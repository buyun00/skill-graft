import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { hubRoot, spawnHub, testHubRoot } from './helpers.mjs'

function readOptional(file) {
  return fs.existsSync(file) ? fs.readFileSync(file) : null
}

function emittedFileFingerprint(file) {
  if (!fs.existsSync(file)) return { exists: false }
  const stat = fs.statSync(file, { bigint: true })
  return {
    exists: true,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
    bytes: fs.readFileSync(file)
  }
}

function checkedGit(cwd, args) {
  const result = spawnSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout.trim()
}

function victimFingerprint(root) {
  const index = path.join(root, '.git', 'index')
  return {
    head: checkedGit(root, ['rev-parse', 'HEAD']),
    status: checkedGit(root, ['status', '--porcelain=v1', '--untracked-files=all']),
    index: fs.readFileSync(index).toString('base64'),
    tracked: fs.readFileSync(path.join(root, 'victim.txt'), 'utf8')
  }
}

test('default CLI helper writes sessions only to its temporary fake-runner hub', (t) => {
  const liveSessions = path.join(hubRoot, 'skill-review', 'sessions.json')
  const liveHistory = path.join(hubRoot, 'skill-review', 'history')
  const beforeSessions = readOptional(liveSessions)
  const beforeHistory = fs.existsSync(liveHistory) ? fs.readdirSync(liveHistory).sort() : []
  const worktree = fs.mkdtempSync(path.join(testHubRoot, 'recognized-worktree-default-'))
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }))
  fs.mkdirSync(path.join(worktree, 'baloot_client'))
  fs.writeFileSync(path.join(worktree, 'AGENTS.md'), '# temporary recognized checkout\n')
  const initialized = spawnSync('git', ['-C', worktree, 'init'], { encoding: 'utf8', windowsHide: true })
  assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout)

  const result = spawnHub([
    'attach',
    '--worktree',
    worktree,
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

test('default suite isolates host homes, Git configuration, DSH, and global command lookup', () => {
  const isolatedRoot = path.dirname(path.resolve(process.env.TEMP || os.tmpdir()))
  for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'DSH_HOME', 'SKILL_GRAFT_HOME']) {
    const value = process.env[name]
    assert.ok(value, `${name} must be set`)
    const relative = path.relative(isolatedRoot, path.resolve(value))
    assert.equal(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), false, `${name} must stay under the isolated suite root`)
  }
  assert.equal(process.env.GIT_OPTIONAL_LOCKS, '0')
  assert.equal(process.env.GIT_TERMINAL_PROMPT, '0')
  assert.equal(process.env.GIT_CONFIG_NOSYSTEM, '1')
  assert.match(process.env.GIT_CONFIG_GLOBAL || '', /(?:NUL|dev[\\/]null)$/i)
  assert.match(process.env.GIT_CONFIG_SYSTEM || '', /(?:NUL|dev[\\/]null)$/i)
  assert.equal(process.env.SKILL_GRAFT_REAL_E2E, '0')
  assert.equal(process.env.HUB_SPAWN_CODEX, '0')
  assert.equal(path.resolve(process.env.SKILL_GRAFT_HOME), path.resolve(process.env.HUB_ROOT))
  for (const name of ['npm_config_cache', 'npm_config_prefix', 'npm_config_userconfig', 'npm_config_globalconfig']) {
    const value = process.env[name] || process.env[name.toUpperCase()]
    assert.ok(value, `${name} must be set`)
    const relative = path.relative(isolatedRoot, path.resolve(value))
    assert.equal(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), false, `${name} must stay isolated`)
  }
  assert.equal(fs.readFileSync(process.env.npm_config_userconfig || process.env.NPM_CONFIG_USERCONFIG, 'utf8'), '')
  assert.equal(fs.readFileSync(process.env.npm_config_globalconfig || process.env.NPM_CONFIG_GLOBALCONFIG, 'utf8'), '')

  for (const command of ['sg', 'dsh']) {
    const result = process.platform === 'win32'
      ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', command, '--version'], { encoding: 'utf8', windowsHide: true })
      : spawnSync(command, ['--version'], { encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 86, `${command} must resolve to the isolated blocker`)
    assert.match(result.stderr || result.stdout, /blocked by isolated default suite/)
  }
})

const hostileChild = process.env.SKILL_GRAFT_HOSTILE_ENV_CHILD === '1'

