import type { AttachCompletionProof } from '../../contracts/state.js'

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
  attachCompletion?: AttachCompletionProof
}
