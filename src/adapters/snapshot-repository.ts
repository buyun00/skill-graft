import fs from 'node:fs'
import path from 'node:path'
import { ApplicationTransactionErrorBase } from '../application/transaction-port.js'
import type {
  LibrarySnapshotObservation,
  LibrarySnapshotRepositoryPort,
  SnapshotContentPort
} from '../application/ports.js'
import type { TransactionAwarePersistPort } from './durable-state.js'
import {
  type LibrarySnapshotManifestV1,
  type LibrarySnapshotSourceV1,
  type Sha256Identifier,
  validateLibrarySnapshotManifestV1
} from '../contracts/index.js'
import {
  type LibrarySnapshotFileFact,
  verifyLibrarySnapshotManifest
} from '../core/index.js'
import {
  DurableFileRoot,
  DurableLimitError,
  decodeUtf8Fatal,
  durableToken,
  flushDirectory,
  normalizeDurableRelative,
  portableDurablePathKey,
  readBoundedDescriptor,
  sha256Identifier,
  type DurableCheckpoint
} from './durable-files.js'

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/
const SAFE_CAPTURE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{15,63}$/

export type SnapshotRepositoryLimits = {
  maxFiles: number
  maxFileBytes: number
  maxTotalBytes: number
  maxManifestBytes: number
  maxSnapshots: number
  maxBlobEntries: number
}

const DEFAULT_LIMITS: SnapshotRepositoryLimits = {
  maxFiles: 10_000,
  maxFileBytes: 32 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxManifestBytes: 8 * 1024 * 1024,
  maxSnapshots: 10_000,
  maxBlobEntries: 20_000
}

type CapturedFile = {
  fact: LibrarySnapshotFileFact
  bytes: Buffer
}

type MemoryCapture = {
  source: LibrarySnapshotSourceV1
  files: readonly CapturedFile[]
  totalBytes: number
}

export type SnapshotRepositoryOptions = {
  /** Recommended Local layout root: skill-review/library. */
  root: string
  sourceRoot: string
  source: LibrarySnapshotSourceV1 | (() => LibrarySnapshotSourceV1)
  /** Explicit approved roots. Unknown source paths are never traversed. */
  captureRoots: readonly string[] | (() => readonly string[])
  /** The exact AsyncLocal transaction-aware façade from DurableTransactionHost. */
  persist: TransactionAwarePersistPort
  modeFor?: (relativePath: string, stat: fs.Stats) => '100644' | '100755'
  token?: () => string
  checkpoint?: DurableCheckpoint
  limits?: Partial<SnapshotRepositoryLimits>
}

export class SnapshotRepositoryError extends ApplicationTransactionErrorBase {
  readonly code = 'SNAPSHOT_INVALID' as const
  readonly retryable = false

  constructor(message: string) {
    super(message)
    this.name = 'SnapshotRepositoryError'
  }
}

function comparable(input: string): string {
  const resolved = path.resolve(input)
  const root = path.parse(resolved).root
  const trimmed = resolved === root ? root : resolved.replace(/[\\/]+$/, '')
  return process.platform === 'win32' || process.platform === 'darwin'
    ? trimmed.normalize('NFC').toLowerCase()
    : trimmed
}

function samePath(left: string, right: string): boolean {
  return comparable(left) === comparable(right)
}

function sameOrInside(root: string, target: string): boolean {
  const relation = path.relative(comparable(root), comparable(target))
  return relation === '' || (
    relation !== '..'
    && !relation.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relation)
  )
}

function assertPlainDirectory(target: string, label: string): void {
  const stat = fs.lstatSync(target)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new SnapshotRepositoryError(`${label} must be a plain directory`)
  }
  if (!samePath(target, fs.realpathSync.native(target))) {
    throw new SnapshotRepositoryError(`${label} crosses a junction or reparse point`)
  }
}

