import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { hubRoot, spawnHub as spawnRawHub, testHubRoot } from './helpers.mjs'
import { createTemporaryCliPackage, createTemporaryTestHub } from './support/test-hub.mjs'

function spawnHub(args, options = {}) {
  const first = args[0]
  const hostLocal = !first || first === '--help' || first === '-h'
    || ['setup', 'install', 'upgrade', 'uninstall', 'purge', 'doctor', 'daemon', 'hook-diagnostic'].includes(first)
  const explicit = args.includes('--contract-v1') || args.includes('--legacy-output')
  return spawnRawHub(!hostLocal && !explicit ? [...args, '--legacy-output'] : args, options)
}

function parseStdout(result, label) {
  assert.equal(result.status, 0, `${label} stdout=${result.stdout} stderr=${result.stderr}`)
  assert.ok(!result.stdout.startsWith('\uFEFF'), `${label} stdout has a BOM`)
  return JSON.parse(result.stdout)
}

function tempHub(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cli-'))
  const dir = path.join(parent, 'data')
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dir, 'skill-review', 'history'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'overlay'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'overlay', 'attached-worktrees.txt'), '')
  fs.writeFileSync(path.join(dir, 'overlay', 'do-not-auto-attach.txt'), '')
  return dir
}

async function tempSetupEnvironment(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const home = path.join(root, 'home')
  const appData = path.join(root, 'appdata')
  const localAppData = path.join(root, 'localappdata')
  const temp = path.join(root, 'temp')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  for (const dir of [home, appData, localAppData, temp]) fs.mkdirSync(dir, { recursive: true })
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const portProbe = createServer()
  await new Promise((resolveListen, rejectListen) => {
    portProbe.once('error', rejectListen)
    portProbe.listen(0, '127.0.0.1', resolveListen)
  })
  const address = portProbe.address()
  assert.ok(address && typeof address === 'object')
  const port = address.port
  await new Promise((resolveClose, rejectClose) => {
    portProbe.close((error) => error ? rejectClose(error) : resolveClose())
  })

  return {
    dataRoot,
    installDir,
    env: {
      HOME: home,
      USERPROFILE: home,
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
      TEMP: temp,
      TMP: temp,
      SKILL_GRAFT_HOME: dataRoot,
      HUB_ROOT: dataRoot,
      HUB_API_PORT: String(port),
      SG_INSTALL_DIR: installDir,
      SG_SKIP_PATH: '1',
      SG_SKIP_TASK: '1'
    }
  }
}

test('U1 hub status exits 0 with hubRoot and 3 resident skills', () => {
  const payload = parseStdout(spawnHub(['status']), 'status')
  assert.equal(payload.hubRoot, testHubRoot)
  assert.equal(payload.resident.length, 3)
  assert.ok(payload.resident.every((node) => node.kind === 'resident'))
  const queued = payload.items.filter((item) => item.status === 'queued')
  assert.equal(payload.counts.queued, queued.length)
})

test('business CLI defaults to the typed envelope and keeps explicit legacy output', () => {
  const typed = parseStdout(spawnRawHub(['status', '--request-id', 'typed-default-status']), 'typed-default-status')
  assert.equal(typed.ok, true)
  assert.equal(typed.contractVersion, 1)
  assert.equal(typed.commandKind, 'status')
  assert.equal(typed.data.hubRoot, testHubRoot)

  const legacy = parseStdout(spawnRawHub(['status', '--legacy-output']), 'legacy-status')
  assert.equal(legacy.hubRoot, testHubRoot)
  assert.equal(legacy.ok, undefined)
  assert.ok(Array.isArray(legacy.items))
})

