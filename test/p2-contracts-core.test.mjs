import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const transpiledRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-p2-shared-'))

function sourceFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(root, entry.name)
    return entry.isDirectory() ? sourceFiles(absolute) : entry.name.endsWith('.ts') ? [absolute] : []
  })
}

function transpileSharedSources() {
  fs.writeFileSync(path.join(transpiledRoot, 'package.json'), '{"type":"module"}\n', 'utf8')
  for (const layer of ['contracts', 'core']) {
    const sourceRoot = path.join(repoRoot, 'src', layer)
    for (const sourceFile of sourceFiles(sourceRoot)) {
      const relative = path.relative(path.join(repoRoot, 'src'), sourceFile)
      const targetFile = path.join(transpiledRoot, relative).replace(/\.ts$/i, '.js')
      const output = ts.transpileModule(fs.readFileSync(sourceFile, 'utf8'), {
        fileName: sourceFile,
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ES2022,
          verbatimModuleSyntax: true
        }
      }).outputText
      fs.mkdirSync(path.dirname(targetFile), { recursive: true })
      fs.writeFileSync(targetFile, output, 'utf8')
    }
  }
}

transpileSharedSources()
const contracts = await import(pathToFileURL(path.join(transpiledRoot, 'contracts', 'index.js')).href)
const core = await import(pathToFileURL(path.join(transpiledRoot, 'core', 'index.js')).href)

test.after(() => fs.rmSync(transpiledRoot, { recursive: true, force: true }))

const SHA_A = `sha256:${'a'.repeat(64)}`
const SHA_B = `sha256:${'b'.repeat(64)}`
const SOURCE_DIGEST = `sha256:${'c'.repeat(64)}`
const GAME_REPO_ID = `sha256:${'d'.repeat(64)}`
const PATH_CLAIMED = `sha256:${'1'.repeat(64)}`
const PATH_LINKED = `sha256:${'2'.repeat(64)}`
const PATH_UNMANAGED = `sha256:${'3'.repeat(64)}`
const CREATED_AT = '2030-01-02T03:04:05.000Z'

function expectedDomainHash(domain, payload) {
  return `sha256:${createHash('sha256').update(`${domain}\0${payload}`, 'utf8').digest('hex')}`
}

function validSnapshotInput(overrides = {}) {
  return {
    source: { kind: 'library', id: 'resident-skills', revision: 'runtime-a' },
    createdAt: CREATED_AT,
    absoluteRoot: 'E:/source',
    files: [
      { path: '中.txt', size: 3, sha256: SHA_A, mode: '100644', isReparsePoint: false, mtimeMs: 100, absolutePath: 'E:/source/中.txt' },
      { path: 'é.txt', size: 2, sha256: SHA_B, mode: '100755', isReparsePoint: false, mtimeMs: 200, absolutePath: 'E:/source/é.txt' },
      { path: 'z.txt', size: 1, sha256: SHA_A, mode: '100644', isReparsePoint: false, mtimeMs: 300, absolutePath: 'E:/source/z.txt' },
      { path: '.\\A.txt', size: 0, sha256: SHA_B, mode: '100644', isReparsePoint: false, mtimeMs: 400, absolutePath: 'E:/source/A.txt' }
    ],
    ...overrides
  }
}

function assertSnapshotSuccess(result) {
  assert.equal(result?.ok, true, JSON.stringify(result))
  return result.manifest
}

