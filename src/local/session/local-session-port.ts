import type {
  SessionCancelRequest,
  SessionPort,
  SessionResumeRequest,
  SessionStartRequest
} from '../../application/ports.js'
import { portFault } from '../../application/port-fault.js'
import type {
  CurrentSessionStatus,
  SessionEventView,
  SessionRunnerEvent,
  SessionRunnerSnapshot,
  SessionStepView,
  SessionView
} from '../../contracts/index.js'
import type { LocalHostContext as HubContext } from '../../adapters/host-context.js'
import {
  completeAttachSession as completeLegacyAttachSession,
  presentSession,
  sessionsNeedReap,
  toSessionView as legacySessionView
} from './legacy-sessions.js'
import {
  createCodexSessionRunner,
  type LocalSessionRunner,
  type LocalSessionRunnerOptions
} from './codex-session-runner.js'
import { resolveLocalCodexRuntime } from './local-codex-runtime.js'
import {
  createLocalSessionBinding,
  type LocalSessionBindingPort
} from './local-session-binding.js'
import {
  createLocalSessionRepository,
  LocalSessionRevisionConflict,
  type LocalSessionRepository
} from './local-session-repository.js'
import type { HubSession } from './types.js'

export type LocalSessionPort = SessionPort & {
  recover(): Promise<readonly SessionView[]>
  needsReap(sessionIds?: readonly string[]): boolean
  listLegacy(): HubSession[]
  getLegacy(sessionId: string): HubSession | null
  readLog(sessionId: string): string
}

export type LocalSessionPortOptions = {
  packageRoot?: string
  environment?: NodeJS.ProcessEnv
  nodeExecutable?: string
  codexModule?: string
  credentialHome?: string
  binding?: LocalSessionBindingPort
  repository?: LocalSessionRepository
  runner?: LocalSessionRunner
  runnerOptions?: Partial<Omit<LocalSessionRunnerOptions,
    'packageRoot' | 'binding' | 'environment' | 'nodeExecutable' | 'codexModule' | 'credentialHome'>>
  waitTimeoutMs?: number
  pollMs?: number
  sleep?: (ms: number) => Promise<void>
}

const ACTIVE_STATUSES = new Set(['queued', 'running'])
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])
const MAX_SESSION_EVENTS = 256

function isV2(session: HubSession): boolean {
  return session.sessionSchemaVersion === 2 && session.task?.taskVersion === 1
}

function currentStatus(value: string): CurrentSessionStatus {
  switch (value) {
    case 'queued':
    case 'running':
    case 'awaiting':
    case 'failed':
    case 'completed':
    case 'cancelled':
      return value
    case 'waiting':
      return 'awaiting'
    default:
      return 'failed'
  }
}

function appendEvent(session: HubSession, event: Omit<SessionEventView, 'sequence'>): void {
  const events = session.events || []
  const sequence = (events.at(-1)?.sequence || 0) + 1
  session.events = [...events, { sequence, ...event }].slice(-MAX_SESSION_EVENTS)
}

function projectCapabilities(session: HubSession) {
  const status = currentStatus(session.status)
  const token = session.codexSessionId || ''
  const canResume = Boolean(token)
    && status !== 'running'
    && status !== 'queued'
    && status !== 'cancelled'
    && !(session.kind === 'attach' && status === 'completed')
  const canCancel = Boolean(session.task?.capabilities.cancel)
    && (status === 'running' || status === 'queued')
    && !session.cancelRequested
  return { canResume, canCancel }
}

