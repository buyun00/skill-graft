import type { PathPort } from '../../adapters/host-context.js'

export const PRODUCT_NAME = 'skill-graft'
export const PRODUCT_COMMAND = 'sg'
export const PRODUCT_ALIAS = 'ozdqp-hub'
export const TASK_NAME = 'SkillGraft'
export const API_PORT = 18765
export const INSTALL_DIR_NAME = 'skill-graft'

export type InstallPaths = {
  product: string
  command: string
  alias: string
  taskName: string
  /** Package-owned code and static assets. */
  packageRoot: string
  /** Mutable Local-host data. `hubRoot` remains its compatibility alias. */
  dataRoot: string
  hubRoot: string
  nodePath: string
  cliPath: string
  serverPath: string
  installDir: string
  binDir: string
  shimCmd: string
  shimAliasCmd: string
  shimUnix: string
  manifestPath: string
  silentVbs: string
  runDaemonCmd: string
  extraShimDir: string | null
  extraShimCmd: string | null
  extraShimAliasCmd: string | null
  port: number
  apiUrl: string
}

/** Values copied into the detached daemon launcher only after the Local trace gate is validated. */
export type DaemonTraceEnvironment = {
  runId: string
  runRoot: string
  pinned: {
    PATH: string
    DSH_HOME: string
    HOME: string
    XDG_CONFIG_HOME: string
    USERPROFILE: string
    APPDATA: string
    LOCALAPPDATA: string
    TEMP: string
    TMP: string
    HUB_SPAWN_CODEX: string
    SKILL_GRAFT_HOME: string
    GIT_CONFIG_GLOBAL: string
    GIT_CONFIG_NOSYSTEM: string
    GIT_OPTIONAL_LOCKS: string
  }
}

export type LayoutFile = {
  path: string
  content: string
}

export type DoctorIssue = {
  level: 'error' | 'warn'
  message: string
}

export type DoctorCheck = {
  ok: boolean
  path: string
  version: string
  detail?: string
}

export type DoctorReport = {
  ok: boolean
  hubRoot: string
  command: string
  node: DoctorCheck
  git: DoctorCheck
  dist: DoctorCheck
  codex: DoctorCheck
  layout: { ok: boolean; missing: string[] }
  shims: { ok: boolean; cmd: string; alias: string; unix: string }
  path: { ok: boolean; binDir: string; onUserPath: boolean; extraShimDir: string | null }
  daemon: {
    ok: boolean
    taskName: string
    taskRegistered: boolean
    running: boolean
    pid: number
    apiHealthy: boolean
    apiUrl: string
  }
  issues: DoctorIssue[]
}

export type SetupFlags = {
  dryRun: boolean
  json: boolean
  noDaemon: boolean
  noPath: boolean
  noTask: boolean
  rebuild: boolean
}

export type SetupStep = {
  id: string
  ok: boolean
  skipped?: boolean
  detail: string
}

export type SetupResult = {
  ok: boolean
  action: 'setup'
  dryRun: boolean
  product: string
  command: string
  hubRoot: string
  installDir: string
  binDir: string
  apiUrl: string
  taskName: string
  steps: SetupStep[]
  doctor: DoctorReport
  issues: DoctorIssue[]
}

export type UninstallResult = {
  ok: boolean
  action: 'uninstall'
  stopped: boolean
  taskRemoved: boolean
  pathRemoved: boolean
  filesRemoved: boolean
  extraShimsRemoved: boolean
  installDir: string
  issues: DoctorIssue[]
}

export type DaemonStatus = {
  ok: boolean
  action: 'daemon-status'
  taskName: string
  taskRegistered: boolean
  running: boolean
  pid: number
  apiPid: number
  apiHealthy: boolean
  apiUrl: string
  heartbeat: Record<string, unknown> | null
}

