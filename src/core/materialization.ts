import {
  LEGACY_MIGRATION_PLAN_SCHEMA_VERSION,
  LEGACY_ROLLBACK_PLAN_SCHEMA_VERSION,
  GIT_IGNORE_ORIGINS,
  GIT_VISIBILITY_OWNERSHIP_STATES,
  LEGACY_COMMON_SIBLING_SAFETY,
  LEGACY_RESTORE_SOURCE_STATUSES,
  MATERIALIZATION_MARKER_SCHEMA_VERSION,
  MATERIALIZE_ACTIONS,
  MATERIALIZE_PLAN_SCHEMA_VERSION,
  RUNTIME_ASSET_SCHEMA_VERSION,
  VISIBILITY_OWNERSHIP_STATE_SCHEMA_VERSION,
  type GitVisibilityOperationV1,
  type GitMaterializationConfigurationPlanV1,
  type GitIgnoreOrigin,
  type GitVisibilityOwnership,
  type LibrarySnapshotFileV1,
  type LibrarySnapshotManifestV1,
  type LegacyArtifactFactV1,
  type LegacyCommonSiblingSafety,
  type LegacyGitVisibilityOperationV1,
  type LegacyGitVisibilityPlanV1,
  type LegacyGitVisibilityStateV1,
  type LegacyMigrationArtifactV1,
  type LegacyMigrationPlanV1,
  type LegacyMigrationRecordV1,
  type LegacyRollbackPlanV1,
  type LegacyRestoreSourceFactV1,
  type MaterializationArtifactOwner,
  type MaterializationArtifactV1,
  type MaterializationCommitRecordV1,
  type MaterializationMarkerV1,
  type MaterializationRequestV1,
  type MaterializeAfterV1,
  type MaterializeBeforeV1,
  type MaterializeConflictKind,
  type MaterializeObservedKind,
  type MaterializeOperationV1,
  type MaterializePlanSummaryV1,
  type MaterializePlanV1,
  type RuntimeAssetFileV1,
  type RuntimeAssetManifestV1,
  type VisibilityOwnershipStateV1,
  type VisibilityOwnershipTargetV1,
  type Sha256Identifier,
  type WorktreePinV1,
  isPortableOpaqueIdentifier,
  isPortableRelativePath,
  validateMaterializationCommitRecordV1,
  validateMaterializationMarkerV1,
  validateLegacyMigrationPlanV1,
  validateMaterializePlanV1,
  validateLegacyMigrationRecordV1,
  validateLegacyRollbackPlanV1,
  validateRuntimeAssetManifestV1,
  validateVisibilityOwnershipStateV1,
  validateWorktreePinV1
} from '../contracts/index.js'
import {
  canonicalJson,
  compareUtf8Bytes,
  domainSeparatedSha256,
  type CanonicalJsonValue
} from './canonical.js'
import {
  createLibrarySnapshotManifest,
  verifyLibrarySnapshotManifest,
  type LibrarySnapshotFileFact
} from './snapshot.js'

export { GIT_IGNORE_ORIGINS }
export type { GitIgnoreOrigin }

export const RUNTIME_ASSET_HASH_DOMAIN = 'skill-graft/runtime-assets/v1' as const
export const VISIBILITY_OWNERSHIP_STATE_HASH_DOMAIN = 'skill-graft/visibility-ownership-state/v1' as const
export const VISIBILITY_OWNERSHIP_BASELINE_HASH_DOMAIN = 'skill-graft/visibility-ownership-baseline/v1' as const
export const MATERIALIZATION_ARTIFACT_HASH_DOMAIN = 'skill-graft/materialization-artifact/v1' as const
export const MATERIALIZATION_ID_HASH_DOMAIN = 'skill-graft/materialization-identity/v1' as const
export const MATERIALIZE_PLAN_HASH_DOMAIN = 'skill-graft/materialize-plan/v1' as const
export const MATERIALIZE_GIT_HASH_DOMAIN = 'skill-graft/materialize-git/v1' as const
export const GIT_VISIBILITY_FACT_HASH_DOMAIN = 'skill-graft/git-visibility-fact/v1' as const
export const GIT_TRACKED_PATHS_HASH_DOMAIN = 'skill-graft/git-tracked-paths/v1' as const
export const GIT_CONFIGURATION_VALUE_HASH_DOMAIN = 'skill-graft/git-configuration-value/v1' as const
export const GIT_CONFIGURATION_FACT_HASH_DOMAIN = 'skill-graft/git-configuration-fact/v1' as const
export const GIT_SIBLING_VISIBILITY_FACTS_HASH_DOMAIN = 'skill-graft/git-sibling-visibility-facts/v1' as const
export const MATERIALIZE_PATH_HASH_DOMAIN = 'skill-graft/materialize-path/v1' as const
export const LEGACY_MIGRATION_ID_HASH_DOMAIN = 'skill-graft/legacy-migration-identity/v1' as const
export const MATERIALIZATION_SOURCE_ARTIFACT_HASH_DOMAIN = 'skill-graft/materialization-source-artifact/v1' as const
export const LEGACY_GIT_FACTS_HASH_DOMAIN = 'skill-graft/legacy-git-facts/v1' as const
export const LEGACY_GIT_PLAN_HASH_DOMAIN = 'skill-graft/legacy-git-plan/v1' as const
export const LEGACY_BACKUP_MANIFEST_HASH_DOMAIN = 'skill-graft/legacy-backup-manifest/v1' as const
export const LEGACY_MIGRATION_PLAN_HASH_DOMAIN = 'skill-graft/legacy-migration-plan/v1' as const
export const LEGACY_ROLLBACK_PLAN_HASH_DOMAIN = 'skill-graft/legacy-rollback-plan/v1' as const

const ZERO_SHA = `sha256:${'0'.repeat(64)}` as Sha256Identifier
const SHA256_IDENTIFIER = /^sha256:[0-9a-f]{64}$/
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const FIXED_CAPTURE_TIME = '1970-01-01T00:00:00.000Z'

export type RuntimeAssetFileFact = LibrarySnapshotFileFact

export type RuntimeAssetManifestInput = {
  runtimeRevision: string
  files: readonly RuntimeAssetFileFact[]
}

export type RuntimeAssetCreationErrorCode =
  | 'RUNTIME_ASSET_INPUT_INVALID'
  | 'RUNTIME_ASSET_PATH_INVALID'
  | 'RUNTIME_ASSET_PATH_COLLISION'
  | 'RUNTIME_ASSET_REPARSE_FACT_REQUIRED'
  | 'RUNTIME_ASSET_REPARSE_FORBIDDEN'
  | 'RUNTIME_ASSET_FILE_INVALID'
  | 'RUNTIME_ASSET_MANIFEST_INVALID'

export type RuntimeAssetCreationError = {
  code: RuntimeAssetCreationErrorCode
  path: string
  message: string
}

export type RuntimeAssetCreationResult =
  | { ok: true; manifest: RuntimeAssetManifestV1; canonicalPayload: string }
  | { ok: false; errors: readonly RuntimeAssetCreationError[] }

export type SelectedMaterializationSkill = {
  name: string
  owner: 'residentSkill' | 'adoptedSkill'
  sourcePrefix: string
  targetRelativePath: string
}

export type SelectedMaterializationSkillErrorCode =
  | 'SELECTION_INVALID'
  | 'SELECTION_NOT_CANONICAL'
  | 'SELECTION_FORBIDDEN'
  | 'SELECTION_NOT_FOUND'
  | 'SELECTION_COLLISION'
  | 'SNAPSHOT_INVALID'

export type SelectedMaterializationSkillsResult =
  | { ok: true; skills: readonly SelectedMaterializationSkill[] }
  | {
      ok: false
      errors: readonly {
        code: SelectedMaterializationSkillErrorCode
        skill?: string
        message: string
      }[]
    }

export type DesiredMaterializationArtifact = MaterializationArtifactV1 & {
  source: MaterializeAfterV1['source']
  files: readonly RuntimeAssetFileV1[]
}

export type DesiredMaterialization = {
  requested: MaterializationRequestV1
  artifacts: readonly DesiredMaterializationArtifact[]
}

export type BuildDesiredMaterializationInput = {
  snapshot: LibrarySnapshotManifestV1
  selectedSkills: readonly string[]
  runtimeAsset: RuntimeAssetManifestV1
  visibilityStateId: Sha256Identifier
}

export type BuildDesiredMaterializationResult =
  | { ok: true; desired: DesiredMaterialization }
  | {
      ok: false
      errors: readonly {
        code: 'SNAPSHOT_INVALID' | 'RUNTIME_ASSET_INVALID' | 'SELECTION_INVALID' | 'BASE_ARTIFACT_MISSING'
        subject?: string
        message: string
      }[]
    }

export type MaterializationObservedArtifactFact = {
  targetRelativePath: string
  kind: 'missing' | MaterializeObservedKind
  digest?: Sha256Identifier
  isReparsePoint: boolean
  linkClassification?: 'legacy' | 'external'
  pathEscaped?: boolean
  protected?: boolean
}

export type GitVisibilityFact = {
  targetRelativePath: string
  trackedCount: number
  skippedTrackedCount: number
  ignored: boolean
  ignoreOrigin: GitIgnoreOrigin
  privateExcluded: boolean
  ownership: GitVisibilityOwnership
  ownershipStateId: Sha256Identifier | null
  baselineDigest: Sha256Identifier | null
  restoreDigest: Sha256Identifier | null
  restoreSafe: boolean
  trackedPathsDigest: Sha256Identifier
  /** Exact current proof; inner tracked paths and ignore rule text never enter the output fact or plan. */
  factDigest: Sha256Identifier
  /** Exact post-policy proof synthesized by createGitVisibilityFact. */
  desiredDigest: Sha256Identifier
}

export type GitVisibilityFactInput = {
  targetRelativePath: string
  trackedPaths: readonly { path: string; skipWorktree: boolean }[]
  ignored: boolean
  ignoreOrigin: GitIgnoreOrigin
  privateExcluded: boolean
  ownership: GitVisibilityOwnership
  ownershipStateId: Sha256Identifier | null
  baselineDigest: Sha256Identifier | null
  restoreDigest: Sha256Identifier | null
  restoreSafe: boolean
}

export type GitVisibilityFactCreationResult =
  | { ok: true; fact: GitVisibilityFact }
  | { ok: false; message: string }

/** Host-neutral proof of the private Git configuration required by materialization. */
export type GitMaterializationConfigurationFact = {
  isLinkedWorktree: boolean
  supportsWorktreeConfig: boolean
  worktreeConfigEnabled: boolean
  hooksPathMatches: boolean
  overlaySourceMatches: boolean
  watchWorkspaceMatches: boolean
  excludesFileMatches: boolean
  baseExcludeSafe: boolean
  baseExcludeValueId: Sha256Identifier | null
  baseExcludeContentDigest: Sha256Identifier
  privateExcludeContentDigest: Sha256Identifier
  desiredPrivateExcludeContentDigest: Sha256Identifier
  commonInfoExcludeClean: boolean
  legacyCommonSiblingSafety: LegacyCommonSiblingSafety
  siblingFactsDigest: Sha256Identifier
  currentDigest: Sha256Identifier
  desiredDigest: Sha256Identifier
}

export type GitMaterializationConfigurationFactInput = {
  isLinkedWorktree: boolean
  supportsWorktreeConfig: boolean
  worktreeConfigEnabled: boolean
  hooksPathValueId: Sha256Identifier | null
  desiredHooksPathValueId: Sha256Identifier
  overlaySourceValueId: Sha256Identifier | null
  desiredOverlaySourceValueId: Sha256Identifier
  watchWorkspaceValueId: Sha256Identifier | null
  desiredWatchWorkspaceValueId: Sha256Identifier
  excludesFileValueId: Sha256Identifier | null
  desiredExcludesFileValueId: Sha256Identifier | null
  baseExcludeSafe: boolean
  baseExcludeValueId: Sha256Identifier | null
  baseExcludeContentDigest: Sha256Identifier
  privateExcludeContentDigest: Sha256Identifier
  desiredPrivateExcludeContentDigest: Sha256Identifier
  commonInfoExcludeDigest: Sha256Identifier
  cleanCommonInfoExcludeDigest: Sha256Identifier
  legacyCommonSiblingSafety: LegacyCommonSiblingSafety
  siblingFactsDigest: Sha256Identifier
}

export type GitMaterializationSiblingVisibilityFact = {
  siblingPathKey: Sha256Identifier
  /** Digest of exact affected target membership plus their Git visibility facts. */
  visibilityDigest: Sha256Identifier
  /**
   * True only when every affected target is independently hidden by
   * repository/private/external rules; legacyCommon never qualifies.
   */
  equivalentlyHidden: boolean
}

export type GitMaterializationSiblingProof = {
  legacyCommonSiblingSafety: LegacyCommonSiblingSafety
  siblingFactsDigest: Sha256Identifier
}

export type GitMaterializationSiblingProofCreationResult =
  | { ok: true; proof: GitMaterializationSiblingProof }
  | { ok: false; message: string }

export type MaterializationPlanningInput = {
  pathKey: Sha256Identifier
  worktreeId: string
  stateRevision: number
  pin: WorktreePinV1
  snapshot: LibrarySnapshotManifestV1
  runtimeAsset: RuntimeAssetManifestV1
  durableMarker: MaterializationCommitRecordV1 | null
  observedMarker: unknown | null
  currentVisibilityState: VisibilityOwnershipStateV1 | null
  desiredVisibilityState: VisibilityOwnershipStateV1
  observations: readonly MaterializationObservedArtifactFact[]
  gitFacts: readonly GitVisibilityFact[]
  gitConfiguration: GitMaterializationConfigurationFact
}

export type MaterializationPlanningErrorCode =
  | 'MATERIALIZATION_INPUT_INVALID'
  | 'MATERIALIZATION_PIN_INVALID'
  | 'MATERIALIZATION_SOURCE_INVALID'
  | 'MATERIALIZATION_FACT_INVALID'

export type MaterializationPlanningError = {
  code: MaterializationPlanningErrorCode
  subject?: string
  message: string
}

export type MaterializationPlanningResult =
  | { ok: true; plan: MaterializePlanV1; canonicalPayload: string }
  | { ok: false; errors: readonly MaterializationPlanningError[] }

export type LegacyMigrationPlanningInput = {
  pathKey: Sha256Identifier
  worktreeId: string
  stateRevision: number
  pin: WorktreePinV1
  snapshot: LibrarySnapshotManifestV1
  runtimeAsset: RuntimeAssetManifestV1
  durableMarker: MaterializationCommitRecordV1 | null
  observedMarker: unknown | null
  currentVisibilityState: VisibilityOwnershipStateV1 | null
  desiredVisibilityState: VisibilityOwnershipStateV1
  backupPrivateStateId: Sha256Identifier
  migrationRecord: LegacyMigrationRecordV1 | null
  artifacts: readonly LegacyArtifactFactV1[]
  gitFacts: readonly GitVisibilityFact[]
  gitConfiguration: GitMaterializationConfigurationFact
}

export type LegacyRollbackPlanningInput = LegacyMigrationPlanningInput & {
  migrationRecord: LegacyMigrationRecordV1
  restoreSources: readonly LegacyRestoreSourceFactV1[]
  restoreGitFacts: readonly GitVisibilityFact[]
  restoreGitConfiguration: GitMaterializationConfigurationFact
}

export type LegacyPlanningErrorCode =
  | 'LEGACY_INPUT_INVALID'
  | 'LEGACY_PIN_INVALID'
  | 'LEGACY_SOURCE_INVALID'
  | 'LEGACY_MARKER_INVALID'
  | 'LEGACY_RECORD_INVALID'
  | 'LEGACY_FACT_INVALID'

export type LegacyPlanningError = {
  code: LegacyPlanningErrorCode
  subject?: string
  message: string
}

