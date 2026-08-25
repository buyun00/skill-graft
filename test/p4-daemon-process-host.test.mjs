import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createDaemonProcessHost } from '../dist/adapters/daemon-process-host.js'
import { createSystemLeaseProcessInspector } from '../dist/adapters/lease-lock.js'

const bootId = '0123456789abcdef0123456789abcdef'

function linuxProcess(pid, ppid, startTicks, commandLine, pgid = 81001) {
  return {
    state: 'alive',
    pid,
    ppid,
    processIdentity: `linux:${bootId}:${startTicks}`,
    pgid,
    commandLine
  }
}

function windowsProcess(pid, ppid, ticks, commandLine) {
  return {
    state: 'alive',
    pid,
    ppid,
    processIdentity: `windows:${ticks}`,
    pgid: pid,
    commandLine
  }
}

function writeProcProcess(procRoot, { pid, ppid, pgid, startTicks, commandLine }) {
  const directory = path.join(procRoot, String(pid))
  fs.mkdirSync(directory, { recursive: true })
  const fields = ['S', String(ppid), String(pgid), ...Array(16).fill('0'), String(startTicks)]
  fs.writeFileSync(path.join(directory, 'stat'), `${pid} (node fixture) ${fields.join(' ')}\n`)
  fs.writeFileSync(path.join(directory, 'cmdline'), commandLine.split(' ').join('\0'))
}

function fakeProcessSystem({ platform = 'linux', initialProcesses, listeners, onSignal, onWindowsTerminate, now, sleep }) {
  let processes = initialProcesses
  return {
    host: createDaemonProcessHost({
      platform,
      readProcess(pid) {
        return processes.find((entry) => entry.pid === pid) || { state: 'dead' }
      },
      listProcesses() {
        return { state: 'ok', processes }
      },
      readListeners() {
        return listeners || { state: 'absent' }
      },
      signalPosix(pid, signal) {
        return onSignal ? onSignal(pid, signal) : 'accepted'
      },
      terminateWindowsTree(pid) {
        return onWindowsTerminate ? onWindowsTerminate(pid) : 'accepted'
      },
      now,
      sleep
    }),
    setProcesses(next) {
      processes = next
    },
    getProcesses() {
      return processes
    }
  }
}

test('fake provider normalizes exact process and listener facts with stable deduplication', () => {
  const root = linuxProcess(81001, 80000, 100, 'node daemon run')
  const child = linuxProcess(81002, 81001, 110, 'node api')
  const grandchild = linuxProcess(81003, 81002, 120, 'node worker')
  const unrelated = linuxProcess(82000, 80000, 90, 'node unrelated', 82000)
  const { host } = fakeProcessSystem({
    initialProcesses: [grandchild, unrelated, root, grandchild, child],
    listeners: {
      state: 'present',
      bindings: [
        { family: 'ipv6', address: '::1', port: 28765, pid: 81002 },
        { family: 'ipv4', address: '127.0.0.1', port: 28765, pid: 81001 },
        { family: 'ipv4', address: '127.0.0.1', port: 28765, pid: 81001 }
      ]
    }
  })

  assert.deepEqual(host.processFacts(root.pid), root)
  const tree = host.processTree(root.pid, root.processIdentity)
  assert.equal(tree.state, 'exact')
  assert.deepEqual(tree.entries.map((entry) => entry.pid), [81001, 81002, 81003])
  assert.equal(Object.isFrozen(tree), true)
  assert.equal(Object.isFrozen(tree.entries), true)
  assert.equal(Object.isFrozen(tree.entries[0]), true)

  assert.deepEqual(host.listenerFacts(28765), {
    state: 'present',
    pids: [81001, 81002],
    bindings: [
      { family: 'ipv4', address: '127.0.0.1', port: 28765, pid: 81001 },
      { family: 'ipv6', address: '::1', port: 28765, pid: 81002 }
    ]
  })
})

