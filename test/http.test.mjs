import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import test from 'node:test'
import { onRequest } from '../server/index.mjs'
import { hubRoot, spawnHub } from './helpers.mjs'

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

test('HTTP query handlers invoke the shipped CLI and do not import core commands', () => {
  const source = fs.readFileSync(path.join(hubRoot, 'server', 'index.mjs'), 'utf8')
  assert.doesNotMatch(source, /from ['"][^'"]*dist\/index\.js['"]/)
  assert.doesNotMatch(source, /\bcreateHub\b/)
  assert.doesNotMatch(source, /\bgetStatus\b/)
  assert.doesNotMatch(source, /\blistWorktrees\b/)
  assert.match(source, /runHub\(\['status'\]\)/)
  assert.match(source, /runHub\(\['daemon', 'status'\]\)/)
  assert.match(source, /runHub\(\['list-worktrees'\]\)/)
  assert.match(source, /\['decide'/)
  assert.match(source, /sessionFromHub\('attach'/)
  assert.match(source, /sessionFromHub\('detach'/)
  assert.match(source, /runHub\(\['resume'/)
  assert.doesNotMatch(source, /promote-inbox\.ps1/)
  assert.doesNotMatch(source, /attach-library\.ps1/)
  assert.doesNotMatch(source, /analyze-remote-skill-update\.ps1/)

  const start = source.indexOf('export async function handleApi')
  const end = source.indexOf('\nfunction send(', start)
  assert.ok(start >= 0 && end > start, 'handleApi is present')
  const handleApi = source.slice(start, end)
  const state = extractPathnameBranch(handleApi, '/api/state')
  assert.match(state, /runHub\(\['status'\]\)/)
  assert.doesNotMatch(state, /readdir/)
  const worktrees = extractPathnameBranch(handleApi, '/api/worktrees')
  assert.match(worktrees, /collectWorktreesCached/)
  assert.doesNotMatch(worktrees, /readdir/)
})

test('management page is static and does not import core or embed attach policy', () => {
  const page = fs.readFileSync(path.join(hubRoot, 'web', 'index.html'), 'utf8')
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

test('GET / serves the management page and still only execs CLI for JSON', { timeout: 180000 }, async (t) => {
  const { server, base } = await listenQueryServer()
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const res = await fetch(`${base}/`)
  const html = await res.text()
  assert.equal(res.ok, true, html)
  assert.match(res.headers.get('content-type') || '', /text\/html/)
  assert.match(html, /skill-graft/)
  assert.match(html, /工作树/)
  const worktrees = await getJson(base, '/api/worktrees')
  const cli = spawnHub(['list-worktrees'])
  assert.equal(cli.status, 0, cli.stderr)
  const fromCli = JSON.parse(cli.stdout)
  const paths = (rows) => [...new Set(rows.map((item) => item.path))].sort((a, b) => a.localeCompare(b))
  assert.deepEqual(paths(worktrees.worktrees), paths(fromCli.worktrees))
})

test('hooks reach core only through the shipped CLI', () => {
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

  const health = await getJson(base, '/api/health')
  assert.deepEqual(health, { ok: true })

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
