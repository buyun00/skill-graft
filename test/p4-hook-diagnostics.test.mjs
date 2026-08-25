import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import {
  createLocalHookDiagnosticAdapter,
  isLocalHookDiagnosticRecord,
  LOCAL_HOOK_DIAGNOSTIC_GIT_PATH,
  LOCAL_HOOK_DIAGNOSTIC_MAX_RECORDS,
  LOCAL_HOOK_DIAGNOSTIC_MAX_TOTAL_BYTES,
  LOCAL_HOOK_DIAGNOSTIC_SCHEMA,
  LOCAL_HOOK_DIAGNOSTIC_SCHEMA_VERSION
} from '../dist/adapters/local-hook-diagnostics.js'

function git(cwd, args, environment = process.env) {
  const env = Object.fromEntries(Object.entries(environment).filter(([name]) => (
    !name.toUpperCase().startsWith('GIT_')
  )))
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return String(result.stdout || '').trim()
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-hook-diagnostics-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const repository = path.join(root, 'repository')
  fs.mkdirSync(repository, { recursive: true })
  git(repository, ['init', '--quiet'])
  git(repository, ['config', 'user.email', 'hook-diagnostics@example.invalid'])
  git(repository, ['config', 'user.name', 'Hook Diagnostics'])
  fs.writeFileSync(path.join(repository, 'seed.txt'), 'seed\n')
  git(repository, ['add', 'seed.txt'])
  git(repository, ['commit', '--quiet', '-m', 'seed'])
  return { root, repository }
}

function diagnosticsRoot(worktree) {
  return path.resolve(git(worktree, [
    'rev-parse', '--path-format=absolute', '--git-path', LOCAL_HOOK_DIAGNOSTIC_GIT_PATH
  ]))
}

function diagnosticFiles(worktree) {
  const root = diagnosticsRoot(worktree)
  if (!fs.existsSync(root)) return []
  return fs.readdirSync(root)
    .filter((name) => /^diag-[0-9]{13}-[a-f0-9]{16}\.json$/.test(name))
    .sort()
}

test('local hook diagnostics persist only the strict locator-free V1 schema under per-worktree Git admin', (t) => {
  const { root, repository } = fixture(t)
  const requestId = 'hook-post-checkout-request-1'
  const poisoned = {
    ...process.env,
    GIT_DIR: path.join(root, 'poisoned-git-dir'),
    GIT_WORK_TREE: path.join(root, 'poisoned-worktree'),
    GIT_INDEX_FILE: path.join(root, 'poisoned-index')
  }
  const adapter = createLocalHookDiagnosticAdapter({
    environment: poisoned,
    nowIso: () => '2026-08-23T12:34:56.789Z',
    randomBytes: () => Buffer.from('0011223344556677', 'hex')
  })
  const written = adapter.record({
    worktree: repository,
    hook: 'post-checkout',
    phase: 'command',
    code: 'COMMAND_FAILED',
    exitCode: 17,
    requestId
  })

  assert.equal(written.status, 'recorded')
  const rootPath = diagnosticsRoot(repository)
  const expectedAdmin = path.resolve(git(repository, ['rev-parse', '--absolute-git-dir']))
  assert.equal(rootPath, path.join(expectedAdmin, 'skill-graft', 'hook-diagnostics-v1'))
  assert.equal(fs.existsSync(path.join(root, 'poisoned-git-dir')), false)
  assert.deepEqual(diagnosticFiles(repository), ['diag-1787488496789-0011223344556677.json'])

  const raw = fs.readFileSync(path.join(rootPath, diagnosticFiles(repository)[0]), 'utf8')
  const record = JSON.parse(raw)
  assert.equal(isLocalHookDiagnosticRecord(record), true)
  assert.deepEqual(record, {
    schema: LOCAL_HOOK_DIAGNOSTIC_SCHEMA,
    schemaVersion: LOCAL_HOOK_DIAGNOSTIC_SCHEMA_VERSION,
    at: '2026-08-23T12:34:56.789Z',
    hook: 'post-checkout',
    phase: 'command',
    code: 'COMMAND_FAILED',
    exitCode: 17,
    requestIdHash: `sha256:${createHash('sha256').update(requestId).digest('hex')}`
  })
  assert.equal(raw.includes(repository), false)
  assert.equal(raw.includes(root), false)
  assert.equal(raw.includes(requestId), false)
  assert.equal(/(?:[A-Za-z]:[\\/]|\/tmp\/)/.test(raw), false)

  const read = adapter.list(repository)
  assert.equal(read.status, 'ok')
  assert.deepEqual(read.records, [record])
})

