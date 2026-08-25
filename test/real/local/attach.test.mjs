import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  ProcessTracker,
  assertRunLayoutOwned,
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

if (!fs.existsSync(context.cliPath) || !fs.statSync(context.cliPath).isFile()) {
  throw new Error(`installed CLI is missing: ${context.cliPath}`)
}
assertRunLayoutOwned(context)
if (!fs.existsSync(path.join(context.probeRoot, '.git'))) throw new Error('real probe must be an isolated Git checkout')
if (!fs.existsSync(path.join(context.probeRoot, 'AGENTS.md'))) throw new Error('real probe is missing AGENTS.md')
if (!fs.existsSync(path.join(context.probeRoot, 'baloot_client'))) throw new Error('real probe is missing baloot_client')
for (const required of [
  'AGENTS.override.md',
  'overlay/prompts/attach.txt',
  'overlay/attach-library.ps1',
  'overlay/manage-skill-visibility.ps1',
  'skills/ozdqp-development/SKILL.md',
  'skills/ozdqp-ui-development/SKILL.md',
  'skills/ozdqp-git-workflow/SKILL.md'
]) {
  if (!fs.existsSync(path.join(context.hubDataRoot, ...required.split('/')))) {
    throw new Error(`isolated hub-data is missing ${required}`)
  }
}

const installedPackageRoot = path.resolve(path.dirname(context.cliPath), '..', '..')
const installedServer = path.join(installedPackageRoot, 'server', 'index.mjs')

function isolatedEnv(overrides = {}) {
  return {
    ...process.env,
    HUB_ROOT: context.hubDataRoot,
    SKILL_GRAFT_HOME: context.hubDataRoot,
    HUB_SPAWN_CODEX: '0',
    ...overrides
  }
}

function runCli(args, overrides = {}) {
  return spawnSync(process.execPath, [context.cliPath, ...args], {
    cwd: context.appRoot,
    env: isolatedEnv(overrides),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000
  })
}

function parseResult(result, label) {
  assert.equal(result.status, 0, `${label}: ${result.error || result.stderr || result.stdout}`)
  return JSON.parse(result.stdout)
}

function git(args) {
  return spawnSync('git', ['-C', context.probeRoot, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  })
}

function writeSummary(name, value) {
  fs.writeFileSync(path.join(context.logsRoot, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function ownedSessionProcessPaths() {
  const review = path.join(context.hubDataRoot, 'skill-review')
  if (!fs.existsSync(review)) return []
  const owned = fs.readdirSync(review)
    .filter((name) => /^run-codex-.*\.cmd$|^session-.*\.last\.txt$/i.test(name))
    .map((name) => path.join(review, name))
  try {
    const payload = JSON.parse(fs.readFileSync(path.join(review, 'sessions.json'), 'utf8'))
    for (const session of payload.sessions || []) {
      for (const candidate of [session.lastFile, session.logFile, session.promptFile]) {
        if (!candidate) continue
        const resolved = path.resolve(String(candidate))
        const relative = path.relative(review, resolved)
        if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
          owned.push(resolved)
        }
      }
    }
  } catch {
    // Existing runner files remain sufficient to identify the WMI cmd parent.
  }
  return [...new Set(owned)]
}

function trackRecordedSessionPids(tracker) {
  const file = path.join(context.hubDataRoot, 'skill-review', 'sessions.json')
  try {
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'))
    for (const session of payload.sessions || []) {
      if (session.status === 'running' && Number(session.pid) > 0) {
        tracker.trackPid(session.pid, { commandIncludes: context.runId })
      }
    }
  } catch {
    // The marker-owned runner sweep below is the fail-closed fallback for a
    // malformed or partially written session file.
  }
  const ownedPaths = ownedSessionProcessPaths()
  if (ownedPaths.length > 0) {
    tracker.trackWindowsOwnedPids({ commandIncludes: context.runId, pathIncludesAny: ownedPaths })
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForHealth(port, expected, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  let last = false
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) })
      last = res.ok
    } catch {
      last = false
    }
    if (last === expected) return last
    await delay(200)
  }
  return last
}

