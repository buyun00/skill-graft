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

export const RUNTIME_ASSET_SCHEMA_VERSION = 1 as const
export const VISIBILITY_OWNERSHIP_STATE_SCHEMA_VERSION = 1 as const
export const MATERIALIZATION_MARKER_SCHEMA_VERSION = 1 as const
export const MATERIALIZATION_COMMIT_RECORD_SCHEMA_VERSION = 1 as const
export const MATERIALIZE_PLAN_SCHEMA_VERSION = 1 as const
export const LEGACY_MIGRATION_RECORD_SCHEMA_VERSION = 1 as const
export const LEGACY_MIGRATION_PLAN_SCHEMA_VERSION = 1 as const
export const LEGACY_ROLLBACK_PLAN_SCHEMA_VERSION = 1 as const

export const MATERIALIZATION_ARTIFACT_OWNERS = [
  'agentsOverride',
  'residentSkill',
  'adoptedSkill',
  'localOverlay'
] as const
export type MaterializationArtifactOwner = (typeof MATERIALIZATION_ARTIFACT_OWNERS)[number]

export const MATERIALIZATION_ARTIFACT_KINDS = ['file', 'directory'] as const
export type MaterializationArtifactKind = (typeof MATERIALIZATION_ARTIFACT_KINDS)[number]

export const MATERIALIZE_ACTIONS = ['create', 'update', 'delete', 'keep', 'conflict'] as const
export type MaterializeAction = (typeof MATERIALIZE_ACTIONS)[number]

export const MATERIALIZE_OBSERVED_KINDS = [
  'file',
  'directory',
  'symlink',
  'junction',
  'hardlink',
  'other'
] as const
export type MaterializeObservedKind = (typeof MATERIALIZE_OBSERVED_KINDS)[number]

export const MATERIALIZE_CONFLICT_KINDS = [
  'dirty',
  'unowned-content',
  'kind-mismatch',
  'legacy-link',
  'external-link',
  'path-collision',
  'path-escape',
  'protected-target',
  'marker-invalid'
] as const
export type MaterializeConflictKind = (typeof MATERIALIZE_CONFLICT_KINDS)[number]

export const GIT_VISIBILITY_ACTIONS = [
  'keep',
  'adopt',
  'setSkipWorktree',
  'excludeLocal',
  'setSkipAndExclude',
  'release',
  'conflict'
] as const
export type GitVisibilityAction = (typeof GIT_VISIBILITY_ACTIONS)[number]

export const GIT_VISIBILITY_OWNERSHIP_STATES = ['unmanaged', 'managed', 'invalid'] as const
export type GitVisibilityOwnership = (typeof GIT_VISIBILITY_OWNERSHIP_STATES)[number]

export const VISIBILITY_BASE_EXCLUDE_SCOPES = [
  'unset',
  'system',
  'global',
  'local',
  'worktree'
] as const
export type VisibilityBaseExcludeScope = (typeof VISIBILITY_BASE_EXCLUDE_SCOPES)[number]

export const GIT_IGNORE_ORIGINS = [
  'none',
  'private',
  'repository',
  'legacyCommon',
  'external'
] as const
/**
 * `legacyCommon` means only a positively identified Skill Graft-owned entry in
 * the shared Git common info/exclude. Project/user lines are `repository` or
 * `external` and are never removed by a materialization plan.
 */
export type GitIgnoreOrigin = (typeof GIT_IGNORE_ORIGINS)[number]

export const GIT_MATERIALIZATION_CONFIGURATION_ACTIONS = [
  'keep',
  'configure',
  'restore',
  'conflict'
] as const
export type GitMaterializationConfigurationAction =
  (typeof GIT_MATERIALIZATION_CONFIGURATION_ACTIONS)[number]

export const GIT_MATERIALIZATION_CONFIGURATION_EFFECTS = [
  'enableWorktreeConfig',
  'setHooksPath',
  'setOverlaySource',
  'setWatchWorkspace',
  'setExcludesFile',
  'refreshExcludeProjection',
  'removeOwnedCommonInfoExcludeEntries',
  'restoreBackup'
] as const
/** `removeOwnedCommonInfoExcludeEntries` never authorizes editing other lines. */
export type GitMaterializationConfigurationEffect =
  (typeof GIT_MATERIALIZATION_CONFIGURATION_EFFECTS)[number]

export const GIT_MATERIALIZATION_CONFIGURATION_CONFLICT_KINDS = [
  'unsupportedWorktreeConfig',
  'legacyCommonInfoExclude',
  'configurationDrift',
  'siblingVisibilityRisk',
  'excludeBaseUnsafe'
] as const
export type GitMaterializationConfigurationConflictKind =
  (typeof GIT_MATERIALIZATION_CONFIGURATION_CONFLICT_KINDS)[number]

export const LEGACY_COMMON_SIBLING_SAFETY = [
  'noSiblings',
  'equivalentlyHidden',
  'unsafe'
] as const
export type LegacyCommonSiblingSafety = (typeof LEGACY_COMMON_SIBLING_SAFETY)[number]

export const LEGACY_LINK_KINDS = ['directoryLink', 'fileHardlink'] as const
export type LegacyLinkKind = (typeof LEGACY_LINK_KINDS)[number]

export const LEGACY_RESTORE_SOURCE_STATUSES = ['valid', 'missing', 'changed', 'unsafe'] as const
export type LegacyRestoreSourceStatus = (typeof LEGACY_RESTORE_SOURCE_STATUSES)[number]

export type RuntimeAssetFileV1 = {
  path: string
  size: number
  sha256: Sha256Identifier
  mode: '100644' | '100755'
}

export type RuntimeAssetManifestV1 = {
  schemaVersion: typeof RUNTIME_ASSET_SCHEMA_VERSION
  runtimeAssetId: Sha256Identifier
  runtimeRevision: string
  assetKind: 'localOverlay'
  files: readonly RuntimeAssetFileV1[]
}

export type MaterializationArtifactV1 = {
  artifactId: string
  owner: MaterializationArtifactOwner
  targetRelativePath: string
  kind: MaterializationArtifactKind
  digest: Sha256Identifier
}

export type VisibilityOwnershipTrackedPathV1 = {
  path: string
  skipWorktree: boolean
}

export type VisibilityOwnershipTargetV1 = {
  artifactId: string
  owner: MaterializationArtifactOwner
  targetRelativePath: string
  /** P3 adopts only a physically missing target; existing exact content stays project-owned. */
  baselineKind: 'missing'
  trackedPaths: readonly VisibilityOwnershipTrackedPathV1[]
  ignoreOrigin: GitIgnoreOrigin
  privateExcluded: boolean
}

/**
 * Host-neutral ownership proof. Absolute Git/config locators are deliberately
 * excluded; adapters bind any raw locator in an adapter-private sidecar.
 */
export type VisibilityOwnershipStateV1 = {
  schemaVersion: typeof VISIBILITY_OWNERSHIP_STATE_SCHEMA_VERSION
  visibilityStateId: Sha256Identifier
  /** Domain hash of the adapter-private raw locator envelope. */
  privateStateId: Sha256Identifier
  pathKey: Sha256Identifier
  worktreeId: string
  baseExclude: {
    scope: VisibilityBaseExcludeScope
    valueId: Sha256Identifier | null
    contentDigest: Sha256Identifier
  }
  targets: readonly VisibilityOwnershipTargetV1[]
}

export type MaterializationOriginV1 =
  | { kind: 'sync' }
  | { kind: 'legacyMigration'; migrationId: Sha256Identifier }

export type MaterializationMarkerV1 = {
  schemaVersion: typeof MATERIALIZATION_MARKER_SCHEMA_VERSION
  materializationId: Sha256Identifier
  planHash: Sha256Identifier
  pathKey: Sha256Identifier
  worktreeId: string
  snapshotId: Sha256Identifier
  selectedSkills: readonly string[]
  runtimeRevision: string
  runtimeAssetId: Sha256Identifier
  visibilityStateId: Sha256Identifier
  origin: MaterializationOriginV1
  artifacts: readonly MaterializationArtifactV1[]
}

/** Durable Hub mirror. The physical marker location remains host-private. */
export type MaterializationCommitRecordV1 = {
  schemaVersion: typeof MATERIALIZATION_COMMIT_RECORD_SCHEMA_VERSION
  pathKey: Sha256Identifier
  marker: MaterializationMarkerV1 | null
}

export type MaterializationRequestV1 = {
  snapshotId: Sha256Identifier
  selectedSkills: readonly string[]
  runtimeRevision: string
  runtimeAssetId: Sha256Identifier
  visibilityStateId: Sha256Identifier
  materializationId: Sha256Identifier
}

export type MaterializeBeforeV1 = {
  kind: MaterializeObservedKind
  digest?: Sha256Identifier
}

export type MaterializeSourceV1 =
  | { kind: 'snapshot'; snapshotId: Sha256Identifier; prefix: string }
  | { kind: 'runtimeAsset'; runtimeAssetId: Sha256Identifier; prefix: string }

export type MaterializeAfterV1 = {
  digest: Sha256Identifier
  source: MaterializeSourceV1
}

export type SafeDiffSampleV1 = {
  pathId: Sha256Identifier
  before?: Sha256Identifier
  after?: Sha256Identifier
}

export type SafeDiffSummaryV1 = {
  kind: MaterializeConflictKind
  changedFiles: number
  addedFiles: number
  removedFiles: number
  samples: readonly SafeDiffSampleV1[]
}

export type MaterializeOperationV1 = {
  artifactId: string
  owner: MaterializationArtifactOwner
  targetRelativePath: string
  kind: MaterializationArtifactKind
  action: MaterializeAction
  before: MaterializeBeforeV1 | null
  after: MaterializeAfterV1 | null
  conflict?: SafeDiffSummaryV1
}

export type GitVisibilityOperationV1 = {
  artifactId: string
  targetRelativePath: string
  action: GitVisibilityAction
  ownership: GitVisibilityOwnership
  ownershipStateId: Sha256Identifier | null
  baselineDigest: Sha256Identifier | null
  restoreDigest: Sha256Identifier | null
  restoreSafe: boolean
  beforeDigest: Sha256Identifier
  afterDigest: Sha256Identifier
}

export type GitMaterializationConfigurationPlanV1 = {
  action: GitMaterializationConfigurationAction
  beforeDigest: Sha256Identifier
  afterDigest: Sha256Identifier
  effects: readonly GitMaterializationConfigurationEffect[]
  conflictKind: GitMaterializationConfigurationConflictKind | null
  /** Locator-free exact proof of every sibling's equivalent visibility. */
  siblingFactsDigest: Sha256Identifier
}

export type GitVisibilityPlanV1 = {
  digest: Sha256Identifier
  operations: readonly GitVisibilityOperationV1[]
  configuration: GitMaterializationConfigurationPlanV1
}

export type MaterializePlanSummaryV1 = {
  create: number
  update: number
  delete: number
  keep: number
  conflict: number
}

