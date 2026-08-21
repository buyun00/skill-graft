import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  ProcessTracker,
  assertRunLayoutOwned,
  createIsolatedGitEnvironment,
  createWindowsBatchInvocation,
  getAvailableLoopbackPort,
  validateRealE2eEnvironment
} from '../../support/real-e2e.mjs'

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const protectedRoots = String(process.env.SKILL_GRAFT_PROTECTED_ROOTS || '')
  .split(path.delimiter)
  .map((item) => item.trim())
  .filter(Boolean)
const fixedProbe = 'E:\\ozdqp-cli-attach-probe'
if (fs.existsSync(fixedProbe)) protectedRoots.push(fixedProbe)

const context = validateRealE2eEnvironment(process.env, { workspaceRoot: sourceRoot, protectedRoots })
assertRunLayoutOwned(context)

const packageName = 'ozdqp-skill-hub'
const installedPackageRoot = path.join(context.appRoot, 'node_modules', packageName)
const runtimeReview = path.join(context.hubDataRoot, 'skill-review')
const installedRuntimeReview = path.join(installedPackageRoot, 'skill-review')
const sessionsFile = path.join(runtimeReview, 'sessions.json')
const expectedSg = path.join(
  context.appRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'sg.cmd' : 'sg'
)
const dshHome = path.join(context.homeRoot, 'dsh-home')
const appData = path.join(context.homeRoot, 'appdata')
const localAppData = path.join(context.homeRoot, 'localappdata')
const npmCache = path.join(context.homeRoot, 'npm-cache')
const npmPrefix = path.join(context.homeRoot, 'npm-prefix')
const tempRoot = path.join(context.homeRoot, 'temp')
const installRoot = path.join(localAppData, 'skill-graft-install')
const p0FixtureFile = path.join(context.runRoot, '.skill-graft-p0-fixture.json')
const browserAcceptanceFile = path.join(context.logsRoot, 'p1-browser-acceptance.json')
const invocationTraceKeyFile = path.join(context.logsRoot, '.invocation-trace-key')
const invocationTraceRoot = path.join(context.logsRoot, 'invocation-trace')
const invocationTraceRequestDomain = 'skill-graft:invocation-trace:request-id:v1\0'
const invocationTraceEnvironmentDomain = 'skill-graft:invocation-trace:environment:v1\0'
const invocationTraceEnvironmentKeys = [
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
const invocationTraceBaseKeys = [
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
].sort()
const invocationTraceCommandKinds = new Set([
  'status',
  'listSkills',
  'listWorktrees',
  'readSkill',
  'listHistory',
  'listSessions',
  'getSession',
  'repairLegacy',
  'applyLegacyAttach',
  'applyLegacyDetach',
  'ingest',
  'decide',
  'attach',
  'detach',
  'edit',
  'chat',
  'analyze',
  'resumeSession',
  'reapSessions'
])
const invocationTraceTransports = new Set(['cli', 'daemon', 'http', 'http-session-reap', 'http-sse', 'other'])
const residentSkillNames = ['ozdqp-development', 'ozdqp-ui-development', 'ozdqp-git-workflow']
const sessionSecrets = Object.freeze({
  intent: `p1-intent-secret-${context.runId}`,
  continuationToken: `p1-continuation-secret-${context.runId}`,
  codexSessionId: `p1-codex-session-secret-${context.runId}`,
  summary: `p1-summary-secret-${context.runId}`,
  lastMessage: `p1-last-message-secret-${context.runId}`
})
const requiredHubFixtureFiles = [
  '.gitattributes',
  '.gitignore',
  'AGENTS.override.md',
  'overlay/attached-worktrees.txt',
  'overlay/do-not-auto-attach.txt',
  'overlay/scan-roots.txt',
  'overlay/prompts/analyze.txt',
  'overlay/prompts/attach.txt',
  'overlay/prompts/chat.txt',
  'overlay/prompts/detach.txt',
  'overlay/prompts/edit.txt',
  'skill-review/state.json',
  'skill-review/sessions.json',
  ...residentSkillNames.map((name) => `skills/${name}/SKILL.md`)
]

function comparable(target) {
  const resolved = path.resolve(target)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function assertEmptyDirectory(target, label) {
  assert.equal(fs.existsSync(target), true, `${label} directory must exist`)
  assert.equal(fs.statSync(target).isDirectory(), true, `${label} must be a directory`)
  assert.deepEqual(fs.readdirSync(target), [], `${label} must start empty for a fresh run-id`)
}

function isSameOrInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function assertOwnedFixturePath(root, relative, kind = 'file') {
  const target = path.resolve(root, ...relative.split('/'))
  assert.equal(isSameOrInside(root, target), true, `${relative} must remain inside its fixture root`)
  assert.equal(fs.existsSync(target), true, `P0 fixture is missing ${relative}`)
  const canonicalRoot = fs.realpathSync.native(root)
  const canonicalTarget = fs.realpathSync.native(target)
  assert.equal(isSameOrInside(canonicalRoot, canonicalTarget), true, `${relative} must not link outside the P0 fixture`)
  const stat = fs.statSync(target)
  assert.equal(kind === 'directory' ? stat.isDirectory() : stat.isFile(), true, `${relative} must be a ${kind}`)
  return target
}

function runFixtureGit(cwd, args, label) {
  const env = createIsolatedGitEnvironment(process.env, context.homeRoot)
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 16 * 1024 * 1024
  })
  assert.equal(result.error, undefined, `${label} spawn error: ${result.error?.message || ''}`)
  assert.equal(result.status, 0, `${label} failed: ${tail(result.stderr || result.stdout)}`)
  return String(result.stdout || '').trim()
}

function inspectProbeFixture(expectedCommit) {
  assertOwnedFixturePath(context.probeRoot, '.git', 'directory')
  assertOwnedFixturePath(context.probeRoot, 'AGENTS.md')
  assertOwnedFixturePath(context.probeRoot, 'baloot_client', 'directory')
  const head = runFixtureGit(context.probeRoot, ['rev-parse', 'HEAD'], 'read P0 probe HEAD')
  assert.equal(head, expectedCommit, 'P0 probe HEAD must match its fixture manifest')
  assert.equal(runFixtureGit(context.probeRoot, ['branch', '--show-current'], 'read P0 probe branch'), '', 'P0 probe must remain detached')
  assert.equal(runFixtureGit(context.probeRoot, ['remote'], 'read P0 probe remotes'), '', 'P0 probe must not retain a live remote')
  const alternatesFile = path.join(context.probeRoot, '.git', 'objects', 'info', 'alternates')
  assert.equal(fs.existsSync(alternatesFile), false, 'P0 probe must not retain an object alternate')
  assert.equal(
    runFixtureGit(context.probeRoot, ['status', '--porcelain=v1', '--untracked-files=all'], 'read P0 probe status'),
    '',
    'P0 probe must be Git-clean before P1 acceptance'
  )
  return { head, detached: true, clean: true, remoteCount: 0, alternatesPresent: false }
}

