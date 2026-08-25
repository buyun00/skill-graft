import type { LocalHostContext } from '../adapters/host-context.js'
import type {
  AttachCompletionProof,
  CurrentSessionStatus,
  SessionEventView,
  SessionRunnerErrorCode,
  SessionRunnerState,
  SessionStepView,
  SessionTask,
  SessionTarget
} from '../contracts/index.js'
import type { SessionStartRequest } from '../application/ports.js'

export type DshStoredSession = {
  sessionSchemaVersion: 1
  id: string
  kind: SessionTask['kind']
  status: CurrentSessionStatus
  revision: number
  attemptId: string
  attemptNumber: number
  runnerEventSequence: number
  cancelRequested: boolean
  task: SessionTask
  target: SessionTarget
  locator?: SessionStartRequest['locator']
  intent?: string
  inboxIds?: readonly string[]
  runnerId?: string
  continuationToken?: string
  runnerState?: SessionRunnerState
  runnerErrorCode?: SessionRunnerErrorCode
  startedAt: string
  endedAt?: string
  exitCode?: number | null
  steps: readonly SessionStepView[]
  events: readonly SessionEventView[]
  attachCompletion?: AttachCompletionProof
}

export class DshSessionRevisionConflict extends Error {
  constructor(readonly sessionId: string) {
    super(`DSH session revision changed: ${sessionId}`)
    this.name = 'DshSessionRevisionConflict'
  }
}

export type DshSessionRepository = {
  list(): DshStoredSession[]
  read(sessionId: string): DshStoredSession | null
  insert(session: DshStoredSession): DshStoredSession
  update(
    sessionId: string,
    expectedRevision: number,
    change: (current: DshStoredSession) => DshStoredSession
  ): DshStoredSession
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function createDshSessionRepository(ctx: LocalHostContext): DshSessionRepository {
  const file = ctx.path.join(ctx.hubRoot, 'skill-review', 'dsh-sessions.json')

  const load = (): DshStoredSession[] => {
    const value = ctx.persist.readJson<{ schemaVersion?: number; sessions?: DshStoredSession[] }>(file, {
      schemaVersion: 1,
      sessions: []
    })
    if (value.schemaVersion !== undefined && value.schemaVersion !== 1) {
      throw new Error('DSH session document schema is unsupported')
    }
    return Array.isArray(value.sessions)
      ? value.sessions.filter((session) => session?.sessionSchemaVersion === 1).map(clone)
      : []
  }

  const save = (sessions: readonly DshStoredSession[]): void => {
    ctx.persist.writeJson(file, { schemaVersion: 1, sessions })
  }

  return {
    list: load,
    read(sessionId) {
      return load().find((session) => session.id === sessionId) || null
    },
    insert(session) {
      const sessions = load()
      if (sessions.some((candidate) => candidate.id === session.id)) {
        throw new DshSessionRevisionConflict(session.id)
      }
      sessions.push(clone(session))
      save(sessions)
      return clone(session)
    },
    update(sessionId, expectedRevision, change) {
      const sessions = load()
      const index = sessions.findIndex((session) => session.id === sessionId)
      if (index < 0 || sessions[index]!.revision !== expectedRevision) {
        throw new DshSessionRevisionConflict(sessionId)
      }
      const next = change(clone(sessions[index]!))
      if (next.id !== sessionId) throw new Error('DSH session update changed identity')
      next.revision = expectedRevision + 1
      sessions[index] = clone(next)
      save(sessions)
      return clone(next)
    }
  }
}
