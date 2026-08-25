import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { Server } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { createInstallHost as createInstallHostAdapter } from '../dist/adapters/install-host.js'
import { applicationLeaseRoot, createLeaseLockManager } from '../dist/adapters/lease-lock.js'
import { LOCAL_RUNTIME_ASSET_PATHS } from '../dist/adapters/local-runtime-assets.js'
import {
  acquireDaemonRunLifecycleGuard,
  doctorHub,
  inspectLifecycleRootReceipt,
  installPathsFor,
  lifecycleRootReceiptPath,
  purgeHub,
  readDaemonLifecycleReceiptAuthority,
  resolveDataRoot,
  setupHub,
  stopDaemonGuarded,
  uninstallHub,
  upgradeHub
} from '../dist/control/install.js'
import {
  acquireCommittedDaemonStartCollapseAuthority,
  bootstrapDaemonStageNamespace,
  collapseCommittedDaemonStart,
  commitDaemonStartInstance,
  createDaemonStartStage,
  inspectDaemonProtocol,
  inspectDaemonReceiptNamespace,
  publishDaemonStartProjection
} from '../dist/control/daemon-protocol.js'

const cliPath = path.resolve('dist/control/cli.js')

function temporaryRoot(t, label = 'p4-lifecycle') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function seedPackage(root, version, tag = version) {
  fs.mkdirSync(path.join(root, 'dist', 'control'), { recursive: true })
  fs.mkdirSync(path.join(root, 'dist', 'application'), { recursive: true })
  fs.mkdirSync(path.join(root, 'server'), { recursive: true })
  fs.mkdirSync(path.join(root, 'web', 'assets'), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({ name: 'ozdqp-skill-hub', version })}\n`)
  fs.writeFileSync(path.join(root, 'dist', 'control', 'cli.js'), `// cli ${tag}\n`)
  fs.writeFileSync(path.join(root, 'dist', 'application', 'hub-application.js'), `// application ${tag}\n`)
  fs.writeFileSync(path.join(root, 'server', 'index.mjs'), `// server ${tag}\n`)
  fs.writeFileSync(path.join(root, 'web', 'assets', 'app.js'), `// web ${tag}\n`)
  fs.writeFileSync(path.join(root, 'AGENTS.override.md'), `# public ${tag}\n`)
  for (const name of LOCAL_RUNTIME_ASSET_PATHS) {
    const file = path.join(root, 'overlay', ...name.split('/'))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `# runtime ${name} ${tag}\n`)
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function lifecycleReceiptHomeIdentity(home, platform = 'win32') {
  const stat = fs.lstatSync(home)
  const physical = fs.realpathSync.native(home)
  return sha256(`${platform === 'win32' ? physical.toLowerCase() : physical}\0${String(stat.dev)}\0${String(stat.ino)}`)
}

function markLifecycleReceiptNamespace(home) {
  const directory = path.join(home, '.skill-graft-lifecycle')
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, '.namespace-v1.skill-graft.marker'), '', { flag: 'wx' })
  return directory
}

function lifecycleReceiptWriterPath(home, leaseUntil, overrides = {}) {
  const directory = path.join(home, '.skill-graft-lifecycle')
  const ownerToken = overrides.ownerToken || '33333333-3333-4333-8333-333333333333'
  const pid = overrides.pid || 4242
  const processIdentity = overrides.processIdentity || 'b'.repeat(64)
  return path.join(
    directory,
    `.root-receipt-v1.${lifecycleReceiptHomeIdentity(home)}.${ownerToken}.${pid}.${processIdentity}.${leaseUntil}.writing`
  )
}

function treeBytes(root) {
  if (!fs.existsSync(root)) return null
  const rows = []
  const visit = (directory, prefix = '') => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name)
      const relative = prefix ? `${prefix}/${name}` : name
      const stat = fs.lstatSync(absolute)
      assert.equal(stat.isSymbolicLink(), false, relative)
      if (stat.isDirectory()) {
        rows.push(['d', `${relative}/`])
        visit(absolute, relative)
      } else rows.push(['f', relative, stat.size, sha256(fs.readFileSync(absolute))])
    }
  }
  visit(root)
  return rows
}

async function interruptLifecycleReceiptReplacement(host, action, message) {
  const receipt = lifecycleRootReceiptPath(host)
  const pending = path.join(path.dirname(receipt), 'root-receipt-v1.pending.json')
  const originalRenameSync = fs.renameSync
  let hit = false
  fs.renameSync = function (source, destination) {
    if (!hit
      && path.resolve(String(source)) === path.resolve(pending)
      && path.resolve(String(destination)) === path.resolve(receipt)) {
      hit = true
      throw new Error(message)
    }
    return originalRenameSync.call(fs, source, destination)
  }
  try {
    return { result: await action(), hit }
  } finally {
    fs.renameSync = originalRenameSync
  }
}

async function interruptLifecycleReceiptPublication(host, action, message) {
  const receipt = lifecycleRootReceiptPath(host)
  const pending = path.join(path.dirname(receipt), 'root-receipt-v1.pending.json')
  const originalRenameSync = fs.renameSync
  const originalLinkSync = fs.linkSync
  let hit = false
  const shouldCut = (source, destination) => !hit
    && path.resolve(String(source)) === path.resolve(pending)
    && path.resolve(String(destination)) === path.resolve(receipt)
  fs.renameSync = function (source, destination) {
    if (shouldCut(source, destination)) {
      hit = true
      throw new Error(message)
    }
    return originalRenameSync.call(fs, source, destination)
  }
  fs.linkSync = function (source, destination) {
    if (shouldCut(source, destination)) {
      hit = true
      throw new Error(message)
    }
    return originalLinkSync.call(fs, source, destination)
  }
  try {
    return { result: await action(), hit }
  } finally {
    fs.renameSync = originalRenameSync
    fs.linkSync = originalLinkSync
  }
}

function captureFileEvidence(file) {
  const stat = fs.lstatSync(file)
  return {
    bytes: fs.readFileSync(file),
    stat: {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      nlink: stat.nlink
    }
  }
}

function assertFileEvidence(file, expected, label = file) {
  const current = captureFileEvidence(file)
  assert.deepEqual(current.bytes, expected.bytes, `${label} bytes changed`)
  assert.deepEqual(current.stat, expected.stat, `${label} identity changed`)
}

function captureDirectoryEvidence(directory) {
  const stat = fs.lstatSync(directory)
  assert.equal(stat.isDirectory(), true)
  assert.equal(stat.isSymbolicLink(), false)
  return {
    tree: treeBytes(directory),
    stat: {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      nlink: stat.nlink
    }
  }
}

function assertDirectoryEvidence(directory, expected, label = directory) {
  const current = captureDirectoryEvidence(directory)
  assert.deepEqual(current, expected, `${label} changed`)
}

function assertLifecycleRecoveryArtifactsAbsent(paths, host, label) {
  const receiptFile = lifecycleRootReceiptPath(host)
  const receiptDirectory = path.dirname(receiptFile)
  const receiptEntries = fs.existsSync(receiptDirectory) ? fs.readdirSync(receiptDirectory) : []
  assert.equal(
    receiptEntries.includes('root-receipt-v1.pending.json'),
    false,
    `${label} retained a pending receipt`
  )
  assert.equal(
    receiptEntries.some((name) => name.startsWith('.root-receipt-v1.') && name.endsWith('.writing')),
    false,
    `${label} retained a receipt writer`
  )

  const protocolDirectory = path.dirname(paths.lifecycleWalPath)
  const protocolEntries = fs.readdirSync(protocolDirectory)
  const walBase = path.basename(paths.lifecycleWalPath)
  const ownerBase = path.basename(paths.lifecycleLockPath)
  assert.equal(fs.existsSync(paths.lifecycleWalPath), false, `${label} retained the lifecycle WAL`)
  assert.equal(fs.existsSync(paths.lifecycleLockPath), false, `${label} retained the lifecycle owner`)
  assert.equal(
    protocolEntries.some((name) => name.startsWith(`${walBase}.`) || name.startsWith(`.${walBase}.`)),
    false,
    `${label} retained a lifecycle WAL publication stage`
  )
  assert.equal(
    protocolEntries.some((name) => name.startsWith(`${ownerBase}.`)),
    false,
    `${label} retained a lifecycle owner publication stage`
  )
}

async function createCommittedUninstallCut(t, label, prepare) {
  const root = temporaryRoot(t, label)
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  seedPackage(packageRoot, '1.0.0', label)
  const { host, state } = createStatefulHost(root, {
    dataRoot,
    installDir,
    taskName: `SkillGraft-${label}`,
    skipPath: true,
    skipTask: true
  })
  assert.equal((await setupHub(packageRoot, { ...setupFlags, noPath: true, noTask: true }, host)).ok, true)
  const paths = installPathsFor(packageRoot, host)
  await prepare?.({ root, packageRoot, dataRoot, installDir, host, state, paths })
  const interrupted = await interruptLifecycleReceiptReplacement(
    host,
    () => uninstallHub(packageRoot, host),
    `${label}-committed-receipt-cut`
  )
  assert.equal(interrupted.hit, true, JSON.stringify(interrupted.result.issues))
  assert.equal(interrupted.result.ok, false)
  const wal = JSON.parse(fs.readFileSync(paths.lifecycleWalPath, 'utf8'))
  assert.equal(wal.operation, 'uninstall')
  assert.equal(wal.phase, 'committed')
  assert.equal(inspectLifecycleRootReceipt(host).state, 'active')
  assert.equal(JSON.parse(fs.readFileSync(paths.dataMarkerPath, 'utf8')).activeInstallId, null)
  assert.equal(fs.existsSync(paths.lifecycleLockPath), true)
  assert.equal(fs.existsSync(installDir), false)
  return { root, packageRoot, dataRoot, installDir, host, state, paths, wal }
}

function seedCommittedUninstallDaemonScaffold(fixture, mode = 'exact') {
  const namespaceId = '93939393-9393-4393-8393-939393939393'
  const receiptDirectory = path.dirname(lifecycleRootReceiptPath(fixture.host))
  const homeMarker = path.join(receiptDirectory, `.daemon-stage-namespace-v1.${namespaceId}.marker`)
  const stageDirectory = `${path.resolve(fixture.dataRoot)}.daemon-instance-stages`
  const innerMarker = path.join(stageDirectory, `.namespace-v1.${namespaceId}.skill-graft.marker`)
  const foreign = path.join(stageDirectory, 'foreign-sentinel')
  fs.writeFileSync(homeMarker, '', { flag: 'wx' })
  if (mode !== 'absent') {
    fs.mkdirSync(stageDirectory)
    if (mode !== 'empty') fs.writeFileSync(innerMarker, '', { flag: 'wx' })
    if (mode === 'foreign') fs.writeFileSync(foreign, 'foreign\n', { flag: 'wx' })
  }
  return { namespaceId, homeMarker, stageDirectory, innerMarker, foreign }
}

async function createSuccessfulPurge(t, label) {
  const root = temporaryRoot(t, label)
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  seedPackage(packageRoot, '1.0.0', label)
  const { host, state } = createStatefulHost(root, { dataRoot, installDir, skipPath: true, skipTask: true })
  assert.equal((await setupHub(packageRoot, { ...setupFlags, noPath: true, noTask: true }, host)).ok, true)
  const paths = installPathsFor(packageRoot, host)
  const manifestBytes = fs.readFileSync(path.join(installDir, 'install.json'))
  assert.equal((await uninstallHub(packageRoot, host)).ok, true)
  const dry = await purgeHub(packageRoot, { dataRoot, dryRun: true, commit: false, json: true }, host)
  assert.equal(dry.ok, true, JSON.stringify(dry.issues))
  const purged = await purgeHub(packageRoot, {
    dataRoot,
    dryRun: false,
    commit: true,
    planHash: dry.plan.planHash,
    dataRootId: dry.plan.dataRootId,
    json: true
  }, host)
  assert.equal(purged.ok, true, JSON.stringify(purged.issues))
  assert.equal(purged.status, 'purged')
  assert.equal(inspectLifecycleRootReceipt(host), null)
  assert.equal(fs.existsSync(dataRoot), false)
  const externalRoot = applicationLeaseRoot(dataRoot)
  assert.equal(fs.existsSync(externalRoot), true)
  assert.deepEqual(fs.readdirSync(path.join(externalRoot, 'leases')), [])
  assertLifecycleRecoveryArtifactsAbsent(paths, host, `${label} successful purge`)
  assert.equal(fs.existsSync(`${dataRoot}.purge-wal-v1.json`), false)
  assert.equal(fs.existsSync(`${dataRoot}.lifecycle-owner-stages`), false)
  const receiptDirectory = path.dirname(lifecycleRootReceiptPath(host))
  assert.equal(
    fs.readdirSync(receiptDirectory).some((name) => name.startsWith('.owner-stage-namespace-v1.')),
    false,
    `${label} retained the HOME owner-stage authority`
  )
  return { root, packageRoot, dataRoot, installDir, host, state, paths, manifestBytes, externalRoot }
}