export type LegacyMigrationPlanningResult =
  | { ok: true; status: 'planned'; plan: LegacyMigrationPlanV1; canonicalPayload: string }
  | { ok: true; status: 'already-migrated'; plan: null; marker: MaterializationMarkerV1; record: LegacyMigrationRecordV1 | null }
  | { ok: true; status: 'not-required'; plan: null }
  | { ok: false; errors: readonly LegacyPlanningError[] }

export type LegacyRollbackPlanningResult =
  | { ok: true; status: 'planned'; plan: LegacyRollbackPlanV1; canonicalPayload: string }
  | { ok: true; status: 'already-rolled-back'; plan: null; record: LegacyMigrationRecordV1 }
  | { ok: false; errors: readonly LegacyPlanningError[] }

function runtimeErrorCode(snapshotCode: string): RuntimeAssetCreationErrorCode {
  switch (snapshotCode) {
    case 'SNAPSHOT_PATH_INVALID': return 'RUNTIME_ASSET_PATH_INVALID'
    case 'SNAPSHOT_PATH_COLLISION': return 'RUNTIME_ASSET_PATH_COLLISION'
    case 'SNAPSHOT_REPARSE_FACT_REQUIRED': return 'RUNTIME_ASSET_REPARSE_FACT_REQUIRED'
    case 'SNAPSHOT_REPARSE_FORBIDDEN': return 'RUNTIME_ASSET_REPARSE_FORBIDDEN'
    case 'SNAPSHOT_FILE_INVALID': return 'RUNTIME_ASSET_FILE_INVALID'
    default: return 'RUNTIME_ASSET_INPUT_INVALID'
  }
}

export function canonicalRuntimeAssetPayload(manifest: RuntimeAssetManifestV1): string {
  // runtimeAssetId is a byte identity. runtimeRevision is separately bound by
  // MaterializationRequest.materializationId so equal assets deduplicate while
  // a runtime release change still produces a distinct materialization truth.
  return canonicalJson({
    schemaVersion: RUNTIME_ASSET_SCHEMA_VERSION,
    assetKind: 'localOverlay',
    files: manifest.files.map((file) => ({
      path: file.path,
      size: file.size,
      sha256: file.sha256,
      mode: file.mode
    }))
  } satisfies CanonicalJsonValue)
}

export function createRuntimeAssetManifest(input: RuntimeAssetManifestInput): RuntimeAssetCreationResult {
  if (input == null || typeof input !== 'object'
    || !isPortableOpaqueIdentifier(input.runtimeRevision)
    || !Array.isArray(input.files) || input.files.length === 0) {
    return {
      ok: false,
      errors: [{ code: 'RUNTIME_ASSET_INPUT_INVALID', path: '$', message: 'runtime revision and at least one overlay file are required' }]
    }
  }
  const captured = createLibrarySnapshotManifest({
    source: { kind: 'library', id: 'skill-graft-runtime-assets', revision: input.runtimeRevision },
    createdAt: FIXED_CAPTURE_TIME,
    files: input.files
  })
  if (!captured.ok) {
    return {
      ok: false,
      errors: captured.errors.map((error) => ({ ...error, code: runtimeErrorCode(error.code) }))
    }
  }
  const withoutId: RuntimeAssetManifestV1 = {
    schemaVersion: RUNTIME_ASSET_SCHEMA_VERSION,
    runtimeAssetId: ZERO_SHA,
    runtimeRevision: input.runtimeRevision,
    assetKind: 'localOverlay',
    files: captured.manifest.files
  }
  const canonicalPayload = canonicalRuntimeAssetPayload(withoutId)
  const manifest: RuntimeAssetManifestV1 = {
    ...withoutId,
    runtimeAssetId: domainSeparatedSha256(RUNTIME_ASSET_HASH_DOMAIN, canonicalPayload)
  }
  const validation = validateRuntimeAssetManifestV1(manifest)
  if (!validation.valid) {
    return {
      ok: false,
      errors: validation.errors.map((error) => ({
        code: 'RUNTIME_ASSET_MANIFEST_INVALID',
        path: error.path,
        message: error.message
      }))
    }
  }
  return { ok: true, manifest: validation.value, canonicalPayload }
}

export function verifyRuntimeAssetManifest(value: unknown): value is RuntimeAssetManifestV1 {
  const validation = validateRuntimeAssetManifestV1(value)
  return validation.valid
    && domainSeparatedSha256(RUNTIME_ASSET_HASH_DOMAIN, canonicalRuntimeAssetPayload(validation.value))
      === validation.value.runtimeAssetId
}

export type VisibilityOwnershipStateInput = Omit<
  VisibilityOwnershipStateV1,
  'schemaVersion' | 'visibilityStateId'
>

export type VisibilityOwnershipStateCreationResult =
  | { ok: true; state: VisibilityOwnershipStateV1; canonicalPayload: string }
  | { ok: false; message: string }

export function canonicalVisibilityOwnershipStatePayload(state: VisibilityOwnershipStateV1): string {
  return canonicalJson({
    schemaVersion: VISIBILITY_OWNERSHIP_STATE_SCHEMA_VERSION,
    privateStateId: state.privateStateId,
    pathKey: state.pathKey,
    worktreeId: state.worktreeId,
    baseExclude: state.baseExclude,
    targets: state.targets
  } as unknown as CanonicalJsonValue)
}

export function visibilityOwnershipTargetBaselineDigest(
  target: VisibilityOwnershipTargetV1
): Sha256Identifier {
  return domainSeparatedSha256(
    VISIBILITY_OWNERSHIP_BASELINE_HASH_DOMAIN,
    canonicalJson(target as unknown as CanonicalJsonValue)
  )
}

export function createVisibilityOwnershipState(
  input: VisibilityOwnershipStateInput
): VisibilityOwnershipStateCreationResult {
  const withoutId: VisibilityOwnershipStateV1 = {
    schemaVersion: VISIBILITY_OWNERSHIP_STATE_SCHEMA_VERSION,
    visibilityStateId: ZERO_SHA,
    ...input
  }
  const validation = validateVisibilityOwnershipStateV1(withoutId)
  if (!validation.valid) return { ok: false, message: 'visibility ownership state failed strict validation' }
  const canonicalPayload = canonicalVisibilityOwnershipStatePayload(validation.value)
  const state: VisibilityOwnershipStateV1 = {
    ...validation.value,
    visibilityStateId: domainSeparatedSha256(VISIBILITY_OWNERSHIP_STATE_HASH_DOMAIN, canonicalPayload)
  }
  return { ok: true, state, canonicalPayload }
}

export function verifyVisibilityOwnershipState(value: unknown): value is VisibilityOwnershipStateV1 {
  const validation = validateVisibilityOwnershipStateV1(value)
  return validation.valid
    && domainSeparatedSha256(
      VISIBILITY_OWNERSHIP_STATE_HASH_DOMAIN,
      canonicalVisibilityOwnershipStatePayload(validation.value)
    ) === validation.value.visibilityStateId
}

function portableName(value: string): string {
  return value.toLocaleLowerCase('en-US')
}

function snapshotSkillCatalog(snapshot: LibrarySnapshotManifestV1): Map<string, SelectedMaterializationSkill[]> {
  const catalog = new Map<string, SelectedMaterializationSkill[]>()
  const add = (skill: SelectedMaterializationSkill) => {
    const key = portableName(skill.name)
    const values = catalog.get(key) ?? []
    if (!values.some((entry) => entry.owner === skill.owner && entry.name === skill.name)) values.push(skill)
    catalog.set(key, values)
  }
  for (const file of snapshot.files) {
    let match = file.path.match(/^skills\/adopted\/([^/]+)\/SKILL\.md$/u)
    if (match) {
      add({
        name: match[1],
        owner: 'adoptedSkill',
        sourcePrefix: `skills/adopted/${match[1]}`,
        targetRelativePath: `.agents/skills/${match[1]}`
      })
      continue
    }
    match = file.path.match(/^skills\/([^/]+)\/SKILL\.md$/u)
    if (match && !['adopted', 'inbox'].includes(portableName(match[1]))) {
      add({
        name: match[1],
        owner: 'residentSkill',
        sourcePrefix: `skills/${match[1]}`,
        targetRelativePath: `.agents/skills/${match[1]}`
      })
    }
  }
  return catalog
}

export function validateSelectedMaterializationSkills(
  snapshot: LibrarySnapshotManifestV1,
  selectedSkills: readonly string[]
): SelectedMaterializationSkillsResult {
  if (!verifyLibrarySnapshotManifest(snapshot)) {
    return { ok: false, errors: [{ code: 'SNAPSHOT_INVALID', message: 'library snapshot failed integrity validation' }] }
  }
  if (!Array.isArray(selectedSkills) || selectedSkills.some((skill) => typeof skill !== 'string')) {
    return { ok: false, errors: [{ code: 'SELECTION_INVALID', message: 'selected skills must be an explicit string array' }] }
  }
  const catalog = snapshotSkillCatalog(snapshot)
  const seen = new Set<string>()
  const skills: SelectedMaterializationSkill[] = []
  const errors: Array<{ code: SelectedMaterializationSkillErrorCode; skill?: string; message: string }> = []
  let previous: string | undefined
  for (const name of selectedSkills) {
    const folded = portableName(name)
    if (!SKILL_NAME.test(name)) {
      errors.push({ code: 'SELECTION_INVALID', skill: name, message: 'selected skill name is invalid' })
      continue
    }
    if (previous != null && compareUtf8Bytes(previous, name) >= 0) {
      errors.push({ code: 'SELECTION_NOT_CANONICAL', skill: name, message: 'selected skills must be in canonical UTF-8 order' })
    }
    previous = name
    if (seen.has(folded)) {
      errors.push({ code: 'SELECTION_COLLISION', skill: name, message: 'selected skills collide under portable comparison' })
      continue
    }
    seen.add(folded)
    if (folded === 'unity-skills') {
      errors.push({ code: 'SELECTION_FORBIDDEN', skill: name, message: 'unity-skills is project-owned and cannot be materialized' })
      continue
    }
    const candidates = catalog.get(folded) ?? []
    if (candidates.length === 0) {
      errors.push({ code: 'SELECTION_NOT_FOUND', skill: name, message: 'selected skill is absent from the snapshot catalog' })
      continue
    }
    if (candidates.length !== 1) {
      errors.push({ code: 'SELECTION_COLLISION', skill: name, message: 'resident and adopted skills collide at one portable target' })
      continue
    }
    if (candidates[0].name !== name) {
      errors.push({ code: 'SELECTION_NOT_CANONICAL', skill: name, message: 'selected skill must use the snapshot canonical spelling' })
      continue
    }
    skills.push(candidates[0])
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, skills }
}

function stripPrefix(file: RuntimeAssetFileV1 | LibrarySnapshotFileV1, prefix: string): RuntimeAssetFileV1 {
  const path = prefix === ''
    ? file.path
    : file.path === prefix
      ? file.path.split('/').at(-1) as string
      : file.path.slice(prefix.length + 1)
  return { path, size: file.size, sha256: file.sha256, mode: file.mode }
}

function artifactDigest(
  owner: MaterializationArtifactOwner,
  targetRelativePath: string,
  kind: 'file' | 'directory',
  files: readonly RuntimeAssetFileV1[]
): Sha256Identifier {
  return domainSeparatedSha256(MATERIALIZATION_ARTIFACT_HASH_DOMAIN, canonicalJson({
    owner,
    targetRelativePath,
    kind,
    files: files.map((file) => ({ path: file.path, size: file.size, sha256: file.sha256, mode: file.mode }))
  } satisfies CanonicalJsonValue))
}

function artifactFromFiles(
  artifactId: string,
  owner: MaterializationArtifactOwner,
  targetRelativePath: string,
  kind: 'file' | 'directory',
  files: readonly RuntimeAssetFileV1[],
  source: MaterializeAfterV1['source']
): DesiredMaterializationArtifact {
  const ordered = [...files].sort((left, right) => compareUtf8Bytes(left.path, right.path))
  return {
    artifactId,
    owner,
    targetRelativePath,
    kind,
    digest: artifactDigest(owner, targetRelativePath, kind, ordered),
    source,
    files: ordered
  }
}

export function canonicalMaterializationIdentityPayload(input: {
  snapshotId: Sha256Identifier
  selectedSkills: readonly string[]
  runtimeRevision: string
  runtimeAssetId: Sha256Identifier
  artifacts: readonly MaterializationArtifactV1[]
}): string {
  return canonicalJson({
    snapshotId: input.snapshotId,
    selectedSkills: input.selectedSkills,
    runtimeRevision: input.runtimeRevision,
    runtimeAssetId: input.runtimeAssetId,
    artifacts: input.artifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      owner: artifact.owner,
      targetRelativePath: artifact.targetRelativePath,
      kind: artifact.kind,
      digest: artifact.digest
    }))
  } satisfies CanonicalJsonValue)
}

export function buildDesiredMaterialization(
  input: BuildDesiredMaterializationInput
): BuildDesiredMaterializationResult {
  if (input == null || typeof input !== 'object'
    || !SHA256_IDENTIFIER.test(input.visibilityStateId)) {
    return { ok: false, errors: [{ code: 'SNAPSHOT_INVALID', message: 'materialization sources are required' }] }
  }
  if (!verifyLibrarySnapshotManifest(input.snapshot)) {
    return { ok: false, errors: [{ code: 'SNAPSHOT_INVALID', message: 'library snapshot failed integrity validation' }] }
  }
  if (!verifyRuntimeAssetManifest(input.runtimeAsset)) {
    return { ok: false, errors: [{ code: 'RUNTIME_ASSET_INVALID', message: 'runtime asset manifest failed integrity validation' }] }
  }
  const selection = validateSelectedMaterializationSkills(input.snapshot, input.selectedSkills)
  if (!selection.ok) {
    return {
      ok: false,
      errors: selection.errors.map((error) => ({
        code: error.code === 'SNAPSHOT_INVALID' ? 'SNAPSHOT_INVALID' : 'SELECTION_INVALID',
        subject: error.skill,
        message: error.message
      }))
    }
  }
  const override = input.snapshot.files.find((file) => file.path === 'AGENTS.override.md')
  if (!override) {
    return { ok: false, errors: [{ code: 'BASE_ARTIFACT_MISSING', subject: 'agentsOverride', message: 'snapshot lacks AGENTS.override.md' }] }
  }
  const artifacts: DesiredMaterializationArtifact[] = [artifactFromFiles(
    'agentsOverride',
    'agentsOverride',
    'AGENTS.override.md',
    'file',
    [stripPrefix(override, 'AGENTS.override.md')],
    { kind: 'snapshot', snapshotId: input.snapshot.snapshotId, prefix: 'AGENTS.override.md' }
  )]
  for (const skill of selection.skills) {
    const files = input.snapshot.files
      .filter((file) => file.path.startsWith(`${skill.sourcePrefix}/`))
      .map((file) => stripPrefix(file, skill.sourcePrefix))
    artifacts.push(artifactFromFiles(
      `${skill.owner}:${skill.name}`,
      skill.owner,
      skill.targetRelativePath,
      'directory',
      files,
      { kind: 'snapshot', snapshotId: input.snapshot.snapshotId, prefix: skill.sourcePrefix }
    ))
  }
  artifacts.push(artifactFromFiles(
    'localOverlay',
    'localOverlay',
    '.codex/local-overlay',
    'directory',
    input.runtimeAsset.files,
    { kind: 'runtimeAsset', runtimeAssetId: input.runtimeAsset.runtimeAssetId, prefix: '' }
  ))
  artifacts.sort((left, right) => compareUtf8Bytes(left.targetRelativePath, right.targetRelativePath))
  const identityPayload = canonicalMaterializationIdentityPayload({
    snapshotId: input.snapshot.snapshotId,
    selectedSkills: input.selectedSkills,
    runtimeRevision: input.runtimeAsset.runtimeRevision,
    runtimeAssetId: input.runtimeAsset.runtimeAssetId,
    artifacts
  })
  return {
    ok: true,
    desired: {
      requested: {
        snapshotId: input.snapshot.snapshotId,
        selectedSkills: [...input.selectedSkills],
        runtimeRevision: input.runtimeAsset.runtimeRevision,
        runtimeAssetId: input.runtimeAsset.runtimeAssetId,
        visibilityStateId: input.visibilityStateId,
        materializationId: domainSeparatedSha256(MATERIALIZATION_ID_HASH_DOMAIN, identityPayload)
      },
      artifacts
    }
  }
}

