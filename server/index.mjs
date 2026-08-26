import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { openLocalHost } from '../dist/local/create-local-host.js'
import { projectLegacyResult } from '../dist/local/compat/legacy-projector.js'
import { daemonStatus, doctorHub, resolveDataRoot as resolveInstallDataRoot } from '../dist/control/install.js'
import { createProductService } from './product-service.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const hubRoot = path.resolve(__dirname, '..')
const defaultPort = Number(process.env.HUB_API_PORT || 18765)
const TRANSPORT_VERSION = 1
const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024
const CAPABILITY_COOKIE = 'skill_graft_capability'
const CAPABILITY_SECRETS = new WeakMap()
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const QUERY_COMMAND_KINDS = new Set([
  'status',
  'listSkills',
  'listWorktrees',
  'readSkill',
  'listHistory',
  'listSessions',
  'getSession',
  'inspectSchema',
  'listSnapshots',
  'getSnapshot',
  'getPin',
  'planSync'
])
// `waiting` remains readable only for pre-P5 durable rows. New runner writes
// use `awaiting`, and both settle the transport stream without creating two
// independent state machines.
const TERMINAL_SESSION_STATUSES = new Set(['awaiting', 'waiting', 'completed', 'failed', 'cancelled'])

function isStructuredSessionView(session) {
  return Number.isSafeInteger(session?.revision)
    && typeof session?.attemptId === 'string'
    && Array.isArray(session?.events)
}

const DEPRECATED_WRITE_ROUTES = new Set([
  '/api/decide',
  '/api/analyze',
  '/api/codex/start',
  '/api/codex/resume',
  '/api/worktree/attach',
  '/api/worktree/detach'
])
const API_METHODS = new Map([
  ['/api/health', ['GET']],
  ['/api/host/diagnostics', ['GET']],
  ['/api/command', ['POST']],
  ['/api/state', ['GET']],
  ['/api/daemon', ['GET']],
  ['/api/skill', ['GET']],
  ['/api/history', ['GET']],
  ['/api/codex/sessions', ['GET']],
  ['/api/codex/session', ['GET']],
  ['/api/codex/session/stream', ['GET']],
  ['/api/worktrees', ['GET']],
  ['/api/decide', ['POST']],
  ['/api/analyze', ['POST']],
  ['/api/codex/start', ['POST']],
  ['/api/codex/resume', ['POST']],
  ['/api/worktree/attach', ['POST']],
  ['/api/worktree/detach', ['POST']]
])
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

export function createHttpCapability() {
  const handle = Object.freeze({})
  CAPABILITY_SECRETS.set(handle, randomBytes(32).toString('base64url'))
  return handle
}

class HttpTransportError extends Error {
  constructor(status, code, message, options = {}) {
    super(message)
    this.name = 'HttpTransportError'
    this.status = status
    this.code = code
    this.headers = options.headers || {}
    this.details = options.details
  }
}

function normalizeHostname(hostname) {
  return String(hostname || '').trim().toLowerCase().replace(/^\[(.*)\]$/, '$1')
}

function parseAuthority(value) {
  if (typeof value !== 'string' || !value || /[\s/@\\]/.test(value)) return null
  try {
    const parsed = new URL(`http://${value}`)
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return null
    const hostname = normalizeHostname(parsed.hostname)
    return {
      hostname,
      port: parsed.port ? Number(parsed.port) : 80
    }
  } catch {
    return null
  }
}

function requestPort(req, configuredPort) {
  const localPort = Number(req.socket?.localPort)
  return Number.isInteger(localPort) && localPort > 0 ? localPort : configuredPort
}