test('malformed, conflicting, and throwing providers remain unknown without authority', () => {
  const malformedProcess = createDaemonProcessHost({
    platform: 'linux',
    readProcess: () => ({ state: 'dead', extra: true }),
    listProcesses: () => ({ state: 'ok', processes: [
      linuxProcess(83001, 80000, 100, 'first'),
      linuxProcess(83001, 80000, 100, 'conflict')
    ] }),
    readListeners: () => ({
      state: 'present',
      bindings: [{ family: 'ipv4', address: '127.0.0.1', port: 28766, pid: 0 }]
    })
  })
  assert.deepEqual(malformedProcess.processFacts(83001), { state: 'unknown' })
  assert.deepEqual(malformedProcess.processTree(83001, `linux:${bootId}:100`), { state: 'unknown' })
  assert.deepEqual(malformedProcess.listenerFacts(28766), { state: 'unknown' })

  const throwing = createDaemonProcessHost({
    platform: 'linux',
    readProcess: () => { throw new Error('provider failed') },
    listProcesses: () => { throw new Error('provider failed') },
    readListeners: () => { throw new Error('provider failed') }
  })
  assert.deepEqual(throwing.processFacts(83002), { state: 'unknown' })
  assert.deepEqual(throwing.processTree(83002, `linux:${bootId}:101`), { state: 'unknown' })
  assert.deepEqual(throwing.listenerFacts(28767), { state: 'unknown' })
})

test('Linux proc fixture uses boot-id/start-ticks identity, real PGID, and ignores group-zero kernel rows', (t) => {
  const procRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-daemon-proc-'))
  t.after(() => fs.rmSync(procRoot, { recursive: true, force: true }))
  fs.mkdirSync(path.join(procRoot, 'sys', 'kernel', 'random'), { recursive: true })
  fs.writeFileSync(path.join(procRoot, 'sys', 'kernel', 'random', 'boot_id'), `${bootId}\n`)
  writeProcProcess(procRoot, { pid: 2, ppid: 0, pgid: 0, startTicks: 1, commandLine: '' })
  writeProcProcess(procRoot, { pid: 83501, ppid: 80000, pgid: 83501, startTicks: 100, commandLine: 'node daemon run' })
  writeProcProcess(procRoot, { pid: 83502, ppid: 83501, pgid: 83501, startTicks: 110, commandLine: 'node api' })
  const host = createDaemonProcessHost({ platform: 'linux', procRoot })

  assert.deepEqual(host.processFacts(83501), linuxProcess(83501, 80000, 100, 'node daemon run', 83501))
  assert.deepEqual(host.processFacts(2), { state: 'unknown' })
  const tree = host.processTree(83501, `linux:${bootId}:100`)
  assert.equal(tree.state, 'exact')
  assert.deepEqual(tree.entries.map(({ pid, ppid, pgid }) => ({ pid, ppid, pgid })), [
    { pid: 83501, ppid: 80000, pgid: 83501 },
    { pid: 83502, ppid: 83501, pgid: 83501 }
  ])
})

test('POSIX exact termination requires an issued stable tree and signals leaves before root', () => {
  const root = linuxProcess(84001, 80000, 100, 'node daemon run')
  const child = linuxProcess(84002, 84001, 110, 'node api')
  const grandchild = linuxProcess(84003, 84002, 120, 'node worker')
  const signaled = []
  const fixture = fakeProcessSystem({
    initialProcesses: [child, grandchild, root],
    onSignal(pid, signal) {
      signaled.push([pid, signal])
      return 'accepted'
    }
  })
  const tree = fixture.host.processTree(root.pid, root.processIdentity)
  assert.equal(tree.state, 'exact')

  assert.throws(
    () => fixture.host.terminateExactTree({ ...tree, entries: [...tree.entries] }),
    /not issued/
  )
  assert.deepEqual(fixture.host.terminateExactTree(tree), {
    state: 'signaled',
    pids: [84003, 84002, 84001]
  })
  assert.deepEqual(signaled, [
    [84003, 'SIGTERM'],
    [84002, 'SIGTERM'],
    [84001, 'SIGTERM']
  ])
})

