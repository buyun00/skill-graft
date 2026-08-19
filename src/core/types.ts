export type SkillKind = 'resident' | 'adopted' | 'inbox'

export type SkillNode = {
  name: string
  kind: SkillKind
  path: string
  hasSkillMd: boolean
  attached: boolean
}

export type InboxSuggestion = {
  action?: string
  target?: string
  reason?: string
  confidence?: string
}

export type InboxItem = {
  id: string
  name: string
  unit: string
  status: string
  sourceRef?: string
  oldCommit?: string
  newCommit?: string
  inboxPath?: string
  adoptedPath?: string
  mergeTarget?: string
  note?: string
  createdAt?: string
  updatedAt?: string
  suggestion?: InboxSuggestion
}

export type HubStateFile = {
  version?: number
  items?: InboxItem[]
  lastIngest?: Record<string, string> | null
}

export type HubState = {
  hubRoot: string
  gameRepo: string | null
  lastIngest: Record<string, string> | null
  resident: SkillNode[]
  adopted: SkillNode[]
  inbox: SkillNode[]
  items: InboxItem[]
  sessions: HubSession[]
  counts: {
    resident: number
    adopted: number
    queued: number
    proposed: number
  }
}

export type WorktreeInfo = {
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

export type GitWorktreeRef = {
  path: string
  branch: string
  head: string
  locked: boolean
  prunable: boolean
}

export type WorktreeList = {
  worktrees: WorktreeInfo[]
  scanRoots: string[]
}

export type HubSession = {
  id: string
  kind: string
  path: string
  worktree: string
  intent: string
  pid: number
  promptFile: string
  logFile: string
  lastFile: string
  startedAt: string
  status: string
  exitCode: number | null
  error: string
  codexSessionId: string
  model?: string
  effort?: string
  summary?: string
  lastMessage?: string
  endedAt?: string
  canResume?: boolean
  inboxIds?: string[]
}

export type IngestTransaction = {
  old: string
  next: string
  ref: string
}
