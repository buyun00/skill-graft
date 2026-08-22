import type { JsonObject } from './common.js'
import type { Sha256Identifier } from './snapshot.js'

export type SkillKind = 'resident' | 'adopted' | 'inbox'

export type SkillView = {
  name: string
  kind: SkillKind
  path: string
  hasSkillMd: boolean
  attached: boolean
}

export type SkillInventoryView = {
  resident: readonly SkillView[]
  adopted: readonly SkillView[]
  inbox: readonly SkillView[]
}

export type InboxStatus = 'queued' | 'proposed' | 'adopted' | 'merged-into-3skill' | 'rejected'

export type InboxDecisionAction = 'adopt' | 'merge' | 'reject'

export type InboxSuggestionView = {
  action?: string
  target?: string
  reason?: string
  confidence?: string
}

export type InboxItemView = {
  id: string
  name: string
  unit: string
  status: InboxStatus
  sourceRef?: string
  oldCommit?: string
  newCommit?: string
  inboxPath?: string
  adoptedPath?: string
  mergeTarget?: string
  note?: string
  createdAt?: string
  updatedAt?: string
  suggestion?: InboxSuggestionView
}

export type SessionKind = 'attach' | 'detach' | 'edit' | 'chat' | 'analyze'

export type SessionStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'

export type SessionTarget = {
  kind: 'hub' | 'worktree' | 'skill' | 'inbox'
  /** Host-neutral logical or opaque identifier; never a host filesystem path. */
  id: string
}

/** Locator-free durable proof that one attach session completed a materialization. */
export type AttachCompletionProof = {
  targetId: string
  pathKey: Sha256Identifier
  materializationId: Sha256Identifier
  completedAt: string
}

/**
 * Shared session projection. Runner process details and runner-owned storage are
 * deliberately excluded; hosts expose only opaque runner and continuation IDs.
 */
export type SessionView = {
  id: string
  kind: SessionKind
  status: SessionStatus
  target?: SessionTarget
  intent?: string
  runnerId?: string
  continuationToken?: string
  startedAt: string
  endedAt?: string
  exitCode?: number | null
  error?: string
  summary?: string
  lastMessage?: string
  canResume: boolean
  inboxIds?: readonly string[]
  attachCompletion?: AttachCompletionProof
}

export type WorktreeView = {
  name: string
  path: string
  branch: string
  head: string
  cloneRoot: string
  changedAt: string
  changedAtMs: number
  attached: boolean
  doNotAuto: boolean
  officialPresent: boolean
  overrideLinked: boolean
  ephemeral: boolean
  locked: boolean
  prunable: boolean
}

export type WorktreeListView = {
  worktrees: readonly WorktreeView[]
  scanRoots: readonly string[]
}

export type LastIngestView = {
  ref: string
  old: string
  new: string
  gameRepo: string
}

export type HubStatusView = SkillInventoryView & {
  hubRoot: string
  gameRepo: string | null
  lastIngest: LastIngestView | null
  items: readonly InboxItemView[]
  sessions: readonly SessionView[]
  counts: {
    resident: number
    adopted: number
    queued: number
    proposed: number
  }
}

export type SkillContentView = {
  path: string
  content: string
}

export type HistoryRecordView = {
  id: string
  type: string
  at?: string
  requestId?: string
  summary?: string
  metadata?: JsonObject
}
