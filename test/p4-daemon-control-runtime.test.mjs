import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { stopDaemonRuntime } from '../dist/control/daemon-control-runtime.js'
import {
  acquireCommittedDaemonStartCollapseAuthority,
  bootstrapDaemonStageNamespace,
  collapseCommittedDaemonStart,
  commitDaemonStartInstance,
  createDaemonStartStage,
  createDaemonStopStage,
  daemonProtocolPaths,
  inspectDaemonProtocol,
  inspectDaemonReceiptNamespace,
  publishDaemonStartProjection
} from '../dist/control/daemon-protocol.js'

const IDS = Object.freeze({
  install: '11111111-1111-4111-8111-111111111111',
  data: '22222222-2222-4222-8222-222222222222',
  namespace: '33333333-3333-4333-8333-333333333333',
  epoch: '44444444-4444-4444-8444-444444444444',
  operation: '55555555-5555-4555-8555-555555555555',
  ownerNamespace: '66666666-6666-4666-8666-666666666666',
  ownerLock: '77777777-7777-4777-8777-777777777777'
})
const CREATED_AT = '2026-08-24T09:00:00.000Z'
const TARGET_PID = process.pid + 100_000
const ABANDONED_ACTOR_PID = TARGET_PID + 100
const PORT = 18_765

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function fileState(file) {
  const stat = fs.lstatSync(file)
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, nlink: stat.nlink }
}

function authorityFileState(file) {
  if (!file || !fs.existsSync(file)) return { bytes: null, stat: null }
  return { bytes: fs.readFileSync(file), stat: fileState(file) }
}

function capturedFile(file) {
  const bytes = fs.readFileSync(file)
  return { file, bytes, sha256: `sha256:${sha256(bytes)}`, state: fileState(file) }
}

function fileIdentity(file) {
  const captured = capturedFile(file)
  return {
    sha256: captured.sha256,
    dev: String(captured.state.dev),
    ino: String(captured.state.ino),
    size: captured.state.size
  }
}

function createActiveReceiptFixture(t, label) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `skill-graft-p4-control-${label}-`))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const dataRoot = path.join(home, 'data')
  const packageRoot = path.join(home, 'package')
  const installDir = path.join(home, 'install')
  const paths = daemonProtocolPaths(home, dataRoot)
  fs.mkdirSync(paths.receiptDirectory, { recursive: true })
  fs.mkdirSync(paths.reviewDirectory, { recursive: true })
  fs.mkdirSync(packageRoot)
  fs.mkdirSync(installDir)
  fs.writeFileSync(paths.receiptNamespaceMarker, '', { flag: 'wx' })
  const receipt = Object.freeze({
    schemaVersion: 1,
    product: 'skill-graft',
    installId: IDS.install,
    dataRootId: IDS.data,
    dataRoot,
    installDir,
    packageRoot,
    packageVersion: '1.0.0',
    packageSha256: `sha256:${'a'.repeat(64)}`,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    state: 'active'
  })
  fs.writeFileSync(paths.receiptFile, `${JSON.stringify(receipt)}\n`, { flag: 'wx' })
  const homeStat = fs.lstatSync(home)
  const homeIdentity = sha256(`${fs.realpathSync.native(home)}\0${homeStat.dev}\0${homeStat.ino}`)
  const readReceiptAuthority = () => {
    const names = fs.readdirSync(paths.receiptDirectory)
      .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
    const daemonName = names.find((name) =>
      /^\.daemon-stage-namespace-v1\.[0-9a-f-]+\.marker$/.test(name)) || null
    const ownerName = names.find((name) =>
      /^\.owner-stage-namespace-v1\.[0-9a-f-]+\.marker$/.test(name)) || null
    const daemonId = daemonName?.slice('.daemon-stage-namespace-v1.'.length, -'.marker'.length) || null
    const ownerId = ownerName?.slice('.owner-stage-namespace-v1.'.length, -'.marker'.length) || null
    const daemonFile = daemonName ? path.join(paths.receiptDirectory, daemonName) : null
    const ownerFile = ownerName ? path.join(paths.receiptDirectory, ownerName) : null
    return {
      home,
      directory: paths.receiptDirectory,
      directoryState: fileState(paths.receiptDirectory),
      entries: names,
      homeIdentity,
      namespaceMarker: paths.receiptNamespaceMarker,
      namespaceMarkerState: authorityFileState(paths.receiptNamespaceMarker),
      receiptFile: paths.receiptFile,
      receipt,
      receiptState: authorityFileState(paths.receiptFile),
      ownerStageNamespaceId: ownerId,
      ownerStageAuthorityMarker: ownerFile,
      ownerStageAuthorityMarkerState: authorityFileState(ownerFile),
      daemonStageNamespaceId: daemonId,
      daemonStageAuthorityMarker: daemonFile,
      daemonStageAuthorityMarkerState: authorityFileState(daemonFile)
    }
  }
  const protocol = { home, dataRoot, platform: process.platform, readReceiptAuthority }
  return { home, dataRoot, packageRoot, paths, receipt, protocol, readReceiptAuthority }
}