function createForeignInstallShape(t, root, installDir, shape) {
  assert.equal(fs.existsSync(installDir), false)
  if (shape === 'regular') {
    fs.writeFileSync(installDir, 'foreign regular install replacement\n')
    const evidence = captureFileEvidence(installDir)
    return () => assertFileEvidence(installDir, evidence, 'foreign regular install replacement')
  }
  if (shape === 'directory') {
    fs.mkdirSync(installDir)
    fs.writeFileSync(path.join(installDir, 'install.json'), '{"foreign":true}\n')
    fs.writeFileSync(path.join(installDir, 'sentinel.txt'), 'foreign directory install replacement\n')
    const inode = fs.lstatSync(installDir).ino
    const bytes = treeBytes(installDir)
    return () => {
      assert.equal(fs.lstatSync(installDir).ino, inode)
      assert.deepEqual(treeBytes(installDir), bytes)
    }
  }
  const target = temporaryRoot(t, `${path.basename(root)}-foreign-install-target`)
  fs.writeFileSync(path.join(target, 'install.json'), '{"foreign":"junction"}\n')
  fs.writeFileSync(path.join(target, 'sentinel.txt'), 'foreign junction target\n')
  try {
    fs.symlinkSync(target, installDir, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    return { unsupported: error }
  }
  const linkStat = fs.lstatSync(installDir)
  const linkTarget = fs.readlinkSync(installDir)
  const targetInode = fs.lstatSync(target).ino
  const targetBytes = treeBytes(target)
  return () => {
    const current = fs.lstatSync(installDir)
    assert.equal(current.isSymbolicLink(), true)
    assert.equal(current.ino, linkStat.ino)
    assert.equal(fs.readlinkSync(installDir), linkTarget)
    assert.equal(fs.lstatSync(target).ino, targetInode)
    assert.deepEqual(treeBytes(target), targetBytes)
  }
}

function createStatefulHost(root, options = {}) {
  const selection = new Map([
    ['HUB_ROOT', options.dataRoot || path.join(root, 'data')],
    ['SG_INSTALL_DIR', options.installDir || path.join(root, 'install')],
    ['HUB_API_PORT', String(options.port || 23111)],
    ...(options.taskName ? [['SG_TASK_NAME', options.taskName]] : []),
    ...(options.extraShimDir ? [['SG_EXTRA_SHIM_DIR', options.extraShimDir]] : [])
  ])
  const userEnvironment = new Map(options.userEnvironment || [])
  const userEnvironmentKinds = new Map([...userEnvironment.keys()].map((name) => [name, 'ExpandString']))
  const tasks = new Map(options.tasks || [])
  const state = {
    selection,
    userEnvironment,
    tasks,
    userPath: options.userPath || 'C:\\Windows',
    userPathExists: options.userPathExists ?? true,
    userPathKind: options.userPathKind || 'ExpandString',
    writes: [],
    taskExistsCalls: 0
  }
  const host = createInstallHostAdapter({
    platform: 'win32',
    home: root,
    localAppData: path.join(root, 'localappdata'),
    pathSep: ';',
    caseInsensitive: true,
    skipPath: Boolean(options.skipPath),
    skipTask: Boolean(options.skipTask),
    env: (name) => selection.get(name),
    environment: () => Object.fromEntries(selection),
    extraShimDir: () => options.extraShimDir || null,
    userPathState: () => state.userPathExists
      ? { exists: true, value: state.userPath, kind: state.userPathKind }
      : { exists: false, value: '', kind: null },
    userPath: () => state.userPathExists ? state.userPath : '',
    userEnv: (name) => userEnvironment.get(name),
    userEnvState: (name) => userEnvironment.has(name)
      ? { exists: true, value: userEnvironment.get(name), kind: userEnvironmentKinds.get(name) || 'ExpandString' }
      : { exists: false, value: '', kind: null },
    integrationSnapshot: options.integrationSnapshot,
    setUserPath: (value) => { state.writes.push(['path', value]); state.userPath = value },
    setUserEnv: (name, value) => {
      state.writes.push(['env', name, value])
      if (value === null) {
        userEnvironment.delete(name)
        userEnvironmentKinds.delete(name)
      } else {
        userEnvironment.set(name, value)
        userEnvironmentKinds.set(name, 'ExpandString')
      }
    },
    compareExchangeUserPath: (expected, next) => {
      const current = state.userPathExists
        ? { exists: true, value: state.userPath, kind: state.userPathKind }
        : { exists: false, value: '', kind: null }
      if (JSON.stringify(current) !== JSON.stringify(expected)) return false
      state.writes.push(['path-cas', expected, next])
      state.userPathExists = next.exists
      state.userPath = next.value
      state.userPathKind = next.kind
      return true
    },
    compareExchangeUserEnv: (name, expected, next) => {
      const current = userEnvironment.has(name)
        ? { exists: true, value: userEnvironment.get(name), kind: userEnvironmentKinds.get(name) || 'ExpandString' }
        : { exists: false, value: '', kind: null }
      if (JSON.stringify(current) !== JSON.stringify(expected)) return false
      state.writes.push(['env-cas', name, expected, next])
      if (!next.exists) {
        userEnvironment.delete(name)
        userEnvironmentKinds.delete(name)
      } else {
        userEnvironment.set(name, next.value)
        userEnvironmentKinds.set(name, next.kind)
      }
      return true
    },
    broadcastEnv: () => state.writes.push(['broadcast']),
    taskExists: (name) => {
      state.taskExistsCalls += 1
      options.onTaskExists?.({ name, call: state.taskExistsCalls, state })
      return tasks.has(name)
    },
    taskAction: (name) => tasks.get(name) || '',
    registerLogonTask: (name, launcher) => {
      if (options.registerLogonTask) return options.registerLogonTask({ name, launcher, state })
      if (tasks.has(name)) throw new Error(`fixture refuses overwrite ${name}`)
      const action = `wscript.exe\u0000"${launcher}"`
      state.writes.push(['task-add', name, action])
      tasks.set(name, action)
    },
    stopScheduledTaskInstance: (name, launcher) => {
      if (options.stopScheduledTaskInstance) return options.stopScheduledTaskInstance({ name, launcher, state })
      state.writes.push(['task-stop-instance', name, launcher])
    },
    unregisterTask: (name, launcher) => {
      if (options.unregisterTask) return options.unregisterTask({ name, launcher, state })
      const expected = `wscript.exe\u0000"${launcher}"`
      if (launcher && tasks.get(name)?.toLowerCase() !== expected.toLowerCase()) throw new Error('foreign task')
      state.writes.push(['task-remove', name])
      tasks.delete(name)
    },
    which: (name) => name === 'git' && !options.noGit ? 'git.exe' : '',
    commandVersion: () => 'git version fixture',
    pidAlive: options.pidAlive || (() => false),
    processCommandLine: options.processCommandLine || (() => ''),
    killPid: options.killPid || (() => false),
    waitForPidsExit: options.waitForPidsExit || (() => false),
    runNpm: () => { throw new Error('prebuilt fixture unexpectedly invoked npm') }
  })
  return { host, state }
}

const setupFlags = Object.freeze({
  dryRun: false,
  json: true,
  noDaemon: true,
  noPath: false,
  noTask: false,
  rebuild: false
})

const taskSetupFlags = Object.freeze({ ...setupFlags, noDaemon: false, noTask: false })

test('lifecycle default data root is a dedicated child and never the package or HOME root', () => {
  const root = path.join(os.tmpdir(), 'p4-default-root-contract')
  const packageRoot = path.join(root, 'package')
  const winHost = createInstallHostAdapter({
    platform: 'win32',
    home: path.join(root, 'home'),
    localAppData: path.join(root, 'localappdata'),
    environment: () => ({}),
    env: () => undefined
  })
  assert.equal(resolveDataRoot(packageRoot, winHost), path.resolve(root, 'localappdata', 'skill-graft-data'))
  assert.notEqual(resolveDataRoot(packageRoot, winHost), path.resolve(packageRoot))
  assert.notEqual(resolveDataRoot(packageRoot, winHost), path.resolve(root, 'home'))
})

test('stable lifecycle root receipt namespace is strict, bounded, and locator-only', async (t) => {
  const root = temporaryRoot(t, 'p4-root-receipt')
  const makeHost = (home) => createInstallHostAdapter({
    platform: 'win32',
    home,
    localAppData: path.join(home, 'localappdata'),
    localVolumeKind: () => 'local',
    environment: () => ({}),
    env: () => undefined
  })
  const recordFor = (home, overrides = {}) => ({
    schemaVersion: 1,
    product: 'skill-graft',
    state: 'active',
    installId: '11111111-1111-4111-8111-111111111111',
    dataRootId: '22222222-2222-4222-8222-222222222222',
    dataRoot: path.join(home, 'data'),
    installDir: path.join(home, 'install'),
    packageRoot: path.join(home, 'package'),
    packageVersion: '1.0.0',
    packageSha256: `sha256:${'a'.repeat(64)}`,
    createdAt: '2026-08-23T00:00:00.000Z',
    updatedAt: '2026-08-23T00:00:00.000Z',
    ...overrides
  })

  await t.test('missing and empty reserved namespace are read-only absence', () => {
    const home = path.join(root, 'empty-home')
    fs.mkdirSync(home)
    const host = makeHost(home)
    const file = lifecycleRootReceiptPath(host)
    assert.equal(file, path.join(home, '.skill-graft-lifecycle', 'root-receipt-v1.json'))
    assert.equal(inspectLifecycleRootReceipt(host), null)
    assert.equal(fs.existsSync(path.dirname(file)), false)
    fs.mkdirSync(path.dirname(file))
    assert.equal(inspectLifecycleRootReceipt(host), null)
  })

  await t.test('a first marker file-fsync failure is durably reproved on retry', async () => {
    const home = path.join(root, 'marker-fsync-retry-home')
    const packageRoot = path.join(home, 'package')
    seedPackage(packageRoot, '1.0.0', 'marker-fsync-retry')
    const marker = path.join(home, '.skill-graft-lifecycle', '.namespace-v1.skill-graft.marker')
    const { host, state } = createStatefulHost(home, {
      dataRoot: path.join(home, 'data'),
      installDir: path.join(home, 'install'),
      skipPath: true,
      skipTask: true
    })
    const originalOpenSync = fs.openSync
    const originalFsyncSync = fs.fsyncSync
    let markerDescriptor = -1
    let injected = false
    fs.openSync = function (target, flags, mode) {
      const descriptor = originalOpenSync.call(fs, target, flags, mode)
      if (path.resolve(String(target)) === path.resolve(marker)) markerDescriptor = descriptor
      return descriptor
    }
    fs.fsyncSync = function (descriptor) {
      if (!injected && descriptor === markerDescriptor) {
        injected = true
        const error = new Error('injected marker file fsync failure')
        error.code = 'EIO'
        throw error
      }
      return originalFsyncSync.call(fs, descriptor)
    }
    let first
    try {
      first = await setupHub(packageRoot, { ...setupFlags, noPath: true, noTask: true }, host)
    } finally {
      fs.openSync = originalOpenSync
      fs.fsyncSync = originalFsyncSync
    }
    assert.equal(injected, true)
    assert.equal(first.ok, false)
    assert.equal(fs.existsSync(marker), true)
    assert.equal(inspectLifecycleRootReceipt(host), null)
    assert.equal(fs.existsSync(path.join(home, 'install')), false)
    assert.deepEqual(state.writes, [])

    const retry = await setupHub(packageRoot, { ...setupFlags, noPath: true, noTask: true }, host)
    assert.equal(retry.ok, true, JSON.stringify(retry.issues))
    assert.equal(inspectLifecycleRootReceipt(host)?.state, 'active')
  })

  await t.test('exact receipt and deterministic complete pending are discoverable', () => {
    const home = path.join(root, 'valid-home')
    markLifecycleReceiptNamespace(home)
    const host = makeHost(home)
    const record = recordFor(home)
    const file = lifecycleRootReceiptPath(host)
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`)
    assert.deepEqual(inspectLifecycleRootReceipt(host), record)
    fs.unlinkSync(file)
    fs.writeFileSync(path.join(path.dirname(file), 'root-receipt-v1.pending.json'), `${JSON.stringify(record, null, 2)}\n`)
    assert.deepEqual(inspectLifecycleRootReceipt(host), record)
  })

  await t.test('the exact publication hard-link pair is the only linked state', () => {
    const home = path.join(root, 'linked-home')
    markLifecycleReceiptNamespace(home)
    const host = makeHost(home)
    const record = recordFor(home)
    const file = lifecycleRootReceiptPath(host)
    const pending = path.join(path.dirname(file), 'root-receipt-v1.pending.json')
    fs.writeFileSync(pending, `${JSON.stringify(record, null, 2)}\n`)
    fs.linkSync(pending, file)
    assert.deepEqual(inspectLifecycleRootReceipt(host), record)
    fs.unlinkSync(pending)
    const foreignLink = path.join(home, 'foreign-link.json')
    fs.linkSync(file, foreignLink)
    assert.throws(() => inspectLifecycleRootReceipt(host), /ambiguous hard-link publication|bounded plain protocol file/)
    assert.equal(fs.readFileSync(foreignLink, 'utf8'), `${JSON.stringify(record, null, 2)}\n`)
  })

  await t.test('foreign, malformed, and overlapping records fail without mutation', () => {
    for (const [name, arrange, pattern] of [
      ['foreign-entry', (directory) => fs.writeFileSync(path.join(directory, 'foreign.txt'), 'foreign'), /foreign entry/],
      ['malformed', (directory) => fs.writeFileSync(path.join(directory, 'root-receipt-v1.json'), '{'), /invalid lifecycle root receipt JSON/],
      ['overlap', (directory, home) => fs.writeFileSync(
        path.join(directory, 'root-receipt-v1.json'),
        `${JSON.stringify(recordFor(home, { dataRoot: path.join(directory, 'nested-data') }), null, 2)}\n`
      ), /receipt root and data root must be disjoint/]
    ]) {
      const home = path.join(root, name)
      const directory = path.join(home, '.skill-graft-lifecycle')
      markLifecycleReceiptNamespace(home)
      const host = makeHost(home)
      arrange(directory, home)
      const before = treeBytes(home)
      assert.throws(() => inspectLifecycleRootReceipt(host), pattern)
      assert.deepEqual(treeBytes(home), before)
    }
  })

  await t.test('unmarked non-empty namespace and recent partial writer are zero-write blockers', async () => {
    const unmarkedHome = path.join(root, 'unmarked-writer-home')
    const unmarkedDirectory = path.join(unmarkedHome, '.skill-graft-lifecycle')
    fs.mkdirSync(unmarkedDirectory, { recursive: true })
    fs.writeFileSync(path.join(unmarkedDirectory, '.root-receipt-v1.foreign.writing'), 'partial')
    const unmarkedHost = makeHost(unmarkedHome)
    const unmarkedBefore = treeBytes(unmarkedHome)
    assert.throws(() => inspectLifecycleRootReceipt(unmarkedHost), /foreign entry|no strict namespace marker/)
    assert.deepEqual(treeBytes(unmarkedHome), unmarkedBefore)

    const home = path.join(root, 'recent-writer-home')
    const packageRoot = path.join(home, 'package')
    seedPackage(packageRoot, '1.0.0', 'recent-writer')
    markLifecycleReceiptNamespace(home)
    const writer = lifecycleReceiptWriterPath(home, Date.now() + 60_000)
    fs.writeFileSync(writer, '{"schemaVersion":')
    const { host, state } = createStatefulHost(home, {
      dataRoot: path.join(home, 'data'),
      installDir: path.join(home, 'install'),
      taskName: 'SkillGraft-p4-recent-writer'
    })
    const before = treeBytes(home)
    const result = await setupHub(packageRoot, setupFlags, host)
    assert.equal(result.ok, false)
    assert.match(result.issues.map((issue) => issue.message).join('\n'), /recent incomplete lifecycle root receipt writer/)
    assert.deepEqual(treeBytes(home), before)
    assert.deepEqual(state.writes, [])
  })

  await t.test('aged stable partial writer is recovered, but complete foreign target is preserved', async () => {
    const agedHome = path.join(root, 'aged-writer-home')
    const agedPackage = path.join(agedHome, 'package')
    seedPackage(agedPackage, '1.0.0', 'aged-writer')
    markLifecycleReceiptNamespace(agedHome)
    const agedWriter = lifecycleReceiptWriterPath(agedHome, Date.now() - 60_000)
    fs.writeFileSync(agedWriter, '{"schemaVersion":')
    const { host: agedHost } = createStatefulHost(agedHome, {
      dataRoot: path.join(agedHome, 'data'),
      installDir: path.join(agedHome, 'install'),
      taskName: 'SkillGraft-p4-aged-writer'
    })
    const recovered = await setupHub(agedPackage, setupFlags, agedHost)
    assert.equal(recovered.ok, true, JSON.stringify(recovered.issues))
    assert.equal(fs.existsSync(agedWriter), false)
    assert.equal(fs.existsSync(lifecycleRootReceiptPath(agedHost)), true)

    const foreignHome = path.join(root, 'foreign-complete-writer-home')
    const foreignPackage = path.join(foreignHome, 'package')
    seedPackage(foreignPackage, '1.0.0', 'foreign-complete-writer')
    markLifecycleReceiptNamespace(foreignHome)
    const foreignRecord = recordFor(foreignHome, {
      dataRoot: path.join(foreignHome, 'other-data'),
      installDir: path.join(foreignHome, 'other-install'),
      packageRoot: path.join(foreignHome, 'other-package')
    })
    const foreignWriter = lifecycleReceiptWriterPath(foreignHome, Date.now() - 60_000)
    fs.writeFileSync(foreignWriter, `${JSON.stringify(foreignRecord, null, 2)}\n`)
    const { host: foreignHost, state: foreignState } = createStatefulHost(foreignHome, {
      dataRoot: path.join(foreignHome, 'data'),
      installDir: path.join(foreignHome, 'install'),
      taskName: 'SkillGraft-p4-foreign-writer'
    })
    const foreignBefore = treeBytes(foreignHome)
    const refused = await setupHub(foreignPackage, setupFlags, foreignHost)
    assert.equal(refused.ok, false)
    assert.match(refused.issues.map((issue) => issue.message).join('\n'), /complete lifecycle root receipt writer is not the requested package reservation/)
    assert.deepEqual(treeBytes(foreignHome), foreignBefore)
    assert.deepEqual(foreignState.writes, [])

    const mismatchHome = path.join(root, 'same-root-package-mismatch-writer-home')
    const mismatchPackage = path.join(mismatchHome, 'package')
    const mismatchData = path.join(mismatchHome, 'data')
    const mismatchInstall = path.join(mismatchHome, 'install')
    seedPackage(mismatchPackage, '1.0.0', 'same-root-package-mismatch')
    markLifecycleReceiptNamespace(mismatchHome)
    const mismatchRecord = recordFor(mismatchHome, {
      dataRoot: mismatchData,
      installDir: mismatchInstall,
      packageRoot: mismatchPackage,
      packageVersion: '9.9.9',
      packageSha256: `sha256:${'f'.repeat(64)}`
    })
    const mismatchWriter = lifecycleReceiptWriterPath(mismatchHome, Date.now() - 60_000)
    fs.writeFileSync(mismatchWriter, `${JSON.stringify(mismatchRecord, null, 2)}\n`)
    const { host: mismatchHost, state: mismatchState } = createStatefulHost(mismatchHome, {
      dataRoot: mismatchData,
      installDir: mismatchInstall,
      taskName: 'SkillGraft-p4-same-root-mismatch-writer'
    })
    const mismatchBefore = treeBytes(mismatchHome)
    const mismatch = await setupHub(mismatchPackage, setupFlags, mismatchHost)
    assert.equal(mismatch.ok, false)
    assert.match(mismatch.issues.map((issue) => issue.message).join('\n'), /complete lifecycle root receipt writer is not the requested package reservation/)
    assert.deepEqual(treeBytes(mismatchHome), mismatchBefore)
    assert.deepEqual(mismatchState.writes, [])
  })
})

test('fresh setup owns only public runtime, is byte-idempotent, and uninstall preserves inactive data', async (t) => {
  const root = temporaryRoot(t)
  const packageRoot = path.join(root, 'package-a')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  seedPackage(packageRoot, '1.0.0', 'A')
  const { host, state } = createStatefulHost(root, { dataRoot, installDir, taskName: 'SkillGraft-p4-fresh' })
  const packageBefore = treeBytes(packageRoot)
  const first = await setupHub(packageRoot, setupFlags, host)
  assert.equal(first.ok, true, JSON.stringify(first.issues))
  assert.deepEqual(treeBytes(packageRoot), packageBefore)
  assert.equal(fs.existsSync(path.join(dataRoot, 'skills', 'ozdqp-development', 'SKILL.md')), false)
  assert.equal(fs.existsSync(path.join(dataRoot, 'skills', 'README.md')), true)
  for (const relative of ['AGENTS.override.md', ...LOCAL_RUNTIME_ASSET_PATHS.map((name) => `overlay/${name}`)]) {
    assert.equal(fs.existsSync(path.join(dataRoot, ...relative.split('/'))), true, relative)
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(installDir, 'install.json'), 'utf8'))
  const marker = JSON.parse(fs.readFileSync(path.join(dataRoot, '.skill-graft-data-root.json'), 'utf8'))
  assert.equal(marker.activeInstallId, manifest.installId)
  assert.equal(marker.dataRootId, manifest.dataRootId)
  assert.equal(first.doctor.lifecycle.corpusEmpty, true)
  assert.equal(first.doctor.ok, true)

  const installBefore = treeBytes(installDir)
  const dataBefore = treeBytes(dataRoot)
  const stateBefore = {
    path: state.userPath,
    env: [...state.userEnvironment],
    tasks: [...state.tasks]
  }
  state.writes.length = 0
  const second = await setupHub(packageRoot, setupFlags, host)
  assert.equal(second.ok, true, JSON.stringify(second.issues))
  assert.deepEqual(treeBytes(installDir), installBefore)
  assert.deepEqual(treeBytes(dataRoot), dataBefore)
  assert.deepEqual(state.writes, [])
  assert.deepEqual({ path: state.userPath, env: [...state.userEnvironment], tasks: [...state.tasks] }, stateBefore)

  const savedSelection = new Map(state.selection)
  for (const name of ['HUB_ROOT', 'SG_INSTALL_DIR', 'HUB_API_PORT', 'SG_TASK_NAME']) state.selection.delete(name)
  state.writes.length = 0
  const freshEnvironmentRetry = await setupHub(packageRoot, setupFlags, host)
  assert.equal(freshEnvironmentRetry.ok, true, JSON.stringify(freshEnvironmentRetry.issues))
  assert.equal(freshEnvironmentRetry.hubRoot, dataRoot)
  assert.equal(freshEnvironmentRetry.installDir, installDir)
  assert.equal(freshEnvironmentRetry.doctor.ok, true)
  assert.deepEqual(treeBytes(installDir), installBefore)
  assert.deepEqual(treeBytes(dataRoot), dataBefore)
  assert.deepEqual(state.writes, [])
  state.selection.clear()
  for (const [name, value] of savedSelection) state.selection.set(name, value)

  state.selection.set('HUB_ROOT', path.join(root, 'second-data'))
  state.selection.set('SG_INSTALL_DIR', path.join(root, 'second-install'))
  state.writes.length = 0
  const beforeSecondRoot = treeBytes(root)
  const secondRoot = await setupHub(packageRoot, setupFlags, host)
  assert.equal(secondRoot.ok, false)
  assert.match(secondRoot.issues.map((issue) => issue.message).join('\n'), /explicit lifecycle selection differs from the preserved root receipt/)
  assert.deepEqual(treeBytes(root), beforeSecondRoot)
  assert.deepEqual(state.writes, [])
  state.selection.clear()
  for (const [name, value] of savedSelection) state.selection.set(name, value)

  const removed = await uninstallHub(packageRoot, host)
  assert.equal(removed.ok, true, JSON.stringify(removed.issues))
  assert.equal(fs.existsSync(installDir), false)
  assert.equal(fs.existsSync(dataRoot), true)
  const inactive = JSON.parse(fs.readFileSync(path.join(dataRoot, '.skill-graft-data-root.json'), 'utf8'))
  assert.equal(inactive.activeInstallId, null)
  assert.equal(fs.existsSync(path.join(dataRoot, 'AGENTS.override.md')), true)
  assert.equal(state.tasks.size, 0)
  assert.equal(state.userEnvironment.size, 0)

  const inactiveReceipt = inspectLifecycleRootReceipt(host)
  assert.equal(inactiveReceipt.state, 'inactive')
  assert.equal(inactiveReceipt.installId, manifest.installId)
  const inactiveReceiptBytes = fs.readFileSync(lifecycleRootReceiptPath(host))
  fs.rmSync(packageRoot, { recursive: true })
  fs.writeFileSync(installDir, 'foreign install file after terminal uninstall\n')
  const foreignInstallInode = fs.lstatSync(installDir).ino
  const foreignInstallBytes = fs.readFileSync(installDir)
  state.selection.clear()
  const freshEnvironmentUninstall = await uninstallHub(packageRoot, host)
  assert.equal(freshEnvironmentUninstall.ok, true, JSON.stringify(freshEnvironmentUninstall.issues))
  assert.equal(freshEnvironmentUninstall.status, 'already-uninstalled')
  assert.equal(freshEnvironmentUninstall.installDir, installDir)
  assert.deepEqual(fs.readFileSync(lifecycleRootReceiptPath(host)), inactiveReceiptBytes)
  assert.equal(fs.lstatSync(installDir).ino, foreignInstallInode)
  assert.deepEqual(fs.readFileSync(installDir), foreignInstallBytes)

  fs.mkdirSync(packageRoot)
  fs.writeFileSync(path.join(packageRoot, 'foreign.txt'), 'foreign package replacement\n')
  const foreignPackageBefore = treeBytes(packageRoot)
  const foreignPackageRetry = await uninstallHub(packageRoot, host)
  assert.equal(foreignPackageRetry.ok, true, JSON.stringify(foreignPackageRetry.issues))
  assert.equal(foreignPackageRetry.status, 'already-uninstalled')
  assert.deepEqual(treeBytes(packageRoot), foreignPackageBefore)
  assert.equal(fs.lstatSync(installDir).ino, foreignInstallInode)
  assert.deepEqual(fs.readFileSync(installDir), foreignInstallBytes)
  fs.rmSync(installDir)
  fs.rmSync(packageRoot, { recursive: true })
  seedPackage(packageRoot, '1.0.0', 'A')

  for (const [name, value] of savedSelection) state.selection.set(name, value)
  state.writes.length = 0
  const reinstalled = await setupHub(packageRoot, setupFlags, host)
  assert.equal(reinstalled.ok, true, JSON.stringify(reinstalled.issues))
  const reinstalledManifest = JSON.parse(fs.readFileSync(path.join(installDir, 'install.json'), 'utf8'))
  const reactivatedReceipt = inspectLifecycleRootReceipt(host)
  assert.equal(reactivatedReceipt.state, 'active')
  assert.notEqual(reactivatedReceipt.installId, manifest.installId)
  assert.equal(reactivatedReceipt.installId, reinstalledManifest.installId)
  assert.equal(reactivatedReceipt.dataRootId, inactiveReceipt.dataRootId)
})

test('an inactive-root reinstall reuses its exact active reservation after rollback', async (t) => {
  const root = temporaryRoot(t, 'p4-reinstall-reservation')
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  seedPackage(packageRoot, '1.0.0')
  const { host } = createStatefulHost(root, { dataRoot, installDir, taskName: 'SkillGraft-p4-reservation' })
  assert.equal((await setupHub(packageRoot, setupFlags, host)).ok, true)
  assert.equal((await uninstallHub(packageRoot, host)).ok, true)
  const inactiveReceipt = inspectLifecycleRootReceipt(host)
  assert.equal(inactiveReceipt.state, 'inactive')

  const originalPathCas = host.compareExchangeUserPath
  let cut = 0
  host.compareExchangeUserPath = (...args) => {
    cut += 1
    if (cut === 1) throw new Error('reinstall-after-wal-integration-cut')
    return originalPathCas(...args)
  }
  const interrupted = await setupHub(packageRoot, setupFlags, host)
  host.compareExchangeUserPath = originalPathCas
  assert.equal(interrupted.ok, false)
  assert.match(interrupted.issues.map((issue) => issue.message).join('\n'), /reinstall-after-wal-integration-cut/)
  const reservedReceipt = inspectLifecycleRootReceipt(host)
  assert.equal(reservedReceipt.state, 'active')
  assert.notEqual(reservedReceipt.installId, inactiveReceipt.installId)
  assert.equal(reservedReceipt.dataRootId, inactiveReceipt.dataRootId)
  assert.equal(fs.existsSync(`${dataRoot}.lifecycle-wal.json`), false)
  assert.equal(fs.existsSync(installDir), false)
  const rolledBackMarker = JSON.parse(fs.readFileSync(path.join(dataRoot, '.skill-graft-data-root.json'), 'utf8'))
  assert.equal(rolledBackMarker.activeInstallId, null)

  const retried = await setupHub(packageRoot, setupFlags, host)
  assert.equal(retried.ok, true, JSON.stringify(retried.issues))
  const manifest = JSON.parse(fs.readFileSync(path.join(installDir, 'install.json'), 'utf8'))
  assert.equal(manifest.installId, reservedReceipt.installId)
  assert.equal(inspectLifecycleRootReceipt(host).installId, reservedReceipt.installId)
})

test('setup resumes exact durable pending reservations from absent and inactive receipt finals', async (t) => {
  for (const prior of ['absent', 'inactive']) {
    const root = temporaryRoot(t, `p4-receipt-pending-${prior}`)
    const packageRoot = path.join(root, 'package')
    const dataRoot = path.join(root, 'data')
    const installDir = path.join(root, 'install')
    seedPackage(packageRoot, '1.0.0', `pending-${prior}`)
    const { host } = createStatefulHost(root, {
      dataRoot,
      installDir,
      taskName: `SkillGraft-p4-pending-${prior}`,
      skipPath: true,
      skipTask: true
    })
    let priorFinal = null
    if (prior === 'inactive') {
      assert.equal((await setupHub(packageRoot, { ...setupFlags, noPath: true, noTask: true }, host)).ok, true)
      assert.equal((await uninstallHub(packageRoot, host)).ok, true)
      priorFinal = inspectLifecycleRootReceipt(host)
      assert.equal(priorFinal.state, 'inactive')
    }
    const interrupted = await interruptLifecycleReceiptPublication(
      host,
      () => setupHub(packageRoot, { ...setupFlags, noPath: true, noTask: true }, host),
      `setup-${prior}-final-receipt-switch-cut`
    )
    assert.equal(interrupted.hit, true, JSON.stringify(interrupted.result))
    assert.equal(interrupted.result.ok, false)
    const receiptFile = lifecycleRootReceiptPath(host)
    const pendingFile = path.join(path.dirname(receiptFile), 'root-receipt-v1.pending.json')
    assert.equal(fs.existsSync(pendingFile), true)
    assert.equal(fs.existsSync(`${dataRoot}.lifecycle-wal.json`), false)
    assert.equal(fs.existsSync(installDir), false)
    const pendingReceipt = JSON.parse(fs.readFileSync(pendingFile, 'utf8'))
    if (priorFinal) {
      assert.deepEqual(JSON.parse(fs.readFileSync(receiptFile, 'utf8')), priorFinal)
      assert.notEqual(pendingReceipt.installId, priorFinal.installId)
      assert.equal(pendingReceipt.dataRootId, priorFinal.dataRootId)
      const terminalBefore = treeBytes(root)
      const refusedUninstall = await uninstallHub(packageRoot, host)
      assert.equal(refusedUninstall.ok, false)
      assert.match(refusedUninstall.issues.map((issue) => issue.message).join('\n'), /unfinished publication.*requires setup recovery/)
      const refusedPurge = await purgeHub(packageRoot, {
        dryRun: true,
        commit: false,
        dataRoot,
        dataRootId: '',
        planHash: ''
      }, host)
      assert.equal(refusedPurge.ok, false)
      assert.match(refusedPurge.issues.map((issue) => issue.message).join('\n'), /publication recovery/)
      assert.deepEqual(treeBytes(root), terminalBefore)
    } else {
      assert.equal(fs.existsSync(receiptFile), false)
    }

    const retried = await setupHub(packageRoot, { ...setupFlags, noPath: true, noTask: true }, host)
    assert.equal(retried.ok, true, JSON.stringify(retried.issues))
    const manifest = JSON.parse(fs.readFileSync(path.join(installDir, 'install.json'), 'utf8'))
    assert.equal(manifest.installId, pendingReceipt.installId)
    assert.equal(manifest.dataRootId, pendingReceipt.dataRootId)
    assert.equal(inspectLifecycleRootReceipt(host).installId, pendingReceipt.installId)
    assert.equal(fs.existsSync(pendingFile), false)
  }
})

test('inactive setup adopts an exact complete unlinked writer without using it as a locator', async (t) => {
  const root = temporaryRoot(t, 'p4-inactive-complete-writer')
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  seedPackage(packageRoot, '1.0.0', 'inactive-complete-writer')
  const { host } = createStatefulHost(root, {
    dataRoot,
    installDir,
    taskName: 'SkillGraft-p4-inactive-complete-writer',
    skipPath: true,
    skipTask: true
  })
  assert.equal((await setupHub(packageRoot, { ...setupFlags, noPath: true, noTask: true }, host)).ok, true)
  assert.equal((await uninstallHub(packageRoot, host)).ok, true)
  const inactiveReceipt = inspectLifecycleRootReceipt(host)
  const interrupted = await interruptLifecycleReceiptReplacement(
    host,
    () => setupHub(packageRoot, { ...setupFlags, noPath: true, noTask: true }, host),
    'inactive-complete-writer-reservation-cut'
  )
  assert.equal(interrupted.hit, true)
  assert.equal(interrupted.result.ok, false)
  const receiptFile = lifecycleRootReceiptPath(host)
  const receiptDirectory = path.dirname(receiptFile)
  const pendingFile = path.join(receiptDirectory, 'root-receipt-v1.pending.json')
  const reservationBytes = fs.readFileSync(pendingFile)
  const reservation = JSON.parse(reservationBytes)
  const writer = lifecycleReceiptWriterPath(root, Date.now() + 60_000)
  fs.writeFileSync(writer, reservationBytes)
  fs.unlinkSync(pendingFile)
  assert.deepEqual(JSON.parse(fs.readFileSync(receiptFile, 'utf8')), inactiveReceipt)

  const retried = await setupHub(packageRoot, { ...setupFlags, noPath: true, noTask: true }, host)
  assert.equal(retried.ok, true, JSON.stringify(retried.issues))
  const manifest = JSON.parse(fs.readFileSync(path.join(installDir, 'install.json'), 'utf8'))
  assert.equal(manifest.installId, reservation.installId)
  assert.equal(manifest.dataRootId, inactiveReceipt.dataRootId)
  assert.equal(inspectLifecycleRootReceipt(host).installId, reservation.installId)
  assert.equal(fs.existsSync(writer), false)
})

test('an existing installation resumes only its exact receipt publication residue', async (t) => {
  for (const mode of ['writer', 'pending', 'linked']) {
    const root = temporaryRoot(t, `p4-existing-receipt-${mode}`)
    const packageRoot = path.join(root, 'package')
    const dataRoot = path.join(root, 'data')
    const installDir = path.join(root, 'install')
    seedPackage(packageRoot, '1.0.0', `existing-receipt-${mode}`)
    const { host, state } = createStatefulHost(root, {
      dataRoot,
      installDir,
      taskName: `SkillGraft-p4-existing-receipt-${mode}`,
      skipPath: true,
      skipTask: true
    })
    const flags = { ...setupFlags, noPath: true, noTask: true }
    assert.equal((await setupHub(packageRoot, flags, host)).ok, true)
    const receiptFile = lifecycleRootReceiptPath(host)
    const receiptDirectory = path.dirname(receiptFile)
    const pendingFile = path.join(receiptDirectory, 'root-receipt-v1.pending.json')
    const receiptBytes = fs.readFileSync(receiptFile)
    let writer = null
    if (mode === 'writer') {
      fs.unlinkSync(receiptFile)
      writer = lifecycleReceiptWriterPath(root, Date.now() + 60_000)
      fs.writeFileSync(writer, receiptBytes)
    } else if (mode === 'pending') {
      fs.unlinkSync(receiptFile)
      fs.writeFileSync(pendingFile, receiptBytes)
    } else {
      fs.linkSync(receiptFile, pendingFile)
    }
    state.writes.length = 0

    const resumed = await setupHub(packageRoot, flags, host)
    assert.equal(resumed.ok, true, `${mode}: ${JSON.stringify(resumed.issues)}`)
    assert.deepEqual(fs.readFileSync(receiptFile), receiptBytes)
    assert.equal(fs.statSync(receiptFile).nlink, 1)
    assert.equal(fs.existsSync(pendingFile), false)
    if (writer) assert.equal(fs.existsSync(writer), false)
    assert.deepEqual(state.writes, [])
  }

  for (const mode of ['writer', 'pending']) {
    const root = temporaryRoot(t, `p4-existing-receipt-mismatch-${mode}`)
    const packageRoot = path.join(root, 'package')
    const dataRoot = path.join(root, 'data')
    const installDir = path.join(root, 'install')
    seedPackage(packageRoot, '1.0.0', `existing-receipt-mismatch-${mode}`)
    const { host, state } = createStatefulHost(root, {
      dataRoot,
      installDir,
      taskName: `SkillGraft-p4-existing-receipt-mismatch-${mode}`,
      skipPath: true,
      skipTask: true
    })
    const flags = { ...setupFlags, noPath: true, noTask: true }
    assert.equal((await setupHub(packageRoot, flags, host)).ok, true)
    const receiptFile = lifecycleRootReceiptPath(host)
    const pendingFile = path.join(path.dirname(receiptFile), 'root-receipt-v1.pending.json')
    const mismatch = JSON.parse(fs.readFileSync(receiptFile, 'utf8'))
    mismatch.packageSha256 = `sha256:${'f'.repeat(64)}`
    fs.unlinkSync(receiptFile)
    if (mode === 'writer') {
      fs.writeFileSync(
        lifecycleReceiptWriterPath(root, Date.now() + 60_000),
        `${JSON.stringify(mismatch, null, 2)}\n`
      )
    } else {
      fs.writeFileSync(pendingFile, `${JSON.stringify(mismatch, null, 2)}\n`)
    }
    state.writes.length = 0
    const before = treeBytes(root)

    const refused = await setupHub(packageRoot, flags, host)
    assert.equal(refused.ok, false)
    assert.match(
      refused.issues.map((issue) => issue.message).join('\n'),
      mode === 'writer' ? /complete lifecycle root receipt writer is not the authorized target/ : /pending lifecycle root receipt is not the exact setup reservation/
    )
    assert.deepEqual(treeBytes(root), before)
    assert.deepEqual(state.writes, [])
  }
})

test('fresh setup adopts its complete unlinked receipt writer reservation after its crashed Application lease expires', async (t) => {
  const root = temporaryRoot(t, 'p4-receipt-writer-reservation')
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  seedPackage(packageRoot, '1.0.0')
  const { host, state } = createStatefulHost(root, {
    dataRoot,
    installDir,
    taskName: 'SkillGraft-p4-writer-reservation',
    skipPath: true,
    skipTask: true
  })
  const receiptFile = lifecycleRootReceiptPath(host)
  const receiptDirectory = path.dirname(receiptFile)
  const pending = path.join(receiptDirectory, 'root-receipt-v1.pending.json')
  const cutRecord = path.join(root, 'complete-writer-cut.json')
  const child = path.join(root, 'complete-writer-cut-child.mjs')
  const installModule = pathToFileURL(path.resolve('dist/control/install.js')).href
  const hostModule = pathToFileURL(path.resolve('dist/adapters/install-host.js')).href
  fs.writeFileSync(child, `
import fs from 'node:fs'
import path from 'node:path'
import { createInstallHost } from ${JSON.stringify(hostModule)}
import { setupHub } from ${JSON.stringify(installModule)}
const packageRoot = ${JSON.stringify(packageRoot)}
const dataRoot = ${JSON.stringify(dataRoot)}
const installDir = ${JSON.stringify(installDir)}
const home = ${JSON.stringify(root)}
const pending = ${JSON.stringify(pending)}
const cutRecord = ${JSON.stringify(cutRecord)}
const selection = new Map([
  ['SKILL_GRAFT_HOME', dataRoot],
  ['HUB_ROOT', dataRoot],
  ['SG_INSTALL_DIR', installDir],
  ['HUB_API_PORT', '23111'],
  ['SG_TASK_NAME', 'SkillGraft-p4-writer-reservation']
])
const originalLinkSync = fs.linkSync
fs.linkSync = function (source, destination) {
  if (String(source).endsWith('.writing') && path.resolve(String(destination)) === path.resolve(pending)) {
    fs.writeFileSync(cutRecord, fs.readFileSync(source))
    process.kill(process.pid, 'SIGKILL')
    throw new Error('SIGKILL unexpectedly returned')
  }
  return originalLinkSync.call(fs, source, destination)
}
const host = createInstallHost({
  platform: 'win32',
  home,
  localAppData: path.join(home, 'localappdata'),
  pathSep: ';',
  caseInsensitive: true,
  skipPath: true,
  skipTask: true,
  env: (name) => selection.get(name),
  environment: () => Object.fromEntries(selection),
  extraShimDir: () => null,
  localVolumeKind: () => 'local',
  which: (name) => name === 'git' ? 'git.exe' : '',
  commandVersion: () => 'git version fixture',
  pidAlive: () => false,
  processCommandLine: () => '',
  runNpm: () => { throw new Error('prebuilt crash fixture unexpectedly invoked npm') }
})
await setupHub(packageRoot, {
  dryRun: false,
  json: true,
  noDaemon: true,
  noPath: true,
  noTask: true,
  rebuild: false
}, host)
process.exitCode = 97
`)
  const interrupted = spawnSync(process.execPath, [child], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true
  })
  assert.equal(interrupted.error, undefined, String(interrupted.error || ''))
  assert.equal(fs.existsSync(cutRecord), true, `${interrupted.stdout}\n${interrupted.stderr}`)
  assert.notEqual(interrupted.status, 0)
  const reservation = JSON.parse(fs.readFileSync(cutRecord, 'utf8'))
  assert.equal(fs.existsSync(receiptFile), false)
  assert.equal(fs.existsSync(pending), false)
  assert.equal(fs.existsSync(`${dataRoot}.lifecycle-wal.json`), false)
  assert.equal(fs.existsSync(installDir), false)
  assert.equal(fs.readdirSync(receiptDirectory).filter((name) => name.endsWith('.writing')).length, 1)

  const candidateFile = path.join(packageRoot, 'dist', 'application', 'hub-application.js')
  const candidateBytes = fs.readFileSync(candidateFile)
  const receiptBeforeCandidateRace = treeBytes(receiptDirectory)
  const originalListen = Server.prototype.listen
  let adoptionListenCalls = 0
  Server.prototype.listen = function (...args) {
    adoptionListenCalls += 1
    if (adoptionListenCalls === 1) fs.appendFileSync(candidateFile, '// changed while acquiring adoption mutex\n')
    return originalListen.apply(this, args)
  }
  let racedAdoption
  try {
    racedAdoption = await setupHub(packageRoot, { ...setupFlags, noPath: true, noTask: true }, host)
  } finally {
    Server.prototype.listen = originalListen
    fs.writeFileSync(candidateFile, candidateBytes)
  }
  assert.equal(racedAdoption.ok, false)
  assert.match(racedAdoption.issues.map((issue) => issue.message).join('\n'), /receipt reservation package.*identity changed/)
  assert.deepEqual(treeBytes(receiptDirectory), receiptBeforeCandidateRace)
  assert.deepEqual(state.writes, [])

  const receiptBeforeDryRun = treeBytes(receiptDirectory)
  const dryRun = await setupHub(packageRoot, {
    ...setupFlags,
    dryRun: true,
    noPath: true,
    noTask: true
  }, host)
  assert.equal(dryRun.ok, false)
  assert.match(dryRun.issues.map((issue) => issue.message).join('\n'), /receipt (?:writer|publication) requires non-dry-run recovery/)
  assert.deepEqual(treeBytes(receiptDirectory), receiptBeforeDryRun)
  assert.deepEqual(state.writes, [])

  const leaseActive = await setupHub(packageRoot, { ...setupFlags, noPath: true, noTask: true }, host)
  assert.equal(leaseActive.ok, false)
  assert.match(leaseActive.issues.map((issue) => issue.message).join('\n'), /application writer gate is busy \(lease-active\)/)
  const adoptedWhileLeaseActive = inspectLifecycleRootReceipt(host)
  assert.equal(adoptedWhileLeaseActive.installId, reservation.installId)
  assert.equal(adoptedWhileLeaseActive.dataRootId, reservation.dataRootId)
  assert.equal(fs.existsSync(pending), false)
  assert.equal(fs.readdirSync(receiptDirectory).some((name) => name.endsWith('.writing')), false)
  assert.equal(fs.existsSync(`${dataRoot}.lifecycle-wal.json`), false)
  assert.equal(fs.existsSync(installDir), false)
  assert.deepEqual(state.writes, [])

  await new Promise((resolveWait) => setTimeout(resolveWait, 31_000))
  const retried = await setupHub(packageRoot, { ...setupFlags, noPath: true, noTask: true }, host)
  assert.equal(retried.ok, true, JSON.stringify(retried.issues))
  const manifest = JSON.parse(fs.readFileSync(path.join(installDir, 'install.json'), 'utf8'))
  const receipt = inspectLifecycleRootReceipt(host)
  assert.equal(receipt.installId, reservation.installId)
  assert.equal(receipt.dataRootId, reservation.dataRootId)
  assert.equal(manifest.installId, reservation.installId)
  assert.equal(manifest.dataRootId, reservation.dataRootId)
  assert.equal(fs.existsSync(pending), false)
  assert.equal(fs.readdirSync(receiptDirectory).filter((name) => name.endsWith('.writing')).length, 0)
})

test('fresh setup seals candidate authority under the mutex before publishing its receipt', async (t) => {
  const root = temporaryRoot(t, 'p4-receipt-prepublish-authority')
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  const packageFile = path.join(packageRoot, 'dist', 'application', 'hub-application.js')
  seedPackage(packageRoot, '1.0.0', 'receipt-prepublish-A')
  const { host, state } = createStatefulHost(root, {
    dataRoot,
    installDir,
    taskName: 'SkillGraft-p4-receipt-prepublish',
    skipPath: true,
    skipTask: true
  })
  const receiptDirectory = path.dirname(lifecycleRootReceiptPath(host))
  const originalListen = Server.prototype.listen
  let listenCalls = 0
  Server.prototype.listen = function (...args) {
    listenCalls += 1
    // The first mutex is the read-only complete-writer inspection. The second
    // is the mutating lifecycle acquisition whose receipt plan must revalidate
    // its frozen package authority before the first locator write.
    if (listenCalls === 1) fs.appendFileSync(packageFile, '// changed at mutex acquisition\n')
    return originalListen.apply(this, args)
  }
  let result
  try {
    result = await setupHub(packageRoot, { ...setupFlags, noPath: true, noTask: true }, host)
  } finally {
    Server.prototype.listen = originalListen
  }
  assert.equal(listenCalls >= 1, true)
  assert.equal(result.ok, false)
  assert.match(result.issues.map((issue) => issue.message).join('\n'), /setup receipt candidate package identity changed/)
  assert.equal(fs.existsSync(receiptDirectory), false)
  assert.equal(fs.existsSync(`${dataRoot}.lifecycle-wal.json`), false)
  assert.equal(fs.existsSync(dataRoot), false)
  assert.equal(fs.existsSync(installDir), false)
  assert.deepEqual(state.writes, [])
})

test('setup rebinds the strict receipt on the first retry after committed uninstall recovery', async (t) => {
  const root = temporaryRoot(t, 'p4-committed-uninstall-receipt')
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  const portProbe = new Server()
  const port = await new Promise((resolve, reject) => {
    portProbe.once('error', reject)
    portProbe.listen(0, '127.0.0.1', () => resolve(portProbe.address().port))
  })
  await new Promise((resolve, reject) => portProbe.close((error) => error ? reject(error) : resolve()))
  seedPackage(packageRoot, '1.0.0')
  const { host, state } = createStatefulHost(root, {
    dataRoot,
    installDir,
    port,
    taskName: 'SkillGraft-p4-receipt-uninstall'
  })
  const installed = await setupHub(packageRoot, setupFlags, host)
  assert.equal(installed.ok, true, JSON.stringify(installed.issues))
  const firstManifest = JSON.parse(fs.readFileSync(path.join(installDir, 'install.json'), 'utf8'))
  const paths = installPathsFor(packageRoot, host)

  const interrupted = await interruptLifecycleReceiptReplacement(
    host,
    () => uninstallHub(packageRoot, host),
    'committed-uninstall-before-receipt-switch-cut'
  )
  assert.equal(interrupted.hit, true)
  assert.equal(interrupted.result.ok, false)
  assert.equal(fs.existsSync(paths.lifecycleWalPath), true)
  assert.equal(fs.existsSync(path.join(path.dirname(lifecycleRootReceiptPath(host)), 'root-receipt-v1.pending.json')), true)
  assert.equal(inspectLifecycleRootReceipt(host).state, 'active')
  assert.equal(fs.existsSync(installDir), false)

  state.selection.clear()
  state.selection.set('HUB_API_PORT', String(port))
  const retried = await setupHub(packageRoot, setupFlags, host)
  assert.equal(retried.ok, true, JSON.stringify(retried.issues))
  assert.equal(fs.existsSync(paths.lifecycleWalPath), false)
  assert.equal(fs.existsSync(path.join(path.dirname(lifecycleRootReceiptPath(host)), 'root-receipt-v1.pending.json')), false)
  const manifest = JSON.parse(fs.readFileSync(path.join(installDir, 'install.json'), 'utf8'))
  const receipt = inspectLifecycleRootReceipt(host)
  assert.equal(receipt.state, 'active')
  assert.notEqual(receipt.installId, firstManifest.installId)
  assert.equal(receipt.installId, manifest.installId)
  assert.equal(receipt.dataRootId, manifest.dataRootId)
})

test('committed uninstall retires an exact daemon ABSENT scaffold before inactive receipt publication', async (t) => {
  let scaffold
  const fixture = await createCommittedUninstallCut(
    t,
    'p4-committed-daemon-scaffold',
    (prepared) => {
      scaffold = seedCommittedUninstallDaemonScaffold(prepared, 'exact')
      assert.equal(inspectDaemonProtocol({
        home: prepared.host.home,
        dataRoot: prepared.dataRoot,
        platform: prepared.host.platform,
        readReceiptAuthority: () => readDaemonLifecycleReceiptAuthority(prepared.dataRoot, prepared.host)
      }).kind, 'ABSENT')
    }
  )
  assert.equal(fs.existsSync(scaffold.homeMarker), false)
  assert.equal(fs.existsSync(scaffold.stageDirectory), false)
  fixture.state.selection.clear()
  fixture.state.writes.length = 0

  const recovered = await uninstallHub(fixture.packageRoot, fixture.host)
  assert.equal(recovered.ok, true, JSON.stringify(recovered.issues))
  assert.equal(recovered.status, 'already-uninstalled')
  assert.equal(inspectLifecycleRootReceipt(fixture.host).state, 'inactive')
  assertLifecycleRecoveryArtifactsAbsent(fixture.paths, fixture.host, 'daemon scaffold committed recovery')
  assert.deepEqual(fixture.state.writes, [])
})

test('committed uninstall retry converges interrupted daemon scaffold retirement', async (t) => {
  for (const mode of ['empty', 'absent']) {
    await t.test(mode, async (t) => {
      const fixture = await createCommittedUninstallCut(t, `p4-committed-daemon-partial-${mode}`)
      const pendingFile = path.join(path.dirname(lifecycleRootReceiptPath(fixture.host)), 'root-receipt-v1.pending.json')
      fs.unlinkSync(pendingFile)
      const scaffold = seedCommittedUninstallDaemonScaffold(fixture, mode)
      fixture.state.selection.clear()
      fixture.state.writes.length = 0
      const recovered = await uninstallHub(fixture.packageRoot, fixture.host)
      assert.equal(recovered.ok, true, JSON.stringify(recovered.issues))
      assert.equal(recovered.status, 'already-uninstalled')
      assert.equal(inspectLifecycleRootReceipt(fixture.host).state, 'inactive')
      assert.equal(fs.existsSync(scaffold.homeMarker), false)
      assert.equal(fs.existsSync(scaffold.stageDirectory), false)
      assertLifecycleRecoveryArtifactsAbsent(fixture.paths, fixture.host, `${mode} daemon scaffold recovery`)
      assert.deepEqual(fixture.state.writes, [])
    })
  }
})

test('committed uninstall retry rejects foreign daemon-stage residue without mutation', async (t) => {
  const fixture = await createCommittedUninstallCut(t, 'p4-committed-daemon-foreign')
  const pendingFile = path.join(path.dirname(lifecycleRootReceiptPath(fixture.host)), 'root-receipt-v1.pending.json')
  fs.unlinkSync(pendingFile)
  const scaffold = seedCommittedUninstallDaemonScaffold(fixture, 'foreign')
  const receiptFile = lifecycleRootReceiptPath(fixture.host)
  const evidence = {
    receipt: captureFileEvidence(receiptFile),
    owner: captureFileEvidence(fixture.paths.lifecycleLockPath),
    wal: captureFileEvidence(fixture.paths.lifecycleWalPath),
    marker: captureFileEvidence(fixture.paths.dataMarkerPath),
    homeMarker: captureFileEvidence(scaffold.homeMarker),
    innerMarker: captureFileEvidence(scaffold.innerMarker),
    foreign: captureFileEvidence(scaffold.foreign),
    stage: captureDirectoryEvidence(scaffold.stageDirectory)
  }
  fixture.state.selection.clear()
  fixture.state.writes.length = 0

  const refused = await uninstallHub(fixture.packageRoot, fixture.host)
  assert.equal(refused.ok, false)
  assert.match(refused.issues.map((issue) => issue.message).join('\n'), /committed uninstall recovery refuses daemon v1 authority or stage residue/)
  assert.equal(inspectLifecycleRootReceipt(fixture.host).state, 'active')
  assertFileEvidence(receiptFile, evidence.receipt)
  assert.equal(fs.existsSync(pendingFile), false)
  assertFileEvidence(fixture.paths.lifecycleLockPath, evidence.owner)
  assertFileEvidence(fixture.paths.lifecycleWalPath, evidence.wal)
  assertFileEvidence(fixture.paths.dataMarkerPath, evidence.marker)
  assertFileEvidence(scaffold.homeMarker, evidence.homeMarker)
  assertFileEvidence(scaffold.innerMarker, evidence.innerMarker)
  assertFileEvidence(scaffold.foreign, evidence.foreign)
  assertDirectoryEvidence(scaffold.stageDirectory, evidence.stage)
  assert.deepEqual(fixture.state.writes, [])
})

test('committed uninstall recovery is package-independent while the receipt is still active', async (t) => {
  const root = temporaryRoot(t, 'p4-committed-uninstall-missing-package')
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  seedPackage(packageRoot, '1.0.0', 'committed-uninstall-missing-package')
  const { host, state } = createStatefulHost(root, {
    dataRoot,
    installDir,
    taskName: 'SkillGraft-p4-committed-uninstall-missing-package',
    skipPath: true,
    skipTask: true
  })
  assert.equal((await setupHub(packageRoot, { ...setupFlags, noPath: true, noTask: true }, host)).ok, true)
  const paths = installPathsFor(packageRoot, host)
  const interrupted = await interruptLifecycleReceiptReplacement(
    host,
    () => uninstallHub(packageRoot, host),
    'committed-uninstall-active-receipt-package-independent-cut'
  )
  assert.equal(interrupted.hit, true)
  assert.equal(interrupted.result.ok, false)
  assert.equal(inspectLifecycleRootReceipt(host).state, 'active')
  assert.equal(fs.existsSync(paths.lifecycleWalPath), true)
  assert.equal(fs.existsSync(installDir), false)
  fs.rmSync(packageRoot, { recursive: true, force: true })
  fs.writeFileSync(installDir, 'foreign install replacement after committed uninstall\n')
  const foreignInstallStat = fs.lstatSync(installDir)
  const foreignInstallBytes = fs.readFileSync(installDir)
  state.selection.clear()

  const recovered = await uninstallHub(packageRoot, host)
  assert.equal(recovered.ok, true, JSON.stringify(recovered.issues))
  assert.equal(recovered.status, 'already-uninstalled')
  assert.equal(inspectLifecycleRootReceipt(host).state, 'inactive')
  assert.equal(fs.existsSync(paths.lifecycleWalPath), false)
  assert.equal(fs.existsSync(paths.lifecycleLockPath), false)
  assert.equal(fs.existsSync(packageRoot), false)
  assert.equal(fs.lstatSync(installDir).ino, foreignInstallStat.ino)
  assert.deepEqual(fs.readFileSync(installDir), foreignInstallBytes)
})

test('committed uninstall terminal recovery preserves foreign historical install shapes', async (t) => {
  for (const shape of ['regular', 'directory', 'junction']) {
    await t.test(shape, async (t) => {
      const fixture = await createCommittedUninstallCut(t, `p4-committed-foreign-${shape}`)
      fs.rmSync(fixture.packageRoot, { recursive: true, force: true })
      const assertPreserved = createForeignInstallShape(t, fixture.root, fixture.installDir, shape)
      if (typeof assertPreserved !== 'function') {
        t.skip(`junction creation is unavailable: ${assertPreserved.unsupported.code || assertPreserved.unsupported.message}`)
        return
      }
      fixture.state.selection.clear()
      fixture.state.writes.length = 0
      const recovered = await uninstallHub(fixture.packageRoot, fixture.host)
      assert.equal(recovered.ok, true, JSON.stringify(recovered.issues))
      assert.equal(recovered.status, 'already-uninstalled')
      assert.equal(inspectLifecycleRootReceipt(fixture.host).state, 'inactive')
      assertLifecycleRecoveryArtifactsAbsent(fixture.paths, fixture.host, `${shape} committed recovery`)
      assert.deepEqual(fixture.state.writes, [])
      assertPreserved()
    })
  }
})

test('committed uninstall acquire-return authority rejects exact inode replacement before receipt or WAL mutation', async (t) => {
  for (const mode of ['receipt', 'pending', 'owner', 'wal', 'marker', 'data-root', 'control']) {
    await t.test(mode, async (t) => {
      const fixture = await createCommittedUninstallCut(t, `p4-committed-acquire-${mode}`)
      const receiptFile = lifecycleRootReceiptPath(fixture.host)
      const pendingFile = path.join(path.dirname(receiptFile), 'root-receipt-v1.pending.json')
      const markerFile = fixture.paths.dataMarkerPath
      const evidence = {
        receipt: captureFileEvidence(receiptFile),
        pending: captureFileEvidence(pendingFile),
        owner: captureFileEvidence(fixture.paths.lifecycleLockPath),
        wal: captureFileEvidence(fixture.paths.lifecycleWalPath),
        marker: captureFileEvidence(markerFile)
      }
      const dataRootInode = fs.lstatSync(fixture.dataRoot).ino
      let checkpointHit = false
      let replacementEvidence = null
      let parkedPath = null
      let replacementRootInode = null
      fixture.state.writes.length = 0
      const result = await uninstallHub(fixture.packageRoot, fixture.host, {
        checkpoint(name) {
          assert.equal(name, 'after-committed-uninstall-acquire-authority')
          assert.equal(checkpointHit, false)
          checkpointHit = true
          assertFileEvidence(receiptFile, evidence.receipt, 'committed entry receipt')
          assertFileEvidence(pendingFile, evidence.pending, 'committed entry pending receipt')
          assertFileEvidence(fixture.paths.lifecycleLockPath, evidence.owner, 'committed entry owner')
          assertFileEvidence(fixture.paths.lifecycleWalPath, evidence.wal, 'committed entry WAL')
          assertFileEvidence(markerFile, evidence.marker, 'committed entry marker')
          assert.equal(fs.lstatSync(fixture.dataRoot).ino, dataRootInode)

          if (mode === 'control') return
          parkedPath = path.join(fixture.root, `committed-acquire-original-${mode}`)
          if (mode === 'data-root') {
            fs.renameSync(fixture.dataRoot, parkedPath)
            fs.mkdirSync(fixture.dataRoot)
            fs.renameSync(path.join(parkedPath, path.basename(markerFile)), markerFile)
            replacementRootInode = fs.lstatSync(fixture.dataRoot).ino
            assert.notEqual(replacementRootInode, dataRootInode)
            assert.equal(fs.lstatSync(markerFile).ino, evidence.marker.stat.ino)
            return
          }
          const target = mode === 'receipt'
            ? receiptFile
            : mode === 'pending'
              ? pendingFile
              : mode === 'owner'
                ? fixture.paths.lifecycleLockPath
                : mode === 'wal'
                  ? fixture.paths.lifecycleWalPath
                  : markerFile
          const original = evidence[mode]
          fs.renameSync(target, parkedPath)
          fs.writeFileSync(target, original.bytes)
          replacementEvidence = captureFileEvidence(target)
          assert.notEqual(replacementEvidence.stat.ino, original.stat.ino)
        }
      })
      assert.equal(checkpointHit, true, `${mode} did not reach committed acquire-return authority`)
      assert.deepEqual(fixture.state.writes, [])
      if (mode === 'control') {
        assert.equal(result.ok, true, JSON.stringify(result.issues))
        assert.equal(result.status, 'already-uninstalled')
        assert.equal(inspectLifecycleRootReceipt(fixture.host).state, 'inactive')
        assert.equal(fs.existsSync(fixture.paths.lifecycleWalPath), false)
        assert.equal(fs.existsSync(fixture.paths.lifecycleLockPath), false)
        return
      }

      assert.equal(result.ok, false)
      assert.match(
        result.issues.map((issue) => issue.message).join('\n'),
        /post-publication|authority|directory identity changed|ancestor changed after an asynchronous checkpoint/
      )
      assert.equal(JSON.parse(fs.readFileSync(receiptFile, 'utf8')).state, 'active')
      assert.equal(JSON.parse(fs.readFileSync(pendingFile, 'utf8')).state, 'inactive')
      assert.equal(JSON.parse(fs.readFileSync(fixture.paths.lifecycleWalPath, 'utf8')).phase, 'committed')
      for (const key of ['receipt', 'pending', 'owner', 'wal', 'marker']) {
        const target = key === 'receipt'
          ? receiptFile
          : key === 'pending'
            ? pendingFile
            : key === 'owner'
              ? fixture.paths.lifecycleLockPath
              : key === 'wal'
                ? fixture.paths.lifecycleWalPath
                : markerFile
        if (key === mode) {
          assert.deepEqual(fs.readFileSync(target), evidence[key].bytes)
          assert.deepEqual(captureFileEvidence(target), replacementEvidence)
          assertFileEvidence(parkedPath, evidence[key], `parked original ${key}`)
        } else {
          assertFileEvidence(target, evidence[key], `unchanged ${key}`)
        }
      }
      if (mode === 'data-root') {
        assert.equal(fs.lstatSync(fixture.dataRoot).ino, replacementRootInode)
        assert.equal(fs.lstatSync(markerFile).ino, evidence.marker.stat.ino)
        assert.equal(fs.lstatSync(parkedPath).ino, dataRootInode)
        assert.equal(fs.existsSync(path.join(parkedPath, 'AGENTS.override.md')), true)
      } else {
        assert.equal(fs.lstatSync(fixture.dataRoot).ino, dataRootInode)
      }
    })
  }
})

test('inactive second uninstall preserves foreign install shapes while active no-W authority remains strict', async (t) => {
  for (const shape of ['regular', 'directory', 'junction']) {
    await t.test(`${shape} inactive`, async (t) => {
      const root = temporaryRoot(t, `p4-inactive-uninstall-${shape}`)
      const packageRoot = path.join(root, 'package')
      const dataRoot = path.join(root, 'data')
      const installDir = path.join(root, 'install')
      seedPackage(packageRoot, '1.0.0', `inactive-uninstall-${shape}`)
      const { host, state } = createStatefulHost(root, { dataRoot, installDir, skipPath: true, skipTask: true })
      assert.equal((await setupHub(packageRoot, { ...setupFlags, noPath: true, noTask: true }, host)).ok, true)
      assert.equal((await uninstallHub(packageRoot, host)).ok, true)
      const receiptBefore = captureFileEvidence(lifecycleRootReceiptPath(host))
      const assertPreserved = createForeignInstallShape(t, root, installDir, shape)
      if (typeof assertPreserved !== 'function') {
        t.skip(`junction creation is unavailable: ${assertPreserved.unsupported.code || assertPreserved.unsupported.message}`)
        return
      }
      const paths = installPathsFor(packageRoot, host)
      state.selection.clear()
      state.writes.length = 0
      const result = await uninstallHub(packageRoot, host)
      assert.equal(result.ok, true, JSON.stringify(result.issues))
      assert.equal(result.status, 'already-uninstalled')
      assert.equal(result.filesRemoved, false)
      assert.equal(result.pathRemoved, false)
      assert.equal(result.taskRemoved, false)
      assert.deepEqual(state.writes, [])
      assertFileEvidence(lifecycleRootReceiptPath(host), receiptBefore, 'inactive second-uninstall receipt')
      assertLifecycleRecoveryArtifactsAbsent(paths, host, `${shape} inactive second uninstall`)
      assertPreserved()
    })

    await t.test(`${shape} active`, async (t) => {
      const root = temporaryRoot(t, `p4-active-uninstall-${shape}`)
      const packageRoot = path.join(root, 'package')
      const dataRoot = path.join(root, 'data')
      const installDir = path.join(root, 'install')
      seedPackage(packageRoot, '1.0.0', `active-uninstall-${shape}`)
      const { host, state } = createStatefulHost(root, { dataRoot, installDir, skipPath: true, skipTask: true })
      assert.equal((await setupHub(packageRoot, { ...setupFlags, noPath: true, noTask: true }, host)).ok, true)
      const receiptBefore = captureFileEvidence(lifecycleRootReceiptPath(host))
      fs.rmSync(installDir, { recursive: true, force: true })
      const assertPreserved = createForeignInstallShape(t, root, installDir, shape)
      if (typeof assertPreserved !== 'function') {
        t.skip(`junction creation is unavailable: ${assertPreserved.unsupported.code || assertPreserved.unsupported.message}`)
        return
      }
      state.writes.length = 0
      const result = await uninstallHub(packageRoot, host)
      assert.equal(result.ok, false)
      assert.match(
        result.issues.map((issue) => issue.message).join('\n'),
        /active lifecycle root receipt|installation|install ownership manifest|install directory|manifest|lifecycle API port/
      )
      assert.equal(fs.existsSync(`${dataRoot}.lifecycle-wal.json`), false)
      assert.deepEqual(state.writes, [])
      assertFileEvidence(lifecycleRootReceiptPath(host), receiptBefore, 'active failed-uninstall receipt')
      assertLifecycleRecoveryArtifactsAbsent(installPathsFor(packageRoot, host), host, `${shape} active failed uninstall`)
      assertPreserved()
    })
  }
})

test('daemon run validates the exact active receipt and installed authority before retiring a stale owner', async (t) => {
  for (const receiptState of ['missing', 'inactive', 'mismatch', 'malformed']) {
    const root = temporaryRoot(t, `p4-daemon-guard-${receiptState}`)
    const packageRoot = path.join(root, 'package')
    const dataRoot = path.join(root, 'data')
    const installDir = path.join(root, 'install')
    seedPackage(packageRoot, '1.0.0', `daemon-guard-${receiptState}`)
    const { host, state } = createStatefulHost(root, {
      dataRoot,
      installDir,
      taskName: `SkillGraft-p4-daemon-guard-${receiptState}`,
      skipPath: true,
      skipTask: true
    })
    const flags = { ...setupFlags, noPath: true, noTask: true }
    assert.equal((await setupHub(packageRoot, flags, host)).ok, true)
    const manifestFile = path.join(installDir, 'install.json')
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
    manifest.features.daemon = true
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
    const paths = installPathsFor(packageRoot, host)
    const staleOwner = {
      schemaVersion: 1,
      token: '11111111-1111-4111-8111-111111111111',
      pid: 4242,
      operation: 'setup',
      installDir,
      createdAt: '2026-08-23T00:00:00.000Z'
    }
    fs.writeFileSync(paths.lifecycleLockPath, `${JSON.stringify(staleOwner, null, 2)}\n`)
    const receiptFile = lifecycleRootReceiptPath(host)
    if (receiptState === 'missing') fs.unlinkSync(receiptFile)
    else if (receiptState === 'malformed') fs.writeFileSync(receiptFile, '{')
    else {
      const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'))
      if (receiptState === 'inactive') receipt.state = 'inactive'
      else receipt.packageSha256 = `sha256:${'f'.repeat(64)}`
      fs.writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`)
    }
    state.writes.length = 0
    const before = treeBytes(root)

    await assert.rejects(
      acquireDaemonRunLifecycleGuard(packageRoot, dataRoot, host),
      /active lifecycle root receipt|invalid lifecycle root receipt JSON|does not bind the active installation manifest/
    )
    assert.deepEqual(treeBytes(root), before)
    assert.deepEqual(state.writes, [])
    assert.deepEqual(JSON.parse(fs.readFileSync(paths.lifecycleLockPath, 'utf8')), staleOwner)
    for (const name of ['daemon.pid', 'api.pid', 'daemon-heartbeat.json', 'daemon.log']) {
      assert.equal(fs.existsSync(path.join(dataRoot, 'skill-review', name)), false, `${receiptState}: ${name}`)
    }
  }

  const root = temporaryRoot(t, 'p4-daemon-guard-exact-receipt')
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  seedPackage(packageRoot, '1.0.0', 'daemon-guard-exact-receipt')
  const { host } = createStatefulHost(root, {
    dataRoot,
    installDir,
    taskName: 'SkillGraft-p4-daemon-guard-exact-receipt',
    skipPath: true,
    skipTask: true
  })
  const flags = { ...setupFlags, noPath: true, noTask: true }
  assert.equal((await setupHub(packageRoot, flags, host)).ok, true)
  const manifestFile = path.join(installDir, 'install.json')
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  manifest.features.daemon = true
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
  const paths = installPathsFor(packageRoot, host)
  fs.writeFileSync(paths.lifecycleLockPath, `${JSON.stringify({
    schemaVersion: 1,
    token: '22222222-2222-4222-8222-222222222222',
    pid: 5252,
    operation: 'upgrade',
    installDir,
    createdAt: '2026-08-23T00:00:00.000Z'
  }, null, 2)}\n`)
  const guard = await acquireDaemonRunLifecycleGuard(packageRoot, dataRoot, host)
  assert.equal(fs.existsSync(paths.lifecycleLockPath), false)
  const receiptFile = lifecycleRootReceiptPath(host)
  const replacementBytes = fs.readFileSync(receiptFile)
  fs.unlinkSync(receiptFile)
  fs.writeFileSync(receiptFile, replacementBytes)
  assert.throws(() => guard.revalidate(), /receipt.*changed|terminal seal/)
  await assert.rejects(guard.release(), /receipt.*changed|terminal seal/)
  assert.deepEqual(fs.readFileSync(receiptFile), replacementBytes)
  for (const name of ['daemon.pid', 'api.pid', 'daemon-heartbeat.json', 'daemon.log']) {
    assert.equal(fs.existsSync(path.join(dataRoot, 'skill-review', name)), false, name)
  }
})