function projectV2(session: HubSession): SessionView {
  const capabilities = projectCapabilities(session)
  return {
    id: session.id,
    kind: session.task?.kind || 'chat',
    status: currentStatus(session.status),
    revision: session.revision ?? 0,
    attemptId: session.attemptId,
    cancelRequested: Boolean(session.cancelRequested),
    target: session.target ? { ...session.target } : session.task?.target ? { ...session.task.target } : undefined,
    intent: session.intent || undefined,
    runnerId: session.runnerId,
    continuationToken: session.codexSessionId || undefined,
    startedAt: session.startedAt,
    endedAt: session.endedAt || undefined,
    exitCode: session.exitCode,
    error: session.runnerErrorCode || undefined,
    summary: session.summary || undefined,
    lastMessage: session.lastMessage || undefined,
    canResume: capabilities.canResume,
    steps: (session.steps || []).map((step) => ({ ...step })),
    events: (session.events || []).map((event) => ({ ...event })),
    capabilities,
    inboxIds: session.inboxIds ? [...session.inboxIds] : undefined,
    attachCompletion: session.attachCompletion ? { ...session.attachCompletion } : undefined
  }
}

function applyRunnerEvent(session: HubSession, event: SessionRunnerEvent): void {
  if (event.sequence <= (session.runnerEventSequence || 0)) return
  session.runnerEventSequence = event.sequence
  const status = currentStatus(session.status)
  if (event.type === 'runner.started') {
    if (!session.events?.some((candidate) => candidate.attemptId === event.attemptId && candidate.type === 'runner.started')) {
      appendEvent(session, {
        attemptId: event.attemptId,
        type: 'runner.started',
        at: event.at,
        status
      })
    }
    return
  }
  appendEvent(session, {
    attemptId: event.attemptId,
    type: 'runner.status',
    at: event.at,
    status,
    code: event.code || event.type
  })
}

function runnerStepStatus(
  steps: readonly SessionStepView[],
  status: SessionStepView['status'],
  at: string
): SessionStepView[] {
  return steps.map((step) => step.owner === 'runner' && step.status !== 'completed'
    ? { ...step, status, at }
    : { ...step })
}

function applyRunnerSnapshot(session: HubSession, snapshot: SessionRunnerSnapshot, now: string): void {
  session.runnerId = snapshot.runnerId
  session.runnerState = snapshot.state
  if (snapshot.continuationToken) session.codexSessionId = snapshot.continuationToken
  if (snapshot.startedAt) session.startedAt = snapshot.startedAt
  if (snapshot.endedAt) session.endedAt = snapshot.endedAt
  if (snapshot.exitCode !== undefined) session.exitCode = snapshot.exitCode
  if (snapshot.error) session.runnerErrorCode = snapshot.error.code

  const steps = session.steps || []
  if (snapshot.state === 'starting' || snapshot.state === 'running' || snapshot.state === 'cancelling') {
    session.status = 'running'
    session.steps = runnerStepStatus(steps, 'running', snapshot.startedAt || now)
    return
  }
  if (snapshot.state === 'succeeded') {
    session.status = session.task?.completion.kind === 'materializationProof' ? 'awaiting' : 'completed'
    session.exitCode = snapshot.exitCode ?? 0
    session.endedAt = snapshot.endedAt || now
    session.runnerErrorCode = undefined
    session.steps = runnerStepStatus(steps, 'completed', session.endedAt)
    appendEvent(session, {
      attemptId: snapshot.attemptId,
      type: 'runner.status',
      at: session.endedAt,
      status: currentStatus(session.status),
      code: 'RUNNER_SUCCEEDED'
    })
    return
  }
  if (snapshot.state === 'cancelled') {
    session.status = 'cancelled'
    session.endedAt = snapshot.endedAt || now
    session.steps = steps.map((step) => step.status === 'completed'
      ? { ...step }
      : { ...step, status: 'cancelled', at: session.endedAt })
    appendEvent(session, {
      attemptId: snapshot.attemptId,
      type: 'runner.status',
      at: session.endedAt,
      status: 'cancelled',
      code: 'RUNNER_CANCELLED'
    })
    return
  }
  session.status = 'failed'
  session.endedAt = snapshot.endedAt || now
  session.runnerErrorCode = snapshot.error?.code || 'RUNNER_PROTOCOL_ERROR'
  session.steps = runnerStepStatus(steps, 'failed', session.endedAt)
  appendEvent(session, {
    attemptId: snapshot.attemptId,
    type: 'runner.status',
    at: session.endedAt,
    status: 'failed',
    code: session.runnerErrorCode
  })
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

const MAX_LAST_MESSAGE_BYTES = 1_000_000

function readBoundLastMessage(
  ctx: HubContext,
  binding: LocalSessionBindingPort,
  session: HubSession
): string | undefined {
  if (!session.lastFile || !session.attemptId) return undefined

  let bound: ReturnType<LocalSessionBindingPort['read']>
  try {
    bound = binding.read(session.id, session.attemptId)
  } catch {
    return undefined
  }
  const artifacts = bound?.artifacts
  if (!artifacts?.attemptRoot || !artifacts.lastMessagePath) return undefined

  try {
    const attemptRoot = ctx.path.resolve(artifacts.attemptRoot)
    const expected = ctx.path.resolve(attemptRoot, 'last-message.txt')
    const boundLastFile = ctx.path.resolve(artifacts.lastMessagePath)
    const sessionLastFile = ctx.path.resolve(session.lastFile)
    const samePath = (left: string, right: string) =>
      ctx.path.comparisonKey(left) === ctx.path.comparisonKey(right)
    if (!samePath(boundLastFile, expected) || !samePath(sessionLastFile, expected)) return undefined
    if (ctx.fs.isSymbolicLink?.(expected) || !ctx.fs.isFile(expected)) return undefined
    const realExpected = ctx.fs.realpath(expected)
    if (!realExpected || !samePath(realExpected, expected)) return undefined

    const content = ctx.fs.readText(expected)
    if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_LAST_MESSAGE_BYTES) {
      return undefined
    }
    return content
  } catch {
    return undefined
  }
}

