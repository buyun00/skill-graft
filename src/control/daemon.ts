import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createHub } from '../adapters/create-hub.js'
import { API_PORT } from '../local/lifecycle/install-domain.js'
import { createLocalHost, type LocalHost } from '../local/create-local-host.js'
import { coherentDataRootEnvironment, resolveLocalDataRoot } from '../local/data-root.js'
import { createCodexSessionRunner } from '../local/session/codex-session-runner.js'
import { createInstallHost, type InstallHost } from '../adapters/install-host.js'

export type DaemonRunOptions = {
  packageRoot?: string
  dataRoot?: string
  /** @deprecated use packageRoot; retained for the Local lifecycle compatibility surface. */
  hubRoot: string
  port?: number
  intervalMs?: number
  host?: InstallHost
}

export type ApiInstanceExpectation = {
  packageRoot?: string
  dataRoot?: string
}

export type DaemonInstanceBinding = {
  pid: number
  apiPid: number
  packageRoot: string
  dataRoot: string
  port: number
}

export const API_PACKAGE_ROOT_HEADER = 'x-skill-graft-package-root'
export const API_DATA_ROOT_HEADER = 'x-skill-graft-data-root'
const DAEMON_STOP_TIMEOUT_MS = 5000

export function reviewFiles(dataRoot: string) {
  const review = join(dataRoot, 'skill-review')
  return {
    review,
    pidFile: join(review, 'daemon.pid'),
    apiPidFile: join(review, 'api.pid'),
    heartbeatFile: join(review, 'daemon-heartbeat.json'),
    logFile: join(review, 'daemon.log')
  }
}

export function readPid(file: string): number {
  try {
    const n = Number(String(fs.readFileSync(file, 'utf8')).trim())
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

export function readHeartbeat(dataRoot: string): Record<string, unknown> | null {
  const file = reviewFiles(dataRoot).heartbeatFile
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

export async function pingApi(
  port: number,
  timeoutMs = 1500,
  expected: ApiInstanceExpectation = {}
): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return false
    const body = await res.json() as { ok?: unknown }
    return body?.ok === true && apiHeadersMatch(res.headers, expected)
  } catch {
    return false
  }
}

export async function waitForApi(
  port: number,
  timeoutMs = 8000,
  expected: ApiInstanceExpectation = {}
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await pingApi(port, 1500, expected)) return true
    await sleep(250)
  }
  return pingApi(port, 1500, expected)
}

export function apiHeadersMatch(headers: Pick<Headers, 'get'>, expected: ApiInstanceExpectation): boolean {
  return headerPathMatches(headers.get(API_PACKAGE_ROOT_HEADER), expected.packageRoot)
    && headerPathMatches(headers.get(API_DATA_ROOT_HEADER), expected.dataRoot)
}

function headerPathMatches(actual: string | null, expected?: string): boolean {
  if (!expected) return true
  if (!actual) return false
  let decoded = actual
  try {
    decoded = decodeURIComponent(actual)
  } catch {
    /* compare the raw header below */
  }
  return sameResolvedPath(decoded, expected)
}

export function daemonProcessMatches(host: InstallHost, pid: number, packageRoot: string): boolean {
  const tokens = commandTokens(host.processCommandLine(pid))
  return tokens.length === 4
    && nodeExecutableMatches(tokens[0], host.caseInsensitive)
    && pathTokenMatches(tokens[1], join(packageRoot, 'dist', 'control', 'cli.js'), host.caseInsensitive)
    && tokens[2]?.toLowerCase() === 'daemon'
    && tokens[3]?.toLowerCase() === 'run'
}

export function apiProcessMatches(host: InstallHost, pid: number, packageRoot: string): boolean {
  const tokens = commandTokens(host.processCommandLine(pid))
  return tokens.length === 2
    && nodeExecutableMatches(tokens[0], host.caseInsensitive)
    && pathTokenMatches(tokens[1], join(packageRoot, 'server', 'index.mjs'), host.caseInsensitive)
}