export type DoctorFacts = {
  hubRoot: string
  nodePath: string
  nodeVersion: string
  gitPath: string
  gitVersion: string
  codexPath: string
  distExists: boolean
  cliPath: string
  missingLayout: string[]
  shimCmdExists: boolean
  shimAliasExists: boolean
  shimUnixExists: boolean
  extraShimExists: boolean
  userPath: string
  pathSep: string
  caseInsensitive: boolean
  taskRegistered: boolean
  daemonPid: number
  daemonAlive: boolean
  apiHealthy: boolean
  apiPort: number
}

export function resolveInstallDir(input: {
  platform: string
  home: string
  localAppData?: string
  override?: string
}): string {
  if (input.override) return input.override
  if (input.platform === 'win32') {
    const root = input.localAppData || joinPosix(input.home, 'AppData/Local')
    return `${trimSlash(root)}\\${INSTALL_DIR_NAME}`
  }
  return `${trimSlash(input.home)}/.local/share/${INSTALL_DIR_NAME}`
}

export function resolveInstallPaths(
  path: PathPort,
  input: {
    hubRoot: string
    packageRoot?: string
    dataRoot?: string
    nodePath: string
    installDir: string
    extraShimDir?: string | null
    port?: number
  }
): InstallPaths {
  const packageRoot = path.resolve(input.packageRoot || input.hubRoot)
  const dataRoot = path.resolve(input.dataRoot || input.hubRoot)
  const hubRoot = dataRoot
  const installDir = path.resolve(input.installDir)
  const binDir = path.join(installDir, 'bin')
  const extraShimDir = input.extraShimDir ? path.resolve(input.extraShimDir) : null
  const port = input.port || API_PORT
  return {
    product: PRODUCT_NAME,
    command: PRODUCT_COMMAND,
    alias: PRODUCT_ALIAS,
    taskName: TASK_NAME,
    packageRoot,
    dataRoot,
    hubRoot,
    nodePath: input.nodePath,
    cliPath: path.join(packageRoot, 'dist', 'control', 'cli.js'),
    serverPath: path.join(packageRoot, 'server', 'index.mjs'),
    installDir,
    binDir,
    shimCmd: path.join(binDir, `${PRODUCT_COMMAND}.cmd`),
    shimAliasCmd: path.join(binDir, `${PRODUCT_ALIAS}.cmd`),
    shimUnix: path.join(binDir, PRODUCT_COMMAND),
    manifestPath: path.join(installDir, 'install.json'),
    silentVbs: path.join(installDir, 'silent-run.vbs'),
    runDaemonCmd: path.join(installDir, 'run-daemon.cmd'),
    extraShimDir,
    extraShimCmd: extraShimDir ? path.join(extraShimDir, `${PRODUCT_COMMAND}.cmd`) : null,
    extraShimAliasCmd: extraShimDir ? path.join(extraShimDir, `${PRODUCT_ALIAS}.cmd`) : null,
    port,
    apiUrl: `http://127.0.0.1:${port}/api/health`
  }
}

export function layoutSpec(hubRoot: string, path: PathPort): { dirs: string[]; files: LayoutFile[] } {
  const overlay = path.join(hubRoot, 'overlay')
  const skills = path.join(hubRoot, 'skills')
  const review = path.join(hubRoot, 'skill-review')
  return {
    dirs: [
      overlay,
      skills,
      path.join(skills, 'inbox'),
      path.join(skills, 'adopted'),
      review,
      path.join(review, 'history')
    ],
    files: [
      {
        path: path.join(overlay, 'scan-roots.txt'),
        content: [
          '# Directories scanned for client checkouts (one level).',
          '# Each independent clone found here also contributes its git worktree list.',
          ''
        ].join('\n')
      },
      { path: path.join(overlay, 'attached-worktrees.txt'), content: '' },
      { path: path.join(overlay, 'do-not-auto-attach.txt'), content: '' },
      {
        path: path.join(skills, 'README.md'),
        content: 'Local skill corpus. This directory is not published.\n'
      },
      {
        path: path.join(review, 'state.json'),
        content: `${JSON.stringify({ version: 1, lastIngest: null, items: [] }, null, 2)}\n`
      },
      {
        path: path.join(review, 'sessions.json'),
        content: `${JSON.stringify({ sessions: [] }, null, 2)}\n`
      }
    ]
  }
}

