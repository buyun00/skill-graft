import type { PathPort } from '../../adapters/host-context.js'

export const PRODUCT_NAME = 'skill-graft'
export const PRODUCT_COMMAND = 'sg'
export const PRODUCT_ALIAS = 'ozdqp-hub'
export const TASK_NAME = 'SkillGraft'
export const API_PORT = 18765
export const INSTALL_DIR_NAME = 'skill-graft'
export const INSTALL_MANIFEST_VERSION = 2 as const
export const DATA_ROOT_MARKER_VERSION = 1 as const
export const PUBLIC_RUNTIME_CORPUS_VERSION = 1 as const
export const LIFECYCLE_ROOT_RECEIPT_VERSION = 1 as const

export type Sha256Digest = `sha256:${string}`

export type OwnedInstallFile = {
  path: string
  sha256: Sha256Digest
}

export type OwnedEnvironmentValue = {
  name: 'SKILL_GRAFT_HOME' | 'HUB_ROOT' | 'HUB_API_PORT'
  value: string
  created: boolean
  kind: 'String' | 'ExpandString'
}

export type LifecycleUserPathValueState = {
  exists: boolean
  value: string
  kind: 'String' | 'ExpandString' | null
}

export type InstallManifestV2 = {
  schemaVersion: typeof INSTALL_MANIFEST_VERSION
  installId: string
  product: typeof PRODUCT_NAME
  command: typeof PRODUCT_COMMAND
  alias: typeof PRODUCT_ALIAS
  packageRoot: string
  packageVersion: string
  packageSha256: Sha256Digest
  nodePath: string
  dataRoot: string
  dataRootId: string
  installDir: string
  binDir: string
  extraShimDir: string | null
  port: number
  taskName: string
  features: {
    path: boolean
    task: boolean
    daemon: boolean
  }
  owned: {
    files: readonly OwnedInstallFile[]
    pathEntry: {
      value: string
      added: boolean
      prior: LifecycleUserPathValueState | null
    }
    environment: readonly OwnedEnvironmentValue[]
    task: { taskPath: '\\'; name: string; launcher: string; created: boolean } | null
  }
  installedAt: string
  updatedAt: string
}

export type PublicRuntimeCorpusEntry = {
  path: string
  sha256: Sha256Digest
  size: number
}

export type DataRootMarkerV1 = {
  schemaVersion: typeof DATA_ROOT_MARKER_VERSION
  dataRootId: string
  activeInstallId: string | null
  canonicalRoot: string
  createdAt: string
  runtime: {
    schemaVersion: typeof PUBLIC_RUNTIME_CORPUS_VERSION
    files: readonly PublicRuntimeCorpusEntry[]
  }
}

/**
 * Per-user discovery authority for the one preserved Skill Graft data root.
 *
 * This record deliberately contains only stable lifecycle identity. Provider
 * selections such as PATH, Task Scheduler, and API port remain manifest/WAL
 * authority and are never inferred from ambient process environment.
 */
type LifecycleRootReceiptBaseV1 = {
  schemaVersion: typeof LIFECYCLE_ROOT_RECEIPT_VERSION
  product: typeof PRODUCT_NAME
  installId: string
  dataRootId: string
  dataRoot: string
  installDir: string
  packageRoot: string
  packageVersion: string
  packageSha256: Sha256Digest
  createdAt: string
  updatedAt: string
}

export type LifecycleRootReceiptV1 = LifecycleRootReceiptBaseV1 & ({
  state: 'active' | 'inactive'
} | {
  state: 'purging'
  purgeId: string
  lockToken: string
  priorInactiveReceiptSha256: Sha256Digest
  planHash: Sha256Digest
  treeSha256: Sha256Digest
  entries: number
  bytes: number
  rootDev: string
  rootIno: string
  tombstone: string
  quarantine: string
  deletedWalSha256: Sha256Digest
})

export type DaemonLifecycleReceiptAuthorityFileState = Readonly<{
  bytes: Buffer | null
  stat: Readonly<{ dev: number; ino: number; size: number; mtimeMs: number; nlink: number }> | null
}>

/**
 * Leaf-level snapshot passed into daemon-protocol through an explicit reader
 * port.  The lifecycle control layer remains the only receipt parser; keeping
 * this value type in the domain module avoids an install -> daemon -> install
 * runtime import cycle when D1 wires the protocol into production.
 */
