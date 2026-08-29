import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { applicationLeaseRoot } from '../../../dist/adapters/lease-lock.js'
import {
  ProcessTracker,
  assertRunLayoutOwned,
  createIsolatedGitEnvironment,
  createWindowsBatchInvocation,
  getAvailableLoopbackPort,
  validateRealE2eEnvironment
} from '../../support/real-e2e.mjs'
import {
  assertExternalEnvironmentEqual,
  assertFreshRunLayout,
  assertLocatorFree,
  assertOwnedPath,
  assertPlainDirectory,
  assertPlainDirectoryChain,
  assertPlainFile,
  assertProtectedRootBaselines,
  broadcastEnvironmentChange,
  captureProtectedRootBaselines,
  deleteExactOwnedTask,
  ensureOwnedDirectory,
  findCommandsOnPath,
  isExactTransientWriteLockBusy,
  parseNpmPack,
  readExternalEnvironmentSnapshot,
  runChecked,
  runNpm,
  samePath,
  sha256Bytes,
  sha256File,
  tail,
  taskState,
  treeManifest,
  withoutHostCommandBins,
  writeBoundedJson,
  writeUserEnvironmentValue
} from '../../support/p4-installed-real.mjs'

if (process.platform !== 'win32') {
  throw new Error('P4 installed-real is Windows-only and never skips on another platform')
}

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const protectedRoots = String(process.env.SKILL_GRAFT_PROTECTED_ROOTS || '')
  .split(path.delimiter)
  .map((item) => item.trim())
  .filter(Boolean)
for (const candidate of [
  'E:\\ozdqp-skill-hub',
  'E:\\ozdqp-cli-attach-probe',
  'E:\\ozdqp-main-fix',
  'E:\\deepseek-harness-master'
]) {
  if (fs.existsSync(candidate)) protectedRoots.push(candidate)
}

const context = validateRealE2eEnvironment(process.env, { workspaceRoot: sourceRoot, protectedRoots })
assertRunLayoutOwned(context)
assertFreshRunLayout(context)

const packageName = 'ozdqp-skill-hub'
const publicRuntimeRelative = 'AGENTS.override.md'
const packageARoot = path.join(context.appRoot, 'node_modules', packageName)
const packageAPublicRuntime = path.join(packageARoot, publicRuntimeRelative)
const cliA = path.join(context.appRoot, 'node_modules', '.bin', 'sg.cmd')
const hostBRoot = path.join(context.appRoot, 'host-b')
const packageBRoot = path.join(hostBRoot, 'node_modules', packageName)
const packageBPublicRuntime = path.join(packageBRoot, publicRuntimeRelative)
const cliB = path.join(hostBRoot, 'node_modules', '.bin', 'sg.cmd')
const installDir = path.join(context.appRoot, 'lifecycle-install')
const installBin = path.join(installDir, 'bin')
const lifecycleLock = `${context.hubDataRoot}.lifecycle.lock`
const lifecycleWal = `${context.hubDataRoot}.lifecycle-wal.json`
const applicationWriterOwnerFile = path.join(
  applicationLeaseRoot(context.hubDataRoot),
  'leases',
  'hub-global.lock',
  'owner.json'
)
const npmCache = path.join(context.homeRoot, 'npm-cache')
const npmPrefix = path.join(context.homeRoot, 'npm-prefix')
const appData = path.join(context.homeRoot, 'appdata')
const localAppData = path.join(context.homeRoot, 'localappdata')
const tempRoot = path.join(context.homeRoot, 'temp')
const xdgRoot = path.join(context.homeRoot, 'xdg-config')
const dshHome = path.join(context.homeRoot, 'dsh-home')
const fakeEditorBin = path.join(appData, 'npm')
const fakeCodexModule = path.join(fakeEditorBin, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
const fakeCodexCommand = path.join(fakeEditorBin, 'codex.cmd')
const privateSkill = 'p4-private-skill'
const privateSkillSnapshotPath = `skills/adopted/${privateSkill}/SKILL.md`
const privateSkillFile = path.join(context.hubDataRoot, ...privateSkillSnapshotPath.split('/'))
const dataPublicRuntime = path.join(context.hubDataRoot, publicRuntimeRelative)
const panelPlanSyncReadyFile = path.join(context.logsRoot, 'p4-panel-plan-sync-ready.json')
const panelPlanSyncContinueFile = path.join(context.logsRoot, 'p4-panel-plan-sync-continue.json')
const panelDirtyConflictReadyFile = path.join(context.logsRoot, 'p4-panel-dirty-conflict-ready.json')
const panelDirtyConflictContinueFile = path.join(context.logsRoot, 'p4-panel-dirty-conflict-continue.json')
const upgradeCutReadyFile = path.join(context.logsRoot, 'p4-upgrade-switched-ready.json')
const summaryFile = path.join(context.logsRoot, 'p4-installed-summary.json')
const taskName = `SkillGraft-P4-${context.runId}`.slice(0, 96)
const outputLimit = 64 * 1024 * 1024
const protectedSet = [sourceRoot, ...protectedRoots]

assert.equal(samePath(context.cliPath, cliA), true, 'SKILL_GRAFT_CLI must name the exact A host sg.cmd path')
for (const [target, first, label] of [
  [packageARoot, 'app', 'package A'],
  [packageBRoot, 'app', 'package B'],
  [installDir, 'app', 'lifecycle install'],
  [privateSkillFile, 'hub-data', 'private skill'],
  [dataPublicRuntime, 'hub-data', 'data-root public runtime'],
  [fakeCodexModule, 'home', 'fake editor module'],
  [upgradeCutReadyFile, 'logs', 'upgrade cut ready marker'],
  [summaryFile, 'logs', 'summary']
]) assertOwnedPath(context, target, first, label)

function deleteEnvironmentNames(environment, predicate) {
  for (const name of Object.keys(environment)) {
    if (predicate(name.toUpperCase())) delete environment[name]
  }
}

function parseJsonResult(result, label, expectedStatus = 0) {
  assert.equal(result.error, undefined, `${label} spawn failed: ${result.error?.message || ''}`)
  assert.equal(result.status, expectedStatus, `${label} exit ${result.status}: ${tail(result.stderr || result.stdout)}`)
  try { return JSON.parse(String(result.stdout || '')) } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error instanceof Error ? error.message : error}`)
  }
}

function npmPackEvidence(packed, tarball, label) {
  assert.equal(typeof packed.name, 'string', `${label} package name`)
  assert.equal(typeof packed.version, 'string', `${label} package version`)
  assert.equal(Number.isSafeInteger(packed.size) && packed.size > 0, true, `${label} packed size`)
  assert.equal(Number.isSafeInteger(packed.unpackedSize) && packed.unpackedSize > 0, true, `${label} unpacked size`)
  assert.match(String(packed.shasum || ''), /^[0-9a-f]{40}$/i, `${label} npm shasum`)
  assert.match(String(packed.integrity || ''), /^sha512-[A-Za-z0-9+/]+=*$/, `${label} npm integrity`)
  assert.equal(Array.isArray(packed.files) && packed.files.length > 0, true, `${label} file inventory`)
  assert.equal(fs.statSync(tarball).size, packed.size, `${label} tarball size`)
  return {
    filename: path.basename(tarball),
    name: packed.name,
    version: packed.version,
    size: packed.size,
    unpackedSize: packed.unpackedSize,
    shasum: packed.shasum,
    integrity: packed.integrity,
    fileCount: packed.files.length,
    sha256: `sha256:${sha256File(tarball)}`
  }
}

function cliInvocation(cli, args) {
  return createWindowsBatchInvocation(cli, args)
}

function runCli(cli, args, environment, { timeout = 180_000 } = {}) {
  const invocation = cliInvocation(cli, args)
  return spawnSync(invocation.command, invocation.args, {
    cwd: context.appRoot,
    env: environment,
    encoding: 'utf8',
    windowsHide: true,
    windowsVerbatimArguments: true,
    timeout,
    maxBuffer: outputLimit
  })
}

function lifecycle(cli, args, environment, label, expectedStatus = 0) {
  return parseJsonResult(runCli(cli, args, environment, { timeout: 420_000 }), label, expectedStatus)
}

function typed(cli, args, environment, label, { allowTransientWriteLockBusy = false } = {}) {
  const requestId = `${label}-${context.runId}`.slice(0, 150)
  const result = runCli(cli, [
    ...args, '--contract-v1', '--request-id', requestId
  ], environment)
  if (allowTransientWriteLockBusy && isExactTransientWriteLockBusy(result)) return null
  const envelope = parseJsonResult(result, label)
  assert.equal(envelope.contractVersion, 1, `${label} contract version`)
  assert.equal(envelope.requestId, requestId, `${label} request ID`)
  assert.equal(envelope.ok, true, `${label} Application failure: ${JSON.stringify(envelope.error || {})}`)
  assert.equal(envelope.meta?.handler, 'application.commandBus', `${label} handler`)
  return envelope
}

function runGit(worktree, args, environment, label, expectedStatus = 0) {
  const result = spawnSync('git', [
    '--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', worktree, ...args
  ], {
    env: createIsolatedGitEnvironment(environment, context.homeRoot),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: outputLimit
  })
  assert.equal(result.error, undefined, `${label} spawn failed`)
  assert.equal(result.status, expectedStatus, `${label}: ${tail(result.stderr || result.stdout)}`)
  return String(result.stdout || '').trim()
}

function writeText(file, value, options = undefined) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, value, options || 'utf8')
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function readBoundedCanonicalJson(file, maxBytes, label) {
  assertPlainFile(file, label)
  const before = fs.lstatSync(file)
  assert.equal(before.nlink, 1, `${label} must have one link`)
  assert.equal(before.size > 0 && before.size <= maxBytes, true, `${label} exceeds its byte bound`)
  const bytes = fs.readFileSync(file)
  const after = fs.lstatSync(file)
  assert.equal(after.isFile() && !after.isSymbolicLink() && after.nlink === 1, true, `${label} changed kind while read`)
  assert.equal(after.dev, before.dev, `${label} changed device while read`)
  assert.equal(after.ino, before.ino, `${label} changed inode while read`)
  assert.equal(after.size, before.size, `${label} changed size while read`)
  assert.equal(after.mtimeMs, before.mtimeMs, `${label} changed timestamp while read`)
  assert.equal(bytes.length, before.size, `${label} read was incomplete`)
  const value = JSON.parse(bytes.toString('utf8'))
  assert.equal(bytes.equals(Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')), true, `${label} bytes must be canonical`)
  return { value, bytes, sha256: `sha256:${sha256Bytes(bytes)}` }
}

function collectBoundedChildOutput(stream, maxBytes = 64 * 1024) {
  const chunks = []
  let length = 0
  let truncated = false
  stream.on('data', (chunk) => {
    const bytes = Buffer.from(chunk)
    const remaining = Math.max(0, maxBytes - length)
    if (remaining > 0) {
      const kept = bytes.subarray(0, remaining)
      chunks.push(kept)
      length += kept.length
    }
    if (bytes.length > remaining) truncated = true
  })
  return () => `${Buffer.concat(chunks, length).toString('utf8')}${truncated ? '\n[bounded output truncated]' : ''}`
}

async function waitForUpgradeCutReady(child, childState, readyFile, stdout, stderr, timeoutMs = 420_000) {
  const deadline = Date.now() + timeoutMs
  let markerError = null
  while (Date.now() < deadline) {
    if (fs.existsSync(readyFile)) {
      try {
        return readBoundedCanonicalJson(readyFile, 4 * 1024, 'upgrade cut ready marker')
      } catch (error) {
        markerError = error
      }
    }
    if (childState.error || child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`upgrade cut worker exited before ready: ${childState.error?.name || child.exitCode || child.signalCode || 'unknown'}; stdout=${tail(stdout())}; stderr=${tail(stderr())}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`upgrade cut worker ready timeout${markerError ? `: ${markerError.message}` : ''}; stdout=${tail(stdout())}; stderr=${tail(stderr())}`)
}

