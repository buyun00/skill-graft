import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import test from 'node:test'
import {
  createHub,
  decide,
  enqueueSession,
  extractSuggestion,
  extractCodexSessionId,
  finalizeSession,
  findSession,
  getStatus,
  ingest,
  isClientCheckout,
  isEphemeralPath,
  listSkills,
  listWorktrees,
  markSessionSpawned,
  parseWorktreePorcelain,
  reapSessions,
  repairLinks,
  RESIDENT_SKILLS,
  sessionExitFile
} from '../dist/index.js'
import { hubRoot, makeFs } from './helpers.mjs'

function fakeGit(handlers) {
  return {
    configGet: handlers.configGet || (() => null),
    output: handlers.output || (() => '')
  }
}

test('C1 parseWorktreePorcelain reads a branch plus detached/locked/prunable', () => {
  const trees = parseWorktreePorcelain([
    'worktree E:/ozdqp-main-fix',
    'HEAD abcdef',
    'branch refs/heads/main-fix',
    '',
    'worktree E:/other',
    'HEAD fedcba',
    'detached',
    'locked',
    'prunable',
    ''
  ].join('\n'))
  assert.equal(trees.length, 2)
  assert.equal(trees[0].path, 'E:/ozdqp-main-fix')
  assert.equal(trees[0].branch, 'main-fix')
  assert.equal(trees[0].head, 'abcdef')
  assert.equal(trees[1].branch, '(detached)')
  assert.equal(trees[1].locked, true)
  assert.equal(trees[1].prunable, true)
})

test('C2 isEphemeralPath hits the four temp markers and not a normal drive path', () => {
  assert.equal(isEphemeralPath('D:\\temp\\wt'), true)
  assert.equal(isEphemeralPath('C:\\Users\\win11\\AppData\\Local\\Temp\\wt'), true)
  assert.equal(isEphemeralPath('C:\\Users\\win11\\.codex\\worktrees\\abc'), true)
  assert.equal(isEphemeralPath('C:\\Users\\win11\\.config\\cursor\\worktrees\\xyz'), true)
  assert.equal(isEphemeralPath('E:\\ozdqp-main-fix'), false)
})

test('C3 isClientCheckout default rules require AGENTS.md + baloot_client and skip hub/excluded/.partial-', () => {
  const root = path.join(os.tmpdir(), 'hub-client-fake')
  const game = path.join(root, 'ozdqp-main-fix')
  const hubDir = path.join(root, 'ozdqp-skill-hub')
  const overlayKit = path.join(root, 'ozdqp-skill-overlay-kit')
  const partial = path.join(root, 'game.partial-123')
  const noAgents = path.join(root, 'no-agents')
  const noBaloot = path.join(root, 'no-baloot')
  const markClient = (dir) => ({
    [path.resolve(dir)]: { dir: true },
    [path.resolve(dir, 'AGENTS.md')]: { text: 'x' },
    [path.resolve(dir, 'baloot_client')]: { dir: true }
  })
  const files = {
    ...markClient(game),
    ...markClient(hubDir),
    ...markClient(overlayKit),
    ...markClient(partial),
    [path.resolve(noAgents)]: { dir: true },
    [path.resolve(noAgents, 'baloot_client')]: { dir: true },
    [path.resolve(noBaloot)]: { dir: true },
    [path.resolve(noBaloot, 'AGENTS.md')]: { text: 'x' }
  }
  const ctx = createHub(hubDir, { fs: makeFs(files) })
  assert.equal(isClientCheckout(ctx, game), true)
  assert.equal(isClientCheckout(ctx, ctx.hubRoot), false)
  assert.equal(isClientCheckout(ctx, overlayKit), false)
  assert.equal(isClientCheckout(ctx, partial), false)
  assert.equal(isClientCheckout(ctx, noAgents), false)
  assert.equal(isClientCheckout(ctx, noBaloot), false)
})