function validateLoopbackRequest(req, configuredPort) {
  const expectedPort = requestPort(req, configuredPort)
  const authority = parseAuthority(req.headers?.host)
  if (!authority || !LOOPBACK_HOSTS.has(authority.hostname) || authority.port !== expectedPort) {
    throw new HttpTransportError(403, 'HTTP_FORBIDDEN_HOST', 'request Host must identify this loopback listener')
  }

  const originValue = req.headers?.origin
  if (originValue == null || originValue === '') return
  if (Array.isArray(originValue)) {
    throw new HttpTransportError(403, 'HTTP_FORBIDDEN_ORIGIN', 'request Origin must identify this loopback listener')
  }
  try {
    const origin = new URL(originValue)
    const hostname = normalizeHostname(origin.hostname)
    const originPort = origin.port ? Number(origin.port) : (origin.protocol === 'http:' ? 80 : 443)
    if (
      origin.protocol !== 'http:'
      || !LOOPBACK_HOSTS.has(hostname)
      || originPort !== expectedPort
      || origin.username
      || origin.password
      || origin.pathname !== '/'
      || origin.search
      || origin.hash
    ) {
      throw new Error('foreign origin')
    }
  } catch {
    throw new HttpTransportError(403, 'HTTP_FORBIDDEN_ORIGIN', 'request Origin must identify this loopback listener')
  }
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8')
  const b = Buffer.from(String(right || ''), 'utf8')
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b)
}

function cookieValue(req, name) {
  const raw = req.headers?.cookie
  if (typeof raw !== 'string') return ''
  for (const pair of raw.split(';')) {
    const separator = pair.indexOf('=')
    if (separator < 0) continue
    if (pair.slice(0, separator).trim() === name) return pair.slice(separator + 1).trim()
  }
  return ''
}

function hasCapability(req, capability) {
  const trustedHeader = req.headers?.['x-skill-graft-capability']
  const headerValue = Array.isArray(trustedHeader) ? '' : trustedHeader
  return safeEqual(headerValue, capability) || safeEqual(cookieValue(req, CAPABILITY_COOKIE), capability)
}

function capabilityCookie(capability) {
  return `${CAPABILITY_COOKIE}=${capability}; Path=/; HttpOnly; SameSite=Strict`
}

function requestIdHeader(req) {
  const value = req.headers?.['x-skill-graft-request-id']
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function problemPayload(error, req) {
  const payload = {
    transportVersion: TRANSPORT_VERSION,
    ok: false,
    error: {
      code: error.code || 'HTTP_INTERNAL',
      message: error.message || 'internal transport error'
    }
  }
  const requestId = requestIdHeader(req)
  if (requestId) payload.requestId = requestId
  if (error.details !== undefined) payload.error.details = error.details
  return payload
}

function send(res, status, payload, contentType = 'application/json; charset=utf-8', headers = {}) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
    ...headers
  })
  res.end(payload)
}

function sendJson(res, status, payload, headers = {}) {
  send(res, status, JSON.stringify(payload), 'application/json; charset=utf-8', {
    'Cache-Control': 'no-store',
    ...headers
  })
}

function sendProblem(req, res, error) {
  const status = Number(error?.status) || 500
  const normalized = error instanceof HttpTransportError
    ? error
    : new HttpTransportError(status, status === 404 ? 'HTTP_NOT_FOUND' : 'HTTP_INTERNAL', error?.message || String(error))
  sendJson(res, normalized.status, problemPayload(normalized, req), normalized.headers)
}

function compatibilityHeaders(pathname) {
  if (!pathname.startsWith('/api/') || pathname === '/api/health' || pathname === '/api/command') return {}
  return {
    Deprecation: 'true',
    Link: '</api/command>; rel="successor-version"'
  }
}

function isJsonContentType(value) {
  if (typeof value !== 'string') return false
  const mediaType = value.split(';', 1)[0].trim().toLowerCase()
  return mediaType === 'application/json' || /^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(mediaType)
}

