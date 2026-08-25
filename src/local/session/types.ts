import type {
  AttachCompletionProof,
  SessionEventView,
  SessionRunnerErrorCode,
  SessionRunnerState,
  SessionStepView,
  SessionTarget,
  SessionTask
} from '../../contracts/index.js'

export type LocalRunnerArtifacts = {
  attemptRoot: string
  requestPath: string
  promptPath: string
  stdoutPath: string
  stderrPath: string
  eventsPath: string
  lastMessagePath: string
  cancelPath: string
  statusPath: string
  receiptPath: string
  launchPath: string
  codexHome: string
  isolatedHome: string
}

export type HubSession = {
  /** Absent on legacy pre-P5 rows. New writes always use version 2. */
  sessionSchemaVersion?: 2
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
  revision?: number
  attemptId?: string
  attemptNumber?: number
  runnerId?: string
  runnerState?: SessionRunnerState
  runnerErrorCode?: SessionRunnerErrorCode
  runnerEventSequence?: number
  cancelRequested?: boolean
  task?: SessionTask
  target?: SessionTarget
  steps?: SessionStepView[]
  events?: SessionEventView[]
  runnerArtifacts?: LocalRunnerArtifacts
}
