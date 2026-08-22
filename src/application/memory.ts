import { isPortableOpaqueIdentifier, type AuditEvent, type SessionView } from '../contracts/index.js'
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
  ApplicationTransactionParticipant,
  ApplicationTransactionParticipantContext,
  ApplicationTransactionPort,
  ApplicationTransactionSavepoint,
  ApplicationWriteTransaction
} from './transaction-port.js'
import { isApplicationTransactionError } from './transaction-port.js'

export type MemoryApplicationTransactions = ApplicationTransactionPort & {
  identities: ApplicationTransactionIdentity[]
  calls: {
    enter: number
    commit: number
    abort: number
    publish: number
    rollback: number
    finalize: number
  }
  participantEvents: Array<{
    participantId: string
    phase: 'publish' | 'rollback' | 'finalize'
  }>
}

type MemoryParticipantEntry = {
  participant: ApplicationTransactionParticipant
  participantId: string
  ordinal: number
  state:
    | 'enlisted'
    | 'publish-started'
    | 'published'
    | 'rollback-started'
    | 'rolled-back'
    | 'finalize-started'
    | 'finalized'
}

function memoryParticipantIdKey(participant: ApplicationTransactionParticipant): string {
  if (!participant || typeof participant !== 'object'
    || typeof participant.publish !== 'function'
    || typeof participant.rollback !== 'function'
    || typeof participant.finalize !== 'function') {
    throw new Error('memory transaction participant is invalid')
  }
  const id = participant.participantId
  if (!isPortableOpaqueIdentifier(id) || id.length > 128) {
    throw new Error('memory transaction participantId must be a portable opaque identifier')
  }
  return id.toLowerCase()
}

function participantPublicationIsUncertain(error: unknown): boolean {
  return isApplicationTransactionError(error) && error.code === 'LOCK_NOT_OWNED'
}

/**
 * Test-only transaction control. It verifies the explicit decision protocol;
 * tests that need staged rollback provide a store-aware implementation.
 */
