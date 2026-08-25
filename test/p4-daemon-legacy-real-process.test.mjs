import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createDaemonProcessHost } from '../dist/adapters/daemon-process-host.js'
import { stopDaemonRuntime } from '../dist/control/daemon-control-runtime.js'
import {
  daemonProtocolPaths,
  inspectDaemonProtocol
} from '../dist/control/daemon-protocol.js'

const SUPPORTED = process.platform === 'win32' || process.platform === 'linux'
const PROCESS_TIMEOUT_MS = 45_000

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function fileState(file) {
  const stat = fs.lstatSync(file)
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    nlink: stat.nlink
  }
}

function authorityFileState(file) {
  if (!file || !fs.existsSync(file)) return { bytes: null, stat: null }
  return { bytes: fs.readFileSync(file), stat: fileState(file) }
}

function createActiveReceiptFixture(runRoot) {
  const home = path.join(runRoot, 'home')
  const dataRoot = path.join(runRoot, 'hub-data')
  const packageRoot = path.join(runRoot, 'package')
  const installDir = path.join(runRoot, 'install')
  fs.mkdirSync(home)
  const paths = daemonProtocolPaths(home, dataRoot)
  fs.mkdirSync(paths.receiptDirectory, { recursive: true })
  fs.mkdirSync(paths.reviewDirectory, { recursive: true })
  fs.mkdirSync(packageRoot)
  fs.mkdirSync(installDir)
  fs.writeFileSync(paths.receiptNamespaceMarker, '', { flag: 'wx' })
  const createdAt = new Date().toISOString()
  const receipt = Object.freeze({
    schemaVersion: 1,
    product: 'skill-graft',
    installId: randomUUID(),
    dataRootId: randomUUID(),
    dataRoot,
    installDir,
    packageRoot,
    packageVersion: '0.0.0-p4-real-legacy',
    packageSha256: `sha256:${'a'.repeat(64)}`,
    createdAt,
    updatedAt: createdAt,
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
  return {
    createdAt,
    dataRoot,
    packageRoot,
    paths,
    protocol: Object.freeze({ home, dataRoot, platform: process.platform, readReceiptAuthority })
  }
}

function workerSource() {
  return [
    "const { spawn } = require('node:child_process')",
    "const fs = require('node:fs')",
    "const net = require('node:net')",
    'const readyFile = process.argv[1]',
    'const stopFile = process.argv[2]',
    'const runId = process.argv[3]',
    'const runRoot = process.argv[4]',
    "const leafCode = \"const owner=Number(process.argv[1]); setInterval(()=>{ try { process.kill(owner, 0) } catch { process.exit(0) } }, 100);\"",
    "const leaf = spawn(process.execPath, ['-e', leafCode, String(process.pid), runId, runRoot, 'leaf'], { stdio: 'ignore', windowsHide: true, env: process.env })",
    'const server = net.createServer((socket) => socket.destroy())',
    'let stopping = false',
    'let stopPoll = null',
    'function shutdown() {',
    '  if (stopping) return',
    '  stopping = true',
    '  if (stopPoll) clearInterval(stopPoll)',
    "  try { leaf.kill('SIGTERM') } catch {}",
    '  try { server.close(() => process.exit(0)) } catch { process.exit(0) }',
    '  setTimeout(() => process.exit(0), 1000).unref()',
    '}',
    "process.on('SIGTERM', shutdown)",
    "process.on('SIGINT', shutdown)",
    "server.on('error', (error) => { try { fs.writeFileSync(readyFile, JSON.stringify({ error: error.message }) + '\\n', { flag: 'wx' }) } catch {}; shutdown() })",
    "leaf.on('error', (error) => { try { fs.writeFileSync(readyFile, JSON.stringify({ error: error.message }) + '\\n', { flag: 'wx' }) } catch {}; shutdown() })",
    "leaf.once('spawn', () => server.listen(0, '127.0.0.1', () => {",
    '  const address = server.address()',
    "  fs.writeFileSync(readyFile, JSON.stringify({ schemaVersion: 1, runId, pid: process.pid, childPid: leaf.pid, port: address.port }) + '\\n', { flag: 'wx' })",
    '  stopPoll = setInterval(() => { if (fs.existsSync(stopFile)) shutdown() }, 50)',
    '}))',
    'setInterval(() => {}, 1000)'
  ].join(';\n')
}

function isolatedWorkerEnvironment(runRoot, runId) {
  return Object.fromEntries(Object.entries({
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    ComSpec: process.env.ComSpec,
    PATH: path.dirname(process.execPath),
    Path: path.dirname(process.execPath),
    HOME: runRoot,
    USERPROFILE: runRoot,
    TEMP: runRoot,
    TMP: runRoot,
    SG_P4_LEGACY_RUN_ID: runId,
    SG_P4_LEGACY_RUN_ROOT: runRoot
  }).filter(([, value]) => typeof value === 'string' && value.length > 0))
}

async function waitFor(label, probe, timeoutMs = PROCESS_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  let last = null
  do {
    try {
      const value = probe()
      if (value) return value
      last = value
    } catch (error) {
      last = error
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  const detail = last instanceof Error ? last.message : JSON.stringify(last)
  throw new Error(`${label} did not converge: ${detail}`)
}

function commandOwnsRun(facts, runId, runRoot) {
  const commandLine = String(facts?.commandLine || '').toLowerCase()
  return commandLine.includes(runId.toLowerCase()) && commandLine.includes(runRoot.toLowerCase())
}

function taskkillTree(pid) {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || ''
  const executable = systemRoot ? path.join(systemRoot, 'System32', 'taskkill.exe') : 'taskkill.exe'
  return spawnSync(executable, ['/PID', String(pid), '/T', '/F'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000
  })
}

function assertOwnedRunRoot(runRoot, runId, canonicalRoot) {
  assert.equal(path.basename(runRoot), runId)
  assert.equal(path.dirname(path.resolve(runRoot)), path.resolve(os.tmpdir()))
  const stat = fs.lstatSync(runRoot)
  assert.equal(stat.isDirectory() && !stat.isSymbolicLink(), true)
  assert.equal(fs.realpathSync.native(runRoot), canonicalRoot)
}

test('D2 production runtime exact-signals and retires a real legacy daemon process tree', {
  skip: !SUPPORTED,
  timeout: 240_000
}, async (t) => {
  const runId = `skill-graft-p4-legacy-os-${randomUUID()}`
  const runRoot = path.join(os.tmpdir(), runId)
  fs.mkdirSync(runRoot, { recursive: false })
  const canonicalRoot = fs.realpathSync.native(runRoot)
  const readyFile = path.join(runRoot, 'legacy-worker-ready.json')
  const stopFile = path.join(runRoot, 'legacy-worker-stop')
  const processHost = createDaemonProcessHost()
  let worker = null
  let rootPid = 0
  let tracked = []

  t.after(async () => {
    const cleanupErrors = []
    try {
      if (worker?.exitCode == null && worker?.signalCode == null && fs.existsSync(runRoot)) {
        try { fs.writeFileSync(stopFile, '', { flag: 'wx' }) } catch (error) {
          if (error?.code !== 'EEXIST') throw error
        }
        await waitFor('owned legacy worker graceful exit', () => (
          worker.exitCode != null || worker.signalCode != null
        ), 3_000).catch(() => null)
      }
      if (worker?.exitCode == null && worker?.signalCode == null && rootPid === worker.pid) {
        if (process.platform === 'win32') taskkillTree(rootPid)
        else {
          try { worker.kill('SIGKILL') } catch { /* direct child already exited */ }
        }
      }
      for (const expected of tracked) {
        const facts = processHost.processFacts(expected.pid)
        if (facts.state !== 'alive' || facts.processIdentity !== expected.processIdentity) continue
        if (expected.tokenRequired) {
          assert.equal(commandOwnsRun(facts, runId, runRoot), true, 'cleanup target lost test ownership tokens')
        }
        if (process.platform === 'win32') taskkillTree(expected.pid)
        else {
          try { process.kill(expected.pid, 'SIGKILL') } catch (error) {
            if (error?.code !== 'ESRCH') throw error
          }
        }
      }
      await waitFor('owned legacy process cleanup', () => tracked.every((expected) => {
        const facts = processHost.processFacts(expected.pid)
        return facts.state === 'dead'
          || facts.state === 'alive' && facts.processIdentity !== expected.processIdentity
      }), 15_000)
    } catch (error) {
      cleanupErrors.push(error)
    }
    try {
      if (fs.existsSync(runRoot)) {
        assertOwnedRunRoot(runRoot, runId, canonicalRoot)
        fs.rmSync(runRoot, { recursive: true, force: false })
      }
    } catch (error) {
      cleanupErrors.push(error)
    }
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'real legacy daemon fixture cleanup failed')
  })

  const fixture = createActiveReceiptFixture(runRoot)
  worker = spawn(process.execPath, ['-e', workerSource(), readyFile, stopFile, runId, runRoot], {
    cwd: runRoot,
    env: isolatedWorkerEnvironment(runRoot, runId),
    stdio: 'ignore',
    windowsHide: true
  })
  assert.ok(Number.isSafeInteger(worker.pid) && worker.pid > 0)
  rootPid = worker.pid

  const ready = await waitFor('legacy worker readiness', () => {
    if (worker.exitCode != null || worker.signalCode != null) {
      throw new Error(`legacy worker exited early (${worker.exitCode ?? worker.signalCode})`)
    }
    if (!fs.existsSync(readyFile)) return null
    const value = JSON.parse(fs.readFileSync(readyFile, 'utf8'))
    if (value.error) throw new Error(value.error)
    return value
  })
  assert.deepEqual(
    { schemaVersion: ready.schemaVersion, runId: ready.runId, pid: ready.pid },
    { schemaVersion: 1, runId, pid: rootPid }
  )
  assert.ok(Number.isSafeInteger(ready.childPid) && ready.childPid > 0 && ready.childPid !== rootPid)
  assert.ok(Number.isSafeInteger(ready.port) && ready.port > 0 && ready.port <= 65_535)

  const rootFacts = await waitFor('exact legacy root process facts', () => {
    const facts = processHost.processFacts(rootPid)
    return facts.state === 'alive' && commandOwnsRun(facts, runId, runRoot) ? facts : null
  })
  const leafFacts = await waitFor('exact legacy leaf process facts', () => {
    const facts = processHost.processFacts(ready.childPid)
    return facts.state === 'alive' && commandOwnsRun(facts, runId, runRoot) ? facts : null
  })
  tracked = [
    { pid: rootPid, processIdentity: rootFacts.processIdentity, tokenRequired: true },
    { pid: ready.childPid, processIdentity: leafFacts.processIdentity, tokenRequired: true }
  ]

  const issuedTree = await waitFor('exact test-owned legacy process tree', () => {
    const tree = processHost.processTree(rootPid, rootFacts.processIdentity)
    if (tree.state !== 'exact') return null
    if (!tree.entries.some((entry) => entry.pid === ready.childPid)) return null
    return tree
  })
  assert.equal(issuedTree.entries.some((entry) => entry.pid === process.pid), false)
  assert.equal(issuedTree.entries.some((entry) => (
    entry.pid === ready.childPid && entry.processIdentity === leafFacts.processIdentity
  )), true)
  const issuedByPid = new Map(issuedTree.entries.map((entry) => [entry.pid, entry]))
  for (const entry of issuedTree.entries) {
    let cursor = entry
    const seen = new Set()
    while (cursor.pid !== rootPid) {
      assert.equal(seen.has(cursor.pid), false, 'test-owned process tree contains an ancestry cycle')
      seen.add(cursor.pid)
      const parent = issuedByPid.get(cursor.ppid)
      assert.ok(parent, `process ${cursor.pid} does not descend from the exact test-owned root`)
      cursor = parent
    }
  }
  tracked = issuedTree.entries.map((entry) => ({
    pid: entry.pid,
    processIdentity: entry.processIdentity,
    tokenRequired: entry.pid === rootPid || entry.pid === ready.childPid
  }))

  const listener = await waitFor('test-owned legacy listener', () => {
    const facts = processHost.listenerFacts(ready.port)
    return facts.state === 'present' && facts.pids.length === 1 && facts.pids[0] === rootPid
      ? facts
      : null
  })
  assert.equal(listener.bindings.every((binding) => binding.pid === rootPid && binding.port === ready.port), true)

  fs.writeFileSync(fixture.paths.pidProjection, `${rootPid}\n`, { flag: 'wx' })
  fs.writeFileSync(fixture.paths.apiPidProjection, `${rootPid}\n`, { flag: 'wx' })
  fs.writeFileSync(fixture.paths.heartbeatProjection, `${JSON.stringify({
    pid: rootPid,
    apiPid: rootPid,
    hubRoot: fixture.dataRoot,
    packageRoot: fixture.packageRoot,
    dataRoot: fixture.dataRoot,
    port: ready.port,
    apiHealthy: true,
    lastBeat: fixture.createdAt
  }, null, 2)}\n`, { flag: 'wx' })
  assert.equal(inspectDaemonProtocol(fixture.protocol).kind, 'LEGACY')

  const result = await stopDaemonRuntime({
    protocol: fixture.protocol,
    processHost,
    healthProbe: async () => {
      throw new Error('legacy retirement must not invent v1 epoch health')
    },
    legacyHint: { pid: rootPid, apiPid: rootPid, port: ready.port },
    timeoutMs: PROCESS_TIMEOUT_MS
  })

  assert.equal(result.stopped, true)
  assert.equal(result.alreadyAbsent, false)
  assert.equal(result.operation, 'legacy-retire')
  assert.equal(result.terminal.kind, 'ABSENT')
  assert.equal(inspectDaemonProtocol(fixture.protocol).kind, 'ABSENT')
  for (const expected of tracked) {
    const facts = await waitFor(`legacy process ${expected.pid} death`, () => {
      const current = processHost.processFacts(expected.pid)
      return current.state === 'dead' ? current : null
    })
    assert.equal(facts.state, 'dead')
  }
  const absentListener = await waitFor('legacy listener absence', () => {
    const facts = processHost.listenerFacts(ready.port)
    return facts.state === 'absent' ? facts : null
  })
  assert.equal(absentListener.state, 'absent')
  for (const file of [
    fixture.paths.pidProjection,
    fixture.paths.apiPidProjection,
    fixture.paths.heartbeatProjection,
    fixture.paths.finalInstance
  ]) assert.equal(fs.existsSync(file), false, file)
})
