import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
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
  for (const verb of ['status', 'list-worktrees', 'list-skills', 'repair-links', 'ingest', 'decide', 'attach', 'detach', 'edit', 'chat', 'resume', 'session', 'setup', 'uninstall', 'doctor', 'daemon']) {
    assert.match(help.stdout, new RegExp(verb))
  }

  const short = spawnHub(['-h'])
  assert.equal(short.status, 0, short.stderr)
  assert.match(short.stdout, /\bsg\b/)
  assert.match(short.stdout, /ozdqp-hub/)
})

test('setup --dry-run --json does not write an install dir', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-setup-dry-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const payload = parseStdout(
    spawnHub(['setup', '--dry-run', '--json', '--no-daemon', '--no-path', '--no-task'], {
      env: { SG_INSTALL_DIR: dir, SG_SKIP_PATH: '1', SG_SKIP_TASK: '1' }
    }),
    'setup-dry-run'
  )
  assert.equal(payload.ok, true)
  assert.equal(payload.action, 'setup')
  assert.equal(payload.dryRun, true)
  assert.equal(payload.command, 'sg')
  assert.equal(fs.existsSync(path.join(dir, 'bin', 'sg.cmd')), false)
  assert.equal(fs.existsSync(path.join(dir, 'install.json')), false)
})

test('setup --json writes shims into SG_INSTALL_DIR without touching user PATH', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-setup-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const payload = parseStdout(
    spawnHub(['setup', '--json', '--no-daemon', '--no-path', '--no-task'], {
      env: { SG_INSTALL_DIR: dir, SG_SKIP_PATH: '1', SG_SKIP_TASK: '1' }
    }),
    'setup-apply'
  )
  assert.equal(payload.ok, true, JSON.stringify(payload.issues || payload, null, 2))
  assert.equal(payload.dryRun, false)
  assert.equal(payload.installDir, dir)
  const shim = fs.readFileSync(path.join(dir, 'bin', 'sg.cmd'), 'utf8')
  assert.match(shim, /HUB_ROOT=/)
  assert.match(shim, /dist\\control\\cli\.js|dist\/control\/cli\.js/)
  assert.match(fs.readFileSync(path.join(dir, 'run-daemon.cmd'), 'utf8'), /daemon run/)
  const doctor = parseStdout(
    spawnHub(['doctor', '--json'], { env: { SG_INSTALL_DIR: dir, SG_SKIP_PATH: '1', SG_SKIP_TASK: '1' } }),
    'doctor'
  )
  assert.equal(doctor.ok, true, JSON.stringify(doctor.issues, null, 2))
  assert.equal(doctor.shims.ok, true)
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

function git(cwd, args) {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true })
}

function makeSkillRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-game-ingest-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  git(dir, ['init'])
  git(dir, ['config', 'user.email', 'hub@test'])
  git(dir, ['config', 'user.name', 'hub'])
  fs.mkdirSync(path.join(dir, '.agents', 'skills', 'smoke-ingest'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.agents', 'skills', 'smoke-ingest', 'SKILL.md'), '# v1\n')
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'agents v1\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-m', 'base'])
  const old = git(dir, ['rev-parse', 'HEAD']).stdout.trim()
  fs.writeFileSync(path.join(dir, '.agents', 'skills', 'smoke-ingest', 'SKILL.md'), '# v2 official skill\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-m', 'update skill'])
  const next = git(dir, ['rev-parse', 'HEAD']).stdout.trim()
  return { dir, old, next }
}