test('hostile wrapper child receives no inherited Git or Node injection variables', { skip: !hostileChild }, () => {
  for (const name of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_PARAMETERS',
    'GIT_CONFIG_KEY_0',
    'GIT_CONFIG_VALUE_0',
    'NODE_OPTIONS',
    'NODE_PATH',
    'NPM_CONFIG_REGISTRY',
    'NPM_CONFIG__AUTH',
    'NPM_CONFIG_TOKEN'
  ]) {
    assert.equal(process.env[name], undefined, `${name} must be scrubbed before tests start`)
  }
  const marker = process.env.SKILL_GRAFT_HOSTILE_ENV_ASSERTION
  assert.ok(marker, 'hostile child assertion marker is required')
  fs.writeFileSync(marker, 'scrubbed\n')
})

test('default-suite child scrubs hostile Git and Node env without touching a victim repository', { skip: hostileChild }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-hostile-wrapper-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const victim = path.join(root, 'victim')
  fs.mkdirSync(victim)
  checkedGit(victim, ['init'])
  checkedGit(victim, ['config', 'user.name', 'Skill Graft Safety Test'])
  checkedGit(victim, ['config', 'user.email', 'skill-graft@example.invalid'])
  fs.writeFileSync(path.join(victim, 'victim.txt'), 'must remain unchanged\n')
  checkedGit(victim, ['add', 'victim.txt'])
  checkedGit(victim, ['commit', '-m', 'victim baseline'])
  const before = victimFingerprint(victim)

  const sentinel = path.join(root, 'node-options-preload.txt')
  const environmentAssertion = path.join(root, 'environment-scrubbed.txt')
  const preload = path.join(root, 'hostile-preload.cjs')
  fs.writeFileSync(preload, [
    "const fs = require('node:fs')",
    "const rootOnly = process.env.SKILL_GRAFT_PRELOAD_ROOT_ONLY === '1'",
    "if (rootOnly) delete process.env.SKILL_GRAFT_PRELOAD_ROOT_ONLY",
    `else fs.appendFileSync(${JSON.stringify(sentinel)}, process.pid + '\\n')`
  ].join('\n'))

  const emittedBefore = [
    path.join(hubRoot, 'dist', 'control', 'cli.js'),
    path.join(hubRoot, 'dist', 'control', 'install.js')
  ].map(emittedFileFingerprint)

  const result = spawnSync(process.execPath, [
    path.join(hubRoot, 'test', 'support', 'run-default-suite.mjs'),
    '--verify-build-no-emit',
    'test/default-isolation.test.mjs'
  ], {
    cwd: hubRoot,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      SKILL_GRAFT_HOSTILE_ENV_CHILD: '1',
      SKILL_GRAFT_HOSTILE_ENV_ASSERTION: environmentAssertion,
      SKILL_GRAFT_PRELOAD_ROOT_ONLY: '1',
      GIT_DIR: path.join(victim, '.git'),
      GIT_WORK_TREE: victim,
      GIT_INDEX_FILE: path.join(victim, '.git', 'index'),
      GIT_OBJECT_DIRECTORY: path.join(victim, '.git', 'objects'),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_PARAMETERS: "'core.fsmonitor=true'",
      GIT_CONFIG_KEY_0: 'core.fsmonitor',
      GIT_CONFIG_VALUE_0: 'true',
      NPM_CONFIG_REGISTRY: 'https://hostile.invalid/',
      NPM_CONFIG__AUTH: 'hostile-placeholder',
      NPM_CONFIG_TOKEN: 'hostile-placeholder',
      NPM_CONFIG_USERCONFIG: path.join(victim, 'hostile.npmrc'),
      NPM_CONFIG_GLOBALCONFIG: path.join(victim, 'hostile-global.npmrc'),
      NODE_OPTIONS: `--require=${preload}`,
      NODE_PATH: victim
    }
  })
  assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join('\n'))
  assert.equal(fs.readFileSync(environmentAssertion, 'utf8'), 'scrubbed\n')
  assert.deepEqual(victimFingerprint(victim), before)
  assert.equal(fs.existsSync(sentinel), false, 'NODE_OPTIONS preload must not reach build or test children')
  assert.deepEqual([
    path.join(hubRoot, 'dist', 'control', 'cli.js'),
    path.join(hubRoot, 'dist', 'control', 'install.js')
  ].map(emittedFileFingerprint), emittedBefore, 'nested wrapper verification must not rewrite the shared dist tree')
})
