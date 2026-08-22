import {
  CONTRACT_VERSION,
  HUB_STATE_SCHEMA_VERSION,
  QUERY_COMMAND_KINDS,
  UNKNOWN_COMMAND_KIND,
  WORKTREE_PIN_SCHEMA_VERSION,
  WRITE_COMMAND_KINDS,
  type AuditEvent,
  type CommandDataByKind,
  type HubCommand,
  type HubCommandKind,
  type HubCommandResult,
  type HubError,
  type HubErrorCode,
  type HubStateV2,
  type InboxItemView,
  type LegacyAttachSourcePolicy,
  type LegacyMigrationPlanV1,
  type LegacyMigrationRecordV1,
  type LegacyRollbackPlanV1,
  type LibrarySnapshotManifestV1,
  type MaterializationCommitRecordV1,
  type MaterializationMarkerV1,
  type MaterializePlanV1,
  type Sha256Identifier,
  type SessionKind,
  type SessionTarget,
  type SessionView,
  type RuntimeAssetManifestV1,
  type WorktreePinV1,
  type WriteCommandKind,
  isPortableOpaqueIdentifier,
  validateHubStateV2,
  validateLibrarySnapshotManifestV1,
  validateMaterializationCommitRecordV1
} from '../contracts/index.js'
import { planLegacyAttach, type LegacyAttachPlanDecision } from '../core/legacy-attach.js'
import { planLegacyDetach, type LegacyDetachPlanDecision } from '../core/legacy-detach.js'
import { describeDecision, planDecision } from '../core/decision-plan.js'
import {
  planAnalyzeCompletion,
  type AnalyzeCompletionFact
} from '../core/analyze-completion-plan.js'
import {
  discoverIngestCandidates,
  INGEST_WATCHED_PATHS,
  parseIngestTransactions,
  planIngest,
  type IngestCandidateSnapshot,
  type IngestTransactionFact
} from '../core/ingest-plan.js'
import {
  decideFirstAttach,
  evaluateClaim,
  recognizeWorktree
} from '../core/policies.js'
import {
  planV1ToV2Migration,
  validateLegacyHubStateV1,
  verifyMigrationPlanHash,
  type LegacyHubStateV1
} from '../core/migration.js'
import {
  canonicalJson,
  compareUtf8Bytes,
  type CanonicalJsonValue
} from '../core/canonical.js'
import { createLibrarySnapshotManifest, verifyLibrarySnapshotManifest } from '../core/snapshot.js'
import {
  rollbackMaterializedWorktreePin,
  transitionWorktreePin
} from '../core/worktree-pin.js'
import {
  planLegacyMigration,
  planLegacyRollback,
  planMaterialization,
  validateSelectedMaterializationSkills,
  verifyLegacyMigrationPlanHash,
  verifyLegacyMigrationRecordIdentity,
  verifyLegacyRollbackPlanHash,
  verifyMaterializationMarker,
  verifyMaterializePlanHash,
  verifyRuntimeAssetManifest
} from '../core/materialization.js'
import {
  projectHubStatus,
  projectSkillInventory,
  projectWorktreeList
} from '../core/query-projections.js'
import type {
  ApplicationRecoveryPort,
  ApplicationRuntimePort,
  HubQueryPort,
  InvocationTracePort,
  LegacyAttachPort,
  LegacyDetachPort,
  P2ApplicationPorts,
  RequestLedgerEntry,
  RequestLedgerPort,
  SessionPort,
  SessionStartRequest,
  WorktreeIdentity
} from './ports.js'
import type { HubStateRepositoryPort } from './use-case-ports.js'
import type { P3ApplicationPorts } from './materialize-port.js'
import {
  APPLICATION_TRANSACTION_ERROR_CODES,
  isApplicationTransactionError,
  type ApplicationTransactionError,
  type ApplicationTransactionIdentity,
  type ApplicationTransactionPort,
  type ApplicationWriteTransaction
} from './transaction-port.js'
import type { SharedUseCasePorts } from './use-case-ports.js'
import { portFaultError } from './port-fault.js'

const QUERY_KINDS = new Set<string>(QUERY_COMMAND_KINDS)
const WRITE_KINDS = new Set<string>(WRITE_COMMAND_KINDS)
const SHA256_IDENTIFIER = /^sha256:[0-9a-f]{64}$/
const GAME_REPOSITORY_ID_DOMAIN = 'skill-graft/game-repository-identity/v1'

class ApplicationFault extends Error {
  constructor(
    readonly code: HubErrorCode,
    message: string,
    readonly retryable = false
  ) {
    super(message)
  }
}

export type HubApplication = {
  execute(command: HubCommand): Promise<HubCommandResult>
}

export type HubApplicationOptions = {
  runtime: ApplicationRuntimePort
  recovery?: ApplicationRecoveryPort
  queries: HubQueryPort
  useCases: SharedUseCasePorts
  legacyAttach: LegacyAttachPort
  legacyDetach: LegacyDetachPort
  sessions: SessionPort
  ledger: RequestLedgerPort
  p2: P2ApplicationPorts
  p3?: P3ApplicationPorts
  transactions: ApplicationTransactionPort
  trace?: InvocationTracePort
  handler?: 'application.commandBus'
}

function canonical(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
}

function digestPayload(command: HubCommand): unknown {
  const { meta: _meta, ...payload } = command
  switch (command.kind) {
    case 'applyLegacyAttach':
      return {
        ...payload,
        sourcePolicy: command.sourcePolicy ?? 'requireMatch',
        visibility: command.visibility ?? 'disable',
        configureGit: command.configureGit ?? false
      }
    case 'ingest':
      return {
        ...payload,
        gameRepo: command.gameRepo || null,
        dispatch: command.dispatch ?? false,
        dryRun: command.dryRun ?? false
      }
    case 'setPin':
      return {
        ...payload,
        ...(command.selectedSkills === undefined
          ? {}
          : { selectedSkills: [...command.selectedSkills].sort(compareUtf8Bytes) })
      }
    case 'attach':
    case 'detach':
    case 'edit':
    case 'chat':
    case 'analyze':
    case 'resumeSession':
      return {
        ...payload,
        runner: {
          ...(command.runner || {}),
          start: command.runner?.start ?? true,
          wait: command.runner?.wait ?? false
        }
      }
    default:
      return payload
  }
}

function commandDigest(runtime: ApplicationRuntimePort, command: HubCommand): string {
  return runtime.sha256(canonical({ contractVersion: command.meta.contractVersion, ...digestPayload(command) as object }))
}

const TRANSACTION_ERROR_CODES = new Set<string>(APPLICATION_TRANSACTION_ERROR_CODES)

function transactionErrorOf(value: unknown): HubError | null {
  if (!isApplicationTransactionError(value)) return null
  const error = value as ApplicationTransactionError & { retryAfterMs?: unknown }
  if (typeof error.code !== 'string' || !TRANSACTION_ERROR_CODES.has(error.code)) return null
  const code = error.code as ApplicationTransactionError['code']
  const retryAfter = typeof error.details?.retryAfterMs === 'number'
    ? error.details.retryAfterMs
    : typeof error.retryAfterMs === 'number'
      ? error.retryAfterMs
      : undefined
  const details = Number.isSafeInteger(retryAfter) && (retryAfter as number) >= 0
    ? { retryAfterMs: retryAfter as number }
    : undefined
  if (code === 'LOCK_BUSY') {
    return { code, message: 'write lock is busy', retryable: true, details }
  }
  if (code === 'LOCK_NOT_OWNED') {
    return { code, message: 'write lease is no longer owned', retryable: true }
  }
  if (code === 'STATE_CORRUPT') {
    return { code, message: 'durable state is corrupt', retryable: false }
  }
  if (code === 'SNAPSHOT_INVALID') {
    return { code, message: 'library snapshot is invalid', retryable: false }
  }
  if (code === 'RUNTIME_ASSET_INVALID') {
    return { code, message: 'runtime assets are invalid', retryable: false }
  }
  if (code === 'MATERIALIZATION_MARKER_INVALID') {
    return { code, message: 'materialization marker is invalid', retryable: false }
  }
  if (code === 'LEGACY_PLAN_STALE') {
    return { code, message: 'legacy materialization plan is stale', retryable: false }
  }
  if (code === 'UNSUPPORTED_LAYOUT') {
    return { code, message: 'worktree layout is unsupported', retryable: false }
  }
  return { code: 'PORT_FAILURE', message: 'write transaction failed', retryable: true }
}

function errorOf(error: unknown): HubError {
  if (error instanceof ApplicationFault) {
    return { code: error.code, message: error.message, retryable: error.retryable }
  }
  return transactionErrorOf(error) || portFaultError(error) || {
    code: 'PORT_FAILURE',
    message: 'host operation failed',
    retryable: true
  }
}

function resultEnvelope(
  command: HubCommand,
  data: unknown,
  events: readonly AuditEvent[] = [],
  replayed = false
): HubCommandResult {
  return {
    contractVersion: CONTRACT_VERSION,
    requestId: command.meta.requestId,
    commandKind: command.kind,
    ok: true,
    data,
    events,
    meta: { replayed, handler: 'application.commandBus' }
  } as HubCommandResult
}

function failureEnvelope(
  command: HubCommand,
  error: HubError,
  events: readonly AuditEvent[] = [],
  replayed = false
): HubCommandResult {
  const unsafe = command as unknown as { kind?: unknown; meta?: { requestId?: unknown } }
  const commandKind = typeof unsafe?.kind === 'string'
    && (QUERY_KINDS.has(unsafe.kind) || WRITE_KINDS.has(unsafe.kind))
    ? unsafe.kind as HubCommandKind
    : UNKNOWN_COMMAND_KIND
  const requestId = validIdentifier(unsafe?.meta?.requestId, 160)
    ? unsafe.meta.requestId
    : ''
  return {
    contractVersion: CONTRACT_VERSION,
    requestId,
    commandKind,
    ok: false,
    error,
    events,
    meta: { replayed, handler: 'application.commandBus' }
  } as HubCommandResult
}

type RuntimeRecord = Record<string, unknown>

const SESSION_STATUSES = new Set(['queued', 'running', 'waiting', 'completed', 'failed', 'cancelled'])
const DECISION_ACTIONS = new Set(['adopt', 'merge', 'reject'])
const LEGACY_SOURCE_POLICIES = new Set(['requireMatch', 'preferLibrary', 'promoteFromWorktree'])
const LEGACY_VISIBILITY_MODES = new Set(['disable', 'preserve'])
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const SKILL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function isRecord(value: unknown): value is RuntimeRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(message: string): never {
  throw new ApplicationFault('INVALID_ARGUMENT', message)
}

function assertAllowedFields(command: RuntimeRecord, payloadFields: readonly string[]) {
  const allowed = new Set(['kind', 'meta', ...payloadFields])
  const unexpected = Object.keys(command).find((key) => !allowed.has(key))
  if (unexpected) invalid('command contains unsupported fields')
}

function requireString(command: RuntimeRecord, field: string, allowEmpty = false): string {
  const value = command[field]
  if (typeof value !== 'string' || !allowEmpty && !value.trim()) invalid(`${field} must be a non-empty string`)
  return value
}

function validIdentifier(value: unknown, maxLength = 128): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && SAFE_IDENTIFIER.test(value)
}

function requireIdentifier(command: RuntimeRecord, field: string, maxLength = 128): string {
  const value = command[field]
  if (!validIdentifier(value, maxLength)) invalid(`${field} must be a safe identifier`)
  return value
}

function optionalIdentifier(command: RuntimeRecord, field: string, maxLength = 128) {
  const value = command[field]
  if (value !== undefined && !validIdentifier(value, maxLength)) invalid(`${field} must be a safe identifier`)
}

function optionalString(command: RuntimeRecord, field: string, allowEmpty = true) {
  const value = command[field]
  if (value === undefined) return
  if (typeof value !== 'string' || !allowEmpty && !value.trim()) invalid(`${field} must be a string`)
}

function optionalBoolean(command: RuntimeRecord, field: string) {
  const value = command[field]
  if (value !== undefined && typeof value !== 'boolean') invalid(`${field} must be a boolean`)
}

function requireSha256(command: RuntimeRecord, field: string): Sha256Identifier {
  const value = command[field]
  if (typeof value !== 'string' || !SHA256_IDENTIFIER.test(value)) {
    invalid(`${field} must be a full lowercase SHA-256 identifier`)
  }
  return value as Sha256Identifier
}

function validateSelectedSkills(value: unknown): void {
  if (value === undefined) return
  if (!Array.isArray(value) || value.length > 512) invalid('selectedSkills must be an array of skill identifiers')
  const seen = new Set<string>()
  for (const skill of value) {
    if (typeof skill !== 'string' || !SKILL_IDENTIFIER.test(skill)) {
      invalid('selectedSkills must contain only skill identifiers')
    }
    const folded = skill.toLocaleLowerCase('en-US')
    if (seen.has(folded)) invalid('selectedSkills must not contain portable duplicates')
    seen.add(folded)
  }
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object') return false
  if (ancestors.has(value)) return false
  ancestors.add(value)
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, ancestors))
    : Object.values(value as RuntimeRecord).every((item) => isJsonValue(item, ancestors))
  ancestors.delete(value)
  return valid
}

function validateRunner(value: unknown) {
  if (value === undefined) return
  if (!isRecord(value)) invalid('runner must be an object')
  const unexpected = Object.keys(value).find((key) => !['profile', 'quality', 'start', 'wait', 'metadata'].includes(key))
  if (unexpected) invalid('runner contains unsupported fields')
  optionalString(value, 'profile', false)
  optionalString(value, 'quality', false)
  optionalBoolean(value, 'start')
  optionalBoolean(value, 'wait')
  if (value.metadata !== undefined && (!isRecord(value.metadata) || !isJsonValue(value.metadata))) {
    invalid('runner.metadata must be a JSON object')
  }
}

