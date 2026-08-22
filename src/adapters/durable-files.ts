import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { TextDecoder } from 'node:util'
import { ApplicationTransactionErrorBase } from '../application/transaction-port.js'

const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const utf8 = new TextDecoder('utf-8', { fatal: true })
export const DEFAULT_DURABLE_FILE_BYTES = 64 * 1024 * 1024
export const DEFAULT_DURABLE_DIRECTORY_ENTRIES = 10_000

export type DurableCheckpoint = (
  name: string,
  facts: Readonly<Record<string, string | number | boolean | null>>
) => void

export type DurablePlainFile =
  | { status: 'missing' }
  | { status: 'plain'; bytes: Buffer; sha256: `sha256:${string}` }

export type DurableFileRootOptions = {
  root: string
  checkpoint?: DurableCheckpoint
  token?: () => string
}

export class UnsafeDurablePathError extends ApplicationTransactionErrorBase {
  readonly code = 'PORT_FAILURE' as const
  readonly retryable = false

  constructor(message: string) {
    super(message)
    this.name = 'UnsafeDurablePathError'
  }
}

export class DurableLimitError extends ApplicationTransactionErrorBase {
  readonly code = 'PORT_FAILURE' as const
  readonly retryable = false

  constructor(message: string) {
    super(message)
    this.name = 'DurableLimitError'
  }
}

export function durableToken(): string {
  return randomBytes(16).toString('hex')
}

export function sha256Identifier(bytes: Buffer | string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function hasWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false
    }
  }
  return true
}

function validateSegment(segment: string): void {
  if (!segment || segment === '.' || segment === '..') {
    throw new UnsafeDurablePathError('durable path contains an empty or relative segment')
  }
  if (!hasWellFormedUtf16(segment) || /[\u0000-\u001f\u007f]/.test(segment)) {
    throw new UnsafeDurablePathError('durable path contains invalid Unicode or control characters')
  }
  if (/[\\/:*?"<>|]/.test(segment) || /[. ]$/.test(segment) || WINDOWS_RESERVED.test(segment)) {
    throw new UnsafeDurablePathError('durable path contains a non-portable segment')
  }
}

export function normalizeDurableRelative(input: string): string {
  if (typeof input !== 'string' || !input || input !== input.trim() || path.isAbsolute(input)) {
    throw new UnsafeDurablePathError('durable path must be a non-empty relative path')
  }
  const forward = input.replaceAll('\\', '/')
  if (forward.startsWith('/') || /^[A-Za-z]:/.test(forward)) {
    throw new UnsafeDurablePathError('durable path must not be absolute')
  }
  const segments = forward.split('/')
  for (const segment of segments) validateSegment(segment)
  return segments.join('/')
}

export function portableDurablePathKey(relativePath: string): string {
  return normalizeDurableRelative(relativePath)
    .split('/')
    .map((segment) => segment.normalize('NFC').toLowerCase())
    .join('/')
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

function lstatMaybe(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function assertPlainDirectory(target: string, label: string): void {
  const stat = fs.lstatSync(target)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new UnsafeDurablePathError(`${label} must be a plain directory`)
  }
  const canonical = fs.realpathSync.native(target)
  if (!samePath(target, canonical)) {
    throw new UnsafeDurablePathError(`${label} crosses a junction or reparse point`)
  }
}

function sameIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function directoryIdentity(target: string, label: string): fs.Stats {
  assertPlainDirectory(target, label)
  return fs.lstatSync(target)
}

function assertDirectoryIdentity(target: string, expected: fs.Stats, label: string): void {
  const actual = directoryIdentity(target, label)
  if (!sameIdentity(actual, expected)) {
    throw new UnsafeDurablePathError(`${label} changed before the filesystem operation`)
  }
}

function validatePlainRoot(input: string, create: boolean): boolean {
  const resolved = path.resolve(input)
  const missing: string[] = []
  let cursor = resolved
  while (lstatMaybe(cursor) === null) {
    const parent = path.dirname(cursor)
    if (samePath(parent, cursor)) throw new UnsafeDurablePathError('durable root has no existing ancestor')
    missing.push(path.basename(cursor))
    cursor = parent
  }
  assertPlainDirectory(cursor, 'durable root ancestor')
  if (!create && missing.length > 0) return false
  while (missing.length > 0) {
    cursor = path.join(cursor, missing.pop() as string)
    fs.mkdirSync(cursor)
    assertPlainDirectory(cursor, 'durable root component')
    flushDirectory(path.dirname(cursor))
  }
  assertPlainDirectory(resolved, 'durable root')
  return true
}

export function decodeUtf8Fatal(bytes: Buffer, label: string): string {
  try {
    return utf8.decode(bytes)
  } catch {
    throw new Error(`${label} is not valid UTF-8`)
  }
}

export function flushDirectory(directory: string): void {
  let descriptor: number | undefined
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY)
    fs.fsyncSync(descriptor)
  } catch (error) {
    const code = String((error as NodeJS.ErrnoException).code)
    const unsupported = process.platform === 'win32'
      && ['EACCES', 'EBADF', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM'].includes(code)
    if (!unsupported) throw error
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

function writeAll(descriptor: number, bytes: Buffer): void {
  let offset = 0
  while (offset < bytes.length) {
    const written = fs.writeSync(descriptor, bytes, offset, bytes.length - offset)
    if (written <= 0) throw new Error('durable file write made no progress')
    offset += written
  }
}

/** Reads at most `maximumBytes + 1`, so growth after lstat cannot allocate an unbounded buffer. */
export function readBoundedDescriptor(
  descriptor: number,
  maximumBytes: number,
  label = 'durable file'
): Buffer {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new DurableLimitError('durable read byte limit is invalid')
  }
  const chunks: Buffer[] = []
  let total = 0
  while (total <= maximumBytes) {
    const remainingProbe = maximumBytes + 1 - total
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remainingProbe))
    const count = fs.readSync(descriptor, buffer, 0, buffer.length, null)
    if (count === 0) break
    total += count
    if (total > maximumBytes) {
      throw new DurableLimitError(`${label} exceeds the ${maximumBytes} byte limit`)
    }
    chunks.push(buffer.subarray(0, count))
  }
  return Buffer.concat(chunks, total)
}

