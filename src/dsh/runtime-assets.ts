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
import { sha256Identifier } from '../adapters/durable-files.js'

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/

/**
 * The DSH release deliberately ships only host-neutral copied runtime files.
 * No Local launcher, Codex prompt, `sg` facade, or daemon hook is part of this
 * closure.
 */
export const DSH_RUNTIME_ASSET_PATHS = Object.freeze([
  'README.md',
  'hooks/.keep'
] as const)

export class DshRuntimeAssetError extends ApplicationTransactionErrorBase {
  readonly code = 'RUNTIME_ASSET_INVALID' as const
  readonly retryable = false

  constructor(message: string) {
    super(message)
    this.name = 'DshRuntimeAssetError'
  }
}

type CapturedRuntimeFile = {
  fact: RuntimeAssetFileFact
  bytes: Buffer
}

function sameOrInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  )
}

function checkedRelative(input: string): string {
  if (!DSH_RUNTIME_ASSET_PATHS.includes(input as (typeof DSH_RUNTIME_ASSET_PATHS)[number])
    || input.includes('\\') || path.posix.normalize(input) !== input) {
    throw new DshRuntimeAssetError('runtime asset path is outside the DSH allowlist')
  }
  return input
}

function readFile(overlayRoot: string, relativePath: string): CapturedRuntimeFile {
  const absolute = path.resolve(overlayRoot, ...relativePath.split('/'))
  if (!sameOrInside(overlayRoot, absolute) || absolute === overlayRoot) {
    throw new DshRuntimeAssetError('runtime asset escapes its overlay root')
  }
  let before: fs.Stats
  try {
    before = fs.lstatSync(absolute)
  } catch {
    throw new DshRuntimeAssetError(`required DSH runtime asset is missing: ${relativePath}`)
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new DshRuntimeAssetError('runtime asset must be a plain file')
  }
  if (before.size > 1024 * 1024) {
    throw new DshRuntimeAssetError('runtime asset exceeds the one MiB boundary')
  }
  if (path.resolve(fs.realpathSync.native(absolute)) !== absolute) {
    throw new DshRuntimeAssetError('runtime asset crosses a reparse point')
  }
  let descriptor: number | undefined
  try {
    const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0
    descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | noFollow)
    const opened = fs.fstatSync(descriptor)
    // pnpm installs immutable package payloads as content-addressed hardlinks.
    // Link count is therefore an installation fact, not a mutable-source
    // capability; identity, path, size, and digest are rechecked instead.
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new DshRuntimeAssetError('runtime asset changed while it was opened')
    }
    const bytes = Buffer.alloc(opened.size)
    let offset = 0
    while (offset < bytes.length) {
      const read = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset)
      if (read === 0) throw new DshRuntimeAssetError('runtime asset was truncated while read')
      offset += read
    }
    const after = fs.fstatSync(descriptor)
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== bytes.length) {
      throw new DshRuntimeAssetError('runtime asset changed while read')
    }
    const mode = '100644' as const
    return {
      bytes,
      fact: {
        path: relativePath,
        size: bytes.length,
        sha256: sha256Identifier(bytes),
        mode,
        isReparsePoint: false
      }
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

export function createDshRuntimeAssetRepository(options: {
  packageRoot: string
  runtimeRevision: string
}): RuntimeAssetRepositoryPort {
  if (!path.isAbsolute(options.packageRoot)) {
    throw new DshRuntimeAssetError('runtime packageRoot must be absolute')
  }
  if (!isPortableOpaqueIdentifier(options.runtimeRevision)) {
    throw new DshRuntimeAssetError('runtimeRevision must be a portable identifier')
  }
  const packageRoot = path.resolve(options.packageRoot)
  const overlayRoot = path.join(packageRoot, 'overlay')

  const scan = (): { manifest: RuntimeAssetManifestV1; files: readonly CapturedRuntimeFile[] } => {
    const packageStat = fs.lstatSync(packageRoot)
    const overlayStat = fs.lstatSync(overlayRoot)
    if (!packageStat.isDirectory() || packageStat.isSymbolicLink()
      || !overlayStat.isDirectory() || overlayStat.isSymbolicLink()) {
      throw new DshRuntimeAssetError('DSH package and overlay roots must be plain directories')
    }
    const files = DSH_RUNTIME_ASSET_PATHS.map((entry) => readFile(overlayRoot, entry))
      .sort((left, right) => Buffer.from(left.fact.path).compare(Buffer.from(right.fact.path)))
    const created = createRuntimeAssetManifest({
      runtimeRevision: options.runtimeRevision,
      files: files.map((file) => file.fact)
    })
    if (!created.ok) throw new DshRuntimeAssetError('Core rejected DSH runtime assets')
    const validation = validateRuntimeAssetManifestV1(created.manifest)
    if (!validation.valid || !verifyRuntimeAssetManifest(created.manifest)) {
      throw new DshRuntimeAssetError('Core produced an invalid DSH runtime manifest')
    }
    return { manifest: validation.value, files }
  }

  return {
    observe: () => scan().manifest,
    readVerifiedFile(input) {
      if (!input || !SHA256_PATTERN.test(input.runtimeAssetId)
        || !SHA256_PATTERN.test(input.expectedSha256)
        || !Number.isSafeInteger(input.expectedSize) || input.expectedSize < 0
        || (input.expectedMode !== '100644' && input.expectedMode !== '100755')) {
        throw new DshRuntimeAssetError('runtime content request is invalid')
      }
      const requestedPath = checkedRelative(input.path)
      const current = scan()
      if (current.manifest.runtimeAssetId !== input.runtimeAssetId) {
        throw new DshRuntimeAssetError('runtime assets changed after planning')
      }
      const expected = current.manifest.files.find((file) => file.path === requestedPath)
      if (!expected) return null
      if (expected.size !== input.expectedSize || expected.sha256 !== input.expectedSha256
        || expected.mode !== input.expectedMode) {
        throw new DshRuntimeAssetError('runtime content request does not match its manifest')
      }
      const captured = readFile(overlayRoot, requestedPath)
      if (captured.fact.sha256 !== expected.sha256 || captured.bytes.length !== expected.size) {
        throw new DshRuntimeAssetError('runtime content failed source verification')
      }
      return new Uint8Array(captured.bytes)
    }
  }
}
