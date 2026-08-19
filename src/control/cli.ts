#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHub } from '../adapters/create-hub.js'
import {
  decide,
  emptyIngestResult,
  enqueueSession,
  getStatus,
  listSkills,
  listWorktrees,
  markSessionSpawned,
  parseIngestTransactions,
  repairPlan,
  resumeSession,
  saveSession
} from '../core/index.js'
import type { DecideAction, HubContext, HubSession } from '../core/index.js'
import { formatDoctorReport, formatSetupReport, formatUninstallReport, PRODUCT_ALIAS, PRODUCT_COMMAND } from '../core/install.js'
import { runDaemon, stopDaemon } from './daemon.js'
import { daemonStatus, doctorHub, setupHub, startDaemonDetached, uninstallHub } from './install.js'

function print(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function fail(message: string, code = 1): never {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

function usage(): string {
  return [
    `${PRODUCT_COMMAND} <command>          (also: ${PRODUCT_ALIAS})`,
    '',
    'Install:',
    '  setup [--dry-run] [--json] [--no-daemon] [--no-path] [--no-task] [--rebuild]',
    '                                 One-click: env, sg on PATH, silent keep-alive, logon autostart',
    '  uninstall [--json]             Remove sg, PATH entry, logon task, and the daemon',
    '  doctor [--json]                Check Node/Git/Codex, sg, autostart, and API health',
    '  daemon start|stop|status|run   Keep-alive supervisor for the local HTTP API',
    '',
    'Query:',
    '  status                         Hub inventory, inbox counts, linked game repo',
    '  list-worktrees                 Discover client worktrees under scan-roots',
    '  list-skills                    Resident / adopted / inbox nodes',
    '',
    'Disk (via CLI; first-time attach is a session, not a silent rewrite):',
    '  repair-links --worktree <path> Repair links on an already-attached tree',
    '  ingest [--game-repo <path>] [--dispatch]',
    '                                 Read hook payload on stdin; empty payload is a no-op',
    '  decide --id <id> --action adopt|merge|reject [--note <text>] [--merge-target <rel>]',
    '',
    'Sessions (background Codex; default model gpt-5.6-luna at max effort):',
    '  attach --worktree <path> [--intent <text>] [--model <id>] [--effort <level>] [--no-spawn]',
    '                                 Enqueue and spawn a detached Codex attach conversation.',
    '                                 Codex runs Disable + attach-library. --no-spawn only records the session.',
    '  detach --worktree <path> [--intent <text>] [--no-spawn]',
    '  edit --path <rel> [--intent <text>] [--no-spawn]',
    '  chat [--intent <text>] [--worktree <path>] [--no-spawn]',
    '  resume --id <id> --message <text> [--no-spawn]'
  ].join('\n')
}

function findHubRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return dirname(dirname(here))
}

function takeFlag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  if (index < 0) return undefined
  const value = argv[index + 1]
  if (!value || value.startsWith('-')) fail(`${name} requires a value`)
  argv.splice(index, 2)
  return value
}

function takeSwitch(argv: string[], name: string): boolean {
  const index = argv.indexOf(name)
  if (index < 0) return false
  argv.splice(index, 1)
  return true
}

function readStdin(): string {
  if (process.stdin.isTTY) return ''
  try {
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

function runPs1(name: string, args: string[], input?: string) {
  const root = findHubRoot()
  return spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'overlay', name), ...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    input
  })
}

function codexJs() {
  return join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
}

const DEFAULT_CODEX_MODEL = 'gpt-5.6-luna'
const DEFAULT_CODEX_EFFORT = 'max'

function quoteCmd(value: string) {
  return `"${String(value).replace(/"/g, '')}"`
}

