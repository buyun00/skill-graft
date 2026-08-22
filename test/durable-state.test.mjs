import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const outputRoot = path.resolve(process.env.SKILL_GRAFT_TEST_DIST || 'dist')
const durable = await import(pathToFileURL(path.join(outputRoot, 'adapters', 'durable-state.js')).href)
const application = await import(pathToFileURL(path.join(outputRoot, 'application', 'index.js')).href)
const durableFilesModuleUrl = pathToFileURL(path.join(outputRoot, 'adapters', 'durable-files.js')).href
const durableFiles = await import(durableFilesModuleUrl)

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-durable-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function documentSchema(relativePath) {
  if (!relativePath.endsWith('.json')) return undefined
  return {
    name: `test-document:${relativePath}`,
    validate(value) {
      return value && typeof value === 'object' && !Array.isArray(value) && value.version === 1
        ? { valid: true }
        : { valid: false, message: 'expected a version 1 object' }
    }
  }
}

function readJson(root, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, ...relativePath.split('/')), 'utf8'))
}

function hubIdentity(requestId) {
  return {
    scope: 'hub-global',
    key: 'hub-global',
    hostId: 'test-host',
    commandKind: 'ingest',
    requestId
  }
}

function exclusiveMemoryLock() {
  let held = false
  return {
    async acquire() {
      if (held) return { status: 'busy', reason: 'held' }
      held = true
      return {
        status: 'acquired',
        lease: {
          ownerToken: 'test-owner-token',
          renew() {
            if (!held) throw Object.assign(new Error('lost'), { code: 'LOCK_NOT_OWNED' })
          },
          release() {
            held = false
          }
        }
      }
    }
  }
}

function observableMemoryLock() {
  let held = false
  let lost = false
  let renewals = 0
  return {
    lose() {
      lost = true
    },
    renewals() {
      return renewals
    },
    port: {
      async acquire() {
        if (held) return { status: 'busy', reason: 'held' }
        held = true
        lost = false
        return {
          status: 'acquired',
          lease: {
            ownerToken: 'observable-owner-token',
            renew() {
              renewals += 1
              if (!held || lost) {
                throw Object.assign(new Error('observable lease lost'), { code: 'LOCK_NOT_OWNED' })
              }
            },
            release() {
              held = false
            }
          }
        }
      }
    }
  }
}

function transactionParticipant(participantId, events, overrides = {}) {
  return {
    participantId,
    async publish(context) {
      events.push(`publish:${participantId}`)
      await overrides.publish?.(context)
    },
    async rollback(context) {
      events.push(`rollback:${participantId}`)
      await overrides.rollback?.(context)
    },
    async finalize() {
      events.push(`finalize:${participantId}`)
      await overrides.finalize?.()
    }
  }
}

test('DurableStateStore is query-construction read-only and deep-clones fallbacks', (t) => {
  const base = fixture(t)
  const root = path.join(base, 'missing-data-root')
  const store = new durable.DurableStateStore({ root, schemaFor: documentSchema })
  assert.equal(fs.existsSync(root), false)

  const fallback = { version: 1, entries: [], omitted: undefined }
  const first = store.read('ledger.json', { fallback }).value
  first.entries.push({ requestId: 'mutated' })
  assert.deepEqual(fallback, { version: 1, entries: [], omitted: undefined })
  assert.deepEqual(store.read('ledger.json', { fallback }).value, { version: 1, entries: [] })
  assert.equal(fs.existsSync(root), false)
})

test('bounded descriptor reads stop after the max+1 probe byte', (t) => {
  const root = fixture(t)
  const file = path.join(root, 'bounded.bin')
  fs.writeFileSync(file, Buffer.from('12345'))
  const descriptor = fs.openSync(file, 'r')
  try {
    assert.throws(
      () => durableFiles.readBoundedDescriptor(descriptor, 4, 'bounded fixture'),
      /exceeds the 4 byte limit/
    )
  } finally {
    fs.closeSync(descriptor)
  }
})

