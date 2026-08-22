import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { createHub } from '../dist/adapters/create-hub.js'
import { createLocalDurableSchemaResolver } from '../dist/adapters/local-durable-schema.js'
import { createLocalP2ApplicationPorts } from '../dist/adapters/local-p2-ports.js'
import { LOCAL_RUNTIME_ASSET_PATHS } from '../dist/adapters/local-runtime-assets.js'
import {
  LEGACY_MIGRATION_ID_HASH_DOMAIN,
  canonicalLegacyMigrationRecordIdentityPayload,
  domainSeparatedSha256
} from '../dist/core/index.js'
import { createLibrarySnapshotManifest } from '../dist/core/snapshot.js'
import { createLocalHost, openLocalHost } from '../dist/local/create-local-host.js'

const NOW = '2031-02-03T04:05:06.000Z'
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

function sha256Identifier(value) {
  return `sha256:${sha256(value)}`
}

function writeFixtureFile(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, contents, 'utf8')
}

function writeJson(file, value) {
  writeFixtureFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true
  })
  assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join('\n'))
  return result.stdout || ''
}

function stringLeaves(value, leaves = []) {
  if (typeof value === 'string') leaves.push(value)
  else if (Array.isArray(value)) value.forEach((entry) => stringLeaves(entry, leaves))
  else if (value && typeof value === 'object') Object.values(value).forEach((entry) => stringLeaves(entry, leaves))
  return leaves
}

function assertLocatorFree(value, locators) {
  const probes = locators.map((locator) => path.resolve(locator).replaceAll('\\', '/').toLowerCase())
  for (const leaf of stringLeaves(value)) {
    const normalized = leaf.replaceAll('\\', '/').toLowerCase()
    assert.equal(probes.some((probe) => normalized.includes(probe)), false, `host locator leaked: ${leaf}`)
  }
}

function assertNoTransactionResidue(root) {
  const journal = path.join(root, '.skill-graft-transactions')
  assert.deepEqual(fs.existsSync(journal) ? fs.readdirSync(journal) : [], [])
}

function gitPath(worktree, relativePath) {
  const resolved = git(worktree, ['rev-parse', '--git-path', relativePath]).trim()
  assert.notEqual(resolved, '', `Git did not resolve ${relativePath}`)
  return path.isAbsolute(resolved) ? path.normalize(resolved) : path.resolve(worktree, resolved)
}

function relativeTree(root) {
  if (!fs.existsSync(root)) return []
  const entries = []
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      entries.push(path.relative(root, absolute).replaceAll('\\', '/'))
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(absolute)
    }
  }
  visit(root)
  return entries.sort()
}

function assertNoMaterializerGitResidue(worktree) {
  const transactions = gitPath(worktree, 'skill-graft/transactions')
  assert.deepEqual(relativeTree(transactions), [], 'materializer transaction token/phase residue remains')
  assert.equal(fs.existsSync(gitPath(worktree, 'config.worktree.lock')), false)
  assert.equal(fs.existsSync(gitPath(worktree, 'index.lock')), false)

  const privateRoot = gitPath(worktree, 'skill-graft')
  const ownedLocks = relativeTree(privateRoot).filter((relative) => (
    /(?:^|[./-])lock(?:$|[./-])/i.test(relative)
    || /\.(?:prepare|finalize)(?:$|[./-])/i.test(relative)
  ))
  assert.deepEqual(ownedLocks, [], 'materializer private-sidecar owned lock/phase residue remains')
}

function pathPort() {
  const comparisonKey = (value) => {
    const resolved = path.resolve(value)
    return process.platform === 'win32' || process.platform === 'darwin'
      ? resolved.toLowerCase()
      : resolved
  }
  return {
    join: (...parts) => path.join(...parts),
    resolve: (...parts) => path.resolve(...parts),
    dirname: (value) => path.dirname(value),
    basename: (value) => path.basename(value),
    comparisonKey,
    isSameOrInside(root, target) {
      const relation = path.relative(comparisonKey(root), comparisonKey(target))
      return relation === '' || relation !== '..' && !relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation)
    }
  }
}