test('P2 snapshot identity is canonical, UTF-8 byte sorted, domain-separated, and provenance independent', () => {
  assert.equal(typeof core.createLibrarySnapshotManifest, 'function')
  assert.equal(typeof core.canonicalLibrarySnapshotPayload, 'function')
  assert.equal(typeof core.verifyLibrarySnapshotManifest, 'function')

  const firstResult = core.createLibrarySnapshotManifest(validSnapshotInput())
  const first = assertSnapshotSuccess(firstResult)
  assert.deepEqual(first.files.map((file) => file.path), ['A.txt', 'z.txt', 'é.txt', '中.txt'])
  assert.equal('mtimeMs' in first.files[0], false)
  assert.equal('absolutePath' in first.files[0], false)
  assert.equal('absoluteRoot' in first, false)

  const second = assertSnapshotSuccess(core.createLibrarySnapshotManifest(validSnapshotInput({
    source: { kind: 'library', id: 'dsh-import-of-the-same-content', revision: 'runtime-b' },
    createdAt: '2040-09-08T07:06:05.000Z',
    absoluteRoot: 'F:/elsewhere',
    files: [...validSnapshotInput().files].reverse().map((file, index) => ({
      ...file,
      mtimeMs: 9000 + index,
      absolutePath: `F:/elsewhere/${index}`
    }))
  })))
  assert.equal(second.snapshotId, first.snapshotId)
  assert.equal(core.canonicalLibrarySnapshotPayload(second), firstResult.canonicalPayload)
  assert.deepEqual(Object.keys(JSON.parse(firstResult.canonicalPayload)).sort(), ['files', 'schemaVersion'])
  assert.equal(
    first.snapshotId,
    expectedDomainHash(core.LIBRARY_SNAPSHOT_HASH_DOMAIN, firstResult.canonicalPayload)
  )
  assert.equal(core.verifyLibrarySnapshotManifest(first), true)
  assert.equal(contracts.validateLibrarySnapshotManifestV1(first).valid, true)

  const changed = assertSnapshotSuccess(core.createLibrarySnapshotManifest(validSnapshotInput({
    files: validSnapshotInput().files.map((file) => file.path === 'z.txt' ? { ...file, sha256: SHA_B } : file)
  })))
  assert.notEqual(changed.snapshotId, first.snapshotId)
  const changedMode = assertSnapshotSuccess(core.createLibrarySnapshotManifest(validSnapshotInput({
    files: validSnapshotInput().files.map((file) => file.path === 'z.txt' ? { ...file, mode: '100755' } : file)
  })))
  assert.notEqual(changedMode.snapshotId, first.snapshotId)
  assert.equal(core.verifyLibrarySnapshotManifest({ ...first, snapshotId: changed.snapshotId }), false)
  const unsorted = contracts.validateLibrarySnapshotManifestV1({ ...first, files: [...first.files].reverse() })
  assert.equal(unsorted.valid, false)
  assert.ok(unsorted.errors.some((error) => error.code === 'INVALID_VALUE'))
  const unsafeSize = contracts.validateLibrarySnapshotManifestV1({
    ...first,
    files: first.files.map((file, index) => index === 0
      ? { ...file, size: Number.MAX_SAFE_INTEGER + 1 }
      : file)
  })
  assert.equal(unsafeSize.valid, false)
  assert.ok(unsafeSize.errors.some((error) => error.path === '$.files[0].size'))
})

test('P2 snapshot creation fails closed on traversal, absolute paths, portable collisions, and reparse facts', () => {
  const cases = [
    {
      code: 'SNAPSHOT_PATH_INVALID',
      input: validSnapshotInput({ files: [{ path: '../escape', size: 1, sha256: SHA_A, mode: '100644', isReparsePoint: false }] })
    },
    {
      code: 'SNAPSHOT_PATH_INVALID',
      input: validSnapshotInput({ files: [{ path: 'C:\\absolute.txt', size: 1, sha256: SHA_A, mode: '100644', isReparsePoint: false }] })
    },
    {
      code: 'SNAPSHOT_PATH_COLLISION',
      input: validSnapshotInput({
        files: [
          { path: 'Skill/SKILL.md', size: 1, sha256: SHA_A, mode: '100644', isReparsePoint: false },
          { path: 'skill/skill.md', size: 1, sha256: SHA_B, mode: '100644', isReparsePoint: false }
        ]
      })
    },
    {
      code: 'SNAPSHOT_REPARSE_FORBIDDEN',
      input: validSnapshotInput({ files: [{ path: 'link', size: 1, sha256: SHA_A, mode: '100644', isReparsePoint: true }] })
    },
    {
      code: 'SNAPSHOT_REPARSE_FACT_REQUIRED',
      input: validSnapshotInput({ files: [{ path: 'unknown-link-fact', size: 1, sha256: SHA_A, mode: '100644' }] })
    },
    ...[
      'dir/file.',
      'dir/file ',
      'dir//file',
      'dir/a:b',
      'dir/a?b',
      'CON',
      'con.txt',
      'dir/COM1.md',
      'lPt9.data',
      `dir/${String.fromCharCode(1)}file`,
      `dir/${String.fromCharCode(0xd800)}file`,
      `dir/${String.fromCharCode(0xdc00)}file`
    ].map((filePath) => ({
      code: 'SNAPSHOT_PATH_INVALID',
      input: validSnapshotInput({
        files: [{ path: filePath, size: 1, sha256: SHA_A, mode: '100644', isReparsePoint: false }]
      })
    })),
    {
      code: 'SNAPSHOT_FILE_INVALID',
      input: validSnapshotInput({
        files: [{
          path: 'too-large',
          size: Number.MAX_SAFE_INTEGER + 1,
          sha256: SHA_A,
          mode: '100644',
          isReparsePoint: false
        }]
      })
    }
  ]

  for (const row of cases) {
    const result = core.createLibrarySnapshotManifest(row.input)
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((error) => error.code === row.code), JSON.stringify(result))
  }
  const invalidDate = core.createLibrarySnapshotManifest(validSnapshotInput({
    createdAt: '2030-02-30T03:04:05.000Z'
  }))
  assert.equal(invalidDate.ok, false)
})