function commandTokens(command: string): string[] {
  if (!command) return []
  const tokens: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|([^\s]+)/g
  for (const match of command.matchAll(pattern)) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '')
  }
  return tokens.filter(Boolean)
}

function nodeExecutableMatches(token: string | undefined, caseInsensitive: boolean): boolean {
  if (!token) return false
  if (!/[\\/]/.test(token)) return /^(?:node|node\.exe)$/i.test(token)
  return comparablePath(token, caseInsensitive) === comparablePath(process.execPath, caseInsensitive)
}

function pathTokenMatches(token: string | undefined, expected: string, caseInsensitive: boolean): boolean {
  return Boolean(token) && comparablePath(token as string, caseInsensitive) === comparablePath(expected, caseInsensitive)
}

function comparablePath(value: string, caseInsensitive: boolean): string {
  const normalized = resolve(value).replaceAll('/', '\\').replace(/[\\]+$/, '')
  return caseInsensitive ? normalized.toLowerCase() : normalized
}

function sameResolvedPath(left: string, right: string): boolean {
  return comparablePath(left, process.platform === 'win32' || process.platform === 'darwin')
    === comparablePath(right, process.platform === 'win32' || process.platform === 'darwin')
}

export function heartbeatBindsInstance(
  heartbeat: Record<string, unknown> | null,
  expected: DaemonInstanceBinding,
  maxAgeMs = 20000,
  now = Date.now()
): boolean {
  if (!heartbeat?.lastBeat) return false
  const at = Date.parse(String(heartbeat.lastBeat))
  const age = now - at
  const heartbeatPackageRoot = typeof heartbeat.packageRoot === 'string' ? heartbeat.packageRoot.trim() : ''
  const heartbeatDataRoot = typeof heartbeat.dataRoot === 'string' ? heartbeat.dataRoot.trim() : ''
  return Number.isFinite(at)
    && age >= 0
    && age < maxAgeMs
    && Number(heartbeat.pid || 0) === expected.pid
    && Number(heartbeat.apiPid || 0) === expected.apiPid
    && Number(heartbeat.port || 0) === expected.port
    && Boolean(heartbeatPackageRoot)
    && Boolean(heartbeatDataRoot)
    && sameResolvedPath(heartbeatPackageRoot, expected.packageRoot)
    && sameResolvedPath(heartbeatDataRoot, expected.dataRoot)
}

export type DaemonPidClaim = {
  claimed: boolean
  existingPid: number
  reason: 'claimed' | 'already-running' | 'unverified-live-pid' | 'claim-failed'
}

export function claimDaemonPid(
  pidFile: string,
  host: InstallHost,
  packageRoot: string,
  ownerPid = process.pid,
  dataRoot = dirname(dirname(pidFile)),
  port = Number(host.env('HUB_API_PORT') || API_PORT)
): DaemonPidClaim {
  fs.mkdirSync(dirname(pidFile), { recursive: true })
  const files = reviewFiles(dataRoot)
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const existingPid = readPid(pidFile)
    const existingApiPid = readPid(files.apiPidFile)
    const daemonAlive = Boolean(existingPid && host.pidAlive(existingPid))
    const apiAlive = Boolean(existingApiPid && host.pidAlive(existingApiPid))
    if (daemonAlive || apiAlive) {
      const heartbeat = readHeartbeat(dataRoot)
      const bound = heartbeatBindsInstance(heartbeat, {
        pid: existingPid,
        apiPid: existingApiPid,
        packageRoot,
        dataRoot,
        port
      })
      const daemonOwned = !daemonAlive || daemonProcessMatches(host, existingPid, packageRoot)
      const apiOwned = !apiAlive || apiProcessMatches(host, existingApiPid, packageRoot)
      if (daemonAlive && bound && daemonOwned && apiOwned) {
        return { claimed: false, existingPid, reason: 'already-running' }
      }
      return {
        claimed: false,
        existingPid: existingPid || existingApiPid,
        reason: 'unverified-live-pid'
      }
    }

    if (fs.existsSync(pidFile)) {
      const quarantine = `${pidFile}.stale.${ownerPid}.${Date.now()}.${attempt}`
      try {
        fs.renameSync(pidFile, quarantine)
        fs.unlinkSync(quarantine)
      } catch {
        try { if (fs.existsSync(quarantine)) fs.unlinkSync(quarantine) } catch { /* ignore */ }
        continue
      }
    }

    const temp = `${pidFile}.${ownerPid}.${Date.now()}.${attempt}.tmp`
    try {
      fs.writeFileSync(temp, `${ownerPid}\n`, { encoding: 'utf8', flag: 'wx' })
      try {
        fs.linkSync(temp, pidFile)
        return { claimed: true, existingPid: 0, reason: 'claimed' }
      } catch (error) {
        if (!isAlreadyExists(error)) return { claimed: false, existingPid: 0, reason: 'claim-failed' }
      }
    } finally {
      try { if (fs.existsSync(temp)) fs.unlinkSync(temp) } catch { /* ignore temporary claim cleanup */ }
    }

  }
  return { claimed: false, existingPid: readPid(pidFile), reason: 'claim-failed' }
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')
}

