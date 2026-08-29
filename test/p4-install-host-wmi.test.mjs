import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const transpiledRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-p4-install-host-'))

function transpile(relativePath) {
  const sourceFile = path.join(repoRoot, 'src', relativePath)
  const targetFile = path.join(transpiledRoot, relativePath).replace(/\.ts$/i, '.js')
  const output = ts.transpileModule(fs.readFileSync(sourceFile, 'utf8'), {
    fileName: sourceFile,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      verbatimModuleSyntax: true
    }
  }).outputText
  fs.mkdirSync(path.dirname(targetFile), { recursive: true })
  fs.writeFileSync(targetFile, output, 'utf8')
}

fs.writeFileSync(path.join(transpiledRoot, 'package.json'), '{"type":"module"}\n', 'utf8')
transpile(path.join('local', 'lifecycle', 'install-domain.ts'))
transpile(path.join('adapters', 'install-host.ts'))
const { createInstallHost } = await import(pathToFileURL(path.join(transpiledRoot, 'adapters', 'install-host.js')).href)

test.after(() => fs.rmSync(transpiledRoot, { recursive: true, force: true }))

function spawnResult(overrides = {}) {
  return {
    error: undefined,
    status: 0,
    signal: null,
    stdout: '4242\r\n',
    stderr: '',
    ...overrides
  }
}

function hostWithResult(result, calls = []) {
  return createInstallHost({ platform: 'win32' }, {
    spawnSync(command, args, options) {
      calls.push({ command, args, options })
      return typeof result === 'function' ? result() : result
    }
  })
}

test('InstallHost wmiCreate uses one bounded non-interactive PowerShell invocation', () => {
  const calls = []
  const host = hostWithResult(spawnResult(), calls)
  const commandLine = '"C:\\Program Files\\nodejs\\node.exe" daemon run'
  const cwd = 'C:\\Skill Graft\\install'

  assert.equal(host.wmiCreate(commandLine, cwd), 4242)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, 'powershell.exe')
  assert.deepEqual(calls[0].args.slice(0, 6), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-Command'
  ])
  assert.match(calls[0].args[6], /Invoke-CimMethod -ClassName Win32_Process -MethodName Create/)
  assert.equal(calls[0].options.encoding, 'utf8')
  assert.equal(calls[0].options.windowsHide, true)
  assert.equal(calls[0].options.timeout, 30_000)
  assert.equal(calls[0].options.env.SG_WMI_CMD, commandLine)
  assert.equal(calls[0].options.env.SG_WMI_CWD, cwd)
})

test('InstallHost wmiCreate fails closed on process and provider failures', () => {
  const timeout = Object.assign(new Error('operation timed out'), { code: 'ETIMEDOUT' })
  assert.throws(
    () => hostWithResult(spawnResult({ error: timeout, status: null, stdout: '' })).wmiCreate('node daemon', 'C:\\hub'),
    /PowerShell launch failed: operation timed out/
  )
  assert.throws(
    () => hostWithResult(spawnResult({ status: null, signal: 'SIGTERM', stdout: '' })).wmiCreate('node daemon', 'C:\\hub'),
    /terminated by signal SIGTERM/
  )
  assert.throws(
    () => hostWithResult(spawnResult({ status: 1, stdout: '', stderr: 'CIM provider access denied' })).wmiCreate('node daemon', 'C:\\hub'),
    /status 1: CIM provider access denied/
  )
  assert.throws(
    () => hostWithResult(spawnResult({ stderr: 'unexpected provider diagnostic' })).wmiCreate('node daemon', 'C:\\hub'),
    /reported stderr: unexpected provider diagnostic/
  )
})

test('InstallHost wmiCreate accepts only one canonical positive safe-integer PID', () => {
  for (const stdout of [
    '',
    '0',
    '-1',
    '+1',
    '01',
    '1.5',
    '123 456',
    '123\n456',
    'pid=123',
    String(Number.MAX_SAFE_INTEGER + 1)
  ]) {
    assert.throws(
      () => hostWithResult(spawnResult({ stdout })).wmiCreate('node daemon', 'C:\\hub'),
      /returned an invalid process id/,
      `stdout ${JSON.stringify(stdout)} must not become a PID`
    )
  }

  assert.equal(hostWithResult(spawnResult({ stdout: '  9876\r\n' })).wmiCreate('node daemon', 'C:\\hub'), 9876)
})

test('InstallHost wmiCreate remains Windows-only before invoking the provider', () => {
  let invoked = false
  const host = createInstallHost({ platform: 'linux' }, {
    spawnSync() {
      invoked = true
      return spawnResult()
    }
  })
  assert.throws(() => host.wmiCreate('node daemon', '/tmp/hub'), /Windows-only/)
  assert.equal(invoked, false)
})

const environmentNames = ['SKILL_GRAFT_HOME', 'HUB_ROOT', 'HUB_API_PORT']

