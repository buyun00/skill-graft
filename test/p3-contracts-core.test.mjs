import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const transpiledRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-p3-contracts-core-'))

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
      const targetFile = path.join(transpiledRoot, relative).replace(/\.ts$/iu, '.js')
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

const PATH_KEY = sha('p3-path-key')
const WORKTREE_ID = 'worktree:p3-probe'
const CREATED_AT = '2030-01-02T03:04:05.000Z'
const visibilityStates = new Map()

function sha(value) {
  return `sha256:${createHash('sha256').update(String(value), 'utf8').digest('hex')}`
}

function domainHash(domain, payload) {
  return sha(`${domain}\0${payload}`)
}

function fileFact(filePath, contents, extras = {}) {
  return {
    path: filePath,
    size: Buffer.byteLength(contents),
    sha256: sha(contents),
    mode: '100644',
    isReparsePoint: false,
    ...extras
  }
}

function makeSnapshot(options = {}) {
  const files = [
    fileFact('AGENTS.override.md', options.override ?? 'override-a'),
    fileFact('skills/ozdqp-development/SKILL.md', options.development ?? 'development-a'),
    fileFact('skills/ozdqp-development/references/rules.md', options.developmentRules ?? 'rules-a'),
    fileFact('skills/ozdqp-git-workflow/SKILL.md', 'git-a'),
    fileFact('skills/ozdqp-ui-development/SKILL.md', 'ui-a'),
    fileFact('skills/adopted/team-skill/SKILL.md', options.adopted ?? 'adopted-a'),
    fileFact('skills/adopted/team-skill/reference.md', 'adopted-reference-a'),
    ...(options.dynamicResident
      ? [fileFact('skills/project-private/SKILL.md', 'project-private-a')]
      : []),
    ...(options.adoptedResidentCollision
      ? [fileFact('skills/adopted/ozdqp-development/SKILL.md', 'collision')]
      : []),
    ...(options.adoptedUnity
      ? [fileFact('skills/adopted/unity-skills/SKILL.md', 'project-owned')]
      : [])
  ]
  const result = core.createLibrarySnapshotManifest({
    source: { kind: 'library', id: 'p3-library', revision: options.revision ?? 'library-a' },
    createdAt: CREATED_AT,
    files
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  return result.manifest
}

function makeRuntime(runtimeRevision = 'runtime-a', contents = 'overlay-a') {
  const result = core.createRuntimeAssetManifest({
    runtimeRevision,
    files: [
      fileFact('hooks/post-checkout', `hook-${contents}`, { mode: '100755', mtimeMs: 100, absolutePath: 'E:/private/overlay/hook' }),
      fileFact('register.ps1', contents, { mtimeMs: 200, absolutePath: 'E:/private/overlay/register.ps1' })
    ].reverse()
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  return result.manifest
}

function makePin(snapshot, selectedSkills, materializedSnapshot = null) {
  return {
    schemaVersion: 1,
    pathKey: PATH_KEY,
    worktreeId: WORKTREE_ID,
    requestedSnapshot: snapshot.snapshotId,
    materializedSnapshot,
    selectedSkills: [...selectedSkills],
    claimState: 'claimed'
  }
}

function makeVisibilityState(artifacts, options = {}) {
  const result = core.createVisibilityOwnershipState({
    privateStateId: options.privateStateId ?? sha('visibility-private-state'),
    pathKey: PATH_KEY,
    worktreeId: WORKTREE_ID,
    baseExclude: options.baseExclude ?? {
      scope: 'global',
      valueId: core.gitMaterializationConfigurationValueId('base-exclude'),
      contentDigest: sha('base-exclude-content')
    },
    targets: artifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      owner: artifact.owner,
      targetRelativePath: artifact.targetRelativePath,
      baselineKind: 'missing',
      trackedPaths: [],
      ignoreOrigin: 'none',
      privateExcluded: false
    }))
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  visibilityStates.set(result.state.visibilityStateId, result.state)
  return result.state
}

function makeDesired(snapshot, runtimeAsset, selectedSkills) {
  const provisional = core.buildDesiredMaterialization({
    snapshot,
    runtimeAsset,
    selectedSkills,
    visibilityStateId: sha('provisional-visibility-state')
  })
  assert.equal(provisional.ok, true, JSON.stringify(provisional))
  const visibilityState = makeVisibilityState(provisional.desired.artifacts)
  const result = core.buildDesiredMaterialization({
    snapshot,
    runtimeAsset,
    selectedSkills,
    visibilityStateId: visibilityState.visibilityStateId
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  return result.desired
}

function markerFromDesired(desired, options = {}) {
  return {
    schemaVersion: 1,
    materializationId: desired.requested.materializationId,
    planHash: options.planHash ?? sha('previous-plan'),
    pathKey: PATH_KEY,
    worktreeId: WORKTREE_ID,
    snapshotId: desired.requested.snapshotId,
    selectedSkills: [...desired.requested.selectedSkills],
    runtimeRevision: desired.requested.runtimeRevision,
    runtimeAssetId: desired.requested.runtimeAssetId,
    visibilityStateId: desired.requested.visibilityStateId,
    origin: options.origin ?? { kind: 'sync' },
    artifacts: desired.artifacts.map(({ artifactId, owner, targetRelativePath, kind, digest }) => ({
      artifactId,
      owner,
      targetRelativePath,
      kind,
      digest
    }))
  }
}

function targetKey(value) {
  return value.normalize('NFC').toLocaleLowerCase('en-US')
}

function gitFact(targetRelativePath, options = {}) {
  const ownership = options.ownership ?? 'unmanaged'
  const created = core.createGitVisibilityFact({
    targetRelativePath,
    trackedPaths: options.trackedPaths ?? [],
    ignored: options.ignored ?? false,
    ignoreOrigin: options.ignoreOrigin ?? 'none',
    privateExcluded: options.privateExcluded ?? false,
    ownership,
    ownershipStateId: options.ownershipStateId ?? null,
    baselineDigest: ownership === 'invalid'
      ? null
      : options.baselineDigest ?? sha(`baseline:${targetRelativePath}`),
    restoreDigest: ownership === 'managed'
      ? options.restoreDigest ?? sha(`restore:${targetRelativePath}`)
      : null,
    restoreSafe: ownership !== 'invalid' && (options.restoreSafe ?? true)
  })
  assert.equal(created.ok, true, JSON.stringify(created))
  return created.fact
}

function gitConfiguration(options = {}) {
  const valueId = core.gitMaterializationConfigurationValueId
  const siblings = core.createGitMaterializationSiblingProof(options.siblings ?? [])
  assert.equal(siblings.ok, true, JSON.stringify(siblings))
  const currentExcludes = options.excludesFile === null
    ? null
    : valueId(options.excludesFile ?? 'desired-excludes')
  const desiredExcludes = options.desiredExcludesFile === null
    ? null
    : valueId(options.desiredExcludesFile ?? 'desired-excludes')
  return core.createGitMaterializationConfigurationFact({
    isLinkedWorktree: options.isLinkedWorktree ?? true,
    supportsWorktreeConfig: options.supportsWorktreeConfig ?? true,
    worktreeConfigEnabled: options.worktreeConfigEnabled ?? true,
    hooksPathValueId: valueId(options.hooksPath ?? 'desired-hooks'),
    desiredHooksPathValueId: valueId('desired-hooks'),
    overlaySourceValueId: valueId(options.overlaySource ?? 'desired-overlay'),
    desiredOverlaySourceValueId: valueId('desired-overlay'),
    watchWorkspaceValueId: valueId(options.watchWorkspace ?? 'desired-watch-workspace'),
    desiredWatchWorkspaceValueId: valueId('desired-watch-workspace'),
    excludesFileValueId: currentExcludes,
    desiredExcludesFileValueId: desiredExcludes,
    baseExcludeSafe: options.baseExcludeSafe ?? true,
    baseExcludeValueId: options.baseExcludeValueId ?? valueId('base-exclude'),
    baseExcludeContentDigest: options.baseExcludeContentDigest ?? sha('base-exclude-content'),
    privateExcludeContentDigest: valueId(options.privateExclude ?? 'desired-private-exclude'),
    desiredPrivateExcludeContentDigest: valueId('desired-private-exclude'),
    commonInfoExcludeDigest: valueId(options.commonInfoExclude ?? 'clean-common'),
    cleanCommonInfoExcludeDigest: valueId('clean-common'),
    ...siblings.proof
  })
}

function transitionFacts(currentArtifacts, desiredArtifacts, options = {}) {
  const current = new Map(currentArtifacts.map((artifact) => [targetKey(artifact.targetRelativePath), artifact]))
  const desired = new Map(desiredArtifacts.map((artifact) => [targetKey(artifact.targetRelativePath), artifact]))
  const keys = new Set([...current.keys(), ...desired.keys()])
  const observations = []
  const gitFacts = []
  const currentState = options.currentVisibilityState === undefined
    ? currentArtifacts.length === 0 ? null : [...visibilityStates.values()].find((state) => (
        state.targets.length === currentArtifacts.length
        && state.targets.every((target, index) => target.artifactId === currentArtifacts[index].artifactId)
      )) ?? null
    : options.currentVisibilityState
  const desiredState = options.desiredVisibilityState
    ?? [...visibilityStates.values()].find((state) => (
      state.targets.length === desiredArtifacts.length
      && state.targets.every((target, index) => target.artifactId === desiredArtifacts[index].artifactId)
    ))
  for (const key of keys) {
    const present = current.get(key)
    const target = (present ?? desired.get(key)).targetRelativePath
    observations.push(present
      ? {
          targetRelativePath: target,
          kind: present.kind,
          digest: present.digest,
          isReparsePoint: false
        }
      : { targetRelativePath: target, kind: 'missing', isReparsePoint: false })
    const currentTarget = currentState?.targets.find((entry) => targetKey(entry.targetRelativePath) === key)
    const desiredTarget = desiredState?.targets.find((entry) => targetKey(entry.targetRelativePath) === key)
    const baseline = currentTarget ?? desiredTarget
    const baselineDigest = baseline == null
      ? sha(`baseline:${target}`)
      : core.visibilityOwnershipTargetBaselineDigest(baseline)
    const baselineFact = gitFact(target, {
      ownership: 'unmanaged',
      ownershipStateId: currentState?.visibilityStateId ?? null,
      baselineDigest,
      ignored: baseline?.ignoreOrigin !== 'none',
      ignoreOrigin: baseline?.ignoreOrigin ?? 'none',
      privateExcluded: baseline?.privateExcluded ?? false,
      trackedPaths: baseline?.trackedPaths ?? []
    })
    gitFacts.push(currentTarget
      ? gitFact(target, {
          ownership: 'managed',
          ownershipStateId: currentState.visibilityStateId,
          baselineDigest,
          restoreDigest: baselineFact.factDigest,
          ignored: true,
          ignoreOrigin: 'private',
          privateExcluded: true,
          trackedPaths: currentTarget.trackedPaths.map((entry) => ({ ...entry, skipWorktree: true }))
        })
      : baselineFact)
  }
  return { observations, gitFacts }
}

function planningInput({ snapshot, runtimeAsset, pin, desired, marker = null, facts, durableMarker, observedMarker }) {
  const currentVisibilityState = marker == null ? null : visibilityStates.get(marker.visibilityStateId)
  const desiredVisibilityState = visibilityStates.get(desired.requested.visibilityStateId)
  return {
    pathKey: PATH_KEY,
    worktreeId: WORKTREE_ID,
    stateRevision: 7,
    pin,
    snapshot,
    runtimeAsset,
    durableMarker: durableMarker === undefined
      ? marker == null ? null : { schemaVersion: 1, pathKey: PATH_KEY, marker }
      : durableMarker,
    observedMarker: observedMarker === undefined ? marker : observedMarker,
    currentVisibilityState,
    desiredVisibilityState,
    observations: facts?.observations ?? transitionFacts(marker?.artifacts ?? [], desired.artifacts, {
      currentVisibilityState,
      desiredVisibilityState
    }).observations,
    gitFacts: facts?.gitFacts ?? transitionFacts(marker?.artifacts ?? [], desired.artifacts, {
      currentVisibilityState,
      desiredVisibilityState
    }).gitFacts,
    gitConfiguration: facts?.gitConfiguration ?? gitConfiguration()
  }
}

function assertPlan(result) {
  assert.equal(result.ok, true, JSON.stringify(result))
  return result.plan
}

function actionByOwner(plan, owner) {
  return plan.operations.find((operation) => operation.owner === owner)?.action
}

function rehashPlan(plan) {
  const cloned = structuredClone(plan)
  cloned.planHash = domainHash(core.MATERIALIZE_PLAN_HASH_DOMAIN, core.canonicalMaterializePlanPayload(cloned))
  return cloned
}

test('P3 command, error, and audit vocabularies are additive and frozen', () => {
  assert.deepEqual(contracts.QUERY_COMMAND_KINDS.slice(-2), ['getPin', 'planSync'])
  assert.deepEqual(contracts.WRITE_COMMAND_KINDS.slice(-4), [
    'claimWorktree', 'sync', 'migrateLegacy', 'rollbackLegacyMigration'
  ])
  assert.ok(contracts.HUB_ERROR_CODES.includes('UNSUPPORTED_LAYOUT'))
  assert.deepEqual(contracts.AUDIT_EVENT_TYPES.slice(-4), [
    'worktree.claimed',
    'worktree.materialized',
    'worktree.legacy-migrated',
    'worktree.legacy-rolled-back'
  ])
})

test('runtime manifest is strict, canonical, content-addressed, and separates revision from bytes', () => {
  const first = makeRuntime('runtime-a', 'same-bytes')
  const second = makeRuntime('runtime-b', 'same-bytes')
  assert.equal(first.runtimeAssetId, second.runtimeAssetId)
  assert.notEqual(first.runtimeRevision, second.runtimeRevision)
  assert.deepEqual(first.files.map((file) => file.path), ['hooks/post-checkout', 'register.ps1'])
  assert.equal(first.files.some((file) => 'absolutePath' in file || 'mtimeMs' in file), false)
  assert.deepEqual(Object.keys(JSON.parse(core.canonicalRuntimeAssetPayload(first))).sort(), [
    'assetKind', 'files', 'schemaVersion'
  ])
  assert.equal(first.runtimeAssetId, domainHash(core.RUNTIME_ASSET_HASH_DOMAIN, core.canonicalRuntimeAssetPayload(first)))
  assert.equal(core.verifyRuntimeAssetManifest(first), true)
  assert.equal(core.verifyRuntimeAssetManifest({
    ...first,
    files: first.files.map((file, index) => index === 0 ? { ...file, sha256: sha('tampered') } : file)
  }), false)

  const strict = contracts.validateRuntimeAssetManifestV1({ ...first, sourceRoot: 'E:/private/overlay' })
  assert.equal(strict.valid, false)
  assert.ok(strict.errors.some((error) => error.code === 'UNEXPECTED_FIELD'))
})

test('runtime manifest creation rejects traversal, locator revisions, portable collisions, and incomplete reparse facts', () => {
  const cases = [
    ['RUNTIME_ASSET_PATH_INVALID', { runtimeRevision: 'runtime-a', files: [fileFact('../escape', 'x')] }],
    ['RUNTIME_ASSET_PATH_INVALID', { runtimeRevision: 'runtime-a', files: [fileFact('C:\\escape', 'x')] }],
    ['RUNTIME_ASSET_REPARSE_FORBIDDEN', { runtimeRevision: 'runtime-a', files: [fileFact('link', 'x', { isReparsePoint: true })] }],
    ['RUNTIME_ASSET_REPARSE_FACT_REQUIRED', {
      runtimeRevision: 'runtime-a',
      files: [{ path: 'unknown', size: 1, sha256: sha('x'), mode: '100644' }]
    }],
    ['RUNTIME_ASSET_PATH_COLLISION', {
      runtimeRevision: 'runtime-a',
      files: [fileFact('Hooks/Post', 'a'), fileFact('hooks/post', 'b')]
    }],
    ['RUNTIME_ASSET_INPUT_INVALID', { runtimeRevision: 'E:/private/revision', files: [fileFact('asset', 'x')] }]
  ]
  for (const [code, input] of cases) {
    const result = core.createRuntimeAssetManifest(input)
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.ok(result.errors.some((error) => error.code === code), JSON.stringify(result))
  }
})

test('selectedSkills is explicit and canonical; empty means override plus overlay and no Skill', () => {
  const snapshot = makeSnapshot({ adoptedUnity: true })
  const runtimeAsset = makeRuntime()
  const empty = makeDesired(snapshot, runtimeAsset, [])
  assert.deepEqual(empty.artifacts.map((artifact) => artifact.owner).sort(), ['agentsOverride', 'localOverlay'])
  assert.equal(empty.artifacts.some((artifact) => artifact.targetRelativePath.startsWith('.agents/skills/')), false)

  const selected = makeDesired(snapshot, runtimeAsset, ['ozdqp-development', 'team-skill'])
  assert.deepEqual(selected.artifacts.map((artifact) => artifact.artifactId), [
    'residentSkill:ozdqp-development',
    'adoptedSkill:team-skill',
    'localOverlay',
    'agentsOverride'
  ])
  assert.equal(selected.artifacts.some((artifact) => artifact.targetRelativePath === 'AGENTS.md'), false)
  assert.equal(selected.artifacts.some((artifact) => artifact.targetRelativePath.includes('unity-skills')), false)

  const dynamicSnapshot = makeSnapshot({ dynamicResident: true })
  const dynamic = makeDesired(dynamicSnapshot, runtimeAsset, ['project-private'])
  assert.ok(dynamic.artifacts.some((artifact) => (
    artifact.artifactId === 'residentSkill:project-private'
      && artifact.targetRelativePath === '.agents/skills/project-private'
  )))

  for (const selection of [
    ['unity-skills'],
    ['missing-skill'],
    ['team-skill', 'ozdqp-development'],
    ['team-skill', 'TEAM-SKILL']
  ]) {
    assert.equal(core.validateSelectedMaterializationSkills(snapshot, selection).ok, false, selection.join(','))
  }
  const collision = makeSnapshot({ adoptedResidentCollision: true })
  assert.equal(core.validateSelectedMaterializationSkills(collision, ['ozdqp-development']).ok, false)
})

test('materialization identity changes on selectedSkills or runtimeRevision even with one snapshot and equal runtime bytes', () => {
  const snapshot = makeSnapshot()
  const runtimeA = makeRuntime('runtime-a', 'same')
  const runtimeB = makeRuntime('runtime-b', 'same')
  assert.equal(runtimeA.runtimeAssetId, runtimeB.runtimeAssetId)
  const emptyA = makeDesired(snapshot, runtimeA, [])
  const selectedA = makeDesired(snapshot, runtimeA, ['ozdqp-development'])
  const emptyB = makeDesired(snapshot, runtimeB, [])
  assert.notEqual(emptyA.requested.materializationId, selectedA.requested.materializationId)
  assert.notEqual(emptyA.requested.materializationId, emptyB.requested.materializationId)
  for (const desired of [emptyA, selectedA, emptyB]) {
    const serialized = JSON.stringify(desired)
    assert.doesNotMatch(serialized, /E:\/|private|absolutePath|mtimeMs|createdAt|sourceRoot/u)
  }
})

test('visibility ownership state is strict, content-addressed, locator-free, and baseline-bound', () => {
  const snapshot = makeSnapshot()
  const runtimeAsset = makeRuntime()
  const desired = makeDesired(snapshot, runtimeAsset, [])
  const state = visibilityStates.get(desired.requested.visibilityStateId)
  assert.equal(contracts.validateVisibilityOwnershipStateV1(state).valid, true)
  assert.equal(core.verifyVisibilityOwnershipState(state), true)
  assert.equal(
    state.visibilityStateId,
    domainHash(core.VISIBILITY_OWNERSHIP_STATE_HASH_DOMAIN, core.canonicalVisibilityOwnershipStatePayload(state))
  )
  assert.match(core.visibilityOwnershipTargetBaselineDigest(state.targets[0]), /^sha256:[a-f0-9]{64}$/u)
  assert.equal(core.verifyVisibilityOwnershipState({
    ...state,
    baseExclude: { ...state.baseExclude, contentDigest: sha('tampered') }
  }), false)
  assert.equal(core.verifyVisibilityOwnershipState({
    ...state,
    privateStateId: sha('tampered-private-state')
  }), false)
  const { privateStateId: _privateStateId, ...missingPrivateState } = state
  assert.equal(contracts.validateVisibilityOwnershipStateV1(missingPrivateState).valid, false)
  assert.equal(contracts.validateVisibilityOwnershipStateV1({
    ...state,
    baseExclude: { ...state.baseExclude, scope: 'unset' }
  }).valid, false)
  assert.equal(contracts.validateVisibilityOwnershipStateV1({
    ...state,
    targets: state.targets.map((target, index) => index === 0
      ? { ...target, trackedPaths: [{ path: '../escape', skipWorktree: false }] }
      : target)
  }).valid, false)
  assert.doesNotMatch(JSON.stringify(state), /locator|[A-Z]:\//u)
})

test('marker and durable mirror schemas are strict, path-bound, origin-aware, nullable, and hash-verifiable', () => {
  const snapshot = makeSnapshot()
  const runtimeAsset = makeRuntime()
  const desired = makeDesired(snapshot, runtimeAsset, [])
  const marker = markerFromDesired(desired)
  assert.equal(contracts.validateMaterializationMarkerV1(marker).valid, true)
  assert.equal(core.verifyMaterializationMarker(marker), true)
  assert.equal(contracts.validateMaterializationCommitRecordV1({ schemaVersion: 1, pathKey: PATH_KEY, marker }).valid, true)
  assert.equal(contracts.validateMaterializationCommitRecordV1({ schemaVersion: 1, pathKey: PATH_KEY, marker: null }).valid, true)
  assert.equal(contracts.validateMaterializationCommitRecordV1({ schemaVersion: 1, pathKey: sha('wrong'), marker }).valid, false)
  assert.equal(contracts.validateMaterializationMarkerV1({ ...marker, markerPath: 'E:/private/marker.json' }).valid, false)
  assert.equal(contracts.validateMaterializationMarkerV1({ ...marker, origin: { kind: 'sync', migrationId: sha('migration') } }).valid, false)
  assert.equal(contracts.validateMaterializationMarkerV1({ ...marker, origin: { kind: 'legacyMigration' } }).valid, false)
  assert.equal(contracts.validateMaterializationMarkerV1({ ...marker, selectedSkills: ['ozdqp-development'] }).valid, false)
  assert.equal(contracts.validateMaterializationMarkerV1({
    ...marker,
    selectedSkills: ['Unity-Skills'],
    artifacts: [
      ...marker.artifacts,
      {
        artifactId: 'adoptedSkill:Unity-Skills',
        owner: 'adoptedSkill',
        targetRelativePath: '.agents/skills/Unity-Skills',
        kind: 'directory',
        digest: sha('unity')
      }
    ].sort((left, right) => Buffer.compare(Buffer.from(left.targetRelativePath), Buffer.from(right.targetRelativePath)))
  }).valid, false)
  assert.equal(core.verifyMaterializationMarker({ ...marker, materializationId: sha('tampered-id') }), false)
  assert.doesNotMatch(JSON.stringify(marker), /markerPath|backupPath|createdAt|updatedAt|E:\/|private/u)
})

test('planner creates only missing targets and refuses first-sync exact project-owned content', () => {
  const snapshot = makeSnapshot()
  const runtimeAsset = makeRuntime()
  const selectedSkills = ['ozdqp-development']
  const desired = makeDesired(snapshot, runtimeAsset, selectedSkills)
  const pin = makePin(snapshot, selectedSkills)

  const create = assertPlan(core.planMaterialization(planningInput({ snapshot, runtimeAsset, pin, desired })))
  assert.deepEqual(create.summary, { create: 3, update: 0, delete: 0, keep: 0, conflict: 0 })
  assert.equal(create.markerStatus, 'missing')
  assert.equal(create.executable, true)
  assert.ok(create.git.operations.every((operation) => operation.ownership === 'unmanaged'))
  assert.ok(create.git.operations.every((operation) => [
    'adopt', 'setSkipWorktree', 'excludeLocal', 'setSkipAndExclude'
  ].includes(operation.action)))

  const existingFacts = transitionFacts(desired.artifacts, desired.artifacts, {
    currentVisibilityState: null,
    desiredVisibilityState: visibilityStates.get(desired.requested.visibilityStateId)
  })
  existingFacts.observations.push(
    { targetRelativePath: 'AGENTS.md', kind: 'file', digest: sha('project-owned'), isReparsePoint: false },
    { targetRelativePath: '.agents/skills/unity-skills', kind: 'directory', digest: sha('unity'), isReparsePoint: false },
    { targetRelativePath: '.agents/skills/project-skill', kind: 'directory', digest: sha('project'), isReparsePoint: false }
  )
  const adopt = assertPlan(core.planMaterialization(planningInput({
    snapshot,
    runtimeAsset,
    pin,
    desired,
    facts: existingFacts
  })))
  assert.deepEqual(adopt.summary, { create: 0, update: 0, delete: 0, keep: 0, conflict: 3 })
  assert.equal(adopt.executable, false)
  assert.equal(adopt.operations.some((operation) => operation.targetRelativePath === 'AGENTS.md'), false)
  assert.equal(adopt.operations.some((operation) => operation.targetRelativePath.includes('unity-skills')), false)
  assert.equal(contracts.validateMaterializePlanV1(adopt).valid, true)
  assert.equal(core.verifyMaterializePlanHash(adopt), true)
})

test('planner covers update, deselection delete, and unchanged keep from dual marker proof', () => {
  const snapshotA = makeSnapshot({ override: 'override-a' })
  const snapshotB = makeSnapshot({ override: 'override-b', revision: 'library-b' })
  const runtimeAsset = makeRuntime()
  const selectedSkills = ['ozdqp-development']
  const desiredA = makeDesired(snapshotA, runtimeAsset, selectedSkills)
  const markerA = markerFromDesired(desiredA)
  const desiredB = makeDesired(snapshotB, runtimeAsset, selectedSkills)
  const update = assertPlan(core.planMaterialization(planningInput({
    snapshot: snapshotB,
    runtimeAsset,
    pin: makePin(snapshotB, selectedSkills, snapshotA.snapshotId),
    desired: desiredB,
    marker: markerA,
    facts: transitionFacts(markerA.artifacts, desiredB.artifacts)
  })))
  assert.equal(update.markerStatus, 'valid')
  assert.equal(actionByOwner(update, 'agentsOverride'), 'update')
  assert.equal(actionByOwner(update, 'residentSkill'), 'keep')
  assert.equal(actionByOwner(update, 'localOverlay'), 'keep')

  const desiredEmpty = makeDesired(snapshotA, runtimeAsset, [])
  const deselect = assertPlan(core.planMaterialization(planningInput({
    snapshot: snapshotA,
    runtimeAsset,
    pin: makePin(snapshotA, [], snapshotA.snapshotId),
    desired: desiredEmpty,
    marker: markerA,
    facts: transitionFacts(markerA.artifacts, desiredEmpty.artifacts)
  })))
  assert.equal(actionByOwner(deselect, 'residentSkill'), 'delete')
  assert.equal(
    deselect.git.operations.find((operation) => operation.artifactId === 'residentSkill:ozdqp-development').action,
    'release'
  )
  assert.equal(deselect.summary.keep, 2)
  assert.equal(deselect.summary.delete, 1)
})

test('base-exclude drift refreshes private projection and unsafe bases conflict', () => {
  const snapshot = makeSnapshot()
  const runtimeAsset = makeRuntime()
  const currentDesired = makeDesired(snapshot, runtimeAsset, [])
  const marker = markerFromDesired(currentDesired)
  const refreshedState = makeVisibilityState(currentDesired.artifacts, {
    baseExclude: {
      scope: 'global',
      valueId: core.gitMaterializationConfigurationValueId('base-exclude'),
      contentDigest: sha('base-exclude-content-b')
    }
  })
  const refreshed = core.buildDesiredMaterialization({
    snapshot,
    runtimeAsset,
    selectedSkills: [],
    visibilityStateId: refreshedState.visibilityStateId
  })
  assert.equal(refreshed.ok, true, JSON.stringify(refreshed))
  const facts = transitionFacts(marker.artifacts, refreshed.desired.artifacts, {
    currentVisibilityState: visibilityStates.get(marker.visibilityStateId),
    desiredVisibilityState: refreshedState
  })
  facts.gitConfiguration = gitConfiguration({
    baseExcludeContentDigest: sha('base-exclude-content-b'),
    privateExclude: 'stale-private-exclude'
  })
  const plan = assertPlan(core.planMaterialization(planningInput({
    snapshot,
    runtimeAsset,
    pin: makePin(snapshot, [], snapshot.snapshotId),
    desired: refreshed.desired,
    marker,
    facts
  })))
  assert.equal(plan.git.configuration.action, 'configure')
  assert.ok(plan.git.configuration.effects.includes('refreshExcludeProjection'))
  assert.notEqual(plan.requested.visibilityStateId, marker.visibilityStateId)

  const unsafeFacts = { ...facts, gitConfiguration: gitConfiguration({
    baseExcludeSafe: false,
    baseExcludeContentDigest: sha('base-exclude-content-b'),
    privateExclude: 'stale-private-exclude'
  }) }
  const unsafe = assertPlan(core.planMaterialization(planningInput({
    snapshot,
    runtimeAsset,
    pin: makePin(snapshot, [], snapshot.snapshotId),
    desired: refreshed.desired,
    marker,
    facts: unsafeFacts
  })))
  assert.equal(unsafe.git.configuration.conflictKind, 'excludeBaseUnsafe')
  assert.equal(unsafe.executable, false)
})

test('Git configuration facts can release the final product-owned worktree excludes override', () => {
  const released = gitConfiguration({ desiredExcludesFile: null })
  assert.equal(released.excludesFileMatches, false)
  assert.notEqual(released.currentDigest, released.desiredDigest)
  assert.throws(() => core.createGitMaterializationConfigurationFact({
    isLinkedWorktree: true,
    supportsWorktreeConfig: true,
    worktreeConfigEnabled: true,
    hooksPathValueId: core.gitMaterializationConfigurationValueId('desired-hooks'),
    desiredHooksPathValueId: core.gitMaterializationConfigurationValueId('desired-hooks'),
    overlaySourceValueId: core.gitMaterializationConfigurationValueId('desired-overlay'),
    desiredOverlaySourceValueId: core.gitMaterializationConfigurationValueId('desired-overlay'),
    watchWorkspaceValueId: core.gitMaterializationConfigurationValueId('desired-watch-workspace'),
    desiredWatchWorkspaceValueId: core.gitMaterializationConfigurationValueId('desired-watch-workspace'),
    excludesFileValueId: core.gitMaterializationConfigurationValueId('desired-excludes'),
    desiredExcludesFileValueId: 'not-a-digest',
    baseExcludeSafe: true,
    baseExcludeValueId: core.gitMaterializationConfigurationValueId('base-exclude'),
    baseExcludeContentDigest: sha('base-exclude-content'),
    privateExcludeContentDigest: sha('private-exclude-content'),
    desiredPrivateExcludeContentDigest: sha('desired-private-exclude-content'),
    commonInfoExcludeDigest: sha('common-exclude'),
    cleanCommonInfoExcludeDigest: sha('common-exclude'),
    legacyCommonSiblingSafety: 'noSiblings',
    siblingFactsDigest: sha('siblings')
  }), /source facts are invalid/u)
})

test('marker-owned missing or modified content is dirty conflict and ordinary legacy links never auto-migrate', () => {
  const snapshot = makeSnapshot()
  const runtimeAsset = makeRuntime()
  const selectedSkills = ['ozdqp-development']
  const desired = makeDesired(snapshot, runtimeAsset, selectedSkills)
  const marker = markerFromDesired(desired)
  const baseFacts = transitionFacts(marker.artifacts, desired.artifacts)
  const missingFacts = structuredClone(baseFacts)
  const owned = missingFacts.observations.find((fact) => fact.targetRelativePath === 'AGENTS.override.md')
  Object.assign(owned, { kind: 'missing', isReparsePoint: false })
  delete owned.digest
  const dirty = assertPlan(core.planMaterialization(planningInput({
    snapshot,
    runtimeAsset,
    pin: makePin(snapshot, selectedSkills, snapshot.snapshotId),
    desired,
    marker,
    facts: missingFacts
  })))
  assert.equal(actionByOwner(dirty, 'agentsOverride'), 'conflict')
  assert.equal(dirty.operations.find((operation) => operation.owner === 'agentsOverride').conflict.kind, 'dirty')

  const firstFacts = transitionFacts([], desired.artifacts)
  const linked = firstFacts.observations.find((fact) => fact.targetRelativePath.includes('ozdqp-development'))
  Object.assign(linked, {
    kind: 'junction',
    isReparsePoint: true,
    linkClassification: 'legacy'
  })
  const legacy = assertPlan(core.planMaterialization(planningInput({
    snapshot,
    runtimeAsset,
    pin: makePin(snapshot, selectedSkills),
    desired,
    facts: firstFacts
  })))
  assert.equal(legacy.operations.find((operation) => operation.owner === 'residentSkill').conflict.kind, 'legacy-link')
  assert.equal(legacy.executable, false)
})

test('planner classifies collisions, escape, protected, external, and invalid reparse facts fail closed', () => {
  const snapshot = makeSnapshot()
  const runtimeAsset = makeRuntime()
  const desired = makeDesired(snapshot, runtimeAsset, [])
  const pin = makePin(snapshot, [])

  const collisionFacts = transitionFacts([], desired.artifacts)
  const override = collisionFacts.observations.find((fact) => fact.targetRelativePath === 'AGENTS.override.md')
  collisionFacts.observations.push({ ...override, targetRelativePath: 'agents.override.md' })
  const collision = assertPlan(core.planMaterialization(planningInput({ snapshot, runtimeAsset, pin, desired, facts: collisionFacts })))
  assert.equal(actionByOwner(collision, 'agentsOverride'), 'conflict')
  assert.equal(collision.operations.find((operation) => operation.owner === 'agentsOverride').conflict.kind, 'path-collision')

  const caseOnlyFacts = transitionFacts([], desired.artifacts)
  caseOnlyFacts.observations.find((fact) => fact.targetRelativePath === 'AGENTS.override.md').targetRelativePath = 'agents.override.md'
  const caseOnly = assertPlan(core.planMaterialization(planningInput({ snapshot, runtimeAsset, pin, desired, facts: caseOnlyFacts })))
  assert.equal(caseOnly.operations.find((operation) => operation.owner === 'agentsOverride').conflict.kind, 'path-collision')

  for (const [field, expected] of [['pathEscaped', 'path-escape'], ['protected', 'protected-target']]) {
    const facts = transitionFacts([], desired.artifacts)
    facts.observations.find((fact) => fact.targetRelativePath === 'AGENTS.override.md')[field] = true
    const plan = assertPlan(core.planMaterialization(planningInput({ snapshot, runtimeAsset, pin, desired, facts })))
    assert.equal(plan.operations.find((operation) => operation.owner === 'agentsOverride').conflict.kind, expected)
  }

  const externalFacts = transitionFacts([], desired.artifacts)
  Object.assign(externalFacts.observations.find((fact) => fact.targetRelativePath === 'AGENTS.override.md'), {
    kind: 'hardlink',
    isReparsePoint: false,
    linkClassification: 'external'
  })
  const external = assertPlan(core.planMaterialization(planningInput({ snapshot, runtimeAsset, pin, desired, facts: externalFacts })))
  assert.equal(external.operations.find((operation) => operation.owner === 'agentsOverride').conflict.kind, 'external-link')

  const malformed = transitionFacts([], desired.artifacts)
  malformed.observations[0].isReparsePoint = true
  const rejected = core.planMaterialization(planningInput({ snapshot, runtimeAsset, pin, desired, facts: malformed }))
  assert.equal(rejected.ok, false)
  assert.ok(rejected.errors.some((error) => error.code === 'MATERIALIZATION_FACT_INVALID'))
})

test('durable mirror and Git-admin marker must agree exactly or every desired target conflicts', () => {
  const snapshot = makeSnapshot()
  const runtimeAsset = makeRuntime()
  const desired = makeDesired(snapshot, runtimeAsset, [])
  const marker = markerFromDesired(desired)
  const facts = transitionFacts(marker.artifacts, desired.artifacts)
  const pin = makePin(snapshot, [], snapshot.snapshotId)
  const observedMarker = { ...marker, planHash: sha('different-proof') }
  const mismatch = assertPlan(core.planMaterialization(planningInput({
    snapshot,
    runtimeAsset,
    pin,
    desired,
    marker,
    facts,
    observedMarker
  })))
  assert.equal(mismatch.markerStatus, 'invalid')
  assert.equal(mismatch.summary.conflict, desired.artifacts.length)
  assert.ok(mismatch.operations.every((operation) => operation.conflict.kind === 'marker-invalid'))

  const collisionFacts = structuredClone(facts)
  collisionFacts.observations.push({
    ...collisionFacts.observations[0],
    targetRelativePath: collisionFacts.observations[0].targetRelativePath.toLocaleLowerCase('en-US')
  })
  const mismatchWithCollision = assertPlan(core.planMaterialization(planningInput({
    snapshot,
    runtimeAsset,
    pin,
    desired,
    marker,
    facts: collisionFacts,
    observedMarker
  })))
  assert.ok(mismatchWithCollision.operations.every((operation) => operation.conflict.kind === 'marker-invalid'))

  const missingDurable = assertPlan(core.planMaterialization(planningInput({
    snapshot,
    runtimeAsset,
    pin,
    desired,
    marker,
    facts,
    durableMarker: null,
    observedMarker: marker
  })))
  assert.equal(missingDurable.markerStatus, 'invalid')
  assert.equal(missingDurable.executable, false)

  const cleared = core.planMaterialization(planningInput({
    snapshot,
    runtimeAsset,
    pin: makePin(snapshot, []),
    desired,
    facts: transitionFacts([], desired.artifacts),
    durableMarker: { schemaVersion: 1, pathKey: PATH_KEY, marker: null },
    observedMarker: null
  }))
  assert.equal(cleared.ok, true, JSON.stringify(cleared))
  assert.equal(cleared.plan.markerStatus, 'missing')
})

test('planner requires exact controlled Git facts and rejects missing, duplicate, extra, or case-mismatched facts', () => {
  const snapshot = makeSnapshot()
  const runtimeAsset = makeRuntime()
  const desired = makeDesired(snapshot, runtimeAsset, [])
  const pin = makePin(snapshot, [])
  const base = transitionFacts([], desired.artifacts)
  const variants = [
    { ...base, gitFacts: base.gitFacts.slice(1) },
    { ...base, gitFacts: [...base.gitFacts, { ...base.gitFacts[0] }] },
    { ...base, gitFacts: [...base.gitFacts, gitFact('AGENTS.md')] },
    {
      ...base,
      gitFacts: base.gitFacts.map((fact) => fact.targetRelativePath === 'AGENTS.override.md'
        ? { ...fact, targetRelativePath: 'agents.override.md' }
        : fact)
    }
  ]
  for (const facts of variants) {
    const result = core.planMaterialization(planningInput({ snapshot, runtimeAsset, pin, desired, facts }))
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.ok(result.errors.some((error) => error.code === 'MATERIALIZATION_FACT_INVALID'))
  }
})

test('malformed source input returns a typed failure instead of throwing', () => {
  const snapshot = makeSnapshot()
  const runtimeAsset = makeRuntime()
  const desired = makeDesired(snapshot, runtimeAsset, [])
  const input = planningInput({ snapshot, runtimeAsset, pin: makePin(snapshot, []), desired })
  assert.doesNotThrow(() => core.planMaterialization({ ...input, snapshot: null }))
  const result = core.planMaterialization({ ...input, snapshot: null })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.code === 'MATERIALIZATION_SOURCE_INVALID'))
  assert.deepEqual(core.buildDesiredMaterialization(null), {
    ok: false,
    errors: [{ code: 'SNAPSHOT_INVALID', message: 'materialization sources are required' }]
  })
})

test('plan hash binds the strict safe plan and embedded Git digest without raw locator or private text', () => {
  const snapshot = makeSnapshot()
  const runtimeAsset = makeRuntime()
  const desired = makeDesired(snapshot, runtimeAsset, [])
  const plan = assertPlan(core.planMaterialization(planningInput({
    snapshot,
    runtimeAsset,
    pin: makePin(snapshot, []),
    desired
  })))
  assert.equal(core.verifyMaterializePlanHash(plan), true)
  assert.equal(core.verifyMaterializePlanHash({ ...plan, planHash: sha('tampered-plan') }), false)
  assert.equal(core.verifyMaterializePlanHash({ ...plan, git: { ...plan.git, digest: sha('tampered-git') } }), false)
  assert.equal(core.verifyMaterializePlanHash(rehashPlan({
    ...plan,
    requested: { ...plan.requested, materializationId: sha('self-consistent-outer-only') }
  })), false)
  const sourceTampered = structuredClone(plan)
  const overlay = sourceTampered.operations.find((operation) => operation.owner === 'localOverlay')
  overlay.after.source = {
    kind: 'snapshot',
    snapshotId: plan.requested.snapshotId,
    prefix: 'AGENTS.override.md'
  }
  assert.equal(core.verifyMaterializePlanHash(rehashPlan(sourceTampered)), false)
  assert.equal(contracts.validateMaterializePlanV1({ ...plan, rawWorktree: 'E:/private/repo' }).valid, false)
  assert.equal(contracts.validateMaterializePlanV1({
    ...plan,
    operations: plan.operations.map((operation, index) => index === 0 ? { ...operation, files: [] } : operation)
  }).valid, false)
  assert.doesNotMatch(JSON.stringify(plan), /E:\/|private|absolutePath|mtimeMs|createdAt|beforeText|afterText/u)
})

test('plan verifier rejects a rehashed but semantically altered current marker', () => {
  const snapshotA = makeSnapshot({ override: 'override-a' })
  const snapshotB = makeSnapshot({ override: 'override-b' })
  const runtimeAsset = makeRuntime()
  const desiredA = makeDesired(snapshotA, runtimeAsset, [])
  const markerA = markerFromDesired(desiredA)
  const desiredB = makeDesired(snapshotB, runtimeAsset, [])
  const plan = assertPlan(core.planMaterialization(planningInput({
    snapshot: snapshotB,
    runtimeAsset,
    pin: makePin(snapshotB, [], snapshotA.snapshotId),
    desired: desiredB,
    marker: markerA,
    facts: transitionFacts(markerA.artifacts, desiredB.artifacts)
  })))
  const tampered = structuredClone(plan)
  tampered.current.artifacts = tampered.current.artifacts.map((artifact) => artifact.owner === 'agentsOverride'
    ? { ...artifact, digest: sha('different-current-content') }
    : artifact)
  tampered.current.materializationId = domainHash(
    core.MATERIALIZATION_ID_HASH_DOMAIN,
    core.canonicalMaterializationIdentityPayload({
      snapshotId: tampered.current.snapshotId,
      selectedSkills: tampered.current.selectedSkills,
      runtimeRevision: tampered.current.runtimeRevision,
      runtimeAssetId: tampered.current.runtimeAssetId,
      artifacts: tampered.current.artifacts
    })
  )
  assert.equal(core.verifyMaterializationMarker(tampered.current), true)
  assert.equal(core.verifyMaterializePlanHash(rehashPlan(tampered)), false)
})

test('legacy migration record identity is strict, fixed-target only, rollback-stable, and path-free', () => {
  const identity = {
    planHash: sha('legacy-plan'),
    pathKey: PATH_KEY,
    worktreeId: WORKTREE_ID,
    snapshotId: sha('snapshot'),
    materializationId: sha('materialization'),
    visibilityStateId: sha('visibility-state'),
    backupManifestId: sha('backup-manifest'),
    backupPrivateStateId: sha('backup-private-state'),
    artifacts: [{
      artifactId: 'agentsOverride',
      owner: 'agentsOverride',
      targetRelativePath: 'AGENTS.override.md',
      kind: 'file',
      legacyKind: 'fileHardlink',
      sourceArtifactId: sha('source-artifact'),
      beforeDigest: sha('after'),
      afterDigest: sha('after')
    }],
    createdArtifacts: [],
    gitVisibilityDigest: sha('git')
  }
  const migrationId = domainHash(
    core.LEGACY_MIGRATION_ID_HASH_DOMAIN,
    core.canonicalLegacyMigrationRecordIdentityPayload(identity)
  )
  const committed = { schemaVersion: 1, migrationId, status: 'committed', ...identity }
  assert.equal(contracts.validateLegacyMigrationRecordV1(committed).valid, true)
  assert.equal(core.verifyLegacyMigrationRecordIdentity(committed), true)
  assert.equal(core.verifyLegacyMigrationRecordIdentity({
    ...committed,
    artifacts: committed.artifacts.map((artifact) => ({ ...artifact, beforeDigest: sha('tampered') }))
  }), false)
  assert.equal(core.verifyLegacyMigrationRecordIdentity({
    ...committed,
    backupPrivateStateId: sha('tampered-private-backup')
  }), false)
  assert.equal(contracts.validateLegacyMigrationRecordV1({
    ...committed,
    backupPrivateStateId: undefined
  }).valid, false)
  assert.equal(contracts.validateLegacyMigrationRecordV1({
    ...committed,
    artifacts: committed.artifacts.map((artifact) => ({ ...artifact, targetRelativePath: 'AGENTS.md' }))
  }).valid, false)
  assert.equal(contracts.validateLegacyMigrationRecordV1({ ...committed, backupPath: 'E:/private/backup' }).valid, false)

  const rolledBack = { ...committed, status: 'rolledBack', rollbackPlanHash: sha('rollback-plan') }
  assert.equal(contracts.validateLegacyMigrationRecordV1(rolledBack).valid, true)
  assert.equal(core.verifyLegacyMigrationRecordIdentity(rolledBack), true)
  assert.doesNotMatch(JSON.stringify(rolledBack), /backupPath|markerPath|E:\/|private|createdAt/u)
})

test('materialized pin compensation clears only materialized truth and is idempotent', () => {
  const snapshot = makeSnapshot()
  const pin = makePin(snapshot, ['ozdqp-development'], snapshot.snapshotId)
  const first = core.rollbackMaterializedWorktreePin(pin)
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.equal(first.pin.materializedSnapshot, null)
  assert.equal(first.pin.requestedSnapshot, snapshot.snapshotId)
  assert.deepEqual(first.pin.selectedSkills, ['ozdqp-development'])
  assert.equal(first.pin.claimState, 'claimed')
  assert.equal(first.idempotent, false)
  const second = core.rollbackMaterializedWorktreePin(first.pin)
  assert.equal(second.ok, true)
  assert.equal(second.idempotent, true)
  const detached = core.rollbackMaterializedWorktreePin({
    ...pin,
    requestedSnapshot: null,
    materializedSnapshot: null,
    selectedSkills: [],
    claimState: 'detached'
  })
  assert.equal(detached.ok, false)
  assert.equal(detached.error.code, 'PIN_TRANSITION_NOT_ALLOWED')
})
