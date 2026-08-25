import type { DurableJsonSchema, DurableSchemaResolver } from '../adapters/durable-state.js'
import { createLocalDurableSchemaResolver } from '../adapters/local-durable-schema.js'

type RuntimeRecord = Record<string, unknown>
type Validation = { valid: true } | { valid: false; message: string }

const CURRENT_STATUSES = new Set(['queued', 'running', 'awaiting', 'failed', 'completed', 'cancelled'])
const SESSION_KINDS = new Set(['attach', 'detach', 'edit', 'chat', 'analyze'])
const RUNNER_STATES = new Set(['starting', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'lost'])
const RUNNER_ERROR_CODES = new Set([
  'RUNNER_UNAVAILABLE',
  'RUNNER_START_FAILED',
  'RUNNER_RESUME_FAILED',
  'RUNNER_CANCEL_FAILED',
  'RUNNER_NOT_FOUND',
  'RUNNER_INVALID_STATE',
  'RUNNER_PROTOCOL_ERROR'
])
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const BINDING_DOCUMENT = /^skill-review\/dsh-sessions\/[A-Za-z0-9][A-Za-z0-9._:-]{0,255}\/attempts\/[A-Za-z0-9][A-Za-z0-9._:-]{0,255}\/binding\.json$/

function ok(): Validation { return { valid: true } }
function invalid(message: string): Validation { return { valid: false, message } }
function record(value: unknown): value is RuntimeRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function string(value: unknown, max = 16_384, empty = false): value is string {
  return typeof value === 'string' && value.length <= max && (empty || value.length > 0)
}
function exactKeys(value: RuntimeRecord, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key))
}
function boundedJson(value: unknown, depth = 0, budget = { nodes: 0 }): boolean {
  budget.nodes += 1
  if (budget.nodes > 100_000 || depth > 48) return false
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'string') return value.length <= 1_000_000
  if (Array.isArray(value)) return value.length <= 10_000
    && value.every((entry) => boundedJson(entry, depth + 1, budget))
  return record(value) && Object.keys(value).length <= 2_000
    && Object.entries(value).every(([key, entry]) => key.length <= 1_024
      && boundedJson(entry, depth + 1, budget))
}

function validateTask(value: unknown, session: RuntimeRecord): boolean {
  return record(value)
    && value.taskVersion === 1
    && value.id === session.id
    && value.kind === session.kind
    && record(value.target)
    && string(value.target.kind, 32)
    && string(value.target.id, 256)
    && record(value.prompt)
    && string(value.prompt.summary, 4_096)
    && Array.isArray(value.prompt.instructions)
    && value.prompt.instructions.length <= 32
    && value.prompt.instructions.every((line) => string(line, 4_096))
    && Array.isArray(value.steps)
    && value.steps.length <= 32
    && record(value.completion)
    && record(value.capabilities)
    && boundedJson(value)
}

