import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { createHub } from '../dist/adapters/create-hub.js'
import { createLocalUseCasePorts } from '../dist/adapters/local-use-case-ports.js'
import {
  discoverIngestCandidates,
  planIngest
} from '../dist/core/ingest-plan.js'
import {
  describeDecision,
  planDecision
} from '../dist/core/decision-plan.js'
import {
  extractInboxSuggestion,
  planAnalyzeCompletion
} from '../dist/core/analyze-completion-plan.js'
import {
  projectHubStatus,
  projectSkillInventory,
  projectWorktreeList
} from '../dist/core/query-projections.js'

const FIXED_NOW = '2030-01-02T03:04:05.000Z'
const OLD = '1'.repeat(40)
const NEXT = '2'.repeat(40)

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function queuedItem(overrides = {}) {
  return {
    id: 'item-1',
    name: 'sample-skill',
    unit: '.agents/skills/sample-skill',
    status: 'queued',
    inboxPath: 'skills/inbox/sample-skill',
    createdAt: '2029-01-01T00:00:00.000Z',
    updatedAt: '2029-01-01T00:00:00.000Z',
    ...overrides
  }
}

function stateWith(item = queuedItem()) {
  return { version: 1, items: [item], lastIngest: null }
}

function inspectDescription(state, command, worktrees = []) {
  const result = describeDecision({ state, command, attachedWorktrees: worktrees })
  assert.equal(result.decision, 'inspect')
  return result.description
}

function worktreeFact(pathname, identity, changedAtMs, ordinal, overrides = {}) {
  return {
    identity,
    ordinal,
    name: path.posix.basename(pathname),
    path: pathname,
    branch: 'main',
    head: `head-${ordinal}`,
    changedAtMs,
    exists: true,
    sameAsHub: false,
    attached: false,
    doNotAuto: false,
    officialPresent: false,
    overrideLinked: false,
    locked: false,
    prunable: false,
    ...overrides
  }
}

function worktreeSeed(pathname, identity, changedAtMs, ordinal, overrides = {}) {
  const fact = worktreeFact(pathname, identity, changedAtMs, ordinal, overrides)
  return {
    ...fact,
    recognition: {
      name: fact.name,
      exists: fact.exists,
      isDirectory: true,
      sameAsHub: fact.sameAsHub,
      explicitlyAllowed: false,
      requiredMarkers: [
        { name: 'AGENTS.md', present: true },
        { name: 'baloot_client', present: true }
      ],
      ...overrides.recognition
    }
  }
}

test('pure query projections own skill grouping and status counts', () => {
  const skills = projectSkillInventory([
    { source: 'adopted', name: 'team', path: 'skills/adopted/team', hasSkillMd: true, attached: true, ordinal: 2 },
    { source: 'resident', name: 'dev', path: 'skills/dev', hasSkillMd: true, attached: false, ordinal: 0 },
    { source: 'inbox', name: 'candidate', path: 'skills/inbox/candidate', hasSkillMd: false, attached: false, ordinal: 3 },
    { source: 'resident', name: 'git', path: 'skills/git', hasSkillMd: true, attached: true, ordinal: 1 }
  ])
  assert.deepEqual(skills.resident.map((skill) => skill.name), ['dev', 'git'])
  assert.deepEqual(skills.adopted.map((skill) => skill.name), ['team'])
  assert.deepEqual(skills.inbox.map((skill) => skill.name), ['candidate'])

  const status = projectHubStatus({
    facts: {
      hubRoot: '/hub',
      gameRepo: '/game',
      lastIngest: null,
      items: [
        queuedItem({ id: 'queued' }),
        queuedItem({ id: 'proposed', status: 'proposed' }),
        queuedItem({ id: 'terminal', status: 'rejected' })
      ]
    },
    skills,
    sessions: [{
      id: 'running',
      kind: 'chat',
      status: 'running',
      startedAt: FIXED_NOW,
      canResume: false
    }]
  })
  assert.deepEqual(status.counts, { resident: 2, adopted: 1, queued: 1, proposed: 1 })
  assert.deepEqual(status.sessions.map((session) => session.id), ['running'])
})

