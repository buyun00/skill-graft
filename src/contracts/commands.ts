import type { CommandMeta, JsonObject } from './common.js'
import type { LegacyAttachSourcePolicy, LegacyVisibilityMode } from './legacy-attach.js'
import type { Sha256Identifier } from './snapshot.js'
import type { InboxDecisionAction, SessionStatus } from './state.js'

export const QUERY_COMMAND_KINDS = [
  'status',
  'listSkills',
  'listWorktrees',
  'readSkill',
  'listHistory',
  'listSessions',
  'getSession',
  'inspectSchema',
  'listSnapshots',
  'getSnapshot',
  'getPin',
  'planSync'
] as const

export const WRITE_COMMAND_KINDS = [
  'repairLegacy',
  'applyLegacyAttach',
  'applyLegacyDetach',
  'ingest',
  'decide',
  'attach',
  'detach',
  'edit',
  'chat',
  'analyze',
  'resumeSession',
  'reapSessions',
  'createSnapshot',
  'setPin',
  'migrateState',
  'claimWorktree',
  'sync',
  'migrateLegacy',
  'rollbackLegacyMigration'
] as const

export type QueryCommandKind = (typeof QUERY_COMMAND_KINDS)[number]
export type WriteCommandKind = (typeof WRITE_COMMAND_KINDS)[number]
export type HubCommandKind = QueryCommandKind | WriteCommandKind

export interface BaseCommand<K extends HubCommandKind> {
  kind: K
  meta: CommandMeta
}

export interface StatusCommand extends BaseCommand<'status'> {}

export interface ListSkillsCommand extends BaseCommand<'listSkills'> {}

export interface ListWorktreesCommand extends BaseCommand<'listWorktrees'> {}

export interface ReadSkillCommand extends BaseCommand<'readSkill'> {
  path: string
}

export interface ListHistoryCommand extends BaseCommand<'listHistory'> {
  cursor?: string
  limit?: number
}

export interface ListSessionsCommand extends BaseCommand<'listSessions'> {
  statuses?: readonly SessionStatus[]
}

export interface GetSessionCommand extends BaseCommand<'getSession'> {
  sessionId: string
}

export interface InspectSchemaCommand extends BaseCommand<'inspectSchema'> {}

export interface ListSnapshotsCommand extends BaseCommand<'listSnapshots'> {}

export interface GetSnapshotCommand extends BaseCommand<'getSnapshot'> {
  snapshotId: Sha256Identifier
}

export interface GetPinCommand extends BaseCommand<'getPin'> {
  worktree: string
}

export interface PlanSyncCommand extends BaseCommand<'planSync'> {
  worktree: string
}

export interface RepairLegacyCommand extends BaseCommand<'repairLegacy'> {
  worktree: string
}

export interface ApplyLegacyAttachCommand extends BaseCommand<'applyLegacyAttach'> {
  worktree: string
  sessionId?: string
  sourcePolicy?: LegacyAttachSourcePolicy
  visibility?: LegacyVisibilityMode
  configureGit?: boolean
}

export interface ApplyLegacyDetachCommand extends BaseCommand<'applyLegacyDetach'> {
  worktree: string
  sessionId?: string
}

export interface IngestCommand extends BaseCommand<'ingest'> {
  gameRepo?: string | null
  payload: string
  dispatch?: boolean
  dryRun?: boolean
}

export interface DecideCommand extends BaseCommand<'decide'> {
  id: string
  action: InboxDecisionAction
  note?: string
  mergeTarget?: string
}

export type SessionRequestOptions = {
  profile?: string
  quality?: string
  start?: boolean
  wait?: boolean
  metadata?: JsonObject
}

export interface AttachCommand extends BaseCommand<'attach'> {
  worktree: string
  intent?: string
  runner?: SessionRequestOptions
}

export interface DetachCommand extends BaseCommand<'detach'> {
  worktree: string
  intent?: string
  runner?: SessionRequestOptions
}

export interface EditCommand extends BaseCommand<'edit'> {
  path: string
  intent?: string
  runner?: SessionRequestOptions
}

export interface ChatCommand extends BaseCommand<'chat'> {
  intent?: string
  worktree?: string
  runner?: SessionRequestOptions
}

export interface AnalyzeCommand extends BaseCommand<'analyze'> {
  inboxId?: string
  intent?: string
  runner?: SessionRequestOptions
}

export interface ResumeSessionCommand extends BaseCommand<'resumeSession'> {
  sessionId: string
  message: string
  runner?: SessionRequestOptions
}

export interface ReapSessionsCommand extends BaseCommand<'reapSessions'> {
  sessionIds?: readonly string[]
}

export interface CreateSnapshotCommand extends BaseCommand<'createSnapshot'> {}

export interface SetPinCommand extends BaseCommand<'setPin'> {
  worktree: string
  snapshotId: Sha256Identifier
  selectedSkills?: readonly string[]
}

export interface MigrateStateCommand extends BaseCommand<'migrateState'> {
  mode: 'dryRun' | 'commit'
  planHash?: Sha256Identifier
}

export interface ClaimWorktreeCommand extends BaseCommand<'claimWorktree'> {
  worktree: string
  snapshotId: Sha256Identifier
  selectedSkills: readonly string[]
  sessionId: string
}

export interface SyncCommand extends BaseCommand<'sync'> {
  worktree: string
  planHash: Sha256Identifier
  /** Optional only for P2 pin/ordinary upgrade compatibility. Official attach flows always provide it. */
  sessionId?: string
}

type PlanCommitMode =
  | { mode: 'dryRun'; planHash?: never }
  | { mode: 'commit'; planHash: Sha256Identifier }

export type MigrateLegacyCommand = BaseCommand<'migrateLegacy'> & {
  worktree: string
} & PlanCommitMode

export type RollbackLegacyMigrationCommand = BaseCommand<'rollbackLegacyMigration'> & {
  worktree: string
  migrationId: Sha256Identifier
} & PlanCommitMode

export type QueryCommand =
  | StatusCommand
  | ListSkillsCommand
  | ListWorktreesCommand
  | ReadSkillCommand
  | ListHistoryCommand
  | ListSessionsCommand
  | GetSessionCommand
  | InspectSchemaCommand
  | ListSnapshotsCommand
  | GetSnapshotCommand
  | GetPinCommand
  | PlanSyncCommand

export type WriteCommand =
  | RepairLegacyCommand
  | ApplyLegacyAttachCommand
  | ApplyLegacyDetachCommand
  | IngestCommand
  | DecideCommand
  | AttachCommand
  | DetachCommand
  | EditCommand
  | ChatCommand
  | AnalyzeCommand
  | ResumeSessionCommand
  | ReapSessionsCommand
  | CreateSnapshotCommand
  | SetPinCommand
  | MigrateStateCommand
  | ClaimWorktreeCommand
  | SyncCommand
  | MigrateLegacyCommand
  | RollbackLegacyMigrationCommand

export type HubCommand = QueryCommand | WriteCommand