test('a live LocalHost writer blocks setup before any lifecycle receipt owner WAL or business write', async (t) => {
  const root = temporaryRoot(t, 'p4-localhost-blocks-lifecycle')
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  seedPackage(packageRoot, '1.0.0', 'localhost-blocks-lifecycle')
  const { host, state } = createStatefulHost(root, {
    dataRoot,
    installDir,
    skipPath: true,
    skipTask: true
  })
  const manager = createLeaseLockManager({ root: applicationLeaseRoot(dataRoot), leaseMs: 30_000 })
  const held = await manager.acquire({
    scope: 'hub-global',
    key: 'hub-global',
    hostId: 'live-localhost-writer',
    commandKind: 'migrateState',
    requestId: 'p4-localhost-blocks-lifecycle'
  })
  assert.equal(held.status, 'acquired')
  const paths = installPathsFor(packageRoot, host)
  const before = treeBytes(root)

  const result = await setupHub(packageRoot, { ...setupFlags, noPath: true, noTask: true }, host)
  assert.equal(result.ok, false)
  assert.match(result.issues.map((issue) => issue.message).join('\n'), /application writer gate is busy/)
  assert.deepEqual(treeBytes(root), before)
  assert.equal(fs.existsSync(lifecycleRootReceiptPath(host)), false)
  assert.equal(fs.existsSync(paths.lifecycleLockPath), false)
  assert.equal(fs.existsSync(paths.lifecycleWalPath), false)
  assert.equal(fs.existsSync(dataRoot), false)
  assert.equal(fs.existsSync(installDir), false)
  assert.deepEqual(state.writes, [])

  await held.lease.release()
  assert.deepEqual(fs.readdirSync(path.join(applicationLeaseRoot(dataRoot), 'leases')), [])
})