test('P2 portable opaque identifiers accept current release forms and reject host locators', () => {
  for (const value of [
    'worktree:0123456789abcdef01234567',
    '0.2.0+a003614',
    'skill-graft-library',
    'runtime-a'
  ]) assert.equal(contracts.isPortableOpaqueIdentifier(value), true, value)

  for (const value of [
    'E:/private/repo',
    'E:private-repo',
    '/private/repo',
    '\\\\server\\share',
    'repo\\child',
    'has space',
    `runtime${String.fromCharCode(10)}revision`
  ]) assert.equal(contracts.isPortableOpaqueIdentifier(value), false, JSON.stringify(value))

  for (const source of [
    { kind: 'library', id: 'E:/private/repo' },
    { kind: 'library', id: 'resident-skills', revision: 'runtime\\private' },
    { kind: 'library', id: 'resident-skills', revision: `runtime${String.fromCharCode(1)}revision` }
  ]) {
    const result = core.createLibrarySnapshotManifest(validSnapshotInput({ source }))
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((error) => error.code === 'SNAPSHOT_INPUT_INVALID'))
  }
})

function unclaimedPin() {
  return {
    schemaVersion: 1,
    pathKey: PATH_CLAIMED,
    worktreeId: 'probe-1',
    requestedSnapshot: null,
    materializedSnapshot: null,
    selectedSkills: [],
    claimState: 'unclaimed'
  }
}

test('P2 WorktreePinV1 keeps runtime revision out and separates requested/materialized/claim transitions', () => {
  assert.equal(contracts.WORKTREE_PIN_SCHEMA_VERSION, 1)
  assert.equal(contracts.validateWorktreePinV1(unclaimedPin()).valid, true)
  const forbiddenRuntime = contracts.validateWorktreePinV1({ ...unclaimedPin(), runtimeRevision: 'must-not-be-here' })
  assert.equal(forbiddenRuntime.valid, false)
  assert.ok(forbiddenRuntime.errors.some((error) => error.code === 'UNEXPECTED_FIELD' && error.path === '$.runtimeRevision'))
  const legacyForbidden = core.validatePin({
    schemaVersion: 1,
    worktreeId: 'legacy-probe',
    librarySnapshot: SHA_A,
    runtimeRevision: 'forbidden-on-every-pin-shape',
    skills: [{ name: 'ozdqp-development' }]
  })
  assert.equal(legacyForbidden.valid, false)
  assert.ok(legacyForbidden.errors.some((error) => error.code === 'runtime-revision-forbidden'))
  const collidingSkills = contracts.validateWorktreePinV1({
    ...unclaimedPin(),
    selectedSkills: ['OZDQP-development', 'ozdqp-development']
  })
  assert.equal(collidingSkills.valid, false)
  assert.ok(collidingSkills.errors.some((error) => error.code === 'DUPLICATE_VALUE'))
  for (const worktreeId of ['E:/probe', 'E:probe', 'probe\\child', `probe${String.fromCharCode(9)}child`]) {
    const validation = contracts.validateWorktreePinV1({ ...unclaimedPin(), worktreeId })
    assert.equal(validation.valid, false)
    assert.ok(validation.errors.some((error) => error.code === 'INVALID_IDENTIFIER'))
  }
  for (const invalidPin of [
    { ...unclaimedPin(), claimState: 'claimed' },
    { ...unclaimedPin(), requestedSnapshot: SHA_A }
  ]) {
    const validation = contracts.validateWorktreePinV1(invalidPin)
    assert.equal(validation.valid, false)
    assert.ok(validation.errors.some((error) => error.code === 'INVARIANT_VIOLATION'))
  }
  assert.deepEqual(core.transitionWorktreePin(unclaimedPin(), { kind: 'future-transition' }), {
    ok: false,
    error: {
      code: 'PIN_TRANSITION_NOT_ALLOWED',
      message: 'unknown worktree pin transition'
    }
  })
  const pendingUpgrade = {
    ...unclaimedPin(),
    claimState: 'claimed',
    requestedSnapshot: SHA_B,
    materializedSnapshot: SHA_A,
    selectedSkills: ['ozdqp-development']
  }
  assert.equal(contracts.validateWorktreePinV1(pendingUpgrade).valid, true)

  const claimed = core.transitionWorktreePin(unclaimedPin(), {
    kind: 'claim',
    requestedSnapshot: SHA_A,
    selectedSkills: ['ozdqp-ui-development', 'ozdqp-development']
  })
  assert.equal(claimed.ok, true)
  assert.equal(claimed.idempotent, false)
  assert.deepEqual(claimed.pin.selectedSkills, ['ozdqp-development', 'ozdqp-ui-development'])
  assert.equal(claimed.pin.requestedSnapshot, SHA_A)
  assert.equal(claimed.pin.materializedSnapshot, null)
  assert.equal('runtimeRevision' in claimed.pin, false)

  const materializedA = core.transitionWorktreePin(claimed.pin, { kind: 'recordMaterialized', snapshotId: SHA_A })
  assert.equal(materializedA.ok, true)
  assert.equal(materializedA.pin.materializedSnapshot, SHA_A)

  const requestedB = core.transitionWorktreePin(materializedA.pin, {
    kind: 'setRequested',
    requestedSnapshot: SHA_B,
    selectedSkills: ['ozdqp-development']
  })
  assert.equal(requestedB.ok, true)
  assert.equal(requestedB.pin.requestedSnapshot, SHA_B)
  assert.equal(requestedB.pin.materializedSnapshot, SHA_A)

  const mismatch = core.transitionWorktreePin(requestedB.pin, { kind: 'recordMaterialized', snapshotId: SHA_A })
  assert.deepEqual(mismatch, {
    ok: false,
    error: {
      code: 'PIN_MATERIALIZED_NOT_REQUESTED',
      message: 'materialized snapshot must match the currently requested snapshot'
    }
  })

  const materializedB = core.transitionWorktreePin(requestedB.pin, { kind: 'recordMaterialized', snapshotId: SHA_B })
  assert.equal(materializedB.ok, true)
  const detached = core.transitionWorktreePin(materializedB.pin, { kind: 'detach' })
  assert.equal(detached.ok, true)
  assert.deepEqual(detached.pin, { ...unclaimedPin(), claimState: 'detached' })
})

