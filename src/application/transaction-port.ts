import type { Sha256Identifier, WriteCommandKind } from '../contracts/index.js'
import type { MaybePromise } from './ports.js'

declare const transactionSavepointBrand: unique symbol
declare const transactionDecisionBrand: unique symbol

/**
 * Opaque savepoint owned by one active write transaction. Callers cannot
 * inspect or manufacture one and adapters must reject cross-transaction use.
 */
export type ApplicationTransactionSavepoint = {
  readonly [transactionSavepointBrand]: true
}

/**
 * A write transaction is keyed by a host-neutral identity. Worktree keys are
 * full sha256 path keys produced by shared identity policy, never raw paths or
 * host-specific locators. `hub-global` is the sole non-hash key.
 */
type ApplicationTransactionIdentityFields = {
  hostId: string
  commandKind: WriteCommandKind
  requestId: string
}

export type ApplicationTransactionIdentity = ApplicationTransactionIdentityFields & (
  | { scope: 'hub-global'; key: 'hub-global' }
  | { scope: 'worktree'; key: Sha256Identifier }
)

export const APPLICATION_TRANSACTION_ERROR_CODES = [
  'LOCK_BUSY',
  'LOCK_NOT_OWNED',
  'STATE_CORRUPT',
  'SNAPSHOT_INVALID',
  'RUNTIME_ASSET_INVALID',
  'MATERIALIZATION_MARKER_INVALID',
  'LEGACY_PLAN_STALE',
  'UNSUPPORTED_LAYOUT',
  'PORT_FAILURE'
] as const

export type ApplicationTransactionErrorCode =
  (typeof APPLICATION_TRANSACTION_ERROR_CODES)[number]

/**
 * Structured failures thrown by the transaction adapter. `LOCK_NOT_OWNED`
 * includes lease loss immediately before publication and therefore guarantees
 * that no staged document was published.
 */
export interface ApplicationTransactionError extends Error {
  readonly code: ApplicationTransactionErrorCode
  readonly retryable: boolean
  readonly details?: Readonly<Record<string, string | number | boolean | null>>
}

const trustedApplicationTransactionErrors = new WeakSet<object>()

/**
 * Shared base for errors issued by trusted transaction/storage adapters.
 * Registration is held in module-private identity state, so copying the
 * public error fields onto an ordinary object or Error cannot spoof one.
 */
export abstract class ApplicationTransactionErrorBase extends Error implements ApplicationTransactionError {
  abstract readonly code: ApplicationTransactionErrorCode
  abstract readonly retryable: boolean
  readonly details?: Readonly<Record<string, string | number | boolean | null>>

  protected constructor(
    message: string,
    details?: Readonly<Record<string, string | number | boolean | null>>
  ) {
    super(message)
    this.details = details
    trustedApplicationTransactionErrors.add(this)
  }
}

export function isApplicationTransactionError(value: unknown): value is ApplicationTransactionError {
  return typeof value === 'object'
    && value !== null
    && trustedApplicationTransactionErrors.has(value)
}

export type ApplicationTransactionDecision<T> =
  | {
    readonly kind: 'commit'
    readonly value: T
    readonly [transactionDecisionBrand]: true
  }
  | {
    readonly kind: 'abort'
    readonly error: unknown
    readonly [transactionDecisionBrand]: true
  }

/**
 * The transaction adapter keeps every participant under the same lease as the
 * durable documents. Participants receive only an owner revalidation hook;
 * they never receive a host path, lock token, or persistence primitive.
 */
export type ApplicationTransactionParticipantContext = Readonly<{
  revalidateLease(): MaybePromise<void>
}>

/**
 * One-shot external publication enlisted by a write transaction. The opaque
 * participant id is diagnostic/identity data only and must be portable (it is
 * never interpreted as a filesystem path). Implementations must leave their
 * own recovery journal intact when publication is uncertain.
 */
export interface ApplicationTransactionParticipant {
  readonly participantId: string
  publish(context: ApplicationTransactionParticipantContext): MaybePromise<void>
  rollback(context: ApplicationTransactionParticipantContext): MaybePromise<void>
  /** Cleanup only; lease loss must leave the recovery journal intact. */
  finalize(context: ApplicationTransactionParticipantContext): MaybePromise<void>
}

/**
 * Transaction control deliberately does not expose a persistence or process
 * primitive. Local composition supplies one AsyncLocal transaction-aware
 * PersistPort to every existing adapter captured by the Application.
 */
export interface ApplicationWriteTransaction {
  /**
   * Revalidate every lease owned by this transaction. External recovery code
   * must call this immediately before and after each filesystem mutation so a
   * paused process cannot keep modifying a worktree after its lease expires.
   */
  revalidateLease(): MaybePromise<void>
  savepoint(): ApplicationTransactionSavepoint
  rollbackTo(savepoint: ApplicationTransactionSavepoint): void
  enlist(participant: ApplicationTransactionParticipant): void
  commit<T>(value: T): ApplicationTransactionDecision<T>
  abort(error: unknown): ApplicationTransactionDecision<never>
}

/**
 * Only an explicit `transaction.commit(value)` decision may publish staged
 * writes. A plain callback return, throw, or explicit abort leaves no partial
 * state. This lets the Application roll handler writes back to a savepoint,
 * stage a durable failure ledger/audit outcome, and then commit that outcome.
 *
 * Implementations acquire a hub-global lease for every write. Worktree writes
 * then acquire their full path-key lease in the fixed hub-global -> worktree
 * order and release in reverse. Both owner identities and lease expirations
 * are revalidated before the WAL may publish any document.
 */
export interface ApplicationTransactionPort {
  withWriteTransaction<T>(
    identity: ApplicationTransactionIdentity,
    callback: (
      transaction: ApplicationWriteTransaction
    ) => ApplicationTransactionDecision<T> | Promise<ApplicationTransactionDecision<T>>
  ): Promise<T>
}