function addLifecycleOwner(fixture) {
  const ownerMarker = path.join(
    fixture.paths.receiptDirectory,
    `.owner-stage-namespace-v1.${IDS.ownerNamespace}.marker`
  )
  const ownerRecord = path.join(fixture.home, 'lifecycle-owner-record-v1.json')
  fs.writeFileSync(ownerMarker, '', { flag: 'wx' })
  fs.writeFileSync(ownerRecord, '{"owner":true}\n', { flag: 'wx' })
  const binding = Object.freeze({
    lockToken: IDS.ownerLock,
    operation: 'upgrade',
    ownerRecord: fileIdentity(ownerRecord),
    ownerStageNamespaceId: IDS.ownerNamespace,
    receiptSha256: `sha256:${sha256(fs.readFileSync(fixture.paths.receiptFile))}`,
    installId: fixture.receipt.installId,
    dataRootId: fixture.receipt.dataRootId
  })
  const readLifecycleOwnerAuthority = () => ({
    lockToken: IDS.ownerLock,
    operation: 'upgrade',
    ownerStageNamespaceId: IDS.ownerNamespace,
    receiptSha256: binding.receiptSha256,
    installId: fixture.receipt.installId,
    dataRootId: fixture.receipt.dataRootId,
    ownerRecord: capturedFile(ownerRecord),
    files: [capturedFile(ownerRecord)],
    directories: []
  })
  fixture.protocol = { ...fixture.protocol, readLifecycleOwnerAuthority }
  return { binding, readLifecycleOwnerAuthority }
}

function bootstrap(fixture) {
  const inspection = inspectDaemonProtocol(fixture.protocol)
  return bootstrapDaemonStageNamespace({
    ...fixture.protocol,
    expectedInspection: inspection,
    expectedReceiptAuthority: inspectDaemonReceiptNamespace(
      fixture.home,
      fixture.dataRoot,
      fixture.readReceiptAuthority,
      process.platform
    ),
    namespaceId: IDS.namespace
  })
}

function candidate(identity = `p4-control-target-${process.pid}`) {
  return Object.freeze({
    epochId: IDS.epoch,
    pid: TARGET_PID,
    apiPid: TARGET_PID,
    processIdentity: identity,
    pgid: TARGET_PID,
    port: PORT,
    createdAt: CREATED_AT
  })
}

function createRunningFixture(t, label, { lifecycle = false } = {}) {
  const fixture = createActiveReceiptFixture(t, label)
  const owner = lifecycle ? addLifecycleOwner(fixture) : null
  const daemon = candidate()
  const start = createDaemonStartStage(bootstrap(fixture), daemon)
  for (const projection of ['pid', 'apiPid', 'heartbeat']) publishDaemonStartProjection(start, projection)
  commitDaemonStartInstance(start)
  collapseCommittedDaemonStart(acquireCommittedDaemonStartCollapseAuthority(
    fixture.protocol,
    inspectDaemonProtocol(fixture.protocol)
  ))
  assert.equal(inspectDaemonProtocol(fixture.protocol).kind, 'RUNNING-CLEAN')
  return { fixture, daemon, owner }
}

