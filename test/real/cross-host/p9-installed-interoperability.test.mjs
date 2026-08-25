import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL, fileURLToPath } from 'node:url'
import {
  createWindowsBatchInvocation,
  getAvailableLoopbackPort
} from '../../support/real-e2e.mjs'

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const harnessRoot = path.resolve(process.env.SKILL_GRAFT_DSH_SOURCE || 'E:\\deepseek-harness-master')
const e2eBase = path.resolve(process.env.SKILL_GRAFT_P9_E2E_BASE || 'E:\\skill-graft-e2e')
const selectedSkill = 'ozdqp-development'
const leaseMs = 30_000
const profileLeaseMs = 1_000

function comparable(value) {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return Boolean(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
}

function writeText(file, content, options = undefined) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, options || 'utf8')
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function tail(value, limit = 8000) {
  const text = String(value || '')
  return text.length <= limit ? text : text.slice(-limit)
}

function treeManifest(root) {
  if (!fs.existsSync(root)) return []
  const rows = []
  const walk = (absolute, relative) => {
    const stat = fs.lstatSync(absolute)
    const portable = relative.split(path.sep).join('/')
    if (stat.isSymbolicLink()) {
      rows.push({ path: portable, kind: 'link', target: sha256(fs.readlinkSync(absolute)) })
      return
    }
    if (stat.isDirectory()) {
      if (portable) rows.push({ path: portable, kind: 'directory' })
      for (const name of fs.readdirSync(absolute).sort()) {
        walk(path.join(absolute, name), relative ? path.join(relative, name) : name)
      }
      return
    }
    assert.equal(stat.isFile(), true, `unexpected filesystem object under ${root}`)
    const bytes = fs.readFileSync(absolute)
    rows.push({ path: portable, kind: 'file', bytes: bytes.length, sha256: sha256(bytes) })
  }
  walk(root, '')
  return rows
}

function json(result, label) {
  try {
    return JSON.parse(String(result.stdout || ''))
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error instanceof Error ? error.message : error}; ${tail(result.stdout)}`)
  }
}

function checked(result, label) {
  assert.equal(result.error, undefined, `${label} spawn failed: ${result.error?.message || ''}`)
  assert.equal(result.status, 0, `${label} failed: ${tail(result.stderr || result.stdout)}`)
  return result
}

function runNodeScript(script, args, options) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeout || 20 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024
  })
}

function runNpm(args, options) {
  const npmScript = String(process.env.npm_execpath || '')
  if (npmScript && fs.existsSync(npmScript)) return runNodeScript(npmScript, args, options)
  const executable = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  return spawnSync(executable, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    windowsHide: true,
    shell: process.platform === 'win32',
    timeout: options.timeout || 20 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024
  })
}

function commandOnPath(name) {
  if (process.platform !== 'win32') return name
  const result = checked(spawnSync('where.exe', [name], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000
  }), `locate ${name}`)
  const candidates = String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const candidate = candidates.find((entry) => entry.toLowerCase().endsWith('.cmd')) || candidates[0]
  assert.ok(candidate && path.isAbsolute(candidate), `${name} must resolve to an absolute executable`)
  return candidate
}

function batchSync(batchFile, args, options) {
  if (process.platform !== 'win32') {
    return spawnSync(batchFile, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: options.timeout || 20 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024
    })
  }
  const invocation = createWindowsBatchInvocation(batchFile, args)
  return spawnSync(invocation.command, invocation.args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    timeout: options.timeout || 20 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024
  })
}

function batchSpawn(batchFile, args, options) {
  if (process.platform !== 'win32') {
    return spawn(batchFile, args, { ...options, windowsHide: true })
  }
  const invocation = createWindowsBatchInvocation(batchFile, args)
  return spawn(invocation.command, invocation.args, {
    ...options,
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments
  })
}

function git(cwd, args, env, label) {
  return checked(spawnSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024
  }), label).stdout.trim()
}

function gitFingerprint(root, env) {
  if (!fs.existsSync(root)) return null
  const top = spawnSync('git', ['--no-optional-locks', '-C', root, 'rev-parse', '--show-toplevel'], {
    env, encoding: 'utf8', windowsHide: true, timeout: 120_000
  })
  if (top.status !== 0) return null
  return {
    root: comparable(root),
    head: git(root, ['rev-parse', 'HEAD'], env, `fingerprint HEAD ${root}`),
    status: git(root, ['status', '--porcelain=v1', '--untracked-files=normal'], env, `fingerprint status ${root}`)
  }
}

function protectedRoots(env) {
  const roots = new Set([
    sourceRoot,
    harnessRoot,
    'E:\\ozdqp-skill-hub',
    'E:\\ozdqp-main-ntfs',
    'E:\\ozdqp-erhe-activity',
    'F:\\ozdqp-main-view',
    'F:\\ozdqp-ai-testing',
    'E:\\ozdqp-cli-attach-probe'
  ].map(comparable))
  const worktrees = spawnSync('git', ['-C', sourceRoot, 'worktree', 'list', '--porcelain'], {
    env, encoding: 'utf8', windowsHide: true, timeout: 120_000
  })
  if (worktrees.status === 0) {
    for (const line of String(worktrees.stdout || '').split(/\r?\n/)) {
      if (line.startsWith('worktree ')) roots.add(comparable(line.slice('worktree '.length)))
    }
  }
  return [...roots].filter((root) => fs.existsSync(root)).sort()
}

function safeEnvironment(base, root) {
  const env = { ...base }
  for (const name of Object.keys(env)) {
    if (/^(?:SKILL_GRAFT|HUB_|DSH_)/i.test(name)
      || ['NODE_AUTH_TOKEN', 'NPM_TOKEN', 'GITHUB_TOKEN'].includes(name.toUpperCase())) delete env[name]
  }
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
    NO_COLOR: '1',
    npm_config_cache: path.join(root, 'npm-cache'),
    NPM_CONFIG_CACHE: path.join(root, 'npm-cache')
  })
  return env
}

function localEnvironment(base, layout) {
  return {
    ...base,
    HOME: layout.localHome,
    USERPROFILE: layout.localHome,
    APPDATA: path.join(layout.localHome, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(layout.localHome, 'AppData', 'Local'),
    TEMP: layout.temp,
    TMP: layout.temp,
    SKILL_GRAFT_HOME: layout.sharedHub,
    HUB_ROOT: layout.sharedHub,
    HUB_SPAWN_CODEX: '0',
    SG_SKIP_PATH: '1',
    SG_SKIP_TASK: '1'
  }
}

function dshEnvironment(base, layout) {
  return {
    ...base,
    HOME: layout.dshOsHome,
    USERPROFILE: layout.dshOsHome,
    APPDATA: path.join(layout.dshOsHome, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(layout.dshOsHome, 'AppData', 'Local'),
    TEMP: layout.temp,
    TMP: layout.temp,
    DSH_HOME: layout.dshHome,
    SKILL_GRAFT_HOME: layout.sharedHub
  }
}

function createProbe(root, name, env) {
  const worktree = path.join(root, name)
  fs.mkdirSync(path.join(worktree, 'baloot_client'), { recursive: true })
  writeText(path.join(worktree, 'README.md'), `# P9 ${name}\n`)
  writeText(path.join(worktree, 'AGENTS.md'), `# P9 ${name} recognition\n`)
  writeText(path.join(worktree, 'baloot_client', 'README.md'), '# recognition marker\n')
  writeText(path.join(worktree, 'probe-sentinel.bin'), Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x80]))
  git(worktree, ['init'], env, `${name} git init`)
  git(worktree, ['config', 'user.name', 'Skill Graft P9'], env, `${name} git user`)
  git(worktree, ['config', 'user.email', 'skill-graft-p9@example.invalid'], env, `${name} git email`)
  git(worktree, ['config', 'extensions.worktreeConfig', 'true'], env, `${name} worktree config`)
  git(worktree, ['add', '.'], env, `${name} git add`)
  git(worktree, ['commit', '-m', `P9 ${name} fixture`], env, `${name} git commit`)
  return worktree
}

