import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createHub } from '../dist/adapters/create-hub.js'
import { createSessionTask } from '../dist/application/index.js'
import { openLocalHost } from '../dist/local/create-local-host.js'
import { createLocalSessionPort } from '../dist/local/session/local-session-port.js'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fakeCodex = path.join(packageRoot, 'test', 'fixtures', 'p5-fake-codex-cli.mjs')

async function waitFor(read, accept, timeoutMs = 15000) {
  const started = Date.now()
  for (;;) {
    const value = await read()
    if (accept(value)) return value
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for local session')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function task(id, intent) {
  return createSessionTask({
    id,
    kind: 'chat',
    target: { kind: 'hub', id: 'hub' },
    intent
  })
}

test('P5 Local runner uses launcher-pinned paths without explicit composition options', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-p5-local-locator-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const userProfile = path.join(root, 'profile')
  const appData = path.join(userProfile, 'AppData', 'Roaming')
  const codexModule = path.join(appData, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
  const credentialHome = path.join(userProfile, '.codex')
  fs.mkdirSync(path.dirname(codexModule), { recursive: true })
  fs.copyFileSync(fakeCodex, codexModule)
  fs.mkdirSync(credentialHome, { recursive: true })
  fs.writeFileSync(path.join(credentialHome, 'auth.json'), '{"fixture":true}\n', 'utf8')
  let controllerCalls = 0
  let controllerLaunchScript = ''
  const port = createLocalSessionPort(createHub(root), {
    packageRoot,
    environment: {
      APPDATA: appData,
      USERPROFILE: userProfile,
      HUB_CODEX_NODE: process.execPath,
      HUB_CODEX_MODULE: codexModule,
      HUB_CODEX_CREDENTIAL_HOME: credentialHome,
      HUB_SPAWN_CODEX: '1'
    },
    runnerOptions: {
      controllerSpawn(_executable, args) {
        controllerCalls += 1
        controllerLaunchScript = String(args.at(-1) || '')
        return { stdout: '4242\n' }
      }
    }
  })

  const started = await port.start({
    task: task('p5-launcher-pinned-locator', 'launcher-pinned locator'),
    kind: 'chat',
    target: { kind: 'hub', id: 'hub' },
    intent: 'launcher-pinned locator',
    options: { wait: false }
  })

  assert.equal(started.status, 'running', JSON.stringify(started))
  assert.equal(controllerCalls, 1)
  assert.match(controllerLaunchScript, /Start-Process/)
  assert.match(controllerLaunchScript, /-WindowStyle Hidden/)
  assert.doesNotMatch(controllerLaunchScript, /Invoke-CimMethod/)
  const stored = JSON.parse(fs.readFileSync(path.join(root, 'skill-review', 'sessions.json'), 'utf8'))
    .sessions.find((session) => session.id === started.id)
  const request = JSON.parse(fs.readFileSync(stored.runnerArtifacts.requestPath, 'utf8'))
  assert.equal(request.executable, process.execPath)
  assert.equal(request.arguments[0], codexModule)
  assert.equal(fs.existsSync(path.join(stored.runnerArtifacts.codexHome, 'auth.json')), true)
  for (const name of ['APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'TEMP']) {
    assert.equal(fs.statSync(request.environment[name]).isDirectory(), true, `${name} is precreated`)
  }
})

test('P5 Local runner binds tasks and maps real controller start/resume receipts with UTF-8 prompts', { skip: process.platform !== 'win32' }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-p5-local-runner-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const credentials = path.join(root, 'credential-source')
  fs.mkdirSync(credentials, { recursive: true })
  fs.writeFileSync(path.join(credentials, 'auth.json'), '{"fixture":true}\n', 'utf8')
  const port = createLocalSessionPort(createHub(root), {
    packageRoot,
    nodeExecutable: process.execPath,
    codexModule: fakeCodex,
    credentialHome: credentials,
    environment: { ...process.env, HUB_SPAWN_CODEX: '1' },
    runnerOptions: {
      controllerSpawn() {
        const requestPath = fs.readdirSync(root, { recursive: true })
          .map((entry) => path.join(root, String(entry)))
          .find((entry) => entry.endsWith(`${path.sep}request.json`)
            && !fs.existsSync(path.join(path.dirname(entry), 'receipt.json')))
        assert.ok(requestPath, 'prepared controller request')
        const controller = path.join(packageRoot, 'runtime', 'codex-runner-controller.ps1')
        const quote = (value) => String(value).replaceAll("'", "''")
        const result = spawnSync('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-Command',
          `[Threading.Thread]::CurrentThread.CurrentCulture=[Globalization.CultureInfo]::GetCultureInfo('th-TH'); & '${quote(controller)}' -RequestPath '${quote(requestPath)}'`
        ], { encoding: 'utf8', windowsHide: true, timeout: 15000 })
        assert.equal(result.status, 0, result.stderr || result.stdout)
        return { stdout: `${process.pid}\n` }
      }
    },
    waitTimeoutMs: 15000,
    pollMs: 50
  })

  const started = await port.start({
    task: task('p5-start-resume', '请开启中文闲聊：你好，世界！'),
    kind: 'chat',
    target: { kind: 'hub', id: 'hub' },
    intent: '请开启中文闲聊：你好，世界！',
    options: { wait: true }
  })
  assert.equal(started.status, 'completed', JSON.stringify(started))
  assert.equal(started.exitCode, 0)
  assert.match(started.startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  assert.match(started.endedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  assert.equal(new Date(started.startedAt).getUTCFullYear(), new Date().getUTCFullYear())
  assert.equal(started.continuationToken, '019cfake0-0000-7000-8000-000000000001')
  assert.equal(started.events.some((event) => event.type === 'runner.status'), true)
  assert.equal(JSON.stringify(started.events).includes('ignored model text'), false)

  const resumed = await port.resume({
    sessionId: started.id,
    task: task(started.id, '继续中文对话：再见！'),
    message: '继续中文对话：再见！',
    options: { wait: true }
  })
  assert.equal(resumed.status, 'completed', JSON.stringify(resumed))
  assert.notEqual(resumed.attemptId, started.attemptId)
  assert.equal(resumed.revision > started.revision, true)
  assert.equal(fs.existsSync(path.join(root, 'Microsoft')), false, 'PowerShell cache stays inside the isolated home')
})

test('P5 Local cancel remains requested until the runner confirms terminal cancellation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-p5-local-cancel-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let runnerState = 'running'
  let cancelCalls = 0
  const runner = {
    enabled: () => true,
    available: () => true,
    pidAlive: () => true,
    start: ({ attemptId }) => ({
      ok: true,
      value: { runnerId: 'local:fake-cancel', attemptId, state: 'running' }
    }),
    resume: () => ({ ok: false, error: { code: 'RUNNER_INVALID_STATE', retryable: false } }),
    cancel: ({ attemptId }) => {
      cancelCalls += 1
      return {
        ok: true,
        value: { runnerId: 'local:fake-cancel', attemptId, state: 'cancelling' }
      }
    },
    status: ({ attemptId }) => ({
      ok: true,
      value: { runnerId: 'local:fake-cancel', attemptId, state: runnerState }
    }),
    events: ({ afterSequence = 0 }) => ({
      ok: true,
      value: { events: [], nextSequence: afterSequence }
    })
  }
  const port = createLocalSessionPort(createHub(root), {
    packageRoot,
    nodeExecutable: process.execPath,
    codexModule: fakeCodex,
    credentialHome: root,
    runner
  })
  const running = await port.start({
    task: task('p5-cancel', 'CANCEL_BLOCK'),
    kind: 'chat',
    target: { kind: 'hub', id: 'hub' },
    intent: 'CANCEL_BLOCK'
  })
  assert.equal(running.status, 'running')
  const requested = await port.cancel({ sessionId: running.id, reason: 'targeted smoke' })
  assert.equal(requested.cancelRequested, true)
  assert.equal(requested.status, 'running')
  assert.equal(cancelCalls, 1)
  runnerState = 'cancelled'
  const sessionsFile = path.join(root, 'skill-review', 'sessions.json')
  const beforeQuery = fs.readFileSync(sessionsFile, 'utf8')
  assert.equal((await port.get(running.id)).status, 'running')
  assert.equal((await port.list()).find((session) => session.id === running.id)?.status, 'running')
  assert.equal(fs.readFileSync(sessionsFile, 'utf8'), beforeQuery, 'session queries must not refresh durable state')
  const reaped = await port.reap([running.id])
  assert.equal(reaped.length, 1)
  const cancelled = await port.get(running.id)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.capabilities.canCancel, false)
  assert.equal(cancelled.events.some((event) => event.type === 'session.cancel-requested'), true)
})