test('pure worktree projection recognizes seeds, dedupes opaque identities, and sorts stably', () => {
  const shared = worktreeFact('/shared-first', 'tree:shared', 40, 3)
  const facts = {
    scanRoots: ['/scan'],
    rules: { exclude: ['excluded'], require: ['AGENTS.md', 'baloot_client'], paths: ['/explicit'] },
    observations: [
      {
        cloneIdentity: 'clone:a',
        cloneRoot: '/clone-a',
        seed: worktreeSeed('/seed-a', 'tree:seed-a', 10, 0),
        listed: [
          worktreeFact('/Root', 'tree:Root', 50, 1),
          worktreeFact('/root', 'tree:root', 50, 2),
          shared
        ]
      },
      {
        cloneIdentity: 'clone:bad',
        cloneRoot: '/clone-bad',
        seed: worktreeSeed('/foreign', 'tree:foreign', 100, 4, {
          recognition: {
            requiredMarkers: [
              { name: 'AGENTS.md', present: false },
              { name: 'baloot_client', present: false }
            ]
          }
        }),
        listed: [worktreeFact('/must-not-leak', 'tree:leak', 200, 5)]
      },
      {
        cloneIdentity: 'clone:a',
        cloneRoot: '/clone-a-duplicate',
        seed: worktreeSeed('/seed-b', 'tree:seed-b', 20, 6),
        listed: [worktreeFact('/ignored-duplicate-clone-list', 'tree:ignored', 300, 7)]
      },
      {
        cloneIdentity: 'clone:b',
        cloneRoot: '/clone-b',
        seed: worktreeSeed('/explicit', 'tree:explicit', 15, 8, {
          recognition: { explicitlyAllowed: true, requiredMarkers: [] }
        }),
        listed: [
          worktreeFact('/shared-second', 'tree:shared', 400, 9),
          worktreeFact('/older', 'tree:older', 5, 10)
        ]
      }
    ]
  }
  const projected = projectWorktreeList(facts)
  assert.deepEqual(projected.scanRoots, ['/scan'])
  assert.deepEqual(projected.worktrees.map((tree) => tree.path), [
    '/Root',
    '/root',
    '/shared-first',
    '/seed-b',
    '/explicit',
    '/seed-a',
    '/older'
  ])
  assert.equal(projected.worktrees.some((tree) => tree.path === '/must-not-leak'), false)
  assert.equal(projected.worktrees.some((tree) => tree.path === '/ignored-duplicate-clone-list'), false)
  assert.equal(projected.worktrees.filter((tree) => tree.path.toLowerCase() === '/root').length, 2)
  assert.equal(projected.worktrees.find((tree) => tree.path === '/shared-first').cloneRoot, '/clone-a')
})

