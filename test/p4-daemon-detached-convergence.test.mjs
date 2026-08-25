import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createInstallHost } from '../dist/adapters/install-host.js'
import {
  readDaemonLifecycleReceiptAuthority,
  startDaemonDetached
} from '../dist/control/install.js'
import {
  acquireCommittedDaemonStartCollapseAuthority,
  bootstrapDaemonStageNamespace,
  collapseCommittedDaemonStart,
  commitDaemonStartInstance,
  createDaemonStartStage,
  daemonProtocolPaths,
  inspectDaemonProtocol,
  inspectDaemonReceiptNamespace,
  parseDaemonReservationName,
  publishDaemonStartProjection
} from '../dist/control/daemon-protocol.js'
import { renderShims, resolveInstallPaths } from '../dist/index.js'

const IDS = Object.freeze({
  install: '11111111-1111-4111-8111-111111111111',
  data: '22222222-2222-4222-8222-222222222222',
  namespace: '33333333-3333-4333-8333-333333333333',
  epoch: '44444444-4444-4444-8444-444444444444'
})
const DAEMON_PID = 91_001
const LAUNCHER_PID = 91_000
const DEAD_LAUNCHER_PIDS = Object.freeze([91_100, 91_101])
const PROCESS_IDENTITY = 'detached-convergence-daemon-91001'
const CREATED_AT = '2026-08-24T00:00:01.000Z'
const STARTUP_WINDOW_MS = 240_000

const pathApi = Object.freeze({
  join: (...parts) => path.join(...parts),
  resolve: (...parts) => path.resolve(...parts),
  dirname: (value) => path.dirname(value),
  basename: (value) => path.basename(value)
})

function reservationEvidence(directory) {
  return fs.readdirSync(directory)
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
    .map((name) => {
      const file = path.join(directory, name)
      const stat = fs.lstatSync(file)
      return {
        name,
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        nlink: stat.nlink,
        bytes: stat.isFile() ? fs.readFileSync(file).toString('hex') : null
      }
    })
}

