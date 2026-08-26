import {
  AUDIT_EVENT_TYPES,
  CONTRACT_VERSION,
  HUB_ERROR_CODES,
  QUERY_COMMAND_KINDS,
  WRITE_COMMAND_KINDS,
  validateHubStateV2,
  validateLegacyMigrationRecordV1,
  validateLibrarySnapshotManifestV1,
  validateMaterializationCommitRecordV1
} from '../contracts/index.js'
import { validateLegacyHubStateV1 } from '../core/migration.js'
import {
  verifyLegacyMigrationRecordIdentity,
  verifyMaterializationMarker
} from '../core/materialization.js'
import { verifyLibrarySnapshotManifest } from '../core/snapshot.js'
import type { DurableJsonSchema, DurableSchemaResolver } from './durable-state.js'
import { validateWorktreeRegistry } from './local-worktree-registry.js'

const COMMAND_KINDS = new Set<string>([...QUERY_COMMAND_KINDS, ...WRITE_COMMAND_KINDS])
const AUDIT_TYPES = new Set<string>(AUDIT_EVENT_TYPES)
const ERROR_CODES = new Set<string>(HUB_ERROR_CODES)
const SESSION_KINDS = new Set(['attach', 'detach', 'edit', 'chat', 'analyze'])
const SESSION_STATUSES = new Set(['queued', 'running', 'awaiting', 'waiting', 'completed', 'failed', 'cancelled'])
const RUNNER_STATES = new Set(['starting', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'lost'])
const RUNNER_ERROR_CODES = new Set([
  'RUNNER_UNAVAILABLE', 'RUNNER_NOT_FOUND', 'RUNNER_INVALID_STATE', 'RUNNER_START_FAILED',
  'RUNNER_RESUME_FAILED', 'RUNNER_CANCEL_FAILED', 'RUNNER_PROTOCOL_ERROR'
])
const SHA256_HEX = /^[a-f0-9]{64}$/
const SHA256_IDENTIFIER = /^sha256:[a-f0-9]{64}$/
const WORKTREE_TARGET_ID = /^worktree:[a-f0-9]{24}$/
const SNAPSHOT_DOCUMENT = /^skill-review\/library\/snapshots\/[a-f0-9]{64}\.json$/
const MATERIALIZATION_CURRENT_DOCUMENT = /^skill-review\/materializations\/current\/([a-f0-9]{64})\.json$/
const LEGACY_MIGRATION_DOCUMENT = /^skill-review\/materializations\/migrations\/([a-f0-9]{64})\.json$/
const HISTORY_DOCUMENT = /^skill-review\/history\/[A-Za-z0-9][A-Za-z0-9._-]{0,159}\.json$/

type Validation = { valid: true } | { valid: false; message: string }
type RuntimeRecord = Record<string, unknown>

function ok(): Validation {
  return { valid: true }
}

function invalid(message: string): Validation {
  return { valid: false, message }
}

function record(value: unknown): value is RuntimeRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(
  value: RuntimeRecord,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key))
}

function boundedString(value: unknown, max = 16_384, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= max && (allowEmpty || value.length > 0)
}

function isoDate(value: unknown): value is string {
  if (!boundedString(value, 64)
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false
  const epoch = Date.parse(value)
  if (!Number.isFinite(epoch)) return false
  return new Date(epoch).toISOString() === (value.includes('.') ? value : value.replace(/Z$/u, '.000Z'))
}

function jsonValue(value: unknown, depth = 0, budget = { nodes: 0 }): boolean {
  budget.nodes += 1
  if (budget.nodes > 200_000 || depth > 64) return false
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'string') return value.length <= 1_000_000
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.length <= 100_000
    && value.every((entry) => jsonValue(entry, depth + 1, budget))
  if (!record(value) || Object.keys(value).length > 10_000) return false
  return Object.entries(value).every(([key, entry]) => key.length <= 4_096
    && jsonValue(entry, depth + 1, budget))
}