function validateStoredSession(value: unknown): boolean {
  if (!record(value) || !exactKeys(value, [
    'sessionSchemaVersion', 'id', 'kind', 'status', 'revision', 'attemptId', 'attemptNumber',
    'runnerEventSequence', 'cancelRequested', 'task', 'target', 'startedAt', 'steps', 'events'
  ], [
    'locator', 'intent', 'inboxIds', 'runnerId', 'continuationToken', 'runnerState',
    'runnerErrorCode', 'endedAt', 'exitCode', 'attachCompletion'
  ])) return false
  if (value.sessionSchemaVersion !== 1
    || typeof value.id !== 'string' || !SAFE_ID.test(value.id)
    || typeof value.kind !== 'string' || !SESSION_KINDS.has(value.kind)
    || typeof value.status !== 'string' || !CURRENT_STATUSES.has(value.status)
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1
    || typeof value.attemptId !== 'string' || !SAFE_ID.test(value.attemptId)
    || !Number.isSafeInteger(value.attemptNumber) || (value.attemptNumber as number) < 1
    || !Number.isSafeInteger(value.runnerEventSequence) || (value.runnerEventSequence as number) < 0
    || typeof value.cancelRequested !== 'boolean'
    || !validateTask(value.task, value)
    || !record(value.target) || !string(value.target.kind, 32) || !string(value.target.id, 256)
    || !string(value.startedAt, 64)
    || !Array.isArray(value.steps) || value.steps.length > 32 || !value.steps.every((entry) => boundedJson(entry))
    || !Array.isArray(value.events) || value.events.length > 256 || !value.events.every((entry) => boundedJson(entry))) return false
  if (value.locator !== undefined && (!record(value.locator)
    || value.locator.kind !== 'worktree' && value.locator.kind !== 'skill'
    || !string(value.locator.value, 8_192))) return false
  if (value.intent !== undefined && !string(value.intent, 16_384, true)) return false
  if (value.inboxIds !== undefined && (!Array.isArray(value.inboxIds)
    || value.inboxIds.length > 10_000
    || !value.inboxIds.every((id) => string(id, 256)))) return false
  if (value.runnerId !== undefined && (typeof value.runnerId !== 'string' || !SAFE_ID.test(value.runnerId))) return false
  if (value.continuationToken !== undefined
    && (typeof value.continuationToken !== 'string' || !SAFE_ID.test(value.continuationToken))) return false
  if (value.runnerState !== undefined
    && (typeof value.runnerState !== 'string' || !RUNNER_STATES.has(value.runnerState))) return false
  if (value.runnerErrorCode !== undefined
    && (typeof value.runnerErrorCode !== 'string' || !RUNNER_ERROR_CODES.has(value.runnerErrorCode))) return false
  if (value.endedAt !== undefined && !string(value.endedAt, 64)) return false
  if (value.exitCode !== undefined && value.exitCode !== null && !Number.isSafeInteger(value.exitCode)) return false
  if (value.attachCompletion !== undefined && !record(value.attachCompletion)) return false
  return boundedJson(value)
}

function validateSessions(value: unknown): Validation {
  if (!record(value)
    || !exactKeys(value, ['schemaVersion', 'sessions'])
    || value.schemaVersion !== 1
    || !Array.isArray(value.sessions)
    || value.sessions.length > 10_000
    || !value.sessions.every(validateStoredSession)) return invalid('DSH session document failed frozen validation')
  const ids = value.sessions.map((session) => (session as RuntimeRecord).id)
  return new Set(ids).size === ids.length ? ok() : invalid('DSH session document contains duplicate IDs')
}

function validateBinding(value: unknown): Validation {
  if (!record(value)
    || !exactKeys(value, [
      'bindingVersion', 'sessionId', 'attemptId', 'task', 'workingDirectory', 'prompt'
    ], ['locator'])
    || value.bindingVersion !== 1
    || typeof value.sessionId !== 'string' || !SAFE_ID.test(value.sessionId)
    || typeof value.attemptId !== 'string' || !SAFE_ID.test(value.attemptId)
    || !record(value.task) || value.task.taskVersion !== 1 || value.task.id !== value.sessionId
    || !string(value.workingDirectory, 8_192)
    || !string(value.prompt, 65_536)) return invalid('DSH session binding failed frozen validation')
  if (value.locator !== undefined && (!record(value.locator)
    || value.locator.kind !== 'worktree' && value.locator.kind !== 'skill'
    || !string(value.locator.value, 8_192))) return invalid('DSH session binding locator is invalid')
  return boundedJson(value) ? ok() : invalid('DSH session binding exceeds bounded JSON limits')
}

const DSH_SESSIONS: DurableJsonSchema = { name: 'DSH sessions', validate: validateSessions }
const DSH_BINDING: DurableJsonSchema = { name: 'DSH session binding', validate: validateBinding }

export function createDshDurableSchemaResolver(): DurableSchemaResolver {
  const fallback = createLocalDurableSchemaResolver()
  return (relativePath) => {
    if (relativePath === 'skill-review/dsh-sessions.json') return DSH_SESSIONS
    if (BINDING_DOCUMENT.test(relativePath)) return DSH_BINDING
    return fallback(relativePath)
  }
}