export function stopDaemon(
  dataRoot: string,
  host: InstallHost = createInstallHost(),
  packageRoot?: string,
  port = Number(host.env('HUB_API_PORT') || API_PORT)
): boolean {
  const files = reviewFiles(dataRoot)
  const staleMarkerSnapshot = [files.pidFile, files.apiPidFile, files.heartbeatFile]
    .map((file) => {
      try {
        return fs.readFileSync(file, 'utf8')
      } catch {
        return null
      }
    })
  const daemonPid = readPid(files.pidFile)
  const apiPid = readPid(files.apiPidFile)
  const heartbeat = readHeartbeat(dataRoot)
  const daemonAlive = Boolean(daemonPid && host.pidAlive(daemonPid))
  const apiAlive = Boolean(apiPid && host.pidAlive(apiPid))
  const anyLive = daemonAlive || apiAlive
  const bound = Boolean(packageRoot) && heartbeatBindsInstance(heartbeat, {
    pid: daemonPid,
    apiPid,
    packageRoot: packageRoot || '',
    dataRoot,
    port
  })
  const daemonOwned = !daemonAlive || Boolean(packageRoot && daemonProcessMatches(host, daemonPid, packageRoot))
  const apiOwned = !apiAlive || Boolean(packageRoot && apiProcessMatches(host, apiPid, packageRoot))

  if (anyLive && (!bound || !daemonOwned || !apiOwned)) {
    return false
  }
  const livePids = [...new Set([
    ...(daemonAlive ? [daemonPid] : []),
    ...(apiAlive ? [apiPid] : [])
  ])]
  if (livePids.length > 0) {
    const markersUnchanged = readPid(files.pidFile) === daemonPid
      && readPid(files.apiPidFile) === apiPid
      && Boolean(packageRoot)
      && heartbeatBindsInstance(readHeartbeat(dataRoot), {
        pid: daemonPid,
        apiPid,
        packageRoot: packageRoot || '',
        dataRoot,
        port
      })
    const ownershipUnchanged = (!daemonAlive || Boolean(packageRoot && daemonProcessMatches(host, daemonPid, packageRoot)))
      && (!apiAlive || Boolean(packageRoot && apiProcessMatches(host, apiPid, packageRoot)))
    if (!markersUnchanged || !ownershipUnchanged) return false
  }
  let killAccepted = true
  for (const pid of livePids) {
    if (!host.pidAlive(pid)) continue
    const stillOwned = Boolean(packageRoot)
      && (pid !== daemonPid || daemonProcessMatches(host, pid, packageRoot || ''))
      && (pid !== apiPid || apiProcessMatches(host, pid, packageRoot || ''))
    if (!stillOwned) return false
    try {
      if (!host.killPid(pid)) killAccepted = false
    } catch {
      killAccepted = false
    }
  }
  if (!killAccepted) {
    return false
  }
  if (livePids.length > 0) {
    let exited = false
    try {
      exited = host.waitForPidsExit(livePids, DAEMON_STOP_TIMEOUT_MS)
    } catch {
      return false
    }
    if (!exited || livePids.some((pid) => host.pidAlive(pid))) return false
  }
  const markerFiles = [files.pidFile, files.apiPidFile, files.heartbeatFile]
  if (markerFiles.every((file) => !fs.existsSync(file))) return true
  if (anyLive) {
    const markersStillIdentifyStoppedInstance = readPid(files.pidFile) === daemonPid
      && readPid(files.apiPidFile) === apiPid
      && Boolean(packageRoot)
      && heartbeatBindsInstance(readHeartbeat(dataRoot), {
        pid: daemonPid,
        apiPid,
        packageRoot: packageRoot || '',
        dataRoot,
        port
      })
    if (!markersStillIdentifyStoppedInstance) return false
  } else {
    const currentMarkerSnapshot = markerFiles.map((file) => {
      try {
        return fs.readFileSync(file, 'utf8')
      } catch {
        return null
      }
    })
    if (currentMarkerSnapshot.some((value, index) => value !== staleMarkerSnapshot[index])) return false
  }
  removeFile(files.pidFile)
  removeFile(files.apiPidFile)
  removeFile(files.heartbeatFile)
  return markerFiles.every((file) => !fs.existsSync(file))
}

