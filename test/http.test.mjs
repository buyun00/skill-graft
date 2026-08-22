import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { onRequest } from '../server/index.mjs'
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
  const server = http.createServer(onRequest)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return { server, base: `http://127.0.0.1:${address.port}` }
}

async function getJson(base, route) {
  const res = await fetch(`${base}${route}`)
  const text = await res.text()
  assert.equal(res.ok, true, `${route} ${res.status} ${text}`)
  assert.ok(text.length > 0, `${route} empty body`)
  return JSON.parse(text)
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

  return {
    base,
    child,
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
  assert.match(source, /createLocalHost/)
  assert.match(source, /host\.application\.execute\(command\)/)
  assert.match(source, /localSessions\?\.needsReap/)
  assert.match(source, /const result = await executeTyped\(typedCommand/)
  assert.doesNotMatch(source, /\bcreateHub\b/)
  assert.doesNotMatch(source, /\bgetStatus\b/)
  assert.doesNotMatch(source, /from ['"][^'"]*(?:src|dist)[\\/]core[\\/]/)
  assert.doesNotMatch(source, /promote-inbox\.ps1/)
  assert.doesNotMatch(source, /attach-library\.ps1/)
  assert.doesNotMatch(source, /analyze-remote-skill-update\.ps1/)

  const start = source.indexOf('export async function handleApi')
  const end = source.indexOf('\nfunction send(', start)
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
    signal: AbortSignal.timeout(3000)
  })
  const missingEvents = await missingSse.text()
  assert.equal(missingSse.ok, true, missingEvents)
  assert.match(missingEvents, /event: status/)
  assert.match(missingEvents, /"status":"missing"/)
  const legacySse = await fetch(`${runtime.base}/api/codex/session/stream?id=${encodeURIComponent(fixture.sessionId)}`, {
    signal: AbortSignal.timeout(3000)
  })
  const legacyEvents = await legacySse.text()
  assert.match(legacyEvents, /"continuationToken":"11111111-2222-3333-4444-555555555555"/)
  assert.match(legacyEvents, /"codexSessionId":"11111111-2222-3333-4444-555555555555"/)
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
  })
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
  })
  assert.equal(decision.ok, true)
  assert.equal(decision.action, 'reject')
  assert.equal(decision.item.status, 'rejected')
  assert.equal(fs.existsSync(fixture.inbox), false, 'reject only removes the isolated inbox fixture')

  const typedChat = await postJson(runtime.base, '/api/command', {
    kind: 'chat',
    intent: 'isolated no-start HTTP command',
    runner: { start: false },
    requestId: 'http-runtime-command-chat'
  })
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
  assert.match(page, /\/api\/state/)
  assert.match(page, /\/api\/worktrees/)
  assert.match(page, /\/api\/decide/)
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
  const fromCli = JSON.parse(cli.stdout)
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
  const status = JSON.parse(cli.stdout)
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
  const fromCli = JSON.parse(cli.stdout)
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