function controlledWorkflowChanges(porcelain) {
  const allowedRoots = [
    '.agents/skills/ozdqp-development',
    '.agents/skills/ozdqp-ui-development',
    '.agents/skills/ozdqp-git-workflow',
    '.codex/local-overlay'
  ]
  const entries = String(porcelain || '')
    .split('\0')
    .filter(Boolean)
  const unexpected = entries.filter((line) => {
    if (!line.startsWith('?? ')) return true
    const relative = line.slice(3).replaceAll('\\', '/').toLowerCase()
    return relative !== 'agents.override.md'
      && !allowedRoots.some((root) => relative === root || relative.startsWith(`${root}/`))
  })
  return { entries, unexpected }
}

function legacyVisibilityPath(relative) {
  const normalized = relative.replaceAll('\\', '/').toLowerCase()
  if (normalized.startsWith('.claude/')) return true
  if (normalized.startsWith('.agents/skills/')) {
    return ![
      '.agents/skills/ozdqp-development/',
      '.agents/skills/ozdqp-ui-development/',
      '.agents/skills/ozdqp-git-workflow/',
      '.agents/skills/unity-skills/'
    ].some((prefix) => normalized.startsWith(prefix))
  }
  return normalized.startsWith('.codex/agents/')
    || normalized.startsWith('.codex/scripts/')
    || normalized.startsWith('.codex/skills/')
    || normalized === '.codex/cursor-rules.env'
}

function parseIndexFlags(output) {
  const entries = new Map()
  for (const record of String(output || '').split('\0').filter(Boolean)) {
    assert.equal(record[1], ' ', `unexpected git ls-files -v record: ${record}`)
    entries.set(record.slice(2).replaceAll('\\', '/'), record[0])
  }
  return entries
}

function allowedVisibilityChanges(beforeOutput, afterOutput) {
  const before = parseIndexFlags(beforeOutput)
  const after = parseIndexFlags(afterOutput)
  assert.deepEqual([...after.keys()], [...before.keys()], 'attach must not add or remove index entries')
  const changes = []
  const unexpected = []
  for (const [relative, beforeFlag] of before) {
    const afterFlag = after.get(relative)
    if (afterFlag === beforeFlag) continue
    const change = { relative, beforeFlag, afterFlag }
    changes.push(change)
    if (!(beforeFlag === 'H' && afterFlag === 'S' && legacyVisibilityPath(relative))) unexpected.push(change)
  }
  return { changes, unexpected }
}