function validateKnownState(value: unknown): Validation {
  if (record(value) && value.schemaVersion === 2) {
    return validateHubStateV2(value).valid ? ok() : invalid('HubStateV2 failed frozen validation')
  }
  return validateLegacyHubStateV1(value).valid
    ? ok()
    : invalid('legacy Hub state failed frozen validation')
}

function validateReadableState(value: unknown): Validation {
  const known = validateKnownState(value)
  if (known.valid) return known
  if (!record(value) || !jsonValue(value)) return invalid('Hub state failed bounded inspection validation')
  const schemaVersion = value.schemaVersion
  const legacyVersion = value.version
  if (schemaVersion !== undefined
    && (!Number.isSafeInteger(schemaVersion) || (schemaVersion as number) < 0)
    || legacyVersion !== undefined
      && (!Number.isSafeInteger(legacyVersion) || (legacyVersion as number) < 0)
    || schemaVersion !== undefined && legacyVersion !== undefined && schemaVersion !== legacyVersion) {
    return invalid('Hub state version descriptor is invalid')
  }
  const declared = schemaVersion ?? legacyVersion
  return typeof declared === 'number' && declared !== 1 && declared !== 2
    ? ok()
    : invalid('Hub state failed frozen validation')
}

function validateAuditEvent(value: unknown): boolean {
  if (!record(value) || !exactKeys(value, [
    'eventVersion', 'id', 'type', 'at', 'requestId', 'hostId', 'transport',
    'commandKind', 'outcome'
  ], ['subject', 'details'])) return false
  return value.eventVersion === CONTRACT_VERSION
    && boundedString(value.id, 256)
    && typeof value.type === 'string' && AUDIT_TYPES.has(value.type)
    && isoDate(value.at)
    && boundedString(value.requestId, 160)
    && boundedString(value.hostId, 64)
    && boundedString(value.transport, 64)
    && typeof value.commandKind === 'string' && COMMAND_KINDS.has(value.commandKind)
    && typeof value.outcome === 'string' && ['started', 'succeeded', 'failed', 'rejected'].includes(value.outcome)
    && (value.subject === undefined || boundedString(value.subject, 512))
    && (value.details === undefined || record(value.details) && jsonValue(value.details))
}

function validateResultEnvelope(value: unknown, requestId: string, commandKind: string): boolean {
  if (!record(value) || value.contractVersion !== CONTRACT_VERSION
    || value.requestId !== requestId || value.commandKind !== commandKind
    || typeof value.ok !== 'boolean' || !Array.isArray(value.events)
    || !value.events.every(validateAuditEvent) || !record(value.meta)
    || !exactKeys(value.meta, ['replayed', 'handler'])
    || typeof value.meta.replayed !== 'boolean' || value.meta.handler !== 'application.commandBus') return false
  if (value.ok) {
    return exactKeys(value, ['contractVersion', 'requestId', 'commandKind', 'ok', 'data', 'events', 'meta'])
      && jsonValue(value.data)
  }
  if (!exactKeys(value, ['contractVersion', 'requestId', 'commandKind', 'ok', 'error', 'events', 'meta'], ['context'])
    || !record(value.error)
    || !exactKeys(value.error, ['code', 'message', 'retryable'], ['details'])
    || typeof value.error.code !== 'string' || !ERROR_CODES.has(value.error.code)
    || !boundedString(value.error.message, 4_096)
    || typeof value.error.retryable !== 'boolean'
    || value.error.details !== undefined && (!record(value.error.details) || !jsonValue(value.error.details))) return false
  return value.context === undefined || record(value.context) && jsonValue(value.context)
}

function validateLedgerEntry(value: unknown): boolean {
  if (!record(value) || !exactKeys(value, [
    'requestId', 'digest', 'commandKind', 'status', 'startedAt'
  ], ['completedAt', 'result'])) return false
  if (!boundedString(value.requestId, 160)
    || typeof value.digest !== 'string' || !SHA256_HEX.test(value.digest)
    || typeof value.commandKind !== 'string' || !COMMAND_KINDS.has(value.commandKind)
    || value.status !== 'started' && value.status !== 'completed'
    || !isoDate(value.startedAt)) return false
  if (value.status === 'started') return value.completedAt === undefined && value.result === undefined
  return isoDate(value.completedAt)
    && validateResultEnvelope(value.result, value.requestId, value.commandKind)
}

