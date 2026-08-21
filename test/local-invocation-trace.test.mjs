import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  createLocalInvocationTraceAdapter,
  localInvocationEnvironmentIdentity
} from '../dist/adapters/local-invocation-trace.js'

const requestHashDomain = 'skill-graft:invocation-trace:request-id:v1\0'
const environmentIdentityDomain = 'skill-graft:invocation-trace:environment:v1\0'
const environmentIdentityKeys = [
  'PATH',
  'DSH_HOME',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'HUB_SPAWN_CODEX',
  'HUB_ROOT',
  'SKILL_GRAFT_HOME',
  'HUB_API_PORT',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_OPTIONAL_LOCKS'
]

function fixture(t, suffix = '') {
  const container = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-trace-'))
  t.after(() => fs.rmSync(container, { recursive: true, force: true }))
  const runId = `trace-run-${path.basename(container).slice(-6)}${suffix}`
  const runRoot = path.join(container, runId)
  const logsRoot = path.join(runRoot, 'logs')
  const isolatedHome = path.join(runRoot, 'home')
  const appRoot = path.join(runRoot, 'app')
  const packageRoot = path.join(appRoot, 'node_modules', 'ozdqp-skill-hub')
  const handlerFile = path.join(packageRoot, 'dist', 'application', 'hub-application.js')
  const key = Buffer.alloc(32, 0x2a)
  fs.mkdirSync(path.dirname(handlerFile), { recursive: true })
  fs.mkdirSync(logsRoot, { recursive: true })
  fs.mkdirSync(isolatedHome)
  fs.writeFileSync(handlerFile, 'export const handlerIdentity = "application.commandBus"\n')
  fs.writeFileSync(path.join(logsRoot, '.invocation-trace-key'), key, { mode: 0o600 })
  fs.writeFileSync(path.join(runRoot, '.skill-graft-e2e-run.json'), `${JSON.stringify({
    version: 1,
    runId,
    runRoot,
    createdAt: '2026-08-21T00:00:00.000Z'
  })}\n`)
  return {
    appRoot,
    container,
    env: {
      SKILL_GRAFT_INVOCATION_TRACE: '1',
      SKILL_GRAFT_REAL_E2E: '1',
      SKILL_GRAFT_RUN_ID: runId,
      SKILL_GRAFT_E2E_ROOT: runRoot,
      SKILL_GRAFT_INVOCATION_TRACE_PATH: path.join(container, 'must-not-be-used'),
      PATH: path.join(isolatedHome, 'safe-bin'),
      DSH_HOME: path.join(isolatedHome, 'dsh-home'),
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      APPDATA: path.join(isolatedHome, 'appdata'),
      LOCALAPPDATA: path.join(isolatedHome, 'localappdata'),
      TEMP: path.join(isolatedHome, 'temp'),
      TMP: path.join(isolatedHome, 'temp'),
      HUB_SPAWN_CODEX: '0',
      HUB_ROOT: path.join(runRoot, 'hub-data'),
      SKILL_GRAFT_HOME: path.join(runRoot, 'hub-data'),
      HUB_API_PORT: '21990',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_OPTIONAL_LOCKS: '0'
    },
    handlerFile,
    key,
    logsRoot,
    packageRoot,
    runId,
    runRoot
  }
}

function dependencies(value, overrides = {}) {
  return {
    nowIso: () => '2026-08-21T01:02:03.004Z',
    pid: 41001,
    ppid: 41000,
    randomBytes: (size) => Buffer.alloc(size, 0xab),
    ...overrides
  }
}

function createAdapter(value, overrides = {}) {
  return createLocalInvocationTraceAdapter({
    packageRoot: value.packageRoot,
    env: value.env,
    dependencies: dependencies(value),
    ...overrides
  })
}

