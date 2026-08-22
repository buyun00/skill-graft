import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { spawnHub } from './helpers.mjs'

function isolatedRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-p3-cli-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

test('P3 CLI help freezes plan, claim, sync, migration, and rollback names', () => {
  const result = spawnHub(['--help'])
  assert.equal(result.status, 0)
  for (const command of ['plan-sync', 'claim', 'sync', 'migrate-legacy', 'rollback-legacy']) {
    assert.match(result.stdout, new RegExp(`\\b${command}\\b`))
  }
  assert.match(result.stdout, /sync --worktree <path> --plan-hash <sha256:id> \[--session-id <id>\]/)
})

test('P3 CLI rejects incomplete, duplicate, and mutually-exclusive flags before dispatch', (t) => {
  const root = isolatedRoot(t)
  const worktree = path.join(root, 'probe')
  fs.mkdirSync(worktree)
  const sha = `sha256:${'a'.repeat(64)}`
  const env = { SKILL_GRAFT_HOME: root, HUB_ROOT: root, HUB_SPAWN_CODEX: '0' }
  const cases = [
    [['plan-sync'], /requires --worktree/],
    [['plan-sync', '--worktree', worktree, '--worktree', worktree], /unsupported or duplicate/],
    [['claim', '--worktree', worktree, '--snapshot', sha, '--session-id', 'session-1'], /explicit --clear-skills/],
    [[
      'claim', '--worktree', worktree, '--snapshot', sha, '--session-id', 'session-1',
      '--skill', 'ozdqp-development', '--clear-skills'
    ], /either --skill or --clear-skills/],
    [['sync', '--worktree', worktree], /requires --worktree and --plan-hash/],
    [[
      'sync', '--worktree', worktree, '--plan-hash', sha,
      '--session-id', 'session-1', '--session-id', 'session-1'
    ], /unsupported or duplicate/],
    [['migrate-legacy', '--worktree', worktree, '--dry-run', '--commit'], /exactly one/],
    [['migrate-legacy', '--worktree', worktree, '--dry-run', '--plan-hash', sha], /does not accept/],
    [['rollback-legacy', '--worktree', worktree, '--dry-run'], /requires --worktree and --migration-id/],
    [[
      'rollback-legacy', '--worktree', worktree, '--migration-id', sha,
      '--commit'
    ], /requires --plan-hash/]
  ]
  for (const [args, expected] of cases) {
    const result = spawnHub(args, { env })
    assert.notEqual(result.status, 0, args.join(' '))
    assert.match(result.stderr, expected, args.join(' '))
  }
  assert.equal(fs.existsSync(path.join(root, 'skill-review', 'application-ledger.json')), false)
  assert.equal(fs.existsSync(path.join(root, '.skill-graft-transactions')), false)
})
