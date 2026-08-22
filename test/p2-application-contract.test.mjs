import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  ApplicationTransactionErrorBase,
  createHubApplication,
  isApplicationTransactionError
} from '../dist/application/index.js'
import { CONTRACT_VERSION, QUERY_COMMAND_KINDS, WRITE_COMMAND_KINDS } from '../dist/contracts/index.js'
import { createLibrarySnapshotManifest } from '../dist/core/snapshot.js'

const NOW = '2031-02-03T04:05:06.000Z'

class FixtureApplicationTransactionError extends ApplicationTransactionErrorBase {
  constructor(code, message, details) {
    super(message, details)
    this.code = code
    this.retryable = code === 'LOCK_BUSY' || code === 'LOCK_NOT_OWNED' || code === 'PORT_FAILURE'
  }
}

function trustedTransactionError(code, message, details) {
  return new FixtureApplicationTransactionError(code, message, details)
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

function identifier(value) {
  return `sha256:${digest(value)}`
}

function clone(value) {
  return value == null ? value : structuredClone(value)
}

function snapshot(seed, createdAt = NOW) {
  const planned = createLibrarySnapshotManifest({
    source: { kind: 'library', id: 'fixture-library', revision: `revision-${seed}` },
    createdAt,
    files: [{
      path: 'ozdqp-development/SKILL.md',
      size: Buffer.byteLength(seed),
      sha256: identifier(seed),
      mode: '100644',
      isReparsePoint: false
    }]
  })
  assert.equal(planned.ok, true)
  return planned.manifest
}

function identity(worktree) {
  const pathKey = identifier(`path:${String(worktree).toLowerCase()}`)
  return { pathKey, worktreeId: `worktree:${pathKey.slice(-24)}` }
}

function currentState(manifests, worktree = '/probe') {
  const resolved = identity(worktree)
  const requested = manifests[0].snapshotId
  return {
    schemaVersion: 2,
    stateRevision: 4,
    runtimeRevision: 'runtime-fixture',
    librarySnapshots: manifests.map((entry) => entry.snapshotId).sort(),
    worktrees: {
      [resolved.pathKey]: {
        schemaVersion: 1,
        pathKey: resolved.pathKey,
        worktreeId: resolved.worktreeId,
        requestedSnapshot: requested,
        materializedSnapshot: requested,
        selectedSkills: ['ozdqp-development'],
        claimState: 'claimed'
      }
    },
    items: [],
    lastIngest: null
  }
}

function restoreModel(model, saved) {
  for (const key of Object.keys(model)) delete model[key]
  Object.assign(model, clone(saved))
}

function createTransactionalFixture(options = {}) {
  const initialSnapshot = options.snapshots?.[0] ?? snapshot('snapshot-a')
  const model = {
    state: clone(options.state ?? currentState([initialSnapshot])),
    snapshots: clone(options.snapshots ?? [initialSnapshot]),
    worktreeFacts: clone(options.worktreeFacts ?? []),
    ledger: [],
    audit: [],
    sessions: clone(options.sessions ?? [])
  }
  const faults = {
    afterStateWrite: false,
    complete: false,
    terminalAudit: false,
    transactionCode: null,
    ...(options.faults ?? {})
  }
  const transactionCalls = []
  const legacyStateCalls = { read: 0, write: 0 }
  let sequence = 0

  const transactions = {
    async withWriteTransaction(transactionIdentity, callback) {
      transactionCalls.push(clone(transactionIdentity))
      if (faults.transactionCode === 'LOCK_BUSY') {
        throw trustedTransactionError('LOCK_BUSY', 'busy', { retryAfterMs: 25 })
      }
      const before = clone(model)
      const savepoints = new Map()
      let decided = false
      const transaction = {
        revalidateLease() {
          if (decided) throw new Error('transaction is closed')
        },
        savepoint() {
          const token = {}
          savepoints.set(token, clone(model))
          return token
        },
        rollbackTo(token) {
          const saved = savepoints.get(token)
          if (!saved) throw new Error('foreign savepoint')
          restoreModel(model, saved)
          savepoints.delete(token)
        },
        commit(value) {
          if (decided) throw new Error('duplicate transaction decision')
          decided = true
          return { kind: 'commit', value }
        },
        abort(error) {
          if (decided) throw new Error('duplicate transaction decision')
          decided = true
          return { kind: 'abort', error }
        }
      }
      try {
        const decision = await callback(transaction)
        if (!decided || !decision || decision.kind !== 'commit' && decision.kind !== 'abort') {
          throw new Error('explicit transaction decision required')
        }
        if (decision.kind === 'abort') throw decision.error
        if (faults.transactionCode === 'LOCK_NOT_OWNED') {
          throw trustedTransactionError('LOCK_NOT_OWNED', 'lease lost')
        }
        return decision.value
      } catch (error) {
        restoreModel(model, before)
        throw error
      }
    }
  }

  const runtime = {
    nowIso: () => NOW,
    nextId(scope) {
      if (faults.terminalAudit && scope === 'audit') throw new Error('audit identity unavailable')
      return `${scope}-${++sequence}`
    },
    sha256: digest
  }
  const queries = {
    readStatusFacts: () => ({ configuredGameRepo: null, inbox: [], attachedWorktrees: [] }),
    listSkillFacts: () => [],
    readWorktreeFacts: () => ({ candidates: [], attached: [] }),
    readSkill: () => ({ status: 'not-found', reason: 'missing' }),
    listHistory: () => [],
    inspectWorktree: () => { throw new Error('legacy inspection unavailable') }
  }
  const useCases = {
    state: {
      readState() {
        legacyStateCalls.read += 1
        return { version: 1, items: [], lastIngest: null }
      },
      writeState() {
        legacyStateCalls.write += 1
      },
      appendHistory: () => {},
      configuredGameRepo: () => null,
      listAttachedWorktrees: () => []
    },
    git: {
      revisionExists: () => false,
      changedPaths: () => [],
      readTree: () => [],
      readBlob: () => null
    },
    artifacts: {
      inspect: () => [],
      apply: () => {}
    }
  }
  const legacyAttach = {
    inspect: () => { throw new Error('legacy attach unavailable') },
    apply: () => { throw new Error('legacy attach unavailable') }
  }
  const legacyDetach = {
    inspect: () => { throw new Error('legacy detach unavailable') },
    apply: () => { throw new Error('legacy detach unavailable') }
  }
  const sessions = {
    list: () => clone(model.sessions),
    get: (sessionId) => clone(model.sessions.find((entry) => entry.id === sessionId) ?? null),
    start: () => { throw new Error('session runner unavailable') },
    resume: () => { throw new Error('session runner unavailable') },
    reap: () => []
  }
  const ledger = {
    read(requestId) {
      return clone(model.ledger.find((entry) => entry.requestId === requestId) ?? null)
    },
    begin(entry) {
      if (model.ledger.some((candidate) => candidate.requestId === entry.requestId)) {
        throw new Error('request already exists')
      }
      model.ledger.push(clone(entry))
    },
    complete(entry, events) {
      if (faults.complete) throw new Error('terminal persistence failed')
      const index = model.ledger.findIndex((candidate) => candidate.requestId === entry.requestId)
      if (index < 0) throw new Error('request disappeared')
      model.ledger[index] = clone(entry)
      model.audit.push(...clone(Array.isArray(events) ? events : [events]))
    },
    listEvents(limit) {
      return clone(model.audit.slice(-limit).reverse())
    }
  }
  const p2 = {
    identities: { resolve: (worktree) => identity(worktree) },
    snapshots: {
      observe() {
        const seed = options.observationSeed ?? 'observed-content'
        return {
          captureId: `capture-${seed}`,
          source: { kind: 'library', id: 'fixture-library', revision: 'observed' },
          files: [{
            path: 'ozdqp-development/SKILL.md',
            size: Buffer.byteLength(seed),
            sha256: identifier(seed),
            mode: '100644',
            isReparsePoint: false
          }]
        }
      },
      store(_captureId, approved) {
        const prior = model.snapshots.find((entry) => entry.snapshotId === approved.snapshotId)
        if (prior) return { manifest: clone(prior), deduplicated: true }
        model.snapshots.push(clone(approved))
        return { manifest: clone(approved), deduplicated: false }
      },
      list: () => clone(model.snapshots),
      read(snapshotId) {
        return clone(model.snapshots.find((entry) => entry.snapshotId === snapshotId) ?? null)
      }
    },
    state: {
      readDocument: () => clone(model.state),
      writeV2(state) {
        model.state = clone(state)
        if (faults.afterStateWrite) throw new Error('state write failed after staging')
      },
      runtimeRevision: () => 'runtime-fixture',
      observeV1Worktrees: () => clone(model.worktreeFacts)
    }
  }

  options.configure?.({ ledger, legacyStateCalls, model, p2, sessions, useCases })

  const app = createHubApplication({
    runtime,
    recovery: options.recovery,
    queries,
    useCases,
    legacyAttach,
    legacyDetach,
    sessions,
    ledger,
    p2,
    transactions,
    trace: options.trace
  })
  const meta = (requestId) => ({
    contractVersion: CONTRACT_VERSION,
    requestId,
    hostId: 'local-test',
    transport: 'test'
  })
  return { app, faults, legacyStateCalls, meta, model, p2, sessions, transactionCalls, useCases }
}

test('Application recovery preflight rejects malformed commands before I/O and traces stable corruption envelopes', async () => {
  const traceEvents = []
  let recoveryCalls = 0
  let handlerReads = 0
  const fixture = createTransactionalFixture({
    recovery: {
      recover() {
        recoveryCalls += 1
        throw trustedTransactionError('STATE_CORRUPT', 'SENTINEL-RECOVERY-CORRUPTION')
      }
    },
    trace: {
      hashRequestId: () => 'redacted-request-hash',
      append: (event) => traceEvents.push(clone(event))
    },
    configure({ p2 }) {
      const originalRead = p2.state.readDocument
      p2.state.readDocument = () => {
        handlerReads += 1
        return originalRead()
      }
    }
  })

  const malformed = await fixture.app.execute({
    kind: 'futureMalformedCommand',
    meta: fixture.meta('malformed-before-recovery')
  })
  assert.equal(malformed.ok, false)
  assert.equal(malformed.error.code, 'UNSUPPORTED_COMMAND')
  assert.equal(recoveryCalls, 0)
  assert.deepEqual(traceEvents, [])

  const corrupt = await fixture.app.execute({
    kind: 'inspectSchema',
    meta: fixture.meta('recovery-corrupt-envelope')
  })
  assert.equal(corrupt.ok, false)
  assert.equal(corrupt.error.code, 'STATE_CORRUPT')
  assert.equal(corrupt.error.retryable, false)
  assert.equal(JSON.stringify(corrupt).includes('SENTINEL-RECOVERY-CORRUPTION'), false)
  assert.equal(recoveryCalls, 1)
  assert.equal(handlerReads, 0)
  assert.deepEqual(traceEvents.map((event) => [event.phase, event.ok]), [
    ['entry', undefined],
    ['result', false]
  ])
  assert.equal(fixture.transactionCalls.length, 0)
  assert.deepEqual(fixture.model.ledger, [])
  assert.deepEqual(fixture.model.audit, [])
})

test('Application recovery retries after lock contention and rechecks after an earlier success', async () => {
  let recoveryCalls = 0
  let lateCorruption = false
  const fixture = createTransactionalFixture({
    recovery: {
      recover() {
        recoveryCalls += 1
        if (recoveryCalls === 1) {
          throw trustedTransactionError('LOCK_BUSY', 'busy', { retryAfterMs: 25 })
        }
        if (lateCorruption) {
          throw trustedTransactionError('STATE_CORRUPT', 'late WAL detail')
        }
      }
    }
  })
  const command = {
    kind: 'inspectSchema',
    meta: fixture.meta('recovery-retry')
  }

  const busy = await fixture.app.execute(command)
  assert.equal(busy.ok, false)
  assert.equal(busy.error.code, 'LOCK_BUSY')
  assert.equal(busy.error.retryable, true)
  assert.deepEqual(busy.error.details, { retryAfterMs: 25 })

  const retry = await fixture.app.execute(command)
  assert.equal(retry.ok, true)
  assert.equal(recoveryCalls, 2)

  lateCorruption = true
  const late = await fixture.app.execute({
    kind: 'inspectSchema',
    meta: fixture.meta('recovery-late-wal')
  })
  assert.equal(late.ok, false)
  assert.equal(late.error.code, 'STATE_CORRUPT')
  assert.equal(late.error.retryable, false)
  assert.equal(recoveryCalls, 3)
})

test('command classification keeps every query lock-free and sends every write through a transaction', async () => {
  const fixture = createTransactionalFixture()
  const snapshotId = fixture.model.snapshots[0].snapshotId
  const queries = {
    status: {},
    listSkills: {},
    listWorktrees: {},
    readSkill: { path: 'missing' },
    listHistory: {},
    listSessions: {},
    getSession: { sessionId: 'missing' },
    inspectSchema: {},
    listSnapshots: {},
    getSnapshot: { snapshotId },
    getPin: { worktree: '/probe' },
    planSync: { worktree: '/probe' }
  }
  const commands = {
    repairLegacy: { worktree: '/probe' },
    applyLegacyAttach: { worktree: '/probe' },
    applyLegacyDetach: { worktree: '/probe' },
    ingest: { payload: '' },
    decide: { id: 'missing', action: 'reject' },
    attach: { worktree: '/probe' },
    detach: { worktree: '/probe' },
    edit: { path: 'ozdqp-development' },
    chat: {},
    analyze: {},
    resumeSession: { sessionId: 'missing', message: 'continue' },
    reapSessions: {},
    createSnapshot: {},
    setPin: { worktree: '/probe', snapshotId },
    migrateState: { mode: 'dryRun' },
    claimWorktree: {
      worktree: '/probe',
      snapshotId,
      selectedSkills: ['ozdqp-development'],
      sessionId: 'missing-attach-session'
    },
    sync: { worktree: '/probe', planHash: identifier('missing-sync-plan') },
    migrateLegacy: { worktree: '/probe', mode: 'dryRun' },
    rollbackLegacyMigration: {
      worktree: '/probe',
      migrationId: identifier('missing-migration'),
      mode: 'dryRun'
    }
  }
  assert.deepEqual(Object.keys(queries), [...QUERY_COMMAND_KINDS])
  assert.deepEqual(Object.keys(commands), [...WRITE_COMMAND_KINDS])

  for (const kind of QUERY_COMMAND_KINDS) {
    await fixture.app.execute({ kind, meta: fixture.meta(`query-${kind}`), ...queries[kind] })
  }
  assert.equal(fixture.transactionCalls.length, 0)

  for (const kind of WRITE_COMMAND_KINDS) {
    await fixture.app.execute({ kind, meta: fixture.meta(`write-${kind}`), ...commands[kind] })
  }
  assert.deepEqual(fixture.transactionCalls.map((entry) => entry.commandKind), [...WRITE_COMMAND_KINDS])
  const worktreeWrites = new Set([
    'setPin',
    'claimWorktree',
    'sync',
    'migrateLegacy',
    'rollbackLegacyMigration'
  ])
  for (const call of fixture.transactionCalls) {
    assert.equal(call.scope, worktreeWrites.has(call.commandKind) ? 'worktree' : 'hub-global')
    assert.equal(call.key, worktreeWrites.has(call.commandKind) ? identity('/probe').pathKey : 'hub-global')
  }
})

test('an unsupported future state version rejects the complete write corpus before ledger or handler effects', async () => {
  const fixture = createTransactionalFixture({
    state: { schemaVersion: 3, future: { opaque: true } }
  })
  const snapshotId = fixture.model.snapshots[0].snapshotId
  const commands = {
    repairLegacy: { worktree: '/probe' },
    applyLegacyAttach: { worktree: '/probe' },
    applyLegacyDetach: { worktree: '/probe' },
    ingest: { payload: '' },
    decide: { id: 'missing', action: 'reject' },
    attach: { worktree: '/probe' },
    detach: { worktree: '/probe' },
    edit: { path: 'ozdqp-development' },
    chat: {},
    analyze: {},
    resumeSession: { sessionId: 'missing', message: 'continue' },
    reapSessions: {},
    createSnapshot: {},
    setPin: { worktree: '/probe', snapshotId },
    migrateState: { mode: 'dryRun' },
    claimWorktree: {
      worktree: '/probe',
      snapshotId,
      selectedSkills: ['ozdqp-development'],
      sessionId: 'missing-attach-session'
    },
    sync: { worktree: '/probe', planHash: identifier('missing-sync-plan') },
    migrateLegacy: { worktree: '/probe', mode: 'dryRun' },
    rollbackLegacyMigration: {
      worktree: '/probe',
      migrationId: identifier('missing-migration'),
      mode: 'dryRun'
    }
  }
  assert.deepEqual(Object.keys(commands), [...WRITE_COMMAND_KINDS])
  const originalState = clone(fixture.model.state)
  for (const kind of WRITE_COMMAND_KINDS) {
    const result = await fixture.app.execute({
      kind,
      meta: fixture.meta(`future-schema-${kind}`),
      ...commands[kind]
    })
    assert.equal(result.ok, false, kind)
    assert.equal(result.error.code, 'STATE_VERSION_UNSUPPORTED', kind)
  }
  assert.deepEqual(fixture.model.state, originalState)
  assert.deepEqual(fixture.model.ledger, [])
  assert.deepEqual(fixture.model.audit, [])
  assert.deepEqual(fixture.model.sessions, [])
  assert.equal(fixture.legacyStateCalls.read, 0)
  assert.equal(fixture.legacyStateCalls.write, 0)
  assert.deepEqual(fixture.transactionCalls.map((entry) => entry.commandKind), [...WRITE_COMMAND_KINDS])
})

test('P2 write results replay exactly and conflicting reuse of requestId never reruns a handler', async () => {
  const first = snapshot('replay-first')
  const second = snapshot('replay-second')
  const cases = [
    {
      fixture: () => createTransactionalFixture({ snapshots: [first], state: currentState([first]) }),
      payload: { kind: 'createSnapshot' },
      conflict: { kind: 'migrateState', mode: 'dryRun' }
    },
    {
      fixture: () => createTransactionalFixture({ snapshots: [first, second], state: currentState([first, second]) }),
      payload: { kind: 'setPin', worktree: '/probe', snapshotId: second.snapshotId },
      conflict: { kind: 'setPin', worktree: '/probe', snapshotId: second.snapshotId, selectedSkills: [] }
    },
    {
      fixture: () => createTransactionalFixture({ snapshots: [first], state: { version: 1, items: [], lastIngest: null } }),
      payload: { kind: 'migrateState', mode: 'dryRun' },
      conflict: { kind: 'createSnapshot' }
    }
  ]

  for (const [index, entry] of cases.entries()) {
    const fixture = entry.fixture()
    const meta = fixture.meta(`p2-replay-${index}`)
    const firstResult = await fixture.app.execute({ ...entry.payload, meta })
    assert.equal(firstResult.meta.replayed, false)
    const afterFirst = clone(fixture.model)
    const replay = await fixture.app.execute({ ...entry.payload, meta })
    assert.equal(replay.meta.replayed, true)
    assert.equal(replay.ok, firstResult.ok)
    assert.deepEqual(replay.ok ? replay.data : replay.error, firstResult.ok ? firstResult.data : firstResult.error)
    assert.deepEqual(fixture.model, afterFirst)

    const conflict = await fixture.app.execute({ ...entry.conflict, meta })
    assert.equal(conflict.ok, false)
    assert.equal(conflict.error.code, 'REQUEST_ID_CONFLICT')
    assert.equal(conflict.error.retryable, false)
    assert.deepEqual(fixture.model, afterFirst)
  }
})

test('business failure rolls handler state back but durably commits one failure ledger and audit outcome', async () => {
  const first = snapshot('first')
  const second = snapshot('second')
  const fixture = createTransactionalFixture({ snapshots: [first, second], state: currentState([first, second]) })
  fixture.faults.afterStateWrite = true

  const result = await fixture.app.execute({
    kind: 'setPin',
    meta: fixture.meta('set-pin-business-failure'),
    worktree: '/probe',
    snapshotId: second.snapshotId,
    selectedSkills: []
  })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'PORT_FAILURE')
  const pin = fixture.model.state.worktrees[identity('/probe').pathKey]
  assert.equal(pin.requestedSnapshot, first.snapshotId)
  assert.equal(pin.materializedSnapshot, first.snapshotId)
  assert.deepEqual(pin.selectedSkills, ['ozdqp-development'])
  assert.equal(fixture.model.ledger.length, 1)
  assert.equal(fixture.model.ledger[0].status, 'completed')
  assert.equal(fixture.model.ledger[0].result.ok, false)
  assert.deepEqual(fixture.model.audit.map((event) => event.type), ['command.failed'])
})

