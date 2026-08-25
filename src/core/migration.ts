import {
  HUB_STATE_SCHEMA_VERSION,
  MIGRATION_PLAN_SCHEMA_VERSION,
  WORKTREE_PIN_SCHEMA_VERSION,
  type HubStateV2,
  type InboxItemView,
  type LastIngestView,
  type MigrationPlanV1,
  type MigrationWarningV1,
  type MigrationWorktreeV1,
  type Sha256Identifier,
  type WorktreePinV1,
  isPortableOpaqueIdentifier,
  isRecord,
  validateHubStateV2,
  validateMigrationPlanV1
} from '../contracts/index.js'
import {
  canonicalJson,
  compareUtf8Bytes,
  domainSeparatedSha256,
  type CanonicalJsonValue
} from './canonical.js'

export const MIGRATION_PLAN_HASH_DOMAIN = 'skill-graft/state-migration-plan/v1' as const

export type LegacyHubStateV1 = {
  schemaVersion: 1
  stateRevision?: number
  items?: readonly InboxItemView[]
  inboxItems?: readonly InboxItemView[]
  lastIngest: LastIngestView | null
}

export type LegacyHubStateValidationResult =
  | { valid: true; value: LegacyHubStateV1 }
  | { valid: false }

const LEGACY_STATE_KEYS = new Set([
  'schemaVersion',
  'version',
  'stateRevision',
  'items',
  'inboxItems',
  'lastIngest'
])

function validLegacyText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

function validateLegacyLastIngest(value: unknown): LastIngestView | null | undefined {
  if (value === null) return null
  if (!isRecord(value)
    || Object.keys(value).length !== 4
    || !Object.hasOwn(value, 'ref')
    || !Object.hasOwn(value, 'old')
    || !Object.hasOwn(value, 'new')
    || !Object.hasOwn(value, 'gameRepo')
    || !validLegacyText(value.ref, 1024)
    || !validLegacyText(value.old, 512)
    || !validLegacyText(value.new, 512)
    || !validLegacyText(value.gameRepo, 4096)) return undefined
  return {
    ref: value.ref,
    old: value.old,
    new: value.new,
    gameRepo: value.gameRepo
  }
}

/**
 * Strictly accepts the two real V1 document spellings and returns one shared
 * semantic shape. Validation deliberately carries no attacker-controlled
 * field names or values across the Application boundary.
 */
export function validateLegacyHubStateV1(value: unknown): LegacyHubStateValidationResult {
  if (!isRecord(value)) return { valid: false }
  const record = value
  if (Object.keys(record).some((key) => !LEGACY_STATE_KEYS.has(key))) return { valid: false }
  if (record.schemaVersion !== undefined && record.version !== undefined) return { valid: false }
  if (record.schemaVersion !== undefined && record.schemaVersion !== 1
    || record.version !== undefined && record.version !== 1
    || record.schemaVersion !== 1 && record.version !== 1) return { valid: false }
  if (record.stateRevision !== undefined
    && (!Number.isSafeInteger(record.stateRevision) || (record.stateRevision as number) < 0
      || (record.stateRevision as number) >= Number.MAX_SAFE_INTEGER)) return { valid: false }
  if (record.items !== undefined && record.inboxItems !== undefined) return { valid: false }
  const items = record.items ?? record.inboxItems ?? []
  if (!Array.isArray(items)) return { valid: false }
  // Earliest P1 state files omitted lastIngest until the first successful
  // ingest. Absence is the one supported legacy spelling of semantic null;
  // an explicitly present value is still validated strictly below.
  const lastIngest = validateLegacyLastIngest(Object.hasOwn(record, 'lastIngest') ? record.lastIngest : null)
  if (lastIngest === undefined) return { valid: false }
  const semantic = validateHubStateV2({
    schemaVersion: HUB_STATE_SCHEMA_VERSION,
    stateRevision: 0,
    runtimeRevision: 'legacy-state-validation',
    librarySnapshots: [],
    worktrees: {},
    items,
    lastIngest: null
  })
  if (!semantic.valid) return { valid: false }
  return {
    valid: true,
    value: {
      schemaVersion: 1,
      ...(typeof record.stateRevision === 'number' ? { stateRevision: record.stateRevision } : {}),
      items: semantic.value.items,
      lastIngest
    }
  }
}

export type LegacyWorktreeMigrationFact = {
  pathKey: Sha256Identifier
  worktreeId: string
  linked: boolean
  claimed: boolean
  selectedSkills: readonly string[]
}

export type V1ToV2MigrationInput = {
  sourceDigest: Sha256Identifier
  runtimeRevision: string
  /** Host-canonicalized opaque identity matching legacyState.lastIngest. */
  lastIngestGameRepoId: Sha256Identifier | null
  defaultSnapshot: Sha256Identifier
  librarySnapshots: readonly Sha256Identifier[]
  legacyState: LegacyHubStateV1
  worktrees: readonly LegacyWorktreeMigrationFact[]
}

