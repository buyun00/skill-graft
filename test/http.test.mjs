import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { probeDaemonApiHealth } from '../dist/control/daemon.js'
import { openLocalHost } from '../dist/local/create-local-host.js'
import { createHttpCapability, createHttpServer, startApiListeners } from '../server/index.mjs'
import { hubRoot, spawnHub } from './helpers.mjs'
import { createTemporaryTestHub } from './support/test-hub.mjs'

function extractPathnameBranch(source, pathname) {
  const needle = `url.pathname === '${pathname}'`
  const idx = source.indexOf(needle)
  if (idx < 0) throw new Error(`missing ${pathname} branch`)
  const brace = source.indexOf('{', idx)
  let depth = 0
  for (let i = brace; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(brace, i + 1)
    }
  }
  throw new Error(`unclosed ${pathname} branch`)
}

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
}

async function listenQueryServer() {
  const host = await openLocalHost({
    packageRoot: hubRoot,
    dataRoot: process.env.SKILL_GRAFT_HOME || process.env.HUB_ROOT || hubRoot,
    hostId: 'http-query-test'
  })
  const transport = createHttpServer({ host })
  const { server } = transport
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return { server, transport, base: `http://127.0.0.1:${address.port}` }
}

async function getJson(base, route) {
  const res = await fetch(`${base}${route}`)
  const text = await res.text()
  assert.equal(res.ok, true, `${route} ${res.status} ${text}`)
  assert.ok(text.length > 0, `${route} empty body`)
  return JSON.parse(text)
}

test('daemon HTTP health binds the caller-provided startup epoch', async (t) => {
  const daemonEpoch = '11111111-1111-4111-8111-111111111111'
  const host = await openLocalHost({
    packageRoot: hubRoot,
    dataRoot: process.env.SKILL_GRAFT_HOME || process.env.HUB_ROOT || hubRoot,
    hostId: 'http-daemon-epoch-test'
  })
  const transport = createHttpServer({ host, daemonEpoch })
  t.after(async () => {
    await transport.close()
  })
  await new Promise((resolve, reject) => {
    transport.server.once('error', reject)
    transport.server.listen(0, '127.0.0.1', resolve)
  })
  const address = transport.server.address()
  assert.ok(address && typeof address === 'object')
  const response = await fetch(`http://127.0.0.1:${address.port}/api/health`)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-skill-graft-daemon-epoch'), daemonEpoch)

  assert.deepEqual(await probeDaemonApiHealth(address.port), {
    state: 'exact',
    epochId: daemonEpoch,
    packageRoot: path.resolve(host.packageRoot),
    dataRoot: path.resolve(host.dataRoot)
  })
})

test('daemon API health probe classifies explicit response defects as foreign', async (t) => {
  const daemonEpoch = '22222222-2222-4222-8222-222222222222'
  const packageRoot = path.resolve(hubRoot)
  const dataRoot = path.resolve(process.env.SKILL_GRAFT_HOME || process.env.HUB_ROOT || hubRoot)
  const authorityHeaders = {
    'Content-Type': 'application/json',
    'X-Skill-Graft-Daemon-Epoch': daemonEpoch,
    'X-Skill-Graft-Package-Root': encodeURIComponent(packageRoot),
    'X-Skill-Graft-Data-Root': encodeURIComponent(dataRoot)
  }
  let reply = { status: 200, headers: authorityHeaders, body: JSON.stringify({ ok: true }) }
  let lastConnection = ''
  const server = http.createServer((request, response) => {
    lastConnection = request.headers.connection || ''
    response.writeHead(reply.status, reply.headers)
    response.end(reply.body)
  })
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  }))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')

  const cases = [
    {
      name: 'non-success HTTP status',
      value: { status: 503, headers: authorityHeaders, body: JSON.stringify({ ok: true }) }
    },
    {
      name: 'malformed JSON body',
      value: { status: 200, headers: authorityHeaders, body: '{' }
    },
    {
      name: 'non-healthy body',
      value: { status: 200, headers: authorityHeaders, body: JSON.stringify({ ok: false }) }
    },
    {
      name: 'missing authority header',
      value: {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true })
      }
    },
    {
      name: 'invalid daemon epoch',
      value: {
        status: 200,
        headers: { ...authorityHeaders, 'X-Skill-Graft-Daemon-Epoch': 'not-an-epoch' },
        body: JSON.stringify({ ok: true })
      }
    },
    {
      name: 'relative package root',
      value: {
        status: 200,
        headers: { ...authorityHeaders, 'X-Skill-Graft-Package-Root': encodeURIComponent('relative/package') },
        body: JSON.stringify({ ok: true })
      }
    },
    {
      name: 'malformed data root encoding',
      value: {
        status: 200,
        headers: { ...authorityHeaders, 'X-Skill-Graft-Data-Root': '%ZZ' },
        body: JSON.stringify({ ok: true })
      }
    }
  ]

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      reply = entry.value
      assert.deepEqual(await probeDaemonApiHealth(address.port), { state: 'foreign' })
      assert.equal(lastConnection, 'close')
    })
  }
})

test('daemon API health probe keeps an unreachable connection unknown', async () => {
  const port = await reserveLoopbackPort()
  assert.deepEqual(await probeDaemonApiHealth(port, 250), { state: 'unknown' })
})

function commandData(payload) {
  return payload?.contractVersion === 1 && Object.hasOwn(payload, 'data')
    ? payload.data
    : payload
}

async function postJson(base, route, body, headers = {}) {
  const res = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body || {})
  })
  const text = await res.text()
  assert.equal(res.ok, true, `${route} ${res.status} ${text}`)
  assert.ok(text.length > 0, `${route} empty body`)
  return JSON.parse(text)
}

async function requestHttp(base, options = {}) {
  const target = new URL(base)
  const body = options.body == null ? null : String(options.body)
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      method: options.method || 'GET',
      path: options.path || '/',
      headers: {
        ...(body == null ? {} : { 'Content-Length': Buffer.byteLength(body) }),
        ...(options.headers || {})
      }
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }))
    })
    req.once('error', reject)
    if (body != null) req.write(body)
    req.end()
  })
}

async function listenTransport(transport) {
  await listenTransportAt(transport, 0, '127.0.0.1')
  const address = transport.server.address()
  return `http://127.0.0.1:${address.port}`
}

