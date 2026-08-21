import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const hubRoot = path.resolve(__dirname, '..')
const cliPath = path.join(hubRoot, 'dist', 'control', 'cli.js')
const port = Number(process.env.HUB_API_PORT || 18765)

function hubDataRoot() {
  return path.resolve(process.env.HUB_ROOT || hubRoot)
}

function runHub(args, options = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: hubRoot,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, HUB_ROOT: hubDataRoot() },
    input: options.input
  })
  if (result.status !== 0) {
    const err = new Error((result.stderr || result.stdout || 'hub command failed').trim())
    err.status = 500
    throw err
  }
  const text = result.stdout || ''
  if (!text.trim()) throw new Error(`hub ${args[0]} produced empty stdout`)
  return JSON.parse(text)
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
}

function sessionsPath() {
  return path.join(hubDataRoot(), 'skill-review', 'sessions.json')
}

function loadSessions() {
  return readJson(sessionsPath(), { sessions: [] })
}

function saveSessions(data) {
  writeJson(sessionsPath(), data)
}

function extractCodexSessionId(text) {
  const match = String(text || '').match(/session id:\s*([0-9a-fA-F-]{16,})/i)
  return match ? match[1] : ''
}

function hydrateSession(session) {
  if (!session) return session
  if (!session.codexSessionId && session.logFile && fs.existsSync(session.logFile)) {
    session.codexSessionId = extractCodexSessionId(fs.readFileSync(session.logFile, 'utf8'))
  }
  if (!session.lastMessage && session.lastFile && fs.existsSync(session.lastFile)) {
    session.lastMessage = fs.readFileSync(session.lastFile, 'utf8')
  }
  if (session.status === 'completed' && session.exitCode === 0 && session.codexSessionId) {
    session.status = 'waiting'
  }
  session.canResume = Boolean(session.codexSessionId) && session.status !== 'running'
  return session
}

function loadAndHydrateSessions() {
  const data = loadSessions()
  let dirty = false
  for (const session of data.sessions || []) {
    const before = `${session.codexSessionId || ''}|${session.status}|${session.lastMessage || ''}`
    hydrateSession(session)
    const after = `${session.codexSessionId || ''}|${session.status}|${session.lastMessage || ''}`
    if (before !== after) dirty = true
  }
  if (dirty) saveSessions(data)
  return data
}

let worktreeCache = { at: 0, root: '', data: null }

function collectWorktreesCached() {
  const now = Date.now()
  const root = hubDataRoot()
  if (worktreeCache.data && worktreeCache.root === root && now - worktreeCache.at < 30000) return worktreeCache.data
  const data = runHub(['list-worktrees'])
  worktreeCache = { at: now, root, data }
  return data
}

function sessionFromHub(kind, body) {
  const args = [kind]
  if (body.path) args.push('--path', body.path)
  if (body.intent) args.push('--intent', body.intent)
  if (body.worktree) args.push('--worktree', body.worktree)
  return runHub(args)
}

export async function handleApi(req, url, body) {
  if (url.pathname === '/api/state') {
    return runHub(['status'])
  }

  if (url.pathname === '/api/daemon') {
    return runHub(['daemon', 'status'])
  }

  if (url.pathname === '/api/skill') {
    const rel = url.searchParams.get('path') || ''
    const dataRoot = hubDataRoot()
    const abs = path.resolve(dataRoot, rel)
    if (abs !== dataRoot && !abs.startsWith(dataRoot + path.sep)) throw new Error('path escaped hub')
    if (!fs.existsSync(abs)) throw new Error('missing ' + rel)
    const target = fs.statSync(abs).isDirectory()
      ? (fs.existsSync(path.join(abs, 'SKILL.md')) ? path.join(abs, 'SKILL.md') : abs)
      : abs
    if (fs.statSync(target).isDirectory()) throw new Error('no SKILL.md')
    return { path: rel, content: fs.readFileSync(target, 'utf8') }
  }

  if (url.pathname === '/api/history') {
    const dir = path.join(hubDataRoot(), 'skill-review', 'history')
    if (!fs.existsSync(dir)) return { records: [] }
    const files = fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort().reverse().slice(0, 50)
    return { records: files.map((name) => readJson(path.join(dir, name), {})) }
  }

  if (url.pathname === '/api/codex/sessions') {
    const data = loadAndHydrateSessions()
    const sessions = (data.sessions || []).map((session) => {
      let logTail = ''
      if (session.logFile && fs.existsSync(session.logFile)) {
        const text = fs.readFileSync(session.logFile, 'utf8')
        logTail = text.slice(-8000)
      }
      return { ...hydrateSession(session), logTail }
    })
    return { sessions }
  }

  if (url.pathname === '/api/codex/session') {
    const id = url.searchParams.get('id')
    const session = hydrateSession((loadAndHydrateSessions().sessions || []).find((item) => item.id === id))
    if (!session) {
      const err = new Error('session not found')
      err.status = 404
      throw err
    }
    let log = ''
    if (session.logFile && fs.existsSync(session.logFile)) log = fs.readFileSync(session.logFile, 'utf8')
    return { session, log }
  }

  if (url.pathname === '/api/worktrees') {
    return collectWorktreesCached()
  }

  if (req.method !== 'POST') {
    const err = new Error('not found')
    err.status = 404
    throw err
  }

  if (url.pathname === '/api/decide') {
    const args = ['decide', '--id', body.id, '--action', body.action]
    if (body.note) args.push('--note', body.note)
    if (body.mergeTarget) args.push('--merge-target', body.mergeTarget)
    return runHub(args)
  }

  if (url.pathname === '/api/analyze') {
    return runHub(['chat', '--intent', 'Analyze queued inbox skill updates'])
  }

  if (url.pathname === '/api/codex/start') {
    const kind = body.kind === 'analyze-note' ? 'chat' : (body.kind || 'chat')
    return sessionFromHub(kind, body)
  }

  if (url.pathname === '/api/codex/resume') {
    return runHub(['resume', '--id', body.id, '--message', body.message])
  }

  if (url.pathname === '/api/worktree/attach') {
    return sessionFromHub('attach', { worktree: body.path, intent: body.intent })
  }

  if (url.pathname === '/api/worktree/detach') {
    return sessionFromHub('detach', { worktree: body.path, intent: body.intent })
  }

  const err = new Error('not found')
  err.status = 404
  throw err
}