function seedLegacyHub(dataRoot, sharedProbe) {
  writeText(path.join(dataRoot, 'AGENTS.override.md'), '# P9 shared authority A\n')
  writeText(path.join(dataRoot, 'skills', selectedSkill, 'SKILL.md'), [
    '---',
    `name: ${selectedSkill}`,
    'description: P9 isolated real gate',
    '---',
    '# P9 Skill A',
    ''
  ].join('\n'))
  writeText(path.join(dataRoot, 'skills', selectedSkill, 'tracked.txt'), 'p9-snapshot-a\n')
  writeText(path.join(dataRoot, 'overlay', 'attached-worktrees.txt'), `${sharedProbe}\n`)
  writeText(path.join(dataRoot, 'overlay', 'scan-roots.txt'), '')
  writeText(path.join(dataRoot, 'overlay', 'do-not-auto-attach.txt'), '')
  writeText(path.join(dataRoot, 'skill-review', 'state.json'), `${JSON.stringify({
    version: 1,
    stateRevision: 1,
    items: [],
    lastIngest: null
  }, null, 2)}\n`)
}

function installedCli(cliPath, env, args, requestId, expectedOk = true) {
  const result = batchSync(cliPath, [...args, '--contract-v1', '--request-id', requestId], {
    cwd: path.dirname(path.dirname(cliPath)), env, timeout: 180_000
  })
  assert.equal(result.error, undefined, `${requestId} CLI spawn failed`)
  assert.equal(expectedOk ? result.status === 0 : result.status !== 0, true, `${requestId}: ${tail(result.stderr || result.stdout)}`)
  const envelope = json(result, requestId)
  assert.equal(envelope.contractVersion, 1, `${requestId} contract version`)
  assert.equal(envelope.requestId, requestId, `${requestId} request id`)
  assert.equal(envelope.ok, expectedOk, `${requestId}: ${JSON.stringify(envelope.error || {})}`)
  assert.equal(envelope.meta?.handler, 'application.commandBus', `${requestId} handler`)
  return envelope
}

async function hostCommand(host, kind, payload, requestId, expectedOk = true) {
  const envelope = await host.application.execute({
    kind,
    ...payload,
    meta: host.commandMeta('p9-installed-fixture', requestId)
  })
  assert.equal(envelope.contractVersion, 1)
  assert.equal(envelope.requestId, requestId)
  assert.equal(envelope.ok, expectedOk, `${requestId}: ${JSON.stringify(envelope.error || {})}`)
  assert.equal(envelope.meta?.handler, 'application.commandBus')
  return envelope
}

async function waitForTcp(port, child) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (child.exitCode != null || child.signalCode != null) throw new Error('DSH profile exited before listening')
    const connected = await new Promise((resolve) => {
      const socket = net.createConnection({ host: '127.0.0.1', port })
      socket.setTimeout(250)
      socket.once('connect', () => { socket.destroy(); resolve(true) })
      socket.once('timeout', () => { socket.destroy(); resolve(false) })
      socket.once('error', () => resolve(false))
    })
    if (connected) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('DSH profile did not open its selected loopback port')
}

