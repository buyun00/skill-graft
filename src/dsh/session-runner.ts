import type {
  SessionRunnerError,
  SessionRunnerErrorCode,
  SessionRunnerEvent,
  SessionRunnerEventsPage,
  SessionRunnerResult,
  SessionRunnerSnapshot
} from '../contracts/index.js'
import type {
  SessionRunnerCancelRequest,
  SessionRunnerEventsRequest,
  SessionRunnerPort,
  SessionRunnerResumeRequest,
  SessionRunnerStartRequest,
  SessionRunnerStatusRequest
} from '../application/ports.js'
import type { DshSessionBindingPort } from './session-binding.js'

export type DshDriverOutcome = {
  state: 'succeeded' | 'failed' | 'cancelled'
  endedAt?: string
  exitCode?: number | null
  errorCode?: SessionRunnerErrorCode
}

export type DshDriverStatus =
  | { state: 'running' }
  | { state: 'cancelling' }
  | DshDriverOutcome
  | { state: 'not-found' }

export type DshDriverRun = {
  runnerId: string
  continuationToken: string
  startedAt?: string
  result: Promise<DshDriverOutcome>
}

/** Host-native seam. Implementations retain DSH AgentHandle ownership. */
export type DshRunDriver = {
  available(): boolean
  start(input: {
    runnerId: string
    prompt: string
    workingDirectory: string
    profile?: string
    quality?: string
  }): Promise<DshDriverRun>
  resume(input: {
    runnerId: string
    continuationToken: string
    prompt: string
    workingDirectory: string
    profile?: string
    quality?: string
  }): Promise<DshDriverRun>
  cancel(runnerId: string, reason?: string): Promise<DshDriverStatus>
  status(runnerId: string): Promise<DshDriverStatus>
  dispose(): Promise<void>
}

export type DshSessionRunnerControl = {
  port: SessionRunnerPort
  available(): boolean
  dispose(): Promise<void>
}

type RunRecord = {
  sessionId: string
  runnerId: string
  attemptId: string
  continuationToken: string
  state: SessionRunnerSnapshot['state']
  startedAt: string
  endedAt?: string
  exitCode?: number | null
  error?: SessionRunnerError
  events: SessionRunnerEvent[]
}

const MAX_RUNNER_EVENTS = 128

function ok<T>(value: T): SessionRunnerResult<T> {
  return { ok: true, value }
}

function failed<T>(error: SessionRunnerError): SessionRunnerResult<T> {
  return { ok: false, error }
}