function emptyWorktreeFacts() {
  return {
    scanRoots: [],
    rules: { paths: [], require: [], exclude: [] },
    observations: []
  }
}

function inertSnapshots() {
  return {
    observe: () => { throw new Error('unused') },
    store: () => { throw new Error('unused') },
    list: () => [],
    read: () => null
  }
}

function localP2Fixture({ canonical, alias, unstable = false, overlayOnly = false }) {
  const hubRoot = path.resolve(canonical, '..', 'hub')
  const paths = pathPort()
  let realpathCalls = 0
  const directoryKeys = new Set([canonical, alias, hubRoot].map(paths.comparisonKey))
  const context = {
    hubRoot,
    path: paths,
    fs: {
      exists: (target) => directoryKeys.has(paths.comparisonKey(target)),
      isDirectory: (target) => directoryKeys.has(paths.comparisonKey(target)),
      isFile: () => false,
      isSymbolicLink: (target) => paths.comparisonKey(target) === paths.comparisonKey(alias),
      readDir: () => [],
      readText: () => null,
      writeText: () => {},
      mkdirp: () => {},
      remove: () => {},
      rename: () => {},
      statMtimeMs: () => 0,
      statId: () => null,
      realpath(target) {
        if (paths.comparisonKey(target) === paths.comparisonKey(alias)) {
          realpathCalls += 1
          if (unstable && realpathCalls % 2 === 0) return path.resolve(canonical, '..', 'changed')
          return canonical
        }
        return directoryKeys.has(paths.comparisonKey(target)) ? paths.resolve(target) : null
      }
    },
    link: {
      samePath: (left, right) => paths.comparisonKey(left) === paths.comparisonKey(right),
      isLinked(left, right) {
        return overlayOnly
          && paths.comparisonKey(left) === paths.comparisonKey(path.join(canonical, '.codex', 'local-overlay'))
          && paths.comparisonKey(right) === paths.comparisonKey(path.join(hubRoot, 'overlay'))
      },
      linkDirectory: () => {},
      linkFile: () => {},
      unlink: () => {}
    },
    git: { configGet: () => null, output: () => '' },
    persist: {
      readJson: (_file, fallback) => structuredClone(fallback),
      writeJson: () => {},
      readList: () => [],
      readState: () => ({ version: 1, items: [], lastIngest: null }),
      writeState: () => {}
    },
    clock: { nowIso: () => NOW, nowMs: () => Date.parse(NOW) },
    ids: { next: () => 'fixture-id' },
    hash: { sha256 }
  }
  const queries = {
    readStatusFacts: () => ({ hubRoot, gameRepo: null, items: [], lastIngest: null }),
    listSkillFacts: () => [],
    readWorktreeFacts: () => overlayOnly ? {
      scanRoots: [canonical],
      rules: { paths: [canonical], require: [], exclude: [] },
      observations: [{
        cloneIdentity: 'clone:fixture',
        cloneRoot: path.dirname(canonical),
        seed: {
          identity: 'worktree:fixture',
          ordinal: 0,
          name: path.basename(canonical),
          path: canonical,
          branch: 'main',
          head: 'a'.repeat(40),
          changedAtMs: 1,
          exists: true,
          sameAsHub: false,
          attached: false,
          doNotAuto: false,
          officialPresent: false,
          overrideLinked: false,
          locked: false,
          prunable: false,
          recognition: {
            name: path.basename(canonical),
            exists: true,
            isDirectory: true,
            sameAsHub: false,
            explicitlyAllowed: true,
            requiredMarkers: []
          }
        },
        listed: []
      }]
    } : emptyWorktreeFacts(),
    readSkill: () => ({ status: 'not-found', reason: 'missing' }),
    listHistory: () => [],
    inspectWorktree: () => { throw new Error('unused') }
  }
  const p2 = createLocalP2ApplicationPorts(context, {
    runtimeRevision: 'fixture-runtime',
    queries,
    snapshots: inertSnapshots(),
    persist: { readOptionalJson: () => null }
  })
  return { context, p2 }
}

