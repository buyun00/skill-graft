import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  localDataRootsEqual,
  renderShims,
  resolveInstallPaths,
  resolveLocalDataRoot,
  toGitBashPath
} from '../dist/index.js'
import { createInstallHost as createInstallHostAdapter } from '../dist/adapters/install-host.js'
import {
  createPosixDaemonLaunchSpec,
  startDaemonDetached,
  uninstallHub
} from '../dist/control/install.js'
import { reviewFiles } from '../dist/control/daemon.js'
import { hubRoot } from './helpers.mjs'

const pathApi = {
  join: (...parts) => path.join(...parts),
  resolve: (...parts) => path.resolve(...parts),
  dirname: (value) => path.dirname(value),
  basename: (value) => path.basename(value)
}

const INSTALL_ENVIRONMENT_NAMES = [
  'SKILL_GRAFT_HOME', 'HUB_ROOT', 'SG_INSTALL_DIR', 'HUB_API_PORT',
  'SKILL_GRAFT_INVOCATION_TRACE', 'SKILL_GRAFT_REAL_E2E', 'SKILL_GRAFT_RUN_ID', 'SKILL_GRAFT_E2E_ROOT',
  'PATH', 'DSH_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP',
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

function tempRoot(t, prefix = 'skill-graft-data-root-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => removeTempRoot(root))
  return root
}

function removeTempRoot(root) {
  const relative = path.relative(os.tmpdir(), root)
  assert.equal(relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`), true)
  const waiter = new Int32Array(new SharedArrayBuffer(4))
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      fs.rmSync(root, { recursive: true, force: true })
      return
    } catch (error) {
      if (!['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(error?.code) || attempt === 99) throw error
      Atomics.wait(waiter, 0, 0, 50)
    }
  }
}

function withoutDataRootEnvironment(overrides = {}) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => {
    const upper = name.toUpperCase()
    return upper !== 'SKILL_GRAFT_HOME' && upper !== 'HUB_ROOT'
  }))
  return { ...environment, ...overrides }
}

function findPosixShell() {
  if (process.platform !== 'win32') return fs.existsSync('/bin/sh') ? '/bin/sh' : 'sh'
  const found = spawnSync('where.exe', ['git.exe'], { encoding: 'utf8', windowsHide: true })
  const git = found.status === 0
    ? String(found.stdout || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean)
    : ''
  const candidates = [
    git ? path.resolve(path.dirname(git), '..', 'bin', 'sh.exe') : '',
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'sh.exe')
  ]
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || ''
}

async function waitForFile(file, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (!fs.existsSync(file) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return fs.existsSync(file)
}

test('Local data-root resolver prefers SKILL_GRAFT_HOME, accepts the legacy alias, and compares lexically', (t) => {
  const root = tempRoot(t)
  const packageRoot = path.join(root, 'package')
  const primary = path.join(root, 'primary')
  const explicit = path.join(root, 'explicit')
  const equivalent = path.join(root, 'segment', '..', 'primary')

  assert.equal(resolveLocalDataRoot({
    packageRoot,
    environment: { SKILL_GRAFT_HOME: primary }
  }), path.resolve(primary))
  assert.equal(resolveLocalDataRoot({
    packageRoot,
    environment: { HUB_ROOT: primary }
  }), path.resolve(primary))
  assert.equal(resolveLocalDataRoot({
    packageRoot,
    environment: { SKILL_GRAFT_HOME: primary, HUB_ROOT: equivalent }
  }), path.resolve(primary))
  assert.equal(resolveLocalDataRoot({
    packageRoot,
    dataRoot: explicit,
    environment: { SKILL_GRAFT_HOME: primary, HUB_ROOT: primary }
  }), path.resolve(explicit))
  assert.equal(localDataRootsEqual(primary, equivalent), true)
  assert.equal(localDataRootsEqual('/Case/Root', '/case/root', 'linux', '/cwd'), false)
  assert.equal(localDataRootsEqual('C:\\Case\\Root', 'c:\\case\\root', 'win32', 'C:\\cwd'), true)

  if (process.platform === 'win32') {
    assert.equal(resolveLocalDataRoot({
      packageRoot: 'C:\\package',
      environment: {
        SKILL_GRAFT_HOME: 'C:\\Data\\.\\Root',
        HUB_ROOT: 'c:\\data\\root\\'
      },
      platform: 'win32',
      cwd: 'C:\\cwd'
    }), 'C:\\Data\\Root')
    assert.equal(resolveLocalDataRoot({
      packageRoot: 'C:\\package',
      environment: {
        SKILL_GRAFT_HOME: '\\\\Server\\Share\\folder\\..\\root',
        HUB_ROOT: '\\\\server\\share\\root\\'
      },
      platform: 'win32',
      cwd: 'C:\\cwd'
    }), '\\\\Server\\Share\\root')
    for (const deviceRoot of ['\\\\?\\C:\\Data', '\\\\.\\C:\\Data', '\\??\\C:\\Data']) {
      assert.throws(() => resolveLocalDataRoot({
        packageRoot: 'C:\\package',
        environment: { SKILL_GRAFT_HOME: deviceRoot },
        platform: 'win32',
        cwd: 'C:\\cwd'
      }), (error) => error?.code === 'INVALID_DATA_ROOT')
    }
    for (const invalidRoot of [
      'C:\\',
      '\\root-relative',
      '/root-relative',
      'C:drive-relative',
      'relative',
      '\\\\server',
      '\\\\server\\',
      '\\\\server\\share',
      '\\\\server\\share\\folder\\..',
      '\\\\server\\\\share',
      '\\\\\\server\\share',
      '\\\\server\\.\\path',
      '\\\\server\\share?\\path'
    ]) {
      assert.throws(() => resolveLocalDataRoot({
        packageRoot: 'C:\\package',
        environment: { SKILL_GRAFT_HOME: invalidRoot },
        platform: 'win32',
        cwd: 'C:\\cwd'
      }), (error) => error?.code === 'INVALID_DATA_ROOT', invalidRoot)
    }
  }
  for (const filesystemRoot of ['/', '/tmp/..']) {
    assert.throws(() => resolveLocalDataRoot({
      packageRoot: '/package',
      environment: { SKILL_GRAFT_HOME: filesystemRoot },
      platform: 'linux',
      cwd: '/cwd'
    }), (error) => error?.code === 'INVALID_DATA_ROOT', filesystemRoot)
  }
})

test('Local data-root resolver rejects whitespace, unsafe roots, and conflicts before explicit overrides', (t) => {
  const root = tempRoot(t)
  const packageRoot = path.join(root, 'package')
  const primary = path.join(root, 'primary')
  const legacy = path.join(root, 'legacy')

  for (const value of [' ', ` ${primary}`, `${primary} `, `${primary}\nchild`, `${primary}"child`]) {
    assert.throws(() => resolveLocalDataRoot({
      packageRoot,
      environment: { SKILL_GRAFT_HOME: value }
    }), (error) => error?.code === 'INVALID_DATA_ROOT')
  }
  assert.throws(() => resolveLocalDataRoot({
    packageRoot,
    dataRoot: path.join(root, 'explicit'),
    environment: { SKILL_GRAFT_HOME: primary, HUB_ROOT: legacy }
  }), (error) => error?.code === 'DATA_ROOT_CONFLICT')
})