function createLegacyFixture(t, label) {
  const fixture = createActiveReceiptFixture(t, label)
  const daemon = candidate(`p4-legacy-target-${process.pid}`)
  fs.writeFileSync(fixture.paths.pidProjection, `${daemon.pid}\n`, { flag: 'wx' })
  fs.writeFileSync(fixture.paths.apiPidProjection, `${daemon.apiPid}\n`, { flag: 'wx' })
  fs.writeFileSync(fixture.paths.heartbeatProjection, `${JSON.stringify({
    pid: daemon.pid,
    apiPid: daemon.apiPid,
    hubRoot: fixture.dataRoot,
    packageRoot: fixture.packageRoot,
    dataRoot: fixture.dataRoot,
    port: daemon.port,
    apiHealthy: true,
    lastBeat: CREATED_AT
  }, null, 2)}\n`, { flag: 'wx' })
  assert.equal(inspectDaemonProtocol(fixture.protocol).kind, 'LEGACY')
  return { fixture, daemon }
}

function aliveProcess(pid, processIdentity, pgid = pid) {
  return Object.freeze({
    state: 'alive',
    pid,
    ppid: 1,
    processIdentity,
    pgid,
    commandLine: `fake-daemon-${pid}`
  })
}

function exactTargetFacts(daemon) {
  return Object.freeze({
    process: Object.freeze({
      state: 'alive',
      pid: daemon.pid,
      processIdentity: daemon.processIdentity,
      pgid: daemon.pgid,
      processTree: Object.freeze([{ pid: daemon.pid, processIdentity: daemon.processIdentity }])
    }),
    listener: Object.freeze({
      state: 'owned',
      port: daemon.port,
      pid: daemon.apiPid,
      processIdentity: daemon.processIdentity
    })
  })
}

function createFakeProcessHost(daemon, options = {}) {
  let daemonState = options.daemonState || 'alive'
  let listenerState = options.listenerState || 'present'
  const daemonIdentity = options.daemonIdentity || daemon.processIdentity
  const daemonPgid = options.daemonPgid || daemon.pgid
  const listenerPid = options.listenerPid || daemon.apiPid
  const calls = { processFacts: 0, processTree: 0, listenerFacts: 0, terminate: 0, wait: 0 }
  const host = Object.freeze({
    platform: process.platform,
    processFacts(pid) {
      calls.processFacts += 1
      if (pid === process.pid) return aliveProcess(pid, `p4-controller-${process.pid}`)
      if (pid === ABANDONED_ACTOR_PID) return Object.freeze({ state: 'dead' })
      if (pid !== daemon.pid) return Object.freeze({ state: 'unknown' })
      if (daemonState === 'dead') return Object.freeze({ state: 'dead' })
      if (daemonState === 'unknown') return Object.freeze({ state: 'unknown' })
      return aliveProcess(daemon.pid, daemonIdentity, daemonPgid)
    },
    processTree(rootPid, expectedIdentity) {
      calls.processTree += 1
      assert.equal(rootPid, daemon.pid)
      if (daemonState !== 'alive' || expectedIdentity !== daemonIdentity) {
        return Object.freeze({ state: 'unknown' })
      }
      return Object.freeze({
        state: 'exact',
        rootPid,
        rootProcessIdentity: daemonIdentity,
        entries: Object.freeze([aliveProcess(daemon.pid, daemonIdentity, daemonPgid)])
      })
    },
    listenerFacts(port) {
      calls.listenerFacts += 1
      assert.equal(port, daemon.port)
      if (listenerState === 'absent') return Object.freeze({ state: 'absent' })
      if (listenerState === 'unknown') return Object.freeze({ state: 'unknown' })
      return Object.freeze({
        state: 'present',
        pids: Object.freeze([listenerPid]),
        bindings: Object.freeze([Object.freeze({
          family: 'ipv4',
          address: '127.0.0.1',
          port,
          pid: listenerPid
        })])
      })
    },
    terminateExactTree(tree) {
      calls.terminate += 1
      assert.equal(tree.rootPid, daemon.pid)
      assert.equal(tree.rootProcessIdentity, daemon.processIdentity)
      if (typeof options.onTerminate === 'function') options.onTerminate(tree)
      daemonState = 'dead'
      listenerState = 'absent'
      return Object.freeze({ state: 'signaled', pids: Object.freeze([daemon.pid]) })
    },
    waitForExit(tree, timeoutMs) {
      calls.wait += 1
      assert.equal(tree.rootPid, daemon.pid)
      assert.ok(timeoutMs >= 0)
      return daemonState === 'dead'
        ? Object.freeze({ state: 'exited' })
        : Object.freeze({ state: 'timeout', pids: Object.freeze([daemon.pid]) })
    }
  })
  return { host, calls }
}

