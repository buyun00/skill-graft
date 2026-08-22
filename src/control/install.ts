import fs from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createNodePath } from '../adapters/node-path.js'
import { createInstallHost, type InstallHost } from '../adapters/install-host.js'
import { resolveLocalInvocationTraceGate } from '../adapters/local-invocation-trace.js'
import {
  coherentDataRootEnvironment,
  LEGACY_DATA_ROOT_ENV,
  localDataRootsEqual,
  PRIMARY_DATA_ROOT_ENV,
  resolveLocalDataRoot
} from '../local/data-root.js'
import {
  API_PORT,
  evaluateDoctor,
  layoutSpec,
  mergeUserPath,
  pathHasDir,
  PRODUCT_ALIAS,
  PRODUCT_COMMAND,
  PRODUCT_NAME,
  removeFromUserPath,
  renderShims,
  resolveInstallDir,
  resolveInstallPaths,
  TASK_NAME,
  type DaemonTraceEnvironment,
  type DaemonStatus,
  type InstallPaths,
  type DoctorFacts,
  type DoctorIssue,
  type DoctorReport,
  type SetupFlags,
  type SetupResult,
  type SetupStep,
  type UninstallResult
} from '../local/lifecycle/install-domain.js'
import {
  apiProcessMatches,
  daemonProcessMatches,
  heartbeatBindsInstance,
  pingApi,
  readHeartbeat,
  readPid,
  reviewFiles,
  stopDaemon
} from './daemon.js'

const pathApi = createNodePath()
const REQUIRED_RESIDENT_SKILLS = ['ozdqp-development', 'ozdqp-ui-development', 'ozdqp-git-workflow'] as const

type StartDaemonDependencies = {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  ping?: typeof pingApi
}

type FrozenInstallEnvironment = Readonly<NodeJS.ProcessEnv>

type FrozenDaemonTracePreflight = Readonly<{
  baseEnvironment: FrozenInstallEnvironment
  daemonTrace?: DaemonTraceEnvironment
}>

function requiredDataAssets(dataRoot: string): string[] {
  return [
    join(dataRoot, 'AGENTS.override.md'),
    join(dataRoot, 'overlay', 'checkout-rules.txt'),
    join(dataRoot, 'overlay', 'attach-library.ps1'),
    join(dataRoot, 'overlay', 'manage-skill-visibility.ps1'),
    join(dataRoot, 'overlay', 'analyze-remote-skill-update.ps1'),
    ...['attach', 'detach', 'edit', 'chat', 'analyze'].map((name) => join(dataRoot, 'overlay', 'prompts', `${name}.txt`)),
    ...REQUIRED_RESIDENT_SKILLS.map((name) => join(dataRoot, 'skills', name, 'SKILL.md'))
  ]
}

function freezeInstallEnvironment(host: InstallHost): FrozenInstallEnvironment {
  return Object.freeze({ ...host.environment() })
}

function resolveDataRootFromEnvironment(
  packageRoot: string,
  platform: NodeJS.Platform | string,
  environment: FrozenInstallEnvironment,
  dataRoot?: string
): string {
  return resolveLocalDataRoot({
    packageRoot,
    dataRoot,
    environment: {
      SKILL_GRAFT_HOME: environment[PRIMARY_DATA_ROOT_ENV],
      HUB_ROOT: environment[LEGACY_DATA_ROOT_ENV]
    },
    platform
  })
}

export function resolveDataRoot(packageRoot: string, host: InstallHost = createInstallHost(), dataRoot?: string): string {
  return resolveDataRootFromEnvironment(packageRoot, host.platform, freezeInstallEnvironment(host), dataRoot)
}

export function installPathsFor(
  packageRoot: string,
  host: InstallHost = createInstallHost(),
  dataRoot?: string,
  environment: FrozenInstallEnvironment = freezeInstallEnvironment(host)
) {
  const installDir = resolveInstallDir({
    platform: host.platform,
    home: host.home || homedir(),
    localAppData: host.localAppData,
    override: environment.SG_INSTALL_DIR
  })
  const extra = host.skipPath ? null : host.extraShimDir()
  return resolveInstallPaths(pathApi, {
    hubRoot: packageRoot,
    packageRoot,
    dataRoot: resolveDataRootFromEnvironment(packageRoot, host.platform, environment, dataRoot),
    nodePath: process.execPath,
    installDir,
    extraShimDir: extra,
    port: Number(environment.HUB_API_PORT || API_PORT)
  })
}

