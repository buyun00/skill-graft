import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import { join } from 'node:path'
import { createHub } from '../adapters/create-hub.js'
import { API_PORT } from '../core/install.js'
import { reapSessions } from '../core/index.js'
import { createInstallHost, type InstallHost } from '../adapters/install-host.js'

export type DaemonRunOptions = {
  hubRoot: string
  port?: number
  intervalMs?: number
  host?: InstallHost
}

export function reviewFiles(hubRoot: string) {
  const review = join(hubRoot, 'skill-review')
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

export function readHeartbeat(hubRoot: string): Record<string, unknown> | null {
  const file = reviewFiles(hubRoot).heartbeatFile
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

export async function pingApi(port: number, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) })
    return res.ok
  } catch {
    return false
  }
}

export async function waitForApi(port: number, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await pingApi(port)) return true
    await sleep(250)
  }
  return pingApi(port)
}

export function stopDaemon(hubRoot: string, host: InstallHost = createInstallHost()): boolean {
  const files = reviewFiles(hubRoot)
  const daemonPid = readPid(files.pidFile)
  const apiPid = readPid(files.apiPidFile)
  let stopped = false
  if (daemonPid && host.pidAlive(daemonPid)) {
    host.killPid(daemonPid)
    stopped = true
  }
  if (apiPid && host.pidAlive(apiPid)) {
    host.killPid(apiPid)
    stopped = true
  }
  try {
    if (fs.existsSync(files.pidFile)) fs.unlinkSync(files.pidFile)
  } catch {
    /* ignore */
  }
  try {
    if (fs.existsSync(files.apiPidFile)) fs.unlinkSync(files.apiPidFile)
  } catch {
    /* ignore */
  }
  return stopped || (!daemonPid && !apiPid)
}

export async function runDaemon(opts: DaemonRunOptions) {
  const host = opts.host || createInstallHost()
  const hubRoot = opts.hubRoot
  const port = opts.port || Number(process.env.HUB_API_PORT || API_PORT)
  const intervalMs = opts.intervalMs || 5000
  const files = reviewFiles(hubRoot)
  fs.mkdirSync(files.review, { recursive: true })

  const existing = readPid(files.pidFile)
  if (existing && existing !== process.pid && host.pidAlive(existing)) {
    process.stderr.write(`skill-graft daemon already running pid ${existing}\n`)
    return
  }
  rotateLog(files.logFile)
  fs.writeFileSync(files.pidFile, `${process.pid}\n`, 'utf8')
  const cleanup = () => {
    try {
      if (readPid(files.pidFile) === process.pid) fs.unlinkSync(files.pidFile)
    } catch {
      /* ignore */
    }
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

  let api: ChildProcess | null = null
  let starting = false
  let backoff = 1000
  const serverPath = join(hubRoot, 'server', 'index.mjs')

  const log = (message: string) => {
    const line = `${new Date().toISOString()} ${message}\n`
    try {
      fs.appendFileSync(files.logFile, line, 'utf8')
    } catch {
      /* ignore */
    }
  }

  const writeBeat = async (healthy: boolean) => {
    const payload = {
      pid: process.pid,
      apiPid: api?.pid || readPid(files.apiPidFile) || 0,
      hubRoot,
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
    if (starting) return
    if (!fs.existsSync(serverPath)) {
      log(`missing API server ${serverPath}`)
      return
    }
    starting = true
    log(`starting API ${serverPath}`)
    const out = fs.openSync(files.logFile, 'a')
    api = spawn(process.execPath, [serverPath], {
      cwd: hubRoot,
      env: { ...process.env, HUB_ROOT: hubRoot, HUB_API_PORT: String(port) },
      stdio: ['ignore', out, out],
      windowsHide: true
    })
    if (api.pid) fs.writeFileSync(files.apiPidFile, `${api.pid}\n`, 'utf8')
    api.on('exit', (code, signal) => {
      log(`API exit code=${code} signal=${signal || ''}`)
      api = null
      starting = false
      backoff = Math.min(backoff * 2, 15000)
    })
    api.on('error', (error) => {
      log(`API spawn error ${error instanceof Error ? error.message : String(error)}`)
      starting = false
    })
    setTimeout(() => {
      starting = false
    }, 1500)
  }

  log(`daemon start pid=${process.pid} hub=${hubRoot} port=${port}`)
  process.stderr.write(`skill-graft daemon pid ${process.pid}\n`)

  const tick = async () => {
    try {
      reapSessions(createHub(hubRoot), (pid) => host.pidAlive(pid))
    } catch (error) {
      log(`session reap ${error instanceof Error ? error.message : String(error)}`)
    }
    const healthy = await pingApi(port)
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
