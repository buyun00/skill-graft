import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,95}$/
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/
const ALLOWED_MODES = new Set(['authorize-session', 'execute-cut'])
const ALLOWED_OPERATIONS = new Set(['sync', 'migrate-legacy', 'rollback-legacy'])
const ALLOWED_CUTS = new Set(['durable-old', 'durable-new'])
const MODULES = Object.freeze({
  createHub: 'dist/adapters/create-hub.js',
  durable: 'dist/adapters/durable-state.js',
  lease: 'dist/adapters/lease-lock.js',
  applicationPorts: 'dist/adapters/local-application-ports.js',
  durableSchema: 'dist/adapters/local-durable-schema.js',
  records: 'dist/adapters/local-materialization-records.js',
  materializer: 'dist/adapters/local-materializer.js',
  p2: 'dist/adapters/local-p2-ports.js',
  runtimeAssets: 'dist/adapters/local-runtime-assets.js',
  snapshots: 'dist/adapters/snapshot-repository.js',
  localHost: 'dist/local/create-local-host.js'
})

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
  if (!fs.existsSync(target)) fail(`${label} is missing`)
  const stat = fs.lstatSync(target)
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} must be a plain directory`)
  if (!samePath(target, fs.realpathSync.native(target))) fail(`${label} must resolve exactly`)
}

function assertPlainDirectoryChain(target, label) {
  const directories = []
  let cursor = path.resolve(target)
  for (;;) {
    directories.push(cursor)
    const parent = path.dirname(cursor)
    if (samePath(parent, cursor)) break
    cursor = parent
  }
  for (const directory of directories.reverse()) assertPlainDirectory(directory, label)
}

function assertPlainFile(target, label) {
  if (!fs.existsSync(target)) fail(`${label} is missing`)
  const stat = fs.lstatSync(target)
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a plain file`)
  if (!samePath(target, fs.realpathSync.native(target))) fail(`${label} must resolve exactly`)
}

function readOwnedMarker(root, runId, name, rootField) {
  assertPlainDirectoryChain(root, `${name} root chain`)
  const markerFile = path.join(root, name)
  assertPlainFile(markerFile, `${name} marker`)
  if (!isInside(root, fs.realpathSync.native(markerFile))) fail(`${name} marker escaped its root`)
  const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'))
  if (!marker || typeof marker !== 'object' || marker.version !== 1 || marker.runId !== runId
    || typeof marker[rootField] !== 'string' || !samePath(marker[rootField], root)) {
    fail(`${name} marker does not own its root`)
  }
  return marker
}

function assertOwnedPath(root, target, firstSegment, label) {
  const resolved = path.resolve(target)
  if (!isInside(root, resolved)) fail(`${label} must be inside the marker-owned run root`)
  const first = path.relative(root, resolved).split(path.sep)[0]
  if (first.toLowerCase() !== firstSegment.toLowerCase()) fail(`${label} must be under ${firstSegment}`)
  assertPlainDirectoryChain(resolved, `${label} chain`)
  return resolved
}

function assertWorktreeOwned(runRoot, worktree, crossRoot) {
  const resolved = path.resolve(worktree)
  if (isInside(path.join(runRoot, 'probe'), resolved)) {
    assertPlainDirectoryChain(resolved, 'probe worktree chain')
    return resolved
  }
  if (!crossRoot) fail('worktree is outside the marker-owned probe root')
  const expected = path.join(crossRoot, `p3-cross-${path.basename(runRoot)}`)
  if (!samePath(resolved, expected) || !isInside(crossRoot, resolved)) {
    fail('cross-volume worktree is not the exact marker-owned child')
  }
  assertPlainDirectoryChain(resolved, 'cross-volume worktree chain')
  return resolved
}

