import assert from 'node:assert/strict'
import test from 'node:test'
import { projectLegacyResult } from '../dist/local/compat/legacy-projector.js'

function success(commandKind, data) {
  return {
    ok: true,
    contractVersion: '1.0',
    commandKind,
    data,
    events: [],
    meta: { requestId: `legacy-${commandKind}`, replayed: false }
  }
}

test('legacy session enrichment cannot replace typed identities, state, or collections', () => {
  const lookups = []
  const legacy = new Map([
    ['typed-analyze', {
      id: 'wrong-legacy-id',
      kind: 'chat',
      status: 'failed',
      target: { kind: 'hub', id: 'wrong-target' },
      pid: 41001,
      promptFile: 'legacy-analyze.prompt',
      logFile: 'legacy-analyze.log'
    }],
    ['typed-chat', {
      id: 'another-wrong-id',
      kind: 'edit',
      status: 'waiting',
      pid: 41002,
      promptFile: 'legacy-chat.prompt'
    }],
    ['legacy-only', {
      id: 'legacy-only',
      kind: 'chat',
      status: 'running',
      pid: 41999
    }]
  ])
  const host = {
    localSessions: {
      getLegacy(id) {
        lookups.push(id)
        return legacy.get(id) || null
      },
      listLegacy() {
        throw new Error('projector must not select or expand the typed collection')
      }
    }
  }
  const typedSessions = [{
    id: 'typed-analyze',
    kind: 'analyze',
    status: 'running',
    target: { kind: 'inbox', id: 'inbox-opaque' },
    startedAt: '2026-08-21T00:00:00.000Z',
    canResume: false
  }, {
    id: 'typed-chat',
    kind: 'chat',
    status: 'queued',
    target: { kind: 'hub', id: 'hub' },
    startedAt: '2026-08-21T00:00:01.000Z',
    canResume: false
  }]

  const status = projectLegacyResult(success('status', {
    counts: { queued: 1 },
    sessions: typedSessions
  }), host)
  assert.deepEqual(status.sessions.map((session) => session.id), ['typed-analyze', 'typed-chat'])
  assert.deepEqual(status.sessions.map((session) => session.status), ['running', 'queued'])
  assert.deepEqual(status.sessions.map((session) => session.kind), ['analyze', 'chat'])
  assert.deepEqual(status.sessions[0].target, { kind: 'inbox', id: 'inbox-opaque' })
  assert.equal(status.sessions[0].pid, 41001)
  assert.equal(status.sessions[0].promptFile, 'legacy-analyze.prompt')
  assert.deepEqual(lookups, ['typed-analyze', 'typed-chat'])

  lookups.length = 0
  const listed = projectLegacyResult(success('listSessions', { sessions: [typedSessions[1]] }), host)
  assert.deepEqual(listed.sessions.map((session) => session.id), ['typed-chat'])
  assert.equal(listed.sessions[0].status, 'queued')
  assert.equal(listed.sessions[0].pid, 41002)
  assert.deepEqual(lookups, ['typed-chat'])

  lookups.length = 0
  const analyzed = projectLegacyResult(success('analyze', { session: typedSessions[0], applied: null }), host)
  assert.equal(analyzed.action, 'analyze')
  assert.equal(analyzed.session.id, 'typed-analyze')
  assert.equal(analyzed.session.kind, 'analyze')
  assert.equal(analyzed.session.status, 'running')
  assert.equal(analyzed.session.pid, 41001)
  assert.deepEqual(lookups, ['typed-analyze'])
})

test('legacy detach projection preserves the typed plan and transactional report', () => {
  const typed = {
    action: 'applyLegacyDetach',
    mode: 'legacyLinks',
    worktree: 'C:\\game-tree',
    changed: true,
    detached: true,
    plan: {
      artifacts: [
        { id: 'local-overlay', label: '.codex/local-overlay', action: 'unlink' },
        { id: 'agents-override', label: 'AGENTS.override.md', action: 'keepMissing' }
      ],
      restorePaths: ['.claude/settings.json'],
      removeClaim: true
    },
    effects: [
      { id: 'local-overlay', status: 'unlinked' },
      { id: 'agents-override', status: 'missing' }
    ],
    restoredTracked: 1,
    claim: 'removed'
  }

  assert.deepEqual(projectLegacyResult(success('applyLegacyDetach', typed)), {
    ok: true,
    action: 'detach-library',
    worktree: 'C:\\game-tree',
    attached: false,
    changed: true,
    detached: true,
    reason: undefined,
    claim: 'removed',
    plan: typed.plan,
    results: typed.effects,
    restoredTracked: 1
  })
})