test('DurableFileRoot accepts mkdir EEXIST only after plain canonical directory validation', (t) => {
  const plainRoot = fixture(t)
  const plainTarget = path.join(plainRoot, 'shared')
  let plainInjected = false
  const plainFiles = new durableFiles.DurableFileRoot({
    root: plainRoot,
    checkpoint(name) {
      if (!plainInjected && name === 'before-durable-directory-create') {
        fs.mkdirSync(plainTarget)
        plainInjected = true
      }
    }
  })
  assert.equal(plainFiles.ensureDirectory('shared'), plainTarget)
  assert.equal(plainInjected, true)

  const fileRoot = fixture(t)
  const fileTarget = path.join(fileRoot, 'blocked')
  const fileFiles = new durableFiles.DurableFileRoot({
    root: fileRoot,
    checkpoint(name) {
      if (name === 'before-durable-directory-create') fs.writeFileSync(fileTarget, 'not-a-directory')
    }
  })
  assert.throws(() => fileFiles.ensureDirectory('blocked'), /must be a plain directory/)

  const linkedRoot = fixture(t)
  const external = fixture(t)
  const linkedTarget = path.join(linkedRoot, 'linked')
  let linked = false
  const linkedFiles = new durableFiles.DurableFileRoot({
    root: linkedRoot,
    checkpoint(name) {
      if (linked || name !== 'before-durable-directory-create') return
      try {
        fs.symlinkSync(external, linkedTarget, process.platform === 'win32' ? 'junction' : 'dir')
        linked = true
      } catch (error) {
        if (error?.code !== 'EPERM') throw error
      }
    }
  })
  if (linked) {
    assert.throws(
      () => linkedFiles.ensureDirectory('linked'),
      /plain directory|junction|reparse|symlink/
    )
  }
})

test('two processes can concurrently perform the same first durable directory ensure', { timeout: 60_000 }, async (t) => {
  const base = fixture(t)
  const root = path.join(base, 'data')
  const barrier = path.join(base, 'barrier')
  fs.mkdirSync(root)
  fs.mkdirSync(barrier)
  const source = `
    import fs from 'node:fs'
    import path from 'node:path'
    const { DurableFileRoot } = await import(process.env.DURABLE_FILES_MODULE_URL)
    const sleeper = new Int32Array(new SharedArrayBuffer(4))
    fs.writeFileSync(path.join(process.env.DURABLE_BARRIER, process.env.DURABLE_LABEL + '.ready'), '')
    const deadline = Date.now() + 30_000
    while (fs.readdirSync(process.env.DURABLE_BARRIER).filter((entry) => entry.endsWith('.ready')).length < 2) {
      if (Date.now() >= deadline) throw new Error('durable ensure barrier timed out')
      Atomics.wait(sleeper, 0, 0, 10)
    }
    new DurableFileRoot({ root: process.env.DURABLE_ROOT }).ensureDirectory('shared/nested')
  `
  const children = ['a', 'b'].map((label) => spawn(
    process.execPath,
    ['--input-type=module', '-e', source],
    {
      env: {
        ...process.env,
        DURABLE_FILES_MODULE_URL: durableFilesModuleUrl,
        DURABLE_ROOT: root,
        DURABLE_BARRIER: barrier,
        DURABLE_LABEL: label
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    }
  ))
  t.after(() => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL')
  })
  const exits = await Promise.all(children.map((child) => new Promise((resolve, reject) => {
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve(code)
      else reject(new Error(`durable ensure child exited ${code}: ${stderr}`))
    })
  })))
  assert.deepEqual(exits, [0, 0])
  assert.equal(fs.statSync(path.join(root, 'shared', 'nested')).isDirectory(), true)
})

