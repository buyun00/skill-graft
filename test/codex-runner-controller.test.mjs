import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const controller = path.join(packageRoot, 'runtime', 'codex-runner-controller.ps1')
const emitter = path.join(packageRoot, 'test', 'fixtures', 'p5-runner-emitter.mjs')

function isAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(read, timeoutMs = 15000) {
  const started = Date.now()
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for controller state')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function makeRequest(root, mode) {
  const artifacts = Object.fromEntries([
    'prompt', 'stdout', 'stderr', 'events', 'last', 'cancel', 'status', 'receipt', 'grandchild'
  ].map((name) => [name, path.join(root, name)]))
  fs.writeFileSync(artifacts.prompt, 'controller prompt\n', 'utf8')
  return {
    artifacts,
    value: {
      sessionId: `controller-${mode}`,
      attemptId: 'attempt-1',
      executable: process.execPath,
      arguments: [emitter, mode, artifacts.grandchild, artifacts.last],
      workingDirectory: root,
      promptPath: artifacts.prompt,
      stdoutPath: artifacts.stdout,
      stderrPath: artifacts.stderr,
      eventsPath: artifacts.events,
      lastMessagePath: artifacts.last,
      cancelPath: artifacts.cancel,
      statusPath: artifacts.status,
      receiptPath: artifacts.receipt,
      maximumStdoutBytes: 64 * 1024,
      maximumStderrBytes: 64 * 1024,
      maximumEventsBytes: 64 * 1024
    }
  }
}

test('Codex controller records structured completion and bounded UTF-8 streams', { skip: process.platform !== 'win32' }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-p5-controller-complete-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const request = makeRequest(root, 'complete')
  const requestPath = path.join(root, 'request.json')
  fs.writeFileSync(requestPath, `${JSON.stringify(request.value)}\n`, 'utf8')

  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', controller, '-RequestPath', requestPath
  ], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  assert.equal(result.status, 0, result.stderr || result.stdout)

  const receipt = JSON.parse(fs.readFileSync(request.artifacts.receipt, 'utf8'))
  assert.equal(receipt.state, 'exited')
  assert.equal(receipt.exitCode, 0)
  assert.equal(receipt.threadId, '019cfake0-0000-7000-8000-000000000001')
  assert.equal(receipt.sawTurnCompleted, true)
  assert.equal(receipt.sawTurnFailed, false)
  assert.match(fs.readFileSync(request.artifacts.stderr, 'utf8'), /结构化运行器/)
  assert.match(fs.readFileSync(request.artifacts.stdout, 'utf8'), /thread\.started/)
  assert.equal(fs.readFileSync(request.artifacts.last, 'utf8'), '真实最后消息\n')

  const events = fs.readFileSync(request.artifacts.events, 'utf8').trim().split(/\r?\n/).map(JSON.parse)
  assert.equal(events.some((event) => event.type === 'thread.started'), true)
  assert.equal(events.some((event) => event.type === 'turn.completed'), true)
  const item = events.find((event) => event.type === 'item.started')
  assert.deepEqual({ itemType: item.itemType, itemId: item.itemId }, {
    itemType: 'command_execution',
    itemId: 'item-1'
  })
  assert.equal(JSON.stringify(item).includes('must not enter normalized events'), false)
})

test('Codex controller cancellation terminates the assigned process tree', { skip: process.platform !== 'win32' }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-p5-controller-cancel-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const request = makeRequest(root, 'cancel')
  const requestPath = path.join(root, 'request.json')
  fs.writeFileSync(requestPath, `${JSON.stringify(request.value)}\n`, 'utf8')

  const controllerProcess = spawn('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', controller, '-RequestPath', requestPath
  ], { stdio: 'ignore', windowsHide: true })
  t.after(() => {
    if (isAlive(controllerProcess.pid)) process.kill(controllerProcess.pid)
  })
  const running = await waitFor(() => {
    if (!fs.existsSync(request.artifacts.status) || !fs.existsSync(request.artifacts.grandchild)) return null
    const status = JSON.parse(fs.readFileSync(request.artifacts.status, 'utf8'))
    return status.state === 'running' ? status : null
  })
  const grandchildPid = Number(fs.readFileSync(request.artifacts.grandchild, 'utf8').trim())
  assert.equal(isAlive(running.childPid), true)
  assert.equal(isAlive(grandchildPid), true)

  fs.writeFileSync(request.artifacts.cancel, '{"cancelVersion":1}\n', 'utf8')
  const receipt = await waitFor(() => fs.existsSync(request.artifacts.receipt)
    ? JSON.parse(fs.readFileSync(request.artifacts.receipt, 'utf8'))
    : null)
  assert.equal(receipt.state, 'cancelled')
  assert.equal(receipt.cancellationRequested, true)
  await waitFor(() => !isAlive(running.childPid) && !isAlive(grandchildPid))
})
