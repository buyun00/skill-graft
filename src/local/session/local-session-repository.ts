import type { LocalHostContext } from '../../adapters/host-context.js'
import type { HubSession } from './types.js'

export class LocalSessionRevisionConflict extends Error {
  constructor(readonly sessionId: string) {
    super(`local session revision changed: ${sessionId}`)
    this.name = 'LocalSessionRevisionConflict'
  }
}

export type LocalSessionRepository = {
  list(): HubSession[]
  read(sessionId: string): HubSession | null
  insert(session: HubSession): HubSession
  update(
    sessionId: string,
    expectedRevision: number,
    change: (current: HubSession) => HubSession
  ): HubSession
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function createLocalSessionRepository(ctx: LocalHostContext): LocalSessionRepository {
  const file = ctx.path.join(ctx.hubRoot, 'skill-review', 'sessions.json')

  const load = (): HubSession[] => {
    const value = ctx.persist.readJson<{ sessions?: HubSession[] }>(file, { sessions: [] })
    return Array.isArray(value.sessions) ? value.sessions.map(clone) : []
  }

  const save = (sessions: readonly HubSession[]) => {
    ctx.persist.writeJson(file, { sessions })
  }

  return {
    list() {
      return load()
    },
    read(sessionId) {
      return load().find((session) => session.id === sessionId) || null
    },
    insert(session) {
      const sessions = load()
      if (sessions.some((candidate) => candidate.id === session.id)) {
        throw new LocalSessionRevisionConflict(session.id)
      }
      sessions.push(clone(session))
      save(sessions)
      return clone(session)
    },
    update(sessionId, expectedRevision, change) {
      const sessions = load()
      const index = sessions.findIndex((session) => session.id === sessionId)
      if (index < 0) throw new LocalSessionRevisionConflict(sessionId)
      const current = sessions[index] as HubSession
      const revision = current.revision ?? 0
      if (revision !== expectedRevision) throw new LocalSessionRevisionConflict(sessionId)
      const next = change(clone(current))
      if (next.id !== sessionId) throw new Error('local session update changed identity')
      next.revision = expectedRevision + 1
      sessions[index] = clone(next)
      save(sessions)
      return clone(next)
    }
  }
}