function validatePayload(command: HubCommand) {
  const value = command as unknown as RuntimeRecord
  switch (command.kind) {
    case 'status':
    case 'listSkills':
    case 'listWorktrees':
    case 'inspectSchema':
    case 'listSnapshots':
    case 'createSnapshot':
      assertAllowedFields(value, [])
      return
    case 'readSkill':
      assertAllowedFields(value, ['path'])
      requireString(value, 'path')
      return
    case 'listHistory':
      assertAllowedFields(value, ['cursor', 'limit'])
      optionalString(value, 'cursor')
      if (value.limit !== undefined && (typeof value.limit !== 'number' || !Number.isFinite(value.limit))) {
        invalid('limit must be a finite number')
      }
      return
    case 'listSessions':
      assertAllowedFields(value, ['statuses'])
      if (value.statuses !== undefined && (!Array.isArray(value.statuses) || value.statuses.some((item) => typeof item !== 'string' || !SESSION_STATUSES.has(item)))) {
        invalid('statuses must contain only supported session statuses')
      }
      return
    case 'getSession':
      assertAllowedFields(value, ['sessionId'])
      requireIdentifier(value, 'sessionId')
      return
    case 'getSnapshot':
      assertAllowedFields(value, ['snapshotId'])
      requireSha256(value, 'snapshotId')
      return
    case 'getPin':
      assertAllowedFields(value, ['worktree'])
      requireString(value, 'worktree')
      return
    case 'planSync':
      assertAllowedFields(value, ['worktree'])
      requireString(value, 'worktree')
      return
    case 'repairLegacy':
      assertAllowedFields(value, ['worktree'])
      requireString(value, 'worktree')
      return
    case 'applyLegacyAttach':
      assertAllowedFields(value, ['worktree', 'sessionId', 'sourcePolicy', 'visibility', 'configureGit'])
      requireString(value, 'worktree')
      optionalIdentifier(value, 'sessionId')
      if (value.sourcePolicy !== undefined
        && (typeof value.sourcePolicy !== 'string' || !LEGACY_SOURCE_POLICIES.has(value.sourcePolicy))) {
        invalid('sourcePolicy must be requireMatch, preferLibrary, or promoteFromWorktree')
      }
      if (value.visibility !== undefined
        && (typeof value.visibility !== 'string' || !LEGACY_VISIBILITY_MODES.has(value.visibility))) {
        invalid('visibility must be disable or preserve')
      }
      optionalBoolean(value, 'configureGit')
      return
    case 'applyLegacyDetach':
      assertAllowedFields(value, ['worktree', 'sessionId'])
      requireString(value, 'worktree')
      optionalIdentifier(value, 'sessionId')
      return
    case 'ingest':
      assertAllowedFields(value, ['gameRepo', 'payload', 'dispatch', 'dryRun'])
      requireString(value, 'payload', true)
      if (value.gameRepo !== undefined && value.gameRepo !== null && typeof value.gameRepo !== 'string') {
        invalid('gameRepo must be a string or null')
      }
      optionalBoolean(value, 'dispatch')
      optionalBoolean(value, 'dryRun')
      return
    case 'decide':
      assertAllowedFields(value, ['id', 'action', 'note', 'mergeTarget'])
      requireIdentifier(value, 'id')
      if (typeof value.action !== 'string' || !DECISION_ACTIONS.has(value.action)) {
        invalid('action must be adopt, merge, or reject')
      }
      optionalString(value, 'note')
      optionalString(value, 'mergeTarget')
      return
    case 'attach':
    case 'detach':
      assertAllowedFields(value, ['worktree', 'intent', 'runner'])
      requireString(value, 'worktree')
      optionalString(value, 'intent')
      validateRunner(value.runner)
      return
    case 'edit':
      assertAllowedFields(value, ['path', 'intent', 'runner'])
      requireString(value, 'path')
      optionalString(value, 'intent')
      validateRunner(value.runner)
      return
    case 'chat':
      assertAllowedFields(value, ['intent', 'worktree', 'runner'])
      optionalString(value, 'intent')
      optionalString(value, 'worktree')
      validateRunner(value.runner)
      return
    case 'analyze':
      assertAllowedFields(value, ['inboxId', 'intent', 'runner'])
      optionalIdentifier(value, 'inboxId')
      optionalString(value, 'intent')
      validateRunner(value.runner)
      return
    case 'resumeSession':
      assertAllowedFields(value, ['sessionId', 'message', 'runner'])
      requireIdentifier(value, 'sessionId')
      requireString(value, 'message')
      validateRunner(value.runner)
      return
    case 'reapSessions':
      assertAllowedFields(value, ['sessionIds'])
      if (value.sessionIds !== undefined && (!Array.isArray(value.sessionIds) || value.sessionIds.some((item) => !validIdentifier(item)))) {
        invalid('sessionIds must contain only safe identifiers')
      }
      return
    case 'setPin':
      assertAllowedFields(value, ['worktree', 'snapshotId', 'selectedSkills'])
      requireString(value, 'worktree')
      requireSha256(value, 'snapshotId')
      validateSelectedSkills(value.selectedSkills)
      return
    case 'claimWorktree':
      assertAllowedFields(value, ['worktree', 'snapshotId', 'selectedSkills', 'sessionId'])
      requireString(value, 'worktree')
      requireSha256(value, 'snapshotId')
      if (!Array.isArray(value.selectedSkills)) invalid('selectedSkills must be an explicit array')
      validateSelectedSkills(value.selectedSkills)
      requireIdentifier(value, 'sessionId')
      return
    case 'sync':
      assertAllowedFields(value, ['worktree', 'planHash', 'sessionId'])
      requireString(value, 'worktree')
      requireSha256(value, 'planHash')
      optionalIdentifier(value, 'sessionId')
      return
    case 'migrateLegacy':
      assertAllowedFields(value, ['worktree', 'mode', 'planHash'])
      requireString(value, 'worktree')
      if (value.mode !== 'dryRun' && value.mode !== 'commit') invalid('mode must be dryRun or commit')
      if (value.mode === 'commit') requireSha256(value, 'planHash')
      else if (value.planHash !== undefined) invalid('planHash is only valid for commit mode')
      return
    case 'rollbackLegacyMigration':
      assertAllowedFields(value, ['worktree', 'migrationId', 'mode', 'planHash'])
      requireString(value, 'worktree')
      requireSha256(value, 'migrationId')
      if (value.mode !== 'dryRun' && value.mode !== 'commit') invalid('mode must be dryRun or commit')
      if (value.mode === 'commit') requireSha256(value, 'planHash')
      else if (value.planHash !== undefined) invalid('planHash is only valid for commit mode')
      return
    case 'migrateState':
      assertAllowedFields(value, ['mode', 'planHash'])
      if (value.mode !== 'dryRun' && value.mode !== 'commit') invalid('mode must be dryRun or commit')
      if (value.mode === 'commit') requireSha256(value, 'planHash')
      else if (value.planHash !== undefined) invalid('planHash is only valid for commit mode')
      return
  }
}

function validate(command: HubCommand) {
  const value = command as unknown
  if (!isRecord(value) || typeof value.kind !== 'string' || !QUERY_KINDS.has(value.kind) && !WRITE_KINDS.has(value.kind)) {
    throw new ApplicationFault('UNSUPPORTED_COMMAND', 'unsupported command')
  }
  if (!isRecord(value.meta) || value.meta.contractVersion !== CONTRACT_VERSION) {
    throw new ApplicationFault('UNSUPPORTED_CONTRACT_VERSION', 'unsupported contract version')
  }
  if (typeof value.meta.requestId !== 'string' || !value.meta.requestId.trim()) {
    throw new ApplicationFault('REQUEST_ID_REQUIRED', 'requestId is required')
  }
  if (!validIdentifier(value.meta.requestId, 160)
    || !validIdentifier(value.meta.hostId, 64)
    || !validIdentifier(value.meta.transport, 64)) {
    throw new ApplicationFault('INVALID_COMMAND_META', 'hostId and transport are required')
  }
  validatePayload(command)
}

function safeSubject(runtime: ApplicationRuntimePort, command: HubCommand): string | undefined {
  const subject = (type: string, value: string) => hashedSubject(runtime, type, value)
  if ('id' in command && typeof command.id === 'string') return subject('inbox', command.id)
  if ('sessionId' in command && typeof command.sessionId === 'string') return subject('session', command.sessionId)
  if ('inboxId' in command && typeof command.inboxId === 'string') return subject('inbox', command.inboxId)
  const pathValue = 'worktree' in command && typeof command.worktree === 'string'
    ? command.worktree
    : 'path' in command && typeof command.path === 'string'
      ? command.path
      : ''
  return pathValue ? subject('path', pathValue) : undefined
}

function hashedSubject(runtime: ApplicationRuntimePort, type: string, value: string): string {
  return `${type}:${runtime.sha256(value).slice(0, 16)}`
}

function safeHandlerError(command: HubCommand, error: HubError): HubError {
  if (command.kind === 'decide') {
    const message = error.code === 'NOT_FOUND'
      ? 'inbox item not found'
      : error.code === 'INVALID_INBOX_TRANSITION'
        ? 'inbox transition rejected'
        : 'inbox decision failed'
    return { ...error, message }
  }
  if (command.kind === 'resumeSession') {
    const message = error.code === 'NOT_FOUND'
      ? 'session not found'
      : error.code === 'RUNNER_UNAVAILABLE'
        ? 'session runner unavailable'
        : 'session resume failed'
    return { ...error, message }
  }
  return error
}

function terminalEvent(runtime: ApplicationRuntimePort, command: HubCommand, error?: HubError): AuditEvent {
  const rejected = Boolean(error && !error.retryable)
  return {
    eventVersion: CONTRACT_VERSION,
    id: runtime.nextId('audit'),
    type: error ? 'command.failed' : 'command.succeeded',
    at: runtime.nowIso(),
    requestId: command.meta.requestId,
    hostId: command.meta.hostId,
    transport: command.meta.transport,
    commandKind: command.kind,
    outcome: error ? (rejected ? 'rejected' : 'failed') : 'succeeded',
    subject: safeSubject(runtime, command),
    details: error ? { errorCode: error.code } : undefined
  }
}

function analyzeCompletionFact(session: SessionView): AnalyzeCompletionFact | null {
  if (session.kind !== 'analyze') return null
  let outcome: AnalyzeCompletionFact['outcome'] = 'pending'
  if (session.status === 'cancelled') outcome = 'cancelled'
  else if (session.status === 'failed' || session.exitCode != null && session.exitCode !== 0) outcome = 'failed'
  else if ((session.status === 'waiting' || session.status === 'completed') && session.exitCode === 0) outcome = 'succeeded'
  return {
    sessionId: session.id,
    outcome,
    output: session.lastMessage || session.summary || '',
    inboxIds: session.inboxIds || []
  }
}

async function applyAnalyzeCompletion(
  runtime: ApplicationRuntimePort,
  useCases: SharedUseCasePorts,
  command: HubCommand,
  session: SessionView
): Promise<readonly AuditEvent[]> {
  const fact = analyzeCompletionFact(session)
  if (!fact || fact.outcome !== 'succeeded') return []
  const state = await useCases.state.readState()
  const at = runtime.nowIso()
  const decision = planAnalyzeCompletion({ state, fact, now: at })
  if (decision.decision === 'noop') return []
  const events: AuditEvent[] = decision.plan.changedItemIds.map((itemId) => ({
    eventVersion: CONTRACT_VERSION,
    id: runtime.nextId('audit'),
    type: 'inbox.transitioned',
    at,
    requestId: command.meta.requestId,
    hostId: command.meta.hostId,
    transport: command.meta.transport,
    commandKind: command.kind,
    outcome: 'succeeded',
    subject: hashedSubject(runtime, 'inbox', itemId),
    details: { nextStatus: 'proposed', source: 'analyze-completion' }
  }))
  await useCases.state.writeState(decision.plan.nextState)
  return events
}

function inboxView(value: unknown): InboxItemView {
  return value as InboxItemView
}

function sessionTarget(kind: SessionKind, command: HubCommand) {
  if (kind === 'analyze' && 'inboxId' in command && command.inboxId) {
    return { kind: 'inbox' as const, id: command.inboxId }
  }
  return { kind: 'hub' as const, id: 'hub' }
}

function sessionLocator(kind: SessionKind, command: HubCommand): SessionStartRequest['locator'] {
  if ((kind === 'attach' || kind === 'detach' || kind === 'chat') && 'worktree' in command && command.worktree) {
    return { kind: 'worktree', value: command.worktree }
  }
  if (kind === 'edit' && 'path' in command) return { kind: 'skill', value: command.path }
  return undefined
}

async function startSession(
  sessions: SessionPort,
  kind: SessionKind,
  command: HubCommand,
  inboxIds?: readonly string[],
  target?: SessionTarget
) {
  const request: SessionStartRequest = {
    kind,
    locator: sessionLocator(kind, command),
    target: target || (sessionLocator(kind, command) ? undefined : sessionTarget(kind, command)),
    intent: 'intent' in command ? command.intent : undefined,
    inboxIds,
    options: 'runner' in command ? command.runner : undefined
  }
  return sessions.start(request)
}

function commandSessionOutcome(session: SessionView): SessionView {
  const {
    intent: _intent,
    continuationToken: _continuationToken,
    error: _error,
    summary: _summary,
    lastMessage: _lastMessage,
    ...outcome
  } = session
  return outcome
}

async function validateAttach(legacyAttach: LegacyAttachPort, worktree: string) {
  const inspection = await legacyAttach.inspect(worktree)
  const recognition = recognizeWorktree(inspection.worktree.recognition)
  const claim = evaluateClaim({
    recognition,
    blocked: inspection.worktree.blocked,
    claimed: inspection.worktree.claimed
  })
  const firstAttach = decideFirstAttach(claim)
  if (firstAttach.decision === 'rejected') {
    const code = firstAttach.reason === 'blocked' ? 'WORKTREE_BLOCKED' : 'WORKTREE_NOT_RECOGNIZED'
    throw new ApplicationFault(code, firstAttach.reason === 'blocked' ? 'worktree is blocked' : 'worktree is not recognized')
  }
  if (!inspection.gitWorktree) throw new ApplicationFault('WORKTREE_NOT_RECOGNIZED', 'worktree is not recognized')
  return inspection.worktree
}

function attachFault(decision: Exclude<LegacyAttachPlanDecision, { decision: 'apply' | 'noop' }>): ApplicationFault {
  if (decision.decision === 'session-required') {
    return new ApplicationFault('FIRST_ATTACH_SESSION_REQUIRED', 'first attach requires an authorized attach session')
  }
  if (decision.reason === 'blocked') return new ApplicationFault('WORKTREE_BLOCKED', 'worktree is blocked')
  if (decision.reason === 'unrecognized') return new ApplicationFault('WORKTREE_NOT_RECOGNIZED', 'worktree is not recognized')
  if (decision.reason === 'library-missing') return new ApplicationFault('NOT_FOUND', 'required library artifact is missing')
  if (decision.conflict === 'external-link') {
    return new ApplicationFault('CONFLICT_EXTERNAL_LINK', 'a managed artifact points to an external location')
  }
  if (decision.conflict === 'dirty' || decision.conflict === 'protected-target') {
    return new ApplicationFault('CONFLICT_DIRTY', 'a managed artifact is not safe to replace')
  }
  return new ApplicationFault('CONFLICT_CONTENT', 'a managed artifact differs from hub')
}

