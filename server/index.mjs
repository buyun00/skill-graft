import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLocalHost } from '../dist/local/create-local-host.js'
import { projectLegacyResult } from '../dist/local/compat/legacy-projector.js'
import { daemonStatus } from '../dist/control/install.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const hubRoot = path.resolve(__dirname, '..')
const port = Number(process.env.HUB_API_PORT || 18765)

function hubDataRoot() {
  return path.resolve(process.env.HUB_ROOT || hubRoot)
}

let localHostCache = { root: '', host: null }

function localHost() {
  const root = hubDataRoot()
  if (!localHostCache.host || localHostCache.root !== root) {
    localHostCache = {
      root,
      host: createLocalHost({ packageRoot: hubRoot, dataRoot: root, hostId: 'local-http' })
    }
  }
  return localHostCache.host
}

function requestId(req, body, suffix = '') {
  const header = String(req.headers?.['x-skill-graft-request-id'] || '').trim()
  const supplied = String(body?.requestId || body?.meta?.requestId || header).trim()
  if (supplied) return suffix ? `${supplied}:${suffix}` : supplied
  return localHost().commandMeta('http').requestId
}

function typedCommand(req, body, kind, input = {}, suffix = '') {
  const host = localHost()
  return {
    kind,
    ...input,
    meta: host.commandMeta('http', requestId(req, body, suffix))
  }
}

async function executeTyped(command) {
  const host = localHost()
  if (command.kind === 'status' || command.kind === 'listSessions' || command.kind === 'getSession') {
    const sessionIds = command.kind === 'getSession' && command.sessionId ? [command.sessionId] : undefined
    if (host.localSessions?.needsReap(sessionIds)) {
      const reaped = await host.application.execute({
        kind: 'reapSessions',
        meta: host.commandMeta('http-session-reap'),
        sessionIds
      })
      if (!reaped.ok) return reaped
    }
  }
  return host.application.execute(command)
}

async function executeLegacy(req, body, kind, input = {}, suffix = '') {
  const result = await executeTyped(typedCommand(req, body, kind, input, suffix))
  return projectLegacyResult(result, localHost())
}

function sessionInput(kind, body) {
  const runner = {
    ...(body.model ? { profile: body.model } : {}),
    ...(body.effort ? { quality: body.effort } : {}),
    ...(typeof body.start === 'boolean' ? { start: body.start } : {}),
    ...(typeof body.wait === 'boolean' ? { wait: body.wait } : {})
  }
  if (kind === 'edit') return { path: body.path || '', intent: body.intent, runner }
  if (kind === 'attach' || kind === 'detach') {
    return { worktree: body.worktree || body.path || '', intent: body.intent, runner }
  }
  if (kind === 'analyze') return { inboxId: body.id || body.inboxId, intent: body.intent, runner }
  return { intent: body.intent, worktree: body.worktree, runner }
}

