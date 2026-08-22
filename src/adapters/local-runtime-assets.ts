import fs from 'node:fs'
import path from 'node:path'
import type { RuntimeAssetRepositoryPort } from '../application/ports.js'
import { ApplicationTransactionErrorBase } from '../application/transaction-port.js'
import {
  isPortableOpaqueIdentifier,
  type RuntimeAssetManifestV1,
  type Sha256Identifier,
  validateRuntimeAssetManifestV1
} from '../contracts/index.js'
import {
  createRuntimeAssetManifest,
  type RuntimeAssetFileFact,
  verifyRuntimeAssetManifest
} from '../core/index.js'
import {
  DurableLimitError,
  normalizeDurableRelative,
  portableDurablePathKey,
  readBoundedDescriptor,
  sha256Identifier,
  type DurableCheckpoint
} from './durable-files.js'

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/
const EXCLUDED_MUTABLE_FILES = new Set([
  'attached-worktrees.txt',
  'do-not-auto-attach.txt',
  'scan-roots.txt'
])

/**
 * P3 deliberately freezes the worktree runtime projection. Adding a plain file
 * below overlay/ must not silently distribute it to every claimed worktree.
 * Compatibility facades remain explicit assets until a later migration removes
 * them from this list and from the installed package contract.
 */
export const LOCAL_RUNTIME_ASSET_PATHS = Object.freeze([
  'HubLib.ps1',
  'analyze-remote-skill-update.ps1',
  'attach-library.ps1',
  'checkout-rules.txt',
  'dispatch-hub-codex.ps1',
  'hooks/post-checkout',
  'hooks/reference-transaction',
  'manage-skill-visibility.ps1',
  'promote-inbox.ps1',
  'prompts/analyze.txt',
  'prompts/attach.txt',
  'prompts/chat.txt',
  'prompts/detach.txt',
  'prompts/edit.txt',
  'register-unity-skills.ps1',
  'start-codex-session.ps1',
  'sync-codex-worktree-overlay.ps1'
] as const)

export const LOCAL_RUNTIME_COMPATIBILITY_ASSET_PATHS = Object.freeze([
  'analyze-remote-skill-update.ps1',
  'dispatch-hub-codex.ps1',
  'promote-inbox.ps1',
  'start-codex-session.ps1'
] as const)

const EXPECTED_RUNTIME_ASSET_FILES = new Set<string>(LOCAL_RUNTIME_ASSET_PATHS)
const EXPECTED_RUNTIME_ASSET_DIRECTORIES = new Set(['hooks', 'prompts'])

export type LocalRuntimeAssetLimits = {
  maxEntries: number
  maxFiles: number
  maxDepth: number
  maxFileBytes: number
  maxTotalBytes: number
}

const DEFAULT_LIMITS: LocalRuntimeAssetLimits = {
  maxEntries: 8_192,
  maxFiles: 4_096,
  maxDepth: 64,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024
}

export type LocalRuntimeAssetRepositoryOptions = {
  /** Absolute root of the installed/source package; only its overlay child is read. */
  packageRoot: string
  /** Explicit host revision. This adapter never consults package.json or Git. */
  runtimeRevision: string
  limits?: Partial<LocalRuntimeAssetLimits>
  modeFor?: (relativePath: string, stat: fs.BigIntStats) => '100644' | '100755'
  checkpoint?: DurableCheckpoint
}

export class LocalRuntimeAssetError extends ApplicationTransactionErrorBase {
  readonly code = 'RUNTIME_ASSET_INVALID' as const
  readonly retryable = false

  constructor(message: string) {
    super(message)
    this.name = 'LocalRuntimeAssetError'
  }
}

type CapturedRuntimeFile = {
  fact: RuntimeAssetFileFact
  bytes: Buffer
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

function lstatRequired(target: string, label: string): fs.BigIntStats {
  try {
    return fs.lstatSync(target, { bigint: true })
  } catch {
    throw new LocalRuntimeAssetError(`${label} is missing or unreadable`)
  }
}

function realpathRequired(target: string, label: string): string {
  try {
    return fs.realpathSync.native(target)
  } catch {
    throw new LocalRuntimeAssetError(`${label} cannot be resolved safely`)
  }
}

function sameIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function sameStableFile(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return sameIdentity(left, right)
    && left.isFile()
    && right.isFile()
    && left.nlink === 1n
    && right.nlink === 1n
    && left.size === right.size
    && left.mode === right.mode
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}

function sameStableDirectory(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return sameIdentity(left, right)
    && left.isDirectory()
    && right.isDirectory()
    && left.nlink === right.nlink
    && left.mode === right.mode
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}

function assertPlainDirectory(target: string, label: string): fs.BigIntStats {
  const stat = lstatRequired(target, label)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new LocalRuntimeAssetError(`${label} must be a plain directory`)
  }
  if (!samePath(target, realpathRequired(target, label))) {
    throw new LocalRuntimeAssetError(`${label} crosses a junction or reparse point`)
  }
  return stat
}

