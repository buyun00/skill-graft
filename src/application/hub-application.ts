import {
  CONTRACT_VERSION,
  QUERY_COMMAND_KINDS,
  UNKNOWN_COMMAND_KIND,
  WRITE_COMMAND_KINDS,
  type AuditEvent,
  type CommandDataByKind,
  type HubCommand,
  type HubCommandKind,
  type HubCommandResult,
  type HubError,
  type HubErrorCode,
  type InboxItemView,
  type LegacyAttachSourcePolicy,
  type SessionKind,
  type SessionTarget,
  type SessionView
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
  projectHubStatus,
  projectSkillInventory,
  projectWorktreeList
} from '../core/query-projections.js'
import type {
  ApplicationRuntimePort,
  HubQueryPort,
  InvocationTracePort,
  LegacyAttachPort,
  LegacyDetachPort,
  RequestLedgerEntry,
  RequestLedgerPort,
  SessionPort,
  SessionStartRequest
} from './ports.js'
import type { SharedUseCasePorts } from './use-case-ports.js'
import { portFaultError } from './port-fault.js'

const QUERY_KINDS = new Set<string>(QUERY_COMMAND_KINDS)
const WRITE_KINDS = new Set<string>(WRITE_COMMAND_KINDS)

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
  queries: HubQueryPort
  useCases: SharedUseCasePorts
  legacyAttach: LegacyAttachPort
  legacyDetach: LegacyDetachPort
  sessions: SessionPort
  ledger: RequestLedgerPort
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

function errorOf(error: unknown): HubError {
  if (error instanceof ApplicationFault) {
    return { code: error.code, message: error.message, retryable: error.retryable }
  }
  return portFaultError(error) || {
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

function isRecord(value: unknown): value is RuntimeRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(message: string): never {
  throw new ApplicationFault('INVALID_ARGUMENT', message)
}

function assertAllowedFields(command: RuntimeRecord, payloadFields: readonly string[]) {
  const allowed = new Set(['kind', 'meta', ...payloadFields])
  const unexpected = Object.keys(command).find((key) => !allowed.has(key))
  if (unexpected) invalid(`${String(command.kind)} contains unsupported field: ${unexpected}`)
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
  if (unexpected) invalid(`runner contains unsupported field: ${unexpected}`)
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
    || session.status === 'completed'
    || session.status === 'failed'
    || session.status === 'cancelled') {
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

async function executeHandler(
  runtime: ApplicationRuntimePort,
  queries: HubQueryPort,
  useCases: SharedUseCasePorts,
  legacyAttach: LegacyAttachPort,
  legacyDetach: LegacyDetachPort,
  sessions: SessionPort,
  ledger: RequestLedgerPort,
  businessEvents: AuditEvent[],
  command: HubCommand
): Promise<unknown> {
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
      const ingested = await executeIngestUseCase(runtime, useCases, command)
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
      const decided = await executeDecisionUseCase(runtime, useCases, command)
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
      const state = await useCases.state.readState()
      const inboxIds = command.inboxId
        ? [command.inboxId]
        : state.items.filter((item) => item.status === 'queued' || item.status === 'proposed').map((item) => item.id)
      if (command.inboxId && !state.items.some((item) => item.id === command.inboxId)) {
        throw new ApplicationFault('NOT_FOUND', 'inbox item not found')
      }
      const session = await startSession(sessions, 'analyze', command, inboxIds)
      businessEvents.push(...await applyAnalyzeCompletion(runtime, useCases, command, session))
      return { action: 'analyze', session: commandSessionOutcome(session), applied: null }
    }
    case 'resumeSession': {
      if (!command.message?.trim()) throw new ApplicationFault('INVALID_ARGUMENT', 'message is required')
      if (!await sessions.get(command.sessionId)) throw new ApplicationFault('NOT_FOUND', 'session not found')
      const session = await sessions.resume({ sessionId: command.sessionId, message: command.message, options: command.runner })
      businessEvents.push(...await applyAnalyzeCompletion(runtime, useCases, command, session))
      return { action: 'resumeSession', session: commandSessionOutcome(session), applied: null }
    }
    case 'reapSessions': {
      const reaped = await sessions.reap(command.sessionIds)
      for (const session of reaped) {
        businessEvents.push(...await applyAnalyzeCompletion(runtime, useCases, command, session))
      }
      return { action: 'reapSessions', sessions: reaped.map(commandSessionOutcome) }
    }
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

export function createHubApplication(options: HubApplicationOptions): HubApplication {
  const { runtime, queries, useCases, legacyAttach, legacyDetach, sessions, ledger, trace } = options
  let writeTail: Promise<void> = Promise.resolve()
  let traceSequence = 0

  const runValidated = async (command: HubCommand): Promise<HubCommandResult> => {
    if (!WRITE_KINDS.has(command.kind)) {
      try {
        return resultEnvelope(command, await executeHandler(runtime, queries, useCases, legacyAttach, legacyDetach, sessions, ledger, [], command))
      } catch (error) {
        return failureEnvelope(command, errorOf(error))
      }
    }

    const digest = commandDigest(runtime, command)
    let existing: RequestLedgerEntry | null
    try {
      existing = await ledger.read(command.meta.requestId)
    } catch (error) {
      return failureEnvelope(command, { code: 'PORT_FAILURE', message: errorOf(error).message, retryable: true })
    }
    if (existing) {
      if (existing.digest !== digest || existing.commandKind !== command.kind) {
        return failureEnvelope(command, {
          code: 'REQUEST_ID_CONFLICT',
          message: 'requestId is already bound to a different command',
          retryable: false
        })
      }
      if (existing.status !== 'completed' || !existing.result) {
        return failureEnvelope(command, {
          code: 'REQUEST_IN_PROGRESS',
          message: 'request has started but no terminal result is available',
          retryable: true
        })
      }
      return replayResult(existing)
    }

    const started: RequestLedgerEntry = {
      requestId: command.meta.requestId,
      digest,
      commandKind: command.kind,
      status: 'started',
      startedAt: runtime.nowIso()
    }
    try {
      await ledger.begin(started)
    } catch (error) {
      return failureEnvelope(command, { code: 'PORT_FAILURE', message: errorOf(error).message, retryable: true })
    }

    let data: unknown
    let handlerError: HubError | undefined
    const businessEvents: AuditEvent[] = []
    try {
      data = await executeHandler(runtime, queries, useCases, legacyAttach, legacyDetach, sessions, ledger, businessEvents, command)
    } catch (caught) {
      handlerError = safeHandlerError(command, errorOf(caught))
    }

    let event: AuditEvent
    try {
      event = terminalEvent(runtime, command, handlerError)
    } catch (eventError) {
      return portFailureEnvelope(command, eventError, 'request outcome audit could not be created')
    }
    const events = [...businessEvents, event]
    const result = handlerError
      ? failureEnvelope(command, handlerError, events)
      : resultEnvelope(command, data, events)

    try {
      await ledger.complete(
        { ...started, status: 'completed', completedAt: event.at, result },
        events.length === 1 ? event : events
      )
    } catch (persistError) {
      return failureEnvelope(command, {
        code: 'PORT_FAILURE',
        message: `request outcome could not be persisted: ${errorOf(persistError).message}`,
        retryable: true
      })
    }
    return result
  }

  const executeValidated = async (command: HubCommand): Promise<HubCommandResult> => {
    try {
      return await runValidated(command)
    } catch (error) {
      return portFailureEnvelope(command, error)
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