export type MigrationPlanningErrorCode =
  | 'MIGRATION_INPUT_INVALID'
  | 'MIGRATION_SNAPSHOT_NOT_FOUND'
  | 'MIGRATION_WORKTREE_COLLISION'
  | 'MIGRATION_PLAN_INVALID'

export type MigrationPlanningResult =
  | { ok: true; plan: MigrationPlanV1; canonicalPayload: string }
  | {
      ok: false
      errors: readonly {
        code: MigrationPlanningErrorCode
        path: string
        message: string
      }[]
    }

const SHA256_IDENTIFIER = /^sha256:[0-9a-f]{64}$/
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const LEGACY_WORKTREE_KEYS = new Set([
  'pathKey',
  'worktreeId',
  'linked',
  'claimed',
  'selectedSkills'
])

function canonicalSkills(skills: readonly string[]): readonly string[] | null {
  const normalized = skills.map((skill) => skill.trim()).sort(compareUtf8Bytes)
  const seen = new Set<string>()
  for (const skill of normalized) {
    const folded = skill.toLocaleLowerCase('en-US')
    if (!SKILL_NAME.test(skill) || seen.has(folded)) return null
    seen.add(folded)
  }
  return normalized
}

export function canonicalMigrationPlanPayload(plan: MigrationPlanV1): string {
  const { planHash: _planHash, ...payload } = plan
  return canonicalJson(payload as unknown as CanonicalJsonValue)
}