function assertUnchangedDirectory(
  target: string,
  expected: fs.BigIntStats,
  label: string
): void {
  const actual = lstatRequired(target, label)
  if (actual.isSymbolicLink()
    || !sameStableDirectory(expected, actual)
    || !samePath(target, realpathRequired(target, label))) {
    throw new LocalRuntimeAssetError(`${label} changed while it was read`)
  }
}

function normalizeRuntimePath(input: string): string {
  if (typeof input !== 'string' || input.includes('\\')) {
    throw new LocalRuntimeAssetError('runtime asset path is not portable')
  }
  let normalized: string
  try {
    normalized = normalizeDurableRelative(input)
  } catch {
    throw new LocalRuntimeAssetError('runtime asset path is not portable')
  }
  if (normalized !== input || normalized !== normalized.normalize('NFC')) {
    throw new LocalRuntimeAssetError('runtime asset path is not NFC-normalized')
  }
  return normalized
}

function validateLimits(input: Partial<LocalRuntimeAssetLimits> | undefined): LocalRuntimeAssetLimits {
  const limits = { ...DEFAULT_LIMITS, ...input }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new DurableLimitError(`runtime asset ${name} limit is invalid`)
    }
  }
  if (limits.maxFiles > limits.maxEntries) {
    throw new DurableLimitError('runtime asset maxFiles cannot exceed maxEntries')
  }
  return limits
}

function defaultMode(_relativePath: string, stat: fs.BigIntStats): '100644' | '100755' {
  return (stat.mode & 0o111n) === 0n ? '100644' : '100755'
}

