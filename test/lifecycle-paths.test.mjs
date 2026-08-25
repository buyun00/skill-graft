import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createInstallHost as createInstallHostAdapter } from '../dist/adapters/install-host.js'
import { LOCAL_RUNTIME_ASSET_PATHS } from '../dist/adapters/local-runtime-assets.js'
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
  stopDaemon,
  stopDaemonWithListenerSeal
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
  'SG_TASK_NAME', 'SG_EXTRA_SHIM_DIR',
  'SKILL_GRAFT_INVOCATION_TRACE', 'SKILL_GRAFT_REAL_E2E', 'SKILL_GRAFT_RUN_ID', 'SKILL_GRAFT_E2E_ROOT',
  'PATH', 'DSH_HOME', 'HOME', 'XDG_CONFIG_HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP',
  'HUB_SPAWN_CODEX', 'HUB_CODEX_NODE', 'HUB_CODEX_MODULE', 'HUB_CODEX_CREDENTIAL_HOME',
  'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_OPTIONAL_LOCKS'
]

function createInstallHost(overrides = {}) {
  if (!overrides.environment && !overrides.env) return createInstallHostAdapter(overrides)
  const environment = overrides.environment || (() => Object.fromEntries(
    INSTALL_ENVIRONMENT_NAMES
      .map((name) => [name, overrides.env?.(name)])
      .filter((entry) => entry[1] !== undefined)
  ))
  const readUserPathState = overrides.userPathState || (() => ({
    exists: true,
    value: overrides.userPath?.() || '',
    kind: 'ExpandString'
  }))
  const readUserEnv = overrides.userEnv || ((name) => overrides.env?.(name))
  const readUserEnvState = overrides.userEnvState || ((name) => {
    const value = readUserEnv(name)
    return value === undefined
      ? { exists: false, value: '', kind: null }
      : { exists: true, value, kind: 'ExpandString' }
  })
  return createInstallHostAdapter({
    userPathState: readUserPathState,
    userEnv: readUserEnv,
    userEnvState: readUserEnvState,
    compareExchangeUserPath: (expected, next) => {
      const current = readUserPathState()
      if (JSON.stringify(current) !== JSON.stringify(expected)) return false
      overrides.setUserPath?.(next.value)
      return JSON.stringify(readUserPathState()) === JSON.stringify(next)
    },
    compareExchangeUserEnv: (name, expected, next) => {
      if (JSON.stringify(readUserEnvState(name)) !== JSON.stringify(expected)) return false
      overrides.setUserEnv?.(name, next.exists ? next.value : null)
      return JSON.stringify(readUserEnvState(name)) === JSON.stringify(next)
    },
    taskAction: () => '',
    ...overrides,
    environment
  })
}

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-lifecycle-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function seedRequiredDataAssets(root) {
  fs.mkdirSync(path.join(root, 'overlay'), { recursive: true })
  fs.writeFileSync(path.join(root, 'AGENTS.override.md'), '# fixture\n')
  for (const name of LOCAL_RUNTIME_ASSET_PATHS) {
    const file = path.join(root, 'overlay', ...name.split('/'))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `# fixture ${name}\n`)
  }
  for (const name of ['ozdqp-development', 'ozdqp-ui-development', 'ozdqp-git-workflow']) {
    const dir = path.join(root, 'skills', name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `# ${name}\n`)
  }
}

function seedPackageRuntime(root, version = '1.0.0') {
  fs.mkdirSync(path.join(root, 'dist', 'control'), { recursive: true })
  fs.mkdirSync(path.join(root, 'server'), { recursive: true })
  fs.mkdirSync(path.join(root, 'web'), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({ name: 'ozdqp-skill-hub', version })}\n`)
  fs.writeFileSync(path.join(root, 'dist', 'control', 'cli.js'), '// fixture cli\n')
  fs.writeFileSync(path.join(root, 'server', 'index.mjs'), '// fixture server\n')
  fs.writeFileSync(path.join(root, 'web', 'index.html'), '<!doctype html>\n')
  fs.writeFileSync(path.join(root, 'AGENTS.override.md'), '# fixture\n')
  for (const name of LOCAL_RUNTIME_ASSET_PATHS) {
    const file = path.join(root, 'overlay', ...name.split('/'))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `# fixture ${name}\n`)
  }
}

