import type {
  AuditEvent,
  HistoryRecordView,
  ApprovedLegacyAttachPlan,
  ApprovedLegacyDetachPlan,
  HubStateV2,
  HubCommandKind,
  HubCommandResult,
  LegacyAttachApplyReport,
  LegacyAttachInspection,
  LegacyDetachApplyReport,
  LegacyDetachInspection,
  LegacyAttachWorktreeInspection,
  LibrarySnapshotSourceV1,
  LibrarySnapshotManifestV1,
  RuntimeAssetManifestV1,
  Sha256Identifier,
  SessionKind,
  SessionRequestOptions,
  SessionTarget,
  SessionView
} from '../contracts/index.js'
import type {
  LegacyWorktreeMigrationFact
} from '../core/migration.js'
import type { LibrarySnapshotFileFact } from '../core/snapshot.js'
import type { AttachCompletionProof } from '../contracts/state.js'
import type {
  HubStatusFacts,
  SkillHostFact,
  WorktreeDiscoveryFacts
} from '../core/query-projections.js'

export type MaybePromise<T> = T | Promise<T>

/**
 * Host-provided deterministic runtime primitives. Keeping these capabilities
 * explicit prevents the shared Application from receiving a filesystem-sized
 * context object.
 */
export interface ApplicationRuntimePort {
  nowIso(): string
  nextId(scope: string): string
  sha256(value: string): string
}

/**
 * Host recovery preflight. Application invokes this after command validation
 * and before any query/write handler so late durable journals are never
 * bypassed and adapter failures use the normal result envelope.
 */
export interface ApplicationRecoveryPort {
  recover(): MaybePromise<void>
}

type InvocationTraceBase = {
  sequence: number
  transport: string
  commandKind: HubCommandKind
  requestHash: string
  handlerIdentity: 'application.commandBus'
}

export type InvocationTraceEvent =
  | InvocationTraceBase & {
    phase: 'entry'
  }
  | InvocationTraceBase & {
    phase: 'result'
    ok: boolean
    replayed: boolean
  }

/**
 * Optional diagnostic boundary. The Application supplies only an opaque hash
 * and allowlisted command metadata; raw request or result payloads never cross
 * this port.
 */
export interface InvocationTracePort {
  hashRequestId(requestId: string): MaybePromise<string>
  append(event: InvocationTraceEvent): MaybePromise<void>
}

export type SkillReadPortResult =
  | { status: 'found'; content: string }
  | { status: 'invalid-path'; reason: 'escaped' | 'escaped-link' }
  | { status: 'not-found'; reason: 'missing' | 'skill-md-missing' }

export type WorktreeInspection = LegacyAttachWorktreeInspection

/**
 * Host observation boundary. Adapters report flat facts and safe file reads;
 * shared Core/Application own grouping, counts, recognition, dedupe, and sort.
 */
export interface HubQueryPort {
  readStatusFacts(): MaybePromise<HubStatusFacts>
  listSkillFacts(): MaybePromise<readonly SkillHostFact[]>
  readWorktreeFacts(): MaybePromise<WorktreeDiscoveryFacts>
  readSkill(path: string): MaybePromise<SkillReadPortResult>
  listHistory(limit: number): MaybePromise<readonly HistoryRecordView[]>
  inspectWorktree(worktree: string): MaybePromise<WorktreeInspection>
}

export type WorktreeIdentity = {
  pathKey: Sha256Identifier
  worktreeId: string
}

/** Host canonicalization boundary; raw locators never become persistent keys. */
export interface WorktreeIdentityPort {
  resolve(worktree: string): MaybePromise<WorktreeIdentity>
}

/** Host observation only. Application/Core exclusively construct the manifest. */
export type LibrarySnapshotObservation = {
  captureId: string
  source: LibrarySnapshotSourceV1
  files: readonly LibrarySnapshotFileFact[]
}

/** Validated immutable snapshot storage; it cannot choose canonical identity. */
export interface LibrarySnapshotRepositoryPort {
  observe(): MaybePromise<LibrarySnapshotObservation>
  store(captureId: string, approved: LibrarySnapshotManifestV1): MaybePromise<{
    manifest: LibrarySnapshotManifestV1
    deduplicated: boolean
  }>
  list(): MaybePromise<readonly LibrarySnapshotManifestV1[]>
  read(snapshotId: Sha256Identifier): MaybePromise<LibrarySnapshotManifestV1 | null>
}

/**
 * Narrow immutable-content boundary used by the Local materializer. Callers
 * must name a file from an already validated manifest; adapters may not expose
 * arbitrary CAS object reads or host paths through this port.
 */