test('Local worktree identity canonicalizes stable aliases and rejects unstable reparse resolution', async () => {
  const canonical = path.resolve(os.tmpdir(), 'skill-graft-canonical-worktree')
  const alias = path.resolve(os.tmpdir(), 'skill-graft-alias-worktree')
  const stable = localP2Fixture({ canonical, alias })
  assert.deepEqual(await stable.p2.identities.resolve(alias), await stable.p2.identities.resolve(canonical))

  const unsafe = localP2Fixture({ canonical, alias, unstable: true })
  assert.throws(() => unsafe.p2.identities.resolve(alias), /resolved safely/)
})

test('V1 migration observation recognizes an isolated managed local-overlay link without persisting raw paths', async () => {
  const canonical = path.resolve(os.tmpdir(), 'skill-graft-partial-link-worktree')
  const alias = path.resolve(os.tmpdir(), 'skill-graft-unused-alias')
  const fixture = localP2Fixture({ canonical, alias, overlayOnly: true })
  const facts = await fixture.p2.state.observeV1Worktrees()
  assert.equal(facts.length, 1)
  assert.equal(facts[0].linked, true)
  assert.equal(facts[0].claimed, false)
  assert.deepEqual(facts[0].selectedSkills, [])
  assert.match(facts[0].pathKey, /^sha256:[a-f0-9]{64}$/)
  assert.equal(JSON.stringify(facts).includes(canonical), false)
})