test('C3b checkout-rules can recognize .git + custom file and still exclude names', () => {
  const root = path.join(os.tmpdir(), 'hub-rules-fake')
  const hubDir = path.join(root, 'hub')
  const custom = path.join(root, 'tiny-git')
  const excluded = path.join(root, 'ozdqp-skill-hub')
  const agentsOnly = path.join(root, 'agents-only')
  const files = {
    [path.resolve(hubDir, 'overlay', 'checkout-rules.txt')]: {
      text: 'exclude ozdqp-skill-hub\nrequire .git\nrequire custom.marker\n'
    },
    [path.resolve(custom)]: { dir: true },
    [path.resolve(custom, '.git')]: { dir: true },
    [path.resolve(custom, 'custom.marker')]: { text: 'x' },
    [path.resolve(excluded)]: { dir: true },
    [path.resolve(excluded, '.git')]: { dir: true },
    [path.resolve(excluded, 'custom.marker')]: { text: 'x' },
    [path.resolve(agentsOnly)]: { dir: true },
    [path.resolve(agentsOnly, 'AGENTS.md')]: { text: 'x' }
  }
  const ctx = createHub(hubDir, { fs: makeFs(files) })
  assert.equal(isClientCheckout(ctx, custom), true)
  assert.equal(isClientCheckout(ctx, excluded), false)
  assert.equal(isClientCheckout(ctx, agentsOnly), false)
})

test('C4 getStatus reads this hub: 3 resident SKILL.md, inbox has queued names, counts match items', () => {
  const status = getStatus(createHub(hubRoot))
  assert.equal(status.hubRoot, hubRoot)
  assert.deepEqual(status.resident.map((node) => node.name), [...RESIDENT_SKILLS])
  assert.ok(status.resident.every((node) => node.hasSkillMd))
  const queued = status.items.filter((item) => item.status === 'queued')
  assert.equal(status.counts.queued, queued.length)
  const queuedNames = [...new Set(queued.map((item) => item.name))]
  for (const name of queuedNames) {
    assert.ok(status.inbox.some((node) => node.name === name), `inbox should include queued name ${name}`)
  }
})

test('C5 listWorktrees marks attached and overrideLinked from list + inode/realpath', () => {
  const root = path.join(os.tmpdir(), 'hub-scan-fake')
  const hub = path.join(root, 'hub')
  const game = path.join(root, 'ozdqp-main-fix')
  const files = {
    [path.resolve(hub, 'overlay', 'scan-roots.txt')]: { text: `${root}\n` },
    [path.resolve(hub, 'overlay', 'attached-worktrees.txt')]: { text: `${game}\n` },
    [path.resolve(hub, 'overlay', 'do-not-auto-attach.txt')]: { text: '' },
    [path.resolve(hub, 'AGENTS.override.md')]: { text: 'override', id: { ino: 11, dev: 1 } },
    [path.resolve(root)]: { dir: true, entries: ['ozdqp-main-fix'] },
    [path.resolve(game)]: { dir: true, mtimeMs: 50 },
    [path.resolve(game, 'AGENTS.md')]: { text: 'x' },
    [path.resolve(game, 'baloot_client')]: { dir: true },
    [path.resolve(game, 'AGENTS.override.md')]: {
      text: 'override',
      id: { ino: 11, dev: 1 },
      real: path.resolve(hub, 'AGENTS.override.md')
    }
  }
  const git = fakeGit({
    configGet: () => game,
    output: (_cwd, args) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') return path.join(game, '.git')
      if (args[0] === 'worktree' && args[1] === 'list') {
        return ['worktree ' + game, 'HEAD deadbeef', 'branch refs/heads/fix', ''].join('\n')
      }
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'fix\n'
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'deadbeef\n'
      return ''
    }
  })
  const result = listWorktrees(createHub(hub, { fs: makeFs(files), git }))
  assert.deepEqual(result.scanRoots, [root])
  assert.equal(result.worktrees.length, 1)
  assert.equal(result.worktrees[0].attached, true)
  assert.equal(result.worktrees[0].overrideLinked, true)
  assert.equal(result.worktrees[0].branch, 'fix')
})