test('hook diagnostic CLI stays host-local and emits only a locator-free bounded outcome', (t) => {
  const { root, repository } = fixture(t)
  const cli = path.resolve('dist/control/cli.js')
  const requestId = 'hook-cli-command-failure-1'
  const environment = {
    ...process.env,
    GIT_DIR: path.join(root, 'poisoned-git-dir'),
    GIT_WORK_TREE: path.join(root, 'poisoned-worktree'),
    SKILL_GRAFT_HOME: path.join(root, 'conflicting-data-a'),
    HUB_ROOT: path.join(root, 'conflicting-data-b')
  }
  const run = (extra = []) => spawnSync(process.execPath, [
    cli,
    'hook-diagnostic',
    '--worktree', repository,
    '--hook', 'reference-transaction',
    '--phase', 'command',
    '--code', 'COMMAND_FAILED',
    '--exit-code', '17',
    '--request-id', requestId,
    ...extra
  ], { encoding: 'utf8', windowsHide: true, env: environment })

  const recorded = run()
  assert.equal(recorded.status, 0, recorded.stderr)
  assert.equal(recorded.stderr, '')
  assert.deepEqual(JSON.parse(recorded.stdout), {
    ok: true,
    action: 'hook-diagnostic',
    recorded: true,
    code: 'COMMAND_FAILED'
  })
  assert.equal(recorded.stdout.includes(root), false)
  assert.equal(recorded.stdout.includes(repository), false)
  assert.equal(recorded.stdout.includes(requestId), false)
  assert.equal(fs.existsSync(environment.SKILL_GRAFT_HOME), false)
  assert.equal(fs.existsSync(environment.HUB_ROOT), false)
  const adapter = createLocalHookDiagnosticAdapter()
  const listed = adapter.list(repository)
  assert.equal(listed.status, 'ok')
  assert.equal(listed.records.length, 1)
  assert.equal(listed.records[0].requestIdHash,
    `sha256:${createHash('sha256').update(requestId).digest('hex')}`)

  const diagnostics = diagnosticsRoot(repository)
  const foreign = path.join(diagnostics, 'foreign.bin')
  fs.writeFileSync(foreign, Buffer.alloc(33, 0x41))
  const before = fs.readdirSync(diagnostics).sort()
  const refused = run()
  assert.equal(refused.status, 1, refused.stderr)
  assert.equal(refused.stderr, '')
  assert.deepEqual(JSON.parse(refused.stdout), {
    ok: false,
    action: 'hook-diagnostic',
    recorded: false,
    code: 'COMMAND_FAILED'
  })
  assert.equal(refused.stdout.includes(root), false)
  assert.equal(refused.stdout.includes(repository), false)
  assert.equal(refused.stdout.includes(requestId), false)
  assert.deepEqual(fs.readdirSync(diagnostics).sort(), before)
})

test('local hook diagnostics reject unknown fields and invalid enums before locating Git', (t) => {
  const { repository } = fixture(t)
  const adapter = createLocalHookDiagnosticAdapter()
  assert.deepEqual(adapter.record({
    worktree: repository,
    hook: 'post-checkout',
    phase: 'command',
    code: 'COMMAND_FAILED',
    exitCode: 1,
    requestId: 'hook-valid',
    message: 'must never persist F:/private/worktree'
  }), { status: 'refused', reason: 'invalid-input' })
  assert.deepEqual(adapter.record({
    worktree: repository,
    hook: 'unknown-hook',
    phase: 'launch',
    code: 'CLI_MISSING'
  }), { status: 'refused', reason: 'invalid-input' })
  assert.deepEqual(adapter.record({
    worktree: repository,
    hook: 'reference-transaction',
    phase: 'launch',
    code: 'CLI_MISSING',
    requestId: 'contains a space'
  }), { status: 'refused', reason: 'invalid-input' })
  assert.deepEqual(adapter.record({
    worktree: repository,
    hook: 'reference-transaction',
    phase: 'launch',
    code: 'COMMAND_FAILED',
    exitCode: 17
  }), { status: 'refused', reason: 'invalid-input' })
  assert.deepEqual(adapter.record({
    worktree: repository,
    hook: 'post-checkout',
    phase: 'command',
    code: 'COMMAND_FAILED',
    exitCode: 0
  }), { status: 'refused', reason: 'invalid-input' })
  assert.deepEqual(diagnosticFiles(repository), [])
})

test('local hook diagnostics rotate an exact valid inventory within count and byte bounds', (t) => {
  const { repository } = fixture(t)
  let tick = Date.parse('2026-08-23T00:00:00.000Z')
  let nonce = 0
  const adapter = createLocalHookDiagnosticAdapter({
    nowIso: () => new Date(tick++).toISOString(),
    randomBytes: () => {
      nonce += 1
      return Buffer.from(nonce.toString(16).padStart(16, '0'), 'hex')
    }
  })

  const root = diagnosticsRoot(repository)
  for (let index = 0; index < LOCAL_HOOK_DIAGNOSTIC_MAX_RECORDS + 9; index += 1) {
    const result = adapter.record({
      worktree: repository,
      hook: index % 2 === 0 ? 'post-checkout' : 'reference-transaction',
      phase: 'command',
      code: 'COMMAND_FAILED',
      exitCode: (index % 255) + 1,
      requestId: `hook-rotation-${index}`
    })
    assert.equal(result.status, 'recorded')
  }

  const files = diagnosticFiles(repository)
  assert.equal(files.length, LOCAL_HOOK_DIAGNOSTIC_MAX_RECORDS)
  const totalBytes = files.reduce((total, name) => total + fs.statSync(path.join(root, name)).size, 0)
  assert.ok(totalBytes <= LOCAL_HOOK_DIAGNOSTIC_MAX_TOTAL_BYTES, `${totalBytes} diagnostic bytes`)
  const read = adapter.list(repository)
  assert.equal(read.status, 'ok')
  assert.equal(read.records.length, LOCAL_HOOK_DIAGNOSTIC_MAX_RECORDS)
})