function validateLedger(value: unknown): Validation {
  if (!record(value) || !exactKeys(value, ['version', 'entries'], ['events'])
    || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > 100_000
    || !value.entries.every(validateLedgerEntry)
    || value.events !== undefined && (!Array.isArray(value.events)
      || value.events.length > 200_000 || !value.events.every(validateAuditEvent))) {
    return invalid('request ledger failed frozen validation')
  }
  const ids = new Set(value.entries.map((entry) => (entry as RuntimeRecord).requestId))
  return ids.size === value.entries.length ? ok() : invalid('request ledger contains duplicate request IDs')
}

function validateAudit(value: unknown): Validation {
  if (!record(value) || !exactKeys(value, ['version', 'events']) || value.version !== 1
    || !Array.isArray(value.events) || value.events.length > 200_000
    || !value.events.every(validateAuditEvent)) return invalid('audit document failed frozen validation')
  const ids = new Set(value.events.map((event) => (event as RuntimeRecord).id))
  return ids.size === value.events.length ? ok() : invalid('audit document contains duplicate event IDs')
}

function validateSession(value: unknown): boolean {
  if (!record(value) || !exactKeys(value, [
    'id', 'kind', 'path', 'worktree', 'intent', 'pid', 'promptFile', 'logFile',
    'lastFile', 'startedAt', 'status', 'exitCode', 'error', 'codexSessionId'
  ], [
    'model', 'effort', 'summary', 'lastMessage', 'endedAt', 'canResume',
    'inboxIds', 'attachCompletion', 'sessionSchemaVersion', 'revision', 'attemptId',
    'attemptNumber', 'runnerId', 'runnerState', 'runnerErrorCode', 'runnerEventSequence',
    'cancelRequested', 'task', 'target', 'steps', 'events', 'runnerArtifacts'
  ])) return false
  const p5 = value.sessionSchemaVersion === 2
  const completion = value.attachCompletion
  const completionValid = completion === undefined || record(completion)
    && exactKeys(completion, ['targetId', 'pathKey', 'materializationId', 'completedAt'])
    && typeof completion.targetId === 'string' && WORKTREE_TARGET_ID.test(completion.targetId)
    && typeof completion.pathKey === 'string' && SHA256_IDENTIFIER.test(completion.pathKey)
    && typeof completion.materializationId === 'string' && SHA256_IDENTIFIER.test(completion.materializationId)
    && isoDate(completion.completedAt)
    && value.kind === 'attach'
    && value.status === 'completed'
    && value.exitCode === 0
    && (p5 || value.canResume === false)
  const runnerArtifactsValid = value.runnerArtifacts === undefined || record(value.runnerArtifacts)
    && exactKeys(value.runnerArtifacts, [
      'attemptRoot', 'requestPath', 'promptPath', 'stdoutPath', 'stderrPath', 'eventsPath',
      'lastMessagePath', 'cancelPath', 'statusPath', 'receiptPath', 'launchPath', 'codexHome',
      'isolatedHome'
    ])
    && Object.values(value.runnerArtifacts).every((entry) => boundedString(entry, 8_192))
  const p5Valid = !p5 || Number.isSafeInteger(value.revision) && (value.revision as number) >= 1
    && boundedString(value.attemptId, 256)
    && Number.isSafeInteger(value.attemptNumber) && (value.attemptNumber as number) >= 1
    && (value.runnerId === undefined || boundedString(value.runnerId, 256))
    && (value.runnerState === undefined || typeof value.runnerState === 'string' && RUNNER_STATES.has(value.runnerState))
    && (value.runnerErrorCode === undefined || typeof value.runnerErrorCode === 'string' && RUNNER_ERROR_CODES.has(value.runnerErrorCode))
    && Number.isSafeInteger(value.runnerEventSequence) && (value.runnerEventSequence as number) >= 0
    && typeof value.cancelRequested === 'boolean'
    && record(value.task) && jsonValue(value.task)
    && record(value.target) && jsonValue(value.target)
    && Array.isArray(value.steps) && value.steps.length <= 32 && value.steps.every((entry) => record(entry) && jsonValue(entry))
    && Array.isArray(value.events) && value.events.length <= 256 && value.events.every((entry) => record(entry) && jsonValue(entry))
    && runnerArtifactsValid
    && value.status !== 'waiting'
  return boundedString(value.id, 256)
    && typeof value.kind === 'string' && SESSION_KINDS.has(value.kind)
    && ['path', 'worktree', 'intent', 'promptFile', 'logFile', 'lastFile', 'error', 'codexSessionId']
      .every((key) => boundedString(value[key], key === 'intent' || key === 'error' ? 65_536 : 8_192, true))
    && Number.isSafeInteger(value.pid) && (value.pid as number) >= 0
    && isoDate(value.startedAt)
    && typeof value.status === 'string' && SESSION_STATUSES.has(value.status)
    && (value.exitCode === null || Number.isSafeInteger(value.exitCode))
    && ['model', 'effort', 'summary', 'lastMessage', 'endedAt'].every((key) => value[key] === undefined
      || boundedString(value[key], key === 'summary' || key === 'lastMessage' ? 1_000_000 : 8_192, true))
    && (value.canResume === undefined || typeof value.canResume === 'boolean')
    && (value.inboxIds === undefined || Array.isArray(value.inboxIds) && value.inboxIds.length <= 10_000
      && value.inboxIds.every((id) => boundedString(id, 256)))
    && completionValid
    && p5Valid
}

