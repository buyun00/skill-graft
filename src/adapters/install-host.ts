import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expectedTaskAction, TASK_NAME } from '../local/lifecycle/install-domain.js'

export type CommandResult = {
  status: number
  stdout: string
  stderr: string
}

export type InstallHostSystem = {
  runPowerShell?: (command: string, extraEnv?: Record<string, string>) => CommandResult
  spawnSync?: typeof spawnSync
}

export type UserPathState = {
  exists: boolean
  value: string
  kind: 'String' | 'ExpandString' | null
}

export type UserEnvironmentState = {
  exists: boolean
  value: string
  kind: 'String' | 'ExpandString' | null
}

export type InstallHostIntegrationSnapshot = {
  userPath: UserPathState
  environment: Readonly<Record<string, UserEnvironmentState>>
  task: {
    exists: boolean
    action: string
  }
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index])
}

function parseUserRegistryState(value: unknown, label: string): UserPathState {
  const record = jsonObject(value)
  if (!record || !hasExactKeys(record, ['exists', 'value', 'kind'])
    || typeof record.exists !== 'boolean'
    || typeof record.value !== 'string') {
    throw new Error(`Windows integration snapshot ${label} state is invalid`)
  }
  if (!record.exists) {
    if (record.value !== '' || record.kind !== null) {
      throw new Error(`Windows integration snapshot ${label} absent state is invalid`)
    }
    return { exists: false, value: '', kind: null }
  }
  if (record.kind !== 'String' && record.kind !== 'ExpandString') {
    throw new Error(`Windows integration snapshot ${label} registry kind is invalid`)
  }
  return { exists: true, value: record.value, kind: record.kind }
}

function validateIntegrationEnvironmentNames(environmentNames: readonly string[]): string[] {
  if (!Array.isArray(environmentNames)) {
    throw new Error('integration snapshot environment names are invalid')
  }
  const names = [...environmentNames]
  if (names.some((name) => typeof name !== 'string' || name.length === 0 || name.includes('\0'))
    || new Set(names).size !== names.length) {
    throw new Error('integration snapshot environment names are invalid')
  }
  return names
}

function parseInstallHostIntegrationSnapshot(
  source: string,
  environmentNames: readonly string[],
  taskName: string
): InstallHostIntegrationSnapshot {
  let parsed: unknown
  try {
    parsed = JSON.parse(String(source || ''))
  } catch (error) {
    throw new Error('Windows integration snapshot returned invalid JSON', { cause: error })
  }
  const record = jsonObject(parsed)
  if (!record || !hasExactKeys(record, ['schemaVersion', 'userPath', 'environment', 'task'])
    || record.schemaVersion !== 1) {
    throw new Error('Windows integration snapshot shape is invalid')
  }
  const environment = jsonObject(record.environment)
  if (!environment || !hasExactKeys(environment, environmentNames)) {
    throw new Error('Windows integration snapshot environment shape is invalid')
  }
  const parsedEnvironment = Object.fromEntries(environmentNames.map((name) => [
    name,
    parseUserRegistryState(environment[name], `environment ${name}`)
  ])) as Record<string, UserEnvironmentState>
  const task = jsonObject(record.task)
  if (!task || !hasExactKeys(task, ['exists', 'action'])
    || typeof task.exists !== 'boolean'
    || typeof task.action !== 'string'
    || (!task.exists && task.action !== '')
    || (!taskName && (task.exists || task.action !== ''))) {
    throw new Error('Windows integration snapshot task shape is invalid')
  }
  return {
    userPath: parseUserRegistryState(record.userPath, 'user PATH'),
    environment: parsedEnvironment,
    task: { exists: task.exists, action: task.action }
  }
}

const localVolumeKindCache = new Map<string, 'local' | 'remote' | 'unknown'>()
const WMI_CREATE_TIMEOUT_MS = 30_000

export interface InstallHost {
  platform: string
  home: string
  localAppData: string
  pathSep: string
  caseInsensitive: boolean
  skipPath: boolean
  skipTask: boolean
  env(name: string): string | undefined
  environment(): NodeJS.ProcessEnv
  which(command: string): string
  commandVersion(bin: string): string
  localVolumeKind(target: string): 'local' | 'remote' | 'unknown'
  userPathState(): UserPathState
  userPath(): string
  userEnvState(name: string): UserEnvironmentState
  userEnv(name: string): string | undefined
  integrationSnapshot?(
    environmentNames: readonly string[],
    taskName: string
  ): InstallHostIntegrationSnapshot
  compareExchangeUserPath(expected: UserPathState, next: UserPathState): boolean
  compareExchangeUserEnv(name: string, expected: UserEnvironmentState, next: UserEnvironmentState): boolean
  setUserPath(value: string): void
  setUserEnv(name: string, value: string | null): void
  broadcastEnv(): void
  extraShimDir(): string | null
  taskExists(name: string): boolean
  taskAction(name: string): string
  registerLogonTask(taskName: string, vbsPath: string): void
  stopScheduledTaskInstance(taskName: string, expectedVbsPath: string): void
  unregisterTask(taskName: string, expectedVbsPath?: string): void
  pidAlive(pid: number): boolean
  processCommandLine(pid: number): string
  killPid(pid: number): boolean
  waitForPidsExit(pids: readonly number[], timeoutMs: number): boolean
  wmiCreate(commandLine: string, cwd: string): number
  launchDetached(
    command: string,
    args: readonly string[],
    opts: { cwd: string; env: NodeJS.ProcessEnv }
  ): number
  run(command: string, args: string[], opts?: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv }): CommandResult
  runNpm(args: string[], cwd: string, timeout?: number): CommandResult
}