export function mergeUserPath(
  current: string,
  binDir: string,
  sep: string,
  caseInsensitive: boolean
): { path: string; changed: boolean; already: boolean } {
  const parts = current.split(sep).map((part) => part.trim()).filter(Boolean)
  const already = parts.some((part) => sameDir(part, binDir, caseInsensitive))
  if (already) return { path: current.replace(/\s+$/, ''), changed: false, already: true }
  const next = parts.length ? `${binDir}${sep}${parts.join(sep)}` : binDir
  return { path: next, changed: true, already: false }
}

export function removeFromUserPath(
  current: string,
  binDir: string,
  sep: string,
  caseInsensitive: boolean
): { path: string; changed: boolean } {
  const parts = current.split(sep).map((part) => part.trim()).filter(Boolean)
  const kept = parts.filter((part) => !sameDir(part, binDir, caseInsensitive))
  const next = kept.join(sep)
  return { path: next, changed: next !== parts.join(sep) }
}

export function pathHasDir(current: string, dir: string, sep: string, caseInsensitive: boolean): boolean {
  return current.split(sep).some((part) => sameDir(part.trim(), dir, caseInsensitive))
}

export function toGitBashPath(winPath: string): string {
  const drive = winPath.match(/^([A-Za-z]):([\\/].*)$/)
  if (drive) return `/${drive[1]?.toLowerCase()}${drive[2]?.replace(/\\/g, '/')}`
  if (/^\\\\/.test(winPath)) return winPath.replace(/\\/g, '/')
  return winPath
}

export function renderShims(paths: InstallPaths, daemonTrace?: DaemonTraceEnvironment): {
  sgCmd: string
  aliasCmd: string
  unix: string
  vbs: string
  runDaemonCmd: string
  manifest: string
} {
  const packageRoot = stripTrailingSep(paths.packageRoot)
  const dataRoot = stripTrailingSep(paths.dataRoot)
  const node = stripTrailingSep(paths.nodePath)
  const cli = stripTrailingSep(paths.cliPath)
  const sgCmd = renderCmdShim(dataRoot, node, cli, paths.port)
  const unixNode = toGitBashPath(node)
  const unixCli = toGitBashPath(cli)
  const unixData = toGitBashPath(dataRoot)
  const unix = [
    '#!/bin/sh',
    'if [ -z "${SKILL_GRAFT_HOME-}" ] && [ -z "${HUB_ROOT-}" ]; then',
    `  SKILL_GRAFT_HOME=${shellSingleQuote(unixData)}`,
    `  HUB_ROOT=${shellSingleQuote(unixData)}`,
    'elif [ -z "${SKILL_GRAFT_HOME-}" ]; then',
    '  SKILL_GRAFT_HOME="${HUB_ROOT}"',
    'elif [ -z "${HUB_ROOT-}" ]; then',
    '  HUB_ROOT="${SKILL_GRAFT_HOME}"',
    'fi',
    'if [ -z "${HUB_API_PORT-}" ]; then',
    `  HUB_API_PORT=${shellSingleQuote(String(paths.port))}`,
    'fi',
    'export SKILL_GRAFT_HOME HUB_ROOT HUB_API_PORT',
    `exec ${shellSingleQuote(unixNode)} ${shellSingleQuote(unixCli)} "$@"`,
    ''
  ].join('\n')
  const runCmd = stripTrailingSep(paths.runDaemonCmd)
  const vbs = [
    'Set sh = CreateObject("Wscript.Shell")',
    `sh.Run "cmd.exe /c ""${runCmd.replace(/"/g, '')}""", 0, False`,
    ''
  ].join('\r\n')
  const runDaemonCmd = [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    'chcp 65001 >nul',
    `set "SKILL_GRAFT_HOME=${bat(dataRoot)}"`,
    `set "HUB_ROOT=${bat(dataRoot)}"`,
    `set "HUB_API_PORT=${paths.port}"`,
    ...(daemonTrace ? [
      'for /f "tokens=1 delims==" %%G in (\'set GIT_ 2^>nul\') do set "%%G="',
      'for /f "tokens=1 delims==" %%D in (\'set DSH_ 2^>nul\') do set "%%D="',
      ...Object.entries(daemonTrace.pinned)
        .filter(([name]) => name !== 'SKILL_GRAFT_HOME')
        .map(([name, value]) => `set "${name}=${batEnvironment(value)}"`),
      'set "SKILL_GRAFT_INVOCATION_TRACE=1"',
      'set "SKILL_GRAFT_REAL_E2E=1"',
      `set "SKILL_GRAFT_RUN_ID=${bat(daemonTrace.runId)}"`,
      `set "SKILL_GRAFT_E2E_ROOT=${bat(daemonTrace.runRoot)}"`
    ] : []),
    `cd /d "${bat(packageRoot)}"`,
    `"${bat(node)}" "${bat(cli)}" daemon run`,
    ''
  ].join('\r\n')
  const manifest = `${JSON.stringify(
    {
      product: paths.product,
      command: paths.command,
      alias: paths.alias,
      packageRoot: paths.packageRoot,
      dataRoot: paths.dataRoot,
      hubRoot: paths.hubRoot,
      nodePath: paths.nodePath,
      cliPath: paths.cliPath,
      installDir: paths.installDir,
      binDir: paths.binDir,
      port: paths.port,
      taskName: paths.taskName,
      installedAt: null
    },
    null,
    2
  )}\n`
  return { sgCmd, aliasCmd: sgCmd, unix, vbs, runDaemonCmd, manifest }
}

