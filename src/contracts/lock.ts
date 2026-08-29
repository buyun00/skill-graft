import {
  P2_JSON_SCHEMA_DRAFT,
  type P2ValidationError,
  type P2ValidationResult,
  invalidValidation,
  validateAgainstContractSchema
} from './validation.js'
import { WRITE_COMMAND_KINDS, type WriteCommandKind } from './commands.js'
import type { Sha256Identifier } from './snapshot.js'

export const LOCK_RECORD_SCHEMA_VERSION = 1 as const
export const LOCK_SCOPES = ['worktree', 'hub-global'] as const
export const HUB_GLOBAL_LOCK_KEY = 'hub-global' as const
export type LockScope = (typeof LOCK_SCOPES)[number]

type LockRecordFieldsV1 = {
  schemaVersion: typeof LOCK_RECORD_SCHEMA_VERSION
  ownerToken: string
  hostId: string
  pid: number
  processIdentity: string
  command: WriteCommandKind
  requestId: string
  acquiredAt: string
  heartbeatAt: string
  leaseUntil: string
}

export type LockRecordV1 = LockRecordFieldsV1 & (
  | { scope: 'worktree'; lockKey: Sha256Identifier }
  | { scope: 'hub-global'; lockKey: typeof HUB_GLOBAL_LOCK_KEY }
)

export const LOCK_RECORD_V1_SCHEMA = {
  $schema: P2_JSON_SCHEMA_DRAFT,
  $id: 'https://skill-graft.dev/schemas/lock-record-v1.schema.json',
  title: 'LockRecordV1',
  type: 'object',
  required: [
    'schemaVersion',
    'scope',
    'lockKey',
    'ownerToken',
    'hostId',
    'pid',
    'processIdentity',
    'command',
    'requestId',
    'acquiredAt',
    'heartbeatAt',
    'leaseUntil'
  ],
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', const: LOCK_RECORD_SCHEMA_VERSION },
    scope: { type: 'string', enum: LOCK_SCOPES },
    lockKey: {
      type: 'string',
      minLength: 1,
      maxLength: 256,
      pattern: '^[A-Za-z0-9:._-]+$',
      'x-errorCode': 'INVALID_IDENTIFIER'
    },
    ownerToken: { type: 'string', minLength: 16, maxLength: 64, pattern: '^[A-Za-z0-9._-]+$' },
    hostId: { type: 'string', minLength: 1, maxLength: 256, pattern: '^[A-Za-z0-9][A-Za-z0-9:._-]*$' },
    pid: { type: 'integer', minimum: 1, maximum: 9007199254740991 },
    processIdentity: { type: 'string', minLength: 1, maxLength: 512, pattern: '^[A-Za-z0-9:._-]+$' },
    command: { type: 'string', enum: WRITE_COMMAND_KINDS },
    requestId: { type: 'string', minLength: 1, maxLength: 512, pattern: '^[A-Za-z0-9:._-]+$' },
    acquiredAt: { type: 'string', format: 'date-time' },
    heartbeatAt: { type: 'string', format: 'date-time' },
    leaseUntil: { type: 'string', format: 'date-time' }
  }
} as const

export const LockRecordV1Schema = LOCK_RECORD_V1_SCHEMA

export function validateLockRecordV1(value: unknown): P2ValidationResult<LockRecordV1> {
  const base = validateAgainstContractSchema<LockRecordV1>(value, LOCK_RECORD_V1_SCHEMA)
  if (!base.valid) return base
  const errors: P2ValidationError[] = []
  const acquired = Date.parse(base.value.acquiredAt)
  const heartbeat = Date.parse(base.value.heartbeatAt)
  const leaseUntil = Date.parse(base.value.leaseUntil)
  if (base.value.scope === 'hub-global' && base.value.lockKey !== HUB_GLOBAL_LOCK_KEY) {
    errors.push({
      code: 'INVARIANT_VIOLATION',
      path: '$.lockKey',
      message: `hub-global locks must use the fixed ${HUB_GLOBAL_LOCK_KEY} key`
    })
  }
  if (base.value.scope === 'worktree' && !/^sha256:[0-9a-f]{64}$/.test(base.value.lockKey)) {
    errors.push({
      code: 'INVALID_IDENTIFIER',
      path: '$.lockKey',
      message: 'worktree locks must use a full opaque SHA-256 path key'
    })
  }
  if (heartbeat < acquired) {
    errors.push({
      code: 'INVARIANT_VIOLATION',
      path: '$.heartbeatAt',
      message: 'heartbeat cannot precede lock acquisition'
    })
  }
  if (leaseUntil <= heartbeat) {
    errors.push({
      code: 'INVARIANT_VIOLATION',
      path: '$.leaseUntil',
      message: 'lease must expire after the last heartbeat'
    })
  }
  return errors.length > 0 ? invalidValidation(errors) : base
}
