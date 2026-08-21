import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const MARKER_NAME = '.skill-graft-e2e-run.json'
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{7,95}$/i

function comparable(target) {
  const resolved = path.resolve(target)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function canonicalize(target) {
  const resolved = path.resolve(target)
  const suffix = []
  let cursor = resolved
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor)
    if (samePath(parent, cursor)) break
    suffix.unshift(path.basename(cursor))
    cursor = parent
  }
  const existing = fs.existsSync(cursor) ? fs.realpathSync.native(cursor) : cursor
  return path.resolve(existing, ...suffix)
}

function samePath(left, right) {
  return comparable(left) === comparable(right)
}

function isInside(parent, target) {
  const rel = path.relative(path.resolve(parent), path.resolve(target))
  return Boolean(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}

function isSameOrInside(parent, target) {
  return samePath(parent, target) || isInside(parent, target)
}

function required(env, name) {
  const value = String(env[name] || '').trim()
  if (!value) throw new Error(`${name} is required for real E2E`)
  return value
}

function absoluteEnvPath(env, name) {
  const value = required(env, name)
  if (!path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`)
  return path.resolve(value)
}

export function createIsolatedGitEnvironment(baseEnv, homeRoot, { platform = process.platform } = {}) {
  if (!baseEnv || typeof baseEnv !== 'object') throw new Error('base Git environment must be an object')
  if (!path.isAbsolute(homeRoot)) throw new Error('isolated Git HOME must be absolute')
  const isolatedHome = path.resolve(homeRoot)
  const env = { ...baseEnv }
  for (const name of Object.keys(env)) {
    if (/^GIT_/i.test(name)) delete env[name]
  }
  Object.assign(env, {
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    XDG_CONFIG_HOME: path.join(isolatedHome, 'xdg-config'),
    GIT_ATTR_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0'
  })
  return env
}

const WINDOWS_BATCH_UNSAFE = /[\u0000-\u001f\u007f"%!&|<>()^]/

function windowsBatchToken(value, label) {
  const token = String(value)
  if (!token || WINDOWS_BATCH_UNSAFE.test(token)) {
    throw new Error(`${label} contains a character that cannot be passed safely through cmd.exe`)
  }
  return `"${token}"`
}

export function createWindowsBatchInvocation(batchFile, args = [], options = {}) {
  if (!Array.isArray(args)) throw new Error('Windows batch arguments must be an array')
  const absoluteBatch = path.win32.resolve(String(batchFile || ''))
  if (!path.win32.isAbsolute(String(batchFile || ''))) {
    throw new Error('Windows batch file must be an absolute path')
  }
  const comspec = String(options.comspec || process.env.ComSpec || 'cmd.exe')
  const line = ['call', windowsBatchToken(absoluteBatch, 'Windows batch file')]
  for (const [index, value] of args.entries()) {
    line.push(windowsBatchToken(value, `Windows batch argument ${index}`))
  }
  return Object.freeze({
    command: comspec,
    args: Object.freeze(['/d', '/s', '/v:off', '/c', line.join(' ')]),
    windowsVerbatimArguments: true
  })
}

export function assertSourceOutsideProtectedRoots(source, protectedRoots, label = 'fixture source') {
  if (!path.isAbsolute(source)) throw new Error(`${label} must be absolute`)
  const canonicalSource = canonicalize(source)
  for (const candidate of protectedRoots || []) {
    if (!candidate) continue
    if (!path.isAbsolute(candidate)) throw new Error(`protected source root must be absolute: ${candidate}`)
    const canonicalProtected = canonicalize(candidate)
    if (isSameOrInside(canonicalProtected, canonicalSource) || isSameOrInside(canonicalSource, canonicalProtected)) {
      throw new Error(`${label} must not overlap a protected or live source: ${canonicalProtected}`)
    }
  }
  return canonicalSource
}

function assertChild(root, target, label, firstSegment) {
  const canonicalRoot = canonicalize(root)
  const canonicalTarget = canonicalize(target)
  if (!isInside(canonicalRoot, canonicalTarget)) {
    throw new Error(`${label} must be inside the run root after resolving links and existing ancestors`)
  }
  const rel = path.relative(root, target)
  const segment = rel.split(path.sep)[0]
  if (firstSegment && segment.toLowerCase() !== firstSegment.toLowerCase()) {
    throw new Error(`${label} must be under ${firstSegment}${path.sep} inside the run root`)
  }
}

function enclosingGitCheckout(target) {
  let cursor = canonicalize(target)
  for (;;) {
    if (fs.existsSync(path.join(cursor, '.git'))) return cursor
    const parent = path.dirname(cursor)
    if (samePath(parent, cursor)) return null
    cursor = parent
  }
}

function assertSafeRunRoot(runRoot, runId, options) {
  const driveRoot = path.parse(runRoot).root
  if (samePath(runRoot, driveRoot)) throw new Error('real E2E run root cannot be a drive root')
  if (path.basename(runRoot).toLowerCase() !== runId.toLowerCase()) {
    throw new Error('real E2E run root basename must equal SKILL_GRAFT_RUN_ID')
  }

  const canonicalRunRoot = canonicalize(runRoot)
  const homeDir = canonicalize(options.homeDir || os.homedir())
  if (isSameOrInside(homeDir, canonicalRunRoot) || isSameOrInside(canonicalRunRoot, homeDir)) {
    throw new Error('refusing a real E2E root inside the user home or one of its ancestors')
  }
  const gitCheckout = enclosingGitCheckout(canonicalRunRoot)
  if (gitCheckout) throw new Error(`refusing a real E2E root inside a Git checkout: ${gitCheckout}`)

  const protectedRoots = [options.workspaceRoot || process.cwd(), ...(options.protectedRoots || [])]
    .filter(Boolean)
    .map((item) => canonicalize(item))
  for (const protectedRoot of protectedRoots) {
    if (isSameOrInside(protectedRoot, canonicalRunRoot) || isInside(canonicalRunRoot, protectedRoot)) {
      throw new Error(`refusing protected workspace or live-tree root: ${protectedRoot}`)
    }
  }
}

export function validateRealE2eEnvironment(env = process.env, options = {}) {
  if (String(env.SKILL_GRAFT_REAL_E2E || '') !== '1') {
    throw new Error('real E2E is disabled; set SKILL_GRAFT_REAL_E2E=1 explicitly')
  }
  const runId = required(env, 'SKILL_GRAFT_RUN_ID')
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error('SKILL_GRAFT_RUN_ID must be 8-96 safe filename characters')
  }

  const runRoot = absoluteEnvPath(env, 'SKILL_GRAFT_E2E_ROOT')
  assertSafeRunRoot(runRoot, runId, options)
  const probeRoot = absoluteEnvPath(env, 'SKILL_GRAFT_REAL_PROBE')
  const hubDataRoot = absoluteEnvPath(env, 'SKILL_GRAFT_HOME')
  const legacyHubRoot = absoluteEnvPath(env, 'HUB_ROOT')
  const cliPath = absoluteEnvPath(env, 'SKILL_GRAFT_CLI')

  assertChild(runRoot, probeRoot, 'probe', 'probe')
  assertChild(runRoot, hubDataRoot, 'hub data', 'hub-data')
  assertChild(runRoot, cliPath, 'installed CLI', 'app')
  if (!samePath(hubDataRoot, legacyHubRoot)) {
    throw new Error('SKILL_GRAFT_HOME and legacy HUB_ROOT must identify the same isolated hub-data root in P0')
  }

  return Object.freeze({
    runId,
    runRoot,
    probeRoot,
    hubDataRoot,
    cliPath,
    appRoot: path.join(runRoot, 'app'),
    homeRoot: path.join(runRoot, 'home'),
    logsRoot: path.join(runRoot, 'logs'),
    markerFile: path.join(runRoot, MARKER_NAME)
  })
}

function readOwnedMarker(context) {
  if (!fs.existsSync(context.markerFile)) {
    throw new Error(`refusing cleanup without ${MARKER_NAME}`)
  }
  let marker
  try {
    marker = JSON.parse(fs.readFileSync(context.markerFile, 'utf8'))
  } catch (error) {
    throw new Error(`refusing cleanup with invalid ${MARKER_NAME}: ${error instanceof Error ? error.message : error}`)
  }
  if (marker.version !== 1 || marker.runId !== context.runId || !samePath(marker.runRoot, context.runRoot)) {
    throw new Error(`refusing cleanup: ${MARKER_NAME} does not own this run root`)
  }
  return marker
}

export function assertRunLayoutOwned(context) {
  readOwnedMarker(context)
  for (const dir of [context.appRoot, context.homeRoot, context.hubDataRoot, context.probeRoot, context.logsRoot]) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw new Error(`real E2E run layout is missing directory: ${dir}`)
    }
    assertChild(context.runRoot, dir, 'run directory')
  }
  return context
}

export function createRunLayout(context) {
  if (fs.existsSync(context.runRoot) && !fs.existsSync(context.markerFile)) {
    const entries = fs.readdirSync(context.runRoot)
    if (entries.length > 0) throw new Error('refusing to adopt a non-empty run root without an ownership marker')
  }
  fs.mkdirSync(context.runRoot, { recursive: true })
  if (fs.existsSync(context.markerFile)) {
    readOwnedMarker(context)
  } else {
    fs.writeFileSync(context.markerFile, `${JSON.stringify({
      version: 1,
      runId: context.runId,
      runRoot: context.runRoot,
      createdAt: new Date().toISOString()
    }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  }
  for (const dir of [context.appRoot, context.homeRoot, context.hubDataRoot, context.probeRoot, context.logsRoot]) {
    assertChild(context.runRoot, dir, 'run directory')
    fs.mkdirSync(dir, { recursive: true })
    assertChild(context.runRoot, dir, 'run directory')
  }
  return assertRunLayoutOwned(context)
}

export function removeOwnedPath(context, target) {
  readOwnedMarker(context)
  const resolved = path.resolve(target)
  if (samePath(resolved, context.runRoot)) throw new Error('refusing to remove the run root through removeOwnedPath')
  if (!isInside(canonicalize(context.runRoot), canonicalize(resolved))) {
    throw new Error('refusing to remove a path outside the run root after resolving links')
  }
  fs.rmSync(resolved, { recursive: true, force: true })
}

export function cleanupRunLayout(context) {
  readOwnedMarker(context)
  fs.rmSync(context.runRoot, { recursive: true, force: true })
}

export async function getAvailableLoopbackPort({ forbidden = [18765, 3080] } = {}) {
  for (;;) {
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer()
      server.unref()
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        const assigned = typeof address === 'object' && address ? address.port : 0
        server.close((error) => {
          if (error) reject(error)
          else resolve(assigned)
        })
      })
    })
    if (!forbidden.includes(port)) return port
  }
}

