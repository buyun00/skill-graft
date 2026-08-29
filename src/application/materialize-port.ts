import type {
  GitMaterializationConfigurationFact,
  GitVisibilityFact,
  MaterializationObservedArtifactFact
} from '../core/materialization.js'
import type {
  LegacyArtifactFactV1,
  LegacyMigrationPlanV1,
  LegacyMigrationRecordV1,
  LegacyRestoreSourceFactV1,
  LegacyRollbackPlanV1,
  LibrarySnapshotManifestV1,
  MaterializationCommitRecordV1,
  MaterializationMarkerV1,
  MaterializePlanV1,
  RuntimeAssetManifestV1,
  Sha256Identifier,
  VisibilityOwnershipStateV1,
  WorktreePinV1
} from '../contracts/index.js'
import type { MaybePromise, RuntimeAssetRepositoryPort, WorktreeIdentity } from './ports.js'
import type {
  ApplicationTransactionParticipant,
  ApplicationTransactionParticipantContext
} from './transaction-port.js'

export type MaterializeInspection = {
  /** Raw external marker input is intentionally validated by shared Core. */
  observedMarker: unknown | null
  /** Verified adapter-private ownership state bound to the observed marker. */
  currentVisibilityState: VisibilityOwnershipStateV1 | null
  /** Proposed ownership state for the exact requested artifact closure. */
  desiredVisibilityState: VisibilityOwnershipStateV1
  observations: readonly MaterializationObservedArtifactFact[]
  gitFacts: readonly GitVisibilityFact[]
  gitConfiguration: GitMaterializationConfigurationFact
}

export type LegacyMigrationInspection = {
  /** Raw Git-admin proof; shared Core reconciles it with the durable mirror. */
  observedMarker: unknown | null
  currentVisibilityState: VisibilityOwnershipStateV1 | null
  desiredVisibilityState: VisibilityOwnershipStateV1
  /** Locator-free digest of the complete adapter-private rollback backup facts. */
  backupPrivateStateId: Sha256Identifier
  artifacts: readonly LegacyArtifactFactV1[]
  gitFacts: readonly GitVisibilityFact[]
  gitConfiguration: GitMaterializationConfigurationFact
}

export type LegacyRollbackInspection = LegacyMigrationInspection & {
  /** Exact adapter-private restore-source availability bound into the rollback plan. */
  restoreSources: readonly LegacyRestoreSourceFactV1[]
  /** Original locator-free Git flags proven by the adapter-private backup. */
  restoreGitFacts: readonly GitVisibilityFact[]
  /** Exact locator-free pre-migration configuration proof from the private backup. */
  restoreGitConfiguration: GitMaterializationConfigurationFact
}

export type MaterializePreparedReport = {
  preparedOperations: number
  preparedBytes: number
}

export type MaterializationRecoveryReport = {
  status: 'clean' | 'rolled-back' | 'finalized'
  recoveredTransactions: number
}

/**
 * External worktree effects are prepared behind a transaction participant.
 * The Application supplies only a Core-approved plan; the adapter must
 * re-inspect the worktree identity and plan inputs before staging anything.
 * A common-info legacy effect additionally requires an exact re-inspection of
 * `plan.git.configuration.siblingFactsDigest`; it never authorizes writing a
 * sibling worktree or relying on an unlocked, adapter-private safety decision.
 */
export interface MaterializePort {
  inspect(input: {
    worktree: string
    identity: WorktreeIdentity
    /** Source inventories only define the exact observation target set. */
    snapshot: LibrarySnapshotManifestV1
    runtimeAsset: RuntimeAssetManifestV1
    selectedSkills: readonly string[]
  }): MaybePromise<MaterializeInspection>

  inspectLegacy(input: {
    worktree: string
    identity: WorktreeIdentity
    snapshot: LibrarySnapshotManifestV1
    runtimeAsset: RuntimeAssetManifestV1
    selectedSkills: readonly string[]
    /** Exact committed record when re-inspecting an already-migrated marker; null for prospective migration. */
    migration: LegacyMigrationRecordV1 | null
  }): MaybePromise<LegacyMigrationInspection>

  inspectLegacyRollback(input: {
    worktree: string
    identity: WorktreeIdentity
    snapshot: LibrarySnapshotManifestV1
    runtimeAsset: RuntimeAssetManifestV1
    selectedSkills: readonly string[]
    migration: LegacyMigrationRecordV1
  }): MaybePromise<LegacyRollbackInspection>

  prepare(input: {
    worktree: string
    identity: WorktreeIdentity
    /** Active transaction lease guard; required before and after every prepare mutation. */
    guard: ApplicationTransactionParticipantContext
    plan: MaterializePlanV1
    /** Shared-verified source inventories; bytes still come from verified content ports. */
    snapshot: LibrarySnapshotManifestV1
    runtimeAsset: RuntimeAssetManifestV1
  }): MaybePromise<{
    marker: MaterializationMarkerV1
    report: MaterializePreparedReport
    participant: ApplicationTransactionParticipant
  }>

  recover(input: {
    worktree: string
    identity: WorktreeIdentity
    durable: MaterializationCommitRecordV1 | null
    /** Explicit active-transaction lease guard; adapters must never infer lease ownership. */
    guard: ApplicationTransactionParticipantContext
    /** Verified HubState truth from the same WAL generation as stateRevision. */
    pin: WorktreePinV1 | null
    stateRevision: number | null
  }): MaybePromise<MaterializationRecoveryReport>

  prepareLegacyMigration(input: {
    worktree: string
    identity: WorktreeIdentity
    guard: ApplicationTransactionParticipantContext
    plan: LegacyMigrationPlanV1
    snapshot: LibrarySnapshotManifestV1
    runtimeAsset: RuntimeAssetManifestV1
  }): MaybePromise<{
    marker: MaterializationMarkerV1
    record: LegacyMigrationRecordV1
    report: MaterializePreparedReport
    participant: ApplicationTransactionParticipant
  }>

  prepareLegacyRollback(input: {
    worktree: string
    identity: WorktreeIdentity
    guard: ApplicationTransactionParticipantContext
    plan: LegacyRollbackPlanV1
    migration: LegacyMigrationRecordV1
    snapshot: LibrarySnapshotManifestV1
    runtimeAsset: RuntimeAssetManifestV1
  }): MaybePromise<{
    record: LegacyMigrationRecordV1
    report: MaterializePreparedReport
    participant: ApplicationTransactionParticipant
  }>
}

/** Locator-free durable truth staged in the same Hub WAL as state/ledger/audit. */
export interface MaterializationRecordPort {
  readCurrent(pathKey: Sha256Identifier): MaybePromise<MaterializationCommitRecordV1 | null>
  writeCurrent(record: MaterializationCommitRecordV1): MaybePromise<void>
  readLegacyMigration(migrationId: Sha256Identifier): MaybePromise<LegacyMigrationRecordV1 | null>
  writeLegacyMigration(record: LegacyMigrationRecordV1): MaybePromise<void>
}

export type P3ApplicationPorts = {
  runtimeAssets: RuntimeAssetRepositoryPort
  materialize: MaterializePort
  records: MaterializationRecordPort
}
