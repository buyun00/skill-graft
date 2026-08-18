import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const panelRoot = path.resolve(__dirname, '..')
const hubRoot = path.resolve(panelRoot, '..')
const host = '127.0.0.1'
const port = 18765

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
}

function sessionsPath() {
  return path.join(hubRoot, 'skill-review', 'sessions.json')
}

function loadSessions() {
  return readJson(sessionsPath(), { sessions: [] })
}

function saveSessions(data) {
  writeJson(sessionsPath(), data)
}

function upsertSession(session) {
  const data = loadSessions()
  const list = Array.isArray(data.sessions) ? data.sessions : []
  const index = list.findIndex((item) => item.id === session.id)
  if (index >= 0) list[index] = session
  else list.push(session)
  data.sessions = list
  saveSessions(data)
}

function buildPrompt({ kind, skillPath, intent, worktree }) {
  const name = kind === 'analyze-note' ? 'chat' : kind
  const templateFile = path.join(hubRoot, 'overlay', 'prompts', `${name}.txt`)
  let prompt = fs.existsSync(templateFile) ? fs.readFileSync(templateFile, 'utf8') : (intent || '')
  prompt = prompt
    .replaceAll('{{HUB}}', hubRoot)
    .replaceAll('{{PATH}}', skillPath || '')
    .replaceAll('{{INTENT}}', intent || '')
    .replaceAll('{{WORKTREE}}', worktree || '')
  return prompt.trim()
}

function startInternalCodex({ kind, skillPath, intent, worktree }) {
  if (kind === 'edit' && !skillPath) throw new Error('edit requires path')
  if ((kind === 'attach' || kind === 'detach') && !worktree) throw new Error(`${kind} requires worktree`)

  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  const prompt = buildPrompt({ kind, skillPath, intent, worktree })
  const promptFile = path.join(hubRoot, 'skill-review', `prompt-${id}.txt`)
  const logFile = path.join(hubRoot, 'skill-review', `session-${id}.log`)
  const lastFile = path.join(hubRoot, 'skill-review', `session-${id}.last.txt`)
  fs.writeFileSync(promptFile, prompt, 'utf8')

  const args = [
    'exec',
    '-C', hubRoot,
    '--skip-git-repo-check',
    '--color', 'never',
    '--sandbox', 'danger-full-access',
    '--dangerously-bypass-approvals-and-sandbox',
    '-o', lastFile
  ]
  if (worktree) args.push('--add-dir', worktree)
  args.push(prompt)

  const session = {
    id,
    kind,
    path: skillPath || '',
    worktree: worktree || '',
    intent: intent || '',
    pid: 0,
    promptFile,
    logFile,
    lastFile,
    startedAt: new Date().toISOString(),
    status: 'running',
    exitCode: null,
    error: ''
  }
  upsertSession(session)

  const npmRoot = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
  const child = spawn(process.execPath, [npmRoot, ...args], {
    cwd: hubRoot,
    windowsHide: true,
    windowsVerbatimArguments: false,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1' }
  })
  session.pid = child.pid || 0
  upsertSession(session)

  const append = (chunk) => {
    fs.appendFileSync(logFile, chunk.toString('utf8'))
  }
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  child.on('error', (error) => {
    session.status = 'failed'
    session.error = error.message
    session.finishedAt = new Date().toISOString()
    append(`\n[spawn error] ${error.message}\n`)
    upsertSession(session)
  })
  child.on('close', (code) => {
    session.exitCode = code
    session.status = code === 0 ? 'completed' : 'failed'
    session.finishedAt = new Date().toISOString()
    if (fs.existsSync(lastFile)) session.lastMessage = fs.readFileSync(lastFile, 'utf8')
    upsertSession(session)
  })
  return session
}

function listSkillGroup(rel, kind) {
  const abs = path.join(hubRoot, rel)
  if (!fs.existsSync(abs)) return []
  return fs.readdirSync(abs, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      kind,
      path: `${rel.replaceAll('\\', '/')}/${entry.name}`,
      hasSkillMd: fs.existsSync(path.join(abs, entry.name, 'SKILL.md')),
      attached: false
    }))
}

function gameRepoSync() {
  try {
    return spawnSync('git', ['-C', hubRoot, 'config', '--get', 'ozdqp.gameRepo'], { encoding: 'utf8' }).stdout.trim() || null
  } catch {
    return null
  }
}