function requireP0Fixture() {
  assertOwnedFixturePath(context.runRoot, path.basename(p0FixtureFile))
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(p0FixtureFile, 'utf8'))
  } catch (error) {
    throw new Error(`invalid P0 fixture manifest: ${error instanceof Error ? error.message : error}`)
  }
  assert.equal(manifest.version, 2, 'P0 fixture manifest version')
  assert.equal(manifest.runId, context.runId, 'P0 fixture manifest must belong to this run-id')
  assert.match(String(manifest.hubCommit || ''), /^[0-9a-f]{40}$/i, 'P0 fixture hub commit')
  assert.match(String(manifest.probeCommit || ''), /^[0-9a-f]{40}$/i, 'P0 fixture probe commit')
  assert.equal(manifest.probeCloneMode, 'independent-no-local-no-hardlinks-no-checkout', 'P0 fixture clone mode')
  assert.equal(manifest.probeAlternatesPresent, false, 'P0 fixture object alternates contract')
  assert.equal(manifest.remoteRemoved, true, 'P0 fixture remote removal')
  assert.equal(manifest.runtimeStateInitialized, true, 'P0 fixture runtime state')
  assert.equal(manifest.sourceProvenance?.schemaVersion, 1, 'P0 source provenance schema')
  assert.match(String(manifest.sourceProvenance?.runIdentitySha256 || ''), /^[0-9a-f]{64}$/i, 'P0 source run identity hash')
  assert.equal(manifest.sourceProvenance?.fixtureVersion, 2, 'P0 source fixture version')
  assert.match(String(manifest.sourceProvenance?.hubCommit || ''), /^[0-9a-f]{40}$/i, 'P0 source hub commit')
  assert.equal(manifest.sourceProvenance?.probeCommit, manifest.probeCommit, 'P0 source probe commit')
  assert.equal(manifest.sourceProvenance?.probeCloneMode, 'independent-no-local-no-hardlinks-no-checkout', 'P0 source clone provenance')
  assert.equal(manifest.sourceProvenance?.probeAlternatesPresent, false, 'P0 source alternate provenance')
  assert.equal(manifest.sourceProvenance?.remoteRemoved, true, 'P0 source remote provenance')
  assert.match(String(manifest.sourceProvenance?.declaredHubCommit || ''), /^[0-9a-f]{40}$/i, 'P0 declared source hub commit')
  assert.match(String(manifest.sourceProvenance?.actualHubCommit || ''), /^[0-9a-f]{40}$/i, 'P0 actual source hub commit')
  assert.match(String(manifest.sourceProvenance?.skillsTree || ''), /^[0-9a-f]{40}$/i, 'P0 source skills tree')
  assert.match(String(manifest.sourceProvenance?.physicalSkillsSha256 || ''), /^[0-9a-f]{64}$/i, 'P0 physical source skills digest')
  assert.match(String(manifest.sourceProvenance?.physicalSkillsContentSha256 || ''), /^[0-9a-f]{64}$/i, 'P0 physical source skills content digest')
  assert.match(String(manifest.sourceProvenance?.probeProjectionKind || ''), /^p0-v(?:1-post-acceptance-attach-v1|2-clean)$/, 'P0 source probe projection kind')
  assert.match(String(manifest.sourceProvenance?.probeProjectionSha256 || ''), /^[0-9a-f]{64}$/i, 'P0 source probe projection digest')
  assert.ok(Number.isInteger(manifest.sourceProvenance?.probeProjectionEntries) && manifest.sourceProvenance.probeProjectionEntries >= 0, 'P0 source probe projection entries')
  assert.equal(manifest.sourceProvenance?.skillsMaterializationPolicy, 'git-blob-exact-or-strict-crlf-v1', 'P0 source skills materialization policy')
  assert.match(String(manifest.sourceProvenance?.skillsGitManifestSha256 || ''), /^[0-9a-f]{64}$/i, 'P0 source Git skills manifest digest')
  assert.match(String(manifest.sourceProvenance?.skillsProjectionSha256 || ''), /^[0-9a-f]{64}$/i, 'P0 source skills projection digest')
  assert.ok(Number.isInteger(manifest.sourceProvenance?.skillsProjectionEntries) && manifest.sourceProvenance.skillsProjectionEntries > 0, 'P0 source skills projection entries')
  assert.ok(Number.isInteger(manifest.sourceProvenance?.skillsExactEntries) && manifest.sourceProvenance.skillsExactEntries >= 0, 'P0 source exact skills entries')
  assert.ok(Number.isInteger(manifest.sourceProvenance?.skillsCrlfEntries) && manifest.sourceProvenance.skillsCrlfEntries >= 0, 'P0 source strict-CRLF skills entries')
  assert.equal(
    manifest.sourceProvenance.skillsExactEntries + manifest.sourceProvenance.skillsCrlfEntries,
    manifest.sourceProvenance.skillsProjectionEntries,
    'P0 source skills materialization entry counts'
  )
  assert.match(String(manifest.sourceProvenance?.skillsAttributesSha256 || ''), /^[0-9a-f]{64}$/i, 'P0 source .gitattributes digest')
  assert.match(String(manifest.sourceProvenance?.targetSkillsTree || ''), /^[0-9a-f]{40}$/i, 'P0 source materialized target skills tree')
  for (const relative of requiredHubFixtureFiles) assertOwnedFixturePath(context.hubDataRoot, relative)
  assertOwnedFixturePath(context.hubDataRoot, '.git', 'directory')
  const hubHead = runFixtureGit(context.hubDataRoot, ['rev-parse', 'HEAD'], 'read P0 hub HEAD')
  assert.equal(hubHead, manifest.hubCommit, 'P0 hub HEAD must match its fixture manifest')
  assert.equal(
    runFixtureGit(context.hubDataRoot, ['rev-parse', 'HEAD:skills'], 'read P0 hub skills tree'),
    manifest.sourceProvenance.targetSkillsTree,
    'P0 hub skills tree must match its source materialization provenance'
  )
  const probe = inspectProbeFixture(manifest.probeCommit)
  return { manifest, hubHead, probe }
}

function expandWindowsEnv(value, env) {
  if (process.platform !== 'win32') return value
  return value.replace(/%([^%]+)%/g, (_match, name) => env[name] || env[name.toUpperCase()] || '')
}

function commandCandidates(dir, command) {
  const names = process.platform === 'win32'
    ? [command, `${command}.cmd`, `${command}.exe`, `${command}.bat`, `${command}.ps1`]
    : [command]
  return names.map((name) => path.join(dir, name))
}

function executableDirectories(rawPath, env = process.env) {
  return String(rawPath || '')
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter(Boolean)
    .map((entry) => ({ raw: entry, expanded: path.resolve(expandWindowsEnv(entry, env)) }))
}

function findOnPath(command, rawPath, env = process.env) {
  const found = []
  for (const entry of executableDirectories(rawPath, env)) {
    for (const candidate of commandCandidates(entry.expanded, command)) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) found.push(path.resolve(candidate))
    }
  }
  return [...new Set(found.map(comparable))]
}

function withoutGlobalHostBins(rawPath, env = process.env) {
  const kept = []
  const removed = []
  for (const entry of executableDirectories(rawPath, env)) {
    const ownsGlobalHostBin = ['sg', 'dsh'].some((command) =>
      commandCandidates(entry.expanded, command).some((candidate) => fs.existsSync(candidate))
    )
    if (ownsGlobalHostBin) removed.push(entry.expanded)
    else kept.push(entry.raw)
  }
  return { value: kept.join(path.delimiter), removed }
}

function isolatedEnvironment(port) {
  const sanitizedPath = withoutGlobalHostBins(process.env.PATH || '')
  assert.deepEqual(findOnPath('sg', sanitizedPath.value), [], 'sanitized base PATH must not expose a global sg')
  assert.deepEqual(findOnPath('dsh', sanitizedPath.value), [], 'sanitized base PATH must not expose a global dsh')

  const env = createIsolatedGitEnvironment(process.env, context.homeRoot)
  for (const key of Object.keys(env)) {
    if (/^DSH_/i.test(key) || /^(?:NODE_AUTH_TOKEN|NPM_TOKEN|GITHUB_TOKEN)$/i.test(key)) delete env[key]
  }
  Object.assign(env, {
    HOME: context.homeRoot,
    USERPROFILE: context.homeRoot,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    TEMP: tempRoot,
    TMP: tempRoot,
    HUB_ROOT: context.hubDataRoot,
    SKILL_GRAFT_HOME: context.hubDataRoot,
    HUB_API_PORT: String(port),
    HUB_SPAWN_CODEX: '0',
    SKILL_GRAFT_INVOCATION_TRACE: '1',
    DSH_HOME: dshHome,
    SG_SKIP_PATH: '1',
    SG_SKIP_TASK: '1',
    SG_INSTALL_DIR: installRoot,
    npm_config_cache: npmCache,
    NPM_CONFIG_CACHE: npmCache,
    npm_config_prefix: npmPrefix,
    NPM_CONFIG_PREFIX: npmPrefix,
    npm_config_userconfig: path.join(context.homeRoot, '.npmrc'),
    NPM_CONFIG_USERCONFIG: path.join(context.homeRoot, '.npmrc'),
    PATH: sanitizedPath.value
  })
  return { env, removedPathEntries: sanitizedPath.removed.length }
}

function tail(value, limit = 4000) {
  const text = String(value || '')
  return text.length <= limit ? text : text.slice(-limit)
}

function assertCommandOk(result, label) {
  assert.equal(result.error, undefined, `${label} spawn error: ${result.error?.message || ''}`)
  assert.equal(result.status, 0, `${label} failed: ${tail(result.stderr || result.stdout)}`)
  return result
}

