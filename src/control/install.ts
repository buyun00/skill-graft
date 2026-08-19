import fs from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createNodePath } from '../adapters/node-path.js'
import { createInstallHost, type InstallHost } from '../adapters/install-host.js'
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
  type DaemonStatus,
  type DoctorFacts,
  type DoctorIssue,
  type DoctorReport,
  type SetupFlags,
  type SetupResult,
  type SetupStep,
  type UninstallResult
} from '../core/install.js'
import { pingApi, readHeartbeat, readPid, reviewFiles, stopDaemon } from './daemon.js'

const pathApi = createNodePath()

export function installPathsFor(packageRoot: string, host: InstallHost = createInstallHost()) {
  const installDir = resolveInstallDir({
    platform: host.platform,
    home: host.home || homedir(),
    localAppData: host.localAppData,
    override: host.env('SG_INSTALL_DIR')
  })
  const extra = host.skipPath ? null : host.extraShimDir()
  return resolveInstallPaths(pathApi, {
    hubRoot: packageRoot,
    nodePath: process.execPath,
    installDir,
    extraShimDir: extra,
    port: Number(host.env('HUB_API_PORT') || API_PORT)
  })
}

export function collectDoctorFacts(packageRoot: string, host: InstallHost = createInstallHost()): DoctorFacts {
  const paths = installPathsFor(packageRoot, host)
  const layout = layoutSpec(packageRoot, pathApi)
  const missingLayout = [
    ...layout.dirs.filter((dir) => !fs.existsSync(dir)),
    ...layout.files.filter((file) => !fs.existsSync(file.path)).map((file) => file.path)
  ]
  const gitPath = host.which('git')
  const nodePath = process.execPath || host.which('node')
  const files = reviewFiles(packageRoot)
  const daemonPid = readPid(files.pidFile)
  return {
    hubRoot: packageRoot,
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
    daemonPid,
    daemonAlive: daemonPid > 0 && host.pidAlive(daemonPid),
    apiHealthy: false,
    apiPort: paths.port
  }
}

export async function doctorHub(packageRoot: string, host: InstallHost = createInstallHost()): Promise<DoctorReport> {
  const paths = installPathsFor(packageRoot, host)
  const facts = collectDoctorFacts(packageRoot, host)
  facts.apiHealthy = await pingApi(paths.port)
  return evaluateDoctor(paths, facts)
}

export async function daemonStatus(packageRoot: string, host: InstallHost = createInstallHost()): Promise<DaemonStatus> {
  const paths = installPathsFor(packageRoot, host)
  const files = reviewFiles(packageRoot)
  const pid = readPid(files.pidFile)
  const apiPid = readPid(files.apiPidFile)
  const running = pid > 0 && host.pidAlive(pid)
  const heartbeat = readHeartbeat(packageRoot)
  const apiHealthy = heartbeatFresh(heartbeat) ? Boolean(heartbeat?.apiHealthy) : await pingApi(paths.port)
  return {
    ok: running && apiHealthy,
    action: 'daemon-status',
    taskName: paths.taskName,
    taskRegistered: host.taskExists(paths.taskName),
    running,
    pid: running ? pid : 0,
    apiPid: apiPid && host.pidAlive(apiPid) ? apiPid : 0,
    apiHealthy,
    apiUrl: paths.apiUrl,
    heartbeat
  }
}

function heartbeatFresh(heartbeat: Record<string, unknown> | null, maxAgeMs = 20000) {
  if (!heartbeat?.lastBeat) return false
  const at = Date.parse(String(heartbeat.lastBeat))
  return Number.isFinite(at) && Date.now() - at < maxAgeMs
}