test('pure analyze completion plan parses host-neutral facts and applies only eligible inbox transitions', () => {
  const suggestion = { action: 'reject', target: '', reason: 'not reusable', confidence: 'high' }
  const state = {
    version: 1,
    items: [
      queuedItem({ id: 'queued' }),
      queuedItem({ id: 'same', status: 'proposed', suggestion }),
      queuedItem({ id: 'changed', status: 'proposed', suggestion: { action: 'adopt' } }),
      queuedItem({ id: 'terminal', status: 'adopted' })
    ],
    lastIngest: null
  }
  const before = clone(state)
  const fact = {
    sessionId: 'analyze-1',
    outcome: 'succeeded',
    output: `model prelude\n\`\`\`json\n${JSON.stringify(suggestion)}\n\`\`\`\nignored tail`,
    inboxIds: []
  }
  assert.deepEqual(extractInboxSuggestion(fact.output), suggestion)
  const result = planAnalyzeCompletion({ state, fact, now: FIXED_NOW })
  assert.equal(result.decision, 'apply')
  assert.deepEqual(state, before, 'Core plan must not mutate observed state')
  assert.deepEqual(result.plan.changedItemIds, ['queued', 'changed'])
  assert.equal(result.plan.nextState.items.find((item) => item.id === 'queued').status, 'proposed')
  assert.deepEqual(result.plan.nextState.items.find((item) => item.id === 'changed').suggestion, suggestion)
  assert.equal(result.plan.nextState.items.find((item) => item.id === 'terminal').status, 'adopted')
  assert.deepEqual(planAnalyzeCompletion({ state: result.plan.nextState, fact, now: FIXED_NOW }), {
    decision: 'noop', reason: 'no-change'
  })
  assert.deepEqual(planAnalyzeCompletion({ state, fact: { ...fact, outcome: 'failed' }, now: FIXED_NOW }), {
    decision: 'noop', reason: 'not-succeeded'
  })
  assert.deepEqual(planAnalyzeCompletion({ state, fact: { ...fact, output: 'not json' }, now: FIXED_NOW }), {
    decision: 'noop', reason: 'invalid-output'
  })
})

test('pure ingest discovery owns transaction filtering, watched units, rename destination, dedupe, and ordering', () => {
  const discovery = discoverIngestCandidates({
    gameRepo: 'E:/game',
    transactions: [
      {
        old: OLD,
        next: NEXT,
        ref: 'refs/heads/main',
        oldExists: true,
        nextExists: true,
        changes: [{ status: 'M', path: 'AGENTS.md' }]
      },
      {
        old: '0'.repeat(40),
        next: NEXT,
        ref: 'refs/remotes/origin/main',
        oldExists: true,
        nextExists: true,
        changes: [{ status: 'M', path: 'CLAUDE.md' }]
      },
      {
        old: OLD,
        next: NEXT,
        ref: 'refs/remotes/origin/missing',
        oldExists: false,
        nextExists: true,
        changes: [{ status: 'M', path: 'AGENTS.md' }]
      },
      {
        old: OLD,
        next: NEXT,
        ref: 'refs/remotes/origin/main',
        oldExists: true,
        nextExists: true,
        changes: [
          {
            status: 'R100',
            previousPath: '.agents/skills/old-skill/SKILL.md',
            path: '.codex/skills/new-skill/SKILL.md'
          },
          { status: 'M', path: '.codex/skills/new-skill/reference.md' },
          { status: 'M', path: 'AGENTS.md' },
          { status: 'M', path: 'src/unwatched.ts' }
        ]
      },
      {
        old: NEXT,
        next: '3'.repeat(40),
        ref: 'refs/remotes/origin/main',
        oldExists: true,
        nextExists: true,
        changes: [{ status: 'M', path: 'src/only-unwatched.ts' }]
      }
    ]
  })

  assert.deepEqual(discovery.candidates.map((candidate) => ({
    key: candidate.key,
    name: candidate.name,
    prefix: candidate.prefix,
    isSkill: candidate.isSkill,
    idMaterial: candidate.idMaterial
  })), [
    {
      key: '.codex/skills/new-skill',
      name: 'new-skill',
      prefix: '.codex/skills/new-skill',
      isSkill: true,
      idMaterial: `refs/remotes/origin/main|${NEXT}|.codex/skills/new-skill`
    },
    {
      key: 'AGENTS.md',
      name: 'AGENTS.md',
      prefix: 'AGENTS.md',
      isSkill: false,
      idMaterial: `refs/remotes/origin/main|${NEXT}|AGENTS.md`
    }
  ])
  assert.deepEqual(discovery.lastIngest, {
    ref: 'refs/remotes/origin/main',
    old: NEXT,
    new: '3'.repeat(40),
    gameRepo: 'E:/game'
  })
})