export function verifyMaterializationMarker(value: unknown): value is MaterializationMarkerV1 {
  const validation = validateMaterializationMarkerV1(value)
  return validation.valid
    && domainSeparatedSha256(MATERIALIZATION_ID_HASH_DOMAIN, canonicalMaterializationIdentityPayload({
      snapshotId: validation.value.snapshotId,
      selectedSkills: validation.value.selectedSkills,
      runtimeRevision: validation.value.runtimeRevision,
      runtimeAssetId: validation.value.runtimeAssetId,
      artifacts: validation.value.artifacts
    })) === validation.value.materializationId
}

function portablePathKey(value: string): string {
  return value.normalize('NFC').split('/').map((segment) => segment.toLocaleLowerCase('en-US')).join('/')
}

type MarkerReconciliationInput = Pick<
  MaterializationPlanningInput,
  'pathKey' | 'worktreeId' | 'pin' | 'durableMarker' | 'observedMarker'
>

function markerReconciliation(input: MarkerReconciliationInput): {
  status: MaterializePlanV1['markerStatus']
  current: MaterializationMarkerV1 | null
} {
  const durableValidation = input.durableMarker == null
    ? null
    : validateMaterializationCommitRecordV1(input.durableMarker)
  const observedValidation = input.observedMarker == null
    ? null
    : validateMaterializationMarkerV1(input.observedMarker)
  if (durableValidation && !durableValidation.valid || observedValidation && !observedValidation.valid) {
    return { status: 'invalid', current: null }
  }
  const durable = durableValidation?.valid ? durableValidation.value : null
  const observed = observedValidation?.valid ? observedValidation.value : null
  const durableMarker = durable?.marker ?? null
  if (durable && durable.pathKey !== input.pathKey) return { status: 'invalid', current: null }
  if (durableMarker === null && observed === null) {
    return input.pin.materializedSnapshot === null
      ? { status: 'missing', current: null }
      : { status: 'invalid', current: null }
  }
  if (!durableMarker || !observed
    || !verifyMaterializationMarker(durableMarker)
    || !verifyMaterializationMarker(observed)
    || durableMarker.pathKey !== input.pathKey
    || durableMarker.worktreeId !== input.worktreeId
    || observed.pathKey !== input.pathKey
    || observed.worktreeId !== input.worktreeId
    || input.pin.materializedSnapshot !== durableMarker.snapshotId
    || canonicalJson(durableMarker as unknown as CanonicalJsonValue)
      !== canonicalJson(observed as unknown as CanonicalJsonValue)) {
    return { status: 'invalid', current: null }
  }
  return { status: 'valid', current: durableMarker }
}

function checkedObservation(
  fact: MaterializationObservedArtifactFact
): MaterializationPlanningError | null {
  const allowedKeys = new Set([
    'targetRelativePath', 'kind', 'digest', 'isReparsePoint',
    'linkClassification', 'pathEscaped', 'protected'
  ])
  if (!fact || typeof fact !== 'object'
    || Object.keys(fact).some((key) => !allowedKeys.has(key))
    || !isPortableRelativePath(fact.targetRelativePath)
    || !['missing', 'file', 'directory', 'symlink', 'junction', 'hardlink', 'other'].includes(fact.kind)
    || typeof fact.isReparsePoint !== 'boolean'
    || fact.pathEscaped != null && typeof fact.pathEscaped !== 'boolean'
    || fact.protected != null && typeof fact.protected !== 'boolean') {
    return { code: 'MATERIALIZATION_FACT_INVALID', message: 'materialization observation is incomplete or non-portable' }
  }
  const plain = fact.kind === 'file' || fact.kind === 'directory'
  const linked = fact.kind === 'symlink' || fact.kind === 'junction' || fact.kind === 'hardlink'
  if (fact.digest !== undefined && !SHA256_IDENTIFIER.test(fact.digest)
    || fact.kind === 'missing' && (fact.digest !== undefined || fact.isReparsePoint)
    || plain && (!fact.digest || !SHA256_IDENTIFIER.test(fact.digest) || fact.isReparsePoint)
    || (fact.kind === 'symlink' || fact.kind === 'junction') && !fact.isReparsePoint
    || fact.kind === 'hardlink' && fact.isReparsePoint
    || linked && fact.linkClassification !== 'legacy' && fact.linkClassification !== 'external'
    || !linked && fact.linkClassification !== undefined) {
    return { code: 'MATERIALIZATION_FACT_INVALID', message: 'materialization observation kind, digest, or reparse facts disagree' }
  }
  return null
}

function safeConflict(
  kind: MaterializeConflictKind,
  targetRelativePath: string,
  before?: Sha256Identifier,
  after?: Sha256Identifier
): NonNullable<MaterializeOperationV1['conflict']> {
  return {
    kind,
    changedFiles: before && after ? 1 : 0,
    addedFiles: !before && after ? 1 : 0,
    removedFiles: before && !after ? 1 : 0,
    samples: [{
      pathId: domainSeparatedSha256(MATERIALIZE_PATH_HASH_DOMAIN, canonicalJson(targetRelativePath)),
      ...(before ? { before } : {}),
      ...(after ? { after } : {})
    }]
  }
}

function beforeOf(fact: MaterializationObservedArtifactFact): MaterializeBeforeV1 | null {
  if (fact.kind === 'missing') return null
  return { kind: fact.kind, ...(fact.digest ? { digest: fact.digest } : {}) }
}

function afterOf(artifact: DesiredMaterializationArtifact | undefined): MaterializeAfterV1 | null {
  return artifact ? { digest: artifact.digest, source: artifact.source } : null
}

function conflictKind(
  fact: MaterializationObservedArtifactFact,
  expectedKind: 'file' | 'directory',
  markerInvalid: boolean
): MaterializeConflictKind | null {
  if (markerInvalid) return 'marker-invalid'
  if (fact.pathEscaped) return 'path-escape'
  if (fact.protected) return 'protected-target'
  if (fact.kind === 'symlink' || fact.kind === 'junction' || fact.kind === 'hardlink') {
    return fact.linkClassification === 'legacy' ? 'legacy-link' : 'external-link'
  }
  if (fact.kind !== 'missing' && fact.kind !== expectedKind) return 'kind-mismatch'
  return null
}

function operationFor(
  desired: DesiredMaterializationArtifact | undefined,
  current: MaterializationArtifactV1 | undefined,
  fact: MaterializationObservedArtifactFact,
  markerInvalid: boolean,
  collision: boolean
): MaterializeOperationV1 {
  const template = desired ?? current as MaterializationArtifactV1
  const operation = {
    artifactId: template.artifactId,
    owner: template.owner,
    targetRelativePath: template.targetRelativePath,
    kind: template.kind
  } as const
  const before = beforeOf(fact)
  const after = afterOf(desired)
  const conflict = markerInvalid
    ? 'marker-invalid'
    : collision
      ? 'path-collision'
      : conflictKind(fact, template.kind, false)
  if (conflict) {
    return {
      ...operation,
      action: 'conflict',
      before,
      after,
      conflict: safeConflict(conflict, template.targetRelativePath, before?.digest, after?.digest)
    }
  }
  if (current) {
    if (fact.kind === 'missing' || fact.digest !== current.digest) {
      return {
        ...operation,
        action: 'conflict',
        before,
        after,
        conflict: safeConflict('dirty', template.targetRelativePath, before?.digest, after?.digest)
      }
    }
    if (!desired) {
      return { ...operation, action: 'delete', before, after: null }
    }
    if (current.digest === desired.digest) {
      return { ...operation, action: 'keep', before, after }
    }
    return { ...operation, action: 'update', before, after }
  }
  if (!desired) throw new TypeError('materialization operation requires a desired or current artifact')
  if (fact.kind === 'missing') return { ...operation, action: 'create', before: null, after }
  return {
    ...operation,
    action: 'conflict',
    before,
    after,
    conflict: safeConflict('unowned-content', template.targetRelativePath, before?.digest, after?.digest)
  }
}

function gitVisibilityProofPayload(input: {
  targetRelativePath: string
  trackedPaths: readonly { path: string; skipWorktree: boolean }[]
  ignored: boolean
  ignoreOrigin: GitIgnoreOrigin
  privateExcluded: boolean
}): string {
  return canonicalJson(input as unknown as CanonicalJsonValue)
}

export function createGitVisibilityFact(
  input: GitVisibilityFactInput
): GitVisibilityFactCreationResult {
  if (!input || typeof input !== 'object'
    || !hasExactKeys(input, [
      'targetRelativePath', 'trackedPaths', 'ignored', 'ignoreOrigin', 'privateExcluded',
      'ownership', 'ownershipStateId', 'baselineDigest', 'restoreDigest', 'restoreSafe'
    ])
    || !isPortableRelativePath(input.targetRelativePath)
    || !Array.isArray(input.trackedPaths)
    || typeof input.ignored !== 'boolean'
    || !GIT_IGNORE_ORIGINS.includes(input.ignoreOrigin)
    || typeof input.privateExcluded !== 'boolean'
    || !GIT_VISIBILITY_OWNERSHIP_STATES.includes(input.ownership)
    || input.ownershipStateId !== null && !SHA256_IDENTIFIER.test(input.ownershipStateId)
    || input.baselineDigest !== null && !SHA256_IDENTIFIER.test(input.baselineDigest)
    || input.restoreDigest !== null && !SHA256_IDENTIFIER.test(input.restoreDigest)
    || typeof input.restoreSafe !== 'boolean'
    || input.ignored !== (input.ignoreOrigin !== 'none')
    || input.ignoreOrigin === 'private' && !input.privateExcluded
    || input.ownership === 'invalid'
      && (input.baselineDigest !== null || input.restoreDigest !== null || input.restoreSafe)
    || input.ownership !== 'invalid' && input.baselineDigest === null
    || input.ownership === 'unmanaged'
      && (!input.restoreSafe || input.restoreDigest !== null)
    || input.ownership === 'managed'
      && input.restoreSafe !== (input.restoreDigest !== null)) {
    return { ok: false, message: 'Git visibility source facts are invalid' }
  }
  const tracked = [...input.trackedPaths]
  for (const entry of tracked) {
    if (!entry || typeof entry !== 'object'
      || !hasExactKeys(entry, ['path', 'skipWorktree'])
      || !isPortableRelativePath(entry.path)
      || typeof entry.skipWorktree !== 'boolean') {
      return { ok: false, message: 'tracked Git path facts are invalid' }
    }
    if (entry.path !== input.targetRelativePath
      && !entry.path.startsWith(`${input.targetRelativePath}/`)) {
      return { ok: false, message: 'tracked Git path facts must remain within the controlled target' }
    }
  }
  tracked.sort((left, right) => compareUtf8Bytes(left.path, right.path))
  for (let index = 1; index < tracked.length; index += 1) {
    if (portablePathKey(tracked[index - 1].path) === portablePathKey(tracked[index].path)) {
      return { ok: false, message: 'tracked Git path facts contain a duplicate or portable collision' }
    }
  }
  const trackedPathsDigest = domainSeparatedSha256(
    GIT_TRACKED_PATHS_HASH_DOMAIN,
    canonicalJson(tracked.map((entry) => entry.path) as unknown as CanonicalJsonValue)
  )
  const currentPayload = gitVisibilityProofPayload({
    targetRelativePath: input.targetRelativePath,
    trackedPaths: tracked,
    ignored: input.ignored,
    ignoreOrigin: input.ignoreOrigin,
    privateExcluded: input.privateExcluded
  })
  const desiredPayload = gitVisibilityProofPayload({
    targetRelativePath: input.targetRelativePath,
    trackedPaths: tracked.map((entry) => ({ path: entry.path, skipWorktree: true })),
    ignored: true,
    ignoreOrigin: input.ignoreOrigin === 'none' || input.ignoreOrigin === 'legacyCommon'
      ? 'private'
      : input.ignoreOrigin,
    privateExcluded: input.privateExcluded
      || input.ignoreOrigin === 'none'
      || input.ignoreOrigin === 'legacyCommon'
  })
  const factDigest = domainSeparatedSha256(GIT_VISIBILITY_FACT_HASH_DOMAIN, currentPayload)
  return {
    ok: true,
    fact: {
      targetRelativePath: input.targetRelativePath,
      trackedCount: tracked.length,
      skippedTrackedCount: tracked.filter((entry) => entry.skipWorktree).length,
      ignored: input.ignored,
      ignoreOrigin: input.ignoreOrigin,
      privateExcluded: input.privateExcluded,
      ownership: input.ownership,
      ownershipStateId: input.ownershipStateId,
      baselineDigest: input.baselineDigest,
      restoreDigest: input.ownership === 'unmanaged' ? factDigest : input.restoreDigest,
      restoreSafe: input.restoreSafe,
      trackedPathsDigest,
      factDigest,
      desiredDigest: domainSeparatedSha256(GIT_VISIBILITY_FACT_HASH_DOMAIN, desiredPayload)
    }
  }
}

export function gitMaterializationConfigurationValueId(value: string): Sha256Identifier {
  return domainSeparatedSha256(
    GIT_CONFIGURATION_VALUE_HASH_DOMAIN,
    canonicalJson(value)
  )
}

export function createGitMaterializationSiblingProof(
  facts: readonly GitMaterializationSiblingVisibilityFact[]
): GitMaterializationSiblingProofCreationResult {
  if (!Array.isArray(facts)) {
    return { ok: false, message: 'Git sibling visibility facts must be an array' }
  }
  const canonical = [...facts]
  for (const fact of canonical) {
    if (!fact || typeof fact !== 'object'
      || !hasExactKeys(fact, ['siblingPathKey', 'visibilityDigest', 'equivalentlyHidden'])
      || !SHA256_IDENTIFIER.test(fact.siblingPathKey)
      || !SHA256_IDENTIFIER.test(fact.visibilityDigest)
      || typeof fact.equivalentlyHidden !== 'boolean') {
      return { ok: false, message: 'Git sibling visibility fact is invalid or locator-bearing' }
    }
  }
  canonical.sort((left, right) => compareUtf8Bytes(left.siblingPathKey, right.siblingPathKey))
  if (canonical.some((fact, index) => index > 0
    && fact.siblingPathKey === canonical[index - 1].siblingPathKey)) {
    return { ok: false, message: 'Git sibling visibility facts contain a duplicate pathKey' }
  }
  const legacyCommonSiblingSafety: LegacyCommonSiblingSafety = canonical.length === 0
    ? 'noSiblings'
    : canonical.every((fact) => fact.equivalentlyHidden)
      ? 'equivalentlyHidden'
      : 'unsafe'
  return {
    ok: true,
    proof: {
      legacyCommonSiblingSafety,
      siblingFactsDigest: domainSeparatedSha256(
        GIT_SIBLING_VISIBILITY_FACTS_HASH_DOMAIN,
        canonicalJson(canonical as unknown as CanonicalJsonValue)
      )
    }
  }
}