test('C6 listWorktrees sorts by changedAtMs descending', () => {
  const root = path.join(os.tmpdir(), 'hub-sort-fake')
  const hub = path.join(root, 'hub')
  const older = path.join(root, 'ozdqp-old')
  const newer = path.join(root, 'ozdqp-new')
  const files = {
    [path.resolve(hub, 'overlay', 'scan-roots.txt')]: { text: `${root}\n` },
    [path.resolve(hub, 'overlay', 'attached-worktrees.txt')]: { text: '' },
    [path.resolve(hub, 'overlay', 'do-not-auto-attach.txt')]: { text: '' },
    [path.resolve(root)]: { dir: true, entries: ['ozdqp-old', 'ozdqp-new'] },
    [path.resolve(older)]: { dir: true, mtimeMs: 100 },
    [path.resolve(older, 'AGENTS.md')]: { text: 'x' },
    [path.resolve(older, 'baloot_client')]: { dir: true },
    [path.resolve(newer)]: { dir: true, mtimeMs: 500 },
    [path.resolve(newer, 'AGENTS.md')]: { text: 'x' },
    [path.resolve(newer, 'baloot_client')]: { dir: true }
  }
  const git = fakeGit({
    output: (cwd, args) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') return path.join(cwd, '.git')
      if (args[0] === 'worktree' && args[1] === 'list') {
        return ['worktree ' + cwd, 'HEAD deadbeef', 'branch refs/heads/main', ''].join('\n')
      }
      return ''
    }
  })
  const result = listWorktrees(createHub(hub, { fs: makeFs(files), git }))
  assert.equal(result.worktrees.length, 2)
  assert.deepEqual(result.worktrees.map((tree) => tree.path), [newer, older])
  assert.ok(result.worktrees[0].changedAtMs > result.worktrees[1].changedAtMs)
})

test('C7 unreadable scan root is skipped and listWorktrees still returns', () => {
  const root = path.join(os.tmpdir(), 'hub-unreadable-fake')
  const hub = path.join(root, 'hub')
  const denied = path.join(root, 'denied')
  const allowed = path.join(root, 'allowed')
  const game = path.join(allowed, 'ozdqp-game')
  const files = {
    [path.resolve(hub, 'overlay', 'scan-roots.txt')]: {
      text: `${path.resolve(denied)}\n${path.resolve(allowed)}\n`
    },
    [path.resolve(hub, 'overlay', 'attached-worktrees.txt')]: { text: '' },
    [path.resolve(hub, 'overlay', 'do-not-auto-attach.txt')]: { text: '' },
    [path.resolve(denied)]: { dir: true, readDirError: 'EACCES' },
    [path.resolve(allowed)]: { dir: true, entries: ['ozdqp-game'] },
    [path.resolve(game)]: { dir: true, mtimeMs: 20 },
    [path.resolve(game, 'AGENTS.md')]: { text: 'x' },
    [path.resolve(game, 'baloot_client')]: { dir: true }
  }
  const git = fakeGit({
    output: (cwd, args) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') return path.join(cwd, '.git')
      if (args[0] === 'worktree' && args[1] === 'list') {
        return ['worktree ' + cwd, 'HEAD cafe', 'branch refs/heads/main', ''].join('\n')
      }
      return ''
    }
  })
  const result = listWorktrees(createHub(hub, { fs: makeFs(files), git }))
  assert.equal(result.worktrees.length, 1)
  assert.equal(result.worktrees[0].path, game)
})

test('C8 empty gameRepo leaves resident and adopted attached false', () => {
  const hub = path.join(os.tmpdir(), 'hub-norepo-fake')
  const files = {
    [path.resolve(hub, 'skills', 'ozdqp-development')]: { dir: true },
    [path.resolve(hub, 'skills', 'ozdqp-development', 'SKILL.md')]: { text: 'x' },
    [path.resolve(hub, 'skills', 'ozdqp-ui-development')]: { dir: true },
    [path.resolve(hub, 'skills', 'ozdqp-ui-development', 'SKILL.md')]: { text: 'x' },
    [path.resolve(hub, 'skills', 'ozdqp-git-workflow')]: { dir: true },
    [path.resolve(hub, 'skills', 'ozdqp-git-workflow', 'SKILL.md')]: { text: 'x' },
    [path.resolve(hub, 'skills', 'adopted')]: { dir: true, entries: ['extra'] },
    [path.resolve(hub, 'skills', 'adopted', 'extra')]: { dir: true },
    [path.resolve(hub, 'skills', 'adopted', 'extra', 'SKILL.md')]: { text: 'x' },
    [path.resolve(hub, 'skills', 'inbox')]: { dir: true, entries: [] },
    [path.resolve(hub, 'skill-review', 'state.json')]: {
      text: JSON.stringify({ version: 1, items: [], lastIngest: null })
    }
  }
  const status = getStatus(createHub(hub, { fs: makeFs(files), git: fakeGit({ configGet: () => null }) }))
  assert.equal(status.gameRepo, null)
  assert.ok(status.resident.length > 0)
  assert.ok(status.adopted.length > 0)
  assert.ok(status.resident.every((node) => node.attached === false))
  assert.ok(status.adopted.every((node) => node.attached === false))
})