test('a live LocalHost writer preserves an exact lifecycle owner link-pair and the first retry collapses it', async (t) => {
  const root = temporaryRoot(t, 'p4-localhost-owner-pair')
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  seedPackage(packageRoot, '1.0.0', 'localhost-owner-pair')
  const { host, state } = createStatefulHost(root, {
    dataRoot,
    installDir,
    skipPath: true,
    skipTask: true
  })
  const paths = installPathsFor(packageRoot, host)
  const token = '33333333-3333-4333-8333-333333333333'
  const pending = path.join(
    path.dirname(paths.lifecycleLockPath),
    `${path.basename(paths.lifecycleLockPath)}.${token}.owner-pending`
  )
  const owner = {
    schemaVersion: 1,
    token,
    pid: 9191,
    operation: 'setup',
    installDir,
    createdAt: '2026-08-23T00:00:00.000Z'
  }
  fs.mkdirSync(path.dirname(paths.lifecycleLockPath), { recursive: true })
  fs.writeFileSync(pending, `${JSON.stringify(owner, null, 2)}\n`, { flag: 'wx' })
  fs.linkSync(pending, paths.lifecycleLockPath)
  assert.equal(fs.statSync(pending).nlink, 2)
  const manager = createLeaseLockManager({ root: applicationLeaseRoot(dataRoot), leaseMs: 30_000 })
  const held = await manager.acquire({
    scope: 'hub-global',
    key: 'hub-global',
    hostId: 'live-localhost-owner-pair',
    commandKind: 'migrateState',
    requestId: 'p4-localhost-owner-pair'
  })
  assert.equal(held.status, 'acquired')
  const before = treeBytes(root)

  const blocked = await setupHub(packageRoot, { ...setupFlags, noPath: true, noTask: true }, host)
  assert.equal(blocked.ok, false)
  assert.match(blocked.issues.map((issue) => issue.message).join('\n'), /application writer gate is busy/)
  assert.deepEqual(treeBytes(root), before)
  assert.equal(fs.statSync(pending).nlink, 2)
  assert.equal(fs.statSync(paths.lifecycleLockPath).nlink, 2)
  assert.deepEqual(state.writes, [])

  await held.lease.release()
  const retried = await setupHub(packageRoot, { ...setupFlags, noPath: true, noTask: true }, host)
  assert.equal(retried.ok, true, JSON.stringify(retried.issues))
  assert.equal(fs.existsSync(pending), false)
  assert.equal(fs.existsSync(paths.lifecycleLockPath), false)
  assert.equal(fs.existsSync(paths.lifecycleWalPath), false)
  assert.equal(fs.existsSync(paths.manifestPath), true)
  assert.deepEqual(fs.readdirSync(path.join(applicationLeaseRoot(dataRoot), 'leases')), [])
})