export function createMemoryApplicationTransactions(): MemoryApplicationTransactions {
  const identities: ApplicationTransactionIdentity[] = []
  const calls = { enter: 0, commit: 0, abort: 0, publish: 0, rollback: 0, finalize: 0 }
  const participantEvents: MemoryApplicationTransactions['participantEvents'] = []
  const usedParticipants = new WeakSet<object>()
  const participantContext: ApplicationTransactionParticipantContext = Object.freeze({
    revalidateLease() {}
  })

  async function rollbackParticipants(entries: readonly MemoryParticipantEntry[]): Promise<Error | null> {
    let firstFailure: Error | null = null
    for (const entry of [...entries].sort((left, right) => right.ordinal - left.ordinal)) {
      if (entry.state === 'rollback-started'
        || entry.state === 'rolled-back'
        || entry.state === 'finalize-started'
        || entry.state === 'finalized') continue
      calls.rollback += 1
      participantEvents.push({ participantId: entry.participantId, phase: 'rollback' })
      try {
        entry.state = 'rollback-started'
        await entry.participant.rollback(participantContext)
        entry.state = 'rolled-back'
      } catch (error) {
        firstFailure ??= error instanceof Error ? error : new Error(String(error))
        if (participantPublicationIsUncertain(error)) break
      }
    }
    return firstFailure
  }

  return {
    identities,
    calls,
    participantEvents,
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
      let participantOrdinal = 0
      const savepoints = new Map<number, number>()
      const participants: MemoryParticipantEntry[] = []
      const cancelledParticipants: MemoryParticipantEntry[] = []
      const participantIds = new Set<string>()
      const control: ApplicationWriteTransaction = {
        revalidateLease() {
          if (!active || decided) throw new Error('memory transaction is closed')
        },
        savepoint() {
          if (!active) throw new Error('memory transaction is closed')
          const ordinal = ++savepointOrdinal
          savepoints.set(ordinal, participants.length)
          return { ordinal } as unknown as ApplicationTransactionSavepoint
        },
        rollbackTo(savepoint) {
          const ordinal = (savepoint as unknown as { ordinal?: number }).ordinal || -1
          const participantCount = savepoints.get(ordinal)
          if (!active || participantCount === undefined) {
            throw new Error('memory transaction savepoint is invalid')
          }
          cancelledParticipants.push(...participants.splice(participantCount))
          for (const candidate of [...savepoints.keys()]) {
            if (candidate >= ordinal) savepoints.delete(candidate)
          }
        },
        enlist(participant) {
          if (!active) throw new Error('memory transaction is closed')
          if (decided) throw new Error('memory transaction already has a decision')
          const participantIdKey = memoryParticipantIdKey(participant)
          if (participantIds.has(participantIdKey)) {
            throw new Error('memory transaction participantId is already enlisted')
          }
          if (usedParticipants.has(participant)) {
            throw new Error('memory transaction participant object is one-shot and was already enlisted')
          }
          participantIds.add(participantIdKey)
          usedParticipants.add(participant)
          participants.push({
            participant,
            participantId: participant.participantId,
            ordinal: ++participantOrdinal,
            state: 'enlisted'
          })
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
      let failure: unknown
      let failed = false
      try {
        let decision: ApplicationTransactionDecision<T> | undefined
        try {
          decision = await callback(control)
        } catch (error) {
          failure = error
          failed = true
        }
        active = false
        if (failed) throw failure
        if (!decided || !decision || (decision.kind !== 'commit' && decision.kind !== 'abort')) {
          throw new Error('memory transaction requires an explicit decision')
        }
        if (decision.kind === 'abort') {
          throw decision.error instanceof Error ? decision.error : new Error(String(decision.error))
        }
        const cancelledFailure = await rollbackParticipants(cancelledParticipants)
        if (cancelledFailure) throw cancelledFailure
        for (const entry of participants) {
          calls.publish += 1
          participantEvents.push({ participantId: entry.participantId, phase: 'publish' })
          entry.state = 'publish-started'
          await entry.participant.publish(participantContext)
          entry.state = 'published'
        }
        for (const entry of [...participants].reverse()) {
          calls.finalize += 1
          participantEvents.push({ participantId: entry.participantId, phase: 'finalize' })
          try {
            entry.state = 'finalize-started'
            await entry.participant.finalize(participantContext)
            entry.state = 'finalized'
          } catch {
            // Durable success is already represented by the explicit commit
            // decision in this test adapter; finalization is best-effort.
          }
        }
        return decision.value
      } catch (error) {
        failure = error
        failed = true
        if (!participantPublicationIsUncertain(error)) {
          const rollbackFailure = await rollbackParticipants([
            ...participants,
            ...cancelledParticipants
          ])
          if (rollbackFailure && !failed) {
            failure = rollbackFailure
            failed = true
          }
        }
        throw failure instanceof Error ? failure : new Error(String(failure))
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
  calls: { list: number; get: number; start: number; resume: number; reap: number; completeAttach: number }
}

export function createMemorySessions(options: {
  seed?: readonly SessionView[]
  now?: () => string
  nextId?: () => string
} = {}): MemorySessions {
  const sessions: SessionView[] = (options.seed || []).map((item) => ({
    ...item,
    attachCompletion: item.attachCompletion ? { ...item.attachCompletion } : undefined
  }))
  const calls = { list: 0, get: 0, start: 0, resume: 0, reap: 0, completeAttach: 0 }
  let counter = sessions.length
  const now = options.now || (() => '2000-01-01T00:00:00.000Z')
  const nextId = options.nextId || (() => `memory-session-${++counter}`)
  const locatorIds = new Map<string, string>()

  const find = (id: string) => sessions.find((item) => item.id === id) || null
  const copy = (value: SessionView) => ({
    ...value,
    inboxIds: value.inboxIds ? [...value.inboxIds] : undefined,
    attachCompletion: value.attachCompletion ? { ...value.attachCompletion } : undefined
  })
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
      if (value.kind === 'attach' && value.status === 'completed') throw portFault('request-in-progress')
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
    },
    completeAttach(input) {
      calls.completeAttach += 1
      const value = find(input.sessionId)
      if (!value) return { status: 'not-authorized', reason: 'not-found' }
      if (value.kind !== 'attach') return { status: 'not-authorized', reason: 'not-attach' }
      if (value.target?.kind !== 'worktree' || value.target.id !== input.proof.targetId) {
        return { status: 'not-authorized', reason: 'target-mismatch' }
      }
      if (value.status === 'completed') {
        const existing = value.attachCompletion
        if (!existing
          || existing.targetId !== input.proof.targetId
          || existing.pathKey !== input.proof.pathKey
          || existing.materializationId !== input.proof.materializationId) {
          return { status: 'proof-conflict' }
        }
        return { status: 'already-completed', session: copy(value) }
      }
      if (value.status !== 'waiting') return { status: 'not-authorized', reason: 'not-waiting' }
      if (value.exitCode !== 0) return { status: 'not-authorized', reason: 'exit-not-zero' }
      value.status = 'completed'
      value.attachCompletion = { ...input.proof }
      value.canResume = false
      return { status: 'completed', session: copy(value) }
    }
  }
}
