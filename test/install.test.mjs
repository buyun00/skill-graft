import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import {
  evaluateDoctor,
  mergeUserPath,
  pathHasDir,
  PRODUCT_COMMAND,
  removeFromUserPath,
  renderShims,
  resolveInstallDir,
  resolveInstallPaths,
  TASK_NAME,
  toGitBashPath
} from '../dist/index.js'

const pathApi = {
  join: (...parts) => path.join(...parts),
  resolve: (...parts) => path.resolve(...parts),
  dirname: (value) => path.dirname(value),
  basename: (value) => path.basename(value)
}

test('resolveInstallDir uses LOCALAPPDATA on Windows and an override when set', () => {
  const win = resolveInstallDir({
    platform: 'win32',
    home: 'C:\\Users\\dev',
    localAppData: 'C:\\Users\\dev\\AppData\\Local'
  })
  assert.equal(path.basename(win), 'skill-graft')
  assert.match(win, /AppData\\Local|AppData\/Local/)
  const override = resolveInstallDir({
    platform: 'win32',
    home: 'C:\\Users\\dev',
    override: 'D:\\tmp\\sg-install'
  })
  assert.equal(path.resolve(override), path.resolve('D:\\tmp\\sg-install'))
})

test('mergeUserPath prepends the bin dir once', () => {
  const first = mergeUserPath('C:\\Windows;C:\\Windows\\System32', 'C:\\sg\\bin', ';', true)
  assert.equal(first.changed, true)
  assert.equal(first.already, false)
  assert.equal(first.path.startsWith('C:\\sg\\bin;'), true)
  const again = mergeUserPath(first.path, 'C:\\sg\\bin', ';', true)
  assert.equal(again.changed, false)
  assert.equal(again.already, true)
  const removed = removeFromUserPath(first.path, 'C:\\sg\\bin', ';', true)
  assert.equal(removed.changed, true)
  assert.equal(pathHasDir(removed.path, 'C:\\sg\\bin', ';', true), false)
})

test('renderShims bake node, coherent data-root aliases, and daemon run into the wrappers', () => {
  const paths = resolveInstallPaths(pathApi, {
    hubRoot: 'E:\\ozdqp-skill-hub',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    installDir: 'C:\\Users\\dev\\AppData\\Local\\skill-graft',
    extraShimDir: 'C:\\Users\\dev\\AppData\\Roaming\\npm',
    port: 18765
  })
  assert.equal(paths.command, PRODUCT_COMMAND)
  assert.equal(paths.taskName, TASK_NAME)
  assert.equal(paths.shimCmd.endsWith('sg.cmd'), true)
  const shims = renderShims(paths)
  assert.match(shims.sgCmd, /set "SKILL_GRAFT_HOME=E:\\ozdqp-skill-hub"/)
  assert.match(shims.sgCmd, /set "HUB_ROOT=E:\\ozdqp-skill-hub"/)
  assert.match(shims.sgCmd, /node\.exe/)
  assert.match(shims.sgCmd, /cli\.js/)
  assert.match(shims.runDaemonCmd, /daemon run/)
  assert.match(shims.vbs, /run-daemon\.cmd/)
  assert.match(shims.runDaemonCmd, /SKILL_GRAFT_HOME/)
  assert.match(shims.runDaemonCmd, /HUB_ROOT/)
  assert.match(shims.unix, /export SKILL_GRAFT_HOME HUB_ROOT HUB_API_PORT/)
  assert.equal(toGitBashPath('E:\\ozdqp-skill-hub\\dist\\control\\cli.js'), '/e/ozdqp-skill-hub/dist/control/cli.js')
})

test('evaluateDoctor treats missing node as an error and a down daemon as a warning', () => {
  const paths = resolveInstallPaths(pathApi, {
    hubRoot: 'E:\\hub',
    nodePath: 'C:\\node.exe',
    installDir: 'C:\\sg'
  })
  const missingNode = evaluateDoctor(paths, {
    hubRoot: 'E:\\hub',
    nodePath: '',
    nodeVersion: '',
    gitPath: 'C:\\git.exe',
    gitVersion: 'git version 2.0',
    codexPath: '',
    distExists: true,
    cliPath: paths.cliPath,
    missingLayout: [],
    shimCmdExists: true,
    shimAliasExists: true,
    shimUnixExists: true,
    extraShimExists: false,
    userPath: paths.binDir,
    pathSep: ';',
    caseInsensitive: true,
    taskRegistered: true,
    daemonPid: 0,
    daemonAlive: false,
    apiHealthy: false,
    apiPort: 18765
  })
  assert.equal(missingNode.ok, false)
  assert.ok(missingNode.issues.some((issue) => issue.level === 'error' && /Node/.test(issue.message)))

  const healthy = evaluateDoctor(paths, {
    hubRoot: 'E:\\hub',
    nodePath: 'C:\\node.exe',
    nodeVersion: 'v22.0.0',
    gitPath: 'C:\\git.exe',
    gitVersion: 'git version 2.0',
    codexPath: 'C:\\codex.js',
    distExists: true,
    cliPath: paths.cliPath,
    missingLayout: [],
    shimCmdExists: true,
    shimAliasExists: true,
    shimUnixExists: true,
    extraShimExists: true,
    userPath: paths.binDir,
    pathSep: ';',
    caseInsensitive: true,
    taskRegistered: true,
    daemonPid: 12,
    daemonAlive: true,
    apiHealthy: true,
    apiPort: 18765,
    manifestExists: true,
    manifestOwned: true,
    lifecycleExpected: { path: true, task: true, daemon: true },
    lifecycleLockHealthy: true,
    lifecycleLockState: 'clear',
    lifecycleWalPending: false,
    dataMarkerOk: true,
    packageVersion: '1.0.0',
    installedVersion: '1.0.0',
    versionMatch: true,
    corpusEmpty: false
  })
  assert.equal(healthy.ok, true)
  assert.equal(healthy.issues.length, 0)
})
