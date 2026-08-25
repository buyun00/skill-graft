import type { InboxItemView, LastIngestView } from './state.js'
import type { Sha256Identifier } from './snapshot.js'
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
import {
  WORKTREE_PIN_V1_SCHEMA,
  type WorktreePinV1,
  validateWorktreePinV1
} from './worktree-pin.js'

export const HUB_STATE_SCHEMA_VERSION = 2 as const

export type HubStateLastIngestV2 = Omit<LastIngestView, 'gameRepo'> & {
  /** Host-produced opaque identity; never the P1 repository locator. */
  gameRepoId: Sha256Identifier
}

export type HubStateV2 = {
  schemaVersion: typeof HUB_STATE_SCHEMA_VERSION
  stateRevision: number
  runtimeRevision: string
  librarySnapshots: readonly Sha256Identifier[]
  worktrees: Readonly<Record<string, WorktreePinV1>>
  items: readonly InboxItemView[]
  lastIngest: HubStateLastIngestV2 | null
}

const SHA256_PATTERN = '^sha256:[0-9a-f]{64}$'

export const HUB_STATE_V2_SCHEMA = {
  $schema: P2_JSON_SCHEMA_DRAFT,
  $id: 'https://skill-graft.dev/schemas/hub-state-v2.schema.json',
  title: 'HubStateV2',
  type: 'object',
  required: [
    'schemaVersion',
    'stateRevision',
    'runtimeRevision',
    'librarySnapshots',
    'worktrees',
    'items',
    'lastIngest'
  ],
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', const: HUB_STATE_SCHEMA_VERSION },
    stateRevision: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
    runtimeRevision: {
      type: 'string',
      minLength: 1,
      maxLength: 256,
      pattern: PORTABLE_OPAQUE_IDENTIFIER_PATTERN,
      'x-errorCode': 'INVALID_IDENTIFIER'
    },
    librarySnapshots: {
      type: 'array',
      uniqueItems: true,
      items: {
        type: 'string',
        pattern: SHA256_PATTERN,
        'x-errorCode': 'INVALID_IDENTIFIER'
      }
    },
    worktrees: {
      type: 'object',
      additionalProperties: WORKTREE_PIN_V1_SCHEMA
    },
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'name', 'unit', 'status'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 512 },
          name: { type: 'string', minLength: 1, maxLength: 512 },
          unit: { type: 'string', minLength: 1, maxLength: 512 },
          status: {
            type: 'string',
            enum: ['queued', 'proposed', 'adopted', 'merged-into-3skill', 'rejected']
          },
          sourceRef: { type: 'string', minLength: 1, maxLength: 4096 },
          oldCommit: { type: 'string', minLength: 1, maxLength: 512 },
          newCommit: { type: 'string', minLength: 1, maxLength: 512 },
          inboxPath: {
            type: 'string',
            minLength: 1,
            maxLength: 4096,
            pattern: PORTABLE_RELATIVE_PATH_PATTERN,
            'x-errorCode': 'PATH_NOT_NORMALIZED'
          },
          adoptedPath: {
            type: 'string',
            minLength: 1,
            maxLength: 4096,
            pattern: PORTABLE_RELATIVE_PATH_PATTERN,
            'x-errorCode': 'PATH_NOT_NORMALIZED'
          },
          mergeTarget: { type: 'string', minLength: 1, maxLength: 512 },
          note: { type: 'string', maxLength: 16384 },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
          suggestion: {
            type: 'object',
            additionalProperties: false,
            properties: {
              action: { type: 'string', maxLength: 512 },
              target: { type: 'string', maxLength: 512 },
              reason: { type: 'string', maxLength: 4096 },
              confidence: { type: 'string', maxLength: 128 }
            }
          }
        }
      }
    },
    lastIngest: {
      type: ['object', 'null'],
      required: ['ref', 'old', 'new', 'gameRepoId'],
      additionalProperties: false,
      properties: {
        ref: { type: 'string', minLength: 1, maxLength: 1024 },
        old: { type: 'string', minLength: 1, maxLength: 512 },
        new: { type: 'string', minLength: 1, maxLength: 512 },
        gameRepoId: {
          type: 'string',
          pattern: SHA256_PATTERN,
          'x-errorCode': 'INVALID_IDENTIFIER'
        }
      }
    }
  }
} as const