test('Local durable schemas strictly cover state, sessions, history, and transactional snapshot manifests', () => {
  const schemaFor = createLocalDurableSchemaResolver()
  const stateSchema = schemaFor('skill-review/state.json')
  assert.equal(stateSchema.validate(null).valid, false)
  assert.equal(stateSchema.validate({ version: 1, items: [], lastIngest: null }).valid, true)
  assert.equal(stateSchema.validate({ version: 1, items: [] }).valid, true)
  assert.equal(stateSchema.validate({ version: 1, items: [], lastIngest: null, surprise: true }).valid, false)
  assert.equal(stateSchema.validate({ schemaVersion: 3, future: { opaque: true } }).valid, true)
  assert.equal(stateSchema.validateWrite({ schemaVersion: 3, future: { opaque: true } }).valid, false)

  const session = {
    id: 'session-1', kind: 'chat', path: '', worktree: '', intent: '', pid: 0,
    promptFile: '', logFile: '', lastFile: '', startedAt: NOW, status: 'queued',
    exitCode: null, error: '', codexSessionId: '', summary: '', lastMessage: '', inboxIds: []
  }
  const sessionsSchema = schemaFor('skill-review/sessions.json')
  assert.equal(sessionsSchema.validate({ sessions: [session] }).valid, true)
  assert.equal(sessionsSchema.validate({ sessions: [{ ...session, rawSecret: 'must fail' }] }).valid, false)
  assert.equal(sessionsSchema.validate({ sessions: [session, session] }).valid, false)
  const legacyCompleted = {
    ...session,
    kind: 'attach',
    status: 'completed',
    exitCode: 0,
    canResume: false
  }
  assert.equal(sessionsSchema.validate({ sessions: [legacyCompleted] }).valid, true)
  const attachCompletion = {
    targetId: `worktree:${'a'.repeat(24)}`,
    pathKey: `sha256:${'b'.repeat(64)}`,
    materializationId: `sha256:${'c'.repeat(64)}`,
    completedAt: NOW
  }
  assert.equal(sessionsSchema.validate({ sessions: [{ ...legacyCompleted, attachCompletion }] }).valid, true)
  for (const malformed of [
    { ...legacyCompleted, attachCompletion: { ...attachCompletion, locator: 'C:\\raw\\probe' } },
    { ...legacyCompleted, status: 'waiting', attachCompletion },
    { ...legacyCompleted, canResume: true, attachCompletion },
    { ...legacyCompleted, attachCompletion: { ...attachCompletion, targetId: 'C:\\raw\\probe' } },
    { ...legacyCompleted, attachCompletion: { ...attachCompletion, materializationId: 'not-a-digest' } }
  ]) {
    assert.equal(sessionsSchema.validate({ sessions: [malformed] }).valid, false)
  }

  const historySchema = schemaFor('skill-review/history/session-1.json')
  assert.equal(historySchema.validate({
    type: 'codex-session', kind: 'chat', path: '', worktree: '', sessionId: 'session-1'
  }).valid, true)
  assert.equal(historySchema.validate({ type: 'unknown', payload: true }).valid, false)

  const manifestResult = createLibrarySnapshotManifest({
    source: { kind: 'library', id: 'fixture', revision: 'revision' },
    createdAt: NOW,
    files: [{
      path: 'ozdqp-development/SKILL.md',
      size: 7,
      sha256: `sha256:${sha256('content')}`,
      mode: '100644',
      isReparsePoint: false
    }]
  })
  assert.equal(manifestResult.ok, true)
  const snapshotSchema = schemaFor(`skill-review/library/snapshots/${manifestResult.manifest.snapshotId.slice(7)}.json`)
  assert.equal(snapshotSchema.validate(manifestResult.manifest).valid, true)
  assert.equal(snapshotSchema.validate({ ...manifestResult.manifest, unexpected: true }).valid, false)
  assert.equal(schemaFor('skill-review/library/snapshots/not-a-hash.json'), undefined)

  const pathKey = sha256Identifier('schema-materialization-path')
  const currentRecord = { schemaVersion: 1, pathKey, marker: null }
  const currentSchema = schemaFor(`skill-review/materializations/current/${pathKey.slice(7)}.json`)
  assert.ok(currentSchema)
  assert.equal(currentSchema.validate(currentRecord).valid, true)
  assert.equal(currentSchema.validate({ ...currentRecord, locator: 'C:\\raw\\probe' }).valid, false)
  assert.equal(currentSchema.validate({ ...currentRecord, pathKey: sha256Identifier('wrong-path') }).valid, false)
  assert.equal(
    schemaFor(`skill-review/materializations/current/${sha256('wrong-route')}.json`).validate(currentRecord).valid,
    false
  )
  assert.equal(schemaFor('skill-review/materializations/current/not-a-hash.json'), undefined)

  const migrationIdentity = {
    planHash: sha256Identifier('schema-migration-plan'),
    pathKey,
    worktreeId: `worktree:${'a'.repeat(24)}`,
    snapshotId: sha256Identifier('schema-migration-snapshot'),
    materializationId: sha256Identifier('schema-migration-materialization'),
    visibilityStateId: sha256Identifier('schema-migration-visibility'),
    backupManifestId: sha256Identifier('schema-migration-backup'),
    backupPrivateStateId: sha256Identifier('schema-migration-private'),
    artifacts: [],
    createdArtifacts: [],
    gitVisibilityDigest: sha256Identifier('schema-migration-git')
  }
  const migrationId = domainSeparatedSha256(
    LEGACY_MIGRATION_ID_HASH_DOMAIN,
    canonicalLegacyMigrationRecordIdentityPayload(migrationIdentity)
  )
  const migrationRecord = {
    schemaVersion: 1,
    migrationId,
    ...migrationIdentity,
    status: 'committed'
  }
  const migrationSchema = schemaFor(`skill-review/materializations/migrations/${migrationId.slice(7)}.json`)
  assert.ok(migrationSchema)
  assert.equal(migrationSchema.validate(migrationRecord).valid, true)
  assert.equal(migrationSchema.validate({ ...migrationRecord, locator: 'C:\\raw\\probe' }).valid, false)
  assert.equal(migrationSchema.validate({ ...migrationRecord, migrationId: sha256Identifier('wrong-id') }).valid, false)
  assert.equal(
    schemaFor(`skill-review/materializations/migrations/${sha256('wrong-route')}.json`).validate(migrationRecord).valid,
    false
  )
  assert.equal(schemaFor('skill-review/materializations/migrations/not-a-hash.json'), undefined)
})