async function waitForChildExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise((resolve, reject) => {
    let settled = false
    const finish = (error = null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.off('exit', onExit)
      if (error) reject(error)
      else resolve()
    }
    const onExit = () => finish()
    const timer = setTimeout(() => {
      finish(new Error('upgrade cut worker did not report exit after owned tree termination'))
    }, timeoutMs)
    child.once('exit', onExit)
    if (child.exitCode !== null || child.signalCode !== null) finish()
  })
}

async function waitForKilledApplicationWriterLeaseExpiry(
  ownerFile,
  expected,
  expectedPid,
  timeoutMs = 35_000
) {
  assert.equal(expected.value.pid, expectedPid, 'killed application writer PID')
  const eligibleAt = Date.parse(expected.value.leaseUntil) + 100
  assert.equal(Number.isFinite(eligibleAt), true, 'killed application writer leaseUntil')
  const deadline = Date.now() + timeoutMs
  if (eligibleAt > deadline) throw new Error('killed application writer lease exceeds its bounded wait')
  while (Date.now() < eligibleAt) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, eligibleAt - Date.now()))))
  }
  const current = readBoundedCanonicalJson(ownerFile, 64 * 1024, 'expired application writer owner')
  assert.equal(
    current.bytes.equals(expected.bytes),
    true,
    'worker termination and lease expiry must not edit the application owner'
  )
  assert.equal(current.value.pid, expectedPid)
  return current
}

function packageVersion(packageRoot) {
  const pkg = readJson(path.join(packageRoot, 'package.json'))
  assert.equal(pkg.name, packageName)
  assert.equal(typeof pkg.version, 'string')
  assert.notEqual(pkg.version.trim(), '')
  return pkg.version
}

function publicRuntimeHash(file) {
  assertPlainFile(file, 'public runtime file')
  return `sha256:${sha256File(file)}`
}

function assertDataPublicRuntime(expectedPackageFile, expectedHash, label) {
  assert.equal(publicRuntimeHash(expectedPackageFile), expectedHash, `${label} package public runtime hash`)
  assertPlainFile(dataPublicRuntime, `${label} data-root public runtime`)
  assert.deepEqual(
    fs.readFileSync(dataPublicRuntime),
    fs.readFileSync(expectedPackageFile),
    `${label} data-root public runtime bytes`
  )
  assert.equal(publicRuntimeHash(dataPublicRuntime), expectedHash, `${label} data-root public runtime hash`)
}

function bumpedVersion(version) {
  const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/)
  assert.ok(match, `A package version must be SemVer-compatible: ${version}`)
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}-p4.${sha256Bytes(context.runId).slice(0, 8)}`
}

function createPackageHost(root) {
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true })
  assertPlainDirectoryChain(root, 'npm host root')
  const packageFile = path.join(root, 'package.json')
  if (!fs.existsSync(packageFile)) {
    fs.writeFileSync(packageFile, `${JSON.stringify({ name: `p4-host-${sha256Bytes(root).slice(0, 12)}`, private: true })}\n`, {
      flag: 'wx', encoding: 'utf8'
    })
  }
}

function installTarball(hostRoot, tarball, environment, label) {
  createPackageHost(hostRoot)
  runChecked(runNpm([
    'install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-save', '--package-lock=false', tarball
  ], hostRoot, environment), label)
}

function extractTarball(tarball, stagingRoot, environment) {
  assert.equal(fs.existsSync(stagingRoot), false, 'B staging root must be fresh')
  assert.ok(fs.statSync(tarball).size <= 256 * 1024 * 1024, 'A tarball exceeds the bounded extraction limit')
  const listed = spawnSync('tar.exe', ['-tzf', tarball], {
    cwd: context.appRoot,
    env: environment,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: outputLimit
  })
  const entries = runChecked(listed, 'inspect package A tarball').split(/\r?\n/).filter(Boolean)
  assert.ok(entries.length > 0 && entries.length <= 20_000, 'A tarball entry count is outside the extraction bound')
  for (const entry of entries) {
    const portable = entry.replaceAll('\\', '/')
    assert.equal(portable === 'package' || portable.startsWith('package/'), true, 'A tarball entry escapes package/')
    assert.equal(portable.split('/').includes('..'), false, 'A tarball entry contains parent traversal')
    assert.equal(path.posix.isAbsolute(portable) || /^[A-Za-z]:/.test(portable), false, 'A tarball entry is absolute')
  }
  fs.mkdirSync(stagingRoot)
  const result = spawnSync('tar.exe', ['-xzf', tarball, '-C', stagingRoot], {
    cwd: context.appRoot,
    env: environment,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: outputLimit
  })
  runChecked(result, 'extract package A for package B')
  assert.deepEqual(fs.readdirSync(stagingRoot), ['package'])
  assertPlainDirectory(path.join(stagingRoot, 'package'), 'extracted B package source')
  treeManifest(path.join(stagingRoot, 'package'))
  return path.join(stagingRoot, 'package')
}

function strictDoctor(report, expectedVersion, label) {
  assert.equal(report.ok, true, `${label}: ${JSON.stringify(report.issues || [])}`)
  for (const key of ['node', 'git', 'dist', 'codex']) assert.equal(report[key]?.ok, true, `${label} ${key}`)
  assert.equal(report.layout?.ok, true, `${label} layout`)
  assert.equal(report.shims?.ok, true, `${label} shims`)
  assert.equal(report.path?.ok, true, `${label} path`)
  assert.equal(report.path?.onUserPath, true, `${label} user path`)
  assert.equal(report.daemon?.ok, true, `${label} daemon`)
  assert.equal(report.daemon?.taskRegistered, true, `${label} task`)
  assert.equal(report.daemon?.running, true, `${label} daemon running`)
  assert.equal(report.daemon?.apiHealthy, true, `${label} API health`)
  assert.equal(report.lifecycle?.manifest, true, `${label} manifest`)
  assert.equal(report.lifecycle?.ownership, true, `${label} ownership`)
  assert.equal(report.lifecycle?.dataMarker, true, `${label} marker`)
  assert.equal(report.lifecycle?.lockHealthy, true, `${label} lock`)
  assert.equal(report.lifecycle?.lockState, 'clear', `${label} lock state`)
  assert.equal(report.lifecycle?.walPending, false, `${label} WAL`)
  assert.equal(report.lifecycle?.durablePending, 0, `${label} durable pending`)
  assert.equal(report.lifecycle?.reviewLocks?.active, 0, `${label} review locks`)
  assert.equal(report.lifecycle?.versionMatch, true, `${label} package identity`)
  assert.equal(report.lifecycle?.packageVersion, expectedVersion, `${label} candidate version`)
  assert.equal(report.lifecycle?.installedVersion, expectedVersion, `${label} installed version`)
}

function userPathExpected(baseline, binDir) {
  const before = baseline.Path.exists ? baseline.Path.value : ''
  return before ? `${binDir};${before}` : binDir
}

function assertOwnedExternalState(baseline, port, silentVbs) {
  const current = readExternalEnvironmentSnapshot()
  assert.equal(current.SKILL_GRAFT_HOME.exists, true)
  assert.equal(current.SKILL_GRAFT_HOME.value, context.hubDataRoot)
  assert.equal(current.HUB_ROOT.exists, true)
  assert.equal(current.HUB_ROOT.value, context.hubDataRoot)
  assert.equal(current.HUB_API_PORT.exists, true)
  assert.equal(current.HUB_API_PORT.value, String(port))
  assert.equal(current.Path.exists, true)
  assert.equal(current.Path.value, userPathExpected(baseline, installBin))
  const task = taskState(taskName)
  assert.equal(task.exists, true, 'owned scheduled task must exist')
  assert.equal(task.action.toLowerCase(), `wscript.exe\u0000"${silentVbs}"`.toLowerCase())
}

function assertExternalClean(baseline) {
  assertExternalEnvironmentEqual(readExternalEnvironmentSnapshot(), baseline, 'lifecycle cleanup')
  assert.equal(taskState(taskName).exists, false, 'scheduled task must be absent')
  assert.equal(fs.existsSync(installDir), false, 'owned install directory must be absent')
  assert.equal(fs.existsSync(lifecycleLock), false, 'lifecycle lock must be absent')
  assert.equal(fs.existsSync(lifecycleWal), false, 'lifecycle WAL must be absent')
  assert.deepEqual(
    fs.readdirSync(path.dirname(installDir)).filter((name) => name.startsWith(`${path.basename(installDir)}.uninstalling-`)),
    [],
    'uninstall tombstones must be absent'
  )
  for (const relative of [
    'skill-review/daemon.pid',
    'skill-review/api.pid',
    'skill-review/daemon-heartbeat.json'
  ]) assert.equal(fs.existsSync(path.join(context.hubDataRoot, ...relative.split('/'))), false, `${relative} must be absent`)
  assert.equal(fs.existsSync(path.join(fakeEditorBin, 'sg.cmd')), false, 'extra sg shim must be absent')
  assert.equal(fs.existsSync(path.join(fakeEditorBin, 'ozdqp-hub.cmd')), false, 'extra alias shim must be absent')
  assertPlainFile(fakeCodexCommand, 'fake editor command preserved')
  assertPlainFile(fakeCodexModule, 'fake editor module preserved')
}

function restoreOwnedExternalState(baseline, expected) {
  if (!expected) return
  const current = readExternalEnvironmentSnapshot()
  let environmentChanged = false
  const allowed = {
    SKILL_GRAFT_HOME: context.hubDataRoot,
    HUB_ROOT: context.hubDataRoot,
    HUB_API_PORT: String(expected.port)
  }
  for (const [name, ownedValue] of Object.entries(allowed)) {
    const before = baseline[name]
    const now = current[name]
    if (now.exists === before.exists && now.value === before.value) continue
    if (!now.exists || now.value !== ownedValue) throw new Error(`refusing emergency restore of foreign HKCU ${name}`)
    writeUserEnvironmentValue(name, before.exists ? before.value : null, before.kind || 'String')
    environmentChanged = true
  }
  const expectedPath = userPathExpected(baseline, installBin)
  if (current.Path.exists !== baseline.Path.exists || current.Path.value !== baseline.Path.value) {
    if (!current.Path.exists || current.Path.value !== expectedPath) {
      throw new Error('refusing emergency restore of a concurrently changed HKCU Path')
    }
    writeUserEnvironmentValue('Path', baseline.Path.exists ? baseline.Path.value : null, baseline.Path.kind || 'String')
    environmentChanged = true
  }
  if (environmentChanged) broadcastEnvironmentChange()
  deleteExactOwnedTask(taskName, `wscript.exe\u0000"${expected.silentVbs}"`)
}

function portListening(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port })
    const done = (value) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(500)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

async function waitForPort(port, expected, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  do {
    if (await portListening(port) === expected) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  return (await portListening(port)) === expected
}

async function waitForDaemon(cli, environment, tracker, expectedVersion, label) {
  const deadline = Date.now() + 240_000
  const minimumStatusBudgetMs = 120_000
  let last = null
  let lastDiagnostic = 'daemon status was not invoked'
  let attempted = false
  do {
    const remaining = deadline - Date.now()
    if (attempted && remaining < minimumStatusBudgetMs) break
    attempted = true
    const result = runCli(cli, ['daemon', 'status'], environment, {
      timeout: Math.min(180_000, Math.max(1, remaining))
    })
    const stdout = String(result.stdout || '')
    const stderr = String(result.stderr || '')
    lastDiagnostic = result.error
      ? `spawn=${tail(result.error.message)}`
      : `exit=${result.status}; stdout=${tail(stdout)}; stderr=${tail(stderr)}`
    let current = null
    try {
      current = JSON.parse(stdout)
      last = current
    } catch (error) {
      if (result.status === 0) {
        throw new Error(`${label} healthy daemon status returned invalid JSON: ${tail(error.message)}`)
      }
    }
    const timedOut = result.error?.code === 'ETIMEDOUT'
    if (result.error && !timedOut) {
      throw new Error(`${label} daemon status spawn failed: ${tail(result.error.message)}`)
    }
    if (!timedOut && result.status !== 0 && result.status !== 1) {
      throw new Error(`${label} daemon status exited unexpectedly: ${lastDiagnostic}`)
    }
    if (result.status === 0) {
      assert.equal(current && typeof current === 'object' && !Array.isArray(current), true, `${label} daemon status payload`)
      assert.equal(current.ok && current.running && current.apiHealthy && Number(current.pid) > 0, true, `${label} daemon status health`)
      assert.equal(Number(current.apiPid), Number(current.pid), `${label} daemon/API PID`)
      tracker.trackPid(Number(current.pid), { commandIncludes: context.runId })
      const doctor = lifecycle(cli, ['doctor', '--json'], environment, `${label} strict doctor`)
      strictDoctor(doctor, expectedVersion, label)
      return { status: current, doctor }
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  } while (Date.now() < deadline)
  throw new Error(
    `${label} daemon did not become strictly healthy: ${JSON.stringify(last)}; ${lastDiagnostic}`
  )
}

async function panelCapability(port) {
  const base = `http://127.0.0.1:${port}`
  const response = await fetch(`${base}/`, { signal: AbortSignal.timeout(5_000) })
  assert.equal(response.status, 200, 'panel bootstrap status')
  const cookie = String(response.headers.get('set-cookie') || '').split(';', 1)[0]
  assert.match(cookie, /^skill_graft_capability=/)
  await response.arrayBuffer()
  return { base, cookie }
}