async function authorizeFirstAttach(
  sessions: SessionPort,
  targetId: string,
  sessionId?: string
): Promise<boolean> {
  if (!sessionId) return false
  const session = await sessions.get(sessionId)
  if (!session
    || session.kind !== 'attach'
    || session.target?.kind !== 'worktree'
    || session.target.id !== targetId
    || session.status !== 'waiting'
    || session.exitCode !== 0) {
    return false
  }
  return true
}

async function authorizeDetach(
  sessions: SessionPort,
  targetId: string,
  sessionId?: string
): Promise<boolean> {
  if (!sessionId) return false
  const session = await sessions.get(sessionId)
  if (!session
    || session.kind !== 'detach'
    || session.target?.kind !== 'worktree'
    || session.target.id !== targetId
    || session.status === 'completed'
    || session.status === 'failed'
    || session.status === 'cancelled') {
    return false
  }
  return true
}

function detachFault(decision: Exclude<LegacyDetachPlanDecision, { decision: 'apply' | 'noop' }>): ApplicationFault {
  if (decision.decision === 'session-required') {
    return new ApplicationFault('DETACH_SESSION_REQUIRED', 'detach apply requires an authorized detach session')
  }
  if (decision.reason === 'blocked') return new ApplicationFault('WORKTREE_BLOCKED', 'worktree is blocked')
  if (decision.reason === 'unrecognized') return new ApplicationFault('WORKTREE_NOT_RECOGNIZED', 'worktree is not recognized')
  if (decision.conflict === 'external-link') {
    return new ApplicationFault('CONFLICT_EXTERNAL_LINK', 'a managed artifact points to an external location')
  }
  return new ApplicationFault('CONFLICT_DIRTY', 'detach would overwrite an unexpected worktree artifact')
}

async function validateDetach(legacyDetach: LegacyDetachPort, worktree: string) {
  const inspection = await legacyDetach.inspect(worktree)
  const decision = planLegacyDetach({ inspection, detachSessionAuthorized: true })
  if (decision.decision === 'apply') return inspection.worktree
  if (decision.decision === 'noop') throw new ApplicationFault('INVALID_ARGUMENT', 'worktree is not attached')
  throw detachFault(decision)
}

async function executeLegacyRepair(legacyAttach: LegacyAttachPort, worktree: string) {
  const inspection = await legacyAttach.inspect(worktree)
  const decision = planLegacyAttach({ inspection, mode: 'repair' })
  if (decision.decision === 'noop') {
    return {
      action: 'repairLegacy' as const,
      worktree: decision.worktree,
      attached: inspection.worktree.claimed,
      blocked: inspection.worktree.blocked,
      repaired: false,
      reason: decision.reason,
      artifacts: []
    }
  }
  if (decision.decision !== 'apply') throw attachFault(decision)
  const report = await legacyAttach.apply(decision.plan)
  return {
    action: 'repairLegacy' as const,
    worktree: decision.plan.worktree,
    attached: inspection.worktree.claimed,
    blocked: inspection.worktree.blocked,
    repaired: report.changed,
    artifacts: decision.plan.artifacts.map((artifact) => ({
      label: artifact.label,
      status: artifact.action === 'keep' ? 'ok' : 'repaired'
    }))
  }
}

function useCaseFault(decision: { code: HubErrorCode; reason: string }): ApplicationFault {
  return new ApplicationFault(decision.code, decision.reason, decision.code === 'PORT_FAILURE')
}

async function executeIngestUseCase(
  runtime: ApplicationRuntimePort,
  useCases: SharedUseCasePorts,
  command: Extract<HubCommand, { kind: 'ingest' }>
) {
  const transactions = parseIngestTransactions(command.payload)
  const gameRepo = command.gameRepo || await useCases.state.configuredGameRepo()
  if (transactions.length === 0) {
    return {
      gameRepo: gameRepo || undefined,
      created: 0,
      items: [] as readonly InboxItemView[]
    }
  }
  if (!gameRepo) throw new ApplicationFault('INVALID_ARGUMENT', 'ingest requires a game repository')

  const facts: IngestTransactionFact[] = []
  for (const transaction of transactions) {
    const oldExists = await useCases.git.revisionExists(gameRepo, transaction.old)
    const nextExists = await useCases.git.revisionExists(gameRepo, transaction.next)
    const changes = oldExists && nextExists
      ? await useCases.git.changedPaths({
        repo: gameRepo,
        oldRevision: transaction.old,
        newRevision: transaction.next,
        pathspecs: INGEST_WATCHED_PATHS
      })
      : []
    facts.push({ ...transaction, oldExists, nextExists, changes })
  }

  const discovery = discoverIngestCandidates({ gameRepo, transactions: facts })
  const state = await useCases.state.readState()
  const existingIds = new Set(state.items.map((item) => item.id))
  const snapshots: IngestCandidateSnapshot[] = []
  for (const candidate of discovery.candidates) {
    const id = runtime.sha256(candidate.idMaterial).slice(0, 16)
    if (existingIds.has(id)) {
      snapshots.push({ id, candidate })
      continue
    }
    let files
    if (candidate.isSkill) {
      files = await useCases.git.readTree({ repo: gameRepo, revision: candidate.next, prefix: candidate.prefix })
    } else {
      const content = await useCases.git.readBlob({ repo: gameRepo, revision: candidate.next, path: candidate.prefix })
      files = [{ path: candidate.name, content: content ?? '' }]
    }
    snapshots.push({ id, candidate, files })
  }

  const hasNewItem = snapshots.some((snapshot) => !existingIds.has(snapshot.id))
  const decision = planIngest({
    state,
    gameRepo,
    discovery,
    snapshots,
    now: hasNewItem ? runtime.nowIso() : '',
    historyId: hasNewItem ? runtime.nextId('ingest') : ''
  })
  if (decision.decision === 'rejected') throw useCaseFault(decision)
  if (!command.dryRun) {
    await useCases.artifacts.apply(decision.plan.effects)
    await useCases.state.writeState(decision.plan.nextState)
    if (decision.plan.history) await useCases.state.appendHistory(decision.plan.history)
  }
  return {
    gameRepo,
    created: decision.plan.createdItems.length,
    items: decision.plan.createdItems
  }
}

async function executeDecisionUseCase(
  runtime: ApplicationRuntimePort,
  useCases: SharedUseCasePorts,
  command: Extract<HubCommand, { kind: 'decide' }>
) {
  const state = await useCases.state.readState()
  const attachedWorktrees = command.action === 'adopt'
    ? await useCases.state.listAttachedWorktrees()
    : []
  const described = describeDecision({ state, command, attachedWorktrees })
  if (described.decision === 'rejected') throw useCaseFault(described)
  if (described.decision === 'noop') return described.result

  const facts = await useCases.artifacts.inspect(described.description.inspectionRequests)
  const planned = planDecision({
    description: described.description,
    facts,
    now: runtime.nowIso(),
    historyId: runtime.nextId(`decide-${command.id}`)
  })
  if (planned.decision === 'rejected') throw useCaseFault(planned)
  await useCases.artifacts.apply(planned.plan.effects)
  await useCases.state.writeState(planned.plan.nextState)
  await useCases.state.appendHistory(planned.plan.history)
  return planned.plan
}

function stateChangedEvent(
  runtime: ApplicationRuntimePort,
  command: HubCommand,
  subject: string,
  details: Record<string, string | number | boolean | null>
): AuditEvent {
  return {
    eventVersion: CONTRACT_VERSION,
    id: runtime.nextId('audit'),
    type: 'state.changed',
    at: runtime.nowIso(),
    requestId: command.meta.requestId,
    hostId: command.meta.hostId,
    transport: command.meta.transport,
    commandKind: command.kind,
    outcome: 'succeeded',
    subject,
    details
  }
}

function nextStateRevision(state: HubStateV2): number {
  if (!Number.isSafeInteger(state.stateRevision) || state.stateRevision >= Number.MAX_SAFE_INTEGER) {
    throw new ApplicationFault('STATE_CORRUPT', 'state revision cannot be advanced')
  }
  return state.stateRevision + 1
}

function opaqueSha256Identifier(
  runtime: ApplicationRuntimePort,
  domain: string,
  value: string
): Sha256Identifier {
  const raw = runtime.sha256(`${domain}\0${value}`).toLowerCase()
  const identifier = (raw.startsWith('sha256:') ? raw : `sha256:${raw}`) as Sha256Identifier
  if (!SHA256_IDENTIFIER.test(identifier)) {
    throw new ApplicationFault('PORT_FAILURE', 'runtime returned an invalid SHA-256 digest', true)
  }
  return identifier
}

function gameRepositoryId(runtime: ApplicationRuntimePort, locatorOrId: string): Sha256Identifier {
  return SHA256_IDENTIFIER.test(locatorOrId)
    ? locatorOrId as Sha256Identifier
    : opaqueSha256Identifier(runtime, GAME_REPOSITORY_ID_DOMAIN, locatorOrId)
}

type P2StateObservation = {
  status: 'empty' | 'legacy' | 'current' | 'unsupported'
  detectedSchemaVersion: number | null
  stateRevision: number | null
  runtimeRevision: string
  current?: HubStateV2
  legacy?: LegacyHubStateV1
}

function strictLegacyStateFrom(value: RuntimeRecord | null): LegacyHubStateV1 {
  if (!value) {
    return { schemaVersion: 1, stateRevision: 0, items: [], lastIngest: null }
  }
  const validation = validateLegacyHubStateV1(value)
  if (!validation.valid) throw new ApplicationFault('STATE_CORRUPT', 'legacy state failed validation')
  return validation.value
}

function checkedSnapshotManifest(value: unknown): LibrarySnapshotManifestV1 {
  const validation = validateLibrarySnapshotManifestV1(value)
  if (!validation.valid || !verifyLibrarySnapshotManifest(validation.value)) {
    throw new ApplicationFault('SNAPSHOT_INVALID', 'library snapshot failed shared integrity validation')
  }
  return validation.value
}

async function physicalSnapshots(p2: P2ApplicationPorts): Promise<readonly LibrarySnapshotManifestV1[]> {
  const manifests = [...await p2.snapshots.list()].map(checkedSnapshotManifest)
    .sort((left, right) => compareUtf8Bytes(left.snapshotId, right.snapshotId))
  for (let index = 1; index < manifests.length; index += 1) {
    if (manifests[index - 1].snapshotId === manifests[index].snapshotId) {
      throw new ApplicationFault('SNAPSHOT_INVALID', 'snapshot repository contains duplicate manifests')
    }
  }
  return manifests
}

function assertRegisteredSnapshots(
  state: HubStateV2,
  physical: readonly LibrarySnapshotManifestV1[]
): void {
  const available = new Set(physical.map((manifest) => manifest.snapshotId))
  if (state.librarySnapshots.some((snapshotId) => !available.has(snapshotId))) {
    throw new ApplicationFault('STATE_CORRUPT', 'HubStateV2 references a missing library snapshot')
  }
}

async function checkedSnapshotRead(
  p2: P2ApplicationPorts,
  snapshotId: Sha256Identifier
): Promise<LibrarySnapshotManifestV1 | null> {
  const raw = await p2.snapshots.read(snapshotId)
  if (raw == null) return null
  const manifest = checkedSnapshotManifest(raw)
  if (manifest.snapshotId !== snapshotId) {
    throw new ApplicationFault('SNAPSHOT_INVALID', 'snapshot repository returned a mismatched manifest')
  }
  return manifest
}

async function inspectP2State(
  p2: P2ApplicationPorts,
  knownPhysical?: readonly LibrarySnapshotManifestV1[],
  verifySnapshotReferences = true
): Promise<P2StateObservation> {
  const runtimeRevision = (await p2.state.runtimeRevision()).trim()
  if (!isPortableOpaqueIdentifier(runtimeRevision)) {
    throw new ApplicationFault('PORT_FAILURE', 'runtime revision is unavailable or invalid', true)
  }
  const document = await p2.state.readDocument()
  if (document == null) {
    return {
      status: 'empty',
      detectedSchemaVersion: null,
      stateRevision: null,
      runtimeRevision,
      legacy: strictLegacyStateFrom(null)
    }
  }
  if (!isRecord(document)) throw new ApplicationFault('STATE_CORRUPT', 'state document must be an object')
  if (document.schemaVersion === HUB_STATE_SCHEMA_VERSION) {
    const validation = validateHubStateV2(document)
    if (!validation.valid) throw new ApplicationFault('STATE_CORRUPT', 'HubStateV2 validation failed')
    if (verifySnapshotReferences) {
      assertRegisteredSnapshots(validation.value, knownPhysical ?? await physicalSnapshots(p2))
    }
    return {
      status: 'current',
      detectedSchemaVersion: HUB_STATE_SCHEMA_VERSION,
      stateRevision: validation.value.stateRevision,
      runtimeRevision,
      current: validation.value
    }
  }
  const detected = typeof document.schemaVersion === 'number'
    ? document.schemaVersion
    : typeof document.version === 'number'
      ? document.version
      : null
  if (detected === 1) {
    const legacy = strictLegacyStateFrom(document)
    const revision = legacy.stateRevision ?? null
    return {
      status: 'legacy',
      detectedSchemaVersion: 1,
      stateRevision: typeof revision === 'number' ? revision : null,
      runtimeRevision,
      legacy
    }
  }
  return {
    status: 'unsupported',
    detectedSchemaVersion: detected,
    stateRevision: null,
    runtimeRevision
  }
}

async function assertWriteSchemaCompatible(p2: P2ApplicationPorts): Promise<void> {
  const inspection = await inspectP2State(p2, undefined, false)
  if (inspection.status === 'unsupported') {
    throw new ApplicationFault('STATE_VERSION_UNSUPPORTED', 'state schema version is unsupported')
  }
}