function createFixture(t, port) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-p4-detached-convergence-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const dataRoot = path.join(home, 'data')
  const packageRoot = path.join(home, 'package')
  const installDir = path.join(home, 'install')
  const protocolPaths = daemonProtocolPaths(home, dataRoot)

  fs.mkdirSync(protocolPaths.receiptDirectory, { recursive: true })
  fs.mkdirSync(protocolPaths.reviewDirectory, { recursive: true })
  fs.mkdirSync(path.join(packageRoot, 'dist', 'control'), { recursive: true })
  fs.mkdirSync(path.join(packageRoot, 'server'), { recursive: true })
  fs.mkdirSync(installDir, { recursive: true })
  fs.writeFileSync(path.join(packageRoot, 'dist', 'control', 'cli.js'), '// detached convergence fixture\n')
  fs.writeFileSync(path.join(packageRoot, 'server', 'index.mjs'), '// detached convergence fixture\n')
  fs.writeFileSync(protocolPaths.receiptNamespaceMarker, '', { flag: 'wx' })
  fs.writeFileSync(protocolPaths.receiptFile, `${JSON.stringify({
    schemaVersion: 1,
    product: 'skill-graft',
    installId: IDS.install,
    dataRootId: IDS.data,
    dataRoot,
    installDir,
    packageRoot,
    packageVersion: '1.0.0',
    packageSha256: `sha256:${'a'.repeat(64)}`,
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
    state: 'active'
  })}\n`, { flag: 'wx' })

  const installPaths = resolveInstallPaths(pathApi, {
    hubRoot: packageRoot,
    packageRoot,
    dataRoot,
    nodePath: process.execPath,
    installDir,
    extraShimDir: null,
    port
  })
  const launchers = renderShims(installPaths, undefined, {
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: home
  })
  fs.writeFileSync(installPaths.silentVbs, launchers.vbs)
  fs.writeFileSync(installPaths.runDaemonCmd, launchers.runDaemonCmd)

  let launched = false
  let launchCalls = 0
  let terminationCalls = 0
  let stage = null
  let options = null
  let displacedManifest = ''
  let invalidEvidence = null
  let host

  const processEntry = Object.freeze({
    state: 'alive',
    pid: DAEMON_PID,
    ppid: LAUNCHER_PID,
    processIdentity: PROCESS_IDENTITY,
    pgid: DAEMON_PID,
    commandLine: `node "${path.join(packageRoot, 'dist', 'control', 'cli.js')}" daemon run`
  })
  const processHost = Object.freeze({
    platform: 'win32',
    processFacts(pid) {
      return launched && pid === DAEMON_PID ? processEntry : Object.freeze({ state: 'dead' })
    },
    processTree(rootPid, expectedIdentity) {
      if (!launched || rootPid !== DAEMON_PID || expectedIdentity !== PROCESS_IDENTITY) {
        return Object.freeze({ state: 'unknown' })
      }
      return Object.freeze({
        state: 'exact',
        rootPid: DAEMON_PID,
        rootProcessIdentity: PROCESS_IDENTITY,
        entries: Object.freeze([processEntry])
      })
    },
    listenerFacts(requestedPort) {
      if (!launched || requestedPort !== port) return Object.freeze({ state: 'absent' })
      return Object.freeze({
        state: 'present',
        pids: Object.freeze([DAEMON_PID]),
        bindings: Object.freeze([Object.freeze({
          family: 'ipv4',
          address: '127.0.0.1',
          port,
          pid: DAEMON_PID
        })])
      })
    },
    terminateExactTree() {
      terminationCalls += 1
      return Object.freeze({ state: 'signaled', pids: Object.freeze([DAEMON_PID]) })
    },
    waitForExit() {
      return Object.freeze({ state: 'timeout', pids: Object.freeze([DAEMON_PID]) })
    }
  })

  const beginInvalidStart = () => {
    launched = true
    const readReceiptAuthority = () => readDaemonLifecycleReceiptAuthority(dataRoot, host)
    options = Object.freeze({ home, dataRoot, platform: 'win32', readReceiptAuthority })
    const expectedInspection = inspectDaemonProtocol(options)
    assert.equal(expectedInspection.kind, 'ABSENT', expectedInspection.reason || expectedInspection.kind)
    const authority = bootstrapDaemonStageNamespace({
      ...options,
      expectedInspection,
      expectedReceiptAuthority: inspectDaemonReceiptNamespace(home, dataRoot, readReceiptAuthority),
      namespaceId: IDS.namespace
    })
    stage = createDaemonStartStage(authority, {
      epochId: IDS.epoch,
      pid: DAEMON_PID,
      apiPid: DAEMON_PID,
      processIdentity: PROCESS_IDENTITY,
      pgid: DAEMON_PID,
      port,
      createdAt: CREATED_AT
    })
    for (const projection of ['pid', 'apiPid', 'heartbeat']) {
      publishDaemonStartProjection(stage, projection)
    }
    commitDaemonStartInstance(stage)
    const committed = inspectDaemonProtocol(options)
    assert.equal(committed.kind, 'RUNNING-LINKED', committed.reason || committed.kind)
    displacedManifest = path.join(home, 'committed-start-manifest.original')
    fs.renameSync(stage.files.manifest.file, displacedManifest)
    fs.writeFileSync(stage.files.manifest.file, '{"schemaVersion":')
    const invalid = inspectDaemonProtocol(options)
    assert.equal(invalid.kind, 'INVALID', invalid.reason || invalid.kind)
    assert.equal(parseDaemonReservationName(stage.reservationName)?.operation, 'start')
    invalidEvidence = reservationEvidence(stage.reservationDirectory)
  }

  host = createInstallHost({
    platform: 'win32',
    home,
    localAppData: home,
    skipPath: true,
    skipTask: true,
    environment: () => Object.freeze({
      SKILL_GRAFT_HOME: dataRoot,
      HUB_ROOT: dataRoot,
      SG_INSTALL_DIR: installDir,
      HUB_API_PORT: String(port)
    }),
    extraShimDir: () => null,
    pidAlive: (pid) => pid === process.pid || launched && pid === DAEMON_PID,
    wmiCreate: () => {
      launchCalls += 1
      beginInvalidStart()
      return LAUNCHER_PID
    }
  })

  const finishStart = () => {
    assert.ok(stage && options && displacedManifest)
    fs.unlinkSync(stage.files.manifest.file)
    fs.renameSync(displacedManifest, stage.files.manifest.file)
    const restored = inspectDaemonProtocol(options)
    assert.equal(restored.kind, 'RUNNING-LINKED', restored.reason || restored.kind)
    collapseCommittedDaemonStart(acquireCommittedDaemonStartCollapseAuthority(
      options,
      inspectDaemonProtocol(options)
    ))
    const terminal = inspectDaemonProtocol(options)
    assert.equal(terminal.kind, 'RUNNING-CLEAN', terminal.reason || terminal.kind)
  }

  return {
    home,
    dataRoot,
    packageRoot,
    host,
    processHost,
    finishStart,
    inspection: () => inspectDaemonProtocol(options),
    invalidEvidence: () => invalidEvidence,
    currentReservationEvidence: () => reservationEvidence(stage.reservationDirectory),
    launchCalls: () => launchCalls,
    terminationCalls: () => terminationCalls
  }
}

