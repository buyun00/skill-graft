import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { dirname, join } from 'node:path'
import type { LocalHostContext as HubContext } from '../../adapters/host-context.js'
import { sessionExitFile } from './legacy-sessions.js'
import type { HubSession } from './types.js'

export const DEFAULT_RUNNER_PROFILE = 'gpt-5.6-luna'
export const DEFAULT_RUNNER_QUALITY = 'max'

export type LocalRunnerStart = {
  session: HubSession
  prompt: string
  continuationToken?: string
  profile?: string
  quality?: string
}

export type LocalSessionRunner = {
  enabled(): boolean
  available(): boolean
  start(input: LocalRunnerStart): number
  pidAlive(pid: number): boolean
}

export type LocalSessionRunnerOptions = {
  environment?: NodeJS.ProcessEnv
  executable?: string
  codexModule?: string
  spawn?: typeof spawnSync
}

function quoteCmd(value: string) {
  return `"${String(value).replace(/"/g, '')}"`
}

export function createCodexSessionRunner(
  ctx: HubContext,
  options: LocalSessionRunnerOptions = {}
): LocalSessionRunner {
  const env = options.environment || process.env
  const executable = options.executable || process.execPath
  const codexModule = options.codexModule || join(env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
  const launch = options.spawn || spawnSync

  return {
    enabled() {
      return env.HUB_SPAWN_CODEX !== '0'
    },
    available() {
      return fs.existsSync(codexModule)
    },
    start(input) {
      const { session } = input
      const profile = input.profile || session.model || env.HUB_CODEX_MODEL || DEFAULT_RUNNER_PROFILE
      const quality = input.quality || session.effort || env.HUB_CODEX_EFFORT || DEFAULT_RUNNER_QUALITY
      const promptFile = input.continuationToken
        ? join(ctx.hubRoot, 'skill-review', `resume-${session.id}.txt`)
        : session.promptFile
      if (input.continuationToken) fs.writeFileSync(promptFile, input.prompt, 'utf8')
      const args = [
        'exec',
        '-C', ctx.hubRoot,
        '--skip-git-repo-check',
        '--color', 'never',
        '--sandbox', 'danger-full-access',
        '--dangerously-bypass-approvals-and-sandbox',
        '-m', profile,
        '-c', `model_reasoning_effort=${quality}`
      ]
      if (session.worktree) args.push('--add-dir', session.worktree)
      if (input.continuationToken) args.push('resume', input.continuationToken)
      args.push('-o', session.lastFile, '-')
      fs.mkdirSync(dirname(session.logFile), { recursive: true })
      const runner = join(ctx.hubRoot, 'skill-review', `run-codex-${session.id}.cmd`)
      const line = [
        quoteCmd(executable),
        quoteCmd(codexModule),
        ...args.map(quoteCmd),
        '<', quoteCmd(promptFile),
        '>>', quoteCmd(session.logFile),
        '2>&1'
      ].join(' ')
      const exitFile = sessionExitFile(ctx, session)
      fs.writeFileSync(
        runner,
        `@echo off\r\nchcp 65001 >nul\r\ncd /d ${quoteCmd(ctx.hubRoot)}\r\n${line}\r\necho %ERRORLEVEL%>${quoteCmd(exitFile)}\r\n`,
        'utf8'
      )
      const ps = [
        `$created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'cmd.exe /c "${runner.replace(/'/g, "''")}"'; CurrentDirectory = '${ctx.hubRoot.replace(/'/g, "''")}' }`,
        'if ([int]$created.ReturnValue -ne 0 -or -not $created.ProcessId) { Write-Error "WMI create failed $($created.ReturnValue)"; exit 1 }',
        'Write-Output $created.ProcessId'
      ].join('; ')
      const launched = launch('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
        encoding: 'utf8',
        windowsHide: true
      })
      const pid = Number(String(launched.stdout || '').trim())
      if (!pid) {
        fs.appendFileSync(session.logFile, `\n[spawn error] ${launched.stderr || launched.stdout || 'WMI create failed'}\n`)
      }
      return pid || 0
    },
    pidAlive(pid) {
      if (!pid || pid <= 0) return false
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
  }
}
