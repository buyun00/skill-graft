import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
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
for (const candidate of [
  'E:\\ozdqp-skill-hub',
  'E:\\ozdqp-cli-attach-probe',
  'E:\\ozdqp-main-fix',
  'E:\\deepseek-harness-master'
]) {
  if (fs.existsSync(candidate)) protectedRoots.push(candidate)
}

const context = validateRealE2eEnvironment(process.env, { workspaceRoot: sourceRoot, protectedRoots })
assertRunLayoutOwned(context)

const packageName = 'ozdqp-skill-hub'
const installedPackageRoot = path.join(context.appRoot, 'node_modules', packageName)
const expectedSg = path.join(
  context.appRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'sg.cmd' : 'sg'
)
const workerFile = path.join(sourceRoot, 'test', 'support', 'p3-installed-real-worker.mjs')
const dshHome = path.join(context.homeRoot, 'dsh-home')
const appData = path.join(context.homeRoot, 'appdata')
const localAppData = path.join(context.homeRoot, 'localappdata')
const npmCache = path.join(context.homeRoot, 'npm-cache')
const npmPrefix = path.join(context.homeRoot, 'npm-prefix')
const tempRoot = path.join(context.homeRoot, 'temp')
const workerLogRoot = path.join(context.logsRoot, 'p3-workers')
const cutLogRoot = path.join(context.logsRoot, 'p3-cuts')
const summaryFile = path.join(context.logsRoot, 'p3-real-summary.json')
const traceKeyFile = path.join(context.logsRoot, '.invocation-trace-key')
const traceRoot = path.join(context.logsRoot, 'invocation-trace')
const workerOutputLimit = 64 * 1024
const leaseMs = 30_000
const legacyCheckpointTimeoutMs = 180_000
const selectedSkill = 'ozdqp-development'
const legacySiblingIgnoreBytes = [
  '/.gitignore',
  '/AGENTS.override.md',
  `/.agents/skills/${selectedSkill}`,
  '/.codex/local-overlay',
  ''
].join('\n')
const preservedProjectFiles = Object.freeze({
  'AGENTS.md': '# P3 installed-real project\n',
  'baloot_client/README.md': '# checkout recognition fixture\n',
  '.agents/skills/unity-skills/SKILL.md': '# project-owned unity-skills\n',
  '.agents/skills/project-owned/SKILL.md': '# project-owned local skill\n'
})
const runtimeAssetPaths = Object.freeze([
  'HubLib.ps1',
  'analyze-remote-skill-update.ps1',
  'attach-library.ps1',
  'checkout-rules.txt',
  'dispatch-hub-codex.ps1',
  'hooks/post-checkout',
  'hooks/reference-transaction',
  'manage-skill-visibility.ps1',
  'promote-inbox.ps1',
  'prompts/analyze.txt',
  'prompts/attach.txt',
  'prompts/chat.txt',
  'prompts/detach.txt',
  'prompts/edit.txt',
  'register-unity-skills.ps1',
  'start-codex-session.ps1',
  'sync-codex-worktree-overlay.ps1'
])

function comparable(target) {
  const resolved = path.resolve(target)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function samePath(left, right) {
  return comparable(left) === comparable(right)
}

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return Boolean(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
}

function isSameOrInside(root, target) {
  return samePath(root, target) || isInside(root, target)
}

function enclosingGitCheckout(target) {
  let cursor = path.resolve(target)
  for (;;) {
    if (fs.existsSync(path.join(cursor, '.git'))) return cursor
    const parent = path.dirname(cursor)
    if (samePath(parent, cursor)) return null
    cursor = parent
  }
}

function assertPlainDirectory(target, label) {
  assert.equal(fs.existsSync(target), true, `${label} must exist`)
  const stat = fs.lstatSync(target)
  assert.equal(stat.isDirectory() && !stat.isSymbolicLink(), true, `${label} must be a plain directory`)
  assert.equal(samePath(target, fs.realpathSync.native(target)), true, `${label} must resolve exactly`)
}

function assertPlainFile(target, label) {
  assert.equal(fs.existsSync(target), true, `${label} must exist`)
  const stat = fs.lstatSync(target)
  assert.equal(stat.isFile() && !stat.isSymbolicLink(), true, `${label} must be a plain file`)
  assert.equal(samePath(target, fs.realpathSync.native(target)), true, `${label} must resolve exactly`)
}

function assertPlainDirectoryChain(target, label) {
  const directories = []
  let cursor = path.resolve(target)
  for (;;) {
    directories.push(cursor)
    const parent = path.dirname(cursor)
    if (samePath(parent, cursor)) break
    cursor = parent
  }
  for (const directory of directories.reverse()) assertPlainDirectory(directory, label)
}

function assertEmptyDirectory(target, label) {
  assertPlainDirectory(target, label)
  assert.deepEqual(fs.readdirSync(target), [], `${label} must be fresh for this run-id`)
}

function assertOwned(target, firstSegment, label) {
  const resolved = path.resolve(target)
  assert.equal(isInside(context.runRoot, resolved), true, `${label} must stay inside the run root`)
  assert.equal(
    path.relative(context.runRoot, resolved).split(path.sep)[0].toLowerCase(),
    firstSegment.toLowerCase(),
    `${label} must stay under ${firstSegment}`
  )
  return resolved
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeText(file, value, options = undefined) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, value, options || 'utf8')
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex')
}

function sha256File(file) {
  return sha256Bytes(fs.readFileSync(file))
}

function treeManifest(root, { skip } = {}) {
  if (!fs.existsSync(root)) return []
  const rows = []
  function walk(absolute, relative) {
    const stat = fs.lstatSync(absolute)
    const portable = relative.split(path.sep).join('/')
    if (skip?.(portable, stat)) return
    if (stat.isSymbolicLink()) {
      rows.push({
        path: portable,
        kind: 'link',
        targetHash: `sha256:${sha256Bytes(Buffer.from(fs.readlinkSync(absolute), 'utf8'))}`
      })
      return
    }
    if (stat.isDirectory()) {
      if (portable) rows.push({ path: portable, kind: 'directory' })
      for (const name of fs.readdirSync(absolute).sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))) {
        walk(path.join(absolute, name), relative ? path.join(relative, name) : name)
      }
      return
    }
    assert.equal(stat.isFile(), true, `unexpected filesystem object in ${path.basename(root)}`)
    const bytes = fs.readFileSync(absolute)
    rows.push({ path: portable, kind: 'file', size: bytes.length, sha256: `sha256:${sha256Bytes(bytes)}` })
  }
  walk(root, '')
  return rows
}

function allStrings(value, output = []) {
  if (typeof value === 'string') output.push(value)
  else if (Array.isArray(value)) for (const entry of value) allStrings(entry, output)
  else if (value && typeof value === 'object') for (const entry of Object.values(value)) allStrings(entry, output)
  return output
}

function assertLocatorFree(value, locators, label) {
  const needles = locators.map((item) => path.resolve(item).replaceAll('\\', '/').toLowerCase())
  for (const candidate of allStrings(value)) {
    const normalized = candidate.replaceAll('\\', '/').toLowerCase()
    for (const needle of needles) {
      assert.equal(normalized.includes(needle), false, `${label} leaked a raw locator`)
    }
  }
}

function expandWindowsEnv(value, env) {
  if (process.platform !== 'win32') return value
  return value.replace(/%([^%]+)%/g, (_match, name) => env[name] || env[name.toUpperCase()] || '')
}

function commandCandidates(directory, command) {
  const names = process.platform === 'win32'
    ? [command, `${command}.cmd`, `${command}.exe`, `${command}.bat`, `${command}.ps1`]
    : [command]
  return names.map((name) => path.join(directory, name))
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
      if (fs.existsSync(candidate) && fs.lstatSync(candidate).isFile()) found.push(comparable(candidate))
    }
  }
  return [...new Set(found)]
}

function withoutGlobalHostBins(rawPath, env = process.env) {
  const kept = []
  const removed = []
  for (const entry of executableDirectories(rawPath, env)) {
    const ownsHostBin = ['sg', 'dsh'].some((command) =>
      commandCandidates(entry.expanded, command).some((candidate) => fs.existsSync(candidate)))
    if (ownsHostBin) removed.push(entry.expanded)
    else kept.push(entry.raw)
  }
  return { value: kept.join(path.delimiter), removed }
}

function deleteEnvironmentNames(environment, predicate) {
  for (const name of Object.keys(environment)) {
    if (predicate(name.toUpperCase())) delete environment[name]
  }
}

function isolatedEnvironment(port) {
  const sanitizedPath = withoutGlobalHostBins(process.env.PATH || '')
  assert.deepEqual(findOnPath('sg', sanitizedPath.value), [], 'sanitized PATH must not expose sg')
  assert.deepEqual(findOnPath('dsh', sanitizedPath.value), [], 'sanitized PATH must not expose dsh')
  const env = createIsolatedGitEnvironment(process.env, context.homeRoot)
  deleteEnvironmentNames(env, (name) => /^DSH_/.test(name)
    || ['NODE_AUTH_TOKEN', 'NPM_TOKEN', 'GITHUB_TOKEN'].includes(name))
  Object.assign(env, {
    HOME: context.homeRoot,
    USERPROFILE: context.homeRoot,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    TEMP: tempRoot,
    TMP: tempRoot,
    SKILL_GRAFT_HOME: context.hubDataRoot,
    HUB_ROOT: context.hubDataRoot,
    HUB_API_PORT: String(port),
    HUB_SPAWN_CODEX: '0',
    SKILL_GRAFT_INVOCATION_TRACE: '1',
    DSH_HOME: dshHome,
    SG_SKIP_PATH: '1',
    SG_SKIP_TASK: '1',
    npm_config_cache: npmCache,
    NPM_CONFIG_CACHE: npmCache,
    npm_config_prefix: npmPrefix,
    NPM_CONFIG_PREFIX: npmPrefix,
    npm_config_userconfig: path.join(context.homeRoot, '.npmrc'),
    NPM_CONFIG_USERCONFIG: path.join(context.homeRoot, '.npmrc'),
    PATH: sanitizedPath.value
  })
  return { env, removedPathEntries: sanitizedPath.removed }
}

function rootEnvironment(base, dataRoot, mode = 'both') {
  const env = { ...base }
  deleteEnvironmentNames(env, (name) => name === 'SKILL_GRAFT_HOME' || name === 'HUB_ROOT')
  if (mode === 'primary' || mode === 'both') env.SKILL_GRAFT_HOME = dataRoot
  if (mode === 'legacy' || mode === 'both') env.HUB_ROOT = dataRoot
  return env
}