export type MaterializePlanV1 = {
  schemaVersion: typeof MATERIALIZE_PLAN_SCHEMA_VERSION
  planHash: Sha256Identifier
  pathKey: Sha256Identifier
  worktreeId: string
  stateRevision: number
  requested: MaterializationRequestV1
  current: MaterializationMarkerV1 | null
  markerStatus: 'missing' | 'valid' | 'invalid'
  operations: readonly MaterializeOperationV1[]
  git: GitVisibilityPlanV1
  summary: MaterializePlanSummaryV1
  executable: boolean
}

export type LegacyMigrationArtifactV1 = {
  artifactId: string
  owner: MaterializationArtifactOwner
  targetRelativePath: string
  kind: MaterializationArtifactKind
  legacyKind: LegacyLinkKind
  sourceArtifactId: Sha256Identifier
  beforeDigest: Sha256Identifier
  afterDigest: Sha256Identifier
}

export type LegacyArtifactFactV1 = {
  artifactId: string
  owner: MaterializationArtifactOwner
  targetRelativePath: string
  kind: MaterializationArtifactKind
  observedKind: 'missing' | MaterializeObservedKind
  digest: Sha256Identifier | null
  isReparsePoint: boolean
  legacyKind: LegacyLinkKind | null
  sourceArtifactId: Sha256Identifier | null
  pathEscaped: boolean
  protected: boolean
}

/** Locator-free current proof for one adapter-private legacy restore source. */
export type LegacyRestoreSourceFactV1 = {
  artifactId: string
  targetRelativePath: string
  legacyKind: LegacyLinkKind
  sourceArtifactId: Sha256Identifier
  sourceStateId: Sha256Identifier
  status: LegacyRestoreSourceStatus
}

export type LegacyGitVisibilityStateV1 = {
  trackedCount: number
  skippedTrackedCount: number
  ignored: boolean
  ignoreOrigin: GitIgnoreOrigin
  privateExcluded: boolean
  trackedPathsDigest: Sha256Identifier
  factDigest: Sha256Identifier
}

export type LegacyGitVisibilityAction = 'apply' | 'restore' | 'keep' | 'conflict'

export type LegacyGitVisibilityOperationV1 = {
  artifactId: string
  targetRelativePath: string
  action: LegacyGitVisibilityAction
  before: LegacyGitVisibilityStateV1
  after: LegacyGitVisibilityStateV1
}

export type LegacyGitVisibilityPlanV1 = {
  digest: Sha256Identifier
  operations: readonly LegacyGitVisibilityOperationV1[]
  configuration: GitMaterializationConfigurationPlanV1
}

export type LegacyMigrationRecordV1 = {
  schemaVersion: typeof LEGACY_MIGRATION_RECORD_SCHEMA_VERSION
  migrationId: Sha256Identifier
  planHash: Sha256Identifier
  pathKey: Sha256Identifier
  worktreeId: string
  status: 'committed' | 'rolledBack'
  snapshotId: Sha256Identifier
  materializationId: Sha256Identifier
  visibilityStateId: Sha256Identifier
  backupManifestId: Sha256Identifier
  /** Domain hash of the adapter-private raw backup payload. */
  backupPrivateStateId: Sha256Identifier
  artifacts: readonly LegacyMigrationArtifactV1[]
  createdArtifacts: readonly MaterializationArtifactV1[]
  gitVisibilityDigest: Sha256Identifier
  rollbackPlanHash?: Sha256Identifier
}

export type LegacyMigrationOperationV1 = {
  artifactId: string
  owner: MaterializationArtifactOwner
  targetRelativePath: string
  kind: MaterializationArtifactKind
  before: MaterializeBeforeV1 | null
  after: MaterializeAfterV1
  legacy: { legacyKind: LegacyLinkKind; sourceArtifactId: Sha256Identifier } | null
  action: 'replaceWithCopy' | 'create' | 'keep' | 'conflict'
  conflict?: SafeDiffSummaryV1
}

export type LegacyMigrationPlanV1 = {
  schemaVersion: typeof LEGACY_MIGRATION_PLAN_SCHEMA_VERSION
  planHash: Sha256Identifier
  migrationId: Sha256Identifier
  pathKey: Sha256Identifier
  worktreeId: string
  stateRevision: number
  requested: MaterializationRequestV1
  markerStatus: 'missing'
  backupManifestId: Sha256Identifier
  backupPrivateStateId: Sha256Identifier
  gitBeforeDigest: Sha256Identifier
  operations: readonly LegacyMigrationOperationV1[]
  git: LegacyGitVisibilityPlanV1
  summary: { replaceWithCopy: number; create: number; keep: number; conflict: number }
  executable: boolean
}

export type LegacyRollbackOperationV1 = {
  artifactId: string
  owner: MaterializationArtifactOwner
  targetRelativePath: string
  kind: MaterializationArtifactKind
  before: MaterializeBeforeV1 | null
  restore: {
    legacyKind: LegacyLinkKind
    sourceArtifactId: Sha256Identifier
    digest: Sha256Identifier
    sourceStateId: Sha256Identifier
  } | null
  action: 'restoreLink' | 'deleteCreated' | 'keep' | 'conflict'
  conflict?: SafeDiffSummaryV1
}

export type LegacyRollbackPlanV1 = {
  schemaVersion: typeof LEGACY_ROLLBACK_PLAN_SCHEMA_VERSION
  planHash: Sha256Identifier
  migrationId: Sha256Identifier
  pathKey: Sha256Identifier
  worktreeId: string
  stateRevision: number
  current: MaterializationMarkerV1
  backupManifestId: Sha256Identifier
  backupPrivateStateId: Sha256Identifier
  restoreVisibilityStateId: Sha256Identifier
  operations: readonly LegacyRollbackOperationV1[]
  git: LegacyGitVisibilityPlanV1
  summary: { restoreLink: number; deleteCreated: number; keep: number; conflict: number }
  executable: boolean
}

const SHA256_PATTERN = '^sha256:[0-9a-f]{64}$'
const SKILL_NAME_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
const ARTIFACT_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'

const SHA256_SCHEMA = {
  type: 'string',
  pattern: SHA256_PATTERN,
  'x-errorCode': 'INVALID_IDENTIFIER'
} as const

const PORTABLE_PATH_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: 4096,
  pattern: PORTABLE_RELATIVE_PATH_PATTERN,
  'x-errorCode': 'PATH_NOT_NORMALIZED'
} as const

const RUNTIME_ASSET_FILE_SCHEMA = {
  type: 'object',
  required: ['path', 'size', 'sha256', 'mode'],
  additionalProperties: false,
  properties: {
    path: PORTABLE_PATH_SCHEMA,
    size: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
    sha256: SHA256_SCHEMA,
    mode: { type: 'string', enum: ['100644', '100755'] }
  }
} as const

export const RUNTIME_ASSET_MANIFEST_V1_SCHEMA = {
  $schema: P2_JSON_SCHEMA_DRAFT,
  $id: 'https://skill-graft.dev/schemas/runtime-asset-manifest-v1.schema.json',
  title: 'RuntimeAssetManifestV1',
  type: 'object',
  required: ['schemaVersion', 'runtimeAssetId', 'runtimeRevision', 'assetKind', 'files'],
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', const: RUNTIME_ASSET_SCHEMA_VERSION },
    runtimeAssetId: SHA256_SCHEMA,
    runtimeRevision: {
      type: 'string',
      minLength: 1,
      maxLength: 256,
      pattern: PORTABLE_OPAQUE_IDENTIFIER_PATTERN,
      'x-errorCode': 'INVALID_IDENTIFIER'
    },
    assetKind: { type: 'string', const: 'localOverlay' },
    files: { type: 'array', minItems: 1, uniqueItems: true, items: RUNTIME_ASSET_FILE_SCHEMA }
  }
} as const

const MATERIALIZATION_ARTIFACT_SCHEMA = {
  type: 'object',
  required: ['artifactId', 'owner', 'targetRelativePath', 'kind', 'digest'],
  additionalProperties: false,
  properties: {
    artifactId: { type: 'string', pattern: ARTIFACT_ID_PATTERN, 'x-errorCode': 'INVALID_IDENTIFIER' },
    owner: { type: 'string', enum: MATERIALIZATION_ARTIFACT_OWNERS },
    targetRelativePath: PORTABLE_PATH_SCHEMA,
    kind: { type: 'string', enum: MATERIALIZATION_ARTIFACT_KINDS },
    digest: SHA256_SCHEMA
  }
} as const

const MATERIALIZATION_ORIGIN_SCHEMA = {
  type: 'object',
  required: ['kind'],
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['sync', 'legacyMigration'] },
    migrationId: SHA256_SCHEMA
  }
} as const

const VISIBILITY_OWNERSHIP_TRACKED_PATH_SCHEMA = {
  type: 'object',
  required: ['path', 'skipWorktree'],
  additionalProperties: false,
  properties: {
    path: PORTABLE_PATH_SCHEMA,
    skipWorktree: { type: 'boolean' }
  }
} as const

const VISIBILITY_OWNERSHIP_TARGET_SCHEMA = {
  type: 'object',
  required: [
    'artifactId', 'owner', 'targetRelativePath', 'baselineKind',
    'trackedPaths', 'ignoreOrigin', 'privateExcluded'
  ],
  additionalProperties: false,
  properties: {
    artifactId: { type: 'string', pattern: ARTIFACT_ID_PATTERN, 'x-errorCode': 'INVALID_IDENTIFIER' },
    owner: { type: 'string', enum: MATERIALIZATION_ARTIFACT_OWNERS },
    targetRelativePath: PORTABLE_PATH_SCHEMA,
    baselineKind: { type: 'string', const: 'missing' },
    trackedPaths: {
      type: 'array',
      uniqueItems: true,
      items: VISIBILITY_OWNERSHIP_TRACKED_PATH_SCHEMA
    },
    ignoreOrigin: { type: 'string', enum: GIT_IGNORE_ORIGINS },
    privateExcluded: { type: 'boolean' }
  }
} as const

export const VISIBILITY_OWNERSHIP_STATE_V1_SCHEMA = {
  $schema: P2_JSON_SCHEMA_DRAFT,
  $id: 'https://skill-graft.dev/schemas/visibility-ownership-state-v1.schema.json',
  title: 'VisibilityOwnershipStateV1',
  type: 'object',
  required: [
    'schemaVersion', 'visibilityStateId', 'privateStateId', 'pathKey', 'worktreeId',
    'baseExclude', 'targets'
  ],
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', const: VISIBILITY_OWNERSHIP_STATE_SCHEMA_VERSION },
    visibilityStateId: SHA256_SCHEMA,
    privateStateId: SHA256_SCHEMA,
    pathKey: SHA256_SCHEMA,
    worktreeId: {
      type: 'string', minLength: 1, maxLength: 256,
      pattern: PORTABLE_OPAQUE_IDENTIFIER_PATTERN, 'x-errorCode': 'INVALID_IDENTIFIER'
    },
    baseExclude: {
      type: 'object',
      required: ['scope', 'valueId', 'contentDigest'],
      additionalProperties: false,
      properties: {
        scope: { type: 'string', enum: VISIBILITY_BASE_EXCLUDE_SCOPES },
        valueId: { ...SHA256_SCHEMA, type: ['string', 'null'] },
        contentDigest: SHA256_SCHEMA
      }
    },
    targets: { type: 'array', uniqueItems: true, items: VISIBILITY_OWNERSHIP_TARGET_SCHEMA }
  }
} as const