async function httpCommand(panel, body, label, expectedOk = true) {
  const response = await fetch(`${panel.base}/api/command`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: panel.cookie,
      Origin: panel.base
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000)
  })
  const envelope = await response.json()
  assert.equal(response.status, 200, `${label} HTTP status`)
  assert.equal(envelope.contractVersion, 1, `${label} contract`)
  assert.equal(envelope.requestId, body.requestId, `${label} request ID`)
  assert.equal(envelope.commandKind, body.kind, `${label} command kind`)
  assert.equal(envelope.meta?.handler, 'application.commandBus', `${label} handler`)
  assert.equal(envelope.ok, expectedOk, `${label} Application outcome`)
  return envelope
}

function createRepository(environment) {
  const common = path.join(context.probeRoot, 'p4-common')
  const worktree = path.join(context.probeRoot, 'p4-worktree')
  assertOwnedPath(context, common, 'probe', 'P4 common repository')
  assertOwnedPath(context, worktree, 'probe', 'P4 linked worktree')
  fs.mkdirSync(common)
  writeText(path.join(common, 'AGENTS.md'), '# P4 installed-real probe\n')
  writeText(path.join(common, 'baloot_client', 'README.md'), '# recognition marker\n')
  writeText(path.join(common, 'revision.txt'), 'revision A\n')
  runGit(common, ['init'], environment, 'probe init')
  runGit(common, ['config', 'user.name', 'Skill Graft P4'], environment, 'probe user name')
  runGit(common, ['config', 'user.email', 'skill-graft-p4@example.invalid'], environment, 'probe user email')
  runGit(common, ['config', 'extensions.worktreeConfig', 'true'], environment, 'probe worktree config')
  runGit(common, ['add', '--', 'AGENTS.md', 'baloot_client', 'revision.txt'], environment, 'probe add A')
  runGit(common, ['commit', '-m', 'P4 fixture A'], environment, 'probe commit A')
  const commitA = runGit(common, ['rev-parse', 'HEAD'], environment, 'probe A HEAD')
  writeText(path.join(common, 'revision.txt'), 'revision B\n')
  runGit(common, ['add', '--', 'revision.txt'], environment, 'probe add B')
  runGit(common, ['commit', '-m', 'P4 fixture B'], environment, 'probe commit B')
  const commitB = runGit(common, ['rev-parse', 'HEAD'], environment, 'probe B HEAD')
  runGit(common, ['worktree', 'add', '--detach', worktree, commitB], environment, 'probe worktree add')
  assertPlainDirectoryChain(worktree, 'P4 linked worktree')
  return Object.freeze({ common, worktree, commitA, commitB })
}

function configureInstalledHook(fixture, packageRoot, environment) {
  const hooks = path.join(packageRoot, 'overlay', 'hooks')
  assertPlainFile(path.join(hooks, 'post-checkout'), 'installed post-checkout hook')
  for (const [key, value] of [
    ['core.hooksPath', hooks],
    ['ozdqp.localOverlaySource', packageRoot],
    ['ozdqp.skillWatchWorkspace', context.hubDataRoot],
    ['ozdqp.skillHubAutoAttach', 'true']
  ]) runGit(fixture.worktree, ['config', '--worktree', key, value], environment, `configure ${key}`)
}