test('CLI ingest writes inbox under isolated HUB_ROOT and --dispatch only enqueues', (t) => {
  const game = makeSkillRepo(t)
  const hubDir = tempHub()
  t.after(() => fs.rmSync(hubDir, { recursive: true, force: true }))
  const liveInbox = path.join(hubRoot, 'skills', 'inbox')
  const liveBefore = fs.existsSync(liveInbox) ? fs.readdirSync(liveInbox).join('\n') : ''
  const liveSessions = path.join(hubRoot, 'skill-review', 'sessions.json')
  const sessionsBefore = fs.existsSync(liveSessions) ? fs.readFileSync(liveSessions, 'utf8') : ''
  const payload = parseStdout(
    spawnHub(['ingest', '--game-repo', game.dir, '--dispatch'], {
      env: { HUB_ROOT: hubDir, HUB_SPAWN_CODEX: '0' },
      input: `${game.old} ${game.next} refs/remotes/origin/smoke-ingest\n`
    }),
    'ingest-isolated'
  )
  assert.equal(payload.ok, true)
  assert.ok(payload.created >= 1)
  assert.equal(payload.dispatched, true)
  assert.equal(payload.session.kind, 'chat')
  assert.equal(payload.session.status, 'queued')
  assert.equal(payload.applied, null)
  const inboxSkill = path.join(hubDir, 'skills', 'inbox', 'smoke-ingest', 'SKILL.md')
  assert.equal(fs.readFileSync(inboxSkill, 'utf8'), '# v2 official skill\n')
  const state = JSON.parse(fs.readFileSync(path.join(hubDir, 'skill-review', 'state.json'), 'utf8'))
  assert.equal(state.items.some((item) => item.name === 'smoke-ingest' && item.status === 'queued'), true)
  const status = parseStdout(spawnHub(['status'], { env: { HUB_ROOT: hubDir } }), 'status-ingest')
  assert.equal(status.counts.queued, state.items.filter((item) => item.status === 'queued').length)
  assert.equal(fs.existsSync(liveInbox) ? fs.readdirSync(liveInbox).join('\n') : '', liveBefore)
  assert.equal(fs.existsSync(liveSessions) ? fs.readFileSync(liveSessions, 'utf8') : '', sessionsBefore)
})

test('CLI decide adopt reports linked vs skipped trees and does not touch live inbox', (t) => {
  const dir = tempHub()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const attached = path.join(dir, 'attached')
  const skippedTree = path.join(dir, 'skipped')
  const loose = path.join(dir, 'loose')
  fs.mkdirSync(path.join(dir, 'skills', 'inbox', 'smoke-cli-adopt'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'skills', 'inbox', 'smoke-cli-adopt', 'SKILL.md'), '# cli\n')
  fs.writeFileSync(path.join(dir, 'overlay', 'attached-worktrees.txt'), `${attached}\n${skippedTree}\n`)
  fs.writeFileSync(path.join(dir, 'skill-review', 'state.json'), JSON.stringify({
    version: 1,
    items: [{ id: 'cli-adopt-1', name: 'smoke-cli-adopt', unit: 'smoke-cli-adopt', status: 'queued', inboxPath: 'skills/inbox/smoke-cli-adopt' }]
  }))
  fs.mkdirSync(path.join(attached, '.agents', 'skills'), { recursive: true })
  fs.mkdirSync(path.join(skippedTree, '.agents', 'skills', 'smoke-cli-adopt'), { recursive: true })
  fs.writeFileSync(path.join(skippedTree, '.agents', 'skills', 'smoke-cli-adopt', 'other.txt'), 'nope\n')
  fs.mkdirSync(path.join(loose, '.agents', 'skills'), { recursive: true })
  const liveInbox = path.join(hubRoot, 'skills', 'inbox')
  const liveBefore = fs.existsSync(liveInbox) ? fs.readdirSync(liveInbox).join('\n') : ''
  const payload = parseStdout(
    spawnHub(['decide', '--id', 'cli-adopt-1', '--action', 'adopt'], { env: { HUB_ROOT: dir } }),
    'decide-adopt'
  )
  assert.equal(payload.ok, true)
  assert.equal(payload.action, 'adopt')
  assert.equal(payload.item.status, 'adopted')
  assert.ok(payload.trees.linked.some((row) => row.worktree === attached))
  assert.ok(payload.trees.skipped.some((row) => row.worktree === skippedTree))
  assert.equal(fs.existsSync(path.join(attached, '.agents', 'skills', 'smoke-cli-adopt', 'SKILL.md')), true)
  assert.equal(fs.existsSync(path.join(loose, '.agents', 'skills', 'smoke-cli-adopt')), false)
  assert.equal(fs.existsSync(liveInbox) ? fs.readdirSync(liveInbox).join('\n') : '', liveBefore)
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
  assert.doesNotMatch(afterSessions, /hub-cli-not-a-game-tree/)
  assert.equal(fs.existsSync(fakeTree), false)
})