test('terminal persistence and lost-lease failures publish zero staged handler, ledger, or audit writes', async () => {
  const first = snapshot('first')
  const second = snapshot('second')
  for (const failure of ['complete', 'LOCK_NOT_OWNED']) {
    const fixture = createTransactionalFixture({ snapshots: [first, second], state: currentState([first, second]) })
    if (failure === 'complete') fixture.faults.complete = true
    else fixture.faults.transactionCode = failure
    const result = await fixture.app.execute({
      kind: 'setPin',
      meta: fixture.meta(`terminal-${failure}`),
      worktree: '/probe',
      snapshotId: second.snapshotId
    })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, failure === 'complete' ? 'PORT_FAILURE' : 'LOCK_NOT_OWNED')
    assert.equal(result.error.retryable, true)
    assert.equal(fixture.model.state.worktrees[identity('/probe').pathKey].requestedSnapshot, first.snapshotId)
    assert.deepEqual(fixture.model.ledger, [])
    assert.deepEqual(fixture.model.audit, [])
  }
})

test('createSnapshot terminal, ledger, and lease failures leave no visible manifest or replay entry', async () => {
  for (const failure of ['terminalAudit', 'complete', 'LOCK_NOT_OWNED']) {
    const fixture = createTransactionalFixture({
      snapshots: [],
      state: { version: 1, items: [], lastIngest: null },
      observationSeed: `failed-${failure}`
    })
    if (failure === 'LOCK_NOT_OWNED') fixture.faults.transactionCode = failure
    else fixture.faults[failure] = true
    const result = await fixture.app.execute({
      kind: 'createSnapshot',
      meta: fixture.meta(`create-${failure}`)
    })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, failure === 'LOCK_NOT_OWNED' ? 'LOCK_NOT_OWNED' : 'PORT_FAILURE')
    assert.deepEqual(fixture.model.snapshots, [])
    assert.deepEqual(fixture.model.ledger, [])
    assert.deepEqual(fixture.model.audit, [])

    fixture.faults.terminalAudit = false
    fixture.faults.complete = false
    fixture.faults.transactionCode = null
    const listed = await fixture.app.execute({
      kind: 'listSnapshots',
      meta: fixture.meta(`list-${failure}`)
    })
    assert.equal(listed.ok, true)
    assert.deepEqual(listed.data.snapshots, [])
  }
})