test('Local invocation trace is inert by default and rejects malformed explicit gates', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-trace-off-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  assert.equal(createLocalInvocationTraceAdapter({ packageRoot: path.join(root, 'missing'), env: {} }), undefined)
  assert.equal(createLocalInvocationTraceAdapter({
    packageRoot: path.join(root, 'missing'),
    env: { SKILL_GRAFT_INVOCATION_TRACE: '0' }
  }), undefined)
  assert.throws(
    () => createLocalInvocationTraceAdapter({
      packageRoot: path.join(root, 'missing'),
      env: { SKILL_GRAFT_INVOCATION_TRACE: 'yes' }
    }),
    /must be 0 or 1/
  )
  assert.throws(
    () => createLocalInvocationTraceAdapter({
      packageRoot: path.join(root, 'missing'),
      env: { SKILL_GRAFT_INVOCATION_TRACE: '1', SKILL_GRAFT_REAL_E2E: '0' }
    }),
    /requires SKILL_GRAFT_REAL_E2E=1/
  )
  assert.deepEqual(fs.readdirSync(root), [])
})

test('Local invocation trace writes only allowlisted HMAC-correlated JSONL under the owned logs root', (t) => {
  const value = fixture(t)
  const adapter = createAdapter(value)
  assert.ok(adapter)
  t.after(() => adapter.close())

  const requestId = `raw-request-${value.runId}`
  const requestHash = adapter.hashRequestId(requestId)
  const expectedHash = createHmac('sha256', value.key)
    .update(requestHashDomain, 'utf8')
    .update(requestId, 'utf8')
    .digest('hex')
  assert.equal(requestHash, `hmac-sha256:v1:${expectedHash}`)
  assert.equal(
    adapter.handlerBuildIdentity,
    `sha256:${createHash('sha256').update(fs.readFileSync(value.handlerFile)).digest('hex')}`
  )
  const expectedEnvironmentIdentity = `sha256:v1:${createHash('sha256')
    .update(environmentIdentityDomain, 'utf8')
    .update(JSON.stringify(environmentIdentityKeys.map((name) => [name, value.env[name] ?? null])), 'utf8')
    .digest('hex')}`
  assert.equal(adapter.environmentIdentity, expectedEnvironmentIdentity)
  assert.equal(localInvocationEnvironmentIdentity(value.env), expectedEnvironmentIdentity)
  assert.equal(adapter.traceRoot, path.join(value.logsRoot, 'invocation-trace'))
  assert.equal(path.dirname(adapter.traceFile), adapter.traceRoot)
  assert.match(path.basename(adapter.traceFile), /^41001-[a-f0-9]{24}\.jsonl$/)
  assert.equal(fs.existsSync(value.env.SKILL_GRAFT_INVOCATION_TRACE_PATH), false)

  adapter.append({
    phase: 'entry',
    sequence: 1,
    transport: 'cli',
    commandKind: 'chat',
    requestHash,
    handlerIdentity: 'application.commandBus',
    requestId,
    sessionId: 'raw-session-secret',
    payload: { intent: 'raw-payload-secret' }
  })
  adapter.append({
    phase: 'result',
    sequence: 1,
    transport: 'untrusted-transport-secret',
    commandKind: 'chat',
    requestHash,
    handlerIdentity: 'application.commandBus',
    ok: true,
    replayed: false,
    error: 'raw-error-secret'
  })
  adapter.close()

  const text = fs.readFileSync(adapter.traceFile, 'utf8')
  const rows = text.trimEnd().split('\n').map((line) => JSON.parse(line))
  assert.equal(rows.length, 2)
  assert.deepEqual(Object.keys(rows[0]).sort(), [
    'adapterIdentity',
    'at',
    'commandKind',
    'environmentIdentity',
    'handlerBuildIdentity',
    'handlerIdentity',
    'phase',
    'pid',
    'ppid',
    'processInstanceId',
    'requestHash',
    'schemaVersion',
    'sequence',
    'transport'
  ].sort())
  assert.deepEqual(Object.keys(rows[1]).sort(), [...Object.keys(rows[0]), 'ok', 'replayed'].sort())
  assert.equal(rows[0].transport, 'cli')
  assert.equal(rows[1].transport, 'other')
  assert.equal(rows[0].requestHash, requestHash)
  assert.equal(rows[0].handlerBuildIdentity, adapter.handlerBuildIdentity)
  assert.equal(rows[0].environmentIdentity, adapter.environmentIdentity)
  assert.match(rows[0].environmentIdentity, /^sha256:v1:[a-f0-9]{64}$/)
  assert.equal(rows[0].processInstanceId, adapter.processInstanceId)
  assert.equal(rows[0].pid, 41001)
  assert.equal(rows[0].ppid, 41000)
  assert.equal(rows[1].ok, true)
  assert.equal(rows[1].replayed, false)
  for (const secret of [
    requestId,
    'raw-session-secret',
    'raw-payload-secret',
    'untrusted-transport-secret',
    'raw-error-secret',
    ...environmentIdentityKeys.map((name) => value.env[name]).filter((item) => String(item || '').length >= 8)
  ]) {
    assert.equal(text.includes(secret), false, `trace must redact ${secret}`)
  }
})