const MATERIALIZATION_MARKER_OBJECT_SCHEMA = {
  type: 'object',
  required: [
    'schemaVersion', 'materializationId', 'planHash', 'pathKey', 'worktreeId',
    'snapshotId', 'selectedSkills', 'runtimeRevision', 'runtimeAssetId',
    'visibilityStateId', 'origin', 'artifacts'
  ],
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', const: MATERIALIZATION_MARKER_SCHEMA_VERSION },
    materializationId: SHA256_SCHEMA,
    planHash: SHA256_SCHEMA,
    pathKey: SHA256_SCHEMA,
    worktreeId: {
      type: 'string', minLength: 1, maxLength: 256,
      pattern: PORTABLE_OPAQUE_IDENTIFIER_PATTERN, 'x-errorCode': 'INVALID_IDENTIFIER'
    },
    snapshotId: SHA256_SCHEMA,
    selectedSkills: {
      type: 'array', uniqueItems: true,
      items: { type: 'string', pattern: SKILL_NAME_PATTERN, 'x-errorCode': 'INVALID_IDENTIFIER' }
    },
    runtimeRevision: {
      type: 'string', minLength: 1, maxLength: 256,
      pattern: PORTABLE_OPAQUE_IDENTIFIER_PATTERN, 'x-errorCode': 'INVALID_IDENTIFIER'
    },
    runtimeAssetId: SHA256_SCHEMA,
    visibilityStateId: SHA256_SCHEMA,
    origin: MATERIALIZATION_ORIGIN_SCHEMA,
    artifacts: { type: 'array', minItems: 2, uniqueItems: true, items: MATERIALIZATION_ARTIFACT_SCHEMA }
  }
} as const

export const MATERIALIZATION_MARKER_V1_SCHEMA = {
  $schema: P2_JSON_SCHEMA_DRAFT,
  $id: 'https://skill-graft.dev/schemas/materialization-marker-v1.schema.json',
  title: 'MaterializationMarkerV1',
  ...MATERIALIZATION_MARKER_OBJECT_SCHEMA
} as const

export const MATERIALIZATION_COMMIT_RECORD_V1_SCHEMA = {
  $schema: P2_JSON_SCHEMA_DRAFT,
  $id: 'https://skill-graft.dev/schemas/materialization-commit-record-v1.schema.json',
  title: 'MaterializationCommitRecordV1',
  type: 'object',
  required: ['schemaVersion', 'pathKey', 'marker'],
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', const: MATERIALIZATION_COMMIT_RECORD_SCHEMA_VERSION },
    pathKey: SHA256_SCHEMA,
    marker: { ...MATERIALIZATION_MARKER_OBJECT_SCHEMA, type: ['object', 'null'] }
  }
} as const

const MATERIALIZATION_REQUEST_SCHEMA = {
  type: 'object',
  required: [
    'snapshotId', 'selectedSkills', 'runtimeRevision', 'runtimeAssetId',
    'visibilityStateId', 'materializationId'
  ],
  additionalProperties: false,
  properties: {
    snapshotId: SHA256_SCHEMA,
    selectedSkills: {
      type: 'array', uniqueItems: true,
      items: { type: 'string', pattern: SKILL_NAME_PATTERN, 'x-errorCode': 'INVALID_IDENTIFIER' }
    },
    runtimeRevision: {
      type: 'string', minLength: 1, maxLength: 256,
      pattern: PORTABLE_OPAQUE_IDENTIFIER_PATTERN, 'x-errorCode': 'INVALID_IDENTIFIER'
    },
    runtimeAssetId: SHA256_SCHEMA,
    visibilityStateId: SHA256_SCHEMA,
    materializationId: SHA256_SCHEMA
  }
} as const

const MATERIALIZE_BEFORE_SCHEMA = {
  type: 'object',
  required: ['kind'],
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: MATERIALIZE_OBSERVED_KINDS },
    digest: SHA256_SCHEMA
  }
} as const

const MATERIALIZE_SOURCE_SCHEMA = {
  type: 'object',
  required: ['kind', 'prefix'],
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['snapshot', 'runtimeAsset'] },
    snapshotId: SHA256_SCHEMA,
    runtimeAssetId: SHA256_SCHEMA,
    prefix: { type: 'string', maxLength: 4096 }
  }
} as const

const MATERIALIZE_AFTER_SCHEMA = {
  type: 'object',
  required: ['digest', 'source'],
  additionalProperties: false,
  properties: { digest: SHA256_SCHEMA, source: MATERIALIZE_SOURCE_SCHEMA }
} as const

const SAFE_DIFF_SAMPLE_SCHEMA = {
  type: 'object',
  required: ['pathId'],
  additionalProperties: false,
  properties: { pathId: SHA256_SCHEMA, before: SHA256_SCHEMA, after: SHA256_SCHEMA }
} as const

const SAFE_DIFF_SCHEMA = {
  type: 'object',
  required: ['kind', 'changedFiles', 'addedFiles', 'removedFiles', 'samples'],
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: MATERIALIZE_CONFLICT_KINDS },
    changedFiles: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
    addedFiles: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
    removedFiles: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
    samples: { type: 'array', maxItems: 8, uniqueItems: true, items: SAFE_DIFF_SAMPLE_SCHEMA }
  }
} as const

const MATERIALIZE_OPERATION_SCHEMA = {
  type: 'object',
  required: ['artifactId', 'owner', 'targetRelativePath', 'kind', 'action', 'before', 'after'],
  additionalProperties: false,
  properties: {
    artifactId: { type: 'string', pattern: ARTIFACT_ID_PATTERN, 'x-errorCode': 'INVALID_IDENTIFIER' },
    owner: { type: 'string', enum: MATERIALIZATION_ARTIFACT_OWNERS },
    targetRelativePath: PORTABLE_PATH_SCHEMA,
    kind: { type: 'string', enum: MATERIALIZATION_ARTIFACT_KINDS },
    action: { type: 'string', enum: MATERIALIZE_ACTIONS },
    before: { ...MATERIALIZE_BEFORE_SCHEMA, type: ['object', 'null'] },
    after: { ...MATERIALIZE_AFTER_SCHEMA, type: ['object', 'null'] },
    conflict: SAFE_DIFF_SCHEMA
  }
} as const

const GIT_VISIBILITY_OPERATION_SCHEMA = {
  type: 'object',
  required: [
    'artifactId', 'targetRelativePath', 'action', 'ownership', 'ownershipStateId',
    'baselineDigest', 'restoreDigest', 'restoreSafe', 'beforeDigest', 'afterDigest'
  ],
  additionalProperties: false,
  properties: {
    artifactId: { type: 'string', pattern: ARTIFACT_ID_PATTERN, 'x-errorCode': 'INVALID_IDENTIFIER' },
    targetRelativePath: PORTABLE_PATH_SCHEMA,
    action: { type: 'string', enum: GIT_VISIBILITY_ACTIONS },
    ownership: { type: 'string', enum: GIT_VISIBILITY_OWNERSHIP_STATES },
    ownershipStateId: { ...SHA256_SCHEMA, type: ['string', 'null'] },
    baselineDigest: { ...SHA256_SCHEMA, type: ['string', 'null'] },
    restoreDigest: { ...SHA256_SCHEMA, type: ['string', 'null'] },
    restoreSafe: { type: 'boolean' },
    beforeDigest: SHA256_SCHEMA,
    afterDigest: SHA256_SCHEMA
  }
} as const

const GIT_MATERIALIZATION_CONFIGURATION_PLAN_SCHEMA = {
  type: 'object',
  required: [
    'action', 'beforeDigest', 'afterDigest', 'effects', 'conflictKind',
    'siblingFactsDigest'
  ],
  additionalProperties: false,
  properties: {
    action: { type: 'string', enum: GIT_MATERIALIZATION_CONFIGURATION_ACTIONS },
    beforeDigest: SHA256_SCHEMA,
    afterDigest: SHA256_SCHEMA,
    effects: {
      type: 'array',
      maxItems: GIT_MATERIALIZATION_CONFIGURATION_EFFECTS.length,
      uniqueItems: true,
      items: { type: 'string', enum: GIT_MATERIALIZATION_CONFIGURATION_EFFECTS }
    },
    conflictKind: {
      type: ['string', 'null'],
      enum: [...GIT_MATERIALIZATION_CONFIGURATION_CONFLICT_KINDS, null]
    },
    siblingFactsDigest: SHA256_SCHEMA
  }
} as const

const GIT_VISIBILITY_PLAN_SCHEMA = {
  type: 'object',
  required: ['digest', 'operations', 'configuration'],
  additionalProperties: false,
  properties: {
    digest: SHA256_SCHEMA,
    operations: { type: 'array', uniqueItems: true, items: GIT_VISIBILITY_OPERATION_SCHEMA },
    configuration: GIT_MATERIALIZATION_CONFIGURATION_PLAN_SCHEMA
  }
} as const

const MATERIALIZE_SUMMARY_SCHEMA = {
  type: 'object',
  required: MATERIALIZE_ACTIONS,
  additionalProperties: false,
  properties: Object.fromEntries(MATERIALIZE_ACTIONS.map((action) => [
    action,
    { type: 'integer', minimum: 0, maximum: 9007199254740991 }
  ]))
} as const

export const MATERIALIZE_PLAN_V1_SCHEMA = {
  $schema: P2_JSON_SCHEMA_DRAFT,
  $id: 'https://skill-graft.dev/schemas/materialize-plan-v1.schema.json',
  title: 'MaterializePlanV1',
  type: 'object',
  required: [
    'schemaVersion', 'planHash', 'pathKey', 'worktreeId', 'stateRevision', 'requested',
    'current', 'markerStatus', 'operations', 'git', 'summary', 'executable'
  ],
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', const: MATERIALIZE_PLAN_SCHEMA_VERSION },
    planHash: SHA256_SCHEMA,
    pathKey: SHA256_SCHEMA,
    worktreeId: {
      type: 'string', minLength: 1, maxLength: 256,
      pattern: PORTABLE_OPAQUE_IDENTIFIER_PATTERN, 'x-errorCode': 'INVALID_IDENTIFIER'
    },
    stateRevision: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
    requested: MATERIALIZATION_REQUEST_SCHEMA,
    current: { ...MATERIALIZATION_MARKER_OBJECT_SCHEMA, type: ['object', 'null'] },
    markerStatus: { type: 'string', enum: ['missing', 'valid', 'invalid'] },
    operations: { type: 'array', uniqueItems: true, items: MATERIALIZE_OPERATION_SCHEMA },
    git: GIT_VISIBILITY_PLAN_SCHEMA,
    summary: MATERIALIZE_SUMMARY_SCHEMA,
    executable: { type: 'boolean' }
  }
} as const