export class ProcessTracker {
  #children = new Set()
  #pids = new Map()

  constructor({ runId = '' } = {}) {
    this.runId = runId
  }

  track(child) {
    if (!child || typeof child.kill !== 'function') throw new Error('tracked process must expose kill(signal)')
    this.#children.add(child)
    if (typeof child.once === 'function') {
      child.once('exit', () => this.#children.delete(child))
    }
    return child
  }

  trackPid(pid, { commandIncludes = this.runId } = {}) {
    const value = Number(pid)
    const token = String(commandIncludes || '').trim()
    if (!Number.isInteger(value) || value <= 0 || value === process.pid) throw new Error('tracked pid must be a positive external process id')
    if (token.length < 8) throw new Error('detached PID tracking requires an ownership token of at least 8 characters')
    this.#pids.set(value, token)
    return value
  }

  trackWindowsOwnedPids({ commandIncludes = this.runId, pathIncludesAny = [] } = {}) {
    if (process.platform !== 'win32') return []
    const token = String(commandIncludes || '').trim()
    const ownedPaths = pathIncludesAny.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
    if (token.length < 8 || ownedPaths.length === 0) {
      throw new Error('owned PID discovery requires a run-id token and at least one marker-owned process path')
    }
    const script = [
      "$rows = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -in @('cmd.exe','node.exe','codex.exe') }",
      '$rows | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'
    ].join('; ')
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true
    })
    if (result.status !== 0) throw new Error(`could not enumerate marker-owned PIDs: ${result.stderr || result.stdout}`)
    const text = String(result.stdout || '').trim()
    const rows = text ? JSON.parse(text) : []
    const tracked = []
    for (const row of (Array.isArray(rows) ? rows : [rows])) {
      const pid = Number(row.ProcessId)
      const commandLine = String(row.CommandLine || '').toLowerCase()
      if (pid === process.pid || !commandLine.includes(token.toLowerCase())) continue
      if (!ownedPaths.some((ownedPath) => commandLine.includes(ownedPath))) continue
      tracked.push(this.trackPid(pid, { commandIncludes: token }))
    }
    return tracked
  }

  #pidAlive(pid) {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  #windowsProcess(pid) {
    const escaped = Number(pid)
    const script = [
      `$p = Get-CimInstance Win32_Process -Filter \"ProcessId = ${escaped}\" -ErrorAction SilentlyContinue`,
      'if ($null -eq $p) { exit 3 }',
      '$p | Select-Object ProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress'
    ].join('; ')
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true
    })
    if (result.status === 3 || !String(result.stdout || '').trim()) return null
    if (result.status !== 0) throw new Error(`could not inspect tracked PID ${pid}: ${result.stderr || result.stdout}`)
    return JSON.parse(result.stdout)
  }

  #posixCommandLine(pid) {
    if (process.platform === 'linux') {
      try {
        return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim()
      } catch {
        return ''
      }
    }
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      windowsHide: true
    })
    return result.status === 0 ? String(result.stdout || '').trim() : ''
  }

  #assertPidOwned(pid, token) {
    if (!this.#pidAlive(pid)) return false
    const commandLine = process.platform === 'win32'
      ? String(this.#windowsProcess(pid)?.CommandLine || '')
      : this.#posixCommandLine(pid)
    if (!commandLine && !this.#pidAlive(pid)) return false
    if (!commandLine.toLowerCase().includes(token.toLowerCase())) {
      throw new Error(`refusing to terminate PID ${pid}: command line does not contain ownership token`)
    }
    return true
  }

  async #stopTrackedPid(pid, token, graceMs) {
    if (!this.#assertPidOwned(pid, token)) return
    if (process.platform === 'win32') {
      const result = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        encoding: 'utf8',
        windowsHide: true
      })
      if (result.status !== 0 && this.#pidAlive(pid)) {
        throw new Error(`taskkill failed for owned PID ${pid}: ${result.stderr || result.stdout}`)
      }
    } else {
      process.kill(pid, 'SIGTERM')
      if (graceMs > 0) await new Promise((resolve) => setTimeout(resolve, graceMs))
      if (this.#pidAlive(pid)) process.kill(pid, 'SIGKILL')
    }
    const deadline = Date.now() + Math.max(graceMs, 2000)
    while (this.#pidAlive(pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    if (this.#pidAlive(pid)) throw new Error(`owned PID ${pid} did not exit after process-tree termination`)
  }

  async stopAll({ graceMs = 1000 } = {}) {
    const children = [...this.#children]
    const errors = []
    // Stop explicitly owned PIDs first so Windows can terminate their complete
    // process trees while the tracked parent is still alive. Killing a tracked
    // ChildProcess handle first can orphan a WMI/detached descendant before
    // taskkill /T gets a chance to discover it.
    for (const [pid, token] of this.#pids) {
      try {
        await this.#stopTrackedPid(pid, token, graceMs)
      } catch (error) {
        errors.push(error)
      }
    }
    for (const child of children) {
      if (child.exitCode == null && child.signalCode == null) {
        try { child.kill('SIGTERM') } catch { /* best effort within the tracked set */ }
      }
    }
    if (graceMs > 0 && children.some((child) => child.exitCode == null && child.signalCode == null)) {
      await new Promise((resolve) => setTimeout(resolve, graceMs))
    }
    for (const child of children) {
      if (child.exitCode == null && child.signalCode == null) {
        try { child.kill('SIGKILL') } catch { /* best effort within the tracked set */ }
      }
    }
    this.#children.clear()
    this.#pids.clear()
    if (errors.length > 0) throw new AggregateError(errors, 'one or more owned process trees could not be stopped')
  }
}
