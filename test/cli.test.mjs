import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { hubRoot, spawnHub } from './helpers.mjs'

function parseStdout(result, label) {
  assert.equal(result.status, 0, `${label} stderr=${result.stderr}`)
  assert.ok(!result.stdout.startsWith('\uFEFF'), `${label} stdout has a BOM`)
  return JSON.parse(result.stdout)
}

function tempHub() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cli-'))
  fs.mkdirSync(path.join(dir, 'skill-review', 'history'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'overlay'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'overlay', 'attached-worktrees.txt'), '')
  fs.writeFileSync(path.join(dir, 'overlay', 'do-not-auto-attach.txt'), '')
  return dir
}

test('U1 hub status exits 0 with hubRoot and 3 resident skills', () => {
  const payload = parseStdout(spawnHub(['status']), 'status')
  assert.equal(payload.hubRoot, hubRoot)
  assert.equal(payload.resident.length, 3)
  assert.ok(payload.resident.every((node) => node.kind === 'resident'))
  const queued = payload.items.filter((item) => item.status === 'queued')
  assert.equal(payload.counts.queued, queued.length)
})

test('U2 hub list-worktrees exits 0 with scanRoots and worktrees arrays', { timeout: 180000 }, () => {
  const payload = parseStdout(spawnHub(['list-worktrees']), 'list-worktrees')
  assert.ok(Array.isArray(payload.scanRoots), 'scanRoots')
  assert.ok(Array.isArray(payload.worktrees), 'worktrees')
})

test('U3 hub list-skills exits 0 with resident, adopted, and inbox arrays', () => {
  const payload = parseStdout(spawnHub(['list-skills']), 'list-skills')
  assert.ok(Array.isArray(payload.resident), 'resident')
  assert.ok(Array.isArray(payload.adopted), 'adopted')
  assert.ok(Array.isArray(payload.inbox), 'inbox')
})

test('U4 unknown command is non-zero; --help and -h exit 0', () => {
  const nope = spawnHub(['nope'])
  assert.notEqual(nope.status, 0)
  assert.match(nope.stderr, /unknown command: nope/)

  const help = spawnHub(['--help'])
  assert.equal(help.status, 0, help.stderr)
  for (const verb of ['status', 'list-worktrees', 'list-skills', 'repair-links', 'ingest', 'decide', 'attach', 'detach', 'edit', 'chat', 'resume']) {
    assert.match(help.stdout, new RegExp(verb))
  }

  const short = spawnHub(['-h'])
  assert.equal(short.status, 0, short.stderr)
  assert.match(short.stdout, /ozdqp-hub/)
})

test('repair-links on a path that is not attached does not rewrite disk', () => {
  const payload = parseStdout(
    spawnHub(['repair-links', '--worktree', 'C:\\hub-cli-not-attached']),
    'repair-links'
  )
  assert.equal(payload.ok, true)
  assert.equal(payload.action, 'repair-links')
  assert.equal(payload.repaired, false)
  assert.equal(payload.reason, 'not-attached')
  assert.equal(payload.attached, false)
})

test('ingest with empty stdin is a no-op', () => {
  const payload = parseStdout(spawnHub(['ingest'], { input: '' }), 'ingest')
  assert.equal(payload.ok, true)
  assert.equal(payload.action, 'ingest')
  assert.equal(payload.created, 0)
  assert.deepEqual(payload.items, [])
})

