import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createInstallHost as createInstallHostAdapter } from '../dist/adapters/install-host.js'
import {
  daemonStatus,
  doctorHub,
  heartbeatMatchesInstance,
  installPathsFor,
  setupHub,
  startDaemonDetached,
  uninstallHub
} from '../dist/control/install.js'
import {
  apiProcessMatches,
  apiHeadersMatch,
  claimDaemonPid,
  daemonProcessMatches,
  reapDaemonSessions,
  reviewFiles,
  stopDaemon
} from '../dist/control/daemon.js'
import { renderShims, resolveInstallPaths } from '../dist/index.js'

const pathApi = {
  join: (...parts) => path.join(...parts),
  resolve: (...parts) => path.resolve(...parts),
  dirname: (value) => path.dirname(value),
  basename: (value) => path.basename(value)
}

const INSTALL_ENVIRONMENT_NAMES = [
  'SKILL_GRAFT_HOME', 'HUB_ROOT', 'SG_INSTALL_DIR', 'HUB_API_PORT',
  'SKILL_GRAFT_INVOCATION_TRACE', 'SKILL_GRAFT_REAL_E2E', 'SKILL_GRAFT_RUN_ID', 'SKILL_GRAFT_E2E_ROOT',
  'PATH', 'DSH_HOME', 'HOME', 'XDG_CONFIG_HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP',
  'HUB_SPAWN_CODEX', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_OPTIONAL_LOCKS'
]

function createInstallHost(overrides = {}) {
  if (!overrides.environment && !overrides.env) return createInstallHostAdapter(overrides)
  const environment = overrides.environment || (() => Object.fromEntries(
    INSTALL_ENVIRONMENT_NAMES
      .map((name) => [name, overrides.env?.(name)])
      .filter((entry) => entry[1] !== undefined)
  ))
  return createInstallHostAdapter({ ...overrides, environment })
}

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-lifecycle-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function seedRequiredDataAssets(root) {
  fs.mkdirSync(path.join(root, 'overlay', 'prompts'), { recursive: true })
  fs.writeFileSync(path.join(root, 'AGENTS.override.md'), '# fixture\n')
  for (const name of ['checkout-rules.txt', 'attach-library.ps1', 'manage-skill-visibility.ps1', 'analyze-remote-skill-update.ps1']) {
    fs.writeFileSync(path.join(root, 'overlay', name), '# fixture\n')
  }
  for (const name of ['attach', 'detach', 'edit', 'chat', 'analyze']) {
    fs.writeFileSync(path.join(root, 'overlay', 'prompts', `${name}.txt`), '# fixture\n')
  }
  for (const name of ['ozdqp-development', 'ozdqp-ui-development', 'ozdqp-git-workflow']) {
    const dir = path.join(root, 'skills', name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `# ${name}\n`)
  }
}

function seedInvocationTraceGate(container) {
  const runId = `trace-launcher-${path.basename(container).slice(-6)}`
  const runRoot = path.join(container, runId)
  const logsRoot = path.join(runRoot, 'logs')
  const pinned = tracePinnedEnvironment(runRoot)
  fs.mkdirSync(logsRoot, { recursive: true })
  for (const directory of [
    pinned.HOME,
    pinned.APPDATA,
    pinned.LOCALAPPDATA,
    pinned.TEMP,
    pinned.DSH_HOME,
    pinned.SKILL_GRAFT_HOME
  ]) fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(logsRoot, '.invocation-trace-key'), Buffer.alloc(32, 0x4c), { mode: 0o600 })
  fs.writeFileSync(path.join(runRoot, '.skill-graft-e2e-run.json'), `${JSON.stringify({
    version: 1,
    runId,
    runRoot
  })}\n`)
  return {
    runId,
    runRoot,
    env: {
      SKILL_GRAFT_INVOCATION_TRACE: '1',
      SKILL_GRAFT_REAL_E2E: '1',
      SKILL_GRAFT_RUN_ID: runId,
      SKILL_GRAFT_E2E_ROOT: runRoot,
      ...pinned
    }
  }
}

function tracePinnedEnvironment(runRoot) {
  const home = path.join(runRoot, 'home')
  return {
    PATH: path.join(home, 'safe-bin'),
    DSH_HOME: path.join(home, 'dsh-home'),
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, 'xdg-config'),
    USERPROFILE: home,
    APPDATA: path.join(home, 'appdata'),
    LOCALAPPDATA: path.join(home, 'localappdata'),
    TEMP: path.join(home, 'temp'),
    TMP: path.join(home, 'temp'),
    HUB_SPAWN_CODEX: '0',
    SKILL_GRAFT_HOME: path.join(runRoot, 'hub-data'),
    GIT_CONFIG_GLOBAL: 'NUL',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0'
  }
}