export function evaluateDoctor(paths: InstallPaths, facts: DoctorFacts): DoctorReport {
  const issues: DoctorIssue[] = []
  const nodeOk = Boolean(facts.nodePath)
  const gitOk = Boolean(facts.gitPath)
  const distOk = facts.distExists
  const layoutOk = facts.missingLayout.length === 0
  const shimsOk = facts.shimCmdExists
  const onUserPath = pathHasDir(facts.userPath, paths.binDir, facts.pathSep, facts.caseInsensitive)
  const pathOk = onUserPath || facts.extraShimExists
  const daemonOk = facts.daemonAlive && facts.apiHealthy
  if (!nodeOk) issues.push({ level: 'error', message: 'Node.js is not installed or not on PATH' })
  if (!gitOk) issues.push({ level: 'error', message: 'Git is not installed or not on PATH' })
  if (!distOk) issues.push({ level: 'error', message: `CLI is not built (${paths.cliPath}). Run setup.cmd or npm run build` })
  if (!layoutOk) issues.push({ level: 'error', message: `Missing hub directories: ${facts.missingLayout.join(', ')}` })
  if (!shimsOk) issues.push({ level: 'warn', message: `sg is not installed. Run:  ${paths.cliPath ? 'sg setup' : 'setup.cmd'}` })
  if (shimsOk && !pathOk) issues.push({ level: 'warn', message: `User PATH does not include ${paths.binDir}. Open a new terminal after setup` })
  if (!facts.codexPath) issues.push({ level: 'warn', message: 'Codex CLI is not installed; attach/edit/chat cannot spawn a conversation' })
  if (!facts.taskRegistered) issues.push({ level: 'warn', message: `Logon task ${paths.taskName} is not registered` })
  if (!facts.daemonAlive) issues.push({ level: 'warn', message: 'Keep-alive daemon is not running' })
  else if (!facts.apiHealthy) issues.push({ level: 'warn', message: `API is down (${paths.apiUrl})` })
  const errors = issues.filter((issue) => issue.level === 'error')
  return {
    ok: errors.length === 0,
    hubRoot: paths.hubRoot,
    command: PRODUCT_COMMAND,
    node: { ok: nodeOk, path: facts.nodePath, version: facts.nodeVersion },
    git: { ok: gitOk, path: facts.gitPath, version: facts.gitVersion },
    dist: { ok: distOk, path: paths.cliPath, version: distOk ? 'built' : '' },
    codex: { ok: Boolean(facts.codexPath), path: facts.codexPath, version: facts.codexPath ? 'present' : '' },
    layout: { ok: layoutOk, missing: facts.missingLayout },
    shims: {
      ok: shimsOk,
      cmd: facts.shimCmdExists ? paths.shimCmd : '',
      alias: facts.shimAliasExists ? paths.shimAliasCmd : '',
      unix: facts.shimUnixExists ? paths.shimUnix : ''
    },
    path: { ok: pathOk, binDir: paths.binDir, onUserPath, extraShimDir: paths.extraShimDir },
    daemon: {
      ok: daemonOk,
      taskName: paths.taskName,
      taskRegistered: facts.taskRegistered,
      running: facts.daemonAlive,
      pid: facts.daemonPid,
      apiHealthy: facts.apiHealthy,
      apiUrl: paths.apiUrl
    },
    issues
  }
}