async function waitForHookSession(cli, environment, beforeIds) {
  const deadline = Date.now() + 60_000
  let observed = null
  let poll = 0
  do {
    poll += 1
    const envelope = typed(cli, ['session', 'list'], environment, `p4-hook-session-list-${poll}`, {
      allowTransientWriteLockBusy: true
    })
    if (envelope === null) {
      await new Promise((resolve) => setTimeout(resolve, 150))
      continue
    }
    observed = envelope.data.sessions.find((session) => !beforeIds.has(session.id) && session.kind === 'attach') || null
    if (observed?.status === 'waiting' && observed.exitCode === 0) return observed
    if (observed?.status === 'failed' || observed?.status === 'cancelled') {
      throw new Error(`installed hook SessionStart failed: ${JSON.stringify(observed)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  } while (Date.now() < deadline)
  throw new Error(`installed hook SessionStart did not reach waiting: ${JSON.stringify(observed)}`)
}

function ownedWindowsProcesses() {
  const script = [
    "$rows = Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.Name -in @('cmd.exe','node.exe','powershell.exe','wscript.exe') }",
    '$rows = @($rows | Where-Object { ([string]$_.CommandLine).ToLowerInvariant().Contains($env:SG_RUN_TOKEN.ToLowerInvariant()) -and ([string]$_.CommandLine).ToLowerInvariant().Contains($env:SG_RUN_ROOT.ToLowerInvariant()) })',
    '$rows | Select-Object ProcessId,Name | ConvertTo-Json -Compress'
  ].join('; ')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, SG_RUN_TOKEN: context.runId, SG_RUN_ROOT: context.runRoot },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: outputLimit
  })
  runChecked(result, 'enumerate marker-owned processes')
  const raw = String(result.stdout || '').trim()
  if (!raw) return []
  const parsed = JSON.parse(raw)
  return Array.isArray(parsed) ? parsed : [parsed]
}

const panelHandshakeFiles = Object.freeze({
  'plan-sync-success': Object.freeze({
    readyFile: panelPlanSyncReadyFile,
    continueFile: panelPlanSyncContinueFile,
    continueName: 'p4-panel-plan-sync-continue.json'
  }),
  'dirty-conflict': Object.freeze({
    readyFile: panelDirtyConflictReadyFile,
    continueFile: panelDirtyConflictContinueFile,
    continueName: 'p4-panel-dirty-conflict-continue.json'
  })
})

async function optionalPanelHandshake({ port, stage, snapshotId, conflictCode }) {
  const enabled = String(process.env.SKILL_GRAFT_P4_PANEL_HANDSHAKE || '') === '1'
  const files = panelHandshakeFiles[stage]
  assert.ok(files, `unknown panel handshake stage: ${stage}`)
  const ready = {
    schemaVersion: 1,
    runId: context.runId,
    status: 'ready',
    stage,
    transport: 'http://127.0.0.1',
    port,
    bootstrapPath: '/workspaces',
    commandPath: '/api/command',
    worktreeRelative: 'probe/p4-worktree',
    snapshotId,
    ...(conflictCode ? { conflictCode } : {}),
    continueFile: files.continueName,
    handshakeRequired: enabled
  }
  writeBoundedJson(files.readyFile, ready, { locators: protectedSet.concat(context.runRoot) })
  if (!enabled) return false
  const rawTimeout = String(process.env.SKILL_GRAFT_P4_PANEL_TIMEOUT_MS || '600000')
  assert.match(rawTimeout, /^\d{4,7}$/)
  const timeoutMs = Number(rawTimeout)
  assert.equal(Number.isSafeInteger(timeoutMs) && timeoutMs >= 10_000 && timeoutMs <= 600_000, true)
  const deadline = Date.now() + timeoutMs
  do {
    if (fs.existsSync(files.continueFile)) {
      assertPlainFile(files.continueFile, `${stage} panel continuation file`)
      const value = readJson(files.continueFile)
      assert.deepEqual(value, { schemaVersion: 1, runId: context.runId, status: 'continue', stage })
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  } while (Date.now() < deadline)
  throw new Error(`${stage} panel handshake timed out without an exact continuation proof`)
}

test('installed Local P4 completes real Windows setup, panel-ready Application flow, A/B lifecycle, WAL recovery, uninstall preservation, and explicit purge', {
  timeout: 60 * 60 * 1000
}, async (t) => {
  const tracker = new ProcessTracker({ runId: context.runId })
  const upgradeCutTracker = new ProcessTracker({ runId: context.runId })
  const baselineExternal = readExternalEnvironmentSnapshot()
  for (const name of ['SKILL_GRAFT_HOME', 'HUB_ROOT', 'HUB_API_PORT']) {
    assert.equal(baselineExternal[name].exists, false, `HKCU ${name} must be absent before installed-real`)
  }
  const userPath = baselineExternal.Path.exists ? baselineExternal.Path.value : ''
  for (const command of ['sg', 'ozdqp-hub']) {
    assert.deepEqual(findCommandsOnPath(command, userPath, process.env), [], `HKCU Path must not expose foreign ${command}`)
  }
  assert.equal(taskState(taskName).exists, false, 'unique P4 scheduled task must be absent before setup')

  const protectedBaselines = captureProtectedRootBaselines(protectedSet, context.homeRoot)
  assert.equal(
    protectedBaselines.find((baseline) => samePath(baseline.root, sourceRoot))?.kind,
    'git',
    'the source worktree must have an exact protected Git baseline'
  )
  const fixedPortBefore = await portListening(18765)
  const port = await getAvailableLoopbackPort({ forbidden: [18765, 3080] })
  assert.equal(await portListening(port), false, 'selected port must be free before setup')

  let expectedExternal = null
  let normalCompletion = false
  t.after(async () => {
    const errors = []
    try {
      upgradeCutTracker.trackWindowsOwnedPids({ commandIncludes: context.runId, pathIncludesAny: [context.runRoot] })
      await upgradeCutTracker.stopAll({ graceMs: 2_000 })
    } catch (error) { errors.push(error) }
    try {
      tracker.trackWindowsOwnedPids({ commandIncludes: context.runId, pathIncludesAny: [context.runRoot] })
      await tracker.stopAll({ graceMs: 2_000 })
    } catch (error) { errors.push(error) }
    try { restoreOwnedExternalState(baselineExternal, expectedExternal) } catch (error) { errors.push(error) }
    try { assertExternalEnvironmentEqual(readExternalEnvironmentSnapshot(), baselineExternal, 'after-hook cleanup') } catch (error) { errors.push(error) }
    try {
      const task = taskState(taskName)
      if (task.exists) errors.push(new Error('after-hook cleanup left the unique scheduled task'))
    } catch (error) { errors.push(error) }
    try {
      if (!await waitForPort(port, false, 10_000)) errors.push(new Error('after-hook cleanup left the selected port listening'))
    } catch (error) { errors.push(error) }
    try { assertProtectedRootBaselines(protectedBaselines, context.homeRoot) } catch (error) { errors.push(error) }
    if (errors.length > 0) throw new AggregateError(errors, normalCompletion
      ? 'P4 installed-real post-success cleanup regression'
      : 'P4 installed-real preserved its failed run root but external cleanup was incomplete')
  })

  for (const directory of [npmCache, npmPrefix, appData, localAppData, tempRoot, xdgRoot, dshHome]) {
    ensureOwnedDirectory(context, directory, 'home', 'isolated HOME directory')
  }
  fs.mkdirSync(path.dirname(fakeCodexModule), { recursive: true })
  const fakeSessionId = `${sha256Bytes(context.runId).slice(0, 8)}-0000-4000-8000-${sha256Bytes(`session:${context.runId}`).slice(0, 12)}`
  writeText(fakeCodexModule, [
    "const fs = require('node:fs')",
    "const path = require('node:path')",
    'const args = process.argv.slice(2)',
    "const index = args.indexOf('-o')",
    "if (index < 0 || !args[index + 1]) { process.stderr.write('missing output contract\\n'); process.exit(2) }",
    'const output = path.resolve(args[index + 1])',
    'fs.mkdirSync(path.dirname(output), { recursive: true })',
    "fs.readFileSync(0, 'utf8')",
    "fs.writeFileSync(output, 'acceptance summary: P4 SessionStart and installed-hook compatibility only; not P5 Runner acceptance\\n', 'utf8')",
    `process.stdout.write('session id: ${fakeSessionId}\\n')`,
    ''
  ].join('\n'))
  writeText(fakeCodexCommand, [
    '@echo off',
    `"${process.execPath}" "%~dp0node_modules\\@openai\\codex\\bin\\codex.js" %*`,
    ''
  ].join('\r\n'))
  assertPlainFile(fakeCodexModule, 'fake Codex module')
  assertPlainFile(fakeCodexCommand, 'fake Codex command')

  const sanitized = withoutHostCommandBins(process.env.PATH || '', process.env)
  const runtimeBin = path.dirname(process.execPath)
  assert.deepEqual(findCommandsOnPath('sg', sanitized.value, process.env), [])
  assert.deepEqual(findCommandsOnPath('ozdqp-hub', sanitized.value, process.env), [])
  const baseEnv = createIsolatedGitEnvironment(process.env, context.homeRoot)
  deleteEnvironmentNames(baseEnv, (name) => /^DSH_/.test(name)
    || /^SG_SKIP_/.test(name)
    || ['NODE_AUTH_TOKEN', 'NPM_TOKEN', 'GITHUB_TOKEN'].includes(name))
  Object.assign(baseEnv, {
    HOME: context.homeRoot,
    USERPROFILE: context.homeRoot,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    TEMP: tempRoot,
    TMP: tempRoot,
    XDG_CONFIG_HOME: xdgRoot,
    DSH_HOME: dshHome,
    SKILL_GRAFT_HOME: context.hubDataRoot,
    HUB_ROOT: context.hubDataRoot,
    HUB_API_PORT: String(port),
    SG_INSTALL_DIR: installDir,
    SG_TASK_NAME: taskName,
    HUB_SPAWN_CODEX: '1',
    HUB_WAIT_TIMEOUT_MS: '120000',
    SKILL_GRAFT_INVOCATION_TRACE: '0',
    SKILL_GRAFT_RUN_ID: context.runId,
    SKILL_GRAFT_E2E_ROOT: context.runRoot,
    npm_config_cache: npmCache,
    NPM_CONFIG_CACHE: npmCache,
    npm_config_prefix: npmPrefix,
    NPM_CONFIG_PREFIX: npmPrefix,
    npm_config_userconfig: path.join(context.homeRoot, '.npmrc'),
    NPM_CONFIG_USERCONFIG: path.join(context.homeRoot, '.npmrc'),
    PATH: [fakeEditorBin, runtimeBin, sanitized.value].filter(Boolean).join(path.delimiter)
  })
  const nodeProbe = spawnSync('node', ['-p', 'process.execPath'], { env: baseEnv, encoding: 'utf8', windowsHide: true })
  assert.equal(nodeProbe.status, 0)
  assert.equal(samePath(String(nodeProbe.stdout || '').trim(), process.execPath), true, 'isolated PATH must resolve the test Node runtime')
  assert.equal(spawnSync('git', ['--version'], { env: baseEnv, encoding: 'utf8', windowsHide: true }).status, 0)
  assert.deepEqual(findCommandsOnPath('sg', baseEnv.PATH, baseEnv), [])

  const packARoot = ensureOwnedDirectory(context, path.join(context.logsRoot, 'pack-a'), 'logs', 'A pack root')
  const packedA = parseNpmPack(runNpm([
    'pack', sourceRoot, '--json', '--ignore-scripts', '--pack-destination', packARoot
  ], context.appRoot, baseEnv), 'npm pack A')
  const tarballA = path.resolve(packARoot, packedA.filename)
  assertPlainFile(tarballA, 'A tarball')
  const packEvidenceA = npmPackEvidence(packedA, tarballA, 'A pack')
  installTarball(context.appRoot, tarballA, baseEnv, 'install A tarball outside source')
  assertPlainFile(cliA, 'installed package A sg.cmd')
  assertPlainFile(path.join(packageARoot, 'dist', 'control', 'cli.js'), 'installed package A CLI')
  assertPlainFile(path.join(packageARoot, 'server', 'index.mjs'), 'installed package A server')
  assertPlainFile(path.join(packageARoot, 'web', 'index.html'), 'installed package A panel')
  assert.deepEqual(fs.readdirSync(path.join(packageARoot, 'skills')).sort(), ['README.md'])
  const versionA = packageVersion(packageARoot)
  assert.equal(versionA, packedA.version)
  const publicRuntimeHashA = publicRuntimeHash(packageAPublicRuntime)

  const stagingRoot = assertOwnedPath(context, path.join(context.logsRoot, 'package-b-staging'), 'logs', 'B staging')
  const stagedB = extractTarball(tarballA, stagingRoot, baseEnv)
  const stagedPackageJson = readJson(path.join(stagedB, 'package.json'))
  const versionB = bumpedVersion(versionA)
  stagedPackageJson.version = versionB
  writeText(path.join(stagedB, 'package.json'), `${JSON.stringify(stagedPackageJson, null, 2)}\n`)
  const stagedPublicRuntime = path.join(stagedB, publicRuntimeRelative)
  assert.equal(publicRuntimeHash(stagedPublicRuntime), publicRuntimeHashA, 'extracted A public runtime baseline')
  const publicRuntimeBComment = `\n<!-- P4 installed-real public runtime B identity sha256:${sha256Bytes(`public-runtime-b:${context.runId}`)} -->\n`
  assertLocatorFree(publicRuntimeBComment, [context.runRoot, sourceRoot, ...protectedRoots], 'B public runtime identity')
  fs.writeFileSync(stagedPublicRuntime, Buffer.concat([
    fs.readFileSync(stagedPublicRuntime),
    Buffer.from(publicRuntimeBComment, 'utf8')
  ]))
  const publicRuntimeHashB = publicRuntimeHash(stagedPublicRuntime)
  assert.notEqual(publicRuntimeHashB, publicRuntimeHashA, 'B public runtime must differ from A')
  writeText(path.join(stagedB, 'web', 'p4-upgrade-identity.txt'), `P4 covered package identity ${sha256Bytes(context.runId)}\n`)
  const packBRoot = ensureOwnedDirectory(context, path.join(context.logsRoot, 'pack-b'), 'logs', 'B pack root')
  const packedB = parseNpmPack(runNpm([
    'pack', stagedB, '--json', '--ignore-scripts', '--pack-destination', packBRoot
  ], context.appRoot, baseEnv), 'npm pack B')
  const tarballB = path.resolve(packBRoot, packedB.filename)
  assertPlainFile(tarballB, 'B tarball')
  const packEvidenceB = npmPackEvidence(packedB, tarballB, 'B pack')
  assert.equal(packedB.version, versionB)
  assert.notEqual(sha256File(tarballB), sha256File(tarballA))
  installTarball(hostBRoot, tarballB, baseEnv, 'install B tarball outside source')
  assertPlainFile(cliB, 'installed package B sg.cmd')
  assertPlainFile(path.join(packageBRoot, 'web', 'p4-upgrade-identity.txt'), 'B identity proof')
  assert.equal(packageVersion(packageBRoot), versionB)
  assert.equal(publicRuntimeHash(packageBPublicRuntime), publicRuntimeHashB, 'packed B public runtime hash')

  const setupDry = lifecycle(cliA, ['setup', '--dry-run', '--json'], baseEnv, 'A setup dry-run')
  assert.equal(setupDry.ok, true, JSON.stringify(setupDry.issues || []))
  assert.equal(setupDry.dryRun, true)
  assertExternalEnvironmentEqual(readExternalEnvironmentSnapshot(), baselineExternal, 'setup dry-run')
  assert.equal(taskState(taskName).exists, false)

  expectedExternal = { port, silentVbs: path.join(installDir, 'silent-run.vbs') }
  const setupA = lifecycle(cliA, ['setup', '--json'], baseEnv, 'A setup')
  assert.equal(setupA.ok, true, JSON.stringify(setupA.issues || []))
  assert.equal(setupA.dryRun, false)
  assert.deepEqual(setupA.steps.filter((step) => ['path', 'env', 'task', 'daemon'].includes(step.id)).map((step) => step.skipped === true), [false, false, false, false])
  strictDoctor(setupA.doctor, versionA, 'A setup doctor')
  const manifestAInitial = readJson(path.join(installDir, 'install.json'))
  expectedExternal = { port, silentVbs: manifestAInitial.owned.task.launcher }
  assert.deepEqual(manifestAInitial.features, { path: true, task: true, daemon: true })
  assert.equal(manifestAInitial.packageVersion, versionA)
  assert.equal(samePath(manifestAInitial.packageRoot, packageARoot), true)
  assert.equal(samePath(manifestAInitial.nodePath, process.execPath), true, 'setup must freeze the test Node runtime')
  assertOwnedExternalState(baselineExternal, port, manifestAInitial.owned.task.launcher)
  await waitForDaemon(cliA, baseEnv, tracker, versionA, 'A setup')
  assert.equal(await waitForPort(port, true), true)
  assertDataPublicRuntime(packageAPublicRuntime, publicRuntimeHashA, 'A setup')

  const setupAReplay = lifecycle(cliA, ['setup', '--json'], baseEnv, 'A setup rerun')
  assert.equal(setupAReplay.ok, true, JSON.stringify(setupAReplay.issues || []))
  strictDoctor(setupAReplay.doctor, versionA, 'A setup rerun doctor')
  assert.deepEqual(readJson(path.join(installDir, 'install.json')), manifestAInitial)
  assertDataPublicRuntime(packageAPublicRuntime, publicRuntimeHashA, 'A setup rerun')

  const registryAfterSetup = readExternalEnvironmentSnapshot()
  const shellEnv = { ...baseEnv, PATH: [registryAfterSetup.Path.value, sanitized.value].filter(Boolean).join(path.delimiter) }
  Object.assign(shellEnv, {
    SKILL_GRAFT_HOME: registryAfterSetup.SKILL_GRAFT_HOME.value,
    HUB_ROOT: registryAfterSetup.HUB_ROOT.value,
    HUB_API_PORT: registryAfterSetup.HUB_API_PORT.value
  })
  const fromPath = findCommandsOnPath('sg', shellEnv.PATH, shellEnv)
  assert.ok(fromPath.length >= 1)
  assert.equal(samePath(path.dirname(fromPath[0]), installBin), true, 'new shell must resolve the owned bin first')
  assert.equal(
    fromPath.some((candidate) => samePath(candidate, path.join(installBin, 'sg.cmd'))),
    true,
    'new shell must expose the owned Windows shim'
  )
  const pathDoctor = parseJsonResult(spawnSync('cmd.exe', ['/d', '/s', '/v:off', '/c', 'call sg doctor --json'], {
    cwd: context.appRoot,
    env: shellEnv,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: outputLimit
  }), 'new-shell PATH doctor')
  strictDoctor(pathDoctor, versionA, 'new-shell PATH doctor')

  writeText(privateSkillFile, '# P4 private skill A\n\nPrivate bytes must survive lifecycle operations.\n')
  for (const [relative, content] of [
    ['overlay/scan-roots.txt', `${context.probeRoot}\n`],
    ['overlay/attached-worktrees.txt', ''],
    ['overlay/do-not-auto-attach.txt', '']
  ]) writeText(path.join(context.hubDataRoot, ...relative.split('/')), content)
  const snapshotA = typed(cliA, ['snapshot', 'create'], baseEnv, 'p4-snapshot-a').data.snapshot
  assert.match(snapshotA.snapshotId, /^sha256:[a-f0-9]{64}$/)
  assert.equal(snapshotA.files.some((entry) => entry.path === privateSkillSnapshotPath), true)
  const migrationPlan = typed(cliA, [
    'migrate-state', '--dry-run'
  ], baseEnv, 'p4-state-migrate-dry').data
  assert.equal(migrationPlan.status, 'planned')
  assert.equal(migrationPlan.plan.targetState.librarySnapshots.includes(snapshotA.snapshotId), true)
  const migrationCommit = typed(cliA, [
    'migrate-state', '--commit', '--plan-hash', migrationPlan.plan.planHash
  ], baseEnv, 'p4-state-migrate-commit').data
  assert.equal(migrationCommit.status, 'committed')
  assert.equal(migrationCommit.state.schemaVersion, 2)

  const fixture = createRepository(baseEnv)
  configureInstalledHook(fixture, packageARoot, baseEnv)
  const sessionsBefore = typed(cliA, ['session', 'list'], baseEnv, 'p4-sessions-before-hook').data.sessions
  const beforeIds = new Set(sessionsBefore.map((session) => session.id))
  runGit(fixture.worktree, ['checkout', '--detach', fixture.commitA], baseEnv, 'installed post-checkout SessionStart')
  const hookSession = await waitForHookSession(cliA, baseEnv, beforeIds)
  assert.equal(hookSession.kind, 'attach')
  assert.equal(hookSession.status, 'waiting')
  assert.equal(hookSession.exitCode, 0)
  assert.match(hookSession.summary || '', /P4 SessionStart and installed-hook compatibility only/)
  assert.equal(hookSession.continuationToken, fakeSessionId)

  const claimed = typed(cliA, [
    'claim', '--worktree', fixture.worktree,
    '--snapshot', snapshotA.snapshotId,
    '--session-id', hookSession.id,
    '--skill', privateSkill
  ], baseEnv, 'p4-claim-a').data
  assert.equal(claimed.changed, true)
  assert.equal(claimed.pin.claimState, 'claimed')

  const panel = await panelCapability(port)
  const materializedPrivateSkill = path.join(fixture.worktree, '.agents', 'skills', privateSkill, 'SKILL.md')
  assert.equal(fs.existsSync(materializedPrivateSkill), false)
  const planSyncPanelHandshakeUsed = await optionalPanelHandshake({
    port,
    stage: 'plan-sync-success',
    snapshotId: snapshotA.snapshotId
  })
  let syncA
  if (planSyncPanelHandshakeUsed) {
    assert.equal(fs.readFileSync(materializedPrivateSkill, 'utf8'), fs.readFileSync(privateSkillFile, 'utf8'))
    const browserPin = await httpCommand(panel, {
      kind: 'getPin', worktree: fixture.worktree, requestId: `p4-http-browser-pin-a-${context.runId}`
    }, 'HTTP browser pin A')
    assert.equal(browserPin.data.pin.materializedSnapshot, snapshotA.snapshotId)
    const completionPlanA = await httpCommand(panel, {
      kind: 'planSync', worktree: fixture.worktree, requestId: `p4-http-completion-plan-a-${context.runId}`
    }, 'HTTP completion plan A')
    assert.equal(completionPlanA.data.status, 'planned')
    assert.equal(completionPlanA.data.plan.executable, true)
    syncA = await httpCommand(panel, {
      kind: 'sync', worktree: fixture.worktree, planHash: completionPlanA.data.plan.planHash,
      sessionId: hookSession.id, requestId: `p4-http-completion-sync-a-${context.runId}`
    }, 'HTTP completion sync A')
    assert.equal(syncA.data.changed, false)
    assert.equal(syncA.data.sessionCompleted, true)
  } else {
    const planA = await httpCommand(panel, {
      kind: 'planSync', worktree: fixture.worktree, requestId: `p4-http-plan-a-${context.runId}`
    }, 'HTTP plan A')
    assert.equal(planA.data.status, 'planned')
    assert.equal(planA.data.plan.executable, true)
    syncA = await httpCommand(panel, {
      kind: 'sync', worktree: fixture.worktree, planHash: planA.data.plan.planHash,
      sessionId: hookSession.id, requestId: `p4-http-sync-a-${context.runId}`
    }, 'HTTP sync A')
    assert.equal(syncA.data.changed, true)
    assert.equal(syncA.data.sessionCompleted, true)
  }
  assert.equal(fs.readFileSync(materializedPrivateSkill, 'utf8'), fs.readFileSync(privateSkillFile, 'utf8'))

  while (Date.now() <= Date.parse(snapshotA.createdAt)) await new Promise((resolve) => setTimeout(resolve, 10))
  writeText(privateSkillFile, '# P4 private skill B\n\nUpgraded private bytes must survive uninstall.\n')
  const snapshotB = typed(cliA, ['snapshot', 'create'], baseEnv, 'p4-snapshot-b').data.snapshot
  assert.match(snapshotB.snapshotId, /^sha256:[a-f0-9]{64}$/)
  assert.notEqual(snapshotB.snapshotId, snapshotA.snapshotId)
  const pinB = await httpCommand(panel, {
    kind: 'setPin', worktree: fixture.worktree, snapshotId: snapshotB.snapshotId,
    selectedSkills: [privateSkill], requestId: `p4-http-pin-b-${context.runId}`
  }, 'HTTP pin B')
  assert.equal(pinB.data.changed, true)
  const planB = await httpCommand(panel, {
    kind: 'planSync', worktree: fixture.worktree, requestId: `p4-http-plan-b-${context.runId}`
  }, 'HTTP plan B')
  assert.equal(planB.data.plan.executable, true)
  const syncB = await httpCommand(panel, {
    kind: 'sync', worktree: fixture.worktree, planHash: planB.data.plan.planHash,
    requestId: `p4-http-sync-b-${context.runId}`
  }, 'HTTP sync B')
  assert.equal(syncB.data.changed, true)
  assert.equal(syncB.data.pin.materializedSnapshot, snapshotB.snapshotId)

  const managedOverride = path.join(fixture.worktree, 'AGENTS.override.md')
  const managedBytes = fs.readFileSync(managedOverride)
  fs.writeFileSync(managedOverride, '# P4 deliberate local conflict\n')
  const conflictPlan = await httpCommand(panel, {
    kind: 'planSync', worktree: fixture.worktree, requestId: `p4-http-conflict-plan-${context.runId}`
  }, 'HTTP conflict plan')
  assert.equal(conflictPlan.data.status, 'conflict')
  assert.equal(conflictPlan.data.plan.executable, false)
  assert.equal(conflictPlan.data.plan.operations.some((operation) => operation.conflict?.kind === 'dirty'), true)
  const conflictSync = await httpCommand(panel, {
    kind: 'sync', worktree: fixture.worktree, planHash: conflictPlan.data.plan.planHash,
    requestId: `p4-http-conflict-sync-${context.runId}`
  }, 'HTTP conflict sync', false)
  assert.equal(conflictSync.error?.code, 'CONFLICT_DIRTY')
  const dirtyConflictPanelHandshakeUsed = await optionalPanelHandshake({
    port,
    stage: 'dirty-conflict',
    snapshotId: snapshotB.snapshotId,
    conflictCode: conflictSync.error.code
  })
  assert.equal(fs.readFileSync(managedOverride, 'utf8'), '# P4 deliberate local conflict\n')
  const conflictHistory = await httpCommand(panel, {
    kind: 'listHistory', limit: 100, requestId: `p4-http-conflict-history-${context.runId}`
  }, 'HTTP conflict history')
  assert.equal(Array.isArray(conflictHistory.data.records), true)
  assert.ok(conflictHistory.data.records.length > 0)
  fs.writeFileSync(managedOverride, managedBytes)
  const recoveryPlan = await httpCommand(panel, {
    kind: 'planSync', worktree: fixture.worktree, requestId: `p4-http-recovery-plan-${context.runId}`
  }, 'HTTP recovery plan')
  const recoverySync = await httpCommand(panel, {
    kind: 'sync', worktree: fixture.worktree, planHash: recoveryPlan.data.plan.planHash,
    requestId: `p4-http-recovery-sync-${context.runId}`
  }, 'HTTP recovery sync')
  assert.equal(recoverySync.data.changed, false)
  const history = await httpCommand(panel, {
    kind: 'listHistory', limit: 100, requestId: `p4-http-history-${context.runId}`
  }, 'HTTP history')
  assert.equal(Array.isArray(history.data.records), true)
  assert.ok(history.data.records.length > 0)
  const panelHandshakeUsed = planSyncPanelHandshakeUsed && dirtyConflictPanelHandshakeUsed
  const httpPin = await httpCommand(panel, {
    kind: 'getPin', worktree: fixture.worktree, requestId: `p4-http-get-pin-${context.runId}`
  }, 'HTTP get pin')
  assert.equal(httpPin.data.pin.materializedSnapshot, snapshotB.snapshotId)

  const privateHash = `sha256:${sha256File(privateSkillFile)}`
  const copyHash = `sha256:${sha256File(path.join(fixture.worktree, '.agents', 'skills', privateSkill, 'SKILL.md'))}`
  const worktreeBeforeLifecycle = treeManifest(fixture.worktree)
  const libraryRoot = path.join(context.hubDataRoot, 'skill-review', 'library')
  const libraryBeforeLifecycle = treeManifest(libraryRoot)
  const snapshotManifestFiles = snapshotA.files.concat(snapshotB.files)
    .filter((entry) => entry.path === privateSkillSnapshotPath)
  assert.equal(snapshotManifestFiles.length, 2)

  const uninstallA = lifecycle(cliA, ['uninstall', '--json'], baseEnv, 'A uninstall')
  assert.equal(uninstallA.ok, true, JSON.stringify(uninstallA.issues || []))
  assert.equal(uninstallA.stopped && uninstallA.taskRemoved && uninstallA.pathRemoved && uninstallA.filesRemoved, true)
  assert.equal(await waitForPort(port, false), true)
  assertExternalClean(baselineExternal)
  assert.equal(`sha256:${sha256File(privateSkillFile)}`, privateHash)
  assert.equal(`sha256:${sha256File(path.join(fixture.worktree, '.agents', 'skills', privateSkill, 'SKILL.md'))}`, copyHash)
  assert.deepEqual(treeManifest(fixture.worktree), worktreeBeforeLifecycle)
  assert.deepEqual(treeManifest(libraryRoot), libraryBeforeLifecycle)
  assert.equal(readJson(path.join(context.hubDataRoot, '.skill-graft-data-root.json')).activeInstallId, null)
  assertDataPublicRuntime(packageAPublicRuntime, publicRuntimeHashA, 'A uninstall preservation')

  const reinstallB = lifecycle(cliB, ['setup', '--json'], baseEnv, 'B reinstall')
  assert.equal(reinstallB.ok, true, JSON.stringify(reinstallB.issues || []))
  strictDoctor(reinstallB.doctor, versionB, 'B reinstall doctor')
  await waitForDaemon(cliB, baseEnv, tracker, versionB, 'B reinstall')
  assertDataPublicRuntime(packageBPublicRuntime, publicRuntimeHashB, 'B reinstall')
  assert.equal(`sha256:${sha256File(privateSkillFile)}`, privateHash)
  assert.deepEqual(treeManifest(fixture.worktree), worktreeBeforeLifecycle)
  assert.deepEqual(treeManifest(libraryRoot), libraryBeforeLifecycle)
  const reinstallBReplay = lifecycle(cliB, ['setup', '--json'], baseEnv, 'B reinstall rerun')
  assert.equal(reinstallBReplay.ok, true)
  strictDoctor(reinstallBReplay.doctor, versionB, 'B reinstall rerun doctor')
  assertDataPublicRuntime(packageBPublicRuntime, publicRuntimeHashB, 'B reinstall rerun')

  const uninstallBReinstall = lifecycle(cliB, ['uninstall', '--json'], baseEnv, 'B reinstall uninstall')
  assert.equal(uninstallBReinstall.ok, true, JSON.stringify(uninstallBReinstall.issues || []))
  assertExternalClean(baselineExternal)
  assertDataPublicRuntime(packageBPublicRuntime, publicRuntimeHashB, 'B reinstall uninstall preservation')
  assert.equal(`sha256:${sha256File(privateSkillFile)}`, privateHash)
  assert.deepEqual(treeManifest(libraryRoot), libraryBeforeLifecycle)

  const setupAFinal = lifecycle(cliA, ['setup', '--json'], baseEnv, 'A setup before upgrade')
  assert.equal(setupAFinal.ok, true, JSON.stringify(setupAFinal.issues || []))
  strictDoctor(setupAFinal.doctor, versionA, 'A setup before upgrade doctor')
  await waitForDaemon(cliA, baseEnv, tracker, versionA, 'A before upgrade')
  assertDataPublicRuntime(packageAPublicRuntime, publicRuntimeHashA, 'A setup before upgrade')
  const manifestA = readJson(path.join(installDir, 'install.json'))
  const markerA = readJson(path.join(context.hubDataRoot, '.skill-graft-data-root.json'))

  const upgradeDry = lifecycle(cliB, ['upgrade', '--dry-run', '--json'], baseEnv, 'B upgrade dry-run')
  assert.equal(upgradeDry.ok, true, JSON.stringify(upgradeDry.issues || []))
  assert.equal(upgradeDry.status, 'planned')
  assert.equal(upgradeDry.fromVersion, versionA)
  assert.equal(upgradeDry.toVersion, versionB)
  assert.equal(readJson(path.join(installDir, 'install.json')).packageVersion, versionA)
  assertDataPublicRuntime(packageAPublicRuntime, publicRuntimeHashA, 'B upgrade dry-run')

  assert.equal(fs.existsSync(lifecycleWal), false, 'upgrade cut WAL must start absent')
  assert.equal(fs.existsSync(lifecycleLock), false, 'upgrade cut owner must start absent')
  assert.equal(fs.existsSync(upgradeCutReadyFile), false, 'upgrade cut ready marker must start absent')
  const upgradeCutWorkerFile = path.join(sourceRoot, 'test', 'support', 'p4-lifecycle-upgrade-cut-worker.mjs')
  assertPlainFile(upgradeCutWorkerFile, 'upgrade cut worker')
  const workerState = { error: null }
  const upgradeCutWorker = upgradeCutTracker.track(spawn(process.execPath, [
    upgradeCutWorkerFile,
    '--run-id', context.runId,
    '--run-root', context.runRoot,
    '--package-root', packageBRoot,
    '--install-dir', installDir,
    '--data-root', context.hubDataRoot,
    '--wal', lifecycleWal,
    '--ready', upgradeCutReadyFile
  ], {
    cwd: context.appRoot,
    env: baseEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  }))
  upgradeCutWorker.once('error', (error) => { workerState.error = error })
  const upgradeCutStdout = collectBoundedChildOutput(upgradeCutWorker.stdout)
  const upgradeCutStderr = collectBoundedChildOutput(upgradeCutWorker.stderr)
  assert.equal(Number.isInteger(upgradeCutWorker.pid) && upgradeCutWorker.pid > 0, true, 'upgrade cut worker must spawn')
  upgradeCutTracker.trackPid(upgradeCutWorker.pid, { commandIncludes: context.runId })

  const cutReady = await waitForUpgradeCutReady(
    upgradeCutWorker,
    workerState,
    upgradeCutReadyFile,
    upgradeCutStdout,
    upgradeCutStderr
  )
  assert.deepEqual(Object.keys(cutReady.value), [
    'schemaVersion', 'runId', 'workerPid', 'phase', 'walId', 'walBytes', 'walSha256'
  ])
  assert.equal(cutReady.value.schemaVersion, 1)
  assert.equal(cutReady.value.runId, context.runId)
  assert.equal(cutReady.value.workerPid, upgradeCutWorker.pid)
  assert.equal(cutReady.value.phase, 'switched')
  assert.match(cutReady.value.walId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  assert.equal(Number.isSafeInteger(cutReady.value.walBytes) && cutReady.value.walBytes > 0, true)
  assert.match(cutReady.value.walSha256, /^sha256:[a-f0-9]{64}$/)
  assertLocatorFree(cutReady.value, protectedSet.concat(context.runRoot), 'upgrade cut ready marker')

  const cutWal = readBoundedCanonicalJson(lifecycleWal, 1024 * 1024, 'product-written switched lifecycle WAL')
  assert.equal(cutWal.value.schemaVersion, 1)
  assert.equal(cutWal.value.operation, 'upgrade')
  assert.equal(cutWal.value.phase, 'switched')
  assert.equal(samePath(cutWal.value.installDir, installDir), true)
  assert.equal(cutWal.value.walId, cutReady.value.walId)
  assert.match(cutWal.value.lockToken, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  assert.equal(cutWal.bytes.length, cutReady.value.walBytes)
  assert.equal(cutWal.sha256, cutReady.value.walSha256)
  assert.deepEqual(cutWal.value.oldManifest, manifestA)
  assert.deepEqual(cutWal.value.oldMarker, markerA)
  assert.equal(cutWal.value.oldDaemonRunning, true)
  assert.equal(samePath(cutWal.value.newManifest.packageRoot, packageBRoot), true)
  assert.equal(cutWal.value.newManifest.packageVersion, versionB)
  assert.equal(cutWal.value.newManifest.installId, manifestA.installId)
  assert.equal(cutWal.value.newManifest.dataRootId, manifestA.dataRootId)
  assert.notEqual(cutWal.value.newManifest.packageSha256, manifestA.packageSha256)
  assert.equal(cutWal.value.newMarker.activeInstallId, cutWal.value.newManifest.installId)

  const switchedManifest = readBoundedCanonicalJson(
    path.join(installDir, 'install.json'),
    1024 * 1024,
    'switched install manifest'
  )
  const switchedMarker = readBoundedCanonicalJson(
    path.join(context.hubDataRoot, '.skill-graft-data-root.json'),
    1024 * 1024,
    'switched data-root marker'
  )
  assert.deepEqual(switchedManifest.value, cutWal.value.newManifest, 'WAL target manifest must be the product-switched bytes')
  assert.deepEqual(switchedMarker.value, cutWal.value.newMarker, 'WAL target marker must be the product-switched bytes')
  assertDataPublicRuntime(packageBPublicRuntime, publicRuntimeHashB, 'product-written switched WAL')

  const cutOwner = readBoundedCanonicalJson(lifecycleLock, 64 * 1024, 'product-written lifecycle owner')
  assert.deepEqual(Object.keys(cutOwner.value), [
    'schemaVersion', 'token', 'pid', 'operation', 'installDir', 'createdAt'
  ])
  assert.equal(cutOwner.value.schemaVersion, 1)
  assert.equal(cutOwner.value.token, cutWal.value.lockToken)
  assert.equal(cutOwner.value.pid, upgradeCutWorker.pid)
  assert.equal(cutOwner.value.operation, 'upgrade')
  assert.equal(samePath(cutOwner.value.installDir, installDir), true)
  assert.equal(Number.isFinite(Date.parse(cutOwner.value.createdAt)), true)

  const applicationOwner = readBoundedCanonicalJson(
    applicationWriterOwnerFile,
    64 * 1024,
    'product-written application writer owner'
  )
  assert.deepEqual(Object.keys(applicationOwner.value), [
    'schemaVersion',
    'scope',
    'lockKey',
    'ownerToken',
    'hostId',
    'pid',
    'processIdentity',
    'command',
    'requestId',
    'acquiredAt',
    'heartbeatAt',
    'leaseUntil'
  ])
  assert.equal(applicationOwner.value.schemaVersion, 1)
  assert.equal(applicationOwner.value.scope, 'hub-global')
  assert.equal(applicationOwner.value.lockKey, 'hub-global')
  assert.match(applicationOwner.value.ownerToken, /^[A-Za-z0-9._-]{16,64}$/)
  assert.equal(applicationOwner.value.hostId, 'lifecycle')
  assert.equal(applicationOwner.value.pid, upgradeCutWorker.pid)
  assert.match(applicationOwner.value.processIdentity, /^windows:\d+$/)
  assert.equal(applicationOwner.value.command, 'migrateState')
  assert.match(applicationOwner.value.requestId, /^lifecycle-[A-Za-z0-9._-]+$/)
  assert.equal(Number.isFinite(Date.parse(applicationOwner.value.acquiredAt)), true)
  assert.equal(Number.isFinite(Date.parse(applicationOwner.value.heartbeatAt)), true)
  const applicationLeaseUntil = Date.parse(applicationOwner.value.leaseUntil)
  assert.equal(Number.isFinite(applicationLeaseUntil), true)
  assert.equal(applicationLeaseUntil > Date.now(), true, 'application writer lease must be live at the cut')
  assert.equal(
    applicationLeaseUntil <= Date.now() + 35_000,
    true,
    'application writer lease must remain inside the bounded recovery window'
  )
  assert.equal(upgradeCutWorker.exitCode, null, 'upgrade cut worker must still own the switched WAL')
  assert.equal(upgradeCutWorker.signalCode, null, 'upgrade cut worker must still be parked')

  await upgradeCutTracker.stopAll({ graceMs: 2_000 })
  await waitForChildExit(upgradeCutWorker)
  const staleWal = readBoundedCanonicalJson(lifecycleWal, 1024 * 1024, 'stale switched lifecycle WAL')
  const staleOwner = readBoundedCanonicalJson(lifecycleLock, 64 * 1024, 'stale lifecycle owner')
  assert.equal(staleWal.bytes.equals(cutWal.bytes), true, 'owned process-tree termination must not edit the product WAL')
  assert.equal(staleOwner.bytes.equals(cutOwner.bytes), true, 'owned process-tree termination must not edit the product owner')
  assert.equal(staleOwner.value.pid, upgradeCutWorker.pid)
  const staleApplicationOwner = readBoundedCanonicalJson(
    applicationWriterOwnerFile,
    64 * 1024,
    'stale application writer owner'
  )
  assert.equal(
    staleApplicationOwner.bytes.equals(applicationOwner.bytes),
    true,
    'owned process-tree termination must not edit the application owner'
  )
  await waitForKilledApplicationWriterLeaseExpiry(
    applicationWriterOwnerFile,
    applicationOwner,
    upgradeCutWorker.pid
  )

  const recoveredA = lifecycle(cliA, ['setup', '--json'], baseEnv, 'A process WAL recovery')
  assert.equal(recoveredA.ok, true, JSON.stringify(recoveredA.issues || []))
  assert.equal(fs.existsSync(lifecycleWal), false)
  assert.equal(fs.existsSync(lifecycleLock), false)
  assert.equal(fs.existsSync(applicationWriterOwnerFile), false)
  assert.deepEqual(readJson(path.join(installDir, 'install.json')), manifestA)
  assert.deepEqual(readJson(path.join(context.hubDataRoot, '.skill-graft-data-root.json')), markerA)
  strictDoctor(recoveredA.doctor, versionA, 'A WAL recovery doctor')
  await waitForDaemon(cliA, baseEnv, tracker, versionA, 'A WAL recovery')
  assertDataPublicRuntime(packageAPublicRuntime, publicRuntimeHashA, 'A WAL recovery')

  const upgradedBAfterRecovery = lifecycle(cliB, ['upgrade', '--json'], baseEnv, 'B upgrade after WAL recovery')
  assert.equal(upgradedBAfterRecovery.ok, true, JSON.stringify(upgradedBAfterRecovery.issues || []))
  assert.equal(upgradedBAfterRecovery.status, 'upgraded')
  strictDoctor(upgradedBAfterRecovery.doctor, versionB, 'B after WAL recovery doctor')
  await waitForDaemon(cliB, baseEnv, tracker, versionB, 'B after WAL recovery')
  assertDataPublicRuntime(packageBPublicRuntime, publicRuntimeHashB, 'B after WAL recovery')
  const manifestB = readJson(path.join(installDir, 'install.json'))
  const markerB = readJson(path.join(context.hubDataRoot, '.skill-graft-data-root.json'))
  assert.equal(manifestB.installId, manifestA.installId)
  assert.equal(manifestB.dataRootId, manifestA.dataRootId)
  assert.notEqual(manifestB.packageSha256, manifestA.packageSha256)
  assert.equal(markerB.activeInstallId, manifestB.installId)
  const upgradeReplay = lifecycle(cliB, ['upgrade', '--json'], baseEnv, 'B upgrade rerun')
  assert.equal(upgradeReplay.ok, true)
  assert.equal(upgradeReplay.status, 'already-current')
  assertDataPublicRuntime(packageBPublicRuntime, publicRuntimeHashB, 'B upgrade rerun')
  const setupBAfterUpgrade = lifecycle(cliB, ['setup', '--json'], baseEnv, 'B setup after upgrade rerun')
  assert.equal(setupBAfterUpgrade.ok, true)
  strictDoctor(setupBAfterUpgrade.doctor, versionB, 'B setup after upgrade rerun doctor')
  assertDataPublicRuntime(packageBPublicRuntime, publicRuntimeHashB, 'final B setup')
  assert.equal(`sha256:${sha256File(privateSkillFile)}`, privateHash)
  assert.deepEqual(treeManifest(fixture.worktree), worktreeBeforeLifecycle)
  assert.deepEqual(treeManifest(libraryRoot), libraryBeforeLifecycle)

  const uninstallB = lifecycle(cliB, ['uninstall', '--json'], baseEnv, 'B final uninstall')
  assert.equal(uninstallB.ok, true, JSON.stringify(uninstallB.issues || []))
  assert.equal(uninstallB.stopped && uninstallB.taskRemoved && uninstallB.pathRemoved && uninstallB.filesRemoved, true)
  const uninstallBReplay = lifecycle(cliB, ['uninstall', '--json'], baseEnv, 'B final uninstall rerun')
  assert.equal(uninstallBReplay.ok, true, JSON.stringify(uninstallBReplay.issues || []))
  assert.equal(uninstallBReplay.status, 'already-uninstalled')
  assert.equal(uninstallBReplay.stopped, false)
  assert.equal(uninstallBReplay.taskRemoved, false)
  assert.equal(uninstallBReplay.pathRemoved, false)
  assert.equal(uninstallBReplay.filesRemoved, false)
  assertDataPublicRuntime(packageBPublicRuntime, publicRuntimeHashB, 'final B uninstall preservation')
  assert.equal(await waitForPort(port, false), true)
  assertExternalClean(baselineExternal)
  assert.equal(`sha256:${sha256File(privateSkillFile)}`, privateHash)
  assert.equal(`sha256:${sha256File(path.join(fixture.worktree, '.agents', 'skills', privateSkill, 'SKILL.md'))}`, copyHash)
  assert.deepEqual(treeManifest(fixture.worktree), worktreeBeforeLifecycle)
  assert.deepEqual(treeManifest(libraryRoot), libraryBeforeLifecycle)
  const inactiveMarker = readJson(path.join(context.hubDataRoot, '.skill-graft-data-root.json'))
  assert.equal(inactiveMarker.activeInstallId, null)
  assert.equal(inactiveMarker.dataRootId, manifestA.dataRootId)
  assert.equal(fs.existsSync(packageARoot), true, 'uninstall must not remove package A')
  assert.equal(fs.existsSync(packageBRoot), true, 'uninstall must not remove package B')

  const primaryReceiptFile = path.join(context.homeRoot, '.skill-graft-lifecycle', 'root-receipt-v1.json')
  const primaryReceiptBeforePurge = fs.readFileSync(primaryReceiptFile)
  const primaryDataBeforePurge = treeManifest(context.hubDataRoot)
  const purgeFixtureRoot = ensureOwnedDirectory(
    context,
    path.join(context.logsRoot, 'p4-independent-purge'),
    'logs',
    'independent purge fixture'
  )
  const purgeHome = path.join(purgeFixtureRoot, 'home')
  const purgeRoot = path.join(purgeFixtureRoot, 'hub-data')
  const purgeInstall = path.join(purgeFixtureRoot, 'lifecycle-install')
  const purgeTaskName = `SkillGraft-P4-Purge-${context.runId}`.slice(0, 96)
  const purgePort = await getAvailableLoopbackPort({ forbidden: [18765, 3080, port] })
  const purgeDirectories = {
    appData: path.join(purgeHome, 'appdata'),
    localAppData: path.join(purgeHome, 'localappdata'),
    temp: path.join(purgeHome, 'temp'),
    xdg: path.join(purgeHome, 'xdg-config'),
    dsh: path.join(purgeHome, 'dsh-home'),
    npmCache: path.join(purgeHome, 'npm-cache'),
    npmPrefix: path.join(purgeHome, 'npm-prefix')
  }
  for (const directory of [purgeHome, purgeRoot, ...Object.values(purgeDirectories)]) {
    ensureOwnedDirectory(context, directory, 'logs', 'independent purge directory')
  }
  const purgeEnv = {
    ...baseEnv,
    HOME: purgeHome,
    USERPROFILE: purgeHome,
    APPDATA: purgeDirectories.appData,
    LOCALAPPDATA: purgeDirectories.localAppData,
    TEMP: purgeDirectories.temp,
    TMP: purgeDirectories.temp,
    XDG_CONFIG_HOME: purgeDirectories.xdg,
    DSH_HOME: purgeDirectories.dsh,
    SKILL_GRAFT_HOME: purgeRoot,
    HUB_ROOT: purgeRoot,
    HUB_API_PORT: String(purgePort),
    SG_INSTALL_DIR: purgeInstall,
    SG_TASK_NAME: purgeTaskName,
    SG_SKIP_PATH: '1',
    SG_SKIP_TASK: '1',
    HUB_SPAWN_CODEX: '0',
    SKILL_GRAFT_INVOCATION_TRACE: '0',
    npm_config_cache: purgeDirectories.npmCache,
    NPM_CONFIG_CACHE: purgeDirectories.npmCache,
    npm_config_prefix: purgeDirectories.npmPrefix,
    NPM_CONFIG_PREFIX: purgeDirectories.npmPrefix,
    npm_config_userconfig: path.join(purgeHome, '.npmrc'),
    NPM_CONFIG_USERCONFIG: path.join(purgeHome, '.npmrc')
  }
  const purgeExternalBefore = readExternalEnvironmentSnapshot()
  assert.equal(taskState(purgeTaskName).exists, false, 'independent purge task must start absent')
  assert.equal(await portListening(purgePort), false, 'independent purge port must start free')
  const purgeSetup = lifecycle(cliB, [
    'setup', '--no-daemon', '--no-path', '--no-task', '--json'
  ], purgeEnv, 'independent purge setup')
  assert.equal(purgeSetup.ok, true, JSON.stringify(purgeSetup.issues || []))
  const purgeManifestFile = path.join(purgeInstall, 'install.json')
  const purgeManifest = readJson(purgeManifestFile)
  assert.deepEqual(purgeManifest.features, { path: false, task: false, daemon: false })
  assert.equal(samePath(purgeManifest.packageRoot, packageBRoot), true)
  assert.equal(samePath(purgeManifest.dataRoot, purgeRoot), true)
  assert.equal(samePath(purgeManifest.installDir, purgeInstall), true)
  assert.equal(samePath(purgeManifest.nodePath, process.execPath), true)
  const purgeReceiptFile = path.join(purgeHome, '.skill-graft-lifecycle', 'root-receipt-v1.json')
  const purgeActiveReceipt = readJson(purgeReceiptFile)
  const purgeActiveMarker = readJson(path.join(purgeRoot, '.skill-graft-data-root.json'))
  assert.equal(purgeActiveReceipt.state, 'active')
  assert.equal(purgeActiveReceipt.dataRootId, purgeManifest.dataRootId)
  assert.equal(purgeActiveReceipt.installId, purgeManifest.installId)
  assert.equal(samePath(purgeActiveReceipt.dataRoot, purgeRoot), true)
  assert.equal(samePath(purgeActiveReceipt.installDir, purgeInstall), true)
  assert.equal(purgeActiveMarker.dataRootId, purgeManifest.dataRootId)
  assert.equal(purgeActiveMarker.activeInstallId, purgeManifest.installId)
  assertExternalEnvironmentEqual(readExternalEnvironmentSnapshot(), purgeExternalBefore, 'independent purge setup')
  assert.equal(taskState(purgeTaskName).exists, false, 'no-task setup must not register the independent task')
  assert.equal(await portListening(purgePort), false, 'no-daemon setup must not bind the independent port')

  const purgeUninstall = lifecycle(cliB, ['uninstall', '--json'], purgeEnv, 'independent purge uninstall')
  assert.equal(purgeUninstall.ok, true, JSON.stringify(purgeUninstall.issues || []))
  assert.equal(purgeUninstall.status, 'uninstalled')
  assert.equal(purgeUninstall.stopped, false)
  assert.equal(purgeUninstall.taskRemoved, false)
  assert.equal(purgeUninstall.pathRemoved, false)
  assert.equal(purgeUninstall.filesRemoved, true)
  assert.equal(purgeUninstall.extraShimsRemoved, false)
  assert.equal(fs.existsSync(purgeInstall), false, 'independent uninstall must remove only its install directory')
  const purgeInactiveReceipt = readJson(purgeReceiptFile)
  const purgeInactiveMarker = readJson(path.join(purgeRoot, '.skill-graft-data-root.json'))
  assert.equal(purgeInactiveReceipt.state, 'inactive')
  assert.equal(purgeInactiveReceipt.dataRootId, purgeManifest.dataRootId)
  assert.equal(purgeInactiveMarker.activeInstallId, null)
  assert.equal(purgeInactiveMarker.dataRootId, purgeManifest.dataRootId)
  const purgeReceiptBeforeDry = fs.readFileSync(purgeReceiptFile)
  const purgeTreeBeforeDry = treeManifest(purgeRoot)
  const purgeDry = lifecycle(cliB, [
    'purge', '--data-root', purgeRoot, '--dry-run', '--json'
  ], purgeEnv, 'independent purge dry-run')
  assert.equal(purgeDry.ok, true, JSON.stringify(purgeDry.issues || []))
  assert.equal(purgeDry.status, 'planned')
  assert.equal(purgeDry.plan.dataRootId, purgeManifest.dataRootId)
  assert.match(purgeDry.plan.planHash, /^sha256:[a-f0-9]{64}$/)
  assert.deepEqual(treeManifest(purgeRoot), purgeTreeBeforeDry, 'purge dry-run must not edit its data root')
  assert.equal(fs.readFileSync(purgeReceiptFile).equals(purgeReceiptBeforeDry), true, 'purge dry-run must not edit its receipt')
  const purgeCommit = lifecycle(cliB, [
    'purge', '--data-root', purgeRoot, '--commit',
    '--data-root-id', purgeDry.plan.dataRootId,
    '--plan-hash', purgeDry.plan.planHash,
    '--json'
  ], purgeEnv, 'independent purge commit')
  assert.equal(purgeCommit.ok, true, JSON.stringify(purgeCommit.issues || []))
  assert.equal(purgeCommit.status, 'purged')
  assert.equal(fs.existsSync(purgeRoot), false)
  assert.equal(fs.existsSync(purgeReceiptFile), false, 'purge receipt must be retired')
  assert.equal(fs.existsSync(`${purgeRoot}.lifecycle.lock`), false, 'purge lifecycle lock must be released')
  assert.equal(fs.existsSync(`${purgeRoot}.lifecycle-wal.json`), false, 'purge lifecycle WAL must be absent')
  assert.equal(fs.existsSync(`${purgeRoot}.purge-wal-v1.json`), false, 'purge WAL must be retired')
  assert.deepEqual(
    fs.readdirSync(purgeFixtureRoot).filter((name) => name.startsWith(`${path.basename(purgeRoot)}.purging-`)),
    [],
    'purge tombstone must be absent'
  )
  assertExternalEnvironmentEqual(readExternalEnvironmentSnapshot(), purgeExternalBefore, 'independent purge completion')
  assert.equal(taskState(purgeTaskName).exists, false, 'independent purge must leave no task')
  assert.equal(await portListening(purgePort), false, 'independent purge must leave its port free')
  assert.deepEqual(fs.readdirSync(purgeDirectories.dsh), [], 'independent Local purge must not use DSH_HOME')
  assert.equal(fs.readFileSync(primaryReceiptFile).equals(primaryReceiptBeforePurge), true, 'independent purge must preserve the primary receipt')
  assert.deepEqual(treeManifest(context.hubDataRoot), primaryDataBeforePurge, 'independent purge must preserve the primary data tree')
  assert.equal(fs.existsSync(lifecycleLock), false, 'primary lifecycle lock must remain absent')
  assert.equal(fs.existsSync(lifecycleWal), false, 'primary lifecycle WAL must remain absent')
  assert.equal(fs.existsSync(context.hubDataRoot), true, 'explicit independent purge must not touch preserved data')
  assert.equal(`sha256:${sha256File(privateSkillFile)}`, privateHash)
  assertDataPublicRuntime(packageBPublicRuntime, publicRuntimeHashB, 'independent purge main-root preservation')

  assert.deepEqual(ownedWindowsProcesses(), [], 'uninstall must leave no marker-owned process')
  assert.equal(await portListening(port), false, 'selected port must be released')
  assert.equal(await portListening(18765), fixedPortBefore, 'fixed 18765 listener state must be unchanged')
  assert.deepEqual(fs.readdirSync(dshHome), [], 'P4 Local flow must not use DSH_HOME')
  assertProtectedRootBaselines(protectedBaselines, context.homeRoot)

  const summary = {
    schemaVersion: 1,
    runId: context.runId,
    host: 'Local',
    phase: 'P4',
    package: {
      name: packageName,
      versionA,
      versionB,
      tarballA: `sha256:${sha256File(tarballA)}`,
      tarballB: `sha256:${sha256File(tarballB)}`,
      packA: packEvidenceA,
      packB: packEvidenceB,
      publicRuntimeA: publicRuntimeHashA,
      publicRuntimeB: publicRuntimeHashB,
      sourceOutsideInstall: true,
      privateCorpusShipped: false
    },
    lifecycle: {
      setupDryRun: true,
      setupRerun: true,
      reinstallAfterUninstall: true,
      upgradeDryRun: true,
      upgradeCommitted: true,
      upgradeRerun: true,
      switchedWalProcessRecovery: true,
      switchedWalProductWritten: true,
      switchedWalOwnerPidMatched: true,
      switchedWalSha256: cutWal.sha256,
      uninstallRerun: true,
      explicitIndependentPurge: true
    },
    integration: {
      userPathOwnedThenRestored: true,
      userEnvironmentOwnedThenRestored: true,
      scheduledTaskOwnedThenRemoved: true,
      newShellResolution: true,
      daemonApplicationPidShared: true,
      selectedPort: port,
      selectedPortReleased: true,
      fixedPortUnchanged: true
    },
    application: {
      hookSessionStartCompatibilityOnly: true,
      p5RunnerAcceptance: false,
      snapshotA: snapshotA.snapshotId,
      snapshotB: snapshotB.snapshotId,
      materializationA: syncA.data.marker.materializationId,
      materializationB: syncB.data.marker.materializationId,
      conflict: conflictSync.error.code,
      historyRecords: history.data.records.length,
      panelHandshakeUsed,
      panelHandshakeStages: {
        planSyncSuccess: planSyncPanelHandshakeUsed,
        dirtyConflict: dirtyConflictPanelHandshakeUsed
      }
    },
    preservation: {
      dataRoot: true,
      privateSkill: privateHash,
      worktreeCopy: copyHash,
      snapshots: snapshotManifestFiles.length,
      worktreeTree: `sha256:${sha256Bytes(JSON.stringify(worktreeBeforeLifecycle))}`,
      snapshotRepository: `sha256:${sha256Bytes(JSON.stringify(libraryBeforeLifecycle))}`
    },
    safety: {
      windowsOnlyHardGate: true,
      markerOwned: true,
      noRetry: true,
      failedRootNeverCleaned: true,
      protectedGitRoots: protectedBaselines.filter((baseline) => baseline.kind === 'git').length,
      protectedPlainRoots: protectedBaselines.filter((baseline) => baseline.kind === 'plain').length,
      protectedRootsUnchanged: true,
      ownedProcessesAfter: 0,
      globalHostBinsRemovedFromProcessPath: sanitized.removed.length,
      dshUnused: true
    }
  }
  assertLocatorFree(summary, [context.runRoot, sourceRoot, ...protectedRoots], 'P4 installed-real summary')
  const summarySha256 = writeBoundedJson(summaryFile, summary, {
    maxBytes: 32 * 1024,
    locators: [context.runRoot, sourceRoot, ...protectedRoots]
  })
  assert.match(summarySha256, /^sha256:[a-f0-9]{64}$/)
  normalCompletion = true
})
