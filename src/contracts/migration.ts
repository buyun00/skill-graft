import {
  HUB_STATE_V2_SCHEMA,
  type HubStateV2,
  validateHubStateV2
} from './hub-state-v2.js'
import type { Sha256Identifier } from './snapshot.js'
import {
  P2_JSON_SCHEMA_DRAFT,
  PORTABLE_OPAQUE_IDENTIFIER_PATTERN,
  type P2ValidationError,
  type P2ValidationResult,
  invalidValidation,
  validateAgainstContractSchema
} from './validation.js'

export const MIGRATION_PLAN_SCHEMA_VERSION = 1 as const

export const MIGRATION_WORKTREE_CLASSIFICATIONS = ['claimed', 'linked', 'unmanaged'] as const
export type MigrationWorktreeClassification = (typeof MIGRATION_WORKTREE_CLASSIFICATIONS)[number]

export const MIGRATION_WARNING_CODES = [
  'CLAIM_REQUIRES_MATERIALIZATION',
  'LEGACY_LINK_RETAINED'
] as const
export type MigrationWarningCode = (typeof MIGRATION_WARNING_CODES)[number]

export type MigrationWorktreeV1 = {
  pathKey: Sha256Identifier
  worktreeId: string
  classification: MigrationWorktreeClassification
  requestedSnapshot: Sha256Identifier | null
  selectedSkills: readonly string[]
}

export type MigrationWarningV1 = {
  code: MigrationWarningCode
  pathKey: Sha256Identifier
  message: string
}

export type MigrationPlanV1 = {
  schemaVersion: typeof MIGRATION_PLAN_SCHEMA_VERSION
  sourceSchemaVersion: 1
  targetSchemaVersion: 2
  sourceDigest: Sha256Identifier
  planHash: Sha256Identifier
  targetState: HubStateV2
  worktrees: readonly MigrationWorktreeV1[]
  warnings: readonly MigrationWarningV1[]
}

const SHA256_PATTERN = '^sha256:[0-9a-f]{64}$'
const SKILL_NAME_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'

export const MIGRATION_PLAN_V1_SCHEMA = {
  $schema: P2_JSON_SCHEMA_DRAFT,
  $id: 'https://skill-graft.dev/schemas/migration-plan-v1.schema.json',
  title: 'MigrationPlanV1',
  type: 'object',
  required: [
    'schemaVersion',
    'sourceSchemaVersion',
    'targetSchemaVersion',
    'sourceDigest',
    'planHash',
    'targetState',
    'worktrees',
    'warnings'
  ],
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', const: MIGRATION_PLAN_SCHEMA_VERSION },
    sourceSchemaVersion: { type: 'integer', const: 1 },
    targetSchemaVersion: { type: 'integer', const: 2 },
    sourceDigest: { type: 'string', pattern: SHA256_PATTERN, 'x-errorCode': 'INVALID_IDENTIFIER' },
    planHash: { type: 'string', pattern: SHA256_PATTERN, 'x-errorCode': 'INVALID_IDENTIFIER' },
    targetState: HUB_STATE_V2_SCHEMA,
    worktrees: {
      type: 'array',
      items: {
        type: 'object',
        required: ['pathKey', 'worktreeId', 'classification', 'requestedSnapshot', 'selectedSkills'],
        additionalProperties: false,
        properties: {
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
          classification: { type: 'string', enum: MIGRATION_WORKTREE_CLASSIFICATIONS },
          requestedSnapshot: {
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
          }
        }
      }
    },
    warnings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['code', 'pathKey', 'message'],
        additionalProperties: false,
        properties: {
          code: { type: 'string', enum: MIGRATION_WARNING_CODES },
          pathKey: {
            type: 'string',
            pattern: SHA256_PATTERN,
            'x-errorCode': 'INVALID_IDENTIFIER'
          },
          message: { type: 'string', minLength: 1, maxLength: 1024 }
        }
      }
    }
  }
} as const

export const MigrationPlanV1Schema = MIGRATION_PLAN_V1_SCHEMA

function nestedPath(path: string, prefix: string): string {
  return path === '$' ? prefix : `${prefix}${path.slice(1)}`
}