function removeFile(file: string) {
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file)
  } catch {
    /* ignore */
  }
}

export async function reapDaemonSessions(
  local: Pick<LocalHost, 'application' | 'commandMeta' | 'localSessions'>
): Promise<boolean> {
  if (!local.localSessions?.needsReap()) return false
  const reaped = await local.application.execute({
    kind: 'reapSessions',
    meta: local.commandMeta('daemon')
  })
  if (!reaped.ok) throw new Error(`${reaped.error.code}: ${reaped.error.message}`)
  return true
}

export async function runDaemon(opts: DaemonRunOptions) {
  const host = opts.host || createInstallHost()
  const packageRoot = resolve(opts.packageRoot || opts.hubRoot)
  const dataRoot = resolveLocalDataRoot({ packageRoot, dataRoot: opts.dataRoot })
  const port = opts.port || Number(process.env.HUB_API_PORT || API_PORT)
  const intervalMs = opts.intervalMs || 5000
  const files = reviewFiles(dataRoot)
  fs.mkdirSync(files.review, { recursive: true })

  const claim = claimDaemonPid(files.pidFile, host, packageRoot, process.pid, dataRoot, port)
  if (!claim.claimed) {
    process.stderr.write(`skill-graft daemon not started: ${claim.reason} pid ${claim.existingPid || 0}\n`)
    return
  }
  rotateLog(files.logFile)
  let api: ChildProcess | null = null
  let cleaningUp = false
  const cleanup = () => {
    if (cleaningUp) return
    cleaningUp = true
    const childPid = api?.pid || readPid(files.apiPidFile)
    if (childPid && host.pidAlive(childPid)) {
      if (!apiProcessMatches(host, childPid, packageRoot)) return
      let killAccepted = false
      try {
        killAccepted = host.killPid(childPid)
      } catch {
        return
      }
      if (!killAccepted) return
      try {
        if (!host.waitForPidsExit([childPid], DAEMON_STOP_TIMEOUT_MS) || host.pidAlive(childPid)) return
      } catch {
        return
      }
    }
    if (!childPid || readPid(files.apiPidFile) === childPid) removeFile(files.apiPidFile)
    if (readPid(files.pidFile) === process.pid) removeFile(files.pidFile)
    const heartbeat = readHeartbeat(dataRoot)
    if (Number(heartbeat?.pid || 0) === process.pid) removeFile(files.heartbeatFile)
  }
  process.on('exit', cleanup)
  process.on('SIGINT', () => {
    cleanup()
    process.exit(0)
  })
  process.on('SIGTERM', () => {
    cleanup()
    process.exit(0)
  })
  process.on('SIGHUP', () => {
    cleanup()
    process.exit(0)
  })

  let starting = false
  let backoff = 1000
  const serverPath = join(packageRoot, 'server', 'index.mjs')
  const context = createHub(dataRoot)
  const runner = createCodexSessionRunner(context)
  const local = createLocalHost({
    packageRoot,
    dataRoot,
    hostId: 'local-daemon',
    context,
    localSessionOptions: { runner: { ...runner, pidAlive: (pid) => host.pidAlive(pid) } }
  })

  const log = (message: string) => {
    const line = `${new Date().toISOString()} ${message}\n`
    try {
      fs.appendFileSync(files.logFile, line, 'utf8')
    } catch {
      /* ignore */
    }
  }

  const writeBeat = (healthy: boolean) => {
    const payload = {
      pid: process.pid,
      apiPid: api?.pid || readPid(files.apiPidFile) || 0,
      hubRoot: dataRoot,
      packageRoot,
      dataRoot,
      port,
      apiHealthy: healthy,
      lastBeat: new Date().toISOString()
    }
    try {
      fs.writeFileSync(files.heartbeatFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    } catch {
      /* ignore */
    }
  }

  const startApi = () => {
    if (starting || (api && api.exitCode === null && api.signalCode === null)) return
    if (!fs.existsSync(serverPath)) {
      log(`missing API server ${serverPath}`)
      return
    }
    starting = true
    log(`starting API ${serverPath}`)
    let out = 0
    let child: ChildProcess
    try {
      out = fs.openSync(files.logFile, 'a')
      child = spawn(process.execPath, [serverPath], {
        cwd: packageRoot,
        env: {
          ...process.env,
          ...coherentDataRootEnvironment(dataRoot, host.platform),
          HUB_API_PORT: String(port)
        },
        stdio: ['ignore', out, out],
        windowsHide: true
      })
      api = child
    } catch (error) {
      starting = false
      log(`API spawn error ${error instanceof Error ? error.message : String(error)}`)
      return
    } finally {
      if (out) {
        try { fs.closeSync(out) } catch { /* the child owns its duplicated handles */ }
      }
    }
    if (child.pid) fs.writeFileSync(files.apiPidFile, `${child.pid}\n`, 'utf8')
    const clearApiPid = () => {
      try {
        if (child.pid && readPid(files.apiPidFile) === child.pid) fs.unlinkSync(files.apiPidFile)
      } catch {
        /* ignore */
      }
    }
    child.on('exit', (code, signal) => {
      log(`API exit code=${code} signal=${signal || ''}`)
      clearApiPid()
      if (api === child) api = null
      starting = false
      backoff = Math.min(backoff * 2, 15000)
    })
    child.on('error', (error) => {
      log(`API spawn error ${error instanceof Error ? error.message : String(error)}`)
      clearApiPid()
      if (api === child) api = null
      starting = false
    })
    setTimeout(() => {
      starting = false
    }, 1500)
  }

  log(`daemon start pid=${process.pid} package=${packageRoot} data=${dataRoot} port=${port}`)
  process.stderr.write(`skill-graft daemon pid ${process.pid}\n`)

  const tick = async () => {
    try {
      await reapDaemonSessions(local)
    } catch (error) {
      log(`session reap ${error instanceof Error ? error.message : String(error)}`)
    }
    const healthy = await pingApi(port, 1500, { packageRoot, dataRoot })
    if (healthy) {
      backoff = 1000
      await writeBeat(true)
      return
    }
    startApi()
    await writeBeat(false)
    await sleep(backoff)
  }

  await tick()
  for (;;) {
    await sleep(intervalMs)
    await tick()
  }
}

function rotateLog(file: string) {
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 2_000_000) {
      fs.renameSync(file, `${file}.old`)
    }
  } catch {
    /* ignore */
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
