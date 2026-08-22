import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import { isPortableOpaqueIdentifier } from '../contracts/index.js'
import type {
  ApplicationTransactionDecision,
  ApplicationTransactionIdentity,
  ApplicationTransactionParticipant,
  ApplicationTransactionParticipantContext,
  ApplicationTransactionPort,
  ApplicationTransactionSavepoint,
  ApplicationWriteTransaction
} from '../application/transaction-port.js'
import {
  ApplicationTransactionErrorBase,
  isApplicationTransactionError,
  type ApplicationTransactionError
} from '../application/transaction-port.js'
import type { LocalHubStateFile, PersistPort } from './host-context.js'
import { DurableLimitError } from './durable-files.js'
import {
  DurableCorruptionError,
  DurableRecoveryRequiredError,
  DurableStateStore,
  type DurableJsonSchema,
  type DurableRecoveryResult,
  type DurableSchemaResolver,
  type DurableStateStoreOptions,
  type DurableValidationResult
} from './durable-wal.js'

const DECISION_MARKER = Symbol('skill-graft.transaction-decision')
const SAVEPOINT_MARKER = Symbol('skill-graft.transaction-savepoint')
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/

export type DurableLease = {
  readonly ownerToken: string
  /** Renew also verifies owner identity and that the prior lease was not lost. */
  renew(): void | Promise<void>
  release(): void | Promise<void>
}

export type DurableTransactionLockPort = {
  acquire(identity: ApplicationTransactionIdentity): Promise<
    | { status: 'acquired'; lease: DurableLease }
    | { status: 'busy'; reason: string; retryAfterMs?: number }
  >
}

export type DurableTransactionHostOptions = DurableStateStoreOptions & {
  lock: DurableTransactionLockPort
  renewalIntervalMs?: number
}

export interface TransactionAwarePersistPort extends PersistPort {
  /** Reads staged ALS state first, then durable primary/backup, without fallback. */
  readOptionalJson<T>(file: string): T | null
  /** Fails before an adapter performs any write-side preparation outside a transaction. */
  assertWriteTransactionActive(): void
}

type StagedDocument = {
  text: string
  value: unknown
}

type RuntimeSavepoint = ApplicationTransactionSavepoint & {
  readonly [SAVEPOINT_MARKER]: {
    transactionId: string
    ordinal: number
    nonce: string
  }
}

type SavepointState = {
  ordinal: number
  staged: Map<string, StagedDocument>
  participantCount: number
}

type ParticipantState =
  | 'enlisted'
  | 'publish-started'
  | 'published'
  | 'rollback-started'
  | 'rolled-back'
  | 'finalize-started'
  | 'finalized'

type ParticipantEntry = {
  participant: ApplicationTransactionParticipant
  participantId: string
  ordinal: number
  state: ParticipantState
}

type ActiveTransaction = {
  id: string
  nonce: string
  active: boolean
  decided: boolean
  issuedDecision: ApplicationTransactionDecision<unknown> | null
  staged: Map<string, StagedDocument>
  savepoints: Map<ApplicationTransactionSavepoint, SavepointState>
  nextSavepoint: number
  participants: ParticipantEntry[]
  cancelledParticipants: ParticipantEntry[]
  participantIds: Set<string>
  nextParticipant: number
}

type RuntimeDecision<T> = ApplicationTransactionDecision<T> & {
  readonly [DECISION_MARKER]: {
    transactionId: string
    nonce: string
  }
}

abstract class DurableApplicationTransactionError extends ApplicationTransactionErrorBase {
  abstract readonly code: ApplicationTransactionError['code']
  abstract readonly retryable: boolean

  protected constructor(message: string, details?: Readonly<Record<string, string | number | boolean | null>>) {
    super(message, details)
  }
}

export class DurableLockBusyError extends DurableApplicationTransactionError {
  readonly code = 'LOCK_BUSY' as const
  readonly retryable = true

  constructor(reason: string, retryAfterMs?: number) {
    super('durable write lock is busy', {
      reason,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs })
    })
    this.name = 'DurableLockBusyError'
  }
}

export class DurableLockNotOwnedError extends DurableApplicationTransactionError {
  readonly code = 'LOCK_NOT_OWNED' as const
  readonly retryable = true

  constructor(message = 'durable write lease is no longer owned') {
    super(message)
    this.name = 'DurableLockNotOwnedError'
  }
}

export class DurableTransactionFailureError extends DurableApplicationTransactionError {
  readonly code = 'PORT_FAILURE' as const
  readonly retryable = true