function comparablePath(target) {
  const resolved = path.resolve(target)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function assertDirectoryLink(linkPath, targetPath, label) {
  assert.equal(fs.existsSync(linkPath), true, `${label} link exists`)
  assert.equal(
    comparablePath(fs.realpathSync.native(linkPath)),
    comparablePath(fs.realpathSync.native(targetPath)),
    `${label} must resolve to the isolated hub target`
  )
}

function assertHardLink(linkPath, targetPath, label) {
  const link = fs.statSync(linkPath)
  const target = fs.statSync(targetPath)
  assert.equal(link.dev, target.dev, `${label} device`)
  assert.equal(link.ino, target.ino, `${label} file identity`)
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function daemonStatusReady(status, port) {
  const heartbeat = status.heartbeat || {}
  const lastBeat = Date.parse(String(heartbeat.lastBeat || ''))
  return status.running === true
    && status.apiHealthy === true
    && Number(status.pid) > 0
    && Number(status.apiPid) > 0
    && heartbeat.apiHealthy === true
    && Number(heartbeat.pid) === Number(status.pid)
    && Number(heartbeat.apiPid) === Number(status.apiPid)
    && Number(heartbeat.port) === port
    && Number.isFinite(lastBeat)
    && Date.now() - lastBeat >= -5000
    && Date.now() - lastBeat < 30000
}

async function waitForDaemonStatus(port, initialStatus, timeoutMs = 30000) {
  const samples = [{
    running: initialStatus.running,
    apiHealthy: initialStatus.apiHealthy,
    pid: initialStatus.pid,
    apiPid: initialStatus.apiPid,
    heartbeatPort: initialStatus.heartbeat?.port || null,
    heartbeatLastBeat: initialStatus.heartbeat?.lastBeat || null
  }]
  let status = initialStatus
  const deadline = Date.now() + timeoutMs
  while (!daemonStatusReady(status, port) && Date.now() < deadline) {
    await delay(500)
    status = parseResult(runCli(['daemon', 'status'], { HUB_API_PORT: String(port) }), 'daemon status convergence')
    samples.push({
      running: status.running,
      apiHealthy: status.apiHealthy,
      pid: status.pid,
      apiPid: status.apiPid,
      heartbeatPort: status.heartbeat?.port || null,
      heartbeatLastBeat: status.heartbeat?.lastBeat || null
    })
  }
  return { status, samples }
}

test('packed Local distribution performs one explicitly enabled real Codex attach in the run-id probe', { timeout: 40 * 60 * 1000 }, async (t) => {
  const tracker = new ProcessTracker({ runId: context.runId })
  t.after(async () => {
    const errors = []
    try {
      trackRecordedSessionPids(tracker)
    } catch (error) {
      errors.push(error)
    }
    try {
      await tracker.stopAll({ graceMs: 500 })
    } catch (error) {
      errors.push(error)
    }
    if (errors.length > 0) throw new AggregateError(errors, 'real attach cleanup failed')
  })

  const beforeStatus = git(['status', '--porcelain=v1', '--untracked-files=all'])
  assert.equal(beforeStatus.status, 0, beforeStatus.stderr)
  assert.equal(beforeStatus.stdout.trim(), '', 'isolated probe must start clean')
  const beforeHead = git(['rev-parse', 'HEAD'])
  assert.equal(beforeHead.status, 0, beforeHead.stderr)
  const beforeStage = git(['ls-files', '--stage', '-z'])
  assert.equal(beforeStage.status, 0, beforeStage.stderr)
  const beforeVisibility = git(['ls-files', '-v', '-z'])
  assert.equal(beforeVisibility.status, 0, beforeVisibility.stderr)

  fs.writeFileSync(path.join(context.hubDataRoot, 'overlay', 'scan-roots.txt'), `${path.dirname(context.probeRoot)}\n`, 'utf8')
  const statusBefore = parseResult(runCli(['status']), 'status before attach')
  const worktreesBefore = parseResult(runCli(['list-worktrees']), 'list-worktrees before attach')
  const beforeRow = worktreesBefore.worktrees.find((row) => path.resolve(row.path).toLowerCase() === context.probeRoot.toLowerCase())
  assert.ok(beforeRow, 'isolated probe must be discoverable before attach')
  assert.equal(beforeRow.attached, false, 'isolated probe must start unattached')

  const attachResult = runCli([
    'attach',
    '--worktree', context.probeRoot,
    '--intent', `P0 real attach acceptance for ${context.runId}`
  ], {
    HUB_SPAWN_CODEX: '1',
    HUB_WAIT_TIMEOUT_MS: String(35 * 60 * 1000)
  })
  trackRecordedSessionPids(tracker)
  const attach = parseResult(attachResult, 'attach start')
  assert.equal(attach.ok, true)
  assert.equal(attach.action, 'attach')
  assert.equal(attach.applied, null)
  assert.equal(attach.session.status, 'running')
  assert.ok(attach.session.pid > 0, 'detached Codex PID')
  tracker.trackPid(attach.session.pid, { commandIncludes: context.runId })

  const deadline = Date.now() + 35 * 60 * 1000
  let session = attach.session
  while (session.status === 'running' && Date.now() < deadline) {
    await delay(1000)
    session = parseResult(runCli(['session', '--id', attach.session.id]), 'session poll').session
  }
  assert.notEqual(session.status, 'running', 'Codex attach timed out')
  assert.equal(session.status, 'waiting', JSON.stringify({ status: session.status, exitCode: session.exitCode, error: session.error }))
  assert.equal(session.exitCode, 0)
  assert.ok(session.codexSessionId, 'real Codex session ID')

  const worktreesAfter = parseResult(runCli(['list-worktrees']), 'list-worktrees after attach')
  const afterRow = worktreesAfter.worktrees.find((row) => path.resolve(row.path).toLowerCase() === context.probeRoot.toLowerCase())
  assert.ok(afterRow, 'isolated probe after attach')
  assert.equal(afterRow.attached, true)
  assert.equal(afterRow.overrideLinked, true)
  assert.equal(afterRow.officialPresent, false)
  for (const name of ['ozdqp-development', 'ozdqp-ui-development', 'ozdqp-git-workflow']) {
    assertDirectoryLink(
      path.join(context.probeRoot, '.agents', 'skills', name),
      path.join(context.hubDataRoot, 'skills', name),
      name
    )
  }
  assertDirectoryLink(
    path.join(context.probeRoot, '.codex', 'local-overlay'),
    path.join(context.hubDataRoot, 'overlay'),
    'local overlay'
  )
  assertHardLink(
    path.join(context.probeRoot, 'AGENTS.override.md'),
    path.join(context.hubDataRoot, 'AGENTS.override.md'),
    'AGENTS.override.md'
  )

  const trackedDiff = git(['diff', '--name-only'])
  assert.equal(trackedDiff.status, 0, trackedDiff.stderr)
  assert.equal(trackedDiff.stdout.trim(), '', 'attach must not modify tracked probe files')
  const stagedDiff = git(['diff', '--cached', '--name-only'])
  assert.equal(stagedDiff.status, 0, stagedDiff.stderr)
  assert.equal(stagedDiff.stdout.trim(), '', 'attach must not stage probe files')
  const afterStage = git(['ls-files', '--stage', '-z'])
  assert.equal(afterStage.status, 0, afterStage.stderr)
  assert.equal(afterStage.stdout, beforeStage.stdout, 'attach must preserve every index blob and mode')
  const afterVisibility = git(['ls-files', '-v', '-z'])
  assert.equal(afterVisibility.status, 0, afterVisibility.stderr)
  const visibilityChanges = allowedVisibilityChanges(beforeVisibility.stdout, afterVisibility.stdout)
  assert.deepEqual(visibilityChanges.unexpected, [], 'attach changed index visibility outside legacy assistant paths')
  const afterStatus = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  assert.equal(afterStatus.status, 0, afterStatus.stderr)
  const workflowChanges = controlledWorkflowChanges(afterStatus.stdout)
  assert.deepEqual(workflowChanges.unexpected, [], `attach wrote outside the controlled local-workflow boundary:\n${workflowChanges.unexpected.join('\n')}`)
  const afterHead = git(['rev-parse', 'HEAD'])
  assert.equal(afterHead.stdout.trim(), beforeHead.stdout.trim(), 'attach must not change the probe commit')

  writeSummary('real-attach-summary.json', {
    runId: context.runId,
    baseline: {
      statusKeys: Object.keys(statusBefore).sort(),
      worktreeKeys: Object.keys(beforeRow).sort(),
      probeHead: beforeHead.stdout.trim()
    },
    attach: {
      envelopeKeys: Object.keys(attach).sort(),
      sessionId: session.id,
      codexSessionId: session.codexSessionId,
      status: session.status,
      exitCode: session.exitCode,
      model: session.model,
      effort: session.effort
    },
    result: {
      attached: afterRow.attached,
      overrideLinked: afterRow.overrideLinked,
      officialPresent: afterRow.officialPresent,
      probeTrackedGitClean: true,
      controlledWorkflowUntrackedCount: workflowChanges.entries.length,
      legacySkipWorktreeCount: visibilityChanges.changes.length,
      unexpectedProbeChanges: workflowChanges.unexpected
    }
  })
})

test('packed Local daemon starts on a random port, serves API and panel, then stops without a listener', { timeout: 90000 }, async (t) => {
  assert.equal(fs.existsSync(installedServer), true, 'packed server/index.mjs')
  const port = await getAvailableLoopbackPort()
  assert.notEqual(port, 18765, 'isolated daemon must not use the live port')
  assert.notEqual(port, 3080, 'isolated daemon must not use the DSH development port')
  const tracker = new ProcessTracker({ runId: context.runId })
  t.after(async () => tracker.stopAll({ graceMs: 500 }))

  const daemon = spawn(process.execPath, [context.cliPath, 'daemon', 'run'], {
    cwd: installedPackageRoot,
    env: isolatedEnv({ HUB_API_PORT: String(port) }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  tracker.track(daemon)
  tracker.trackPid(daemon.pid, { commandIncludes: context.runId })
  assert.equal(await waitForHealth(port, true), true, 'daemon health')

  const apiPidFile = path.join(installedPackageRoot, 'skill-review', 'api.pid')
  assert.equal(fs.existsSync(apiPidFile), true, 'daemon api.pid')
  const apiPid = Number(fs.readFileSync(apiPidFile, 'utf8').trim())
  tracker.trackPid(apiPid, { commandIncludes: context.runId })

  const health = await fetch(`http://127.0.0.1:${port}/api/health`)
  assert.deepEqual(await health.json(), { ok: true })
  const page = await fetch(`http://127.0.0.1:${port}/`)
  const html = await page.text()
  assert.equal(page.ok, true)
  assert.match(page.headers.get('content-type') || '', /text\/html/)
  assert.match(html, /总览|Skill Hub|技能库/)
  const initialDaemonStatus = parseResult(runCli(['daemon', 'status'], { HUB_API_PORT: String(port) }), 'initial daemon status')
  const statusConvergence = await waitForDaemonStatus(port, initialDaemonStatus)
  const daemonStatus = statusConvergence.status
  assert.equal(daemonStatusReady(daemonStatus, port), true, `daemon status did not converge after ${statusConvergence.samples.length} samples`)

  const daemonPidFile = path.join(installedPackageRoot, 'skill-review', 'daemon.pid')
  const daemonPid = daemonStatus.pid
  const stopped = parseResult(runCli(['daemon', 'stop'], { HUB_API_PORT: String(port) }), 'daemon stop')
  assert.equal(stopped.ok, true)
  assert.equal(await waitForHealth(port, false), false, 'random daemon port must be released')
  assert.equal(pidAlive(daemonPid), false, 'daemon PID must exit after stop')
  assert.equal(pidAlive(apiPid), false, 'API PID must exit after stop')
  assert.equal(fs.existsSync(daemonPidFile), false, 'daemon.pid must be removed after stop')
  assert.equal(fs.existsSync(apiPidFile), false, 'api.pid must be removed after stop')
  await tracker.stopAll({ graceMs: 500 })

  writeSummary('real-daemon-summary.json', {
    runId: context.runId,
    port,
    health: { status: health.status, body: { ok: true } },
    page: { status: page.status, contentType: page.headers.get('content-type') },
    daemon: {
      statusKeys: Object.keys(daemonStatus).sort(),
      initialApiHealthy: initialDaemonStatus.apiHealthy,
      statusSamples: statusConvergence.samples,
      runningBeforeStop: true,
      apiHealthyBeforeStop: true,
      stopped: stopped.stopped,
      portReleased: true
    }
  })
})
