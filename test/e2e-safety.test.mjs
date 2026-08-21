import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  ProcessTracker,
  cleanupRunLayout,
  createRunLayout,
  getAvailableLoopbackPort,
  removeOwnedPath,
  validateRealE2eEnvironment
} from './support/real-e2e.mjs'

function makePaths(prefix = 'p0-contract-20260821-000000') {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-e2e-contract-'))
  const root = path.join(parent, prefix)
  return {
    parent,
    runId: prefix,
    root,
    probe: path.join(root, 'probe'),
    hubData: path.join(root, 'hub-data'),
    cli: path.join(root, 'app', 'node_modules', 'ozdqp-skill-hub', 'dist', 'control', 'cli.js')
  }
}

function envFor(paths) {
  return {
    SKILL_GRAFT_REAL_E2E: '1',
    SKILL_GRAFT_RUN_ID: paths.runId,
    SKILL_GRAFT_E2E_ROOT: paths.root,
    SKILL_GRAFT_REAL_PROBE: paths.probe,
    SKILL_GRAFT_HOME: paths.hubData,
    HUB_ROOT: paths.hubData,
    SKILL_GRAFT_CLI: paths.cli
  }
}

function safeOptions(paths, protectedRoots = []) {
  return {
    homeDir: path.join(paths.parent, 'unrelated-home'),
    workspaceRoot: path.join(paths.parent, 'unrelated-workspace'),
    protectedRoots
  }
}

test('real E2E requires an explicit enable flag and run-id-owned paths', (t) => {
  const paths = makePaths()
  t.after(() => fs.rmSync(paths.parent, { recursive: true, force: true }))

  assert.throws(
    () => validateRealE2eEnvironment({ ...envFor(paths), SKILL_GRAFT_REAL_E2E: '0' }, safeOptions(paths)),
    /SKILL_GRAFT_REAL_E2E=1/
  )
  assert.throws(
    () => validateRealE2eEnvironment({ ...envFor(paths), SKILL_GRAFT_RUN_ID: '' }, safeOptions(paths)),
    /SKILL_GRAFT_RUN_ID/
  )
  assert.throws(
    () => validateRealE2eEnvironment({ ...envFor(paths), SKILL_GRAFT_REAL_PROBE: path.join(paths.parent, 'outside') }, safeOptions(paths)),
    /probe.*run root/i
  )

  const context = validateRealE2eEnvironment(envFor(paths), safeOptions(paths))
  assert.equal(context.runId, paths.runId)
  assert.equal(context.runRoot, path.resolve(paths.root))
  assert.equal(context.probeRoot, path.resolve(paths.probe))
  assert.equal(context.hubDataRoot, path.resolve(paths.hubData))
  assert.equal(context.cliPath, path.resolve(paths.cli))
})

test('real E2E rejects the workspace, user home, drive root, and protected live trees', (t) => {
  const paths = makePaths('p0-protected-20260821-000000')
  t.after(() => fs.rmSync(paths.parent, { recursive: true, force: true }))
  const options = {
    workspaceRoot: paths.root,
    homeDir: path.join(paths.parent, 'unrelated-home'),
    protectedRoots: [paths.root]
  }

  assert.throws(() => validateRealE2eEnvironment(envFor(paths), options), /protected/i)

  const homeRunId = 'p0-home-20260821-000000'
  const homeRoot = path.join(os.homedir(), homeRunId)
  const homeRun = {
    ...paths,
    runId: homeRunId,
    root: homeRoot,
    probe: path.join(homeRoot, 'probe'),
    hubData: path.join(homeRoot, 'hub-data'),
    cli: path.join(homeRoot, 'app', 'node_modules', 'ozdqp-skill-hub', 'dist', 'control', 'cli.js')
  }
  assert.throws(() => validateRealE2eEnvironment(envFor(homeRun), { homeDir: os.homedir() }), /user home/i)

  const drive = path.parse(paths.root).root
  const driveRun = { ...paths, root: drive, probe: path.join(drive, 'probe'), hubData: path.join(drive, 'hub-data') }
  assert.throws(() => validateRealE2eEnvironment(envFor(driveRun)), /drive root|run.?id/i)
})

test('real E2E rejects a run root nested in any Git checkout ancestor', (t) => {
  const paths = makePaths('p0-git-tree-20260821-000000')
  t.after(() => fs.rmSync(paths.parent, { recursive: true, force: true }))
  const liveTree = path.join(paths.parent, 'unlisted-live-tree')
  fs.mkdirSync(path.join(liveTree, '.git'), { recursive: true })
  const root = path.join(liveTree, paths.runId)
  const nested = {
    ...paths,
    root,
    probe: path.join(root, 'probe'),
    hubData: path.join(root, 'hub-data'),
    cli: path.join(root, 'app', 'node_modules', 'ozdqp-skill-hub', 'dist', 'control', 'cli.js')
  }

  assert.throws(
    () => validateRealE2eEnvironment(envFor(nested), safeOptions(nested)),
    /inside a Git checkout/i
  )
})