function parseJsonOutput(result, label) {
  assertCommandOk(result, label)
  try {
    return JSON.parse(String(result.stdout || ''))
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error instanceof Error ? error.message : error}`)
  }
}

function typedData(result, label) {
  assert.equal(result.contractVersion, 1, `${label} contract version`)
  assert.equal(result.ok, true, `${label} typed failure: ${JSON.stringify(result.error || {})}`)
  assert.equal(result.meta?.handler, 'application.commandBus', `${label} Application handler`)
  return result.data
}

function runNpm(args, cwd, env) {
  const npmExecPath = String(process.env.npm_execpath || '')
  const command = npmExecPath ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const commandArgs = npmExecPath ? [npmExecPath, ...args] : args
  return spawnSync(command, commandArgs, {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024
  })
}

function sgInvocation(args) {
  if (process.platform !== 'win32') return { command: context.cliPath, args }
  return createWindowsBatchInvocation(context.cliPath, args)
}

function runSg(args, env) {
  const invocation = sgInvocation(args)
  return spawnSync(invocation.command, invocation.args, {
    cwd: context.appRoot,
    env,
    encoding: 'utf8',
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments === true,
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024
  })
}

function runInstalledImport(specifier, env) {
  return spawnSync(process.execPath, [
    '--input-type=module',
    '--eval',
    `await import(${JSON.stringify(specifier)})`
  ], {
    cwd: context.appRoot,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024
  })
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForHealth(port, expected, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  let healthy = false
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(750)
      })
      healthy = response.ok && (await response.json()).ok === true
    } catch {
      healthy = false
    }
    if (healthy === expected) return healthy
    await delay(150)
  }
  return healthy
}

async function waitForDaemonStatus(env, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    const result = runSg(['daemon', 'status'], env)
    if (!result.error && result.status === 0) {
      try {
        last = JSON.parse(String(result.stdout || ''))
        if (last.running === true && last.apiHealthy === true && last.heartbeat?.apiHealthy === true) return last
      } catch {
        // Preserve the last parseable payload and keep polling the owned daemon.
      }
    }
    await delay(200)
  }
  throw new Error(`daemon did not become healthy: ${JSON.stringify(last)}`)
}

async function waitForInvocationTracePid(pid, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  const prefix = `${pid}-`
  while (Date.now() < deadline) {
    if (fs.existsSync(invocationTraceRoot)) {
      const matched = fs.readdirSync(invocationTraceRoot)
        .filter((name) => name.startsWith(prefix) && name.endsWith('.jsonl'))
        .some((name) => fs.statSync(path.join(invocationTraceRoot, name)).size > 0)
      if (matched) return true
    }
    await delay(150)
  }
  return false
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function processRows() {
  if (process.platform === 'win32') {
    const script = [
      '$rows = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue',
      '$rows | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress'
    ].join('; ')
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024
    })
    assertCommandOk(result, 'enumerate Windows processes')
    const text = String(result.stdout || '').trim()
    const parsed = text ? JSON.parse(text) : []
    return (Array.isArray(parsed) ? parsed : [parsed]).map((row) => ({
      pid: Number(row.ProcessId),
      ppid: Number(row.ParentProcessId),
      name: String(row.Name || ''),
      commandLine: String(row.CommandLine || '')
    }))
  }

  const result = spawnSync('ps', ['-eo', 'pid=,ppid=,comm=,args='], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024
  })
  assertCommandOk(result, 'enumerate POSIX processes')
  return String(result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/))
    .filter(Boolean)
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      name: match[3],
      commandLine: match[4] || match[3]
    }))
}

function descendantRows(rows, rootPid) {
  const descendants = []
  const parents = new Set([Number(rootPid)])
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      if (parents.has(row.pid) || !parents.has(row.ppid)) continue
      parents.add(row.pid)
      descendants.push(row)
      changed = true
    }
  }
  return descendants
}

function containsCliIntermediary(row) {
  return /dist[\\/]control[\\/]cli\.js/i.test(row.commandLine)
}

function commandContainsPath(row, target) {
  const command = row.commandLine.replaceAll('/', '\\').toLowerCase()
  const expected = path.resolve(target).replaceAll('/', '\\').toLowerCase()
  return command.includes(expected)
}

function containsDshProcess(row) {
  return /(?:^|[\\/\s"'])dsh(?:\.cmd|\.exe|\.ps1|\.js)?(?=$|[\s"'])/i.test(row.commandLine)
}

function ownedRunProcesses(rows) {
  const token = context.runId.toLowerCase()
  return rows.filter((row) => row.pid !== process.pid && row.commandLine.toLowerCase().includes(token))
}

async function waitForStopped(port, pids, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  let owned = []
  while (Date.now() < deadline) {
    const healthDown = await waitForHealth(port, false, 500)
    const pidsDown = pids.every((pid) => !pidAlive(pid))
    owned = ownedRunProcesses(processRows())
    if (healthDown === false && pidsDown && owned.length === 0) return { portReleased: true, owned }
    await delay(200)
  }
  return { portReleased: (await waitForHealth(port, false, 500)) === false, owned }
}

async function getJson(base, pathname, headers = undefined) {
  const response = await fetch(`${base}${pathname}`, { headers, signal: AbortSignal.timeout(5000) })
  const body = await response.json()
  assert.equal(response.status, 200, `${pathname} status`)
  return { response, body }
}

async function postCommand(base, payload) {
  const response = await fetch(`${base}/api/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000)
  })
  const body = await response.json()
  assert.equal(response.status, 200, '/api/command status')
  return body
}