test('identity or topology drift refuses every signal before mutation', () => {
  const root = linuxProcess(85001, 80000, 100, 'node daemon run')
  const child = linuxProcess(85002, 85001, 110, 'node api')
  const signaled = []
  const fixture = fakeProcessSystem({
    initialProcesses: [root, child],
    onSignal(pid) {
      signaled.push(pid)
      return 'accepted'
    }
  })
  const tree = fixture.host.processTree(root.pid, root.processIdentity)
  assert.equal(tree.state, 'exact')
  fixture.setProcesses([root, linuxProcess(85002, 85001, 999, 'node api')])

  assert.deepEqual(fixture.host.terminateExactTree(tree), { state: 'unknown', pids: [] })
  assert.deepEqual(signaled, [])
})

test('Windows exact termination delegates one revalidated root to taskkill tree provider', () => {
  const root = windowsProcess(86001, 80000, '638600000000000000', 'node daemon run')
  const child = windowsProcess(86002, 86001, '638600000000000100', 'node api')
  const terminated = []
  const { host } = fakeProcessSystem({
    platform: 'win32',
    initialProcesses: [child, root],
    onWindowsTerminate(pid) {
      terminated.push(pid)
      return 'accepted'
    }
  })
  const tree = host.processTree(root.pid, root.processIdentity)
  assert.equal(tree.state, 'exact')
  assert.deepEqual(host.terminateExactTree(tree), { state: 'signaled', pids: [86001] })
  assert.deepEqual(terminated, [86001])
})

test('waitForExit tracks exact identities and treats PID reuse as target exit', () => {
  const root = linuxProcess(87001, 80000, 100, 'node daemon run')
  let clock = 0
  let fixture
  fixture = fakeProcessSystem({
    initialProcesses: [root],
    now: () => clock,
    sleep(milliseconds) {
      clock += milliseconds
      fixture.setProcesses([linuxProcess(87001, 80000, 500, 'node replacement')])
    }
  })
  const tree = fixture.host.processTree(root.pid, root.processIdentity)
  assert.equal(tree.state, 'exact')
  assert.deepEqual(fixture.host.waitForExit(tree, 100), { state: 'exited' })

  fixture.setProcesses([root])
  const liveTree = fixture.host.processTree(root.pid, root.processIdentity)
  assert.equal(liveTree.state, 'exact')
  assert.deepEqual(fixture.host.waitForExit(liveTree, 0), { state: 'timeout', pids: [87001] })
})

test('real current-process facts use the same creation identity as the lease inspector', async () => {
  const host = createDaemonProcessHost()
  const facts = host.processFacts(process.pid)
  assert.equal(facts.state, 'alive')
  assert.equal(facts.pid, process.pid)
  assert.equal(facts.ppid, process.ppid)
  assert.match(facts.processIdentity, /^(?:windows:\d+|linux:[a-f0-9]{32}:\d+)$/)
  assert.ok(facts.pgid > 0)

  const leaseIdentity = await createSystemLeaseProcessInspector().currentIdentity(process.pid)
  assert.equal(facts.processIdentity, leaseIdentity)
  const tree = host.processTree(process.pid, facts.processIdentity)
  assert.equal(tree.state, 'exact')
  assert.ok(tree.entries.some((entry) => entry.pid === process.pid && entry.processIdentity === facts.processIdentity))
  assert.deepEqual(host.processFacts(2_147_483_646), { state: 'dead' })
})

test('real listener smoke reports a test-owned loopback socket or fails closed on restricted procfs', async (t) => {
  const server = net.createServer((socket) => socket.destroy())
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise((resolve) => server.close(() => resolve())))
  const address = server.address()
  assert.ok(address && typeof address === 'object')

  const facts = createDaemonProcessHost().listenerFacts(address.port)
  if (facts.state === 'unknown') {
    assert.equal(process.platform, 'linux', 'Windows Get-NetTCPConnection provider must resolve the test listener')
    return
  }
  assert.equal(facts.state, 'present')
  assert.ok(facts.pids.includes(process.pid))
  assert.ok(facts.bindings.some((binding) => binding.pid === process.pid
    && binding.family === 'ipv4' && binding.address === '127.0.0.1' && binding.port === address.port))
})