test('C9 inbox nodes are kind inbox and never attached', () => {
  const hub = path.join(os.tmpdir(), 'hub-inbox-fake')
  const files = {
    [path.resolve(hub, 'skills', 'inbox')]: { dir: true, entries: ['queued-skill'] },
    [path.resolve(hub, 'skills', 'inbox', 'queued-skill')]: { dir: true },
    [path.resolve(hub, 'skills', 'inbox', 'queued-skill', 'SKILL.md')]: { text: 'x' }
  }
  const skills = listSkills(createHub(hub, { fs: makeFs(files), git: fakeGit({ configGet: () => 'E:\\game' }) }), 'E:\\game')
  assert.equal(skills.inbox.length, 1)
  assert.equal(skills.inbox[0].kind, 'inbox')
  assert.equal(skills.inbox[0].attached, false)
  assert.equal(skills.inbox[0].name, 'queued-skill')
})

function sessionHub(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-session-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dir, 'skill-review', 'history'), { recursive: true })
  const ctx = createHub(dir)
  return { dir, ctx }
}

test('fake process exit 0 finalizes sessions.json to waiting with exitCode, codexSessionId, and summary', (t) => {
  const { ctx } = sessionHub(t)
  const session = enqueueSession(ctx, { kind: 'attach', worktree: 'C:\\hub-session-fake-tree', intent: 'close-loop' })
  markSessionSpawned(ctx, session, 424201)
  ctx.fs.writeText(session.logFile, 'codex\nsession id: 0123456789abcdef0123456789abcdef\n')
  ctx.fs.writeText(session.lastFile, '验收摘要: attached=true overrideLinked=true officialPresent=false\n')
  ctx.fs.writeText(sessionExitFile(ctx, session), '0\n')
  const finalized = reapSessions(ctx, () => false)
  assert.equal(finalized.length, 1)
  assert.equal(finalized[0].status, 'waiting')
  assert.equal(finalized[0].exitCode, 0)
  assert.equal(finalized[0].codexSessionId, '0123456789abcdef0123456789abcdef')
  assert.match(finalized[0].summary || '', /attached=true/)
  const stored = findSession(ctx, session.id)
  assert.equal(stored.status, 'waiting')
  assert.equal(stored.exitCode, 0)
  assert.equal(extractCodexSessionId(ctx.fs.readText(session.logFile)), stored.codexSessionId)
})

test('fake process nonzero exit finalizes sessions.json to failed', (t) => {
  const { ctx } = sessionHub(t)
  const session = enqueueSession(ctx, { kind: 'chat', intent: 'will-fail' })
  markSessionSpawned(ctx, session, 424202)
  ctx.fs.writeText(session.logFile, 'boom\n')
  ctx.fs.writeText(sessionExitFile(ctx, session), '2\n')
  const finalized = reapSessions(ctx, () => false)
  assert.equal(finalized.length, 1)
  assert.equal(finalized[0].status, 'failed')
  assert.equal(finalized[0].exitCode, 2)
  assert.match(finalized[0].error || '', /2/)
  const stored = findSession(ctx, session.id)
  assert.equal(stored.status, 'failed')
  assert.equal(stored.exitCode, 2)
})

test('finalizeSession writes waiting on exit 0 without treating a live pid as settled', (t) => {
  const { ctx } = sessionHub(t)
  const session = enqueueSession(ctx, { kind: 'detach', worktree: 'C:\\hub-session-fake-tree', intent: 'done' })
  markSessionSpawned(ctx, session, 424203)
  ctx.fs.writeText(session.lastFile, '验收摘要: detached\n')
  const stillRunning = reapSessions(ctx, (pid) => pid === 424203)
  assert.equal(stillRunning.length, 0)
  assert.equal(findSession(ctx, session.id).status, 'running')
  const done = finalizeSession(ctx, findSession(ctx, session.id), { exitCode: 0 })
  assert.equal(done.status, 'waiting')
  assert.equal(done.exitCode, 0)
  assert.match(done.summary || '', /detached/)
})