export function createLocalRuntimeAssetRepository(
  options: LocalRuntimeAssetRepositoryOptions
): RuntimeAssetRepositoryPort {
  if (!options || typeof options !== 'object'
    || typeof options.packageRoot !== 'string'
    || !path.isAbsolute(options.packageRoot)) {
    throw new LocalRuntimeAssetError('runtime asset packageRoot must be absolute')
  }
  if (!isPortableOpaqueIdentifier(options.runtimeRevision)) {
    throw new LocalRuntimeAssetError('runtimeRevision must be an explicit portable opaque identifier')
  }
  const packageRoot = path.resolve(options.packageRoot)
  const overlayRoot = path.join(packageRoot, 'overlay')
  const runtimeRevision = options.runtimeRevision
  const limits = validateLimits(options.limits)
  const checkpoint = options.checkpoint || (() => {})
  const modeFor = options.modeFor || defaultMode

  function assertSourceRoot(): void {
    assertPlainDirectory(packageRoot, 'runtime package root')
    assertPlainDirectory(overlayRoot, 'runtime overlay root')
    if (!sameOrInside(packageRoot, overlayRoot) || samePath(packageRoot, overlayRoot)) {
      throw new LocalRuntimeAssetError('runtime overlay root escapes its package root')
    }
  }

  function readPlainFile(relativePath: string, absolutePath: string): CapturedRuntimeFile {
    if (!sameOrInside(overlayRoot, absolutePath) || samePath(overlayRoot, absolutePath)) {
      throw new LocalRuntimeAssetError('runtime asset file escapes its overlay root')
    }
    const before = lstatRequired(absolutePath, 'runtime asset file')
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
      throw new LocalRuntimeAssetError('runtime asset input must be a plain single-link file')
    }
    if (before.size > BigInt(limits.maxFileBytes)) {
      throw new DurableLimitError(
        `runtime asset file exceeds the ${limits.maxFileBytes} byte limit`
      )
    }
    if (!samePath(absolutePath, realpathRequired(absolutePath, 'runtime asset file'))) {
      throw new LocalRuntimeAssetError('runtime asset file crosses a junction or reparse point')
    }

    checkpoint('runtime-assets-before-file-open', { relativePath })
    let descriptor: number | undefined
    try {
      const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0
      try {
        descriptor = fs.openSync(absolutePath, fs.constants.O_RDONLY | noFollow)
      } catch {
        throw new LocalRuntimeAssetError('runtime asset file cannot be opened safely')
      }
      const opened = fs.fstatSync(descriptor, { bigint: true })
      if (!sameStableFile(before, opened)) {
        throw new LocalRuntimeAssetError('runtime asset file changed while it was opened')
      }
      const bytes = readBoundedDescriptor(descriptor, limits.maxFileBytes, 'runtime asset file')
      checkpoint('runtime-assets-after-file-read', { relativePath, bytes: bytes.length })
      const openedAfter = fs.fstatSync(descriptor, { bigint: true })
      if (!sameStableFile(opened, openedAfter) || openedAfter.size !== BigInt(bytes.length)) {
        throw new LocalRuntimeAssetError(
          'runtime asset file changed on its opened handle while it was read'
        )
      }
      checkpoint('runtime-assets-before-file-path-recheck', { relativePath })
      const after = lstatRequired(absolutePath, 'runtime asset file')
      if (after.isSymbolicLink()
        || !sameStableFile(openedAfter, after)
        || !samePath(absolutePath, realpathRequired(absolutePath, 'runtime asset file'))) {
        throw new LocalRuntimeAssetError('runtime asset file changed while it was read')
      }
      const mode = modeFor(relativePath, after)
      if (mode !== '100644' && mode !== '100755') {
        throw new LocalRuntimeAssetError('runtime asset mode provider returned an invalid mode')
      }
      return {
        fact: {
          path: relativePath,
          size: bytes.length,
          sha256: sha256Identifier(bytes),
          mode,
          isReparsePoint: false,
          mtimeMs: Number(after.mtimeNs) / 1_000_000,
          absolutePath
        },
        bytes
      }
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor)
    }
  }

  function scan(): { manifest: RuntimeAssetManifestV1; files: readonly CapturedRuntimeFile[] } {
    assertSourceRoot()
    const selected = new Map<string, CapturedRuntimeFile>()
    const observedPaths = new Map<string, string>()
    let entryCount = 0
    let fileCount = 0
    let totalBytes = 0

    function registerPath(relativePath: string): string {
      const normalized = normalizeRuntimePath(relativePath)
      const portableKey = portableDurablePathKey(normalized)
      const previous = observedPaths.get(portableKey)
      if (previous && previous !== normalized) {
        throw new LocalRuntimeAssetError('runtime overlay contains a portable path collision')
      }
      observedPaths.set(portableKey, normalized)
      return normalized
    }

    function readDirectory(absolutePath: string, relativePath: string, expected: fs.BigIntStats): fs.Dirent[] {
      let directory: fs.Dir | undefined
      const entries: fs.Dirent[] = []
      try {
        directory = fs.opendirSync(absolutePath)
        for (;;) {
          const entry = directory.readSync()
          if (!entry) break
          entryCount += 1
          if (entryCount > limits.maxEntries) {
            throw new DurableLimitError(
              `runtime overlay exceeds the ${limits.maxEntries} entry limit`
            )
          }
          entries.push(entry)
        }
      } catch (error) {
        if (error instanceof DurableLimitError) throw error
        throw new LocalRuntimeAssetError('runtime overlay directory cannot be read safely')
      } finally {
        directory?.closeSync()
      }
      checkpoint('runtime-assets-after-directory-read', {
        relativePath: relativePath || '.',
        entries: entries.length
      })
      assertUnchangedDirectory(absolutePath, expected, 'runtime overlay directory')
      return entries.sort((left, right) => (
        Buffer.from(left.name, 'utf8').compare(Buffer.from(right.name, 'utf8'))
      ))
    }

    function walkDirectory(absolutePath: string, relativePath: string, depth: number): void {
      if (depth > limits.maxDepth) {
        throw new DurableLimitError(`runtime overlay exceeds the ${limits.maxDepth} depth limit`)
      }
      const directoryStat = assertPlainDirectory(
        absolutePath,
        relativePath ? 'runtime overlay directory' : 'runtime overlay root'
      )
      for (const entry of readDirectory(absolutePath, relativePath, directoryStat)) {
        assertUnchangedDirectory(absolutePath, directoryStat, 'runtime overlay directory')
        if (entry.name.includes('\\') || entry.name !== entry.name.normalize('NFC')) {
          throw new LocalRuntimeAssetError('runtime overlay entry name is not portable NFC')
        }
        const joined = relativePath ? path.posix.join(relativePath, entry.name) : entry.name
        const normalized = registerPath(joined)
        const child = path.resolve(overlayRoot, ...normalized.split('/'))
        if (!sameOrInside(overlayRoot, child) || samePath(overlayRoot, child)) {
          throw new LocalRuntimeAssetError('runtime overlay entry escapes its source root')
        }
        const stat = lstatRequired(child, 'runtime overlay entry')
        if (stat.isSymbolicLink()
          || !samePath(child, realpathRequired(child, 'runtime overlay entry'))) {
          throw new LocalRuntimeAssetError('runtime overlay contains a junction or reparse point')
        }
        const excludedMutableFile = EXCLUDED_MUTABLE_FILES.has(normalized)
        if (excludedMutableFile && (!stat.isFile() || stat.nlink !== 1n)) {
          throw new LocalRuntimeAssetError(
            'excluded mutable runtime entries must remain plain single-link files'
          )
        }
        if (stat.isDirectory()) {
          if (!EXPECTED_RUNTIME_ASSET_DIRECTORIES.has(normalized)) {
            throw new LocalRuntimeAssetError(
              'runtime overlay contains an unrecognized directory'
            )
          }
          walkDirectory(child, normalized, depth + 1)
          assertUnchangedDirectory(absolutePath, directoryStat, 'runtime overlay directory')
          continue
        }
        if (!stat.isFile() || stat.nlink !== 1n) {
          throw new LocalRuntimeAssetError(
            'runtime overlay entries must be plain directories or single-link files'
          )
        }
        fileCount += 1
        if (fileCount > limits.maxFiles) {
          throw new DurableLimitError(`runtime overlay exceeds the ${limits.maxFiles} file limit`)
        }
        if (excludedMutableFile) {
          assertUnchangedDirectory(absolutePath, directoryStat, 'runtime overlay directory')
          continue
        }
        if (!EXPECTED_RUNTIME_ASSET_FILES.has(normalized)) {
          throw new LocalRuntimeAssetError('runtime overlay contains an unrecognized file')
        }
        const captured = readPlainFile(normalized, child)
        totalBytes += captured.bytes.length
        if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxTotalBytes) {
          throw new DurableLimitError(
            `runtime overlay exceeds the ${limits.maxTotalBytes} aggregate byte limit`
          )
        }
        selected.set(portableDurablePathKey(normalized), captured)
        assertUnchangedDirectory(absolutePath, directoryStat, 'runtime overlay directory')
      }
      assertUnchangedDirectory(absolutePath, directoryStat, 'runtime overlay directory')
    }

    walkDirectory(overlayRoot, '', 0)
    if (selected.size !== EXPECTED_RUNTIME_ASSET_FILES.size
      || LOCAL_RUNTIME_ASSET_PATHS.some((relativePath) => (
        !selected.has(portableDurablePathKey(relativePath))
      ))) {
      throw new LocalRuntimeAssetError('runtime overlay is missing a required immutable asset')
    }
    const files = [...selected.values()].sort((left, right) => (
      Buffer.from(left.fact.path, 'utf8').compare(Buffer.from(right.fact.path, 'utf8'))
    ))
    const created = createRuntimeAssetManifest({
      runtimeRevision,
      files: files.map((file) => file.fact)
    })
    if (!created.ok) {
      throw new LocalRuntimeAssetError('Core rejected the runtime asset observation')
    }
    const validation = validateRuntimeAssetManifestV1(created.manifest)
    if (!validation.valid || !verifyRuntimeAssetManifest(created.manifest)) {
      throw new LocalRuntimeAssetError('Core produced an invalid runtime asset manifest')
    }
    return { manifest: validation.value, files }
  }

  return {
    observe() {
      return scan().manifest
    },

    readVerifiedFile(input) {
      if (!input || typeof input !== 'object'
        || !SHA256_PATTERN.test(input.runtimeAssetId)
        || !SHA256_PATTERN.test(input.expectedSha256)
        || !Number.isSafeInteger(input.expectedSize)
        || input.expectedSize < 0
        || input.expectedSize > limits.maxFileBytes
        || (input.expectedMode !== '100644' && input.expectedMode !== '100755')) {
        throw new LocalRuntimeAssetError('runtime asset content request is invalid')
      }
      const requestedPath = normalizeRuntimePath(input.path)
      const current = scan()
      if (current.manifest.runtimeAssetId !== input.runtimeAssetId) {
        throw new LocalRuntimeAssetError('runtime assets changed after the requested manifest was planned')
      }
      const expected = current.manifest.files.find((file) => file.path === requestedPath)
      if (!expected) return null
      if (expected.size !== input.expectedSize
        || expected.sha256 !== input.expectedSha256
        || expected.mode !== input.expectedMode) {
        throw new LocalRuntimeAssetError('runtime asset content request does not match its manifest')
      }
      const absolutePath = path.resolve(overlayRoot, ...requestedPath.split('/'))
      const captured = readPlainFile(requestedPath, absolutePath)
      if (captured.bytes.length !== expected.size
        || captured.fact.sha256 !== expected.sha256
        || captured.fact.mode !== expected.mode) {
        throw new LocalRuntimeAssetError('runtime asset content failed source verification')
      }
      return new Uint8Array(captured.bytes)
    }
  }
}