function send(res, status, payload, contentType = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': contentType })
  res.end(payload)
}

const webRoot = path.join(hubRoot, 'web')
const WEB_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
  '.xml': 'application/xml'
}

function isInsideWebRoot(file) {
  const root = path.resolve(webRoot).toLowerCase()
  const resolved = path.resolve(file).toLowerCase()
  return resolved === root || resolved.startsWith(root + path.sep)
}

function sendWebFile(res, file) {
  const ext = path.extname(file).toLowerCase()
  send(res, 200, fs.readFileSync(file), WEB_TYPES[ext] || 'application/octet-stream')
}

function decodePathname(pathname) {
  try {
    return decodeURIComponent(pathname)
  } catch {
    return pathname
  }
}

function serveWeb(url, res) {
  const pathname = decodePathname(url.pathname || '/')
  let rel = pathname === '/' ? '/index.html' : pathname
  if (!rel.startsWith('/')) return false
  if (rel.split(/[/\\]/).some((part) => part === '..')) return false
  const candidates = [rel]
  if (!path.extname(rel)) {
    const trimmed = rel.replace(/\/$/, '') || '/index'
    candidates.push(`${trimmed}.html`)
    candidates.push(`${trimmed}/index.html`)
    const parts = trimmed.split('/').filter(Boolean)
    if (parts.length >= 2) {
      candidates.push(`/${parts[0]}.html`)
      candidates.push(`/${parts[0]}/index.html`)
    }
  }
  for (const candidate of candidates) {
    const file = path.join(webRoot, candidate.replace(/^\/+/, ''))
    if (!isInsideWebRoot(file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) continue
    sendWebFile(res, file)
    return true
  }
  return false
}

function findSession(id) {
  const session = (loadAndHydrateSessions().sessions || []).find((item) => item.id === id) || null
  return session ? hydrateSession(session) : null
}

function streamSession(id, req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  })
  let lastSize = -1
  let lastStatus = ''
  const writeEvent = (event, payload) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
  }
  const tick = () => {
    const session = findSession(id)
    if (!session) {
      writeEvent('status', { status: 'missing' })
      return
    }
    let log = ''
    if (session.logFile && fs.existsSync(session.logFile)) {
      const size = fs.statSync(session.logFile).size
      if (size !== lastSize) {
        lastSize = size
        log = fs.readFileSync(session.logFile, 'utf8')
        writeEvent('log', { text: log })
      }
    }
    if (session.status !== lastStatus) {
      lastStatus = session.status
      writeEvent('status', {
        status: session.status,
        lastMessage: session.lastMessage || '',
        error: session.error || '',
        exitCode: session.exitCode,
        codexSessionId: session.codexSessionId || ''
      })
    }
    if (session.status && session.status !== 'running') {
      clearInterval(timer)
      res.end()
    }
  }
  const timer = setInterval(tick, 250)
  tick()
  req.on('close', () => {
    clearInterval(timer)
  })
}

export const onRequest = async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${port}`)
  try {
    if (url.pathname === '/api/health') {
      send(res, 200, JSON.stringify({ ok: true }))
      return
    }
    if (url.pathname === '/api/codex/session/stream') {
      const id = url.searchParams.get('id')
      if (!id) {
        send(res, 400, JSON.stringify({ error: 'missing id' }))
        return
      }
      streamSession(id, req, res)
      return
    }
    if (!url.pathname.startsWith('/api/') && serveWeb(url, res)) {
      return
    }
    if (url.pathname.startsWith('/api/')) {
      let body = {}
      if (req.method === 'POST') {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const raw = Buffer.concat(chunks).toString('utf8')
        body = raw ? JSON.parse(raw) : {}
      }
      const data = await handleApi(req, url, body)
      send(res, 200, JSON.stringify(data))
      return
    }
    send(res, 404, JSON.stringify({ error: 'not found' }))
  } catch (error) {
    send(res, error.status || 500, JSON.stringify({ error: error.message || String(error) }))
  }
}

function isMainModule() {
  const entry = process.argv[1]
  if (!entry) return false
  return path.resolve(fileURLToPath(import.meta.url)).toLowerCase() === path.resolve(entry).toLowerCase()
}

function startApiListeners() {
  for (const bindHost of ['127.0.0.1', '::1']) {
    const server = http.createServer(onRequest)
    server.listen(port, bindHost, () => {
      const label = bindHost === '::1' ? 'localhost' : bindHost
      console.log(`skill-graft api http://${label}:${port}/`)
    })
    server.on('error', (error) => {
      if (bindHost === '::1' && error && error.code === 'EADDRINUSE') return
      console.error(`listen ${bindHost}:${port} failed`, error)
      if (bindHost === '127.0.0.1') process.exit(1)
    })
  }
}

if (isMainModule()) startApiListeners()
