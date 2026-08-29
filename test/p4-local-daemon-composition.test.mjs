import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createServer as createNodeHttpServer } from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { createInstallHost } from '../dist/adapters/install-host.js'
import { createDaemonProcessHost } from '../dist/adapters/daemon-process-host.js'
import {
  daemonProtocolPaths,
  inspectDaemonProtocol
} from '../dist/control/daemon-protocol.js'
import { runDaemon } from '../dist/control/daemon.js'
import {
  readDaemonLifecycleReceiptAuthority,
  setupHub
} from '../dist/control/install.js'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI = path.join(PACKAGE_ROOT, 'dist', 'control', 'cli.js')
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function freeLoopbackPort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const port = address.port
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

async function waitFor(probe, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (lastError) throw lastError
  throw new Error(`condition did not converge within ${timeoutMs}ms`)
}

function isolatedEnvironment(root, dataRoot, port) {
  const home = path.join(root, 'home')
  const temp = path.join(home, 'temp')
  fs.mkdirSync(temp, { recursive: true })
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'appdata'),
    LOCALAPPDATA: path.join(home, 'localappdata'),
    XDG_CONFIG_HOME: path.join(home, 'xdg-config'),
    TEMP: temp,
    TMP: temp,
    SKILL_GRAFT_HOME: dataRoot,
    HUB_ROOT: dataRoot,
    HUB_API_PORT: String(port),
    SG_INSTALL_DIR: path.join(home, 'install'),
    HUB_SPAWN_CODEX: '0',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
    SG_SKIP_PATH: '1',
    SG_SKIP_TASK: '1'
  }
}

function installHostFor(home, environment) {
  return createInstallHost({
    home,
    localAppData: environment.LOCALAPPDATA,
    skipPath: true,
    skipTask: true,
    env: (name) => environment[name],
    environment: () => ({ ...environment })
  })
}

function deterministicProcessHost(port) {
  const processIdentity = `p4-composition-${process.pid}`
  const processFacts = Object.freeze({
    state: 'alive',
    pid: process.pid,
    ppid: Math.max(1, process.ppid),
    processIdentity,
    pgid: process.pid,
    commandLine: `${process.execPath} p4-local-daemon-composition`
  })
  return Object.freeze({
    platform: process.platform,
    processFacts(pid) {
      return pid === process.pid ? processFacts : Object.freeze({ state: 'dead' })
    },
    processTree(rootPid, expectedIdentity) {
      if (rootPid !== process.pid || expectedIdentity !== processIdentity) {
        return Object.freeze({ state: 'unknown' })
      }
      return Object.freeze({
        state: 'exact',
        rootPid,
        rootProcessIdentity: processIdentity,
        entries: Object.freeze([processFacts])
      })
    },
    listenerFacts(expectedPort) {
      if (expectedPort !== port) return Object.freeze({ state: 'absent' })
      return Object.freeze({
        state: 'present',
        pids: Object.freeze([process.pid]),
        bindings: Object.freeze([Object.freeze({
          family: 'ipv4',
          address: '127.0.0.1',
          port,
          pid: process.pid
        })])
      })
    },
    terminateExactTree() {
      return Object.freeze({ state: 'unknown', pids: Object.freeze([process.pid]) })
    },
    waitForExit() {
      return Object.freeze({ state: 'unknown', pids: Object.freeze([process.pid]) })
    }
  })
}

function protocolOptions(home, dataRoot, host) {
  return {
    home,
    dataRoot,
    platform: process.platform,
    readReceiptAuthority: () => readDaemonLifecycleReceiptAuthority(dataRoot, host)
  }
}

function runCli(args, environment, timeout = 120_000) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: PACKAGE_ROOT,
    env: environment,
    encoding: 'utf8',
    windowsHide: true,
    timeout
  })
}