async function listenTransportAt(transport, port, bindHost) {
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      transport.server.off('error', onError)
      transport.server.off('listening', onListening)
    }
    const onError = (error) => {
      cleanup()
      reject(error)
    }
    const onListening = () => {
      cleanup()
      resolve()
    }
    transport.server.once('error', onError)
    transport.server.once('listening', onListening)
    try {
      transport.server.listen(port, bindHost)
    } catch (error) {
      cleanup()
      reject(error)
    }
  })
}

function fakeHost(execute, options = {}) {
  let sequence = 0
  return {
    packageRoot: options.packageRoot || hubRoot,
    dataRoot: options.dataRoot || hubRoot,
    hostId: options.hostId || 'http-fake-host',
    localSessions: {
      needsReap: () => false,
      readLog: (id) => options.readLog?.(id) || ''
    },
    commandMeta(transport, requestId) {
      sequence += 1
      return {
        contractVersion: 1,
        requestId: requestId || `fake-http-${sequence}`,
        hostId: this.hostId,
        transport
      }
    },
    application: { execute }
  }
}

function fileFingerprint(file) {
  const body = fs.readFileSync(file)
  const stat = fs.statSync(file)
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    sha256: crypto.createHash('sha256').update(body).digest('hex')
  }
}

async function reserveLoopbackPort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = address.port
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function stopOwnedChild(child) {
  if (child.exitCode != null || child.signalCode != null) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
  try { child.kill('SIGTERM') } catch { /* exact owned child already exited */ }
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))])
  if (child.exitCode == null && child.signalCode == null) {
    try { child.kill('SIGKILL') } catch { /* exact owned child already exited */ }
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))])
  }
}