function createDeadLauncherFixture(t, port, succeedOnRetry) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-p4-dead-launcher-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const dataRoot = path.join(home, 'data')
  const packageRoot = path.join(home, 'package')
  const installDir = path.join(home, 'install')
  const protocolPaths = daemonProtocolPaths(home, dataRoot)

  fs.mkdirSync(protocolPaths.receiptDirectory, { recursive: true })
  fs.mkdirSync(protocolPaths.reviewDirectory, { recursive: true })
  fs.mkdirSync(path.join(packageRoot, 'dist', 'control'), { recursive: true })
  fs.mkdirSync(path.join(packageRoot, 'server'), { recursive: true })
  fs.mkdirSync(installDir, { recursive: true })
  fs.writeFileSync(path.join(packageRoot, 'dist', 'control', 'cli.js'), '// dead launcher fixture\n')
  fs.writeFileSync(path.join(packageRoot, 'server', 'index.mjs'), '// dead launcher fixture\n')
  fs.writeFileSync(protocolPaths.receiptNamespaceMarker, '', { flag: 'wx' })
  fs.writeFileSync(protocolPaths.receiptFile, `${JSON.stringify({
    schemaVersion: 1,
    product: 'skill-graft',
    installId: IDS.install,
    dataRootId: IDS.data,
    dataRoot,
    installDir,
    packageRoot,
    packageVersion: '1.0.0',
    packageSha256: `sha256:${'a'.repeat(64)}`,
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
    state: 'active'
  })}\n`, { flag: 'wx' })

  const installPaths = resolveInstallPaths(pathApi, {
    hubRoot: packageRoot,
    packageRoot,
    dataRoot,
    nodePath: process.execPath,
    installDir,
    extraShimDir: null,
    port
  })
  const launchers = renderShims(installPaths, undefined, {
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: home
  })
  fs.writeFileSync(installPaths.silentVbs, launchers.vbs)
  fs.writeFileSync(installPaths.runDaemonCmd, launchers.runDaemonCmd)

  let runtimeLaunched = false
  let launchCalls = 0
  let terminationCalls = 0
  const launcherFactCalls = [0, 0]
  let host

  const processEntry = Object.freeze({
    state: 'alive',
    pid: DAEMON_PID,
    ppid: DEAD_LAUNCHER_PIDS[1],
    processIdentity: PROCESS_IDENTITY,
    pgid: DAEMON_PID,
    commandLine: `node "${path.join(packageRoot, 'dist', 'control', 'cli.js')}" daemon run`
  })
  const processHost = Object.freeze({
    platform: 'win32',
    processFacts(pid) {
      if (runtimeLaunched && pid === DAEMON_PID) return processEntry
      const launcherIndex = DEAD_LAUNCHER_PIDS.indexOf(pid)
      if (launcherIndex >= 0) launcherFactCalls[launcherIndex] += 1
      return Object.freeze({ state: 'dead' })
    },
    processTree(rootPid, expectedIdentity) {
      if (!runtimeLaunched || rootPid !== DAEMON_PID || expectedIdentity !== PROCESS_IDENTITY) {
        return Object.freeze({ state: 'unknown' })
      }
      return Object.freeze({
        state: 'exact',
        rootPid: DAEMON_PID,
        rootProcessIdentity: PROCESS_IDENTITY,
        entries: Object.freeze([processEntry])
      })
    },
    listenerFacts(requestedPort) {
      if (!runtimeLaunched || requestedPort !== port) return Object.freeze({ state: 'absent' })
      return Object.freeze({
        state: 'present',
        pids: Object.freeze([DAEMON_PID]),
        bindings: Object.freeze([Object.freeze({
          family: 'ipv4',
          address: '127.0.0.1',
          port,
          pid: DAEMON_PID
        })])
      })
    },
    terminateExactTree() {
      terminationCalls += 1
      return Object.freeze({ state: 'signaled', pids: Object.freeze([DAEMON_PID]) })
    },
    waitForExit() {
      return Object.freeze({ state: 'timeout', pids: Object.freeze([DAEMON_PID]) })
    }
  })

  const publishCleanRuntime = () => {
    runtimeLaunched = true
    const readReceiptAuthority = () => readDaemonLifecycleReceiptAuthority(dataRoot, host)
    const options = Object.freeze({ home, dataRoot, platform: 'win32', readReceiptAuthority })
    const expectedInspection = inspectDaemonProtocol(options)
    assert.equal(expectedInspection.kind, 'ABSENT', expectedInspection.reason || expectedInspection.kind)
    const authority = bootstrapDaemonStageNamespace({
      ...options,
      expectedInspection,
      expectedReceiptAuthority: inspectDaemonReceiptNamespace(home, dataRoot, readReceiptAuthority),
      namespaceId: IDS.namespace
    })
    const stage = createDaemonStartStage(authority, {
      epochId: IDS.epoch,
      pid: DAEMON_PID,
      apiPid: DAEMON_PID,
      processIdentity: PROCESS_IDENTITY,
      pgid: DAEMON_PID,
      port,
      createdAt: CREATED_AT
    })
    for (const projection of ['pid', 'apiPid', 'heartbeat']) {
      publishDaemonStartProjection(stage, projection)
    }
    commitDaemonStartInstance(stage)
    collapseCommittedDaemonStart(acquireCommittedDaemonStartCollapseAuthority(
      options,
      inspectDaemonProtocol(options)
    ))
    const terminal = inspectDaemonProtocol(options)
    assert.equal(terminal.kind, 'RUNNING-CLEAN', terminal.reason || terminal.kind)
  }

  host = createInstallHost({
    platform: 'win32',
    home,
    localAppData: home,
    skipPath: true,
    skipTask: true,
    environment: () => Object.freeze({
      SKILL_GRAFT_HOME: dataRoot,
      HUB_ROOT: dataRoot,
      SG_INSTALL_DIR: installDir,
      HUB_API_PORT: String(port)
    }),
    extraShimDir: () => null,
    pidAlive: (pid) => pid === process.pid || runtimeLaunched && pid === DAEMON_PID,
    wmiCreate: () => {
      launchCalls += 1
      if (succeedOnRetry && launchCalls === 2) publishCleanRuntime()
      return DEAD_LAUNCHER_PIDS[Math.min(launchCalls - 1, DEAD_LAUNCHER_PIDS.length - 1)]
    }
  })

  return {
    dataRoot,
    packageRoot,
    host,
    processHost,
    inspection: () => inspectDaemonProtocol({
      home,
      dataRoot,
      platform: 'win32',
      readReceiptAuthority: () => readDaemonLifecycleReceiptAuthority(dataRoot, host)
    }),
    launchCalls: () => launchCalls,
    launcherFactCalls: () => [...launcherFactCalls],
    terminationCalls: () => terminationCalls
  }
}

