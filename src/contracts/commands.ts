import type { CommandMeta, JsonObject } from './common.js'
import type { LegacyAttachSourcePolicy, LegacyVisibilityMode } from './legacy-attach.js'
import type { InboxDecisionAction, SessionStatus } from './state.js'

export const QUERY_COMMAND_KINDS = [
  'status',
  'listSkills',
  'listWorktrees',
  'readSkill',
  'listHistory',
  'listSessions',
  'getSession'
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
  'reapSessions'
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

export type QueryCommand =
  | StatusCommand
  | ListSkillsCommand
  | ListWorktreesCommand
  | ReadSkillCommand
  | ListHistoryCommand
  | ListSessionsCommand
  | GetSessionCommand

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

export type HubCommand = QueryCommand | WriteCommand