export function createInstallHost(
  overrides: Partial<InstallHost> = {},
  system: InstallHostSystem = {}
): InstallHost {
  const platform = overrides.platform || process.platform
  const invokePowerShell = system.runPowerShell || runPowerShell
  const invokeSpawnSync = system.spawnSync || spawnSync
  const host: InstallHost = {
    platform,
    home: os.homedir(),
    localAppData: process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    pathSep: platform === 'win32' ? ';' : ':',
    caseInsensitive: platform === 'win32' || platform === 'darwin',
    skipPath: process.env.SG_SKIP_PATH === '1',
    skipTask: process.env.SG_SKIP_TASK === '1',
    env(name) {
      return process.env[name]
    },
    environment() {
      return { ...process.env }
    },
    which(command) {
      const tool = platform === 'win32' ? 'where' : 'which'
      const ran = spawnSync(tool, [command], { encoding: 'utf8', windowsHide: true })
      if (ran.status !== 0) return ''
      const line = String(ran.stdout || '')
        .split(/\r?\n/)
        .map((item) => item.trim())
        .find((item) => item && !item.startsWith('INFO:'))
      return line || ''
    },
    commandVersion(bin) {
      if (!bin) return ''
      const ran = spawnSync(bin, ['--version'], { encoding: 'utf8', windowsHide: true })
      return String(ran.stdout || ran.stderr || '').trim().split(/\r?\n/)[0] || ''
    },
    localVolumeKind(target) {
      const absolute = path.resolve(target)
      if (process.platform === 'win32') {
        if (/^\\\\/.test(absolute) || /^\\\\[?.]\\/.test(target)) return 'remote'
        const root = path.parse(absolute).root
        const cacheKey = `win32:${root.toLowerCase()}`
        const cached = localVolumeKindCache.get(cacheKey)
        if (cached) return cached
        const ran = spawnSync('powershell.exe', [
          '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
          `[Console]::Out.Write([string]([System.IO.DriveInfo]::new('${root.replace(/'/g, "''")}').DriveType))`
        ], { encoding: 'utf8', windowsHide: true })
        if (ran.status !== 0) return 'unknown'
        const kind = String(ran.stdout || '').trim()
        const classified = kind === 'Fixed' ? 'local' : kind === 'Network' ? 'remote' : 'unknown'
        localVolumeKindCache.set(cacheKey, classified)
        return classified
      }
      if (process.platform === 'linux') {
        try {
          let ancestor = absolute
          while (!fs.existsSync(ancestor)) {
            const parent = path.dirname(ancestor)
            if (parent === ancestor) break
            ancestor = parent
          }
          const rows = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n')
          let best: { mount: string; type: string } | null = null
          for (const row of rows) {
            const split = row.indexOf(' - ')
            if (split < 0) continue
            const left = row.slice(0, split).split(' ')
            const right = row.slice(split + 3).split(' ')
            const mount = String(left[4] || '').replace(/\\040/g, ' ').replace(/\\134/g, '\\')
            const type = String(right[0] || '')
            if ((ancestor === mount || ancestor.startsWith(`${mount}${path.sep}`))
              && (!best || mount.length > best.mount.length)) best = { mount, type }
          }
          if (!best) return 'unknown'
          if (['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'overlay', 'tmpfs'].includes(best.type)) return 'local'
          if (/^(?:nfs\d*|cifs|smb\d*|fuse\.|sshfs|9p)$/.test(best.type)) return 'remote'
          return 'unknown'
        } catch {
          return 'unknown'
        }
      }
      return 'unknown'
    },
    userPathState() {
      if (host.skipPath || platform !== 'win32') {
        return { exists: process.env.PATH !== undefined, value: process.env.PATH || '', kind: null }
      }
      const ran = invokePowerShell(
        [
          "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $false)",
          'if (-not $key) { exit 3 }',
          "$value = $key.GetValue('Path', $null, 'DoNotExpandEnvironmentNames')",
          'if ($null -eq $value) { exit 3 }',
          "$kind = [string]$key.GetValueKind('Path')",
          '$key.Close()',
          '[Console]::Out.Write((@{ value = [string]$value; kind = $kind } | ConvertTo-Json -Compress))'
        ].join('; ')
      )
      if (ran.status === 3) return { exists: false, value: '', kind: null }
      if (ran.status !== 0) throw new Error(ran.stderr || ran.stdout || 'failed to read user PATH')
      const parsed = JSON.parse(String(ran.stdout || '')) as { value?: unknown; kind?: unknown }
      if (typeof parsed.value !== 'string' || !['String', 'ExpandString'].includes(String(parsed.kind))) {
        throw new Error('user PATH registry state is invalid')
      }
      return { exists: true, value: parsed.value, kind: parsed.kind as 'String' | 'ExpandString' }
    },
    userPath() {
      return host.userPathState().value
    },
    userEnvState(name) {
      if (host.skipPath || platform !== 'win32') {
        const value = process.env[name]
        return value === undefined
          ? { exists: false, value: '', kind: null }
          : { exists: true, value, kind: 'String' }
      }
      const ran = invokePowerShell(
        [
          "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $false)",
          'if (-not $key) { exit 3 }',
          "$value = $key.GetValue($env:SG_ENV_NAME, $null, 'DoNotExpandEnvironmentNames')",
          'if ($null -eq $value) { exit 3 }',
          "$kind = [string]$key.GetValueKind($env:SG_ENV_NAME)",
          '$key.Close()',
          '[Console]::Out.Write((@{ value = [string]$value; kind = $kind } | ConvertTo-Json -Compress))'
        ].join('; '),
        { SG_ENV_NAME: name }
      )
      if (ran.status === 3) return { exists: false, value: '', kind: null }
      if (ran.status !== 0) throw new Error(ran.stderr || ran.stdout || `failed to read ${name}`)
      const parsed = JSON.parse(String(ran.stdout || '')) as { value?: unknown; kind?: unknown }
      if (typeof parsed.value !== 'string' || !['String', 'ExpandString'].includes(String(parsed.kind))) {
        throw new Error(`user environment registry state is invalid: ${name}`)
      }
      return { exists: true, value: parsed.value, kind: parsed.kind as 'String' | 'ExpandString' }
    },
    userEnv(name) {
      const state = host.userEnvState(name)
      return state.exists ? state.value : undefined
    },
    integrationSnapshot(environmentNames, taskName) {
      if (platform !== 'win32') throw new Error('integrationSnapshot is Windows-only')
      const names = validateIntegrationEnvironmentNames(environmentNames)
      if (typeof taskName !== 'string' || taskName.includes('\0')) {
        throw new Error('integration snapshot task name is invalid')
      }
      const ran = invokePowerShell(
        [
          "$ErrorActionPreference = 'Stop'",
          '$environmentNames = @(($env:SG_ENV_NAMES_JSON | ConvertFrom-Json) | ForEach-Object { $_ })',
          "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $false)",
          'function Read-UserEnvironmentState([string]$name) {',
          "  if (-not $key) { return @{ exists = $false; value = ''; kind = $null } }",
          "  $value = $key.GetValue($name, $null, 'DoNotExpandEnvironmentNames')",
          "  if ($null -eq $value) { return @{ exists = $false; value = ''; kind = $null } }",
          '  $kind = [string]$key.GetValueKind($name)',
          '  return @{ exists = $true; value = [string]$value; kind = $kind }',
          '}',
          'try {',
          "  $userPath = Read-UserEnvironmentState 'Path'",
          '  $environment = @{}',
          '  foreach ($name in $environmentNames) {',
          '    $environment[[string]$name] = Read-UserEnvironmentState ([string]$name)',
          '  }',
          '} finally {',
          '  if ($key) { $key.Close() }',
          '}',
          "$taskState = @{ exists = $false; action = '' }",
          'if (-not [string]::IsNullOrEmpty($env:SG_TASK_NAME)) {',
          '  $task = $null',
          '  try {',
          "    $tasks = @(Get-ScheduledTask -TaskPath '\\' -TaskName $env:SG_TASK_NAME -ErrorAction Stop)",
          "    if ($tasks.Count -ne 1) { throw 'ambiguous root scheduled task result' }",
          '    $task = $tasks[0]',
          '  } catch {',
          '    $notFound = [string]$_.FullyQualifiedErrorId -match "^(NoMatchingMSFT_Task|CmdletizationQuery_NotFound)"',
          '    if (-not $notFound) { [Console]::Error.Write([string]$_.Exception.Message); exit 10 }',
          '  }',
          '  if ($task) {',
          '    $actions = @($task.Actions)',
          '    $triggers = @($task.Triggers)',
          '    $action = $actions[0]',
          '    $trigger = $triggers[0]',
          '    $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
          '    try { $principalSid = ([System.Security.Principal.NTAccount]$task.Principal.UserId).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $principalSid = "" }',
          '    try { $triggerSid = ([System.Security.Principal.NTAccount]$trigger.UserId).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $triggerSid = "" }',
          '    $shape = $actions.Count -eq 1 -and $triggers.Count -eq 1',
          '    $shape = $shape -and $trigger.CimClass.CimClassName -eq "MSFT_TaskLogonTrigger" -and $trigger.Delay -eq "PT15S"',
          '    $shape = $shape -and $principalSid -eq $currentSid -and $triggerSid -eq $currentSid',
          '    $shape = $shape -and [string]$task.Principal.LogonType -eq "Interactive" -and [string]$task.Principal.RunLevel -eq "Limited"',
          '    $shape = $shape -and $task.Settings.Enabled -and $trigger.Enabled',
          '    $shape = $shape -and $task.Settings.Hidden -and $task.Settings.StartWhenAvailable',
          '    $shape = $shape -and (-not $task.Settings.DisallowStartIfOnBatteries) -and (-not $task.Settings.StopIfGoingOnBatteries)',
          '    $shape = $shape -and (-not $task.Settings.IdleSettings.StopOnIdleEnd)',
          '    $shape = $shape -and [string]$task.Settings.MultipleInstances -eq "IgnoreNew" -and $task.Settings.RestartCount -eq 3',
          '    $shape = $shape -and $task.Settings.RestartInterval -eq "PT1M" -and $task.Settings.ExecutionTimeLimit -eq "PT0S"',
          '    $shape = $shape -and [string]$action.WorkingDirectory -eq ""',
          '    $taskAction = if ($shape) { ([string]$action.Execute) + [char]0 + ([string]$action.Arguments) } else { "__FOREIGN_TASK_SHAPE__" }',
          '    $taskState = @{ exists = $true; action = $taskAction }',
          '  }',
          '}',
          '$result = @{ schemaVersion = 1; userPath = $userPath; environment = $environment; task = $taskState }',
          '[Console]::Out.Write(($result | ConvertTo-Json -Compress -Depth 6))'
        ].join('\n'),
        { SG_ENV_NAMES_JSON: JSON.stringify(names), SG_TASK_NAME: taskName }
      )
      const stderr = String(ran.stderr || '').trim()
      if (ran.status !== 0 || stderr) {
        throw new Error(stderr || ran.stdout || 'failed to read Windows integration snapshot')
      }
      return parseInstallHostIntegrationSnapshot(ran.stdout, names, taskName)
    },
    setUserPath(value) {
      if (host.skipPath) return
      if (platform !== 'win32') {
        return
      }
      const ran = invokePowerShell(
        [
          "$newPath = $env:SG_PATH_VALUE",
          "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)",
          "if (-not $key) { throw 'cannot open HKCU\\Environment' }",
          "$kind = [Microsoft.Win32.RegistryValueKind]::ExpandString",
          "try { $kind = $key.GetValueKind('Path') } catch {}",
          "$key.SetValue('Path', $newPath, $kind)",
          "$key.Close()"
        ].join('; '),
        { SG_PATH_VALUE: value }
      )
      if (ran.status !== 0) throw new Error(ran.stderr || ran.stdout || 'failed to set user PATH')
    },
    setUserEnv(name, value) {
      if (host.skipPath) return
      if (platform !== 'win32') return
      const ran = invokePowerShell(
        value === null
          ? `[Environment]::SetEnvironmentVariable($env:SG_ENV_NAME, $null, 'User')`
          : `[Environment]::SetEnvironmentVariable($env:SG_ENV_NAME, $env:SG_ENV_VALUE, 'User')`,
        { SG_ENV_NAME: name, SG_ENV_VALUE: value || '' }
      )
      if (ran.status !== 0) throw new Error(ran.stderr || ran.stdout || `failed to set ${name}`)
    },
    broadcastEnv() {
      if (host.skipPath || platform !== 'win32') return
      invokePowerShell(
        [
          "Add-Type -TypeDefinition @'",
          'using System;',
          'using System.Runtime.InteropServices;',
          'public class SgBroadcast {',
          '  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)]',
          '  public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);',
          '}',
          "'@",
          '$result = [UIntPtr]::Zero',
          '[void][SgBroadcast]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, "Environment", 2, 5000, [ref]$result)'
        ].join('\n')
      )
    },
    extraShimDir() {
      if (platform !== 'win32') return null
      const dir = path.join(process.env.APPDATA || '', 'npm')
      return fs.existsSync(dir) ? dir : null
    },
    taskExists(name) {
      if (host.skipTask) return false
      if (platform !== 'win32') return false
      const ran = invokePowerShell(
        [
          "try { $tasks = @(Get-ScheduledTask -TaskPath '\\' -TaskName $env:SG_TASK_NAME -ErrorAction Stop); if ($tasks.Count -ne 1) { throw 'ambiguous root scheduled task result' }; $task = $tasks[0] } catch {",
          '  $notFound = [string]$_.FullyQualifiedErrorId -match "^(NoMatchingMSFT_Task|CmdletizationQuery_NotFound)"',
          '  if ($notFound) { exit 3 }',
          '  [Console]::Error.Write([string]$_.Exception.Message); exit 10',
          '}',
          'exit 0'
        ].join('\n'),
        { SG_TASK_NAME: name }
      )
      if (ran.status === 3) return false
      if (ran.status !== 0) throw new Error(ran.stderr || ran.stdout || `failed to inspect scheduled task ${name}`)
      return true
    },
    compareExchangeUserPath(expected, next) {
      if (host.skipPath || platform !== 'win32') throw new Error('persistent user PATH compare-exchange is unavailable')
      const ran = invokePowerShell([
        "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)",
        "if (-not $key) { throw 'cannot open HKCU\\Environment' }",
        "$current = $key.GetValue('Path', $null, 'DoNotExpandEnvironmentNames')",
        '$currentExists = $null -ne $current',
        "$currentKind = if ($currentExists) { [string]$key.GetValueKind('Path') } else { '' }",
        '$expectedExists = $env:SG_EXPECTED_EXISTS -eq "1"',
        '$matches = $currentExists -eq $expectedExists',
        '$matches = $matches -and (-not $currentExists -or ([string]$current -ceq $env:SG_EXPECTED_VALUE -and $currentKind -ceq $env:SG_EXPECTED_KIND))',
        'if (-not $matches) { $key.Close(); exit 4 }',
        '$nextExists = $env:SG_NEXT_EXISTS -eq "1"',
        'if ($nextExists) {',
        '  $nextKind = [System.Enum]::Parse([Microsoft.Win32.RegistryValueKind], $env:SG_NEXT_KIND)',
        "  $key.SetValue('Path', $env:SG_NEXT_VALUE, $nextKind)",
        '} else {',
        "  $key.DeleteValue('Path', $false)",
        '}',
        "$after = $key.GetValue('Path', $null, 'DoNotExpandEnvironmentNames')",
        '$afterExists = $null -ne $after',
        "$afterKind = if ($afterExists) { [string]$key.GetValueKind('Path') } else { '' }",
        '$post = $afterExists -eq $nextExists',
        '$post = $post -and (-not $afterExists -or ([string]$after -ceq $env:SG_NEXT_VALUE -and $afterKind -ceq $env:SG_NEXT_KIND))',
        '$key.Close()',
        'if (-not $post) { exit 5 }'
      ].join('\n'), {
        SG_EXPECTED_EXISTS: expected.exists ? '1' : '0',
        SG_EXPECTED_VALUE: expected.value,
        SG_EXPECTED_KIND: expected.kind || '',
        SG_NEXT_EXISTS: next.exists ? '1' : '0',
        SG_NEXT_VALUE: next.value,
        SG_NEXT_KIND: next.kind || ''
      })
      if (ran.status === 4) return false
      if (ran.status !== 0) throw new Error(ran.stderr || ran.stdout || 'failed to compare-exchange user PATH')
      return true
    },
    compareExchangeUserEnv(name, expected, next) {
      if (host.skipPath || platform !== 'win32') throw new Error('persistent user environment compare-exchange is unavailable')
      const ran = invokePowerShell([
        "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)",
        "if (-not $key) { throw 'cannot open HKCU\\Environment' }",
        "$current = $key.GetValue($env:SG_ENV_NAME, $null, 'DoNotExpandEnvironmentNames')",
        '$currentExists = $null -ne $current',
        "$currentKind = if ($currentExists) { [string]$key.GetValueKind($env:SG_ENV_NAME) } else { '' }",
        '$expectedExists = $env:SG_EXPECTED_EXISTS -eq "1"',
        '$matches = $currentExists -eq $expectedExists',
        '$matches = $matches -and (-not $currentExists -or ([string]$current -ceq $env:SG_EXPECTED_VALUE -and $currentKind -ceq $env:SG_EXPECTED_KIND))',
        'if (-not $matches) { $key.Close(); exit 4 }',
        '$nextExists = $env:SG_NEXT_EXISTS -eq "1"',
        'if ($nextExists) {',
        '  $nextKind = [System.Enum]::Parse([Microsoft.Win32.RegistryValueKind], $env:SG_NEXT_KIND)',
        '  $key.SetValue($env:SG_ENV_NAME, $env:SG_NEXT_VALUE, $nextKind)',
        '} else {',
        '  $key.DeleteValue($env:SG_ENV_NAME, $false)',
        '}',
        "$after = $key.GetValue($env:SG_ENV_NAME, $null, 'DoNotExpandEnvironmentNames')",
        '$afterExists = $null -ne $after',
        "$afterKind = if ($afterExists) { [string]$key.GetValueKind($env:SG_ENV_NAME) } else { '' }",
        '$post = $afterExists -eq $nextExists -and (-not $afterExists -or ([string]$after -ceq $env:SG_NEXT_VALUE -and $afterKind -ceq $env:SG_NEXT_KIND))',
        '$key.Close()',
        'if (-not $post) { exit 5 }'
      ].join('\n'), {
        SG_ENV_NAME: name,
        SG_EXPECTED_EXISTS: expected.exists ? '1' : '0',
        SG_EXPECTED_VALUE: expected.value,
        SG_EXPECTED_KIND: expected.kind || '',
        SG_NEXT_EXISTS: next.exists ? '1' : '0',
        SG_NEXT_VALUE: next.value,
        SG_NEXT_KIND: next.kind || ''
      })
      if (ran.status === 4) return false
      if (ran.status !== 0) throw new Error(ran.stderr || ran.stdout || `failed to compare-exchange ${name}`)
      return true
    },
    taskAction(name) {
      if (host.skipTask || platform !== 'win32') return ''
      const ran = invokePowerShell(
        [
          "try { $tasks = @(Get-ScheduledTask -TaskPath '\\' -TaskName $env:SG_TASK_NAME -ErrorAction Stop); if ($tasks.Count -ne 1) { throw 'ambiguous root scheduled task result' }; $task = $tasks[0] } catch {",
          '  $notFound = [string]$_.FullyQualifiedErrorId -match "^(NoMatchingMSFT_Task|CmdletizationQuery_NotFound)"',
          '  if ($notFound) { exit 3 }',
          '  [Console]::Error.Write([string]$_.Exception.Message); exit 10',
          '}',
          '$actions = @($task.Actions)',
          '$triggers = @($task.Triggers)',
          '$action = $actions[0]',
          '$trigger = $triggers[0]',
          '$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
          'try { $principalSid = ([System.Security.Principal.NTAccount]$task.Principal.UserId).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $principalSid = "" }',
          'try { $triggerSid = ([System.Security.Principal.NTAccount]$trigger.UserId).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $triggerSid = "" }',
          '$shape = $actions.Count -eq 1 -and $triggers.Count -eq 1',
          '$shape = $shape -and $trigger.CimClass.CimClassName -eq "MSFT_TaskLogonTrigger" -and $trigger.Delay -eq "PT15S"',
          '$shape = $shape -and $principalSid -eq $currentSid -and $triggerSid -eq $currentSid',
          '$shape = $shape -and [string]$task.Principal.LogonType -eq "Interactive" -and [string]$task.Principal.RunLevel -eq "Limited"',
          '$shape = $shape -and $task.Settings.Enabled -and $trigger.Enabled',
          '$shape = $shape -and $task.Settings.Hidden -and $task.Settings.StartWhenAvailable',
          '$shape = $shape -and (-not $task.Settings.DisallowStartIfOnBatteries) -and (-not $task.Settings.StopIfGoingOnBatteries)',
          '$shape = $shape -and (-not $task.Settings.IdleSettings.StopOnIdleEnd)',
          '$shape = $shape -and [string]$task.Settings.MultipleInstances -eq "IgnoreNew" -and $task.Settings.RestartCount -eq 3',
          '$shape = $shape -and $task.Settings.RestartInterval -eq "PT1M" -and $task.Settings.ExecutionTimeLimit -eq "PT0S"',
          '$shape = $shape -and [string]$action.WorkingDirectory -eq ""',
          'if (-not $shape) { [Console]::Out.Write("__FOREIGN_TASK_SHAPE__"); exit 0 }',
          '[Console]::Out.Write(([string]$action.Execute) + [char]0 + ([string]$action.Arguments))'
        ].join('; '),
        { SG_TASK_NAME: name }
      )
      if (ran.status === 3) return ''
      if (ran.status !== 0) throw new Error(ran.stderr || ran.stdout || `failed to inspect scheduled task ${name}`)
      return String(ran.stdout || '').replace(/\r?\n$/, '')
    },
    registerLogonTask(taskName, vbsPath) {
      if (host.skipTask) return
      if (platform !== 'win32') return
      const ran = invokePowerShell(
        [
          "try { $existing = @(Get-ScheduledTask -TaskPath '\\' -TaskName $env:SG_TASK_NAME -ErrorAction Stop); if ($existing.Count -gt 0) { exit 4 } } catch {",
          '  $notFound = [string]$_.FullyQualifiedErrorId -match "^(NoMatchingMSFT_Task|CmdletizationQuery_NotFound)"',
          '  if (-not $notFound) { [Console]::Error.Write([string]$_.Exception.Message); exit 10 }',
          '}',
          '$taskName = $env:SG_TASK_NAME',
          '$vbs = $env:SG_VBS',
          "$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('\"' + $vbs + '\"')",
          '$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited',
          '$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd -MultipleInstances IgnoreNew -Hidden -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable',
          '$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME',
          "$trigger.Delay = 'PT15S'",
          "Register-ScheduledTask -TaskPath '\\' -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null"
        ].join('; '),
        { SG_TASK_NAME: taskName, SG_VBS: vbsPath }
      )
      if (ran.status === 4) throw new Error(`refusing to adopt existing scheduled task ${taskName}`)
      if (ran.status !== 0) {
        if (host.taskExists(taskName)) throw new Error(`refusing raced foreign scheduled task ${taskName}`)
        throw new Error(ran.stderr || ran.stdout || 'failed to register logon task')
      }
      if (!host.taskExists(taskName)
        || host.taskAction(taskName).toLowerCase() !== expectedTaskAction(vbsPath).toLowerCase()) {
        throw new Error(`scheduled task ${taskName} failed strict ownership verification`)
      }
    },
    stopScheduledTaskInstance(taskName, expectedVbsPath) {
      if (host.skipTask) throw new Error('scheduled task provider is disabled')
      if (platform !== 'win32') return
      const ran = invokePowerShell([
        "try { $tasks = @(Get-ScheduledTask -TaskPath '\\' -TaskName $env:SG_TASK_NAME -ErrorAction Stop); if ($tasks.Count -ne 1) { throw 'ambiguous root scheduled task result' }; $task = $tasks[0] } catch {",
        '  $notFound = [string]$_.FullyQualifiedErrorId -match "^(NoMatchingMSFT_Task|CmdletizationQuery_NotFound)"',
        '  if ($notFound) { exit 3 }',
        '  [Console]::Error.Write([string]$_.Exception.Message); exit 10',
        '}',
        '$actions = @($task.Actions)',
        '$triggers = @($task.Triggers)',
        '$action = $actions[0]',
        '$trigger = $triggers[0]',
        '$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
        'try { $principalSid = ([System.Security.Principal.NTAccount]$task.Principal.UserId).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $principalSid = "" }',
        'try { $triggerSid = ([System.Security.Principal.NTAccount]$trigger.UserId).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $triggerSid = "" }',
        '$shape = $actions.Count -eq 1 -and $triggers.Count -eq 1',
        '$shape = $shape -and ([string]$action.Execute).ToLowerInvariant() -eq "wscript.exe"',
        '$shape = $shape -and [string]$action.Arguments -eq ("`"" + $env:SG_VBS + "`"") -and [string]$action.WorkingDirectory -eq ""',
        '$shape = $shape -and $trigger.CimClass.CimClassName -eq "MSFT_TaskLogonTrigger" -and $trigger.Delay -eq "PT15S"',
        '$shape = $shape -and $principalSid -eq $currentSid -and $triggerSid -eq $currentSid',
        '$shape = $shape -and [string]$task.Principal.LogonType -eq "Interactive" -and [string]$task.Principal.RunLevel -eq "Limited"',
        '$shape = $shape -and $task.Settings.Enabled -and $trigger.Enabled',
        '$shape = $shape -and $task.Settings.Hidden -and $task.Settings.StartWhenAvailable',
        '$shape = $shape -and (-not $task.Settings.DisallowStartIfOnBatteries) -and (-not $task.Settings.StopIfGoingOnBatteries)',
        '$shape = $shape -and (-not $task.Settings.IdleSettings.StopOnIdleEnd)',
        '$shape = $shape -and [string]$task.Settings.MultipleInstances -eq "IgnoreNew" -and $task.Settings.RestartCount -eq 3',
        '$shape = $shape -and $task.Settings.RestartInterval -eq "PT1M" -and $task.Settings.ExecutionTimeLimit -eq "PT0S"',
        'if (-not $shape) { exit 4 }',
        'if ([string]$task.State -ne "Ready") {',
        "  Stop-ScheduledTask -TaskPath '\\' -TaskName $env:SG_TASK_NAME -ErrorAction Stop",
        '  $deadline = [DateTime]::UtcNow.AddSeconds(5)',
        '  do {',
        "    $after = @(Get-ScheduledTask -TaskPath '\\' -TaskName $env:SG_TASK_NAME -ErrorAction Stop)",
        '    if ($after.Count -ne 1) { exit 5 }',
        '    if ([string]$after[0].State -eq "Ready") { break }',
        '    Start-Sleep -Milliseconds 100',
        '  } while ([DateTime]::UtcNow -lt $deadline)',
        '  if ([string]$after[0].State -ne "Ready") { exit 5 }',
        '}'
      ].join('\n'), { SG_TASK_NAME: taskName, SG_VBS: expectedVbsPath })
      if (ran.status === 3) throw new Error(`scheduled task ${taskName} disappeared before its running instance could be stopped`)
      if (ran.status === 4) throw new Error(`refusing to stop foreign scheduled task ${taskName}`)
      if (ran.status === 5) throw new Error(`scheduled task ${taskName} did not reach the ready state after stop`)
      if (ran.status !== 0) throw new Error(ran.stderr || ran.stdout || `failed to stop scheduled task ${taskName}`)
      if (!host.taskExists(taskName)
        || host.taskAction(taskName).toLowerCase() !== expectedTaskAction(expectedVbsPath).toLowerCase()) {
        throw new Error(`scheduled task ${taskName} changed while stopping its running instance`)
      }
    },
    unregisterTask(taskName, expectedVbsPath) {
      if (host.skipTask) return
      if (platform !== 'win32') return
      const ran = invokePowerShell([
        "try { $tasks = @(Get-ScheduledTask -TaskPath '\\' -TaskName $env:SG_TASK_NAME -ErrorAction Stop); if ($tasks.Count -ne 1) { throw 'ambiguous root scheduled task result' }; $task = $tasks[0] } catch {",
          '  $notFound = [string]$_.FullyQualifiedErrorId -match "^(NoMatchingMSFT_Task|CmdletizationQuery_NotFound)"',
        '  if ($notFound) { exit 0 }',
        '  [Console]::Error.Write([string]$_.Exception.Message); exit 10',
        '}',
        '$actions = @($task.Actions)',
        '$triggers = @($task.Triggers)',
        '$action = $actions[0]',
        '$trigger = $triggers[0]',
        '$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
        'try { $principalSid = ([System.Security.Principal.NTAccount]$task.Principal.UserId).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $principalSid = "" }',
        'try { $triggerSid = ([System.Security.Principal.NTAccount]$trigger.UserId).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $triggerSid = "" }',
        '$shape = $actions.Count -eq 1 -and $triggers.Count -eq 1',
        '$shape = $shape -and ([string]$action.Execute).ToLowerInvariant() -eq "wscript.exe"',
        '$shape = $shape -and [string]$action.Arguments -eq ("`"" + $env:SG_VBS + "`"") -and [string]$action.WorkingDirectory -eq ""',
        '$shape = $shape -and $trigger.CimClass.CimClassName -eq "MSFT_TaskLogonTrigger" -and $trigger.Delay -eq "PT15S"',
        '$shape = $shape -and $principalSid -eq $currentSid -and $triggerSid -eq $currentSid',
        '$shape = $shape -and [string]$task.Principal.LogonType -eq "Interactive" -and [string]$task.Principal.RunLevel -eq "Limited"',
        '$shape = $shape -and $task.Settings.Enabled -and $trigger.Enabled',
        '$shape = $shape -and $task.Settings.Hidden -and $task.Settings.StartWhenAvailable',
        '$shape = $shape -and (-not $task.Settings.DisallowStartIfOnBatteries) -and (-not $task.Settings.StopIfGoingOnBatteries)',
        '$shape = $shape -and (-not $task.Settings.IdleSettings.StopOnIdleEnd)',
        '$shape = $shape -and [string]$task.Settings.MultipleInstances -eq "IgnoreNew" -and $task.Settings.RestartCount -eq 3',
        '$shape = $shape -and $task.Settings.RestartInterval -eq "PT1M" -and $task.Settings.ExecutionTimeLimit -eq "PT0S"',
        'if (-not $shape) { exit 4 }',
        "Unregister-ScheduledTask -TaskPath '\\' -TaskName $env:SG_TASK_NAME -Confirm:$false -ErrorAction Stop",
        "try { $remaining = @(Get-ScheduledTask -TaskPath '\\' -TaskName $env:SG_TASK_NAME -ErrorAction Stop); if ($remaining.Count -gt 0) { exit 5 } } catch {",
          '  $notFound = [string]$_.FullyQualifiedErrorId -match "^(NoMatchingMSFT_Task|CmdletizationQuery_NotFound)"',
        '  if (-not $notFound) { [Console]::Error.Write([string]$_.Exception.Message); exit 10 }',
        '}'
      ].join('\n'), { SG_TASK_NAME: taskName, SG_VBS: expectedVbsPath || '' })
      if (ran.status === 4) throw new Error(`refusing to remove foreign scheduled task ${taskName}`)
      if (ran.status !== 0) throw new Error(ran.stderr || ran.stdout || `failed to unregister ${taskName}`)
    },
    pidAlive(pid) {
      if (!pid || pid <= 0) return false
      try {
        process.kill(pid, 0)
        return true
      } catch (error) {
        // Only an explicit no-such-process result proves absence. EPERM/access
        // denial is a live or unverifiable cross-user process and must remain
        // visible to the lifecycle ownership checks so they fail closed.
        return (error as NodeJS.ErrnoException).code !== 'ESRCH'
      }
    },
    processCommandLine(pid) {
      if (!pid || pid <= 0) return ''
      if (platform === 'win32') {
      const ran = invokePowerShell(
          [
            '$processId = [int]$env:SG_PROCESS_ID',
            '$process = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId=" + $processId) -ErrorAction SilentlyContinue',
            'if ($process) { [Console]::Out.Write([string]$process.CommandLine) }'
          ].join('; '),
          { SG_PROCESS_ID: String(pid) }
        )
        return ran.status === 0 ? String(ran.stdout || '').trim() : ''
      }
      if (platform === 'linux') {
        try {
          return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim()
        } catch {
          return ''
        }
      }
      const ran = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
        encoding: 'utf8',
        windowsHide: true
      })
      return ran.status === 0 ? String(ran.stdout || '').trim() : ''
    },
    killPid(pid) {
      if (!pid || pid <= 0) return true
      if (platform === 'win32') {
        const ran = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
          encoding: 'utf8',
          windowsHide: true
        })
        return ran.status === 0 || !host.pidAlive(pid)
      }
      try {
        process.kill(pid, 'SIGTERM')
        return true
      } catch {
        return !host.pidAlive(pid)
      }
    },
    waitForPidsExit(pids, timeoutMs) {
      const targets = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))]
      if (targets.length === 0) return true
      const deadline = Date.now() + Math.max(0, timeoutMs)
      const waiter = new Int32Array(new SharedArrayBuffer(4))
      while (targets.some((pid) => host.pidAlive(pid))) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) return false
        Atomics.wait(waiter, 0, 0, Math.min(50, remaining))
      }
      return true
    },
    wmiCreate(commandLine, cwd) {
      if (platform !== 'win32') {
        throw new Error('wmiCreate is Windows-only; use launchDetached for POSIX hosts')
      }
      const ps = [
        '$startup = New-CimInstance -ClassName Win32_ProcessStartup -Namespace root\\cimv2 -ClientOnly -Property @{ ShowWindow = [uint16]0 }',
        '$created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:SG_WMI_CMD; CurrentDirectory = $env:SG_WMI_CWD; ProcessStartupInformation = $startup }',
        'if (-not $created -or [int]$created.ReturnValue -ne 0 -or -not $created.ProcessId) {',
        '  $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:SG_WMI_CMD; CurrentDirectory = $env:SG_WMI_CWD }',
        '}',
        'if (-not $created -or [int]$created.ReturnValue -ne 0 -or -not $created.ProcessId) { Write-Error "WMI create failed $($created.ReturnValue)"; exit 1 }',
        'Write-Output $created.ProcessId'
      ].join('; ')
      const launched = invokeSpawnSync('powershell.exe', [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-Command', ps
      ], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: WMI_CREATE_TIMEOUT_MS,
        env: { ...process.env, SG_WMI_CMD: commandLine, SG_WMI_CWD: cwd }
      })
      if (launched.error) {
        throw new Error(`WMI create PowerShell launch failed: ${launched.error.message}`, { cause: launched.error })
      }
      const stderr = String(launched.stderr || '').trim()
      if (launched.signal) {
        throw new Error(`WMI create PowerShell terminated by signal ${launched.signal}${stderr ? `: ${stderr}` : ''}`)
      }
      if (launched.status !== 0) {
        throw new Error(`WMI create PowerShell exited with status ${String(launched.status)}${stderr ? `: ${stderr}` : ''}`)
      }
      if (stderr) throw new Error(`WMI create PowerShell reported stderr: ${stderr}`)

      const stdout = String(launched.stdout || '').trim()
      if (!/^[1-9][0-9]*$/.test(stdout)) {
        throw new Error('WMI create PowerShell returned an invalid process id')
      }
      const pid = Number(stdout)
      if (!Number.isSafeInteger(pid)) {
        throw new Error('WMI create PowerShell returned an invalid process id')
      }
      return pid
    },
    launchDetached(command, args, opts) {
      const launched = spawn(command, [...args], {
        cwd: opts.cwd,
        // Callers provide a complete, policy-reviewed environment. Merging here
        // would silently reintroduce aliases or trace variables they removed.
        env: opts.env,
        detached: true,
        shell: false,
        stdio: 'ignore',
        windowsHide: true
      })
      launched.once('error', () => {
        // Health acceptance remains authoritative; avoid an unhandled child error.
      })
      launched.unref()
      return Number(launched.pid || 0)
    },
    run(command, args, opts = {}) {
      const ran = spawnSync(command, args, {
        cwd: opts.cwd,
        encoding: 'utf8',
        windowsHide: true,
        timeout: opts.timeout,
        env: opts.env ? { ...process.env, ...opts.env } : process.env
      })
      return { status: ran.status ?? 1, stdout: String(ran.stdout || ''), stderr: String(ran.stderr || '') }
    },
    runNpm(args, cwd, timeout = 600000) {
      if (platform === 'win32') {
        return host.run('cmd.exe', ['/c', 'npm', ...args], { cwd, timeout })
      }
      return host.run('npm', args, { cwd, timeout })
    },
    ...overrides
  }
  return host
}

export function defaultTaskName() {
  return TASK_NAME
}

function runPowerShell(command: string, extraEnv: Record<string, string> = {}): CommandResult {
  const ran = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...extraEnv }
  })
  return { status: ran.status ?? 1, stdout: String(ran.stdout || ''), stderr: String(ran.stderr || '') }
}
