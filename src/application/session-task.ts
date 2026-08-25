import {
  SESSION_TASK_VERSION,
  type SessionKind,
  type SessionTarget,
  type SessionTask,
  type SessionTaskStep
} from '../contracts/index.js'

export type CreateSessionTaskInput = {
  id: string
  kind: SessionKind
  target: SessionTarget
  intent?: string
  inboxIds?: readonly string[]
}

const TASK_DEFINITIONS: Record<SessionKind, {
  summary: string
  instructions: readonly string[]
  steps: readonly SessionTaskStep[]
}> = {
  attach: {
    summary: 'Prepare a Skill Graft attachment and wait for trusted materialization.',
    instructions: [
      'Prepare an immutable library snapshot handoff for the selected logical worktree.',
      'Do not claim, materialize, or report completion; trusted Application sync owns those effects.'
    ],
    steps: [
      { id: 'prepareSnapshot', title: 'Prepare immutable snapshot handoff', owner: 'runner' },
      { id: 'awaitApplicationSync', title: 'Await trusted materialization proof', owner: 'application' }
    ]
  },
  detach: {
    summary: 'Request a trusted Skill Graft detach and verify the result.',
    instructions: [
      'Use only the trusted detach command supplied by the host binding.',
      'Verify the logical worktree is detached without changing unrelated repository content.'
    ],
    steps: [
      { id: 'requestDetach', title: 'Request trusted detach', owner: 'runner' },
      { id: 'verifyDetach', title: 'Verify detach result', owner: 'runner' }
    ]
  },
  edit: {
    summary: 'Apply the requested Skill edit and verify its bounded result.',
    instructions: [
      'Change only the selected logical Skill and files owned by it.',
      'Verify the requested result without editing an attached game repository copy.'
    ],
    steps: [
      { id: 'applyEdit', title: 'Apply bounded Skill edit', owner: 'runner' },
      { id: 'verifyEdit', title: 'Verify Skill edit', owner: 'runner' }
    ]
  },
  chat: {
    summary: 'Respond to the requested Skill Graft hub task.',
    instructions: ['Work only within the logical hub scope authorized by the request.'],
    steps: [{ id: 'respond', title: 'Respond to hub request', owner: 'runner' }]
  },
  analyze: {
    summary: 'Analyze queued inbox items and return a recommendation.',
    instructions: [
      'Analyze only the selected logical inbox items.',
      'Do not adopt, merge, reject, or modify a game repository.'
    ],
    steps: [{ id: 'analyzeInbox', title: 'Analyze inbox items', owner: 'runner' }]
  }
}

export function createSessionTask(input: CreateSessionTaskInput): SessionTask {
  const definition = TASK_DEFINITIONS[input.kind]
  const intent = input.intent?.trim()
  return {
    taskVersion: SESSION_TASK_VERSION,
    id: input.id,
    kind: input.kind,
    target: { ...input.target },
    intent: intent || undefined,
    inboxIds: input.inboxIds ? [...input.inboxIds] : undefined,
    prompt: {
      summary: definition.summary,
      instructions: [
        ...definition.instructions,
        ...(intent ? [`User intent: ${intent}`] : [])
      ]
    },
    steps: definition.steps.map((step) => ({ ...step })),
    completion: input.kind === 'attach'
      ? { kind: 'materializationProof' }
      : { kind: 'runnerExit', successExitCodes: [0] },
    capabilities: { resume: true, cancel: true }
  }
}