async function seedOwnedInstall({ packageRoot, dataRoot, installDir, port, daemonOwned = false }) {
  seedPackageRuntime(packageRoot)
  const env = new Map([
    ['HUB_ROOT', dataRoot],
    ['HUB_API_PORT', String(port)],
    ['SG_INSTALL_DIR', installDir]
  ])
  const host = createInstallHost({
    platform: 'win32',
    home: path.dirname(installDir),
    localAppData: path.dirname(installDir),
    skipPath: true,
    skipTask: true,
    env: (name) => env.get(name),
    extraShimDir: () => null,
    which: (name) => name === 'git' ? 'git.exe' : '',
    commandVersion: () => 'git version fixture',
    integrationSnapshot: undefined,
    taskExists: () => false,
    pidAlive: () => false,
    runNpm: () => { throw new Error('fixture unexpectedly invoked npm') }
  })
  const result = await setupHub(packageRoot, {
    dryRun: false,
    json: true,
    noDaemon: true,
    noPath: true,
    noTask: true,
    rebuild: false
  }, host)
  assert.equal(result.ok, true, JSON.stringify(result.issues))
  if (daemonOwned) {
    const manifestPath = path.join(installDir, 'install.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    manifest.features.daemon = true
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  }
  return env
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
  seedPackageRuntime(packageRoot)
  const runnerPaths = {
    HUB_CODEX_NODE: path.join(gate.runRoot, 'runner', 'node.exe'),
    HUB_CODEX_MODULE: path.join(gate.runRoot, 'runner', 'codex.js'),
    HUB_CODEX_CREDENTIAL_HOME: path.join(gate.runRoot, 'runner', 'credentials')
  }
  const env = new Map([
    ['HUB_ROOT', dataRoot],
    ['HUB_API_PORT', '21990'],
    ['SG_INSTALL_DIR', installDir],
    ...Object.entries(runnerPaths),
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
  const interactiveShim = fs.readFileSync(path.join(installDir, 'bin', 'sg.cmd'), 'utf8')
  const unixShim = fs.readFileSync(path.join(installDir, 'bin', 'sg'), 'utf8')
  for (const [name, value] of Object.entries(runnerPaths)) {
    assert.match(launcher, new RegExp(`set "${name}=${escapeRegex(value)}"`), `${name} detached launcher pin`)
    assert.equal((launcher.match(new RegExp(`^set "${name}=`, 'gm')) || []).length, 2, name)
    assert.match(interactiveShim, new RegExp(`set "${name}=${escapeRegex(value)}"`), `${name} cmd shim pin`)
    assert.equal((interactiveShim.match(new RegExp(`^set "${name}=`, 'gm')) || []).length, 2, `${name} cmd shim`)
    assert.match(unixShim, new RegExp(`${name}='${escapeRegex(value)}'`), `${name} unix shim pin`)
  }
  assert.match(unixShim, /unset HUB_CODEX_NODE HUB_CODEX_MODULE HUB_CODEX_CREDENTIAL_HOME/)
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
    seedPackageRuntime(packageRoot)
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
  seedPackageRuntime(packageRoot)
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

test('CLI daemon stop supplies package and selected data roots to the lifecycle guard', () => {
  const source = fs.readFileSync(new URL('../src/control/cli.ts', import.meta.url), 'utf8')
  assert.match(source, /await stopDaemonGuarded\(packageRoot, undefined, dataRoot\)/)
  assert.doesNotMatch(source, /stopDaemon\(dataRoot, undefined, packageRoot\)/)
})

test('setup preserves explicit HUB_ROOT and initializes only the data root', async (t) => {
  const root = tempRoot(t)
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  seedRequiredDataAssets(dataRoot)
  seedPackageRuntime(packageRoot)

  const env = new Map([
    ['HUB_ROOT', dataRoot],
    ['HUB_API_PORT', '21992'],
    ['SG_INSTALL_DIR', installDir]
  ])
  const userEnvWrites = []
  const persistentUserEnv = new Map()
  const host = createInstallHost({
    platform: 'win32',
    home: root,
    localAppData: root,
    skipPath: false,
    skipTask: true,
    env: (name) => env.get(name),
    extraShimDir: () => null,
    userPath: () => path.join(installDir, 'bin'),
    userEnv: (name) => persistentUserEnv.get(name),
    setUserPath: () => {},
    setUserEnv: (name, value) => {
      userEnvWrites.push([name, value])
      if (value === null) persistentUserEnv.delete(name)
      else persistentUserEnv.set(name, value)
    },
    broadcastEnv: () => {},
    which: (name) => name === 'git' ? 'git.exe' : '',
    commandVersion: () => 'git version fixture',
    integrationSnapshot: undefined,
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

  assert.equal(result.ok, true, JSON.stringify(result.issues))
  assert.equal(result.hubRoot, path.resolve(dataRoot))
  assert.match(result.steps.find((step) => step.id === 'deps')?.detail || '', /prebuilt/)
  assert.equal(fs.existsSync(path.join(dataRoot, 'skill-review', 'state.json')), true)
  assert.equal(fs.existsSync(path.join(packageRoot, 'skill-review')), false)
  assert.deepEqual(userEnvWrites.filter(([name]) => name === 'SKILL_GRAFT_HOME' || name === 'HUB_ROOT'), [
    ['SKILL_GRAFT_HOME', path.resolve(dataRoot)],
    ['HUB_ROOT', path.resolve(dataRoot)]
  ])
  const shim = fs.readFileSync(paths.shimCmd, 'utf8')
  assert.match(shim, /if not defined HUB_ROOT/)
  assert.match(shim, new RegExp(escapeRegex(path.resolve(dataRoot))))
  assert.match(shim, new RegExp(escapeRegex(paths.cliPath)))
})

test('setup bootstraps public runtime into an empty explicit data root without private Skills', async (t) => {
  const root = tempRoot(t)
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'empty-data')
  const installDir = path.join(root, 'install')
  const portProbe = createServer()
  await new Promise((resolveListen, rejectListen) => {
    portProbe.once('error', rejectListen)
    portProbe.listen(0, '127.0.0.1', resolveListen)
  })
  const portAddress = portProbe.address()
  assert.ok(portAddress && typeof portAddress === 'object')
  const port = portAddress.port
  await new Promise((resolveClose, rejectClose) => {
    portProbe.close((error) => error ? rejectClose(error) : resolveClose())
  })
  seedPackageRuntime(packageRoot)
  const env = new Map([
    ['HUB_ROOT', dataRoot],
    ['SG_INSTALL_DIR', installDir],
    ['HUB_API_PORT', String(port)]
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

  assert.equal(result.ok, true, JSON.stringify(result.issues))
  assert.equal(fs.existsSync(path.join(dataRoot, 'skill-review', 'state.json')), true)
  assert.equal(fs.existsSync(path.join(packageRoot, 'skill-review')), false)
  assert.equal(fs.existsSync(path.join(dataRoot, '.skill-graft-data-root.json')), true)
  assert.equal(fs.statSync(path.join(dataRoot, '.skill-graft-transactions')).isDirectory(), true)
  assert.equal(fs.existsSync(path.join(dataRoot, 'AGENTS.override.md')), true)
  assert.equal(fs.existsSync(path.join(dataRoot, 'skills', 'ozdqp-development', 'SKILL.md')), false)
  assert.equal(JSON.parse(fs.readFileSync(path.join(installDir, 'install.json'), 'utf8')).port, port)
  assert.equal(result.doctor.lifecycle.corpusEmpty, true)
  assert.equal(result.doctor.issues.some((issue) => issue.level === 'warn' && /corpus is empty/.test(issue.message)), true)
})

test('setup halts every external lifecycle mutation when an unowned public runtime file is dirty', async (t) => {
  const root = tempRoot(t)
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'empty-data')
  const installDir = path.join(root, 'install')
  seedPackageRuntime(packageRoot)
  fs.mkdirSync(dataRoot, { recursive: true })
  fs.writeFileSync(path.join(dataRoot, 'AGENTS.override.md'), '# foreign user bytes\n')
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
  assert.equal(result.steps.find((step) => step.id === 'preflight')?.ok, false)
  for (const id of ['shims', 'path', 'env', 'task', 'daemon']) {
    assert.equal(result.steps.find((step) => step.id === id)?.skipped, true, `${id} must be skipped`)
  }
  assert.deepEqual(mutations, [])
  assert.equal(fs.existsSync(installDir), false)
  assert.equal(fs.readFileSync(path.join(dataRoot, 'AGENTS.override.md'), 'utf8'), '# foreign user bytes\n')
})

test('setup trace preflight halts deps, layout, PATH, task, and daemon mutations', async (t) => {
  const root = tempRoot(t)
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  seedRequiredDataAssets(dataRoot)
  seedPackageRuntime(packageRoot)
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

test('daemon status never promotes legacy marker and HTTP facts without v1 authority', async (t) => {
  const root = tempRoot(t)
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const wrong = reviewFiles(packageRoot)
  const expected = reviewFiles(dataRoot)
  const api = createServer((request, response) => {
    response.statusCode = request.url === '/api/health' ? 200 : 404
    response.setHeader('Content-Type', 'application/json')
    response.setHeader('x-skill-graft-package-root', encodeURIComponent(packageRoot))
    response.setHeader('x-skill-graft-data-root', encodeURIComponent(dataRoot))
    response.end(JSON.stringify({ ok: request.url === '/api/health' }))
  })
  await new Promise((resolveListen, rejectListen) => {
    api.once('error', rejectListen)
    api.listen(0, '127.0.0.1', resolveListen)
  })
  t.after(() => new Promise((resolveClose) => api.close(() => resolveClose())))
  const address = api.address()
  assert.ok(address && typeof address === 'object')
  const port = address.port
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
    port,
    apiHealthy: true,
    lastBeat: new Date().toISOString()
  })}\n`)

  const host = createInstallHost({
    env: (name) => name === 'HUB_API_PORT' ? String(port) : undefined,
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

  assert.equal(status.running, false)
  assert.equal(status.pid, 0)
  assert.equal(status.apiPid, 0)
  assert.equal(status.apiHealthy, false)
  assert.equal(status.heartbeat, null)
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
  assert.equal(status.running, false)
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
  const daemonEpoch = '11111111-1111-4111-8111-111111111111'
  const values = new Map([
    ['x-skill-graft-package-root', encodeURIComponent(packageRoot)],
    ['x-skill-graft-data-root', encodeURIComponent(dataRoot)],
    ['x-skill-graft-daemon-epoch', daemonEpoch]
  ])
  const headers = { get: (name) => values.get(name.toLowerCase()) || null }
  assert.equal(apiHeadersMatch(headers, { packageRoot, dataRoot }), true)
  assert.equal(apiHeadersMatch(headers, { packageRoot, dataRoot, daemonEpoch }), true)
  assert.equal(apiHeadersMatch(headers, { packageRoot, dataRoot, daemonEpoch: '22222222-2222-4222-8222-222222222222' }), false)
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

test('daemon stop rejects lost PID markers while preserving heartbeat process evidence', (t) => {
  const root = tempRoot(t)
  const packageRoot = path.join(root, 'package')
  const port = 22013
  for (const scenario of [
    { name: 'missing-daemon-pid', keepDaemonPid: false, keepApiPid: true },
    { name: 'missing-api-pid', keepDaemonPid: true, keepApiPid: false },
    { name: 'missing-both-pids', keepDaemonPid: false, keepApiPid: false }
  ]) {
    const dataRoot = path.join(root, scenario.name)
    const files = reviewFiles(dataRoot)
    fs.mkdirSync(files.review, { recursive: true })
    if (scenario.keepDaemonPid) fs.writeFileSync(files.pidFile, '731\n')
    if (scenario.keepApiPid) fs.writeFileSync(files.apiPidFile, '732\n')
    fs.writeFileSync(files.heartbeatFile, `${JSON.stringify({
      pid: 731,
      apiPid: 732,
      packageRoot,
      dataRoot,
      port,
      lastBeat: new Date().toISOString()
    })}\n`)
    const before = fs.readdirSync(files.review)
      .sort()
      .map((name) => [name, fs.readFileSync(path.join(files.review, name))])
    const killed = []
    const host = createInstallHost({
      env: (name) => name === 'HUB_API_PORT' ? String(port) : undefined,
      pidAlive: (pid) => pid === 731 || pid === 732,
      processCommandLine: (pid) => pid === 731
        ? `node "${path.join(packageRoot, 'dist', 'control', 'cli.js')}" daemon run`
        : `node "${path.join(packageRoot, 'server', 'index.mjs')}"`,
      killPid: (pid) => { killed.push(pid); return true }
    })

    assert.equal(stopDaemon(dataRoot, host, packageRoot, port), false, scenario.name)
    assert.deepEqual(killed, [], scenario.name)
    assert.deepEqual(
      fs.readdirSync(files.review).sort().map((name) => [name, fs.readFileSync(path.join(files.review, name))]),
      before,
      scenario.name
    )
  }
})

test('daemon stop refuses a reparse review root without touching protected marker names', (t) => {
  const root = tempRoot(t)
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const protectedRoot = path.join(root, 'protected')
  const files = reviewFiles(dataRoot)
  fs.mkdirSync(dataRoot, { recursive: true })
  fs.mkdirSync(protectedRoot, { recursive: true })
  const protectedFiles = ['daemon.pid', 'api.pid', 'daemon-heartbeat.json', 'daemon.log']
  for (const name of protectedFiles) fs.writeFileSync(path.join(protectedRoot, name), `protected ${name}\n`)
  fs.symlinkSync(protectedRoot, files.review, process.platform === 'win32' ? 'junction' : 'dir')
  const before = protectedFiles.map((name) => fs.readFileSync(path.join(protectedRoot, name)))
  const killed = []
  const host = createInstallHost({
    pidAlive: () => true,
    processCommandLine: () => `node "${path.join(packageRoot, 'dist', 'control', 'cli.js')}" daemon run`,
    killPid: (pid) => { killed.push(pid); return true }
  })

  assert.equal(stopDaemon(dataRoot, host, packageRoot, 22014), false)
  assert.deepEqual(killed, [])
  for (const [index, name] of protectedFiles.entries()) {
    assert.deepEqual(fs.readFileSync(path.join(protectedRoot, name)), before[index])
  }
})

test('listener-sealed daemon stop rejects unmarked and dead-marker listeners without cleanup', async (t) => {
  const root = tempRoot(t)
  const packageRoot = path.join(root, 'package')
  const server = createServer((_request, response) => response.end('foreign listener\n'))
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  t.after(() => new Promise((resolveClose) => server.close(() => resolveClose())))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const port = address.port
  const host = createInstallHost({
    env: (name) => name === 'HUB_API_PORT' ? String(port) : undefined,
    pidAlive: () => false,
    processCommandLine: () => ''
  })

  const unmarkedRoot = path.join(root, 'unmarked')
  fs.mkdirSync(unmarkedRoot)
  assert.equal(await stopDaemonWithListenerSeal(unmarkedRoot, host, packageRoot, port), false)
  assert.equal(server.listening, true)
  assert.equal(fs.existsSync(reviewFiles(unmarkedRoot).review), false)

  const markedRoot = path.join(root, 'dead-markers')
  const files = reviewFiles(markedRoot)
  fs.mkdirSync(files.review, { recursive: true })
  fs.writeFileSync(files.pidFile, '741\n')
  fs.writeFileSync(files.apiPidFile, '742\n')
  fs.writeFileSync(files.heartbeatFile, `${JSON.stringify({
    pid: 741,
    apiPid: 742,
    packageRoot,
    dataRoot: markedRoot,
    port,
    lastBeat: new Date().toISOString()
  })}\n`)
  const before = [files.pidFile, files.apiPidFile, files.heartbeatFile].map((file) => fs.readFileSync(file))
  assert.equal(await stopDaemonWithListenerSeal(markedRoot, host, packageRoot, port), false)
  assert.equal(server.listening, true)
  for (const [index, file] of [files.pidFile, files.apiPidFile, files.heartbeatFile].entries()) {
    assert.deepEqual(fs.readFileSync(file), before[index])
  }
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

test('detached start preserves legacy marker evidence when launch does not publish v1 authority', async (t) => {
  const root = tempRoot(t)
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  const files = reviewFiles(dataRoot)
  const portProbe = createServer()
  await new Promise((resolveListen, rejectListen) => {
    portProbe.once('error', rejectListen)
    portProbe.listen(0, '127.0.0.1', resolveListen)
  })
  const portAddress = portProbe.address()
  assert.ok(portAddress && typeof portAddress === 'object')
  const port = portAddress.port
  await new Promise((resolveClose, rejectClose) => {
    portProbe.close((error) => error ? rejectClose(error) : resolveClose())
  })
  fs.mkdirSync(path.join(packageRoot, 'dist', 'control'), { recursive: true })
  fs.mkdirSync(path.join(packageRoot, 'server'), { recursive: true })
  fs.writeFileSync(path.join(packageRoot, 'dist', 'control', 'cli.js'), '// fixture\n')
  fs.writeFileSync(path.join(packageRoot, 'server', 'index.mjs'), '// fixture\n')
  const launcherPaths = resolveInstallPaths(pathApi, {
    hubRoot: packageRoot,
    packageRoot,
    dataRoot,
    nodePath: process.execPath,
    installDir,
    extraShimDir: null,
    port
  })
  const launchers = renderShims(launcherPaths, undefined, {
    HOME: root,
    USERPROFILE: root,
    LOCALAPPDATA: root,
    HUB_CODEX_NODE: process.execPath,
    HUB_CODEX_CREDENTIAL_HOME: path.join(root, '.codex')
  })
  fs.mkdirSync(installDir, { recursive: true })
  fs.writeFileSync(launcherPaths.silentVbs, launchers.vbs)
  fs.writeFileSync(launcherPaths.runDaemonCmd, launchers.runDaemonCmd)
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
        hubRoot: dataRoot,
        packageRoot,
        dataRoot,
        port,
        apiHealthy: true,
        lastBeat: new Date().toISOString()
      }, null, 2)}\n`)
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
  assert.match(result.detail, /v1 daemon authority is control-required\/LEGACY; evidence preserved/)
  assert.deepEqual(killed, [])
  assert.deepEqual([...live].sort(), [831, 832])
  assert.equal(fs.existsSync(files.pidFile), true)
  assert.equal(fs.existsSync(files.apiPidFile), true)
  assert.equal(fs.existsSync(files.heartbeatFile), true)
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
  const markerBytes = [files.pidFile, files.apiPidFile, files.heartbeatFile]
    .map((file) => fs.readFileSync(file))
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
  assert.match(result.detail, /v1 authority is control-required; evidence preserved/)
  assert.deepEqual(mutations, [])
  for (const [index, file] of [files.pidFile, files.apiPidFile, files.heartbeatFile].entries()) {
    assert.deepEqual(fs.readFileSync(file), markerBytes[index], `daemon start preserves ${path.basename(file)}`)
  }
})

test('uninstall aborts without removing any state when daemon ownership is unverified', async (t) => {
  const root = tempRoot(t)
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  const files = reviewFiles(dataRoot)
  const port = 22001
  const env = await seedOwnedInstall({ packageRoot, dataRoot, installDir, port, daemonOwned: true })
  fs.mkdirSync(files.review, { recursive: true })
  const manifestBytes = fs.readFileSync(path.join(installDir, 'install.json'))
  fs.writeFileSync(files.pidFile, '731\n')
  fs.writeFileSync(files.heartbeatFile, '{corrupt')
  const mutations = []
  const host = createInstallHost({
    platform: 'win32',
    home: root,
    localAppData: root,
    skipPath: false,
    skipTask: false,
    env: (name) => env.get(name),
    extraShimDir: () => null,
    pidAlive: (pid) => pid === 731,
    processCommandLine: () => `node "${path.join(packageRoot, 'dist', 'control', 'cli.js')}" daemon run`,
    killPid: (pid) => { mutations.push(`kill:${pid}`); return true },
    unregisterTask: () => mutations.push('task'),
    taskExists: () => false,
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
  assert.equal(result.issues.some((issue) => issue.level === 'error'
    && /daemon heartbeat is not valid bounded JSON/.test(issue.message)), true, JSON.stringify(result.issues))
  assert.deepEqual(mutations, [])
  assert.deepEqual(fs.readFileSync(path.join(installDir, 'install.json')), manifestBytes)
  assert.equal(fs.existsSync(files.pidFile), true)
  assert.equal(fs.existsSync(files.heartbeatFile), true)
})

test('uninstall aborts after an owned daemon kill timeout and preserves install state and markers', async (t) => {
  const root = tempRoot(t)
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  const files = reviewFiles(dataRoot)
  const portProbe = createServer()
  await new Promise((resolveListen, rejectListen) => {
    portProbe.once('error', rejectListen)
    portProbe.listen(0, '127.0.0.1', resolveListen)
  })
  const address = portProbe.address()
  assert.ok(address && typeof address === 'object')
  const port = address.port
  await new Promise((resolveClose) => portProbe.close(resolveClose))
  const env = await seedOwnedInstall({ packageRoot, dataRoot, installDir, port, daemonOwned: true })
  fs.mkdirSync(files.review, { recursive: true })
  const manifestBytes = fs.readFileSync(path.join(installDir, 'install.json'))
  fs.writeFileSync(files.pidFile, '811\n')
  fs.writeFileSync(files.apiPidFile, '811\n')
  fs.writeFileSync(files.heartbeatFile, `${JSON.stringify({
    pid: 811,
    apiPid: 811,
    hubRoot: dataRoot,
    packageRoot,
    dataRoot,
    port,
    apiHealthy: true,
    lastBeat: new Date().toISOString()
  }, null, 2)}\n`)
  const markerBytes = [files.pidFile, files.apiPidFile, files.heartbeatFile].map((file) => fs.readFileSync(file))
  const mutations = []
  const host = createInstallHost({
    platform: 'win32',
    home: root,
    localAppData: root,
    skipPath: false,
    skipTask: false,
    env: (name) => env.get(name),
    extraShimDir: () => null,
    pidAlive: (pid) => pid === 811,
    processCommandLine: () => `node "${path.join(packageRoot, 'dist', 'control', 'cli.js')}" daemon run`,
    killPid: (pid) => { mutations.push(`kill:${pid}`); return true },
    unregisterTask: () => mutations.push('task'),
    taskExists: () => false,
    userPath: () => `${path.join(installDir, 'bin')};C:\\Windows`,
    setUserPath: () => mutations.push('path'),
    setUserEnv: () => mutations.push('env'),
    broadcastEnv: () => mutations.push('broadcast')
  })
  const daemonEvents = []
  const daemonIdentity = 'lifecycle-timeout-daemon-811'
  const aliveFacts = (pid, processIdentity, pgid = pid) => Object.freeze({
    state: 'alive',
    pid,
    ppid: 1,
    processIdentity,
    pgid,
    commandLine: `fixture-process-${pid}`
  })
  const processHost = Object.freeze({
    platform: 'win32',
    processFacts(pid) {
      if (pid === process.pid) return aliveFacts(pid, `lifecycle-timeout-controller-${pid}`)
      if (pid === 811) return aliveFacts(pid, daemonIdentity)
      return Object.freeze({ state: 'dead' })
    },
    processTree(rootPid, expectedIdentity) {
      assert.equal(rootPid, 811)
      assert.equal(expectedIdentity, daemonIdentity)
      return Object.freeze({
        state: 'exact',
        rootPid,
        rootProcessIdentity: daemonIdentity,
        entries: Object.freeze([aliveFacts(811, daemonIdentity)])
      })
    },
    listenerFacts(expectedPort) {
      assert.equal(expectedPort, port)
      return Object.freeze({
        state: 'present',
        pids: Object.freeze([811]),
        bindings: Object.freeze([Object.freeze({
          family: 'ipv4',
          address: '127.0.0.1',
          port,
          pid: 811
        })])
      })
    },
    terminateExactTree(tree) {
      daemonEvents.push(`terminate:${tree.rootPid}`)
      return Object.freeze({ state: 'signaled', pids: Object.freeze([tree.rootPid]) })
    },
    waitForExit(tree) {
      daemonEvents.push(`wait:${tree.rootPid}`)
      return Object.freeze({ state: 'timeout', pids: Object.freeze([tree.rootPid]) })
    }
  })

  const result = await uninstallHub(packageRoot, host, {
    daemonStop: {
      processHost,
      healthProbe: async () => { throw new Error('legacy daemon retirement must not probe v1 health') },
      timeoutMs: 100
    }
  })
  assert.equal(result.ok, false)
  assert.equal(result.stopped, false)
  assert.equal(result.taskRemoved, false)
  assert.equal(result.pathRemoved, false)
  assert.equal(result.filesRemoved, false)
  assert.equal(result.extraShimsRemoved, false)
  assert.equal(result.issues.some((issue) => issue.level === 'error' && /daemon exact tree exit is timeout/.test(issue.message)), true, JSON.stringify(result.issues))
  assert.deepEqual(daemonEvents, ['terminate:811', 'wait:811', 'terminate:811', 'wait:811'])
  assert.deepEqual(mutations, [])
  assert.deepEqual(fs.readFileSync(path.join(installDir, 'install.json')), manifestBytes)
  for (const [index, file] of [files.pidFile, files.apiPidFile, files.heartbeatFile].entries()) {
    assert.deepEqual(fs.readFileSync(file), markerBytes[index], `uninstall preserves ${path.basename(file)}`)
  }
})

test('uninstall reports failure when scheduled task removal is refused instead of returning a false success', async (t) => {
  const root = tempRoot(t)
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  const portProbe = createServer()
  await new Promise((resolveListen, rejectListen) => {
    portProbe.once('error', rejectListen)
    portProbe.listen(0, '127.0.0.1', resolveListen)
  })
  const portAddress = portProbe.address()
  assert.ok(portAddress && typeof portAddress === 'object')
  const port = portAddress.port
  await new Promise((resolveClose, rejectClose) => {
    portProbe.close((error) => error ? rejectClose(error) : resolveClose())
  })
  seedPackageRuntime(packageRoot)
  const mutations = []
  const env = new Map([
    ['HUB_ROOT', dataRoot],
    ['SG_INSTALL_DIR', installDir],
    ['HUB_API_PORT', String(port)]
  ])
  let taskPresent = false
  const taskAction = `wscript.exe\u0000"${path.join(installDir, 'silent-run.vbs')}"`
  const host = createInstallHost({
    platform: 'win32',
    home: root,
    localAppData: root,
    skipPath: true,
    skipTask: false,
    env: (name) => env.get(name),
    extraShimDir: () => null,
    which: (name) => name === 'git' ? 'git.exe' : '',
    commandVersion: () => 'git version fixture',
    pidAlive: () => false,
    registerLogonTask: () => { taskPresent = true },
    taskAction: () => taskAction,
    taskExists: () => taskPresent,
    runNpm: () => { throw new Error('fixture unexpectedly invoked npm') }
  })
  const setup = await setupHub(packageRoot, {
    dryRun: false,
    json: true,
    noDaemon: true,
    noPath: true,
    noTask: false,
    rebuild: false
  }, host)
  assert.equal(setup.ok, true, JSON.stringify(setup.issues))
  const manifestPath = path.join(installDir, 'install.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifest.features.daemon = true
  manifest.features.task = true
  manifest.owned.task = {
    taskPath: '\\',
    name: manifest.taskName,
    launcher: path.join(installDir, 'silent-run.vbs'),
    created: true
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  taskPresent = true
  const uninstallHost = createInstallHost({
    ...host,
    unregisterTask: () => mutations.push('unregister-task'),
    registerLogonTask: () => {},
    taskExists: () => true,
    taskAction: () => taskAction
  })

  const result = await uninstallHub(packageRoot, uninstallHost)
  assert.equal(result.ok, false)
  assert.equal(result.stopped, false)
  assert.equal(result.taskRemoved, false)
  assert.equal(result.filesRemoved, false)
  assert.equal(result.issues.some((issue) => issue.level === 'error' && /scheduled task/.test(issue.message)), true)
  // The prepared WAL closes the restart source before stopping the daemon;
  // same-process recovery retries the exact owned CAS before preserving the WAL.
  assert.deepEqual(mutations, ['unregister-task', 'unregister-task'])
  assert.equal(fs.existsSync(path.join(installDir, 'install.json')), true)
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

test('InstallHost uses one strict scheduled-task inspection and conditional deletion script', () => {
  const source = fs.readFileSync(new URL('../src/adapters/install-host.ts', import.meta.url), 'utf8')
  const start = source.indexOf('unregisterTask(taskName, expectedVbsPath) {')
  const implementation = source.slice(start, source.indexOf('pidAlive(pid)', start))
  assert.match(implementation, /Get-ScheduledTask/)
  assert.match(implementation, /Unregister-ScheduledTask/)
  assert.match(implementation, /\$remaining = @\(Get-ScheduledTask -TaskPath '\\\\'/)
  assert.doesNotMatch(implementation, /-Force|schtasks\.exe/)
  assert.match(implementation, /refusing to remove foreign scheduled task/)
})

test('InstallHost stops only the exact owned scheduled-task instance and preserves registration', () => {
  const launcher = 'C:\\SkillGraft\\silent-run.vbs'
  const taskName = 'SkillGraft-stop-instance-contract'
  const commands = []
  const host = createInstallHostAdapter({
    platform: 'win32',
    skipTask: false,
    taskExists: (name) => name === taskName,
    taskAction: (name) => name === taskName ? `wscript.exe\u0000"${launcher}"` : ''
  }, {
    runPowerShell: (command, environment) => {
      commands.push({ command, environment })
      return { status: 0, stdout: '', stderr: '' }
    }
  })

  host.stopScheduledTaskInstance(taskName, launcher)
  assert.equal(commands.length, 1)
  assert.equal(commands[0].environment.SG_TASK_NAME, taskName)
  assert.equal(commands[0].environment.SG_VBS, launcher)
  assert.match(commands[0].command, /Stop-ScheduledTask/)
  assert.match(commands[0].command, /State -eq "Ready"/)
  assert.match(commands[0].command, /Settings\.Enabled/)
  assert.match(commands[0].command, /trigger\.Enabled/)
  assert.match(commands[0].command, /RestartCount -eq 3/)
  assert.doesNotMatch(commands[0].command, /Unregister-ScheduledTask|Disable-ScheduledTask/)
})

test('InstallHost treats only explicit registry or task absence as absent', () => {
  const source = fs.readFileSync(new URL('../src/adapters/install-host.ts', import.meta.url), 'utf8')
  const userPath = source.slice(source.indexOf('userPathState() {'), source.indexOf('userPath() {', source.indexOf('userPathState() {')))
  const taskExists = source.slice(source.indexOf('taskExists(name) {'), source.indexOf('taskAction(name)', source.indexOf('taskExists(name) {')))
  assert.match(userPath, /ran\.status === 3/)
  assert.match(userPath, /ran\.status !== 0/)
  assert.match(userPath, /failed to read user PATH/)
  assert.match(taskExists, /Get-ScheduledTask/)
  assert.match(taskExists, /ran\.status === 3/)
  assert.match(taskExists, /ran\.status !== 0/)
  assert.match(taskExists, /failed to inspect scheduled task/)
  assert.doesNotMatch(taskExists, /CategoryInfo\.Category -eq ["']ObjectNotFound/)
})

test('InstallHost behavior distinguishes explicit absence from PowerShell provider failures', () => {
  const result = (status, stderr = '') => ({ status, stdout: '', stderr })
  const absent = createInstallHostAdapter({ platform: 'win32', skipPath: false, skipTask: false }, {
    runPowerShell: () => result(3)
  })
  assert.equal(absent.userPath(), '')
  assert.equal(absent.taskExists('SkillGraft-test'), false)

  const failed = createInstallHostAdapter({ platform: 'win32', skipPath: false, skipTask: false }, {
    runPowerShell: () => result(10, 'access denied')
  })
  assert.throws(() => failed.userPath(), /access denied/)
  assert.throws(() => failed.taskExists('SkillGraft-test'), /access denied/)
})

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
