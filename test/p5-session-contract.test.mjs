import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  CURRENT_SESSION_STATUSES,
  LEGACY_SESSION_STATUSES,
  SESSION_RUNNER_ERROR_CODES,
  SESSION_RUNNER_EVENT_TYPES,
  SESSION_RUNNER_STATES,
  SESSION_TASK_VERSION,
  createMemorySessions
} from '../dist/index.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('P5 freezes one host-neutral session and runner vocabulary', () => {
  assert.equal(SESSION_TASK_VERSION, 1)
  assert.deepEqual(CURRENT_SESSION_STATUSES, [
    'queued', 'running', 'awaiting', 'failed', 'completed', 'cancelled'
  ])
  assert.deepEqual(LEGACY_SESSION_STATUSES, ['waiting'])
  assert.deepEqual(SESSION_RUNNER_STATES, [
    'starting', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'lost'
  ])
  assert.deepEqual(SESSION_RUNNER_EVENT_TYPES, [
    'runner.started', 'runner.progress', 'runner.succeeded', 'runner.failed', 'runner.cancelled'
  ])
  assert.deepEqual(SESSION_RUNNER_ERROR_CODES, [
    'RUNNER_UNAVAILABLE',
    'RUNNER_NOT_FOUND',
    'RUNNER_INVALID_STATE',
    'RUNNER_START_FAILED',
    'RUNNER_RESUME_FAILED',
    'RUNNER_CANCEL_FAILED',
    'RUNNER_PROTOCOL_ERROR'
  ])
})

test('P5 SessionRunnerPort exposes only start resume cancel status and events', () => {
  const declaration = fs.readFileSync(path.join(root, 'dist', 'application', 'ports.d.ts'), 'utf8')
  const match = declaration.match(/export interface SessionRunnerPort \{([\s\S]*?)\n\}/)
  assert.ok(match, 'SessionRunnerPort declaration')
  const contract = match[1]
  assert.deepEqual(
    [...contract.matchAll(/^\s{4}(start|resume|cancel|status|events)\(/gm)].map((entry) => entry[1]),
    ['start', 'resume', 'cancel', 'status', 'events']
  )
  assert.doesNotMatch(contract, /\b(?:pid|path|argv|codex|powershell|jobObject)\b/i)
})

test('P5 memory session projection supplies the required durable view fields', () => {
  const sessions = createMemorySessions({
    now: () => '2026-08-25T00:00:00.000Z',
    nextId: () => 'session-contract-1'
  })
  const session = sessions.start({
    kind: 'chat',
    target: { kind: 'hub', id: 'hub' },
    intent: 'contract smoke'
  })
  assert.equal(session.revision, 1)
  assert.equal(session.cancelRequested, false)
  assert.equal(session.attemptId, 'attempt-session-contract-1-1')
  assert.deepEqual(session.steps, [])
  assert.equal(session.events[0].type, 'session.queued')
  assert.deepEqual(session.capabilities, { canResume: false, canCancel: true })
})