test('CLI and server reject conflicting roots before filesystem writes or listeners', async (t) => {
  const root = tempRoot(t)
  const primary = path.join(root, 'victims', 'primary')
  const legacy = path.join(root, 'victims', 'legacy')
  const cliWriteMarker = path.join(root, 'cli-write-attempted.txt')
  const listenMarker = path.join(root, 'listener-attempted.txt')
  const cliPreload = path.join(root, 'cli-preload.cjs')
  const serverPreload = path.join(root, 'server-preload.cjs')

  fs.writeFileSync(cliPreload, [
    "const fs = require('node:fs')",
    "const { syncBuiltinESMExports } = require('node:module')",
    'const marker = process.env.SG_DATA_ROOT_WRITE_MARKER',
    'const writeMarker = fs.writeFileSync.bind(fs)',
    "for (const method of ['mkdirSync', 'writeFileSync', 'appendFileSync', 'renameSync', 'rmSync', 'unlinkSync']) {",
    '  const original = fs[method].bind(fs)',
    "  fs[method] = function (...args) { writeMarker(marker, method + '\\n'); return original(...args) }",
    '}',
    'syncBuiltinESMExports()'
  ].join('\n'))
  // Use a listener-specific probe for the API process. It has no reason to touch either victim root.
  fs.writeFileSync(serverPreload, [
    "const fs = require('node:fs')",
    "const http = require('node:http')",
    "const marker = process.env.SG_DATA_ROOT_LISTEN_MARKER",
    'const original = http.Server.prototype.listen',
    'http.Server.prototype.listen = function (...args) { fs.writeFileSync(marker, String(args[0])); return original.apply(this, args) }'
  ].join('\n'))

  const cli = spawnSync(process.execPath, [
    '--require',
    cliPreload,
    path.join(hubRoot, 'dist', 'control', 'cli.js'),
    'status'
  ], {
    cwd: hubRoot,
    encoding: 'utf8',
    windowsHide: true,
    env: withoutDataRootEnvironment({
      SKILL_GRAFT_HOME: primary,
      HUB_ROOT: legacy,
      HUB_SPAWN_CODEX: '0',
      SG_DATA_ROOT_WRITE_MARKER: cliWriteMarker
    })
  })
  assert.notEqual(cli.status, 0)
  assert.match(cli.stderr, /SKILL_GRAFT_HOME and HUB_ROOT resolve to different data roots/)
  assert.equal(fs.existsSync(primary), false)
  assert.equal(fs.existsSync(legacy), false)
  assert.equal(fs.existsSync(cliWriteMarker), false)

  const child = spawn(process.execPath, ['--require', serverPreload, path.join(hubRoot, 'server', 'index.mjs')], {
    cwd: hubRoot,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: withoutDataRootEnvironment({
      SKILL_GRAFT_HOME: primary,
      HUB_ROOT: legacy,
      HUB_API_PORT: '21979',
      HUB_SPAWN_CODEX: '0',
      SG_DATA_ROOT_LISTEN_MARKER: listenMarker
    })
  })
  t.after(() => {
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL')
  })
  const stderr = []
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)))
  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('conflicting-root server did not exit')), 5000)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
  })
  assert.notEqual(exit.code, 0)
  assert.match(stderr.join(''), /SKILL_GRAFT_HOME and HUB_ROOT resolve to different data roots/)
  assert.equal(fs.existsSync(listenMarker), false)
  assert.equal(fs.existsSync(primary), false)
  assert.equal(fs.existsSync(legacy), false)
})