test('pure ingest plan skips existing ids, creates immutable state/effects/history, and accepts omitted duplicate bytes', () => {
  const discovery = discoverIngestCandidates({
    gameRepo: 'E:/game',
    transactions: [{
      old: OLD,
      next: NEXT,
      ref: 'refs/remotes/origin/main',
      oldExists: true,
      nextExists: true,
      changes: [
        { status: 'M', path: '.agents/skills/alpha/SKILL.md' },
        { status: 'M', path: 'AGENTS.md' }
      ]
    }]
  })
  const original = {
    version: 1,
    items: [queuedItem({ id: 'existing-alpha' })],
    lastIngest: null
  }
  const before = clone(original)
  const result = planIngest({
    state: original,
    gameRepo: 'E:/game',
    discovery,
    snapshots: [
      { id: 'existing-alpha', candidate: discovery.candidates[0] },
      {
        id: 'agents-item',
        candidate: discovery.candidates[1],
        files: [{ path: 'AGENTS.md', content: '# agents\n' }]
      }
    ],
    now: FIXED_NOW,
    historyId: 'ingest-history-1'
  })

  assert.equal(result.decision, 'apply')
  assert.deepEqual(original, before)
  assert.equal(result.plan.createdItems.length, 1)
  assert.deepEqual(result.plan.createdItems[0], {
    id: 'agents-item',
    name: 'AGENTS.md',
    unit: 'AGENTS.md',
    status: 'queued',
    sourceRef: 'refs/remotes/origin/main',
    oldCommit: OLD,
    newCommit: NEXT,
    inboxPath: 'skills/inbox/AGENTS.md',
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    suggestion: { action: '', target: '', reason: '', confidence: '' }
  })
  assert.deepEqual(result.plan.effects, [{
    kind: 'replace-tree',
    target: { scope: 'hub', segments: ['skills', 'inbox', 'AGENTS.md'] },
    files: [{ segments: ['AGENTS.md'], content: '# agents\n' }]
  }])
  assert.deepEqual(result.plan.history, {
    id: 'ingest-history-1',
    record: { type: 'ingest', count: 1, lastIngest: discovery.lastIngest }
  })
  assert.equal(result.plan.nextState.items.length, 2)
  assert.deepEqual(result.plan.nextState.lastIngest, discovery.lastIngest)
})

test('pure ingest plan advances lastIngest without fabricating item/history effects', () => {
  const state = stateWith()
  const result = planIngest({
    state,
    gameRepo: 'E:/game',
    discovery: {
      candidates: [],
      lastIngest: { ref: 'refs/remotes/origin/main', old: OLD, new: NEXT, gameRepo: 'E:/game' }
    },
    snapshots: [],
    now: FIXED_NOW,
    historyId: ''
  })
  assert.equal(result.decision, 'apply')
  assert.deepEqual(result.plan.effects, [])
  assert.deepEqual(result.plan.createdItems, [])
  assert.equal(result.plan.history, undefined)
  assert.equal(result.plan.nextState.items[0].id, 'item-1')
  assert.equal(result.plan.nextState.lastIngest.new, NEXT)
})

test('pure ingest plan rejects missing/mismatched snapshots and unsafe paths', () => {
  const discovery = discoverIngestCandidates({
    gameRepo: 'E:/game',
    transactions: [{
      old: OLD,
      next: NEXT,
      ref: 'refs/remotes/origin/main',
      oldExists: true,
      nextExists: true,
      changes: [{ status: 'M', path: '.agents/skills/alpha/SKILL.md' }]
    }]
  })
  const base = {
    state: { items: [], lastIngest: null },
    gameRepo: 'E:/game',
    discovery,
    now: FIXED_NOW,
    historyId: 'history-1'
  }
  assert.deepEqual(planIngest({ ...base, snapshots: [] }), {
    decision: 'rejected',
    code: 'PORT_FAILURE',
    reason: 'snapshot missing for ingest unit: .agents/skills/alpha'
  })
  assert.equal(planIngest({
    ...base,
    snapshots: [{
      id: 'alpha-item',
      candidate: discovery.candidates[0],
      files: [{ path: '../escape', content: 'bad' }]
    }]
  }).code, 'INVALID_ARGUMENT')
  assert.equal(planIngest({
    ...base,
    snapshots: [{
      id: 'alpha-item',
      candidate: { ...discovery.candidates[0], next: '4'.repeat(40) },
      files: [{ path: 'SKILL.md', content: 'body' }]
    }]
  }).code, 'PORT_FAILURE')
})