function assertPlainSourceRoot(input: string): string {
  const root = path.resolve(input)
  if (!fs.existsSync(root)) throw new SnapshotRepositoryError('snapshot source root does not exist')
  // realpath equality catches a linked ancestor even when sourceRoot itself is
  // a plain directory. Query-only list/read never calls this function.
  assertPlainDirectory(root, 'snapshot source root')
  return root
}

function normalizeSnapshotPath(input: string): string {
  const normalized = normalizeDurableRelative(input)
  if (normalized !== normalized.normalize('NFC')) {
    throw new SnapshotRepositoryError('snapshot paths must already be NFC-normalized')
  }
  return normalized
}

function sourceValue(input: SnapshotRepositoryOptions['source']): LibrarySnapshotSourceV1 {
  const source = typeof input === 'function' ? input() : input
  if (!source || source.kind !== 'library' || typeof source.id !== 'string' || !source.id.trim()) {
    throw new SnapshotRepositoryError('snapshot source provenance is invalid')
  }
  return {
    kind: 'library',
    id: source.id.trim(),
    ...(source.revision?.trim() ? { revision: source.revision.trim() } : {})
  }
}

function sourceMatches(left: LibrarySnapshotSourceV1, right: LibrarySnapshotSourceV1): boolean {
  return left.kind === right.kind
    && left.id === right.id
    && left.revision === right.revision
}

function captureRootsValue(input: SnapshotRepositoryOptions['captureRoots']): readonly string[] {
  const roots = typeof input === 'function' ? input() : input
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new SnapshotRepositoryError('at least one approved snapshot root is required')
  }
  return roots
}

function parseManifest(value: unknown): LibrarySnapshotManifestV1 {
  const validation = validateLibrarySnapshotManifestV1(value)
  if (!validation.valid || !verifyLibrarySnapshotManifest(value)) {
    throw new SnapshotRepositoryError('stored snapshot manifest is invalid')
  }
  return validation.value
}

function readSourceFile(
  sourceRoot: string,
  absolute: string,
  maximumBytes: number
): { bytes: Buffer; stat: fs.Stats } {
  if (!sameOrInside(sourceRoot, absolute) || samePath(sourceRoot, absolute)) {
    throw new SnapshotRepositoryError('snapshot file escapes its source root')
  }
  const before = fs.lstatSync(absolute)
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new SnapshotRepositoryError('snapshot input is not a plain file')
  }
  if (before.nlink !== 1) {
    throw new SnapshotRepositoryError('snapshot source hard links are not allowed')
  }
  if (before.size > maximumBytes) {
    throw new DurableLimitError(`snapshot source file exceeds the ${maximumBytes} byte limit`)
  }
  if (!samePath(absolute, fs.realpathSync.native(absolute))) {
    throw new SnapshotRepositoryError('snapshot input crosses a junction or reparse point')
  }
  let descriptor: number | undefined
  try {
    const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0
    descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | noFollow)
    const opened = fs.fstatSync(descriptor)
    if (!opened.isFile() || opened.nlink !== 1
      || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new SnapshotRepositoryError('snapshot input changed while it was opened')
    }
    const bytes = readBoundedDescriptor(descriptor, maximumBytes, 'snapshot source file')
    const openedAfter = fs.fstatSync(descriptor)
    if (!openedAfter.isFile() || openedAfter.nlink !== 1
      || openedAfter.dev !== opened.dev || openedAfter.ino !== opened.ino
      || openedAfter.size !== bytes.length) {
      throw new SnapshotRepositoryError('snapshot input changed on its opened handle while captured')
    }
    const after = fs.lstatSync(absolute)
    if (!after.isFile() || after.isSymbolicLink()
      || after.dev !== before.dev || after.ino !== before.ino
      || after.size !== bytes.length || after.nlink !== 1) {
      throw new SnapshotRepositoryError('snapshot input changed while it was captured')
    }
    return { bytes, stat: after }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