function runGit(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, windowsHide: true })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('close', (code) => {
      if (code === 0) resolve(out)
      else reject(new Error(err || `git ${args.join(' ')} failed (${code})`))
    })
  })
}

function runPwsh(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], {
      cwd: hubRoot,
      windowsHide: true
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('close', (code) => {
      if (code === 0) resolve(out)
      else reject(new Error(err || out || `${path.basename(script)} failed`))
    })
  })
}

function readList(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
}

function gitOut(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) return ''
  return result.stdout || ''
}

function isClientCheckout(dir) {
  if (!dir || !fs.existsSync(dir)) return false
  if (samePath(dir, hubRoot)) return false
  const name = path.basename(dir).toLowerCase()
  if (name === 'ozdqp-skill-hub' || name === 'ozdqp-skill-overlay-kit') return false
  if (name.includes('.partial-')) return false
  return fs.existsSync(path.join(dir, 'AGENTS.md')) && fs.existsSync(path.join(dir, 'baloot_client'))
}

function isEphemeralPath(dir) {
  const normalized = dir.replaceAll('\\', '/').toLowerCase()
  return (
    normalized.includes('/temp/') ||
    normalized.includes('/appdata/local/temp/') ||
    normalized.includes('/.codex/worktrees/') ||
    normalized.includes('/.config/cursor/worktrees/')
  )
}

function parseWorktreePorcelain(text) {
  const trees = []
  let current = {}
  const flush = () => {
    if (!current.path) return
    trees.push({
      path: current.path,
      branch: current.branch || (current.detached ? '(detached)' : ''),
      head: current.head || '',
      locked: Boolean(current.locked),
      prunable: Boolean(current.prunable)
    })
    current = {}
  }
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      flush()
      current.path = line.slice(9)
    } else if (line.startsWith('HEAD ')) current.head = line.slice(5)
    else if (line.startsWith('branch ')) current.branch = line.slice(7).replace('refs/heads/', '')
    else if (line === 'detached') current.detached = true
    else if (line.startsWith('locked')) current.locked = true
    else if (line.startsWith('prunable')) current.prunable = true
    else if (line === '') flush()
  }
  flush()
  return trees
}

function discoverClientDirs(roots) {
  const found = []
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue
    let entries = []
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const full = path.join(root, entry.name)
      if (isClientCheckout(full)) found.push(full)
    }
  }
  return found
}

function cloneRootFromCommonDir(commonDir) {
  const resolved = path.resolve(commonDir)
  const base = path.basename(resolved)
  const parent = path.dirname(resolved)
  if (base === '.git') return parent
  if (path.basename(parent) === 'worktrees' && path.basename(path.dirname(parent)) === '.git') {
    return path.dirname(path.dirname(parent))
  }
  return parent
}