function spawnCodex(ctx: HubContext, session: HubSession, extra: { resumeId?: string; prompt: string }) {
  const model = session.model || process.env.HUB_CODEX_MODEL || DEFAULT_CODEX_MODEL
  const effort = session.effort || process.env.HUB_CODEX_EFFORT || DEFAULT_CODEX_EFFORT
  const promptFile = extra.resumeId
    ? join(ctx.hubRoot, 'skill-review', `resume-${session.id}.txt`)
    : session.promptFile
  if (extra.resumeId) fs.writeFileSync(promptFile, extra.prompt, 'utf8')
  const args = [
    'exec',
    '-C', ctx.hubRoot,
    '--skip-git-repo-check',
    '--color', 'never',
    '--sandbox', 'danger-full-access',
    '--dangerously-bypass-approvals-and-sandbox',
    '-m', model,
    '-c', `model_reasoning_effort=${effort}`
  ]
  if (session.worktree) args.push('--add-dir', session.worktree)
  if (extra.resumeId) args.push('resume', extra.resumeId)
  args.push('-o', session.lastFile, '-')
  fs.mkdirSync(dirname(session.logFile), { recursive: true })
  const runner = join(ctx.hubRoot, 'skill-review', `run-codex-${session.id}.cmd`)
  const line = [
    quoteCmd(process.execPath),
    quoteCmd(codexJs()),
    ...args.map(quoteCmd),
    '<', quoteCmd(promptFile),
    '>>', quoteCmd(session.logFile),
    '2>&1'
  ].join(' ')
  fs.writeFileSync(runner, `@echo off\r\nchcp 65001 >nul\r\ncd /d ${quoteCmd(ctx.hubRoot)}\r\n${line}\r\n`, 'utf8')
  const ps = [
    `$created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'cmd.exe /c "${runner.replace(/'/g, "''")}'; CurrentDirectory = '${ctx.hubRoot.replace(/'/g, "''")}' }`,
    'if ([int]$created.ReturnValue -ne 0 -or -not $created.ProcessId) { Write-Error "WMI create failed $($created.ReturnValue)"; exit 1 }',
    'Write-Output $created.ProcessId'
  ].join('; ')
  const launched = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
    encoding: 'utf8',
    windowsHide: true
  })
  const pid = Number(String(launched.stdout || '').trim())
  if (!pid) {
    fs.appendFileSync(session.logFile, `\n[spawn error] ${launched.stderr || launched.stdout || 'WMI create failed'}\n`)
  }
  return pid || 0
}

function shouldSpawn(noSpawn: boolean) {
  if (noSpawn) return false
  if (process.env.HUB_SPAWN_CODEX === '0') return false
  return fs.existsSync(codexJs())
}

const rawArgv = process.argv.slice(2)
const command = rawArgv[0] || ''
if (!command || command === '-h' || command === '--help') {
  process.stdout.write(`${usage()}\n`)
  process.exit(command ? 0 : 1)
}

const argv = rawArgv.slice(1)
const packageRoot = findHubRoot()
const hub = createHub(process.env.HUB_ROOT || packageRoot)