function integrationPayload(overrides = {}) {
  return {
    schemaVersion: 1,
    userPath: { exists: true, value: 'C:\\Skill Graft\\bin;C:\\Windows', kind: 'ExpandString' },
    environment: {
      SKILL_GRAFT_HOME: { exists: true, value: 'C:\\Skill Graft\\data', kind: 'ExpandString' },
      HUB_ROOT: { exists: true, value: 'C:\\Skill Graft\\data', kind: 'String' },
      HUB_API_PORT: { exists: true, value: '18765', kind: 'String' }
    },
    task: { exists: true, action: 'wscript.exe\0"C:\\Skill Graft\\bin\\silent-run.vbs"' },
    ...overrides
  }
}

function hostWithPowerShell(result, calls = []) {
  return createInstallHost({ platform: 'win32' }, {
    runPowerShell(command, extraEnv) {
      calls.push({ command, extraEnv })
      return typeof result === 'function' ? result() : result
    }
  })
}

test('InstallHost integrationSnapshot reads PATH, selected environment, and strict task state once', () => {
  const calls = []
  const payload = integrationPayload()
  const host = hostWithPowerShell({ status: 0, stdout: JSON.stringify(payload), stderr: '' }, calls)

  assert.deepEqual(host.integrationSnapshot(environmentNames, 'Skill Graft Local'), {
    userPath: payload.userPath,
    environment: payload.environment,
    task: payload.task
  })
  assert.equal(calls.length, 1)
  assert.deepEqual(JSON.parse(calls[0].extraEnv.SG_ENV_NAMES_JSON), environmentNames)
  assert.equal(calls[0].extraEnv.SG_TASK_NAME, 'Skill Graft Local')
  assert.match(calls[0].command, /ConvertTo-Json -Compress -Depth 6/)
  assert.match(calls[0].command, /__FOREIGN_TASK_SHAPE__/)
  assert.ok(
    calls[0].command.indexOf('if (-not [string]::IsNullOrEmpty($env:SG_TASK_NAME))')
      < calls[0].command.indexOf('Get-ScheduledTask'),
    'the empty-task guard must precede the scheduled-task provider call'
  )
})

test('InstallHost integrationSnapshot skips task lookup when no task name is requested', () => {
  const calls = []
  const payload = integrationPayload({ task: { exists: false, action: '' } })
  const host = hostWithPowerShell({ status: 0, stdout: JSON.stringify(payload), stderr: '' }, calls)

  assert.deepEqual(host.integrationSnapshot(environmentNames, '').task, { exists: false, action: '' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].extraEnv.SG_TASK_NAME, '')
})

test('InstallHost integrationSnapshot fails closed on provider, JSON, and output-shape failures', () => {
  assert.throws(
    () => hostWithPowerShell({ status: 10, stdout: '', stderr: 'scheduled task provider failed' })
      .integrationSnapshot(environmentNames, 'Skill Graft Local'),
    /scheduled task provider failed/
  )
  assert.throws(
    () => hostWithPowerShell({ status: 0, stdout: JSON.stringify(integrationPayload()), stderr: 'provider warning' })
      .integrationSnapshot(environmentNames, 'Skill Graft Local'),
    /provider warning/
  )
  assert.throws(
    () => hostWithPowerShell({ status: 0, stdout: '{', stderr: '' })
      .integrationSnapshot(environmentNames, 'Skill Graft Local'),
    /invalid JSON/
  )
  assert.throws(
    () => hostWithPowerShell({
      status: 0,
      stdout: JSON.stringify(integrationPayload({
        environment: {
          SKILL_GRAFT_HOME: { exists: true, value: 'data', kind: 'ExpandString' },
          HUB_ROOT: { exists: true, value: 'data', kind: 'String' }
        }
      })),
      stderr: ''
    }).integrationSnapshot(environmentNames, 'Skill Graft Local'),
    /environment shape is invalid/
  )
  assert.throws(
    () => hostWithPowerShell({
      status: 0,
      stdout: JSON.stringify(integrationPayload({ task: { exists: false, action: 'foreign' } })),
      stderr: ''
    }).integrationSnapshot(environmentNames, 'Skill Graft Local'),
    /task shape is invalid/
  )
})

test('InstallHost integrationSnapshot rejects ambiguous request inputs before PowerShell', () => {
  const calls = []
  const host = hostWithPowerShell({ status: 0, stdout: JSON.stringify(integrationPayload()), stderr: '' }, calls)

  assert.throws(() => host.integrationSnapshot(['HUB_ROOT', 'HUB_ROOT'], ''), /environment names are invalid/)
  assert.throws(() => host.integrationSnapshot(environmentNames, 'bad\0task'), /task name is invalid/)
  assert.equal(calls.length, 0)
})

test('InstallHost integrationSnapshot preserves multiple names through the real Windows provider', {
  skip: process.platform !== 'win32'
}, () => {
  const host = createInstallHost({ skipPath: false })
  const names = ['SKILL_GRAFT_HOME', 'HUB_ROOT', 'HUB_API_PORT']
  const snapshot = host.integrationSnapshot(names, '')

  assert.deepEqual(Object.keys(snapshot.environment).sort(), [...names].sort())
  assert.deepEqual(snapshot.userPath, host.userPathState())
  for (const name of names) assert.deepEqual(snapshot.environment[name], host.userEnvState(name))
  assert.deepEqual(snapshot.task, { exists: false, action: '' })
})