test('typed CLI status with nothing to reap is read-only', (t) => {
  const dir = tempHub(t)
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const payload = parseStdout(spawnHub([
    'status', '--contract-v1', '--request-id', 'cli-read-only-status'
  ], { env: { HUB_ROOT: dir } }), 'typed-read-only-status')
  assert.equal(payload.ok, true)
  assert.equal(payload.commandKind, 'status')
  assert.equal(payload.data.hubRoot, path.resolve(dir))
  assert.equal(fs.existsSync(path.join(dir, 'skill-review', 'application-ledger.json')), false)
  assert.equal(fs.existsSync(path.join(dir, 'skill-review', 'application-audit.json')), false)
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
  for (const verb of ['status', 'list-worktrees', 'list-skills', 'repair-links', 'apply-legacy-attach', 'apply-legacy-detach', 'ingest', 'decide', 'attach', 'detach', 'edit', 'chat', 'analyze', 'resume', 'cancel', 'session', 'setup', 'uninstall', 'doctor', 'daemon']) {
    assert.match(help.stdout, new RegExp(verb))
  }

  const short = spawnHub(['-h'])
  assert.equal(short.status, 0, short.stderr)
  assert.match(short.stdout, /\bsg\b/)
  assert.match(short.stdout, /ozdqp-hub/)
})

test('daemon stop returns structured failure and nonzero for live unverified state', (t) => {
  const dir = tempHub(t)
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const review = path.join(dir, 'skill-review')
  const pidFile = path.join(review, 'daemon.pid')
  const heartbeatFile = path.join(review, 'daemon-heartbeat.json')
  fs.writeFileSync(pidFile, `${process.pid}\n`)
  fs.writeFileSync(heartbeatFile, '{corrupt')

  const result = spawnHub(['daemon', 'stop'], {
    env: { HUB_ROOT: dir, HUB_API_PORT: '22002' }
  })
  assert.notEqual(result.status, 0)
  assert.ok(!result.stdout.startsWith('\uFEFF'))
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.ok, false)
  assert.equal(payload.action, 'daemon-stop')
  assert.equal(payload.stopped, false)
  assert.equal(payload.error.code, 'DAEMON_INSTANCE_UNVERIFIED')
  assert.equal(fs.readFileSync(pidFile, 'utf8').trim(), String(process.pid))
  assert.equal(fs.readFileSync(heartbeatFile, 'utf8'), '{corrupt')
})

test('daemon status maps every non-ok structured result to exit code 1', (t) => {
  const dir = tempHub(t)
  const environment = {
    HUB_ROOT: dir,
    HUB_API_PORT: '22012',
    SG_SKIP_TASK: '1'
  }
  const stopped = spawnHub(['daemon', 'status'], { env: environment })
  assert.equal(stopped.status, 1, stopped.stderr)
  const stoppedPayload = JSON.parse(stopped.stdout)
  assert.equal(stoppedPayload.action, 'daemon-status')
  assert.equal(stoppedPayload.ok, false)
  assert.equal(stoppedPayload.running, false)

  const review = path.join(dir, 'skill-review')
  fs.writeFileSync(path.join(review, 'daemon.pid'), `${process.pid}\n`)
  fs.writeFileSync(path.join(review, 'api.pid'), `${process.pid}\n`)
  fs.writeFileSync(path.join(review, 'daemon-heartbeat.json'), '{corrupt')
  const unverified = spawnHub(['daemon', 'status'], { env: environment })
  assert.equal(unverified.status, 1, unverified.stderr)
  const unverifiedPayload = JSON.parse(unverified.stdout)
  assert.equal(unverifiedPayload.action, 'daemon-status')
  assert.equal(unverifiedPayload.ok, false)
  assert.equal(unverifiedPayload.running, false)
  assert.equal(fs.readFileSync(path.join(review, 'daemon-heartbeat.json'), 'utf8'), '{corrupt')
})

