import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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
const workerFile = path.join(sourceRoot, 'test', 'support', 'p2-durable-worker.mjs')
const dshHome = path.join(context.homeRoot, 'dsh-home')
const appData = path.join(context.homeRoot, 'appdata')
const localAppData = path.join(context.homeRoot, 'localappdata')
const npmCache = path.join(context.homeRoot, 'npm-cache')
const npmPrefix = path.join(context.homeRoot, 'npm-prefix')
const tempRoot = path.join(context.homeRoot, 'temp')
const commandLogRoot = path.join(context.logsRoot, 'commands')
const workerLogRoot = path.join(context.logsRoot, 'workers')
const residentSkills = ['ozdqp-development', 'ozdqp-ui-development', 'ozdqp-git-workflow']
const workerOutputLimit = 64 * 1024
let commandOrdinal = 0

function comparable(target) {
  const resolved = path.resolve(target)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return Boolean(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
}

function assertEmptyDirectory(target, label) {
  assert.equal(fs.existsSync(target), true, `${label} must exist`)
  assert.equal(fs.lstatSync(target).isDirectory(), true, `${label} must be a directory`)
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

function writeText(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, value, 'utf8')
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
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
      rows.push({ path: portable, kind: 'link', target: comparable(fs.realpathSync.native(absolute)) })
      return
    }
    if (stat.isDirectory()) {
      if (portable) rows.push({ path: portable, kind: 'directory' })
      for (const name of fs.readdirSync(absolute).sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))) {
        walk(path.join(absolute, name), relative ? path.join(relative, name) : name)
      }
      return
    }
    assert.equal(stat.isFile(), true, `unexpected filesystem object at ${absolute}`)
    const bytes = fs.readFileSync(absolute)
    rows.push({ path: portable, kind: 'file', size: bytes.length, sha256: sha256Bytes(bytes) })
  }
  walk(root, '')
  return rows
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
    || ['NODE_AUTH_TOKEN', 'NPM_TOKEN', 'GITHUB_TOKEN', 'SKILL_GRAFT_INVOCATION_TRACE'].includes(name))
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

function recordCommand(label, kind, args, result) {
  fs.mkdirSync(commandLogRoot, { recursive: true })
  const safeLabel = label.replace(/[^A-Za-z0-9._-]/g, '-')
  const file = path.join(commandLogRoot, `${String(++commandOrdinal).padStart(3, '0')}-${safeLabel}.json`)
  fs.writeFileSync(file, `${JSON.stringify({
    schemaVersion: 1,
    label,
    kind,
    args,
    status: result.status,
    signal: result.signal,
    error: result.error?.message || null,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || '')
  }, null, 2)}\n`, 'utf8')
}

function workerLabel(label) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,159}$/.test(label)) throw new Error('worker evidence label is invalid')
  return label
}

function ensureWorkerLogRoot() {
  assertOwned(workerLogRoot, 'logs', 'worker evidence root')
  if (!fs.existsSync(workerLogRoot)) fs.mkdirSync(workerLogRoot)
  const stat = fs.lstatSync(workerLogRoot)
  assert.equal(stat.isDirectory() && !stat.isSymbolicLink(), true, 'worker evidence root must be a plain directory')
  assert.equal(comparable(fs.realpathSync.native(workerLogRoot)), comparable(workerLogRoot), 'worker evidence root must resolve exactly')
}

function boundedWorkerBytes(value) {
  const raw = Buffer.isBuffer(value) ? value : Buffer.from(String(value || ''), 'utf8')
  return { captured: raw.subarray(0, workerOutputLimit), totalBytes: raw.length }
}