export const HubStateV2Schema = HUB_STATE_V2_SCHEMA

export function validateHubStateV2(value: unknown): P2ValidationResult<HubStateV2> {
  const base = validateAgainstContractSchema<HubStateV2>(value, HUB_STATE_V2_SCHEMA)
  if (!base.valid) return base
  const errors: P2ValidationError[] = []
  const itemIds = new Set<string>()
  for (let index = 0; index < base.value.items.length; index += 1) {
    const item = base.value.items[index]
    const id = item.id
    if (itemIds.has(id)) {
      errors.push({
        code: 'DUPLICATE_VALUE',
        path: `$.items[${index}].id`,
        message: 'inbox item IDs must be unique within HubStateV2'
      })
    }
    itemIds.add(id)
    for (const field of ['inboxPath', 'adoptedPath'] as const) {
      const path = item[field]
      if (path != null && !isPortableRelativePath(path)) {
        errors.push({
          code: 'PATH_NOT_NORMALIZED',
          path: `$.items[${index}].${field}`,
          message: 'inbox artifact path must be a normalized portable relative path'
        })
      }
    }
  }
  const snapshots = new Set(base.value.librarySnapshots)
  let previousSnapshot: string | undefined
  for (let index = 0; index < base.value.librarySnapshots.length; index += 1) {
    const snapshot = base.value.librarySnapshots[index]
    if (previousSnapshot != null && previousSnapshot >= snapshot) {
      errors.push({
        code: previousSnapshot === snapshot ? 'DUPLICATE_VALUE' : 'INVALID_VALUE',
        path: `$.librarySnapshots[${index}]`,
        message: 'library snapshot IDs must be unique and in canonical order'
      })
    }
    previousSnapshot = snapshot
  }
  const worktreeIds = new Map<string, string>()
  for (const [key, pin] of Object.entries(base.value.worktrees)) {
    const priorPathKey = worktreeIds.get(pin.worktreeId)
    if (priorPathKey != null) {
      errors.push({
        code: 'DUPLICATE_VALUE',
        path: `$.worktrees.${key}.worktreeId`,
        message: `worktree ID is already assigned to ${priorPathKey}`
      })
    }
    worktreeIds.set(pin.worktreeId, key)
    if (!/^sha256:[0-9a-f]{64}$/.test(key)) {
      errors.push({
        code: 'INVALID_IDENTIFIER',
        path: `$.worktrees.${key}`,
        message: 'worktree map key must be a full opaque SHA-256 path key'
      })
    }
    if (key !== pin.pathKey) {
      errors.push({
        code: 'INVARIANT_VIOLATION',
        path: `$.worktrees.${key}.pathKey`,
        message: 'worktree map key must exactly match pin.pathKey'
      })
    }
    const pinValidation = validateWorktreePinV1(pin)
    if (!pinValidation.valid) {
      errors.push(...pinValidation.errors.map((entry) => ({
        ...entry,
        path: `$.worktrees.${key}${entry.path.slice(1)}`
      })))
    }
    for (const field of ['requestedSnapshot', 'materializedSnapshot'] as const) {
      const reference = pin[field]
      if (reference != null && !snapshots.has(reference)) {
        errors.push({
          code: 'REFERENCE_NOT_FOUND',
          path: `$.worktrees.${key}.${field}`,
          message: 'referenced library snapshot is not registered in this state'
        })
      }
    }
    if (pin.claimState === 'claimed' && pin.requestedSnapshot == null) {
      errors.push({
        code: 'INVARIANT_VIOLATION',
        path: `$.worktrees.${key}.requestedSnapshot`,
        message: 'claimed worktrees must request a snapshot'
      })
    }
    if (pin.claimState !== 'claimed'
      && (pin.requestedSnapshot != null || pin.materializedSnapshot != null || pin.selectedSkills.length > 0)) {
      errors.push({
        code: 'INVARIANT_VIOLATION',
        path: `$.worktrees.${key}`,
        message: 'unclaimed or detached worktrees cannot retain requested materialization state'
      })
    }
  }
  return errors.length > 0 ? invalidValidation(errors) : base
}