const LEGACY_MIGRATION_ARTIFACT_SCHEMA = {
  type: 'object',
  required: [
    'artifactId', 'owner', 'targetRelativePath', 'kind', 'legacyKind',
    'sourceArtifactId', 'beforeDigest', 'afterDigest'
  ],
  additionalProperties: false,
  properties: {
    artifactId: { type: 'string', pattern: ARTIFACT_ID_PATTERN, 'x-errorCode': 'INVALID_IDENTIFIER' },
    owner: { type: 'string', enum: MATERIALIZATION_ARTIFACT_OWNERS },
    targetRelativePath: PORTABLE_PATH_SCHEMA,
    kind: { type: 'string', enum: MATERIALIZATION_ARTIFACT_KINDS },
    legacyKind: { type: 'string', enum: LEGACY_LINK_KINDS },
    sourceArtifactId: SHA256_SCHEMA,
    beforeDigest: SHA256_SCHEMA,
    afterDigest: SHA256_SCHEMA
  }
} as const

export const LEGACY_MIGRATION_RECORD_V1_SCHEMA = {
  $schema: P2_JSON_SCHEMA_DRAFT,
  $id: 'https://skill-graft.dev/schemas/legacy-migration-record-v1.schema.json',
  title: 'LegacyMigrationRecordV1',
  type: 'object',
  required: [
    'schemaVersion', 'migrationId', 'planHash', 'pathKey', 'worktreeId', 'status',
    'snapshotId', 'materializationId', 'visibilityStateId', 'backupManifestId',
    'backupPrivateStateId',
    'artifacts', 'createdArtifacts', 'gitVisibilityDigest'
  ],
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', const: LEGACY_MIGRATION_RECORD_SCHEMA_VERSION },
    migrationId: SHA256_SCHEMA,
    planHash: SHA256_SCHEMA,
    pathKey: SHA256_SCHEMA,
    worktreeId: {
      type: 'string', minLength: 1, maxLength: 256,
      pattern: PORTABLE_OPAQUE_IDENTIFIER_PATTERN, 'x-errorCode': 'INVALID_IDENTIFIER'
    },
    status: { type: 'string', enum: ['committed', 'rolledBack'] },
    snapshotId: SHA256_SCHEMA,
    materializationId: SHA256_SCHEMA,
    visibilityStateId: SHA256_SCHEMA,
    backupManifestId: SHA256_SCHEMA,
    backupPrivateStateId: SHA256_SCHEMA,
    artifacts: { type: 'array', uniqueItems: true, items: LEGACY_MIGRATION_ARTIFACT_SCHEMA },
    createdArtifacts: { type: 'array', uniqueItems: true, items: MATERIALIZATION_ARTIFACT_SCHEMA },
    gitVisibilityDigest: SHA256_SCHEMA,
    rollbackPlanHash: SHA256_SCHEMA
  }
} as const

const LEGACY_LINK_PROOF_SCHEMA = {
  type: 'object',
  required: ['legacyKind', 'sourceArtifactId'],
  additionalProperties: false,
  properties: {
    legacyKind: { type: 'string', enum: LEGACY_LINK_KINDS },
    sourceArtifactId: SHA256_SCHEMA
  }
} as const

const LEGACY_RESTORE_SCHEMA = {
  type: 'object',
  required: ['legacyKind', 'sourceArtifactId', 'digest', 'sourceStateId'],
  additionalProperties: false,
  properties: {
    legacyKind: { type: 'string', enum: LEGACY_LINK_KINDS },
    sourceArtifactId: SHA256_SCHEMA,
    digest: SHA256_SCHEMA,
    sourceStateId: SHA256_SCHEMA
  }
} as const

const LEGACY_GIT_STATE_SCHEMA = {
  type: 'object',
  required: [
    'trackedCount', 'skippedTrackedCount', 'ignored', 'ignoreOrigin', 'privateExcluded',
    'trackedPathsDigest', 'factDigest'
  ],
  additionalProperties: false,
  properties: {
    trackedCount: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
    skippedTrackedCount: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
    ignored: { type: 'boolean' },
    ignoreOrigin: { type: 'string', enum: GIT_IGNORE_ORIGINS },
    privateExcluded: { type: 'boolean' },
    trackedPathsDigest: SHA256_SCHEMA,
    factDigest: SHA256_SCHEMA
  }
} as const

const LEGACY_GIT_OPERATION_SCHEMA = {
  type: 'object',
  required: ['artifactId', 'targetRelativePath', 'action', 'before', 'after'],
  additionalProperties: false,
  properties: {
    artifactId: { type: 'string', pattern: ARTIFACT_ID_PATTERN, 'x-errorCode': 'INVALID_IDENTIFIER' },
    targetRelativePath: PORTABLE_PATH_SCHEMA,
    action: { type: 'string', enum: ['apply', 'restore', 'keep', 'conflict'] },
    before: LEGACY_GIT_STATE_SCHEMA,
    after: LEGACY_GIT_STATE_SCHEMA
  }
} as const

const LEGACY_GIT_PLAN_SCHEMA = {
  type: 'object',
  required: ['digest', 'operations', 'configuration'],
  additionalProperties: false,
  properties: {
    digest: SHA256_SCHEMA,
    operations: { type: 'array', minItems: 2, uniqueItems: true, items: LEGACY_GIT_OPERATION_SCHEMA },
    configuration: GIT_MATERIALIZATION_CONFIGURATION_PLAN_SCHEMA
  }
} as const

const LEGACY_MIGRATION_OPERATION_SCHEMA = {
  type: 'object',
  required: ['artifactId', 'owner', 'targetRelativePath', 'kind', 'before', 'after', 'legacy', 'action'],
  additionalProperties: false,
  properties: {
    artifactId: { type: 'string', pattern: ARTIFACT_ID_PATTERN, 'x-errorCode': 'INVALID_IDENTIFIER' },
    owner: { type: 'string', enum: MATERIALIZATION_ARTIFACT_OWNERS },
    targetRelativePath: PORTABLE_PATH_SCHEMA,
    kind: { type: 'string', enum: MATERIALIZATION_ARTIFACT_KINDS },
    before: { ...MATERIALIZE_BEFORE_SCHEMA, type: ['object', 'null'] },
    after: MATERIALIZE_AFTER_SCHEMA,
    legacy: { ...LEGACY_LINK_PROOF_SCHEMA, type: ['object', 'null'] },
    action: { type: 'string', enum: ['replaceWithCopy', 'create', 'keep', 'conflict'] },
    conflict: SAFE_DIFF_SCHEMA
  }
} as const

export const LEGACY_MIGRATION_PLAN_V1_SCHEMA = {
  $schema: P2_JSON_SCHEMA_DRAFT,
  $id: 'https://skill-graft.dev/schemas/legacy-migration-plan-v1.schema.json',
  title: 'LegacyMigrationPlanV1',
  type: 'object',
  required: [
    'schemaVersion', 'planHash', 'migrationId', 'pathKey', 'worktreeId', 'stateRevision',
    'requested', 'markerStatus', 'backupManifestId', 'backupPrivateStateId',
    'gitBeforeDigest', 'operations',
    'git', 'summary', 'executable'
  ],
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', const: LEGACY_MIGRATION_PLAN_SCHEMA_VERSION },
    planHash: SHA256_SCHEMA,
    migrationId: SHA256_SCHEMA,
    pathKey: SHA256_SCHEMA,
    worktreeId: {
      type: 'string', minLength: 1, maxLength: 256,
      pattern: PORTABLE_OPAQUE_IDENTIFIER_PATTERN, 'x-errorCode': 'INVALID_IDENTIFIER'
    },
    stateRevision: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
    requested: MATERIALIZATION_REQUEST_SCHEMA,
    markerStatus: { type: 'string', const: 'missing' },
    backupManifestId: SHA256_SCHEMA,
    backupPrivateStateId: SHA256_SCHEMA,
    gitBeforeDigest: SHA256_SCHEMA,
    operations: { type: 'array', minItems: 2, uniqueItems: true, items: LEGACY_MIGRATION_OPERATION_SCHEMA },
    git: LEGACY_GIT_PLAN_SCHEMA,
    summary: {
      type: 'object',
      required: ['replaceWithCopy', 'create', 'keep', 'conflict'],
      additionalProperties: false,
      properties: {
        replaceWithCopy: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
        create: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
        keep: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
        conflict: { type: 'integer', minimum: 0, maximum: 9007199254740991 }
      }
    },
    executable: { type: 'boolean' }
  }
} as const

const LEGACY_ROLLBACK_OPERATION_SCHEMA = {
  type: 'object',
  required: ['artifactId', 'owner', 'targetRelativePath', 'kind', 'before', 'restore', 'action'],
  additionalProperties: false,
  properties: {
    artifactId: { type: 'string', pattern: ARTIFACT_ID_PATTERN, 'x-errorCode': 'INVALID_IDENTIFIER' },
    owner: { type: 'string', enum: MATERIALIZATION_ARTIFACT_OWNERS },
    targetRelativePath: PORTABLE_PATH_SCHEMA,
    kind: { type: 'string', enum: MATERIALIZATION_ARTIFACT_KINDS },
    before: { ...MATERIALIZE_BEFORE_SCHEMA, type: ['object', 'null'] },
    restore: { ...LEGACY_RESTORE_SCHEMA, type: ['object', 'null'] },
    action: { type: 'string', enum: ['restoreLink', 'deleteCreated', 'keep', 'conflict'] },
    conflict: SAFE_DIFF_SCHEMA
  }
} as const

export const LEGACY_ROLLBACK_PLAN_V1_SCHEMA = {
  $schema: P2_JSON_SCHEMA_DRAFT,
  $id: 'https://skill-graft.dev/schemas/legacy-rollback-plan-v1.schema.json',
  title: 'LegacyRollbackPlanV1',
  type: 'object',
  required: [
    'schemaVersion', 'planHash', 'migrationId', 'pathKey', 'worktreeId',
    'stateRevision', 'current', 'backupManifestId', 'backupPrivateStateId',
    'restoreVisibilityStateId', 'operations', 'git',
    'summary', 'executable'
  ],
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', const: LEGACY_ROLLBACK_PLAN_SCHEMA_VERSION },
    planHash: SHA256_SCHEMA,
    migrationId: SHA256_SCHEMA,
    pathKey: SHA256_SCHEMA,
    worktreeId: {
      type: 'string', minLength: 1, maxLength: 256,
      pattern: PORTABLE_OPAQUE_IDENTIFIER_PATTERN, 'x-errorCode': 'INVALID_IDENTIFIER'
    },
    stateRevision: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
    current: MATERIALIZATION_MARKER_OBJECT_SCHEMA,
    backupManifestId: SHA256_SCHEMA,
    backupPrivateStateId: SHA256_SCHEMA,
    restoreVisibilityStateId: SHA256_SCHEMA,
    operations: { type: 'array', minItems: 2, uniqueItems: true, items: LEGACY_ROLLBACK_OPERATION_SCHEMA },
    git: LEGACY_GIT_PLAN_SCHEMA,
    summary: {
      type: 'object',
      required: ['restoreLink', 'deleteCreated', 'keep', 'conflict'],
      additionalProperties: false,
      properties: {
        restoreLink: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
        deleteCreated: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
        keep: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
        conflict: { type: 'integer', minimum: 0, maximum: 9007199254740991 }
      }
    },
    executable: { type: 'boolean' }
  }
} as const