test('decide reject updates a fixture hub and does not touch the live inbox', (t) => {
  const dir = tempHub()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const id = 'cli-decide-fixture'
  const inboxRel = path.join(dir, 'skills', 'inbox', 'fixture-skill')
  fs.mkdirSync(inboxRel, { recursive: true })
  fs.writeFileSync(path.join(inboxRel, 'SKILL.md'), '# fixture\n')
  fs.writeFileSync(path.join(dir, 'skill-review', 'state.json'), JSON.stringify({
    version: 1,
    items: [{ id, name: 'fixture-skill', unit: 'fixture', status: 'queued', inboxPath: 'skills/inbox/fixture-skill' }],
    lastIngest: null
  }))
  const liveState = fs.readFileSync(path.join(hubRoot, 'skill-review', 'state.json'), 'utf8')
  const payload = parseStdout(
    spawnHub(['decide', '--id', id, '--action', 'reject'], { env: { HUB_ROOT: dir } }),
    'decide'
  )
  assert.equal(payload.ok, true)
  assert.equal(payload.action, 'reject')
  assert.equal(payload.item.status, 'rejected')
  assert.equal(fs.existsSync(inboxRel), false)
  assert.equal(fs.readFileSync(path.join(hubRoot, 'skill-review', 'state.json'), 'utf8'), liveState)
})

test('session verbs enqueue and do not silently rewrite a live game tree', (t) => {
  const dir = tempHub()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const liveSessions = path.join(hubRoot, 'skill-review', 'sessions.json')
  const beforeSessions = fs.existsSync(liveSessions) ? fs.readFileSync(liveSessions, 'utf8') : ''
  const fakeTree = 'C:\\hub-cli-not-a-game-tree'

  const attach = parseStdout(
    spawnHub(['attach', '--worktree', fakeTree, '--intent', 'test-enqueue', '--no-spawn'], { env: { HUB_ROOT: dir } }),
    'attach'
  )
  assert.equal(attach.ok, true)
  assert.equal(attach.action, 'attach')
  assert.equal(attach.applied, null)
  assert.equal(attach.session.kind, 'attach')
  assert.equal(attach.session.worktree, fakeTree)
  assert.equal(attach.session.status, 'queued')
  assert.equal(attach.session.pid, 0)
  assert.equal(attach.session.model, 'gpt-5.6-luna')
  assert.equal(attach.session.effort, 'max')

  const detach = parseStdout(
    spawnHub(['detach', '--worktree', fakeTree, '--no-spawn'], { env: { HUB_ROOT: dir } }),
    'detach'
  )
  assert.equal(detach.session.kind, 'detach')
  assert.equal(detach.session.status, 'queued')

  const edit = parseStdout(
    spawnHub(['edit', '--path', 'skills/ozdqp-development', '--no-spawn'], { env: { HUB_ROOT: dir } }),
    'edit'
  )
  assert.equal(edit.session.kind, 'edit')
  assert.equal(edit.session.path, 'skills/ozdqp-development')

  const chat = parseStdout(
    spawnHub(['chat', '--intent', 'hello', '--no-spawn'], { env: { HUB_ROOT: dir } }),
    'chat'
  )
  assert.equal(chat.session.kind, 'chat')

  const resume = parseStdout(
    spawnHub(['resume', '--id', chat.session.id, '--message', 'continue', '--no-spawn'], { env: { HUB_ROOT: dir } }),
    'resume'
  )
  assert.equal(resume.ok, true)
  assert.equal(resume.session.id, chat.session.id)
  const log = fs.readFileSync(path.join(dir, 'skill-review', `session-${chat.session.id}.log`), 'utf8')
  assert.match(log, /continue/)

  const afterSessions = fs.existsSync(liveSessions) ? fs.readFileSync(liveSessions, 'utf8') : ''
  assert.equal(afterSessions, beforeSessions)
  assert.equal(fs.existsSync(fakeTree), false)
})

test('shipped CLI attach spawns Codex on gpt-5.6-luna at max, not overlay scripts', () => {
  const src = fs.readFileSync(path.join(hubRoot, 'dist', 'control', 'cli.js'), 'utf8')
  assert.match(src, /gpt-5\.6-luna/)
  assert.match(src, /model_reasoning_effort/)
  assert.match(src, /'-m'/)
  assert.match(src, /spawnCodex/)
  assert.doesNotMatch(src, /manage-skill-visibility\.ps1/)
})
