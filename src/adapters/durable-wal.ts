import path from 'node:path'
import { ApplicationTransactionErrorBase } from '../application/transaction-port.js'
import {
  DurableFileRoot,
  DurableLimitError,
  decodeUtf8Fatal,
  type DurableCheckpoint,
  normalizeDurableRelative,
  portableDurablePathKey,
  sha256Identifier
} from './durable-files.js'

export const DURABLE_WAL_SCHEMA_VERSION = 1 as const
export const DURABLE_WAL_FORMAT = 'skill-graft.multi-document-wal/v1' as const
const DEFAULT_JOURNAL_DIRECTORY = '.skill-graft-transactions'
const WAL_SUFFIX = '.wal.json'
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export type DurableValidationResult =
  | { valid: true }
  | { valid: false; message: string }

export type DurableJsonSchema = {
  name: string
  /** Read-side carrier validation; may admit a bounded future-version descriptor for inspection. */
  validate(value: unknown): DurableValidationResult
  /** Optional stricter publication validation. Durable writes and WAL recovery always use it when present. */
  validateWrite?(value: unknown): DurableValidationResult
}

export type DurableSchemaResolver = (relativePath: string) => DurableJsonSchema | undefined

export type DurableDocumentWrite = {
  relativePath: string
  value: unknown
}

export type DurableReadResult<T> = {
  value: T
  source: 'primary' | 'backup-recovered' | 'fallback'
}

export type DurableRecoveryResult = {
  recoveredTransactions: number
  rolledBackTransactions: number
  finalizedTransactions: number
}

export type DurableCommitResult = {
  transactionId: string
  documentCount: number
  recoveredAfterSynchronousFailure: boolean
}

export type DurableStateStoreOptions = {
  root: string
  schemaFor: DurableSchemaResolver
  checkpoint?: DurableCheckpoint
  transactionDirectory?: string
  token?: () => string
  limits?: Partial<DurableStateLimits>
}

export type DurableStateLimits = {
  maxDocumentBytes: number
  maxWalBytes: number
  maxDocumentsPerTransaction: number
  maxJournalEntries: number
}

const DEFAULT_LIMITS: DurableStateLimits = {
  maxDocumentBytes: 16 * 1024 * 1024,
  maxWalBytes: 8 * 1024 * 1024,
  maxDocumentsPerTransaction: 2_048,
  maxJournalEntries: 8_192
}

type Candidate =
  | { status: 'missing' }
  | { status: 'invalid'; message: string }
  | { status: 'valid'; bytes: Buffer; value: unknown; sha256: `sha256:${string}` }

type WalEntry = {
  relativePath: string
  temporaryPath: string
  backupPath: string
  newSha256: `sha256:${string}`
  previousSha256: `sha256:${string}` | null
  hadPrimary: boolean
}

type WalDocument = {
  format: typeof DURABLE_WAL_FORMAT
  schemaVersion: typeof DURABLE_WAL_SCHEMA_VERSION
  transactionId: string
  phase: 'prepared'
  entries: WalEntry[]
}

export class DurableCorruptionError extends ApplicationTransactionErrorBase {
  readonly code = 'STATE_CORRUPT' as const
  readonly retryable = false

  constructor(message: string) {
    super(message)
    this.name = 'DurableCorruptionError'
  }
}

export class DurableRecoveryRequiredError extends ApplicationTransactionErrorBase {
  readonly code = 'PORT_FAILURE' as const
  readonly retryable = true

  constructor() {
    super('durable transaction recovery is required before reading live state')
    this.name = 'DurableRecoveryRequiredError'
  }
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function validationMessage(schema: DurableJsonSchema, value: unknown, write = false): string | null {
  let result: DurableValidationResult
  try {
    result = (write ? schema.validateWrite ?? schema.validate : schema.validate)(value)
  } catch (error) {
    return `${schema.name}: ${error instanceof Error ? error.message : String(error)}`
  }
  return result.valid ? null : `${schema.name}: ${result.message}`
}

function backupRelative(relativePath: string): string {
  const normalized = normalizeDurableRelative(relativePath)
  const directory = path.posix.dirname(normalized)
  const base = path.posix.basename(normalized)
  return normalizeDurableRelative(path.posix.join(
    directory === '.' ? '' : directory,
    `.${base}.skill-graft.bak`
  ))
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export class DurableStateStore {
  readonly root: string
  readonly journalRelative: string
  private readonly files: DurableFileRoot
  private readonly schemaFor: DurableSchemaResolver
  private readonly checkpoint: DurableCheckpoint
  private readonly limits: DurableStateLimits

  constructor(options: DurableStateStoreOptions) {
    this.root = path.resolve(options.root)
    this.files = new DurableFileRoot(options)
    this.schemaFor = options.schemaFor
    this.checkpoint = options.checkpoint || (() => {})
    this.limits = { ...DEFAULT_LIMITS, ...options.limits }
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new DurableLimitError(`durable ${name} limit is invalid`)
      }
    }
    this.journalRelative = normalizeDurableRelative(
      options.transactionDirectory || DEFAULT_JOURNAL_DIRECTORY
    )
    // Deliberately no mkdir, repair, or cleanup here. Query-only host
    // construction must leave an absent data root byte-for-byte absent.
    this.inspectJournal(false)
  }