export function formatSetupReport(result: SetupResult): string {
  const d = result.doctor
  const mark = (ok: boolean) => (ok ? 'ok  ' : 'FAIL')
  const skip = (step: SetupStep) => (step.skipped ? 'skip' : mark(step.ok))
  const step = (id: string) => result.steps.find((item) => item.id === id)
  const lines = [
    `${result.dryRun ? 'skill-graft setup (dry-run)' : 'skill-graft setup'}`,
    '',
    `  Node.js     ${mark(d.node.ok)} ${d.node.version}  ${d.node.path}`.trimEnd(),
    `  Git         ${mark(d.git.ok)} ${d.git.version}  ${d.git.path}`.trimEnd(),
    `  Codex       ${d.codex.ok ? 'ok  ' : 'warn'} ${d.codex.path || 'not installed'}`,
    `  Build       ${mark(d.dist.ok)} ${d.dist.path}`,
    `  Layout      ${mark(d.layout.ok)} ${d.layout.ok ? 'skills / overlay / skill-review' : d.layout.missing.join(', ')}`
  ]
  const deps = step('deps')
  const env = step('env')
  const shims = step('shims')
  const pathStep = step('path')
  const task = step('task')
  const daemon = step('daemon')
  if (deps) lines.push(`  Deps        ${skip(deps)} ${deps.detail}`)
  if (env) lines.push(`  Env         ${skip(env)} ${env.detail}`)
  if (shims) lines.push(`  Command     ${skip(shims)} sg -> ${result.binDir}`)
  if (pathStep) lines.push(`  PATH        ${skip(pathStep)} ${pathStep.detail}`)
  if (task) lines.push(`  Autostart   ${skip(task)} ${task.detail}`)
  if (daemon) lines.push(`  Daemon      ${skip(daemon)} ${daemon.detail}`)
  lines.push('')
  if (result.issues.length) {
    for (const issue of result.issues) {
      lines.push(`  ${issue.level === 'error' ? 'error' : 'warn '}  ${issue.message}`)
    }
    lines.push('')
  }
  if (result.ok && !result.dryRun) {
    lines.push(`  API         ${d.daemon.apiUrl}`)
    lines.push('')
    lines.push('Open a new terminal and run:  sg status')
    lines.push('If an already-open editor terminal cannot find sg, restart the editor.')
  } else if (result.ok && result.dryRun) {
    lines.push('Dry-run only. Re-run without --dry-run to apply.')
  } else {
    lines.push('Setup did not finish. Fix the errors above and run setup again.')
  }
  return lines.join('\n')
}