function markRunningWithPid(dir, session, pid, extra = {}) {
  const file = path.join(dir, 'skill-review', 'sessions.json')
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  const row = data.sessions.find((item) => item.id === session.id)
  row.pid = pid
  row.status = 'running'
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
  fs.writeFileSync(session.logFile, extra.log || `session id: 0123456789abcdef0123456789abcdef\n`)
  fs.writeFileSync(session.lastFile, extra.last || '验收摘要: fixture-ok\n')
  if (extra.exitCode != null) {
    fs.writeFileSync(path.join(dir, 'skill-review', `session-${session.id}.exit`), `${extra.exitCode}\n`)
  }
}

test('attach --no-spawn --wait stays queued and does not launch Codex', (t) => {
  const dir = tempHub()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const liveSessions = path.join(hubRoot, 'skill-review', 'sessions.json')
  const before = fs.existsSync(liveSessions) ? fs.readFileSync(liveSessions, 'utf8') : ''
  const started = Date.now()
  const payload = parseStdout(
    spawnHub(['attach', '--worktree', 'C:\\hub-cli-wait-queued', '--intent', 'no-spawn-wait', '--no-spawn', '--wait'], {
      env: { HUB_ROOT: dir, HUB_WAIT_TIMEOUT_MS: '4000', HUB_SPAWN_CODEX: '0' }
    }),
    'attach-no-spawn-wait'
  )
  assert.ok(Date.now() - started < 3500, 'queued --wait must return without polling a missing pid')
  assert.equal(payload.session.status, 'queued')
  assert.equal(payload.session.pid, 0)
  assert.equal(fs.existsSync(path.join(dir, 'skill-review', `run-codex-${payload.session.id}.cmd`)), false)
  assert.equal(fs.existsSync(liveSessions) ? fs.readFileSync(liveSessions, 'utf8') : '', before)
})

test('session --id --wait reaps a fake pid exit 0 without launching Codex', { timeout: 20000 }, (t) => {
  const dir = tempHub()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const liveSessions = path.join(hubRoot, 'skill-review', 'sessions.json')
  const before = fs.existsSync(liveSessions) ? fs.readFileSync(liveSessions, 'utf8') : ''
  const attach = parseStdout(
    spawnHub(['attach', '--worktree', 'C:\\hub-cli-fake-pid', '--intent', 'wait-zero', '--no-spawn'], {
      env: { HUB_ROOT: dir, HUB_SPAWN_CODEX: '0' }
    }),
    'attach-fixture'
  )
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 400)'], {
    stdio: 'ignore',
    windowsHide: true
  })
  t.after(() => {
    try {
      child.kill()
    } catch {
      /* already exited */
    }
  })
  assert.ok(child.pid > 0)
  markRunningWithPid(dir, attach.session, child.pid, { exitCode: 0 })
  const payload = parseStdout(
    spawnHub(['session', '--id', attach.session.id, '--wait'], {
      env: { HUB_ROOT: dir, HUB_WAIT_TIMEOUT_MS: '10000', HUB_SPAWN_CODEX: '0' }
    }),
    'session-wait-zero'
  )
  assert.equal(payload.ok, true)
  assert.equal(payload.action, 'session')
  assert.equal(payload.session.status, 'waiting')
  assert.equal(payload.session.exitCode, 0)
  assert.equal(payload.session.codexSessionId, '0123456789abcdef0123456789abcdef')
  assert.match(payload.session.summary || '', /fixture-ok/)
  assert.equal(fs.existsSync(path.join(dir, 'skill-review', `run-codex-${attach.session.id}.cmd`)), false)
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'skill-review', 'sessions.json'), 'utf8'))
  const row = stored.sessions.find((item) => item.id === attach.session.id)
  assert.equal(row.status, 'waiting')
  assert.equal(row.exitCode, 0)
  const status = parseStdout(spawnHub(['status'], { env: { HUB_ROOT: dir } }), 'status-after-wait')
  assert.ok(Array.isArray(status.sessions))
  assert.equal(status.sessions.some((item) => item.id === attach.session.id), false)
  assert.equal(fs.existsSync(liveSessions) ? fs.readFileSync(liveSessions, 'utf8') : '', before)
})