function validateSessions(value: unknown): Validation {
  if (!record(value) || !exactKeys(value, ['sessions']) || !Array.isArray(value.sessions)
    || value.sessions.length > 10_000 || !value.sessions.every(validateSession)) {
    return invalid('session document failed frozen validation')
  }
  const ids = new Set(value.sessions.map((session) => (session as RuntimeRecord).id))
  return ids.size === value.sessions.length ? ok() : invalid('session document contains duplicate IDs')
}

function validateHistory(value: unknown): Validation {
  if (!record(value) || typeof value.type !== 'string') {
    return invalid('history record failed frozen validation')
  }
  if (value.type === 'ingest') {
    if (!exactKeys(value, ['type', 'count', 'lastIngest'])
      || !Number.isSafeInteger(value.count) || (value.count as number) <= 0
      || value.lastIngest !== null && (!record(value.lastIngest)
        || !exactKeys(value.lastIngest, ['ref', 'old', 'new', 'gameRepo'])
        || !['ref', 'old', 'new', 'gameRepo'].every((key) => boundedString(
          (value.lastIngest as RuntimeRecord)[key],
          key === 'gameRepo' ? 4_096 : 1_024
        )))) return invalid('ingest history record failed frozen validation')
    return ok()
  }
  if (value.type === 'decide') {
    if (!exactKeys(value, ['type', 'id', 'action'], ['note', 'mergeTarget'])
      || !boundedString(value.id, 512)
      || typeof value.action !== 'string' || !['adopt', 'merge', 'reject'].includes(value.action)
      || value.note !== undefined && !boundedString(value.note, 16_384, true)
      || value.mergeTarget !== undefined && !boundedString(value.mergeTarget, 512)) {
      return invalid('decision history record failed frozen validation')
    }
    return ok()
  }
  if (value.type === 'codex-session') {
    if (!exactKeys(value, ['type', 'kind', 'path', 'worktree', 'sessionId'])
      || typeof value.kind !== 'string' || !SESSION_KINDS.has(value.kind)
      || !boundedString(value.path, 8_192, true)
      || !boundedString(value.worktree, 8_192, true)
      || !boundedString(value.sessionId, 256)) {
      return invalid('session history record failed frozen validation')
    }
    return ok()
  }
  return invalid('history record type is unsupported')
}