function legacyMigrationInput(overrides = {}) {
  return {
    sourceDigest: SOURCE_DIGEST,
    runtimeRevision: '0.2.0+a003614',
    lastIngestGameRepoId: null,
    defaultSnapshot: SHA_A,
    librarySnapshots: [SHA_B, SHA_A],
    legacyState: {
      schemaVersion: 1,
      stateRevision: 7,
      inboxItems: [],
      lastIngest: null
    },
    worktrees: [
      {
        pathKey: PATH_UNMANAGED,
        worktreeId: 'unmanaged',
        linked: false,
        claimed: false,
        selectedSkills: ['ignored-stale-selection']
      },
      {
        pathKey: PATH_LINKED,
        worktreeId: 'linked',
        linked: true,
        claimed: false,
        selectedSkills: ['ozdqp-development']
      },
      {
        pathKey: PATH_CLAIMED,
        worktreeId: 'claimed',
        linked: false,
        claimed: true,
        selectedSkills: ['ozdqp-git-workflow']
      }
    ],
    ...overrides
  }
}

test('P2 legacy validation treats version as a discriminator and emits one normalized semantic shape', () => {
  const byVersion = core.validateLegacyHubStateV1({
    version: 1,
    items: [],
    lastIngest: null
  })
  const bySchemaVersion = core.validateLegacyHubStateV1({
    schemaVersion: 1,
    items: [],
    lastIngest: null
  })
  assert.equal(byVersion.valid, true)
  assert.equal(bySchemaVersion.valid, true)
  assert.deepEqual(byVersion.value, bySchemaVersion.value)
  assert.deepEqual(byVersion.value, {
    schemaVersion: 1,
    items: [],
    lastIngest: null
  })
  assert.equal('version' in byVersion.value, false)

  const explicit = core.validateLegacyHubStateV1({
    version: 1,
    stateRevision: 7,
    items: [],
    lastIngest: null
  })
  assert.equal(explicit.valid, true)
  const planned = core.planV1ToV2Migration(legacyMigrationInput({ legacyState: explicit.value }))
  assert.equal(planned.ok, true)
  assert.equal(planned.plan.targetState.stateRevision, 8)

  for (const invalid of [
    { version: 1, items: [], lastIngest: null, sessions: [] },
    { version: 1, schemaVersion: 1, items: [], lastIngest: null },
    { version: 1, items: [], lastIngest: { ref: 'r', old: 'a', new: 'b', gameRepo: 'E:/repo', hostPath: 'E:/repo' } }
  ]) {
    assert.equal(core.validateLegacyHubStateV1(invalid).valid, false)
    const rejected = core.planV1ToV2Migration(legacyMigrationInput({ legacyState: invalid }))
    assert.equal(rejected.ok, false)
    assert.equal(rejected.errors[0].path, '$.legacyState')
  }
})