test('fresh Local data root inspects empty, snapshots, and migrates through dry-run and commit', async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-p2-fresh-'))
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dataRoot, 'skills', 'ozdqp-development'), { recursive: true })
  fs.writeFileSync(path.join(dataRoot, 'skills', 'ozdqp-development', 'SKILL.md'), '# fixture\n', 'utf8')
  fs.writeFileSync(path.join(dataRoot, 'AGENTS.override.md'), '# fixture\n', 'utf8')

  const host = await openLocalHost({ packageRoot: PACKAGE_ROOT, dataRoot, hostId: 'local-p2-test' })
  const execute = (requestId, payload) => host.application.execute({
    ...payload,
    meta: host.commandMeta('test', requestId)
  })

  const empty = await execute('fresh-inspect-empty', { kind: 'inspectSchema' })
  assert.equal(empty.ok, true)
  assert.equal(empty.data.status, 'empty')
  assert.equal(fs.existsSync(path.join(dataRoot, 'skill-review', 'state.json')), false)

  const created = await execute('fresh-create-snapshot', { kind: 'createSnapshot' })
  assert.equal(created.ok, true)
  const dryRun = await execute('fresh-migration-dry-run', { kind: 'migrateState', mode: 'dryRun' })
  assert.equal(dryRun.ok, true)
  assert.equal(dryRun.data.status, 'planned')
  assert.equal(fs.existsSync(path.join(dataRoot, 'skill-review', 'state.json')), false)

  const committed = await execute('fresh-migration-commit', {
    kind: 'migrateState',
    mode: 'commit',
    planHash: dryRun.data.plan.planHash
  })
  assert.equal(committed.ok, true)
  assert.equal(committed.data.status, 'committed')
  const current = await execute('fresh-inspect-current', { kind: 'inspectSchema' })
  assert.equal(current.ok, true)
  assert.equal(current.data.status, 'current')
})