function writeWorkerEvidence({ label, phase, pid, code, signal, stdout, stderr, stdoutBytes, stderrBytes }) {
  const safeLabel = workerLabel(label)
  assert.equal(['lease-contend', 'commit', 'recover', 'hold-wal'].includes(phase), true, 'worker evidence phase is invalid')
  ensureWorkerLogRoot()
  const streams = [
    ['stdout', stdout, stdoutBytes],
    ['stderr', stderr, stderrBytes]
  ]
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
  for (const [name, captured, totalBytes] of streams) {
    assert.equal(Buffer.isBuffer(captured), true, `${name} worker evidence must be bytes`)
    assert.equal(Number.isSafeInteger(totalBytes) && totalBytes >= captured.length, true, `${name} byte count is invalid`)
    fs.writeFileSync(path.join(workerLogRoot, `${safeLabel}.${name}.log`), captured, { flag: 'wx' })
    metadata.streams[name] = {
      totalBytes,
      capturedBytes: captured.length,
      truncated: totalBytes > captured.length,
      capturedSha256: `sha256:${sha256Bytes(captured)}`
    }
  }
  fs.writeFileSync(
    path.join(workerLogRoot, `${safeLabel}.meta.json`),
    `${JSON.stringify(metadata, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx' }
  )
  return metadata
}

function runNpm(args, cwd, env, label) {
  const npmExecPath = String(process.env.npm_execpath || '')
  const command = npmExecPath ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const commandArgs = npmExecPath ? [npmExecPath, ...args] : args
  const result = spawnSync(command, commandArgs, {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024
  })
  recordCommand(label, 'npm', args, result)
  return result
}

function sgInvocation(args) {
  if (process.platform !== 'win32') return { command: context.cliPath, args }
  return createWindowsBatchInvocation(context.cliPath, args)
}

function runSg(args, env, label) {
  const invocation = sgInvocation(args)
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: context.appRoot,
    env,
    encoding: 'utf8',
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments === true,
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024
  })
  recordCommand(label, 'sg', args, result)
  return result
}

function parseJsonResult(result, label, expectedStatus = 0) {
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
  const result = runSg(
    [...args, '--contract-v1', '--request-id', requestId],
    rootEnvironment(baseEnv, dataRoot, mode),
    label
  )
  const envelope = parseJsonResult(result, label)
  assert.equal(envelope.contractVersion, 1, `${label} contract version`)
  assert.equal(envelope.requestId, requestId, `${label} request id`)
  assert.equal(envelope.ok, true, `${label} Application failure: ${JSON.stringify(envelope.error || {})}`)
  assert.equal(envelope.meta?.handler, 'application.commandBus', `${label} Application handler`)
  return { envelope, requestId }
}

function runGit(cwd, args, baseEnv, label) {
  const result = spawnSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
    env: createIsolatedGitEnvironment(baseEnv, context.homeRoot),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024
  })
  assert.equal(result.error, undefined, `${label} spawn failed`)
  assert.equal(result.status, 0, `${label}: ${tail(result.stderr || result.stdout)}`)
  return String(result.stdout || '').trim()
}

function createGitProbe(root, name, baseEnv) {
  assertOwned(root, 'probe', `${name} probe`)
  fs.mkdirSync(path.join(root, 'baloot_client'), { recursive: true })
  writeText(path.join(root, 'AGENTS.md'), `# ${name} probe\n`)
  writeText(path.join(root, 'baloot_client', 'README.md'), `${name} client marker\n`)
  writeText(path.join(root, 'sentinel.txt'), `${name} immutable sentinel\n`)
  runGit(root, ['init'], baseEnv, `${name} git init`)
  runGit(root, ['config', 'user.name', 'Skill Graft P2'], baseEnv, `${name} git user`)
  runGit(root, ['config', 'user.email', 'skill-graft-p2@example.invalid'], baseEnv, `${name} git email`)
  runGit(root, ['add', '--', 'AGENTS.md', 'baloot_client/README.md', 'sentinel.txt'], baseEnv, `${name} git add`)
  runGit(root, ['commit', '-m', `seed ${name}`], baseEnv, `${name} git commit`)
  assert.equal(runGit(root, ['remote'], baseEnv, `${name} remotes`), '', `${name} probe must have no remote`)
  return root
}

function seedLegacyFixture(dataRoot, probeParent, label, baseEnv, includedVersion) {
  assertOwned(dataRoot, 'hub-data', `${label} data root`)
  assertOwned(probeParent, 'probe', `${label} probe parent`)
  fs.mkdirSync(dataRoot, { recursive: true })
  fs.mkdirSync(probeParent, { recursive: true })
  writeText(path.join(dataRoot, 'AGENTS.override.md'), `# ${label} override ${includedVersion}\n`)
  for (const name of residentSkills) {
    writeText(
      path.join(dataRoot, 'skills', name, 'SKILL.md'),
      `# ${name}\n${label} included ${includedVersion}\n`
    )
  }
  writeText(
    path.join(dataRoot, 'skills', 'adopted', 'p2-adopted', 'SKILL.md'),
    `# adopted\n${label} included ${includedVersion}\n`
  )
  writeText(path.join(dataRoot, 'skills', 'inbox', 'excluded-update', 'SKILL.md'), '# excluded inbox A\n')
  writeText(path.join(dataRoot, 'skills', 'README.md'), '# excluded skills marker A\n')
  writeText(path.join(dataRoot, 'overlay', 'controlled-code.ps1'), '# excluded overlay code A\n')
  writeText(path.join(dataRoot, 'overlay', 'checkout-rules.txt'), '# excluded checkout rules\n')
  writeText(path.join(dataRoot, 'overlay', 'do-not-auto-attach.txt'), '')

  const claimed = createGitProbe(path.join(probeParent, 'claimed'), `${label}-claimed`, baseEnv)
  const linked = createGitProbe(path.join(probeParent, 'linked'), `${label}-linked`, baseEnv)
  const unmanaged = createGitProbe(path.join(probeParent, 'unmanaged'), `${label}-unmanaged`, baseEnv)
  const linkedTarget = path.join(linked, '.agents', 'skills', 'ozdqp-development')
  fs.mkdirSync(path.dirname(linkedTarget), { recursive: true })
  fs.symlinkSync(path.join(dataRoot, 'skills', 'ozdqp-development'), linkedTarget, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(
    comparable(fs.realpathSync.native(linkedTarget)),
    comparable(path.join(dataRoot, 'skills', 'ozdqp-development')),
    `${label} linked probe target`
  )

  writeText(path.join(dataRoot, 'overlay', 'attached-worktrees.txt'), `${claimed}\n`)
  writeText(path.join(dataRoot, 'overlay', 'scan-roots.txt'), `${probeParent}\n`)
  writeText(path.join(dataRoot, 'skill-review', 'state.json'), `${JSON.stringify({
    version: 1,
    stateRevision: 4,
    items: [],
    lastIngest: null
  }, null, 2)}\n`)
  return {
    label,
    dataRoot,
    probeParent,
    claimed,
    linked,
    unmanaged,
    linkedTarget,
    changedIncluded: path.join(dataRoot, 'skills', 'ozdqp-development', 'SKILL.md'),
    excludedFiles: [
      path.join(dataRoot, 'skills', 'inbox', 'excluded-update', 'SKILL.md'),
      path.join(dataRoot, 'skills', 'README.md'),
      path.join(dataRoot, 'overlay', 'controlled-code.ps1')
    ]
  }
}

function probeSnapshot(root, baseEnv, label) {
  const gitDirectory = runGit(root, ['rev-parse', '--absolute-git-dir'], baseEnv, `${label} git dir`)
  const indexFile = path.join(gitDirectory, 'index')
  return {
    tree: treeManifest(root, { skip: (relative) => relative === '.git' || relative.startsWith('.git/') }),
    indexSha256: sha256File(indexFile),
    head: runGit(root, ['rev-parse', 'HEAD'], baseEnv, `${label} HEAD`),
    status: runGit(root, ['status', '--porcelain=v1', '--untracked-files=all'], baseEnv, `${label} status`)
  }
}

function fixtureProbeSnapshots(fixture, baseEnv) {
  return Object.fromEntries(['claimed', 'linked', 'unmanaged'].map((kind) => [
    kind,
    probeSnapshot(fixture[kind], baseEnv, `${fixture.label}-${kind}`)
  ]))
}

function businessSnapshot(fixture, baseEnv) {
  return {
    state: fs.readFileSync(path.join(fixture.dataRoot, 'skill-review', 'state.json'), 'base64'),
    source: treeManifest(path.join(fixture.dataRoot, 'skills')),
    override: fs.readFileSync(path.join(fixture.dataRoot, 'AGENTS.override.md'), 'base64'),
    overlay: treeManifest(path.join(fixture.dataRoot, 'overlay')),
    snapshots: treeManifest(path.join(fixture.dataRoot, 'skill-review', 'library')),
    probes: fixtureProbeSnapshots(fixture, baseEnv)
  }
}

function expectedCapturePaths() {
  return [
    'AGENTS.override.md',
    ...residentSkills.map((name) => `skills/${name}/SKILL.md`),
    'skills/adopted/p2-adopted/SKILL.md'
  ].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
}

function assertSnapshotManifest(fixture, manifest) {
  assert.match(manifest.snapshotId, /^sha256:[a-f0-9]{64}$/)
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.source.kind, 'library')
  assert.deepEqual(manifest.files.map((file) => file.path), expectedCapturePaths())
  assert.equal(manifest.files.every((file) => file.mode === '100644'), true)
  assert.equal(manifest.files.some((file) => file.path.startsWith('overlay/')), false)
  assert.equal(manifest.files.some((file) => file.path.startsWith('skills/inbox/')), false)
  assert.equal(manifest.files.some((file) => file.path === 'skills/README.md'), false)
  const libraryRoot = path.join(fixture.dataRoot, 'skill-review', 'library')
  for (const file of manifest.files) {
    const blob = path.join(libraryRoot, 'blobs', 'sha256', file.sha256.slice('sha256:'.length))
    assert.equal(fs.existsSync(blob), true, `snapshot blob exists for ${file.path}`)
    const bytes = fs.readFileSync(blob)
    assert.equal(bytes.length, file.size, `snapshot blob size for ${file.path}`)
    assert.equal(`sha256:${sha256Bytes(bytes)}`, file.sha256, `snapshot blob digest for ${file.path}`)
  }
}

function repositoryInventory(fixture) {
  const library = path.join(fixture.dataRoot, 'skill-review', 'library')
  const snapshotRoot = path.join(library, 'snapshots')
  const blobRoot = path.join(library, 'blobs', 'sha256')
  return {
    tree: treeManifest(library),
    primaryManifests: fs.readdirSync(snapshotRoot)
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .sort(),
    blobs: fs.readdirSync(blobRoot).filter((name) => /^[a-f0-9]{64}$/.test(name)).sort()
  }
}

function allStringValues(value, output = []) {
  if (typeof value === 'string') output.push(value)
  else if (Array.isArray(value)) for (const entry of value) allStringValues(entry, output)
  else if (value && typeof value === 'object') for (const entry of Object.values(value)) allStringValues(entry, output)
  return output
}

function assertNoRawLocator(value, locator, label) {
  const needle = path.resolve(locator).replaceAll('\\', '/').toLowerCase()
  for (const candidate of allStringValues(value)) {
    assert.equal(candidate.replaceAll('\\', '/').toLowerCase().includes(needle), false, `${label} leaked a raw locator`)
  }
}

function assertMigrationPlan(plan, defaultSnapshot) {
  assert.equal(plan.schemaVersion, 1)
  assert.match(plan.planHash, /^sha256:[a-f0-9]{64}$/)
  assert.match(plan.sourceDigest, /^sha256:[a-f0-9]{64}$/)
  assert.deepEqual(plan.worktrees.map((entry) => entry.classification).sort(), ['claimed', 'linked', 'unmanaged'])
  assert.deepEqual(plan.warnings.map((entry) => entry.code).sort(), [
    'CLAIM_REQUIRES_MATERIALIZATION',
    'LEGACY_LINK_RETAINED'
  ])
  assert.equal(Object.keys(plan.targetState.worktrees).length, 2)
  for (const entry of plan.worktrees) {
    assert.match(entry.pathKey, /^sha256:[a-f0-9]{64}$/)
    assert.match(entry.worktreeId, /^worktree:[a-f0-9]{24}$/)
    if (entry.classification === 'unmanaged') {
      assert.equal(entry.requestedSnapshot, null)
      assert.deepEqual(entry.selectedSkills, [])
      assert.equal(plan.targetState.worktrees[entry.pathKey], undefined)
    } else {
      assert.equal(entry.requestedSnapshot, defaultSnapshot)
      const pin = plan.targetState.worktrees[entry.pathKey]
      assert.equal(pin.requestedSnapshot, defaultSnapshot)
      assert.equal(pin.materializedSnapshot, null)
      assert.equal(pin.claimState, 'claimed')
    }
  }
  for (const value of allStringValues(plan)) {
    assert.equal(/^[A-Za-z]:[\\/]/.test(value), false, `migration plan leaked a Windows path: ${value}`)
  }
}

function assertCompletedRequest(dataRoot, requestId, commandKind) {
  const review = path.join(dataRoot, 'skill-review')
  const ledger = JSON.parse(fs.readFileSync(path.join(review, 'application-ledger.json'), 'utf8'))
  const audit = JSON.parse(fs.readFileSync(path.join(review, 'application-audit.json'), 'utf8'))
  const entry = ledger.entries.find((candidate) => candidate.requestId === requestId)
  assert.equal(entry?.status, 'completed', `${commandKind} request completed in the durable ledger`)
  assert.equal(entry?.commandKind, commandKind)
  const events = audit.events.filter((event) => event.requestId === requestId)
  assert.equal(events.some((event) => event.type === 'command.succeeded'), true, `${commandKind} terminal audit event`)
  return { entry, events }
}

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`${label} timed out`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function workerArgs(mode, dataRoot, label, { leaseMs, value, readyFile } = {}) {
  return [
    workerFile,
    '--mode', mode,
    '--run-id', context.runId,
    '--run-root', context.runRoot,
    '--package-root', installedPackageRoot,
    '--data-root', dataRoot,
    '--lease-ms', String(leaseMs),
    '--label', label,
    ...(value === undefined ? [] : ['--value', value]),
    ...(readyFile === undefined ? [] : ['--ready-file', readyFile])
  ]
}

function runWorker(baseEnv, mode, dataRoot, label, options) {
  const args = workerArgs(mode, dataRoot, label, options)
  const result = spawnSync(process.execPath, args, {
    cwd: context.appRoot,
    env: rootEnvironment(baseEnv, dataRoot),
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024
  })
  recordCommand(label, 'p2-worker', args.slice(1), result)
  const stdout = boundedWorkerBytes(result.stdout)
  const stderr = boundedWorkerBytes(result.stderr)
  const evidence = writeWorkerEvidence({
    label,
    phase: mode,
    pid: result.pid,
    code: result.status,
    signal: result.signal,
    stdout: stdout.captured,
    stderr: stderr.captured,
    stdoutBytes: stdout.totalBytes,
    stderrBytes: stderr.totalBytes
  })
  let output = null
  if (String(result.stdout || '').trim()) {
    try {
      output = JSON.parse(String(result.stdout).trim().split(/\r?\n/).at(-1))
    } catch {
      throw new Error(`${label} returned invalid worker JSON: ${JSON.stringify(evidence.streams)}`)
    }
  }
  return { result, output, evidence }
}

function spawnWorker(baseEnv, tracker, mode, dataRoot, label, options) {
  const args = workerArgs(mode, dataRoot, label, options)
  const child = tracker.track(spawn(process.execPath, args, {
    cwd: context.appRoot,
    env: rootEnvironment(baseEnv, dataRoot),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  }))
  child.p2Label = label
  child.p2Args = args
  child.p2Phase = mode
  child.p2Stdout = Buffer.alloc(0)
  child.p2Stderr = Buffer.alloc(0)
  child.p2StdoutBytes = 0
  child.p2StderrBytes = 0
  const capture = (name, chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    const bytesName = `${name}Bytes`
    child[bytesName] += bytes.length
    const remaining = workerOutputLimit - child[name].length
    if (remaining > 0) child[name] = Buffer.concat([child[name], bytes.subarray(0, remaining)])
  }
  child.stdout.on('data', (chunk) => capture('p2Stdout', chunk))
  child.stderr.on('data', (chunk) => capture('p2Stderr', chunk))
  child.p2Completion = new Promise((resolve, reject) => {
    child.once('close', (code, signal) => {
      try {
        writeWorkerEvidence({
          label: child.p2Label,
          phase: child.p2Phase,
          pid: child.pid,
          code,
          signal,
          stdout: child.p2Stdout,
          stderr: child.p2Stderr,
          stdoutBytes: child.p2StdoutBytes,
          stderrBytes: child.p2StderrBytes
        })
        resolve({ code, signal })
      } catch (error) {
        reject(error)
      }
    })
  })
  return child
}

function workerDiagnostic(child) {
  return JSON.stringify({
    stdoutBytes: child.p2StdoutBytes,
    stderrBytes: child.p2StderrBytes,
    bufferedSha256: sha256Bytes(Buffer.concat([child.p2Stdout, Buffer.from([0]), child.p2Stderr]))
  })
}

function synchronousWorkerDiagnostic(worker) {
  return JSON.stringify({
    phase: worker.evidence.phase,
    pid: worker.evidence.pid,
    exit: worker.evidence.exit,
    streams: worker.evidence.streams
  })
}

function waitForWorkerMessage(child, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      child.off('message', onMessage)
      child.off('error', onError)
      child.off('exit', onExit)
    }
    const onMessage = (message) => {
      cleanup()
      resolve(message)
    }
    const onError = () => {
      cleanup()
      reject(new Error(`${child.p2Label} spawn failed: ${workerDiagnostic(child)}`))
    }
    const onExit = (code, signal) => {
      cleanup()
      child.p2Completion.then(
        () => reject(new Error(`${child.p2Label} exited before IPC code=${code} signal=${signal}: ${workerDiagnostic(child)}`)),
        () => reject(new Error(`${child.p2Label} evidence persistence failed after IPC exit`))
      )
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`${child.p2Label} IPC timed out: ${workerDiagnostic(child)}`))
    }, timeoutMs)
    child.once('message', onMessage)
    child.once('error', onError)
    child.once('exit', onExit)
  })
}