test('setup --dry-run --json does not write an install dir', async (t) => {
  const fixture = await tempSetupEnvironment(t, 'hub-setup-dry-')
  const dir = fixture.installDir
  const cliPackage = createTemporaryCliPackage(hubRoot)
  t.after(() => cliPackage.cleanup())
  const payload = parseStdout(
    spawnHub(['setup', '--dry-run', '--json', '--no-daemon', '--no-path', '--no-task'], {
      cliPath: cliPackage.cliPath,
      env: fixture.env
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

test('setup --json writes shims into SG_INSTALL_DIR without touching user PATH', async (t) => {
  const fixture = await tempSetupEnvironment(t, 'hub-setup-')
  const dir = fixture.installDir
  const cliPackage = createTemporaryCliPackage(hubRoot)
  t.after(() => cliPackage.cleanup())
  const payload = parseStdout(
    spawnHub(['setup', '--json', '--no-daemon', '--no-path', '--no-task'], {
      cliPath: cliPackage.cliPath,
      env: fixture.env
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
    spawnHub(['doctor', '--json'], {
      cliPath: cliPackage.cliPath,
      env: fixture.env
    }),
    'doctor'
  )
  assert.equal(doctor.ok, true, JSON.stringify(doctor.issues, null, 2))
  assert.equal(doctor.shims.ok, true)
  assert.equal(doctor.daemon.apiHealthy, false)
})

test('repair-links rejects a non-Git path without applying effects', (t) => {
  const dir = tempHub(t)
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const worktree = path.join(dir, 'non-git-repair-probe')
  assert.equal(fs.existsSync(worktree), false)
  const result = spawnHub([
    'repair-links', '--worktree', worktree,
    '--contract-v1', '--request-id', 'cli-non-git-repair'
  ], { env: { HUB_ROOT: dir } })
  assert.notEqual(result.status, 0)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.ok, false)
  assert.equal(payload.error.code, 'WORKTREE_NOT_RECOGNIZED')
  assert.equal(fs.existsSync(worktree), false, 'rejected repair must not create or rewrite the target')
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

function makeRecognizedWorktree(root, name) {
  const tree = path.join(root, name)
  fs.mkdirSync(path.join(tree, 'baloot_client'), { recursive: true })
  fs.writeFileSync(path.join(tree, 'AGENTS.md'), '# temporary recognized checkout\n')
  const initialized = git(tree, ['init'])
  assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout)
  return tree
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
  const hubDir = tempHub(t)
  t.after(() => fs.rmSync(hubDir, { recursive: true, force: true }))
  const liveInbox = path.join(hubRoot, 'skills', 'inbox')
  const liveBefore = fs.existsSync(liveInbox) ? fs.readdirSync(liveInbox).join('\n') : ''
  const liveSessions = path.join(hubRoot, 'skill-review', 'sessions.json')
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
  assert.equal(payload.session.kind, 'analyze')
  assert.equal(payload.session.status, 'queued')
  assert.equal(payload.applied, null)
  const inboxSkill = path.join(hubDir, 'skills', 'inbox', 'smoke-ingest', 'SKILL.md')
  assert.equal(fs.readFileSync(inboxSkill, 'utf8'), '# v2 official skill\n')
  const state = JSON.parse(fs.readFileSync(path.join(hubDir, 'skill-review', 'state.json'), 'utf8'))
  assert.equal(state.items.some((item) => item.name === 'smoke-ingest' && item.status === 'queued'), true)
  const status = parseStdout(spawnHub(['status'], { env: { HUB_ROOT: hubDir } }), 'status-ingest')
  assert.equal(status.counts.queued, state.items.filter((item) => item.status === 'queued').length)
  assert.equal(fs.existsSync(liveInbox) ? fs.readdirSync(liveInbox).join('\n') : '', liveBefore)
  const liveAfter = fs.existsSync(liveSessions) ? fs.readFileSync(liveSessions, 'utf8') : ''
  assert.doesNotMatch(liveAfter, new RegExp(payload.session.id))
})

test('typed CLI ingest --dry-run plans, replays, conflicts, and writes only ledger/audit', (t) => {
  const game = makeSkillRepo(t)
  const hubDir = tempHub(t)
  t.after(() => fs.rmSync(hubDir, { recursive: true, force: true }))
  const requestId = 'cli-ingest-dry-run'
  const input = `${game.old} ${game.next} refs/remotes/origin/smoke-ingest\n`
  const args = [
    'ingest', '--game-repo', game.dir, '--dispatch', '--dry-run',
    '--contract-v1', '--request-id', requestId
  ]

  const first = parseStdout(spawnHub(args, {
    env: { HUB_ROOT: hubDir, HUB_SPAWN_CODEX: '0' },
    input
  }), 'typed-ingest-dry-run')
  assert.equal(first.ok, true)
  assert.equal(first.commandKind, 'ingest')
  assert.equal(first.meta.replayed, false)
  assert.equal(first.data.dryRun, true)
  assert.ok(first.data.created >= 1)
  assert.equal(first.data.items.some((item) => item.name === 'smoke-ingest'), true)
  assert.equal(first.data.dispatched, false)
  assert.equal(first.data.session, undefined)

  const replay = parseStdout(spawnHub(args, {
    env: { HUB_ROOT: hubDir, HUB_SPAWN_CODEX: '0' },
    input
  }), 'typed-ingest-dry-run-replay')
  assert.equal(replay.ok, true)
  assert.equal(replay.meta.replayed, true)
  assert.deepEqual(replay.data, first.data)

  const conflict = spawnHub([
    'ingest', '--game-repo', game.dir, '--dispatch',
    '--contract-v1', '--request-id', requestId
  ], {
    env: { HUB_ROOT: hubDir, HUB_SPAWN_CODEX: '0' },
    input
  })
  assert.notEqual(conflict.status, 0)
  const conflictPayload = JSON.parse(conflict.stdout)
  assert.equal(conflictPayload.ok, false)
  assert.equal(conflictPayload.error.code, 'REQUEST_ID_CONFLICT')

  assert.equal(fs.existsSync(path.join(hubDir, 'skills', 'inbox', 'smoke-ingest')), false)
  assert.equal(fs.existsSync(path.join(hubDir, 'skill-review', 'state.json')), false)
  assert.equal(fs.existsSync(path.join(hubDir, 'skill-review', 'sessions.json')), false)
  assert.deepEqual(fs.readdirSync(path.join(hubDir, 'skill-review', 'history')), [])
  const ledger = JSON.parse(fs.readFileSync(path.join(hubDir, 'skill-review', 'application-ledger.json'), 'utf8'))
  const audit = JSON.parse(fs.readFileSync(path.join(hubDir, 'skill-review', 'application-audit.json'), 'utf8'))
  assert.equal(ledger.entries.length, 1)
  assert.equal(ledger.entries[0].requestId, requestId)
  assert.equal(ledger.entries[0].status, 'completed')
  assert.equal(audit.events.length, 1)
  assert.equal(audit.events[0].requestId, requestId)
  assert.equal(audit.events[0].type, 'command.succeeded')
})

test('CLI decide adopt reports linked vs skipped trees and does not touch live inbox', (t) => {
  const dir = tempHub(t)
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

test('CLI analyze fake session writes proposed suggestion; decide without --action does not adopt', (t) => {
  const dir = tempHub(t)
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dir, 'overlay', 'prompts'), { recursive: true })
  fs.copyFileSync(path.join(hubRoot, 'overlay', 'prompts', 'analyze.txt'), path.join(dir, 'overlay', 'prompts', 'analyze.txt'))
  fs.mkdirSync(path.join(dir, 'skills', 'inbox', 'smoke-cli-analyze'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'skills', 'inbox', 'smoke-cli-analyze', 'SKILL.md'), '# x\n')
  const id = 'cli-an-1'
  fs.writeFileSync(path.join(dir, 'skill-review', 'state.json'), JSON.stringify({
    version: 1,
    items: [{ id, name: 'smoke-cli-analyze', unit: 'smoke-cli-analyze', status: 'queued', inboxPath: 'skills/inbox/smoke-cli-analyze' }]
  }))
  const env = { HUB_ROOT: dir, HUB_SPAWN_CODEX: '0' }
  const missing = spawnHub(['decide', '--id', id], { env })
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /--action/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'skill-review', 'state.json'), 'utf8')).items[0].status, 'queued')
  const analyze = parseStdout(spawnHub(['analyze', '--id', id, '--no-spawn'], { env }), 'analyze')
  assert.equal(analyze.session.kind, 'analyze')
  assert.equal(analyze.applied, null)
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 300)'], { stdio: 'ignore', windowsHide: true })
  t.after(() => { try { child.kill() } catch { /* gone */ } })
  markRunningWithPid(dir, analyze.session, child.pid, {
    exitCode: 0,
    log: 'session id: 0123456789abcdef0123456789abcdef\n',
    last: '{"action":"reject","target":"","reason":"smoke only"}'
  })
  parseStdout(
    spawnHub(['session', '--id', analyze.session.id, '--wait'], { env: { ...env, HUB_WAIT_TIMEOUT_MS: '10000' } }),
    'analyze-wait'
  )
  const status = parseStdout(spawnHub(['status'], { env }), 'status-proposed')
  const item = status.items.find((row) => row.id === id)
  assert.equal(item.status, 'proposed')
  assert.equal(item.suggestion.action, 'reject')
  assert.equal(fs.existsSync(path.join(dir, 'skills', 'inbox', 'smoke-cli-analyze', 'SKILL.md')), true)
})

test('decide reject updates a fixture hub and does not touch the live inbox', (t) => {
  const dir = tempHub(t)
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
  const dir = tempHub(t)
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const liveSessions = path.join(hubRoot, 'skill-review', 'sessions.json')
  const beforeLiveSessions = fs.existsSync(liveSessions) ? fs.readFileSync(liveSessions, 'utf8') : ''
  const fakeTree = makeRecognizedWorktree(dir, 'session-worktree')

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

  fs.writeFileSync(path.join(dir, 'overlay', 'attached-worktrees.txt'), `${fakeTree}\n`)
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
  assert.equal(afterSessions, beforeLiveSessions)
  assert.equal(fs.readFileSync(path.join(fakeTree, 'AGENTS.md'), 'utf8'), '# temporary recognized checkout\n')
  assert.equal(fs.existsSync(path.join(fakeTree, 'AGENTS.override.md')), false)
  assert.equal(fs.existsSync(path.join(fakeTree, '.agents')), false)
})

test('typed CLI detach apply is bound to the queued detach session and removes only the isolated claim', (t) => {
  const dir = tempHub(t)
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const worktree = makeRecognizedWorktree(dir, 'typed-detach-worktree')
  fs.writeFileSync(path.join(dir, 'overlay', 'attached-worktrees.txt'), `# keep comment\nC:\\other-tree\n${worktree}\n`)
  const queued = parseStdout(spawnHub([
    'detach', '--worktree', worktree, '--no-spawn', '--contract-v1', '--request-id', 'cli-detach-enqueue'
  ], { env: { HUB_ROOT: dir, HUB_SPAWN_CODEX: '0' } }), 'typed-detach-enqueue')
  assert.equal(queued.ok, true)
  assert.equal(queued.commandKind, 'detach')
  assert.equal(queued.data.applied, null)

  const applied = parseStdout(spawnHub([
    'apply-legacy-detach', '--worktree', worktree, '--session-id', queued.data.session.id,
    '--contract-v1', '--request-id', 'cli-detach-apply'
  ], { env: { HUB_ROOT: dir, HUB_SPAWN_CODEX: '0' } }), 'typed-detach-apply')
  assert.equal(applied.ok, true)
  assert.equal(applied.commandKind, 'applyLegacyDetach')
  assert.equal(applied.data.detached, true)
  assert.equal(applied.data.changed, true)
  assert.equal(applied.data.claim, 'removed')
  assert.deepEqual(applied.data.effects.map((effect) => effect.status), ['missing', 'missing', 'missing', 'missing', 'missing'])
  assert.equal(fs.readFileSync(path.join(dir, 'overlay', 'attached-worktrees.txt'), 'utf8'), '# keep comment\nC:\\other-tree\n')

  const replay = parseStdout(spawnHub([
    'apply-legacy-detach', '--worktree', worktree, '--session-id', queued.data.session.id,
    '--contract-v1', '--request-id', 'cli-detach-apply'
  ], { env: { HUB_ROOT: dir, HUB_SPAWN_CODEX: '0' } }), 'typed-detach-replay')
  assert.equal(replay.ok, true)
  assert.equal(replay.meta.replayed, true)
  assert.deepEqual(replay.data, applied.data)
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

function markV2RunnerExited(dir, session) {
  const file = path.join(dir, 'skill-review', 'sessions.json')
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  const row = data.sessions.find((item) => item.id === session.id)
  assert.equal(row.sessionSchemaVersion, 2)
  row.runnerId = `local:${createHash('sha256').update(`${row.id}\n${row.attemptId}`).digest('hex').slice(0, 24)}`
  row.status = 'running'
  const at = new Date().toISOString()
  fs.writeFileSync(row.runnerArtifacts.receiptPath, `${JSON.stringify({
    executionReceiptVersion: 1,
    sessionId: row.id,
    attemptId: row.attemptId,
    state: 'exited',
    controllerPid: 0,
    childPid: 0,
    exitCode: 0,
    threadId: '019cfake0-0000-7000-8000-000000000001',
    sawTurnCompleted: true,
    sawTurnFailed: false,
    eventCount: 1,
    cancellationRequested: false,
    startedAt: at,
    endedAt: at
  })}\n`, 'utf8')
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
}

test('claim reaps its completed attach session without requiring a prior session query', { timeout: 20000 }, (t) => {
  const temporary = createTemporaryTestHub(hubRoot)
  t.after(() => temporary.cleanup())
  const dir = temporary.root
  const worktree = makeRecognizedWorktree(dir, 'direct-claim-worktree')
  const snapshot = parseStdout(spawnHub([
    'snapshot', 'create', '--contract-v1', '--request-id', 'direct-claim-snapshot'
  ], { env: { HUB_ROOT: dir, HUB_SPAWN_CODEX: '0' } }), 'direct-claim-snapshot')
  const snapshotId = snapshot.data.snapshot.snapshotId
  const runtimeRevision = JSON.parse(fs.readFileSync(path.join(hubRoot, 'package.json'), 'utf8')).version
  fs.writeFileSync(path.join(dir, 'skill-review', 'state.json'), `${JSON.stringify({
    schemaVersion: 2,
    stateRevision: 1,
    runtimeRevision,
    librarySnapshots: [snapshotId],
    worktrees: {},
    items: [],
    lastIngest: null
  }, null, 2)}\n`, 'utf8')
  const attach = parseStdout(spawnHub([
    'attach', '--worktree', worktree, '--intent', 'direct claim', '--no-spawn'
  ], { env: { HUB_ROOT: dir, HUB_SPAWN_CODEX: '0' } }), 'direct-claim-attach')
  markV2RunnerExited(dir, attach.session)

  const claimed = parseStdout(spawnHub([
    'claim', '--worktree', worktree,
    '--snapshot', snapshotId,
    '--session-id', attach.session.id,
    '--clear-skills', '--contract-v1', '--request-id', 'direct-claim'
  ], { env: { HUB_ROOT: dir, HUB_SPAWN_CODEX: '0' } }), 'direct-claim')
  assert.equal(claimed.commandKind, 'claimWorktree')
  assert.equal(claimed.data.changed, true)
  assert.deepEqual(claimed.data.pin.selectedSkills, [])
  const ledger = JSON.parse(fs.readFileSync(path.join(dir, 'skill-review', 'application-ledger.json'), 'utf8'))
  assert.ok(ledger.entries.some((entry) => entry.commandKind === 'reapSessions'))
})

test('attach --no-spawn --wait stays queued and does not launch Codex', (t) => {
  const dir = tempHub(t)
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const worktree = makeRecognizedWorktree(dir, 'wait-queued-worktree')
  const liveSessions = path.join(hubRoot, 'skill-review', 'sessions.json')
  const before = fs.existsSync(liveSessions) ? fs.readFileSync(liveSessions, 'utf8') : ''
  const payload = parseStdout(
    spawnHub(['attach', '--worktree', worktree, '--intent', 'no-spawn-wait', '--no-spawn', '--wait'], {
      env: { HUB_ROOT: dir, HUB_WAIT_TIMEOUT_MS: '4000', HUB_SPAWN_CODEX: '0' }
    }),
    'attach-no-spawn-wait'
  )
  assert.equal(payload.session.status, 'queued')
  assert.equal(payload.session.pid, 0)
  assert.equal(fs.existsSync(path.join(dir, 'skill-review', `run-codex-${payload.session.id}.cmd`)), false)
  const afterQueued = fs.existsSync(liveSessions) ? fs.readFileSync(liveSessions, 'utf8') : ''
  assert.equal(afterQueued, before)
})

test('session --id --wait reaps a fake pid exit 0 without launching Codex', { timeout: 20000 }, (t) => {
  const dir = tempHub(t)
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const worktree = makeRecognizedWorktree(dir, 'fake-pid-worktree')
  const liveSessions = path.join(hubRoot, 'skill-review', 'sessions.json')
  const before = fs.existsSync(liveSessions) ? fs.readFileSync(liveSessions, 'utf8') : ''
  const attach = parseStdout(
    spawnHub(['attach', '--worktree', worktree, '--intent', 'wait-zero', '--no-spawn'], {
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
  const typed = parseStdout(spawnHub([
    'session', '--id', attach.session.id, '--wait', '--contract-v1', '--request-id', 'typed-session-wait'
  ], { env: { HUB_ROOT: dir, HUB_WAIT_TIMEOUT_MS: '10000', HUB_SPAWN_CODEX: '0' } }), 'typed-session-wait')
  assert.equal(typed.ok, true)
  assert.equal(typed.commandKind, 'getSession')
  assert.equal(typed.data.session.id, attach.session.id)
  assert.equal(typed.data.session.status, 'waiting')
  const ledger = JSON.parse(fs.readFileSync(path.join(dir, 'skill-review', 'application-ledger.json'), 'utf8'))
  assert.equal(ledger.entries.filter((entry) => entry.commandKind === 'reapSessions').length, 1)
  const status = parseStdout(spawnHub(['status'], { env: { HUB_ROOT: dir } }), 'status-after-wait')
  assert.ok(Array.isArray(status.sessions))
  assert.equal(status.sessions.some((item) => item.id === attach.session.id), false)
  const afterLive = fs.existsSync(liveSessions) ? fs.readFileSync(liveSessions, 'utf8') : ''
  assert.equal(afterLive, before)
})

test('session --id --wait reaps a fake pid nonzero exit as failed', { timeout: 20000 }, (t) => {
  const dir = tempHub(t)
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

test('detach and edit --no-spawn enqueue the conversation prompt and finalize via fake pid', (t) => {
  const dir = tempHub(t)
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dir, 'overlay', 'prompts'), { recursive: true })
  fs.copyFileSync(path.join(hubRoot, 'overlay', 'prompts', 'detach.txt'), path.join(dir, 'overlay', 'prompts', 'detach.txt'))
  fs.copyFileSync(path.join(hubRoot, 'overlay', 'prompts', 'edit.txt'), path.join(dir, 'overlay', 'prompts', 'edit.txt'))
  const env = { HUB_ROOT: dir, HUB_SPAWN_CODEX: '0' }
  const detachTree = makeRecognizedWorktree(dir, 'detach-tree')
  fs.writeFileSync(path.join(dir, 'overlay', 'attached-worktrees.txt'), `${detachTree}\n`)
  const detach = parseStdout(
    spawnHub(['detach', '--worktree', detachTree, '--no-spawn'], { env }),
    'detach-enqueue'
  )
  assert.equal(detach.session.kind, 'detach')
  assert.equal(detach.session.status, 'queued')
  assert.equal(detach.applied, null)
  const detachPrompt = fs.readFileSync(detach.session.promptFile, 'utf8')
  assert.match(detachPrompt, /apply-legacy-detach/)
  assert.match(detachPrompt, new RegExp(detach.session.id))
  assert.match(detachPrompt, /--contract-v1/)
  assert.doesNotMatch(detachPrompt, /attached-worktrees|manage-skill-visibility|Remove-Item|Set-Content/)
  assert.doesNotMatch(detachPrompt, /等用户确认/)

  const edit = parseStdout(
    spawnHub(['edit', '--path', 'skills/ozdqp-development', '--intent', 'add a smoke line', '--no-spawn'], { env }),
    'edit-enqueue'
  )
  assert.equal(edit.session.kind, 'edit')
  assert.equal(edit.session.status, 'queued')
  const editPrompt = fs.readFileSync(edit.session.promptFile, 'utf8')
  assert.match(editPrompt, /skills\/ozdqp-development/)
  assert.match(editPrompt, /已挂接/)

  const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 300)'], {
    stdio: 'ignore',
    windowsHide: true
  })
  t.after(() => {
    try { child.kill() } catch { /* gone */ }
  })
  markRunningWithPid(dir, detach.session, child.pid, {
    exitCode: 0,
    log: 'session id: 0123456789abcdef0123456789abcdef\n',
    last: '验收摘要: attached=false officialPresent=true\n'
  })
  const settled = parseStdout(
    spawnHub(['session', '--id', detach.session.id, '--wait'], {
      env: { ...env, HUB_WAIT_TIMEOUT_MS: '10000' }
    }),
    'detach-wait'
  )
  assert.equal(settled.session.status, 'waiting')
  assert.equal(settled.session.exitCode, 0)
  assert.match(settled.session.summary || '', /attached=false/)
})

test('shipped Local SessionRunner owns Codex launch defaults while CLI stays a thin Application transport', () => {
  const cli = fs.readFileSync(path.join(hubRoot, 'dist', 'control', 'cli.js'), 'utf8')
  const runner = fs.readFileSync(path.join(hubRoot, 'dist', 'local', 'session', 'codex-session-runner.js'), 'utf8')
  assert.match(runner, /gpt-5\.6-luna/)
  assert.match(runner, /model_reasoning_effort/)
  assert.match(runner, /'-m'/)
  assert.match(runner, /Invoke-CimMethod/)
  assert.match(cli, /application\.execute/)
  assert.doesNotMatch(cli, /spawnSync|Invoke-CimMethod|model_reasoning_effort/)
  assert.doesNotMatch(runner, /manage-skill-visibility\.ps1/)
  assert.doesNotMatch(runner, /attach-library\.ps1/)
  assert.doesNotMatch(runner, /analyze-remote-skill-update\.ps1/)
})

test('CLI repair-links restores a broken fixture junction and rejects a dirty override', (t) => {
  const dir = tempHub(t)
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
  fs.writeFileSync(path.join(tree, 'AGENTS.md'), '# temporary recognized checkout\n')
  fs.mkdirSync(path.join(tree, 'baloot_client'), { recursive: true })
  const initialized = git(tree, ['init'])
  assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout)
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