function parseCliJson(result, label) {
  assert.equal(result.error, undefined, `${label}: ${result.error?.stack || result.error}`)
  assert.equal(result.signal, null, `${label}: signal=${result.signal}\n${result.stderr || result.stdout}`)
  assert.equal(result.status, 0, `${label}: ${result.stderr || result.stdout}`)
  try {
    return JSON.parse(result.stdout)
  } catch (error) {
    throw new Error(`${label}: invalid JSON stdout: ${result.stdout}`, { cause: error })
  }
}

function diagnosticTree(root, maximum = 256) {
  if (!fs.existsSync(root)) return []
  const entries = []
  const visit = (directory) => {
    for (const name of fs.readdirSync(directory).sort()) {
      if (entries.length >= maximum) return
      const absolute = path.join(directory, name)
      const stat = fs.lstatSync(absolute)
      const relative = path.relative(root, absolute)
      entries.push(`${stat.isDirectory() ? 'd' : stat.isFile() ? 'f' : 'x'} ${relative}`)
      if (stat.isDirectory() && !stat.isSymbolicLink()) visit(absolute)
    }
  }
  visit(root)
  return entries
}

function diagnosticText(file, maximumBytes = 64 * 1024) {
  if (!fs.existsSync(file)) return '<absent>'
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) return '<not a plain file>'
  const bytes = fs.readFileSync(file)
  return bytes.subarray(0, maximumBytes).toString('utf8')
}

function reportSetupFailure(t, fixture, result) {
  t.diagnostic(`preserved failed setup run directory: ${fixture.root}`)
  t.diagnostic(`setup child error: ${result.error?.stack || result.error || '<none>'}`)
  t.diagnostic(`setup child stderr: ${result.stderr || '<empty>'}`)
  try {
    const payload = JSON.parse(result.stdout)
    t.diagnostic(`setup steps/issues: ${JSON.stringify({ steps: payload.steps, issues: payload.issues }, null, 2)}`)
  } catch {
    t.diagnostic(`setup stdout: ${result.stdout || '<empty>'}`)
  }
  const launcher = path.join(fixture.environment.SG_INSTALL_DIR, 'run-daemon.cmd')
  const daemonLog = path.join(fixture.dataRoot, 'skill-review', 'daemon.log')
  t.diagnostic(`run-daemon.cmd (${launcher}):\n${diagnosticText(launcher)}`)
  t.diagnostic(`daemon.log (${daemonLog}):\n${diagnosticText(daemonLog)}`)
  try {
    const inspection = inspectDaemonProtocol(fixture.options)
    t.diagnostic(`daemon protocol: ${JSON.stringify({
      kind: inspection.kind,
      reason: inspection.reason,
      reservation: inspection.reservation,
      instance: inspection.instance,
      publicProjectionCount: inspection.publicProjectionCount,
      stagePayloadCount: inspection.stagePayloadCount
    }, null, 2)}`)
  } catch (error) {
    t.diagnostic(`daemon protocol inspection failed: ${error?.stack || error}`)
  }
  t.diagnostic(`preserved run tree:\n${diagnosticTree(fixture.root).join('\n')}`)
}

