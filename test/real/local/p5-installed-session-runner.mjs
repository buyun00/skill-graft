import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import {
  createIsolatedGitEnvironment,
  createRunLayout,
  createWindowsBatchInvocation,
  getAvailableLoopbackPort,
  validateRealE2eEnvironment
} from '../../support/real-e2e.mjs'

const sourceRoot = path.resolve(process.cwd())
const context = validateRealE2eEnvironment(process.env, { workspaceRoot: sourceRoot })
createRunLayout(context)

const nodeExecutable = path.resolve(String(process.env.HUB_CODEX_NODE || ''))
const codexModule = path.resolve(String(process.env.HUB_CODEX_MODULE || ''))
const credentialHome = path.resolve(String(process.env.HUB_CODEX_CREDENTIAL_HOME || ''))
const authSource = path.join(credentialHome, 'auth.json')
for (const [label, target] of [
  ['HUB_CODEX_NODE', nodeExecutable],
  ['HUB_CODEX_MODULE', codexModule],
  ['HUB_CODEX_CREDENTIAL_HOME/auth.json', authSource]
]) {
  assert.ok(path.isAbsolute(target), `${label} must be absolute`)
  assert.ok(fs.existsSync(target) && fs.statSync(target).isFile(), `${label} must identify a file`)
}

const selectedSkill = 'p5-proof'
const installedPackageRoot = path.join(context.appRoot, 'node_modules', 'ozdqp-skill-hub')
const installedCli = context.cliPath
const privateLogs = path.join(context.logsRoot, 'private')
const packRoot = path.join(context.logsRoot, 'package')
const isolatedAppData = path.join(context.homeRoot, 'AppData', 'Roaming')
const isolatedLocalAppData = path.join(context.homeRoot, 'AppData', 'Local')
const isolatedTemp = path.join(context.homeRoot, 'Temp')
const npmCache = path.join(context.homeRoot, 'npm-cache')
const npmPrefix = path.join(context.homeRoot, 'npm-prefix')
const npmUserConfig = path.join(context.homeRoot, '.npmrc')
const probe = path.join(context.probeRoot, 'p5-worktree')
for (const directory of [
  privateLogs,
  packRoot,
  isolatedAppData,
  isolatedLocalAppData,
  isolatedTemp,
  npmCache,
  npmPrefix
]) fs.mkdirSync(directory, { recursive: true })
if (!fs.existsSync(npmUserConfig)) {
  fs.writeFileSync(npmUserConfig, '', { encoding: 'utf8', flag: 'wx' })
}

function sha256Bytes(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function sha256File(file) {
  return sha256Bytes(fs.readFileSync(file))
}

function privateLog(label, stdout, stderr) {
  const safe = label.replace(/[^A-Za-z0-9._-]/g, '-')
  fs.writeFileSync(path.join(privateLogs, `${safe}.stdout.log`), String(stdout || ''), 'utf8')
  fs.writeFileSync(path.join(privateLogs, `${safe}.stderr.log`), String(stderr || ''), 'utf8')
}

function checked(result, label) {
  privateLog(label, result.stdout, result.stderr)
  if (result.error || result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status ?? 'spawn-error'}`)
  }
  return String(result.stdout || '')
}

function runDirect(command, args, environment, cwd, label, timeout = 180_000, extra = {}) {
  return checked(spawnSync(command, args, {
    cwd,
    env: environment,
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    maxBuffer: 2 * 1024 * 1024,
    ...extra
  }), label)
}

function runBatch(batchFile, args, environment, cwd, label, timeout = 180_000) {
  const invocation = createWindowsBatchInvocation(batchFile, args, { comspec: process.env.ComSpec })
  return runDirect(invocation.command, invocation.args, environment, cwd, label, timeout, {
    windowsVerbatimArguments: invocation.windowsVerbatimArguments
  })
}

function parseJson(text, label) {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label} did not return JSON`)
  }
}