test('a pristine terminal abort does not create a phantom started request on retry', async () => {
  const fixture = createTransactionalFixture()
  const command = {
    kind: 'migrateState',
    meta: fixture.meta('retry-after-terminal-abort'),
    mode: 'dryRun'
  }
  fixture.faults.terminalAudit = true
  const aborted = await fixture.app.execute(command)
  assert.equal(aborted.ok, false)
  assert.deepEqual(fixture.model.ledger, [])
  assert.deepEqual(fixture.model.audit, [])

  fixture.faults.terminalAudit = false
  const retry = await fixture.app.execute(command)
  assert.equal(retry.ok, true)
  assert.equal(retry.data.status, 'already-current')
  assert.equal(retry.meta.replayed, false)
  assert.equal(fixture.model.ledger.length, 1)
  assert.equal(fixture.model.ledger[0].status, 'completed')
})

test('setPin only updates an existing claimed pin and never materializes it', async () => {
  const first = snapshot('first')
  const second = snapshot('second')
  const fixture = createTransactionalFixture({ snapshots: [first, second], state: currentState([first, second]) })
  const before = clone(fixture.model.state.worktrees[identity('/probe').pathKey])

  const omitted = await fixture.app.execute({
    kind: 'setPin',
    meta: fixture.meta('pin-omit-skills'),
    worktree: '/probe',
    snapshotId: second.snapshotId
  })
  assert.equal(omitted.ok, true)
  assert.equal(omitted.data.pin.requestedSnapshot, second.snapshotId)
  assert.equal(omitted.data.pin.materializedSnapshot, before.materializedSnapshot)
  assert.deepEqual(omitted.data.pin.selectedSkills, before.selectedSkills)

  const explicitEmpty = await fixture.app.execute({
    kind: 'setPin',
    meta: fixture.meta('pin-empty-skills'),
    worktree: '/probe',
    snapshotId: first.snapshotId,
    selectedSkills: []
  })
  assert.equal(explicitEmpty.ok, true)
  assert.deepEqual(explicitEmpty.data.pin.selectedSkills, [])
  assert.equal(explicitEmpty.data.pin.materializedSnapshot, before.materializedSnapshot)

  fixture.model.state.worktrees[identity('/probe').pathKey].claimState = 'detached'
  fixture.model.state.worktrees[identity('/probe').pathKey].requestedSnapshot = null
  fixture.model.state.worktrees[identity('/probe').pathKey].materializedSnapshot = null
  fixture.model.state.worktrees[identity('/probe').pathKey].selectedSkills = []
  const detached = await fixture.app.execute({
    kind: 'setPin',
    meta: fixture.meta('pin-detached'),
    worktree: '/probe',
    snapshotId: second.snapshotId
  })
  assert.equal(detached.ok, false)
  assert.equal(detached.error.code, 'INVALID_PIN')
  assert.equal(detached.error.retryable, false)
  assert.equal(fixture.model.state.worktrees[identity('/probe').pathKey].claimState, 'detached')
})