test('pure ingest plan preserves Unicode/space skill names and an empty deletion snapshot', () => {
  const discovery = discoverIngestCandidates({
    gameRepo: 'E:/game',
    transactions: [{
      old: OLD,
      next: NEXT,
      ref: 'refs/remotes/origin/main',
      oldExists: true,
      nextExists: true,
      changes: [{ status: 'D', path: '.agents/skills/技能 @1/SKILL.md' }]
    }]
  })
  const result = planIngest({
    state: { items: [], lastIngest: null },
    gameRepo: 'E:/game',
    discovery,
    snapshots: [{ id: 'unicode-item', candidate: discovery.candidates[0], files: [] }],
    now: FIXED_NOW,
    historyId: 'unicode-history'
  })
  assert.equal(result.decision, 'apply')
  assert.equal(result.plan.createdItems[0].name, '技能 @1')
  assert.deepEqual(result.plan.effects[0], {
    kind: 'replace-tree',
    target: { scope: 'hub', segments: ['skills', 'inbox', '技能 @1'] },
    files: []
  })
})

test('pure decision description rejects invalid requests and makes terminal replay a no-op', () => {
  const state = stateWith()
  assert.equal(describeDecision({
    state,
    command: { id: 'missing', action: 'reject' },
    attachedWorktrees: []
  }).code, 'NOT_FOUND')
  assert.equal(describeDecision({
    state,
    command: { id: 'item-1', action: 'merge' },
    attachedWorktrees: []
  }).code, 'INVALID_INBOX_TRANSITION')
  assert.equal(describeDecision({
    state,
    command: { id: 'item-1', action: 'merge', mergeTarget: '../escape' },
    attachedWorktrees: []
  }).code, 'INVALID_ARGUMENT')
  assert.equal(describeDecision({
    state,
    command: { id: 'item-1', action: 'other' },
    attachedWorktrees: []
  }).code, 'INVALID_ARGUMENT')

  const terminal = stateWith(queuedItem({ status: 'adopted', adoptedPath: 'skills/adopted/sample-skill' }))
  const replay = describeDecision({
    state: terminal,
    command: { id: 'item-1', action: 'adopt' },
    attachedWorktrees: ['/tree/ignored']
  })
  assert.deepEqual(replay, {
    decision: 'noop',
    result: { action: 'adopt', item: terminal.items[0], linked: [], skipped: [] }
  })
})