test('detached daemon rejects a conflict before markers, process launch, or host creation', async (t) => {
  const root = tempRoot(t)
  const packageRoot = path.join(root, 'package')
  const primary = path.join(root, 'primary')
  const legacy = path.join(root, 'legacy')
  const explicit = path.join(root, 'explicit')
  const mutations = []
  const host = createInstallHost({
    skipPath: true,
    skipTask: true,
    env: (name) => {
      if (name === 'SKILL_GRAFT_HOME') return primary
      if (name === 'HUB_ROOT') return legacy
      return undefined
    },
    extraShimDir: () => null,
    pidAlive: () => false,
    wmiCreate: () => { mutations.push('process'); return 0 },
    killPid: () => { mutations.push('kill'); return true }
  })

  await assert.rejects(startDaemonDetached(packageRoot, host, explicit), (error) => error?.code === 'DATA_ROOT_CONFLICT')
  assert.deepEqual(mutations, [])
  assert.equal(fs.existsSync(primary), false)
  assert.equal(fs.existsSync(legacy), false)
  assert.equal(fs.existsSync(explicit), false)
})

test('InstallHost detached launcher returns while its exact owned child is still running', async (t) => {
  const root = tempRoot(t)
  const marker = path.join(root, 'detached-child-ready.txt')
  const host = createInstallHost()
  let pid = 0
  t.after(() => {
    if (pid > 0 && host.pidAlive(pid)) {
      host.killPid(pid)
      host.waitForPidsExit([pid], 5000)
    }
  })
  const childScript = [
    "require('node:fs').writeFileSync(process.env.SG_DETACHED_READY, String(process.pid))",
    'setInterval(() => {}, 1000)'
  ].join('; ')
  const startedAt = Date.now()
  pid = host.launchDetached(process.execPath, ['-e', childScript], {
    cwd: root,
    env: { ...process.env, SG_DETACHED_READY: marker }
  })
  const elapsed = Date.now() - startedAt

  assert.ok(pid > 0)
  assert.ok(elapsed < 1500, `detached launch blocked for ${elapsed}ms`)
  assert.equal(await waitForFile(marker), true)
  assert.equal(Number(fs.readFileSync(marker, 'utf8')), pid)
  assert.equal(host.pidAlive(pid), true)
  assert.equal(host.killPid(pid), true)
  assert.equal(host.waitForPidsExit([pid], 5000), true)
})

