import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import {
  codexSessionHref,
  mapOverview,
  overviewPrimary,
  queuedSessionView,
  sessionFromEnvelope,
  versionParts
} from '../panel/lib/overview-mapping.mjs'
import { spawnHub, testHubRoot } from './helpers.mjs'

const busyState = {
  hubRoot: 'E:\\hub',
  gameRepo: 'E:\\game',
  counts: { resident: 3, adopted: 1, queued: 1, proposed: 1 },
  items: [
    {
      id: 'u-dev',
      name: 'ozdqp-development',
      status: 'queued',
      suggestion: { reason: '官方新增 2 条规则' },
      oldCommit: 'abcdef123456',
      newCommit: '9876543210aa'
    },
    {
      id: 'u-prefab',
      name: 'unity-prefab-rules',
      status: 'proposed',
      suggestion: { reason: 'Prefab 验证规则增强' }
    },
    { id: 'adopted-old', name: 'old-skill', status: 'adopted', oldCommit: '111', newCommit: '222' }
  ],
  resident: [{ name: 'ozdqp-development', path: 'skills/ozdqp-development', kind: 'resident' }],
  adopted: [{ name: 'extra', path: 'skills/adopted/extra', kind: 'adopted' }]
}

const busyWorktrees = {
  worktrees: [
    {
      name: 'main-fix',
      path: 'E:\\main-fix',
      attached: true,
      overrideLinked: true,
      officialPresent: false
    },
    {
      name: 'tools',
      path: 'E:\\tools',
      attached: true,
      overrideLinked: false,
      officialPresent: false
    },
    {
      name: 'release',
      path: 'E:\\release',
      attached: false,
      overrideLinked: false,
      officialPresent: true
    }
  ]
}

const emptyState = {
  hubRoot: 'E:\\hub',
  gameRepo: 'E:\\game',
  counts: { resident: 2, adopted: 0, queued: 0, proposed: 0 },
  items: [],
  resident: [{ name: 'a', path: 'skills/a' }],
  adopted: []
}

const emptyWorktrees = {
  worktrees: [
    {
      name: 'main-fix',
      path: 'E:\\main-fix',
      attached: true,
      overrideLinked: true,
      officialPresent: false
    },
    {
      name: 'release',
      path: 'E:\\release',
      attached: false,
      overrideLinked: false,
      officialPresent: false
    }
  ]
}

test('overview mapper builds 有事件 cards, stats, and version chips from API JSON', () => {
  const mapped = mapOverview({
    state: busyState,
    worktrees: busyWorktrees,
    health: { ok: true },
    daemon: { ok: true },
    sessions: { sessions: [] }
  })

  assert.equal(mapped.skillCount, 4)
  assert.equal(mapped.worktreeCount, 3)
  assert.equal(mapped.pending, 3)
  assert.match(mapped.stats, /4 Skills/)
  assert.match(mapped.stats, /3 Worktrees/)
  assert.match(mapped.stats, /3 待处理/)
  assert.equal(mapped.overviewPrimary, '需要你处理')
  assert.equal(overviewPrimary(mapped.attention), '需要你处理')

  const updates = mapped.attention.filter((item) => item.kind === 'update')
  const repairs = mapped.attention.filter((item) => item.kind === 'repair')
  assert.equal(updates.length, 2)
  assert.equal(repairs.length, 1)
  assert.equal(updates[0].title, 'ozdqp-development')
  assert.equal(updates[0].description, '官方新增 2 条规则')
  assert.equal(updates[0].fromVersion, 'abcdef1')
  assert.equal(updates[0].toVersion, '9876543')
  assert.equal(updates[0].showVersionChip, true)
  assert.equal(updates[1].title, 'unity-prefab-rules')
  assert.equal(updates[1].fromVersion, undefined)
  assert.equal(updates[1].toVersion, undefined)
  assert.equal(updates[1].showVersionChip, false)
  assert.equal(versionParts(busyState.items[1]).showVersionChip, false)
  assert.equal(repairs[0].title, 'tools 工作区')
  assert.equal(repairs[0].path, 'E:\\tools')

  const tools = mapped.workspaces.find((row) => row.name === 'tools')
  const main = mapped.workspaces.find((row) => row.name === 'main-fix')
  const release = mapped.workspaces.find((row) => row.name === 'release')
  assert.equal(main.statusLabel, '正常')
  assert.equal(tools.statusLabel, '需要修复')
  assert.equal(release.statusLabel, '未连接')
  assert.equal(tools.attached, true)
  assert.equal(tools.overrideLinked, false)
  assert.equal(tools.officialPresent, false)
  assert.equal(mapped.git.status, 'ok')
  assert.equal(mapped.codex.status, 'ok')
  assert.match(mapped.storage, /本机 hub/)
  assert.match(mapped.storage, /E:\\hub/)
  assert.equal(mapped.displayName, '本机')
  assert.doesNotMatch(mapped.storage, /GB/)
})

