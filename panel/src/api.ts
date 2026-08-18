export type SkillNode = {
  name: string
  kind: 'resident' | 'adopted' | 'inbox'
  path: string
  hasSkillMd: boolean
  attached: boolean
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
  suggestion?: {
    action?: string
    target?: string
    reason?: string
    confidence?: string
  }
}

export type HubState = {
  hubRoot: string
  gameRepo: string | null
  lastIngest: Record<string, string> | null
  resident: SkillNode[]
  adopted: SkillNode[]
  inbox: SkillNode[]
  items: InboxItem[]
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

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init
  })
  const text = await response.text()
  const data = text ? JSON.parse(text) : {}
  if (!response.ok) {
    throw new Error(data.error || response.statusText)
  }
  return data as T
}

export const api = {
  state: () => request<HubState>('/api/state'),
  skill: (path: string) => request<{ path: string; content: string }>(`/api/skill?path=${encodeURIComponent(path)}`),
  history: () => request<{ records: Array<Record<string, unknown>> }>('/api/history'),
  decide: (body: { id: string; action: 'adopt' | 'merge' | 'reject'; note?: string; mergeTarget?: string }) =>
    request('/api/decide', { method: 'POST', body: JSON.stringify(body) }),
  analyze: () => request('/api/analyze', { method: 'POST', body: '{}' }),
  startCodex: (body: { path?: string; intent?: string; kind?: string; worktree?: string }) =>
    request('/api/codex/start', { method: 'POST', body: JSON.stringify(body) }),
  resumeCodex: (body: { id: string; message: string }) =>
    request('/api/codex/resume', { method: 'POST', body: JSON.stringify(body) }),
  sessions: () => request<{ sessions: Array<Record<string, unknown>> }>('/api/codex/sessions'),
  worktrees: () => request<{ worktrees: WorktreeInfo[]; scanRoots: string[] }>('/api/worktrees'),
  attachWorktree: (path: string) =>
    request('/api/worktree/attach', { method: 'POST', body: JSON.stringify({ path }) }),
  detachWorktree: (path: string) =>
    request('/api/worktree/detach', { method: 'POST', body: JSON.stringify({ path }) })
}