function collectWorktrees() {
  const scanRoots = readList(path.join(hubRoot, 'overlay', 'scan-roots.txt'))
  const discovered = discoverClientDirs(scanRoots)
  const cloneSeeds = new Map()
  for (const dir of discovered) {
    const raw = gitOut(dir, ['rev-parse', '--git-common-dir']).trim()
    const common = raw ? path.resolve(dir, raw) : path.resolve(dir, '.git')
    if (!cloneSeeds.has(common.toLowerCase())) cloneSeeds.set(common.toLowerCase(), { seed: dir, common })
  }

  const attached = readList(path.join(hubRoot, 'overlay', 'attached-worktrees.txt'))
  const blocked = readList(path.join(hubRoot, 'overlay', 'do-not-auto-attach.txt'))
  const byPath = new Map()

  const addTree = (info, cloneRoot, requireClient) => {
    if (!info.path || !fs.existsSync(info.path) || samePath(info.path, hubRoot)) return
    if (requireClient && !isClientCheckout(info.path)) return
    const resolved = path.resolve(info.path)
    const key = resolved.toLowerCase()
    if (byPath.has(key)) return
    const changedAtMs = latestLocalChangeMs(resolved)
    byPath.set(key, {
      name: path.basename(resolved),
      path: info.path,
      branch: info.branch || gitOut(info.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() || '(unknown)',
      head: info.head || gitOut(info.path, ['rev-parse', 'HEAD']).trim(),
      cloneRoot,
      changedAt: changedAtMs ? new Date(changedAtMs).toISOString() : '',
      changedAtMs,
      attached: attached.some((item) => samePath(item, info.path)),
      doNotAuto: blocked.some((item) => samePath(item, info.path)),
      officialPresent: fs.existsSync(path.join(info.path, '.claude', 'skills')) || fs.existsSync(path.join(info.path, '.codex', 'skills')),
      overrideLinked: isLinked(path.join(info.path, 'AGENTS.override.md'), path.join(hubRoot, 'AGENTS.override.md')),
      ephemeral: isEphemeralPath(info.path),
      locked: Boolean(info.locked),
      prunable: Boolean(info.prunable)
    })
  }

  for (const { seed, common } of cloneSeeds.values()) {
    const porcelain = gitOut(seed, ['worktree', 'list', '--porcelain'])
    const listed = parseWorktreePorcelain(porcelain)
    const cloneRoot = cloneRootFromCommonDir(common)
    if (listed.length === 0) {
      addTree({ path: seed, branch: '', head: '' }, cloneRoot, true)
      continue
    }
    for (const tree of listed) addTree(tree, cloneRoot, false)
  }

  for (const dir of discovered) {
    const raw = gitOut(dir, ['rev-parse', '--git-common-dir']).trim()
    const common = raw ? path.resolve(dir, raw) : path.resolve(dir, '.git')
    addTree({ path: dir, branch: '', head: '' }, cloneRootFromCommonDir(common), true)
  }

  const worktrees = [...byPath.values()].sort((left, right) => (right.changedAtMs || 0) - (left.changedAtMs || 0))
  return { worktrees, scanRoots }
}

let worktreeCache = { at: 0, data: null }

function collectWorktreesCached() {
  const now = Date.now()
  if (worktreeCache.data && now - worktreeCache.at < 30000) return worktreeCache.data
  const data = collectWorktrees()
  worktreeCache = { at: now, data }
  return data
}

function fileTimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs || 0
  } catch {
    return 0
  }
}

function latestLocalChangeMs(dir) {
  const times = [fileTimeMs(dir), fileTimeMs(path.join(dir, '.git')), fileTimeMs(path.join(dir, 'AGENTS.override.md'))]
  const gitDir = gitOut(dir, ['rev-parse', '--absolute-git-dir']).trim()
  if (gitDir) {
    times.push(fileTimeMs(gitDir), fileTimeMs(path.join(gitDir, 'HEAD')), fileTimeMs(path.join(gitDir, 'index')))
  }
  return Math.max(0, ...times)
}

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
}

function isLinked(linkPath, expected) {
  try {
    if (samePath(fs.realpathSync(linkPath), expected)) return true
  } catch {
    // fall through to inode compare
  }
  try {
    const left = fs.statSync(linkPath)
    const right = fs.statSync(expected)
    return Boolean(left.ino && right.ino && left.ino === right.ino && left.dev === right.dev)
  } catch {
    return false
  }
}