function attachedRepairHub(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-repair-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const hubDir = path.join(dir, 'hub')
  const tree = path.join(dir, 'tree')
  for (const name of RESIDENT_SKILLS) {
    fs.mkdirSync(path.join(hubDir, 'skills', name), { recursive: true })
    fs.writeFileSync(path.join(hubDir, 'skills', name, 'SKILL.md'), `${name}\n`)
  }
  fs.mkdirSync(path.join(hubDir, 'overlay'), { recursive: true })
  fs.writeFileSync(path.join(hubDir, 'AGENTS.override.md'), 'override-bytes\n')
  fs.writeFileSync(path.join(hubDir, 'overlay', 'attached-worktrees.txt'), `${tree}\n`)
  fs.writeFileSync(path.join(hubDir, 'overlay', 'do-not-auto-attach.txt'), '')
  fs.mkdirSync(path.join(tree, '.agents', 'skills'), { recursive: true })
  fs.mkdirSync(path.join(tree, '.codex'), { recursive: true })
  const ctx = createHub(hubDir)
  const first = repairLinks(ctx, tree)
  assert.equal(first.ok, true)
  assert.equal(first.repaired, true)
  return { dir, hubDir, tree, ctx }
}

test('repairLinks does not rewrite an unattached fixture tree', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-repair-unattached-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const hubDir = path.join(dir, 'hub')
  const tree = path.join(dir, 'tree')
  fs.mkdirSync(path.join(hubDir, 'overlay'), { recursive: true })
  fs.writeFileSync(path.join(hubDir, 'overlay', 'attached-worktrees.txt'), '')
  fs.writeFileSync(path.join(hubDir, 'overlay', 'do-not-auto-attach.txt'), '')
  fs.mkdirSync(tree, { recursive: true })
  const sentinel = path.join(tree, 'keep.txt')
  fs.writeFileSync(sentinel, 'untouched\n')
  const result = repairLinks(createHub(hubDir), tree)
  assert.equal(result.attached, false)
  assert.equal(result.repaired, false)
  assert.equal(result.reason, 'not-attached')
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'untouched\n')
  assert.equal(fs.existsSync(path.join(tree, '.agents')), false)
})

test('repairLinks restores a broken resident skill junction on an attached fixture', (t) => {
  const { ctx, tree, hubDir } = attachedRepairHub(t)
  const name = RESIDENT_SKILLS[0]
  const linkPath = path.join(tree, '.agents', 'skills', name)
  const hubPath = path.join(hubDir, 'skills', name)
  ctx.link.unlink(linkPath)
  assert.equal(ctx.link.isLinked(linkPath, hubPath), false)
  const result = repairLinks(ctx, tree)
  assert.equal(result.ok, true)
  assert.equal(result.repaired, true)
  assert.equal(ctx.link.isLinked(linkPath, hubPath), true)
  assert.equal(fs.readFileSync(path.join(linkPath, 'SKILL.md'), 'utf8'), `${name}\n`)
})

test('analyze finalize writes suggestion and proposed without adopting', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-analyze-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dir, 'skill-review', 'history'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'skills', 'inbox', 'smoke-analyze'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'skills', 'inbox', 'smoke-analyze', 'SKILL.md'), '# smoke\n')
  fs.writeFileSync(path.join(dir, 'skill-review', 'state.json'), JSON.stringify({
    version: 1,
    items: [{ id: 'an-1', name: 'smoke-analyze', unit: 'smoke-analyze', status: 'queued', inboxPath: 'skills/inbox/smoke-analyze' }]
  }))
  const ctx = createHub(dir)
  const session = enqueueSession(ctx, { kind: 'analyze', intent: 'suggest', inboxIds: ['an-1'] })
  markSessionSpawned(ctx, session, 88001)
  ctx.fs.writeText(session.logFile, 'session id: 0123456789abcdef0123456789abcdef\n')
  ctx.fs.writeText(session.lastFile, '```json\n{"action":"reject","target":"","reason":"discardable smoke"}\n```\n')
  ctx.fs.writeText(sessionExitFile(ctx, session), '0\n')
  reapSessions(ctx, () => false)
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'skill-review', 'state.json'), 'utf8'))
  const item = state.items.find((row) => row.id === 'an-1')
  assert.equal(item.status, 'proposed')
  assert.equal(item.suggestion.action, 'reject')
  assert.match(item.suggestion.reason, /discardable/)
  assert.equal(fs.existsSync(path.join(dir, 'skills', 'inbox', 'smoke-analyze', 'SKILL.md')), true)
  assert.equal(extractSuggestion(ctx.fs.readText(session.lastFile)).action, 'reject')
})