async function requireCurrentState(p2: P2ApplicationPorts): Promise<HubStateV2> {
  const inspection = await inspectP2State(p2)
  if (inspection.status === 'legacy' || inspection.status === 'empty') {
    throw new ApplicationFault('MIGRATION_REQUIRED', 'state migration is required')
  }
  if (inspection.status !== 'current') {
    throw new ApplicationFault('STATE_VERSION_UNSUPPORTED', 'state schema version is unsupported')
  }
  if (!inspection.current) throw new ApplicationFault('STATE_CORRUPT', 'current state is unavailable')
  return inspection.current
}

function createApplicationInboxStatePort(
  runtime: ApplicationRuntimePort,
  p2: P2ApplicationPorts,
  legacy: HubStateRepositoryPort
): HubStateRepositoryPort {
  return {
    async readState() {
      const inspection = await inspectP2State(p2)
      if (inspection.status === 'unsupported') {
        throw new ApplicationFault('STATE_VERSION_UNSUPPORTED', 'state schema version is unsupported')
      }
      if (inspection.status !== 'current') return legacy.readState()
      if (!inspection.current) throw new ApplicationFault('STATE_CORRUPT', 'current state is unavailable')
      const lastIngest = inspection.current.lastIngest
      const configuredGameRepo = lastIngest ? await legacy.configuredGameRepo() : null
      return {
        version: HUB_STATE_SCHEMA_VERSION,
        items: inspection.current.items,
        lastIngest: lastIngest
          ? {
              ref: lastIngest.ref,
              old: lastIngest.old,
              new: lastIngest.new,
              gameRepo: configuredGameRepo?.trim() || lastIngest.gameRepoId
            }
          : null
      }
    },
    async writeState(next) {
      const inspection = await inspectP2State(p2)
      if (inspection.status === 'unsupported') {
        throw new ApplicationFault('STATE_VERSION_UNSUPPORTED', 'state schema version is unsupported')
      }
      if (inspection.status !== 'current') return legacy.writeState(next)
      if (!inspection.current) throw new ApplicationFault('STATE_CORRUPT', 'current state is unavailable')
      const currentLastIngest = inspection.current.lastIngest
      const nextLastIngest = next.lastIngest
      const preservesIngestIdentity = Boolean(currentLastIngest && nextLastIngest
        && currentLastIngest.ref === nextLastIngest.ref
        && currentLastIngest.old === nextLastIngest.old
        && currentLastIngest.new === nextLastIngest.new)
      await p2.state.writeV2({
        ...inspection.current,
        stateRevision: nextStateRevision(inspection.current),
        items: next.items,
        lastIngest: nextLastIngest
          ? {
              ref: nextLastIngest.ref,
              old: nextLastIngest.old,
              new: nextLastIngest.new,
              gameRepoId: preservesIngestIdentity
                ? currentLastIngest!.gameRepoId
                : gameRepositoryId(runtime, nextLastIngest.gameRepo)
            }
          : null
      })
    },
    appendHistory: (write) => legacy.appendHistory(write),
    configuredGameRepo: () => legacy.configuredGameRepo(),
    listAttachedWorktrees: () => legacy.listAttachedWorktrees()
  }
}

async function visibleSnapshots(p2: P2ApplicationPorts): Promise<readonly LibrarySnapshotManifestV1[]> {
  const physical = await physicalSnapshots(p2)
  const inspection = await inspectP2State(p2, physical)
  if (inspection.status === 'unsupported') {
    throw new ApplicationFault('STATE_VERSION_UNSUPPORTED', 'state schema version is unsupported')
  }
  if (inspection.status !== 'current') return physical
  if (!inspection.current) throw new ApplicationFault('STATE_CORRUPT', 'current state is unavailable')
  const registered = new Set(inspection.current.librarySnapshots)
  return physical.filter((manifest) => registered.has(manifest.snapshotId))
}

async function executeCreateSnapshot(
  runtime: ApplicationRuntimePort,
  p2: P2ApplicationPorts,
  businessEvents: AuditEvent[],
  command: Extract<HubCommand, { kind: 'createSnapshot' }>
) {
  const inspection = await inspectP2State(p2)
  if (inspection.status === 'unsupported') {
    throw new ApplicationFault('STATE_VERSION_UNSUPPORTED', 'state schema version is unsupported')
  }
  const observation = await p2.snapshots.observe()
  const approved = createLibrarySnapshotManifest({
    source: observation.source,
    createdAt: runtime.nowIso(),
    files: observation.files
  })
  if (!approved.ok) throw new ApplicationFault('SNAPSHOT_INVALID', 'library snapshot facts are invalid')
  const captured = await p2.snapshots.store(observation.captureId, approved.manifest)
  const storedManifest = checkedSnapshotManifest(captured.manifest)
  if (storedManifest.snapshotId !== approved.manifest.snapshotId) {
    throw new ApplicationFault('SNAPSHOT_INVALID', 'snapshot repository stored a mismatched manifest')
  }
  let registered = false
  if (inspection.status === 'current') {
    const state = inspection.current
    if (!state) throw new ApplicationFault('STATE_CORRUPT', 'current state is unavailable')
    if (!state.librarySnapshots.includes(storedManifest.snapshotId)) {
      const librarySnapshots = [...state.librarySnapshots, storedManifest.snapshotId].sort(compareUtf8Bytes)
      await p2.state.writeV2({
        ...state,
        stateRevision: nextStateRevision(state),
        librarySnapshots
      })
      registered = true
    }
  }
  businessEvents.push(stateChangedEvent(runtime, command, `snapshot:${storedManifest.snapshotId}`, {
    change: registered ? 'snapshot-registered' : 'snapshot-captured',
    snapshotId: storedManifest.snapshotId,
    deduplicated: captured.deduplicated
  }))
  return {
    action: 'createSnapshot' as const,
    snapshot: storedManifest,
    deduplicated: captured.deduplicated
  }
}

async function requireLockedWorktreeIdentity(
  p2: P2ApplicationPorts,
  lockedIdentity: WorktreeIdentity | undefined,
  worktree: string
): Promise<WorktreeIdentity> {
  const identity = await p2.identities.resolve(worktree)
  if (!lockedIdentity
    || identity.pathKey !== lockedIdentity.pathKey
    || identity.worktreeId !== lockedIdentity.worktreeId) {
    throw new ApplicationFault('LOCK_NOT_OWNED', 'worktree identity changed while acquiring the write lock', true)
  }
  return identity
}

async function executeSetPin(
  runtime: ApplicationRuntimePort,
  p2: P2ApplicationPorts,
  lockedIdentity: WorktreeIdentity | undefined,
  businessEvents: AuditEvent[],
  command: Extract<HubCommand, { kind: 'setPin' }>
) {
  const identity = await requireLockedWorktreeIdentity(p2, lockedIdentity, command.worktree)
  const state = await requireCurrentState(p2)
  if (!state.librarySnapshots.includes(command.snapshotId)) {
    throw new ApplicationFault('SNAPSHOT_NOT_FOUND', 'requested library snapshot is not registered')
  }
  const snapshot = await checkedSnapshotRead(p2, command.snapshotId)
  if (!snapshot) throw new ApplicationFault('SNAPSHOT_NOT_FOUND', 'requested library snapshot was not found')
  const current = state.worktrees[identity.pathKey]
  if (!current || current.claimState !== 'claimed' || current.worktreeId !== identity.worktreeId) {
    throw new ApplicationFault('INVALID_PIN', 'setPin requires an existing claimed worktree pin')
  }
  const transition = transitionWorktreePin(current, {
    kind: 'setRequested',
    requestedSnapshot: command.snapshotId,
    selectedSkills: command.selectedSkills ?? current.selectedSkills
  })
  if (!transition.ok) throw new ApplicationFault('INVALID_PIN', 'requested pin transition is invalid')
  if (!transition.idempotent) {
    await p2.state.writeV2({
      ...state,
      stateRevision: nextStateRevision(state),
      worktrees: { ...state.worktrees, [identity.pathKey]: transition.pin }
    })
  }
  businessEvents.push(stateChangedEvent(runtime, command, `worktree:${identity.pathKey}`, {
    change: 'pin-requested',
    pathKey: identity.pathKey,
    snapshotId: command.snapshotId,
    changed: !transition.idempotent
  }))
  return {
    action: 'setPin' as const,
    pathKey: identity.pathKey,
    worktreeId: identity.worktreeId,
    pin: transition.pin,
    changed: !transition.idempotent
  }
}

function requireP3(p3: P3ApplicationPorts | undefined): P3ApplicationPorts {
  if (!p3) throw new ApplicationFault('PORT_FAILURE', 'materialization host is unavailable', true)
  return p3
}

function checkedRuntimeAssetManifest(value: unknown): RuntimeAssetManifestV1 {
  if (!verifyRuntimeAssetManifest(value)) {
    throw new ApplicationFault('RUNTIME_ASSET_INVALID', 'runtime asset manifest failed shared integrity validation')
  }
  return value
}

function checkedMaterializationRecord(
  value: unknown,
  pathKey: Sha256Identifier
): MaterializationCommitRecordV1 | null {
  if (value == null) return null
  const validation = validateMaterializationCommitRecordV1(value)
  if (!validation.valid
    || validation.value.pathKey !== pathKey
    || validation.value.marker != null && !verifyMaterializationMarker(validation.value.marker)) {
    throw new ApplicationFault('STATE_CORRUPT', 'materialization commit record failed integrity validation')
  }
  return validation.value
}

type MaterializationSourceContext = {
  state: HubStateV2
  pin: WorktreePinV1
  snapshot: LibrarySnapshotManifestV1
  runtimeAsset: RuntimeAssetManifestV1
  durable: MaterializationCommitRecordV1 | null
}

type PlannedMaterialization = MaterializationSourceContext & {
  plan: MaterializePlanV1
}

async function requireMaterializationSourceContext(
  p2: P2ApplicationPorts,
  p3: P3ApplicationPorts,
  identity: WorktreeIdentity
): Promise<MaterializationSourceContext> {
  const state = await requireCurrentState(p2)
  const pin = state.worktrees[identity.pathKey]
  if (!pin
    || pin.pathKey !== identity.pathKey
    || pin.worktreeId !== identity.worktreeId
    || pin.claimState !== 'claimed'
    || pin.requestedSnapshot == null) {
    throw new ApplicationFault('WORKTREE_NOT_CLAIMED', 'worktree must have a matching claimed pin')
  }
  if (!state.librarySnapshots.includes(pin.requestedSnapshot)) {
    throw new ApplicationFault('SNAPSHOT_NOT_FOUND', 'requested library snapshot is not registered')
  }
  const snapshot = await checkedSnapshotRead(p2, pin.requestedSnapshot)
  if (!snapshot) throw new ApplicationFault('SNAPSHOT_NOT_FOUND', 'requested library snapshot was not found')
  const runtimeAsset = checkedRuntimeAssetManifest(await p3.runtimeAssets.observe())
  const selected = validateSelectedMaterializationSkills(snapshot, pin.selectedSkills)
  if (!selected.ok) {
    throw new ApplicationFault(
      'INVALID_PIN',
      'selected skills are not a canonical subset of the requested snapshot'
    )
  }
  const durable = checkedMaterializationRecord(
    await p3.records.readCurrent(identity.pathKey),
    identity.pathKey
  )
  return { state, pin, snapshot, runtimeAsset, durable }
}

async function computeMaterializationPlan(
  p2: P2ApplicationPorts,
  p3: P3ApplicationPorts,
  worktree: string,
  identity: WorktreeIdentity
): Promise<PlannedMaterialization> {
  const source = await requireMaterializationSourceContext(p2, p3, identity)
  const { state, pin, snapshot, runtimeAsset, durable } = source
  const inspection = await p3.materialize.inspect({
    worktree,
    identity,
    snapshot,
    runtimeAsset,
    selectedSkills: pin.selectedSkills
  })
  const planned = planMaterialization({
    pathKey: identity.pathKey,
    worktreeId: identity.worktreeId,
    stateRevision: state.stateRevision,
    pin,
    snapshot,
    runtimeAsset,
    durableMarker: durable,
    observedMarker: inspection.observedMarker,
    currentVisibilityState: inspection.currentVisibilityState,
    desiredVisibilityState: inspection.desiredVisibilityState,
    observations: inspection.observations,
    gitFacts: inspection.gitFacts,
    gitConfiguration: inspection.gitConfiguration
  })
  if (!planned.ok) {
    const codes = new Set(planned.errors.map((error) => error.code))
    if (codes.has('MATERIALIZATION_SOURCE_INVALID')) {
      throw new ApplicationFault('SNAPSHOT_INVALID', 'materialization source inventory is incomplete')
    }
    if (codes.has('MATERIALIZATION_PIN_INVALID')) {
      throw new ApplicationFault('INVALID_PIN', 'materialization pin no longer matches the requested source')
    }
    throw new ApplicationFault(
      'PORT_FAILURE',
      'materialization facts failed validation',
      true
    )
  }
  if (!verifyMaterializePlanHash(planned.plan)
    || planned.plan.pathKey !== identity.pathKey
    || planned.plan.worktreeId !== identity.worktreeId
    || planned.plan.requested.snapshotId !== pin.requestedSnapshot) {
    throw new ApplicationFault('STATE_CORRUPT', 'materialization plan failed integrity validation')
  }
  return { ...source, plan: planned.plan }
}

function worktreeMaterializationEvent(
  runtime: ApplicationRuntimePort,
  command: HubCommand,
  type: 'worktree.claimed' | 'worktree.materialized',
  pathKey: Sha256Identifier,
  details: Record<string, string | number | boolean | null>
): AuditEvent {
  return {
    eventVersion: CONTRACT_VERSION,
    id: runtime.nextId('audit'),
    type,
    at: runtime.nowIso(),
    requestId: command.meta.requestId,
    hostId: command.meta.hostId,
    transport: command.meta.transport,
    commandKind: command.kind,
    outcome: 'succeeded',
    subject: `worktree:${pathKey}`,
    details
  }
}

async function executePlanSync(
  p2: P2ApplicationPorts,
  p3: P3ApplicationPorts | undefined,
  command: Extract<HubCommand, { kind: 'planSync' }>
) {
  const materialization = requireP3(p3)
  const identity = await p2.identities.resolve(command.worktree)
  const { plan } = await computeMaterializationPlan(p2, materialization, command.worktree, identity)
  return {
    action: 'planSync' as const,
    status: plan.executable ? 'planned' as const : 'conflict' as const,
    plan
  }
}