export class DurableFileRoot {
  readonly root: string
  private readonly checkpoint: DurableCheckpoint
  private readonly nextToken: () => string

  constructor(options: DurableFileRootOptions) {
    this.root = path.resolve(options.root)
    // Construction and query-only hosts are read-only. Missing layout is
    // created lazily only after a write transaction owns its leases.
    validatePlainRoot(this.root, false)
    this.checkpoint = options.checkpoint || (() => {})
    this.nextToken = options.token || durableToken
  }

  token(): string {
    const token = this.nextToken()
    if (!SAFE_TOKEN.test(token)) throw new Error('durable token is invalid')
    return token
  }

  relative(file: string): string {
    const absolute = path.resolve(file)
    if (!sameOrInside(this.root, absolute) || samePath(this.root, absolute)) {
      throw new UnsafeDurablePathError('persist target escapes durable root')
    }
    return normalizeDurableRelative(path.relative(this.root, absolute).split(path.sep).join('/'))
  }

  absolute(relativePath: string, label = 'durable path'): string {
    validatePlainRoot(this.root, false)
    const normalized = normalizeDurableRelative(relativePath)
    const target = path.resolve(this.root, ...normalized.split('/'))
    if (!sameOrInside(this.root, target) || samePath(this.root, target)) {
      throw new UnsafeDurablePathError(`${label} escapes durable root`)
    }
    let cursor = this.root
    const segments = normalized.split('/')
    for (let index = 0; index < segments.length; index += 1) {
      cursor = path.join(cursor, segments[index])
      const stat = lstatMaybe(cursor)
      if (!stat) break
      if (stat.isSymbolicLink()) {
        throw new UnsafeDurablePathError(`${label} crosses a symlink or reparse point`)
      }
      if (index < segments.length - 1 && !stat.isDirectory()) {
        throw new UnsafeDurablePathError(`${label} crosses a non-directory component`)
      }
      const canonical = fs.realpathSync.native(cursor)
      if (!samePath(cursor, canonical)) {
        throw new UnsafeDurablePathError(`${label} crosses a junction or reparse point`)
      }
    }
    return target
  }