function validateSnapshot(value: unknown): Validation {
  const validation = validateLibrarySnapshotManifestV1(value)
  return validation.valid && validation.value.files.length <= 20_000
    && verifyLibrarySnapshotManifest(validation.value)
    ? ok()
    : invalid('snapshot manifest failed frozen validation')
}

function validateMaterializationCurrent(value: unknown): Validation {
  const validation = validateMaterializationCommitRecordV1(value)
  return validation.valid
    && (validation.value.marker == null || verifyMaterializationMarker(validation.value.marker))
    ? ok()
    : invalid('materialization commit record failed frozen validation')
}

function validateLegacyMigration(value: unknown): Validation {
  const validation = validateLegacyMigrationRecordV1(value)
  return validation.valid && verifyLegacyMigrationRecordIdentity(validation.value)
    ? ok()
    : invalid('legacy migration record failed frozen validation')
}

const SCHEMAS = {
  state: {
    name: 'Hub state',
    validate: validateReadableState,
    validateWrite: validateKnownState
  },
  ledger: { name: 'request ledger', validate: validateLedger },
  audit: { name: 'audit events', validate: validateAudit },
  sessions: { name: 'sessions', validate: validateSessions },
  history: { name: 'history record', validate: validateHistory },
  snapshot: { name: 'library snapshot manifest', validate: validateSnapshot },
  materializationCurrent: { name: 'materialization commit record', validate: validateMaterializationCurrent },
  legacyMigration: { name: 'legacy migration record', validate: validateLegacyMigration },
  worktreeRegistry: {
    name: 'worktree registry',
    validate: (value: unknown) => validateWorktreeRegistry(value)
      ? ok()
      : invalid('worktree registry failed frozen validation')
  }
} satisfies Record<string, DurableJsonSchema>

export function createLocalDurableSchemaResolver(): DurableSchemaResolver {
  return (relativePath) => {
    switch (relativePath) {
      case 'skill-review/state.json': return SCHEMAS.state
      case 'skill-review/application-ledger.json': return SCHEMAS.ledger
      case 'skill-review/application-audit.json': return SCHEMAS.audit
      case 'skill-review/sessions.json': return SCHEMAS.sessions
      case 'skill-review/worktree-registry.json': return SCHEMAS.worktreeRegistry
      default:
        if (HISTORY_DOCUMENT.test(relativePath)) return SCHEMAS.history
        if (SNAPSHOT_DOCUMENT.test(relativePath)) return SCHEMAS.snapshot
        if (MATERIALIZATION_CURRENT_DOCUMENT.test(relativePath)) {
          const expectedPathKey = `sha256:${relativePath.match(MATERIALIZATION_CURRENT_DOCUMENT)?.[1] ?? ''}`
          return {
            ...SCHEMAS.materializationCurrent,
            validate(value) {
              const base = validateMaterializationCurrent(value)
              if (!base.valid) return base
              const validation = validateMaterializationCommitRecordV1(value)
              return validation.valid && validation.value.pathKey === expectedPathKey
                ? ok()
                : invalid('materialization commit record path key does not match its durable target')
            }
          }
        }
        if (LEGACY_MIGRATION_DOCUMENT.test(relativePath)) {
          const expectedMigrationId = `sha256:${relativePath.match(LEGACY_MIGRATION_DOCUMENT)?.[1] ?? ''}`
          return {
            ...SCHEMAS.legacyMigration,
            validate(value) {
              const base = validateLegacyMigration(value)
              if (!base.valid) return base
              const validation = validateLegacyMigrationRecordV1(value)
              return validation.valid && validation.value.migrationId === expectedMigrationId
                ? ok()
                : invalid('legacy migration record ID does not match its durable target')
            }
          }
        }
        return undefined
    }
  }
}