async function waitForHttpReady(port, child) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (child.exitCode != null || child.signalCode != null) throw new Error('DSH profile exited before Web readiness')
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(1000)
      })
      if (response.status === 200 && (await response.text()).length > 0) return
    } catch {
      // Web readiness polling is not an Application/RPC retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('DSH profile did not reach Web readiness')
}

function listeners(port) {
  if (process.platform !== 'win32') return []
  const result = checked(spawnSync('netstat.exe', ['-ano', '-p', 'tcp'], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000
  }), 'netstat listeners')
  return String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter((line) => {
    const fields = line.split(/\s+/)
    return fields.length >= 5 && fields[1].endsWith(`:${port}`) && fields[3].toUpperCase() === 'LISTENING'
  }).map((line) => Number(line.split(/\s+/).at(-1))).filter(Number.isSafeInteger).sort((a, b) => a - b)
}

function windowsProcess(pid) {
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter \"ProcessId = ${Number(pid)}\" -ErrorAction SilentlyContinue`,
    'if ($null -eq $p) { exit 3 }',
    '$p | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'
  ].join('; ')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000
  })
  if (result.status === 3 || !String(result.stdout || '').trim()) return null
  assert.equal(result.status, 0, `inspect process ${pid}: ${result.stderr || result.stdout}`)
  return JSON.parse(result.stdout)
}

async function stopOwnedTree(child, runId) {
  if (child.exitCode != null || child.signalCode != null) return
  if (process.platform === 'win32') {
    const current = windowsProcess(child.pid)
    assert.ok(current, 'owned DSH wrapper process must still exist before stop')
    assert.equal(String(current.CommandLine || '').toLowerCase().includes(runId.toLowerCase()), true,
      'refusing to terminate a process without the P9 run-id')
    const stopped = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      encoding: 'utf8', windowsHide: true, timeout: 30_000
    })
    assert.equal(stopped.status, 0, `stop owned DSH profile: ${stopped.stderr || stopped.stdout}`)
  } else {
    child.kill('SIGTERM')
  }
  const deadline = Date.now() + 30_000
  while (child.exitCode == null && child.signalCode == null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.equal(child.exitCode != null || child.signalCode != null, true, 'owned DSH profile must exit')
}

function runOwnedProcesses(runId) {
  if (process.platform !== 'win32') return []
  const escaped = runId.replaceAll("'", "''")
  const script = [
    "$rows = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -in @('node.exe','cmd.exe','dsh.exe','pnpm.exe') }",
    `$rows | Where-Object { [string]$_.CommandLine -like '*${escaped}*' } | Select-Object ProcessId,Name | ConvertTo-Json -Compress`
  ].join('; ')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000
  })
  assert.equal(result.status, 0, `enumerate run-owned processes: ${result.stderr || result.stdout}`)
  const output = String(result.stdout || '').trim()
  if (!output) return []
  const parsed = JSON.parse(output)
  return Array.isArray(parsed) ? parsed : [parsed]
}