export function createGitMaterializationConfigurationFact(
  input: GitMaterializationConfigurationFactInput
): GitMaterializationConfigurationFact {
  if (!input || typeof input !== 'object'
    || !hasExactKeys(input, [
      'isLinkedWorktree', 'supportsWorktreeConfig', 'worktreeConfigEnabled',
      'hooksPathValueId', 'desiredHooksPathValueId', 'overlaySourceValueId',
      'desiredOverlaySourceValueId', 'watchWorkspaceValueId',
      'desiredWatchWorkspaceValueId', 'excludesFileValueId',
      'desiredExcludesFileValueId', 'baseExcludeSafe', 'baseExcludeValueId',
      'baseExcludeContentDigest', 'privateExcludeContentDigest',
      'desiredPrivateExcludeContentDigest', 'commonInfoExcludeDigest',
      'cleanCommonInfoExcludeDigest', 'legacyCommonSiblingSafety',
      'siblingFactsDigest'
    ])
    || typeof input.isLinkedWorktree !== 'boolean'
    || typeof input.supportsWorktreeConfig !== 'boolean'
    || typeof input.worktreeConfigEnabled !== 'boolean'
    || input.hooksPathValueId !== null && !SHA256_IDENTIFIER.test(input.hooksPathValueId)
    || !SHA256_IDENTIFIER.test(input.desiredHooksPathValueId)
    || input.overlaySourceValueId !== null && !SHA256_IDENTIFIER.test(input.overlaySourceValueId)
    || !SHA256_IDENTIFIER.test(input.desiredOverlaySourceValueId)
    || input.watchWorkspaceValueId !== null && !SHA256_IDENTIFIER.test(input.watchWorkspaceValueId)
    || !SHA256_IDENTIFIER.test(input.desiredWatchWorkspaceValueId)
    || input.excludesFileValueId !== null && !SHA256_IDENTIFIER.test(input.excludesFileValueId)
    || input.desiredExcludesFileValueId !== null
      && !SHA256_IDENTIFIER.test(input.desiredExcludesFileValueId)
    || typeof input.baseExcludeSafe !== 'boolean'
    || input.baseExcludeValueId !== null && !SHA256_IDENTIFIER.test(input.baseExcludeValueId)
    || !SHA256_IDENTIFIER.test(input.baseExcludeContentDigest)
    || !SHA256_IDENTIFIER.test(input.privateExcludeContentDigest)
    || !SHA256_IDENTIFIER.test(input.desiredPrivateExcludeContentDigest)
    || !SHA256_IDENTIFIER.test(input.commonInfoExcludeDigest)
    || !SHA256_IDENTIFIER.test(input.cleanCommonInfoExcludeDigest)
    || !LEGACY_COMMON_SIBLING_SAFETY.includes(input.legacyCommonSiblingSafety)
    || !SHA256_IDENTIFIER.test(input.siblingFactsDigest)) {
    throw new TypeError('Git materialization configuration source facts are invalid')
  }
  const hooksPathMatches = input.hooksPathValueId === input.desiredHooksPathValueId
  const overlaySourceMatches = input.overlaySourceValueId === input.desiredOverlaySourceValueId
  const watchWorkspaceMatches = input.watchWorkspaceValueId === input.desiredWatchWorkspaceValueId
  const excludesFileMatches = input.excludesFileValueId === input.desiredExcludesFileValueId
    && input.privateExcludeContentDigest === input.desiredPrivateExcludeContentDigest
  const commonInfoExcludeClean = input.commonInfoExcludeDigest === input.cleanCommonInfoExcludeDigest
  const currentDigest = domainSeparatedSha256(
    GIT_CONFIGURATION_FACT_HASH_DOMAIN,
    canonicalJson({
      isLinkedWorktree: input.isLinkedWorktree,
      supportsWorktreeConfig: input.supportsWorktreeConfig,
      worktreeConfigEnabled: input.worktreeConfigEnabled,
      hooksPathValueId: input.hooksPathValueId,
      overlaySourceValueId: input.overlaySourceValueId,
      watchWorkspaceValueId: input.watchWorkspaceValueId,
      excludesFileValueId: input.excludesFileValueId,
      baseExcludeSafe: input.baseExcludeSafe,
      baseExcludeValueId: input.baseExcludeValueId,
      baseExcludeContentDigest: input.baseExcludeContentDigest,
      privateExcludeContentDigest: input.privateExcludeContentDigest,
      commonInfoExcludeDigest: input.commonInfoExcludeDigest
    } as unknown as CanonicalJsonValue)
  )
  const desiredDigest = domainSeparatedSha256(
    GIT_CONFIGURATION_FACT_HASH_DOMAIN,
    canonicalJson({
      isLinkedWorktree: input.isLinkedWorktree,
      supportsWorktreeConfig: true,
      worktreeConfigEnabled: true,
      hooksPathValueId: input.desiredHooksPathValueId,
      overlaySourceValueId: input.desiredOverlaySourceValueId,
      watchWorkspaceValueId: input.desiredWatchWorkspaceValueId,
      excludesFileValueId: input.desiredExcludesFileValueId,
      baseExcludeSafe: true,
      baseExcludeValueId: input.baseExcludeValueId,
      baseExcludeContentDigest: input.baseExcludeContentDigest,
      privateExcludeContentDigest: input.desiredPrivateExcludeContentDigest,
      commonInfoExcludeDigest: input.cleanCommonInfoExcludeDigest
    } as unknown as CanonicalJsonValue)
  )
  return {
    isLinkedWorktree: input.isLinkedWorktree,
    supportsWorktreeConfig: input.supportsWorktreeConfig,
    worktreeConfigEnabled: input.worktreeConfigEnabled,
    hooksPathMatches,
    overlaySourceMatches,
    watchWorkspaceMatches,
    excludesFileMatches,
    baseExcludeSafe: input.baseExcludeSafe,
    baseExcludeValueId: input.baseExcludeValueId,
    baseExcludeContentDigest: input.baseExcludeContentDigest,
    privateExcludeContentDigest: input.privateExcludeContentDigest,
    desiredPrivateExcludeContentDigest: input.desiredPrivateExcludeContentDigest,
    commonInfoExcludeClean,
    legacyCommonSiblingSafety: input.legacyCommonSiblingSafety,
    siblingFactsDigest: input.siblingFactsDigest,
    currentDigest,
    desiredDigest
  }
}

function checkedGitVisibilityFact(fact: GitVisibilityFact): boolean {
  if (!fact || typeof fact !== 'object'
    || !hasExactKeys(fact, [
      'targetRelativePath', 'trackedCount', 'skippedTrackedCount', 'ignored',
      'ignoreOrigin', 'privateExcluded', 'ownership', 'ownershipStateId',
      'baselineDigest', 'restoreDigest', 'restoreSafe', 'trackedPathsDigest',
      'factDigest', 'desiredDigest'
    ])
    || !isPortableRelativePath(fact.targetRelativePath)
    || !Number.isSafeInteger(fact.trackedCount) || fact.trackedCount < 0
    || !Number.isSafeInteger(fact.skippedTrackedCount) || fact.skippedTrackedCount < 0
    || fact.skippedTrackedCount > fact.trackedCount
    || typeof fact.ignored !== 'boolean'
    || !GIT_IGNORE_ORIGINS.includes(fact.ignoreOrigin)
    || fact.ignored !== (fact.ignoreOrigin !== 'none')
    || typeof fact.privateExcluded !== 'boolean'
    || fact.ignoreOrigin === 'private' && !fact.privateExcluded
    || !GIT_VISIBILITY_OWNERSHIP_STATES.includes(fact.ownership)
    || fact.ownershipStateId !== null && !SHA256_IDENTIFIER.test(fact.ownershipStateId)
    || fact.baselineDigest !== null && !SHA256_IDENTIFIER.test(fact.baselineDigest)
    || fact.restoreDigest !== null && !SHA256_IDENTIFIER.test(fact.restoreDigest)
    || typeof fact.restoreSafe !== 'boolean'
    || fact.ownership === 'invalid'
      && (fact.baselineDigest !== null || fact.restoreDigest !== null || fact.restoreSafe)
    || fact.ownership !== 'invalid' && fact.baselineDigest === null
    || fact.ownership === 'unmanaged'
      && (!fact.restoreSafe || fact.restoreDigest !== fact.factDigest)
    || fact.ownership === 'managed'
      && fact.restoreSafe !== (fact.restoreDigest !== null)
    || !SHA256_IDENTIFIER.test(fact.trackedPathsDigest)
    || !SHA256_IDENTIFIER.test(fact.factDigest)
    || !SHA256_IDENTIFIER.test(fact.desiredDigest)) return false
  const needsEffect = fact.skippedTrackedCount < fact.trackedCount
    || fact.ignoreOrigin === 'none'
    || fact.ignoreOrigin === 'legacyCommon'
  return needsEffect === (fact.factDigest !== fact.desiredDigest)
}

function gitConfigurationReady(fact: GitMaterializationConfigurationFact): boolean {
  return fact.supportsWorktreeConfig
    && fact.baseExcludeSafe
    && fact.worktreeConfigEnabled
    && fact.hooksPathMatches
    && fact.overlaySourceMatches
    && fact.watchWorkspaceMatches
    && fact.excludesFileMatches
    && fact.commonInfoExcludeClean
}

function checkedGitConfigurationFact(fact: GitMaterializationConfigurationFact): boolean {
  if (!fact || typeof fact !== 'object'
    || !hasExactKeys(fact, [
      'isLinkedWorktree', 'supportsWorktreeConfig', 'worktreeConfigEnabled',
      'hooksPathMatches', 'overlaySourceMatches', 'watchWorkspaceMatches',
      'excludesFileMatches', 'baseExcludeSafe', 'baseExcludeValueId',
      'baseExcludeContentDigest', 'privateExcludeContentDigest',
      'desiredPrivateExcludeContentDigest',
      'commonInfoExcludeClean', 'legacyCommonSiblingSafety',
      'siblingFactsDigest', 'currentDigest', 'desiredDigest'
    ])
    || typeof fact.isLinkedWorktree !== 'boolean'
    || typeof fact.supportsWorktreeConfig !== 'boolean'
    || typeof fact.worktreeConfigEnabled !== 'boolean'
    || typeof fact.hooksPathMatches !== 'boolean'
    || typeof fact.overlaySourceMatches !== 'boolean'
    || typeof fact.watchWorkspaceMatches !== 'boolean'
    || typeof fact.excludesFileMatches !== 'boolean'
    || typeof fact.baseExcludeSafe !== 'boolean'
    || fact.baseExcludeValueId !== null && !SHA256_IDENTIFIER.test(fact.baseExcludeValueId)
    || !SHA256_IDENTIFIER.test(fact.baseExcludeContentDigest)
    || !SHA256_IDENTIFIER.test(fact.privateExcludeContentDigest)
    || !SHA256_IDENTIFIER.test(fact.desiredPrivateExcludeContentDigest)
    || typeof fact.commonInfoExcludeClean !== 'boolean'
    || !LEGACY_COMMON_SIBLING_SAFETY.includes(fact.legacyCommonSiblingSafety)
    || !SHA256_IDENTIFIER.test(fact.siblingFactsDigest)
    || !SHA256_IDENTIFIER.test(fact.currentDigest)
    || !SHA256_IDENTIFIER.test(fact.desiredDigest)) return false
  return gitConfigurationReady(fact) === (fact.currentDigest === fact.desiredDigest)
}

function gitConfigurationPlan(
  fact: GitMaterializationConfigurationFact,
  mode: 'materialization' | 'migration'
): GitMaterializationConfigurationPlanV1 {
  // Ordinary sync never edits common info/exclude. A non-clean proof means
  // explicit legacy migration is required; that mode may remove only exact
  // Skill Graft-owned legacy entries under its private backup participant.
  const conflictKind = !fact.supportsWorktreeConfig || !fact.worktreeConfigEnabled
    ? 'unsupportedWorktreeConfig' as const
    : !fact.baseExcludeSafe
      ? 'excludeBaseUnsafe' as const
      : mode === 'materialization' && !fact.commonInfoExcludeClean
      ? 'legacyCommonInfoExclude' as const
      : mode === 'migration'
        && !fact.commonInfoExcludeClean
        && fact.legacyCommonSiblingSafety === 'unsafe'
        ? 'siblingVisibilityRisk' as const
        : null
  if (conflictKind !== null) {
    return {
      action: 'conflict',
      beforeDigest: fact.currentDigest,
      afterDigest: fact.currentDigest,
      effects: [],
      conflictKind,
      siblingFactsDigest: fact.siblingFactsDigest
    }
  }
  if (gitConfigurationReady(fact)) {
    return {
      action: 'keep',
      beforeDigest: fact.currentDigest,
      afterDigest: fact.currentDigest,
      effects: [],
      conflictKind: null,
      siblingFactsDigest: fact.siblingFactsDigest
    }
  }
  const effects: GitMaterializationConfigurationPlanV1['effects'][number][] = []
  if (!fact.hooksPathMatches) effects.push('setHooksPath')
  if (!fact.overlaySourceMatches) effects.push('setOverlaySource')
  if (!fact.watchWorkspaceMatches) effects.push('setWatchWorkspace')
  if (!fact.excludesFileMatches) effects.push('setExcludesFile')
  if (fact.privateExcludeContentDigest !== fact.desiredPrivateExcludeContentDigest) {
    effects.push('refreshExcludeProjection')
  }
  if (!fact.commonInfoExcludeClean) effects.push('removeOwnedCommonInfoExcludeEntries')
  return {
    action: 'configure',
    beforeDigest: fact.currentDigest,
    afterDigest: fact.desiredDigest,
    effects,
    conflictKind: null,
    siblingFactsDigest: fact.siblingFactsDigest
  }
}

function canonicalGitPlanPayload(plan: Pick<MaterializePlanV1['git'], 'operations' | 'configuration'>): string {
  return canonicalJson({
    operations: plan.operations,
    configuration: plan.configuration
  } as unknown as CanonicalJsonValue)
}

function visibilityTargetMatchesArtifact(
  target: VisibilityOwnershipTargetV1,
  artifact: MaterializationArtifactV1
): boolean {
  return target.artifactId === artifact.artifactId
    && target.owner === artifact.owner
    && target.targetRelativePath === artifact.targetRelativePath
}

function visibilityTargetsMatchArtifacts(
  state: VisibilityOwnershipStateV1,
  artifacts: readonly MaterializationArtifactV1[]
): boolean {
  if (state.targets.length !== artifacts.length) return false
  return state.targets.every((target, index) => visibilityTargetMatchesArtifact(target, artifacts[index]))
}

function sameVisibilityBaseline(
  left: VisibilityOwnershipTargetV1,
  right: VisibilityOwnershipTargetV1
): boolean {
  return canonicalJson(left as unknown as CanonicalJsonValue)
    === canonicalJson(right as unknown as CanonicalJsonValue)
}

function gitPlan(
  operations: readonly MaterializeOperationV1[],
  facts: readonly GitVisibilityFact[],
  configurationFact: GitMaterializationConfigurationFact
): MaterializePlanV1['git'] {
  const byPath = new Map(facts.map((fact) => [portablePathKey(fact.targetRelativePath), fact]))
  const planned: GitVisibilityOperationV1[] = operations.map((operation) => {
    const fact = byPath.get(portablePathKey(operation.targetRelativePath)) as GitVisibilityFact
    let action: GitVisibilityOperationV1['action'] = 'keep'
    if (operation.action === 'conflict' || fact.ownership === 'invalid') action = 'conflict'
    else if (operation.action === 'delete') {
      action = fact.ownership === 'managed' && fact.restoreSafe ? 'release' : 'conflict'
    } else if (operation.action === 'create' && fact.ownership !== 'unmanaged'
      || operation.action !== 'create' && fact.ownership !== 'managed') {
      action = 'conflict'
    } else {
      const needSkip = fact.skippedTrackedCount < fact.trackedCount
      const needExclude = fact.ignoreOrigin === 'none' || fact.ignoreOrigin === 'legacyCommon'
      if (needSkip && needExclude) action = 'setSkipAndExclude'
      else if (needSkip) action = 'setSkipWorktree'
      else if (needExclude) action = 'excludeLocal'
      else if (operation.action === 'create') action = 'adopt'
    }
    return {
      artifactId: operation.artifactId,
      targetRelativePath: operation.targetRelativePath,
      action,
      ownership: fact.ownership,
      ownershipStateId: fact.ownershipStateId,
      baselineDigest: fact.baselineDigest,
      restoreDigest: fact.restoreDigest,
      restoreSafe: fact.restoreSafe,
      beforeDigest: fact.factDigest,
      afterDigest: action === 'release'
        ? fact.restoreDigest as Sha256Identifier
        : action === 'keep' || action === 'adopt' || action === 'conflict'
          ? fact.factDigest
          : fact.desiredDigest
    }
  })
  const withoutDigest = {
    operations: planned,
    configuration: gitConfigurationPlan(configurationFact, 'materialization')
  }
  return {
    digest: domainSeparatedSha256(MATERIALIZE_GIT_HASH_DOMAIN, canonicalGitPlanPayload(withoutDigest)),
    ...withoutDigest
  }
}