function tail(value, limit = 6000) {
  const text = String(value || '')
  return text.length <= limit ? text : text.slice(-limit)
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

function runSg(args, env, { timeout = 120_000 } = {}) {
  const invocation = sgInvocation(args)
  return spawnSync(invocation.command, invocation.args, {
    cwd: context.appRoot,
    env,
    encoding: 'utf8',
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments === true,
    timeout,
    maxBuffer: 32 * 1024 * 1024
  })
}

function parseJson(result, label, expectedStatus = 0) {
  assert.equal(result.error, undefined, `${label} spawn failed: ${result.error?.message || ''}`)
  assert.equal(result.status, expectedStatus, `${label} exit ${result.status}: ${tail(result.stderr || result.stdout)}`)
  try {
    return JSON.parse(String(result.stdout || ''))
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error instanceof Error ? error.message : error}`)
  }
}

function typed(baseEnv, dataRoot, args, label, mode = 'both') {
  const requestId = `${label}-${context.runId}`
  const envelope = parseJson(runSg(
    [...args, '--contract-v1', '--request-id', requestId],
    rootEnvironment(baseEnv, dataRoot, mode)
  ), label)
  assert.equal(envelope.contractVersion, 1, `${label} contract version`)
  assert.equal(envelope.requestId, requestId, `${label} request id`)
  assert.equal(envelope.ok, true, `${label} Application failure: ${JSON.stringify(envelope.error || {})}`)
  assert.equal(envelope.meta?.handler, 'application.commandBus', `${label} Application handler`)
  return { envelope, requestId }
}

function typedFailure(baseEnv, dataRoot, args, label, expectedCode, mode = 'both') {
  const requestId = `${label}-${context.runId}`
  const result = runSg(
    [...args, '--contract-v1', '--request-id', requestId],
    rootEnvironment(baseEnv, dataRoot, mode)
  )
  assert.equal(result.error, undefined, `${label} spawn failed`)
  assert.notEqual(result.status, 0, `${label} must fail`)
  const envelope = parseJson(result, label, result.status)
  assert.equal(envelope.contractVersion, 1)
  assert.equal(envelope.requestId, requestId)
  assert.equal(envelope.ok, false)
  assert.equal(envelope.error?.code, expectedCode)
  return { envelope, requestId }
}

function runGit(cwd, args, baseEnv, label, { expectedStatus = 0 } = {}) {
  const result = spawnSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
    env: createIsolatedGitEnvironment(baseEnv, context.homeRoot),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 32 * 1024 * 1024
  })
  assert.equal(result.error, undefined, `${label} spawn failed`)
  assert.equal(result.status, expectedStatus, `${label}: ${tail(result.stderr || result.stdout)}`)
  return String(result.stdout || '').trim()
}

function gitPath(worktree, relative, env, label) {
  const value = runGit(worktree, ['rev-parse', '--git-path', relative], env, label)
  return path.resolve(worktree, value)
}

function gitAdmin(worktree, env, label) {
  return path.resolve(runGit(worktree, ['rev-parse', '--absolute-git-dir'], env, label))
}

function assertSameVolume(worktree, admin, label) {
  assert.equal(
    path.parse(path.resolve(worktree)).root.toLowerCase(),
    path.parse(path.resolve(admin)).root.toLowerCase(),
    `${label} must share a volume`
  )
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(worktree).dev, fs.statSync(admin).dev, `${label} must share a device`)
  }
}

function assertDifferentVolume(worktree, admin, label) {
  assert.notEqual(
    path.parse(path.resolve(worktree)).root.toLowerCase(),
    path.parse(path.resolve(admin)).root.toLowerCase(),
    `${label} must cross volumes`
  )
}

function validateCrossVolumeRoot() {
  const raw = String(process.env.SKILL_GRAFT_CROSS_VOLUME_ROOT || '').trim()
  assert.notEqual(raw, '', 'SKILL_GRAFT_CROSS_VOLUME_ROOT is required; P3 real acceptance never skips cross-volume evidence')
  assert.equal(path.isAbsolute(raw), true, 'cross-volume root must be absolute')
  const root = path.resolve(raw)
  assert.notEqual(samePath(root, path.parse(root).root), true, 'cross-volume root cannot be a volume root')
  assertPlainDirectoryChain(root, 'cross-volume root chain')
  assert.equal(enclosingGitCheckout(root), null, 'cross-volume root must not be inside a Git checkout')
  const home = path.resolve(os.homedir())
  for (const protectedRoot of [sourceRoot, context.runRoot, home, ...protectedRoots]) {
    if (!protectedRoot) continue
    assert.equal(
      isSameOrInside(protectedRoot, root) || isSameOrInside(root, protectedRoot),
      false,
      'cross-volume root must not overlap protected, live, home, or run roots'
    )
  }
  assert.notEqual(
    path.parse(root).root.toLowerCase(),
    path.parse(context.probeRoot).root.toLowerCase(),
    'cross-volume root must be on a different volume from the Git common repository'
  )
  const markerFile = path.join(root, '.skill-graft-e2e-cross-volume.json')
  assertPlainFile(markerFile, 'cross-volume ownership marker')
  const marker = readJson(markerFile)
  assert.equal(typeof marker?.root, 'string', 'cross-volume marker root must be an absolute string')
  assert.equal(path.isAbsolute(marker.root), true, 'cross-volume marker root must be absolute')
  assert.deepEqual(
    { version: marker.version, runId: marker.runId, root: comparable(marker.root) },
    { version: 1, runId: context.runId, root: comparable(root) },
    'cross-volume marker must own exactly this root and run-id'
  )
  assert.deepEqual(
    fs.readdirSync(root).sort(),
    [path.basename(markerFile)],
    'cross-volume root must be dedicated to this marker before the one allowed fixture child is created'
  )
  const child = path.join(root, `p3-cross-${context.runId}`)
  assert.equal(fs.existsSync(child), false, 'cross-volume fixture child must be fresh')
  return Object.freeze({ root, child, markerFile })
}

function ensurePlainOwnedDirectory(target, firstSegment, label) {
  assertOwned(target, firstSegment, label)
  if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true })
  assertPlainDirectoryChain(target, label)
}

function boundedBytes(value) {
  const raw = Buffer.isBuffer(value) ? value : Buffer.from(String(value || ''), 'utf8')
  return { captured: raw.subarray(0, workerOutputLimit), totalBytes: raw.length }
}

function workerEvidenceLabel(label) {
  assert.match(label, /^[A-Za-z0-9][A-Za-z0-9._-]{7,159}$/)
  return label
}

function persistWorkerEvidence({ label, phase, pid, code, signal, stdout, stderr, stdoutBytes, stderrBytes }) {
  const safeLabel = workerEvidenceLabel(label)
  assert.equal(['authorize-session', 'execute-cut'].includes(phase), true, 'worker phase is allowlisted')
  ensurePlainOwnedDirectory(workerLogRoot, 'logs', 'worker evidence root')
  const metadata = {
    schemaVersion: 1,
    phase,
    pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
    exit: {
      code: Number.isInteger(code) ? code : null,
      signal: typeof signal === 'string' && /^[A-Z0-9]+$/.test(signal) ? signal : null
    },
    streams: {}
  }
  for (const [name, captured, totalBytes] of [
    ['stdout', stdout, stdoutBytes],
    ['stderr', stderr, stderrBytes]
  ]) {
    assert.equal(Buffer.isBuffer(captured), true)
    assert.equal(Number.isSafeInteger(totalBytes) && totalBytes >= captured.length, true)
    const capturedText = captured.toString('utf8')
    assert.equal(/ownerToken|message|details/i.test(capturedText), false, `${name} worker evidence is redacted`)
    assertLocatorFree(capturedText, [context.runRoot, installedPackageRoot], `${name} worker evidence`)
    const file = path.join(workerLogRoot, `${safeLabel}.${name}.log`)
    fs.writeFileSync(file, captured, { flag: 'wx', mode: 0o600 })
    metadata.streams[name] = {
      totalBytes,
      capturedBytes: captured.length,
      truncated: totalBytes > captured.length,
      capturedSha256: `sha256:${sha256Bytes(captured)}`
    }
  }
  const serialized = JSON.stringify(metadata, null, 2)
  assert.equal(/ownerToken|message|details/i.test(serialized), false, 'worker metadata is redacted')
  assertLocatorFree(serialized, [context.runRoot, installedPackageRoot], 'worker metadata')
  fs.writeFileSync(path.join(workerLogRoot, `${safeLabel}.meta.json`), `${serialized}\n`, {
    encoding: 'utf8', flag: 'wx', mode: 0o600
  })
  return metadata
}

function parseLastWorkerLine(bytes, label) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes || '')
  const line = text.trim().split(/\r?\n/).filter(Boolean).at(-1)
  assert.ok(line, `${label} must emit one bounded JSON result`)
  const parsed = JSON.parse(line)
  assert.equal(parsed.schemaVersion, 1, `${label} worker schema`)
  assertLocatorFree(parsed, [context.runRoot, installedPackageRoot], `${label} worker output`)
  return parsed
}

function workerArguments({
  mode,
  operation,
  cut,
  worktree,
  requestId,
  planHash,
  migrationId,
  sessionId,
  readyFile,
  crossRoot
}) {
  return [
    workerFile,
    '--mode', mode,
    ...(operation ? ['--operation', operation] : []),
    ...(cut ? ['--cut', cut] : []),
    '--run-id', context.runId,
    '--run-root', context.runRoot,
    '--package-root', installedPackageRoot,
    '--data-root', context.hubDataRoot,
    '--worktree', worktree,
    ...(crossRoot ? ['--cross-root', crossRoot] : []),
    '--request-id', requestId,
    ...(planHash ? ['--plan-hash', planHash] : []),
    ...(migrationId ? ['--migration-id', migrationId] : []),
    ...(sessionId ? ['--session-id', sessionId] : []),
    ...(readyFile ? ['--ready-file', readyFile] : []),
    '--lease-ms', String(leaseMs)
  ]
}

function runAuthorizeWorker(baseEnv, worktree, label, crossRoot = undefined) {
  const args = workerArguments({
    mode: 'authorize-session',
    worktree,
    requestId: `${label}-request`,
    crossRoot
  })
  const result = spawnSync(process.execPath, args, {
    cwd: context.appRoot,
    env: rootEnvironment(baseEnv, context.hubDataRoot),
    encoding: null,
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024
  })
  const stdout = boundedBytes(result.stdout)
  const stderr = boundedBytes(result.stderr)
  const evidence = persistWorkerEvidence({
    label,
    phase: 'authorize-session',
    pid: result.pid,
    code: result.status,
    signal: result.signal,
    stdout: stdout.captured,
    stderr: stderr.captured,
    stdoutBytes: stdout.totalBytes,
    stderrBytes: stderr.totalBytes
  })
  assert.equal(result.error, undefined, `${label} spawn failed: ${JSON.stringify(evidence.streams)}`)
  assert.equal(result.status, 0, `${label} worker failed: ${JSON.stringify(evidence.streams)}`)
  assert.equal(stderr.totalBytes, 0, `${label} worker stderr must be empty`)
  const output = parseLastWorkerLine(stdout.captured, label)
  assert.deepEqual(
    { ok: output.ok, mode: output.mode, status: output.status },
    { ok: true, mode: 'authorize-session', status: 'running' }
  )
  assert.match(output.sessionId, /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/)
  assert.match(output.targetId, /^worktree:[a-f0-9]{24}$/)
  return output
}

function spawnCutWorker(baseEnv, tracker, options) {
  ensurePlainOwnedDirectory(cutLogRoot, 'logs', 'cut evidence root')
  assert.equal(fs.existsSync(options.readyFile), false, 'cut ready evidence must be fresh')
  const args = workerArguments({ mode: 'execute-cut', ...options })
  const child = tracker.track(spawn(process.execPath, args, {
    cwd: context.appRoot,
    env: rootEnvironment(baseEnv, context.hubDataRoot),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  }))
  child.p3Label = options.label
  child.p3Stdout = Buffer.alloc(0)
  child.p3Stderr = Buffer.alloc(0)
  child.p3StdoutBytes = 0
  child.p3StderrBytes = 0
  const capture = (field, chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    child[`${field}Bytes`] += bytes.length
    const remaining = workerOutputLimit - child[field].length
    if (remaining > 0) child[field] = Buffer.concat([child[field], bytes.subarray(0, remaining)])
  }
  child.stdout.on('data', (chunk) => capture('p3Stdout', chunk))
  child.stderr.on('data', (chunk) => capture('p3Stderr', chunk))
  child.p3Completion = new Promise((resolve, reject) => {
    child.once('close', (code, signal) => {
      try {
        persistWorkerEvidence({
          label: child.p3Label,
          phase: 'execute-cut',
          pid: child.pid,
          code,
          signal,
          stdout: child.p3Stdout,
          stderr: child.p3Stderr,
          stdoutBytes: child.p3StdoutBytes,
          stderrBytes: child.p3StderrBytes
        })
        resolve({ code, signal })
      } catch (error) {
        reject(error)
      }
    })
  })
  return child
}

async function waitForReadyOrWorkerExit(child, readyFile, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (fs.existsSync(readyFile)) {
      assertPlainFile(readyFile, `${child.p3Label} ready evidence`)
      assert.ok(fs.lstatSync(readyFile).size <= 4096, `${child.p3Label} ready evidence is bounded`)
      try {
        const ready = readJson(readyFile)
        if (ready?.schemaVersion === 1) return ready
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
      }
    }
    if (child.exitCode != null || child.signalCode != null) {
      await child.p3Completion
      const output = child.p3Stdout.length ? parseLastWorkerLine(child.p3Stdout, child.p3Label) : null
      throw new Error(`${child.p3Label} exited before its required checkpoint: ${JSON.stringify({
        exitCode: child.exitCode,
        signal: child.signalCode,
        output,
        stdoutSha256: `sha256:${sha256Bytes(child.p3Stdout)}`,
        stderrSha256: `sha256:${sha256Bytes(child.p3Stderr)}`
      })}`)
    }
    if (Date.now() >= deadline) throw new Error(`${child.p3Label} checkpoint timed out`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function killCutWorker(child) {
  assert.equal(child.kill('SIGKILL'), true, `${child.p3Label} must accept the owned kill`)
  const exited = await child.p3Completion
  assert.equal(exited.code, null, `${child.p3Label} must not exit cleanly at a crash cut`)
  assert.equal(exited.signal, 'SIGKILL', `${child.p3Label} crash signal`)
}

async function authorizeWaitingSession(baseEnv, worktree, label, crossRoot = undefined) {
  const started = runAuthorizeWorker(baseEnv, worktree, label, crossRoot)
  const reaped = typed(baseEnv, context.hubDataRoot, [
    'session', '--id', started.sessionId
  ], `${label}-reap`).envelope.data.session
  assert.equal(reaped.id, started.sessionId)
  assert.equal(reaped.status, 'waiting')
  assert.equal(reaped.exitCode, 0)
  assert.equal(reaped.target?.id, started.targetId)
  assertLocatorFree(reaped, [worktree, context.runRoot], `${label} public session`)
  return reaped
}

function listening18765() {
  if (process.platform !== 'win32') return []
  const result = spawnSync('netstat.exe', ['-ano', '-p', 'tcp'], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000
  })
  assert.equal(result.status, 0, `netstat failed: ${result.stderr || result.stdout}`)
  return String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter((line) => {
    const fields = line.split(/\s+/)
    return fields.length >= 5 && /:18765$/.test(fields[1]) && fields[3].toUpperCase() === 'LISTENING'
  }).map((line) => Number(line.split(/\s+/).at(-1))).filter(Number.isSafeInteger).sort((a, b) => a - b)
}

function runOwnedProcesses() {
  if (process.platform !== 'win32') return []
  const escaped = context.runId.replaceAll("'", "''")
  const script = [
    "$rows = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -in @('node.exe','cmd.exe','codex.exe','dsh.exe') }",
    `$rows | Where-Object { [string]$_.CommandLine -like '*${escaped}*' } | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress`
  ].join('; ')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000
  })
  assert.equal(result.status, 0, `owned process inspection failed: ${result.stderr || result.stdout}`)
  const text = String(result.stdout || '').trim()
  if (!text) return []
  const rows = JSON.parse(text)
  return (Array.isArray(rows) ? rows : [rows]).filter((row) => Number(row.ProcessId) !== process.pid)
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForHealth(port, expected, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let healthy = false
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(750) })
      healthy = response.ok && (await response.json()).ok === true
    } catch {
      healthy = false
    }
    if (healthy === expected) return healthy
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return healthy
}

async function waitForDaemonStatus(env, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    const result = runSg(['daemon', 'status'], env)
    if (!result.error && result.status === 0) {
      try {
        last = JSON.parse(String(result.stdout || ''))
        if (last.running === true && last.apiHealthy === true && last.heartbeat?.apiHealthy === true) return last
      } catch { /* keep polling the marker-owned daemon */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`daemon did not become healthy: ${JSON.stringify(last)}`)
}

async function startDaemon(env, tracker, port, label) {
  const started = parseJson(runSg(['daemon', 'start'], env), `${label} daemon start`)
  assert.equal(started.ok, true, `${label} daemon start`)
  const daemonPid = Number(started.pid)
  assert.equal(Number.isSafeInteger(daemonPid) && daemonPid > 0, true)
  tracker.trackPid(daemonPid, { commandIncludes: context.runId })
  let status
  try {
    status = await waitForDaemonStatus(env)
  } catch (error) {
    try { runSg(['daemon', 'stop'], env) } catch { /* tracker still owns the reported daemon PID */ }
    throw error
  }
  const apiPid = Number(status.apiPid)
  assert.equal(Number(status.pid), daemonPid, `${label} daemon start/status PID`)
  assert.equal(Number.isSafeInteger(apiPid) && apiPid > 0, true)
  tracker.trackPid(apiPid, { commandIncludes: context.runId })
  assert.equal(await waitForHealth(port, true), true, `${label} daemon health`)
  assert.equal(comparable(status.heartbeat.dataRoot), comparable(context.hubDataRoot))
  assert.equal(comparable(status.heartbeat.packageRoot), comparable(installedPackageRoot))
  return { daemonPid, apiPid, base: `http://127.0.0.1:${port}` }
}

async function stopDaemon(env, daemon, label) {
  const stopped = parseJson(runSg(['daemon', 'stop'], env), `${label} daemon stop`)
  assert.equal(stopped.ok, true, `${label} daemon stop`)
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && (pidAlive(daemon.daemonPid) || pidAlive(daemon.apiPid))) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.equal(pidAlive(daemon.daemonPid), false, `${label} daemon process stopped`)
  assert.equal(pidAlive(daemon.apiPid), false, `${label} API process stopped`)
  assert.equal(await waitForHealth(Number(new URL(daemon.base).port), false, 3_000), false, `${label} port released`)
}

