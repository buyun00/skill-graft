import type {
  AttachCompletionOutcome,
  SessionCancelRequest,
  SessionPort,
  SessionResumeRequest,
  SessionStartRequest
} from '../application/ports.js'
import { portFault } from '../application/port-fault.js'
import type {
  SessionEventView,
  SessionRunnerEvent,
  SessionRunnerSnapshot,
  SessionStepView,
  SessionView
} from '../contracts/index.js'
import type { LocalHostContext } from '../adapters/host-context.js'
import type { DshSessionBindingPort } from './session-binding.js'
import {
  createDshSessionRepository,
  DshSessionRevisionConflict,
  type DshSessionRepository,
  type DshStoredSession
} from './session-repository.js'
import type { DshSessionRunnerControl } from './session-runner.js'

export type DshSessionPort = SessionPort & {
  recover(): Promise<readonly SessionView[]>
}

export type DshSessionPortOptions = {
  repository?: DshSessionRepository
}

const ACTIVE_STATUSES = new Set(['queued', 'running'])
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])
const MAX_SESSION_EVENTS = 256

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function appendEvent(session: DshStoredSession, event: Omit<SessionEventView, 'sequence'>): void {
  const sequence = (session.events.at(-1)?.sequence || 0) + 1
  session.events = [...session.events, { sequence, ...event }].slice(-MAX_SESSION_EVENTS)
}

function projectCapabilities(session: DshStoredSession): SessionView['capabilities'] {
  const canResume = Boolean(session.continuationToken)
    && session.task.capabilities.resume
    && session.status !== 'running'
    && session.status !== 'queued'
    && session.status !== 'cancelled'
    && !(session.kind === 'attach' && session.status === 'completed')
  const canCancel = session.task.capabilities.cancel
    && (session.status === 'running' || session.status === 'queued')
    && !session.cancelRequested
  return { canResume, canCancel }
}