export function formatDoctorReport(report: DoctorReport): string {
  const mark = (ok: boolean) => (ok ? 'ok  ' : 'FAIL')
  const lines = [
    'skill-graft doctor',
    '',
    `  Hub         ${report.hubRoot}`,
    `  Node.js     ${mark(report.node.ok)} ${report.node.version}  ${report.node.path}`.trimEnd(),
    `  Git         ${mark(report.git.ok)} ${report.git.version}  ${report.git.path}`.trimEnd(),
    `  Codex       ${report.codex.ok ? 'ok  ' : 'warn'} ${report.codex.path || 'not installed'}`,
    `  CLI         ${mark(report.dist.ok)} ${report.dist.path}`,
    `  Layout      ${mark(report.layout.ok)} ${report.layout.ok ? 'ok' : report.layout.missing.join(', ')}`,
    `  sg          ${mark(report.shims.ok)} ${report.shims.cmd || 'not installed'}`,
    `  PATH        ${mark(report.path.ok)} ${report.path.binDir}${report.path.onUserPath ? ' (user PATH)' : ''}`,
    `  Autostart   ${report.daemon.taskRegistered ? 'ok  ' : 'warn'} task ${report.daemon.taskName}`,
    `  Daemon      ${report.daemon.running ? 'ok  ' : 'warn'} pid ${report.daemon.pid || '-'}  api ${report.daemon.apiHealthy ? 'up' : 'down'}`,
    ''
  ]
  if (report.issues.length) {
    for (const issue of report.issues) {
      lines.push(`  ${issue.level === 'error' ? 'error' : 'warn '}  ${issue.message}`)
    }
    lines.push('')
  }
  lines.push(report.ok ? 'Ready. Use:  sg status | sg attach --worktree <path>' : 'Not ready. Run setup.cmd or:  sg setup')
  return lines.join('\n')
}

export function formatUninstallReport(result: UninstallResult): string {
  const mark = (ok: boolean) => (ok ? 'ok  ' : 'FAIL')
  return [
    'skill-graft uninstall',
    '',
    `  Daemon      ${mark(result.stopped)} stopped`,
    `  Autostart   ${mark(result.taskRemoved)} task removed`,
    `  PATH        ${mark(result.pathRemoved)} bin removed`,
    `  Shims       ${mark(result.filesRemoved)} ${result.installDir}`,
    '',
    result.ok ? 'Removed. The hub repository itself was left in place.' : 'Uninstall did not finish.'
  ].join('\n')
}

function renderCmdShim(dataRoot: string, nodePath: string, cliPath: string, port: number): string {
  return [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    ...renderInteractiveCmdDataRootDefaults(dataRoot),
    `if not defined HUB_API_PORT set "HUB_API_PORT=${port}"`,
    `"${bat(nodePath)}" "${bat(cliPath)}" %*`,
    ''
  ].join('\r\n')
}

function renderInteractiveCmdDataRootDefaults(dataRoot: string): string[] {
  const fallback = bat(dataRoot)
  return [
    'set "_SKILL_GRAFT_DATA_ROOT_DEFAULT="',
    'if not defined SKILL_GRAFT_HOME if not defined HUB_ROOT set "_SKILL_GRAFT_DATA_ROOT_DEFAULT=1"',
    `if defined _SKILL_GRAFT_DATA_ROOT_DEFAULT set "SKILL_GRAFT_HOME=${fallback}"`,
    `if defined _SKILL_GRAFT_DATA_ROOT_DEFAULT set "HUB_ROOT=${fallback}"`,
    'set "_SKILL_GRAFT_DATA_ROOT_DEFAULT="'
  ]
}

function sameDir(left: string, right: string, caseInsensitive: boolean): boolean {
  const a = stripTrailingSep(left)
  const b = stripTrailingSep(right)
  if (!a || !b) return false
  return caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b
}

function stripTrailingSep(value: string): string {
  return value.replace(/[\\/]+$/, '')
}

function trimSlash(value: string): string {
  return value.replace(/[\\/]+$/, '')
}

function joinPosix(left: string, right: string): string {
  return `${trimSlash(left)}/${right}`
}

function bat(value: string): string {
  return stripTrailingSep(value).replace(/%/g, '%%')
}

function batEnvironment(value: string): string {
  return value.replace(/%/g, '%%')
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