function assertSessionProjection(session, worktree) {
  for (const key of ['id', 'kind', 'status', 'target', 'steps', 'events']) assert.equal(key in session, true, `session has ${key}`)
  const publicJson = JSON.stringify(session).toLowerCase()
  assert.equal(publicJson.includes(comparable(worktree).replaceAll('\\', '\\\\')), false, 'session hides worktree locator')
  assert.equal(/\"(?:pid|argv|ownerToken)\"/i.test(publicJson), false, 'session hides host-private process/lock data')
}

class SuccessfulLocalRunner {
  constructor() {
    this.runs = new Map()
  }

  enabled() { return true }
  available() { return true }
  pidAlive(pid) { return pid === process.pid }

  start(input) {
    const runnerId = `p9-local:${input.attemptId}`
    const startedAt = new Date().toISOString()
    this.runs.set(runnerId, {
      attemptId: input.attemptId,
      startedAt,
      endedAt: new Date(Date.now() + 1).toISOString()
    })
    return {
      ok: true,
      value: {
        runnerId,
        attemptId: input.attemptId,
        state: 'running',
        continuationToken: runnerId,
        startedAt
      }
    }
  }

  resume(input) { return this.start(input) }

  status(input) {
    const run = this.runs.get(input.runnerId)
    if (!run || run.attemptId !== input.attemptId) {
      return { ok: false, error: { code: 'RUNNER_NOT_FOUND', retryable: false } }
    }
    return {
      ok: true,
      value: {
        runnerId: input.runnerId,
        attemptId: input.attemptId,
        state: 'succeeded',
        continuationToken: input.runnerId,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        exitCode: 0
      }
    }
  }

  events(input) {
    const status = this.status(input)
    if (!status.ok) return status
    const sequence = 1
    return {
      ok: true,
      value: {
        events: (input.afterSequence || 0) < sequence
          ? [{ sequence, attemptId: input.attemptId, type: 'runner.succeeded', at: status.value.endedAt }]
          : [],
        nextSequence: sequence
      }
    }
  }

  cancel(input) { return this.status(input) }
}

class SuccessfulDshDriver {
  constructor() {
    this.runs = new Map()
  }

  available() { return true }

  start(input) {
    const outcome = { state: 'succeeded', endedAt: new Date().toISOString(), exitCode: 0 }
    const run = { outcome, result: Promise.resolve(outcome) }
    this.runs.set(input.runnerId, run)
    return {
      runnerId: input.runnerId,
      continuationToken: input.runnerId,
      startedAt: new Date().toISOString(),
      result: run.result
    }
  }

  resume(input) { return this.start(input) }
  async status(runnerId) { return this.runs.get(runnerId)?.outcome || { state: 'not-found' } }
  async cancel(runnerId) { return this.runs.get(runnerId)?.outcome || { state: 'not-found' } }
  async dispose() {}
}

test('P9 installed Local and installed-artifact DSH composition share state on host-owned probes', {
  timeout: 35 * 60 * 1000
}, async () => {
  assert.equal(process.platform, 'win32', 'P9 installed interoperability gate is currently a native Windows gate')
  assert.equal(fs.existsSync(harnessRoot), true, 'DeepSeek Harness source checkout is required')
  assert.equal(fs.existsSync(path.join(sourceRoot, 'dist', 'control', 'cli.js')), true,
    'P9 gate consumes a prebuilt Local release without writing the protected source tree')
  assert.equal(fs.existsSync(path.join(sourceRoot, '.artifacts-local', 'dsh-package', 'package.json')), true,
    'P9 gate consumes a prebuilt DSH package stage without writing the protected source tree')
  assert.equal(fs.existsSync(path.join(harnessRoot, 'apps', 'cli', 'src', 'bin.ts')), true,
    'P9 gate consumes the existing Harness checkout as a read-only prerequisite')
  const runId = `p9-${randomUUID()}`
  const runRoot = path.join(e2eBase, runId)
  assert.equal(path.basename(runRoot), runId)
  assert.notEqual(comparable(runRoot), comparable(path.parse(runRoot).root))
  assert.equal(fs.existsSync(runRoot), false, 'P9 run root must be fresh')
  for (const protectedRoot of protectedRoots(process.env)) {
    assert.equal(isInside(protectedRoot, runRoot) || isInside(runRoot, protectedRoot) || comparable(protectedRoot) === comparable(runRoot), false,
      `run root must not overlap protected root ${protectedRoot}`)
  }

  const layout = {
    runId,
    runRoot,
    packages: path.join(runRoot, 'packages'),
    localApp: path.join(runRoot, 'local-app'),
    localHome: path.join(runRoot, 'local-home'),
    dshOsHome: path.join(runRoot, 'dsh-os-home'),
    dshHome: path.join(runRoot, 'dsh-home'),
    sharedHub: path.join(runRoot, 'dsh-home', 'skill-graft'),
    probes: path.join(runRoot, 'probes'),
    temp: path.join(runRoot, 'temp'),
    logs: path.join(runRoot, 'logs')
  }
  fs.mkdirSync(runRoot, { recursive: true })
  writeText(path.join(runRoot, '.skill-graft-p9-run.json'), `${JSON.stringify({
    schemaVersion: 1,
    runId,
    runRoot,
    createdAt: new Date().toISOString()
  }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  for (const directory of Object.values(layout).filter((value) => typeof value === 'string' && value !== runId && value !== runRoot)) {
    assert.equal(isInside(runRoot, directory), true, `${directory} stays within the P9 run root`)
    fs.mkdirSync(directory, { recursive: true })
  }
  assert.notEqual(comparable(layout.localHome), comparable(layout.dshHome))
  assert.equal(isInside(layout.dshHome, layout.sharedHub), true)

  const baseEnv = safeEnvironment(process.env, runRoot)
  const localEnv = localEnvironment(baseEnv, layout)
  const dshEnv = dshEnvironment(baseEnv, layout)
  for (const directory of [
    localEnv.APPDATA, localEnv.LOCALAPPDATA, layout.temp,
    dshEnv.APPDATA, dshEnv.LOCALAPPDATA, path.join(runRoot, 'npm-cache')
  ]) fs.mkdirSync(directory, { recursive: true })
  writeText(path.join(layout.localHome, '.npmrc'), '')
  writeText(path.join(layout.dshOsHome, '.npmrc'), '')

  const roots = protectedRoots(baseEnv)
  const protectedBefore = roots.map((root) => gitFingerprint(root, baseEnv)).filter(Boolean)
  const listener18765Before = listeners(18765)
  assert.deepEqual(runOwnedProcesses(runId), [], 'no process from this fresh P9 run-id may pre-exist')

  const localPackRows = json(checked(runNpm([
    'pack', '--json', '--ignore-scripts', '--pack-destination', layout.packages
  ], { cwd: sourceRoot, env: localEnv }), 'Local npm pack'), 'Local npm pack')
  assert.equal(localPackRows.length, 1)
  const localTarball = path.resolve(layout.packages, localPackRows[0].filename)
  assert.equal(isInside(runRoot, localTarball), true)
  checked(runNpm([
    'install', '--prefix', layout.localApp, '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', localTarball
  ], { cwd: layout.localApp, env: localEnv }), 'install Local tarball')
  const localPackageRoot = path.join(layout.localApp, 'node_modules', 'ozdqp-skill-hub')
  const localCli = path.join(layout.localApp, 'node_modules', '.bin', 'sg.cmd')
  assert.equal(fs.existsSync(localCli), true, 'installed Local CLI shim exists')
  assert.equal(fs.existsSync(path.join(localPackageRoot, 'src')), false, 'installed Local has no source tree')
  assert.equal(isInside(sourceRoot, localCli), false, 'Local gate never invokes the development-tree CLI')

  const dshStage = path.join(sourceRoot, '.artifacts-local', 'dsh-package')
  const dshPackRows = json(checked(runNpm([
    'pack', '--json', '--ignore-scripts', '--pack-destination', layout.packages
  ], { cwd: dshStage, env: dshEnv }), 'DSH npm pack'), 'DSH npm pack')
  assert.equal(dshPackRows.length, 1)
  const dshTarball = path.resolve(layout.packages, dshPackRows[0].filename)
  assert.equal(isInside(runRoot, dshTarball), true)
  const pnpm = commandOnPath('pnpm')
  checked(batchSync(pnpm, ['run', 'dsh', 'plugin', '--profile', 'web', 'add', dshTarball], {
    cwd: harnessRoot, env: dshEnv, timeout: 20 * 60 * 1000
  }), 'install DSH tarball into isolated profile')
  const dump = checked(batchSync(pnpm, ['run', 'dsh', '--profile', 'web', '--dump-config'], {
    cwd: harnessRoot, env: dshEnv, timeout: 5 * 60 * 1000
  }), 'dump isolated DSH profile')
  assert.match(dump.stdout, /@ozdqp\/skill-graft-dsh/)
  assert.match(dump.stdout, /connection/)
  writeText(path.join(layout.logs, 'dsh-dump-config.log'), tail(dump.stdout, 64 * 1024))
  const dshPackageLink = path.join(layout.dshHome, 'profiles', 'web', 'node_modules', '@ozdqp', 'skill-graft-dsh')
  assert.equal(fs.existsSync(dshPackageLink), true, 'installed DSH profile package exists')
  const dshPackageRoot = fs.realpathSync.native(dshPackageLink)
  assert.equal(isInside(layout.dshHome, dshPackageRoot), true, 'DSH package resolves inside isolated DSH_HOME')
  assert.equal(fs.existsSync(path.join(dshPackageRoot, 'src')), false, 'installed DSH has no source tree')

  const localProbe = createProbe(layout.probes, 'local-owned', localEnv)
  const dshProbe = createProbe(layout.probes, 'dsh-owned', localEnv)
  const sharedProbe = createProbe(layout.probes, 'shared-state-only', localEnv)
  const sharedProbeBaseline = treeManifest(sharedProbe)
  seedLegacyHub(layout.sharedHub, sharedProbe)

  const snapshotRequestId = `p9-shared-snapshot-${runId}`
  const snapshotAEnvelope = installedCli(localCli, localEnv, ['snapshot', 'create'], snapshotRequestId)
  const snapshotA = snapshotAEnvelope.data.snapshot
  const migratePlan = installedCli(localCli, localEnv, ['migrate-state', '--dry-run'], `p9-migrate-plan-${runId}`)
  const migrated = installedCli(localCli, localEnv, [
    'migrate-state', '--commit', '--plan-hash', migratePlan.data.plan.planHash
  ], `p9-migrate-commit-${runId}`)
  assert.equal(migrated.data.state.schemaVersion, 2)
  const sharedPin = installedCli(localCli, localEnv, [
    'pin', 'show', '--worktree', sharedProbe
  ], `p9-shared-pin-initial-${runId}`)
  assert.equal(sharedPin.data.pin.claimState, 'claimed', 'migration claims only the shared state-only probe')

  const localModules = {
    ...(await import(pathToFileURL(path.join(localPackageRoot, 'dist', 'local', 'create-local-host.js')).href)),
    dshHost: await import(pathToFileURL(path.join(localPackageRoot, 'dist', 'dsh', 'create-dsh-host.js')).href),
    dshRuntime: await import(pathToFileURL(path.join(localPackageRoot, 'dist', 'dsh', 'session-runtime.js')).href)
  }
  const localRunner = new SuccessfulLocalRunner()
  const localFixtureHost = localModules.createLocalHost({
    packageRoot: localPackageRoot,
    dataRoot: layout.sharedHub,
    hostId: 'local-p9-session-fixture',
    localSessionOptions: { runner: localRunner },
    leaseMs
  })
  await localFixtureHost.ready()
  const localStarted = await hostCommand(localFixtureHost, 'attach', {
    worktree: localProbe,
    intent: 'P9 Local installed materialization authorization',
    runner: { start: true, wait: false }
  }, `p9-local-session-start-${runId}`)
  assert.equal(localStarted.data.session.status, 'running')
  const localSessionId = localStarted.data.session.id
  await hostCommand(localFixtureHost, 'reapSessions', { sessionIds: [localSessionId] }, `p9-local-session-reap-${runId}`)
  const localAwaiting = await hostCommand(localFixtureHost, 'getSession', { sessionId: localSessionId }, `p9-local-session-awaiting-${runId}`)
  assert.equal(localAwaiting.data.session.status, 'awaiting')
  installedCli(localCli, localEnv, [
    'claim', '--worktree', localProbe,
    '--snapshot', snapshotA.snapshotId,
    '--session-id', localSessionId,
    '--skill', selectedSkill
  ], `p9-local-claim-${runId}`)

  const dshDriver = new SuccessfulDshDriver()
  const dshFixtureHost = await localModules.dshHost.openDshHost({
    packageRoot: dshPackageRoot,
    dataRoot: layout.sharedHub,
    hostId: 'dsh-p9-session-fixture',
    leaseMs,
    createSessionRuntime: (context) => localModules.dshRuntime.createDshSessionRuntime(context, dshDriver)
  })
  const dshStarted = await hostCommand(dshFixtureHost, 'attach', {
    worktree: dshProbe,
    intent: 'P9 DSH installed materialization authorization',
    runner: { start: true, wait: false }
  }, `p9-dsh-session-start-${runId}`)
  assert.equal(dshStarted.data.session.status, 'running')
  const dshSessionId = dshStarted.data.session.id
  await new Promise((resolve) => setImmediate(resolve))
  await hostCommand(dshFixtureHost, 'reapSessions', { sessionIds: [dshSessionId] }, `p9-dsh-session-reap-${runId}`)
  const dshAwaiting = await hostCommand(dshFixtureHost, 'getSession', { sessionId: dshSessionId }, `p9-dsh-session-awaiting-${runId}`)
  assert.equal(dshAwaiting.data.session.status, 'awaiting')
  await hostCommand(dshFixtureHost, 'claimWorktree', {
    worktree: dshProbe,
    snapshotId: snapshotA.snapshotId,
    selectedSkills: [selectedSkill],
    sessionId: dshSessionId
  }, `p9-dsh-claim-${runId}`)
  await dshFixtureHost.dispose()

  const port = await getAvailableLoopbackPort({ forbidden: [18765, 3080] })
  const runtimePatch = path.join(runRoot, `${runId}-runtime.patch.yml`)
  writeText(runtimePatch, [
    '- id: skill-graft-dsh',
    '  config:',
    `    dataRoot: '${layout.sharedHub.replaceAll('\\', '/')}'`,
    "    workspace: ''",
    '    autoSync: off',
    `    lockTimeoutMs: ${profileLeaseMs}`,
    '    logLevel: info',
    ''
  ].join('\n'))
  const profile = batchSpawn(pnpm, [
    'run', 'dsh', '--profile', 'web', '--patch', runtimePatch,
    '--host', '127.0.0.1', '--port', String(port)
  ], {
    cwd: harnessRoot,
    env: dshEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let profileStdout = ''
  let profileStderr = ''
  let directDshHost = null
  const profileRpcStatus = 'startup-empty-response-limitation'
  let dshExecute
  profile.stdout.on('data', (chunk) => { profileStdout = tail(profileStdout + chunk, 64 * 1024) })
  profile.stderr.on('data', (chunk) => { profileStderr = tail(profileStderr + chunk, 64 * 1024) })
  try {
    await waitForTcp(port, profile)
    await waitForHttpReady(port, profile)
    writeText(path.join(layout.logs, 'dsh-profile-rpc-limitation.log'), [
      'P9 live status returned an empty response in two earlier bounded attempts after readiness.',
      'This converged run polls Web readiness only; P8 remains the live RPC transport evidence.',
      ''
    ].join('\n'), { encoding: 'utf8', flag: 'wx' })
    await stopOwnedTree(profile, runId)
    await new Promise((resolve) => setTimeout(resolve, profileLeaseMs + 500))
    directDshHost = await localModules.dshHost.openDshHost({
      packageRoot: dshPackageRoot,
      dataRoot: layout.sharedHub,
      hostId: 'dsh-p9-installed-direct',
      leaseMs,
      createSessionRuntime: (context) => localModules.dshRuntime.createDshSessionRuntime(
        context,
        new SuccessfulDshDriver()
      )
    })
    dshExecute = (command, requestId, expectedOk = true) => {
      const { kind, ...payload } = command
      return hostCommand(directDshHost, kind, payload, requestId, expectedOk)
    }
    const dshStatus = await dshExecute({ kind: 'status' }, `p9-dsh-direct-status-${runId}`)
    assert.equal(dshStatus.ok, true)
    const dshSkills = await dshExecute({ kind: 'listSkills' }, `p9-dsh-list-skills-${runId}`)
    assert.equal(dshSkills.ok, true)
    assert.equal(dshSkills.data.resident.some((skill) => skill.name === selectedSkill), true)
    const localStatus = installedCli(localCli, localEnv, ['status'], `p9-local-status-${runId}`)
    assert.equal(localStatus.ok, true)
    const localWorktrees = installedCli(localCli, localEnv, ['list-worktrees'], `p9-local-list-worktrees-${runId}`)
    assert.equal(localWorktrees.ok, true)

    const replay = await dshExecute({ kind: 'createSnapshot' }, snapshotRequestId)
    assert.equal(replay.ok, true)
    assert.equal(replay.meta.replayed, true, 'DSH replays the Local snapshot request from the shared ledger')
    assert.equal(replay.data.snapshot.snapshotId, snapshotA.snapshotId)

    writeText(path.join(layout.sharedHub, 'AGENTS.override.md'), '# P9 shared authority B\n')
    writeText(path.join(layout.sharedHub, 'skills', selectedSkill, 'tracked.txt'), 'p9-snapshot-b\n')
    const snapshotBEnvelope = await dshExecute({ kind: 'createSnapshot' }, `p9-dsh-snapshot-b-${runId}`)
    assert.equal(snapshotBEnvelope.ok, true)
    const snapshotB = snapshotBEnvelope.data.snapshot
    assert.notEqual(snapshotB.snapshotId, snapshotA.snapshotId)

    const dshQueued = await dshExecute({
      kind: 'chat',
      intent: 'P9 installed DSH public session projection',
      runner: { start: false, wait: false }
    }, `p9-dsh-session-queued-${runId}`)
    assert.equal(dshQueued.ok, true)
    assert.equal(dshQueued.data.session.status, 'queued')
    const dshQueuedRead = await dshExecute({
      kind: 'getSession', sessionId: dshQueued.data.session.id
    }, `p9-dsh-session-get-${runId}`)
    assert.equal(dshQueuedRead.ok, true)

    const localPlan = installedCli(localCli, localEnv, [
      'plan-sync', '--worktree', localProbe
    ], `p9-local-plan-${runId}`)
    assert.equal(localPlan.data.plan.executable, true, JSON.stringify(localPlan.data.plan))
    const localSync = installedCli(localCli, localEnv, [
      'sync', '--worktree', localProbe,
      '--plan-hash', localPlan.data.plan.planHash,
      '--session-id', localSessionId
    ], `p9-local-sync-${runId}`)
    assert.equal(localSync.data.changed, true)
    assert.equal(fs.readFileSync(path.join(localProbe, 'AGENTS.override.md'), 'utf8'), '# P9 shared authority A\n')
    assert.equal(fs.readFileSync(path.join(localProbe, '.agents', 'skills', selectedSkill, 'tracked.txt'), 'utf8'), 'p9-snapshot-a\n')

    const dshPlan = await dshExecute({ kind: 'planSync', worktree: dshProbe }, `p9-dsh-plan-${runId}`)
    assert.equal(dshPlan.ok, true)
    assert.equal(dshPlan.data.plan.executable, true, JSON.stringify(dshPlan.data.plan))
    const dshSync = await dshExecute({
      kind: 'sync',
      worktree: dshProbe,
      planHash: dshPlan.data.plan.planHash,
      sessionId: dshSessionId
    }, `p9-dsh-sync-${runId}`)
    assert.equal(dshSync.ok, true)
    assert.equal(dshSync.data.changed, true)
    assert.equal(fs.readFileSync(path.join(dshProbe, 'AGENTS.override.md'), 'utf8'), '# P9 shared authority A\n')
    assert.equal(fs.readFileSync(path.join(dshProbe, '.agents', 'skills', selectedSkill, 'tracked.txt'), 'utf8'), 'p9-snapshot-a\n')
    assert.equal(fs.existsSync(path.join(dshProbe, '.codex', 'local-overlay', 'README.md')), true)
    const localCompleted = installedCli(localCli, localEnv, [
      'session', 'show', '--id', localSessionId
    ], `p9-local-session-completed-${runId}`)
    assert.equal(localCompleted.data.session.status, 'completed')
    const dshCompleted = await dshExecute({
      kind: 'getSession', sessionId: dshSessionId
    }, `p9-dsh-session-completed-${runId}`)
    assert.equal(dshCompleted.ok, true)
    assert.equal(dshCompleted.data.session.status, 'completed')
    assertSessionProjection(localCompleted.data.session, localProbe)
    assertSessionProjection(dshCompleted.data.session, dshProbe)
    assertSessionProjection(dshQueuedRead.data.session, layout.runRoot)

    const leaseModules = await import(pathToFileURL(path.join(localPackageRoot, 'dist', 'adapters', 'lease-lock.js')).href)
    const leaseRoot = leaseModules.applicationLeaseRoot(layout.sharedHub)
    const manager = leaseModules.createLeaseLockManager({ root: leaseRoot, leaseMs })
    const acquired = await manager.acquire({
      scope: 'hub-global',
      key: 'hub-global',
      hostId: 'local-p9-lock-holder',
      commandKind: 'setPin',
      requestId: `p9-local-lock-holder-${runId}`
    })
    assert.equal(acquired.status, 'acquired')
    const stateBeforeBusy = fs.readFileSync(path.join(layout.sharedHub, 'skill-review', 'state.json'))
    const ledgerBeforeBusy = fs.readFileSync(path.join(layout.sharedHub, 'skill-review', 'application-ledger.json'))
    const auditBeforeBusy = fs.readFileSync(path.join(layout.sharedHub, 'skill-review', 'application-audit.json'))
    let busy
    try {
      busy = await dshExecute({
        kind: 'setPin',
        worktree: sharedProbe,
        snapshotId: snapshotB.snapshotId,
        selectedSkills: [selectedSkill]
      }, `p9-dsh-shared-pin-busy-${runId}`, false)
    } finally {
      await acquired.lease.release()
    }
    assert.equal(busy.ok, false)
    assert.equal(busy.error.code, 'LOCK_BUSY')
    assert.equal(busy.error.retryable, true)
    assert.deepEqual(fs.readFileSync(path.join(layout.sharedHub, 'skill-review', 'state.json')), stateBeforeBusy)
    assert.deepEqual(fs.readFileSync(path.join(layout.sharedHub, 'skill-review', 'application-ledger.json')), ledgerBeforeBusy)
    assert.deepEqual(fs.readFileSync(path.join(layout.sharedHub, 'skill-review', 'application-audit.json')), auditBeforeBusy)
    assert.deepEqual(treeManifest(sharedProbe), sharedProbeBaseline, 'rejected DSH writer preserves every shared-probe byte')

    const localSharedSet = installedCli(localCli, localEnv, [
      'pin', 'set', '--worktree', sharedProbe,
      '--snapshot', snapshotB.snapshotId,
      '--skill', selectedSkill
    ], `p9-local-shared-pin-winner-${runId}`)
    assert.equal(localSharedSet.data.pin.requestedSnapshot, snapshotB.snapshotId)
    const dshSharedRead = await dshExecute({
      kind: 'getPin', worktree: sharedProbe
    }, `p9-dsh-shared-pin-read-${runId}`)
    assert.equal(dshSharedRead.ok, true)
    assert.equal(dshSharedRead.data.pin.requestedSnapshot, snapshotB.snapshotId)
    assert.deepEqual(treeManifest(sharedProbe), sharedProbeBaseline,
      'successful shared-state pin update does not materialize or overwrite the shared probe')

    const stateFile = path.join(layout.sharedHub, 'skill-review', 'state.json')
    const originalState = fs.readFileSync(stateFile)
    const ledgerBeforeSkew = fs.readFileSync(path.join(layout.sharedHub, 'skill-review', 'application-ledger.json'))
    const auditBeforeSkew = fs.readFileSync(path.join(layout.sharedHub, 'skill-review', 'application-audit.json'))
    const snapshotsBeforeSkew = treeManifest(path.join(layout.sharedHub, 'skill-review', 'library'))
    const probesBeforeSkew = {
      local: treeManifest(localProbe),
      dsh: treeManifest(dshProbe),
      shared: treeManifest(sharedProbe)
    }
    const futureState = Buffer.from('{"schemaVersion":3,"future":{"opaque":true}}\n', 'utf8')
    fs.writeFileSync(stateFile, futureState)
    let inspectedFuture
    let rejectedFuture
    try {
      inspectedFuture = await dshExecute({ kind: 'inspectSchema' }, `p9-dsh-future-schema-${runId}`)
      assert.deepEqual({
        status: inspectedFuture.data.status,
        detected: inspectedFuture.data.detectedSchemaVersion,
        current: inspectedFuture.data.currentSchemaVersion,
        revision: inspectedFuture.data.stateRevision,
        writable: inspectedFuture.data.writable,
        migrationRequired: inspectedFuture.data.migrationRequired
      }, {
        status: 'unsupported', detected: 3, current: 2, revision: null, writable: false, migrationRequired: false
      })
      rejectedFuture = installedCli(localCli, localEnv, ['snapshot', 'create'], `p9-local-future-write-${runId}`, false)
      assert.equal(rejectedFuture.error.code, 'STATE_VERSION_UNSUPPORTED')
      assert.equal(rejectedFuture.error.retryable, false)
      assert.deepEqual(fs.readFileSync(stateFile), futureState, 'future schema bytes remain exact')
      assert.deepEqual(fs.readFileSync(path.join(layout.sharedHub, 'skill-review', 'application-ledger.json')), ledgerBeforeSkew)
      assert.deepEqual(fs.readFileSync(path.join(layout.sharedHub, 'skill-review', 'application-audit.json')), auditBeforeSkew)
      assert.deepEqual(treeManifest(path.join(layout.sharedHub, 'skill-review', 'library')), snapshotsBeforeSkew)
      assert.deepEqual({
        local: treeManifest(localProbe), dsh: treeManifest(dshProbe), shared: treeManifest(sharedProbe)
      }, probesBeforeSkew)
    } finally {
      fs.writeFileSync(stateFile, originalState)
    }

    const finalLocalSchema = installedCli(localCli, localEnv, ['inspect-schema'], `p9-local-final-schema-${runId}`)
    assert.equal(finalLocalSchema.data.status, 'current')
    const finalDshStatus = await dshExecute({ kind: 'status' }, `p9-dsh-final-status-${runId}`)
    assert.equal(finalDshStatus.ok, true)

    const transactionRoot = path.join(layout.sharedHub, '.skill-graft-transactions')
    assert.deepEqual(treeManifest(transactionRoot), [], 'shared transaction staging residue is zero')
    assert.deepEqual(treeManifest(path.join(leaseRoot, 'leases')), [], 'live/staging/retired lease residue is zero')
    for (const [name, worktree] of Object.entries({ localProbe, dshProbe, sharedProbe })) {
      const transactionPath = path.resolve(worktree, git(worktree, ['rev-parse', '--git-path', 'skill-graft/transactions'], localEnv, `${name} transaction path`))
      assert.deepEqual(treeManifest(transactionPath), [], `${name} materialization transaction residue is zero`)
    }

    const summary = {
      schemaVersion: 1,
      runId,
      sourceSha: git(sourceRoot, ['rev-parse', 'HEAD'], baseEnv, 'P9 source SHA'),
      localTarball: { sha256: sha256(fs.readFileSync(localTarball)), bytes: fs.statSync(localTarball).size },
      dshTarball: { sha256: sha256(fs.readFileSync(dshTarball)), bytes: fs.statSync(dshTarball).size },
      shared: {
        snapshotReplay: true,
        requestReplayExecutor: 'installed-local-dist-dsh-composition',
        busyCode: busy.error.code,
        busyRetryable: busy.error.retryable,
        futureSchemaCode: rejectedFuture.error.code,
        finalStateSha256: sha256(fs.readFileSync(stateFile))
      },
      materialization: {
        localProbe: { planHash: localPlan.data.plan.planHash, materializationId: localSync.data.marker.materializationId },
        dshCompositionProbe: {
          planHash: dshPlan.data.plan.planHash,
          materializationId: dshSync.data.marker.materializationId
        },
        sameProbeCrossHostSync: false
      },
      sessions: {
        local: localCompleted.data.session.status,
        dsh: dshCompleted.data.session.status,
        profileQueuedQuery: dshQueuedRead.data.session.status,
        authorizationDriverBoundary: 'focused-fixture'
      },
      dshInvocation: {
        profileRpcStatus,
        installedDirectFallback: true,
        compositionModuleSource: 'installed Local tgz dist/dsh',
        runtimeAssetPackageRoot: 'installed DSH profile tgz',
        priorLiveRpcEvidence: 'artifacts/verification/P8/README.md'
      },
      isolation: {
        localHomeDistinctFromDshHome: comparable(layout.localHome) !== comparable(layout.dshHome),
        sharedHubUnderDshHome: isInside(layout.dshHome, layout.sharedHub),
        sourceTreeCliUsed: false,
        port,
        listener18765Before
      }
    }
    writeText(path.join(layout.logs, 'p9-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, {
      encoding: 'utf8', flag: 'wx'
    })
    process.stdout.write(`P9_SUMMARY ${JSON.stringify(summary)}\n`)
  } finally {
    writeText(path.join(layout.logs, 'dsh-profile.stdout.log'), profileStdout)
    writeText(path.join(layout.logs, 'dsh-profile.stderr.log'), profileStderr)
    await directDshHost?.dispose()
    await stopOwnedTree(profile, runId)
  }

  const deadline = Date.now() + 30_000
  while (listeners(port).length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.deepEqual(listeners(port), [], 'selected DSH listener is released')
  assert.deepEqual(runOwnedProcesses(runId), [], 'all run-owned DSH processes are reaped')
  assert.deepEqual(listeners(18765), listener18765Before, 'pre-existing 18765 listeners are untouched')
  const protectedAfter = roots.map((root) => gitFingerprint(root, baseEnv)).filter(Boolean)
  assert.deepEqual(protectedAfter, protectedBefore, 'all protected OZDQP, handoff, track, and Harness worktrees are unchanged')
})