function waitForWorkerExit(child, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${child.p2Label} did not exit`)), timeoutMs)
    child.p2Completion.then(
      (exited) => { clearTimeout(timer); resolve(exited) },
      () => { clearTimeout(timer); reject(new Error(`${child.p2Label} evidence persistence failed`)) }
    )
  })
}

async function waitForCleanWorkerExit(child, timeoutMs = 30_000) {
  const exited = await waitForWorkerExit(child, timeoutMs)
  assert.equal(exited.code, 0, `${child.p2Label} exit code: ${workerDiagnostic(child)}`)
  assert.equal(exited.signal, null, `${child.p2Label} signal: ${workerDiagnostic(child)}`)
}

async function waitForKilledWorkerExit(child, expectedSignal = 'SIGKILL', timeoutMs = 30_000) {
  const exited = await waitForWorkerExit(child, timeoutMs)
  assert.equal(exited.signal, expectedSignal, `${child.p2Label} kill signal: ${workerDiagnostic(child)}`)
  assert.equal(exited.code, null, `${child.p2Label} must not report a clean exit code`)
}

function lockArtifacts(dataRoot) {
  return treeManifest(path.join(dataRoot, 'skill-review', 'locks', 'leases'))
}

function transactionArtifacts(dataRoot) {
  return treeManifest(path.join(dataRoot, '.skill-graft-transactions'))
}

function listening18765() {
  if (process.platform !== 'win32') return []
  const result = spawnSync('netstat.exe', ['-ano', '-p', 'tcp'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000
  })
  assert.equal(result.status, 0, `netstat failed: ${result.stderr || result.stdout}`)
  return String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter((line) => {
    const fields = line.split(/\s+/)
    return fields.length >= 5 && /:18765$/.test(fields[1]) && fields[3].toUpperCase() === 'LISTENING'
  }).map((line) => Number(line.split(/\s+/).at(-1))).filter((pid) => Number.isSafeInteger(pid)).sort((a, b) => a - b)
}

function runOwnedProcesses() {
  if (process.platform !== 'win32') return []
  const escaped = context.runId.replaceAll("'", "''")
  const script = [
    "$rows = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -in @('node.exe','cmd.exe','codex.exe','dsh.exe') }",
    `$rows | Where-Object { [string]$_.CommandLine -like '*${escaped}*' } | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress`
  ].join('; ')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000
  })
  assert.equal(result.status, 0, `owned process inspection failed: ${result.stderr || result.stdout}`)
  const text = String(result.stdout || '').trim()
  if (!text) return []
  const parsed = JSON.parse(text)
  return (Array.isArray(parsed) ? parsed : [parsed]).filter((row) => Number(row.ProcessId) !== process.pid)
}

function writeSummary(value) {
  const serialized = JSON.stringify(value, null, 2)
  assert.equal(/ownerToken/i.test(serialized), false, 'summary must not contain lease owner tokens')
  for (const candidate of [context.runRoot, context.hubDataRoot, context.probeRoot, installedPackageRoot]) {
    assert.equal(serialized.toLowerCase().includes(candidate.toLowerCase()), false, 'summary must not contain absolute run paths')
  }
  fs.writeFileSync(path.join(context.logsRoot, 'p2-real-summary.json'), `${serialized}\n`, 'utf8')
}

test('packed Local P2 distribution preserves snapshot, migration, pin, lease, WAL, and root contracts', {
  timeout: 10 * 60 * 1000
}, async (t) => {
  assert.equal(process.platform, 'win32', 'P2 installed-real acceptance requires native Windows evidence')
  assertEmptyDirectory(context.appRoot, 'app root')
  assertEmptyDirectory(context.homeRoot, 'home root')
  assertEmptyDirectory(context.hubDataRoot, 'hub-data root')
  assertEmptyDirectory(context.probeRoot, 'probe root')
  assertEmptyDirectory(context.logsRoot, 'logs root')
  assert.equal(comparable(context.cliPath), comparable(expectedSg), 'SKILL_GRAFT_CLI must be the isolated npm sg shim')
  assert.equal(fs.existsSync(workerFile), true, 'P2 durable worker must exist in the source test harness')

  const tracker = new ProcessTracker({ runId: context.runId })
  t.after(async () => {
    await tracker.stopAll({ graceMs: 750 })
  })

  for (const directory of [appData, localAppData, npmCache, npmPrefix, tempRoot, dshHome]) {
    fs.mkdirSync(directory, { recursive: true })
  }
  writeText(path.join(context.homeRoot, '.npmrc'), '')
  assert.deepEqual(fs.readdirSync(dshHome), [], 'DSH_HOME starts empty')
  const selectedPort = await getAvailableLoopbackPort({ forbidden: [18765, 3080] })
  const isolated = isolatedEnvironment(selectedPort)
  const baseEnv = isolated.env
  const port18765Before = listening18765()
  assert.deepEqual(runOwnedProcesses(), [], 'no marker-owned process may predate the P2 run')

  const packRoot = path.join(context.appRoot, 'package')
  fs.mkdirSync(packRoot, { recursive: true })
  const packedRows = parseJsonResult(
    runNpm(['pack', '--json', '--pack-destination', packRoot], sourceRoot, baseEnv, 'p2-npm-pack'),
    'npm pack'
  )
  assert.equal(Array.isArray(packedRows), true)
  assert.equal(packedRows.length, 1)
  const packed = packedRows[0]
  const tarball = path.resolve(packRoot, packed.filename)
  assert.equal(isInside(context.runRoot, tarball), true)
  assert.equal(fs.existsSync(tarball), true)
  const packPaths = (packed.files || []).map((entry) => String(entry.path).replaceAll('\\', '/'))
  for (const required of [
    'dist/control/cli.js',
    'dist/adapters/lease-lock.js',
    'dist/adapters/durable-state.js',
    'dist/adapters/durable-wal.js',
    'dist/adapters/snapshot-repository.js'
  ]) assert.equal(packPaths.includes(required), true, `${required} must ship`)
  for (const forbidden of [
    'src/', 'test/', 'docs/', 'scripts/', 'artifacts/', 'skill-review/',
    '.skill-graft-transactions/', 'overlay/attached-worktrees.txt',
    'overlay/scan-roots.txt', 'overlay/do-not-auto-attach.txt'
  ]) {
    assert.equal(packPaths.some((file) => file === forbidden || file.startsWith(forbidden)), false, `${forbidden} excluded from package`)
  }
  assert.equal(packPaths.filter((file) => file.startsWith('skills/')).every((file) => file === 'skills/README.md'), true)

  const installed = runNpm([
    'install', '--prefix', context.appRoot, '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', tarball
  ], context.appRoot, baseEnv, 'p2-npm-install')
  assert.equal(installed.error, undefined, `npm install spawn: ${installed.error?.message || ''}`)
  assert.equal(installed.status, 0, `npm install: ${tail(installed.stderr || installed.stdout)}`)
  assert.equal(fs.existsSync(context.cliPath), true, 'absolute installed sg exists')
  assert.equal(fs.existsSync(path.join(installedPackageRoot, 'src')), false)
  assert.equal(fs.existsSync(path.join(installedPackageRoot, 'test')), false)
  assert.equal(fs.existsSync(path.join(installedPackageRoot, 'skill-review', 'state.json')), false)

  const dryFixture = seedLegacyFixture(
    path.join(context.hubDataRoot, 'dryrun'),
    path.join(context.probeRoot, 'dryrun'),
    'dryrun',
    baseEnv,
    'B'
  )
  const drySnapshot = typed(baseEnv, dryFixture.dataRoot, ['snapshot', 'create'], 'p2-dry-snapshot').envelope.data.snapshot
  assertSnapshotManifest(dryFixture, drySnapshot)
  const dryBusinessBefore = businessSnapshot(dryFixture, baseEnv)
  const dry = typed(baseEnv, dryFixture.dataRoot, ['migrate-state', '--dry-run'], 'p2-dry-migration')
  assert.equal(dry.envelope.data.status, 'planned')
  assert.equal(dry.envelope.data.state, null)
  assertMigrationPlan(dry.envelope.data.plan, drySnapshot.snapshotId)
  assert.deepEqual(businessSnapshot(dryFixture, baseEnv), dryBusinessBefore, 'dry-run business domain is read-only')
  assertCompletedRequest(dryFixture.dataRoot, dry.requestId, 'migrateState')
  assert.equal(JSON.parse(fs.readFileSync(path.join(dryFixture.dataRoot, 'skill-review', 'state.json'), 'utf8')).version, 1)

  const commitFixture = seedLegacyFixture(
    path.join(context.hubDataRoot, 'commit'),
    path.join(context.probeRoot, 'commit'),
    'commit',
    baseEnv,
    'A'
  )
  const initialSchema = typed(baseEnv, commitFixture.dataRoot, ['inspect-schema'], 'p2-schema-legacy')
  assert.equal(initialSchema.envelope.data.status, 'legacy')
  assert.equal(initialSchema.envelope.data.detectedSchemaVersion, 1)
  const initialProbes = fixtureProbeSnapshots(commitFixture, baseEnv)

  const createdA = typed(baseEnv, commitFixture.dataRoot, ['snapshot', 'create'], 'p2-snapshot-a')
  const snapshotA = createdA.envelope.data.snapshot
  assert.equal(createdA.envelope.data.deduplicated, false)
  assertSnapshotManifest(commitFixture, snapshotA)
  const inventoryA = repositoryInventory(commitFixture)

  const mtimeOnly = new Date(Date.now() + 10_000)
  fs.utimesSync(commitFixture.changedIncluded, mtimeOnly, mtimeOnly)
  for (const [index, file] of commitFixture.excludedFiles.entries()) {
    writeText(file, `excluded mutation ${index} ${context.runId}\n`)
  }
  const duplicateA = typed(baseEnv, commitFixture.dataRoot, ['snapshot', 'create'], 'p2-snapshot-a-dedup')
  assert.equal(duplicateA.envelope.data.snapshot.snapshotId, snapshotA.snapshotId)
  assert.equal(duplicateA.envelope.data.deduplicated, true)
  assert.deepEqual(repositoryInventory(commitFixture), inventoryA, 'dedup creates no manifest or blob')

  await waitUntil(() => Date.now() > Date.parse(snapshotA.createdAt), 5_000, 'snapshot B clock advance')
  writeText(commitFixture.changedIncluded, '# ozdqp-development\ncommit included B\n')
  const createdB = typed(baseEnv, commitFixture.dataRoot, ['snapshot', 'create'], 'p2-snapshot-b')
  const snapshotB = createdB.envelope.data.snapshot
  assert.notEqual(snapshotB.snapshotId, snapshotA.snapshotId)
  assert.ok(Date.parse(snapshotB.createdAt) > Date.parse(snapshotA.createdAt), 'snapshot B must be the migration default')
  assertSnapshotManifest(commitFixture, snapshotB)
  const inventoryB = repositoryInventory(commitFixture)
  assert.deepEqual(inventoryB.primaryManifests.sort(), [
    `${snapshotA.snapshotId.slice(7)}.json`,
    `${snapshotB.snapshotId.slice(7)}.json`
  ].sort())
  assert.ok(inventoryB.blobs.length > inventoryA.blobs.length, 'changed included content adds a CAS blob')

  const listed = typed(baseEnv, commitFixture.dataRoot, ['snapshot', 'list'], 'p2-snapshot-list')
  assert.deepEqual(
    listed.envelope.data.snapshots.map((manifest) => manifest.snapshotId).sort(),
    [snapshotA.snapshotId, snapshotB.snapshotId].sort()
  )
  for (const [name, snapshot] of [['a', snapshotA], ['b', snapshotB]]) {
    const shown = typed(baseEnv, commitFixture.dataRoot, ['snapshot', 'show', '--id', snapshot.snapshotId], `p2-snapshot-show-${name}`)
    assert.equal(shown.envelope.data.snapshot.snapshotId, snapshot.snapshotId)
  }

  const commitBusinessBefore = businessSnapshot(commitFixture, baseEnv)
  const planned = typed(baseEnv, commitFixture.dataRoot, ['migrate-state', '--dry-run'], 'p2-commit-migration-plan')
  assert.equal(planned.envelope.data.status, 'planned')
  assertMigrationPlan(planned.envelope.data.plan, snapshotB.snapshotId)
  assert.deepEqual(businessSnapshot(commitFixture, baseEnv), commitBusinessBefore, 'commit fixture dry-run is read-only')
  assertCompletedRequest(commitFixture.dataRoot, planned.requestId, 'migrateState')

  const committed = typed(baseEnv, commitFixture.dataRoot, [
    'migrate-state', '--commit', '--plan-hash', planned.envelope.data.plan.planHash
  ], 'p2-migration-commit')
  assert.equal(committed.envelope.data.status, 'committed')
  const stateFile = path.join(commitFixture.dataRoot, 'skill-review', 'state.json')
  const stateBackup = path.join(commitFixture.dataRoot, 'skill-review', '.state.json.skill-graft.bak')
  const stateV2 = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  assert.equal(stateV2.schemaVersion, 2)
  assert.deepEqual(stateV2.librarySnapshots, [snapshotA.snapshotId, snapshotB.snapshotId].sort())
  assert.equal(Object.keys(stateV2.worktrees).length, 2)
  assert.deepEqual(JSON.parse(fs.readFileSync(stateBackup, 'utf8')), stateV2, 'durable backup converges to V2')
  assert.deepEqual(treeManifest(path.join(commitFixture.dataRoot, 'skills')), commitBusinessBefore.source)
  assert.deepEqual(treeManifest(path.join(commitFixture.dataRoot, 'overlay')), commitBusinessBefore.overlay)
  assert.deepEqual(treeManifest(path.join(commitFixture.dataRoot, 'skill-review', 'library')), commitBusinessBefore.snapshots)
  assert.deepEqual(fixtureProbeSnapshots(commitFixture, baseEnv), initialProbes)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dryFixture.dataRoot, 'skill-review', 'state.json'), 'utf8')).version, 1)

  const currentStatus = typed(baseEnv, commitFixture.dataRoot, ['status'], 'p2-status-current').envelope.data
  assert.equal(currentStatus.hubRoot, path.resolve(commitFixture.dataRoot))
  assert.equal(currentStatus.lastIngest, null)
  assert.equal(currentStatus.gameRepo, null)
  assert.equal(currentStatus.counts?.resident, residentSkills.length)
  assert.deepEqual(currentStatus.resident.map((skill) => skill.name).sort(), [...residentSkills].sort())
  assert.equal(JSON.stringify(currentStatus).includes('gameRepoId'), false, 'V2 storage identity must not leak through status')

  const beforeRepeatState = fs.readFileSync(stateFile)
  const repeated = typed(baseEnv, commitFixture.dataRoot, [
    'migrate-state', '--commit', '--plan-hash', planned.envelope.data.plan.planHash
  ], 'p2-migration-repeat')
  assert.equal(repeated.envelope.data.status, 'already-current')
  assert.deepEqual(fs.readFileSync(stateFile), beforeRepeatState, 'repeated migration leaves V2 bytes unchanged')

  const claimedBefore = typed(baseEnv, commitFixture.dataRoot, [
    'pin', 'show', '--worktree', commitFixture.claimed
  ], 'p2-pin-claimed-before').envelope.data.pin
  const linkedBefore = typed(baseEnv, commitFixture.dataRoot, [
    'pin', 'show', '--worktree', commitFixture.linked
  ], 'p2-pin-linked-before').envelope.data.pin
  assert.equal(claimedBefore.requestedSnapshot, snapshotB.snapshotId)
  assert.equal(linkedBefore.requestedSnapshot, snapshotB.snapshotId)

  const claimedSet = typed(baseEnv, commitFixture.dataRoot, [
    'pin', 'set', '--worktree', commitFixture.claimed,
    '--snapshot', snapshotA.snapshotId, '--clear-skills'
  ], 'p2-pin-claimed-a')
  const claimedSetData = claimedSet.envelope.data
  assert.deepEqual(Object.keys(claimedSetData).sort(), ['action', 'changed', 'pathKey', 'pin', 'worktreeId'].sort())
  assert.equal(claimedSetData.action, 'setPin')
  assert.match(claimedSetData.pathKey, /^sha256:[a-f0-9]{64}$/)
  assert.match(claimedSetData.worktreeId, /^worktree:[a-f0-9]{24}$/)
  assert.equal(claimedSetData.changed, true)
  assert.deepEqual(claimedSetData.pin, {
    schemaVersion: 1,
    pathKey: claimedSetData.pathKey,
    worktreeId: claimedSetData.worktreeId,
    requestedSnapshot: snapshotA.snapshotId,
    materializedSnapshot: null,
    selectedSkills: [],
    claimState: 'claimed'
  })
  assert.equal(Object.hasOwn(claimedSetData, 'worktree'), false)
  assertNoRawLocator(claimedSet.envelope, commitFixture.claimed, 'setPin envelope')
  const claimedSetLedger = assertCompletedRequest(commitFixture.dataRoot, claimedSet.requestId, 'setPin')
  assertNoRawLocator(claimedSetLedger.entry, commitFixture.claimed, 'setPin ledger entry')
  assertNoRawLocator(claimedSetLedger.entry.result, commitFixture.claimed, 'setPin ledger result')
  typed(baseEnv, commitFixture.dataRoot, [
    'pin', 'set', '--worktree', commitFixture.linked,
    '--snapshot', snapshotB.snapshotId
  ], 'p2-pin-linked-b')

  const claimedRestart = typed(baseEnv, commitFixture.dataRoot, [
    'pin', 'show', '--worktree', commitFixture.claimed
  ], 'p2-pin-claimed-restart').envelope.data
  const linkedRestart = typed(baseEnv, commitFixture.dataRoot, [
    'pin', 'show', '--worktree', commitFixture.linked
  ], 'p2-pin-linked-restart').envelope.data
  const unmanagedRestart = typed(baseEnv, commitFixture.dataRoot, [
    'pin', 'show', '--worktree', commitFixture.unmanaged
  ], 'p2-pin-unmanaged-restart').envelope.data
  for (const [view, expected] of [[claimedRestart, snapshotA.snapshotId], [linkedRestart, snapshotB.snapshotId]]) {
    assert.match(view.pathKey, /^sha256:[a-f0-9]{64}$/)
    assert.equal(view.pin.pathKey, view.pathKey)
    assert.equal(view.pin.requestedSnapshot, expected)
    assert.equal(view.pin.materializedSnapshot, null)
    assert.equal(view.pin.claimState, 'claimed')
    assert.equal('runtimeRevision' in view.pin, false)
  }
  assert.equal(unmanagedRestart.pin, null)
  assert.deepEqual(fixtureProbeSnapshots(commitFixture, baseEnv), initialProbes, 'pin operations never touch probe bytes or index')

  assert.equal(typed(baseEnv, commitFixture.dataRoot, ['inspect-schema'], 'p2-root-primary', 'primary').envelope.data.status, 'current')
  assert.equal(typed(baseEnv, commitFixture.dataRoot, ['inspect-schema'], 'p2-root-legacy', 'legacy').envelope.data.status, 'current')
  const equivalentEnv = rootEnvironment(baseEnv, commitFixture.dataRoot)
  equivalentEnv.SKILL_GRAFT_HOME = `${commitFixture.dataRoot.toUpperCase()}${path.sep}.`
  equivalentEnv.HUB_ROOT = `${commitFixture.dataRoot}${path.sep}`
  const equivalent = runSg([
    'inspect-schema', '--contract-v1', '--request-id', `p2-root-equivalent-${context.runId}`
  ], equivalentEnv, 'p2-root-equivalent')
  assert.equal(parseJsonResult(equivalent, 'equivalent roots').data.status, 'current')

  const conflictPrimary = path.join(context.hubDataRoot, 'conflict-primary')
  const conflictLegacy = path.join(context.hubDataRoot, 'conflict-legacy')
  assert.equal(fs.existsSync(conflictPrimary), false)
  assert.equal(fs.existsSync(conflictLegacy), false)
  const conflictBefore = treeManifest(context.hubDataRoot)
  const conflictEnv = rootEnvironment(baseEnv, conflictPrimary, 'primary')
  conflictEnv.HUB_ROOT = conflictLegacy
  const conflict = runSg(['snapshot', 'create'], conflictEnv, 'p2-root-conflict')
  assert.equal(conflict.error, undefined)
  assert.notEqual(conflict.status, 0)
  assert.match(conflict.stderr, /SKILL_GRAFT_HOME and HUB_ROOT resolve to different data roots/)
  assert.equal(fs.existsSync(conflictPrimary), false)
  assert.equal(fs.existsSync(conflictLegacy), false)
  assert.deepEqual(treeManifest(context.hubDataRoot), conflictBefore, 'root conflict fails before any write')

  const contentionRoot = path.join(context.hubDataRoot, 'lock-contention')
  fs.mkdirSync(contentionRoot, { recursive: true })
  const leaseMs = 3_000
  const contenderA = spawnWorker(baseEnv, tracker, 'lease-contend', contentionRoot, `p2-contend-a-${context.runId}`, { leaseMs })
  const messageA = waitForWorkerMessage(contenderA)
  const contenderB = spawnWorker(baseEnv, tracker, 'lease-contend', contentionRoot, `p2-contend-b-${context.runId}`, { leaseMs })
  const messageB = waitForWorkerMessage(contenderB)
  const contention = await Promise.all([messageA, messageB])
  assert.equal(contention.filter((entry) => entry.status === 'acquired').length, 1)
  assert.equal(contention.filter((entry) => entry.status === 'busy').length, 1)
  const winner = contention[0].status === 'acquired' ? contenderA : contenderB
  const loser = winner === contenderA ? contenderB : contenderA
  await waitForCleanWorkerExit(loser)
  assert.equal(winner.send('release'), true, 'winning lease worker accepts the explicit release signal')
  await waitForCleanWorkerExit(winner)
  await waitUntil(() => lockArtifacts(contentionRoot).length === 0, 5_000, 'contention lock cleanup')

  const walRoot = path.join(context.hubDataRoot, 'lock-wal')
  fs.mkdirSync(walRoot, { recursive: true })
  const walLeaseMs = 2_500
  const seed = runWorker(baseEnv, 'commit', walRoot, `p2-wal-seed-${context.runId}`, {
    leaseMs: walLeaseMs,
    value: 'old-complete'
  })
  assert.equal(seed.result.status, 0, `WAL seed: ${synchronousWorkerDiagnostic(seed)}`)
  assert.equal(seed.output?.status, 'committed')
  const durableStateFile = path.join(walRoot, 'fixture', 'state.json')
  assert.deepEqual(JSON.parse(fs.readFileSync(durableStateFile, 'utf8')), { schemaVersion: 1, value: 'old-complete' })

  const walReady = path.join(context.logsRoot, 'wal-crash-ready.json')
  const crash = spawnWorker(baseEnv, tracker, 'hold-wal', walRoot, `p2-wal-crash-${context.runId}`, {
    leaseMs: walLeaseMs,
    value: 'new-complete',
    readyFile: walReady
  })
  await waitUntil(() => fs.existsSync(walReady), 30_000, 'WAL publication checkpoint')
  const ready = JSON.parse(fs.readFileSync(walReady, 'utf8'))
  assert.equal(ready.pid, crash.pid)
  assert.equal(ready.phase, 'wal-published')
  const walDirectory = path.join(walRoot, '.skill-graft-transactions')
  const walFiles = fs.readdirSync(walDirectory).filter((name) => name.endsWith('.wal.json'))
  assert.deepEqual(walFiles, [`${ready.transactionId}.wal.json`])
  const walFile = path.join(walDirectory, walFiles[0])
  const walBeforeKill = fs.readFileSync(walFile)
  const wal = JSON.parse(walBeforeKill.toString('utf8'))
  assert.equal(wal.format, 'skill-graft.multi-document-wal/v1')
  assert.equal(wal.schemaVersion, 1)
  assert.equal(wal.phase, 'prepared')
  assert.deepEqual(wal.entries.map((entry) => entry.relativePath), ['fixture/state.json'])
  const ownerFile = path.join(walRoot, 'skill-review', 'locks', 'leases', 'hub-global.lock', 'owner.json')
  const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'))
  assert.equal(owner.pid, crash.pid)
  assert.equal(owner.scope, 'hub-global')
  assert.equal(owner.lockKey, 'hub-global')
  const leaseUntil = Date.parse(owner.leaseUntil)
  assert.ok(leaseUntil > Date.now())
  assert.equal(crash.kill('SIGKILL'), true)
  await waitForKilledWorkerExit(crash)
  assert.equal(pidAlive(ready.pid), false, 'crashed lock owner is dead')

  const beforeExpiry = runWorker(baseEnv, 'recover', walRoot, `p2-wal-before-expiry-${context.runId}`, {
    leaseMs: walLeaseMs
  })
  assert.equal(beforeExpiry.result.status, 2, `pre-expiry recovery: ${synchronousWorkerDiagnostic(beforeExpiry)}`)
  assert.equal(beforeExpiry.output?.code, 'LOCK_BUSY')
  assert.equal(beforeExpiry.output?.retryable, true)
  assert.equal(beforeExpiry.output?.reason, 'lease-active')
  assert.deepEqual(JSON.parse(fs.readFileSync(durableStateFile, 'utf8')), { schemaVersion: 1, value: 'old-complete' })
  assert.deepEqual(fs.readFileSync(walFile), walBeforeKill, 'pre-expiry contender cannot alter the WAL')

  const remainingLease = leaseUntil - Date.now() + 200
  if (remainingLease > 0) await new Promise((resolve) => setTimeout(resolve, remainingLease))
  const recovered = runWorker(baseEnv, 'recover', walRoot, `p2-wal-after-expiry-${context.runId}`, {
    leaseMs: walLeaseMs
  })
  assert.equal(recovered.result.status, 0, `post-expiry recovery: ${synchronousWorkerDiagnostic(recovered)}`)
  assert.equal(recovered.output?.status, 'recovered')
  assert.equal(recovered.output?.recoveredTransactions, 1)
  assert.deepEqual(JSON.parse(fs.readFileSync(durableStateFile, 'utf8')), { schemaVersion: 1, value: 'new-complete' })
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(walRoot, 'fixture', '.state.json.skill-graft.bak'), 'utf8')),
    { schemaVersion: 1, value: 'new-complete' }
  )
  await waitUntil(() => transactionArtifacts(walRoot).length === 0, 5_000, 'WAL cleanup')
  await waitUntil(() => lockArtifacts(walRoot).length === 0, 5_000, 'WAL lock cleanup')

  await tracker.stopAll({ graceMs: 500 })
  assert.deepEqual(runOwnedProcesses(), [], 'no marker-owned process remains')
  assert.deepEqual(listening18765(), port18765Before, 'P2 acceptance never changes the 18765 listener set')
  assert.deepEqual(fs.readdirSync(dshHome), [], 'DSH_HOME remains unused')
  assert.equal(fs.existsSync(path.join(installedPackageRoot, 'skill-review', 'state.json')), false)
  assert.equal(fs.existsSync(path.join(installedPackageRoot, '.skill-graft-transactions')), false)
  const workerExpectations = new Map([
    [`p2-contend-a-${context.runId}`, { phase: 'lease-contend', code: 0, signal: null }],
    [`p2-contend-b-${context.runId}`, { phase: 'lease-contend', code: 0, signal: null }],
    [`p2-wal-seed-${context.runId}`, { phase: 'commit', code: 0, signal: null }],
    [`p2-wal-crash-${context.runId}`, { phase: 'hold-wal', code: null, signal: 'SIGKILL' }],
    [`p2-wal-before-expiry-${context.runId}`, { phase: 'recover', code: 2, signal: null }],
    [`p2-wal-after-expiry-${context.runId}`, { phase: 'recover', code: 0, signal: null }]
  ])
  const expectedEvidenceFiles = [...workerExpectations.keys()].flatMap((label) => [
    `${label}.stdout.log`, `${label}.stderr.log`, `${label}.meta.json`
  ]).sort()
  assert.deepEqual(fs.readdirSync(workerLogRoot).sort(), expectedEvidenceFiles, 'every real worker has bounded raw stream evidence and metadata')
  for (const [label, expected] of workerExpectations) {
    const metadata = JSON.parse(fs.readFileSync(path.join(workerLogRoot, `${label}.meta.json`), 'utf8'))
    assert.equal(metadata.schemaVersion, 1)
    assert.equal(metadata.phase, expected.phase)
    assert.equal(Number.isSafeInteger(metadata.pid) && metadata.pid > 0, true)
    assert.deepEqual(metadata.exit, { code: expected.code, signal: expected.signal })
    assert.deepEqual(Object.keys(metadata.streams).sort(), ['stderr', 'stdout'])
    for (const stream of Object.values(metadata.streams)) {
      assert.equal(Number.isSafeInteger(stream.totalBytes), true)
      assert.equal(Number.isSafeInteger(stream.capturedBytes), true)
      assert.equal(stream.capturedBytes <= workerOutputLimit, true)
      assert.equal(stream.truncated, stream.totalBytes > stream.capturedBytes)
      assert.match(stream.capturedSha256, /^sha256:[a-f0-9]{64}$/)
    }
    const serialized = JSON.stringify(metadata)
    assert.equal(/ownerToken|message|details/i.test(serialized), false, 'worker metadata remains redacted')
    assert.equal(serialized.toLowerCase().includes(context.runRoot.toLowerCase()), false, 'worker metadata omits raw paths')
  }
  for (const root of [dryFixture.dataRoot, commitFixture.dataRoot, contentionRoot, walRoot]) {
    assert.equal(transactionArtifacts(root).length, 0, `${path.basename(root)} has no WAL/tmp residue`)
    assert.equal(lockArtifacts(root).length, 0, `${path.basename(root)} has no lock residue`)
  }

  writeSummary({
    schemaVersion: 1,
    runId: context.runId,
    package: {
      name: packed.name,
      version: packed.version,
      shasum: packed.shasum,
      size: packed.size,
      installedPrivateAdapters: 4
    },
    isolation: {
      markerOwned: true,
      globalHostPathEntriesRemoved: isolated.removedPathEntries.length,
      dshHomeUnused: true,
      codexOrDshStarted: false,
      api18765Before: port18765Before,
      api18765After: listening18765(),
      ownedProcessesAfter: 0
    },
    snapshots: {
      snapshotA: snapshotA.snapshotId,
      snapshotB: snapshotB.snapshotId,
      deduplicatedA: true,
      manifestCount: inventoryB.primaryManifests.length,
      blobCount: inventoryB.blobs.length,
      capturedFileCount: snapshotB.files.length,
      overlayExcluded: true
    },
    migration: {
      dryRunClassifications: dry.envelope.data.plan.worktrees.map((entry) => entry.classification).sort(),
      committedClassifications: planned.envelope.data.plan.worktrees.map((entry) => entry.classification).sort(),
      repeatedStatus: repeated.envelope.data.status,
      schemaVersion: stateV2.schemaVersion,
      worktreePins: Object.keys(stateV2.worktrees).length,
      currentStatusRead: true
    },
    pins: {
      claimedRequested: claimedRestart.pin.requestedSnapshot,
      linkedRequested: linkedRestart.pin.requestedSnapshot,
      materializedNull: true,
      probeBytesAndIndexUnchanged: true
    },
    locking: {
      contenderResults: contention.map((entry) => entry.status).sort(),
      ownerDeadBeforeRecovery: true,
      preExpiryCode: beforeExpiry.output.code,
      recoveredTransactions: recovered.output.recoveredTransactions,
      finalValue: 'new-complete',
      residueFiles: 0
    },
    workerEvidence: {
      workers: workerExpectations.size,
      rawStreamFiles: workerExpectations.size * 2,
      metadataFiles: workerExpectations.size
    },
    dataRootAliases: {
      primaryOnly: true,
      legacyOnly: true,
      equivalent: true,
      conflictFailedBeforeWrite: true
    }
  })
})