test('setPin results and durable replay ledger never retain the raw worktree locator', async () => {
  const first = snapshot('locator-first')
  const second = snapshot('locator-second')
  const rawLocator = '/SENTINEL-RAW-WORKTREE-LOCATOR/probe'
  const fixture = createTransactionalFixture({
    snapshots: [first, second],
    state: currentState([first, second], rawLocator)
  })
  const command = {
    kind: 'setPin',
    meta: fixture.meta('set-pin-no-locator'),
    worktree: rawLocator,
    snapshotId: second.snapshotId
  }

  const result = await fixture.app.execute(command)
  assert.equal(result.ok, true)
  assert.equal(Object.hasOwn(result.data, 'worktree'), false)
  assert.equal(result.data.pathKey, identity(rawLocator).pathKey)
  assert.equal(JSON.stringify(result).includes(rawLocator), false)
  assert.equal(JSON.stringify(fixture.model.ledger).includes(rawLocator), false)

  const replay = await fixture.app.execute(command)
  assert.equal(replay.ok, true)
  assert.equal(replay.meta.replayed, true)
  assert.equal(JSON.stringify(replay).includes(rawLocator), false)
})

test('P1 inbox writes merge through the shared V2 facade without losing snapshot registry or pins', async () => {
  const manifest = snapshot('v2-inbox')
  const state = currentState([manifest])
  state.items = [
    {
      id: 'decide-1',
      name: 'decision-skill',
      unit: '.agents/skills/decision-skill',
      status: 'queued',
      inboxPath: 'skills/inbox/decision-skill',
      createdAt: NOW,
      updatedAt: NOW
    },
    {
      id: 'reap-1',
      name: 'reap-skill',
      unit: '.agents/skills/reap-skill',
      status: 'queued',
      inboxPath: 'skills/inbox/reap-skill',
      createdAt: NOW,
      updatedAt: NOW
    }
  ]
  const fixture = createTransactionalFixture({ snapshots: [manifest], state })
  const preservedRegistry = clone(state.librarySnapshots)
  const preservedPins = clone(state.worktrees)
  const oldRevision = '1'.repeat(40)
  const nextRevision = '2'.repeat(40)
  fixture.useCases.git.revisionExists = () => true
  fixture.useCases.git.changedPaths = () => [{ status: 'M', path: '.agents/skills/gated-skill/SKILL.md' }]
  fixture.useCases.git.readTree = () => [{ path: 'SKILL.md', content: '# Gated skill\n' }]
  fixture.useCases.artifacts.inspect = (requests) => requests.map((request) => ({
    key: request.key,
    exists: true,
    actualKind: 'directory',
    contentMatches: true
  }))
  fixture.sessions.start = (input) => ({
    id: 'analyze-complete',
    kind: 'analyze',
    status: 'waiting',
    target: { kind: 'inbox', id: input.inboxIds?.[0] ?? 'inbox' },
    startedAt: NOW,
    exitCode: 0,
    canResume: true,
    inboxIds: input.inboxIds,
    lastMessage: '{"action":"merge","target":"ozdqp-development","reason":"fixture"}'
  })
  fixture.sessions.reap = () => [{
    id: 'reaped-analyze',
    kind: 'analyze',
    status: 'waiting',
    target: { kind: 'inbox', id: 'reap-1' },
    startedAt: NOW,
    exitCode: 0,
    canResume: true,
    inboxIds: ['reap-1'],
    lastMessage: '{"action":"adopt","target":"reap-skill","reason":"fixture"}'
  }]

  const ingested = await fixture.app.execute({
    kind: 'ingest',
    meta: fixture.meta('v2-ingest'),
    gameRepo: '/repo',
    payload: `${oldRevision} ${nextRevision} refs/remotes/origin/main`,
    dispatch: false
  })
  assert.equal(ingested.ok, true)
  assert.equal(fixture.model.state.items.some((item) => item.name === 'gated-skill'), true)
  assert.match(fixture.model.state.lastIngest.gameRepoId, /^sha256:[0-9a-f]{64}$/)
  assert.equal(JSON.stringify(fixture.model.state).includes('/repo'), false)
  const persistedGameRepoId = fixture.model.state.lastIngest.gameRepoId

  const analyzed = await fixture.app.execute({
    kind: 'analyze',
    meta: fixture.meta('v2-analyze'),
    inboxId: 'decide-1'
  })
  assert.equal(analyzed.ok, true)
  assert.equal(fixture.model.state.items.find((item) => item.id === 'decide-1').status, 'proposed')

  const decided = await fixture.app.execute({
    kind: 'decide',
    meta: fixture.meta('v2-decide'),
    id: 'decide-1',
    action: 'reject',
    note: 'fixture decision'
  })
  assert.equal(decided.ok, true)
  assert.equal(fixture.model.state.items.find((item) => item.id === 'decide-1').status, 'rejected')

  const reaped = await fixture.app.execute({
    kind: 'reapSessions',
    meta: fixture.meta('v2-reap'),
    sessionIds: ['reaped-analyze']
  })
  assert.equal(reaped.ok, true)
  assert.equal(fixture.model.state.items.find((item) => item.id === 'reap-1').status, 'proposed')

  assert.equal(fixture.model.state.schemaVersion, 2)
  assert.equal(fixture.model.state.stateRevision, state.stateRevision + 4)
  assert.equal(fixture.model.state.runtimeRevision, state.runtimeRevision)
  assert.deepEqual(fixture.model.state.librarySnapshots, preservedRegistry)
  assert.deepEqual(fixture.model.state.worktrees, preservedPins)
  assert.equal(fixture.model.state.lastIngest.gameRepoId, persistedGameRepoId,
    'unrelated inbox writes must preserve the existing opaque repository identity')
  assert.deepEqual(fixture.legacyStateCalls, { read: 0, write: 0 })
})