function project(session: DshStoredSession): SessionView {
  const capabilities = projectCapabilities(session)
  return {
    id: session.id,
    kind: session.kind,
    status: session.status,
    revision: session.revision,
    attemptId: session.attemptId,
    cancelRequested: session.cancelRequested,
    target: { ...session.target },
    intent: session.intent,
    runnerId: session.runnerId,
    continuationToken: session.continuationToken,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    exitCode: session.exitCode,
    error: session.runnerErrorCode,
    canResume: capabilities.canResume,
    steps: session.steps.map((step) => ({ ...step })),
    events: session.events.map((event) => ({ ...event })),
    capabilities,
    inboxIds: session.inboxIds ? [...session.inboxIds] : undefined,
    attachCompletion: session.attachCompletion ? { ...session.attachCompletion } : undefined
  }
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

function applyRunnerEvent(session: DshStoredSession, event: SessionRunnerEvent): void {
  if (event.attemptId !== session.attemptId || event.sequence <= session.runnerEventSequence) return
  session.runnerEventSequence = event.sequence
  if (event.type === 'runner.started') {
    if (!session.events.some((candidate) => candidate.attemptId === event.attemptId
      && candidate.type === 'runner.started')) {
      appendEvent(session, {
        attemptId: event.attemptId,
        type: 'runner.started',
        at: event.at,
        status: session.status
      })
    }
    return
  }
  appendEvent(session, {
    attemptId: event.attemptId,
    type: 'runner.status',
    at: event.at,
    status: session.status,
    code: event.code || event.type
  })
}

function applyRunnerSnapshot(session: DshStoredSession, value: SessionRunnerSnapshot, now: string): void {
  if (value.attemptId !== session.attemptId) return
  session.runnerId = value.runnerId
  session.runnerState = value.state
  if (value.continuationToken) session.continuationToken = value.continuationToken
  if (value.startedAt) session.startedAt = value.startedAt
  if (value.endedAt) session.endedAt = value.endedAt
  if (value.exitCode !== undefined) session.exitCode = value.exitCode
  if (value.error) session.runnerErrorCode = value.error.code

  if (value.state === 'starting' || value.state === 'running' || value.state === 'cancelling') {
    session.status = 'running'
    session.steps = runnerStepStatus(session.steps, 'running', value.startedAt || now)
    return
  }
  if (value.state === 'succeeded') {
    session.status = session.task.completion.kind === 'materializationProof' ? 'awaiting' : 'completed'
    session.exitCode = value.exitCode ?? 0
    session.endedAt = value.endedAt || now
    session.runnerErrorCode = undefined
    session.steps = runnerStepStatus(session.steps, 'completed', session.endedAt)
    appendEvent(session, {
      attemptId: value.attemptId,
      type: 'runner.status',
      at: session.endedAt,
      status: session.status,
      code: 'RUNNER_SUCCEEDED'
    })
    if (session.status === 'completed') {
      appendEvent(session, {
        attemptId: value.attemptId,
        type: 'session.completed',
        at: session.endedAt,
        status: 'completed'
      })
    }
    return
  }
  if (value.state === 'cancelled') {
    session.status = 'cancelled'
    session.endedAt = value.endedAt || now
    session.steps = session.steps.map((step) => step.status === 'completed'
      ? { ...step }
      : { ...step, status: 'cancelled', at: session.endedAt })
    appendEvent(session, {
      attemptId: value.attemptId,
      type: 'runner.status',
      at: session.endedAt,
      status: 'cancelled',
      code: 'RUNNER_CANCELLED'
    })
    return
  }
  session.status = 'failed'
  session.endedAt = value.endedAt || now
  session.runnerErrorCode = value.error?.code || (value.state === 'lost'
    ? 'RUNNER_NOT_FOUND'
    : 'RUNNER_PROTOCOL_ERROR')
  session.steps = runnerStepStatus(session.steps, 'failed', session.endedAt)
  appendEvent(session, {
    attemptId: value.attemptId,
    type: 'runner.status',
    at: session.endedAt,
    status: 'failed',
    code: session.runnerErrorCode
  })
}

function sameProof(left: NonNullable<DshStoredSession['attachCompletion']>, right: NonNullable<DshStoredSession['attachCompletion']>): boolean {
  return left.targetId === right.targetId
    && left.pathKey === right.pathKey
    && left.materializationId === right.materializationId
}

export function createDshSessionPort(
  ctx: LocalHostContext,
  binding: DshSessionBindingPort,
  runner: DshSessionRunnerControl,
  options: DshSessionPortOptions = {}
): DshSessionPort {
  const repository = options.repository || createDshSessionRepository(ctx)

  const update = (current: DshStoredSession, change: (next: DshStoredSession) => void): DshStoredSession => {
    try {
      return repository.update(current.id, current.revision, (next) => {
        change(next)
        return next
      })
    } catch (error) {
      if (error instanceof DshSessionRevisionConflict) throw portFault('request-in-progress')
      throw error
    }
  }

  const synchronize = async (input: DshStoredSession): Promise<DshStoredSession> => {
    if (!input.runnerId || !ACTIVE_STATUSES.has(input.status)) return input
    const request = {
      sessionId: input.id,
      attemptId: input.attemptId,
      runnerId: input.runnerId
    }
    const [status, events] = await Promise.all([
      runner.port.status(request),
      runner.port.events({ ...request, afterSequence: input.runnerEventSequence })
    ])
    const before = JSON.stringify(input)
    const next = clone(input)
    if (events.ok) {
      for (const event of events.value.events) applyRunnerEvent(next, event)
      next.runnerEventSequence = Math.max(next.runnerEventSequence, events.value.nextSequence)
    }
    if (status.ok) {
      applyRunnerSnapshot(next, status.value, ctx.clock.nowIso())
    } else {
      applyRunnerSnapshot(next, {
        runnerId: input.runnerId,
        attemptId: input.attemptId,
        state: status.error.code === 'RUNNER_NOT_FOUND' ? 'lost' : 'failed',
        error: status.error
      }, ctx.clock.nowIso())
    }
    if (!events.ok && !next.runnerErrorCode) next.runnerErrorCode = events.error.code
    if (JSON.stringify(next) === before) return input
    return update(input, (stored) => Object.assign(stored, next))
  }

  const startAttempt = async (
    session: DshStoredSession,
    mode: 'start' | 'resume',
    options_: SessionStartRequest['options'],
    previous?: { runnerId: string; continuationToken: string }
  ): Promise<DshStoredSession> => {
    if (options_?.start === false) return session
    if (!runner.available()) throw portFault('runner-unavailable')
    const result = mode === 'start'
      ? await runner.port.start({ task: session.task, attemptId: session.attemptId, options: options_ })
      : await runner.port.resume({
          task: session.task,
          attemptId: session.attemptId,
          runnerId: previous?.runnerId || '',
          continuationToken: previous?.continuationToken || '',
          options: options_
        })
    session = update(session, (next) => {
      if (result.ok) {
        applyRunnerSnapshot(next, result.value, ctx.clock.nowIso())
        if (!next.events.some((event) => event.attemptId === result.value.attemptId
          && event.type === 'runner.started')) {
          appendEvent(next, {
            attemptId: result.value.attemptId,
            type: 'runner.started',
            at: result.value.startedAt || ctx.clock.nowIso(),
            status: 'running'
          })
        }
      } else {
        applyRunnerSnapshot(next, {
          runnerId: mode === 'resume' && previous?.runnerId
            ? previous.runnerId
            : `dsh-failed:${next.id}`,
          attemptId: next.attemptId,
          state: 'failed',
          error: result.error
        }, ctx.clock.nowIso())
        if (mode === 'resume' && previous?.continuationToken) {
          next.continuationToken = previous.continuationToken
        } else {
          next.continuationToken = undefined
        }
      }
    })
    // DSH runs are always asynchronous. Waiting here would hold the shared
    // Application write transaction and prevent status/cancel commands from
    // reaching the live AgentHandle. Explicit reapSessions folds completion.
    return session
  }

  const port: DshSessionPort = {
    async list() {
      // Query commands do not own a durable write transaction. Runner state is
      // folded only by start/resume/cancel or the explicit reapSessions write.
      return repository.list().map(project)
    },
    async get(sessionId) {
      const session = repository.read(sessionId)
      return session ? project(session) : null
    },
    async start(input: SessionStartRequest) {
      if (!input.task || !input.task.id || input.task.kind !== input.kind) throw portFault('invalid-request')
      if (repository.read(input.task.id)) throw portFault('request-in-progress')
      if (input.options?.start !== false && !runner.available()) throw portFault('runner-unavailable')
      const attemptId = ctx.ids.next('dsh-attempt')
      binding.prepare({
        sessionId: input.task.id,
        attemptId,
        task: input.task,
        locator: input.locator
      })
      const at = ctx.clock.nowIso()
      let session: DshStoredSession = {
        sessionSchemaVersion: 1,
        id: input.task.id,
        kind: input.kind,
        status: 'queued',
        revision: 1,
        attemptId,
        attemptNumber: 1,
        runnerEventSequence: 0,
        cancelRequested: false,
        task: clone(input.task),
        target: clone(input.task.target),
        locator: input.locator ? { ...input.locator } : undefined,
        intent: input.intent || input.task.intent,
        inboxIds: input.task.inboxIds ? [...input.task.inboxIds] : undefined,
        startedAt: at,
        exitCode: null,
        steps: input.task.steps.map((step) => ({ ...step, status: 'pending' })),
        events: [{
          sequence: 1,
          attemptId,
          type: 'session.queued',
          at,
          status: 'queued'
        }]
      }
      session = repository.insert(session)
      session = await startAttempt(session, 'start', input.options)
      return project(session)
    },
    async resume(input: SessionResumeRequest) {
      let session = repository.read(input.sessionId)
      if (!session) throw portFault('resource-not-found')
      session = await synchronize(session)
      if (ACTIVE_STATUSES.has(session.status) || session.status === 'cancelled') throw portFault('request-in-progress')
      if (session.kind === 'attach' && session.status === 'completed') throw portFault('request-in-progress')
      if (!session.runnerId || !session.continuationToken) throw portFault('invalid-request')
      if (input.task.id !== session.id || input.task.kind !== session.kind) throw portFault('invalid-request')
      const previous = { runnerId: session.runnerId, continuationToken: session.continuationToken }
      const attemptId = ctx.ids.next('dsh-attempt')
      binding.prepare({
        sessionId: session.id,
        attemptId,
        task: input.task,
        locator: session.locator
      })
      session = update(session, (next) => {
        next.task = clone(input.task)
        next.intent = input.message
        next.status = 'queued'
        next.attemptId = attemptId
        next.attemptNumber += 1
        next.runnerId = undefined
        next.runnerState = undefined
        next.runnerErrorCode = undefined
        next.runnerEventSequence = 0
        next.cancelRequested = false
        next.exitCode = null
        next.endedAt = undefined
        next.steps = input.task.steps.map((step) => ({ ...step, status: 'pending' }))
        appendEvent(next, {
          attemptId,
          type: 'session.queued',
          at: ctx.clock.nowIso(),
          status: 'queued'
        })
      })
      session = await startAttempt(session, 'resume', input.options, previous)
      return project(session)
    },
    async cancel(input: SessionCancelRequest) {
      let session = repository.read(input.sessionId)
      if (!session) throw portFault('resource-not-found')
      session = await synchronize(session)
      if (TERMINAL_STATUSES.has(session.status)) return project(session)
      if (session.status === 'awaiting') throw portFault('request-in-progress')
      if (session.cancelRequested) return project(session)
      session = update(session, (next) => {
        next.cancelRequested = true
        appendEvent(next, {
          attemptId: next.attemptId,
          type: 'session.cancel-requested',
          at: ctx.clock.nowIso(),
          status: next.status
        })
      })
      if (!session.runnerId) {
        session = update(session, (next) => {
          next.status = 'cancelled'
          next.endedAt = ctx.clock.nowIso()
          next.steps = next.steps.map((step) => ({ ...step, status: 'cancelled', at: next.endedAt }))
          appendEvent(next, {
            attemptId: next.attemptId,
            type: 'runner.status',
            at: next.endedAt,
            status: 'cancelled',
            code: 'RUNNER_CANCELLED'
          })
        })
        return project(session)
      }
      const result = await runner.port.cancel({
        sessionId: session.id,
        attemptId: session.attemptId,
        runnerId: session.runnerId,
        reason: input.reason
      })
      if (!result.ok) {
        session = update(session, (next) => { next.runnerErrorCode = result.error.code })
      } else {
        session = update(session, (next) => applyRunnerSnapshot(next, result.value, ctx.clock.nowIso()))
      }
      return project(session)
    },
    async reap(sessionIds?: readonly string[]) {
      const allowed = sessionIds === undefined ? null : new Set(sessionIds)
      const changed: SessionView[] = []
      for (const session of repository.list()) {
        if (allowed && !allowed.has(session.id)) continue
        if (!ACTIVE_STATUSES.has(session.status)) continue
        const before = session.revision
        const current = await synchronize(session)
        if (current.revision !== before) changed.push(project(current))
      }
      return changed
    },
    completeAttach(input): AttachCompletionOutcome {
      const session = repository.read(input.sessionId)
      if (!session) return { status: 'not-authorized', reason: 'not-found' }
      if (session.kind !== 'attach') return { status: 'not-authorized', reason: 'not-attach' }
      if (session.target.kind !== 'worktree' || session.target.id !== input.proof.targetId) {
        return { status: 'not-authorized', reason: 'target-mismatch' }
      }
      if (session.status === 'completed') {
        if (!session.attachCompletion || !sameProof(session.attachCompletion, input.proof)) {
          return { status: 'proof-conflict' }
        }
        return { status: 'already-completed', session: project(session) }
      }
      if (session.status !== 'awaiting') return { status: 'not-authorized', reason: 'not-awaiting' }
      if (session.exitCode !== 0) return { status: 'not-authorized', reason: 'exit-not-zero' }
      const completed = update(session, (next) => {
        next.status = 'completed'
        next.attachCompletion = { ...input.proof }
        next.steps = next.steps.map((step) => step.owner === 'application'
          ? { ...step, status: 'completed', at: input.proof.completedAt }
          : { ...step })
        appendEvent(next, {
          attemptId: next.attemptId,
          type: 'session.completed',
          at: input.proof.completedAt,
          status: 'completed'
        })
      })
      return { status: 'completed', session: project(completed) }
    },
    async recover() {
      return port.reap()
    }
  }
  return port
}