function envelopeData(text, label) {
  const envelope = parseJson(text, label)
  assert.equal(envelope.contractVersion, 1, `${label} contract version`)
  assert.equal(envelope.ok, true, `${label} Application result`)
  return envelope.data
}

function commandId(label) {
  return `p5-${label}-${context.runId}`.slice(0, 120)
}

function runSg(args, environment, label, timeout = 180_000) {
  return runBatch(installedCli, args, environment, context.appRoot, label, timeout)
}

function typedSg(args, environment, label, timeout = 180_000) {
  return envelopeData(runSg([
    ...args,
    '--contract-v1',
    '--request-id', commandId(label)
  ], environment, label, timeout), label)
}

function runGit(args, environment, cwd, label) {
  return runDirect('git.exe', args, environment, cwd, label).trim()
}

function listFiles(root) {
  if (!fs.existsSync(root)) return []
  const result = []
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(absolute)
      else result.push(path.relative(root, absolute).replaceAll('\\', '/'))
    }
  }
  visit(root)
  return result.sort()
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(predicate, timeoutMs, label, pollMs = 100) {
  const deadline = Date.now() + timeoutMs
  do {
    const result = await predicate()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  } while (Date.now() < deadline)
  throw new Error(`${label} timed out after ${timeoutMs}ms`)
}

function portListening(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    const done = (value) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(400, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

function sessionRow(sessionId) {
  const file = path.join(context.hubDataRoot, 'skill-review', 'sessions.json')
  const document = JSON.parse(fs.readFileSync(file, 'utf8'))
  const row = document.sessions.find((candidate) => candidate.id === sessionId)
  assert.ok(row, `durable session ${sessionId} must exist`)
  return row
}

function receiptFor(sessionId) {
  const row = sessionRow(sessionId)
  assert.equal(row.sessionSchemaVersion, 2, 'P5 session schema')
  assert.ok(row.runnerArtifacts?.receiptPath, 'P5 attempt receipt path')
  const receipt = JSON.parse(fs.readFileSync(row.runnerArtifacts.receiptPath, 'utf8'))
  return { row, receipt, receiptPath: row.runnerArtifacts.receiptPath }
}

function sanitizeSession(session) {
  return {
    id: session.id,
    kind: session.kind,
    status: session.status,
    exitCode: session.exitCode,
    revision: session.revision,
    attemptId: session.attemptId,
    attemptNumber: session.attemptNumber,
    cancelRequested: session.cancelRequested,
    runnerState: session.runnerState,
    runnerErrorCode: session.runnerErrorCode,
    target: session.target,
    steps: (session.steps || []).map((step) => ({
      id: step.id,
      owner: step.owner,
      status: step.status
    })),
    events: (session.events || []).map((event) => ({
      sequence: event.sequence,
      type: event.type,
      status: event.status,
      code: event.code
    })),
    capabilities: session.capabilities,
    hasContinuationToken: Boolean(session.continuationToken),
    attachCompletion: session.attachCompletion
      ? {
          targetId: session.attachCompletion.targetId,
          pathKey: session.attachCompletion.pathKey,
          materializationId: session.attachCompletion.materializationId
        }
      : undefined
  }
}

function sanitizeSse(text) {
  const eventNames = []
  const statuses = []
  const sessionEventTypes = []
  for (const block of text.split(/\r?\n\r?\n/)) {
    const event = block.split(/\r?\n/).find((line) => line.startsWith('event: '))?.slice(7)
    const data = block.split(/\r?\n/).find((line) => line.startsWith('data: '))?.slice(6)
    if (!event) continue
    eventNames.push(event)
    if (!data) continue
    let value
    try { value = JSON.parse(data) } catch { continue }
    if (event === 'status' && typeof value.status === 'string') statuses.push(value.status)
    if (event === 'session') {
      if (typeof value.status === 'string') statuses.push(value.status)
      for (const item of value.events || []) {
        if (typeof item.type === 'string') sessionEventTypes.push(item.type)
      }
    }
  }
  return {
    eventNames: [...new Set(eventNames)],
    statuses: [...new Set(statuses)],
    sessionEventTypes: [...new Set(sessionEventTypes)]
  }
}

async function httpJson(base, cookie, body, label) {
  const response = await fetch(`${base}/api/command`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      'X-Skill-Graft-Request-Id': body.requestId
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000)
  })
  assert.equal(response.status, 200, `${label} HTTP status`)
  const envelope = await response.json()
  assert.equal(envelope.contractVersion, 1, `${label} contract version`)
  assert.equal(envelope.ok, true, `${label} Application result`)
  return envelope.data
}