export type DaemonLifecycleReceiptAuthoritySnapshot = Readonly<{
  home: string
  directory: string
  directoryState: Readonly<{ dev: number; ino: number; size: number; mtimeMs: number; nlink: number }>
  entries: readonly string[]
  homeIdentity: string
  namespaceMarker: string
  namespaceMarkerState: DaemonLifecycleReceiptAuthorityFileState
  receiptFile: string
  receipt: LifecycleRootReceiptV1
  receiptState: DaemonLifecycleReceiptAuthorityFileState
  ownerStageNamespaceId: string | null
  ownerStageAuthorityMarker: string | null
  ownerStageAuthorityMarkerState: DaemonLifecycleReceiptAuthorityFileState | null
  daemonStageNamespaceId: string | null
  daemonStageAuthorityMarker: string | null
  daemonStageAuthorityMarkerState: DaemonLifecycleReceiptAuthorityFileState | null
}>

export type LifecycleIntegrationStateV1 = {
  userPath: LifecycleUserPathValueState & {
    managed: boolean
  }
  environment: readonly {
    name: OwnedEnvironmentValue['name']
    exists: boolean
    value: string
    kind: 'String' | 'ExpandString' | null
  }[]
  task: {
    managed: boolean
    exists: boolean
    action: string
  }
}

export type LifecycleExternalArtifactFactV1 = {
  kind: 'file' | 'symlink' | 'directory' | 'other'
  dev: number
  ino: number
  mode: number
  size: number
  mtimeMs: number
  nlink: number
  sha256: Sha256Digest | null
  linkTarget: string | null
}

export type LifecycleExternalArtifactV1 = {
  path: string
  ownedSha256: Sha256Digest
  action: 'delete-exact' | 'preserve-absent' | 'preserve-foreign'
  before: LifecycleExternalArtifactFactV1 | null
}

export type LifecycleWalV1 = {
  schemaVersion: 1
  walId: string
  lockToken: string
  operation: 'setup' | 'upgrade' | 'uninstall'
  phase: 'prepared' | 'switched' | 'committed'
  installDir: string
  oldManifest: InstallManifestV2 | null
  newManifest: InstallManifestV2 | null
  oldReceipt: LifecycleRootReceiptV1 | null
  newReceipt: LifecycleRootReceiptV1
  oldMarker: DataRootMarkerV1 | null
  newMarker: DataRootMarkerV1 | null
  oldIntegration: LifecycleIntegrationStateV1
  newIntegration: LifecycleIntegrationStateV1
  externalArtifacts: readonly LifecycleExternalArtifactV1[]
  tombstone: string | null
  oldDaemonRunning: boolean
  createdAt: string
}

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
  dataMarkerPath: string
  lifecycleLockPath: string
  lifecycleWalPath: string
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
  lifecycle: {
    manifest: boolean
    ownership: boolean
    lockHealthy: boolean
    dataMarker: boolean
    packageVersion: string
    installedVersion: string
    versionMatch: boolean
    corpusEmpty: boolean
    lockState: 'clear' | 'active' | 'stale' | 'unverifiable'
    walPending: boolean
    durablePending: number
    reviewLocks: { active: number; stale: number; unverifiable: number }
    expected: { path: boolean; task: boolean; daemon: boolean } | null
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
  status: 'uninstalled' | 'already-uninstalled' | 'failed'
  stopped: boolean
  taskRemoved: boolean
  pathRemoved: boolean
  filesRemoved: boolean
  extraShimsRemoved: boolean
  installDir: string
  issues: DoctorIssue[]
}

export type UpgradeFlags = {
  dryRun: boolean
  json: boolean
  noDaemon: boolean
}

export type UpgradeResult = {
  ok: boolean
  action: 'upgrade'
  dryRun: boolean
  status: 'planned' | 'upgraded' | 'already-current' | 'failed'
  fromVersion: string
  toVersion: string
  packageRoot: string
  installDir: string
  doctor: DoctorReport
  issues: DoctorIssue[]
}

export type PurgePlanV1 = {
  schemaVersion: 1
  action: 'purge'
  dataRootId: string
  treeSha256: Sha256Digest
  entries: number
  bytes: number
  planHash: Sha256Digest
}

export type PurgeFlags = {
  dataRoot: string
  dryRun: boolean
  commit: boolean
  planHash?: Sha256Digest
  dataRootId?: string
  json: boolean
}