test('Local composition claims, materializes, completes attach, and reopens as an exact keep', { timeout: 120_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-p3-composition-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dataRoot = path.join(root, 'data')
  const worktree = path.join(root, 'game-tree')
  const selectedSkill = 'ozdqp-development'
  const overrideContents = '# composition override\n'
  const skillContents = '# composition skill\n'
  writeFixtureFile(path.join(dataRoot, 'AGENTS.override.md'), overrideContents)
  writeFixtureFile(path.join(dataRoot, 'skills', selectedSkill, 'SKILL.md'), skillContents)
  fs.mkdirSync(worktree, { recursive: true })
  git(worktree, ['init', '-q'])
  writeFixtureFile(path.join(worktree, 'project.txt'), 'tracked project file\n')
  git(worktree, ['add', 'project.txt'])
  git(worktree, [
    '-c', 'user.name=Composition Test',
    '-c', 'user.email=composition@example.invalid',
    'commit', '-qm', 'fixture'
  ])
  git(worktree, ['config', 'extensions.worktreeConfig', 'true'])

  const host = await openLocalHost({ packageRoot: PACKAGE_ROOT, dataRoot, hostId: 'local-p3-composition' })
  const execute = (requestId, payload) => host.application.execute({
    ...payload,
    meta: host.commandMeta('test', requestId)
  })
  const created = await execute('composition-create-snapshot', { kind: 'createSnapshot' })
  assert.equal(created.ok, true, JSON.stringify(created))
  const snapshotId = created.data.snapshot.snapshotId
  const migration = await execute('composition-plan-v1-migration', { kind: 'migrateState', mode: 'dryRun' })
  assert.equal(migration.ok, true, JSON.stringify(migration))
  const migrated = await execute('composition-commit-v1-migration', {
    kind: 'migrateState',
    mode: 'commit',
    planHash: migration.data.plan.planHash
  })
  assert.equal(migrated.ok, true, JSON.stringify(migrated))

  const sessionId = 'composition-attach-session'
  const reviewRoot = path.join(dataRoot, 'skill-review')
  const promptFile = path.join(reviewRoot, `prompt-${sessionId}.txt`)
  const logFile = path.join(reviewRoot, `session-${sessionId}.log`)
  const lastFile = path.join(reviewRoot, `session-${sessionId}.last.txt`)
  writeFixtureFile(promptFile, 'authorize one materialization\n')
  writeFixtureFile(logFile, '')
  writeFixtureFile(lastFile, '')
  writeJson(path.join(reviewRoot, 'sessions.json'), {
    sessions: [{
      id: sessionId,
      kind: 'attach',
      path: '',
      worktree,
      intent: 'authorize one materialization',
      pid: 0,
      promptFile,
      logFile,
      lastFile,
      startedAt: NOW,
      status: 'waiting',
      exitCode: 0,
      error: '',
      codexSessionId: '00000000-0000-0000-0000-000000000001',
      endedAt: NOW,
      canResume: true,
      summary: '',
      lastMessage: '',
      inboxIds: []
    }]
  })

  const claimed = await execute('composition-claim', {
    kind: 'claimWorktree',
    worktree,
    snapshotId,
    selectedSkills: [selectedSkill],
    sessionId
  })
  assert.equal(claimed.ok, true, JSON.stringify(claimed))
  assert.equal(claimed.data.changed, true)
  assert.equal(claimed.data.pin.claimState, 'claimed')
  assert.equal(claimed.data.pin.materializedSnapshot, null)

  const planned = await execute('composition-plan-sync', { kind: 'planSync', worktree })
  assert.equal(planned.ok, true, JSON.stringify(planned))
  assert.equal(planned.data.status, 'planned')
  assert.equal(planned.data.plan.executable, true)
  assert.deepEqual(
    planned.data.plan.operations.map(({ targetRelativePath, action }) => [targetRelativePath, action]),
    [
      ['.agents/skills/ozdqp-development', 'create'],
      ['.codex/local-overlay', 'create'],
      ['AGENTS.override.md', 'create']
    ]
  )

  const synced = await execute('composition-sync', {
    kind: 'sync',
    worktree,
    planHash: planned.data.plan.planHash,
    sessionId
  })
  assert.equal(synced.ok, true, JSON.stringify(synced))
  assert.equal(synced.data.changed, true)
  assert.equal(synced.data.sessionCompleted, true)
  assert.equal(synced.data.pin.materializedSnapshot, snapshotId)
  assert.equal(fs.readFileSync(path.join(worktree, 'project.txt'), 'utf8'), 'tracked project file\n')
  assert.equal(git(worktree, ['status', '--porcelain=v1']), '')
  assert.equal(fs.readFileSync(path.join(worktree, 'AGENTS.override.md'), 'utf8'), overrideContents)
  assert.equal(
    fs.readFileSync(path.join(worktree, '.agents', 'skills', selectedSkill, 'SKILL.md'), 'utf8'),
    skillContents
  )
  for (const relative of LOCAL_RUNTIME_ASSET_PATHS) {
    assert.deepEqual(
      fs.readFileSync(path.join(worktree, '.codex', 'local-overlay', ...relative.split('/'))),
      fs.readFileSync(path.join(PACKAGE_ROOT, 'overlay', ...relative.split('/'))),
      relative
    )
  }

  const stateFile = path.join(reviewRoot, 'state.json')
  const state = readJson(stateFile)
  const pin = state.worktrees[claimed.data.pathKey]
  assert.deepEqual(pin, synced.data.pin)
  const currentFile = path.join(
    reviewRoot,
    'materializations',
    'current',
    `${claimed.data.pathKey.slice('sha256:'.length)}.json`
  )
  const currentRecord = readJson(currentFile)
  assert.equal(currentRecord.pathKey, claimed.data.pathKey)
  assert.equal(currentRecord.marker.materializationId, synced.data.marker.materializationId)
  const completedSession = readJson(path.join(reviewRoot, 'sessions.json')).sessions[0]
  assert.equal(completedSession.status, 'completed')
  assert.equal(completedSession.canResume, false)
  assert.deepEqual(Object.keys(completedSession.attachCompletion).sort(), [
    'completedAt', 'materializationId', 'pathKey', 'targetId'
  ])
  assert.deepEqual(
    {
      targetId: completedSession.attachCompletion.targetId,
      pathKey: completedSession.attachCompletion.pathKey,
      materializationId: completedSession.attachCompletion.materializationId
    },
    {
      targetId: claimed.data.worktreeId,
      pathKey: claimed.data.pathKey,
      materializationId: synced.data.marker.materializationId
    }
  )
  assertLocatorFree(
    [claimed.data, planned.data, synced.data, pin, currentRecord, completedSession.attachCompletion],
    [PACKAGE_ROOT, dataRoot, worktree]
  )
  assertNoTransactionResidue(dataRoot)
  assertNoMaterializerGitResidue(worktree)

  const durableBeforeReopen = {
    state: fs.readFileSync(stateFile),
    current: fs.readFileSync(currentFile),
    sessions: fs.readFileSync(path.join(reviewRoot, 'sessions.json'))
  }
  const reopened = await openLocalHost({ packageRoot: PACKAGE_ROOT, dataRoot, hostId: 'local-p3-composition-reopen' })
  const reopenExecute = (requestId, payload) => reopened.application.execute({
    ...payload,
    meta: reopened.commandMeta('test', requestId)
  })
  const keepPlan = await reopenExecute('composition-reopen-plan', { kind: 'planSync', worktree })
  assert.equal(keepPlan.ok, true, JSON.stringify(keepPlan))
  assert.equal(keepPlan.data.status, 'planned')
  assert.equal(keepPlan.data.plan.executable, true)
  assert.equal(keepPlan.data.plan.operations.every((operation) => operation.action === 'keep'), true)
  assert.equal(keepPlan.data.plan.git.operations.every((operation) => operation.action === 'keep'), true)
  assert.equal(keepPlan.data.plan.git.configuration.action, 'keep')
  const noOp = await reopenExecute('composition-reopen-sync', {
    kind: 'sync',
    worktree,
    planHash: keepPlan.data.plan.planHash,
    sessionId
  })
  assert.equal(noOp.ok, true, JSON.stringify(noOp))
  assert.equal(noOp.data.changed, false)
  assert.equal(noOp.data.sessionCompleted, true)
  assert.equal(noOp.data.marker.materializationId, synced.data.marker.materializationId)
  assert.deepEqual(fs.readFileSync(stateFile), durableBeforeReopen.state)
  assert.deepEqual(fs.readFileSync(currentFile), durableBeforeReopen.current)
  assert.deepEqual(fs.readFileSync(path.join(reviewRoot, 'sessions.json')), durableBeforeReopen.sessions)
  assertLocatorFree([keepPlan.data, noOp.data], [PACKAGE_ROOT, dataRoot, worktree])
  assertNoTransactionResidue(dataRoot)
  assertNoMaterializerGitResidue(worktree)
})