test('P2 migration redacts the real P1 repository locator into the supplied opaque identity', () => {
  const rawGameRepo = 'E:\\private\\ozdqp-main'
  const legacyState = {
    version: 1,
    stateRevision: 7,
    items: [{
      id: 'queued-1',
      name: 'candidate',
      unit: 'skill:candidate',
      status: 'queued',
      inboxPath: 'skills/inbox/candidate'
    }],
    lastIngest: {
      ref: 'refs/remotes/origin/main',
      old: 'a'.repeat(40),
      new: 'b'.repeat(40),
      gameRepo: rawGameRepo
    }
  }
  const validation = core.validateLegacyHubStateV1(legacyState)
  assert.equal(validation.valid, true)
  assert.equal(validation.value.lastIngest.gameRepo, rawGameRepo)

  const result = core.planV1ToV2Migration(legacyMigrationInput({
    legacyState,
    lastIngestGameRepoId: GAME_REPO_ID
  }))
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(result.plan.targetState.lastIngest, {
    ref: 'refs/remotes/origin/main',
    old: 'a'.repeat(40),
    new: 'b'.repeat(40),
    gameRepoId: GAME_REPO_ID
  })
  assert.equal(JSON.stringify(result.plan).includes(rawGameRepo), false)
  assert.equal(contracts.validateHubStateV2({
    ...result.plan.targetState,
    lastIngest: legacyState.lastIngest
  }).valid, false)

  for (const mismatch of [
    legacyMigrationInput({ legacyState, lastIngestGameRepoId: null }),
    legacyMigrationInput({ lastIngestGameRepoId: GAME_REPO_ID })
  ]) {
    const rejected = core.planV1ToV2Migration(mismatch)
    assert.equal(rejected.ok, false)
    assert.equal(rejected.errors[0].code, 'MIGRATION_INPUT_INVALID')
  }
})