function exactHealth(fixture, daemon) {
  return async (request) => {
    assert.equal(request.port, daemon.port)
    assert.equal(request.epochId, daemon.epochId)
    assert.equal(request.pid, daemon.pid)
    assert.equal(request.apiPid, daemon.apiPid)
    return Object.freeze({
      state: 'exact',
      epochId: daemon.epochId,
      packageRoot: fixture.receipt.packageRoot,
      dataRoot: fixture.receipt.dataRoot
    })
  }
}

function runtimeOptions(fixture, daemon, fake, extra = {}) {
  return {
    protocol: fixture.protocol,
    processHost: fake.host,
    healthProbe: exactHealth(fixture, daemon),
    timeoutMs: 100,
    ...extra
  }
}

test('D2 runtime signals only an exact RUNNING-CLEAN tree, seals exit, and retires to ABSENT', async (t) => {
  const { fixture, daemon } = createRunningFixture(t, 'exact-stop')
  const fake = createFakeProcessHost(daemon)
  const result = await stopDaemonRuntime(runtimeOptions(fixture, daemon, fake))
  assert.deepEqual({
    stopped: result.stopped,
    alreadyAbsent: result.alreadyAbsent,
    operation: result.operation,
    terminal: result.terminal.kind
  }, { stopped: true, alreadyAbsent: false, operation: 'stop', terminal: 'ABSENT' })
  assert.equal(fake.calls.terminate, 1)
  assert.equal(fake.calls.wait, 1)
  assert.equal(inspectDaemonProtocol(fixture.protocol).kind, 'ABSENT')
})

test('D2 runtime returns alreadyAbsent for ABSENT without probing or signaling a host process', async (t) => {
  const fixture = createActiveReceiptFixture(t, 'already-absent')
  const unreachable = Object.freeze({
    platform: process.platform,
    processFacts() { throw new Error('ABSENT must not probe a process') },
    processTree() { throw new Error('ABSENT must not probe a tree') },
    listenerFacts() { throw new Error('ABSENT must not probe a listener') },
    terminateExactTree() { throw new Error('ABSENT must not signal') },
    waitForExit() { throw new Error('ABSENT must not wait') }
  })
  const result = await stopDaemonRuntime({
    protocol: fixture.protocol,
    processHost: unreachable,
    healthProbe: async () => { throw new Error('ABSENT must not probe health') }
  })
  assert.equal(result.alreadyAbsent, true)
  assert.equal(result.operation, 'none')
  assert.equal(result.terminal.kind, 'ABSENT')
})

test('D2 runtime treats an explicitly reused PID with an absent listener as retirement-only', async (t) => {
  const { fixture, daemon } = createRunningFixture(t, 'pid-reuse')
  const fake = createFakeProcessHost(daemon, {
    daemonIdentity: 'p4-reused-process-generation',
    daemonPgid: daemon.pgid + 1,
    listenerState: 'absent'
  })
  const result = await stopDaemonRuntime(runtimeOptions(fixture, daemon, fake))
  assert.equal(result.operation, 'stop')
  assert.equal(result.terminal.kind, 'ABSENT')
  assert.equal(fake.calls.terminate, 0)
  assert.equal(fake.calls.wait, 0)
})