test('Local recovery rechecks late WALs, rejects malformed commands before recovery I/O, and clears failed attempts', async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-p2-late-wal-'))
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }))
  const host = await openLocalHost({ packageRoot: PACKAGE_ROOT, dataRoot, hostId: 'local-p2-late-wal-test' })

  const first = await host.application.execute({
    kind: 'inspectSchema',
    meta: host.commandMeta('test', 'late-wal-before')
  })
  assert.equal(first.ok, true)

  const journalRoot = path.join(dataRoot, '.skill-graft-transactions')
  const walFile = path.join(journalRoot, 'late.wal.json')
  const corruptBytes = Buffer.from('{"SENTINEL-LATE-WAL":', 'utf8')
  fs.mkdirSync(journalRoot, { recursive: true })
  fs.writeFileSync(walFile, corruptBytes)

  const malformed = await host.application.execute({
    kind: 'futureMalformedCommand',
    meta: host.commandMeta('test', 'late-wal-malformed')
  })
  assert.equal(malformed.ok, false)
  assert.equal(malformed.error.code, 'UNSUPPORTED_COMMAND')
  assert.deepEqual(fs.readFileSync(walFile), corruptBytes)

  const corrupt = await host.application.execute({
    kind: 'inspectSchema',
    meta: host.commandMeta('test', 'late-wal-corrupt')
  })
  assert.equal(corrupt.ok, false)
  assert.equal(corrupt.error.code, 'STATE_CORRUPT')
  assert.equal(corrupt.error.retryable, false)
  assert.equal(JSON.stringify(corrupt).includes('SENTINEL-LATE-WAL'), false)

  fs.unlinkSync(walFile)
  const retry = await host.application.execute({
    kind: 'inspectSchema',
    meta: host.commandMeta('test', 'late-wal-retry')
  })
  assert.equal(retry.ok, true)
})