test('P2 V1 to V2 migration plan is deterministic, classifies facts, and never fakes materialization', () => {
  assert.equal(typeof core.planV1ToV2Migration, 'function')
  assert.equal(typeof core.canonicalMigrationPlanPayload, 'function')
  assert.equal(typeof core.verifyMigrationPlanHash, 'function')

  const firstResult = core.planV1ToV2Migration(legacyMigrationInput())
  assert.equal(firstResult.ok, true, JSON.stringify(firstResult))
  const first = firstResult.plan
  assert.deepEqual(first.worktrees.map((entry) => [entry.pathKey, entry.classification]), [
    [PATH_CLAIMED, 'claimed'],
    [PATH_LINKED, 'linked'],
    [PATH_UNMANAGED, 'unmanaged']
  ])
  assert.deepEqual(first.worktrees.find((entry) => entry.classification === 'unmanaged').selectedSkills, [])
  assert.deepEqual(Object.keys(first.targetState.worktrees), [PATH_CLAIMED, PATH_LINKED])
  assert.equal(first.targetState.schemaVersion, 2)
  assert.equal(first.targetState.runtimeRevision, '0.2.0+a003614')
  for (const pin of Object.values(first.targetState.worktrees)) {
    assert.equal(pin.requestedSnapshot, SHA_A)
    assert.equal(pin.materializedSnapshot, null)
    assert.equal(pin.claimState, 'claimed')
    assert.equal('runtimeRevision' in pin, false)
  }
  assert.deepEqual(first.warnings.map((warning) => warning.code), [
    'CLAIM_REQUIRES_MATERIALIZATION',
    'LEGACY_LINK_RETAINED'
  ])

  const reordered = core.planV1ToV2Migration(legacyMigrationInput({
    librarySnapshots: [SHA_A, SHA_B, SHA_A],
    worktrees: [...legacyMigrationInput().worktrees].reverse()
  }))
  assert.equal(reordered.ok, true)
  assert.equal(reordered.plan.planHash, first.planHash)
  assert.equal(reordered.canonicalPayload, firstResult.canonicalPayload)
  assert.equal(
    first.planHash,
    expectedDomainHash(core.MIGRATION_PLAN_HASH_DOMAIN, firstResult.canonicalPayload)
  )
  assert.equal(core.verifyMigrationPlanHash(first), true)
  assert.equal(contracts.validateMigrationPlanV1(first).valid, true)
  assert.equal(contracts.validateHubStateV2(first.targetState).valid, true)

  const changedSource = core.planV1ToV2Migration(legacyMigrationInput({ sourceDigest: `sha256:${'d'.repeat(64)}` }))
  assert.equal(changedSource.ok, true)
  assert.notEqual(changedSource.plan.planHash, first.planHash)
  assert.equal(core.verifyMigrationPlanHash({ ...first, planHash: changedSource.plan.planHash }), false)

  const invalidPlans = [
    {
      ...first,
      worktrees: first.worktrees.map((entry) => entry.classification === 'unmanaged'
        ? { ...entry, requestedSnapshot: SHA_A, selectedSkills: ['ozdqp-development'] }
        : entry)
    },
    {
      ...first,
      targetState: {
        ...first.targetState,
        worktrees: {
          ...first.targetState.worktrees,
          [PATH_CLAIMED]: {
            ...first.targetState.worktrees[PATH_CLAIMED],
            materializedSnapshot: SHA_A
          }
        }
      }
    },
    { ...first, warnings: first.warnings.slice(1) },
    { ...first, warnings: [...first.warnings, first.warnings[0]] },
    {
      ...first,
      warnings: first.warnings.map((warning, index) => index === 0
        ? { ...warning, code: 'LEGACY_LINK_RETAINED' }
        : warning)
    },
    {
      ...first,
      targetState: {
        ...first.targetState,
        worktrees: {
          ...first.targetState.worktrees,
          [PATH_UNMANAGED]: {
            ...first.targetState.worktrees[PATH_CLAIMED],
            pathKey: PATH_UNMANAGED,
            worktreeId: 'unexpected-extra-pin'
          }
        }
      }
    }
  ]
  for (const invalidPlan of invalidPlans) {
    const validation = contracts.validateMigrationPlanV1(invalidPlan)
    assert.equal(validation.valid, false, JSON.stringify(invalidPlan))
    assert.ok(validation.errors.some((error) => ['INVARIANT_VIOLATION', 'DUPLICATE_VALUE'].includes(error.code)))
  }

  for (const malformedInput of [
    legacyMigrationInput({ librarySnapshots: [SHA_A, null] }),
    legacyMigrationInput({ worktrees: [null] }),
    legacyMigrationInput({ runtimeRevision: 17 }),
    legacyMigrationInput({ runtimeRevision: 'E:/runtime' }),
    legacyMigrationInput({
      worktrees: [{
        pathKey: PATH_CLAIMED,
        worktreeId: 'E:/private/worktree',
        linked: true,
        claimed: true,
        selectedSkills: []
      }]
    }),
    legacyMigrationInput({
      worktrees: [{
        pathKey: PATH_CLAIMED,
        worktreeId: 'claimed',
        linked: true,
        claimed: true,
        selectedSkills: [],
        worktreePath: 'E:/private/worktree'
      }]
    })
  ]) {
    const malformed = core.planV1ToV2Migration(malformedInput)
    assert.equal(malformed.ok, false)
    assert.equal(malformed.errors[0].code, 'MIGRATION_INPUT_INVALID')
  }
})

