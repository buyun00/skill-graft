import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { createInstallHost } from '../dist/adapters/install-host.js'
import {
  daemonProtocolPaths,
  inspectDaemonProtocol
} from '../dist/control/daemon-protocol.js'
import {
  commitDaemonRuntimeStart,
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

async function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-p4-runtime-start-'))
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
  const host = createInstallHost({
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
  }, host, dataRoot)
  assert.equal(setup.ok, true, JSON.stringify(setup.issues || []))
  const readReceiptAuthority = () => readDaemonLifecycleReceiptAuthority(dataRoot, host)
  const options = { home, dataRoot, platform: process.platform, readReceiptAuthority }
  const candidate = Object.freeze({
    epochId: '11111111-1111-4111-8111-111111111111',
    pid: process.pid,
    apiPid: process.pid,
    processIdentity: `runtime-test-${process.pid}`,
    pgid: process.pid,
    port,
    createdAt: '2026-08-24T06:00:00.000Z'
  })
  return { root, home, dataRoot, host, options, candidate }
}

const unreachableReconcilePort = Object.freeze({
  async observeActor() {
    throw new Error('fresh runtime must not probe an actor')
  },
  async observeRunning() {
    throw new Error('fresh runtime must not observe an existing daemon')
  }
})

test('D1-B runtime publishes an exact listener-sealed candidate and collapses START', { timeout: 120_000 }, async (t) => {
  const fixture = await createFixture(t)
  const empty = await reconcileDaemonRuntimeForStart(fixture.options, unreachableReconcilePort)
  assert.equal(empty.kind, 'EMPTY')
  const sealEvents = []
  const terminal = await commitDaemonRuntimeStart(empty, fixture.candidate, {
    sealStatic() {
      sealEvents.push('static')
    },
    async sealRuntime(candidate) {
      assert.deepEqual(candidate, fixture.candidate)
      sealEvents.push('runtime')
    }
  })

  assert.equal(terminal.kind, 'RUNNING-CLEAN')
  assert.equal(terminal.instance.epochId, fixture.candidate.epochId)
  assert.equal(terminal.instance.processIdentity, fixture.candidate.processIdentity)
  assert.equal(terminal.instance.port, fixture.candidate.port)
  assert.equal(sealEvents.filter((event) => event === 'runtime').length, 7)
  // Production has no injected kill-cut callback. Each of the 54 durable
  // protocol checkpoints needs one static seal, while seven runtime seals are
  // independently sandwiched by two static seals.
  assert.equal(sealEvents.filter((event) => event === 'static').length, 68)
  const paths = daemonProtocolPaths(fixture.home, fixture.dataRoot)
  assert.equal(fs.existsSync(paths.finalInstance), true)
  assert.deepEqual(
    fs.readdirSync(paths.stageDirectory).filter((name) => !name.startsWith('.namespace-v1.')),
    []
  )

  const existing = await reconcileDaemonRuntimeForStart(fixture.options, {
    async observeActor() {
      throw new Error('RUNNING-CLEAN must not probe a START actor')
    },
    async observeRunning(instance) {
      assert.equal(instance.epochId, fixture.candidate.epochId)
      return { state: 'exact' }
    }
  })
  assert.equal(existing.kind, 'EXISTING')
  assert.equal(existing.instance.epochId, fixture.candidate.epochId)
})

test('D1-B runtime leaves a recoverable unpublished START when the listener seal fails', { timeout: 120_000 }, async (t) => {
  const fixture = await createFixture(t)
  const empty = await reconcileDaemonRuntimeForStart(fixture.options, unreachableReconcilePort)
  let runtimeSeals = 0
  const sealEvents = []
  await assert.rejects(commitDaemonRuntimeStart(empty, fixture.candidate, {
    sealStatic() {
      sealEvents.push('static')
    },
    async sealRuntime() {
      runtimeSeals += 1
      sealEvents.push('runtime')
      if (runtimeSeals === 2) throw new Error('injected listener epoch drift')
    }
  }, (name) => sealEvents.push(`checkpoint:${name}`)), /injected listener epoch drift/)
  for (let index = 0; index < sealEvents.length; index += 1) {
    if (!sealEvents[index].startsWith('checkpoint:')) continue
    assert.equal(sealEvents[index - 1], 'static')
    assert.equal(sealEvents[index + 1], 'static')
  }

  const residue = inspectDaemonProtocol(fixture.options)
  assert.equal(residue.kind, 'STARTING')
  assert.equal(residue.publicProjectionCount, 0)
  assert.equal(fs.existsSync(residue.paths.finalInstance), false)
  const reconciled = await reconcileDaemonRuntimeForStart(fixture.options, {
    async observeActor(pid) {
      assert.equal(pid, process.pid)
      return { state: 'dead' }
    },
    async observeRunning() {
      throw new Error('dead unpublished START must not be observed as running')
    }
  })
  assert.equal(reconciled.kind, 'EMPTY')
  assert.equal(inspectDaemonProtocol(fixture.options).kind, 'ABSENT')
})