export async function handleApi(req, url, body) {
  if (url.pathname === '/api/command') {
    const input = body && typeof body === 'object' ? body : {}
    const kind = String(input.kind || '')
    const { meta: suppliedMeta, requestId: _requestId, ...payload } = input
    const host = localHost()
    const command = {
      ...payload,
      kind,
      meta: {
        ...host.commandMeta('http', String(suppliedMeta?.requestId || requestId(req, body))),
        ...(suppliedMeta && typeof suppliedMeta === 'object' ? suppliedMeta : {}),
        hostId: host.hostId,
        transport: 'http'
      }
    }
    return executeTyped(command)
  }

  if (url.pathname === '/api/state') {
    return executeLegacy(req, body, 'status')
  }

  if (url.pathname === '/api/daemon') {
    return daemonStatus(hubRoot, undefined, hubDataRoot())
  }

  if (url.pathname === '/api/skill') {
    const rel = url.searchParams.get('path') || ''
    return executeLegacy(req, body, 'readSkill', { path: rel })
  }

  if (url.pathname === '/api/history') {
    return executeLegacy(req, body, 'listHistory', { limit: 50 })
  }

  if (url.pathname === '/api/codex/sessions') {
    const data = await executeLegacy(req, body, 'listSessions')
    const sessions = (data.sessions || []).map((session) => ({
      ...session,
      logTail: localHost().localSessions?.readLog(session.id).slice(-8000) || ''
    }))
    return { sessions }
  }

  if (url.pathname === '/api/codex/session') {
    const id = url.searchParams.get('id')
    const result = await executeTyped(typedCommand(req, body, 'getSession', { sessionId: id || '' }))
    if (!result.ok && result.error.code === 'NOT_FOUND') {
      const err = new Error('session not found')
      err.status = 404
      throw err
    }
    const projected = projectLegacyResult(result, localHost())
    const session = projected.session
    const log = localHost().localSessions?.readLog(id || '') || ''
    return { session, log }
  }

  if (url.pathname === '/api/worktrees') {
    return executeLegacy(req, body, 'listWorktrees')
  }

  if (req.method !== 'POST') {
    const err = new Error('not found')
    err.status = 404
    throw err
  }

  if (url.pathname === '/api/decide') {
    return executeLegacy(req, body, 'decide', {
      id: body.id,
      action: body.action,
      note: body.note,
      mergeTarget: body.mergeTarget
    })
  }

  if (url.pathname === '/api/analyze') {
    return executeLegacy(req, body, 'analyze', sessionInput('analyze', {
      ...body,
      intent: body.intent || 'Analyze queued inbox skill updates',
      start: typeof body.start === 'boolean' ? body.start : true
    }))
  }

  if (url.pathname === '/api/codex/start') {
    const kind = body.kind === 'analyze-note' ? 'chat' : (body.kind || 'chat')
    return executeLegacy(req, body, kind, sessionInput(kind, body))
  }

  if (url.pathname === '/api/codex/resume') {
    return executeLegacy(req, body, 'resumeSession', {
      sessionId: body.id,
      message: body.message,
      runner: sessionInput('chat', body).runner
    })
  }

  if (url.pathname === '/api/worktree/attach') {
    return executeLegacy(req, body, 'attach', sessionInput('attach', { ...body, worktree: body.path }))
  }

  if (url.pathname === '/api/worktree/detach') {
    return executeLegacy(req, body, 'detach', sessionInput('detach', { ...body, worktree: body.path }))
  }

  const err = new Error('not found')
  err.status = 404
  throw err
}

function send(res, status, payload, contentType = 'application/json; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'Content-Type': contentType, ...headers })
  res.end(payload)
}

function compatibilityHeaders(pathname) {
  if (!pathname.startsWith('/api/') || pathname === '/api/health' || pathname === '/api/command') return {}
  return {
    Deprecation: 'true',
    Link: '</api/command>; rel="successor-version"'
  }
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

async function findSession(id) {
  const host = localHost()
  const command = {
    kind: 'getSession',
    sessionId: id,
    meta: host.commandMeta('http-sse')
  }
  const result = await host.application.execute(command)
  if (!result.ok) return null
  return result.data.session
}

function streamSession(id, req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    Deprecation: 'true',
    Link: '</api/command>; rel="successor-version"'
  })
  let lastSize = -1
  let lastStatus = ''
  const writeEvent = (event, payload) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
  }
  const tick = async () => {
    const session = await findSession(id)
    if (!session) {
      writeEvent('status', { status: 'missing' })
      clearInterval(timer)
      res.end()
      return
    }
    const log = localHost().localSessions?.readLog(id) || ''
    if (log.length !== lastSize) {
      lastSize = log.length
      writeEvent('log', { text: log })
    }
    if (session.status !== lastStatus) {
      lastStatus = session.status
      writeEvent('status', {
        status: session.status,
        lastMessage: session.lastMessage || '',
        error: session.error || '',
        exitCode: session.exitCode,
        continuationToken: session.continuationToken || '',
        codexSessionId: session.continuationToken || ''
      })
    }
    if (session.status && session.status !== 'running') {
      clearInterval(timer)
      res.end()
    }
  }
  const timer = setInterval(() => void tick(), 250)
  void tick()
  req.on('close', () => {
    clearInterval(timer)
  })
}

export const onRequest = async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${port}`)
  try {
    if (url.pathname === '/api/health') {
      send(res, 200, JSON.stringify({ ok: true }), 'application/json; charset=utf-8', {
        'X-Skill-Graft-Package-Root': encodeURIComponent(path.resolve(hubRoot)),
        'X-Skill-Graft-Data-Root': encodeURIComponent(hubDataRoot())
      })
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
      send(res, 200, JSON.stringify(data), 'application/json; charset=utf-8', compatibilityHeaders(url.pathname))
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