function normalizedStatus(status) {
  return {
    hubRoot: comparable(status.hubRoot),
    gameRepo: status.gameRepo || null,
    counts: status.counts,
    items: [...(status.items || [])]
      .map((item) => ({ id: item.id, name: item.name, unit: item.unit, status: item.status }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    sessions: [...(status.sessions || [])]
      .map((session) => ({ id: session.id, kind: session.kind, status: session.status }))
      .sort((left, right) => left.id.localeCompare(right.id))
  }
}

function inboxProjection(status, inboxId, inboxName, label) {
  assert.equal(Array.isArray(status?.items), true, `${label} items`)
  const item = status.items.find((candidate) => candidate.id === inboxId)
  assert.ok(item, `${label} must contain the seeded inbox item`)
  assert.deepEqual(
    { id: item.id, name: item.name, status: item.status },
    { id: inboxId, name: inboxName, status: 'queued' },
    `${label} seeded inbox identity and state`
  )
  const queued = status.items.filter((candidate) => candidate.status === 'queued').length
  assert.equal(status.counts?.queued, 1, `${label} queued count`)
  assert.equal(queued, status.counts.queued, `${label} queued count must match its item projection`)
  return {
    count: status.counts.queued,
    item: { id: item.id, name: item.name, status: item.status }
  }
}

function seedInboxFixture(inboxId, inboxName, inboxDirectory) {
  fs.mkdirSync(inboxDirectory, { recursive: true })
  fs.mkdirSync(path.join(context.hubDataRoot, 'skill-review'), { recursive: true })
  fs.writeFileSync(path.join(inboxDirectory, 'SKILL.md'), '# Isolated P1 application probe\n', 'utf8')
  fs.writeFileSync(path.join(context.hubDataRoot, 'skill-review', 'state.json'), `${JSON.stringify({
    version: 1,
    lastIngest: null,
    items: [{
      id: inboxId,
      name: inboxName,
      unit: `skills/inbox/${inboxName}`,
      status: 'queued',
      inboxPath: `skills/inbox/${inboxName}`
    }]
  }, null, 2)}\n`, 'utf8')
}

function seedDaemonReapFixture(sessionId) {
  const stored = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'))
  assert.equal(Array.isArray(stored.sessions), true, 'daemon reap fixture requires the Local session store')
  assert.equal(stored.sessions.some((session) => session.id === sessionId), false, 'daemon reap fixture id must be unique')
  stored.sessions.push({
    id: sessionId,
    kind: 'chat',
    path: '',
    worktree: context.probeRoot,
    intent: 'p1-daemon-reap-fixture',
    pid: 0,
    promptFile: path.join(runtimeReview, `prompt-${sessionId}.txt`),
    logFile: path.join(runtimeReview, `session-${sessionId}.log`),
    lastFile: path.join(runtimeReview, `session-${sessionId}.last.txt`),
    startedAt: new Date().toISOString(),
    status: 'running',
    exitCode: null,
    error: '',
    codexSessionId: '',
    summary: '',
    lastMessage: '',
    inboxIds: []
  })
  fs.writeFileSync(sessionsFile, `${JSON.stringify(stored, null, 2)}\n`, 'utf8')
  fs.writeFileSync(path.join(runtimeReview, `session-${sessionId}.exit`), '0\n', { flag: 'wx' })
}

function browserAcceptanceMetadata({ base, inboxId, inboxName, inboxDirectory, installedEnv, phase }) {
  const daemonLauncher = path.join(installRoot, 'run-daemon.cmd')
  const preferredLaunch = process.platform === 'win32'
    ? createWindowsBatchInvocation(daemonLauncher)
    : { command: process.execPath, args: [context.cliPath, 'daemon', 'run'] }
  const fallbackLaunch = process.platform === 'win32'
    ? createWindowsBatchInvocation(context.cliPath, ['daemon', 'start'])
    : { command: context.cliPath, args: ['daemon', 'start'] }
  return {
    schemaVersion: 1,
    runId: context.runId,
    phase,
    generatedAt: new Date().toISOString(),
    restart: {
      installedCli: context.cliPath,
      cwd: context.appRoot,
      dataRoot: context.hubDataRoot,
      daemonLauncher,
      preferredLaunch: {
        executable: preferredLaunch.command,
        args: preferredLaunch.args,
        windowsVerbatimArguments: preferredLaunch.windowsVerbatimArguments === true,
        note: 'the installed launcher already pins the verified isolated environment and selectedPort'
      },
      fallbackLaunch: {
        executable: fallbackLaunch.command,
        args: fallbackLaunch.args,
        windowsVerbatimArguments: fallbackLaunch.windowsVerbatimArguments === true,
        note: 'if selectedPort is unavailable, choose a fresh loopback port, rebuild the same sanitized environment with HUB_API_PORT set to it, then invoke this command so the launcher and URLs are regenerated'
      },
      host: '127.0.0.1',
      selectedPort: Number(installedEnv.HUB_API_PORT),
      portSelection: {
        helper: 'getAvailableLoopbackPort',
        forbidden: [18765, 3080],
        note: 'reuse selectedPort only if still available; otherwise select another loopback port and rebuild URLs'
      },
      environment: {
        HOME: installedEnv.HOME,
        USERPROFILE: installedEnv.USERPROFILE,
        APPDATA: installedEnv.APPDATA,
        LOCALAPPDATA: installedEnv.LOCALAPPDATA,
        TEMP: installedEnv.TEMP,
        TMP: installedEnv.TMP,
        HUB_ROOT: installedEnv.HUB_ROOT,
        SKILL_GRAFT_HOME: installedEnv.SKILL_GRAFT_HOME,
        DSH_HOME: installedEnv.DSH_HOME,
        HUB_SPAWN_CODEX: installedEnv.HUB_SPAWN_CODEX,
        GIT_CONFIG_GLOBAL: installedEnv.GIT_CONFIG_GLOBAL,
        GIT_CONFIG_NOSYSTEM: installedEnv.GIT_CONFIG_NOSYSTEM,
        GIT_OPTIONAL_LOCKS: installedEnv.GIT_OPTIONAL_LOCKS,
        PATH: {
          policy: 'installed .bin prepended to a base PATH with all sg/dsh providers removed',
          sha256: createHash('sha256').update(installedEnv.PATH, 'utf8').digest('hex')
        }
      }
    },
    routes: {
      baseUrl: base,
      updatePath: `/updates/${encodeURIComponent(inboxId)}`,
      updateUrl: `${base}/updates/${encodeURIComponent(inboxId)}`,
      stateApiUrl: `${base}/api/state`,
      legacyDecisionApiUrl: `${base}/api/decide`,
      commandApiUrl: `${base}/api/command`
    },
    seed: {
      item: { id: inboxId, name: inboxName, status: 'queued' },
      inboxDirectory,
      counts: { queued: 1 }
    },
    assertions: {
      queued: {
        routeItemId: inboxId,
        item: { id: inboxId, name: inboxName, status: 'queued' },
        counts: { queued: 1 }
      },
      uiWrite: {
        commandKind: 'decide',
        action: 'reject',
        targetId: inboxId,
        expectedStatus: 'rejected'
      },
      refreshed: {
        item: { id: inboxId, name: inboxName, status: 'rejected' },
        counts: { queued: 0 },
        rejectedItemCount: 1
      }
    },
    browserEvidence: {
      result: {
        schemaVersion: 1,
        resultFile: path.join(context.logsRoot, 'browser', 'p1-browser-result.json'),
        requiredPhase: 'browser-accepted'
      },
      suggestedScreenshots: {
        queued: path.join(context.logsRoot, 'browser', 'p1-browser-queued.png'),
        rejected: path.join(context.logsRoot, 'browser', 'p1-browser-rejected.png')
      },
      domStateConsistencyVerified: false,
      screenshotEvidence: null
    }
  }
}

function writeBrowserAcceptanceMetadata(value) {
  fs.writeFileSync(browserAcceptanceFile, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function traceRequestHash(key, requestId) {
  return `hmac-sha256:v1:${createHmac('sha256', key)
    .update(invocationTraceRequestDomain, 'utf8')
    .update(requestId, 'utf8')
    .digest('hex')}`
}

function traceEnvironmentIdentity(env) {
  const allowlisted = invocationTraceEnvironmentKeys.map((name) => [name, env[name] ?? null])
  return `sha256:v1:${createHash('sha256')
    .update(invocationTraceEnvironmentDomain, 'utf8')
    .update(JSON.stringify(allowlisted), 'utf8')
    .digest('hex')}`
}

function traceArtifactsUnder(root) {
  if (!fs.existsSync(root)) return []
  const found = []
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      const relative = path.relative(root, absolute).replaceAll('\\', '/')
      if (entry.name === '.invocation-trace-key'
        || entry.name === 'invocation-trace'
        || /^\d+-[a-f0-9]{24}\.jsonl$/.test(entry.name)) {
        found.push(relative)
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(absolute)
    }
  }
  visit(root)
  return found.sort()
}

function rawTraceForms(value) {
  const raw = String(value || '')
  if (!raw) return []
  const forward = raw.replaceAll('\\', '/')
  return [...new Set([
    raw,
    forward,
    JSON.stringify(raw).slice(1, -1),
    JSON.stringify(forward).slice(1, -1)
  ])]
}

function validateInvocationTrace({
  apiPid,
  daemonPid,
  environment,
  key,
  requestId,
  rawRequestIds,
  rawValues
}) {
  assert.equal(fs.existsSync(invocationTraceRoot), true, 'marker-owned invocation trace root')
  const traceRootStat = fs.lstatSync(invocationTraceRoot)
  assert.equal(traceRootStat.isDirectory(), true, 'invocation trace root must be a directory')
  assert.equal(traceRootStat.isSymbolicLink(), false, 'invocation trace root must not be linked')
  assert.equal(
    comparable(fs.realpathSync.native(invocationTraceRoot)).startsWith(`${comparable(fs.realpathSync.native(context.logsRoot))}${path.sep}`),
    true,
    'invocation trace root must remain below the marker-owned logs root'
  )

  const expectedEnvironmentIdentity = traceEnvironmentIdentity(environment)
  const fileNames = fs.readdirSync(invocationTraceRoot).sort()
  assert.ok(fileNames.length > 0, 'invocation trace must contain per-process JSONL evidence')
  const rows = []
  let traceText = ''
  for (const fileName of fileNames) {
    const match = fileName.match(/^(\d+)-([a-f0-9]{24})\.jsonl$/)
    assert.ok(match, `unexpected invocation trace artifact ${fileName}`)
    const traceFile = path.join(invocationTraceRoot, fileName)
    const stat = fs.lstatSync(traceFile)
    assert.equal(stat.isFile(), true, `${fileName} must be a regular file`)
    assert.equal(stat.isSymbolicLink(), false, `${fileName} must not be linked`)
    const canonicalTraceFile = fs.realpathSync.native(traceFile)
    assert.equal(
      comparable(path.dirname(canonicalTraceFile)),
      comparable(fs.realpathSync.native(invocationTraceRoot)),
      `${fileName} must remain directly below the trace root`
    )
    const fileText = fs.readFileSync(traceFile, 'utf8')
    traceText += fileText
    if (fileText.length === 0) continue
    assert.equal(fileText.endsWith('\n'), true, `${fileName} must end at a complete JSONL record`)
    const lines = fileText.split('\n')
    assert.equal(lines.pop(), '', `${fileName} trailing JSONL separator`)
    for (let index = 0; index < lines.length; index += 1) {
      assert.notEqual(lines[index], '', `${fileName}:${index + 1} must not contain a blank record`)
      const row = JSON.parse(lines[index])
      const expectedKeys = row.phase === 'result'
        ? [...invocationTraceBaseKeys, 'ok', 'replayed'].sort()
        : invocationTraceBaseKeys
      assert.deepEqual(Object.keys(row).sort(), expectedKeys, `${fileName}:${index + 1} exact trace schema`)
      assert.equal(row.schemaVersion, 1)
      assert.equal(row.adapterIdentity, 'local.invocationTrace.v1')
      assert.equal(row.handlerIdentity, 'application.commandBus')
      assert.match(row.handlerBuildIdentity, /^sha256:[a-f0-9]{64}$/)
      assert.equal(row.environmentIdentity, expectedEnvironmentIdentity, `${fileName}:${index + 1} isolated environment identity`)
      assert.equal(invocationTraceCommandKinds.has(row.commandKind), true, `${fileName}:${index + 1} command kind`)
      assert.equal(invocationTraceTransports.has(row.transport), true, `${fileName}:${index + 1} transport`)
      assert.match(row.requestHash, /^hmac-sha256:v1:[a-f0-9]{64}$/)
      assert.equal(Number.isSafeInteger(row.sequence) && row.sequence > 0, true)
      assert.equal(Number.isSafeInteger(row.pid) && row.pid > 0, true)
      assert.equal(Number.isSafeInteger(row.ppid) && row.ppid >= 0, true)
      assert.equal(row.pid, Number(match[1]), `${fileName}:${index + 1} PID must match its file`)
      assert.equal(row.processInstanceId, match[2], `${fileName}:${index + 1} instance must match its file`)
      assert.equal(new Date(row.at).toISOString(), row.at, `${fileName}:${index + 1} ISO timestamp`)
      if (row.phase === 'result') {
        assert.equal(typeof row.ok, 'boolean')
        assert.equal(typeof row.replayed, 'boolean')
      } else {
        assert.equal(row.phase, 'entry')
      }
      rows.push({ fileName, line: index + 1, row })
    }
  }

  const expectedHandlerBuildIdentity = `sha256:${createHash('sha256')
    .update(fs.readFileSync(path.join(installedPackageRoot, 'dist', 'application', 'hub-application.js')))
    .digest('hex')}`
  assert.ok(rows.length > 0, 'invocation trace must contain Application handler records')
  assert.equal(
    rows.every(({ row }) => row.handlerBuildIdentity === expectedHandlerBuildIdentity),
    true,
    'all transports must identify the same installed Application handler bytes'
  )

  const pairs = new Map()
  for (const wrapped of rows) {
    const keyOfPair = `${wrapped.row.processInstanceId}:${wrapped.row.sequence}`
    const pair = pairs.get(keyOfPair) || []
    pair.push(wrapped)
    pairs.set(keyOfPair, pair)
  }
  for (const [keyOfPair, pair] of pairs) {
    assert.equal(pair.length, 2, `${keyOfPair} must contain one entry and one result`)
    assert.deepEqual(pair.map(({ row }) => row.phase), ['entry', 'result'], `${keyOfPair} phase order`)
    const [entry, result] = pair.map(({ row }) => row)
    for (const field of [
      'adapterIdentity',
      'commandKind',
      'environmentIdentity',
      'handlerBuildIdentity',
      'handlerIdentity',
      'pid',
      'ppid',
      'processInstanceId',
      'requestHash',
      'sequence',
      'transport'
    ]) {
      assert.equal(result[field], entry[field], `${keyOfPair} ${field} pairing`)
    }
  }

  const requestHash = traceRequestHash(key, requestId)
  const targetEntries = rows
    .map(({ row }) => row)
    .filter((row) => row.requestHash === requestHash && row.commandKind === 'chat' && row.phase === 'entry')
  const targetResults = rows
    .map(({ row }) => row)
    .filter((row) => row.requestHash === requestHash && row.commandKind === 'chat' && row.phase === 'result')
  assert.deepEqual(
    targetEntries.map((row) => row.transport).sort(),
    ['cli', 'http', 'http'],
    'the CLI execution and both HTTP attempts must enter the traced Application handler'
  )
  assert.deepEqual(
    targetResults
      .map((row) => ({ transport: row.transport, ok: row.ok, replayed: row.replayed }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    [
      { transport: 'cli', ok: true, replayed: false },
      { transport: 'http', ok: false, replayed: false },
      { transport: 'http', ok: true, replayed: true }
    ].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    'trace must distinguish executed, replayed, and conflicting requests'
  )
  for (const row of targetEntries.concat(targetResults)) {
    if (row.transport === 'http') {
      assert.equal(row.pid, apiPid, 'HTTP trace PID must be the real API process')
      assert.equal(row.ppid, daemonPid, 'HTTP trace parent must be the real daemon process')
    } else {
      assert.notEqual(row.pid, apiPid, 'CLI trace must not be emitted by the API process')
      assert.notEqual(row.pid, daemonPid, 'CLI trace must not be emitted by the daemon process')
    }
  }
  const daemonRows = rows.map(({ row }) => row).filter((row) => row.pid === daemonPid)
  const apiRows = rows.map(({ row }) => row).filter((row) => row.pid === apiPid)
  assert.ok(daemonRows.length > 0, 'daemon process must emit environment-identified Application trace records')
  assert.ok(apiRows.length > 0, 'API process must emit environment-identified Application trace records')
  assert.equal(daemonRows.every((row) => row.environmentIdentity === expectedEnvironmentIdentity), true)
  assert.equal(apiRows.every((row) => row.environmentIdentity === expectedEnvironmentIdentity), true)
  const daemonReapRows = daemonRows.filter((row) => row.transport === 'daemon' && row.commandKind === 'reapSessions')
  assert.equal(daemonReapRows.length, 2, 'daemon must emit one reapSessions entry/result pair')
  assert.deepEqual(daemonReapRows.map((row) => row.phase), ['entry', 'result'])
  assert.equal(daemonReapRows[1].ok, true, 'daemon reapSessions result must succeed')
  assert.equal(daemonReapRows[1].replayed, false, 'daemon reapSessions must execute instead of replaying')

  let rawValueMatches = 0
  for (const value of [...rawRequestIds, ...rawValues, key.toString('hex')]) {
    for (const form of rawTraceForms(value)) {
      if (traceText.includes(form)) rawValueMatches += 1
    }
  }
  assert.equal(rawValueMatches, 0, 'trace JSONL must contain no raw request ids, secrets, payload values, or paths')
  assert.deepEqual(traceArtifactsUnder(installedPackageRoot), [], 'packageRoot must contain no invocation trace artifacts')
  assert.deepEqual(traceArtifactsUnder(context.hubDataRoot), [], 'dataRoot must contain no invocation trace artifacts')

  return {
    schemaVersion: 1,
    traceFileCount: fileNames.length,
    traceRecordCount: rows.length,
    entryCount: rows.filter(({ row }) => row.phase === 'entry').length,
    resultCount: rows.filter(({ row }) => row.phase === 'result').length,
    cliExecutedCount: targetResults.filter((row) => row.transport === 'cli' && row.ok && !row.replayed).length,
    httpReplayCount: targetResults.filter((row) => row.transport === 'http' && row.ok && row.replayed).length,
    httpConflictCount: targetResults.filter((row) => row.transport === 'http' && !row.ok && !row.replayed).length,
    handlerIdentity: 'application.commandBus',
    handlerBuildIdentity: expectedHandlerBuildIdentity,
    environmentIdentity: expectedEnvironmentIdentity,
    daemonEnvironmentMatched: true,
    apiEnvironmentMatched: true,
    requestHash,
    rawValueMatches,
    markerOwnedRoot: true,
    pidRolesMatched: true
  }
}

function writeSummary(value) {
  fs.writeFileSync(
    path.join(context.logsRoot, 'p1-application-summary.json'),
    `${JSON.stringify(value, null, 2)}\n`,
    'utf8'
  )
}

test('packed Local P1 distribution uses one Application across CLI and HTTP with isolated lifecycle', { timeout: 8 * 60 * 1000 }, async (t) => {
  assert.equal(process.platform, 'win32', 'the P1 real lifecycle acceptance currently requires Windows process evidence')
  assertEmptyDirectory(context.appRoot, 'app root')
  assertEmptyDirectory(context.homeRoot, 'home root')
  assertEmptyDirectory(context.logsRoot, 'logs root')
  const invocationTraceKey = randomBytes(32)
  fs.writeFileSync(invocationTraceKeyFile, invocationTraceKey, { flag: 'wx', mode: 0o600 })
  const invocationTraceKeyStat = fs.lstatSync(invocationTraceKeyFile)
  assert.equal(invocationTraceKeyStat.isFile(), true, 'invocation trace key must be a regular marker-owned file')
  assert.equal(invocationTraceKeyStat.isSymbolicLink(), false, 'invocation trace key must not be linked')
  assert.equal(invocationTraceKeyStat.size, 32, 'invocation trace key must contain exactly 32 bytes')
  const p0Fixture = requireP0Fixture()
  assert.equal(comparable(context.cliPath), comparable(expectedSg), 'SKILL_GRAFT_CLI must name the isolated npm sg shim')

  for (const dir of [appData, localAppData, npmCache, npmPrefix, tempRoot, dshHome]) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.writeFileSync(path.join(context.homeRoot, '.npmrc'), '', 'utf8')
  assert.deepEqual(fs.readdirSync(dshHome), [], 'DSH_HOME must start empty')

  const port = await getAvailableLoopbackPort()
  const base = `http://127.0.0.1:${port}`
  const isolated = isolatedEnvironment(port)
  const inboxId = `p1-inbox-${context.runId}`
  const inboxName = 'p1-application-probe'
  const inboxDirectory = path.join(context.hubDataRoot, 'skills', 'inbox', inboxName)
  const requestIds = Object.freeze({
    initialStatus: `p1-status-initial-${context.runId}`,
    initialWorktrees: `p1-worktrees-${context.runId}`,
    inboxCliStatus: `p1-inbox-cli-status-${context.runId}`,
    inboxHttpStatus: `p1-inbox-http-status-${context.runId}`,
    inboxLegacyState: `p1-inbox-legacy-state-${context.runId}`,
    chat: `p1-chat-${context.runId}`,
    reject: `p1-reject-${context.runId}`,
    finalCliStatus: `p1-status-final-${context.runId}`,
    finalHttpStatus: `p1-http-status-${context.runId}`
  })
  const packRoot = path.join(context.appRoot, 'package')
  fs.mkdirSync(packRoot, { recursive: true })

  const packRows = parseJsonOutput(
    runNpm(['pack', '--json', '--pack-destination', packRoot], sourceRoot, isolated.env),
    'npm pack current candidate'
  )
  assert.equal(Array.isArray(packRows), true, 'npm pack --json rows')
  assert.equal(packRows.length, 1, 'one packed candidate')
  const packed = packRows[0]
  const tarball = path.resolve(packRoot, packed.filename)
  assert.equal(fs.existsSync(tarball), true, 'packed tarball exists')
  const packPaths = (packed.files || []).map((entry) => String(entry.path).replaceAll('\\', '/'))
  assert.deepEqual(packPaths.filter((file) => /^dist\/core\/(?:install|sessions)(?:\.|\/)/.test(file)), [], 'no stale migrated core artifacts')
  for (const forbidden of ['src/', 'test/', 'docs/', 'scripts/', 'setup.cmd', 'overlay/attached-worktrees.txt', 'overlay/scan-roots.txt', 'overlay/do-not-auto-attach.txt']) {
    assert.equal(packPaths.some((file) => file === forbidden || file.startsWith(forbidden)), false, `${forbidden} excluded from package`)
  }

  assertCommandOk(
    runNpm([
      'install',
      '--prefix', context.appRoot,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      tarball
    ], context.appRoot, isolated.env),
    'install packed candidate'
  )
  assert.equal(fs.existsSync(context.cliPath), true, 'installed sg shim')
  assert.equal(fs.existsSync(path.join(installedPackageRoot, 'dist', 'control', 'cli.js')), true, 'installed dist CLI')
  assert.equal(fs.existsSync(path.join(installedPackageRoot, 'server', 'index.mjs')), true, 'installed server')
  assert.equal(fs.existsSync(path.join(installedPackageRoot, 'web', 'index.html')), true, 'installed static page')
  assert.equal(fs.existsSync(path.join(installedPackageRoot, 'src')), false, 'source tree is not installed')
  assert.equal(fs.existsSync(path.join(installedPackageRoot, 'test')), false, 'test tree is not installed')

  const installedBin = path.dirname(context.cliPath)
  const installedEnv = { ...isolated.env, PATH: `${installedBin}${path.delimiter}${isolated.env.PATH}` }
  const resolvedSg = findOnPath('sg', installedEnv.PATH, installedEnv)
  assert.equal(resolvedSg.includes(comparable(context.cliPath)), true, 'PATH resolves the isolated sg shim')
  assert.deepEqual(findOnPath('dsh', installedEnv.PATH, installedEnv), [], 'installed PATH must not expose dsh')
  const forbiddenInstalledSubpaths = [
    'ozdqp-skill-hub/dist/core/decide.js',
    'ozdqp-skill-hub/dist/core/legacy-attach.js',
    'ozdqp-skill-hub/dist/local/session/legacy-sessions.js'
  ]
  for (const forbiddenSubpath of forbiddenInstalledSubpaths) {
    const blockedImport = runInstalledImport(forbiddenSubpath, installedEnv)
    assert.equal(blockedImport.error, undefined, `${forbiddenSubpath} import probe spawn error`)
    assert.notEqual(blockedImport.status, 0, `${forbiddenSubpath} unexpectedly resolved from the installed package`)
    assert.match(blockedImport.stderr, /ERR_PACKAGE_PATH_NOT_EXPORTED/, `${forbiddenSubpath} package export boundary`)
  }

  const setup = parseJsonOutput(
    runSg(['setup', '--json', '--no-daemon', '--no-path', '--no-task'], installedEnv),
    'installed sg setup'
  )
  assert.equal(setup.ok, true)
  assert.equal(setup.action, 'setup')
  assert.match(setup.steps.find((step) => step.id === 'deps')?.detail || '', /prebuilt/)
  assert.equal(fs.existsSync(path.join(installedPackageRoot, 'node_modules')), false, 'setup does not install dev dependencies into the package')
  assert.equal(setup.steps.find((step) => step.id === 'daemon')?.skipped, true)
  assert.equal(setup.steps.find((step) => step.id === 'path')?.skipped, true)
  assert.equal(setup.steps.find((step) => step.id === 'task')?.skipped, true)

  const doctor = parseJsonOutput(runSg(['doctor', '--json'], installedEnv), 'installed sg doctor')
  assert.equal(doctor.ok, true)
  assert.equal(doctor.dist.ok, true)
  assert.equal(doctor.layout.ok, true)
  assert.equal(doctor.daemon.running, false)
  assert.notEqual(comparable(installedPackageRoot), comparable(context.hubDataRoot), 'installed packageRoot and runtime dataRoot must be separate')
  assert.equal(comparable(setup.hubRoot), comparable(context.hubDataRoot), 'setup must target isolated dataRoot')
  assert.equal(comparable(setup.doctor.hubRoot), comparable(context.hubDataRoot), 'setup doctor must target isolated dataRoot')
  assert.equal(comparable(doctor.hubRoot), comparable(context.hubDataRoot), 'doctor must target isolated dataRoot')
  assert.equal(
    comparable(doctor.dist.path),
    comparable(path.join(installedPackageRoot, 'dist', 'control', 'cli.js')),
    'doctor dist must resolve from the installed packageRoot'
  )
  assert.equal(fs.existsSync(installedRuntimeReview), false, 'setup and doctor must not create runtime state under packageRoot')
  for (const relative of ['state.json', 'sessions.json']) {
    assert.equal(fs.existsSync(path.join(runtimeReview, relative)), true, `setup runtime ${relative} must live under dataRoot`)
  }

  const redactionSessionId = `p1-redaction-${context.runId}`
  const seededSession = {
    id: redactionSessionId,
    kind: 'chat',
    path: '',
    worktree: context.probeRoot,
    intent: sessionSecrets.intent,
    pid: 0,
    promptFile: path.join(runtimeReview, `prompt-${redactionSessionId}.txt`),
    logFile: path.join(runtimeReview, `session-${redactionSessionId}.log`),
    lastFile: path.join(runtimeReview, `session-${redactionSessionId}.last.txt`),
    startedAt: new Date().toISOString(),
    status: 'running',
    exitCode: null,
    error: '',
    codexSessionId: `${sessionSecrets.continuationToken}:${sessionSecrets.codexSessionId}`,
    summary: sessionSecrets.summary,
    lastMessage: sessionSecrets.lastMessage,
    inboxIds: []
  }
  const seededSessionsText = `${JSON.stringify({ sessions: [seededSession] }, null, 2)}\n`
  for (const [field, secret] of Object.entries(sessionSecrets)) {
    assert.equal(seededSessionsText.includes(secret), true, `redaction fixture must carry the exact ${field} secret`)
  }
  fs.writeFileSync(sessionsFile, seededSessionsText, 'utf8')

  const initialStatusEnvelope = parseJsonOutput(
    runSg(['status', '--contract-v1', '--request-id', requestIds.initialStatus], installedEnv),
    'installed sg status'
  )
  const initialStatus = typedData(initialStatusEnvelope, 'installed sg status')
  assert.equal(initialStatus.hubRoot, path.resolve(context.hubDataRoot))
  assert.equal(Array.isArray(initialStatus.sessions), true)
  assert.deepEqual(
    initialStatus.resident.map((skill) => skill.name).sort(),
    [...residentSkillNames].sort(),
    'installed Local status must expose all three P0 resident Skills'
  )
  assert.equal(
    initialStatus.resident.every((skill) => skill.hasSkillMd === true),
    true,
    'all three P0 resident Skills must retain SKILL.md in isolated hub-data'
  )
  const initialWorktreesEnvelope = parseJsonOutput(
    runSg(['list-worktrees', '--contract-v1', '--request-id', requestIds.initialWorktrees], installedEnv),
    'installed sg list-worktrees'
  )
  const initialWorktrees = typedData(initialWorktreesEnvelope, 'installed sg list-worktrees')
  assert.equal(Array.isArray(initialWorktrees.worktrees), true)
  assert.equal(Array.isArray(initialWorktrees.scanRoots), true)
  const initialProbe = initialWorktrees.worktrees.find((item) => comparable(item.path) === comparable(context.probeRoot))
  assert.ok(initialProbe, 'P0 detached probe must be discoverable from its isolated scan root')
  assert.equal(initialProbe.branch, '(detached)')
  assert.equal(initialProbe.head, p0Fixture.manifest.probeCommit)

  const daemonReapSessionId = `p1-daemon-reap-${context.runId}`
  seedDaemonReapFixture(daemonReapSessionId)
  seedInboxFixture(inboxId, inboxName, inboxDirectory)
  writeBrowserAcceptanceMetadata(browserAcceptanceMetadata({
    base,
    inboxId,
    inboxName,
    inboxDirectory,
    installedEnv,
    phase: 'seeded-for-script-acceptance'
  }))

  const tracker = new ProcessTracker({ runId: context.runId })
  let daemonPid = 0
  let apiPid = 0
  let daemonStopped = false
  t.after(async () => {
    const errors = []
    try {
      if (!daemonStopped && fs.existsSync(context.cliPath)) runSg(['daemon', 'stop'], installedEnv)
    } catch (error) {
      errors.push(error)
    }
    try {
      await tracker.stopAll({ graceMs: 750 })
    } catch (error) {
      errors.push(error)
    }
    if (errors.length > 0) throw new AggregateError(errors, 'P1 real lifecycle cleanup failed')
  })

  const daemonStart = parseJsonOutput(runSg(['daemon', 'start'], installedEnv), 'installed sg daemon start')
  assert.equal(daemonStart.ok, true, daemonStart.detail)
  daemonPid = Number(daemonStart.pid)
  assert.ok(daemonPid > 0, 'daemon PID')
  tracker.trackPid(daemonPid, { commandIncludes: context.runId })
  assert.equal(await waitForHealth(port, true), true, 'random-port daemon health')

  const daemonStatus = await waitForDaemonStatus(installedEnv)
  assert.equal(daemonStatus.running, true)
  assert.equal(
    await waitForInvocationTracePid(daemonPid),
    true,
    'daemon must execute a real reapSessions command through the traced Application'
  )
  const daemonReapedSessions = JSON.parse(fs.readFileSync(sessionsFile, 'utf8')).sessions
    .filter((session) => session.id === daemonReapSessionId)
  assert.equal(daemonReapedSessions.length, 1, 'daemon reap fixture must remain a single owned session')
  assert.equal(daemonReapedSessions[0].status, 'waiting', 'daemon Application reap must finalize the owned fixture session')
  assert.equal(daemonReapedSessions[0].exitCode, 0, 'daemon Application reap must consume the runner-style exit evidence')
  assert.match(String(daemonReapedSessions[0].endedAt || ''), /^\d{4}-\d{2}-\d{2}T/, 'daemon reap must record terminal time')
  assert.equal(daemonStatus.apiHealthy, true)
  assert.equal(Number(daemonStatus.pid), daemonPid)
  apiPid = Number(daemonStatus.apiPid)
  assert.ok(apiPid > 0, 'API PID')
  tracker.trackPid(apiPid, { commandIncludes: context.runId })
  assert.equal(Number(daemonStatus.heartbeat?.port), port)
  assert.equal(comparable(daemonStatus.heartbeat?.dataRoot), comparable(context.hubDataRoot))
  assert.equal(comparable(daemonStatus.heartbeat?.packageRoot), comparable(installedPackageRoot))
  assert.equal(Number(fs.readFileSync(path.join(runtimeReview, 'daemon.pid'), 'utf8').trim()), daemonPid)
  assert.equal(Number(fs.readFileSync(path.join(runtimeReview, 'api.pid'), 'utf8').trim()), apiPid)
  const heartbeat = JSON.parse(fs.readFileSync(path.join(runtimeReview, 'daemon-heartbeat.json'), 'utf8'))
  assert.equal(Number(heartbeat.pid), daemonPid)
  assert.equal(Number(heartbeat.apiPid), apiPid)
  assert.equal(Number(heartbeat.port), port)
  assert.equal(comparable(heartbeat.packageRoot), comparable(installedPackageRoot))
  assert.equal(comparable(heartbeat.dataRoot), comparable(context.hubDataRoot))
  assert.equal(fs.existsSync(path.join(installedPackageRoot, 'skill-review', 'daemon.pid')), false, 'package root never owns daemon state')

  const health = await getJson(base, '/api/health')
  assert.deepEqual(health.body, { ok: true })
  const healthPackageRoot = health.response.headers.get('x-skill-graft-package-root')
  const healthDataRoot = health.response.headers.get('x-skill-graft-data-root')
  assert.ok(healthPackageRoot, 'health must identify the installed packageRoot')
  assert.ok(healthDataRoot, 'health must identify the isolated dataRoot')
  assert.equal(
    comparable(decodeURIComponent(healthPackageRoot)),
    comparable(installedPackageRoot),
    'health packageRoot header must identify the isolated npm installation'
  )
  assert.equal(
    comparable(decodeURIComponent(healthDataRoot)),
    comparable(context.hubDataRoot),
    'health dataRoot header must identify isolated HUB_ROOT'
  )
  const page = await fetch(`${base}/`, { signal: AbortSignal.timeout(5000) })
  const html = await page.text()
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-type') || '', /text\/html/i)
  assert.match(html, /Skill Hub|技能库|总览/)
  const deepPage = await fetch(`${base}/updates/${encodeURIComponent(inboxId)}`, { signal: AbortSignal.timeout(5000) })
  const deepHtml = await deepPage.text()
  assert.equal(deepPage.status, 200)
  assert.match(deepPage.headers.get('content-type') || '', /text\/html/i)
  assert.match(deepHtml, /Skill Hub|更新中心|总览/)
  const assetPath = packPaths.find((file) => /^web\/_next\/static\/chunks\/app\/\[\[\.\.\.slug\]\]\/page-[^/]+\.js$/.test(file))
  assert.ok(assetPath, 'packed catch-all UI asset')
  const assetUrl = `/${assetPath.slice('web/'.length).split('/').map(encodeURIComponent).join('/')}`
  const asset = await fetch(`${base}${assetUrl}`, { signal: AbortSignal.timeout(5000) })
  const assetBytes = await asset.arrayBuffer()
  assert.equal(asset.status, 200)
  assert.match(asset.headers.get('content-type') || '', /javascript/i)
  assert.ok(assetBytes.byteLength > 0, 'packed UI asset body')
  const httpDaemon = await getJson(base, '/api/daemon')
  assert.equal(httpDaemon.body.running, true)
  assert.equal(Number(httpDaemon.body.pid), daemonPid)
  assert.equal(Number(httpDaemon.body.apiPid), apiPid)
  const inboxCliStatusEnvelope = parseJsonOutput(runSg([
    'status',
    '--contract-v1',
    '--request-id', requestIds.inboxCliStatus
  ], installedEnv), 'CLI seeded inbox status')
  const inboxCliStatus = typedData(inboxCliStatusEnvelope, 'CLI seeded inbox status')
  const inboxHttpStatus = await postCommand(base, {
    kind: 'status',
    requestId: requestIds.inboxHttpStatus
  })
  assert.equal(inboxHttpStatus.ok, true, 'typed HTTP seeded inbox status')
  const legacyState = await getJson(base, '/api/state', {
    'x-skill-graft-request-id': requestIds.inboxLegacyState
  })
  assert.equal(legacyState.response.headers.get('deprecation'), 'true')
  assert.match(legacyState.response.headers.get('link') || '', /<\/api\/command>/)
  assert.equal(comparable(legacyState.body.hubRoot), comparable(context.hubDataRoot))
  const inboxCliProjection = inboxProjection(inboxCliStatus, inboxId, inboxName, 'CLI typed status')
  const inboxHttpProjection = inboxProjection(inboxHttpStatus.data, inboxId, inboxName, 'HTTP typed status')
  const inboxLegacyProjection = inboxProjection(legacyState.body, inboxId, inboxName, 'legacy /api/state')
  assert.deepEqual(inboxHttpProjection, inboxCliProjection, 'CLI and typed HTTP seeded inbox projections agree')
  assert.deepEqual(inboxLegacyProjection, inboxCliProjection, 'CLI and browser-facing legacy seeded inbox projections agree')
  const legacyWorktrees = await getJson(base, '/api/worktrees')
  assert.equal(legacyWorktrees.response.headers.get('deprecation'), 'true')
  assert.deepEqual(
    [...(legacyWorktrees.body.worktrees || [])].map((item) => comparable(item.path)).sort(),
    [...initialWorktrees.worktrees].map((item) => comparable(item.path)).sort(),
    'legacy HTTP and typed CLI list the same worktrees'
  )

  const profile = 'gpt-5.6-luna'
  const quality = 'max'
  const intent = sessionSecrets.intent
  const requestId = requestIds.chat
  const cliChatEnvelope = parseJsonOutput(runSg([
    'chat',
    '--intent', intent,
    '--worktree', context.probeRoot,
    '--model', profile,
    '--effort', quality,
    '--no-spawn',
    '--contract-v1',
    '--request-id', requestId
  ], installedEnv), 'CLI chat first execution')
  const cliChat = typedData(cliChatEnvelope, 'CLI chat first execution')
  assert.equal(cliChat.session.kind, 'chat')
  assert.equal(cliChat.session.status, 'queued')
  assert.equal(cliChatEnvelope.meta.replayed, false)
  assert.equal(cliChatEnvelope.events.length, 1)
  assert.equal(cliChatEnvelope.events[0].transport, 'cli')

  const replay = await postCommand(base, {
    kind: 'chat',
    intent,
    worktree: context.probeRoot,
    runner: { profile, quality, start: false, wait: false },
    requestId
  })
  assert.equal(replay.ok, true)
  assert.equal(replay.commandKind, 'chat')
  assert.equal(replay.meta.replayed, true)
  assert.equal(replay.meta.handler, 'application.commandBus')
  assert.equal(replay.data.session.id, cliChat.session.id)
  assert.deepEqual(replay.events, cliChatEnvelope.events)

  const conflict = await postCommand(base, {
    kind: 'chat',
    intent: `${intent} conflict probe`,
    worktree: context.probeRoot,
    runner: { profile, quality, start: false, wait: false },
    requestId
  })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.error.code, 'REQUEST_ID_CONFLICT')

  const runtimeSessionsText = fs.readFileSync(sessionsFile, 'utf8')
  for (const [field, secret] of Object.entries(sessionSecrets)) {
    assert.equal(runtimeSessionsText.includes(secret), true, `runtime session store must retain the exact ${field} redaction fixture`)
  }
  const sessions = JSON.parse(runtimeSessionsText).sessions || []
  assert.equal(sessions.filter((session) => session.id === cliChat.session.id).length, 1, 'one session effect')
  const ledgerFile = path.join(context.hubDataRoot, 'skill-review', 'application-ledger.json')
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'))
  const auditFile = path.join(context.hubDataRoot, 'skill-review', 'application-audit.json')
  const audit = JSON.parse(fs.readFileSync(auditFile, 'utf8'))
  const requestEntries = ledger.entries.filter((entry) => entry.requestId === requestId)
  const requestEvents = audit.events.filter((event) => event.requestId === requestId)
  assert.equal(requestEntries.length, 1, 'one request ledger effect')
  assert.equal(requestEvents.length, 1, 'one terminal audit effect')
  assert.equal(requestEntries[0].status, 'completed')
  assert.equal(requestEntries[0].result.data.session.id, cliChat.session.id)
  const persistedApplicationFiles = [
    ['request ledger', fs.readFileSync(ledgerFile, 'utf8')],
    ['audit log', fs.readFileSync(auditFile, 'utf8')]
  ]
  for (const [label, content] of persistedApplicationFiles) {
    for (const [field, secret] of Object.entries(sessionSecrets)) {
      assert.equal(content.includes(secret), false, `${label} must not contain the exact ${field} session secret`)
    }
  }
  assert.equal(fs.existsSync(path.join(installedRuntimeReview, 'application-ledger.json')), false, 'request ledger must not exist under packageRoot')
  assert.equal(fs.existsSync(path.join(installedRuntimeReview, 'application-audit.json')), false, 'audit log must not exist under packageRoot')

  const rejectRequestId = requestIds.reject
  const rejected = await postCommand(base, {
    kind: 'decide',
    id: inboxId,
    action: 'reject',
    note: 'isolated P1 application acceptance',
    requestId: rejectRequestId
  })
  assert.equal(rejected.ok, true)
  assert.equal(rejected.data.item.status, 'rejected')
  assert.equal(fs.existsSync(inboxDirectory), false, 'reject removes only the isolated inbox probe')

  const cliStatusEnvelope = parseJsonOutput(runSg([
    'status',
    '--contract-v1',
    '--request-id', requestIds.finalCliStatus
  ], installedEnv), 'CLI final status')
  const cliStatus = typedData(cliStatusEnvelope, 'CLI final status')
  const httpStatus = await postCommand(base, {
    kind: 'status',
    requestId: requestIds.finalHttpStatus
  })
  assert.equal(httpStatus.ok, true)
  assert.deepEqual(normalizedStatus(cliStatus), normalizedStatus(httpStatus.data), 'CLI and HTTP status agree')
  assert.equal(cliStatus.items.find((item) => item.id === inboxId)?.status, 'rejected')
  const idleLedgerBefore = fs.readFileSync(ledgerFile, 'utf8')
  const idleAuditBefore = fs.readFileSync(auditFile, 'utf8')
  await delay(5500)
  assert.equal(fs.readFileSync(ledgerFile, 'utf8'), idleLedgerBefore, 'idle daemon tick does not grow the request ledger')
  assert.equal(fs.readFileSync(auditFile, 'utf8'), idleAuditBefore, 'idle daemon tick does not grow the audit log')

  const runningRows = processRows()
  const daemonRow = runningRows.find((row) => row.pid === daemonPid)
  const apiRow = runningRows.find((row) => row.pid === apiPid)
  assert.ok(daemonRow, 'daemon process row')
  assert.ok(apiRow, 'API process row')
  assert.equal(commandContainsPath(daemonRow, installedPackageRoot), true, 'daemon executes the installed package')
  assert.match(daemonRow.commandLine, /dist[\\/]control[\\/]cli\.js["']?\s+daemon\s+run/i)
  assert.equal(apiRow.ppid, daemonPid, 'API server must be a direct daemon child')
  assert.match(apiRow.commandLine, /server[\\/]index\.mjs/i)
  assert.equal(commandContainsPath(apiRow, installedPackageRoot), true, 'API executes the installed package')
  assert.equal(containsCliIntermediary(apiRow), false, 'API is not a CLI intermediary')
  const daemonDescendants = descendantRows(runningRows, daemonPid)
  assert.ok(daemonDescendants.some((row) => row.pid === apiPid), 'API is in the daemon process tree')
  assert.deepEqual(
    daemonDescendants.filter(containsCliIntermediary).map((row) => row.pid),
    [],
    'daemon descendants contain no dist/control/cli intermediary'
  )
  assert.deepEqual(
    [...daemonDescendants, ...ownedRunProcesses(runningRows)].filter(containsDshProcess).map((row) => row.pid),
    [],
    'the isolated daemon tree contains no DSH process'
  )
  assert.deepEqual(fs.readdirSync(dshHome), [], 'DSH_HOME remains unused')

  const stopped = parseJsonOutput(runSg(['daemon', 'stop'], installedEnv), 'installed sg daemon stop')
  assert.equal(stopped.ok, true)
  daemonStopped = true
  const shutdown = await waitForStopped(port, [daemonPid, apiPid])
  assert.equal(shutdown.portReleased, true, 'random API port released')
  assert.equal(pidAlive(daemonPid), false, 'daemon PID stopped')
  assert.equal(pidAlive(apiPid), false, 'API PID stopped')
  assert.deepEqual(shutdown.owned.map((row) => row.pid), [], 'run-id process count returned to zero')
  assert.equal(fs.existsSync(path.join(runtimeReview, 'daemon.pid')), false)
  assert.equal(fs.existsSync(path.join(runtimeReview, 'api.pid')), false)
  assert.equal(fs.existsSync(path.join(installedPackageRoot, 'skill-review', 'daemon.pid')), false, 'package root never owns daemon state')
  assert.equal(fs.existsSync(path.join(installedPackageRoot, 'skill-review', 'api.pid')), false, 'package root never owns API state')
  const stoppedStatus = parseJsonOutput(runSg(['daemon', 'status'], installedEnv), 'installed sg daemon status after stop')
  assert.equal(stoppedStatus.running, false)
  assert.equal(Number(stoppedStatus.pid), 0)
  assert.equal(Number(stoppedStatus.apiPid), 0)
  assert.equal(stoppedStatus.apiHealthy, false)
  await tracker.stopAll({ graceMs: 500 })
  const finalProbe = inspectProbeFixture(p0Fixture.manifest.probeCommit)
  assert.deepEqual(fs.readFileSync(invocationTraceKeyFile), invocationTraceKey, 'trace key remains marker-owned and unchanged')
  const traceEvidence = validateInvocationTrace({
    apiPid,
    daemonPid,
    environment: installedEnv,
    key: invocationTraceKey,
    requestId,
    rawRequestIds: Object.values(requestIds),
    rawValues: [
      ...Object.values(sessionSecrets),
      cliChat.session.id,
      daemonReapSessionId,
      inboxId,
      inboxName,
      'isolated P1 application acceptance',
      profile,
      quality,
      context.runRoot,
      context.probeRoot,
      context.hubDataRoot,
      context.cliPath,
      installedPackageRoot,
      runtimeReview,
      inboxDirectory
    ]
  })
  seedInboxFixture(inboxId, inboxName, inboxDirectory)
  const browserSeedState = JSON.parse(fs.readFileSync(path.join(runtimeReview, 'state.json'), 'utf8'))
  assert.deepEqual(
    browserSeedState.items.map((item) => ({ id: item.id, name: item.name, status: item.status })),
    [{ id: inboxId, name: inboxName, status: 'queued' }],
    'post-script browser seed must be restored to one queued inbox item'
  )
  const browserMetadata = browserAcceptanceMetadata({
    base,
    inboxId,
    inboxName,
    inboxDirectory,
    installedEnv,
    phase: 'ready-for-browser-restart'
  })
  writeBrowserAcceptanceMetadata(browserMetadata)

  writeSummary({
    runId: context.runId,
    fixture: {
      version: p0Fixture.manifest.version,
      hubCommit: p0Fixture.hubHead,
      probeCommit: finalProbe.head,
      probeCloneMode: p0Fixture.manifest.probeCloneMode,
      probeDetached: finalProbe.detached,
      probeClean: finalProbe.clean,
      probeRemoteCount: finalProbe.remoteCount,
      probeAlternatesPresent: finalProbe.alternatesPresent,
      residentSkills: residentSkillNames.length,
      sourceProvenance: {
        schemaVersion: p0Fixture.manifest.sourceProvenance.schemaVersion,
        runIdentitySha256: p0Fixture.manifest.sourceProvenance.runIdentitySha256,
        fixtureVersion: p0Fixture.manifest.sourceProvenance.fixtureVersion,
        hubCommit: p0Fixture.manifest.sourceProvenance.hubCommit,
        probeCommit: p0Fixture.manifest.sourceProvenance.probeCommit,
        probeCloneMode: p0Fixture.manifest.sourceProvenance.probeCloneMode,
        probeAlternatesPresent: p0Fixture.manifest.sourceProvenance.probeAlternatesPresent,
        remoteRemoved: p0Fixture.manifest.sourceProvenance.remoteRemoved,
        declaredHubCommit: p0Fixture.manifest.sourceProvenance.declaredHubCommit,
        actualHubCommit: p0Fixture.manifest.sourceProvenance.actualHubCommit,
        skillsTree: p0Fixture.manifest.sourceProvenance.skillsTree,
        physicalSkillsSha256: p0Fixture.manifest.sourceProvenance.physicalSkillsSha256,
        physicalSkillsContentSha256: p0Fixture.manifest.sourceProvenance.physicalSkillsContentSha256,
        probeProjectionKind: p0Fixture.manifest.sourceProvenance.probeProjectionKind,
        probeProjectionSha256: p0Fixture.manifest.sourceProvenance.probeProjectionSha256,
        probeProjectionEntries: p0Fixture.manifest.sourceProvenance.probeProjectionEntries,
        skillsMaterializationPolicy: p0Fixture.manifest.sourceProvenance.skillsMaterializationPolicy,
        skillsGitManifestSha256: p0Fixture.manifest.sourceProvenance.skillsGitManifestSha256,
        skillsProjectionSha256: p0Fixture.manifest.sourceProvenance.skillsProjectionSha256,
        skillsProjectionEntries: p0Fixture.manifest.sourceProvenance.skillsProjectionEntries,
        skillsExactEntries: p0Fixture.manifest.sourceProvenance.skillsExactEntries,
        skillsCrlfEntries: p0Fixture.manifest.sourceProvenance.skillsCrlfEntries,
        skillsAttributesSha256: p0Fixture.manifest.sourceProvenance.skillsAttributesSha256,
        targetSkillsTree: p0Fixture.manifest.sourceProvenance.targetSkillsTree
      }
    },
    package: {
      name: packed.name,
      version: packed.version,
      filename: path.basename(packed.filename),
      shasum: packed.shasum,
      size: packed.size,
      privateDeepImportsBlocked: forbiddenInstalledSubpaths.length
    },
    isolation: {
      globalHostPathEntriesRemoved: isolated.removedPathEntries,
      inheritedGitVariablesCleared: true,
      isolatedGitConfig: true,
      dshHomeUnused: true,
      randomPort: port,
      portReleased: true,
      runIdProcessesAfterStop: 0
    },
    lifecycle: {
      setup: setup.ok,
      doctor: doctor.ok,
      healthStatus: health.response.status,
      healthPackageRootMatched: true,
      healthDataRootMatched: true,
      staticStatus: page.status,
      deepLinkStatus: deepPage.status,
      assetStatus: asset.status,
      assetBytes: assetBytes.byteLength,
      daemonStarted: true,
      daemonStopped: true,
      packageDataRootsSeparated: true,
      runtimeOnlyUnderDataRoot: true
    },
    application: {
      requestHash: traceEvidence.requestHash,
      httpReplayed: replay.meta.replayed,
      sessionEffects: 1,
      ledgerEffects: requestEntries.length,
      auditEffects: requestEvents.length,
      redactedSessionSecretCount: Object.keys(sessionSecrets).length,
      idleDaemonLedgerStable: true,
      requestConflictRejected: conflict.error.code,
      inboxRejected: rejected.data.item.status,
      cliHttpStatusEqual: true,
      seededInboxCliHttpLegacyEqual: true
    },
    invocationTrace: traceEvidence,
    ui: {
      acceptance: 'pending-real-browser',
      staticShellFetched: true,
      browserMetadataFile: browserAcceptanceFile,
      browserRestartReady: true,
      updateUrl: browserMetadata.routes.updateUrl,
      seededItem: browserMetadata.seed.item,
      browserDomStateConsistencyVerified: false,
      screenshotEvidence: null
    },
    processBoundary: {
      apiDirectDaemonChild: true,
      cliIntermediaryDescendants: 0,
      dshDescendants: 0
    }
  })
})
