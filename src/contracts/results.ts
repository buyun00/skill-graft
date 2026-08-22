import type { JsonObject } from './common.js'
import type { HubCommand, HubCommandKind } from './commands.js'
import type { HubError } from './errors.js'
import type { AuditEvent } from './events.js'
import type {
  LegacyAttachApplyEffect,
  LegacyAttachSourcePolicy,
  LegacyVisibilityMode
} from './legacy-attach.js'
import type { LegacyDetachApplyEffect } from './legacy-detach.js'
import type { HubStateV2 } from './hub-state-v2.js'
import type { MigrationPlanV1 } from './migration.js'
import type { LibrarySnapshotManifestV1, Sha256Identifier } from './snapshot.js'
import type {
  HistoryRecordView,
  HubStatusView,
  InboxItemView,
  SessionView,
  SkillContentView,
  SkillInventoryView,
  WorktreeListView
} from './state.js'
import type { ContractVersion } from './version.js'
import type { WorktreePinV1 } from './worktree-pin.js'

export type RepairLegacyResult = {
  action: 'repairLegacy'
  worktree: string
  attached: boolean
  blocked: boolean
  repaired: boolean
  reason?: string
  artifacts: readonly {
    label: string
    status: string
  }[]
}

export type ApplyLegacyAttachResult = {
  action: 'applyLegacyAttach'
  mode: 'legacyLinks'
  worktree: string
  changed: boolean
  claim: 'created' | 'alreadyClaimed'
  sourcePolicy: LegacyAttachSourcePolicy
  plan: {
    artifacts: readonly {
      id: string
      label: string
      action: 'keep' | 'link' | 'replaceWithLibrary' | 'promoteToLibraryThenLink' | 'backupThenLink'
    }[]
    visibility: LegacyVisibilityMode
    configureGit: boolean
    recordClaim: boolean
  }
  effects: readonly LegacyAttachApplyEffect[]
  visibility: {
    trackedChanged: number
    removed: number
  }
  gitConfigured: boolean
}

export type ApplyLegacyDetachResult = {
  action: 'applyLegacyDetach'
  mode: 'legacyLinks'
  worktree: string
  changed: boolean
  detached: true
  reason?: 'notAttached'
  plan: {
    artifacts: readonly {
      id: string
      label: string
      action: 'unlink' | 'keepMissing'
    }[]
    restorePaths: readonly string[]
    removeClaim: boolean
  }
  effects: readonly LegacyDetachApplyEffect[]
  restoredTracked: number
  claim: 'removed' | 'alreadyDetached'
}

export type IngestResult = {
  action: 'ingest'
  gameRepo?: string
  created: number
  items: readonly InboxItemView[]
  dryRun: boolean
  dispatched: boolean
  session?: SessionView
}

export type DecideResult = {
  action: 'adopt' | 'merge' | 'reject'
  item: InboxItemView
  worktrees: {
    applied: readonly {
      worktree: string
      status: string
    }[]
    skipped: readonly {
      worktree: string
      reason: string
    }[]
  }
}

export type SessionCommandResult<K extends 'attach' | 'detach' | 'edit' | 'chat' | 'analyze' | 'resumeSession'> = {
  action: K
  session: SessionView
  applied: null
}

export type ReapSessionsResult = {
  action: 'reapSessions'
  sessions: readonly SessionView[]
}

export type HubSchemaStatus = 'empty' | 'legacy' | 'current' | 'unsupported'

export type InspectSchemaResult = {
  action: 'inspectSchema'
  status: HubSchemaStatus
  detectedSchemaVersion: number | null
  currentSchemaVersion: 2
  stateRevision: number | null
  runtimeRevision: string
  writable: boolean
  migrationRequired: boolean
}

export type ListSnapshotsResult = {
  snapshots: readonly LibrarySnapshotManifestV1[]
}

export type GetSnapshotResult = {
  snapshot: LibrarySnapshotManifestV1
}

export type GetPinResult = {
  worktree: string
  pathKey: Sha256Identifier
  worktreeId: string
  pin: WorktreePinV1 | null
}

export type CreateSnapshotResult = {
  action: 'createSnapshot'
  snapshot: LibrarySnapshotManifestV1
  deduplicated: boolean
}

export type SetPinResult = {
  action: 'setPin'
  pathKey: Sha256Identifier
  worktreeId: string
  pin: WorktreePinV1
  changed: boolean
}

export type MigrateStateResult = {
  action: 'migrateState'
  mode: 'dryRun' | 'commit'
  status: 'planned' | 'committed' | 'already-current'
  plan: MigrationPlanV1 | null
  state: HubStateV2 | null
}

export type CommandDataByKind = {
  status: HubStatusView
  listSkills: SkillInventoryView
  listWorktrees: WorktreeListView
  readSkill: SkillContentView
  listHistory: { records: readonly HistoryRecordView[]; cursor?: string }
  listSessions: { sessions: readonly SessionView[] }
  getSession: { session: SessionView }
  inspectSchema: InspectSchemaResult
  listSnapshots: ListSnapshotsResult
  getSnapshot: GetSnapshotResult
  getPin: GetPinResult
  repairLegacy: RepairLegacyResult
  applyLegacyAttach: ApplyLegacyAttachResult
  applyLegacyDetach: ApplyLegacyDetachResult
  ingest: IngestResult
  decide: DecideResult
  attach: SessionCommandResult<'attach'>
  detach: SessionCommandResult<'detach'>
  edit: SessionCommandResult<'edit'>
  chat: SessionCommandResult<'chat'>
  analyze: SessionCommandResult<'analyze'>
  resumeSession: SessionCommandResult<'resumeSession'>
  reapSessions: ReapSessionsResult
  createSnapshot: CreateSnapshotResult
  setPin: SetPinResult
  migrateState: MigrateStateResult
}

export const UNKNOWN_COMMAND_KIND = 'unknown' as const
export type UnknownCommandKind = typeof UNKNOWN_COMMAND_KIND

export interface EnvelopeBase<K extends HubCommandKind | UnknownCommandKind> {
  contractVersion: ContractVersion
  requestId: string
  commandKind: K
  events: readonly AuditEvent[]
  meta: {
    replayed: boolean
    handler: 'application.commandBus'
  }
}

export interface SuccessEnvelope<K extends HubCommandKind, D> extends EnvelopeBase<K> {
  ok: true
  data: D
}

export interface FailureEnvelope<K extends HubCommandKind | UnknownCommandKind> extends EnvelopeBase<K> {
  ok: false
  error: HubError
  context?: JsonObject
}

export type ResultEnvelope<K extends HubCommandKind, D> = SuccessEnvelope<K, D> | FailureEnvelope<K | UnknownCommandKind>

export type HubCommandResult<C extends HubCommand = HubCommand> = C extends HubCommand
  ? ResultEnvelope<C['kind'], CommandDataByKind[C['kind']]>
  : never