function refreshLastMessage(
  ctx: HubContext,
  binding: LocalSessionBindingPort,
  session: HubSession
): void {
  const content = readBoundLastMessage(ctx, binding, session)
  if (content !== undefined) session.lastMessage = content
  else delete session.lastMessage
}

export function createLocalSessionPort(ctx: HubContext, options: LocalSessionPortOptions = {}): LocalSessionPort {
  const env = options.environment || process.env
  const packageRoot = options.packageRoot || ctx.hubRoot
  // Resolution stays inside the supplied composition/environment authority.
  // Isolated APPDATA/USERPROFILE values therefore cannot fall back to the
  // daemon user's global Codex installation or credential store.
  const runtime = resolveLocalCodexRuntime({
    packageRoot,
    environment: env,
    nodeExecutable: options.nodeExecutable,
    fallbackNodeExecutable: process.execPath,
    codexModule: options.codexModule,
    credentialHome: options.credentialHome,
    controllerPath: options.runnerOptions?.controllerPath
  })
  const { nodeExecutable, codexModule, credentialHome } = runtime
  const binding = options.binding || createLocalSessionBinding(ctx, {
    packageRoot,
    nodeExecutable,
    credentialHome
  })
  const runner = options.runner || createCodexSessionRunner(ctx, {
    packageRoot,
    binding,
    environment: env,
    nodeExecutable,
    codexModule,
    credentialHome,
    ...options.runnerOptions
  })
  const repository = options.repository || createLocalSessionRepository(ctx)
  const waitTimeoutMs = options.waitTimeoutMs ?? Number(env.HUB_WAIT_TIMEOUT_MS || 30 * 60 * 1000)
  const pollMs = options.pollMs ?? 250
  const sleep = options.sleep || ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  const update = (current: HubSession, change: (next: HubSession) => void): HubSession => {
    try {
      return repository.update(current.id, current.revision ?? 0, (next) => {
        change(next)
        return next
      })
    } catch (error) {
      if (error instanceof LocalSessionRevisionConflict) throw portFault('request-in-progress')
      throw error
    }
  }

  const synchronize = async (input: HubSession): Promise<HubSession> => {
    if (!isV2(input)) return input
    const before = JSON.stringify(input)
    const next = clone(input)
    if (input.runnerId && input.attemptId && ACTIVE_STATUSES.has(input.status)) {
      const request = {
        sessionId: input.id,
        attemptId: input.attemptId,
        runnerId: input.runnerId
      }
      const status = await runner.status(request)
      const events = await runner.events({ ...request, afterSequence: input.runnerEventSequence || 0 })
      if (events.ok) {
        for (const event of events.value.events) applyRunnerEvent(next, event)
        next.runnerEventSequence = Math.max(next.runnerEventSequence || 0, events.value.nextSequence)
      }
      if (status.ok) applyRunnerSnapshot(next, status.value, ctx.clock.nowIso())
      else {
        applyRunnerSnapshot(next, {
          runnerId: input.runnerId,
          attemptId: input.attemptId,
          state: 'failed',
          error: status.error
        }, ctx.clock.nowIso())
      }
      if (!events.ok) next.runnerErrorCode = events.error.code
    }
    refreshLastMessage(ctx, binding, next)
    if (JSON.stringify(next) === before) return input
    return update(input, (stored) => Object.assign(stored, next))
  }

  const refresh = async (session: HubSession): Promise<HubSession> => isV2(session)
    ? synchronize(session)
    : presentSession(ctx, session)

  const waitFor = async (session: HubSession): Promise<HubSession> => {
    const started = ctx.clock.nowMs()
    let current = session
    while (ACTIVE_STATUSES.has(current.status)) {
      current = await refresh(repository.read(current.id) || current)
      if (!ACTIVE_STATUSES.has(current.status)) break
      if (ctx.clock.nowMs() - started > waitTimeoutMs) break
      await sleep(pollMs)
    }
    return current
  }

  const startAttempt = async (
    session: HubSession,
    mode: 'start' | 'resume',
    options_: SessionStartRequest['options'],
    previous?: { runnerId: string; continuationToken: string }
  ): Promise<HubSession> => {
    if (options_?.start === false) return session
    if (!runner.enabled() || !runner.available()) throw portFault('runner-unavailable')
    if (!session.task || !session.attemptId) throw portFault('invalid-request')
    const result = mode === 'start'
      ? await runner.start({ task: session.task, attemptId: session.attemptId, options: options_ })
      : await runner.resume({
          task: session.task,
          attemptId: session.attemptId,
          runnerId: previous?.runnerId || '',
          continuationToken: previous?.continuationToken || '',
          options: options_
        })
    session = update(session, (next) => {
      if (result.ok) {
        applyRunnerSnapshot(next, result.value, ctx.clock.nowIso())
        appendEvent(next, {
          attemptId: result.value.attemptId,
          type: 'runner.started',
          at: result.value.startedAt || ctx.clock.nowIso(),
          status: 'running'
        })
      } else {
        applyRunnerSnapshot(next, {
          runnerId: next.runnerId || `local:${next.id}`,
          attemptId: next.attemptId || '',
          state: 'failed',
          error: result.error
        }, ctx.clock.nowIso())
      }
    })
    return options_?.wait ? waitFor(session) : session
  }

  const port: LocalSessionPort = {
    async list() {
      return repository.list().map((session) => isV2(session)
        ? projectV2(session)
        : legacySessionView(ctx, session))
    },
    async get(sessionId) {
      const session = repository.read(sessionId)
      if (!session) return null
      return isV2(session) ? projectV2(session) : legacySessionView(ctx, session)
    },
    async start(input: SessionStartRequest) {
      if (!input.task || input.task.id.length === 0 || input.task.kind !== input.kind) throw portFault('invalid-request')
      if (repository.read(input.task.id)) throw portFault('request-in-progress')
      if (input.options?.start !== false && (!runner.enabled() || !runner.available())) {
        throw portFault('runner-unavailable')
      }
      const attemptId = ctx.ids.next('attempt')
      const prepared = binding.prepare({
        sessionId: input.task.id,
        attemptId,
        task: input.task,
        locator: input.locator
      })
      const at = ctx.clock.nowIso()
      let session: HubSession = {
        sessionSchemaVersion: 2,
        id: input.task.id,
        kind: input.kind,
        path: input.locator?.kind === 'skill' ? input.locator.value : '',
        worktree: input.locator?.kind === 'worktree' ? input.locator.value : '',
        intent: input.intent || input.task.intent || '',
        pid: 0,
        promptFile: prepared.artifacts.promptPath,
        logFile: prepared.artifacts.stdoutPath,
        lastFile: prepared.artifacts.lastMessagePath,
        startedAt: at,
        status: 'queued',
        exitCode: null,
        error: '',
        codexSessionId: '',
        model: input.options?.profile || env.HUB_CODEX_MODEL,
        effort: input.options?.quality || env.HUB_CODEX_EFFORT,
        inboxIds: input.task.inboxIds ? [...input.task.inboxIds] : [],
        revision: 1,
        attemptId,
        attemptNumber: 1,
        runnerEventSequence: 0,
        cancelRequested: false,
        task: clone(input.task),
        target: clone(input.task.target),
        steps: input.task.steps.map((step) => ({ ...step, status: 'pending' })),
        events: [{
          sequence: 1,
          attemptId,
          type: 'session.queued',
          at,
          status: 'queued'
        }],
        runnerArtifacts: prepared.artifacts
      }
      session = repository.insert(session)
      session = await startAttempt(session, 'start', input.options)
      return projectV2(session)
    },
    async resume(input: SessionResumeRequest) {
      let session = repository.read(input.sessionId)
      if (!session) throw portFault('resource-not-found')
      session = await refresh(session)
      if (!isV2(session) || !session.task) throw portFault('invalid-request')
      if (ACTIVE_STATUSES.has(session.status)) throw portFault('request-in-progress')
      if (session.kind === 'attach' && session.status === 'completed') throw portFault('request-in-progress')
      if (!session.codexSessionId || !session.runnerId) throw portFault('invalid-request')
      if (input.task.id !== session.id || input.task.kind !== session.task.kind) throw portFault('invalid-request')
      const previous = { runnerId: session.runnerId, continuationToken: session.codexSessionId }
      const attemptId = ctx.ids.next('attempt')
      const prepared = binding.prepare({
        sessionId: session.id,
        attemptId,
        task: input.task,
        locator: session.worktree
          ? { kind: 'worktree', value: session.worktree }
          : session.path
            ? { kind: 'skill', value: session.path }
            : undefined
      })
      session = update(session, (next) => {
        next.task = clone(input.task)
        next.intent = input.message
        next.status = 'queued'
        next.attemptId = attemptId
        next.attemptNumber = (next.attemptNumber || 1) + 1
        next.runnerId = undefined
        next.runnerState = undefined
        next.runnerErrorCode = undefined
        next.runnerEventSequence = 0
        next.cancelRequested = false
        next.exitCode = null
        next.endedAt = undefined
        next.promptFile = prepared.artifacts.promptPath
        next.logFile = prepared.artifacts.stdoutPath
        next.lastFile = prepared.artifacts.lastMessagePath
        next.lastMessage = undefined
        next.runnerArtifacts = prepared.artifacts
        next.steps = input.task.steps.map((step) => ({ ...step, status: 'pending' }))
        appendEvent(next, {
          attemptId,
          type: 'session.queued',
          at: ctx.clock.nowIso(),
          status: 'queued'
        })
      })
      session = await startAttempt(session, 'resume', input.options, previous)
      return projectV2(session)
    },
    async cancel(input: SessionCancelRequest) {
      let session = repository.read(input.sessionId)
      if (!session) throw portFault('resource-not-found')
      session = await refresh(session)
      if (!isV2(session)) throw portFault('invalid-request')
      if (TERMINAL_STATUSES.has(session.status)) return projectV2(session)
      if (session.cancelRequested) return projectV2(session)
      session = update(session, (next) => {
        next.cancelRequested = true
        appendEvent(next, {
          attemptId: next.attemptId || '',
          type: 'session.cancel-requested',
          at: ctx.clock.nowIso(),
          status: currentStatus(next.status)
        })
      })
      if (!session.runnerId || !session.attemptId) {
        session = update(session, (next) => {
          next.status = 'cancelled'
          next.endedAt = ctx.clock.nowIso()
          next.steps = (next.steps || []).map((step) => ({ ...step, status: 'cancelled', at: next.endedAt }))
        })
        return projectV2(session)
      }
      const result = await runner.cancel({
        sessionId: session.id,
        attemptId: session.attemptId,
        runnerId: session.runnerId,
        reason: input.reason
      })
      if (!result.ok) {
        session = update(session, (next) => {
          next.runnerErrorCode = result.error.code
        })
      } else if (result.value.state === 'cancelled') {
        session = update(session, (next) => applyRunnerSnapshot(next, result.value, ctx.clock.nowIso()))
      }
      return projectV2(session)
    },
    async reap(sessionIds?: readonly string[]) {
      const allowed = sessionIds === undefined ? null : new Set(sessionIds)
      const changed: SessionView[] = []
      for (const session of repository.list()) {
        if (allowed && !allowed.has(session.id)) continue
        if (!isV2(session) || !ACTIVE_STATUSES.has(session.status)) continue
        const before = session.revision ?? 0
        const current = await synchronize(session)
        if ((current.revision ?? 0) !== before) changed.push(projectV2(current))
      }
      return changed
    },
    completeAttach(input) {
      const session = repository.read(input.sessionId)
      if (!session) return { status: 'not-authorized', reason: 'not-found' }
      if (!isV2(session)) return completeLegacyAttachSession(ctx, input)
      if (session.kind !== 'attach') return { status: 'not-authorized', reason: 'not-attach' }
      if (session.target?.kind !== 'worktree' || session.target.id !== input.proof.targetId) {
        return { status: 'not-authorized', reason: 'target-mismatch' }
      }
      if (session.status === 'completed') {
        const proof = session.attachCompletion
        if (!proof
          || proof.targetId !== input.proof.targetId
          || proof.pathKey !== input.proof.pathKey
          || proof.materializationId !== input.proof.materializationId) return { status: 'proof-conflict' }
        return { status: 'already-completed', session: projectV2(session) }
      }
      if (session.status !== 'awaiting') return { status: 'not-authorized', reason: 'not-awaiting' }
      if (session.exitCode !== 0) return { status: 'not-authorized', reason: 'exit-not-zero' }
      const completed = update(session, (next) => {
        next.status = 'completed'
        next.attachCompletion = { ...input.proof }
        next.steps = (next.steps || []).map((step) => step.owner === 'application'
          ? { ...step, status: 'completed', at: input.proof.completedAt }
          : { ...step })
        appendEvent(next, {
          attemptId: next.attemptId || '',
          type: 'session.completed',
          at: input.proof.completedAt,
          status: 'completed'
        })
      })
      return { status: 'completed', session: projectV2(completed) }
    },
    async recover() {
      return port.reap()
    },
    needsReap(sessionIds?: readonly string[]) {
      const allowed = sessionIds === undefined ? null : new Set(sessionIds)
      const sessions = repository.list()
      if (sessions.some((session) => isV2(session)
        && (!allowed || allowed.has(session.id))
        && session.status === 'running')) return true
      return sessionsNeedReap(ctx, (pid) => runner.pidAlive(pid), sessionIds)
    },
    listLegacy() {
      return repository.list().map((session) => isV2(session) ? clone(session) : presentSession(ctx, session))
    },
    getLegacy(sessionId) {
      const session = repository.read(sessionId)
      return session ? isV2(session) ? clone(session) : presentSession(ctx, session) : null
    },
    readLog(sessionId) {
      const session = repository.read(sessionId)
      return session ? ctx.fs.readText(session.logFile) || '' : ''
    }
  }
  return port
}