async function postCommand(base, payload, label) {
  const response = await fetch(`${base}/api/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120_000)
  })
  const body = await response.json()
  assert.equal(response.status, 200, `${label} HTTP status`)
  assert.equal(body.contractVersion, 1, `${label} contract`)
  assert.equal(body.meta?.handler, 'application.commandBus', `${label} handler`)
  return body
}

function createRepositoryFixture(baseEnv) {
  const common = assertOwned(path.join(context.probeRoot, 'p3-common-repository'), 'probe', 'common repository')
  fs.mkdirSync(path.join(common, '.agents', 'skills', selectedSkill), { recursive: true })
  for (const [relative, bytes] of Object.entries(preservedProjectFiles)) {
    writeText(path.join(common, ...relative.split('/')), bytes)
  }
  writeText(path.join(common, '.agents', 'skills', selectedSkill, 'tracked.txt'), 'tracked-baseline\n')
  writeText(path.join(common, 'protected-sentinel.txt'), `protected ${context.runId}\n`)
  writeText(path.join(common, 'project-revision.txt'), 'revision A\n')
  runGit(common, ['init'], baseEnv, 'common git init')
  runGit(common, ['config', 'user.name', 'Skill Graft P3'], baseEnv, 'common git user')
  runGit(common, ['config', 'user.email', 'skill-graft-p3@example.invalid'], baseEnv, 'common git email')
  runGit(common, ['config', 'extensions.worktreeConfig', 'true'], baseEnv, 'enable worktree config')
  runGit(common, ['add', '--', 'AGENTS.md', 'baloot_client', '.agents/skills', 'protected-sentinel.txt', 'project-revision.txt'], baseEnv, 'common git add A')
  runGit(common, ['commit', '-m', 'P3 fixture A'], baseEnv, 'common git commit A')
  const commitA = runGit(common, ['rev-parse', 'HEAD'], baseEnv, 'common commit A')
  writeText(path.join(common, 'project-revision.txt'), 'revision B\n')
  runGit(common, ['add', '--', 'project-revision.txt'], baseEnv, 'common git add B')
  runGit(common, ['commit', '-m', 'P3 fixture B'], baseEnv, 'common git commit B')
  const commitB = runGit(common, ['rev-parse', 'HEAD'], baseEnv, 'common commit B')
  assert.notEqual(commitA, commitB)
  assert.equal(runGit(common, ['remote'], baseEnv, 'common remotes'), '', 'fixture repository has no remote')

  const worktrees = {}
  for (const name of ['ordinary', 'unmanaged', 'legacy']) {
    const worktree = assertOwned(path.join(context.probeRoot, `p3-${name}`), 'probe', `${name} worktree`)
    runGit(common, ['worktree', 'add', '--detach', worktree, commitB], baseEnv, `add ${name} worktree`)
    assertPlainDirectoryChain(worktree, `${name} worktree chain`)
    const admin = gitAdmin(worktree, baseEnv, `${name} admin`)
    assertSameVolume(worktree, admin, `${name} worktree/admin`)
    assert.equal(runGit(worktree, ['rev-parse', 'HEAD'], baseEnv, `${name} HEAD`), commitB)
    worktrees[name] = { root: worktree, admin }
  }

  const baseExclude = path.join(worktrees.ordinary.root, '.p3-base-excludes')
  writeText(baseExclude, 'sentinel-a.tmp\n')
  for (const name of ['sentinel-a.tmp', 'sentinel-b.tmp', 'sentinel-c.tmp']) {
    writeText(path.join(worktrees.ordinary.root, name), `${name}\n`)
  }
  runGit(worktrees.ordinary.root, [
    'config', '--worktree', 'core.excludesFile', baseExclude
  ], baseEnv, 'ordinary base excludes config')
  fs.rmSync(path.join(worktrees.ordinary.root, '.agents', 'skills', selectedSkill), { recursive: true, force: true })

  return Object.freeze({ common, commitA, commitB, baseExclude, ...worktrees })
}

function seedLibraryV1(dataRoot) {
  assertOwned(dataRoot, 'hub-data', 'P3 data root')
  writeText(path.join(dataRoot, 'AGENTS.override.md'), '# P3 override A\n')
  writeText(path.join(dataRoot, 'skills', selectedSkill, 'SKILL.md'), '# ozdqp-development A\n')
  writeText(path.join(dataRoot, 'skills', selectedSkill, 'tracked.txt'), 'tracked-baseline\n')
  writeText(path.join(dataRoot, 'skills', 'ozdqp-ui-development', 'SKILL.md'), '# UI A\n')
  writeText(path.join(dataRoot, 'skills', 'ozdqp-git-workflow', 'SKILL.md'), '# Git A\n')
  writeText(path.join(dataRoot, 'overlay', 'attached-worktrees.txt'), '')
  writeText(path.join(dataRoot, 'overlay', 'scan-roots.txt'), '')
  writeText(path.join(dataRoot, 'overlay', 'do-not-auto-attach.txt'), '')
  writeText(path.join(dataRoot, 'skill-review', 'state.json'), `${JSON.stringify({
    version: 1,
    stateRevision: 1,
    items: [],
    lastIngest: null
  }, null, 2)}\n`)
}

function mutateLibraryB(dataRoot) {
  writeText(path.join(dataRoot, 'AGENTS.override.md'), '# P3 override B\n')
  writeText(path.join(dataRoot, 'skills', selectedSkill, 'SKILL.md'), '# ozdqp-development B\n')
}

function copyInstalledRuntimeToLegacySource(dataRoot) {
  const targetRoot = path.join(dataRoot, 'overlay')
  fs.rmSync(targetRoot, { recursive: true, force: true })
  fs.mkdirSync(targetRoot, { recursive: true })
  for (const relative of runtimeAssetPaths) {
    const source = path.join(installedPackageRoot, 'overlay', ...relative.split('/'))
    const target = path.join(targetRoot, ...relative.split('/'))
    assertPlainFile(source, `installed runtime asset ${relative}`)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL)
  }
  assert.deepEqual(
    treeManifest(targetRoot).filter((entry) => entry.kind === 'file').map((entry) => entry.path),
    [...runtimeAssetPaths].sort((left, right) => Buffer.from(left).compare(Buffer.from(right))),
    'legacy runtime source contains only the installed fixed asset allowlist'
  )
}

function seedLegacyLinks(fixture, baseEnv) {
  const worktree = fixture.legacy.root
  const override = path.join(worktree, 'AGENTS.override.md')
  const skill = path.join(worktree, '.agents', 'skills', selectedSkill)
  const overlay = path.join(worktree, '.codex', 'local-overlay')
  fs.rmSync(override, { force: true })
  fs.rmSync(skill, { recursive: true, force: true })
  fs.rmSync(overlay, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(skill), { recursive: true })
  fs.mkdirSync(path.dirname(overlay), { recursive: true })
  fs.linkSync(path.join(context.hubDataRoot, 'AGENTS.override.md'), override)
  fs.symlinkSync(
    path.join(context.hubDataRoot, 'skills', selectedSkill),
    skill,
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  fs.symlinkSync(
    path.join(context.hubDataRoot, 'overlay'),
    overlay,
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  assert.equal(fs.lstatSync(override).nlink >= 2, true, 'legacy override is a hardlink')
  assert.equal(fs.lstatSync(skill).isSymbolicLink(), true, 'legacy skill is a directory link')
  assert.equal(fs.lstatSync(overlay).isSymbolicLink(), true, 'legacy overlay is a directory link')

  const commonExclude = gitPath(worktree, 'info/exclude', baseEnv, 'legacy common exclude')
  fs.appendFileSync(commonExclude, Buffer.from([
    'project-owned-pattern',
    '/AGENTS.override.md',
    `/.agents/skills/${selectedSkill}`,
    '/.codex/local-overlay',
    ''
  ].join('\r\n'), 'utf8'))
  return Object.freeze({ worktree, override, skill, overlay, commonExclude })
}

function siblingWorktreeManifest(name, root) {
  return treeManifest(root, {
    skip: name === 'common' ? (relative) => relative === '.git' : undefined
  })
}

function seedEquivalentLegacySiblingVisibility(fixture, baseEnv) {
  return Object.freeze([
    ['common', fixture.common],
    ['ordinary', fixture.ordinary.root],
    ['unmanaged', fixture.unmanaged.root]
  ].map(([name, root]) => {
    const ignoreFile = path.join(root, '.gitignore')
    const statusBefore = runGit(
      root,
      ['status', '--porcelain=v1', '--untracked-files=all'],
      baseEnv,
      `${name} status before legacy sibling visibility`
    )
    assert.equal(fs.existsSync(ignoreFile), false, `${name} sibling ignore starts absent`)
    fs.writeFileSync(ignoreFile, legacySiblingIgnoreBytes, { encoding: 'utf8', flag: 'wx' })
    const ignored = runGit(root, [
      'check-ignore', '-v', '--no-index', '--',
      'AGENTS.override.md', `.agents/skills/${selectedSkill}`, '.codex/local-overlay'
    ], baseEnv, `${name} equivalent sibling visibility`).split(/\r?\n/)
    assert.equal(ignored.length, 3, `${name} sibling rules cover every controlled target`)
    assert.equal(
      ignored.every((line) => line.includes('.gitignore:')),
      true,
      `${name} sibling visibility comes from its worktree-local ignore`
    )
    assert.equal(
      runGit(
        root,
        ['status', '--porcelain=v1', '--untracked-files=all'],
        baseEnv,
        `${name} status after legacy sibling visibility`
      ),
      statusBefore,
      `${name} sibling visibility fixture does not change Git status`
    )
    return Object.freeze({
      name,
      root,
      ignoreFile,
      ignoreBytes: fs.readFileSync(ignoreFile).toString('base64'),
      status: statusBefore,
      worktree: siblingWorktreeManifest(name, root)
    })
  }))
}

function assertEquivalentLegacySiblingVisibility(siblings, baseEnv, label) {
  for (const sibling of siblings) {
    assert.equal(
      fs.readFileSync(sibling.ignoreFile).toString('base64'),
      sibling.ignoreBytes,
      `${label} preserves ${sibling.name} sibling ignore bytes`
    )
    assert.equal(
      runGit(
        sibling.root,
        ['status', '--porcelain=v1', '--untracked-files=all'],
        baseEnv,
        `${label} ${sibling.name} status`
      ),
      sibling.status,
      `${label} preserves ${sibling.name} Git status`
    )
    assert.deepEqual(
      siblingWorktreeManifest(sibling.name, sibling.root),
      sibling.worktree,
      `${label} preserves ${sibling.name} sibling worktree bytes`
    )
  }
}

function assertLegacyLinks(legacy, expected) {
  assert.equal(fs.lstatSync(legacy.override).nlink >= 2, expected, 'legacy override link state')
  assert.equal(fs.lstatSync(legacy.skill).isSymbolicLink(), expected, 'legacy skill link state')
  assert.equal(fs.lstatSync(legacy.overlay).isSymbolicLink(), expected, 'legacy overlay link state')
  if (expected) {
    assert.equal(
      comparable(fs.realpathSync.native(legacy.skill)),
      comparable(path.join(context.hubDataRoot, 'skills', selectedSkill))
    )
    assert.equal(
      comparable(fs.realpathSync.native(legacy.overlay)),
      comparable(path.join(context.hubDataRoot, 'overlay'))
    )
  } else {
    assert.equal(fs.lstatSync(legacy.override).isFile(), true)
    assert.equal(fs.lstatSync(legacy.skill).isDirectory(), true)
    assert.equal(fs.lstatSync(legacy.overlay).isDirectory(), true)
  }
}

function stateV2() {
  const state = readJson(path.join(context.hubDataRoot, 'skill-review', 'state.json'))
  assert.equal(state.schemaVersion, 2)
  return state
}

function completedLedgerEntry(requestId, commandKind) {
  const ledger = readJson(path.join(context.hubDataRoot, 'skill-review', 'application-ledger.json'))
  const entry = ledger.entries.find((candidate) => candidate.requestId === requestId)
  assert.equal(entry?.status, 'completed', `${commandKind} ledger completion`)
  assert.equal(entry?.commandKind, commandKind)
  return entry
}

function currentRecordFile(pathKey) {
  return path.join(
    context.hubDataRoot,
    'skill-review',
    'materializations',
    'current',
    `${pathKey.slice('sha256:'.length)}.json`
  )
}

function migrationRecordFile(migrationId) {
  return path.join(
    context.hubDataRoot,
    'skill-review',
    'materializations',
    'migrations',
    `${migrationId.slice('sha256:'.length)}.json`
  )
}

function sessionStoreEntry(sessionId) {
  const sessions = readJson(path.join(context.hubDataRoot, 'skill-review', 'sessions.json')).sessions
  const session = sessions.find((candidate) => candidate.id === sessionId)
  assert.ok(session, `session ${sessionId} must persist`)
  return session
}

function assertOrdinaryDurableProof({ worktree, pathKey, sessionId, requestId }) {
  const pin = stateV2().worktrees[pathKey]
  const current = readJson(currentRecordFile(pathKey))
  const proof = sessionStoreEntry(sessionId).attachCompletion
  const ledger = completedLedgerEntry(requestId, 'sync')
  assert.equal(pin.pathKey, pathKey)
  assert.equal(pin.materializedSnapshot, current.marker.snapshotId)
  assert.equal(proof.pathKey, pathKey)
  assert.equal(proof.targetId, pin.worktreeId)
  assert.equal(proof.materializationId, current.marker.materializationId)
  assertLocatorFree(pin, [worktree, context.runRoot], 'durable pin')
  assertLocatorFree(current, [worktree, context.runRoot], 'durable current materialization')
  assertLocatorFree(proof, [worktree, context.runRoot], 'durable session completion proof')
  assertLocatorFree(ledger.result, [worktree, context.runRoot], 'durable sync ledger result')
}

function invocationRows() {
  if (!fs.existsSync(traceRoot)) return []
  return fs.readdirSync(traceRoot).filter((name) => name.endsWith('.jsonl')).flatMap((name) =>
    fs.readFileSync(path.join(traceRoot, name), 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)))
}

function noEnvHookEnvironment(baseEnv) {
  const env = { ...baseEnv, HUB_SPAWN_CODEX: '0' }
  deleteEnvironmentNames(env, (name) => name === 'SKILL_GRAFT_HOME' || name === 'HUB_ROOT')
  return env
}

function entriesRecursively(root) {
  return treeManifest(root)
}

function assertNoDataResidue() {
  assert.deepEqual(entriesRecursively(path.join(context.hubDataRoot, '.skill-graft-transactions')), [], 'no durable WAL/tmp/bak residue')
  for (const relative of [
    'skill-review/daemon.pid',
    'skill-review/api.pid',
    'skill-review/daemon-heartbeat.json',
    'skill-review/daemon-stop.request'
  ]) assert.equal(fs.existsSync(path.join(context.hubDataRoot, ...relative.split('/'))), false, `no ${relative} residue`)
  for (const relative of [
    ['skill-review', 'locks', 'leases'],
    ['skill-review', 'locks', 'staging'],
    ['skill-review', 'locks', 'retired']
  ]) {
    assert.deepEqual(entriesRecursively(path.join(context.hubDataRoot, ...relative)), [], `${relative.join('/')} has no residue`)
  }
}

function assertNoGitResidue(worktrees, baseEnv) {
  for (const [name, worktree] of Object.entries(worktrees)) {
    if (!fs.existsSync(worktree)) continue
    const admin = gitAdmin(worktree, baseEnv, `${name} final admin`)
    for (const relative of ['skill-graft/transactions', 'skill-graft/legacy-transactions']) {
      const root = gitPath(worktree, relative, baseEnv, `${name} ${relative}`)
      const rows = entriesRecursively(root)
      assert.deepEqual(rows, [], `${name} ${relative} is empty`)
      assert.equal(rows.some((entry) => /(?:token|\.prepare|\.finalize)/i.test(entry.path)), false)
    }
    const lockCandidates = [
      `${gitPath(worktree, 'config.worktree', baseEnv, `${name} config.worktree`)}.lock`,
      `${gitPath(worktree, 'index', baseEnv, `${name} index`)}.lock`,
      `${gitPath(worktree, 'skill-graft/excludes-v1', baseEnv, `${name} excludes`)}.lock`,
      `${gitPath(worktree, 'skill-graft/materialized-v1.json', baseEnv, `${name} marker`)}.lock`
    ]
    for (const candidate of lockCandidates) assert.equal(fs.existsSync(candidate), false, `${name} owned lock is absent`)
    assert.deepEqual(
      treeManifest(admin).filter((entry) => entry.kind === 'file' && entry.path.endsWith('.lock')),
      [],
      `${name} Git admin has no owned lock file`
    )
    const commonDirValue = runGit(worktree, ['rev-parse', '--git-common-dir'], baseEnv, `${name} common Git dir`)
    const commonDir = path.resolve(worktree, commonDirValue)
    assert.deepEqual(
      treeManifest(commonDir).filter((entry) => entry.kind === 'file' && entry.path.endsWith('.lock')),
      [],
      `${name} common Git admin has no lock file`
    )
    assert.equal(
      treeManifest(admin).some((entry) => entry.kind === 'file' && /(?:^|\/)\.?(?:prepare|finalize|token)[^/]*$/i.test(entry.path)),
      false,
      `${name} admin has no private transaction sidecar residue`
    )
  }
}

function assertInstalledPackageStateless(baseline) {
  for (const relative of [
    'skill-review/state.json',
    'skill-review/application-ledger.json',
    'skill-review/application-audit.json',
    'skill-review/daemon.pid',
    'skill-review/api.pid',
    '.skill-graft-transactions'
  ]) assert.equal(fs.existsSync(path.join(installedPackageRoot, ...relative.split('/'))), false, `package root excludes ${relative}`)
  assert.deepEqual(treeManifest(installedPackageRoot), baseline, 'installed package remains byte-for-byte stateless')
}

function writeSummary(value) {
  const serialized = JSON.stringify(value, null, 2)
  assert.equal(/ownerToken|message|details/i.test(serialized), false, 'summary is redacted')
  assertLocatorFree(serialized, [
    context.runRoot,
    context.hubDataRoot,
    context.probeRoot,
    installedPackageRoot,
    sourceRoot
  ], 'summary')
  fs.writeFileSync(summaryFile, `${serialized}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
}

test('installed Local P3 materialization preserves session, hook, daemon, legacy, WAL, and layout contracts', {
  timeout: 30 * 60 * 1000
}, async (t) => {
  assert.equal(process.platform, 'win32', 'P3 installed-real acceptance requires native Windows evidence')
  assertEmptyDirectory(context.appRoot, 'app root')
  assertEmptyDirectory(context.homeRoot, 'home root')
  assertEmptyDirectory(context.hubDataRoot, 'hub-data root')
  assertEmptyDirectory(context.probeRoot, 'probe root')
  assertEmptyDirectory(context.logsRoot, 'logs root')
  assert.equal(comparable(context.cliPath), comparable(expectedSg), 'SKILL_GRAFT_CLI must be the isolated npm sg shim')
  assertPlainFile(workerFile, 'P3 installed-real worker')
  const crossVolume = validateCrossVolumeRoot()
  const crossRootBaseline = treeManifest(crossVolume.root)
  const listener18765Before = listening18765()
  assert.deepEqual(runOwnedProcesses(), [], 'no marker-owned process may predate the P3 run')

  const tracker = new ProcessTracker({ runId: context.runId })
  let activeDaemon = null
  let crossAdded = false
  let fixture
  let cleanupGitEnv = process.env
  t.after(async () => {
    if (activeDaemon && fs.existsSync(context.cliPath)) {
      try { await stopDaemon(activeDaemon.env, activeDaemon.processes, 'after-hook cleanup') } catch { /* tracker remains authoritative */ }
    }
    if (crossAdded && fixture?.common && fs.existsSync(crossVolume.child)) {
      try {
        runGit(fixture.common, ['worktree', 'remove', '--force', crossVolume.child], cleanupGitEnv, 'cleanup cross worktree')
      } catch { /* preserve the exact marker-owned child for diagnosis */ }
    }
    await tracker.stopAll({ graceMs: 750 })
  })

  for (const directory of [appData, localAppData, npmCache, npmPrefix, tempRoot, dshHome]) {
    fs.mkdirSync(directory, { recursive: true })
  }
  writeText(path.join(context.homeRoot, '.npmrc'), '')
  const traceKey = randomBytes(32)
  fs.writeFileSync(traceKeyFile, traceKey, { flag: 'wx', mode: 0o600 })
  assertPlainFile(traceKeyFile, 'invocation trace key')
  assert.equal(fs.lstatSync(traceKeyFile).size, 32)
  assert.deepEqual(fs.readdirSync(dshHome), [], 'DSH_HOME starts empty')

  const selectedPort = await getAvailableLoopbackPort({ forbidden: [18765, 3080] })
  const isolated = isolatedEnvironment(selectedPort)
  const baseEnv = isolated.env
  cleanupGitEnv = baseEnv

  const packRoot = path.join(context.appRoot, 'package')
  fs.mkdirSync(packRoot, { recursive: true })
  const packedRows = parseJson(
    runNpm(['pack', '--json', '--pack-destination', packRoot], sourceRoot, baseEnv),
    'P3 npm pack'
  )
  assert.equal(Array.isArray(packedRows), true)
  assert.equal(packedRows.length, 1)
  const packed = packedRows[0]
  const tarball = path.resolve(packRoot, packed.filename)
  assert.equal(isInside(context.runRoot, tarball), true, 'tarball is marker-owned')
  assertPlainFile(tarball, 'P3 release tarball')
  const packPaths = (packed.files || []).map((entry) => String(entry.path).replaceAll('\\', '/'))
  for (const required of [
    'dist/control/cli.js',
    'dist/application/hub-application.js',
    'dist/local/create-local-host.js',
    'dist/adapters/local-materializer.js',
    'dist/adapters/local-runtime-assets.js',
    'dist/adapters/local-materialization-records.js',
    'dist/adapters/durable-state.js',
    'server/index.mjs',
    'overlay/hooks/post-checkout',
    'overlay/hooks/reference-transaction'
  ]) assert.equal(packPaths.includes(required), true, `${required} must ship`)
  for (const forbidden of [
    'src/', 'test/', 'docs/', 'scripts/', 'artifacts/', 'skill-review/',
    '.skill-graft-transactions/', 'overlay/attached-worktrees.txt',
    'overlay/scan-roots.txt', 'overlay/do-not-auto-attach.txt'
  ]) {
    assert.equal(
      packPaths.some((file) => file === forbidden || file.startsWith(forbidden)),
      false,
      `${forbidden} is excluded from the release`
    )
  }

  const installed = runNpm([
    'install', '--prefix', context.appRoot, '--ignore-scripts', '--no-audit', '--no-fund',
    '--no-package-lock', tarball
  ], context.appRoot, baseEnv)
  assert.equal(installed.error, undefined, `npm install spawn: ${installed.error?.message || ''}`)
  assert.equal(installed.status, 0, `npm install: ${tail(installed.stderr || installed.stdout)}`)
  assertPlainFile(context.cliPath, 'absolute installed sg')
  assertPlainDirectoryChain(installedPackageRoot, 'installed package chain')
  assert.equal(fs.existsSync(path.join(installedPackageRoot, 'src')), false)
  assert.equal(fs.existsSync(path.join(installedPackageRoot, 'test')), false)
  assert.equal(fs.existsSync(path.join(installedPackageRoot, 'skill-review')), false)
  assert.deepEqual(findOnPath('sg', baseEnv.PATH, baseEnv), [], 'only the absolute sg shim is accepted')
  assert.deepEqual(findOnPath('dsh', baseEnv.PATH, baseEnv), [], 'DSH stays unavailable')
  const installedPackageBaseline = treeManifest(installedPackageRoot)

  fixture = createRepositoryFixture(baseEnv)
  assert.match(runGit(fixture.ordinary.root, [
    'ls-files', '-v', '--', `.agents/skills/${selectedSkill}/tracked.txt`
  ], baseEnv, 'ordinary initial H'), /^H /)
  seedLibraryV1(context.hubDataRoot)
  const legacySchema = typed(baseEnv, context.hubDataRoot, ['inspect-schema'], 'p3-schema-legacy').envelope.data
  assert.deepEqual(
    { status: legacySchema.status, detected: legacySchema.detectedSchemaVersion, current: legacySchema.currentSchemaVersion },
    { status: 'legacy', detected: 1, current: 2 }
  )

  const snapshotAResult = typed(baseEnv, context.hubDataRoot, ['snapshot', 'create'], 'p3-snapshot-a')
  const snapshotA = snapshotAResult.envelope.data.snapshot
  assert.match(snapshotA.snapshotId, /^sha256:[a-f0-9]{64}$/)
  assert.equal(snapshotA.files.some((entry) => entry.path === 'AGENTS.override.md'), true)
  assert.equal(snapshotA.files.some((entry) => entry.path === `skills/${selectedSkill}/SKILL.md`), true)
  assert.equal(snapshotA.files.some((entry) => entry.path.startsWith('overlay/')), false)
  while (Date.now() <= Date.parse(snapshotA.createdAt)) await new Promise((resolve) => setTimeout(resolve, 10))
  mutateLibraryB(context.hubDataRoot)
  const snapshotBResult = typed(baseEnv, context.hubDataRoot, ['snapshot', 'create'], 'p3-snapshot-b')
  const snapshotB = snapshotBResult.envelope.data.snapshot
  assert.match(snapshotB.snapshotId, /^sha256:[a-f0-9]{64}$/)
  assert.notEqual(snapshotB.snapshotId, snapshotA.snapshotId)
  assert.ok(Date.parse(snapshotB.createdAt) > Date.parse(snapshotA.createdAt))

  const migrationDry = typed(baseEnv, context.hubDataRoot, [
    'migrate-state', '--dry-run'
  ], 'p3-state-migrate-dry').envelope.data
  assert.equal(migrationDry.status, 'planned')
  assert.equal(migrationDry.plan.targetState.librarySnapshots.includes(snapshotB.snapshotId), true)
  const migrationCommit = typed(baseEnv, context.hubDataRoot, [
    'migrate-state', '--commit', '--plan-hash', migrationDry.plan.planHash
  ], 'p3-state-migrate-commit').envelope.data
  assert.equal(migrationCommit.status, 'committed')
  assert.equal(migrationCommit.state.schemaVersion, 2)
  assert.deepEqual(migrationCommit.state.librarySnapshots, [snapshotA.snapshotId, snapshotB.snapshotId].sort())
  const currentSchema = typed(baseEnv, context.hubDataRoot, ['inspect-schema'], 'p3-schema-current').envelope.data
  assert.deepEqual(
    { status: currentSchema.status, detected: currentSchema.detectedSchemaVersion, current: currentSchema.currentSchemaVersion },
    { status: 'current', detected: 2, current: 2 }
  )

  const ordinarySession = await authorizeWaitingSession(
    baseEnv,
    fixture.ordinary.root,
    `p3-ordinary-session-${context.runId}`
  )
  const ordinaryClaim = typed(baseEnv, context.hubDataRoot, [
    'claim', '--worktree', fixture.ordinary.root,
    '--snapshot', snapshotA.snapshotId,
    '--session-id', ordinarySession.id,
    '--skill', selectedSkill
  ], 'p3-ordinary-claim')
  assert.equal(ordinaryClaim.envelope.data.changed, true)
  assert.equal(ordinaryClaim.envelope.data.pin.claimState, 'claimed')
  assert.equal(ordinaryClaim.envelope.data.pin.materializedSnapshot, null)
  assertLocatorFree(ordinaryClaim.envelope, [fixture.ordinary.root, context.runRoot], 'ordinary claim envelope')

  const ordinaryPlanA = typed(baseEnv, context.hubDataRoot, [
    'plan-sync', '--worktree', fixture.ordinary.root
  ], 'p3-ordinary-plan-a').envelope.data
  assert.equal(ordinaryPlanA.status, 'planned')
  assert.equal(ordinaryPlanA.plan.executable, true)
  assert.equal(ordinaryPlanA.plan.requested.snapshotId, snapshotA.snapshotId)
  assert.deepEqual(ordinaryPlanA.plan.requested.selectedSkills, [selectedSkill])
  const ordinarySyncA = typed(baseEnv, context.hubDataRoot, [
    'sync', '--worktree', fixture.ordinary.root,
    '--plan-hash', ordinaryPlanA.plan.planHash,
    '--session-id', ordinarySession.id
  ], 'p3-ordinary-sync-a')
  assert.equal(ordinarySyncA.envelope.data.changed, true)
  assert.equal(ordinarySyncA.envelope.data.sessionCompleted, true)
  assert.equal(ordinarySyncA.envelope.data.pin.materializedSnapshot, snapshotA.snapshotId)
  const ordinarySyncReplay = parseJson(runSg([
    'sync', '--worktree', fixture.ordinary.root,
    '--plan-hash', ordinaryPlanA.plan.planHash,
    '--session-id', ordinarySession.id,
    '--contract-v1', '--request-id', ordinarySyncA.requestId
  ], rootEnvironment(baseEnv, context.hubDataRoot)), 'ordinary sync replay')
  assert.equal(ordinarySyncReplay.ok, true)
  assert.equal(ordinarySyncReplay.meta.replayed, true)
  assert.equal(ordinarySyncReplay.data.marker.materializationId, ordinarySyncA.envelope.data.marker.materializationId)
  assert.equal(ordinarySyncReplay.data.sessionCompleted, true)
  assertLocatorFree(ordinarySyncReplay, [fixture.ordinary.root, context.runRoot], 'ordinary sync replay')
  assert.equal(fs.readFileSync(path.join(fixture.ordinary.root, 'AGENTS.override.md'), 'utf8'), '# P3 override A\n')
  assert.equal(
    fs.readFileSync(path.join(fixture.ordinary.root, '.agents', 'skills', selectedSkill, 'tracked.txt'), 'utf8'),
    'tracked-baseline\n'
  )
  assert.match(
    runGit(fixture.ordinary.root, [
      'ls-files', '-v', '--', `.agents/skills/${selectedSkill}/tracked.txt`
    ], baseEnv, 'ordinary H to S'),
    /^S /
  )
  assert.match(
    runGit(fixture.ordinary.root, ['check-ignore', '-v', 'sentinel-a.tmp'], baseEnv, 'ordinary base exclude A'),
    /sentinel-a\.tmp/
  )
  assertOrdinaryDurableProof({
    worktree: fixture.ordinary.root,
    pathKey: ordinarySyncA.envelope.data.pathKey,
    sessionId: ordinarySession.id,
    requestId: ordinarySyncA.requestId
  })
  const completedSession = typed(baseEnv, context.hubDataRoot, [
    'session', '--id', ordinarySession.id
  ], 'p3-ordinary-session-completed').envelope.data.session
  assert.equal(completedSession.status, 'completed')
  assert.equal(completedSession.attachCompletion.materializationId, ordinarySyncA.envelope.data.marker.materializationId)
  assertLocatorFree(completedSession.attachCompletion, [fixture.ordinary.root, context.runRoot], 'completed attach proof')

  const pinB = typed(baseEnv, context.hubDataRoot, [
    'pin', 'set', '--worktree', fixture.ordinary.root,
    '--snapshot', snapshotB.snapshotId,
    '--skill', selectedSkill
  ], 'p3-ordinary-pin-b').envelope.data
  assert.equal(pinB.changed, true)
  writeText(fixture.baseExclude, 'sentinel-a.tmp\nsentinel-b.tmp\n')
  const staleBasePlan = typed(baseEnv, context.hubDataRoot, [
    'plan-sync', '--worktree', fixture.ordinary.root
  ], 'p3-ordinary-plan-base-drift').envelope.data.plan
  assert.equal(staleBasePlan.git.configuration.effects.includes('refreshExcludeProjection'), true)
  writeText(fixture.baseExclude, 'sentinel-a.tmp\nsentinel-b.tmp\nsentinel-c.tmp\n')
  const staleBaseFailure = typedFailure(baseEnv, context.hubDataRoot, [
    'sync', '--worktree', fixture.ordinary.root,
    '--plan-hash', staleBasePlan.planHash
  ], 'p3-ordinary-stale-base-sync', 'MATERIALIZE_PLAN_STALE')
  assertLocatorFree(staleBaseFailure.envelope, [fixture.ordinary.root, context.runRoot], 'stale base failure')
  const freshBPlan = typed(baseEnv, context.hubDataRoot, [
    'plan-sync', '--worktree', fixture.ordinary.root
  ], 'p3-ordinary-plan-b').envelope.data.plan
  assert.equal(freshBPlan.executable, true)
  const syncB = typed(baseEnv, context.hubDataRoot, [
    'sync', '--worktree', fixture.ordinary.root,
    '--plan-hash', freshBPlan.planHash
  ], 'p3-ordinary-sync-b').envelope.data
  assert.equal(syncB.changed, true)
  assert.equal(syncB.pin.materializedSnapshot, snapshotB.snapshotId)
  assert.equal(fs.readFileSync(path.join(fixture.ordinary.root, 'AGENTS.override.md'), 'utf8'), '# P3 override B\n')
  for (const sentinel of ['sentinel-a.tmp', 'sentinel-b.tmp', 'sentinel-c.tmp']) {
    assert.match(runGit(fixture.ordinary.root, [
      'check-ignore', '-v', sentinel
    ], baseEnv, `ordinary projected exclude ${sentinel}`), new RegExp(sentinel.replace('.', '\\.')))
  }

  const managedOverride = path.join(fixture.ordinary.root, 'AGENTS.override.md')
  writeText(managedOverride, '# locally dirty override\n')
  const dirtyExternalBefore = {
    worktree: treeManifest(fixture.ordinary.root),
    admin: treeManifest(fixture.ordinary.admin)
  }
  const dirtyPlan = typed(baseEnv, context.hubDataRoot, [
    'plan-sync', '--worktree', fixture.ordinary.root
  ], 'p3-ordinary-plan-dirty').envelope.data
  assert.equal(dirtyPlan.status, 'conflict')
  assert.equal(dirtyPlan.plan.executable, false)
  assert.equal(
    dirtyPlan.plan.operations.some((operation) => operation.conflict?.kind === 'dirty'),
    true
  )
  const dirtyFailure = typedFailure(baseEnv, context.hubDataRoot, [
    'sync', '--worktree', fixture.ordinary.root,
    '--plan-hash', dirtyPlan.plan.planHash
  ], 'p3-ordinary-sync-dirty', 'CONFLICT_DIRTY')
  assertLocatorFree(dirtyFailure.envelope, [fixture.ordinary.root, context.runRoot], 'dirty failure')
  assert.equal(fs.readFileSync(managedOverride, 'utf8'), '# locally dirty override\n')
  assert.deepEqual(treeManifest(fixture.ordinary.root), dirtyExternalBefore.worktree, 'dirty refusal preserves the whole worktree')
  assert.deepEqual(treeManifest(fixture.ordinary.admin), dirtyExternalBefore.admin, 'dirty refusal preserves the whole linked admin')
  writeText(managedOverride, '# P3 override B\n')

  const reopenExternalBefore = {
    worktree: treeManifest(fixture.ordinary.root),
    admin: treeManifest(fixture.ordinary.admin)
  }
  const reopenPlan = typed(baseEnv, context.hubDataRoot, [
    'plan-sync', '--worktree', fixture.ordinary.root
  ], 'p3-ordinary-reopen-plan').envelope.data.plan
  const reopenSync = typed(baseEnv, context.hubDataRoot, [
    'sync', '--worktree', fixture.ordinary.root,
    '--plan-hash', reopenPlan.planHash
  ], 'p3-ordinary-reopen-sync').envelope.data
  assert.equal(reopenSync.changed, false)
  assert.deepEqual(treeManifest(fixture.ordinary.root), reopenExternalBefore.worktree, 'CLI no-op preserves the whole worktree')
  assert.deepEqual(treeManifest(fixture.ordinary.admin), reopenExternalBefore.admin, 'CLI no-op preserves marker and Git projections')
  const markerBytesBeforeDaemon = fs.readFileSync(gitPath(
    fixture.ordinary.root,
    'skill-graft/materialized-v1.json',
    baseEnv,
    'ordinary marker before daemon'
  ))

  const ordinaryDaemonProcesses = await startDaemon(baseEnv, tracker, selectedPort, 'ordinary reopen')
  activeDaemon = { env: baseEnv, processes: ordinaryDaemonProcesses }
  const httpNoopPlan = await postCommand(ordinaryDaemonProcesses.base, {
    kind: 'planSync',
    worktree: fixture.ordinary.root,
    requestId: `p3-http-ordinary-plan-${context.runId}`
  }, 'ordinary HTTP plan')
  assert.equal(httpNoopPlan.ok, true)
  assert.equal(httpNoopPlan.data.plan.executable, true)
  const httpNoopSync = await postCommand(ordinaryDaemonProcesses.base, {
    kind: 'sync',
    worktree: fixture.ordinary.root,
    planHash: httpNoopPlan.data.plan.planHash,
    requestId: `p3-http-ordinary-sync-${context.runId}`
  }, 'ordinary HTTP no-op sync')
  assert.equal(httpNoopSync.ok, true)
  assert.equal(httpNoopSync.data.changed, false)
  assert.deepEqual(treeManifest(fixture.ordinary.root), reopenExternalBefore.worktree, 'daemon no-op preserves the whole worktree')
  assert.deepEqual(treeManifest(fixture.ordinary.admin), reopenExternalBefore.admin, 'daemon no-op preserves marker and Git projections')
  assert.deepEqual(fs.readFileSync(gitPath(
    fixture.ordinary.root,
    'skill-graft/materialized-v1.json',
    baseEnv,
    'ordinary marker after daemon'
  )), markerBytesBeforeDaemon, 'daemon no-op preserves marker bytes')
  await stopDaemon(baseEnv, ordinaryDaemonProcesses, 'ordinary reopen')
  activeDaemon = null

  typed(baseEnv, context.hubDataRoot, [
    'pin', 'set', '--worktree', fixture.ordinary.root,
    '--snapshot', snapshotB.snapshotId,
    '--clear-skills'
  ], 'p3-ordinary-release-pin')
  const releasePlan = typed(baseEnv, context.hubDataRoot, [
    'plan-sync', '--worktree', fixture.ordinary.root
  ], 'p3-ordinary-release-plan').envelope.data.plan
  assert.equal(
    releasePlan.git.operations.some((operation) =>
      operation.targetRelativePath === `.agents/skills/${selectedSkill}` && operation.action === 'release'),
    true
  )
  const released = typed(baseEnv, context.hubDataRoot, [
    'sync', '--worktree', fixture.ordinary.root,
    '--plan-hash', releasePlan.planHash
  ], 'p3-ordinary-release-sync').envelope.data
  assert.equal(released.changed, true)
  assert.match(runGit(fixture.ordinary.root, [
    'ls-files', '-v', '--', `.agents/skills/${selectedSkill}/tracked.txt`
  ], baseEnv, 'ordinary S to H'), /^H /)
  assert.equal(fs.existsSync(path.join(fixture.ordinary.root, '.agents', 'skills', selectedSkill)), false)
  const ordinaryPrivateExclude = gitPath(
    fixture.ordinary.root,
    'skill-graft/excludes-v1',
    baseEnv,
    'ordinary private exclude'
  )
  assert.doesNotMatch(fs.readFileSync(ordinaryPrivateExclude, 'utf8'), new RegExp(selectedSkill))
  assert.match(
    runGit(fixture.ordinary.root, ['check-ignore', '-v', 'sentinel-c.tmp'], baseEnv, 'release preserves base exclude'),
    /sentinel-c\.tmp/
  )

  const expectedHooks = path.join(installedPackageRoot, 'overlay', 'hooks')
  assert.equal(
    comparable(runGit(fixture.ordinary.root, [
      'config', '--worktree', '--get', 'core.hooksPath'
    ], baseEnv, 'ordinary hooks config')),
    comparable(expectedHooks)
  )
  assert.equal(
    comparable(runGit(fixture.ordinary.root, [
      'config', '--worktree', '--get', 'ozdqp.localOverlaySource'
    ], baseEnv, 'ordinary package config')),
    comparable(installedPackageRoot)
  )
  assert.equal(
    comparable(runGit(fixture.ordinary.root, [
      'config', '--worktree', '--get', 'ozdqp.skillWatchWorkspace'
    ], baseEnv, 'ordinary data config')),
    comparable(context.hubDataRoot)
  )

  const sessionsBeforeHook = readJson(path.join(context.hubDataRoot, 'skill-review', 'sessions.json')).sessions
  runGit(fixture.ordinary.root, [
    'config', '--worktree', 'ozdqp.skillHubAutoAttach', 'true'
  ], baseEnv, 'enable no-env hook')
  runGit(fixture.ordinary.root, [
    'checkout', '--detach', fixture.commitA
  ], noEnvHookEnvironment(baseEnv), 'real no-env post-checkout hook')
  const sessionsAfterHook = readJson(path.join(context.hubDataRoot, 'skill-review', 'sessions.json')).sessions
  assert.equal(sessionsAfterHook.length, sessionsBeforeHook.length + 1, 'no-env hook creates exactly one attach session')
  const hookSession = sessionsAfterHook.find((candidate) =>
    !sessionsBeforeHook.some((before) => before.id === candidate.id))
  assert.equal(hookSession.kind, 'attach')
  assert.equal(hookSession.status, 'queued')
  assert.equal(comparable(hookSession.worktree), comparable(fixture.ordinary.root))
  assert.equal(
    invocationRows().some((row) => row.commandKind === 'attach' && row.transport === 'cli'),
    true,
    'no-env hook reaches the installed Application attach handler'
  )
  assert.deepEqual(fs.readdirSync(dshHome), [], 'no-env hook does not start DSH')
  assert.deepEqual(runOwnedProcesses(), [], 'no-env hook does not start Codex or a detached worker')

  const unmanagedSession = await authorizeWaitingSession(
    baseEnv,
    fixture.unmanaged.root,
    `p3-unmanaged-session-${context.runId}`
  )
  typed(baseEnv, context.hubDataRoot, [
    'claim', '--worktree', fixture.unmanaged.root,
    '--snapshot', snapshotB.snapshotId,
    '--session-id', unmanagedSession.id,
    '--clear-skills'
  ], 'p3-unmanaged-claim')
  const unmanagedOverride = path.join(fixture.unmanaged.root, 'AGENTS.override.md')
  writeText(unmanagedOverride, '# P3 override B\n')
  const unmanagedGraft = gitPath(fixture.unmanaged.root, 'skill-graft', baseEnv, 'unmanaged graft root')
  assert.equal(fs.existsSync(unmanagedGraft), false)
  const unmanagedExternalBefore = {
    worktree: treeManifest(fixture.unmanaged.root),
    admin: treeManifest(fixture.unmanaged.admin)
  }
  const unmanagedPlan = typed(baseEnv, context.hubDataRoot, [
    'plan-sync', '--worktree', fixture.unmanaged.root
  ], 'p3-unmanaged-exact-plan').envelope.data
  assert.equal(unmanagedPlan.status, 'conflict')
  assert.equal(unmanagedPlan.plan.executable, false)
  assert.equal(
    unmanagedPlan.plan.operations.some((operation) =>
      operation.targetRelativePath === 'AGENTS.override.md' && operation.conflict?.kind === 'unowned-content'),
    true
  )
  const unmanagedFailure = typedFailure(baseEnv, context.hubDataRoot, [
    'sync', '--worktree', fixture.unmanaged.root,
    '--plan-hash', unmanagedPlan.plan.planHash,
    '--session-id', unmanagedSession.id
  ], 'p3-unmanaged-exact-sync', 'CONFLICT_CONTENT')
  assertLocatorFree(unmanagedFailure.envelope, [fixture.unmanaged.root, context.runRoot], 'unmanaged exact failure')
  assert.equal(fs.readFileSync(unmanagedOverride, 'utf8'), '# P3 override B\n')
  assert.deepEqual(treeManifest(fixture.unmanaged.root), unmanagedExternalBefore.worktree, 'unmanaged refusal preserves the whole worktree')
  assert.deepEqual(treeManifest(fixture.unmanaged.admin), unmanagedExternalBefore.admin, 'unmanaged refusal preserves the whole linked admin')
  assert.equal(fs.existsSync(unmanagedGraft), false, 'unmanaged exact conflict creates no Git-admin state')
  const unmanagedWaiting = typed(baseEnv, context.hubDataRoot, [
    'session', '--id', unmanagedSession.id
  ], 'p3-unmanaged-session-after-conflict').envelope.data.session
  assert.equal(unmanagedWaiting.status, 'waiting')
  assert.equal(unmanagedWaiting.exitCode, 0)
  assert.equal(unmanagedWaiting.attachCompletion, undefined)
  assert.equal(sessionStoreEntry(unmanagedSession.id).attachCompletion, undefined)
  assertLocatorFree(unmanagedWaiting, [fixture.unmanaged.root, context.runRoot], 'unmanaged waiting session')
  fs.rmSync(unmanagedOverride)

  copyInstalledRuntimeToLegacySource(context.hubDataRoot)
  const legacy = seedLegacyLinks(fixture, baseEnv)
  const siblingVisibility = seedEquivalentLegacySiblingVisibility(fixture, baseEnv)
  const siblingBeforeLegacyPlan = {
    legacyWorktree: treeManifest(legacy.worktree),
    legacyAdmin: treeManifest(fixture.legacy.admin),
    ordinary: treeManifest(fixture.ordinary.admin),
    unmanaged: treeManifest(fixture.unmanaged.admin),
    visibility: siblingVisibility,
    commonExclude: fs.readFileSync(legacy.commonExclude).toString('base64')
  }
  const legacySession = await authorizeWaitingSession(
    baseEnv,
    legacy.worktree,
    `p3-legacy-session-${context.runId}`
  )
  typed(baseEnv, context.hubDataRoot, [
    'claim', '--worktree', legacy.worktree,
    '--snapshot', snapshotB.snapshotId,
    '--session-id', legacySession.id,
    '--skill', selectedSkill
  ], 'p3-legacy-claim')
  const legacyDry = typed(baseEnv, context.hubDataRoot, [
    'migrate-legacy', '--worktree', legacy.worktree, '--dry-run'
  ], 'p3-legacy-migrate-dry').envelope.data
  assert.equal(legacyDry.status, 'planned')
  assert.equal(legacyDry.plan.executable, true)
  assert.equal(legacyDry.plan.summary.replaceWithCopy, 3)
  assert.deepEqual(
    legacyDry.plan.operations.filter((operation) => operation.action === 'replaceWithCopy').map((operation) => operation.targetRelativePath).sort(),
    ['.agents/skills/ozdqp-development', '.codex/local-overlay', 'AGENTS.override.md'].sort()
  )
  assert.deepEqual(treeManifest(legacy.worktree), siblingBeforeLegacyPlan.legacyWorktree, 'legacy dry-run preserves its worktree')
  assert.deepEqual(treeManifest(fixture.legacy.admin), siblingBeforeLegacyPlan.legacyAdmin, 'legacy dry-run preserves its linked admin')
  assert.deepEqual(treeManifest(fixture.ordinary.admin), siblingBeforeLegacyPlan.ordinary, 'legacy dry-run preserves ordinary sibling admin')
  assert.deepEqual(treeManifest(fixture.unmanaged.admin), siblingBeforeLegacyPlan.unmanaged, 'legacy dry-run preserves unmanaged sibling admin')
  assertEquivalentLegacySiblingVisibility(siblingBeforeLegacyPlan.visibility, baseEnv, 'legacy dry-run')
  assert.equal(fs.readFileSync(legacy.commonExclude).toString('base64'), siblingBeforeLegacyPlan.commonExclude)

  const migrationOldReady = path.join(cutLogRoot, `legacy-migrate-old-${context.runId}.json`)
  const migrationCut = spawnCutWorker(baseEnv, tracker, {
    label: `p3-legacy-migrate-old-${context.runId}`,
    operation: 'migrate-legacy',
    cut: 'durable-old',
    worktree: legacy.worktree,
    requestId: `p3-legacy-migrate-cut-${context.runId}`,
    planHash: legacyDry.plan.planHash,
    readyFile: migrationOldReady
  })
  const migrationReady = await waitForReadyOrWorkerExit(
    migrationCut,
    migrationOldReady,
    legacyCheckpointTimeoutMs
  )
  assert.deepEqual(
    { mode: migrationReady.mode, operation: migrationReady.operation, cut: migrationReady.cut, phase: migrationReady.phase },
    {
      mode: 'execute-cut',
      operation: 'migrate-legacy',
      cut: 'durable-old',
      phase: 'legacy-materializer-after-marker-phase'
    }
  )
  assert.equal(migrationReady.pid, migrationCut.pid)
  assertLegacyLinks(legacy, false)
  assert.equal(fs.existsSync(gitPath(
    legacy.worktree,
    'skill-graft/materialized-v1.json',
    baseEnv,
    'legacy durable-old published marker'
  )), true)
  assert.equal(
    entriesRecursively(gitPath(
      legacy.worktree,
      'skill-graft/legacy-transactions',
      baseEnv,
      'legacy durable-old journal'
    )).some((entry) => entry.path.endsWith('journal.json')),
    true,
    'durable-old cut has an external legacy journal'
  )
  assert.deepEqual(
    entriesRecursively(path.join(context.hubDataRoot, '.skill-graft-transactions')),
    [],
    'durable-old cut precedes Hub WAL publication'
  )
  await killCutWorker(migrationCut)
  await new Promise((resolve) => setTimeout(resolve, leaseMs + 300))

  const legacyRecoveryDaemon = await startDaemon(baseEnv, tracker, selectedPort, 'legacy durable-old recovery')
  activeDaemon = { env: baseEnv, processes: legacyRecoveryDaemon }
  const recoveredOld = await postCommand(legacyRecoveryDaemon.base, {
    kind: 'setPin',
    worktree: legacy.worktree,
    snapshotId: snapshotB.snapshotId,
    selectedSkills: [selectedSkill],
    requestId: `p3-legacy-recover-old-${context.runId}`
  }, 'legacy durable-old recovery command')
  assert.equal(recoveredOld.ok, true)
  assertLegacyLinks(legacy, true)
  const legacyMarker = gitPath(legacy.worktree, 'skill-graft/materialized-v1.json', baseEnv, 'legacy marker')
  assert.equal(fs.existsSync(legacyMarker), false, 'durable-old recovery restores the absent marker')
  const legacyCurrentBeforeCommit = currentRecordFile(legacyDry.plan.pathKey)
  if (fs.existsSync(legacyCurrentBeforeCommit)) {
    assert.equal(readJson(legacyCurrentBeforeCommit).marker, null)
  }
  assert.equal(fs.existsSync(migrationRecordFile(legacyDry.plan.migrationId)), false)
  assert.deepEqual(entriesRecursively(gitPath(
    legacy.worktree,
    'skill-graft/legacy-transactions',
    baseEnv,
    'legacy transactions after old recovery'
  )), [])

  const migrationReplan = await postCommand(legacyRecoveryDaemon.base, {
    kind: 'migrateLegacy',
    worktree: legacy.worktree,
    mode: 'dryRun',
    requestId: `p3-legacy-replan-${context.runId}`
  }, 'legacy replan after recovery')
  assert.equal(migrationReplan.ok, true)
  assert.equal(migrationReplan.data.status, 'planned')
  assert.equal(migrationReplan.data.plan.executable, true)
  const migrationCommitted = await postCommand(legacyRecoveryDaemon.base, {
    kind: 'migrateLegacy',
    worktree: legacy.worktree,
    mode: 'commit',
    planHash: migrationReplan.data.plan.planHash,
    requestId: `p3-legacy-commit-${context.runId}`
  }, 'legacy normal commit')
  assert.equal(migrationCommitted.ok, true)
  assert.equal(migrationCommitted.data.status, 'committed')
  assertLegacyLinks(legacy, false)
  assertEquivalentLegacySiblingVisibility(siblingBeforeLegacyPlan.visibility, baseEnv, 'legacy migration')
  assert.match(fs.readFileSync(legacy.commonExclude, 'utf8'), /project-owned-pattern/)
  assert.doesNotMatch(
    fs.readFileSync(legacy.commonExclude, 'utf8'),
    /AGENTS\.override\.md|ozdqp-development|local-overlay/
  )
  assert.equal(migrationCommitted.data.migration.status, 'committed')
  assertLocatorFree(
    migrationCommitted.data.migration,
    [legacy.worktree, context.hubDataRoot, installedPackageRoot],
    'legacy migration record'
  )
  const migrationId = migrationCommitted.data.migration.migrationId
  assert.equal(migrationId, migrationReplan.data.plan.migrationId)
  assert.equal(migrationId, legacyDry.plan.migrationId)
  assert.equal(migrationCommitted.data.migration.planHash, migrationReplan.data.plan.planHash)
  assert.equal(migrationCommitted.data.migration.backupManifestId, migrationReplan.data.plan.backupManifestId)
  assert.equal(migrationCommitted.data.migration.backupPrivateStateId, migrationReplan.data.plan.backupPrivateStateId)
  await stopDaemon(baseEnv, legacyRecoveryDaemon, 'legacy durable-old recovery')
  activeDaemon = null

  const alreadyMigrated = typed(baseEnv, context.hubDataRoot, [
    'migrate-legacy', '--worktree', legacy.worktree, '--dry-run'
  ], 'p3-legacy-reopen').envelope.data
  assert.equal(alreadyMigrated.status, 'already-migrated')
  assert.equal(alreadyMigrated.plan, null)
  const rollbackDryExternalBefore = {
    worktree: treeManifest(legacy.worktree),
    admin: treeManifest(fixture.legacy.admin)
  }
  const rollbackDry = typed(baseEnv, context.hubDataRoot, [
    'rollback-legacy', '--worktree', legacy.worktree,
    '--migration-id', migrationId,
    '--dry-run'
  ], 'p3-legacy-rollback-dry').envelope.data
  assert.equal(rollbackDry.status, 'planned')
  assert.equal(rollbackDry.plan.executable, true)
  assert.equal(rollbackDry.plan.summary.restoreLink, 3)
  assert.deepEqual(treeManifest(legacy.worktree), rollbackDryExternalBefore.worktree, 'rollback dry-run preserves its worktree')
  assert.deepEqual(treeManifest(fixture.legacy.admin), rollbackDryExternalBefore.admin, 'rollback dry-run preserves its linked admin')

  // This gate is intentionally non-skippable. The worker must reach the
  // durable-new checkpoint; otherwise waitForReadyOrWorkerExit throws with a
  // redacted product error code and installed-real acceptance fails hard.
  const rollbackRequestId = `p3-legacy-rollback-cut-${context.runId}`
  const rollbackNewReady = path.join(cutLogRoot, `legacy-rollback-new-${context.runId}.json`)
  const rollbackCut = spawnCutWorker(baseEnv, tracker, {
    label: `p3-legacy-rollback-new-${context.runId}`,
    operation: 'rollback-legacy',
    cut: 'durable-new',
    worktree: legacy.worktree,
    requestId: rollbackRequestId,
    planHash: rollbackDry.plan.planHash,
    migrationId,
    readyFile: rollbackNewReady
  })
  const rollbackReady = await waitForReadyOrWorkerExit(
    rollbackCut,
    rollbackNewReady,
    legacyCheckpointTimeoutMs
  )
  assert.deepEqual(
    { mode: rollbackReady.mode, operation: rollbackReady.operation, cut: rollbackReady.cut, phase: rollbackReady.phase },
    { mode: 'execute-cut', operation: 'rollback-legacy', cut: 'durable-new', phase: 'wal-published' }
  )
  assert.equal(rollbackReady.pid, rollbackCut.pid)
  assert.match(rollbackReady.transactionHash, /^sha256:[a-f0-9]{64}$/)
  assertLegacyLinks(legacy, true)
  const publishedWal = entriesRecursively(path.join(context.hubDataRoot, '.skill-graft-transactions'))
    .filter((entry) => entry.kind === 'file' && entry.path.endsWith('.wal.json'))
  assert.equal(publishedWal.length, 1, 'durable-new cut has one published Hub WAL')
  assert.equal(readJson(migrationRecordFile(migrationId)).status, 'committed', 'durable target bytes remain old at WAL cut')
  assert.notEqual(readJson(currentRecordFile(legacyDry.plan.pathKey)).marker, null, 'current durable marker remains old at WAL cut')
  await killCutWorker(rollbackCut)
  await new Promise((resolve) => setTimeout(resolve, leaseMs + 300))

  const rollbackRecoveryDaemon = await startDaemon(baseEnv, tracker, selectedPort, 'legacy durable-new recovery')
  activeDaemon = { env: baseEnv, processes: rollbackRecoveryDaemon }
  const replayedRollback = await postCommand(rollbackRecoveryDaemon.base, {
    kind: 'rollbackLegacyMigration',
    worktree: legacy.worktree,
    migrationId,
    mode: 'commit',
    planHash: rollbackDry.plan.planHash,
    requestId: rollbackRequestId
  }, 'legacy rollback replay')
  assert.equal(replayedRollback.ok, true)
  assert.equal(replayedRollback.meta.replayed, true)
  assert.equal(replayedRollback.data.status, 'rolled-back')
  assertLegacyLinks(legacy, true)
  const rolledBackRecord = readJson(migrationRecordFile(migrationId))
  assert.equal(rolledBackRecord.status, 'rolledBack')
  assert.equal(readJson(currentRecordFile(legacyDry.plan.pathKey)).marker, null)
  const rollbackPin = typed(baseEnv, context.hubDataRoot, [
    'pin', 'show', '--worktree', legacy.worktree
  ], 'p3-legacy-pin-after-rollback').envelope.data.pin
  assert.equal(rollbackPin.materializedSnapshot, null)
  assert.equal(fs.existsSync(legacyMarker), false)
  assert.equal(
    fs.readFileSync(legacy.commonExclude).toString('base64'),
    siblingBeforeLegacyPlan.commonExclude,
    'rollback restores exact common exclude bytes while preserving the project-owned line'
  )
  assert.deepEqual(treeManifest(fixture.ordinary.admin), siblingBeforeLegacyPlan.ordinary, 'legacy round-trip preserves ordinary sibling admin')
  assert.deepEqual(treeManifest(fixture.unmanaged.admin), siblingBeforeLegacyPlan.unmanaged, 'legacy round-trip preserves unmanaged sibling admin')
  assertEquivalentLegacySiblingVisibility(siblingBeforeLegacyPlan.visibility, baseEnv, 'legacy rollback')
  await stopDaemon(baseEnv, rollbackRecoveryDaemon, 'legacy durable-new recovery')
  activeDaemon = null
  const rollbackReopen = typed(baseEnv, context.hubDataRoot, [
    'rollback-legacy', '--worktree', legacy.worktree,
    '--migration-id', migrationId,
    '--dry-run'
  ], 'p3-legacy-rollback-reopen').envelope.data
  assert.equal(rollbackReopen.status, 'already-rolled-back')
  assert.equal(rollbackReopen.plan, null)

  runGit(fixture.common, [
    'worktree', 'add', '--detach', crossVolume.child, fixture.commitB
  ], baseEnv, 'add marker-owned cross-volume worktree')
  crossAdded = true
  assertPlainDirectoryChain(crossVolume.child, 'cross-volume worktree chain')
  const crossAdmin = gitAdmin(crossVolume.child, baseEnv, 'cross-volume admin')
  assertDifferentVolume(crossVolume.child, crossAdmin, 'cross-volume fixture')
  const crossSession = await authorizeWaitingSession(
    baseEnv,
    crossVolume.child,
    `p3-cross-session-${context.runId}`,
    crossVolume.root
  )
  const crossBaseline = {
    worktree: treeManifest(crossVolume.child),
    admin: treeManifest(crossAdmin),
    common: treeManifest(path.join(fixture.common, '.git')),
    data: treeManifest(context.hubDataRoot),
    package: treeManifest(installedPackageRoot)
  }
  const crossFailure = typedFailure(baseEnv, context.hubDataRoot, [
    'claim', '--worktree', crossVolume.child,
    '--snapshot', snapshotB.snapshotId,
    '--session-id', crossSession.id,
    '--clear-skills'
  ], 'p3-cross-volume-claim', 'UNSUPPORTED_LAYOUT')
  assertLocatorFree(
    crossFailure.envelope,
    [crossVolume.child, crossVolume.root, fixture.common, context.runRoot],
    'cross-volume failure envelope'
  )
  assert.deepEqual(treeManifest(crossVolume.child), crossBaseline.worktree, 'cross-volume refusal preserves worktree')
  assert.deepEqual(treeManifest(crossAdmin), crossBaseline.admin, 'cross-volume refusal preserves linked admin')
  assert.deepEqual(treeManifest(path.join(fixture.common, '.git')), crossBaseline.common, 'cross-volume refusal preserves common Git state')
  assert.deepEqual(treeManifest(context.hubDataRoot), crossBaseline.data, 'cross-volume refusal is before durable ledger writes')
  assert.deepEqual(treeManifest(installedPackageRoot), crossBaseline.package, 'cross-volume refusal preserves installed package')
  assert.equal(fs.existsSync(path.join(crossAdmin, 'skill-graft')), false, 'cross-volume refusal creates no Git-admin P3 state')
  runGit(fixture.common, ['worktree', 'remove', '--force', crossVolume.child], baseEnv, 'remove marker-owned cross-volume worktree')
  crossAdded = false
  assert.equal(fs.existsSync(crossVolume.child), false, 'cross-volume child is removed after evidence')
  assert.deepEqual(treeManifest(crossVolume.root), crossRootBaseline, 'cross-volume root returns to its exact marker-owned baseline')

  await tracker.stopAll({ graceMs: 500 })
  assert.deepEqual(runOwnedProcesses(), [], 'no marker-owned process remains')
  assert.deepEqual(listening18765(), listener18765Before, 'P3 acceptance never changes the 18765 listener set')
  assert.deepEqual(fs.readdirSync(dshHome), [], 'DSH_HOME remains unused')
  assert.deepEqual(fs.readFileSync(traceKeyFile), traceKey, 'invocation trace key remains unchanged')
  assertInstalledPackageStateless(installedPackageBaseline)
  assertNoDataResidue()
  assertNoGitResidue({
    ordinary: fixture.ordinary.root,
    unmanaged: fixture.unmanaged.root,
    legacy: fixture.legacy.root
  }, baseEnv)
  for (const worktree of [fixture.common, fixture.ordinary.root, fixture.unmanaged.root, fixture.legacy.root]) {
    assert.equal(
      fs.readFileSync(path.join(worktree, 'protected-sentinel.txt'), 'utf8'),
      `protected ${context.runId}\n`,
      'fixture protected sentinel remains exact'
    )
    for (const [relative, bytes] of Object.entries(preservedProjectFiles)) {
      assert.equal(
        fs.readFileSync(path.join(worktree, ...relative.split('/')), 'utf8'),
        bytes,
        `${relative} remains project-owned and exact`
      )
    }
  }
  assertEquivalentLegacySiblingVisibility(siblingBeforeLegacyPlan.visibility, baseEnv, 'P3 final state')

  const workerMetadata = fs.readdirSync(workerLogRoot).filter((name) => name.endsWith('.meta.json')).map((name) =>
    readJson(path.join(workerLogRoot, name)))
  assert.ok(workerMetadata.length >= 6, 'all session and crash workers persist bounded evidence')
  for (const metadata of workerMetadata) {
    for (const stream of Object.values(metadata.streams)) {
      assert.equal(stream.capturedBytes <= workerOutputLimit, true)
      assert.equal(stream.truncated, stream.totalBytes > stream.capturedBytes)
      assert.match(stream.capturedSha256, /^sha256:[a-f0-9]{64}$/)
    }
  }

  writeSummary({
    schemaVersion: 1,
    runId: context.runId,
    package: {
      name: packed.name,
      version: packed.version,
      shasum: packed.shasum,
      size: packed.size,
      requiredP3Files: 10
    },
    isolation: {
      markerOwned: true,
      crossVolumeMarkerOwned: true,
      globalHostPathEntriesRemoved: isolated.removedPathEntries.length,
      dshHomeUnused: true,
      codexOrDshStarted: false,
      api18765Before: listener18765Before,
      api18765After: listening18765(),
      ownedProcessesAfter: 0
    },
    schema: {
      initial: legacySchema.status,
      final: currentSchema.status,
      snapshotA: snapshotA.snapshotId,
      snapshotB: snapshotB.snapshotId
    },
    ordinary: {
      pathKey: ordinarySyncA.envelope.data.pathKey,
      materializationA: ordinarySyncA.envelope.data.marker.materializationId,
      materializationB: syncB.marker.materializationId,
      staleBaseRejected: true,
      dirtyRejected: true,
      reopenNoop: true,
      daemonNoop: true,
      releaseHsh: true,
      hookWithoutRootEnvironment: true
    },
    conflicts: {
      unmanagedExact: 'CONFLICT_CONTENT',
      dirty: 'CONFLICT_DIRTY',
      crossVolume: 'UNSUPPORTED_LAYOUT'
    },
    legacy: {
      migrationId,
      replaceWithCopy: legacyDry.plan.summary.replaceWithCopy,
      durableOldRecovered: true,
      durableNewReplayed: true,
      restoredLinks: rollbackDry.plan.summary.restoreLink
    },
    evidence: {
      workerCount: workerMetadata.length,
      invocationAttachObserved: true,
      residueFiles: 0
    }
  })
})