export type PurgeResult = {
  ok: boolean
  action: 'purge'
  mode: 'dryRun' | 'commit'
  status: 'planned' | 'purged' | 'already-absent' | 'failed'
  plan: PurgePlanV1 | null
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
  extraShimDir?: string | null
  userPath: string
  pathSep: string
  caseInsensitive: boolean
  taskRegistered: boolean
  daemonPid: number
  apiPid?: number
  daemonAlive: boolean
  apiHealthy: boolean
  apiPort: number
  manifestExists?: boolean
  manifestOwned?: boolean
  lifecycleExpected?: { path: boolean; task: boolean; daemon: boolean }
  lifecycleLockHealthy?: boolean
  dataMarkerOk?: boolean
  packageVersion?: string
  installedVersion?: string
  versionMatch?: boolean
  corpusEmpty?: boolean
  lifecycleLockState?: 'clear' | 'active' | 'stale' | 'unverifiable'
  lifecycleWalPending?: boolean
  durablePending?: number
  reviewLockActive?: number
  reviewLockStale?: number
  reviewLockUnverifiable?: number
  integrationInspectionError?: string
  daemonInspectionError?: string
  corpusInspectionError?: string
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
    taskName?: string
    port?: number
  }
): InstallPaths {
  const packageRoot = path.resolve(input.packageRoot || input.hubRoot)
  const dataRoot = path.resolve(input.dataRoot || input.hubRoot)
  const hubRoot = dataRoot
  const installDir = path.resolve(input.installDir)
  const binDir = path.join(installDir, 'bin')
  const extraShimDir = input.extraShimDir ? path.resolve(input.extraShimDir) : null
  const port = input.port ?? API_PORT
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('lifecycle API port must be an integer from 1 to 65535')
  }
  return {
    product: PRODUCT_NAME,
    command: PRODUCT_COMMAND,
    alias: PRODUCT_ALIAS,
    taskName: input.taskName || TASK_NAME,
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
    dataMarkerPath: path.join(dataRoot, '.skill-graft-data-root.json'),
    // All mutations of one data root, including purge, share this external
    // namespace.  It stays outside the root so rename/delete cannot erase it.
    lifecycleLockPath: `${dataRoot}.lifecycle.lock`,
    lifecycleWalPath: `${dataRoot}.lifecycle-wal.json`,
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
  if (already) return { path: current, changed: false, already: true }
  // PATH is user-owned opaque text.  Detection may normalize each entry, but
  // the lifecycle is only allowed to prepend its one entry and must preserve
  // every existing byte (including empty entries, whitespace, and %VARS%).
  const next = current.length > 0 ? `${binDir}${sep}${current}` : binDir
  return { path: next, changed: true, already: false }
}

export function removeFromUserPath(
  current: string,
  binDir: string,
  sep: string,
  caseInsensitive: boolean
): { path: string; changed: boolean } {
  const boundary = current.indexOf(sep)
  const first = boundary < 0 ? current : current.slice(0, boundary)
  if (!sameDir(first, binDir, caseInsensitive)) return { path: current, changed: false }
  return {
    path: boundary < 0 ? '' : current.slice(boundary + sep.length),
    changed: true
  }
}

export function pathHasDir(current: string, dir: string, sep: string, caseInsensitive: boolean): boolean {
  return current.split(sep).some((part) => sameDir(part.trim(), dir, caseInsensitive))
}

export function expectedTaskAction(vbsPath: string): string {
  return `wscript.exe\u0000"${stripTrailingSep(vbsPath)}"`
}

export function toGitBashPath(winPath: string): string {
  const drive = winPath.match(/^([A-Za-z]):([\\/].*)$/)
  if (drive) return `/${drive[1]?.toLowerCase()}${drive[2]?.replace(/\\/g, '/')}`
  if (/^\\\\/.test(winPath)) return winPath.replace(/\\/g, '/')
  return winPath
}

export type DaemonLauncherEnvironment = Readonly<Partial<Record<
  'HOME' | 'USERPROFILE' | 'APPDATA' | 'LOCALAPPDATA' | 'TEMP' | 'TMP',
  string
>>>