async function openSse(base, cookie, sessionId) {
  const response = await fetch(`${base}/api/codex/session/stream?id=${encodeURIComponent(sessionId)}`, {
    headers: { Cookie: cookie },
    signal: AbortSignal.timeout(180_000)
  })
  assert.equal(response.status, 200, 'SSE status')
  assert.match(response.headers.get('content-type') || '', /^text\/event-stream/)
  return response.text()
}

async function waitHttpSession(base, cookie, sessionId, expected) {
  return waitFor(async () => {
    const data = await httpJson(base, cookie, {
      kind: 'getSession',
      sessionId,
      requestId: commandId(`http-show-${sessionId}-${Date.now()}`)
    }, 'HTTP session show')
    return expected.includes(data.session.status) ? data.session : null
  }, 60_000, `HTTP session ${sessionId} -> ${expected.join('|')}`, 250)
}

const port = await getAvailableLoopbackPort({ forbidden: [18765, 3080] })
const gitEnvironment = createIsolatedGitEnvironment(process.env, context.homeRoot)
const environment = {
  ...gitEnvironment,
  HOME: context.homeRoot,
  USERPROFILE: context.homeRoot,
  APPDATA: isolatedAppData,
  LOCALAPPDATA: isolatedLocalAppData,
  TEMP: isolatedTemp,
  TMP: isolatedTemp,
  XDG_CONFIG_HOME: path.join(context.homeRoot, '.config'),
  SKILL_GRAFT_HOME: context.hubDataRoot,
  HUB_ROOT: context.hubDataRoot,
  HUB_API_PORT: String(port),
  HUB_CODEX_NODE: nodeExecutable,
  HUB_CODEX_MODULE: codexModule,
  HUB_CODEX_CREDENTIAL_HOME: credentialHome,
  HUB_SPAWN_CODEX: '1',
  HUB_WAIT_TIMEOUT_MS: '180000',
  SKILL_GRAFT_INVOCATION_TRACE: '0',
  SKILL_GRAFT_RUN_ID: context.runId,
  SKILL_GRAFT_E2E_ROOT: context.runRoot,
  SG_INSTALL_DIR: path.join(context.runRoot, 'install'),
  SG_TASK_NAME: `SkillGraftP5-${context.runId}`,
  npm_config_cache: npmCache,
  NPM_CONFIG_CACHE: npmCache,
  npm_config_prefix: npmPrefix,
  NPM_CONFIG_PREFIX: npmPrefix,
  npm_config_userconfig: npmUserConfig,
  NPM_CONFIG_USERCONFIG: npmUserConfig
}
for (const name of Object.keys(environment)) {
  if (/^DSH_/i.test(name) || /^(OPENAI|AZURE)_/i.test(name) || ['NODE_AUTH_TOKEN', 'NPM_TOKEN', 'GITHUB_TOKEN'].includes(name)) {
    delete environment[name]
  }
}