async function authorizeClaimSession(
  sessions: SessionPort,
  identity: WorktreeIdentity,
  sessionId: string
): Promise<void> {
  const session = await sessions.get(sessionId)
  if (!session
    || session.kind !== 'attach'
    || session.target?.kind !== 'worktree'
    || session.target.id !== identity.worktreeId
    || session.status !== 'waiting'
    || session.exitCode !== 0) {
    throw new ApplicationFault(
      'FIRST_ATTACH_SESSION_REQUIRED',
      'claim requires a successful waiting attach session for this worktree'
    )
  }
}

async function executeClaimWorktree(
  runtime: ApplicationRuntimePort,
  sessions: SessionPort,
  p2: P2ApplicationPorts,
  p3: P3ApplicationPorts | undefined,
  lockedIdentity: WorktreeIdentity | undefined,
  businessEvents: AuditEvent[],
  command: Extract<HubCommand, { kind: 'claimWorktree' }>
) {
  requireP3(p3)
  const identity = await requireLockedWorktreeIdentity(p2, lockedIdentity, command.worktree)
  const state = await requireCurrentState(p2)
  if (!state.librarySnapshots.includes(command.snapshotId)) {
    throw new ApplicationFault('SNAPSHOT_NOT_FOUND', 'requested library snapshot is not registered')
  }
  const snapshot = await checkedSnapshotRead(p2, command.snapshotId)
  if (!snapshot) throw new ApplicationFault('SNAPSHOT_NOT_FOUND', 'requested library snapshot was not found')
  const selected = validateSelectedMaterializationSkills(snapshot, command.selectedSkills)
  if (!selected.ok) {
    throw new ApplicationFault('INVALID_PIN', 'selected skills are not a canonical subset of the snapshot')
  }
  await authorizeClaimSession(sessions, identity, command.sessionId)

  const current = state.worktrees[identity.pathKey] ?? {
    schemaVersion: WORKTREE_PIN_SCHEMA_VERSION,
    pathKey: identity.pathKey,
    worktreeId: identity.worktreeId,
    requestedSnapshot: null,
    materializedSnapshot: null,
    selectedSkills: [],
    claimState: 'unclaimed' as const
  }
  if (current.pathKey !== identity.pathKey || current.worktreeId !== identity.worktreeId) {
    throw new ApplicationFault('STATE_CORRUPT', 'worktree pin identity does not match the resolved worktree')
  }
  const transition = transitionWorktreePin(current, {
    kind: 'claim',
    requestedSnapshot: command.snapshotId,
    selectedSkills: command.selectedSkills
  })
  if (!transition.ok) throw new ApplicationFault('INVALID_PIN', 'worktree claim transition is invalid')
  if (current.claimState === 'claimed' && !transition.idempotent) {
    throw new ApplicationFault('WORKTREE_ALREADY_CLAIMED', 'worktree is already claimed; use setPin to change its request')
  }
  if (!transition.idempotent) {
    await p2.state.writeV2({
      ...state,
      stateRevision: nextStateRevision(state),
      worktrees: { ...state.worktrees, [identity.pathKey]: transition.pin }
    })
  }
  businessEvents.push(worktreeMaterializationEvent(
    runtime,
    command,
    'worktree.claimed',
    identity.pathKey,
    {
      pathKey: identity.pathKey,
      snapshotId: command.snapshotId,
      selectedSkillCount: transition.pin.selectedSkills.length,
      changed: !transition.idempotent
    }
  ))
  return {
    action: 'claimWorktree' as const,
    pathKey: identity.pathKey,
    worktreeId: identity.worktreeId,
    pin: transition.pin,
    changed: !transition.idempotent
  }
}