test('POSIX detached launch spec executes a complete reviewed environment with fixed aliases', async (t) => {
  const root = tempRoot(t)
  const marker = path.join(root, 'posix-launch.json')
  const traceMarker = path.join(root, 'posix-trace-launch.json')
  const cli = path.join(root, 'fake-cli.cjs')
  const dataRoot = "/owned/skill } space $ ` back\\slash"
  fs.writeFileSync(cli, [
    "const fs = require('node:fs')",
    "fs.writeFileSync(process.env.SG_POSIX_LAUNCH_MARKER, JSON.stringify({",
    '  argv: process.argv.slice(2),',
    '  primary: process.env.SKILL_GRAFT_HOME,',
    '  legacy: process.env.HUB_ROOT,',
    '  port: process.env.HUB_API_PORT,',
    '  path: process.env.PATH,',
    '  home: process.env.HOME,',
    '  preserved: process.env.SG_PRESERVED,',
    "  inheritedOnly: Object.prototype.hasOwnProperty.call(process.env, 'SG_DETACHED_INHERITED_ONLY'),",
    "  git: Object.keys(process.env).filter((name) => /^GIT_/i.test(name)).sort(),",
    "  dsh: Object.keys(process.env).filter((name) => /^DSH_/i.test(name)).sort()",
    '}))'
  ].join('\n'))
  const baseEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => ![
    'PATH', 'HOME', 'SKILL_GRAFT_HOME', 'HUB_ROOT', 'SG_DETACHED_INHERITED_ONLY'
  ].includes(name.toUpperCase())))
  Object.assign(baseEnvironment, {
    PATH: process.env.PATH || '',
    HOME: path.join(root, 'ordinary-home'),
    SKILL_GRAFT_HOME: '/conflicting/primary',
    HUB_ROOT: '/conflicting/legacy',
    SG_PRESERVED: 'ordinary-value',
    SG_POSIX_LAUNCH_MARKER: marker
  })
  const frozenEnvironment = Object.freeze({ ...baseEnvironment })
  let hostEnvReads = 0
  const host = createInstallHost({
    environment: () => frozenEnvironment,
    env: () => {
      hostEnvReads += 1
      return 'contradictory-host-env-value'
    }
  })
  const launch = createPosixDaemonLaunchSpec({
    nodePath: process.execPath,
    cliPath: cli,
    packageRoot: root,
    dataRoot,
    port: 22911
  }, host.environment())
  const priorInheritedOnly = process.env.SG_DETACHED_INHERITED_ONLY
  process.env.SG_DETACHED_INHERITED_ONLY = 'must-not-be-merged-by-launchDetached'
  t.after(() => {
    if (priorInheritedOnly === undefined) delete process.env.SG_DETACHED_INHERITED_ONLY
    else process.env.SG_DETACHED_INHERITED_ONLY = priorInheritedOnly
  })

  const startedAt = Date.now()
  const pid = host.launchDetached(launch.command, launch.args, launch.opts)
  const elapsed = Date.now() - startedAt
  assert.ok(pid > 0)
  assert.ok(elapsed < 1500, `detached launch blocked for ${elapsed}ms`)
  assert.equal(await waitForFile(marker), true)
  assert.equal(hostEnvReads, 0)
  assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), {
    argv: ['daemon', 'run'],
    primary: dataRoot,
    legacy: dataRoot,
    port: '22911',
    path: baseEnvironment.PATH,
    home: baseEnvironment.HOME,
    preserved: 'ordinary-value',
    inheritedOnly: false,
    git: Object.keys(baseEnvironment).filter((name) => /^GIT_/i.test(name)).sort(),
    dsh: Object.keys(baseEnvironment).filter((name) => /^DSH_/i.test(name)).sort()
  })
  assert.equal(host.waitForPidsExit([pid], 5000), true)

  const trace = {
    runId: 'trace-posix-environment',
    runRoot: '/trace-posix-environment',
    pinned: {
      PATH: process.env.PATH || '',
      DSH_HOME: '/trace/home/dsh-home',
      HOME: '/trace/home',
      USERPROFILE: '/trace/home',
      APPDATA: '/trace/home/appdata',
      LOCALAPPDATA: '/trace/home/localappdata',
      TEMP: '/trace/home/temp',
      TMP: '/trace/home/temp',
      HUB_SPAWN_CODEX: '0',
      SKILL_GRAFT_HOME: dataRoot,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_OPTIONAL_LOCKS: '0'
    }
  }
  const traceBase = {
    ...baseEnvironment,
    SKILL_GRAFT_HOME: '/wrong-trace-primary',
    HUB_ROOT: '/wrong-trace-legacy',
    Git_Dir: '/must/not/survive',
    gIt_Extra: 'must-not-survive',
    dSh_Extra: 'must-not-survive',
    SG_POSIX_LAUNCH_MARKER: traceMarker
  }
  const traceLaunch = createPosixDaemonLaunchSpec({
    nodePath: process.execPath,
    cliPath: cli,
    packageRoot: root,
    dataRoot,
    port: 22912
  }, traceBase, trace)
  const tracePid = host.launchDetached(traceLaunch.command, traceLaunch.args, traceLaunch.opts)
  assert.ok(tracePid > 0)
  assert.equal(await waitForFile(traceMarker), true)
  assert.equal(hostEnvReads, 0)
  assert.deepEqual(JSON.parse(fs.readFileSync(traceMarker, 'utf8')), {
    argv: ['daemon', 'run'],
    primary: dataRoot,
    legacy: dataRoot,
    port: '22912',
    path: trace.pinned.PATH,
    home: trace.pinned.HOME,
    preserved: 'ordinary-value',
    inheritedOnly: false,
    git: ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_OPTIONAL_LOCKS'],
    dsh: ['DSH_HOME']
  })
  assert.equal(host.waitForPidsExit([tracePid], 5000), true)
})