function readJsonBody(req, limitBytes) {
  const declared = Number(req.headers?.['content-length'])
  if (Number.isFinite(declared) && declared > limitBytes) {
    req.resume()
    return Promise.reject(new HttpTransportError(
      413,
      'HTTP_PAYLOAD_TOO_LARGE',
      `JSON request body exceeds ${limitBytes} bytes`
    ))
  }

  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false

    const cleanup = () => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      req.off('aborted', onAborted)
    }
    const fail = (error, drain = false) => {
      if (settled) return
      settled = true
      cleanup()
      if (drain) req.resume()
      reject(error)
    }
    const onData = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > limitBytes) {
        fail(new HttpTransportError(
          413,
          'HTTP_PAYLOAD_TOO_LARGE',
          `JSON request body exceeds ${limitBytes} bytes`
        ), true)
        return
      }
      chunks.push(buffer)
    }
    const onEnd = () => {
      if (settled) return
      settled = true
      cleanup()
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw.trim()) {
        resolve({})
        return
      }
      let value
      try {
        value = JSON.parse(raw)
      } catch {
        reject(new HttpTransportError(400, 'HTTP_INVALID_JSON', 'request body is not valid JSON'))
        return
      }
      if (value == null || typeof value !== 'object' || Array.isArray(value)) {
        reject(new HttpTransportError(400, 'HTTP_INVALID_JSON', 'request body must be a JSON object'))
        return
      }
      resolve(value)
    }
    const onError = (error) => fail(new HttpTransportError(400, 'HTTP_BODY_READ_FAILED', error.message || 'request body failed'))
    const onAborted = () => fail(new HttpTransportError(400, 'HTTP_REQUEST_ABORTED', 'request body was aborted'))

    req.on('data', onData)
    req.once('end', onEnd)
    req.once('error', onError)
    req.once('aborted', onAborted)
  })
}

function decodePathname(pathname) {
  try {
    return decodeURIComponent(pathname)
  } catch {
    return pathname
  }
}

function utf8Tail(value, limitBytes) {
  const buffer = Buffer.from(String(value || ''), 'utf8')
  let offset = Math.max(0, buffer.length - limitBytes)
  while (offset < buffer.length && (buffer[offset] & 0xc0) === 0x80) offset += 1
  return {
    text: buffer.subarray(offset).toString('utf8'),
    offset,
    totalBytes: buffer.length,
    truncated: offset > 0
  }
}

function createWebResponder(servedWebRoot, capability) {
  const resolvedRoot = path.resolve(servedWebRoot)
  const portable = (value) => process.platform === 'win32' ? value.toLowerCase() : value
  const portableRoot = portable(resolvedRoot)

  function isInside(root, file) {
    const resolved = portable(path.resolve(file))
    const normalizedRoot = portable(path.resolve(root))
    return resolved === normalizedRoot || resolved.startsWith(normalizedRoot + path.sep)
  }

  function isInsideWebRoot(file) {
    const resolved = portable(path.resolve(file))
    return resolved === portableRoot || resolved.startsWith(portableRoot + path.sep)
  }

  function plainWebFile(file) {
    if (!isInsideWebRoot(file)) return null
    try {
      const rootStat = fs.lstatSync(resolvedRoot)
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null
      const canonicalRoot = fs.realpathSync.native(resolvedRoot)
      const relative = path.relative(resolvedRoot, file)
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null
      const parts = relative.split(path.sep).filter(Boolean)
      let current = resolvedRoot
      for (let index = 0; index < parts.length; index += 1) {
        current = path.join(current, parts[index])
        const stat = fs.lstatSync(current)
        if (stat.isSymbolicLink()) return null
        if (index < parts.length - 1 && !stat.isDirectory()) return null
        if (index === parts.length - 1 && !stat.isFile()) return null
      }
      const canonicalFile = fs.realpathSync.native(current)
      if (!isInside(canonicalRoot, canonicalFile) || canonicalFile === canonicalRoot) return null
      return canonicalFile
    } catch {
      return null
    }
  }

  function sendWebFile(req, res, file) {
    const ext = path.extname(file).toLowerCase()
    const headers = {
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY'
    }
    if (ext === '.html') {
      headers['Cache-Control'] = 'no-store'
      if (!hasCapability(req, capability)) headers['Set-Cookie'] = capabilityCookie(capability)
    }
    send(res, 200, fs.readFileSync(file), WEB_TYPES[ext] || 'application/octet-stream', headers)
  }

  return function serveWeb(req, url, res) {
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
      const relative = candidate.replace(/^[/\\]+/, '')
      if (relative.split(/[/\\]/).some((part) => part === '..')) continue
      const file = plainWebFile(path.resolve(resolvedRoot, relative))
      if (!file) continue
      sendWebFile(req, res, file)
      return true
    }
    return false
  }
}