test('lifecycle owner publication recovers only reservations inside its independently marked namespace', async (t) => {
  const makeFixture = (label) => {
    const root = temporaryRoot(t, label)
    const packageRoot = path.join(root, 'package')
    const dataRoot = path.join(root, 'data')
    const installDir = path.join(root, 'install')
    seedPackage(packageRoot, '1.0.0', label)
    const { host, state } = createStatefulHost(root, {
      dataRoot,
      installDir,
      skipPath: true,
      skipTask: true
    })
    return {
      root,
      packageRoot,
      dataRoot,
      installDir,
      host,
      state,
      paths: installPathsFor(packageRoot, host),
      stageNamespace: `${path.resolve(dataRoot)}.lifecycle-owner-stages`
    }
  }
  const flags = { ...setupFlags, noPath: true, noTask: true }
  const leaveReservation = async (fixture, kind) => {
    const originalOpenSync = fs.openSync
    const originalRmdirSync = fs.rmdirSync
    let cut = false
    fs.openSync = function (target, openFlags, ...rest) {
      const absolute = typeof target === 'string' ? path.resolve(target) : ''
      if (!cut && path.basename(absolute) === 'owner.json'
        && path.dirname(path.dirname(absolute)) === path.resolve(fixture.stageNamespace)) {
        cut = true
        if (kind === 'partial') {
          const descriptor = originalOpenSync.call(fs, target, openFlags, ...rest)
          fs.writeSync(descriptor, Buffer.from('{"schemaVersion":1,"token":'))
          fs.closeSync(descriptor)
        }
        throw new Error(`abrupt owner ${kind} publication cut`)
      }
      return originalOpenSync.call(fs, target, openFlags, ...rest)
    }
    fs.rmdirSync = function (target, ...rest) {
      if (kind === 'empty' && cut && path.dirname(path.resolve(String(target))) === path.resolve(fixture.stageNamespace)) {
        throw new Error('simulated process-tree death before reservation cleanup')
      }
      return originalRmdirSync.call(fs, target, ...rest)
    }
    try {
      const interrupted = await setupHub(fixture.packageRoot, flags, fixture.host)
      assert.equal(interrupted.ok, false)
      assert.match(interrupted.issues.map((issue) => issue.message).join('\n'), /abrupt owner/)
      assert.equal(cut, true)
    } finally {
      fs.openSync = originalOpenSync
      fs.rmdirSync = originalRmdirSync
    }
    const stages = fs.readdirSync(fixture.stageNamespace)
      .filter((name) => name.endsWith('.owner-stage'))
    assert.equal(stages.length, 1)
    return path.join(fixture.stageNamespace, stages[0])
  }
  const stagedRecord = (stage, installDir) => {
    const fields = path.basename(stage).split('.')
    const operations = { s: 'setup', g: 'upgrade', u: 'uninstall', r: 'recover', p: 'purge' }
    return {
      schemaVersion: 1,
      token: fields[6],
      pid: Number(fields[7]),
      operation: operations[fields[10]],
      installDir,
      createdAt: new Date(Number(fields[9])).toISOString()
    }
  }

  await t.test('a pre-existing unowned empty sibling is refused before receipt or business writes', async () => {
    const fixture = makeFixture('p4-owner-stage-foreign-empty')
    fs.mkdirSync(fixture.stageNamespace)
    const before = treeBytes(fixture.root)
    const result = await setupHub(fixture.packageRoot, flags, fixture.host)
    assert.equal(result.ok, false)
    assert.match(result.issues.map((issue) => issue.message).join('\n'), /without durable preserved-root namespace authority/)
    assert.deepEqual(treeBytes(fixture.root), before)
    assert.equal(fs.existsSync(lifecycleRootReceiptPath(fixture.host)), false)
    assert.equal(fs.existsSync(fixture.paths.lifecycleLockPath), false)
    assert.equal(fs.existsSync(fixture.paths.lifecycleWalPath), false)
    assert.deepEqual(fixture.state.writes, [])
  })

  await t.test('HOME authority makes the mkdir-to-internal-marker cut recoverable', async () => {
    const fixture = makeFixture('p4-owner-stage-marker-cut')
    const originalOpenSync = fs.openSync
    let cut = false
    fs.openSync = function (target, openFlags, ...rest) {
      const absolute = typeof target === 'string' ? path.resolve(target) : ''
      if (!cut && path.dirname(absolute) === path.resolve(fixture.stageNamespace)
        && path.basename(absolute).startsWith('.namespace-v1.')) {
        cut = true
        throw new Error('abrupt internal namespace marker cut')
      }
      return originalOpenSync.call(fs, target, openFlags, ...rest)
    }
    try {
      const interrupted = await setupHub(fixture.packageRoot, flags, fixture.host)
      assert.equal(interrupted.ok, false)
      assert.match(interrupted.issues.map((issue) => issue.message).join('\n'), /abrupt internal namespace marker cut/)
    } finally {
      fs.openSync = originalOpenSync
    }
    assert.equal(cut, true)
    assert.deepEqual(fs.readdirSync(fixture.stageNamespace), [])
    assert.equal(fs.readdirSync(path.dirname(lifecycleRootReceiptPath(fixture.host)))
      .some((name) => name.startsWith('.owner-stage-namespace-v1.')), true)
    const retried = await setupHub(fixture.packageRoot, flags, fixture.host)
    assert.equal(retried.ok, true, JSON.stringify(retried.issues))
    assert.equal(fs.readdirSync(fixture.stageNamespace).some((name) => name.endsWith('.owner-stage')), false)
  })

  for (const kind of ['empty', 'partial']) {
    await t.test(`${kind} reserved owner stage converges on the first retry`, async () => {
      const fixture = makeFixture(`p4-owner-stage-${kind}`)
      await leaveReservation(fixture, kind)
      const retried = await setupHub(fixture.packageRoot, flags, fixture.host)
      assert.equal(retried.ok, true, JSON.stringify(retried.issues))
      assert.equal(fs.readdirSync(fixture.stageNamespace).some((name) => name.endsWith('.owner-stage')), false)
      assert.equal(fs.existsSync(fixture.paths.lifecycleLockPath), false)
      assert.equal(fs.existsSync(fixture.paths.lifecycleWalPath), false)
    })
  }

  await t.test('full and linked reserved stages converge while a live LocalHost preserves them byte-exact', async () => {
    for (const linked of [false, true]) {
      const fixture = makeFixture(`p4-owner-stage-${linked ? 'linked' : 'full'}`)
      const stage = await leaveReservation(fixture, 'partial')
      const record = stagedRecord(stage, fixture.installDir)
      const recordFile = path.join(stage, 'owner.json')
      fs.unlinkSync(recordFile)
      fs.writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`)
      const pending = `${fixture.paths.lifecycleLockPath}.${record.token}.owner-pending`
      if (linked) fs.linkSync(recordFile, pending)
      const manager = createLeaseLockManager({ root: applicationLeaseRoot(fixture.dataRoot), leaseMs: 30_000 })
      const held = await manager.acquire({
        scope: 'hub-global',
        key: 'hub-global',
        hostId: `owner-stage-${linked ? 'linked' : 'full'}`,
        commandKind: 'migrateState',
        requestId: `owner-stage-${linked ? 'linked' : 'full'}`
      })
      assert.equal(held.status, 'acquired')
      const before = treeBytes(fixture.root)
      const blocked = await setupHub(fixture.packageRoot, flags, fixture.host)
      assert.equal(blocked.ok, false)
      assert.match(blocked.issues.map((issue) => issue.message).join('\n'), /application writer gate is busy/)
      assert.deepEqual(treeBytes(fixture.root), before)
      await held.lease.release()
      const retried = await setupHub(fixture.packageRoot, flags, fixture.host)
      assert.equal(retried.ok, true, JSON.stringify(retried.issues))
      assert.equal(fs.existsSync(stage), false)
      assert.equal(fs.existsSync(pending), false)
      assert.equal(fs.existsSync(fixture.paths.lifecycleLockPath), false)
      assert.equal(fs.existsSync(fixture.paths.lifecycleWalPath), false)
    }
  })

  await t.test('a real child kill preserves the partial reservation until lease expiry, then the first eligible retry converges', async () => {
    const fixture = makeFixture('p4-owner-stage-real-kill')
    const state = {
      HUB_ROOT: fixture.dataRoot,
      SG_INSTALL_DIR: fixture.installDir,
      HUB_API_PORT: '23111'
    }
    const script = `
      import fs from 'node:fs';
      import path from 'node:path';
      import { createInstallHost } from ${JSON.stringify(pathToFileURL(path.resolve('dist/adapters/install-host.js')).href)};
      import { setupHub } from ${JSON.stringify(pathToFileURL(path.resolve('dist/control/install.js')).href)};
      const selection = new Map(Object.entries(${JSON.stringify(state)}));
      const stageNamespace = ${JSON.stringify(fixture.stageNamespace)};
      const originalOpenSync = fs.openSync;
      fs.openSync = function(target, flags, ...rest) {
        const absolute = typeof target === 'string' ? path.resolve(target) : '';
        if (path.basename(absolute) === 'owner.json' && path.dirname(path.dirname(absolute)) === path.resolve(stageNamespace)) {
          const descriptor = originalOpenSync.call(fs, target, flags, ...rest);
          fs.writeSync(descriptor, Buffer.from('{"schemaVersion":1,"token":'));
          fs.fsyncSync(descriptor);
          fs.writeSync(1, 'OWNER_STAGE_CUT_READY\\n');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        }
        return originalOpenSync.call(fs, target, flags, ...rest);
      };
      const host = createInstallHost({
        platform: 'win32', home: ${JSON.stringify(fixture.root)},
        localAppData: ${JSON.stringify(path.join(fixture.root, 'localappdata'))},
        pathSep: ';', caseInsensitive: true, skipPath: true, skipTask: true,
        env: (name) => selection.get(name), environment: () => Object.fromEntries(selection),
        userPathState: () => ({ exists: false, value: '', kind: null }), userPath: () => '',
        userEnv: () => undefined, userEnvState: () => ({ exists: false, value: '', kind: null }),
        setUserPath: () => {}, setUserEnv: () => {}, compareExchangeUserPath: () => false,
        compareExchangeUserEnv: () => false, broadcastEnv: () => {}, taskExists: () => false,
        taskAction: () => '', registerLogonTask: () => {}, stopScheduledTaskInstance: () => {},
        unregisterTask: () => {}, which: (name) => name === 'git' ? 'git.exe' : '',
        commandVersion: () => 'git version fixture', pidAlive: () => false,
        processCommandLine: () => '', killPid: () => false, waitForPidsExit: () => false,
        runNpm: () => { throw new Error('unexpected npm'); }
      });
      await setupHub(${JSON.stringify(fixture.packageRoot)}, ${JSON.stringify(flags)}, host);
    `
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const deadline = Date.now() + 20_000
    while (!stdout.includes('OWNER_STAGE_CUT_READY') && child.exitCode === null && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20))
    }
    assert.match(stdout, /OWNER_STAGE_CUT_READY/, stderr)
    child.kill('SIGKILL')
    await new Promise((resolveExit) => child.once('exit', resolveExit))
    const stages = fs.readdirSync(fixture.stageNamespace).filter((name) => name.endsWith('.owner-stage'))
    assert.equal(stages.length, 1)
    const stagedFile = path.join(fixture.stageNamespace, stages[0], 'owner.json')
    assert.match(fs.readFileSync(stagedFile, 'utf8'), /^\{"schemaVersion"/)
    const beforeEligible = treeBytes(fixture.root)
    const tooEarly = await setupHub(fixture.packageRoot, flags, fixture.host)
    assert.equal(tooEarly.ok, false)
    assert.match(tooEarly.issues.map((issue) => issue.message).join('\n'), /application writer gate is busy \(lease-active\)/)
    assert.deepEqual(treeBytes(fixture.root), beforeEligible)
    await new Promise((resolveWait) => setTimeout(resolveWait, 31_000))
    const retried = await setupHub(fixture.packageRoot, flags, fixture.host)
    assert.equal(retried.ok, true, JSON.stringify(retried.issues))
    assert.equal(fs.readdirSync(fixture.stageNamespace).some((name) => name.endsWith('.owner-stage')), false)
    assert.equal(fs.existsSync(fixture.paths.lifecycleLockPath), false)
    assert.equal(fs.existsSync(fixture.paths.lifecycleWalPath), false)
  })
})

test('lifecycle WAL phase CAS is file-flushed, directory-flushed, and exactly reread before return', async (t) => {
  const makeFixture = (label) => {
    const root = temporaryRoot(t, label)
    const packageRoot = path.join(root, 'package')
    const dataRoot = path.join(root, 'data')
    const installDir = path.join(root, 'install')
    seedPackage(packageRoot, '1.0.0', label)
    const { host } = createStatefulHost(root, { dataRoot, installDir, skipPath: true, skipTask: true })
    return { root, packageRoot, dataRoot, installDir, host, paths: installPathsFor(packageRoot, host) }
  }
  const flags = { ...setupFlags, noPath: true, noTask: true }

  await t.test('the committed phase is not observable as returned before its durability chain', async () => {
    const fixture = makeFixture('p4-wal-phase-durable-order')
    const events = []
    const descriptorPaths = new Map()
    const originalOpenSync = fs.openSync
    const originalCloseSync = fs.closeSync
    const originalFsyncSync = fs.fsyncSync
    const originalRenameSync = fs.renameSync
    fs.openSync = function (target, openFlags, ...rest) {
      const descriptor = originalOpenSync.call(fs, target, openFlags, ...rest)
      if (typeof target === 'string') {
        const absolute = path.resolve(target)
        descriptorPaths.set(descriptor, absolute)
        if (absolute === path.resolve(fixture.paths.lifecycleWalPath) && (openFlags === 'r' || openFlags === fs.constants.O_RDONLY)) {
          events.push(['wal-read', absolute])
        }
      }
      return descriptor
    }
    fs.closeSync = function (descriptor) {
      try { return originalCloseSync.call(fs, descriptor) } finally { descriptorPaths.delete(descriptor) }
    }
    fs.fsyncSync = function (descriptor) {
      const absolute = descriptorPaths.get(descriptor)
      if (absolute) events.push(['fsync', absolute])
      return originalFsyncSync.call(fs, descriptor)
    }
    fs.renameSync = function (source, destination) {
      if (path.resolve(String(destination)) === path.resolve(fixture.paths.lifecycleWalPath)
        && String(source).endsWith('.lifecycle-stage')) {
        events.push(['wal-rename', path.resolve(String(source))])
      }
      return originalRenameSync.call(fs, source, destination)
    }
    try {
      const installed = await setupHub(fixture.packageRoot, flags, fixture.host)
      assert.equal(installed.ok, true, JSON.stringify(installed.issues))
    } finally {
      fs.openSync = originalOpenSync
      fs.closeSync = originalCloseSync
      fs.fsyncSync = originalFsyncSync
      fs.renameSync = originalRenameSync
    }
    const renameIndex = events.findIndex(([kind]) => kind === 'wal-rename')
    assert.ok(renameIndex > 0, JSON.stringify(events))
    const stage = events[renameIndex][1]
    const parent = path.resolve(path.dirname(fixture.paths.lifecycleWalPath))
    const stageFsync = events.findIndex(([kind, absolute], index) => index < renameIndex && kind === 'fsync' && absolute === stage)
    const parentFsync = events.findIndex(([kind, absolute], index) => index > renameIndex && kind === 'fsync' && absolute === parent)
    const finalRead = events.findIndex(([kind], index) => index > parentFsync && kind === 'wal-read')
    assert.ok(stageFsync >= 0 && stageFsync < renameIndex, JSON.stringify(events))
    assert.ok(parentFsync > renameIndex, JSON.stringify(events))
    assert.ok(finalRead > parentFsync, JSON.stringify(events))
    assert.equal(fs.existsSync(fixture.paths.lifecycleWalPath), false)
    assert.equal(fs.existsSync(fixture.paths.lifecycleLockPath), false)
  })

  await t.test('a post-rename directory-fsync failure remains exact recovery authority for the first retry', async () => {
    const fixture = makeFixture('p4-wal-phase-dir-fsync-failure')
    const descriptorPaths = new Map()
    const originalOpenSync = fs.openSync
    const originalCloseSync = fs.closeSync
    const originalFsyncSync = fs.fsyncSync
    const originalRenameSync = fs.renameSync
    let phaseRenamed = false
    let injected = false
    fs.openSync = function (target, openFlags, ...rest) {
      const descriptor = originalOpenSync.call(fs, target, openFlags, ...rest)
      if (typeof target === 'string') descriptorPaths.set(descriptor, path.resolve(target))
      return descriptor
    }
    fs.closeSync = function (descriptor) {
      try { return originalCloseSync.call(fs, descriptor) } finally { descriptorPaths.delete(descriptor) }
    }
    fs.renameSync = function (source, destination) {
      const result = originalRenameSync.call(fs, source, destination)
      if (path.resolve(String(destination)) === path.resolve(fixture.paths.lifecycleWalPath)
        && String(source).endsWith('.lifecycle-stage')) phaseRenamed = true
      return result
    }
    fs.fsyncSync = function (descriptor) {
      if (!injected && phaseRenamed
        && descriptorPaths.get(descriptor) === path.resolve(path.dirname(fixture.paths.lifecycleWalPath))) {
        injected = true
        throw Object.assign(new Error('injected WAL parent fsync failure'), { code: 'EIO' })
      }
      return originalFsyncSync.call(fs, descriptor)
    }
    let interrupted
    try {
      interrupted = await setupHub(fixture.packageRoot, flags, fixture.host)
    } finally {
      fs.openSync = originalOpenSync
      fs.closeSync = originalCloseSync
      fs.fsyncSync = originalFsyncSync
      fs.renameSync = originalRenameSync
    }
    assert.equal(injected, true)
    assert.equal(interrupted.ok, false)
    const retried = await setupHub(fixture.packageRoot, flags, fixture.host)
    assert.equal(retried.ok, true, JSON.stringify(retried.issues))
    assert.equal(fs.existsSync(fixture.paths.lifecycleWalPath), false)
    assert.equal(fs.existsSync(fixture.paths.lifecycleLockPath), false)
    assert.equal(fs.existsSync(fixture.paths.manifestPath), true)
  })
})

test('guarded manual stop closes the exact owned task instance before terminating its daemon tree', async (t) => {
  const root = temporaryRoot(t, 'p4-daemon-stop-task-instance')
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  const taskName = 'SkillGraft-p4-daemon-stop-task-instance'
  const portProbe = new Server()
  await new Promise((resolveListen, rejectListen) => {
    portProbe.once('error', rejectListen)
    portProbe.listen(0, '127.0.0.1', resolveListen)
  })
  const portAddress = portProbe.address()
  assert.ok(portAddress && typeof portAddress === 'object')
  const port = portAddress.port
  await new Promise((resolveClose) => portProbe.close(() => resolveClose()))
  const events = []
  let daemonAlive = true
  let listenerPresent = true
  const daemonIdentity = 'p4-manual-stop-daemon-8811'
  seedPackage(packageRoot, '1.0.0', 'daemon-stop-task-instance')
  const { host, state } = createStatefulHost(root, {
    dataRoot,
    installDir,
    taskName,
    port,
    skipPath: true,
    skipTask: false,
    stopScheduledTaskInstance: ({ name, launcher }) => {
      events.push(`task-stop:${name}:${launcher}`)
    },
    pidAlive: () => false,
    processCommandLine: () => '',
    killPid: () => false,
    waitForPidsExit: () => false
  })
  assert.equal((await setupHub(packageRoot, {
    ...setupFlags,
    noPath: true,
    noTask: true,
    noDaemon: true
  }, host)).ok, true)
  const paths = installPathsFor(packageRoot, host)
  const manifest = JSON.parse(fs.readFileSync(paths.manifestPath, 'utf8'))
  manifest.features.daemon = true
  manifest.features.task = true
  manifest.owned.task = {
    taskPath: '\\',
    name: taskName,
    launcher: paths.silentVbs,
    created: true
  }
  fs.writeFileSync(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  const taskAction = `wscript.exe\u0000"${paths.silentVbs}"`
  state.tasks.set(taskName, taskAction)
  state.writes.length = 0
  const protocol = {
    home: root,
    dataRoot,
    platform: 'win32',
    readReceiptAuthority: () => readDaemonLifecycleReceiptAuthority(dataRoot, host)
  }
  const empty = inspectDaemonProtocol(protocol)
  const namespace = bootstrapDaemonStageNamespace({
    ...protocol,
    expectedInspection: empty,
    expectedReceiptAuthority: inspectDaemonReceiptNamespace(
      root,
      dataRoot,
      protocol.readReceiptAuthority,
      'win32'
    ),
    namespaceId: '91919191-9191-4191-8191-919191919191'
  })
  const daemon = Object.freeze({
    epochId: '92929292-9292-4292-8292-929292929292',
    pid: 8811,
    apiPid: 8811,
    processIdentity: daemonIdentity,
    pgid: 8811,
    port,
    createdAt: '2026-08-24T00:00:00.000Z'
  })
  const start = createDaemonStartStage(namespace, daemon)
  for (const projection of ['pid', 'apiPid', 'heartbeat']) {
    publishDaemonStartProjection(start, projection)
  }
  commitDaemonStartInstance(start)
  collapseCommittedDaemonStart(acquireCommittedDaemonStartCollapseAuthority(
    protocol,
    inspectDaemonProtocol(protocol)
  ))
  assert.equal(inspectDaemonProtocol(protocol).kind, 'RUNNING-CLEAN')
  const aliveFacts = (pid, processIdentity, pgid = pid) => Object.freeze({
    state: 'alive',
    pid,
    ppid: 1,
    processIdentity,
    pgid,
    commandLine: `fake-process-${pid}`
  })
  const processHost = Object.freeze({
    platform: 'win32',
    processFacts(pid) {
      if (pid === process.pid) return aliveFacts(pid, `p4-manual-stop-controller-${pid}`)
      if (pid === daemon.pid && daemonAlive) return aliveFacts(pid, daemonIdentity)
      return Object.freeze({ state: 'dead' })
    },
    processTree(rootPid, expectedIdentity) {
      if (!daemonAlive || rootPid !== daemon.pid || expectedIdentity !== daemonIdentity) {
        return Object.freeze({ state: 'unknown' })
      }
      return Object.freeze({
        state: 'exact',
        rootPid,
        rootProcessIdentity: daemonIdentity,
        entries: Object.freeze([aliveFacts(daemon.pid, daemonIdentity)])
      })
    },
    listenerFacts(expectedPort) {
      assert.equal(expectedPort, port)
      if (!listenerPresent) return Object.freeze({ state: 'absent' })
      return Object.freeze({
        state: 'present',
        pids: Object.freeze([daemon.apiPid]),
        bindings: Object.freeze([Object.freeze({
          family: 'ipv4',
          address: '127.0.0.1',
          port,
          pid: daemon.apiPid
        })])
      })
    },
    terminateExactTree(tree) {
      assert.equal(tree.rootPid, daemon.pid)
      assert.equal(tree.rootProcessIdentity, daemonIdentity)
      events.push(`terminate:${tree.entries.map((entry) => entry.pid).join(',')}`)
      daemonAlive = false
      listenerPresent = false
      return Object.freeze({ state: 'signaled', pids: Object.freeze([daemon.pid]) })
    },
    waitForExit(tree) {
      events.push(`wait:${tree.entries.map((entry) => entry.pid).join(',')}`)
      return daemonAlive
        ? Object.freeze({ state: 'timeout', pids: Object.freeze([daemon.pid]) })
        : Object.freeze({ state: 'exited' })
    }
  })
  const healthProbe = async () => Object.freeze({
    state: 'exact',
    epochId: daemon.epochId,
    packageRoot,
    dataRoot
  })

  assert.equal(await stopDaemonGuarded(packageRoot, host, dataRoot, { processHost, healthProbe }), true)
  assert.deepEqual(events, [
    `task-stop:${taskName}:${paths.silentVbs}`,
    'terminate:8811',
    'wait:8811'
  ])
  assert.equal(state.tasks.get(taskName), taskAction)
  assert.equal(inspectDaemonProtocol(protocol).kind, 'ABSENT')
})

test('uninstall removes only its leading PATH entry and preserves later opaque user bytes', async (t) => {
  const root = temporaryRoot(t, 'p4-path-suffix')
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  seedPackage(packageRoot, '1.0.0')
  const { host, state } = createStatefulHost(root, { dataRoot, installDir })
  const installed = await setupHub(packageRoot, setupFlags, host)
  assert.equal(installed.ok, true, JSON.stringify(installed.issues))
  const ownedPath = `${path.join(installDir, 'bin')};C:\\Windows`
  assert.equal(state.userPath, ownedPath)

  state.userPath = `${ownedPath};  %FOREIGN_BIN%  ;;`
  const removed = await uninstallHub(packageRoot, host)
  assert.equal(removed.ok, true, JSON.stringify(removed.issues))
  assert.equal(state.userPathExists, true)
  assert.equal(state.userPathKind, 'ExpandString')
  assert.equal(state.userPath, 'C:\\Windows;  %FOREIGN_BIN%  ;;')
})

test('uninstall treats a moved formerly-owned PATH entry as foreign and preserves it', async (t) => {
  const root = temporaryRoot(t, 'p4-path-reordered')
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  seedPackage(packageRoot, '1.0.0')
  const { host, state } = createStatefulHost(root, { dataRoot, installDir })
  const installed = await setupHub(packageRoot, setupFlags, host)
  assert.equal(installed.ok, true, JSON.stringify(installed.issues))
  const reordered = `C:\\Windows;${path.join(installDir, 'bin')}`
  state.userPath = reordered

  const removed = await uninstallHub(packageRoot, host)
  assert.equal(removed.ok, true, JSON.stringify(removed.issues))
  assert.equal(removed.pathRemoved, false)
  assert.equal(state.userPath, reordered)
  assert.equal(fs.existsSync(path.join(installDir, 'install.json')), false)
})

test('uninstall preserves duplicate-bin suffix, PATH kind drift, and an explicit empty suffix', async (t) => {
  await t.test('duplicate and kind', async () => {
    const root = temporaryRoot(t, 'p4-path-duplicate-kind')
    const packageRoot = path.join(root, 'package')
    const dataRoot = path.join(root, 'data')
    const installDir = path.join(root, 'install')
    seedPackage(packageRoot, '1.0.0')
    const { host, state } = createStatefulHost(root, { dataRoot, installDir })
    assert.equal((await setupHub(packageRoot, setupFlags, host)).ok, true)
    const bin = path.join(installDir, 'bin')
    state.userPath = `${bin};C:\\Windows;${bin};FOREIGN`
    state.userPathKind = 'String'
    const removed = await uninstallHub(packageRoot, host)
    assert.equal(removed.ok, true, JSON.stringify(removed.issues))
    assert.equal(state.userPath, `C:\\Windows;${bin};FOREIGN`)
    assert.equal(state.userPathKind, 'String')
  })

  await t.test('absent prior plus empty suffix', async () => {
    const root = temporaryRoot(t, 'p4-path-empty-suffix')
    const packageRoot = path.join(root, 'package')
    const dataRoot = path.join(root, 'data')
    const installDir = path.join(root, 'install')
    seedPackage(packageRoot, '1.0.0')
    const { host, state } = createStatefulHost(root, {
      dataRoot,
      installDir,
      userPath: '',
      userPathExists: false
    })
    assert.equal((await setupHub(packageRoot, setupFlags, host)).ok, true)
    state.userPath = `${path.join(installDir, 'bin')};`
    state.userPathExists = true
    const removed = await uninstallHub(packageRoot, host)
    assert.equal(removed.ok, true, JSON.stringify(removed.issues))
    assert.equal(state.userPathExists, true)
    assert.equal(state.userPath, '')
  })
})

test('uninstall locates the manifest independently and preserves every unowned integration fact', async (t) => {
  const root = temporaryRoot(t, 'p4-unowned-integration')
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  const extraShimDir = path.join(root, 'external-shims')
  seedPackage(packageRoot, '1.0.0')
  fs.mkdirSync(extraShimDir, { recursive: true })
  const { host, state } = createStatefulHost(root, { dataRoot, installDir, extraShimDir })
  const paths = installPathsFor(packageRoot, host, undefined, host.environment(), { resolveHostExtraShim: true })
  state.userPath = `C:\\Windows;${paths.binDir}`
  state.userEnvironment.set('SKILL_GRAFT_HOME', dataRoot)
  state.userEnvironment.set('HUB_ROOT', dataRoot)
  state.userEnvironment.set('HUB_API_PORT', String(paths.port))

  const installed = await setupHub(packageRoot, setupFlags, host)
  assert.equal(installed.ok, true, JSON.stringify(installed.issues))
  const manifest = JSON.parse(fs.readFileSync(path.join(installDir, 'install.json'), 'utf8'))
  assert.equal(manifest.owned.pathEntry.added, false)
  assert.deepEqual(manifest.owned.environment.map((entry) => entry.created), [false, false, false])

  const foreignPath = 'C:\\FOREIGN_ONLY'
  const foreignHome = path.join(root, 'foreign-home')
  const foreignLegacy = path.join(root, 'different-foreign-home')
  state.userPath = foreignPath
  state.userEnvironment.delete('SKILL_GRAFT_HOME')
  state.userEnvironment.set('HUB_ROOT', foreignLegacy)
  state.userEnvironment.set('HUB_API_PORT', '29999')
  state.selection.set('SKILL_GRAFT_HOME', foreignHome)
  state.selection.set('HUB_ROOT', foreignLegacy)
  state.selection.set('HUB_API_PORT', '29999')
  state.selection.set('SG_TASK_NAME', 'ForeignSelection')
  fs.writeFileSync(paths.extraShimCmd, '@echo foreign shim\r\n')
  fs.rmSync(paths.extraShimAliasCmd)

  const removed = await uninstallHub(packageRoot, host)
  assert.equal(removed.ok, true, JSON.stringify(removed.issues))
  assert.equal(removed.pathRemoved, false)
  assert.equal(removed.extraShimsRemoved, false)
  assert.equal(state.userPath, foreignPath)
  assert.equal(state.userEnvironment.has('SKILL_GRAFT_HOME'), false)
  assert.equal(state.userEnvironment.get('HUB_ROOT'), foreignLegacy)
  assert.equal(state.userEnvironment.get('HUB_API_PORT'), '29999')
  assert.equal(fs.readFileSync(paths.extraShimCmd, 'utf8'), '@echo foreign shim\r\n')
  assert.equal(fs.existsSync(paths.extraShimAliasCmd), false)
  assert.equal(fs.existsSync(installDir), false)
})

test('uninstall never treats SG_SKIP providers as absence for enabled owned features', async (t) => {
  await t.test('PATH and environment provider', async () => {
    const root = temporaryRoot(t, 'p4-uninstall-skip-path')
    const packageRoot = path.join(root, 'package')
    const dataRoot = path.join(root, 'data')
    const installDir = path.join(root, 'install')
    seedPackage(packageRoot, '1.0.0')
    const { host, state } = createStatefulHost(root, { dataRoot, installDir })
    assert.equal((await setupHub(packageRoot, setupFlags, host)).ok, true)
    state.writes.length = 0
    host.skipPath = true
    const before = treeBytes(root)
    const pathBefore = state.userPath
    const environmentBefore = [...state.userEnvironment]

    const result = await uninstallHub(packageRoot, host)
    assert.equal(result.ok, false)
    assert.match(result.issues[0].message, /persistent PATH\/environment provider is unavailable/)
    assert.deepEqual(treeBytes(root), before)
    assert.deepEqual(state.writes, [])
    assert.equal(state.userPath, pathBefore)
    assert.deepEqual([...state.userEnvironment], environmentBefore)
  })

  await t.test('scheduled-task provider', async () => {
    const root = temporaryRoot(t, 'p4-uninstall-skip-task')
    const packageRoot = path.join(root, 'package')
    const dataRoot = path.join(root, 'data')
    const installDir = path.join(root, 'install')
    const taskName = 'SkillGraft-p4-skip-task'
    seedPackage(packageRoot, '1.0.0')
    const { host, state } = createStatefulHost(root, { dataRoot, installDir, taskName })
    assert.equal((await setupHub(packageRoot, setupFlags, host)).ok, true)
    const manifestFile = path.join(installDir, 'install.json')
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
    manifest.features.daemon = true
    manifest.features.task = true
    manifest.owned.task = {
      taskPath: '\\',
      name: taskName,
      launcher: path.join(installDir, 'silent-run.vbs'),
      created: true
    }
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
    state.tasks.set(taskName, `wscript.exe\u0000"${manifest.owned.task.launcher}"`)
    state.writes.length = 0
    host.skipTask = true
    const before = treeBytes(root)
    const taskBefore = [...state.tasks]

    const result = await uninstallHub(packageRoot, host)
    assert.equal(result.ok, false)
    assert.match(result.issues[0].message, /persistent scheduled-task provider is unavailable/)
    assert.deepEqual(treeBytes(root), before)
    assert.deepEqual(state.writes, [])
    assert.deepEqual([...state.tasks], taskBefore)
  })
})

test('SG_SKIP refuses a prepared setup WAL whose embedded manifest is the only provider authority', async (t) => {
  const root = temporaryRoot(t, 'p4-skip-setup-wal-only')
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  const taskName = 'SkillGraft-p4-skip-setup-wal'
  seedPackage(packageRoot, '1.0.0')
  const fixture = createStatefulHost(root, {
    dataRoot,
    installDir,
    taskName,
    registerLogonTask: ({ state }) => {
      state.tasks.set(taskName, 'foreign.exe\u0000C:\\foreign\\setup-cut.exe')
      throw new Error('setup-task-publication-cut')
    }
  })
  const setup = await setupHub(packageRoot, taskSetupFlags, fixture.host)
  assert.equal(setup.ok, false)
  const paths = installPathsFor(packageRoot, fixture.host)
  assert.equal(fs.existsSync(paths.lifecycleWalPath), true)
  fs.rmSync(paths.manifestPath, { force: true })
  fixture.host.skipPath = true
  fixture.host.skipTask = true
  fixture.state.writes.length = 0
  const rootBefore = treeBytes(root)
  const pathBefore = fixture.state.userPath
  const environmentBefore = [...fixture.state.userEnvironment]
  const taskBefore = [...fixture.state.tasks]

  const result = await uninstallHub(packageRoot, fixture.host)
  assert.equal(result.ok, false)
  assert.match(result.issues[0].message, /persistent PATH\/environment provider is unavailable|persistent scheduled-task provider is unavailable/)
  assert.equal(fs.existsSync(paths.lifecycleWalPath), true)
  assert.deepEqual(treeBytes(root), rootBefore)
  assert.deepEqual(fixture.state.writes, [])
  assert.equal(fixture.state.userPath, pathBefore)
  assert.deepEqual([...fixture.state.userEnvironment], environmentBefore)
  assert.deepEqual([...fixture.state.tasks], taskBefore)
})

test('prepared uninstall never treats a disappeared preserved foreign task as a closed owned task', async (t) => {
  const root = temporaryRoot(t, 'p4-uninstall-preserved-task-restart')
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  const taskName = 'SkillGraft-p4-preserved-task'
  seedPackage(packageRoot, '1.0.0')
  const { host, state } = createStatefulHost(root, { dataRoot, installDir, taskName })
  assert.equal((await setupHub(packageRoot, setupFlags, host)).ok, true)

  const manifestFile = path.join(installDir, 'install.json')
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  manifest.features.daemon = true
  manifest.features.task = true
  manifest.owned.task = {
    taskPath: '\\',
    name: taskName,
    launcher: path.join(installDir, 'silent-run.vbs'),
    created: true
  }
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
  const foreignTask = 'foreign.exe\u0000C:\\foreign\\launcher.exe'
  state.tasks.set(taskName, foreignTask)
  state.writes.length = 0

  const paths = installPathsFor(packageRoot, host)
  const installBefore = treeBytes(installDir)
  const dataBefore = treeBytes(dataRoot)
  const pathBefore = state.userPath
  const environmentBefore = [...state.userEnvironment]
  const originalPathCas = host.compareExchangeUserPath
  let cutCalls = 0
  host.compareExchangeUserPath = () => {
    cutCalls += 1
    state.tasks.delete(taskName)
    throw new Error('prepared-uninstall-task-disappearance-cut')
  }

  const interrupted = await uninstallHub(packageRoot, host)
  assert.equal(interrupted.ok, false)
  assert.equal(cutCalls, 1)
  assert.equal(state.tasks.has(taskName), false)
  assert.equal(fs.existsSync(paths.lifecycleWalPath), true)
  assert.deepEqual(treeBytes(installDir), installBefore)
  assert.deepEqual(treeBytes(dataRoot), dataBefore)
  assert.equal(state.userPath, pathBefore)
  assert.deepEqual([...state.userEnvironment], environmentBefore)
  assert.deepEqual(state.writes, [])

  host.compareExchangeUserPath = originalPathCas
  const restartInstallBefore = treeBytes(installDir)
  const restartDataBefore = treeBytes(dataRoot)
  const restarted = await uninstallHub(packageRoot, host)
  assert.equal(restarted.ok, false)
  assert.match(restarted.issues.map((issue) => issue.message).join('\n'), /task closure|integration closure|foreign scheduled task state|differs from both WAL endpoints/)
  assert.equal(fs.existsSync(paths.lifecycleWalPath), true)
  assert.deepEqual(treeBytes(installDir), restartInstallBefore)
  assert.deepEqual(treeBytes(dataRoot), restartDataBefore)
  assert.equal(state.userPath, pathBefore)
  assert.deepEqual([...state.userEnvironment], environmentBefore)
  assert.deepEqual(state.writes, [])

  fs.rmSync(manifestFile)
  host.skipTask = true
  const receiptOnlyInstallBefore = treeBytes(installDir)
  const receiptOnlyDataBefore = treeBytes(dataRoot)
  const receiptOnlyWal = fs.readFileSync(paths.lifecycleWalPath)
  const skipped = await uninstallHub(packageRoot, host)
  assert.equal(skipped.ok, false)
  assert.match(skipped.issues[0].message, /persistent scheduled-task provider is unavailable/)
  assert.deepEqual(fs.readFileSync(paths.lifecycleWalPath), receiptOnlyWal)
  assert.deepEqual(treeBytes(installDir), receiptOnlyInstallBefore)
  assert.deepEqual(treeBytes(dataRoot), receiptOnlyDataBefore)
  assert.deepEqual(state.writes, [])
})

test('setup adopts exact P3 runtime without changing private skills or state', async (t) => {
  const root = temporaryRoot(t)
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  seedPackage(packageRoot, '1.0.0')
  fs.mkdirSync(dataRoot, { recursive: true })
  for (const relative of ['AGENTS.override.md', ...LOCAL_RUNTIME_ASSET_PATHS.map((name) => `overlay/${name}`)]) {
    const source = path.join(packageRoot, ...relative.split('/'))
    const target = path.join(dataRoot, ...relative.split('/'))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(source, target)
  }
  const privateSkill = path.join(dataRoot, 'skills', 'private-project', 'SKILL.md')
  const stateFile = path.join(dataRoot, 'skill-review', 'state.json')
  fs.mkdirSync(path.dirname(privateSkill), { recursive: true })
  fs.mkdirSync(path.dirname(stateFile), { recursive: true })
  fs.writeFileSync(privateSkill, '# private bytes\n')
  fs.writeFileSync(stateFile, '{"user":"state"}\n')
  const privateBefore = fs.readFileSync(privateSkill)
  const stateBefore = fs.readFileSync(stateFile)
  const { host } = createStatefulHost(root, { dataRoot, installDir, skipPath: true, skipTask: true })
  const result = await setupHub(packageRoot, { ...setupFlags, noPath: true, noTask: true }, host)
  assert.equal(result.ok, true, JSON.stringify(result.issues))
  assert.deepEqual(fs.readFileSync(privateSkill), privateBefore)
  assert.deepEqual(fs.readFileSync(stateFile), stateBefore)
  assert.equal(fs.existsSync(path.join(dataRoot, '.skill-graft-data-root.json')), true)
})

test('foreign task and install-tree content fail the read-only preflight before any lifecycle mutation', async (t) => {
  const root = temporaryRoot(t)
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  seedPackage(packageRoot, '1.0.0')
  const taskName = 'SkillGraft-p4-foreign'
  const { host, state } = createStatefulHost(root, {
    dataRoot,
    installDir,
    taskName,
    tasks: [[taskName, 'evil.exe\u0000F:/foreign/path']]
  })
  const packageBefore = treeBytes(packageRoot)
  const result = await setupHub(packageRoot, taskSetupFlags, host)
  assert.equal(result.ok, false)
  assert.match(result.issues.map((issue) => issue.message).join('\n'), /foreign scheduled task/)
  assert.deepEqual(state.writes, [])
  assert.equal(fs.existsSync(dataRoot), false)
  assert.equal(fs.existsSync(installDir), false)
  assert.deepEqual(treeBytes(packageRoot), packageBefore)

  state.tasks.clear()
  const installed = await setupHub(packageRoot, setupFlags, host)
  assert.equal(installed.ok, true, JSON.stringify(installed.issues))
  fs.writeFileSync(path.join(installDir, 'foreign.txt'), 'foreign\n')
  state.writes.length = 0
  const uninstall = await uninstallHub(packageRoot, host)
  assert.equal(uninstall.ok, false)
  assert.match(uninstall.issues[0].message, /unowned file/)
  assert.deepEqual(state.writes, [])
  assert.equal(fs.readFileSync(path.join(installDir, 'foreign.txt'), 'utf8'), 'foreign\n')
})

test('setup refuses PATH, environment, and exact-task ownership races after taking its lock', async (t) => {
  for (const kind of ['path', 'environment', 'task']) {
    await t.test(kind, async () => {
      const root = temporaryRoot(t, `p4-setup-${kind}-race`)
      const packageRoot = path.join(root, 'package')
      const dataRoot = path.join(root, 'data')
      const installDir = path.join(root, 'install')
      const taskName = `SkillGraft-p4-${kind}-race`
      seedPackage(packageRoot, '1.0.0')
      let paths
      const fixture = createStatefulHost(root, {
        dataRoot,
        installDir,
        taskName,
        onTaskExists: ({ call, state }) => {
          // The fourth lookup is the first ownership read after the lifecycle lock.
          if (call !== 4) return
          if (kind === 'path') state.userPath = `${state.userPath};${paths.binDir}`
          if (kind === 'environment') {
            state.userEnvironment.set('SKILL_GRAFT_HOME', dataRoot)
            state.userEnvironment.set('HUB_ROOT', dataRoot)
            state.userEnvironment.set('HUB_API_PORT', String(paths.port))
          }
          if (kind === 'task') {
            state.tasks.set(taskName, `wscript.exe\u0000"${paths.silentVbs}"`)
          }
        }
      })
      paths = installPathsFor(packageRoot, fixture.host)
      const packageBefore = treeBytes(packageRoot)
      const result = await setupHub(packageRoot, taskSetupFlags, fixture.host)
      assert.equal(result.ok, false)
      const expectedRace = {
        path: /user PATH changed after preflight/,
        environment: /user environment changed after preflight: SKILL_GRAFT_HOME/,
        task: /foreign scheduled task/
      }[kind]
      assert.match(result.issues.map((issue) => issue.message).join('\n'), expectedRace)
      assert.deepEqual(fixture.state.writes, [])
      assert.equal(fs.existsSync(dataRoot), false)
      assert.equal(fs.existsSync(installDir), false)
      assert.equal(fs.existsSync(`${dataRoot}.lifecycle-wal.json`), false)
      assert.equal(fs.existsSync(path.join(installDir, 'install.json')), false)
      assert.deepEqual(treeBytes(packageRoot), packageBefore)
    })
  }
})

test('setup failure rolls fresh roots back, while a raced foreign task is preserved with WAL evidence', async (t) => {
  const cleanRoot = temporaryRoot(t, 'p4-clean-task-failure')
  const cleanPackageRoot = path.join(cleanRoot, 'package')
  seedPackage(cleanPackageRoot, '1.0.0')
  const cleanData = path.join(cleanRoot, 'clean-data')
  const cleanInstall = path.join(cleanRoot, 'clean-install')
  const clean = createStatefulHost(cleanRoot, {
    dataRoot: cleanData,
    installDir: cleanInstall,
    taskName: 'SkillGraft-p4-clean-fail',
    registerLogonTask: () => { throw new Error('task service unavailable') }
  })
  const cleanResult = await setupHub(cleanPackageRoot, taskSetupFlags, clean.host)
  assert.equal(cleanResult.ok, false)
  assert.equal(fs.existsSync(cleanData), false)
  assert.equal(fs.existsSync(cleanInstall), false)
  assert.equal(fs.existsSync(`${cleanData}.lifecycle-wal.json`), false)

  const racedRoot = temporaryRoot(t, 'p4-raced-task-failure')
  const racedPackageRoot = path.join(racedRoot, 'package')
  seedPackage(racedPackageRoot, '1.0.0')
  const racedData = path.join(racedRoot, 'raced-data')
  const racedInstall = path.join(racedRoot, 'raced-install')
  const racedName = 'SkillGraft-p4-raced'
  let racedRegisterCalls = 0
  const raced = createStatefulHost(racedRoot, {
    dataRoot: racedData,
    installDir: racedInstall,
    taskName: racedName,
    registerLogonTask: ({ state }) => {
      racedRegisterCalls += 1
      state.tasks.set(racedName, 'evil.exe\u0000F:/raced/foreign')
      throw new Error('raced foreign task')
    }
  })
  const racedResult = await setupHub(racedPackageRoot, taskSetupFlags, raced.host)
  assert.equal(racedResult.ok, false)
  assert.equal(racedRegisterCalls, 1)
  assert.equal(raced.state.tasks.get(racedName), 'evil.exe\u0000F:/raced/foreign')
  assert.equal(fs.existsSync(`${racedData}.lifecycle-wal.json`), true)
  assert.equal(racedResult.issues.some((issue) => /rollback refused a concurrently changed scheduled task/.test(issue.message)), true)
})

test('path-enabled upgrade binds full dist/web identity and remains idempotent', async (t) => {
  const root = temporaryRoot(t)
  const packageA = path.join(root, 'package-a')
  const packageB = path.join(root, 'package-b')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  seedPackage(packageA, '1.0.0', 'A')
  seedPackage(packageB, '2.0.0', 'B')
  const { host, state } = createStatefulHost(root, { dataRoot, installDir, skipTask: true })
  const installed = await setupHub(packageA, { ...setupFlags, noTask: true }, host)
  assert.equal(installed.ok, true, JSON.stringify(installed.issues))
  const installedPath = {
    exists: state.userPathExists,
    value: state.userPath,
    kind: state.userPathKind
  }
  JSON.parse(fs.readFileSync(path.join(installDir, 'install.json'), 'utf8'))

  fs.appendFileSync(path.join(packageA, 'dist', 'application', 'hub-application.js'), '// dirty\n')
  const dirtyDoctor = await doctorHub(packageA, host, dataRoot)
  assert.equal(dirtyDoctor.ok, false)
  assert.equal(dirtyDoctor.lifecycle.versionMatch, false)
  fs.writeFileSync(path.join(packageA, 'dist', 'application', 'hub-application.js'), '// application A\n')

  const sameVersionDifferentBytes = path.join(root, 'package-a-repacked')
  seedPackage(sameVersionDifferentBytes, '1.0.0', 'repacked-A')
  const repacked = await upgradeHub(sameVersionDifferentBytes, { dryRun: true, json: true, noDaemon: true }, host)
  assert.equal(repacked.ok, false)
  assert.match(repacked.issues[0].message, /reuses the installed version with different package bytes/)

  const dry = await upgradeHub(packageB, { dryRun: true, json: true, noDaemon: true }, host)
  assert.equal(dry.ok, true, JSON.stringify(dry.issues))
  assert.equal(dry.status, 'planned')
  assert.equal(dry.fromVersion, '1.0.0')
  assert.equal(dry.toVersion, '2.0.0')
  const upgraded = await upgradeHub(packageB, { dryRun: false, json: true, noDaemon: true }, host)
  assert.equal(upgraded.ok, true, JSON.stringify(upgraded.issues))
  assert.equal(upgraded.status, 'upgraded')
  assert.deepEqual({
    exists: state.userPathExists,
    value: state.userPath,
    kind: state.userPathKind
  }, installedPath, 'same install bin must preserve the exact PATH value and kind')
  const upgradePaths = installPathsFor(packageB, host)
  assert.equal(fs.existsSync(upgradePaths.lifecycleWalPath), false)
  assert.equal(fs.existsSync(upgradePaths.lifecycleLockPath), false)
  const manifestB = JSON.parse(fs.readFileSync(path.join(installDir, 'install.json'), 'utf8'))
  assert.equal(manifestB.packageVersion, '2.0.0')
  assert.match(fs.readFileSync(path.join(installDir, 'bin', 'sg.cmd'), 'utf8'), new RegExp(packageB.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

  fs.appendFileSync(path.join(packageB, 'web', 'assets', 'app.js'), '// dirty web\n')
  assert.equal((await doctorHub(packageB, host, dataRoot)).lifecycle.versionMatch, false)
  fs.writeFileSync(path.join(packageB, 'web', 'assets', 'app.js'), '// web B\n')

  const current = await setupHub(packageB, { ...setupFlags, noTask: true }, host)
  assert.equal(current.ok, true, JSON.stringify(current.issues))
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(installDir, 'install.json'), 'utf8')), manifestB)
})

test('upgrade and setup rebind the strict receipt on the first committed-upgrade retry', async (t) => {
  const root = temporaryRoot(t, 'p4-committed-upgrade-receipt')
  const packageA = path.join(root, 'package-a')
  const packageB = path.join(root, 'package-b')
  const packageC = path.join(root, 'package-c')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  seedPackage(packageA, '1.0.0', 'receipt-A')
  seedPackage(packageB, '2.0.0', 'receipt-B')
  seedPackage(packageC, '3.0.0', 'receipt-C')
  const { host, state } = createStatefulHost(root, {
    dataRoot,
    installDir,
    taskName: 'SkillGraft-p4-receipt-upgrade',
    skipPath: true,
    skipTask: true
  })
  assert.equal((await setupHub(packageA, { ...setupFlags, noPath: true, noTask: true }, host)).ok, true)
  const paths = installPathsFor(packageA, host)

  const interruptedB = await interruptLifecycleReceiptReplacement(
    host,
    () => upgradeHub(packageB, { dryRun: false, json: true, noDaemon: true }, host),
    'committed-upgrade-B-before-receipt-switch-cut'
  )
  assert.equal(interruptedB.hit, true, JSON.stringify(interruptedB.result))
  assert.equal(interruptedB.result.ok, false)
  assert.equal(fs.existsSync(paths.lifecycleWalPath), true)
  assert.equal(inspectLifecycleRootReceipt(host).packageVersion, '1.0.0')
  assert.equal(JSON.parse(fs.readFileSync(path.join(installDir, 'install.json'), 'utf8')).packageVersion, '2.0.0')

  state.selection.clear()
  const retriedUpgrade = await upgradeHub(packageB, { dryRun: false, json: true, noDaemon: true }, host)
  assert.equal(retriedUpgrade.ok, true, JSON.stringify(retriedUpgrade.issues))
  assert.equal(retriedUpgrade.status, 'already-current')
  assert.equal(inspectLifecycleRootReceipt(host).packageVersion, '2.0.0')
  assert.equal(fs.existsSync(paths.lifecycleWalPath), false)

  const interruptedC = await interruptLifecycleReceiptReplacement(
    host,
    () => upgradeHub(packageC, { dryRun: false, json: true, noDaemon: true }, host),
    'committed-upgrade-C-before-receipt-switch-cut'
  )
  assert.equal(interruptedC.hit, true, JSON.stringify(interruptedC.result))
  assert.equal(interruptedC.result.ok, false)
  assert.equal(fs.existsSync(paths.lifecycleWalPath), true)
  assert.equal(inspectLifecycleRootReceipt(host).packageVersion, '2.0.0')
  assert.equal(JSON.parse(fs.readFileSync(path.join(installDir, 'install.json'), 'utf8')).packageVersion, '3.0.0')

  const retriedSetup = await setupHub(packageC, { ...setupFlags, noPath: true, noTask: true }, host)
  assert.equal(retriedSetup.ok, true, JSON.stringify(retriedSetup.issues))
  assert.equal(inspectLifecycleRootReceipt(host).packageVersion, '3.0.0')
  assert.equal(fs.existsSync(paths.lifecycleWalPath), false)
})

test('purge requires inactive marker ID and fresh plan hash, including after install-dir env drift', async (t) => {
  const root = temporaryRoot(t)
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  seedPackage(packageRoot, '1.0.0')
  const { host, state } = createStatefulHost(root, { dataRoot, installDir, skipPath: true, skipTask: true })
  assert.equal((await setupHub(packageRoot, { ...setupFlags, noPath: true, noTask: true }, host)).ok, true)
  state.selection.set('SG_INSTALL_DIR', path.join(root, 'bypass-install'))
  const active = await purgeHub(packageRoot, { dataRoot, dryRun: true, commit: false, json: true }, host)
  assert.equal(active.ok, false)
  assert.match(active.issues[0].message, /inactive or purging preserved root receipt/)
  state.selection.set('SG_INSTALL_DIR', installDir)
  assert.equal((await uninstallHub(packageRoot, host)).ok, true)
  fs.rmSync(packageRoot, { recursive: true })
  fs.mkdirSync(packageRoot)
  fs.writeFileSync(path.join(packageRoot, 'foreign.txt'), 'foreign package after uninstall\n')
  const foreignPackageBefore = treeBytes(packageRoot)

  const dry = await purgeHub(packageRoot, { dataRoot, dryRun: true, commit: false, json: true }, host)
  assert.equal(dry.ok, true, JSON.stringify(dry.issues))
  fs.mkdirSync(path.join(dataRoot, 'skills', 'inbox'), { recursive: true })
  fs.writeFileSync(path.join(dataRoot, 'skills', 'inbox', 'user-added.txt'), 'changed after plan\n')
  const stale = await purgeHub(packageRoot, {
    dataRoot,
    dryRun: false,
    commit: true,
    planHash: dry.plan.planHash,
    dataRootId: dry.plan.dataRootId,
    json: true
  }, host)
  assert.equal(stale.ok, false)
  assert.equal(fs.existsSync(dataRoot), true)

  const fresh = await purgeHub(packageRoot, { dataRoot, dryRun: true, commit: false, json: true }, host)
  const receiptFile = lifecycleRootReceiptPath(host)
  const originalUnlinkSync = fs.unlinkSync
  const originalFsyncSync = fs.fsyncSync
  let receiptUnlinked = false
  let receiptFlushFailureInjected = false
  fs.unlinkSync = function (target) {
    const result = originalUnlinkSync.call(fs, target)
    if (path.resolve(String(target)) === path.resolve(receiptFile)) receiptUnlinked = true
    return result
  }
  fs.fsyncSync = function (descriptor) {
    if (receiptUnlinked && !receiptFlushFailureInjected) {
      receiptFlushFailureInjected = true
      const error = new Error('injected post-receipt-unlink directory fsync failure')
      error.code = 'EIO'
      throw error
    }
    return originalFsyncSync.call(fs, descriptor)
  }
  let purged
  try {
    purged = await purgeHub(packageRoot, {
      dataRoot,
      dryRun: false,
      commit: true,
      planHash: fresh.plan.planHash,
      dataRootId: fresh.plan.dataRootId,
      json: true
    }, host)
  } finally {
    fs.unlinkSync = originalUnlinkSync
    fs.fsyncSync = originalFsyncSync
  }
  assert.equal(purged.ok, true, JSON.stringify(purged.issues))
  assert.equal(receiptFlushFailureInjected, true)
  assert.equal(fs.existsSync(dataRoot), false)
  assert.equal(inspectLifecycleRootReceipt(host), null)
  assert.deepEqual(treeBytes(packageRoot), foreignPackageBefore)

  const postUnlinkRetry = await purgeHub(packageRoot, {
    dataRoot,
    dryRun: false,
    commit: true,
    planHash: fresh.plan.planHash,
    dataRootId: fresh.plan.dataRootId,
    json: true
  }, host)
  assert.equal(postUnlinkRetry.ok, true, JSON.stringify(postUnlinkRetry.issues))
  assert.equal(postUnlinkRetry.status, 'already-absent')
  assert.equal(postUnlinkRetry.plan, null)

  fs.mkdirSync(dataRoot, { recursive: true })
  fs.writeFileSync(path.join(dataRoot, 'foreign.txt'), 'foreign after terminal purge\n')
  const foreignBefore = treeBytes(dataRoot)
  const foreignRetry = await purgeHub(packageRoot, {
    dataRoot,
    dryRun: false,
    commit: true,
    planHash: fresh.plan.planHash,
    dataRootId: fresh.plan.dataRootId,
    json: true
  }, host)
  assert.equal(foreignRetry.ok, false)
  assert.match(foreignRetry.issues[0].message, /data-root inode without a preserved root receipt/)
  assert.deepEqual(treeBytes(dataRoot), foreignBefore)

  fs.rmSync(dataRoot, { recursive: true })
  const tombstone = `${dataRoot}.purging-foreign-id-cut`
  const quarantine = `${tombstone}.deleting`
  fs.mkdirSync(quarantine)
  fs.writeFileSync(path.join(quarantine, 'sentinel.txt'), 'preserve tombstone quarantine\n')
  const residueBefore = treeBytes(root)
  const residueRetry = await purgeHub(packageRoot, {
    dataRoot,
    dryRun: false,
    commit: true,
    planHash: fresh.plan.planHash,
    dataRootId: fresh.plan.dataRootId,
    json: true
  }, host)
  assert.equal(residueRetry.ok, false)
  assert.match(residueRetry.issues[0].message, /lifecycle or deletion residue/)
  assert.deepEqual(treeBytes(root), residueBefore)

  fs.rmSync(quarantine, { recursive: true })
  const foreignWal = `${dataRoot}.lifecycle-wal.json`
  fs.writeFileSync(foreignWal, 'foreign WAL bytes\n')
  const walBefore = treeBytes(root)
  const walRetry = await purgeHub(packageRoot, {
    dataRoot,
    dryRun: false,
    commit: true,
    planHash: fresh.plan.planHash,
    dataRootId: fresh.plan.dataRootId,
    json: true
  }, host)
  assert.equal(walRetry.ok, false)
  assert.match(walRetry.issues[0].message, /lifecycle WAL evidence/)
  assert.deepEqual(treeBytes(root), walBefore)
})

test('purge rejects an unowned daemon stage sibling before its first protocol mutation', async (t) => {
  const root = temporaryRoot(t, 'p4-purge-foreign-daemon-stage')
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  seedPackage(packageRoot, '1.0.0', 'foreign-daemon-stage')
  const { host, state } = createStatefulHost(root, { dataRoot, installDir, skipPath: true, skipTask: true })
  assert.equal((await setupHub(packageRoot, { ...setupFlags, noPath: true, noTask: true }, host)).ok, true)
  assert.equal((await uninstallHub(packageRoot, host)).ok, true)
  const paths = installPathsFor(packageRoot, host)
  const dry = await purgeHub(packageRoot, { dataRoot, dryRun: true, commit: false, json: true }, host)
  assert.equal(dry.ok, true, JSON.stringify(dry.issues))
  const daemonStage = `${dataRoot}.daemon-instance-stages`
  fs.mkdirSync(daemonStage)
  fs.writeFileSync(path.join(daemonStage, 'foreign-sentinel.txt'), 'foreign daemon stage\n')
  const rootEvidence = captureDirectoryEvidence(root)
  const receiptFile = lifecycleRootReceiptPath(host)
  const receiptEvidence = captureFileEvidence(receiptFile)
  const daemonEvidence = captureDirectoryEvidence(daemonStage)
  state.writes.length = 0
  const result = await purgeHub(packageRoot, {
    dataRoot,
    dryRun: false,
    commit: true,
    planHash: dry.plan.planHash,
    dataRootId: dry.plan.dataRootId,
    json: true
  }, host)
  assert.equal(result.ok, false)
  assert.match(result.issues.map((issue) => issue.message).join('\n'), /unauthorized reserved sibling.*daemon-instance-stages/)
  assertDirectoryEvidence(root, rootEvidence, 'foreign daemon-stage purge root')
  assertDirectoryEvidence(daemonStage, daemonEvidence, 'foreign daemon-stage sibling')
  assertFileEvidence(receiptFile, receiptEvidence, 'inactive receipt before daemon-stage refusal')
  assert.equal(fs.existsSync(paths.lifecycleWalPath), false)
  assert.equal(fs.existsSync(paths.lifecycleLockPath), false)
  assert.equal(fs.existsSync(`${dataRoot}.purge-wal-v1.json`), false)
  assert.deepEqual(state.writes, [])
})

test('purge rejects a canonical daemon HOME and stage authority before its first protocol mutation', async (t) => {
  const root = temporaryRoot(t, 'p4-purge-owned-daemon-stage')
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  seedPackage(packageRoot, '1.0.0', 'owned-daemon-stage')
  const { host, state } = createStatefulHost(root, { dataRoot, installDir, skipPath: true, skipTask: true })
  assert.equal((await setupHub(packageRoot, { ...setupFlags, noPath: true, noTask: true }, host)).ok, true)
  assert.equal((await uninstallHub(packageRoot, host)).ok, true)
  const paths = installPathsFor(packageRoot, host)
  const fresh = await purgeHub(packageRoot, { dataRoot, dryRun: true, commit: false, json: true }, host)
  assert.equal(fresh.ok, true, JSON.stringify(fresh.issues))

  const namespaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const receiptFile = lifecycleRootReceiptPath(host)
  const receiptDirectory = path.dirname(receiptFile)
  const homeMarker = path.join(receiptDirectory, `.daemon-stage-namespace-v1.${namespaceId}.marker`)
  const daemonStage = `${dataRoot}.daemon-instance-stages`
  const innerMarker = path.join(daemonStage, `.namespace-v1.${namespaceId}.skill-graft.marker`)
  fs.writeFileSync(homeMarker, '', { flag: 'wx' })
  fs.mkdirSync(daemonStage)
  fs.writeFileSync(innerMarker, '', { flag: 'wx' })
  const rootEvidence = captureDirectoryEvidence(root)
  const receiptEvidence = captureFileEvidence(receiptFile)
  const homeMarkerEvidence = captureFileEvidence(homeMarker)
  const daemonEvidence = captureDirectoryEvidence(daemonStage)

  state.writes.length = 0
  const dry = await purgeHub(packageRoot, { dataRoot, dryRun: true, commit: false, json: true }, host)
  assert.equal(dry.ok, false)
  assert.match(dry.issues.map((issue) => issue.message).join('\n'), /daemon.*(?:stage|authority)|daemon-instance-stages/i)
  assertDirectoryEvidence(root, rootEvidence, 'owned daemon authority dry-run root')
  assertFileEvidence(receiptFile, receiptEvidence, 'owned daemon authority dry-run receipt')
  assertFileEvidence(homeMarker, homeMarkerEvidence, 'owned daemon HOME marker')
  assertDirectoryEvidence(daemonStage, daemonEvidence, 'owned daemon stage namespace')
  assert.deepEqual(state.writes, [])

  const result = await purgeHub(packageRoot, {
    dataRoot,
    dryRun: false,
    commit: true,
    planHash: fresh.plan.planHash,
    dataRootId: fresh.plan.dataRootId,
    json: true
  }, host)
  assert.equal(result.ok, false)
  assert.match(result.issues.map((issue) => issue.message).join('\n'), /daemon.*(?:stage|authority)|daemon-instance-stages/i)
  assertDirectoryEvidence(root, rootEvidence, 'owned daemon authority commit root')
  assertFileEvidence(receiptFile, receiptEvidence, 'owned daemon authority commit receipt')
  assertFileEvidence(homeMarker, homeMarkerEvidence, 'owned daemon HOME marker after commit')
  assertDirectoryEvidence(daemonStage, daemonEvidence, 'owned daemon stage namespace after commit')
  assert.equal(fs.existsSync(paths.lifecycleWalPath), false)
  assert.equal(fs.existsSync(paths.lifecycleLockPath), false)
  assert.equal(fs.existsSync(`${dataRoot}.purge-wal-v1.json`), false)
  assert.deepEqual(state.writes, [])
})

test('purge resumes an exact inactive-to-purging durable receipt handoff', async (t) => {
  const root = temporaryRoot(t, 'p4-purge-receipt-cut')
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  seedPackage(packageRoot, '1.0.0')
  const { host } = createStatefulHost(root, { dataRoot, installDir, skipPath: true, skipTask: true })
  assert.equal((await setupHub(packageRoot, { ...setupFlags, noPath: true, noTask: true }, host)).ok, true)
  assert.equal((await uninstallHub(packageRoot, host)).ok, true)

  const dry = await purgeHub(packageRoot, { dataRoot, dryRun: true, commit: false, json: true }, host)
  assert.equal(dry.ok, true, JSON.stringify(dry.issues))
  const commit = () => purgeHub(packageRoot, {
      dataRoot,
      dryRun: false,
      commit: true,
      planHash: dry.plan.planHash,
      dataRootId: dry.plan.dataRootId,
      json: true
    }, host)
  const interrupted = await interruptLifecycleReceiptReplacement(
    host,
    commit,
    'abrupt inactive-to-purging receipt replacement cut'
  )
  assert.equal(interrupted.hit, true, JSON.stringify(interrupted.result.issues))
  assert.equal(interrupted.result.ok, false)
  assert.match(interrupted.result.issues.map((issue) => issue.message).join('\n'), /abrupt inactive-to-purging/)
  assert.equal(fs.existsSync(dataRoot), false)
  assert.equal(inspectLifecycleRootReceipt(host).state, 'inactive')
  const receiptFile = lifecycleRootReceiptPath(host)
  const pendingFile = path.join(path.dirname(receiptFile), 'root-receipt-v1.pending.json')
  assert.equal(JSON.parse(fs.readFileSync(pendingFile, 'utf8')).state, 'purging')
  assert.equal(JSON.parse(fs.readFileSync(`${dataRoot}.purge-wal-v1.json`, 'utf8')).phase, 'deleted')

  fs.writeFileSync(installDir, 'foreign install file after terminal handoff\n')
  const uninstallResidue = `${installDir}.uninstalling-foreign-after-handoff`
  fs.mkdirSync(uninstallResidue)
  fs.writeFileSync(path.join(uninstallResidue, 'foreign.txt'), 'foreign uninstall-prefix bytes\n')
  const foreignInstallBefore = fs.readFileSync(installDir)
  const foreignUninstallBefore = treeBytes(uninstallResidue)
  const foreignInstallInode = fs.lstatSync(installDir).ino
  const foreignUninstallInode = fs.lstatSync(uninstallResidue).ino

  const resumed = await commit()
  assert.equal(resumed.ok, true, JSON.stringify(resumed.issues))
  assert.equal(resumed.status, 'purged')
  assert.equal(inspectLifecycleRootReceipt(host), null)
  assert.equal(fs.existsSync(pendingFile), false)
  assert.equal(fs.existsSync(`${dataRoot}.purge-wal-v1.json`), false)
  assert.equal(fs.lstatSync(installDir).ino, foreignInstallInode)
  assert.equal(fs.lstatSync(uninstallResidue).ino, foreignUninstallInode)
  assert.equal(fs.lstatSync(installDir).isFile(), true)
  assert.deepEqual(fs.readFileSync(installDir), foreignInstallBefore)
  assert.deepEqual(treeBytes(uninstallResidue), foreignUninstallBefore)
})

test('purging receipt-only recovery rejects a reappeared canonical tree before any protocol write', async (t) => {
  const root = temporaryRoot(t, 'p4-purge-terminal-reappearance')
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  const backup = path.join(root, 'data-backup')
  seedPackage(packageRoot, '1.0.0', 'purge-terminal-reappearance')
  const { host } = createStatefulHost(root, { dataRoot, installDir, skipPath: true, skipTask: true })
  assert.equal((await setupHub(packageRoot, { ...setupFlags, noPath: true, noTask: true }, host)).ok, true)
  assert.equal((await uninstallHub(packageRoot, host)).ok, true)
  fs.cpSync(dataRoot, backup, { recursive: true, preserveTimestamps: true })
  const dry = await purgeHub(packageRoot, { dataRoot, dryRun: true, commit: false, json: true }, host)
  assert.equal(dry.ok, true, JSON.stringify(dry.issues))
  const commitFlags = {
    dataRoot,
    dryRun: false,
    commit: true,
    planHash: dry.plan.planHash,
    dataRootId: dry.plan.dataRootId,
    json: true
  }
  const paths = installPathsFor(packageRoot, host)
  const originalUnlinkSync = fs.unlinkSync
  let ownerRetired = false
  fs.unlinkSync = function (target, ...rest) {
    const result = originalUnlinkSync.call(fs, target, ...rest)
    if (!ownerRetired && path.resolve(String(target)) === path.resolve(paths.lifecycleLockPath)) {
      ownerRetired = true
      throw new Error('abrupt cut after terminal lifecycle owner retirement')
    }
    return result
  }
  let interrupted
  try {
    interrupted = await purgeHub(packageRoot, commitFlags, host)
  } finally {
    fs.unlinkSync = originalUnlinkSync
  }
  assert.equal(ownerRetired, true)
  assert.equal(interrupted.ok, false)
  assert.match(interrupted.issues.map((issue) => issue.message).join('\n'), /abrupt cut after terminal lifecycle owner retirement/)
  assert.equal(inspectLifecycleRootReceipt(host).state, 'purging')
  assert.equal(fs.existsSync(`${dataRoot}.purge-wal-v1.json`), false)
  assert.equal(fs.existsSync(paths.lifecycleLockPath), false)
  assert.equal(fs.existsSync(dataRoot), false)
  assert.deepEqual(fs.readdirSync(path.join(applicationLeaseRoot(dataRoot), 'leases')), [])

  fs.cpSync(backup, dataRoot, { recursive: true, preserveTimestamps: true })
  const before = treeBytes(root)
  const refused = await purgeHub(packageRoot, commitFlags, host)
  assert.equal(refused.ok, false)
  assert.match(refused.issues.map((issue) => issue.message).join('\n'), /purge receipt cleanup requires absent data/)
  assert.deepEqual(treeBytes(root), before)
  assert.equal(fs.existsSync(paths.lifecycleLockPath), false)
  assert.equal(fs.existsSync(`${dataRoot}.purge-wal-v1.json`), false)
  assert.deepEqual(fs.readdirSync(path.join(applicationLeaseRoot(dataRoot), 'leases')), [])
})

test('purging receipt publication resumes only its deterministic pending writer and linked shapes', async (t) => {
  const root = temporaryRoot(t, 'p4-purge-receipt-publication-shapes')
  const archive = temporaryRoot(t, 'p4-purge-receipt-publication-archive')
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  seedPackage(packageRoot, '1.0.0', 'purge-receipt-publication-shapes')
  const { host } = createStatefulHost(root, { dataRoot, installDir, skipPath: true, skipTask: true })
  assert.equal((await setupHub(packageRoot, { ...setupFlags, noPath: true, noTask: true }, host)).ok, true)
  assert.equal((await uninstallHub(packageRoot, host)).ok, true)
  const dry = await purgeHub(packageRoot, { dataRoot, dryRun: true, commit: false, json: true }, host)
  assert.equal(dry.ok, true, JSON.stringify(dry.issues))
  const commitFlags = {
    dataRoot,
    dryRun: false,
    commit: true,
    planHash: dry.plan.planHash,
    dataRootId: dry.plan.dataRootId,
    json: true
  }
  const commit = () => purgeHub(packageRoot, commitFlags, host)
  const interrupted = await interruptLifecycleReceiptReplacement(
    host,
    commit,
    'capture deterministic purging receipt publication'
  )
  assert.equal(interrupted.hit, true)
  assert.equal(interrupted.result.ok, false)
  const receiptFile = lifecycleRootReceiptPath(host)
  const receiptDirectory = path.dirname(receiptFile)
  const pendingFile = path.join(receiptDirectory, 'root-receipt-v1.pending.json')
  const paths = installPathsFor(packageRoot, host)
  const ownerFile = paths.lifecycleLockPath
  const stageNamespace = `${dataRoot}.lifecycle-owner-stages`
  const walFile = `${dataRoot}.purge-wal-v1.json`
  const inactiveReceipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'))
  const purgingReceipt = JSON.parse(fs.readFileSync(pendingFile, 'utf8'))
  assert.equal(inactiveReceipt.state, 'inactive')
  assert.equal(purgingReceipt.state, 'purging')
  assert.equal(JSON.parse(fs.readFileSync(walFile, 'utf8')).phase, 'deleted')
  assert.equal(fs.statSync(ownerFile).nlink, 1)
  fs.cpSync(receiptDirectory, path.join(archive, 'receipt'), { recursive: true, preserveTimestamps: true })
  fs.cpSync(stageNamespace, path.join(archive, 'stages'), { recursive: true, preserveTimestamps: true })
  fs.copyFileSync(walFile, path.join(archive, 'purge-wal.json'))
  fs.copyFileSync(ownerFile, path.join(archive, 'lifecycle-owner.json'))

  const restoreBase = () => {
    fs.rmSync(receiptDirectory, { recursive: true, force: true })
    fs.rmSync(stageNamespace, { recursive: true, force: true })
    fs.rmSync(walFile, { force: true })
    for (const name of fs.readdirSync(path.dirname(ownerFile))) {
      if (name === path.basename(ownerFile) || name.startsWith(`${path.basename(ownerFile)}.`)) {
        const candidate = path.join(path.dirname(ownerFile), name)
        if (fs.lstatSync(candidate).isFile()) fs.rmSync(candidate, { force: true })
      }
    }
    fs.cpSync(path.join(archive, 'receipt'), receiptDirectory, { recursive: true, preserveTimestamps: true })
    fs.cpSync(path.join(archive, 'stages'), stageNamespace, { recursive: true, preserveTimestamps: true })
    fs.copyFileSync(path.join(archive, 'purge-wal.json'), walFile)
    fs.copyFileSync(path.join(archive, 'lifecycle-owner.json'), ownerFile)
  }
  const complete = async (shape) => {
    const result = await commit()
    assert.equal(result.ok, true, `${shape}: ${JSON.stringify(result.issues)}`)
    assert.equal(result.status, 'purged')
    assert.equal(inspectLifecycleRootReceipt(host), null)
    assert.equal(fs.existsSync(walFile), false)
    assert.equal(fs.existsSync(stageNamespace), false)
    assert.deepEqual(fs.readdirSync(path.join(applicationLeaseRoot(dataRoot), 'leases')), [])
  }

  for (const shape of ['pending', 'writer', 'writer-pending-link', 'final', 'final-pending-link']) {
    await t.test(shape, async () => {
      restoreBase()
      const writer = lifecycleReceiptWriterPath(root, Date.now() + 60_000, { pid: process.pid })
      if (shape === 'writer') {
        fs.renameSync(pendingFile, writer)
      } else if (shape === 'writer-pending-link') {
        fs.linkSync(pendingFile, writer)
        assert.equal(fs.statSync(pendingFile).nlink, 2)
      } else if (shape === 'final') {
        fs.unlinkSync(receiptFile)
        fs.renameSync(pendingFile, receiptFile)
      } else if (shape === 'final-pending-link') {
        fs.unlinkSync(receiptFile)
        fs.linkSync(pendingFile, receiptFile)
        assert.equal(fs.statSync(receiptFile).nlink, 2)
      }
      await complete(shape)
    })
  }

  for (const shape of ['independent-inode', 'wrong-basename']) {
    await t.test(`owner final plus ${shape} pending is rejected before receipt handoff`, async () => {
      restoreBase()
      const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'))
      const pendingToken = shape === 'wrong-basename'
        ? '11111111-1111-4111-8111-111111111111'
        : owner.token
      const ownerPending = `${ownerFile}.${pendingToken}.owner-pending`
      fs.copyFileSync(ownerFile, ownerPending)
      assert.equal(fs.statSync(ownerFile).nlink, 1)
      assert.equal(fs.statSync(ownerPending).nlink, 1)
      const before = treeBytes(root)
      const receiptInode = fs.lstatSync(receiptFile).ino
      const pendingReceiptInode = fs.lstatSync(pendingFile).ino
      const walInode = fs.lstatSync(walFile).ino
      const result = await commit()
      assert.equal(result.ok, false)
      assert.match(
        result.issues.map((issue) => issue.message).join('\n'),
        shape === 'wrong-basename' ? /pending name does not bind/ : /not an exact link pair/
      )
      assert.equal(fs.lstatSync(receiptFile).ino, receiptInode)
      assert.equal(fs.lstatSync(pendingFile).ino, pendingReceiptInode)
      assert.equal(fs.lstatSync(walFile).ino, walInode)
      assert.deepEqual(treeBytes(root), before)
    })
  }

  await t.test('recent partial prefix is pre-gate read-only and its expired retry converges', async () => {
    restoreBase()
    const recentWriter = lifecycleReceiptWriterPath(root, Date.now() + 60_000, { pid: 999_998 })
    const prefix = fs.readFileSync(pendingFile).subarray(0, 64)
    fs.unlinkSync(pendingFile)
    fs.writeFileSync(recentWriter, prefix)
    const before = treeBytes(root)
    const recent = await commit()
    assert.equal(recent.ok, false)
    assert.match(recent.issues.map((issue) => issue.message).join('\n'), /recent incomplete purging receipt writer/)
    assert.deepEqual(treeBytes(root), before)
    assert.deepEqual(fs.readdirSync(path.join(applicationLeaseRoot(dataRoot), 'leases')), [])

    const expiredWriter = lifecycleReceiptWriterPath(root, Date.now() - 1_000, { pid: 999_998 })
    fs.renameSync(recentWriter, expiredWriter)
    await complete('expired partial prefix')
  })
})

test('a real child kill at durable renamed purge authority is busy until TTL and then converges', async (t) => {
  const root = temporaryRoot(t, 'p4-purge-renamed-real-kill')
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  seedPackage(packageRoot, '1.0.0', 'purge-renamed-real-kill')
  const { host } = createStatefulHost(root, { dataRoot, installDir, skipPath: true, skipTask: true })
  assert.equal((await setupHub(packageRoot, { ...setupFlags, noPath: true, noTask: true }, host)).ok, true)
  assert.equal((await uninstallHub(packageRoot, host)).ok, true)
  fs.mkdirSync(path.join(dataRoot, 'skills', 'inbox'), { recursive: true })
  fs.writeFileSync(path.join(dataRoot, 'skills', 'inbox', 'restart.txt'), 'durable renamed restart\n')
  const dry = await purgeHub(packageRoot, { dataRoot, dryRun: true, commit: false, json: true }, host)
  assert.equal(dry.ok, true, JSON.stringify(dry.issues))
  const commitFlags = {
    dataRoot,
    dryRun: false,
    commit: true,
    planHash: dry.plan.planHash,
    dataRootId: dry.plan.dataRootId,
    json: true
  }
  const selection = {
    HUB_ROOT: dataRoot,
    SG_INSTALL_DIR: installDir,
    HUB_API_PORT: '23111'
  }
  const walFile = `${dataRoot}.purge-wal-v1.json`
  const script = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { createInstallHost } from ${JSON.stringify(pathToFileURL(path.resolve('dist/adapters/install-host.js')).href)};
    import { purgeHub } from ${JSON.stringify(pathToFileURL(path.resolve('dist/control/install.js')).href)};
    const selection = new Map(Object.entries(${JSON.stringify(selection)}));
    const walFile = ${JSON.stringify(walFile)};
    const originalLstat = fs.promises.lstat;
    let announced = false;
    fs.promises.lstat = async function(target, ...rest) {
      const absolute = path.resolve(String(target));
      if (!announced && fs.existsSync(walFile)) {
        const wal = JSON.parse(fs.readFileSync(walFile, 'utf8'));
        const tombstone = path.resolve(wal.tombstone);
        if (wal.phase === 'renamed' && (absolute === tombstone || absolute.startsWith(tombstone + path.sep))) {
          announced = true;
          fs.writeSync(1, 'PURGE_RENAMED_CUT_READY\\n');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        }
      }
      return originalLstat.call(fs.promises, target, ...rest);
    };
    const host = createInstallHost({
      platform: 'win32', home: ${JSON.stringify(root)}, localAppData: ${JSON.stringify(path.join(root, 'localappdata'))},
      pathSep: ';', caseInsensitive: true, skipPath: true, skipTask: true,
      env: (name) => selection.get(name), environment: () => Object.fromEntries(selection),
      userPathState: () => ({ exists: false, value: '', kind: null }), userPath: () => '',
      userEnv: () => undefined, userEnvState: () => ({ exists: false, value: '', kind: null }),
      setUserPath: () => {}, setUserEnv: () => {}, compareExchangeUserPath: () => false,
      compareExchangeUserEnv: () => false, broadcastEnv: () => {}, taskExists: () => false,
      taskAction: () => '', registerLogonTask: () => {}, stopScheduledTaskInstance: () => {},
      unregisterTask: () => {}, which: (name) => name === 'git' ? 'git.exe' : '',
      commandVersion: () => 'git version fixture', pidAlive: () => false,
      processCommandLine: () => '', killPid: () => false, waitForPidsExit: () => false,
      runNpm: () => { throw new Error('unexpected npm'); }
    });
    await purgeHub(${JSON.stringify(packageRoot)}, ${JSON.stringify(commitFlags)}, host);
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const childExited = new Promise((resolveExit) => child.once('exit', resolveExit))
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGKILL')
    if (child.exitCode === null) await childExited
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const deadline = Date.now() + 25_000
  while (!stdout.includes('PURGE_RENAMED_CUT_READY') && child.exitCode === null && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
  }
  assert.match(stdout, /PURGE_RENAMED_CUT_READY/, stderr)
  const renamedWal = JSON.parse(fs.readFileSync(walFile, 'utf8'))
  assert.equal(renamedWal.phase, 'renamed')
  assert.equal(fs.existsSync(dataRoot), false)
  assert.equal(fs.existsSync(renamedWal.tombstone), true)
  child.kill('SIGKILL')
  await childExited

  const beforeEligible = treeBytes(root)
  const tooEarly = await purgeHub(packageRoot, commitFlags, host)
  assert.equal(tooEarly.ok, false)
  assert.match(tooEarly.issues.map((issue) => issue.message).join('\n'), /application writer gate is busy \(lease-active\)/)
  assert.deepEqual(treeBytes(root), beforeEligible)
  await new Promise((resolveWait) => setTimeout(resolveWait, 31_000))
  const resumed = await purgeHub(packageRoot, commitFlags, host)
  assert.equal(resumed.ok, true, JSON.stringify(resumed.issues))
  assert.equal(resumed.status, 'purged')
  assert.equal(inspectLifecycleRootReceipt(host), null)
  assert.equal(fs.existsSync(walFile), false)
  assert.equal(fs.existsSync(renamedWal.tombstone), false)
  assert.deepEqual(fs.readdirSync(path.join(applicationLeaseRoot(dataRoot), 'leases')), [])
})

test('purge never adopts same-byte replacement inodes across locked and phase scan awaits', async (t) => {
  for (const mode of ['locked-plan', 'prepared', 'renamed']) {
    await t.test(mode, async () => {
      const root = temporaryRoot(t, `p4-purge-inode-${mode}`)
      const packageRoot = path.join(root, 'package')
      const dataRoot = path.join(root, 'data')
      const installDir = path.join(root, 'install')
      seedPackage(packageRoot, '1.0.0', `purge-inode-${mode}`)
      const { host } = createStatefulHost(root, { dataRoot, installDir, skipPath: true, skipTask: true })
      assert.equal((await setupHub(packageRoot, { ...setupFlags, noPath: true, noTask: true }, host)).ok, true)
      assert.equal((await uninstallHub(packageRoot, host)).ok, true)
      const victimRelative = path.join('skills', 'inbox', 'same-bytes.txt')
      const victim = path.join(dataRoot, victimRelative)
      fs.mkdirSync(path.dirname(victim), { recursive: true })
      fs.writeFileSync(victim, 'same bytes across the async cut\n')
      const dry = await purgeHub(packageRoot, { dataRoot, dryRun: true, commit: false, json: true }, host)
      assert.equal(dry.ok, true, JSON.stringify(dry.issues))
      const walFile = `${dataRoot}.purge-wal-v1.json`
      const originalPromisesLstat = fs.promises.lstat
      let hit = false
      let replacementPath = ''
      let parkedPath = ''
      let replacementInode = null
      fs.promises.lstat = async function (target, ...rest) {
        const absolute = path.resolve(String(target))
        let wal = null
        if (fs.existsSync(walFile)) wal = JSON.parse(fs.readFileSync(walFile, 'utf8'))
        const expectedVictim = mode === 'renamed' && wal
          ? path.join(wal.tombstone, victimRelative)
          : victim
        const atCut = mode === 'locked-plan'
          ? !wal
          : wal?.phase === mode
        if (!hit && atCut && absolute === path.resolve(expectedVictim)) {
          hit = true
          replacementPath = expectedVictim
          parkedPath = `${expectedVictim}.frozen-before-await`
          const bytes = fs.readFileSync(expectedVictim)
          fs.renameSync(expectedVictim, parkedPath)
          fs.writeFileSync(expectedVictim, bytes)
          replacementInode = fs.lstatSync(expectedVictim).ino
        }
        return originalPromisesLstat.call(fs.promises, target, ...rest)
      }
      let result
      try {
        result = await purgeHub(packageRoot, {
          dataRoot,
          dryRun: false,
          commit: true,
          planHash: dry.plan.planHash,
          dataRootId: dry.plan.dataRootId,
          json: true
        }, host)
      } finally {
        fs.promises.lstat = originalPromisesLstat
      }
      assert.equal(hit, true, `${mode} did not reach the intended async path-stat cut`)
      assert.equal(result.ok, false)
      assert.match(result.issues.map((issue) => issue.message).join('\n'), /initial metadata freeze|changed before bounded hashing/)
      assert.equal(fs.lstatSync(replacementPath).ino, replacementInode)
      assert.equal(fs.readFileSync(replacementPath, 'utf8'), 'same bytes across the async cut\n')
      assert.equal(fs.readFileSync(parkedPath, 'utf8'), 'same bytes across the async cut\n')
      if (mode === 'locked-plan') {
        assert.equal(fs.existsSync(walFile), false)
        assert.equal(fs.existsSync(dataRoot), true)
      } else {
        const wal = JSON.parse(fs.readFileSync(walFile, 'utf8'))
        assert.equal(wal.phase, mode)
        assert.equal(fs.existsSync(dataRoot), mode === 'prepared')
        assert.equal(fs.existsSync(wal.tombstone), mode === 'renamed')
      }
      assert.equal(inspectLifecycleRootReceipt(host).state, 'inactive')
      assert.deepEqual(fs.readdirSync(path.join(applicationLeaseRoot(dataRoot), 'leases')), [])
    })
  }
})

test('purge deleting phase preserves same-byte live and isolated-slot replacement inodes', async (t) => {
  for (const mode of ['live', 'slot']) {
    await t.test(mode, async () => {
      const root = temporaryRoot(t, `p4-purge-deleting-inode-${mode}`)
      const packageRoot = path.join(root, 'package')
      const dataRoot = path.join(root, 'data')
      const installDir = path.join(root, 'install')
      seedPackage(packageRoot, '1.0.0', `purge-deleting-inode-${mode}`)
      const { host } = createStatefulHost(root, { dataRoot, installDir, skipPath: true, skipTask: true })
      assert.equal((await setupHub(packageRoot, { ...setupFlags, noPath: true, noTask: true }, host)).ok, true)
      assert.equal((await uninstallHub(packageRoot, host)).ok, true)
      const victimRelative = path.join('skills', 'inbox', 'deleting-same-bytes.txt')
      const victim = path.join(dataRoot, victimRelative)
      fs.mkdirSync(path.dirname(victim), { recursive: true })
      fs.writeFileSync(victim, 'same bytes at the deleting mutation cut\n')
      const dry = await purgeHub(packageRoot, { dataRoot, dryRun: true, commit: false, json: true }, host)
      assert.equal(dry.ok, true, JSON.stringify(dry.issues))
      const commitFlags = {
        dataRoot,
        dryRun: false,
        commit: true,
        planHash: dry.plan.planHash,
        dataRootId: dry.plan.dataRootId,
        json: true
      }
      const commit = () => purgeHub(packageRoot, commitFlags, host)
      const walFile = `${dataRoot}.purge-wal-v1.json`

      if (mode === 'slot') {
        const originalRenameSync = fs.renameSync
        let isolated = false
        fs.renameSync = function (source, target) {
          const result = originalRenameSync.call(fs, source, target)
          if (!isolated && String(target).endsWith('.leaf') && String(target).includes('.deleting')) {
            isolated = true
            throw new Error('abrupt cut after atomic leaf isolation')
          }
          return result
        }
        let interrupted
        try {
          interrupted = await commit()
        } finally {
          fs.renameSync = originalRenameSync
        }
        assert.equal(isolated, true, `slot fixture did not reach the leaf-isolation cut: ${JSON.stringify(interrupted.issues)}`)
        assert.equal(interrupted.ok, false)
        assert.match(interrupted.issues.map((issue) => issue.message).join('\n'), /abrupt cut after atomic leaf isolation/)
      }

      const interruptedWal = mode === 'slot' ? JSON.parse(fs.readFileSync(walFile, 'utf8')) : null
      if (interruptedWal) assert.equal(interruptedWal.phase, 'deleting')
      const slotName = interruptedWal
        ? fs.readdirSync(interruptedWal.quarantine).find((name) => name.endsWith('.leaf'))
        : null
      if (mode === 'slot') assert.equal(typeof slotName, 'string')
      let replacementPath = interruptedWal ? path.join(interruptedWal.quarantine, slotName) : ''
      if (replacementPath) assert.equal(fs.existsSync(replacementPath), true)
      const originalPromisesLstat = fs.promises.lstat
      let hit = false
      let parkedPath = ''
      let replacementInode = null
      fs.promises.lstat = async function (target, ...rest) {
        if (!hit && mode === 'live' && fs.existsSync(walFile)) {
          const currentWal = JSON.parse(fs.readFileSync(walFile, 'utf8'))
          if (currentWal.phase === 'deleting') replacementPath = path.join(currentWal.tombstone, victimRelative)
        }
        if (!hit && replacementPath && path.resolve(String(target)) === path.resolve(replacementPath)) {
          hit = true
          parkedPath = `${replacementPath}.frozen-before-await`
          const bytes = fs.readFileSync(replacementPath)
          fs.renameSync(replacementPath, parkedPath)
          fs.writeFileSync(replacementPath, bytes)
          replacementInode = fs.lstatSync(replacementPath).ino
        }
        return originalPromisesLstat.call(fs.promises, target, ...rest)
      }
      let result
      try {
        result = await commit()
      } finally {
        fs.promises.lstat = originalPromisesLstat
      }
      assert.equal(hit, true, `${mode} did not reach its deleting-phase async path-stat cut: ${JSON.stringify(result.issues)}`)
      assert.equal(result.ok, false)
      assert.match(result.issues.map((issue) => issue.message).join('\n'), /initial metadata freeze|changed before bounded hashing|changed before deletion|changed before isolation/)
      assert.equal(fs.lstatSync(replacementPath).ino, replacementInode)
      assert.equal(fs.readFileSync(replacementPath, 'utf8').length > 0, true)
      assert.equal(fs.readFileSync(parkedPath, 'utf8').length > 0, true)
      assert.equal(JSON.parse(fs.readFileSync(walFile, 'utf8')).phase, 'deleting')
      assert.deepEqual(fs.readdirSync(path.join(applicationLeaseRoot(dataRoot), 'leases')), [])
    })
  }
})

test('durable purge phases retain their pre-gate inode authority across the Application gate await', async (t) => {
  for (const mode of [
    'prepared-canonical',
    'prepared-tombstone',
    'renamed',
    'deleting-live',
    'deleting-slot',
    'deleting-quarantine'
  ]) {
    await t.test(mode, async () => {
      const root = temporaryRoot(t, `p4-purge-gate-inode-${mode}`)
      const packageRoot = path.join(root, 'package')
      const dataRoot = path.join(root, 'data')
      const installDir = path.join(root, 'install')
      seedPackage(packageRoot, '1.0.0', `purge-gate-inode-${mode}`)
      const { host } = createStatefulHost(root, { dataRoot, installDir, skipPath: true, skipTask: true })
      assert.equal((await setupHub(packageRoot, { ...setupFlags, noPath: true, noTask: true }, host)).ok, true)
      assert.equal((await uninstallHub(packageRoot, host)).ok, true)
      const victimRelative = path.join('skills', 'inbox', 'gate-same-bytes.txt')
      const victim = path.join(dataRoot, victimRelative)
      fs.mkdirSync(path.dirname(victim), { recursive: true })
      fs.writeFileSync(victim, 'same bytes across the Application gate await\n')
      const dry = await purgeHub(packageRoot, { dataRoot, dryRun: true, commit: false, json: true }, host)
      assert.equal(dry.ok, true, JSON.stringify(dry.issues))
      const commitFlags = {
        dataRoot,
        dryRun: false,
        commit: true,
        planHash: dry.plan.planHash,
        dataRootId: dry.plan.dataRootId,
        json: true
      }
      const commit = () => purgeHub(packageRoot, commitFlags, host)
      const walFile = `${dataRoot}.purge-wal-v1.json`

      // Materialize a real restart shape first. The second commit below must
      // therefore freeze the already-durable phase before it begins waiting
      // for the machine mutex and Application gate.
      const originalRenameSync = fs.renameSync
      const originalMkdirSync = fs.mkdirSync
      const originalPromisesLstat = fs.promises.lstat
      let fixtureHit = false
      if (mode === 'prepared-canonical' || mode === 'prepared-tombstone') {
        fs.renameSync = function (source, target, ...rest) {
          if (!fixtureHit
            && path.resolve(String(source)) === path.resolve(dataRoot)
            && path.basename(String(target)).startsWith(`${path.basename(dataRoot)}.purging-`)) {
            fixtureHit = true
            if (mode === 'prepared-tombstone') {
              originalRenameSync.call(fs, source, target, ...rest)
            }
            throw new Error(`durable ${mode} purge entry cut`)
          }
          return originalRenameSync.call(fs, source, target, ...rest)
        }
      } else if (mode === 'deleting-slot') {
        fs.renameSync = function (source, target, ...rest) {
          const result = originalRenameSync.call(fs, source, target, ...rest)
          if (!fixtureHit && String(target).endsWith('.leaf') && String(target).includes('.deleting')) {
            fixtureHit = true
            throw new Error('durable deleting slot entry cut')
          }
          return result
        }
      } else if (mode === 'deleting-quarantine') {
        fs.mkdirSync = function (target, ...rest) {
          const result = originalMkdirSync.call(fs, target, ...rest)
          if (!fixtureHit && fs.existsSync(walFile)) {
            const wal = JSON.parse(fs.readFileSync(walFile, 'utf8'))
            if (wal.phase === 'deleting' && path.resolve(String(target)) === path.resolve(wal.quarantine)) {
              fixtureHit = true
              throw new Error('durable deleting quarantine entry cut')
            }
          }
          return result
        }
      } else {
        fs.promises.lstat = async function (target, ...rest) {
          if (!fixtureHit && fs.existsSync(walFile)) {
            const wal = JSON.parse(fs.readFileSync(walFile, 'utf8'))
            const expectedPhase = mode === 'renamed' ? 'renamed' : 'deleting'
            const expectedVictim = path.join(wal.tombstone, victimRelative)
            if (wal.phase === expectedPhase && path.resolve(String(target)) === path.resolve(expectedVictim)) {
              fixtureHit = true
              throw new Error(`durable ${expectedPhase} purge entry cut`)
            }
          }
          return originalPromisesLstat.call(fs.promises, target, ...rest)
        }
      }
      let interrupted
      try {
        interrupted = await commit()
      } finally {
        fs.renameSync = originalRenameSync
        fs.mkdirSync = originalMkdirSync
        fs.promises.lstat = originalPromisesLstat
      }
      assert.equal(fixtureHit, true, `${mode} did not materialize its durable entry phase`)
      assert.equal(interrupted.ok, false)
      const durableWal = JSON.parse(fs.readFileSync(walFile, 'utf8'))
      const expectedPhase = mode.startsWith('prepared') ? 'prepared' : mode === 'renamed' ? 'renamed' : 'deleting'
      assert.equal(durableWal.phase, expectedPhase)

      let replacementPath
      let replacementKind = 'file'
      if (mode === 'prepared-canonical') {
        replacementPath = victim
      } else if (mode === 'prepared-tombstone' || mode === 'renamed' || mode === 'deleting-live') {
        replacementPath = path.join(durableWal.tombstone, victimRelative)
      } else if (mode === 'deleting-slot') {
        const slot = fs.readdirSync(durableWal.quarantine).find((name) => name.endsWith('.leaf'))
        assert.equal(typeof slot, 'string')
        replacementPath = path.join(durableWal.quarantine, slot)
      } else {
        replacementPath = durableWal.quarantine
        replacementKind = 'directory'
        assert.deepEqual(fs.readdirSync(replacementPath), [])
      }
      assert.equal(fs.existsSync(replacementPath), true)

      const paths = installPathsFor(packageRoot, host)
      const receiptFile = lifecycleRootReceiptPath(host)
      const ownerFile = paths.lifecycleLockPath
      const receiptBefore = fs.readFileSync(receiptFile)
      const ownerBefore = fs.readFileSync(ownerFile)
      const walBefore = fs.readFileSync(walFile)
      const receiptInode = fs.lstatSync(receiptFile).ino
      const ownerInode = fs.lstatSync(ownerFile).ino
      const walInode = fs.lstatSync(walFile).ino
      const parkedPath = path.join(root, `gate-await-original-${mode}`)
      const replacementBytes = replacementKind === 'file' ? fs.readFileSync(replacementPath) : null
      let gateAwaitHit = false
      let replacementInode = null
      const result = await purgeHub(packageRoot, commitFlags, host, {
        checkpoint(name) {
          assert.equal(name, 'after-application-gate-revalidate-before-seal')
          assert.equal(gateAwaitHit, false, `${mode} repeated its initial Application gate checkpoint`)
          assert.equal(JSON.parse(fs.readFileSync(walFile, 'utf8')).phase, expectedPhase)
          assert.equal(fs.lstatSync(receiptFile).ino, receiptInode)
          assert.equal(fs.lstatSync(ownerFile).ino, ownerInode)
          assert.equal(fs.lstatSync(walFile).ino, walInode)
          assert.deepEqual(fs.readFileSync(receiptFile), receiptBefore)
          assert.deepEqual(fs.readFileSync(ownerFile), ownerBefore)
          assert.deepEqual(fs.readFileSync(walFile), walBefore)
          assert.equal(fs.existsSync(path.join(applicationLeaseRoot(dataRoot), 'leases', 'hub-global.lock', 'owner.json')), true)
          gateAwaitHit = true
          originalRenameSync.call(fs, replacementPath, parkedPath)
          if (replacementKind === 'directory') originalMkdirSync.call(fs, replacementPath)
          else fs.writeFileSync(replacementPath, replacementBytes)
          replacementInode = fs.lstatSync(replacementPath).ino
        }
      })
      assert.equal(gateAwaitHit, true, `${mode} did not reach the Application gate renewal await`)
      assert.equal(result.ok, false)
      assert.match(
        result.issues.map((issue) => issue.message).join('\n'),
        /pre-gate metadata freeze|frozen delete metadata|quarantine authority|root shape changed/
      )
      assert.equal(fs.lstatSync(replacementPath).ino, replacementInode)
      assert.equal(fs.existsSync(parkedPath), true)
      if (replacementKind === 'file') {
        assert.deepEqual(fs.readFileSync(replacementPath), replacementBytes)
        assert.deepEqual(fs.readFileSync(parkedPath), replacementBytes)
      }
      assert.equal(fs.lstatSync(receiptFile).ino, receiptInode)
      assert.equal(fs.lstatSync(ownerFile).ino, ownerInode)
      assert.equal(fs.lstatSync(walFile).ino, walInode)
      assert.deepEqual(fs.readFileSync(receiptFile), receiptBefore)
      assert.deepEqual(fs.readFileSync(ownerFile), ownerBefore)
      assert.deepEqual(fs.readFileSync(walFile), walBefore)
      assert.equal(JSON.parse(fs.readFileSync(walFile, 'utf8')).phase, expectedPhase)
      assert.deepEqual(fs.readdirSync(path.join(applicationLeaseRoot(dataRoot), 'leases')), [])
    })
  }
})

test('purge deleting recovery never adopts manifest paths that were absent at its initial freeze', async (t) => {
  for (const mode of ['file', 'directory']) {
    await t.test(mode, async () => {
      const root = temporaryRoot(t, `p4-purge-deleting-absent-${mode}`)
      const packageRoot = path.join(root, 'package')
      const dataRoot = path.join(root, 'data')
      const installDir = path.join(root, 'install')
      seedPackage(packageRoot, '1.0.0', `purge-deleting-absent-${mode}`)
      const { host } = createStatefulHost(root, { dataRoot, installDir, skipPath: true, skipTask: true })
      assert.equal((await setupHub(packageRoot, { ...setupFlags, noPath: true, noTask: true }, host)).ok, true)
      assert.equal((await uninstallHub(packageRoot, host)).ok, true)
      const inbox = path.join(dataRoot, 'skills', 'inbox')
      fs.mkdirSync(inbox, { recursive: true })
      const victimRelative = path.join('skills', 'inbox', 'zzz-live-trigger.txt')
      const victim = path.join(dataRoot, victimRelative)
      fs.writeFileSync(victim, 'live trigger bytes\n')
      const absentRelative = mode === 'file'
        ? path.join('skills', 'inbox', 'aaa-reappeared.txt')
        : path.join('skills', 'inbox', 'aaa-reappeared')
      const absentOriginal = path.join(dataRoot, absentRelative)
      if (mode === 'file') fs.writeFileSync(absentOriginal, 'reappeared file bytes\n')
      else fs.mkdirSync(absentOriginal)
      const absentBytes = mode === 'file' ? fs.readFileSync(absentOriginal) : null
      const dry = await purgeHub(packageRoot, { dataRoot, dryRun: true, commit: false, json: true }, host)
      assert.equal(dry.ok, true, JSON.stringify(dry.issues))
      const commitFlags = {
        dataRoot,
        dryRun: false,
        commit: true,
        planHash: dry.plan.planHash,
        dataRootId: dry.plan.dataRootId,
        json: true
      }
      const commit = () => purgeHub(packageRoot, commitFlags, host)
      const walFile = `${dataRoot}.purge-wal-v1.json`
      const originalPromisesLstat = fs.promises.lstat
      let cut = false
      fs.promises.lstat = async function (target, ...rest) {
        if (!cut && fs.existsSync(walFile)) {
          const wal = JSON.parse(fs.readFileSync(walFile, 'utf8'))
          const expectedVictim = path.join(wal.tombstone, victimRelative)
          if (wal.phase === 'deleting' && path.resolve(String(target)) === path.resolve(expectedVictim)) {
            cut = true
            throw new Error('abrupt cut before partial deleting recovery')
          }
        }
        return originalPromisesLstat.call(fs.promises, target, ...rest)
      }
      let interrupted
      try {
        interrupted = await commit()
      } finally {
        fs.promises.lstat = originalPromisesLstat
      }
      assert.equal(cut, true)
      assert.equal(interrupted.ok, false)
      assert.match(interrupted.issues.map((issue) => issue.message).join('\n'), /abrupt cut before partial deleting recovery/)
      const wal = JSON.parse(fs.readFileSync(walFile, 'utf8'))
      assert.equal(wal.phase, 'deleting')
      const tombstoneVictim = path.join(wal.tombstone, victimRelative)
      const reappeared = path.join(wal.tombstone, absentRelative)
      if (mode === 'file') fs.unlinkSync(reappeared)
      else fs.rmdirSync(reappeared)
      assert.equal(fs.existsSync(reappeared), false)

      let injected = false
      let replacementInode = null
      fs.promises.lstat = async function (target, ...rest) {
        if (!injected && path.resolve(String(target)) === path.resolve(tombstoneVictim)) {
          injected = true
          if (mode === 'file') fs.writeFileSync(reappeared, absentBytes)
          else fs.mkdirSync(reappeared)
          replacementInode = fs.lstatSync(reappeared).ino
        }
        return originalPromisesLstat.call(fs.promises, target, ...rest)
      }
      let result
      try {
        result = await commit()
      } finally {
        fs.promises.lstat = originalPromisesLstat
      }
      assert.equal(injected, true)
      assert.equal(result.ok, false)
      assert.match(
        result.issues.map((issue) => issue.message).join('\n'),
        /directory inventory changed|changed after its initial metadata freeze|still contains live files/
      )
      assert.equal(fs.lstatSync(reappeared).ino, replacementInode)
      if (mode === 'file') assert.deepEqual(fs.readFileSync(reappeared), absentBytes)
      assert.equal(JSON.parse(fs.readFileSync(walFile, 'utf8')).phase, 'deleting')
      assert.deepEqual(fs.readdirSync(path.join(applicationLeaseRoot(dataRoot), 'leases')), [])
    })
  }
})

test('receipt-free purge rejects leaf and ancestor reparses before any lifecycle write', async (t) => {
  const root = temporaryRoot(t, 'p4-purge-no-receipt-reparse')
  const packageRoot = path.join(root, 'missing-package')
  const protectedRoot = path.join(root, 'protected')
  fs.mkdirSync(protectedRoot)
  const sentinel = path.join(protectedRoot, 'sentinel.txt')
  fs.writeFileSync(sentinel, 'protected bytes\n')
  const { host, state } = createStatefulHost(root, {
    dataRoot: path.join(root, 'unused-data'),
    installDir: path.join(root, 'unused-install'),
    skipPath: true,
    skipTask: true
  })
  const makeDirectoryLink = (target, link) => fs.symlinkSync(
    target,
    link,
    process.platform === 'win32' ? 'junction' : 'dir'
  )

  const leaf = path.join(root, 'leaf-data')
  makeDirectoryLink(protectedRoot, leaf)
  const leafResult = await purgeHub(packageRoot, { dataRoot: leaf, dryRun: false, commit: true, json: true }, host)
  assert.equal(leafResult.ok, false)
  assert.match(leafResult.issues[0].message, /data-root inode|reparse|symbolic/)
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'protected bytes\n')
  assert.equal(fs.existsSync(path.join(root, '.skill-graft-lifecycle')), false)
  assert.deepEqual(state.writes, [])

  const alias = path.join(root, 'ancestor-alias')
  const plainParent = path.join(protectedRoot, 'plain-parent')
  fs.mkdirSync(plainParent)
  makeDirectoryLink(protectedRoot, alias)
  for (const suffix of [
    path.join(alias, 'plain-parent', 'missing-data'),
    path.join(alias, 'missing-one', 'missing-two', 'missing-data')
  ]) {
    const result = await purgeHub(packageRoot, { dataRoot: suffix, dryRun: false, commit: true, json: true }, host)
    assert.equal(result.ok, false)
    assert.match(result.issues[0].message, /reparse\/symbolic path component/)
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'protected bytes\n')
    assert.equal(fs.existsSync(path.join(root, '.skill-graft-lifecycle')), false)
    assert.deepEqual(state.writes, [])
  }
})

test('receipt-free purge touches only an already-published exact application lease namespace', async (t) => {
  const root = temporaryRoot(t, 'p4-purge-receipt-free-gate')
  const packageRoot = path.join(root, 'missing-package')
  const dataRoot = path.join(root, 'missing-data')
  const installDir = path.join(root, 'missing-install')
  const { host, state } = createStatefulHost(root, { dataRoot, installDir, skipPath: true, skipTask: true })
  const externalRoot = applicationLeaseRoot(dataRoot)
  const paths = installPathsFor(packageRoot, host)
  const commit = () => purgeHub(packageRoot, { dataRoot, dryRun: false, commit: true, json: true }, host)

  const absent = await commit()
  assert.equal(absent.ok, true, JSON.stringify(absent.issues))
  assert.equal(absent.status, 'already-absent')
  assert.equal(fs.existsSync(externalRoot), false)
  assert.equal(fs.existsSync(lifecycleRootReceiptPath(host)), false)
  assert.deepEqual(state.writes, [])

  for (const [label, residue] of [
    ['valid lifecycle WAL pending', `${paths.lifecycleWalPath}.11111111-1111-4111-8111-111111111111.22222222-2222-4222-8222-222222222222.pending`],
    ['malformed lifecycle WAL sibling', `${paths.lifecycleWalPath}.malformed-residue`],
    ['valid hidden lifecycle WAL stage', path.join(path.dirname(paths.lifecycleWalPath), `.${path.basename(paths.lifecycleWalPath)}.11111111-1111-4111-8111-111111111111.22222222-2222-4222-8222-222222222222.lifecycle-stage`)],
    ['malformed hidden lifecycle WAL stage', path.join(path.dirname(paths.lifecycleWalPath), `.${path.basename(paths.lifecycleWalPath)}.malformed-residue`)],
    ['valid lifecycle owner pending', `${paths.lifecycleLockPath}.33333333-3333-4333-8333-333333333333.owner-pending`],
    ['malformed lifecycle owner sibling', `${paths.lifecycleLockPath}.malformed-residue`]
  ]) {
    fs.writeFileSync(residue, `${label}\n`)
    const residueBefore = treeBytes(root)
    const refused = await commit()
    assert.equal(refused.ok, false, label)
    assert.match(refused.issues.map((issue) => issue.message).join('\n'), /lifecycle or deletion residue/)
    assert.deepEqual(treeBytes(root), residueBefore, `${label} changed during receipt-free refusal`)
    assert.equal(fs.existsSync(externalRoot), false, `${label} bootstrapped an external namespace`)
    const dryRefused = await purgeHub(packageRoot, { dataRoot, dryRun: true, commit: false, json: true }, host)
    assert.equal(dryRefused.ok, false, `${label} was ignored by dry-run`)
    assert.match(dryRefused.issues.map((issue) => issue.message).join('\n'), /lifecycle or deletion residue/)
    assert.deepEqual(treeBytes(root), residueBefore, `${label} changed during receipt-free dry-run refusal`)
    fs.rmSync(residue)
  }

  const documentsDataRoot = path.join(root, 'Documents', 'missing-data')
  fs.mkdirSync(path.dirname(documentsDataRoot), { recursive: true })
  const documentsExternalRoot = applicationLeaseRoot(documentsDataRoot)
  const protectedLiveManager = createLeaseLockManager({ root: documentsExternalRoot, leaseMs: 30_000 })
  const protectedLive = await protectedLiveManager.acquire({
    scope: 'hub-global',
    key: 'hub-global',
    hostId: 'p4-protected-receipt-free-live',
    commandKind: 'migrateState',
    requestId: 'p4-protected-receipt-free-live'
  })
  assert.equal(protectedLive.status, 'acquired')
  const protectedLiveBefore = treeBytes(documentsExternalRoot)
  const protectedLiveResult = await purgeHub(packageRoot, {
    dataRoot: documentsDataRoot, dryRun: false, commit: true, json: true
  }, host)
  assert.equal(protectedLiveResult.ok, false)
  assert.match(protectedLiveResult.issues.map((issue) => issue.message).join('\n'), /overlaps a protected/)
  assert.deepEqual(treeBytes(documentsExternalRoot), protectedLiveBefore)
  await protectedLive.lease.release()

  const programDataRoot = path.join(root, 'ProgramData')
  const programDataDataRoot = path.join(programDataRoot, 'missing-data')
  fs.mkdirSync(programDataRoot)
  state.selection.set('ProgramData', programDataRoot)
  const programDataExternalRoot = applicationLeaseRoot(programDataDataRoot)
  const protectedExpiredNow = Date.now() - 60_000
  const expiredManager = createLeaseLockManager({
    root: programDataExternalRoot,
    leaseMs: 10,
    now: () => protectedExpiredNow,
    pid: 999_997,
    processInspector: {
      async currentIdentity(pid) { return `p4-protected-dead:${pid}` },
      async probe() { return 'dead' }
    }
  })
  const protectedExpired = await expiredManager.acquire({
    scope: 'hub-global',
    key: 'hub-global',
    hostId: 'p4-protected-receipt-free-expired',
    commandKind: 'migrateState',
    requestId: 'p4-protected-receipt-free-expired'
  })
  assert.equal(protectedExpired.status, 'acquired')
  const protectedExpiredBefore = treeBytes(programDataExternalRoot)
  const protectedExpiredResult = await purgeHub(packageRoot, {
    dataRoot: programDataDataRoot, dryRun: false, commit: true, json: true
  }, host)
  assert.equal(protectedExpiredResult.ok, false)
  assert.match(protectedExpiredResult.issues.map((issue) => issue.message).join('\n'), /overlaps a protected/)
  assert.deepEqual(treeBytes(programDataExternalRoot), protectedExpiredBefore)
  await protectedExpired.lease.release()

  fs.mkdirSync(externalRoot)
  const unmarkedBefore = treeBytes(root)
  const unmarked = await commit()
  assert.equal(unmarked.ok, false)
  assert.match(unmarked.issues.map((issue) => issue.message).join('\n'), /already-published application lease namespace/)
  assert.deepEqual(treeBytes(root), unmarkedBefore)
  fs.rmdirSync(externalRoot)

  const liveManager = createLeaseLockManager({ root: externalRoot, leaseMs: 30_000 })
  const live = await liveManager.acquire({
    scope: 'hub-global',
    key: 'hub-global',
    hostId: 'p4-receipt-free-live',
    commandKind: 'migrateState',
    requestId: 'p4-receipt-free-live'
  })
  assert.equal(live.status, 'acquired')
  const liveBefore = treeBytes(externalRoot)
  const busy = await commit()
  assert.equal(busy.ok, false)
  assert.match(busy.issues.map((issue) => issue.message).join('\n'), /application writer gate is busy \(lease-active\)/)
  assert.deepEqual(treeBytes(externalRoot), liveBefore)
  await live.lease.release()
  const settled = await commit()
  assert.equal(settled.ok, true, JSON.stringify(settled.issues))
  assert.equal(settled.status, 'already-absent')
  assert.deepEqual(fs.readdirSync(path.join(externalRoot, 'leases')), [])

  const staleNow = Date.now() - 60_000
  const staleManager = createLeaseLockManager({
    root: externalRoot,
    leaseMs: 1,
    now: () => staleNow,
    pid: 999_999,
    processInspector: {
      async currentIdentity(pid) { return `p4-dead:${pid}` },
      async probe() { return 'dead' }
    }
  })
  const staleLeases = []
  for (const digit of ['1', '2', '3', '4', '5']) {
    const stale = await staleManager.acquire({
      scope: 'worktree',
      key: `sha256:${digit.repeat(64)}`,
      hostId: 'p4-receipt-free-expired',
      commandKind: 'ingest',
      requestId: `p4-receipt-free-expired-${digit}`
    })
    assert.equal(stale.status, 'acquired', JSON.stringify(stale))
    staleLeases.push(stale.lease)
  }
  assert.equal(fs.readdirSync(path.join(externalRoot, 'leases')).length, 5)
  const recovered = await commit()
  assert.equal(
    recovered.ok,
    true,
    JSON.stringify({ issues: recovered.issues, leases: fs.readdirSync(path.join(externalRoot, 'leases')) })
  )
  assert.equal(recovered.status, 'already-absent')
  assert.deepEqual(fs.readdirSync(path.join(externalRoot, 'leases')), [])
  assert.equal(fs.existsSync(lifecycleRootReceiptPath(host)), false)
  assert.deepEqual(state.writes, [])
})

test('a successful purge namespace remains terminal despite later historical install bytes or ambient settings', async (t) => {
  for (const shape of ['regular', 'same-root', 'malformed', 'oversize', 'junction', 'invalid-env']) {
    await t.test(shape, async (t) => {
      const fixture = await createSuccessfulPurge(t, `p4-purge-terminal-install-${shape}`)
      let assertForeignPreserved = () => assert.equal(fs.existsSync(fixture.installDir), false)
      if (shape === 'regular') {
        assertForeignPreserved = createForeignInstallShape(t, fixture.root, fixture.installDir, 'regular')
      } else if (shape === 'junction') {
        const target = temporaryRoot(t, `p4-purge-terminal-junction-target-${shape}`)
        fs.writeFileSync(path.join(target, 'install.json'), fixture.manifestBytes)
        fs.writeFileSync(path.join(target, 'sentinel.txt'), 'terminal foreign junction bytes\n')
        try {
          fs.symlinkSync(target, fixture.installDir, process.platform === 'win32' ? 'junction' : 'dir')
        } catch (error) {
          t.skip(`junction creation is unavailable: ${error.code || error.message}`)
          return
        }
        const linkInode = fs.lstatSync(fixture.installDir).ino
        const linkTarget = fs.readlinkSync(fixture.installDir)
        const targetEvidence = captureDirectoryEvidence(target)
        assertForeignPreserved = () => {
          assert.equal(fs.lstatSync(fixture.installDir).ino, linkInode)
          assert.equal(fs.readlinkSync(fixture.installDir), linkTarget)
          assertDirectoryEvidence(target, targetEvidence, 'terminal foreign junction target')
        }
      } else if (shape !== 'invalid-env') {
        fs.mkdirSync(fixture.installDir)
        const manifestFile = path.join(fixture.installDir, 'install.json')
        if (shape === 'same-root') fs.writeFileSync(manifestFile, fixture.manifestBytes)
        else if (shape === 'malformed') fs.writeFileSync(manifestFile, '{"broken":')
        else fs.writeFileSync(manifestFile, Buffer.alloc(512 * 1024, 0x61))
        fs.writeFileSync(path.join(fixture.installDir, 'sentinel.txt'), `${shape} terminal foreign bytes\n`)
        const foreignEvidence = captureDirectoryEvidence(fixture.installDir)
        assertForeignPreserved = () => assertDirectoryEvidence(
          fixture.installDir,
          foreignEvidence,
          `${shape} terminal foreign install directory`
        )
      }
      fixture.state.selection.set('SG_TASK_NAME', 'invalid/task/name')
      fixture.state.selection.set('HUB_API_PORT', 'not-a-port')
      fixture.state.writes.length = 0
      const externalEvidence = captureDirectoryEvidence(fixture.externalRoot)
      const dry = await purgeHub(fixture.packageRoot, {
        dataRoot: fixture.dataRoot,
        dryRun: true,
        commit: false,
        json: true
      }, fixture.host)
      assert.equal(dry.ok, true, JSON.stringify(dry.issues))
      assert.equal(dry.status, 'already-absent')
      assertDirectoryEvidence(fixture.externalRoot, externalEvidence, `${shape} dry-run external namespace`)
      assertForeignPreserved()

      const committed = await purgeHub(fixture.packageRoot, {
        dataRoot: fixture.dataRoot,
        dryRun: false,
        commit: true,
        json: true
      }, fixture.host)
      assert.equal(committed.ok, true, JSON.stringify(committed.issues))
      assert.equal(committed.status, 'already-absent')
      assertDirectoryEvidence(fixture.externalRoot, externalEvidence, `${shape} commit external namespace`)
      assertForeignPreserved()
      assert.deepEqual(fixture.state.writes, [])
    })
  }
})

test('receipt-free terminal classification keeps live leases read-only and reaps only eligible stale leases', async (t) => {
  await t.test('live', async (t) => {
    const fixture = await createSuccessfulPurge(t, 'p4-purge-terminal-live-later-install')
    fs.mkdirSync(fixture.installDir)
    fs.writeFileSync(path.join(fixture.installDir, 'install.json'), fixture.manifestBytes)
    const foreignEvidence = captureDirectoryEvidence(fixture.installDir)
    fixture.state.selection.set('SG_TASK_NAME', 'invalid/task/name')
    fixture.state.selection.set('HUB_API_PORT', 'not-a-port')
    const manager = createLeaseLockManager({ root: fixture.externalRoot, leaseMs: 30_000 })
    const live = await manager.acquire({
      scope: 'hub-global',
      key: 'hub-global',
      hostId: 'p4-terminal-live',
      commandKind: 'migrateState',
      requestId: 'p4-terminal-live'
    })
    assert.equal(live.status, 'acquired')
    t.after(async () => { try { await live.lease.release() } catch {} })
    const externalEvidence = captureDirectoryEvidence(fixture.externalRoot)
    fixture.state.writes.length = 0
    const dry = await purgeHub(fixture.packageRoot, {
      dataRoot: fixture.dataRoot, dryRun: true, commit: false, json: true
    }, fixture.host)
    assert.equal(dry.ok, false)
    assert.match(dry.issues.map((issue) => issue.message).join('\n'), /requires terminal cleanup/)
    assertDirectoryEvidence(fixture.externalRoot, externalEvidence, 'live terminal dry-run namespace')
    const commit = await purgeHub(fixture.packageRoot, {
      dataRoot: fixture.dataRoot, dryRun: false, commit: true, json: true
    }, fixture.host)
    assert.equal(commit.ok, false)
    assert.match(commit.issues.map((issue) => issue.message).join('\n'), /application writer gate is busy \(lease-active\)/)
    assertDirectoryEvidence(fixture.externalRoot, externalEvidence, 'live terminal commit namespace')
    assertDirectoryEvidence(fixture.installDir, foreignEvidence, 'live terminal foreign install')
    assert.deepEqual(fixture.state.writes, [])
  })

  await t.test('eligible stale', async (t) => {
    const fixture = await createSuccessfulPurge(t, 'p4-purge-terminal-stale-later-install')
    fs.mkdirSync(fixture.installDir)
    fs.writeFileSync(path.join(fixture.installDir, 'install.json'), fixture.manifestBytes)
    const foreignEvidence = captureDirectoryEvidence(fixture.installDir)
    fixture.state.selection.set('SG_TASK_NAME', 'invalid/task/name')
    fixture.state.selection.set('HUB_API_PORT', 'not-a-port')
    const staleNow = Date.now() - 60_000
    const manager = createLeaseLockManager({
      root: fixture.externalRoot,
      leaseMs: 1,
      now: () => staleNow,
      pid: 999_996,
      processInspector: {
        async currentIdentity(pid) { return `p4-terminal-stale:${pid}` },
        async probe() { return 'dead' }
      }
    })
    const stale = await manager.acquire({
      scope: 'worktree',
      key: `sha256:${'9'.repeat(64)}`,
      hostId: 'p4-terminal-stale',
      commandKind: 'ingest',
      requestId: 'p4-terminal-stale'
    })
    assert.equal(stale.status, 'acquired')
    const beforeDry = captureDirectoryEvidence(fixture.externalRoot)
    fixture.state.writes.length = 0
    const dry = await purgeHub(fixture.packageRoot, {
      dataRoot: fixture.dataRoot, dryRun: true, commit: false, json: true
    }, fixture.host)
    assert.equal(dry.ok, false)
    assert.match(dry.issues.map((issue) => issue.message).join('\n'), /requires terminal cleanup/)
    assertDirectoryEvidence(fixture.externalRoot, beforeDry, 'stale terminal dry-run namespace')
    const commit = await purgeHub(fixture.packageRoot, {
      dataRoot: fixture.dataRoot, dryRun: false, commit: true, json: true
    }, fixture.host)
    assert.equal(commit.ok, true, JSON.stringify(commit.issues))
    assert.equal(commit.status, 'already-absent')
    assert.deepEqual(fs.readdirSync(path.join(fixture.externalRoot, 'leases')), [])
    assertDirectoryEvidence(fixture.installDir, foreignEvidence, 'stale terminal foreign install')
    assert.deepEqual(fixture.state.writes, [])
  })
})

test('receipt-free purge with no external namespace still rejects a same-root installed manifest', async (t) => {
  const fixture = await createSuccessfulPurge(t, 'p4-purge-no-external-installed')
  fs.rmSync(fixture.externalRoot, { recursive: true, force: true })
  assert.equal(fs.existsSync(fixture.externalRoot), false)
  fs.mkdirSync(fixture.installDir)
  fs.writeFileSync(path.join(fixture.installDir, 'install.json'), fixture.manifestBytes)
  const before = treeBytes(fixture.root)
  fixture.state.writes.length = 0
  for (const flags of [
    { dataRoot: fixture.dataRoot, dryRun: true, commit: false, json: true },
    { dataRoot: fixture.dataRoot, dryRun: false, commit: true, json: true }
  ]) {
    const result = await purgeHub(fixture.packageRoot, flags, fixture.host)
    assert.equal(result.ok, false)
    assert.match(result.issues.map((issue) => issue.message).join('\n'), /uninstall the active installation before purging/)
    assert.deepEqual(treeBytes(fixture.root), before)
    assert.equal(fs.existsSync(fixture.externalRoot), false)
    assert.deepEqual(fixture.state.writes, [])
  }
})

test('purge refuses hidden ordinary lifecycle WAL stages while an inactive receipt exists', async (t) => {
  const root = temporaryRoot(t, 'p4-purge-hidden-lifecycle-stage')
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  seedPackage(packageRoot, '1.0.0', 'purge-hidden-lifecycle-stage')
  const { host } = createStatefulHost(root, { dataRoot, installDir, skipPath: true, skipTask: true })
  assert.equal((await setupHub(packageRoot, { ...setupFlags, noPath: true, noTask: true }, host)).ok, true)
  assert.equal((await uninstallHub(packageRoot, host)).ok, true)
  const plan = await purgeHub(packageRoot, { dataRoot, dryRun: true, commit: false, json: true }, host)
  assert.equal(plan.ok, true, JSON.stringify(plan.issues))
  const paths = installPathsFor(packageRoot, host)
  const base = `.${path.basename(paths.lifecycleWalPath)}.`
  for (const [label, name] of [
    ['valid', `${base}11111111-1111-4111-8111-111111111111.22222222-2222-4222-8222-222222222222.lifecycle-stage`],
    ['malformed', `${base}malformed-residue`]
  ]) {
    const stage = path.join(path.dirname(paths.lifecycleWalPath), name)
    fs.writeFileSync(stage, `${label} hidden lifecycle stage\n`)
    const before = treeBytes(root)
    const dry = await purgeHub(packageRoot, { dataRoot, dryRun: true, commit: false, json: true }, host)
    assert.equal(dry.ok, false, label)
    assert.match(dry.issues.map((issue) => issue.message).join('\n'), /hidden lifecycle WAL stage/)
    assert.deepEqual(treeBytes(root), before)
    const commit = await purgeHub(packageRoot, {
      dataRoot,
      dryRun: false,
      commit: true,
      planHash: plan.plan.planHash,
      dataRootId: plan.plan.dataRootId,
      json: true
    }, host)
    assert.equal(commit.ok, false, label)
    assert.match(commit.issues.map((issue) => issue.message).join('\n'), /hidden lifecycle WAL stage/)
    assert.deepEqual(treeBytes(root), before)
    assert.deepEqual(fs.readdirSync(path.join(applicationLeaseRoot(dataRoot), 'leases')), [])
    fs.unlinkSync(stage)
  }
})

test('purge remains terminal when a cooperating writer acquires immediately after gate release', async (t) => {
  const root = temporaryRoot(t, 'p4-purge-post-release-contender')
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  seedPackage(packageRoot, '1.0.0', 'purge-post-release-contender')
  const { host } = createStatefulHost(root, { dataRoot, installDir, skipPath: true, skipTask: true })
  assert.equal((await setupHub(packageRoot, { ...setupFlags, noPath: true, noTask: true }, host)).ok, true)
  assert.equal((await uninstallHub(packageRoot, host)).ok, true)
  const dry = await purgeHub(packageRoot, { dataRoot, dryRun: true, commit: false, json: true }, host)
  assert.equal(dry.ok, true, JSON.stringify(dry.issues))
  const externalRoot = applicationLeaseRoot(dataRoot)
  const contenderManager = createLeaseLockManager({ root: externalRoot, leaseMs: 30_000 })
  const originalUnlinkSync = fs.unlinkSync
  let contenderPromise = null
  let releaseCutHit = false
  fs.unlinkSync = function (target, ...rest) {
    const result = originalUnlinkSync.call(fs, target, ...rest)
    const name = path.basename(String(target))
    if (!releaseCutHit && /^\.retire-hub-global\.lock-[0-9a-f]{64}\.claim\.json$/.test(name)) {
      releaseCutHit = true
      contenderPromise = contenderManager.acquire({
        scope: 'hub-global',
        key: 'hub-global',
        hostId: 'p4-post-release-contender',
        commandKind: 'migrateState',
        requestId: 'p4-post-release-contender'
      })
    }
    return result
  }
  let result
  try {
    result = await purgeHub(packageRoot, {
      dataRoot,
      dryRun: false,
      commit: true,
      planHash: dry.plan.planHash,
      dataRootId: dry.plan.dataRootId,
      json: true
    }, host)
  } finally {
    fs.unlinkSync = originalUnlinkSync
  }
  assert.equal(releaseCutHit, true, 'purge did not reach the application gate release cut')
  const contender = await contenderPromise
  assert.equal(contender.status, 'acquired', JSON.stringify(contender))
  assert.equal(result.ok, true, JSON.stringify(result.issues))
  assert.equal(result.status, 'purged')
  assert.equal(inspectLifecycleRootReceipt(host), null)
  const contenderOwner = path.join(externalRoot, 'leases', 'hub-global.lock', 'owner.json')
  assert.equal(fs.existsSync(contenderOwner), true)
  assert.equal(JSON.parse(fs.readFileSync(contenderOwner, 'utf8')).ownerToken, contender.lease.ownerToken)
  await contender.lease.release()
})

test('purge refuses separator-bearing marker IDs without creating a tombstone', async (t) => {
  const root = temporaryRoot(t)
  const packageRoot = path.join(root, 'package')
  const dataRoot = path.join(root, 'data')
  const installDir = path.join(root, 'install')
  seedPackage(packageRoot, '1.0.0')
  const { host } = createStatefulHost(root, { dataRoot, installDir, skipPath: true, skipTask: true })
  assert.equal((await setupHub(packageRoot, { ...setupFlags, noPath: true, noTask: true }, host)).ok, true)
  assert.equal((await uninstallHub(packageRoot, host)).ok, true)
  const markerFile = path.join(dataRoot, '.skill-graft-data-root.json')
  const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'))
  marker.dataRootId = `..${path.sep}escape`
  fs.writeFileSync(markerFile, `${JSON.stringify(marker, null, 2)}\n`)
  const result = await purgeHub(packageRoot, { dataRoot, dryRun: true, commit: false, json: true }, host)
  assert.equal(result.ok, false)
  assert.equal(fs.existsSync(`${dataRoot}.purging-${marker.dataRootId}`), false)
  assert.equal(fs.existsSync(dataRoot), true)
})

test('hook-diagnostic CLI records valid events and emits locator-free fixed refusals', (t) => {
  const root = temporaryRoot(t, 'p4-hook-cli')
  const worktree = path.join(root, 'repo')
  fs.mkdirSync(worktree)
  const isolatedGit = { ...process.env, GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' }
  const initialized = spawnSync('git', ['-C', worktree, 'init', '-q'], { encoding: 'utf8', windowsHide: true, env: isolatedGit })
  assert.equal(initialized.status, 0, initialized.stderr)

  const recorded = spawnSync(process.execPath, [
    cliPath, 'hook-diagnostic', '--worktree', worktree,
    '--hook', 'post-checkout', '--phase', 'command', '--code', 'COMMAND_FAILED', '--exit-code', '7',
    '--request-id', 'p4-hook-cli-record'
  ], { encoding: 'utf8', windowsHide: true, env: isolatedGit })
  assert.equal(recorded.status, 0, recorded.stderr)
  assert.deepEqual(JSON.parse(recorded.stdout), { ok: true, action: 'hook-diagnostic', recorded: true, code: 'COMMAND_FAILED' })
  assert.equal(recorded.stdout.includes(worktree), false)

  const rawLocator = 'F:/raw/path'
  const refused = spawnSync(process.execPath, [
    cliPath, 'hook-diagnostic', '--worktree', worktree,
    '--hook', 'post-checkout', '--phase', 'launch', '--code', rawLocator
  ], { encoding: 'utf8', windowsHide: true, env: isolatedGit })
  assert.notEqual(refused.status, 0)
  assert.deepEqual(JSON.parse(refused.stdout), { ok: false, action: 'hook-diagnostic', recorded: false, code: 'DIAGNOSTIC_REFUSED' })
  assert.equal(refused.stdout.includes(rawLocator), false)
  assert.equal(refused.stdout.includes(worktree), false)
})

test('InstallHost task creation has no force-overwrite path', () => {
  const source = fs.readFileSync(new URL('../src/adapters/install-host.ts', import.meta.url), 'utf8')
  const implementationStart = source.indexOf('registerLogonTask(taskName, vbsPath) {')
  const register = source.slice(implementationStart, source.indexOf('unregisterTask(taskName', implementationStart))
  assert.doesNotMatch(register, /Register-ScheduledTask[^\n]*-Force/)
  assert.doesNotMatch(register, /\['\/Create'[^\]]*'\/F'/)
  assert.match(register, /refusing raced foreign scheduled task/)
})
