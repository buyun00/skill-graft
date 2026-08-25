import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

function fail(message) {
  throw new Error(message)
}

function comparable(target) {
  const resolved = path.resolve(target)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function samePath(left, right) {
  return comparable(left) === comparable(right)
}

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return Boolean(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
}

function take(argv, name, { optional = false } = {}) {
  const index = argv.indexOf(name)
  if (index < 0) {
    if (optional) return undefined
    fail(`${name} is required`)
  }
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) fail(`${name} requires a value`)
  argv.splice(index, 2)
  return value
}

function assertPlainDirectory(target, label) {
  const stat = fs.lstatSync(target)
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} must be a plain directory`)
  if (!samePath(target, fs.realpathSync.native(target))) fail(`${label} must not cross a reparse point`)
}

function assertPlainDirectoryChain(target, label) {
  const resolved = path.resolve(target)
  const directories = []
  let cursor = resolved
  while (true) {
    directories.push(cursor)
    const parent = path.dirname(cursor)
    if (samePath(parent, cursor)) break
    cursor = parent
  }
  for (const directory of directories.reverse()) assertPlainDirectory(directory, label)
}

function readMarker(runRoot, runId) {
  assertPlainDirectoryChain(runRoot, 'run root chain')
  const markerFile = path.join(runRoot, '.skill-graft-e2e-run.json')
  const markerStat = fs.lstatSync(markerFile)
  if (!markerStat.isFile() || markerStat.isSymbolicLink()) fail('worker run marker must be a plain file')
  const realMarker = fs.realpathSync.native(markerFile)
  if (!samePath(markerFile, realMarker) || !isInside(runRoot, realMarker)) {
    fail('worker run marker must resolve exactly inside the run root')
  }
  const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'))
  if (marker == null || typeof marker !== 'object' || marker.version !== 1 || marker.runId !== runId
    || typeof marker.runRoot !== 'string' || !samePath(marker.runRoot, runRoot)) {
    fail('worker run marker does not own this root')
  }
  return marker
}

function assertOwnedPath(runRoot, target, firstSegment, label) {
  const resolved = path.resolve(target)
  if (!isInside(runRoot, resolved)) fail(`${label} must be inside the marker-owned run root`)
  const first = path.relative(runRoot, resolved).split(path.sep)[0]
  if (first.toLowerCase() !== firstSegment.toLowerCase()) {
    fail(`${label} must be under ${firstSegment}`)
  }
  let cursor = resolved
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor)
    if (samePath(parent, cursor)) fail(`${label} has no existing owned ancestor`)
    cursor = parent
  }
  assertPlainDirectory(cursor, `${label} ancestor`)
  return resolved
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

const argv = process.argv.slice(2)
const mode = take(argv, '--mode')
const runId = take(argv, '--run-id')
const runRoot = path.resolve(take(argv, '--run-root'))
const packageRoot = path.resolve(take(argv, '--package-root'))
const dataRoot = path.resolve(take(argv, '--data-root'))
const leaseMs = Number(take(argv, '--lease-ms'))
const label = take(argv, '--label')
const value = take(argv, '--value', { optional: true })
const readyFileInput = take(argv, '--ready-file', { optional: true })
if (argv.length > 0) fail('unsupported worker arguments')
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,95}$/.test(runId)) fail('worker run-id is invalid')
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,159}$/.test(label)) fail('worker label is invalid')
if (!Number.isSafeInteger(leaseMs) || leaseMs < 250 || leaseMs > 60_000) fail('worker lease is invalid')

readMarker(runRoot, runId)
assertOwnedPath(runRoot, packageRoot, 'app', 'installed package')
assertOwnedPath(runRoot, dataRoot, 'hub-data', 'durable data root')
assertPlainDirectory(packageRoot, 'installed package')
assertPlainDirectory(dataRoot, 'durable data root')
const readyFile = readyFileInput
  ? assertOwnedPath(runRoot, readyFileInput, 'logs', 'ready file')
  : undefined

const leaseModule = path.join(packageRoot, 'dist', 'adapters', 'lease-lock.js')
const durableModule = path.join(packageRoot, 'dist', 'adapters', 'durable-state.js')
for (const file of [leaseModule, durableModule]) {
  if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) fail(`installed adapter is missing: ${path.basename(file)}`)
}
const { createLeaseLockManager } = await import(pathToFileURL(leaseModule).href)
const { createDurableTransactionHost } = await import(pathToFileURL(durableModule).href)

const identity = {
  scope: 'hub-global',
  key: 'hub-global',
  hostId: 'p2-real-worker',
  commandKind: 'createSnapshot',
  requestId: label
}
const lockRoot = path.join(dataRoot, 'skill-review', 'locks')
const lock = createLeaseLockManager({ root: lockRoot, leaseMs })

function fixtureSchema(relativePath) {
  if (relativePath !== 'fixture/state.json') return undefined
  return {
    name: 'P2RealDurableStateV1',
    validate(candidate) {
      const valid = candidate != null
        && typeof candidate === 'object'
        && !Array.isArray(candidate)
        && Object.keys(candidate).length === 2
        && candidate.schemaVersion === 1
        && typeof candidate.value === 'string'
        && candidate.value.length > 0
        && candidate.value.length <= 1024
      return valid ? { valid: true } : { valid: false, message: 'invalid P2 real durable state' }
    }
  }
}

if (mode === 'lease-contend') {
  const acquired = await lock.acquire(identity)
  if (acquired.status === 'busy') {
    process.send?.({ ok: true, status: 'busy' })
    output({ ok: true, status: 'busy' })
  } else {
    process.send?.({ ok: true, status: 'acquired' })
    await new Promise((resolve, reject) => {
      process.once('message', async (message) => {
        if (message !== 'release') {
          reject(new Error('lease worker received an invalid release message'))
          return
        }
        try {
          await acquired.lease.release()
          resolve()
        } catch (error) {
          reject(error)
        }
      })
    })
    output({ ok: true, status: 'released' })
  }
} else {
  let checkpointObserved = false
  const durable = createDurableTransactionHost({
    root: dataRoot,
    schemaFor: fixtureSchema,
    lock,
    renewalIntervalMs: 0,
    checkpoint(name, facts) {
      if (mode !== 'hold-wal' || name !== 'wal-published' || checkpointObserved) return
      if (!readyFile) fail('hold-wal requires --ready-file')
      checkpointObserved = true
      fs.mkdirSync(path.dirname(readyFile), { recursive: true })
      fs.writeFileSync(readyFile, `${JSON.stringify({
        schemaVersion: 1,
        runId,
        pid: process.pid,
        transactionId: facts.transactionId,
        phase: name
      }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
      const gate = new Int32Array(new SharedArrayBuffer(4))
      Atomics.wait(gate, 0, 0)
    }
  })
  const stateFile = path.join(dataRoot, 'fixture', 'state.json')

  if (mode === 'recover') {
    try {
      const result = await durable.recover(identity)
      output({
        ok: true,
        status: 'recovered',
        recoveredTransactions: Number(result?.recoveredTransactions || 0)
      })
    } catch (error) {
      const code = error?.code === 'LOCK_BUSY' ? 'LOCK_BUSY' : 'UNKNOWN'
      const reason = error?.details?.reason === 'lease-active' ? 'lease-active' : 'redacted'
      output({
        ok: false,
        status: 'blocked',
        code,
        retryable: error?.retryable === true,
        reason
      })
      process.exitCode = 2
    }
  } else if (mode === 'commit' || mode === 'hold-wal') {
    if (!value) fail('worker value is required')
    await durable.transactions.withWriteTransaction(identity, async (transaction) => {
      durable.persist.writeJson(stateFile, { schemaVersion: 1, value })
      return transaction.commit(value)
    })
    if (mode === 'hold-wal') fail('hold-wal unexpectedly returned after its durable checkpoint')
    output({ ok: true, status: 'committed' })
  } else {
    fail('unsupported worker mode')
  }
}
