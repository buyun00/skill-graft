import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { createInstallHost } from '../dist/adapters/install-host.js'
import {
  commitDaemonRuntimeStart,
  createDaemonRuntimeReconcilePort,
  observeDaemonAuthority,
  reconcileDaemonRuntimeForStart
} from '../dist/control/daemon-runtime.js'
import {
  readDaemonLifecycleReceiptAuthority,
  setupHub
} from '../dist/control/install.js'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function freeLoopbackPort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

const unreachableReconcilePort = Object.freeze({
  async observeActor() {
    throw new Error('fresh runtime must not probe an actor')
  },
  async observeRunning() {
    throw new Error('fresh runtime must not observe a running daemon')
  }
})

async function createFixture(t, { running = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-p4-runtime-observer-'))
  const home = path.join(root, 'home')
  const dataRoot = path.join(root, 'data')
  fs.mkdirSync(home, { recursive: true })
  const port = await freeLoopbackPort()
  const environment = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'appdata'),
    LOCALAPPDATA: path.join(home, 'localappdata'),
    HUB_ROOT: dataRoot,
    SKILL_GRAFT_HOME: dataRoot,
    HUB_API_PORT: String(port),
    SG_SKIP_PATH: '1',
    SG_SKIP_TASK: '1'
  }
  const installHost = createInstallHost({
    home,
    localAppData: path.join(home, 'localappdata'),
    skipPath: true,
    skipTask: true,
    env: (name) => environment[name],
    environment: () => ({ ...environment })
  })
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const setup = await setupHub(PACKAGE_ROOT, {
    dryRun: false,
    json: true,
    noDaemon: true,
    noPath: true,
    noTask: true
  }, installHost, dataRoot)
  assert.equal(setup.ok, true, JSON.stringify(setup.issues || []))
  const readReceiptAuthority = () => readDaemonLifecycleReceiptAuthority(dataRoot, installHost)
  const options = { home, dataRoot, platform: process.platform, readReceiptAuthority }
  const candidate = Object.freeze({
    epochId: '22222222-2222-4222-8222-222222222222',
    pid: 41_001,
    apiPid: 41_001,
    processIdentity: 'runtime-observer-process-identity',
    pgid: 41_001,
    port,
    createdAt: '2026-08-24T08:00:00.000Z'
  })
  const empty = await reconcileDaemonRuntimeForStart(options, unreachableReconcilePort)
  assert.equal(empty.kind, 'EMPTY')
  let inspection = null
  if (running) {
    inspection = await commitDaemonRuntimeStart(empty, candidate, {
      sealStatic() {},
      async sealRuntime() {}
    })
    assert.equal(inspection.kind, 'RUNNING-CLEAN')
  }
  return { root, home, dataRoot, installHost, options, candidate, inspection, empty }
}

function aliveProcess(candidate, overrides = {}) {
  return Object.freeze({
    state: 'alive',
    pid: candidate.pid,
    ppid: 1,
    processIdentity: candidate.processIdentity,
    pgid: candidate.pgid,
    commandLine: 'node daemon-test.mjs',
    ...overrides
  })
}

function exactProcessHost(fixture, overrides = {}) {
  const processFacts = overrides.processFacts || ((pid) => {
    assert.equal(pid, fixture.candidate.pid)
    return aliveProcess(fixture.candidate)
  })
  const processTree = overrides.processTree || ((rootPid, expectedIdentity) => {
    assert.equal(rootPid, fixture.candidate.pid)
    assert.equal(expectedIdentity, fixture.candidate.processIdentity)
    return Object.freeze({
      state: 'exact',
      rootPid,
      rootProcessIdentity: expectedIdentity,
      entries: Object.freeze([aliveProcess(fixture.candidate)])
    })
  })
  const listenerFacts = overrides.listenerFacts || ((port) => {
    assert.equal(port, fixture.candidate.port)
    return Object.freeze({
      state: 'present',
      pids: Object.freeze([fixture.candidate.apiPid]),
      bindings: Object.freeze([Object.freeze({
        family: 'ipv4',
        address: '127.0.0.1',
        port,
        pid: fixture.candidate.apiPid
      })])
    })
  })
  return Object.freeze({
    platform: process.platform,
    processFacts,
    processTree,
    listenerFacts,
    terminateExactTree() {
      throw new Error('read-only observer must never terminate a process')
    },
    waitForExit() {
      throw new Error('read-only observer must never wait for termination')
    }
  })
}