test('POSIX detached start uses argv spawning and pins both aliases to an explicit dataRoot', async (t) => {
  if (process.platform === 'win32') {
    t.skip('native install path resolution is Windows-specific on this host; launch spec is executed above')
    return
  }
  const root = tempRoot(t)
  const dataRoot = path.join(root, 'posix-data')
  const packageRoot = path.join(root, 'package')
  const installDir = path.join(root, 'install')
  const port = 22911
  const live = new Set([9101, 9102])
  const launches = []
  const host = createInstallHost({
    platform: 'linux',
    home: root,
    localAppData: root,
    skipPath: true,
    skipTask: true,
    env: (name) => {
      if (name === 'SG_INSTALL_DIR') return installDir
      if (name === 'HUB_API_PORT') return String(port)
      return undefined
    },
    extraShimDir: () => null,
    pidAlive: (pid) => live.has(pid),
    processCommandLine: (pid) => pid === 9101
      ? `node "${path.join(packageRoot, 'dist', 'control', 'cli.js')}" daemon run`
      : `node "${path.join(packageRoot, 'server', 'index.mjs')}"`,
    wmiCreate: () => { throw new Error('POSIX detached start used the Windows launcher') },
    launchDetached: (command, args, opts) => {
      launches.push({ command, args: [...args], cwd: opts.cwd, env: { ...opts.env } })
      const files = reviewFiles(dataRoot)
      fs.mkdirSync(files.review, { recursive: true })
      fs.writeFileSync(files.pidFile, '9101\n')
      fs.writeFileSync(files.apiPidFile, '9102\n')
      fs.writeFileSync(files.heartbeatFile, `${JSON.stringify({
        pid: 9101,
        apiPid: 9102,
        packageRoot,
        dataRoot,
        port,
        apiHealthy: true,
        lastBeat: new Date().toISOString()
      })}\n`)
      return 9101
    },
    killPid: (pid) => { live.delete(pid); return true },
    waitForPidsExit: (pids) => pids.every((pid) => !live.has(pid))
  })

  const result = await startDaemonDetached(packageRoot, host, dataRoot, {
    ping: async () => true
  })
  assert.equal(result.ok, true, result.detail)
  assert.equal(launches.length, 1)
  assert.equal(launches[0].command, process.execPath)
  assert.deepEqual(launches[0].args, [path.join(packageRoot, 'dist', 'control', 'cli.js'), 'daemon', 'run'])
  assert.equal(launches[0].cwd, path.resolve(packageRoot))
  assert.equal(launches[0].env.SKILL_GRAFT_HOME, dataRoot)
  assert.equal(launches[0].env.HUB_ROOT, dataRoot)
  assert.equal(launches[0].env.HUB_API_PORT, String(port))
})

