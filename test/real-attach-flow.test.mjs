import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { hubRoot, spawnHub } from './helpers.mjs'

const probe = 'E:\\ozdqp-cli-attach-probe'

function parseStdout(result, label) {
  assert.equal(result.status, 0, `${label} stderr=${result.stderr}`)
  return JSON.parse(result.stdout)
}

test('real copied game worktree is attached via CLI', { timeout: 180000 }, (t) => {
  if (!fs.existsSync(path.join(probe, 'AGENTS.md')) || !fs.existsSync(path.join(probe, 'baloot_client'))) {
    t.skip(`missing probe checkout at ${probe}`)
    return
  }
  const listed = parseStdout(spawnHub(['list-worktrees']), 'list-worktrees')
  const row = listed.worktrees.find((item) => String(item.path).replace(/\//g, '\\').toLowerCase() === probe.toLowerCase())
  assert.ok(row, 'list-worktrees includes the copied game worktree')
  assert.equal(row.attached, true)
  assert.equal(row.overrideLinked, true)
  assert.equal(row.officialPresent, false)
})

test('breaking the probe override makes CLI repair-links fail', (t) => {
  const override = path.join(probe, 'AGENTS.override.md')
  if (!fs.existsSync(override)) {
    t.skip(`missing probe override at ${override}`)
    return
  }
  const previousGameRepo = spawnSync('git', ['-C', hubRoot, 'config', '--get', 'ozdqp.gameRepo'], { encoding: 'utf8' }).stdout.trim()
  t.after(() => {
    fs.rmSync(override, { force: true })
    spawnHub(['repair-links', '--worktree', probe])
    if (previousGameRepo) {
      spawnSync('git', ['-C', hubRoot, 'config', 'ozdqp.gameRepo', previousGameRepo], { encoding: 'utf8' })
    }
  })
  fs.rmSync(override, { force: true })
  fs.writeFileSync(override, 'BROKEN-OVERRIDE-NOT-HUB\n')
  const repair = spawnHub(['repair-links', '--worktree', probe])
  assert.notEqual(repair.status, 0, 'repair-links must fail when override diverged')
  assert.match(`${repair.stderr}\n${repair.stdout}`, /differs from hub/)
})

test('CLI attach without --no-spawn starts a background luna-max Codex process', () => {
  const payload = parseStdout(
    spawnHub(['attach', '--worktree', probe, '--intent', 'background-luna-max']),
    'attach spawn'
  )
  assert.equal(payload.ok, true)
  assert.equal(payload.applied, null)
  assert.equal(payload.session.model, 'gpt-5.6-luna')
  assert.equal(payload.session.effort, 'max')
  assert.equal(payload.session.status, 'running')
  assert.ok(payload.session.pid > 0, 'Codex pid')
})

test('CLI attach enqueues a luna-max Codex conversation and does not run overlay scripts itself', () => {
  const payload = parseStdout(
    spawnHub(['attach', '--worktree', probe, '--intent', 'codex-should-mount', '--no-spawn']),
    'attach enqueue'
  )
  assert.equal(payload.ok, true)
  assert.equal(payload.applied, null)
  assert.equal(payload.session.kind, 'attach')
  assert.equal(payload.session.status, 'queued')
  assert.equal(payload.session.pid, 0)
  assert.equal(payload.session.model, 'gpt-5.6-luna')
  assert.equal(payload.session.effort, 'max')
})

test('CLI decide on an unknown inbox id exits non-zero', () => {
  const result = spawnHub(['decide', '--id', 'no-such-item', '--action', 'reject'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Unknown inbox item/)
})

test('CLI ingest of a real game commit range writes inbox into an isolated hub', { timeout: 120000 }, (t) => {
  if (!fs.existsSync(path.join(probe, '.git'))) {
    t.skip('probe is not a git checkout')
    return
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ingest-real-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dir, 'skill-review'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'skill-review', 'state.json'), JSON.stringify({
    version: 1,
    items: [],
    lastIngest: null
  }))
  const old = spawnSync('git', ['-C', probe, 'rev-parse', 'HEAD~1'], { encoding: 'utf8' }).stdout.trim()
  const next = spawnSync('git', ['-C', probe, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
  if (!old || !next) {
    t.skip('could not resolve probe commits')
    return
  }
  const result = spawnHub(['ingest', '--game-repo', probe], {
    env: { HUB_ROOT: dir },
    input: `${old} ${next} refs/remotes/origin/cli-probe-test\n`
  })
  assert.equal(result.status, 0, result.stderr)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.ok, true)
  assert.equal(payload.action, 'ingest')
  assert.ok(typeof payload.output === 'string')
  const liveItems = JSON.parse(fs.readFileSync(path.join(hubRoot, 'skill-review', 'state.json'), 'utf8')).items || []
  const liveIds = new Set(liveItems.map((item) => item.id))
  const isolated = JSON.parse(fs.readFileSync(path.join(dir, 'skill-review', 'state.json'), 'utf8'))
  for (const item of isolated.items || []) {
    assert.equal(liveIds.has(item.id), false, 'isolated ingest must not write the live hub inbox')
  }
})
