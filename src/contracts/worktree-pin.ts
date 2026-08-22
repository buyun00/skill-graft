import type { Sha256Identifier } from './snapshot.js'
import {
  P2_JSON_SCHEMA_DRAFT,
  PORTABLE_OPAQUE_IDENTIFIER_PATTERN,
  type P2ValidationError,
  type P2ValidationResult,
  invalidValidation,
  validateAgainstContractSchema
} from './validation.js'

export const WORKTREE_PIN_SCHEMA_VERSION = 1 as const

export const WORKTREE_CLAIM_STATES = ['unclaimed', 'claimed', 'detached'] as const
export type WorktreeClaimState = (typeof WORKTREE_CLAIM_STATES)[number]

export type WorktreePinV1 = {
  schemaVersion: typeof WORKTREE_PIN_SCHEMA_VERSION
  pathKey: Sha256Identifier
  worktreeId: string
  requestedSnapshot: Sha256Identifier | null
  materializedSnapshot: Sha256Identifier | null
  selectedSkills: readonly string[]
  claimState: WorktreeClaimState
}

const SHA256_PATTERN = '^sha256:[0-9a-f]{64}$'
const SKILL_NAME_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'

export const WORKTREE_PIN_V1_SCHEMA = {
  $schema: P2_JSON_SCHEMA_DRAFT,
  $id: 'https://skill-graft.dev/schemas/worktree-pin-v1.schema.json',
  title: 'WorktreePinV1',
  type: 'object',
  required: [
    'schemaVersion',
    'pathKey',
    'worktreeId',
    'requestedSnapshot',
    'materializedSnapshot',
    'selectedSkills',
    'claimState'
  ],
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', const: WORKTREE_PIN_SCHEMA_VERSION },
    pathKey: {
      type: 'string',
      pattern: SHA256_PATTERN,
      'x-errorCode': 'INVALID_IDENTIFIER'
    },
    worktreeId: {
      type: 'string',
      minLength: 1,
      maxLength: 256,
      pattern: PORTABLE_OPAQUE_IDENTIFIER_PATTERN,
      'x-errorCode': 'INVALID_IDENTIFIER'
    },
    requestedSnapshot: {
      type: ['string', 'null'],
      pattern: SHA256_PATTERN,
      'x-errorCode': 'INVALID_IDENTIFIER'
    },
    materializedSnapshot: {
      type: ['string', 'null'],
      pattern: SHA256_PATTERN,
      'x-errorCode': 'INVALID_IDENTIFIER'
    },
    selectedSkills: {
      type: 'array',
      uniqueItems: true,
      items: {
        type: 'string',
        pattern: SKILL_NAME_PATTERN,
        'x-errorCode': 'INVALID_IDENTIFIER'
      }
    },
    claimState: { type: 'string', enum: WORKTREE_CLAIM_STATES }
  }
} as const

export const WorktreePinV1Schema = WORKTREE_PIN_V1_SCHEMA

export function validateWorktreePinV1(value: unknown): P2ValidationResult<WorktreePinV1> {
  const base = validateAgainstContractSchema<WorktreePinV1>(value, WORKTREE_PIN_V1_SCHEMA)
  if (!base.valid) return base
  const errors: P2ValidationError[] = []
  const seen = new Set<string>()
  let previous: string | undefined
  for (let index = 0; index < base.value.selectedSkills.length; index += 1) {
    const skill = base.value.selectedSkills[index]
    const folded = skill.toLocaleLowerCase('en-US')
    if (seen.has(folded)) {
      errors.push({
        code: 'DUPLICATE_VALUE',
        path: `$.selectedSkills[${index}]`,
        message: 'selected skill names must be unique under portable case comparison'
      })
    }
    seen.add(folded)
    // Skill names are ASCII by schema, so code-unit and UTF-8 byte order are identical.
    if (previous != null && previous >= skill) {
      errors.push({
        code: 'INVALID_VALUE',
        path: `$.selectedSkills[${index}]`,
        message: 'selected skill names must be in canonical order'
      })
    }
    previous = skill
  }
  if (base.value.claimState === 'claimed') {
    if (base.value.requestedSnapshot == null) {
      errors.push({
        code: 'INVARIANT_VIOLATION',
        path: '$.requestedSnapshot',
        message: 'claimed pin must request a snapshot'
      })
    }
  } else if (base.value.requestedSnapshot != null
    || base.value.materializedSnapshot != null
    || base.value.selectedSkills.length > 0) {
    errors.push({
      code: 'INVARIANT_VIOLATION',
      path: '$',
      message: 'unclaimed or detached pin cannot retain snapshot or selected-skill state'
    })
  }
  return errors.length > 0 ? invalidValidation(errors) : base
}