export function collectDoctorFacts(
  packageRoot: string,
  host: InstallHost = createInstallHost(),
  dataRoot?: string,
  environment: FrozenInstallEnvironment = freezeInstallEnvironment(host)
): DoctorFacts {
  const paths = installPathsFor(packageRoot, host, dataRoot, environment)
  const layout = layoutSpec(paths.dataRoot, pathApi)
  const missingLayout = [
    ...layout.dirs.filter((dir) => !fs.existsSync(dir)),
    ...layout.files.filter((file) => !fs.existsSync(file.path)).map((file) => file.path),
    ...requiredDataAssets(paths.dataRoot).filter((file) => !fs.existsSync(file))
  ]
  const gitPath = host.which('git')
  const nodePath = process.execPath || host.which('node')
  const files = reviewFiles(paths.dataRoot)
  const daemonPid = readPid(files.pidFile)
  const apiPid = readPid(files.apiPidFile)
  const heartbeat = readHeartbeat(paths.dataRoot)
  const daemonAlive = daemonPid > 0
    && host.pidAlive(daemonPid)
    && daemonProcessMatches(host, daemonPid, paths.packageRoot)
    && heartbeatMatchesInstance(heartbeat, {
      pid: daemonPid,
      apiPid,
      packageRoot: paths.packageRoot,
      dataRoot: paths.dataRoot,
      port: paths.port
    })
  return {
    hubRoot: paths.dataRoot,
    nodePath,
    nodeVersion: process.version,
    gitPath,
    gitVersion: gitPath ? host.commandVersion(gitPath) : '',
    codexPath: codexJs(),
    distExists: fs.existsSync(paths.cliPath),
    cliPath: paths.cliPath,
    missingLayout,
    shimCmdExists: fs.existsSync(paths.shimCmd),
    shimAliasExists: fs.existsSync(paths.shimAliasCmd),
    shimUnixExists: fs.existsSync(paths.shimUnix),
    extraShimExists: Boolean(paths.extraShimCmd && fs.existsSync(paths.extraShimCmd)),
    userPath: host.userPath(),
    pathSep: host.pathSep,
    caseInsensitive: host.caseInsensitive,
    taskRegistered: host.taskExists(paths.taskName),
    daemonPid: daemonAlive ? daemonPid : 0,
    daemonAlive,
    apiHealthy: false,
    apiPort: paths.port
  }
}

export async function doctorHub(
  packageRoot: string,
  host: InstallHost = createInstallHost(),
  dataRoot?: string,
  environment: FrozenInstallEnvironment = freezeInstallEnvironment(host)
): Promise<DoctorReport> {
  const paths = installPathsFor(packageRoot, host, dataRoot, environment)
  const facts = collectDoctorFacts(packageRoot, host, paths.dataRoot, environment)
  const apiPid = readPid(reviewFiles(paths.dataRoot).apiPidFile)
  const apiOwned = apiPid > 0 && host.pidAlive(apiPid) && apiProcessMatches(host, apiPid, paths.packageRoot)
  facts.apiHealthy = facts.daemonAlive && apiOwned && await pingApi(paths.port, 1500, {
    packageRoot: paths.packageRoot,
    dataRoot: paths.dataRoot
  })
  return evaluateDoctor(paths, facts)
}

export async function daemonStatus(
  packageRoot: string,
  host: InstallHost = createInstallHost(),
  dataRoot?: string,
  environment: FrozenInstallEnvironment = freezeInstallEnvironment(host)
): Promise<DaemonStatus> {
  const paths = installPathsFor(packageRoot, host, dataRoot, environment)
  const files = reviewFiles(paths.dataRoot)
  const pid = readPid(files.pidFile)
  const apiPid = readPid(files.apiPidFile)
  const daemonOwned = pid > 0 && host.pidAlive(pid) && daemonProcessMatches(host, pid, paths.packageRoot)
  const apiOwned = apiPid > 0 && host.pidAlive(apiPid) && apiProcessMatches(host, apiPid, paths.packageRoot)
  const heartbeat = readHeartbeat(paths.dataRoot)
  const heartbeatValid = heartbeatMatchesInstance(heartbeat, {
    pid,
    apiPid,
    packageRoot: paths.packageRoot,
    dataRoot: paths.dataRoot,
    port: paths.port
  })
  const running = daemonOwned && heartbeatValid
  const apiHealthy = running && apiOwned && heartbeatValid && Boolean(heartbeat?.apiHealthy)
  return {
    ok: running && apiHealthy,
    action: 'daemon-status',
    taskName: paths.taskName,
    taskRegistered: host.taskExists(paths.taskName),
    running,
    pid: running ? pid : 0,
    apiPid: apiOwned && heartbeatValid ? apiPid : 0,
    apiHealthy,
    apiUrl: paths.apiUrl,
    heartbeat
  }
}

export function heartbeatMatchesInstance(
  heartbeat: Record<string, unknown> | null,
  expected: { pid: number; apiPid: number; packageRoot: string; dataRoot: string; port: number },
  maxAgeMs = 20000,
  now = Date.now()
) {
  return heartbeatBindsInstance(heartbeat, expected, maxAgeMs, now)
}

