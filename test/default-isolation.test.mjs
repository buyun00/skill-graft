import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { hubRoot, spawnHub, testHubRoot } from './helpers.mjs'

function readOptional(file) {
  return fs.existsSync(file) ? fs.readFileSync(file) : null
}

test('default CLI helper writes sessions only to its temporary fake-runner hub', () => {
  const liveSessions = path.join(hubRoot, 'skill-review', 'sessions.json')
  const liveHistory = path.join(hubRoot, 'skill-review', 'history')
  const beforeSessions = readOptional(liveSessions)
  const beforeHistory = fs.existsSync(liveHistory) ? fs.readdirSync(liveHistory).sort() : []

  const result = spawnHub([
    'attach',
    '--worktree',
    path.join(testHubRoot, 'fake-worktree'),
    '--intent',
    'default-suite-fake-runner',
    '--no-spawn'
  ])
  assert.equal(result.status, 0, result.stderr)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.session.status, 'queued')
  assert.equal(payload.session.pid, 0)
  assert.equal(path.relative(os.tmpdir(), testHubRoot).startsWith('..'), false)
  assert.equal(fs.existsSync(path.join(testHubRoot, 'skill-review', 'sessions.json')), true)

  assert.deepEqual(readOptional(liveSessions), beforeSessions)
  assert.deepEqual(fs.existsSync(liveHistory) ? fs.readdirSync(liveHistory).sort() : [], beforeHistory)
})
