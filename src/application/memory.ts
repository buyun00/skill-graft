import type { AuditEvent, SessionView } from '../contracts/index.js'
import type {
  RequestLedgerEntry,
  RequestLedgerPort,
  SessionPort,
  SessionResumeRequest,
  SessionStartRequest
} from './ports.js'
import { portFault } from './port-fault.js'
import type {
  ApplicationTransactionDecision,
  ApplicationTransactionIdentity,
  ApplicationTransactionPort,
  ApplicationTransactionSavepoint,
  ApplicationWriteTransaction
} from './transaction-port.js'

export type MemoryApplicationTransactions = ApplicationTransactionPort & {
  identities: ApplicationTransactionIdentity[]
  calls: { enter: number; commit: number; abort: number }
}

/**
 * Test-only transaction control. It verifies the explicit decision protocol;
 * tests that need staged rollback provide a store-aware implementation.
 */
export function createMemoryApplicationTransactions(): MemoryApplicationTransactions {
  const identities: ApplicationTransactionIdentity[] = []
  const calls = { enter: 0, commit: 0, abort: 0 }
  return {
    identities,
    calls,
    async withWriteTransaction<T>(
      identity: ApplicationTransactionIdentity,
      callback: (
        transaction: ApplicationWriteTransaction
      ) => ApplicationTransactionDecision<T> | Promise<ApplicationTransactionDecision<T>>
    ): Promise<T> {
      identities.push({ ...identity })
      calls.enter += 1
      let active = true
      let decided = false
      let savepointOrdinal = 0
      const savepoints = new Set<number>()
      const control: ApplicationWriteTransaction = {
        savepoint() {
          if (!active) throw new Error('memory transaction is closed')
          const ordinal = ++savepointOrdinal
          savepoints.add(ordinal)
          return { ordinal } as unknown as ApplicationTransactionSavepoint
        },
        rollbackTo(savepoint) {
          if (!active || !savepoints.has((savepoint as unknown as { ordinal?: number }).ordinal || -1)) {
            throw new Error('memory transaction savepoint is invalid')
          }
        },
        commit<U>(value: U) {
          if (!active || decided) throw new Error('memory transaction already has a decision')
          decided = true
          calls.commit += 1
          return { kind: 'commit', value } as ApplicationTransactionDecision<U>
        },
        abort(error: unknown) {
          if (!active || decided) throw new Error('memory transaction already has a decision')
          decided = true
          calls.abort += 1
          return { kind: 'abort', error } as ApplicationTransactionDecision<never>
        }
      }
      try {
        const decision = await callback(control)
        if (!decided || !decision || (decision.kind !== 'commit' && decision.kind !== 'abort')) {
          throw new Error('memory transaction requires an explicit decision')
        }
        if (decision.kind === 'abort') {
          throw decision.error instanceof Error ? decision.error : new Error(String(decision.error))
        }
        return decision.value
      } finally {
        active = false
      }
    }
  }
}

export type MemoryLedger = RequestLedgerPort & {
  entries: RequestLedgerEntry[]
  events: AuditEvent[]
  calls: { read: number; begin: number; complete: number; listEvents: number }
}

export function createMemoryRequestLedger(): MemoryLedger {
  const entries: RequestLedgerEntry[] = []
  const events: AuditEvent[] = []
  const calls = { read: 0, begin: 0, complete: 0, listEvents: 0 }
  return {
    entries,
    events,
    calls,
    read(requestId) {
      calls.read += 1
      return entries.find((entry) => entry.requestId === requestId) || null
    },
    begin(entry) {
      calls.begin += 1
      if (entries.some((candidate) => candidate.requestId === entry.requestId)) {
        throw portFault('request-in-progress')
      }
      entries.push(entry)
    },
    complete(entry, inputEvents) {
      calls.complete += 1
      const index = entries.findIndex((candidate) => candidate.requestId === entry.requestId)
      if (index < 0) throw portFault('resource-not-found')
      entries[index] = entry
      const nextEvents = Array.isArray(inputEvents) ? inputEvents : [inputEvents]
      for (const event of nextEvents) {
        if (!events.some((candidate) => candidate.id === event.id)) events.push(event)
      }
    },
    listEvents(limit) {
      calls.listEvents += 1
      return events.slice().reverse().slice(0, limit)
    }
  }
}

export type MemorySessions = SessionPort & {
  sessions: SessionView[]
  calls: { list: number; get: number; start: number; resume: number; reap: number }
}

export function createMemorySessions(options: {
  seed?: readonly SessionView[]
  now?: () => string
  nextId?: () => string
} = {}): MemorySessions {
  const sessions = (options.seed || []).map((item) => ({ ...item }))
  const calls = { list: 0, get: 0, start: 0, resume: 0, reap: 0 }
  let counter = sessions.length
  const now = options.now || (() => '2000-01-01T00:00:00.000Z')
  const nextId = options.nextId || (() => `memory-session-${++counter}`)
  const locatorIds = new Map<string, string>()

  const find = (id: string) => sessions.find((item) => item.id === id) || null
  const copy = (value: SessionView) => ({ ...value, inboxIds: value.inboxIds ? [...value.inboxIds] : undefined })
  const targetFor = (input: SessionStartRequest) => {
    if (input.target) return input.target
    if (!input.locator) return undefined
    const key = `${input.locator.kind}:${input.locator.value}`
    let id = locatorIds.get(key)
    if (!id) {
      id = `memory-${input.locator.kind}:${locatorIds.size + 1}`
      locatorIds.set(key, id)
    }
    return { kind: input.locator.kind, id }
  }

  return {
    sessions,
    calls,
    list() {
      calls.list += 1
      return sessions.map(copy)
    },
    get(sessionId) {
      calls.get += 1
      const value = find(sessionId)
      return value ? copy(value) : null
    },
    start(input: SessionStartRequest) {
      calls.start += 1
      const startRunner = input.options?.start !== false
      const value: SessionView = {
        id: nextId(),
        kind: input.kind,
        status: startRunner ? 'running' : 'queued',
        target: targetFor(input),
        intent: input.intent,
        runnerId: startRunner ? `memory-runner-${counter}` : undefined,
        startedAt: now(),
        canResume: false,
        inboxIds: input.inboxIds ? [...input.inboxIds] : undefined
      }
      sessions.push(value)
      return copy(value)
    },
    resume(input: SessionResumeRequest) {
      calls.resume += 1
      const value = find(input.sessionId)
      if (!value) throw portFault('resource-not-found')
      if (value.status === 'running') throw portFault('request-in-progress')
      value.intent = input.message
      value.status = input.options?.start === false ? 'queued' : 'running'
      value.error = undefined
      value.exitCode = null
      value.endedAt = undefined
      return copy(value)
    },
    reap() {
      calls.reap += 1
      return []
    }
  }
}
