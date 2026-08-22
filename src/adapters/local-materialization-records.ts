import { ApplicationTransactionErrorBase } from '../application/transaction-port.js'
import type { MaterializationRecordPort } from '../application/materialize-port.js'
import {
  type LegacyMigrationRecordV1,
  type MaterializationCommitRecordV1,
  type Sha256Identifier,
  validateLegacyMigrationRecordV1,
  validateMaterializationCommitRecordV1
} from '../contracts/index.js'
import {
  verifyLegacyMigrationRecordIdentity,
  verifyMaterializationMarker
} from '../core/materialization.js'
import type { LocalHostContext } from './host-context.js'
import type { TransactionAwarePersistPort } from './durable-state.js'

const SHA256_IDENTIFIER = /^sha256:[a-f0-9]{64}$/

export class LocalMaterializationRecordError extends ApplicationTransactionErrorBase {
  readonly code = 'STATE_CORRUPT' as const
  readonly retryable = false

  constructor(message: string) {
    super(message)
    this.name = 'LocalMaterializationRecordError'
  }
}

function identifierHex(identifier: Sha256Identifier, label: string): string {
  if (!SHA256_IDENTIFIER.test(identifier)) {
    throw new LocalMaterializationRecordError(`${label} is not a full SHA-256 identifier`)
  }
  return identifier.slice('sha256:'.length)
}

function currentFile(context: LocalHostContext, pathKey: Sha256Identifier): string {
  return context.path.join(
    context.hubRoot,
    'skill-review',
    'materializations',
    'current',
    `${identifierHex(pathKey, 'materialization path key')}.json`
  )
}

function migrationFile(context: LocalHostContext, migrationId: Sha256Identifier): string {
  return context.path.join(
    context.hubRoot,
    'skill-review',
    'materializations',
    'migrations',
    `${identifierHex(migrationId, 'legacy migration id')}.json`
  )
}

function checkedCurrent(
  value: unknown,
  expectedPathKey: Sha256Identifier
): MaterializationCommitRecordV1 {
  const validation = validateMaterializationCommitRecordV1(value)
  if (!validation.valid
    || validation.value.pathKey !== expectedPathKey
    || validation.value.marker != null && !verifyMaterializationMarker(validation.value.marker)) {
    throw new LocalMaterializationRecordError('materialization commit record failed frozen validation')
  }
  return validation.value
}

function checkedMigration(
  value: unknown,
  expectedMigrationId: Sha256Identifier
): LegacyMigrationRecordV1 {
  const validation = validateLegacyMigrationRecordV1(value)
  if (!validation.valid
    || validation.value.migrationId !== expectedMigrationId
    || !verifyLegacyMigrationRecordIdentity(validation.value)) {
    throw new LocalMaterializationRecordError('legacy migration record failed frozen validation')
  }
  return validation.value
}

export function createLocalMaterializationRecordPort(
  context: LocalHostContext,
  persist: Pick<TransactionAwarePersistPort, 'readOptionalJson' | 'writeJson'>
): MaterializationRecordPort {
  return {
    readCurrent(pathKey) {
      const value = persist.readOptionalJson<unknown>(currentFile(context, pathKey))
      return value === null ? null : checkedCurrent(value, pathKey)
    },
    writeCurrent(record) {
      const checked = checkedCurrent(record, record.pathKey)
      persist.writeJson(currentFile(context, checked.pathKey), checked)
    },
    readLegacyMigration(migrationId) {
      const value = persist.readOptionalJson<unknown>(migrationFile(context, migrationId))
      return value === null ? null : checkedMigration(value, migrationId)
    },
    writeLegacyMigration(record) {
      const checked = checkedMigration(record, record.migrationId)
      persist.writeJson(migrationFile(context, checked.migrationId), checked)
    }
  }
}
