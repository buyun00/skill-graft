import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workerFile = path.join(sourceRoot, 'test', 'support', 'p4-lifecycle-upgrade-cut-worker.mjs')

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function samePath(left, right) {
  const first = path.resolve(left)
  const second = path.resolve(right)
  return process.platform === 'win32'
    ? first.toLowerCase() === second.toLowerCase()
    : first === second
}

function collectOutput(stream, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  stream.on('data', (chunk) => {
    if (size >= limit) return
    const kept = Buffer.from(chunk).subarray(0, limit - size)
    chunks.push(kept)
    size += kept.length
  })
  return () => Buffer.concat(chunks, size).toString('utf8')
}

async function stopOwnedChild(child, exited) {
  if (child.exitCode === null && child.signalCode === null) {
    assert.equal(child.kill('SIGKILL'), true, 'parked worker must accept its exact owned kill')
  }
  const stopped = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 5_000)
    exited.then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
  assert.equal(stopped, true, 'parked worker must report exit after its exact owned kill')
}

test('P4 upgrade-cut worker publishes a durable ready marker before the first switched-WAL integration provider', {
  skip: process.platform !== 'win32'
}, async (t) => {
  const preferredRoot = 'E:\\skill-graft-e2e'
  const isolationParent = fs.existsSync(preferredRoot) ? preferredRoot : os.tmpdir()
  const parentStat = fs.lstatSync(isolationParent)
  assert.equal(parentStat.isDirectory() && !parentStat.isSymbolicLink(), true, 'contract isolation parent must be one plain directory')
  assert.equal(samePath(fs.realpathSync.native(isolationParent), isolationParent), true, 'contract isolation parent must not redirect')

  const runId = `p4cut-${randomUUID()}`
  const runRoot = fs.mkdtempSync(path.join(isolationParent, `${runId}-`))
  const packageRoot = path.join(runRoot, 'package')
  const installDir = path.join(runRoot, 'app', 'install')
  const dataRoot = path.join(runRoot, 'hub-data')
  const logsRoot = path.join(runRoot, 'logs')
  const walFile = `${dataRoot}.lifecycle-wal.json`
  const readyFile = path.join(logsRoot, 'upgrade-cut-ready.json')
  const controlModule = path.join(packageRoot, 'dist', 'control', 'install.js')
  const hostModule = path.join(packageRoot, 'dist', 'adapters', 'install-host.js')
  const walId = randomUUID()
  const lockToken = randomUUID()
  let child = null
  let exited = null
  let passed = false

  try {
    for (const directory of [path.dirname(controlModule), path.dirname(hostModule), installDir, dataRoot, logsRoot]) {
      fs.mkdirSync(directory, { recursive: true })
    }
    fs.writeFileSync(path.join(packageRoot, 'package.json'), `${JSON.stringify({ private: true, type: 'module' })}\n`, 'utf8')
    fs.writeFileSync(controlModule, `
      import fs from 'node:fs'

      export async function upgradeHub(_packageRoot, _flags, host) {
        const installDir = process.env.P4_CUT_CONTRACT_INSTALL_DIR
        const dataRoot = process.env.P4_CUT_CONTRACT_DATA_ROOT
        const wal = {
          schemaVersion: 1,
          walId: process.env.P4_CUT_CONTRACT_WAL_ID,
          lockToken: process.env.P4_CUT_CONTRACT_LOCK_TOKEN,
          operation: 'upgrade',
          phase: 'switched',
          installDir
        }
        const descriptor = fs.openSync(\`${'${dataRoot}'}.lifecycle-wal.json\`, 'wx', 0o600)
        try {
          fs.writeFileSync(descriptor, \`${'${JSON.stringify(wal, null, 2)}'}\\n\`, 'utf8')
          fs.fsyncSync(descriptor)
        } finally {
          fs.closeSync(descriptor)
        }
        host.taskExists('SkillGraft-P4-contract')
        throw new Error('taskExists returned instead of reaching the worker cut')
      }
    `, 'utf8')
    fs.writeFileSync(hostModule, `
      import fs from 'node:fs'
      import path from 'node:path'
      import { syncBuiltinESMExports } from 'node:module'

      const readyFile = path.resolve(process.env.P4_CUT_CONTRACT_READY)
      const originalOpenSync = fs.openSync
      const originalFsyncSync = fs.fsyncSync
      const originalCloseSync = fs.closeSync
      const tracked = new Map()
      const samePath = (left, right) => path.resolve(String(left)).toLowerCase() === path.resolve(right).toLowerCase()

      fs.openSync = function(file, flags, ...rest) {
        if (samePath(file, readyFile) && flags !== 'wx') throw new Error('READY_MARKER_WAS_NOT_OPENED_WX')
        const descriptor = originalOpenSync.call(fs, file, flags, ...rest)
        if (samePath(file, readyFile)) tracked.set(descriptor, false)
        return descriptor
      }
      fs.fsyncSync = function(descriptor) {
        const result = originalFsyncSync.call(fs, descriptor)
        if (tracked.has(descriptor)) tracked.set(descriptor, true)
        return result
      }
      fs.closeSync = function(descriptor) {
        const readyFsynced = tracked.get(descriptor)
        const result = originalCloseSync.call(fs, descriptor)
        if (tracked.has(descriptor)) {
          tracked.delete(descriptor)
          if (!readyFsynced) throw new Error('READY_MARKER_WAS_NOT_FSYNCED')
          fs.writeSync(1, 'P4_READY_WX_FSYNC_CLOSE_OK\\n')
        }
        return result
      }
      syncBuiltinESMExports()

      export function createInstallHost() {
        return {
          taskExists() {
            throw new Error('BASE_TASK_EXISTS_SENTINEL')
          }
        }
      }
    `, 'utf8')

    child = spawn(process.execPath, [
      workerFile,
      '--run-id', runId,
      '--run-root', runRoot,
      '--package-root', packageRoot,
      '--install-dir', installDir,
      '--data-root', dataRoot,
      '--wal', walFile,
      '--ready', readyFile
    ], {
      cwd: runRoot,
      env: {
        ...process.env,
        P4_CUT_CONTRACT_INSTALL_DIR: installDir,
        P4_CUT_CONTRACT_DATA_ROOT: dataRoot,
        P4_CUT_CONTRACT_WAL_ID: walId,
        P4_CUT_CONTRACT_LOCK_TOKEN: lockToken,
        P4_CUT_CONTRACT_READY: readyFile
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    const stdout = collectOutput(child.stdout)
    const stderr = collectOutput(child.stderr)
    exited = new Promise((resolve) => child.once('exit', resolve))

    const deadline = Date.now() + 15_000
    while ((!fs.existsSync(readyFile) || !stdout().includes('P4_READY_WX_FSYNC_CLOSE_OK'))
      && child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(child.exitCode, null, `worker exited before ready; stdout=${stdout()}; stderr=${stderr()}; runRoot=${runRoot}`)
    assert.equal(child.signalCode, null, `worker was signalled before ready; stdout=${stdout()}; stderr=${stderr()}; runRoot=${runRoot}`)
    assert.equal(fs.existsSync(readyFile), true, `worker did not publish ready; stdout=${stdout()}; stderr=${stderr()}; runRoot=${runRoot}`)
    assert.match(stdout(), /P4_READY_WX_FSYNC_CLOSE_OK/, `ready did not complete wx/fsync/close; stderr=${stderr()}; runRoot=${runRoot}`)
    assert.doesNotMatch(stderr(), /BASE_TASK_EXISTS_SENTINEL/, 'worker delegated to taskExists before publishing the cut')

    const before = fs.lstatSync(readyFile)
    const readyBytes = fs.readFileSync(readyFile)
    const after = fs.lstatSync(readyFile)
    assert.equal(before.isFile() && !before.isSymbolicLink() && before.nlink === 1, true, 'ready must be one plain file')
    assert.deepEqual(
      [after.dev, after.ino, after.size, after.mtimeMs],
      [before.dev, before.ino, before.size, before.mtimeMs],
      'ready must remain stable while read'
    )
    const ready = JSON.parse(readyBytes.toString('utf8'))
    assert.equal(readyBytes.equals(canonicalBytes(ready)), true, 'ready marker must be canonical JSON')
    const walBytes = fs.readFileSync(walFile)
    assert.deepEqual(ready, {
      schemaVersion: 1,
      runId,
      workerPid: child.pid,
      phase: 'switched',
      walId,
      walBytes: walBytes.length,
      walSha256: `sha256:${createHash('sha256').update(walBytes).digest('hex')}`
    })

    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(child.exitCode, null, 'worker must remain parked after publishing ready')
    assert.equal(child.signalCode, null, 'parked worker must remain unsignalled')
    process.kill(child.pid, 0)
    await stopOwnedChild(child, exited)
    passed = true
  } finally {
    if (!passed) {
      if (child && child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL') } catch { /* best effort for this exact owned child */ }
      }
      if (exited) await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))])
      t.diagnostic(`preserved failed focused run root: ${runRoot}`)
    } else {
      const relative = path.relative(isolationParent, runRoot)
      assert.equal(Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), true)
      assert.equal(path.basename(runRoot).startsWith(`${runId}-`), true)
      fs.rmSync(runRoot, { recursive: true })
    }
  }
})