export interface SnapshotContentPort {
  readVerifiedFile(input: {
    snapshotId: Sha256Identifier
    path: string
    expectedSize: number
    expectedSha256: Sha256Identifier
  }): MaybePromise<Uint8Array | null>
}

/**
 * Read-only installed runtime assets. The Local adapter owns safe observation;
 * Core owns the content-addressed manifest and callers can read only an exact
 * file already named by that manifest.
 */
export interface RuntimeAssetRepositoryPort {
  observe(): MaybePromise<RuntimeAssetManifestV1>
  readVerifiedFile(input: {
    runtimeAssetId: Sha256Identifier
    path: string
    expectedSize: number
    expectedSha256: Sha256Identifier
    expectedMode: '100644' | '100755'
  }): MaybePromise<Uint8Array | null>
}

/** Raw state/facts only. Application validates and projects schema status. */
export interface HubStateV2RepositoryPort {
  readDocument(): MaybePromise<unknown | null>
  writeV2(state: HubStateV2): MaybePromise<void>
  runtimeRevision(): MaybePromise<string>
  observeV1Worktrees(): MaybePromise<readonly LegacyWorktreeMigrationFact[]>
}

export type P2ApplicationPorts = {
  identities: WorktreeIdentityPort
  snapshots: LibrarySnapshotRepositoryPort
  state: HubStateV2RepositoryPort
}

/**
 * Host effect boundary for the legacy live-link attach path. The adapter only
 * observes host facts and applies a Core-approved, path-bounded plan.
 */
export interface LegacyAttachPort {
  inspect(worktree: string): MaybePromise<LegacyAttachInspection>
  apply(plan: ApprovedLegacyAttachPlan): MaybePromise<LegacyAttachApplyReport>
}

/**
 * Host effect boundary for restoring an attached legacy worktree. The adapter
 * rechecks host facts and applies only a Core-approved transactional plan.
 */
export interface LegacyDetachPort {
  inspect(worktree: string): MaybePromise<LegacyDetachInspection>
  apply(plan: ApprovedLegacyDetachPlan): MaybePromise<LegacyDetachApplyReport>
}

export type SessionStartRequest = {
  kind: SessionKind
  /** Host locator used only to launch the session; it must not be exposed as target.id. */
  locator?: {
    kind: 'worktree' | 'skill'
    value: string
  }
  target?: SessionTarget
  intent?: string
  inboxIds?: readonly string[]
  options?: SessionRequestOptions
}

export type SessionResumeRequest = {
  sessionId: string
  message: string
  options?: SessionRequestOptions
}

export type AttachCompletionRequest = {
  sessionId: string
  proof: AttachCompletionProof
}

export type AttachCompletionOutcome =
  | { status: 'completed' | 'already-completed'; session: SessionView }
  | {
      status: 'not-authorized'
      reason: 'not-found' | 'not-attach' | 'target-mismatch' | 'not-waiting' | 'exit-not-zero'
    }
  | { status: 'proof-conflict' }

/**
 * Host-owned session boundary. The shared Application never sees a process id,
 * a runner-specific continuation id format, or a runner-owned file path.
 */
export interface SessionPort {
  list(): MaybePromise<readonly SessionView[]>
  get(sessionId: string): MaybePromise<SessionView | null>
  start(input: SessionStartRequest): MaybePromise<SessionView>
  resume(input: SessionResumeRequest): MaybePromise<SessionView>
  reap(sessionIds?: readonly string[]): MaybePromise<readonly SessionView[]>
  /**
   * Conditionally persists an attach completion in the active Hub write transaction.
   * `completedAt` is metadata; idempotence compares the three identity fields and
   * retains the first timestamp. No raw locator may enter the proof or outcome.
   */
  completeAttach(input: AttachCompletionRequest): MaybePromise<AttachCompletionOutcome>
}

export type RequestLedgerEntry = {
  requestId: string
  digest: string
  commandKind: HubCommandKind
  status: 'started' | 'completed'
  startedAt: string
  completedAt?: string
  result?: HubCommandResult
}

/**
 * A host persists this ledger outside the shared layer. P1 intentionally
 * guarantees sequential cross-process replay and single-process concurrency;
 * cross-process locking and crash transactions are introduced in P2.
 */
export interface RequestLedgerPort {
  read(requestId: string): MaybePromise<RequestLedgerEntry | null>
  begin(entry: RequestLedgerEntry): MaybePromise<void>
  complete(entry: RequestLedgerEntry, events: AuditEvent | readonly AuditEvent[]): MaybePromise<void>
  listEvents(limit: number): MaybePromise<readonly AuditEvent[]>
}