function exclusiveDurableWrite(file, value) {
  const bytes = Buffer.from(value, 'utf8')
  const descriptor = fs.openSync(file, 'wx', 0o600)
  try {
    if (!fs.fstatSync(descriptor).isFile()) fail('exclusive evidence target is not a regular file')
    let offset = 0
    while (offset < bytes.length) offset += fs.writeSync(descriptor, bytes, offset, bytes.length - offset)
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function safeCode(error) {
  const value = typeof error?.code === 'string' ? error.code : 'WORKER_FAILURE'
  return /^[A-Z][A-Z0-9_]{2,63}$/.test(value) ? value : 'WORKER_FAILURE'
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function leaseRenewalInterval(leaseMs) {
  return Math.max(100, Math.floor(leaseMs / 3))
}

async function loadInstalledModules(packageRoot) {
  const loaded = {}
  for (const [name, relative] of Object.entries(MODULES)) {
    const file = path.resolve(packageRoot, ...relative.split('/'))
    if (!isInside(packageRoot, file)) fail('installed module allowlist escaped package root')
    assertPlainFile(file, `installed module ${name}`)
    loaded[name] = await import(pathToFileURL(file).href)
  }
  return loaded
}

function checkpointFor(operation, cut) {
  if (cut === 'durable-new') return 'wal-published'
  if (operation === 'sync') return 'materializer-after-marker-publication-phase'
  if (operation === 'migrate-legacy') return 'legacy-materializer-after-marker-phase'
  return 'legacy-materializer-after-rollback-marker-phase'
}

function freezeCheckpoint({ runId, mode, operation, cut, readyFile, expected }) {
  let frozen = false
  return (step, facts = {}) => {
    if (frozen || step !== expected) return
    frozen = true
    exclusiveDurableWrite(readyFile, `${JSON.stringify({
      schemaVersion: 1,
      runId,
      pid: process.pid,
      mode,
      operation,
      cut,
      phase: step,
      transactionHash: typeof facts.transactionId === 'string' ? sha256(facts.transactionId) : null
    }, null, 2)}\n`)
    assertPlainFile(readyFile, 'cut ready evidence')
    const gate = new Int32Array(new SharedArrayBuffer(4))
    Atomics.wait(gate, 0, 0)
  }
}

async function authorizeSession(input, modules) {
  const { createLocalHost } = modules.localHost
  const runner = {
    enabled() { return true },
    available() { return true },
    start() { return process.pid },
    pidAlive(pid) { return pid === process.pid }
  }
  const host = createLocalHost({
    packageRoot: input.packageRoot,
    dataRoot: input.dataRoot,
    hostId: 'p3-installed-real-worker',
    localSessionOptions: { runner },
    leaseMs: input.leaseMs,
    renewalIntervalMs: leaseRenewalInterval(input.leaseMs)
  })
  await host.ready()
  const result = await host.application.execute({
    kind: 'attach',
    meta: host.commandMeta('p3-real-worker', input.requestId),
    worktree: input.worktree,
    intent: 'P3 installed-real authorized attach',
    runner: { start: true, wait: false }
  })
  if (!result.ok) {
    output({ schemaVersion: 1, ok: false, mode: input.mode, code: result.error.code })
    process.exitCode = 2
    return
  }
  const session = result.data.session
  if (session.status !== 'running' || !IDENTIFIER_PATTERN.test(session.id)) fail('attach session did not start')
  const exitFile = path.join(input.dataRoot, 'skill-review', `session-${session.id}.exit`)
  if (!isInside(input.dataRoot, exitFile)) fail('session exit evidence escaped data root')
  assertPlainDirectoryChain(path.dirname(exitFile), 'session exit evidence parent chain')
  exclusiveDurableWrite(exitFile, '0\n')
  output({
    schemaVersion: 1,
    ok: true,
    mode: input.mode,
    status: 'running',
    sessionId: session.id,
    targetId: session.target?.id || null
  })
}

async function executeCut(input, modules) {
  const packageMetadata = JSON.parse(fs.readFileSync(path.join(input.packageRoot, 'package.json'), 'utf8'))
  const runtimeRevision = String(packageMetadata.version || '')
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/.test(runtimeRevision)) fail('installed runtime revision is invalid')
  const expected = checkpointFor(input.operation, input.cut)
  const freeze = freezeCheckpoint({ ...input, expected })

  const base = modules.createHub.createHub(input.dataRoot)
  const lock = modules.lease.createLeaseLockManager({
    root: path.join(input.dataRoot, 'skill-review', 'locks'),
    leaseMs: input.leaseMs
  })
  const durable = modules.durable.createDurableTransactionHost({
    root: input.dataRoot,
    schemaFor: modules.durableSchema.createLocalDurableSchemaResolver(),
    lock,
    renewalIntervalMs: leaseRenewalInterval(input.leaseMs),
    checkpoint: input.cut === 'durable-new' ? freeze : undefined
  })
  const context = { ...base, persist: durable.persist }
  const applicationPorts = modules.applicationPorts.createLocalApplicationPorts(context, {
    packageRoot: input.packageRoot
  })
  const snapshots = modules.snapshots.createSnapshotRepository({
    root: path.join(input.dataRoot, 'skill-review', 'library'),
    sourceRoot: input.dataRoot,
    source: { kind: 'library', id: 'skill-graft-library' },
    captureRoots: () => modules.p2.localLibraryCaptureRoots(context),
    persist: durable.persist
  })
  const p2 = modules.p2.createLocalP2ApplicationPorts(context, {
    runtimeRevision,
    queries: applicationPorts.queries,
    snapshots,
    persist: durable.persist
  })
  const runtimeAssets = modules.runtimeAssets.createLocalRuntimeAssetRepository({
    packageRoot: input.packageRoot,
    runtimeRevision
  })
  const p3 = {
    runtimeAssets,
    materialize: modules.materializer.createLocalMaterializer({
      packageRoot: input.packageRoot,
      dataRoot: input.dataRoot,
      identities: p2.identities,
      snapshots,
      runtimeAssets,
      legacySourceRoot: input.dataRoot,
      checkpoint: input.cut === 'durable-old' ? freeze : undefined
    }),
    records: modules.records.createLocalMaterializationRecordPort(context, durable.persist)
  }
  const host = modules.localHost.createLocalHost({
    packageRoot: input.packageRoot,
    dataRoot: input.dataRoot,
    hostId: 'p3-installed-real-worker',
    context,
    p2,
    p3,
    transactions: durable.transactions,
    runtimeRevision,
    leaseMs: input.leaseMs,
    renewalIntervalMs: leaseRenewalInterval(input.leaseMs)
  })
  const meta = host.commandMeta('p3-real-worker', input.requestId)
  let command
  if (input.operation === 'sync') {
    command = {
      kind: 'sync', meta, worktree: input.worktree, planHash: input.planHash,
      ...(input.sessionId ? { sessionId: input.sessionId } : {})
    }
  } else if (input.operation === 'migrate-legacy') {
    command = { kind: 'migrateLegacy', meta, worktree: input.worktree, mode: 'commit', planHash: input.planHash }
  } else {
    command = {
      kind: 'rollbackLegacyMigration', meta, worktree: input.worktree,
      migrationId: input.migrationId, mode: 'commit', planHash: input.planHash
    }
  }
  const result = await host.application.execute(command)
  if (!result.ok) {
    output({ schemaVersion: 1, ok: false, mode: input.mode, operation: input.operation, cut: input.cut, code: result.error.code })
    process.exitCode = 2
    return
  }
  fail('execute-cut returned without reaching its required checkpoint')
}

async function main() {
  const argv = process.argv.slice(2)
  const mode = take(argv, '--mode')
  const operation = take(argv, '--operation', { optional: true })
  const cut = take(argv, '--cut', { optional: true })
  const runId = take(argv, '--run-id')
  const runRoot = path.resolve(take(argv, '--run-root'))
  const packageRoot = path.resolve(take(argv, '--package-root'))
  const dataRoot = path.resolve(take(argv, '--data-root'))
  const worktree = path.resolve(take(argv, '--worktree'))
  const crossRootInput = take(argv, '--cross-root', { optional: true })
  const crossRoot = crossRootInput ? path.resolve(crossRootInput) : undefined
  const requestId = take(argv, '--request-id')
  const planHash = take(argv, '--plan-hash', { optional: true })
  const migrationId = take(argv, '--migration-id', { optional: true })
  const sessionId = take(argv, '--session-id', { optional: true })
  const readyFileInput = take(argv, '--ready-file', { optional: true })
  const leaseMs = Number(take(argv, '--lease-ms'))
  if (argv.length > 0) fail('unsupported worker arguments')
  if (!ALLOWED_MODES.has(mode)) fail('worker mode is invalid')
  if (!RUN_ID_PATTERN.test(runId)) fail('worker run-id is invalid')
  if (!IDENTIFIER_PATTERN.test(requestId)) fail('worker request-id is invalid')
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 500 || leaseMs > 60_000) fail('worker lease is invalid')
  if (mode === 'execute-cut') {
    if (!ALLOWED_OPERATIONS.has(operation) || !ALLOWED_CUTS.has(cut)) fail('worker cut request is invalid')
    if (!SHA256_PATTERN.test(planHash || '')) fail('worker plan hash is invalid')
    if (operation === 'rollback-legacy' && !SHA256_PATTERN.test(migrationId || '')) fail('worker migration id is invalid')
    if (!readyFileInput) fail('execute-cut requires a ready file')
  } else if (operation || cut || planHash || migrationId || readyFileInput) {
    fail('authorize-session received cut-only arguments')
  }
  if (sessionId && !IDENTIFIER_PATTERN.test(sessionId)) fail('worker session-id is invalid')

  readOwnedMarker(runRoot, runId, '.skill-graft-e2e-run.json', 'runRoot')
  if (crossRoot) {
    if (samePath(crossRoot, path.parse(crossRoot).root)
      || isInside(runRoot, crossRoot) || isInside(crossRoot, runRoot)
      || path.parse(crossRoot).root.toLowerCase() === path.parse(runRoot).root.toLowerCase()) {
      fail('cross-volume root boundary is invalid')
    }
    readOwnedMarker(crossRoot, runId, '.skill-graft-e2e-cross-volume.json', 'root')
  }
  assertOwnedPath(runRoot, packageRoot, 'app', 'installed package')
  assertOwnedPath(runRoot, dataRoot, 'hub-data', 'durable data root')
  if (!samePath(packageRoot, path.join(runRoot, 'app', 'node_modules', 'ozdqp-skill-hub'))
    || !samePath(dataRoot, path.join(runRoot, 'hub-data'))) {
    fail('worker package or data root is not the exact installed-real layout')
  }
  assertWorktreeOwned(runRoot, worktree, crossRoot)
  const readyFile = readyFileInput
    ? path.resolve(readyFileInput)
    : undefined
  if (readyFile) {
    const logsRoot = path.join(runRoot, 'logs')
    if (!isInside(logsRoot, readyFile)) fail('ready file must stay under the marker-owned logs root')
    assertPlainDirectoryChain(path.dirname(readyFile), 'ready file parent chain')
    if (fs.existsSync(readyFile)) fail('ready file must be fresh')
  }

  const modules = await loadInstalledModules(packageRoot)
  const input = {
    mode, operation, cut, runId, runRoot, packageRoot, dataRoot, worktree,
    crossRoot, requestId, planHash, migrationId, sessionId, readyFile, leaseMs
  }
  if (mode === 'authorize-session') await authorizeSession(input, modules)
  else await executeCut(input, modules)
}

main().catch((error) => {
  output({ schemaVersion: 1, ok: false, code: safeCode(error) })
  process.exitCode = 2
})