function configureSuccessfulSessions(fixture) {
  let next = 0
  fixture.sessions.start = (input) => {
    const session = {
      id: `started-${++next}`,
      kind: input.kind,
      status: 'running',
      target: input.target ?? { kind: 'hub', id: 'hub' },
      intent: input.intent,
      startedAt: NOW,
      canResume: false,
      inboxIds: input.inboxIds
    }
    fixture.model.sessions.push(session)
    return clone(session)
  }
  fixture.sessions.resume = (input) => {
    const session = fixture.model.sessions.find((entry) => entry.id === input.sessionId)
    if (!session) throw new Error('missing session')
    session.status = 'running'
    session.intent = input.message
    session.canResume = false
    return clone(session)
  }
  fixture.sessions.reap = (sessionIds) => {
    const selected = fixture.model.sessions.filter((entry) => !sessionIds || sessionIds.includes(entry.id))
    for (const session of selected) {
      session.status = 'completed'
      session.exitCode = 0
      session.canResume = true
    }
    return clone(selected)
  }
}

test('edit/chat/analyze/resume/reap session documents commit on success and roll back on terminal failure', async () => {
  const seed = [{
    id: 'waiting-session',
    kind: 'chat',
    status: 'waiting',
    target: { kind: 'hub', id: 'hub' },
    startedAt: NOW,
    exitCode: 0,
    canResume: true
  }]
  const corpus = [
    { kind: 'edit', path: 'ozdqp-development' },
    { kind: 'chat', intent: 'session transaction' },
    { kind: 'analyze' },
    { kind: 'resumeSession', sessionId: 'waiting-session', message: 'resume transaction' },
    { kind: 'reapSessions', sessionIds: ['waiting-session'] }
  ]

  const success = createTransactionalFixture({ sessions: seed })
  configureSuccessfulSessions(success)
  for (const [index, payload] of corpus.entries()) {
    const result = await success.app.execute({ ...payload, meta: success.meta(`session-success-${index}`) })
    assert.equal(result.ok, true, `${payload.kind} should commit`)
  }
  assert.equal(success.model.ledger.length, corpus.length)
  assert.equal(success.model.audit.filter((event) => event.type === 'command.succeeded').length, corpus.length)

  for (const [index, payload] of corpus.entries()) {
    const rollback = createTransactionalFixture({ sessions: seed })
    configureSuccessfulSessions(rollback)
    const before = clone(rollback.model.sessions)
    rollback.faults.complete = true
    const result = await rollback.app.execute({ ...payload, meta: rollback.meta(`session-rollback-${index}`) })
    assert.equal(result.ok, false, `${payload.kind} should abort`)
    assert.deepEqual(rollback.model.sessions, before)
    assert.deepEqual(rollback.model.ledger, [])
    assert.deepEqual(rollback.model.audit, [])
  }
})