test('P2 HubStateV2 validator fails closed on missing snapshots and non-opaque or mismatched path keys', () => {
  const result = core.planV1ToV2Migration(legacyMigrationInput())
  assert.equal(result.ok, true)
  const state = result.plan.targetState
  const portableInbox = contracts.validateHubStateV2({
    ...state,
    items: [{
      id: 'portable',
      name: 'portable',
      unit: 'portable',
      status: 'adopted',
      inboxPath: 'skills/inbox/portable',
      adoptedPath: 'skills/adopted/portable'
    }]
  })
  assert.equal(portableInbox.valid, true, JSON.stringify(portableInbox))

  for (const [field, unsafePath] of [
    ['inboxPath', 'E:/private/inbox'],
    ['inboxPath', '../private'],
    ['inboxPath', 'skills\\inbox\\private'],
    ['adoptedPath', 'skills/adopted/../private'],
    ['adoptedPath', 'CON']
  ]) {
    const invalid = contracts.validateHubStateV2({
      ...state,
      items: [{ id: 'unsafe', name: 'unsafe', unit: 'unsafe', status: 'queued', [field]: unsafePath }]
    })
    assert.equal(invalid.valid, false, `${field}:${unsafePath}`)
    assert.ok(invalid.errors.some((error) => error.code === 'PATH_NOT_NORMALIZED'))
  }

  for (const runtimeRevision of ['E:/runtime', 'E:runtime', 'runtime\\local', `runtime${String.fromCharCode(10)}local`]) {
    const invalid = contracts.validateHubStateV2({ ...state, runtimeRevision })
    assert.equal(invalid.valid, false)
    assert.ok(invalid.errors.some((error) => error.code === 'INVALID_IDENTIFIER'))
  }
  const missing = contracts.validateHubStateV2({
    ...state,
    librarySnapshots: [SHA_B]
  })
  assert.equal(missing.valid, false)
  assert.ok(missing.errors.some((error) => error.code === 'REFERENCE_NOT_FOUND'))

  const invalidKey = contracts.validateHubStateV2({
    ...state,
    worktrees: {
      'E:/Tree': { ...state.worktrees[PATH_LINKED], pathKey: 'E:/Tree' }
    }
  })
  assert.equal(invalidKey.valid, false)
  assert.ok(invalidKey.errors.some((error) => error.code === 'INVALID_IDENTIFIER'))

  const mismatchedKey = contracts.validateHubStateV2({
    ...state,
    worktrees: {
      [PATH_LINKED]: { ...state.worktrees[PATH_LINKED], pathKey: PATH_CLAIMED }
    }
  })
  assert.equal(mismatchedKey.valid, false)
  assert.ok(mismatchedKey.errors.some((error) => error.code === 'INVARIANT_VIOLATION'))

  const unsortedSnapshots = contracts.validateHubStateV2({
    ...state,
    librarySnapshots: [...state.librarySnapshots].reverse()
  })
  assert.equal(unsortedSnapshots.valid, false)
  assert.ok(unsortedSnapshots.errors.some((error) => error.code === 'INVALID_VALUE'))

  const corruptInbox = contracts.validateHubStateV2({
    ...state,
    items: [{ id: 'bad', name: 'bad', unit: 'bad', status: 'queued', hostPath: 'E:/private' }]
  })
  assert.equal(corruptInbox.valid, false)
  assert.ok(corruptInbox.errors.some((error) => error.code === 'UNEXPECTED_FIELD'))

  const duplicateInbox = contracts.validateHubStateV2({
    ...state,
    items: [
      { id: 'duplicate', name: 'first', unit: 'a', status: 'queued' },
      { id: 'duplicate', name: 'second', unit: 'b', status: 'rejected' }
    ]
  })
  assert.equal(duplicateInbox.valid, false)
  assert.ok(duplicateInbox.errors.some((error) => error.code === 'DUPLICATE_VALUE'))

  const duplicateWorktree = contracts.validateHubStateV2({
    ...state,
    worktrees: {
      ...state.worktrees,
      [PATH_LINKED]: {
        ...state.worktrees[PATH_LINKED],
        worktreeId: state.worktrees[PATH_CLAIMED].worktreeId
      }
    }
  })
  assert.equal(duplicateWorktree.valid, false)
  assert.ok(duplicateWorktree.errors.some((error) => error.code === 'DUPLICATE_VALUE'))

  const unsafeRevision = contracts.validateHubStateV2({
    ...state,
    stateRevision: Number.MAX_SAFE_INTEGER + 1
  })
  assert.equal(unsafeRevision.valid, false)
  assert.ok(unsafeRevision.errors.some((error) => error.path === '$.stateRevision'))
})

function lockRecord() {
  return {
    schemaVersion: 1,
    scope: 'worktree',
    lockKey: PATH_CLAIMED,
    ownerToken: 'owner-token-0123456789',
    hostId: 'local',
    pid: 4242,
    processIdentity: 'process-start:123456',
    command: 'setPin',
    requestId: 'request-p2-lock',
    acquiredAt: '2030-01-02T03:00:00.000Z',
    heartbeatAt: '2030-01-02T03:00:05.000Z',
    leaseUntil: '2030-01-02T03:00:10.000Z'
  }
}