test('local hook diagnostics are isolated by linked-worktree Git admin directories', (t) => {
  const { root, repository } = fixture(t)
  const linked = path.join(root, 'linked worktree')
  git(repository, ['worktree', 'add', '--quiet', '-b', 'hook-diagnostics-linked', linked])
  const adapter = createLocalHookDiagnosticAdapter()

  assert.equal(adapter.record({
    worktree: repository,
    hook: 'post-checkout',
    phase: 'launch',
    code: 'CLI_MISSING'
  }).status, 'recorded')
  assert.equal(adapter.record({
    worktree: linked,
    hook: 'reference-transaction',
    phase: 'launch',
    code: 'NODE_UNAVAILABLE'
  }).status, 'recorded')

  assert.notEqual(diagnosticsRoot(repository), diagnosticsRoot(linked))
  assert.equal(diagnosticFiles(repository).length, 1)
  assert.equal(diagnosticFiles(linked).length, 1)
  assert.equal(adapter.list(repository).records[0].hook, 'post-checkout')
  assert.equal(adapter.list(linked).records[0].hook, 'reference-transaction')
})

for (const corruption of ['unknown-name', 'malformed-owned', 'linked-owned']) {
  test(`local hook diagnostics fail closed on ${corruption} without deleting or publishing`, (t) => {
    const { root, repository } = fixture(t)
    const adapter = createLocalHookDiagnosticAdapter({
      nowIso: () => '2026-08-23T12:34:56.789Z',
      randomBytes: () => Buffer.from('8899aabbccddeeff', 'hex')
    })
    const diagnostics = diagnosticsRoot(repository)
    fs.mkdirSync(diagnostics, { recursive: true })
    let corrupt
    let outside
    if (corruption === 'unknown-name') {
      corrupt = path.join(diagnostics, 'unknown.json')
      fs.writeFileSync(corrupt, '{"schema":"foreign"}\n')
    } else if (corruption === 'malformed-owned') {
      corrupt = path.join(diagnostics, 'diag-1787488496000-0011223344556677.json')
      fs.writeFileSync(corrupt, `${JSON.stringify({
        schema: LOCAL_HOOK_DIAGNOSTIC_SCHEMA,
        schemaVersion: LOCAL_HOOK_DIAGNOSTIC_SCHEMA_VERSION,
        at: '2026-08-23T12:34:56.000Z',
        hook: 'post-checkout',
        phase: 'command',
        code: 'COMMAND_FAILED',
        exitCode: 1,
        requestIdHash: null,
        message: 'forbidden extra field'
      })}\n`)
    } else {
      outside = path.join(root, 'outside-entry')
      fs.mkdirSync(outside)
      corrupt = path.join(diagnostics, 'diag-1787488496000-0011223344556677.json')
      fs.symlinkSync(outside, corrupt, process.platform === 'win32' ? 'junction' : 'dir')
    }
    const before = fs.lstatSync(corrupt)

    assert.deepEqual(adapter.list(repository), {
      status: 'refused',
      reason: 'unsafe-diagnostics-root'
    })
    assert.deepEqual(adapter.record({
      worktree: repository,
      hook: 'post-checkout',
      phase: 'command',
      code: 'COMMAND_FAILED',
      exitCode: 1,
      requestId: 'hook-corrupt-inventory'
    }), { status: 'refused', reason: 'unsafe-diagnostics-root' })
    assert.equal(fs.existsSync(corrupt), true)
    assert.equal(fs.lstatSync(corrupt).isSymbolicLink(), before.isSymbolicLink())
    assert.deepEqual(diagnosticFiles(repository), corruption === 'unknown-name' ? [] : [path.basename(corrupt)])
    assert.equal(fs.existsSync(path.join(diagnostics, 'diag-1787488496789-8899aabbccddeeff.json')), false)
    if (outside) assert.deepEqual(fs.readdirSync(outside), [])
  })
}

test('local hook diagnostics refuse a linked product directory and never write through it', (t) => {
  const { root, repository } = fixture(t)
  const admin = path.resolve(git(repository, ['rev-parse', '--absolute-git-dir']))
  const outside = path.join(root, 'outside')
  fs.mkdirSync(outside)
  fs.symlinkSync(outside, path.join(admin, 'skill-graft'), process.platform === 'win32' ? 'junction' : 'dir')
  const adapter = createLocalHookDiagnosticAdapter()

  assert.deepEqual(adapter.record({
    worktree: repository,
    hook: 'post-checkout',
    phase: 'launch',
    code: 'CLI_MISSING'
  }), { status: 'refused', reason: 'unsafe-git-admin' })
  assert.deepEqual(fs.readdirSync(outside), [])
})
