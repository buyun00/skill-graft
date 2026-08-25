import fs from 'node:fs'
import path from 'node:path'

export const LOCAL_CODEX_RUNTIME_ISSUES = [
  'runner-disabled',
  'node-unavailable',
  'codex-module-unavailable',
  'credential-unavailable',
  'controller-unavailable'
] as const

export type LocalCodexRuntimeIssue = (typeof LOCAL_CODEX_RUNTIME_ISSUES)[number]

export type LocalCodexRuntime = Readonly<{
  nodeExecutable: string
  codexModule: string
  credentialHome: string
  controllerPath: string
  enabled: boolean
  available: boolean
  ready: boolean
  issues: readonly LocalCodexRuntimeIssue[]
}>

export type ResolveLocalCodexRuntimeOptions = {
  packageRoot: string
  environment?: NodeJS.ProcessEnv
  allowStandardPaths?: boolean
  nodeExecutable?: string
  fallbackNodeExecutable?: string
  codexModule?: string
  credentialHome?: string
  controllerPath?: string
}

function configured(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

function firstConfigured(...values: Array<string | undefined>): string {
  for (const value of values) {
    const candidate = configured(value)
    if (candidate) return candidate
  }
  return ''
}

function standardCodexModule(environment: NodeJS.ProcessEnv): string {
  const appData = configured(environment.APPDATA)
  return appData
    ? path.join(appData, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    : ''
}

function standardCredentialHome(environment: NodeJS.ProcessEnv): string {
  const codexHome = configured(environment.CODEX_HOME)
  if (codexHome) return codexHome
  const userHome = firstConfigured(environment.USERPROFILE, environment.HOME)
  return userHome ? path.join(userHome, '.codex') : ''
}

function plainFile(target: string): boolean {
  if (!target || !path.isAbsolute(target)) return false
  try {
    return fs.statSync(target).isFile()
  } catch {
    return false
  }
}

/**
 * Resolves the Local Codex runtime only from the supplied composition and its
 * scoped environment. Explicit composition values win, followed by explicit
 * HUB_CODEX_* values. Trusted install/diagnostic composition may explicitly
 * enable discovery of standard paths inside the supplied APPDATA / USERPROFILE
 * authority; runtime composition remains fail-closed by default.
 */
export function resolveLocalCodexRuntime(
  options: ResolveLocalCodexRuntimeOptions
): LocalCodexRuntime {
  const environment = options.environment || {}
  const nodeExecutable = firstConfigured(
    options.nodeExecutable,
    environment.HUB_CODEX_NODE,
    options.fallbackNodeExecutable
  )
  const codexModule = firstConfigured(
    options.codexModule,
    environment.HUB_CODEX_MODULE,
    options.allowStandardPaths ? standardCodexModule(environment) : ''
  )
  const credentialHome = firstConfigured(
    options.credentialHome,
    environment.HUB_CODEX_CREDENTIAL_HOME,
    options.allowStandardPaths ? standardCredentialHome(environment) : ''
  )
  const controllerPath = firstConfigured(
    options.controllerPath,
    path.join(options.packageRoot, 'runtime', 'codex-runner-controller.ps1')
  )
  const enabled = environment.HUB_SPAWN_CODEX !== '0'
  const issues: LocalCodexRuntimeIssue[] = []
  if (!enabled) issues.push('runner-disabled')
  if (!plainFile(nodeExecutable)) issues.push('node-unavailable')
  if (!plainFile(codexModule)) issues.push('codex-module-unavailable')
  if (!plainFile(credentialHome ? path.join(credentialHome, 'auth.json') : '')) {
    issues.push('credential-unavailable')
  }
  if (!plainFile(controllerPath)) issues.push('controller-unavailable')
  const available = issues.every((issue) => issue === 'runner-disabled')
  return Object.freeze({
    nodeExecutable,
    codexModule,
    credentialHome,
    controllerPath,
    enabled,
    available,
    ready: enabled && available,
    issues: Object.freeze(issues)
  })
}

export function describeLocalCodexRuntime(runtime: LocalCodexRuntime): string {
  if (runtime.ready) return 'Session Runner ready'
  const labels: Record<LocalCodexRuntimeIssue, string> = {
    'runner-disabled': 'Session Runner is disabled by HUB_SPAWN_CODEX=0',
    'node-unavailable': 'Session Runner Node executable is unavailable',
    'codex-module-unavailable': 'Codex CLI module is unavailable',
    'credential-unavailable': 'Codex credentials are unavailable',
    'controller-unavailable': 'Session Runner controller is unavailable'
  }
  return runtime.issues.map((issue) => labels[issue]).join('; ')
}