test('migration dry-run is audited without business persistence and commit rejects a stale default snapshot plan', async () => {
  const first = snapshot('first', '2030-01-01T00:00:00.000Z')
  const second = snapshot('second', '2030-02-01T00:00:00.000Z')
  const claimed = identity('/claimed')
  const linked = identity('/linked')
  const fixture = createTransactionalFixture({
    snapshots: [first, second],
    state: { version: 1, items: [], lastIngest: null },
    worktreeFacts: [
      { ...linked, linked: true, claimed: false, selectedSkills: ['zeta', 'alpha'] },
      { ...claimed, linked: true, claimed: true, selectedSkills: ['ozdqp-development'] }
    ]
  })

  const dryRun = await fixture.app.execute({
    kind: 'migrateState',
    meta: fixture.meta('migration-dry-run'),
    mode: 'dryRun'
  })
  assert.equal(dryRun.ok, true)
  assert.equal(dryRun.data.status, 'planned')
  assert.equal(dryRun.data.plan.targetState.librarySnapshots.includes(second.snapshotId), true)
  assert.equal(dryRun.data.plan.targetState.worktrees[linked.pathKey].requestedSnapshot, second.snapshotId)
  assert.equal(dryRun.data.plan.targetState.worktrees[linked.pathKey].materializedSnapshot, null)
  assert.deepEqual(dryRun.data.plan.targetState.worktrees[linked.pathKey].selectedSkills, ['alpha', 'zeta'])
  assert.equal(fixture.model.state.version, 1)
  assert.equal(fixture.model.ledger[0].status, 'completed')
  assert.deepEqual(fixture.model.audit.map((event) => event.type), ['command.succeeded'])

  const third = snapshot('third', '2030-03-01T00:00:00.000Z')
  fixture.model.snapshots.push(third)
  const stale = await fixture.app.execute({
    kind: 'migrateState',
    meta: fixture.meta('migration-stale'),
    mode: 'commit',
    planHash: dryRun.data.plan.planHash
  })
  assert.equal(stale.ok, false)
  assert.equal(stale.error.code, 'MIGRATION_PLAN_STALE')
  assert.equal(fixture.model.state.version, 1)

  const refreshed = await fixture.app.execute({
    kind: 'migrateState',
    meta: fixture.meta('migration-refresh'),
    mode: 'dryRun'
  })
  const committed = await fixture.app.execute({
    kind: 'migrateState',
    meta: fixture.meta('migration-commit'),
    mode: 'commit',
    planHash: refreshed.data.plan.planHash
  })
  assert.equal(committed.ok, true)
  assert.equal(committed.data.status, 'committed')
  assert.equal(fixture.model.state.schemaVersion, 2)
  assert.equal(fixture.model.state.worktrees[claimed.pathKey].materializedSnapshot, null)

  const committedStateBytes = JSON.stringify(fixture.model.state)
  const committedRevision = fixture.model.state.stateRevision
  const repeated = await fixture.app.execute({
    kind: 'migrateState',
    meta: fixture.meta('migration-repeat-commit'),
    mode: 'commit',
    planHash: refreshed.data.plan.planHash
  })
  assert.equal(repeated.ok, true)
  assert.equal(repeated.data.status, 'already-current')
  assert.equal(repeated.data.plan, null)
  assert.equal(JSON.stringify(fixture.model.state), committedStateBytes)
  assert.equal(fixture.model.state.stateRevision, committedRevision)
})

