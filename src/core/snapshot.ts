import {
  LIBRARY_SNAPSHOT_SCHEMA_VERSION,
  type LibrarySnapshotFileV1,
  type LibrarySnapshotManifestV1,
  type LibrarySnapshotSourceV1,
  type Sha256Identifier,
  validateLibrarySnapshotManifestV1
} from '../contracts/index.js'
import {
  canonicalJson,
  compareUtf8Bytes,
  domainSeparatedSha256,
  type CanonicalJsonValue
} from './canonical.js'

export const LIBRARY_SNAPSHOT_HASH_DOMAIN = 'skill-graft/library-snapshot/v1' as const

export type LibrarySnapshotFileFact = {
  path: string
  size: number
  sha256: string
  mode: '100644' | '100755'
  isReparsePoint: boolean
  mtimeMs?: number
  absolutePath?: string
}

export type LibrarySnapshotManifestInput = {
  source: LibrarySnapshotSourceV1
  createdAt: string
  files: readonly LibrarySnapshotFileFact[]
  absoluteRoot?: string
}

export type SnapshotCreationErrorCode =
  | 'SNAPSHOT_INPUT_INVALID'
  | 'SNAPSHOT_PATH_INVALID'
  | 'SNAPSHOT_PATH_COLLISION'
  | 'SNAPSHOT_REPARSE_FACT_REQUIRED'
  | 'SNAPSHOT_REPARSE_FORBIDDEN'
  | 'SNAPSHOT_FILE_INVALID'

export type SnapshotCreationError = {
  code: SnapshotCreationErrorCode
  path: string
  message: string
}

export type SnapshotCreationResult =
  | {
      ok: true
      manifest: LibrarySnapshotManifestV1
      canonicalPayload: string
    }
  | {
      ok: false
      errors: readonly SnapshotCreationError[]
    }

const SHA256_IDENTIFIER = /^sha256:[0-9a-f]{64}$/i