test('Local invocation trace fails closed for an invalid marker, key, or exclusive JSONL claim', (t) => {
  const invalidMarker = fixture(t, '-marker')
  fs.writeFileSync(path.join(invalidMarker.runRoot, '.skill-graft-e2e-run.json'), '{"version":1,"runId":"wrong","runRoot":"wrong"}\n')
  assert.throws(() => createAdapter(invalidMarker), /does not own this run root/)

  const invalidKey = fixture(t, '-key')
  fs.writeFileSync(path.join(invalidKey.logsRoot, '.invocation-trace-key'), Buffer.alloc(31))
  assert.throws(() => createAdapter(invalidKey), /exactly 32 bytes/)

  const collision = fixture(t, '-claim')
  const traceRoot = path.join(collision.logsRoot, 'invocation-trace')
  fs.mkdirSync(traceRoot)
  fs.writeFileSync(path.join(traceRoot, `41001-${'ab'.repeat(12)}.jsonl`), 'owned fixture\n')
  assert.throws(() => createAdapter(collision), (error) => error?.code === 'EEXIST')
})

test('Local invocation trace rejects linked marker-owned paths and linked handler files', (t) => {
  const linkedMarker = fixture(t, '-marker-link')
  const markerFile = path.join(linkedMarker.runRoot, '.skill-graft-e2e-run.json')
  const outsideMarker = path.join(linkedMarker.container, 'outside-marker.json')
  fs.renameSync(markerFile, outsideMarker)
  try {
    fs.symlinkSync(outsideMarker, markerFile, 'file')
  } catch (error) {
    t.skip(`cannot create marker symlink: ${error.code || error.message}`)
    return
  }
  assert.throws(() => createAdapter(linkedMarker), /symlink or junction|crosses a symlink or junction/)

  const linkedLogs = fixture(t, '-logs-link')
  const outsideLogs = path.join(linkedLogs.container, 'outside-logs')
  fs.mkdirSync(outsideLogs)
  fs.rmSync(linkedLogs.logsRoot, { recursive: true })
  try {
    fs.symlinkSync(outsideLogs, linkedLogs.logsRoot, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    t.skip(`cannot create logs junction/symlink: ${error.code || error.message}`)
    return
  }
  assert.throws(() => createAdapter(linkedLogs), /symlink or junction|crosses a symlink or junction/)

  const linkedHandler = fixture(t, '-handler-link')
  const outsideHandler = path.join(linkedHandler.container, 'outside-handler.js')
  fs.writeFileSync(outsideHandler, 'export const outside = true\n')
  fs.rmSync(linkedHandler.handlerFile)
  try {
    fs.symlinkSync(outsideHandler, linkedHandler.handlerFile, 'file')
  } catch (error) {
    t.skip(`cannot create handler symlink: ${error.code || error.message}`)
    return
  }
  assert.throws(() => createAdapter(linkedHandler), /symlink or junction|crosses a symlink or junction/)
})