export function validateMigrationPlanV1(value: unknown): P2ValidationResult<MigrationPlanV1> {
  const base = validateAgainstContractSchema<MigrationPlanV1>(value, MIGRATION_PLAN_V1_SCHEMA)
  if (!base.valid) return base
  const errors: P2ValidationError[] = []
  const stateValidation = validateHubStateV2(base.value.targetState)
  if (!stateValidation.valid) {
    errors.push(...stateValidation.errors.map((entry) => ({
      ...entry,
      path: nestedPath(entry.path, '$.targetState')
    })))
  }
  const pathKeys = new Set<string>()
  const expectedWarnings = new Map<string, MigrationWarningCode>()
  let previousPathKey: string | undefined
  for (let index = 0; index < base.value.worktrees.length; index += 1) {
    const entry = base.value.worktrees[index]
    if (pathKeys.has(entry.pathKey)) {
      errors.push({
        code: 'DUPLICATE_VALUE',
        path: `$.worktrees[${index}].pathKey`,
        message: 'migration worktree path key must be unique'
      })
    }
    pathKeys.add(entry.pathKey)
    if (previousPathKey != null && previousPathKey >= entry.pathKey) {
      errors.push({
        code: 'INVALID_VALUE',
        path: `$.worktrees[${index}].pathKey`,
        message: 'migration worktrees must be in canonical path-key order'
      })
    }
    previousPathKey = entry.pathKey
    const selected = new Set<string>()
    let previousSkill: string | undefined
    for (let skillIndex = 0; skillIndex < entry.selectedSkills.length; skillIndex += 1) {
      const skill = entry.selectedSkills[skillIndex]
      const folded = skill.toLocaleLowerCase('en-US')
      if (selected.has(folded)) {
        errors.push({
          code: 'DUPLICATE_VALUE',
          path: `$.worktrees[${index}].selectedSkills[${skillIndex}]`,
          message: 'migration selected skills collide under portable case comparison'
        })
      }
      selected.add(folded)
      if (previousSkill != null && previousSkill >= skill) {
        errors.push({
          code: 'INVALID_VALUE',
          path: `$.worktrees[${index}].selectedSkills[${skillIndex}]`,
          message: 'migration selected skills must be in canonical order'
        })
      }
      previousSkill = skill
    }
    const targetPin = base.value.targetState.worktrees[entry.pathKey]
    if (entry.classification === 'unmanaged') {
      if (entry.requestedSnapshot != null || entry.selectedSkills.length > 0 || targetPin != null) {
        errors.push({
          code: 'INVARIANT_VIOLATION',
          path: `$.worktrees[${index}]`,
          message: 'unmanaged worktree must have no request, selected skills, or target-state pin'
        })
      }
      continue
    }
    expectedWarnings.set(
      entry.pathKey,
      entry.classification === 'claimed' ? 'CLAIM_REQUIRES_MATERIALIZATION' : 'LEGACY_LINK_RETAINED'
    )
    if (entry.requestedSnapshot == null) {
      errors.push({
        code: 'INVARIANT_VIOLATION',
        path: `$.worktrees[${index}].requestedSnapshot`,
        message: 'managed migration worktree must request a snapshot'
      })
    }
    if (targetPin == null) {
      errors.push({
        code: 'REFERENCE_NOT_FOUND',
        path: `$.worktrees[${index}].pathKey`,
        message: 'managed migration worktree is missing from target state'
      })
    }
    if (targetPin != null && (targetPin.claimState !== 'claimed'
      || targetPin.materializedSnapshot !== null
      || targetPin.requestedSnapshot === null
      || targetPin.requestedSnapshot !== entry.requestedSnapshot
      || targetPin.worktreeId !== entry.worktreeId
      || targetPin.selectedSkills.length !== entry.selectedSkills.length
      || targetPin.selectedSkills.some((skill, skillIndex) => skill !== entry.selectedSkills[skillIndex]))) {
      errors.push({
        code: 'INVARIANT_VIOLATION',
        path: `$.worktrees[${index}]`,
        message: 'migration classification must match the corresponding target-state pin'
      })
    }
  }
  for (const targetPathKey of Object.keys(base.value.targetState.worktrees)) {
    if (!expectedWarnings.has(targetPathKey)) {
      errors.push({
        code: 'INVARIANT_VIOLATION',
        path: `$.targetState.worktrees.${targetPathKey}`,
        message: 'target-state pin has no corresponding managed migration worktree'
      })
    }
  }
  let previousWarning: string | undefined
  const observedWarnings = new Set<string>()
  for (let index = 0; index < base.value.warnings.length; index += 1) {
    const warning = base.value.warnings[index]
    const key = `${warning.code}\0${warning.pathKey}`
    if (previousWarning != null && previousWarning >= key) {
      errors.push({
        code: 'INVALID_VALUE',
        path: `$.warnings[${index}]`,
        message: 'migration warnings must be in canonical code/path-key order'
      })
    }
    previousWarning = key
    const expectedCode = expectedWarnings.get(warning.pathKey)
    if (expectedCode == null || expectedCode !== warning.code || observedWarnings.has(warning.pathKey)) {
      errors.push({
        code: observedWarnings.has(warning.pathKey) ? 'DUPLICATE_VALUE' : 'INVARIANT_VIOLATION',
        path: `$.warnings[${index}]`,
        message: 'migration warnings must contain exactly one classification warning per managed worktree'
      })
    }
    observedWarnings.add(warning.pathKey)
  }
  for (const pathKey of expectedWarnings.keys()) {
    if (!observedWarnings.has(pathKey)) {
      errors.push({
        code: 'INVARIANT_VIOLATION',
        path: '$.warnings',
        message: `migration warning is missing for managed worktree ${pathKey}`
      })
    }
  }
  return errors.length > 0 ? invalidValidation(errors) : base
}