test('pure adopt decision maps facts to move/link effects and stable per-tree outcomes', () => {
  const state = stateWith()
  const before = clone(state)
  const description = inspectDescription(
    state,
    { id: 'item-1', action: 'adopt', note: 'approved' },
    ['/tree/link', '/tree/ok', '/tree/missing', '/tree/conflict']
  )
  assert.deepEqual(description.inspectionRequests.map((request) => request.key), [
    'source',
    'destination',
    'tree:0:root',
    'tree:0:link',
    'tree:1:root',
    'tree:1:link',
    'tree:2:root',
    'tree:2:link',
    'tree:3:root',
    'tree:3:link'
  ])
  const result = planDecision({
    description,
    now: FIXED_NOW,
    historyId: 'decision-history-1',
    facts: [
      { key: 'source', exists: true, actualKind: 'directory' },
      { key: 'destination', exists: false },
      { key: 'tree:0:root', exists: true, actualKind: 'directory' },
      { key: 'tree:0:link', exists: false },
      { key: 'tree:1:root', exists: true, actualKind: 'directory' },
      { key: 'tree:1:link', exists: true, actualKind: 'directory', linkedToExpected: true },
      { key: 'tree:2:root', exists: false },
      { key: 'tree:2:link', exists: false },
      { key: 'tree:3:root', exists: true, actualKind: 'directory' },
      { key: 'tree:3:link', exists: true, actualKind: 'directory', linkedToExpected: false }
    ]
  })

  assert.equal(result.decision, 'apply')
  assert.deepEqual(state, before)
  assert.deepEqual(result.plan.effects, [
    {
      kind: 'move',
      source: { scope: 'hub', segments: ['skills', 'inbox', 'sample-skill'] },
      target: { scope: 'hub', segments: ['skills', 'adopted', 'sample-skill'] }
    },
    {
      kind: 'link',
      source: { scope: 'hub', segments: ['skills', 'adopted', 'sample-skill'] },
      target: { scope: 'worktree', worktree: '/tree/link', segments: ['.agents', 'skills', 'sample-skill'] },
      artifactKind: 'directory'
    }
  ])
  assert.deepEqual(result.plan.linked, [
    { worktree: '/tree/link', status: 'linked' },
    { worktree: '/tree/ok', status: 'ok' }
  ])
  assert.deepEqual(result.plan.skipped, [
    { worktree: '/tree/missing', reason: 'missing' },
    { worktree: '/tree/conflict', reason: 'already points elsewhere' }
  ])
  assert.deepEqual(result.plan.item, {
    ...state.items[0],
    status: 'adopted',
    adoptedPath: 'skills/adopted/sample-skill',
    note: 'approved',
    updatedAt: FIXED_NOW
  })
  assert.deepEqual(result.plan.history, {
    id: 'decision-history-1',
    record: { type: 'decide', id: 'item-1', action: 'adopt', note: 'approved' }
  })
})

test('pure adopt decision blocks absent source, existing destination, and incomplete fact sets', () => {
  const description = inspectDescription(stateWith(), { id: 'item-1', action: 'adopt' })
  assert.equal(planDecision({
    description,
    now: FIXED_NOW,
    historyId: 'history-1',
    facts: [{ key: 'source', exists: false }, { key: 'destination', exists: false }]
  }).code, 'NOT_FOUND')
  assert.equal(planDecision({
    description,
    now: FIXED_NOW,
    historyId: 'history-1',
    facts: [{ key: 'source', exists: true }, { key: 'destination', exists: true }]
  }).code, 'CONFLICT_CONTENT')
  assert.equal(planDecision({
    description,
    now: FIXED_NOW,
    historyId: 'history-1',
    facts: [{ key: 'source', exists: true, actualKind: 'file' }, { key: 'destination', exists: false }]
  }).code, 'CONFLICT_CONTENT')
  assert.equal(planDecision({
    description,
    now: FIXED_NOW,
    historyId: 'history-1',
    facts: [{ key: 'source', exists: true }]
  }).code, 'PORT_FAILURE')
})

test('pure merge and reject decisions own status/history/removal policy', () => {
  const mergeDescription = inspectDescription(
    stateWith(),
    { id: 'item-1', action: 'merge', mergeTarget: ' skills/ozdqp-development ', note: 'fold in' }
  )
  const merge = planDecision({
    description: mergeDescription,
    now: FIXED_NOW,
    historyId: 'merge-history',
    facts: [
      { key: 'source', exists: true, actualKind: 'directory' },
      { key: 'merge-target', exists: true, actualKind: 'directory' }
    ]
  })
  assert.equal(merge.decision, 'apply')
  assert.equal(merge.plan.item.status, 'merged-into-3skill')
  assert.equal(merge.plan.item.mergeTarget, 'skills/ozdqp-development')
  assert.deepEqual(merge.plan.effects, [{
    kind: 'remove',
    target: { scope: 'hub', segments: ['skills', 'inbox', 'sample-skill'] }
  }])
  assert.deepEqual(merge.plan.history.record, {
    type: 'decide',
    id: 'item-1',
    action: 'merge',
    note: 'fold in',
    mergeTarget: 'skills/ozdqp-development'
  })
  assert.equal(planDecision({
    description: mergeDescription,
    now: FIXED_NOW,
    historyId: 'merge-history',
    facts: [{ key: 'source', exists: false }, { key: 'merge-target', exists: false }]
  }).code, 'NOT_FOUND')

  const rejectDescription = inspectDescription(stateWith(), { id: 'item-1', action: 'reject' })
  const rejectedWithMissingBytes = planDecision({
    description: rejectDescription,
    now: FIXED_NOW,
    historyId: 'reject-history',
    facts: [{ key: 'source', exists: false }]
  })
  assert.equal(rejectedWithMissingBytes.decision, 'apply')
  assert.equal(rejectedWithMissingBytes.plan.item.status, 'rejected')
  assert.deepEqual(rejectedWithMissingBytes.plan.effects, [])
})