export async function setupHub(
  packageRoot: string,
  flags: SetupFlags,
  host: InstallHost = createInstallHost(),
  dataRoot?: string
): Promise<SetupResult> {
  const environment = freezeInstallEnvironment(host)
  const paths = installPathsFor(packageRoot, host, dataRoot, environment)
  const steps: SetupStep[] = []
  const issues: DoctorIssue[] = []
  const add = (step: SetupStep) => {
    steps.push(step)
    if (!step.ok && !step.skipped) issues.push({ level: 'error', message: `${step.id}: ${step.detail}` })
  }

  let tracePreflight: FrozenDaemonTracePreflight = Object.freeze({ baseEnvironment: environment })
  let tracePreflightFailed = false
  try {
    tracePreflight = preflightDaemonTraceEnvironment(environment, host.platform, paths.dataRoot)
  } catch (error) {
    tracePreflightFailed = true
    add({
      id: 'trace',
      ok: false,
      detail: `invocation trace gate is invalid: ${error instanceof Error ? error.message : String(error)}`
    })
  }

  if (!flags.dryRun) {
    let failedStep = tracePreflightFailed ? 'trace' : ''
    const run = async (id: string, operation: () => SetupStep | Promise<SetupStep>) => {
      if (failedStep) {
        add({ id, ok: true, skipped: true, detail: `skipped after ${failedStep} failed` })
        return
      }
      let step: SetupStep
      try {
        step = await operation()
      } catch (error) {
        step = { id, ok: false, detail: error instanceof Error ? error.message : String(error) }
      }
      add(step)
      if (!step.ok && !step.skipped) failedStep = id
    }

    const taskExistedBefore = tracePreflightFailed || host.skipTask || host.taskExists(paths.taskName)
    await run('deps', () => ensureDependencies(packageRoot, flags.rebuild, host))
    await run('layout', () => ensureLayout(paths.dataRoot))
    await run('shims', () => writeShims(paths, tracePreflight))
    await run('path', () => applyPath(paths, flags.noPath, host))
    await run('env', () => {
      const step = applyUserEnv(paths, flags.noPath, host, environment)
      if (!step.skipped && !flags.noPath && !host.skipPath) host.broadcastEnv()
      return step
    })
    await run('task', () => applyTask(paths, flags.noTask, host))
    await run('daemon', () => applyDaemon(paths, flags.noDaemon, host, tracePreflight))

    if ((failedStep === 'task' || failedStep === 'daemon') && !taskExistedBefore && !flags.noTask && !host.skipTask) {
      try {
        host.unregisterTask(paths.taskName)
        if (host.taskExists(paths.taskName)) throw new Error(`failed to roll back ${paths.taskName}`)
      } catch (error) {
        issues.push({
          level: 'error',
          message: `task rollback: ${error instanceof Error ? error.message : String(error)}`
        })
      }
    }
  } else {
    add({ id: 'deps', ok: true, skipped: true, detail: 'dry-run' })
    add({ id: 'layout', ok: true, skipped: true, detail: 'dry-run' })
    add({ id: 'shims', ok: true, skipped: true, detail: paths.binDir })
    const merged = mergeUserPath(host.userPath(), paths.binDir, host.pathSep, host.caseInsensitive)
    add({
      id: 'path',
      ok: true,
      skipped: flags.noPath,
      detail: flags.noPath ? 'skipped' : merged.already ? 'already on user PATH' : `would prepend ${paths.binDir}`
    })
    add({
      id: 'task',
      ok: true,
      skipped: flags.noTask,
      detail: flags.noTask ? 'skipped' : `would register ${paths.taskName} at logon`
    })
    add({
      id: 'daemon',
      ok: true,
      skipped: flags.noDaemon,
      detail: flags.noDaemon ? 'skipped' : `would start keep-alive for ${paths.apiUrl}`
    })
  }

  const doctor = await doctorHub(packageRoot, host, paths.dataRoot, environment)
  const setupErrors = issues.filter((issue) => issue.level === 'error')
  return {
    ok: setupErrors.length === 0 && doctor.ok && (flags.dryRun || doctor.dist.ok),
    action: 'setup',
    dryRun: flags.dryRun,
    product: PRODUCT_NAME,
    command: PRODUCT_COMMAND,
    hubRoot: paths.dataRoot,
    installDir: paths.installDir,
    binDir: paths.binDir,
    apiUrl: paths.apiUrl,
    taskName: paths.taskName,
    steps,
    doctor,
    issues: [...setupErrors, ...doctor.issues.filter((issue) => !setupErrors.some((item) => item.message === issue.message))]
  }
}