export async function setupHub(
  packageRoot: string,
  flags: SetupFlags,
  host: InstallHost = createInstallHost()
): Promise<SetupResult> {
  const paths = installPathsFor(packageRoot, host)
  const steps: SetupStep[] = []
  const issues: DoctorIssue[] = []
  const add = (step: SetupStep) => {
    steps.push(step)
    if (!step.ok && !step.skipped) issues.push({ level: 'error', message: `${step.id}: ${step.detail}` })
  }

  if (!flags.dryRun) {
    add(ensureDependencies(packageRoot, flags.rebuild, host))
    add(ensureLayout(packageRoot))
    add(writeShims(paths))
    add(applyPath(paths, flags.noPath, host))
    add(applyUserEnv(paths, flags.noPath, host))
    add(applyTask(paths, flags.noTask, host))
    if (!flags.noPath && !host.skipPath) host.broadcastEnv()
    add(await applyDaemon(paths, flags.noDaemon, host))
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

  const doctor = await doctorHub(packageRoot, host)
  const setupErrors = issues.filter((issue) => issue.level === 'error')
  return {
    ok: setupErrors.length === 0 && doctor.node.ok && doctor.git.ok && (flags.dryRun || doctor.dist.ok),
    action: 'setup',
    dryRun: flags.dryRun,
    product: PRODUCT_NAME,
    command: PRODUCT_COMMAND,
    hubRoot: packageRoot,
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
  const paths = installPathsFor(packageRoot, host)
  const issues: DoctorIssue[] = []
  let stopped = false
  try {
    stopped = stopDaemon(packageRoot, host)
  } catch (error) {
    issues.push({ level: 'warn', message: error instanceof Error ? error.message : String(error) })
  }
  try {
    host.unregisterTask(paths.taskName)
  } catch (error) {
    issues.push({ level: 'warn', message: error instanceof Error ? error.message : String(error) })
  }
  let pathRemoved = true
  try {
    if (!host.skipPath && host.platform === 'win32') {
      const current = host.userPath()
      const next = removeFromUserPath(current, paths.binDir, host.pathSep, host.caseInsensitive)
      if (next.changed) host.setUserPath(next.path)
      const existing = host.env('HUB_ROOT')
      if (!existing || samePath(existing, paths.hubRoot)) host.setUserEnv('HUB_ROOT', null)
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
  } catch {
    extraShimsRemoved = false
  }
  let filesRemoved = true
  try {
    if (fs.existsSync(paths.installDir)) fs.rmSync(paths.installDir, { recursive: true, force: true })
  } catch (error) {
    filesRemoved = false
    issues.push({ level: 'error', message: error instanceof Error ? error.message : String(error) })
  }
  return {
    ok: issues.filter((issue) => issue.level === 'error').length === 0,
    action: 'uninstall',
    stopped,
    taskRemoved: host.skipTask || !host.taskExists(paths.taskName),
    pathRemoved,
    filesRemoved,
    extraShimsRemoved,
    installDir: paths.installDir,
    issues
  }
}

export async function startDaemonDetached(
  packageRoot: string,
  host: InstallHost = createInstallHost()
): Promise<{ ok: boolean; pid: number; apiHealthy: boolean; detail: string }> {
  const paths = installPathsFor(packageRoot, host)
  const files = reviewFiles(packageRoot)
  const existing = readPid(files.pidFile)
  if (existing && host.pidAlive(existing) && (await pingApi(paths.port))) {
    return { ok: true, pid: existing, apiHealthy: true, detail: `already running pid ${existing}` }
  }
  if (existing && host.pidAlive(existing) && !(await pingApi(paths.port))) {
    host.killPid(existing)
  }
  if (!fs.existsSync(paths.runDaemonCmd) || !fs.existsSync(paths.silentVbs)) {
    writeShims(paths)
  }
  const commandLine =
    host.platform === 'win32'
      ? `cmd.exe /c "${paths.runDaemonCmd}"`
      : `${process.execPath} "${paths.cliPath}" daemon run`
  const launched = host.wmiCreate(commandLine, paths.hubRoot)
  const deadline = Date.now() + 12000
  let livePid = readPid(files.pidFile)
  let apiHealthy = await pingApi(paths.port)
  while (Date.now() < deadline && !(livePid && host.pidAlive(livePid) && apiHealthy)) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    livePid = readPid(files.pidFile)
    apiHealthy = await pingApi(paths.port)
  }
  if (!livePid) livePid = launched
  return {
    ok: Boolean(livePid) && host.pidAlive(livePid) && apiHealthy,
    pid: livePid && host.pidAlive(livePid) ? livePid : launched,
    apiHealthy,
    detail: apiHealthy
      ? `pid ${livePid} ${paths.apiUrl}`
      : `started pid ${livePid || launched || 0} but API is not up yet`
  }
}

function ensureDependencies(packageRoot: string, rebuild: boolean, host: InstallHost): SetupStep {
  try {
    const modules = join(packageRoot, 'node_modules')
    if (!fs.existsSync(modules)) {
      const ran = host.runNpm(['install'], packageRoot)
      if (ran.status !== 0) return { id: 'deps', ok: false, detail: ran.stderr || ran.stdout || 'npm install failed' }
    }
    const cli = join(packageRoot, 'dist', 'control', 'cli.js')
    if (rebuild || !fs.existsSync(cli)) {
      const ran = host.runNpm(['run', 'build'], packageRoot)
      if (ran.status !== 0) return { id: 'deps', ok: false, detail: ran.stderr || ran.stdout || 'npm run build failed' }
    }
    return {
      id: 'deps',
      ok: true,
      detail: `node ${process.version}`
    }
  } catch (error) {
    return { id: 'deps', ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

function ensureLayout(packageRoot: string): SetupStep {
  const spec = layoutSpec(packageRoot, pathApi)
  for (const dir of spec.dirs) fs.mkdirSync(dir, { recursive: true })
  for (const file of spec.files) {
    if (!fs.existsSync(file.path)) {
      fs.mkdirSync(pathApi.dirname(file.path), { recursive: true })
      fs.writeFileSync(file.path, file.content, 'utf8')
    }
  }
  return { id: 'layout', ok: true, detail: 'hub directories ready' }
}

function writeShims(paths: ReturnType<typeof installPathsFor>): SetupStep {
  const rendered = renderShims(paths)
  fs.mkdirSync(paths.binDir, { recursive: true })
  fs.mkdirSync(paths.installDir, { recursive: true })
  fs.writeFileSync(paths.shimCmd, rendered.sgCmd, 'utf8')
  fs.writeFileSync(paths.shimAliasCmd, rendered.aliasCmd, 'utf8')
  fs.writeFileSync(paths.shimUnix, rendered.unix, 'utf8')
  fs.writeFileSync(paths.silentVbs, rendered.vbs, 'utf8')
  fs.writeFileSync(paths.runDaemonCmd, rendered.runDaemonCmd, 'utf8')
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
  host: InstallHost
): SetupStep {
  if (noPath || host.skipPath || host.platform !== 'win32') {
    return { id: 'env', ok: true, skipped: true, detail: stepsEnvDetail(host) }
  }
  host.setUserEnv('HUB_ROOT', paths.hubRoot)
  host.setUserEnv('HUB_API_PORT', String(paths.port))
  return { id: 'env', ok: true, detail: `HUB_ROOT=${paths.hubRoot}` }
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
  host: InstallHost
): Promise<SetupStep> {
  if (noDaemon) return { id: 'daemon', ok: true, skipped: true, detail: 'skipped' }
  const started = await startDaemonDetached(paths.hubRoot, host)
  return { id: 'daemon', ok: started.ok || started.pid > 0, detail: started.detail }
}

function removeIfExists(target: string | null) {
  if (!target) return
  if (fs.existsSync(target)) fs.unlinkSync(target)
}

function samePath(left: string, right: string) {
  return left.replace(/[\\/]+$/, '').toLowerCase() === right.replace(/[\\/]+$/, '').toLowerCase()
}

function codexJs() {
  const target = join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
  return fs.existsSync(target) ? target : ''
}