test('uninstall remains compatible with legacy HUB_ROOT and clears only the selected root alias', async (t) => {
  const root = tempRoot(t)
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'legacy-data')
  const installDir = path.join(root, 'install')
  fs.mkdirSync(installDir, { recursive: true })
  fs.writeFileSync(path.join(installDir, 'installed.txt'), 'fixture\n')
  const environment = new Map([
    ['HUB_ROOT', dataRoot],
    ['SG_INSTALL_DIR', installDir]
  ])
  const environmentWrites = []
  const host = createInstallHost({
    platform: 'win32',
    home: root,
    localAppData: root,
    skipPath: false,
    skipTask: true,
    env: (name) => environment.get(name),
    extraShimDir: () => null,
    pidAlive: () => false,
    userPath: () => '',
    setUserPath: () => {},
    setUserEnv: (name, value) => {
      environmentWrites.push([name, value])
      if (value === null) environment.delete(name)
      else environment.set(name, value)
    },
    broadcastEnv: () => {}
  })

  const result = await uninstallHub(packageRoot, host)
  assert.equal(result.ok, true, JSON.stringify(result.issues))
  assert.deepEqual(environmentWrites, [['HUB_ROOT', null]])
  assert.equal(environment.has('HUB_ROOT'), false)
  assert.equal(environment.has('SKILL_GRAFT_HOME'), false)
})

