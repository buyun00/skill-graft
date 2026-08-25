import type { SessionKind, SessionTarget } from './state.js'

export const SESSION_TASK_VERSION = 1 as const

export const CURRENT_SESSION_STATUSES = [
  'queued',
  'running',
  'awaiting',
  'failed',
  'completed',
  'cancelled'
] as const

/** Only accepted while projecting pre-P5 durable rows. New writes never use it. */
export const LEGACY_SESSION_STATUSES = ['waiting'] as const

export type CurrentSessionStatus = (typeof CURRENT_SESSION_STATUSES)[number]
export type LegacySessionStatus = (typeof LEGACY_SESSION_STATUSES)[number]
export type SessionStatus = CurrentSessionStatus | LegacySessionStatus

export const SESSION_STEP_IDS = [
  'prepareSnapshot',
  'awaitApplicationSync',
  'requestDetach',
  'verifyDetach',
  'applyEdit',
  'verifyEdit',
  'respond',
  'analyzeInbox'
] as const

export type SessionStepId = (typeof SESSION_STEP_IDS)[number]
export type SessionStepOwner = 'runner' | 'application'
export type SessionStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export type SessionTaskPrompt = {
  /** Locator-free business summary. Host adapters append execution bindings separately. */
  summary: string
  /** Locator-free business instructions. They must not contain host commands or paths. */
  instructions: readonly string[]
}

export type SessionTaskStep = {
  id: SessionStepId
  title: string
  owner: SessionStepOwner
}

export type SessionCompletionRule =
  | { kind: 'materializationProof' }
  | { kind: 'runnerExit'; successExitCodes: readonly [0] }

export type SessionTaskCapabilities = {
  resume: boolean
  cancel: boolean
}

/**
 * Host-neutral unit of session work. Locators, executable names, argv, process
 * identities, and runner-native protocol data deliberately live outside it.
 */
export type SessionTask = {
  taskVersion: typeof SESSION_TASK_VERSION
  id: string
  kind: SessionKind
  target: SessionTarget
  intent?: string
  inboxIds?: readonly string[]
  prompt: SessionTaskPrompt
  steps: readonly SessionTaskStep[]
  completion: SessionCompletionRule
  capabilities: SessionTaskCapabilities
}

export type SessionStepView = SessionTaskStep & {
  status: SessionStepStatus
  at?: string
}

export const SESSION_EVENT_TYPES = [
  'session.queued',
  'runner.started',
  'runner.status',
  'step.status',
  'session.cancel-requested',
  'session.completed'
] as const

export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number]

/** Bounded, locator-free event projection safe for CLI, SSE, and host UIs. */
export type SessionEventView = {
  sequence: number
  attemptId: string
  type: SessionEventType
  at: string
  status?: CurrentSessionStatus
  stepId?: SessionStepId
  /** Stable machine code only; never runner output or a host locator. */
  code?: string
}

export type SessionCapabilitiesView = {
  canResume: boolean
  canCancel: boolean
}