function createApplicationBridge(host, packageRoot, dataRoot, getDiagnostics, getDaemonStatus) {
  function suppliedRequestId(req, body, suffix = '') {
    const candidates = [
      body?.requestId,
      body?.meta?.requestId,
      requestIdHeader(req)
    ]
    const supplied = candidates.find((value) => typeof value === 'string' && value.trim())
    const value = supplied ? supplied.trim() : host.commandMeta('http').requestId
    return suffix ? `${value}:${suffix}` : value
  }

  function typedCommand(req, body, kind, input = {}, suffix = '') {
    return {
      kind,
      ...input,
      meta: host.commandMeta('http', suppliedRequestId(req, body, suffix))
    }
  }

  async function executeTyped(command) {
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
    return projectLegacyResult(result, host)
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

  async function handleApi(req, url, body) {
    if (url.pathname === '/api/host/diagnostics') {
      return getDiagnostics()
    }

    if (url.pathname === '/api/command') {
      const input = body && typeof body === 'object' ? body : {}
      const kind = typeof input.kind === 'string' ? input.kind : ''
      const { meta: _suppliedMeta, requestId: _requestId, ...payload } = input
      const command = {
        ...payload,
        kind,
        meta: host.commandMeta('http', suppliedRequestId(req, body))
      }
      return executeTyped(command)
    }

    if (url.pathname === '/api/state') {
      return executeLegacy(req, body, 'status')
    }

    if (url.pathname === '/api/daemon') {
      return getDaemonStatus()
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
        ...(isStructuredSessionView(session)
          ? {}
          : { logTail: host.localSessions?.readLog(session.id).slice(-8000) || '' })
      }))
      return { sessions }
    }

    if (url.pathname === '/api/codex/session') {
      const id = url.searchParams.get('id')
      const result = await executeTyped(typedCommand(req, body, 'getSession', { sessionId: id || '' }))
      if (!result.ok && result.error.code === 'NOT_FOUND') {
        throw new HttpTransportError(404, 'HTTP_NOT_FOUND', 'session not found')
      }
      const projected = projectLegacyResult(result, host)
      return {
        session: projected.session,
        ...(isStructuredSessionView(projected.session)
          ? {}
          : { log: host.localSessions?.readLog(id || '') || '' })
      }
    }

    if (url.pathname === '/api/worktrees') {
      return executeLegacy(req, body, 'listWorktrees')
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

    throw new HttpTransportError(404, 'HTTP_NOT_FOUND', 'API route not found')
  }

  async function findSession(id) {
    const result = await executeTyped({
      kind: 'getSession',
      sessionId: id,
      meta: host.commandMeta('http-sse')
    })
    if (!result.ok) {
      if (result.error.code === 'NOT_FOUND') return { session: null, error: null }
      return { session: null, error: result.error }
    }
    return { session: result.data.session, error: null }
  }

  return { executeTyped, handleApi, findSession }
}