async function startCliBlockedServer(dataRoot) {
  const spyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-http-cli-spy-'))
  const preload = path.join(spyRoot, 'block-cli.cjs')
  const marker = path.join(spyRoot, 'cli-spawn.jsonl')
  fs.writeFileSync(preload, String.raw`
const fs = require('node:fs')
const childProcess = require('node:child_process')
const { syncBuiltinESMExports } = require('node:module')
const { promisify } = require('node:util')
const marker = process.env.SKILL_GRAFT_HTTP_CLI_MARKER
const flatten = (value) => Array.isArray(value)
  ? value.flatMap(flatten)
  : (typeof value === 'string' || typeof value === 'number' ? [String(value)] : [])
for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const original = childProcess[method]
  const wrapped = function (...args) {
    const command = flatten(args).join(' ')
    const normalized = command.replaceAll('\\', '/').toLowerCase()
    if (normalized.includes('dist/control/cli.js')) {
      fs.appendFileSync(marker, JSON.stringify({ method, command }) + '\n')
      throw new Error('HTTP attempted to start the CLI intermediary')
    }
    return original.apply(this, args)
  }
  if (method === 'exec' || method === 'execFile') {
    wrapped[promisify.custom] = (...args) => new Promise((resolve, reject) => {
      wrapped(...args, (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout
          error.stderr = stderr
          reject(error)
        } else {
          resolve({ stdout, stderr })
        }
      })
    })
  }
  childProcess[method] = wrapped
}
syncBuiltinESMExports()
`, 'utf8')

  const port = await reserveLoopbackPort()
  const stdout = []
  const stderr = []
  const child = spawn(process.execPath, ['--require', preload, path.join(hubRoot, 'server', 'index.mjs')], {
    cwd: hubRoot,
    env: {
      ...process.env,
      SKILL_GRAFT_HOME: dataRoot,
      HUB_ROOT: dataRoot,
      HUB_API_PORT: String(port),
      HUB_SPAWN_CODEX: '0',
      SKILL_GRAFT_HTTP_CLI_MARKER: marker
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  child.stdout.on('data', (chunk) => stdout.push(String(chunk)))
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)))

  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 10000
  for (;;) {
    if (child.exitCode != null || child.signalCode != null) {
      fs.rmSync(spyRoot, { recursive: true, force: true })
      throw new Error(`HTTP server exited before health check\n${stdout.join('')}\n${stderr.join('')}`)
    }
    try {
      const health = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) })
      if (health.ok) break
    } catch {
      // The owned child has not bound its random loopback port yet.
    }
    if (Date.now() >= deadline) {
      await stopOwnedChild(child)
      fs.rmSync(spyRoot, { recursive: true, force: true })
      throw new Error(`HTTP server health check timed out\n${stdout.join('')}\n${stderr.join('')}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  const panel = await fetch(`${base}/`)
  const capabilityCookie = String(panel.headers.get('set-cookie') || '').split(';', 1)[0]
  if (!panel.ok || !capabilityCookie) {
    await stopOwnedChild(child)
    fs.rmSync(spyRoot, { recursive: true, force: true })
    throw new Error(`HTTP server did not issue the panel capability cookie\n${stdout.join('')}\n${stderr.join('')}`)
  }

  return {
    base,
    child,
    capabilityCookie,
    marker,
    output: () => `${stdout.join('')}\n${stderr.join('')}`,
    async stop() {
      await stopOwnedChild(child)
      fs.rmSync(spyRoot, { recursive: true, force: true })
    }
  }
}

function seedHttpApplicationFixture(root) {
  const inboxId = 'http-reject-probe'
  const inboxRel = `skills/inbox/${inboxId}`
  const inbox = path.join(root, ...inboxRel.split('/'))
  fs.mkdirSync(inbox, { recursive: true })
  fs.writeFileSync(path.join(inbox, 'SKILL.md'), '# isolated HTTP reject probe\n', 'utf8')
  fs.writeFileSync(path.join(root, 'skill-review', 'state.json'), `${JSON.stringify({
    version: 1,
    lastIngest: null,
    items: [{
      id: inboxId,
      name: inboxId,
      unit: inboxRel,
      status: 'queued',
      inboxPath: inboxRel,
      createdAt: '2000-01-01T00:00:00.000Z',
      updatedAt: '2000-01-01T00:00:00.000Z',
      suggestion: { action: '', target: '', reason: '', confidence: '' }
    }]
  }, null, 2)}\n`, 'utf8')
  fs.writeFileSync(
    path.join(root, 'skill-review', 'history', '000-http-fixture.json'),
    '{"type":"decide","id":"http-fixture","action":"reject","note":"fixture"}\n',
    'utf8'
  )

  const sessionId = 'http-hydrate-probe'
  const promptFile = path.join(root, 'skill-review', `prompt-${sessionId}.txt`)
  const logFile = path.join(root, 'skill-review', `session-${sessionId}.log`)
  const lastFile = path.join(root, 'skill-review', `session-${sessionId}.last.txt`)
  fs.writeFileSync(promptFile, 'isolated prompt\n', 'utf8')
  fs.writeFileSync(logFile, 'session id: 11111111-2222-3333-4444-555555555555\n', 'utf8')
  fs.writeFileSync(lastFile, 'isolated hydrated message\n', 'utf8')
  const sessionsFile = path.join(root, 'skill-review', 'sessions.json')
  fs.writeFileSync(sessionsFile, `${JSON.stringify({
    sessions: [{
      id: sessionId,
      kind: 'chat',
      path: '',
      worktree: '',
      intent: 'hydrate without writing',
      pid: 0,
      promptFile,
      logFile,
      lastFile,
      startedAt: '2000-01-01T00:00:00.000Z',
      status: 'completed',
      exitCode: 0,
      error: '',
      codexSessionId: '',
      summary: '',
      lastMessage: '',
      inboxIds: []
    }]
  }, null, 2)}\n`, 'utf8')
  return { inbox, inboxId, sessionId, sessionsFile }
}

test('HTTP business handlers use one in-process Application and never the CLI intermediary', () => {
  const source = fs.readFileSync(path.join(hubRoot, 'server', 'index.mjs'), 'utf8')
  assert.doesNotMatch(source, /node:child_process/)
  assert.doesNotMatch(source, /\bspawnSync\b/)
  assert.doesNotMatch(source, /\brunHub\b/)
  assert.doesNotMatch(source, /\bcliPath\b/)
  assert.doesNotMatch(source, /dist[\\/]control[\\/]cli\.js/)
  assert.match(source, /openLocalHost/)
  assert.match(source, /export function createHttpServer/)
  assert.match(source, /host\.application\.execute\(command\)/)
  assert.match(source, /localSessions\?\.needsReap/)
  assert.match(source, /const result = await executeTyped\(typedCommand/)
  assert.doesNotMatch(source, /\bcreateHub\b/)
  assert.doesNotMatch(source, /\bgetStatus\b/)
  assert.doesNotMatch(source, /from ['"][^'"]*(?:src|dist)[\\/]core[\\/]/)
  assert.doesNotMatch(source, /promote-inbox\.ps1/)
  assert.doesNotMatch(source, /attach-library\.ps1/)
  assert.doesNotMatch(source, /analyze-remote-skill-update\.ps1/)

  const factoryStart = source.indexOf('export function createHttpServer')
  const factoryEnd = source.indexOf('\nfunction isMainModule', factoryStart)
  assert.ok(factoryStart >= 0 && factoryEnd > factoryStart, 'createHttpServer is present')
  assert.doesNotMatch(source.slice(factoryStart, factoryEnd), /openLocalHost|createLocalHost/)

  const start = source.indexOf('async function handleApi')
  const end = source.indexOf('\n  async function findSession', start)
  assert.ok(start >= 0 && end > start, 'handleApi is present')
  const handleApi = source.slice(start, end)
  const state = extractPathnameBranch(handleApi, '/api/state')
  assert.match(state, /executeLegacy\(req, body, 'status'\)/)
  assert.doesNotMatch(state, /reapSessions/)
  assert.doesNotMatch(state, /readdir/)
  const worktrees = extractPathnameBranch(handleApi, '/api/worktrees')
  assert.match(worktrees, /executeLegacy\(req, body, 'listWorktrees'/)
  assert.doesNotMatch(worktrees, /Cache/)
  assert.doesNotMatch(worktrees, /readdir/)

  for (const [route, expected] of [
    ['/api/command', /executeTyped/],
    ['/api/skill', /executeLegacy\(req, body, 'readSkill'/],
    ['/api/history', /executeLegacy\(req, body, 'listHistory'/],
    ['/api/codex/sessions', /executeLegacy\(req, body, 'listSessions'/],
    ['/api/codex/session', /executeTyped\(typedCommand\(req, body, 'getSession'/],
    ['/api/decide', /executeLegacy\(req, body, 'decide'/],
    ['/api/analyze', /executeLegacy\(req, body, 'analyze', sessionInput\('analyze'/],
    ['/api/codex/start', /executeLegacy/],
    ['/api/codex/resume', /executeLegacy\(req, body, 'resumeSession'/],
    ['/api/worktree/attach', /executeLegacy\(req, body, 'attach'/],
    ['/api/worktree/detach', /executeLegacy\(req, body, 'detach'/]
  ]) {
    assert.match(extractPathnameBranch(handleApi, route), expected, route)
  }
})

test('standalone listener startup rejects atomically when IPv4 is occupied and never starts IPv6', async (t) => {
  const occupied = net.createServer()
  await new Promise((resolve, reject) => {
    occupied.once('error', reject)
    occupied.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise((resolve) => occupied.close(resolve)))
  const occupiedAddress = occupied.address()
  const port = occupiedAddress.port
  const listenCalls = []
  const signals = new EventEmitter()
  const host = fakeHost(async () => {
    throw new Error('Application must not run during listener startup')
  })

  await assert.rejects(
    startApiListeners({
      host,
      packageRoot: hubRoot,
      dataRoot: hubRoot,
      port,
      signalTarget: signals,
      listenTransport: async (transport, requestedPort, bindHost) => {
        listenCalls.push({ bindHost, port: requestedPort })
        await listenTransportAt(transport, requestedPort, bindHost)
      },
      log: () => {},
      warn: () => {},
      logError: () => {}
    }),
    (error) => error?.code === 'EADDRINUSE'
  )

  assert.deepEqual(listenCalls, [{ bindHost: '127.0.0.1', port }])
  assert.equal(signals.listenerCount('SIGTERM'), 0)
  assert.equal(signals.listenerCount('SIGINT'), 0)
})

test('standalone listener degrades unsupported IPv6 and closes IPv4 and signal handlers idempotently', async (t) => {
  const signals = new EventEmitter()
  const listenCalls = []
  const warnings = []
  const shutdownErrors = []
  const host = fakeHost(async () => {
    throw new Error('Application must not run for the health probe')
  })
  let runtime
  t.after(async () => {
    await runtime?.close()
  })

  runtime = await startApiListeners({
    host,
    packageRoot: hubRoot,
    dataRoot: hubRoot,
    port: 0,
    signalTarget: signals,
    listenTransport: async (transport, requestedPort, bindHost) => {
      listenCalls.push({ bindHost, port: requestedPort })
      if (bindHost === '::1') {
        throw Object.assign(new Error('IPv6 is unavailable in this focused fixture'), {
          code: 'EAFNOSUPPORT'
        })
      }
      await listenTransportAt(transport, requestedPort, bindHost)
    },
    log: () => {},
    warn: (message) => warnings.push(message),
    logError: (...args) => shutdownErrors.push(args)
  })

  assert.equal(runtime.transports.length, 1)
  const address = runtime.transports[0].server.address()
  assert.equal(address.address, '127.0.0.1')
  assert.ok(address.port > 0)
  assert.deepEqual(listenCalls, [
    { bindHost: '127.0.0.1', port: 0 },
    { bindHost: '::1', port: address.port }
  ])
  assert.deepEqual(warnings, [
    'skill-graft IPv6 API unavailable (EAFNOSUPPORT); continuing on IPv4'
  ])
  assert.equal(signals.listenerCount('SIGTERM'), 1)
  assert.equal(signals.listenerCount('SIGINT'), 1)

  const health = await fetch(`http://127.0.0.1:${address.port}/api/health`)
  assert.equal(health.status, 200)
  assert.deepEqual(await health.json(), { ok: true })

  assert.equal(signals.emit('SIGTERM'), true)
  const firstClose = runtime.close()
  const secondClose = runtime.close()
  assert.strictEqual(firstClose, secondClose)
  assert.equal(signals.emit('SIGTERM'), false)
  assert.equal(signals.emit('SIGINT'), false)
  await firstClose
  assert.deepEqual(shutdownErrors, [])
  assert.equal(signals.listenerCount('SIGTERM'), 0)
  assert.equal(signals.listenerCount('SIGINT'), 0)

  const rebound = net.createServer()
  await new Promise((resolve, reject) => {
    rebound.once('error', reject)
    rebound.listen(address.port, '127.0.0.1', resolve)
  })
  await new Promise((resolve) => rebound.close(resolve))
})