test('legacy version spellings normalize to one migration identity and only explicit stateRevision advances', async () => {
  const manifest = snapshot('legacy-spelling-equivalence')
  const spellings = [
    { version: 1, items: [], lastIngest: null },
    { schemaVersion: 1, items: [], lastIngest: null }
  ]
  const observations = []

  for (const [index, state] of spellings.entries()) {
    const fixture = createTransactionalFixture({ snapshots: [manifest], state })
    const inspected = await fixture.app.execute({
      kind: 'inspectSchema',
      meta: fixture.meta(`legacy-spelling-inspect-${index}`)
    })
    assert.equal(inspected.ok, true)
    assert.equal(inspected.data.status, 'legacy')
    assert.equal(inspected.data.stateRevision, null)

    const migrated = await fixture.app.execute({
      kind: 'migrateState',
      meta: fixture.meta(`legacy-spelling-migrate-${index}`),
      mode: 'dryRun'
    })
    assert.equal(migrated.ok, true)
    assert.equal(migrated.data.plan.targetState.stateRevision, 1)
    observations.push({
      sourceDigest: migrated.data.plan.sourceDigest,
      planHash: migrated.data.plan.planHash,
      targetState: migrated.data.plan.targetState
    })
  }
  assert.deepEqual(observations[1], observations[0])

  const explicit = createTransactionalFixture({
    snapshots: [manifest],
    state: { version: 1, stateRevision: 7, items: [], lastIngest: null }
  })
  const inspected = await explicit.app.execute({
    kind: 'inspectSchema',
    meta: explicit.meta('legacy-explicit-revision-inspect')
  })
  assert.equal(inspected.ok, true)
  assert.equal(inspected.data.stateRevision, 7)
  const migrated = await explicit.app.execute({
    kind: 'migrateState',
    meta: explicit.meta('legacy-explicit-revision-migrate'),
    mode: 'dryRun'
  })
  assert.equal(migrated.ok, true)
  assert.equal(migrated.data.plan.targetState.stateRevision, 8)
})

test('strict legacy inspection rejects unknown fields, malformed items, and invalid revisions without leaking values', async () => {
  const sentinel = 'SENTINEL-DO-NOT-LEAK'
  const invalidStates = [
    { version: 1, items: [], lastIngest: null, [sentinel]: 'secret-value' },
    { version: 1, items: [{ id: sentinel }], lastIngest: null },
    { version: 1, stateRevision: Number.MAX_SAFE_INTEGER, items: [], lastIngest: null }
  ]
  for (const [index, state] of invalidStates.entries()) {
    const fixture = createTransactionalFixture({ snapshots: [], state })
    const inspected = await fixture.app.execute({
      kind: 'inspectSchema',
      meta: fixture.meta(`strict-inspect-${index}`)
    })
    assert.equal(inspected.ok, false)
    assert.equal(inspected.error.code, 'STATE_CORRUPT')
    assert.equal(JSON.stringify(inspected).includes(sentinel), false)
    assert.equal(fixture.transactionCalls.length, 0)

    const migrated = await fixture.app.execute({
      kind: 'migrateState',
      meta: fixture.meta(`strict-migrate-${index}`),
      mode: 'dryRun'
    })
    assert.equal(migrated.ok, false)
    assert.equal(migrated.error.code, 'STATE_CORRUPT')
    assert.equal(JSON.stringify(migrated).includes(sentinel), false)
    assert.equal(JSON.stringify(fixture.model.ledger).includes(sentinel), false)
    assert.equal(JSON.stringify(fixture.model.audit).includes(sentinel), false)
  }
})

test('command validation redacts unsupported field names before any transaction or ledger access', async () => {
  const sentinel = 'SENTINEL-UNSUPPORTED-FIELD'
  const fixture = createTransactionalFixture()
  for (const command of [
    { kind: 'createSnapshot', meta: fixture.meta('redacted-command-field'), [sentinel]: 'secret' },
    {
      kind: 'analyze',
      meta: fixture.meta('redacted-runner-field'),
      runner: { start: false, [sentinel]: 'secret' }
    }
  ]) {
    const result = await fixture.app.execute(command)
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'INVALID_ARGUMENT')
    assert.equal(JSON.stringify(result).includes(sentinel), false)
  }
  assert.equal(fixture.transactionCalls.length, 0)
  assert.deepEqual(fixture.model.ledger, [])
  assert.deepEqual(fixture.model.audit, [])
})