test('ingest empty payload is a no-op and does not need a game repo', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ingest-empty-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const result = ingest(createHub(dir), { payload: '' })
  assert.equal(result.created, 0)
  assert.deepEqual(result.items, [])
})

test('adopt links only attached fixture trees and skips a same-name non-hub path', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-adopt-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const hubDir = path.join(dir, 'hub')
  const attachedA = path.join(dir, 'attached-a')
  const attachedB = path.join(dir, 'attached-b')
  const loose = path.join(dir, 'unattached')
  fs.mkdirSync(path.join(hubDir, 'overlay'), { recursive: true })
  fs.mkdirSync(path.join(hubDir, 'skill-review', 'history'), { recursive: true })
  fs.mkdirSync(path.join(hubDir, 'skills', 'inbox', 'smoke-adopt'), { recursive: true })
  fs.writeFileSync(path.join(hubDir, 'skills', 'inbox', 'smoke-adopt', 'SKILL.md'), '# smoke-adopt\n')
  fs.writeFileSync(
    path.join(hubDir, 'overlay', 'attached-worktrees.txt'),
    `${attachedA}\n${attachedB}\n`
  )
  fs.writeFileSync(path.join(hubDir, 'overlay', 'do-not-auto-attach.txt'), '')
  fs.writeFileSync(path.join(hubDir, 'skill-review', 'state.json'), JSON.stringify({
    version: 1,
    items: [{ id: 'adopt-1', name: 'smoke-adopt', unit: 'smoke-adopt', status: 'queued', inboxPath: 'skills/inbox/smoke-adopt' }],
    lastIngest: null
  }))
  for (const tree of [attachedA, attachedB, loose]) {
    fs.mkdirSync(path.join(tree, '.agents', 'skills'), { recursive: true })
  }
  fs.mkdirSync(path.join(attachedB, '.agents', 'skills', 'smoke-adopt'), { recursive: true })
  fs.writeFileSync(path.join(attachedB, '.agents', 'skills', 'smoke-adopt', 'SKILL.md'), '# not hub\n')
  const liveInbox = path.join(hubRoot, 'skills', 'inbox')
  const liveBefore = fs.existsSync(liveInbox) ? fs.readdirSync(liveInbox).join('\n') : ''
  const result = decide(createHub(hubDir), { id: 'adopt-1', action: 'adopt' })
  assert.equal(result.ok, true)
  assert.equal(result.item.status, 'adopted')
  const dest = path.join(hubDir, 'skills', 'adopted', 'smoke-adopt')
  assert.equal(fs.existsSync(path.join(dest, 'SKILL.md')), true)
  assert.equal(result.trees.linked.some((row) => row.worktree === attachedA && row.status === 'linked'), true)
  assert.equal(result.trees.skipped.some((row) => row.worktree === attachedB && /elsewhere/.test(row.reason)), true)
  assert.equal(createHub(hubDir).link.isLinked(path.join(attachedA, '.agents', 'skills', 'smoke-adopt'), dest), true)
  assert.equal(fs.readFileSync(path.join(attachedB, '.agents', 'skills', 'smoke-adopt', 'SKILL.md'), 'utf8'), '# not hub\n')
  assert.equal(fs.existsSync(path.join(loose, '.agents', 'skills', 'smoke-adopt')), false)
  assert.equal(fs.existsSync(liveInbox) ? fs.readdirSync(liveInbox).join('\n') : '', liveBefore)
})

