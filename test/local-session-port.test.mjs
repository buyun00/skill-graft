import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createHub } from '../dist/index.js'
import { isPortFault } from '../dist/application/index.js'
import { createLocalSessionPort } from '../dist/local/session/local-session-port.js'
import { createTemporaryTestHub } from './support/test-hub.mjs'

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function sessionsFile(root) {
  return path.join(root, 'skill-review', 'sessions.json')
}

function readSessions(root) {
  return JSON.parse(fs.readFileSync(sessionsFile(root), 'utf8')).sessions || []
}

function writeSessions(root, sessions) {
  fs.writeFileSync(sessionsFile(root), `${JSON.stringify({ sessions }, null, 2)}\n`, 'utf8')
}

function allFiles(root) {
  const files = []
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(full)
      else files.push(path.relative(root, full).replaceAll('\\', '/'))
    }
  }
  visit(root)
  return files.sort()
}

function fakeRunner(overrides = {}) {
  return {
    enabled: () => true,
    available: () => true,
    start: () => 0,
    pidAlive: () => false,
    ...overrides
  }
}

test('LocalSessionPort scoped reap inspects and updates only requested session IDs', async (t) => {
  const temporary = createTemporaryTestHub(sourceRoot)
  t.after(() => temporary.cleanup())
  const checkedPids = []
  const port = createLocalSessionPort(createHub(temporary.root), {
    runner: fakeRunner({
      pidAlive(pid) {
        checkedPids.push(pid)
        return false
      }
    })
  })

  const selected = await port.start({
    kind: 'chat',
    intent: 'selected scoped reap',
    options: { start: false }
  })
  const untouched = await port.start({
    kind: 'chat',
    intent: 'must remain untouched',
    options: { start: false }
  })
  const sessions = readSessions(temporary.root)
  const selectedRow = sessions.find((session) => session.id === selected.id)
  const untouchedRow = sessions.find((session) => session.id === untouched.id)
  selectedRow.status = 'running'
  selectedRow.pid = 10101
  untouchedRow.status = 'running'
  untouchedRow.pid = 20202
  writeSessions(temporary.root, sessions)
  fs.writeFileSync(path.join(temporary.root, 'skill-review', `session-${selected.id}.exit`), '0\n', 'utf8')
  fs.writeFileSync(path.join(temporary.root, 'skill-review', `session-${untouched.id}.exit`), '3\n', 'utf8')
  fs.writeFileSync(untouchedRow.logFile, 'session id: 0123456789abcdef0123456789abcdef\n', 'utf8')
  fs.writeFileSync(untouchedRow.lastFile, '验收摘要: must not be inspected\n', 'utf8')
  const untouchedBefore = structuredClone(untouchedRow)

  const reaped = await port.reap([selected.id])
  assert.deepEqual(checkedPids, [10101], 'scoped reap must not check another session process')
  assert.equal(reaped.length, 1)
  assert.equal(reaped[0].id, selected.id)
  assert.equal(reaped[0].status, 'waiting')
  const afterScoped = readSessions(temporary.root)
  assert.equal(afterScoped.find((session) => session.id === selected.id).status, 'waiting')
  assert.deepEqual(
    afterScoped.find((session) => session.id === untouched.id),
    untouchedBefore,
    'unrequested session storage must remain byte-for-field unchanged'
  )

  const beforeEmptyScope = fs.readFileSync(sessionsFile(temporary.root), 'utf8')
  assert.deepEqual(await port.reap([]), [], 'an explicit empty scope is a no-op')
  assert.equal(fs.readFileSync(sessionsFile(temporary.root), 'utf8'), beforeEmptyScope)
  assert.deepEqual(checkedPids, [10101])

  assert.equal(port.needsReap([selected.id]), false)
  assert.equal(port.needsReap([]), false)
  assert.equal(port.needsReap([untouched.id]), true)
  assert.deepEqual(checkedPids, [10101, 20202])
  const beforeGlobalCheck = fs.readFileSync(sessionsFile(temporary.root), 'utf8')
  assert.equal(port.needsReap(), true)
  assert.equal(fs.readFileSync(sessionsFile(temporary.root), 'utf8'), beforeGlobalCheck, 'needsReap is read-only')
})

test('LocalSessionPort preflights a required unavailable runner before enqueue', async (t) => {
  const temporary = createTemporaryTestHub(sourceRoot)
  t.after(() => temporary.cleanup())
  let enabledCalls = 0
  let availableCalls = 0
  let startCalls = 0
  const port = createLocalSessionPort(createHub(temporary.root), {
    runner: fakeRunner({
      enabled() {
        enabledCalls += 1
        return true
      },
      available() {
        availableCalls += 1
        return false
      },
      start() {
        startCalls += 1
        return 0
      }
    })
  })
  const sessionsBefore = fs.readFileSync(sessionsFile(temporary.root), 'utf8')
  const filesBefore = allFiles(temporary.root)

  await assert.rejects(
    port.start({
      kind: 'attach',
      locator: { kind: 'worktree', value: path.join(temporary.root, 'probe-worktree') },
      intent: 'must fail before enqueue',
      options: { start: true }
    }),
    (error) => isPortFault(error) && error.reason === 'runner-unavailable'
  )
  assert.equal(enabledCalls, 1)
  assert.equal(availableCalls, 1)
  assert.equal(startCalls, 0)
  assert.equal(fs.readFileSync(sessionsFile(temporary.root), 'utf8'), sessionsBefore)
  assert.deepEqual(allFiles(temporary.root), filesBefore, 'preflight failure must not create prompt, log, history, or session files')

  const queued = await port.start({
    kind: 'attach',
    locator: { kind: 'worktree', value: path.join(temporary.root, 'explicit-no-start') },
    intent: 'explicitly queue without a runner',
    options: { start: false }
  })
  assert.equal(queued.status, 'queued')
  assert.match(queued.target.id, /^worktree:[0-9a-f]{24}$/)
  assert.equal(queued.target.id.includes(temporary.root), false)
  const stored = readSessions(temporary.root)
  assert.equal(stored.length, 1)
  const prompt = fs.readFileSync(stored[0].promptFile, 'utf8')
  assert.match(prompt, /sg apply-legacy-attach/)
  assert.match(prompt, new RegExp(`--session-id "${queued.id}"`))
  assert.equal(prompt.includes('{{SESSION_ID}}'), false)
  assert.equal(availableCalls, 1, 'no-start must not probe runner availability')
  assert.equal(startCalls, 0)
})

test('LocalSessionPort wait timeout returns a durable running session instead of a false failure', async (t) => {
  const temporary = createTemporaryTestHub(sourceRoot)
  t.after(() => temporary.cleanup())
  const port = createLocalSessionPort(createHub(temporary.root), {
    runner: fakeRunner({ start: () => 30303, pidAlive: () => true }),
    waitTimeoutMs: 0,
    pollMs: 1,
    sleep: () => new Promise((resolve) => setTimeout(resolve, 2))
  })
  const session = await port.start({
    kind: 'chat',
    intent: 'wait deadline is not a runner failure',
    options: { start: true, wait: true }
  })
  assert.equal(session.status, 'running')
  assert.equal(readSessions(temporary.root)[0].status, 'running')
})