function utf8(value: string): readonly number[] {
  const bytes: number[] = []
  for (const character of value) {
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

function portablePathKey(path: string): string {
  return path.normalize('NFC').split('/').map((segment) => segment.toLocaleLowerCase('en-US')).join('/')
}

function nestedPath(path: string, prefix: string): string {
  return path === '$' ? prefix : `${prefix}${path.slice(1)}`
}

function appendNestedErrors(errors: P2ValidationError[], nested: readonly P2ValidationError[], prefix: string): void {
  errors.push(...nested.map((entry) => ({ ...entry, path: nestedPath(entry.path, prefix) })))
}

function canonicalStringArray(
  values: readonly string[],
  path: string,
  errors: P2ValidationError[],
  portableCase = false
): void {
  const seen = new Set<string>()
  let previous: string | undefined
  values.forEach((value, index) => {
    const key = portableCase ? value.toLocaleLowerCase('en-US') : value
    if (seen.has(key)) {
      errors.push({ code: 'DUPLICATE_VALUE', path: `${path}[${index}]`, message: 'array value is duplicated' })
    }
    seen.add(key)
    if (previous != null && compareUtf8(previous, value) >= 0) {
      errors.push({ code: 'INVALID_VALUE', path: `${path}[${index}]`, message: 'array values must be in canonical UTF-8 order' })
    }
    previous = value
  })
}

function canonicalPaths<T extends { targetRelativePath: string; artifactId: string }>(
  values: readonly T[],
  path: string,
  errors: P2ValidationError[]
): void {
  const pathKeys = new Set<string>()
  const artifactIds = new Set<string>()
  let previous: string | undefined
  values.forEach((value, index) => {
    if (!isPortableRelativePath(value.targetRelativePath)) {
      errors.push({ code: 'PATH_NOT_NORMALIZED', path: `${path}[${index}].targetRelativePath`, message: 'target path must be portable' })
    }
    const portable = portablePathKey(value.targetRelativePath)
    if (pathKeys.has(portable)) {
      errors.push({ code: 'PATH_COLLISION', path: `${path}[${index}].targetRelativePath`, message: 'target paths collide under portable comparison' })
    }
    pathKeys.add(portable)
    if (artifactIds.has(value.artifactId)) {
      errors.push({ code: 'DUPLICATE_VALUE', path: `${path}[${index}].artifactId`, message: 'artifact ID is duplicated' })
    }
    artifactIds.add(value.artifactId)
    if (previous != null && compareUtf8(previous, value.targetRelativePath) >= 0) {
      errors.push({ code: 'INVALID_VALUE', path: `${path}[${index}].targetRelativePath`, message: 'artifacts must be in canonical target order' })
    }
    previous = value.targetRelativePath
  })
}

function skillFromArtifact(artifact: MaterializationArtifactV1): string | null {
  const expectedPrefix = artifact.owner === 'residentSkill'
    ? 'residentSkill:'
    : artifact.owner === 'adoptedSkill'
      ? 'adoptedSkill:'
      : null
  if (!expectedPrefix || !artifact.artifactId.startsWith(expectedPrefix)) return null
  return artifact.artifactId.slice(expectedPrefix.length)
}

function validOwnedArtifact(artifact: MaterializationArtifactV1): boolean {
  if (artifact.owner === 'agentsOverride') {
    return artifact.artifactId === 'agentsOverride'
      && artifact.targetRelativePath === 'AGENTS.override.md'
      && artifact.kind === 'file'
  }
  if (artifact.owner === 'localOverlay') {
    return artifact.artifactId === 'localOverlay'
      && artifact.targetRelativePath === '.codex/local-overlay'
      && artifact.kind === 'directory'
  }
  const name = skillFromArtifact(artifact)
  return Boolean(name
    && portablePathKey(name) !== 'unity-skills'
    && new RegExp(SKILL_NAME_PATTERN, 'u').test(name)
    && artifact.targetRelativePath === `.agents/skills/${name}`
    && artifact.kind === 'directory')
}

function validLegacyArtifact(artifact: LegacyMigrationArtifactV1): boolean {
  return validOwnedArtifact({
    artifactId: artifact.artifactId,
    owner: artifact.owner,
    targetRelativePath: artifact.targetRelativePath,
    kind: artifact.kind,
    digest: artifact.afterDigest
  })
    && artifact.legacyKind === (artifact.kind === 'file' ? 'fileHardlink' : 'directoryLink')
    && artifact.beforeDigest === artifact.afterDigest
}

export function validateRuntimeAssetManifestV1(value: unknown): P2ValidationResult<RuntimeAssetManifestV1> {
  const base = validateAgainstContractSchema<RuntimeAssetManifestV1>(value, RUNTIME_ASSET_MANIFEST_V1_SCHEMA)
  if (!base.valid) return base
  const errors: P2ValidationError[] = []
  const paths = new Set<string>()
  let previous: string | undefined
  base.value.files.forEach((file, index) => {
    if (!isPortableRelativePath(file.path)) {
      errors.push({ code: 'PATH_NOT_NORMALIZED', path: `$.files[${index}].path`, message: 'runtime asset path must be portable' })
    }
    const key = portablePathKey(file.path)
    if (paths.has(key)) {
      errors.push({ code: 'PATH_COLLISION', path: `$.files[${index}].path`, message: 'runtime asset paths collide under portable comparison' })
    }
    paths.add(key)
    if (previous != null && compareUtf8(previous, file.path) >= 0) {
      errors.push({ code: 'INVALID_VALUE', path: `$.files[${index}].path`, message: 'runtime asset files must be in canonical UTF-8 order' })
    }
    previous = file.path
  })
  return errors.length > 0 ? invalidValidation(errors) : base
}

export function validateVisibilityOwnershipStateV1(
  value: unknown
): P2ValidationResult<VisibilityOwnershipStateV1> {
  const base = validateAgainstContractSchema<VisibilityOwnershipStateV1>(
    value,
    VISIBILITY_OWNERSHIP_STATE_V1_SCHEMA
  )
  if (!base.valid) return base
  const errors: P2ValidationError[] = []
  if ((base.value.baseExclude.scope === 'unset') !== (base.value.baseExclude.valueId === null)) {
    errors.push({
      code: 'INVARIANT_VIOLATION',
      path: '$.baseExclude.valueId',
      message: 'unset base exclude scope requires a null value ID and configured scopes require an ID'
    })
  }
  canonicalPaths(base.value.targets, '$.targets', errors)
  base.value.targets.forEach((target, targetIndex) => {
    const kind = target.owner === 'agentsOverride' ? 'file' : 'directory'
    if (!validOwnedArtifact({
      artifactId: target.artifactId,
      owner: target.owner,
      targetRelativePath: target.targetRelativePath,
      kind,
      digest: `sha256:${'0'.repeat(64)}`
    })) {
      errors.push({
        code: 'INVARIANT_VIOLATION',
        path: `$.targets[${targetIndex}]`,
        message: 'visibility ownership target is outside the fixed materialization policy'
      })
    }
    if (target.ignoreOrigin === 'private' && !target.privateExcluded) {
      errors.push({
        code: 'INVARIANT_VIOLATION',
        path: `$.targets[${targetIndex}].privateExcluded`,
        message: 'private ignore origin requires an exact private exclusion baseline'
      })
    }
    const trackedKeys = new Set<string>()
    let previous: string | undefined
    target.trackedPaths.forEach((tracked, trackedIndex) => {
      const trackedPath = `$.targets[${targetIndex}].trackedPaths[${trackedIndex}].path`
      if (!isPortableRelativePath(tracked.path)
        || tracked.path !== target.targetRelativePath
          && !tracked.path.startsWith(`${target.targetRelativePath}/`)) {
        errors.push({
          code: 'PATH_NOT_NORMALIZED',
          path: trackedPath,
          message: 'tracked visibility baseline path must remain within its portable controlled target'
        })
      }
      const key = portablePathKey(tracked.path)
      if (trackedKeys.has(key)) {
        errors.push({
          code: 'PATH_COLLISION',
          path: trackedPath,
          message: 'tracked visibility baseline paths collide under portable comparison'
        })
      }
      trackedKeys.add(key)
      if (previous != null && compareUtf8(previous, tracked.path) >= 0) {
        errors.push({
          code: 'INVALID_VALUE',
          path: trackedPath,
          message: 'tracked visibility baseline paths must be in canonical UTF-8 order'
        })
      }
      previous = tracked.path
    })
  })
  return errors.length > 0 ? invalidValidation(errors) : base
}

export function validateMaterializationMarkerV1(value: unknown): P2ValidationResult<MaterializationMarkerV1> {
  const base = validateAgainstContractSchema<MaterializationMarkerV1>(value, MATERIALIZATION_MARKER_V1_SCHEMA)
  if (!base.valid) return base
  const errors: P2ValidationError[] = []
  canonicalStringArray(base.value.selectedSkills, '$.selectedSkills', errors, true)
  canonicalPaths(base.value.artifacts, '$.artifacts', errors)
  const originKeys = Object.keys(base.value.origin)
  if (base.value.origin.kind === 'sync') {
    if (originKeys.length !== 1) {
      errors.push({ code: 'INVARIANT_VIOLATION', path: '$.origin', message: 'sync origin cannot contain a migration ID' })
    }
  } else if (originKeys.length !== 2 || !('migrationId' in base.value.origin)) {
    errors.push({ code: 'INVARIANT_VIOLATION', path: '$.origin.migrationId', message: 'legacy migration origin requires a migration ID' })
  }
  const selected = new Set(base.value.selectedSkills)
  const observedSkills = new Set<string>()
  let overrides = 0
  let overlays = 0
  base.value.artifacts.forEach((artifact, index) => {
    if (!validOwnedArtifact(artifact)) {
      errors.push({ code: 'INVARIANT_VIOLATION', path: `$.artifacts[${index}]`, message: 'artifact ownership does not match its fixed target' })
      return
    }
    if (artifact.owner === 'agentsOverride') overrides += 1
    if (artifact.owner === 'localOverlay') overlays += 1
    const skill = skillFromArtifact(artifact)
    if (skill) observedSkills.add(skill)
  })
  if (overrides !== 1 || overlays !== 1) {
    errors.push({ code: 'INVARIANT_VIOLATION', path: '$.artifacts', message: 'marker must own exactly one override and one runtime overlay' })
  }
  if (selected.size !== observedSkills.size
    || [...selected].some((skill) => !observedSkills.has(skill))) {
    errors.push({ code: 'INVARIANT_VIOLATION', path: '$.selectedSkills', message: 'selected skills must exactly match marker-owned Skill artifacts' })
  }
  return errors.length > 0 ? invalidValidation(errors) : base
}

export function validateMaterializationCommitRecordV1(value: unknown): P2ValidationResult<MaterializationCommitRecordV1> {
  const base = validateAgainstContractSchema<MaterializationCommitRecordV1>(value, MATERIALIZATION_COMMIT_RECORD_V1_SCHEMA)
  if (!base.valid) return base
  if (base.value.marker === null) return base
  const errors: P2ValidationError[] = []
  const marker = validateMaterializationMarkerV1(base.value.marker)
  if (!marker.valid) appendNestedErrors(errors, marker.errors, '$.marker')
  if (base.value.marker.pathKey !== base.value.pathKey) {
    errors.push({ code: 'INVARIANT_VIOLATION', path: '$.marker.pathKey', message: 'durable mirror path key must match its marker' })
  }
  return errors.length > 0 ? invalidValidation(errors) : base
}

function validateSource(source: MaterializeSourceV1, path: string, errors: P2ValidationError[]): void {
  const keys = Object.keys(source).sort()
  if (source.kind === 'snapshot') {
    if (keys.join(',') !== 'kind,prefix,snapshotId') {
      errors.push({ code: 'INVARIANT_VIOLATION', path, message: 'snapshot source has an invalid field set' })
    }
  } else if (keys.join(',') !== 'kind,prefix,runtimeAssetId') {
    errors.push({ code: 'INVARIANT_VIOLATION', path, message: 'runtime asset source has an invalid field set' })
  }
  if (source.prefix !== '' && !isPortableRelativePath(source.prefix)) {
    errors.push({ code: 'PATH_NOT_NORMALIZED', path: `${path}.prefix`, message: 'source prefix must be empty or a portable relative path' })
  }
}

function sourceMatchesRequested(
  artifact: MaterializationArtifactV1,
  source: MaterializeSourceV1,
  requested: MaterializationRequestV1
): boolean {
  if (artifact.owner === 'localOverlay') {
    return source.kind === 'runtimeAsset'
      && source.runtimeAssetId === requested.runtimeAssetId
      && source.prefix === ''
  }
  if (source.kind !== 'snapshot' || source.snapshotId !== requested.snapshotId) return false
  if (artifact.owner === 'agentsOverride') return source.prefix === 'AGENTS.override.md'
  const skill = skillFromArtifact(artifact)
  if (!skill) return false
  return source.prefix === (artifact.owner === 'residentSkill'
    ? `skills/${skill}`
    : `skills/adopted/${skill}`)
}

export function validateMaterializePlanV1(value: unknown): P2ValidationResult<MaterializePlanV1> {
  const base = validateAgainstContractSchema<MaterializePlanV1>(value, MATERIALIZE_PLAN_V1_SCHEMA)
  if (!base.valid) return base
  const errors: P2ValidationError[] = []
  canonicalStringArray(base.value.requested.selectedSkills, '$.requested.selectedSkills', errors, true)
  canonicalPaths(base.value.operations, '$.operations', errors)
  if (base.value.current !== null) {
    const current = validateMaterializationMarkerV1(base.value.current)
    if (!current.valid) appendNestedErrors(errors, current.errors, '$.current')
    if (base.value.current.pathKey !== base.value.pathKey || base.value.current.worktreeId !== base.value.worktreeId) {
      errors.push({ code: 'INVARIANT_VIOLATION', path: '$.current', message: 'current marker identity must match the plan identity' })
    }
  }
  if (base.value.markerStatus === 'valid' && base.value.current === null
    || base.value.markerStatus !== 'valid' && base.value.current !== null) {
    errors.push({ code: 'INVARIANT_VIOLATION', path: '$.markerStatus', message: 'marker status must agree with the current marker' })
  }
  const counts = Object.fromEntries(MATERIALIZE_ACTIONS.map((action) => [action, 0])) as Record<MaterializeAction, number>
  const currentByPath = new Map((base.value.current?.artifacts ?? []).map((artifact) => [
    portablePathKey(artifact.targetRelativePath),
    artifact
  ]))
  const operationPaths = new Set<string>()
  const desiredSkills = new Set<string>()
  let desiredOverrides = 0
  let desiredOverlays = 0
  base.value.operations.forEach((operation, index) => {
    counts[operation.action] += 1
    const artifact: MaterializationArtifactV1 = {
      artifactId: operation.artifactId,
      owner: operation.owner,
      targetRelativePath: operation.targetRelativePath,
      kind: operation.kind,
      digest: operation.after?.digest ?? operation.before?.digest ?? `sha256:${'0'.repeat(64)}`
    }
    const pathKey = portablePathKey(operation.targetRelativePath)
    operationPaths.add(pathKey)
    const currentArtifact = currentByPath.get(pathKey)
    if (!validOwnedArtifact(artifact)) {
      errors.push({ code: 'INVARIANT_VIOLATION', path: `$.operations[${index}]`, message: 'operation targets an artifact outside the shared ownership policy' })
    }
    if (operation.after) {
      validateSource(operation.after.source, `$.operations[${index}].after.source`, errors)
      if (!sourceMatchesRequested(artifact, operation.after.source, base.value.requested)) {
        errors.push({ code: 'INVARIANT_VIOLATION', path: `$.operations[${index}].after.source`, message: 'operation source must match its owner and requested snapshot or runtime asset' })
      }
      if (artifact.owner === 'agentsOverride') desiredOverrides += 1
      if (artifact.owner === 'localOverlay') desiredOverlays += 1
      const skill = skillFromArtifact(artifact)
      if (skill) desiredSkills.add(skill)
    }
    if (currentArtifact) {
      const identityMatches = currentArtifact.artifactId === operation.artifactId
        && currentArtifact.owner === operation.owner
        && currentArtifact.targetRelativePath === operation.targetRelativePath
        && currentArtifact.kind === operation.kind
      if (!identityMatches && operation.conflict?.kind !== 'path-collision') {
        errors.push({ code: 'INVARIANT_VIOLATION', path: `$.operations[${index}]`, message: 'current marker artifact identity must match its operation unless a portable path collision is reported' })
      }
      if (operation.action === 'create'
        || operation.action !== 'conflict' && operation.before?.digest !== currentArtifact.digest) {
        errors.push({ code: 'INVARIANT_VIOLATION', path: `$.operations[${index}]`, message: 'non-conflicting current-marker operation must prove the marker-owned before digest' })
      }
    } else if (operation.after === null || operation.action === 'update' || operation.action === 'delete') {
      errors.push({ code: 'INVARIANT_VIOLATION', path: `$.operations[${index}]`, message: 'delete and update require a current marker artifact; every operation requires current or desired ownership' })
    }
    if (operation.action === 'create' && (operation.before !== null || operation.after === null)
      || operation.action === 'update' && (operation.before === null || operation.after === null)
      || operation.action === 'delete' && (operation.before === null || operation.after !== null)
      || operation.action === 'keep' && (operation.before === null || operation.after === null
        || operation.before.digest !== operation.after.digest)
      || operation.action === 'conflict' && operation.conflict === undefined
      || operation.action !== 'conflict' && operation.conflict !== undefined) {
      errors.push({ code: 'INVARIANT_VIOLATION', path: `$.operations[${index}]`, message: 'operation action does not match its before, after, or conflict shape' })
    }
    if (operation.before && ['file', 'directory'].includes(operation.before.kind) && operation.before.digest === undefined) {
      errors.push({ code: 'INVARIANT_VIOLATION', path: `$.operations[${index}].before.digest`, message: 'plain observed content requires a digest' })
    }
    if (operation.conflict && operation.conflict.samples.length > 8) {
      errors.push({ code: 'INVARIANT_VIOLATION', path: `$.operations[${index}].conflict.samples`, message: 'safe conflict summary cannot contain more than eight hashed samples' })
    }
  })
  for (const currentArtifact of currentByPath.values()) {
    if (!operationPaths.has(portablePathKey(currentArtifact.targetRelativePath))) {
      errors.push({ code: 'INVARIANT_VIOLATION', path: '$.operations', message: 'operations must cover every current marker artifact' })
    }
  }
  const requestedSkills = new Set(base.value.requested.selectedSkills)
  if (desiredOverrides !== 1 || desiredOverlays !== 1
    || requestedSkills.size !== desiredSkills.size
    || [...requestedSkills].some((skill) => !desiredSkills.has(skill))) {
    errors.push({ code: 'INVARIANT_VIOLATION', path: '$.requested', message: 'requested selection must exactly match after-artifacts plus one override and one runtime overlay' })
  }
  for (const action of MATERIALIZE_ACTIONS) {
    if (base.value.summary[action] !== counts[action]) {
      errors.push({ code: 'INVARIANT_VIOLATION', path: `$.summary.${action}`, message: 'summary count does not match operations' })
    }
  }
  canonicalPaths(base.value.git.operations, '$.git.operations', errors)
  let ownershipMembershipChanged = false
  if (base.value.git.operations.length !== base.value.operations.length) {
    errors.push({ code: 'INVARIANT_VIOLATION', path: '$.git.operations', message: 'Git visibility must cover every materialization operation exactly once' })
  } else {
    base.value.operations.forEach((operation, index) => {
      const gitOperation = base.value.git.operations[index]
      if (gitOperation.artifactId !== operation.artifactId
        || gitOperation.targetRelativePath !== operation.targetRelativePath) {
        errors.push({ code: 'INVARIANT_VIOLATION', path: `$.git.operations[${index}]`, message: 'Git visibility identity must match its materialization operation' })
      }
      const expectedStateId = base.value.current?.visibilityStateId ?? null
      if (base.value.markerStatus !== 'invalid'
        && gitOperation.ownershipStateId !== expectedStateId) {
        errors.push({ code: 'INVARIANT_VIOLATION', path: `$.git.operations[${index}].ownershipStateId`, message: 'Git ownership fact must bind the exact current marker visibility state' })
      }
      const hasCurrent = currentByPath.has(portablePathKey(operation.targetRelativePath))
      const expectedOwnership = hasCurrent ? 'managed' : 'unmanaged'
      if (gitOperation.ownership !== expectedOwnership && gitOperation.action !== 'conflict') {
        errors.push({ code: 'INVARIANT_VIOLATION', path: `$.git.operations[${index}].ownership`, message: 'non-conflicting Git ownership must exactly match current marker membership' })
      }
      if (gitOperation.ownership === 'invalid') {
        if (gitOperation.action !== 'conflict'
          || gitOperation.baselineDigest !== null
          || gitOperation.restoreDigest !== null
          || gitOperation.restoreSafe) {
          errors.push({ code: 'INVARIANT_VIOLATION', path: `$.git.operations[${index}]`, message: 'invalid Git ownership must be a non-restorable conflict' })
        }
      } else if (gitOperation.baselineDigest === null
        || gitOperation.restoreSafe !== (gitOperation.restoreDigest !== null)) {
        errors.push({ code: 'INVARIANT_VIOLATION', path: `$.git.operations[${index}]`, message: 'valid Git ownership requires a baseline and an exact safe restore proof' })
      }
      if (gitOperation.ownership === 'unmanaged'
        && (!gitOperation.restoreSafe || gitOperation.restoreDigest !== gitOperation.beforeDigest)) {
        errors.push({ code: 'INVARIANT_VIOLATION', path: `$.git.operations[${index}]`, message: 'unmanaged Git ownership must preserve its observed visibility as the adoption baseline' })
      }
      if (operation.action === 'delete') {
        ownershipMembershipChanged = true
        if (gitOperation.action !== 'release'
          || gitOperation.ownership !== 'managed'
          || !gitOperation.restoreSafe
          || gitOperation.restoreDigest !== gitOperation.afterDigest) {
          errors.push({ code: 'INVARIANT_VIOLATION', path: `$.git.operations[${index}]`, message: 'delete requires an exact safe release of managed Git visibility' })
        }
      } else if (!hasCurrent && operation.action !== 'conflict') {
        ownershipMembershipChanged = true
        if (gitOperation.ownership !== 'unmanaged'
          || !['adopt', 'setSkipWorktree', 'excludeLocal', 'setSkipAndExclude'].includes(gitOperation.action)) {
          errors.push({ code: 'INVARIANT_VIOLATION', path: `$.git.operations[${index}]`, message: 'a newly created target must adopt its unmanaged Git visibility baseline' })
        }
      } else if (hasCurrent && ['adopt', 'release'].includes(gitOperation.action)) {
        errors.push({ code: 'INVARIANT_VIOLATION', path: `$.git.operations[${index}].action`, message: 'retained managed targets cannot be adopted or released' })
      }
      const preservesPhysicalState = gitOperation.beforeDigest === gitOperation.afterDigest
      if (gitOperation.action !== 'release'
        && ['keep', 'adopt', 'conflict'].includes(gitOperation.action) !== preservesPhysicalState) {
        errors.push({ code: 'INVARIANT_VIOLATION', path: `$.git.operations[${index}]`, message: 'Git keep/adopt/conflict preserve physical visibility; set effects must change it' })
      }
    })
  }
  const configurationConflict = validateGitConfigurationPlan(
    base.value.git.configuration,
    'materialization',
    errors
  )
  const gitConflict = base.value.git.operations.some((operation) => operation.action === 'conflict')
  if (ownershipMembershipChanged
    && base.value.requested.visibilityStateId === (base.value.current?.visibilityStateId ?? null)) {
    errors.push({ code: 'INVARIANT_VIOLATION', path: '$.requested.visibilityStateId', message: 'adoption or release must publish a distinct visibility ownership state' })
  }
  if (!ownershipMembershipChanged
    && base.value.current !== null
    && base.value.git.configuration.action === 'keep'
    && base.value.requested.visibilityStateId !== base.value.current.visibilityStateId) {
    errors.push({ code: 'INVARIANT_VIOLATION', path: '$.requested.visibilityStateId', message: 'unchanged ownership and Git configuration must retain the current visibility state' })
  }
  if (base.value.executable !== (counts.conflict === 0 && !gitConflict && !configurationConflict)) {
    errors.push({ code: 'INVARIANT_VIOLATION', path: '$.executable', message: 'only a material- and Git-configuration-conflict-free plan is executable' })
  }
  return errors.length > 0 ? invalidValidation(errors) : base
}

export function validateLegacyMigrationRecordV1(value: unknown): P2ValidationResult<LegacyMigrationRecordV1> {
  const base = validateAgainstContractSchema<LegacyMigrationRecordV1>(value, LEGACY_MIGRATION_RECORD_V1_SCHEMA)
  if (!base.valid) return base
  const errors: P2ValidationError[] = []
  canonicalPaths(base.value.artifacts, '$.artifacts', errors)
  canonicalPaths(base.value.createdArtifacts, '$.createdArtifacts', errors)
  if (base.value.status === 'committed' && base.value.rollbackPlanHash !== undefined
    || base.value.status === 'rolledBack' && base.value.rollbackPlanHash === undefined) {
    errors.push({ code: 'INVARIANT_VIOLATION', path: '$.rollbackPlanHash', message: 'only a rolled-back migration requires a rollback plan hash' })
  }
  base.value.artifacts.forEach((artifact, index) => {
    if (!validLegacyArtifact(artifact)) {
      errors.push({ code: 'INVARIANT_VIOLATION', path: `$.artifacts[${index}]`, message: 'legacy record targets an artifact outside the fixed migration ownership policy' })
    }
  })
  const migratedPaths = new Set(base.value.artifacts.map((artifact) => portablePathKey(artifact.targetRelativePath)))
  base.value.createdArtifacts.forEach((artifact, index) => {
    if (!validOwnedArtifact(artifact) || migratedPaths.has(portablePathKey(artifact.targetRelativePath))) {
      errors.push({ code: 'INVARIANT_VIOLATION', path: `$.createdArtifacts[${index}]`, message: 'created legacy record artifact must be fixed-owned and disjoint from restored links' })
    }
  })
  return errors.length > 0 ? invalidValidation(errors) : base
}

function sameGitState(left: LegacyGitVisibilityStateV1, right: LegacyGitVisibilityStateV1): boolean {
  return left.trackedCount === right.trackedCount
    && left.skippedTrackedCount === right.skippedTrackedCount
    && left.ignored === right.ignored
    && left.ignoreOrigin === right.ignoreOrigin
    && left.privateExcluded === right.privateExcluded
    && left.trackedPathsDigest === right.trackedPathsDigest
    && left.factDigest === right.factDigest
}

function validateGitConfigurationPlan(
  configuration: GitMaterializationConfigurationPlanV1,
  mode: 'materialization' | 'migration' | 'rollback',
  errors: P2ValidationError[]
): boolean {
  const positions = configuration.effects.map((effect) =>
    GIT_MATERIALIZATION_CONFIGURATION_EFFECTS.indexOf(effect))
  if (positions.some((position, index) => index > 0 && position <= positions[index - 1])) {
    errors.push({ code: 'INVALID_VALUE', path: '$.git.configuration.effects', message: 'Git configuration effects must use frozen canonical order' })
  }
  const same = configuration.beforeDigest === configuration.afterDigest
  if (configuration.action === 'keep' || configuration.action === 'conflict') {
    if (!same || configuration.effects.length !== 0
      || configuration.action === 'keep' && configuration.conflictKind !== null
      || configuration.action === 'conflict' && configuration.conflictKind === null) {
      errors.push({ code: 'INVARIANT_VIOLATION', path: '$.git.configuration', message: 'Git configuration keep/conflict must preserve the exact digest and carry no effects' })
    }
    const allowedConflicts = mode === 'materialization'
      ? ['unsupportedWorktreeConfig', 'legacyCommonInfoExclude', 'configurationDrift', 'excludeBaseUnsafe']
      : mode === 'migration'
        ? ['unsupportedWorktreeConfig', 'configurationDrift', 'siblingVisibilityRisk', 'excludeBaseUnsafe']
        : ['unsupportedWorktreeConfig', 'configurationDrift', 'siblingVisibilityRisk', 'excludeBaseUnsafe']
    if (configuration.action === 'conflict'
      && !allowedConflicts.includes(configuration.conflictKind as string)) {
      errors.push({ code: 'INVARIANT_VIOLATION', path: '$.git.configuration.conflictKind', message: 'Git configuration conflict kind is not valid for this planning mode' })
    }
  } else if (configuration.action === 'configure') {
    if (mode === 'rollback' || same || configuration.effects.length === 0
      || configuration.effects.includes('restoreBackup')
      || configuration.conflictKind !== null) {
      errors.push({ code: 'INVARIANT_VIOLATION', path: '$.git.configuration', message: 'Git configure requires a changed digest and forward-only effects' })
    }
  } else if (configuration.action === 'restore') {
    if (mode !== 'rollback' || same
      || configuration.effects.length !== 1
      || configuration.effects[0] !== 'restoreBackup'
      || configuration.conflictKind !== null) {
      errors.push({ code: 'INVARIANT_VIOLATION', path: '$.git.configuration', message: 'Git restore requires the exact backed-up configuration digest' })
    }
  }
  return configuration.action === 'conflict'
}

function validateLegacyGitPlan(
  git: LegacyGitVisibilityPlanV1,
  operations: readonly { artifactId: string; targetRelativePath: string; action: string }[],
  mode: 'migration' | 'rollback',
  errors: P2ValidationError[]
): number {
  canonicalPaths(git.operations, '$.git.operations', errors)
  if (git.operations.length !== operations.length) {
    errors.push({ code: 'INVARIANT_VIOLATION', path: '$.git.operations', message: 'legacy Git visibility must exactly cover planned artifacts' })
    return 0
  }
  let conflicts = 0
  git.operations.forEach((entry, index) => {
    const operation = operations[index]
    if (entry.artifactId !== operation.artifactId || entry.targetRelativePath !== operation.targetRelativePath) {
      errors.push({ code: 'INVARIANT_VIOLATION', path: `$.git.operations[${index}]`, message: 'legacy Git identity must match its artifact operation' })
    }
    if (entry.before.skippedTrackedCount > entry.before.trackedCount
      || entry.after.skippedTrackedCount > entry.after.trackedCount) {
      errors.push({ code: 'INVARIANT_VIOLATION', path: `$.git.operations[${index}]`, message: 'skipped tracked count cannot exceed exact tracked count' })
    }
    if (entry.before.ignored !== (entry.before.ignoreOrigin !== 'none')
      || entry.after.ignored !== (entry.after.ignoreOrigin !== 'none')) {
      errors.push({ code: 'INVARIANT_VIOLATION', path: `$.git.operations[${index}]`, message: 'Git ignored state must agree with its host-neutral ignore origin' })
    }
    if (entry.before.ignoreOrigin === 'private' && !entry.before.privateExcluded
      || entry.after.ignoreOrigin === 'private' && !entry.after.privateExcluded) {
      errors.push({ code: 'INVARIANT_VIOLATION', path: `$.git.operations[${index}]`, message: 'private ignore origin requires an exact managed private exclusion proof' })
    }
    const same = sameGitState(entry.before, entry.after)
    if (entry.action === 'conflict') {
      conflicts += 1
      if (!same || mode === 'migration' && operation.action !== 'conflict') {
        errors.push({ code: 'INVARIANT_VIOLATION', path: `$.git.operations[${index}]`, message: 'Git conflict must preserve state and migration conflicts must follow artifact conflicts' })
      }
    } else if (entry.action === 'keep') {
      if (!same || operation.action === 'conflict') {
        errors.push({ code: 'INVARIANT_VIOLATION', path: `$.git.operations[${index}]`, message: 'Git keep requires equal states and a non-conflicting artifact' })
      }
    } else if (entry.action === 'apply') {
      if (mode !== 'migration' || same || operation.action === 'conflict'
        || entry.before.trackedCount !== entry.after.trackedCount
        || entry.before.trackedPathsDigest !== entry.after.trackedPathsDigest
        || entry.after.skippedTrackedCount !== entry.after.trackedCount
        || !entry.after.ignored
        || entry.before.ignoreOrigin === 'legacyCommon' && entry.after.ignoreOrigin !== 'private'
        || (entry.before.ignoreOrigin === 'legacyCommon' || entry.before.ignoreOrigin === 'none')
          && !entry.after.privateExcluded
        || entry.before.ignoreOrigin !== 'legacyCommon'
          && entry.before.ignoreOrigin !== 'none'
          && entry.after.ignoreOrigin !== entry.before.ignoreOrigin) {
        errors.push({ code: 'INVARIANT_VIOLATION', path: `$.git.operations[${index}]`, message: 'Git apply must implement the fixed migration visibility policy without changing tracked membership' })
      }
    } else if (entry.action === 'restore') {
      if (mode !== 'rollback' || same || operation.action === 'conflict'
        || entry.before.trackedCount !== entry.after.trackedCount
        || entry.before.trackedPathsDigest !== entry.after.trackedPathsDigest) {
        errors.push({ code: 'INVARIANT_VIOLATION', path: `$.git.operations[${index}]`, message: 'Git restore must reinstate backed-up flags without changing tracked membership' })
      }
    }
  })
  if (validateGitConfigurationPlan(git.configuration, mode, errors)) conflicts += 1
  return conflicts
}

export function validateLegacyMigrationPlanV1(value: unknown): P2ValidationResult<LegacyMigrationPlanV1> {
  const base = validateAgainstContractSchema<LegacyMigrationPlanV1>(value, LEGACY_MIGRATION_PLAN_V1_SCHEMA)
  if (!base.valid) return base
  const errors: P2ValidationError[] = []
  canonicalStringArray(base.value.requested.selectedSkills, '$.requested.selectedSkills', errors, true)
  canonicalPaths(base.value.operations, '$.operations', errors)
  const desiredSkills = new Set<string>()
  let overrides = 0
  let overlays = 0
  const counts = { replaceWithCopy: 0, create: 0, keep: 0, conflict: 0 }
  base.value.operations.forEach((operation, index) => {
    counts[operation.action] += 1
    const artifact: MaterializationArtifactV1 = {
      artifactId: operation.artifactId,
      owner: operation.owner,
      targetRelativePath: operation.targetRelativePath,
      kind: operation.kind,
      digest: operation.after.digest
    }
    if (!validOwnedArtifact(artifact)) {
      errors.push({ code: 'INVARIANT_VIOLATION', path: `$.operations[${index}]`, message: 'legacy migration targets an artifact outside fixed ownership' })
    }
    validateSource(operation.after.source, `$.operations[${index}].after.source`, errors)
    if (!sourceMatchesRequested(artifact, operation.after.source, base.value.requested)) {
      errors.push({ code: 'INVARIANT_VIOLATION', path: `$.operations[${index}].after.source`, message: 'legacy migration source must match requested owner and content source' })
    }
    if (operation.owner === 'agentsOverride') overrides += 1
    if (operation.owner === 'localOverlay') overlays += 1
    const skill = skillFromArtifact(artifact)
    if (skill) desiredSkills.add(skill)
    const expectedLegacyKind = operation.kind === 'file' ? 'fileHardlink' : 'directoryLink'
    const expectedObservedKind = operation.kind === 'file' ? 'hardlink' : 'junction'
    if (operation.action === 'replaceWithCopy') {
      if (operation.before?.kind !== expectedObservedKind
        || operation.before.digest !== operation.after.digest
        || operation.legacy?.legacyKind !== expectedLegacyKind
        || operation.conflict !== undefined) {
        errors.push({ code: 'INVARIANT_VIOLATION', path: `$.operations[${index}]`, message: 'replaceWithCopy requires an exact proven legacy link and no conflict' })
      }
    } else if (operation.action === 'create') {
      if (operation.before !== null || operation.legacy !== null || operation.conflict !== undefined) {
        errors.push({ code: 'INVARIANT_VIOLATION', path: `$.operations[${index}]`, message: 'legacy create requires a physically missing target and no legacy or conflict proof' })
      }
    } else if (operation.action === 'keep') {
      errors.push({ code: 'INVARIANT_VIOLATION', path: `$.operations[${index}]`, message: 'unmanaged plain exact content cannot be adopted by legacy migration' })
    } else if (operation.conflict === undefined) {
      errors.push({ code: 'INVARIANT_VIOLATION', path: `$.operations[${index}].conflict`, message: 'legacy conflict requires a safe summary' })
    }
    if (operation.action !== 'conflict' && operation.conflict !== undefined) {
      errors.push({ code: 'INVARIANT_VIOLATION', path: `$.operations[${index}].conflict`, message: 'non-conflicting legacy operations cannot carry conflict data' })
    }
    if (operation.conflict && operation.conflict.samples.length > 8) {
      errors.push({ code: 'INVARIANT_VIOLATION', path: `$.operations[${index}].conflict.samples`, message: 'legacy safe summary cannot contain more than eight samples' })
    }
  })
  const requestedSkills = new Set(base.value.requested.selectedSkills)
  if (overrides !== 1 || overlays !== 1
    || requestedSkills.size !== desiredSkills.size
    || [...requestedSkills].some((skill) => !desiredSkills.has(skill))) {
    errors.push({ code: 'INVARIANT_VIOLATION', path: '$.requested.selectedSkills', message: 'legacy migration operations must exactly cover the requested selection, override, and overlay' })
  }
  for (const action of ['replaceWithCopy', 'create', 'keep', 'conflict'] as const) {
    if (base.value.summary[action] !== counts[action]) {
      errors.push({ code: 'INVARIANT_VIOLATION', path: `$.summary.${action}`, message: 'legacy migration summary does not match operations' })
    }
  }
  const gitConflicts = validateLegacyGitPlan(base.value.git, base.value.operations, 'migration', errors)
  const hasLegacyWork = counts.replaceWithCopy > 0 || counts.create > 0
  if (base.value.executable !== (counts.conflict === 0 && gitConflicts === 0 && hasLegacyWork)) {
    errors.push({ code: 'INVARIANT_VIOLATION', path: '$.executable', message: 'legacy migration requires a verified link replacement or missing-target create and no material or Git conflict' })
  }
  return errors.length > 0 ? invalidValidation(errors) : base
}

export function validateLegacyRollbackPlanV1(value: unknown): P2ValidationResult<LegacyRollbackPlanV1> {
  const base = validateAgainstContractSchema<LegacyRollbackPlanV1>(value, LEGACY_ROLLBACK_PLAN_V1_SCHEMA)
  if (!base.valid) return base
  const errors: P2ValidationError[] = []
  const current = validateMaterializationMarkerV1(base.value.current)
  if (!current.valid) appendNestedErrors(errors, current.errors, '$.current')
  if (base.value.current.pathKey !== base.value.pathKey
    || base.value.current.worktreeId !== base.value.worktreeId
    || base.value.current.origin.kind !== 'legacyMigration'
    || base.value.current.origin.kind === 'legacyMigration'
      && base.value.current.origin.migrationId !== base.value.migrationId) {
    errors.push({ code: 'INVARIANT_VIOLATION', path: '$.current', message: 'rollback current marker must identify this legacy migration and worktree' })
  }
  if (base.value.restoreVisibilityStateId === base.value.current.visibilityStateId) {
    errors.push({ code: 'INVARIANT_VIOLATION', path: '$.restoreVisibilityStateId', message: 'rollback must publish a distinct empty visibility ownership state' })
  }
  canonicalPaths(base.value.operations, '$.operations', errors)
  const currentByPath = new Map(base.value.current.artifacts.map((artifact) => [portablePathKey(artifact.targetRelativePath), artifact]))
  const counts = { restoreLink: 0, deleteCreated: 0, keep: 0, conflict: 0 }
  base.value.operations.forEach((operation, index) => {
    counts[operation.action] += 1
    const currentArtifact = currentByPath.get(portablePathKey(operation.targetRelativePath))
    if (!currentArtifact
      || currentArtifact.artifactId !== operation.artifactId
      || currentArtifact.owner !== operation.owner
      || currentArtifact.targetRelativePath !== operation.targetRelativePath
      || currentArtifact.kind !== operation.kind) {
      errors.push({ code: 'INVARIANT_VIOLATION', path: `$.operations[${index}]`, message: 'rollback operation must exactly match a current marker artifact' })
    }
    const expectedLegacyKind = operation.kind === 'file' ? 'fileHardlink' : 'directoryLink'
    if (operation.action === 'restoreLink') {
      if (operation.before?.kind !== operation.kind
        || operation.before.digest !== currentArtifact?.digest
        || operation.restore?.legacyKind !== expectedLegacyKind
        || operation.restore.digest !== currentArtifact?.digest
        || operation.conflict !== undefined) {
        errors.push({ code: 'INVARIANT_VIOLATION', path: `$.operations[${index}]`, message: 'restoreLink requires exact current copy and matching legacy proof' })
      }
    } else if (operation.action === 'deleteCreated') {
      if (operation.before?.kind !== operation.kind
        || operation.before.digest !== currentArtifact?.digest
        || operation.restore !== null
        || operation.conflict !== undefined) {
        errors.push({ code: 'INVARIANT_VIOLATION', path: `$.operations[${index}]`, message: 'deleteCreated requires the exact product-created copy and no restore proof' })
      }
    } else if (operation.action === 'keep') {
      if (operation.before?.kind !== operation.kind
        || operation.before.digest !== currentArtifact?.digest
        || operation.restore !== null
        || operation.conflict !== undefined) {
        errors.push({ code: 'INVARIANT_VIOLATION', path: `$.operations[${index}]`, message: 'rollback keep requires exact non-migrated current content' })
      }
    } else if (operation.conflict === undefined) {
      errors.push({ code: 'INVARIANT_VIOLATION', path: `$.operations[${index}].conflict`, message: 'rollback conflict requires a safe summary' })
    }
    if (operation.action !== 'conflict' && operation.conflict !== undefined) {
      errors.push({ code: 'INVARIANT_VIOLATION', path: `$.operations[${index}].conflict`, message: 'non-conflicting rollback operations cannot carry conflict data' })
    }
  })
  if (base.value.operations.length !== currentByPath.size) {
    errors.push({ code: 'INVARIANT_VIOLATION', path: '$.operations', message: 'rollback operations must exactly cover current marker artifacts' })
  }
  for (const action of ['restoreLink', 'deleteCreated', 'keep', 'conflict'] as const) {
    if (base.value.summary[action] !== counts[action]) {
      errors.push({ code: 'INVARIANT_VIOLATION', path: `$.summary.${action}`, message: 'rollback summary does not match operations' })
    }
  }
  const gitConflicts = validateLegacyGitPlan(base.value.git, base.value.operations, 'rollback', errors)
  const hasRestoreWork = counts.restoreLink > 0 || counts.deleteCreated > 0
    || base.value.git.operations.some((operation) => operation.action === 'restore')
    || base.value.git.configuration.action === 'restore'
  if (base.value.executable !== (counts.conflict === 0 && gitConflicts === 0 && hasRestoreWork)) {
    errors.push({ code: 'INVARIANT_VIOLATION', path: '$.executable', message: 'rollback requires an exact link, Git visibility, or configuration restoration and no conflict' })
  }
  return errors.length > 0 ? invalidValidation(errors) : base
}