test('merge and reject do not create game-tree skill links', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-decide-nolink-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const hubDir = path.join(dir, 'hub')
  const tree = path.join(dir, 'tree')
  fs.mkdirSync(path.join(hubDir, 'overlay'), { recursive: true })
  fs.mkdirSync(path.join(hubDir, 'skill-review', 'history'), { recursive: true })
  fs.mkdirSync(path.join(hubDir, 'skills', 'ozdqp-development'), { recursive: true })
  fs.mkdirSync(path.join(hubDir, 'skills', 'inbox', 'merge-me'), { recursive: true })
  fs.mkdirSync(path.join(hubDir, 'skills', 'inbox', 'reject-me'), { recursive: true })
  fs.writeFileSync(path.join(hubDir, 'skills', 'inbox', 'merge-me', 'SKILL.md'), '# m\n')
  fs.writeFileSync(path.join(hubDir, 'skills', 'inbox', 'reject-me', 'SKILL.md'), '# r\n')
  fs.writeFileSync(path.join(hubDir, 'overlay', 'attached-worktrees.txt'), `${tree}\n`)
  fs.mkdirSync(path.join(tree, '.agents', 'skills'), { recursive: true })
  fs.writeFileSync(path.join(hubDir, 'skill-review', 'state.json'), JSON.stringify({
    version: 1,
    items: [
      { id: 'm1', name: 'merge-me', unit: 'merge-me', status: 'queued', inboxPath: 'skills/inbox/merge-me' },
      { id: 'r1', name: 'reject-me', unit: 'reject-me', status: 'queued', inboxPath: 'skills/inbox/reject-me' }
    ]
  }))
  const ctx = createHub(hubDir)
  decide(ctx, { id: 'm1', action: 'merge', mergeTarget: 'skills/ozdqp-development' })
  decide(ctx, { id: 'r1', action: 'reject' })
  assert.equal(fs.existsSync(path.join(tree, '.agents', 'skills', 'merge-me')), false)
  assert.equal(fs.existsSync(path.join(tree, '.agents', 'skills', 'reject-me')), false)
})

test('ingest copies official skill files into an isolated hub inbox', (t) => {
  const game = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-game-core-ingest-'))
  const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-core-ingest-'))
  t.after(() => {
    fs.rmSync(game, { recursive: true, force: true })
    fs.rmSync(hubDir, { recursive: true, force: true })
  })
  const run = (args) => spawnSync('git', ['-C', game, ...args], { encoding: 'utf8', windowsHide: true })
  run(['init'])
  run(['config', 'user.email', 'hub@test'])
  run(['config', 'user.name', 'hub'])
  fs.mkdirSync(path.join(game, '.agents', 'skills', 'core-ingest'), { recursive: true })
  fs.writeFileSync(path.join(game, '.agents', 'skills', 'core-ingest', 'SKILL.md'), '# one\n')
  run(['add', '.'])
  run(['commit', '-m', 'one'])
  const old = run(['rev-parse', 'HEAD']).stdout.trim()
  fs.writeFileSync(path.join(game, '.agents', 'skills', 'core-ingest', 'SKILL.md'), '# two\n')
  run(['add', '.'])
  run(['commit', '-m', 'two'])
  const next = run(['rev-parse', 'HEAD']).stdout.trim()
  fs.mkdirSync(path.join(hubDir, 'skill-review'), { recursive: true })
  const result = ingest(createHub(hubDir), {
    gameRepo: game,
    payload: `${old} ${next} refs/remotes/origin/core-ingest\n`
  })
  assert.equal(result.created, 1)
  assert.equal(result.items[0].name, 'core-ingest')
  assert.equal(result.items[0].status, 'queued')
  assert.equal(fs.readFileSync(path.join(hubDir, 'skills', 'inbox', 'core-ingest', 'SKILL.md'), 'utf8'), '# two\n')
  const liveInbox = path.join(hubRoot, 'skills', 'inbox', 'core-ingest')
  assert.equal(fs.existsSync(liveInbox), false)
})

test('repairLinks fails when fixture override bytes differ and does not overwrite them', (t) => {
  const { ctx, tree } = attachedRepairHub(t)
  const override = path.join(tree, 'AGENTS.override.md')
  fs.rmSync(override, { force: true })
  fs.writeFileSync(override, 'DIRTY-OVERRIDE\n')
  assert.throws(() => repairLinks(ctx, tree), /differs from hub/)
  assert.equal(fs.readFileSync(override, 'utf8'), 'DIRTY-OVERRIDE\n')
})

test('core source does not import http, powershell, Win32, or APPDATA', () => {
  const coreDir = path.join(hubRoot, 'src', 'core')
  const files = fs.readdirSync(coreDir).filter((name) => name.endsWith('.ts'))
  assert.ok(files.length > 0)
  for (const name of files) {
    const text = fs.readFileSync(path.join(coreDir, name), 'utf8')
    assert.doesNotMatch(text, /node:http/, name)
    assert.doesNotMatch(text, /powershell\.exe/i, name)
    assert.doesNotMatch(text, /Win32/, name)
    assert.doesNotMatch(text, /APPDATA/, name)
    assert.doesNotMatch(text, /junction/i, name)
    assert.doesNotMatch(text, /mklink/i, name)
  }
})