function materializationConflictFault(plan: MaterializePlanV1): ApplicationFault {
  const kinds = new Set(plan.operations.flatMap((operation) => operation.conflict ? [operation.conflict.kind] : []))
  if (kinds.has('legacy-link')) {
    return new ApplicationFault('LEGACY_MIGRATION_REQUIRED', 'legacy links require an explicit migration')
  }
  if (kinds.has('external-link')) {
    return new ApplicationFault('CONFLICT_EXTERNAL_LINK', 'a materialization target points outside the worktree')
  }
  if (kinds.has('marker-invalid')) {
    return new ApplicationFault('MATERIALIZATION_MARKER_INVALID', 'materialization marker and durable truth disagree')
  }
  if (plan.git.configuration.conflictKind === 'legacyCommonInfoExclude') {
    return new ApplicationFault(
      'LEGACY_MIGRATION_REQUIRED',
      'legacy common Git exclusions require an explicit migration'
    )
  }
  if (plan.git.configuration.conflictKind === 'unsupportedWorktreeConfig') {
    return new ApplicationFault('UNSUPPORTED_LAYOUT', 'worktree-specific Git configuration is unavailable')
  }
  if (plan.git.configuration.conflictKind === 'configurationDrift') {
    return new ApplicationFault('CONFLICT_PATH', 'Git materialization configuration changed after planning')
  }
  if (plan.git.configuration.conflictKind === 'excludeBaseUnsafe') {
    return new ApplicationFault('CONFLICT_PATH', 'the effective Git excludes source cannot be projected safely')
  }
  if (kinds.has('dirty')) {
    return new ApplicationFault('CONFLICT_DIRTY', 'a managed materialization target was changed locally')
  }
  if (kinds.has('unowned-content')) {
    return new ApplicationFault('CONFLICT_CONTENT', 'an unmanaged target differs from the requested content')
  }
  return new ApplicationFault('CONFLICT_PATH', 'a materialization target is not safe to replace')
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function markerMatchesPlan(marker: MaterializationMarkerV1, plan: MaterializePlanV1): boolean {
  return verifyMaterializationMarker(marker)
    && marker.planHash === plan.planHash
    && marker.pathKey === plan.pathKey
    && marker.worktreeId === plan.worktreeId
    && marker.snapshotId === plan.requested.snapshotId
    && sameStrings(marker.selectedSkills, plan.requested.selectedSkills)
    && marker.runtimeRevision === plan.requested.runtimeRevision
    && marker.runtimeAssetId === plan.requested.runtimeAssetId
    && marker.visibilityStateId === plan.requested.visibilityStateId
    && marker.materializationId === plan.requested.materializationId
    && marker.origin.kind === 'sync'
}

type PlannedAttachCompletion = {
  sessionId: string
  proof: {
    targetId: string
    pathKey: Sha256Identifier
    materializationId: Sha256Identifier
    completedAt: string
  }
}

function sameAttachCompletionIdentity(
  value: unknown,
  expected: PlannedAttachCompletion['proof']
): value is PlannedAttachCompletion['proof'] {
  if (!value || typeof value !== 'object') return false
  const proof = value as Record<string, unknown>
  return Object.keys(proof).every((key) => [
    'targetId', 'pathKey', 'materializationId', 'completedAt'
  ].includes(key))
    && proof.targetId === expected.targetId
    && proof.pathKey === expected.pathKey
    && proof.materializationId === expected.materializationId
    && typeof proof.completedAt === 'string'
    && Number.isFinite(Date.parse(proof.completedAt))
}

async function planAttachCompletion(
  runtime: ApplicationRuntimePort,
  sessions: SessionPort,
  sessionId: string | undefined,
  identity: WorktreeIdentity,
  materializationId: Sha256Identifier
): Promise<PlannedAttachCompletion | null> {
  if (!sessionId) return null
  const expected = {
    targetId: identity.worktreeId,
    pathKey: identity.pathKey,
    materializationId,
    completedAt: runtime.nowIso()
  }
  const session = await sessions.get(sessionId)
  if (!session
    || session.kind !== 'attach'
    || session.target?.kind !== 'worktree'
    || session.target.id !== identity.worktreeId) {
    throw new ApplicationFault(
      'FIRST_ATTACH_SESSION_REQUIRED',
      'sync completion requires an attach session for this worktree'
    )
  }
  if (session.status === 'completed') {
    if (session.exitCode !== 0) {
      throw new ApplicationFault(
        'FIRST_ATTACH_SESSION_REQUIRED',
        'sync completion requires a successful attach session'
      )
    }
    if (!sameAttachCompletionIdentity(session.attachCompletion, expected)) {
      throw new ApplicationFault(
        'CONFLICT_CONTENT',
        'attach completion proof does not match this materialization'
      )
    }
    return {
      sessionId,
      proof: { ...expected, completedAt: session.attachCompletion.completedAt }
    }
  }
  if (session.status !== 'waiting' || session.exitCode !== 0) {
    throw new ApplicationFault(
      'FIRST_ATTACH_SESSION_REQUIRED',
      'sync completion requires a successful waiting attach session'
    )
  }
  return { sessionId, proof: expected }
}

async function completePlannedAttach(
  sessions: SessionPort,
  completion: PlannedAttachCompletion | null
): Promise<boolean> {
  if (!completion) return false
  const outcome = await sessions.completeAttach(completion)
  if (outcome.status === 'not-authorized') {
    throw new ApplicationFault(
      'FIRST_ATTACH_SESSION_REQUIRED',
      'attach session is no longer authorized to complete this sync'
    )
  }
  if (outcome.status === 'proof-conflict') {
    throw new ApplicationFault(
      'CONFLICT_CONTENT',
      'attach completion proof conflicts with the durable session'
    )
  }
  if (outcome.session.status !== 'completed'
    || !sameAttachCompletionIdentity(outcome.session.attachCompletion, completion.proof)) {
    throw new ApplicationFault('PORT_FAILURE', 'session completion port returned an invalid proof', true)
  }
  return true
}

async function executeSync(
  runtime: ApplicationRuntimePort,
  sessions: SessionPort,
  p2: P2ApplicationPorts,
  p3: P3ApplicationPorts | undefined,
  transaction: ApplicationWriteTransaction | undefined,
  lockedIdentity: WorktreeIdentity | undefined,
  businessEvents: AuditEvent[],
  command: Extract<HubCommand, { kind: 'sync' }>
) {
  const materialization = requireP3(p3)
  if (!transaction) throw new ApplicationFault('PORT_FAILURE', 'write transaction is unavailable', true)
  const identity = await requireLockedWorktreeIdentity(p2, lockedIdentity, command.worktree)
  const planned = await computeMaterializationPlan(p2, materialization, command.worktree, identity)
  const { plan } = planned
  if (plan.planHash !== command.planHash) {
    throw new ApplicationFault('MATERIALIZE_PLAN_STALE', 'materialization plan no longer matches current state')
  }
  if (!plan.executable) throw materializationConflictFault(plan)
  const attachCompletion = await planAttachCompletion(
    runtime,
    sessions,
    command.sessionId,
    identity,
    plan.requested.materializationId
  )

  const externalNoChange = plan.current != null
    && plan.current.materializationId === plan.requested.materializationId
    && plan.current.visibilityStateId === plan.requested.visibilityStateId
    && planned.pin.materializedSnapshot === plan.requested.snapshotId
    && plan.operations.every((operation) => operation.action === 'keep')
    && plan.git.operations.every((operation) => operation.action === 'keep')
    && plan.git.configuration.action === 'keep'
  if (externalNoChange) {
    const sessionCompleted = await completePlannedAttach(sessions, attachCompletion)
    return {
      action: 'sync' as const,
      pathKey: identity.pathKey,
      worktreeId: identity.worktreeId,
      changed: false,
      planHash: plan.planHash,
      marker: plan.current as MaterializationMarkerV1,
      pin: planned.pin,
      summary: plan.summary,
      sessionCompleted
    }
  }

  const prepared = await materialization.materialize.prepare({
    worktree: command.worktree,
    identity,
    guard: Object.freeze({ revalidateLease: () => transaction.revalidateLease() }),
    plan,
    snapshot: planned.snapshot,
    runtimeAsset: planned.runtimeAsset
  })
  transaction.enlist(prepared.participant)
  checkedPreparedReport(prepared.report)
  if (!markerMatchesPlan(prepared.marker, plan)) {
    throw new ApplicationFault('MATERIALIZATION_MARKER_INVALID', 'prepared materialization marker does not match the approved plan')
  }
  const transition = transitionWorktreePin(planned.pin, {
    kind: 'recordMaterialized',
    snapshotId: plan.requested.snapshotId
  })
  if (!transition.ok) throw new ApplicationFault('INVALID_PIN', 'materialized pin transition is invalid')
  if (!transition.idempotent) {
    await p2.state.writeV2({
      ...planned.state,
      stateRevision: nextStateRevision(planned.state),
      worktrees: { ...planned.state.worktrees, [identity.pathKey]: transition.pin }
    })
  }
  await materialization.records.writeCurrent({
    schemaVersion: 1,
    pathKey: identity.pathKey,
    marker: prepared.marker
  })
  const sessionCompleted = await completePlannedAttach(sessions, attachCompletion)
  businessEvents.push(worktreeMaterializationEvent(
    runtime,
    command,
    'worktree.materialized',
    identity.pathKey,
    {
      pathKey: identity.pathKey,
      snapshotId: plan.requested.snapshotId,
      materializationId: plan.requested.materializationId,
      planHash: plan.planHash,
      operationCount: plan.operations.length,
      preparedBytes: prepared.report.preparedBytes
    }
  ))
  return {
    action: 'sync' as const,
    pathKey: identity.pathKey,
    worktreeId: identity.worktreeId,
    changed: true,
    planHash: plan.planHash,
    marker: prepared.marker,
    pin: transition.pin,
    summary: plan.summary,
    sessionCompleted
  }
}

function checkedLegacyMigrationRecord(
  value: unknown,
  migrationId: Sha256Identifier,
  identity: WorktreeIdentity
): LegacyMigrationRecordV1 | null {
  if (value == null) return null
  if (!verifyLegacyMigrationRecordIdentity(value)
    || value.migrationId !== migrationId
    || value.pathKey !== identity.pathKey
    || value.worktreeId !== identity.worktreeId) {
    throw new ApplicationFault('STATE_CORRUPT', 'legacy migration record failed integrity validation')
  }
  return value
}

function legacyPlanningFailure(
  errors: readonly { code: string }[],
  operation: 'migration' | 'rollback'
): ApplicationFault {
  const codes = new Set(errors.map((error) => error.code))
  if (codes.has('LEGACY_PIN_INVALID')) {
    return new ApplicationFault('WORKTREE_NOT_CLAIMED', 'legacy operation requires a matching claimed pin')
  }
  if (codes.has('LEGACY_MARKER_INVALID')) {
    return new ApplicationFault('MATERIALIZATION_MARKER_INVALID', 'legacy marker and durable truth disagree')
  }
  if (codes.has('LEGACY_RECORD_INVALID')) {
    return new ApplicationFault('STATE_CORRUPT', 'legacy migration record is invalid')
  }
  if (codes.has('LEGACY_SOURCE_INVALID')) {
    return new ApplicationFault('SNAPSHOT_INVALID', 'legacy materialization source is invalid')
  }
  return new ApplicationFault('PORT_FAILURE', 'legacy materialization facts failed validation', true)
}

function legacyPlanConflictFault(
  plan: LegacyMigrationPlanV1 | LegacyRollbackPlanV1,
  operation: 'migration' | 'rollback'
): ApplicationFault {
  if (plan.git.configuration.conflictKind === 'unsupportedWorktreeConfig') {
    return new ApplicationFault('UNSUPPORTED_LAYOUT', 'worktree-specific Git configuration is unavailable')
  }
  if (plan.git.configuration.conflictKind === 'siblingVisibilityRisk') {
    return new ApplicationFault(
      operation === 'rollback' ? 'LEGACY_ROLLBACK_CONFLICT' : 'CONFLICT_PATH',
      'legacy Git visibility cannot be changed without affecting another worktree'
    )
  }
  if (plan.git.configuration.conflictKind === 'excludeBaseUnsafe') {
    return new ApplicationFault(
      operation === 'rollback' ? 'LEGACY_ROLLBACK_CONFLICT' : 'CONFLICT_PATH',
      'the effective Git excludes source cannot be projected safely'
    )
  }
  if (operation === 'rollback') {
    return new ApplicationFault('LEGACY_ROLLBACK_CONFLICT', 'legacy rollback conflicts with current worktree state')
  }
  const kinds = new Set(plan.operations.flatMap((entry) => entry.conflict ? [entry.conflict.kind] : []))
  if (kinds.has('external-link')) {
    return new ApplicationFault('CONFLICT_EXTERNAL_LINK', 'a legacy target points outside the approved source')
  }
  if (kinds.has('dirty')) {
    return new ApplicationFault('CONFLICT_DIRTY', 'legacy content changed after it was observed')
  }
  if (kinds.has('unowned-content')) {
    return new ApplicationFault('CONFLICT_CONTENT', 'unmanaged content differs from the requested materialization')
  }
  return new ApplicationFault('CONFLICT_PATH', 'legacy materialization contains an unsafe target')
}

function legacyMaterializationEvent(
  runtime: ApplicationRuntimePort,
  command: HubCommand,
  type: 'worktree.legacy-migrated' | 'worktree.legacy-rolled-back',
  identity: WorktreeIdentity,
  details: Record<string, string | number | boolean | null>
): AuditEvent {
  return {
    eventVersion: CONTRACT_VERSION,
    id: runtime.nextId('audit'),
    type,
    at: runtime.nowIso(),
    requestId: command.meta.requestId,
    hostId: command.meta.hostId,
    transport: command.meta.transport,
    commandKind: command.kind,
    outcome: 'succeeded',
    subject: `worktree:${identity.pathKey}`,
    details
  }
}

async function computeLegacyMigrationPlan(
  p2: P2ApplicationPorts,
  p3: P3ApplicationPorts,
  worktree: string,
  identity: WorktreeIdentity
) {
  const source = await requireMaterializationSourceContext(p2, p3, identity)
  const markerMigrationId = source.durable?.marker?.origin.kind === 'legacyMigration'
    ? source.durable.marker.origin.migrationId
    : null
  let migration = markerMigrationId == null
    ? null
    : checkedLegacyMigrationRecord(
        await p3.records.readLegacyMigration(markerMigrationId),
        markerMigrationId,
        identity
      )
  const inspection = await p3.materialize.inspectLegacy({
    worktree,
    identity,
    snapshot: source.snapshot,
    runtimeAsset: source.runtimeAsset,
    selectedSkills: source.pin.selectedSkills,
    migration
  })
  const planningInput = () => ({
    pathKey: identity.pathKey,
    worktreeId: identity.worktreeId,
    stateRevision: source.state.stateRevision,
    pin: source.pin,
    snapshot: source.snapshot,
    runtimeAsset: source.runtimeAsset,
    durableMarker: source.durable,
    observedMarker: inspection.observedMarker,
    migrationRecord: migration,
    backupPrivateStateId: inspection.backupPrivateStateId,
    artifacts: inspection.artifacts,
    gitFacts: inspection.gitFacts,
    gitConfiguration: inspection.gitConfiguration,
    currentVisibilityState: inspection.currentVisibilityState,
    desiredVisibilityState: inspection.desiredVisibilityState
  })
  let planned = planLegacyMigration(planningInput())
  if (planned.ok && planned.status === 'planned' && planned.plan && migration == null) {
    migration = checkedLegacyMigrationRecord(
      await p3.records.readLegacyMigration(planned.plan.migrationId),
      planned.plan.migrationId,
      identity
    )
    if (migration) planned = planLegacyMigration(planningInput())
  }
  if (!planned.ok) throw legacyPlanningFailure(planned.errors, 'migration')
  if (planned.plan && !verifyLegacyMigrationPlanHash(planned.plan)) {
    throw new ApplicationFault('STATE_CORRUPT', 'legacy migration plan failed integrity validation')
  }
  return { ...source, migration, inspection, planned }
}

async function computeLegacyRollbackPlan(
  p2: P2ApplicationPorts,
  p3: P3ApplicationPorts,
  worktree: string,
  identity: WorktreeIdentity,
  migrationId: Sha256Identifier
) {
  const source = await requireMaterializationSourceContext(p2, p3, identity)
  const migration = checkedLegacyMigrationRecord(
    await p3.records.readLegacyMigration(migrationId),
    migrationId,
    identity
  )
  if (!migration) {
    throw new ApplicationFault('LEGACY_MIGRATION_NOT_FOUND', 'legacy migration record was not found')
  }
  const inspection = await p3.materialize.inspectLegacyRollback({
    worktree,
    identity,
    snapshot: source.snapshot,
    runtimeAsset: source.runtimeAsset,
    selectedSkills: source.pin.selectedSkills,
    migration
  })
  const planned = planLegacyRollback({
    pathKey: identity.pathKey,
    worktreeId: identity.worktreeId,
    stateRevision: source.state.stateRevision,
    pin: source.pin,
    snapshot: source.snapshot,
    runtimeAsset: source.runtimeAsset,
    durableMarker: source.durable,
    observedMarker: inspection.observedMarker,
    migrationRecord: migration,
    backupPrivateStateId: inspection.backupPrivateStateId,
    artifacts: inspection.artifacts,
    gitFacts: inspection.gitFacts,
    gitConfiguration: inspection.gitConfiguration,
    currentVisibilityState: inspection.currentVisibilityState,
    desiredVisibilityState: inspection.desiredVisibilityState,
    restoreGitFacts: inspection.restoreGitFacts,
    restoreGitConfiguration: inspection.restoreGitConfiguration,
    restoreSources: inspection.restoreSources
  })
  if (!planned.ok) throw legacyPlanningFailure(planned.errors, 'rollback')
  if (planned.plan && !verifyLegacyRollbackPlanHash(planned.plan)) {
    throw new ApplicationFault('STATE_CORRUPT', 'legacy rollback plan failed integrity validation')
  }
  return { ...source, migration, inspection, planned }
}

function checkedPreparedReport(report: { preparedOperations: number; preparedBytes: number }): void {
  if (!Number.isSafeInteger(report.preparedOperations)
    || report.preparedOperations < 0
    || !Number.isSafeInteger(report.preparedBytes)
    || report.preparedBytes < 0) {
    throw new ApplicationFault('PORT_FAILURE', 'materialization adapter returned an invalid preparation report', true)
  }
}

function markerMatchesLegacyMigrationPlan(
  marker: MaterializationMarkerV1,
  plan: LegacyMigrationPlanV1
): boolean {
  return verifyMaterializationMarker(marker)
    && marker.planHash === plan.planHash
    && marker.pathKey === plan.pathKey
    && marker.worktreeId === plan.worktreeId
    && marker.snapshotId === plan.requested.snapshotId
    && sameStrings(marker.selectedSkills, plan.requested.selectedSkills)
    && marker.runtimeRevision === plan.requested.runtimeRevision
    && marker.runtimeAssetId === plan.requested.runtimeAssetId
    && marker.visibilityStateId === plan.requested.visibilityStateId
    && marker.materializationId === plan.requested.materializationId
    && marker.origin.kind === 'legacyMigration'
    && marker.origin.migrationId === plan.migrationId
}

function migrationRecordMatchesPlan(
  record: LegacyMigrationRecordV1,
  plan: LegacyMigrationPlanV1,
  marker: MaterializationMarkerV1
): boolean {
  return verifyLegacyMigrationRecordIdentity(record)
    && record.status === 'committed'
    && record.rollbackPlanHash === undefined
    && record.migrationId === plan.migrationId
    && record.planHash === plan.planHash
    && record.pathKey === plan.pathKey
    && record.worktreeId === plan.worktreeId
    && record.snapshotId === plan.requested.snapshotId
    && record.materializationId === plan.requested.materializationId
    && record.visibilityStateId === plan.requested.visibilityStateId
    && record.backupManifestId === plan.backupManifestId
    && record.backupPrivateStateId === plan.backupPrivateStateId
    && marker.visibilityStateId === record.visibilityStateId
    && marker.origin.kind === 'legacyMigration'
    && marker.origin.migrationId === record.migrationId
}

async function executeMigrateLegacy(
  runtime: ApplicationRuntimePort,
  p2: P2ApplicationPorts,
  p3: P3ApplicationPorts | undefined,
  transaction: ApplicationWriteTransaction | undefined,
  lockedIdentity: WorktreeIdentity | undefined,
  businessEvents: AuditEvent[],
  command: Extract<HubCommand, { kind: 'migrateLegacy' }>
) {
  const materialization = requireP3(p3)
  if (!transaction) throw new ApplicationFault('PORT_FAILURE', 'write transaction is unavailable', true)
  const identity = await requireLockedWorktreeIdentity(p2, lockedIdentity, command.worktree)
  const computed = await computeLegacyMigrationPlan(p2, materialization, command.worktree, identity)
  if (computed.planned.status === 'already-migrated') {
    return {
      action: 'migrateLegacy' as const,
      mode: command.mode,
      status: 'already-migrated' as const,
      plan: null,
      migration: computed.planned.record,
      pin: computed.pin
    }
  }
  if (computed.planned.status === 'not-required') {
    return {
      action: 'migrateLegacy' as const,
      mode: command.mode,
      status: 'not-required' as const,
      plan: null,
      migration: null,
      pin: computed.pin
    }
  }
  const plan = computed.planned.plan
  if (command.mode === 'dryRun') {
    return {
      action: 'migrateLegacy' as const,
      mode: 'dryRun' as const,
      status: plan.executable ? 'planned' as const : 'conflict' as const,
      plan,
      migration: computed.migration,
      pin: computed.pin
    }
  }
  if (command.planHash !== plan.planHash) {
    throw new ApplicationFault('LEGACY_PLAN_STALE', 'legacy migration plan no longer matches current state')
  }
  if (!plan.executable) throw legacyPlanConflictFault(plan, 'migration')
  const prepared = await materialization.materialize.prepareLegacyMigration({
    worktree: command.worktree,
    identity,
    guard: Object.freeze({ revalidateLease: () => transaction.revalidateLease() }),
    plan,
    snapshot: computed.snapshot,
    runtimeAsset: computed.runtimeAsset
  })
  transaction.enlist(prepared.participant)
  checkedPreparedReport(prepared.report)
  if (!markerMatchesLegacyMigrationPlan(prepared.marker, plan)
    || !migrationRecordMatchesPlan(prepared.record, plan, prepared.marker)) {
    throw new ApplicationFault(
      'MATERIALIZATION_MARKER_INVALID',
      'prepared legacy migration proof does not match the approved plan'
    )
  }
  const transition = transitionWorktreePin(computed.pin, {
    kind: 'recordMaterialized',
    snapshotId: plan.requested.snapshotId
  })
  if (!transition.ok) throw new ApplicationFault('INVALID_PIN', 'legacy migration pin transition is invalid')
  if (!transition.idempotent) {
    await p2.state.writeV2({
      ...computed.state,
      stateRevision: nextStateRevision(computed.state),
      worktrees: { ...computed.state.worktrees, [identity.pathKey]: transition.pin }
    })
  }
  await materialization.records.writeCurrent({
    schemaVersion: 1,
    pathKey: identity.pathKey,
    marker: prepared.marker
  })
  await materialization.records.writeLegacyMigration(prepared.record)
  businessEvents.push(legacyMaterializationEvent(
    runtime,
    command,
    'worktree.legacy-migrated',
    identity,
    {
      pathKey: identity.pathKey,
      migrationId: prepared.record.migrationId,
      materializationId: prepared.marker.materializationId,
      planHash: plan.planHash,
      replacementCount: plan.summary.replaceWithCopy,
      preparedBytes: prepared.report.preparedBytes
    }
  ))
  return {
    action: 'migrateLegacy' as const,
    mode: 'commit' as const,
    status: 'committed' as const,
    plan,
    migration: prepared.record,
    pin: transition.pin
  }
}

async function executeRollbackLegacyMigration(
  runtime: ApplicationRuntimePort,
  p2: P2ApplicationPorts,
  p3: P3ApplicationPorts | undefined,
  transaction: ApplicationWriteTransaction | undefined,
  lockedIdentity: WorktreeIdentity | undefined,
  businessEvents: AuditEvent[],
  command: Extract<HubCommand, { kind: 'rollbackLegacyMigration' }>
) {
  const materialization = requireP3(p3)
  if (!transaction) throw new ApplicationFault('PORT_FAILURE', 'write transaction is unavailable', true)
  const identity = await requireLockedWorktreeIdentity(p2, lockedIdentity, command.worktree)
  const computed = await computeLegacyRollbackPlan(
    p2,
    materialization,
    command.worktree,
    identity,
    command.migrationId
  )
  if (computed.planned.status === 'already-rolled-back') {
    return {
      action: 'rollbackLegacyMigration' as const,
      mode: command.mode,
      status: 'already-rolled-back' as const,
      plan: null,
      migration: computed.planned.record,
      pin: computed.pin
    }
  }
  const plan = computed.planned.plan
  if (command.mode === 'dryRun') {
    return {
      action: 'rollbackLegacyMigration' as const,
      mode: 'dryRun' as const,
      status: plan.executable ? 'planned' as const : 'conflict' as const,
      plan,
      migration: computed.migration,
      pin: computed.pin
    }
  }
  if (command.planHash !== plan.planHash) {
    throw new ApplicationFault('LEGACY_PLAN_STALE', 'legacy rollback plan no longer matches current state')
  }
  if (!plan.executable) throw legacyPlanConflictFault(plan, 'rollback')
  const prepared = await materialization.materialize.prepareLegacyRollback({
    worktree: command.worktree,
    identity,
    guard: Object.freeze({ revalidateLease: () => transaction.revalidateLease() }),
    plan,
    migration: computed.migration,
    snapshot: computed.snapshot,
    runtimeAsset: computed.runtimeAsset
  })
  transaction.enlist(prepared.participant)
  checkedPreparedReport(prepared.report)
  if (!verifyLegacyMigrationRecordIdentity(prepared.record)
    || prepared.record.migrationId !== plan.migrationId
    || prepared.record.status !== 'rolledBack'
    || prepared.record.rollbackPlanHash !== plan.planHash
    || prepared.record.backupManifestId !== plan.backupManifestId
    || prepared.record.backupPrivateStateId !== plan.backupPrivateStateId
    || prepared.record.pathKey !== identity.pathKey
    || prepared.record.worktreeId !== identity.worktreeId) {
    throw new ApplicationFault('STATE_CORRUPT', 'prepared legacy rollback record does not match the approved plan')
  }
  const transition = rollbackMaterializedWorktreePin(computed.pin)
  if (!transition.ok) throw new ApplicationFault('INVALID_PIN', 'legacy rollback pin transition is invalid')
  if (!transition.idempotent) {
    await p2.state.writeV2({
      ...computed.state,
      stateRevision: nextStateRevision(computed.state),
      worktrees: { ...computed.state.worktrees, [identity.pathKey]: transition.pin }
    })
  }
  await materialization.records.writeCurrent({
    schemaVersion: 1,
    pathKey: identity.pathKey,
    marker: null
  })
  await materialization.records.writeLegacyMigration(prepared.record)
  businessEvents.push(legacyMaterializationEvent(
    runtime,
    command,
    'worktree.legacy-rolled-back',
    identity,
    {
      pathKey: identity.pathKey,
      migrationId: prepared.record.migrationId,
      planHash: plan.planHash,
      restoredCount: plan.summary.restoreLink,
      preparedBytes: prepared.report.preparedBytes
    }
  ))
  return {
    action: 'rollbackLegacyMigration' as const,
    mode: 'commit' as const,
    status: 'rolled-back' as const,
    plan,
    migration: prepared.record,
    pin: transition.pin
  }
}

function defaultMigrationSnapshot(
  manifests: readonly LibrarySnapshotManifestV1[]
): Sha256Identifier {
  const ordered = [...manifests].sort((left, right) => {
    return compareUtf8Bytes(left.createdAt, right.createdAt)
      || compareUtf8Bytes(left.snapshotId, right.snapshotId)
  })
  const selected = ordered.at(-1)
  if (!selected) throw new ApplicationFault('SNAPSHOT_NOT_FOUND', 'migration requires a library snapshot')
  return selected.snapshotId
}

async function executeMigration(
  runtime: ApplicationRuntimePort,
  p2: P2ApplicationPorts,
  businessEvents: AuditEvent[],
  command: Extract<HubCommand, { kind: 'migrateState' }>
) {
  const inspection = await inspectP2State(p2)
  if (inspection.status === 'current') {
    const state = inspection.current
    if (!state) throw new ApplicationFault('STATE_CORRUPT', 'current state is unavailable')
    return {
      action: 'migrateState' as const,
      mode: command.mode,
      status: 'already-current' as const,
      plan: null,
      state
    }
  }
  if (inspection.status === 'unsupported') {
    throw new ApplicationFault('STATE_VERSION_UNSUPPORTED', 'state schema version is unsupported')
  }
  const snapshots = await physicalSnapshots(p2)
  const defaultSnapshot = defaultMigrationSnapshot(snapshots)
  const worktrees = [...await p2.state.observeV1Worktrees()]
    .map((fact) => ({ ...fact, selectedSkills: [...fact.selectedSkills].sort(compareUtf8Bytes) }))
    .sort((left, right) => compareUtf8Bytes(left.pathKey, right.pathKey))
  const legacyState = inspection.legacy
  if (!legacyState) throw new ApplicationFault('STATE_CORRUPT', 'legacy state is unavailable')
  const sourcePayload = canonicalJson({
    runtimeRevision: inspection.runtimeRevision,
    legacyState,
    worktrees
  } as unknown as CanonicalJsonValue)
  const sourceHex = runtime.sha256(`skill-graft/state-migration-source/v1\0${sourcePayload}`).toLowerCase()
  const sourceDigest = (sourceHex.startsWith('sha256:') ? sourceHex : `sha256:${sourceHex}`) as Sha256Identifier
  if (!SHA256_IDENTIFIER.test(sourceDigest)) {
    throw new ApplicationFault('PORT_FAILURE', 'runtime returned an invalid SHA-256 digest', true)
  }
  const planned = planV1ToV2Migration({
    sourceDigest,
    runtimeRevision: inspection.runtimeRevision,
    legacyState,
    lastIngestGameRepoId: legacyState.lastIngest
      ? gameRepositoryId(runtime, legacyState.lastIngest.gameRepo)
      : null,
    worktrees,
    defaultSnapshot,
    librarySnapshots: snapshots.map((manifest) => manifest.snapshotId)
  })
  if (!planned.ok) throw new ApplicationFault('STATE_CORRUPT', 'legacy state cannot be migrated')
  if (!verifyMigrationPlanHash(planned.plan)) {
    throw new ApplicationFault('STATE_CORRUPT', 'migration plan failed verification')
  }
  if (command.mode === 'dryRun') {
    return {
      action: 'migrateState' as const,
      mode: 'dryRun' as const,
      status: 'planned' as const,
      plan: planned.plan,
      state: null
    }
  }
  if (command.planHash !== planned.plan.planHash) {
    throw new ApplicationFault('MIGRATION_PLAN_STALE', 'migration plan hash no longer matches current state')
  }
  await p2.state.writeV2(planned.plan.targetState)
  businessEvents.push(stateChangedEvent(runtime, command, `migration:${planned.plan.planHash}`, {
    change: 'state-migrated',
    planHash: planned.plan.planHash,
    sourceDigest: planned.plan.sourceDigest,
    targetSchemaVersion: HUB_STATE_SCHEMA_VERSION
  }))
  return {
    action: 'migrateState' as const,
    mode: 'commit' as const,
    status: 'committed' as const,
    plan: planned.plan,
    state: planned.plan.targetState
  }
}

async function executeHandler(
  runtime: ApplicationRuntimePort,
  queries: HubQueryPort,
  useCases: SharedUseCasePorts,
  legacyAttach: LegacyAttachPort,
  legacyDetach: LegacyDetachPort,
  sessions: SessionPort,
  ledger: RequestLedgerPort,
  p2: P2ApplicationPorts,
  p3: P3ApplicationPorts | undefined,
  writeTransaction: ApplicationWriteTransaction | undefined,
  lockedWorktreeIdentity: WorktreeIdentity | undefined,
  businessEvents: AuditEvent[],
  command: HubCommand
): Promise<unknown> {
  const inboxUseCases: SharedUseCasePorts = {
    ...useCases,
    state: createApplicationInboxStatePort(runtime, p2, useCases.state)
  }
  switch (command.kind) {
    case 'status': {
      const sessionViews = (await sessions.list()).filter((item) => item.status === 'queued' || item.status === 'running')
      const facts = await queries.readStatusFacts()
      const skills = projectSkillInventory(await queries.listSkillFacts())
      return projectHubStatus({ facts, skills, sessions: sessionViews })
    }
    case 'listSkills':
      return projectSkillInventory(await queries.listSkillFacts())
    case 'listWorktrees':
      return projectWorktreeList(await queries.readWorktreeFacts())
    case 'readSkill': {
      if (!command.path?.trim()) throw new ApplicationFault('INVALID_ARGUMENT', 'path is required')
      const requested = command.path
      const result = await queries.readSkill(requested)
      if (result.status === 'invalid-path') {
        const suffix = result.reason === 'escaped-link' ? ' through a link' : ''
        throw new ApplicationFault('INVALID_ARGUMENT', `path escaped hub${suffix}`)
      }
      if (result.status === 'not-found') {
        if (result.reason === 'skill-md-missing') throw new ApplicationFault('NOT_FOUND', 'no SKILL.md')
        throw new ApplicationFault('NOT_FOUND', `missing ${requested}`)
      }
      return { path: requested, content: result.content }
    }
    case 'listHistory': {
      const limit = Math.max(1, Math.min(200, command.limit || 50))
      const records = [...await queries.listHistory(limit)]
      const remaining = Math.max(0, limit - records.length)
      if (remaining > 0) {
        const events = await ledger.listEvents(remaining)
        records.push(...events.map((event) => ({
          id: event.id,
          type: event.type,
          at: event.at,
          requestId: event.requestId,
          summary: event.outcome,
          metadata: { commandKind: event.commandKind, outcome: event.outcome }
        })))
      }
      return { records: records.slice(0, limit), cursor: command.cursor }
    }
    case 'listSessions': {
      const all = await sessions.list()
      const filtered = command.statuses?.length ? all.filter((item) => command.statuses?.includes(item.status)) : all
      return { sessions: filtered }
    }
    case 'getSession': {
      if (!command.sessionId?.trim()) throw new ApplicationFault('INVALID_ARGUMENT', 'sessionId is required')
      const session = await sessions.get(command.sessionId)
      if (!session) throw new ApplicationFault('NOT_FOUND', 'session not found')
      return { session }
    }
    case 'inspectSchema': {
      const inspection = await inspectP2State(p2)
      return {
        action: 'inspectSchema' as const,
        status: inspection.status,
        detectedSchemaVersion: inspection.detectedSchemaVersion,
        currentSchemaVersion: HUB_STATE_SCHEMA_VERSION,
        stateRevision: inspection.stateRevision,
        runtimeRevision: inspection.runtimeRevision,
        writable: inspection.status === 'current',
        migrationRequired: inspection.status === 'empty' || inspection.status === 'legacy'
      }
    }
    case 'listSnapshots':
      return { snapshots: await visibleSnapshots(p2) }
    case 'getSnapshot': {
      const snapshots = await visibleSnapshots(p2)
      const visible = snapshots.find((manifest) => manifest.snapshotId === command.snapshotId)
      if (!visible) throw new ApplicationFault('SNAPSHOT_NOT_FOUND', 'library snapshot was not found')
      const snapshot = await checkedSnapshotRead(p2, visible.snapshotId)
      if (!snapshot) throw new ApplicationFault('SNAPSHOT_NOT_FOUND', 'library snapshot was not found')
      return { snapshot }
    }
    case 'getPin': {
      const identity = await p2.identities.resolve(command.worktree)
      const state = await requireCurrentState(p2)
      return {
        worktree: command.worktree,
        pathKey: identity.pathKey,
        worktreeId: identity.worktreeId,
        pin: state.worktrees[identity.pathKey] ?? null
      }
    }
    case 'planSync':
      return executePlanSync(p2, p3, command)
    case 'repairLegacy': {
      if (!command.worktree?.trim()) throw new ApplicationFault('INVALID_ARGUMENT', 'worktree is required')
      return executeLegacyRepair(legacyAttach, command.worktree)
    }
    case 'applyLegacyAttach': {
      const inspection = await legacyAttach.inspect(command.worktree)
      const authorized = await authorizeFirstAttach(sessions, inspection.worktree.targetId, command.sessionId)
      const decision = planLegacyAttach({
        inspection,
        mode: 'firstAttach',
        sourcePolicy: command.sourcePolicy as LegacyAttachSourcePolicy | undefined,
        visibility: command.visibility,
        configureGit: command.configureGit,
        attachSessionAuthorized: authorized
      })
      if (decision.decision !== 'apply') {
        if (decision.decision === 'noop') throw new ApplicationFault('INTERNAL_ERROR', 'unexpected attach plan outcome')
        throw attachFault(decision)
      }
      const report = await legacyAttach.apply(decision.plan)
      return {
        action: 'applyLegacyAttach',
        mode: 'legacyLinks',
        worktree: decision.plan.worktree,
        changed: report.changed,
        claim: report.claim,
        sourcePolicy: decision.plan.sourcePolicy,
        plan: {
          artifacts: decision.plan.artifacts.map((artifact) => ({
            id: artifact.id,
            label: artifact.label,
            action: artifact.action
          })),
          visibility: decision.plan.visibility.mode,
          configureGit: decision.plan.configureGit,
          recordClaim: decision.plan.claim === 'create'
        },
        effects: report.effects,
        visibility: report.visibility,
        gitConfigured: report.gitConfigured
      }
    }
    case 'applyLegacyDetach': {
      const inspection = await legacyDetach.inspect(command.worktree)
      const authorized = await authorizeDetach(sessions, inspection.worktree.targetId, command.sessionId)
      const decision = planLegacyDetach({ inspection, detachSessionAuthorized: authorized })
      if (decision.decision === 'noop') {
        return {
          action: 'applyLegacyDetach',
          mode: 'legacyLinks',
          worktree: decision.worktree,
          changed: false,
          detached: true,
          reason: 'notAttached',
          plan: { artifacts: [], restorePaths: [], removeClaim: false },
          effects: [],
          restoredTracked: 0,
          claim: 'alreadyDetached'
        }
      }
      if (decision.decision !== 'apply') throw detachFault(decision)
      const report = await legacyDetach.apply(decision.plan)
      return {
        action: 'applyLegacyDetach',
        mode: 'legacyLinks',
        worktree: decision.plan.worktree,
        changed: report.changed,
        detached: true,
        plan: {
          artifacts: decision.plan.artifacts.map((artifact) => ({
            id: artifact.id,
            label: artifact.label,
            action: artifact.action
          })),
          restorePaths: decision.plan.restorePaths,
          removeClaim: decision.plan.removeClaim
        },
        effects: report.effects,
        restoredTracked: report.restoredTracked,
        claim: report.claim
      }
    }
    case 'ingest': {
      const ingested = await executeIngestUseCase(runtime, inboxUseCases, command)
      let session: SessionView | undefined
      if (!command.dryRun && command.dispatch && ingested.created > 0) {
        session = await sessions.start({
          kind: 'analyze',
          target: { kind: 'hub', id: 'hub' },
          intent: 'Analyze queued inbox skill updates',
          inboxIds: ingested.items.map((item) => item.id),
          options: { start: false }
        })
      }
      return {
        action: 'ingest',
        gameRepo: ingested.gameRepo,
        created: ingested.created,
        items: ingested.items.map(inboxView),
        dryRun: Boolean(command.dryRun),
        dispatched: Boolean(session),
        session: session ? commandSessionOutcome(session) : undefined
      }
    }
    case 'decide': {
      const decided = await executeDecisionUseCase(runtime, inboxUseCases, command)
      return {
        action: decided.action,
        item: inboxView(decided.item),
        worktrees: {
          applied: decided.linked,
          skipped: decided.skipped
        }
      }
    }
    case 'attach': {
      const worktree = await validateAttach(legacyAttach, command.worktree)
      const session = await startSession(
        sessions,
        'attach',
        { ...command, worktree: worktree.resolvedPath },
        undefined,
        { kind: 'worktree', id: worktree.targetId }
      )
      return { action: 'attach', session: commandSessionOutcome(session), applied: null }
    }
    case 'detach': {
      const worktree = await validateDetach(legacyDetach, command.worktree)
      const session = await startSession(
        sessions,
        'detach',
        { ...command, worktree: worktree.resolvedPath },
        undefined,
        { kind: 'worktree', id: worktree.targetId }
      )
      return { action: 'detach', session: commandSessionOutcome(session), applied: null }
    }
    case 'edit': {
      const session = await startSession(sessions, 'edit', command)
      return { action: 'edit', session: commandSessionOutcome(session), applied: null }
    }
    case 'chat': {
      const session = await startSession(sessions, 'chat', command)
      return { action: 'chat', session: commandSessionOutcome(session), applied: null }
    }
    case 'analyze': {
      const state = await inboxUseCases.state.readState()
      const inboxIds = command.inboxId
        ? [command.inboxId]
        : state.items.filter((item) => item.status === 'queued' || item.status === 'proposed').map((item) => item.id)
      if (command.inboxId && !state.items.some((item) => item.id === command.inboxId)) {
        throw new ApplicationFault('NOT_FOUND', 'inbox item not found')
      }
      const session = await startSession(sessions, 'analyze', command, inboxIds)
      businessEvents.push(...await applyAnalyzeCompletion(runtime, inboxUseCases, command, session))
      return { action: 'analyze', session: commandSessionOutcome(session), applied: null }
    }
    case 'resumeSession': {
      if (!command.message?.trim()) throw new ApplicationFault('INVALID_ARGUMENT', 'message is required')
      if (!await sessions.get(command.sessionId)) throw new ApplicationFault('NOT_FOUND', 'session not found')
      const session = await sessions.resume({ sessionId: command.sessionId, message: command.message, options: command.runner })
      businessEvents.push(...await applyAnalyzeCompletion(runtime, inboxUseCases, command, session))
      return { action: 'resumeSession', session: commandSessionOutcome(session), applied: null }
    }
    case 'reapSessions': {
      const reaped = await sessions.reap(command.sessionIds)
      for (const session of reaped) {
        businessEvents.push(...await applyAnalyzeCompletion(runtime, inboxUseCases, command, session))
      }
      return { action: 'reapSessions', sessions: reaped.map(commandSessionOutcome) }
    }
    case 'createSnapshot':
      return executeCreateSnapshot(runtime, p2, businessEvents, command)
    case 'setPin':
      return executeSetPin(runtime, p2, lockedWorktreeIdentity, businessEvents, command)
    case 'migrateState':
      return executeMigration(runtime, p2, businessEvents, command)
    case 'claimWorktree':
      return executeClaimWorktree(runtime, sessions, p2, p3, lockedWorktreeIdentity, businessEvents, command)
    case 'sync':
      return executeSync(
        runtime,
        sessions,
        p2,
        p3,
        writeTransaction,
        lockedWorktreeIdentity,
        businessEvents,
        command
      )
    case 'migrateLegacy':
      return executeMigrateLegacy(
        runtime,
        p2,
        p3,
        writeTransaction,
        lockedWorktreeIdentity,
        businessEvents,
        command
      )
    case 'rollbackLegacyMigration':
      return executeRollbackLegacyMigration(
        runtime,
        p2,
        p3,
        writeTransaction,
        lockedWorktreeIdentity,
        businessEvents,
        command
      )
    default:
      throw new ApplicationFault('UNSUPPORTED_COMMAND', `unsupported command: ${(command as HubCommand).kind}`)
  }
}

function replayResult(entry: RequestLedgerEntry): HubCommandResult {
  if (!entry.result) throw new ApplicationFault('REQUEST_IN_PROGRESS', 'request result is not available', true)
  return { ...entry.result, meta: { ...entry.result.meta, replayed: true } } as HubCommandResult
}

function portFailureEnvelope(command: HubCommand, error: unknown, prefix = 'application port failed'): HubCommandResult {
  return failureEnvelope(command, {
    code: 'PORT_FAILURE',
    message: `${prefix}: ${errorOf(error).message}`,
    retryable: true
  })
}

function worktreeLocatorForWrite(command: HubCommand): string | null {
  // Copy-based worktree writes share the hub-global -> pathKey lock domain.
  // P1 legacy attach/detach retain their original adapter transaction until
  // the explicit P3 migration command takes ownership of their artifacts.
  switch (command.kind) {
    case 'setPin':
    case 'claimWorktree':
    case 'sync':
    case 'migrateLegacy':
    case 'rollbackLegacyMigration':
      return command.worktree
    default:
      return null
  }
}

async function writeTransactionContext(
  p2: P2ApplicationPorts,
  command: HubCommand
): Promise<{
  transactionIdentity: ApplicationTransactionIdentity
  worktreeIdentity?: WorktreeIdentity
}> {
  const commandKind = command.kind as WriteCommandKind
  const fields = {
    hostId: command.meta.hostId,
    commandKind,
    requestId: command.meta.requestId
  }
  const worktree = worktreeLocatorForWrite(command)
  if (worktree == null) {
    return { transactionIdentity: { scope: 'hub-global', key: 'hub-global', ...fields } }
  }
  const worktreeIdentity = await p2.identities.resolve(worktree)
  return {
    transactionIdentity: { scope: 'worktree', key: worktreeIdentity.pathKey, ...fields },
    worktreeIdentity
  }
}

export function createHubApplication(options: HubApplicationOptions): HubApplication {
  const {
    runtime,
    recovery,
    queries,
    useCases,
    legacyAttach,
    legacyDetach,
    sessions,
    ledger,
    p2,
    p3,
    transactions,
    trace
  } = options
  let writeTail: Promise<void> = Promise.resolve()
  let traceSequence = 0

  const runValidated = async (command: HubCommand): Promise<HubCommandResult> => {
    if (!WRITE_KINDS.has(command.kind)) {
      try {
        return resultEnvelope(
          command,
          await executeHandler(
            runtime,
            queries,
            useCases,
            legacyAttach,
            legacyDetach,
            sessions,
            ledger,
            p2,
            p3,
            undefined,
            undefined,
            [],
            command
          )
        )
      } catch (error) {
        return failureEnvelope(command, errorOf(error))
      }
    }

    const digest = commandDigest(runtime, command)
    const transactionContext = await writeTransactionContext(p2, command)
    return transactions.withWriteTransaction(transactionContext.transactionIdentity, async (transaction) => {
      // Unknown future schemas are observable through inspectSchema but never
      // enter a write handler or publish a ledger/audit outcome. Recheck under
      // the acquired lease so a concurrent schema replacement cannot race a
      // previously observed compatible version.
      const worktree = worktreeLocatorForWrite(command)
      if (worktree != null) {
        // The raw locator is resolved before locking only to choose the opaque
        // lock key. Re-resolve and compare before recovery or any durable read
        // so an alias substitution cannot make lock A authorize worktree B.
        const identity = await requireLockedWorktreeIdentity(
          p2,
          transactionContext.worktreeIdentity,
          worktree
        )
        if (p3) {
          const stateInspection = await inspectP2State(p2, undefined, false)
          if (stateInspection.status === 'unsupported') {
            throw new ApplicationFault(
              'STATE_VERSION_UNSUPPORTED',
              'state schema version is unsupported'
            )
          }
          const currentState = stateInspection.status === 'current'
            ? stateInspection.current
            : undefined
          if (stateInspection.status === 'current' && !currentState) {
            throw new ApplicationFault('STATE_CORRUPT', 'current state is unavailable')
          }
          const pin = currentState?.worktrees[identity.pathKey] ?? null
          const durable = checkedMaterializationRecord(
            await p3.records.readCurrent(identity.pathKey),
            identity.pathKey
          )
          // Recovery runs under both leases and before replay lookup. A request
          // whose external participant committed before a crash is therefore
          // finalized before its durable result can be replayed.
          await p3.materialize.recover({
            worktree,
            identity,
            durable,
            pin,
            stateRevision: currentState?.stateRevision ?? null,
            guard: Object.freeze({
              revalidateLease: () => transaction.revalidateLease()
            })
          })
        }
      }
      const existing = await ledger.read(command.meta.requestId)
      if (existing) {
        if (existing.digest !== digest || existing.commandKind !== command.kind) {
          return transaction.commit(failureEnvelope(command, {
            code: 'REQUEST_ID_CONFLICT',
            message: 'requestId is already bound to a different command',
            retryable: false
          }))
        }
        if (existing.status !== 'completed' || !existing.result) {
          return transaction.commit(failureEnvelope(command, {
            code: 'REQUEST_IN_PROGRESS',
            message: 'request has started but no terminal result is available',
            retryable: true
          }))
        }
        return transaction.commit(replayResult(existing))
      }

      const started: RequestLedgerEntry = {
        requestId: command.meta.requestId,
        digest,
        commandKind: command.kind,
        status: 'started',
        startedAt: runtime.nowIso()
      }
      await ledger.begin(started)
      const handlerSavepoint = transaction.savepoint()

      let data: unknown
      let handlerError: HubError | undefined
      const businessEvents: AuditEvent[] = []
      try {
        await assertWriteSchemaCompatible(p2)
        data = await executeHandler(
          runtime,
          queries,
          useCases,
          legacyAttach,
          legacyDetach,
          sessions,
          ledger,
          p2,
          p3,
          transaction,
          transactionContext.worktreeIdentity,
          businessEvents,
          command
        )
      } catch (caught) {
        const transactionError = transactionErrorOf(caught)
        const abortApplicationFault = caught instanceof ApplicationFault
          && (caught.code === 'STATE_VERSION_UNSUPPORTED' || caught.code === 'LOCK_NOT_OWNED')
        const durableBusinessFailure = transactionError
          && (transactionError.code === 'SNAPSHOT_INVALID'
            || transactionError.code === 'RUNTIME_ASSET_INVALID'
            || transactionError.code === 'MATERIALIZATION_MARKER_INVALID'
            || transactionError.code === 'UNSUPPORTED_LAYOUT')
        if (abortApplicationFault || transactionError && !durableBusinessFailure) {
          return transaction.abort(caught)
        }
        transaction.rollbackTo(handlerSavepoint)
        businessEvents.length = 0
        handlerError = safeHandlerError(command, transactionError ?? errorOf(caught))
      }

      // Creating the terminal event and completing the ledger are part of the
      // transaction's terminal persistence. Any failure here escapes the
      // callback, so the adapter publishes none of the staged documents.
      const event = terminalEvent(runtime, command, handlerError)
      const events = [...businessEvents, event]
      const result = handlerError
        ? failureEnvelope(command, handlerError, events)
        : resultEnvelope(command, data, events)
      await ledger.complete(
        { ...started, status: 'completed', completedAt: event.at, result },
        events.length === 1 ? event : events
      )
      return transaction.commit(result)
    })
  }

  const executeValidated = async (command: HubCommand): Promise<HubCommandResult> => {
    try {
      // planSync is an explicit zero-write observation. Unlike other commands
      // it must not trigger even host recovery; worktree recovery happens only
      // after a write command owns both leases.
      if (command.kind !== 'planSync') await recovery?.recover()
      return await runValidated(command)
    } catch (error) {
      return failureEnvelope(command, errorOf(error))
    }
  }

  const run = async (command: HubCommand): Promise<HubCommandResult> => {
    try {
      validate(command)
    } catch (error) {
      return failureEnvelope(command, errorOf(error))
    }
    if (!trace) return executeValidated(command)

    let requestHash: string
    try {
      requestHash = await trace.hashRequestId(command.meta.requestId)
    } catch {
      return executeValidated(command)
    }
    const sequence = ++traceSequence
    let entryWritten = false
    try {
      await trace.append({
        phase: 'entry',
        sequence,
        transport: command.meta.transport,
        commandKind: command.kind,
        requestHash,
        handlerIdentity: 'application.commandBus'
      })
      entryWritten = true
    } catch {
      /* diagnostics must not affect command execution */
    }

    const result = await executeValidated(command)
    if (entryWritten) {
      try {
        await trace.append({
          phase: 'result',
          sequence,
          transport: command.meta.transport,
          commandKind: command.kind,
          requestHash,
          handlerIdentity: 'application.commandBus',
          ok: result.ok,
          replayed: result.meta.replayed
        })
      } catch {
        /* diagnostics must not affect command execution */
      }
    }
    return result
  }

  const guardedRun = async (command: HubCommand): Promise<HubCommandResult> => {
    try {
      return await run(command)
    } catch (error) {
      return portFailureEnvelope(command, error)
    }
  }

  return {
    execute(command) {
      if (!WRITE_KINDS.has((command as HubCommand | undefined)?.kind || '')) return guardedRun(command)
      const pending = writeTail.then(() => guardedRun(command), () => guardedRun(command))
      writeTail = pending.then(() => undefined, () => undefined)
      return pending
    }
  }
}

export function isApplicationSuccess<K extends HubCommandKind>(
  result: HubCommandResult
): result is HubCommandResult & { ok: true; data: CommandDataByKind[K] } {
  return result.ok
}