function runnerError(code: SessionRunnerErrorCode, retryable: boolean): SessionRunnerError {
  return { code, retryable }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function snapshot(record: RunRecord): SessionRunnerSnapshot {
  return {
    runnerId: record.runnerId,
    attemptId: record.attemptId,
    state: record.state,
    continuationToken: record.continuationToken,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    exitCode: record.exitCode,
    error: record.error ? { ...record.error } : undefined
  }
}

function appendEvent(record: RunRecord, event: Omit<SessionRunnerEvent, 'sequence' | 'attemptId'>): void {
  const sequence = (record.events.at(-1)?.sequence || 0) + 1
  record.events = [...record.events, {
    sequence,
    attemptId: record.attemptId,
    ...event
  }].slice(-MAX_RUNNER_EVENTS)
}

function normalizeOutcome(value: DshDriverOutcome): DshDriverOutcome {
  if (value.state === 'succeeded' && value.exitCode !== undefined
    && value.exitCode !== null && value.exitCode !== 0) {
    return {
      ...value,
      state: 'failed',
      errorCode: 'RUNNER_PROTOCOL_ERROR'
    }
  }
  return value
}

export function createDshSessionRunner(options: {
  driver: DshRunDriver
  binding: DshSessionBindingPort
  now: () => string
  nextId: () => string
}): DshSessionRunnerControl {
  const records = new Map<string, RunRecord>()
  const observations = new Set<Promise<void>>()

  const settle = (record: RunRecord, outcome: DshDriverOutcome): void => {
    const current = records.get(record.runnerId)
    if (current !== record) return
    const normalized = normalizeOutcome(outcome)
    record.state = normalized.state
    record.endedAt = normalized.endedAt || options.now()
    record.exitCode = normalized.exitCode ?? (normalized.state === 'succeeded' ? 0 : normalized.state === 'failed' ? 1 : null)
    record.error = normalized.state === 'failed'
      ? runnerError(normalized.errorCode || 'RUNNER_PROTOCOL_ERROR', true)
      : undefined
    appendEvent(record, {
      type: normalized.state === 'succeeded'
        ? 'runner.succeeded'
        : normalized.state === 'cancelled'
          ? 'runner.cancelled'
          : 'runner.failed',
      at: record.endedAt,
      ...(record.error ? { code: record.error.code } : {})
    })
  }

  const observe = (record: RunRecord, result: Promise<DshDriverOutcome>): void => {
    const operation = result.then(
      (outcome) => settle(record, outcome),
      () => settle(record, {
        state: 'failed',
        endedAt: options.now(),
        exitCode: 1,
        errorCode: 'RUNNER_PROTOCOL_ERROR'
      })
    )
    observations.add(operation)
    void operation.finally(() => observations.delete(operation)).catch(() => undefined)
  }

  const publish = (
    input: SessionRunnerStartRequest | SessionRunnerResumeRequest,
    run: DshDriverRun
  ): SessionRunnerSnapshot => {
    const record: RunRecord = {
      sessionId: input.task.id,
      runnerId: run.runnerId,
      attemptId: input.attemptId,
      continuationToken: run.continuationToken,
      state: 'running',
      startedAt: run.startedAt || options.now(),
      events: []
    }
    appendEvent(record, { type: 'runner.started', at: record.startedAt })
    records.set(record.runnerId, record)
    observe(record, run.result)
    return snapshot(record)
  }

  const find = (input: SessionRunnerStatusRequest): RunRecord | null => {
    const record = records.get(input.runnerId)
    return record
      && record.sessionId === input.sessionId
      && record.attemptId === input.attemptId
      ? record
      : null
  }

  const refresh = async (record: RunRecord): Promise<void> => {
    if (!['starting', 'running', 'cancelling'].includes(record.state)) return
    const current = await options.driver.status(record.runnerId)
    if (current.state === 'not-found') {
      record.state = 'lost'
      record.endedAt = options.now()
      record.error = runnerError('RUNNER_NOT_FOUND', true)
      appendEvent(record, { type: 'runner.failed', at: record.endedAt, code: record.error.code })
      return
    }
    if (current.state === 'running' || current.state === 'cancelling') {
      record.state = current.state
      return
    }
    settle(record, current)
  }

  const port: SessionRunnerPort = {
    async start(input) {
      if (!options.driver.available()) return failed(runnerError('RUNNER_UNAVAILABLE', true))
      const binding = options.binding.read(input.task.id, input.attemptId)
      if (!binding || binding.task.id !== input.task.id) {
        return failed(runnerError('RUNNER_PROTOCOL_ERROR', false))
      }
      const runnerId = options.nextId()
      try {
        const run = await options.driver.start({
          runnerId,
          prompt: binding.prompt,
          workingDirectory: binding.workingDirectory,
          profile: input.options?.profile,
          quality: input.options?.quality
        })
        if (run.runnerId !== runnerId || !run.continuationToken) {
          return failed(runnerError('RUNNER_PROTOCOL_ERROR', false))
        }
        return ok(publish(input, run))
      } catch {
        return failed(runnerError('RUNNER_START_FAILED', true))
      }
    },
    async resume(input) {
      if (!options.driver.available()) return failed(runnerError('RUNNER_UNAVAILABLE', true))
      if (!input.runnerId || !input.continuationToken) {
        return failed(runnerError('RUNNER_INVALID_STATE', false))
      }
      const binding = options.binding.read(input.task.id, input.attemptId)
      if (!binding || binding.task.id !== input.task.id) {
        return failed(runnerError('RUNNER_PROTOCOL_ERROR', false))
      }
      try {
        const run = await options.driver.resume({
          runnerId: input.runnerId,
          continuationToken: input.continuationToken,
          prompt: binding.prompt,
          workingDirectory: binding.workingDirectory,
          profile: input.options?.profile,
          quality: input.options?.quality
        })
        if (run.runnerId !== input.runnerId || run.continuationToken !== input.continuationToken) {
          return failed(runnerError('RUNNER_PROTOCOL_ERROR', false))
        }
        return ok(publish(input, run))
      } catch {
        return failed(runnerError('RUNNER_RESUME_FAILED', true))
      }
    },
    async cancel(input: SessionRunnerCancelRequest) {
      const record = find(input)
      if (!record) return failed(runnerError('RUNNER_NOT_FOUND', false))
      if (record.state === 'cancelled') return ok(snapshot(record))
      if (record.state === 'succeeded' || record.state === 'failed' || record.state === 'lost') {
        return failed(runnerError('RUNNER_INVALID_STATE', false))
      }
      try {
        const current = await options.driver.cancel(record.runnerId, input.reason)
        if (current.state === 'not-found') return failed(runnerError('RUNNER_NOT_FOUND', false))
        if (current.state === 'running' || current.state === 'cancelling') {
          record.state = 'cancelling'
          appendEvent(record, { type: 'runner.progress', at: options.now() })
        } else {
          settle(record, current)
        }
        return ok(snapshot(record))
      } catch {
        return failed(runnerError('RUNNER_CANCEL_FAILED', true))
      }
    },
    async status(input: SessionRunnerStatusRequest) {
      const record = find(input)
      if (!record) return failed(runnerError('RUNNER_NOT_FOUND', true))
      try {
        await refresh(record)
        return ok(snapshot(record))
      } catch {
        return failed(runnerError('RUNNER_PROTOCOL_ERROR', true))
      }
    },
    async events(input: SessionRunnerEventsRequest) {
      const record = find(input)
      if (!record) return failed<SessionRunnerEventsPage>(runnerError('RUNNER_NOT_FOUND', true))
      const after = input.afterSequence ?? 0
      if (!Number.isSafeInteger(after) || after < 0) {
        return failed<SessionRunnerEventsPage>(runnerError('RUNNER_PROTOCOL_ERROR', false))
      }
      const events = record.events.filter((event) => event.sequence > after).map(clone)
      return ok({
        events,
        nextSequence: Math.max(after, ...record.events.map((event) => event.sequence), 0)
      })
    }
  }

  return {
    port,
    available: () => options.driver.available(),
    async dispose() {
      await options.driver.dispose()
      await Promise.allSettled([...observations])
    }
  }
}