test('detached start retries one transient INVALID START reservation and accepts RUNNING-CLEAN', async (t) => {
  const fixture = createFixture(t, 23_051)
  let clock = 0
  let sleepCalls = 0
  let repaired = false
  let repairAtSleepCall = 0
  const result = await startDaemonDetached(fixture.packageRoot, fixture.host, fixture.dataRoot, {
    now: () => clock,
    sleep: async (milliseconds) => {
      sleepCalls += 1
      if (!repaired) {
        repaired = true
        repairAtSleepCall = sleepCalls
        fixture.finishStart()
      }
      clock += milliseconds
    },
    ping: async () => true,
    processHost: fixture.processHost
  })

  assert.equal(result.ok, true, result.detail)
  assert.equal(result.pid, DAEMON_PID)
  assert.equal(result.apiHealthy, true)
  assert.equal(fixture.inspection().kind, 'RUNNING-CLEAN')
  assert.equal(fixture.launchCalls(), 1)
  assert.equal(repairAtSleepCall, 1)
  assert.ok(sleepCalls >= 1)
  assert.ok(clock < STARTUP_WINDOW_MS)
  assert.equal(fixture.terminationCalls(), 0)
})

test('detached start fails closed after bounded stable INVALID START samples without mutation', async (t) => {
  const fixture = createFixture(t, 23_052)
  let clock = 0
  let sleepCalls = 0
  const result = await startDaemonDetached(fixture.packageRoot, fixture.host, fixture.dataRoot, {
    now: () => clock,
    sleep: async (milliseconds) => {
      sleepCalls += 1
      clock += milliseconds
    },
    ping: async () => true,
    processHost: fixture.processHost
  })

  assert.equal(result.ok, false)
  assert.equal(result.pid, 0)
  assert.equal(result.apiHealthy, false)
  assert.match(result.detail, /control-required\/INVALID/)
  assert.equal(fixture.inspection().kind, 'INVALID')
  assert.deepEqual(fixture.currentReservationEvidence(), fixture.invalidEvidence())
  assert.equal(fixture.launchCalls(), 1)
  assert.equal(sleepCalls, 8)
  assert.equal(fixture.terminationCalls(), 0)
})