test('trusted corruption aborts without a replay record while untyped objects cannot spoof stable error codes', async () => {
  let corrupt = true
  const trusted = createTransactionalFixture({
    configure({ p2 }) {
      const originalRead = p2.state.readDocument
      p2.state.readDocument = () => {
        if (corrupt) {
          throw trustedTransactionError('STATE_CORRUPT', 'attacker-controlled storage detail')
        }
        return originalRead()
      }
    }
  })
  const command = {
    kind: 'migrateState',
    meta: trusted.meta('trusted-corruption-retry'),
    mode: 'dryRun'
  }
  const failed = await trusted.app.execute(command)
  assert.equal(failed.ok, false)
  assert.equal(failed.error.code, 'STATE_CORRUPT')
  assert.equal(failed.error.retryable, false)
  assert.equal(JSON.stringify(failed).includes('attacker-controlled'), false)
  assert.deepEqual(trusted.model.ledger, [])
  assert.deepEqual(trusted.model.audit, [])

  corrupt = false
  const retry = await trusted.app.execute(command)
  assert.equal(retry.ok, true)
  assert.equal(retry.meta.replayed, false)

  const untrusted = createTransactionalFixture({
    configure({ p2 }) {
      p2.state.readDocument = () => {
        throw { code: 'STATE_CORRUPT', retryable: false, message: 'spoofed corruption' }
      }
    }
  })
  const spoofed = await untrusted.app.execute({
    kind: 'migrateState',
    meta: untrusted.meta('untrusted-corruption'),
    mode: 'dryRun'
  })
  assert.equal(spoofed.ok, false)
  assert.equal(spoofed.error.code, 'PORT_FAILURE')
  assert.equal(JSON.stringify(spoofed).includes('spoofed corruption'), false)
  assert.equal(untrusted.model.ledger[0].status, 'completed')
  assert.equal(isApplicationTransactionError({
    code: 'STATE_CORRUPT',
    retryable: false,
    message: 'spoofed corruption'
  }), false)
  assert.equal(isApplicationTransactionError(Object.assign(new Error('spoofed Error'), {
    code: 'STATE_CORRUPT',
    retryable: false
  })), false)
})

test('trusted snapshot validation failures are durably audited without publishing handler writes', async () => {
  const fixture = createTransactionalFixture({
    configure({ p2 }) {
      p2.snapshots.observe = () => {
        throw trustedTransactionError('SNAPSHOT_INVALID', 'untrusted snapshot path')
      }
    }
  })
  const before = clone(fixture.model.snapshots)
  const result = await fixture.app.execute({
    kind: 'createSnapshot',
    meta: fixture.meta('snapshot-invalid')
  })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'SNAPSHOT_INVALID')
  assert.equal(result.error.retryable, false)
  assert.equal(JSON.stringify(result).includes('untrusted snapshot path'), false)
  assert.deepEqual(fixture.model.snapshots, before)
  assert.equal(fixture.model.ledger[0].status, 'completed')
  assert.deepEqual(fixture.model.audit.map((event) => event.type), ['command.failed'])
})

test('a current state with a missing registered manifest fails closed across P2 reads and writes', async () => {
  const present = snapshot('registered-present')
  const missing = snapshot('registered-missing')
  const fixture = createTransactionalFixture({
    snapshots: [present],
    state: currentState([present, missing])
  })
  const reads = [
    { kind: 'inspectSchema' },
    { kind: 'listSnapshots' },
    { kind: 'getSnapshot', snapshotId: present.snapshotId },
    { kind: 'getPin', worktree: '/probe' }
  ]
  for (const [index, payload] of reads.entries()) {
    const result = await fixture.app.execute({ ...payload, meta: fixture.meta(`missing-registry-read-${index}`) })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'STATE_CORRUPT')
  }
  assert.equal(fixture.transactionCalls.length, 0)

  for (const [index, payload] of [
    { kind: 'createSnapshot' },
    { kind: 'setPin', worktree: '/probe', snapshotId: present.snapshotId },
    { kind: 'migrateState', mode: 'dryRun' }
  ].entries()) {
    const result = await fixture.app.execute({ ...payload, meta: fixture.meta(`missing-registry-write-${index}`) })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'STATE_CORRUPT')
  }
  assert.deepEqual(fixture.model.snapshots, [present])
  assert.equal(fixture.model.state.librarySnapshots.includes(missing.snapshotId), true)
})

test('snapshot dedupe preserves first stored provenance and pre-migration list/show expose validated physical objects', async () => {
  const existing = snapshot('observed-content', '2029-01-01T00:00:00.000Z')
  const fixture = createTransactionalFixture({
    snapshots: [existing],
    state: { version: 1, items: [], lastIngest: null },
    observationSeed: 'observed-content'
  })
  const created = await fixture.app.execute({ kind: 'createSnapshot', meta: fixture.meta('snapshot-dedupe') })
  assert.equal(created.ok, true)
  assert.equal(created.data.deduplicated, true)
  assert.equal(created.data.snapshot.createdAt, existing.createdAt)
  assert.equal(fixture.model.snapshots.length, 1)

  const listed = await fixture.app.execute({ kind: 'listSnapshots', meta: fixture.meta('snapshot-list') })
  assert.equal(listed.ok, true)
  assert.deepEqual(listed.data.snapshots, [existing])
  const fetched = await fixture.app.execute({
    kind: 'getSnapshot',
    meta: fixture.meta('snapshot-get'),
    snapshotId: existing.snapshotId
  })
  assert.equal(fetched.ok, true)
  assert.deepEqual(fetched.data.snapshot, existing)
})

test('setPin aborts before state reads when the locator resolves to a different identity after locking', async () => {
  const first = snapshot('first')
  const second = snapshot('second')
  const fixture = createTransactionalFixture({ snapshots: [first, second], state: currentState([first, second]) })
  const locked = identity('/probe')
  const substituted = identity('/substituted')
  let resolutions = 0
  let stateReads = 0
  fixture.p2.identities.resolve = () => (++resolutions === 1 ? locked : substituted)
  const originalRead = fixture.p2.state.readDocument
  fixture.p2.state.readDocument = () => {
    stateReads += 1
    return originalRead()
  }

  const result = await fixture.app.execute({
    kind: 'setPin',
    meta: fixture.meta('pin-identity-substitution'),
    worktree: '/probe',
    snapshotId: second.snapshotId
  })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'LOCK_NOT_OWNED')
  assert.equal(result.error.retryable, true)
  assert.equal(resolutions, 2)
  assert.equal(stateReads, 0)
  assert.deepEqual(fixture.model.ledger, [])
  assert.deepEqual(fixture.model.audit, [])
  assert.equal(fixture.model.state.worktrees[locked.pathKey].requestedSnapshot, first.snapshotId)
})