test('P5 Local Application persists the V2 task and routes typed cancelSession', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-p5-local-application-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const host = await openLocalHost({
    packageRoot,
    dataRoot: root,
    hostId: 'p5-local-test',
    localSessionOptions: {
      nodeExecutable: process.execPath,
      codexModule: fakeCodex,
      credentialHome: root
    }
  })
  const started = await host.application.execute({
    kind: 'chat',
    meta: host.commandMeta('test', 'p5-app-start'),
    intent: 'persist queued task',
    runner: { start: false }
  })
  assert.equal(started.ok, true, JSON.stringify(started))
  assert.equal(started.data.session.status, 'queued')
  assert.equal(started.data.session.steps[0].id, 'respond')

  const cancelled = await host.application.execute({
    kind: 'cancelSession',
    meta: host.commandMeta('test', 'p5-app-cancel'),
    sessionId: started.data.session.id,
    reason: 'typed cancellation'
  })
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled))
  assert.equal(cancelled.data.session.status, 'cancelled')
  assert.equal(cancelled.data.session.cancelRequested, true)
})

test('P5 Local host recovery reaps an active attempt inside the Application transaction', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-p5-local-recovery-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let runnerState = 'running'
  const runner = {
    enabled: () => true,
    available: () => true,
    pidAlive: () => runnerState === 'running',
    start: ({ attemptId }) => ({
      ok: true,
      value: { runnerId: 'local:recovery', attemptId, state: 'running' }
    }),
    resume: () => ({ ok: false, error: { code: 'RUNNER_INVALID_STATE', retryable: false } }),
    cancel: () => ({ ok: false, error: { code: 'RUNNER_INVALID_STATE', retryable: false } }),
    status: ({ attemptId }) => ({
      ok: true,
      value: {
        runnerId: 'local:recovery',
        attemptId,
        state: runnerState,
        ...(runnerState === 'succeeded'
          ? { exitCode: 0, continuationToken: 'thread-recovery', endedAt: new Date().toISOString() }
          : {})
      }
    }),
    events: ({ afterSequence = 0 }) => ({
      ok: true,
      value: { events: [], nextSequence: afterSequence }
    })
  }
  const options = {
    packageRoot,
    dataRoot: root,
    localSessionOptions: {
      nodeExecutable: process.execPath,
      codexModule: fakeCodex,
      credentialHome: root,
      runner
    }
  }
  const first = await openLocalHost({ ...options, hostId: 'p5-recovery-first' })
  const started = await first.application.execute({
    kind: 'chat',
    meta: first.commandMeta('test', 'p5-recovery-start'),
    intent: 'persist active attempt'
  })
  assert.equal(started.ok, true, JSON.stringify(started))
  assert.equal(started.data.session.status, 'running')

  runnerState = 'succeeded'
  const reopened = await openLocalHost({ ...options, hostId: 'p5-recovery-reopened' })
  const recovered = await reopened.application.execute({
    kind: 'getSession',
    meta: reopened.commandMeta('test', 'p5-recovery-show'),
    sessionId: started.data.session.id
  })
  assert.equal(recovered.ok, true, JSON.stringify(recovered))
  assert.equal(recovered.data.session.status, 'completed')
  assert.equal(recovered.data.session.exitCode, 0)
  assert.equal(recovered.data.session.continuationToken, 'thread-recovery')
})