  relativePath(file: string): string {
    return this.files.relative(file)
  }

  private schema(relativePath: string): DurableJsonSchema {
    const normalized = normalizeDurableRelative(relativePath)
    const schema = this.schemaFor(normalized)
    if (!schema) throw new Error(`no durable schema registered for ${normalized}`)
    return schema
  }

  private candidate(relativePath: string, schemaPath: string, write = false): Candidate {
    let file: ReturnType<DurableFileRoot['read']>
    try {
      file = this.files.read(relativePath, this.limits.maxDocumentBytes)
    } catch (error) {
      // Size is document validity, so a bounded valid backup may still be the
      // read truth. Linked/reparse/escape faults remain exceptions and never
      // downgrade into a fallback path.
      if (error instanceof DurableLimitError) {
        return { status: 'invalid', message: error.message }
      }
      throw error
    }
    if (file.status === 'missing') return file
    let text: string
    try {
      text = decodeUtf8Fatal(file.bytes, relativePath)
    } catch (error) {
      return { status: 'invalid', message: error instanceof Error ? error.message : String(error) }
    }
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      return { status: 'invalid', message: 'document is not valid JSON' }
    }
    const invalid = validationMessage(this.schema(schemaPath), value, write)
    if (invalid) return { status: 'invalid', message: invalid }
    return { status: 'valid', bytes: file.bytes, value, sha256: file.sha256 }
  }

  private serialize(relativePath: string, value: unknown): Buffer {
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
    const bytes = Buffer.from(`${serialized}\n`, 'utf8')
    if (bytes.length > this.limits.maxDocumentBytes) {
      throw new DurableLimitError(
        `serialized durable document exceeds the ${this.limits.maxDocumentBytes} byte limit`
      )
    }
    const persisted = JSON.parse(serialized) as unknown
    const invalid = validationMessage(this.schema(relativePath), persisted, true)
    if (invalid) {
      throw new DurableCorruptionError(`refusing invalid ${relativePath}: ${invalid}`)
    }
    return bytes
  }

  private inspectJournal(throwWhenPending: boolean): ReturnType<DurableFileRoot['list']> {
    const entries = this.files.list(this.journalRelative, this.limits.maxJournalEntries)
    if (throwWhenPending && entries.length > 0) throw new DurableRecoveryRequiredError()
    return entries
  }

  assertReadable(): void {
    this.inspectJournal(true)
  }

  recoveryRequired(): boolean {
    return this.inspectJournal(false).length > 0
  }

  read<T>(
    relativePath: string,
    options: { fallback?: T } = {}
  ): DurableReadResult<T> {
    this.assertReadable()
    const normalized = normalizeDurableRelative(relativePath)
    const primary = this.candidate(normalized, normalized)
    if (primary.status === 'valid') return { value: primary.value as T, source: 'primary' }
    const backupPath = backupRelative(normalized)
    const backup = this.candidate(backupPath, normalized)
    if (backup.status === 'valid') {
      return { value: backup.value as T, source: 'backup-recovered' }
    }
    if (primary.status === 'missing' && backup.status === 'missing'
      && Object.prototype.hasOwnProperty.call(options, 'fallback')) {
      const serialized = this.serialize(normalized, options.fallback)
      return {
        value: JSON.parse(decodeUtf8Fatal(serialized, `${normalized} fallback`)) as T,
        source: 'fallback'
      }
    }
    const primaryReason = primary.status === 'invalid' ? primary.message : primary.status
    const backupReason = backup.status === 'invalid' ? backup.message : backup.status
    throw new DurableCorruptionError(
      `no valid primary or backup for ${normalized} (primary=${primaryReason}; backup=${backupReason})`
    )
  }

  readOptional<T>(relativePath: string): DurableReadResult<T> | null {
    this.assertReadable()
    const normalized = normalizeDurableRelative(relativePath)
    const primary = this.candidate(normalized, normalized)
    if (primary.status === 'valid') return { value: primary.value as T, source: 'primary' }
    const backup = this.candidate(backupRelative(normalized), normalized)
    if (backup.status === 'valid') {
      return { value: backup.value as T, source: 'backup-recovered' }
    }
    if (primary.status === 'missing' && backup.status === 'missing') return null
    const primaryReason = primary.status === 'invalid' ? primary.message : primary.status
    const backupReason = backup.status === 'invalid' ? backup.message : backup.status
    throw new DurableCorruptionError(
      `no valid primary or backup for ${normalized} (primary=${primaryReason}; backup=${backupReason})`
    )
  }

  readText(relativePath: string): string | null {
    this.assertReadable()
    return this.files.readText(normalizeDurableRelative(relativePath), this.limits.maxDocumentBytes)
  }

  private transactionTemporary(transactionId: string, index: number): string {
    return normalizeDurableRelative(path.posix.join(
      this.journalRelative,
      `.txn-${transactionId}-${index}.next.tmp`
    ))
  }

  private transactionAuxiliary(
    transactionId: string,
    index: number,
    purpose: 'backup' | 'final-backup' | 'restore'
  ): string {
    return normalizeDurableRelative(path.posix.join(
      this.journalRelative,
      `.txn-${transactionId}-${index}.${purpose}.tmp`
    ))
  }

  private replaceFromJournal(
    temporaryPath: string,
    targetPath: string,
    bytes: Buffer,
    emitCheckpoint: boolean
  ): void {
    this.files.removeIfPlain(temporaryPath)
    this.files.writeExclusive(
      temporaryPath,
      bytes,
      emitCheckpoint,
      true,
      this.limits.maxDocumentBytes
    )
    try {
      this.files.replace(temporaryPath, targetPath, emitCheckpoint)
    } catch (error) {
      this.files.removeIfPlain(temporaryPath)
      throw error
    }
  }

  private walRelative(transactionId: string): string {
    return normalizeDurableRelative(path.posix.join(
      this.journalRelative,
      `${transactionId}${WAL_SUFFIX}`
    ))
  }

  private validateWal(value: unknown, expectedId: string): WalDocument {
    if (!value || typeof value !== 'object' || !exactKeys(value, [
      'entries', 'format', 'phase', 'schemaVersion', 'transactionId'
    ])) {
      throw new DurableCorruptionError('transaction WAL has an invalid schema')
    }
    const candidate = value as Partial<WalDocument>
    if (candidate.format !== DURABLE_WAL_FORMAT
      || candidate.schemaVersion !== DURABLE_WAL_SCHEMA_VERSION
      || candidate.phase !== 'prepared'
      || candidate.transactionId !== expectedId
      || !SAFE_TOKEN.test(expectedId)
      || !Array.isArray(candidate.entries)
      || candidate.entries.length === 0
      || candidate.entries.length > this.limits.maxDocumentsPerTransaction) {
      throw new DurableCorruptionError('transaction WAL identity is invalid')
    }
    const entries: WalEntry[] = []
    const keys = new Set<string>()
    for (let index = 0; index < candidate.entries.length; index += 1) {
      const raw = candidate.entries[index]
      if (!raw || typeof raw !== 'object' || !exactKeys(raw, [
        'backupPath', 'hadPrimary', 'newSha256', 'previousSha256', 'relativePath', 'temporaryPath'
      ])) {
        throw new DurableCorruptionError('transaction WAL entry has an invalid schema')
      }
      const entry = raw as WalEntry
      const normalized: WalEntry = {
        relativePath: normalizeDurableRelative(entry.relativePath),
        temporaryPath: normalizeDurableRelative(entry.temporaryPath),
        backupPath: normalizeDurableRelative(entry.backupPath),
        newSha256: entry.newSha256,
        previousSha256: entry.previousSha256,
        hadPrimary: entry.hadPrimary
      }
      if (normalized.temporaryPath !== this.transactionTemporary(expectedId, index)
        || normalized.backupPath !== backupRelative(normalized.relativePath)
        || !SHA256_PATTERN.test(normalized.newSha256)
        || !(normalized.previousSha256 === null || SHA256_PATTERN.test(normalized.previousSha256))
        || typeof normalized.hadPrimary !== 'boolean'
        || normalized.hadPrimary !== (normalized.previousSha256 !== null)) {
        throw new DurableCorruptionError('transaction WAL entry is inconsistent')
      }
      const key = portableDurablePathKey(normalized.relativePath)
      if (keys.has(key)) throw new DurableCorruptionError('transaction WAL contains a path collision')
      keys.add(key)
      this.files.absolute(normalized.relativePath, 'transaction target')
      this.files.absolute(normalized.temporaryPath, 'transaction temporary')
      this.files.absolute(normalized.backupPath, 'transaction backup')
      entries.push(normalized)
    }
    return {
      format: DURABLE_WAL_FORMAT,
      schemaVersion: DURABLE_WAL_SCHEMA_VERSION,
      transactionId: expectedId,
      phase: 'prepared',
      entries
    }
  }

  private readWal(fileName: string): WalDocument {
    const match = fileName.match(/^([A-Za-z0-9][A-Za-z0-9._-]{0,63})\.wal\.json$/)
    if (!match) throw new DurableCorruptionError(`unexpected transaction journal artifact: ${fileName}`)
    const relative = this.walRelative(match[1])
    const file = this.files.read(relative, this.limits.maxWalBytes)
    if (file.status === 'missing') throw new DurableCorruptionError('transaction WAL disappeared during recovery')
    let value: unknown
    try {
      value = JSON.parse(decodeUtf8Fatal(file.bytes, relative))
    } catch (error) {
      throw new DurableCorruptionError(
        `transaction WAL cannot be decoded: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    return this.validateWal(value, match[1])
  }

  private updateBackup(
    transactionId: string,
    index: number,
    entry: WalEntry,
    bytes: Buffer,
    emitCheckpoint: boolean
  ): void {
    this.replaceFromJournal(
      this.transactionAuxiliary(transactionId, index, 'final-backup'),
      entry.backupPath,
      bytes,
      emitCheckpoint
    )
  }

  private finalizeForward(wal: WalDocument, disposition: 'forward' | 'finalized', emitCheckpoint: boolean): 'forward' | 'finalized' {
    for (let index = 0; index < wal.entries.length; index += 1) {
      const entry = wal.entries[index]
      const target = this.candidate(entry.relativePath, entry.relativePath, true)
      if (target.status !== 'valid' || target.sha256 !== entry.newSha256) {
        throw new DurableCorruptionError(`cannot finalize invalid target ${entry.relativePath}`)
      }
      this.updateBackup(wal.transactionId, index, entry, target.bytes, emitCheckpoint)
      this.files.removeIfPlain(entry.temporaryPath)
    }
    for (const entry of wal.entries) {
      const target = this.candidate(entry.relativePath, entry.relativePath, true)
      const backup = this.candidate(entry.backupPath, entry.relativePath, true)
      if (target.status !== 'valid' || target.sha256 !== entry.newSha256
        || backup.status !== 'valid' || backup.sha256 !== entry.newSha256) {
        throw new DurableCorruptionError(`forward verification failed for ${entry.relativePath}`)
      }
    }
    const walPath = this.walRelative(wal.transactionId)
    try {
      this.files.removeIfPlain(walPath)
    } catch (error) {
      // An unlink can succeed even when the following directory fsync reports
      // an error. The fully verified in-memory target+backup set is then the
      // only truthful outcome; do not manufacture a false command failure.
      if (this.files.read(walPath, this.limits.maxWalBytes).status !== 'missing') throw error
    }
    return disposition
  }

  private recoverWal(fileName: string, emitCheckpoint: boolean): 'forward' | 'rollback' | 'finalized' {
    const wal = this.readWal(fileName)
    const states = wal.entries.map((entry) => ({
      entry,
      target: this.candidate(entry.relativePath, entry.relativePath, true),
      temporary: this.candidate(entry.temporaryPath, entry.relativePath, true)
    }))
    const allPublished = states.every(({ entry, target }) => (
      target.status === 'valid' && target.sha256 === entry.newSha256
    ))
    if (allPublished) return this.finalizeForward(wal, 'finalized', emitCheckpoint)

    const canForward = states.every(({ entry, target, temporary }) => (
      target.status === 'valid' && target.sha256 === entry.newSha256
    ) || (
      temporary.status === 'valid' && temporary.sha256 === entry.newSha256
    ))
    if (canForward) {
      for (const { entry, target } of states) {
        if (target.status === 'valid' && target.sha256 === entry.newSha256) continue
        this.files.replace(entry.temporaryPath, entry.relativePath, emitCheckpoint)
      }
      return this.finalizeForward(wal, 'forward', emitCheckpoint)
    }

    for (let index = 0; index < states.length; index += 1) {
      const { entry, target } = states[index]
      if (entry.hadPrimary) {
        const backup = this.candidate(entry.backupPath, entry.relativePath, true)
        if (backup.status !== 'valid' || backup.sha256 !== entry.previousSha256) {
          throw new DurableCorruptionError(`rollback backup is unavailable for ${entry.relativePath}`)
        }
        if (target.status === 'valid'
          && target.sha256 !== entry.newSha256
          && target.sha256 !== entry.previousSha256) {
          throw new DurableCorruptionError(`rollback target changed unexpectedly: ${entry.relativePath}`)
        }
        this.replaceFromJournal(
          this.transactionAuxiliary(wal.transactionId, index, 'restore'),
          entry.relativePath,
          backup.bytes,
          emitCheckpoint
        )
      } else if (target.status !== 'missing') {
        if (target.status !== 'valid' || target.sha256 !== entry.newSha256) {
          throw new DurableCorruptionError(`rollback target changed unexpectedly: ${entry.relativePath}`)
        }
        this.files.removeIfPlain(entry.relativePath)
      }
      this.files.removeIfPlain(entry.temporaryPath)
    }
    this.files.removeIfPlain(this.walRelative(wal.transactionId))
    return 'rollback'
  }

  private classifyJournal(
    entries: ReturnType<DurableFileRoot['list']>
  ): { walNames: string[]; temporaryPaths: string[] } {
    const walNames: string[] = []
    const temporaryPaths: string[] = []
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new DurableCorruptionError(`unexpected transaction journal entry: ${entry.name}`)
      }
      if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.wal\.json$/.test(entry.name)) {
        walNames.push(entry.name)
        continue
      }
      const recognized = /^\.txn-[A-Za-z0-9][A-Za-z0-9._-]{0,63}-\d+\.next\.tmp$/.test(entry.name)
        || /^\.txn-[A-Za-z0-9][A-Za-z0-9._-]{0,63}-\d+\.(?:backup|final-backup|restore)\.tmp$/.test(entry.name)
        || /^\.[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.wal\.json\.skill-graft-wal-[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.tmp$/.test(entry.name)
      if (!recognized) throw new DurableCorruptionError(`unexpected transaction journal artifact: ${entry.name}`)
      temporaryPaths.push(path.posix.join(this.journalRelative, entry.name))
    }
    return { walNames, temporaryPaths }
  }

  recoverPending(): DurableRecoveryResult {
    const result: DurableRecoveryResult = {
      recoveredTransactions: 0,
      rolledBackTransactions: 0,
      finalizedTransactions: 0
    }
    const classified = this.classifyJournal(
      this.files.list(this.journalRelative, this.limits.maxJournalEntries)
    )
    const walNames = classified.walNames.sort((left, right) => (
      Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'))
    ))
    // Parse and schema-check every WAL before any recovery mutates a target.
    // A later invalid WAL can therefore never be discovered after an earlier
    // one has already been forwarded.
    for (const fileName of walNames) this.readWal(fileName)
    for (const fileName of walNames) {
      const disposition = this.recoverWal(fileName, false)
      result.recoveredTransactions += 1
      if (disposition === 'rollback') result.rolledBackTransactions += 1
      if (disposition === 'finalized') result.finalizedTransactions += 1
    }
    for (const temporaryPath of classified.temporaryPaths) {
      this.files.removeIfPlain(temporaryPath)
    }
    return result
  }

  async commit(
    documents: readonly DurableDocumentWrite[],
    beforeWalPublish?: () => void | Promise<void>
  ): Promise<DurableCommitResult> {
    if (!Array.isArray(documents) || documents.length === 0) {
      throw new Error('durable transaction requires at least one document')
    }
    if (documents.length > this.limits.maxDocumentsPerTransaction) {
      throw new DurableLimitError(
        `durable transaction exceeds the ${this.limits.maxDocumentsPerTransaction} document limit`
      )
    }
    this.recoverPending()
    this.files.ensureDirectory(this.journalRelative)
    const transactionId = this.files.token()
    const normalized = documents.map((document) => ({
      relativePath: normalizeDurableRelative(document.relativePath),
      value: document.value
    })).sort((left, right) => Buffer.from(left.relativePath, 'utf8').compare(Buffer.from(right.relativePath, 'utf8')))
    const keys = new Set<string>()
    for (const document of normalized) {
      const key = portableDurablePathKey(document.relativePath)
      if (keys.has(key)) throw new Error('durable transaction contains a portable path collision')
      keys.add(key)
    }

    const entries: WalEntry[] = []
    const prepared: string[] = []
    let walPublished = false
    let walPublicationUncertain = false
    try {
      for (let index = 0; index < normalized.length; index += 1) {
        const document = normalized[index]
        const primary = this.candidate(document.relativePath, document.relativePath, true)
        const backupPath = backupRelative(document.relativePath)
        const backup = this.candidate(backupPath, document.relativePath, true)
        let previous: Extract<Candidate, { status: 'valid' }> | null = null
        if (primary.status === 'valid') {
          previous = primary
          this.replaceFromJournal(
            this.transactionAuxiliary(transactionId, index, 'backup'),
            backupPath,
            primary.bytes,
            true
          )
        } else if (backup.status === 'valid') {
          previous = backup
        } else if (primary.status === 'invalid' || backup.status === 'invalid') {
          const primaryReason = primary.status === 'invalid' ? primary.message : primary.status
          const backupReason = backup.status === 'invalid' ? backup.message : backup.status
          throw new DurableCorruptionError(
            `cannot prepare ${document.relativePath} (primary=${primaryReason}; backup=${backupReason})`
          )
        }
        const nextBytes = this.serialize(document.relativePath, document.value)
        const temporaryPath = this.transactionTemporary(transactionId, index)
        this.files.writeExclusive(temporaryPath, nextBytes)
        prepared.push(temporaryPath)
        entries.push({
          relativePath: document.relativePath,
          temporaryPath,
          backupPath,
          newSha256: sha256Identifier(nextBytes),
          previousSha256: previous?.sha256 || null,
          hadPrimary: previous !== null
        })
      }
      const wal: WalDocument = {
        format: DURABLE_WAL_FORMAT,
        schemaVersion: DURABLE_WAL_SCHEMA_VERSION,
        transactionId,
        phase: 'prepared',
        entries
      }
      const walPath = this.walRelative(transactionId)
      const walBytes = jsonBytes(wal)
      if (walBytes.length > this.limits.maxWalBytes) {
        throw new DurableLimitError(`transaction WAL exceeds the ${this.limits.maxWalBytes} byte limit`)
      }
      // All document and backup bytes are already flushed. Lease ownership is
      // checked here, at the last await boundary before the durable WAL commit
      // decision and immediate publication.
      await beforeWalPublish?.()
      try {
        this.files.atomicWrite(walPath, walBytes, 'wal', true)
        walPublished = true
      } catch (error) {
        let observed: ReturnType<DurableFileRoot['read']>
        try {
          observed = this.files.read(walPath, this.limits.maxWalBytes)
        } catch {
          walPublicationUncertain = true
          throw new DurableRecoveryRequiredError()
        }
        if (observed.status === 'missing') throw error
        if (observed.sha256 !== sha256Identifier(walBytes)
          || observed.bytes.length !== walBytes.length
          || !observed.bytes.equals(walBytes)) {
          walPublicationUncertain = true
          throw new DurableRecoveryRequiredError()
        }
        walPublished = true
        throw error
      }
      this.checkpoint('wal-published', { transactionId, entries: entries.length })
      for (const entry of entries) {
        this.files.replace(entry.temporaryPath, entry.relativePath)
        this.checkpoint('transaction-target-published', {
          transactionId,
          relativePath: entry.relativePath
        })
      }
      this.checkpoint('transaction-before-finalize', { transactionId, entries: entries.length })
      this.finalizeForward(wal, 'forward', true)
      return {
        transactionId,
        documentCount: entries.length,
        recoveredAfterSynchronousFailure: false
      }
    } catch (error) {
      if (!walPublished) {
        if (walPublicationUncertain) throw error
        for (const temporary of prepared) this.files.removeIfPlain(temporary)
        throw error
      }
      const disposition = this.recoverWal(`${transactionId}${WAL_SUFFIX}`, false)
      if (disposition === 'rollback') throw error
      // The WAL was already the durable commit decision. A synchronous
      // publication/checkpoint error that can be deterministically forwarded
      // is reported as success, never as a false failure after publication.
      return {
        transactionId,
        documentCount: entries.length,
        recoveredAfterSynchronousFailure: true
      }
    }
  }
}