  constructor(message: string) {
    super(message)
    this.name = 'DurableTransactionFailureError'
  }
}

export class DurableTransactionDecisionRequiredError extends DurableTransactionFailureError {
  constructor() {
    super('write transaction callback must return its own transaction.commit(...) or transaction.abort(...)')
    this.name = 'DurableTransactionDecisionRequiredError'
  }
}

function transactionToken(): string {
  return randomBytes(16).toString('hex')
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function participantIdKey(participant: ApplicationTransactionParticipant): string {
  if (!participant || typeof participant !== 'object'
    || typeof participant.publish !== 'function'
    || typeof participant.rollback !== 'function'
    || typeof participant.finalize !== 'function') {
    throw new DurableTransactionFailureError('transaction participant is invalid')
  }
  const id = participant.participantId
  if (!isPortableOpaqueIdentifier(id) || id.length > 128) {
    throw new DurableTransactionFailureError(
      'transaction participantId must be a portable opaque identifier'
    )
  }
  return id.toLowerCase()
}

function participantPublicationIsUncertain(error: unknown): boolean {
  return error instanceof DurableRecoveryRequiredError
    || isApplicationTransactionError(error) && error.code === 'LOCK_NOT_OWNED'
}

function assertTransactionIdentity(identity: ApplicationTransactionIdentity): void {
  if (!identity || typeof identity !== 'object') throw new Error('transaction identity is required')
  if (identity.scope === 'hub-global') {
    if (identity.key !== 'hub-global') throw new Error('hub-global transaction key must be hub-global')
  } else if (identity.scope === 'worktree') {
    if (!SHA256_PATTERN.test(identity.key)) {
      throw new Error('worktree transaction key must be a full sha256 path key')
    }
  } else {
    throw new Error('transaction scope is invalid')
  }
  for (const [name, value] of [
    ['hostId', identity.hostId],
    ['commandKind', identity.commandKind],
    ['requestId', identity.requestId]
  ] as const) {
    if (typeof value !== 'string' || !value || value !== value.trim()
      || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error(`transaction ${name} is invalid`)
    }
  }
}

function validateStaged(schema: DurableJsonSchema, value: unknown): void {
  let result: DurableValidationResult
  try {
    result = (schema.validateWrite ?? schema.validate)(value)
  } catch (error) {
    throw new DurableCorruptionError(
      `${schema.name}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (!result.valid) throw new DurableCorruptionError(`${schema.name}: ${result.message}`)
}

function emptyRecovery(): DurableRecoveryResult {
  return {
    recoveredTransactions: 0,
    rolledBackTransactions: 0,
    finalizedTransactions: 0
  }
}

export function createDurableTransactionHost(options: DurableTransactionHostOptions): {
  store: DurableStateStore
  persist: TransactionAwarePersistPort
  transactions: ApplicationTransactionPort
  recover(identity: ApplicationTransactionIdentity): Promise<DurableRecoveryResult>
} {
  const store = new DurableStateStore(options)
  const storage = new AsyncLocalStorage<ActiveTransaction>()
  const usedParticipants = new WeakSet<object>()
  const maximumStagedDocumentBytes = options.limits?.maxDocumentBytes ?? 16 * 1024 * 1024

  function current(): ActiveTransaction | undefined {
    const transaction = storage.getStore()
    if (transaction && !transaction.active) {
      throw new DurableTransactionFailureError('transaction context is closed')
    }
    return transaction
  }

  function readDocument<T>(file: string, fallback: T): T {
    const relativePath = store.relativePath(file)
    const transaction = current()
    const staged = transaction?.staged.get(relativePath)
    if (staged) return JSON.parse(staged.text) as T
    return store.read<T>(relativePath, { fallback }).value
  }

  function stage(file: string, value: unknown): void {
    const transaction = current()
    if (!transaction) {
      throw new DurableTransactionFailureError('durable PersistPort writes require an active write transaction')
    }
    if (transaction.decided) {
      throw new DurableTransactionFailureError('writes are closed after a transaction decision')
    }
    const relativePath = store.relativePath(file)
    const schema = options.schemaFor(relativePath)
    if (!schema) throw new Error(`no durable schema registered for ${relativePath}`)
    let serialized: string | undefined
    try {
      serialized = JSON.stringify(value, null, 2)
    } catch (error) {
      throw new DurableCorruptionError(
        `cannot serialize ${relativePath}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    if (typeof serialized !== 'string') {
      throw new DurableCorruptionError(`cannot serialize ${relativePath}: JSON value is not persistable`)
    }
    const text = `${serialized}\n`
    if (Buffer.byteLength(text, 'utf8') > maximumStagedDocumentBytes) {
      throw new DurableLimitError(
        `serialized durable document exceeds the ${maximumStagedDocumentBytes} byte limit`
      )
    }
    const persisted = JSON.parse(serialized) as unknown
    // Validate the exact JSON shape that will be published. Optional
    // `undefined` properties are legitimately omitted by JSON.stringify.
    validateStaged(schema, persisted)
    transaction.staged.set(relativePath, { text, value: persisted })
  }

  const persist: TransactionAwarePersistPort = {
    assertWriteTransactionActive() {
      const transaction = current()
      if (!transaction || transaction.decided) {
        throw new DurableTransactionFailureError(
          'durable writes require an open active write transaction'
        )
      }
    },
    readJson<T>(file: string, fallback: T): T {
      return readDocument(file, fallback)
    },
    writeJson(file, value) {
      stage(file, value)
    },
    readOptionalJson<T>(file: string): T | null {
      const relativePath = store.relativePath(file)
      const transaction = current()
      const staged = transaction?.staged.get(relativePath)
      if (staged) return JSON.parse(staged.text) as T
      return store.readOptional<T>(relativePath)?.value ?? null
    },
    readList(file) {
      const relativePath = store.relativePath(file)
      const transaction = current()
      const text = transaction?.staged.get(relativePath)?.text ?? store.readText(relativePath) ?? ''
      return text.split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
    },
    readState(file) {
      return readDocument<LocalHubStateFile>(file, { version: 1, items: [], lastIngest: null })
    },
    writeState(file, state) {
      stage(file, state)
    }
  }

  async function acquireLocks(identity: ApplicationTransactionIdentity): Promise<DurableLease[]> {
    assertTransactionIdentity(identity)
    const identities: ApplicationTransactionIdentity[] = [{
      scope: 'hub-global',
      key: 'hub-global',
      hostId: identity.hostId,
      commandKind: identity.commandKind,
      requestId: identity.requestId
    }]
    if (identity.scope === 'worktree') identities.push(identity)
    const leases: DurableLease[] = []
    try {
      for (const lockIdentity of identities) {
        const acquired = await options.lock.acquire(lockIdentity)
        if (acquired.status === 'busy') {
          throw new DurableLockBusyError(acquired.reason, acquired.retryAfterMs)
        }
        leases.push(acquired.lease)
      }
      return leases
    } catch (error) {
      for (const lease of [...leases].reverse()) {
        try { await lease.release() } catch { /* preserve acquisition failure */ }
      }
      throw error
    }
  }

  async function renewAll(leases: readonly DurableLease[]): Promise<void> {
    try {
      for (const lease of leases) await lease.renew()
    } catch (error) {
      if (isApplicationTransactionError(error) && error.code === 'LOCK_NOT_OWNED') throw error
      throw new DurableLockNotOwnedError(asError(error).message)
    }
  }

  async function releaseAll(leases: readonly DurableLease[]): Promise<Error | null> {
    let failure: Error | null = null
    for (const lease of [...leases].reverse()) {
      try {
        await lease.release()
      } catch (error) {
        failure ||= asError(error)
      }
    }
    return failure
  }

  const transactions: ApplicationTransactionPort = {
    async withWriteTransaction<T>(
      identity: ApplicationTransactionIdentity,
      callback: (
        transaction: ApplicationWriteTransaction
      ) => ApplicationTransactionDecision<T> | Promise<ApplicationTransactionDecision<T>>
    ): Promise<T> {
      if (storage.getStore()) {
        throw new DurableTransactionFailureError('nested write transactions are not supported')
      }
      const leases = await acquireLocks(identity)
      const transaction: ActiveTransaction = {
        id: transactionToken(),
        nonce: transactionToken(),
        active: true,
        decided: false,
        issuedDecision: null,
        staged: new Map(),
        savepoints: new Map(),
        nextSavepoint: 0,
        participants: [],
        cancelledParticipants: [],
        participantIds: new Set(),
        nextParticipant: 0
      }
      let renewalFailure: unknown
      let renewalFailed = false
      let renewal = Promise.resolve()
      const intervalMs = options.renewalIntervalMs ?? 0
      const timer = intervalMs > 0 ? setInterval(() => {
        renewal = renewal.then(() => renewAll(leases)).catch((error) => {
          if (!renewalFailed) renewalFailure = error
          renewalFailed = true
        })
      }, intervalMs) : undefined
      timer?.unref()

      function assertOpen(): void {
        if (!transaction.active) throw new DurableTransactionFailureError('transaction is closed')
        if (transaction.decided) throw new DurableTransactionFailureError('transaction already has a terminal decision')
      }

      const control: ApplicationWriteTransaction = {
        revalidateLease() {
          assertOpen()
          return renewAll(leases)
        },
        savepoint() {
          assertOpen()
          const ordinal = ++transaction.nextSavepoint
          const savepoint = Object.freeze({
            [SAVEPOINT_MARKER]: Object.freeze({
              transactionId: transaction.id,
              ordinal,
              nonce: transaction.nonce
            })
          }) as RuntimeSavepoint
          transaction.savepoints.set(savepoint, {
            ordinal,
            staged: new Map(transaction.staged),
            participantCount: transaction.participants.length
          })
          return savepoint
        },
        rollbackTo(savepoint) {
          assertOpen()
          const runtime = savepoint as RuntimeSavepoint
          const marker = runtime?.[SAVEPOINT_MARKER]
          const state = transaction.savepoints.get(savepoint)
          if (!marker
            || marker.transactionId !== transaction.id
            || marker.nonce !== transaction.nonce
            || !state
            || state.ordinal !== marker.ordinal) {
            throw new DurableTransactionFailureError('savepoint is not owned by this transaction or was already used')
          }
          transaction.staged = new Map(state.staged)
          transaction.cancelledParticipants.push(
            ...transaction.participants.splice(state.participantCount)
          )
          for (const [candidate, candidateState] of transaction.savepoints) {
            if (candidateState.ordinal >= state.ordinal) transaction.savepoints.delete(candidate)
          }
        },
        enlist(participant) {
          assertOpen()
          const idKey = participantIdKey(participant)
          if (transaction.participantIds.has(idKey)) {
            throw new DurableTransactionFailureError(
              'transaction participantId is already enlisted'
            )
          }
          if (usedParticipants.has(participant)) {
            throw new DurableTransactionFailureError(
              'transaction participant object is one-shot and was already enlisted'
            )
          }
          transaction.participantIds.add(idKey)
          usedParticipants.add(participant)
          transaction.participants.push({
            participant,
            participantId: participant.participantId,
            ordinal: ++transaction.nextParticipant,
            state: 'enlisted'
          })
        },
        commit<U>(value: U): ApplicationTransactionDecision<U> {
          assertOpen()
          transaction.decided = true
          const decision = Object.freeze({
            kind: 'commit',
            value,
            [DECISION_MARKER]: Object.freeze({
              transactionId: transaction.id,
              nonce: transaction.nonce
            })
          }) as RuntimeDecision<U>
          transaction.issuedDecision = decision as ApplicationTransactionDecision<unknown>
          return decision
        },
        abort(error: unknown): ApplicationTransactionDecision<never> {
          assertOpen()
          transaction.decided = true
          const decision = Object.freeze({
            kind: 'abort',
            error,
            [DECISION_MARKER]: Object.freeze({
              transactionId: transaction.id,
              nonce: transaction.nonce
            })
          }) as RuntimeDecision<never>
          transaction.issuedDecision = decision
          return decision
        }
      }

      const participantContext: ApplicationTransactionParticipantContext = Object.freeze({
        revalidateLease: () => renewAll(leases)
      })

      async function rollbackParticipants(entries: readonly ParticipantEntry[]): Promise<Error | null> {
        let firstFailure: Error | null = null
        for (const entry of [...entries].sort((left, right) => right.ordinal - left.ordinal)) {
          if (entry.state === 'rollback-started'
            || entry.state === 'rolled-back'
            || entry.state === 'finalize-started'
            || entry.state === 'finalized') continue
          try {
            // Cleanup is permitted only while the same transaction leases are
            // demonstrably still owned. The participant may revalidate again
            // immediately before its own final filesystem operation.
            await renewAll(leases)
            entry.state = 'rollback-started'
            await entry.participant.rollback(participantContext)
            entry.state = 'rolled-back'
          } catch (error) {
            firstFailure ??= asError(error)
            // Lease loss or an uncertain publication is a recovery boundary,
            // not permission to guess and overwrite potentially committed data.
            if (participantPublicationIsUncertain(error)) break
          }
        }
        return firstFailure
      }

      async function finalizeParticipants(entries: readonly ParticipantEntry[]): Promise<void> {
        for (const entry of [...entries].sort((left, right) => right.ordinal - left.ordinal)) {
          if (entry.state !== 'published') continue
          entry.state = 'finalize-started'
          try {
            await renewAll(leases)
            await entry.participant.finalize(participantContext)
            entry.state = 'finalized'
          } catch {
            // The JSON WAL is already the durable commit decision. Participant
            // journal cleanup is intentionally best-effort and recoverable.
          }
        }
      }

      let failure: unknown
      let failed = false
      let committed = false
      let result: T | undefined
      try {
        store.recoverPending()
        let decision: RuntimeDecision<T> | undefined
        try {
          decision = await storage.run(transaction, () => callback(control)) as RuntimeDecision<T>
        } finally {
          // Participant publication/rollback is transaction-host work, not a
          // continuation of the Application callback's writable ALS context.
          transaction.active = false
        }
        const marker = decision?.[DECISION_MARKER]
        if (!decision
          || decision !== transaction.issuedDecision
          || !marker
          || marker.transactionId !== transaction.id
          || marker.nonce !== transaction.nonce
          || (decision.kind !== 'commit' && decision.kind !== 'abort')) {
          throw new DurableTransactionDecisionRequiredError()
        }
        if (decision.kind === 'abort') throw asError(decision.error)
        if (timer) clearInterval(timer)
        await renewal
        if (renewalFailed) throw asError(renewalFailure)

        const cancelledFailure = await rollbackParticipants(transaction.cancelledParticipants)
        if (cancelledFailure) throw cancelledFailure
        if ((transaction.participants.length > 0 || transaction.cancelledParticipants.length > 0)
          && transaction.staged.size === 0) {
          throw new DurableTransactionFailureError(
            'a transaction with an external participant must stage at least one durable document'
          )
        }

        // Final owner/lease check before external publication. Every
        // participant then publishes in enlistment order.
        await renewAll(leases)
        for (const entry of transaction.participants) {
          entry.state = 'publish-started'
          await entry.participant.publish(participantContext)
          entry.state = 'published'
        }

        // External bytes must be present before the JSON WAL can make their
        // corresponding state/ledger truth durable.
        await renewAll(leases)
        if (transaction.staged.size > 0) {
          await store.commit(
            [...transaction.staged].map(([relativePath, document]) => ({
              relativePath,
              value: document.value
            })),
            () => renewAll(leases)
          )
        }
        result = decision.value
        committed = true
        await finalizeParticipants(transaction.participants)
      } catch (error) {
        failure = error
        failed = true
        if (timer) clearInterval(timer)
        await renewal
        if (renewalFailed) failure = renewalFailure
        if (!committed
          && !participantPublicationIsUncertain(failure)
          && (transaction.participants.length > 0 || transaction.cancelledParticipants.length > 0)) {
          const rollbackFailure = await rollbackParticipants([
            ...transaction.participants,
            ...transaction.cancelledParticipants
          ])
          if (rollbackFailure && participantPublicationIsUncertain(rollbackFailure)) {
            failure = rollbackFailure
          }
        }
      } finally {
        if (timer) clearInterval(timer)
        transaction.active = false
        transaction.staged.clear()
        transaction.savepoints.clear()
        transaction.participants.length = 0
        transaction.cancelledParticipants.length = 0
        transaction.participantIds.clear()
        const releaseFailure = await releaseAll(leases)
        // Once a WAL has committed, failure to remove an already-owned lease
        // must not turn durable success into a false command failure.
        if (!committed && !failed && releaseFailure) {
          failure = releaseFailure
          failed = true
        }
      }
      if (failed) throw asError(failure)
      return result as T
    }
  }

  return {
    store,
    persist,
    transactions,
    async recover(identity) {
      assertTransactionIdentity(identity)
      if (!store.recoveryRequired()) return emptyRecovery()
      const leases = await acquireLocks(identity)
      let completed = false
      let result: DurableRecoveryResult | undefined
      let failure: unknown
      try {
        await renewAll(leases)
        result = store.recoverPending()
        completed = true
      } catch (error) {
        failure = error
      } finally {
        const releaseFailure = await releaseAll(leases)
        if (!completed && !failure && releaseFailure) failure = releaseFailure
      }
      if (failure) throw asError(failure)
      return result as DurableRecoveryResult
    }
  }
}

export {
  DURABLE_WAL_FORMAT,
  DURABLE_WAL_SCHEMA_VERSION,
  DurableCorruptionError,
  DurableRecoveryRequiredError,
  DurableStateStore
} from './durable-wal.js'
export type {
  DurableCommitResult,
  DurableDocumentWrite,
  DurableJsonSchema,
  DurableReadResult,
  DurableRecoveryResult,
  DurableSchemaResolver,
  DurableStateStoreOptions,
  DurableValidationResult
} from './durable-wal.js'