export function createHttpServer(options = {}) {
  const host = options.host
  if (!host?.application || typeof host.commandMeta !== 'function') {
    throw new TypeError('createHttpServer requires an already-open host')
  }

  const packageRoot = path.resolve(options.packageRoot || host.packageRoot)
  const dataRoot = path.resolve(options.dataRoot || host.dataRoot)
  const daemonEpoch = options.daemonEpoch == null ? '' : String(options.daemonEpoch)
  if (daemonEpoch && !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(daemonEpoch)) {
    throw new TypeError('options.daemonEpoch must be a canonical UUID')
  }
  const configuredPort = Number(options.port || defaultPort)
  const bodyLimitBytes = Number(options.bodyLimitBytes || DEFAULT_BODY_LIMIT_BYTES)
  const streamPollMs = Math.max(5, Number(options.streamPollMs || 250))
  const streamHeartbeatMs = Math.max(100, Number(options.streamHeartbeatMs || 15000))
  const streamLogTailBytes = Math.max(256, Number(options.streamLogTailBytes || 8192))
  const servedWebRoot = path.resolve(options.webRoot || path.join(packageRoot, 'web'))
  const getDiagnostics = options.getDiagnostics || (() => doctorHub(packageRoot, undefined, dataRoot))
  const getDaemonStatus = options.getDaemonStatus || (() => daemonStatus(packageRoot, undefined, dataRoot))
  const capabilityHandle = options.capability || createHttpCapability()
  const capability = CAPABILITY_SECRETS.get(capabilityHandle)
  if (!capability) throw new TypeError('options.capability must come from createHttpCapability()')
  const activeStreams = new Set()
  const bridge = createApplicationBridge(host, packageRoot, dataRoot, getDiagnostics, getDaemonStatus)
  const productService = createProductService({
    packageRoot,
    dataRoot,
    host,
    executeTyped: bridge.executeTyped
  })
  const serveWeb = createWebResponder(servedWebRoot, capability)

  function requireCapability(req) {
    if (!hasCapability(req, capability)) {
      throw new HttpTransportError(
        403,
        'HTTP_CAPABILITY_REQUIRED',
        'a panel capability is required for write commands'
      )
    }
  }

  function streamSession(id, req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
      Deprecation: 'true',
      Link: '</api/command>; rel="successor-version"'
    })

    let closed = false
    let pollTimer = null
    let heartbeatTimer = null
    let lastLogText = null
    let lastLogBytes = -1
    let lastStatus = ''
    let lastSession = ''

    const clearTimers = () => {
      if (pollTimer) clearTimeout(pollTimer)
      if (heartbeatTimer) clearTimeout(heartbeatTimer)
      pollTimer = null
      heartbeatTimer = null
    }
    const cleanup = () => {
      if (closed) return
      closed = true
      clearTimers()
      activeStreams.delete(shutdown)
      req.off('aborted', abort)
      res.off('close', abort)
    }
    const writeEvent = (event, payload) => {
      if (closed || res.destroyed || res.writableEnded) return false
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
        return true
      } catch {
        cleanup()
        return false
      }
    }
    const finish = (reason) => {
      if (closed) return
      writeEvent('end', {
        streamVersion: TRANSPORT_VERSION,
        sessionId: id,
        reason
      })
      if (!res.destroyed && !res.writableEnded) res.end()
      cleanup()
    }
    const abort = () => cleanup()
    const shutdown = () => finish('server-shutdown')
    const schedulePoll = () => {
      if (!closed) pollTimer = setTimeout(() => void tick(), streamPollMs)
    }
    const heartbeat = () => {
      if (closed || res.destroyed || res.writableEnded) {
        cleanup()
        return
      }
      try {
        res.write(`: keepalive ${Date.now()}\n\n`)
      } catch {
        cleanup()
        return
      }
      heartbeatTimer = setTimeout(heartbeat, streamHeartbeatMs)
    }
    const tick = async () => {
      if (closed) return
      pollTimer = null
      try {
        const { session, error } = await bridge.findSession(id)
        if (closed) return
        if (error) {
          writeEvent('status', { status: 'error', error: error.message || error.code || 'session query failed' })
          finish('error')
          return
        }
        if (!session) {
          writeEvent('status', { status: 'missing' })
          finish('missing')
          return
        }
        const serializedSession = JSON.stringify(session)
        if (serializedSession !== lastSession) {
          lastSession = serializedSession
          writeEvent('session', session)
        }
        // P5 sessions carry normalized bounded events. Never mirror their raw
        // Codex JSONL/text stream through SSE; legacy rows without events keep
        // the deprecated log projection for read compatibility only.
        if (!isStructuredSessionView(session)) {
          const log = utf8Tail(host.localSessions?.readLog(id) || '', streamLogTailBytes)
          if (log.totalBytes !== lastLogBytes || log.text !== lastLogText) {
            lastLogBytes = log.totalBytes
            lastLogText = log.text
            writeEvent('log', log)
          }
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
        if (TERMINAL_SESSION_STATUSES.has(session.status)) {
          finish('settled')
          return
        }
        schedulePoll()
      } catch (error) {
        if (closed) return
        writeEvent('status', { status: 'error', error: error?.message || String(error) })
        finish('error')
      }
    }

    activeStreams.add(shutdown)
    req.once('aborted', abort)
    res.once('close', abort)
    heartbeatTimer = setTimeout(heartbeat, streamHeartbeatMs)
    void tick()
  }

  const handleRequest = async (req, res) => {
    try {
      validateLoopbackRequest(req, configuredPort)
      const url = new URL(req.url || '/', 'http://loopback.invalid')

      if (url.pathname.startsWith('/api/')) {
        const isProductRoute = url.pathname === '/api/product' || url.pathname.startsWith('/api/product/')
        if (isProductRoute) {
          const method = req.method || 'GET'
          if (method !== 'GET' && method !== 'POST') {
            throw new HttpTransportError(
              405,
              'HTTP_METHOD_NOT_ALLOWED',
              `${method} is not allowed for ${url.pathname}`,
              { headers: { Allow: 'GET, POST' } }
            )
          }

          let body = {}
          if (method === 'POST') {
            requireCapability(req)
            if (!isJsonContentType(req.headers?.['content-type'])) {
              throw new HttpTransportError(
                415,
                'HTTP_UNSUPPORTED_MEDIA_TYPE',
                'POST requests require Content-Type: application/json'
              )
            }
            body = await readJsonBody(req, bodyLimitBytes)
          }

          try {
            const productPathname = url.pathname.slice('/api/product'.length) || '/'
            const data = await productService.handle({
              method,
              pathname: productPathname,
              body,
              searchParams: url.searchParams
            })
            sendJson(res, 200, data)
          } catch (error) {
            if (error instanceof HttpTransportError) throw error
            throw new HttpTransportError(
              Number(error?.status) || 500,
              typeof error?.code === 'string' && error.code ? error.code : 'HTTP_INTERNAL',
              error?.message || String(error),
              { details: error?.details }
            )
          }
          return
        }

        const allowed = API_METHODS.get(url.pathname)
        if (!allowed) throw new HttpTransportError(404, 'HTTP_NOT_FOUND', 'API route not found')
        if (!allowed.includes(req.method || 'GET')) {
          throw new HttpTransportError(
            405,
            'HTTP_METHOD_NOT_ALLOWED',
            `${req.method || 'UNKNOWN'} is not allowed for ${url.pathname}`,
            { headers: { Allow: allowed.join(', ') } }
          )
        }

        if (DEPRECATED_WRITE_ROUTES.has(url.pathname)) requireCapability(req)

        if (url.pathname === '/api/health') {
          sendJson(res, 200, { ok: true }, {
            'X-Skill-Graft-Package-Root': encodeURIComponent(packageRoot),
            'X-Skill-Graft-Data-Root': encodeURIComponent(dataRoot),
            ...(daemonEpoch ? { 'X-Skill-Graft-Daemon-Epoch': daemonEpoch } : {})
          })
          return
        }

        if (url.pathname === '/api/codex/session/stream') {
          requireCapability(req)
          const id = url.searchParams.get('id')
          if (!id) throw new HttpTransportError(400, 'HTTP_INVALID_QUERY', 'missing session id')
          streamSession(id, req, res)
          return
        }

        let body = {}
        if (req.method === 'POST') {
          if (!isJsonContentType(req.headers?.['content-type'])) {
            throw new HttpTransportError(
              415,
              'HTTP_UNSUPPORTED_MEDIA_TYPE',
              'POST requests require Content-Type: application/json'
            )
          }
          body = await readJsonBody(req, bodyLimitBytes)
          if (url.pathname === '/api/command') {
            const kind = typeof body.kind === 'string' ? body.kind : ''
            if (!QUERY_COMMAND_KINDS.has(kind)) requireCapability(req)
          }
        }

        const data = await bridge.handleApi(req, url, body)
        sendJson(res, 200, data, compatibilityHeaders(url.pathname))
        return
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        throw new HttpTransportError(
          405,
          'HTTP_METHOD_NOT_ALLOWED',
          `${req.method || 'UNKNOWN'} is not allowed for static resources`,
          { headers: { Allow: 'GET, HEAD' } }
        )
      }
      if (serveWeb(req, url, res)) return
      throw new HttpTransportError(404, 'HTTP_NOT_FOUND', 'static resource not found')
    } catch (error) {
      if (!res.headersSent) sendProblem(req, res, error)
      else if (!res.writableEnded) res.end()
    }
  }

  const server = http.createServer(handleRequest)
  let closePromise = null
  const close = () => {
    if (closePromise) return closePromise
    for (const shutdown of [...activeStreams]) shutdown()
    closePromise = new Promise((resolve, reject) => {
      if (!server.listening) {
        resolve()
        return
      }
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
      server.closeIdleConnections?.()
    })
    return closePromise
  }

  return {
    server,
    handleRequest,
    close,
    capabilityCookieName: CAPABILITY_COOKIE
  }
}