function wellFormedUnicode(value: string): boolean {
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

function windowsReservedBasename(segment: string): boolean {
  const basename = segment.split('.', 1)[0].toLocaleUpperCase('en-US')
  return /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(basename)
}

function normalizeRelativePath(input: string): string | null {
  if (!input || !wellFormedUnicode(input) || input !== input.trim() || /^[A-Za-z]:/.test(input) || /^[\\/]/.test(input)) return null
  let normalized = input.replaceAll('\\', '/').normalize('NFC')
  while (normalized.startsWith('./')) normalized = normalized.slice(2)
  const segments = normalized.split('/')
  if (segments.length === 0 || segments.some((segment) => {
    return segment.length === 0
      || segment === '.'
      || segment === '..'
      || /[<>"|?*\u0000-\u001f\u007f:]/u.test(segment)
      || /[ .]$/u.test(segment)
      || windowsReservedBasename(segment)
  })) return null
  return segments.join('/')
}

function portableRelativePathKey(path: string): string {
  return path.split('/').map((segment) => segment.toLocaleLowerCase('en-US')).join('/')
}

function normalizedFile(
  fact: LibrarySnapshotFileFact,
  index: number,
  errors: SnapshotCreationError[]
): LibrarySnapshotFileV1 | null {
  const field = `files[${index}]`
  const path = typeof fact?.path === 'string' ? normalizeRelativePath(fact.path) : null
  if (path == null) {
    errors.push({
      code: 'SNAPSHOT_PATH_INVALID',
      path: `${field}.path`,
      message: 'snapshot file path must be a normalized portable relative path'
    })
  }
  if (typeof fact?.isReparsePoint !== 'boolean') {
    errors.push({
      code: 'SNAPSHOT_REPARSE_FACT_REQUIRED',
      path: `${field}.isReparsePoint`,
      message: 'snapshot traversal must provide an explicit reparse-point fact'
    })
  } else if (fact.isReparsePoint) {
    errors.push({
      code: 'SNAPSHOT_REPARSE_FORBIDDEN',
      path: `${field}.isReparsePoint`,
      message: 'snapshot input cannot contain a reparse point'
    })
  }
  if (!Number.isSafeInteger(fact?.size) || fact.size < 0
    || typeof fact?.sha256 !== 'string' || !SHA256_IDENTIFIER.test(fact.sha256)
    || fact?.mode !== '100644' && fact?.mode !== '100755') {
    errors.push({
      code: 'SNAPSHOT_FILE_INVALID',
      path: field,
      message: 'snapshot file requires nonnegative safe size, SHA-256 content ID, and portable file mode'
    })
  }
  if (path == null || errors.some((entry) => entry.path === field || entry.path.startsWith(`${field}.`))) return null
  return {
    path,
    size: fact.size,
    sha256: fact.sha256.toLowerCase() as Sha256Identifier,
    mode: fact.mode
  }
}

export function canonicalLibrarySnapshotPayload(manifest: LibrarySnapshotManifestV1): string {
  return canonicalJson({
    schemaVersion: LIBRARY_SNAPSHOT_SCHEMA_VERSION,
    files: manifest.files.map((file) => ({
      path: file.path,
      size: file.size,
      sha256: file.sha256,
      mode: file.mode
    }))
  } satisfies CanonicalJsonValue)
}

export function createLibrarySnapshotManifest(input: LibrarySnapshotManifestInput): SnapshotCreationResult {
  const errors: SnapshotCreationError[] = []
  if (input == null || typeof input !== 'object'
    || input.source == null || typeof input.source !== 'object'
    || input.source.kind !== 'library'
    || typeof input.source.id !== 'string' || !input.source.id.trim()
    || input.source.revision != null && typeof input.source.revision !== 'string'
    || typeof input.createdAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(input.createdAt)
    || !Number.isFinite(Date.parse(input.createdAt))
    || !Array.isArray(input.files)) {
    return {
      ok: false,
      errors: [{ code: 'SNAPSHOT_INPUT_INVALID', path: '$', message: 'snapshot provenance and file facts are required' }]
    }
  }
  const files = input.files
    .map((fact, index) => normalizedFile(fact, index, errors))
    .filter((file): file is LibrarySnapshotFileV1 => file != null)
    .sort((left, right) => compareUtf8Bytes(left.path, right.path))

  const portablePaths = new Map<string, string>()
  for (const file of files) {
    const portable = portableRelativePathKey(file.path)
    const previous = portablePaths.get(portable)
    if (previous != null) {
      errors.push({
        code: 'SNAPSHOT_PATH_COLLISION',
        path: file.path,
        message: `snapshot path collides with ${previous} under portable comparison`
      })
    }
    portablePaths.set(portable, file.path)
  }
  if (errors.length > 0) return { ok: false, errors }

  const source: LibrarySnapshotSourceV1 = {
    kind: 'library',
    id: input.source.id.trim(),
    ...(input.source.revision?.trim() ? { revision: input.source.revision.trim() } : {})
  }
  const withoutId: LibrarySnapshotManifestV1 = {
    schemaVersion: LIBRARY_SNAPSHOT_SCHEMA_VERSION,
    snapshotId: `sha256:${'0'.repeat(64)}`,
    source,
    createdAt: input.createdAt,
    files
  }
  const canonicalPayload = canonicalLibrarySnapshotPayload(withoutId)
  const manifest: LibrarySnapshotManifestV1 = {
    ...withoutId,
    snapshotId: domainSeparatedSha256(LIBRARY_SNAPSHOT_HASH_DOMAIN, canonicalPayload)
  }
  const validation = validateLibrarySnapshotManifestV1(manifest)
  if (!validation.valid) {
    return {
      ok: false,
      errors: validation.errors.map((entry) => ({
        code: 'SNAPSHOT_INPUT_INVALID',
        path: entry.path,
        message: entry.message
      }))
    }
  }
  return { ok: true, manifest, canonicalPayload }
}

export function verifyLibrarySnapshotManifest(manifest: unknown): manifest is LibrarySnapshotManifestV1 {
  const validation = validateLibrarySnapshotManifestV1(manifest)
  return validation.valid
    && domainSeparatedSha256(LIBRARY_SNAPSHOT_HASH_DOMAIN, canonicalLibrarySnapshotPayload(validation.value))
      === validation.value.snapshotId
}