export async function uninstallHub(
  packageRoot: string,
  host: InstallHost = createInstallHost()
): Promise<UninstallResult> {
  const environment = freezeInstallEnvironment(host)
  const paths = installPathsFor(packageRoot, host, undefined, environment)
  const issues: DoctorIssue[] = []
  let stopped = false
  try {
    stopped = stopDaemon(paths.dataRoot, host, paths.packageRoot, paths.port)
  } catch (error) {
    issues.push({ level: 'error', message: error instanceof Error ? error.message : String(error) })
  }
  if (!stopped) {
    issues.push({
      level: 'error',
      message: 'daemon stop failed or was refused: the instance could not be verified stopped; uninstall aborted and all install state was preserved'
    })
    return {
      ok: false,
      action: 'uninstall',
      stopped: false,
      taskRemoved: false,
      pathRemoved: false,
      filesRemoved: false,
      extraShimsRemoved: false,
      installDir: paths.installDir,
      issues
    }
  }
  let taskRemoved = host.skipTask
  try {
    host.unregisterTask(paths.taskName)
    taskRemoved = host.skipTask || !host.taskExists(paths.taskName)
    if (!taskRemoved) throw new Error(`failed to remove scheduled task ${paths.taskName}`)
  } catch (error) {
    taskRemoved = false
    issues.push({ level: 'error', message: error instanceof Error ? error.message : String(error) })
  }
  let pathRemoved = true
  try {
    if (!host.skipPath && host.platform === 'win32') {
      const current = host.userPath()
      const next = removeFromUserPath(current, paths.binDir, host.pathSep, host.caseInsensitive)
      if (next.changed) host.setUserPath(next.path)
      for (const name of [PRIMARY_DATA_ROOT_ENV, LEGACY_DATA_ROOT_ENV] as const) {
        const existing = environment[name]
        if (existing && localDataRootsEqual(existing, paths.dataRoot, host.platform)) {
          host.setUserEnv(name, null)
        }
      }
      host.broadcastEnv()
    }
  } catch (error) {
    pathRemoved = false
    issues.push({ level: 'error', message: error instanceof Error ? error.message : String(error) })
  }
  let extraShimsRemoved = true
  try {
    removeIfExists(paths.extraShimCmd)
    removeIfExists(paths.extraShimAliasCmd)
    extraShimsRemoved = !paths.extraShimCmd || !fs.existsSync(paths.extraShimCmd)
    extraShimsRemoved = extraShimsRemoved && (!paths.extraShimAliasCmd || !fs.existsSync(paths.extraShimAliasCmd))
    if (!extraShimsRemoved) throw new Error('one or more global shims remain')
  } catch (error) {
    extraShimsRemoved = false
    issues.push({ level: 'error', message: error instanceof Error ? error.message : String(error) })
  }
  let filesRemoved = true
  try {
    if (fs.existsSync(paths.installDir)) fs.rmSync(paths.installDir, { recursive: true, force: true })
    filesRemoved = !fs.existsSync(paths.installDir)
    if (!filesRemoved) throw new Error(`failed to remove install directory ${paths.installDir}`)
  } catch (error) {
    filesRemoved = false
    issues.push({ level: 'error', message: error instanceof Error ? error.message : String(error) })
  }
  return {
    ok: stopped
      && taskRemoved
      && pathRemoved
      && filesRemoved
      && extraShimsRemoved
      && issues.every((issue) => issue.level !== 'error'),
    action: 'uninstall',
    stopped,
    taskRemoved,
    pathRemoved,
    filesRemoved,
    extraShimsRemoved,
    installDir: paths.installDir,
    issues
  }
}