export function renderShims(
  paths: InstallPaths,
  daemonTrace?: DaemonTraceEnvironment,
  launcherEnvironment: DaemonLauncherEnvironment = {}
): {
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
  const sgCmd = renderCmdShim(dataRoot, node, cli, paths.port, paths.installDir, paths.taskName)
  const unixNode = toGitBashPath(node)
  const unixCli = toGitBashPath(cli)
  const unixData = toGitBashPath(dataRoot)
  const launcherEnvironmentLines = (['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP'] as const)
    .flatMap((name) => {
      const value = launcherEnvironment[name]
      if (value === undefined) return []
      if (!value || /["\u0000\r\n]/.test(value)) {
        throw new Error(`daemon launcher ${name} is not safely representable`)
      }
      return [`set "${name}=${batEnvironment(value)}"`]
    })
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
    `SG_INSTALL_DIR=${shellSingleQuote(toGitBashPath(paths.installDir))}`,
    `SG_TASK_NAME=${shellSingleQuote(paths.taskName)}`,
    'export SKILL_GRAFT_HOME HUB_ROOT HUB_API_PORT SG_INSTALL_DIR SG_TASK_NAME',
    `exec ${shellSingleQuote(unixNode)} ${shellSingleQuote(unixCli)} "$@"`,
    ''
  ].join('\n')
  const runCmd = stripTrailingSep(paths.runDaemonCmd)
  const vbs = [
    'Set sh = CreateObject("Wscript.Shell")',
    `rc = sh.Run("cmd.exe /c ""${runCmd.replace(/"/g, '')}""", 0, True)`,
    'WScript.Quit rc',
    ''
  ].join('\r\n')
  const runDaemonCmd = [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    'chcp 65001 >nul',
    `set "SKILL_GRAFT_HOME=${bat(dataRoot)}"`,
    `set "HUB_ROOT=${bat(dataRoot)}"`,
    `set "HUB_API_PORT=${paths.port}"`,
    `set "SG_INSTALL_DIR=${bat(paths.installDir)}"`,
    `set "SG_TASK_NAME=${bat(paths.taskName)}"`,
    ...launcherEnvironmentLines,
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
    'exit /b %ERRORLEVEL%',
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
  const expected = facts.lifecycleExpected
  const manifestOk = facts.manifestExists ?? false
  const ownershipOk = facts.manifestOwned ?? false
  const lockHealthy = facts.lifecycleLockHealthy ?? true
  const dataMarkerOk = facts.dataMarkerOk ?? false
  const versionMatch = facts.versionMatch ?? false
  const lockState = facts.lifecycleLockState || (lockHealthy ? 'clear' : 'unverifiable')
  const walPending = Boolean(facts.lifecycleWalPending)
  const durablePending = facts.durablePending || 0
  const reviewActive = facts.reviewLockActive || 0
  const reviewStale = facts.reviewLockStale || 0
  const reviewUnverifiable = facts.reviewLockUnverifiable || 0
  if (!nodeOk) issues.push({ level: 'error', message: 'Node.js is not installed or not on PATH' })
  if (!gitOk) issues.push({ level: 'error', message: 'Git is not installed or not on PATH' })
  if (!distOk) issues.push({ level: 'error', message: `CLI is not built (${paths.cliPath}). Run setup.cmd or npm run build` })
  if (!layoutOk) issues.push({ level: 'error', message: `Missing hub directories: ${facts.missingLayout.join(', ')}` })
  if (!shimsOk) issues.push({ level: 'warn', message: `sg is not installed. Run:  ${paths.cliPath ? 'sg setup' : 'setup.cmd'}` })
  if (shimsOk && expected?.path && !pathOk) issues.push({ level: 'warn', message: `User PATH does not include ${paths.binDir}. Open a new terminal after setup` })
  if (!facts.codexPath) issues.push({ level: 'warn', message: 'Codex CLI is not installed; attach/edit/chat cannot spawn a conversation' })
  if (expected?.task && !facts.taskRegistered) issues.push({ level: 'warn', message: `Logon task ${paths.taskName} is not registered` })
  if (expected?.daemon && !facts.daemonAlive) issues.push({ level: 'warn', message: 'Keep-alive daemon is not running' })
  else if (expected?.daemon && !facts.apiHealthy) issues.push({ level: 'warn', message: `API is down (${paths.apiUrl})` })
  if (facts.integrationInspectionError) {
    issues.push({ level: 'error', message: `Lifecycle integration inspection failed: ${facts.integrationInspectionError}` })
  }
  if (facts.daemonInspectionError) {
    issues.push({ level: 'error', message: `Daemon inspection failed: ${facts.daemonInspectionError}` })
  }
  if (facts.corpusInspectionError) {
    issues.push({ level: 'error', message: `Private Skill corpus inspection failed: ${facts.corpusInspectionError}` })
  }
  if (!manifestOk) issues.push({ level: 'error', message: 'Install ownership manifest is missing' })
  else if (!ownershipOk) issues.push({ level: 'error', message: 'Install ownership manifest does not match current lifecycle artifacts' })
  if (!dataMarkerOk) issues.push({ level: 'error', message: 'Data-root ownership marker is missing or invalid' })
  if (lockState === 'active') issues.push({ level: 'error', message: 'Lifecycle operation is currently active' })
  else if (lockState === 'stale') issues.push({ level: 'warn', message: 'Lifecycle lock is stale and recoverable on the next write' })
  else if (lockState === 'unverifiable') issues.push({ level: 'error', message: 'Lifecycle lock is unverifiable' })
  if (walPending) issues.push({ level: 'error', message: 'Lifecycle WAL requires recovery before the installation is ready' })
  if (durablePending > 0) issues.push({ level: 'error', message: `${durablePending} durable transaction artifact(s) require recovery` })
  if (reviewActive > 0) issues.push({ level: 'error', message: `${reviewActive} application lease(s) are active` })
  if (reviewStale > 0) issues.push({ level: 'warn', message: `${reviewStale} application lease(s) are stale and recoverable` })
  if (reviewUnverifiable > 0) issues.push({ level: 'error', message: `${reviewUnverifiable} application lease artifact(s) are unverifiable` })
  if (!facts.packageVersion || !facts.installedVersion || !versionMatch) issues.push({ level: 'error', message: 'Installed package version does not match the active ownership manifest' })
  if (facts.corpusEmpty) issues.push({ level: 'warn', message: 'Private Skill corpus is empty; import or create Skills before pinning a worktree' })
  const errors = issues.filter((issue) => issue.level === 'error')
  const expectedReady = !expected || (
    (!expected.path || pathOk)
    && (!expected.task || facts.taskRegistered)
    && (!expected.daemon || daemonOk)
  )
  return {
    ok: errors.length === 0 && expectedReady,
    hubRoot: paths.hubRoot,
    command: PRODUCT_COMMAND,
    node: { ok: nodeOk, path: facts.nodePath, version: facts.nodeVersion },
    git: { ok: gitOk, path: facts.gitPath, version: facts.gitVersion },
    dist: { ok: distOk, path: paths.cliPath, version: distOk ? facts.packageVersion || 'unknown' : '' },
    codex: { ok: Boolean(facts.codexPath), path: facts.codexPath, version: facts.codexPath ? 'present' : '' },
    layout: { ok: layoutOk, missing: facts.missingLayout },
    shims: {
      ok: shimsOk,
      cmd: facts.shimCmdExists ? paths.shimCmd : '',
      alias: facts.shimAliasExists ? paths.shimAliasCmd : '',
      unix: facts.shimUnixExists ? paths.shimUnix : ''
    },
    path: { ok: pathOk, binDir: paths.binDir, onUserPath, extraShimDir: facts.extraShimDir ?? paths.extraShimDir },
    daemon: {
      ok: daemonOk,
      taskName: paths.taskName,
      taskRegistered: facts.taskRegistered,
      running: facts.daemonAlive,
      pid: facts.daemonPid,
      apiHealthy: facts.apiHealthy,
      apiUrl: paths.apiUrl
    },
    lifecycle: {
      manifest: manifestOk,
      ownership: ownershipOk,
      lockHealthy,
      dataMarker: dataMarkerOk,
      packageVersion: facts.packageVersion || '',
      installedVersion: facts.installedVersion || '',
      versionMatch,
      corpusEmpty: Boolean(facts.corpusEmpty),
      lockState,
      walPending,
      durablePending,
      reviewLocks: { active: reviewActive, stale: reviewStale, unverifiable: reviewUnverifiable },
      expected: expected || null
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
  const expected = report.lifecycle.expected
  const state = (enabled: boolean, ok: boolean, success: string, failure: string) => enabled
    ? `${ok ? 'ok  ' : 'warn'} ${ok ? success : failure}`
    : 'skip not owned'
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
    `  PATH        ${expected?.path === false ? 'skip not owned' : `${mark(report.path.ok)} ${report.path.binDir}${report.path.onUserPath ? ' (user PATH)' : ''}`}`,
    `  Autostart   ${state(expected?.task !== false, report.daemon.taskRegistered, `task ${report.daemon.taskName}`, `task ${report.daemon.taskName} missing`)}`,
    `  Daemon      ${state(expected?.daemon !== false, report.daemon.running && report.daemon.apiHealthy, `pid ${report.daemon.pid} api up`, `pid ${report.daemon.pid || '-'} api down`)}`,
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
  if (result.status === 'already-uninstalled' && result.ok) {
    return [
      'skill-graft uninstall',
      '',
      'Already uninstalled; no owned artifacts were removed.'
    ].join('\n')
  }
  if (result.status === 'uninstalled' && result.ok) {
    const outcome = (removed: boolean) => (removed ? 'ok   removed' : 'skip not owned / preserved')
    return [
      'skill-graft uninstall',
      '',
      `  Daemon      ${outcome(result.stopped)}`,
      `  Autostart   ${outcome(result.taskRemoved)}`,
      `  PATH        ${outcome(result.pathRemoved)}`,
      `  Shims       ${result.filesRemoved ? 'ok   removed' : 'FAIL not removed'} ${result.installDir}`,
      `  Extra shims ${outcome(result.extraShimsRemoved)}`,
      '',
      'Removed. The hub repository itself was left in place.'
    ].join('\n')
  }
  const mark = (ok: boolean) => (ok ? 'ok  ' : 'FAIL')
  return [
    'skill-graft uninstall',
    '',
    `  Daemon      ${mark(result.stopped)} stopped`,
    `  Autostart   ${mark(result.taskRemoved)} task removed`,
    `  PATH        ${mark(result.pathRemoved)} bin removed`,
    `  Shims       ${mark(result.filesRemoved)} ${result.installDir}`,
    '',
    'Uninstall did not finish.'
  ].join('\n')
}

function renderCmdShim(
  dataRoot: string,
  nodePath: string,
  cliPath: string,
  port: number,
  installDir: string,
  taskName: string
): string {
  return [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    ...renderInteractiveCmdDataRootDefaults(dataRoot),
    `if not defined HUB_API_PORT set "HUB_API_PORT=${port}"`,
    `set "SG_INSTALL_DIR=${bat(installDir)}"`,
    `set "SG_TASK_NAME=${bat(taskName)}"`,
    `"${bat(nodePath)}" "${bat(cliPath)}" %*`,
    ''
  ].join('\r\n')
}

export function formatUpgradeReport(result: UpgradeResult): string {
  const mark = (ok: boolean) => (ok ? 'ok  ' : 'FAIL')
  return [
    `skill-graft upgrade${result.dryRun ? ' (dry-run)' : ''}`,
    '',
    `  Package     ${result.fromVersion || '-'} -> ${result.toVersion || '-'}`,
    `  Install     ${mark(result.ok)} ${result.status}`,
    `  Doctor      ${mark(result.doctor.ok)} ${result.installDir}`,
    '',
    result.ok
      ? result.dryRun ? 'Dry-run only. Re-run without --dry-run to apply.' : 'Upgrade complete.'
      : result.status === 'upgraded' || result.status === 'already-current'
        ? 'Static installation is committed; daemon readiness repair is required. Retry sg upgrade or sg daemon start.'
        : 'Upgrade incomplete; inspect the issues and rerun to complete WAL recovery.'
  ].join('\n')
}

export function formatPurgeReport(result: PurgeResult): string {
  const plan = result.plan
  return [
    `skill-graft purge (${result.mode === 'dryRun' ? 'dry-run' : 'commit'})`,
    '',
    `  Status      ${result.status}`,
    ...(plan ? [
      `  Data ID     ${plan.dataRootId}`,
      `  Entries    ${plan.entries}`,
      `  Bytes      ${plan.bytes}`,
      `  Plan hash  ${plan.planHash}`
    ] : []),
    '',
    result.ok
      ? result.status === 'already-absent'
        ? 'No preserved data root exists; nothing was changed.'
        : result.mode === 'dryRun' ? 'Dry-run only. Re-run with --commit and the exact ID/hash.' : 'Data root purged.'
      : 'Purge did not finish.'
  ].join('\n')
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