export function canonicalMaterializePlanPayload(plan: MaterializePlanV1): string {
  const { planHash: _planHash, ...payload } = plan
  return canonicalJson(payload as unknown as CanonicalJsonValue)
}

export function planMaterialization(input: MaterializationPlanningInput): MaterializationPlanningResult {
  if (!input || typeof input !== 'object'
    || !SHA256_IDENTIFIER.test(input.pathKey)
    || !isPortableOpaqueIdentifier(input.worktreeId)
    || !Number.isSafeInteger(input.stateRevision) || input.stateRevision < 0
    || !Array.isArray(input.observations)
    || !Array.isArray(input.gitFacts)
    || !verifyVisibilityOwnershipState(input.desiredVisibilityState)
    || input.currentVisibilityState !== null
      && !verifyVisibilityOwnershipState(input.currentVisibilityState)
    || input.desiredVisibilityState.pathKey !== input.pathKey
    || input.desiredVisibilityState.worktreeId !== input.worktreeId
    || input.currentVisibilityState !== null
      && (input.currentVisibilityState.pathKey !== input.pathKey
        || input.currentVisibilityState.worktreeId !== input.worktreeId)) {
    return { ok: false, errors: [{ code: 'MATERIALIZATION_INPUT_INVALID', message: 'materialization identity and facts are invalid' }] }
  }
  const pinValidation = validateWorktreePinV1(input.pin)
  if (!pinValidation.valid
    || pinValidation.value.claimState !== 'claimed'
    || pinValidation.value.pathKey !== input.pathKey
    || pinValidation.value.worktreeId !== input.worktreeId) {
    return { ok: false, errors: [{ code: 'MATERIALIZATION_PIN_INVALID', message: 'a matching claimed pin is required' }] }
  }
  const desiredResult = buildDesiredMaterialization({
    snapshot: input.snapshot,
    selectedSkills: pinValidation.value.selectedSkills,
    runtimeAsset: input.runtimeAsset,
    visibilityStateId: input.desiredVisibilityState.visibilityStateId
  })
  if (!desiredResult.ok) {
    return {
      ok: false,
      errors: desiredResult.errors.map((error) => ({
        code: 'MATERIALIZATION_SOURCE_INVALID',
        subject: error.subject,
        message: error.message
      }))
    }
  }
  if (pinValidation.value.requestedSnapshot !== desiredResult.desired.requested.snapshotId) {
    return { ok: false, errors: [{ code: 'MATERIALIZATION_PIN_INVALID', message: 'pin request must match the desired snapshot' }] }
  }
  const errors = input.observations.map(checkedObservation).filter((error): error is MaterializationPlanningError => error !== null)
  for (const fact of input.gitFacts) {
    if (!checkedGitVisibilityFact(fact)) {
      errors.push({ code: 'MATERIALIZATION_FACT_INVALID', message: 'Git visibility fact is invalid' })
    }
  }
  if (!checkedGitConfigurationFact(input.gitConfiguration)) {
    errors.push({ code: 'MATERIALIZATION_FACT_INVALID', message: 'Git materialization configuration fact is invalid' })
  }
  if (errors.length > 0) return { ok: false, errors }

  const reconciliation = markerReconciliation(input)
  const desiredByPath = new Map(desiredResult.desired.artifacts.map((artifact) => [portablePathKey(artifact.targetRelativePath), artifact]))
  const currentByPath = new Map((reconciliation.current?.artifacts ?? []).map((artifact) => [portablePathKey(artifact.targetRelativePath), artifact]))
  if (reconciliation.current === null) {
    if (reconciliation.status !== 'invalid' && input.currentVisibilityState !== null) {
      return { ok: false, errors: [{ code: 'MATERIALIZATION_FACT_INVALID', message: 'visibility ownership state exists without a valid current marker' }] }
    }
  } else if (input.currentVisibilityState === null
    || input.currentVisibilityState.visibilityStateId !== reconciliation.current.visibilityStateId
    || !visibilityTargetsMatchArtifacts(input.currentVisibilityState, reconciliation.current.artifacts)) {
    return { ok: false, errors: [{ code: 'MATERIALIZATION_FACT_INVALID', message: 'current visibility ownership state does not exactly match the marker' }] }
  }
  if (!visibilityTargetsMatchArtifacts(input.desiredVisibilityState, desiredResult.desired.artifacts)) {
    return { ok: false, errors: [{ code: 'MATERIALIZATION_FACT_INVALID', message: 'desired visibility ownership state does not exactly cover desired artifacts' }] }
  }
  if (input.desiredVisibilityState.baseExclude.valueId !== input.gitConfiguration.baseExcludeValueId
    || input.desiredVisibilityState.baseExclude.contentDigest !== input.gitConfiguration.baseExcludeContentDigest) {
    return { ok: false, errors: [{ code: 'MATERIALIZATION_FACT_INVALID', message: 'desired visibility state and Git base-exclude projection facts disagree' }] }
  }
  const controlledKeys = new Set([...desiredByPath.keys(), ...currentByPath.keys()])
  const observations = new Map<string, MaterializationObservedArtifactFact[]>()
  for (const fact of input.observations) {
    const key = portablePathKey(fact.targetRelativePath)
    if (!controlledKeys.has(key)) continue
    observations.set(key, [...(observations.get(key) ?? []), fact])
  }
  const missingFacts = [...controlledKeys].filter((key) => !observations.has(key))
  if (missingFacts.length > 0) {
    return { ok: false, errors: [{ code: 'MATERIALIZATION_FACT_INVALID', message: 'observation set does not cover every controlled target' }] }
  }
  const gitFacts = new Map<string, GitVisibilityFact[]>()
  for (const fact of input.gitFacts) {
    const key = portablePathKey(fact.targetRelativePath)
    if (!controlledKeys.has(key)) {
      return { ok: false, errors: [{ code: 'MATERIALIZATION_FACT_INVALID', message: 'Git visibility set contains an uncontrolled target' }] }
    }
    gitFacts.set(key, [...(gitFacts.get(key) ?? []), fact])
  }
  if ([...controlledKeys].some((key) => gitFacts.get(key)?.length !== 1)) {
    return { ok: false, errors: [{ code: 'MATERIALIZATION_FACT_INVALID', message: 'Git visibility set must contain exactly one fact for every controlled target' }] }
  }
  for (const key of controlledKeys) {
    const controlled = desiredByPath.get(key) ?? currentByPath.get(key) as MaterializationArtifactV1
    if (gitFacts.get(key)?.[0].targetRelativePath !== controlled.targetRelativePath) {
      return { ok: false, errors: [{ code: 'MATERIALIZATION_FACT_INVALID', message: 'Git visibility target spelling must exactly match the controlled artifact' }] }
    }
  }
  const currentVisibilityByPath = new Map((input.currentVisibilityState?.targets ?? []).map((target) => [
    portablePathKey(target.targetRelativePath),
    target
  ]))
  const desiredVisibilityByPath = new Map(input.desiredVisibilityState.targets.map((target) => [
    portablePathKey(target.targetRelativePath),
    target
  ]))
  for (const key of controlledKeys) {
    const currentTarget = currentVisibilityByPath.get(key)
    const desiredTarget = desiredVisibilityByPath.get(key)
    const fact = gitFacts.get(key)?.[0] as GitVisibilityFact
    if (currentTarget && desiredTarget && !sameVisibilityBaseline(currentTarget, desiredTarget)) {
      return { ok: false, errors: [{ code: 'MATERIALIZATION_FACT_INVALID', message: 'retained visibility ownership baseline cannot change' }] }
    }
    const baseline = currentTarget ?? desiredTarget
    const expectedOwnership = currentTarget ? 'managed' : 'unmanaged'
    if (fact.ownershipStateId !== (input.currentVisibilityState?.visibilityStateId ?? null)
      || fact.ownership === expectedOwnership
        && (baseline === undefined
          || fact.baselineDigest !== visibilityOwnershipTargetBaselineDigest(baseline))) {
      return { ok: false, errors: [{ code: 'MATERIALIZATION_FACT_INVALID', message: 'Git visibility fact does not bind the exact ownership baseline' }] }
    }
  }

  const operations: MaterializeOperationV1[] = []
  for (const key of [...controlledKeys].sort(compareUtf8Bytes)) {
    const desired = desiredByPath.get(key)
    const current = currentByPath.get(key)
    const facts = observations.get(key) as MaterializationObservedArtifactFact[]
    const controlledTarget = (desired ?? current as MaterializationArtifactV1).targetRelativePath
    const exact = facts.find((fact) => fact.targetRelativePath === controlledTarget)
    operations.push(operationFor(
      desired,
      current,
      exact ?? facts[0],
      reconciliation.status === 'invalid',
      facts.length !== 1 || exact === undefined
    ))
  }
  operations.sort((left, right) => compareUtf8Bytes(left.targetRelativePath, right.targetRelativePath))
  const summary = Object.fromEntries(MATERIALIZE_ACTIONS.map((action) => [
    action,
    operations.filter((operation) => operation.action === action).length
  ])) as MaterializePlanSummaryV1
  const git = gitPlan(operations, input.gitFacts, input.gitConfiguration)
  const withoutHash: MaterializePlanV1 = {
    schemaVersion: MATERIALIZE_PLAN_SCHEMA_VERSION,
    planHash: ZERO_SHA,
    pathKey: input.pathKey,
    worktreeId: input.worktreeId,
    stateRevision: input.stateRevision,
    requested: desiredResult.desired.requested,
    current: reconciliation.current,
    markerStatus: reconciliation.status,
    operations,
    git,
    summary,
    executable: summary.conflict === 0
      && git.operations.every((operation) => operation.action !== 'conflict')
      && git.configuration.action !== 'conflict'
  }
  const canonicalPayload = canonicalMaterializePlanPayload(withoutHash)
  const plan: MaterializePlanV1 = {
    ...withoutHash,
    planHash: domainSeparatedSha256(MATERIALIZE_PLAN_HASH_DOMAIN, canonicalPayload)
  }
  const validation = validateMaterializePlanV1(plan)
  if (!validation.valid) {
    return {
      ok: false,
      errors: [{ code: 'MATERIALIZATION_INPUT_INVALID', message: 'planned materialization failed frozen contract validation' }]
    }
  }
  return { ok: true, plan: validation.value, canonicalPayload }
}

export function verifyMaterializePlanHash(value: unknown): value is MaterializePlanV1 {
  const validation = validateMaterializePlanV1(value)
  return validation.valid
    && (validation.value.current === null || verifyMaterializationMarker(validation.value.current))
    && domainSeparatedSha256(
      MATERIALIZATION_ID_HASH_DOMAIN,
      canonicalMaterializationIdentityPayload({
        snapshotId: validation.value.requested.snapshotId,
        selectedSkills: validation.value.requested.selectedSkills,
        runtimeRevision: validation.value.requested.runtimeRevision,
        runtimeAssetId: validation.value.requested.runtimeAssetId,
        artifacts: validation.value.operations
          .filter((operation): operation is MaterializeOperationV1 & { after: MaterializeAfterV1 } => operation.after !== null)
          .map((operation) => ({
            artifactId: operation.artifactId,
            owner: operation.owner,
            targetRelativePath: operation.targetRelativePath,
            kind: operation.kind,
            digest: operation.after.digest
          }))
      })
    ) === validation.value.requested.materializationId
    && domainSeparatedSha256(
      MATERIALIZE_GIT_HASH_DOMAIN,
      canonicalGitPlanPayload(validation.value.git)
    ) === validation.value.git.digest
    && domainSeparatedSha256(MATERIALIZE_PLAN_HASH_DOMAIN, canonicalMaterializePlanPayload(validation.value))
      === validation.value.planHash
}

export function canonicalMaterializationSourceArtifactPayload(after: MaterializeAfterV1): string {
  return canonicalJson({ digest: after.digest, source: after.source } as unknown as CanonicalJsonValue)
}