function exactHealth(fixture, overrides = {}) {
  return async (request) => {
    assert.deepEqual(request, {
      port: fixture.candidate.port,
      epochId: fixture.candidate.epochId,
      packageRoot: fixture.inspection.instance.packageRoot,
      dataRoot: fixture.inspection.instance.dataRoot,
      pid: fixture.candidate.pid,
      apiPid: fixture.candidate.apiPid
    })
    return Object.freeze({
      state: 'exact',
      epochId: fixture.candidate.epochId,
      packageRoot: fixture.inspection.instance.packageRoot,
      dataRoot: fixture.inspection.instance.dataRoot,
      ...overrides
    })
  }
}

test('D1-B observer is fail-closed across protocol, process, listener, and health facts', { timeout: 120_000 }, async (t) => {
  const fixture = await createFixture(t, { running: false })
  await t.test('exposes non-running protocol without probing legacy markers', async () => {
    let providerCalls = 0
    const unreachableHost = Object.freeze({
      platform: process.platform,
      processFacts() { providerCalls += 1; throw new Error('must not probe') },
      processTree() { providerCalls += 1; throw new Error('must not probe') },
      listenerFacts() { providerCalls += 1; throw new Error('must not probe') },
      terminateExactTree() { throw new Error('must not terminate') },
      waitForExit() { throw new Error('must not wait') }
    })
    const observed = await observeDaemonAuthority(fixture.options, unreachableHost, async () => {
      providerCalls += 1
      throw new Error('must not probe health')
    })
    assert.equal(observed.state, 'not-running')
    assert.equal(observed.protocolKind, 'ABSENT')
    assert.equal(providerCalls, 0)
  })

  fixture.inspection = await commitDaemonRuntimeStart(fixture.empty, fixture.candidate, {
    sealStatic() {},
    async sealRuntime() {}
  })

  await t.test('accepts only the exact frozen tree, listener, and health epoch', async () => {
    const processHost = exactProcessHost(fixture)
    const healthProbe = exactHealth(fixture)
    const observed = await observeDaemonAuthority(fixture.options, processHost, healthProbe)
    assert.equal(observed.state, 'exact')
    assert.equal(observed.protocolKind, 'RUNNING-CLEAN')
    assert.equal(observed.instance.epochId, fixture.candidate.epochId)
    assert.deepEqual(observed.processTree.entries.map((entry) => entry.pid), [fixture.candidate.pid])
    assert.deepEqual(observed.listener.pids, [fixture.candidate.apiPid])

    const reconciled = await reconcileDaemonRuntimeForStart(
      fixture.options,
      createDaemonRuntimeReconcilePort(fixture.options, processHost, healthProbe)
    )
    assert.equal(reconciled.kind, 'EXISTING')
    assert.equal(reconciled.instance.epochId, fixture.candidate.epochId)
  })

  await t.test('classifies PID reuse as foreign', async () => {
    const processHost = exactProcessHost(fixture, {
      processFacts: () => aliveProcess(fixture.candidate, { processIdentity: 'reused-process-identity' })
    })
    const observed = await observeDaemonAuthority(fixture.options, processHost, exactHealth(fixture))
    assert.equal(observed.state, 'foreign')
    assert.equal(observed.reason, 'root-process-identity-mismatch')
  })

  await t.test('classifies PGID drift as foreign', async () => {
    const processHost = exactProcessHost(fixture, {
      processFacts: () => aliveProcess(fixture.candidate, { pgid: fixture.candidate.pgid + 1 })
    })
    const observed = await observeDaemonAuthority(fixture.options, processHost, exactHealth(fixture))
    assert.equal(observed.state, 'foreign')
    assert.equal(observed.reason, 'root-process-pgid-mismatch')
  })

  await t.test('rejects a listener owned by a foreign PID', async () => {
    const foreignPid = fixture.candidate.apiPid + 9
    const processHost = exactProcessHost(fixture, {
      listenerFacts: (port) => ({
        state: 'present',
        pids: [foreignPid],
        bindings: [{ family: 'ipv4', address: '127.0.0.1', port, pid: foreignPid }]
      })
    })
    const observed = await observeDaemonAuthority(fixture.options, processHost, exactHealth(fixture))
    assert.equal(observed.state, 'foreign')
    assert.equal(observed.reason, 'listener-owner-mismatch')
  })

  await t.test('normalizes an equivalent IPv6 loopback address before accepting it', async () => {
    const processHost = exactProcessHost(fixture, {
      listenerFacts: (port) => ({
        state: 'present',
        pids: [fixture.candidate.apiPid],
        bindings: [{
          family: 'ipv6',
          address: '0000:0000:0000:0000:0000:0000:0000:0001',
          port,
          pid: fixture.candidate.apiPid
        }]
      })
    })
    const observed = await observeDaemonAuthority(fixture.options, processHost, exactHealth(fixture))
    assert.equal(observed.state, 'exact')
    assert.deepEqual(observed.listener.bindings, [{
      family: 'ipv6',
      address: '::1',
      port: fixture.candidate.port,
      pid: fixture.candidate.apiPid
    }])
  })

  await t.test('classifies every valid non-loopback listener address as foreign', async (t) => {
    const cases = [
      ['IPv4 wildcard', [{ family: 'ipv4', address: '0.0.0.0' }]],
      ['IPv4 non-authoritative loopback', [{ family: 'ipv4', address: '127.0.0.2' }]],
      ['IPv6 wildcard', [{ family: 'ipv6', address: '::' }]],
      ['mixed loopback and foreign bindings', [
        { family: 'ipv4', address: '127.0.0.1' },
        { family: 'ipv6', address: '::ffff:127.0.0.1' }
      ]]
    ]
    for (const [name, addresses] of cases) {
      await t.test(name, async () => {
        let healthCalls = 0
        const processHost = exactProcessHost(fixture, {
          listenerFacts: (port) => ({
            state: 'present',
            pids: [fixture.candidate.apiPid],
            bindings: addresses.map(({ family, address }) => ({
              family,
              address,
              port,
              pid: fixture.candidate.apiPid
            }))
          })
        })
        const observed = await observeDaemonAuthority(fixture.options, processHost, async () => {
          healthCalls += 1
          throw new Error('foreign listener must short-circuit health')
        })
        assert.equal(observed.state, 'foreign')
        assert.equal(observed.reason, 'listener-address-not-loopback')
        assert.equal(healthCalls, 0)
      })
    }
  })

  await t.test('rejects a health response from another epoch', async () => {
    const observed = await observeDaemonAuthority(
      fixture.options,
      exactProcessHost(fixture),
      exactHealth(fixture, { epochId: '33333333-3333-4333-8333-333333333333' })
    )
    assert.equal(observed.state, 'foreign')
    assert.equal(observed.reason, 'health-authority-mismatch')
  })

  await t.test('propagates unknown facts without health fallback', async () => {
    let healthCalls = 0
    const processHost = exactProcessHost(fixture, { processFacts: () => ({ state: 'unknown' }) })
    const observed = await observeDaemonAuthority(fixture.options, processHost, async () => {
      healthCalls += 1
      throw new Error('unknown process must short-circuit health')
    })
    assert.equal(observed.state, 'unknown')
    assert.equal(observed.reason, 'root-process-unknown')
    assert.equal(healthCalls, 0)
  })

  await t.test('fails closed on protocol drift during health sampling', async () => {
    const observed = await observeDaemonAuthority(fixture.options, exactProcessHost(fixture), async () => {
      fs.appendFileSync(fixture.inspection.paths.heartbeatProjection, '\n')
      return {
        state: 'exact',
        epochId: fixture.candidate.epochId,
        packageRoot: fixture.inspection.instance.packageRoot,
        dataRoot: fixture.inspection.instance.dataRoot
      }
    })
    assert.equal(observed.state, 'unknown')
    assert.equal(observed.reason, 'protocol-drift')
  })
})
