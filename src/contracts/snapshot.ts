import {
  P2_JSON_SCHEMA_DRAFT,
  PORTABLE_OPAQUE_IDENTIFIER_PATTERN,
  PORTABLE_RELATIVE_PATH_PATTERN,
  type P2ValidationError,
  type P2ValidationResult,
  invalidValidation,
  isPortableRelativePath,
  validateAgainstContractSchema
} from './validation.js'

export const LIBRARY_SNAPSHOT_SCHEMA_VERSION = 1 as const

export type Sha256Identifier = `sha256:${string}`

export type LibrarySnapshotSourceV1 = {
  kind: 'library'
  id: string
  revision?: string
}

export type LibrarySnapshotFileV1 = {
  path: string
  size: number
  sha256: Sha256Identifier
  mode: '100644' | '100755'
}

export type LibrarySnapshotManifestV1 = {
  schemaVersion: typeof LIBRARY_SNAPSHOT_SCHEMA_VERSION
  snapshotId: Sha256Identifier
  source: LibrarySnapshotSourceV1
  createdAt: string
  files: readonly LibrarySnapshotFileV1[]
}

const SHA256_PATTERN = '^sha256:[0-9a-f]{64}$'

export const LIBRARY_SNAPSHOT_MANIFEST_V1_SCHEMA = {
  $schema: P2_JSON_SCHEMA_DRAFT,
  $id: 'https://skill-graft.dev/schemas/library-snapshot-manifest-v1.schema.json',
  title: 'LibrarySnapshotManifestV1',
  type: 'object',
  required: ['schemaVersion', 'snapshotId', 'source', 'createdAt', 'files'],
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', const: LIBRARY_SNAPSHOT_SCHEMA_VERSION },
    snapshotId: { type: 'string', pattern: SHA256_PATTERN, 'x-errorCode': 'INVALID_IDENTIFIER' },
    source: {
      type: 'object',
      required: ['kind', 'id'],
      additionalProperties: false,
      properties: {
        kind: { type: 'string', const: 'library' },
        id: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
          pattern: PORTABLE_OPAQUE_IDENTIFIER_PATTERN,
          'x-errorCode': 'INVALID_IDENTIFIER'
        },
        revision: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
          pattern: PORTABLE_OPAQUE_IDENTIFIER_PATTERN,
          'x-errorCode': 'INVALID_IDENTIFIER'
        }
      }
    },
    createdAt: { type: 'string', format: 'date-time' },
    files: {
      type: 'array',
      uniqueItems: true,
      items: {
        type: 'object',
        required: ['path', 'size', 'sha256', 'mode'],
        additionalProperties: false,
        properties: {
          path: {
            type: 'string',
            minLength: 1,
            maxLength: 4096,
            pattern: PORTABLE_RELATIVE_PATH_PATTERN,
            'x-errorCode': 'PATH_NOT_NORMALIZED'
          },
          size: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
          sha256: { type: 'string', pattern: SHA256_PATTERN, 'x-errorCode': 'INVALID_IDENTIFIER' },
          mode: { type: 'string', enum: ['100644', '100755'] }
        }
      }
    }
  }
} as const

export const LibrarySnapshotManifestV1Schema = LIBRARY_SNAPSHOT_MANIFEST_V1_SCHEMA

function portablePathKey(path: string): string {
  return path.normalize('NFC')
    .split('/')
    .map((segment) => segment.replace(/[ .]+$/u, '').toLocaleLowerCase('en-US'))
    .join('/')
}

function validManifestPath(path: string): boolean {
  return isPortableRelativePath(path)
}

function utf8(path: string): readonly number[] {
  const bytes: number[] = []
  for (const character of path) {
    const point = character.codePointAt(0) ?? 0
    if (point <= 0x7f) bytes.push(point)
    else if (point <= 0x7ff) bytes.push(0xc0 | point >>> 6, 0x80 | point & 0x3f)
    else if (point <= 0xffff) bytes.push(0xe0 | point >>> 12, 0x80 | point >>> 6 & 0x3f, 0x80 | point & 0x3f)
    else bytes.push(0xf0 | point >>> 18, 0x80 | point >>> 12 & 0x3f, 0x80 | point >>> 6 & 0x3f, 0x80 | point & 0x3f)
  }
  return bytes
}

function compareUtf8(left: string, right: string): number {
  const a = utf8(left)
  const b = utf8(right)
  const length = Math.min(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return a.length - b.length
}

export function validateLibrarySnapshotManifestV1(value: unknown): P2ValidationResult<LibrarySnapshotManifestV1> {
  const base = validateAgainstContractSchema<LibrarySnapshotManifestV1>(value, LIBRARY_SNAPSHOT_MANIFEST_V1_SCHEMA)
  if (!base.valid) return base
  const errors: P2ValidationError[] = []
  const paths = new Set<string>()
  let previous: string | undefined
  for (let index = 0; index < base.value.files.length; index += 1) {
    const file = base.value.files[index]
    if (!validManifestPath(file.path)) {
      errors.push({
        code: 'PATH_NOT_NORMALIZED',
        path: `$.files[${index}].path`,
        message: 'manifest path contains a non-portable or non-normalized segment'
      })
    }
    const key = portablePathKey(file.path)
    if (paths.has(key)) {
      errors.push({
        code: 'PATH_COLLISION',
        path: `$.files[${index}].path`,
        message: 'file path collides under portable case-insensitive comparison'
      })
    }
    paths.add(key)
    if (previous != null && compareUtf8(previous, file.path) >= 0) {
      errors.push({
        code: previous === file.path ? 'DUPLICATE_VALUE' : 'INVALID_VALUE',
        path: `$.files[${index}].path`,
        message: 'manifest files must be strictly ordered by UTF-8 path bytes'
      })
    }
    previous = file.path
  }
  return errors.length > 0 ? invalidValidation(errors) : base
}