export function materializationSourceArtifactId(after: MaterializeAfterV1): Sha256Identifier {
  return domainSeparatedSha256(
    MATERIALIZATION_SOURCE_ARTIFACT_HASH_DOMAIN,
    canonicalMaterializationSourceArtifactPayload(after)
  )
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function checkedLegacyArtifactFact(fact: LegacyArtifactFactV1): boolean {
  if (!fact || typeof fact !== 'object'
    || !hasExactKeys(fact, [
      'artifactId', 'owner', 'targetRelativePath', 'kind', 'observedKind', 'digest',
      'isReparsePoint', 'legacyKind', 'sourceArtifactId', 'pathEscaped', 'protected'
    ])
    || typeof fact.artifactId !== 'string'
    || !['agentsOverride', 'residentSkill', 'adoptedSkill', 'localOverlay'].includes(fact.owner)
    || !isPortableRelativePath(fact.targetRelativePath)
    || fact.kind !== 'file' && fact.kind !== 'directory'
    || !['missing', 'file', 'directory', 'symlink', 'junction', 'hardlink', 'other'].includes(fact.observedKind)
    || typeof fact.isReparsePoint !== 'boolean'
    || typeof fact.pathEscaped !== 'boolean'
    || typeof fact.protected !== 'boolean'
    || fact.digest !== null && !SHA256_IDENTIFIER.test(fact.digest)
    || fact.sourceArtifactId !== null && !SHA256_IDENTIFIER.test(fact.sourceArtifactId)
    || fact.legacyKind !== null && fact.legacyKind !== 'directoryLink' && fact.legacyKind !== 'fileHardlink') {
    return false
  }
  const linked = fact.observedKind === 'symlink'
    || fact.observedKind === 'junction'
    || fact.observedKind === 'hardlink'
  if (fact.observedKind === 'missing') {
    return fact.digest === null
      && !fact.isReparsePoint
      && fact.legacyKind === null
      && fact.sourceArtifactId === null
  }
  if (fact.digest === null) return false
  if (fact.observedKind === 'file' || fact.observedKind === 'directory') {
    return !fact.isReparsePoint && fact.legacyKind === null && fact.sourceArtifactId === null
  }
  if (fact.observedKind === 'junction') {
    return fact.isReparsePoint
      && fact.sourceArtifactId !== null
      && (fact.legacyKind === null || fact.legacyKind === 'directoryLink')
  }
  if (fact.observedKind === 'hardlink') {
    return !fact.isReparsePoint
      && fact.sourceArtifactId !== null
      && (fact.legacyKind === null || fact.legacyKind === 'fileHardlink')
  }
  if (fact.observedKind === 'symlink') {
    return fact.isReparsePoint && fact.sourceArtifactId !== null && fact.legacyKind === null
  }
  return !linked && fact.legacyKind === null && fact.sourceArtifactId === null
}

function checkedLegacyGitFact(fact: GitVisibilityFact): boolean {
  return checkedGitVisibilityFact(fact)
}

function checkedLegacyRestoreSourceFact(fact: LegacyRestoreSourceFactV1): boolean {
  return Boolean(fact && typeof fact === 'object'
    && hasExactKeys(fact, [
      'artifactId', 'targetRelativePath', 'legacyKind', 'sourceArtifactId',
      'sourceStateId', 'status'
    ])
    && typeof fact.artifactId === 'string'
    && isPortableRelativePath(fact.targetRelativePath)
    && (fact.legacyKind === 'directoryLink' || fact.legacyKind === 'fileHardlink')
    && SHA256_IDENTIFIER.test(fact.sourceArtifactId)
    && SHA256_IDENTIFIER.test(fact.sourceStateId)
    && LEGACY_RESTORE_SOURCE_STATUSES.includes(fact.status))
}

function gitState(fact: GitVisibilityFact): LegacyGitVisibilityStateV1 {
  return {
    trackedCount: fact.trackedCount,
    skippedTrackedCount: fact.skippedTrackedCount,
    ignored: fact.ignored,
    ignoreOrigin: fact.ignoreOrigin,
    privateExcluded: fact.privateExcluded,
    trackedPathsDigest: fact.trackedPathsDigest,
    factDigest: fact.factDigest
  }
}

function desiredGitState(fact: GitVisibilityFact): LegacyGitVisibilityStateV1 {
  return {
    trackedCount: fact.trackedCount,
    skippedTrackedCount: fact.trackedCount,
    ignored: true,
    ignoreOrigin: fact.ignoreOrigin === 'none' || fact.ignoreOrigin === 'legacyCommon'
      ? 'private'
      : fact.ignoreOrigin,
    privateExcluded: fact.privateExcluded
      || fact.ignoreOrigin === 'none'
      || fact.ignoreOrigin === 'legacyCommon',
    trackedPathsDigest: fact.trackedPathsDigest,
    factDigest: fact.desiredDigest
  }
}

function sameLegacyGitState(left: LegacyGitVisibilityStateV1, right: LegacyGitVisibilityStateV1): boolean {
  return left.trackedCount === right.trackedCount
    && left.skippedTrackedCount === right.skippedTrackedCount
    && left.ignored === right.ignored
    && left.ignoreOrigin === right.ignoreOrigin
    && left.privateExcluded === right.privateExcluded
    && left.trackedPathsDigest === right.trackedPathsDigest
    && left.factDigest === right.factDigest
}

export function canonicalLegacyGitFactsPayload(
  artifacts: readonly Pick<MaterializationArtifactV1, 'artifactId' | 'targetRelativePath'>[],
  facts: readonly GitVisibilityFact[],
  configuration: GitMaterializationConfigurationFact
): string {
  return canonicalJson({
    operations: artifacts.map((artifact, index) => ({
      artifactId: artifact.artifactId,
      targetRelativePath: artifact.targetRelativePath,
      ...gitState(facts[index])
    })),
    configuration
  } as unknown as CanonicalJsonValue)
}

function legacyGitFactsDigest(
  artifacts: readonly Pick<MaterializationArtifactV1, 'artifactId' | 'targetRelativePath'>[],
  facts: readonly GitVisibilityFact[],
  configuration: GitMaterializationConfigurationFact
): Sha256Identifier {
  return domainSeparatedSha256(
    LEGACY_GIT_FACTS_HASH_DOMAIN,
    canonicalLegacyGitFactsPayload(artifacts, facts, configuration)
  )
}

export function canonicalLegacyGitPlanPayload(plan: LegacyGitVisibilityPlanV1): string {
  return canonicalJson({
    operations: plan.operations,
    configuration: plan.configuration
  } as unknown as CanonicalJsonValue)
}

function legacyGitPlanDigest(plan: Pick<LegacyGitVisibilityPlanV1, 'operations' | 'configuration'>): Sha256Identifier {
  return domainSeparatedSha256(
    LEGACY_GIT_PLAN_HASH_DOMAIN,
    canonicalJson({
      operations: plan.operations,
      configuration: plan.configuration
    } as unknown as CanonicalJsonValue)
  )
}

function exactLegacyFacts(
  artifacts: readonly DesiredMaterializationArtifact[],
  facts: readonly LegacyArtifactFactV1[],
  gitFacts: readonly GitVisibilityFact[],
  configuration: GitMaterializationConfigurationFact,
  restoreGitFacts?: readonly GitVisibilityFact[],
  restoreConfiguration?: GitMaterializationConfigurationFact
): LegacyPlanningError[] {
  const errors: LegacyPlanningError[] = []
  if (!Array.isArray(facts) || !Array.isArray(gitFacts)
    || restoreGitFacts !== undefined && !Array.isArray(restoreGitFacts)
    || facts.length !== artifacts.length
    || gitFacts.length !== artifacts.length
    || restoreGitFacts !== undefined && restoreGitFacts.length !== artifacts.length) {
    return [{ code: 'LEGACY_FACT_INVALID', message: 'legacy artifact and Git facts must exactly cover desired targets' }]
  }
  artifacts.forEach((artifact, index) => {
    const fact = facts[index]
    if (!checkedLegacyArtifactFact(fact)
      || fact.artifactId !== artifact.artifactId
      || fact.owner !== artifact.owner
      || fact.targetRelativePath !== artifact.targetRelativePath
      || fact.kind !== artifact.kind) {
      errors.push({ code: 'LEGACY_FACT_INVALID', subject: artifact.artifactId, message: 'legacy artifact fact identity or shape is invalid' })
    }
    const gitFact = gitFacts[index]
    if (!checkedLegacyGitFact(gitFact) || gitFact.targetRelativePath !== artifact.targetRelativePath) {
      errors.push({ code: 'LEGACY_FACT_INVALID', subject: artifact.artifactId, message: 'legacy Git fact identity or state is invalid' })
    }
    const restore = restoreGitFacts?.[index]
    if (restoreGitFacts !== undefined
      && (!checkedLegacyGitFact(restore) || restore.targetRelativePath !== artifact.targetRelativePath)) {
      errors.push({ code: 'LEGACY_FACT_INVALID', subject: artifact.artifactId, message: 'legacy backed-up Git fact identity or state is invalid' })
    }
  })
  if (!checkedGitConfigurationFact(configuration)) {
    errors.push({ code: 'LEGACY_FACT_INVALID', message: 'legacy Git materialization configuration fact is invalid' })
  }
  if (restoreConfiguration !== undefined && !checkedGitConfigurationFact(restoreConfiguration)) {
    errors.push({ code: 'LEGACY_FACT_INVALID', message: 'legacy backed-up Git configuration fact is invalid' })
  }
  return errors
}

function legacyBefore(fact: LegacyArtifactFactV1): MaterializeBeforeV1 | null {
  return fact.observedKind === 'missing'
    ? null
    : { kind: fact.observedKind, ...(fact.digest ? { digest: fact.digest } : {}) }
}

function legacyMigrationOperation(
  artifact: DesiredMaterializationArtifact,
  fact: LegacyArtifactFactV1
): LegacyMigrationPlanV1['operations'][number] {
  const before = legacyBefore(fact)
  const after: MaterializeAfterV1 = { digest: artifact.digest, source: artifact.source }
  const expectedObserved = artifact.kind === 'file' ? 'hardlink' : 'junction'
  const expectedLegacy = artifact.kind === 'file' ? 'fileHardlink' : 'directoryLink'
  const expectedSource = materializationSourceArtifactId(after)
  const legacy = fact.legacyKind && fact.sourceArtifactId
    ? { legacyKind: fact.legacyKind, sourceArtifactId: fact.sourceArtifactId }
    : null
  const base = {
    artifactId: artifact.artifactId,
    owner: artifact.owner,
    targetRelativePath: artifact.targetRelativePath,
    kind: artifact.kind,
    before,
    after,
    legacy
  } as const
  let conflict: MaterializeConflictKind | null = null
  if (fact.pathEscaped) conflict = 'path-escape'
  else if (fact.protected) conflict = 'protected-target'
  else if (fact.observedKind === expectedObserved && fact.legacyKind === expectedLegacy) {
    if (fact.sourceArtifactId !== expectedSource) conflict = 'external-link'
    else if (fact.digest !== artifact.digest) conflict = 'dirty'
    else return { ...base, action: 'replaceWithCopy' }
  } else if (fact.observedKind === artifact.kind && fact.legacyKind === null) {
    conflict = 'unowned-content'
  } else if (fact.observedKind === 'junction'
    || fact.observedKind === 'hardlink'
    || fact.observedKind === 'symlink') {
    conflict = fact.legacyKind ? 'legacy-link' : 'external-link'
  } else if (fact.observedKind === 'missing') return { ...base, action: 'create' }
  else conflict = 'kind-mismatch'
  return {
    ...base,
    action: 'conflict',
    conflict: safeConflict(conflict, artifact.targetRelativePath, fact.digest ?? undefined, artifact.digest)
  }
}

function createMigrationGitPlan(
  operations: readonly LegacyMigrationPlanV1['operations'][number][],
  facts: readonly GitVisibilityFact[],
  configurationFact: GitMaterializationConfigurationFact
): LegacyGitVisibilityPlanV1 {
  const planned: LegacyGitVisibilityOperationV1[] = operations.map((operation, index) => {
    const before = gitState(facts[index])
    if (operation.action === 'conflict') {
      return { artifactId: operation.artifactId, targetRelativePath: operation.targetRelativePath, action: 'conflict', before, after: before }
    }
    const after = desiredGitState(facts[index])
    return {
      artifactId: operation.artifactId,
      targetRelativePath: operation.targetRelativePath,
      action: sameLegacyGitState(before, after) ? 'keep' : 'apply',
      before,
      after
    }
  })
  const withoutDigest = {
    operations: planned,
    configuration: gitConfigurationPlan(configurationFact, 'migration')
  }
  return { digest: legacyGitPlanDigest(withoutDigest), ...withoutDigest }
}

function migratedArtifacts(
  operations: readonly LegacyMigrationPlanV1['operations'][number][]
): LegacyMigrationArtifactV1[] {
  return operations
    .filter((operation): operation is typeof operation & {
      before: MaterializeBeforeV1 & { digest: Sha256Identifier }
      legacy: { legacyKind: 'directoryLink' | 'fileHardlink'; sourceArtifactId: Sha256Identifier }
    } => operation.action === 'replaceWithCopy'
      && operation.before?.digest !== undefined
      && operation.legacy !== null)
    .map((operation) => ({
      artifactId: operation.artifactId,
      owner: operation.owner,
      targetRelativePath: operation.targetRelativePath,
      kind: operation.kind,
      legacyKind: operation.legacy.legacyKind,
      sourceArtifactId: operation.legacy.sourceArtifactId,
      beforeDigest: operation.before.digest,
      afterDigest: operation.after.digest
    }))
}

function createdMigrationArtifacts(
  operations: readonly LegacyMigrationPlanV1['operations'][number][]
): MaterializationArtifactV1[] {
  return operations
    .filter((operation) => operation.action === 'create')
    .map((operation) => ({
      artifactId: operation.artifactId,
      owner: operation.owner,
      targetRelativePath: operation.targetRelativePath,
      kind: operation.kind,
      digest: operation.after.digest
    }))
}

export function canonicalLegacyBackupManifestPayload(input: {
  pathKey: Sha256Identifier
  worktreeId: string
  artifacts: readonly LegacyMigrationArtifactV1[]
  gitBeforeDigest: Sha256Identifier
  backupPrivateStateId: Sha256Identifier
}): string {
  return canonicalJson({
    pathKey: input.pathKey,
    worktreeId: input.worktreeId,
    artifacts: input.artifacts,
    gitBeforeDigest: input.gitBeforeDigest,
    backupPrivateStateId: input.backupPrivateStateId
  } as unknown as CanonicalJsonValue)
}

function legacyBackupManifestId(input: {
  pathKey: Sha256Identifier
  worktreeId: string
  artifacts: readonly LegacyMigrationArtifactV1[]
  gitBeforeDigest: Sha256Identifier
  backupPrivateStateId: Sha256Identifier
}): Sha256Identifier {
  return domainSeparatedSha256(
    LEGACY_BACKUP_MANIFEST_HASH_DOMAIN,
    canonicalLegacyBackupManifestPayload(input)
  )
}

export function canonicalLegacyMigrationPlanPayload(plan: LegacyMigrationPlanV1): string {
  const { planHash: _planHash, migrationId: _migrationId, ...payload } = plan
  return canonicalJson(payload as unknown as CanonicalJsonValue)
}

function migrationIdentityFromPlan(plan: LegacyMigrationPlanV1): Parameters<typeof canonicalLegacyMigrationRecordIdentityPayload>[0] {
  return {
    planHash: plan.planHash,
    pathKey: plan.pathKey,
    worktreeId: plan.worktreeId,
    snapshotId: plan.requested.snapshotId,
    materializationId: plan.requested.materializationId,
    visibilityStateId: plan.requested.visibilityStateId,
    backupManifestId: plan.backupManifestId,
    backupPrivateStateId: plan.backupPrivateStateId,
    artifacts: migratedArtifacts(plan.operations),
    createdArtifacts: createdMigrationArtifacts(plan.operations),
    gitVisibilityDigest: plan.gitBeforeDigest
  }
}

function legacyInputIdentityValid(input: LegacyMigrationPlanningInput, rollback = false): boolean {
  const keys = [
    'pathKey', 'worktreeId', 'stateRevision', 'pin', 'snapshot', 'runtimeAsset',
    'durableMarker', 'observedMarker', 'currentVisibilityState', 'desiredVisibilityState',
    'backupPrivateStateId',
    'migrationRecord', 'artifacts', 'gitFacts',
    'gitConfiguration',
    ...(rollback ? ['restoreSources', 'restoreGitFacts', 'restoreGitConfiguration'] : [])
  ]
  return Boolean(input && typeof input === 'object'
    && hasExactKeys(input, keys)
    && SHA256_IDENTIFIER.test(input.pathKey)
    && isPortableOpaqueIdentifier(input.worktreeId)
    && Number.isSafeInteger(input.stateRevision)
    && input.stateRevision >= 0
    && SHA256_IDENTIFIER.test(input.backupPrivateStateId)
    && verifyVisibilityOwnershipState(input.desiredVisibilityState)
    && (input.currentVisibilityState === null
      || verifyVisibilityOwnershipState(input.currentVisibilityState))
    && input.desiredVisibilityState.pathKey === input.pathKey
    && input.desiredVisibilityState.worktreeId === input.worktreeId
    && (input.currentVisibilityState === null
      || input.currentVisibilityState.pathKey === input.pathKey
        && input.currentVisibilityState.worktreeId === input.worktreeId)
    && Array.isArray(input.artifacts)
    && Array.isArray(input.gitFacts))
}

function legacyRecordMatchesMarker(
  record: LegacyMigrationRecordV1,
  marker: MaterializationMarkerV1
): boolean {
  return verifyLegacyMigrationRecordIdentity(record)
    && record.status === 'committed'
    && marker.origin.kind === 'legacyMigration'
    && marker.origin.migrationId === record.migrationId
    && marker.planHash === record.planHash
    && marker.pathKey === record.pathKey
    && marker.worktreeId === record.worktreeId
    && marker.snapshotId === record.snapshotId
    && marker.materializationId === record.materializationId
    && marker.visibilityStateId === record.visibilityStateId
}

function exactMaterializedCopies(
  artifacts: readonly DesiredMaterializationArtifact[],
  facts: readonly LegacyArtifactFactV1[]
): boolean {
  return artifacts.every((artifact, index) => {
    const fact = facts[index]
    return fact.observedKind === artifact.kind
      && fact.digest === artifact.digest
      && !fact.isReparsePoint
      && fact.legacyKind === null
      && fact.sourceArtifactId === null
      && !fact.pathEscaped
      && !fact.protected
  })
}

export function planLegacyMigration(input: LegacyMigrationPlanningInput): LegacyMigrationPlanningResult {
  if (!legacyInputIdentityValid(input)) {
    return { ok: false, errors: [{ code: 'LEGACY_INPUT_INVALID', message: 'legacy migration identity and flat facts are invalid' }] }
  }
  const pin = validateWorktreePinV1(input.pin)
  if (!pin.valid
    || pin.value.claimState !== 'claimed'
    || pin.value.pathKey !== input.pathKey
    || pin.value.worktreeId !== input.worktreeId) {
    return { ok: false, errors: [{ code: 'LEGACY_PIN_INVALID', message: 'legacy migration requires the exact claimed worktree pin' }] }
  }
  const desiredResult = buildDesiredMaterialization({
    snapshot: input.snapshot,
    runtimeAsset: input.runtimeAsset,
    selectedSkills: pin.value.selectedSkills,
    visibilityStateId: input.desiredVisibilityState.visibilityStateId
  })
  if (!desiredResult.ok) {
    return {
      ok: false,
      errors: desiredResult.errors.map((error) => ({
        code: 'LEGACY_SOURCE_INVALID',
        subject: error.subject,
        message: error.message
      }))
    }
  }
  const desired = desiredResult.desired
  if (pin.value.requestedSnapshot !== desired.requested.snapshotId) {
    return { ok: false, errors: [{ code: 'LEGACY_PIN_INVALID', message: 'legacy migration snapshot must match the pin request' }] }
  }
  const factErrors = exactLegacyFacts(
    desired.artifacts,
    input.artifacts,
    input.gitFacts,
    input.gitConfiguration
  )
  if (factErrors.length > 0) return { ok: false, errors: factErrors }
  const reconciliation = markerReconciliation(input)
  if (reconciliation.current === null) {
    if (input.currentVisibilityState !== null) {
      return { ok: false, errors: [{ code: 'LEGACY_FACT_INVALID', message: 'visibility ownership state exists without a valid current marker' }] }
    }
  } else if (input.currentVisibilityState === null
    || input.currentVisibilityState.visibilityStateId !== reconciliation.current.visibilityStateId
    || !visibilityTargetsMatchArtifacts(input.currentVisibilityState, reconciliation.current.artifacts)) {
    return { ok: false, errors: [{ code: 'LEGACY_FACT_INVALID', message: 'current visibility ownership state does not exactly match the marker' }] }
  }
  if (!visibilityTargetsMatchArtifacts(input.desiredVisibilityState, desired.artifacts)
    || input.desiredVisibilityState.baseExclude.valueId !== input.gitConfiguration.baseExcludeValueId
    || input.desiredVisibilityState.baseExclude.contentDigest !== input.gitConfiguration.baseExcludeContentDigest) {
    return { ok: false, errors: [{ code: 'LEGACY_FACT_INVALID', message: 'desired visibility ownership state does not match legacy targets or base projection' }] }
  }
  for (let index = 0; index < desired.artifacts.length; index += 1) {
    const currentTarget = input.currentVisibilityState?.targets[index]
    const desiredTarget = input.desiredVisibilityState.targets[index]
    const fact = input.gitFacts[index]
    if (currentTarget && !sameVisibilityBaseline(currentTarget, desiredTarget)
      || fact.ownershipStateId !== (input.currentVisibilityState?.visibilityStateId ?? null)
      || fact.ownership === (currentTarget ? 'managed' : 'unmanaged')
        && fact.baselineDigest !== visibilityOwnershipTargetBaselineDigest(currentTarget ?? desiredTarget)) {
      return { ok: false, errors: [{ code: 'LEGACY_FACT_INVALID', message: 'legacy Git visibility facts do not bind exact current and desired ownership baselines' }] }
    }
  }
  if (reconciliation.status === 'invalid') {
    return { ok: false, errors: [{ code: 'LEGACY_MARKER_INVALID', message: 'durable and Git-admin materialization proofs disagree' }] }
  }
  if (input.migrationRecord !== null && !verifyLegacyMigrationRecordIdentity(input.migrationRecord)) {
    return { ok: false, errors: [{ code: 'LEGACY_RECORD_INVALID', message: 'legacy migration record failed strict identity verification' }] }
  }
  if (reconciliation.status === 'valid') {
    const current = reconciliation.current as MaterializationMarkerV1
    if (current.materializationId !== desired.requested.materializationId
      || current.visibilityStateId !== desired.requested.visibilityStateId
      || !exactMaterializedCopies(desired.artifacts, input.artifacts)) {
      return { ok: false, errors: [{ code: 'LEGACY_MARKER_INVALID', message: 'current marker does not prove the requested exact copied materialization' }] }
    }
    if (current.origin.kind === 'legacyMigration') {
      if (input.migrationRecord === null
        || !legacyRecordMatchesMarker(input.migrationRecord, current)
        || input.migrationRecord.backupPrivateStateId !== input.backupPrivateStateId) {
        return { ok: false, errors: [{ code: 'LEGACY_RECORD_INVALID', message: 'legacy marker requires its exact committed migration record' }] }
      }
    } else if (input.migrationRecord !== null) {
      return { ok: false, errors: [{ code: 'LEGACY_RECORD_INVALID', message: 'sync-origin marker cannot carry a legacy migration record' }] }
    }
    return {
      ok: true,
      status: 'already-migrated',
      plan: null,
      marker: current,
      record: input.migrationRecord
    }
  }
  if (input.migrationRecord?.status === 'committed') {
    return { ok: false, errors: [{ code: 'LEGACY_RECORD_INVALID', message: 'unmaterialized legacy state cannot retain a committed migration record' }] }
  }

  const operations = desired.artifacts.map((artifact, index) => legacyMigrationOperation(artifact, input.artifacts[index]))
  const summary = {
    replaceWithCopy: operations.filter((operation) => operation.action === 'replaceWithCopy').length,
    create: operations.filter((operation) => operation.action === 'create').length,
    keep: operations.filter((operation) => operation.action === 'keep').length,
    conflict: operations.filter((operation) => operation.action === 'conflict').length
  }
  const git = createMigrationGitPlan(operations, input.gitFacts, input.gitConfiguration)
  const hasLegacyConfiguration = git.configuration.effects
    .includes('removeOwnedCommonInfoExcludeEntries')
  if (summary.replaceWithCopy === 0 && summary.create === 0
    && summary.conflict === 0 && !hasLegacyConfiguration) {
    if (input.migrationRecord !== null) {
      return { ok: false, errors: [{ code: 'LEGACY_RECORD_INVALID', message: 'rolled-back migration record does not identify any prospective legacy work' }] }
    }
    return { ok: true, status: 'not-required', plan: null }
  }
  const gitBeforeDigest = legacyGitFactsDigest(
    desired.artifacts,
    input.gitFacts,
    input.gitConfiguration
  )
  const replacementArtifacts = migratedArtifacts(operations)
  const backupManifestId = legacyBackupManifestId({
    pathKey: input.pathKey,
    worktreeId: input.worktreeId,
    artifacts: replacementArtifacts,
    gitBeforeDigest,
    backupPrivateStateId: input.backupPrivateStateId
  })
  const withoutIdentity: LegacyMigrationPlanV1 = {
    schemaVersion: LEGACY_MIGRATION_PLAN_SCHEMA_VERSION,
    planHash: ZERO_SHA,
    migrationId: ZERO_SHA,
    pathKey: input.pathKey,
    worktreeId: input.worktreeId,
    stateRevision: input.stateRevision,
    requested: desired.requested,
    markerStatus: 'missing',
    backupManifestId,
    backupPrivateStateId: input.backupPrivateStateId,
    gitBeforeDigest,
    operations,
    git,
    summary,
    executable: summary.conflict === 0
      && git.configuration.action !== 'conflict'
      && git.operations.every((operation) => operation.action !== 'conflict')
      && (summary.replaceWithCopy > 0 || summary.create > 0)
  }
  const canonicalPayload = canonicalLegacyMigrationPlanPayload(withoutIdentity)
  const withPlanHash: LegacyMigrationPlanV1 = {
    ...withoutIdentity,
    planHash: domainSeparatedSha256(LEGACY_MIGRATION_PLAN_HASH_DOMAIN, canonicalPayload)
  }
  const plan: LegacyMigrationPlanV1 = {
    ...withPlanHash,
    migrationId: domainSeparatedSha256(
      LEGACY_MIGRATION_ID_HASH_DOMAIN,
      canonicalLegacyMigrationRecordIdentityPayload(migrationIdentityFromPlan(withPlanHash))
    )
  }
  const validation = validateLegacyMigrationPlanV1(plan)
  if (!validation.valid) {
    return { ok: false, errors: [{ code: 'LEGACY_INPUT_INVALID', message: 'legacy migration plan failed frozen contract validation' }] }
  }
  if (input.migrationRecord !== null
    && (input.migrationRecord.status !== 'rolledBack'
      || canonicalLegacyMigrationRecordIdentityPayload(input.migrationRecord)
        !== canonicalLegacyMigrationRecordIdentityPayload(migrationIdentityFromPlan(validation.value)))) {
    return { ok: false, errors: [{ code: 'LEGACY_RECORD_INVALID', message: 'rolled-back migration record does not match the prospective deterministic migration identity' }] }
  }
  return { ok: true, status: 'planned', plan: validation.value, canonicalPayload }
}

export function verifyLegacyMigrationPlanHash(value: unknown): value is LegacyMigrationPlanV1 {
  const validation = validateLegacyMigrationPlanV1(value)
  if (!validation.valid) return false
  const plan = validation.value
  const artifacts: MaterializationArtifactV1[] = plan.operations.map((operation) => ({
    artifactId: operation.artifactId,
    owner: operation.owner,
    targetRelativePath: operation.targetRelativePath,
    kind: operation.kind,
    digest: operation.after.digest
  }))
  if (domainSeparatedSha256(
    MATERIALIZATION_ID_HASH_DOMAIN,
    canonicalMaterializationIdentityPayload({
      snapshotId: plan.requested.snapshotId,
      selectedSkills: plan.requested.selectedSkills,
      runtimeRevision: plan.requested.runtimeRevision,
      runtimeAssetId: plan.requested.runtimeAssetId,
      artifacts
    })
  ) !== plan.requested.materializationId) return false
  if (plan.operations.some((operation) => operation.action === 'replaceWithCopy'
    && operation.legacy?.sourceArtifactId !== materializationSourceArtifactId(operation.after))) return false
  const replacementArtifacts = migratedArtifacts(plan.operations)
  if (legacyBackupManifestId({
    pathKey: plan.pathKey,
    worktreeId: plan.worktreeId,
    artifacts: replacementArtifacts,
    gitBeforeDigest: plan.gitBeforeDigest,
    backupPrivateStateId: plan.backupPrivateStateId
  })
    !== plan.backupManifestId) return false
  if (legacyGitPlanDigest(plan.git) !== plan.git.digest) return false
  if (domainSeparatedSha256(LEGACY_MIGRATION_PLAN_HASH_DOMAIN, canonicalLegacyMigrationPlanPayload(plan))
    !== plan.planHash) return false
  return domainSeparatedSha256(
    LEGACY_MIGRATION_ID_HASH_DOMAIN,
    canonicalLegacyMigrationRecordIdentityPayload(migrationIdentityFromPlan(plan))
  ) === plan.migrationId
}

function createRollbackGitPlan(
  operations: readonly LegacyRollbackPlanV1['operations'][number][],
  facts: readonly GitVisibilityFact[],
  restoreFacts: readonly GitVisibilityFact[],
  configurationFact: GitMaterializationConfigurationFact,
  restoreConfigurationFact: GitMaterializationConfigurationFact
): LegacyGitVisibilityPlanV1 {
  const planned: LegacyGitVisibilityOperationV1[] = operations.map((operation, index) => {
    const before = gitState(facts[index])
    if (operation.action === 'conflict') {
      return { artifactId: operation.artifactId, targetRelativePath: operation.targetRelativePath, action: 'conflict', before, after: before }
    }
    const after = gitState(restoreFacts[index])
    if (sameLegacyGitState(before, after)) {
      return {
        artifactId: operation.artifactId,
        targetRelativePath: operation.targetRelativePath,
        action: 'keep',
        before,
        after
      }
    }
    if (before.trackedCount !== after.trackedCount
      || before.trackedPathsDigest !== after.trackedPathsDigest
      || before.factDigest !== restoreFacts[index].desiredDigest) {
      return { artifactId: operation.artifactId, targetRelativePath: operation.targetRelativePath, action: 'conflict', before, after: before }
    }
    return {
      artifactId: operation.artifactId,
      targetRelativePath: operation.targetRelativePath,
      action: 'restore',
      before,
      after
    }
  })
  let configuration: GitMaterializationConfigurationPlanV1
  if (configurationFact.currentDigest === restoreConfigurationFact.currentDigest) {
    configuration = {
      action: 'keep',
      beforeDigest: configurationFact.currentDigest,
      afterDigest: configurationFact.currentDigest,
      effects: [],
      conflictKind: null,
      siblingFactsDigest: configurationFact.siblingFactsDigest
    }
  } else {
    const conflictKind = !configurationFact.supportsWorktreeConfig
      || !configurationFact.worktreeConfigEnabled
      ? 'unsupportedWorktreeConfig' as const
      : !restoreConfigurationFact.commonInfoExcludeClean
        && configurationFact.legacyCommonSiblingSafety === 'unsafe'
        ? 'siblingVisibilityRisk' as const
        : configurationFact.currentDigest !== restoreConfigurationFact.desiredDigest
          ? 'configurationDrift' as const
          : null
    configuration = conflictKind === null
      ? {
          action: 'restore',
          beforeDigest: configurationFact.currentDigest,
          afterDigest: restoreConfigurationFact.currentDigest,
          effects: ['restoreBackup'],
          conflictKind: null,
          siblingFactsDigest: configurationFact.siblingFactsDigest
        }
      : {
          action: 'conflict',
          beforeDigest: configurationFact.currentDigest,
          afterDigest: configurationFact.currentDigest,
          effects: [],
          conflictKind,
          siblingFactsDigest: configurationFact.siblingFactsDigest
        }
  }
  const withoutDigest = { operations: planned, configuration }
  return { digest: legacyGitPlanDigest(withoutDigest), ...withoutDigest }
}

function legacyRollbackOperation(
  artifact: DesiredMaterializationArtifact,
  fact: LegacyArtifactFactV1,
  recordArtifact: LegacyMigrationArtifactV1 | undefined,
  createdArtifact: MaterializationArtifactV1 | undefined,
  restoreSource: LegacyRestoreSourceFactV1 | undefined
): LegacyRollbackPlanV1['operations'][number] {
  const before = legacyBefore(fact)
  const restore = recordArtifact
    ? {
        legacyKind: recordArtifact.legacyKind,
        sourceArtifactId: recordArtifact.sourceArtifactId,
        digest: recordArtifact.beforeDigest,
        sourceStateId: restoreSource?.sourceStateId ?? ZERO_SHA
      }
    : null
  const base = {
    artifactId: artifact.artifactId,
    owner: artifact.owner,
    targetRelativePath: artifact.targetRelativePath,
    kind: artifact.kind,
    before,
    restore
  } as const
  let conflict: MaterializeConflictKind | null = null
  if (fact.pathEscaped) conflict = 'path-escape'
  else if (fact.protected) conflict = 'protected-target'
  else if (recordArtifact && (!restoreSource
    || restoreSource.artifactId !== recordArtifact.artifactId
    || restoreSource.targetRelativePath !== recordArtifact.targetRelativePath
    || restoreSource.legacyKind !== recordArtifact.legacyKind
    || restoreSource.sourceArtifactId !== recordArtifact.sourceArtifactId
    || restoreSource.status !== 'valid')) {
    conflict = restoreSource?.status === 'missing' || restoreSource?.status === 'changed'
      ? 'dirty' : 'external-link'
  }
  else if (fact.observedKind === artifact.kind && fact.legacyKind === null) {
    if (fact.digest === artifact.digest) {
      if (recordArtifact) return { ...base, action: 'restoreLink' }
      if (createdArtifact?.digest === artifact.digest) return { ...base, action: 'deleteCreated' }
      conflict = 'unowned-content'
    } else conflict = 'dirty'
  } else if (fact.observedKind === 'junction'
    || fact.observedKind === 'hardlink'
    || fact.observedKind === 'symlink') {
    conflict = fact.legacyKind ? 'legacy-link' : 'external-link'
  } else if (fact.observedKind === 'missing') conflict = 'dirty'
  else conflict = 'kind-mismatch'
  return {
    ...base,
    action: 'conflict',
    conflict: safeConflict(conflict, artifact.targetRelativePath, fact.digest ?? undefined, artifact.digest)
  }
}

function recordArtifactsMatchDesired(
  record: LegacyMigrationRecordV1,
  artifacts: readonly DesiredMaterializationArtifact[]
): boolean {
  const desiredByPath = new Map(artifacts.map((artifact) => [artifact.targetRelativePath, artifact]))
  if (record.artifacts.length + record.createdArtifacts.length !== artifacts.length) return false
  const migrated = record.artifacts.every((entry) => {
    const desired = desiredByPath.get(entry.targetRelativePath)
    if (!desired) return false
    const after: MaterializeAfterV1 = { digest: desired.digest, source: desired.source }
    return entry.artifactId === desired.artifactId
      && entry.owner === desired.owner
      && entry.kind === desired.kind
      && entry.afterDigest === desired.digest
      && entry.beforeDigest === desired.digest
      && entry.legacyKind === (desired.kind === 'file' ? 'fileHardlink' : 'directoryLink')
      && entry.sourceArtifactId === materializationSourceArtifactId(after)
  })
  const created = record.createdArtifacts.every((entry) => {
    const desired = desiredByPath.get(entry.targetRelativePath)
    return desired !== undefined
      && entry.artifactId === desired.artifactId
      && entry.owner === desired.owner
      && entry.kind === desired.kind
      && entry.digest === desired.digest
  })
  const paths = new Set([
    ...record.artifacts.map((entry) => entry.targetRelativePath),
    ...record.createdArtifacts.map((entry) => entry.targetRelativePath)
  ])
  return migrated && created && paths.size === artifacts.length
}

function restoreSourcesMatchRecord(
  record: LegacyMigrationRecordV1,
  facts: readonly LegacyRestoreSourceFactV1[]
): boolean {
  return Array.isArray(facts)
    && facts.length === record.artifacts.length
    && facts.every((fact, index) => {
      const artifact = record.artifacts[index]
      return checkedLegacyRestoreSourceFact(fact)
        && fact.artifactId === artifact.artifactId
        && fact.targetRelativePath === artifact.targetRelativePath
        && fact.legacyKind === artifact.legacyKind
        && fact.sourceArtifactId === artifact.sourceArtifactId
    })
}

function exactRolledBackState(
  artifacts: readonly DesiredMaterializationArtifact[],
  facts: readonly LegacyArtifactFactV1[],
  gitFacts: readonly GitVisibilityFact[],
  restoreGitFacts: readonly GitVisibilityFact[],
  gitConfiguration: GitMaterializationConfigurationFact,
  restoreGitConfiguration: GitMaterializationConfigurationFact,
  record: LegacyMigrationRecordV1
): boolean {
  const recordByPath = new Map(record.artifacts.map((artifact) => [artifact.targetRelativePath, artifact]))
  const createdByPath = new Map(record.createdArtifacts.map((artifact) => [artifact.targetRelativePath, artifact]))
  return artifacts.every((artifact, index) => {
    const fact = facts[index]
    const migrated = recordByPath.get(artifact.targetRelativePath)
    const created = createdByPath.get(artifact.targetRelativePath)
    const contentMatches = migrated
      ? fact.observedKind === (artifact.kind === 'file' ? 'hardlink' : 'junction')
        && fact.legacyKind === migrated.legacyKind
        && fact.sourceArtifactId === migrated.sourceArtifactId
        && fact.digest === artifact.digest
      : created
        ? fact.observedKind === 'missing'
          && fact.legacyKind === null
          && fact.sourceArtifactId === null
        : false
    return contentMatches
      && !fact.pathEscaped
      && !fact.protected
      && sameLegacyGitState(gitState(gitFacts[index]), gitState(restoreGitFacts[index]))
  }) && gitConfiguration.currentDigest === restoreGitConfiguration.currentDigest
}

export function canonicalLegacyRollbackPlanPayload(plan: LegacyRollbackPlanV1): string {
  const { planHash: _planHash, ...payload } = plan
  return canonicalJson(payload as unknown as CanonicalJsonValue)
}

export function planLegacyRollback(input: LegacyRollbackPlanningInput): LegacyRollbackPlanningResult {
  if (!legacyInputIdentityValid(input, true)
    || !Array.isArray(input.restoreSources)
    || !Array.isArray(input.restoreGitFacts)) {
    return { ok: false, errors: [{ code: 'LEGACY_INPUT_INVALID', message: 'legacy rollback identity and flat facts are invalid' }] }
  }
  const pin = validateWorktreePinV1(input.pin)
  if (!pin.valid
    || pin.value.claimState !== 'claimed'
    || pin.value.pathKey !== input.pathKey
    || pin.value.worktreeId !== input.worktreeId) {
    return { ok: false, errors: [{ code: 'LEGACY_PIN_INVALID', message: 'legacy rollback requires the exact claimed worktree pin' }] }
  }
  if (!verifyLegacyMigrationRecordIdentity(input.migrationRecord)
    || input.migrationRecord.pathKey !== input.pathKey
    || input.migrationRecord.worktreeId !== input.worktreeId
    || input.migrationRecord.backupPrivateStateId !== input.backupPrivateStateId) {
    return { ok: false, errors: [{ code: 'LEGACY_RECORD_INVALID', message: 'rollback requires the exact verified migration record' }] }
  }
  if (!restoreSourcesMatchRecord(input.migrationRecord, input.restoreSources)) {
    return { ok: false, errors: [{ code: 'LEGACY_FACT_INVALID', message: 'legacy restore source facts must exactly cover the backed-up link artifacts' }] }
  }
  const desiredResult = buildDesiredMaterialization({
    snapshot: input.snapshot,
    runtimeAsset: input.runtimeAsset,
    selectedSkills: pin.value.selectedSkills,
    visibilityStateId: input.currentVisibilityState?.visibilityStateId
      ?? input.desiredVisibilityState.visibilityStateId
  })
  if (!desiredResult.ok) {
    return {
      ok: false,
      errors: desiredResult.errors.map((error) => ({
        code: 'LEGACY_SOURCE_INVALID',
        subject: error.subject,
        message: error.message
      }))
    }
  }
  const desired = desiredResult.desired
  if (pin.value.requestedSnapshot !== desired.requested.snapshotId
    || input.migrationRecord.snapshotId !== desired.requested.snapshotId
    || input.migrationRecord.materializationId !== desired.requested.materializationId
    || !recordArtifactsMatchDesired(input.migrationRecord, desired.artifacts)) {
    return { ok: false, errors: [{ code: 'LEGACY_RECORD_INVALID', message: 'migration record, pin, and requested source inventories do not close over one materialization' }] }
  }
  const factErrors = exactLegacyFacts(
    desired.artifacts,
    input.artifacts,
    input.gitFacts,
    input.gitConfiguration,
    input.restoreGitFacts,
    input.restoreGitConfiguration
  )
  if (factErrors.length > 0) return { ok: false, errors: factErrors }
  if (legacyGitFactsDigest(
    desired.artifacts,
    input.restoreGitFacts,
    input.restoreGitConfiguration
  )
    !== input.migrationRecord.gitVisibilityDigest) {
    return { ok: false, errors: [{ code: 'LEGACY_RECORD_INVALID', message: 'backed-up Git visibility facts do not match the migration record' }] }
  }
  const reconciliation = markerReconciliation(input)
  if (input.migrationRecord.status === 'rolledBack') {
    if (reconciliation.status !== 'missing'
      || input.currentVisibilityState !== null
      || input.desiredVisibilityState.targets.length !== 0
      || input.desiredVisibilityState.baseExclude.valueId
        !== input.restoreGitConfiguration.baseExcludeValueId
      || input.desiredVisibilityState.baseExclude.contentDigest
        !== input.restoreGitConfiguration.baseExcludeContentDigest
      || pin.value.materializedSnapshot !== null
      || !exactRolledBackState(
        desired.artifacts,
        input.artifacts,
        input.gitFacts,
        input.restoreGitFacts,
        input.gitConfiguration,
        input.restoreGitConfiguration,
        input.migrationRecord
      )) {
      return { ok: false, errors: [{ code: 'LEGACY_MARKER_INVALID', message: 'rolled-back record does not match marker, pin, copied content, link, or Git facts' }] }
    }
    return { ok: true, status: 'already-rolled-back', plan: null, record: input.migrationRecord }
  }
  if (reconciliation.status !== 'valid') {
    return { ok: false, errors: [{ code: 'LEGACY_MARKER_INVALID', message: 'committed migration requires matching durable and Git-admin markers' }] }
  }
  const current = reconciliation.current as MaterializationMarkerV1
  if (input.currentVisibilityState === null
    || input.currentVisibilityState.visibilityStateId !== current.visibilityStateId
    || !visibilityTargetsMatchArtifacts(input.currentVisibilityState, current.artifacts)
    || input.desiredVisibilityState.targets.length !== 0
    || input.desiredVisibilityState.baseExclude.valueId
      !== input.restoreGitConfiguration.baseExcludeValueId
    || input.desiredVisibilityState.baseExclude.contentDigest
      !== input.restoreGitConfiguration.baseExcludeContentDigest) {
    return { ok: false, errors: [{ code: 'LEGACY_FACT_INVALID', message: 'rollback visibility ownership states do not match the marker or exact restore projection' }] }
  }
  for (let index = 0; index < current.artifacts.length; index += 1) {
    const baseline = input.currentVisibilityState.targets[index]
    const fact = input.gitFacts[index]
    if (fact.ownership !== 'managed'
      || fact.ownershipStateId !== input.currentVisibilityState.visibilityStateId
      || fact.baselineDigest !== visibilityOwnershipTargetBaselineDigest(baseline)) {
      return { ok: false, errors: [{ code: 'LEGACY_FACT_INVALID', message: 'rollback current Git facts do not bind the committed visibility ownership state' }] }
    }
  }
  if (!legacyRecordMatchesMarker(input.migrationRecord, current)
    || current.materializationId !== desired.requested.materializationId) {
    return { ok: false, errors: [{ code: 'LEGACY_RECORD_INVALID', message: 'current marker does not match the committed migration record' }] }
  }
  const recordByPath = new Map(input.migrationRecord.artifacts.map((artifact) => [artifact.targetRelativePath, artifact]))
  const createdByPath = new Map(input.migrationRecord.createdArtifacts.map((artifact) => [artifact.targetRelativePath, artifact]))
  const restoreSourceByPath = new Map(input.restoreSources.map((fact) => [fact.targetRelativePath, fact]))
  const operations = desired.artifacts.map((artifact, index) => legacyRollbackOperation(
    artifact,
    input.artifacts[index],
    recordByPath.get(artifact.targetRelativePath),
    createdByPath.get(artifact.targetRelativePath),
    restoreSourceByPath.get(artifact.targetRelativePath)
  ))
  const git = createRollbackGitPlan(
    operations,
    input.gitFacts,
    input.restoreGitFacts,
    input.gitConfiguration,
    input.restoreGitConfiguration
  )
  const summary = {
    restoreLink: operations.filter((operation) => operation.action === 'restoreLink').length,
    deleteCreated: operations.filter((operation) => operation.action === 'deleteCreated').length,
    keep: operations.filter((operation) => operation.action === 'keep').length,
    conflict: operations.filter((operation) => operation.action === 'conflict').length
  }
  const withoutHash: LegacyRollbackPlanV1 = {
    schemaVersion: LEGACY_ROLLBACK_PLAN_SCHEMA_VERSION,
    planHash: ZERO_SHA,
    migrationId: input.migrationRecord.migrationId,
    pathKey: input.pathKey,
    worktreeId: input.worktreeId,
    stateRevision: input.stateRevision,
    current,
    backupManifestId: input.migrationRecord.backupManifestId,
    backupPrivateStateId: input.migrationRecord.backupPrivateStateId,
    restoreVisibilityStateId: input.desiredVisibilityState.visibilityStateId,
    operations,
    git,
    summary,
    executable: summary.conflict === 0
      && git.operations.every((operation) => operation.action !== 'conflict')
      && git.configuration.action !== 'conflict'
      && (summary.restoreLink > 0
        || summary.deleteCreated > 0
        || git.operations.some((operation) => operation.action === 'restore')
        || git.configuration.action === 'restore')
  }
  const canonicalPayload = canonicalLegacyRollbackPlanPayload(withoutHash)
  const plan: LegacyRollbackPlanV1 = {
    ...withoutHash,
    planHash: domainSeparatedSha256(LEGACY_ROLLBACK_PLAN_HASH_DOMAIN, canonicalPayload)
  }
  const validation = validateLegacyRollbackPlanV1(plan)
  if (!validation.valid) {
    return { ok: false, errors: [{ code: 'LEGACY_INPUT_INVALID', message: 'legacy rollback plan failed frozen contract validation' }] }
  }
  return { ok: true, status: 'planned', plan: validation.value, canonicalPayload }
}

export function verifyLegacyRollbackPlanHash(value: unknown): value is LegacyRollbackPlanV1 {
  const validation = validateLegacyRollbackPlanV1(value)
  return validation.valid
    && verifyMaterializationMarker(validation.value.current)
    && legacyGitPlanDigest(validation.value.git) === validation.value.git.digest
    && domainSeparatedSha256(
      LEGACY_ROLLBACK_PLAN_HASH_DOMAIN,
      canonicalLegacyRollbackPlanPayload(validation.value)
    ) === validation.value.planHash
}

export function canonicalLegacyMigrationRecordIdentityPayload(record: {
  planHash: Sha256Identifier
  pathKey: Sha256Identifier
  worktreeId: string
  snapshotId: Sha256Identifier
  materializationId: Sha256Identifier
  visibilityStateId: Sha256Identifier
  backupManifestId: Sha256Identifier
  backupPrivateStateId: Sha256Identifier
  artifacts: readonly {
    artifactId: string
    owner: MaterializationArtifactOwner
    targetRelativePath: string
    kind: 'file' | 'directory'
    legacyKind: 'directoryLink' | 'fileHardlink'
    sourceArtifactId: Sha256Identifier
    beforeDigest: Sha256Identifier
    afterDigest: Sha256Identifier
  }[]
  createdArtifacts: readonly MaterializationArtifactV1[]
  gitVisibilityDigest: Sha256Identifier
}): string {
  return canonicalJson({
    planHash: record.planHash,
    pathKey: record.pathKey,
    worktreeId: record.worktreeId,
    snapshotId: record.snapshotId,
    materializationId: record.materializationId,
    visibilityStateId: record.visibilityStateId,
    backupManifestId: record.backupManifestId,
    backupPrivateStateId: record.backupPrivateStateId,
    artifacts: record.artifacts,
    createdArtifacts: record.createdArtifacts,
    gitVisibilityDigest: record.gitVisibilityDigest
  } as unknown as CanonicalJsonValue)
}

export function verifyLegacyMigrationRecordIdentity(value: unknown): value is LegacyMigrationRecordV1 {
  const validation = validateLegacyMigrationRecordV1(value)
  if (!validation.valid) return false
  return domainSeparatedSha256(
    LEGACY_MIGRATION_ID_HASH_DOMAIN,
    canonicalLegacyMigrationRecordIdentityPayload(validation.value)
  ) === validation.value.migrationId
}