test('installed shims pass coherent primary and compatibility roots to the child', (t) => {
  const root = tempRoot(t)
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  const cliPath = path.join(packageRoot, 'dist', 'control', 'cli.js')
  fs.mkdirSync(path.dirname(cliPath), { recursive: true })
  fs.writeFileSync(cliPath, [
    "const fs = require('node:fs')",
    "fs.writeFileSync(process.argv[2], JSON.stringify({ primary: process.env.SKILL_GRAFT_HOME, legacy: process.env.HUB_ROOT }))"
  ].join('\n'))
  const paths = resolveInstallPaths(pathApi, {
    hubRoot: packageRoot,
    packageRoot,
    dataRoot,
    nodePath: process.execPath,
    installDir
  })
  const shims = renderShims(paths)
  fs.mkdirSync(paths.binDir, { recursive: true })
  fs.writeFileSync(paths.shimCmd, shims.sgCmd)
  fs.writeFileSync(paths.shimUnix, shims.unix, { mode: 0o700 })

  const run = (marker, environment) => process.platform === 'win32'
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', paths.shimCmd, marker], {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
        env: environment
      })
    : spawnSync('/bin/sh', [paths.shimUnix, marker], {
        cwd: root,
        encoding: 'utf8',
        env: environment
      })

  const defaultMarker = path.join(root, 'default-child.json')
  const defaultRun = run(defaultMarker, withoutDataRootEnvironment())
  assert.equal(defaultRun.status, 0, defaultRun.stderr || defaultRun.stdout)
  assert.deepEqual(JSON.parse(fs.readFileSync(defaultMarker, 'utf8')), {
    primary: path.resolve(dataRoot),
    legacy: path.resolve(dataRoot)
  })

  const legacyRoot = path.join(root, 'legacy-only')
  const legacyMarker = path.join(root, 'legacy-child.json')
  const legacyRun = run(legacyMarker, withoutDataRootEnvironment({ HUB_ROOT: legacyRoot }))
  assert.equal(legacyRun.status, 0, legacyRun.stderr || legacyRun.stdout)
  assert.deepEqual(
    JSON.parse(fs.readFileSync(legacyMarker, 'utf8')),
    process.platform === 'win32'
      ? { legacy: legacyRoot }
      : { primary: legacyRoot, legacy: legacyRoot }
  )
})