test('Core planners are host-free and the local effect adapter has no command-action branches', () => {
  for (const file of ['src/core/ingest-plan.ts', 'src/core/decision-plan.ts', 'src/core/use-case-plan-types.ts']) {
    const source = fs.readFileSync(file, 'utf8')
    assert.doesNotMatch(source, /HubContext|\bctx\b|from ['"]node:|\bprocess\b|\bfetch\b/)
    assert.doesNotMatch(source, /\.(?:fs|git|persist|link)\b/)
  }
  const adapter = fs.readFileSync('src/adapters/local-use-case-ports.ts', 'utf8')
  assert.doesNotMatch(adapter, /\b(?:adopt|merge|reject)\b/i)
  assert.doesNotMatch(adapter, /(?:decision-plan|ingest-plan|policies)\.js/)
})

test('local low-level adapter persists state/history and applies only generic artifact effects', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-plan-adapter-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const hubRoot = path.join(root, 'hub')
  const worktree = path.join(root, 'tree')
  fs.mkdirSync(hubRoot, { recursive: true })
  fs.mkdirSync(worktree, { recursive: true })
  const context = createHub(hubRoot)
  const ports = createLocalUseCasePorts(context)

  const state = {
    version: 1,
    items: [queuedItem()],
    lastIngest: { ref: 'refs/remotes/origin/main', old: OLD, new: NEXT, gameRepo: root }
  }
  ports.state.writeState(state)
  assert.deepEqual(ports.state.readState(), state)
  ports.state.appendHistory({ id: 'history-1', record: { type: 'test', count: 1 } })
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(hubRoot, 'skill-review', 'history', 'history-1.json'), 'utf8')), {
    type: 'test', count: 1
  })
  assert.throws(() => ports.state.appendHistory({ id: '../escape', record: {} }), /unsafe/)
  fs.mkdirSync(path.join(hubRoot, 'overlay'), { recursive: true })
  fs.writeFileSync(path.join(hubRoot, 'overlay', 'attached-worktrees.txt'), `${worktree}\n${worktree}\n`)
  assert.deepEqual(ports.state.listAttachedWorktrees(), [worktree])

  const inbox = { scope: 'hub', segments: ['skills', 'inbox', 'alpha'] }
  const adopted = { scope: 'hub', segments: ['skills', 'adopted', 'alpha'] }
  ports.artifacts.apply([{
    kind: 'replace-tree',
    target: inbox,
    files: [
      { segments: ['SKILL.md'], content: '# Alpha\n' },
      { segments: ['references', 'one.md'], content: 'one\n' }
    ]
  }])
  assert.equal(fs.readFileSync(path.join(hubRoot, 'skills', 'inbox', 'alpha', 'SKILL.md'), 'utf8'), '# Alpha\n')
  assert.deepEqual(ports.artifacts.inspect([{ key: 'inbox', target: inbox, expectedKind: 'directory' }]), [{
    key: 'inbox',
    exists: true,
    actualKind: 'directory',
    linkedToExpected: undefined,
    pointsElsewhere: undefined
  }])
  ports.artifacts.apply([{ kind: 'move', source: inbox, target: adopted }])
  ports.artifacts.apply([{
    kind: 'link',
    source: adopted,
    target: { scope: 'worktree', worktree, segments: ['.agents', 'skills', 'alpha'] },
    artifactKind: 'directory'
  }])
  const linkFacts = ports.artifacts.inspect([{
    key: 'link',
    target: { scope: 'worktree', worktree, segments: ['.agents', 'skills', 'alpha'] },
    expectedSource: adopted,
    expectedKind: 'directory'
  }])
  assert.equal(linkFacts[0].exists, true)
  assert.equal(linkFacts[0].linkedToExpected, true)
  ports.artifacts.apply([{ kind: 'unlink', target: { scope: 'worktree', worktree, segments: ['.agents', 'skills', 'alpha'] } }])
  ports.artifacts.apply([{ kind: 'remove', target: adopted }])
  assert.equal(fs.existsSync(path.join(hubRoot, 'skills', 'adopted', 'alpha')), false)

  const outside = path.join(root, 'outside')
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside\n')
  context.link.linkDirectory(path.join(hubRoot, 'escape'), outside)
  assert.throws(() => ports.artifacts.inspect([{
    key: 'escape',
    target: { scope: 'hub', segments: ['escape', 'secret.txt'] }
  }]), /linked ancestor/)

  fs.rmSync(path.join(hubRoot, 'overlay'), { recursive: true, force: true })
  fs.writeFileSync(path.join(outside, 'attached-worktrees.txt'), `${worktree}\n`)
  context.link.linkDirectory(path.join(hubRoot, 'overlay'), outside)
  assert.throws(() => ports.state.listAttachedWorktrees(), /linked ancestor/)
})

