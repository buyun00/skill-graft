import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TASK_NAME } from '../core/install.js'

export type CommandResult = {
  status: number
  stdout: string
  stderr: string
}

export interface InstallHost {
  platform: string
  home: string
  localAppData: string
  pathSep: string
  caseInsensitive: boolean
  skipPath: boolean
  skipTask: boolean
  env(name: string): string | undefined
  which(command: string): string
  commandVersion(bin: string): string
  userPath(): string
  setUserPath(value: string): void
  setUserEnv(name: string, value: string | null): void
  broadcastEnv(): void
  extraShimDir(): string | null
  taskExists(name: string): boolean
  registerLogonTask(taskName: string, vbsPath: string): void
  unregisterTask(taskName: string): void
  pidAlive(pid: number): boolean
  killPid(pid: number): void
  wmiCreate(commandLine: string, cwd: string): number
  run(command: string, args: string[], opts?: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv }): CommandResult
  runNpm(args: string[], cwd: string, timeout?: number): CommandResult
}

export function createInstallHost(overrides: Partial<InstallHost> = {}): InstallHost {
  const platform = process.platform
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
    userPath() {
      if (host.skipPath) return process.env.PATH || ''
      if (platform !== 'win32') return process.env.PATH || ''
      const ran = runPowerShell(
        `$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $false); if (-not $key) { return }; $value = $key.GetValue('Path', '', 'DoNotExpandEnvironmentNames'); $key.Close(); [Console]::Out.Write($value)`
      )
      return String(ran.stdout || '').replace(/\r?\n$/, '')
    },
    setUserPath(value) {
      if (host.skipPath) return
      if (platform !== 'win32') {
        return
      }
      const ran = runPowerShell(
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
      const ran = runPowerShell(
        value === null
          ? `[Environment]::SetEnvironmentVariable($env:SG_ENV_NAME, $null, 'User')`
          : `[Environment]::SetEnvironmentVariable($env:SG_ENV_NAME, $env:SG_ENV_VALUE, 'User')`,
        { SG_ENV_NAME: name, SG_ENV_VALUE: value || '' }
      )
      if (ran.status !== 0) throw new Error(ran.stderr || ran.stdout || `failed to set ${name}`)
    },
    broadcastEnv() {
      if (host.skipPath || platform !== 'win32') return
      runPowerShell(
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
      const ran = spawnSync('schtasks.exe', ['/Query', '/TN', name], { encoding: 'utf8', windowsHide: true })
      return ran.status === 0
    },
    registerLogonTask(taskName, vbsPath) {
      if (host.skipTask) return
      if (platform !== 'win32') return
      const ran = runPowerShell(
        [
          '$taskName = $env:SG_TASK_NAME',
          '$vbs = $env:SG_VBS',
          "$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('\"' + $vbs + '\"')",
          '$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited',
          '$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd -MultipleInstances IgnoreNew -Hidden -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable',
          '$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME',
          "$trigger.Delay = 'PT15S'",
          'Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null'
        ].join('; '),
        { SG_TASK_NAME: taskName, SG_VBS: vbsPath }
      )
      if (ran.status !== 0) {
        const fallback = spawnSync(
          'schtasks.exe',
          ['/Create', '/TN', taskName, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/IT', '/F', '/TR', `wscript.exe "${vbsPath}"`],
          { encoding: 'utf8', windowsHide: true }
        )
        if (fallback.status !== 0) {
          throw new Error(ran.stderr || fallback.stderr || fallback.stdout || 'failed to register logon task')
        }
      }
    },
    unregisterTask(taskName) {
      if (host.skipTask) return
      if (platform !== 'win32') return
      spawnSync('schtasks.exe', ['/Delete', '/TN', taskName, '/F'], { encoding: 'utf8', windowsHide: true })
    },
    pidAlive(pid) {
      if (!pid || pid <= 0) return false
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    },
    killPid(pid) {
      if (!pid || pid <= 0) return
      if (platform === 'win32') {
        spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true })
        return
      }
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        /* already gone */
      }
    },
    wmiCreate(commandLine, cwd) {
      if (platform !== 'win32') {
        const ran = spawnSync(commandLine, {
          cwd,
          encoding: 'utf8',
          shell: true,
          stdio: 'ignore',
          windowsHide: true
        })
        return Number(ran.pid || 0)
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
      const launched = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, SG_WMI_CMD: commandLine, SG_WMI_CWD: cwd }
      })
      return Number(String(launched.stdout || '').trim()) || 0
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