async function handleApi(req, url, body) {
  const state = readJson(path.join(hubRoot, 'skill-review', 'state.json'), { version: 1, items: [], lastIngest: null })
  const repo = gameRepoSync()
  if (url.pathname === '/api/state') {
    const resident = ['ozdqp-development', 'ozdqp-ui-development', 'ozdqp-git-workflow'].map((name) => ({
      name,
      kind: 'resident',
      path: `skills/${name}`,
      hasSkillMd: fs.existsSync(path.join(hubRoot, 'skills', name, 'SKILL.md')),
      attached: repo ? isLinked(path.join(repo, '.agents', 'skills', name), path.join(hubRoot, 'skills', name)) : false
    }))
    const adopted = listSkillGroup('skills/adopted', 'adopted').map((node) => ({
      ...node,
      attached: repo ? isLinked(path.join(repo, '.agents', 'skills', node.name), path.join(hubRoot, 'skills', 'adopted', node.name)) : false
    }))
    const inbox = listSkillGroup('skills/inbox', 'inbox')
    const items = state.items || []
    return {
      hubRoot,
      gameRepo: repo,
      lastIngest: state.lastIngest || null,
      resident,
      adopted,
      inbox,
      items,
      counts: {
        resident: resident.length,
        adopted: adopted.length,
        queued: items.filter((item) => item.status === 'queued').length,
        proposed: items.filter((item) => item.status === 'proposed').length
      }
    }
  }

  if (url.pathname === '/api/skill') {
    const rel = url.searchParams.get('path') || ''
    const abs = path.resolve(hubRoot, rel)
    if (!abs.startsWith(hubRoot)) throw new Error('path escaped hub')
    if (!fs.existsSync(abs)) throw new Error('missing ' + rel)
    const target = fs.statSync(abs).isDirectory()
      ? (fs.existsSync(path.join(abs, 'SKILL.md')) ? path.join(abs, 'SKILL.md') : abs)
      : abs
    if (fs.statSync(target).isDirectory()) throw new Error('no SKILL.md')
    return { path: rel, content: fs.readFileSync(target, 'utf8') }
  }

  if (url.pathname === '/api/history') {
    const dir = path.join(hubRoot, 'skill-review', 'history')
    if (!fs.existsSync(dir)) return { records: [] }
    const files = fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort().reverse().slice(0, 50)
    return { records: files.map((name) => readJson(path.join(dir, name), {})) }
  }

  if (url.pathname === '/api/codex/sessions') {
    const data = loadSessions()
    const sessions = (data.sessions || []).map((session) => {
      let logTail = ''
      if (session.logFile && fs.existsSync(session.logFile)) {
        const text = fs.readFileSync(session.logFile, 'utf8')
        logTail = text.slice(-8000)
      }
      return { ...session, logTail }
    })
    return { sessions }
  }

  if (url.pathname === '/api/codex/session') {
    const id = url.searchParams.get('id')
    const session = (loadSessions().sessions || []).find((item) => item.id === id)
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
    const args = ['-Id', body.id, '-Action', body.action]
    if (body.note) args.push('-Note', body.note)
    if (body.mergeTarget) args.push('-MergeTarget', body.mergeTarget)
    const out = await runPwsh(path.join(hubRoot, 'overlay', 'promote-inbox.ps1'), args)
    return { ok: true, output: out }
  }

  if (url.pathname === '/api/analyze') {
    const out = await runPwsh(path.join(hubRoot, 'overlay', 'dispatch-hub-codex.ps1'), [])
    return { ok: true, output: out }
  }

  if (url.pathname === '/api/codex/start') {
    const session = startInternalCodex({
      kind: body.kind || 'chat',
      skillPath: body.path,
      intent: body.intent,
      worktree: body.worktree
    })
    return session
  }

  if (url.pathname === '/api/worktree/attach') {
    const session = startInternalCodex({ kind: 'attach', worktree: body.path, intent: body.intent })
    return { ok: true, session }
  }

  if (url.pathname === '/api/worktree/detach') {
    const session = startInternalCodex({ kind: 'detach', worktree: body.path, intent: body.intent })
    return { ok: true, session }
  }

  const err = new Error('not found')
  err.status = 404
  throw err
}

function send(res, status, payload, contentType = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': contentType })
  res.end(payload)
}

function serveStatic(urlPath, res) {
  const dist = path.join(panelRoot, 'dist')
  let rel = urlPath === '/' ? '/index.html' : urlPath
  const abs = path.normalize(path.join(dist, rel))
  if (!abs.startsWith(dist)) {
    send(res, 403, 'forbidden', 'text/plain')
    return
  }
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    send(res, 200, fs.readFileSync(path.join(dist, 'index.html')), 'text/html; charset=utf-8')
    return
  }
  const ext = path.extname(abs)
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.json': 'application/json; charset=utf-8'
  }
  send(res, 200, fs.readFileSync(abs), types[ext] || 'application/octet-stream')
}

function findSession(id) {
  return (loadSessions().sessions || []).find((item) => item.id === id) || null
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
        exitCode: session.exitCode
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

const onRequest = async (req, res) => {
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
    serveStatic(url.pathname, res)
  } catch (error) {
    send(res, error.status || 500, JSON.stringify({ error: error.message || String(error) }))
  }
}

for (const bindHost of ['127.0.0.1', '::1']) {
  const server = http.createServer(onRequest)
  server.listen(port, bindHost, () => {
    const label = bindHost === '::1' ? 'localhost' : bindHost
    console.log(`skill hub panel http://${label}:${port}/`)
  })
  server.on('error', (error) => {
    if (bindHost === '::1' && error && error.code === 'EADDRINUSE') return
    console.error(`listen ${bindHost}:${port} failed`, error)
    if (bindHost === '127.0.0.1') process.exit(1)
  })
}

setTimeout(() => {
  try { collectWorktreesCached() } catch (error) { console.error(error) }
}, 300)