test('session --id --wait reaps a fake pid nonzero exit as failed', { timeout: 20000 }, (t) => {
  const dir = tempHub()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const chat = parseStdout(
    spawnHub(['chat', '--intent', 'wait-fail', '--no-spawn'], { env: { HUB_ROOT: dir, HUB_SPAWN_CODEX: '0' } }),
    'chat-fixture'
  )
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(3), 400)'], {
    stdio: 'ignore',
    windowsHide: true
  })
  t.after(() => {
    try {
      child.kill()
    } catch {
      /* already exited */
    }
  })
  markRunningWithPid(dir, chat.session, child.pid, {
    exitCode: 3,
    log: 'failed without a session id\n',
    last: ''
  })
  const payload = parseStdout(
    spawnHub(['session', '--id', chat.session.id, '--wait'], {
      env: { HUB_ROOT: dir, HUB_WAIT_TIMEOUT_MS: '10000', HUB_SPAWN_CODEX: '0' }
    }),
    'session-wait-fail'
  )
  assert.equal(payload.session.status, 'failed')
  assert.equal(payload.session.exitCode, 3)
})

test('shipped CLI attach spawns Codex on gpt-5.6-luna at max, not overlay scripts', () => {
  const src = fs.readFileSync(path.join(hubRoot, 'dist', 'control', 'cli.js'), 'utf8')
  assert.match(src, /gpt-5\.6-luna/)
  assert.match(src, /model_reasoning_effort/)
  assert.match(src, /'-m'/)
  assert.match(src, /spawnCodex/)
  assert.doesNotMatch(src, /manage-skill-visibility\.ps1/)
  assert.doesNotMatch(src, /attach-library\.ps1/)
  assert.doesNotMatch(src, /analyze-remote-skill-update\.ps1/)
})

test('CLI repair-links restores a broken fixture junction and rejects a dirty override', (t) => {
  const dir = tempHub()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const tree = path.join(dir, 'tree')
  for (const name of ['ozdqp-development', 'ozdqp-ui-development', 'ozdqp-git-workflow']) {
    fs.mkdirSync(path.join(dir, 'skills', name), { recursive: true })
    fs.writeFileSync(path.join(dir, 'skills', name, 'SKILL.md'), `${name}\n`)
  }
  fs.mkdirSync(path.join(dir, 'overlay'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'AGENTS.override.md'), 'override-bytes\n')
  fs.writeFileSync(path.join(dir, 'overlay', 'attached-worktrees.txt'), `${tree}\n`)
  fs.mkdirSync(path.join(tree, '.agents', 'skills'), { recursive: true })
  fs.mkdirSync(path.join(tree, '.codex'), { recursive: true })
  const env = { HUB_ROOT: dir }
  const first = parseStdout(spawnHub(['repair-links', '--worktree', tree], { env }), 'repair-first')
  assert.equal(first.ok, true)
  assert.equal(first.repaired, true)
  const skillLink = path.join(tree, '.agents', 'skills', 'ozdqp-development')
  fs.rmdirSync(skillLink)
  const restored = parseStdout(spawnHub(['repair-links', '--worktree', tree], { env }), 'repair-restored')
  assert.equal(restored.ok, true)
  assert.equal(fs.existsSync(path.join(skillLink, 'SKILL.md')), true)
  const override = path.join(tree, 'AGENTS.override.md')
  fs.rmSync(override, { force: true })
  fs.writeFileSync(override, 'DIRTY-OVERRIDE\n')
  const dirty = spawnHub(['repair-links', '--worktree', tree], { env })
  assert.notEqual(dirty.status, 0)
  assert.match(`${dirty.stderr}\n${dirty.stdout}`, /differs from hub/)
  assert.equal(fs.readFileSync(override, 'utf8'), 'DIRTY-OVERRIDE\n')
})