test('detached start relaunches once after a dead launcher with stable ABSENT authority', async (t) => {
  const fixture = createDeadLauncherFixture(t, 23_053, true)
  let clock = 0
  let sleepCalls = 0
  const result = await startDaemonDetached(fixture.packageRoot, fixture.host, fixture.dataRoot, {
    now: () => clock,
    sleep: async (milliseconds) => {
      sleepCalls += 1
      clock += milliseconds
    },
    ping: async () => true,
    processHost: fixture.processHost
  })

  assert.equal(result.ok, true, result.detail)
  assert.equal(result.pid, DAEMON_PID)
  assert.equal(result.apiHealthy, true)
  assert.equal(fixture.inspection().kind, 'RUNNING-CLEAN')
  assert.equal(fixture.launchCalls(), 2)
  assert.deepEqual(fixture.launcherFactCalls(), [4, 0])
  assert.ok(sleepCalls >= 3)
  assert.ok(clock < STARTUP_WINDOW_MS)
  assert.equal(fixture.terminationCalls(), 0)
})

test('detached start fails quickly after two dead launchers and never launches a third', async (t) => {
  const fixture = createDeadLauncherFixture(t, 23_054, false)
  let clock = 0
  let sleepCalls = 0
  const result = await startDaemonDetached(fixture.packageRoot, fixture.host, fixture.dataRoot, {
    now: () => clock,
    sleep: async (milliseconds) => {
      sleepCalls += 1
      clock += milliseconds
    },
    ping: async () => true,
    processHost: fixture.processHost
  })

  assert.equal(result.ok, false)
  assert.equal(result.pid, 0)
  assert.equal(result.apiHealthy, false)
  assert.match(result.detail, new RegExp(`launched pids ${DEAD_LAUNCHER_PIDS.join(',')}`))
  assert.equal(fixture.inspection().kind, 'ABSENT')
  assert.equal(fixture.launchCalls(), 2)
  assert.deepEqual(fixture.launcherFactCalls(), [4, 4])
  assert.equal(sleepCalls, 6)
  assert.equal(clock, 1_500)
  assert.equal(fixture.terminationCalls(), 0)
})