test('run layout only creates and removes marker-owned paths', (t) => {
  const paths = makePaths('p0-layout-20260821-000000')
  t.after(() => fs.rmSync(paths.parent, { recursive: true, force: true }))
  const context = validateRealE2eEnvironment(envFor(paths), safeOptions(paths))
  const layout = createRunLayout(context)

  for (const key of ['appRoot', 'homeRoot', 'hubDataRoot', 'probeRoot', 'logsRoot']) {
    assert.equal(fs.statSync(layout[key]).isDirectory(), true, key)
  }
  assert.equal(fs.existsSync(layout.markerFile), true)

  const scratch = path.join(layout.logsRoot, 'delete-me')
  fs.mkdirSync(scratch)
  removeOwnedPath(context, scratch)
  assert.equal(fs.existsSync(scratch), false)
  assert.throws(() => removeOwnedPath(context, paths.parent), /outside|refusing/i)
  assert.throws(() => removeOwnedPath(context, context.runRoot), /run root/i)

  cleanupRunLayout(context)
  assert.equal(fs.existsSync(context.runRoot), false)
})

test('a probe Junction cannot escape the run root', (t) => {
  const paths = makePaths('p0-reparse-20260821-000000')
  t.after(() => fs.rmSync(paths.parent, { recursive: true, force: true }))
  const context = validateRealE2eEnvironment(envFor(paths), safeOptions(paths))
  createRunLayout(context)
  const outside = path.join(paths.parent, 'protected-live-tree')
  fs.mkdirSync(outside)
  const sentinel = path.join(outside, 'sentinel.txt')
  fs.writeFileSync(sentinel, 'must-survive\n')
  removeOwnedPath(context, context.probeRoot)
  fs.symlinkSync(outside, context.probeRoot, process.platform === 'win32' ? 'junction' : 'dir')

  assert.throws(
    () => validateRealE2eEnvironment(envFor(paths), safeOptions(paths, [outside])),
    /probe.*run root|protected/i
  )
  assert.throws(() => removeOwnedPath(context, context.probeRoot), /outside.*run root/i)
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'must-survive\n')
  cleanupRunLayout(context)
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'must-survive\n')
})

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('random loopback port is reusable after service exit', async () => {
  const port = await getAvailableLoopbackPort()
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535)
  assert.notEqual(port, 18765)
  assert.notEqual(port, 3080)

  const first = net.createServer()
  await listen(first, port)
  await close(first)
  const second = net.createServer()
  await listen(second, port)
  await close(second)
})

test('owned detached PID cleanup terminates a real Node parent and child process tree', { timeout: 20000 }, async (t) => {
  const token = `p0-process-${Date.now().toString(36)}`
  const code = [
    "const { spawn } = require('node:child_process')",
    'const token = process.argv[1]',
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', token + '-child'], { stdio: 'ignore', windowsHide: true })",
    'process.stdout.write(String(child.pid) + "\\n")',
    'setInterval(() => {}, 1000)'
  ].join('; ')
  const parent = spawn(process.execPath, ['-e', code, token], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  const tracker = new ProcessTracker({ runId: token })
  tracker.track(parent)
  tracker.trackPid(parent.pid, { commandIncludes: token })
  t.after(async () => {
    await tracker.stopAll({ graceMs: 100 })
  })
  const childPid = await new Promise((resolve, reject) => {
    let text = ''
    const timer = setTimeout(() => reject(new Error('child PID was not reported')), 5000)
    parent.stdout.on('data', (chunk) => {
      text += chunk.toString('utf8')
      const line = text.split(/\r?\n/)[0].trim()
      if (line) {
        clearTimeout(timer)
        resolve(Number(line))
      }
    })
    parent.once('error', reject)
    parent.once('exit', (codeValue) => {
      if (!text.trim()) reject(new Error(`parent exited before reporting child PID: ${codeValue}`))
    })
  })
  assert.equal(pidAlive(parent.pid), true)
  assert.equal(pidAlive(childPid), true)
  await tracker.stopAll({ graceMs: 250 })
  assert.equal(pidAlive(parent.pid), false)
  assert.equal(pidAlive(childPid), false)
})

test('Windows owned-PID discovery only adopts a run-id and marker-path match', {
  timeout: 20000,
  skip: process.platform !== 'win32'
}, async (t) => {
  const token = `p0-sweep-${Date.now().toString(36)}`
  const markerPath = path.join(os.tmpdir(), token, 'session-owned.last.txt')
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', token, markerPath], {
    stdio: 'ignore',
    windowsHide: true
  })
  const tracker = new ProcessTracker({ runId: token })
  tracker.track(child)
  t.after(async () => tracker.stopAll({ graceMs: 100 }))
  const deadline = Date.now() + 5000
  let adopted = []
  while (adopted.length === 0 && Date.now() < deadline) {
    adopted = tracker.trackWindowsOwnedPids({ commandIncludes: token, pathIncludesAny: [markerPath] })
    if (adopted.length === 0) await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.deepEqual(adopted, [child.pid])
  await tracker.stopAll({ graceMs: 250 })
  assert.equal(pidAlive(child.pid), false)
})