test('standalone listener rejects unexpected IPv6 errors and releases the started IPv4 port', async () => {
  const signals = new EventEmitter()
  const host = fakeHost(async () => {
    throw new Error('Application must not run during listener startup')
  })
  let ipv4Port = 0

  await assert.rejects(
    startApiListeners({
      host,
      packageRoot: hubRoot,
      dataRoot: hubRoot,
      port: 0,
      signalTarget: signals,
      listenTransport: async (transport, requestedPort, bindHost) => {
        if (bindHost === '::1') {
          throw Object.assign(new Error('unexpected IPv6 permission failure'), { code: 'EACCES' })
        }
        await listenTransportAt(transport, requestedPort, bindHost)
        ipv4Port = transport.server.address().port
      },
      log: () => {},
      warn: () => {},
      logError: () => {}
    }),
    (error) => error?.code === 'EACCES'
  )

  assert.ok(ipv4Port > 0)
  assert.equal(signals.listenerCount('SIGTERM'), 0)
  assert.equal(signals.listenerCount('SIGINT'), 0)
  const rebound = net.createServer()
  await new Promise((resolve, reject) => {
    rebound.once('error', reject)
    rebound.listen(ipv4Port, '127.0.0.1', resolve)
  })
  await new Promise((resolve) => rebound.close(resolve))
})

test('standalone listener uses the install data-root resolver while an explicit dataRoot wins', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-standalone-data-root-'))
  const packageRoot = path.join(root, 'package')
  const resolvedDataRoot = path.join(root, 'resolved-data')
  const explicitDataRoot = path.join(root, 'explicit-data')
  fs.mkdirSync(packageRoot, { recursive: true })
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const host = fakeHost(async () => {
    throw new Error('Application must not run for the health probe')
  }, { packageRoot, dataRoot: resolvedDataRoot })
  const runtimes = []
  t.after(async () => {
    await Promise.all(runtimes.map((runtime) => runtime.close()))
  })
  const common = {
    host,
    packageRoot,
    port: 0,
    listenTransport: async (transport, requestedPort, bindHost) => {
      if (bindHost === '::1') {
        throw Object.assign(new Error('fixture has no IPv6'), { code: 'EAFNOSUPPORT' })
      }
      await listenTransportAt(transport, requestedPort, bindHost)
    },
    log: () => {},
    warn: () => {},
    logError: () => {}
  }

  const resolverCalls = []
  const resolved = await startApiListeners({
    ...common,
    signalTarget: new EventEmitter(),
    resolveDataRoot(candidatePackageRoot) {
      resolverCalls.push(candidatePackageRoot)
      return resolvedDataRoot
    }
  })
  runtimes.push(resolved)
  assert.deepEqual(resolverCalls, [path.resolve(packageRoot)])
  assert.equal(samePath(resolvedDataRoot, packageRoot), false)
  const resolvedAddress = resolved.transports[0].server.address()
  const resolvedHealth = await fetch(`http://127.0.0.1:${resolvedAddress.port}/api/health`)
  assert.equal(
    samePath(decodeURIComponent(resolvedHealth.headers.get('x-skill-graft-data-root') || ''), resolvedDataRoot),
    true
  )
  await resolved.close()

  let explicitResolverCalls = 0
  const explicit = await startApiListeners({
    ...common,
    dataRoot: explicitDataRoot,
    signalTarget: new EventEmitter(),
    resolveDataRoot() {
      explicitResolverCalls += 1
      return resolvedDataRoot
    }
  })
  runtimes.push(explicit)
  assert.equal(explicitResolverCalls, 0)
  const explicitAddress = explicit.transports[0].server.address()
  const explicitHealth = await fetch(`http://127.0.0.1:${explicitAddress.port}/api/health`)
  assert.equal(
    samePath(decodeURIComponent(explicitHealth.headers.get('x-skill-graft-data-root') || ''), explicitDataRoot),
    true
  )
})

