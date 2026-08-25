import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import type {
  LegacyMigrationInspection,
  LegacyRollbackInspection,
  MaterializeInspection,
  MaterializePort,
  MaterializationRecoveryReport
} from '../application/materialize-port.js'
import type {
  RuntimeAssetRepositoryPort,
  SnapshotContentPort,
  WorktreeIdentity,
  WorktreeIdentityPort
} from '../application/ports.js'
import {
  ApplicationTransactionErrorBase,
  isApplicationTransactionError,
  type ApplicationTransactionParticipant
} from '../application/transaction-port.js'
import {
  isPortableRelativePath,
  type LegacyArtifactFactV1,
  type LegacyLinkKind,
  type LegacyMigrationPlanV1,
  type LegacyMigrationRecordV1,
  type LegacyRestoreSourceFactV1,
  type LegacyRollbackPlanV1,
  type LibrarySnapshotFileV1,
  type MaterializationArtifactV1,
  type MaterializationCommitRecordV1,
  type MaterializationMarkerV1,
  type MaterializeOperationV1,
  type MaterializePlanV1,
  type RuntimeAssetFileV1,
  type Sha256Identifier,
  type VisibilityBaseExcludeScope,
  type VisibilityOwnershipStateV1,
  type VisibilityOwnershipTargetV1,
  type WorktreePinV1
} from '../contracts/index.js'
import {
  LEGACY_BACKUP_MANIFEST_HASH_DOMAIN,
  LEGACY_GIT_FACTS_HASH_DOMAIN,
  MATERIALIZATION_ARTIFACT_HASH_DOMAIN,
  buildDesiredMaterialization,
  canonicalLegacyBackupManifestPayload,
  canonicalLegacyGitFactsPayload,
  canonicalJson,
  compareUtf8Bytes,
  domainSeparatedSha256,
  createGitMaterializationConfigurationFact,
  createGitMaterializationSiblingProof,
  createGitVisibilityFact,
  createVisibilityOwnershipState,
  gitMaterializationConfigurationValueId,
  materializationSourceArtifactId,
  visibilityOwnershipTargetBaselineDigest,
  verifyLegacyMigrationPlanHash,
  verifyLegacyMigrationRecordIdentity,
  verifyLegacyRollbackPlanHash,
  verifyLibrarySnapshotManifest,
  verifyMaterializationMarker,
  verifyMaterializePlanHash,
  verifyRuntimeAssetManifest,
  verifyVisibilityOwnershipState,
  type CanonicalJsonValue,
  type DesiredMaterialization,
  type DesiredMaterializationArtifact,
  type GitMaterializationConfigurationFact,
  type GitVisibilityFact,
  type MaterializationObservedArtifactFact
} from '../core/index.js'
import { flushDirectory, sha256Identifier } from './durable-files.js'

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{15,127}$/
const MARKER_NAME = 'materialized-v1.json'
const PRIVATE_EXCLUDES_BEGIN = '# skill-graft managed excludes v1 begin'
const PRIVATE_EXCLUDES_END = '# skill-graft managed excludes v1 end'
const ZERO_SHA = `sha256:${'0'.repeat(64)}` as Sha256Identifier
const ORDINARY_SIBLING_FACTS_DIGEST = domainSeparatedSha256(
  'skill-graft/local-materializer-ordinary-sibling-facts-not-applicable/v1',
  canonicalJson([])
)
const ORDINARY_RESOURCE_KINDS = [
  'privateExclude',
  'worktreeConfig',
  'gitIndex',
  'visibilityPrivate',
  'visibilityState',
  'marker'
] as const
type OrdinaryResourceKind = (typeof ORDINARY_RESOURCE_KINDS)[number]
const ORDINARY_GIT_VISIBILITY_RESOURCE_KINDS = [
  'privateExclude', 'worktreeConfig', 'gitIndex'
] as const satisfies readonly OrdinaryResourceKind[]
const ORDINARY_VISIBILITY_SIDECAR_RESOURCE_KINDS = [
  'visibilityPrivate', 'visibilityState'
] as const satisfies readonly OrdinaryResourceKind[]
const ORDINARY_RESOURCE_NAMES: Readonly<Record<OrdinaryResourceKind, string>> = {
  gitIndex: 'git-index',
  worktreeConfig: 'worktree-config',
  privateExclude: 'private-exclude',
  visibilityPrivate: 'visibility-private',
  visibilityState: 'visibility-state',
  marker: 'marker'
}
const LEGACY_RESOURCE_KINDS = [
  'privateExclude',
  'worktreeConfig',
  'gitIndex',
  'commonInfoExclude',
  'commonConfig',
  'visibilityPrivate',
  'visibilityState',
  'marker'
] as const
type LegacyResourceKind = (typeof LEGACY_RESOURCE_KINDS)[number]
const LEGACY_RESOURCE_NAMES: Readonly<Record<LegacyResourceKind, string>> = {
  privateExclude: 'private-exclude',
  worktreeConfig: 'worktree-config',
  gitIndex: 'git-index',
  commonInfoExclude: 'common-info-exclude',
  commonConfig: 'common-config',
  visibilityPrivate: 'visibility-private',
  visibilityState: 'visibility-state',
  marker: 'marker'
}

export type LocalMaterializerLimits = {
  maxArtifacts: number
  maxFiles: number
  maxFileBytes: number
  maxTotalBytes: number
  maxMarkerBytes: number
  maxJournalBytes: number
  maxRecoveryTransactions: number
  maxGitIndexBytes: number
  maxGitConfigBytes: number
  maxSiblingWorktrees: number
  maxSiblingFacts: number
}

const DEFAULT_LIMITS: LocalMaterializerLimits = {
  maxArtifacts: 512,
  maxFiles: 16_384,
  maxFileBytes: 32 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxMarkerBytes: 4 * 1024 * 1024,
  maxJournalBytes: 8 * 1024 * 1024,
  maxRecoveryTransactions: 128,
  maxGitIndexBytes: 128 * 1024 * 1024,
  maxGitConfigBytes: 8 * 1024 * 1024,
  maxSiblingWorktrees: 64,
  maxSiblingFacts: 32_768
}

export type LocalMaterializerOptions = {
  /** Installed distribution root containing overlay/ and dist/. */
  packageRoot: string
  /** Mutable Hub data/watch root consumed by installed hooks. */
  dataRoot: string
  identities: WorktreeIdentityPort
  snapshots: SnapshotContentPort
  runtimeAssets: RuntimeAssetRepositoryPort
  /** Existing live-link library root, used only to classify explicit legacy migration conflicts. */
  legacySourceRoot?: string
  token?: () => string
  checkpoint?: (step: string, facts: Readonly<Record<string, string | number | boolean>>) => void
  limits?: Partial<LocalMaterializerLimits>
}

export class LocalMaterializerError extends ApplicationTransactionErrorBase {
  readonly code = 'PORT_FAILURE' as const
  readonly retryable = false

  constructor(message: string) {
    super(message)
    this.name = 'LocalMaterializerError'
  }
}

export class LocalMaterializerLayoutError extends ApplicationTransactionErrorBase {
  readonly code = 'UNSUPPORTED_LAYOUT' as const
  readonly retryable = false

  constructor(message: string) {
    super(message)
    this.name = 'LocalMaterializerLayoutError'
  }
}

export class LocalMaterializerStateError extends ApplicationTransactionErrorBase {
  readonly code = 'STATE_CORRUPT' as const
  readonly retryable = false

  constructor(message: string) {
    super(message)
    this.name = 'LocalMaterializerStateError'
  }
}

export class LocalMaterializerBusyError extends ApplicationTransactionErrorBase {
  readonly code = 'LOCK_BUSY' as const
  readonly retryable = true

  constructor(message = 'Git resource is busy') {
    super(message, { resource: 'git' })
    this.name = 'LocalMaterializerBusyError'
  }
}

export class LocalLegacyPlanStaleError extends ApplicationTransactionErrorBase {
  readonly code = 'LEGACY_PLAN_STALE' as const
  readonly retryable = false

  constructor(message = 'legacy materialization plan no longer matches current state') {
    super(message)
    this.name = 'LocalLegacyPlanStaleError'
  }
}

type ArtifactJournal = {
  artifactId: string
  targetRelativePath: string
  kind: 'file' | 'directory'
  action: 'create' | 'update' | 'delete'
  before: Sha256Identifier | null
  after: Sha256Identifier | null
  stageName: string | null
  backupName: string
}

type ResourceJournalBase = {
  kind: OrdinaryResourceKind
  target: string
}

type PublishResourceJournal = ResourceJournalBase & {
  disposition: 'publish'
  before: Sha256Identifier | null
  after: Sha256Identifier
  stageName: string
  backupName: string
}

type KeepResourceJournal = ResourceJournalBase & {
  disposition: 'keep'
  before: Sha256Identifier | null
  after: Sha256Identifier | null
  stageName: null
  backupName: null
}

type ResourceJournal = PublishResourceJournal | KeepResourceJournal

type LocalMaterializationJournalV1 = {
  schemaVersion: 1
  token: string
  pathKey: Sha256Identifier
  worktreeId: string
  planHash: Sha256Identifier
  oldMarker: MaterializationMarkerV1 | null
  newMarker: MaterializationMarkerV1
  siblingConfigDigest: Sha256Identifier
  createdParents: readonly string[]
  createdResourceParents: readonly ('visibility' | 'visibility-private')[]
  artifacts: readonly ArtifactJournal[]
  resources: readonly ResourceJournal[]
}

type RevalidateLease = () => Promise<void>
type MaterializerCheckpoint = NonNullable<LocalMaterializerOptions['checkpoint']>

type LocalLayout = {
  worktree: string
  gitAdminRoot: string
  graftRoot: string
  marker: string
  transactions: string
  legacyTransactions: string
  legacyBackups: string
  visibility: string
  visibilityPrivate: string
}

type VisibilityPrivateEnvelopeV1 = {
  schemaVersion: 1
  visibilityStateId: Sha256Identifier
  privateStateId: Sha256Identifier
  pathKey: Sha256Identifier
  worktreeId: string
  baseExclude: {
    scope: VisibilityBaseExcludeScope
    valueId: Sha256Identifier | null
    contentDigest: Sha256Identifier
    locator: string
    exists: boolean
  }
}

type VisibilityPrivatePayloadV1 = Omit<
  VisibilityPrivateEnvelopeV1,
  'visibilityStateId' | 'privateStateId'
>

type BaseExcludeSnapshot = VisibilityPrivateEnvelopeV1['baseExclude'] & {
  bytes: Buffer
  safe: boolean
}

type VisibilityInspection = {
  currentVisibilityState: VisibilityOwnershipStateV1 | null
  desiredVisibilityState: VisibilityOwnershipStateV1
  /** Adapter-private prepare fence. Never crosses Application/Core. */
  privateBaseExclude: BaseExcludeSnapshot
}

type LegacyPrivateResourceSnapshotV1 = {
  locator: string
  exists: boolean
  size: number
  contentDigest: Sha256Identifier
}

type LegacyPrivateArtifactSnapshotV1 = {
  artifactId: string
  targetRelativePath: string
  legacyKind: LegacyLinkKind | null
  sourceArtifactId: Sha256Identifier | null
  rawLinkTarget: string | null
  targetDevice: string | null
  targetInode: string | null
  sourceLocator: string | null
  sourceDevice: string | null
  sourceInode: string | null
  contentDigest: Sha256Identifier | null
  sourceStateId: Sha256Identifier
}

type LegacyBackupPrivatePayloadV1 = {
  schemaVersion: 1
  pathKey: Sha256Identifier
  worktreeId: string
  createdParents: readonly string[]
  createdResourceParents: readonly ('visibility' | 'visibility-private')[]
  artifacts: readonly LegacyPrivateArtifactSnapshotV1[]
  gitFacts: readonly GitVisibilityFact[]
  gitConfiguration: GitMaterializationConfigurationFact
  resources: {
    gitIndex: LegacyPrivateResourceSnapshotV1
    commonConfig: LegacyPrivateResourceSnapshotV1
    worktreeConfig: LegacyPrivateResourceSnapshotV1
    privateExclude: LegacyPrivateResourceSnapshotV1
    commonInfoExclude: LegacyPrivateResourceSnapshotV1
    baseExclude: LegacyPrivateResourceSnapshotV1 & {
      scope: VisibilityBaseExcludeScope
      valueId: Sha256Identifier | null
    }
  }
}

type LegacyInspectionPrivate = {
  inspection: LegacyMigrationInspection
  desired: DesiredMaterialization
  privatePayload: LegacyBackupPrivatePayloadV1
  baseExclude: BaseExcludeSnapshot
}

type LegacyPhysicalStateV2 =
  | { kind: 'missing' }
  | { kind: 'copy'; digest: Sha256Identifier }
  | {
      kind: 'legacyLink'
      legacyKind: LegacyLinkKind
      sourceArtifactId: Sha256Identifier
      sourceStateId: Sha256Identifier
    }

type LegacyArtifactJournalV2 = {
  artifactId: string
  owner: MaterializationArtifactV1['owner']
  targetRelativePath: string
  artifactKind: 'file' | 'directory'
  action: 'replaceWithCopy' | 'create' | 'restoreLink' | 'deleteCreated'
  before: LegacyPhysicalStateV2
  after: LegacyPhysicalStateV2
  stageName: string | null
  backupName: string | null
  discardName: string
}

type LegacyResourceJournalV2 = {
  kind: LegacyResourceKind
  target: string
  before: Sha256Identifier | null
  after: Sha256Identifier | null
  stageName: string | null
  backupName: string
}

type LegacyBackupEnvelopeV1 = {
  schemaVersion: 1
  prepareToken: string
  planHash: Sha256Identifier
  migrationId: Sha256Identifier
  backupManifestId: Sha256Identifier
  backupPrivateStateId: Sha256Identifier
  privatePayload: LegacyBackupPrivatePayloadV1
  resourceFiles: Readonly<Record<keyof LegacyBackupPrivatePayloadV1['resources'], string | null>>
}

type LocalLegacyMaterializationJournalV2 = {
  schemaVersion: 2
  operationKind: 'legacyMigration' | 'legacyRollback'
  token: string
  pathKey: Sha256Identifier
  worktreeId: string
  planHash: Sha256Identifier
  plan: LegacyMigrationPlanV1 | LegacyRollbackPlanV1
  migrationId: Sha256Identifier
  backupManifestId: Sha256Identifier
  backupPrivateStateId: Sha256Identifier
  backupRoot: string
  dropBackupOnAbort: boolean
  oldMarker: MaterializationMarkerV1 | null
  newMarker: MaterializationMarkerV1 | null
  siblingFactsDigest: Sha256Identifier
  commonInfoEffect: boolean
  createdParents: readonly string[]
  createdResourceParents: readonly ('visibility' | 'visibility-private')[]
  artifacts: readonly LegacyArtifactJournalV2[]
  resources: readonly LegacyResourceJournalV2[]
  record: LegacyMigrationRecordV1
}

type LegacyPrepareClaimV1 = {
  schemaVersion: 1
  operationKind: 'legacyMigration' | 'legacyRollback'
  token: string
  pathKey: Sha256Identifier
  worktreeId: string
  planHash: Sha256Identifier
  plan: LegacyMigrationPlanV1 | LegacyRollbackPlanV1
  migrationId: Sha256Identifier
  backupManifestId: Sha256Identifier
  backupPrivateStateId: Sha256Identifier
  dropBackupOnAbort: boolean
}

type PathDigest = {
  kind: 'missing' | 'file' | 'directory' | 'symlink' | 'junction' | 'hardlink' | 'other'
  digest?: Sha256Identifier
  isReparsePoint: boolean
  unsafeDescendant: boolean
}

function comparable(input: string): string {
  const resolved = path.resolve(input)
  const root = path.parse(resolved).root
  const trimmed = resolved === root ? root : resolved.replace(/[\\/]+$/, '')
  return process.platform === 'win32' || process.platform === 'darwin'
    ? trimmed.normalize('NFC').toLowerCase()
    : trimmed
}

function samePath(left: string, right: string): boolean {
  return comparable(left) === comparable(right)
}

function sameOrInside(root: string, target: string): boolean {
  const relation = path.relative(comparable(root), comparable(target))
  return relation === '' || (relation !== '..' && !relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation))
}

function runGit(worktree: string, args: readonly string[], options: {
  env?: NodeJS.ProcessEnv
  input?: Buffer
  allowOne?: boolean
} = {}): string {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => (
    !name.toUpperCase().startsWith('GIT_')
  ))) as NodeJS.ProcessEnv
  for (const [name, value] of Object.entries(options.env ?? {})) {
    if (value !== undefined) environment[name] = value
  }
  const result = spawnSync('git', ['-C', worktree, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 128 * 1024 * 1024,
    env: environment,
    input: options.input
  })
  if (result.status !== 0 && !(options.allowOne && result.status === 1)) {
    throw new LocalMaterializerError('Git materialization preflight failed')
  }
  return String(result.stdout || '')
}

function lstat(target: string): fs.Stats | null {
  try { return fs.lstatSync(target) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new LocalMaterializerError('materialization path cannot be inspected safely')
  }
}

async function guardedRename(source: string, target: string, revalidate?: RevalidateLease): Promise<void> {
  await revalidate?.()
  fs.renameSync(source, target)
  await revalidate?.()
  await revalidate?.()
  fsyncDirectory(path.dirname(source))
  await revalidate?.()
  if (!samePath(path.dirname(source), path.dirname(target))) {
    await revalidate?.()
    fsyncDirectory(path.dirname(target))
    await revalidate?.()
  }
}

async function guardedUnlink(target: string, revalidate?: RevalidateLease): Promise<void> {
  await revalidate?.()
  fs.unlinkSync(target)
  await revalidate?.()
  await revalidate?.()
  fsyncDirectory(path.dirname(target))
  await revalidate?.()
}

async function guardedMkdir(target: string, revalidate?: RevalidateLease): Promise<void> {
  await revalidate?.()
  fs.mkdirSync(target)
  await revalidate?.()
  await revalidate?.()
  fsyncDirectory(path.dirname(target))
  await revalidate?.()
  await revalidate?.()
  fsyncDirectory(target)
  await revalidate?.()
}

async function guardedRmdir(target: string, revalidate?: RevalidateLease): Promise<void> {
  await revalidate?.()
  fs.rmdirSync(target)
  await revalidate?.()
  await revalidate?.()
  fsyncDirectory(path.dirname(target))
  await revalidate?.()
}

function fsyncDirectory(target: string): void {
  flushDirectory(target)
}

function isLeaseLoss(error: unknown): boolean {
  return isApplicationTransactionError(error) && error.code === 'LOCK_NOT_OWNED'
}

function assertPlainDirectory(target: string, label: string): void {
  const stat = lstat(target)
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new LocalMaterializerError(`${label} must be a plain directory`)
  }
  let real: string
  try { real = fs.realpathSync.native(target) } catch {
    throw new LocalMaterializerError(`${label} cannot be resolved safely`)
  }
  if (!samePath(target, real)) throw new LocalMaterializerError(`${label} crosses a junction or reparse point`)
}

function assertSingleLinkFile(target: string, maxBytes: number, label: string): fs.Stats {
  const stat = lstat(target)
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new LocalMaterializerError(`${label} must be a plain single-link file`)
  }
  if (stat.size > maxBytes) throw new LocalMaterializerError(`${label} exceeds its byte limit`)
  if (!samePath(target, fs.realpathSync.native(target))) {
    throw new LocalMaterializerError(`${label} crosses a junction or reparse point`)
  }
  return stat
}

function readPlainBytes(target: string, maxBytes: number, label: string): Buffer {
  const before = assertSingleLinkFile(target, maxBytes, label)
  let descriptor: number | undefined
  try {
    const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | noFollow)
    const opened = fs.fstatSync(descriptor)
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size
      || opened.mtimeMs !== before.mtimeMs || opened.ctimeMs !== before.ctimeMs
      || opened.mode !== before.mode || opened.nlink !== before.nlink) {
      throw new LocalMaterializerError(`${label} changed while opening`)
    }
    const bytes = Buffer.alloc(opened.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset)
      if (count === 0) throw new LocalMaterializerError(`${label} ended unexpectedly`)
      offset += count
    }
    const after = fs.fstatSync(descriptor)
    const pathAfter = assertSingleLinkFile(target, maxBytes, label)
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
      || after.mode !== opened.mode || after.nlink !== opened.nlink
      || pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino || pathAfter.size !== opened.size
      || pathAfter.mtimeMs !== opened.mtimeMs || pathAfter.ctimeMs !== opened.ctimeMs
      || pathAfter.mode !== opened.mode || pathAfter.nlink !== opened.nlink) {
      throw new LocalMaterializerError(`${label} changed while reading`)
    }
    return bytes
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

async function atomicWrite(target: string, bytes: Buffer, revalidate?: RevalidateLease): Promise<void> {
  const parent = path.dirname(target)
  assertPlainDirectory(parent, 'materialization journal parent')
  const temporary = path.join(parent, `.${path.basename(target)}.${randomBytes(8).toString('hex')}.tmp`)
  let descriptor: number | undefined
  let failure: unknown
  let published = false
  try {
    await revalidate?.()
    descriptor = fs.openSync(temporary, 'wx', 0o600)
    await revalidate?.()
    await revalidate?.()
    fs.writeFileSync(descriptor, bytes)
    await revalidate?.()
    await revalidate?.()
    fs.fsyncSync(descriptor)
    await revalidate?.()
    fs.closeSync(descriptor)
    descriptor = undefined
    await guardedRename(temporary, target, revalidate)
    published = true
  } catch (error) {
    failure = error
    throw error
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch { /* preserve the mutation failure */ }
    }
    if (!published && lstat(temporary)) {
      try { await guardedUnlink(temporary, revalidate) } catch (cleanupError) {
        if (!failure || isLeaseLoss(cleanupError)) throw cleanupError
      }
    }
  }
}

function fsyncFile(target: string): void {
  const descriptor = fs.openSync(target, process.platform === 'win32' ? fs.constants.O_RDWR : fs.constants.O_RDONLY)
  try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
  fsyncDirectory(path.dirname(target))
}

async function guardedFsyncFile(target: string, revalidate?: RevalidateLease): Promise<void> {
  const descriptor = fs.openSync(
    target,
    process.platform === 'win32' ? fs.constants.O_RDWR : fs.constants.O_RDONLY
  )
  try {
    await revalidate?.()
    fs.fsyncSync(descriptor)
    await revalidate?.()
  } finally { fs.closeSync(descriptor) }
  await revalidate?.()
  fsyncDirectory(path.dirname(target))
  await revalidate?.()
}

function parseJsonFile(target: string, maxBytes: number, label: string): unknown | null {
  if (!lstat(target)) return null
  const bytes = readPlainBytes(target, maxBytes, label)
  try { return JSON.parse(bytes.toString('utf8')) as unknown } catch {
    return { invalidMaterializationDocument: true }
  }
}

function artifactDigest(
  artifact: Pick<MaterializationArtifactV1, 'owner' | 'targetRelativePath' | 'kind'>,
  files: readonly RuntimeAssetFileV1[]
): Sha256Identifier {
  return domainSeparatedSha256(MATERIALIZATION_ARTIFACT_HASH_DOMAIN, canonicalJson({
    owner: artifact.owner,
    targetRelativePath: artifact.targetRelativePath,
    kind: artifact.kind,
    files: [...files].sort((left, right) => compareUtf8Bytes(left.path, right.path)).map((file) => ({
      path: file.path,
      size: file.size,
      sha256: file.sha256,
      mode: file.mode
    }))
  } satisfies CanonicalJsonValue))
}

function unsafeDigest(label: string): Sha256Identifier {
  return domainSeparatedSha256('skill-graft/materialization-unsafe-observation/v1', label)
}

function safeTarget(worktree: string, relative: string): { target: string; pathEscaped: boolean } {
  if (!isPortableRelativePath(relative)) throw new LocalMaterializerError('materialization target is not portable')
  const target = path.resolve(worktree, ...relative.split('/'))
  if (!sameOrInside(worktree, target) || samePath(worktree, target)) {
    throw new LocalMaterializerError('materialization target escaped its worktree')
  }
  let cursor = worktree
  for (const segment of relative.split('/').slice(0, -1)) {
    cursor = path.join(cursor, segment)
    const stat = lstat(cursor)
    if (!stat) break
    if (!stat.isDirectory() || stat.isSymbolicLink()) return { target, pathEscaped: true }
    if (!samePath(cursor, fs.realpathSync.native(cursor))) return { target, pathEscaped: true }
  }
  return { target, pathEscaped: false }
}

function modeOf(stat: fs.Stats): '100644' | '100755' {
  return process.platform !== 'win32' && (stat.mode & 0o111) !== 0 ? '100755' : '100644'
}

function observePath(
  worktree: string,
  artifact: MaterializationArtifactV1,
  limits: LocalMaterializerLimits,
  physicalTarget?: string
): PathDigest {
  const bounded = physicalTarget
    ? { target: path.resolve(physicalTarget), pathEscaped: false }
    : safeTarget(worktree, artifact.targetRelativePath)
  if (bounded.pathEscaped) {
    return { kind: 'missing', isReparsePoint: false, unsafeDescendant: true }
  }
  const stat = lstat(bounded.target)
  if (!stat) return { kind: 'missing', isReparsePoint: false, unsafeDescendant: false }
  if (stat.isSymbolicLink()) {
    return {
      kind: process.platform === 'win32' && stat.isDirectory() ? 'junction' : 'symlink',
      isReparsePoint: true,
      unsafeDescendant: false
    }
  }
  if (stat.isFile()) {
    if (stat.nlink !== 1) return { kind: 'hardlink', isReparsePoint: false, unsafeDescendant: false }
    const bytes = readPlainBytes(bounded.target, limits.maxFileBytes, 'materialized file')
    const file: RuntimeAssetFileV1 = {
      path: path.posix.basename(artifact.targetRelativePath),
      size: bytes.length,
      sha256: sha256Identifier(bytes),
      mode: modeOf(stat)
    }
    return {
      kind: 'file',
      digest: artifactDigest(artifact, [file]),
      isReparsePoint: false,
      unsafeDescendant: false
    }
  }
  if (!stat.isDirectory()) return { kind: 'other', isReparsePoint: false, unsafeDescendant: false }
  if (!samePath(bounded.target, fs.realpathSync.native(bounded.target))) {
    return { kind: 'directory', digest: unsafeDigest(artifact.targetRelativePath), isReparsePoint: false, unsafeDescendant: true }
  }
  const files: RuntimeAssetFileV1[] = []
  let unsafe = false
  let fileCount = 0
  let totalBytes = 0
  const visit = (directory: string, prefix: string): void => {
    const before = lstat(directory)
    if (!before?.isDirectory() || before.isSymbolicLink() || !samePath(directory, fs.realpathSync.native(directory))) {
      unsafe = true
      return
    }
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)))
    for (const entry of entries) {
      if (entry.name !== entry.name.normalize('NFC') || entry.name.includes('\\')) { unsafe = true; continue }
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const child = path.join(directory, entry.name)
      const childStat = lstat(child)
      if (!childStat || childStat.isSymbolicLink() || !samePath(child, fs.realpathSync.native(child))) {
        unsafe = true
        continue
      }
      if (childStat.isDirectory()) visit(child, relative)
      else if (childStat.isFile() && childStat.nlink === 1) {
        fileCount += 1
        if (fileCount > limits.maxFiles) throw new LocalMaterializerError('materialized artifact exceeds the file limit')
        const bytes = readPlainBytes(child, limits.maxFileBytes, 'materialized artifact file')
        totalBytes += bytes.length
        if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxTotalBytes) {
          throw new LocalMaterializerError('materialized artifact exceeds the aggregate byte limit')
        }
        files.push({ path: relative, size: bytes.length, sha256: sha256Identifier(bytes), mode: modeOf(childStat) })
      } else unsafe = true
    }
    const after = lstat(directory)
    if (!after || after.dev !== before.dev || after.ino !== before.ino
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || after.mode !== before.mode || after.nlink !== before.nlink) unsafe = true
  }
  visit(bounded.target, '')
  return {
    kind: 'directory',
    digest: unsafe ? unsafeDigest(artifact.targetRelativePath) : artifactDigest(artifact, files),
    isReparsePoint: false,
    unsafeDescendant: unsafe
  }
}

function legacyExpected(root: string, artifact: MaterializationArtifactV1): string | null {
  if (artifact.owner === 'agentsOverride') return path.join(root, 'AGENTS.override.md')
  if (artifact.owner === 'localOverlay') return path.join(root, 'overlay')
  const separator = artifact.artifactId.indexOf(':')
  const name = separator < 0 ? '' : artifact.artifactId.slice(separator + 1)
  if (!name || name === 'unity-skills') return null
  return artifact.owner === 'residentSkill'
    ? path.join(root, 'skills', name)
    : path.join(root, 'skills', 'adopted', name)
}

function classifyLink(worktree: string, artifact: MaterializationArtifactV1, root?: string): 'legacy' | 'external' {
  if (!root) return 'external'
  const target = safeTarget(worktree, artifact.targetRelativePath).target
  const expected = legacyExpected(path.resolve(root), artifact)
  if (!expected || !lstat(expected)) return 'external'
  const targetStat = lstat(target)
  const expectedStat = lstat(expected)
  if (!targetStat || !expectedStat) return 'external'
  try {
    if (targetStat.isSymbolicLink()) {
      return samePath(fs.realpathSync.native(target), fs.realpathSync.native(expected)) ? 'legacy' : 'external'
    }
    if (targetStat.isFile() && expectedStat.isFile()) {
      return targetStat.dev === expectedStat.dev && targetStat.ino === expectedStat.ino ? 'legacy' : 'external'
    }
  } catch { return 'external' }
  return 'external'
}

function checkedLegacySourceRoot(options: LocalMaterializerOptions, worktree: string): string {
  if (!options.legacySourceRoot || !path.isAbsolute(options.legacySourceRoot)) {
    throw new LocalMaterializerLayoutError('legacy source root must be an absolute plain directory')
  }
  const root = path.resolve(options.legacySourceRoot)
  try { assertPlainDirectory(root, 'legacy source root') } catch {
    throw new LocalMaterializerLayoutError('legacy source root must be an absolute plain directory')
  }
  if (sameOrInside(worktree, root)) {
    throw new LocalMaterializerLayoutError('legacy source root must be outside the worktree')
  }
  return root
}

function readStableRegularBytes(target: string, maxBytes: number, label: string): Buffer {
  const before = lstat(target)
  if (!before?.isFile() || before.isSymbolicLink() || before.size > maxBytes
    || !samePath(target, fs.realpathSync.native(target))) {
    throw new LocalMaterializerError(`${label} is not a bounded canonical regular file`)
  }
  let descriptor: number | undefined
  try {
    const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | noFollow)
    const opened = fs.fstatSync(descriptor)
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs
      || opened.ctimeMs !== before.ctimeMs || opened.mode !== before.mode
      || opened.nlink !== before.nlink) {
      throw new LocalMaterializerError(`${label} changed while opening`)
    }
    const bytes = Buffer.alloc(opened.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset)
      if (count === 0) throw new LocalMaterializerError(`${label} ended unexpectedly`)
      offset += count
    }
    const after = fs.fstatSync(descriptor)
    const pathAfter = lstat(target)
    if (!pathAfter?.isFile() || pathAfter.isSymbolicLink()
      || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
      || after.mode !== opened.mode || after.nlink !== opened.nlink
      || pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino
      || pathAfter.size !== opened.size || pathAfter.mtimeMs !== opened.mtimeMs
      || pathAfter.ctimeMs !== opened.ctimeMs || pathAfter.mode !== opened.mode
      || pathAfter.nlink !== opened.nlink) {
      throw new LocalMaterializerError(`${label} changed while reading`)
    }
    return bytes
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

function legacyArtifactContentDigest(
  worktree: string,
  artifact: DesiredMaterializationArtifact,
  physical: string,
  limits: LocalMaterializerLimits
): { digest: Sha256Identifier; unsafe: boolean } {
  if (artifact.kind === 'file') {
    try {
      const stat = lstat(physical)
      if (!stat?.isFile() || stat.isSymbolicLink()) {
        return { digest: unsafeDigest(artifact.targetRelativePath), unsafe: true }
      }
      const bytes = readStableRegularBytes(physical, limits.maxFileBytes, 'legacy materialization file')
      return {
        digest: artifactDigest(artifact, [{
          path: path.posix.basename(artifact.targetRelativePath),
          size: bytes.length,
          sha256: sha256Identifier(bytes),
          mode: modeOf(stat)
        }]),
        unsafe: false
      }
    } catch {
      return { digest: unsafeDigest(artifact.targetRelativePath), unsafe: true }
    }
  }
  try {
    const observed = observePath(worktree, artifact, limits, physical)
    return observed.kind === 'directory' && observed.digest
      ? { digest: observed.digest, unsafe: observed.unsafeDescendant }
      : { digest: unsafeDigest(artifact.targetRelativePath), unsafe: true }
  } catch {
    return { digest: unsafeDigest(artifact.targetRelativePath), unsafe: true }
  }
}

function externalLegacySourceId(input: {
  kind: string
  rawLinkTarget: string | null
  device: string | null
  inode: string | null
  digest: Sha256Identifier
}): Sha256Identifier {
  return domainSeparatedSha256(
    'skill-graft/legacy-external-source-state/v1',
    canonicalJson(input as unknown as CanonicalJsonValue)
  )
}

function legacyArtifactObservation(
  options: LocalMaterializerOptions,
  worktree: string,
  legacyRoot: string,
  artifact: DesiredMaterializationArtifact,
  limits: LocalMaterializerLimits
): { fact: LegacyArtifactFactV1; privateFact: LegacyPrivateArtifactSnapshotV1 } {
  assertControlledTarget(artifact)
  const bounded = safeTarget(worktree, artifact.targetRelativePath)
  const target = bounded.target
  const expected = legacyExpected(legacyRoot, artifact)
  const targetStat = bounded.pathEscaped ? null : lstat(target)
  const expectedStat = expected ? lstat(expected) : null
  const protectedTarget = artifact.targetRelativePath === 'AGENTS.md'
    || artifact.targetRelativePath === '.agents/skills/unity-skills'
  if (bounded.pathEscaped) {
    const sourceStateId = domainSeparatedSha256(
      'skill-graft/legacy-restore-source-state/v1',
      canonicalJson({ artifactId: artifact.artifactId, status: 'unsafe-ancestor' })
    )
    return {
      fact: {
        artifactId: artifact.artifactId,
        owner: artifact.owner,
        targetRelativePath: artifact.targetRelativePath,
        kind: artifact.kind,
        observedKind: 'missing',
        digest: null,
        isReparsePoint: false,
        legacyKind: null,
        sourceArtifactId: null,
        pathEscaped: true,
        protected: protectedTarget
      },
      privateFact: {
        artifactId: artifact.artifactId,
        targetRelativePath: artifact.targetRelativePath,
        legacyKind: null,
        sourceArtifactId: null,
        rawLinkTarget: null,
        targetDevice: null,
        targetInode: null,
        sourceLocator: expected,
        sourceDevice: null,
        sourceInode: null,
        contentDigest: null,
        sourceStateId
      }
    }
  }
  if (!targetStat) {
    const privateBase = {
      artifactId: artifact.artifactId,
      targetRelativePath: artifact.targetRelativePath,
      legacyKind: null,
      sourceArtifactId: null,
      rawLinkTarget: null,
      targetDevice: null,
      targetInode: null,
      sourceLocator: expected,
      sourceDevice: expectedStat ? String(expectedStat.dev) : null,
      sourceInode: expectedStat ? String(expectedStat.ino) : null,
      contentDigest: null
    } as const
    return {
      fact: {
        artifactId: artifact.artifactId,
        owner: artifact.owner,
        targetRelativePath: artifact.targetRelativePath,
        kind: artifact.kind,
        observedKind: 'missing',
        digest: null,
        isReparsePoint: false,
        legacyKind: null,
        sourceArtifactId: null,
        pathEscaped: false,
        protected: protectedTarget
      },
      privateFact: {
        ...privateBase,
        sourceStateId: domainSeparatedSha256(
          'skill-graft/legacy-restore-source-state/v1',
          canonicalJson(privateBase as unknown as CanonicalJsonValue)
        )
      }
    }
  }

  let rawLinkTarget: string | null = null
  let observedKind: LegacyArtifactFactV1['observedKind']
  let isReparsePoint = false
  if (targetStat.isSymbolicLink()) {
    try { rawLinkTarget = fs.readlinkSync(target) } catch { rawLinkTarget = '<unreadable>' }
    isReparsePoint = true
    let resolvesDirectory = false
    try { resolvesDirectory = fs.statSync(target).isDirectory() } catch { /* dangling */ }
    observedKind = resolvesDirectory ? 'junction' : 'symlink'
  } else if (targetStat.isFile()) {
    observedKind = targetStat.nlink > 1 ? 'hardlink' : 'file'
  } else if (targetStat.isDirectory()) {
    observedKind = 'directory'
  } else observedKind = 'other'

  const content = observedKind === 'junction' || observedKind === 'symlink'
    ? (() => {
        try { return legacyArtifactContentDigest(worktree, artifact, fs.realpathSync.native(target), limits) } catch {
          return { digest: unsafeDigest(artifact.targetRelativePath), unsafe: true }
        }
      })()
    : observedKind === 'hardlink' || observedKind === 'file' || observedKind === 'directory'
      ? legacyArtifactContentDigest(worktree, artifact, target, limits)
      : { digest: unsafeDigest(artifact.targetRelativePath), unsafe: true }

  let exactLegacy = false
  if (expected && expectedStat) {
    try {
      if (artifact.kind === 'directory' && observedKind === 'junction' && expectedStat.isDirectory()) {
        exactLegacy = samePath(fs.realpathSync.native(target), fs.realpathSync.native(expected))
      } else if (artifact.kind === 'file' && observedKind === 'hardlink' && expectedStat.isFile()) {
        exactLegacy = targetStat.dev === expectedStat.dev && targetStat.ino === expectedStat.ino
      }
    } catch { exactLegacy = false }
  }
  const expectedSourceArtifactId = materializationSourceArtifactId({
    digest: artifact.digest,
    source: artifact.source
  })
  const externalId = externalLegacySourceId({
    kind: observedKind,
    rawLinkTarget,
    device: String(targetStat.dev),
    inode: String(targetStat.ino),
    digest: content.digest
  })
  const legacyKind: LegacyLinkKind | null = exactLegacy
    ? artifact.kind === 'file' ? 'fileHardlink' : 'directoryLink'
    : null
  const sourceArtifactId = exactLegacy ? expectedSourceArtifactId
    : observedKind === 'junction' || observedKind === 'symlink' || observedKind === 'hardlink'
      ? externalId
      : null
  const privateBase = {
    artifactId: artifact.artifactId,
    targetRelativePath: artifact.targetRelativePath,
    legacyKind,
    sourceArtifactId,
    rawLinkTarget,
    targetDevice: String(targetStat.dev),
    targetInode: String(targetStat.ino),
    sourceLocator: expected,
    sourceDevice: expectedStat ? String(expectedStat.dev) : null,
    sourceInode: expectedStat ? String(expectedStat.ino) : null,
    contentDigest: content.digest
  } as const
  return {
    fact: {
      artifactId: artifact.artifactId,
      owner: artifact.owner,
      targetRelativePath: artifact.targetRelativePath,
      kind: artifact.kind,
      observedKind,
      digest: content.digest,
      isReparsePoint,
      legacyKind,
      sourceArtifactId,
      pathEscaped: observedKind === 'junction' || observedKind === 'symlink'
        || observedKind === 'hardlink' ? false : content.unsafe,
      protected: protectedTarget
    },
    privateFact: {
      ...privateBase,
      sourceStateId: domainSeparatedSha256(
        'skill-graft/legacy-restore-source-state/v1',
        canonicalJson(privateBase as unknown as CanonicalJsonValue)
      )
    }
  }
}

function gitTracked(worktree: string, relative: string): {
  trackedCount: number
  skippedTrackedCount: number
  paths: { path: string; skipWorktree: boolean }[]
} {
  const output = runGit(worktree, ['-c', 'core.quotepath=false', 'ls-files', '-v', '-z', '--', relative])
  const records = output.split('\0').filter(Boolean)
  const paths: { path: string; skipWorktree: boolean }[] = []
  let skippedTrackedCount = 0
  for (const record of records) {
    const match = record.match(/^(.)(?:\s)(.*)$/s)
    if (!match) throw new LocalMaterializerError('Git index returned an invalid visibility record')
    const skipWorktree = match[1].toUpperCase() === 'S'
    paths.push({ path: match[2], skipWorktree })
    if (skipWorktree) skippedTrackedCount += 1
  }
  return { trackedCount: paths.length, skippedTrackedCount, paths }
}

function worktreeConfigPath(worktree: string): string {
  return exactGitPath(worktree, 'config.worktree')
}

function privateExcludePath(worktree: string): string {
  return exactGitPath(worktree, 'skill-graft/excludes-v1')
}

function locallyExcluded(worktree: string, relative: string): boolean {
  const config = worktreeConfigPath(worktree)
  if (!lstat(config)) return false
  const configured = runGit(worktree, ['config', '--file', config, '--get', 'core.excludesFile'], { allowOne: true }).trim()
  const excludes = privateExcludePath(worktree)
  if (!configured || !path.isAbsolute(configured) || !samePath(configured, excludes) || !lstat(excludes)) return false
  return managedPrivatePatterns(excludes, DEFAULT_LIMITS.maxGitConfigBytes).includes(`/${relative}`)
}

function managedPrivatePatterns(target: string, maxBytes: number): string[] {
  if (!lstat(target)) return []
  const lines = readPlainBytes(target, maxBytes, 'private worktree excludes').toString('utf8').split(/\r?\n/)
  const begin = lines.indexOf(PRIVATE_EXCLUDES_BEGIN)
  const end = lines.indexOf(PRIVATE_EXCLUDES_END)
  if (begin < 0 || end <= begin || lines.indexOf(PRIVATE_EXCLUDES_BEGIN, begin + 1) >= 0
    || lines.indexOf(PRIVATE_EXCLUDES_END, end + 1) >= 0) return []
  return lines.slice(begin + 1, end).filter(Boolean)
}

function containsReservedPrivateExcludeLine(bytes: Buffer): boolean {
  const begin = Buffer.from(PRIVATE_EXCLUDES_BEGIN, 'utf8')
  const end = Buffer.from(PRIVATE_EXCLUDES_END, 'utf8')
  let offset = 0
  while (offset <= bytes.length) {
    const newline = bytes.indexOf(0x0a, offset)
    let contentEnd = newline < 0 ? bytes.length : newline
    if (contentEnd > offset && bytes[contentEnd - 1] === 0x0d) contentEnd -= 1
    const line = bytes.subarray(offset, contentEnd)
    if (line.equals(begin) || line.equals(end)) return true
    if (newline < 0) break
    offset = newline + 1
  }
  return false
}

function gitIgnoreFact(worktree: string, relative: string, baseOverride?: string): {
  ignored: boolean
  ignoreOrigin: 'none' | 'repository' | 'legacyCommon' | 'external' | 'private'
} {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => (
    !name.toUpperCase().startsWith('GIT_')
  ))) as NodeJS.ProcessEnv
  const result = spawnSync('git', [
    '-C', worktree,
    ...(baseOverride ? ['-c', `core.excludesFile=${baseOverride}`] : []),
    'check-ignore', '-v', '-z', '--no-index', '--stdin'
  ], {
    encoding: 'utf8', windowsHide: true, env: environment,
    input: Buffer.from(`${relative}\0`, 'utf8')
  })
  if (result.status === 1) return { ignored: false, ignoreOrigin: 'none' }
  if (result.status !== 0) throw new LocalMaterializerError('Git ignore fact could not be inspected')
  const fields = String(result.stdout || '').split('\0')
  if (fields.length < 5 || !fields[0] || !fields[2]) {
    throw new LocalMaterializerError('Git ignore fact has an invalid source record')
  }
  const source = path.resolve(worktree, fields[0])
  const pattern = fields[2]
  const configuration = gitConfigurationLayout(layoutOf(worktree))
  if (samePath(source, configuration.privateExclude)) {
    return {
      ignored: true,
      ignoreOrigin: managedPrivatePatterns(configuration.privateExclude, DEFAULT_LIMITS.maxGitConfigBytes)
        .includes(pattern) ? 'private' : 'external'
    }
  }
  if (samePath(source, configuration.commonInfoExclude)
    && exactManagedPattern(pattern, new Set([relative]))) {
    return { ignored: true, ignoreOrigin: 'legacyCommon' }
  }
  return {
    ignored: true,
    ignoreOrigin: sameOrInside(worktree, source) && !samePath(source, configuration.commonInfoExclude)
      ? 'repository' : 'external'
  }
}

type RawGitVisibility = {
  targetRelativePath: string
  trackedPaths: readonly { path: string; skipWorktree: boolean }[]
  ignored: boolean
  ignoreOrigin: 'none' | 'repository' | 'legacyCommon' | 'external' | 'private'
  privateExcluded: boolean
}

function inspectRawGit(worktree: string, relative: string, baseOverride?: string): RawGitVisibility {
  const tracked = gitTracked(worktree, relative)
  const ignored = gitIgnoreFact(worktree, relative, baseOverride)
  return {
    targetRelativePath: relative,
    trackedPaths: tracked.paths,
    ignored: ignored.ignored,
    ignoreOrigin: ignored.ignoreOrigin,
    privateExcluded: baseOverride ? false : locallyExcluded(worktree, relative)
  }
}

function createVisibilityFact(input: RawGitVisibility & {
  ownership: 'unmanaged' | 'managed' | 'invalid'
  ownershipStateId: Sha256Identifier | null
  baselineDigest: Sha256Identifier | null
  restoreDigest: Sha256Identifier | null
  restoreSafe: boolean
}): GitVisibilityFact {
  const created = createGitVisibilityFact({
    ...input
  })
  if (!created.ok) throw new LocalMaterializerError(created.message)
  return created.fact
}

function inspectUnmanagedGit(worktree: string, relative: string): GitVisibilityFact {
  return createVisibilityFact({
    ...inspectRawGit(worktree, relative),
    ownership: 'unmanaged',
    ownershipStateId: null,
    baselineDigest: ZERO_SHA,
    restoreDigest: null,
    restoreSafe: true
  })
}

function markerBytes(marker: MaterializationMarkerV1): Buffer {
  return Buffer.from(`${JSON.stringify(marker, null, 2)}\n`, 'utf8')
}

function equalJson(left: unknown, right: unknown): boolean {
  try { return canonicalJson(left as CanonicalJsonValue) === canonicalJson(right as CanonicalJsonValue) } catch { return false }
}

function assertControlledTarget(artifact: MaterializationArtifactV1): void {
  const target = artifact.targetRelativePath
  const valid = artifact.owner === 'agentsOverride'
    ? target === 'AGENTS.override.md' && artifact.kind === 'file'
    : artifact.owner === 'localOverlay'
      ? target === '.codex/local-overlay' && artifact.kind === 'directory'
      : (artifact.owner === 'residentSkill' || artifact.owner === 'adoptedSkill')
        && artifact.kind === 'directory'
        && /^\.agents\/skills\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(target)
        && target !== '.agents/skills/unity-skills'
  if (!valid || target === 'AGENTS.md' || target.startsWith('AGENTS.md/')) {
    throw new LocalMaterializerError('Core plan contains a protected or unknown materialization target')
  }
}

async function checkedIdentity(
  identities: WorktreeIdentityPort,
  worktreeInput: string,
  expected: WorktreeIdentity
): Promise<string> {
  const worktree = path.resolve(worktreeInput)
  assertPlainDirectory(worktree, 'worktree')
  const top = path.resolve(runGit(worktree, ['rev-parse', '--show-toplevel']).trim())
  if (!samePath(top, worktree)) throw new LocalMaterializerError('materialization requires the exact Git worktree root')
  const observed = await identities.resolve(worktree)
  if (observed.pathKey !== expected.pathKey || observed.worktreeId !== expected.worktreeId) {
    throw new LocalMaterializerError('worktree identity changed during materialization')
  }
  return worktree
}

function layoutOf(worktree: string): LocalLayout {
  const gitAdminValue = runGit(worktree, ['rev-parse', '--absolute-git-dir']).trim()
  const graftValue = runGit(worktree, ['rev-parse', '--git-path', 'skill-graft']).trim()
  if (!gitAdminValue || !graftValue) throw new LocalMaterializerLayoutError('Git administrative path is unavailable')
  const gitAdminRoot = path.resolve(worktree, gitAdminValue)
  const graftRoot = path.resolve(worktree, graftValue)
  try { assertPlainDirectory(gitAdminRoot, 'Git administrative root') } catch {
    throw new LocalMaterializerLayoutError('Git administrative root must be a plain canonical directory')
  }
  if (!sameOrInside(gitAdminRoot, graftRoot)) throw new LocalMaterializerLayoutError('Skill Graft journal escaped the Git administrative root')
  if (path.parse(worktree).root.toLowerCase() !== path.parse(gitAdminRoot).root.toLowerCase()) {
    throw new LocalMaterializerLayoutError('worktree and Git journal must be on the same volume')
  }
  const worktreeStat = fs.statSync(worktree)
  const adminStat = fs.statSync(gitAdminRoot)
  if (process.platform !== 'win32' && worktreeStat.dev !== adminStat.dev) {
    throw new LocalMaterializerLayoutError('worktree and Git journal must be on the same filesystem')
  }
  return {
    worktree,
    gitAdminRoot,
    graftRoot,
    marker: path.join(graftRoot, MARKER_NAME),
    transactions: path.join(graftRoot, 'transactions'),
    legacyTransactions: path.join(graftRoot, 'legacy-transactions'),
    legacyBackups: path.join(graftRoot, 'legacy-backups'),
    visibility: path.join(graftRoot, 'visibility'),
    visibilityPrivate: path.join(graftRoot, 'visibility-private')
  }
}

function assertNoPendingMaterializationTransaction(layout: LocalLayout): void {
  for (const [root, label] of [
    [layout.transactions, 'ordinary materialization transactions root'],
    [layout.legacyTransactions, 'legacy materialization transactions root']
  ] as const) {
    if (!lstat(root)) continue
    assertPlainDirectory(root, label)
    if (fs.readdirSync(root).length !== 0) {
      throw new LocalMaterializerStateError(
        'pending materialization recovery must complete before legacy preparation'
      )
    }
  }
  if (!lstat(layout.legacyBackups)) return
  assertPlainDirectory(layout.legacyBackups, 'legacy materialization backups root')
  if (fs.readdirSync(layout.legacyBackups).some((name) => !/^[0-9a-f]{64}$/.test(name))) {
    throw new LocalMaterializerStateError(
      'legacy backup recovery must complete before legacy preparation'
    )
  }
}

function visibilityHex(id: Sha256Identifier): string {
  if (!/^sha256:[0-9a-f]{64}$/.test(id)) {
    throw new LocalMaterializerStateError('visibility ownership identifier is invalid')
  }
  return id.slice('sha256:'.length)
}

function visibilityStatePath(layout: LocalLayout, id: Sha256Identifier): string {
  return path.join(layout.visibility, `${visibilityHex(id)}.json`)
}

function visibilityPrivatePath(layout: LocalLayout, id: Sha256Identifier): string {
  return path.join(layout.visibilityPrivate, `${visibilityHex(id)}.json`)
}

function ensurePlainPath(root: string, target: string): void {
  if (!sameOrInside(root, target)) throw new LocalMaterializerError('journal path escaped its root')
  const relation = path.relative(root, target)
  let cursor = root
  for (const segment of relation.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment)
    const stat = lstat(cursor)
    if (!stat) break
    if (stat.isSymbolicLink() || !samePath(cursor, fs.realpathSync.native(cursor))) {
      throw new LocalMaterializerError('journal path crosses a junction or reparse point')
    }
  }
}

async function ensureDirectory(
  root: string,
  target: string,
  revalidate?: RevalidateLease
): Promise<void> {
  ensurePlainPath(root, target)
  const relation = path.relative(root, target)
  let cursor = root
  for (const segment of relation.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment)
    if (!lstat(cursor)) await guardedMkdir(cursor, revalidate)
  }
  assertPlainDirectory(target, 'materialization journal directory')
}

function newMarker(plan: MaterializePlanV1, desired: DesiredMaterialization): MaterializationMarkerV1 {
  const marker: MaterializationMarkerV1 = {
    schemaVersion: 1,
    materializationId: plan.requested.materializationId,
    planHash: plan.planHash,
    pathKey: plan.pathKey,
    worktreeId: plan.worktreeId,
    snapshotId: plan.requested.snapshotId,
    selectedSkills: [...plan.requested.selectedSkills],
    runtimeRevision: plan.requested.runtimeRevision,
    runtimeAssetId: plan.requested.runtimeAssetId,
    visibilityStateId: plan.requested.visibilityStateId,
    origin: { kind: 'sync' },
    artifacts: desired.artifacts.map(({ source: _source, files: _files, ...artifact }) => artifact)
  }
  if (!verifyMaterializationMarker(marker)) throw new LocalMaterializerError('materialization marker failed Core validation')
  return marker
}

function sourcePath(artifact: DesiredMaterializationArtifact, file: RuntimeAssetFileV1): string {
  if (artifact.kind === 'file') return artifact.source.prefix
  return artifact.source.prefix ? `${artifact.source.prefix}/${file.path}` : file.path
}

async function verifiedSourceBytes(
  options: LocalMaterializerOptions,
  artifact: DesiredMaterializationArtifact,
  file: RuntimeAssetFileV1
): Promise<Uint8Array> {
  const source = sourcePath(artifact, file)
  const bytes = artifact.source.kind === 'snapshot'
    ? await options.snapshots.readVerifiedFile({
      snapshotId: artifact.source.snapshotId,
      path: source,
      expectedSize: file.size,
      expectedSha256: file.sha256
    })
    : await options.runtimeAssets.readVerifiedFile({
      runtimeAssetId: artifact.source.runtimeAssetId,
      path: source,
      expectedSize: file.size,
      expectedSha256: file.sha256,
      expectedMode: file.mode
    })
  if (!bytes || bytes.byteLength !== file.size || sha256Identifier(Buffer.from(bytes)) !== file.sha256) {
    throw new LocalMaterializerError('verified materialization source content is missing or changed')
  }
  return bytes
}

async function writeStagedFile(
  target: string,
  bytes: Uint8Array,
  mode: '100644' | '100755',
  revalidate?: RevalidateLease
): Promise<void> {
  let descriptor: number | undefined
  try {
    await revalidate?.()
    descriptor = fs.openSync(target, 'wx', mode === '100755' ? 0o755 : 0o644)
    await revalidate?.()
    await revalidate?.()
    fs.writeFileSync(descriptor, bytes)
    await revalidate?.()
    await revalidate?.()
    fs.fsyncSync(descriptor)
    await revalidate?.()
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
  if (process.platform !== 'win32') {
    await revalidate?.()
    fs.chmodSync(target, mode === '100755' ? 0o755 : 0o644)
    await revalidate?.()
  }
  await guardedFsyncFile(target, revalidate)
}

function currentDigest(
  worktree: string,
  artifact: MaterializationArtifactV1,
  limits: LocalMaterializerLimits
): Sha256Identifier | null | 'unsafe' {
  const observed = observePath(worktree, artifact, limits)
  if (observed.unsafeDescendant || observed.kind === 'symlink' || observed.kind === 'junction'
    || observed.kind === 'hardlink' || observed.kind === 'other') return 'unsafe'
  if (observed.kind === 'missing') return null
  return observed.digest ?? 'unsafe'
}

function stageName(index: number): string { return `artifact-${String(index).padStart(4, '0')}` }

function pathStateMatches(value: Sha256Identifier | null | 'unsafe', expected: Sha256Identifier | null): boolean {
  return value !== 'unsafe' && value === expected
}

function artifactPathDigest(
  worktree: string,
  target: string,
  artifact: MaterializationArtifactV1,
  limits: LocalMaterializerLimits
): Sha256Identifier | null | 'unsafe' {
  const observed = observePath(worktree, artifact, limits, target)
  if (observed.unsafeDescendant || observed.kind === 'symlink' || observed.kind === 'junction'
    || observed.kind === 'hardlink' || observed.kind === 'other') return 'unsafe'
  if (observed.kind === 'missing') return null
  return observed.digest ?? 'unsafe'
}

async function movePreparedArtifact(
  layout: LocalLayout,
  txRoot: string,
  entry: ArtifactJournal,
  artifact: MaterializationArtifactV1,
  limits: LocalMaterializerLimits,
  createdParents: readonly string[],
  revalidate?: RevalidateLease
): Promise<void> {
  const target = safeTarget(layout.worktree, entry.targetRelativePath)
  if (target.pathEscaped) throw new LocalMaterializerError('materialization target ancestor changed')
  const stage = entry.stageName ? path.join(txRoot, 'staging', entry.stageName) : null
  const backup = path.join(txRoot, 'backups', entry.backupName)
  let current = currentDigest(layout.worktree, artifact, limits)
  let staged = stage ? artifactPathDigest(layout.worktree, stage, artifact, limits) : null
  let backedUp = artifactPathDigest(layout.worktree, backup, artifact, limits)
  if (entry.action === 'create') {
    if (current === entry.after && staged === null && backedUp === null) return
    if (current !== null || staged !== entry.after || backedUp !== null || !stage) {
      throw new LocalMaterializerError('create publication no longer matches its prepared state')
    }
    await ensureTargetParentGuarded(layout.worktree, target.target, createdParents, revalidate)
    await guardedRename(stage, target.target, revalidate)
    return
  }
  if (entry.action === 'delete') {
    if (current === null && backedUp === entry.before) return
    if (!pathStateMatches(current, entry.before) || backedUp !== null || staged !== null) {
      throw new LocalMaterializerError('delete publication no longer matches its prepared state')
    }
    await guardedRename(target.target, backup, revalidate)
    return
  }
  if (current === entry.after && staged === null && backedUp === entry.before) return
  if (pathStateMatches(current, entry.before) && backedUp === null && staged === entry.after) {
    await guardedRename(target.target, backup, revalidate)
    current = null
    backedUp = artifactPathDigest(layout.worktree, backup, artifact, limits)
    staged = stage ? artifactPathDigest(layout.worktree, stage, artifact, limits) : null
  }
  if (current === null && backedUp === entry.before && staged === entry.after && stage) {
    await guardedRename(stage, target.target, revalidate)
    return
  }
  throw new LocalMaterializerError('update publication no longer matches its prepared state')
}

function ensureTargetParent(worktree: string, target: string, createdParents?: readonly string[]): void {
  const relative = path.relative(worktree, path.dirname(target))
  let cursor = worktree
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment)
    const stat = lstat(cursor)
    const portable = path.relative(worktree, cursor).replaceAll('\\', '/')
    if (!stat) {
      if (createdParents && !createdParents.includes(portable)) {
        throw new LocalMaterializerError('materialization parent disappeared after planning')
      }
      fs.mkdirSync(cursor)
    }
    else if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(cursor, fs.realpathSync.native(cursor))) {
      throw new LocalMaterializerError('materialization parent is not a plain directory')
    }
  }
}

async function ensureTargetParentGuarded(
  worktree: string,
  target: string,
  createdParents: readonly string[],
  revalidate?: RevalidateLease
): Promise<void> {
  const relative = path.relative(worktree, path.dirname(target))
  let cursor = worktree
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment)
    const stat = lstat(cursor)
    const portable = path.relative(worktree, cursor).replaceAll('\\', '/')
    if (!stat) {
      if (!createdParents.includes(portable)) {
        throw new LocalMaterializerError('materialization parent disappeared after planning')
      }
      await guardedMkdir(cursor, revalidate)
    } else if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(cursor, fs.realpathSync.native(cursor))) {
      throw new LocalMaterializerError('materialization parent is not a plain directory')
    }
  }
}

async function publishParents(
  worktree: string,
  createdParents: readonly string[],
  controlledTargets: readonly string[],
  allowAlreadyCreated: boolean,
  revalidate?: RevalidateLease
): Promise<void> {
  for (const relative of createdParents) {
    const target = safeTarget(worktree, `${relative}/placeholder`)
    const parent = path.dirname(target.target)
    const observed = lstat(parent)
    if (target.pathEscaped || observed && (!allowAlreadyCreated
      || !observed.isDirectory() || observed.isSymbolicLink() || !samePath(parent, fs.realpathSync.native(parent)))) {
      throw new LocalMaterializerError('materialization parent appeared after planning')
    }
    if (observed && allowAlreadyCreated) {
      const prefix = `${relative}/`
      const allowedChildren = new Set([...createdParents, ...controlledTargets]
        .filter((candidate) => candidate.startsWith(prefix))
        .map((candidate) => candidate.slice(prefix.length).split('/')[0]))
      if (fs.readdirSync(parent).some((name) => !allowedChildren.has(name))) {
        throw new LocalMaterializerStateError('recovered materialization parent contains an unowned entry')
      }
    }
  }
  for (const relative of createdParents) {
    const target = path.resolve(worktree, ...relative.split('/'))
    if (lstat(target)) continue
    const parent = path.dirname(target)
    assertPlainDirectory(parent, 'materialization parent ancestor')
    await guardedMkdir(target, revalidate)
    assertPlainDirectory(target, 'created materialization parent')
  }
}

async function publishResourceParents(
  layout: LocalLayout,
  created: readonly ('visibility' | 'visibility-private')[],
  allowAlreadyCreated: boolean,
  revalidate?: RevalidateLease
): Promise<void> {
  for (const relative of created) {
    const target = relative === 'visibility' ? layout.visibility : layout.visibilityPrivate
    const stat = lstat(target)
    if (stat && (!allowAlreadyCreated || !stat.isDirectory() || stat.isSymbolicLink()
      || !samePath(target, fs.realpathSync.native(target)))) {
      throw new LocalMaterializerError('visibility sidecar parent appeared after planning')
    }
  }
  for (const relative of created) {
    const target = relative === 'visibility' ? layout.visibility : layout.visibilityPrivate
    if (!lstat(target)) await ensureDirectoryGuarded(layout.graftRoot, target, revalidate)
  }
}

function bytesDigest(target: string, maxBytes: number): Sha256Identifier | null | 'unsafe' {
  if (!lstat(target)) return null
  try { return sha256Identifier(readPlainBytes(target, maxBytes, 'transactional materialization resource')) } catch { return 'unsafe' }
}

async function movePreparedResource(
  txRoot: string,
  entry: ResourceJournal,
  maxBytes: number,
  revalidate?: RevalidateLease
): Promise<void> {
  if (entry.disposition === 'keep') {
    if (bytesDigest(entry.target, maxBytes) !== entry.after) {
      throw new LocalMaterializerError('kept materialization resource changed before publication')
    }
    return
  }
  const stage = path.join(txRoot, 'staging', entry.stageName)
  const backup = path.join(txRoot, 'backups', entry.backupName)
  let current = bytesDigest(entry.target, maxBytes)
  let staged = bytesDigest(stage, maxBytes)
  let backedUp = bytesDigest(backup, maxBytes)
  if (current === entry.after && staged === null && (entry.before === null ? backedUp === null : backedUp === entry.before)) return
  if (current === entry.before && backedUp === null && staged === entry.after) {
    assertPlainDirectory(path.dirname(entry.target), 'transactional resource parent')
    if (current !== null) await guardedRename(entry.target, backup, revalidate)
    current = bytesDigest(entry.target, maxBytes)
    backedUp = bytesDigest(backup, maxBytes)
    staged = bytesDigest(stage, maxBytes)
  }
  if (current === null && staged === entry.after && (entry.before === null ? backedUp === null : backedUp === entry.before)) {
    await guardedRename(stage, entry.target, revalidate)
    return
  }
  throw new LocalMaterializerError('transactional materialization resource changed before publication')
}

async function ensureDirectoryGuarded(
  root: string,
  target: string,
  revalidate?: RevalidateLease
): Promise<void> {
  ensurePlainPath(root, target)
  const relation = path.relative(root, target)
  let cursor = root
  for (const segment of relation.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment)
    const stat = lstat(cursor)
    if (!stat) await guardedMkdir(cursor, revalidate)
    else if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(cursor, fs.realpathSync.native(cursor))) {
      throw new LocalMaterializerStateError('transaction directory changed while recovering')
    }
  }
}

async function restoreArtifact(
  layout: LocalLayout,
  txRoot: string,
  entry: ArtifactJournal,
  artifact: MaterializationArtifactV1,
  limits: LocalMaterializerLimits,
  revalidate?: RevalidateLease
): Promise<void> {
  const target = safeTarget(layout.worktree, entry.targetRelativePath)
  if (target.pathEscaped) throw new LocalMaterializerError('materialization rollback target ancestor changed')
  const backup = path.join(txRoot, 'backups', entry.backupName)
  const stage = entry.stageName ? path.join(txRoot, 'staging', entry.stageName) : null
  const discarded = path.join(txRoot, 'discarded', entry.backupName)
  let current = currentDigest(layout.worktree, artifact, limits)
  let backedUp = artifactPathDigest(layout.worktree, backup, artifact, limits)
  const staged = stage ? artifactPathDigest(layout.worktree, stage, artifact, limits) : null
  let discardedDigest = artifactPathDigest(layout.worktree, discarded, artifact, limits)
  if (current === entry.before && backedUp === null) return
  if (entry.before === null) {
    if (backedUp !== null) throw new LocalMaterializerStateError('create rollback has an impossible backup')
    if (current === null) {
      if (discardedDigest !== null && discardedDigest !== entry.after) {
        throw new LocalMaterializerStateError('create rollback discard changed')
      }
      return
    }
    if (current !== entry.after || staged !== null || discardedDigest !== null) {
      throw new LocalMaterializerError('materialized artifact changed after publication')
    }
  } else if (current === null) {
    if (backedUp !== entry.before || discardedDigest !== null && discardedDigest !== entry.after) {
      throw new LocalMaterializerError('materialization rollback intermediate state is invalid')
    }
  } else if (current === entry.after) {
    if (backedUp !== entry.before || staged !== null || discardedDigest !== null) {
      throw new LocalMaterializerError('materialized artifact lacks its rollback proof')
    }
  } else {
    throw new LocalMaterializerError('materialized artifact changed after publication')
  }
  if (current !== null) {
    await ensureDirectoryGuarded(txRoot, path.dirname(discarded), revalidate)
    await guardedRename(target.target, discarded, revalidate)
    current = null
    discardedDigest = artifactPathDigest(layout.worktree, discarded, artifact, limits)
    if (discardedDigest !== entry.after) throw new LocalMaterializerStateError('artifact discard publication could not be proven')
  }
  if (entry.before !== null) {
    backedUp = artifactPathDigest(layout.worktree, backup, artifact, limits)
    if (backedUp !== entry.before) throw new LocalMaterializerError('materialization backup is unavailable')
    await ensureTargetParentGuarded(layout.worktree, target.target, [], revalidate)
    await guardedRename(backup, target.target, revalidate)
  }
}

async function restoreResource(
  txRoot: string,
  entry: ResourceJournal,
  maxBytes: number,
  revalidate?: RevalidateLease
): Promise<void> {
  if (entry.disposition === 'keep') {
    if (bytesDigest(entry.target, maxBytes) !== entry.before) {
      throw new LocalMaterializerStateError('kept materialization resource changed before rollback')
    }
    return
  }
  let current = bytesDigest(entry.target, maxBytes)
  const stage = path.join(txRoot, 'staging', entry.stageName)
  const backup = path.join(txRoot, 'backups', entry.backupName)
  const discarded = path.join(txRoot, 'discarded', entry.backupName)
  const staged = bytesDigest(stage, maxBytes)
  let backedUp = bytesDigest(backup, maxBytes)
  let discardedDigest = bytesDigest(discarded, maxBytes)
  if (current === entry.before && backedUp === null) return
  if (entry.before === null) {
    if (backedUp !== null) throw new LocalMaterializerStateError('resource create rollback has an impossible backup')
    if (current === null) {
      if (discardedDigest !== null && discardedDigest !== entry.after) {
        throw new LocalMaterializerStateError('resource rollback discard changed')
      }
      return
    }
    if (current !== entry.after || staged !== null || discardedDigest !== null) {
      throw new LocalMaterializerError('materialization resource changed after publication')
    }
  } else if (current === null) {
    if (backedUp !== entry.before || discardedDigest !== null && discardedDigest !== entry.after) {
      throw new LocalMaterializerError('materialization resource rollback intermediate state is invalid')
    }
  } else if (current === entry.after) {
    if (backedUp !== entry.before || staged !== null || discardedDigest !== null) {
      throw new LocalMaterializerError('materialization resource lacks its rollback proof')
    }
  } else {
    throw new LocalMaterializerError('materialization resource changed after publication')
  }
  if (current !== null) {
    await ensureDirectoryGuarded(txRoot, path.dirname(discarded), revalidate)
    await guardedRename(entry.target, discarded, revalidate)
    current = null
    discardedDigest = bytesDigest(discarded, maxBytes)
    if (discardedDigest !== entry.after) throw new LocalMaterializerStateError('resource discard publication could not be proven')
  }
  if (entry.before !== null) {
    backedUp = bytesDigest(backup, maxBytes)
    if (backedUp !== entry.before) throw new LocalMaterializerError('materialization resource backup is unavailable')
    await guardedRename(backup, entry.target, revalidate)
  }
}

function readJournal(txRoot: string, limits: LocalMaterializerLimits): LocalMaterializationJournalV1 {
  const value = parseJsonFile(path.join(txRoot, 'journal.json'), limits.maxJournalBytes, 'materialization journal')
  if (!value || typeof value !== 'object') throw new LocalMaterializerStateError('materialization recovery journal is missing')
  const journal = value as Partial<LocalMaterializationJournalV1>
  if (!exactKeys(value, [
    'schemaVersion', 'token', 'pathKey', 'worktreeId', 'planHash', 'oldMarker', 'newMarker',
    'siblingConfigDigest', 'createdParents', 'createdResourceParents', 'artifacts', 'resources'
  ])
    || journal.schemaVersion !== 1 || typeof journal.token !== 'string' || !TOKEN.test(journal.token)
    || !Array.isArray(journal.createdParents) || !Array.isArray(journal.createdResourceParents)
    || !Array.isArray(journal.artifacts) || !Array.isArray(journal.resources)
    || !verifyMaterializationMarker(journal.newMarker) || journal.oldMarker != null && !verifyMaterializationMarker(journal.oldMarker)) {
    throw new LocalMaterializerStateError('materialization recovery journal is invalid')
  }
  return journal as LocalMaterializationJournalV1
}

function assertSafeCleanupTree(root: string, limits: LocalMaterializerLimits): void {
  let entries = 0
  const visit = (target: string): void => {
    const stat = lstat(target)
    if (!stat) return
    entries += 1
    if (entries > limits.maxFiles + limits.maxArtifacts * 8) {
      throw new LocalMaterializerStateError('transaction cleanup tree exceeds its entry limit')
    }
    if (stat.isSymbolicLink() || !samePath(target, fs.realpathSync.native(target))) {
      throw new LocalMaterializerStateError('transaction cleanup tree contains a linked path')
    }
    if (stat.isFile()) {
      if (stat.nlink !== 1) throw new LocalMaterializerStateError('transaction cleanup tree contains a hard-linked file')
      return
    }
    if (!stat.isDirectory()) throw new LocalMaterializerStateError('transaction cleanup tree contains an unknown entry')
    for (const child of fs.readdirSync(target)) visit(path.join(target, child))
  }
  visit(root)
}

async function removeCleanupTree(
  target: string,
  limits: LocalMaterializerLimits,
  revalidate?: RevalidateLease
): Promise<void> {
  let entries = 0
  const visit = async (current: string): Promise<void> => {
    const stat = lstat(current)
    if (!stat) return
    entries += 1
    if (entries > limits.maxFiles + limits.maxArtifacts * 8) {
      throw new LocalMaterializerStateError('transaction cleanup tree exceeds its entry limit')
    }
    if (stat.isSymbolicLink() || !samePath(current, fs.realpathSync.native(current))) {
      throw new LocalMaterializerStateError('transaction cleanup tree contains a linked path')
    }
    if (stat.isFile()) {
      if (stat.nlink !== 1) throw new LocalMaterializerStateError('transaction cleanup tree contains a hard-linked file')
      await guardedUnlink(current, revalidate)
      return
    }
    if (!stat.isDirectory()) throw new LocalMaterializerStateError('transaction cleanup tree contains an unknown entry')
    const children = fs.readdirSync(current).sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
    for (const child of children) await visit(path.join(current, child))
    await guardedRmdir(current, revalidate)
  }
  await visit(target)
}

async function cleanupTransaction(
  layout: LocalLayout,
  inputRoot: string,
  limits: LocalMaterializerLimits,
  publishTombstone: boolean,
  afterTombstone?: () => void,
  revalidate?: RevalidateLease
): Promise<void> {
  if (!sameOrInside(layout.transactions, inputRoot) || samePath(layout.transactions, inputRoot)) {
    throw new LocalMaterializerError('transaction cleanup target is unsafe')
  }
  const inputName = path.basename(inputRoot)
  const bareToken = inputName.startsWith('.prepare-') ? inputName.slice('.prepare-'.length)
    : inputName.startsWith('.finalize-') ? inputName.slice('.finalize-'.length)
      : inputName
  if (!TOKEN.test(bareToken)) throw new LocalMaterializerError('transaction cleanup token is unsafe')
  let txRoot = inputRoot
  const stat = lstat(inputRoot)
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(inputRoot, fs.realpathSync.native(inputRoot)))) {
    throw new LocalMaterializerError('transaction cleanup target is not a plain directory')
  }
  if (!stat) return
  assertSafeCleanupTree(inputRoot, limits)
  if (publishTombstone && inputName === bareToken) {
    const tombstone = path.join(layout.transactions, `.finalize-${bareToken}`)
    if (lstat(tombstone)) throw new LocalMaterializerStateError('transaction finalize tombstone already exists')
    await guardedRename(inputRoot, tombstone, revalidate)
    txRoot = tombstone
    assertSafeCleanupTree(txRoot, limits)
    afterTombstone?.()
  }
  await removeCleanupTree(txRoot, limits, revalidate)
}

function markerArtifactMap(journal: LocalMaterializationJournalV1): Map<string, MaterializationArtifactV1> {
  const map = new Map<string, MaterializationArtifactV1>()
  for (const artifact of journal.newMarker.artifacts) map.set(artifact.targetRelativePath, artifact)
  for (const artifact of journal.oldMarker?.artifacts ?? []) if (!map.has(artifact.targetRelativePath)) map.set(artifact.targetRelativePath, artifact)
  return map
}

function exactGitPath(worktree: string, gitPath: string): string {
  const value = runGit(worktree, ['rev-parse', '--git-path', gitPath]).trim()
  if (!value) throw new LocalMaterializerLayoutError('required Git administrative path is unavailable')
  return path.resolve(worktree, value)
}

type GitConfigurationLayout = {
  commonRoot: string
  commonConfig: string
  worktreeConfig: string
  privateExclude: string
  commonInfoExclude: string
}

function gitConfigurationLayout(layout: LocalLayout): GitConfigurationLayout {
  const commonValue = runGit(layout.worktree, ['rev-parse', '--git-common-dir']).trim()
  if (!commonValue) throw new LocalMaterializerLayoutError('Git common directory is unavailable')
  const commonRoot = path.resolve(layout.worktree, commonValue)
  try { assertPlainDirectory(commonRoot, 'Git common directory') } catch {
    throw new LocalMaterializerLayoutError('Git common directory must be a plain canonical directory')
  }
  if (path.parse(commonRoot).root.toLowerCase() !== path.parse(layout.gitAdminRoot).root.toLowerCase()) {
    throw new LocalMaterializerLayoutError('Git common and worktree administrative roots must share a volume')
  }
  return {
    commonRoot,
    commonConfig: path.join(commonRoot, 'config'),
    worktreeConfig: worktreeConfigPath(layout.worktree),
    privateExclude: privateExcludePath(layout.worktree),
    commonInfoExclude: path.join(commonRoot, 'info', 'exclude')
  }
}

function legacyPrivateResourceSnapshot(
  target: string,
  maxBytes: number,
  label: string,
  knownBytes?: Buffer
): LegacyPrivateResourceSnapshotV1 {
  const stat = lstat(target)
  if (!stat) {
    const bytes = knownBytes ?? Buffer.alloc(0)
    return {
      locator: path.resolve(target),
      exists: false,
      size: bytes.length,
      contentDigest: sha256Identifier(bytes)
    }
  }
  const bytes = knownBytes ?? readStableRegularBytes(target, maxBytes, label)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== bytes.length
    || !samePath(target, fs.realpathSync.native(target))) {
    throw new LocalMaterializerLayoutError(`${label} is not a plain canonical file`)
  }
  return {
    locator: path.resolve(target),
    exists: true,
    size: bytes.length,
    contentDigest: sha256Identifier(bytes)
  }
}

function legacyBackupPrivateStateId(payload: LegacyBackupPrivatePayloadV1): Sha256Identifier {
  return domainSeparatedSha256(
    'skill-graft/legacy-backup-private-state/v1',
    canonicalJson(payload as unknown as CanonicalJsonValue)
  )
}

function observedLegacyGitFactsDigest(
  artifacts: readonly MaterializationArtifactV1[],
  facts: readonly GitVisibilityFact[],
  configuration: GitMaterializationConfigurationFact
): Sha256Identifier {
  return domainSeparatedSha256(
    LEGACY_GIT_FACTS_HASH_DOMAIN,
    canonicalLegacyGitFactsPayload(artifacts, facts, configuration)
  )
}

function legacyBackupPrivatePayload(input: {
  layout: LocalLayout
  identity: WorktreeIdentity
  baseExclude: BaseExcludeSnapshot
  createdParents: readonly string[]
  createdResourceParents: readonly ('visibility' | 'visibility-private')[]
  artifactFacts: readonly LegacyPrivateArtifactSnapshotV1[]
  gitFacts: readonly GitVisibilityFact[]
  gitConfiguration: GitMaterializationConfigurationFact
  limits: LocalMaterializerLimits
}): LegacyBackupPrivatePayloadV1 {
  const configuration = gitConfigurationLayout(input.layout)
  const gitIndex = exactGitPath(input.layout.worktree, 'index')
  const base = legacyPrivateResourceSnapshot(
    input.baseExclude.locator,
    input.limits.maxGitConfigBytes,
    'legacy base exclude',
    input.baseExclude.bytes
  )
  if (base.exists !== input.baseExclude.exists
    || base.contentDigest !== input.baseExclude.contentDigest) {
    throw new LocalMaterializerStateError('legacy base exclude changed during inspection')
  }
  return {
    schemaVersion: 1,
    pathKey: input.identity.pathKey,
    worktreeId: input.identity.worktreeId,
    createdParents: input.createdParents,
    createdResourceParents: input.createdResourceParents,
    artifacts: input.artifactFacts,
    gitFacts: input.gitFacts,
    gitConfiguration: input.gitConfiguration,
    resources: {
      gitIndex: legacyPrivateResourceSnapshot(
        gitIndex, input.limits.maxGitIndexBytes, 'legacy Git index'
      ),
      commonConfig: legacyPrivateResourceSnapshot(
        configuration.commonConfig, input.limits.maxGitConfigBytes, 'legacy Git common config'
      ),
      worktreeConfig: legacyPrivateResourceSnapshot(
        configuration.worktreeConfig, input.limits.maxGitConfigBytes, 'legacy Git worktree config'
      ),
      privateExclude: legacyPrivateResourceSnapshot(
        configuration.privateExclude, input.limits.maxGitConfigBytes, 'legacy private exclude'
      ),
      commonInfoExclude: legacyPrivateResourceSnapshot(
        configuration.commonInfoExclude, input.limits.maxGitConfigBytes, 'legacy common info exclude'
      ),
      baseExclude: {
        ...base,
        scope: input.baseExclude.scope,
        valueId: input.baseExclude.valueId
      }
    }
  }
}

function legacyIdentifierHex(value: Sha256Identifier, label: string): string {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) throw new LocalMaterializerStateError(`${label} is invalid`)
  return value.slice('sha256:'.length)
}

function legacyBackupRoot(layout: LocalLayout, migrationId: Sha256Identifier): string {
  return path.join(layout.legacyBackups, legacyIdentifierHex(migrationId, 'legacy migration identifier'))
}

function legacyPrepareBackupCleanupRoot(
  layout: LocalLayout,
  migrationId: Sha256Identifier,
  token: string
): string {
  if (!TOKEN.test(token)) throw new LocalMaterializerStateError('legacy backup cleanup token is invalid')
  return path.join(
    layout.legacyBackups,
    `.abort-${legacyIdentifierHex(migrationId, 'legacy migration identifier')}-${token}`
  )
}

function legacyBackupEnvelopeBytes(envelope: LegacyBackupEnvelopeV1): Buffer {
  return Buffer.from(`${canonicalJson(envelope as unknown as CanonicalJsonValue)}\n`, 'utf8')
}

function legacyPrivateResourceLimit(
  kind: keyof LegacyBackupPrivatePayloadV1['resources'],
  limits: LocalMaterializerLimits
): number {
  return kind === 'gitIndex' ? limits.maxGitIndexBytes : limits.maxGitConfigBytes
}

const LEGACY_PRIVATE_RESOURCE_FILES: Readonly<
  Record<keyof LegacyBackupPrivatePayloadV1['resources'], string>
> = {
  gitIndex: 'git-index.bin',
  commonConfig: 'common-config.bin',
  worktreeConfig: 'worktree-config.bin',
  privateExclude: 'private-exclude.bin',
  commonInfoExclude: 'common-info-exclude.bin',
  baseExclude: 'base-exclude.bin'
}

function validateLegacyBackupEnvelope(
  options: LocalMaterializerOptions,
  layout: LocalLayout,
  envelope: unknown,
  expected: {
    prepareToken?: string
    planHash: Sha256Identifier
    migrationId: Sha256Identifier
    backupManifestId: Sha256Identifier
    backupPrivateStateId: Sha256Identifier
    pathKey: Sha256Identifier
    worktreeId: string
    artifacts: LegacyMigrationRecordV1['artifacts']
    gitBeforeDigest: Sha256Identifier
  },
  limits: LocalMaterializerLimits
): LegacyBackupEnvelopeV1 {
  if (!envelope || typeof envelope !== 'object'
    || !exactKeys(envelope, [
      'schemaVersion', 'prepareToken', 'planHash', 'migrationId', 'backupManifestId',
      'backupPrivateStateId', 'privatePayload', 'resourceFiles'
    ])) {
    throw new LocalMaterializerStateError('legacy backup envelope shape is invalid')
  }
  const value = envelope as Partial<LegacyBackupEnvelopeV1>
  let observedPrivateStateId: Sha256Identifier
  try {
    observedPrivateStateId = legacyBackupPrivateStateId(
      value.privatePayload as LegacyBackupPrivatePayloadV1
    )
  } catch {
    throw new LocalMaterializerStateError('legacy backup private payload is not canonical')
  }
  if (value.schemaVersion !== 1
    || typeof value.prepareToken !== 'string' || !TOKEN.test(value.prepareToken)
    || expected.prepareToken !== undefined && value.prepareToken !== expected.prepareToken
    || value.planHash !== expected.planHash
    || value.migrationId !== expected.migrationId
    || value.backupManifestId !== expected.backupManifestId
    || value.backupPrivateStateId !== expected.backupPrivateStateId
    || !value.privatePayload || typeof value.privatePayload !== 'object'
    || observedPrivateStateId !== expected.backupPrivateStateId
    || !value.resourceFiles || typeof value.resourceFiles !== 'object'
    || !exactKeys(value.resourceFiles, Object.keys(LEGACY_PRIVATE_RESOURCE_FILES))) {
    throw new LocalMaterializerStateError('legacy backup envelope identity is invalid')
  }
  const computedManifestId = domainSeparatedSha256(
    LEGACY_BACKUP_MANIFEST_HASH_DOMAIN,
    canonicalLegacyBackupManifestPayload({
      pathKey: expected.pathKey,
      worktreeId: expected.worktreeId,
      artifacts: expected.artifacts,
      gitBeforeDigest: expected.gitBeforeDigest,
      backupPrivateStateId: expected.backupPrivateStateId
    })
  )
  if (computedManifestId !== expected.backupManifestId) {
    throw new LocalMaterializerStateError('legacy backup manifest identity is invalid')
  }
  const payload = value.privatePayload as LegacyBackupPrivatePayloadV1
  if (payload.schemaVersion !== 1
    || payload.pathKey !== expected.pathKey
    || payload.worktreeId !== expected.worktreeId
    || !exactKeys(payload, [
      'schemaVersion', 'pathKey', 'worktreeId', 'createdParents',
      'createdResourceParents', 'artifacts', 'gitFacts', 'gitConfiguration', 'resources'
    ])
    || !Array.isArray(payload.createdParents)
    || !Array.isArray(payload.createdResourceParents)
    || !Array.isArray(payload.artifacts) || !Array.isArray(payload.gitFacts)
    || !payload.resources || typeof payload.resources !== 'object'
    || !exactKeys(payload.resources, Object.keys(LEGACY_PRIVATE_RESOURCE_FILES))) {
    throw new LocalMaterializerStateError('legacy backup private payload is invalid')
  }
  const allowedParents = new Set(['.agents', '.agents/skills', '.codex'])
  if (new Set(payload.createdParents).size !== payload.createdParents.length
    || payload.createdParents.some((relative) => !allowedParents.has(relative))
    || new Set(payload.createdResourceParents).size !== payload.createdResourceParents.length
    || payload.createdResourceParents.some((relative) => relative !== 'visibility'
      && relative !== 'visibility-private')) {
    throw new LocalMaterializerStateError('legacy backup parent inventory is invalid')
  }
  const configuration = gitConfigurationLayout(layout)
  const expectedLocators: Partial<Record<keyof LegacyBackupPrivatePayloadV1['resources'], string>> = {
    gitIndex: exactGitPath(layout.worktree, 'index'),
    commonConfig: configuration.commonConfig,
    worktreeConfig: configuration.worktreeConfig,
    privateExclude: configuration.privateExclude,
    commonInfoExclude: configuration.commonInfoExclude
  }
  for (const kind of Object.keys(LEGACY_PRIVATE_RESOURCE_FILES) as (keyof LegacyBackupPrivatePayloadV1['resources'])[]) {
    const resource = payload.resources[kind]
    const resourceFile = (value.resourceFiles as Record<string, unknown>)[kind]
    if (!resource || typeof resource !== 'object'
      || typeof resource.locator !== 'string' || !path.isAbsolute(resource.locator)
      || typeof resource.exists !== 'boolean'
      || !Number.isSafeInteger(resource.size) || resource.size < 0
      || !/^sha256:[0-9a-f]{64}$/.test(resource.contentDigest)
      || expectedLocators[kind] && !samePath(resource.locator, expectedLocators[kind] as string)
      || resourceFile !== (resource.exists ? LEGACY_PRIVATE_RESOURCE_FILES[kind] : null)) {
      throw new LocalMaterializerStateError('legacy backup resource manifest is invalid')
    }
    if (kind === 'baseExclude') {
      const base = resource as LegacyBackupPrivatePayloadV1['resources']['baseExclude']
      if (!['unset', 'system', 'global', 'local', 'worktree'].includes(base.scope)
        || base.valueId !== baseExcludeValueId(base.scope, base.locator)) {
        throw new LocalMaterializerStateError('legacy backup base exclude identity is invalid')
      }
    }
  }
  const root = legacyBackupRoot(layout, expected.migrationId)
  const resourcesRoot = path.join(root, 'resources')
  for (const kind of Object.keys(LEGACY_PRIVATE_RESOURCE_FILES) as (keyof LegacyBackupPrivatePayloadV1['resources'])[]) {
    const resource = payload.resources[kind]
    const file = path.join(resourcesRoot, LEGACY_PRIVATE_RESOURCE_FILES[kind])
    if (!resource.exists) {
      if (lstat(file)) throw new LocalMaterializerStateError('legacy backup contains an unexpected resource')
      continue
    }
    const bytes = readPlainBytes(file, legacyPrivateResourceLimit(kind, limits), `legacy backup ${kind}`)
    if (bytes.length !== resource.size || sha256Identifier(bytes) !== resource.contentDigest) {
      throw new LocalMaterializerStateError('legacy backup resource content changed')
    }
  }
  const legacyRoot = checkedLegacySourceRoot(options, layout.worktree)
  for (const artifact of payload.artifacts) {
    if (!artifact || typeof artifact !== 'object'
      || typeof artifact.artifactId !== 'string'
      || !isPortableRelativePath(artifact.targetRelativePath)
      || artifact.legacyKind !== null && artifact.legacyKind !== 'directoryLink'
        && artifact.legacyKind !== 'fileHardlink'
      || artifact.sourceLocator !== null && (!path.isAbsolute(artifact.sourceLocator)
        || !sameOrInside(legacyRoot, artifact.sourceLocator))) {
      throw new LocalMaterializerStateError('legacy backup artifact payload is invalid')
    }
  }
  return value as LegacyBackupEnvelopeV1
}

async function publishLegacyBackupEnvelope(input: {
  options: LocalMaterializerOptions
  layout: LocalLayout
  prepareToken: string
  plan: LegacyMigrationPlanV1
  privatePayload: LegacyBackupPrivatePayloadV1
  limits: LocalMaterializerLimits
  revalidate: RevalidateLease
  checkpoint: MaterializerCheckpoint
}): Promise<{ root: string; envelope: LegacyBackupEnvelopeV1 }> {
  const { layout, plan, privatePayload, limits, revalidate, checkpoint } = input
  await ensureDirectory(layout.gitAdminRoot, layout.graftRoot, revalidate)
  await ensureDirectory(layout.graftRoot, layout.legacyBackups, revalidate)
  const root = legacyBackupRoot(layout, plan.migrationId)
  const existing = lstat(root)
  const expected = {
    prepareToken: existing ? undefined : input.prepareToken,
    planHash: plan.planHash,
    migrationId: plan.migrationId,
    backupManifestId: plan.backupManifestId,
    backupPrivateStateId: plan.backupPrivateStateId,
    pathKey: plan.pathKey,
    worktreeId: plan.worktreeId,
    artifacts: legacyMigrationRecord(plan).artifacts,
    gitBeforeDigest: plan.gitBeforeDigest
  }
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()
      || !samePath(root, fs.realpathSync.native(root))) {
      throw new LocalMaterializerStateError('legacy backup root is unsafe')
    }
    const parsed = parseJsonFile(path.join(root, 'envelope.json'), limits.maxJournalBytes, 'legacy backup envelope')
    return {
      root,
      envelope: validateLegacyBackupEnvelope(input.options, layout, parsed, expected, limits)
    }
  }
  const temporary = path.join(
    layout.legacyBackups,
    `.prepare-${legacyIdentifierHex(plan.migrationId, 'legacy migration identifier')}-${randomBytes(8).toString('hex')}`
  )
  if (lstat(temporary)) throw new LocalMaterializerStateError('legacy backup preparation root already exists')
  await guardedMkdir(temporary, revalidate)
  await ensureDirectory(temporary, path.join(temporary, 'resources'), revalidate)
  await ensureDirectory(temporary, path.join(temporary, 'artifacts'), revalidate)
  const resourceFiles = {} as Record<keyof LegacyBackupPrivatePayloadV1['resources'], string | null>
  try {
    for (const kind of Object.keys(LEGACY_PRIVATE_RESOURCE_FILES) as (keyof LegacyBackupPrivatePayloadV1['resources'])[]) {
      const resource = privatePayload.resources[kind]
      resourceFiles[kind] = resource.exists ? LEGACY_PRIVATE_RESOURCE_FILES[kind] : null
      if (!resource.exists) continue
      const bytes = readStableRegularBytes(
        resource.locator,
        legacyPrivateResourceLimit(kind, limits),
        `legacy source ${kind}`
      )
      if (bytes.length !== resource.size || sha256Identifier(bytes) !== resource.contentDigest) {
        throw new LocalMaterializerStateError('legacy backup source changed during preparation')
      }
      await writeStagedFile(
        path.join(temporary, 'resources', LEGACY_PRIVATE_RESOURCE_FILES[kind]),
        bytes,
        '100644',
        revalidate
      )
      checkpoint('legacy-materializer-after-backup-resource', { resource: kind })
      await revalidate()
    }
    const envelope: LegacyBackupEnvelopeV1 = {
      schemaVersion: 1,
      prepareToken: input.prepareToken,
      planHash: expected.planHash,
      migrationId: expected.migrationId,
      backupManifestId: expected.backupManifestId,
      backupPrivateStateId: expected.backupPrivateStateId,
      privatePayload,
      resourceFiles
    }
    await writeStagedFile(
      path.join(temporary, 'envelope.json'),
      legacyBackupEnvelopeBytes(envelope),
      '100644',
      revalidate
    )
    await revalidate()
    fsyncDirectory(temporary)
    await revalidate()
    await guardedRename(temporary, root, revalidate)
    checkpoint('legacy-materializer-after-backup-published', { resources: Object.keys(resourceFiles).length })
    await revalidate()
    const parsed = parseJsonFile(path.join(root, 'envelope.json'), limits.maxJournalBytes, 'legacy backup envelope')
    return {
      root,
      envelope: validateLegacyBackupEnvelope(input.options, layout, parsed, expected, limits)
    }
  } catch (error) {
    if (lstat(temporary)) {
      try { await removeCleanupTree(temporary, limits, revalidate) } catch (cleanupError) {
        if (isLeaseLoss(cleanupError)) throw cleanupError
      }
    }
    throw error
  }
}

function legacyMigrationMarker(
  plan: LegacyMigrationPlanV1,
  desired: DesiredMaterialization
): MaterializationMarkerV1 {
  const marker: MaterializationMarkerV1 = {
    schemaVersion: 1,
    materializationId: plan.requested.materializationId,
    planHash: plan.planHash,
    pathKey: plan.pathKey,
    worktreeId: plan.worktreeId,
    snapshotId: plan.requested.snapshotId,
    selectedSkills: [...plan.requested.selectedSkills],
    runtimeRevision: plan.requested.runtimeRevision,
    runtimeAssetId: plan.requested.runtimeAssetId,
    visibilityStateId: plan.requested.visibilityStateId,
    origin: { kind: 'legacyMigration', migrationId: plan.migrationId },
    artifacts: desired.artifacts.map(({ source: _source, files: _files, ...artifact }) => artifact)
  }
  if (!verifyMaterializationMarker(marker)) {
    throw new LocalMaterializerStateError('legacy migration marker failed frozen verification')
  }
  return marker
}

function legacyMigrationRecord(
  plan: LegacyMigrationPlanV1,
  status: 'committed' | 'rolledBack' = 'committed',
  rollbackPlanHash?: Sha256Identifier
): LegacyMigrationRecordV1 {
  const record: LegacyMigrationRecordV1 = {
    schemaVersion: 1,
    migrationId: plan.migrationId,
    planHash: plan.planHash,
    pathKey: plan.pathKey,
    worktreeId: plan.worktreeId,
    status,
    snapshotId: plan.requested.snapshotId,
    materializationId: plan.requested.materializationId,
    visibilityStateId: plan.requested.visibilityStateId,
    backupManifestId: plan.backupManifestId,
    backupPrivateStateId: plan.backupPrivateStateId,
    artifacts: plan.operations
      .filter((operation) => operation.action === 'replaceWithCopy'
        && operation.legacy !== null && operation.before?.digest !== undefined)
      .map((operation) => ({
        artifactId: operation.artifactId,
        owner: operation.owner,
        targetRelativePath: operation.targetRelativePath,
        kind: operation.kind,
        legacyKind: (operation.legacy as NonNullable<typeof operation.legacy>).legacyKind,
        sourceArtifactId: (operation.legacy as NonNullable<typeof operation.legacy>).sourceArtifactId,
        beforeDigest: (operation.before as NonNullable<typeof operation.before>).digest as Sha256Identifier,
        afterDigest: operation.after.digest
      })),
    createdArtifacts: plan.operations
      .filter((operation) => operation.action === 'create')
      .map((operation) => ({
        artifactId: operation.artifactId,
        owner: operation.owner,
        targetRelativePath: operation.targetRelativePath,
        kind: operation.kind,
        digest: operation.after.digest
      })),
    gitVisibilityDigest: plan.gitBeforeDigest,
    ...(rollbackPlanHash ? { rollbackPlanHash } : {})
  }
  if (!verifyLegacyMigrationRecordIdentity(record)) {
    throw new LocalMaterializerStateError('legacy migration record failed frozen verification')
  }
  return record
}

async function stageLegacyDesiredArtifact(input: {
  options: LocalMaterializerOptions
  worktree: string
  artifact: DesiredMaterializationArtifact
  stage: string
  limits: LocalMaterializerLimits
  counters: { files: number; bytes: number }
  revalidate: RevalidateLease
}): Promise<void> {
  const { options, worktree, artifact, stage, limits, counters, revalidate } = input
  if (artifact.kind === 'directory') await guardedMkdir(stage, revalidate)
  for (const file of artifact.files) {
    counters.files += 1
    counters.bytes += file.size
    if (counters.files > limits.maxFiles || file.size > limits.maxFileBytes
      || counters.bytes > limits.maxTotalBytes) {
      throw new LocalMaterializerError('legacy materialization staging exceeds its content limits')
    }
    const bytes = await verifiedSourceBytes(options, artifact, file)
    const target = artifact.kind === 'file' ? stage : path.join(stage, ...file.path.split('/'))
    if (artifact.kind === 'directory') {
      await ensureDirectory(stage, path.dirname(target), revalidate)
    }
    await writeStagedFile(target, bytes, file.mode, revalidate)
  }
  const observed = observePath(worktree, artifact, limits, stage)
  if (observed.unsafeDescendant || observed.digest !== artifact.digest) {
    throw new LocalMaterializerStateError('staged legacy copy failed digest verification')
  }
}

function legacyResourceLimit(resource: LegacyResourceJournalV2, limits: LocalMaterializerLimits): number {
  return resource.kind === 'gitIndex' ? limits.maxGitIndexBytes
    : resource.kind === 'marker' || resource.kind === 'visibilityState'
      ? limits.maxMarkerBytes : limits.maxGitConfigBytes
}

function legacyResourceState(
  txRoot: string,
  resource: LegacyResourceJournalV2,
  limits: LocalMaterializerLimits
): {
  current: Sha256Identifier | null | 'unsafe'
  staged: Sha256Identifier | null | 'unsafe'
  backedUp: Sha256Identifier | null | 'unsafe'
  discarded: Sha256Identifier | null | 'unsafe'
} {
  const maxBytes = legacyResourceLimit(resource, limits)
  return {
    current: bytesDigest(resource.target, maxBytes),
    staged: resource.stageName
      ? bytesDigest(path.join(txRoot, 'staging', resource.stageName), maxBytes) : null,
    backedUp: bytesDigest(path.join(txRoot, 'backups', resource.backupName), maxBytes),
    discarded: bytesDigest(path.join(txRoot, 'discarded', resource.backupName), maxBytes)
  }
}

async function moveLegacyResourceForward(
  txRoot: string,
  resource: LegacyResourceJournalV2,
  limits: LocalMaterializerLimits,
  revalidate: RevalidateLease
): Promise<void> {
  let state = legacyResourceState(txRoot, resource, limits)
  if (resource.before === resource.after && resource.stageName === null) {
    if (state.current !== resource.after || state.backedUp !== null || state.discarded !== null) {
      throw new LocalMaterializerStateError('kept legacy resource changed')
    }
    return
  }
  if (state.current === resource.after && state.staged === null
    && (resource.before === null ? state.backedUp === null : state.backedUp === resource.before)) return
  if (state.current === resource.before && state.backedUp === null) {
    if (resource.before !== null) {
      await ensureDirectory(txRoot, path.join(txRoot, 'backups'), revalidate)
      await guardedRename(resource.target, path.join(txRoot, 'backups', resource.backupName), revalidate)
      state = legacyResourceState(txRoot, resource, limits)
    }
  }
  if (resource.after === null) {
    if (state.current !== null || state.staged !== null
      || resource.before !== null && state.backedUp !== resource.before) {
      throw new LocalMaterializerStateError('legacy resource deletion is not forward recoverable')
    }
    return
  }
  if (state.current === null && state.staged === resource.after
    && (resource.before === null ? state.backedUp === null : state.backedUp === resource.before)
    && resource.stageName) {
    await guardedRename(path.join(txRoot, 'staging', resource.stageName), resource.target, revalidate)
    state = legacyResourceState(txRoot, resource, limits)
  }
  if (state.current !== resource.after || state.staged !== null
    || (resource.before === null ? state.backedUp !== null : state.backedUp !== resource.before)) {
    throw new LocalMaterializerStateError('legacy resource publication could not be proven')
  }
}

async function moveLegacyResourceBackward(
  txRoot: string,
  resource: LegacyResourceJournalV2,
  limits: LocalMaterializerLimits,
  revalidate: RevalidateLease
): Promise<void> {
  let state = legacyResourceState(txRoot, resource, limits)
  if (resource.before === resource.after && resource.stageName === null) {
    if (state.current !== resource.before) throw new LocalMaterializerStateError('kept legacy resource changed')
    return
  }
  if (state.current === resource.before && state.backedUp === null) return
  if (state.current === resource.after && resource.after !== null) {
    await ensureDirectory(txRoot, path.join(txRoot, 'discarded'), revalidate)
    await guardedRename(resource.target, path.join(txRoot, 'discarded', resource.backupName), revalidate)
    state = legacyResourceState(txRoot, resource, limits)
  }
  if (state.current === null && resource.before !== null && state.backedUp === resource.before) {
    await guardedRename(path.join(txRoot, 'backups', resource.backupName), resource.target, revalidate)
    state = legacyResourceState(txRoot, resource, limits)
  }
  if (state.current !== resource.before || state.backedUp !== null) {
    throw new LocalMaterializerStateError('legacy resource rollback could not be proven')
  }
}

async function stageLegacyResource(input: {
  resources: LegacyResourceJournalV2[]
  kind: LegacyResourceKind
  target: string
  desired: Buffer | null
  txRoot: string
  limits: LocalMaterializerLimits
  revalidate: RevalidateLease
}): Promise<void> {
  const { resources, kind, target, desired, txRoot, limits, revalidate } = input
  const maxBytes = kind === 'gitIndex' ? limits.maxGitIndexBytes
    : kind === 'marker' || kind === 'visibilityState' ? limits.maxMarkerBytes
      : limits.maxGitConfigBytes
  const before = lstat(target) ? readPlainBytes(target, maxBytes, `legacy ${kind}`) : null
  const beforeDigest = before === null ? null : sha256Identifier(before)
  const afterDigest = desired === null ? null : sha256Identifier(desired)
  const name = LEGACY_RESOURCE_NAMES[kind]
  let stagedName: string | null = null
  if (desired !== null && afterDigest !== beforeDigest) {
    stagedName = name
    await writeStagedFile(path.join(txRoot, 'staging', name), desired, '100644', revalidate)
  }
  resources.push({
    kind,
    target,
    before: beforeDigest,
    after: afterDigest,
    stageName: stagedName,
    backupName: name
  })
}

function legacyResourceBytesFromBackup(
  backupRoot: string,
  envelope: LegacyBackupEnvelopeV1,
  kind: keyof LegacyBackupPrivatePayloadV1['resources'],
  limits: LocalMaterializerLimits
): Buffer | null {
  const resource = envelope.privatePayload.resources[kind]
  if (!resource.exists) return null
  const target = path.join(backupRoot, 'resources', LEGACY_PRIVATE_RESOURCE_FILES[kind])
  const bytes = readPlainBytes(target, legacyPrivateResourceLimit(kind, limits), `legacy backup ${kind}`)
  if (bytes.length !== resource.size || sha256Identifier(bytes) !== resource.contentDigest) {
    throw new LocalMaterializerStateError('legacy backup resource changed')
  }
  return bytes
}

function legacyPrivateArtifact(
  envelope: LegacyBackupEnvelopeV1,
  artifactId: string
): LegacyPrivateArtifactSnapshotV1 {
  const found = envelope.privatePayload.artifacts.find((artifact) => artifact.artifactId === artifactId)
  if (!found) throw new LocalMaterializerStateError('legacy backup lacks an artifact proof')
  return found
}

function legacyPhysicalStateAt(
  worktree: string,
  physical: string,
  artifact: MaterializationArtifactV1,
  privateFact: LegacyPrivateArtifactSnapshotV1,
  limits: LocalMaterializerLimits
): LegacyPhysicalStateV2 | 'unsafe' {
  const stat = lstat(physical)
  if (!stat) return { kind: 'missing' }
  const linked = stat.isSymbolicLink() || stat.isFile() && stat.nlink > 1
  if (!linked) {
    const digest = artifactPathDigest(worktree, physical, artifact, limits)
    return digest === null || digest === 'unsafe' ? 'unsafe' : { kind: 'copy', digest }
  }
  if (!privateFact.legacyKind || !privateFact.sourceArtifactId || !privateFact.sourceLocator
    || !privateFact.targetDevice || !privateFact.targetInode
    || !privateFact.sourceDevice || !privateFact.sourceInode
    || !privateFact.contentDigest) return 'unsafe'
  try {
    const sourceStat = lstat(privateFact.sourceLocator)
    if (!sourceStat
      || String(stat.dev) !== privateFact.targetDevice
      || String(stat.ino) !== privateFact.targetInode
      || String(sourceStat.dev) !== privateFact.sourceDevice
      || String(sourceStat.ino) !== privateFact.sourceInode) return 'unsafe'
    if (privateFact.legacyKind === 'fileHardlink') {
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink < 2
        || !sourceStat.isFile() || sourceStat.isSymbolicLink()
        || stat.dev !== sourceStat.dev || stat.ino !== sourceStat.ino) return 'unsafe'
    } else {
      if (!stat.isSymbolicLink() || !sourceStat.isDirectory()
        || fs.readlinkSync(physical) !== privateFact.rawLinkTarget
        || !samePath(fs.realpathSync.native(physical), fs.realpathSync.native(privateFact.sourceLocator))) {
        return 'unsafe'
      }
    }
    const content = legacyArtifactContentDigest(worktree, {
      ...artifact,
      source: { kind: 'snapshot', snapshotId: ZERO_SHA, prefix: '' },
      files: []
    }, privateFact.legacyKind === 'directoryLink'
      ? fs.realpathSync.native(physical) : physical, limits)
    if (content.unsafe || content.digest !== privateFact.contentDigest) return 'unsafe'
    return {
      kind: 'legacyLink',
      legacyKind: privateFact.legacyKind,
      sourceArtifactId: privateFact.sourceArtifactId,
      sourceStateId: privateFact.sourceStateId
    }
  } catch {
    return 'unsafe'
  }
}

function sameLegacyPhysicalState(
  left: LegacyPhysicalStateV2 | 'unsafe',
  right: LegacyPhysicalStateV2
): boolean {
  return left !== 'unsafe' && equalJson(left, right)
}

function legacyArtifactLocations(
  layout: LocalLayout,
  txRoot: string,
  journal: LocalLegacyMaterializationJournalV2,
  entry: LegacyArtifactJournalV2
): { target: string; stage: string | null; backup: string | null; discarded: string } {
  const target = safeTarget(layout.worktree, entry.targetRelativePath)
  if (target.pathEscaped) throw new LocalMaterializerStateError('legacy artifact ancestor is unsafe')
  const backupRoot = legacyBackupRoot(layout, journal.migrationId)
  if (!samePath(backupRoot, journal.backupRoot)) {
    throw new LocalMaterializerStateError('legacy journal backup locator is invalid')
  }
  return {
    target: target.target,
    stage: entry.stageName ? path.join(txRoot, 'staging', entry.stageName) : null,
    backup: entry.backupName ? path.join(backupRoot, 'artifacts', entry.backupName) : null,
    discarded: path.join(txRoot, 'discarded', entry.discardName)
  }
}

function legacyArtifactStates(
  layout: LocalLayout,
  txRoot: string,
  journal: LocalLegacyMaterializationJournalV2,
  entry: LegacyArtifactJournalV2,
  artifact: MaterializationArtifactV1,
  envelope: LegacyBackupEnvelopeV1,
  limits: LocalMaterializerLimits
): {
  target: LegacyPhysicalStateV2 | 'unsafe'
  stage: LegacyPhysicalStateV2 | 'unsafe'
  backup: LegacyPhysicalStateV2 | 'unsafe'
  discarded: LegacyPhysicalStateV2 | 'unsafe'
} {
  const locations = legacyArtifactLocations(layout, txRoot, journal, entry)
  const privateFact = legacyPrivateArtifact(envelope, entry.artifactId)
  return {
    target: legacyPhysicalStateAt(layout.worktree, locations.target, artifact, privateFact, limits),
    stage: locations.stage
      ? legacyPhysicalStateAt(layout.worktree, locations.stage, artifact, privateFact, limits)
      : { kind: 'missing' },
    backup: locations.backup
      ? legacyPhysicalStateAt(layout.worktree, locations.backup, artifact, privateFact, limits)
      : { kind: 'missing' },
    discarded: legacyPhysicalStateAt(
      layout.worktree, locations.discarded, artifact, privateFact, limits
    )
  }
}

function assertLegacyRenameSameVolume(source: string, destinationParent: string): void {
  const sourceStat = lstat(source)
  const parentStat = lstat(destinationParent)
  if (!sourceStat || !parentStat?.isDirectory() || parentStat.isSymbolicLink()
    || sourceStat.dev !== parentStat.dev) {
    throw new LocalMaterializerLayoutError('legacy object move requires one filesystem volume')
  }
}

async function moveLegacyArtifactForward(input: {
  layout: LocalLayout
  txRoot: string
  journal: LocalLegacyMaterializationJournalV2
  entry: LegacyArtifactJournalV2
  artifact: MaterializationArtifactV1
  envelope: LegacyBackupEnvelopeV1
  limits: LocalMaterializerLimits
  revalidate: RevalidateLease
}): Promise<void> {
  const { layout, txRoot, journal, entry, artifact, envelope, limits, revalidate } = input
  const locations = legacyArtifactLocations(layout, txRoot, journal, entry)
  let state = legacyArtifactStates(layout, txRoot, journal, entry, artifact, envelope, limits)
  if (entry.action === 'replaceWithCopy') {
    if (sameLegacyPhysicalState(state.target, entry.after)
      && state.stage !== 'unsafe' && state.stage.kind === 'missing'
      && sameLegacyPhysicalState(state.backup, entry.before)) return
    if (sameLegacyPhysicalState(state.target, entry.before)
      && sameLegacyPhysicalState(state.stage, entry.after)
      && state.backup !== 'unsafe' && state.backup.kind === 'missing'
      && locations.backup) {
      assertLegacyRenameSameVolume(locations.target, path.dirname(locations.backup))
      await guardedRename(locations.target, locations.backup, revalidate)
      state = legacyArtifactStates(layout, txRoot, journal, entry, artifact, envelope, limits)
    }
    if (state.target !== 'unsafe' && state.target.kind === 'missing'
      && sameLegacyPhysicalState(state.stage, entry.after)
      && sameLegacyPhysicalState(state.backup, entry.before)
      && locations.stage) {
      await guardedRename(locations.stage, locations.target, revalidate)
      state = legacyArtifactStates(layout, txRoot, journal, entry, artifact, envelope, limits)
    }
  } else if (entry.action === 'create') {
    if (sameLegacyPhysicalState(state.target, entry.after)
      && state.stage !== 'unsafe' && state.stage.kind === 'missing') return
    if (state.target !== 'unsafe' && state.target.kind === 'missing'
      && sameLegacyPhysicalState(state.stage, entry.after) && locations.stage) {
      await ensureTargetParentGuarded(layout.worktree, locations.target, journal.createdParents, revalidate)
      await guardedRename(locations.stage, locations.target, revalidate)
      state = legacyArtifactStates(layout, txRoot, journal, entry, artifact, envelope, limits)
    }
  } else if (entry.action === 'restoreLink') {
    if (sameLegacyPhysicalState(state.target, entry.after)
      && state.backup !== 'unsafe' && state.backup.kind === 'missing'
      && sameLegacyPhysicalState(state.discarded, entry.before)) return
    if (sameLegacyPhysicalState(state.target, entry.before)
      && sameLegacyPhysicalState(state.backup, entry.after)
      && state.discarded !== 'unsafe' && state.discarded.kind === 'missing') {
      await ensureDirectory(txRoot, path.dirname(locations.discarded), revalidate)
      await guardedRename(locations.target, locations.discarded, revalidate)
      state = legacyArtifactStates(layout, txRoot, journal, entry, artifact, envelope, limits)
    }
    if (state.target !== 'unsafe' && state.target.kind === 'missing'
      && sameLegacyPhysicalState(state.backup, entry.after)
      && sameLegacyPhysicalState(state.discarded, entry.before)
      && locations.backup) {
      assertLegacyRenameSameVolume(locations.backup, path.dirname(locations.target))
      await guardedRename(locations.backup, locations.target, revalidate)
      state = legacyArtifactStates(layout, txRoot, journal, entry, artifact, envelope, limits)
    }
  } else {
    if (state.target !== 'unsafe' && state.target.kind === 'missing'
      && sameLegacyPhysicalState(state.discarded, entry.before)) return
    if (sameLegacyPhysicalState(state.target, entry.before)
      && state.discarded !== 'unsafe' && state.discarded.kind === 'missing') {
      await ensureDirectory(txRoot, path.dirname(locations.discarded), revalidate)
      await guardedRename(locations.target, locations.discarded, revalidate)
      state = legacyArtifactStates(layout, txRoot, journal, entry, artifact, envelope, limits)
    }
  }
  if (!sameLegacyPhysicalState(state.target, entry.after)) {
    throw new LocalMaterializerStateError('legacy artifact publication could not be proven')
  }
}

async function moveLegacyArtifactBackward(input: {
  layout: LocalLayout
  txRoot: string
  journal: LocalLegacyMaterializationJournalV2
  entry: LegacyArtifactJournalV2
  artifact: MaterializationArtifactV1
  envelope: LegacyBackupEnvelopeV1
  limits: LocalMaterializerLimits
  revalidate: RevalidateLease
}): Promise<void> {
  const { layout, txRoot, journal, entry, artifact, envelope, limits, revalidate } = input
  const locations = legacyArtifactLocations(layout, txRoot, journal, entry)
  let state = legacyArtifactStates(layout, txRoot, journal, entry, artifact, envelope, limits)
  if (entry.action === 'replaceWithCopy') {
    if (sameLegacyPhysicalState(state.target, entry.before)) return
    if (sameLegacyPhysicalState(state.target, entry.after)) {
      await ensureDirectory(txRoot, path.dirname(locations.discarded), revalidate)
      await guardedRename(locations.target, locations.discarded, revalidate)
      state = legacyArtifactStates(layout, txRoot, journal, entry, artifact, envelope, limits)
    }
    if (state.target !== 'unsafe' && state.target.kind === 'missing'
      && sameLegacyPhysicalState(state.backup, entry.before) && locations.backup) {
      await guardedRename(locations.backup, locations.target, revalidate)
      state = legacyArtifactStates(layout, txRoot, journal, entry, artifact, envelope, limits)
    }
  } else if (entry.action === 'create') {
    if (state.target !== 'unsafe' && state.target.kind === 'missing') return
    if (sameLegacyPhysicalState(state.target, entry.after)) {
      await ensureDirectory(txRoot, path.dirname(locations.discarded), revalidate)
      await guardedRename(locations.target, locations.discarded, revalidate)
      state = legacyArtifactStates(layout, txRoot, journal, entry, artifact, envelope, limits)
    }
  } else if (entry.action === 'restoreLink') {
    if (sameLegacyPhysicalState(state.target, entry.before)
      && sameLegacyPhysicalState(state.backup, entry.after)) return
    if (sameLegacyPhysicalState(state.target, entry.after)
      && state.backup !== 'unsafe' && state.backup.kind === 'missing'
      && locations.backup) {
      await guardedRename(locations.target, locations.backup, revalidate)
      state = legacyArtifactStates(layout, txRoot, journal, entry, artifact, envelope, limits)
    }
    if (state.target !== 'unsafe' && state.target.kind === 'missing'
      && sameLegacyPhysicalState(state.discarded, entry.before)) {
      await guardedRename(locations.discarded, locations.target, revalidate)
      state = legacyArtifactStates(layout, txRoot, journal, entry, artifact, envelope, limits)
    }
  } else {
    if (sameLegacyPhysicalState(state.target, entry.before)) return
    if (state.target !== 'unsafe' && state.target.kind === 'missing'
      && sameLegacyPhysicalState(state.discarded, entry.before)) {
      await guardedRename(locations.discarded, locations.target, revalidate)
      state = legacyArtifactStates(layout, txRoot, journal, entry, artifact, envelope, limits)
    }
  }
  if (!sameLegacyPhysicalState(state.target, entry.before)) {
    throw new LocalMaterializerStateError('legacy artifact rollback could not be proven')
  }
}

function legacyJournalBytes(journal: LocalLegacyMaterializationJournalV2): Buffer {
  return Buffer.from(`${canonicalJson(journal as unknown as CanonicalJsonValue)}\n`, 'utf8')
}

function legacyPrepareClaimBytes(claim: LegacyPrepareClaimV1): Buffer {
  return Buffer.from(`${canonicalJson(claim as unknown as CanonicalJsonValue)}\n`, 'utf8')
}

function readLegacyPrepareClaim(
  txRoot: string,
  limits: LocalMaterializerLimits
): LegacyPrepareClaimV1 | null {
  const target = path.join(txRoot, 'prepare.json')
  if (!lstat(target)) return null
  const value = parseJsonFile(target, limits.maxJournalBytes, 'legacy preparation claim')
  if (!value || typeof value !== 'object'
    || !exactKeys(value, [
      'schemaVersion', 'operationKind', 'token', 'pathKey', 'worktreeId',
      'planHash', 'plan', 'migrationId', 'backupManifestId',
      'backupPrivateStateId', 'dropBackupOnAbort'
    ])) {
    throw new LocalMaterializerStateError('legacy preparation claim shape is invalid')
  }
  const claim = value as Partial<LegacyPrepareClaimV1>
  const plan = claim.plan as LegacyMigrationPlanV1 | LegacyRollbackPlanV1 | undefined
  const validPlan = claim.operationKind === 'legacyMigration'
    ? !!plan && verifyLegacyMigrationPlanHash(plan as LegacyMigrationPlanV1)
    : claim.operationKind === 'legacyRollback'
      ? !!plan && verifyLegacyRollbackPlanHash(plan as LegacyRollbackPlanV1)
      : false
  if (claim.schemaVersion !== 1
    || claim.operationKind !== 'legacyMigration' && claim.operationKind !== 'legacyRollback'
    || typeof claim.token !== 'string' || !TOKEN.test(claim.token)
    || typeof claim.pathKey !== 'string' || typeof claim.worktreeId !== 'string'
    || typeof claim.planHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(claim.planHash)
    || !validPlan || !plan
    || typeof claim.migrationId !== 'string'
      || !/^sha256:[0-9a-f]{64}$/.test(claim.migrationId)
    || typeof claim.backupManifestId !== 'string'
      || !/^sha256:[0-9a-f]{64}$/.test(claim.backupManifestId)
    || typeof claim.backupPrivateStateId !== 'string'
      || !/^sha256:[0-9a-f]{64}$/.test(claim.backupPrivateStateId)
    || typeof claim.dropBackupOnAbort !== 'boolean'
    || claim.operationKind === 'legacyRollback' && claim.dropBackupOnAbort
    || claim.planHash !== plan.planHash
    || claim.pathKey !== plan.pathKey || claim.worktreeId !== plan.worktreeId
    || claim.migrationId !== plan.migrationId
    || claim.backupManifestId !== plan.backupManifestId
    || claim.backupPrivateStateId !== plan.backupPrivateStateId) {
    throw new LocalMaterializerStateError('legacy preparation claim is invalid')
  }
  return claim as LegacyPrepareClaimV1
}

function validateLegacyPrepareBackup(
  options: LocalMaterializerOptions,
  layout: LocalLayout,
  claim: LegacyPrepareClaimV1,
  limits: LocalMaterializerLimits
): LegacyBackupEnvelopeV1 {
  if (claim.operationKind !== 'legacyMigration'
    || !verifyLegacyMigrationPlanHash(claim.plan as LegacyMigrationPlanV1)) {
    throw new LocalMaterializerStateError('legacy backup cleanup claim is not a migration plan')
  }
  const plan = claim.plan as LegacyMigrationPlanV1
  const root = legacyBackupRoot(layout, claim.migrationId)
  const envelope = parseJsonFile(
    path.join(root, 'envelope.json'), limits.maxJournalBytes, 'legacy preparation backup envelope'
  )
  return validateLegacyBackupEnvelope(options, layout, envelope, {
    prepareToken: claim.token,
    planHash: claim.planHash,
    migrationId: claim.migrationId,
    backupManifestId: claim.backupManifestId,
    backupPrivateStateId: claim.backupPrivateStateId,
    pathKey: claim.pathKey,
    worktreeId: claim.worktreeId,
    artifacts: legacyMigrationRecord(plan).artifacts,
    gitBeforeDigest: plan.gitBeforeDigest
  }, limits)
}

function validateLegacyPrepareBackupCleanupState(
  options: LocalMaterializerOptions,
  layout: LocalLayout,
  claim: LegacyPrepareClaimV1,
  limits: LocalMaterializerLimits
): { root: string; tombstone: string } {
  const root = legacyBackupRoot(layout, claim.migrationId)
  const tombstone = legacyPrepareBackupCleanupRoot(layout, claim.migrationId, claim.token)
  if (lstat(root) && lstat(tombstone)) {
    throw new LocalMaterializerStateError('legacy aborted backup has competing cleanup roots')
  }
  if (lstat(root)) {
    validateLegacyPrepareBackup(options, layout, claim, limits)
    const artifactsRoot = path.join(root, 'artifacts')
    if (!lstat(artifactsRoot) || fs.readdirSync(artifactsRoot).length !== 0) {
      throw new LocalMaterializerStateError('aborted legacy backup unexpectedly owns link objects')
    }
  }
  if (lstat(tombstone)) {
    assertPlainDirectory(tombstone, 'legacy aborted backup cleanup tombstone')
    assertSafeCleanupTree(tombstone, limits)
  }
  return { root, tombstone }
}

async function cleanupLegacyPrepareBackup(
  options: LocalMaterializerOptions,
  layout: LocalLayout,
  claim: LegacyPrepareClaimV1,
  limits: LocalMaterializerLimits,
  revalidate: RevalidateLease,
  checkpoint?: MaterializerCheckpoint
): Promise<void> {
  const { root, tombstone } = validateLegacyPrepareBackupCleanupState(
    options, layout, claim, limits
  )
  if (lstat(root)) {
    await guardedRename(root, tombstone, revalidate)
    checkpoint?.('legacy-materializer-after-aborted-backup-tombstone', {
      migrationId: claim.migrationId
    })
  }
  if (!lstat(tombstone)) return
  await removeCleanupTree(tombstone, limits, revalidate)
}

function expectedLegacyResourceTargets(
  layout: LocalLayout,
  marker: MaterializationMarkerV1
): Readonly<Record<LegacyResourceKind, string>> {
  const configuration = gitConfigurationLayout(layout)
  return {
    privateExclude: configuration.privateExclude,
    worktreeConfig: configuration.worktreeConfig,
    gitIndex: exactGitPath(layout.worktree, 'index'),
    commonInfoExclude: configuration.commonInfoExclude,
    commonConfig: configuration.commonConfig,
    visibilityPrivate: visibilityPrivatePath(layout, marker.visibilityStateId),
    visibilityState: visibilityStatePath(layout, marker.visibilityStateId),
    marker: layout.marker
  }
}

function validateLegacyJournal(
  options: LocalMaterializerOptions,
  layout: LocalLayout,
  journal: LocalLegacyMaterializationJournalV2,
  envelope: LegacyBackupEnvelopeV1,
  limits: LocalMaterializerLimits
): void {
  const migration = journal.operationKind === 'legacyMigration'
  const planValid = migration
    ? verifyLegacyMigrationPlanHash(journal.plan)
    : verifyLegacyRollbackPlanHash(journal.plan)
  if (!planValid || journal.plan.planHash !== journal.planHash
    || journal.plan.pathKey !== journal.pathKey || journal.plan.worktreeId !== journal.worktreeId
    || journal.plan.migrationId !== journal.migrationId
    || journal.plan.backupManifestId !== journal.backupManifestId
    || journal.plan.backupPrivateStateId !== journal.backupPrivateStateId
    || typeof journal.dropBackupOnAbort !== 'boolean'
    || !migration && journal.dropBackupOnAbort
    || migration && journal.dropBackupOnAbort !== (envelope.prepareToken === journal.token)
    || !verifyLegacyMigrationRecordIdentity(journal.record)
    || journal.record.migrationId !== journal.migrationId
    || journal.record.pathKey !== journal.pathKey
    || journal.record.worktreeId !== journal.worktreeId
    || journal.record.backupManifestId !== journal.backupManifestId
    || journal.record.backupPrivateStateId !== journal.backupPrivateStateId
    || !samePath(journal.backupRoot, legacyBackupRoot(layout, journal.migrationId))
    || journal.siblingFactsDigest !== journal.plan.git.configuration.siblingFactsDigest
    || journal.artifacts.length > limits.maxArtifacts) {
    throw new LocalMaterializerStateError('legacy journal identity is invalid')
  }
  let marker: MaterializationMarkerV1
  if (migration) {
    const plan = journal.plan as LegacyMigrationPlanV1
    if (journal.oldMarker !== null || !verifyMaterializationMarker(journal.newMarker)
      || journal.newMarker.planHash !== plan.planHash
      || journal.newMarker.origin.kind !== 'legacyMigration'
      || journal.newMarker.origin.migrationId !== plan.migrationId
      || journal.record.status !== 'committed' || journal.record.rollbackPlanHash !== undefined
      || !equalJson(journal.record, legacyMigrationRecord(plan))) {
      throw new LocalMaterializerStateError('legacy migration journal proof is invalid')
    }
    marker = journal.newMarker
  } else {
    const plan = journal.plan as LegacyRollbackPlanV1
    if (!verifyMaterializationMarker(journal.oldMarker) || journal.newMarker !== null
      || !equalJson(journal.oldMarker, plan.current)
      || journal.record.status !== 'rolledBack'
      || journal.record.rollbackPlanHash !== plan.planHash
      || journal.record.planHash !== journal.oldMarker.planHash
      || journal.oldMarker.origin.kind !== 'legacyMigration'
      || journal.oldMarker.origin.migrationId !== journal.migrationId) {
      throw new LocalMaterializerStateError('legacy rollback journal proof is invalid')
    }
    marker = journal.oldMarker
  }
  if (envelope.planHash !== journal.record.planHash
    || envelope.migrationId !== journal.migrationId
    || envelope.backupManifestId !== journal.backupManifestId
    || envelope.backupPrivateStateId !== journal.backupPrivateStateId) {
    throw new LocalMaterializerStateError('legacy journal and backup envelope disagree')
  }
  const expectedTargets = expectedLegacyResourceTargets(layout, marker)
  if (journal.resources.length !== LEGACY_RESOURCE_KINDS.length) {
    throw new LocalMaterializerStateError('legacy resource inventory is incomplete')
  }
  for (const [index, kind] of LEGACY_RESOURCE_KINDS.entries()) {
    const resource = journal.resources[index]
    if (!resource || typeof resource !== 'object'
      || !exactKeys(resource, [
        'kind', 'target', 'before', 'after', 'stageName', 'backupName'
      ])
      || resource.kind !== kind || !samePath(resource.target, expectedTargets[kind])
      || resource.before !== null && !/^sha256:[0-9a-f]{64}$/.test(resource.before)
      || resource.after !== null && !/^sha256:[0-9a-f]{64}$/.test(resource.after)
      || resource.backupName !== LEGACY_RESOURCE_NAMES[kind]
      || resource.before === resource.after && resource.stageName !== null
      || resource.before !== resource.after && resource.after !== null
        && resource.stageName !== LEGACY_RESOURCE_NAMES[kind]
      || resource.after === null && resource.stageName !== null) {
      throw new LocalMaterializerStateError('legacy resource journal is invalid')
    }
    if (kind === 'commonConfig' && resource.before !== resource.after) {
      throw new LocalMaterializerStateError('legacy common config must be a kept exact proof')
    }
    if (migration && (kind === 'visibilityPrivate' || kind === 'visibilityState'
      || kind === 'marker') && resource.after === null) {
      throw new LocalMaterializerStateError('legacy migration commit resources must publish')
    }
    if (!migration && (kind === 'visibilityPrivate' || kind === 'visibilityState'
      || kind === 'marker') && resource.after !== null) {
      throw new LocalMaterializerStateError('legacy rollback commit resources must be absent')
    }
  }
  const common = journal.resources[LEGACY_RESOURCE_KINDS.indexOf('commonInfoExclude')]
  const commonChanged = common.before !== common.after
  const planHasCommonEffect = migration
    ? journal.plan.git.configuration.effects.includes('removeOwnedCommonInfoExcludeEntries')
    : commonChanged && journal.plan.git.configuration.effects.includes('restoreBackup')
  if (journal.commonInfoEffect !== commonChanged || commonChanged !== planHasCommonEffect) {
    throw new LocalMaterializerStateError('legacy common-info effect is not plan-bound')
  }
  const plannedOperations = journal.plan.operations.filter((operation) => operation.action !== 'keep')
  if (journal.artifacts.length !== plannedOperations.length) {
    throw new LocalMaterializerStateError('legacy artifact journal does not exactly cover the plan')
  }
  for (const [index, operation] of plannedOperations.entries()) {
    const entry = journal.artifacts[index]
    const privateFact = legacyPrivateArtifact(envelope, operation.artifactId)
    if (!entry || typeof entry !== 'object'
      || !exactKeys(entry, [
        'artifactId', 'owner', 'targetRelativePath', 'artifactKind', 'action',
        'before', 'after', 'stageName', 'backupName', 'discardName'
      ])
      || entry.artifactId !== operation.artifactId || entry.owner !== operation.owner
      || entry.targetRelativePath !== operation.targetRelativePath
      || entry.artifactKind !== operation.kind || entry.action !== operation.action
      || entry.discardName !== `artifact-${String(index).padStart(4, '0')}`) {
      throw new LocalMaterializerStateError('legacy artifact journal identity is invalid')
    }
    assertControlledTarget({
      artifactId: entry.artifactId,
      owner: entry.owner,
      targetRelativePath: entry.targetRelativePath,
      kind: entry.artifactKind,
      digest: operation.action === 'replaceWithCopy' || operation.action === 'create'
        ? (operation as LegacyMigrationPlanV1['operations'][number]).after.digest
        : (operation as LegacyRollbackPlanV1['operations'][number]).before?.digest ?? ZERO_SHA
    })
    const expectedCopy = {
      kind: 'copy' as const,
      digest: migration
        ? (operation as LegacyMigrationPlanV1['operations'][number]).after.digest
        : (operation as LegacyRollbackPlanV1['operations'][number]).before?.digest as Sha256Identifier
    }
    if (migration) {
      const migrationOperation = operation as LegacyMigrationPlanV1['operations'][number]
      const expectedBefore: LegacyPhysicalStateV2 = migrationOperation.action === 'create'
        ? { kind: 'missing' }
        : {
            kind: 'legacyLink',
            legacyKind: (migrationOperation.legacy as NonNullable<typeof migrationOperation.legacy>).legacyKind,
            sourceArtifactId: (migrationOperation.legacy as NonNullable<typeof migrationOperation.legacy>).sourceArtifactId,
            sourceStateId: privateFact.sourceStateId
          }
      if (!equalJson(entry.before, expectedBefore) || !equalJson(entry.after, expectedCopy)
        || entry.stageName !== `artifact-${String(index).padStart(4, '0')}`
        || entry.backupName !== (migrationOperation.action === 'replaceWithCopy'
          ? `artifact-${String(index).padStart(4, '0')}` : null)) {
        throw new LocalMaterializerStateError('legacy migration artifact closure is invalid')
      }
    } else {
      const rollbackOperation = operation as LegacyRollbackPlanV1['operations'][number]
      const expectedAfter: LegacyPhysicalStateV2 = rollbackOperation.action === 'deleteCreated'
        ? { kind: 'missing' }
        : {
            kind: 'legacyLink',
            legacyKind: (rollbackOperation.restore as NonNullable<typeof rollbackOperation.restore>).legacyKind,
            sourceArtifactId: (rollbackOperation.restore as NonNullable<typeof rollbackOperation.restore>).sourceArtifactId,
            sourceStateId: (rollbackOperation.restore as NonNullable<typeof rollbackOperation.restore>).sourceStateId
          }
      if (!equalJson(entry.before, expectedCopy) || !equalJson(entry.after, expectedAfter)
        || entry.stageName !== null
        || entry.backupName !== (rollbackOperation.action === 'restoreLink'
          ? `artifact-${String(index).padStart(4, '0')}` : null)) {
        throw new LocalMaterializerStateError('legacy rollback artifact closure is invalid')
      }
    }
  }
  const allowedParents = new Set(['.agents', '.agents/skills', '.codex'])
  if (new Set(journal.createdParents).size !== journal.createdParents.length
    || journal.createdParents.some((relative) => !allowedParents.has(relative))
    || new Set(journal.createdResourceParents).size !== journal.createdResourceParents.length
    || journal.createdResourceParents.some((relative) => relative !== 'visibility'
      && relative !== 'visibility-private')
    || !equalJson(journal.createdParents, envelope.privatePayload.createdParents)
    || !equalJson(
      journal.createdResourceParents, envelope.privatePayload.createdResourceParents
    )) {
    throw new LocalMaterializerStateError('legacy created parent inventory is invalid')
  }
  void options
}

function readLegacyJournal(
  options: LocalMaterializerOptions,
  layout: LocalLayout,
  txRoot: string,
  limits: LocalMaterializerLimits
): { journal: LocalLegacyMaterializationJournalV2; envelope: LegacyBackupEnvelopeV1 } {
  const value = parseJsonFile(path.join(txRoot, 'journal.json'), limits.maxJournalBytes, 'legacy materialization journal')
  if (!value || typeof value !== 'object'
    || !exactKeys(value, [
      'schemaVersion', 'operationKind', 'token', 'pathKey', 'worktreeId', 'planHash', 'plan',
      'migrationId', 'backupManifestId', 'backupPrivateStateId', 'backupRoot', 'dropBackupOnAbort',
      'oldMarker', 'newMarker', 'siblingFactsDigest', 'commonInfoEffect',
      'createdParents', 'createdResourceParents', 'artifacts', 'resources', 'record'
    ])) {
    throw new LocalMaterializerStateError('legacy materialization journal shape is invalid')
  }
  const journal = value as Partial<LocalLegacyMaterializationJournalV2>
  if (journal.schemaVersion !== 2
    || journal.operationKind !== 'legacyMigration' && journal.operationKind !== 'legacyRollback'
    || typeof journal.token !== 'string' || !TOKEN.test(journal.token)
    || typeof journal.pathKey !== 'string' || typeof journal.worktreeId !== 'string'
    || typeof journal.planHash !== 'string'
    || !journal.plan || typeof journal.plan !== 'object'
    || !journal.record || typeof journal.record !== 'object'
    || typeof journal.migrationId !== 'string'
    || typeof journal.backupManifestId !== 'string'
    || typeof journal.backupPrivateStateId !== 'string'
    || typeof journal.backupRoot !== 'string' || !path.isAbsolute(journal.backupRoot)
    || typeof journal.dropBackupOnAbort !== 'boolean'
    || typeof journal.commonInfoEffect !== 'boolean'
    || !Array.isArray(journal.createdParents) || !Array.isArray(journal.createdResourceParents)
    || !Array.isArray(journal.artifacts) || !Array.isArray(journal.resources)) {
    throw new LocalMaterializerStateError('legacy materialization journal is invalid')
  }
  const typed = journal as LocalLegacyMaterializationJournalV2
  const envelopeValue = parseJsonFile(
    path.join(legacyBackupRoot(layout, typed.migrationId), 'envelope.json'),
    limits.maxJournalBytes,
    'legacy backup envelope'
  )
  const envelope = validateLegacyBackupEnvelope(options, layout, envelopeValue, {
    planHash: typed.record.planHash,
    migrationId: typed.migrationId,
    backupManifestId: typed.backupManifestId,
    backupPrivateStateId: typed.backupPrivateStateId,
    pathKey: typed.pathKey,
    worktreeId: typed.worktreeId,
    artifacts: typed.record.artifacts,
    gitBeforeDigest: typed.record.gitVisibilityDigest
  }, limits)
  validateLegacyJournal(options, layout, typed, envelope, limits)
  return { journal: typed, envelope }
}

function readLegacyDropBackupTombstoneJournal(
  layout: LocalLayout,
  txRoot: string,
  limits: LocalMaterializerLimits
): LocalLegacyMaterializationJournalV2 {
  const value = parseJsonFile(
    path.join(txRoot, 'journal.json'), limits.maxJournalBytes,
    'legacy finalization journal'
  )
  if (!value || typeof value !== 'object'
    || !exactKeys(value, [
      'schemaVersion', 'operationKind', 'token', 'pathKey', 'worktreeId', 'planHash', 'plan',
      'migrationId', 'backupManifestId', 'backupPrivateStateId', 'backupRoot', 'dropBackupOnAbort',
      'oldMarker', 'newMarker', 'siblingFactsDigest', 'commonInfoEffect',
      'createdParents', 'createdResourceParents', 'artifacts', 'resources', 'record'
    ])) {
    throw new LocalMaterializerStateError('legacy finalization journal shape is invalid')
  }
  const journal = value as Partial<LocalLegacyMaterializationJournalV2>
  if (journal.schemaVersion !== 2 || journal.operationKind !== 'legacyMigration'
    || typeof journal.token !== 'string' || !TOKEN.test(journal.token)
    || typeof journal.pathKey !== 'string' || typeof journal.worktreeId !== 'string'
    || typeof journal.planHash !== 'string'
    || !journal.plan || typeof journal.plan !== 'object'
    || !journal.record || typeof journal.record !== 'object'
    || typeof journal.migrationId !== 'string'
    || typeof journal.backupManifestId !== 'string'
    || typeof journal.backupPrivateStateId !== 'string'
    || typeof journal.backupRoot !== 'string' || !path.isAbsolute(journal.backupRoot)
    || journal.dropBackupOnAbort !== true
    || !Array.isArray(journal.createdParents) || !Array.isArray(journal.createdResourceParents)
    || !Array.isArray(journal.artifacts) || !Array.isArray(journal.resources)) {
    throw new LocalMaterializerStateError('legacy finalization journal is invalid')
  }
  const typed = journal as LocalLegacyMaterializationJournalV2
  const plan = typed.plan as LegacyMigrationPlanV1
  if (!verifyLegacyMigrationPlanHash(plan)
    || typed.planHash !== plan.planHash
    || typed.pathKey !== plan.pathKey || typed.worktreeId !== plan.worktreeId
    || typed.migrationId !== plan.migrationId
    || typed.backupManifestId !== plan.backupManifestId
    || typed.backupPrivateStateId !== plan.backupPrivateStateId
    || !samePath(typed.backupRoot, legacyBackupRoot(layout, plan.migrationId))
    || !verifyLegacyMigrationRecordIdentity(typed.record)
    || !equalJson(typed.record, legacyMigrationRecord(plan))
    || typed.oldMarker !== null || !verifyMaterializationMarker(typed.newMarker)
    || typed.newMarker.planHash !== plan.planHash
    || typed.newMarker.pathKey !== plan.pathKey
    || typed.newMarker.worktreeId !== plan.worktreeId
    || typed.newMarker.origin.kind !== 'legacyMigration'
    || typed.newMarker.origin.migrationId !== plan.migrationId) {
    throw new LocalMaterializerStateError('legacy finalization journal identity is invalid')
  }
  return typed
}

async function assertLegacySiblingFence(
  options: LocalMaterializerOptions,
  layout: LocalLayout,
  journal: LocalLegacyMaterializationJournalV2,
  limits: LocalMaterializerLimits,
  stale: boolean
): Promise<void> {
  if (!journal.commonInfoEffect) return
  const marker = journal.oldMarker ?? journal.newMarker
  if (!marker) throw new LocalMaterializerStateError('legacy sibling fence lacks artifact closure')
  const proof = await inspectSiblingProof(
    options,
    layout,
    marker.artifacts.map((artifact) => artifact.targetRelativePath),
    limits
  )
  if (proof.siblingFactsDigest !== journal.siblingFactsDigest
    || proof.legacyCommonSiblingSafety === 'unsafe') {
    if (stale) throw new LocalLegacyPlanStaleError('legacy sibling visibility proof changed')
    throw new LocalMaterializerStateError('legacy sibling visibility proof changed during recovery')
  }
}

async function acquireLegacyGitResourceLocks(
  journal: LocalLegacyMaterializationJournalV2,
  txRoot: string,
  revalidate: RevalidateLease,
  recoverOwnStale: boolean,
  checkpoint: MaterializerCheckpoint
): Promise<() => Promise<void>> {
  const lockable = journal.resources.filter((resource) => resource.before !== resource.after
    && (resource.kind === 'gitIndex' || resource.kind === 'worktreeConfig'
      || resource.kind === 'commonInfoExclude'))
    .sort((left, right) => compareUtf8Bytes(left.target, right.target))
  const releases: (() => Promise<void>)[] = []
  try {
    for (const resource of lockable) {
      const lockRoot = path.join(txRoot, 'locks', resource.kind)
      assertPlainDirectory(path.join(lockRoot, 'staging'), 'legacy Git lock staging root')
      const lockKind: OrdinaryResourceKind = resource.kind === 'gitIndex' ? 'gitIndex' : 'worktreeConfig'
      const mapped: PublishResourceJournal = {
        disposition: 'publish',
        kind: lockKind,
        target: resource.target,
        before: resource.before,
        after: resource.after ?? ZERO_SHA,
        stageName: ORDINARY_RESOURCE_NAMES[lockKind],
        backupName: ORDINARY_RESOURCE_NAMES[lockKind]
      }
      const marker = journal.oldMarker ?? journal.newMarker
      if (!marker) throw new LocalMaterializerStateError('legacy lock journal lacks a marker identity')
      const dummy: LocalMaterializationJournalV1 = {
        schemaVersion: 1,
        token: journal.token,
        pathKey: journal.pathKey,
        worktreeId: journal.worktreeId,
        planHash: journal.planHash,
        oldMarker: null,
        newMarker: marker,
        siblingConfigDigest: ORDINARY_SIBLING_FACTS_DIGEST,
        createdParents: [],
        createdResourceParents: [],
        artifacts: [],
        resources: [mapped]
      }
      releases.push(await acquireGitResourceLocks(
        dummy, lockRoot, revalidate, recoverOwnStale,
        (step, facts) => checkpoint(step.replace('materializer-', 'legacy-materializer-'), {
          ...facts,
          legacyResource: resource.kind
        })
      ))
    }
    return async () => {
      let failure: unknown
      for (const release of [...releases].reverse()) {
        try { await release() } catch (error) {
          if (isLeaseLoss(error)) throw error
          failure ??= error
        }
      }
      if (failure) throw failure
    }
  } catch (error) {
    let leaseFailure: unknown
    for (const release of [...releases].reverse()) {
      try { await release() } catch (releaseError) {
        if (isLeaseLoss(releaseError)) leaseFailure = releaseError
      }
    }
    if (leaseFailure) throw leaseFailure
    throw error
  }
}

type LegacyProgressState = {
  initial: boolean
  published: boolean
  forward: boolean
  rolledBack: boolean
  backward: boolean
}

function legacyArtifactProgress(
  layout: LocalLayout,
  txRoot: string,
  journal: LocalLegacyMaterializationJournalV2,
  entry: LegacyArtifactJournalV2,
  artifact: MaterializationArtifactV1,
  envelope: LegacyBackupEnvelopeV1,
  limits: LocalMaterializerLimits
): LegacyProgressState {
  const state = legacyArtifactStates(layout, txRoot, journal, entry, artifact, envelope, limits)
  const missing = (value: LegacyPhysicalStateV2 | 'unsafe') => value !== 'unsafe' && value.kind === 'missing'
  let initial = false
  let intermediate = false
  let published = false
  let rollbackIntermediate = false
  let rolledBack = false
  if (entry.action === 'replaceWithCopy') {
    initial = sameLegacyPhysicalState(state.target, entry.before)
      && sameLegacyPhysicalState(state.stage, entry.after) && missing(state.backup) && missing(state.discarded)
    intermediate = missing(state.target) && sameLegacyPhysicalState(state.stage, entry.after)
      && sameLegacyPhysicalState(state.backup, entry.before) && missing(state.discarded)
    published = sameLegacyPhysicalState(state.target, entry.after) && missing(state.stage)
      && sameLegacyPhysicalState(state.backup, entry.before) && missing(state.discarded)
    rollbackIntermediate = missing(state.target) && missing(state.stage)
      && sameLegacyPhysicalState(state.backup, entry.before)
      && sameLegacyPhysicalState(state.discarded, entry.after)
    rolledBack = sameLegacyPhysicalState(state.target, entry.before) && missing(state.stage)
      && missing(state.backup) && sameLegacyPhysicalState(state.discarded, entry.after)
  } else if (entry.action === 'create') {
    initial = missing(state.target) && sameLegacyPhysicalState(state.stage, entry.after)
      && missing(state.backup) && missing(state.discarded)
    published = sameLegacyPhysicalState(state.target, entry.after) && missing(state.stage)
      && missing(state.backup) && missing(state.discarded)
    rolledBack = missing(state.target) && missing(state.stage) && missing(state.backup)
      && sameLegacyPhysicalState(state.discarded, entry.after)
  } else if (entry.action === 'restoreLink') {
    initial = sameLegacyPhysicalState(state.target, entry.before) && missing(state.stage)
      && sameLegacyPhysicalState(state.backup, entry.after) && missing(state.discarded)
    intermediate = missing(state.target) && missing(state.stage)
      && sameLegacyPhysicalState(state.backup, entry.after)
      && sameLegacyPhysicalState(state.discarded, entry.before)
    published = sameLegacyPhysicalState(state.target, entry.after) && missing(state.stage)
      && missing(state.backup) && sameLegacyPhysicalState(state.discarded, entry.before)
    rollbackIntermediate = missing(state.target) && missing(state.stage)
      && sameLegacyPhysicalState(state.backup, entry.after)
      && sameLegacyPhysicalState(state.discarded, entry.before)
    rolledBack = initial
  } else {
    initial = sameLegacyPhysicalState(state.target, entry.before) && missing(state.stage)
      && missing(state.backup) && missing(state.discarded)
    published = missing(state.target) && missing(state.stage) && missing(state.backup)
      && sameLegacyPhysicalState(state.discarded, entry.before)
    rolledBack = initial
  }
  const forward = initial || intermediate || published
  return {
    initial,
    published,
    forward,
    rolledBack,
    backward: forward || rollbackIntermediate || rolledBack
  }
}

function legacyResourceProgress(
  txRoot: string,
  resource: LegacyResourceJournalV2,
  limits: LocalMaterializerLimits
): LegacyProgressState {
  const state = legacyResourceState(txRoot, resource, limits)
  if (resource.before === resource.after && resource.stageName === null) {
    const kept = state.current === resource.after && state.backedUp === null && state.discarded === null
    return {
      initial: kept, published: kept, forward: kept, rolledBack: kept, backward: kept
    }
  }
  const stagedInitial = resource.after === null ? state.staged === null : state.staged === resource.after
  const initial = state.current === resource.before && stagedInitial
    && state.backedUp === null && state.discarded === null
  const intermediate = resource.before !== null && state.current === null
    && stagedInitial && state.backedUp === resource.before && state.discarded === null
  const published = state.current === resource.after && state.staged === null
    && (resource.before === null ? state.backedUp === null : state.backedUp === resource.before)
    && state.discarded === null
  const rollbackIntermediate = resource.after !== null && state.current === null
    && state.staged === null && state.discarded === resource.after
    && (resource.before === null ? state.backedUp === null : state.backedUp === resource.before)
  const rolledBack = state.current === resource.before && state.staged === null
    && state.backedUp === null
    && (resource.after === null ? state.discarded === null : state.discarded === resource.after)
  const forward = initial || intermediate || published
  return {
    initial,
    published,
    forward,
    rolledBack,
    backward: forward || rollbackIntermediate || rolledBack
  }
}

function legacyForwardSequence(
  layout: LocalLayout,
  txRoot: string,
  journal: LocalLegacyMaterializationJournalV2,
  envelope: LegacyBackupEnvelopeV1,
  limits: LocalMaterializerLimits
): LegacyProgressState[] {
  const marker = journal.oldMarker ?? journal.newMarker
  if (!marker) throw new LocalMaterializerStateError('legacy journal lacks artifact marker closure')
  const artifacts = new Map(marker.artifacts.map((artifact) => [artifact.artifactId, artifact]))
  const artifactState = (entry: LegacyArtifactJournalV2) => {
    const artifact = artifacts.get(entry.artifactId)
    if (!artifact) throw new LocalMaterializerStateError('legacy journal artifact is unavailable')
    return legacyArtifactProgress(layout, txRoot, journal, entry, artifact, envelope, limits)
  }
  const resourceState = (kind: LegacyResourceKind) => {
    const resource = journal.resources.find((entry) => entry.kind === kind)
    if (!resource) throw new LocalMaterializerStateError('legacy journal resource is unavailable')
    return legacyResourceProgress(txRoot, resource, limits)
  }
  if (journal.operationKind === 'legacyMigration') {
    return [
      ...journal.artifacts.filter((entry) => entry.action === 'replaceWithCopy').map(artifactState),
      ...(['privateExclude', 'worktreeConfig', 'gitIndex', 'commonInfoExclude'] as const).map(resourceState),
      ...journal.artifacts.filter((entry) => entry.action === 'create').map(artifactState),
      resourceState('visibilityPrivate'), resourceState('visibilityState'), resourceState('marker')
    ]
  }
  return [
    ...journal.artifacts.map(artifactState),
    ...(['commonInfoExclude', 'gitIndex', 'worktreeConfig', 'privateExclude'] as const).map(resourceState),
    resourceState('visibilityState'), resourceState('visibilityPrivate'), resourceState('marker')
  ]
}

function assertLegacyForwardPrefix(
  layout: LocalLayout,
  txRoot: string,
  journal: LocalLegacyMaterializationJournalV2,
  envelope: LegacyBackupEnvelopeV1,
  limits: LocalMaterializerLimits
): void {
  let reachedIncomplete = false
  for (const state of legacyForwardSequence(layout, txRoot, journal, envelope, limits)) {
    if (!state.forward) throw new LocalMaterializerStateError('legacy publication state is not recoverable')
    if (reachedIncomplete && !state.initial) {
      throw new LocalMaterializerStateError('legacy publication does not follow its visibility-safe phase order')
    }
    if (!state.published) reachedIncomplete = true
  }
}

function assertLegacyBackwardRecoverable(
  layout: LocalLayout,
  txRoot: string,
  journal: LocalLegacyMaterializationJournalV2,
  envelope: LegacyBackupEnvelopeV1,
  limits: LocalMaterializerLimits
): void {
  // Backward reconciliation walks the forward sequence in reverse. At any
  // crash cut its observable shape is therefore:
  //   published* [one intermediate]? rolledBack* initial*
  // Some actions have identical initial/rolled-back shapes, so retain every
  // possible classification instead of greedily choosing one.
  const sequence = legacyForwardSequence(layout, txRoot, journal, envelope, limits)
  const ordered = journal.operationKind === 'legacyRollback'
    ? sequence.slice(0, -1)
    : sequence
  if (journal.operationKind === 'legacyRollback') {
    const marker = sequence.at(-1)
    // Rollback publication deletes its old marker last. If that deletion
    // happened, abort/recovery intentionally keeps the marker missing until
    // every preceding effect is old again, then republishes it as final proof.
    if (!marker || !marker.initial && !marker.published) {
      throw new LocalMaterializerStateError('legacy rollback marker state is not recoverable')
    }
  }
  let phases = new Set<number>([-1])
  for (const state of ordered) {
    if (!state.backward) {
      throw new LocalMaterializerStateError('legacy rollback state is not recoverable')
    }
    const next = new Set<number>()
    for (const phase of phases) {
      if (phase <= 0 && state.published) next.add(0)
      if (phase <= 0 && state.backward) next.add(1)
      if (phase <= 2 && state.rolledBack) next.add(2)
      if (phase <= 3 && state.initial) next.add(3)
    }
    phases = next
    if (phases.size === 0) {
      throw new LocalMaterializerStateError(
        'legacy rollback does not follow its visibility-safe reverse phase order'
      )
    }
  }
}

async function publishLegacyResourceKinds(input: {
  txRoot: string
  journal: LocalLegacyMaterializationJournalV2
  kinds: readonly LegacyResourceKind[]
  limits: LocalMaterializerLimits
  revalidate: RevalidateLease
  checkpoint: MaterializerCheckpoint
}): Promise<void> {
  for (const kind of input.kinds) {
    const resource = input.journal.resources.find((entry) => entry.kind === kind)
    if (!resource) throw new LocalMaterializerStateError('legacy publication resource is unavailable')
    input.checkpoint('legacy-materializer-before-resource-publish', { resource: kind })
    await input.revalidate()
    await moveLegacyResourceForward(input.txRoot, resource, input.limits, input.revalidate)
    await input.revalidate()
  }
}

async function publishLegacyArtifactEntries(input: {
  layout: LocalLayout
  txRoot: string
  journal: LocalLegacyMaterializationJournalV2
  entries: readonly LegacyArtifactJournalV2[]
  envelope: LegacyBackupEnvelopeV1
  limits: LocalMaterializerLimits
  revalidate: RevalidateLease
  checkpoint: MaterializerCheckpoint
}): Promise<void> {
  const marker = input.journal.oldMarker ?? input.journal.newMarker
  if (!marker) throw new LocalMaterializerStateError('legacy artifact publication lacks marker closure')
  const byId = new Map(marker.artifacts.map((artifact) => [artifact.artifactId, artifact]))
  for (const entry of input.entries) {
    const artifact = byId.get(entry.artifactId)
    if (!artifact) throw new LocalMaterializerStateError('legacy publication artifact is unavailable')
    input.checkpoint('legacy-materializer-before-artifact-publish', { artifact: entry.artifactId })
    await input.revalidate()
    await moveLegacyArtifactForward({ ...input, entry, artifact })
    await input.revalidate()
  }
}

async function publishLegacyForward(input: {
  options: LocalMaterializerOptions
  layout: LocalLayout
  txRoot: string
  journal: LocalLegacyMaterializationJournalV2
  envelope: LegacyBackupEnvelopeV1
  limits: LocalMaterializerLimits
  revalidate: RevalidateLease
  checkpoint: MaterializerCheckpoint
}): Promise<void> {
  const { journal } = input
  assertLegacyForwardPrefix(input.layout, input.txRoot, journal, input.envelope, input.limits)
  await assertLegacySiblingFence(input.options, input.layout, journal, input.limits, false)
  await input.revalidate()
  if (journal.operationKind === 'legacyMigration') {
    await publishLegacyArtifactEntries({
      ...input,
      entries: journal.artifacts.filter((entry) => entry.action === 'replaceWithCopy')
    })
    input.checkpoint('legacy-materializer-after-link-replacement-phase', {
      operations: journal.artifacts.filter((entry) => entry.action === 'replaceWithCopy').length
    })
    await publishLegacyResourceKinds({
      ...input,
      kinds: ['privateExclude', 'worktreeConfig', 'gitIndex', 'commonInfoExclude']
    })
    await assertLegacySiblingFence(input.options, input.layout, journal, input.limits, false)
    input.checkpoint('legacy-materializer-after-git-publication-phase', { operations: 4 })
    await publishLegacyArtifactEntries({
      ...input,
      entries: journal.artifacts.filter((entry) => entry.action === 'create')
    })
    input.checkpoint('legacy-materializer-after-create-phase', {
      operations: journal.artifacts.filter((entry) => entry.action === 'create').length
    })
    await publishLegacyResourceKinds({ ...input, kinds: ['visibilityPrivate', 'visibilityState'] })
    input.checkpoint('legacy-materializer-after-sidecar-phase', { operations: 2 })
    await publishLegacyResourceKinds({ ...input, kinds: ['marker'] })
    input.checkpoint('legacy-materializer-after-marker-phase', { operations: 1 })
  } else {
    await publishLegacyArtifactEntries({ ...input, entries: journal.artifacts })
    input.checkpoint('legacy-materializer-after-rollback-artifact-phase', {
      operations: journal.artifacts.length
    })
    await publishLegacyResourceKinds({
      ...input,
      kinds: ['commonInfoExclude', 'gitIndex', 'worktreeConfig', 'privateExclude']
    })
    await assertLegacySiblingFence(input.options, input.layout, journal, input.limits, false)
    input.checkpoint('legacy-materializer-after-rollback-git-phase', { operations: 4 })
    await publishLegacyResourceKinds({ ...input, kinds: ['visibilityState', 'visibilityPrivate'] })
    input.checkpoint('legacy-materializer-after-rollback-sidecar-phase', { operations: 2 })
    await removeLegacyCreatedParents(input.layout, journal, input.revalidate)
    input.checkpoint('legacy-materializer-after-rollback-parent-phase', {
      operations: journal.createdParents.length + journal.createdResourceParents.length
    })
    await publishLegacyResourceKinds({ ...input, kinds: ['marker'] })
    input.checkpoint('legacy-materializer-after-rollback-marker-phase', { operations: 1 })
  }
  await input.revalidate()
}

async function rollbackLegacyArtifactEntries(input: {
  layout: LocalLayout
  txRoot: string
  journal: LocalLegacyMaterializationJournalV2
  entries: readonly LegacyArtifactJournalV2[]
  envelope: LegacyBackupEnvelopeV1
  limits: LocalMaterializerLimits
  revalidate: RevalidateLease
  checkpoint: MaterializerCheckpoint
}): Promise<void> {
  const marker = input.journal.oldMarker ?? input.journal.newMarker
  if (!marker) throw new LocalMaterializerStateError('legacy artifact rollback lacks marker closure')
  const byId = new Map(marker.artifacts.map((artifact) => [artifact.artifactId, artifact]))
  for (const entry of input.entries) {
    const artifact = byId.get(entry.artifactId)
    if (!artifact) throw new LocalMaterializerStateError('legacy rollback artifact is unavailable')
    input.checkpoint('legacy-materializer-before-artifact-rollback', { artifact: entry.artifactId })
    await input.revalidate()
    await moveLegacyArtifactBackward({ ...input, entry, artifact })
    await input.revalidate()
  }
}

async function rollbackLegacyResourceKinds(input: {
  txRoot: string
  journal: LocalLegacyMaterializationJournalV2
  kinds: readonly LegacyResourceKind[]
  limits: LocalMaterializerLimits
  revalidate: RevalidateLease
  checkpoint: MaterializerCheckpoint
}): Promise<void> {
  for (const kind of input.kinds) {
    const resource = input.journal.resources.find((entry) => entry.kind === kind)
    if (!resource) throw new LocalMaterializerStateError('legacy rollback resource is unavailable')
    input.checkpoint('legacy-materializer-before-resource-rollback', { resource: kind })
    await input.revalidate()
    await moveLegacyResourceBackward(input.txRoot, resource, input.limits, input.revalidate)
    await input.revalidate()
  }
}

function assertLegacyAtDirection(
  layout: LocalLayout,
  txRoot: string,
  journal: LocalLegacyMaterializationJournalV2,
  envelope: LegacyBackupEnvelopeV1,
  limits: LocalMaterializerLimits,
  direction: 'before' | 'after'
): void {
  const marker = journal.oldMarker ?? journal.newMarker
  if (!marker) throw new LocalMaterializerStateError('legacy proof lacks marker artifact closure')
  const byId = new Map(marker.artifacts.map((artifact) => [artifact.artifactId, artifact]))
  for (const entry of journal.artifacts) {
    const artifact = byId.get(entry.artifactId)
    if (!artifact) throw new LocalMaterializerStateError('legacy proof artifact is unavailable')
    const state = legacyArtifactStates(layout, txRoot, journal, entry, artifact, envelope, limits)
    if (!sameLegacyPhysicalState(state.target, entry[direction])) {
      throw new LocalMaterializerStateError(`legacy artifact did not reach ${direction} state`)
    }
    const expectedBackup = direction === 'after'
      ? entry.action === 'replaceWithCopy' ? entry.before
        : entry.action === 'restoreLink' ? { kind: 'missing' as const }
          : { kind: 'missing' as const }
      : entry.action === 'restoreLink' ? entry.after : { kind: 'missing' as const }
    if (!sameLegacyPhysicalState(state.backup, expectedBackup)) {
      throw new LocalMaterializerStateError(`legacy persistent artifact backup is not ${direction}-complete`)
    }
  }
  for (const resource of journal.resources) {
    const state = legacyResourceState(txRoot, resource, limits)
    if (state.current !== resource[direction]) {
      throw new LocalMaterializerStateError(`legacy resource did not reach ${direction} state`)
    }
  }
  const parentsMustExist = journal.operationKind === 'legacyMigration'
    ? direction === 'after'
    : direction === 'before'
  for (const relative of journal.createdParents) {
    const target = path.resolve(layout.worktree, ...relative.split('/'))
    const stat = lstat(target)
    if (parentsMustExist) {
      if (!stat?.isDirectory() || stat.isSymbolicLink()
        || !samePath(target, fs.realpathSync.native(target))) {
        throw new LocalMaterializerStateError(`legacy created parent did not reach ${direction} state`)
      }
    } else if (stat) {
      throw new LocalMaterializerStateError(`legacy created parent was not removed at ${direction} state`)
    }
  }
  for (const relative of journal.createdResourceParents) {
    const target = relative === 'visibility' ? layout.visibility : layout.visibilityPrivate
    const stat = lstat(target)
    if (parentsMustExist) {
      if (!stat?.isDirectory() || stat.isSymbolicLink()
        || !samePath(target, fs.realpathSync.native(target))) {
        throw new LocalMaterializerStateError(`legacy resource parent did not reach ${direction} state`)
      }
    } else if (stat) {
      throw new LocalMaterializerStateError(`legacy resource parent was not removed at ${direction} state`)
    }
  }
  const expectedMarker = direction === 'after' ? journal.newMarker : journal.oldMarker
  const actualMarker = parseJsonFile(layout.marker, limits.maxMarkerBytes, 'legacy materialization marker')
  if (expectedMarker === null) {
    if (lstat(layout.marker)) throw new LocalMaterializerStateError('legacy marker should be absent')
  } else if (!verifyMaterializationMarker(actualMarker) || !equalJson(actualMarker, expectedMarker)) {
    throw new LocalMaterializerStateError('legacy marker proof is incomplete')
  }
  if (direction === 'after' && journal.operationKind === 'legacyMigration') {
    readCurrentVisibility(layout, { pathKey: journal.pathKey, worktreeId: journal.worktreeId }, expectedMarker as MaterializationMarkerV1, limits)
  }
}

async function removeLegacyCreatedParents(
  layout: LocalLayout,
  journal: LocalLegacyMaterializationJournalV2,
  revalidate: RevalidateLease
): Promise<void> {
  for (const relative of [...journal.createdParents].sort((left, right) => right.length - left.length)) {
    const target = path.resolve(layout.worktree, ...relative.split('/'))
    const stat = lstat(target)
    if (!stat) continue
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.readdirSync(target).length !== 0) {
      throw new LocalMaterializerStateError('legacy created parent is not empty and owned')
    }
    await guardedRmdir(target, revalidate)
  }
  for (const relative of [...journal.createdResourceParents].reverse()) {
    const target = relative === 'visibility' ? layout.visibility : layout.visibilityPrivate
    const stat = lstat(target)
    if (!stat) continue
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.readdirSync(target).length !== 0) {
      throw new LocalMaterializerStateError('legacy created resource parent is not empty and owned')
    }
    await guardedRmdir(target, revalidate)
  }
}

async function rollbackLegacyJournal(input: {
  options: LocalMaterializerOptions
  layout: LocalLayout
  txRoot: string
  journal: LocalLegacyMaterializationJournalV2
  envelope: LegacyBackupEnvelopeV1
  limits: LocalMaterializerLimits
  revalidate: RevalidateLease
  checkpoint: MaterializerCheckpoint
}): Promise<void> {
  assertLegacyBackwardRecoverable(
    input.layout, input.txRoot, input.journal, input.envelope, input.limits
  )
  await assertLegacySiblingFence(input.options, input.layout, input.journal, input.limits, false)
  if (input.journal.operationKind === 'legacyMigration') {
    await rollbackLegacyResourceKinds({ ...input, kinds: ['marker'] })
    input.checkpoint('legacy-materializer-after-marker-rollback-phase', { operations: 1 })
    await rollbackLegacyResourceKinds({ ...input, kinds: ['visibilityState', 'visibilityPrivate'] })
    input.checkpoint('legacy-materializer-after-sidecar-rollback-phase', { operations: 2 })
    await rollbackLegacyArtifactEntries({
      ...input,
      entries: [...input.journal.artifacts].reverse().filter((entry) => entry.action === 'create')
    })
    await rollbackLegacyResourceKinds({
      ...input,
      kinds: ['commonInfoExclude', 'gitIndex', 'worktreeConfig', 'privateExclude']
    })
    await assertLegacySiblingFence(input.options, input.layout, input.journal, input.limits, false)
    input.checkpoint('legacy-materializer-after-git-rollback-phase', { operations: 4 })
    await rollbackLegacyArtifactEntries({
      ...input,
      entries: [...input.journal.artifacts].reverse().filter((entry) => entry.action === 'replaceWithCopy')
    })
    input.checkpoint('legacy-materializer-after-link-rollback-phase', {
      operations: input.journal.artifacts.filter((entry) => entry.action === 'replaceWithCopy').length
    })
  } else {
    const marker = input.journal.oldMarker ?? input.journal.newMarker
    if (!marker) throw new LocalMaterializerStateError('legacy rollback lacks parent marker closure')
    await publishParents(
      input.layout.worktree,
      input.journal.createdParents,
      marker.artifacts.map((artifact) => artifact.targetRelativePath),
      true,
      input.revalidate
    )
    await publishResourceParents(
      input.layout, input.journal.createdResourceParents, true, input.revalidate
    )
    input.checkpoint('legacy-materializer-after-rollback-old-parent-phase', {
      operations: input.journal.createdParents.length + input.journal.createdResourceParents.length
    })
    await rollbackLegacyResourceKinds({ ...input, kinds: ['visibilityPrivate', 'visibilityState'] })
    await rollbackLegacyResourceKinds({
      ...input,
      kinds: ['privateExclude', 'worktreeConfig', 'gitIndex', 'commonInfoExclude']
    })
    await assertLegacySiblingFence(input.options, input.layout, input.journal, input.limits, false)
    input.checkpoint('legacy-materializer-after-rollback-old-git-phase', { operations: 4 })
    await rollbackLegacyArtifactEntries({
      ...input,
      entries: [...input.journal.artifacts].reverse().filter((entry) => entry.action === 'deleteCreated')
    })
    await rollbackLegacyArtifactEntries({
      ...input,
      entries: [...input.journal.artifacts].reverse().filter((entry) => entry.action === 'restoreLink')
    })
    // When rollback publication reached its final marker deletion, durable-old
    // recovery must not republish that marker until every copy, Git fact and
    // visibility sidecar again proves the committed migration state.
    await rollbackLegacyResourceKinds({ ...input, kinds: ['marker'] })
    input.checkpoint('legacy-materializer-after-rollback-old-marker-phase', { operations: 1 })
  }
  if (input.journal.operationKind === 'legacyMigration') {
    await removeLegacyCreatedParents(input.layout, input.journal, input.revalidate)
  }
  assertLegacyAtDirection(
    input.layout, input.txRoot, input.journal, input.envelope, input.limits, 'before'
  )
}

async function cleanupLegacyTransaction(
  layout: LocalLayout,
  inputRoot: string,
  limits: LocalMaterializerLimits,
  revalidate: RevalidateLease,
  direction: 'forward' | 'backward',
  dropBackup?: Sha256Identifier,
  checkpoint?: MaterializerCheckpoint
): Promise<void> {
  if (!sameOrInside(layout.legacyTransactions, inputRoot)
    || samePath(layout.legacyTransactions, inputRoot)) {
    throw new LocalMaterializerStateError('legacy transaction cleanup target is unsafe')
  }
  const inputName = path.basename(inputRoot)
  const finalized = /^\.finalize-(forward|backward)-(.+)$/.exec(inputName)
  const bareToken = finalized ? finalized[2] : inputName
  if (!TOKEN.test(bareToken) || finalized && finalized[1] !== direction) {
    throw new LocalMaterializerStateError('legacy transaction token is unsafe')
  }
  const stat = lstat(inputRoot)
  if (!stat) return
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || !samePath(inputRoot, fs.realpathSync.native(inputRoot))) {
    throw new LocalMaterializerStateError('legacy transaction cleanup target is not a plain directory')
  }
  assertSafeCleanupTree(inputRoot, limits)
  let txRoot = inputRoot
  if (inputName === bareToken) {
    const tombstoneName = dropBackup
      ? `.finalize-drop-backup-${legacyIdentifierHex(dropBackup, 'legacy migration identifier')}-${bareToken}`
      : `.finalize-${direction}-${bareToken}`
    const tombstone = path.join(layout.legacyTransactions, tombstoneName)
    if (lstat(tombstone)) {
      throw new LocalMaterializerStateError('legacy transaction finalize tombstone already exists')
    }
    await guardedRename(inputRoot, tombstone, revalidate)
    txRoot = tombstone
    assertSafeCleanupTree(txRoot, limits)
    checkpoint?.('legacy-materializer-after-finalize-tombstone', {
      direction,
      dropBackup: dropBackup !== undefined
    })
  }
  if (dropBackup) {
    await cleanupLegacyBackupByMigrationId(layout, dropBackup, limits, revalidate)
  }
  await removeLegacyTombstoneTree(txRoot, limits, revalidate)
}

async function removeLegacyTombstoneTree(
  txRoot: string,
  limits: LocalMaterializerLimits,
  revalidate: RevalidateLease
): Promise<void> {
  const stat = lstat(txRoot)
  if (!stat) return
  assertSafeCleanupTree(txRoot, limits)
  const journal = path.join(txRoot, 'journal.json')
  const children = fs.readdirSync(txRoot)
    .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
  if (!lstat(journal)) {
    if (children.length !== 0) {
      throw new LocalMaterializerStateError(
        'legacy finalization tombstone lost its journal before cleanup completed'
      )
    }
    await guardedRmdir(txRoot, revalidate)
    return
  }
  for (const child of children) {
    if (child === 'journal.json') continue
    await removeCleanupTree(path.join(txRoot, child), limits, revalidate)
  }
  await guardedUnlink(journal, revalidate)
  await guardedRmdir(txRoot, revalidate)
}

async function cleanupLegacyBackupByMigrationId(
  layout: LocalLayout,
  migrationId: Sha256Identifier,
  limits: LocalMaterializerLimits,
  revalidate: RevalidateLease
): Promise<void> {
  const root = legacyBackupRoot(layout, migrationId)
  const artifactsRoot = path.join(root, 'artifacts')
  if (lstat(artifactsRoot) && fs.readdirSync(artifactsRoot).length !== 0) {
    throw new LocalMaterializerStateError('aborted legacy backup still owns link objects')
  }
  assertSafeCleanupTree(root, limits)
  await removeCleanupTree(root, limits, revalidate)
}

function inspectLegacyRestoreSource(
  layout: LocalLayout,
  backupRoot: string,
  artifact: LegacyMigrationRecordV1['artifacts'][number],
  privateFact: LegacyPrivateArtifactSnapshotV1,
  ordinal: number,
  limits: LocalMaterializerLimits
): LegacyRestoreSourceFactV1 {
  const target = path.join(backupRoot, 'artifacts', `artifact-${String(ordinal).padStart(4, '0')}`)
  let status: LegacyRestoreSourceFactV1['status']
  let sourceStateId: Sha256Identifier
  try {
    assertPlainDirectory(path.join(backupRoot, 'artifacts'), 'legacy backup artifact root')
    const targetStat = lstat(target)
    const sourceStat = privateFact.sourceLocator ? lstat(privateFact.sourceLocator) : null
    if (!targetStat || !sourceStat) {
      status = 'missing'
      sourceStateId = domainSeparatedSha256(
        'skill-graft/legacy-restore-source-observation/v1',
        canonicalJson({ artifactId: artifact.artifactId, status })
      )
    } else {
      const physical = legacyPhysicalStateAt(layout.worktree, target, {
        artifactId: artifact.artifactId,
        owner: artifact.owner,
        targetRelativePath: artifact.targetRelativePath,
        kind: artifact.kind,
        digest: artifact.beforeDigest
      }, privateFact, limits)
      const expected: LegacyPhysicalStateV2 = {
        kind: 'legacyLink',
        legacyKind: artifact.legacyKind,
        sourceArtifactId: artifact.sourceArtifactId,
        sourceStateId: privateFact.sourceStateId
      }
      if (sameLegacyPhysicalState(physical, expected)) {
        status = 'valid'
        sourceStateId = privateFact.sourceStateId
      } else {
        const structurallyLinked = artifact.legacyKind === 'directoryLink'
          ? targetStat.isSymbolicLink()
          : targetStat.isFile() && !targetStat.isSymbolicLink()
        status = structurallyLinked ? 'changed' : 'unsafe'
        sourceStateId = domainSeparatedSha256(
          'skill-graft/legacy-restore-source-observation/v1',
          canonicalJson({
            artifactId: artifact.artifactId,
            status,
            device: String(targetStat.dev),
            inode: String(targetStat.ino),
            links: targetStat.nlink,
            size: targetStat.size
          })
        )
      }
    }
  } catch {
    status = 'unsafe'
    sourceStateId = domainSeparatedSha256(
      'skill-graft/legacy-restore-source-observation/v1',
      canonicalJson({ artifactId: artifact.artifactId, status })
    )
  }
  return {
    artifactId: artifact.artifactId,
    targetRelativePath: artifact.targetRelativePath,
    legacyKind: artifact.legacyKind,
    sourceArtifactId: artifact.sourceArtifactId,
    sourceStateId,
    status
  }
}

function supportsWorktreeConfig(worktree: string): boolean {
  const output = runGit(worktree, ['version']).trim()
  const match = output.match(/git version ([0-9]+)\.([0-9]+)/i)
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  return major > 2 || major === 2 && minor >= 20
}

function privatePatternLines(target: string, maxBytes: number, label: string): string[] {
  if (!lstat(target)) return []
  return readPlainBytes(target, maxBytes, label).toString('utf8').split(/\r?\n/).filter(Boolean)
}

function exactManagedPattern(line: string, targets: ReadonlySet<string>): boolean {
  return line.startsWith('/') && targets.has(line.slice(1))
}

function removeOwnedCommonExcludeLines(bytes: Buffer, targets: ReadonlySet<string>): Buffer {
  const owned = new Set([...targets].map((target) => Buffer.from(`/${target}`, 'utf8').toString('hex')))
  const kept: Buffer[] = []
  let offset = 0
  while (offset < bytes.length) {
    const newline = bytes.indexOf(0x0a, offset)
    const end = newline < 0 ? bytes.length : newline + 1
    const complete = bytes.subarray(offset, end)
    let contentEnd = newline < 0 ? end : newline
    if (contentEnd > offset && bytes[contentEnd - 1] === 0x0d) contentEnd -= 1
    const content = bytes.subarray(offset, contentEnd)
    if (!owned.has(content.toString('hex'))) kept.push(complete)
    offset = end
  }
  return Buffer.concat(kept)
}

function configurationPathValueId(value: string | null): Sha256Identifier | null {
  if (!value) return null
  return gitMaterializationConfigurationValueId(
    path.isAbsolute(value) ? comparable(value) : `invalid-relative:${value}`
  )
}

function siblingWorktrees(worktree: string, limits: LocalMaterializerLimits): string[] {
  const output = runGit(worktree, ['worktree', 'list', '--porcelain', '-z'])
  if (Buffer.byteLength(output) > limits.maxGitConfigBytes) {
    throw new LocalMaterializerError('Git sibling worktree inventory exceeds its byte limit')
  }
  const result: string[] = []
  for (const record of output.split('\0\0').filter(Boolean)) {
    const field = record.split('\0').find((candidate) => candidate.startsWith('worktree '))
    if (!field) throw new LocalMaterializerError('Git worktree inventory is invalid')
    const target = path.resolve(field.slice('worktree '.length))
    if (!samePath(target, worktree)) result.push(target)
  }
  if (result.length > limits.maxSiblingWorktrees) {
    throw new LocalMaterializerError('Git sibling worktree inventory exceeds its count limit')
  }
  return result.sort(compareUtf8Bytes)
}

async function inspectSiblingProof(
  options: LocalMaterializerOptions,
  layout: LocalLayout,
  controlledTargets: readonly string[],
  limits: LocalMaterializerLimits
) {
  const facts: { siblingPathKey: Sha256Identifier; visibilityDigest: Sha256Identifier; equivalentlyHidden: boolean }[] = []
  const siblings = siblingWorktrees(layout.worktree, limits)
  if (siblings.length * controlledTargets.length > limits.maxSiblingFacts) {
    throw new LocalMaterializerError('Git sibling visibility proof exceeds its fact limit')
  }
  for (const sibling of siblings) {
    let siblingPathKey: Sha256Identifier
    try {
      siblingPathKey = (await options.identities.resolve(sibling)).pathKey
    } catch {
      siblingPathKey = domainSeparatedSha256(
        'skill-graft/local-materializer-unresolved-sibling/v1', canonicalJson(comparable(sibling))
      )
    }
    try {
      assertPlainDirectory(sibling, 'sibling Git worktree')
      const top = path.resolve(runGit(sibling, ['rev-parse', '--show-toplevel']).trim())
      if (!samePath(top, sibling)) throw new LocalMaterializerError('sibling Git worktree root is not exact')
      const visibility = controlledTargets.map((targetRelativePath) => inspectUnmanagedGit(sibling, targetRelativePath))
      facts.push({
        siblingPathKey,
        visibilityDigest: domainSeparatedSha256(
          'skill-graft/local-materializer-sibling-visibility/v1',
          canonicalJson(visibility.map((fact) => ({
            targetRelativePath: fact.targetRelativePath,
            factDigest: fact.factDigest,
            ignoreOrigin: fact.ignoreOrigin
          })) as CanonicalJsonValue)
        ),
        equivalentlyHidden: visibility.every((fact) => fact.ignored && fact.ignoreOrigin !== 'legacyCommon')
      })
    } catch {
      facts.push({
        siblingPathKey,
        visibilityDigest: domainSeparatedSha256(
          'skill-graft/local-materializer-sibling-visibility-unsafe/v1', canonicalJson(siblingPathKey)
        ),
        equivalentlyHidden: false
      })
    }
  }
  const proof = createGitMaterializationSiblingProof(facts)
  if (!proof.ok) throw new LocalMaterializerError(proof.message)
  return proof.proof
}

async function inspectGitConfiguration(
  options: LocalMaterializerOptions,
  layout: LocalLayout,
  controlledTargets: readonly string[],
  baseExclude: BaseExcludeSnapshot,
  desiredPrivateExclude: Buffer,
  desiredExcludesFileValueId: Sha256Identifier | null,
  limits: LocalMaterializerLimits,
  mode: 'ordinary' | 'legacy' = 'ordinary',
  requireSiblingProof = false
): Promise<GitMaterializationConfigurationFact> {
  const configuration = gitConfigurationLayout(layout)
  const packageLayout = checkedPackageRoot(options, layout.worktree)
  const worktreeConfigEnabled = configBoolean(configuration.commonConfig, 'extensions.worktreeConfig') === true
  const hooks = configValue(configuration.worktreeConfig, 'core.hooksPath')
  const overlay = configValue(configuration.worktreeConfig, 'ozdqp.localOverlaySource')
  const watchWorkspace = configValue(configuration.worktreeConfig, 'ozdqp.skillWatchWorkspace')
  const excludes = configValue(configuration.worktreeConfig, 'core.excludesFile')
  const controlled = new Set(controlledTargets)
  const commonBytes = lstat(configuration.commonInfoExclude)
    ? readPlainBytes(configuration.commonInfoExclude, limits.maxGitConfigBytes, 'Git common info exclude')
    : Buffer.from('', 'utf8')
  const cleanCommonBytes = removeOwnedCommonExcludeLines(commonBytes, controlled)
  const privateBytes = lstat(configuration.privateExclude)
    ? readPlainBytes(configuration.privateExclude, limits.maxGitConfigBytes, 'private worktree excludes')
    : Buffer.alloc(0)
  const commonInfoExcludeClean = commonBytes.equals(cleanCommonBytes)
  const emptySiblingProof = createGitMaterializationSiblingProof([])
  if (!emptySiblingProof.ok) throw new LocalMaterializerError(emptySiblingProof.message)
  const siblingProof = mode === 'legacy' && (!commonInfoExcludeClean || requireSiblingProof)
    ? await inspectSiblingProof(options, layout, controlledTargets, limits)
    : emptySiblingProof.proof
  return createGitMaterializationConfigurationFact({
    isLinkedWorktree: !samePath(layout.gitAdminRoot, configuration.commonRoot),
    supportsWorktreeConfig: supportsWorktreeConfig(layout.worktree),
    worktreeConfigEnabled,
    hooksPathValueId: configurationPathValueId(hooks),
    desiredHooksPathValueId: gitMaterializationConfigurationValueId(comparable(packageLayout.hooksPath)),
    overlaySourceValueId: configurationPathValueId(overlay),
    desiredOverlaySourceValueId: gitMaterializationConfigurationValueId(comparable(packageLayout.packageRoot)),
    watchWorkspaceValueId: configurationPathValueId(watchWorkspace),
    desiredWatchWorkspaceValueId: gitMaterializationConfigurationValueId(comparable(packageLayout.dataRoot)),
    excludesFileValueId: configurationPathValueId(excludes),
    desiredExcludesFileValueId,
    baseExcludeSafe: baseExclude.safe,
    baseExcludeValueId: baseExclude.valueId,
    baseExcludeContentDigest: baseExclude.contentDigest,
    privateExcludeContentDigest: sha256Identifier(privateBytes),
    desiredPrivateExcludeContentDigest: sha256Identifier(desiredPrivateExclude),
    commonInfoExcludeDigest: sha256Identifier(commonBytes),
    cleanCommonInfoExcludeDigest: sha256Identifier(cleanCommonBytes),
    // Ordinary materialization never mutates common Git resources. Its frozen
    // sentinel remains unchanged. Explicit legacy migration enumerates siblings
    // only when it owns exact common-info/exclude lines that must be removed.
    legacyCommonSiblingSafety: mode === 'ordinary'
      ? 'unsafe'
      : siblingProof.legacyCommonSiblingSafety,
    siblingFactsDigest: mode === 'ordinary'
      ? ORDINARY_SIBLING_FACTS_DIGEST
      : siblingProof.siblingFactsDigest
  })
}

function checkedPackageRoot(options: LocalMaterializerOptions, worktree: string): {
  packageRoot: string
  hooksPath: string
  dataRoot: string
} {
  if (!path.isAbsolute(options.packageRoot)) throw new LocalMaterializerLayoutError('package root must be absolute')
  const packageRoot = path.resolve(options.packageRoot)
  try { assertPlainDirectory(packageRoot, 'package root') } catch {
    throw new LocalMaterializerLayoutError('package root must be a plain canonical directory')
  }
  if (sameOrInside(worktree, packageRoot)) throw new LocalMaterializerLayoutError('package root must be outside the worktree')
  const hooksPath = path.join(packageRoot, 'overlay', 'hooks')
  try { assertPlainDirectory(hooksPath, 'installed hooks directory') } catch {
    throw new LocalMaterializerLayoutError('installed package hooks are missing or unsafe')
  }
  if (!path.isAbsolute(options.dataRoot)) throw new LocalMaterializerLayoutError('data root must be absolute')
  const dataRoot = path.resolve(options.dataRoot)
  try { assertPlainDirectory(dataRoot, 'data root') } catch {
    throw new LocalMaterializerLayoutError('data root must be a plain canonical directory')
  }
  if (sameOrInside(worktree, dataRoot)) throw new LocalMaterializerLayoutError('data root must be outside the worktree')
  return { packageRoot, hooksPath, dataRoot }
}

function configValue(config: string, key: string): string | null {
  if (!lstat(config)) return null
  readPlainBytes(config, DEFAULT_LIMITS.maxGitConfigBytes, 'Git configuration')
  const value = runGit(path.dirname(config), ['config', '--file', config, '--get', key], { allowOne: true }).trim()
  return value || null
}

function configBoolean(config: string, key: string): boolean | null {
  if (!lstat(config)) return null
  readPlainBytes(config, DEFAULT_LIMITS.maxGitConfigBytes, 'Git configuration')
  const value = runGit(path.dirname(config), ['config', '--file', config, '--bool', '--get', key], { allowOne: true }).trim()
  if (!value) return null
  if (value === 'true') return true
  if (value === 'false') return false
  throw new LocalMaterializerError('Git boolean configuration is invalid')
}

async function copyOrCreateStage(
  target: string,
  stage: string,
  maxBytes: number,
  label: string,
  revalidate?: RevalidateLease
): Promise<Buffer | null> {
  const before = lstat(target) ? readPlainBytes(target, maxBytes, label) : null
  if (before !== null) await writeStagedFile(stage, before, '100644', revalidate)
  else await writeStagedFile(stage, Buffer.from('', 'utf8'), '100644', revalidate)
  return before
}

async function setStagedConfig(
  worktree: string,
  stage: string,
  key: string,
  value: string,
  revalidate?: RevalidateLease
): Promise<void> {
  await revalidate?.()
  runGit(worktree, ['config', '--file', stage, '--replace-all', key, value])
  await revalidate?.()
}

async function unsetStagedConfig(
  worktree: string,
  stage: string,
  key: string,
  revalidate?: RevalidateLease
): Promise<void> {
  if (configValue(stage, key) !== null) {
    await revalidate?.()
    runGit(worktree, ['config', '--file', stage, '--unset-all', key])
    await revalidate?.()
  }
}

async function addResourceIfChanged(
  resources: ResourceJournal[],
  kind: OrdinaryResourceKind,
  target: string,
  stage: string,
  before: Buffer | null,
  maxBytes: number,
  revalidate?: RevalidateLease
): Promise<void> {
  await guardedFsyncFile(stage, revalidate)
  const after = readPlainBytes(stage, maxBytes, `staged ${kind}`)
  const beforeDigest = before !== null ? sha256Identifier(before) : null
  const afterDigest = sha256Identifier(after)
  if (beforeDigest === afterDigest) {
    await guardedUnlink(stage, revalidate)
    resources.push({
      disposition: 'keep', kind, target,
      before: beforeDigest, after: beforeDigest, stageName: null, backupName: null
    })
    return
  }
  const name = ORDINARY_RESOURCE_NAMES[kind]
  resources.push({
    disposition: 'publish', kind, target,
    before: beforeDigest, after: afterDigest, stageName: name, backupName: name
  })
}

function addKeptResource(
  resources: ResourceJournal[],
  kind: OrdinaryResourceKind,
  target: string,
  current: Buffer | null
): void {
  const currentDigest = current === null ? null : sha256Identifier(current)
  resources.push({
    disposition: 'keep', kind, target,
    before: currentDigest, after: currentDigest, stageName: null, backupName: null
  })
}

async function addImmutableResource(
  resources: ResourceJournal[],
  kind: 'visibilityPrivate' | 'visibilityState',
  target: string,
  stage: string,
  bytes: Buffer,
  maxBytes: number,
  revalidate?: RevalidateLease
): Promise<void> {
  const existing = lstat(target) ? readPlainBytes(target, maxBytes, kind) : null
  if (existing && !existing.equals(bytes)) {
    throw new LocalMaterializerStateError('content-addressed visibility sidecar changed')
  }
  await writeStagedFile(stage, bytes, '100644', revalidate)
  if (existing) {
    await guardedUnlink(stage, revalidate)
    addKeptResource(resources, kind, target, existing)
    return
  }
  const name = ORDINARY_RESOURCE_NAMES[kind]
  resources.push({
    disposition: 'publish',
    kind,
    target,
    before: null,
    after: sha256Identifier(bytes),
    stageName: name,
    backupName: name
  })
}

function assertWorktreeConfigEnabled(configuration: GitConfigurationLayout): void {
  const enabled = configBoolean(configuration.commonConfig, 'extensions.worktreeConfig') === true
  if (enabled) return
  throw new LocalMaterializerLayoutError('Git extensions.worktreeConfig must be enabled by explicit repository setup')
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareUtf8Bytes)
  const wanted = [...expected].sort(compareUtf8Bytes)
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function baseExcludeValueId(scope: VisibilityBaseExcludeScope, locator: string): Sha256Identifier | null {
  return scope === 'unset' ? null : gitMaterializationConfigurationValueId(`${scope}:${comparable(locator)}`)
}

function defaultGlobalExcludeLocator(): { locator: string; safe: boolean } {
  const xdg = process.env.XDG_CONFIG_HOME
  if (xdg) {
    return path.isAbsolute(xdg)
      ? { locator: path.join(path.resolve(xdg), 'git', 'ignore'), safe: true }
      : { locator: path.resolve(xdg, 'git', 'ignore'), safe: false }
  }
  const home = os.homedir()
  return path.isAbsolute(home)
    ? { locator: path.join(path.resolve(home), '.config', 'git', 'ignore'), safe: true }
    : { locator: path.resolve(home, '.config', 'git', 'ignore'), safe: false }
}

function readBaseExcludeLocator(
  layout: LocalLayout,
  scope: VisibilityBaseExcludeScope,
  locatorInput: string,
  expectedExists: boolean | null,
  limits: LocalMaterializerLimits
): BaseExcludeSnapshot {
  const locator = path.resolve(locatorInput)
  let safe = path.isAbsolute(locatorInput) && !sameOrInside(layout.graftRoot, locator)
  const stat = lstat(locator)
  const exists = stat !== null
  let bytes: Buffer = Buffer.alloc(0)
  if (expectedExists !== null && exists !== expectedExists) safe = false
  if (stat) {
    try {
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
        || !samePath(locator, fs.realpathSync.native(locator))) safe = false
      else {
        bytes = readPlainBytes(locator, limits.maxGitConfigBytes, 'base core.excludesFile')
        if (containsReservedPrivateExcludeLine(bytes)) safe = false
      }
    } catch { safe = false }
  } else {
    let cursor = path.dirname(locator)
    while (!lstat(cursor) && path.dirname(cursor) !== cursor) cursor = path.dirname(cursor)
    const ancestor = lstat(cursor)
    try {
      if (!ancestor?.isDirectory() || ancestor.isSymbolicLink()
        || !samePath(cursor, fs.realpathSync.native(cursor))) safe = false
    } catch { safe = false }
  }
  return {
    scope,
    valueId: baseExcludeValueId(scope, locator),
    contentDigest: sha256Identifier(bytes),
    locator,
    exists,
    bytes,
    safe
  }
}

function inspectFreshBaseExclude(
  layout: LocalLayout,
  configuration: GitConfigurationLayout,
  limits: LocalMaterializerLimits
): BaseExcludeSnapshot {
  const output = runGit(layout.worktree, [
    'config', '--show-scope', '--null', '--path', '--get', 'core.excludesFile'
  ], { allowOne: true })
  if (!output) {
    const fallback = defaultGlobalExcludeLocator()
    const snapshot = readBaseExcludeLocator(layout, 'unset', fallback.locator, null, limits)
    return { ...snapshot, safe: snapshot.safe && fallback.safe }
  }
  const fields = output.split('\0')
  if (fields.at(-1) === '') fields.pop()
  const scope = fields[0] as VisibilityBaseExcludeScope
  const locator = fields[1]
  if (fields.length !== 2 || !['system', 'global', 'local', 'worktree'].includes(scope)
    || !locator || !path.isAbsolute(locator) || samePath(locator, configuration.privateExclude)) {
    const safeScope: VisibilityBaseExcludeScope = ['system', 'global', 'local', 'worktree'].includes(scope)
      ? scope : 'unset'
    const resolved = locator ? path.resolve(locator) : defaultGlobalExcludeLocator().locator
    return {
      scope: safeScope,
      valueId: baseExcludeValueId(safeScope, resolved),
      contentDigest: sha256Identifier(Buffer.alloc(0)),
      locator: resolved,
      exists: false,
      bytes: Buffer.alloc(0),
      safe: false
    }
  }
  return readBaseExcludeLocator(layout, scope, locator, null, limits)
}

function inspectOwnedUnderlyingBaseExclude(
  layout: LocalLayout,
  historical: VisibilityPrivateEnvelopeV1['baseExclude'],
  limits: LocalMaterializerLimits
): BaseExcludeSnapshot {
  if (historical.scope === 'worktree') {
    return readBaseExcludeLocator(layout, 'worktree', historical.locator, null, limits)
  }
  for (const scope of ['local', 'global', 'system'] as const) {
    const locator = runGit(layout.worktree, [
      'config', `--${scope}`, '--path', '--get', 'core.excludesFile'
    ], { allowOne: true }).trim()
    if (locator) {
      if (!path.isAbsolute(locator)) {
        const resolved = path.resolve(locator)
        return {
          scope,
          valueId: baseExcludeValueId(scope, resolved),
          contentDigest: sha256Identifier(Buffer.alloc(0)),
          locator: resolved,
          exists: false,
          bytes: Buffer.alloc(0),
          safe: false
        }
      }
      return readBaseExcludeLocator(layout, scope, locator, null, limits)
    }
  }
  const fallback = defaultGlobalExcludeLocator()
  const snapshot = readBaseExcludeLocator(layout, 'unset', fallback.locator, null, limits)
  return { ...snapshot, safe: snapshot.safe && fallback.safe }
}

function visibilityStateBytes(state: VisibilityOwnershipStateV1): Buffer {
  return Buffer.from(`${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

function visibilityPrivateBytes(envelope: VisibilityPrivateEnvelopeV1): Buffer {
  return Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, 'utf8')
}

function visibilityPrivatePayload(
  identity: WorktreeIdentity,
  base: BaseExcludeSnapshot
): VisibilityPrivatePayloadV1 {
  return {
    schemaVersion: 1,
    pathKey: identity.pathKey,
    worktreeId: identity.worktreeId,
    baseExclude: {
      scope: base.scope,
      valueId: base.valueId,
      contentDigest: base.contentDigest,
      locator: base.locator,
      exists: base.exists
    }
  }
}

function visibilityPrivateStateId(payload: VisibilityPrivatePayloadV1): Sha256Identifier {
  return domainSeparatedSha256(
    'skill-graft/visibility-private-state/v1',
    canonicalJson(payload as unknown as CanonicalJsonValue)
  )
}

function visibilityPrivateEnvelope(
  identity: WorktreeIdentity,
  state: VisibilityOwnershipStateV1,
  base: BaseExcludeSnapshot
): VisibilityPrivateEnvelopeV1 {
  const payload = visibilityPrivatePayload(identity, base)
  return {
    ...payload,
    visibilityStateId: state.visibilityStateId,
    privateStateId: state.privateStateId
  }
}

function readCurrentVisibility(
  layout: LocalLayout,
  identity: WorktreeIdentity,
  marker: MaterializationMarkerV1,
  limits: LocalMaterializerLimits
): { state: VisibilityOwnershipStateV1; base: BaseExcludeSnapshot } {
  const stateTarget = visibilityStatePath(layout, marker.visibilityStateId)
  const privateTarget = visibilityPrivatePath(layout, marker.visibilityStateId)
  if (!lstat(stateTarget) || !lstat(privateTarget)) {
    throw new LocalMaterializerStateError('materialization marker ownership sidecar is missing')
  }
  let stateValue: unknown
  let privateValue: unknown
  try {
    stateValue = JSON.parse(readPlainBytes(
      stateTarget, limits.maxMarkerBytes, 'visibility ownership state'
    ).toString('utf8'))
    privateValue = JSON.parse(readPlainBytes(
      privateTarget, limits.maxGitConfigBytes, 'private visibility ownership state'
    ).toString('utf8'))
  } catch {
    throw new LocalMaterializerStateError('materialization ownership sidecar is invalid')
  }
  if (!verifyVisibilityOwnershipState(stateValue)
    || stateValue.visibilityStateId !== marker.visibilityStateId
    || stateValue.pathKey !== identity.pathKey
    || stateValue.worktreeId !== identity.worktreeId
    || !privateValue || typeof privateValue !== 'object'
    || !exactKeys(privateValue, [
      'schemaVersion', 'visibilityStateId', 'privateStateId', 'pathKey', 'worktreeId', 'baseExclude'
    ])) {
    throw new LocalMaterializerStateError('materialization ownership sidecar identity is invalid')
  }
  const envelope = privateValue as Partial<VisibilityPrivateEnvelopeV1>
  const baseValue = envelope.baseExclude
  if (envelope.schemaVersion !== 1
    || envelope.visibilityStateId !== stateValue.visibilityStateId
    || envelope.privateStateId !== stateValue.privateStateId
    || envelope.pathKey !== identity.pathKey
    || envelope.worktreeId !== identity.worktreeId
    || !baseValue || typeof baseValue !== 'object'
    || !exactKeys(baseValue, ['scope', 'valueId', 'contentDigest', 'locator', 'exists'])
    || !['unset', 'system', 'global', 'local', 'worktree'].includes(baseValue.scope)
    || typeof baseValue.locator !== 'string' || !path.isAbsolute(baseValue.locator)
    || typeof baseValue.exists !== 'boolean'
    || baseValue.scope !== stateValue.baseExclude.scope
    || baseValue.valueId !== stateValue.baseExclude.valueId
    || baseValue.contentDigest !== stateValue.baseExclude.contentDigest) {
    throw new LocalMaterializerStateError('private visibility ownership sidecar is invalid')
  }
  if (baseExcludeValueId(baseValue.scope, baseValue.locator) !== baseValue.valueId) {
    throw new LocalMaterializerStateError('visibility ownership base exclude source identity is invalid')
  }
  const privatePayload = visibilityPrivatePayload(identity, {
    scope: baseValue.scope,
    valueId: baseValue.valueId,
    contentDigest: baseValue.contentDigest,
    locator: baseValue.locator,
    exists: baseValue.exists,
    bytes: Buffer.alloc(0),
    safe: false
  })
  if (visibilityPrivateStateId(privatePayload) !== envelope.privateStateId) {
    throw new LocalMaterializerStateError('private visibility ownership state hash is invalid')
  }
  if (!visibilityStateMatchesArtifacts(stateValue, marker.artifacts)) {
    throw new LocalMaterializerStateError('visibility ownership state does not match the materialization marker')
  }
  const base = inspectOwnedUnderlyingBaseExclude(layout, baseValue, limits)
  return { state: stateValue, base }
}

function composedPrivateExcludes(baseBytes: Buffer, managedPatterns: readonly string[]): Buffer {
  const managedBlock = Buffer.from(
    `${PRIVATE_EXCLUDES_BEGIN}\n${managedPatterns.join('\n')}${managedPatterns.length ? '\n' : ''}${PRIVATE_EXCLUDES_END}\n`,
    'utf8'
  )
  const prefix = baseBytes.length === 0 || baseBytes[baseBytes.length - 1] === 0x0a
    ? baseBytes : Buffer.concat([baseBytes, Buffer.from('\n', 'utf8')])
  return Buffer.concat([prefix, managedBlock])
}

function validateJournal(layout: LocalLayout, journal: LocalMaterializationJournalV1, limits: LocalMaterializerLimits): void {
  if (journal.newMarker.pathKey !== journal.pathKey || journal.newMarker.worktreeId !== journal.worktreeId
    || journal.newMarker.planHash !== journal.planHash
    || journal.oldMarker && (journal.oldMarker.pathKey !== journal.pathKey || journal.oldMarker.worktreeId !== journal.worktreeId)
    || journal.siblingConfigDigest !== ORDINARY_SIBLING_FACTS_DIGEST
    || journal.artifacts.length > limits.maxArtifacts
    || journal.createdParents.length > 3
    || journal.createdResourceParents.length > 2) {
    throw new LocalMaterializerStateError('materialization journal identity or limits are invalid')
  }
  const allowedParents = new Set(['.agents', '.agents/skills', '.codex'])
  if (new Set(journal.createdParents).size !== journal.createdParents.length
    || journal.createdParents.some((relative) => !allowedParents.has(relative))) {
    throw new LocalMaterializerStateError('materialization journal parent set is invalid')
  }
  const allowedResourceParents = new Set(['visibility', 'visibility-private'])
  if (new Set(journal.createdResourceParents).size !== journal.createdResourceParents.length
    || journal.createdResourceParents.some((relative) => !allowedResourceParents.has(relative))) {
    throw new LocalMaterializerStateError('materialization resource parent set is invalid')
  }
  const artifacts = markerArtifactMap(journal)
  const oldByPath = new Map((journal.oldMarker?.artifacts ?? []).map((artifact) => [artifact.targetRelativePath, artifact]))
  const newByPath = new Map(journal.newMarker.artifacts.map((artifact) => [artifact.targetRelativePath, artifact]))
  const expectedChanges = [...new Set([...oldByPath.keys(), ...newByPath.keys()])]
    .sort(compareUtf8Bytes)
    .filter((target) => !equalJson(oldByPath.get(target) ?? null, newByPath.get(target) ?? null))
  if (journal.artifacts.length !== expectedChanges.length) {
    throw new LocalMaterializerStateError('materialization artifact journal does not exactly cover the marker diff')
  }
  const seenTargets = new Set<string>()
  for (const [index, entry] of journal.artifacts.entries()) {
    if (!entry || typeof entry !== 'object'
      || !exactKeys(entry, [
        'artifactId', 'targetRelativePath', 'kind', 'action', 'before', 'after', 'stageName', 'backupName'
      ])) {
      throw new LocalMaterializerStateError('materialization artifact journal is invalid')
    }
    const artifact = artifacts.get(entry.targetRelativePath)
    if (!artifact) throw new LocalMaterializerStateError('materialization journal references an unknown artifact')
    assertControlledTarget(artifact)
    const oldArtifact = oldByPath.get(entry.targetRelativePath)
    const newArtifact = newByPath.get(entry.targetRelativePath)
    const expectedStage = stageName(index)
    const expectedAction = !oldArtifact ? 'create' : !newArtifact ? 'delete' : 'update'
    if (entry.targetRelativePath !== expectedChanges[index]
      || seenTargets.has(entry.targetRelativePath)
      || entry.artifactId !== artifact.artifactId
      || entry.kind !== artifact.kind
      || entry.before !== (oldArtifact?.digest ?? null)
      || entry.after !== (newArtifact?.digest ?? null)
      || entry.action !== expectedAction
      || entry.backupName !== expectedStage
      || entry.stageName !== (newArtifact ? expectedStage : null)) {
      throw new LocalMaterializerStateError('materialization artifact journal is invalid')
    }
    seenTargets.add(entry.targetRelativePath)
  }
  const expectedTargets = {
    gitIndex: exactGitPath(layout.worktree, 'index'),
    worktreeConfig: worktreeConfigPath(layout.worktree),
    privateExclude: privateExcludePath(layout.worktree),
    visibilityPrivate: visibilityPrivatePath(layout, journal.newMarker.visibilityStateId),
    visibilityState: visibilityStatePath(layout, journal.newMarker.visibilityStateId),
    marker: layout.marker
  } as const
  if (journal.resources.length !== ORDINARY_RESOURCE_KINDS.length) {
    throw new LocalMaterializerStateError('ordinary materialization resource inventory is incomplete')
  }
  for (const [index, expectedKind] of ORDINARY_RESOURCE_KINDS.entries()) {
    const resource = journal.resources[index]
    if (!resource || typeof resource !== 'object'
      || !exactKeys(resource, [
        'disposition', 'kind', 'target', 'before', 'after', 'stageName', 'backupName'
      ])
      || resource.kind !== expectedKind
      || typeof resource.target !== 'string'
      || !samePath(resource.target, expectedTargets[expectedKind])
      || resource.disposition !== 'publish' && resource.disposition !== 'keep'
      || resource.before !== null && !/^sha256:[0-9a-f]{64}$/.test(resource.before)
      || resource.after !== null && !/^sha256:[0-9a-f]{64}$/.test(resource.after)) {
      throw new LocalMaterializerStateError('materialization resource journal is invalid')
    }
    if (resource.disposition === 'keep') {
      if (resource.before !== resource.after || resource.stageName !== null || resource.backupName !== null) {
        throw new LocalMaterializerStateError('kept materialization resource journal is invalid')
      }
    } else if (resource.after === null
      || resource.stageName !== ORDINARY_RESOURCE_NAMES[expectedKind]
      || resource.backupName !== ORDINARY_RESOURCE_NAMES[expectedKind]
      || (expectedKind === 'visibilityPrivate' || expectedKind === 'visibilityState') && resource.before !== null) {
      throw new LocalMaterializerStateError('published materialization resource journal is invalid')
    }
  }
  const privateResource = journal.resources[3]
  const stateResource = journal.resources[4]
  if (journal.createdResourceParents.includes('visibility-private')
      && (privateResource?.disposition !== 'publish' || privateResource.before !== null)
    || journal.createdResourceParents.includes('visibility')
      && (stateResource?.disposition !== 'publish' || stateResource.before !== null)) {
    throw new LocalMaterializerStateError('visibility resource parent has no matching published sidecar')
  }
}

function artifactPublicationState(
  layout: LocalLayout,
  txRoot: string,
  entry: ArtifactJournal,
  artifact: MaterializationArtifactV1,
  limits: LocalMaterializerLimits
): { current: Sha256Identifier | null | 'unsafe'; staged: Sha256Identifier | null | 'unsafe'; backedUp: Sha256Identifier | null | 'unsafe' } {
  const stage = path.join(txRoot, 'staging', entry.stageName ?? entry.backupName)
  const backup = path.join(txRoot, 'backups', entry.backupName)
  return {
    current: currentDigest(layout.worktree, artifact, limits),
    staged: artifactPathDigest(layout.worktree, stage, artifact, limits),
    backedUp: artifactPathDigest(layout.worktree, backup, artifact, limits)
  }
}

function resourcePublicationState(
  txRoot: string,
  entry: ResourceJournal,
  limits: LocalMaterializerLimits
): { current: Sha256Identifier | null | 'unsafe'; staged: Sha256Identifier | null | 'unsafe'; backedUp: Sha256Identifier | null | 'unsafe' } {
  const maxBytes = resourceLimit(entry, limits)
  if (entry.disposition === 'keep') {
    return { current: bytesDigest(entry.target, maxBytes), staged: null, backedUp: null }
  }
  return {
    current: bytesDigest(entry.target, maxBytes),
    staged: bytesDigest(path.join(txRoot, 'staging', entry.stageName), maxBytes),
    backedUp: bytesDigest(path.join(txRoot, 'backups', entry.backupName), maxBytes)
  }
}

function artifactInitiallyPublishable(entry: ArtifactJournal, state: ReturnType<typeof artifactPublicationState>): boolean {
  if (entry.action === 'create') return state.current === null && state.staged === entry.after && state.backedUp === null
  if (entry.action === 'delete') return state.current === entry.before && state.staged === null && state.backedUp === null
  return state.current === entry.before && state.staged === entry.after && state.backedUp === null
}

function artifactForwardPublishable(entry: ArtifactJournal, state: ReturnType<typeof artifactPublicationState>): boolean {
  if (artifactInitiallyPublishable(entry, state)) return true
  if (entry.action === 'create') return state.current === entry.after && state.staged === null && state.backedUp === null
  if (entry.action === 'delete') return state.current === null && state.staged === null && state.backedUp === entry.before
  return state.backedUp === entry.before && (
    state.current === null && state.staged === entry.after
    || state.current === entry.after && state.staged === null
  )
}

function artifactPublished(entry: ArtifactJournal, state: ReturnType<typeof artifactPublicationState>): boolean {
  if (entry.action === 'create') return state.current === entry.after && state.staged === null && state.backedUp === null
  if (entry.action === 'delete') return state.current === null && state.staged === null && state.backedUp === entry.before
  return state.current === entry.after && state.staged === null && state.backedUp === entry.before
}

function resourceInitiallyPublishable(entry: ResourceJournal, state: ReturnType<typeof resourcePublicationState>): boolean {
  if (entry.disposition === 'keep') return state.current === entry.after
  return state.current === entry.before && state.staged === entry.after && state.backedUp === null
}

function resourceForwardPublishable(entry: ResourceJournal, state: ReturnType<typeof resourcePublicationState>): boolean {
  if (entry.disposition === 'keep') return state.current === entry.after
  if (resourceInitiallyPublishable(entry, state)) return true
  if (entry.before === null) return state.current === entry.after && state.staged === null && state.backedUp === null
  return state.backedUp === entry.before && (
    state.current === null && state.staged === entry.after
    || state.current === entry.after && state.staged === null
  )
}

function resourcePublished(entry: ResourceJournal, state: ReturnType<typeof resourcePublicationState>): boolean {
  if (entry.disposition === 'keep') return state.current === entry.after
  return state.current === entry.after && state.staged === null
    && (entry.before === null ? state.backedUp === null : state.backedUp === entry.before)
}

function isGitVisibilityResource(entry: ResourceJournal): boolean {
  return ORDINARY_GIT_VISIBILITY_RESOURCE_KINDS.some((kind) => kind === entry.kind)
}

function isVisibilitySidecarResource(entry: ResourceJournal): boolean {
  return ORDINARY_VISIBILITY_SIDECAR_RESOURCE_KINDS.some((kind) => kind === entry.kind)
}

function assertForwardPublicationPrefix(
  layout: LocalLayout,
  txRoot: string,
  journal: LocalMaterializationJournalV1,
  limits: LocalMaterializerLimits
): void {
  const artifacts = markerArtifactMap(journal)
  const states: { initial: boolean; published: boolean; forward: boolean }[] = []
  for (const entry of journal.artifacts.filter((candidate) => candidate.action === 'delete')) {
    const artifact = artifacts.get(entry.targetRelativePath)
    if (!artifact) throw new LocalMaterializerStateError('journal delete artifact is unavailable')
    const state = artifactPublicationState(layout, txRoot, entry, artifact, limits)
    states.push({
      initial: artifactInitiallyPublishable(entry, state),
      published: artifactPublished(entry, state),
      forward: artifactForwardPublishable(entry, state)
    })
  }
  for (const entry of journal.resources.filter((candidate) => (
    candidate.disposition === 'publish' && isGitVisibilityResource(candidate)
  ))) {
    const state = resourcePublicationState(txRoot, entry, limits)
    states.push({
      initial: resourceInitiallyPublishable(entry, state),
      published: resourcePublished(entry, state),
      forward: resourceForwardPublishable(entry, state)
    })
  }
  for (const entry of journal.artifacts.filter((candidate) => candidate.action !== 'delete')) {
    const artifact = artifacts.get(entry.targetRelativePath)
    if (!artifact) throw new LocalMaterializerStateError('journal create or update artifact is unavailable')
    const state = artifactPublicationState(layout, txRoot, entry, artifact, limits)
    states.push({
      initial: artifactInitiallyPublishable(entry, state),
      published: artifactPublished(entry, state),
      forward: artifactForwardPublishable(entry, state)
    })
  }
  for (const entry of journal.resources.filter((candidate) => (
    candidate.disposition === 'publish' && isVisibilitySidecarResource(candidate)
  ))) {
    const state = resourcePublicationState(txRoot, entry, limits)
    states.push({
      initial: resourceInitiallyPublishable(entry, state),
      published: resourcePublished(entry, state),
      forward: resourceForwardPublishable(entry, state)
    })
  }
  const marker = journal.resources.find((candidate) => candidate.kind === 'marker')
  if (!marker) throw new LocalMaterializerStateError('journal marker resource is unavailable')
  if (marker.disposition === 'publish') {
    const state = resourcePublicationState(txRoot, marker, limits)
    states.push({
      initial: resourceInitiallyPublishable(marker, state),
      published: resourcePublished(marker, state),
      forward: resourceForwardPublishable(marker, state)
    })
  }

  let reachedIncompleteEntry = false
  for (const state of states) {
    if (!state.forward) {
      throw new LocalMaterializerStateError('materialization publication state is not forward-recoverable')
    }
    if (reachedIncompleteEntry) {
      if (!state.initial) {
        throw new LocalMaterializerStateError('materialization publication does not follow the visibility-safe phase order')
      }
      continue
    }
    if (!state.published) reachedIncompleteEntry = true
  }
}

function assertKeptResourcesCurrent(
  journal: LocalMaterializationJournalV1,
  limits: LocalMaterializerLimits
): void {
  for (const resource of journal.resources) {
    if (resource.disposition === 'keep'
      && bytesDigest(resource.target, resourceLimit(resource, limits)) !== resource.after) {
      throw new LocalMaterializerStateError('kept materialization resource changed before journal cleanup')
    }
  }
}

function assertJournalPublishable(
  layout: LocalLayout,
  txRoot: string,
  journal: LocalMaterializationJournalV1,
  limits: LocalMaterializerLimits,
  allowProgress: boolean
): void {
  validateJournal(layout, journal, limits)
  assertSafeCleanupTree(txRoot, limits)
  if (allowProgress) assertForwardPublicationPrefix(layout, txRoot, journal, limits)
  const artifacts = markerArtifactMap(journal)
  for (const entry of journal.artifacts) {
    const artifact = artifacts.get(entry.targetRelativePath)
    if (!artifact) throw new LocalMaterializerStateError('journal artifact is unavailable for publication preflight')
    const state = artifactPublicationState(layout, txRoot, entry, artifact, limits)
    if (!(allowProgress ? artifactForwardPublishable(entry, state) : artifactInitiallyPublishable(entry, state))) {
      throw allowProgress
        ? new LocalMaterializerStateError('artifact publication progress cannot be proven')
        : new LocalMaterializerError('materialization artifact changed before publication')
    }
  }
  for (const entry of journal.resources) {
    if (entry.kind === 'visibilityState' || entry.kind === 'visibilityPrivate') {
      const relative = entry.kind === 'visibilityState' ? 'visibility' : 'visibility-private'
      const parent = path.dirname(entry.target)
      const parentStat = lstat(parent)
      if (!parentStat && !journal.createdResourceParents.includes(relative)
        || parentStat && (!parentStat.isDirectory() || parentStat.isSymbolicLink()
          || !samePath(parent, fs.realpathSync.native(parent)))
        || !allowProgress && parentStat && journal.createdResourceParents.includes(relative)) {
        throw allowProgress
          ? new LocalMaterializerStateError('visibility sidecar parent progress cannot be proven')
          : new LocalMaterializerError('visibility sidecar parent changed before publication')
      }
    }
    const state = resourcePublicationState(txRoot, entry, limits)
    if (!(allowProgress ? resourceForwardPublishable(entry, state) : resourceInitiallyPublishable(entry, state))) {
      throw allowProgress
        ? new LocalMaterializerStateError('resource publication progress cannot be proven')
        : new LocalMaterializerError('materialization resource changed before publication')
    }
  }
}

function resourceLimit(resource: ResourceJournal, limits: LocalMaterializerLimits): number {
  return resource.kind === 'gitIndex' ? limits.maxGitIndexBytes
    : resource.kind === 'marker' || resource.kind === 'visibilityState' ? limits.maxMarkerBytes
      : limits.maxGitConfigBytes
}

function gitLockRequired(resource: ResourceJournal): boolean {
  return resource.disposition === 'publish'
    && (resource.kind === 'gitIndex' || resource.kind === 'worktreeConfig')
}

function gitLockBytes(journal: LocalMaterializationJournalV1, resource: ResourceJournal): Buffer {
  return Buffer.from(`skill-graft-git-lock-v1\n${journal.token}\n${resource.kind}\n${resource.before ?? 'missing'}\n`, 'utf8')
}

type GitLockIdentity = { dev: number; ino: number }

type GitLockAttempt = {
  target: string
  placeholder: string
  bytes: Buffer
  identity: GitLockIdentity | null
  targetPublished: boolean
}

function sameGitLockIdentity(stat: fs.Stats, identity: GitLockIdentity): boolean {
  return stat.dev === identity.dev && stat.ino === identity.ino
}

function readGitLockCandidate(
  target: string,
  allowedLinks: 1 | 2,
  expectedIdentity?: GitLockIdentity
): { bytes: Buffer; stat: fs.Stats } {
  const before = lstat(target)
  if (!before?.isFile() || before.isSymbolicLink() || before.nlink !== allowedLinks
    || expectedIdentity && !sameGitLockIdentity(before, expectedIdentity)
    || !samePath(target, fs.realpathSync.native(target)) || before.size > 4096) {
    throw new LocalMaterializerStateError('Git resource lock is unsafe')
  }
  let descriptor: number | undefined
  try {
    const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | noFollow)
    const opened = fs.fstatSync(descriptor)
    if (!sameGitLockIdentity(opened, { dev: before.dev, ino: before.ino })
      || opened.nlink !== allowedLinks || opened.size !== before.size
      || opened.mtimeMs !== before.mtimeMs || opened.ctimeMs !== before.ctimeMs
      || opened.mode !== before.mode) {
      throw new LocalMaterializerStateError('Git resource lock changed while opening')
    }
    const bytes = Buffer.alloc(opened.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset)
      if (count === 0) throw new LocalMaterializerStateError('Git resource lock ended unexpectedly')
      offset += count
    }
    const after = fs.fstatSync(descriptor)
    const pathAfter = lstat(target)
    if (!pathAfter || !sameGitLockIdentity(after, { dev: opened.dev, ino: opened.ino })
      || !sameGitLockIdentity(pathAfter, { dev: opened.dev, ino: opened.ino })
      || after.nlink !== allowedLinks || pathAfter.nlink !== allowedLinks
      || after.size !== opened.size || pathAfter.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || pathAfter.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs || pathAfter.ctimeMs !== opened.ctimeMs
      || after.mode !== opened.mode || pathAfter.mode !== opened.mode) {
      throw new LocalMaterializerStateError('Git resource lock changed while reading')
    }
    return { bytes, stat: pathAfter }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

async function removeOwnedGitLockAttempt(
  attempt: GitLockAttempt,
  revalidate: RevalidateLease
): Promise<void> {
  const targetStat = lstat(attempt.target)
  const placeholderStat = lstat(attempt.placeholder)
  if (attempt.targetPublished && targetStat) {
    if (!attempt.identity || !sameGitLockIdentity(targetStat, attempt.identity)
      || targetStat.nlink !== (placeholderStat ? 2 : 1)) {
      throw new LocalMaterializerStateError('owned Git lock identity changed during initialization')
    }
    if (placeholderStat && (!sameGitLockIdentity(placeholderStat, attempt.identity) || placeholderStat.nlink !== 2)) {
      throw new LocalMaterializerStateError('owned Git lock placeholder identity changed')
    }
    const observed = readGitLockCandidate(
      attempt.target,
      placeholderStat ? 2 : 1,
      attempt.identity
    )
    if (!observed.bytes.equals(attempt.bytes)) {
      throw new LocalMaterializerStateError('owned Git lock content changed during initialization')
    }
    await guardedUnlink(attempt.target, revalidate)
  }
  const remainingPlaceholder = lstat(attempt.placeholder)
  if (remainingPlaceholder) {
    if (!attempt.identity || !sameGitLockIdentity(remainingPlaceholder, attempt.identity)
      || remainingPlaceholder.nlink !== 1 || !remainingPlaceholder.isFile()
      || remainingPlaceholder.isSymbolicLink()
      || !samePath(attempt.placeholder, fs.realpathSync.native(attempt.placeholder))) {
      throw new LocalMaterializerStateError('Git lock placeholder changed during cleanup')
    }
    await guardedUnlink(attempt.placeholder, revalidate)
  }
}

async function reconcileStaleGitLock(
  attempt: GitLockAttempt,
  recoverOwnStale: boolean,
  revalidate: RevalidateLease
): Promise<void> {
  const targetStat = lstat(attempt.target)
  const placeholderStat = lstat(attempt.placeholder)
  if (placeholderStat && (!placeholderStat.isFile() || placeholderStat.isSymbolicLink()
    || !samePath(attempt.placeholder, fs.realpathSync.native(attempt.placeholder))
    || placeholderStat.nlink !== (targetStat && sameGitLockIdentity(targetStat, {
      dev: placeholderStat.dev, ino: placeholderStat.ino
    }) ? 2 : 1) || placeholderStat.size > 4096)) {
    throw new LocalMaterializerStateError('Git lock placeholder is unsafe')
  }
  if (targetStat) {
    if (!targetStat.isFile() || targetStat.isSymbolicLink()
      || !samePath(attempt.target, fs.realpathSync.native(attempt.target))
      || targetStat.nlink !== 1 && targetStat.nlink !== 2) {
      throw new LocalMaterializerStateError('Git resource lock is unsafe')
    }
    if (targetStat.nlink === 2 && (!placeholderStat
      || !sameGitLockIdentity(targetStat, { dev: placeholderStat.dev, ino: placeholderStat.ino }))) {
      throw new LocalMaterializerStateError('Git resource lock has an unknown hard-link peer')
    }
    if (targetStat.nlink === 1 && placeholderStat) {
      throw new LocalMaterializerStateError('Git lock target and placeholder disagree')
    }
    const observed = readGitLockCandidate(attempt.target, targetStat.nlink as 1 | 2)
    if (!observed.bytes.equals(attempt.bytes)) throw new LocalMaterializerBusyError()
    if (!recoverOwnStale) throw new LocalMaterializerBusyError()
    attempt.identity = { dev: observed.stat.dev, ino: observed.stat.ino }
    attempt.targetPublished = true
    await guardedUnlink(attempt.target, revalidate)
  }
  const remainingPlaceholder = lstat(attempt.placeholder)
  if (remainingPlaceholder) {
    if (!recoverOwnStale) {
      throw new LocalMaterializerStateError('Git lock placeholder requires transaction recovery')
    }
    if (!remainingPlaceholder.isFile() || remainingPlaceholder.isSymbolicLink()
      || remainingPlaceholder.nlink !== 1
      || !samePath(attempt.placeholder, fs.realpathSync.native(attempt.placeholder))) {
      throw new LocalMaterializerStateError('Git lock placeholder is unsafe')
    }
    await guardedUnlink(attempt.placeholder, revalidate)
  }
  attempt.identity = null
  attempt.targetPublished = false
}

async function acquireGitResourceLocks(
  journal: LocalMaterializationJournalV1,
  txRoot: string,
  revalidate: RevalidateLease,
  recoverOwnStale: boolean,
  checkpoint: MaterializerCheckpoint
): Promise<() => Promise<void>> {
  const attempts: GitLockAttempt[] = []
  const held: GitLockAttempt[] = []
  try {
    const resources = journal.resources.filter(gitLockRequired)
      .sort((left, right) => compareUtf8Bytes(left.target, right.target))
    for (const resource of resources) {
      await revalidate()
      const target = `${resource.target}.lock`
      const bytes = gitLockBytes(journal, resource)
      const placeholder = path.join(txRoot, 'staging', `.git-lock-${resource.kind}`)
      const attempt: GitLockAttempt = {
        target, placeholder, bytes, identity: null, targetPublished: false
      }
      attempts.push(attempt)
      assertPlainDirectory(path.dirname(target), 'Git lock parent')
      assertPlainDirectory(path.dirname(placeholder), 'Git lock placeholder parent')
      if (lstat(path.dirname(target))?.dev !== lstat(path.dirname(placeholder))?.dev) {
        throw new LocalMaterializerLayoutError('Git lock target and placeholder must share a volume')
      }
      await reconcileStaleGitLock(attempt, recoverOwnStale, revalidate)

      await revalidate()
      fsyncDirectory(path.dirname(target))
      checkpoint('materializer-after-git-lock-target-parent-pre-fsync', { resource: resource.kind })
      await revalidate()
      let descriptor: number | undefined
      try {
        await revalidate()
        descriptor = fs.openSync(placeholder, 'wx', 0o600)
        const opened = fs.fstatSync(descriptor)
        attempt.identity = { dev: opened.dev, ino: opened.ino }
        checkpoint('materializer-after-git-lock-placeholder-open', { resource: resource.kind })
        await revalidate()

        await revalidate()
        fs.writeFileSync(descriptor, bytes)
        checkpoint('materializer-after-git-lock-placeholder-write', { resource: resource.kind })
        await revalidate()

        await revalidate()
        fs.fsyncSync(descriptor)
        checkpoint('materializer-after-git-lock-placeholder-fsync', { resource: resource.kind })
        await revalidate()
        fs.closeSync(descriptor)
        descriptor = undefined
      } catch (error) {
        if (descriptor !== undefined) {
          try { fs.closeSync(descriptor) } catch { /* preserve initialization failure */ }
        }
        throw error
      }

      await revalidate()
      fsyncDirectory(path.dirname(placeholder))
      checkpoint('materializer-after-git-lock-placeholder-parent-fsync', { resource: resource.kind })
      await revalidate()

      await revalidate()
      try { fs.linkSync(placeholder, target) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new LocalMaterializerBusyError()
        throw new LocalMaterializerStateError('Git resource lock could not be published atomically')
      }
      attempt.targetPublished = true
      held.push(attempt)
      checkpoint('materializer-after-git-lock-link', { resource: resource.kind })
      await revalidate()
      const linkedTarget = lstat(target)
      const linkedPlaceholder = lstat(placeholder)
      if (!attempt.identity || !linkedTarget || !linkedPlaceholder
        || !sameGitLockIdentity(linkedTarget, attempt.identity)
        || !sameGitLockIdentity(linkedPlaceholder, attempt.identity)
        || linkedTarget.nlink !== 2 || linkedPlaceholder.nlink !== 2) {
        throw new LocalMaterializerStateError('Git resource lock hard-link publication could not be proven')
      }

      await revalidate()
      fsyncDirectory(path.dirname(target))
      checkpoint('materializer-after-git-lock-target-parent-fsync', { resource: resource.kind })
      await revalidate()

      await revalidate()
      fs.unlinkSync(placeholder)
      checkpoint('materializer-after-git-lock-placeholder-unlink', { resource: resource.kind })
      await revalidate()

      await revalidate()
      fsyncDirectory(path.dirname(placeholder))
      checkpoint('materializer-after-git-lock-placeholder-unlink-parent-fsync', { resource: resource.kind })
      await revalidate()

      const initialized = readGitLockCandidate(target, 1, attempt.identity)
      if (!initialized.bytes.equals(bytes)) {
        throw new LocalMaterializerStateError('Git resource lock initialization could not be proven')
      }
    }
    return async () => {
      const failures: unknown[] = []
      for (const lock of [...held].reverse()) {
        await revalidate()
        try {
          if (!lock.identity) throw new LocalMaterializerStateError('owned Git lock identity is unavailable')
          const observed = readGitLockCandidate(lock.target, 1, lock.identity)
          if (!observed.bytes.equals(lock.bytes)) throw new LocalMaterializerStateError('owned Git lock changed while held')
          await guardedUnlink(lock.target, revalidate)
        } catch (error) {
          if (isLeaseLoss(error)) throw error
          failures.push(error)
        }
      }
      if (failures.length > 0) throw new LocalMaterializerStateError('Git resource locks could not be released safely')
    }
  } catch (error) {
    let leaseFailure: unknown
    for (const attempt of [...attempts].reverse()) {
      try {
        await removeOwnedGitLockAttempt(attempt, revalidate)
      } catch (cleanupError) {
        if (isLeaseLoss(cleanupError)) leaseFailure = cleanupError
        /* Preserve foreign, partial, or replaced locks for explicit recovery. */
      }
    }
    if (leaseFailure) throw leaseFailure
    throw error
  }
}

async function publishArtifactPhase(
  layout: LocalLayout,
  txRoot: string,
  journal: LocalMaterializationJournalV1,
  limits: LocalMaterializerLimits,
  actions: ReadonlySet<ArtifactJournal['action']>,
  revalidate: RevalidateLease,
  checkpoint: MaterializerCheckpoint
): Promise<number> {
  const artifacts = markerArtifactMap(journal)
  const entries = journal.artifacts.filter((entry) => actions.has(entry.action))
  for (const entry of entries) {
    const artifact = artifacts.get(entry.targetRelativePath)
    if (!artifact) throw new LocalMaterializerStateError('journal artifact is unavailable during publication')
    checkpoint('materializer-before-artifact-publish', { artifact: entry.artifactId })
    await revalidate()
    await movePreparedArtifact(
      layout, txRoot, entry, artifact, limits, journal.createdParents, revalidate
    )
    await revalidate()
  }
  return entries.length
}

async function publishResourcePhase(
  txRoot: string,
  resources: readonly ResourceJournal[],
  limits: LocalMaterializerLimits,
  revalidate: RevalidateLease,
  checkpoint: MaterializerCheckpoint
): Promise<number> {
  for (const resource of resources) {
    checkpoint('materializer-before-resource-publish', { resource: resource.kind })
    await revalidate()
    await movePreparedResource(txRoot, resource, resourceLimit(resource, limits), revalidate)
    await revalidate()
  }
  return resources.length
}

async function publishOrdinaryForward(
  layout: LocalLayout,
  txRoot: string,
  journal: LocalMaterializationJournalV1,
  limits: LocalMaterializerLimits,
  revalidate: RevalidateLease,
  checkpoint: MaterializerCheckpoint
): Promise<void> {
  const deleted = await publishArtifactPhase(
    layout, txRoot, journal, limits, new Set(['delete']), revalidate, checkpoint
  )
  checkpoint('materializer-after-delete-publication-phase', { operations: deleted })
  await revalidate()

  const gitVisibility = await publishResourcePhase(
    txRoot,
    journal.resources.filter(isGitVisibilityResource),
    limits,
    revalidate,
    checkpoint
  )
  checkpoint('materializer-after-git-visibility-publication-phase', { operations: gitVisibility })
  await revalidate()

  const createdOrUpdated = await publishArtifactPhase(
    layout, txRoot, journal, limits, new Set(['create', 'update']), revalidate, checkpoint
  )
  checkpoint('materializer-after-create-update-publication-phase', { operations: createdOrUpdated })
  await revalidate()

  const sidecars = await publishResourcePhase(
    txRoot,
    journal.resources.filter(isVisibilitySidecarResource),
    limits,
    revalidate,
    checkpoint
  )
  checkpoint('materializer-after-visibility-sidecar-publication-phase', { operations: sidecars })
  await revalidate()

  const marker = journal.resources.filter((resource) => resource.kind === 'marker')
  const markers = await publishResourcePhase(txRoot, marker, limits, revalidate, checkpoint)
  checkpoint('materializer-after-marker-publication-phase', { operations: markers })
  await revalidate()
}

type MarkerRollbackState = {
  current: Sha256Identifier | null | 'unsafe'
  staged: Sha256Identifier | null | 'unsafe'
  backedUp: Sha256Identifier | null | 'unsafe'
  discarded: Sha256Identifier | null | 'unsafe'
}

function markerRollbackState(
  txRoot: string,
  entry: ResourceJournal,
  limits: LocalMaterializerLimits
): MarkerRollbackState {
  const maxBytes = resourceLimit(entry, limits)
  if (entry.disposition === 'keep') {
    return {
      current: bytesDigest(entry.target, maxBytes), staged: null, backedUp: null, discarded: null
    }
  }
  return {
    current: bytesDigest(entry.target, maxBytes),
    staged: bytesDigest(path.join(txRoot, 'staging', entry.stageName), maxBytes),
    backedUp: bytesDigest(path.join(txRoot, 'backups', entry.backupName), maxBytes),
    discarded: bytesDigest(path.join(txRoot, 'discarded', entry.backupName), maxBytes)
  }
}

async function retractPublishedMarkerForRollback(
  txRoot: string,
  entry: ResourceJournal,
  limits: LocalMaterializerLimits,
  revalidate?: RevalidateLease
): Promise<void> {
  let state = markerRollbackState(txRoot, entry, limits)
  if (entry.disposition === 'keep') {
    if (state.current !== entry.before) throw new LocalMaterializerStateError('kept marker changed before rollback')
    return
  }
  if (state.current === entry.after) {
    if (state.staged !== null || state.backedUp !== entry.before || state.discarded !== null) {
      throw new LocalMaterializerStateError('published marker lacks exact rollback proof')
    }
    const discarded = path.join(txRoot, 'discarded', entry.backupName)
    await ensureDirectoryGuarded(txRoot, path.dirname(discarded), revalidate)
    await guardedRename(entry.target, discarded, revalidate)
    state = markerRollbackState(txRoot, entry, limits)
    if (state.current !== null || state.staged !== null
      || state.backedUp !== entry.before || state.discarded !== entry.after) {
      throw new LocalMaterializerStateError('published marker retraction could not be proven')
    }
    return
  }
  if (state.current === null) {
    const forwardMissing = state.staged === entry.after
      && state.backedUp === entry.before && state.discarded === null
    const alreadyRetracted = state.staged === null
      && state.backedUp === entry.before && state.discarded === entry.after
    if (forwardMissing || alreadyRetracted) return
  } else if (entry.before !== null && state.current === entry.before && state.backedUp === null) {
    const remainedOld = state.staged === entry.after && state.discarded === null
    const alreadyRestored = state.staged === null && state.discarded === entry.after
    if (remainedOld || alreadyRestored) return
  }
  throw new LocalMaterializerStateError('marker is not in a rollback-safe publication state')
}

async function restoreOldMarker(
  txRoot: string,
  entry: ResourceJournal,
  limits: LocalMaterializerLimits,
  revalidate?: RevalidateLease
): Promise<void> {
  let state = markerRollbackState(txRoot, entry, limits)
  if (entry.disposition === 'keep') {
    if (state.current !== entry.before) throw new LocalMaterializerStateError('kept marker changed during rollback')
    return
  }
  if (entry.before === null) {
    const missingInitial = state.current === null && state.staged === entry.after
      && state.backedUp === null && state.discarded === null
    const missingRetracted = state.current === null && state.staged === null
      && state.backedUp === null && state.discarded === entry.after
    if (!missingInitial && !missingRetracted) {
      throw new LocalMaterializerStateError('fresh marker rollback did not retain exact absence proof')
    }
    return
  }
  if (state.current === entry.before) {
    const remainedOld = state.staged === entry.after && state.backedUp === null && state.discarded === null
    const restoredOld = state.staged === null && state.backedUp === null && state.discarded === entry.after
    if (!remainedOld && !restoredOld) {
      throw new LocalMaterializerStateError('old marker rollback proof is invalid')
    }
    return
  }
  if (state.current === null && state.backedUp === entry.before) {
    const forwardMissing = state.staged === entry.after && state.discarded === null
    const retracted = state.staged === null && state.discarded === entry.after
    if (!forwardMissing && !retracted) {
      throw new LocalMaterializerStateError('old marker backup state is invalid')
    }
    const backup = path.join(txRoot, 'backups', entry.backupName)
    await guardedRename(backup, entry.target, revalidate)
    state = markerRollbackState(txRoot, entry, limits)
    if (state.current !== entry.before || state.backedUp !== null) {
      throw new LocalMaterializerStateError('old marker restoration could not be proven')
    }
    return
  }
  throw new LocalMaterializerStateError('old marker cannot be restored safely')
}

function assertResourcesAtBefore(
  resources: readonly ResourceJournal[],
  limits: LocalMaterializerLimits,
  label: string
): void {
  for (const resource of resources) {
    if (bytesDigest(resource.target, resourceLimit(resource, limits)) !== resource.before) {
      throw new LocalMaterializerStateError(`${label} did not reach its journaled old state`)
    }
  }
}

function assertFullyRolledBack(
  layout: LocalLayout,
  journal: LocalMaterializationJournalV1,
  limits: LocalMaterializerLimits
): void {
  const artifacts = markerArtifactMap(journal)
  for (const entry of journal.artifacts) {
    const artifact = artifacts.get(entry.targetRelativePath)
    if (!artifact || currentDigest(layout.worktree, artifact, limits) !== entry.before) {
      throw new LocalMaterializerStateError('materialization artifact rollback is incomplete')
    }
  }
  assertResourcesAtBefore(journal.resources, limits, 'materialization resource rollback')
  if (journal.oldMarker === null) {
    if (lstat(layout.marker)) throw new LocalMaterializerStateError('fresh materialization marker survived rollback')
  } else {
    const marker = parseJsonFile(layout.marker, limits.maxMarkerBytes, 'rolled-back materialization marker')
    if (!verifyMaterializationMarker(marker) || !equalJson(marker, journal.oldMarker)) {
      throw new LocalMaterializerStateError('old materialization marker was not restored exactly')
    }
    readCurrentVisibility(layout, {
      pathKey: journal.pathKey,
      worktreeId: journal.worktreeId
    }, journal.oldMarker, limits)
  }
}

async function rollbackJournal(
  layout: LocalLayout,
  txRoot: string,
  journal: LocalMaterializationJournalV1,
  limits: LocalMaterializerLimits,
  revalidate?: RevalidateLease,
  checkpoint?: MaterializerCheckpoint
): Promise<void> {
  validateJournal(layout, journal, limits)
  assertKeptResourcesCurrent(journal, limits)
  const artifacts = markerArtifactMap(journal)
  const marker = journal.resources.find((resource) => resource.kind === 'marker')
  if (!marker) throw new LocalMaterializerStateError('materialization marker resource is missing')

  await revalidate?.()
  await retractPublishedMarkerForRollback(txRoot, marker, limits, revalidate)
  checkpoint?.('materializer-after-marker-retraction-phase', { operations: 1 })
  await revalidate?.()

  const creates = [...journal.artifacts].reverse().filter((entry) => entry.action === 'create')
  for (const entry of creates) {
    checkpoint?.('materializer-before-artifact-rollback', { artifact: entry.artifactId })
    await revalidate?.()
    const artifact = artifacts.get(entry.targetRelativePath)
    if (!artifact) throw new LocalMaterializerStateError('journal create artifact is unavailable during rollback')
    await restoreArtifact(layout, txRoot, entry, artifact, limits, revalidate)
    await revalidate?.()
  }
  checkpoint?.('materializer-after-create-rollback-phase', { operations: creates.length })
  await revalidate?.()

  const gitVisibility = [...journal.resources].reverse().filter(isGitVisibilityResource)
  for (const resource of gitVisibility) {
    checkpoint?.('materializer-before-resource-rollback', { resource: resource.kind })
    await revalidate?.()
    await restoreResource(txRoot, resource, resourceLimit(resource, limits), revalidate)
    await revalidate?.()
  }
  assertResourcesAtBefore(gitVisibility, limits, 'old Git visibility')
  checkpoint?.('materializer-after-git-visibility-rollback-phase', { operations: gitVisibility.length })
  await revalidate?.()

  const updatesAndDeletes = [...journal.artifacts].reverse().filter((entry) => entry.action !== 'create')
  for (const entry of updatesAndDeletes) {
    checkpoint?.('materializer-before-artifact-rollback', { artifact: entry.artifactId })
    await revalidate?.()
    const artifact = artifacts.get(entry.targetRelativePath)
    if (!artifact) throw new LocalMaterializerStateError('journal update or delete artifact is unavailable during rollback')
    await restoreArtifact(layout, txRoot, entry, artifact, limits, revalidate)
    await revalidate?.()
  }
  for (const relative of [...journal.createdParents].sort((left, right) => right.length - left.length)) {
    await revalidate?.()
    const target = safeTarget(layout.worktree, `${relative}/placeholder`).target
    const parent = path.dirname(target)
    const stat = lstat(parent)
    if (!stat) continue
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(parent, fs.realpathSync.native(parent))) {
      throw new LocalMaterializerError('created materialization parent changed before rollback')
    }
    if (fs.readdirSync(parent).length === 0) await guardedRmdir(parent, revalidate)
    await revalidate?.()
  }
  checkpoint?.('materializer-after-update-delete-rollback-phase', { operations: updatesAndDeletes.length })
  await revalidate?.()

  const sidecars = [...journal.resources].reverse().filter(isVisibilitySidecarResource)
  for (const resource of sidecars) {
    checkpoint?.('materializer-before-resource-rollback', { resource: resource.kind })
    await revalidate?.()
    await restoreResource(txRoot, resource, resourceLimit(resource, limits), revalidate)
    await revalidate?.()
  }
  assertResourcesAtBefore(sidecars, limits, 'visibility sidecar rollback')
  for (const relative of [...journal.createdResourceParents].reverse()) {
    await revalidate?.()
    const target = relative === 'visibility' ? layout.visibility : layout.visibilityPrivate
    const stat = lstat(target)
    if (!stat) continue
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(target, fs.realpathSync.native(target))) {
      throw new LocalMaterializerStateError('visibility resource parent changed before rollback')
    }
    if (fs.readdirSync(target).length === 0) await guardedRmdir(target, revalidate)
    await revalidate?.()
  }
  checkpoint?.('materializer-after-visibility-sidecar-rollback-phase', { operations: sidecars.length })
  await revalidate?.()

  checkpoint?.('materializer-before-resource-rollback', { resource: marker.kind })
  await restoreOldMarker(txRoot, marker, limits, revalidate)
  checkpoint?.('materializer-after-old-marker-rollback-phase', { operations: 1 })
  await revalidate?.()
  assertFullyRolledBack(layout, journal, limits)
  assertKeptResourcesCurrent(journal, limits)
}

function fullyPublished(layout: LocalLayout, journal: LocalMaterializationJournalV1, limits: LocalMaterializerLimits): boolean {
  validateJournal(layout, journal, limits)
  const artifacts = markerArtifactMap(journal)
  for (const entry of journal.artifacts) {
    const artifact = artifacts.get(entry.targetRelativePath)
    if (!artifact || !artifactPublished(entry, artifactPublicationState(layout, path.join(layout.transactions, journal.token), entry, artifact, limits))) return false
  }
  for (const resource of journal.resources) {
    if (!resourcePublished(resource, resourcePublicationState(path.join(layout.transactions, journal.token), resource, limits))) return false
  }
  return true
}

function assertPublishedMarkerAndVisibility(
  layout: LocalLayout,
  identity: WorktreeIdentity,
  expected: MaterializationMarkerV1,
  limits: LocalMaterializerLimits
): void {
  const marker = parseJsonFile(layout.marker, limits.maxMarkerBytes, 'materialization marker')
  if (!verifyMaterializationMarker(marker) || !equalJson(marker, expected)) {
    throw new LocalMaterializerStateError('published materialization marker does not match durable truth')
  }
  readCurrentVisibility(layout, identity, marker, limits)
}

function durableMatches(durable: MaterializationCommitRecordV1 | null, marker: MaterializationMarkerV1): boolean {
  return durable?.pathKey === marker.pathKey && durable.marker != null && equalJson(durable.marker, marker)
}

function oldDurable(durable: MaterializationCommitRecordV1 | null, journal: LocalMaterializationJournalV1): boolean {
  if (!durable || durable.marker === null) return journal.oldMarker === null
  return journal.oldMarker !== null && durable.pathKey === journal.pathKey && equalJson(durable.marker, journal.oldMarker)
}

function legacyRecoveryDirection(
  durable: MaterializationCommitRecordV1 | null,
  journal: LocalLegacyMaterializationJournalV2
): 'forward' | 'backward' {
  if (journal.operationKind === 'legacyMigration') {
    if (journal.newMarker && durableMatches(durable, journal.newMarker)) return 'forward'
    if (journal.oldMarker === null && (durable === null || durable.marker === null)) return 'backward'
  } else {
    // A present record with marker:null is the durable commit proof for a
    // completed rollback. An absent record is not interchangeable with that
    // proof because it can also mean the Hub transaction never committed.
    if (durable !== null && durable.marker === null) return 'forward'
    if (journal.oldMarker && durableMatches(durable, journal.oldMarker)) return 'backward'
  }
  throw new LocalMaterializerStateError(
    'durable mirror does not identify a safe legacy recovery direction'
  )
}

function validateRecoveryTruth(
  identity: WorktreeIdentity,
  durable: MaterializationCommitRecordV1 | null,
  pin: WorktreePinV1 | null,
  stateRevision: number | null
): void {
  if (stateRevision !== null && (!Number.isSafeInteger(stateRevision) || stateRevision < 0)) {
    throw new LocalMaterializerStateError('recovery state revision is invalid')
  }
  if (pin && stateRevision === null) {
    throw new LocalMaterializerStateError('recovery pin requires its observed Hub state revision')
  }
  if (durable && durable.pathKey !== identity.pathKey) {
    throw new LocalMaterializerStateError('durable materialization mirror belongs to another worktree')
  }
  if (pin && (pin.pathKey !== identity.pathKey || pin.worktreeId !== identity.worktreeId)) {
    throw new LocalMaterializerStateError('recovery pin belongs to another worktree')
  }
  if (durable?.marker) {
    if (!verifyMaterializationMarker(durable.marker)
      || !pin || pin.claimState !== 'claimed'
      || pin.materializedSnapshot !== durable.marker.snapshotId) {
      throw new LocalMaterializerStateError('durable marker and Hub pin do not identify one committed materialization')
    }
  } else if (pin?.materializedSnapshot !== null && pin?.materializedSnapshot !== undefined) {
    throw new LocalMaterializerStateError('Hub pin claims materialized content without a durable marker')
  }
}

function visibilityTarget(
  artifact: MaterializationArtifactV1,
  raw: RawGitVisibility
): VisibilityOwnershipTargetV1 {
  return {
    artifactId: artifact.artifactId,
    owner: artifact.owner,
    targetRelativePath: artifact.targetRelativePath,
    baselineKind: 'missing',
    trackedPaths: [...raw.trackedPaths]
      .sort((left, right) => compareUtf8Bytes(left.path, right.path)),
    ignoreOrigin: raw.ignoreOrigin,
    privateExcluded: raw.privateExcluded
  }
}

function visibilityStateMatchesArtifacts(
  state: VisibilityOwnershipStateV1,
  artifacts: readonly MaterializationArtifactV1[]
): boolean {
  return state.targets.length === artifacts.length && state.targets.every((target, index) => {
    const artifact = artifacts[index]
    return artifact != null
      && target.artifactId === artifact.artifactId
      && target.owner === artifact.owner
      && target.targetRelativePath === artifact.targetRelativePath
  })
}

function trackedPathNames(value: readonly { path: string }[]): string {
  return canonicalJson(value.map((entry) => entry.path).sort(compareUtf8Bytes) as CanonicalJsonValue)
}

function managedVisibilityFact(
  worktree: string,
  state: VisibilityOwnershipStateV1,
  target: VisibilityOwnershipTargetV1,
  raw: RawGitVisibility,
  base: BaseExcludeSnapshot
): GitVisibilityFact {
  const underlying = inspectRawGit(worktree, target.targetRelativePath, base.locator)
  const restoreSafe = base.safe
    && target.ignoreOrigin !== 'private'
    && trackedPathNames(raw.trackedPaths) === trackedPathNames(target.trackedPaths)
    && underlying.ignoreOrigin === target.ignoreOrigin
    && underlying.privateExcluded === target.privateExcluded
  let restoreDigest: Sha256Identifier | null = null
  if (restoreSafe) {
    restoreDigest = createVisibilityFact({
      targetRelativePath: target.targetRelativePath,
      trackedPaths: target.trackedPaths,
      ignored: target.ignoreOrigin !== 'none',
      ignoreOrigin: target.ignoreOrigin,
      privateExcluded: target.privateExcluded,
      ownership: 'unmanaged',
      ownershipStateId: null,
      baselineDigest: visibilityOwnershipTargetBaselineDigest(target),
      restoreDigest: null,
      restoreSafe: true
    }).factDigest
  }
  return createVisibilityFact({
    ...raw,
    ownership: 'managed',
    ownershipStateId: state.visibilityStateId,
    baselineDigest: visibilityOwnershipTargetBaselineDigest(target),
    restoreDigest,
    restoreSafe
  })
}

/**
 * Copy materialization adapter. It emits only flat observations and executes
 * actions already frozen by shared Core; it never selects skills or resolves
 * a conflict on behalf of Application/Core.
 */
export function createLocalMaterializer(options: LocalMaterializerOptions): MaterializePort {
  const limits = { ...DEFAULT_LIMITS, ...options.limits }
  const checkpoint = options.checkpoint ?? (() => {})
  const nextToken = options.token ?? (() => `tx-${randomBytes(16).toString('hex')}`)

  async function inspect(
    input: Parameters<MaterializePort['inspect']>[0]
  ): Promise<MaterializeInspection & VisibilityInspection> {
    const worktree = await checkedIdentity(options.identities, input.worktree, input.identity)
    const layout = layoutOf(worktree)
    const configuration = gitConfigurationLayout(layout)
    const preliminaryDesired = buildDesiredMaterialization({
      snapshot: input.snapshot,
      selectedSkills: input.selectedSkills,
      runtimeAsset: input.runtimeAsset,
      visibilityStateId: ZERO_SHA
    })
    if (!preliminaryDesired.ok) throw new LocalMaterializerError('Core rejected materialization inspection sources')
    let observedMarker: unknown | null
    try {
      if (!lstat(layout.marker)) observedMarker = null
      else {
        const parsed = parseJsonFile(layout.marker, limits.maxMarkerBytes, 'materialization marker')
        observedMarker = parsed === null ? { invalidMaterializationDocument: true } : parsed
      }
    } catch {
      // Inspection must return a raw invalid marker fact so shared Core owns
      // the stable marker-invalid conflict classification.
      observedMarker = { invalidMaterializationDocument: true }
    }
    const current = verifyMaterializationMarker(observedMarker)
      && observedMarker.pathKey === input.identity.pathKey
      && observedMarker.worktreeId === input.identity.worktreeId
      ? observedMarker
      : null
    const currentVisibility = current
      ? readCurrentVisibility(layout, input.identity, current, limits)
      : null
    if (currentVisibility && !visibilityStateMatchesArtifacts(currentVisibility.state, current?.artifacts ?? [])) {
      throw new LocalMaterializerStateError('visibility ownership state does not match the materialization marker')
    }
    let baseExclude = currentVisibility?.base
      ?? inspectFreshBaseExclude(layout, configuration, limits)
    if (!currentVisibility && lstat(configuration.privateExclude)) {
      baseExclude = { ...baseExclude, safe: false }
    }
    const byPath = new Map<string, MaterializationArtifactV1>()
    for (const artifact of current?.artifacts ?? []) byPath.set(artifact.targetRelativePath, artifact)
    for (const artifact of preliminaryDesired.desired.artifacts) byPath.set(artifact.targetRelativePath, artifact)
    const artifacts = [...byPath.values()].sort((left, right) => compareUtf8Bytes(left.targetRelativePath, right.targetRelativePath))
    if (artifacts.length > limits.maxArtifacts) throw new LocalMaterializerError('materialization exceeds the artifact limit')
    const observations: MaterializationObservedArtifactFact[] = []
    const rawGitByPath = new Map<string, RawGitVisibility>()
    for (const artifact of artifacts) {
      assertControlledTarget(artifact)
      const observed = observePath(worktree, artifact, limits)
      const linked = observed.kind === 'symlink' || observed.kind === 'junction' || observed.kind === 'hardlink'
      observations.push({
        targetRelativePath: artifact.targetRelativePath,
        kind: observed.kind,
        ...(observed.digest ? { digest: observed.digest } : {}),
        isReparsePoint: observed.isReparsePoint,
        ...(linked ? { linkClassification: classifyLink(worktree, artifact, options.legacySourceRoot) } : {}),
        ...(observed.unsafeDescendant ? { pathEscaped: true } : {}),
        ...(artifact.targetRelativePath === 'AGENTS.md' || artifact.targetRelativePath === '.agents/skills/unity-skills'
          ? { protected: true } : {})
      })
      rawGitByPath.set(artifact.targetRelativePath, inspectRawGit(worktree, artifact.targetRelativePath))
    }
    const currentTargets = new Map((currentVisibility?.state.targets ?? []).map((target) => [
      target.targetRelativePath, target
    ]))
    const desiredTargets = preliminaryDesired.desired.artifacts.map((artifact) => {
      const retained = currentTargets.get(artifact.targetRelativePath)
      return retained ?? visibilityTarget(
        artifact,
        rawGitByPath.get(artifact.targetRelativePath) as RawGitVisibility
      )
    })
    const privateStateId = visibilityPrivateStateId(visibilityPrivatePayload(input.identity, baseExclude))
    const createdState = createVisibilityOwnershipState({
      privateStateId,
      pathKey: input.identity.pathKey,
      worktreeId: input.identity.worktreeId,
      baseExclude: {
        scope: baseExclude.scope,
        valueId: baseExclude.valueId,
        contentDigest: baseExclude.contentDigest
      },
      targets: desiredTargets
    })
    if (!createdState.ok) throw new LocalMaterializerError(createdState.message)
    const desiredVisibilityState = createdState.state
    const desiredResult = buildDesiredMaterialization({
      snapshot: input.snapshot,
      selectedSkills: input.selectedSkills,
      runtimeAsset: input.runtimeAsset,
      visibilityStateId: desiredVisibilityState.visibilityStateId
    })
    if (!desiredResult.ok) throw new LocalMaterializerError('Core rejected materialization visibility state')
    const gitFacts = artifacts.map((artifact) => {
      const raw = rawGitByPath.get(artifact.targetRelativePath) as RawGitVisibility
      const managedTarget = currentTargets.get(artifact.targetRelativePath)
      if (managedTarget && currentVisibility) {
        return managedVisibilityFact(
          worktree, currentVisibility.state, managedTarget, raw, baseExclude
        )
      }
      const desiredTarget = desiredTargets.find((target) => target.targetRelativePath === artifact.targetRelativePath)
      if (!desiredTarget) throw new LocalMaterializerStateError('visibility ownership baseline is unavailable')
      return createVisibilityFact({
        ...raw,
        ownership: 'unmanaged',
        ownershipStateId: currentVisibility?.state.visibilityStateId ?? null,
        baselineDigest: visibilityOwnershipTargetBaselineDigest(desiredTarget),
        restoreDigest: null,
        restoreSafe: true
      })
    })
    const managedPatterns = desiredVisibilityState.targets
      .filter((target) => target.privateExcluded
        || target.ignoreOrigin === 'none' || target.ignoreOrigin === 'legacyCommon')
      .map((target) => `/${target.targetRelativePath}`)
      .sort(compareUtf8Bytes)
    const desiredPrivateExclude = composedPrivateExcludes(baseExclude.bytes, managedPatterns)
    const desiredExcludesFileValueId = desiredVisibilityState.targets.length > 0
      ? gitMaterializationConfigurationValueId(comparable(configuration.privateExclude))
      : baseExclude.scope === 'worktree'
        ? configurationPathValueId(baseExclude.locator)
        : null
    const gitConfiguration = await inspectGitConfiguration(
      options, layout, artifacts.map((artifact) => artifact.targetRelativePath),
      baseExclude, desiredPrivateExclude, desiredExcludesFileValueId, limits
    )
    checkpoint('materializer-inspected', { artifacts: artifacts.length })
    return {
      observedMarker,
      observations,
      gitFacts,
      gitConfiguration,
      currentVisibilityState: currentVisibility?.state ?? null,
      desiredVisibilityState,
      privateBaseExclude: baseExclude
    }
  }

  async function inspectLegacyPrivate(
    input: Parameters<MaterializePort['inspectLegacy']>[0]
  ): Promise<LegacyInspectionPrivate> {
    const worktree = await checkedIdentity(options.identities, input.worktree, input.identity)
    const layout = layoutOf(worktree)
    let frozenBackupPrivateStateId: Sha256Identifier | null = null
    if (input.migration !== null) {
      if (!verifyLegacyMigrationRecordIdentity(input.migration)
        || input.migration.status !== 'committed'
        || input.migration.pathKey !== input.identity.pathKey
        || input.migration.worktreeId !== input.identity.worktreeId) {
        throw new LocalMaterializerStateError('committed legacy migration record is invalid')
      }
      const backupRoot = legacyBackupRoot(layout, input.migration.migrationId)
      const envelopeValue = parseJsonFile(
        path.join(backupRoot, 'envelope.json'), limits.maxJournalBytes, 'legacy backup envelope'
      )
      validateLegacyBackupEnvelope(options, layout, envelopeValue, {
        planHash: input.migration.planHash,
        migrationId: input.migration.migrationId,
        backupManifestId: input.migration.backupManifestId,
        backupPrivateStateId: input.migration.backupPrivateStateId,
        pathKey: input.migration.pathKey,
        worktreeId: input.migration.worktreeId,
        artifacts: input.migration.artifacts,
        gitBeforeDigest: input.migration.gitVisibilityDigest
      }, limits)
      frozenBackupPrivateStateId = input.migration.backupPrivateStateId
    }
    const legacyRoot = checkedLegacySourceRoot(options, worktree)
    const baseInspection = await inspect({
      worktree,
      identity: input.identity,
      snapshot: input.snapshot,
      runtimeAsset: input.runtimeAsset,
      selectedSkills: input.selectedSkills
    })
    const desiredResult = buildDesiredMaterialization({
      snapshot: input.snapshot,
      selectedSkills: input.selectedSkills,
      runtimeAsset: input.runtimeAsset,
      visibilityStateId: baseInspection.desiredVisibilityState.visibilityStateId
    })
    if (!desiredResult.ok) throw new LocalMaterializerError('Core rejected legacy materialization sources')
    const desired = desiredResult.desired
    const gitByPath = new Map(baseInspection.gitFacts.map((fact) => [fact.targetRelativePath, fact]))
    const gitFacts = desired.artifacts.map((artifact) => {
      const fact = gitByPath.get(artifact.targetRelativePath)
      if (!fact) throw new LocalMaterializerStateError('legacy Git facts do not cover desired artifacts')
      return fact
    })
    const observations = desired.artifacts.map((artifact) => legacyArtifactObservation(
      options, worktree, legacyRoot, artifact, limits
    ))
    const managedPatterns = baseInspection.desiredVisibilityState.targets
      .filter((target) => target.privateExcluded
        || target.ignoreOrigin === 'none' || target.ignoreOrigin === 'legacyCommon')
      .map((target) => `/${target.targetRelativePath}`)
      .sort(compareUtf8Bytes)
    const desiredPrivateExclude = composedPrivateExcludes(
      baseInspection.privateBaseExclude.bytes,
      managedPatterns
    )
    const createdParents = new Set<string>()
    for (const observation of observations) {
      if (observation.fact.observedKind !== 'missing' || observation.fact.pathEscaped) continue
      const target = safeTarget(worktree, observation.fact.targetRelativePath)
      if (target.pathEscaped) continue
      let cursor = worktree
      const relativeParent = path.relative(worktree, path.dirname(target.target)).replaceAll('\\', '/')
      for (const segment of relativeParent.split('/').filter(Boolean)) {
        cursor = path.join(cursor, segment)
        if (!lstat(cursor)) {
          createdParents.add(path.relative(worktree, cursor).replaceAll('\\', '/'))
        }
      }
    }
    const plannedParents = [...createdParents]
      .sort((left, right) => left.split('/').length - right.split('/').length)
    const createdResourceParents = [
      ...(!lstat(layout.visibilityPrivate) ? ['visibility-private' as const] : []),
      ...(!lstat(layout.visibility) ? ['visibility' as const] : [])
    ]
    const configuration = gitConfigurationLayout(layout)
    const desiredExcludesFileValueId = baseInspection.desiredVisibilityState.targets.length > 0
      ? gitMaterializationConfigurationValueId(comparable(configuration.privateExclude))
      : baseInspection.privateBaseExclude.scope === 'worktree'
        ? configurationPathValueId(baseInspection.privateBaseExclude.locator)
        : null
    const gitConfiguration = await inspectGitConfiguration(
      options,
      layout,
      desired.artifacts.map((artifact) => artifact.targetRelativePath),
      baseInspection.privateBaseExclude,
      desiredPrivateExclude,
      desiredExcludesFileValueId,
      limits,
      'legacy'
    )
    const privatePayload = legacyBackupPrivatePayload({
      layout,
      identity: input.identity,
      baseExclude: baseInspection.privateBaseExclude,
      createdParents: plannedParents,
      createdResourceParents,
      artifactFacts: observations.map((observation) => observation.privateFact),
      gitFacts,
      gitConfiguration,
      limits
    })
    const inspection: LegacyMigrationInspection = {
      observedMarker: baseInspection.observedMarker,
      currentVisibilityState: baseInspection.currentVisibilityState,
      desiredVisibilityState: baseInspection.desiredVisibilityState,
      backupPrivateStateId: frozenBackupPrivateStateId ?? legacyBackupPrivateStateId(privatePayload),
      artifacts: observations.map((observation) => observation.fact),
      gitFacts,
      gitConfiguration
    }
    checkpoint('legacy-materializer-inspected', {
      artifacts: inspection.artifacts.length,
      commonInfoEffect: !gitConfiguration.commonInfoExcludeClean
    })
    return {
      inspection,
      desired,
      privatePayload,
      baseExclude: baseInspection.privateBaseExclude
    }
  }

  async function inspectLegacy(
    input: Parameters<MaterializePort['inspectLegacy']>[0]
  ): Promise<LegacyMigrationInspection> {
    return (await inspectLegacyPrivate(input)).inspection
  }

  async function inspectLegacyRollback(
    input: Parameters<MaterializePort['inspectLegacyRollback']>[0]
  ): Promise<LegacyRollbackInspection> {
    const worktree = await checkedIdentity(options.identities, input.worktree, input.identity)
    const layout = layoutOf(worktree)
    if (!verifyLegacyMigrationRecordIdentity(input.migration)
      || input.migration.pathKey !== input.identity.pathKey
      || input.migration.worktreeId !== input.identity.worktreeId) {
      throw new LocalMaterializerStateError('legacy rollback migration record is invalid')
    }
    const backupRoot = legacyBackupRoot(layout, input.migration.migrationId)
    const envelopeValue = parseJsonFile(
      path.join(backupRoot, 'envelope.json'), limits.maxJournalBytes, 'legacy backup envelope'
    )
    const envelope = validateLegacyBackupEnvelope(options, layout, envelopeValue, {
      planHash: input.migration.planHash,
      migrationId: input.migration.migrationId,
      backupManifestId: input.migration.backupManifestId,
      backupPrivateStateId: input.migration.backupPrivateStateId,
      pathKey: input.migration.pathKey,
      worktreeId: input.migration.worktreeId,
      artifacts: input.migration.artifacts,
      gitBeforeDigest: input.migration.gitVisibilityDigest
    }, limits)
    const baseInspection = await inspect({
      worktree,
      identity: input.identity,
      snapshot: input.snapshot,
      runtimeAsset: input.runtimeAsset,
      selectedSkills: input.selectedSkills
    })
    const desiredResult = buildDesiredMaterialization({
      snapshot: input.snapshot,
      selectedSkills: input.selectedSkills,
      runtimeAsset: input.runtimeAsset,
      visibilityStateId: baseInspection.desiredVisibilityState.visibilityStateId
    })
    if (!desiredResult.ok) throw new LocalMaterializerError('Core rejected legacy rollback sources')
    if (input.migration.snapshotId !== desiredResult.desired.requested.snapshotId
      || input.migration.materializationId !== desiredResult.desired.requested.materializationId) {
      throw new LocalMaterializerStateError('legacy rollback sources do not match the migration record')
    }
    const observedMarker = baseInspection.observedMarker
    if (input.migration.status === 'committed') {
      if (!verifyMaterializationMarker(observedMarker)
        || observedMarker.origin.kind !== 'legacyMigration'
        || observedMarker.origin.migrationId !== input.migration.migrationId
        || observedMarker.planHash !== input.migration.planHash
        || observedMarker.materializationId !== input.migration.materializationId
        || observedMarker.visibilityStateId !== input.migration.visibilityStateId) {
        throw new LocalMaterializerStateError('committed legacy migration marker is not exact')
      }
    } else if (observedMarker !== null) {
      throw new LocalMaterializerStateError('rolled-back legacy migration retained a marker')
    }
    const legacyRoot = checkedLegacySourceRoot(options, worktree)
    const observations = desiredResult.desired.artifacts.map((artifact) => legacyArtifactObservation(
      options, worktree, legacyRoot, artifact, limits
    ).fact)
    const gitByPath = new Map(baseInspection.gitFacts.map((fact) => [fact.targetRelativePath, fact]))
    const gitFacts = desiredResult.desired.artifacts.map((artifact) => {
      const fact = gitByPath.get(artifact.targetRelativePath)
      if (!fact) throw new LocalMaterializerStateError('legacy rollback Git facts are incomplete')
      return fact
    })
    const managedPatterns = baseInspection.desiredVisibilityState.targets
      .filter((target) => target.privateExcluded
        || target.ignoreOrigin === 'none' || target.ignoreOrigin === 'legacyCommon')
      .map((target) => `/${target.targetRelativePath}`)
      .sort(compareUtf8Bytes)
    const desiredPrivateExclude = composedPrivateExcludes(
      baseInspection.privateBaseExclude.bytes, managedPatterns
    )
    const configuration = gitConfigurationLayout(layout)
    const gitConfiguration = await inspectGitConfiguration(
      options,
      layout,
      desiredResult.desired.artifacts.map((artifact) => artifact.targetRelativePath),
      baseInspection.privateBaseExclude,
      desiredPrivateExclude,
      gitMaterializationConfigurationValueId(comparable(configuration.privateExclude)),
      limits,
      'legacy',
      envelope.privatePayload.gitConfiguration.commonInfoExcludeClean === false
    )
    const backupBase = envelope.privatePayload.resources.baseExclude
    const backupBaseBytes = legacyResourceBytesFromBackup(
      backupRoot, envelope, 'baseExclude', limits
    ) ?? Buffer.alloc(0)
    const restoreBase: BaseExcludeSnapshot = {
      scope: backupBase.scope,
      valueId: backupBase.valueId,
      contentDigest: backupBase.contentDigest,
      locator: backupBase.locator,
      exists: backupBase.exists,
      bytes: backupBaseBytes,
      safe: true
    }
    const emptyState = createVisibilityOwnershipState({
      privateStateId: visibilityPrivateStateId(visibilityPrivatePayload(input.identity, restoreBase)),
      pathKey: input.identity.pathKey,
      worktreeId: input.identity.worktreeId,
      baseExclude: {
        scope: restoreBase.scope,
        valueId: restoreBase.valueId,
        contentDigest: restoreBase.contentDigest
      },
      targets: []
    })
    if (!emptyState.ok) throw new LocalMaterializerStateError(emptyState.message)
    const payloadOrdinal = new Map(envelope.privatePayload.artifacts.map((artifact, index) => [
      artifact.artifactId, index
    ]))
    const restoreSources = input.migration.artifacts.map((artifact) => {
      const privateFact = legacyPrivateArtifact(envelope, artifact.artifactId)
      const ordinal = payloadOrdinal.get(artifact.artifactId)
      if (ordinal === undefined) throw new LocalMaterializerStateError('legacy backup artifact ordinal is missing')
      return inspectLegacyRestoreSource(layout, backupRoot, artifact, privateFact, ordinal, limits)
    })
    const result: LegacyRollbackInspection = {
      observedMarker,
      currentVisibilityState: baseInspection.currentVisibilityState,
      desiredVisibilityState: emptyState.state,
      backupPrivateStateId: input.migration.backupPrivateStateId,
      artifacts: observations,
      gitFacts,
      gitConfiguration,
      restoreSources,
      restoreGitFacts: envelope.privatePayload.gitFacts,
      restoreGitConfiguration: envelope.privatePayload.gitConfiguration
    }
    checkpoint('legacy-rollback-inspected', {
      artifacts: result.artifacts.length,
      restoreSources: result.restoreSources.length
    })
    return result
  }

  async function prepareLegacyMigration(
    input: Parameters<MaterializePort['prepareLegacyMigration']>[0]
  ) {
    const revalidate: RevalidateLease = async () => { await input.guard.revalidateLease() }
    await revalidate()
    const worktree = await checkedIdentity(options.identities, input.worktree, input.identity)
    await revalidate()
    const layout = layoutOf(worktree)
    assertWorktreeConfigEnabled(gitConfigurationLayout(layout))
    if (!verifyLegacyMigrationPlanHash(input.plan) || !input.plan.executable
      || input.plan.summary.conflict !== 0
      || input.plan.pathKey !== input.identity.pathKey
      || input.plan.worktreeId !== input.identity.worktreeId
      || !verifyLibrarySnapshotManifest(input.snapshot)
      || !verifyRuntimeAssetManifest(input.runtimeAsset)) {
      throw new LocalMaterializerError('legacy migration plan or sources failed frozen validation')
    }
    const desiredResult = buildDesiredMaterialization({
      snapshot: input.snapshot,
      selectedSkills: input.plan.requested.selectedSkills,
      runtimeAsset: input.runtimeAsset,
      visibilityStateId: input.plan.requested.visibilityStateId
    })
    if (!desiredResult.ok || !equalJson(desiredResult.desired.requested, input.plan.requested)) {
      throw new LocalMaterializerError('legacy migration sources do not match the approved plan')
    }
    const reinspection = await inspectLegacyPrivate({
      worktree,
      identity: input.identity,
      snapshot: input.snapshot,
      runtimeAsset: input.runtimeAsset,
      selectedSkills: input.plan.requested.selectedSkills,
      migration: null
    })
    await revalidate()
    const observedGitDigest = observedLegacyGitFactsDigest(
      desiredResult.desired.artifacts,
      reinspection.inspection.gitFacts,
      reinspection.inspection.gitConfiguration
    )
    if (reinspection.inspection.observedMarker !== null
      || reinspection.inspection.currentVisibilityState !== null
      || reinspection.inspection.desiredVisibilityState.visibilityStateId
        !== input.plan.requested.visibilityStateId
      || reinspection.inspection.backupPrivateStateId !== input.plan.backupPrivateStateId
      || observedGitDigest !== input.plan.gitBeforeDigest
      || reinspection.inspection.gitConfiguration.currentDigest
        !== input.plan.git.configuration.beforeDigest
      || reinspection.inspection.gitConfiguration.desiredDigest
        !== input.plan.git.configuration.afterDigest
      || reinspection.inspection.gitConfiguration.siblingFactsDigest
        !== input.plan.git.configuration.siblingFactsDigest) {
      throw new LocalLegacyPlanStaleError()
    }
    for (const [index, operation] of input.plan.operations.entries()) {
      const fact = reinspection.inspection.artifacts[index]
      const gitFact = reinspection.inspection.gitFacts[index]
      const gitOperation = input.plan.git.operations[index]
      const exactIdentity = fact?.artifactId === operation.artifactId
        && fact.targetRelativePath === operation.targetRelativePath
        && fact.kind === operation.kind
      const exactArtifact = operation.action === 'replaceWithCopy'
        ? exactIdentity && fact.legacyKind === operation.legacy?.legacyKind
          && fact.sourceArtifactId === operation.legacy?.sourceArtifactId
          && fact.digest === operation.before?.digest
        : operation.action === 'create'
          ? exactIdentity && fact.observedKind === 'missing' && fact.digest === null
          : operation.action === 'keep' && exactIdentity
      if (!exactArtifact || !gitFact || !gitOperation
        || gitOperation.artifactId !== operation.artifactId
        || gitOperation.targetRelativePath !== operation.targetRelativePath
        || gitOperation.before.factDigest !== gitFact.factDigest
        || gitOperation.after.factDigest !== gitFact.desiredDigest) {
        throw new LocalLegacyPlanStaleError('legacy artifact or Git facts changed')
      }
    }
    const commonEffect = input.plan.git.configuration.effects
      .includes('removeOwnedCommonInfoExcludeEntries')
    if (commonEffect && reinspection.inspection.gitConfiguration.legacyCommonSiblingSafety === 'unsafe') {
      throw new LocalLegacyPlanStaleError('legacy common-info sibling proof is unsafe')
    }
    assertNoPendingMaterializationTransaction(layout)

    const token = nextToken()
    if (!TOKEN.test(token)) throw new LocalMaterializerError('legacy transaction token is invalid')
    const backupRoot = legacyBackupRoot(layout, input.plan.migrationId)
    const backupExisted = lstat(backupRoot) !== null
    await ensureDirectory(layout.gitAdminRoot, layout.graftRoot, revalidate)
    await ensureDirectory(layout.graftRoot, layout.legacyTransactions, revalidate)
    const prepareRoot = path.join(layout.legacyTransactions, `.prepare-${token}`)
    const committedRoot = path.join(layout.legacyTransactions, token)
    if (lstat(prepareRoot) || lstat(committedRoot)) {
      throw new LocalMaterializerStateError('legacy transaction already exists')
    }
    await guardedMkdir(prepareRoot, revalidate)
    let txRoot = prepareRoot
    const claim: LegacyPrepareClaimV1 = {
      schemaVersion: 1,
      operationKind: 'legacyMigration',
      token,
      pathKey: input.identity.pathKey,
      worktreeId: input.identity.worktreeId,
      planHash: input.plan.planHash,
      plan: input.plan,
      migrationId: input.plan.migrationId,
      backupManifestId: input.plan.backupManifestId,
      backupPrivateStateId: input.plan.backupPrivateStateId,
      dropBackupOnAbort: !backupExisted
    }
    await atomicWrite(path.join(txRoot, 'prepare.json'), legacyPrepareClaimBytes(claim), revalidate)
    checkpoint('legacy-materializer-after-prepare-claim', { operationKind: claim.operationKind })
    const desiredById = new Map(desiredResult.desired.artifacts.map((artifact) => [artifact.artifactId, artifact]))
    const counters = { files: 0, bytes: 0 }
    const artifacts: LegacyArtifactJournalV2[] = []
    try {
      const publishedBackup = await publishLegacyBackupEnvelope({
        options,
        layout,
        prepareToken: token,
        plan: input.plan,
        privatePayload: reinspection.privatePayload,
        limits,
        revalidate,
        checkpoint
      })
      for (const [index, operation] of input.plan.operations
        .filter((operation) => operation.action !== 'keep').entries()) {
        if (operation.action === 'replaceWithCopy'
          && lstat(path.join(backupRoot, 'artifacts', `artifact-${String(index).padStart(4, '0')}`))) {
          throw new LocalMaterializerStateError('legacy backup artifact slot is already occupied')
        }
      }
      await ensureDirectory(txRoot, path.join(txRoot, 'staging'), revalidate)
      await ensureDirectory(txRoot, path.join(txRoot, 'backups'), revalidate)
      await ensureDirectory(txRoot, path.join(txRoot, 'discarded'), revalidate)
      await ensureDirectory(txRoot, path.join(txRoot, 'locks'), revalidate)
      for (const kind of ['gitIndex', 'worktreeConfig', 'commonInfoExclude'] as const) {
        await ensureDirectory(txRoot, path.join(txRoot, 'locks', kind), revalidate)
        await ensureDirectory(txRoot, path.join(txRoot, 'locks', kind, 'staging'), revalidate)
      }
      checkpoint('legacy-materializer-after-prepare-root', { operations: input.plan.operations.length })
      const plannedParents = [...publishedBackup.envelope.privatePayload.createdParents]
      const changedOperations = input.plan.operations.filter((operation) => operation.action !== 'keep')
      for (const [index, operation] of changedOperations.entries()) {
        if (operation.action !== 'replaceWithCopy' && operation.action !== 'create') {
          throw new LocalMaterializerError('legacy migration plan contains a non-migration action')
        }
        const desired = desiredById.get(operation.artifactId)
        if (!desired) throw new LocalMaterializerStateError('legacy desired artifact is unavailable')
        const name = `artifact-${String(index).padStart(4, '0')}`
        await stageLegacyDesiredArtifact({
          options,
          worktree,
          artifact: desired,
          stage: path.join(txRoot, 'staging', name),
          limits,
          counters,
          revalidate
        })
        const privateFact = legacyPrivateArtifact(publishedBackup.envelope, operation.artifactId)
        artifacts.push({
          artifactId: operation.artifactId,
          owner: operation.owner,
          targetRelativePath: operation.targetRelativePath,
          artifactKind: operation.kind,
          action: operation.action,
          before: operation.action === 'create' ? { kind: 'missing' } : {
            kind: 'legacyLink',
            legacyKind: (operation.legacy as NonNullable<typeof operation.legacy>).legacyKind,
            sourceArtifactId: (operation.legacy as NonNullable<typeof operation.legacy>).sourceArtifactId,
            sourceStateId: privateFact.sourceStateId
          },
          after: { kind: 'copy', digest: operation.after.digest },
          stageName: name,
          backupName: operation.action === 'replaceWithCopy' ? name : null,
          discardName: name
        })
      }

      const configuration = gitConfigurationLayout(layout)
      const packageLayout = checkedPackageRoot(options, worktree)
      const resources: LegacyResourceJournalV2[] = []
      const managedPatterns = reinspection.inspection.desiredVisibilityState.targets
        .filter((target) => target.privateExcluded
          || target.ignoreOrigin === 'none' || target.ignoreOrigin === 'legacyCommon')
        .map((target) => `/${target.targetRelativePath}`)
        .sort(compareUtf8Bytes)
      const privateDesired = composedPrivateExcludes(reinspection.baseExclude.bytes, managedPatterns)
      await stageLegacyResource({
        resources, kind: 'privateExclude', target: configuration.privateExclude,
        desired: privateDesired, txRoot, limits, revalidate
      })

      const configCompute = path.join(txRoot, 'staging', '.worktree-config-compute')
      await copyOrCreateStage(
        configuration.worktreeConfig, configCompute, limits.maxGitConfigBytes,
        'legacy worktree config', revalidate
      )
      const effects = new Set(input.plan.git.configuration.effects)
      if (effects.has('setExcludesFile')) {
        await setStagedConfig(worktree, configCompute, 'core.excludesFile', configuration.privateExclude, revalidate)
      }
      if (effects.has('setHooksPath')) {
        await setStagedConfig(worktree, configCompute, 'core.hooksPath', packageLayout.hooksPath, revalidate)
      }
      if (effects.has('setOverlaySource')) {
        await setStagedConfig(
          worktree, configCompute, 'ozdqp.localOverlaySource', packageLayout.packageRoot, revalidate
        )
      }
      if (effects.has('setWatchWorkspace')) {
        await setStagedConfig(
          worktree, configCompute, 'ozdqp.skillWatchWorkspace', packageLayout.dataRoot, revalidate
        )
      }
      const worktreeDesired = readPlainBytes(
        configCompute, limits.maxGitConfigBytes, 'computed legacy worktree config'
      )
      await guardedUnlink(configCompute, revalidate)
      await stageLegacyResource({
        resources, kind: 'worktreeConfig', target: configuration.worktreeConfig,
        desired: worktreeDesired, txRoot, limits, revalidate
      })

      const indexTarget = exactGitPath(worktree, 'index')
      const indexCompute = path.join(txRoot, 'staging', '.git-index-compute')
      await revalidate()
      fs.copyFileSync(indexTarget, indexCompute, fs.constants.COPYFILE_EXCL)
      await revalidate()
      for (const operation of input.plan.git.operations.filter((operation) => operation.action === 'apply')) {
        const tracked = gitTracked(worktree, operation.targetRelativePath).paths.map((entry) => entry.path)
        if (tracked.length === 0) continue
        await revalidate()
        runGit(worktree, ['update-index', '--skip-worktree', '-z', '--stdin'], {
          env: { GIT_INDEX_FILE: indexCompute },
          input: Buffer.from(`${tracked.join('\0')}\0`, 'utf8')
        })
        await revalidate()
      }
      await guardedFsyncFile(indexCompute, revalidate)
      const indexDesired = readPlainBytes(indexCompute, limits.maxGitIndexBytes, 'computed legacy Git index')
      await guardedUnlink(indexCompute, revalidate)
      await stageLegacyResource({
        resources, kind: 'gitIndex', target: indexTarget,
        desired: indexDesired, txRoot, limits, revalidate
      })

      const commonBefore = lstat(configuration.commonInfoExclude)
        ? readPlainBytes(configuration.commonInfoExclude, limits.maxGitConfigBytes, 'legacy common info exclude')
        : null
      const commonEffectRequested = effects.has('removeOwnedCommonInfoExcludeEntries')
      if (commonEffectRequested && commonBefore === null) {
        throw new LocalLegacyPlanStaleError('legacy common-info effect targets a missing file')
      }
      const commonDesired = commonEffectRequested
        ? removeOwnedCommonExcludeLines(
            commonBefore as Buffer,
            new Set(desiredResult.desired.artifacts.map((artifact) => artifact.targetRelativePath))
          )
        : commonBefore
      await stageLegacyResource({
        resources, kind: 'commonInfoExclude', target: configuration.commonInfoExclude,
        desired: commonDesired, txRoot, limits, revalidate
      })
      const commonConfigBytes = readPlainBytes(
        configuration.commonConfig, limits.maxGitConfigBytes, 'legacy common Git config'
      )
      await stageLegacyResource({
        resources, kind: 'commonConfig', target: configuration.commonConfig,
        desired: commonConfigBytes, txRoot, limits, revalidate
      })

      const state = reinspection.inspection.desiredVisibilityState
      await stageLegacyResource({
        resources,
        kind: 'visibilityPrivate',
        target: visibilityPrivatePath(layout, state.visibilityStateId),
        desired: visibilityPrivateBytes(visibilityPrivateEnvelope(input.identity, state, reinspection.baseExclude)),
        txRoot, limits, revalidate
      })
      await stageLegacyResource({
        resources,
        kind: 'visibilityState',
        target: visibilityStatePath(layout, state.visibilityStateId),
        desired: visibilityStateBytes(state),
        txRoot, limits, revalidate
      })
      const marker = legacyMigrationMarker(input.plan, desiredResult.desired)
      await stageLegacyResource({
        resources, kind: 'marker', target: layout.marker,
        desired: markerBytes(marker), txRoot, limits, revalidate
      })
      resources.sort((left, right) => LEGACY_RESOURCE_KINDS.indexOf(left.kind)
        - LEGACY_RESOURCE_KINDS.indexOf(right.kind))
      const record = legacyMigrationRecord(input.plan)
      const journal: LocalLegacyMaterializationJournalV2 = {
        schemaVersion: 2,
        operationKind: 'legacyMigration',
        token,
        pathKey: input.identity.pathKey,
        worktreeId: input.identity.worktreeId,
        planHash: input.plan.planHash,
        plan: input.plan,
        migrationId: input.plan.migrationId,
        backupManifestId: input.plan.backupManifestId,
        backupPrivateStateId: input.plan.backupPrivateStateId,
        backupRoot,
        dropBackupOnAbort: !backupExisted,
        oldMarker: null,
        newMarker: marker,
        siblingFactsDigest: input.plan.git.configuration.siblingFactsDigest,
        commonInfoEffect: commonEffect,
        createdParents: plannedParents,
        createdResourceParents: [
          ...publishedBackup.envelope.privatePayload.createdResourceParents
        ],
        artifacts,
        resources,
        record
      }
      validateLegacyJournal(options, layout, journal, publishedBackup.envelope, limits)
      checkpoint('legacy-materializer-before-journal-write', { operations: artifacts.length })
      await atomicWrite(path.join(txRoot, 'journal.json'), legacyJournalBytes(journal), revalidate)
      await guardedRename(prepareRoot, committedRoot, revalidate)
      txRoot = committedRoot
      checkpoint('legacy-materializer-prepared', { operations: artifacts.length, bytes: counters.bytes })

      let finished = false
      let outcome: 'published' | 'rolledBack' | null = null
      const participant: ApplicationTransactionParticipant = {
        participantId: `legacy-migrate-${token}`,
        async publish(context) {
          if (finished) throw new LocalMaterializerError('legacy migration participant is finalized')
          const lease: RevalidateLease = async () => { await context.revalidateLease() }
          await lease()
          await checkedIdentity(options.identities, worktree, input.identity)
          const onDisk = readLegacyJournal(options, layout, txRoot, limits)
          if (!equalJson(onDisk.journal, journal)) throw new LocalMaterializerStateError('legacy journal changed')
          assertLegacyForwardPrefix(layout, txRoot, journal, onDisk.envelope, limits)
          const releaseLocks = await acquireLegacyGitResourceLocks(
            journal, txRoot, lease, false, checkpoint
          )
          let failure: unknown
          try {
            await assertLegacySiblingFence(options, layout, journal, limits, true)
            await publishParents(
              worktree,
              journal.createdParents,
              marker.artifacts.map((artifact) => artifact.targetRelativePath),
              false,
              lease
            )
            await publishResourceParents(layout, journal.createdResourceParents, false, lease)
            await publishLegacyForward({
              options, layout, txRoot, journal, envelope: onDisk.envelope,
              limits, revalidate: lease, checkpoint
            })
            assertLegacyAtDirection(layout, txRoot, journal, onDisk.envelope, limits, 'after')
            const published = await inspect({
              worktree,
              identity: input.identity,
              snapshot: input.snapshot,
              runtimeAsset: input.runtimeAsset,
              selectedSkills: input.plan.requested.selectedSkills
            })
            if (!equalJson(published.observedMarker, marker)
              || published.currentVisibilityState?.visibilityStateId !== marker.visibilityStateId
              || published.gitConfiguration.currentDigest !== input.plan.git.configuration.afterDigest) {
              throw new LocalMaterializerStateError('legacy migration publication proof is incomplete')
            }
            for (const [index, operation] of input.plan.git.operations.entries()) {
              if (published.gitFacts[index]?.factDigest !== operation.after.factDigest) {
                throw new LocalMaterializerStateError('legacy published Git fact is incorrect')
              }
            }
            outcome = 'published'
          } catch (error) {
            failure = error
            throw error
          } finally {
            try { await releaseLocks() } catch (releaseError) {
              if (!failure || isLeaseLoss(releaseError)) throw releaseError
            }
          }
        },
        async rollback(context) {
          if (finished) return
          const lease: RevalidateLease = async () => { await context.revalidateLease() }
          await lease()
          await checkedIdentity(options.identities, worktree, input.identity)
          const onDisk = readLegacyJournal(options, layout, txRoot, limits)
          const releaseLocks = await acquireLegacyGitResourceLocks(journal, txRoot, lease, true, checkpoint)
          let failure: unknown
          try {
            await rollbackLegacyJournal({
              options, layout, txRoot, journal, envelope: onDisk.envelope,
              limits, revalidate: lease, checkpoint
            })
            outcome = 'rolledBack'
          } catch (error) {
            failure = error
            throw error
          } finally {
            try { await releaseLocks() } catch (releaseError) {
              if (!failure || isLeaseLoss(releaseError)) throw releaseError
            }
          }
        },
        async finalize(context) {
          if (finished) return
          const lease: RevalidateLease = async () => { await context.revalidateLease() }
          await lease()
          const onDisk = readLegacyJournal(options, layout, txRoot, limits)
          if (!outcome) throw new LocalMaterializerStateError('legacy participant outcome is unknown')
          assertLegacyAtDirection(
            layout, txRoot, journal, onDisk.envelope, limits,
            outcome === 'published' ? 'after' : 'before'
          )
          await cleanupLegacyTransaction(
            layout, txRoot, limits, lease,
            outcome === 'published' ? 'forward' : 'backward',
            outcome === 'rolledBack' && journal.dropBackupOnAbort
              ? journal.migrationId : undefined,
            checkpoint
          )
          await lease()
          finished = true
        }
      }
      return {
        marker,
        record,
        report: { preparedOperations: artifacts.length, preparedBytes: counters.bytes },
        participant
      }
    } catch (error) {
      const transactionCommitted = lstat(committedRoot) !== null
      if (!transactionCommitted && !backupExisted && lstat(backupRoot)) {
        try {
          checkpoint('legacy-materializer-before-aborted-backup-cleanup', {
            migrationId: claim.migrationId
          })
          await cleanupLegacyPrepareBackup(
            options, layout, claim, limits, revalidate, checkpoint
          )
        } catch (cleanupError) {
          throw cleanupError
        }
      }
      if (!transactionCommitted && lstat(prepareRoot)) {
        try {
          await removeCleanupTree(prepareRoot, limits, revalidate)
        } catch (cleanupError) {
          if (isLeaseLoss(cleanupError)) throw cleanupError
        }
      }
      throw error
    }
  }

  async function prepareLegacyRollback(
    input: Parameters<MaterializePort['prepareLegacyRollback']>[0]
  ) {
    const revalidate: RevalidateLease = async () => { await input.guard.revalidateLease() }
    await revalidate()
    const worktree = await checkedIdentity(options.identities, input.worktree, input.identity)
    await revalidate()
    const layout = layoutOf(worktree)
    if (!verifyLegacyRollbackPlanHash(input.plan) || !input.plan.executable
      || input.plan.summary.conflict !== 0
      || input.plan.pathKey !== input.identity.pathKey
      || input.plan.worktreeId !== input.identity.worktreeId
      || !verifyLegacyMigrationRecordIdentity(input.migration)
      || input.migration.status !== 'committed'
      || input.migration.migrationId !== input.plan.migrationId
      || input.migration.backupManifestId !== input.plan.backupManifestId
      || input.migration.backupPrivateStateId !== input.plan.backupPrivateStateId
      || !verifyLibrarySnapshotManifest(input.snapshot)
      || !verifyRuntimeAssetManifest(input.runtimeAsset)) {
      throw new LocalMaterializerError('legacy rollback plan, record, or sources failed frozen validation')
    }
    const desiredResult = buildDesiredMaterialization({
      snapshot: input.snapshot,
      selectedSkills: input.plan.current.selectedSkills,
      runtimeAsset: input.runtimeAsset,
      visibilityStateId: input.plan.current.visibilityStateId
    })
    if (!desiredResult.ok
      || desiredResult.desired.requested.materializationId !== input.migration.materializationId
      || desiredResult.desired.requested.snapshotId !== input.migration.snapshotId) {
      throw new LocalMaterializerError('legacy rollback sources do not match the migration')
    }
    const reinspection = await inspectLegacyRollback({
      worktree,
      identity: input.identity,
      snapshot: input.snapshot,
      runtimeAsset: input.runtimeAsset,
      selectedSkills: input.plan.current.selectedSkills,
      migration: input.migration
    })
    await revalidate()
    if (!equalJson(reinspection.observedMarker, input.plan.current)
      || reinspection.currentVisibilityState?.visibilityStateId !== input.plan.current.visibilityStateId
      || reinspection.desiredVisibilityState.visibilityStateId !== input.plan.restoreVisibilityStateId
      || reinspection.backupPrivateStateId !== input.plan.backupPrivateStateId
      || reinspection.gitConfiguration.currentDigest !== input.plan.git.configuration.beforeDigest
      || reinspection.restoreGitConfiguration.currentDigest !== input.plan.git.configuration.afterDigest
      || reinspection.gitConfiguration.siblingFactsDigest
        !== input.plan.git.configuration.siblingFactsDigest) {
      throw new LocalLegacyPlanStaleError('legacy rollback facts changed')
    }
    for (const [index, operation] of input.plan.operations.entries()) {
      const fact = reinspection.artifacts[index]
      const gitFact = reinspection.gitFacts[index]
      const restoreGitFact = reinspection.restoreGitFacts[index]
      const gitOperation = input.plan.git.operations[index]
      const restoreSource = operation.restore
        ? reinspection.restoreSources.find((candidate) => candidate.artifactId === operation.artifactId)
        : null
      if (!fact || !gitFact || !restoreGitFact || !gitOperation
        || fact.artifactId !== operation.artifactId
        || fact.targetRelativePath !== operation.targetRelativePath
        || fact.observedKind !== operation.kind || fact.legacyKind !== null
        || fact.digest !== operation.before?.digest
        || gitOperation.before.factDigest !== gitFact.factDigest
        || gitOperation.after.factDigest !== restoreGitFact.factDigest
        || operation.action === 'restoreLink' && (!restoreSource
          || restoreSource.status !== 'valid'
          || restoreSource.sourceStateId !== operation.restore?.sourceStateId)) {
        throw new LocalLegacyPlanStaleError('legacy rollback artifact or restore source changed')
      }
    }
    const commonEffect = input.plan.git.configuration.effects.includes('restoreBackup')
      && reinspection.gitConfiguration.commonInfoExcludeClean
        !== reinspection.restoreGitConfiguration.commonInfoExcludeClean
    if (commonEffect && reinspection.gitConfiguration.legacyCommonSiblingSafety === 'unsafe') {
      throw new LocalLegacyPlanStaleError('legacy rollback sibling proof is unsafe')
    }
    const backupRoot = legacyBackupRoot(layout, input.plan.migrationId)
    const envelopeValue = parseJsonFile(
      path.join(backupRoot, 'envelope.json'), limits.maxJournalBytes, 'legacy backup envelope'
    )
    const envelope = validateLegacyBackupEnvelope(options, layout, envelopeValue, {
      planHash: input.migration.planHash,
      migrationId: input.migration.migrationId,
      backupManifestId: input.migration.backupManifestId,
      backupPrivateStateId: input.migration.backupPrivateStateId,
      pathKey: input.migration.pathKey,
      worktreeId: input.migration.worktreeId,
      artifacts: input.migration.artifacts,
      gitBeforeDigest: input.migration.gitVisibilityDigest
    }, limits)
    assertNoPendingMaterializationTransaction(layout)

    const token = nextToken()
    if (!TOKEN.test(token)) throw new LocalMaterializerError('legacy rollback token is invalid')
    await ensureDirectory(layout.gitAdminRoot, layout.graftRoot, revalidate)
    await ensureDirectory(layout.graftRoot, layout.legacyTransactions, revalidate)
    const prepareRoot = path.join(layout.legacyTransactions, `.prepare-${token}`)
    const committedRoot = path.join(layout.legacyTransactions, token)
    if (lstat(prepareRoot) || lstat(committedRoot)) {
      throw new LocalMaterializerStateError('legacy rollback transaction already exists')
    }
    await guardedMkdir(prepareRoot, revalidate)
    let txRoot = prepareRoot
    const claim: LegacyPrepareClaimV1 = {
      schemaVersion: 1,
      operationKind: 'legacyRollback',
      token,
      pathKey: input.identity.pathKey,
      worktreeId: input.identity.worktreeId,
      planHash: input.plan.planHash,
      plan: input.plan,
      migrationId: input.plan.migrationId,
      backupManifestId: input.plan.backupManifestId,
      backupPrivateStateId: input.plan.backupPrivateStateId,
      dropBackupOnAbort: false
    }
    await atomicWrite(path.join(txRoot, 'prepare.json'), legacyPrepareClaimBytes(claim), revalidate)
    checkpoint('legacy-materializer-after-prepare-claim', { operationKind: claim.operationKind })
    await ensureDirectory(txRoot, path.join(txRoot, 'staging'), revalidate)
    await ensureDirectory(txRoot, path.join(txRoot, 'backups'), revalidate)
    await ensureDirectory(txRoot, path.join(txRoot, 'discarded'), revalidate)
    await ensureDirectory(txRoot, path.join(txRoot, 'locks'), revalidate)
    for (const kind of ['gitIndex', 'worktreeConfig', 'commonInfoExclude'] as const) {
      await ensureDirectory(txRoot, path.join(txRoot, 'locks', kind), revalidate)
      await ensureDirectory(txRoot, path.join(txRoot, 'locks', kind, 'staging'), revalidate)
    }
    const artifacts: LegacyArtifactJournalV2[] = []
    try {
      const changedOperations = input.plan.operations.filter((operation) => operation.action !== 'keep')
      const payloadOrdinal = new Map(envelope.privatePayload.artifacts.map((artifact, index) => [
        artifact.artifactId, index
      ]))
      for (const [index, operation] of changedOperations.entries()) {
        if (operation.action !== 'restoreLink' && operation.action !== 'deleteCreated'
          || !operation.before?.digest) {
          throw new LocalMaterializerError('legacy rollback plan contains an invalid action')
        }
        const name = `artifact-${String(index).padStart(4, '0')}`
        const persistentOrdinal = payloadOrdinal.get(operation.artifactId)
        if (persistentOrdinal === undefined || persistentOrdinal !== index) {
          throw new LocalMaterializerStateError('legacy rollback backup ordinal is not canonical')
        }
        artifacts.push({
          artifactId: operation.artifactId,
          owner: operation.owner,
          targetRelativePath: operation.targetRelativePath,
          artifactKind: operation.kind,
          action: operation.action,
          before: { kind: 'copy', digest: operation.before.digest },
          after: operation.action === 'deleteCreated' ? { kind: 'missing' } : {
            kind: 'legacyLink',
            legacyKind: (operation.restore as NonNullable<typeof operation.restore>).legacyKind,
            sourceArtifactId: (operation.restore as NonNullable<typeof operation.restore>).sourceArtifactId,
            sourceStateId: (operation.restore as NonNullable<typeof operation.restore>).sourceStateId
          },
          stageName: null,
          backupName: operation.action === 'restoreLink' ? name : null,
          discardName: name
        })
      }
      const configuration = gitConfigurationLayout(layout)
      const resources: LegacyResourceJournalV2[] = []
      await stageLegacyResource({
        resources, kind: 'privateExclude', target: configuration.privateExclude,
        desired: legacyResourceBytesFromBackup(backupRoot, envelope, 'privateExclude', limits),
        txRoot, limits, revalidate
      })
      await stageLegacyResource({
        resources, kind: 'worktreeConfig', target: configuration.worktreeConfig,
        desired: legacyResourceBytesFromBackup(backupRoot, envelope, 'worktreeConfig', limits),
        txRoot, limits, revalidate
      })
      await stageLegacyResource({
        resources, kind: 'gitIndex', target: exactGitPath(worktree, 'index'),
        desired: legacyResourceBytesFromBackup(backupRoot, envelope, 'gitIndex', limits),
        txRoot, limits, revalidate
      })
      await stageLegacyResource({
        resources, kind: 'commonInfoExclude', target: configuration.commonInfoExclude,
        desired: legacyResourceBytesFromBackup(backupRoot, envelope, 'commonInfoExclude', limits),
        txRoot, limits, revalidate
      })
      await stageLegacyResource({
        resources, kind: 'commonConfig', target: configuration.commonConfig,
        desired: legacyResourceBytesFromBackup(backupRoot, envelope, 'commonConfig', limits),
        txRoot, limits, revalidate
      })
      await stageLegacyResource({
        resources, kind: 'visibilityPrivate',
        target: visibilityPrivatePath(layout, input.plan.current.visibilityStateId),
        desired: null, txRoot, limits, revalidate
      })
      await stageLegacyResource({
        resources, kind: 'visibilityState',
        target: visibilityStatePath(layout, input.plan.current.visibilityStateId),
        desired: null, txRoot, limits, revalidate
      })
      await stageLegacyResource({
        resources, kind: 'marker', target: layout.marker,
        desired: null, txRoot, limits, revalidate
      })
      resources.sort((left, right) => LEGACY_RESOURCE_KINDS.indexOf(left.kind)
        - LEGACY_RESOURCE_KINDS.indexOf(right.kind))
      const record: LegacyMigrationRecordV1 = {
        ...input.migration,
        status: 'rolledBack',
        rollbackPlanHash: input.plan.planHash
      }
      if (!verifyLegacyMigrationRecordIdentity(record)) {
        throw new LocalMaterializerStateError('rolled-back legacy record failed verification')
      }
      const journal: LocalLegacyMaterializationJournalV2 = {
        schemaVersion: 2,
        operationKind: 'legacyRollback',
        token,
        pathKey: input.identity.pathKey,
        worktreeId: input.identity.worktreeId,
        planHash: input.plan.planHash,
        plan: input.plan,
        migrationId: input.plan.migrationId,
        backupManifestId: input.plan.backupManifestId,
        backupPrivateStateId: input.plan.backupPrivateStateId,
        backupRoot,
        dropBackupOnAbort: false,
        oldMarker: input.plan.current,
        newMarker: null,
        siblingFactsDigest: input.plan.git.configuration.siblingFactsDigest,
        commonInfoEffect: commonEffect,
        createdParents: [...envelope.privatePayload.createdParents],
        createdResourceParents: [...envelope.privatePayload.createdResourceParents],
        artifacts,
        resources,
        record
      }
      validateLegacyJournal(options, layout, journal, envelope, limits)
      await atomicWrite(path.join(txRoot, 'journal.json'), legacyJournalBytes(journal), revalidate)
      await guardedRename(prepareRoot, committedRoot, revalidate)
      txRoot = committedRoot
      checkpoint('legacy-rollback-prepared', { operations: artifacts.length })
      let finished = false
      let outcome: 'published' | 'rolledBack' | null = null
      const participant: ApplicationTransactionParticipant = {
        participantId: `legacy-rollback-${token}`,
        async publish(context) {
          if (finished) throw new LocalMaterializerError('legacy rollback participant is finalized')
          const lease: RevalidateLease = async () => { await context.revalidateLease() }
          await lease()
          await checkedIdentity(options.identities, worktree, input.identity)
          const onDisk = readLegacyJournal(options, layout, txRoot, limits)
          if (!equalJson(onDisk.journal, journal)) throw new LocalMaterializerStateError('legacy rollback journal changed')
          assertLegacyForwardPrefix(layout, txRoot, journal, onDisk.envelope, limits)
          const releaseLocks = await acquireLegacyGitResourceLocks(journal, txRoot, lease, false, checkpoint)
          let failure: unknown
          try {
            await assertLegacySiblingFence(options, layout, journal, limits, true)
            await publishLegacyForward({
              options, layout, txRoot, journal, envelope: onDisk.envelope,
              limits, revalidate: lease, checkpoint
            })
            assertLegacyAtDirection(layout, txRoot, journal, onDisk.envelope, limits, 'after')
            outcome = 'published'
          } catch (error) {
            failure = error
            throw error
          } finally {
            try { await releaseLocks() } catch (releaseError) {
              if (!failure || isLeaseLoss(releaseError)) throw releaseError
            }
          }
        },
        async rollback(context) {
          if (finished) return
          const lease: RevalidateLease = async () => { await context.revalidateLease() }
          await lease()
          await checkedIdentity(options.identities, worktree, input.identity)
          const onDisk = readLegacyJournal(options, layout, txRoot, limits)
          const releaseLocks = await acquireLegacyGitResourceLocks(journal, txRoot, lease, true, checkpoint)
          let failure: unknown
          try {
            await rollbackLegacyJournal({
              options, layout, txRoot, journal, envelope: onDisk.envelope,
              limits, revalidate: lease, checkpoint
            })
            outcome = 'rolledBack'
          } catch (error) {
            failure = error
            throw error
          } finally {
            try { await releaseLocks() } catch (releaseError) {
              if (!failure || isLeaseLoss(releaseError)) throw releaseError
            }
          }
        },
        async finalize(context) {
          if (finished) return
          const lease: RevalidateLease = async () => { await context.revalidateLease() }
          await lease()
          const onDisk = readLegacyJournal(options, layout, txRoot, limits)
          if (!outcome) throw new LocalMaterializerStateError('legacy rollback participant outcome is unknown')
          assertLegacyAtDirection(
            layout, txRoot, journal, onDisk.envelope, limits,
            outcome === 'published' ? 'after' : 'before'
          )
          await cleanupLegacyTransaction(
            layout, txRoot, limits, lease,
            outcome === 'published' ? 'forward' : 'backward',
            undefined,
            checkpoint
          )
          await lease()
          finished = true
        }
      }
      return {
        record,
        report: { preparedOperations: artifacts.length, preparedBytes: 0 },
        participant
      }
    } catch (error) {
      if (lstat(txRoot)) {
        try {
          if (samePath(txRoot, prepareRoot)) await removeCleanupTree(txRoot, limits, revalidate)
        } catch (cleanupError) {
          if (isLeaseLoss(cleanupError)) throw cleanupError
        }
      }
      throw error
    }
  }

  async function prepare(input: Parameters<MaterializePort['prepare']>[0]) {
    const revalidatePrepareLease: RevalidateLease = async () => {
      await input.guard.revalidateLease()
    }
    await revalidatePrepareLease()
    const worktree = await checkedIdentity(options.identities, input.worktree, input.identity)
    await revalidatePrepareLease()
    const layout = layoutOf(worktree)
    assertWorktreeConfigEnabled(gitConfigurationLayout(layout))
    if (!verifyMaterializePlanHash(input.plan) || !input.plan.executable
      || input.plan.summary.conflict !== 0
      || input.plan.pathKey !== input.identity.pathKey
      || input.plan.worktreeId !== input.identity.worktreeId
      || !verifyLibrarySnapshotManifest(input.snapshot)
      || !verifyRuntimeAssetManifest(input.runtimeAsset)) {
      throw new LocalMaterializerError('materialization plan or sources failed frozen validation')
    }
    const desiredResult = buildDesiredMaterialization({
      snapshot: input.snapshot,
      selectedSkills: input.plan.requested.selectedSkills,
      runtimeAsset: input.runtimeAsset,
      visibilityStateId: input.plan.requested.visibilityStateId
    })
    if (!desiredResult.ok || !equalJson(desiredResult.desired.requested, input.plan.requested)
      || input.snapshot.snapshotId !== input.plan.requested.snapshotId
      || input.runtimeAsset.runtimeAssetId !== input.plan.requested.runtimeAssetId
      || input.runtimeAsset.runtimeRevision !== input.plan.requested.runtimeRevision) {
      throw new LocalMaterializerError('materialization source inventories do not match the approved plan')
    }
    const desiredByPath = new Map(desiredResult.desired.artifacts.map((artifact) => [artifact.targetRelativePath, artifact]))
    const currentByPath = new Map((input.plan.current?.artifacts ?? []).map((artifact) => [artifact.targetRelativePath, artifact]))
    for (const operation of input.plan.operations) {
      const desired = desiredByPath.get(operation.targetRelativePath)
      const current = currentByPath.get(operation.targetRelativePath)
      const controlled = desired ?? current
      if (!controlled) throw new LocalMaterializerError('materialization operation has no controlled artifact')
      assertControlledTarget(controlled)
      if (operation.action === 'conflict'
        || operation.action !== 'delete' && (!desired || operation.after?.digest !== desired.digest)
        || operation.action === 'delete' && (desired || operation.after !== null)
        || operation.before?.digest !== current?.digest && !(operation.before === null && current === undefined)) {
        throw new LocalMaterializerError('materialization operations do not match their source inventories and marker')
      }
    }

    const reinspection = await inspect({
      worktree,
      identity: input.identity,
      snapshot: input.snapshot,
      runtimeAsset: input.runtimeAsset,
      selectedSkills: input.plan.requested.selectedSkills
    })
    await revalidatePrepareLease()
    if (reinspection.desiredVisibilityState.visibilityStateId !== input.plan.requested.visibilityStateId
      || input.plan.current !== null
        && reinspection.currentVisibilityState?.visibilityStateId !== input.plan.current.visibilityStateId
      || input.plan.current === null && reinspection.currentVisibilityState !== null) {
      throw new LocalMaterializerError('visibility ownership state changed after planning')
    }
    if (input.plan.markerStatus === 'valid') {
      if (!equalJson(reinspection.observedMarker, input.plan.current)) throw new LocalMaterializerError('materialization marker changed after planning')
    } else if (input.plan.markerStatus === 'missing' && reinspection.observedMarker !== null) {
      throw new LocalMaterializerError('materialization marker appeared after planning')
    }
    const observedByPath = new Map(reinspection.observations.map((fact) => [fact.targetRelativePath, fact]))
    const gitByPath = new Map(reinspection.gitFacts.map((fact) => [fact.targetRelativePath, fact]))
    for (const operation of input.plan.operations) {
      const fact = observedByPath.get(operation.targetRelativePath)
      const beforeMatches = fact?.kind === 'missing'
        ? operation.before === null
        : fact != null && operation.before != null
          && operation.before.kind === fact.kind
          && operation.before.digest === fact.digest
      if (!beforeMatches) {
        throw new LocalMaterializerError('materialization target changed after planning')
      }
      const git = gitByPath.get(operation.targetRelativePath)
      const gitOperation = input.plan.git.operations.find((candidate) => candidate.targetRelativePath === operation.targetRelativePath)
      if (!git || !gitOperation
        || gitOperation.beforeDigest !== git.factDigest
        || gitOperation.ownership !== git.ownership
        || gitOperation.ownershipStateId !== git.ownershipStateId
        || gitOperation.baselineDigest !== git.baselineDigest
        || gitOperation.restoreDigest !== git.restoreDigest
        || gitOperation.restoreSafe !== git.restoreSafe
        || gitOperation.action === 'conflict') {
        throw new LocalMaterializerError('Git visibility changed after planning')
      }
    }
    if (input.plan.git.configuration.beforeDigest !== reinspection.gitConfiguration.currentDigest
      || input.plan.git.configuration.afterDigest !== (input.plan.git.configuration.action === 'keep'
        ? reinspection.gitConfiguration.currentDigest : reinspection.gitConfiguration.desiredDigest)
      || input.plan.git.configuration.action === 'conflict') {
      throw new LocalMaterializerError('Git materialization configuration changed after planning')
    }

    const token = nextToken()
    if (!TOKEN.test(token)) throw new LocalMaterializerError('materialization transaction token is invalid')
    await ensureDirectory(layout.gitAdminRoot, layout.graftRoot, revalidatePrepareLease)
    await ensureDirectory(layout.graftRoot, layout.transactions, revalidatePrepareLease)
    const committedRoot = path.join(layout.transactions, token)
    const prepareRoot = path.join(layout.transactions, `.prepare-${token}`)
    if (lstat(committedRoot) || lstat(prepareRoot)) throw new LocalMaterializerError('materialization transaction already exists')
    await guardedMkdir(prepareRoot, revalidatePrepareLease)
    checkpoint('materializer-after-prepare-root', { operations: input.plan.operations.length })
    await revalidatePrepareLease()
    let txRoot = prepareRoot
    await ensureDirectory(txRoot, path.join(txRoot, 'staging'), revalidatePrepareLease)
    await ensureDirectory(txRoot, path.join(txRoot, 'backups'), revalidatePrepareLease)

    let preparedBytes = 0
    let preparedFiles = 0
    const artifactJournals: ArtifactJournal[] = []
    const createdParents = new Set<string>()
    for (const operation of input.plan.operations) {
      if (operation.action !== 'create' && operation.action !== 'update') continue
      const target = safeTarget(worktree, operation.targetRelativePath)
      if (target.pathEscaped) throw new LocalMaterializerError('materialization parent escaped after planning')
      const parentRelative = path.relative(worktree, path.dirname(target.target)).replaceAll('\\', '/')
      let cursor = worktree
      for (const segment of parentRelative.split('/').filter(Boolean)) {
        cursor = path.join(cursor, segment)
        if (!lstat(cursor)) createdParents.add(path.relative(worktree, cursor).replaceAll('\\', '/'))
      }
    }
    const plannedParents = [...createdParents].sort((left, right) => left.split('/').length - right.split('/').length)
    try {
      let journalIndex = 0
      for (const operation of input.plan.operations) {
        if (operation.action === 'keep') continue
        const index = journalIndex
        journalIndex += 1
        const desired = desiredByPath.get(operation.targetRelativePath)
        const stage = desired ? path.join(txRoot, 'staging', stageName(index)) : null
        if (desired && stage) {
          if (desired.kind === 'directory') {
            await guardedMkdir(stage, revalidatePrepareLease)
          }
          for (const file of desired.files) {
            preparedFiles += 1
            preparedBytes += file.size
            if (preparedFiles > limits.maxFiles || file.size > limits.maxFileBytes || preparedBytes > limits.maxTotalBytes) {
              throw new LocalMaterializerError('materialization staging exceeds its content limits')
            }
            const bytes = await verifiedSourceBytes(options, desired, file)
            const target = desired.kind === 'file'
              ? stage
              : path.join(stage, ...file.path.split('/'))
            if (!target) throw new LocalMaterializerError('materialization staging target is missing')
            if (desired.kind === 'directory') {
              await ensureDirectory(stage, path.dirname(target), revalidatePrepareLease)
              await writeStagedFile(target, bytes, file.mode, revalidatePrepareLease)
            } else await writeStagedFile(target, bytes, file.mode, revalidatePrepareLease)
          }
          const staged = observePath(worktree, desired, limits, stage)
          if (staged.unsafeDescendant || staged.digest !== desired.digest) {
            throw new LocalMaterializerError('staged materialization artifact failed digest verification')
          }
        }
        artifactJournals.push({
          artifactId: operation.artifactId,
          targetRelativePath: operation.targetRelativePath,
          kind: operation.kind,
          action: operation.action as 'create' | 'update' | 'delete',
          before: operation.before?.digest ?? null,
          after: operation.after?.digest ?? null,
          stageName: desired ? stageName(index) : null,
          backupName: `artifact-${String(index).padStart(4, '0')}`
        })
      }

      const resources: ResourceJournal[] = []
      const packageLayout = checkedPackageRoot(options, worktree)
      const configuration = gitConfigurationLayout(layout)
      assertWorktreeConfigEnabled(configuration)
      // Ordinary materialization has no common Git resource. Keep a stable
      // non-authorizing token in the journal without touching sibling state.
      const siblingConfigDigest = ORDINARY_SIBLING_FACTS_DIGEST

      const privateStage = path.join(txRoot, 'staging', 'private-exclude')
      const privateBefore = lstat(configuration.privateExclude)
        ? readPlainBytes(configuration.privateExclude, limits.maxGitConfigBytes, 'private worktree excludes') : null
      const managedPatterns = reinspection.desiredVisibilityState.targets
        .filter((target) => target.privateExcluded
          || target.ignoreOrigin === 'none' || target.ignoreOrigin === 'legacyCommon')
        .map((target) => `/${target.targetRelativePath}`)
        .sort(compareUtf8Bytes)
      const privateBytes = composedPrivateExcludes(reinspection.privateBaseExclude.bytes, managedPatterns)
      await writeStagedFile(privateStage, privateBytes, '100644', revalidatePrepareLease)
      await addResourceIfChanged(
        resources, 'privateExclude', configuration.privateExclude, privateStage,
        privateBefore, limits.maxGitConfigBytes, revalidatePrepareLease
      )

      const worktreeStage = path.join(txRoot, 'staging', 'worktree-config')
      const worktreeBefore = await copyOrCreateStage(
        configuration.worktreeConfig, worktreeStage, limits.maxGitConfigBytes, 'Git worktree config',
        revalidatePrepareLease
      )
      if (reinspection.desiredVisibilityState.targets.length > 0) {
        await setStagedConfig(
          worktree, worktreeStage, 'core.excludesFile', configuration.privateExclude, revalidatePrepareLease
        )
      } else if (reinspection.privateBaseExclude.scope === 'worktree') {
        await setStagedConfig(
          worktree, worktreeStage, 'core.excludesFile', reinspection.privateBaseExclude.locator,
          revalidatePrepareLease
        )
      } else {
        await unsetStagedConfig(worktree, worktreeStage, 'core.excludesFile', revalidatePrepareLease)
      }
      await setStagedConfig(worktree, worktreeStage, 'core.hooksPath', packageLayout.hooksPath, revalidatePrepareLease)
      await setStagedConfig(
        worktree, worktreeStage, 'ozdqp.localOverlaySource', packageLayout.packageRoot, revalidatePrepareLease
      )
      await setStagedConfig(
        worktree, worktreeStage, 'ozdqp.skillWatchWorkspace', packageLayout.dataRoot, revalidatePrepareLease
      )
      await addResourceIfChanged(
        resources, 'worktreeConfig', configuration.worktreeConfig, worktreeStage,
        worktreeBefore, limits.maxGitConfigBytes, revalidatePrepareLease
      )

      const visibility = input.plan.git.operations.filter((operation) => operation.action !== 'keep')
      const indexValue = runGit(worktree, ['rev-parse', '--git-path', 'index']).trim()
      const indexTarget = path.resolve(worktree, indexValue)
      const indexBefore = readPlainBytes(indexTarget, limits.maxGitIndexBytes, 'Git index')
      if (visibility.some((operation) => operation.action === 'setSkipWorktree'
        || operation.action === 'setSkipAndExclude'
        || operation.action === 'release' && (reinspection.currentVisibilityState?.targets
          .find((target) => target.targetRelativePath === operation.targetRelativePath)?.trackedPaths.length ?? 0) > 0)) {
        const stage = path.join(txRoot, 'staging', 'git-index')
        await revalidatePrepareLease()
        fs.copyFileSync(indexTarget, stage, fs.constants.COPYFILE_EXCL)
        await revalidatePrepareLease()
        const paths = visibility.flatMap((operation) => operation.action === 'setSkipWorktree' || operation.action === 'setSkipAndExclude'
          ? gitTracked(worktree, operation.targetRelativePath).paths.map((entry) => entry.path) : [])
        if (paths.length > 0) {
          const inputBytes = Buffer.from(`${paths.join('\0')}\0`, 'utf8')
          await revalidatePrepareLease()
          runGit(worktree, ['update-index', '--skip-worktree', '-z', '--stdin'], {
            env: { GIT_INDEX_FILE: stage }, input: inputBytes
          })
          await revalidatePrepareLease()
        }
        const releaseTargets = new Map((reinspection.currentVisibilityState?.targets ?? []).map((target) => [
          target.targetRelativePath, target
        ]))
        const restoreSkip = visibility.flatMap((operation) => operation.action === 'release'
          ? (releaseTargets.get(operation.targetRelativePath)?.trackedPaths ?? []).filter((entry) => entry.skipWorktree).map((entry) => entry.path)
          : [])
        const restoreNoSkip = visibility.flatMap((operation) => operation.action === 'release'
          ? (releaseTargets.get(operation.targetRelativePath)?.trackedPaths ?? []).filter((entry) => !entry.skipWorktree).map((entry) => entry.path)
          : [])
        if (restoreSkip.length > 0) {
          await revalidatePrepareLease()
          runGit(worktree, ['update-index', '--skip-worktree', '-z', '--stdin'], {
            env: { GIT_INDEX_FILE: stage }, input: Buffer.from(`${restoreSkip.join('\0')}\0`, 'utf8')
          })
          await revalidatePrepareLease()
        }
        if (restoreNoSkip.length > 0) {
          await revalidatePrepareLease()
          runGit(worktree, ['update-index', '--no-skip-worktree', '-z', '--stdin'], {
            env: { GIT_INDEX_FILE: stage }, input: Buffer.from(`${restoreNoSkip.join('\0')}\0`, 'utf8')
          })
          await revalidatePrepareLease()
        }
        await guardedFsyncFile(stage, revalidatePrepareLease)
        await addResourceIfChanged(
          resources, 'gitIndex', indexTarget, stage, indexBefore, limits.maxGitIndexBytes,
          revalidatePrepareLease
        )
      } else {
        addKeptResource(resources, 'gitIndex', indexTarget, indexBefore)
      }
      const state = reinspection.desiredVisibilityState
      if (state.visibilityStateId !== input.plan.requested.visibilityStateId) {
        throw new LocalMaterializerError('prepared visibility ownership state does not match the approved plan')
      }
      const privateTarget = visibilityPrivatePath(layout, state.visibilityStateId)
      const privateSidecarBytes = reinspection.currentVisibilityState?.visibilityStateId === state.visibilityStateId
        ? readPlainBytes(privateTarget, limits.maxGitConfigBytes, 'private visibility ownership state')
        : visibilityPrivateBytes(visibilityPrivateEnvelope(
          input.identity, state, reinspection.privateBaseExclude
        ))
      await addImmutableResource(
        resources,
        'visibilityPrivate',
        privateTarget,
        path.join(txRoot, 'staging', 'visibility-private'),
        privateSidecarBytes,
        limits.maxGitConfigBytes,
        revalidatePrepareLease
      )
      await addImmutableResource(
        resources,
        'visibilityState',
        visibilityStatePath(layout, state.visibilityStateId),
        path.join(txRoot, 'staging', 'visibility-state'),
        visibilityStateBytes(state),
        limits.maxMarkerBytes,
        revalidatePrepareLease
      )
      const marker = newMarker(input.plan, desiredResult.desired)
      const oldMarkerBytes = lstat(layout.marker) ? readPlainBytes(layout.marker, limits.maxMarkerBytes, 'materialization marker') : null
      const stagedMarker = markerBytes(marker)
      const markerStage = path.join(txRoot, 'staging', 'marker')
      await writeStagedFile(markerStage, stagedMarker, '100644', revalidatePrepareLease)
      await addResourceIfChanged(
        resources, 'marker', layout.marker, markerStage,
        oldMarkerBytes, limits.maxMarkerBytes, revalidatePrepareLease
      )
      resources.sort((left, right) => (
        ORDINARY_RESOURCE_KINDS.indexOf(left.kind) - ORDINARY_RESOURCE_KINDS.indexOf(right.kind)
      ))
      const journal: LocalMaterializationJournalV1 = {
        schemaVersion: 1,
        token,
        pathKey: input.identity.pathKey,
        worktreeId: input.identity.worktreeId,
        planHash: input.plan.planHash,
        oldMarker: input.plan.current,
        newMarker: marker,
        siblingConfigDigest,
        createdParents: plannedParents,
        createdResourceParents: [
          ...(!lstat(layout.visibilityPrivate) && resources.some((resource) => (
            resource.kind === 'visibilityPrivate' && resource.disposition === 'publish'
          ))
            ? ['visibility-private' as const] : []),
          ...(!lstat(layout.visibility) && resources.some((resource) => (
            resource.kind === 'visibilityState' && resource.disposition === 'publish'
          ))
            ? ['visibility' as const] : [])
        ],
        artifacts: artifactJournals,
        resources
      }
      validateJournal(layout, journal, limits)
      checkpoint('materializer-before-journal-write', { operations: artifactJournals.length })
      await atomicWrite(
        path.join(txRoot, 'journal.json'),
        Buffer.from(`${JSON.stringify(journal, null, 2)}\n`, 'utf8'),
        revalidatePrepareLease
      )
      checkpoint('materializer-before-journal-commit', { operations: artifactJournals.length })
      await guardedRename(prepareRoot, committedRoot, revalidatePrepareLease)
      txRoot = committedRoot
      checkpoint('materializer-prepared', { operations: artifactJournals.length, bytes: preparedBytes })
      let finished = false
      const participant: ApplicationTransactionParticipant = {
        participantId: `materialize-${token}`,
        async publish(context) {
          if (finished) throw new LocalMaterializerError('materialization participant is already finalized')
          await context.revalidateLease()
          await checkedIdentity(options.identities, worktree, input.identity)
          validateJournal(layout, journal, limits)
          const releaseGitLocks = await acquireGitResourceLocks(
            journal, txRoot, async () => context.revalidateLease(), false, checkpoint
          )
          let publicationError: unknown
          try {
            await context.revalidateLease()
            assertJournalPublishable(layout, txRoot, journal, limits, false)
            await context.revalidateLease()
            await publishParents(
              worktree, journal.createdParents, journal.newMarker.artifacts.map((artifact) => artifact.targetRelativePath),
              false, async () => context.revalidateLease()
            )
            await publishResourceParents(
              layout, journal.createdResourceParents, false, async () => context.revalidateLease()
            )
            await publishOrdinaryForward(
              layout, txRoot, journal, limits, async () => context.revalidateLease(), checkpoint
            )
            await context.revalidateLease()
            const publishedFacts = await inspect({
              worktree,
              identity: input.identity,
              snapshot: input.snapshot,
              runtimeAsset: input.runtimeAsset,
              selectedSkills: input.plan.requested.selectedSkills
            })
            await context.revalidateLease()
            const publishedGitByPath = new Map(publishedFacts.gitFacts.map((fact) => [fact.targetRelativePath, fact]))
            for (const planned of input.plan.git.operations) {
              let fact = publishedGitByPath.get(planned.targetRelativePath)
              if (!fact && planned.action === 'release') {
                const baseline = reinspection.currentVisibilityState?.targets.find(
                  (target) => target.targetRelativePath === planned.targetRelativePath
                )
                if (baseline) {
                  fact = createVisibilityFact({
                    ...inspectRawGit(worktree, planned.targetRelativePath),
                    ownership: 'unmanaged',
                    ownershipStateId: publishedFacts.currentVisibilityState?.visibilityStateId ?? null,
                    baselineDigest: visibilityOwnershipTargetBaselineDigest(baseline),
                    restoreDigest: null,
                    restoreSafe: true
                  })
                }
              }
              if (!fact || fact.factDigest !== planned.afterDigest) {
                throw new LocalMaterializerError(`published Git visibility does not match the approved after digest for ${planned.artifactId}`)
              }
            }
            if (publishedFacts.currentVisibilityState?.visibilityStateId !== input.plan.requested.visibilityStateId) {
              throw new LocalMaterializerStateError('published visibility ownership state does not match the marker')
            }
            if (publishedFacts.gitConfiguration.currentDigest !== input.plan.git.configuration.afterDigest) {
              throw new LocalMaterializerError('published Git configuration does not match the approved after digest')
            }
            if (!fullyPublished(layout, journal, limits)) throw new LocalMaterializerError('materialization publication could not be proven')
          } catch (error) {
            publicationError = error
            throw error
          } finally {
            try { await releaseGitLocks() } catch (releaseError) {
              if (!publicationError || isLeaseLoss(releaseError)) throw releaseError
            }
          }
        },
        async rollback(context) {
          if (finished) return
          await context.revalidateLease()
          await checkedIdentity(options.identities, worktree, input.identity)
          validateJournal(layout, journal, limits)
          const releaseGitLocks = await acquireGitResourceLocks(
            journal, txRoot, async () => context.revalidateLease(), true, checkpoint
          )
          let rollbackError: unknown
          try {
            await rollbackJournal(
              layout, txRoot, journal, limits, async () => context.revalidateLease(), checkpoint
            )
          } catch (error) {
            rollbackError = error
            throw error
          } finally {
            try { await releaseGitLocks() } catch (releaseError) {
              if (!rollbackError || isLeaseLoss(releaseError)) throw releaseError
            }
          }
        },
        async finalize(context) {
          if (finished) return
          await context.revalidateLease()
          validateJournal(layout, journal, limits)
          assertKeptResourcesCurrent(journal, limits)
          await cleanupTransaction(layout, txRoot, limits, true, () => {
            checkpoint('materializer-after-finalize-tombstone', { operations: journal.artifacts.length })
          }, async () => context.revalidateLease())
          await context.revalidateLease()
          finished = true
        }
      }
      return {
        marker,
        report: { preparedOperations: artifactJournals.length, preparedBytes },
        participant
      }
    } catch (error) {
      try {
        await cleanupTransaction(layout, txRoot, limits, false, undefined, revalidatePrepareLease)
      } catch (cleanupError) {
        if (isLeaseLoss(cleanupError)) throw cleanupError
        // Preserve the original preparation failure; recovery will inspect any
        // safe orphan that cleanup could not remove.
      }
      throw error
    }
  }

  async function recover(input: Parameters<MaterializePort['recover']>[0]): Promise<MaterializationRecoveryReport> {
    await input.guard.revalidateLease()
    const worktree = await checkedIdentity(options.identities, input.worktree, input.identity)
    await input.guard.revalidateLease()
    const layout = layoutOf(worktree)
    validateRecoveryTruth(input.identity, input.durable, input.pin, input.stateRevision)
    const recoveryEntries = (root: string, label: string): fs.Dirent[] => {
      if (!lstat(root)) return []
      assertPlainDirectory(root, label)
      return fs.readdirSync(root, { withFileTypes: true })
        .sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)))
    }
    const legacyEntries = recoveryEntries(
      layout.legacyTransactions, 'legacy materialization transactions root'
    )
    const ordinaryEntries = recoveryEntries(
      layout.transactions, 'materialization transactions root'
    )
    if (legacyEntries.length + ordinaryEntries.length > limits.maxRecoveryTransactions) {
      throw new LocalMaterializerStateError('too many materialization recovery transactions')
    }
    if (legacyEntries.length > 0 && ordinaryEntries.length > 0) {
      throw new LocalMaterializerStateError(
        'ordinary and legacy materialization transactions cannot recover concurrently'
      )
    }

    // Backup preparation roots contain only independent regular copies and a
    // private envelope. They are never a committed ownership claim and can be
    // cleaned independently. Final migration-id roots are permanent records,
    // including after a successful rollback, and are therefore retained.
    const abortedBackupTombstones = new Set<string>()
    const backupPreparationRoots: string[] = []
    if (lstat(layout.legacyBackups)) {
      await input.guard.revalidateLease()
      assertPlainDirectory(layout.legacyBackups, 'legacy materialization backups root')
      const backupEntries = fs.readdirSync(layout.legacyBackups, { withFileTypes: true })
        .sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)))
      if (backupEntries.length > limits.maxRecoveryTransactions + limits.maxArtifacts) {
        throw new LocalMaterializerStateError('too many legacy materialization backups')
      }
      for (const entry of backupEntries) {
        await input.guard.revalidateLease()
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          throw new LocalMaterializerStateError('legacy backup root contains an unknown entry')
        }
        const root = path.join(layout.legacyBackups, entry.name)
        assertPlainDirectory(root, 'legacy materialization backup')
        if (/^\.prepare-[0-9a-f]{64}-[0-9a-f]{16}$/.test(entry.name)) {
          assertSafeCleanupTree(root, limits)
          backupPreparationRoots.push(root)
          continue
        }
        const abortedMatch = /^\.abort-([0-9a-f]{64})-(.+)$/.exec(entry.name)
        if (abortedMatch && TOKEN.test(abortedMatch[2])) {
          abortedBackupTombstones.add(entry.name)
          continue
        }
        if (!/^[0-9a-f]{64}$/.test(entry.name)) {
          throw new LocalMaterializerStateError('legacy backup root contains an unknown entry')
        }
      }
    }

    const matchedAbortedBackupTombstones = new Set<string>()
    for (const entry of legacyEntries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new LocalMaterializerStateError(
          'legacy materialization recovery root contains an unknown entry'
        )
      }
      const txRoot = path.join(layout.legacyTransactions, entry.name)
      assertPlainDirectory(txRoot, 'legacy materialization transaction')
      const prepareMatch = /^\.prepare-(.+)$/.exec(entry.name)
      if (prepareMatch && TOKEN.test(prepareMatch[1])) {
        const claim = readLegacyPrepareClaim(txRoot, limits)
        if (claim && (claim.token !== prepareMatch[1]
          || claim.pathKey !== input.identity.pathKey
          || claim.worktreeId !== input.identity.worktreeId)) {
          throw new LocalMaterializerStateError(
            'legacy preparation claim identity does not match the worktree'
          )
        }
        if (claim?.dropBackupOnAbort) {
          const state = validateLegacyPrepareBackupCleanupState(
            options, layout, claim, limits
          )
          if (lstat(state.tombstone)) {
            const name = path.basename(state.tombstone)
            if (!abortedBackupTombstones.has(name)
              || matchedAbortedBackupTombstones.has(name)) {
              throw new LocalMaterializerStateError(
                'legacy aborted backup tombstone ownership is ambiguous'
              )
            }
            matchedAbortedBackupTombstones.add(name)
          }
        } else if (claim) {
          const unexpected = legacyPrepareBackupCleanupRoot(
            layout, claim.migrationId, claim.token
          )
          if (lstat(unexpected)) {
            throw new LocalMaterializerStateError(
              'retained legacy backup has an unexpected abort cleanup tombstone'
            )
          }
        }
        continue
      }
      const dropBackup = /^\.finalize-drop-backup-([0-9a-f]{64})-(.+)$/.exec(entry.name)
      const finalize = /^\.finalize-(forward|backward)-(.+)$/.exec(entry.name)
      if (!TOKEN.test(entry.name)
        && !(dropBackup && TOKEN.test(dropBackup[2]))
        && !(finalize && TOKEN.test(finalize[2]))) {
        throw new LocalMaterializerStateError(
          'legacy materialization recovery root contains an unknown entry'
        )
      }
    }
    if (matchedAbortedBackupTombstones.size !== abortedBackupTombstones.size) {
      throw new LocalMaterializerStateError('legacy aborted backup tombstone lost its preparation claim')
    }
    for (const root of backupPreparationRoots) {
      await removeCleanupTree(root, limits, async () => input.guard.revalidateLease())
    }

    if (legacyEntries.length > 0) {
      let finalized = 0
      let rolledBack = 0
      for (const entry of legacyEntries) {
        await input.guard.revalidateLease()
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          throw new LocalMaterializerStateError(
            'legacy materialization recovery root contains an unknown entry'
          )
        }
        const txRoot = path.join(layout.legacyTransactions, entry.name)
        assertPlainDirectory(txRoot, 'legacy materialization transaction')
        const prepareMatch = /^\.prepare-(.+)$/.exec(entry.name)
        if (prepareMatch && TOKEN.test(prepareMatch[1])) {
          // The token is published only after the complete V2 journal is
          // durable. A prepare root therefore cannot have published a target.
          const claim = readLegacyPrepareClaim(txRoot, limits)
          if (claim && (claim.token !== prepareMatch[1]
            || claim.pathKey !== input.identity.pathKey
            || claim.worktreeId !== input.identity.worktreeId)) {
            throw new LocalMaterializerStateError(
              'legacy preparation claim identity does not match the worktree'
            )
          }
          if (claim?.dropBackupOnAbort) {
            await cleanupLegacyPrepareBackup(
              options,
              layout,
              claim,
              limits,
              async () => input.guard.revalidateLease(),
              checkpoint
            )
            abortedBackupTombstones.delete(path.basename(
              legacyPrepareBackupCleanupRoot(layout, claim.migrationId, claim.token)
            ))
          } else if (claim) {
            const unexpectedTombstone = legacyPrepareBackupCleanupRoot(
              layout, claim.migrationId, claim.token
            )
            if (lstat(unexpectedTombstone)) {
              throw new LocalMaterializerStateError(
                'retained legacy backup has an unexpected abort cleanup tombstone'
              )
            }
          }
          assertSafeCleanupTree(txRoot, limits)
          await removeCleanupTree(
            txRoot, limits, async () => input.guard.revalidateLease()
          )
          rolledBack += 1
          continue
        }
        const dropBackupMatch = /^\.finalize-drop-backup-([0-9a-f]{64})-(.+)$/.exec(entry.name)
        if (dropBackupMatch && TOKEN.test(dropBackupMatch[2])) {
          const journal = readLegacyDropBackupTombstoneJournal(layout, txRoot, limits)
          if (journal.token !== dropBackupMatch[2]
            || legacyIdentifierHex(journal.migrationId, 'legacy migration identifier')
              !== dropBackupMatch[1]
            || journal.pathKey !== input.identity.pathKey
            || journal.worktreeId !== input.identity.worktreeId
            || legacyRecoveryDirection(input.durable, journal) !== 'backward') {
            throw new LocalMaterializerStateError(
              'legacy backup-drop tombstone does not match durable recovery truth'
            )
          }
          // The tombstone was published only after exact before-state proof.
          // Its static plan/record identity remains readable even if backup
          // cleanup itself was interrupted and the envelope is now partial.
          await cleanupLegacyBackupByMigrationId(
            layout,
            journal.migrationId,
            limits,
            async () => input.guard.revalidateLease()
          )
          assertSafeCleanupTree(txRoot, limits)
          await removeLegacyTombstoneTree(
            txRoot, limits, async () => input.guard.revalidateLease()
          )
          rolledBack += 1
          continue
        }
        const finalizeMatch = /^\.finalize-(forward|backward)-(.+)$/.exec(entry.name)
        if (finalizeMatch && TOKEN.test(finalizeMatch[2])) {
          const journalPath = path.join(txRoot, 'journal.json')
          const direction = finalizeMatch[1] as 'forward' | 'backward'
          if (lstat(journalPath)) {
            const onDisk = readLegacyJournal(options, layout, txRoot, limits)
            if (onDisk.journal.token !== finalizeMatch[2]
              || onDisk.journal.pathKey !== input.identity.pathKey
              || onDisk.journal.worktreeId !== input.identity.worktreeId) {
              throw new LocalMaterializerStateError(
                'legacy finalization tombstone identity does not match the worktree'
              )
            }
            const durableDirection = legacyRecoveryDirection(input.durable, onDisk.journal)
            if (durableDirection !== direction) {
              throw new LocalMaterializerStateError(
                'legacy finalization tombstone direction disagrees with durable truth'
              )
            }
            assertLegacyAtDirection(
              layout, txRoot, onDisk.journal, onDisk.envelope, limits,
              direction === 'forward' ? 'after' : 'before'
            )
          }
          await removeLegacyTombstoneTree(
            txRoot, limits, async () => input.guard.revalidateLease()
          )
          if (direction === 'forward') finalized += 1
          else rolledBack += 1
          continue
        }
        if (!TOKEN.test(entry.name)) {
          throw new LocalMaterializerStateError(
            'legacy materialization recovery root contains an unknown entry'
          )
        }
        const onDisk = readLegacyJournal(options, layout, txRoot, limits)
        const { journal, envelope } = onDisk
        if (journal.token !== entry.name
          || journal.pathKey !== input.identity.pathKey
          || journal.worktreeId !== input.identity.worktreeId) {
          throw new LocalMaterializerStateError(
            'legacy materialization journal identity does not match the worktree'
          )
        }
        const direction = legacyRecoveryDirection(input.durable, journal)
        // Reject reordered or ownerless intermediate states before acquiring
        // any Git claim, then prove the prefix again while the claims are held.
        if (direction === 'forward') {
          assertLegacyForwardPrefix(layout, txRoot, journal, envelope, limits)
        } else {
          assertLegacyBackwardRecoverable(layout, txRoot, journal, envelope, limits)
        }
        await assertLegacySiblingFence(options, layout, journal, limits, false)
        const releaseLocks = await acquireLegacyGitResourceLocks(
          journal, txRoot, async () => input.guard.revalidateLease(), true, checkpoint
        )
        let recoveryError: unknown
        try {
          if (direction === 'forward') {
            assertLegacyForwardPrefix(layout, txRoot, journal, envelope, limits)
          } else {
            assertLegacyBackwardRecoverable(layout, txRoot, journal, envelope, limits)
          }
          await assertLegacySiblingFence(options, layout, journal, limits, false)
          if (direction === 'forward') {
            if (journal.operationKind === 'legacyMigration') {
              const marker = journal.newMarker as MaterializationMarkerV1
              await publishParents(
                worktree,
                journal.createdParents,
                marker.artifacts.map((artifact) => artifact.targetRelativePath),
                true,
                async () => input.guard.revalidateLease()
              )
              await publishResourceParents(
                layout,
                journal.createdResourceParents,
                true,
                async () => input.guard.revalidateLease()
              )
            }
            await publishLegacyForward({
              options,
              layout,
              txRoot,
              journal,
              envelope,
              limits,
              revalidate: async () => input.guard.revalidateLease(),
              checkpoint
            })
            assertLegacyAtDirection(layout, txRoot, journal, envelope, limits, 'after')
          } else {
            await rollbackLegacyJournal({
              options,
              layout,
              txRoot,
              journal,
              envelope,
              limits,
              revalidate: async () => input.guard.revalidateLease(),
              checkpoint
            })
            assertLegacyAtDirection(layout, txRoot, journal, envelope, limits, 'before')
          }
        } catch (error) {
          recoveryError = error
          throw error
        } finally {
          try { await releaseLocks() } catch (releaseError) {
            if (!recoveryError || isLeaseLoss(releaseError)) throw releaseError
          }
        }
        await input.guard.revalidateLease()
        await cleanupLegacyTransaction(
          layout,
          txRoot,
          limits,
          async () => input.guard.revalidateLease(),
          direction,
          direction === 'backward' && journal.operationKind === 'legacyMigration'
            && journal.dropBackupOnAbort
            ? journal.migrationId
            : undefined,
          checkpoint
        )
        await input.guard.revalidateLease()
        if (direction === 'forward') finalized += 1
        else rolledBack += 1
      }
      if (abortedBackupTombstones.size !== 0) {
        throw new LocalMaterializerStateError('legacy aborted backup tombstone lost its preparation claim')
      }
      await input.guard.revalidateLease()
      const markerExists = lstat(layout.marker) !== null
      const marker = parseJsonFile(
        layout.marker, limits.maxMarkerBytes, 'legacy materialization marker'
      )
      const expected = input.durable?.marker ?? null
      if (!markerExists && expected !== null
        || markerExists && (!verifyMaterializationMarker(marker)
          || !expected || !equalJson(marker, expected))) {
        throw new LocalMaterializerStateError(
          'legacy materialization recovery did not reconcile marker truth'
        )
      }
      if (markerExists && verifyMaterializationMarker(marker)) {
        readCurrentVisibility(layout, input.identity, marker, limits)
      }
      await input.guard.revalidateLease()
      return {
        status: rolledBack > 0 ? 'rolled-back' : finalized > 0 ? 'finalized' : 'clean',
        recoveredTransactions: rolledBack + finalized
      }
    }
    if (abortedBackupTombstones.size !== 0) {
      throw new LocalMaterializerStateError('legacy aborted backup tombstone lost its preparation claim')
    }
    if (!lstat(layout.transactions)) {
      await input.guard.revalidateLease()
      const markerExists = lstat(layout.marker) !== null
      const marker = parseJsonFile(layout.marker, limits.maxMarkerBytes, 'materialization marker')
      const expected = input.durable?.marker ?? null
      if (!markerExists && expected === null) {
        await input.guard.revalidateLease()
        return { status: 'clean', recoveredTransactions: 0 }
      }
      if (!markerExists || !verifyMaterializationMarker(marker) || !expected || !equalJson(marker, expected)) {
        throw new LocalMaterializerStateError('external marker and durable materialization mirror disagree')
      }
      readCurrentVisibility(layout, input.identity, marker, limits)
      await input.guard.revalidateLease()
      return { status: 'clean', recoveredTransactions: 0 }
    }
    await input.guard.revalidateLease()
    assertPlainDirectory(layout.transactions, 'materialization transactions root')
    const entries = fs.readdirSync(layout.transactions, { withFileTypes: true })
      .sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)))
    if (entries.length > limits.maxRecoveryTransactions) throw new LocalMaterializerStateError('too many materialization recovery transactions')
    let finalized = 0
    let rolledBack = 0
    for (const entry of entries) {
      await input.guard.revalidateLease()
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new LocalMaterializerStateError('materialization recovery root contains an unknown entry')
      }
      const txRoot = path.join(layout.transactions, entry.name)
      assertPlainDirectory(txRoot, 'materialization transaction')
      if (entry.name.startsWith('.prepare-') && TOKEN.test(entry.name.slice('.prepare-'.length))) {
        // The final token name is published only after the complete journal is
        // fsynced. Under the worktree lease, a prepare directory is therefore
        // an orphan with no possible target publication.
        await input.guard.revalidateLease()
        await cleanupTransaction(layout, txRoot, limits, false, undefined, async () => input.guard.revalidateLease())
        await input.guard.revalidateLease()
        rolledBack += 1
        continue
      }
      if (entry.name.startsWith('.finalize-') && TOKEN.test(entry.name.slice('.finalize-'.length))) {
        // Tombstones are published only after terminal reconciliation. A
        // partial recursive delete can always resume without touching live
        // worktree or Git resources.
        await input.guard.revalidateLease()
        await cleanupTransaction(layout, txRoot, limits, false, undefined, async () => input.guard.revalidateLease())
        await input.guard.revalidateLease()
        finalized += 1
        continue
      }
      if (!TOKEN.test(entry.name)) {
        throw new LocalMaterializerStateError('materialization recovery root contains an unknown entry')
      }
      const journal = readJournal(txRoot, limits)
      if (journal.token !== entry.name || journal.pathKey !== input.identity.pathKey
        || journal.worktreeId !== input.identity.worktreeId) {
        throw new LocalMaterializerStateError('materialization journal identity does not match the worktree')
      }
      validateJournal(layout, journal, limits)
      const releaseGitLocks = await acquireGitResourceLocks(
        journal, txRoot, async () => input.guard.revalidateLease(), true, checkpoint
      )
      let recoveryError: unknown
      try {
        if (durableMatches(input.durable, journal.newMarker)) {
          await input.guard.revalidateLease()
          assertJournalPublishable(layout, txRoot, journal, limits, true)
          await publishParents(
            worktree, journal.createdParents, journal.newMarker.artifacts.map((artifact) => artifact.targetRelativePath),
            true, async () => input.guard.revalidateLease()
          )
          await publishResourceParents(
            layout, journal.createdResourceParents, true, async () => input.guard.revalidateLease()
          )
          await publishOrdinaryForward(
            layout, txRoot, journal, limits, async () => input.guard.revalidateLease(), checkpoint
          )
          await input.guard.revalidateLease()
          if (!fullyPublished(layout, journal, limits)) {
            throw new LocalMaterializerStateError('durable-new recovery could not prove complete external publication')
          }
          // Complete semantic proof must precede the finalize tombstone. If
          // it fails, the journal and backups remain available for repair.
          assertPublishedMarkerAndVisibility(layout, input.identity, journal.newMarker, limits)
          await cleanupTransaction(
            layout, txRoot, limits, true, undefined, async () => input.guard.revalidateLease()
          )
          await input.guard.revalidateLease()
          finalized += 1
        } else if (oldDurable(input.durable, journal)) {
          await rollbackJournal(
            layout, txRoot, journal, limits, async () => input.guard.revalidateLease(), checkpoint
          )
          await input.guard.revalidateLease()
          await cleanupTransaction(
            layout, txRoot, limits, true, undefined, async () => input.guard.revalidateLease()
          )
          await input.guard.revalidateLease()
          rolledBack += 1
        } else {
          throw new LocalMaterializerStateError('durable mirror does not identify a safe recovery direction')
        }
      } catch (error) {
        recoveryError = error
        throw error
      } finally {
        try { await releaseGitLocks() } catch (releaseError) {
          if (!recoveryError || isLeaseLoss(releaseError)) throw releaseError
        }
      }
    }
    await input.guard.revalidateLease()
    const markerExists = lstat(layout.marker) !== null
    const marker = parseJsonFile(layout.marker, limits.maxMarkerBytes, 'materialization marker')
    const expected = input.durable?.marker ?? null
    if (!markerExists && expected !== null
      || markerExists && (!verifyMaterializationMarker(marker) || !expected || !equalJson(marker, expected))) {
      throw new LocalMaterializerStateError('materialization recovery did not reconcile marker truth')
    }
    if (markerExists && verifyMaterializationMarker(marker)) {
      readCurrentVisibility(layout, input.identity, marker, limits)
    }
    await input.guard.revalidateLease()
    return {
      status: rolledBack > 0 ? 'rolled-back' : finalized > 0 ? 'finalized' : 'clean',
      recoveredTransactions: rolledBack + finalized
    }
  }

  return {
    inspect,
    inspectLegacy,
    inspectLegacyRollback,
    prepare,
    recover,
    prepareLegacyMigration,
    prepareLegacyRollback
  }
}
