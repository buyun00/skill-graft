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
    return readJson(path.join(hubRoot, 'skill-review', 'sessions.json'), { sessions: [] })
  }

  if (url.pathname === '/api/worktrees') {
    if (!repo) return { worktrees: [] }
    const porcelain = await runGit(repo, ['worktree', 'list', '--porcelain'])
    const attached = readList(path.join(hubRoot, 'overlay', 'attached-worktrees.txt'))
    const blocked = readList(path.join(hubRoot, 'overlay', 'do-not-auto-attach.txt'))
    const trees = []
    let current = {}
    for (const line of porcelain.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) current.path = line.slice(9)
      else if (line.startsWith('HEAD ')) current.head = line.slice(5)
      else if (line.startsWith('branch ')) current.branch = line.slice(7).replace('refs/heads/', '')
      else if (line === '') {
        if (current.path) {
          trees.push({
            path: current.path,
            branch: current.branch || '(detached)',
            head: current.head || '',
            attached: attached.some((item) => samePath(item, current.path)),
            doNotAuto: blocked.some((item) => samePath(item, current.path)),
            officialPresent: fs.existsSync(path.join(current.path, '.claude', 'skills')) || fs.existsSync(path.join(current.path, '.codex', 'skills')),
            overrideLinked: isLinked(path.join(current.path, 'AGENTS.override.md'), path.join(hubRoot, 'AGENTS.override.md'))
          })
        }
        current = {}
      }
    }
    return { worktrees: trees }
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
    const args = ['-Kind', body.kind || 'edit']
    if (body.path) args.push('-Path', body.path)
    if (body.intent) args.push('-Intent', body.intent)
    if (body.worktree) args.push('-Worktree', body.worktree)
    const out = await runPwsh(path.join(hubRoot, 'overlay', 'start-codex-session.ps1'), args)
    return JSON.parse(out.trim().split(/\r?\n/).at(-1) || '{}')
  }

  if (url.pathname === '/api/worktree/attach') {
    const out = await runPwsh(path.join(hubRoot, 'overlay', 'start-codex-session.ps1'), ['-Kind', 'attach', '-Worktree', body.path])
    return { ok: true, output: out }
  }

  if (url.pathname === '/api/worktree/detach') {
    const out = await runPwsh(path.join(hubRoot, 'overlay', 'start-codex-session.ps1'), ['-Kind', 'detach', '-Worktree', body.path])
    return { ok: true, output: out }
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

const onRequest = async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${port}`)
  try {
    if (url.pathname === '/api/health') {
      send(res, 200, JSON.stringify({ ok: true }))
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