test('Local inspection reports an unknown future schema while writes leave its bytes unchanged', async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-p2-future-schema-'))
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }))
  const reviewRoot = path.join(dataRoot, 'skill-review')
  fs.mkdirSync(reviewRoot, { recursive: true })
  const stateFile = path.join(reviewRoot, 'state.json')
  const stateBytes = Buffer.from('{"schemaVersion":3,"future":{"opaque":true}}\n', 'utf8')
  fs.writeFileSync(stateFile, stateBytes)

  const host = await openLocalHost({ packageRoot: PACKAGE_ROOT, dataRoot, hostId: 'local-p2-future-test' })
  const inspected = await host.application.execute({
    kind: 'inspectSchema',
    meta: host.commandMeta('test', 'future-schema-inspect')
  })
  assert.equal(inspected.ok, true)
  assert.equal(inspected.data.status, 'unsupported')
  assert.equal(inspected.data.detectedSchemaVersion, 3)

  const rejected = await host.application.execute({
    kind: 'createSnapshot',
    meta: host.commandMeta('test', 'future-schema-write')
  })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error.code, 'STATE_VERSION_UNSUPPORTED')
  assert.deepEqual(fs.readFileSync(stateFile), stateBytes)
  assert.equal(fs.existsSync(path.join(reviewRoot, 'application-ledger.json')), false)
  assert.equal(fs.existsSync(path.join(reviewRoot, 'application-audit.json')), false)
  assert.equal(fs.existsSync(path.join(reviewRoot, 'library', 'snapshots')), false)
})

test('implicit runtime revision never consults ambient Git state', (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-p2-runtime-'))
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }))
  const context = createHub(dataRoot, {
    git: {
      configGet: () => null,
      output: () => { throw new Error('ambient GIT_DIR must not be consulted') }
    }
  })
  assert.doesNotThrow(() => createLocalHost({
    packageRoot: PACKAGE_ROOT,
    dataRoot,
    context
  }))
  assert.deepEqual(fs.readdirSync(dataRoot), [])
})