test('P2 lock reclaim policy only reclaims an expired lock whose exact owner is proven dead', () => {
  const record = lockRecord()
  assert.equal(contracts.validateLockRecordV1(record).valid, true)
  assert.equal(contracts.validateLockRecordV1({ ...record, command: 'status' }).valid, false)
  assert.equal(contracts.validateLockRecordV1({
    ...record,
    ownerToken: 'owner:token:0123456789'
  }).valid, false)
  assert.equal(contracts.validateLockRecordV1({
    ...record,
    ownerToken: 'x'.repeat(65)
  }).valid, false)
  const beforeExpiry = Date.parse('2030-01-02T03:00:09.000Z')
  const afterExpiry = Date.parse('2030-01-02T03:00:11.000Z')

  assert.deepEqual(core.evaluateLockReclaim(record, { nowEpochMs: beforeExpiry, processStatus: 'dead' }), {
    reclaim: false,
    reason: 'lease-active',
    retryAfterMs: 1000
  })
  assert.deepEqual(core.evaluateLockReclaim(record, { nowEpochMs: afterExpiry, processStatus: 'alive-owner' }), {
    reclaim: false,
    reason: 'owner-alive'
  })
  assert.deepEqual(core.evaluateLockReclaim(record, { nowEpochMs: afterExpiry, processStatus: 'pid-reused' }), {
    reclaim: false,
    reason: 'pid-reused-fail-closed'
  })
  assert.deepEqual(core.evaluateLockReclaim(record, { nowEpochMs: afterExpiry, processStatus: 'unknown' }), {
    reclaim: false,
    reason: 'owner-unknown-fail-closed'
  })
  assert.deepEqual(core.evaluateLockReclaim(record, { nowEpochMs: afterExpiry, processStatus: 'dead' }), {
    reclaim: true,
    reason: 'expired-owner-dead'
  })

  assert.equal(core.authorizeLockOwner(record, {
    ownerToken: record.ownerToken,
    hostId: record.hostId,
    pid: record.pid,
    processIdentity: record.processIdentity
  }), true)
  assert.equal(core.authorizeLockOwner(record, {
    ownerToken: 'wrong-token',
    hostId: record.hostId,
    pid: record.pid,
    processIdentity: record.processIdentity
  }), false)

  const extraField = contracts.validateLockRecordV1({ ...record, path: 'host-private-path' })
  assert.equal(extraField.valid, false)
  assert.ok(extraField.errors.some((error) => error.code === 'UNEXPECTED_FIELD'))
  const rawWorktreeKey = contracts.validateLockRecordV1({ ...record, lockKey: 'e:/probe' })
  assert.equal(rawWorktreeKey.valid, false)
  assert.ok(rawWorktreeKey.errors.some((error) => error.code === 'INVALID_IDENTIFIER'))
  const globalLock = { ...record, scope: 'hub-global', lockKey: contracts.HUB_GLOBAL_LOCK_KEY }
  assert.equal(contracts.validateLockRecordV1(globalLock).valid, true)
  const wrongGlobalKey = contracts.validateLockRecordV1({ ...globalLock, lockKey: PATH_CLAIMED })
  assert.equal(wrongGlobalKey.valid, false)
  assert.ok(wrongGlobalKey.errors.some((error) => error.code === 'INVARIANT_VIOLATION'))
  for (const invalidRecord of [
    { ...record, pid: Number.MAX_SAFE_INTEGER + 1 },
    { ...record, acquiredAt: '2030-02-30T03:00:00.000Z' }
  ]) {
    const invalid = contracts.validateLockRecordV1(invalidRecord)
    assert.equal(invalid.valid, false)
    assert.ok(invalid.errors.some((error) => error.code === 'INVALID_VALUE'))
  }
})

test('P2 schema versions and stable error vocabularies are publicly exported', () => {
  assert.deepEqual({
    snapshot: contracts.LIBRARY_SNAPSHOT_SCHEMA_VERSION,
    state: contracts.HUB_STATE_SCHEMA_VERSION,
    pin: contracts.WORKTREE_PIN_SCHEMA_VERSION,
    migration: contracts.MIGRATION_PLAN_SCHEMA_VERSION,
    lock: contracts.LOCK_RECORD_SCHEMA_VERSION
  }, {
    snapshot: 1,
    state: 2,
    pin: 1,
    migration: 1,
    lock: 1
  })
  for (const code of [
    'STATE_CORRUPT',
    'MIGRATION_REQUIRED',
    'MIGRATION_PLAN_STALE',
    'LOCK_BUSY',
    'LOCK_NOT_OWNED',
    'SNAPSHOT_NOT_FOUND',
    'SNAPSHOT_INVALID'
  ]) {
    assert.ok(contracts.HUB_ERROR_CODES.includes(code), code)
  }
  assert.deepEqual(contracts.P2_VALIDATION_ERROR_CODES, [
    'INVALID_TYPE',
    'MISSING_FIELD',
    'UNEXPECTED_FIELD',
    'UNSUPPORTED_SCHEMA_VERSION',
    'INVALID_VALUE',
    'INVALID_IDENTIFIER',
    'DUPLICATE_VALUE',
    'PATH_NOT_NORMALIZED',
    'PATH_COLLISION',
    'REFERENCE_NOT_FOUND',
    'INVARIANT_VIOLATION'
  ])
  for (const schema of [
    contracts.LIBRARY_SNAPSHOT_MANIFEST_V1_SCHEMA,
    contracts.HUB_STATE_V2_SCHEMA,
    contracts.WORKTREE_PIN_V1_SCHEMA,
    contracts.MIGRATION_PLAN_V1_SCHEMA,
    contracts.LOCK_RECORD_V1_SCHEMA
  ]) {
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema')
    assert.match(schema.$id, /^https:\/\//)
    assert.equal(schema.type, 'object')
    assert.ok(Array.isArray(schema.required))
    assert.equal(schema.additionalProperties, false)
  }
})