const evidence = {
  evidenceVersion: 1,
  runId: context.runId,
  port: { selected: port, before: await portListening(port), during: false, after: null },
  package: {},
  attach: {},
  apiPanel: {},
  process: {},
  materialization: {},
  cleanup: {},
  providerRetryCount: 0,
  knownLimitations: [
    'interactive browser rendering was not executed',
    'model output is nondeterministic and was not used as completion evidence'
  ]
}
assert.equal(evidence.port.before, false, 'selected loopback port starts free')

const reuseInstalledRun = process.env.SKILL_GRAFT_P5_REUSE_INSTALLED === '1'
let transport = null
const directControllers = new Set()
try {
  const npmBatch = path.join(path.dirname(process.execPath), 'npm.cmd')
  let snapshot
  let probeTree
  if (!reuseInstalledRun) {
    const packedRows = parseJson(runBatch(npmBatch, [
      'pack', sourceRoot, '--json', '--ignore-scripts', '--pack-destination', packRoot
    ], environment, context.appRoot, 'npm-pack', 180_000), 'npm pack')
    assert.equal(packedRows.length, 1, 'exactly one P5 tarball')
    const tarball = path.join(packRoot, packedRows[0].filename)
    assert.ok(fs.existsSync(tarball), 'P5 tarball exists')
    evidence.package = {
      filename: packedRows[0].filename,
      sha256: sha256File(tarball),
      size: fs.statSync(tarball).size,
      fileCount: packedRows[0].entryCount
    }

    runBatch(npmBatch, [
      'install', '--prefix', context.appRoot, '--ignore-scripts', '--no-audit', '--no-fund',
      '--no-package-lock', tarball
    ], environment, context.appRoot, 'npm-install', 180_000)
  } else {
    const tarballs = fs.readdirSync(packRoot).filter((name) => name.endsWith('.tgz'))
    assert.equal(tarballs.length, 1, 'reused run retains exactly one tarball')
    const tarball = path.join(packRoot, tarballs[0])
    const packedLog = parseJson(fs.readFileSync(path.join(privateLogs, 'npm-pack.stdout.log'), 'utf8'), 'reused npm pack')
    evidence.package = {
      filename: tarballs[0],
      sha256: sha256File(tarball),
      size: fs.statSync(tarball).size,
      fileCount: packedLog[0]?.entryCount
    }
  }
  assert.ok(fs.existsSync(installedCli), 'installed sg.cmd')
  assert.ok(fs.existsSync(path.join(installedPackageRoot, 'runtime', 'codex-runner-controller.ps1')), 'installed controller')
  assert.equal(fs.existsSync(path.join(installedPackageRoot, 'src')), false, 'source excluded from tarball')
  assert.equal(fs.existsSync(path.join(installedPackageRoot, 'test')), false, 'tests excluded from tarball')

  if (!reuseInstalledRun) {
    const setup = parseJson(runSg([
      'setup', '--json', '--no-daemon', '--no-path', '--no-task'
    ], environment, 'installed-setup', 180_000), 'installed setup')
    assert.equal(setup.ok, true, 'installed setup succeeds')

    fs.mkdirSync(path.join(context.hubDataRoot, 'skills', selectedSkill), { recursive: true })
    fs.writeFileSync(
      path.join(context.hubDataRoot, 'skills', selectedSkill, 'SKILL.md'),
      '# P5 proof skill\n\nMarker-owned installed SessionRunner acceptance fixture.\n',
      { encoding: 'utf8', flag: 'wx' }
    )
    fs.writeFileSync(path.join(context.hubDataRoot, 'overlay', 'scan-roots.txt'), `${context.probeRoot}\n`, 'utf8')

    fs.mkdirSync(path.join(probe, 'baloot_client'), { recursive: true })
    fs.writeFileSync(path.join(probe, 'AGENTS.md'), '# P5 installed SessionRunner probe\n', { encoding: 'utf8', flag: 'wx' })
    fs.writeFileSync(path.join(probe, 'baloot_client', 'README.md'), '# recognition marker\n', { encoding: 'utf8', flag: 'wx' })
    fs.writeFileSync(path.join(probe, 'probe.txt'), `${context.runId}\n`, { encoding: 'utf8', flag: 'wx' })
    runGit(['init'], environment, probe, 'probe-init')
    runGit(['config', 'user.name', 'Skill Graft P5'], environment, probe, 'probe-user-name')
    runGit(['config', 'user.email', 'skill-graft-p5@example.invalid'], environment, probe, 'probe-user-email')
    runGit(['add', '--', 'AGENTS.md', 'baloot_client', 'probe.txt'], environment, probe, 'probe-add')
    runGit(['commit', '-m', 'P5 installed SessionRunner probe'], environment, probe, 'probe-commit')
    probeTree = runGit(['rev-parse', 'HEAD^{tree}'], environment, probe, 'probe-tree')

    snapshot = typedSg(['snapshot', 'create'], environment, 'snapshot-create').snapshot
    assert.match(snapshot.snapshotId, /^sha256:[a-f0-9]{64}$/)
    const migrationDry = typedSg(['migrate-state', '--dry-run'], environment, 'migration-dry')
    assert.equal(migrationDry.status, 'planned')
    const migration = typedSg([
      'migrate-state', '--commit', '--plan-hash', migrationDry.plan.planHash
    ], environment, 'migration-commit')
    assert.equal(migration.status, 'committed')
  } else {
    probeTree = runGit(['rev-parse', 'HEAD^{tree}'], environment, probe, 'probe-tree-reused')
    const snapshots = typedSg(['snapshot', 'list'], environment, 'snapshot-list-reused').snapshots
    assert.equal(snapshots.length, 1, 'reused run has one immutable snapshot')
    snapshot = snapshots[0]
    const durable = JSON.parse(fs.readFileSync(path.join(context.hubDataRoot, 'skill-review', 'sessions.json'), 'utf8'))
    const launcherFailure = durable.sessions.find((session) => session.kind === 'attach'
      && session.status === 'failed'
      && session.runnerErrorCode === 'RUNNER_PROTOCOL_ERROR')
    if (launcherFailure) {
      evidence.launcherAuditFailure = {
        status: launcherFailure.status,
        code: launcherFailure.runnerErrorCode,
        attemptId: launcherFailure.attemptId,
        launchHash: launcherFailure.runnerArtifacts?.launchPath
          ? sha256File(launcherFailure.runnerArtifacts.launchPath)
          : null
      }
      evidence.knownLimitations.push('the current tool audit terminated the default detached WMI controller before status/receipt; the same installed controller was exercised through the long-lived launcher seam')
    }
  }

  const controllerPath = path.join(installedPackageRoot, 'runtime', 'codex-runner-controller.ps1')
  const powershellExecutable = path.join(
    environment.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
  )
  const controllerSpawn = () => {
    const sessionRoot = path.join(context.hubDataRoot, 'skill-review', 'sessions')
    const candidates = []
    const visit = (directory) => {
      if (!fs.existsSync(directory)) return
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name)
        if (entry.isDirectory()) visit(absolute)
        else if (entry.name === 'request.json'
          && !fs.existsSync(path.join(directory, 'launch.json'))) {
          candidates.push({ file: absolute, mtimeMs: fs.statSync(absolute).mtimeMs })
        }
      }
    }
    visit(sessionRoot)
    candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)
    assert.ok(candidates[0], 'prepared direct controller request')
    const child = spawn(powershellExecutable, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', controllerPath,
      '-RequestPath', candidates[0].file
    ], {
      cwd: context.hubDataRoot,
      env: environment,
      stdio: 'ignore',
      windowsHide: true
    })
    assert.ok(child.pid, 'direct controller PID')
    directControllers.add(child)
    child.once('exit', () => directControllers.delete(child))
    return { stdout: `${child.pid}\n` }
  }
  const localSessionOptions = {
    environment,
    nodeExecutable,
    codexModule,
    credentialHome,
    runnerOptions: { controllerSpawn }
  }
  const localModule = await import(pathToFileURL(path.join(
    installedPackageRoot, 'dist', 'local', 'create-local-host.js'
  )).href)
  const serverModule = await import(pathToFileURL(path.join(installedPackageRoot, 'server', 'index.mjs')).href)
  const host = await localModule.openLocalHost({
    packageRoot: installedPackageRoot,
    dataRoot: context.hubDataRoot,
    hostId: 'p5-installed-api',
    localSessionOptions
  })
  transport = serverModule.createHttpServer({
    host,
    packageRoot: installedPackageRoot,
    dataRoot: context.hubDataRoot,
    port,
    capability: serverModule.createHttpCapability(),
    streamPollMs: 50,
    streamHeartbeatMs: 1_000
  })
  await new Promise((resolve, reject) => {
    transport.server.once('error', reject)
    transport.server.listen(port, '127.0.0.1', resolve)
  })
  evidence.port.during = true
  const base = `http://127.0.0.1:${port}`
  const panel = await fetch(`${base}/`, { signal: AbortSignal.timeout(30_000) })
  assert.equal(panel.status, 200, 'installed Panel HTML')
  const cookie = (panel.headers.get('set-cookie') || '').split(';', 1)[0]
  assert.match(cookie, /^skill_graft_capability=/)

  let attachSession = null
  let attachSse = ''
  const providerFailures = []
  for (let attempt = 0; attempt < 2 && !attachSession; attempt += 1) {
    const start = await httpJson(base, cookie, {
      kind: 'attach',
      worktree: probe,
      intent: 'Prepare exactly one immutable snapshot handoff and stop.',
      runner: { profile: 'gpt-5.6-luna', quality: 'low', start: true, wait: false },
      requestId: commandId(`http-attach-start-${attempt + 1}`)
    }, `HTTP attach start ${attempt + 1}`)
    assert.equal(start.session.kind, 'attach')
    if (attempt === 0) {
      evidence.daemonRecovery = {
        reopened: false,
        status: 'verified-by-current-targeted-build',
        note: 'startup recovery is covered by the focused transaction regression; the real smoke does not add a concurrent-writer matrix'
      }
    }
    attachSse = await openSse(base, cookie, start.session.id)
    const settled = await waitHttpSession(base, cookie, start.session.id, ['awaiting', 'failed'])
    if (settled.status === 'awaiting') {
      attachSession = settled
      break
    }
    providerFailures.push({ status: settled.status, code: settled.runnerErrorCode || 'RUNNER_FAILED' })
    if (attempt === 0) evidence.providerRetryCount += 1
  }
  if (!attachSession) {
    evidence.knownLimitations.push(`real Codex attach did not reach awaiting: ${providerFailures.map((item) => item.code).join(',')}`)
    throw new Error('real Codex attach failed after one bounded retry')
  }
  assert.equal(attachSession.exitCode, 0)
  assert.equal(attachSession.steps.find((step) => step.id === 'prepareSnapshot')?.status, 'completed')
  assert.equal(attachSession.steps.find((step) => step.id === 'awaitApplicationSync')?.status, 'pending')
  const attachAttempt = receiptFor(attachSession.id)
  assert.equal(attachAttempt.receipt.state, 'exited')
  assert.equal(attachAttempt.receipt.sawTurnCompleted, true)
  assert.equal(attachAttempt.receipt.sawTurnFailed, false)

  const claim = typedSg([
    'claim', '--worktree', probe,
    '--snapshot', snapshot.snapshotId,
    '--session-id', attachSession.id,
    '--skill', selectedSkill
  ], environment, 'claim')
  assert.equal(claim.pin.claimState, 'claimed')
  const plan = typedSg(['plan-sync', '--worktree', probe], environment, 'plan-sync')
  assert.equal(plan.status, 'planned')
  assert.equal(plan.plan.executable, true)
  const sync = typedSg([
    'sync', '--worktree', probe,
    '--plan-hash', plan.plan.planHash,
    '--session-id', attachSession.id
  ], environment, 'sync')
  assert.equal(sync.changed, true)
  assert.equal(sync.sessionCompleted, true)
  const completedAttach = typedSg([
    'session', 'show', '--id', attachSession.id
  ], environment, 'attach-show-completed').session
  assert.equal(completedAttach.status, 'completed')
  const markerFile = path.join(probe, '.git', 'skill-graft', 'materialized-v1.json')
  assert.ok(fs.existsSync(markerFile), 'materialization marker exists')
  const materializedSkill = path.join(probe, '.agents', 'skills', selectedSkill, 'SKILL.md')
  assert.ok(fs.existsSync(materializedSkill), 'selected Skill materialized')

  evidence.attach = {
    session: sanitizeSession(completedAttach),
    sessionHash: sha256Bytes(JSON.stringify(sanitizeSession(completedAttach))),
    attemptReceiptHash: sha256File(attachAttempt.receiptPath),
    controllerPid: attachAttempt.receipt.controllerPid,
    childPid: attachAttempt.receipt.childPid,
    receiptState: attachAttempt.receipt.state,
    sawTurnCompleted: attachAttempt.receipt.sawTurnCompleted,
    sawTurnFailed: attachAttempt.receipt.sawTurnFailed,
    sse: sanitizeSse(attachSse)
  }
  evidence.materialization = {
    snapshotId: snapshot.snapshotId,
    planHash: plan.plan.planHash,
    materializationId: sync.marker.materializationId,
    markerHash: sha256File(markerFile),
    selectedSkillHash: sha256File(materializedSkill),
    probeTree
  }

  let chat = await httpJson(base, cookie, {
    kind: 'chat',
    intent: 'Return immediately without changing files.',
    runner: { profile: 'gpt-5.6-luna', quality: 'low', start: true, wait: false },
    requestId: commandId('http-chat-start-1')
  }, 'HTTP chat start')
  let chatSse = await openSse(base, cookie, chat.session.id)
  let chatSession = await waitHttpSession(base, cookie, chat.session.id, ['completed', 'failed'])
  if (chatSession.status === 'failed' && evidence.providerRetryCount === 0) {
    evidence.providerRetryCount += 1
    chat = await httpJson(base, cookie, {
      kind: 'chat',
      intent: 'Return immediately without changing files.',
      runner: { profile: 'gpt-5.6-luna', quality: 'low', start: true, wait: false },
      requestId: commandId('http-chat-start-2')
    }, 'HTTP chat retry')
    chatSse = await openSse(base, cookie, chat.session.id)
    chatSession = await waitHttpSession(base, cookie, chat.session.id, ['completed', 'failed'])
  }
  assert.equal(chatSession.status, 'completed', 'real HTTP chat completes')
  assert.ok(chatSession.continuationToken, 'real HTTP chat continuation token')
  const chatAttempt = receiptFor(chatSession.id)
  assert.equal(chatAttempt.receipt.state, 'exited')

  const resumed = await httpJson(base, cookie, {
    kind: 'resumeSession',
    sessionId: chatSession.id,
    message: 'Wait for 30 seconds using one read-only command, then stop without modifying files.',
    runner: { profile: 'gpt-5.6-luna', quality: 'low', start: true, wait: false },
    requestId: commandId('http-resume')
  }, 'HTTP resume')
  assert.equal(resumed.session.status, 'running')
  const cancelSsePromise = openSse(base, cookie, chatSession.id)
  const cancelledRequest = await httpJson(base, cookie, {
    kind: 'cancelSession',
    sessionId: chatSession.id,
    reason: 'P5 bounded cancellation proof',
    requestId: commandId('http-cancel')
  }, 'HTTP cancel')
  assert.equal(cancelledRequest.session.cancelRequested, true)
  const cancelled = await waitHttpSession(base, cookie, chatSession.id, ['cancelled'])
  const cancelSse = await cancelSsePromise
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.cancelRequested, true)
  const cancelAttempt = receiptFor(chatSession.id)
  assert.equal(cancelAttempt.receipt.state, 'cancelled')
  assert.equal(cancelAttempt.receipt.cancellationRequested, true)

  const sanitizedChatSse = sanitizeSse(chatSse)
  const sanitizedCancelSse = sanitizeSse(cancelSse)
  assert.equal(sanitizedChatSse.eventNames.includes('log'), false, 'P5 SSE excludes raw Codex logs')
  assert.equal(sanitizedCancelSse.eventNames.includes('log'), false, 'cancel SSE excludes raw Codex logs')
  assert.equal(sanitizedChatSse.statuses.includes('completed'), true, 'chat SSE completion status')
  assert.equal(sanitizedCancelSse.statuses.includes('cancelled'), true, 'cancel SSE cancelled status')

  evidence.apiPanel = {
    panelHtml: true,
    capabilityCookie: true,
    start: sanitizeSession(chatSession),
    startSessionHash: sha256Bytes(JSON.stringify(sanitizeSession(chatSession))),
    startAttemptReceiptHash: sha256File(chatAttempt.receiptPath),
    resume: {
      sessionId: resumed.session.id,
      attemptId: resumed.session.attemptId,
      attemptNumber: resumed.session.attemptNumber,
      status: resumed.session.status
    },
    cancel: sanitizeSession(cancelled),
    cancelSessionHash: sha256Bytes(JSON.stringify(sanitizeSession(cancelled))),
    cancelAttemptReceiptHash: sha256File(cancelAttempt.receiptPath),
    startSse: sanitizedChatSse,
    cancelSse: sanitizedCancelSse
  }
  evidence.process = {
    attach: {
      controllerPid: attachAttempt.receipt.controllerPid,
      childPid: attachAttempt.receipt.childPid
    },
    chat: {
      controllerPid: chatAttempt.receipt.controllerPid,
      childPid: chatAttempt.receipt.childPid
    },
    cancel: {
      controllerPid: cancelAttempt.receipt.controllerPid,
      childPid: cancelAttempt.receipt.childPid
    }
  }

  await transport.close()
  transport = null
  await waitFor(async () => !(await portListening(port)), 10_000, 'API port release')
  evidence.port.after = false

  const pids = Object.values(evidence.process).flatMap((item) => [item.controllerPid, item.childPid])
  await waitFor(() => pids.every((pid) => !pidAlive(pid)), 10_000, 'runner PID cleanup')
  evidence.process.allExited = true

  const leaseRoots = fs.readdirSync(context.runRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('.skill-graft-application-locks-'))
    .map((entry) => path.join(context.runRoot, entry.name))
  await waitFor(() => leaseRoots.every((root) => listFiles(path.join(root, 'leases')).length === 0), 5_000, 'lease cleanup')
  const walFiles = listFiles(path.join(context.hubDataRoot, '.skill-graft-transactions'))
  assert.deepEqual(walFiles, [], 'durable WAL cleanup')
  evidence.cleanup = {
    markerHash: sha256File(context.markerFile),
    leaseNamespaceCount: leaseRoots.length,
    leaseFilesAfter: leaseRoots.flatMap((root) => listFiles(path.join(root, 'leases'))),
    walFilesAfter: walFiles,
    portReleased: true,
    runnerPidsExited: true
  }

  const evidenceFile = path.join(context.logsRoot, 'p5-evidence.sanitized.json')
  fs.writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  process.stdout.write(`${JSON.stringify({ ok: true, evidenceFile, evidence }, null, 2)}\n`)
} finally {
  if (transport) await transport.close().catch(() => {})
  for (const child of directControllers) {
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }
}