async function main() {
  if (command === 'setup' || command === 'install') {
    const flags = {
      dryRun: takeSwitch(argv, '--dry-run'),
      json: takeSwitch(argv, '--json'),
      noDaemon: takeSwitch(argv, '--no-daemon'),
      noPath: takeSwitch(argv, '--no-path'),
      noTask: takeSwitch(argv, '--no-task'),
      rebuild: takeSwitch(argv, '--rebuild')
    }
    const result = await setupHub(packageRoot, flags)
    if (flags.json) print(result)
    else process.stdout.write(`${formatSetupReport(result)}\n`)
    if (!result.ok) process.exit(1)
    return
  }
  if (command === 'uninstall') {
    const json = takeSwitch(argv, '--json')
    const result = await uninstallHub(packageRoot)
    if (json) print(result)
    else process.stdout.write(`${formatUninstallReport(result)}\n`)
    if (!result.ok) process.exit(1)
    return
  }
  if (command === 'doctor') {
    const json = takeSwitch(argv, '--json')
    const report = await doctorHub(packageRoot)
    if (json) print(report)
    else process.stdout.write(`${formatDoctorReport(report)}\n`)
    if (!report.ok) process.exit(1)
    return
  }
  if (command === 'daemon') {
    const sub = argv[0] || 'status'
    if (sub === 'run') {
      await runDaemon({ hubRoot: packageRoot })
      return
    }
    if (sub === 'start') {
      const started = await startDaemonDetached(packageRoot)
      print({ action: 'daemon-start', ...started })
      if (!started.ok) process.exit(1)
      return
    }
    if (sub === 'stop') {
      const stopped = stopDaemon(packageRoot)
      print({ ok: true, action: 'daemon-stop', stopped })
      return
    }
    if (sub === 'status') {
      print(await daemonStatus(packageRoot))
      return
    }
    fail(`unknown daemon command: ${sub}\n${usage()}`)
  }
  if (command === 'status') {
    print(getStatus(hub))
    return
  }
  if (command === 'list-worktrees') {
    print(listWorktrees(hub))
    return
  }
  if (command === 'list-skills') {
    print(listSkills(hub, getStatus(hub).gameRepo))
    return
  }
  if (command === 'repair-links') {
    const worktree = takeFlag(argv, '--worktree')
    if (!worktree) fail('repair-links requires --worktree')
    const plan = repairPlan(hub, worktree)
    if (!plan.attached || plan.blocked) {
      print({ ok: true, ...plan, repaired: false, reason: plan.blocked ? 'blocked' : 'not-attached' })
    } else {
      const ran = runPs1('attach-library.ps1', ['-TargetWorktree', plan.worktree])
      if (ran.status !== 0) fail(ran.stderr || ran.stdout || 'repair-links failed')
      print({ ok: true, ...plan, repaired: true, output: ran.stdout })
    }
    return
  }
  if (command === 'ingest') {
    const gameRepo = takeFlag(argv, '--game-repo') || hub.git.configGet(hub.hubRoot, 'ozdqp.gameRepo')
    const dispatch = takeSwitch(argv, '--dispatch')
    const payload = readStdin()
    const rows = parseIngestTransactions(payload)
    if (rows.length === 0) {
      print(emptyIngestResult())
    } else {
      if (!gameRepo) fail('ingest requires --game-repo or git config ozdqp.gameRepo')
      const args = ['-GameRepo', gameRepo, '-HubRoot', hub.hubRoot]
      if (dispatch) args.push('-DispatchCodex')
      const ran = runPs1('analyze-remote-skill-update.ps1', args, payload)
      if (ran.status !== 0) fail(ran.stderr || ran.stdout || 'ingest failed')
      print({ ok: true, action: 'ingest', gameRepo, dispatched: dispatch, output: ran.stdout })
    }
    return
  }
  if (command === 'decide') {
    const id = takeFlag(argv, '--id')
    const action = takeFlag(argv, '--action') as DecideAction | undefined
    const note = takeFlag(argv, '--note')
    const mergeTarget = takeFlag(argv, '--merge-target')
    if (!id || !action) fail('decide requires --id and --action')
    print(decide(hub, { id, action, note, mergeTarget }))
    return
  }
  if (command === 'attach' || command === 'detach' || command === 'edit' || command === 'chat') {
    const worktree = takeFlag(argv, '--worktree')
    const skillPath = takeFlag(argv, '--path')
    const intent = takeFlag(argv, '--intent')
    const model = takeFlag(argv, '--model') || process.env.HUB_CODEX_MODEL || DEFAULT_CODEX_MODEL
    const effort = takeFlag(argv, '--effort') || process.env.HUB_CODEX_EFFORT || DEFAULT_CODEX_EFFORT
    const noSpawn = takeSwitch(argv, '--no-spawn')
    if ((command === 'attach' || command === 'detach') && !worktree) fail(`${command} requires --worktree`)
    let session = enqueueSession(hub, { kind: command, worktree, skillPath, intent })
    session.model = model
    session.effort = effort
    if (shouldSpawn(noSpawn)) {
      const prompt = hub.fs.readText(session.promptFile) || intent || command
      session = markSessionSpawned(hub, session, spawnCodex(hub, session, { prompt }))
    } else {
      saveSession(hub, session)
      if (command === 'attach' && !noSpawn && process.env.HUB_SPAWN_CODEX !== '0') {
        fail('Codex is not installed; attach must run a background conversation, not overlay scripts')
      }
    }
    print({ ok: true, action: command, session, applied: null })
    return
  }
  if (command === 'resume') {
    const id = takeFlag(argv, '--id')
    const message = takeFlag(argv, '--message')
    const noSpawn = takeSwitch(argv, '--no-spawn')
    if (!id || !message) fail('resume requires --id and --message')
    let session = resumeSession(hub, { id, message })
    if (shouldSpawn(noSpawn) && session.codexSessionId) {
      session = markSessionSpawned(hub, session, spawnCodex(hub, session, {
        resumeId: session.codexSessionId,
        prompt: message
      }))
    }
    print({ ok: true, action: 'resume', session })
    return
  }
  fail(`unknown command: ${command}\n${usage()}`)
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error))
})
