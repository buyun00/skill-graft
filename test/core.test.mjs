import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import test from 'node:test'
import {
  createHub,
  enqueueSession,
  extractCodexSessionId,
  finalizeSession,
  findSession,
  getStatus,
  isClientCheckout,
  isEphemeralPath,
  listSkills,
  listWorktrees,
  markSessionSpawned,
  parseWorktreePorcelain,
  reapSessions,
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

test('C3 isClientCheckout requires AGENTS.md + baloot_client and skips hub/excluded/.partial-', () => {
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
  }
})