  ensureDirectory(relativeDirectory: string): string {
    validatePlainRoot(this.root, true)
    const normalized = normalizeDurableRelative(relativeDirectory)
    let cursor = this.root
    for (const segment of normalized.split('/')) {
      cursor = path.join(cursor, segment)
      const stat = lstatMaybe(cursor)
      if (!stat) {
        this.checkpoint('before-durable-directory-create', {})
        try {
          fs.mkdirSync(cursor)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
        // EEXIST is acceptable only after the same validation as a directory
        // we created ourselves. Flush the parent in either case: the winning
        // creator may not yet have completed its durability step.
        assertPlainDirectory(cursor, 'durable directory')
        flushDirectory(path.dirname(cursor))
      }
      assertPlainDirectory(cursor, 'durable directory')
    }
    return cursor
  }

  ensureParent(relativePath: string): string {
    const normalized = normalizeDurableRelative(relativePath)
    const directory = path.posix.dirname(normalized)
    return directory === '.' ? this.root : this.ensureDirectory(directory)
  }

  read(relativePath: string, maximumBytes = DEFAULT_DURABLE_FILE_BYTES): DurablePlainFile {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
      throw new DurableLimitError('durable read byte limit is invalid')
    }
    const normalized = normalizeDurableRelative(relativePath)
    const absolute = this.absolute(normalized, 'durable file')
    const before = lstatMaybe(absolute)
    if (!before) return { status: 'missing' }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
      throw new UnsafeDurablePathError('durable file is not a plain file')
    }
    if (before.size > maximumBytes) {
      throw new DurableLimitError(`durable file exceeds the ${maximumBytes} byte limit`)
    }
    let descriptor: number | undefined
    try {
      const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0
      descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | noFollow)
      const opened = fs.fstatSync(descriptor)
      if (!opened.isFile() || opened.nlink !== 1
        || opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new UnsafeDurablePathError('durable file changed while it was opened')
      }
      const bytes = readBoundedDescriptor(descriptor, maximumBytes)
      const openedAfter = fs.fstatSync(descriptor)
      if (!openedAfter.isFile() || openedAfter.nlink !== 1
        || openedAfter.dev !== opened.dev || openedAfter.ino !== opened.ino
        || openedAfter.size !== bytes.length) {
        throw new UnsafeDurablePathError('durable file changed on its opened handle while it was read')
      }
      const after = fs.lstatSync(absolute)
      if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1
        || after.dev !== before.dev || after.ino !== before.ino
        || after.size !== bytes.length) {
        throw new UnsafeDurablePathError('durable file changed while it was read')
      }
      return { status: 'plain', bytes, sha256: sha256Identifier(bytes) }
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor)
    }
  }

  readText(relativePath: string, maximumBytes = DEFAULT_DURABLE_FILE_BYTES): string | null {
    const file = this.read(relativePath, maximumBytes)
    return file.status === 'missing' ? null : decodeUtf8Fatal(file.bytes, relativePath)
  }

  writeExclusive(
    relativePath: string,
    bytes: Buffer,
    emitCheckpoint = true,
    requireExistingParent = false,
    maximumBytes = DEFAULT_DURABLE_FILE_BYTES
  ): void {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || bytes.length > maximumBytes) {
      throw new DurableLimitError(`durable write exceeds the ${maximumBytes} byte limit`)
    }
    const normalized = normalizeDurableRelative(relativePath)
    if (requireExistingParent) {
      const expectedParent = path.dirname(this.absolute(normalized, 'durable temporary file'))
      assertPlainDirectory(expectedParent, 'durable temporary parent')
    } else {
      this.ensureParent(normalized)
    }
    const absolute = this.absolute(normalized, 'durable temporary file')
    let descriptor: number | undefined
    let complete = false
    try {
      const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0
      descriptor = fs.openSync(
        absolute,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
        0o600
      )
      writeAll(descriptor, bytes)
      fs.fsyncSync(descriptor)
      if (emitCheckpoint) this.checkpoint('file-flushed', { relativePath: normalized, bytes: bytes.length })
      complete = true
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor)
      if (!complete) {
        const stat = lstatMaybe(absolute)
        if (stat?.isFile() && !stat.isSymbolicLink()) fs.unlinkSync(absolute)
      }
    }
  }

  replace(
    temporaryRelative: string,
    targetRelative: string,
    emitCheckpoint = true,
    requireExistingParent = false
  ): void {
    const temporary = normalizeDurableRelative(temporaryRelative)
    const target = normalizeDurableRelative(targetRelative)
    const temporaryPath = this.absolute(temporary, 'durable temporary replacement')
    const targetPath = this.absolute(target, 'durable replacement target')
    const tempStat = lstatMaybe(temporaryPath)
    if (!tempStat?.isFile() || tempStat.isSymbolicLink()) {
      throw new Error(`durable temporary file is missing or unsafe: ${temporary}`)
    }
    const sourceDirectory = path.dirname(temporaryPath)
    const targetDirectory = path.dirname(targetPath)
    if (requireExistingParent) {
      assertPlainDirectory(targetDirectory, 'durable replacement parent')
    } else {
      this.ensureParent(target)
    }
    const sourceParent = directoryIdentity(sourceDirectory, 'durable replacement source parent')
    const targetParent = directoryIdentity(targetDirectory, 'durable replacement target parent')
    const existing = lstatMaybe(targetPath)
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
      throw new UnsafeDurablePathError(`durable replacement target is unsafe: ${target}`)
    }
    // Node does not expose renameat/openat handles. These identity checks stop
    // ordinary path swaps and linked ancestors; the data root must additionally
    // be ACL-protected from a hostile same-privilege process racing this call.
    assertDirectoryIdentity(sourceDirectory, sourceParent, 'durable replacement source parent')
    assertDirectoryIdentity(targetDirectory, targetParent, 'durable replacement target parent')
    const currentTemporary = lstatMaybe(temporaryPath)
    if (!currentTemporary || !sameIdentity(currentTemporary, tempStat)) {
      throw new UnsafeDurablePathError('durable temporary changed before atomic replacement')
    }
    const currentTarget = lstatMaybe(targetPath)
    if ((existing === null) !== (currentTarget === null)
      || existing && currentTarget && !sameIdentity(existing, currentTarget)) {
      throw new UnsafeDurablePathError('durable target changed before atomic replacement')
    }
    fs.renameSync(temporaryPath, targetPath)
    if (emitCheckpoint) this.checkpoint('atomic-replace-published', { relativePath: target })
    flushDirectory(targetDirectory)
    if (!samePath(sourceDirectory, targetDirectory)) flushDirectory(sourceDirectory)
    if (emitCheckpoint) this.checkpoint('atomic-replace', { relativePath: target })
  }

  atomicWrite(relativePath: string, bytes: Buffer, purpose: string, emitCheckpoint = true): void {
    if (!/^[A-Za-z][A-Za-z0-9-]{0,31}$/.test(purpose)) throw new Error('durable write purpose is invalid')
    const normalized = normalizeDurableRelative(relativePath)
    const directory = path.posix.dirname(normalized)
    const base = path.posix.basename(normalized)
    const temporary = normalizeDurableRelative(path.posix.join(
      directory === '.' ? '' : directory,
      `.${base}.skill-graft-${purpose}-${this.token()}.tmp`
    ))
    this.writeExclusive(temporary, bytes, emitCheckpoint)
    try {
      this.replace(temporary, normalized, emitCheckpoint)
    } catch (error) {
      this.removeIfPlain(temporary)
      throw error
    }
  }

  removeIfPlain(relativePath: string): boolean {
    const normalized = normalizeDurableRelative(relativePath)
    const absolute = this.absolute(normalized, 'durable removal target')
    const stat = lstatMaybe(absolute)
    if (!stat) return false
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new UnsafeDurablePathError('durable removal target is not a plain file')
    }
    const parent = path.dirname(absolute)
    const parentStat = directoryIdentity(parent, 'durable removal parent')
    assertDirectoryIdentity(parent, parentStat, 'durable removal parent')
    const current = lstatMaybe(absolute)
    if (!current || !sameIdentity(stat, current)) {
      throw new UnsafeDurablePathError('durable removal target changed before unlink')
    }
    fs.unlinkSync(absolute)
    flushDirectory(parent)
    return true
  }

  list(
    relativeDirectory: string,
    maximumEntries = DEFAULT_DURABLE_DIRECTORY_ENTRIES
  ): fs.Dirent[] {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) {
      throw new DurableLimitError('durable directory entry limit is invalid')
    }
    const normalized = normalizeDurableRelative(relativeDirectory)
    const absolute = this.absolute(normalized, 'durable directory listing')
    if (lstatMaybe(absolute) === null) return []
    assertPlainDirectory(absolute, 'durable directory listing')
    const directory = fs.opendirSync(absolute)
    const entries: fs.Dirent[] = []
    try {
      for (;;) {
        const entry = directory.readSync()
        if (!entry) break
        if (entries.length >= maximumEntries) {
          throw new DurableLimitError(`durable directory exceeds the ${maximumEntries} entry limit`)
        }
        entries.push(entry)
      }
    } finally {
      directory.closeSync()
    }
    return entries
  }
}
