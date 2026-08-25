import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{7,95}$/i
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const WAL_MAX_BYTES = 1024 * 1024
const READY_MAX_BYTES = 4 * 1024

function parseArgs(argv) {
  const expected = new Set(['run-id', 'run-root', 'package-root', 'install-dir', 'data-root', 'wal', 'ready'])
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = String(argv[index] || '')
    const value = argv[index + 1]
    if (!flag.startsWith('--') || value === undefined) throw new Error('worker arguments must be exact flag/value pairs')
    const name = flag.slice(2)
    if (!expected.has(name) || values.has(name)) throw new Error('worker received an unknown or duplicate argument')
    values.set(name, String(value))
  }
  if (values.size !== expected.size) throw new Error('worker is missing a required argument')
  return Object.fromEntries([...expected].map((name) => [name.replaceAll('-', '_'), values.get(name)]))
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

function readCanonicalWal(file) {
  const before = fs.lstatSync(file)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
    || before.size <= 0 || before.size > WAL_MAX_BYTES) {
    throw new Error('published lifecycle WAL is not one bounded plain file')
  }
  const bytes = fs.readFileSync(file)
  const after = fs.lstatSync(file)
  if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1
    || after.dev !== before.dev || after.ino !== before.ino
    || after.size !== before.size || after.mtimeMs !== before.mtimeMs
    || bytes.length !== before.size) {
    throw new Error('published lifecycle WAL changed while the worker read it')
  }
  const wal = JSON.parse(bytes.toString('utf8'))
  const canonical = Buffer.from(`${JSON.stringify(wal, null, 2)}\n`, 'utf8')
  if (!bytes.equals(canonical)) throw new Error('published lifecycle WAL bytes are not canonical')
  return { bytes, wal }
}

function writeReady(file, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
  if (bytes.length <= 0 || bytes.length > READY_MAX_BYTES) throw new Error('worker ready marker exceeds its bound')
  const descriptor = fs.openSync(file, 'wx', 0o600)
  try {
    fs.writeFileSync(descriptor, bytes)
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

function parkForever() {
  const parked = new Int32Array(new SharedArrayBuffer(4))
  for (;;) Atomics.wait(parked, 0, 0)
}

async function main() {
  if (process.platform !== 'win32') throw new Error('P4 lifecycle cut worker is Windows-only')
  const args = parseArgs(process.argv.slice(2))
  if (!RUN_ID_PATTERN.test(args.run_id)) throw new Error('worker run ID is invalid')

  const runRoot = path.resolve(args.run_root)
  const packageRoot = path.resolve(args.package_root)
  const installDir = path.resolve(args.install_dir)
  const dataRoot = path.resolve(args.data_root)
  const walFile = path.resolve(args.wal)
  const readyFile = path.resolve(args.ready)
  if (!isInside(runRoot, packageRoot) || !isInside(runRoot, installDir)
    || !isInside(runRoot, dataRoot) || !isInside(runRoot, readyFile)) {
    throw new Error('worker paths must remain inside the isolated run root')
  }
  if (!samePath(walFile, `${dataRoot}.lifecycle-wal.json`) || !isInside(runRoot, walFile)) {
    throw new Error('worker WAL path is not bound to the isolated data root')
  }
  if (fs.existsSync(readyFile)) throw new Error('worker ready marker must start absent')

  const controlModule = path.join(packageRoot, 'dist', 'control', 'install.js')
  const hostModule = path.join(packageRoot, 'dist', 'adapters', 'install-host.js')
  for (const file of [controlModule, hostModule]) {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error('worker production module must be one plain installed file')
    }
  }
  const [{ upgradeHub }, { createInstallHost }] = await Promise.all([
    import(pathToFileURL(controlModule).href),
    import(pathToFileURL(hostModule).href)
  ])
  if (typeof upgradeHub !== 'function' || typeof createInstallHost !== 'function') {
    throw new Error('installed package does not expose the lifecycle production entry points')
  }

  const baseHost = createInstallHost()
  let cutPublished = false
  const publishCutIfPresent = () => {
    if (cutPublished || !fs.existsSync(walFile)) return
    const { bytes, wal } = readCanonicalWal(walFile)
    if (wal?.phase !== 'switched') return
    if (wal.schemaVersion !== 1 || wal.operation !== 'upgrade'
      || !UUID_PATTERN.test(String(wal.walId || ''))
      || !UUID_PATTERN.test(String(wal.lockToken || ''))
      || !samePath(String(wal.installDir || ''), installDir)) {
      throw new Error('worker observed an invalid switched lifecycle WAL')
    }
    cutPublished = true
    writeReady(readyFile, {
      schemaVersion: 1,
      runId: args.run_id,
      workerPid: process.pid,
      phase: 'switched',
      walId: wal.walId,
      walBytes: bytes.length,
      walSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    })
    parkForever()
  }
  const host = Object.freeze({
    ...baseHost,
    taskExists(name) {
      // currentLifecycleIntegration reads the scheduled-task provider before
      // userPathState. Observe the product-written switched WAL at the first
      // integration read, before a provider result can affect recovery.
      publishCutIfPresent()
      return baseHost.taskExists(name)
    },
    userPathState() {
      // The production upgrade publishes its switched WAL immediately before
      // integration reads this provider. Observe only; the parent kills us.
      publishCutIfPresent()
      return baseHost.userPathState()
    },
    integrationSnapshot(environmentNames, taskName) {
      publishCutIfPresent()
      if (typeof baseHost.integrationSnapshot !== 'function') {
        throw new Error('installed package does not expose the integration snapshot provider')
      }
      return baseHost.integrationSnapshot(environmentNames, taskName)
    }
  })

  const result = await upgradeHub(packageRoot, { dryRun: false, json: true, noDaemon: false }, host)
  const status = result && typeof result === 'object' && typeof result.status === 'string'
    ? result.status
    : 'unknown'
  const issues = result && typeof result === 'object' && Array.isArray(result.issues)
    ? result.issues.map((issue) => {
      if (typeof issue === 'string') return issue
      if (issue && typeof issue === 'object' && typeof issue.message === 'string') return issue.message
      return String(issue || '')
    }).filter(Boolean).join('; ')
    : ''
  throw new Error(`production upgrade returned before the switched WAL cut was reached; status=${status}; issues=${issues || 'none'}`)
}

main().catch((error) => {
  const kind = error && typeof error === 'object' && typeof error.name === 'string' ? error.name : 'Error'
  const rawMessage = error && typeof error === 'object' && typeof error.message === 'string'
    ? error.message
    : String(error || 'unknown error')
  const message = rawMessage.replace(/[\r\n\t]+/g, ' ').slice(0, 512)
  process.stderr.write(`p4 lifecycle upgrade-cut worker failed (${kind}): ${message}\n`)
  process.exitCode = 1
})