export function createSnapshotRepository(
  options: SnapshotRepositoryOptions
): LibrarySnapshotRepositoryPort & SnapshotContentPort {
  const repositoryRoot = path.resolve(options.root)
  const sourceRootInput = path.resolve(options.sourceRoot)
  const files = new DurableFileRoot(options)
  const nextToken = options.token || durableToken
  const checkpoint = options.checkpoint || (() => {})
  const modeFor = options.modeFor || (() => '100644' as const)
  const limits = { ...DEFAULT_LIMITS, ...options.limits }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new DurableLimitError(`snapshot ${name} limit is invalid`)
    }
  }
  const captures = new Map<string, MemoryCapture>()

  function blobRelative(identifier: Sha256Identifier): string {
    if (!SHA256_PATTERN.test(identifier)) throw new SnapshotRepositoryError('blob id is invalid')
    return normalizeDurableRelative(path.posix.join(
      'blobs',
      'sha256',
      identifier.slice('sha256:'.length)
    ))
  }

  function manifestRelative(identifier: Sha256Identifier): string {
    if (!SHA256_PATTERN.test(identifier)) throw new SnapshotRepositoryError('snapshot id is invalid')
    return normalizeDurableRelative(path.posix.join(
      'snapshots',
      `${identifier.slice('sha256:'.length)}.json`
    ))
  }

  function manifestBackupRelative(identifier: Sha256Identifier): string {
    const primary = manifestRelative(identifier)
    const base = path.posix.basename(primary)
    return normalizeDurableRelative(path.posix.join('snapshots', `.${base}.skill-graft.bak`))
  }

  function manifestAbsolute(identifier: Sha256Identifier): string {
    return path.resolve(repositoryRoot, ...manifestRelative(identifier).split('/'))
  }

  function readImmutableBlob(identifier: Sha256Identifier) {
    const relative = blobRelative(identifier)
    const blob = files.read(relative, limits.maxFileBytes)
    if (blob.status === 'missing') return blob
    const absolute = files.absolute(relative, 'snapshot blob')
    const stat = fs.lstatSync(absolute)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || stat.size !== blob.bytes.length) {
      throw new SnapshotRepositoryError('snapshot blob is not an isolated immutable file')
    }
    return blob
  }

  function collectApprovedFiles(sourceRoot: string): Array<{ relativePath: string; absolutePath: string }> {
    const selected = new Map<string, { relativePath: string; absolutePath: string }>()

    function addFile(relativePath: string, absolutePath: string): void {
      const normalized = normalizeSnapshotPath(relativePath)
      const portable = portableDurablePathKey(normalized)
      const previous = selected.get(portable)
      if (previous && previous.relativePath !== normalized) {
        throw new SnapshotRepositoryError(
          `snapshot path collision between ${previous.relativePath} and ${normalized}`
        )
      }
      if (!previous && selected.size >= limits.maxFiles) {
        throw new DurableLimitError(`snapshot exceeds the ${limits.maxFiles} file limit`)
      }
      selected.set(portable, { relativePath: normalized, absolutePath })
    }

    function directoryEntries(absolute: string): fs.Dirent[] {
      const directory = fs.opendirSync(absolute)
      const entries: fs.Dirent[] = []
      try {
        for (;;) {
          const entry = directory.readSync()
          if (!entry) break
          if (entries.length >= limits.maxFiles) {
            throw new DurableLimitError('approved snapshot directory exceeds the file limit')
          }
          entries.push(entry)
        }
      } finally {
        directory.closeSync()
      }
      return entries.sort((left, right) => (
        Buffer.from(left.name, 'utf8').compare(Buffer.from(right.name, 'utf8'))
      ))
    }

    function walk(relativePath: string): void {
      const normalized = normalizeSnapshotPath(relativePath)
      const absolute = path.resolve(sourceRoot, ...normalized.split('/'))
      if (!sameOrInside(sourceRoot, absolute) || samePath(sourceRoot, absolute)) {
        throw new SnapshotRepositoryError('approved snapshot root escapes the source')
      }
      const stat = fs.lstatSync(absolute)
      if (stat.isSymbolicLink() || !samePath(absolute, fs.realpathSync.native(absolute))) {
        throw new SnapshotRepositoryError('approved snapshot subtree contains a reparse point')
      }
      if (stat.isFile()) {
        addFile(normalized, absolute)
        return
      }
      if (!stat.isDirectory()) {
        throw new SnapshotRepositoryError('approved snapshot input is not a file or directory')
      }
      for (const entry of directoryEntries(absolute)) {
        if (entry.isSymbolicLink()) {
          throw new SnapshotRepositoryError('approved snapshot subtree contains a symlink or reparse point')
        }
        walk(path.posix.join(normalized, entry.name))
      }
    }

    const portableRoots = new Set<string>()
    for (const relativeRoot of captureRootsValue(options.captureRoots)) {
      const normalized = normalizeSnapshotPath(relativeRoot)
      const portable = portableDurablePathKey(normalized)
      if (portableRoots.has(portable)) throw new SnapshotRepositoryError('approved roots collide')
      portableRoots.add(portable)
      const approvedAbsolute = path.resolve(sourceRoot, ...normalized.split('/'))
      if (sameOrInside(approvedAbsolute, repositoryRoot)
        || sameOrInside(repositoryRoot, approvedAbsolute)) {
        throw new SnapshotRepositoryError('approved capture root overlaps the snapshot repository')
      }
      walk(normalized)
    }
    return [...selected.values()].sort((left, right) => (
      Buffer.from(left.relativePath, 'utf8').compare(Buffer.from(right.relativePath, 'utf8'))
    ))
  }

  function publishImmutableBlob(identifier: Sha256Identifier, bytes: Buffer): void {
    if (bytes.length > limits.maxFileBytes || sha256Identifier(bytes) !== identifier) {
      throw new SnapshotRepositoryError('captured blob content does not match its bounded fact')
    }
    const relative = blobRelative(identifier)
    const existing = readImmutableBlob(identifier)
    if (existing.status === 'missing') {
      const directory = path.posix.dirname(relative)
      const base = path.posix.basename(relative)
      const temporary = normalizeDurableRelative(path.posix.join(
        directory,
        `.${base}.skill-graft-blob-${files.token()}.tmp`
      ))
      files.writeExclusive(temporary, bytes, true, false, limits.maxFileBytes)
      const temporaryPath = files.absolute(temporary, 'snapshot blob temporary')
      const targetPath = files.absolute(relative, 'snapshot blob target')
      files.ensureParent(relative)
      try {
        // A hard-link publication is an atomic no-clobber operation. We do not
        // fall back to a partial copy on filesystems that lack this guarantee.
        fs.linkSync(temporaryPath, targetPath)
        flushDirectory(path.dirname(targetPath))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      } finally {
        files.removeIfPlain(temporary)
      }
    }
    const stored = readImmutableBlob(identifier)
    if (stored.status === 'missing' || stored.sha256 !== identifier || stored.bytes.length !== bytes.length) {
      throw new SnapshotRepositoryError('content-addressed blob failed durable verification')
    }
  }

  function cleanBlobTemporaries(): void {
    for (const entry of files.list('blobs/sha256', limits.maxBlobEntries)) {
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new SnapshotRepositoryError(`unexpected blob repository entry: ${entry.name}`)
      }
      if (/^[a-f0-9]{64}$/.test(entry.name)) continue
      if (/^\.[a-f0-9]{64}\.skill-graft-blob-[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.tmp$/.test(entry.name)) {
        files.removeIfPlain(path.posix.join('blobs', 'sha256', entry.name))
        continue
      }
      throw new SnapshotRepositoryError(`unexpected blob repository artifact: ${entry.name}`)
    }
  }

  function verifyBlobClosure(manifest: LibrarySnapshotManifestV1): void {
    if (manifest.files.length > limits.maxFiles) {
      throw new DurableLimitError(`snapshot exceeds the ${limits.maxFiles} file limit`)
    }
    let total = 0
    for (const file of manifest.files) {
      if (file.size > limits.maxFileBytes) {
        throw new DurableLimitError(`snapshot blob exceeds the ${limits.maxFileBytes} byte limit`)
      }
      total += file.size
      if (!Number.isSafeInteger(total) || total > limits.maxTotalBytes) {
        throw new DurableLimitError(`snapshot exceeds the ${limits.maxTotalBytes} aggregate byte limit`)
      }
      const blob = readImmutableBlob(file.sha256)
      if (blob.status === 'missing' || blob.bytes.length !== file.size || blob.sha256 !== file.sha256) {
        throw new SnapshotRepositoryError(`snapshot blob closure is invalid for ${file.path}`)
      }
    }
  }

  function readManifest(identifier: Sha256Identifier): LibrarySnapshotManifestV1 | null {
    const value = options.persist.readOptionalJson<unknown>(manifestAbsolute(identifier))
    if (value === null) return null
    const serializedBytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
    if (serializedBytes > limits.maxManifestBytes) {
      throw new DurableLimitError(`snapshot manifest exceeds the ${limits.maxManifestBytes} byte limit`)
    }
    const manifest = parseManifest(value)
    if (manifest.snapshotId !== identifier) {
      throw new SnapshotRepositoryError('snapshot manifest id does not match its object path')
    }
    verifyBlobClosure(manifest)
    return manifest
  }

  return {
    observe() {
      // A prior callback that failed before store() cannot publish anything;
      // release its bounded process-local capture before starting the next
      // globally serialized observation.
      captures.clear()
      cleanBlobTemporaries()
      const sourceRoot = assertPlainSourceRoot(sourceRootInput)
      const source = sourceValue(options.source)
      const selected = collectApprovedFiles(sourceRoot)
      const capturedFiles: CapturedFile[] = []
      let totalBytes = 0
      for (const file of selected) {
        const captured = readSourceFile(sourceRoot, file.absolutePath, limits.maxFileBytes)
        totalBytes += captured.bytes.length
        if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxTotalBytes) {
          throw new DurableLimitError(`snapshot exceeds the ${limits.maxTotalBytes} aggregate byte limit`)
        }
        const mode = modeFor(file.relativePath, captured.stat)
        if (mode !== '100644' && mode !== '100755') {
          throw new SnapshotRepositoryError('snapshot mode provider returned an invalid portable mode')
        }
        capturedFiles.push({
          fact: {
            path: file.relativePath,
            size: captured.bytes.length,
            sha256: sha256Identifier(captured.bytes),
            mode,
            isReparsePoint: false,
            mtimeMs: captured.stat.mtimeMs,
            absolutePath: file.absolutePath
          },
          bytes: captured.bytes
        })
      }
      const captureId = nextToken()
      if (!SAFE_CAPTURE_ID.test(captureId)) throw new SnapshotRepositoryError('capture token is invalid')
      captures.set(captureId, { source, files: capturedFiles, totalBytes })
      try { checkpoint('snapshot-observed', { captureId, files: capturedFiles.length }) } catch { /* observation only */ }
      return {
        captureId,
        source,
        files: capturedFiles.map((file) => ({ ...file.fact }))
      } satisfies LibrarySnapshotObservation
    },

    store(captureId, approved) {
      const capture = captures.get(captureId)
      if (!capture) throw new SnapshotRepositoryError('capture is missing, expired, or belongs to another process')
      options.persist.assertWriteTransactionActive()
      captures.delete(captureId)
      const validation = validateLibrarySnapshotManifestV1(approved)
      if (!validation.valid || !verifyLibrarySnapshotManifest(approved)) {
        throw new SnapshotRepositoryError('Core-approved snapshot manifest failed frozen validation')
      }
      if (!sourceMatches(capture.source, approved.source)
        || capture.files.length !== approved.files.length) {
        throw new SnapshotRepositoryError('approved manifest does not match its capture facts')
      }
      const capturedByPath = new Map(capture.files.map((file) => [file.fact.path, file]))
      for (const file of approved.files) {
        const captured = capturedByPath.get(file.path)
        if (!captured
          || captured.fact.size !== file.size
          || captured.fact.sha256 !== file.sha256
          || captured.fact.mode !== file.mode
          || captured.bytes.length !== file.size
          || sha256Identifier(captured.bytes) !== file.sha256) {
          throw new SnapshotRepositoryError('approved manifest changed a captured file fact or bytes')
        }
        publishImmutableBlob(file.sha256, captured.bytes)
      }

      const existing = readManifest(approved.snapshotId)
      if (existing) return { manifest: existing, deduplicated: true }
      // PersistPort rejects this call outside an active Application write
      // transaction. The manifest is therefore one WAL document beside
      // HubStateV2, request ledger, audit, and history—not a prepublished file.
      options.persist.writeJson(manifestAbsolute(approved.snapshotId), approved)
      try {
        checkpoint('snapshot-manifest-staged', {
          snapshotId: approved.snapshotId,
          files: approved.files.length
        })
      } catch { /* the manifest remains staged, not published */ }
      return { manifest: approved, deduplicated: false }
    },

    list() {
      const manifests: LibrarySnapshotManifestV1[] = []
      const identifiers = new Set<string>()
      const entries = files.list('snapshots', limits.maxSnapshots * 2)
        .sort((left, right) => Buffer.from(left.name, 'utf8').compare(Buffer.from(right.name, 'utf8')))
      for (const entry of entries) {
        if (entry.isSymbolicLink() || !entry.isFile()) {
          throw new SnapshotRepositoryError(`unexpected snapshot repository entry: ${entry.name}`)
        }
        const match = entry.name.match(/^([a-f0-9]{64})\.json$/)
        if (!match) {
          const backup = entry.name.match(/^\.([a-f0-9]{64})\.json\.skill-graft\.bak$/)
          if (backup) {
            identifiers.add(backup[1])
            continue
          }
          throw new SnapshotRepositoryError(`unexpected snapshot repository artifact: ${entry.name}`)
        }
        identifiers.add(match[1])
      }
      for (const identifier of [...identifiers].sort((left, right) => (
        Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'))
      ))) {
        if (manifests.length >= limits.maxSnapshots) {
          throw new DurableLimitError(`snapshot repository exceeds the ${limits.maxSnapshots} manifest limit`)
        }
        const manifest = readManifest(`sha256:${identifier}`)
        if (!manifest) throw new SnapshotRepositoryError('listed snapshot disappeared during read')
        manifests.push(manifest)
      }
      return manifests
    },

    read(snapshotId) {
      if (!SHA256_PATTERN.test(snapshotId)) throw new SnapshotRepositoryError('snapshot id is invalid')
      return readManifest(snapshotId)
    },

    readVerifiedFile(input) {
      if (!SHA256_PATTERN.test(input.snapshotId)
        || !SHA256_PATTERN.test(input.expectedSha256)
        || !Number.isSafeInteger(input.expectedSize)
        || input.expectedSize < 0) {
        throw new SnapshotRepositoryError('snapshot content request is invalid')
      }
      const manifest = readManifest(input.snapshotId)
      if (!manifest) return null
      const expected = manifest.files.find((file) => file.path === input.path)
      if (!expected) return null
      if (expected.size !== input.expectedSize || expected.sha256 !== input.expectedSha256) {
        throw new SnapshotRepositoryError('snapshot content request does not match its manifest')
      }
      const blob = readImmutableBlob(expected.sha256)
      if (blob.status === 'missing'
        || blob.bytes.length !== expected.size
        || blob.sha256 !== expected.sha256) {
        throw new SnapshotRepositoryError('snapshot content failed immutable blob verification')
      }
      return new Uint8Array(blob.bytes)
    }
  }
}
