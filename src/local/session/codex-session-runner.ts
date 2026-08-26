import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type {
  SessionRunnerPort,
  SessionRunnerStatusRequest
} from '../../application/index.js'
import type {
  SessionRequestOptions,
  SessionRunnerError,
  SessionRunnerEvent,
  SessionRunnerEventsPage,
  SessionRunnerSnapshot
} from '../../contracts/index.js'
import type { LocalHostContext } from '../../adapters/host-context.js'
import type { LocalSessionBinding, LocalSessionBindingPort } from './local-session-binding.js'

export const DEFAULT_RUNNER_PROFILE = 'gpt-5.6-luna'
export const DEFAULT_RUNNER_QUALITY = 'max'

type ControllerStatus = {
  runnerStatusVersion: 1
  sessionId: string
  attemptId: string
  state: 'starting' | 'running' | 'cancelling' | 'exited' | 'failed' | 'cancelled'
  controllerPid: number
  childPid: number
  exitCode?: number
  startedAt: string
  endedAt?: string
}

type ExecutionReceipt = {
  executionReceiptVersion: 1
  sessionId: string
  attemptId: string
  state: 'exited' | 'failed' | 'cancelled'
  controllerPid: number
  childPid: number
  exitCode: number
  threadId?: string
  sawTurnCompleted: boolean
  sawTurnFailed: boolean
  eventCount: number
  cancellationRequested: boolean
  startedAt: string
  endedAt: string
  error?: string
}

type ControllerEvent = {
  eventVersion: 1
  sequence: number
  at: string
  type: string
}

export type LocalSessionRunner = SessionRunnerPort & {
  enabled(): boolean
  available(): boolean
  pidAlive(pid: number): boolean
}

export type LocalSessionRunnerOptions = {
  packageRoot: string
  binding: LocalSessionBindingPort
  environment?: NodeJS.ProcessEnv
  nodeExecutable: string
  codexModule: string
  credentialHome: string
  controllerPath?: string
  powershellExecutable?: string
  controllerSpawn?: typeof spawnSync
  processAlive?: (pid: number) => boolean
  maximumStdoutBytes?: number
  maximumStderrBytes?: number
  maximumEventsBytes?: number
}

function runnerError(code: SessionRunnerError['code'], retryable: boolean): SessionRunnerError {
  return { code, retryable }
}

function ok<T>(value: T) {
  return { ok: true as const, value }
}

function failed<T>(error: SessionRunnerError) {
  return { ok: false as const, error }
}

function readJson<T>(file: string): { kind: 'missing' } | { kind: 'invalid' } | { kind: 'value'; value: T } {
  if (!fs.existsSync(file)) return { kind: 'missing' }
  try {
    return { kind: 'value', value: JSON.parse(fs.readFileSync(file, 'utf8')) as T }
  } catch {
    return { kind: 'invalid' }
  }
}

function atomicJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}`
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, 'utf8')
  fs.renameSync(temporary, file)
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function validStatus(value: ControllerStatus, expected: SessionRunnerStatusRequest): boolean {
  return value?.runnerStatusVersion === 1
    && value.sessionId === expected.sessionId
    && value.attemptId === expected.attemptId
    && ['starting', 'running', 'cancelling', 'exited', 'failed', 'cancelled'].includes(value.state)
    && Number.isSafeInteger(value.controllerPid)
    && Number.isSafeInteger(value.childPid)
    && validIso(value.startedAt)
    && (value.endedAt === undefined || validIso(value.endedAt))
}

function validReceipt(value: ExecutionReceipt, expected: SessionRunnerStatusRequest): boolean {
  return value?.executionReceiptVersion === 1
    && value.sessionId === expected.sessionId
    && value.attemptId === expected.attemptId
    && ['exited', 'failed', 'cancelled'].includes(value.state)
    && Number.isSafeInteger(value.exitCode)
    && typeof value.sawTurnCompleted === 'boolean'
    && typeof value.sawTurnFailed === 'boolean'
    && Number.isSafeInteger(value.eventCount)
    && value.eventCount >= 0
    && typeof value.cancellationRequested === 'boolean'
    && validIso(value.startedAt)
    && validIso(value.endedAt)
}

function modelOptions(input: SessionRequestOptions | undefined, env: NodeJS.ProcessEnv) {
  return {
    profile: input?.profile || env.HUB_CODEX_MODEL || DEFAULT_RUNNER_PROFILE,
    quality: input?.quality || env.HUB_CODEX_EFFORT || DEFAULT_RUNNER_QUALITY
  }
}

function startArguments(
  binding: LocalSessionBinding,
  codexModule: string,
  options: SessionRequestOptions | undefined,
  env: NodeJS.ProcessEnv
): string[] {
  const model = modelOptions(options, env)
  const args = [
    codexModule,
    'exec',
    '--json',
    '--ignore-user-config',
    '--ignore-rules',
    '-C', binding.workingDirectory,
    '--skip-git-repo-check',
    '--color', 'never',
    '--sandbox', 'danger-full-access',
    '--dangerously-bypass-approvals-and-sandbox',
    '-m', model.profile,
    '-c', `model_reasoning_effort=${model.quality}`
  ]
  for (const directory of binding.additionalDirectories) args.push('--add-dir', directory)
  args.push('-o', binding.artifacts.lastMessagePath, '-')
  return args
}

function resumeArguments(
  binding: LocalSessionBinding,
  codexModule: string,
  continuationToken: string,
  options: SessionRequestOptions | undefined,
  env: NodeJS.ProcessEnv
): string[] {
  const model = modelOptions(options, env)
  return [
    codexModule,
    'exec', 'resume',
    '--json',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox',
    '-m', model.profile,
    '-c', `model_reasoning_effort=${model.quality}`,
    '-o', binding.artifacts.lastMessagePath,
    continuationToken,
    '-'
  ]
}

export function createCodexSessionRunner(
  ctx: LocalHostContext,
  options: LocalSessionRunnerOptions
): LocalSessionRunner {
  const env = options.environment || process.env
  const controllerPath = options.controllerPath || path.join(options.packageRoot, 'runtime', 'codex-runner-controller.ps1')
  const powershellExecutable = options.powershellExecutable || path.join(
    env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  const controllerSpawn = options.controllerSpawn || spawnSync
  const processAlive = options.processAlive || ((pid: number) => {
    if (!pid || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  })
  const runnerIdFor = (sessionId: string, attemptId: string) => `local:${ctx.hash.sha256(`${sessionId}\n${attemptId}`).slice(0, 24)}`

  const bindingFor = (sessionId: string, attemptId: string, runnerId?: string) => {
    if (runnerId && runnerId !== runnerIdFor(sessionId, attemptId)) return null
    return options.binding.read(sessionId, attemptId)
  }

  const statusSnapshot = (request: SessionRunnerStatusRequest) => {
    const binding = bindingFor(request.sessionId, request.attemptId, request.runnerId)
    if (!binding) return failed<SessionRunnerSnapshot>(runnerError('RUNNER_NOT_FOUND', false))
    const receiptRead = readJson<ExecutionReceipt>(binding.artifacts.receiptPath)
    if (receiptRead.kind === 'invalid') {
      return failed<SessionRunnerSnapshot>(runnerError('RUNNER_PROTOCOL_ERROR', false))
    }
    if (receiptRead.kind === 'value') {
      const receipt = receiptRead.value
      if (!validReceipt(receipt, request)) {
        return failed<SessionRunnerSnapshot>(runnerError('RUNNER_PROTOCOL_ERROR', false))
      }
      const base = {
        runnerId: request.runnerId,
        attemptId: request.attemptId,
        continuationToken: receipt.threadId || undefined,
        startedAt: receipt.startedAt,
        endedAt: receipt.endedAt,
        exitCode: receipt.exitCode
      }
      if (receipt.state === 'cancelled') return ok<SessionRunnerSnapshot>({ ...base, state: 'cancelled' })
      const succeeded = receipt.state === 'exited'
        && receipt.exitCode === 0
        && receipt.sawTurnCompleted
        && !receipt.sawTurnFailed
      if (succeeded) return ok<SessionRunnerSnapshot>({ ...base, state: 'succeeded' })
      return ok<SessionRunnerSnapshot>({
        ...base,
        state: 'failed',
        error: runnerError('RUNNER_PROTOCOL_ERROR', false)
      })
    }

    const statusRead = readJson<ControllerStatus>(binding.artifacts.statusPath)
    if (statusRead.kind === 'invalid') {
      return failed<SessionRunnerSnapshot>(runnerError('RUNNER_PROTOCOL_ERROR', false))
    }
    if (statusRead.kind === 'value') {
      const status = statusRead.value
      if (!validStatus(status, request)) {
        return failed<SessionRunnerSnapshot>(runnerError('RUNNER_PROTOCOL_ERROR', false))
      }
      if (status.state === 'failed' || status.state === 'exited' || status.state === 'cancelled') {
        return ok<SessionRunnerSnapshot>({
          runnerId: request.runnerId,
          attemptId: request.attemptId,
          state: status.state === 'cancelled' ? 'cancelled' : 'failed',
          startedAt: status.startedAt,
          endedAt: status.endedAt,
          exitCode: status.exitCode,
          ...(status.state === 'cancelled' ? {} : { error: runnerError('RUNNER_PROTOCOL_ERROR', true) })
        })
      }
      return ok<SessionRunnerSnapshot>({
        runnerId: request.runnerId,
        attemptId: request.attemptId,
        state: status.state,
        startedAt: status.startedAt,
        exitCode: status.exitCode
      })
    }

    const launchRead = readJson<{ controllerPid?: unknown; launchedAt?: unknown }>(binding.artifacts.launchPath)
    if (launchRead.kind === 'invalid') {
      return failed<SessionRunnerSnapshot>(runnerError('RUNNER_PROTOCOL_ERROR', false))
    }
    const controllerPid = launchRead.kind === 'value' && Number.isSafeInteger(launchRead.value.controllerPid)
      ? Number(launchRead.value.controllerPid)
      : 0
    const launchedAt = launchRead.kind === 'value' && validIso(launchRead.value.launchedAt)
      ? launchRead.value.launchedAt
      : undefined
    const withinStartupGrace = Boolean(launchedAt) && Date.now() - Date.parse(launchedAt as string) < 30_000
    const alive = processAlive(controllerPid)
    return ok<SessionRunnerSnapshot>({
      runnerId: request.runnerId,
      attemptId: request.attemptId,
      state: alive || withinStartupGrace ? 'starting' : 'lost',
      startedAt: launchedAt,
      ...(alive || withinStartupGrace ? {} : { error: runnerError('RUNNER_PROTOCOL_ERROR', true) })
    })
  }

  const launchAttempt = (
    binding: LocalSessionBinding,
    arguments_: readonly string[],
    startError: SessionRunnerError['code']
  ) => {
    if (!path.isAbsolute(options.nodeExecutable)
      || !path.isAbsolute(options.codexModule)
      || !path.isAbsolute(options.credentialHome)
      || !fs.existsSync(options.nodeExecutable)
      || !fs.existsSync(options.codexModule)
      || !fs.existsSync(path.join(options.credentialHome, 'auth.json'))
      || !fs.existsSync(controllerPath)) {
      return failed<SessionRunnerSnapshot>(runnerError('RUNNER_NOT_FOUND', false))
    }
    const request = {
      sessionId: binding.sessionId,
      attemptId: binding.attemptId,
      executable: options.nodeExecutable,
      arguments: arguments_,
      workingDirectory: binding.workingDirectory,
      promptPath: binding.artifacts.promptPath,
      stdoutPath: binding.artifacts.stdoutPath,
      stderrPath: binding.artifacts.stderrPath,
      eventsPath: binding.artifacts.eventsPath,
      lastMessagePath: binding.artifacts.lastMessagePath,
      cancelPath: binding.artifacts.cancelPath,
      statusPath: binding.artifacts.statusPath,
      receiptPath: binding.artifacts.receiptPath,
      environment: binding.environment,
      maximumStdoutBytes: options.maximumStdoutBytes ?? 256 * 1024,
      maximumStderrBytes: options.maximumStderrBytes ?? 256 * 1024,
      maximumEventsBytes: options.maximumEventsBytes ?? 256 * 1024
    }
    atomicJson(binding.artifacts.requestPath, request)
    let controllerPid = 0
    try {
      const psLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`
      const controllerLog = path.join(binding.artifacts.attemptRoot, 'controller.log')
      const encodedScript = Buffer.from(
        `[IO.File]::WriteAllText(${psLiteral(controllerLog)}, 'controller launch'); & ${psLiteral(controllerPath)} -RequestPath ${psLiteral(binding.artifacts.requestPath)} *>> ${psLiteral(controllerLog)}`,
        'utf16le'
      ).toString('base64')
      const script = [
        `$created = Start-Process -FilePath ${psLiteral(powershellExecutable)} -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',${psLiteral(encodedScript)}) -WorkingDirectory ${psLiteral(binding.workingDirectory)} -WindowStyle Hidden -PassThru`,
        'if (-not $created -or -not $created.Id) { exit 1 }',
        '[Console]::Out.WriteLine([int]$created.Id)'
      ].join('; ')
      const launched = controllerSpawn(powershellExecutable, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script
      ], {
        cwd: binding.workingDirectory,
        encoding: 'utf8',
        windowsHide: true
      })
      controllerPid = Number(String(launched.stdout || '').trim().split(/\r?\n/).at(-1) || 0)
    } catch {
      return failed<SessionRunnerSnapshot>(runnerError(startError, true))
    }
    if (!controllerPid) return failed<SessionRunnerSnapshot>(runnerError(startError, true))
    atomicJson(binding.artifacts.launchPath, {
      launchVersion: 1,
      sessionId: binding.sessionId,
      attemptId: binding.attemptId,
      controllerPid,
      launchedAt: new Date().toISOString()
    })
    return ok<SessionRunnerSnapshot>({
      runnerId: runnerIdFor(binding.sessionId, binding.attemptId),
      attemptId: binding.attemptId,
      state: 'starting'
    })
  }

  return {
    enabled() {
      return env.HUB_SPAWN_CODEX !== '0'
    },
    available() {
      return path.isAbsolute(options.nodeExecutable)
        && path.isAbsolute(options.codexModule)
        && path.isAbsolute(options.credentialHome)
        && fs.existsSync(options.nodeExecutable)
        && fs.existsSync(options.codexModule)
        && fs.existsSync(path.join(options.credentialHome, 'auth.json'))
        && fs.existsSync(controllerPath)
    },
    pidAlive(pid) {
      return processAlive(pid)
    },
    start(input) {
      if (env.HUB_SPAWN_CODEX === '0') return failed(runnerError('RUNNER_UNAVAILABLE', true))
      const binding = bindingFor(input.task.id, input.attemptId)
      if (!binding) return failed(runnerError('RUNNER_INVALID_STATE', false))
      return launchAttempt(binding, startArguments(binding, options.codexModule, input.options, env), 'RUNNER_START_FAILED')
    },
    resume(input) {
      if (env.HUB_SPAWN_CODEX === '0') return failed(runnerError('RUNNER_UNAVAILABLE', true))
      if (!input.continuationToken.trim()) return failed(runnerError('RUNNER_INVALID_STATE', false))
      const binding = bindingFor(input.task.id, input.attemptId)
      if (!binding) return failed(runnerError('RUNNER_INVALID_STATE', false))
      return launchAttempt(
        binding,
        resumeArguments(binding, options.codexModule, input.continuationToken, input.options, env),
        'RUNNER_RESUME_FAILED'
      )
    },
    cancel(input) {
      const binding = bindingFor(input.sessionId, input.attemptId, input.runnerId)
      if (!binding) return failed(runnerError('RUNNER_NOT_FOUND', false))
      const current = statusSnapshot(input)
      if (!current.ok) return current
      if (current.value.state === 'succeeded'
        || current.value.state === 'failed'
        || current.value.state === 'cancelled'
        || current.value.state === 'lost') return current
      try {
        atomicJson(binding.artifacts.cancelPath, {
          cancelVersion: 1,
          sessionId: input.sessionId,
          attemptId: input.attemptId,
          requestedAt: new Date().toISOString()
        })
      } catch {
        return failed(runnerError('RUNNER_CANCEL_FAILED', true))
      }
      const after = statusSnapshot(input)
      if (!after.ok) return after
      return ok({ ...after.value, state: after.value.state === 'starting' ? 'cancelling' : after.value.state })
    },
    status(input) {
      return statusSnapshot(input)
    },
    events(input) {
      const binding = bindingFor(input.sessionId, input.attemptId, input.runnerId)
      if (!binding) return failed<SessionRunnerEventsPage>(runnerError('RUNNER_NOT_FOUND', false))
      const rawEvents: ControllerEvent[] = []
      if (fs.existsSync(binding.artifacts.eventsPath)) {
        const lines = fs.readFileSync(binding.artifacts.eventsPath, 'utf8').split(/\r?\n/).filter(Boolean)
        for (const line of lines) {
          try {
            const event = JSON.parse(line) as ControllerEvent
            if (event.eventVersion !== 1
              || !Number.isSafeInteger(event.sequence)
              || event.sequence <= 0
              || !validIso(event.at)
              || typeof event.type !== 'string') {
              return failed<SessionRunnerEventsPage>(runnerError('RUNNER_PROTOCOL_ERROR', false))
            }
            rawEvents.push(event)
          } catch {
            return failed<SessionRunnerEventsPage>(runnerError('RUNNER_PROTOCOL_ERROR', false))
          }
        }
      }
      const after = input.afterSequence ?? 0
      const events: SessionRunnerEvent[] = rawEvents
        .filter((event) => event.sequence > after)
        .slice(0, 512)
        .map((event) => ({
          sequence: event.sequence,
          attemptId: input.attemptId,
          type: event.type === 'runner.controller.started'
            ? 'runner.started'
            : event.type === 'turn.failed'
              || event.type === 'error'
              || event.type === 'runner.controller.failed'
              || event.type === 'runner.invalid-json-event'
                ? 'runner.failed'
                : 'runner.progress',
          at: event.at,
          ...(event.type === 'turn.failed'
            || event.type === 'error'
            || event.type === 'runner.controller.failed'
            || event.type === 'runner.invalid-json-event'
            ? { code: 'RUNNER_PROTOCOL_ERROR' as const }
            : {})
        }))
      const status = statusSnapshot(input)
      if (!status.ok) return failed<SessionRunnerEventsPage>(status.error)
      const receipt = readJson<ExecutionReceipt>(binding.artifacts.receiptPath)
      const terminalSequence = receipt.kind === 'value' && validReceipt(receipt.value, input)
        ? receipt.value.eventCount + 1
        : 0
      if (terminalSequence > after && terminalSequence > 0) {
        const type = status.value.state === 'succeeded'
          ? 'runner.succeeded'
          : status.value.state === 'cancelled'
            ? 'runner.cancelled'
            : 'runner.failed'
        events.push({
          sequence: terminalSequence,
          attemptId: input.attemptId,
          type,
          at: status.value.endedAt || new Date().toISOString(),
          ...(type === 'runner.failed' ? { code: status.value.error?.code || 'RUNNER_PROTOCOL_ERROR' } : {})
        })
      }
      events.sort((left, right) => left.sequence - right.sequence)
      return ok<SessionRunnerEventsPage>({
        events,
        nextSequence: Math.max(after, ...events.map((event) => event.sequence), rawEvents.at(-1)?.sequence || 0)
      })
    }
  }
}