test('DurableFileRoot rejects a file hard-linked before or during a bounded read', async (t) => {
  const root = fixture(t)
  const file = path.join(root, 'state.json')
  const linked = path.join(root, 'state.link')
  const expected = Buffer.alloc(512 * 1024, 0x5a)
  fs.writeFileSync(file, expected)
  try {
    fs.linkSync(file, linked)
    fs.unlinkSync(linked)
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'ENOTSUP') return
    throw error
  }
  const source = `
    import fs from 'node:fs'
    const [file, linked] = process.argv.slice(1)
    fs.linkSync(file, linked)
    process.send?.({ kind: 'linked' })
    await new Promise((resolve) => process.once('message', resolve))
    for (let index = 0; index < 80; index += 1) {
      try { fs.unlinkSync(linked) } catch (error) { if (error.code !== 'ENOENT') throw error }
      fs.linkSync(file, linked)
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    try { fs.unlinkSync(linked) } catch (error) { if (error.code !== 'ENOENT') throw error }
    process.send?.({ kind: 'done' })
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, file, linked], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true
  })
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
  const first = await new Promise((resolve, reject) => {
    child.once('message', resolve)
    child.once('error', reject)
  })
  assert.deepEqual(first, { kind: 'linked' })
  const files = new durableFiles.DurableFileRoot({ root })
  assert.throws(() => files.read('state.json', expected.length), durableFiles.UnsafeDurablePathError)

  let done = false
  const completed = new Promise((resolve, reject) => {
    child.on('message', (message) => {
      if (message?.kind === 'done') {
        done = true
        resolve()
      }
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code && code !== 0) reject(new Error(`hardlink child exited ${code}: ${stderr}`))
    })
  })
  child.send('continue')
  while (!done) {
    try {
      assert.deepEqual(files.read('state.json', expected.length).bytes, expected)
    } catch (error) {
      assert.ok(error instanceof durableFiles.UnsafeDurablePathError)
    }
    await new Promise((resolve) => setImmediate(resolve))
  }
  await completed
  assert.deepEqual(files.read('state.json', expected.length).bytes, expected)
})

test('multi-document WAL forwards a recoverable commit and rolls back an incomplete one', async (t) => {
  const root = path.join(fixture(t), 'data')
  const initial = new durable.DurableStateStore({ root, schemaFor: documentSchema })
  await initial.commit([
    { relativePath: 'a.json', value: { version: 1, value: 'old-a' } },
    { relativePath: 'b.json', value: { version: 1, value: 'old-b' } },
    { relativePath: 'audit.json', value: { version: 1, events: [] } },
    { relativePath: 'history/one.json', value: { version: 1, item: 'old' } }
  ])

  let injected = false
  const forward = new durable.DurableStateStore({
    root,
    schemaFor: documentSchema,
    checkpoint(name) {
      if (!injected && name === 'transaction-target-published') {
        injected = true
        throw new Error('fault-after-first-target')
      }
    }
  })
  const forwarded = await forward.commit([
    { relativePath: 'a.json', value: { version: 1, value: 'new-a' } },
    { relativePath: 'b.json', value: { version: 1, value: 'new-b' } }
  ])
  assert.equal(forwarded.recoveredAfterSynchronousFailure, true)
  assert.equal(readJson(root, 'a.json').value, 'new-a')
  assert.equal(readJson(root, 'b.json').value, 'new-b')

  const rollback = new durable.DurableStateStore({
    root,
    schemaFor: documentSchema,
    checkpoint(name, facts) {
      if (name !== 'wal-published') return
      const missing = path.join(
        root,
        '.skill-graft-transactions',
        `.txn-${facts.transactionId}-1.next.tmp`
      )
      fs.unlinkSync(missing)
      throw new Error('fault-with-missing-prepared-document')
    }
  })
  await assert.rejects(rollback.commit([
    { relativePath: 'a.json', value: { version: 1, value: 'uncommitted-a' } },
    { relativePath: 'b.json', value: { version: 1, value: 'uncommitted-b' } }
  ]), /fault-with-missing-prepared-document/)
  assert.equal(readJson(root, 'a.json').value, 'new-a')
  assert.equal(readJson(root, 'b.json').value, 'new-b')
  assert.deepEqual(fs.readdirSync(path.join(root, '.skill-graft-transactions')), [])
})

test('WAL rename truth is recovered exactly and unknown journal artifacts block every recovery write', async (t) => {
  const exactRoot = path.join(fixture(t), 'exact-data')
  const exactSeed = new durable.DurableStateStore({ root: exactRoot, schemaFor: documentSchema })
  await exactSeed.commit([{ relativePath: 'state.json', value: { version: 1, value: 'old' } }])
  let exactInjected = false
  const exact = new durable.DurableStateStore({
    root: exactRoot,
    schemaFor: documentSchema,
    checkpoint(name, facts) {
      if (!exactInjected && name === 'atomic-replace-published'
        && String(facts.relativePath).endsWith('.wal.json')) {
        exactInjected = true
        throw new Error('wal-directory-flush-failed-after-rename')
      }
    }
  })
  const committed = await exact.commit([
    { relativePath: 'state.json', value: { version: 1, value: 'new' } }
  ])
  assert.equal(committed.recoveredAfterSynchronousFailure, true)
  assert.equal(readJson(exactRoot, 'state.json').value, 'new')
  assert.deepEqual(fs.readdirSync(path.join(exactRoot, '.skill-graft-transactions')), [])

  const uncertainRoot = path.join(fixture(t), 'uncertain-data')
  const uncertainSeed = new durable.DurableStateStore({ root: uncertainRoot, schemaFor: documentSchema })
  await uncertainSeed.commit([{ relativePath: 'state.json', value: { version: 1, value: 'old' } }])
  let hardlinkProbe
  const uncertain = new durable.DurableStateStore({
    root: uncertainRoot,
    schemaFor: documentSchema,
    checkpoint(name, facts) {
      if (hardlinkProbe || name !== 'atomic-replace-published'
        || !String(facts.relativePath).endsWith('.wal.json')) return
      const wal = path.join(uncertainRoot, ...String(facts.relativePath).split('/'))
      hardlinkProbe = `${wal}.unknown-hardlink`
      fs.linkSync(wal, hardlinkProbe)
      throw new Error('wal-readback-identity-uncertain')
    }
  })
  await assert.rejects(
    uncertain.commit([{ relativePath: 'state.json', value: { version: 1, value: 'pending' } }]),
    durable.DurableRecoveryRequiredError
  )
  assert.equal(readJson(uncertainRoot, 'state.json').value, 'old')
  const recovery = new durable.DurableStateStore({ root: uncertainRoot, schemaFor: documentSchema })
  assert.throws(() => recovery.recoverPending(), durable.DurableCorruptionError)
  assert.equal(readJson(uncertainRoot, 'state.json').value, 'old')
  fs.unlinkSync(hardlinkProbe)
  assert.equal(recovery.recoverPending().recoveredTransactions, 1)
  assert.equal(readJson(uncertainRoot, 'state.json').value, 'pending')
  assert.deepEqual(fs.readdirSync(path.join(uncertainRoot, '.skill-graft-transactions')), [])
})

test('primary corruption uses a valid backup and fails closed when both copies are invalid', async (t) => {
  const root = path.join(fixture(t), 'data')
  const store = new durable.DurableStateStore({ root, schemaFor: documentSchema })
  await store.commit([{ relativePath: 'state.json', value: { version: 1, value: 7 } }])
  fs.writeFileSync(path.join(root, 'state.json'), '{broken', 'utf8')
  assert.deepEqual(store.read('state.json').value, { version: 1, value: 7 })
  fs.writeFileSync(path.join(root, '.state.json.skill-graft.bak'), '{also-broken', 'utf8')
  assert.throws(() => store.read('state.json'), durable.DurableCorruptionError)
})

test('an oversized primary falls back to a bounded backup while unsafe links never do', async (t) => {
  const root = path.join(fixture(t), 'data')
  const store = new durable.DurableStateStore({
    root,
    schemaFor: documentSchema,
    limits: { maxDocumentBytes: 128 }
  })
  await store.commit([{ relativePath: 'state.json', value: { version: 1, value: 'bounded' } }])
  const primary = path.join(root, 'state.json')
  const backup = path.join(root, '.state.json.skill-graft.bak')
  fs.writeFileSync(primary, 'x'.repeat(129))
  assert.equal(store.read('state.json').value.value, 'bounded')
  fs.writeFileSync(backup, 'y'.repeat(129))
  assert.throws(
    () => store.read('state.json'),
    (error) => error?.code === 'STATE_CORRUPT' && error.retryable === false
  )

  const linkedRoot = path.join(fixture(t), 'linked-data')
  const linkedStore = new durable.DurableStateStore({ root: linkedRoot, schemaFor: documentSchema })
  await linkedStore.commit([{ relativePath: 'state.json', value: { version: 1, value: 'linked' } }])
  const linkedPrimary = path.join(linkedRoot, 'state.json')
  const linked = path.join(linkedRoot, 'state-hardlink-probe')
  try {
    fs.linkSync(linkedPrimary, linked)
    assert.throws(() => linkedStore.read('state.json'), durableFiles.UnsafeDurablePathError)
    fs.unlinkSync(linked)
  } catch (error) {
    if (error?.code !== 'EPERM' && error?.code !== 'ENOTSUP') throw error
  }
})

test('transaction façade requires an owned one-shot decision and preserves savepoint boundaries', async (t) => {
  const root = path.join(fixture(t), 'data')
  const host = durable.createDurableTransactionHost({
    root,
    schemaFor: documentSchema,
    lock: exclusiveMemoryLock()
  })
  assert.deepEqual(await host.recover(hubIdentity('recovery')), {
    recoveredTransactions: 0,
    rolledBackTransactions: 0,
    finalizedTransactions: 0
  })
  assert.equal(fs.existsSync(root), false)

  await host.transactions.withWriteTransaction(hubIdentity('initial'), async (transaction) => {
    await transaction.revalidateLease()
    host.persist.writeJson(path.join(root, 'state.json'), { version: 1, value: 1 })
    const decision = transaction.commit('initial')
    assert.throws(() => transaction.revalidateLease(), /terminal decision/)
    return decision
  })

  await assert.rejects(host.transactions.withWriteTransaction(hubIdentity('abort'), async (transaction) => {
    host.persist.writeJson(path.join(root, 'state.json'), { version: 1, value: 2 })
    return transaction.abort(new Error('business-abort'))
  }), /business-abort/)
  assert.equal(host.persist.readJson(path.join(root, 'state.json'), { version: 1 }).value, 1)

  await host.transactions.withWriteTransaction(hubIdentity('savepoint'), async (transaction) => {
    host.persist.writeJson(path.join(root, 'ledger.json'), { version: 1, status: 'begun' })
    const savepoint = transaction.savepoint()
    host.persist.writeJson(path.join(root, 'state.json'), { version: 1, value: 99 })
    transaction.rollbackTo(savepoint)
    assert.throws(() => transaction.rollbackTo(savepoint), /already used/)
    host.persist.writeJson(path.join(root, 'audit.json'), { version: 1, status: 'failed' })
    return transaction.commit('durable-failure')
  })
  assert.equal(host.persist.readJson(path.join(root, 'state.json'), { version: 1 }).value, 1)
  assert.equal(host.persist.readJson(path.join(root, 'ledger.json'), { version: 1 }).status, 'begun')
  assert.equal(host.persist.readJson(path.join(root, 'audit.json'), { version: 1 }).status, 'failed')

  await assert.rejects(host.transactions.withWriteTransaction(hubIdentity('plain-return'), async () => {
    host.persist.writeJson(path.join(root, 'state.json'), { version: 1, value: 100 })
    return { kind: 'commit', value: 'forged' }
  }), durable.DurableTransactionDecisionRequiredError)
  assert.equal(host.persist.readJson(path.join(root, 'state.json'), { version: 1 }).value, 1)

  await assert.rejects(host.transactions.withWriteTransaction(hubIdentity('copied-abort-marker'), async (transaction) => {
    host.persist.writeJson(path.join(root, 'state.json'), { version: 1, value: 101 })
    const issuedAbort = transaction.abort(new Error('must-not-be-converted'))
    const marker = Object.getOwnPropertySymbols(issuedAbort)[0]
    return Object.freeze({
      kind: 'commit',
      value: 'forged-from-abort',
      [marker]: issuedAbort[marker]
    })
  }), durable.DurableTransactionDecisionRequiredError)
  assert.equal(host.persist.readJson(path.join(root, 'state.json'), { version: 1 }).value, 1)

  await assert.rejects(host.transactions.withWriteTransaction(hubIdentity('nested'), async (transaction) => {
    await host.transactions.withWriteTransaction(hubIdentity('nested-inner'), async (inner) => inner.commit(null))
    return transaction.commit(null)
  }), /nested write transactions/)
})

test('durable participants publish in order, finalize in reverse, and tolerate finalize failure', async (t) => {
  const root = path.join(fixture(t), 'data')
  const lock = observableMemoryLock()
  const host = durable.createDurableTransactionHost({
    root,
    schemaFor: documentSchema,
    lock: lock.port
  })
  const events = []
  const first = transactionParticipant('materialize:first', events, {
    async publish(context) {
      events.push('revalidate:first')
      await context.revalidateLease()
    },
    finalize() {
      throw new Error('finalize-cleanup-failed')
    }
  })
  const second = transactionParticipant('materialize:second', events)

  const result = await host.transactions.withWriteTransaction(hubIdentity('participant-success'), async (transaction) => {
    host.persist.writeJson(path.join(root, 'ledger.json'), { version: 1, status: 'terminal' })
    transaction.enlist(first)
    transaction.enlist(second)
    return transaction.commit('committed')
  })

  assert.equal(result, 'committed')
  assert.equal(readJson(root, 'ledger.json').status, 'terminal')
  assert.deepEqual(events, [
    'publish:materialize:first',
    'revalidate:first',
    'publish:materialize:second',
    'finalize:materialize:second',
    'finalize:materialize:first'
  ])
  assert.ok(lock.renewals() >= 3)
})

test('participant enlistment is portable, unique, terminal-bound, and one-shot across transactions', async (t) => {
  const root = path.join(fixture(t), 'data')
  const host = durable.createDurableTransactionHost({
    root,
    schemaFor: documentSchema,
    lock: exclusiveMemoryLock()
  })
  const events = []
  const first = transactionParticipant('participant@ONE+1', events)

  await host.transactions.withWriteTransaction(hubIdentity('participant-identity'), async (transaction) => {
    transaction.enlist(first)
    assert.throws(() => transaction.enlist(first), /one-shot|already enlisted/)
    assert.throws(
      () => transaction.enlist(transactionParticipant('PARTICIPANT@one+1', events)),
      /participantId is already enlisted/
    )
    assert.throws(
      () => transaction.enlist(transactionParticipant('../not-portable', events)),
      /portable opaque identifier/
    )
    host.persist.writeJson(path.join(root, 'identity.json'), { version: 1, value: 'accepted' })
    return transaction.commit(null)
  })
  assert.deepEqual(events, ['publish:participant@ONE+1', 'finalize:participant@ONE+1'])

  await assert.rejects(
    host.transactions.withWriteTransaction(hubIdentity('participant-cross-transaction'), async (transaction) => {
      transaction.enlist(first)
      return transaction.commit(null)
    }),
    /one-shot/
  )

  await host.transactions.withWriteTransaction(hubIdentity('participant-after-decision'), async (transaction) => {
    const decision = transaction.commit(null)
    assert.throws(
      () => transaction.enlist(transactionParticipant('participant:late', events)),
      /terminal decision/
    )
    return decision
  })
})

test('participants roll back on abort, callback failure, invalid decisions, and savepoint discard', async (t) => {
  const root = path.join(fixture(t), 'data')
  const host = durable.createDurableTransactionHost({
    root,
    schemaFor: documentSchema,
    lock: exclusiveMemoryLock()
  })

  for (const scenario of ['abort', 'throw', 'invalid']) {
    const events = []
    const participant = transactionParticipant(`cleanup:${scenario}`, events, {
      rollback: (context) => context.revalidateLease()
    })
    await assert.rejects(
      host.transactions.withWriteTransaction(hubIdentity(`participant-${scenario}`), async (transaction) => {
        transaction.enlist(participant)
        host.persist.writeJson(path.join(root, `${scenario}.json`), { version: 1, value: scenario })
        if (scenario === 'abort') return transaction.abort(new Error('participant-business-abort'))
        if (scenario === 'throw') throw new Error('participant-callback-failed')
        return { kind: 'commit', value: null }
      })
    )
    assert.deepEqual(events, [`rollback:cleanup:${scenario}`])
    assert.equal(fs.existsSync(path.join(root, `${scenario}.json`)), false)
  }

  const savepointEvents = []
  await host.transactions.withWriteTransaction(hubIdentity('participant-savepoint'), async (transaction) => {
    const retained = transactionParticipant('savepoint:retained', savepointEvents)
    const discarded = transactionParticipant('savepoint:discarded', savepointEvents)
    transaction.enlist(retained)
    const savepoint = transaction.savepoint()
    transaction.enlist(discarded)
    transaction.rollbackTo(savepoint)
    host.persist.writeJson(path.join(root, 'savepoint-participant.json'), { version: 1, value: 'retained' })
    return transaction.commit(null)
  })
  assert.deepEqual(savepointEvents, [
    'rollback:savepoint:discarded',
    'publish:savepoint:retained',
    'finalize:savepoint:retained'
  ])

  const noDocumentEvents = []
  await assert.rejects(
    host.transactions.withWriteTransaction(hubIdentity('participant-no-document'), async (transaction) => {
      transaction.enlist(transactionParticipant('participant:no-document', noDocumentEvents))
      return transaction.commit(null)
    }),
    /must stage at least one durable document/
  )
  assert.deepEqual(noDocumentEvents, ['rollback:participant:no-document'])
})

test('participant publish and pre-WAL failures roll back every enlistment in reverse order', async (t) => {
  const publishRoot = path.join(fixture(t), 'publish-data')
  const publishHost = durable.createDurableTransactionHost({
    root: publishRoot,
    schemaFor: documentSchema,
    lock: exclusiveMemoryLock()
  })
  const publishEvents = []
  await assert.rejects(
    publishHost.transactions.withWriteTransaction(hubIdentity('participant-publish-failure'), async (transaction) => {
      transaction.enlist(transactionParticipant('publish:a', publishEvents))
      transaction.enlist(transactionParticipant('publish:b', publishEvents, {
        publish() {
          throw new Error('explicitly-unpublished')
        }
      }))
      transaction.enlist(transactionParticipant('publish:c', publishEvents))
      publishHost.persist.writeJson(path.join(publishRoot, 'state.json'), { version: 1, value: 'must-not-publish' })
      return transaction.commit(null)
    }),
    /explicitly-unpublished/
  )
  assert.deepEqual(publishEvents, [
    'publish:publish:a',
    'publish:publish:b',
    'rollback:publish:c',
    'rollback:publish:b',
    'rollback:publish:a'
  ])
  assert.equal(fs.existsSync(path.join(publishRoot, 'state.json')), false)

  const spoofRoot = path.join(fixture(t), 'spoof-data')
  const spoofHost = durable.createDurableTransactionHost({
    root: spoofRoot,
    schemaFor: documentSchema,
    lock: exclusiveMemoryLock()
  })
  const spoofEvents = []
  await assert.rejects(
    spoofHost.transactions.withWriteTransaction(hubIdentity('participant-spoofed-lock-error'), async (transaction) => {
      transaction.enlist(transactionParticipant('spoof:lock', spoofEvents, {
        publish() {
          throw Object.assign(new Error('spoofed-lock-not-owned'), { code: 'LOCK_NOT_OWNED' })
        }
      }))
      spoofHost.persist.writeJson(path.join(spoofRoot, 'state.json'), { version: 1, value: 'must-roll-back' })
      return transaction.commit(null)
    }),
    /spoofed-lock-not-owned/
  )
  assert.deepEqual(spoofEvents, ['publish:spoof:lock', 'rollback:spoof:lock'])
  assert.equal(fs.existsSync(path.join(spoofRoot, 'state.json')), false)

  const walRoot = path.join(fixture(t), 'wal-data')
  let armed = false
  let injected = false
  const walHost = durable.createDurableTransactionHost({
    root: walRoot,
    schemaFor: documentSchema,
    lock: exclusiveMemoryLock(),
    checkpoint(name) {
      if (armed && !injected && name === 'file-flushed') {
        injected = true
        throw new Error('pre-wal-publication-failed')
      }
    }
  })
  const walEvents = []
  await assert.rejects(
    walHost.transactions.withWriteTransaction(hubIdentity('participant-pre-wal-failure'), async (transaction) => {
      transaction.enlist(transactionParticipant('pre-wal:one', walEvents, {
        publish() {
          armed = true
        }
      }))
      walHost.persist.writeJson(path.join(walRoot, 'state.json'), { version: 1, value: 'must-roll-back' })
      return transaction.commit(null)
    }),
    /pre-wal-publication-failed/
  )
  assert.deepEqual(walEvents, ['publish:pre-wal:one', 'rollback:pre-wal:one'])
  assert.equal(fs.existsSync(path.join(walRoot, 'state.json')), false)
})

test('uncertain WAL publication and lease loss preserve participant recovery journals', async (t) => {
  const uncertainRoot = path.join(fixture(t), 'uncertain-participant-data')
  let hardlinkProbe
  const uncertainHost = durable.createDurableTransactionHost({
    root: uncertainRoot,
    schemaFor: documentSchema,
    lock: exclusiveMemoryLock(),
    checkpoint(name, facts) {
      if (hardlinkProbe || name !== 'atomic-replace-published'
        || !String(facts.relativePath).endsWith('.wal.json')) return
      const wal = path.join(uncertainRoot, ...String(facts.relativePath).split('/'))
      hardlinkProbe = `${wal}.participant-unknown-hardlink`
      fs.linkSync(wal, hardlinkProbe)
      throw new Error('participant-wal-publication-uncertain')
    }
  })
  const uncertainEvents = []
  await assert.rejects(
    uncertainHost.transactions.withWriteTransaction(hubIdentity('participant-wal-uncertain'), async (transaction) => {
      transaction.enlist(transactionParticipant('uncertain:wal', uncertainEvents))
      uncertainHost.persist.writeJson(path.join(uncertainRoot, 'state.json'), { version: 1, value: 'pending' })
      return transaction.commit(null)
    }),
    durable.DurableRecoveryRequiredError
  )
  assert.deepEqual(uncertainEvents, ['publish:uncertain:wal'])
  fs.unlinkSync(hardlinkProbe)
  assert.equal((await uncertainHost.recover(hubIdentity('participant-wal-recover'))).recoveredTransactions, 1)
  assert.equal(readJson(uncertainRoot, 'state.json').value, 'pending')

  const leaseRoot = path.join(fixture(t), 'lease-participant-data')
  const lock = observableMemoryLock()
  const leaseHost = durable.createDurableTransactionHost({
    root: leaseRoot,
    schemaFor: documentSchema,
    lock: lock.port
  })
  const leaseEvents = []
  await assert.rejects(
    leaseHost.transactions.withWriteTransaction(hubIdentity('participant-lease-loss'), async (transaction) => {
      transaction.enlist(transactionParticipant('uncertain:lease', leaseEvents, {
        async publish(context) {
          lock.lose()
          await context.revalidateLease()
        }
      }))
      leaseHost.persist.writeJson(path.join(leaseRoot, 'state.json'), { version: 1, value: 'must-not-guess' })
      return transaction.commit(null)
    }),
    (error) => error?.code === 'LOCK_NOT_OWNED'
  )
  assert.deepEqual(leaseEvents, ['publish:uncertain:lease'])
  assert.equal(fs.existsSync(path.join(leaseRoot, 'state.json')), false)
})

test('memory transaction participants mirror publish, reverse rollback, and best-effort finalize', async () => {
  const transactions = application.createMemoryApplicationTransactions()
  const successEvents = []
  await transactions.withWriteTransaction(hubIdentity('memory-participant-success'), async (transaction) => {
    await transaction.revalidateLease()
    transaction.enlist(transactionParticipant('memory:a', successEvents, {
      finalize() {
        throw new Error('ignored-memory-finalize')
      }
    }))
    transaction.enlist(transactionParticipant('memory:b', successEvents))
    return transaction.commit(null)
  })
  assert.deepEqual(successEvents, [
    'publish:memory:a',
    'publish:memory:b',
    'finalize:memory:b',
    'finalize:memory:a'
  ])

  const failureEvents = []
  await assert.rejects(
    transactions.withWriteTransaction(hubIdentity('memory-participant-failure'), async (transaction) => {
      transaction.enlist(transactionParticipant('memory:one', failureEvents))
      transaction.enlist(transactionParticipant('memory:two', failureEvents, {
        publish() {
          throw new Error('memory-publish-failed')
        }
      }))
      return transaction.commit(null)
    }),
    /memory-publish-failed/
  )
  assert.deepEqual(failureEvents, [
    'publish:memory:one',
    'publish:memory:two',
    'rollback:memory:two',
    'rollback:memory:one'
  ])
  assert.deepEqual(transactions.participantEvents.map((event) => `${event.phase}:${event.participantId}`), [
    'publish:memory:a',
    'publish:memory:b',
    'finalize:memory:b',
    'finalize:memory:a',
    'publish:memory:one',
    'publish:memory:two',
    'rollback:memory:two',
    'rollback:memory:one'
  ])
})

test('staging validates the serialized JSON shape and rejects unbounded or unserializable values', async (t) => {
  const root = path.join(fixture(t), 'data')
  const host = durable.createDurableTransactionHost({
    root,
    schemaFor: documentSchema,
    lock: exclusiveMemoryLock(),
    limits: { maxDocumentBytes: 128 }
  })
  await host.transactions.withWriteTransaction(hubIdentity('optional-undefined'), async (transaction) => {
    host.persist.writeJson(path.join(root, 'optional.json'), {
      version: 1,
      present: 'yes',
      omitted: undefined
    })
    return transaction.commit(null)
  })
  assert.deepEqual(readJson(root, 'optional.json'), { version: 1, present: 'yes' })

  await assert.rejects(
    host.transactions.withWriteTransaction(hubIdentity('bigint'), async (transaction) => {
      host.persist.writeJson(path.join(root, 'bigint.json'), { version: 1, value: 1n })
      return transaction.commit(null)
    }),
    (error) => error?.code === 'STATE_CORRUPT' && error.retryable === false
  )
  const cyclic = { version: 1 }
  cyclic.self = cyclic
  await assert.rejects(
    host.transactions.withWriteTransaction(hubIdentity('cycle'), async (transaction) => {
      host.persist.writeJson(path.join(root, 'cycle.json'), cyclic)
      return transaction.commit(null)
    }),
    (error) => error?.code === 'STATE_CORRUPT' && error.retryable === false
  )
  await assert.rejects(
    host.transactions.withWriteTransaction(hubIdentity('oversize'), async (transaction) => {
      host.persist.writeJson(path.join(root, 'oversize.json'), { version: 1, value: 'x'.repeat(256) })
      return transaction.commit(null)
    }),
    /exceeds the 128 byte limit/
  )
  assert.equal(fs.existsSync(path.join(root, 'bigint.json')), false)
  assert.equal(fs.existsSync(path.join(root, 'cycle.json')), false)
  assert.equal(fs.existsSync(path.join(root, 'oversize.json')), false)
})

test('read-side future-version carriers cannot bypass stricter durable write validation', async (t) => {
  const root = path.join(fixture(t), 'data')
  fs.mkdirSync(root, { recursive: true })
  const stateFile = path.join(root, 'state.json')
  const futureBytes = Buffer.from('{"schemaVersion":3,"future":true}\n', 'utf8')
  fs.writeFileSync(stateFile, futureBytes)
  const host = durable.createDurableTransactionHost({
    root,
    schemaFor(relativePath) {
      if (relativePath !== 'state.json') return undefined
      return {
        name: 'asymmetric state',
        validate: (value) => value && typeof value === 'object' && Number.isSafeInteger(value.schemaVersion)
          ? { valid: true }
          : { valid: false, message: 'version descriptor required' },
        validateWrite: (value) => value && typeof value === 'object' && value.schemaVersion === 2
          ? { valid: true }
          : { valid: false, message: 'only schema version 2 is writable' }
      }
    },
    lock: exclusiveMemoryLock()
  })
  assert.deepEqual(host.persist.readOptionalJson(stateFile), { schemaVersion: 3, future: true })
  await assert.rejects(
    host.transactions.withWriteTransaction(hubIdentity('future-write-rejected'), async (transaction) => {
      host.persist.writeJson(stateFile, { schemaVersion: 3, future: 'changed' })
      return transaction.commit(null)
    }),
    (error) => error?.code === 'STATE_CORRUPT' && error.retryable === false
  )
  assert.deepEqual(fs.readFileSync(stateFile), futureBytes)
})

test('AsyncLocal staging is visible to its callback but not a concurrent live query', async (t) => {
  const root = path.join(fixture(t), 'data')
  const host = durable.createDurableTransactionHost({
    root,
    schemaFor: documentSchema,
    lock: exclusiveMemoryLock()
  })
  await host.transactions.withWriteTransaction(hubIdentity('seed'), async (transaction) => {
    host.persist.writeJson(path.join(root, 'state.json'), { version: 1, value: 'live' })
    return transaction.commit(null)
  })

  let stagedReady
  const ready = new Promise((resolve) => { stagedReady = resolve })
  let continueCommit
  const barrier = new Promise((resolve) => { continueCommit = resolve })
  const writing = host.transactions.withWriteTransaction(hubIdentity('concurrent'), async (transaction) => {
    host.persist.writeJson(path.join(root, 'state.json'), { version: 1, value: 'staged' })
    assert.equal(host.persist.readJson(path.join(root, 'state.json'), { version: 1 }).value, 'staged')
    stagedReady()
    await barrier
    return transaction.commit(null)
  })
  await ready
  assert.equal(host.persist.readJson(path.join(root, 'state.json'), { version: 1 }).value, 'live')
  continueCommit()
  await writing
  assert.equal(host.persist.readJson(path.join(root, 'state.json'), { version: 1 }).value, 'staged')
})