export async function startDaemonDetached(
  packageRoot: string,
  host: InstallHost = createInstallHost(),
  dataRoot?: string,
  dependencies: StartDaemonDependencies = {}
): Promise<{ ok: boolean; pid: number; apiHealthy: boolean; detail: string }> {
  const environment = freezeInstallEnvironment(host)
  const paths = installPathsFor(packageRoot, host, dataRoot, environment)
  let tracePreflight: FrozenDaemonTracePreflight
  try {
    tracePreflight = preflightDaemonTraceEnvironment(environment, host.platform, paths.dataRoot)
  } catch (error) {
    return {
      ok: false,
      pid: 0,
      apiHealthy: false,
      detail: `invocation trace gate is invalid: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  return startDaemonDetachedAfterPreflight(paths, host, tracePreflight, dependencies)
}

async function startDaemonDetachedAfterPreflight(
  paths: ReturnType<typeof installPathsFor>,
  host: InstallHost,
  tracePreflight: FrozenDaemonTracePreflight,
  dependencies: StartDaemonDependencies = {}
): Promise<{ ok: boolean; pid: number; apiHealthy: boolean; detail: string }> {
  const now = dependencies.now || Date.now
  const pause = dependencies.sleep || ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const ping = dependencies.ping || pingApi
  const daemonTrace = tracePreflight.daemonTrace
  const files = reviewFiles(paths.dataRoot)
  const existing = readPid(files.pidFile)
  const existingApi = readPid(files.apiPidFile)
  const expectedApi = { packageRoot: paths.packageRoot, dataRoot: paths.dataRoot }
  const existingAlive = Boolean(existing && host.pidAlive(existing))
  const existingApiAlive = Boolean(existingApi && host.pidAlive(existingApi))
  const anyExistingLive = existingAlive || existingApiAlive
  const existingHeartbeat = readHeartbeat(paths.dataRoot)
  const existingBound = heartbeatMatchesInstance(existingHeartbeat, {
    pid: existing,
    apiPid: existingApi,
    packageRoot: paths.packageRoot,
    dataRoot: paths.dataRoot,
    port: paths.port
  })
  const existingOwned = !existingAlive || daemonProcessMatches(host, existing, paths.packageRoot)
  const existingApiOwned = !existingApiAlive || apiProcessMatches(host, existingApi, paths.packageRoot)
  if (anyExistingLive && (!existingBound || !existingOwned || !existingApiOwned)) {
    return {
      ok: false,
      pid: 0,
      apiHealthy: false,
      detail: 'refusing to replace live daemon state whose instance binding is unverified; markers preserved'
    }
  }
  const existingApiHealthy = existingAlive
    && existingApiAlive
    && await ping(paths.port, 1500, expectedApi)
  if (existingBound && existingOwned && existingApiOwned && existingApiHealthy) {
    return { ok: true, pid: existing, apiHealthy: true, detail: `already running pid ${existing}` }
  }
  if (!stopDaemon(paths.dataRoot, host, paths.packageRoot, paths.port)) {
    return {
      ok: false,
      pid: 0,
      apiHealthy: false,
      detail: 'refusing to start because prior daemon state could not be safely stopped; markers preserved'
    }
  }
  writeDaemonLaunchers(paths, renderShims(paths, daemonTrace))
  const launched = host.platform === 'win32'
    ? host.wmiCreate(`cmd.exe /c "${paths.runDaemonCmd}"`, paths.packageRoot)
    : (() => {
        const launch = createPosixDaemonLaunchSpec(
          paths,
          tracePreflight.baseEnvironment,
          daemonTrace,
          host.platform
        )
        return host.launchDetached(launch.command, launch.args, launch.opts)
      })()
  const deadline = now() + 12000
  let livePid = readPid(files.pidFile)
  let liveApiPid = readPid(files.apiPidFile)
  let daemonOwned = Boolean(livePid && host.pidAlive(livePid) && daemonProcessMatches(host, livePid, paths.packageRoot))
  let apiOwned = Boolean(liveApiPid && host.pidAlive(liveApiPid) && apiProcessMatches(host, liveApiPid, paths.packageRoot))
  let instanceBound = heartbeatMatchesInstance(readHeartbeat(paths.dataRoot), {
    pid: livePid,
    apiPid: liveApiPid,
    packageRoot: paths.packageRoot,
    dataRoot: paths.dataRoot,
    port: paths.port
  })
  let apiHealthy = apiOwned && instanceBound && await ping(paths.port, 1500, expectedApi)
  while (now() < deadline && !(daemonOwned && apiOwned && instanceBound && apiHealthy)) {
    await pause(250)
    livePid = readPid(files.pidFile)
    liveApiPid = readPid(files.apiPidFile)
    daemonOwned = Boolean(livePid && host.pidAlive(livePid) && daemonProcessMatches(host, livePid, paths.packageRoot))
    apiOwned = Boolean(liveApiPid && host.pidAlive(liveApiPid) && apiProcessMatches(host, liveApiPid, paths.packageRoot))
    instanceBound = heartbeatMatchesInstance(readHeartbeat(paths.dataRoot), {
      pid: livePid,
      apiPid: liveApiPid,
      packageRoot: paths.packageRoot,
      dataRoot: paths.dataRoot,
      port: paths.port
    })
    apiHealthy = apiOwned && instanceBound && await ping(paths.port, 1500, expectedApi)
  }
  const ok = daemonOwned && apiOwned && instanceBound && apiHealthy
  let cleanupDetail = ''
  if (!ok) {
    const cleaned = stopDaemon(paths.dataRoot, host, paths.packageRoot, paths.port)
    cleanupDetail = cleaned
      ? '; partial launch was safely stopped'
      : '; partial launch cleanup was refused and verified markers were preserved'
  }
  return {
    ok,
    pid: ok && daemonOwned ? livePid : 0,
    apiHealthy: ok && apiHealthy,
    detail: ok
      ? `pid ${livePid} ${paths.apiUrl}`
      : `launched pid ${launched || 0}; verified daemon ${daemonOwned ? livePid : 0} but API is not up yet${cleanupDetail}`
  }
}

export type PosixDaemonLaunchSpec = {
  command: string
  args: readonly [string, 'daemon', 'run']
  opts: {
    cwd: string
    env: NodeJS.ProcessEnv
  }
}

/** Pure launch description used by the POSIX lifecycle and cross-platform execution tests. */
export function createPosixDaemonLaunchSpec(
  paths: Pick<InstallPaths, 'nodePath' | 'cliPath' | 'packageRoot' | 'dataRoot' | 'port'>,
  baseEnvironment: NodeJS.ProcessEnv,
  daemonTrace?: DaemonTraceEnvironment,
  platform: NodeJS.Platform | string = 'linux'
): PosixDaemonLaunchSpec {
  if (platform === 'win32') {
    throw new Error('POSIX daemon launch spec cannot target win32')
  }
  if (daemonTrace && !localDataRootsEqual(daemonTrace.pinned.SKILL_GRAFT_HOME, paths.dataRoot, platform)) {
    throw new Error(`POSIX daemon trace root must identify selected data root ${paths.dataRoot}`)
  }
  const reviewedBaseEnvironment = daemonTrace
    ? Object.fromEntries(Object.entries(baseEnvironment).filter(([name]) => !/^(?:GIT_|DSH_)/i.test(name)))
    : { ...baseEnvironment }
  return {
    command: paths.nodePath,
    args: [paths.cliPath, 'daemon', 'run'],
    opts: {
      cwd: paths.packageRoot,
      env: {
        ...reviewedBaseEnvironment,
        ...(daemonTrace ? daemonTrace.pinned : {}),
        ...coherentDataRootEnvironment(paths.dataRoot, platform),
        HUB_API_PORT: String(paths.port),
        ...(daemonTrace ? {
          SKILL_GRAFT_INVOCATION_TRACE: '1',
          SKILL_GRAFT_REAL_E2E: '1',
          SKILL_GRAFT_RUN_ID: daemonTrace.runId,
          SKILL_GRAFT_E2E_ROOT: daemonTrace.runRoot
        } : {})
      }
    }
  }
}

function ensureDependencies(packageRoot: string, rebuild: boolean, host: InstallHost): SetupStep {
  try {
    const cli = join(packageRoot, 'dist', 'control', 'cli.js')
    if (!rebuild && fs.existsSync(cli)) {
      return { id: 'deps', ok: true, detail: `node ${process.version} (prebuilt)` }
    }
    const buildInputs = [
      join(packageRoot, 'scripts', 'clean-dist.mjs'),
      join(packageRoot, 'src'),
      join(packageRoot, 'tsconfig.json')
    ]
    if (buildInputs.some((target) => !fs.existsSync(target))) {
      return {
        id: 'deps',
        ok: false,
        detail: rebuild
          ? 'this prebuilt distribution cannot be rebuilt in place'
          : `prebuilt CLI is missing (${cli})`
      }
    }
    const modules = join(packageRoot, 'node_modules')
    if (!fs.existsSync(modules)) {
      const ran = host.runNpm(['install'], packageRoot)
      if (ran.status !== 0) return { id: 'deps', ok: false, detail: ran.stderr || ran.stdout || 'npm install failed' }
    }
    const ran = host.runNpm(['run', 'build'], packageRoot)
    if (ran.status !== 0) return { id: 'deps', ok: false, detail: ran.stderr || ran.stdout || 'npm run build failed' }
    return {
      id: 'deps',
      ok: true,
      detail: `node ${process.version}`
    }
  } catch (error) {
    return { id: 'deps', ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

function ensureLayout(dataRoot: string): SetupStep {
  try {
    const spec = layoutSpec(dataRoot, pathApi)
    for (const dir of spec.dirs) fs.mkdirSync(dir, { recursive: true })
    for (const file of spec.files) {
      if (!fs.existsSync(file.path)) {
        fs.mkdirSync(pathApi.dirname(file.path), { recursive: true })
        fs.writeFileSync(file.path, file.content, 'utf8')
      }
    }
    const missing = requiredDataAssets(dataRoot).filter((file) => !fs.existsSync(file))
    return missing.length > 0
      ? { id: 'layout', ok: false, detail: `required Hub assets are missing: ${missing.join(', ')}` }
      : { id: 'layout', ok: true, detail: 'hub directories ready' }
  } catch (error) {
    return { id: 'layout', ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

function resolveDaemonTraceEnvironment(
  environment: FrozenInstallEnvironment,
  platform: NodeJS.Platform | string,
  dataRoot: string
): DaemonTraceEnvironment | undefined {
  const gate = resolveLocalInvocationTraceGate(environment)
  if (!gate) return undefined

  const requiredPinnedValue = (name: string) => {
    const value = environment[name]
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`real E2E detached launcher requires ${name}`)
    }
    if (/[\0\r\n"]/.test(value)) {
      throw new Error(`real E2E detached launcher ${name} is unsafe for a cmd environment assignment`)
    }
    return value
  }
  const pinned: DaemonTraceEnvironment['pinned'] = {
    PATH: requiredPinnedValue('PATH'),
    DSH_HOME: requiredPinnedValue('DSH_HOME'),
    HOME: requiredPinnedValue('HOME'),
    USERPROFILE: requiredPinnedValue('USERPROFILE'),
    APPDATA: requiredPinnedValue('APPDATA'),
    LOCALAPPDATA: requiredPinnedValue('LOCALAPPDATA'),
    TEMP: requiredPinnedValue('TEMP'),
    TMP: requiredPinnedValue('TMP'),
    HUB_SPAWN_CODEX: requiredPinnedValue('HUB_SPAWN_CODEX'),
    SKILL_GRAFT_HOME: requiredPinnedValue('SKILL_GRAFT_HOME'),
    GIT_CONFIG_GLOBAL: requiredPinnedValue('GIT_CONFIG_GLOBAL'),
    GIT_CONFIG_NOSYSTEM: requiredPinnedValue('GIT_CONFIG_NOSYSTEM'),
    GIT_OPTIONAL_LOCKS: requiredPinnedValue('GIT_OPTIONAL_LOCKS')
  }
  const expectedHome = join(gate.runRoot, 'home')
  for (const [name, expected] of [
    ['HOME', expectedHome],
    ['USERPROFILE', expectedHome],
    ['APPDATA', join(expectedHome, 'appdata')],
    ['LOCALAPPDATA', join(expectedHome, 'localappdata')],
    ['TEMP', join(expectedHome, 'temp')],
    ['TMP', join(expectedHome, 'temp')],
    ['DSH_HOME', join(expectedHome, 'dsh-home')],
    ['SKILL_GRAFT_HOME', join(gate.runRoot, 'hub-data')]
  ] as const) {
    if (!samePath(pinned[name], expected, platform)) {
      throw new Error(`real E2E detached launcher ${name} must identify ${expected}`)
    }
  }
  if (!localDataRootsEqual(pinned.SKILL_GRAFT_HOME, dataRoot, platform)) {
    throw new Error(`real E2E detached launcher SKILL_GRAFT_HOME must identify selected data root ${dataRoot}`)
  }
  if (pinned.HUB_SPAWN_CODEX !== '0') {
    throw new Error('real E2E detached launcher requires HUB_SPAWN_CODEX=0')
  }
  const expectedGlobalConfig = platform === 'win32' ? 'NUL' : '/dev/null'
  const globalConfigMatches = platform === 'win32'
    ? pinned.GIT_CONFIG_GLOBAL.toLowerCase() === expectedGlobalConfig.toLowerCase()
    : pinned.GIT_CONFIG_GLOBAL === expectedGlobalConfig
  if (!globalConfigMatches
    || pinned.GIT_CONFIG_NOSYSTEM !== '1'
    || pinned.GIT_OPTIONAL_LOCKS !== '0') {
    throw new Error('real E2E detached launcher requires isolated Git config and GIT_OPTIONAL_LOCKS=0')
  }
  return { runId: gate.runId, runRoot: gate.runRoot, pinned }
}

function preflightDaemonTraceEnvironment(
  environment: FrozenInstallEnvironment,
  platform: NodeJS.Platform | string,
  dataRoot: string
): FrozenDaemonTracePreflight {
  const revalidatedDataRoot = resolveDataRootFromEnvironment(dataRoot, platform, environment, dataRoot)
  if (!localDataRootsEqual(revalidatedDataRoot, dataRoot, platform)) {
    throw new Error(`preflight data root must identify selected data root ${dataRoot}`)
  }
  const daemonTrace = resolveDaemonTraceEnvironment(environment, platform, dataRoot)
  if (!daemonTrace) return Object.freeze({ baseEnvironment: environment })
  const pinned = Object.freeze({ ...daemonTrace.pinned }) as DaemonTraceEnvironment['pinned']
  return Object.freeze({
    baseEnvironment: environment,
    daemonTrace: Object.freeze({ ...daemonTrace, pinned })
  })
}

function writeShims(
  paths: ReturnType<typeof installPathsFor>,
  tracePreflight: FrozenDaemonTracePreflight
): SetupStep {
  const rendered = renderShims(paths, tracePreflight.daemonTrace)
  fs.mkdirSync(paths.binDir, { recursive: true })
  fs.mkdirSync(paths.installDir, { recursive: true })
  fs.writeFileSync(paths.shimCmd, rendered.sgCmd, 'utf8')
  fs.writeFileSync(paths.shimAliasCmd, rendered.aliasCmd, 'utf8')
  fs.writeFileSync(paths.shimUnix, rendered.unix, 'utf8')
  writeDaemonLaunchers(paths, rendered)
  const manifest = JSON.parse(rendered.manifest) as Record<string, unknown>
  manifest.installedAt = new Date().toISOString()
  fs.writeFileSync(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  if (paths.extraShimCmd) fs.writeFileSync(paths.extraShimCmd, rendered.sgCmd, 'utf8')
  if (paths.extraShimAliasCmd) fs.writeFileSync(paths.extraShimAliasCmd, rendered.aliasCmd, 'utf8')
  return {
    id: 'shims',
    ok: fs.existsSync(paths.shimCmd),
    detail: `${PRODUCT_COMMAND} and ${PRODUCT_ALIAS} -> ${paths.cliPath}`
  }
}

function writeDaemonLaunchers(
  paths: ReturnType<typeof installPathsFor>,
  rendered = renderShims(paths)
) {
  fs.mkdirSync(paths.installDir, { recursive: true })
  fs.writeFileSync(paths.silentVbs, rendered.vbs, 'utf8')
  fs.writeFileSync(paths.runDaemonCmd, rendered.runDaemonCmd, 'utf8')
}

function applyPath(
  paths: ReturnType<typeof installPathsFor>,
  noPath: boolean,
  host: InstallHost
): SetupStep {
  if (noPath || host.skipPath) return { id: 'path', ok: true, skipped: true, detail: 'skipped' }
  if (host.platform !== 'win32') {
    const onPath = pathHasDir(process.env.PATH || '', paths.binDir, host.pathSep, host.caseInsensitive)
    return {
      id: 'path',
      ok: true,
      detail: onPath ? `${paths.binDir} already on PATH` : `wrote ${paths.binDir}; add it to PATH if sg is not found`
    }
  }
  const current = host.userPath()
  const merged = mergeUserPath(current, paths.binDir, host.pathSep, host.caseInsensitive)
  if (merged.changed) host.setUserPath(merged.path)
  return {
    id: 'path',
    ok: true,
    detail: merged.already ? `${paths.binDir} already on user PATH` : `prepended ${paths.binDir} to user PATH`
  }
}

function applyUserEnv(
  paths: ReturnType<typeof installPathsFor>,
  noPath: boolean,
  host: InstallHost,
  environment: FrozenInstallEnvironment
): SetupStep {
  if (noPath || host.skipPath || host.platform !== 'win32') {
    return { id: 'env', ok: true, skipped: true, detail: stepsEnvDetail(host) }
  }
  const existingPrimary = environment[PRIMARY_DATA_ROOT_ENV]
  const existingLegacy = environment[LEGACY_DATA_ROOT_ENV]
  const existingPort = environment.HUB_API_PORT
  if (existingPrimary !== paths.dataRoot) host.setUserEnv(PRIMARY_DATA_ROOT_ENV, paths.dataRoot)
  if (existingLegacy !== paths.dataRoot) host.setUserEnv(LEGACY_DATA_ROOT_ENV, paths.dataRoot)
  if (!existingPort) host.setUserEnv('HUB_API_PORT', String(paths.port))
  return {
    id: 'env',
    ok: true,
    detail: `${PRIMARY_DATA_ROOT_ENV}=${paths.dataRoot}; ${LEGACY_DATA_ROOT_ENV}=${paths.dataRoot}`
  }
}

function stepsEnvDetail(host: InstallHost) {
  return `node ${process.version}${host.skipPath ? ' (PATH skipped)' : ''}`
}

function applyTask(
  paths: ReturnType<typeof installPathsFor>,
  noTask: boolean,
  host: InstallHost
): SetupStep {
  if (noTask || host.skipTask) return { id: 'task', ok: true, skipped: true, detail: 'skipped' }
  if (host.platform !== 'win32') {
    return { id: 'task', ok: true, skipped: true, detail: 'logon task is Windows-only' }
  }
  host.registerLogonTask(paths.taskName, paths.silentVbs)
  const registered = host.taskExists(paths.taskName)
  return {
    id: 'task',
    ok: registered,
    detail: registered ? `${TASK_NAME} runs at logon (hidden)` : `failed to register ${TASK_NAME}`
  }
}

async function applyDaemon(
  paths: ReturnType<typeof installPathsFor>,
  noDaemon: boolean,
  host: InstallHost,
  tracePreflight: FrozenDaemonTracePreflight
): Promise<SetupStep> {
  if (noDaemon) return { id: 'daemon', ok: true, skipped: true, detail: 'skipped' }
  const started = await startDaemonDetachedAfterPreflight(paths, host, tracePreflight)
  return { id: 'daemon', ok: started.ok, detail: started.detail }
}

function removeIfExists(target: string | null) {
  if (!target) return
  if (fs.existsSync(target)) fs.unlinkSync(target)
}

function samePath(left: string, right: string, platform: NodeJS.Platform | string) {
  const a = left.replace(/[\\/]+$/, '')
  const b = right.replace(/[\\/]+$/, '')
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function codexJs() {
  const target = join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
  return fs.existsSync(target) ? target : ''
}