async function createReceiptFixture(t, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`))
  const dataRoot = path.join(root, 'data')
  const port = await freeLoopbackPort()
  const environment = isolatedEnvironment(root, dataRoot, port)
  const home = environment.HOME
  const host = installHostFor(home, environment)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const setup = await setupHub(PACKAGE_ROOT, {
    dryRun: false,
    json: true,
    noDaemon: true,
    noPath: true,
    noTask: true
  }, host, dataRoot)
  assert.equal(setup.ok, true, JSON.stringify(setup.issues || setup, null, 2))
  return {
    root,
    home,
    dataRoot,
    port,
    environment,
    host,
    processHost: deterministicProcessHost(port),
    readReceiptAuthority: () => readDaemonLifecycleReceiptAuthority(dataRoot, host),
    options: protocolOptions(home, dataRoot, host)
  }
}

function epochHealthTransport(onCreate = () => {}) {
  return {
    createHttpCapability() {
      return Object.freeze({})
    },
    createHttpServer(options) {
      onCreate(options)
      assert.match(options.daemonEpoch, UUID)
      const server = createNodeHttpServer((_request, response) => {
        response.setHeader('Content-Type', 'application/json')
        response.setHeader('x-skill-graft-package-root', encodeURIComponent(options.packageRoot))
        response.setHeader('x-skill-graft-data-root', encodeURIComponent(options.dataRoot))
        response.setHeader('x-skill-graft-daemon-epoch', options.daemonEpoch)
        response.end('{"ok":true}')
      })
      return {
        server,
        close() {
          if (!server.listening) return Promise.resolve()
          server.closeAllConnections()
          return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
        }
      }
    }
  }
}

test('P4 production setup serves one Application/API process under a RUNNING-CLEAN epoch and D2 stop retires it', { timeout: 420_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-p4-daemon-production-'))
  const dataRoot = path.join(root, 'data')
  const port = await freeLoopbackPort()
  const environment = isolatedEnvironment(root, dataRoot, port)
  const home = environment.HOME
  const host = installHostFor(home, environment)
  const options = protocolOptions(home, dataRoot, host)
  const paths = daemonProtocolPaths(home, dataRoot)
  let daemonPid = 0
  let safelyStopped = false
  let preserveRoot = false
  t.after(async () => {
    if (!daemonPid) {
      try {
        const inspection = inspectDaemonProtocol(options)
        if (inspection.instance?.packageRoot === PACKAGE_ROOT
          && inspection.instance.dataRoot === dataRoot) daemonPid = inspection.instance.pid
      } catch { /* no exact protocol instance to clean */ }
    }
    if (!safelyStopped && daemonPid && processAlive(daemonPid)) {
      runCli(['daemon', 'stop'], environment, 120_000)
    }
    if (daemonPid && processAlive(daemonPid)) {
      try { process.kill(daemonPid, 'SIGTERM') } catch { /* already exited */ }
      await waitFor(() => !processAlive(daemonPid), 10_000).catch(() => {})
    }
    if (!preserveRoot) fs.rmSync(root, { recursive: true, force: true })
  })

  const setupStartedAt = Date.now()
  const setupCommand = runCli(['setup', '--json', '--no-path', '--no-task'], environment, 300_000)
  t.diagnostic(`real isolated sg setup elapsed ${Date.now() - setupStartedAt}ms`)
  if (setupCommand.error || setupCommand.status !== 0) {
    preserveRoot = true
    reportSetupFailure(t, { root, dataRoot, environment, options }, setupCommand)
  }
  const setup = parseCliJson(setupCommand, 'real isolated sg setup')
  assert.equal(setup.ok, true, JSON.stringify(setup.issues || setup, null, 2))

  const running = await waitFor(() => {
    const inspection = inspectDaemonProtocol(options)
    if (inspection.kind === 'INVALID') throw new Error(inspection.reason || 'invalid daemon protocol')
    return inspection.kind === 'RUNNING-CLEAN' ? inspection : null
  })
  assert.ok(running.instance)
  daemonPid = running.instance.pid
  assert.equal(running.instance.apiPid, daemonPid)
  assert.equal(running.instance.port, port)
  assert.match(running.instance.epochId, UUID)
  assert.equal(processAlive(daemonPid), true)

  const processHost = createDaemonProcessHost()
  const processFacts = processHost.processFacts(daemonPid)
  assert.equal(processFacts.state, 'alive')
  assert.equal(processFacts.processIdentity, running.instance.processIdentity)
  assert.equal(processFacts.pgid, running.instance.pgid)
  const listeners = processHost.listenerFacts(port)
  assert.equal(listeners.state, 'present')
  assert.deepEqual(listeners.pids, [daemonPid])

  const health = await fetch(`http://127.0.0.1:${port}/api/health`)
  assert.equal(health.status, 200)
  assert.equal((await health.json()).ok, true)
  assert.equal(health.headers.get('x-skill-graft-daemon-epoch'), running.instance.epochId)
  assert.equal(decodeURIComponent(health.headers.get('x-skill-graft-package-root')), PACKAGE_ROOT)
  assert.equal(decodeURIComponent(health.headers.get('x-skill-graft-data-root')), dataRoot)

  const response = await fetch(`http://127.0.0.1:${port}/api/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'status', requestId: 'p4-daemon-single-application-status' })
  })
  assert.equal(response.status, 200)
  const envelope = await response.json()
  assert.equal(envelope.contractVersion, 1)
  assert.equal(envelope.commandKind, 'status')
  assert.equal(envelope.ok, true)

  const stopStartedAt = Date.now()
  const stopCommand = runCli(['daemon', 'stop'], environment, 180_000)
  t.diagnostic(`D2 daemon stop elapsed ${Date.now() - stopStartedAt}ms`)
  const stopped = parseCliJson(stopCommand, 'D2 daemon stop')
  assert.equal(stopped.ok, true)
  assert.equal(stopped.stopped, true)
  await waitFor(() => !processAlive(daemonPid), 15_000)
  safelyStopped = true
  const absent = await waitFor(() => {
    const inspection = inspectDaemonProtocol(options)
    return inspection.kind === 'ABSENT' ? inspection : null
  }, 15_000)
  assert.equal(absent.instance, null)
  for (const file of [paths.pidProjection, paths.apiPidProjection, paths.heartbeatProjection, paths.finalInstance]) {
    assert.equal(fs.existsSync(file), false, file)
  }
  assert.equal(fs.existsSync(paths.stageDirectory), true)
})

test('P4 daemon startup closes an already-listening transport before propagating a later bind failure', { timeout: 120_000 }, async (t) => {
  const fixture = await createReceiptFixture(t, 'skill-graft-p4-daemon-startup')
  let factories = 0
  let firstServer
  const transportInputs = []
  const baseTransport = epochHealthTransport((options) => transportInputs.push(options))
  const httpModule = {
    createHttpCapability: baseTransport.createHttpCapability,
    createHttpServer(options) {
      factories += 1
      if (factories === 2) throw Object.assign(new Error('injected second transport failure'), { code: 'EACCES' })
      const transport = baseTransport.createHttpServer(options)
      firstServer = transport.server
      return transport
    }
  }
  t.after(async () => {
    if (firstServer?.listening) {
      firstServer.closeAllConnections()
      await new Promise((resolve) => firstServer.close(() => resolve()))
    }
  })

  await assert.rejects(
    runDaemon({
      hubRoot: PACKAGE_ROOT,
      packageRoot: PACKAGE_ROOT,
      dataRoot: fixture.dataRoot,
      port: fixture.port,
      intervalMs: 10,
      host: fixture.host,
      home: fixture.home,
      readReceiptAuthority: fixture.readReceiptAuthority,
      processHost: fixture.processHost,
      httpModule
    }),
    /injected second transport failure/
  )
  assert.equal(firstServer?.listening, false)
  assert.equal(transportInputs.length, 1)
  assert.match(transportInputs[0].daemonEpoch, UUID)

  const rebound = net.createServer()
  await new Promise((resolve, reject) => {
    rebound.once('error', reject)
    rebound.listen(fixture.port, '127.0.0.1', resolve)
  })
  await new Promise((resolve, reject) => rebound.close((error) => error ? reject(error) : resolve()))

  const inspection = inspectDaemonProtocol(fixture.options)
  assert.equal(inspection.kind, 'ABSENT', inspection.reason || inspection.kind)
  const paths = daemonProtocolPaths(fixture.home, fixture.dataRoot)
  for (const file of [paths.pidProjection, paths.apiPidProjection, paths.heartbeatProjection, paths.finalInstance]) {
    assert.equal(fs.existsSync(file), false, file)
  }
})

test('P4 daemon startup detects a same-byte readiness retarget, preserves evidence, and remains structurally recoverable', { timeout: 120_000 }, async (t) => {
  const fixture = await createReceiptFixture(t, 'skill-graft-p4-daemon-ready-seal')
  const transports = []
  let releaseCalls = 0
  let replacementBytes
  const paths = daemonProtocolPaths(fixture.home, fixture.dataRoot)
  const displacedApiPid = `${paths.apiPidProjection}.original`
  const baseTransport = epochHealthTransport()
  const httpModule = {
    createHttpCapability: baseTransport.createHttpCapability,
    createHttpServer(options) {
      const transport = baseTransport.createHttpServer(options)
      transports.push(transport.server)
      return transport
    }
  }
  t.after(async () => {
    await Promise.all(transports.map((server) => {
      if (!server.listening) return Promise.resolve()
      server.closeAllConnections()
      return new Promise((resolve) => server.close(() => resolve()))
    }))
  })

  await assert.rejects(runDaemon({
    hubRoot: PACKAGE_ROOT,
    packageRoot: PACKAGE_ROOT,
    dataRoot: fixture.dataRoot,
    port: fixture.port,
    intervalMs: 10,
    host: fixture.host,
    home: fixture.home,
    readReceiptAuthority: fixture.readReceiptAuthority,
    processHost: fixture.processHost,
    httpModule,
    onStartupReady: () => {
      replacementBytes = fs.readFileSync(paths.apiPidProjection)
      fs.renameSync(paths.apiPidProjection, displacedApiPid)
      fs.writeFileSync(paths.apiPidProjection, replacementBytes)
    },
    releaseStartupAuthority: async (terminalSeal) => {
      releaseCalls += 1
      await terminalSeal()
    }
  }), /changed|frozen|identity|current/i)

  assert.equal(releaseCalls, 0)
  assert.deepEqual(fs.readFileSync(paths.apiPidProjection), replacementBytes)
  assert.equal(fs.existsSync(displacedApiPid), true)
  assert.equal(transports.some((server) => server.listening), false)

  const preserved = inspectDaemonProtocol(fixture.options)
  assert.equal(preserved.kind, 'INVALID')
  assert.match(preserved.reason, /API PID projection does not match its immutable file identity/)
  for (const file of [paths.pidProjection, paths.apiPidProjection, paths.heartbeatProjection, paths.finalInstance]) {
    assert.equal(fs.existsSync(file), true, file)
  }
  fs.rmSync(paths.apiPidProjection)
  fs.renameSync(displacedApiPid, paths.apiPidProjection)
  const restored = inspectDaemonProtocol(fixture.options)
  assert.equal(restored.kind, 'RUNNING-CLEAN', restored.reason || restored.kind)
})

test('P4 production imports and wires daemon protocol/runtime authority instead of leaving it test-only', () => {
  const daemonSource = fs.readFileSync(path.join(PACKAGE_ROOT, 'src', 'control', 'daemon.ts'), 'utf8')
  const installSource = fs.readFileSync(path.join(PACKAGE_ROOT, 'src', 'control', 'install.ts'), 'utf8')
  const cliSource = fs.readFileSync(path.join(PACKAGE_ROOT, 'src', 'control', 'cli.ts'), 'utf8')
  const serverSource = fs.readFileSync(path.join(PACKAGE_ROOT, 'server', 'index.mjs'), 'utf8')

  assert.match(daemonSource, /from '\.\/daemon-runtime\.js'/)
  assert.match(daemonSource, /from '\.\.\/adapters\/daemon-process-host\.js'/)
  assert.match(daemonSource, /reconcileDaemonRuntimeForStart/)
  assert.match(daemonSource, /commitDaemonRuntimeStart/)
  assert.match(daemonSource, /daemonEpoch/)
  assert.match(installSource, /from '\.\/daemon-(?:protocol|runtime)\.js'/)
  assert.match(installSource, /from '\.\/daemon-control-runtime\.js'/)
  assert.match(installSource, /observeDaemonAuthority/)
  assert.match(installSource, /stopDaemonRuntime/)
  assert.match(cliSource, /readReceiptAuthority:\s*\(\)\s*=>\s*readDaemonLifecycleReceiptAuthority/)
  assert.match(serverSource, /X-Skill-Graft-Daemon-Epoch/)
})