test('install paths keep package assets separate from mutable HUB_ROOT data', (t) => {
  const root = tempRoot(t)
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const paths = resolveInstallPaths(pathApi, {
    hubRoot: packageRoot,
    packageRoot,
    dataRoot,
    nodePath: process.execPath,
    installDir: path.join(root, 'install'),
    port: 21991
  })

  assert.equal(paths.packageRoot, path.resolve(packageRoot))
  assert.equal(paths.dataRoot, path.resolve(dataRoot))
  assert.equal(paths.hubRoot, paths.dataRoot)
  assert.equal(paths.cliPath, path.join(path.resolve(packageRoot), 'dist', 'control', 'cli.js'))
  assert.equal(paths.serverPath, path.join(path.resolve(packageRoot), 'server', 'index.mjs'))

  const shims = renderShims(paths)
  assert.match(shims.sgCmd, /if not defined SKILL_GRAFT_HOME if not defined HUB_ROOT set "_SKILL_GRAFT_DATA_ROOT_DEFAULT=1"/)
  assert.match(shims.sgCmd, /if defined _SKILL_GRAFT_DATA_ROOT_DEFAULT set "SKILL_GRAFT_HOME=/)
  assert.match(shims.sgCmd, /if defined _SKILL_GRAFT_DATA_ROOT_DEFAULT set "HUB_ROOT=/)
  assert.match(shims.sgCmd, new RegExp(escapeRegex(path.resolve(dataRoot))))
  assert.match(shims.runDaemonCmd, new RegExp(`cd /d "${escapeRegex(path.resolve(packageRoot))}"`))
  assert.match(shims.runDaemonCmd, /set "SKILL_GRAFT_HOME=/)
  assert.match(shims.runDaemonCmd, /set "HUB_ROOT=/)
  assert.doesNotMatch(shims.runDaemonCmd, /if not defined (?:SKILL_GRAFT_HOME|HUB_ROOT)/)
  assert.doesNotMatch(shims.runDaemonCmd, /SKILL_GRAFT_INVOCATION_TRACE|SKILL_GRAFT_REAL_E2E|SKILL_GRAFT_RUN_ID|SKILL_GRAFT_E2E_ROOT/)
  assert.match(shims.unix, /if \[ -z "\$\{SKILL_GRAFT_HOME-\}" \] && \[ -z "\$\{HUB_ROOT-\}" \]; then/)
  assert.match(shims.unix, /export SKILL_GRAFT_HOME HUB_ROOT HUB_API_PORT/)
  assert.doesNotMatch(shims.unix, /\$\{(?:SKILL_GRAFT_HOME|HUB_ROOT):-/)

  const traceRunRoot = path.join(root, 'trace-render-1234')
  const pinned = tracePinnedEnvironment(traceRunRoot)
  const tracePaths = { ...paths, dataRoot: pinned.SKILL_GRAFT_HOME, hubRoot: pinned.SKILL_GRAFT_HOME }
  const trace = renderShims(tracePaths, {
    runId: 'trace-render-1234',
    runRoot: traceRunRoot,
    pinned
  })
  assert.match(trace.runDaemonCmd, /for \/f "tokens=1 delims==" %%G in \('set GIT_ 2\^>nul'\) do set "%%G="/)
  assert.match(trace.runDaemonCmd, /for \/f "tokens=1 delims==" %%D in \('set DSH_ 2\^>nul'\) do set "%%D="/)
  for (const [name, value] of Object.entries(pinned)) {
    assert.match(trace.runDaemonCmd, new RegExp(`set "${name}=${escapeRegex(value)}"`), `${name} pin`)
  }
  const primaryAssignments = [...trace.runDaemonCmd.matchAll(/^set "SKILL_GRAFT_HOME=([^\r\n]*)"\r?$/gm)]
  const legacyAssignments = [...trace.runDaemonCmd.matchAll(/^set "HUB_ROOT=([^\r\n]*)"\r?$/gm)]
  assert.deepEqual(primaryAssignments.map((match) => match[1]), [pinned.SKILL_GRAFT_HOME])
  assert.deepEqual(legacyAssignments.map((match) => match[1]), [pinned.SKILL_GRAFT_HOME])
  assert.match(trace.runDaemonCmd, /set "SKILL_GRAFT_INVOCATION_TRACE=1"/)
  assert.match(trace.runDaemonCmd, /set "SKILL_GRAFT_REAL_E2E=1"/)
  assert.match(trace.runDaemonCmd, /set "SKILL_GRAFT_RUN_ID=trace-render-1234"/)
  assert.match(trace.runDaemonCmd, new RegExp(`set "SKILL_GRAFT_E2E_ROOT=${escapeRegex(path.join(root, 'trace-render-1234'))}"`))
  assert.doesNotMatch(trace.runDaemonCmd, /INVOCATION_TRACE_KEY|invocation-trace-key/)
})

test('setup pins validated trace gates only into the detached daemon launcher', async (t) => {
  const container = tempRoot(t)
  const gate = seedInvocationTraceGate(container)
  const packageRoot = path.join(gate.runRoot, 'app', 'node_modules', 'ozdqp-skill-hub')
  const dataRoot = path.join(gate.runRoot, 'hub-data')
  const installDir = path.join(gate.runRoot, 'home', 'install')
  seedRequiredDataAssets(dataRoot)
  fs.mkdirSync(path.join(packageRoot, 'dist', 'control'), { recursive: true })
  fs.writeFileSync(path.join(packageRoot, 'dist', 'control', 'cli.js'), '// fixture\n')
  const env = new Map([
    ['HUB_ROOT', dataRoot],
    ['HUB_API_PORT', '21990'],
    ['SG_INSTALL_DIR', installDir],
    ...Object.entries(gate.env)
  ])
  const mutatedPath = path.join(gate.runRoot, 'mutated-after-preflight')
  const host = createInstallHost({
    platform: 'win32',
    home: path.join(gate.runRoot, 'home'),
    localAppData: path.join(gate.runRoot, 'home'),
    skipPath: true,
    skipTask: false,
    env: (name) => env.get(name),
    extraShimDir: () => null,
    which: (name) => name === 'git' ? 'git.exe' : '',
    commandVersion: () => 'git version fixture',
    taskExists: () => {
      env.set('PATH', mutatedPath)
      return false
    },
    pidAlive: () => false,
    runNpm: () => { throw new Error('setup unexpectedly invoked npm') }
  })

  const result = await setupHub(packageRoot, {
    dryRun: false,
    json: true,
    noDaemon: true,
    noPath: true,
    noTask: true,
    rebuild: false
  }, host)
  assert.equal(result.steps.find((step) => step.id === 'shims')?.ok, true)
  const launcher = fs.readFileSync(path.join(installDir, 'run-daemon.cmd'), 'utf8')
  assert.match(launcher, /set "SKILL_GRAFT_INVOCATION_TRACE=1"/)
  assert.match(launcher, /set "SKILL_GRAFT_REAL_E2E=1"/)
  assert.match(launcher, new RegExp(`set "SKILL_GRAFT_RUN_ID=${escapeRegex(gate.runId)}"`))
  assert.match(launcher, new RegExp(`set "SKILL_GRAFT_E2E_ROOT=${escapeRegex(gate.runRoot)}"`))
  assert.match(launcher, /set GIT_ 2\^>nul/)
  assert.match(launcher, /set DSH_ 2\^>nul/)
  for (const [name, value] of Object.entries(gate.env).filter(([name]) => [
    'PATH',
    'DSH_HOME',
    'HOME',
    'XDG_CONFIG_HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'TEMP',
    'TMP',
    'HUB_SPAWN_CODEX',
    'SKILL_GRAFT_HOME',
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_NOSYSTEM',
    'GIT_OPTIONAL_LOCKS'
  ].includes(name))) {
    assert.match(launcher, new RegExp(`set "${name}=${escapeRegex(value)}"`), `${name} detached launcher pin`)
  }
  assert.equal((launcher.match(/^set "SKILL_GRAFT_HOME=/gm) || []).length, 1)
  assert.equal((launcher.match(/^set "HUB_ROOT=/gm) || []).length, 1)
  assert.doesNotMatch(launcher, new RegExp(escapeRegex(mutatedPath)))
  assert.doesNotMatch(launcher, /INVOCATION_TRACE_KEY|invocation-trace-key/)

  const normalShim = fs.readFileSync(path.join(installDir, 'bin', 'sg.cmd'), 'utf8')
  assert.doesNotMatch(normalShim, /SKILL_GRAFT_INVOCATION_TRACE|SKILL_GRAFT_REAL_E2E|SKILL_GRAFT_RUN_ID|SKILL_GRAFT_E2E_ROOT/)
})

test('setup refuses trace-gated detached launchers with unowned or unsafe pinned environments', async (t) => {
  for (const scenario of [
    { name: 'outside-home', mutate: (env, root) => env.set('HOME', path.join(root, 'outside-home')), pattern: /HOME must identify/ },
    { name: 'outside-xdg', mutate: (env, root) => env.set('XDG_CONFIG_HOME', path.join(root, 'outside-xdg')), pattern: /XDG_CONFIG_HOME must identify/ },
    { name: 'codex-enabled', mutate: (env) => env.set('HUB_SPAWN_CODEX', '1'), pattern: /HUB_SPAWN_CODEX=0/ },
    { name: 'cmd-injection', mutate: (env) => env.set('PATH', 'safe"\r\nset HOSTILE=1'), pattern: /unsafe for a cmd environment/ }
  ]) {
    const container = path.join(tempRoot(t), scenario.name)
    fs.mkdirSync(container)
    const gate = seedInvocationTraceGate(container)
    const packageRoot = path.join(gate.runRoot, 'app', 'node_modules', 'ozdqp-skill-hub')
    const dataRoot = path.join(gate.runRoot, 'hub-data')
    const installDir = path.join(gate.runRoot, 'home', 'install')
    seedRequiredDataAssets(dataRoot)
    fs.mkdirSync(path.join(packageRoot, 'dist', 'control'), { recursive: true })
    fs.writeFileSync(path.join(packageRoot, 'dist', 'control', 'cli.js'), '// fixture\n')
    const env = new Map([
      ['HUB_ROOT', dataRoot],
      ['HUB_API_PORT', '21990'],
      ['SG_INSTALL_DIR', installDir],
      ...Object.entries(gate.env)
    ])
    scenario.mutate(env, container)
    const host = createInstallHost({
      platform: 'win32',
      home: path.join(gate.runRoot, 'home'),
      localAppData: path.join(gate.runRoot, 'home'),
      skipPath: true,
      skipTask: true,
      env: (name) => env.get(name),
      extraShimDir: () => null,
      which: (name) => name === 'git' ? 'git.exe' : '',
      commandVersion: () => 'git version fixture',
      taskExists: () => false,
      pidAlive: () => false,
      runNpm: () => { throw new Error('setup unexpectedly invoked npm') }
    })

    const result = await setupHub(packageRoot, {
      dryRun: false,
      json: true,
      noDaemon: true,
      noPath: true,
      noTask: true,
      rebuild: false
    }, host)
    const trace = result.steps.find((step) => step.id === 'trace')
    assert.equal(trace?.ok, false, scenario.name)
    assert.match(trace?.detail || '', scenario.pattern, scenario.name)
    assert.equal(result.steps.find((step) => step.id === 'deps')?.skipped, true, scenario.name)
    assert.equal(result.steps.find((step) => step.id === 'layout')?.skipped, true, scenario.name)
    assert.equal(fs.existsSync(path.join(installDir, 'run-daemon.cmd')), false, scenario.name)
  }
})

test('setup preflight and detached start reject a trace root that differs from explicit dataRoot before mutations', async (t) => {
  const container = tempRoot(t)
  const gate = seedInvocationTraceGate(container)
  const packageRoot = path.join(gate.runRoot, 'app', 'node_modules', 'ozdqp-skill-hub')
  const selectedDataRoot = path.join(gate.runRoot, 'selected-other-data')
  const installDir = path.join(gate.runRoot, 'home', 'install')
  fs.mkdirSync(path.join(packageRoot, 'src'), { recursive: true })
  fs.mkdirSync(path.join(packageRoot, 'scripts'), { recursive: true })
  fs.mkdirSync(path.join(packageRoot, 'node_modules'), { recursive: true })
  fs.writeFileSync(path.join(packageRoot, 'scripts', 'clean-dist.mjs'), '// fixture\n')
  fs.writeFileSync(path.join(packageRoot, 'tsconfig.json'), '{}\n')
  const env = new Map([
    ['HUB_ROOT', gate.env.SKILL_GRAFT_HOME],
    ['HUB_API_PORT', '21990'],
    ['SG_INSTALL_DIR', installDir],
    ...Object.entries(gate.env)
  ])
  let launches = 0
  let dependencyProcesses = 0
  let hostEnvReads = 0
  const host = createInstallHost({
    platform: 'win32',
    home: path.join(gate.runRoot, 'home'),
    localAppData: path.join(gate.runRoot, 'home'),
    skipPath: true,
    skipTask: true,
    environment: () => Object.fromEntries(env),
    env: (name) => {
      hostEnvReads += 1
      if (name === 'SKILL_GRAFT_HOME') return path.join(gate.runRoot, 'contradictory-primary')
      if (name === 'HUB_ROOT') return path.join(gate.runRoot, 'contradictory-legacy')
      return 'contradictory-host-env-value'
    },
    extraShimDir: () => null,
    which: () => '',
    commandVersion: () => '',
    taskExists: () => false,
    pidAlive: () => false,
    wmiCreate: () => { launches += 1; return 0 },
    launchDetached: () => { launches += 1; return 0 },
    runNpm: () => { dependencyProcesses += 1; return { status: 0, stdout: '', stderr: '' } }
  })

  const setup = await setupHub(packageRoot, {
    dryRun: false,
    json: true,
    noDaemon: false,
    noPath: true,
    noTask: true,
    rebuild: false
  }, host, selectedDataRoot)
  const trace = setup.steps.find((step) => step.id === 'trace')
  assert.equal(trace?.ok, false)
  assert.match(trace?.detail || '', /SKILL_GRAFT_HOME must identify selected data root/)
  for (const id of ['deps', 'layout', 'shims', 'path', 'env', 'task', 'daemon']) {
    assert.equal(setup.steps.find((step) => step.id === id)?.skipped, true, id)
  }
  assert.equal(dependencyProcesses, 0)
  assert.equal(hostEnvReads, 0)
  assert.equal(launches, 0)
  assert.equal(fs.existsSync(selectedDataRoot), false)
  assert.equal(fs.existsSync(installDir), false)

  const result = await startDaemonDetached(packageRoot, host, selectedDataRoot)
  assert.equal(result.ok, false)
  assert.match(result.detail, /SKILL_GRAFT_HOME must identify selected data root/)
  assert.equal(hostEnvReads, 0)
  assert.equal(launches, 0)
  assert.equal(fs.existsSync(path.join(installDir, 'run-daemon.cmd')), false)
  assert.equal(fs.existsSync(path.join(installDir, 'silent-run.vbs')), false)
})

test('setup and detached start fail closed when an explicitly enabled trace gate is invalid', async (t) => {
  const root = tempRoot(t)
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  seedRequiredDataAssets(dataRoot)
  fs.mkdirSync(path.join(packageRoot, 'dist', 'control'), { recursive: true })
  fs.writeFileSync(path.join(packageRoot, 'dist', 'control', 'cli.js'), '// fixture\n')
  let launches = 0
  const env = new Map([
    ['HUB_ROOT', dataRoot],
    ['SG_INSTALL_DIR', installDir],
    ['SKILL_GRAFT_INVOCATION_TRACE', '1'],
    ['SKILL_GRAFT_REAL_E2E', '0']
  ])
  const host = createInstallHost({
    platform: 'win32',
    home: root,
    localAppData: root,
    skipPath: true,
    skipTask: true,
    env: (name) => env.get(name),
    extraShimDir: () => null,
    which: (name) => name === 'git' ? 'git.exe' : '',
    commandVersion: () => 'git version fixture',
    taskExists: () => false,
    pidAlive: () => false,
    wmiCreate: () => { launches += 1; return 0 },
    runNpm: () => { throw new Error('setup unexpectedly invoked npm') }
  })

  const setup = await setupHub(packageRoot, {
    dryRun: false,
    json: true,
    noDaemon: true,
    noPath: true,
    noTask: true,
    rebuild: false
  }, host)
  const trace = setup.steps.find((step) => step.id === 'trace')
  assert.equal(trace?.ok, false)
  assert.match(trace?.detail || '', /invocation trace gate is invalid/)
  assert.equal(setup.steps.find((step) => step.id === 'deps')?.skipped, true)
  assert.equal(setup.steps.find((step) => step.id === 'layout')?.skipped, true)
  assert.equal(fs.existsSync(path.join(installDir, 'run-daemon.cmd')), false)

  const started = await startDaemonDetached(packageRoot, host, dataRoot)
  assert.equal(started.ok, false)
  assert.match(started.detail, /invocation trace gate is invalid/)
  assert.equal(launches, 0)
})

test('CLI daemon stop supplies both lifecycle roots to PID verification', () => {
  const source = fs.readFileSync(new URL('../src/control/cli.ts', import.meta.url), 'utf8')
  assert.match(source, /stopDaemon\(dataRoot, undefined, packageRoot\)/)
})

test('setup preserves explicit HUB_ROOT and initializes only the data root', async (t) => {
  const root = tempRoot(t)
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  seedRequiredDataAssets(dataRoot)
  fs.mkdirSync(path.join(packageRoot, 'dist', 'control'), { recursive: true })
  fs.writeFileSync(path.join(packageRoot, 'dist', 'control', 'cli.js'), '// fixture\n')

  const env = new Map([
    ['HUB_ROOT', dataRoot],
    ['HUB_API_PORT', '21992'],
    ['SG_INSTALL_DIR', installDir]
  ])
  const userEnvWrites = []
  const host = createInstallHost({
    platform: 'win32',
    home: root,
    localAppData: root,
    skipPath: false,
    skipTask: true,
    env: (name) => env.get(name),
    extraShimDir: () => null,
    userPath: () => path.join(installDir, 'bin'),
    setUserPath: () => {},
    setUserEnv: (name, value) => userEnvWrites.push([name, value]),
    broadcastEnv: () => {},
    which: (name) => name === 'git' ? 'git.exe' : '',
    commandVersion: () => 'git version fixture',
    taskExists: () => false,
    pidAlive: () => false,
    runNpm: () => { throw new Error('setup unexpectedly invoked npm') }
  })

  const paths = installPathsFor(packageRoot, host)
  assert.equal(paths.packageRoot, path.resolve(packageRoot))
  assert.equal(paths.dataRoot, path.resolve(dataRoot))

  const result = await setupHub(packageRoot, {
    dryRun: false,
    json: true,
    noDaemon: true,
    noPath: false,
    noTask: true,
    rebuild: false
  }, host)

  assert.equal(result.hubRoot, path.resolve(dataRoot))
  assert.match(result.steps.find((step) => step.id === 'deps')?.detail || '', /prebuilt/)
  assert.equal(fs.existsSync(path.join(dataRoot, 'skill-review', 'state.json')), true)
  assert.equal(fs.existsSync(path.join(packageRoot, 'skill-review')), false)
  assert.deepEqual(userEnvWrites.filter(([name]) => name === 'SKILL_GRAFT_HOME' || name === 'HUB_ROOT'), [
    ['SKILL_GRAFT_HOME', path.resolve(dataRoot)]
  ])
  const shim = fs.readFileSync(paths.shimCmd, 'utf8')
  assert.match(shim, /if not defined HUB_ROOT/)
  assert.match(shim, new RegExp(escapeRegex(path.resolve(dataRoot))))
  assert.match(shim, new RegExp(escapeRegex(paths.cliPath)))
})

test('setup fails closed when an explicit data root lacks immutable assets', async (t) => {
  const root = tempRoot(t)
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'empty-data')
  const installDir = path.join(root, 'install')
  fs.mkdirSync(path.join(packageRoot, 'dist', 'control'), { recursive: true })
  fs.writeFileSync(path.join(packageRoot, 'dist', 'control', 'cli.js'), '// fixture\n')
  const env = new Map([
    ['HUB_ROOT', dataRoot],
    ['SG_INSTALL_DIR', installDir]
  ])
  const host = createInstallHost({
    platform: 'win32',
    home: root,
    localAppData: root,
    skipPath: true,
    skipTask: true,
    env: (name) => env.get(name),
    extraShimDir: () => null,
    which: (name) => name === 'git' ? 'git.exe' : '',
    commandVersion: () => 'git version fixture',
    taskExists: () => false,
    pidAlive: () => false,
    runNpm: () => { throw new Error('setup unexpectedly invoked npm') }
  })

  const result = await setupHub(packageRoot, {
    dryRun: false,
    json: true,
    noDaemon: true,
    noPath: true,
    noTask: true,
    rebuild: false
  }, host)

  assert.equal(result.ok, false)
  assert.equal(fs.existsSync(path.join(dataRoot, 'skill-review', 'state.json')), true)
  assert.equal(fs.existsSync(path.join(packageRoot, 'skill-review')), false)
  assert.ok(result.doctor.layout.missing.includes(path.join(dataRoot, 'AGENTS.override.md')))
  assert.ok(result.doctor.layout.missing.includes(path.join(dataRoot, 'skills', 'ozdqp-development', 'SKILL.md')))
})

test('setup halts every external lifecycle mutation after required data assets fail', async (t) => {
  const root = tempRoot(t)
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'empty-data')
  const installDir = path.join(root, 'install')
  fs.mkdirSync(path.join(packageRoot, 'dist', 'control'), { recursive: true })
  fs.writeFileSync(path.join(packageRoot, 'dist', 'control', 'cli.js'), '// fixture\n')
  const mutations = []
  const host = createInstallHost({
    platform: 'win32',
    home: root,
    localAppData: root,
    skipPath: false,
    skipTask: false,
    env: (name) => {
      if (name === 'HUB_ROOT') return dataRoot
      if (name === 'SG_INSTALL_DIR') return installDir
      return undefined
    },
    extraShimDir: () => null,
    which: (name) => name === 'git' ? 'git.exe' : '',
    commandVersion: () => 'git version fixture',
    userPath: () => 'C:\\Windows',
    setUserPath: () => mutations.push('path'),
    setUserEnv: () => mutations.push('env'),
    broadcastEnv: () => mutations.push('broadcast'),
    taskExists: () => false,
    registerLogonTask: () => mutations.push('task'),
    unregisterTask: () => mutations.push('unregister-task'),
    pidAlive: () => false,
    wmiCreate: () => { mutations.push('daemon'); return 0 },
    runNpm: () => { throw new Error('setup unexpectedly invoked npm') }
  })

  const result = await setupHub(packageRoot, {
    dryRun: false,
    json: true,
    noDaemon: false,
    noPath: false,
    noTask: false,
    rebuild: false
  }, host)

  assert.equal(result.ok, false)
  assert.equal(result.steps.find((step) => step.id === 'layout')?.ok, false)
  for (const id of ['shims', 'path', 'env', 'task', 'daemon']) {
    assert.equal(result.steps.find((step) => step.id === id)?.skipped, true, `${id} must be skipped`)
  }
  assert.deepEqual(mutations, [])
  assert.equal(fs.existsSync(installDir), false)
})

test('setup trace preflight halts deps, layout, PATH, task, and daemon mutations', async (t) => {
  const root = tempRoot(t)
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  seedRequiredDataAssets(dataRoot)
  fs.mkdirSync(path.join(packageRoot, 'dist', 'control'), { recursive: true })
  fs.writeFileSync(path.join(packageRoot, 'dist', 'control', 'cli.js'), '// fixture\n')
  const mutations = []
  const host = createInstallHost({
    platform: 'win32',
    home: root,
    localAppData: root,
    skipPath: false,
    skipTask: false,
    env: (name) => {
      if (name === 'HUB_ROOT') return dataRoot
      if (name === 'SG_INSTALL_DIR') return installDir
      if (name === 'SKILL_GRAFT_INVOCATION_TRACE') return '1'
      if (name === 'SKILL_GRAFT_REAL_E2E') return '0'
      return undefined
    },
    extraShimDir: () => null,
    which: (name) => name === 'git' ? 'git.exe' : '',
    commandVersion: () => 'git version fixture',
    userPath: () => 'C:\\Windows',
    setUserPath: () => mutations.push('path'),
    setUserEnv: () => mutations.push('env'),
    broadcastEnv: () => mutations.push('broadcast'),
    taskExists: () => false,
    registerLogonTask: () => mutations.push('task'),
    unregisterTask: () => mutations.push('unregister-task'),
    pidAlive: () => false,
    wmiCreate: () => { mutations.push('daemon'); return 0 },
    runNpm: () => { throw new Error('setup unexpectedly invoked npm') }
  })

  const result = await setupHub(packageRoot, {
    dryRun: false,
    json: true,
    noDaemon: false,
    noPath: false,
    noTask: false,
    rebuild: false
  }, host)

  assert.equal(result.ok, false)
  assert.equal(result.steps.find((step) => step.id === 'trace')?.ok, false)
  for (const id of ['deps', 'layout', 'shims', 'path', 'env', 'task', 'daemon']) {
    assert.equal(result.steps.find((step) => step.id === id)?.skipped, true, `${id} must be skipped`)
  }
  assert.deepEqual(mutations, [])
  assert.equal(fs.existsSync(path.join(installDir, 'run-daemon.cmd')), false)
})

test('daemon status reads pid and heartbeat only from dataRoot', async (t) => {
  const root = tempRoot(t)
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const wrong = reviewFiles(packageRoot)
  const expected = reviewFiles(dataRoot)
  fs.mkdirSync(wrong.review, { recursive: true })
  fs.mkdirSync(expected.review, { recursive: true })
  fs.writeFileSync(wrong.pidFile, '111\n')
  fs.writeFileSync(expected.pidFile, '222\n')
  fs.writeFileSync(expected.apiPidFile, '333\n')
  fs.writeFileSync(expected.heartbeatFile, `${JSON.stringify({
    pid: 222,
    apiPid: 333,
    packageRoot,
    dataRoot,
    port: 21993,
    apiHealthy: true,
    lastBeat: new Date().toISOString()
  })}\n`)

  const host = createInstallHost({
    env: (name) => name === 'HUB_API_PORT' ? '21993' : undefined,
    skipPath: true,
    skipTask: true,
    extraShimDir: () => null,
    taskExists: () => false,
    pidAlive: (pid) => pid === 222 || pid === 333,
    processCommandLine: (pid) => pid === 222
      ? `node "${path.join(packageRoot, 'dist', 'control', 'cli.js')}" daemon run`
      : `node "${path.join(packageRoot, 'server', 'index.mjs')}"`
  })
  const status = await daemonStatus(packageRoot, host, dataRoot)

  assert.equal(status.running, true)
  assert.equal(status.pid, 222)
  assert.equal(status.apiPid, 333)
  assert.equal(status.apiHealthy, true)
  assert.equal(status.heartbeat.dataRoot, dataRoot)
})

test('daemon status does not trust a fresh healthy heartbeat after the daemon stopped', async (t) => {
  const root = tempRoot(t)
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const files = reviewFiles(dataRoot)
  fs.mkdirSync(files.review, { recursive: true })
  fs.writeFileSync(files.pidFile, '444\n')
  fs.writeFileSync(files.heartbeatFile, `${JSON.stringify({
    pid: 444,
    apiPid: 445,
    dataRoot,
    apiHealthy: true,
    lastBeat: new Date().toISOString()
  })}\n`)
  const host = createInstallHost({
    env: (name) => name === 'HUB_API_PORT' ? '21994' : undefined,
    skipPath: true,
    skipTask: true,
    extraShimDir: () => null,
    taskExists: () => false,
    pidAlive: () => false
  })
  const status = await daemonStatus(packageRoot, host, dataRoot)
  assert.equal(status.running, false)
  assert.equal(status.pid, 0)
  assert.equal(status.apiHealthy, false)
})

test('daemon and API process identity requires an exact package entry token', () => {
  const packageRoot = path.resolve('package-command-fixture')
  const daemonEntry = path.join(packageRoot, 'dist', 'control', 'cli.js')
  const apiEntry = path.join(packageRoot, 'server', 'index.mjs')
  const host = createInstallHost({
    processCommandLine: (pid) => pid === 1
      ? `node "${daemonEntry}.other" daemon run`
      : `node "${apiEntry}.other"`
  })
  assert.equal(daemonProcessMatches(host, 1, packageRoot), false)
  assert.equal(apiProcessMatches(host, 2, packageRoot), false)
  host.processCommandLine = (pid) => pid === 1
    ? `evil.exe "${daemonEntry}" daemon run`
    : `evil.exe --payload "${apiEntry}"`
  assert.equal(daemonProcessMatches(host, 1, packageRoot), false)
  assert.equal(apiProcessMatches(host, 2, packageRoot), false)
  host.processCommandLine = (pid) => pid === 1
    ? `node -e "noop" "${daemonEntry}" daemon run`
    : `node -e "noop" "${apiEntry}"`
  assert.equal(daemonProcessMatches(host, 1, packageRoot), false)
  assert.equal(apiProcessMatches(host, 2, packageRoot), false)
  host.processCommandLine = (pid) => pid === 1
    ? `node "${daemonEntry}" daemon run`
    : `node "${apiEntry}"`
  assert.equal(daemonProcessMatches(host, 1, packageRoot), true)
  assert.equal(apiProcessMatches(host, 2, packageRoot), true)
})

test('daemon status rejects an unowned API pid even with a fresh healthy heartbeat', async (t) => {
  const root = tempRoot(t)
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const files = reviewFiles(dataRoot)
  fs.mkdirSync(files.review, { recursive: true })
  fs.writeFileSync(files.pidFile, '501\n')
  fs.writeFileSync(files.apiPidFile, '502\n')
  fs.writeFileSync(files.heartbeatFile, `${JSON.stringify({
    pid: 501,
    apiPid: 502,
    packageRoot,
    dataRoot,
    port: 21996,
    apiHealthy: true,
    lastBeat: new Date().toISOString()
  })}\n`)
  const host = createInstallHost({
    env: (name) => name === 'HUB_API_PORT' ? '21996' : undefined,
    skipPath: true,
    skipTask: true,
    extraShimDir: () => null,
    taskExists: () => false,
    pidAlive: () => true,
    processCommandLine: (pid) => pid === 501
      ? `node "${path.join(packageRoot, 'dist', 'control', 'cli.js')}" daemon run`
      : `node "${path.join(packageRoot, 'server', 'index.mjs')}.other"`
  })

  const status = await daemonStatus(packageRoot, host, dataRoot)
  assert.equal(status.running, true)
  assert.equal(status.apiPid, 0)
  assert.equal(status.apiHealthy, false)
  assert.equal(status.ok, false)
})

test('daemon status rejects a live daemon whose heartbeat belongs to another data root or port', async (t) => {
  const root = tempRoot(t)
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const files = reviewFiles(dataRoot)
  fs.mkdirSync(files.review, { recursive: true })
  fs.writeFileSync(files.pidFile, '511\n')
  fs.writeFileSync(files.apiPidFile, '512\n')
  fs.writeFileSync(files.heartbeatFile, `${JSON.stringify({
    pid: 511,
    apiPid: 512,
    packageRoot,
    dataRoot: `${dataRoot}-other`,
    port: 22996,
    apiHealthy: true,
    lastBeat: new Date().toISOString()
  })}\n`)
  const host = createInstallHost({
    env: (name) => name === 'HUB_API_PORT' ? '21996' : undefined,
    skipPath: true,
    skipTask: true,
    extraShimDir: () => null,
    taskExists: () => false,
    pidAlive: () => true,
    processCommandLine: (pid) => pid === 511
      ? `node "${path.join(packageRoot, 'dist', 'control', 'cli.js')}" daemon run`
      : `node "${path.join(packageRoot, 'server', 'index.mjs')}"`
  })

  const status = await daemonStatus(packageRoot, host, dataRoot)
  assert.equal(status.running, false)
  assert.equal(status.pid, 0)
  assert.equal(status.apiPid, 0)
  assert.equal(status.apiHealthy, false)
  assert.equal(status.ok, false)
  const doctor = await doctorHub(packageRoot, host, dataRoot)
  assert.equal(doctor.daemon.running, false)
  assert.equal(doctor.daemon.pid, 0)
})

test('daemon emits reap command only when the Local runner reports a terminal process', async () => {
  const commands = []
  const local = {
    localSessions: { needsReap: () => false },
    commandMeta: () => ({ requestId: 'daemon-request' }),
    application: {
      execute: async (command) => {
        commands.push(command)
        return { ok: true, data: {} }
      }
    }
  }

  assert.equal(await reapDaemonSessions(local), false)
  assert.equal(commands.length, 0)

  local.localSessions.needsReap = () => true
  assert.equal(await reapDaemonSessions(local), true)
  assert.equal(commands.length, 1)
  assert.equal(commands[0].kind, 'reapSessions')
})

test('heartbeat validation rejects future, stale, and cross-instance records', () => {
  const expected = {
    pid: 10,
    apiPid: 11,
    packageRoot: path.resolve('package-fixture'),
    dataRoot: path.resolve('data-fixture'),
    port: 21995
  }
  const now = Date.now()
  const heartbeat = {
    ...expected,
    apiHealthy: true,
    lastBeat: new Date(now - 1000).toISOString()
  }
  assert.equal(heartbeatMatchesInstance(heartbeat, expected, 20000, now), true)
  assert.equal(heartbeatMatchesInstance({ ...heartbeat, lastBeat: new Date(now + 1).toISOString() }, expected, 20000, now), false)
  assert.equal(heartbeatMatchesInstance({ ...heartbeat, pid: 99 }, expected, 20000, now), false)
  assert.equal(heartbeatMatchesInstance({ ...heartbeat, dataRoot: `${expected.dataRoot}-other` }, expected, 20000, now), false)
})

test('API instance headers must identify both expected roots', () => {
  const packageRoot = path.resolve('package-header-fixture')
  const dataRoot = path.resolve('data-header-fixture')
  const values = new Map([
    ['x-skill-graft-package-root', encodeURIComponent(packageRoot)],
    ['x-skill-graft-data-root', encodeURIComponent(dataRoot)]
  ])
  const headers = { get: (name) => values.get(name.toLowerCase()) || null }
  assert.equal(apiHeadersMatch(headers, { packageRoot, dataRoot }), true)
  assert.equal(apiHeadersMatch(headers, { packageRoot, dataRoot: `${dataRoot}-other` }), false)
  assert.equal(apiHeadersMatch({ get: () => null }, { packageRoot, dataRoot }), false)
})

test('daemon pid claim is exclusive and recognizes the verified existing owner', (t) => {
  const root = tempRoot(t)
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const port = 21997
  const files = reviewFiles(dataRoot)
  const pidFile = files.pidFile
  const ownerPid = 90101
  const host = createInstallHost({
    env: (name) => name === 'HUB_API_PORT' ? String(port) : undefined,
    pidAlive: (pid) => pid === ownerPid,
    processCommandLine: (pid) => pid === ownerPid
      ? `node "${path.join(packageRoot, 'dist', 'control', 'cli.js')}" daemon run`
      : ''
  })
  const claimed = claimDaemonPid(pidFile, host, packageRoot, ownerPid)
  assert.equal(claimed.claimed, true)
  assert.equal(fs.readFileSync(pidFile, 'utf8').trim(), String(ownerPid))
  fs.writeFileSync(files.heartbeatFile, `${JSON.stringify({
    pid: ownerPid,
    apiPid: 0,
    packageRoot,
    dataRoot,
    port,
    lastBeat: new Date().toISOString()
  })}\n`)
  const competing = claimDaemonPid(pidFile, host, packageRoot, ownerPid + 1, dataRoot, port)
  assert.equal(competing.claimed, false)
  assert.equal(competing.reason, 'already-running')
  assert.equal(fs.readFileSync(pidFile, 'utf8').trim(), String(ownerPid))
})

test('daemon stop preserves every marker unless the full instance and entries are verified', (t) => {
  const root = tempRoot(t)
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const files = reviewFiles(dataRoot)
  fs.mkdirSync(files.review, { recursive: true })
  const port = 21998
  const writeState = (overrides = {}) => {
    fs.writeFileSync(files.pidFile, '701\n')
    fs.writeFileSync(files.apiPidFile, '702\n')
    fs.writeFileSync(files.heartbeatFile, `${JSON.stringify({
      pid: 701,
      apiPid: 702,
      packageRoot,
      dataRoot,
      port,
      lastBeat: new Date().toISOString(),
      ...overrides
    })}\n`)
  }
  writeState()
  const killed = []
  const live = new Set([701, 702])
  const host = createInstallHost({
    env: (name) => name === 'HUB_API_PORT' ? String(port) : undefined,
    pidAlive: (pid) => live.has(pid),
    processCommandLine: () => 'node unrelated.js',
    killPid: (pid) => {
      killed.push(pid)
      live.delete(pid)
      return true
    }
  })
  assert.equal(stopDaemon(dataRoot, host, packageRoot), false)
  assert.deepEqual(killed, [])
  assert.equal(fs.existsSync(files.pidFile), true)
  assert.equal(fs.existsSync(files.apiPidFile), true)
  assert.equal(fs.existsSync(files.heartbeatFile), true)

  writeState()
  host.processCommandLine = (pid) => pid === 701
    ? `node "${path.join(packageRoot, 'dist', 'control', 'cli.js')}" daemon run`
    : `node "${path.join(packageRoot, 'server', 'index.mjs')}"`
  assert.equal(stopDaemon(dataRoot, host, packageRoot), true)
  assert.deepEqual(killed, [701, 702])
  assert.equal(fs.existsSync(files.pidFile), false)
  assert.equal(fs.existsSync(files.apiPidFile), false)
  assert.equal(fs.existsSync(files.heartbeatFile), false)
})

test('daemon stop preserves every marker for failed, no-op, and slow process termination', (t) => {
  const root = tempRoot(t)
  const packageRoot = path.join(root, 'package')
  const port = 22003
  for (const scenario of [
    { name: 'failed', killResult: false, waitResult: true, expectedWaits: 0 },
    { name: 'no-op', killResult: true, waitResult: true, expectedWaits: 1 },
    { name: 'slow', killResult: true, waitResult: false, expectedWaits: 1 }
  ]) {
    const dataRoot = path.join(root, scenario.name)
    const files = reviewFiles(dataRoot)
    fs.mkdirSync(files.review, { recursive: true })
    fs.writeFileSync(files.pidFile, '801\n')
    fs.writeFileSync(files.apiPidFile, '802\n')
    fs.writeFileSync(files.heartbeatFile, `${JSON.stringify({
      pid: 801,
      apiPid: 802,
      packageRoot,
      dataRoot,
      port,
      lastBeat: new Date().toISOString()
    })}\n`)
    const markerBytes = [files.pidFile, files.apiPidFile, files.heartbeatFile].map((file) => fs.readFileSync(file))
    const killed = []
    let waits = 0
    const host = createInstallHost({
      env: (name) => name === 'HUB_API_PORT' ? String(port) : undefined,
      pidAlive: (pid) => pid === 801 || pid === 802,
      processCommandLine: (pid) => pid === 801
        ? `node "${path.join(packageRoot, 'dist', 'control', 'cli.js')}" daemon run`
        : `node "${path.join(packageRoot, 'server', 'index.mjs')}"`,
      killPid: (pid) => { killed.push(pid); return scenario.killResult },
      waitForPidsExit: () => { waits += 1; return scenario.waitResult }
    })

    assert.equal(stopDaemon(dataRoot, host, packageRoot, port), false, `${scenario.name} termination must fail closed`)
    assert.deepEqual(killed, [801, 802], `${scenario.name} kill attempts`)
    assert.equal(waits, scenario.expectedWaits, `${scenario.name} bounded wait count`)
    for (const [index, file] of [files.pidFile, files.apiPidFile, files.heartbeatFile].entries()) {
      assert.deepEqual(fs.readFileSync(file), markerBytes[index], `${scenario.name} preserves ${path.basename(file)}`)
    }
  }
})

test('daemon stop fails closed for missing, corrupt, and cross-instance heartbeat state', (t) => {
  const root = tempRoot(t)
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const files = reviewFiles(dataRoot)
  const port = 21999
  fs.mkdirSync(files.review, { recursive: true })
  const killed = []
  const host = createInstallHost({
    env: (name) => name === 'HUB_API_PORT' ? String(port) : undefined,
    pidAlive: (pid) => pid === 711 || pid === 712,
    processCommandLine: (pid) => pid === 711
      ? `node "${path.join(packageRoot, 'dist', 'control', 'cli.js')}" daemon run`
      : `node "${path.join(packageRoot, 'server', 'index.mjs')}"`,
    killPid: (pid) => { killed.push(pid); return true }
  })
  const writePids = () => {
    fs.writeFileSync(files.pidFile, '711\n')
    fs.writeFileSync(files.apiPidFile, '712\n')
  }
  const assertPreserved = () => {
    assert.equal(stopDaemon(dataRoot, host, packageRoot, port), false)
    assert.equal(fs.existsSync(files.pidFile), true)
    assert.equal(fs.existsSync(files.apiPidFile), true)
    assert.equal(fs.existsSync(files.heartbeatFile), true)
    assert.deepEqual(killed, [])
  }

  writePids()
  fs.writeFileSync(files.heartbeatFile, '{corrupt')
  assertPreserved()
  fs.writeFileSync(files.heartbeatFile, `${JSON.stringify({
    pid: 711,
    apiPid: 712,
    packageRoot,
    dataRoot: `${dataRoot}-other`,
    port,
    lastBeat: new Date().toISOString()
  })}\n`)
  assertPreserved()
  fs.writeFileSync(files.heartbeatFile, `${JSON.stringify({
    pid: 711,
    apiPid: 712,
    packageRoot,
    dataRoot,
    port: port + 1,
    lastBeat: new Date().toISOString()
  })}\n`)
  assertPreserved()
  fs.rmSync(files.heartbeatFile)
  assert.equal(stopDaemon(dataRoot, host, packageRoot, port), false)
  assert.equal(fs.existsSync(files.pidFile), true)
  assert.equal(fs.existsSync(files.apiPidFile), true)
  assert.equal(fs.existsSync(files.heartbeatFile), false)
  assert.deepEqual(killed, [])
})

test('daemon stop revalidates strict ownership immediately before the first kill', (t) => {
  const root = tempRoot(t)
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const files = reviewFiles(dataRoot)
  const port = 22008
  fs.mkdirSync(files.review, { recursive: true })
  fs.writeFileSync(files.pidFile, '821\n')
  fs.writeFileSync(files.apiPidFile, '822\n')
  fs.writeFileSync(files.heartbeatFile, `${JSON.stringify({
    pid: 821,
    apiPid: 822,
    packageRoot,
    dataRoot,
    port,
    lastBeat: new Date().toISOString()
  })}\n`)
  const calls = new Map()
  const killed = []
  const host = createInstallHost({
    env: (name) => name === 'HUB_API_PORT' ? String(port) : undefined,
    pidAlive: (pid) => pid === 821 || pid === 822,
    processCommandLine: (pid) => {
      const count = (calls.get(pid) || 0) + 1
      calls.set(pid, count)
      if (pid === 821 && count >= 3) return 'evil.exe unrelated.js'
      return pid === 821
        ? `node "${path.join(packageRoot, 'dist', 'control', 'cli.js')}" daemon run`
        : `node "${path.join(packageRoot, 'server', 'index.mjs')}"`
    },
    killPid: (pid) => { killed.push(pid); return true }
  })

  assert.equal(stopDaemon(dataRoot, host, packageRoot, port), false)
  assert.deepEqual(killed, [])
  assert.equal(fs.readFileSync(files.pidFile, 'utf8').trim(), '821')
  assert.equal(fs.readFileSync(files.apiPidFile, 'utf8').trim(), '822')
  assert.equal(fs.existsSync(files.heartbeatFile), true)
})

test('detached start safely stops its verified daemon and API after health acceptance times out', async (t) => {
  const root = tempRoot(t)
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  const files = reviewFiles(dataRoot)
  const port = 22009
  fs.mkdirSync(path.join(packageRoot, 'dist', 'control'), { recursive: true })
  fs.mkdirSync(path.join(packageRoot, 'server'), { recursive: true })
  fs.writeFileSync(path.join(packageRoot, 'dist', 'control', 'cli.js'), '// fixture\n')
  fs.writeFileSync(path.join(packageRoot, 'server', 'index.mjs'), '// fixture\n')
  const live = new Set()
  const killed = []
  const host = createInstallHost({
    platform: 'win32',
    home: root,
    localAppData: root,
    skipPath: true,
    skipTask: true,
    env: (name) => {
      if (name === 'HUB_ROOT') return dataRoot
      if (name === 'HUB_API_PORT') return String(port)
      if (name === 'SG_INSTALL_DIR') return installDir
      return undefined
    },
    extraShimDir: () => null,
    pidAlive: (pid) => live.has(pid),
    processCommandLine: (pid) => pid === 831
      ? `node "${path.join(packageRoot, 'dist', 'control', 'cli.js')}" daemon run`
      : `node "${path.join(packageRoot, 'server', 'index.mjs')}"`,
    killPid: (pid) => { killed.push(pid); live.delete(pid); return true },
    waitForPidsExit: (pids) => pids.every((pid) => !live.has(pid)),
    wmiCreate: () => {
      fs.mkdirSync(files.review, { recursive: true })
      fs.writeFileSync(files.pidFile, '831\n')
      fs.writeFileSync(files.apiPidFile, '832\n')
      fs.writeFileSync(files.heartbeatFile, `${JSON.stringify({
        pid: 831,
        apiPid: 832,
        packageRoot,
        dataRoot,
        port,
        lastBeat: new Date().toISOString()
      })}\n`)
      live.add(831)
      live.add(832)
      return 830
    }
  })
  let clock = 0
  const result = await startDaemonDetached(packageRoot, host, dataRoot, {
    now: () => { clock += 13000; return clock },
    sleep: async () => {},
    ping: async () => false
  })

  assert.equal(result.ok, false)
  assert.equal(result.pid, 0)
  assert.equal(result.apiHealthy, false)
  assert.match(result.detail, /partial launch was safely stopped/)
  assert.deepEqual(killed, [831, 832])
  assert.deepEqual([...live], [])
  assert.equal(fs.existsSync(files.pidFile), false)
  assert.equal(fs.existsSync(files.apiPidFile), false)
  assert.equal(fs.existsSync(files.heartbeatFile), false)
})

test('daemon start refuses same-package live markers bound to another data root or port', async (t) => {
  const root = tempRoot(t)
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const files = reviewFiles(dataRoot)
  const port = 22000
  fs.mkdirSync(files.review, { recursive: true })
  fs.writeFileSync(files.pidFile, '721\n')
  fs.writeFileSync(files.apiPidFile, '722\n')
  fs.writeFileSync(files.heartbeatFile, `${JSON.stringify({
    pid: 721,
    apiPid: 722,
    packageRoot,
    dataRoot: `${dataRoot}-other`,
    port: port + 1,
    lastBeat: new Date().toISOString()
  })}\n`)
  const mutations = []
  const host = createInstallHost({
    env: (name) => {
      if (name === 'HUB_ROOT') return dataRoot
      if (name === 'HUB_API_PORT') return String(port)
      if (name === 'SG_INSTALL_DIR') return path.join(root, 'install')
      return undefined
    },
    skipPath: true,
    skipTask: true,
    extraShimDir: () => null,
    pidAlive: (pid) => pid === 721 || pid === 722,
    processCommandLine: (pid) => pid === 721
      ? `node "${path.join(packageRoot, 'dist', 'control', 'cli.js')}" daemon run`
      : `node "${path.join(packageRoot, 'server', 'index.mjs')}"`,
    killPid: (pid) => { mutations.push(`kill:${pid}`); return true },
    wmiCreate: () => { mutations.push('launch'); return 0 }
  })

  const result = await startDaemonDetached(packageRoot, host, dataRoot)
  assert.equal(result.ok, false)
  assert.match(result.detail, /instance binding is unverified/)
  assert.deepEqual(mutations, [])
  assert.equal(fs.readFileSync(files.pidFile, 'utf8').trim(), '721')
  assert.equal(fs.readFileSync(files.apiPidFile, 'utf8').trim(), '722')
})

test('uninstall aborts without removing any state when daemon ownership is unverified', async (t) => {
  const root = tempRoot(t)
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  const files = reviewFiles(dataRoot)
  const port = 22001
  fs.mkdirSync(files.review, { recursive: true })
  fs.mkdirSync(installDir, { recursive: true })
  fs.writeFileSync(path.join(installDir, 'keep.txt'), 'keep\n')
  fs.writeFileSync(files.pidFile, '731\n')
  fs.writeFileSync(files.heartbeatFile, '{corrupt')
  const mutations = []
  const host = createInstallHost({
    platform: 'win32',
    home: root,
    localAppData: root,
    skipPath: false,
    skipTask: false,
    env: (name) => {
      if (name === 'HUB_ROOT') return dataRoot
      if (name === 'HUB_API_PORT') return String(port)
      if (name === 'SG_INSTALL_DIR') return installDir
      return undefined
    },
    extraShimDir: () => null,
    pidAlive: (pid) => pid === 731,
    processCommandLine: () => `node "${path.join(packageRoot, 'dist', 'control', 'cli.js')}" daemon run`,
    killPid: (pid) => { mutations.push(`kill:${pid}`); return true },
    unregisterTask: () => mutations.push('task'),
    taskExists: () => true,
    userPath: () => `${path.join(installDir, 'bin')};C:\\Windows`,
    setUserPath: () => mutations.push('path'),
    setUserEnv: () => mutations.push('env'),
    broadcastEnv: () => mutations.push('broadcast')
  })

  const result = await uninstallHub(packageRoot, host)
  assert.equal(result.ok, false)
  assert.equal(result.stopped, false)
  assert.equal(result.taskRemoved, false)
  assert.equal(result.pathRemoved, false)
  assert.equal(result.filesRemoved, false)
  assert.equal(result.extraShimsRemoved, false)
  assert.equal(result.issues.some((issue) => issue.level === 'error' && /uninstall aborted/.test(issue.message)), true)
  assert.deepEqual(mutations, [])
  assert.equal(fs.existsSync(path.join(installDir, 'keep.txt')), true)
  assert.equal(fs.existsSync(files.pidFile), true)
  assert.equal(fs.existsSync(files.heartbeatFile), true)
})

test('uninstall aborts after an owned daemon kill timeout and preserves install state and markers', async (t) => {
  const root = tempRoot(t)
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  const files = reviewFiles(dataRoot)
  const port = 22004
  fs.mkdirSync(files.review, { recursive: true })
  fs.mkdirSync(installDir, { recursive: true })
  fs.writeFileSync(path.join(installDir, 'keep.txt'), 'keep\n')
  fs.writeFileSync(files.pidFile, '811\n')
  fs.writeFileSync(files.apiPidFile, '812\n')
  fs.writeFileSync(files.heartbeatFile, `${JSON.stringify({
    pid: 811,
    apiPid: 812,
    packageRoot,
    dataRoot,
    port,
    lastBeat: new Date().toISOString()
  })}\n`)
  const markerBytes = [files.pidFile, files.apiPidFile, files.heartbeatFile].map((file) => fs.readFileSync(file))
  const mutations = []
  const host = createInstallHost({
    platform: 'win32',
    home: root,
    localAppData: root,
    skipPath: false,
    skipTask: false,
    env: (name) => {
      if (name === 'HUB_ROOT') return dataRoot
      if (name === 'HUB_API_PORT') return String(port)
      if (name === 'SG_INSTALL_DIR') return installDir
      return undefined
    },
    extraShimDir: () => null,
    pidAlive: (pid) => pid === 811 || pid === 812,
    processCommandLine: (pid) => pid === 811
      ? `node "${path.join(packageRoot, 'dist', 'control', 'cli.js')}" daemon run`
      : `node "${path.join(packageRoot, 'server', 'index.mjs')}"`,
    killPid: (pid) => { mutations.push(`kill:${pid}`); return true },
    waitForPidsExit: () => false,
    unregisterTask: () => mutations.push('task'),
    taskExists: () => true,
    userPath: () => `${path.join(installDir, 'bin')};C:\\Windows`,
    setUserPath: () => mutations.push('path'),
    setUserEnv: () => mutations.push('env'),
    broadcastEnv: () => mutations.push('broadcast')
  })

  const result = await uninstallHub(packageRoot, host)
  assert.equal(result.ok, false)
  assert.equal(result.stopped, false)
  assert.equal(result.taskRemoved, false)
  assert.equal(result.pathRemoved, false)
  assert.equal(result.filesRemoved, false)
  assert.equal(result.extraShimsRemoved, false)
  assert.equal(result.issues.some((issue) => issue.level === 'error' && /uninstall aborted/.test(issue.message)), true)
  assert.deepEqual(mutations, ['kill:811', 'kill:812'])
  assert.equal(fs.existsSync(path.join(installDir, 'keep.txt')), true)
  for (const [index, file] of [files.pidFile, files.apiPidFile, files.heartbeatFile].entries()) {
    assert.deepEqual(fs.readFileSync(file), markerBytes[index], `uninstall preserves ${path.basename(file)}`)
  }
})

test('uninstall reports failure when scheduled task removal is refused instead of returning a false success', async (t) => {
  const root = tempRoot(t)
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  fs.mkdirSync(installDir, { recursive: true })
  fs.writeFileSync(path.join(installDir, 'installed.txt'), 'fixture\n')
  const mutations = []
  const host = createInstallHost({
    platform: 'win32',
    home: root,
    localAppData: root,
    skipPath: true,
    skipTask: false,
    env: (name) => {
      if (name === 'HUB_ROOT') return dataRoot
      if (name === 'SG_INSTALL_DIR') return installDir
      return undefined
    },
    extraShimDir: () => null,
    pidAlive: () => false,
    unregisterTask: () => mutations.push('unregister-task'),
    taskExists: () => true
  })

  const result = await uninstallHub(packageRoot, host)
  assert.equal(result.ok, false)
  assert.equal(result.stopped, true)
  assert.equal(result.taskRemoved, false)
  assert.equal(result.filesRemoved, true)
  assert.equal(result.issues.some((issue) => issue.level === 'error' && /scheduled task/.test(issue.message)), true)
  assert.deepEqual(mutations, ['unregister-task'])
})

test('uninstall reports global shim deletion failures and keeps the failed paths observable', async (t) => {
  const root = tempRoot(t)
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  const globalBin = path.join(root, 'global-bin')
  fs.mkdirSync(installDir, { recursive: true })
  fs.mkdirSync(path.join(globalBin, 'sg.cmd'), { recursive: true })
  fs.mkdirSync(path.join(globalBin, 'ozdqp-hub.cmd'), { recursive: true })
  const host = createInstallHost({
    platform: 'win32',
    home: root,
    localAppData: root,
    skipPath: false,
    skipTask: true,
    env: (name) => {
      if (name === 'HUB_ROOT') return dataRoot
      if (name === 'SG_INSTALL_DIR') return installDir
      return undefined
    },
    extraShimDir: () => globalBin,
    pidAlive: () => false,
    userPath: () => '',
    setUserPath: () => {},
    setUserEnv: () => {},
    broadcastEnv: () => {}
  })

  const result = await uninstallHub(packageRoot, host)
  assert.equal(result.ok, false)
  assert.equal(result.extraShimsRemoved, false)
  assert.equal(fs.existsSync(path.join(globalBin, 'sg.cmd')), true)
  assert.equal(fs.existsSync(path.join(globalBin, 'ozdqp-hub.cmd')), true)
  assert.equal(result.issues.some((issue) => issue.level === 'error'), true)
})

test('InstallHost checks schtasks deletion status before declaring task removal complete', () => {
  const source = fs.readFileSync(new URL('../src/adapters/install-host.ts', import.meta.url), 'utf8')
  assert.match(source, /const ran = spawnSync\('schtasks\.exe', \['\/Delete'/)
  assert.match(source, /ran\.status !== 0 && host\.taskExists\(taskName\)/)
  assert.match(source, /throw new Error/)
})

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
