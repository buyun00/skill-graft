import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { createHub } from '../dist/adapters/create-hub.js'
import { createLocalDurableSchemaResolver } from '../dist/adapters/local-durable-schema.js'
import { createLocalP2ApplicationPorts } from '../dist/adapters/local-p2-ports.js'
import { createLibrarySnapshotManifest } from '../dist/core/snapshot.js'
import { createLocalHost, openLocalHost } from '../dist/local/create-local-host.js'

const NOW = '2031-02-03T04:05:06.000Z'
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex')
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
