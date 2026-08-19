import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import test from 'node:test'
import { createPanelApi } from '../panel/lib/api.mjs'
import { queuedSessionView } from '../panel/lib/overview-mapping.mjs'
import { buildPaletteEntries, filterPaletteEntries } from '../panel/lib/palette.mjs'
import { hubRoot } from './helpers.mjs'

function walkText(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === 'out') continue
    const full = path.join(dir, name)
    const st = fs.statSync(full)
    if (st.isDirectory()) walkText(full, acc)
    else if (/\.(html|js|css|mjs|ts|tsx|txt|map)$/.test(name)) acc.push(fs.readFileSync(full, 'utf8'))
  }
  return acc
}

function shippedSources() {
  return [
    ...walkText(path.join(hubRoot, 'panel', 'src')),
    ...walkText(path.join(hubRoot, 'panel', 'lib')),
    ...walkText(path.join(hubRoot, 'web'))
  ].join('\n')
}

async function listenRecorder() {
  const seen = []
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    let body = {}
    if (req.method === 'POST') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const raw = Buffer.concat(chunks).toString('utf8')
      body = raw ? JSON.parse(raw) : {}
    }
    seen.push({ method: req.method, path: url.pathname, search: url.search, body })
    const sessionish = ['/api/worktree/attach', '/api/worktree/detach', '/api/analyze', '/api/codex/start', '/api/codex/resume']
    const payload = sessionish.includes(url.pathname)
      ? { id: 'sess-1', status: 'running', kind: 'attach' }
      : { ok: true }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(payload))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return { server, seen, base: `http://127.0.0.1:${address.port}` }
}

test('shipped API client posts decide/analyze/attach/detach/codex as documented', async (t) => {
  const { server, seen, base } = await listenRecorder()
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const api = createPanelApi({ base })

  await api.decide('inbox-1', 'reject')
  await api.analyze()
  const attach = await api.attachWorktree('E:\\ozdqp-cli-attach-probe', 'contract-attach')
  const detach = await api.detachWorktree('E:\\ozdqp-cli-attach-probe', 'contract-detach')
  await api.startCodex({ kind: 'chat', intent: 'hello' })
  await api.resumeCodex('sess-1', 'continue')

  const byPath = Object.fromEntries(seen.map((item) => [item.path, item]))
  assert.equal(byPath['/api/decide'].method, 'POST')
  assert.deepEqual(byPath['/api/decide'].body, { id: 'inbox-1', action: 'reject' })
  assert.equal(byPath['/api/analyze'].method, 'POST')
  assert.equal(byPath['/api/worktree/attach'].method, 'POST')
  assert.equal(byPath['/api/worktree/attach'].body.path, 'E:\\ozdqp-cli-attach-probe')
  assert.equal(byPath['/api/worktree/detach'].method, 'POST')
  assert.equal(byPath['/api/codex/start'].method, 'POST')
  assert.equal(byPath['/api/codex/resume'].body.id, 'sess-1')
  assert.equal(byPath['/api/codex/resume'].body.message, 'continue')

  const queued = queuedSessionView(attach)
  assert.equal(queued.label, '已入队')
  assert.equal(queued.status, 'running')
  assert.equal(queued.attachedUnchanged, true)
  assert.equal(Object.prototype.hasOwnProperty.call(attach, 'attached'), false)
  assert.equal(queuedSessionView(detach).label, '已入队')
  assert.equal(api.sessionStreamUrl('abc'), `${base}/api/codex/session/stream?id=abc`)
})

test('palette entries come from skills + worktrees + updates with router hrefs', () => {
  const entries = buildPaletteEntries({
    state: {
      resident: [{ name: 'ozdqp-development', path: 'skills/ozdqp-development', kind: 'resident' }],
      adopted: [{ name: 'extra', path: 'skills/adopted/extra', kind: 'adopted' }],
      inbox: [{ name: 'archify', path: 'skills/inbox/archify', kind: 'inbox' }],
      items: [{ id: 'u-dev', name: 'ozdqp-development', status: 'queued' }]
    },
    worktrees: { worktrees: [{ name: 'probe', path: 'E:\\ozdqp-cli-attach-probe' }] }
  })
  const hrefs = entries.map((item) => item.href)
  assert.ok(hrefs.includes('/skills?path=skills%2Fozdqp-development'))
  assert.ok(hrefs.includes('/workspaces?path=E%3A%5Cozdqp-cli-attach-probe'))
  assert.ok(hrefs.includes('/updates/u-dev'))
  const filtered = filterPaletteEntries(entries, 'probe')
  assert.equal(filtered.length, 1)
  assert.equal(filtered[0].href, '/workspaces?path=E%3A%5Cozdqp-cli-attach-probe')
})

test('panel and web sources do not import core or embed attach policy', () => {
  const source = shippedSources()
  assert.match(source, /\/api\/state/)
  assert.match(source, /\/api\/worktrees/)
  assert.match(source, /\/api\/decide/)
  assert.match(source, /EventSource/)
  assert.match(source, /\/api\/codex\/session\/stream/)
  assert.doesNotMatch(source, /src\/core/)
  assert.doesNotMatch(source, /preferLibrary/)
  assert.doesNotMatch(source, /inode/)
  assert.doesNotMatch(source, /认仓/)
  assert.doesNotMatch(source, /createHub/)
  assert.doesNotMatch(source, /from ['"]node:fs['"]/)
})