function isMainModule() {
  const entry = process.argv[1]
  if (!entry) return false
  return path.resolve(fileURLToPath(import.meta.url)).toLowerCase() === path.resolve(entry).toLowerCase()
}

function listenHttpTransport(transport, port, bindHost) {
  return new Promise((resolve, reject) => {
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

function isOptionalIpv6ListenError(error) {
  return ['EADDRINUSE', 'EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(String(error?.code || ''))
}

export async function startApiListeners(options = {}) {
  const packageRoot = path.resolve(options.packageRoot || hubRoot)
  const resolveDataRoot = options.resolveDataRoot || resolveInstallDataRoot
  const dataRoot = path.resolve(options.dataRoot || resolveDataRoot(packageRoot))
  const port = Number(options.port ?? defaultPort)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new TypeError('startApiListeners port must be an integer from 0 through 65535')
  }
  const host = options.host || await (options.openHost || openLocalHost)({
    packageRoot,
    dataRoot,
    hostId: 'local-http'
  })
  const transports = []
  const capability = options.capability || createHttpCapability()
  const listenTransport = options.listenTransport || listenHttpTransport
  const signalTarget = options.signalTarget || process
  const log = options.log || ((message) => console.log(message))
  const warn = options.warn || ((message) => console.warn(message))
  const logError = options.logError || ((message, error) => console.error(message, error))
  let signalHandlersRegistered = false
  let closePromise = null

  const removeSignalHandlers = () => {
    if (!signalHandlersRegistered) return
    signalHandlersRegistered = false
    signalTarget.off('SIGTERM', onSignal)
    signalTarget.off('SIGINT', onSignal)
  }
  const close = () => {
    if (closePromise) return closePromise
    removeSignalHandlers()
    closePromise = Promise.allSettled(transports.map((transport) => transport.close())).then(() => undefined)
    return closePromise
  }
  const onSignal = () => {
    void close().catch((error) => logError('skill-graft api shutdown failed', error))
  }

  try {
    const ipv4 = createHttpServer({
      host,
      packageRoot,
      dataRoot,
      port,
      capability
    })
    transports.push(ipv4)
    await listenTransport(ipv4, port, '127.0.0.1')
    const ipv4Address = ipv4.server.address()
    const listeningPort = typeof ipv4Address === 'object' && ipv4Address ? ipv4Address.port : port
    log(`skill-graft api http://127.0.0.1:${listeningPort}/`)

    const ipv6 = createHttpServer({
      host,
      packageRoot,
      dataRoot,
      port: listeningPort,
      capability
    })
    try {
      await listenTransport(ipv6, listeningPort, '::1')
      transports.push(ipv6)
      log(`skill-graft api http://localhost:${listeningPort}/`)
    } catch (error) {
      await ipv6.close()
      if (!isOptionalIpv6ListenError(error)) throw error
      warn(`skill-graft IPv6 API unavailable (${error.code}); continuing on IPv4`)
    }

    signalHandlersRegistered = true
    signalTarget.once('SIGTERM', onSignal)
    signalTarget.once('SIGINT', onSignal)
    return { host, transports, close }
  } catch (error) {
    await close()
    throw error
  }
}

if (isMainModule()) {
  void startApiListeners().catch((error) => {
    console.error('skill-graft api failed to start', error)
    process.exitCode = 1
  })
}