test('Unix shim single-quotes fallback roots containing shell metacharacters', (t) => {
  const shell = findPosixShell()
  if (!shell) {
    t.skip('no POSIX shell is available')
    return
  }
  const root = tempRoot(t)
  const packageRoot = path.join(root, 'package')
  const installDir = path.join(root, 'install')
  const cliPath = path.join(packageRoot, 'dist', 'control', 'cli.js')
  const marker = path.join(root, 'unix-child.json')
  fs.mkdirSync(path.dirname(cliPath), { recursive: true })
  fs.writeFileSync(cliPath, [
    "const fs = require('node:fs')",
    "fs.writeFileSync(process.env.SG_UNIX_SHIM_MARKER, JSON.stringify({ primary: process.env.SKILL_GRAFT_HOME, legacy: process.env.HUB_ROOT }))"
  ].join('\n'))
  const basePaths = resolveInstallPaths(pathApi, {
    hubRoot: packageRoot,
    packageRoot,
    dataRoot: path.join(root, 'ordinary-data'),
    nodePath: process.execPath,
    installDir
  })
  const fallbackRoot = "/tmp/skill } space $ ` back\\slash and ' quote"
  const paths = { ...basePaths, dataRoot: fallbackRoot, hubRoot: fallbackRoot }
  const shim = renderShims(paths).unix
  fs.mkdirSync(paths.binDir, { recursive: true })
  fs.writeFileSync(paths.shimUnix, shim, { mode: 0o700 })
  const result = spawnSync(shell, [toGitBashPath(paths.shimUnix), 'probe'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env: withoutDataRootEnvironment({ SG_UNIX_SHIM_MARKER: marker })
  })

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), {
    primary: fallbackRoot,
    legacy: fallbackRoot
  })
  assert.doesNotMatch(shim, /\$\{(?:SKILL_GRAFT_HOME|HUB_ROOT):-/)
  assert.match(shim, /SKILL_GRAFT_HOME='\/tmp\/skill } space \$ ` back/)
  assert.match(shim, /'\\''/)
})

test('trace run-daemon launcher assigns each data-root alias exactly once and fake CLI receives the fixed root', {
  skip: process.platform !== 'win32'
}, (t) => {
  const root = tempRoot(t)
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  const cliPath = path.join(packageRoot, 'dist', 'control', 'cli.js')
  const marker = path.join(root, 'run-daemon-child.json')
  fs.mkdirSync(path.dirname(cliPath), { recursive: true })
  fs.writeFileSync(cliPath, [
    "const fs = require('node:fs')",
    "fs.writeFileSync(process.env.SG_RUN_DAEMON_MARKER, JSON.stringify({ args: process.argv.slice(2), primary: process.env.SKILL_GRAFT_HOME, legacy: process.env.HUB_ROOT }))"
  ].join('\n'))
  const paths = resolveInstallPaths(pathApi, {
    hubRoot: packageRoot,
    packageRoot,
    dataRoot,
    nodePath: process.execPath,
    installDir
  })
  const home = path.join(root, 'home')
  const trace = {
    runId: 'trace-data-root-once',
    runRoot: root,
    pinned: {
      PATH: process.env.PATH || path.dirname(process.execPath),
      DSH_HOME: path.join(home, 'dsh'),
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(home, 'appdata'),
      LOCALAPPDATA: path.join(home, 'localappdata'),
      TEMP: path.join(home, 'temp'),
      TMP: path.join(home, 'temp'),
      HUB_SPAWN_CODEX: '0',
      SKILL_GRAFT_HOME: dataRoot,
      GIT_CONFIG_GLOBAL: 'NUL',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_OPTIONAL_LOCKS: '0'
    }
  }
  const launcher = renderShims(paths, trace).runDaemonCmd
  assert.equal((launcher.match(/^set "SKILL_GRAFT_HOME=/gm) || []).length, 1)
  assert.equal((launcher.match(/^set "HUB_ROOT=/gm) || []).length, 1)
  fs.mkdirSync(paths.installDir, { recursive: true })
  fs.writeFileSync(paths.runDaemonCmd, launcher)
  const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', paths.runDaemonCmd], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, SG_RUN_DAEMON_MARKER: marker }
  })

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), {
    args: ['daemon', 'run'],
    primary: path.resolve(dataRoot),
    legacy: path.resolve(dataRoot)
  })
})

test('Windows sg shim never expands hostile inherited roots and lets the Node resolver fail closed', {
  skip: process.platform !== 'win32'
}, (t) => {
  const root = tempRoot(t)
  const fallbackRoot = path.join(root, 'fallback-data')
  const installDir = path.join(root, 'install')
  const sentinel = path.join(root, 'must-not-exist.txt')
  const paths = resolveInstallPaths(pathApi, {
    hubRoot,
    packageRoot: hubRoot,
    dataRoot: fallbackRoot,
    nodePath: process.execPath,
    installDir
  })
  const shim = renderShims(paths).sgCmd
  fs.mkdirSync(paths.binDir, { recursive: true })
  fs.writeFileSync(paths.shimCmd, shim)
  const hostile = `x!%&^()" & echo compromised>"${sentinel}" & rem "`
  const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', paths.shimCmd, 'status'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env: withoutDataRootEnvironment({ HUB_ROOT: hostile, HUB_SPAWN_CODEX: '0' })
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /HUB_ROOT contains an unsafe path character/)
  assert.equal(fs.existsSync(sentinel), false)
  assert.equal(fs.existsSync(fallbackRoot), false)
  assert.match(shim, /setlocal DisableDelayedExpansion/)
  assert.doesNotMatch(shim, /%HUB_ROOT%|%SKILL_GRAFT_HOME%/)
})