test('HTTP transport rejects foreign authorities and gates writes with an HttpOnly panel capability', async (t) => {
  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-http-web-'))
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-http-outside-'))
  const outsideBytes = `outside-static-secret-${crypto.randomBytes(12).toString('hex')}`
  const outsideFile = path.join(outsideRoot, 'secret.txt')
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>isolated panel</title>', 'utf8')
  fs.writeFileSync(outsideFile, outsideBytes, 'utf8')
  let fileSymlinkCreated = false
  let directoryLinkCreated = false
  try {
    fs.symlinkSync(outsideFile, path.join(webRoot, 'linked-secret.txt'), 'file')
    fileSymlinkCreated = true
  } catch (error) {
    t.diagnostic(`file symlink fixture unavailable: ${error.code || error.message}`)
  }
  try {
    fs.symlinkSync(outsideRoot, path.join(webRoot, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir')
    directoryLinkCreated = true
  } catch (error) {
    t.diagnostic(`directory link fixture unavailable: ${error.code || error.message}`)
  }
  const calls = []
  const host = fakeHost(async (command) => {
    calls.push(command)
    const base = {
      contractVersion: 1,
      requestId: command.meta.requestId,
      commandKind: command.kind,
      events: [],
      meta: { replayed: false, handler: 'application.commandBus' }
    }
    if (command.kind === 'planSync') {
      return { ...base, ok: false, error: { code: 'CONFLICT', message: 'application conflict' } }
    }
    return { ...base, ok: true, data: { accepted: command.kind } }
  }, { packageRoot: webRoot, dataRoot: webRoot })
  const transport = createHttpServer({
    host,
    webRoot,
    bodyLimitBytes: 128,
    getDiagnostics: async () => ({ ok: true }),
    getDaemonStatus: async () => ({ ok: true })
  })
  const base = await listenTransport(transport)
  const port = new URL(base).port
  t.after(async () => {
    await transport.close()
    fs.rmSync(webRoot, { recursive: true, force: true })
    fs.rmSync(outsideRoot, { recursive: true, force: true })
  })

  const foreignHost = await requestHttp(base, {
    method: 'POST',
    path: '/api/command',
    headers: { Host: `attacker.invalid:${port}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'status' })
  })
  assert.equal(foreignHost.status, 403)
  assert.equal(JSON.parse(foreignHost.body).error.code, 'HTTP_FORBIDDEN_HOST')

  const foreignOrigin = await requestHttp(base, {
    method: 'POST',
    path: '/api/command',
    headers: {
      Host: `127.0.0.1:${port}`,
      Origin: 'http://attacker.invalid',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ kind: 'status' })
  })
  assert.equal(foreignOrigin.status, 403)
  assert.equal(JSON.parse(foreignOrigin.body).error.code, 'HTTP_FORBIDDEN_ORIGIN')
  assert.equal(calls.length, 0, 'foreign Host/Origin must not reach Application')

  const wrongMethod = await requestHttp(base, { path: '/api/command' })
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.headers.allow, 'POST')
  assert.equal(JSON.parse(wrongMethod.body).error.code, 'HTTP_METHOD_NOT_ALLOWED')

  const wrongType = await requestHttp(base, {
    method: 'POST',
    path: '/api/command',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ kind: 'status' })
  })
  assert.equal(wrongType.status, 415)
  assert.equal(JSON.parse(wrongType.body).error.code, 'HTTP_UNSUPPORTED_MEDIA_TYPE')

  const malformed = await requestHttp(base, {
    method: 'POST',
    path: '/api/command',
    headers: { 'Content-Type': 'application/json' },
    body: '{'
  })
  assert.equal(malformed.status, 400)
  assert.equal(JSON.parse(malformed.body).error.code, 'HTTP_INVALID_JSON')

  const nonObject = await requestHttp(base, {
    method: 'POST',
    path: '/api/command',
    headers: { 'Content-Type': 'application/json' },
    body: '[]'
  })
  assert.equal(nonObject.status, 400)
  assert.equal(JSON.parse(nonObject.body).error.code, 'HTTP_INVALID_JSON')

  const oversized = await requestHttp(base, {
    method: 'POST',
    path: '/api/command',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'status', padding: 'x'.repeat(200) })
  })
  assert.equal(oversized.status, 413)
  assert.equal(JSON.parse(oversized.body).error.code, 'HTTP_PAYLOAD_TOO_LARGE')

  const unauthenticatedSse = await requestHttp(base, {
    path: '/api/codex/session/stream?id=secret-session'
  })
  assert.equal(unauthenticatedSse.status, 403)
  assert.equal(JSON.parse(unauthenticatedSse.body).error.code, 'HTTP_CAPABILITY_REQUIRED')
  assert.equal(calls.length, 0, 'unauthenticated SSE must not query Application or session logs')

  const applicationFailure = await requestHttp(base, {
    method: 'POST',
    path: '/api/command',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'planSync', worktree: 'C:\\isolated' })
  })
  assert.equal(applicationFailure.status, 200, 'valid Application failures stay HTTP 200')
  assert.equal(JSON.parse(applicationFailure.body).error.code, 'CONFLICT')

  const deniedWrite = await requestHttp(base, {
    method: 'POST',
    path: '/api/command',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'chat', intent: 'must be denied' })
  })
  assert.equal(deniedWrite.status, 403)
  assert.equal(JSON.parse(deniedWrite.body).error.code, 'HTTP_CAPABILITY_REQUIRED')
  assert.equal(calls.length, 1, 'denied write must not reach Application')

  const panel = await requestHttp(base)
  assert.equal(panel.status, 200)
  const setCookie = String(panel.headers['set-cookie'] || '')
  assert.match(setCookie, /^skill_graft_capability=/)
  assert.match(setCookie, /; HttpOnly;/)
  assert.match(setCookie, /; SameSite=Strict$/)
  const cookie = setCookie.split(';', 1)[0]

  const forbiddenStaticPaths = [
    ...(fileSymlinkCreated ? ['/linked-secret.txt'] : []),
    ...(directoryLinkCreated ? ['/outside-link/secret.txt'] : []),
    `/%252e%252e/${encodeURIComponent(path.basename(outsideRoot))}/secret.txt`,
    `/%2e%2e%5c${encodeURIComponent(path.basename(outsideRoot))}%5csecret.txt`
  ]
  for (const forbiddenPath of forbiddenStaticPaths) {
    const response = await requestHttp(base, { path: forbiddenPath })
    assert.equal(response.status, 404, forbiddenPath)
    assert.doesNotMatch(response.body, new RegExp(outsideBytes), forbiddenPath)
  }

  const health = await requestHttp(base, { path: '/api/health' })
  assert.equal(health.status, 200)
  assert.equal(health.headers['set-cookie'], undefined)
  assert.doesNotMatch(health.body, new RegExp(cookie.split('=', 2)[1]))

  const acceptedWrite = await requestHttp(base, {
    method: 'POST',
    path: '/api/command',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ kind: 'chat', intent: 'capability accepted' })
  })
  assert.equal(acceptedWrite.status, 200)
  assert.equal(JSON.parse(acceptedWrite.body).data.accepted, 'chat')
  assert.equal(calls.length, 2)

  const deniedDeprecatedWrite = await requestHttp(base, {
    method: 'POST',
    path: '/api/decide',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'probe', action: 'reject' })
  })
  assert.equal(deniedDeprecatedWrite.status, 403)
  assert.equal(calls.length, 2)
})

test('one opaque capability authorizes sibling loopback transports but not another logical instance', async (t) => {
  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-http-shared-capability-'))
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>shared capability</title>', 'utf8')
  let effects = 0
  const host = fakeHost(async (command) => {
    effects += 1
    return {
      contractVersion: 1,
      requestId: command.meta.requestId,
      commandKind: command.kind,
      ok: true,
      data: { accepted: command.kind },
      events: [],
      meta: { replayed: false, handler: 'application.commandBus' }
    }
  }, { packageRoot: webRoot, dataRoot: webRoot })
  const capability = createHttpCapability()
  assert.deepEqual(Object.keys(capability), [], 'opaque handle must not expose secret material')
  const sharedA = createHttpServer({ host, webRoot, capability })
  const sharedB = createHttpServer({ host, webRoot, capability })
  const isolated = createHttpServer({ host, webRoot })
  const [baseA, baseB, baseIsolated] = await Promise.all([
    listenTransport(sharedA),
    listenTransport(sharedB),
    listenTransport(isolated)
  ])
  t.after(async () => {
    await Promise.all([sharedA.close(), sharedB.close(), isolated.close()])
    fs.rmSync(webRoot, { recursive: true, force: true })
  })

  const panel = await requestHttp(baseA)
  const cookie = String(panel.headers['set-cookie'] || '').split(';', 1)[0]
  assert.match(cookie, /^skill_graft_capability=/)
  assert.equal(Object.hasOwn(sharedA, 'capability'), false)

  const siblingWrite = await requestHttp(baseB, {
    method: 'POST',
    path: '/api/command',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ kind: 'chat', intent: 'shared logical instance' })
  })
  assert.equal(siblingWrite.status, 200)
  assert.equal(effects, 1)

  const isolatedWrite = await requestHttp(baseIsolated, {
    method: 'POST',
    path: '/api/command',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ kind: 'chat', intent: 'different logical instance' })
  })
  assert.equal(isolatedWrite.status, 403)
  assert.equal(JSON.parse(isolatedWrite.body).error.code, 'HTTP_CAPABILITY_REQUIRED')
  assert.equal(effects, 1, 'different logical capability must be rejected before Application')
})

test('SSE emits an explicit terminal event and stops polling after client abort', async (t) => {
  let status = 'completed'
  let calls = 0
  const longLog = 'x'.repeat(20000)
  const host = fakeHost(async (command) => {
    calls += 1
    return {
      contractVersion: 1,
      requestId: command.meta.requestId,
      commandKind: command.kind,
      ok: true,
      data: {
        session: {
          id: command.sessionId,
          kind: 'chat',
          status,
          lastMessage: '',
          error: '',
          exitCode: status === 'completed' ? 0 : null,
          continuationToken: ''
        }
      },
      events: [],
      meta: { replayed: false, handler: 'application.commandBus' }
    }
  }, { readLog: () => longLog })
  const transport = createHttpServer({
    host,
    streamPollMs: 10,
    streamHeartbeatMs: 100,
    getDiagnostics: async () => ({ ok: true }),
    getDaemonStatus: async () => ({ ok: true })
  })
  const base = await listenTransport(transport)
  t.after(() => transport.close())
  const panel = await requestHttp(base)
  const cookie = String(panel.headers['set-cookie'] || '').split(';', 1)[0]

  const terminal = await fetch(`${base}/api/codex/session/stream?id=terminal`, {
    headers: { Cookie: cookie }
  })
  const terminalText = await terminal.text()
  assert.match(terminalText, /event: status/)
  assert.match(terminalText, /"status":"completed"/)
  assert.match(terminalText, /event: end/)
  assert.match(terminalText, /"reason":"settled"/)
  const logData = terminalText.match(/event: log\ndata: (\{[^\n]+\})/)
  assert.ok(logData, 'bounded log event')
  const boundedLog = JSON.parse(logData[1])
  assert.equal(Buffer.byteLength(boundedLog.text), 8192)
  assert.equal(boundedLog.offset, 11808)
  assert.equal(boundedLog.totalBytes, 20000)
  assert.equal(boundedLog.truncated, true)

  status = 'running'
  calls = 0
  const controller = new AbortController()
  const running = await fetch(`${base}/api/codex/session/stream?id=running`, {
    signal: controller.signal,
    headers: { Cookie: cookie }
  })
  const reader = running.body.getReader()
  await reader.read()
  await new Promise((resolve) => setTimeout(resolve, 35))
  controller.abort()
  try { await reader.cancel() } catch { /* abort owns this exact stream */ }
  await new Promise((resolve) => setTimeout(resolve, 30))
  const afterAbort = calls
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(calls, afterAbort, 'aborted SSE stream must not reconnect or keep polling')
})

test('real isolated HTTP server uses Application without CLI child and keeps session queries read-only', { timeout: 30000 }, async (t) => {
  const temporaryHub = createTemporaryTestHub(hubRoot)
  let runtime
  t.after(async () => {
    if (runtime) await runtime.stop()
    temporaryHub.cleanup()
  })
  const fixture = seedHttpApplicationFixture(temporaryHub.root)
  runtime = await startCliBlockedServer(temporaryHub.root)

  const sessionsBefore = fileFingerprint(fixture.sessionsFile)
  const sessions = await getJson(runtime.base, '/api/codex/sessions')
  const hydrated = sessions.sessions.find((item) => item.id === fixture.sessionId)
  assert.ok(hydrated, 'seeded session missing from list')
  assert.equal(hydrated.status, 'waiting')
  assert.equal(hydrated.codexSessionId, '11111111-2222-3333-4444-555555555555')
  assert.match(hydrated.logTail, /session id:/)

  const detail = await getJson(runtime.base, `/api/codex/session?id=${encodeURIComponent(fixture.sessionId)}`)
  assert.equal(detail.session.id, fixture.sessionId)
  assert.equal(detail.session.status, 'waiting')
  assert.match(detail.log, /11111111-2222-3333-4444-555555555555/)
  assert.deepEqual(fileFingerprint(fixture.sessionsFile), sessionsBefore, 'session GET routes must not persist hydration')

  const missingSse = await fetch(`${runtime.base}/api/codex/session/stream?id=missing-http-session`, {
    headers: { Cookie: runtime.capabilityCookie },
    signal: AbortSignal.timeout(3000)
  })
  const missingEvents = await missingSse.text()
  assert.equal(missingSse.ok, true, missingEvents)
  assert.match(missingEvents, /event: status/)
  assert.match(missingEvents, /"status":"missing"/)
  assert.match(missingEvents, /event: end/)
  assert.match(missingEvents, /"reason":"missing"/)
  const legacySse = await fetch(`${runtime.base}/api/codex/session/stream?id=${encodeURIComponent(fixture.sessionId)}`, {
    headers: { Cookie: runtime.capabilityCookie },
    signal: AbortSignal.timeout(3000)
  })
  const legacyEvents = await legacySse.text()
  assert.match(legacyEvents, /"continuationToken":"11111111-2222-3333-4444-555555555555"/)
  assert.match(legacyEvents, /"codexSessionId":"11111111-2222-3333-4444-555555555555"/)
  assert.match(legacyEvents, /event: end/)
  assert.match(legacyEvents, /"reason":"settled"/)
  const requestLedger = path.join(temporaryHub.root, 'skill-review', 'application-ledger.json')
  const auditLog = path.join(temporaryHub.root, 'skill-review', 'application-audit.json')
  assert.equal(fs.existsSync(requestLedger), false)
  assert.equal(fs.existsSync(auditLog), false)

  const state = await getJson(runtime.base, '/api/state')
  assert.ok(Array.isArray(state.resident))
  assert.equal(state.counts.queued, 1)

  const worktrees = await getJson(runtime.base, '/api/worktrees')
  assert.deepEqual(worktrees.scanRoots, [])
  assert.deepEqual(worktrees.worktrees, [])

  const skill = await getJson(runtime.base, `/api/skill?path=${encodeURIComponent('skills/ozdqp-development')}`)
  assert.equal(skill.path, 'skills/ozdqp-development')
  assert.match(skill.content, /Temporary default-test fixture/)

  const history = await getJson(runtime.base, '/api/history')
  assert.ok(history.records.some((record) => record.type === 'decide' && record.id === 'http-fixture'))
  assert.equal(fs.existsSync(requestLedger), false, 'read-only HTTP routes must not create a request ledger')
  assert.equal(fs.existsSync(auditLog), false, 'read-only HTTP routes must not create audit events')

  const analyzed = await postJson(runtime.base, '/api/analyze', {
    id: fixture.inboxId,
    intent: 'Analyze the isolated HTTP inbox item',
    model: 'http-compat-model',
    effort: 'http-compat-effort',
    start: false,
    wait: true,
    requestId: 'http-runtime-analyze'
  }, { Cookie: runtime.capabilityCookie })
  assert.equal(analyzed.ok, true)
  assert.equal(analyzed.action, 'analyze')
  assert.equal(analyzed.session.kind, 'analyze')
  assert.equal(analyzed.session.status, 'queued')
  assert.equal(analyzed.session.model, 'http-compat-model')
  assert.equal(analyzed.session.effort, 'http-compat-effort')
  assert.deepEqual(analyzed.session.inboxIds, [fixture.inboxId])

  const analyzeLedger = JSON.parse(fs.readFileSync(requestLedger, 'utf8'))
  const analyzeEntry = analyzeLedger.entries.find((entry) => entry.requestId === 'http-runtime-analyze')
  assert.equal(analyzeEntry.commandKind, 'analyze', 'the Application ledger must observe analyze, never chat')
  assert.equal(analyzeEntry.result.commandKind, 'analyze')

  const sessionDocument = JSON.parse(fs.readFileSync(fixture.sessionsFile, 'utf8'))
  const analyzeRow = sessionDocument.sessions.find((session) => session.id === analyzed.session.id)
  assert.ok(analyzeRow, 'analyze session was not persisted')
  analyzeRow.status = 'running'
  analyzeRow.pid = 99999999
  analyzeRow.exitCode = null
  fs.writeFileSync(fixture.sessionsFile, `${JSON.stringify(sessionDocument, null, 2)}\n`, 'utf8')
  fs.writeFileSync(
    analyzeRow.lastFile,
    '```json\n{"action":"reject","reason":"isolated HTTP completion"}\n```\n',
    'utf8'
  )
  fs.writeFileSync(
    path.join(temporaryHub.root, 'skill-review', `session-${analyzeRow.id}.exit`),
    '0\n',
    'utf8'
  )

  const completedState = await getJson(runtime.base, '/api/state')
  const completedItem = completedState.items.find((item) => item.id === fixture.inboxId)
  assert.equal(completedItem.status, 'proposed')
  assert.equal(completedItem.suggestion.action, 'reject')
  const completionAudit = JSON.parse(fs.readFileSync(auditLog, 'utf8')).events
  assert.ok(completionAudit.some((event) => (
    event.type === 'inbox.transitioned'
      && event.commandKind === 'reapSessions'
      && event.details?.source === 'analyze-completion'
  )), 'analyze completion must transition through Core/Application')
  const completionLedger = JSON.parse(fs.readFileSync(requestLedger, 'utf8')).entries
  assert.ok(completionLedger.some((entry) => entry.commandKind === 'reapSessions' && entry.status === 'completed'))

  const decision = await postJson(runtime.base, '/api/decide', {
    id: fixture.inboxId,
    action: 'reject',
    requestId: 'http-runtime-reject'
  }, { Cookie: runtime.capabilityCookie })
  assert.equal(decision.ok, true)
  assert.equal(decision.action, 'reject')
  assert.equal(decision.item.status, 'rejected')
  assert.equal(fs.existsSync(fixture.inbox), false, 'reject only removes the isolated inbox fixture')

  const typedChat = await postJson(runtime.base, '/api/command', {
    kind: 'chat',
    intent: 'isolated no-start HTTP command',
    runner: { start: false },
    requestId: 'http-runtime-command-chat'
  }, { Cookie: runtime.capabilityCookie })
  assert.equal(typedChat.ok, true)
  assert.equal(typedChat.commandKind, 'chat')
  assert.equal(typedChat.data.session.kind, 'chat')
  assert.equal(typedChat.data.session.status, 'queued')

  assert.equal(fs.existsSync(runtime.marker), false, `server attempted a CLI intermediary\n${runtime.output()}`)
  const reviewEntries = fs.readdirSync(path.join(temporaryHub.root, 'skill-review'))
  assert.equal(reviewEntries.some((name) => /^run-codex-.*\.cmd$/i.test(name)), false, 'HUB_SPAWN_CODEX=0 must suppress the real runner')
})

function walkWebText(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === 'out') continue
    const full = path.join(dir, name)
    const st = fs.statSync(full)
    if (st.isDirectory()) walkWebText(full, acc)
    else if (/\.(html|js|css|mjs|txt)$/.test(name)) acc.push(fs.readFileSync(full, 'utf8'))
  }
  return acc
}

test('management page is static and does not import core or embed attach policy', () => {
  const page = [
    ...walkWebText(path.join(hubRoot, 'web')),
    ...walkWebText(path.join(hubRoot, 'panel', 'src')),
    ...walkWebText(path.join(hubRoot, 'panel', 'lib'))
  ].join('\n')
  assert.match(page, /\/api\/command/)
  assert.match(page, /EventSource/)
  assert.match(page, /\/api\/codex\/session\/stream/)
  assert.doesNotMatch(page, /src\/core/)
  assert.doesNotMatch(page, /preferLibrary/)
  assert.doesNotMatch(page, /inode/)
  assert.doesNotMatch(page, /认仓/)
  assert.doesNotMatch(page, /createHub/)
})

test('GET / serves the management page and Application worktree JSON matches the CLI transport', { timeout: 180000 }, async (t) => {
  const { server, base } = await listenQueryServer()
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const res = await fetch(`${base}/`)
  const html = await res.text()
  assert.equal(res.ok, true, html)
  assert.match(res.headers.get('content-type') || '', /text\/html/)
  assert.match(html, /总览/)
  assert.match(html, /Skill Hub|技能库|工作区/)
  const worktrees = await getJson(base, '/api/worktrees')
  const cli = spawnHub(['list-worktrees'])
  assert.equal(cli.status, 0, cli.stderr)
  const fromCli = commandData(JSON.parse(cli.stdout))
  const paths = (rows) => [...new Set(rows.map((item) => item.path))].sort((a, b) => a.localeCompare(b))
  assert.deepEqual(paths(worktrees.worktrees), paths(fromCli.worktrees))
})

test('Next catch-all assets with [[...slug]] are served', { timeout: 180000 }, async (t) => {
  const chunkDir = path.join(hubRoot, 'web', '_next', 'static', 'chunks', 'app', '[[...slug]]')
  assert.equal(fs.existsSync(chunkDir), true, 'exported [[...slug]] chunk dir')
  const pageJs = fs.readdirSync(chunkDir).find((name) => name.startsWith('page-') && name.endsWith('.js'))
  assert.ok(pageJs, 'page chunk')
  const { server, base } = await listenQueryServer()
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const route = `/_next/static/chunks/app/${encodeURIComponent('[[...slug]]')}/${pageJs}`
  const res = await fetch(`${base}${route}`)
  const body = await res.text()
  assert.equal(res.ok, true, `${route} ${res.status} ${body.slice(0, 120)}`)
  assert.match(res.headers.get('content-type') || '', /javascript/)
  assert.ok(body.length > 20, 'js chunk empty')
})

test('static hub routes are served for sidebar paths', { timeout: 180000 }, async (t) => {
  const { server, base } = await listenQueryServer()
  t.after(() => new Promise((resolve) => server.close(resolve)))
  for (const route of ['/', '/skills', '/updates', '/workspaces', '/store', '/codex', '/settings', '/updates/demo-id']) {
    const res = await fetch(`${base}${route}`)
    const html = await res.text()
    assert.equal(res.ok, true, `${route} ${res.status} ${html.slice(0, 200)}`)
    assert.match(res.headers.get('content-type') || '', /text\/html/)
    assert.match(html, /总览/)
  }
})

test('hooks reach the Application only through the shipped CLI transport', () => {
  const post = fs.readFileSync(path.join(hubRoot, 'overlay', 'hooks', 'post-checkout'), 'utf8')
  const ingest = fs.readFileSync(path.join(hubRoot, 'overlay', 'hooks', 'reference-transaction'), 'utf8')
  assert.match(post, /dist\/control\/cli\.js/)
  assert.match(post, /repair-links/)
  assert.match(post, / attach /)
  assert.doesNotMatch(post, /attach-library\.ps1/)
  assert.doesNotMatch(post, /start-codex-session\.ps1/)
  assert.match(ingest, /dist\/control\/cli\.js/)
  assert.match(ingest, / ingest /)
  assert.doesNotMatch(ingest, /analyze-remote-skill-update\.ps1/)
})

test('GET /api/state matches hub status resident and counts.queued', { timeout: 180000 }, async (t) => {
  const { server, base } = await listenQueryServer()
  t.after(() => new Promise((resolve) => server.close(resolve)))

  const healthResponse = await fetch(`${base}/api/health`)
  const health = await healthResponse.json()
  assert.deepEqual(health, { ok: true })
  assert.equal(
    samePath(decodeURIComponent(healthResponse.headers.get('x-skill-graft-package-root') || ''), hubRoot),
    true
  )
  assert.equal(
    samePath(decodeURIComponent(healthResponse.headers.get('x-skill-graft-data-root') || ''), process.env.HUB_ROOT),
    true
  )

  const cli = spawnHub(['status'])
  assert.equal(cli.status, 0, cli.stderr)
  const status = commandData(JSON.parse(cli.stdout))
  const state = await getJson(base, '/api/state')
  assert.ok(state.resident, 'state.resident missing')
  assert.ok(state.counts, 'state.counts missing')
  assert.deepEqual(state.resident, status.resident)
  assert.equal(state.counts.queued, status.counts.queued)
})

test('GET /api/worktrees matches hub list-worktrees scanRoots and worktree paths', { timeout: 180000 }, async (t) => {
  const { server, base } = await listenQueryServer()
  t.after(() => new Promise((resolve) => server.close(resolve)))

  const cli = spawnHub(['list-worktrees'])
  assert.equal(cli.status, 0, cli.stderr)
  const fromCli = commandData(JSON.parse(cli.stdout))
  const payload = await getJson(base, '/api/worktrees')
  assert.ok(Array.isArray(payload.scanRoots), 'scanRoots')
  assert.ok(Array.isArray(payload.worktrees), 'worktrees')
  assert.deepEqual(payload.scanRoots, fromCli.scanRoots)
  const paths = (rows) => [...new Set(rows.map((item) => item.path))].sort((a, b) => a.localeCompare(b))
  assert.deepEqual(paths(payload.worktrees), paths(fromCli.worktrees))
  const mainFix = (payload.worktrees || []).find((item) => samePath(item.path, 'E:\\ozdqp-main-fix'))
  if (mainFix) {
    assert.equal(mainFix.attached, true)
    assert.equal(mainFix.overrideLinked, true)
    assert.equal(mainFix.officialPresent, false)
  }
})