test('local Git facts adapter reports revisions, rename destinations, trees, and empty blobs', (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-git-facts-'))
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    return result.stdout.trim()
  }
  git('init')
  git('config', 'user.name', 'Skill Graft Test')
  git('config', 'user.email', 'skill-graft@example.invalid')
  fs.mkdirSync(path.join(repo, '.agents', 'skills', 'old-skill'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.agents', 'skills', 'old-skill', 'SKILL.md'), '# Old\n')
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), '')
  git('add', '.')
  git('commit', '-m', 'old')
  const oldRevision = git('rev-parse', 'HEAD')
  fs.mkdirSync(path.join(repo, '.codex', 'skills'), { recursive: true })
  fs.renameSync(
    path.join(repo, '.agents', 'skills', 'old-skill'),
    path.join(repo, '.codex', 'skills', 'new-skill')
  )
  fs.writeFileSync(path.join(repo, '.codex', 'skills', 'new-skill', 'reference.md'), 'reference\n')
  git('add', '-A')
  git('commit', '-m', 'new')
  const newRevision = git('rev-parse', 'HEAD')

  const ports = createLocalUseCasePorts(createHub(repo))
  assert.equal(ports.git.revisionExists(repo, oldRevision), true)
  assert.equal(ports.git.revisionExists(repo, 'f'.repeat(40)), false)
  const changes = ports.git.changedPaths({
    repo,
    oldRevision,
    newRevision,
    pathspecs: ['.agents/skills', '.codex/skills', 'AGENTS.md']
  })
  assert.ok(changes.some((change) => change.path === '.codex/skills/new-skill/SKILL.md'))
  const tree = ports.git.readTree({ repo, revision: newRevision, prefix: '.codex/skills/new-skill' })
  assert.deepEqual(tree, [
    { path: 'SKILL.md', content: '# Old\n' },
    { path: 'reference.md', content: 'reference\n' }
  ])
  assert.equal(ports.git.readBlob({ repo, revision: newRevision, path: 'AGENTS.md' }), '')
  assert.equal(ports.git.readBlob({ repo, revision: newRevision, path: 'missing.md' }), null)
})