test('overview mapper 空白 path has empty attention and no 需要修复 rows', () => {
  const mapped = mapOverview({
    state: emptyState,
    worktrees: emptyWorktrees,
    health: { ok: true },
    daemon: { ok: false },
    sessions: { sessions: [] },
    userName: '  '
  })
  assert.equal(mapped.attention.length, 0)
  assert.equal(mapped.pending, 0)
  assert.equal(mapped.overviewPrimary, '一切正常')
  assert.equal(overviewPrimary(mapped.attention), '一切正常')
  assert.doesNotMatch(mapped.stats, /待处理/)
  assert.equal(mapped.skillCount, 2)
  assert.equal(mapped.worktreeCount, 2)
  assert.equal(mapped.displayName, '本机')
  for (const row of mapped.workspaces) {
    assert.notEqual(row.statusLabel, '需要修复')
    assert.ok(row.statusLabel === '正常' || row.statusLabel === '未连接')
  }
  assert.equal(mapped.git.status, 'ok')
  assert.equal(mapped.codex.status, 'ok')
  assert.equal(mapped.codex.label, '可访问')
})

test('git / codex / username / storage rules follow API fields only', () => {
  const noGit = mapOverview({
    state: { hubRoot: 'H', counts: { resident: 0, adopted: 0, queued: 0, proposed: 0 }, items: [] },
    worktrees: { worktrees: [] },
    health: { ok: true },
    daemon: { ok: false },
    sessions: null,
    sessionsReachable: false,
    userName: 'Ada'
  })
  assert.equal(noGit.git.status, 'off')
  assert.equal(noGit.codex.status, 'off')
  assert.equal(noGit.displayName, 'Ada')
  assert.equal(noGit.storage, '本机 hub · H')
  assert.equal(noGit.skillCount, 0)
})

test('queuedSessionView unwraps the real CLI {ok,action,session} envelope', () => {
  const envelope = {
    ok: true,
    action: 'attach',
    session: { id: 'sess-1', status: 'running', kind: 'attach' },
    applied: null
  }
  assert.equal(sessionFromEnvelope(envelope).id, 'sess-1')
  const view = queuedSessionView(envelope)
  assert.equal(view.label, '已入队')
  assert.equal(view.id, 'sess-1')
  assert.equal(view.status, 'running')
  assert.equal(view.attachedUnchanged, true)
  assert.notEqual(view.attached, true)
  assert.equal(codexSessionHref(envelope), '/codex?id=sess-1')
  assert.equal(codexSessionHref({ ok: true, action: 'chat', session: { id: 'abc', status: 'running' } }), '/codex?id=abc')
})

test('queuedSessionView reads a real CLI attach --no-spawn envelope', () => {
  const fakeWorktree = path.join(testHubRoot, 'fake-worktree')
  const cli = spawnHub([
    'attach',
    '--worktree',
    fakeWorktree,
    '--intent',
    'unwrap-session-envelope',
    '--no-spawn'
  ])
  assert.equal(cli.status, 0, cli.stderr)
  const payload = JSON.parse(cli.stdout)
  assert.equal(payload.ok, true)
  assert.equal(payload.action, 'attach')
  assert.ok(payload.session && payload.session.id, 'CLI session.id')
  assert.equal(sessionFromEnvelope(payload).id, payload.session.id)
  const view = queuedSessionView(payload)
  assert.equal(view.label, '已入队')
  assert.equal(view.id, payload.session.id)
  assert.equal(view.attachedUnchanged, true)
  assert.equal(codexSessionHref(payload), `/codex?id=${encodeURIComponent(payload.session.id)}`)
})