export function planV1ToV2Migration(input: V1ToV2MigrationInput): MigrationPlanningResult {
  if (!isRecord(input)) {
    return {
      ok: false,
      errors: [{ code: 'MIGRATION_INPUT_INVALID', path: '$', message: 'V1 migration facts are incomplete or invalid' }]
    }
  }
  const legacyValidation = validateLegacyHubStateV1(input.legacyState)
  if (!legacyValidation.valid) {
    return {
      ok: false,
      errors: [{ code: 'MIGRATION_INPUT_INVALID', path: '$.legacyState', message: 'legacy state failed strict V1 validation' }]
    }
  }
  const legacyState = legacyValidation.value
  if (typeof input.sourceDigest !== 'string'
    || !SHA256_IDENTIFIER.test(input.sourceDigest)
    || typeof input.defaultSnapshot !== 'string'
    || !SHA256_IDENTIFIER.test(input.defaultSnapshot)
    || !isPortableOpaqueIdentifier(input.runtimeRevision)
    || input.lastIngestGameRepoId !== null
      && (typeof input.lastIngestGameRepoId !== 'string'
        || !SHA256_IDENTIFIER.test(input.lastIngestGameRepoId))
    || (legacyState.lastIngest === null) !== (input.lastIngestGameRepoId === null)
    || !Array.isArray(input.librarySnapshots)
    || input.librarySnapshots.some((snapshot) => typeof snapshot !== 'string' || !SHA256_IDENTIFIER.test(snapshot))
    || !Array.isArray(input.worktrees)
    || input.worktrees.some((entry) => !isRecord(entry)
      || Object.keys(entry).length !== LEGACY_WORKTREE_KEYS.size
      || Object.keys(entry).some((key) => !LEGACY_WORKTREE_KEYS.has(key))
      || typeof entry.pathKey !== 'string'
      || !isPortableOpaqueIdentifier(entry.worktreeId)
      || typeof entry.linked !== 'boolean'
      || typeof entry.claimed !== 'boolean'
      || !Array.isArray(entry.selectedSkills)
      || entry.selectedSkills.some((skill: unknown) => typeof skill !== 'string'))) {
    return {
      ok: false,
      errors: [{ code: 'MIGRATION_INPUT_INVALID', path: '$', message: 'V1 migration facts are incomplete or invalid' }]
    }
  }

  const librarySnapshots = [...new Set(input.librarySnapshots)].sort(compareUtf8Bytes)
  if (!librarySnapshots.includes(input.defaultSnapshot)) {
    return {
      ok: false,
      errors: [{
        code: 'MIGRATION_SNAPSHOT_NOT_FOUND',
        path: '$.defaultSnapshot',
        message: 'default snapshot must be registered before migration'
      }]
    }
  }

  const worktrees: MigrationWorktreeV1[] = []
  const targetWorktrees: Record<string, WorktreePinV1> = {}
  const warnings: MigrationWarningV1[] = []
  const seenPathKeys = new Set<string>()
  const sortedFacts = [...input.worktrees].sort((left, right) => compareUtf8Bytes(left.pathKey, right.pathKey))
  for (let index = 0; index < sortedFacts.length; index += 1) {
    const fact = sortedFacts[index]
    const classification = fact.claimed ? 'claimed' : fact.linked ? 'linked' : 'unmanaged'
    const selectedSkills = classification === 'unmanaged' ? [] : canonicalSkills(fact.selectedSkills)
    if (!SHA256_IDENTIFIER.test(fact.pathKey)
      || !isPortableOpaqueIdentifier(fact.worktreeId)
      || selectedSkills == null) {
      return {
        ok: false,
        errors: [{
          code: 'MIGRATION_INPUT_INVALID',
          path: `$.worktrees[${index}]`,
          message: 'worktree migration fact contains an invalid opaque key, ID, or selected skill'
        }]
      }
    }
    if (seenPathKeys.has(fact.pathKey)) {
      return {
        ok: false,
        errors: [{
          code: 'MIGRATION_WORKTREE_COLLISION',
          path: `$.worktrees[${index}].pathKey`,
          message: 'worktree path keys must be unique'
        }]
      }
    }
    seenPathKeys.add(fact.pathKey)
    const requestedSnapshot = classification === 'unmanaged' ? null : input.defaultSnapshot
    worktrees.push({
      pathKey: fact.pathKey,
      worktreeId: fact.worktreeId,
      classification,
      requestedSnapshot,
      selectedSkills
    })
    if (classification !== 'unmanaged') {
      targetWorktrees[fact.pathKey] = {
        schemaVersion: WORKTREE_PIN_SCHEMA_VERSION,
        pathKey: fact.pathKey,
        worktreeId: fact.worktreeId,
        requestedSnapshot: input.defaultSnapshot,
        materializedSnapshot: null,
        selectedSkills,
        claimState: 'claimed'
      }
      warnings.push(classification === 'claimed'
        ? {
            code: 'CLAIM_REQUIRES_MATERIALIZATION',
            pathKey: fact.pathKey,
            message: 'existing claim requests the default snapshot but remains unmaterialized in P2'
          }
        : {
            code: 'LEGACY_LINK_RETAINED',
            pathKey: fact.pathKey,
            message: 'legacy link is recognized but retained until the explicit P3 migration'
          })
    }
  }

  warnings.sort((left, right) => compareUtf8Bytes(left.code, right.code) || compareUtf8Bytes(left.pathKey, right.pathKey))
  const legacyRevision = legacyState.stateRevision ?? 0
  if (!Number.isSafeInteger(legacyRevision) || legacyRevision < 0 || legacyRevision >= Number.MAX_SAFE_INTEGER) {
    return {
      ok: false,
      errors: [{ code: 'MIGRATION_INPUT_INVALID', path: '$.legacyState.stateRevision', message: 'state revision must be nonnegative' }]
    }
  }
  const legacyItems = legacyState.items ?? []
  if (!Array.isArray(legacyItems)) {
    return {
      ok: false,
      errors: [{ code: 'MIGRATION_INPUT_INVALID', path: '$.legacyState.items', message: 'legacy inbox items must be an array' }]
    }
  }
  const targetState: HubStateV2 = {
    schemaVersion: HUB_STATE_SCHEMA_VERSION,
    stateRevision: legacyRevision + 1,
    runtimeRevision: input.runtimeRevision,
    librarySnapshots,
    worktrees: targetWorktrees,
    items: [...legacyItems],
    lastIngest: legacyState.lastIngest == null
      ? null
      : {
          ref: legacyState.lastIngest.ref,
          old: legacyState.lastIngest.old,
          new: legacyState.lastIngest.new,
          gameRepoId: input.lastIngestGameRepoId as Sha256Identifier
        }
  }
  const stateValidation = validateHubStateV2(targetState)
  if (!stateValidation.valid) {
    return {
      ok: false,
      errors: stateValidation.errors.map((entry) => ({
        code: 'MIGRATION_INPUT_INVALID',
        path: `$.legacyState${entry.path.slice(1)}`,
        message: entry.message
      }))
    }
  }
  const withoutHash: MigrationPlanV1 = {
    schemaVersion: MIGRATION_PLAN_SCHEMA_VERSION,
    sourceSchemaVersion: 1,
    targetSchemaVersion: HUB_STATE_SCHEMA_VERSION,
    sourceDigest: input.sourceDigest,
    planHash: `sha256:${'0'.repeat(64)}`,
    targetState,
    worktrees,
    warnings
  }
  const canonicalPayload = canonicalMigrationPlanPayload(withoutHash)
  const plan: MigrationPlanV1 = {
    ...withoutHash,
    planHash: domainSeparatedSha256(MIGRATION_PLAN_HASH_DOMAIN, canonicalPayload)
  }
  const validation = validateMigrationPlanV1(plan)
  if (!validation.valid) {
    return {
      ok: false,
      errors: validation.errors.map((entry) => ({
        code: 'MIGRATION_PLAN_INVALID',
        path: entry.path,
        message: entry.message
      }))
    }
  }
  return { ok: true, plan, canonicalPayload }
}

export function verifyMigrationPlanHash(plan: unknown): plan is MigrationPlanV1 {
  const validation = validateMigrationPlanV1(plan)
  return validation.valid
    && domainSeparatedSha256(MIGRATION_PLAN_HASH_DOMAIN, canonicalMigrationPlanPayload(validation.value))
      === validation.value.planHash
}