test('D2 runtime cleans an actor-dead abandoned STOP reservation before retrying the exact stop', async (t) => {
  const { fixture, daemon } = createRunningFixture(t, 'abandoned-stop')
  assert.throws(() => createDaemonStopStage(
    fixture.protocol,
    inspectDaemonProtocol(fixture.protocol),
    {
      operationId: IDS.operation,
      actor: {
        pid: ABANDONED_ACTOR_PID,
        processIdentity: 'p4-dead-controller',
        pgid: ABANDONED_ACTOR_PID,
        createdAt: CREATED_AT
      },
      targetFacts: exactTargetFacts(daemon),
      checkpoint(name) {
        if (name === 'daemon-control-reservation-directory-created') {
          throw new Error('injected abandoned STOP creation')
        }
      }
    }
  ), /injected abandoned STOP creation/)
  assert.equal(inspectDaemonProtocol(fixture.protocol).kind, 'STOPPING-PARTIAL')
  const fake = createFakeProcessHost(daemon)
  const result = await stopDaemonRuntime(runtimeOptions(fixture, daemon, fake))
  assert.equal(result.operation, 'stop')
  assert.equal(result.terminal.kind, 'ABSENT')
  assert.equal(fake.calls.terminate, 1)
})

test('D2 runtime bootstraps an exact live legacy target, signals it, and retires its projections', async (t) => {
  const { fixture, daemon } = createLegacyFixture(t, 'legacy-live')
  const fake = createFakeProcessHost(daemon)
  const result = await stopDaemonRuntime(runtimeOptions(fixture, daemon, fake, {
    healthProbe: async () => { throw new Error('legacy retirement must not probe v1 health') },
    legacyHint: { pid: daemon.pid, apiPid: daemon.apiPid, port: daemon.port }
  }))
  assert.equal(result.operation, 'legacy-retire')
  assert.equal(result.terminal.kind, 'ABSENT')
  assert.equal(fake.calls.terminate, 1)
  assert.equal(fs.existsSync(fixture.paths.pidProjection), false)
  assert.equal(fs.existsSync(fixture.paths.apiPidProjection), false)
  assert.equal(fs.existsSync(fixture.paths.heartbeatProjection), false)
})

test('D2 runtime rejects unknown or foreign target facts before mutation and preserves RUNNING-CLEAN', async (t) => {
  await t.test('unknown process facts', async (t) => {
    const { fixture, daemon } = createRunningFixture(t, 'unknown-process')
    const before = fs.readdirSync(fixture.paths.stageDirectory)
    const fake = createFakeProcessHost(daemon, { daemonState: 'unknown', listenerState: 'unknown' })
    await assert.rejects(stopDaemonRuntime(runtimeOptions(fixture, daemon, fake)), /process facts are unknown/)
    assert.equal(fake.calls.terminate, 0)
    assert.equal(inspectDaemonProtocol(fixture.protocol).kind, 'RUNNING-CLEAN')
    assert.deepEqual(fs.readdirSync(fixture.paths.stageDirectory), before)
  })

  await t.test('foreign listener ownership', async (t) => {
    const { fixture, daemon } = createRunningFixture(t, 'foreign-listener')
    const before = fs.readdirSync(fixture.paths.stageDirectory)
    const fake = createFakeProcessHost(daemon, { listenerPid: daemon.apiPid + 1 })
    await assert.rejects(stopDaemonRuntime(runtimeOptions(fixture, daemon, fake)), /listener|exactly live/i)
    assert.equal(fake.calls.terminate, 0)
    assert.equal(inspectDaemonProtocol(fixture.protocol).kind, 'RUNNING-CLEAN')
    assert.deepEqual(fs.readdirSync(fixture.paths.stageDirectory), before)
  })
})

test('D2 runtime carries the frozen lifecycle owner binding through its control stage', async (t) => {
  const { fixture, daemon, owner } = createRunningFixture(t, 'lifecycle-binding', { lifecycle: true })
  let observedBinding = null
  const fake = createFakeProcessHost(daemon, {
    onTerminate() {
      const staged = inspectDaemonProtocol(fixture.protocol)
      assert.equal(staged.kind, 'STOPPING')
      observedBinding = staged.manifest.lifecycleOwnerBinding
    }
  })
  const result = await stopDaemonRuntime(runtimeOptions(fixture, daemon, fake, {
    lifecycleOwnerBinding: owner.binding,
    readLifecycleOwnerAuthority: owner.readLifecycleOwnerAuthority
  }))
  assert.deepEqual(observedBinding, owner.binding)
  assert.equal(result.terminal.kind, 'ABSENT')
})
