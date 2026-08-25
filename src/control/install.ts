import fs from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { createServer, type Server } from 'node:net'
import { TextDecoder } from 'node:util'
import { createNodePath } from '../adapters/node-path.js'
import {
  createInstallHost,
  type InstallHost,
  type UserEnvironmentState,
  type UserPathState
} from '../adapters/install-host.js'
import {
  createDaemonProcessHost,
  type DaemonProcessHost
} from '../adapters/daemon-process-host.js'
import {
  APPLICATION_LEASE_NAMESPACE_MARKER,
  applicationLeaseRoot,
  assertApplicationLeaseNamespaceSafe,
  assertLegacyApplicationLeaseNamespaceClear,
  createLeaseLockManager
} from '../adapters/lease-lock.js'
import type { DurableLease } from '../adapters/durable-state.js'
import { flushDirectory } from '../adapters/durable-files.js'
import { resolveLocalInvocationTraceGate } from '../adapters/local-invocation-trace.js'
import { LOCAL_RUNTIME_ASSET_PATHS } from '../adapters/local-runtime-assets.js'
import { validateLockRecordV1, type LockRecordV1 } from '../contracts/index.js'
import {
  coherentDataRootEnvironment,
  LEGACY_DATA_ROOT_ENV,
  localDataRootsEqual,
  PRIMARY_DATA_ROOT_ENV,
  resolveLocalDataRoot
} from '../local/data-root.js'
import {
  describeLocalCodexRuntime,
  resolveLocalCodexRuntime
} from '../local/session/local-codex-runtime.js'
import {
  API_PORT,
  DATA_ROOT_MARKER_VERSION,
  evaluateDoctor,
  expectedTaskAction,
  INSTALL_MANIFEST_VERSION,
  LIFECYCLE_ROOT_RECEIPT_VERSION,
  layoutSpec,
  mergeUserPath,
  pathHasDir,
  PRODUCT_ALIAS,
  PRODUCT_COMMAND,
  PRODUCT_NAME,
  PUBLIC_RUNTIME_CORPUS_VERSION,
  removeFromUserPath,
  renderShims,
  resolveInstallDir,
  resolveInstallPaths,
  TASK_NAME,
  type DataRootMarkerV1,
  type DaemonLauncherEnvironment,
  type DaemonLifecycleReceiptAuthoritySnapshot,
  type DaemonTraceEnvironment,
  type DaemonStatus,
  type InstallPaths,
  type InstallManifestV2,
  type LifecycleIntegrationStateV1,
  type LifecycleRootReceiptV1,
  type LifecycleExternalArtifactFactV1,
  type LifecycleExternalArtifactV1,
  type LifecycleWalV1,
  type OwnedEnvironmentValue,
  type OwnedInstallFile,
  type PurgeFlags,
  type PurgePlanV1,
  type PurgeResult,
  type Sha256Digest,
  type DoctorFacts,
  type DoctorIssue,
  type DoctorReport,
  type SetupFlags,
  type SetupResult,
  type SetupStep,
  type UninstallResult,
  type UpgradeFlags,
  type UpgradeResult
} from '../local/lifecycle/install-domain.js'
import {
  apiProcessMatches,
  assertDaemonMarkerSetCurrent,
  daemonProcessMatches,
  heartbeatBindsInstance,
  inspectDaemonMarkerSet,
  loopbackListenerPresent,
  pingApi,
  probeDaemonApiHealth,
  readHeartbeat,
  reviewFiles
} from './daemon.js'
import {
  observeDaemonAuthority,
  type DaemonAuthorityObservation,
  type DaemonRuntimeHealthProbe,
  type DaemonRuntimeProtocolOptions
} from './daemon-runtime.js'
import {
  stopDaemonRuntime,
  type DaemonLegacyControlHint
} from './daemon-control-runtime.js'
import {
  assertDaemonInspectionCurrent,
  captureDaemonProtocolFile,
  daemonInnerNamespaceMarker,
  daemonFileIdentity,
  inspectDaemonProtocol,
  type DaemonLifecycleOwnerAuthoritySnapshot,
  type DaemonLifecycleOwnerBindingV1,
  type DaemonProtocolCheckpoint,
  type DaemonSha256,
  type InspectDaemonProtocolOptions
} from './daemon-protocol.js'

const pathApi = createNodePath()
const PUBLIC_RUNTIME_FILES = Object.freeze([
  'AGENTS.override.md',
  ...LOCAL_RUNTIME_ASSET_PATHS.map((name) => `overlay/${name}`)
])
const MANAGED_INSTALL_ROOT_FILES = new Set(['install.json', 'silent-run.vbs', 'run-daemon.cmd'])
const MANAGED_INSTALL_BIN_FILES = new Set([PRODUCT_COMMAND, `${PRODUCT_COMMAND}.cmd`, `${PRODUCT_ALIAS}.cmd`])
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const SEMVER_VERSION = /^([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
const DATA_ROOT_DIR_NAME = 'skill-graft-data'
const MANIFEST_MAX_BYTES = 1024 * 1024
const MARKER_MAX_BYTES = 512 * 1024
const LIFECYCLE_LOCK_MAX_BYTES = 64 * 1024
const LIFECYCLE_WAL_MAX_BYTES = 1024 * 1024
const LIFECYCLE_ROOT_RECEIPT_MAX_BYTES = 64 * 1024
const PURGE_WAL_MAX_BYTES = 64 * 1024 * 1024
const LIFECYCLE_ROOT_RECEIPT_DIR = '.skill-graft-lifecycle'
const LIFECYCLE_ROOT_RECEIPT_NAMESPACE_MARKER = '.namespace-v1.skill-graft.marker'
const LIFECYCLE_ROOT_RECEIPT_FILE = 'root-receipt-v1.json'
const LIFECYCLE_ROOT_RECEIPT_PENDING = 'root-receipt-v1.pending.json'
const LIFECYCLE_ROOT_RECEIPT_WRITER_LEASE_MS = 30_000
const LIFECYCLE_ROOT_RECEIPT_WRITING = /^\.root-receipt-v1\.([a-f0-9]{64})\.([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([1-9][0-9]{0,15})\.([a-f0-9]{64})\.([1-9][0-9]{0,15})\.writing$/i
const LIFECYCLE_OWNER_STAGE_AUTHORITY_MARKER = /^\.owner-stage-namespace-v1\.([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.marker$/i
const LIFECYCLE_DAEMON_STAGE_AUTHORITY_MARKER = /^\.daemon-stage-namespace-v1\.([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.marker$/
const LIFECYCLE_OWNER_STAGE_NAMESPACE_MARKER = /^\.namespace-v1\.([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.skill-graft\.marker$/i
const LIFECYCLE_OWNER_STAGE = /^\.sg-owner-v1\.([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([a-f0-9]{12})\.([a-f0-9]{24})\.([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([1-9][0-9]{0,15})\.([a-f0-9]{16})\.([1-9][0-9]{0,15})\.([sgurp])\.([a-f0-9]{12})\.owner-stage$/i
const LIFECYCLE_OWNER_STAGE_RECORD = 'owner.json'
const PURGE_WAL_STAGE = /^\.purge-wal-v1\.([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.stage$/i
const LIFECYCLE_ROOT_RECEIPT_PROCESS_IDENTITY = createHash('sha256')
  .update(`${process.pid}\0${process.execPath}\0${process.argv.join('\0')}\0${process.hrtime.bigint()}\0${randomUUID()}`)
  .digest('hex')
const INTEGRATION_VALUE_MAX_BYTES = 64 * 1024
const LIFECYCLE_ENV_NAMES = Object.freeze([
  PRIMARY_DATA_ROOT_ENV,
  LEGACY_DATA_ROOT_ENV,
  'HUB_API_PORT'
] as const)

type StartDaemonDependencies = {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  ping?: typeof pingApi
  processHost?: DaemonProcessHost
}

type StopDaemonDependencies = {
  processHost?: DaemonProcessHost
  healthProbe?: DaemonRuntimeHealthProbe
  ping?: typeof pingApi
  checkpoint?: DaemonProtocolCheckpoint
  timeoutMs?: number
}

type LifecycleRecoveryPrivateHooks = {
  checkpoint?: (name: 'after-committed-uninstall-acquire-authority') => void | Promise<void>
  daemonStop?: StopDaemonDependencies
}

type FrozenInstallEnvironment = Readonly<NodeJS.ProcessEnv>

type FrozenDaemonTracePreflight = Readonly<{
  baseEnvironment: FrozenInstallEnvironment
  daemonTrace?: DaemonTraceEnvironment
}>

type PackageIdentity = {
  packageRoot: string
  version: string
  sha256: Sha256Digest
  publicRuntime: ReadonlyMap<string, Buffer>
  publicRuntimeFacts: DataRootMarkerV1['runtime']['files']
}

type ParsedSemVer = Readonly<{
  core: readonly [string, string, string]
  prerelease: readonly string[] | null
}>

function parseSemVerVersion(value: string, label: string): ParsedSemVer {
  const match = SEMVER_VERSION.exec(value)
  if (!match) throw new Error(`${label} is not a valid semantic version`)
  const core = [match[1], match[2], match[3]] as const
  if (core.some((identifier) => identifier.length > 1 && identifier.startsWith('0'))) {
    throw new Error(`${label} is not a valid semantic version`)
  }
  const prerelease = match[4]?.split('.') || null
  if (prerelease?.some((identifier) => /^[0-9]+$/.test(identifier)
    && identifier.length > 1 && identifier.startsWith('0'))) {
    throw new Error(`${label} is not a valid semantic version`)
  }
  return { core, prerelease }
}

function compareNumericSemVerIdentifier(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  return left === right ? 0 : left < right ? -1 : 1
}

function compareSemVerVersions(left: string, right: string): number {
  const leftVersion = parseSemVerVersion(left, 'candidate release version')
  const rightVersion = parseSemVerVersion(right, 'installed release version')
  for (let index = 0; index < leftVersion.core.length; index += 1) {
    const compared = compareNumericSemVerIdentifier(leftVersion.core[index], rightVersion.core[index])
    if (compared !== 0) return compared
  }
  if (!leftVersion.prerelease && !rightVersion.prerelease) return 0
  if (!leftVersion.prerelease) return 1
  if (!rightVersion.prerelease) return -1
  const count = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length)
  for (let index = 0; index < count; index += 1) {
    const leftIdentifier = leftVersion.prerelease[index]
    const rightIdentifier = rightVersion.prerelease[index]
    if (leftIdentifier === undefined) return -1
    if (rightIdentifier === undefined) return 1
    const leftNumeric = /^[0-9]+$/.test(leftIdentifier)
    const rightNumeric = /^[0-9]+$/.test(rightIdentifier)
    if (leftNumeric && rightNumeric) {
      const compared = compareNumericSemVerIdentifier(leftIdentifier, rightIdentifier)
      if (compared !== 0) return compared
      continue
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    if (leftIdentifier !== rightIdentifier) return leftIdentifier < rightIdentifier ? -1 : 1
  }
  return 0
}

type IntegrationSnapshot = {
  files: Map<string, Buffer | null>
  directories: Map<string, boolean>
  userPath: UserPathState
  pathManaged: boolean
  environment: Map<string, UserEnvironmentState>
  taskExisted: boolean
  taskLauncher: string
  taskManaged: boolean
  installDirExisted: boolean
  dataRootExisted: boolean
}

type IntegrationExpected = {
  files: Map<string, Buffer | null>
  userPath: UserPathState
  pathManaged: boolean
  environment: Map<string, UserEnvironmentState>
  taskExisted: boolean
  taskLauncher: string
  taskManaged: boolean
}

function unmanagedUserPathState(): UserPathState {
  return { exists: false, value: '', kind: null }
}

function absentUserEnvironmentState(): UserEnvironmentState {
  return { exists: false, value: '', kind: null }
}

function sameUserEnvironmentState(left: UserEnvironmentState, right: UserEnvironmentState): boolean {
  return left.exists === right.exists && left.value === right.value && left.kind === right.kind
}

function sameUserPathState(left: UserPathState, right: UserPathState): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function lifecycleUserPathValue(state: LifecycleIntegrationStateV1['userPath']): UserPathState {
  return { exists: state.exists, value: state.value, kind: state.kind }
}

function userPathStateWithValue(prior: UserPathState, value: string): UserPathState {
  return {
    exists: true,
    value,
    kind: prior.exists ? prior.kind : 'ExpandString'
  }
}

function uninstallUserPathTarget(
  current: UserPathState,
  manifest: InstallManifestV2,
  host: InstallHost
): UserPathState {
  const classified = classifyUninstallUserPathTarget(current, manifest, host)
  if (!classified.owned) throw new Error('owned user PATH entry is no longer in the removable position')
  return classified.target
}

function classifyUninstallUserPathTarget(
  current: UserPathState,
  manifest: InstallManifestV2,
  host: InstallHost
): { owned: boolean; target: UserPathState } {
  const owned = manifest.owned.pathEntry
  if (!owned.added) return { owned: false, target: current }
  const prior = owned.prior
  if (!prior) throw new Error('owned user PATH is missing its prior state')
  if (!current.exists || current.kind === null) return { owned: false, target: current }
  const removed = removeFromUserPath(current.value, owned.value, host.pathSep, host.caseInsensitive)
  if (!removed.changed) return { owned: false, target: current }
  if (prior.exists && removed.path === prior.value && current.kind === prior.kind) {
    return { owned: true, target: { ...prior } }
  }
  if (!prior.exists && current.value === owned.value) {
    return { owned: true, target: { ...prior } }
  }
  return {
    owned: true,
    target: {
      exists: true,
      value: removed.path,
      kind: current.kind
    }
  }
}

const verifiedLifecycleLinkedTargets = new Map<string, { stage: string; dev: number; ino: number }>()

function isVerifiedLifecycleLinkedTarget(file: string, stat: fs.Stats): boolean {
  const linked = verifiedLifecycleLinkedTargets.get(resolve(file))
  if (!linked || stat.nlink !== 2 || stat.dev !== linked.dev || stat.ino !== linked.ino) return false
  try {
    const stage = fs.lstatSync(linked.stage)
    return stage.isFile() && !stage.isSymbolicLink() && stage.nlink === 2
      && stage.dev === stat.dev && stage.ino === stat.ino
  } catch {
    return false
  }
}

function sha256Bytes(value: string | Buffer): Sha256Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function captureExternalArtifactFact(file: string): LifecycleExternalArtifactFactV1 | null {
  const before = lstatOptional(file)
  if (!before) return null
  const base = {
    dev: before.dev,
    ino: before.ino,
    mode: before.mode,
    size: before.size,
    mtimeMs: before.mtimeMs,
    nlink: before.nlink
  }
  if (before.isSymbolicLink()) {
    const linkTarget = fs.readlinkSync(file)
    const after = fs.lstatSync(file)
    if (after.dev !== before.dev || after.ino !== before.ino || after.mode !== before.mode
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.nlink !== before.nlink) {
      throw new Error(`external lifecycle artifact changed while captured: ${file}`)
    }
    return { kind: 'symlink', ...base, sha256: null, linkTarget }
  }
  if (!before.isFile()) {
    return {
      kind: before.isDirectory() ? 'directory' : 'other',
      ...base,
      sha256: null,
      linkTarget: null
    }
  }
  let sha256: Sha256Digest | null = null
  if (before.size <= 64 * 1024 * 1024) {
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    try {
      const opened = fs.fstatSync(descriptor)
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
        || opened.mode !== before.mode || opened.size !== before.size || opened.nlink !== before.nlink) {
        throw new Error(`external lifecycle artifact changed before read: ${file}`)
      }
      let offset = 0
      while (offset < opened.size) {
        const count = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, opened.size - offset), offset)
        if (count <= 0) throw new Error(`external lifecycle artifact ended before its captured size: ${file}`)
        hash.update(buffer.subarray(0, count))
        offset += count
      }
      if (fs.readSync(descriptor, buffer, 0, 1, offset) !== 0) {
        throw new Error(`external lifecycle artifact grew while read: ${file}`)
      }
      const afterRead = fs.fstatSync(descriptor)
      if (afterRead.dev !== opened.dev || afterRead.ino !== opened.ino || afterRead.mode !== opened.mode
        || afterRead.size !== opened.size || afterRead.mtimeMs !== opened.mtimeMs || afterRead.nlink !== opened.nlink) {
        throw new Error(`external lifecycle artifact changed while read: ${file}`)
      }
      sha256 = `sha256:${hash.digest('hex')}`
    } finally {
      fs.closeSync(descriptor)
    }
  }
  const after = fs.lstatSync(file)
  if (after.dev !== before.dev || after.ino !== before.ino || after.mode !== before.mode
    || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.nlink !== before.nlink) {
    throw new Error(`external lifecycle artifact changed while captured: ${file}`)
  }
  return { kind: 'file', ...base, sha256, linkTarget: null }
}

function sameExternalArtifactFact(
  left: LifecycleExternalArtifactFactV1 | null,
  right: LifecycleExternalArtifactFactV1 | null
): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function assertExternalArtifactFactCurrent(file: string, expected: LifecycleExternalArtifactFactV1 | null, label: string): void {
  if (!sameExternalArtifactFact(captureExternalArtifactFact(file), expected)) {
    throw new Error(`${label} changed after its uninstall action was frozen`)
  }
}

function planUninstallExternalArtifacts(
  paths: InstallPaths,
  manifest: InstallManifestV2,
  platform: NodeJS.Platform | string
): LifecycleExternalArtifactV1[] {
  return manifest.owned.files
    .filter((entry) => !isSameOrInside(paths.installDir, entry.path, platform))
    .map((entry) => {
      const before = captureExternalArtifactFact(entry.path)
      const action: LifecycleExternalArtifactV1['action'] = before === null
        ? 'preserve-absent'
        : before.kind === 'file' && before.nlink === 1 && before.sha256 === entry.sha256
          ? 'delete-exact'
          : 'preserve-foreign'
      return { path: resolve(entry.path), ownedSha256: entry.sha256, action, before }
    })
    .sort((left, right) => left.path.localeCompare(right.path))
}

function sha256File(file: string, maxBytes = 256 * 1024 * 1024, allowLinked = false): Sha256Digest {
  const before = fs.lstatSync(file)
  const verifiedLinked = !allowLinked && isVerifiedLifecycleLinkedTarget(file, before)
  if (!before.isFile() || before.isSymbolicLink()
    || before.nlink < 1 || before.nlink > (allowLinked || verifiedLinked ? 2 : 1) || before.size > maxBytes) {
    throw new Error(`hashed lifecycle file is not a bounded unique plain file: ${file}`)
  }
  const descriptor = fs.openSync(file, 'r')
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    const opened = fs.fstatSync(descriptor)
    if (opened.dev !== before.dev || opened.ino !== before.ino
      || opened.size !== before.size || opened.nlink !== before.nlink) {
      throw new Error(`hashed lifecycle file changed before read: ${file}`)
    }
    let total = 0
    for (;;) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null)
      if (count === 0) break
      total += count
      if (total > maxBytes) throw new Error(`hashed lifecycle file exceeds its bound: ${file}`)
      hash.update(buffer.subarray(0, count))
    }
    const after = fs.fstatSync(descriptor)
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || after.nlink !== opened.nlink) {
      throw new Error(`hashed lifecycle file changed while read: ${file}`)
    }
  } finally {
    fs.closeSync(descriptor)
  }
  const pathAfter = fs.lstatSync(file)
  if (!pathAfter.isFile() || pathAfter.isSymbolicLink()
    || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino || pathAfter.size !== before.size
    || pathAfter.mtimeMs !== before.mtimeMs || pathAfter.nlink !== before.nlink) {
    throw new Error(`hashed lifecycle file path changed while read: ${file}`)
  }
  return `sha256:${hash.digest('hex')}`
}

function readBoundedPlainFile(file: string, maxBytes: number, label: string, allowLinked = false): Buffer {
  const before = fs.lstatSync(file)
  const verifiedLinked = !allowLinked && isVerifiedLifecycleLinkedTarget(file, before)
  if (!before.isFile() || before.isSymbolicLink()
    || before.nlink < 1 || before.nlink > (allowLinked || verifiedLinked ? 2 : 1) || before.size > maxBytes) {
    throw new Error(`${label} is not a bounded unique plain file`)
  }
  const descriptor = fs.openSync(file, 'r')
  try {
    const opened = fs.fstatSync(descriptor)
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error(`${label} changed before read`)
    }
    const bytes = Buffer.alloc(opened.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset)
      if (count === 0) throw new Error(`${label} ended before its recorded size`)
      offset += count
    }
    const after = fs.fstatSync(descriptor)
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      throw new Error(`${label} changed while read`)
    }
    const pathAfter = fs.lstatSync(file)
    if (!pathAfter.isFile() || pathAfter.isSymbolicLink()
      || pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino
      || pathAfter.size !== opened.size || pathAfter.mtimeMs !== opened.mtimeMs
      || pathAfter.nlink !== opened.nlink) {
      throw new Error(`${label} path changed while read`)
    }
    return bytes
  } finally {
    fs.closeSync(descriptor)
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

type LifecycleWriteAuthority = Pick<LifecycleWalV1, 'walId' | 'lockToken'>
type DirectoryFence = Map<string, { dev: number; ino: number }>
type LifecycleMutationFence = {
  directories: DirectoryFence
  absent: Set<string>
  plannedDirectories: Set<string>
  writableRoots: string[]
  exactFiles: Set<string>
}

type CapturedFileState = {
  bytes: Buffer | null
  stat: { dev: number; ino: number; size: number; mtimeMs: number; nlink: number } | null
}

type CapturedHashedFileState = {
  sha256: Sha256Digest
  stat: { dev: number; ino: number; size: number; mtimeMs: number; nlink: number }
}

type CapturedOptionalPlainDirectoryIdentity = { dev: number; ino: number } | null

function captureOptionalPlainDirectoryIdentity(
  directory: string,
  label: string
): CapturedOptionalPlainDirectoryIdentity {
  const stat = lstatOptional(directory)
  if (!stat) return null
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} is not a plain directory`)
  return { dev: stat.dev, ino: stat.ino }
}

function assertOptionalPlainDirectoryIdentity(
  directory: string,
  expected: CapturedOptionalPlainDirectoryIdentity,
  label: string
): void {
  const current = captureOptionalPlainDirectoryIdentity(directory, label)
  if (canonicalJson(current) !== canonicalJson(expected)) {
    throw new Error(`${label} changed across the purge protocol epoch`)
  }
}

const lifecycleMutationFences = new Map<string, LifecycleMutationFence>()

const LIFECYCLE_STAGE_NAME = /^\..+\.([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.lifecycle-stage$/i

function lifecycleStagePath(target: string, authority: LifecycleWriteAuthority): string {
  if (!UUID.test(authority.walId) || !UUID.test(authority.lockToken)) {
    throw new Error('lifecycle staging requires a valid WAL and owner binding')
  }
  return join(dirname(target), `.${basename(target)}.${authority.walId}.${authority.lockToken}.lifecycle-stage`)
}

function isLifecycleStageName(name: string): boolean {
  return LIFECYCLE_STAGE_NAME.test(name)
}

function lifecycleAuthorityKey(authority: LifecycleWriteAuthority): string {
  return `${authority.walId}:${authority.lockToken}`
}

function planLifecycleDirectory(fence: LifecycleMutationFence, directory: string): void {
  const absolute = resolve(directory)
  fence.plannedDirectories.add(absolute)
  let cursor = absolute
  const missing: string[] = []
  let stat = lstatOptional(cursor)
  while (!stat) {
    missing.push(cursor)
    const parent = dirname(cursor)
    if (samePath(parent, cursor, process.platform)) break
    cursor = parent
    stat = lstatOptional(cursor)
  }
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`lifecycle mutation path has no plain existing ancestor: ${absolute}`)
  }
  captureDirectoryFence(cursor, fence.directories)
  for (const item of missing) fence.absent.add(item)
}

function registerLifecycleMutationFence(paths: InstallPaths, wal: LifecycleWalV1): void {
  const writableRoots = [paths.installDir, paths.dataRoot]
  const exactFiles = new Set([resolve(paths.lifecycleWalPath), resolve(paths.lifecycleLockPath)])
  const directories = new Map<string, { dev: number; ino: number }>()
  const fence: LifecycleMutationFence = {
    directories,
    absent: new Set(),
    plannedDirectories: new Set(),
    writableRoots: writableRoots.map((item) => resolve(item)),
    exactFiles
  }
  const manifests = [wal.oldManifest, wal.newManifest].filter(Boolean) as InstallManifestV2[]
  for (const manifest of manifests) {
    for (const file of manifest.owned.files) {
      exactFiles.add(resolve(file.path))
      planLifecycleDirectory(fence, dirname(file.path))
    }
  }
  for (const directory of [
    dirname(paths.lifecycleWalPath),
    dirname(paths.lifecycleLockPath),
    paths.installDir,
    paths.dataRoot,
    ...layoutSpec(paths.dataRoot, pathApi).dirs,
    ...layoutSpec(paths.dataRoot, pathApi).files.map((file) => dirname(file.path)),
    ...PUBLIC_RUNTIME_FILES.map((file) => dirname(join(paths.dataRoot, ...file.split('/')))),
    ...(wal.tombstone ? [dirname(wal.tombstone)] : [])
  ]) planLifecycleDirectory(fence, directory)
  exactFiles.add(resolve(paths.dataMarkerPath))
  exactFiles.add(resolve(paths.manifestPath))
  lifecycleMutationFences.set(lifecycleAuthorityKey(wal), fence)
}

function registerTerminalLifecycleProtocolMutationFence(paths: InstallPaths, wal: LifecycleWalV1): void {
  const exactFiles = new Set([resolve(paths.lifecycleWalPath), resolve(paths.lifecycleLockPath)])
  const directories = new Map<string, { dev: number; ino: number }>()
  const fence: LifecycleMutationFence = {
    directories,
    absent: new Set(),
    plannedDirectories: new Set(),
    writableRoots: [],
    exactFiles
  }
  // A committed uninstall only transitions the preserved receipt and removes
  // its lifecycle WAL.  Its historical install/package tree is no longer an
  // owned mutation target and may have been replaced by unrelated bytes.
  for (const directory of new Set([
    dirname(paths.lifecycleWalPath),
    dirname(paths.lifecycleLockPath)
  ])) planLifecycleDirectory(fence, directory)
  lifecycleMutationFences.set(lifecycleAuthorityKey(wal), fence)
}

function lifecycleMutationFenceFor(target: string, authority: LifecycleWriteAuthority): LifecycleMutationFence {
  const fence = lifecycleMutationFences.get(lifecycleAuthorityKey(authority))
  if (!fence) throw new Error('lifecycle mutation has no frozen ancestor fence')
  const absolute = resolve(target)
  if (!fence.exactFiles.has(absolute)
    && !fence.writableRoots.some((root) => isSameOrInside(root, absolute, process.platform))) {
    throw new Error(`lifecycle mutation target is outside its frozen authority: ${absolute}`)
  }
  return fence
}

function assertLifecycleDirectoryFence(directory: string, fence: LifecycleMutationFence): void {
  let cursor = resolve(directory)
  for (;;) {
    const expected = fence.directories.get(cursor)
    const stat = lstatOptional(cursor)
    if (expected) {
      if (!stat?.isDirectory() || stat.isSymbolicLink() || stat.dev !== expected.dev || stat.ino !== expected.ino) {
        throw new Error(`lifecycle mutation ancestor changed after an asynchronous checkpoint: ${cursor}`)
      }
    } else if (fence.absent.has(cursor)) {
      if (stat) throw new Error(`lifecycle mutation missing path was concurrently created: ${cursor}`)
    } else if (stat) {
      throw new Error(`lifecycle mutation encountered an unfrozen directory: ${cursor}`)
    }
    const parent = dirname(cursor)
    if (samePath(parent, cursor, process.platform)) break
    cursor = parent
  }
}

function ensureLifecycleDirectory(
  directory: string,
  authority: LifecycleWriteAuthority,
  authorityTarget: string = directory
): void {
  const absolute = resolve(directory)
  const fence = lifecycleMutationFenceFor(authorityTarget, authority)
  if (!fence.plannedDirectories.has(absolute)) planLifecycleDirectory(fence, absolute)
  assertLifecycleDirectoryFence(absolute, fence)
  fs.mkdirSync(absolute, { recursive: true })
  let cursor = absolute
  for (;;) {
    const stat = fs.lstatSync(cursor)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`created lifecycle directory is unsafe: ${cursor}`)
    fence.directories.set(cursor, { dev: stat.dev, ino: stat.ino })
    fence.absent.delete(cursor)
    const parent = dirname(cursor)
    if (samePath(parent, cursor, process.platform) || fence.directories.has(parent)) break
    cursor = parent
  }
}

function assertLifecycleFileMutationBoundary(
  file: string,
  authority: LifecycleWriteAuthority,
  authorityTarget: string = file
): LifecycleMutationFence {
  const fence = lifecycleMutationFenceFor(authorityTarget, authority)
  assertLifecycleDirectoryFence(dirname(resolve(file)), fence)
  return fence
}

function assertLifecycleDirectoryMutationBoundary(
  directory: string,
  authority: LifecycleWriteAuthority,
  authorityTarget: string = directory
): LifecycleMutationFence {
  const fence = lifecycleMutationFenceFor(authorityTarget, authority)
  assertLifecycleDirectoryFence(resolve(directory), fence)
  return fence
}

function lifecycleRenameSync(
  source: string,
  destination: string,
  authority: LifecycleWriteAuthority,
  authorityTarget: string = destination,
  sourceIsDirectory = false
): void {
  const fence = lifecycleMutationFenceFor(authorityTarget, authority)
  assertLifecycleDirectoryFence(sourceIsDirectory ? resolve(source) : dirname(resolve(source)), fence)
  assertLifecycleDirectoryFence(dirname(resolve(destination)), fence)
  fs.renameSync(source, destination)
}

function lifecycleUnlinkSync(
  file: string,
  authority: LifecycleWriteAuthority,
  authorityTarget: string = file
): void {
  assertLifecycleFileMutationBoundary(file, authority, authorityTarget)
  fs.unlinkSync(file)
}

function lifecycleChmodSync(
  file: string,
  mode: number,
  authority: LifecycleWriteAuthority,
  authorityTarget: string = file
): void {
  assertLifecycleFileMutationBoundary(file, authority, authorityTarget)
  fs.chmodSync(file, mode)
}

function atomicWrite(
  target: string,
  value: string | Buffer,
  authority?: LifecycleWriteAuthority,
  expectedCurrent?: CapturedFileState
): void {
  if (authority) ensureLifecycleDirectory(dirname(target), authority, target)
  else fs.mkdirSync(dirname(target), { recursive: true })
  const targetBefore = expectedCurrent || (authority ? { bytes: null, stat: null } : null)
  if (targetBefore) assertCapturedFileState(target, targetBefore, 'lifecycle write target')
  const temporary = authority
    ? lifecycleStagePath(target, authority)
    : join(dirname(target), `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`)
  const expected = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8')
  let ownedStage: { dev: number; ino: number } | null = null
  let descriptor = -1
  try {
    if (authority) assertLifecycleFileMutationBoundary(temporary, authority, target)
    descriptor = fs.openSync(temporary, 'wx')
    const opened = fs.fstatSync(descriptor)
    ownedStage = { dev: opened.dev, ino: opened.ino }
    fs.writeFileSync(descriptor, expected)
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = -1
    const staged = fs.lstatSync(temporary)
    if (!staged.isFile() || staged.isSymbolicLink() || staged.nlink !== 1
      || staged.dev !== opened.dev || staged.ino !== opened.ino
      || !readBoundedPlainFile(temporary, expected.length, 'lifecycle staging file').equals(expected)) {
      throw new Error(`lifecycle staging postcondition failed: ${temporary}`)
    }
    if (platformSupportsMode() && basename(target) === PRODUCT_COMMAND) {
      if (authority) lifecycleChmodSync(temporary, 0o755, authority, target)
      else fs.chmodSync(temporary, 0o755)
      const modeDescriptor = fs.openSync(temporary, fs.constants.O_RDWR)
      try { fs.fsyncSync(modeDescriptor) } finally { fs.closeSync(modeDescriptor) }
      const mode = fs.lstatSync(temporary).mode & 0o777
      if ((mode & 0o111) === 0) throw new Error(`lifecycle executable mode postcondition failed: ${temporary}`)
    }
    if (targetBefore) assertCapturedFileState(target, targetBefore, 'lifecycle write target')
    if (targetBefore?.stat === null) {
      // Publishing an expected-absent target by rename would silently replace a
      // raced foreign file. A hard link is the portable no-replace publication
      // primitive used by the lifecycle protocol; the exact linked staging
      // name is retained as restart evidence if its cleanup is interrupted.
      if (authority) {
        assertLifecycleFileMutationBoundary(temporary, authority, target)
        assertLifecycleFileMutationBoundary(target, authority)
      }
      fs.linkSync(temporary, target)
      flushDirectory(dirname(target))
      if (authority) lifecycleUnlinkSync(temporary, authority, target)
      else fs.unlinkSync(temporary)
      flushDirectory(dirname(target))
    } else if (authority) {
      lifecycleRenameSync(temporary, target, authority, target)
      flushDirectory(dirname(target))
    } else {
      fs.renameSync(temporary, target)
      flushDirectory(dirname(target))
    }
    const published = readBoundedPlainFile(target, expected.length, 'durable lifecycle write target')
    if (!published.equals(expected)) {
      throw new Error(`durable lifecycle write failed its final readback: ${target}`)
    }
  } finally {
    if (descriptor >= 0) fs.closeSync(descriptor)
    try {
      const staged = lstatOptional(temporary)
      if (staged && ownedStage && staged.isFile() && !staged.isSymbolicLink()
        && staged.dev === ownedStage.dev && staged.ino === ownedStage.ino
        && staged.nlink >= 1 && staged.nlink <= 2
        && readBoundedPlainFile(temporary, expected.length, 'lifecycle staging cleanup', staged.nlink === 2).equals(expected)) {
        if (authority) lifecycleUnlinkSync(temporary, authority, target)
        else fs.unlinkSync(temporary)
      }
    } catch { /* exact-owned process-kill evidence remains for restart recovery */ }
  }
}

function assertPlainFile(file: string, label: string): void {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a plain file: ${file}`)
}

function assertPlainDirectory(directory: string, label: string): void {
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a plain directory: ${directory}`)
}

function assertPlainPathFromRoot(root: string, target: string, label: string): void {
  const absoluteRoot = resolve(root)
  const absoluteTarget = resolve(target)
  if (!isSameOrInside(absoluteRoot, absoluteTarget, process.platform)) {
    throw new Error(`${label} escapes the candidate package root`)
  }
  let cursor = absoluteTarget
  for (;;) {
    const stat = fs.lstatSync(cursor)
    if (stat.isSymbolicLink()) throw new Error(`${label} has a reparse/symbolic path component: ${cursor}`)
    if (samePath(cursor, absoluteTarget, process.platform)) {
      if (!stat.isFile()) throw new Error(`${label} must be a plain file: ${absoluteTarget}`)
    } else if (!stat.isDirectory()) {
      throw new Error(`${label} has a non-directory path component: ${cursor}`)
    }
    if (samePath(cursor, absoluteRoot, process.platform)) break
    cursor = dirname(cursor)
  }
}

function lstatOptional(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function isSameOrInside(parent: string, target: string, platform: string): boolean {
  if (samePath(parent, target, platform)) return true
  const rel = relative(resolve(parent), resolve(target))
  return Boolean(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function assertSafeRecursiveRoot(target: string, label: string, forbidden: readonly string[], platform: string): string {
  if (!isAbsolute(target)) throw new Error(`${label} must be absolute`)
  const root = resolve(target)
  if (samePath(root, parse(root).root, platform)) throw new Error(`${label} cannot be a filesystem root`)
  for (const candidate of forbidden.filter(Boolean)) {
    // An owned lifecycle directory is normally below HOME/LOCALAPPDATA. Refuse
    // only the protected root itself or one of its ancestors; callers add
    // stricter two-way disjointness for package/data roots where required.
    if (isSameOrInside(root, candidate, platform)) {
      throw new Error(`${label} overlaps a protected lifecycle root: ${candidate}`)
    }
  }
  let cursor = root
  for (;;) {
    const stat = lstatOptional(cursor)
    if (stat) {
      if (stat.isSymbolicLink()) throw new Error(`${label} has a reparse/symbolic path component: ${cursor}`)
    }
    const parent = dirname(cursor)
    if (samePath(parent, cursor, platform)) break
    cursor = parent
  }
  return root
}

function assertLocalLifecycleRoot(target: string, label: string, platform: string): void {
  const absolute = resolve(target)
  if (platform === 'win32' && (/^\\\\/.test(absolute) || /^\\\\[?.]\\/.test(target))) {
    throw new Error(`${label} must be on a local filesystem; UNC and device roots are unsupported`)
  }
  if (platform !== 'win32' && /^\/\//.test(target)) {
    throw new Error(`${label} must be on a local filesystem`)
  }
}

function protectedLifecycleRoots(host: InstallHost): string[] {
  if (host.platform === 'win32') {
    const environment = host.environment()
    return [
      environment.SystemRoot || environment.WINDIR,
      environment.ProgramFiles,
      environment['ProgramFiles(x86)'],
      environment.ProgramData,
      join(host.home, 'Desktop'),
      join(host.home, 'Documents'),
      join(host.home, 'Downloads')
    ].filter((value): value is string => Boolean(value && isAbsolute(value)))
  }
  return ['/bin', '/boot', '/dev', '/etc', '/lib', '/lib64', '/proc', '/run', '/sbin', '/sys', '/usr', '/var']
}

function assertOutsideProtectedRoots(target: string, label: string, host: InstallHost): void {
  for (const protectedRoot of protectedLifecycleRoots(host)) {
    if (isSameOrInside(protectedRoot, target, host.platform)
      || isSameOrInside(target, protectedRoot, host.platform)) {
      throw new Error(`${label} overlaps a protected operating-system or user-content root`)
    }
  }
}

function physicalLifecyclePath(
  target: string,
  label: string,
  platform: NodeJS.Platform | string,
  requireDirectory: boolean
): string {
  const absolute = resolve(target)
  let ancestor = absolute
  let stat = lstatOptional(ancestor)
  while (!stat) {
    const parent = dirname(ancestor)
    if (samePath(parent, ancestor, platform)) break
    ancestor = parent
    stat = lstatOptional(ancestor)
  }
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} has no plain existing directory ancestor`)
  }
  if (requireDirectory && !samePath(ancestor, absolute, platform)) throw new Error(`${label} must exist`)
  const realAncestor = fs.realpathSync.native(ancestor)
  const physical = resolve(realAncestor, relative(ancestor, absolute))
  if (requireDirectory) {
    assertPlainDirectory(absolute, label)
    if (!samePath(fs.realpathSync.native(absolute), physical, platform)) {
      throw new Error(`${label} has an unverifiable physical path`)
    }
  }
  return physical
}

function readJsonRecord(
  file: string,
  maxBytes = MANIFEST_MAX_BYTES,
  allowLinked = false
): Record<string, unknown> | null {
  const before = lstatOptional(file)
  if (!before) return null
  if (!before.isFile() || before.isSymbolicLink()
    || before.nlink < 1 || before.nlink > (allowLinked ? 2 : 1) || before.size > maxBytes) {
    throw new Error(`lifecycle JSON is not a bounded unique plain file: ${file}`)
  }
  const descriptor = fs.openSync(file, 'r')
  let bytes: Buffer
  try {
    const opened = fs.fstatSync(descriptor)
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.size !== before.size || opened.nlink !== before.nlink || opened.size > maxBytes) {
      throw new Error(`lifecycle JSON changed before read: ${file}`)
    }
    bytes = Buffer.alloc(opened.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset)
      if (count === 0) throw new Error(`lifecycle JSON ended before its recorded size: ${file}`)
      offset += count
    }
    const after = fs.fstatSync(descriptor)
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || after.nlink !== opened.nlink) {
      throw new Error(`lifecycle JSON changed while read: ${file}`)
    }
  } finally {
    fs.closeSync(descriptor)
  }
  const pathAfter = fs.lstatSync(file)
  if (!pathAfter.isFile() || pathAfter.isSymbolicLink()
    || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino || pathAfter.size !== before.size
    || pathAfter.mtimeMs !== before.mtimeMs || pathAfter.nlink !== before.nlink) {
    throw new Error(`lifecycle JSON path changed while read: ${file}`)
  }
  const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`invalid lifecycle JSON object: ${file}`)
  return parsed as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function canonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 20 || value.length > 32) return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

type LifecycleRootReceiptNamespace = {
  directory: string
  file: string
  pending: string
  directoryExists: boolean
  homeIdentity: string
  markerState: CapturedFileState | null
  ownerStageNamespaceId: string | null
  ownerStageAuthorityMarker: string | null
  ownerStageAuthorityMarkerState: CapturedFileState | null
  daemonStageNamespaceId: string | null
  daemonStageAuthorityMarker: string | null
  daemonStageAuthorityMarkerState: CapturedFileState | null
  receipt: LifecycleRootReceiptV1 | null
  receiptState: CapturedFileState | null
  pendingReceipt: LifecycleRootReceiptV1 | null
  pendingState: CapturedFileState | null
  writing: string | null
  writingOwner: LifecycleRootReceiptWriterOwner | null
  writingReceipt: LifecycleRootReceiptV1 | null
  writingState: CapturedFileState | null
}

type LifecycleRootReceiptWriterOwner = {
  homeIdentity: string
  ownerToken: string
  pid: number
  processIdentity: string
  leaseUntil: number
}

export function lifecycleRootReceiptPath(host: InstallHost = createInstallHost()): string {
  return join(resolve(host.home || homedir()), LIFECYCLE_ROOT_RECEIPT_DIR, LIFECYCLE_ROOT_RECEIPT_FILE)
}

function lifecycleRootReceiptPendingPath(host: InstallHost): string {
  return join(dirname(lifecycleRootReceiptPath(host)), LIFECYCLE_ROOT_RECEIPT_PENDING)
}

function lifecycleRootReceiptHomeIdentity(home: string, platform: NodeJS.Platform | string): string {
  const stat = fs.lstatSync(home)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('lifecycle receipt HOME must be a plain directory')
  const physical = fs.realpathSync.native(home)
  const canonicalPhysical = platform === 'win32' ? physical.toLowerCase() : physical
  return createHash('sha256')
    .update(`${canonicalPhysical}\0${String(stat.dev)}\0${String(stat.ino)}`)
    .digest('hex')
}

function parseLifecycleRootReceiptWriterName(name: string, expectedHomeIdentity: string): LifecycleRootReceiptWriterOwner | null {
  const match = LIFECYCLE_ROOT_RECEIPT_WRITING.exec(name)
  if (!match) return null
  const pid = Number(match[3])
  const leaseUntil = Number(match[5])
  if (match[1].toLowerCase() !== expectedHomeIdentity.toLowerCase()
    || !Number.isSafeInteger(pid) || pid < 1
    || !Number.isSafeInteger(leaseUntil) || leaseUntil < 1) {
    throw new Error('lifecycle root receipt writer name is not bound to this HOME')
  }
  return {
    homeIdentity: match[1].toLowerCase(),
    ownerToken: match[2].toLowerCase(),
    pid,
    processIdentity: match[4].toLowerCase(),
    leaseUntil
  }
}

function validateLifecycleRootReceipt(
  value: Record<string, unknown>,
  host: InstallHost
): LifecycleRootReceiptV1 {
  const commonKeys = [
    'schemaVersion', 'product', 'state', 'installId', 'dataRootId', 'dataRoot', 'installDir',
    'packageRoot', 'packageVersion', 'packageSha256', 'createdAt', 'updatedAt'
  ]
  const purgingKeys = [
    ...commonKeys,
    'purgeId', 'lockToken', 'priorInactiveReceiptSha256', 'planHash', 'treeSha256', 'entries', 'bytes',
    'rootDev', 'rootIno', 'tombstone', 'quarantine', 'deletedWalSha256'
  ]
  if (!exactKeys(value, value.state === 'purging' ? purgingKeys : commonKeys)
    || value.schemaVersion !== LIFECYCLE_ROOT_RECEIPT_VERSION
    || value.product !== PRODUCT_NAME
    || value.state !== 'active' && value.state !== 'inactive' && value.state !== 'purging'
    || typeof value.installId !== 'string' || !UUID.test(value.installId)
    || typeof value.dataRootId !== 'string' || !UUID.test(value.dataRootId)
    || typeof value.dataRoot !== 'string' || !isAbsolute(value.dataRoot)
    || typeof value.installDir !== 'string' || !isAbsolute(value.installDir)
    || typeof value.packageRoot !== 'string' || !isAbsolute(value.packageRoot)
    || typeof value.packageVersion !== 'string' || value.packageVersion.length < 1 || value.packageVersion.length > 128
    || /[\u0000-\u001f\u007f]/.test(value.packageVersion)
    || typeof value.packageSha256 !== 'string' || !SHA256_DIGEST.test(value.packageSha256)
    || !canonicalIsoTimestamp(value.createdAt) || !canonicalIsoTimestamp(value.updatedAt)
    || Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
    throw new Error('invalid lifecycle root receipt')
  }
  if (value.state === 'purging') {
    if (typeof value.purgeId !== 'string' || !UUID.test(value.purgeId)
      || typeof value.lockToken !== 'string' || !UUID.test(value.lockToken)
      || typeof value.priorInactiveReceiptSha256 !== 'string' || !SHA256_DIGEST.test(value.priorInactiveReceiptSha256)
      || typeof value.planHash !== 'string' || !SHA256_DIGEST.test(value.planHash)
      || typeof value.treeSha256 !== 'string' || !SHA256_DIGEST.test(value.treeSha256)
      || !Number.isSafeInteger(value.entries) || Number(value.entries) < 1 || Number(value.entries) > 100_000
      || !Number.isSafeInteger(value.bytes) || Number(value.bytes) < 0 || Number(value.bytes) > 10 * 1024 * 1024 * 1024
      || typeof value.rootDev !== 'string' || !/^[0-9]+$/.test(value.rootDev)
      || typeof value.rootIno !== 'string' || !/^[0-9]+$/.test(value.rootIno)
      || typeof value.tombstone !== 'string' || !isAbsolute(value.tombstone)
      || typeof value.quarantine !== 'string' || !isAbsolute(value.quarantine)
      || typeof value.deletedWalSha256 !== 'string' || !SHA256_DIGEST.test(value.deletedWalSha256)) {
      throw new Error('invalid purging lifecycle root receipt')
    }
    const purgePlanCore = {
      schemaVersion: 1 as const,
      action: 'purge' as const,
      dataRootId: value.dataRootId as string,
      treeSha256: value.treeSha256 as Sha256Digest,
      entries: Number(value.entries),
      bytes: Number(value.bytes)
    }
    if (value.planHash !== sha256Bytes(canonicalJson(purgePlanCore))) {
      throw new Error('purging lifecycle root receipt plan facts are inconsistent')
    }
    const expectedTombstone = `${resolve(value.dataRoot as string)}.purging-${String(value.dataRootId)}-${String(value.purgeId).toLowerCase()}`
    if (!samePath(value.tombstone, expectedTombstone, host.platform)
      || !samePath(value.quarantine, frozenDeleteQuarantine(expectedTombstone), host.platform)) {
      throw new Error('purging lifecycle root receipt names an invalid tombstone namespace')
    }
  }
  for (const [pathValue, label] of [
    [value.dataRoot as string, 'data root'],
    [value.installDir as string, 'install directory'],
    [value.packageRoot as string, 'package root']
  ] as const) {
    if (Buffer.byteLength(pathValue, 'utf8') > 32 * 1024 || /[\u0000\r\n]/.test(pathValue)) {
      throw new Error(`lifecycle root receipt ${label} is invalid`)
    }
  }
  const receipt = value as unknown as LifecycleRootReceiptV1
  const receiptRoot = dirname(lifecycleRootReceiptPath(host))
  const applicationRoot = applicationLeaseRoot(receipt.dataRoot)
  for (const [candidate, label] of [
    [receipt.dataRoot, 'data root'],
    [receipt.installDir, 'install directory'],
    [receipt.packageRoot, 'package root'],
    [applicationRoot, 'application lease root']
  ] as const) {
    assertDisjoint(receiptRoot, candidate, `lifecycle receipt root and ${label}`, host.platform)
  }
  assertDisjoint(receipt.dataRoot, receipt.installDir, 'lifecycle receipt data and install roots', host.platform)
  assertDisjoint(receipt.dataRoot, receipt.packageRoot, 'lifecycle receipt data and package roots', host.platform)
  assertDisjoint(receipt.installDir, receipt.packageRoot, 'lifecycle receipt install and package roots', host.platform)
  return receipt
}

function parseLifecycleRootReceiptBytes(bytes: Buffer, host: InstallHost): LifecycleRootReceiptV1 {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new Error('invalid lifecycle root receipt JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid lifecycle root receipt JSON')
  }
  return validateLifecycleRootReceipt(parsed as Record<string, unknown>, host)
}

function sameLifecycleRootReceipt(left: LifecycleRootReceiptV1 | null, right: LifecycleRootReceiptV1 | null): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function sameLifecycleRootReceiptNamespace(left: LifecycleRootReceiptV1, right: LifecycleRootReceiptV1, host: InstallHost): boolean {
  return left.dataRootId === right.dataRootId
    && samePath(left.dataRoot, right.dataRoot, host.platform)
    && samePath(left.installDir, right.installDir, host.platform)
}

function preflightLifecycleRootReceiptDirectory(host: InstallHost): { home: string; directory: string; exists: boolean } {
  const home = resolve(host.home || homedir())
  const directory = dirname(lifecycleRootReceiptPath(host))
  assertLocalLifecycleRoot(home, 'lifecycle receipt HOME', host.platform)
  if (host.localVolumeKind(home) !== 'local') {
    throw new Error('lifecycle receipt HOME must be on a proven local fixed volume')
  }
  assertSafeRecursiveRoot(home, 'lifecycle receipt HOME', [], host.platform)
  physicalLifecyclePath(home, 'lifecycle receipt HOME', host.platform, true)
  assertSafeRecursiveRoot(directory, 'lifecycle receipt directory', [], host.platform)
  const stat = lstatOptional(directory)
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
    throw new Error('lifecycle receipt directory must be a plain directory')
  }
  if (stat) physicalLifecyclePath(directory, 'lifecycle receipt directory', host.platform, true)
  return { home, directory, exists: Boolean(stat) }
}

function readLifecycleRootReceiptNamespace(host: InstallHost): LifecycleRootReceiptNamespace {
  const preflight = preflightLifecycleRootReceiptDirectory(host)
  const file = lifecycleRootReceiptPath(host)
  const pending = lifecycleRootReceiptPendingPath(host)
  const homeIdentity = lifecycleRootReceiptHomeIdentity(preflight.home, host.platform)
  if (!preflight.exists) {
    return {
      directory: preflight.directory,
      file,
      pending,
      directoryExists: false,
      homeIdentity,
      markerState: null,
      ownerStageNamespaceId: null,
      ownerStageAuthorityMarker: null,
      ownerStageAuthorityMarkerState: null,
      daemonStageNamespaceId: null,
      daemonStageAuthorityMarker: null,
      daemonStageAuthorityMarkerState: null,
      receipt: null,
      receiptState: null,
      pendingReceipt: null,
      pendingState: null,
      writing: null,
      writingOwner: null,
      writingReceipt: null,
      writingState: null
    }
  }
  const allowed = new Set([
    LIFECYCLE_ROOT_RECEIPT_NAMESPACE_MARKER,
    LIFECYCLE_ROOT_RECEIPT_FILE,
    LIFECYCLE_ROOT_RECEIPT_PENDING
  ])
  let writing: string | null = null
  let writingOwner: LifecycleRootReceiptWriterOwner | null = null
  let ownerStageNamespaceId: string | null = null
  let ownerStageAuthorityMarker: string | null = null
  let daemonStageNamespaceId: string | null = null
  let daemonStageAuthorityMarker: string | null = null
  const entries = boundedDirectoryEntries(preflight.directory, 6, 'lifecycle receipt namespace')
  for (const entry of entries) {
    const owner = parseLifecycleRootReceiptWriterName(entry.name, homeIdentity)
    const ownerStageAuthority = LIFECYCLE_OWNER_STAGE_AUTHORITY_MARKER.exec(entry.name)
    const daemonStageAuthority = LIFECYCLE_DAEMON_STAGE_AUTHORITY_MARKER.exec(entry.name)
    if (!allowed.has(entry.name) && !owner && !ownerStageAuthority && !daemonStageAuthority) {
      throw new Error(`lifecycle receipt namespace contains a foreign entry: ${entry.name}`)
    }
    if (owner) {
      if (writing) throw new Error('lifecycle receipt namespace contains multiple incomplete writers')
      writing = join(preflight.directory, entry.name)
      writingOwner = owner
    }
    if (ownerStageAuthority) {
      if (ownerStageAuthorityMarker) throw new Error('lifecycle receipt namespace contains multiple owner-stage authorities')
      ownerStageNamespaceId = ownerStageAuthority[1]
      ownerStageAuthorityMarker = join(preflight.directory, entry.name)
    }
    if (daemonStageAuthority) {
      if (daemonStageAuthorityMarker) throw new Error('lifecycle receipt namespace contains multiple daemon-stage authorities')
      daemonStageNamespaceId = daemonStageAuthority[1].toLowerCase()
      daemonStageAuthorityMarker = join(preflight.directory, entry.name)
    }
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`lifecycle receipt namespace entry is not a plain file: ${entry.name}`)
    }
  }
  const marker = join(preflight.directory, LIFECYCLE_ROOT_RECEIPT_NAMESPACE_MARKER)
  const markerStat = lstatOptional(marker)
  if (entries.length > 0 && !markerStat) {
    throw new Error('non-empty lifecycle receipt namespace has no strict namespace marker')
  }
  if (markerStat && (!markerStat.isFile() || markerStat.isSymbolicLink()
    || markerStat.nlink !== 1 || markerStat.size !== 0)) {
    throw new Error('lifecycle receipt namespace marker is not a unique empty protocol file')
  }
  const markerState = markerStat ? captureFileState(marker, 0) : null
  const ownerStageAuthorityStat = ownerStageAuthorityMarker ? fs.lstatSync(ownerStageAuthorityMarker) : null
  if (ownerStageAuthorityStat && (!ownerStageAuthorityStat.isFile() || ownerStageAuthorityStat.isSymbolicLink()
    || ownerStageAuthorityStat.nlink !== 1 || ownerStageAuthorityStat.size !== 0)) {
    throw new Error('lifecycle owner-stage authority marker is not a unique empty protocol file')
  }
  const ownerStageAuthorityMarkerState = ownerStageAuthorityStat && ownerStageAuthorityMarker
    ? captureFileState(ownerStageAuthorityMarker, 0)
    : null
  const daemonStageAuthorityStat = daemonStageAuthorityMarker ? fs.lstatSync(daemonStageAuthorityMarker) : null
  if (daemonStageAuthorityStat && (!daemonStageAuthorityStat.isFile() || daemonStageAuthorityStat.isSymbolicLink()
    || daemonStageAuthorityStat.nlink !== 1 || daemonStageAuthorityStat.size !== 0)) {
    throw new Error('lifecycle daemon-stage authority marker is not a unique empty protocol file')
  }
  const daemonStageAuthorityMarkerState = daemonStageAuthorityStat && daemonStageAuthorityMarker
    ? captureFileState(daemonStageAuthorityMarker, 0)
    : null
  const receiptStat = lstatOptional(file)
  const pendingStat = lstatOptional(pending)
  for (const [stat, label] of [[receiptStat, 'receipt'], [pendingStat, 'pending receipt']] as const) {
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink < 1 || stat.nlink > 2
      || stat.size > LIFECYCLE_ROOT_RECEIPT_MAX_BYTES)) {
      throw new Error(`lifecycle root ${label} is not a bounded plain protocol file`)
    }
  }
  const receiptState = receiptStat
    ? captureFileState(file, LIFECYCLE_ROOT_RECEIPT_MAX_BYTES, receiptStat.nlink === 2)
    : null
  const pendingState = pendingStat
    ? captureFileState(pending, LIFECYCLE_ROOT_RECEIPT_MAX_BYTES, pendingStat.nlink === 2)
    : null
  const writingStat = writing ? fs.lstatSync(writing) : null
  if (writingStat && (!writingStat.isFile() || writingStat.isSymbolicLink()
    || writingStat.nlink < 1 || writingStat.nlink > 2 || writingStat.size > LIFECYCLE_ROOT_RECEIPT_MAX_BYTES)) {
    throw new Error('lifecycle root receipt writer is not a bounded plain protocol file')
  }
  const writingState = writingStat && writing
    ? captureFileState(writing, LIFECYCLE_ROOT_RECEIPT_MAX_BYTES, writingStat.nlink === 2)
    : null
  const receipt = receiptState?.bytes ? parseLifecycleRootReceiptBytes(receiptState.bytes, host) : null
  const pendingReceipt = pendingState?.bytes ? parseLifecycleRootReceiptBytes(pendingState.bytes, host) : null
  let writingReceipt: LifecycleRootReceiptV1 | null = null
  if (writingState?.bytes) {
    try { writingReceipt = parseLifecycleRootReceiptBytes(writingState.bytes, host) } catch { /* incomplete reserved writer */ }
  }
  if (receiptState?.stat?.nlink === 2) {
    if (!receiptState?.stat || !pendingState?.stat
      || receiptState.stat.nlink !== 2 || pendingState.stat.nlink !== 2
      || receiptState.stat.dev !== pendingState.stat.dev || receiptState.stat.ino !== pendingState.stat.ino
      || !sameOptionalBuffer(receiptState.bytes, pendingState.bytes)) {
      throw new Error('lifecycle root receipt has an ambiguous hard-link publication')
    }
  } else if (pendingState?.stat?.nlink === 2 && writingState?.stat?.nlink !== 2) {
    throw new Error('lifecycle root receipt pending file has an ambiguous hard link')
  } else if (receipt && pendingReceipt && !sameLifecycleRootReceiptNamespace(receipt, pendingReceipt, host)) {
    throw new Error('lifecycle root receipt pending update crosses a preserved root namespace')
  }
  if (writingState?.stat?.nlink === 2) {
    if (!pendingState?.stat || pendingState.stat.nlink !== 2
      || pendingState.stat.dev !== writingState.stat.dev || pendingState.stat.ino !== writingState.stat.ino
      || !sameOptionalBuffer(pendingState.bytes, writingState.bytes) || !writingReceipt || !pendingReceipt) {
      throw new Error('lifecycle root receipt writer has an ambiguous hard link')
    }
  } else if (writingState && writingState.stat?.nlink !== 1) {
    throw new Error('lifecycle root receipt writer has an unsafe link count')
  }
  return {
    directory: preflight.directory,
    file,
    pending,
    directoryExists: true,
    homeIdentity,
    markerState,
    ownerStageNamespaceId,
    ownerStageAuthorityMarker,
    ownerStageAuthorityMarkerState,
    daemonStageNamespaceId,
    daemonStageAuthorityMarker,
    daemonStageAuthorityMarkerState,
    receipt,
    receiptState,
    pendingReceipt,
    pendingState,
    writing,
    writingOwner,
    writingReceipt,
    writingState
  }
}

function assertLifecycleRootReceiptNamespaceExact(
  host: InstallHost,
  expected: LifecycleRootReceiptNamespace,
  label: string
): void {
  const current = readLifecycleRootReceiptNamespace(host)
  if (current.directory !== expected.directory
    || current.file !== expected.file
    || current.pending !== expected.pending
    || current.directoryExists !== expected.directoryExists
    || current.homeIdentity !== expected.homeIdentity
    || current.ownerStageNamespaceId !== expected.ownerStageNamespaceId
    || current.ownerStageAuthorityMarker !== expected.ownerStageAuthorityMarker
    || current.daemonStageNamespaceId !== expected.daemonStageNamespaceId
    || current.daemonStageAuthorityMarker !== expected.daemonStageAuthorityMarker
    || current.writing !== expected.writing
    || canonicalJson(current.writingOwner) !== canonicalJson(expected.writingOwner)
    || canonicalJson(current.receipt) !== canonicalJson(expected.receipt)
    || canonicalJson(current.pendingReceipt) !== canonicalJson(expected.pendingReceipt)
    || canonicalJson(current.writingReceipt) !== canonicalJson(expected.writingReceipt)) {
    throw new Error(`${label} namespace changed`)
  }
  const absent: CapturedFileState = { bytes: null, stat: null }
  assertCapturedFileState(
    join(expected.directory, LIFECYCLE_ROOT_RECEIPT_NAMESPACE_MARKER),
    expected.markerState || absent,
    `${label} marker`,
    0
  )
  assertCapturedFileState(
    expected.file,
    expected.receiptState || absent,
    `${label} final`,
    LIFECYCLE_ROOT_RECEIPT_MAX_BYTES
  )
  assertCapturedFileState(
    expected.pending,
    expected.pendingState || absent,
    `${label} pending`,
    LIFECYCLE_ROOT_RECEIPT_MAX_BYTES
  )
  if (expected.writing && expected.writingState) {
    assertCapturedFileState(
      expected.writing,
      expected.writingState,
      `${label} writer`,
      LIFECYCLE_ROOT_RECEIPT_MAX_BYTES
    )
  }
  if (expected.ownerStageAuthorityMarker && expected.ownerStageAuthorityMarkerState) {
    assertCapturedFileState(
      expected.ownerStageAuthorityMarker,
      expected.ownerStageAuthorityMarkerState,
      `${label} owner-stage authority`,
      0
    )
  }
  if (expected.daemonStageAuthorityMarker && expected.daemonStageAuthorityMarkerState) {
    assertCapturedFileState(
      expected.daemonStageAuthorityMarker,
      expected.daemonStageAuthorityMarkerState,
      `${label} daemon-stage authority`,
      0
    )
  }
}

/**
 * The daemon v1 foundation consumes lifecycle authority through this narrow
 * adapter instead of maintaining a second receipt parser.  It is deliberately
 * read-only and only admits the stable, unique active-receipt shape from which
 * a daemon namespace may be bootstrapped.
 */
export function readDaemonLifecycleReceiptAuthority(
  dataRoot: string,
  host: InstallHost = createInstallHost()
): DaemonLifecycleReceiptAuthoritySnapshot {
  const expectedRoot = resolve(dataRoot)
  const namespace = readLifecycleRootReceiptNamespace(host)
  if (!namespace.directoryExists || !namespace.markerState?.bytes || !namespace.markerState.stat
    || !namespace.receipt || namespace.receipt.state !== 'active'
    || !namespace.receiptState?.bytes || !namespace.receiptState.stat
    || namespace.receiptState.stat.nlink !== 1
    || namespace.pendingState || namespace.writingState
    || !samePath(namespace.receipt.dataRoot, expectedRoot, host.platform)) {
    throw new Error('daemon namespace requires one unique active lifecycle receipt')
  }
  const directoryStat = fs.lstatSync(namespace.directory)
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error('daemon lifecycle receipt namespace is not a plain directory')
  }
  const entries = boundedDirectoryEntries(namespace.directory, 6, 'daemon lifecycle receipt namespace')
    .map((entry) => entry.name)
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
  assertLifecycleRootReceiptNamespaceExact(host, namespace, 'daemon lifecycle receipt authority')
  const directoryAfter = fs.lstatSync(namespace.directory)
  const entriesAfter = boundedDirectoryEntries(namespace.directory, 6, 'daemon lifecycle receipt namespace')
    .map((entry) => entry.name)
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
  if (directoryAfter.dev !== directoryStat.dev || directoryAfter.ino !== directoryStat.ino
    || directoryAfter.size !== directoryStat.size || directoryAfter.mtimeMs !== directoryStat.mtimeMs
    || directoryAfter.nlink !== directoryStat.nlink
    || canonicalJson(entriesAfter) !== canonicalJson(entries)) {
    throw new Error('daemon lifecycle receipt namespace changed during capture')
  }
  return {
    home: resolve(host.home || homedir()),
    directory: namespace.directory,
    directoryState: {
      dev: directoryStat.dev,
      ino: directoryStat.ino,
      size: directoryStat.size,
      mtimeMs: directoryStat.mtimeMs,
      nlink: directoryStat.nlink
    },
    entries,
    homeIdentity: namespace.homeIdentity,
    namespaceMarker: join(namespace.directory, LIFECYCLE_ROOT_RECEIPT_NAMESPACE_MARKER),
    namespaceMarkerState: { bytes: namespace.markerState.bytes, stat: namespace.markerState.stat },
    receiptFile: namespace.file,
    receipt: namespace.receipt,
    receiptState: { bytes: namespace.receiptState.bytes, stat: namespace.receiptState.stat },
    ownerStageNamespaceId: namespace.ownerStageNamespaceId,
    ownerStageAuthorityMarker: namespace.ownerStageAuthorityMarker,
    ownerStageAuthorityMarkerState: namespace.ownerStageAuthorityMarkerState,
    daemonStageNamespaceId: namespace.daemonStageNamespaceId,
    daemonStageAuthorityMarker: namespace.daemonStageAuthorityMarker,
    daemonStageAuthorityMarkerState: namespace.daemonStageAuthorityMarkerState
  }
}

type DaemonLifecycleControlAuthority = Readonly<{
  binding: DaemonLifecycleOwnerBindingV1
  reader: NonNullable<InspectDaemonProtocolOptions['readLifecycleOwnerAuthority']>
}>

function daemonLifecycleControlAuthority(
  paths: InstallPaths,
  host: InstallHost,
  expectedLockToken: string
): DaemonLifecycleControlAuthority {
  const receiptAuthority = readDaemonLifecycleReceiptAuthority(paths.dataRoot, host)
  const publication = readLifecycleOwnerPublicationHint(paths, host)
  const owner = publication.record
  if (!owner || owner.token !== expectedLockToken || !receiptAuthority.ownerStageNamespaceId
    || publication.stageNamespace.namespaceId !== receiptAuthority.ownerStageNamespaceId
    || !publication.finalState.stat) {
    throw new Error('daemon lifecycle control has no exact published lifecycle owner')
  }
  const captureOwner = () => {
    const current = readLifecycleOwnerPublicationHint(paths, host)
    if (!current.record || canonicalJson(current.record) !== canonicalJson(owner)
      || current.stageNamespace.namespaceId !== receiptAuthority.ownerStageNamespaceId
      || !current.finalState.stat) {
      throw new Error('daemon lifecycle owner changed during control')
    }
    return {
      current,
      ownerRecord: captureDaemonProtocolFile(
        paths.lifecycleLockPath,
        LIFECYCLE_LOCK_MAX_BYTES,
        'daemon lifecycle owner record',
        [current.finalState.stat.nlink]
      )
    }
  }
  const initial = captureOwner()
  const receiptBytes = receiptAuthority.receiptState.bytes
  if (!receiptBytes) throw new Error('daemon lifecycle control lost its active receipt bytes')
  const receiptSha256 = sha256Bytes(receiptBytes) as DaemonSha256
  const binding: DaemonLifecycleOwnerBindingV1 = Object.freeze({
    lockToken: owner.token,
    operation: owner.operation,
    ownerRecord: daemonFileIdentity(initial.ownerRecord),
    ownerStageNamespaceId: receiptAuthority.ownerStageNamespaceId,
    receiptSha256,
    installId: receiptAuthority.receipt.installId,
    dataRootId: receiptAuthority.receipt.dataRootId
  })
  const reader = (expected: DaemonLifecycleOwnerBindingV1): DaemonLifecycleOwnerAuthoritySnapshot => {
    if (canonicalJson(expected) !== canonicalJson(binding)) {
      throw new Error('daemon lifecycle owner reader received another binding')
    }
    const receipt = readDaemonLifecycleReceiptAuthority(paths.dataRoot, host)
    const currentReceiptBytes = receipt.receiptState.bytes
    if (!currentReceiptBytes || sha256Bytes(currentReceiptBytes) !== receiptSha256
      || receipt.ownerStageNamespaceId !== binding.ownerStageNamespaceId
      || receipt.receipt.installId !== binding.installId
      || receipt.receipt.dataRootId !== binding.dataRootId) {
      throw new Error('daemon lifecycle receipt changed during control')
    }
    const captured = captureOwner()
    const files = [captured.ownerRecord, ...captured.current.artifacts.map((artifact) =>
      captureDaemonProtocolFile(
        artifact.file,
        LIFECYCLE_LOCK_MAX_BYTES,
        'daemon lifecycle owner publication artifact',
        artifact.state.stat ? [artifact.state.stat.nlink] : [1]
      ))]
    return Object.freeze({
      lockToken: binding.lockToken,
      operation: binding.operation,
      ownerStageNamespaceId: binding.ownerStageNamespaceId,
      receiptSha256: binding.receiptSha256,
      installId: binding.installId,
      dataRootId: binding.dataRootId,
      ownerRecord: captured.ownerRecord,
      files: Object.freeze(files),
      directories: Object.freeze([])
    })
  }
  return Object.freeze({ binding, reader })
}

function readLifecycleRootReceipt(host: InstallHost): LifecycleRootReceiptV1 | null {
  const namespace = readLifecycleRootReceiptNamespace(host)
  if (namespace.writingState) throw new Error('incomplete lifecycle root receipt writer requires locked recovery')
  return namespace.receipt || namespace.pendingReceipt
}

function readLifecycleRootReceiptHint(host: InstallHost): LifecycleRootReceiptV1 | null {
  const namespace = readLifecycleRootReceiptNamespace(host)
  // An unlinked writer is not durable locator authority. In particular, a
  // complete but foreign writer must never redirect fresh-environment setup.
  return namespace.receipt || namespace.pendingReceipt
}

function assertNoPurgingLifecycleRootReceipt(
  namespace: LifecycleRootReceiptNamespace,
  operation: string
): void {
  if ([namespace.receipt, namespace.pendingReceipt, namespace.writingReceipt]
    .some((receipt) => receipt?.state === 'purging')) {
    throw new Error(`purge recovery is required before ${operation}`)
  }
}

/** Read-only strict receipt inspection used by lifecycle diagnostics and tests. */
export function inspectLifecycleRootReceipt(host: InstallHost = createInstallHost()): LifecycleRootReceiptV1 | null {
  return readLifecycleRootReceipt(host)
}

function ensureLifecycleRootReceiptDirectory(host: InstallHost): LifecycleRootReceiptNamespace {
  let namespace = readLifecycleRootReceiptNamespace(host)
  if (!namespace.directoryExists) {
    const home = dirname(namespace.directory)
    const homeFence = captureDirectoryFence(home)
    assertDirectoryFence(home, homeFence)
    if (lstatOptional(namespace.directory)) throw new Error('lifecycle receipt directory appeared before exclusive creation')
    fs.mkdirSync(namespace.directory)
    flushDirectory(home)
    const created = fs.lstatSync(namespace.directory)
    if (!created.isDirectory() || created.isSymbolicLink()) {
      throw new Error('created lifecycle receipt namespace is not a plain directory')
    }
    namespace = readLifecycleRootReceiptNamespace(host)
  }
  if (namespace.markerState) {
    const marker = join(namespace.directory, LIFECYCLE_ROOT_RECEIPT_NAMESPACE_MARKER)
    assertCapturedFileState(marker, namespace.markerState, 'lifecycle receipt namespace marker durability', 0)
    const descriptor = fs.openSync(marker, fs.constants.O_RDWR)
    try {
      const opened = fs.fstatSync(descriptor)
      const expected = namespace.markerState.stat
      if (!expected || !opened.isFile() || opened.isSymbolicLink()
        || opened.dev !== expected.dev || opened.ino !== expected.ino
        || opened.nlink !== 1 || opened.size !== 0) {
        throw new Error('lifecycle receipt namespace marker descriptor changed before durability proof')
      }
      fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
    flushDirectory(namespace.directory)
    assertCapturedFileState(marker, namespace.markerState, 'lifecycle receipt namespace marker durability', 0)
    return readLifecycleRootReceiptNamespace(host)
  }
  // The only adoptable unmarked state is a genuinely empty, plain reserved
  // directory. The marker is a zero-byte protocol inode, so its wx creation is
  // itself complete; there is no partially-written marker crash state.
  if (namespace.receiptState || namespace.pendingState || namespace.writingState) {
    throw new Error('unmarked lifecycle receipt namespace is not empty')
  }
  const home = dirname(namespace.directory)
  const homeFence = captureDirectoryFence(home)
  flushDirectory(home)
  assertDirectoryFence(home, homeFence)
  namespace = readLifecycleRootReceiptNamespace(host)
  if (!namespace.directoryExists || namespace.markerState || namespace.receiptState
    || namespace.pendingState || namespace.writingState) {
    throw new Error('empty lifecycle receipt namespace changed before marker adoption')
  }
  const marker = join(namespace.directory, LIFECYCLE_ROOT_RECEIPT_NAMESPACE_MARKER)
  const fence = captureDirectoryFence(namespace.directory)
  assertDirectoryFence(namespace.directory, fence)
  if (lstatOptional(marker)) throw new Error('lifecycle receipt namespace marker appeared before exclusive creation')
  const descriptor = fs.openSync(marker, 'wx')
  try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
  flushDirectory(namespace.directory)
  namespace = readLifecycleRootReceiptNamespace(host)
  if (!namespace.markerState?.stat || namespace.markerState.stat.size !== 0 || namespace.markerState.stat.nlink !== 1) {
    throw new Error('lifecycle receipt namespace marker publication failed')
  }
  return namespace
}

function writeLifecycleRootReceiptPending(
  namespace: LifecycleRootReceiptNamespace,
  receipt: LifecycleRootReceiptV1,
  host: InstallHost
): CapturedFileState {
  if (!namespace.directoryExists || namespace.pendingState || namespace.writingState) {
    throw new Error('lifecycle root receipt pending publication is not empty')
  }
  const bytes = recordBytes(receipt)
  if (bytes.length > LIFECYCLE_ROOT_RECEIPT_MAX_BYTES) throw new Error('lifecycle root receipt exceeds its size bound')
  const directoryFence = captureDirectoryFence(namespace.directory)
  assertDirectoryFence(namespace.directory, directoryFence)
  if (lstatOptional(namespace.pending)) throw new Error('lifecycle root receipt pending file appeared before publication')
  if (!namespace.markerState?.stat) throw new Error('lifecycle root receipt writer requires a strict namespace marker')
  const ownerToken = randomUUID()
  const leaseUntil = Date.now() + LIFECYCLE_ROOT_RECEIPT_WRITER_LEASE_MS
  const writing = join(
    namespace.directory,
    `.root-receipt-v1.${namespace.homeIdentity}.${ownerToken}.${process.pid}.${LIFECYCLE_ROOT_RECEIPT_PROCESS_IDENTITY}.${leaseUntil}.writing`
  )
  const descriptor = fs.openSync(writing, 'wx')
  const opened = fs.fstatSync(descriptor)
  let completeState: CapturedFileState | null = null
  let writeFailure: unknown = null
  try {
    let offset = 0
    while (offset < bytes.length) {
      const count = fs.writeSync(descriptor, bytes, offset, bytes.length - offset, offset)
      if (count <= 0) throw new Error('lifecycle root receipt pending write made no progress')
      offset += count
    }
    fs.fsyncSync(descriptor)
  } catch (error) {
    writeFailure = error
  } finally {
    fs.closeSync(descriptor)
  }
  if (writeFailure) {
    try {
      const current = lstatOptional(writing)
      if (current?.isFile() && !current.isSymbolicLink()
        && current.dev === opened.dev && current.ino === opened.ino && current.nlink === 1) {
        fs.unlinkSync(writing)
        flushDirectory(namespace.directory)
      }
    } catch { /* exact partial protocol evidence remains for locked recovery */ }
    throw writeFailure
  }
  try {
    completeState = captureFileState(writing, LIFECYCLE_ROOT_RECEIPT_MAX_BYTES)
    if (!completeState.bytes || !sameLifecycleRootReceipt(parseLifecycleRootReceiptBytes(completeState.bytes, host), receipt)) {
      throw new Error('lifecycle root receipt writer failed its exact readback')
    }
    assertDirectoryFence(namespace.directory, directoryFence)
    assertCapturedFileState(writing, completeState, 'lifecycle root receipt complete writer', LIFECYCLE_ROOT_RECEIPT_MAX_BYTES)
    const pendingAbsent = captureFileState(namespace.pending, LIFECYCLE_ROOT_RECEIPT_MAX_BYTES)
    if (pendingAbsent.stat) throw new Error('lifecycle root receipt pending file appeared before no-replace publication')
    assertCapturedFileState(namespace.pending, pendingAbsent, 'lifecycle root receipt pending target', LIFECYCLE_ROOT_RECEIPT_MAX_BYTES)
    fs.linkSync(writing, namespace.pending)
    flushDirectory(namespace.directory)
    const linkedWriting = captureFileState(writing, LIFECYCLE_ROOT_RECEIPT_MAX_BYTES, true)
    const linkedPending = captureFileState(namespace.pending, LIFECYCLE_ROOT_RECEIPT_MAX_BYTES, true)
    if (!linkedWriting.stat || !linkedPending.stat || linkedWriting.stat.nlink !== 2 || linkedPending.stat.nlink !== 2
      || linkedWriting.stat.dev !== linkedPending.stat.dev || linkedWriting.stat.ino !== linkedPending.stat.ino
      || !sameOptionalBuffer(linkedWriting.bytes, bytes) || !sameOptionalBuffer(linkedPending.bytes, bytes)) {
      throw new Error('lifecycle root receipt writer did not publish an exact pending pair')
    }
    assertCapturedFileState(writing, linkedWriting, 'lifecycle root receipt linked writer', LIFECYCLE_ROOT_RECEIPT_MAX_BYTES)
    fs.unlinkSync(writing)
    flushDirectory(namespace.directory)
    const pending = captureFileState(namespace.pending, LIFECYCLE_ROOT_RECEIPT_MAX_BYTES)
    if (!pending.stat || pending.stat.nlink !== 1 || !sameOptionalBuffer(pending.bytes, bytes)) {
      throw new Error('lifecycle root receipt pending publication did not become unique')
    }
    return pending
  } catch (error) {
    try {
      const current = lstatOptional(writing)
      if (current?.isFile() && !current.isSymbolicLink()
        && current.dev === opened.dev && current.ino === opened.ino && current.nlink >= 1 && current.nlink <= 2) {
        fs.unlinkSync(writing)
        flushDirectory(namespace.directory)
      }
    } catch { /* process-kill protocol evidence remains for locked recovery */ }
    throw error
  }
}

function assertLifecycleRootReceiptCurrentAllowed(
  current: LifecycleRootReceiptV1 | null,
  allowed: readonly (LifecycleRootReceiptV1 | null)[]
): void {
  if (!allowed.some((candidate) => sameLifecycleRootReceipt(current, candidate))) {
    throw new Error('lifecycle root receipt changed or identifies another preserved root')
  }
}

function collapseLifecycleRootReceiptPair(
  namespace: LifecycleRootReceiptNamespace,
  host: InstallHost,
  allowed: readonly (LifecycleRootReceiptV1 | null)[]
): LifecycleRootReceiptNamespace {
  const linked = namespace.receiptState?.stat?.nlink === 2 || namespace.pendingState?.stat?.nlink === 2
  if (!linked) return namespace
  if (!namespace.receipt || !namespace.pendingReceipt || !namespace.receiptState || !namespace.pendingState) {
    throw new Error('lifecycle root receipt linked publication is incomplete')
  }
  assertLifecycleRootReceiptCurrentAllowed(namespace.receipt, allowed)
  const fence = captureDirectoryFence(namespace.directory)
  assertDirectoryFence(namespace.directory, fence)
  assertCapturedFileState(namespace.file, namespace.receiptState, 'lifecycle root receipt linked target', LIFECYCLE_ROOT_RECEIPT_MAX_BYTES)
  assertCapturedFileState(namespace.pending, namespace.pendingState, 'lifecycle root receipt linked pending', LIFECYCLE_ROOT_RECEIPT_MAX_BYTES)
  fs.unlinkSync(namespace.pending)
  flushDirectory(namespace.directory)
  const collapsed = readLifecycleRootReceiptNamespace(host)
  if (!collapsed.receiptState?.stat || collapsed.receiptState.stat.nlink !== 1
    || !sameLifecycleRootReceipt(collapsed.receipt, namespace.receipt) || collapsed.pendingState) {
    throw new Error('lifecycle root receipt linked publication did not collapse exactly')
  }
  return collapsed
}

function recoverLifecycleRootReceiptWriter(
  namespace: LifecycleRootReceiptNamespace,
  host: InstallHost,
  target: LifecycleRootReceiptV1,
  allowed: readonly (LifecycleRootReceiptV1 | null)[]
): LifecycleRootReceiptNamespace {
  if (!namespace.writing || !namespace.writingState) return namespace
  if (!namespace.markerState?.stat || !namespace.writingOwner) {
    throw new Error('lifecycle root receipt writer has no strict namespace or owner binding')
  }
  assertLifecycleRootReceiptCurrentAllowed(namespace.receipt, allowed)
  const fence = captureDirectoryFence(namespace.directory)
  if (namespace.writingState.stat?.nlink === 2) {
    if (!namespace.writingReceipt || !namespace.pendingReceipt || !namespace.pendingState
      || !sameLifecycleRootReceipt(namespace.writingReceipt, target)
      || !sameLifecycleRootReceipt(namespace.pendingReceipt, target)) {
      throw new Error('lifecycle root receipt linked writer is not the authorized target')
    }
    assertDirectoryFence(namespace.directory, fence)
    assertCapturedFileState(namespace.writing, namespace.writingState, 'lifecycle root receipt linked writer recovery', LIFECYCLE_ROOT_RECEIPT_MAX_BYTES)
    assertCapturedFileState(namespace.pending, namespace.pendingState, 'lifecycle root receipt linked pending recovery', LIFECYCLE_ROOT_RECEIPT_MAX_BYTES)
    fs.unlinkSync(namespace.writing)
    flushDirectory(namespace.directory)
    return readLifecycleRootReceiptNamespace(host)
  }
  if (namespace.writingState.stat?.nlink !== 1) {
    throw new Error('lifecycle root receipt writer has an unsafe recovery state')
  }
  if (!namespace.writingReceipt) {
    // A fixed pending file is always complete authority. A recent incomplete
    // writer might be a concurrently injected or still-observed foreign inode,
    // so it only blocks. Once its encoded lease is expired, the persistent
    // namespace marker and two exact captures classify it as stable product
    // protocol residue; only that exact inode/bytes may be removed.
    if (Date.now() <= namespace.writingOwner.leaseUntil) {
      throw new Error('recent incomplete lifecycle root receipt writer is not recoverable yet')
    }
    const stable = captureFileState(namespace.writing, LIFECYCLE_ROOT_RECEIPT_MAX_BYTES)
    if (!sameOptionalBuffer(stable.bytes, namespace.writingState.bytes)
      || canonicalJson(stable.stat) !== canonicalJson(namespace.writingState.stat)) {
      throw new Error('aged incomplete lifecycle root receipt writer did not remain stable')
    }
    assertDirectoryFence(namespace.directory, fence)
    assertCapturedFileState(namespace.writing, stable, 'incomplete lifecycle root receipt writer', LIFECYCLE_ROOT_RECEIPT_MAX_BYTES)
    fs.unlinkSync(namespace.writing)
    flushDirectory(namespace.directory)
    return readLifecycleRootReceiptNamespace(host)
  }
  if (!sameLifecycleRootReceipt(namespace.writingReceipt, target)) {
    throw new Error('complete lifecycle root receipt writer is not the authorized target')
  }
  if (namespace.pendingState) throw new Error('lifecycle root receipt writer raced an existing pending authority')
  const pendingAbsent = captureFileState(namespace.pending, LIFECYCLE_ROOT_RECEIPT_MAX_BYTES)
  assertDirectoryFence(namespace.directory, fence)
  assertCapturedFileState(namespace.writing, namespace.writingState, 'complete lifecycle root receipt writer recovery', LIFECYCLE_ROOT_RECEIPT_MAX_BYTES)
  assertCapturedFileState(namespace.pending, pendingAbsent, 'absent lifecycle root receipt pending recovery target', LIFECYCLE_ROOT_RECEIPT_MAX_BYTES)
  fs.linkSync(namespace.writing, namespace.pending)
  flushDirectory(namespace.directory)
  namespace = readLifecycleRootReceiptNamespace(host)
  if (!namespace.writing || !namespace.writingState || !namespace.pendingState
    || namespace.writingState.stat?.nlink !== 2 || namespace.pendingState.stat?.nlink !== 2) {
    throw new Error('lifecycle root receipt writer recovery did not form its exact linked pair')
  }
  assertCapturedFileState(namespace.writing, namespace.writingState, 'linked lifecycle root receipt writer recovery', LIFECYCLE_ROOT_RECEIPT_MAX_BYTES)
  fs.unlinkSync(namespace.writing)
  flushDirectory(namespace.directory)
  return readLifecycleRootReceiptNamespace(host)
}

function ensureLifecycleRootReceipt(
  host: InstallHost,
  target: LifecycleRootReceiptV1,
  allowedCurrent: readonly (LifecycleRootReceiptV1 | null)[]
): CapturedFileState {
  validateLifecycleRootReceipt(target as unknown as Record<string, unknown>, host)
  let namespace = ensureLifecycleRootReceiptDirectory(host)
  const allowed = allowedCurrent.some((candidate) => sameLifecycleRootReceipt(candidate, target))
    ? allowedCurrent
    : [...allowedCurrent, target]
  namespace = recoverLifecycleRootReceiptWriter(namespace, host, target, allowed)
  namespace = collapseLifecycleRootReceiptPair(namespace, host, allowed)

  if (namespace.pendingReceipt) {
    if (!sameLifecycleRootReceipt(namespace.pendingReceipt, target)) {
      throw new Error('lifecycle root receipt has an unexpected pending transition')
    }
    assertLifecycleRootReceiptCurrentAllowed(namespace.receipt, allowed)
  } else if (sameLifecycleRootReceipt(namespace.receipt, target)) {
    const state = namespace.receiptState
    if (!state?.stat || state.stat.nlink !== 1) throw new Error('lifecycle root receipt target is not uniquely published')
    flushDirectory(namespace.directory)
    assertCapturedFileState(namespace.file, state, 'lifecycle root receipt existing target durability', LIFECYCLE_ROOT_RECEIPT_MAX_BYTES)
    const durable = readLifecycleRootReceiptNamespace(host)
    if (durable.pendingState || durable.writingState || !sameLifecycleRootReceipt(durable.receipt, target)
      || !durable.receiptState?.stat || durable.receiptState.stat.nlink !== 1) {
      throw new Error('lifecycle root receipt existing target failed its durable terminal seal')
    }
    return durable.receiptState
  } else {
    assertLifecycleRootReceiptCurrentAllowed(namespace.receipt, allowed)
    writeLifecycleRootReceiptPending(namespace, target, host)
    namespace = readLifecycleRootReceiptNamespace(host)
  }

  if (!namespace.pendingReceipt || !namespace.pendingState) {
    throw new Error('lifecycle root receipt pending transition disappeared')
  }
  if (!sameLifecycleRootReceipt(namespace.pendingReceipt, target)) {
    throw new Error('lifecycle root receipt pending transition changed')
  }
  const fence = captureDirectoryFence(namespace.directory)
  if (!namespace.receiptState) {
    assertLifecycleRootReceiptCurrentAllowed(null, allowed)
    const absent = captureFileState(namespace.file, LIFECYCLE_ROOT_RECEIPT_MAX_BYTES)
    if (absent.stat) throw new Error('lifecycle root receipt appeared before no-replace publication')
    assertDirectoryFence(namespace.directory, fence)
    assertCapturedFileState(namespace.pending, namespace.pendingState, 'lifecycle root receipt pending publication', LIFECYCLE_ROOT_RECEIPT_MAX_BYTES)
    assertCapturedFileState(namespace.file, absent, 'lifecycle root receipt absent target', LIFECYCLE_ROOT_RECEIPT_MAX_BYTES)
    fs.linkSync(namespace.pending, namespace.file)
    flushDirectory(namespace.directory)
    namespace = readLifecycleRootReceiptNamespace(host)
    if (!namespace.receiptState?.stat || !namespace.pendingState?.stat
      || namespace.receiptState.stat.nlink !== 2 || namespace.pendingState.stat.nlink !== 2
      || namespace.receiptState.stat.dev !== namespace.pendingState.stat.dev
      || namespace.receiptState.stat.ino !== namespace.pendingState.stat.ino) {
      throw new Error('lifecycle root receipt no-replace publication did not form its exact linked pair')
    }
    namespace = collapseLifecycleRootReceiptPair(namespace, host, [target])
  } else {
    assertLifecycleRootReceiptCurrentAllowed(namespace.receipt, allowed)
    assertDirectoryFence(namespace.directory, fence)
    assertCapturedFileState(namespace.file, namespace.receiptState, 'lifecycle root receipt replacement target', LIFECYCLE_ROOT_RECEIPT_MAX_BYTES)
    assertCapturedFileState(namespace.pending, namespace.pendingState, 'lifecycle root receipt replacement pending', LIFECYCLE_ROOT_RECEIPT_MAX_BYTES)
    fs.renameSync(namespace.pending, namespace.file)
    flushDirectory(namespace.directory)
    namespace = readLifecycleRootReceiptNamespace(host)
  }
  if (!namespace.receiptState?.stat || namespace.receiptState.stat.nlink !== 1 || namespace.pendingState
    || !sameLifecycleRootReceipt(namespace.receipt, target)) {
    throw new Error('lifecycle root receipt transition failed its terminal seal')
  }
  return namespace.receiptState
}

function removeLifecycleRootReceipt(host: InstallHost, expected: LifecycleRootReceiptV1): void {
  let namespace = readLifecycleRootReceiptNamespace(host)
  if (!namespace.directoryExists || !namespace.markerState?.stat) {
    throw new Error('lifecycle root receipt namespace is missing before exact removal')
  }
  namespace = collapseLifecycleRootReceiptPair(namespace, host, [expected])
  if (namespace.pendingState) throw new Error('lifecycle root receipt has an unresolved pending transition')
  if (namespace.writingState) throw new Error('lifecycle root receipt has an unresolved writer during removal')
  if (!namespace.receiptState) {
    flushDirectory(namespace.directory)
    const absent = readLifecycleRootReceiptNamespace(host)
    if (!absent.markerState?.stat || absent.receiptState || absent.pendingState || absent.writingState) {
      throw new Error('lifecycle root receipt absence changed during durable retry proof')
    }
    return
  }
  if (!sameLifecycleRootReceipt(namespace.receipt, expected) || !namespace.receiptState) {
    throw new Error('lifecycle root receipt changed before exact removal')
  }
  const fence = captureDirectoryFence(namespace.directory)
  assertDirectoryFence(namespace.directory, fence)
  assertCapturedFileState(namespace.file, namespace.receiptState, 'lifecycle root receipt removal', LIFECYCLE_ROOT_RECEIPT_MAX_BYTES)
  fs.unlinkSync(namespace.file)
  flushDirectory(namespace.directory)
  const after = readLifecycleRootReceiptNamespace(host)
  if (after.receiptState || after.pendingState || after.writingState) {
    throw new Error('lifecycle root receipt removal left protocol residue')
  }
}

function removeLifecycleRootReceiptWithDurableRetry(
  host: InstallHost,
  expected: LifecycleRootReceiptV1,
  frozenNamespace: LifecycleRootReceiptNamespace,
  sealTerminalEpoch: (receiptAbsent: boolean) => void
): void {
  const frozenState = frozenNamespace.receiptState
  if (!frozenState?.stat || frozenState.stat.nlink !== 1
    || !sameLifecycleRootReceipt(frozenNamespace.receipt, expected)
    || frozenNamespace.pendingState || frozenNamespace.writingState) {
    throw new Error('lifecycle root receipt removal has no exact frozen terminal authority')
  }
  const removeOrSealAbsent = () => {
    const current = readLifecycleRootReceiptNamespace(host)
    if (!current.directoryExists || !current.markerState?.stat
      || current.pendingState || current.writingState) {
      throw new Error('lifecycle root receipt namespace changed during durable removal')
    }
    if (current.receiptState) {
      sealTerminalEpoch(false)
      if (!sameLifecycleRootReceipt(current.receipt, expected)) {
        throw new Error('lifecycle root receipt changed during durable removal')
      }
      assertCapturedFileState(
        current.file,
        frozenState,
        'frozen lifecycle root receipt removal',
        LIFECYCLE_ROOT_RECEIPT_MAX_BYTES
      )
      fs.unlinkSync(current.file)
    } else {
      sealTerminalEpoch(true)
    }
    flushDirectory(current.directory)
    const absent = readLifecycleRootReceiptNamespace(host)
    if (!absent.markerState?.stat || absent.receiptState || absent.pendingState || absent.writingState) {
      throw new Error('lifecycle root receipt durable removal failed its absence seal')
    }
    sealTerminalEpoch(true)
  }
  try {
    removeOrSealAbsent()
  } catch {
    // The unlink can already be the publication truth when only its directory
    // flush/readback failed. Retry only the originally-frozen inode or an exact
    // absent path; never recapture a present replacement as new authority.
    removeOrSealAbsent()
  }
}

function adoptCompleteLifecycleRootReceiptWriterReservation(
  paths: InstallPaths,
  candidate: PackageIdentity,
  host: InstallHost,
  allowedCurrent: readonly (LifecycleRootReceiptV1 | null)[]
): LifecycleRootReceiptV1 | null {
  const namespace = readLifecycleRootReceiptNamespace(host)
  if (!namespace.writingState || !namespace.writingReceipt) return null
  if (namespace.pendingState) throw new Error('complete lifecycle root receipt writer conflicts with pending locator authority')
  assertLifecycleRootReceiptCurrentAllowed(namespace.receipt, allowedCurrent)
  assertPackageIdentityCurrent(candidate, 'complete lifecycle root receipt reservation package')
  const reservation = namespace.writingReceipt
  if (namespace.receipt && !sameLifecycleRootReceiptNamespace(namespace.receipt, reservation, host)) {
    throw new Error('complete lifecycle root receipt writer crosses the published preserved root namespace')
  }
  if (reservation.state !== 'active'
    || !samePath(reservation.dataRoot, paths.dataRoot, host.platform)
    || !samePath(reservation.installDir, paths.installDir, host.platform)
    || !samePath(reservation.packageRoot, candidate.packageRoot, host.platform)
    || reservation.packageVersion !== candidate.version
    || reservation.packageSha256 !== candidate.sha256) {
    throw new Error('complete lifecycle root receipt writer is not the requested package reservation')
  }
  if (readInstallManifest(paths, host.platform, 'install-only')) {
    throw new Error('complete lifecycle root receipt writer cannot replace an existing installation')
  }
  const marker = preflightDataRoot(paths, candidate, host, false)
  if (marker && (marker.activeInstallId !== null || marker.dataRootId !== reservation.dataRootId)) {
    throw new Error('complete lifecycle root receipt writer does not bind the inactive data-root marker')
  }
  ensureLifecycleRootReceipt(host, reservation, [...allowedCurrent, reservation])
  assertPackageIdentityCurrent(candidate, 'complete lifecycle root receipt reservation package terminal seal')
  const terminalMarker = preflightDataRoot(paths, candidate, host, false)
  if (canonicalJson(terminalMarker) !== canonicalJson(marker)) {
    throw new Error('complete lifecycle root receipt reservation data marker changed during publication')
  }
  assertLifecycleRootReceiptCurrentExact(host, reservation)
  return reservation
}

function lifecycleRootReceiptForManifest(
  manifest: InstallManifestV2,
  state: 'active' | 'inactive',
  prior: LifecycleRootReceiptV1 | null = null,
  updatedAt = manifest.updatedAt
): LifecycleRootReceiptV1 {
  return {
    schemaVersion: LIFECYCLE_ROOT_RECEIPT_VERSION,
    product: PRODUCT_NAME,
    state,
    installId: manifest.installId,
    dataRootId: manifest.dataRootId,
    dataRoot: manifest.dataRoot,
    installDir: manifest.installDir,
    packageRoot: manifest.packageRoot,
    packageVersion: manifest.packageVersion,
    packageSha256: manifest.packageSha256,
    createdAt: prior?.createdAt || manifest.installedAt,
    updatedAt
  }
}

function assertLifecycleRootReceiptBindsManifest(
  receipt: LifecycleRootReceiptV1,
  manifest: InstallManifestV2,
  state: 'active' | 'inactive',
  host: InstallHost
): void {
  const expected = lifecycleRootReceiptForManifest(manifest, state, receipt, receipt.updatedAt)
  if (!sameLifecycleRootReceipt(receipt, expected)
    || !samePath(receipt.dataRoot, manifest.dataRoot, host.platform)
    || !samePath(receipt.installDir, manifest.installDir, host.platform)
    || !samePath(receipt.packageRoot, manifest.packageRoot, host.platform)) {
    throw new Error(`lifecycle root receipt does not bind the ${state} installation manifest`)
  }
}

function lifecycleRootReceiptWalTarget(wal: LifecycleWalV1): LifecycleRootReceiptV1 {
  if (wal.operation === 'setup' || wal.phase === 'committed') return wal.newReceipt
  if (!wal.oldReceipt) throw new Error('non-committed lifecycle WAL has no prior root receipt')
  return wal.oldReceipt
}

function assertLifecycleRootReceiptWalClosure(wal: LifecycleWalV1, host: InstallHost): LifecycleRootReceiptV1 {
  const namespace = readLifecycleRootReceiptNamespace(host)
  const target = lifecycleRootReceiptWalTarget(wal)
  if (!namespace.directoryExists || !namespace.markerState?.stat || !namespace.receipt) {
    throw new Error('lifecycle WAL has no strict published root receipt authority')
  }
  const transitional = wal.phase === 'committed' && wal.operation !== 'setup'
  const allowedFinal = transitional
    ? [wal.oldReceipt, wal.newReceipt].filter(Boolean) as LifecycleRootReceiptV1[]
    : [target]
  if (!allowedFinal.some((candidate) => sameLifecycleRootReceipt(namespace.receipt, candidate))) {
    throw new Error('lifecycle root receipt is outside the WAL transition closure')
  }
  if (!transitional && (namespace.pendingState || namespace.writingState)) {
    throw new Error('non-committed lifecycle root receipt has unexpected publication residue')
  }
  if (namespace.pendingReceipt && !sameLifecycleRootReceipt(namespace.pendingReceipt, wal.newReceipt)) {
    throw new Error('lifecycle root receipt pending state is not the WAL target')
  }
  if (namespace.writingState) {
    if (namespace.writingReceipt && !sameLifecycleRootReceipt(namespace.writingReceipt, wal.newReceipt)) {
      throw new Error('lifecycle root receipt writer is not the WAL target')
    }
    if (!namespace.writingReceipt && (!namespace.writingOwner || Date.now() <= namespace.writingOwner.leaseUntil)) {
      throw new Error('lifecycle root receipt has a recent or unbound partial writer')
    }
    const stable = captureFileState(namespace.writing!, LIFECYCLE_ROOT_RECEIPT_MAX_BYTES, namespace.writingState.stat?.nlink === 2)
    if (!sameOptionalBuffer(stable.bytes, namespace.writingState.bytes)
      || canonicalJson(stable.stat) !== canonicalJson(namespace.writingState.stat)) {
      throw new Error('lifecycle root receipt writer changed during WAL closure')
    }
  }
  return target
}

function assertLifecycleRootReceiptCurrentExact(host: InstallHost, expected: LifecycleRootReceiptV1): void {
  if (!sameLifecycleRootReceipt(readLifecycleRootReceipt(host), expected)) {
    throw new Error('lifecycle root receipt does not match the required WAL terminal state')
  }
}

function packageIdentity(packageRoot: string): PackageIdentity {
  const root = resolve(packageRoot)
  assertPlainDirectory(root, 'candidate package root')
  const required = new Set([
    'package.json',
    'server/index.mjs',
    ...PUBLIC_RUNTIME_FILES
  ])
  let totalBytes = 0
  let entries = 0
  const countedFiles = new Set<string>()
  const releaseInventory: Array<{ path: string; kind: 'directory' | 'file'; size: number }> = []
  for (const subtree of ['dist', 'web']) {
    const subtreeRoot = join(root, subtree)
    assertPlainDirectory(subtreeRoot, `candidate package ${subtree}`)
    const visit = (directory: string, prefix: string) => {
      for (const entry of boundedDirectoryEntries(
        directory,
        20_000 - entries,
        'candidate package release directory'
      ).sort((left, right) => left.name.localeCompare(right.name))) {
        const name = entry.name
        entries += 1
        if (entries > 20_000) throw new Error('candidate package exceeds the 20000-entry release limit')
        const absolute = join(directory, name)
        const relativePath = `${prefix}/${name}`
        const stat = fs.lstatSync(absolute)
        if (stat.isSymbolicLink()) throw new Error(`candidate package contains a reparse/symbolic entry: ${relativePath}`)
        if (stat.isDirectory()) {
          releaseInventory.push({ path: relativePath, kind: 'directory', size: 0 })
          visit(absolute, relativePath)
        }
        else if (stat.isFile()) {
          totalBytes += stat.size
          if (totalBytes > 256 * 1024 * 1024) throw new Error('candidate package exceeds the 256 MiB release limit')
          required.add(relativePath)
          countedFiles.add(relativePath)
          releaseInventory.push({ path: relativePath, kind: 'file', size: stat.size })
        } else throw new Error(`candidate package contains an unsupported entry: ${relativePath}`)
      }
    }
    visit(subtreeRoot, subtree)
  }
  if (!required.has('dist/control/cli.js')) throw new Error('candidate package is missing dist/control/cli.js')
  const bufferedFiles = new Map<string, Buffer>()
  for (const relativePath of required) {
    assertPlainPathFromRoot(root, join(root, ...relativePath.split('/')), `candidate package ${relativePath}`)
  }
  bufferedFiles.set(
    'package.json',
    readBoundedPlainFile(join(root, 'package.json'), 1024 * 1024, 'candidate package.json')
  )
  for (const relativePath of PUBLIC_RUNTIME_FILES) {
    bufferedFiles.set(
      relativePath,
      readBoundedPlainFile(
        join(root, ...relativePath.split('/')),
        16 * 1024 * 1024,
        `candidate public runtime ${relativePath}`
      )
    )
  }
  const facts = [...required].sort((a, b) => a.localeCompare(b)).map((relativePath) => {
    const file = join(root, ...relativePath.split('/'))
    assertPlainFile(file, `candidate package ${relativePath}`)
    const stat = fs.lstatSync(file)
    if (!countedFiles.has(relativePath)) {
      entries += 1
      totalBytes += stat.size
      if (entries > 20_000) throw new Error('candidate package exceeds the 20000-entry release limit')
      if (totalBytes > 256 * 1024 * 1024) throw new Error('candidate package exceeds the 256 MiB release limit')
    }
    if (stat.size > 64 * 1024 * 1024) throw new Error(`candidate package file exceeds the 64 MiB per-file limit: ${relativePath}`)
    const buffered = bufferedFiles.get(relativePath)
    if (buffered && buffered.length !== stat.size) {
      throw new Error(`candidate package file changed while freezing release identity: ${relativePath}`)
    }
    return {
      path: relativePath,
      sha256: buffered ? sha256Bytes(buffered) : sha256File(file, 64 * 1024 * 1024),
      size: stat.size
    }
  })
  // Re-read every release file after the inventory walk. This makes the
  // returned identity coherent across the complete dist/web/runtime set.
  for (const fact of facts) {
    const file = join(root, ...fact.path.split('/'))
    assertPlainPathFromRoot(root, file, `candidate package ${fact.path}`)
    const current = sha256File(file, 64 * 1024 * 1024)
    const currentSize = fs.lstatSync(file).size
    if (current !== fact.sha256 || currentSize !== fact.size) {
      throw new Error(`candidate package changed while freezing release identity: ${fact.path}`)
    }
  }
  const currentInventory: Array<{ path: string; kind: 'directory' | 'file'; size: number }> = []
  let currentEntries = 0
  let currentBytes = 0
  const revisit = (directory: string, prefix: string) => {
    for (const entry of boundedDirectoryEntries(
      directory,
      20_000 - currentEntries,
      'candidate package release revalidation directory'
    ).sort((left, right) => left.name.localeCompare(right.name))) {
      const name = entry.name
      currentEntries += 1
      if (currentEntries > 20_000) throw new Error('candidate package exceeds the 20000-entry release limit')
      const absolute = join(directory, name)
      const relativePath = `${prefix}/${name}`
      const stat = fs.lstatSync(absolute)
      if (stat.isSymbolicLink()) throw new Error(`candidate package contains a reparse/symbolic entry: ${relativePath}`)
      if (stat.isDirectory()) {
        currentInventory.push({ path: relativePath, kind: 'directory', size: 0 })
        revisit(absolute, relativePath)
      } else if (stat.isFile()) {
        currentBytes += stat.size
        if (currentBytes > 256 * 1024 * 1024) throw new Error('candidate package exceeds the 256 MiB release limit')
        currentInventory.push({ path: relativePath, kind: 'file', size: stat.size })
      } else throw new Error(`candidate package contains an unsupported entry: ${relativePath}`)
    }
  }
  for (const subtree of ['dist', 'web']) revisit(join(root, subtree), subtree)
  if (canonicalJson(currentInventory) !== canonicalJson(releaseInventory)) {
    throw new Error('candidate package inventory changed while freezing release identity')
  }
  const packageBytes = bufferedFiles.get('package.json') as Buffer
  const pkg = JSON.parse(packageBytes.toString('utf8')) as { name?: unknown; version?: unknown }
  if (pkg.name !== 'ozdqp-skill-hub' || typeof pkg.version !== 'string'
    || !pkg.version.trim() || pkg.version.length > 128 || /[\u0000-\u001f\u007f]/.test(pkg.version)) {
    throw new Error('candidate package metadata must identify ozdqp-skill-hub with a version')
  }
  const publicRuntime = new Map(PUBLIC_RUNTIME_FILES.map((relativePath) => [
    relativePath,
    Buffer.from(bufferedFiles.get(relativePath) as Buffer)
  ] as const))
  return {
    packageRoot: root,
    version: pkg.version,
    sha256: sha256Bytes(canonicalJson({ version: pkg.version, files: facts })),
    publicRuntime,
    publicRuntimeFacts: PUBLIC_RUNTIME_FILES.map((relativePath) => {
      const bytes = publicRuntime.get(relativePath) as Buffer
      return { path: relativePath, sha256: sha256Bytes(bytes), size: bytes.length }
    })
  }
}

function assertPackageIdentityCurrent(expected: PackageIdentity, label = 'package'): void {
  const current = packageIdentity(expected.packageRoot)
  if (current.version !== expected.version || current.sha256 !== expected.sha256) {
    throw new Error(`${label} identity changed during lifecycle operation`)
  }
}

type PackageAuthoritySnapshot = { directories: DirectoryFence }

function capturePackageAuthoritySnapshot(expected: PackageIdentity, label: string): PackageAuthoritySnapshot {
  const snapshot = { directories: captureDirectoryFence(expected.packageRoot) }
  assertPackageAuthoritySnapshot(expected, snapshot, label)
  return snapshot
}

function assertPackageAuthoritySnapshot(
  expected: PackageIdentity,
  snapshot: PackageAuthoritySnapshot,
  label: string
): void {
  assertDirectoryFence(expected.packageRoot, snapshot.directories)
  assertPackageIdentityCurrent(expected, label)
  assertDirectoryFence(expected.packageRoot, snapshot.directories)
}

function publicRuntimeFacts(dataRoot: string) {
  return PUBLIC_RUNTIME_FILES.map((relativePath) => {
    const file = join(dataRoot, ...relativePath.split('/'))
    const bytes = readBoundedPlainFile(file, 16 * 1024 * 1024, `data runtime ${relativePath}`)
    return { path: relativePath, sha256: sha256Bytes(bytes), size: bytes.length }
  })
}

function validateDataRootMarker(
  value: Record<string, unknown>,
  paths: InstallPaths,
  platform: NodeJS.Platform | string = process.platform
): DataRootMarkerV1 {
  if (!exactKeys(value, ['schemaVersion', 'dataRootId', 'activeInstallId', 'canonicalRoot', 'createdAt', 'runtime'])
    || value.schemaVersion !== DATA_ROOT_MARKER_VERSION
    || typeof value.dataRootId !== 'string' || !UUID.test(value.dataRootId)
    || value.activeInstallId !== null && (typeof value.activeInstallId !== 'string' || !UUID.test(value.activeInstallId))
    || typeof value.canonicalRoot !== 'string' || !isAbsolute(value.canonicalRoot)
    || !samePath(value.canonicalRoot, paths.dataRoot, platform)
    || !canonicalIsoTimestamp(value.createdAt)
    || !value.runtime || typeof value.runtime !== 'object') {
    throw new Error('invalid or foreign data-root ownership marker')
  }
  const runtime = value.runtime as Record<string, unknown>
  if (!exactKeys(runtime, ['schemaVersion', 'files'])
    || runtime.schemaVersion !== PUBLIC_RUNTIME_CORPUS_VERSION || !Array.isArray(runtime.files)
    || runtime.files.length !== PUBLIC_RUNTIME_FILES.length) {
    throw new Error('invalid data-root public runtime manifest')
  }
  const seen = new Set<string>()
  let runtimeBytes = 0
  for (const item of runtime.files) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('invalid data-root public runtime entry')
    const entry = item as Record<string, unknown>
    if (!exactKeys(entry, ['path', 'sha256', 'size'])
      || typeof entry.path !== 'string' || !PUBLIC_RUNTIME_FILES.includes(entry.path)
      || seen.has(entry.path)
      || typeof entry.sha256 !== 'string' || !SHA256_DIGEST.test(entry.sha256)
      || typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size)
      || entry.size < 0 || entry.size > 16 * 1024 * 1024) {
      throw new Error('invalid data-root public runtime entry')
    }
    runtimeBytes += entry.size as number
    if (runtimeBytes > 256 * 1024 * 1024) throw new Error('data-root public runtime manifest exceeds its total bound')
    seen.add(entry.path)
  }
  return value as unknown as DataRootMarkerV1
}

function readDataRootMarker(paths: InstallPaths, platform: NodeJS.Platform | string = process.platform): DataRootMarkerV1 | null {
  const value = readJsonRecord(paths.dataMarkerPath, MARKER_MAX_BYTES)
  return value ? validateDataRootMarker(value, paths, platform) : null
}

function validateInstallManifest(
  value: Record<string, unknown>,
  paths: InstallPaths,
  platform: NodeJS.Platform | string
): InstallManifestV2 {
  if (!exactKeys(value, [
    'schemaVersion', 'installId', 'product', 'command', 'alias', 'packageRoot', 'packageVersion',
    'packageSha256', 'nodePath', 'dataRoot', 'dataRootId', 'installDir', 'binDir', 'extraShimDir', 'port',
    'taskName', 'features', 'owned', 'installedAt', 'updatedAt'
  ])
    || value.schemaVersion !== INSTALL_MANIFEST_VERSION
    || value.product !== PRODUCT_NAME || value.command !== PRODUCT_COMMAND || value.alias !== PRODUCT_ALIAS
    || typeof value.installId !== 'string' || !UUID.test(value.installId)
    || typeof value.packageRoot !== 'string' || !isAbsolute(value.packageRoot)
    || typeof value.packageVersion !== 'string' || value.packageVersion.length < 1 || value.packageVersion.length > 128
    || /[\u0000-\u001f\u007f]/.test(value.packageVersion)
    || typeof value.packageSha256 !== 'string' || !SHA256_DIGEST.test(value.packageSha256)
    || typeof value.nodePath !== 'string' || !isAbsolute(value.nodePath)
    || typeof value.dataRoot !== 'string' || !isAbsolute(value.dataRoot)
    || typeof value.dataRootId !== 'string' || !UUID.test(value.dataRootId)
    || typeof value.installDir !== 'string' || !isAbsolute(value.installDir)
    || typeof value.binDir !== 'string' || !isAbsolute(value.binDir)
    || value.extraShimDir !== null && (typeof value.extraShimDir !== 'string' || !isAbsolute(value.extraShimDir))
    || typeof value.port !== 'number' || !Number.isInteger(value.port)
    || typeof value.taskName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value.taskName)
    || !canonicalIsoTimestamp(value.installedAt)
    || !canonicalIsoTimestamp(value.updatedAt)
    || !value.features || typeof value.features !== 'object'
    || !value.owned || typeof value.owned !== 'object') {
    throw new Error('invalid or legacy install ownership manifest')
  }
  const manifest = value as unknown as InstallManifestV2
  if (!exactKeys(manifest.features as unknown as Record<string, unknown>, ['path', 'task', 'daemon'])
    || !exactKeys(manifest.owned as unknown as Record<string, unknown>, ['files', 'pathEntry', 'environment', 'task'])
    || typeof manifest.features.path !== 'boolean'
    || typeof manifest.features.task !== 'boolean'
    || typeof manifest.features.daemon !== 'boolean'
    || !Array.isArray(manifest.owned.files)
    || !manifest.owned.pathEntry
    || !exactKeys(manifest.owned.pathEntry as unknown as Record<string, unknown>, ['value', 'added', 'prior'])
    || typeof manifest.owned.pathEntry.value !== 'string'
    || typeof manifest.owned.pathEntry.added !== 'boolean'
    || !Array.isArray(manifest.owned.environment)
    || manifest.owned.files.some((file) => !file
      || !exactKeys(file as unknown as Record<string, unknown>, ['path', 'sha256'])
      || typeof file.path !== 'string' || !isAbsolute(file.path)
      || typeof file.sha256 !== 'string' || !SHA256_DIGEST.test(file.sha256))
    || manifest.owned.environment.some((entry) => !entry
      || !exactKeys(entry as unknown as Record<string, unknown>, ['name', 'value', 'created', 'kind'])
      || ![PRIMARY_DATA_ROOT_ENV, LEGACY_DATA_ROOT_ENV, 'HUB_API_PORT'].includes(entry.name)
      || typeof entry.value !== 'string' || typeof entry.created !== 'boolean'
      || entry.kind !== 'String' && entry.kind !== 'ExpandString'
      || entry.created && entry.kind !== 'ExpandString')
    || (manifest.owned.task !== null && (!manifest.owned.task
      || !exactKeys(manifest.owned.task as unknown as Record<string, unknown>, ['taskPath', 'name', 'launcher', 'created'])
      || manifest.owned.task.taskPath !== '\\'
      || typeof manifest.owned.task.name !== 'string'
      || typeof manifest.owned.task.launcher !== 'string'
      || typeof manifest.owned.task.created !== 'boolean'))) {
    throw new Error('invalid install ownership manifest details')
  }
  if (!samePath(manifest.installDir, paths.installDir, platform)
    || !samePath(manifest.binDir, paths.binDir, platform)
    || !samePath(manifest.dataRoot, paths.dataRoot, platform)
    || !samePath(manifest.packageRoot, paths.packageRoot, platform)
    || !samePath(manifest.nodePath, paths.nodePath, platform)
    || !manifest.features.path && manifest.extraShimDir !== null
    || manifest.extraShimDir === null !== (paths.extraShimDir === null)
    || manifest.extraShimDir !== null && paths.extraShimDir !== null && !samePath(manifest.extraShimDir, paths.extraShimDir, platform)
    || manifest.port !== paths.port
    || manifest.port < 1 || manifest.port > 65_535
    || manifest.taskName !== paths.taskName) {
    throw new Error('install ownership manifest is bound to another lifecycle root')
  }
  if (!samePath(manifest.owned.pathEntry.value, paths.binDir, platform)
    || (!manifest.features.path && (manifest.owned.pathEntry.added || manifest.owned.pathEntry.prior !== null))) {
    throw new Error('install ownership PATH authority is not bound to the managed bin directory')
  }
  const priorPath = manifest.owned.pathEntry.prior as unknown
  if (manifest.owned.pathEntry.added) {
    if (!priorPath || typeof priorPath !== 'object' || Array.isArray(priorPath)
      || !exactKeys(priorPath as Record<string, unknown>, ['exists', 'value', 'kind'])) {
      throw new Error('install ownership PATH prior state is invalid')
    }
    const prior = priorPath as Record<string, unknown>
    if (typeof prior.exists !== 'boolean' || typeof prior.value !== 'string'
      || Buffer.byteLength(prior.value, 'utf8') > INTEGRATION_VALUE_MAX_BYTES
      || prior.kind !== null && prior.kind !== 'String' && prior.kind !== 'ExpandString'
      || !prior.exists && (prior.value !== '' || prior.kind !== null)
      || prior.exists && prior.kind === null) {
      throw new Error('install ownership PATH prior state is invalid')
    }
  } else if (priorPath !== null) {
    throw new Error('install ownership PATH prior state exists without owned PATH mutation')
  }
  const environment = new Map<string, OwnedEnvironmentValue>()
  for (const entry of manifest.owned.environment) {
    if (environment.has(entry.name)) throw new Error('install ownership environment entries must be unique')
    environment.set(entry.name, entry)
  }
  const expectedEnvironment = manifest.features.path && platform === 'win32'
    ? new Map<string, string>([
      [PRIMARY_DATA_ROOT_ENV, paths.dataRoot],
      [LEGACY_DATA_ROOT_ENV, paths.dataRoot],
      ['HUB_API_PORT', String(paths.port)]
    ])
    : new Map<string, string>()
  if (environment.size !== expectedEnvironment.size
    || [...expectedEnvironment].some(([name, expected]) => environment.get(name)?.value !== expected)) {
    throw new Error('install ownership environment authority is not bound to the lifecycle roots')
  }
  if (!manifest.features.task) {
    if (manifest.owned.task !== null) throw new Error('disabled scheduled-task feature cannot carry task ownership')
  } else if (!manifest.owned.task
    || !manifest.owned.task.created
    || manifest.owned.task.name !== paths.taskName
    || !samePath(manifest.owned.task.launcher, paths.silentVbs, platform)) {
    throw new Error('install ownership scheduled task is not bound to the managed launcher')
  }
  if (manifest.features.task && !manifest.features.daemon) {
    throw new Error('scheduled-task ownership requires the daemon lifecycle feature')
  }
  const expectedOwnedFiles = [
    paths.shimCmd,
    paths.shimAliasCmd,
    paths.shimUnix,
    paths.silentVbs,
    paths.runDaemonCmd,
    ...(manifest.features.path ? [paths.extraShimCmd, paths.extraShimAliasCmd].filter(Boolean) as string[] : [])
  ]
  const pathKey = (file: string) => platform === 'win32' ? resolve(file).toLowerCase() : resolve(file)
  const expectedFileKeys = new Set(expectedOwnedFiles.map(pathKey))
  const actualFileKeys = new Set(manifest.owned.files.map((entry) => pathKey(entry.path)))
  if (actualFileKeys.size !== manifest.owned.files.length
    || actualFileKeys.size !== expectedFileKeys.size
    || [...actualFileKeys].some((file) => !expectedFileKeys.has(file))) {
    throw new Error('install ownership file inventory is not the exact managed artifact set')
  }
  return manifest
}

function readInstallManifest(
  paths: InstallPaths,
  platform: NodeJS.Platform | string = process.platform,
  selection: 'exact' | 'install-only' = 'exact'
): InstallManifestV2 | null {
  const value = readJsonRecord(paths.manifestPath, MANIFEST_MAX_BYTES)
  if (!value) return null
  const embeddedPaths = resolveInstallPaths(pathApi, {
    hubRoot: String(value.packageRoot || ''),
    packageRoot: String(value.packageRoot || ''),
    dataRoot: String(value.dataRoot || ''),
    nodePath: String(value.nodePath || ''),
    installDir: String(value.installDir || ''),
    extraShimDir: value.extraShimDir === null ? null : String(value.extraShimDir || ''),
    taskName: String(value.taskName || ''),
    port: Number(value.port || 0)
  })
  const manifest = validateInstallManifest(value, embeddedPaths, platform)
  if (!samePath(manifest.installDir, paths.installDir, platform)
    || selection === 'exact' && (!samePath(manifest.dataRoot, paths.dataRoot, platform)
      || manifest.taskName !== paths.taskName
      || manifest.port !== paths.port)) {
    throw new Error('install ownership manifest is bound to another lifecycle selection')
  }
  return manifest
}

function lifecycleLockHealthy(paths: InstallPaths, host: InstallHost): boolean {
  const state = lifecycleLockState(paths, host)
  return state === 'clear' || state === 'stale'
}

type LifecycleLockRecord = {
  schemaVersion: 1
  token: string
  pid: number
  operation: 'setup' | 'upgrade' | 'uninstall' | 'recover' | 'purge'
  installDir: string
  createdAt: string
}

type LifecycleLease = {
  token: string
  /** WAL snapshot adopted while the machine mutex was held, if any. */
  recoveryWal: LifecycleWalV1 | null
  recoveryWalState: CapturedFileState | null
  recoveryTerminalMarkerState: CapturedFileState | null
  recoveryTerminalDataRootFence: DirectoryFence | null
  applicationOwner: ApplicationOwnerBinding | null
  assertPostPublicationAuthority: () => void
  sealApplicationGate: () => void
  revalidateApplicationGate: () => Promise<void>
  releaseApplicationGate: () => Promise<void>
  retireOwnerRecord: () => void
  preserveOwnerRecord: () => void
  release: () => Promise<void>
}

type LifecycleRootReceiptPlan = {
  target: LifecycleRootReceiptV1
  allowedCurrent: readonly (LifecycleRootReceiptV1 | null)[]
  /** Terminal receipt/WAL recovery must not inspect historical install/package bytes. */
  terminalPreflight?: boolean
  /** Exact caller authority frozen before the mutex await and checked before any receipt mutation. */
  sealBeforePublication: () => void
  /** Exact target authority checked after receipt normalization/publication. */
  sealAfterPublication: () => void
  /** Operation-specific non-owner authority checked after owner publication. */
  sealPostOwnerPublication?: () => void
  /** Long external authority check that renews the held Application gate. */
  revalidateExternalAuthority?: (renew: () => Promise<void>) => Promise<void>
  /** Private deterministic seam after the first gate renewal and before its exact post-seal. */
  afterApplicationGateRevalidate?: () => void | Promise<void>
}

type OwnedLifecycleProof = {
  lockToken: string
  applicationOwner: ApplicationOwnerBinding
  wal: LifecycleWalV1
}

type ApplicationOwnerBinding = Pick<LockRecordV1,
  'scope' | 'lockKey' | 'ownerToken' | 'hostId' | 'pid' | 'processIdentity'
  | 'command' | 'requestId' | 'acquiredAt'>

function applicationOwnerBinding(record: LockRecordV1): ApplicationOwnerBinding {
  return {
    scope: record.scope,
    lockKey: record.lockKey,
    ownerToken: record.ownerToken,
    hostId: record.hostId,
    pid: record.pid,
    processIdentity: record.processIdentity,
    command: record.command,
    requestId: record.requestId,
    acquiredAt: record.acquiredAt
  }
}

function sameApplicationOwnerBinding(record: LockRecordV1, binding: ApplicationOwnerBinding): boolean {
  return canonicalJson(applicationOwnerBinding(record)) === canonicalJson(binding)
}

function readLifecycleLockFile(
  file: string,
  paths: InstallPaths,
  platform: NodeJS.Platform | string,
  allowLinked = false
): LifecycleLockRecord | null {
  const lock = readJsonRecord(file, LIFECYCLE_LOCK_MAX_BYTES, allowLinked)
  if (!lock) return null
  if (!exactKeys(lock, ['schemaVersion', 'token', 'pid', 'operation', 'installDir', 'createdAt'])
    || lock.schemaVersion !== 1
    || typeof lock.token !== 'string' || !UUID.test(lock.token)
    || typeof lock.pid !== 'number' || !Number.isSafeInteger(lock.pid) || lock.pid < 1
    || !['setup', 'upgrade', 'uninstall', 'recover', 'purge'].includes(String(lock.operation))
    || typeof lock.installDir !== 'string' || !samePath(lock.installDir, paths.installDir, platform)
    || typeof lock.createdAt !== 'string' || !Number.isFinite(Date.parse(lock.createdAt))) {
    throw new Error('lifecycle lock is malformed or bound to another install root')
  }
  return lock as unknown as LifecycleLockRecord
}

function readLifecycleLock(paths: InstallPaths, host: InstallHost): LifecycleLockRecord | null {
  return readLifecycleLockFile(paths.lifecycleLockPath, paths, host.platform)
}

function lifecycleLockState(paths: InstallPaths, host: InstallHost): 'clear' | 'active' | 'stale' | 'unverifiable' {
  try {
    if (lstatOptional(paths.lifecycleLockPath) === null) return 'clear'
    const lock = readLifecycleLock(paths, host)
    // A numeric PID alone cannot distinguish the original owner from PID
    // reuse. The machine mutex is the writer authority; a read-only doctor
    // cannot safely probe it without changing state, so report a live PID as
    // unverifiable rather than claiming an active owner.
    return lock && host.pidAlive(lock.pid) ? 'unverifiable' : 'stale'
  } catch {
    return 'unverifiable'
  }
}

function durablePendingCount(dataRoot: string): number {
  const root = join(dataRoot, '.skill-graft-transactions')
  try {
    if (lstatOptional(root) === null) return 0
    assertPlainDirectory(root, 'durable transaction root')
    return boundedDirectoryEntries(root, 10_000, 'durable transaction inventory').length
  } catch {
    return 1
  }
}

function boundedDirectoryEntries(directory: string, limit: number, label: string): fs.Dirent[] {
  const opened = fs.opendirSync(directory)
  const entries: fs.Dirent[] = []
  try {
    for (;;) {
      const entry = opened.readSync()
      if (!entry) break
      if (entries.length >= limit) throw new Error(`${label} exceeds its inventory bound`)
      entries.push(entry)
    }
  } finally {
    opened.closeSync()
  }
  return entries
}

function boundedMatchingDirectoryEntries(
  directory: string,
  matches: (entry: fs.Dirent) => boolean,
  limit: number,
  label: string,
  scanLimit = 100_000
): fs.Dirent[] {
  const opened = fs.opendirSync(directory)
  const entries: fs.Dirent[] = []
  let scanned = 0
  try {
    for (;;) {
      const entry = opened.readSync()
      if (!entry) break
      scanned += 1
      if (scanned > scanLimit) throw new Error(`${label} exceeds its scan bound`)
      if (!matches(entry)) continue
      if (entries.length >= limit) throw new Error(`${label} exceeds its protocol-entry bound`)
      entries.push(entry)
    }
  } finally {
    opened.closeSync()
  }
  return entries
}

function reviewLockFacts(
  dataRoot: string,
  host: InstallHost,
  allowedHubOwner?: ApplicationOwnerBinding
): { active: number; stale: number; unverifiable: number } {
  try {
    assertLegacyApplicationLeaseNamespaceClear(dataRoot)
  } catch {
    return { active: 0, stale: 0, unverifiable: 1 }
  }
  const externalRoot = applicationLeaseRoot(dataRoot)
  const leases = join(externalRoot, 'leases')
  const result = { active: 0, stale: 0, unverifiable: 0 }
  try {
    if (lstatOptional(externalRoot) === null) return result
    assertApplicationLeaseNamespaceSafe(externalRoot)
    const namespaceEntries = boundedDirectoryEntries(externalRoot, 8, 'application lease namespace')
    if (namespaceEntries.some((entry) => /^\.namespace-bootstrap-/.test(entry.name))) {
      result.unverifiable += 1
    }
    if (!namespaceEntries.some((entry) => entry.name === APPLICATION_LEASE_NAMESPACE_MARKER)) {
      result.unverifiable += 1
    }
    if (lstatOptional(leases) === null) {
      result.unverifiable += 1
      return result
    }
    assertPlainDirectory(leases, 'application lease root')
    for (const entry of boundedDirectoryEntries(leases, 10_000, 'application lease inventory')) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^(?:hub-global|worktree-[a-f0-9]{64})\.lock$/.test(entry.name)) {
        result.unverifiable += 1
        continue
      }
      try {
        const liveDirectory = join(leases, entry.name)
        const liveEntries = boundedDirectoryEntries(liveDirectory, 32, 'live application lease')
        if (liveEntries.length !== 1 || liveEntries[0].name !== 'owner.json'
          || !liveEntries[0].isFile() || liveEntries[0].isSymbolicLink()) {
          result.unverifiable += 1
          continue
        }
        const owner = readJsonRecord(join(liveDirectory, 'owner.json'), 64 * 1024)
        const validated = validateLockRecordV1(owner)
        if (!validated.valid) {
          result.unverifiable += 1
          continue
        }
        const record = validated.value
        const expectedScope = entry.name === 'hub-global.lock' ? 'hub-global' : 'worktree'
        const expectedKey = entry.name === 'hub-global.lock'
          ? 'hub-global'
          : `sha256:${entry.name.slice('worktree-'.length, -'.lock'.length)}`
        if (record.scope !== expectedScope || record.lockKey !== expectedKey) {
          result.unverifiable += 1
          continue
        }
        const leaseUntil = Date.parse(record.leaseUntil)
        if (allowedHubOwner && entry.name === 'hub-global.lock'
          && record.ownerToken === allowedHubOwner.ownerToken) {
          if (record.pid === process.pid
            && record.scope === 'hub-global'
            && record.lockKey === 'hub-global'
            && sameApplicationOwnerBinding(record, allowedHubOwner)
            && leaseUntil > Date.now()) {
            continue
          }
          result.unverifiable += 1
          continue
        }
        if (leaseUntil > Date.now()) {
          result.active += 1
        } else if (!host.pidAlive(record.pid)) {
          result.stale += 1
        } else {
          // An expired record whose numeric PID is still live can be either
          // the original owner or PID reuse. This synchronous doctor path
          // cannot prove process identity, so it is never labelled recoverable.
          result.unverifiable += 1
        }
      } catch {
        result.unverifiable += 1
      }
    }
  } catch {
    result.unverifiable += 1
  }
  return result
}

function assertApplicationQuiescent(dataRoot: string, host: InstallHost, allowedHubOwner?: ApplicationOwnerBinding): void {
  const durable = durablePendingCount(dataRoot)
  if (durable > 0) throw new Error(`${durable} durable transaction artifact(s) must be recovered before lifecycle mutation`)
  const locks = reviewLockFacts(dataRoot, host, allowedHubOwner)
  if (locks.active > 0 || locks.stale > 0 || locks.unverifiable > 0) {
    throw new Error('application lease state must be clear before lifecycle mutation')
  }
}

function lifecycleMutexName(_paths: Pick<InstallPaths, 'dataRoot'>, _host: InstallHost): string {
  // Lifecycle writes are rare and can touch machine-global task names plus
  // shared install/data roots selected by different OS users. A single
  // machine-scope v1 mutex fences every writer before any durable owner/WAL
  // record is published; narrower data-root and Application gates follow it.
  const key = createHash('sha256').update('skill-graft.lifecycle.machine-global/v1').digest('hex')
  if (process.platform === 'win32') return `\\\\.\\pipe\\skill-graft-lifecycle-${key}`
  if (process.platform === 'linux') return `\0skill-graft-lifecycle-${key}`
  throw new Error(`lifecycle mutation is unsupported on ${process.platform} because no crash-safe OS mutex is available`)
}

async function listenLifecycleMutex(server: Server, name: string): Promise<void> {
  await new Promise<void>((resolveListen, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolveListen()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(name)
  })
}

async function closeLifecycleMutex(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
}

async function withLifecycleReadMutex<T>(
  paths: InstallPaths,
  host: InstallHost,
  action: () => T | Promise<T>,
  postAcquirePreflight?: () => void
): Promise<T> {
  const mutex = createServer((socket) => socket.destroy())
  try {
    await listenLifecycleMutex(mutex, lifecycleMutexName(paths, host))
    postAcquirePreflight?.()
    return await action()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new Error('lifecycle lock is already held (EADDRINUSE)')
    }
    throw error
  } finally {
    await closeLifecycleMutex(mutex)
  }
}

function installManifestPresentNoFollow(paths: InstallPaths): boolean {
  const install = lstatOptional(paths.installDir)
  if (!install || !install.isDirectory() || install.isSymbolicLink()) return false
  return lstatOptional(paths.manifestPath) !== null
}

function readAlreadyUninstalledMarker(paths: InstallPaths, host: InstallHost): DataRootMarkerV1 | null {
  assertLocalLifecycleRoot(paths.dataRoot, 'data root', host.platform)
  assertOutsideProtectedRoots(paths.dataRoot, 'data root', host)
  assertSafeRecursiveRoot(paths.dataRoot, 'data root', [host.home], host.platform)
  physicalLifecyclePath(paths.dataRoot, 'data root', host.platform, false)
  const marker = readDataRootMarker(paths, host.platform)
  if (!marker || marker.activeInstallId !== null) return null
  if (lstatOptional(paths.lifecycleWalPath) !== null || installManifestPresentNoFollow(paths)) return null
  return marker
}

type ReceiptBoundInactiveMarkerProof = {
  marker: DataRootMarkerV1
  state: CapturedFileState
}

function captureReceiptBoundInactiveMarker(
  paths: InstallPaths,
  receipt: LifecycleRootReceiptV1,
  host: InstallHost
): ReceiptBoundInactiveMarkerProof | null {
  if (receipt.state !== 'inactive') return null
  assertLocalLifecycleRoot(paths.dataRoot, 'data root', host.platform)
  assertOutsideProtectedRoots(paths.dataRoot, 'data root', host)
  assertSafeRecursiveRoot(paths.dataRoot, 'data root', [host.home], host.platform)
  physicalLifecyclePath(paths.dataRoot, 'data root', host.platform, false)
  const marker = readDataRootMarker(paths, host.platform)
  if (!marker || marker.activeInstallId !== null || marker.dataRootId !== receipt.dataRootId
    || lstatOptional(paths.lifecycleWalPath) !== null) return null
  const state = captureFileState(paths.dataMarkerPath, MARKER_MAX_BYTES)
  if (!state.stat || state.stat.nlink !== 1) {
    throw new Error('inactive receipt data marker is not a unique exact protocol file')
  }
  return { marker, state }
}

function assertReceiptBoundInactiveMarker(
  paths: InstallPaths,
  receipt: LifecycleRootReceiptV1,
  host: InstallHost,
  expected: ReceiptBoundInactiveMarkerProof
): void {
  assertCapturedFileState(
    paths.dataMarkerPath,
    expected.state,
    'inactive receipt terminal data marker',
    MARKER_MAX_BYTES
  )
  const current = captureReceiptBoundInactiveMarker(paths, receipt, host)
  if (!current || canonicalJson(current.marker) !== canonicalJson(expected.marker)
    || canonicalJson(current.state.stat) !== canonicalJson(expected.state.stat)
    || !sameOptionalBuffer(current.state.bytes, expected.state.bytes)) {
    throw new Error('inactive receipt terminal data marker changed')
  }
}

function lifecycleOwnerPendingPath(paths: InstallPaths, token: string): string {
  if (!UUID.test(token)) throw new Error('lifecycle owner publication token is invalid')
  return join(dirname(paths.lifecycleLockPath), `${basename(paths.lifecycleLockPath)}.${token}.owner-pending`)
}

type CapturedPlainDirectoryState = {
  stat: { dev: number; ino: number; mtimeMs: number; nlink: number }
  entries: string[]
}

type LifecycleOwnerStageReservation = {
  directory: string
  recordFile: string
  record: LifecycleLockRecord
  processIdentity: string
  receipt: LifecycleRootReceiptV1
  directoryState: CapturedPlainDirectoryState
  recordState: CapturedFileState | null
}

type PurgeWalStageArtifact = {
  file: string
  purgeId: string
  lockToken: string
  state: CapturedFileState
}

type LifecycleOwnerStageNamespace = {
  directory: string
  directoryState: CapturedPlainDirectoryState | null
  namespaceId: string | null
  marker: string | null
  markerState: CapturedFileState | null
  reservations: LifecycleOwnerStageReservation[]
  purgeStage: PurgeWalStageArtifact | null
}

function lifecycleOwnerStageNamespacePath(paths: InstallPaths): string {
  return `${resolve(paths.dataRoot)}.lifecycle-owner-stages`
}

function lifecycleOwnerBindingHash(value: string, platform: NodeJS.Platform | string, length: number): string {
  const canonical = platform === 'win32' ? resolve(value).toLowerCase() : resolve(value)
  return createHash('sha256').update(canonical).digest('hex').slice(0, length)
}

function lifecycleOwnerReceiptHash(receipt: LifecycleRootReceiptV1): string {
  return createHash('sha256').update(recordBytes(receipt)).digest('hex').slice(0, 24)
}

function lifecycleOwnerOperationCode(operation: LifecycleLockRecord['operation']): string {
  return ({ setup: 's', upgrade: 'g', uninstall: 'u', recover: 'r', purge: 'p' } as const)[operation]
}

function lifecycleOwnerOperationFromCode(code: string): LifecycleLockRecord['operation'] | null {
  if (code === 's') return 'setup'
  if (code === 'g') return 'upgrade'
  if (code === 'u') return 'uninstall'
  if (code === 'r') return 'recover'
  if (code === 'p') return 'purge'
  return null
}

function lifecycleOwnerStagePath(
  paths: InstallPaths,
  record: LifecycleLockRecord,
  receipt: LifecycleRootReceiptV1,
  namespaceId: string,
  platform: NodeJS.Platform | string,
  processIdentity = LIFECYCLE_ROOT_RECEIPT_PROCESS_IDENTITY
): string {
  if (!UUID.test(namespaceId) || !UUID.test(record.token) || !UUID.test(receipt.dataRootId)
    || !/^[a-f0-9]{64}$/i.test(processIdentity)) {
    throw new Error('lifecycle owner stage reservation identity is invalid')
  }
  const createdAt = Date.parse(record.createdAt)
  if (!Number.isSafeInteger(createdAt) || new Date(createdAt).toISOString() !== record.createdAt) {
    throw new Error('lifecycle owner stage reservation timestamp is not canonical')
  }
  const name = [
    '.sg-owner-v1',
    namespaceId,
    lifecycleOwnerBindingHash(paths.lifecycleLockPath, platform, 12),
    lifecycleOwnerReceiptHash(receipt),
    receipt.dataRootId,
    record.token,
    String(record.pid),
    processIdentity.slice(0, 16),
    String(createdAt),
    lifecycleOwnerOperationCode(record.operation),
    lifecycleOwnerBindingHash(record.installDir, platform, 12)
  ].join('.') + '.owner-stage'
  if (Buffer.byteLength(name, 'utf8') > 240) throw new Error('lifecycle owner stage reservation name exceeds its bound')
  return join(lifecycleOwnerStageNamespacePath(paths), name)
}

function capturePlainDirectoryState(
  directory: string,
  label: string,
  maxEntries = 4
): CapturedPlainDirectoryState {
  const before = fs.lstatSync(directory)
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error(`${label} is not a plain directory`)
  const entries = boundedDirectoryEntries(directory, maxEntries, label).map((entry) => entry.name).sort()
  const after = fs.lstatSync(directory)
  if (!after.isDirectory() || after.isSymbolicLink()
    || after.dev !== before.dev || after.ino !== before.ino
    || after.mtimeMs !== before.mtimeMs || after.nlink !== before.nlink) {
    throw new Error(`${label} changed while captured`)
  }
  return { stat: { dev: after.dev, ino: after.ino, mtimeMs: after.mtimeMs, nlink: after.nlink }, entries }
}

function assertPlainDirectoryState(
  directory: string,
  expected: CapturedPlainDirectoryState,
  label: string,
  maxEntries = 4
): void {
  const current = capturePlainDirectoryState(directory, label, maxEntries)
  if (canonicalJson(current) !== canonicalJson(expected)) {
    throw new Error(`${label} changed before lifecycle mutation`)
  }
}

function readLifecycleOwnerStageReservation(
  paths: InstallPaths,
  host: InstallHost,
  directory: string,
  receipt: LifecycleRootReceiptV1,
  namespaceId: string
): LifecycleOwnerStageReservation {
  const match = LIFECYCLE_OWNER_STAGE.exec(basename(directory))
  if (!match) throw new Error('lifecycle owner stage reservation name is malformed')
  const [, reservedNamespaceId, lockHash, receiptHash, dataRootId, token, pidText, processIdentity, createdAtText, operationCode, installHash] = match
  const pid = Number(pidText)
  const createdAtMs = Number(createdAtText)
  const operation = lifecycleOwnerOperationFromCode(operationCode.toLowerCase())
  if (reservedNamespaceId.toLowerCase() !== namespaceId.toLowerCase()
    || lockHash.toLowerCase() !== lifecycleOwnerBindingHash(paths.lifecycleLockPath, host.platform, 12)
    || receiptHash.toLowerCase() !== lifecycleOwnerReceiptHash(receipt)
    || dataRootId.toLowerCase() !== receipt.dataRootId.toLowerCase()
    || installHash.toLowerCase() !== lifecycleOwnerBindingHash(paths.installDir, host.platform, 12)
    || !UUID.test(token) || !Number.isSafeInteger(pid) || pid < 1
    || !Number.isSafeInteger(createdAtMs) || createdAtMs < 1 || !operation) {
    throw new Error('lifecycle owner stage reservation is not bound to the current preserved root authority')
  }
  if (!samePath(receipt.dataRoot, paths.dataRoot, host.platform)
    || !samePath(receipt.installDir, paths.installDir, host.platform)) {
    throw new Error('lifecycle owner stage reservation receipt is bound to another lifecycle root')
  }
  const createdAt = new Date(createdAtMs).toISOString()
  if (Date.parse(createdAt) !== createdAtMs) throw new Error('lifecycle owner stage timestamp is invalid')
  const record: LifecycleLockRecord = { schemaVersion: 1, token, pid, operation, installDir: paths.installDir, createdAt }
  const directoryState = capturePlainDirectoryState(directory, 'lifecycle owner stage reservation')
  if (directoryState.entries.some((name) => name !== LIFECYCLE_OWNER_STAGE_RECORD)) {
    throw new Error('lifecycle owner stage reservation contains a foreign child')
  }
  const recordFile = join(directory, LIFECYCLE_OWNER_STAGE_RECORD)
  const recordStat = lstatOptional(recordFile)
  if (recordStat && (!recordStat.isFile() || recordStat.isSymbolicLink()
    || recordStat.nlink < 1 || recordStat.nlink > 2 || recordStat.size > LIFECYCLE_LOCK_MAX_BYTES)) {
    throw new Error('lifecycle owner stage record is not a bounded unique plain file')
  }
  const recordState = recordStat
    ? captureFileState(recordFile, LIFECYCLE_LOCK_MAX_BYTES, recordStat.nlink === 2)
    : null
  if (recordState?.bytes?.length === recordBytes(record).length) {
    const parsed = readLifecycleLockFile(recordFile, paths, host.platform, recordStat?.nlink === 2)
    if (!parsed || canonicalJson(parsed) !== canonicalJson(record)) {
      throw new Error('complete lifecycle owner stage record does not match its reservation authority')
    }
  }
  assertPlainDirectoryState(directory, directoryState, 'lifecycle owner stage reservation')
  return { directory, recordFile, record, processIdentity, receipt, directoryState, recordState }
}

function readLifecycleOwnerStageNamespace(paths: InstallPaths, host: InstallHost): LifecycleOwnerStageNamespace {
  const directory = lifecycleOwnerStageNamespacePath(paths)
  const receiptNamespace = readLifecycleRootReceiptNamespace(host)
  const authorityNamespaceId = receiptNamespace.ownerStageNamespaceId
  const stat = lstatOptional(directory)
  if (!stat) {
    return {
      directory,
      directoryState: null,
      namespaceId: authorityNamespaceId,
      marker: null,
      markerState: null,
      reservations: [],
      purgeStage: null
    }
  }
  if (!authorityNamespaceId) {
    throw new Error('lifecycle owner stage namespace exists without durable preserved-root namespace authority')
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('lifecycle owner stage namespace is not a plain directory')
  }
  const entries = boundedDirectoryEntries(directory, 4, 'lifecycle owner stage namespace')
  const markerEntries = entries.filter((entry) => LIFECYCLE_OWNER_STAGE_NAMESPACE_MARKER.test(entry.name))
  const reservationEntries = entries.filter((entry) => LIFECYCLE_OWNER_STAGE.test(entry.name))
  const purgeStageEntries = entries.filter((entry) => PURGE_WAL_STAGE.test(entry.name))
  if (markerEntries.length > 1 || reservationEntries.length > 1
    || purgeStageEntries.length > 1
    || entries.length !== markerEntries.length + reservationEntries.length + purgeStageEntries.length) {
    throw new Error('lifecycle owner stage namespace contains foreign or ambiguous entries')
  }
  if (entries.length > 0 && markerEntries.length !== 1) {
    throw new Error('non-empty lifecycle owner stage namespace has no strict marker')
  }
  let namespaceId: string | null = null
  let marker: string | null = null
  let markerState: CapturedFileState | null = null
  if (markerEntries.length === 1) {
    const markerEntry = markerEntries[0]
    const markerMatch = LIFECYCLE_OWNER_STAGE_NAMESPACE_MARKER.exec(markerEntry.name)!
    if (!markerEntry.isFile() || markerEntry.isSymbolicLink()) {
      throw new Error('lifecycle owner stage namespace marker is not a plain file')
    }
    namespaceId = markerMatch[1]
    if (namespaceId.toLowerCase() !== authorityNamespaceId.toLowerCase()) {
      throw new Error('lifecycle owner stage namespace marker does not match its durable HOME authority')
    }
    marker = join(directory, markerEntry.name)
    const markerStat = fs.lstatSync(marker)
    if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.nlink !== 1 || markerStat.size !== 0) {
      throw new Error('lifecycle owner stage namespace marker is not a unique empty protocol file')
    }
    markerState = captureFileState(marker, 0)
  }
  const reservations: LifecycleOwnerStageReservation[] = []
  if (reservationEntries.length === 1) {
    if (!namespaceId) throw new Error('lifecycle owner stage reservation has no namespace identity')
    const entry = reservationEntries[0]
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error('lifecycle owner stage reservation is not a plain directory')
    }
    const receipt = readLifecycleRootReceiptNamespace(host).receipt
    if (!receipt) throw new Error('lifecycle owner stage reservation has no published preserved-root receipt authority')
    reservations.push(readLifecycleOwnerStageReservation(paths, host, join(directory, entry.name), receipt, namespaceId))
  }
  let purgeStage: PurgeWalStageArtifact | null = null
  if (purgeStageEntries.length === 1) {
    if (!namespaceId) throw new Error('purge WAL staging file has no lifecycle owner-stage namespace identity')
    const entry = purgeStageEntries[0]
    const match = PURGE_WAL_STAGE.exec(entry.name)!
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error('purge WAL staging artifact is not a plain file')
    }
    const file = join(directory, entry.name)
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink < 1 || stat.nlink > 2
      || stat.size > PURGE_WAL_MAX_BYTES) {
      throw new Error('purge WAL staging artifact is not a bounded internal file')
    }
    if (stat.nlink === 2) {
      const final = `${resolve(paths.dataRoot)}.purge-wal-v1.json`
      const finalStat = fs.lstatSync(final)
      if (!finalStat.isFile() || finalStat.isSymbolicLink() || finalStat.nlink !== 2
        || finalStat.dev !== stat.dev || finalStat.ino !== stat.ino
        || finalStat.size !== stat.size || finalStat.mtimeMs !== stat.mtimeMs) {
        throw new Error('purge WAL staging artifact has an unsafe external hard link')
      }
    }
    purgeStage = {
      file,
      purgeId: match[1].toLowerCase(),
      lockToken: match[2].toLowerCase(),
      state: captureFileState(file, PURGE_WAL_MAX_BYTES, stat.nlink === 2)
    }
  }
  const directoryState = capturePlainDirectoryState(directory, 'lifecycle owner stage namespace')
  return {
    directory,
    directoryState,
    namespaceId: namespaceId || authorityNamespaceId,
    marker,
    markerState,
    reservations,
    purgeStage
  }
}

function sameLifecycleOwnerStageNamespace(
  left: LifecycleOwnerStageNamespace,
  right: LifecycleOwnerStageNamespace
): boolean {
  if (left.directory !== right.directory || left.namespaceId !== right.namespaceId
    || left.marker !== right.marker || canonicalJson(left.directoryState) !== canonicalJson(right.directoryState)
    || canonicalJson(left.markerState?.stat || null) !== canonicalJson(right.markerState?.stat || null)
    || !sameOptionalBuffer(left.markerState?.bytes || null, right.markerState?.bytes || null)
    || left.purgeStage?.file !== right.purgeStage?.file
    || left.purgeStage?.purgeId !== right.purgeStage?.purgeId
    || left.purgeStage?.lockToken !== right.purgeStage?.lockToken
    || canonicalJson(left.purgeStage?.state.stat || null) !== canonicalJson(right.purgeStage?.state.stat || null)
    || !sameOptionalBuffer(left.purgeStage?.state.bytes || null, right.purgeStage?.state.bytes || null)
    || left.reservations.length !== right.reservations.length) return false
  return left.reservations.every((reservation, index) => {
    const current = right.reservations[index]
    return Boolean(current && reservation.directory === current.directory
      && canonicalJson(reservation.record) === canonicalJson(current.record)
      && reservation.processIdentity === current.processIdentity
      && canonicalJson(reservation.directoryState) === canonicalJson(current.directoryState)
      && canonicalJson(reservation.recordState?.stat || null) === canonicalJson(current.recordState?.stat || null)
      && sameOptionalBuffer(reservation.recordState?.bytes || null, current.recordState?.bytes || null))
  })
}

function ensureLifecycleOwnerStageAuthority(
  paths: InstallPaths,
  host: InstallHost,
  receipt: LifecycleRootReceiptV1
): string {
  let namespace = readLifecycleRootReceiptNamespace(host)
  const currentReceipt = namespace.receipt
  if (!currentReceipt || !sameLifecycleRootReceipt(currentReceipt, receipt)) {
    throw new Error('lifecycle owner-stage namespace has no exact current root receipt')
  }
  if (namespace.ownerStageNamespaceId && namespace.ownerStageAuthorityMarker
    && namespace.ownerStageAuthorityMarkerState) {
    assertCapturedFileState(
      namespace.ownerStageAuthorityMarker,
      namespace.ownerStageAuthorityMarkerState,
      'lifecycle owner-stage authority marker durability',
      0
    )
    const descriptor = fs.openSync(namespace.ownerStageAuthorityMarker, fs.constants.O_RDWR)
    try {
      const opened = fs.fstatSync(descriptor)
      const expected = namespace.ownerStageAuthorityMarkerState.stat
      if (!expected || !opened.isFile() || opened.isSymbolicLink()
        || opened.dev !== expected.dev || opened.ino !== expected.ino
        || opened.nlink !== 1 || opened.size !== 0) {
        throw new Error('lifecycle owner-stage authority marker descriptor changed before durability proof')
      }
      fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
    flushDirectory(namespace.directory)
    const durable = readLifecycleRootReceiptNamespace(host)
    if (durable.ownerStageNamespaceId !== namespace.ownerStageNamespaceId
      || durable.ownerStageAuthorityMarker !== namespace.ownerStageAuthorityMarker
      || !sameOptionalBuffer(durable.ownerStageAuthorityMarkerState?.bytes || null, namespace.ownerStageAuthorityMarkerState.bytes)
      || canonicalJson(durable.ownerStageAuthorityMarkerState?.stat || null)
        !== canonicalJson(namespace.ownerStageAuthorityMarkerState.stat)) {
      throw new Error('lifecycle owner-stage authority marker changed during durability proof')
    }
    return namespace.ownerStageNamespaceId
  }
  // Until the marker below is durably published in the already-owned HOME
  // receipt namespace, the same-volume sibling is not ours. Even an empty,
  // perfectly named pre-existing directory is foreign and must remain intact.
  if (lstatOptional(lifecycleOwnerStageNamespacePath(paths))) {
    throw new Error('unowned lifecycle owner stage namespace already exists')
  }
  if (!namespace.directoryExists || !namespace.markerState) {
    throw new Error('lifecycle owner-stage authority requires the strict receipt namespace marker')
  }
  const namespaceId = randomUUID()
  const marker = join(namespace.directory, `.owner-stage-namespace-v1.${namespaceId}.marker`)
  const directoryFence = captureDirectoryFence(namespace.directory)
  assertDirectoryFence(namespace.directory, directoryFence)
  if (lstatOptional(marker)) throw new Error('lifecycle owner-stage authority marker appeared before exclusive creation')
  const descriptor = fs.openSync(marker, 'wx')
  try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
  flushDirectory(namespace.directory)
  namespace = readLifecycleRootReceiptNamespace(host)
  if (namespace.ownerStageNamespaceId !== namespaceId || namespace.ownerStageAuthorityMarker !== marker
    || !namespace.ownerStageAuthorityMarkerState?.stat
    || namespace.ownerStageAuthorityMarkerState.stat.size !== 0
    || namespace.ownerStageAuthorityMarkerState.stat.nlink !== 1) {
    throw new Error('lifecycle owner-stage authority marker publication failed')
  }
  return namespaceId
}

function ensureLifecycleOwnerStageNamespace(
  paths: InstallPaths,
  host: InstallHost,
  receipt: LifecycleRootReceiptV1
): LifecycleOwnerStageNamespace {
  const authorityNamespaceId = ensureLifecycleOwnerStageAuthority(paths, host, receipt)
  let namespace = readLifecycleOwnerStageNamespace(paths, host)
  const parent = dirname(namespace.directory)
  const parentFence = captureDirectoryFence(parent)
  if (!namespace.directoryState) {
    assertDirectoryFence(parent, parentFence)
    if (lstatOptional(namespace.directory)) throw new Error('lifecycle owner stage namespace appeared before exclusive creation')
    fs.mkdirSync(namespace.directory)
    flushDirectory(parent)
    assertDirectoryFence(parent, parentFence)
    namespace = readLifecycleOwnerStageNamespace(paths, host)
  }
  if (!namespace.directoryState) throw new Error('lifecycle owner stage namespace creation was not observable')
  if (namespace.marker && namespace.markerState && namespace.namespaceId) {
    if (namespace.namespaceId !== authorityNamespaceId) {
      throw new Error('lifecycle owner stage namespace changed its durable namespace identity')
    }
    assertCapturedFileState(namespace.marker, namespace.markerState, 'lifecycle owner stage namespace marker durability', 0)
    const descriptor = fs.openSync(namespace.marker, fs.constants.O_RDWR)
    try {
      const opened = fs.fstatSync(descriptor)
      const expected = namespace.markerState.stat
      if (!expected || !opened.isFile() || opened.isSymbolicLink()
        || opened.dev !== expected.dev || opened.ino !== expected.ino
        || opened.nlink !== 1 || opened.size !== 0) {
        throw new Error('lifecycle owner stage namespace marker descriptor changed before durability proof')
      }
      fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
    flushDirectory(namespace.directory)
    flushDirectory(parent)
    const durable = readLifecycleOwnerStageNamespace(paths, host)
    if (!sameLifecycleOwnerStageNamespace(namespace, durable)) {
      throw new Error('lifecycle owner stage namespace changed during durability proof')
    }
    return durable
  }
  if (namespace.directoryState.entries.length !== 0) {
    throw new Error('unmarked lifecycle owner stage namespace is not empty')
  }
  flushDirectory(parent)
  assertDirectoryFence(parent, parentFence)
  namespace = readLifecycleOwnerStageNamespace(paths, host)
  if (!namespace.directoryState || namespace.directoryState.entries.length !== 0) {
    throw new Error('empty lifecycle owner stage namespace changed before marker adoption')
  }
  const namespaceId = authorityNamespaceId
  const marker = join(namespace.directory, `.namespace-v1.${namespaceId}.skill-graft.marker`)
  const directoryFence = captureDirectoryFence(namespace.directory)
  assertDirectoryFence(namespace.directory, directoryFence)
  if (lstatOptional(marker)) throw new Error('lifecycle owner stage namespace marker appeared before exclusive creation')
  const descriptor = fs.openSync(marker, 'wx')
  try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
  flushDirectory(namespace.directory)
  flushDirectory(parent)
  const published = readLifecycleOwnerStageNamespace(paths, host)
  if (published.namespaceId !== namespaceId || !published.markerState?.stat
    || published.markerState.stat.size !== 0 || published.markerState.stat.nlink !== 1) {
    throw new Error('lifecycle owner stage namespace marker publication failed')
  }
  return published
}

type LifecycleOwnerPublicationHint = {
  record: LifecycleLockRecord | null
  finalState: CapturedFileState
  artifacts: Array<{ file: string; state: CapturedFileState }>
  stageNamespace: LifecycleOwnerStageNamespace
}

function readLifecycleOwnerPublicationHint(paths: InstallPaths, host: InstallHost): LifecycleOwnerPublicationHint {
  const parent = dirname(paths.lifecycleLockPath)
  const finalStat = lstatOptional(paths.lifecycleLockPath)
  let record: LifecycleLockRecord | null = null
  if (finalStat) {
    if (!finalStat.isFile() || finalStat.isSymbolicLink() || finalStat.nlink < 1 || finalStat.nlink > 2) {
      throw new Error('lifecycle owner publication final is unsafe')
    }
    if (finalStat.nlink === 1) {
      record = readLifecycleLock(paths, host)
    } else {
      const linked = boundedMatchingDirectoryEntries(
        parent,
        (entry) => entry.name.startsWith(`${basename(paths.lifecycleLockPath)}.`)
          && entry.name.endsWith('.owner-pending'),
        2,
        'lifecycle owner publication read-only pair inventory'
      )
      if (linked.length !== 1 || !linked[0].isFile() || linked[0].isSymbolicLink()) {
        throw new Error('lifecycle owner publication final has no unique internal pending link')
      }
      const pending = join(parent, linked[0].name)
      const pendingStat = fs.lstatSync(pending)
      if (!pendingStat.isFile() || pendingStat.isSymbolicLink() || pendingStat.nlink !== 2
        || pendingStat.dev !== finalStat.dev || pendingStat.ino !== finalStat.ino
        || pendingStat.size !== finalStat.size || pendingStat.mtimeMs !== finalStat.mtimeMs) {
        throw new Error('lifecycle owner publication final is not an exact internal hard-link pair')
      }
      const finalRecord = readLifecycleLockFile(paths.lifecycleLockPath, paths, host.platform, true)
      const pendingRecord = readLifecycleLockFile(pending, paths, host.platform, true)
      if (!finalRecord || !pendingRecord
        || !samePath(pending, lifecycleOwnerPendingPath(paths, finalRecord.token), host.platform)
        || canonicalJson(finalRecord) !== canonicalJson(pendingRecord)) {
        throw new Error('lifecycle owner publication final pair has foreign bytes')
      }
      record = finalRecord
    }
  }
  const artifacts: Array<{ file: string; state: CapturedFileState }> = []
  if (lstatOptional(parent)) {
    const prefix = `${basename(paths.lifecycleLockPath)}.`
    const pendingEntries = boundedMatchingDirectoryEntries(
      parent,
      (entry) => entry.name.startsWith(prefix)
        && entry.name.endsWith('.owner-pending'),
      2,
      'lifecycle owner publication read-only inventory'
    )
    if (pendingEntries.length > 1) throw new Error('multiple lifecycle owner publication artifacts require manual recovery')
    for (const entry of pendingEntries) {
      const token = entry.name.slice(prefix.length, -'.owner-pending'.length)
      if (!UUID.test(token) || !entry.isFile() || entry.isSymbolicLink()) {
        throw new Error('lifecycle owner publication artifact has an unverifiable name or kind')
      }
      const file = join(parent, entry.name)
      const stat = fs.lstatSync(file)
      if (stat.nlink < 1 || stat.nlink > 2) throw new Error('lifecycle owner publication artifact has an unsafe link count')
      artifacts.push({ file, state: captureFileState(file, LIFECYCLE_LOCK_MAX_BYTES, stat.nlink === 2) })
    }
  }
  const stageNamespace = readLifecycleOwnerStageNamespace(paths, host)
  return {
    record,
    finalState: captureFileState(paths.lifecycleLockPath, LIFECYCLE_LOCK_MAX_BYTES, finalStat?.nlink === 2),
    artifacts: artifacts.sort((left, right) => left.file.localeCompare(right.file)),
    stageNamespace
  }
}

function assertLifecycleOwnerPublicationHint(
  paths: InstallPaths,
  host: InstallHost,
  expected: LifecycleOwnerPublicationHint,
  label: string
): void {
  const current = readLifecycleOwnerPublicationHint(paths, host)
  assertCapturedFileState(
    paths.lifecycleLockPath,
    expected.finalState,
    `${label} final`,
    LIFECYCLE_LOCK_MAX_BYTES
  )
  if (canonicalJson(current.record) !== canonicalJson(expected.record)
    || current.artifacts.length !== expected.artifacts.length) {
    throw new Error(`${label} inventory changed`)
  }
  for (const [index, artifact] of expected.artifacts.entries()) {
    const observed = current.artifacts[index]
    if (!observed || observed.file !== artifact.file) {
      throw new Error(`${label} inventory changed`)
    }
    assertCapturedFileState(
      artifact.file,
      artifact.state,
      `${label} artifact`,
      LIFECYCLE_LOCK_MAX_BYTES
    )
  }
  if (!sameLifecycleOwnerStageNamespace(expected.stageNamespace, current.stageNamespace)) {
    throw new Error(`${label} stage namespace changed`)
  }
}

function retireLifecycleOwnerStageReservation(
  paths: InstallPaths,
  host: InstallHost,
  expectedNamespace: LifecycleOwnerStageNamespace,
  expected: LifecycleOwnerStageReservation,
  pending: string | null
): void {
  if (host.pidAlive(expected.record.pid)) {
    const command = host.processCommandLine(expected.record.pid)
    const observedIdentity = createHash('sha256').update(command).digest('hex').slice(0, 16)
    const detail = observedIdentity === expected.processIdentity.toLowerCase() ? 'still live' : 'live but unverifiable'
    throw new Error(`lifecycle owner stage publisher is ${detail}`)
  }
  const currentNamespace = readLifecycleOwnerStageNamespace(paths, host)
  if (!sameLifecycleOwnerStageNamespace(expectedNamespace, currentNamespace)) {
    throw new Error('lifecycle owner stage namespace changed before recovery')
  }
  if (lstatOptional(paths.lifecycleLockPath)) {
    throw new Error('lifecycle owner stage cannot be recovered beside a published final owner')
  }
  if (pending) {
    const pendingStat = fs.lstatSync(pending)
    const pendingRecord = readLifecycleLockFile(pending, paths, host.platform, pendingStat.nlink === 2)
    if (!pendingRecord || canonicalJson(pendingRecord) !== canonicalJson(expected.record)) {
      throw new Error('lifecycle owner stage pending record is foreign')
    }
    if (expected.recordState) {
      const recordStat = expected.recordState.stat
      if (!recordStat || recordStat.nlink !== 2 || pendingStat.nlink !== 2
        || pendingStat.dev !== recordStat.dev || pendingStat.ino !== recordStat.ino
        || !sameOptionalBuffer(expected.recordState.bytes, recordBytes(expected.record))) {
        throw new Error('lifecycle owner stage and pending are not an exact internal hard-link pair')
      }
    } else if (pendingStat.nlink !== 1) {
      throw new Error('lifecycle owner stage has an ambiguous pending link')
    }
  } else if (expected.recordState && expected.recordState.stat?.nlink !== 1) {
    throw new Error('unpublished lifecycle owner stage has an unsafe record link count')
  }
  if (expected.recordState) {
    assertCapturedFileState(
      expected.recordFile,
      expected.recordState,
      'lifecycle owner stage record recovery',
      LIFECYCLE_LOCK_MAX_BYTES
    )
    fs.unlinkSync(expected.recordFile)
    flushDirectory(expected.directory)
  }
  const empty = capturePlainDirectoryState(expected.directory, 'empty lifecycle owner stage reservation')
  if (empty.entries.length !== 0
    || empty.stat.dev !== expected.directoryState.stat.dev || empty.stat.ino !== expected.directoryState.stat.ino) {
    throw new Error('lifecycle owner stage reservation changed before directory retirement')
  }
  assertPlainDirectoryState(expected.directory, empty, 'empty lifecycle owner stage reservation')
  fs.rmdirSync(expected.directory)
  flushDirectory(expectedNamespace.directory)
  const after = readLifecycleOwnerStageNamespace(paths, host)
  if (after.reservations.length !== 0 || after.namespaceId !== expectedNamespace.namespaceId) {
    throw new Error('lifecycle owner stage reservation retirement failed its postcondition')
  }
}

function normalizeLifecycleOwnerPublication(paths: InstallPaths, host: InstallHost): void {
  const parent = dirname(paths.lifecycleLockPath)
  if (lstatOptional(parent) === null) return
  assertPlainDirectory(parent, 'lifecycle owner parent')
  const prefix = `${basename(paths.lifecycleLockPath)}.`
  const candidates = boundedMatchingDirectoryEntries(
    parent,
    (entry) => entry.name.startsWith(prefix) && entry.name.endsWith('.owner-pending'),
    2,
    'lifecycle owner publication inventory'
  )
  if (candidates.length > 1) throw new Error('multiple lifecycle owner publications require manual recovery')
  const stageNamespace = readLifecycleOwnerStageNamespace(paths, host)
  const stage = stageNamespace.reservations[0] || null
  const entry = candidates[0] || null
  const token = entry ? entry.name.slice(prefix.length, -'.owner-pending'.length) : null
  if (entry && (!token || !UUID.test(token) || !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error('lifecycle owner publication has an unverifiable name or kind')
  }
  const pending = entry ? join(parent, entry.name) : null
  let pendingStat = pending ? fs.lstatSync(pending) : null
  const finalStat = lstatOptional(paths.lifecycleLockPath)
  if (stage) {
    if (finalStat) throw new Error('lifecycle owner stage remains beside a published final owner')
    if (pending && token !== stage.record.token) {
      throw new Error('lifecycle owner stage and pending use different publication tokens')
    }
    retireLifecycleOwnerStageReservation(paths, host, stageNamespace, stage, pending)
    pendingStat = pending ? fs.lstatSync(pending) : null
  }
  if (!pending || !pendingStat) return
  if (finalStat) {
    if (!finalStat.isFile() || finalStat.isSymbolicLink()
      || finalStat.nlink !== 2 || pendingStat.nlink !== 2
      || finalStat.dev !== pendingStat.dev || finalStat.ino !== pendingStat.ino
      || finalStat.size !== pendingStat.size || finalStat.mtimeMs !== pendingStat.mtimeMs) {
      throw new Error('lifecycle owner publication is not an exact internal hard-link pair')
    }
    const pendingRecord = readLifecycleLockFile(pending, paths, host.platform, true)
    const finalRecord = readLifecycleLockFile(paths.lifecycleLockPath, paths, host.platform, true)
    if (!pendingRecord || !finalRecord || pendingRecord.token !== token
      || canonicalJson(pendingRecord) !== canonicalJson(finalRecord)) {
      throw new Error('lifecycle owner publication pair has foreign bytes')
    }
    const captured = captureFileState(pending, LIFECYCLE_LOCK_MAX_BYTES, true)
    assertCapturedFileState(pending, captured, 'lifecycle owner publication pending link')
    fs.unlinkSync(pending)
    flushDirectory(parent)
    const unique = fs.lstatSync(paths.lifecycleLockPath)
    if (!unique.isFile() || unique.isSymbolicLink() || unique.nlink !== 1
      || unique.dev !== finalStat.dev || unique.ino !== finalStat.ino) {
      throw new Error('lifecycle owner publication did not collapse to a unique record')
    }
    return
  }
  if (pendingStat.nlink === 2) {
    throw new Error('unpublished lifecycle owner has an unbound hard link')
  }
  if (pendingStat.nlink !== 1) throw new Error('unpublished lifecycle owner has an unsafe link count')
  const pendingRecord = readLifecycleLockFile(pending, paths, host.platform)
  if (!pendingRecord || pendingRecord.token !== token) {
    throw new Error('unpublished lifecycle owner is malformed or unbound')
  }
  // The machine-wide OS mutex is already held. Therefore no cooperating
  // publisher can still own this complete unpublished record; a live numeric
  // PID may be an unrelated reused process and is not authority over the mutex.
  const captured = captureFileState(pending, LIFECYCLE_LOCK_MAX_BYTES)
  assertCapturedFileState(pending, captured, 'unpublished lifecycle owner cleanup')
  fs.unlinkSync(pending)
  flushDirectory(parent)
}

function publishLifecycleOwnerNoReplace(paths: InstallPaths, record: LifecycleLockRecord, host: InstallHost): void {
  const parent = dirname(paths.lifecycleLockPath)
  fs.mkdirSync(parent, { recursive: true })
  const receipt = readLifecycleRootReceiptNamespace(host).receipt
  if (!receipt || !samePath(receipt.dataRoot, paths.dataRoot, host.platform)
    || !samePath(receipt.installDir, paths.installDir, host.platform)) {
    throw new Error('lifecycle owner publication has no exact preserved-root receipt authority')
  }
  const stageNamespace = ensureLifecycleOwnerStageNamespace(paths, host, receipt)
  if (!stageNamespace.namespaceId || stageNamespace.reservations.length !== 0) {
    throw new Error('lifecycle owner stage namespace is not empty and authoritative')
  }
  const pending = lifecycleOwnerPendingPath(paths, record.token)
  const stage = lifecycleOwnerStagePath(paths, record, receipt, stageNamespace.namespaceId, host.platform)
  const stageRecord = join(stage, LIFECYCLE_OWNER_STAGE_RECORD)
  const bytes = recordBytes(record)
  if (bytes.length > LIFECYCLE_LOCK_MAX_BYTES) throw new Error('lifecycle owner record exceeds its bound')
  if (lstatOptional(pending) !== null) throw new Error('lifecycle owner publication slot is not empty')
  if (lstatOptional(stage) !== null) throw new Error('lifecycle owner write stage is not empty')
  const targetBefore = captureFileState(paths.lifecycleLockPath, LIFECYCLE_LOCK_MAX_BYTES)
  if (targetBefore.stat !== null) throw new Error('lifecycle owner target is not absent')
  let descriptor = -1
  let stageIdentity: { dev: number; ino: number } | null = null
  let recordIdentity: { dev: number; ino: number } | null = null
  let pendingPublished = false
  let published = false
  try {
    fs.mkdirSync(stage)
    const createdStage = fs.lstatSync(stage)
    if (!createdStage.isDirectory() || createdStage.isSymbolicLink()) {
      throw new Error('lifecycle owner stage reservation creation failed')
    }
    stageIdentity = { dev: createdStage.dev, ino: createdStage.ino }
    flushDirectory(stageNamespace.directory)
    descriptor = fs.openSync(stageRecord, 'wx')
    const opened = fs.fstatSync(descriptor)
    recordIdentity = { dev: opened.dev, ino: opened.ino }
    fs.writeFileSync(descriptor, bytes)
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = -1
    const complete = captureFileState(stageRecord, LIFECYCLE_LOCK_MAX_BYTES)
    if (!sameOptionalBuffer(complete.bytes, bytes) || complete.stat?.nlink !== 1) {
      throw new Error('lifecycle owner write stage failed readback')
    }
    fs.linkSync(stageRecord, pending)
    pendingPublished = true
    const pendingStaged = fs.lstatSync(pending)
    const stageLinked = fs.lstatSync(stageRecord)
    if (pendingStaged.nlink !== 2 || stageLinked.nlink !== 2
      || pendingStaged.dev !== stageLinked.dev || pendingStaged.ino !== stageLinked.ino
      || !readBoundedPlainFile(pending, LIFECYCLE_LOCK_MAX_BYTES, 'lifecycle owner complete pending', true).equals(bytes)) {
      throw new Error('lifecycle owner pending publication failed its internal-pair postcondition')
    }
    const capturedStage = captureFileState(stageRecord, LIFECYCLE_LOCK_MAX_BYTES, true)
    assertCapturedFileState(stageRecord, capturedStage, 'lifecycle owner write stage')
    fs.unlinkSync(stageRecord)
    flushDirectory(stage)
    const emptyStage = capturePlainDirectoryState(stage, 'empty lifecycle owner stage reservation')
    if (emptyStage.entries.length !== 0) throw new Error('lifecycle owner stage reservation retained a foreign child')
    fs.rmdirSync(stage)
    flushDirectory(stageNamespace.directory)
    assertCapturedFileState(paths.lifecycleLockPath, targetBefore, 'lifecycle owner publication target')
    fs.linkSync(pending, paths.lifecycleLockPath)
    published = true
    flushDirectory(parent)
    const pendingLinked = fs.lstatSync(pending)
    const finalLinked = fs.lstatSync(paths.lifecycleLockPath)
    if (pendingLinked.nlink !== 2 || finalLinked.nlink !== 2
      || pendingLinked.dev !== finalLinked.dev || pendingLinked.ino !== finalLinked.ino
      || !readBoundedPlainFile(pending, LIFECYCLE_LOCK_MAX_BYTES, 'lifecycle owner linked pending', true).equals(bytes)
      || !readBoundedPlainFile(paths.lifecycleLockPath, LIFECYCLE_LOCK_MAX_BYTES, 'lifecycle owner linked target', true).equals(bytes)) {
      throw new Error('lifecycle owner no-replace publication failed its linked-pair postcondition')
    }
    const capturedLinked = captureFileState(pending, LIFECYCLE_LOCK_MAX_BYTES, true)
    assertCapturedFileState(pending, capturedLinked, 'lifecycle owner linked pending')
    fs.unlinkSync(pending)
    flushDirectory(parent)
    const final = fs.lstatSync(paths.lifecycleLockPath)
    if (!final.isFile() || final.isSymbolicLink() || final.nlink !== 1
      || !readBoundedPlainFile(paths.lifecycleLockPath, LIFECYCLE_LOCK_MAX_BYTES, 'lifecycle owner target').equals(bytes)) {
      throw new Error('lifecycle owner publication failed its terminal postcondition')
    }
  } catch (error) {
    if (!published && stageIdentity) {
      try {
        const currentPending = lstatOptional(pending)
        const currentRecord = lstatOptional(stageRecord)
        if (pendingPublished && currentPending?.isFile() && !currentPending.isSymbolicLink()
          && recordIdentity && currentPending.dev === recordIdentity.dev && currentPending.ino === recordIdentity.ino) {
          fs.unlinkSync(pending)
        }
        if (currentRecord?.isFile() && !currentRecord.isSymbolicLink()
          && recordIdentity && currentRecord.dev === recordIdentity.dev && currentRecord.ino === recordIdentity.ino) {
          fs.unlinkSync(stageRecord)
        }
        const currentStage = lstatOptional(stage)
        if (currentStage?.isDirectory() && !currentStage.isSymbolicLink()
          && currentStage.dev === stageIdentity.dev && currentStage.ino === stageIdentity.ino
          && boundedDirectoryEntries(stage, 1, 'lifecycle owner stage cleanup').length === 0) {
          fs.rmdirSync(stage)
        }
        flushDirectory(stageNamespace.directory)
        flushDirectory(parent)
      } catch { /* preserve exact crash evidence when cleanup cannot be proven */ }
    }
    throw error
  } finally {
    if (descriptor >= 0) fs.closeSync(descriptor)
  }
}

function cleanupLifecycleWalPending(
  paths: InstallPaths,
  host: InstallHost,
  priorLock: LifecycleLockRecord | null
): void {
  const parent = dirname(paths.lifecycleWalPath)
  if (lstatOptional(parent) === null) return
  assertPlainDirectory(parent, 'lifecycle WAL parent')
  const prefix = `${basename(paths.lifecycleWalPath)}.`
  const candidates = boundedMatchingDirectoryEntries(
    parent,
    (entry) => entry.name.startsWith(prefix) && entry.name.endsWith('.pending'),
    17,
    'lifecycle WAL pending inventory'
  ).map((entry) => entry.name)
  if (candidates.length > 16) throw new Error('too many lifecycle WAL pending artifacts')
  const verified: Array<{ file: string; stat: fs.Stats }> = []
  const published = readLifecycleWal(paths, host)
  for (const name of candidates) {
    const parts = name.slice(prefix.length, -'.pending'.length).split('.')
    if (parts.length !== 2 || !UUID.test(parts[0]) || !UUID.test(parts[1])) {
      throw new Error('lifecycle WAL pending artifact has an unverifiable name')
    }
    const file = join(parent, name)
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIFECYCLE_WAL_MAX_BYTES
      || !priorLock || parts[1] !== priorLock.token) {
      throw new Error('lifecycle WAL pending artifact has no stale lifecycle-owner authority')
    }
    if (published) {
      const wal = readLifecycleWalFile(file, paths, host)
      if (!wal || wal.walId !== parts[0] || wal.lockToken !== parts[1]) {
        throw new Error('published lifecycle WAL pending artifact is malformed')
      }
      const publishedStat = fs.lstatSync(paths.lifecycleWalPath)
      if (published.walId !== wal.walId || published.lockToken !== wal.lockToken
        || publishedStat.dev !== stat.dev || publishedStat.ino !== stat.ino
        || publishedStat.nlink !== 2 || stat.nlink !== 2) {
        throw new Error('lifecycle WAL pending artifact is not the published WAL hard link')
      }
    } else if (stat.nlink !== 1) {
      throw new Error('unpublished lifecycle WAL pending artifact has an unsafe link count')
    }
    verified.push({ file, stat })
  }
  if (verified.length > 1) throw new Error('multiple lifecycle WAL pending artifacts require manual recovery')
  for (const candidate of verified) {
    const current = fs.lstatSync(candidate.file)
    if (current.dev !== candidate.stat.dev || current.ino !== candidate.stat.ino
      || current.size !== candidate.stat.size || current.mtimeMs !== candidate.stat.mtimeMs
      || current.nlink !== candidate.stat.nlink) {
      throw new Error('lifecycle WAL pending artifact changed before cleanup')
    }
    fs.unlinkSync(candidate.file)
  }
  if (published) {
    const final = fs.lstatSync(paths.lifecycleWalPath)
    if (final.nlink !== 1) throw new Error('published lifecycle WAL retained an unexpected hard link')
  }
}

function lifecycleRecoveryAuthorityPresent(paths: InstallPaths, host: InstallHost, token: string): boolean {
  if (lstatOptional(paths.lifecycleWalPath) !== null) {
    const wal = readLifecycleWal(paths, host)
    return wal?.lockToken === token
  }
  const parent = dirname(paths.lifecycleWalPath)
  const receipt = readLifecycleRootReceiptNamespace(host).receipt
  if (receipt && samePath(receipt.dataRoot, paths.dataRoot, host.platform)
    && samePath(receipt.installDir, paths.installDir, host.platform)) {
    if (receipt.state === 'purging' && receipt.lockToken === token) return true
    const purge = readPurgeAuthoritySnapshot(paths, receipt, host)
    const purgeToken = purge.final?.lockToken || purge.stage?.lockToken
      || purge.stageNamespace.purgeStage?.lockToken || null
    if (purgeToken === token) return true
  }
  if (lstatOptional(parent) === null) return false
  assertPlainDirectory(parent, 'lifecycle recovery authority parent')
  const suffix = `.${token}.pending`
  return boundedMatchingDirectoryEntries(
    parent,
    (entry) => entry.name.startsWith(`${basename(paths.lifecycleWalPath)}.`)
      && entry.name.endsWith(suffix),
    2,
    'lifecycle recovery authority inventory'
  ).some((entry) => entry.isFile() && !entry.isSymbolicLink())
}

function retireStaleLifecycleOwnerWithoutWal(paths: InstallPaths, host: InstallHost): void {
  normalizeLifecycleOwnerPublication(paths, host)
  if (lstatOptional(paths.lifecycleWalPath) !== null) {
    throw new Error('lifecycle WAL still requires recovery')
  }
  const parent = dirname(paths.lifecycleWalPath)
  if (lstatOptional(parent) !== null) {
    assertPlainDirectory(parent, 'lifecycle authority parent')
    const prefix = `${basename(paths.lifecycleWalPath)}.`
    const pending = boundedMatchingDirectoryEntries(
      parent,
      (entry) => entry.name.startsWith(prefix) && entry.name.endsWith('.pending'),
      2,
      'lifecycle pending authority inventory'
    )
    if (pending.length > 0) throw new Error('lifecycle pending authority still requires recovery')
  }
  const owner = readLifecycleLock(paths, host)
  if (!owner) return
  const captured = captureFileState(paths.lifecycleLockPath, LIFECYCLE_LOCK_MAX_BYTES)
  if (!sameOptionalBuffer(captured.bytes, recordBytes(owner))) {
    throw new Error('stale lifecycle owner bytes changed before retirement')
  }
  assertCapturedFileState(paths.lifecycleLockPath, captured, 'stale lifecycle owner retirement')
  fs.unlinkSync(paths.lifecycleLockPath)
  flushDirectory(dirname(paths.lifecycleLockPath))
}

type ApplicationLifecycleGate = {
  owner: ApplicationOwnerBinding
  seal: () => void
  revalidate: () => Promise<void>
  release: () => Promise<void>
}

type PublishedApplicationLeaseNamespaceProof = {
  rootState: CapturedPlainDirectoryState
  markerState: CapturedFileState
  leases: { dev: number; ino: number }
}

function assertPublishedApplicationLeaseNamespace(
  root: string,
  expected: PublishedApplicationLeaseNamespaceProof
): void {
  assertApplicationLeaseNamespaceSafe(root)
  assertPlainDirectoryState(root, expected.rootState, 'published application lease namespace')
  const names = expected.rootState.entries
  if (names.length !== 2
    || !names.includes(APPLICATION_LEASE_NAMESPACE_MARKER)
    || !names.includes('leases')) {
    throw new Error('receipt-free purge requires an already-published application lease namespace')
  }
  const marker = join(root, APPLICATION_LEASE_NAMESPACE_MARKER)
  if (!expected.markerState.stat || expected.markerState.stat.nlink !== 1) {
    throw new Error('receipt-free purge requires a unique published application lease namespace marker')
  }
  assertCapturedFileState(marker, expected.markerState, 'published application lease namespace marker', 64 * 1024)
  const leases = join(root, 'leases')
  const leasesStat = fs.lstatSync(leases)
  if (!leasesStat.isDirectory() || leasesStat.isSymbolicLink()
    || leasesStat.dev !== expected.leases.dev || leasesStat.ino !== expected.leases.ino) {
    throw new Error('published application lease container changed during receipt-free recovery')
  }
  assertPlainDirectoryState(root, expected.rootState, 'published application lease namespace')
}

function capturePublishedApplicationLeaseNamespace(root: string): PublishedApplicationLeaseNamespaceProof {
  assertApplicationLeaseNamespaceSafe(root)
  const rootState = capturePlainDirectoryState(root, 'published application lease namespace')
  if (rootState.entries.length !== 2
    || !rootState.entries.includes(APPLICATION_LEASE_NAMESPACE_MARKER)
    || !rootState.entries.includes('leases')) {
    throw new Error('receipt-free purge requires an already-published application lease namespace')
  }
  const markerState = captureFileState(join(root, APPLICATION_LEASE_NAMESPACE_MARKER), 64 * 1024)
  if (!markerState.stat || markerState.stat.nlink !== 1) {
    throw new Error('receipt-free purge requires a unique published application lease namespace marker')
  }
  const leasesStat = fs.lstatSync(join(root, 'leases'))
  if (!leasesStat.isDirectory() || leasesStat.isSymbolicLink()) {
    throw new Error('receipt-free purge requires an existing plain application lease container')
  }
  const proof: PublishedApplicationLeaseNamespaceProof = {
    rootState,
    markerState,
    leases: { dev: leasesStat.dev, ino: leasesStat.ino }
  }
  assertPublishedApplicationLeaseNamespace(root, proof)
  return proof
}

async function acquireApplicationLifecycleGate(
  paths: Pick<InstallPaths, 'dataRoot'>,
  host: InstallHost,
  options: { requireExistingRoot?: { root: string; fence: DirectoryFence; seal: () => void } } = {}
): Promise<ApplicationLifecycleGate> {
  assertLegacyApplicationLeaseNamespaceClear(paths.dataRoot)
  const root = applicationLeaseRoot(paths.dataRoot)
  if (options.requireExistingRoot && !samePath(root, options.requireExistingRoot.root, host.platform)) {
    throw new Error('required application writer gate root differs from the canonical data-root identity')
  }
  if (options.requireExistingRoot) {
    options.requireExistingRoot.seal()
    assertDirectoryFence(root, options.requireExistingRoot.fence)
    if (lstatOptional(paths.dataRoot)) throw new Error('receipt-free purge data root reappeared before gate recovery')
  }
  assertApplicationLeaseNamespaceSafe(root)
  const manager = createLeaseLockManager({
    root,
    preflightRoot() {
      const rebound = applicationLeaseRoot(paths.dataRoot)
      if (!samePath(rebound, root, host.platform)) {
        throw new Error('application writer gate root changed after lifecycle binding')
      }
      if (options.requireExistingRoot) {
        options.requireExistingRoot.seal()
        assertDirectoryFence(root, options.requireExistingRoot.fence)
        if (lstatOptional(paths.dataRoot)) throw new Error('receipt-free purge data root reappeared during gate recovery')
        assertApplicationLeaseNamespaceSafe(root)
      }
    },
    leaseMs: 30_000
  })
  const requestId = `lifecycle-${randomUUID()}`
  const acquired = await manager.acquire({
    scope: 'hub-global',
    key: 'hub-global',
    hostId: 'lifecycle',
    commandKind: 'migrateState',
    requestId
  })
  if (acquired.status !== 'acquired') throw new Error(`application writer gate is busy (${acquired.reason})`)
  const lease: DurableLease = acquired.lease
  let timer: NodeJS.Timeout | null = null
  let closed = false
  let renewalTail: Promise<void> = Promise.resolve()
  let renewalFailure: unknown = null
  try {
    const ownerFile = join(root, 'leases', 'hub-global.lock', 'owner.json')
    const readOwnedRecord = (): LockRecordV1 => {
      const validated = validateLockRecordV1(readJsonRecord(ownerFile))
      if (!validated.valid
        || validated.value.scope !== 'hub-global'
        || validated.value.lockKey !== 'hub-global'
        || validated.value.ownerToken !== lease.ownerToken
        || validated.value.hostId !== 'lifecycle'
        || validated.value.pid !== process.pid
        || validated.value.command !== 'migrateState'
        || validated.value.requestId !== requestId
        || Date.parse(validated.value.leaseUntil) <= Date.now()) {
        throw new Error('application writer gate owner binding is invalid')
      }
      return validated.value
    }
    const owner = applicationOwnerBinding(readOwnedRecord())
    let recoveringWorktrees = true
    const sealNamespace = (allowRecoverableStale: boolean) => {
      const reboundRoot = applicationLeaseRoot(paths.dataRoot)
      if (!samePath(reboundRoot, root, host.platform)) {
        throw new Error('application writer gate canonical namespace changed')
      }
      assertApplicationLeaseNamespaceSafe(root)
      const currentOwner = readOwnedRecord()
      if (!sameApplicationOwnerBinding(currentOwner, owner)) {
        throw new Error('application writer gate owner binding changed')
      }
      assertLegacyApplicationLeaseNamespaceClear(paths.dataRoot)
      if (!allowRecoverableStale) {
        const durablePending = durablePendingCount(paths.dataRoot)
        if (durablePending > 0) {
          throw new Error(`${durablePending} durable transaction artifact(s) appeared during lifecycle mutation`)
        }
      }
      if (!allowRecoverableStale) {
        const facts = reviewLockFacts(paths.dataRoot, host, owner)
        if (facts.active > 0 || facts.unverifiable > 0 || facts.stale > 0) {
          throw new Error('application writer gate namespace changed or contains another live authority')
        }
      }
    }
    const enqueueRenewal = (allowRecoverableStale = false): Promise<void> => {
      if (closed) return Promise.reject(new Error('application writer gate is already closing'))
      const operation = renewalTail.then(async () => {
        if (closed) throw new Error('application writer gate is already closing')
        if (renewalFailure) throw renewalFailure
        sealNamespace(allowRecoverableStale)
        await lease.renew()
        const current = readOwnedRecord()
        if (!sameApplicationOwnerBinding(current, owner)) throw new Error('application writer gate owner binding changed')
        sealNamespace(allowRecoverableStale)
      })
      renewalTail = operation.catch((error) => {
        if (!renewalFailure) renewalFailure = error
      })
      return operation
    }
    timer = setInterval(() => { void enqueueRenewal(recoveringWorktrees).catch(() => {}) }, 10_000)
    timer.unref()
    await enqueueRenewal(true)
    assertLegacyApplicationLeaseNamespaceClear(paths.dataRoot)
    const durablePending = durablePendingCount(paths.dataRoot)
    if (durablePending > 0) throw new Error(`${durablePending} durable transaction artifact(s) must be recovered before lifecycle mutation`)
    await manager.reapOrphanedWorktreeLeases(lease.ownerToken, () => enqueueRenewal(true))
    recoveringWorktrees = false
    await enqueueRenewal()
    return {
      owner,
      seal: () => sealNamespace(false),
      revalidate: enqueueRenewal,
      async release() {
        if (closed) return
        closed = true
        if (timer) clearInterval(timer)
        timer = null
        await renewalTail
        let failure = renewalFailure
        try {
          await lease.release()
        } catch (error) {
          if (!failure) failure = error
        }
        if (failure) throw failure
      }
    }
  } catch (error) {
    closed = true
    if (timer) clearInterval(timer)
    timer = null
    try { await renewalTail } catch { /* the primary acquisition failure wins */ }
    try { await lease.release() } catch { /* preserve the primary binding failure */ }
    throw error
  }
}

async function acquireLifecycleLock(
  paths: InstallPaths,
  host: InstallHost,
  operation: string,
  withApplicationGate: boolean | 'from-locked-wal' = true,
  receiptPlan?: LifecycleRootReceiptPlan
): Promise<LifecycleLease> {
  let token = ''
  let record: LifecycleLockRecord | null = null
  if (!['setup', 'upgrade', 'uninstall', 'recover', 'purge'].includes(operation)) throw new Error('unsupported lifecycle lock operation')
  const mutexName = lifecycleMutexName(paths, host)
  const mutex = createServer((socket) => socket.destroy())
  try {
    await listenLifecycleMutex(mutex, mutexName)
  } catch (error) {
    await closeLifecycleMutex(mutex)
    throw new Error(`lifecycle lock is already held (${(error as NodeJS.ErrnoException).code || 'mutex unavailable'})`)
  }
  let applicationGate: ApplicationLifecycleGate | null = null
  let adoptedWal: LifecycleWalV1 | null = null
  let adoptedWalState: CapturedFileState | null = null
  let preserveOwnerRecord = false
  let adoptedRecoveryAuthority = false
  let namespaceFence: DirectoryFence | null = null
  let exactOwnerState: CapturedFileState | null = null
  let exactOwnerPublication: LifecycleOwnerPublicationHint | null = null
  let recoveryTerminalMarkerState: CapturedFileState | null = null
  let recoveryTerminalDataRootFence: DirectoryFence | null = null
  let postPublicationAuthoritySeal: () => void = () => {}
  const preflightLockedRoots = () => {
    if (operation === 'purge') {
      if (!receiptPlan) throw new Error('purge lifecycle lock requires a preserved root receipt plan')
      if (receiptPlan.target.state !== 'active') {
        if (receiptPlan.target.state === 'purging' || receiptPlan.terminalPreflight) {
          preflightTerminalPreservedRootPaths(paths, receiptPlan.target, host)
        } else {
          preflightPreservedRootPaths(paths, receiptPlan.target, host)
        }
        const namespace = readLifecycleRootReceiptNamespace(host)
        if (!receiptPlan.allowedCurrent.some((candidate) => sameLifecycleRootReceipt(namespace.receipt, candidate))) {
          throw new Error('purge preserved root receipt changed during locked narrow preflight')
        }
        for (const transition of [namespace.pendingReceipt, namespace.writingReceipt].filter(Boolean) as LifecycleRootReceiptV1[]) {
          if (!sameLifecycleRootReceipt(transition, receiptPlan.target)) {
            throw new Error('purge preserved root receipt has an unexpected locked transition')
          }
        }
        return
      }
      preflightLifecycleRoots(paths, host)
    } else {
      preflightLifecycleRoots(paths, host)
    }
  }
  const preflightLockedWalRoots = (wal: LifecycleWalV1) => {
    if (wal.operation === 'uninstall' && wal.phase === 'committed') {
      // A committed uninstall is a package-independent terminal receipt. Its
      // active historical locator may be the only published receipt until the
      // exact WAL recovery switches it to inactive, so validate the preserved
      // roots and the WAL-bounded receipt namespace without touching package
      // or install bytes that may legitimately be absent or foreign now.
      preflightTerminalPreservedRootPaths(paths, wal.newReceipt, host)
      const namespace = readLifecycleRootReceiptNamespace(host)
      const allowed = [wal.oldReceipt, wal.newReceipt].filter(Boolean) as LifecycleRootReceiptV1[]
      const observed = [namespace.receipt, namespace.pendingReceipt, namespace.writingReceipt]
        .filter(Boolean) as LifecycleRootReceiptV1[]
      if (observed.length === 0
        || observed.some((receipt) => !allowed.some((candidate) => sameLifecycleRootReceipt(receipt, candidate)))) {
        throw new Error('committed uninstall WAL has no matching preserved root receipt authority')
      }
      return
    }
    preflightLifecycleRoots(paths, host)
  }
  const assertLifecycleNamespaceMutationBoundary = () => {
    preflightLifecycleNamespaceMutationPaths(paths, host)
    if (!namespaceFence) throw new Error('lifecycle namespace has no post-mutex ancestor fence')
    assertDirectoryFence(dirname(paths.lifecycleLockPath), namespaceFence)
    assertDirectoryFence(dirname(paths.lifecycleWalPath), namespaceFence)
  }
  try {
    // `listenLifecycleMutex` is an asynchronous boundary. Revalidate the
    // lexical roots before even reading protocol state, then freeze every
    // existing namespace ancestor used by pre-WAL owner/WAL mutations.
    preflightLifecycleNamespaceMutationPaths(paths, host)
    namespaceFence = captureDirectoryFence(dirname(paths.lifecycleLockPath))
    captureDirectoryFence(dirname(paths.lifecycleWalPath), namespaceFence)
    if (withApplicationGate !== 'from-locked-wal') {
      preflightLockedRoots()
    } else {
      const lockedWalHint = readLifecycleWal(paths, host)
      if (lockedWalHint) preflightLockedWalRoots(lockedWalHint)
    }
    // Receipt selection is checked under the machine mutex before lifecycle
    // owner/WAL normalization can write anywhere. A different preserved root
    // is a per-user authority conflict, not an alternate installation slot.
    const receiptNamespace = readLifecycleRootReceiptNamespace(host)
    if (receiptNamespace.writingState && !receiptNamespace.writingReceipt
      && receiptNamespace.writingOwner && Date.now() <= receiptNamespace.writingOwner.leaseUntil) {
      throw new Error(operation === 'purge'
        ? 'recent incomplete purging receipt writer is not recoverable yet'
        : 'recent incomplete lifecycle root receipt writer is not recoverable yet')
    }
    for (const receipt of [receiptNamespace.receipt, receiptNamespace.pendingReceipt].filter(Boolean) as LifecycleRootReceiptV1[]) {
      if (!samePath(receipt.dataRoot, paths.dataRoot, host.platform)
        || !samePath(receipt.installDir, paths.installDir, host.platform)) {
        throw new Error('lifecycle root receipt identifies another preserved root')
      }
    }
    const absentFileState: CapturedFileState = { bytes: null, stat: null }
    const receiptFenceTarget = receiptNamespace.directoryExists
      ? receiptNamespace.directory
      : dirname(receiptNamespace.directory)
    const receiptFence = captureDirectoryFence(receiptFenceTarget)
    const assertLockedReceiptNamespace = () => {
      const current = readLifecycleRootReceiptNamespace(host)
      if (current.directoryExists !== receiptNamespace.directoryExists
        || current.homeIdentity !== receiptNamespace.homeIdentity
        || current.file !== receiptNamespace.file
        || current.pending !== receiptNamespace.pending
        || current.writing !== receiptNamespace.writing
        || current.ownerStageNamespaceId !== receiptNamespace.ownerStageNamespaceId
        || current.ownerStageAuthorityMarker !== receiptNamespace.ownerStageAuthorityMarker
        || current.daemonStageNamespaceId !== receiptNamespace.daemonStageNamespaceId
        || current.daemonStageAuthorityMarker !== receiptNamespace.daemonStageAuthorityMarker
        || canonicalJson(current.receipt) !== canonicalJson(receiptNamespace.receipt)
        || canonicalJson(current.pendingReceipt) !== canonicalJson(receiptNamespace.pendingReceipt)
        || canonicalJson(current.writingReceipt) !== canonicalJson(receiptNamespace.writingReceipt)) {
        throw new Error('lifecycle root receipt namespace changed while acquiring the application writer gate')
      }
      assertDirectoryFence(receiptFenceTarget, receiptFence)
      assertCapturedFileState(
        join(receiptNamespace.directory, LIFECYCLE_ROOT_RECEIPT_NAMESPACE_MARKER),
        receiptNamespace.markerState || absentFileState,
        'lifecycle root receipt namespace marker',
        0
      )
      if (receiptNamespace.ownerStageAuthorityMarker && receiptNamespace.ownerStageAuthorityMarkerState) {
        assertCapturedFileState(
          receiptNamespace.ownerStageAuthorityMarker,
          receiptNamespace.ownerStageAuthorityMarkerState,
          'lifecycle owner-stage authority marker before application gate',
          0
        )
      }
      if (receiptNamespace.daemonStageAuthorityMarker && receiptNamespace.daemonStageAuthorityMarkerState) {
        assertCapturedFileState(
          receiptNamespace.daemonStageAuthorityMarker,
          receiptNamespace.daemonStageAuthorityMarkerState,
          'lifecycle daemon-stage authority marker before application gate',
          0
        )
      }
      assertCapturedFileState(
        receiptNamespace.file,
        receiptNamespace.receiptState || absentFileState,
        'lifecycle root receipt before application gate',
        LIFECYCLE_ROOT_RECEIPT_MAX_BYTES
      )
      assertCapturedFileState(
        receiptNamespace.pending,
        receiptNamespace.pendingState || absentFileState,
        'lifecycle root receipt pending before application gate',
        LIFECYCLE_ROOT_RECEIPT_MAX_BYTES
      )
      if (receiptNamespace.writing && receiptNamespace.writingState) {
        assertCapturedFileState(
          receiptNamespace.writing,
          receiptNamespace.writingState,
          'lifecycle root receipt writer before application gate',
          LIFECYCLE_ROOT_RECEIPT_MAX_BYTES
        )
      }
    }
    // Classify the exact locked WAL without normalizing or deleting any
    // lifecycle protocol bytes. Except for a strict committed-uninstall
    // terminal receipt, the external Application gate must be acquired before
    // receipt CAS, stale-owner retirement, pending cleanup, or owner publish.
    const lockedWalHint = readLifecycleWal(paths, host)
    const lockedOwnerPublication = readLifecycleOwnerPublicationHint(paths, host)
    const lockedOwnerHint = lockedOwnerPublication.record
    const lockedReceipt = receiptNamespace.receipt
    const lockedPurgeAuthority = lockedReceipt
      ? readPurgeAuthoritySnapshot(paths, lockedReceipt, host)
      : null
    const lockedPurgeToken = lockedPurgeAuthority?.final?.lockToken
      || lockedPurgeAuthority?.stage?.lockToken
      || lockedPurgeAuthority?.stageNamespace.purgeStage?.lockToken
      || (lockedReceipt?.state === 'purging' ? lockedReceipt.lockToken : null)
    const purgingReceiptOnly = lockedReceipt?.state === 'purging'
      && !lockedPurgeAuthority?.final && !lockedPurgeAuthority?.stage
      && !lockedPurgeAuthority?.stagePartial
    if (operation === 'purge' && lockedReceipt) {
      assertPurgeOwnerPublicationBinding(
        paths,
        host,
        lockedReceipt,
        lockedPurgeToken,
        lockedOwnerPublication
      )
    }
    if (lockedPurgeToken) {
      if (operation !== 'purge') throw new Error('purge WAL requires recovery before another lifecycle operation')
      if (lockedWalHint) throw new Error('purge WAL conflicts with an ordinary lifecycle WAL')
      if ((!lockedOwnerHint && !purgingReceiptOnly)
        || lockedOwnerHint && lockedOwnerHint.token !== lockedPurgeToken) {
        throw new Error('purge WAL has no matching prior lifecycle owner authority')
      }
    }
    if (lockedWalHint && (!lockedOwnerHint || lockedWalHint.lockToken !== lockedOwnerHint.token)) {
      throw new Error('lifecycle WAL has no matching prior owner authority')
    }
    if (lockedWalHint) preflightLockedWalRoots(lockedWalHint)
    const lockedWalHintStat = lstatOptional(paths.lifecycleWalPath)
    const lockedWalHintState = captureFileState(
      paths.lifecycleWalPath,
      LIFECYCLE_WAL_MAX_BYTES,
      lockedWalHintStat?.nlink === 2
    )
    const assertLockedProtocolHints = () => {
      assertLifecycleNamespaceMutationBoundary()
      assertLockedReceiptNamespace()
      assertCapturedFileState(
        paths.lifecycleWalPath,
        lockedWalHintState,
        'locked lifecycle WAL before application gate',
        LIFECYCLE_WAL_MAX_BYTES
      )
      assertCapturedFileState(
        paths.lifecycleLockPath,
        lockedOwnerPublication.finalState,
        'locked lifecycle owner before application gate',
        LIFECYCLE_LOCK_MAX_BYTES
      )
      const currentOwnerPublication = readLifecycleOwnerPublicationHint(paths, host)
      if (currentOwnerPublication.artifacts.length !== lockedOwnerPublication.artifacts.length) {
        throw new Error('lifecycle owner publication inventory changed while acquiring the application writer gate')
      }
      for (const [index, artifact] of lockedOwnerPublication.artifacts.entries()) {
        const currentArtifact = currentOwnerPublication.artifacts[index]
        if (!currentArtifact || currentArtifact.file !== artifact.file) {
          throw new Error('lifecycle owner publication inventory changed while acquiring the application writer gate')
        }
        assertCapturedFileState(
          artifact.file,
          artifact.state,
          'lifecycle owner publication artifact before application gate',
          LIFECYCLE_LOCK_MAX_BYTES
        )
      }
      if (!sameLifecycleOwnerStageNamespace(
        lockedOwnerPublication.stageNamespace,
        currentOwnerPublication.stageNamespace
      )) {
        throw new Error('lifecycle owner stage namespace changed while acquiring the application writer gate')
      }
      if (lockedPurgeAuthority && lockedReceipt) {
        assertPurgeAuthoritySnapshot(
          paths,
          lockedReceipt,
          host,
          lockedPurgeAuthority,
          'locked purge WAL before application gate'
        )
      }
      if (canonicalJson(readLifecycleWal(paths, host)) !== canonicalJson(lockedWalHint)
        || canonicalJson(currentOwnerPublication.record) !== canonicalJson(lockedOwnerHint)) {
        throw new Error('locked lifecycle protocol authority changed while acquiring the application writer gate')
      }
    }
    const acquireApplicationGate = withApplicationGate === 'from-locked-wal'
      ? !(lockedWalHint?.operation === 'uninstall' && lockedWalHint.phase === 'committed')
      : withApplicationGate
    if (acquireApplicationGate) {
      if (withApplicationGate === 'from-locked-wal' && lockedWalHint) preflightLockedWalRoots(lockedWalHint)
      else preflightLockedRoots()
      if (receiptPlan) receiptPlan.sealBeforePublication()
      applicationGate = await acquireApplicationLifecycleGate(paths, host)
      const sealAfterApplicationGateAwait = () => {
        if (withApplicationGate === 'from-locked-wal' && lockedWalHint) preflightLockedWalRoots(lockedWalHint)
        else preflightLockedRoots()
        assertLockedProtocolHints()
        if (receiptPlan) receiptPlan.sealBeforePublication()
      }
      sealAfterApplicationGateAwait()
      await applicationGate.revalidate()
      if (receiptPlan?.afterApplicationGateRevalidate) {
        await receiptPlan.afterApplicationGateRevalidate()
      }
      sealAfterApplicationGateAwait()
      assertApplicationQuiescent(paths.dataRoot, host, applicationGate.owner)
      sealAfterApplicationGateAwait()
    }
    if (receiptPlan) {
      if (receiptPlan.revalidateExternalAuthority) {
        if (!applicationGate) throw new Error('external lifecycle authority requires the Application gate')
        await receiptPlan.revalidateExternalAuthority(() => applicationGate!.revalidate())
      }
      receiptPlan.sealBeforePublication()
      ensureLifecycleRootReceipt(host, receiptPlan.target, receiptPlan.allowedCurrent)
      receiptPlan.sealAfterPublication()
      assertLifecycleRootReceiptCurrentExact(host, receiptPlan.target)
    }
    // The successfully-bound OS mutex is the writer authority. A prior strict
    // record is diagnostics only: its PID can be reused after an owner crash.
    // Malformed/foreign records remain fail-closed and are never overwritten.
    assertLifecycleNamespaceMutationBoundary()
    normalizeLifecycleOwnerPublication(paths, host)
    const priorLock = readLifecycleLock(paths, host)
    assertLifecycleNamespaceMutationBoundary()
    cleanupLifecycleWalPending(paths, host, priorLock)
    const priorWal = readLifecycleWal(paths, host)
    if (priorWal && (!priorLock || priorWal.lockToken !== priorLock.token)) {
      throw new Error('lifecycle WAL has no matching prior owner authority')
    }
    if (priorWal) preflightLockedWalRoots(priorWal)
    const currentPurgeAuthority = lockedPurgeToken && lockedReceipt
      ? readPurgeAuthoritySnapshot(paths, lockedReceipt, host)
      : null
    const currentPurgeToken = currentPurgeAuthority?.final?.lockToken
      || currentPurgeAuthority?.stage?.lockToken
      || currentPurgeAuthority?.stageNamespace.purgeStage?.lockToken
      || (lockedReceipt?.state === 'purging' ? lockedReceipt.lockToken : null)
    if (currentPurgeToken !== lockedPurgeToken) {
      throw new Error('purge WAL owner binding changed after lifecycle normalization')
    }
    token = priorWal?.lockToken || currentPurgeToken || randomUUID()
    adoptedWal = priorWal
    adoptedWalState = priorWal
      ? captureFileState(paths.lifecycleWalPath, LIFECYCLE_WAL_MAX_BYTES)
      : null
    if (priorWal || currentPurgeToken && priorLock) {
      // The durable WAL and stale strict owner are one restart authority. Keep
      // their token and owner bytes unchanged while the new process holds the
      // machine mutex; replacing either record would create a cross-generation
      // crash window. Successful recovery removes the exact stale owner.
      if (!priorLock || priorLock.token !== token) {
        throw new Error('lifecycle recovery authority lost its exact prior owner')
      }
      record = priorLock
      adoptedRecoveryAuthority = true
    } else {
      if (priorLock) {
        const stale = captureFileState(paths.lifecycleLockPath, LIFECYCLE_LOCK_MAX_BYTES)
        if (!sameOptionalBuffer(stale.bytes, recordBytes(priorLock))) {
          throw new Error('stale lifecycle owner changed before retirement')
        }
        assertLifecycleNamespaceMutationBoundary()
        assertCapturedFileState(paths.lifecycleLockPath, stale, 'stale lifecycle owner retirement')
        fs.unlinkSync(paths.lifecycleLockPath)
        flushDirectory(dirname(paths.lifecycleLockPath))
      }
      record = {
        schemaVersion: 1,
        token,
        pid: process.pid,
        operation: operation as LifecycleLockRecord['operation'],
        installDir: paths.installDir,
        createdAt: new Date().toISOString()
      }
      assertLifecycleNamespaceMutationBoundary()
      publishLifecycleOwnerNoReplace(paths, record, host)
    }
    const publishedOwner = readLifecycleOwnerPublicationHint(paths, host)
    if (!record || !publishedOwner.record
      || canonicalJson(publishedOwner.record) !== canonicalJson(record)
      || !publishedOwner.finalState.stat || publishedOwner.finalState.stat.nlink !== 1
      || publishedOwner.artifacts.length !== 0
      || !sameOptionalBuffer(publishedOwner.finalState.bytes, recordBytes(record))) {
      throw new Error('lifecycle owner did not reach a unique exact publication state')
    }
    exactOwnerState = publishedOwner.finalState
    exactOwnerPublication = publishedOwner
    if (adoptedWalState) {
      assertCapturedFileState(paths.lifecycleWalPath, adoptedWalState, 'locked lifecycle WAL classification')
    }
    const publishedReceipt = readLifecycleRootReceiptNamespace(host)
    const publishedReceiptFenceTarget = publishedReceipt.directoryExists
      ? publishedReceipt.directory
      : dirname(publishedReceipt.directory)
    const publishedReceiptFence = captureDirectoryFence(publishedReceiptFenceTarget)
    const publishedWal = readLifecycleWal(paths, host)
    const publishedWalState = captureFileState(paths.lifecycleWalPath, LIFECYCLE_WAL_MAX_BYTES)
    recoveryTerminalMarkerState = publishedWal?.operation === 'uninstall' && publishedWal.phase === 'committed'
      ? captureFileState(paths.dataMarkerPath, MARKER_MAX_BYTES)
      : null
    recoveryTerminalDataRootFence = recoveryTerminalMarkerState
      ? captureDirectoryFence(paths.dataRoot)
      : null
    const publishedPurgeAuthority = publishedReceipt.receipt
      ? readPurgeAuthoritySnapshot(paths, publishedReceipt.receipt, host)
      : null
    const sealPostPublicationEpoch = () => {
      if (withApplicationGate === 'from-locked-wal' && publishedWal) preflightLockedWalRoots(publishedWal)
      else preflightLockedRoots()
      applicationGate?.seal()
      assertLifecycleNamespaceMutationBoundary()
      assertDirectoryFence(publishedReceiptFenceTarget, publishedReceiptFence)
      assertLifecycleRootReceiptNamespaceExact(
        host,
        publishedReceipt,
        'lifecycle post-publication receipt authority'
      )
      if (receiptPlan?.sealPostOwnerPublication) receiptPlan.sealPostOwnerPublication()
      assertLifecycleOwnerPublicationHint(
        paths,
        host,
        publishedOwner,
        'lifecycle post-publication owner authority'
      )
      assertCapturedFileState(
        paths.lifecycleWalPath,
        publishedWalState,
        'lifecycle post-publication WAL authority',
        LIFECYCLE_WAL_MAX_BYTES
      )
      if (canonicalJson(readLifecycleWal(paths, host)) !== canonicalJson(publishedWal)) {
        throw new Error('lifecycle post-publication WAL authority changed')
      }
      if (recoveryTerminalMarkerState) {
        if (!recoveryTerminalDataRootFence) {
          throw new Error('committed uninstall data-root authority was not frozen')
        }
        assertDirectoryFence(paths.dataRoot, recoveryTerminalDataRootFence)
        assertCapturedFileState(
          paths.dataMarkerPath,
          recoveryTerminalMarkerState,
          'committed uninstall post-publication marker authority',
          MARKER_MAX_BYTES
        )
        if (canonicalJson(readDataRootMarker(paths, host.platform)) !== canonicalJson(publishedWal?.newMarker)) {
          throw new Error('committed uninstall post-publication marker authority changed')
        }
      }
      if (publishedReceipt.receipt && publishedPurgeAuthority) {
        assertPurgeAuthoritySnapshot(
          paths,
          publishedReceipt.receipt,
          host,
          publishedPurgeAuthority,
          'lifecycle post-publication purge authority'
        )
      }
      applicationGate?.seal()
    }
    postPublicationAuthoritySeal = sealPostPublicationEpoch
    sealPostPublicationEpoch()
    if (applicationGate) {
      await applicationGate.revalidate()
      sealPostPublicationEpoch()
      if (receiptPlan?.revalidateExternalAuthority) {
        await receiptPlan.revalidateExternalAuthority(() => applicationGate!.revalidate())
        sealPostPublicationEpoch()
      }
      assertApplicationQuiescent(paths.dataRoot, host, applicationGate.owner)
      sealPostPublicationEpoch()
    }
  } catch (error) {
    if (applicationGate) {
      try { await applicationGate.release() } catch { /* primary acquisition failure wins */ }
      applicationGate = null
    }
    try {
      assertLifecycleNamespaceMutationBoundary()
      if (!adoptedRecoveryAuthority && record && exactOwnerState && exactOwnerPublication) {
        assertLifecycleNamespaceMutationBoundary()
        assertLifecycleOwnerPublicationHint(
          paths,
          host,
          exactOwnerPublication,
          'failed lifecycle acquisition owner cleanup'
        )
        assertCapturedFileState(
          paths.lifecycleLockPath,
          exactOwnerState,
          'failed lifecycle acquisition owner cleanup',
          LIFECYCLE_LOCK_MAX_BYTES
        )
        fs.unlinkSync(paths.lifecycleLockPath)
        flushDirectory(dirname(paths.lifecycleLockPath))
      }
    } catch { /* preserve any concurrently changed owner record */ }
    await closeLifecycleMutex(mutex)
    throw error
  }
  return {
    token,
    recoveryWal: adoptedWal,
    recoveryWalState: adoptedWalState,
    recoveryTerminalMarkerState,
    recoveryTerminalDataRootFence,
    applicationOwner: applicationGate?.owner || null,
    assertPostPublicationAuthority: postPublicationAuthoritySeal,
    sealApplicationGate: () => { if (applicationGate) applicationGate.seal() },
    revalidateApplicationGate: async () => {
      if (applicationGate) await applicationGate.revalidate()
    },
    releaseApplicationGate: async () => {
      if (!applicationGate) return
      const owned = applicationGate
      applicationGate = null
      await owned.release()
    },
    retireOwnerRecord: () => {
      assertLifecycleNamespaceMutationBoundary()
      const current = readLifecycleLock(paths, host)
      if (!current) {
        flushDirectory(dirname(paths.lifecycleLockPath))
        if (lstatOptional(paths.lifecycleLockPath)) throw new Error('lifecycle owner reappeared during retirement proof')
        return
      }
      if (!record || !exactOwnerState || !exactOwnerPublication
        || current.token !== token || canonicalJson(current) !== canonicalJson(record)) {
        throw new Error('lifecycle owner changed before terminal retirement')
      }
      assertCapturedFileState(
        paths.lifecycleLockPath,
        exactOwnerState,
        'terminal lifecycle owner authority',
        LIFECYCLE_LOCK_MAX_BYTES
      )
      const terminalReceipt = readLifecycleRootReceipt(host)
      const terminalPurgeHandoff = terminalReceipt?.state === 'purging'
        && terminalReceipt.lockToken === token
        && !lstatOptional(purgeWalPath(paths.dataRoot))
        && !lstatOptional(paths.dataRoot)
        && !lstatOptional(terminalReceipt.tombstone)
        && !lstatOptional(terminalReceipt.quarantine)
      if (lifecycleRecoveryAuthorityPresent(paths, host, token) && !terminalPurgeHandoff) {
        throw new Error('lifecycle owner still has ordinary lifecycle recovery authority')
      }
      const assertTerminalOwnerPublication = () => {
        if (!terminalPurgeHandoff) {
          assertLifecycleOwnerPublicationHint(
            paths,
            host,
            exactOwnerPublication!,
            'terminal lifecycle owner publication'
          )
          return
        }
        const terminalPublication = readLifecycleOwnerPublicationHint(paths, host)
        if (!terminalPublication.record
          || canonicalJson(terminalPublication.record) !== canonicalJson(record)
          || terminalPublication.artifacts.length !== 0
          || terminalPublication.stageNamespace.directoryState
          || terminalPublication.stageNamespace.markerState
          || terminalPublication.stageNamespace.reservations.length !== 0
          || terminalPublication.stageNamespace.purgeStage) {
          throw new Error('terminal purge owner publication retained a protocol artifact')
        }
        assertCapturedFileState(
          paths.lifecycleLockPath,
          exactOwnerState!,
          'terminal purge lifecycle owner publication',
          LIFECYCLE_LOCK_MAX_BYTES
        )
      }
      assertTerminalOwnerPublication()
      assertLifecycleNamespaceMutationBoundary()
      assertTerminalOwnerPublication()
      assertCapturedFileState(
        paths.lifecycleLockPath,
        exactOwnerState,
        'terminal lifecycle owner retirement',
        LIFECYCLE_LOCK_MAX_BYTES
      )
      fs.unlinkSync(paths.lifecycleLockPath)
      flushDirectory(dirname(paths.lifecycleLockPath))
      if (lstatOptional(paths.lifecycleLockPath)) throw new Error('lifecycle owner retirement failed its absence seal')
    },
    preserveOwnerRecord: () => { preserveOwnerRecord = true },
    release: async () => {
      let failure: unknown = null
      if (applicationGate) {
        const owned = applicationGate
        applicationGate = null
        try { await owned.release() } catch (error) { failure = error }
      }
      try {
        assertLifecycleNamespaceMutationBoundary()
        const current = readLifecycleLock(paths, host)
        if (!preserveOwnerRecord && current?.token === token
          && lifecycleRecoveryAuthorityPresent(paths, host, token)) {
          preserveOwnerRecord = true
        }
        if (!preserveOwnerRecord && current?.token === token && record) {
          if (!exactOwnerState || !exactOwnerPublication
            || canonicalJson(current) !== canonicalJson(record)) {
            throw new Error('lifecycle owner changed before release cleanup')
          }
          assertLifecycleNamespaceMutationBoundary()
          assertLifecycleOwnerPublicationHint(
            paths,
            host,
            exactOwnerPublication,
            'lifecycle release owner publication'
          )
          assertCapturedFileState(
            paths.lifecycleLockPath,
            exactOwnerState,
            'lifecycle release owner cleanup',
            LIFECYCLE_LOCK_MAX_BYTES
          )
          fs.unlinkSync(paths.lifecycleLockPath)
          flushDirectory(dirname(paths.lifecycleLockPath))
        }
      } catch (error) {
        // Never remove a record whose ownership cannot be revalidated, but do
        // not strand the process-local OS mutex on a diagnostics failure.
        if (!failure) failure = error
      } finally {
        try { await closeLifecycleMutex(mutex) } catch (error) { if (!failure) failure = error }
      }
      if (failure) throw failure
    }
  }
}

function requiredDataAssets(dataRoot: string): string[] {
  return PUBLIC_RUNTIME_FILES.map((name) => join(dataRoot, ...name.split('/')))
}

function assertDisjoint(left: string, right: string, label: string, platform: string): void {
  if (isSameOrInside(left, right, platform) || isSameOrInside(right, left, platform)) {
    throw new Error(`${label} must be disjoint: ${left} <> ${right}`)
  }
}

function preflightLifecycleRoots(paths: InstallPaths, host: InstallHost): void {
  if (host.platform === 'win32') {
    for (const [value, label] of [
      [paths.packageRoot, 'package root'],
      [paths.dataRoot, 'data root'],
      [paths.installDir, 'install directory'],
      [paths.nodePath, 'node executable'],
      [paths.cliPath, 'CLI entry'],
      [paths.runDaemonCmd, 'daemon launcher'],
      [paths.silentVbs, 'silent launcher']
    ] as const) {
      if (/[%"\u0000\r\n]/.test(value)) {
        throw new Error(`${label} contains characters that cannot be represented safely in Windows lifecycle launchers`)
      }
    }
  }
  for (const [target, label] of [
    [paths.installDir, 'install directory'],
    [paths.dataRoot, 'data root'],
    [paths.packageRoot, 'package root'],
    ...(paths.extraShimDir ? [[paths.extraShimDir, 'extra shim directory'] as const] : [])
  ] as const) {
    assertLocalLifecycleRoot(target, label, host.platform)
    if (label !== 'package root') assertOutsideProtectedRoots(target, label, host)
    const volumeKind = host.localVolumeKind(target)
    if (volumeKind !== 'local') {
      throw new Error(`${label} must be on a proven local fixed volume; ${volumeKind} volumes are unsupported`)
    }
  }
  assertSafeRecursiveRoot(paths.installDir, 'install directory', [host.home], host.platform)
  assertSafeRecursiveRoot(paths.dataRoot, 'data root', [host.home], host.platform)
  assertSafeRecursiveRoot(paths.packageRoot, 'package root', [], host.platform)
  if (lstatOptional(paths.dataRoot)) {
    assertPlainDirectory(paths.dataRoot, 'data root')
    const allowedDataRootEntries = new Set([
      '.skill-graft-data-root.json',
      '.skill-graft-transactions',
      'AGENTS.override.md',
      'overlay',
      'skills',
      'skill-review'
    ])
    for (const entry of boundedDirectoryEntries(paths.dataRoot, 10_000, 'data-root top-level inventory')) {
      if (!allowedDataRootEntries.has(entry.name)
        && !(lstatOptional(paths.lifecycleWalPath) && isLifecycleStageName(entry.name))) {
        throw new Error(`data root contains an unknown top-level artifact: ${entry.name}`)
      }
    }
  }
  const installPhysical = physicalLifecyclePath(paths.installDir, 'install directory', host.platform, false)
  const dataPhysical = physicalLifecyclePath(paths.dataRoot, 'data root', host.platform, false)
  const packagePhysical = physicalLifecyclePath(paths.packageRoot, 'package root', host.platform, true)
  assertDisjoint(paths.installDir, paths.packageRoot, 'install directory and package root', host.platform)
  assertDisjoint(paths.installDir, paths.dataRoot, 'install directory and data root', host.platform)
  assertDisjoint(paths.dataRoot, paths.packageRoot, 'data root and package root', host.platform)
  assertDisjoint(installPhysical, packagePhysical, 'physical install directory and package root', host.platform)
  assertDisjoint(installPhysical, dataPhysical, 'physical install directory and data root', host.platform)
  assertDisjoint(dataPhysical, packagePhysical, 'physical data root and package root', host.platform)
  if (paths.extraShimDir) {
    assertLocalLifecycleRoot(paths.extraShimDir, 'extra shim directory', host.platform)
    assertOutsideProtectedRoots(paths.extraShimDir, 'extra shim directory', host)
    if (!isAbsolute(paths.extraShimDir)) throw new Error('extra shim directory must be absolute')
    assertSafeRecursiveRoot(paths.extraShimDir, 'extra shim directory', [], host.platform)
    const shimPhysical = physicalLifecyclePath(paths.extraShimDir, 'extra shim directory', host.platform, true)
    assertDisjoint(shimPhysical, installPhysical, 'extra shim directory and install directory', host.platform)
    assertDisjoint(shimPhysical, dataPhysical, 'extra shim directory and data root', host.platform)
    assertDisjoint(shimPhysical, packagePhysical, 'extra shim directory and package root', host.platform)
  }
}

function preflightLifecycleNamespaceMutationPaths(paths: InstallPaths, host: InstallHost): void {
  assertLocalLifecycleRoot(paths.dataRoot, 'data root', host.platform)
  assertOutsideProtectedRoots(paths.dataRoot, 'data root', host)
  if (host.localVolumeKind(paths.dataRoot) !== 'local') {
    throw new Error('data root must be on a proven local fixed volume')
  }
  assertSafeRecursiveRoot(paths.dataRoot, 'data root', [host.home], host.platform)
  physicalLifecyclePath(paths.dataRoot, 'data root', host.platform, false)
  for (const parent of new Set([dirname(paths.lifecycleLockPath), dirname(paths.lifecycleWalPath)])) {
    assertLocalLifecycleRoot(parent, 'lifecycle namespace parent', host.platform)
    assertSafeRecursiveRoot(parent, 'lifecycle namespace parent', [], host.platform)
    physicalLifecyclePath(parent, 'lifecycle namespace parent', host.platform, true)
  }
  const ownerStages = lifecycleOwnerStageNamespacePath(paths)
  assertLocalLifecycleRoot(ownerStages, 'lifecycle owner stage namespace', host.platform)
  assertOutsideProtectedRoots(ownerStages, 'lifecycle owner stage namespace', host)
  assertSafeRecursiveRoot(ownerStages, 'lifecycle owner stage namespace', [], host.platform)
  physicalLifecyclePath(ownerStages, 'lifecycle owner stage namespace', host.platform, false)
}

function preflightPreservedRootPaths(
  paths: InstallPaths,
  receipt: LifecycleRootReceiptV1,
  host: InstallHost
): void {
  if (!samePath(paths.dataRoot, receipt.dataRoot, host.platform)
    || !samePath(paths.installDir, receipt.installDir, host.platform)) {
    throw new Error('preserved root receipt paths changed during narrow preflight')
  }
  for (const [target, label] of [
    [paths.installDir, 'install directory'],
    [paths.dataRoot, 'data root']
  ] as const) {
    assertLocalLifecycleRoot(target, label, host.platform)
    assertOutsideProtectedRoots(target, label, host)
    if (host.localVolumeKind(target) !== 'local') {
      throw new Error(`${label} must be on a proven local fixed volume`)
    }
    assertSafeRecursiveRoot(target, label, [host.home], host.platform)
  }
  if (lstatOptional(paths.dataRoot)) {
    assertPlainDirectory(paths.dataRoot, 'data root')
    const allowedDataRootEntries = new Set([
      '.skill-graft-data-root.json',
      '.skill-graft-transactions',
      'AGENTS.override.md',
      'overlay',
      'skills',
      'skill-review'
    ])
    for (const entry of boundedDirectoryEntries(paths.dataRoot, 10_000, 'data-root top-level inventory')) {
      if (!allowedDataRootEntries.has(entry.name)) {
        throw new Error(`data root contains an unknown top-level artifact: ${entry.name}`)
      }
    }
  }
  const installPhysical = physicalLifecyclePath(paths.installDir, 'install directory', host.platform, false)
  const dataPhysical = physicalLifecyclePath(paths.dataRoot, 'data root', host.platform, false)
  assertDisjoint(paths.installDir, paths.dataRoot, 'install directory and data root', host.platform)
  assertDisjoint(installPhysical, dataPhysical, 'physical install directory and data root', host.platform)
}

function preflightTerminalPreservedRootPaths(
  paths: InstallPaths,
  receipt: LifecycleRootReceiptV1,
  host: InstallHost
): void {
  if (!samePath(paths.dataRoot, receipt.dataRoot, host.platform)
    || !samePath(paths.installDir, receipt.installDir, host.platform)) {
    throw new Error('terminal preserved root receipt paths changed during narrow preflight')
  }
  // A terminal receipt/WAL owns only the preserved data-root protocol and its
  // lifecycle siblings.  The historical install/package locations are merely
  // lexical bindings at this point: later foreign bytes or reparses there must
  // neither be inspected nor prevent terminal recovery.
  preflightLifecycleNamespaceMutationPaths(paths, host)
  assertDisjoint(paths.installDir, paths.dataRoot, 'install directory and data root', host.platform)
}

function preflightPurgeAuthorityPaths(
  paths: InstallPaths,
  receipt: LifecycleRootReceiptV1,
  wal: PurgeWalV1 | null,
  host: InstallHost
): void {
  if (receipt.state === 'purging' || wal?.phase === 'deleted') {
    preflightTerminalPreservedRootPaths(paths, receipt, host)
  } else {
    preflightPreservedRootPaths(paths, receipt, host)
  }
}

function preflightPreservedRootReceiptPaths(
  paths: InstallPaths,
  receipt: LifecycleRootReceiptV1,
  host: InstallHost
): void {
  preflightPreservedRootPaths(paths, receipt, host)
  assertLifecycleRootReceiptCurrentExact(host, receipt)
}

function preflightTerminalPreservedRootReceiptPaths(
  paths: InstallPaths,
  receipt: LifecycleRootReceiptV1,
  host: InstallHost
): void {
  preflightTerminalPreservedRootPaths(paths, receipt, host)
  assertLifecycleRootReceiptCurrentExact(host, receipt)
}

function hashOpenFile(file: string, expectedSize?: number, maxBytes = 10 * 1024 * 1024 * 1024): Sha256Digest {
  const before = fs.lstatSync(file)
  const size = expectedSize ?? before.size
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
    || before.size !== size || size > maxBytes) {
    throw new Error(`lifecycle tree file is not a bounded unique plain file: ${file}`)
  }
  const hash = createHash('sha256')
  const descriptor = fs.openSync(file, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    const opened = fs.fstatSync(descriptor)
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== size || opened.nlink !== 1) {
      throw new Error(`lifecycle tree file changed before bounded hashing: ${file}`)
    }
    let position = 0
    while (position < size) {
      const count = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, size - position), position)
      if (count === 0) throw new Error(`lifecycle tree file ended before its recorded size: ${file}`)
      hash.update(buffer.subarray(0, count))
      position += count
    }
    if (fs.readSync(descriptor, buffer, 0, 1, size) !== 0) {
      throw new Error(`lifecycle tree file grew during bounded hashing: ${file}`)
    }
    const after = fs.fstatSync(descriptor)
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || after.nlink !== opened.nlink) {
      throw new Error(`lifecycle tree file changed during bounded hashing: ${file}`)
    }
  } finally {
    fs.closeSync(descriptor)
  }
  const pathAfter = fs.lstatSync(file)
  if (!pathAfter.isFile() || pathAfter.isSymbolicLink()
    || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino || pathAfter.size !== before.size
    || pathAfter.mtimeMs !== before.mtimeMs || pathAfter.nlink !== before.nlink) {
    throw new Error(`lifecycle tree file path changed during bounded hashing: ${file}`)
  }
  return `sha256:${hash.digest('hex')}`
}

function walkPlainTree(
  root: string,
  limits: { maxEntries?: number; maxBytes?: number; label?: string } = {}
): Array<{ path: string; absolute: string; kind: 'file' | 'directory'; size: number; sha256?: Sha256Digest }> {
  if (!fs.existsSync(root)) return []
  assertPlainDirectory(root, 'lifecycle tree root')
  const output: Array<{ path: string; absolute: string; kind: 'file' | 'directory'; size: number; sha256?: Sha256Digest }> = []
  const maxEntries = limits.maxEntries ?? 100_000
  const maxBytes = limits.maxBytes ?? 10 * 1024 * 1024 * 1024
  const label = limits.label || 'lifecycle tree'
  let totalBytes = 0
  const visit = (directory: string, prefix: string) => {
    for (const item of boundedDirectoryEntries(directory, maxEntries - output.length, label)
      .sort((left, right) => compareUtf8Path(left.name, right.name))) {
      const name = item.name
      if (output.length + 1 > maxEntries) throw new Error(`${label} exceeds the ${maxEntries}-entry safety limit`)
      const absolute = join(directory, name)
      const relativePath = prefix ? `${prefix}/${name}` : name
      const stat = fs.lstatSync(absolute)
      if (stat.isSymbolicLink()) throw new Error(`lifecycle tree contains a reparse/symbolic entry: ${relativePath}`)
      if (stat.isDirectory()) {
        output.push({ path: `${relativePath}/`, absolute, kind: 'directory', size: 0 })
        visit(absolute, relativePath)
      } else if (stat.isFile()) {
        totalBytes += stat.size
        if (totalBytes > maxBytes) throw new Error(`${label} exceeds the ${maxBytes}-byte safety limit`)
        output.push({
          path: relativePath,
          absolute,
          kind: 'file',
          size: stat.size,
          sha256: hashOpenFile(absolute, stat.size, maxBytes - (totalBytes - stat.size))
        })
      } else {
        throw new Error(`lifecycle tree contains an unsupported entry: ${relativePath}`)
      }
    }
  }
  visit(root, '')
  return output
}

async function captureHashedFileStateWithRevalidation(
  file: string,
  expectedSize: number,
  revalidate: () => Promise<void>,
  expectedStat?: PlainTreeMetadataEntry['stat']
): Promise<CapturedHashedFileState> {
  const initial = fs.lstatSync(file)
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1
    || initial.size !== expectedSize
    || expectedStat && canonicalJson(plainTreeMetadataStat(initial)) !== canonicalJson(expectedStat)) {
    throw new Error('lifecycle tree path changed before its first asynchronous hashing boundary')
  }
  const pathBefore = await fs.promises.lstat(file)
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || pathBefore.nlink !== 1
    || pathBefore.size !== expectedSize
    || canonicalJson(plainTreeMetadataStat(pathBefore)) !== canonicalJson(plainTreeMetadataStat(initial))) {
    throw new Error('lifecycle tree path changed before bounded hashing')
  }
  const descriptor = await fs.promises.open(file, 'r')
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  let position = 0
  try {
    const before = await descriptor.stat()
    if (!before.isFile() || before.nlink !== 1 || before.size !== expectedSize
      || canonicalJson(plainTreeMetadataStat(before)) !== canonicalJson(plainTreeMetadataStat(initial))) {
      throw new Error('lifecycle tree file changed before bounded hashing')
    }
    while (position < expectedSize) {
      const { bytesRead } = await descriptor.read(
        buffer,
        0,
        Math.min(buffer.length, expectedSize - position),
        position
      )
      if (bytesRead === 0) throw new Error('lifecycle tree file ended before its recorded size')
      hash.update(buffer.subarray(0, bytesRead))
      position += bytesRead
      if (position % (8 * 1024 * 1024) === 0) await revalidate()
    }
    const probe = await descriptor.read(buffer, 0, 1, expectedSize)
    if (probe.bytesRead !== 0) throw new Error('lifecycle tree file grew during bounded hashing')
    const after = await descriptor.stat()
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.nlink !== before.nlink
      || position !== before.size) {
      throw new Error('lifecycle tree file changed during bounded hashing')
    }
  } finally {
    await descriptor.close()
  }
  const pathAfter = await fs.promises.lstat(file)
  if (!pathAfter.isFile() || pathAfter.isSymbolicLink()
    || pathAfter.dev !== pathBefore.dev || pathAfter.ino !== pathBefore.ino
    || pathAfter.size !== pathBefore.size || pathAfter.mtimeMs !== pathBefore.mtimeMs
    || pathAfter.nlink !== pathBefore.nlink) {
    throw new Error('lifecycle tree path changed during bounded hashing')
  }
  return {
    sha256: `sha256:${hash.digest('hex')}`,
    stat: {
      dev: pathAfter.dev,
      ino: pathAfter.ino,
      size: pathAfter.size,
      mtimeMs: pathAfter.mtimeMs,
      nlink: pathAfter.nlink
    }
  }
}

async function hashOpenFileWithRevalidation(
  file: string,
  expectedSize: number,
  revalidate: () => Promise<void>
): Promise<Sha256Digest> {
  return (await captureHashedFileStateWithRevalidation(file, expectedSize, revalidate)).sha256
}

async function walkPlainTreeWithRevalidation(
  root: string,
  limits: { maxEntries: number; maxBytes: number; label: string },
  revalidate: () => Promise<void>,
  expectedMetadata?: PlainTreeMetadataSnapshot
): Promise<Array<PlainTreeEntry & { capture?: CapturedHashedFileState }>> {
  const metadata = expectedMetadata || capturePlainTreeMetadata(root, limits)
  const metadataByPath = new Map(metadata.entries.map((entry) => [entry.path, entry]))
  const childrenByParent = new Map<string, string[]>()
  for (const entry of metadata.entries) {
    const normalized = entry.kind === 'directory' ? entry.path.slice(0, -1) : entry.path
    const separator = normalized.lastIndexOf('/')
    const parent = separator < 0 ? '' : normalized.slice(0, separator)
    const children = childrenByParent.get(parent) || []
    children.push(normalized.slice(separator + 1))
    childrenByParent.set(parent, children)
  }
  const assertStat = (absolute: string, expected: PlainTreeMetadataEntry['stat'], kind: 'file' | 'directory', label: string) => {
    const stat = fs.lstatSync(absolute)
    if (stat.isSymbolicLink()
      || kind === 'file' && (!stat.isFile() || stat.nlink !== 1)
      || kind === 'directory' && !stat.isDirectory()
      || canonicalJson(plainTreeMetadataStat(stat)) !== canonicalJson(expected)) {
      throw new Error(`${limits.label} ${label} changed after its initial metadata freeze`)
    }
  }
  const assertRoot = () => assertStat(resolve(root), metadata.root, 'directory', 'root')
  assertRoot()
  await revalidate()
  assertRoot()
  const output: Array<PlainTreeEntry & { capture?: CapturedHashedFileState }> = []
  let totalBytes = 0
  let checkedEntries = 0
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const directoryMetadata = prefix ? metadataByPath.get(`${prefix}/`) : null
    if (prefix && (!directoryMetadata || directoryMetadata.kind !== 'directory')) {
      throw new Error(`${limits.label} contains a directory absent from its initial metadata freeze: ${prefix}`)
    }
    const assertDirectory = () => prefix
      ? assertStat(directory, directoryMetadata!.stat, 'directory', `directory ${prefix}`)
      : assertRoot()
    assertDirectory()
    const entries = boundedDirectoryEntries(
      directory,
      limits.maxEntries - output.length,
      limits.label
    ).sort((left, right) => compareUtf8Path(left.name, right.name))
    const expectedChildren = [...(childrenByParent.get(prefix) || [])].sort(compareUtf8Path)
    if (entries.length !== expectedChildren.length
      || entries.some((entry, index) => entry.name !== expectedChildren[index])) {
      throw new Error(`${limits.label} directory inventory changed after its initial metadata freeze: ${prefix || '.'}`)
    }
    for (const directoryEntry of entries) {
      const name = directoryEntry.name
      if (output.length + 1 > limits.maxEntries) {
        throw new Error(`${limits.label} exceeds the ${limits.maxEntries}-entry safety limit`)
      }
      const absolute = join(directory, name)
      const relativePath = prefix ? `${prefix}/${name}` : name
      const expected = metadataByPath.get(directoryEntry.isDirectory() ? `${relativePath}/` : relativePath)
      if (!expected) throw new Error(`${limits.label} contains an entry absent from its initial metadata freeze: ${relativePath}`)
      if (checkedEntries++ % 128 === 0) {
        assertDirectory()
        await revalidate()
        assertDirectory()
      }
      assertStat(absolute, expected.stat, expected.kind, `entry ${relativePath}`)
      if (expected.kind === 'directory') {
        output.push({ path: `${relativePath}/`, absolute, kind: 'directory', size: 0 })
        await visit(absolute, relativePath)
      } else {
        totalBytes += expected.size
        if (totalBytes > limits.maxBytes) {
          throw new Error(`${limits.label} exceeds the ${limits.maxBytes}-byte safety limit`)
        }
        const capture = await captureHashedFileStateWithRevalidation(absolute, expected.size, revalidate, expected.stat)
        output.push({ path: relativePath, absolute, kind: 'file', size: expected.size, sha256: capture.sha256, capture })
      }
    }
  }
  await visit(root, '')
  assertRoot()
  await revalidate()
  assertRoot()
  return output
}

type PlainTreeEntry = ReturnType<typeof walkPlainTree>[number]

type PlainTreeMetadataEntry = {
  path: string
  absolute: string
  kind: 'file' | 'directory'
  size: number
  stat: { dev: number; ino: number; size: number; mtimeMs: number; nlink: number }
}

type PlainTreeMetadataSnapshot = {
  root: { dev: number; ino: number; size: number; mtimeMs: number; nlink: number }
  entries: readonly PlainTreeMetadataEntry[]
}

function plainTreeMetadataStat(stat: fs.Stats): PlainTreeMetadataEntry['stat'] {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, nlink: stat.nlink }
}

function capturePlainTreeMetadata(
  root: string,
  limits: { maxEntries: number; maxBytes: number; label: string }
): PlainTreeMetadataSnapshot {
  const absoluteRoot = resolve(root)
  const rootStat = fs.lstatSync(absoluteRoot)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`${limits.label} root is not a plain directory during its initial metadata freeze`)
  }
  const entries: PlainTreeMetadataEntry[] = []
  let totalBytes = 0
  const visit = (directory: string, prefix: string): void => {
    const inventory = boundedDirectoryEntries(
      directory,
      limits.maxEntries - entries.length,
      `${limits.label} metadata inventory`
    ).sort((left, right) => compareUtf8Path(left.name, right.name))
    for (const item of inventory) {
      if (entries.length + 1 > limits.maxEntries) {
        throw new Error(`${limits.label} exceeds the ${limits.maxEntries}-entry safety limit`)
      }
      const absolute = join(directory, item.name)
      const relativePath = prefix ? `${prefix}/${item.name}` : item.name
      const stat = fs.lstatSync(absolute)
      if (stat.isSymbolicLink()) throw new Error(`${limits.label} contains a reparse/symbolic entry: ${relativePath}`)
      if (stat.isDirectory()) {
        entries.push({
          path: `${relativePath}/`,
          absolute,
          kind: 'directory',
          size: 0,
          stat: plainTreeMetadataStat(stat)
        })
        visit(absolute, relativePath)
      } else if (stat.isFile()) {
        if (stat.nlink !== 1) throw new Error(`${limits.label} contains a linked file: ${relativePath}`)
        totalBytes += stat.size
        if (totalBytes > limits.maxBytes) {
          throw new Error(`${limits.label} exceeds the ${limits.maxBytes}-byte safety limit`)
        }
        entries.push({
          path: relativePath,
          absolute,
          kind: 'file',
          size: stat.size,
          stat: plainTreeMetadataStat(stat)
        })
      } else {
        throw new Error(`${limits.label} contains an unsupported entry: ${relativePath}`)
      }
    }
  }
  visit(absoluteRoot, '')
  return { root: plainTreeMetadataStat(rootStat), entries }
}

function assertPlainTreeMetadataManifest(
  expected: PlainTreeMetadataSnapshot,
  manifest: readonly Pick<PurgeWalEntryV1, 'path' | 'kind' | 'size'>[],
  label: string
): void {
  if (expected.entries.length !== manifest.length) throw new Error(`${label} inventory differs from its manifest`)
  for (let index = 0; index < expected.entries.length; index += 1) {
    const frozen = expected.entries[index]
    const recorded = manifest[index]
    if (frozen.path !== recorded.path || frozen.kind !== recorded.kind || frozen.size !== recorded.size) {
      throw new Error(`${label} metadata differs from its manifest at ${recorded.path}`)
    }
  }
}

function assertPlainTreeMetadataCurrent(
  root: string,
  expected: PlainTreeMetadataSnapshot,
  observed: readonly (PlainTreeEntry & { capture?: CapturedHashedFileState })[],
  label: string
): void {
  const rootStat = fs.lstatSync(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
    || canonicalJson(plainTreeMetadataStat(rootStat)) !== canonicalJson(expected.root)) {
    throw new Error(`${label} root changed after its initial metadata freeze`)
  }
  if (expected.entries.length !== observed.length) throw new Error(`${label} inventory changed after its initial metadata freeze`)
  for (let index = 0; index < expected.entries.length; index += 1) {
    const frozen = expected.entries[index]
    const current = observed[index]
    if (frozen.path !== current.path || frozen.kind !== current.kind || frozen.size !== current.size) {
      throw new Error(`${label} inventory changed after its initial metadata freeze`)
    }
    if (frozen.kind === 'file') {
      if (!current.capture || canonicalJson(current.capture.stat) !== canonicalJson(frozen.stat)) {
        throw new Error(`${label} file changed after its initial metadata freeze: ${frozen.path}`)
      }
    } else {
      const stat = fs.lstatSync(frozen.absolute)
      if (!stat.isDirectory() || stat.isSymbolicLink()
        || canonicalJson(plainTreeMetadataStat(stat)) !== canonicalJson(frozen.stat)) {
        throw new Error(`${label} directory changed after its initial metadata freeze: ${frozen.path}`)
      }
    }
  }
}

function assertPlainTreeMetadataSnapshotCurrent(
  root: string,
  expected: PlainTreeMetadataSnapshot,
  limits: { maxEntries: number; maxBytes: number; label: string }
): void {
  const current = capturePlainTreeMetadata(root, limits)
  if (canonicalJson(current.root) !== canonicalJson(expected.root)
    || current.entries.length !== expected.entries.length
    || current.entries.some((entry, index) => {
      const frozen = expected.entries[index]
      return !frozen || entry.path !== frozen.path || entry.absolute !== frozen.absolute
        || entry.kind !== frozen.kind || entry.size !== frozen.size
        || canonicalJson(entry.stat) !== canonicalJson(frozen.stat)
    })) {
    throw new Error(`${limits.label} changed after its pre-gate metadata freeze`)
  }
}

type PurgeWalEntryV1 = {
  path: string
  kind: 'file' | 'directory'
  size: number
  sha256: Sha256Digest | null
}

type PurgeWalPhase = 'prepared' | 'renamed' | 'deleting' | 'deleted'

type PurgeWalV1 = {
  schemaVersion: 1
  product: typeof PRODUCT_NAME
  operation: 'purge'
  purgeId: string
  lockToken: string
  phase: PurgeWalPhase
  dataRootId: string
  dataRoot: string
  tombstone: string
  quarantine: string
  rootDev: string
  rootIno: string
  receiptSha256: Sha256Digest
  plan: PurgePlanV1
  entries: PurgeWalEntryV1[]
  createdAt: string
  updatedAt: string
}

type PurgeAuthoritySnapshot = {
  final: PurgeWalV1 | null
  finalState: CapturedFileState
  stage: PurgeWalV1 | null
  stagePartial: boolean
  stageNamespace: LifecycleOwnerStageNamespace
}

function canonicalPlainTree(entries: readonly PlainTreeEntry[]): string {
  return canonicalJson(entries.map((entry) => ({
    path: entry.path,
    kind: entry.kind,
    size: entry.size,
    sha256: entry.sha256 || null
  })))
}

function compareUtf8Path(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function purgeWalPath(dataRoot: string): string {
  return `${resolve(dataRoot)}.purge-wal-v1.json`
}

function purgeWalEntry(entry: PlainTreeEntry): PurgeWalEntryV1 {
  return {
    path: entry.path,
    kind: entry.kind,
    size: entry.size,
    sha256: entry.sha256 || null
  }
}

function purgeWalReceiptSha256(receipt: LifecycleRootReceiptV1): Sha256Digest {
  return receipt.state === 'purging'
    ? receipt.priorInactiveReceiptSha256
    : sha256Bytes(recordBytes(receipt))
}

function purgeWalTreeSha256(entries: readonly PurgeWalEntryV1[]): Sha256Digest {
  return sha256Bytes(canonicalJson(entries))
}

function validatePurgePlanValue(value: unknown, dataRootId: string, entries: readonly PurgeWalEntryV1[]): PurgePlanV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('purge WAL plan is invalid')
  const plan = value as Record<string, unknown>
  if (!exactKeys(plan, ['schemaVersion', 'action', 'dataRootId', 'treeSha256', 'entries', 'bytes', 'planHash'])
    || plan.schemaVersion !== 1 || plan.action !== 'purge' || plan.dataRootId !== dataRootId
    || typeof plan.treeSha256 !== 'string' || !SHA256_DIGEST.test(plan.treeSha256)
    || !Number.isSafeInteger(plan.entries) || Number(plan.entries) < 1 || Number(plan.entries) > 100_000
    || !Number.isSafeInteger(plan.bytes) || Number(plan.bytes) < 0 || Number(plan.bytes) > 10 * 1024 * 1024 * 1024
    || typeof plan.planHash !== 'string' || !SHA256_DIGEST.test(plan.planHash)) {
    throw new Error('purge WAL plan is invalid')
  }
  const bytes = entries.reduce((total, entry) => total + entry.size, 0)
  if (Number(plan.entries) !== entries.length || Number(plan.bytes) !== bytes
    || plan.treeSha256 !== purgeWalTreeSha256(entries)) {
    throw new Error('purge WAL plan does not bind its full tree manifest')
  }
  const core = {
    schemaVersion: 1 as const,
    action: 'purge' as const,
    dataRootId,
    treeSha256: plan.treeSha256 as Sha256Digest,
    entries: Number(plan.entries),
    bytes: Number(plan.bytes)
  }
  if (plan.planHash !== sha256Bytes(canonicalJson(core))) throw new Error('purge WAL plan hash is invalid')
  return { ...core, planHash: plan.planHash as Sha256Digest }
}

function validatePurgeWalEntry(value: unknown): PurgeWalEntryV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('purge WAL tree entry is invalid')
  const entry = value as Record<string, unknown>
  if (!exactKeys(entry, ['path', 'kind', 'size', 'sha256'])
    || typeof entry.path !== 'string' || Buffer.byteLength(entry.path, 'utf8') < 1
    || Buffer.byteLength(entry.path, 'utf8') > 32 * 1024 || entry.path.includes('\0')
    || entry.path.startsWith('/') || entry.path.includes('\\')) {
    throw new Error('purge WAL tree entry path is invalid')
  }
  const directory = entry.kind === 'directory'
  const file = entry.kind === 'file'
  if (!directory && !file) throw new Error('purge WAL tree entry kind is invalid')
  const pathValue = entry.path as string
  if (directory !== pathValue.endsWith('/')) throw new Error('purge WAL tree entry path/kind binding is invalid')
  const segments = (directory ? pathValue.slice(0, -1) : pathValue).split('/')
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error('purge WAL tree entry escapes its tombstone')
  }
  if (!Number.isSafeInteger(entry.size) || Number(entry.size) < 0
    || directory && Number(entry.size) !== 0
    || file && (typeof entry.sha256 !== 'string' || !SHA256_DIGEST.test(entry.sha256))
    || directory && entry.sha256 !== null) {
    throw new Error('purge WAL tree entry facts are invalid')
  }
  return {
    path: pathValue,
    kind: directory ? 'directory' : 'file',
    size: Number(entry.size),
    sha256: file ? entry.sha256 as Sha256Digest : null
  }
}

function purgeWalEntriesInDfsOrder(entries: readonly PurgeWalEntryV1[]): PurgeWalEntryV1[] {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]))
  const children = new Map<string, PurgeWalEntryV1[]>()
  for (const entry of entries) {
    const normalized = entry.kind === 'directory' ? entry.path.slice(0, -1) : entry.path
    const separator = normalized.lastIndexOf('/')
    const parent = separator < 0 ? '' : `${normalized.slice(0, separator)}/`
    if (parent && byPath.get(parent)?.kind !== 'directory') {
      throw new Error(`purge WAL tree entry has no recorded parent directory: ${entry.path}`)
    }
    const list = children.get(parent) || []
    list.push(entry)
    children.set(parent, list)
  }
  const ordered: PurgeWalEntryV1[] = []
  const visit = (parent: string) => {
    const list = children.get(parent) || []
    list.sort((left, right) => {
      const leftName = (left.kind === 'directory' ? left.path.slice(0, -1) : left.path).slice(parent.length)
      const rightName = (right.kind === 'directory' ? right.path.slice(0, -1) : right.path).slice(parent.length)
      return compareUtf8Path(leftName, rightName)
    })
    for (const entry of list) {
      ordered.push(entry)
      if (entry.kind === 'directory') visit(entry.path)
    }
  }
  visit('')
  if (ordered.length !== entries.length) throw new Error('purge WAL tree manifest is disconnected')
  return ordered
}

function validatePurgeWal(
  value: unknown,
  paths: InstallPaths,
  receipt: LifecycleRootReceiptV1,
  host: InstallHost
): PurgeWalV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('purge WAL is invalid')
  const wal = value as Record<string, unknown>
  if (!exactKeys(wal, [
    'schemaVersion', 'product', 'operation', 'purgeId', 'lockToken', 'phase', 'dataRootId', 'dataRoot',
    'tombstone', 'quarantine', 'rootDev', 'rootIno', 'receiptSha256', 'plan', 'entries', 'createdAt', 'updatedAt'
  ])
    || wal.schemaVersion !== 1 || wal.product !== PRODUCT_NAME || wal.operation !== 'purge'
    || typeof wal.purgeId !== 'string' || !UUID.test(wal.purgeId)
    || typeof wal.lockToken !== 'string' || !UUID.test(wal.lockToken)
    || !['prepared', 'renamed', 'deleting', 'deleted'].includes(String(wal.phase))
    || wal.dataRootId !== receipt.dataRootId
    || typeof wal.dataRoot !== 'string' || !samePath(wal.dataRoot, receipt.dataRoot, host.platform)
    || typeof wal.tombstone !== 'string' || !isAbsolute(wal.tombstone)
    || typeof wal.quarantine !== 'string' || !isAbsolute(wal.quarantine)
    || typeof wal.rootDev !== 'string' || !/^[0-9]+$/.test(wal.rootDev)
    || typeof wal.rootIno !== 'string' || !/^[0-9]+$/.test(wal.rootIno)
    || wal.receiptSha256 !== purgeWalReceiptSha256(receipt)
    || !Array.isArray(wal.entries) || wal.entries.length < 1 || wal.entries.length > 100_000
    || !canonicalIsoTimestamp(wal.createdAt) || !canonicalIsoTimestamp(wal.updatedAt)
    || Date.parse(wal.updatedAt as string) < Date.parse(wal.createdAt as string)) {
    throw new Error('purge WAL is not bound to the preserved root authority')
  }
  const expectedTombstone = `${resolve(paths.dataRoot)}.purging-${receipt.dataRootId}-${String(wal.purgeId).toLowerCase()}`
  if (!samePath(wal.tombstone as string, expectedTombstone, host.platform)
    || !samePath(wal.quarantine as string, frozenDeleteQuarantine(expectedTombstone), host.platform)
    || !samePath(wal.dataRoot as string, paths.dataRoot, host.platform)) {
    throw new Error('purge WAL tombstone namespace is invalid')
  }
  const entries = (wal.entries as unknown[]).map(validatePurgeWalEntry)
  const unique = new Set<string>()
  for (const entry of entries) {
    if (unique.has(entry.path)) throw new Error('purge WAL tree manifest contains duplicate paths')
    unique.add(entry.path)
  }
  const ordered = purgeWalEntriesInDfsOrder(entries)
  if (canonicalJson(ordered) !== canonicalJson(entries)) throw new Error('purge WAL tree manifest is not canonical DFS order')
  const plan = validatePurgePlanValue(wal.plan, receipt.dataRootId, entries)
  const result: PurgeWalV1 = {
    schemaVersion: 1,
    product: PRODUCT_NAME,
    operation: 'purge',
    purgeId: String(wal.purgeId).toLowerCase(),
    lockToken: String(wal.lockToken).toLowerCase(),
    phase: wal.phase as PurgeWalPhase,
    dataRootId: receipt.dataRootId,
    dataRoot: resolve(paths.dataRoot),
    tombstone: expectedTombstone,
    quarantine: frozenDeleteQuarantine(expectedTombstone),
    rootDev: wal.rootDev as string,
    rootIno: wal.rootIno as string,
    receiptSha256: wal.receiptSha256 as Sha256Digest,
    plan,
    entries,
    createdAt: wal.createdAt as string,
    updatedAt: wal.updatedAt as string
  }
  if (receipt.state === 'purging' && (result.phase !== 'deleted'
    || receipt.purgeId !== result.purgeId || receipt.lockToken !== result.lockToken
    || receipt.planHash !== result.plan.planHash || receipt.treeSha256 !== result.plan.treeSha256
    || receipt.entries !== result.plan.entries || receipt.bytes !== result.plan.bytes
    || receipt.rootDev !== result.rootDev || receipt.rootIno !== result.rootIno
    || !samePath(receipt.tombstone, result.tombstone, host.platform)
    || !samePath(receipt.quarantine, result.quarantine, host.platform)
    || receipt.deletedWalSha256 !== sha256Bytes(recordBytes(result)))) {
    throw new Error('deleted purge WAL does not match the purging receipt handoff')
  }
  if (!recordBytes(result).equals(recordBytes(value))) throw new Error('purge WAL bytes are not canonical')
  return result
}

function parsePurgeWalBytes(
  bytes: Buffer,
  paths: InstallPaths,
  receipt: LifecycleRootReceiptV1,
  host: InstallHost
): PurgeWalV1 {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new Error('purge WAL JSON is incomplete or invalid')
  }
  return validatePurgeWal(parsed, paths, receipt, host)
}

function materializePurgeWalEntries(wal: PurgeWalV1): PlainTreeEntry[] {
  return wal.entries.map((entry) => ({
    path: entry.path,
    absolute: join(wal.tombstone, ...(entry.kind === 'directory' ? entry.path.slice(0, -1) : entry.path).split('/')),
    kind: entry.kind,
    size: entry.size,
    ...(entry.sha256 ? { sha256: entry.sha256 } : {})
  }))
}

function readPurgeAuthoritySnapshot(
  paths: InstallPaths,
  receipt: LifecycleRootReceiptV1,
  host: InstallHost
): PurgeAuthoritySnapshot {
  const stageNamespace = readLifecycleOwnerStageNamespace(paths, host)
  const finalPath = purgeWalPath(paths.dataRoot)
  const finalStat = lstatOptional(finalPath)
  if (finalStat && (!stageNamespace.namespaceId || !stageNamespace.markerState)) {
    throw new Error('purge WAL exists without its durable owner-stage namespace authority')
  }
  if (finalStat && (!finalStat.isFile() || finalStat.isSymbolicLink()
    || finalStat.nlink < 1 || finalStat.nlink > 2 || finalStat.size > PURGE_WAL_MAX_BYTES)) {
    throw new Error('purge WAL is not a bounded internal file')
  }
  const finalState = captureFileState(finalPath, PURGE_WAL_MAX_BYTES, finalStat?.nlink === 2)
  const final = finalState.bytes ? parsePurgeWalBytes(finalState.bytes, paths, receipt, host) : null
  let stage: PurgeWalV1 | null = null
  let stagePartial = false
  const staged = stageNamespace.purgeStage
  if (staged) {
    const bytes = staged.state.bytes
    if (!bytes) throw new Error('purge WAL staging artifact disappeared while classified')
    let parsed: unknown
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      stage = validatePurgeWal(parsed, paths, receipt, host)
      if (stage.purgeId !== staged.purgeId || stage.lockToken !== staged.lockToken) {
        throw new Error('purge WAL staging bytes do not match the reserved stage name')
      }
    } catch {
      stage = null
      stagePartial = true
    }
  }
  if (finalStat?.nlink === 2) {
    if (!stage || !staged || staged.state.stat?.nlink !== 2
      || canonicalJson(final) !== canonicalJson(stage)
      || !sameOptionalBuffer(finalState.bytes, staged.state.bytes)) {
      throw new Error('published purge WAL is not an exact internal hard-link pair')
    }
  }
  if (!final && stage && stage.phase !== 'prepared') {
    throw new Error('unpublished purge WAL stage is not an initial prepared authority')
  }
  return { final, finalState, stage, stagePartial, stageNamespace }
}

function samePurgeAuthoritySnapshot(left: PurgeAuthoritySnapshot, right: PurgeAuthoritySnapshot): boolean {
  return canonicalJson(left.final) === canonicalJson(right.final)
    && canonicalJson(left.stage) === canonicalJson(right.stage)
    && left.stagePartial === right.stagePartial
    && canonicalJson(left.finalState.stat) === canonicalJson(right.finalState.stat)
    && sameOptionalBuffer(left.finalState.bytes, right.finalState.bytes)
    && sameLifecycleOwnerStageNamespace(left.stageNamespace, right.stageNamespace)
}

function assertPurgeAuthoritySnapshot(
  paths: InstallPaths,
  receipt: LifecycleRootReceiptV1,
  host: InstallHost,
  expected: PurgeAuthoritySnapshot,
  label: string
): void {
  const current = readPurgeAuthoritySnapshot(paths, receipt, host)
  if (!samePurgeAuthoritySnapshot(current, expected)) throw new Error(`${label} changed`)
}

function purgeWalPhaseAfter(current: PurgeWalPhase): PurgeWalPhase | null {
  if (current === 'prepared') return 'renamed'
  if (current === 'renamed') return 'deleting'
  if (current === 'deleting') return 'deleted'
  return null
}

function transitionPurgeWal(wal: PurgeWalV1, phase: PurgeWalPhase): PurgeWalV1 {
  if (phase !== wal.phase && purgeWalPhaseAfter(wal.phase) !== phase) {
    throw new Error(`invalid purge WAL phase transition: ${wal.phase} -> ${phase}`)
  }
  return { ...wal, phase, updatedAt: new Date().toISOString() }
}

function assertPurgeWalTransition(expected: PurgeWalV1, target: PurgeWalV1): void {
  if (purgeWalPhaseAfter(expected.phase) !== target.phase) {
    throw new Error(`purge WAL staged an invalid phase transition: ${expected.phase} -> ${target.phase}`)
  }
  const normalized = { ...target, phase: expected.phase, updatedAt: expected.updatedAt }
  if (canonicalJson(normalized) !== canonicalJson(expected)) {
    throw new Error('purge WAL staged transition changed immutable authority fields')
  }
}

function createPreparedPurgeWal(
  paths: InstallPaths,
  receipt: LifecycleRootReceiptV1,
  lockToken: string,
  plan: PurgePlanV1,
  entries: readonly PlainTreeEntry[],
  rootStat: fs.Stats,
  host: InstallHost
): PurgeWalV1 {
  if (!UUID.test(lockToken) || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('purge WAL requires an exact lifecycle owner and plain data-root inode')
  }
  const purgeId = randomUUID()
  const now = new Date().toISOString()
  const manifest = entries.map(purgeWalEntry)
  const wal: PurgeWalV1 = {
    schemaVersion: 1,
    product: PRODUCT_NAME,
    operation: 'purge',
    purgeId,
    lockToken,
    phase: 'prepared',
    dataRootId: receipt.dataRootId,
    dataRoot: resolve(paths.dataRoot),
    tombstone: `${resolve(paths.dataRoot)}.purging-${receipt.dataRootId}-${purgeId}`,
    quarantine: '',
    rootDev: String(rootStat.dev),
    rootIno: String(rootStat.ino),
    receiptSha256: purgeWalReceiptSha256(receipt),
    plan,
    entries: manifest,
    createdAt: now,
    updatedAt: now
  }
  wal.quarantine = frozenDeleteQuarantine(wal.tombstone)
  const bytes = recordBytes(wal)
  if (bytes.length > PURGE_WAL_MAX_BYTES) {
    throw new Error(`purge WAL exceeds its ${PURGE_WAL_MAX_BYTES}-byte safety limit`)
  }
  return validatePurgeWal(JSON.parse(bytes.toString('utf8')), paths, receipt, host)
}

function purgingLifecycleRootReceipt(
  inactive: LifecycleRootReceiptV1,
  wal: PurgeWalV1,
  host: InstallHost
): LifecycleRootReceiptV1 {
  if (inactive.state !== 'inactive' || wal.phase !== 'deleted'
    || wal.receiptSha256 !== sha256Bytes(recordBytes(inactive))) {
    throw new Error('purging receipt handoff requires the exact inactive receipt and deleted purge WAL')
  }
  const receipt: LifecycleRootReceiptV1 = {
    ...inactive,
    state: 'purging',
    purgeId: wal.purgeId,
    lockToken: wal.lockToken,
    priorInactiveReceiptSha256: wal.receiptSha256,
    planHash: wal.plan.planHash,
    treeSha256: wal.plan.treeSha256,
    entries: wal.plan.entries,
    bytes: wal.plan.bytes,
    rootDev: wal.rootDev,
    rootIno: wal.rootIno,
    tombstone: wal.tombstone,
    quarantine: wal.quarantine,
    deletedWalSha256: sha256Bytes(recordBytes(wal)),
    // The deleted WAL is the durable transition authority. Reconstructing the
    // handoff after a receipt-writer crash must reproduce byte-identical JSON.
    updatedAt: wal.updatedAt
  }
  return validateLifecycleRootReceipt(receipt as unknown as Record<string, unknown>, host)
}

type PurgeReceiptPublicationSelection = {
  namespace: LifecycleRootReceiptNamespace
  final: LifecycleRootReceiptV1
  target: LifecycleRootReceiptV1 | null
  partialWriter: boolean
  hasTransitionArtifacts: boolean
}

function classifyPurgeReceiptPublication(
  namespace: LifecycleRootReceiptNamespace,
  host: InstallHost
): PurgeReceiptPublicationSelection | null {
  if (namespace.daemonStageAuthorityMarker || namespace.daemonStageNamespaceId) {
    throw new Error('purge requires daemon v1 authority cleanup before preserved-root deletion')
  }
  const final = namespace.receipt
  if (!final) {
    if (namespace.pendingState || namespace.writingState
      || namespace.ownerStageAuthorityMarker || namespace.ownerStageNamespaceId) {
      throw new Error('purge receipt publication has no published preserved-root locator')
    }
    return null
  }
  if (final.state !== 'inactive' && final.state !== 'purging') {
    throw new Error('purge requires an inactive or purging preserved root receipt')
  }
  const candidates = [namespace.pendingReceipt, namespace.writingReceipt].filter(Boolean) as LifecycleRootReceiptV1[]
  if (candidates.some((candidate) => candidate.state !== 'purging')) {
    throw new Error('purge receipt publication contains a non-terminal target; setup publication recovery is required')
  }
  const target = candidates[0] || final
  if (candidates.some((candidate) => !sameLifecycleRootReceipt(candidate, target))) {
    throw new Error('purge receipt publication contains conflicting terminal targets')
  }
  if (target.state === 'purging') {
    if (!sameLifecycleRootReceiptNamespace(final, target, host)) {
      throw new Error('purging receipt publication crosses the preserved root namespace')
    }
    if (final.state === 'inactive'
      && target.priorInactiveReceiptSha256 !== sha256Bytes(recordBytes(final))) {
      throw new Error('purging receipt publication does not bind the published inactive receipt')
    }
    if (final.state === 'purging' && !sameLifecycleRootReceipt(final, target)) {
      throw new Error('purging receipt publication conflicts with the published terminal handoff')
    }
  }
  const partialWriter = Boolean(namespace.writingState && !namespace.writingReceipt)
  if (namespace.pendingState && namespace.writingState) {
    const pendingStat = namespace.pendingState.stat
    const writingStat = namespace.writingState.stat
    if (!namespace.pendingReceipt || !namespace.writingReceipt
      || !pendingStat || !writingStat || pendingStat.nlink !== 2 || writingStat.nlink !== 2
      || pendingStat.dev !== writingStat.dev || pendingStat.ino !== writingStat.ino
      || !sameLifecycleRootReceipt(namespace.pendingReceipt, namespace.writingReceipt)) {
      throw new Error('purge receipt publication contains unrelated pending and writer artifacts')
    }
  }
  if (final.state === 'purging' && namespace.writingState) {
    throw new Error('published purging receipt contains an unexpected writer')
  }
  if (final.state === 'purging' && namespace.pendingState) {
    const finalStat = namespace.receiptState?.stat
    const pendingStat = namespace.pendingState.stat
    if (!finalStat || !pendingStat || finalStat.nlink !== 2 || pendingStat.nlink !== 2
      || finalStat.dev !== pendingStat.dev || finalStat.ino !== pendingStat.ino
      || !sameLifecycleRootReceipt(namespace.pendingReceipt, final)) {
      throw new Error('published purging receipt contains a foreign pending transition')
    }
  }
  return {
    namespace,
    final,
    target: partialWriter && target.state === 'inactive' ? null : target,
    partialWriter,
    hasTransitionArtifacts: Boolean(namespace.pendingState || namespace.writingState)
  }
}

function purgePlanFromPurgingReceipt(receipt: LifecycleRootReceiptV1): PurgePlanV1 {
  if (receipt.state !== 'purging') throw new Error('purge plan handoff requires a purging receipt')
  return {
    schemaVersion: 1,
    action: 'purge',
    dataRootId: receipt.dataRootId,
    treeSha256: receipt.treeSha256,
    entries: receipt.entries,
    bytes: receipt.bytes,
    planHash: receipt.planHash
  }
}

function removePartialPurgeWalStage(
  paths: InstallPaths,
  receipt: LifecycleRootReceiptV1,
  host: InstallHost,
  expected: PurgeAuthoritySnapshot
): PurgeAuthoritySnapshot {
  const stage = expected.stageNamespace.purgeStage
  if (!expected.stagePartial || !stage || stage.state.stat?.nlink !== 1) return expected
  assertPurgeAuthoritySnapshot(paths, receipt, host, expected, 'partial purge WAL stage')
  assertCapturedFileState(stage.file, stage.state, 'partial purge WAL stage', PURGE_WAL_MAX_BYTES)
  fs.unlinkSync(stage.file)
  flushDirectory(expected.stageNamespace.directory)
  const after = readPurgeAuthoritySnapshot(paths, receipt, host)
  if (after.stageNamespace.purgeStage) throw new Error('partial purge WAL stage cleanup failed')
  return after
}

function writePurgeWal(
  paths: InstallPaths,
  receipt: LifecycleRootReceiptV1,
  host: InstallHost,
  wal: PurgeWalV1,
  expected: PurgeWalV1 | null
): PurgeWalV1 {
  const canonical = validatePurgeWal(JSON.parse(recordBytes(wal).toString('utf8')), paths, receipt, host)
  if (expected) assertPurgeWalTransition(expected, canonical)
  const bytes = recordBytes(canonical)
  if (bytes.length > PURGE_WAL_MAX_BYTES) throw new Error('purge WAL exceeds its serialized safety bound')
  let authority = readPurgeAuthoritySnapshot(paths, receipt, host)
  if (canonicalJson(authority.final) === canonicalJson(canonical)
    && canonicalJson(authority.stage) === canonicalJson(canonical)
    && authority.finalState.stat?.nlink === 2
    && authority.stageNamespace.purgeStage?.state.stat?.nlink === 2) {
    assertCapturedFileState(
      authority.stageNamespace.purgeStage.file,
      authority.stageNamespace.purgeStage.state,
      'purge WAL linked-stage recovery',
      PURGE_WAL_MAX_BYTES
    )
    fs.unlinkSync(authority.stageNamespace.purgeStage.file)
    flushDirectory(authority.stageNamespace.directory)
    authority = readPurgeAuthoritySnapshot(paths, receipt, host)
  }
  if (canonicalJson(authority.final) === canonicalJson(canonical) && !authority.stageNamespace.purgeStage) {
    flushDirectory(dirname(purgeWalPath(paths.dataRoot)))
    const durable = readPurgeAuthoritySnapshot(paths, receipt, host)
    if (canonicalJson(durable.final) !== canonicalJson(canonical)) throw new Error('purge WAL durability proof failed')
    return durable.final!
  }
  if (canonicalJson(authority.final) !== canonicalJson(expected)) {
    throw new Error('purge WAL target contains unexpected concurrent bytes')
  }
  if (!authority.stageNamespace.directoryState || !authority.stageNamespace.markerState
    || !authority.stageNamespace.namespaceId) {
    throw new Error('purge WAL has no durable owner-stage namespace')
  }
  if (authority.stagePartial) authority = removePartialPurgeWalStage(paths, receipt, host, authority)
  let staged = authority.stageNamespace.purgeStage
  if (staged && canonicalJson(authority.stage) !== canonicalJson(canonical)) {
    throw new Error('purge WAL has a different complete staged transition')
  }
  const stagePath = join(
    authority.stageNamespace.directory,
    `.purge-wal-v1.${canonical.purgeId}.${canonical.lockToken}.stage`
  )
  if (staged && !samePath(staged.file, stagePath, host.platform)) {
    throw new Error('purge WAL stage is bound to another operation')
  }
  const stageFence = captureDirectoryFence(authority.stageNamespace.directory)
  const finalParent = dirname(purgeWalPath(paths.dataRoot))
  const finalFence = captureDirectoryFence(finalParent)
  if (!staged) {
    assertDirectoryFence(authority.stageNamespace.directory, stageFence)
    if (lstatOptional(stagePath)) throw new Error('purge WAL stage appeared before exclusive creation')
    const descriptor = fs.openSync(stagePath, 'wx')
    try {
      fs.writeFileSync(descriptor, bytes)
      fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
    flushDirectory(authority.stageNamespace.directory)
    staged = readPurgeAuthoritySnapshot(paths, receipt, host).stageNamespace.purgeStage
    if (!staged || !samePath(staged.file, stagePath, host.platform)
      || !sameOptionalBuffer(staged.state.bytes, bytes) || staged.state.stat?.nlink !== 1) {
      throw new Error('purge WAL stage failed its durable exact readback')
    }
  }
  let beforePublish = readPurgeAuthoritySnapshot(paths, receipt, host)
  if (canonicalJson(beforePublish.final) !== canonicalJson(expected)
    || canonicalJson(beforePublish.stage) !== canonicalJson(canonical)
    || beforePublish.stagePartial) {
    throw new Error('purge WAL publication authority changed before mutation')
  }
  const finalPath = purgeWalPath(paths.dataRoot)
  assertDirectoryFence(authority.stageNamespace.directory, stageFence)
  assertDirectoryFence(finalParent, finalFence)
  assertCapturedFileState(stagePath, beforePublish.stageNamespace.purgeStage!.state, 'purge WAL publication stage', PURGE_WAL_MAX_BYTES)
  assertCapturedFileState(finalPath, beforePublish.finalState, 'purge WAL publication target', PURGE_WAL_MAX_BYTES)
  if (!expected) {
    fs.linkSync(stagePath, finalPath)
    flushDirectory(finalParent)
    const linked = readPurgeAuthoritySnapshot(paths, receipt, host)
    if (!linked.final || !linked.stage || linked.finalState.stat?.nlink !== 2
      || linked.stageNamespace.purgeStage?.state.stat?.nlink !== 2
      || canonicalJson(linked.final) !== canonicalJson(canonical)
      || canonicalJson(linked.stage) !== canonicalJson(canonical)) {
      throw new Error('purge WAL no-replace publication did not form an exact internal link pair')
    }
    assertCapturedFileState(stagePath, linked.stageNamespace.purgeStage!.state, 'purge WAL linked stage', PURGE_WAL_MAX_BYTES)
    fs.unlinkSync(stagePath)
    flushDirectory(authority.stageNamespace.directory)
  } else {
    fs.renameSync(stagePath, finalPath)
    flushDirectory(authority.stageNamespace.directory)
    if (!samePath(authority.stageNamespace.directory, finalParent, host.platform)) flushDirectory(finalParent)
  }
  const durable = readPurgeAuthoritySnapshot(paths, receipt, host)
  if (durable.stageNamespace.purgeStage || durable.finalState.stat?.nlink !== 1
    || canonicalJson(durable.final) !== canonicalJson(canonical)
    || !sameOptionalBuffer(durable.finalState.bytes, bytes)) {
    throw new Error('purge WAL publication failed its terminal exact readback')
  }
  return durable.final!
}

function removePurgeWalExact(
  paths: InstallPaths,
  receipt: LifecycleRootReceiptV1,
  host: InstallHost,
  expected: PurgeWalV1
): void {
  const snapshot = readPurgeAuthoritySnapshot(paths, receipt, host)
  if (snapshot.stageNamespace.purgeStage) throw new Error('purge WAL removal found a pending staged transition')
  if (!snapshot.final) {
    flushDirectory(dirname(purgeWalPath(paths.dataRoot)))
    if (readPurgeAuthoritySnapshot(paths, receipt, host).final) throw new Error('purge WAL reappeared during removal proof')
    return
  }
  if (canonicalJson(snapshot.final) !== canonicalJson(expected)) throw new Error('purge WAL changed before exact removal')
  assertCapturedFileState(purgeWalPath(paths.dataRoot), snapshot.finalState, 'purge WAL exact removal', PURGE_WAL_MAX_BYTES)
  fs.unlinkSync(purgeWalPath(paths.dataRoot))
  flushDirectory(dirname(purgeWalPath(paths.dataRoot)))
  const after = readPurgeAuthoritySnapshot(paths, receipt, host)
  if (after.final || after.stageNamespace.purgeStage) throw new Error('purge WAL removal failed its exact absence seal')
}

function removeLifecycleOwnerStageNamespaceAuthority(
  paths: InstallPaths,
  receipt: LifecycleRootReceiptV1,
  host: InstallHost
): void {
  assertLifecycleRootReceiptCurrentExact(host, receipt)
  const initialReceiptNamespace = readLifecycleRootReceiptNamespace(host)
  if (initialReceiptNamespace.daemonStageAuthorityMarker || initialReceiptNamespace.daemonStageNamespaceId
    || lstatOptional(`${resolve(paths.dataRoot)}.daemon-instance-stages`)) {
    throw new Error('terminal purge refuses daemon v1 authority or stage residue')
  }
  let namespace = readLifecycleOwnerStageNamespace(paths, host)
  const parent = dirname(namespace.directory)
  const parentFence = captureDirectoryFence(parent)
  if (namespace.reservations.length > 0 || namespace.purgeStage) {
    throw new Error('terminal purge found an active lifecycle owner-stage artifact')
  }
  if (namespace.directoryState) {
    assertDirectoryFence(parent, parentFence)
    if (namespace.marker && namespace.markerState) {
      assertCapturedFileState(namespace.marker, namespace.markerState, 'terminal owner-stage namespace marker', 0)
      fs.unlinkSync(namespace.marker)
      flushDirectory(namespace.directory)
      namespace = readLifecycleOwnerStageNamespace(paths, host)
    }
    if (!namespace.directoryState || namespace.directoryState.entries.length !== 0) {
      throw new Error('terminal owner-stage namespace is not exactly empty')
    }
    assertPlainDirectoryState(namespace.directory, namespace.directoryState, 'terminal empty owner-stage namespace')
    fs.rmdirSync(namespace.directory)
    flushDirectory(parent)
    assertDirectoryFence(parent, parentFence)
    if (lstatOptional(namespace.directory)) throw new Error('terminal owner-stage namespace removal failed')
  } else {
    flushDirectory(parent)
    if (lstatOptional(namespace.directory)) throw new Error('terminal owner-stage namespace reappeared')
  }

  const receiptNamespace = readLifecycleRootReceiptNamespace(host)
  if (!sameLifecycleRootReceipt(receiptNamespace.receipt, receipt)) {
    throw new Error('root receipt changed before terminal owner-stage authority removal')
  }
  if (receiptNamespace.ownerStageAuthorityMarker && receiptNamespace.ownerStageAuthorityMarkerState) {
    assertCapturedFileState(
      receiptNamespace.ownerStageAuthorityMarker,
      receiptNamespace.ownerStageAuthorityMarkerState,
      'terminal HOME owner-stage authority marker',
      0
    )
    fs.unlinkSync(receiptNamespace.ownerStageAuthorityMarker)
    flushDirectory(receiptNamespace.directory)
  } else {
    flushDirectory(receiptNamespace.directory)
  }
  const terminal = readLifecycleRootReceiptNamespace(host)
  if (!sameLifecycleRootReceipt(terminal.receipt, receipt)
    || terminal.ownerStageAuthorityMarker || terminal.ownerStageNamespaceId
    || terminal.daemonStageAuthorityMarker || terminal.daemonStageNamespaceId) {
    throw new Error('terminal owner-stage HOME authority removal failed its seal')
  }
}

function frozenDeleteQuarantine(root: string): string {
  return `${resolve(root)}.deleting`
}

function frozenDeleteSlotPrefix(relativePath: string): string {
  return `${sha256Bytes(Buffer.from(relativePath, 'utf8')).slice('sha256:'.length)}.`
}

type FrozenDeletePathFact = {
  absolute: string
  stat: { dev: number; ino: number; size: number; mtimeMs: number; nlink: number }
}

type FrozenDeleteMetadata = {
  root: FrozenDeletePathFact
  directories: ReadonlyMap<string, FrozenDeletePathFact>
  liveFiles: ReadonlyMap<string, FrozenDeletePathFact>
  quarantine: FrozenDeletePathFact | null
  slots: ReadonlyMap<string, FrozenDeletePathFact>
}

function frozenDeletePathFact(absolute: string, stat: fs.Stats): FrozenDeletePathFact {
  return {
    absolute,
    stat: { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, nlink: stat.nlink }
  }
}

function assertFrozenDeletePathFact(expected: FrozenDeletePathFact, label: string): void {
  const current = fs.lstatSync(expected.absolute)
  if (current.isSymbolicLink()
    || current.dev !== expected.stat.dev || current.ino !== expected.stat.ino
    || current.size !== expected.stat.size || current.mtimeMs !== expected.stat.mtimeMs
    || current.nlink !== expected.stat.nlink) {
    throw new Error(`${label} changed after its initial metadata freeze`)
  }
}

function captureFrozenDeleteMetadata(
  root: string,
  frozen: readonly PlainTreeEntry[],
  expectedHashes: ReadonlyMap<string, Sha256Digest>
): FrozenDeleteMetadata {
  const absoluteRoot = resolve(root)
  const rootStat = fs.lstatSync(absoluteRoot)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('frozen lifecycle root is not a plain directory during metadata freeze')
  }
  const expected = new Map(frozen.map((entry) => [entry.path, entry]))
  const directories = new Map<string, FrozenDeletePathFact>()
  const liveFiles = new Map<string, FrozenDeletePathFact>()
  let observed = 0
  const visit = (directory: string, prefix: string) => {
    const entries = boundedDirectoryEntries(directory, frozen.length - observed, 'frozen lifecycle metadata inventory')
      .sort((left, right) => compareUtf8Path(left.name, right.name))
    for (const item of entries) {
      if (++observed > frozen.length) throw new Error('frozen lifecycle metadata inventory exceeds its manifest')
      const absolute = join(directory, item.name)
      const relative = prefix ? `${prefix}/${item.name}` : item.name
      const stat = fs.lstatSync(absolute)
      if (stat.isSymbolicLink()) throw new Error(`frozen lifecycle metadata contains a reparse entry: ${relative}`)
      if (stat.isDirectory()) {
        const path = `${relative}/`
        if (expected.get(path)?.kind !== 'directory') throw new Error(`frozen lifecycle metadata contains an unknown directory: ${path}`)
        directories.set(path, frozenDeletePathFact(absolute, stat))
        visit(absolute, relative)
      } else if (stat.isFile()) {
        const expectedEntry = expected.get(relative)
        if (expectedEntry?.kind !== 'file' || !expectedHashes.has(relative)
          || stat.nlink !== 1 || stat.size !== expectedEntry.size) {
          throw new Error(`frozen lifecycle metadata contains an unknown or changed file: ${relative}`)
        }
        liveFiles.set(relative, frozenDeletePathFact(absolute, stat))
      } else {
        throw new Error(`frozen lifecycle metadata contains an unsupported entry: ${relative}`)
      }
    }
  }
  visit(absoluteRoot, '')

  const quarantinePath = frozenDeleteQuarantine(absoluteRoot)
  let quarantine: FrozenDeletePathFact | null = null
  const slots = new Map<string, FrozenDeletePathFact>()
  const quarantineStat = lstatOptional(quarantinePath)
  if (quarantineStat) {
    if (!quarantineStat.isDirectory() || quarantineStat.isSymbolicLink()) {
      throw new Error('frozen lifecycle delete quarantine is not a plain directory during metadata freeze')
    }
    quarantine = frozenDeletePathFact(quarantinePath, quarantineStat)
    const byPrefix = new Map<string, string>()
    for (const relativePath of expectedHashes.keys()) byPrefix.set(frozenDeleteSlotPrefix(relativePath), relativePath)
    for (const item of boundedDirectoryEntries(quarantinePath, expectedHashes.size, 'frozen delete metadata quarantine')) {
      const match = /^([0-9a-f]{64})\.([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.leaf$/.exec(item.name)
      const relativePath = match ? byPrefix.get(`${match[1]}.`) : undefined
      const absolute = join(quarantinePath, item.name)
      const stat = fs.lstatSync(absolute)
      const expectedEntry = relativePath ? expected.get(relativePath) : null
      if (!relativePath || slots.has(relativePath) || liveFiles.has(relativePath)
        || expectedEntry?.kind !== 'file' || !stat.isFile() || stat.isSymbolicLink()
        || stat.nlink !== 1 || stat.size !== expectedEntry.size) {
        throw new Error('frozen delete metadata quarantine contains a foreign or duplicate slot')
      }
      slots.set(relativePath, frozenDeletePathFact(absolute, stat))
    }
  }
  return { root: frozenDeletePathFact(absoluteRoot, rootStat), directories, liveFiles, quarantine, slots }
}

function assertFrozenDeleteMetadataCurrent(
  expected: FrozenDeleteMetadata,
  current: FrozenDeleteState
): void {
  assertFrozenDeletePathFact(expected.root, 'frozen lifecycle root')
  if (expected.directories.size !== current.directories.length
    || expected.liveFiles.size !== current.liveFiles.size
    || expected.slots.size !== current.slots.size) {
    throw new Error('frozen lifecycle inventory changed after its initial metadata freeze')
  }
  for (const [path, fact] of expected.directories) {
    if (!current.directories.some((entry) => entry.path === path)) throw new Error(`frozen lifecycle directory disappeared: ${path}`)
    assertFrozenDeletePathFact(fact, `frozen lifecycle directory ${path}`)
  }
  for (const [path, fact] of expected.liveFiles) {
    const observed = current.liveFiles.get(path)
    if (!observed || canonicalJson(observed.capture.stat) !== canonicalJson(fact.stat)) {
      throw new Error(`frozen lifecycle leaf changed after its initial metadata freeze: ${path}`)
    }
  }
  if (Boolean(expected.quarantine) !== Boolean(lstatOptional(current.quarantine))) {
    throw new Error('frozen lifecycle quarantine changed after its initial metadata freeze')
  }
  if (expected.quarantine) assertFrozenDeletePathFact(expected.quarantine, 'frozen lifecycle delete quarantine')
  for (const [path, fact] of expected.slots) {
    const observed = current.slots.get(path)
    if (!observed || canonicalJson(observed.capture.stat) !== canonicalJson(fact.stat)) {
      throw new Error(`frozen lifecycle delete slot changed after its initial metadata freeze: ${path}`)
    }
  }
}

function assertFrozenDeleteMetadataSnapshotCurrent(
  root: string,
  frozen: readonly PlainTreeEntry[],
  expectedHashes: ReadonlyMap<string, Sha256Digest>,
  expected: FrozenDeleteMetadata
): void {
  const current = captureFrozenDeleteMetadata(root, frozen, expectedHashes)
  const sameFact = (left: FrozenDeletePathFact | null, right: FrozenDeletePathFact | null) =>
    canonicalJson(left) === canonicalJson(right)
  const sameFacts = (
    left: ReadonlyMap<string, FrozenDeletePathFact>,
    right: ReadonlyMap<string, FrozenDeletePathFact>
  ) => left.size === right.size && [...left].every(([key, fact]) => sameFact(fact, right.get(key) || null))
  if (!sameFact(current.root, expected.root)
    || !sameFact(current.quarantine, expected.quarantine)
    || !sameFacts(current.directories, expected.directories)
    || !sameFacts(current.liveFiles, expected.liveFiles)
    || !sameFacts(current.slots, expected.slots)) {
    throw new Error('frozen lifecycle delete state changed after its pre-gate metadata freeze')
  }
}

function assertFrozenDeleteDirectoriesCurrent(
  expected: FrozenDeleteMetadata,
  current: FrozenDeleteState
): void {
  if (expected.directories.size !== current.directories.length) {
    throw new Error('frozen lifecycle directory inventory changed after deletion awaits')
  }
  for (const [path, fact] of expected.directories) {
    if (!current.directories.some((entry) => entry.path === path)) {
      throw new Error(`frozen lifecycle directory disappeared after deletion awaits: ${path}`)
    }
    const stat = fs.lstatSync(fact.absolute)
    // Removing captured children legitimately changes directory size, mtime,
    // and link count.  The stable deletion authority is the original plain
    // directory inode (also present in `directoryFence`), not mutable metadata.
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || stat.dev !== fact.stat.dev || stat.ino !== fact.stat.ino) {
      throw new Error(`frozen lifecycle directory inode changed after deletion awaits: ${path}`)
    }
  }
}

type FrozenDeleteState = {
  quarantine: string
  directories: readonly { path: string; absolute: string }[]
  liveFiles: ReadonlyMap<string, { path: string; absolute: string; capture: CapturedHashedFileState }>
  slots: ReadonlyMap<string, { path: string; absolute: string; capture: CapturedHashedFileState }>
}

function captureDirectoryFence(directory: string, fence: DirectoryFence = new Map()): DirectoryFence {
  let cursor = resolve(directory)
  for (;;) {
    const stat = fs.lstatSync(cursor)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`lifecycle mutation ancestor is not a plain directory: ${cursor}`)
    }
    const prior = fence.get(cursor)
    if (prior && (prior.dev !== stat.dev || prior.ino !== stat.ino)) {
      throw new Error(`lifecycle mutation ancestor changed while fencing: ${cursor}`)
    }
    fence.set(cursor, { dev: stat.dev, ino: stat.ino })
    const parent = dirname(cursor)
    if (samePath(parent, cursor, process.platform)) break
    cursor = parent
  }
  return fence
}

function assertDirectoryFence(directory: string, fence: DirectoryFence): void {
  let cursor = resolve(directory)
  for (;;) {
    const expected = fence.get(cursor)
    if (expected) {
      const stat = fs.lstatSync(cursor)
      if (!stat.isDirectory() || stat.isSymbolicLink()
        || stat.dev !== expected.dev || stat.ino !== expected.ino) {
        throw new Error(`lifecycle mutation ancestor changed after an asynchronous checkpoint: ${cursor}`)
      }
    }
    const parent = dirname(cursor)
    if (samePath(parent, cursor, process.platform)) break
    cursor = parent
  }
}

function inspectFrozenDeleteState(
  root: string,
  frozen: readonly PlainTreeEntry[],
  expectedHashes: ReadonlyMap<string, Sha256Digest>,
  allowPartial: boolean
): FrozenDeleteState {
  const absoluteRoot = resolve(root)
  const current = walkPlainTree(absoluteRoot, {
    maxEntries: frozen.length,
    maxBytes: frozen.reduce((total, entry) => total + entry.size, 0),
    label: 'frozen lifecycle tombstone'
  })
  if (!allowPartial && canonicalPlainTree(current) !== canonicalPlainTree(frozen)) {
    throw new Error('frozen lifecycle tombstone changed before deletion')
  }
  const expectedDirectories = new Set(frozen.filter((entry) => entry.kind === 'directory').map((entry) => entry.path))
  const expectedSizes = new Map(frozen.filter((entry) => entry.kind === 'file').map((entry) => [entry.path, entry.size]))
  const currentFiles = new Set<string>()
  const liveFiles = new Map<string, { path: string; absolute: string; capture: CapturedHashedFileState }>()
  for (const entry of current) {
    if (entry.kind === 'directory') {
      if (!expectedDirectories.has(entry.path)) {
        throw new Error(`frozen lifecycle tombstone contains an unknown directory: ${entry.path}`)
      }
      continue
    }
    const expected = expectedHashes.get(entry.path)
    if (!expected || entry.sha256 !== expected) {
      throw new Error(`frozen lifecycle tombstone contains foreign or changed bytes: ${entry.path}`)
    }
    currentFiles.add(entry.path)
    const capture = captureHashedFileState(entry.absolute, entry.size, 'frozen lifecycle live leaf')
    if (capture.sha256 !== expected) throw new Error(`frozen lifecycle tombstone changed during capture: ${entry.path}`)
    liveFiles.set(entry.path, { path: entry.path, absolute: entry.absolute, capture })
  }

  const quarantine = frozenDeleteQuarantine(absoluteRoot)
  const slots = new Map<string, { path: string; absolute: string; capture: CapturedHashedFileState }>()
  if (fs.existsSync(quarantine)) {
    assertPlainDirectory(quarantine, 'frozen lifecycle delete quarantine')
    const byPrefix = new Map<string, string>()
    for (const relativePath of expectedHashes.keys()) {
      const prefix = frozenDeleteSlotPrefix(relativePath)
      if (byPrefix.has(prefix)) throw new Error('frozen lifecycle delete-slot identity collision')
      byPrefix.set(prefix, relativePath)
    }
    for (const item of boundedDirectoryEntries(quarantine, expectedHashes.size, 'frozen delete quarantine')
      .sort((left, right) => compareUtf8Path(left.name, right.name))) {
      const name = item.name
      const absolute = join(quarantine, name)
      assertPlainFile(absolute, 'frozen lifecycle delete slot')
      const match = /^([0-9a-f]{64})\.([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.leaf$/.exec(name)
      const relativePath = match ? byPrefix.get(`${match[1]}.`) : undefined
      if (!relativePath || slots.has(relativePath) || currentFiles.has(relativePath)) {
        throw new Error('frozen lifecycle delete quarantine contains foreign or duplicate bytes')
      }
      const expectedSize = expectedSizes.get(relativePath)
      if (expectedSize === undefined) throw new Error('frozen lifecycle delete slot has no recorded size')
      const captured = captureHashedFileState(absolute, expectedSize, 'frozen lifecycle delete slot')
      if (captured.stat.size !== expectedSize || captured.sha256 !== expectedHashes.get(relativePath)) {
        throw new Error(`frozen lifecycle delete slot contains changed bytes: ${relativePath}`)
      }
      slots.set(relativePath, { path: relativePath, absolute, capture: captured })
    }
  }
  return {
    quarantine,
    directories: current.filter((entry) => entry.kind === 'directory')
      .map((entry) => ({ path: entry.path, absolute: entry.absolute })),
    liveFiles,
    slots
  }
}

async function inspectFrozenDeleteStateWithRevalidation(
  root: string,
  frozen: readonly PlainTreeEntry[],
  expectedHashes: ReadonlyMap<string, Sha256Digest>,
  allowPartial: boolean,
  revalidate: () => Promise<void>
): Promise<FrozenDeleteState> {
  const absoluteRoot = resolve(root)
  const current = await walkPlainTreeWithRevalidation(absoluteRoot, {
    maxEntries: frozen.length,
    maxBytes: frozen.reduce((total, entry) => total + entry.size, 0),
    label: 'frozen lifecycle tombstone'
  }, revalidate)
  if (!allowPartial && canonicalPlainTree(current) !== canonicalPlainTree(frozen)) {
    throw new Error('frozen lifecycle tombstone changed before deletion')
  }
  const expectedDirectories = new Set(frozen.filter((entry) => entry.kind === 'directory').map((entry) => entry.path))
  const expectedSizes = new Map(frozen.filter((entry) => entry.kind === 'file').map((entry) => [entry.path, entry.size]))
  const currentFiles = new Set<string>()
  const liveFiles = new Map<string, { path: string; absolute: string; capture: CapturedHashedFileState }>()
  for (const entry of current) {
    if (entry.kind === 'directory') {
      if (!expectedDirectories.has(entry.path)) {
        throw new Error(`frozen lifecycle tombstone contains an unknown directory: ${entry.path}`)
      }
      continue
    }
    const expected = expectedHashes.get(entry.path)
    if (!expected || entry.sha256 !== expected || !entry.capture) {
      throw new Error(`frozen lifecycle tombstone contains foreign or changed bytes: ${entry.path}`)
    }
    currentFiles.add(entry.path)
    liveFiles.set(entry.path, { path: entry.path, absolute: entry.absolute, capture: entry.capture })
  }

  const quarantine = frozenDeleteQuarantine(absoluteRoot)
  const slots = new Map<string, { path: string; absolute: string; capture: CapturedHashedFileState }>()
  if (fs.existsSync(quarantine)) {
    assertPlainDirectory(quarantine, 'frozen lifecycle delete quarantine')
    const byPrefix = new Map<string, string>()
    for (const relativePath of expectedHashes.keys()) {
      const prefix = frozenDeleteSlotPrefix(relativePath)
      if (byPrefix.has(prefix)) throw new Error('frozen lifecycle delete-slot identity collision')
      byPrefix.set(prefix, relativePath)
    }
    for (const item of boundedDirectoryEntries(quarantine, expectedHashes.size, 'frozen delete quarantine')
      .sort((left, right) => compareUtf8Path(left.name, right.name))) {
      const name = item.name
      const absolute = join(quarantine, name)
      assertPlainFile(absolute, 'frozen lifecycle delete slot')
      const match = /^([0-9a-f]{64})\.([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.leaf$/.exec(name)
      const relativePath = match ? byPrefix.get(`${match[1]}.`) : undefined
      if (!relativePath || slots.has(relativePath) || currentFiles.has(relativePath)) {
        throw new Error('frozen lifecycle delete quarantine contains foreign or duplicate bytes')
      }
      const expectedSize = expectedSizes.get(relativePath)
      if (expectedSize === undefined) throw new Error('frozen lifecycle delete slot has no recorded size')
      const capture = await captureHashedFileStateWithRevalidation(absolute, expectedSize, revalidate)
      if (capture.sha256 !== expectedHashes.get(relativePath)) {
        throw new Error(`frozen lifecycle delete slot contains changed bytes: ${relativePath}`)
      }
      slots.set(relativePath, { path: relativePath, absolute, capture })
    }
  }
  await revalidate()
  return {
    quarantine,
    directories: current.filter((entry) => entry.kind === 'directory')
      .map((entry) => ({ path: entry.path, absolute: entry.absolute })),
    liveFiles,
    slots
  }
}

async function removeFrozenTree(
  root: string,
  frozen: readonly PlainTreeEntry[],
  revalidate: () => Promise<void>,
  options: {
    allowPartial?: boolean
    expectedHashes?: ReadonlyMap<string, Sha256Digest>
    initialMetadata?: FrozenDeleteMetadata
  } = {}
): Promise<void> {
  const absoluteRoot = resolve(root)
  const expectedHashes = options.expectedHashes || new Map(
    frozen.filter((entry) => entry.kind === 'file').map((entry) => [entry.path, entry.sha256!])
  )
  const expectedSizes = new Map(
    frozen.filter((entry) => entry.kind === 'file').map((entry) => [entry.path, entry.size])
  )
  const mutationSeal = (revalidate as PurgeMutationRevalidator).seal || (() => {})
  const initialMetadata = options.initialMetadata
    || captureFrozenDeleteMetadata(absoluteRoot, frozen, expectedHashes)
  if (options.initialMetadata) {
    assertFrozenDeleteMetadataSnapshotCurrent(absoluteRoot, frozen, expectedHashes, initialMetadata)
  }
  const directoryFence = captureDirectoryFence(absoluteRoot)
  for (const entry of frozen.filter((candidate) => candidate.kind === 'directory')) {
    if (lstatOptional(entry.absolute)) captureDirectoryFence(entry.absolute, directoryFence)
  }
  const quarantine = frozenDeleteQuarantine(absoluteRoot)
  const quarantineAbsent: CapturedFileState = { bytes: null, stat: null }
  if (initialMetadata.quarantine) captureDirectoryFence(quarantine, directoryFence)
  let state = await inspectFrozenDeleteStateWithRevalidation(
    absoluteRoot,
    frozen,
    expectedHashes,
    options.allowPartial === true,
    revalidate
  )
  assertFrozenDeleteMetadataCurrent(initialMetadata, state)
  assertDirectoryFence(absoluteRoot, directoryFence)
  if (initialMetadata.quarantine) assertDirectoryFence(quarantine, directoryFence)
  const deleteSlot = async (
    relativePath: string,
    slot: string,
    expectedCapture: CapturedHashedFileState
  ) => {
    await revalidate()
    assertDirectoryFence(dirname(slot), directoryFence)
    const captured = await captureHashedFileStateWithRevalidation(
      slot,
      expectedSizes.get(relativePath) ?? 0,
      revalidate
    )
    if (captured.sha256 !== expectedHashes.get(relativePath)
      || canonicalJson(captured.stat) !== canonicalJson(expectedCapture.stat)) {
      throw new Error(`frozen lifecycle isolated delete slot changed before deletion: ${relativePath}`)
    }
    await revalidate()
    assertDirectoryFence(dirname(slot), directoryFence)
    assertCapturedHashedFileIdentity(slot, captured, 'frozen lifecycle isolated delete slot')
    mutationSeal()
    fs.unlinkSync(slot)
    flushDirectory(dirname(slot))
  }

  for (const slot of state.slots.values()) await deleteSlot(slot.path, slot.absolute, slot.capture)

  const currentFiles = [...state.liveFiles.values()]
  if (currentFiles.length > 0 && !fs.existsSync(state.quarantine)) {
    if (initialMetadata.quarantine) throw new Error('frozen lifecycle delete quarantine disappeared before reuse')
    await revalidate()
    assertDirectoryFence(dirname(state.quarantine), directoryFence)
    assertCapturedFileState(state.quarantine, quarantineAbsent, 'absent frozen delete quarantine', 0)
    mutationSeal()
    fs.mkdirSync(state.quarantine)
    flushDirectory(dirname(state.quarantine))
    assertPlainDirectory(state.quarantine, 'frozen lifecycle delete quarantine')
    captureDirectoryFence(state.quarantine, directoryFence)
  }
  for (const entry of currentFiles) {
    await revalidate()
    const source = entry.absolute
    assertDirectoryFence(dirname(source), directoryFence)
    assertDirectoryFence(state.quarantine, directoryFence)
    const captured = await captureHashedFileStateWithRevalidation(
      source,
      expectedSizes.get(entry.path) ?? 0,
      revalidate
    )
    if (captured.sha256 !== expectedHashes.get(entry.path)
      || canonicalJson(captured.stat) !== canonicalJson(entry.capture.stat)) {
      throw new Error(`frozen lifecycle leaf changed before isolation: ${entry.path}`)
    }
    await revalidate()
    assertDirectoryFence(dirname(source), directoryFence)
    assertDirectoryFence(state.quarantine, directoryFence)
    assertCapturedHashedFileIdentity(source, captured, 'frozen lifecycle leaf')
    const slot = join(state.quarantine, `${frozenDeleteSlotPrefix(entry.path)}${randomUUID()}.leaf`)
    if (fs.existsSync(slot)) throw new Error('frozen lifecycle delete slot unexpectedly exists')
    mutationSeal()
    fs.renameSync(source, slot)
    flushDirectory(dirname(source))
    if (!samePath(dirname(source), state.quarantine, process.platform)) flushDirectory(state.quarantine)
    assertCapturedHashedFileIdentity(slot, captured, 'frozen lifecycle newly isolated delete slot')
    try {
      await deleteSlot(entry.path, slot, captured)
    } catch (error) {
      // A changed slot is foreign evidence. Put it back only when the original
      // namespace is still empty; otherwise preserve both paths fail-closed.
      const sourceAbsent = captureFileState(source, expectedSizes.get(entry.path) ?? 0)
      if (fs.existsSync(slot) && !sourceAbsent.stat) {
        await revalidate()
        assertDirectoryFence(dirname(slot), directoryFence)
        assertDirectoryFence(dirname(source), directoryFence)
        assertCapturedHashedFileIdentity(slot, captured, 'frozen lifecycle isolated rollback slot')
        assertCapturedFileState(
          source,
          sourceAbsent,
          'absent frozen lifecycle rollback source',
          expectedSizes.get(entry.path) ?? 0
        )
        mutationSeal()
        fs.renameSync(slot, source)
        flushDirectory(dirname(slot))
        if (!samePath(dirname(slot), dirname(source), process.platform)) flushDirectory(dirname(source))
      }
      throw error
    }
  }

  if (fs.existsSync(state.quarantine)) {
    const emptyQuarantine = capturePlainDirectoryState(state.quarantine, 'empty frozen lifecycle delete quarantine')
    if (emptyQuarantine.entries.length !== 0) throw new Error('frozen lifecycle delete quarantine is not empty')
    await revalidate()
    assertDirectoryFence(state.quarantine, directoryFence)
    assertPlainDirectoryState(state.quarantine, emptyQuarantine, 'empty frozen lifecycle delete quarantine')
    mutationSeal()
    fs.rmdirSync(state.quarantine)
    flushDirectory(dirname(state.quarantine))
  }
  state = await inspectFrozenDeleteStateWithRevalidation(absoluteRoot, frozen, expectedHashes, true, revalidate)
  assertDirectoryFence(absoluteRoot, directoryFence)
  // Only directories captured before the first await belong to this deletion
  // call.  A manifest directory that was already absent in a partial recovery
  // may be recreated by a later writer while leaves are being isolated; never
  // adopt that new inode into the final rmdir pass.
  assertFrozenDeleteDirectoriesCurrent(initialMetadata, state)
  if (state.slots.size > 0) throw new Error('frozen lifecycle delete quarantine is not empty')
  if (state.liveFiles.size > 0) throw new Error('frozen lifecycle tombstone still contains live files')
  const directories = [...state.directories]
    .sort((left, right) => right.path.split('/').length - left.path.split('/').length)
  for (const entry of directories) {
    const emptyDirectory = capturePlainDirectoryState(entry.absolute, 'empty frozen lifecycle directory')
    if (emptyDirectory.entries.length !== 0) throw new Error(`frozen lifecycle directory is not empty: ${entry.path}`)
    await revalidate()
    assertDirectoryFence(entry.absolute, directoryFence)
    assertPlainDirectoryState(entry.absolute, emptyDirectory, 'empty frozen lifecycle directory')
    mutationSeal()
    fs.rmdirSync(entry.absolute)
    flushDirectory(dirname(entry.absolute))
  }
  if (fs.existsSync(absoluteRoot)) {
    const emptyRoot = capturePlainDirectoryState(absoluteRoot, 'empty frozen lifecycle root')
    if (emptyRoot.entries.length !== 0) throw new Error('frozen lifecycle root is not empty')
    await revalidate()
    assertDirectoryFence(absoluteRoot, directoryFence)
    assertPlainDirectoryState(absoluteRoot, emptyRoot, 'empty frozen lifecycle root')
    mutationSeal()
    fs.rmdirSync(absoluteRoot)
    flushDirectory(dirname(absoluteRoot))
  }
}

function assertManagedInstallTree(
  paths: InstallPaths,
  manifest: InstallManifestV2 | null,
  platform: NodeJS.Platform | string = process.platform,
  allowMissingOwned = false
): void {
  const actualFiles = new Set<string>()
  let actualFileCount = 0
  const walPresent = lstatOptional(paths.lifecycleWalPath) !== null
  const install = lstatOptional(paths.installDir)
  if (install) {
    if (!install.isDirectory() || install.isSymbolicLink()) throw new Error('install directory must be a plain directory')
    const rootEntries = boundedDirectoryEntries(paths.installDir, 16, 'managed install root')
    for (const entry of rootEntries) {
      const absolute = join(paths.installDir, entry.name)
      if (entry.name === 'bin') {
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('managed install bin must be a plain directory')
        for (const child of boundedDirectoryEntries(absolute, 16, 'managed install bin')) {
          const childPath = join(absolute, child.name)
          if (!child.isFile() || child.isSymbolicLink()) {
            throw new Error(`install directory contains an unowned bin entry: bin/${child.name}`)
          }
          const recoverableStage = walPresent && isLifecycleStageName(child.name)
          if (!recoverableStage && !MANAGED_INSTALL_BIN_FILES.has(child.name)) {
            throw new Error(`install directory contains an unowned file: bin/${child.name}`)
          }
          if (!recoverableStage) {
            actualFiles.add(resolve(childPath))
            actualFileCount += 1
          }
        }
        continue
      }
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(`install directory contains an unowned directory or entry: ${entry.name}`)
      }
      const recoverableStage = walPresent && isLifecycleStageName(entry.name)
      if (!recoverableStage && !MANAGED_INSTALL_ROOT_FILES.has(entry.name)) {
        throw new Error(`install directory contains an unowned file: ${entry.name}`)
      }
      if (!recoverableStage) {
        actualFiles.add(resolve(absolute))
        actualFileCount += 1
      }
    }
  }
  if (!manifest && actualFileCount > 0) {
    throw new Error('install directory contains lifecycle files without an ownership manifest')
  }
  if (manifest) {
    const allowedExternal = new Set([paths.extraShimCmd, paths.extraShimAliasCmd].filter(Boolean).map((file) => resolve(file as string)))
    const expectedInside = new Set([resolve(paths.manifestPath)])
    for (const owned of manifest.owned.files) {
      const file = resolve(owned.path)
      if (isSameOrInside(paths.installDir, file, platform)) expectedInside.add(file)
      else if (!allowedExternal.has(file)) throw new Error(`ownership manifest names an unsafe external file: ${file}`)
    }
    if ((!allowMissingOwned && actualFiles.size !== expectedInside.size)
      || [...actualFiles].some((file) => !expectedInside.has(file))) {
      throw new Error('install directory contents do not exactly match the ownership manifest')
    }
  }
}

function ownedFilesHealthy(
  manifest: InstallManifestV2,
  include: (entry: OwnedInstallFile) => boolean = () => true
): boolean {
  const unique = new Set<string>()
  for (const owned of manifest.owned.files) {
    if (!include(owned)) continue
    const absolute = resolve(owned.path)
    if (unique.has(absolute)) return false
    unique.add(absolute)
    if (!fs.existsSync(absolute)) return false
    try {
      if (sha256File(absolute) !== owned.sha256) return false
    } catch {
      return false
    }
  }
  return true
}

function inspectManifestIntegrationOwnership(
  paths: InstallPaths,
  manifest: InstallManifestV2,
  host: InstallHost,
  mode: 'strict' | 'uninstall' = 'strict'
): { owned: boolean; inspectionError?: string } {
  try {
    assertManagedInstallTree(paths, manifest, host.platform)
    if (!ownedFilesHealthy(manifest, mode === 'uninstall'
      ? (entry) => isSameOrInside(paths.installDir, entry.path, host.platform)
      : () => true)) return { owned: false }
    if (mode === 'uninstall') return { owned: true }
    const integrationSnapshot = (manifest.features.path || manifest.owned.task)
      && host.platform === 'win32'
      && host.integrationSnapshot
      && (!manifest.features.path || !host.skipPath)
      && (!manifest.owned.task || !host.skipTask)
      ? host.integrationSnapshot(
          manifest.features.path ? manifest.owned.environment.map((entry) => entry.name) : [],
          manifest.owned.task?.name || ''
        )
      : null
    if (manifest.features.path) {
      const currentPath = integrationSnapshot ? integrationSnapshot.userPath.value : host.userPath()
      if (!pathHasDir(currentPath, manifest.owned.pathEntry.value, host.pathSep, host.caseInsensitive)) return { owned: false }
      if (manifest.owned.pathEntry.added) {
        const first = currentPath.split(host.pathSep, 1)[0] || ''
        if (!samePath(first, manifest.owned.pathEntry.value, host.platform)) return { owned: false }
      }
      for (const entry of manifest.owned.environment) {
        const current = integrationSnapshot
          ? integrationSnapshot.environment[entry.name]
          : host.userEnvState(entry.name)
        if (!sameUserEnvironmentState(current, {
          exists: true,
          value: entry.value,
          kind: entry.kind
        })) return { owned: false }
      }
    }
    if (manifest.owned.task) {
      const taskExists = integrationSnapshot
        ? integrationSnapshot.task.exists
        : host.taskExists(manifest.owned.task.name)
      if (!taskExists) return { owned: false }
      const taskAction = integrationSnapshot
        ? integrationSnapshot.task.action
        : host.taskAction(manifest.owned.task.name)
      if (taskAction.toLowerCase() !== expectedTaskAction(manifest.owned.task.launcher).toLowerCase()) return { owned: false }
    }
    return { owned: true }
  } catch (error) {
    return {
      owned: false,
      inspectionError: error instanceof Error ? error.message : String(error)
    }
  }
}

function manifestIntegrationOwned(
  paths: InstallPaths,
  manifest: InstallManifestV2,
  host: InstallHost,
  mode: 'strict' | 'uninstall' = 'strict'
): boolean {
  return inspectManifestIntegrationOwnership(paths, manifest, host, mode).owned
}

function preflightExistingOwnership(
  paths: InstallPaths,
  host: InstallHost,
  intent: { path: boolean; task: boolean } = { path: true, task: true }
): InstallManifestV2 | null {
  const manifest = readInstallManifest(paths, host.platform)
  if (manifest) {
    const ownedPaths = pathsForManifest(manifest, paths, host)
    if (!manifestIntegrationOwned(ownedPaths, manifest, host)) {
      throw new Error('existing installation no longer matches its ownership manifest')
    }
  } else {
    assertManagedInstallTree(paths, null, host.platform)
    if (intent.path) {
      for (const candidate of [paths.extraShimCmd, paths.extraShimAliasCmd]) {
        if (candidate && fs.existsSync(candidate)) throw new Error(`refusing to overwrite foreign global shim: ${candidate}`)
      }
    }
    if (intent.task && host.platform === 'win32' && !host.skipTask && host.taskExists(paths.taskName)) {
      throw new Error(`refusing to overwrite foreign scheduled task ${paths.taskName}`)
    }
  }
  return manifest
}

function existingManifestPathsForUpgrade(
  candidatePaths: InstallPaths,
  host: InstallHost,
  environment: FrozenInstallEnvironment
): InstallPaths {
  const raw = readJsonRecord(candidatePaths.manifestPath)
  if (!raw || typeof raw.packageRoot !== 'string' || !isAbsolute(raw.packageRoot)) {
    throw new Error('upgrade requires a valid owned existing installation')
  }
  const existingPaths = resolveInstallPaths(pathApi, {
    hubRoot: raw.packageRoot,
    packageRoot: raw.packageRoot,
    dataRoot: String(raw.dataRoot || ''),
    nodePath: String(raw.nodePath || process.execPath),
    installDir: String(raw.installDir || ''),
    extraShimDir: raw.extraShimDir === null ? null : String(raw.extraShimDir || ''),
    taskName: String(raw.taskName || ''),
    port: Number(raw.port || 0)
  })
  if (!samePath(existingPaths.installDir, candidatePaths.installDir, host.platform)
    || !samePath(existingPaths.dataRoot, candidatePaths.dataRoot, host.platform)
    || existingPaths.taskName !== candidatePaths.taskName
    || existingPaths.port !== candidatePaths.port) {
    throw new Error('existing installation is bound to another lifecycle namespace')
  }
  return existingPaths
}

function preflightDataRoot(
  paths: InstallPaths,
  candidate: PackageIdentity,
  host: InstallHost,
  requireCandidateMatch = false
): DataRootMarkerV1 | null {
  if (fs.existsSync(paths.dataRoot)) assertPlainDirectory(paths.dataRoot, 'data root')
  const marker = readDataRootMarker(paths, host.platform)
  const sourceRoot = candidate.packageRoot
  const candidateFacts = new Map(candidate.publicRuntimeFacts.map((entry) => [entry.path, entry]))
  for (const relativePath of PUBLIC_RUNTIME_FILES) {
    const source = join(sourceRoot, ...relativePath.split('/'))
    const target = join(paths.dataRoot, ...relativePath.split('/'))
    assertPlainFile(source, `package public runtime ${relativePath}`)
    if (fs.existsSync(target)) {
      assertPlainFile(target, `data public runtime ${relativePath}`)
      if ((!marker || requireCandidateMatch) && sha256File(target) !== candidateFacts.get(relativePath)?.sha256) {
        throw new Error(`unowned data runtime differs from the package: ${relativePath}`)
      }
    }
  }
  if (marker) {
    const recorded = new Map(marker.runtime.files.map((entry) => [entry.path, entry]))
    if (recorded.size !== PUBLIC_RUNTIME_FILES.length) throw new Error('data-root runtime manifest is incomplete')
    for (const relativePath of PUBLIC_RUNTIME_FILES) {
      const entry = recorded.get(relativePath)
      const target = join(paths.dataRoot, ...relativePath.split('/'))
      if (!entry || !fs.existsSync(target) || sha256File(target) !== entry.sha256 || fs.statSync(target).size !== entry.size) {
        throw new Error(`data-root public runtime ownership mismatch: ${relativePath}`)
      }
    }
    if (requireCandidateMatch) {
      const expected = [...candidate.publicRuntimeFacts].sort((left, right) => left.path.localeCompare(right.path))
      const recordedFacts = [...marker.runtime.files].sort((left, right) => left.path.localeCompare(right.path))
      if (canonicalJson(recordedFacts) !== canonicalJson(expected)) {
        throw new Error('active data-root runtime is not bound to the installed package')
      }
    }
  }
  const layout = layoutSpec(paths.dataRoot, pathApi)
  for (const directory of layout.dirs) {
    if (fs.existsSync(directory)) assertPlainDirectory(directory, 'data layout directory')
  }
  for (const file of layout.files) {
    if (fs.existsSync(file.path)) assertPlainFile(file.path, 'data layout file')
  }
  return marker
}

type InstalledLifecycleAuthoritySnapshot = {
  directories: DirectoryFence
  manifest: CapturedFileState
  marker: CapturedFileState
}

function assertInstalledLifecycleAuthoritySnapshot(
  paths: InstallPaths,
  candidate: PackageIdentity,
  expectedManifest: InstallManifestV2,
  expectedMarker: DataRootMarkerV1,
  snapshot: InstalledLifecycleAuthoritySnapshot,
  host: InstallHost,
  label: string,
  integrationMode: 'strict' | 'uninstall' = 'strict'
): void {
  preflightLifecycleRoots(paths, host)
  for (const directory of [candidate.packageRoot, paths.dataRoot, paths.installDir]) {
    assertDirectoryFence(directory, snapshot.directories)
  }
  assertCapturedFileState(paths.manifestPath, snapshot.manifest, `${label} manifest`, MANIFEST_MAX_BYTES)
  assertCapturedFileState(paths.dataMarkerPath, snapshot.marker, `${label} data marker`, MARKER_MAX_BYTES)

  assertPackageIdentityCurrent(candidate, `${label} package`)
  const currentManifest = readInstallManifest(paths, host.platform, 'install-only')
  if (!currentManifest || canonicalJson(currentManifest) !== canonicalJson(expectedManifest)) {
    throw new Error(`${label} installation manifest changed while acquiring the lifecycle mutex`)
  }
  const currentMarker = preflightDataRoot(paths, candidate, host, true)
  if (!currentMarker || canonicalJson(currentMarker) !== canonicalJson(expectedMarker)) {
    throw new Error(`${label} data-root marker changed while acquiring the lifecycle mutex`)
  }
  if (!manifestIntegrationOwned(paths, expectedManifest, host, integrationMode)) {
    throw new Error(`${label} persistent integration changed while acquiring the lifecycle mutex`)
  }

  // Package hashing and provider inspection can be long. Recheck the frozen
  // physical roots and the two byte-authority files immediately before the
  // caller is allowed to publish or retire lifecycle protocol state.
  for (const directory of [candidate.packageRoot, paths.dataRoot, paths.installDir]) {
    assertDirectoryFence(directory, snapshot.directories)
  }
  assertCapturedFileState(paths.manifestPath, snapshot.manifest, `${label} manifest terminal seal`, MANIFEST_MAX_BYTES)
  assertCapturedFileState(paths.dataMarkerPath, snapshot.marker, `${label} data marker terminal seal`, MARKER_MAX_BYTES)
}

function captureInstalledLifecycleAuthoritySnapshot(
  paths: InstallPaths,
  candidate: PackageIdentity,
  expectedManifest: InstallManifestV2,
  expectedMarker: DataRootMarkerV1,
  host: InstallHost,
  label: string,
  integrationMode: 'strict' | 'uninstall' = 'strict'
): InstalledLifecycleAuthoritySnapshot {
  const directories = captureDirectoryFence(candidate.packageRoot)
  captureDirectoryFence(paths.dataRoot, directories)
  captureDirectoryFence(paths.installDir, directories)
  const snapshot: InstalledLifecycleAuthoritySnapshot = {
    directories,
    manifest: captureFileState(paths.manifestPath, MANIFEST_MAX_BYTES),
    marker: captureFileState(paths.dataMarkerPath, MARKER_MAX_BYTES)
  }
  if (!snapshot.manifest.stat || !snapshot.marker.stat) {
    throw new Error(`${label} authority files are missing before lifecycle mutex acquisition`)
  }
  assertInstalledLifecycleAuthoritySnapshot(
    paths,
    candidate,
    expectedManifest,
    expectedMarker,
    snapshot,
    host,
    label,
    integrationMode
  )
  return snapshot
}

function assertMarkerBindsPackage(marker: DataRootMarkerV1, packageRoot: string, label: string): void {
  const recorded = [...marker.runtime.files].sort((left, right) => left.path.localeCompare(right.path))
  const expected = publicRuntimeFacts(packageRoot).sort((left, right) => left.path.localeCompare(right.path))
  if (canonicalJson(recorded) !== canonicalJson(expected)) {
    throw new Error(`${label} data-root runtime is not bound to its package release`)
  }
}

function bootstrapDataRoot(
  paths: InstallPaths,
  candidate: PackageIdentity,
  priorMarker: DataRootMarkerV1 | null,
  replaceRuntime: boolean,
  activeInstallId: string | null,
  plannedMarker?: DataRootMarkerV1,
  expectedBefore?: ReadonlyMap<string, Buffer | null>,
  authority?: LifecycleWriteAuthority
): DataRootMarkerV1 {
  const spec = layoutSpec(paths.dataRoot, pathApi)
  for (const directory of spec.dirs) {
    if (authority) ensureLifecycleDirectory(directory, authority, directory)
    else fs.mkdirSync(directory, { recursive: true })
  }
  for (const file of spec.files) {
    if (!fs.existsSync(file.path)) {
      if (expectedBefore) writeFileFromAllowed(file.path, file.content, [expectedBefore.get(resolve(file.path)) ?? null], 'data layout bootstrap', authority)
      else atomicWrite(file.path, file.content, authority)
    }
  }
  for (const relativePath of PUBLIC_RUNTIME_FILES) {
      const target = join(paths.dataRoot, ...relativePath.split('/'))
      if (replaceRuntime || !fs.existsSync(target)) {
      const bytes = candidate.publicRuntime.get(relativePath) as Buffer
      if (expectedBefore) writeFileFromAllowed(target, bytes, [expectedBefore.get(resolve(target)) ?? null], `public runtime ${relativePath}`, authority)
      else atomicWrite(target, bytes, authority)
    }
  }
  const marker: DataRootMarkerV1 = plannedMarker || {
    schemaVersion: DATA_ROOT_MARKER_VERSION,
    dataRootId: priorMarker?.dataRootId || randomUUID(),
    activeInstallId,
    canonicalRoot: paths.dataRoot,
    createdAt: priorMarker?.createdAt || new Date().toISOString(),
    runtime: {
      schemaVersion: PUBLIC_RUNTIME_CORPUS_VERSION,
      files: [...candidate.publicRuntimeFacts]
    }
  }
  if (expectedBefore) {
    writeFileFromAllowed(
      paths.dataMarkerPath,
      recordBytes(marker),
      [expectedBefore.get(resolve(paths.dataMarkerPath)) ?? null],
      'data-root marker bootstrap',
      authority
    )
  } else atomicWrite(paths.dataMarkerPath, `${JSON.stringify(marker, null, 2)}\n`, authority)
  return marker
}

function privateCorpusEmpty(dataRoot: string): boolean {
  const skills = join(dataRoot, 'skills')
  const root = lstatOptional(skills)
  if (!root) return true
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('private Skill corpus root is not a plain directory')
  const directory = fs.opendirSync(skills)
  let seen = 0
  try {
    for (;;) {
      const entry = directory.readSync()
      if (!entry) return true
      seen += 1
      if (seen > 10_000) throw new Error('private Skill corpus inventory exceeds 10000 entries')
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === 'inbox' || entry.name === 'adopted') continue
      const skillFile = lstatOptional(join(skills, entry.name, 'SKILL.md'))
      if (skillFile?.isFile() && !skillFile.isSymbolicLink()) return false
    }
  } finally {
    directory.closeSync()
  }
}

function assertDirectoryEmptyBounded(directory: string, label: string): void {
  const handle = fs.opendirSync(directory)
  try {
    if (handle.readSync()) throw new Error(`${label} is not empty`)
  } finally {
    handle.closeSync()
  }
}

function plainPathHasKind(target: string, kind: 'file' | 'directory', boundary: string): boolean {
  try {
    if (!fs.existsSync(target)) return false
    let cursor = resolve(target)
    const root = resolve(boundary)
    for (;;) {
      const stat = fs.lstatSync(cursor)
      if (stat.isSymbolicLink()) return false
      if (samePath(cursor, resolve(target), process.platform)) {
        if (kind === 'file' ? !stat.isFile() : !stat.isDirectory()) return false
      } else if (!stat.isDirectory()) return false
      if (samePath(cursor, root, process.platform)) break
      if (!isSameOrInside(root, cursor, process.platform)) return false
      const parent = dirname(cursor)
      if (samePath(parent, cursor, process.platform)) return false
      cursor = parent
    }
    return true
  } catch {
    return false
  }
}

function daemonLauncherEnvironment(
  host: InstallHost,
  environment: FrozenInstallEnvironment,
  paths: Pick<InstallPaths, 'packageRoot' | 'nodePath'>
): DaemonLauncherEnvironment {
  const home = resolve(host.home || environment.USERPROFILE || environment.HOME || homedir())
  const authority = Object.freeze({
    HOME: home,
    USERPROFILE: home,
    ...(environment.APPDATA ? { APPDATA: resolve(environment.APPDATA) } : {}),
    ...(host.localAppData || environment.LOCALAPPDATA
      ? { LOCALAPPDATA: resolve(host.localAppData || environment.LOCALAPPDATA!) }
      : {}),
    ...(environment.TEMP ? { TEMP: resolve(environment.TEMP) } : {}),
    ...(environment.TMP ? { TMP: resolve(environment.TMP) } : {})
  })
  const runtime = resolveLocalCodexRuntime({
    packageRoot: paths.packageRoot,
    environment: Object.freeze({ ...environment, ...authority }),
    allowStandardPaths: true,
    fallbackNodeExecutable: paths.nodePath
  })
  const fixed = {
    HUB_CODEX_NODE: runtime.nodeExecutable,
    HUB_CODEX_MODULE: runtime.codexModule,
    HUB_CODEX_CREDENTIAL_HOME: runtime.credentialHome
  } as const
  for (const [name, value] of Object.entries(fixed)) {
    if (value && !isAbsolute(value)) throw new Error(`${name} must be absolute`)
  }
  return Object.freeze({
    ...authority,
    ...(fixed.HUB_CODEX_NODE ? { HUB_CODEX_NODE: fixed.HUB_CODEX_NODE } : {}),
    ...(fixed.HUB_CODEX_MODULE ? { HUB_CODEX_MODULE: fixed.HUB_CODEX_MODULE } : {}),
    ...(fixed.HUB_CODEX_CREDENTIAL_HOME
      ? { HUB_CODEX_CREDENTIAL_HOME: fixed.HUB_CODEX_CREDENTIAL_HOME }
      : {})
  })
}

function renderedArtifacts(
  paths: InstallPaths,
  tracePreflight: FrozenDaemonTracePreflight,
  includeExtraShims: boolean,
  host: InstallHost
): Map<string, string> {
  const rendered = renderShims(
    paths,
    tracePreflight.daemonTrace,
    daemonLauncherEnvironment(host, tracePreflight.baseEnvironment, paths)
  )
  const artifacts = new Map<string, string>([
    [paths.shimCmd, rendered.sgCmd],
    [paths.shimAliasCmd, rendered.aliasCmd],
    [paths.shimUnix, rendered.unix],
    [paths.silentVbs, rendered.vbs],
    [paths.runDaemonCmd, rendered.runDaemonCmd]
  ])
  if (includeExtraShims && paths.extraShimCmd) artifacts.set(paths.extraShimCmd, rendered.sgCmd)
  if (includeExtraShims && paths.extraShimAliasCmd) artifacts.set(paths.extraShimAliasCmd, rendered.aliasCmd)
  return artifacts
}

function writeArtifacts(
  artifacts: ReadonlyMap<string, string>,
  expectedBefore?: ReadonlyMap<string, Buffer | null>,
  authority?: LifecycleWriteAuthority
): void {
  for (const [file, content] of artifacts) {
    if (expectedBefore) writeFileFromAllowed(file, content, [expectedBefore.get(resolve(file)) ?? null], 'install artifact', authority)
    else atomicWrite(file, content, authority)
  }
  for (const file of artifacts.keys()) {
    if (basename(file) === PRODUCT_COMMAND && platformSupportsMode()) {
      if (authority) lifecycleChmodSync(file, 0o755, authority, file)
      else fs.chmodSync(file, 0o755)
    }
  }
}

function platformSupportsMode(): boolean {
  return process.platform !== 'win32'
}

function ownedArtifactFacts(artifacts: ReadonlyMap<string, string>): OwnedInstallFile[] {
  return [...artifacts.entries()]
    .map(([file, content]) => ({ path: resolve(file), sha256: sha256Bytes(content) }))
    .sort((left, right) => left.path.localeCompare(right.path))
}

function planEnvironmentOwnership(
  paths: InstallPaths,
  enabled: boolean,
  host: InstallHost
): OwnedEnvironmentValue[] {
  if (!enabled || host.platform !== 'win32') return []
  return ([
    [PRIMARY_DATA_ROOT_ENV, paths.dataRoot],
    [LEGACY_DATA_ROOT_ENV, paths.dataRoot],
    ['HUB_API_PORT', String(paths.port)]
  ] as const).map(([name, value]) => {
    const current = host.userEnvState(name)
    if (current.exists && current.value !== value) {
      throw new Error(`refusing to overwrite foreign user environment value ${name}`)
    }
    return {
      name,
      value,
      created: !current.exists,
      kind: current.exists ? current.kind! : 'ExpandString' as const
    }
  })
}

function planTaskOwnership(paths: InstallPaths, enabled: boolean, host: InstallHost): InstallManifestV2['owned']['task'] {
  if (!enabled || host.platform !== 'win32') return null
  if (!host.taskExists(paths.taskName)) {
    return { taskPath: '\\', name: paths.taskName, launcher: paths.silentVbs, created: true }
  }
  throw new Error(`refusing to adopt existing scheduled task ${paths.taskName}`)
}

function createInstallManifest(input: {
  paths: InstallPaths
  candidate: PackageIdentity
  marker: DataRootMarkerV1
  artifacts: ReadonlyMap<string, string>
  pathEnabled: boolean
  taskEnabled: boolean
  daemonEnabled: boolean
  pathAdded: boolean
  pathPrior: UserPathState | null
  environment: readonly OwnedEnvironmentValue[]
  task: InstallManifestV2['owned']['task']
  previous?: InstallManifestV2 | null
  installId?: string
  plannedAt?: string
}): InstallManifestV2 {
  const now = input.plannedAt || new Date().toISOString()
  return {
    schemaVersion: INSTALL_MANIFEST_VERSION,
    installId: input.previous?.installId || input.installId || randomUUID(),
    product: PRODUCT_NAME,
    command: PRODUCT_COMMAND,
    alias: PRODUCT_ALIAS,
    packageRoot: input.candidate.packageRoot,
    packageVersion: input.candidate.version,
    packageSha256: input.candidate.sha256,
    nodePath: input.paths.nodePath,
    dataRoot: input.paths.dataRoot,
    dataRootId: input.marker.dataRootId,
    installDir: input.paths.installDir,
    binDir: input.paths.binDir,
    extraShimDir: input.pathEnabled ? input.paths.extraShimDir : null,
    port: input.paths.port,
    taskName: input.paths.taskName,
    features: {
      path: input.pathEnabled,
      task: input.taskEnabled,
      daemon: input.daemonEnabled
    },
    owned: {
      files: ownedArtifactFacts(input.artifacts),
      pathEntry: { value: input.paths.binDir, added: input.pathAdded, prior: input.pathPrior },
      environment: [...input.environment],
      task: input.task
    },
    installedAt: input.previous?.installedAt || now,
    updatedAt: now
  }
}

function writeManifest(
  paths: InstallPaths,
  manifest: InstallManifestV2,
  allowed?: readonly (Buffer | null)[],
  authority?: LifecycleWriteAuthority
): void {
  if (allowed) writeFileFromAllowed(paths.manifestPath, recordBytes(manifest), allowed, 'install ownership manifest', authority)
  else atomicWrite(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, authority)
}

function snapshotIntegration(
  paths: InstallPaths,
  host: InstallHost,
  files: readonly string[],
  directories: readonly string[] = [],
  integration: { path: boolean; task: boolean } = { path: true, task: true }
): IntegrationSnapshot {
  const unique = [...new Set(files.filter(Boolean).map((file) => resolve(file)))]
  const directorySet = new Set(directories.map((directory) => resolve(directory)))
  for (const file of unique) {
    let cursor = dirname(file)
    while (isSameOrInside(paths.installDir, cursor, host.platform)
      || isSameOrInside(paths.dataRoot, cursor, host.platform)) {
      if (samePath(cursor, paths.installDir, host.platform) || samePath(cursor, paths.dataRoot, host.platform)) break
      directorySet.add(resolve(cursor))
      cursor = dirname(cursor)
    }
  }
  let snapshotBytes = 0
  const frozenFiles = new Map<string, Buffer | null>()
  for (const file of unique) {
    const bytes = currentFileBytes(file, 16 * 1024 * 1024)
    if (bytes) {
      snapshotBytes += bytes.length
      if (snapshotBytes > 256 * 1024 * 1024) throw new Error('lifecycle snapshot exceeds its total byte bound')
    }
    frozenFiles.set(file, bytes)
  }
  return {
    files: frozenFiles,
    directories: new Map([...directorySet].map((directory) => [directory, fs.existsSync(directory)])),
    userPath: integration.path ? host.userPathState() : unmanagedUserPathState(),
    pathManaged: integration.path,
    environment: new Map(LIFECYCLE_ENV_NAMES.map((name) => [
      name,
      integration.path ? host.userEnvState(name) : absentUserEnvironmentState()
    ])),
    taskExisted: integration.task && host.platform === 'win32' && !host.skipTask && host.taskExists(paths.taskName),
    taskLauncher: integration.task && host.platform === 'win32' && !host.skipTask && host.taskExists(paths.taskName)
      ? host.taskAction(paths.taskName)
      : '',
    taskManaged: integration.task,
    installDirExisted: fs.existsSync(paths.installDir),
    dataRootExisted: fs.existsSync(paths.dataRoot)
  }
}

function assertIntegrationSnapshotCurrent(paths: InstallPaths, host: InstallHost, snapshot: IntegrationSnapshot): void {
  for (const [file, before] of snapshot.files) {
    if (!sameOptionalBuffer(currentFileBytes(file), before)) throw new Error(`lifecycle file changed after preflight: ${file}`)
  }
  for (const [directory, existed] of snapshot.directories) {
    if (fs.existsSync(directory) !== existed) throw new Error(`lifecycle directory changed after preflight: ${directory}`)
    if (existed) assertPlainDirectory(directory, 'preflight lifecycle directory')
  }
  if (snapshot.pathManaged && !sameUserPathState(host.userPathState(), snapshot.userPath)) {
    throw new Error('user PATH changed after preflight')
  }
  if (snapshot.pathManaged) {
    for (const [name, before] of snapshot.environment) {
      if (!sameUserEnvironmentState(host.userEnvState(name), before)) {
        throw new Error(`user environment changed after preflight: ${name}`)
      }
    }
  }
  const taskExists = snapshot.taskManaged && host.platform === 'win32' && !host.skipTask && host.taskExists(paths.taskName)
  const taskAction = taskExists ? host.taskAction(paths.taskName) : ''
  if (taskExists !== snapshot.taskExisted
    || taskExists && taskAction.toLowerCase() !== snapshot.taskLauncher.toLowerCase()) {
    throw new Error('scheduled task changed after preflight')
  }
}

function sameOptionalBuffer(left: Buffer | null, right: Buffer | null): boolean {
  return left === null ? right === null : right !== null && left.equals(right)
}

function currentFileBytes(file: string, maxBytes = 64 * 1024 * 1024): Buffer | null {
  if (!lstatOptional(file)) return null
  return readBoundedPlainFile(file, maxBytes, 'lifecycle file')
}

function captureFileState(file: string, maxBytes = 64 * 1024 * 1024, allowLinked = false): CapturedFileState {
  const before = lstatOptional(file)
  if (!before) return { bytes: null, stat: null }
  const bytes = readBoundedPlainFile(file, maxBytes, 'lifecycle CAS file', allowLinked)
  const after = fs.lstatSync(file)
  if (!after.isFile() || after.isSymbolicLink()
    || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
    || after.mtimeMs !== before.mtimeMs || after.nlink !== before.nlink) {
    throw new Error(`lifecycle CAS file changed while captured: ${file}`)
  }
  return {
    bytes,
    stat: {
      dev: after.dev,
      ino: after.ino,
      size: after.size,
      mtimeMs: after.mtimeMs,
      nlink: after.nlink
    }
  }
}

function assertCapturedFileState(
  file: string,
  expected: CapturedFileState,
  label: string,
  maxBytes = Math.max(64 * 1024 * 1024, expected.bytes?.length || 0)
): void {
  const current = captureFileState(
    file,
    maxBytes,
    expected.stat?.nlink === 2
  )
  if (!sameOptionalBuffer(current.bytes, expected.bytes)
    || canonicalJson(current.stat) !== canonicalJson(expected.stat)) {
    throw new Error(`${label} changed before lifecycle mutation`)
  }
}

function captureHashedFileState(
  file: string,
  maxBytes: number,
  label: string,
  allowLinked = false
): CapturedHashedFileState {
  const before = fs.lstatSync(file)
  if (!before.isFile() || before.isSymbolicLink()
    || before.nlink < 1 || before.nlink > (allowLinked ? 2 : 1) || before.size > maxBytes) {
    throw new Error(`${label} is not a bounded unique plain file`)
  }
  const sha256 = sha256File(file, maxBytes, allowLinked)
  const after = fs.lstatSync(file)
  if (!after.isFile() || after.isSymbolicLink()
    || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
    || after.mtimeMs !== before.mtimeMs || after.nlink !== before.nlink) {
    throw new Error(`${label} changed while captured`)
  }
  return {
    sha256,
    stat: {
      dev: after.dev,
      ino: after.ino,
      size: after.size,
      mtimeMs: after.mtimeMs,
      nlink: after.nlink
    }
  }
}

function assertCapturedHashedFileState(
  file: string,
  expected: CapturedHashedFileState,
  label: string,
  allowLinked = false
): void {
  const current = captureHashedFileState(file, expected.stat.size, label, allowLinked)
  if (current.sha256 !== expected.sha256 || canonicalJson(current.stat) !== canonicalJson(expected.stat)) {
    throw new Error(`${label} changed before lifecycle mutation`)
  }
}

function assertCapturedHashedFileIdentity(
  file: string,
  expected: CapturedHashedFileState,
  label: string
): void {
  const current = fs.lstatSync(file)
  if (!current.isFile() || current.isSymbolicLink()
    || current.dev !== expected.stat.dev || current.ino !== expected.stat.ino
    || current.size !== expected.stat.size || current.mtimeMs !== expected.stat.mtimeMs
    || current.nlink !== expected.stat.nlink) {
    throw new Error(`${label} changed after its bounded hash seal`)
  }
}

function recordBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function assertCurrentFileAllowed(file: string, allowed: readonly (Buffer | null)[], label: string): Buffer | null {
  const current = currentFileBytes(file)
  if (!allowed.some((candidate) => sameOptionalBuffer(current, candidate))) {
    throw new Error(`${label} contains foreign concurrent bytes`)
  }
  return current
}

function writeFileFromAllowed(
  file: string,
  value: string | Buffer,
  allowed: readonly (Buffer | null)[],
  label: string,
  authority?: LifecycleWriteAuthority
): void {
  const before = captureFileState(file)
  if (!allowed.some((candidate) => sameOptionalBuffer(before.bytes, candidate))) {
    throw new Error(`${label} contains foreign concurrent bytes`)
  }
  atomicWrite(file, value, authority, before)
  const expected = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8')
  if (!sameOptionalBuffer(currentFileBytes(file), expected)) throw new Error(`${label} failed its write postcondition`)
}

function externalDeleteSlot(file: string, walId: string): string {
  if (!UUID.test(walId)) throw new Error('external delete slot requires a valid lifecycle WAL ID')
  return join(dirname(resolve(file)), `.${basename(file)}.${walId}.deleting`)
}

function unlinkOwnedFileByIsolation(
  file: string,
  expected: Sha256Digest,
  authority: LifecycleWriteAuthority,
  label: string
): void {
  const source = resolve(file)
  const sourceBefore = captureHashedFileState(source, 64 * 1024 * 1024, label)
  if (sourceBefore.sha256 !== expected) throw new Error(`${label} contains foreign bytes before isolation`)
  const slot = externalDeleteSlot(source, authority.walId)
  const fence = lifecycleMutationFenceFor(source, authority)
  assertLifecycleDirectoryFence(dirname(source), fence)
  const slotBefore = captureFileState(slot, 64 * 1024 * 1024)
  if (slotBefore.stat !== null) throw new Error(`${label} private delete slot already exists`)
  assertCapturedHashedFileState(source, sourceBefore, label)
  assertCapturedFileState(slot, slotBefore, `${label} private delete slot`)
  // Isolate by no-replace hard-link publication followed by an exact source
  // unlink. A kill between those two syscalls leaves a provable internal pair
  // that recovery collapses back to the live source namespace.
  assertLifecycleFileMutationBoundary(source, authority, source)
  assertLifecycleFileMutationBoundary(slot, authority, source)
  fs.linkSync(source, slot)
  const linkedSource = captureHashedFileState(source, sourceBefore.stat.size, label, true)
  const linkedSlot = captureHashedFileState(slot, sourceBefore.stat.size, `${label} isolated slot`, true)
  if (linkedSource.sha256 !== expected || linkedSlot.sha256 !== expected
    || linkedSource.stat.dev !== linkedSlot.stat.dev || linkedSource.stat.ino !== linkedSlot.stat.ino
    || linkedSource.stat.nlink !== 2 || linkedSlot.stat.nlink !== 2
    || linkedSource.stat.dev !== sourceBefore.stat.dev || linkedSource.stat.ino !== sourceBefore.stat.ino
    || linkedSource.stat.size !== sourceBefore.stat.size || linkedSource.stat.mtimeMs !== sourceBefore.stat.mtimeMs) {
    throw new Error(`${label} changed during no-replace isolation`)
  }
  assertCapturedHashedFileState(source, linkedSource, label, true)
  lifecycleUnlinkSync(source, authority, source)
  try {
    const isolated = captureHashedFileState(slot, sourceBefore.stat.size, `${label} isolated slot`)
    if (isolated.sha256 !== expected) throw new Error(`${label} changed before isolated deletion`)
    assertCapturedHashedFileState(slot, isolated, `${label} isolated slot`)
    lifecycleUnlinkSync(slot, authority, source)
  } catch (error) {
    if (lstatOptional(slot) && !lstatOptional(source)) {
      const isolated = captureHashedFileState(slot, sourceBefore.stat.size, `${label} isolated rollback slot`)
      if (isolated.sha256 === expected) {
        assertLifecycleFileMutationBoundary(slot, authority, source)
        assertLifecycleFileMutationBoundary(source, authority, source)
        fs.linkSync(slot, source)
        const restored = captureHashedFileState(source, sourceBefore.stat.size, `${label} restored source`, true)
        if (restored.sha256 !== expected || restored.stat.dev !== isolated.stat.dev || restored.stat.ino !== isolated.stat.ino) {
          throw new Error(`${label} rollback source did not bind the isolated inode`)
        }
        lifecycleUnlinkSync(slot, authority, source)
      }
    }
    throw error
  }
}

function expectedIntegration(
  snapshot: IntegrationSnapshot,
  overrides: {
    files?: ReadonlyMap<string, string | Buffer | null>
    userPath?: UserPathState
    pathManaged?: boolean
    environment?: ReadonlyMap<string, UserEnvironmentState>
    taskExisted?: boolean
    taskLauncher?: string
    taskManaged?: boolean
  }
): IntegrationExpected {
  const files = new Map(snapshot.files)
  for (const [file, value] of overrides.files || []) {
    files.set(resolve(file), value === null ? null : Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8'))
  }
  return {
    files,
    userPath: overrides.userPath ?? snapshot.userPath,
    pathManaged: overrides.pathManaged ?? snapshot.pathManaged,
    environment: new Map(overrides.environment || snapshot.environment),
    taskExisted: overrides.taskExisted ?? snapshot.taskExisted,
    taskLauncher: overrides.taskLauncher ?? snapshot.taskLauncher,
    taskManaged: overrides.taskManaged ?? snapshot.taskManaged
  }
}

function lifecycleIntegrationState(
  value: Pick<IntegrationSnapshot, 'userPath' | 'pathManaged' | 'environment' | 'taskExisted' | 'taskLauncher' | 'taskManaged'>
    | Pick<IntegrationExpected, 'userPath' | 'pathManaged' | 'environment' | 'taskExisted' | 'taskLauncher' | 'taskManaged'>
): LifecycleIntegrationStateV1 {
  return {
    userPath: { managed: value.pathManaged, ...value.userPath },
    environment: LIFECYCLE_ENV_NAMES.map((name) => ({
      name,
      ...(value.environment.get(name) || absentUserEnvironmentState())
    })),
    task: {
      managed: value.taskManaged,
      exists: value.taskExisted,
      action: value.taskExisted ? value.taskLauncher : ''
    }
  }
}

function currentLifecycleIntegration(
  paths: InstallPaths,
  host: InstallHost,
  integration: { path: boolean; task: boolean } = { path: true, task: true }
): LifecycleIntegrationStateV1 {
  const taskExists = integration.task && host.platform === 'win32' && !host.skipTask && host.taskExists(paths.taskName)
  return {
    userPath: { managed: integration.path, ...(integration.path ? host.userPathState() : unmanagedUserPathState()) },
    environment: LIFECYCLE_ENV_NAMES.map((name) => ({
      name,
      ...(integration.path ? host.userEnvState(name) : absentUserEnvironmentState())
    })),
    task: { managed: integration.task, exists: taskExists, action: taskExists ? host.taskAction(paths.taskName) : '' }
  }
}

function assertLifecycleIntegrationCurrent(
  paths: InstallPaths,
  host: InstallHost,
  expected: LifecycleIntegrationStateV1,
  label: string
): void {
  if (canonicalJson(currentLifecycleIntegration(paths, host, {
    path: expected.userPath.managed,
    task: expected.task.managed
  })) !== canonicalJson(expected)) {
    throw new Error(`${label} integration state differs from the frozen lifecycle state`)
  }
}

async function cleanupFreshRollbackRoots(
  paths: InstallPaths,
  snapshot: IntegrationSnapshot,
  revalidate: () => Promise<void>
): Promise<void> {
  const removeIfFresh = async (root: string, existed: boolean, allowedDirectories: ReadonlySet<string>) => {
    if (existed || !fs.existsSync(root)) return
    const entries = walkPlainTree(root)
    const fence = captureDirectoryFence(root)
    for (const entry of entries.filter((candidate) => candidate.kind === 'directory')) {
      captureDirectoryFence(entry.absolute, fence)
    }
    if (entries.some((entry) => entry.kind === 'file')) throw new Error(`rollback refused unexpected files in fresh root ${root}`)
    for (const entry of entries) {
      if (!allowedDirectories.has(resolve(entry.absolute))) {
        throw new Error(`rollback refused an unexpected directory in fresh root: ${entry.path}`)
      }
    }
    for (const entry of entries.sort((left, right) => right.path.split('/').length - left.path.split('/').length)) {
      await revalidate()
      assertDirectoryFence(entry.absolute, fence)
      assertPlainDirectory(entry.absolute, 'rollback-created lifecycle directory')
      fs.rmdirSync(entry.absolute)
    }
    await revalidate()
    assertDirectoryFence(root, fence)
    assertPlainDirectory(root, 'rollback-created lifecycle root')
    fs.rmdirSync(root)
  }
  for (const [directory, existed] of [...snapshot.directories].sort(([left], [right]) => right.length - left.length)) {
    if (existed || !fs.existsSync(directory)) continue
    const fence = captureDirectoryFence(directory)
    await revalidate()
    assertDirectoryFence(directory, fence)
    assertPlainDirectory(directory, 'rollback-created lifecycle directory')
    assertDirectoryEmptyBounded(directory, `rollback refused concurrently changed directory ${directory}`)
    fs.rmdirSync(directory)
  }
  await removeIfFresh(paths.installDir, snapshot.installDirExisted, new Set([resolve(paths.binDir)]))
  const allowedDataDirectories = new Set<string>()
  const addParents = (target: string) => {
    let cursor = dirname(target)
    while (isSameOrInside(paths.dataRoot, cursor, process.platform) && !samePath(cursor, paths.dataRoot, process.platform)) {
      allowedDataDirectories.add(resolve(cursor))
      cursor = dirname(cursor)
    }
  }
  const spec = layoutSpec(paths.dataRoot, pathApi)
  for (const directory of spec.dirs) {
    allowedDataDirectories.add(resolve(directory))
    addParents(directory)
  }
  for (const file of [...spec.files.map((entry) => entry.path), paths.dataMarkerPath, ...requiredDataAssets(paths.dataRoot)]) addParents(file)
  await removeIfFresh(paths.dataRoot, snapshot.dataRootExisted, allowedDataDirectories)
}

function restoreIntegration(
  paths: InstallPaths,
  host: InstallHost,
  snapshot: IntegrationSnapshot,
  expected: IntegrationExpected,
  authority: LifecycleWriteAuthority
): void {
  for (const [file, before] of snapshot.files) {
    const current = currentFileBytes(file)
    const after = expected.files.has(file) ? expected.files.get(file) as Buffer | null : before
    if (!sameOptionalBuffer(current, before) && !sameOptionalBuffer(current, after)) {
      throw new Error(`rollback refused concurrently changed lifecycle file: ${file}`)
    }
  }
  for (const [file, before] of snapshot.files) {
    const current = currentFileBytes(file)
    const after = expected.files.has(file) ? expected.files.get(file) as Buffer | null : before
    if (sameOptionalBuffer(current, before)) continue
    if (!sameOptionalBuffer(current, after)) throw new Error(`rollback lost lifecycle file authority: ${file}`)
    if (before === null) {
      if (fs.existsSync(file)) lifecycleUnlinkSync(file, authority, file)
    } else writeFileFromAllowed(file, before, [after], 'lifecycle rollback file', authority)
  }
  let changed = false
  if (snapshot.pathManaged && !host.skipPath && host.platform === 'win32') {
    const currentPath = host.userPathState()
    if (!sameUserPathState(currentPath, snapshot.userPath)) {
      if (!sameUserPathState(currentPath, expected.userPath)
        || !host.compareExchangeUserPath(currentPath, snapshot.userPath)
        || !sameUserPathState(host.userPathState(), snapshot.userPath)) {
        throw new Error('rollback refused a concurrently changed user PATH')
      }
      changed = true
    }
    for (const [name, value] of snapshot.environment) {
      const current = host.userEnvState(name)
      const after = expected.environment.get(name)
      if (!sameUserEnvironmentState(current, value)) {
        if (!after || !sameUserEnvironmentState(current, after)
          || !host.compareExchangeUserEnv(name, current, value)
          || !sameUserEnvironmentState(host.userEnvState(name), value)) {
          throw new Error(`rollback refused concurrently changed user environment ${name}`)
        }
        changed = true
      }
    }
    if (changed) host.broadcastEnv()
  }
  if (snapshot.taskManaged && !host.skipTask && host.platform === 'win32') {
    const taskExisted = host.taskExists(paths.taskName)
    const taskLauncher = taskExisted ? host.taskAction(paths.taskName) : ''
    const taskIsBefore = taskExisted === snapshot.taskExisted
      && (!taskExisted || taskLauncher.toLowerCase() === snapshot.taskLauncher.toLowerCase())
    const taskIsAfter = taskExisted === expected.taskExisted
      && (!taskExisted || taskLauncher.toLowerCase() === expected.taskLauncher.toLowerCase())
    if (!taskIsBefore && !taskIsAfter) throw new Error('rollback refused a concurrently changed scheduled task')
    if (taskIsBefore) return
    if (!snapshot.taskExisted) {
      host.unregisterTask(paths.taskName, paths.silentVbs)
    } else if (snapshot.taskLauncher.toLowerCase() === expectedTaskAction(paths.silentVbs).toLowerCase()) {
      host.registerLogonTask(paths.taskName, paths.silentVbs)
    } else {
      throw new Error('cannot restore a foreign scheduled task action')
    }
  }
}

class LifecycleWalPublicationError extends Error {
  readonly preserveLifecycleOwner = true

  constructor(cause: unknown) {
    super(`lifecycle WAL publication requires restart recovery: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'LifecycleWalPublicationError'
  }
}

function writeLifecycleWal(
  paths: InstallPaths,
  wal: LifecycleWalV1,
  expected: LifecycleWalV1 | null,
  host: InstallHost
): void {
  const oldIntegration = validateLifecycleIntegrationState(wal.oldIntegration, 'prior')
  const newIntegration = validateLifecycleIntegrationState(wal.newIntegration, 'target')
  if (canonicalJson(oldIntegration) !== canonicalJson(wal.oldIntegration)
    || canonicalJson(newIntegration) !== canonicalJson(wal.newIntegration)) {
    throw new Error('constructed lifecycle WAL integration state is not canonical')
  }
  for (const marker of [wal.oldMarker, wal.newMarker].filter(Boolean) as DataRootMarkerV1[]) {
    validateDataRootMarker(marker as unknown as Record<string, unknown>, paths, process.platform)
  }
  for (const manifest of [wal.oldManifest, wal.newManifest].filter(Boolean) as InstallManifestV2[]) {
    const embedded = resolveInstallPaths(pathApi, {
      hubRoot: manifest.packageRoot,
      packageRoot: manifest.packageRoot,
      dataRoot: manifest.dataRoot,
      nodePath: manifest.nodePath,
      installDir: manifest.installDir,
      extraShimDir: manifest.extraShimDir,
      taskName: manifest.taskName,
      port: manifest.port
    })
    validateInstallManifest(manifest as unknown as Record<string, unknown>, embedded, process.platform)
  }
  for (const receipt of [wal.oldReceipt, wal.newReceipt].filter(Boolean) as LifecycleRootReceiptV1[]) {
    if (canonicalJson(validateLifecycleRootReceipt(receipt as unknown as Record<string, unknown>, host)) !== canonicalJson(receipt)) {
      throw new Error('constructed lifecycle WAL root receipt is not canonical')
    }
  }
  if (wal.operation === 'setup') {
    if (!wal.newManifest || wal.oldManifest || wal.newReceipt.state !== 'active'
      || wal.oldReceipt && !sameLifecycleRootReceiptNamespace(wal.oldReceipt, wal.newReceipt, host)) {
      throw new Error('constructed setup WAL root receipt transition is invalid')
    }
    assertLifecycleRootReceiptBindsManifest(wal.newReceipt, wal.newManifest, 'active', host)
  } else if (wal.operation === 'upgrade') {
    if (!wal.oldManifest || !wal.newManifest || !wal.oldReceipt
      || !sameLifecycleRootReceiptNamespace(wal.oldReceipt, wal.newReceipt, host)) {
      throw new Error('constructed upgrade WAL root receipt transition is invalid')
    }
    assertLifecycleRootReceiptBindsManifest(wal.oldReceipt, wal.oldManifest, 'active', host)
    assertLifecycleRootReceiptBindsManifest(wal.newReceipt, wal.newManifest, 'active', host)
  } else {
    if (!wal.oldManifest || wal.newManifest || !wal.oldReceipt
      || !sameLifecycleRootReceiptNamespace(wal.oldReceipt, wal.newReceipt, host)) {
      throw new Error('constructed uninstall WAL root receipt transition is invalid')
    }
    assertLifecycleRootReceiptBindsManifest(wal.oldReceipt, wal.oldManifest, 'active', host)
    assertLifecycleRootReceiptBindsManifest(wal.newReceipt, wal.oldManifest, 'inactive', host)
  }
  const transitionManifest = wal.operation === 'setup' ? wal.newManifest : wal.oldManifest
  if (!transitionManifest) throw new Error('constructed lifecycle WAL has no transition manifest')
  const externalArtifacts = validateLifecycleExternalArtifacts(
    wal.externalArtifacts,
    wal.operation,
    transitionManifest,
    paths,
    process.platform
  )
  if (canonicalJson(externalArtifacts) !== canonicalJson(wal.externalArtifacts)) {
    throw new Error('constructed lifecycle WAL external artifact actions are not canonical')
  }
  const bytes = recordBytes(wal)
  if (bytes.length > LIFECYCLE_WAL_MAX_BYTES) {
    throw new Error('lifecycle WAL exceeds its durable publication bound')
  }
  if (expected === null) {
    if (wal.phase !== 'prepared') throw new Error('initial lifecycle WAL publication must be prepared')
    const initialReceipt = wal.operation === 'setup' ? wal.newReceipt : wal.oldReceipt
    if (!initialReceipt) throw new Error('initial lifecycle WAL has no published root receipt authority')
    assertLifecycleRootReceiptCurrentExact(host, initialReceipt)
    ensureLifecycleDirectory(dirname(paths.lifecycleWalPath), wal, paths.lifecycleWalPath)
    const publishedBefore: CapturedFileState = { bytes: null, stat: null }
    assertCapturedFileState(paths.lifecycleWalPath, publishedBefore, 'initial lifecycle WAL target')
    const owner = readJsonRecord(paths.lifecycleLockPath, LIFECYCLE_LOCK_MAX_BYTES)
    if (!owner || owner.token !== wal.lockToken || owner.pid !== process.pid) {
      throw new Error('lifecycle WAL initial publication has no matching lifecycle owner')
    }
    const temporary = `${paths.lifecycleWalPath}.${wal.walId}.${wal.lockToken}.pending`
    let descriptor = -1
    try {
      try {
        assertLifecycleFileMutationBoundary(temporary, wal, paths.lifecycleWalPath)
        descriptor = fs.openSync(temporary, 'wx')
        assertLifecycleFileMutationBoundary(temporary, wal, paths.lifecycleWalPath)
        fs.writeFileSync(descriptor, bytes)
        fs.fsyncSync(descriptor)
        fs.closeSync(descriptor)
        descriptor = -1
        // link is an atomic, no-replace publication on every supported host.
        // A hard kill can leave the complete pending and final names linked to
        // the same inode; the next mutex owner proves and collapses that pair.
        assertLifecycleFileMutationBoundary(temporary, wal, paths.lifecycleWalPath)
        assertLifecycleFileMutationBoundary(paths.lifecycleWalPath, wal)
        assertCapturedFileState(paths.lifecycleWalPath, publishedBefore, 'initial lifecycle WAL target')
        fs.linkSync(temporary, paths.lifecycleWalPath)
        flushDirectory(dirname(paths.lifecycleWalPath))
        try {
          lifecycleUnlinkSync(temporary, wal, paths.lifecycleWalPath)
          flushDirectory(dirname(paths.lifecycleWalPath))
        } catch {
          // The published WAL remains authoritative. Keeping the exact linked
          // pending name is safer than losing the owner truth on cleanup error.
        }
      } finally {
        if (descriptor >= 0) fs.closeSync(descriptor)
      }
    } catch (error) {
      if (!lstatOptional(paths.lifecycleWalPath)) {
        try { if (lstatOptional(temporary)) lifecycleUnlinkSync(temporary, wal, paths.lifecycleWalPath) } catch { /* preserve owner below */ }
      }
      if (lstatOptional(paths.lifecycleWalPath) || lstatOptional(temporary)) {
        throw new LifecycleWalPublicationError(error)
      }
      throw error
    }
  } else {
    const { phase: nextPhase, ...nextImmutable } = wal
    const { phase: priorPhase, ...priorImmutable } = expected
    const legal = priorPhase === 'prepared'
      ? expected.operation === 'upgrade' ? nextPhase === 'switched' : nextPhase === 'committed'
      : priorPhase === 'switched' && expected.operation === 'upgrade' && nextPhase === 'committed'
    if (!legal || canonicalJson(nextImmutable) !== canonicalJson(priorImmutable)) {
      throw new Error('lifecycle WAL transition changed immutable authority or skipped its phase state machine')
    }
    const pending = `${paths.lifecycleWalPath}.${expected.walId}.${expected.lockToken}.pending`
    const pendingStat = lstatOptional(pending)
    if (pendingStat) {
      const finalStat = fs.lstatSync(paths.lifecycleWalPath)
      if (!pendingStat.isFile() || pendingStat.isSymbolicLink()
        || pendingStat.dev !== finalStat.dev || pendingStat.ino !== finalStat.ino
        || pendingStat.nlink !== 2 || finalStat.nlink !== 2) {
        throw new Error('lifecycle WAL transition found an unowned pending artifact')
      }
      lifecycleUnlinkSync(pending, wal, paths.lifecycleWalPath)
      flushDirectory(dirname(paths.lifecycleWalPath))
    }
    writeFileFromAllowed(paths.lifecycleWalPath, bytes, [recordBytes(expected)], 'lifecycle WAL transition', wal)
  }
  const publishedStat = fs.lstatSync(paths.lifecycleWalPath)
  const pendingStat = lstatOptional(`${paths.lifecycleWalPath}.${wal.walId}.${wal.lockToken}.pending`)
  const linkedPair = publishedStat.nlink === 2 && pendingStat?.isFile()
    && !pendingStat.isSymbolicLink() && pendingStat.dev === publishedStat.dev
    && pendingStat.ino === publishedStat.ino && pendingStat.nlink === 2
  if (!readBoundedPlainFile(paths.lifecycleWalPath, LIFECYCLE_WAL_MAX_BYTES, 'published lifecycle WAL', linkedPair).equals(bytes)
    || publishedStat.nlink !== 1 && !linkedPair) {
    throw new Error('lifecycle WAL write postcondition failed')
  }
}

function removeLifecycleWal(paths: InstallPaths, expected: LifecycleWalV1): void {
  let captured = captureFileState(paths.lifecycleWalPath, LIFECYCLE_WAL_MAX_BYTES)
  if (!sameOptionalBuffer(captured.bytes, recordBytes(expected))) {
    throw new Error('lifecycle WAL removal contains foreign concurrent bytes')
  }
  const pending = `${paths.lifecycleWalPath}.${expected.walId}.${expected.lockToken}.pending`
  const pendingStat = lstatOptional(pending)
  if (pendingStat) {
    const finalStat = fs.lstatSync(paths.lifecycleWalPath)
    if (!pendingStat.isFile() || pendingStat.isSymbolicLink()
      || pendingStat.dev !== finalStat.dev || pendingStat.ino !== finalStat.ino
      || pendingStat.nlink !== 2 || finalStat.nlink !== 2) {
      throw new Error('lifecycle WAL removal found an unowned pending artifact')
    }
    lifecycleUnlinkSync(pending, expected, paths.lifecycleWalPath)
    captured = captureFileState(paths.lifecycleWalPath, LIFECYCLE_WAL_MAX_BYTES)
    if (!sameOptionalBuffer(captured.bytes, recordBytes(expected))) {
      throw new Error('lifecycle WAL changed while collapsing its pending hard link')
    }
  }
  assertCapturedFileState(paths.lifecycleWalPath, captured, 'lifecycle WAL removal')
  lifecycleUnlinkSync(paths.lifecycleWalPath, expected)
  flushDirectory(dirname(paths.lifecycleWalPath))
}

function pathsForManifest(manifestValue: InstallManifestV2, current: InstallPaths, host: InstallHost): InstallPaths {
  const paths = resolveInstallPaths(pathApi, {
    hubRoot: manifestValue.packageRoot,
    packageRoot: manifestValue.packageRoot,
    dataRoot: manifestValue.dataRoot,
    nodePath: manifestValue.nodePath,
    installDir: manifestValue.installDir,
    extraShimDir: manifestValue.extraShimDir,
    taskName: manifestValue.taskName,
    port: manifestValue.port
  })
  validateInstallManifest(manifestValue as unknown as Record<string, unknown>, paths, host.platform)
  if (!samePath(manifestValue.nodePath, process.execPath, host.platform)) {
    throw new Error('lifecycle WAL node runtime differs from the current executable')
  }
  preflightLifecycleRoots(paths, host)
  assertManagedInstallTree(paths, manifestValue, host.platform, true)
  return paths
}

function validateLifecycleIntegrationState(value: unknown, label: string): LifecycleIntegrationStateV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !exactKeys(value as Record<string, unknown>, ['userPath', 'environment', 'task'])) {
    throw new Error(`lifecycle WAL ${label} integration state is invalid`)
  }
  const raw = value as Record<string, unknown>
  if (!raw.userPath || typeof raw.userPath !== 'object' || Array.isArray(raw.userPath)
    || !exactKeys(raw.userPath as Record<string, unknown>, ['managed', 'exists', 'value', 'kind'])
    || !Array.isArray(raw.environment) || raw.environment.length !== LIFECYCLE_ENV_NAMES.length
    || !raw.task || typeof raw.task !== 'object' || Array.isArray(raw.task)
    || !exactKeys(raw.task as Record<string, unknown>, ['managed', 'exists', 'action'])) {
    throw new Error(`lifecycle WAL ${label} integration state is invalid`)
  }
  const environment = raw.environment.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || !exactKeys(entry as Record<string, unknown>, ['name', 'exists', 'value', 'kind'])) {
      throw new Error(`lifecycle WAL ${label} environment state is invalid`)
    }
    const item = entry as Record<string, unknown>
    const name = LIFECYCLE_ENV_NAMES[index]
    if (item.name !== name || typeof item.exists !== 'boolean' || typeof item.value !== 'string'
      || Buffer.byteLength(item.value, 'utf8') > INTEGRATION_VALUE_MAX_BYTES
      || item.kind !== null && item.kind !== 'String' && item.kind !== 'ExpandString'
      || !item.exists && (item.value !== '' || item.kind !== null)
      || item.exists && item.kind === null) {
      throw new Error(`lifecycle WAL ${label} environment state is invalid`)
    }
    return {
      name,
      exists: item.exists,
      value: item.value,
      kind: item.kind
    } as LifecycleIntegrationStateV1['environment'][number]
  })
  const pathState = raw.userPath as Record<string, unknown>
  if (typeof pathState.managed !== 'boolean' || typeof pathState.exists !== 'boolean' || typeof pathState.value !== 'string'
    || Buffer.byteLength(pathState.value, 'utf8') > INTEGRATION_VALUE_MAX_BYTES
    || pathState.kind !== null && pathState.kind !== 'String' && pathState.kind !== 'ExpandString'
    || !pathState.exists && (pathState.value !== '' || pathState.kind !== null)
    || pathState.exists && pathState.kind === null
    || !pathState.managed && (pathState.exists || pathState.value !== '' || pathState.kind !== null)) {
    throw new Error(`lifecycle WAL ${label} PATH state is invalid`)
  }
  const task = raw.task as Record<string, unknown>
  if (typeof task.managed !== 'boolean' || typeof task.exists !== 'boolean' || typeof task.action !== 'string'
    || Buffer.byteLength(task.action, 'utf8') > INTEGRATION_VALUE_MAX_BYTES
    || !task.managed && (task.exists || task.action !== '')
    || !task.exists && task.action !== '') {
    throw new Error(`lifecycle WAL ${label} task state is invalid`)
  }
  return {
    userPath: pathState as unknown as LifecycleIntegrationStateV1['userPath'],
    environment,
    task: { managed: task.managed, exists: task.exists, action: task.action }
  }
}

function projectedLifecycleIntegration(
  operation: LifecycleWalV1['operation'],
  before: LifecycleIntegrationStateV1,
  manifest: InstallManifestV2,
  host: InstallHost
): LifecycleIntegrationStateV1 {
  if (before.userPath.managed !== manifest.features.path || before.task.managed !== manifest.features.task) {
    throw new Error('lifecycle integration ownership flags differ from the manifest features')
  }
  if (operation === 'upgrade') return before
  const environment = new Map(before.environment.map((entry) => [entry.name, {
    exists: entry.exists,
    value: entry.value,
    kind: entry.kind
  } as UserEnvironmentState]))
  let userPath = before.userPath
  let task = { ...before.task }
  if (operation === 'setup') {
    if (manifest.owned.pathEntry.added) {
      const merged = mergeUserPath(before.userPath.value, manifest.owned.pathEntry.value, host.pathSep, host.caseInsensitive)
      if (!merged.changed) throw new Error('lifecycle setup WAL cannot acquire an already-present PATH entry')
      userPath = { managed: true, ...userPathStateWithValue(before.userPath, merged.path) }
    }
    for (const entry of manifest.owned.environment) {
      const prior = environment.get(entry.name) || absentUserEnvironmentState()
      const expected = { exists: true, value: entry.value, kind: entry.kind } as UserEnvironmentState
      if (entry.created) {
        if (prior.exists) throw new Error(`lifecycle setup WAL cannot acquire existing environment ${entry.name}`)
        environment.set(entry.name, expected)
      } else if (!sameUserEnvironmentState(prior, expected)) {
        throw new Error(`lifecycle setup WAL pre-existing environment ${entry.name} is inconsistent`)
      }
    }
    if (manifest.owned.task) {
      if (!manifest.owned.task.created || before.task.exists) {
        throw new Error('lifecycle setup WAL cannot adopt a pre-existing scheduled task')
      }
      task = { managed: true, exists: true, action: expectedTaskAction(manifest.owned.task.launcher) }
    } else if (before.task.exists) {
      throw new Error('lifecycle setup WAL contains an unexpected pre-existing scheduled task')
    }
  } else {
    if (manifest.owned.pathEntry.added) {
      userPath = {
        managed: true,
        ...classifyUninstallUserPathTarget(before.userPath, manifest, host).target
      }
    }
    for (const entry of manifest.owned.environment) {
      const prior = environment.get(entry.name) || absentUserEnvironmentState()
      const expected = { exists: true, value: entry.value, kind: entry.kind } as UserEnvironmentState
      if (entry.created && sameUserEnvironmentState(prior, expected)) {
        environment.set(entry.name, absentUserEnvironmentState())
      }
    }
    if (manifest.owned.task?.created) {
      if (before.task.exists
        && before.task.action.toLowerCase() === expectedTaskAction(manifest.owned.task.launcher).toLowerCase()) {
        task = { managed: true, exists: false, action: '' }
      }
    }
  }
  return {
    userPath,
    environment: LIFECYCLE_ENV_NAMES.map((name) => ({
      name,
      ...(environment.get(name) || absentUserEnvironmentState())
    })),
    task
  }
}

function assertIntegrationStateOwns(
  manifest: InstallManifestV2,
  state: LifecycleIntegrationStateV1,
  host: InstallHost,
  label: string,
  allowUnownedDrift = false
): void {
  if (manifest.features.path) {
    if (!state.userPath.managed) throw new Error(`${label} PATH is not marked as managed`)
    if (!allowUnownedDrift
      && !pathHasDir(state.userPath.value, manifest.owned.pathEntry.value, host.pathSep, host.caseInsensitive)) {
      throw new Error(`${label} PATH does not contain the manifest-bound bin directory`)
    }
    if (!allowUnownedDrift && manifest.owned.pathEntry.added) {
      const first = state.userPath.value.split(host.pathSep, 1)[0] || ''
      if (!samePath(first, manifest.owned.pathEntry.value, host.platform)) {
        throw new Error(`${label} PATH does not preserve the owned prepend position`)
      }
    }
  } else if (state.userPath.managed || state.userPath.exists || state.userPath.value !== '' || state.userPath.kind !== null) {
    throw new Error(`${label} contains unreachable disabled PATH state`)
  }
  const environment = new Map(state.environment.map((entry) => [entry.name, entry]))
  for (const entry of manifest.owned.environment) {
    if (allowUnownedDrift) continue
    const current = environment.get(entry.name)
    if (!current || !sameUserEnvironmentState(current, {
      exists: true,
      value: entry.value,
      kind: entry.kind
    })) {
      throw new Error(`${label} environment ${entry.name} does not match its manifest binding`)
    }
  }
  if (manifest.owned.task && !allowUnownedDrift) {
    if (!state.task.exists
      || state.task.action.toLowerCase() !== expectedTaskAction(manifest.owned.task.launcher).toLowerCase()) {
      throw new Error(`${label} scheduled task does not match its manifest binding`)
    }
  } else if (!manifest.owned.task && state.task.exists && !allowUnownedDrift) {
    throw new Error(`${label} contains an unexpected scheduled task`)
  }
  if (state.task.managed !== manifest.features.task) {
    throw new Error(`${label} scheduled-task ownership flag differs from the manifest feature`)
  }
}

function validateLifecycleExternalArtifacts(
  value: unknown,
  operation: LifecycleWalV1['operation'],
  manifest: InstallManifestV2,
  paths: InstallPaths,
  platform: NodeJS.Platform | string
): LifecycleExternalArtifactV1[] {
  if (!Array.isArray(value) || value.length > 16) {
    throw new Error('lifecycle WAL external artifact actions are invalid')
  }
  const expected = manifest.owned.files
    .filter((entry) => !isSameOrInside(paths.installDir, entry.path, platform))
    .sort((left, right) => resolve(left.path).localeCompare(resolve(right.path)))
  if (operation !== 'uninstall') {
    if (value.length !== 0) throw new Error('non-uninstall lifecycle WAL carries external deletion actions')
    return []
  }
  if (value.length !== expected.length) {
    throw new Error('lifecycle WAL external artifact actions do not match the manifest inventory')
  }
  return value.map((rawValue, index) => {
    if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)
      || !exactKeys(rawValue as Record<string, unknown>, ['path', 'ownedSha256', 'action', 'before'])) {
      throw new Error('lifecycle WAL external artifact action is invalid')
    }
    const raw = rawValue as Record<string, unknown>
    const owned = expected[index]
    if (typeof raw.path !== 'string' || !samePath(raw.path, owned.path, platform)
      || raw.ownedSha256 !== owned.sha256
      || raw.action !== 'delete-exact' && raw.action !== 'preserve-absent' && raw.action !== 'preserve-foreign') {
      throw new Error('lifecycle WAL external artifact action is not manifest-bound')
    }
    let before: LifecycleExternalArtifactFactV1 | null = null
    if (raw.before !== null) {
      if (!raw.before || typeof raw.before !== 'object' || Array.isArray(raw.before)
        || !exactKeys(raw.before as Record<string, unknown>, [
          'kind', 'dev', 'ino', 'mode', 'size', 'mtimeMs', 'nlink', 'sha256', 'linkTarget'
        ])) {
        throw new Error('lifecycle WAL external artifact fact is invalid')
      }
      const fact = raw.before as Record<string, unknown>
      const numeric = ['dev', 'ino', 'mode', 'size', 'mtimeMs', 'nlink'] as const
      if (fact.kind !== 'file' && fact.kind !== 'symlink' && fact.kind !== 'directory' && fact.kind !== 'other'
        || numeric.some((name) => typeof fact[name] !== 'number' || !Number.isFinite(fact[name]) || (fact[name] as number) < 0)
        || fact.sha256 !== null && (typeof fact.sha256 !== 'string' || !SHA256_DIGEST.test(fact.sha256))
        || fact.linkTarget !== null && (typeof fact.linkTarget !== 'string'
          || Buffer.byteLength(fact.linkTarget, 'utf8') > 64 * 1024)) {
        throw new Error('lifecycle WAL external artifact fact is invalid')
      }
      if (fact.kind === 'symlink') {
        if (typeof fact.linkTarget !== 'string' || fact.sha256 !== null) {
          throw new Error('lifecycle WAL external symlink fact is invalid')
        }
      } else if (fact.linkTarget !== null) {
        throw new Error('lifecycle WAL non-symlink artifact carries a link target')
      }
      if (fact.kind !== 'file' && fact.sha256 !== null
        || fact.kind === 'file' && (fact.size as number) <= 64 * 1024 * 1024 && fact.sha256 === null) {
        throw new Error('lifecycle WAL external artifact digest is invalid')
      }
      before = fact as unknown as LifecycleExternalArtifactFactV1
    }
    const exactOwned = before?.kind === 'file' && before.nlink === 1 && before.sha256 === owned.sha256
    if (raw.action === 'delete-exact' && !exactOwned
      || raw.action === 'preserve-absent' && before !== null
      || raw.action === 'preserve-foreign' && (before === null || exactOwned)) {
      throw new Error('lifecycle WAL external artifact action does not match its frozen fact')
    }
    return {
      path: resolve(owned.path),
      ownedSha256: owned.sha256,
      action: raw.action,
      before
    } as LifecycleExternalArtifactV1
  })
}

function readLifecycleWalFile(file: string, paths: InstallPaths, host: InstallHost): LifecycleWalV1 | null {
  const isPublished = samePath(file, paths.lifecycleWalPath, host.platform)
  const value = readJsonRecord(
    file,
    LIFECYCLE_WAL_MAX_BYTES,
    isPublished || lstatOptional(file)?.nlink === 2
  )
  if (!value) return null
  if (!exactKeys(value, [
    'schemaVersion', 'walId', 'lockToken', 'operation', 'phase', 'installDir', 'oldManifest', 'newManifest',
    'oldReceipt', 'newReceipt', 'oldMarker', 'newMarker', 'oldIntegration', 'newIntegration',
    'externalArtifacts', 'tombstone', 'oldDaemonRunning', 'createdAt'
  ])
    || value.schemaVersion !== 1
    || typeof value.walId !== 'string' || !UUID.test(value.walId)
    || typeof value.lockToken !== 'string' || !UUID.test(value.lockToken)
    || value.operation !== 'setup' && value.operation !== 'upgrade' && value.operation !== 'uninstall'
    || !['prepared', 'switched', 'committed'].includes(String(value.phase))
    || value.phase === 'switched' && value.operation !== 'upgrade'
    || typeof value.installDir !== 'string' || !samePath(value.installDir, paths.installDir, host.platform)
    || typeof value.oldDaemonRunning !== 'boolean'
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
    || value.tombstone !== null && typeof value.tombstone !== 'string') {
    throw new Error('lifecycle WAL is invalid or bound to another install root')
  }
  const terminalUninstallReceipt = value.operation === 'uninstall' && value.phase === 'committed'
  const embeddedManifestPaths = (raw: Record<string, unknown>): InstallPaths => resolveInstallPaths(pathApi, {
    hubRoot: String(raw.packageRoot || ''),
    packageRoot: String(raw.packageRoot || ''),
    dataRoot: String(raw.dataRoot || ''),
    nodePath: String(raw.nodePath || ''),
    installDir: String(raw.installDir || ''),
    extraShimDir: raw.extraShimDir === null ? null : String(raw.extraShimDir || ''),
    taskName: String(raw.taskName || ''),
    port: Number(raw.port || 0)
  })
  const readEmbeddedManifest = (rawValue: unknown, label: string): InstallManifestV2 | null => {
    if (rawValue === null) return null
    if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) throw new Error(`lifecycle WAL ${label} manifest is invalid`)
    const raw = rawValue as Record<string, unknown>
    const embeddedPaths = embeddedManifestPaths(raw)
    const manifest = validateInstallManifest(raw, embeddedPaths, host.platform)
    if (!terminalUninstallReceipt) pathsForManifest(manifest, paths, host)
    return manifest
  }
  const oldManifest = readEmbeddedManifest(value.oldManifest, 'prior')
  const newManifest = readEmbeddedManifest(value.newManifest, 'target')
  if (value.operation === 'setup' && (oldManifest !== null || !newManifest)
    || value.operation === 'upgrade' && (!oldManifest || !newManifest)
    || value.operation === 'uninstall' && (!oldManifest || newManifest !== null)) {
    throw new Error('lifecycle WAL manifest transition does not match its operation')
  }
  if (oldManifest && newManifest
    && (newManifest.installId !== oldManifest.installId || newManifest.dataRootId !== oldManifest.dataRootId)) {
    throw new Error('lifecycle WAL manifests do not describe the same owned installation')
  }
  const bindingManifest = newManifest || oldManifest
  if (!bindingManifest) throw new Error('lifecycle WAL has no installation binding')
  const readEmbeddedReceipt = (rawValue: unknown, label: string): LifecycleRootReceiptV1 | null => {
    if (rawValue === null) return null
    if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) {
      throw new Error(`lifecycle WAL ${label} root receipt is invalid`)
    }
    return validateLifecycleRootReceipt(rawValue as Record<string, unknown>, host)
  }
  const oldReceipt = readEmbeddedReceipt(value.oldReceipt, 'prior')
  const newReceipt = readEmbeddedReceipt(value.newReceipt, 'target')
  if (!newReceipt) throw new Error('lifecycle WAL has no target root receipt')
  if (value.operation === 'setup') {
    if (oldReceipt && !sameLifecycleRootReceiptNamespace(oldReceipt, newReceipt, host)) {
      throw new Error('lifecycle setup WAL receipt transition crosses a preserved root namespace')
    }
    assertLifecycleRootReceiptBindsManifest(newReceipt, newManifest!, 'active', host)
  } else if (value.operation === 'upgrade') {
    if (!oldReceipt || !sameLifecycleRootReceiptNamespace(oldReceipt, newReceipt, host)) {
      throw new Error('lifecycle upgrade WAL receipts do not describe one preserved root')
    }
    assertLifecycleRootReceiptBindsManifest(oldReceipt, oldManifest!, 'active', host)
    assertLifecycleRootReceiptBindsManifest(newReceipt, newManifest!, 'active', host)
  } else {
    if (!oldReceipt || !sameLifecycleRootReceiptNamespace(oldReceipt, newReceipt, host)) {
      throw new Error('lifecycle uninstall WAL receipts do not describe one preserved root')
    }
    assertLifecycleRootReceiptBindsManifest(oldReceipt, oldManifest!, 'active', host)
    assertLifecycleRootReceiptBindsManifest(newReceipt, oldManifest!, 'inactive', host)
  }
  const bindingPaths = terminalUninstallReceipt
    ? embeddedManifestPaths(bindingManifest as unknown as Record<string, unknown>)
    : pathsForManifest(bindingManifest, paths, host)
  if (!samePath(bindingPaths.dataRoot, paths.dataRoot, host.platform)
    || !samePath(bindingPaths.lifecycleWalPath, paths.lifecycleWalPath, host.platform)) {
    throw new Error('lifecycle WAL is bound to another data-root namespace')
  }
  for (const manifest of [oldManifest, newManifest].filter(Boolean) as InstallManifestV2[]) {
    const manifestPaths = terminalUninstallReceipt
      ? embeddedManifestPaths(manifest as unknown as Record<string, unknown>)
      : pathsForManifest(manifest, paths, host)
    if (!samePath(manifestPaths.installDir, paths.installDir, host.platform)
      || !samePath(manifestPaths.dataRoot, paths.dataRoot, host.platform)
      || !samePath(manifestPaths.binDir, bindingPaths.binDir, host.platform)
      || !samePath(manifestPaths.lifecycleLockPath, bindingPaths.lifecycleLockPath, host.platform)
      || !samePath(manifestPaths.lifecycleWalPath, bindingPaths.lifecycleWalPath, host.platform)) {
      throw new Error('lifecycle WAL manifest crosses an installation namespace')
    }
  }
  if (oldManifest && newManifest && (
    !samePath(oldManifest.installDir, newManifest.installDir, host.platform)
    || !samePath(oldManifest.dataRoot, newManifest.dataRoot, host.platform)
    || !samePath(oldManifest.binDir, newManifest.binDir, host.platform)
    || oldManifest.nodePath !== newManifest.nodePath
    || oldManifest.taskName !== newManifest.taskName
    || oldManifest.port !== newManifest.port
    || oldManifest.features.path !== newManifest.features.path
    || oldManifest.features.task !== newManifest.features.task
    || (oldManifest.extraShimDir === null) !== (newManifest.extraShimDir === null)
    || Boolean(oldManifest.extraShimDir && newManifest.extraShimDir
      && !samePath(oldManifest.extraShimDir, newManifest.extraShimDir, host.platform))
    || canonicalJson(oldManifest.owned.files.map((entry) => host.platform === 'win32'
      ? resolve(entry.path).toLowerCase()
      : resolve(entry.path)).sort()) !== canonicalJson(newManifest.owned.files.map((entry) => host.platform === 'win32'
        ? resolve(entry.path).toLowerCase()
        : resolve(entry.path)).sort())
    || canonicalJson(oldManifest.owned.pathEntry) !== canonicalJson(newManifest.owned.pathEntry)
    || canonicalJson(oldManifest.owned.environment) !== canonicalJson(newManifest.owned.environment)
    || canonicalJson(oldManifest.owned.task) !== canonicalJson(newManifest.owned.task)
  )) throw new Error('lifecycle WAL release transition changes its integration namespace')
  const readEmbeddedMarker = (rawValue: unknown, label: string): DataRootMarkerV1 | null => {
    if (rawValue === null) return null
    if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) throw new Error(`lifecycle WAL ${label} marker is invalid`)
    return validateDataRootMarker(rawValue as Record<string, unknown>, bindingPaths, host.platform)
  }
  const oldMarker = readEmbeddedMarker(value.oldMarker, 'prior')
  const newMarker = readEmbeddedMarker(value.newMarker, 'target')
  if (!newMarker || newMarker.dataRootId !== bindingManifest.dataRootId) throw new Error('lifecycle WAL target marker is not bound to the data root')
  if (oldMarker && oldMarker.dataRootId !== bindingManifest.dataRootId) throw new Error('lifecycle WAL prior marker is not bound to the data root')
  if (value.operation === 'setup') {
    if (oldMarker?.activeInstallId || newMarker.activeInstallId !== newManifest!.installId || value.tombstone !== null) {
      throw new Error('lifecycle setup WAL has an invalid ownership transition')
    }
    assertMarkerBindsPackage(newMarker, newManifest!.packageRoot, 'lifecycle target')
  } else if (value.operation === 'upgrade') {
    if (oldMarker?.activeInstallId !== oldManifest!.installId
      || newMarker.activeInstallId !== newManifest!.installId || value.tombstone !== null) {
      throw new Error('lifecycle upgrade WAL has an invalid ownership transition')
    }
    assertMarkerBindsPackage(oldMarker!, oldManifest!.packageRoot, 'lifecycle prior')
    assertMarkerBindsPackage(newMarker, newManifest!.packageRoot, 'lifecycle target')
  } else {
    const expectedTombstone = `${paths.installDir}.uninstalling-${oldManifest!.installId}-${value.walId}`
    if (oldMarker?.activeInstallId !== oldManifest!.installId || newMarker.activeInstallId !== null
      || typeof value.tombstone !== 'string' || !samePath(value.tombstone, expectedTombstone, host.platform)) {
      throw new Error('lifecycle uninstall WAL has an invalid ownership transition')
    }
    if (terminalUninstallReceipt) {
      if (canonicalJson(oldMarker!.runtime) !== canonicalJson(newMarker.runtime)) {
        throw new Error('committed uninstall receipt changes its frozen runtime binding')
      }
    } else {
      assertMarkerBindsPackage(oldMarker!, oldManifest!.packageRoot, 'lifecycle prior')
      assertMarkerBindsPackage(newMarker, oldManifest!.packageRoot, 'lifecycle target')
    }
  }
  const oldIntegration = validateLifecycleIntegrationState(value.oldIntegration, 'prior')
  const newIntegration = validateLifecycleIntegrationState(value.newIntegration, 'target')
  const transitionManifest = value.operation === 'setup' ? newManifest! : oldManifest!
  const externalArtifacts = validateLifecycleExternalArtifacts(
    value.externalArtifacts,
    value.operation as LifecycleWalV1['operation'],
    transitionManifest,
    bindingPaths,
    host.platform
  )
  const projected = projectedLifecycleIntegration(value.operation, oldIntegration, transitionManifest, host)
  if (canonicalJson(projected) !== canonicalJson(newIntegration)) {
    throw new Error('lifecycle WAL integration transition is inconsistent')
  }
  if (value.operation === 'setup') {
    assertIntegrationStateOwns(newManifest!, newIntegration, host, 'lifecycle setup target')
    if (!newManifest!.owned.pathEntry.added && newManifest!.features.path) {
      if (!pathHasDir(oldIntegration.userPath.value, newManifest!.owned.pathEntry.value, host.pathSep, host.caseInsensitive)) {
        throw new Error('lifecycle setup prior PATH does not contain the pre-existing manifest-bound bin directory')
      }
    }
  } else if (value.operation === 'upgrade') {
    assertIntegrationStateOwns(oldManifest!, oldIntegration, host, 'lifecycle upgrade prior')
    assertIntegrationStateOwns(newManifest!, newIntegration, host, 'lifecycle upgrade target')
  } else {
    assertIntegrationStateOwns(oldManifest!, oldIntegration, host, 'lifecycle uninstall prior', true)
  }
  const wal = {
    ...value,
    oldManifest,
    newManifest,
    oldReceipt,
    newReceipt,
    oldMarker,
    newMarker,
    oldIntegration,
    newIntegration,
    externalArtifacts
  } as unknown as LifecycleWalV1
  const finalStat = fs.lstatSync(file)
  if (isPublished && finalStat.nlink === 2) {
    const pending = `${paths.lifecycleWalPath}.${wal.walId}.${wal.lockToken}.pending`
    const pendingStat = lstatOptional(pending)
    if (!pendingStat?.isFile() || pendingStat.isSymbolicLink()
      || pendingStat.dev !== finalStat.dev || pendingStat.ino !== finalStat.ino
      || pendingStat.size !== finalStat.size || pendingStat.nlink !== 2) {
      throw new Error('lifecycle WAL has an unowned additional hard link')
    }
  } else if (!isPublished && finalStat.nlink === 2) {
    const publishedStat = lstatOptional(paths.lifecycleWalPath)
    if (!publishedStat?.isFile() || publishedStat.isSymbolicLink()
      || publishedStat.dev !== finalStat.dev || publishedStat.ino !== finalStat.ino
      || publishedStat.size !== finalStat.size || publishedStat.nlink !== 2) {
      throw new Error('lifecycle WAL pending file has an unowned additional hard link')
    }
  } else if (finalStat.nlink !== 1) {
    throw new Error('lifecycle WAL has an unsafe link count')
  }
  return wal
}

function readLifecycleWal(paths: InstallPaths, host: InstallHost): LifecycleWalV1 | null {
  return readLifecycleWalFile(paths.lifecycleWalPath, paths, host)
}

type RecoverableRelease = {
  manifest: InstallManifestV2
  paths: InstallPaths
  identity: PackageIdentity
  artifacts: Map<string, string>
}

type LifecycleStageCandidate = {
  target: string
  exact: Buffer[]
  facts: Array<{ sha256: Sha256Digest; size: number }>
}

type VerifiedLifecycleStage = {
  file: string
  target: string
  bytes: Buffer
  stat: { dev: number; ino: number; size: number; mtimeMs: number; nlink: number }
}

function lifecycleStageCandidates(
  paths: InstallPaths,
  wal: LifecycleWalV1,
  releases: readonly RecoverableRelease[]
): Map<string, LifecycleStageCandidate> {
  const candidates = new Map<string, LifecycleStageCandidate>()
  const add = (
    target: string,
    value?: Buffer | string | null,
    fact?: { sha256: Sha256Digest; size: number }
  ) => {
    const absolute = resolve(target)
    const stage = lifecycleStagePath(absolute, wal)
    const candidate = candidates.get(stage) || { target: absolute, exact: [], facts: [] }
    if (value !== undefined && value !== null) {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8')
      if (!candidate.exact.some((entry) => entry.equals(bytes))) candidate.exact.push(bytes)
    }
    if (fact && !candidate.facts.some((entry) => entry.sha256 === fact.sha256 && entry.size === fact.size)) {
      candidate.facts.push(fact)
    }
    candidates.set(stage, candidate)
  }
  for (const release of releases) {
    add(release.paths.manifestPath, recordBytes(release.manifest))
    for (const [file, content] of release.artifacts) add(file, content)
    for (const relativePath of PUBLIC_RUNTIME_FILES) {
      const fact = release.identity.publicRuntimeFacts.find((entry) => entry.path === relativePath)
      add(
        join(release.paths.dataRoot, ...relativePath.split('/')),
        release.identity.publicRuntime.get(relativePath) || null,
        fact
      )
    }
    for (const file of layoutSpec(release.paths.dataRoot, pathApi).files) add(file.path, file.content)
  }
  for (const marker of [wal.oldMarker, wal.newMarker].filter(Boolean) as DataRootMarkerV1[]) {
    add(paths.dataMarkerPath, recordBytes(marker))
    for (const fact of marker.runtime.files) {
      add(join(paths.dataRoot, ...fact.path.split('/')), undefined, fact)
    }
  }
  for (const phase of (wal.operation === 'upgrade'
    ? ['prepared', 'switched', 'committed']
    : ['prepared', 'committed']) as LifecycleWalV1['phase'][]) {
    add(paths.lifecycleWalPath, recordBytes({ ...wal, phase }))
  }
  return candidates
}

function assertLifecycleStageClosure(
  paths: InstallPaths,
  wal: LifecycleWalV1,
  releases: readonly RecoverableRelease[]
): VerifiedLifecycleStage[] {
  const candidates = lifecycleStageCandidates(paths, wal, releases)
  const known = new Set([...candidates.keys()].map((file) => resolve(file)))
  const inspectNames = (root: string, recursive: boolean, limit: number) => {
    if (!lstatOptional(root)) return
    const pending = [resolve(root)]
    let entries = 0
    while (pending.length > 0) {
      const directory = pending.pop() as string
      assertPlainDirectory(directory, 'lifecycle staging inventory directory')
      for (const entry of boundedDirectoryEntries(directory, limit, 'lifecycle staging inventory')) {
        entries += 1
        if (entries > limit) throw new Error('lifecycle staging inventory exceeds its bound')
        const absolute = join(directory, entry.name)
        if (entry.isSymbolicLink()) throw new Error(`lifecycle staging inventory contains a reparse entry: ${absolute}`)
        if (entry.isDirectory()) {
          if (recursive) pending.push(absolute)
          continue
        }
        if (isLifecycleStageName(entry.name) && !known.has(resolve(absolute))) {
          throw new Error(`lifecycle WAL found an unbound staging artifact: ${absolute}`)
        }
      }
    }
  }
  // The install tree is product-owned and small. The data root contains an
  // unbounded private corpus, so only its fixed top-level marker namespace is
  // inventoried; every product-owned nested target is checked by exact path
  // below without reading unrelated user files.
  inspectNames(paths.installDir, true, 256)
  inspectNames(paths.dataRoot, false, 10_000)
  const verified: VerifiedLifecycleStage[] = []
  for (const [file, candidate] of candidates) {
    const stat = lstatOptional(file)
    if (!stat) continue
    if (!stat.isFile() || stat.isSymbolicLink()
      || stat.nlink < 1 || stat.nlink > 2 || stat.size > 64 * 1024 * 1024) {
      throw new Error(`lifecycle staging artifact is unsafe: ${file}`)
    }
    if (stat.nlink === 2) {
      const targetStat = lstatOptional(candidate.target)
      if (!targetStat?.isFile() || targetStat.isSymbolicLink()
        || targetStat.nlink !== 2 || targetStat.dev !== stat.dev || targetStat.ino !== stat.ino
        || targetStat.size !== stat.size || targetStat.mtimeMs !== stat.mtimeMs) {
        throw new Error(`lifecycle staging artifact has an unbound hard link: ${file}`)
      }
      verifiedLifecycleLinkedTargets.set(resolve(candidate.target), { stage: file, dev: stat.dev, ino: stat.ino })
    }
    const bytes = readBoundedPlainFile(file, 64 * 1024 * 1024, 'lifecycle staging artifact', stat.nlink === 2)
    const digest = sha256Bytes(bytes)
    const complete = candidate.exact.some((entry) => entry.equals(bytes))
      || candidate.facts.some((fact) => fact.size === bytes.length && fact.sha256 === digest)
    const partial = candidate.exact.some((entry) => bytes.length < entry.length && entry.subarray(0, bytes.length).equals(bytes))
    if (!complete && !partial) {
      throw new Error(`lifecycle staging artifact has foreign bytes: ${file}`)
    }
    verified.push({
      file,
      target: candidate.target,
      bytes,
      stat: { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, nlink: stat.nlink }
    })
  }
  return verified
}

function removeVerifiedLifecycleStages(
  stages: readonly VerifiedLifecycleStage[],
  authority: LifecycleWriteAuthority
): void {
  for (const stage of stages) {
    const fence = lifecycleMutationFenceFor(stage.target, authority)
    assertLifecycleDirectoryFence(dirname(stage.file), fence)
    const current = fs.lstatSync(stage.file)
    if (!current.isFile() || current.isSymbolicLink()
      || current.dev !== stage.stat.dev || current.ino !== stage.stat.ino
      || current.size !== stage.stat.size || current.mtimeMs !== stage.stat.mtimeMs
      || current.nlink !== stage.stat.nlink
      || !readBoundedPlainFile(stage.file, stage.bytes.length, 'lifecycle staging removal', stage.stat.nlink === 2).equals(stage.bytes)) {
      throw new Error(`lifecycle staging artifact changed before cleanup: ${stage.file}`)
    }
    fs.unlinkSync(stage.file)
    if (stage.stat.nlink === 2) {
      const target = fs.lstatSync(stage.target)
      if (!target.isFile() || target.isSymbolicLink() || target.nlink !== 1
        || target.dev !== stage.stat.dev || target.ino !== stage.stat.ino) {
        throw new Error(`lifecycle staging target did not collapse to a unique file: ${stage.target}`)
      }
      verifiedLifecycleLinkedTargets.delete(resolve(stage.target))
    }
  }
}

function recoverableRelease(
  manifest: InstallManifestV2,
  currentPaths: InstallPaths,
  host: InstallHost,
  environment: FrozenInstallEnvironment,
  label: string
): RecoverableRelease {
  const paths = pathsForManifest(manifest, currentPaths, host)
  const identity = packageIdentity(manifest.packageRoot)
  if (identity.sha256 !== manifest.packageSha256 || identity.version !== manifest.packageVersion) {
    throw new Error(`lifecycle WAL ${label} package identity changed`)
  }
  const trace = preflightDaemonTraceEnvironment(environment, host.platform, paths.dataRoot)
  const artifacts = renderedArtifacts(paths, trace, manifest.features.path, host)
  if (canonicalJson(ownedArtifactFacts(artifacts))
    !== canonicalJson([...manifest.owned.files].sort((a, b) => a.path.localeCompare(b.path)))) {
    throw new Error(`lifecycle WAL ${label} artifact inventory cannot be reproduced`)
  }
  return { manifest, paths, identity, artifacts }
}

function assertLifecycleExternalArtifactsCurrent(wal: LifecycleWalV1, terminal: boolean): void {
  for (const artifact of wal.externalArtifacts) {
    const current = captureExternalArtifactFact(artifact.path)
    const slot = externalDeleteSlot(artifact.path, wal.walId)
    const slotExists = lstatOptional(slot) !== null
    if (artifact.action === 'delete-exact') {
      const stillOwned = current?.kind === 'file' && current.nlink === 1 && current.sha256 === artifact.ownedSha256
      if (terminal ? current !== null : current !== null && !stillOwned) {
        throw new Error(`lifecycle WAL external delete target changed: ${artifact.path}`)
      }
    } else if (!sameExternalArtifactFact(current, artifact.before)) {
      throw new Error(`lifecycle WAL preserved external artifact changed: ${artifact.path}`)
    }
    if (terminal && slotExists) {
      throw new Error(`lifecycle WAL external artifact still has an isolated delete slot: ${artifact.path}`)
    }
  }
}

function assertArtifactClosure(releases: readonly RecoverableRelease[], wal: LifecycleWalV1): void {
  const allowed = new Map<string, Set<Sha256Digest>>()
  for (const release of releases) {
    for (const [file, content] of release.artifacts) {
      const hashes = allowed.get(resolve(file)) || new Set<Sha256Digest>()
      hashes.add(sha256Bytes(content))
      allowed.set(resolve(file), hashes)
    }
  }
  const external = new Map(wal.externalArtifacts.map((entry) => [resolve(entry.path), entry]))
  for (const [file, hashes] of allowed) {
    const action = external.get(resolve(file))
    if (wal.operation === 'uninstall' && action) {
      const current = captureExternalArtifactFact(file)
      if (action.action === 'delete-exact') {
        const exactOwned = current?.kind === 'file' && current.nlink === 1 && current.sha256 === action.ownedSha256
        if (current !== null && !exactOwned) {
          throw new Error(`lifecycle WAL external delete target contains foreign bytes: ${file}`)
        }
      } else if (!sameExternalArtifactFact(current, action.before)) {
        throw new Error(`lifecycle WAL preserved external artifact changed: ${file}`)
      }
      continue
    }
    if (!fs.existsSync(file)) {
      if (wal.operation === 'upgrade') throw new Error(`lifecycle WAL owned artifact is missing: ${file}`)
      continue
    }
    if (!hashes.has(sha256File(file))) throw new Error(`lifecycle WAL recovery found foreign artifact bytes: ${file}`)
  }
}

function assertExternalDeleteSlotClosure(
  release: RecoverableRelease,
  wal: LifecycleWalV1
): Array<{ source: string; slot: string; sha256: Sha256Digest; linkedPair: boolean }> {
  if (wal.operation !== 'uninstall' || !wal.oldManifest) return []
  const output: Array<{ source: string; slot: string; sha256: Sha256Digest; linkedPair: boolean }> = []
  const actions = new Map(wal.externalArtifacts.map((entry) => [resolve(entry.path), entry]))
  for (const entry of wal.oldManifest.owned.files) {
    if (isSameOrInside(release.paths.installDir, entry.path, process.platform)) continue
    const source = resolve(entry.path)
    const slot = externalDeleteSlot(source, wal.walId)
    const sourceExists = fs.existsSync(source)
    const slotExists = fs.existsSync(slot)
    const action = actions.get(source)
    if (!action) throw new Error(`lifecycle WAL omits external artifact action: ${source}`)
    if (action.action !== 'delete-exact') {
      if (slotExists) throw new Error(`preserved external artifact has a private delete slot: ${source}`)
      if (!sameExternalArtifactFact(captureExternalArtifactFact(source), action.before)) {
        throw new Error(`preserved external artifact changed during lifecycle recovery: ${source}`)
      }
      continue
    }
    if (sourceExists && slotExists) {
      const sourceStat = fs.lstatSync(source)
      const slotStat = fs.lstatSync(slot)
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink()
        || !slotStat.isFile() || slotStat.isSymbolicLink()
        || sourceStat.dev !== slotStat.dev || sourceStat.ino !== slotStat.ino
        || sourceStat.nlink !== 2 || slotStat.nlink !== 2
        || sha256File(source, 64 * 1024 * 1024, true) !== entry.sha256
        || sha256File(slot, 64 * 1024 * 1024, true) !== entry.sha256) {
        throw new Error('lifecycle WAL external artifact exists in two foreign namespaces')
      }
      output.push({ source, slot, sha256: entry.sha256, linkedPair: true })
      continue
    }
    if (sourceExists && sha256File(source) !== entry.sha256) {
      throw new Error(`lifecycle WAL external artifact contains foreign bytes: ${source}`)
    }
    if (slotExists) {
      assertPlainFile(slot, 'lifecycle WAL isolated external artifact')
      if (sha256File(slot) !== entry.sha256) {
        throw new Error(`lifecycle WAL isolated external artifact contains foreign bytes: ${slot}`)
      }
      output.push({ source, slot, sha256: entry.sha256, linkedPair: false })
    }
  }
  return output
}

function markerBytes(marker: DataRootMarkerV1 | null): Buffer | null {
  return marker ? recordBytes(marker) : null
}

function manifestBytes(manifest: InstallManifestV2 | null): Buffer | null {
  return manifest ? recordBytes(manifest) : null
}

function assertWalFileClosures(paths: InstallPaths, wal: LifecycleWalV1): void {
  const manifests = wal.operation === 'setup'
    ? [null, manifestBytes(wal.newManifest)]
    : wal.operation === 'upgrade'
      ? [manifestBytes(wal.oldManifest), manifestBytes(wal.newManifest)]
      : [manifestBytes(wal.oldManifest), null]
  assertCurrentFileAllowed(paths.manifestPath, manifests, 'lifecycle WAL install manifest')
  const markers = [markerBytes(wal.oldMarker), markerBytes(wal.newMarker)]
    .filter((value, index, all) => all.findIndex((other) => sameOptionalBuffer(value, other)) === index)
  assertCurrentFileAllowed(paths.dataMarkerPath, markers, 'lifecycle WAL data-root marker')
}

function runtimeAllowedBytes(
  paths: InstallPaths,
  wal: LifecycleWalV1,
  releases: readonly RecoverableRelease[],
  relativePath: string
): Array<Buffer | null> {
  const output: Array<Buffer | null> = []
  if (!wal.oldMarker) output.push(null)
  if (wal.oldMarker) {
    const recorded = wal.oldMarker.runtime.files.find((entry) => entry.path === relativePath)
    const current = join(paths.dataRoot, ...relativePath.split('/'))
    if (!recorded) throw new Error(`lifecycle WAL prior marker omits ${relativePath}`)
    if (fs.existsSync(current) && sha256File(current) === recorded.sha256) output.push(fs.readFileSync(current))
  }
  for (const release of releases) {
    const source = Buffer.from(release.identity.publicRuntime.get(relativePath) as Buffer)
    if (!output.some((candidate) => candidate !== null && candidate.equals(source))) output.push(source)
  }
  return output
}

function assertRuntimeClosure(paths: InstallPaths, wal: LifecycleWalV1): void {
  for (const relativePath of PUBLIC_RUNTIME_FILES) {
    const current = join(paths.dataRoot, ...relativePath.split('/'))
    const bytes = currentFileBytes(current)
    if (bytes === null) {
      if (wal.oldMarker !== null) throw new Error(`lifecycle WAL public runtime is missing: ${relativePath}`)
      continue
    }
    const digest = sha256Bytes(bytes)
    const allowed = [wal.oldMarker, wal.newMarker].filter(Boolean).map((marker) => {
      const entry = marker!.runtime.files.find((candidate) => candidate.path === relativePath)
      if (!entry) throw new Error(`lifecycle WAL runtime marker omits ${relativePath}`)
      return entry.sha256
    })
    if (!allowed.includes(digest)) throw new Error(`lifecycle WAL found foreign public runtime bytes: ${relativePath}`)
  }
}

function assertLifecycleIntegrationClosure(paths: InstallPaths, wal: LifecycleWalV1, host: InstallHost): void {
  if (wal.oldIntegration.userPath.managed !== wal.newIntegration.userPath.managed
    || wal.oldIntegration.task.managed !== wal.newIntegration.task.managed) {
    throw new Error('lifecycle WAL changes integration ownership flags')
  }
  const current = currentLifecycleIntegration(paths, host, {
    path: wal.oldIntegration.userPath.managed,
    task: wal.oldIntegration.task.managed
  })
  if (canonicalJson(current.userPath) !== canonicalJson(wal.oldIntegration.userPath)
    && canonicalJson(current.userPath) !== canonicalJson(wal.newIntegration.userPath)) {
    throw new Error('lifecycle WAL found foreign user PATH bytes')
  }
  for (const name of LIFECYCLE_ENV_NAMES) {
    const currentValue = current.environment.find((entry) => entry.name === name)!
    const oldValue = wal.oldIntegration.environment.find((entry) => entry.name === name)!
    const newValue = wal.newIntegration.environment.find((entry) => entry.name === name)!
    if (canonicalJson(currentValue) !== canonicalJson(oldValue)
      && canonicalJson(currentValue) !== canonicalJson(newValue)) {
      throw new Error(`lifecycle WAL found foreign user environment ${name}`)
    }
  }
  const task = canonicalJson(current.task)
  const taskMayBeClosed = Boolean(wal.oldManifest?.owned.task?.created || wal.newManifest?.owned.task?.created)
    && !(wal.operation === 'uninstall'
      && canonicalJson(wal.oldIntegration.task) === canonicalJson(wal.newIntegration.task))
  const closedTask = canonicalJson({ managed: true, exists: false, action: '' })
  if (task !== canonicalJson(wal.oldIntegration.task) && task !== canonicalJson(wal.newIntegration.task)
    && !(taskMayBeClosed && task === closedTask)) {
    throw new Error('lifecycle WAL found foreign scheduled task state')
  }
}

async function closeWalBoundTaskRestartSource(
  paths: InstallPaths,
  wal: LifecycleWalV1,
  host: InstallHost,
  revalidate: () => Promise<void>
): Promise<boolean> {
  const task = wal.oldManifest?.owned.task || wal.newManifest?.owned.task
  if (!task?.created) return false
  if (wal.operation === 'uninstall'
    && canonicalJson(wal.oldIntegration.task) === canonicalJson(wal.newIntegration.task)) {
    return false
  }
  const current = currentLifecycleIntegration(paths, host, { path: false, task: true }).task
  if (!current.exists) return false
  if (current.action.toLowerCase() !== expectedTaskAction(task.launcher).toLowerCase()) {
    throw new Error('WAL-bound scheduled task changed before closing its daemon restart source')
  }
  await revalidate()
  assertLifecycleIntegrationClosure(paths, wal, host)
  const exact = currentLifecycleIntegration(paths, host, { path: false, task: true }).task
  if (!exact.exists || exact.action.toLowerCase() !== expectedTaskAction(task.launcher).toLowerCase()) {
    throw new Error('WAL-bound scheduled task changed at its removal boundary')
  }
  host.unregisterTask(task.name, task.launcher)
  if (host.taskExists(task.name)) throw new Error(`failed to close scheduled task restart source ${task.name}`)
  return true
}

async function applyLifecycleIntegrationTarget(
  paths: InstallPaths,
  wal: LifecycleWalV1,
  manifest: InstallManifestV2,
  target: LifecycleIntegrationStateV1,
  host: InstallHost,
  revalidate: () => Promise<void>
): Promise<void> {
  assertLifecycleIntegrationClosure(paths, wal, host)
  let broadcast = false
  if (target.userPath.managed) {
    const targetUserPath = lifecycleUserPathValue(target.userPath)
    const oldUserPath = lifecycleUserPathValue(wal.oldIntegration.userPath)
    const newUserPath = lifecycleUserPathValue(wal.newIntegration.userPath)
    if (!sameUserPathState(host.userPathState(), targetUserPath)) {
      await revalidate()
      assertLifecycleIntegrationClosure(paths, wal, host)
      const current = host.userPathState()
      if (!sameUserPathState(current, oldUserPath)
        && !sameUserPathState(current, newUserPath)) {
        throw new Error('lifecycle WAL lost PATH compare-exchange authority')
      }
      const next = { exists: target.userPath.exists, value: target.userPath.value, kind: target.userPath.kind }
      if (!host.compareExchangeUserPath(current, next)
        || !sameUserPathState(host.userPathState(), next)) {
        throw new Error('lifecycle WAL PATH recovery postcondition failed')
      }
      broadcast = true
    }
    for (const entry of target.environment) {
      const desired = { exists: entry.exists, value: entry.value, kind: entry.kind }
      const current = host.userEnvState(entry.name)
      if (sameUserEnvironmentState(current, desired)) continue
      await revalidate()
      assertLifecycleIntegrationClosure(paths, wal, host)
      const expectedCurrent = host.userEnvState(entry.name)
      const oldValue = wal.oldIntegration.environment.find((candidate) => candidate.name === entry.name)!
      const newValue = wal.newIntegration.environment.find((candidate) => candidate.name === entry.name)!
      if (!sameUserEnvironmentState(expectedCurrent, oldValue)
        && !sameUserEnvironmentState(expectedCurrent, newValue)
        || !host.compareExchangeUserEnv(entry.name, expectedCurrent, desired)) {
        throw new Error(`lifecycle WAL environment recovery lost compare-exchange authority: ${entry.name}`)
      }
      if (!sameUserEnvironmentState(host.userEnvState(entry.name), desired)) {
        throw new Error(`lifecycle WAL environment recovery postcondition failed: ${entry.name}`)
      }
      broadcast = true
    }
  }
  if (target.task.managed) {
    const currentTask = currentLifecycleIntegration(paths, host, { path: false, task: true }).task
    if (canonicalJson(currentTask) === canonicalJson(target.task)) {
      if (broadcast) host.broadcastEnv()
      return
    }
    await revalidate()
    assertLifecycleIntegrationClosure(paths, wal, host)
    const ownedTask = manifest.owned.task
    if (target.task.exists) {
      if (!ownedTask || target.task.action.toLowerCase() !== expectedTaskAction(ownedTask.launcher).toLowerCase()) {
        throw new Error('lifecycle WAL target task has no owned launcher binding')
      }
      host.registerLogonTask(ownedTask.name, ownedTask.launcher)
    } else {
      if (!ownedTask) throw new Error('lifecycle WAL cannot remove an unbound scheduled task')
      host.unregisterTask(ownedTask.name, ownedTask.launcher)
    }
  }
  if (broadcast) host.broadcastEnv()
  assertLifecycleIntegrationCurrent(paths, host, target, 'lifecycle WAL recovery')
}

function assertUninstallTombstoneClosure(
  paths: InstallPaths,
  wal: LifecycleWalV1,
  requireComplete = false
): { exists: boolean; empty: boolean; entries: PlainTreeEntry[]; expectedHashes: ReadonlyMap<string, Sha256Digest> } {
  if (wal.operation !== 'uninstall' || !wal.oldManifest || !wal.tombstone) {
    return { exists: false, empty: true, entries: [], expectedHashes: new Map() }
  }
  const rootExists = fs.existsSync(wal.tombstone)
  const quarantine = frozenDeleteQuarantine(wal.tombstone)
  const quarantineExists = fs.existsSync(quarantine)
  assertSafeRecursiveRoot(wal.tombstone, 'uninstall tombstone', [paths.installDir, paths.dataRoot, paths.packageRoot], process.platform)
  assertSafeRecursiveRoot(quarantine, 'uninstall delete quarantine', [paths.installDir, paths.dataRoot, paths.packageRoot], process.platform)
  const expected = new Map<string, Sha256Digest>()
  for (const entry of wal.oldManifest.owned.files) {
    if (isSameOrInside(paths.installDir, entry.path, process.platform)) {
      expected.set(relative(paths.installDir, entry.path).split(sep).join('/'), entry.sha256)
    }
  }
  expected.set('install.json', sha256Bytes(recordBytes(wal.oldManifest)))
  const entries = rootExists ? walkPlainTree(wal.tombstone) : []
  const actualFiles = new Set<string>()
  for (const entry of entries) {
    if (entry.kind === 'directory') {
      if (entry.path !== 'bin/') throw new Error(`uninstall tombstone contains an unknown directory: ${entry.path}`)
    } else {
      actualFiles.add(entry.path)
      if (expected.get(entry.path) !== entry.sha256) {
        throw new Error(`uninstall tombstone contains foreign or changed bytes: ${entry.path}`)
      }
    }
  }
  const deleteState = inspectFrozenDeleteState(wal.tombstone, entries, expected, true)
  if (requireComplete && (deleteState.slots.size !== 0
    || actualFiles.size !== expected.size
    || [...expected.keys()].some((file) => !actualFiles.has(file)))) {
    throw new Error('uninstall tombstone is not the exact frozen install tree')
  }
  return {
    exists: rootExists || quarantineExists,
    empty: entries.length === 0 && deleteState.slots.size === 0,
    entries,
    expectedHashes: expected
  }
}

function daemonHeartbeatStructurallyBinds(
  heartbeat: Record<string, unknown> | null,
  expected: { pid: number; apiPid: number; packageRoot: string; dataRoot: string; port: number }
): boolean {
  const at = Date.parse(String(heartbeat?.lastBeat || ''))
  return Number.isFinite(at) && heartbeatBindsInstance(heartbeat, expected, 2, at + 1)
}

function assertNoForeignLiveLifecycleProcess(paths: InstallPaths, host: InstallHost, allowedPackageRoots: readonly string[]): void {
  const markers = inspectDaemonMarkerSet(paths.dataRoot)
  if (markers.kind === 'partial') {
    throw new Error('lifecycle found an incomplete daemon marker set')
  }
  if (markers.kind === 'absent') return
  const livePids = [...new Set([
    markers.pid,
    markers.apiPid,
    markers.advertisedPid,
    markers.advertisedApiPid
  ].filter((pid) => pid > 0 && host.pidAlive(pid)))]
  if (livePids.length === 0) return
  const boundPackage = allowedPackageRoots.find((packageRoot) => daemonHeartbeatStructurallyBinds(markers.heartbeat, {
    pid: markers.pid,
    apiPid: markers.apiPid,
    packageRoot,
    dataRoot: paths.dataRoot,
    port: paths.port
  }))
  if (!boundPackage || livePids.some((pid) => {
    const daemonRole = pid === markers.pid || pid === markers.advertisedPid
    const apiRole = pid === markers.apiPid || pid === markers.advertisedApiPid
    return !((!daemonRole || daemonProcessMatches(host, pid, boundPackage))
      && (!apiRole || apiProcessMatches(host, pid, boundPackage)))
  })) {
    throw new Error('lifecycle WAL found a foreign live daemon/API process')
  }
}

async function sealDaemonLifecycleStateBeforeMutation(
  paths: InstallPaths,
  host: InstallHost,
  packageRoot: string,
  port: number,
  revalidate: () => Promise<void>
): Promise<boolean> {
  const markers = inspectDaemonMarkerSet(paths.dataRoot)
  const listenerPresent = await loopbackListenerPresent(port)
  await revalidate()
  assertDaemonMarkerSetCurrent(paths.dataRoot, markers)
  if (markers.kind === 'partial') {
    throw new Error('daemon marker set is incomplete before lifecycle mutation')
  }
  if (markers.kind === 'absent') {
    if (listenerPresent) throw new Error('daemon API listener is active without its marker authority')
    return false
  }
  if (!daemonHeartbeatStructurallyBinds(markers.heartbeat, {
    pid: markers.pid,
    apiPid: markers.apiPid,
    packageRoot,
    dataRoot: paths.dataRoot,
    port
  })) {
    throw new Error('daemon marker set does not bind the lifecycle installation')
  }
  const daemonAlive = host.pidAlive(markers.pid)
  const apiAlive = host.pidAlive(markers.apiPid)
  if (daemonAlive && !daemonProcessMatches(host, markers.pid, packageRoot)
    || apiAlive && !apiProcessMatches(host, markers.apiPid, packageRoot)) {
    throw new Error('daemon marker set identifies a foreign live process')
  }
  if (listenerPresent && (!apiAlive || !apiProcessMatches(host, markers.apiPid, packageRoot))) {
    throw new Error('daemon API listener has no exact live process authority')
  }
  return daemonAlive || apiAlive
}

function assertInstalledTerminalSynchronous(
  release: RecoverableRelease,
  marker: DataRootMarkerV1,
  host: InstallHost,
  uninstallRollbackWal?: LifecycleWalV1
): void {
  const currentIdentity = packageIdentity(release.identity.packageRoot)
  if (currentIdentity.sha256 !== release.identity.sha256 || currentIdentity.version !== release.identity.version) {
    throw new Error('installed package changed before terminal lifecycle validation')
  }
  assertCurrentFileAllowed(release.paths.manifestPath, [recordBytes(release.manifest)], 'installed manifest postcondition')
  assertCurrentFileAllowed(release.paths.dataMarkerPath, [recordBytes(marker)], 'installed marker postcondition')
  for (const [file, content] of release.artifacts) {
    const action = uninstallRollbackWal?.operation === 'uninstall'
      ? uninstallRollbackWal.externalArtifacts.find((entry) => samePath(entry.path, file, host.platform))
      : undefined
    if (action?.action === 'preserve-absent') {
      if (captureExternalArtifactFact(file) !== null) {
        throw new Error(`preserved absent external artifact appeared before rollback terminal: ${file}`)
      }
      continue
    }
    if (action?.action === 'preserve-foreign') {
      assertExternalArtifactFactCurrent(file, action.before, `preserved external artifact ${file}`)
      continue
    }
    assertCurrentFileAllowed(file, [Buffer.from(content, 'utf8')], 'installed artifact postcondition')
    if (platformSupportsMode() && basename(file) === PRODUCT_COMMAND
      && (fs.lstatSync(file).mode & 0o111) === 0) {
      throw new Error(`installed command is not executable: ${file}`)
    }
  }
  for (const relativePath of PUBLIC_RUNTIME_FILES) {
    const source = Buffer.from(release.identity.publicRuntime.get(relativePath) as Buffer)
    assertCurrentFileAllowed(join(release.paths.dataRoot, ...relativePath.split('/')), [source], 'installed runtime postcondition')
  }
  if (!manifestIntegrationOwned(
    release.paths,
    release.manifest,
    host,
    uninstallRollbackWal?.operation === 'uninstall' ? 'uninstall' : 'strict'
  )) throw new Error('installed integration postcondition failed')
  assertPackageIdentityCurrent(release.identity, 'installed package terminal')
}

async function assertInstalledTerminal(
  release: RecoverableRelease,
  marker: DataRootMarkerV1,
  host: InstallHost,
  requireDaemon = release.manifest.features.daemon
): Promise<void> {
  assertInstalledTerminalSynchronous(release, marker, host)
  if (requireDaemon) {
    const status = await daemonStatus(release.manifest.packageRoot, host, release.manifest.dataRoot)
    if (!status.running || !status.apiHealthy) throw new Error('installed daemon postcondition failed')
  }
  assertInstalledTerminalSynchronous(release, marker, host)
}

async function assertInstalledWalTerminalSeal(
  release: RecoverableRelease,
  marker: DataRootMarkerV1,
  wal: LifecycleWalV1,
  host: InstallHost,
  lease: LifecycleLease,
  requireDaemon = release.manifest.features.daemon
): Promise<void> {
  await lease.revalidateApplicationGate()
  await assertInstalledTerminal(release, marker, host, requireDaemon)
  await lease.revalidateApplicationGate()
  assertInstalledTerminalSynchronous(release, marker, host)
  assertLifecycleIntegrationCurrent(release.paths, host, wal.newIntegration, 'terminal lifecycle seal')
  assertOwnedLifecycleProof(release.paths, host, ownedLifecycleProof(lease, wal))
}

function releaseForManifest(releases: readonly RecoverableRelease[], manifest: InstallManifestV2): RecoverableRelease | null {
  return releases.find((release) => canonicalJson(release.manifest) === canonicalJson(manifest)) || null
}

function assertCommittedUninstallTerminal(
  wal: LifecycleWalV1,
  releases: readonly RecoverableRelease[],
  host: InstallHost
): void {
  const prior = wal.oldManifest ? releaseForManifest(releases, wal.oldManifest) : null
  if (!prior || !wal.oldManifest || !wal.newMarker || !wal.tombstone) throw new Error('committed uninstall WAL is incomplete')
  if (fs.existsSync(prior.paths.installDir)
    || fs.existsSync(wal.tombstone)
    || fs.existsSync(frozenDeleteQuarantine(wal.tombstone))) {
    throw new Error('committed uninstall still has install residue')
  }
  assertCurrentFileAllowed(prior.paths.dataMarkerPath, [recordBytes(wal.newMarker)], 'committed uninstall marker')
  assertLifecycleExternalArtifactsCurrent(wal, true)
  assertNoForeignLiveLifecycleProcess(prior.paths, host, [])
  assertLifecycleIntegrationCurrent(prior.paths, host, wal.newIntegration, 'committed uninstall WAL')
}

type CommittedUninstallProtocolEpoch = {
  seal: () => void
  advanceReceipt: (target: LifecycleRootReceiptV1) => void
  advanceWalRemoval: () => void
}

function retireCommittedUninstallDaemonNamespace(
  paths: InstallPaths,
  host: InstallHost,
  sealCommittedAuthority: (daemonStagePresent: boolean) => void
): void {
  const protocolOptions = installedDaemonRuntimeOptions(paths, host)
  const inspection = inspectDaemonProtocol(protocolOptions)
  if (inspection.kind !== 'ABSENT' && inspection.kind !== 'NAMESPACE-RECOVERABLE') {
    throw new Error('committed uninstall recovery refuses daemon v1 authority or stage residue')
  }
  assertDaemonInspectionCurrent(inspection)

  const stageDirectory = inspection.paths.stageDirectory
  const fixedRuntimeFiles = [
    inspection.paths.pidProjection,
    inspection.paths.apiPidProjection,
    inspection.paths.heartbeatProjection,
    inspection.paths.finalInstance
  ] as const
  const absentFile: CapturedFileState = { bytes: null, stat: null }
  const assertFixedRuntimeAbsent = () => {
    for (const file of fixedRuntimeFiles) {
      assertCapturedFileState(file, absentFile, 'committed uninstall daemon terminal projection', 0)
    }
  }
  assertFixedRuntimeAbsent()

  const receiptNamespace = readLifecycleRootReceiptNamespace(host)
  const receiptDirectoryFence = captureDirectoryFence(receiptNamespace.directory)
  const stageParent = dirname(stageDirectory)
  const stageParentFence = captureDirectoryFence(stageParent)
  if (!receiptNamespace.daemonStageAuthorityMarker && !receiptNamespace.daemonStageNamespaceId) {
    if (inspection.namespaceId || lstatOptional(stageDirectory)) {
      throw new Error('committed uninstall recovery refuses daemon v1 authority or stage residue')
    }
    sealCommittedAuthority(false)
    assertDirectoryFence(stageParent, stageParentFence)
    assertDirectoryFence(receiptNamespace.directory, receiptDirectoryFence)
    flushDirectory(stageParent)
    flushDirectory(receiptNamespace.directory)
    assertDirectoryFence(stageParent, stageParentFence)
    assertDirectoryFence(receiptNamespace.directory, receiptDirectoryFence)
    if (lstatOptional(stageDirectory)) {
      throw new Error('committed uninstall daemon stage namespace reappeared during absence settle')
    }
    sealCommittedAuthority(false)
    assertFixedRuntimeAbsent()
    const terminalInspection = inspectDaemonProtocol(protocolOptions)
    if (terminalInspection.kind !== 'ABSENT' || terminalInspection.namespaceId) {
      throw new Error('committed uninstall daemon namespace absence did not remain exact')
    }
    assertDaemonInspectionCurrent(terminalInspection)
    return
  }
  if (!receiptNamespace.daemonStageAuthorityMarker
    || !receiptNamespace.daemonStageAuthorityMarkerState?.stat
    || !receiptNamespace.daemonStageNamespaceId
    || inspection.namespaceId !== receiptNamespace.daemonStageNamespaceId) {
    throw new Error('committed uninstall daemon stage authority is incomplete')
  }
  const homeMarker = receiptNamespace.daemonStageAuthorityMarker
  const homeMarkerState = receiptNamespace.daemonStageAuthorityMarkerState
  if (!homeMarkerState?.stat) {
    throw new Error('committed uninstall daemon HOME authority state is absent')
  }
  if (homeMarkerState.stat.nlink !== 1 || homeMarkerState.stat.size !== 0
    || homeMarkerState.bytes?.length !== 0) {
    throw new Error('committed uninstall daemon HOME authority is not a unique empty marker')
  }

  assertLocalLifecycleRoot(stageDirectory, 'committed uninstall daemon stage namespace', host.platform)
  assertOutsideProtectedRoots(stageDirectory, 'committed uninstall daemon stage namespace', host)
  physicalLifecyclePath(stageDirectory, 'committed uninstall daemon stage namespace', host.platform, false)
  const innerMarker = daemonInnerNamespaceMarker(inspection.paths, receiptNamespace.daemonStageNamespaceId)
  const stageEntry = lstatOptional(stageDirectory)
  if (stageEntry) {
    const stageDirectoryFence = captureDirectoryFence(stageDirectory)
    const stageState = capturePlainDirectoryState(
      stageDirectory,
      'committed uninstall daemon stage namespace',
      2
    )
    const expectedInnerName = basename(innerMarker)
    if (stageState.entries.length > 1
      || stageState.entries.some((entry) => entry !== expectedInnerName)) {
      throw new Error('committed uninstall recovery refuses daemon v1 authority or stage residue')
    }
    if (stageState.entries.length === 1) {
      const innerState = captureFileState(innerMarker, 0)
      if (!innerState.stat || innerState.stat.nlink !== 1 || innerState.stat.size !== 0
        || innerState.bytes?.length !== 0) {
        throw new Error('committed uninstall daemon inner authority is not a unique empty marker')
      }
      sealCommittedAuthority(true)
      assertLifecycleRootReceiptNamespaceExact(
        host,
        receiptNamespace,
        'committed uninstall daemon HOME authority before inner retirement'
      )
      assertDirectoryFence(stageParent, stageParentFence)
      assertDirectoryFence(stageDirectory, stageDirectoryFence)
      assertPlainDirectoryState(
        stageDirectory,
        stageState,
        'committed uninstall daemon stage namespace before inner retirement',
        2
      )
      assertCapturedFileState(innerMarker, innerState, 'committed uninstall daemon inner authority', 0)
      assertFixedRuntimeAbsent()
      fs.unlinkSync(innerMarker)
      flushDirectory(stageDirectory)
      assertDirectoryFence(stageDirectory, stageDirectoryFence)
      sealCommittedAuthority(true)
    }

    const emptyStageState = capturePlainDirectoryState(
      stageDirectory,
      'committed uninstall empty daemon stage namespace',
      1
    )
    if (emptyStageState.entries.length !== 0) {
      throw new Error('committed uninstall daemon stage namespace did not become empty')
    }
    sealCommittedAuthority(true)
    assertLifecycleRootReceiptNamespaceExact(
      host,
      receiptNamespace,
      'committed uninstall daemon HOME authority before stage retirement'
    )
    assertDirectoryFence(stageParent, stageParentFence)
    assertDirectoryFence(stageDirectory, stageDirectoryFence)
    assertPlainDirectoryState(
      stageDirectory,
      emptyStageState,
      'committed uninstall empty daemon stage namespace before retirement',
      1
    )
    assertFixedRuntimeAbsent()
    fs.rmdirSync(stageDirectory)
    flushDirectory(stageParent)
    sealCommittedAuthority(true)
  }

  assertDirectoryFence(stageParent, stageParentFence)
  if (lstatOptional(stageDirectory)) {
    throw new Error('committed uninstall daemon stage namespace retirement failed')
  }
  flushDirectory(stageParent)
  assertDirectoryFence(stageParent, stageParentFence)
  if (lstatOptional(stageDirectory)) {
    throw new Error('committed uninstall daemon stage namespace reappeared after durability settle')
  }
  sealCommittedAuthority(true)
  assertDirectoryFence(receiptNamespace.directory, receiptDirectoryFence)
  assertLifecycleRootReceiptNamespaceExact(
    host,
    receiptNamespace,
    'committed uninstall daemon HOME authority before retirement'
  )
  assertDirectoryFence(stageParent, stageParentFence)
  if (lstatOptional(stageDirectory)) {
    throw new Error('committed uninstall daemon stage namespace reappeared before HOME retirement')
  }
  assertCapturedFileState(homeMarker, homeMarkerState, 'committed uninstall daemon HOME authority', 0)
  assertFixedRuntimeAbsent()
  fs.unlinkSync(homeMarker)
  flushDirectory(receiptNamespace.directory)
  assertDirectoryFence(receiptNamespace.directory, receiptDirectoryFence)
  sealCommittedAuthority(false)

  const terminalReceipt = readLifecycleRootReceiptNamespace(host)
  if (terminalReceipt.daemonStageAuthorityMarker || terminalReceipt.daemonStageNamespaceId
    || lstatOptional(stageDirectory)) {
    throw new Error('committed uninstall daemon namespace retirement failed its terminal seal')
  }
  const terminalInspection = inspectDaemonProtocol(protocolOptions)
  if (terminalInspection.kind !== 'ABSENT' || terminalInspection.namespaceId) {
    throw new Error('committed uninstall daemon namespace retirement did not reach exact absence')
  }
  assertDaemonInspectionCurrent(terminalInspection)
}

function createCommittedUninstallProtocolEpoch(
  paths: InstallPaths,
  wal: LifecycleWalV1,
  host: InstallHost,
  expectedWalState?: CapturedFileState,
  expectedMarkerState?: CapturedFileState,
  expectedDataRootFence?: DirectoryFence,
  sealApplicationGate: () => void = () => {}
): CommittedUninstallProtocolEpoch {
  if (wal.operation !== 'uninstall' || wal.phase !== 'committed'
    || !wal.newMarker || wal.newMarker.activeInstallId !== null) {
    throw new Error('committed uninstall protocol epoch requires an inactive terminal WAL')
  }
  const target = assertLifecycleRootReceiptWalClosure(wal, host)
  let receiptNamespace = readLifecycleRootReceiptNamespace(host)
  const daemonRetirementReceipt = receiptNamespace
  const receiptAfterDaemonRetirement: LifecycleRootReceiptNamespace = {
    ...daemonRetirementReceipt,
    daemonStageNamespaceId: null,
    daemonStageAuthorityMarker: null,
    daemonStageAuthorityMarkerState: null
  }
  const receiptFenceTarget = receiptNamespace.directoryExists
    ? receiptNamespace.directory
    : dirname(receiptNamespace.directory)
  const receiptFence = captureDirectoryFence(receiptFenceTarget)
  const protocolFence = captureDirectoryFence(dirname(paths.lifecycleWalPath))
  const receiptMarkerPath = join(receiptNamespace.directory, LIFECYCLE_ROOT_RECEIPT_NAMESPACE_MARKER)
  const receiptMarkerState = receiptNamespace.markerState || { bytes: null, stat: null }
  const ownerStageAuthorityPath = receiptNamespace.ownerStageAuthorityMarker
  const ownerStageAuthorityState = receiptNamespace.ownerStageAuthorityMarkerState
    || { bytes: null, stat: null }
  const ownerPublication = readLifecycleOwnerPublicationHint(paths, host)
  if (!ownerPublication.record || ownerPublication.record.token !== wal.lockToken
    || ownerPublication.record.operation !== 'uninstall'
    || !ownerPublication.finalState.stat || ownerPublication.finalState.stat.nlink !== 1
    || ownerPublication.artifacts.length !== 0) {
    throw new Error('committed uninstall protocol epoch has no unique exact owner')
  }
  const markerState = expectedMarkerState || captureFileState(paths.dataMarkerPath, MARKER_MAX_BYTES)
  const dataRootFence = expectedDataRootFence || captureDirectoryFence(paths.dataRoot)
  let walState = expectedWalState || captureFileState(paths.lifecycleWalPath, LIFECYCLE_WAL_MAX_BYTES)
  let walPresent = true

  const sealDaemonRetirementAuthority = (daemonStagePresent: boolean) => {
    sealApplicationGate()
    preflightTerminalPreservedRootPaths(paths, target, host)
    assertDirectoryFence(paths.dataRoot, dataRootFence)
    assertDirectoryFence(dirname(paths.lifecycleWalPath), protocolFence)
    assertDirectoryFence(receiptFenceTarget, receiptFence)
    assertLifecycleRootReceiptNamespaceExact(
      host,
      daemonStagePresent ? daemonRetirementReceipt : receiptAfterDaemonRetirement,
      'committed uninstall daemon retirement receipt authority'
    )
    assertLifecycleOwnerPublicationHint(
      paths,
      host,
      ownerPublication,
      'committed uninstall daemon retirement owner authority'
    )
    assertCapturedFileState(
      paths.dataMarkerPath,
      markerState,
      'committed uninstall daemon retirement terminal data marker',
      MARKER_MAX_BYTES
    )
    if (canonicalJson(readDataRootMarker(paths, host.platform)) !== canonicalJson(wal.newMarker)) {
      throw new Error('committed uninstall daemon retirement terminal data marker changed')
    }
    assertCapturedFileState(
      paths.lifecycleWalPath,
      walState,
      'committed uninstall daemon retirement WAL authority',
      LIFECYCLE_WAL_MAX_BYTES
    )
    if (canonicalJson(readLifecycleWal(paths, host)) !== canonicalJson(wal)) {
      throw new Error('committed uninstall daemon retirement WAL changed')
    }
    sealApplicationGate()
  }
  retireCommittedUninstallDaemonNamespace(paths, host, sealDaemonRetirementAuthority)
  receiptNamespace = readLifecycleRootReceiptNamespace(host)
  if (receiptNamespace.daemonStageAuthorityMarker || receiptNamespace.daemonStageNamespaceId
    || lstatOptional(`${resolve(paths.dataRoot)}.daemon-instance-stages`)) {
    throw new Error('committed uninstall recovery refuses daemon v1 authority or stage residue')
  }

  const assertReceiptScaffold = () => {
    assertDirectoryFence(receiptFenceTarget, receiptFence)
    assertCapturedFileState(
      receiptMarkerPath,
      receiptMarkerState,
      'committed uninstall receipt namespace marker',
      0
    )
    if (ownerStageAuthorityPath) {
      assertCapturedFileState(
        ownerStageAuthorityPath,
        ownerStageAuthorityState,
        'committed uninstall owner-stage authority marker',
        0
      )
    }
  }
  const assertFixedProtocol = (includeReceipt: boolean, includeWal: boolean) => {
    sealApplicationGate()
    preflightTerminalPreservedRootPaths(paths, target, host)
    assertDirectoryFence(paths.dataRoot, dataRootFence)
    assertDirectoryFence(dirname(paths.lifecycleWalPath), protocolFence)
    assertReceiptScaffold()
    assertLifecycleOwnerPublicationHint(
      paths,
      host,
      ownerPublication,
      'committed uninstall lifecycle owner authority'
    )
    assertCapturedFileState(
      paths.dataMarkerPath,
      markerState,
      'committed uninstall terminal data marker',
      MARKER_MAX_BYTES
    )
    if (canonicalJson(readDataRootMarker(paths, host.platform)) !== canonicalJson(wal.newMarker)) {
      throw new Error('committed uninstall terminal data marker changed')
    }
    if (includeReceipt) {
      assertLifecycleRootReceiptNamespaceExact(
        host,
        receiptNamespace,
        'committed uninstall receipt authority'
      )
    }
    if (includeWal) {
      assertCapturedFileState(
        paths.lifecycleWalPath,
        walState,
        'committed uninstall WAL authority',
        LIFECYCLE_WAL_MAX_BYTES
      )
      if (canonicalJson(readLifecycleWal(paths, host)) !== canonicalJson(wal)) {
        throw new Error('committed uninstall WAL changed during terminal recovery')
      }
    }
    sealApplicationGate()
  }
  const seal = () => {
    assertFixedProtocol(true, walPresent)
    if (!walPresent && (lstatOptional(paths.lifecycleWalPath) || readLifecycleWal(paths, host))) {
      throw new Error('committed uninstall WAL reappeared after terminal removal')
    }
  }
  const advanceReceipt = (nextTarget: LifecycleRootReceiptV1) => {
    if (!sameLifecycleRootReceipt(nextTarget, target)) {
      throw new Error('committed uninstall receipt advance used another terminal target')
    }
    assertFixedProtocol(false, true)
    const next = readLifecycleRootReceiptNamespace(host)
    if (next.directory !== receiptNamespace.directory
      || next.homeIdentity !== receiptNamespace.homeIdentity
      || next.ownerStageNamespaceId !== receiptNamespace.ownerStageNamespaceId
      || next.ownerStageAuthorityMarker !== receiptNamespace.ownerStageAuthorityMarker
      || next.daemonStageNamespaceId !== receiptNamespace.daemonStageNamespaceId
      || next.daemonStageAuthorityMarker !== receiptNamespace.daemonStageAuthorityMarker
      || !sameLifecycleRootReceipt(next.receipt, target)
      || !next.receiptState?.stat || next.receiptState.stat.nlink !== 1
      || next.pendingState || next.writingState) {
      throw new Error('committed uninstall receipt advance did not reach its unique target')
    }
    receiptNamespace = next
    seal()
  }
  const advanceWalRemoval = () => {
    assertFixedProtocol(true, false)
    if (lstatOptional(paths.lifecycleWalPath) || readLifecycleWal(paths, host)) {
      throw new Error('committed uninstall WAL removal did not reach exact absence')
    }
    walPresent = false
    walState = { bytes: null, stat: null }
    seal()
  }
  const allowedReceipts = [wal.oldReceipt, wal.newReceipt].filter(Boolean) as LifecycleRootReceiptV1[]
  const observedReceipts = [receiptNamespace.receipt, receiptNamespace.pendingReceipt, receiptNamespace.writingReceipt]
    .filter(Boolean) as LifecycleRootReceiptV1[]
  if (observedReceipts.length === 0
    || observedReceipts.some((receipt) => !allowedReceipts.some((allowed) => sameLifecycleRootReceipt(receipt, allowed)))) {
    throw new Error('committed uninstall protocol epoch has no matching receipt publication')
  }
  seal()
  return { seal, advanceReceipt, advanceWalRemoval }
}

async function assertCommittedWalTerminal(
  wal: LifecycleWalV1,
  releases: readonly RecoverableRelease[],
  host: InstallHost,
  requireDaemon = true
): Promise<void> {
  if (wal.operation === 'setup' || wal.operation === 'upgrade') {
    const target = wal.newManifest ? releaseForManifest(releases, wal.newManifest) : null
    if (!target || !wal.newMarker) throw new Error('committed lifecycle WAL target is unavailable')
    await assertInstalledTerminal(target, wal.newMarker, host, requireDaemon && target.manifest.features.daemon)
    assertLifecycleIntegrationCurrent(target.paths, host, wal.newIntegration, 'committed lifecycle WAL')
    return
  }
  assertCommittedUninstallTerminal(wal, releases, host)
}

async function stopWalBoundLifecycleProcesses(
  paths: InstallPaths,
  releases: readonly RecoverableRelease[],
  wal: LifecycleWalV1,
  host: InstallHost,
  allowedHubOwner: ApplicationOwnerBinding | undefined,
  revalidateApplicationGate: () => Promise<void>,
  daemonStopDependencies: StopDaemonDependencies = {}
): Promise<void> {
  const owned = releases.filter((release) => release.manifest.features.daemon)
  assertNoForeignLiveLifecycleProcess(paths, host, owned.map((release) => release.manifest.packageRoot))
  for (const release of owned) {
    await revalidateApplicationGate()
    const lifecycleAuthority = daemonLifecycleControlAuthority(paths, host, wal.lockToken)
    if (!await stopInstalledDaemonRuntime(release.paths, host, lifecycleAuthority, daemonStopDependencies)) {
      throw new Error('cannot safely stop a WAL-bound daemon/API before lifecycle recovery')
    }
    await revalidateApplicationGate()
  }
  await revalidateApplicationGate()
  assertLegacyApplicationLeaseNamespaceClear(paths.dataRoot)
  assertApplicationQuiescent(paths.dataRoot, host, allowedHubOwner)
  assertNoForeignLiveLifecycleProcess(paths, host, [])
}

async function recoverLifecycleWalIfNeeded(
  currentPaths: InstallPaths,
  host: InstallHost,
  environment: FrozenInstallEnvironment,
  allowedHubOwner?: ApplicationOwnerBinding,
  revalidateApplicationGate: () => Promise<void> = async () => {},
  expectedWal?: {
    wal: LifecycleWalV1
    state: CapturedFileState
    terminalMarkerState?: CapturedFileState | null
    terminalDataRootFence?: DirectoryFence | null
  },
  daemonStopDependencies: StopDaemonDependencies = {}
): Promise<boolean> {
  if (expectedWal) {
    assertCapturedFileState(currentPaths.lifecycleWalPath, expectedWal.state, 'locked lifecycle WAL recovery snapshot')
  }
  const wal = readLifecycleWal(currentPaths, host)
  if (!wal) return false
  if (expectedWal && canonicalJson(wal) !== canonicalJson(expectedWal.wal)) {
    throw new Error('lifecycle WAL changed after its machine-mutex classification')
  }
  const receiptTarget = assertLifecycleRootReceiptWalClosure(wal, host)
  if (wal.operation === 'uninstall' && wal.phase === 'committed') {
    if (!wal.newMarker || wal.newMarker.activeInstallId !== null) {
      throw new Error('committed uninstall receipt has no inactive terminal marker')
    }
    if (expectedWal && (!expectedWal.terminalMarkerState || !expectedWal.terminalDataRootFence)) {
      throw new Error('committed uninstall recovery lost its acquired marker/root authority')
    }
    registerTerminalLifecycleProtocolMutationFence(currentPaths, wal)
    const protocolEpoch = createCommittedUninstallProtocolEpoch(
      currentPaths,
      wal,
      host,
      expectedWal?.state,
      expectedWal?.terminalMarkerState || undefined,
      expectedWal?.terminalDataRootFence || undefined
    )
    protocolEpoch.seal()
    ensureLifecycleRootReceipt(host, receiptTarget, [wal.oldReceipt, wal.newReceipt])
    protocolEpoch.advanceReceipt(receiptTarget)
    protocolEpoch.seal()
    removeLifecycleWal(currentPaths, wal)
    protocolEpoch.advanceWalRemoval()
    return true
  }
  const manifests = [wal.oldManifest, wal.newManifest].filter(Boolean) as InstallManifestV2[]
  const releases = manifests.map((manifest, index) => recoverableRelease(
    manifest,
    currentPaths,
    host,
    environment,
    index === 0 && wal.oldManifest ? 'prior' : 'target'
  ))
  const targetManifest = wal.operation === 'setup' ? wal.newManifest! : wal.oldManifest!
  const targetMarker = wal.operation === 'setup' ? wal.newMarker! : wal.oldMarker!
  const target = releaseForManifest(releases, targetManifest)
  if (!target) throw new Error('lifecycle WAL recovery target release is unavailable')
  registerLifecycleMutationFence(target.paths, wal)
  assertApplicationQuiescent(target.paths.dataRoot, host, allowedHubOwner)
  const lifecycleStages = assertLifecycleStageClosure(target.paths, wal, releases)
  assertWalFileClosures(target.paths, wal)
  assertArtifactClosure(releases, wal)
  const isolatedExternal = assertExternalDeleteSlotClosure(target, wal)
  assertRuntimeClosure(target.paths, wal)
  assertLifecycleIntegrationClosure(target.paths, wal, host)
  const tombstone = assertUninstallTombstoneClosure(target.paths, wal)
  if (wal.operation === 'uninstall' && fs.existsSync(target.paths.installDir) && tombstone.exists && !tombstone.empty) {
    throw new Error('uninstall recovery found both install root and non-empty tombstone')
  }
  ensureLifecycleRootReceipt(host, receiptTarget, [wal.oldReceipt, wal.newReceipt])
  await revalidateApplicationGate()
  assertLifecycleRootReceiptCurrentExact(host, receiptTarget)
  if (wal.phase === 'committed') {
    // A committed setup/upgrade is already the terminal byte/integration
    // authority. Do not close its autostart source or stop its owned daemon;
    // only repair an exited desired daemon and then consume the receipt.
    await assertCommittedWalTerminal(wal, releases, host, false)
    const terminal = wal.newManifest ? releaseForManifest(releases, wal.newManifest) : null
    if (!terminal || !wal.newMarker) throw new Error('committed lifecycle WAL terminal release disappeared')
    await revalidateApplicationGate()
    await assertInstalledTerminal(terminal, wal.newMarker, host, false)
    assertInstalledTerminalSynchronous(terminal, wal.newMarker, host)
    assertLifecycleIntegrationCurrent(terminal.paths, host, wal.newIntegration, 'committed recovery terminal seal')
    await revalidateApplicationGate()
    assertLifecycleRootReceiptCurrentExact(host, wal.newReceipt)
    if (allowedHubOwner) {
      assertOwnedLifecycleProof(currentPaths, host, {
        lockToken: wal.lockToken,
        applicationOwner: allowedHubOwner,
        wal
      })
    }
    removeLifecycleWal(currentPaths, wal)
    return true
  }
  await closeWalBoundTaskRestartSource(target.paths, wal, host, revalidateApplicationGate)
  await stopWalBoundLifecycleProcesses(
    target.paths,
    releases,
    wal,
    host,
    allowedHubOwner,
    revalidateApplicationGate,
    daemonStopDependencies
  )

  // Stages are consumed only after every WAL, filesystem, integration,
  // process, and writer closure has passed. Each unlink revalidates both the
  // application gate and the exact inode/bytes captured above.
  for (const stage of lifecycleStages) {
    await revalidateApplicationGate()
    removeVerifiedLifecycleStages([stage], wal)
  }

  // No mutation of any kind occurs before every filesystem, integration,
  // process, and application-writer closure above has passed.
  for (const isolated of isolatedExternal) {
    await revalidateApplicationGate()
    if (isolated.linkedPair) {
      const source = captureHashedFileState(isolated.source, 64 * 1024 * 1024, 'linked external artifact source', true)
      const slot = captureHashedFileState(isolated.slot, 64 * 1024 * 1024, 'linked external artifact slot', true)
      if (source.sha256 !== isolated.sha256 || slot.sha256 !== isolated.sha256
        || source.stat.dev !== slot.stat.dev || source.stat.ino !== slot.stat.ino
        || source.stat.nlink !== 2 || slot.stat.nlink !== 2) {
        throw new Error('linked external artifact pair changed during recovery')
      }
      assertCapturedHashedFileState(isolated.slot, slot, 'linked external artifact slot', true)
      lifecycleUnlinkSync(isolated.slot, wal, isolated.source)
      continue
    }
    if (fs.existsSync(isolated.source)) throw new Error('isolated external artifact source was recreated during recovery')
    assertPlainFile(isolated.slot, 'isolated external artifact recovery slot')
    if (sha256File(isolated.slot) !== isolated.sha256) {
      throw new Error('isolated external artifact changed during recovery')
    }
    lifecycleRenameSync(isolated.slot, isolated.source, wal, isolated.source)
  }

  await revalidateApplicationGate()
  if (wal.operation === 'uninstall' && wal.tombstone && tombstone.exists) {
    await removeFrozenTree(wal.tombstone, tombstone.entries, revalidateApplicationGate, {
      allowPartial: true,
      expectedHashes: tombstone.expectedHashes
    })
  }
  await revalidateApplicationGate()
  ensureLifecycleDirectory(target.paths.installDir, wal, target.paths.installDir)
  for (const directory of layoutSpec(target.paths.dataRoot, pathApi).dirs) {
    ensureLifecycleDirectory(directory, wal, directory)
  }
  for (const file of layoutSpec(target.paths.dataRoot, pathApi).files) {
    if (!fs.existsSync(file.path)) atomicWrite(file.path, file.content, wal)
  }
  for (const relativePath of PUBLIC_RUNTIME_FILES) {
    await revalidateApplicationGate()
    const destination = join(target.paths.dataRoot, ...relativePath.split('/'))
    const source = Buffer.from(target.identity.publicRuntime.get(relativePath) as Buffer)
    writeFileFromAllowed(destination, source, runtimeAllowedBytes(target.paths, wal, releases, relativePath), `lifecycle runtime ${relativePath}`, wal)
  }
  await revalidateApplicationGate()
  writeFileFromAllowed(
    target.paths.dataMarkerPath,
    recordBytes(targetMarker),
    [markerBytes(wal.oldMarker), markerBytes(wal.newMarker)],
    'lifecycle marker recovery',
    wal
  )
  for (const [file, content] of target.artifacts) {
    await revalidateApplicationGate()
    const externalAction = wal.operation === 'uninstall'
      ? wal.externalArtifacts.find((entry) => samePath(entry.path, file, host.platform))
      : undefined
    if (externalAction?.action === 'preserve-absent') {
      if (captureExternalArtifactFact(file) !== null) {
        throw new Error(`preserved absent external artifact appeared during recovery: ${file}`)
      }
      continue
    }
    if (externalAction?.action === 'preserve-foreign') {
      assertExternalArtifactFactCurrent(file, externalAction.before, `preserved external artifact ${file}`)
      continue
    }
    const allowed: Array<Buffer | null> = releases.flatMap((release) => {
      const candidate = release.artifacts.get(file)
      return candidate === undefined ? [] : [Buffer.from(candidate, 'utf8')]
    })
    if (wal.operation !== 'upgrade') allowed.push(null)
    writeFileFromAllowed(file, content, allowed, 'lifecycle artifact recovery', wal)
  }
  await revalidateApplicationGate()
  writeFileFromAllowed(
    target.paths.manifestPath,
    recordBytes(targetManifest),
    wal.operation === 'setup'
      ? [null, manifestBytes(wal.newManifest)]
      : [manifestBytes(wal.oldManifest), manifestBytes(wal.newManifest), null],
    'lifecycle manifest recovery',
    wal
  )
  await applyLifecycleIntegrationTarget(
    target.paths,
    wal,
    targetManifest,
    wal.operation === 'setup' ? wal.newIntegration : wal.oldIntegration,
    host,
    revalidateApplicationGate
  )
  if (wal.operation === 'uninstall') {
    assertInstalledTerminalSynchronous(target, targetMarker, host, wal)
  } else {
    await assertInstalledTerminal(target, targetMarker, host, false)
  }
  if (wal.tombstone && fs.existsSync(wal.tombstone)) throw new Error('lifecycle recovery left an uninstall tombstone')
  await revalidateApplicationGate()
  assertInstalledTerminalSynchronous(target, targetMarker, host, wal.operation === 'uninstall' ? wal : undefined)
  assertLifecycleIntegrationCurrent(target.paths, host, wal.operation === 'setup' ? wal.newIntegration : wal.oldIntegration, 'recovery terminal seal')
  await revalidateApplicationGate()
  assertLifecycleRootReceiptCurrentExact(host, receiptTarget)
  if (allowedHubOwner) {
    assertOwnedLifecycleProof(currentPaths, host, {
      lockToken: wal.lockToken,
      applicationOwner: allowedHubOwner,
      wal
    })
  }
  removeLifecycleWal(currentPaths, wal)
  return true
}

async function recoverLifecycleWalUnderLock(
  paths: InstallPaths,
  host: InstallHost,
  environment: FrozenInstallEnvironment,
  privateHooks: LifecycleRecoveryPrivateHooks = {}
): Promise<boolean> {
  if (!fs.existsSync(paths.lifecycleWalPath)) return false
  // The machine mutex, not this racy existence hint, classifies the recovery
  // authority and decides whether an Application gate is required.
  const lease = await acquireLifecycleLock(paths, host, 'recover', 'from-locked-wal')
  lease.assertPostPublicationAuthority()
  const wal = lease.recoveryWal
  if (!wal || !lease.recoveryWalState) {
    await lease.release()
    return false
  }
  const terminalUninstallReceipt = wal.operation === 'uninstall' && wal.phase === 'committed'
  const restartManifest = !terminalUninstallReceipt
    ? wal.phase === 'committed' || wal.operation === 'setup'
      ? wal.newManifest
      : wal.oldDaemonRunning ? wal.oldManifest : null
    : null
  let recovered = false
  try {
    if (terminalUninstallReceipt && privateHooks.checkpoint) {
      await privateHooks.checkpoint('after-committed-uninstall-acquire-authority')
      lease.assertPostPublicationAuthority()
    }
    // The pre-lock WAL read is only a fast-fail hint. Provider authority must
    // be derived again from the exact WAL adopted under the machine mutex,
    // before recovery can observe or mutate persistent integration state.
    assertLifecycleWalProvidersAvailable(wal, host)
    recovered = await recoverLifecycleWalIfNeeded(
      paths,
      host,
      environment,
      lease.applicationOwner || undefined,
      lease.revalidateApplicationGate,
      {
        wal,
        state: lease.recoveryWalState,
        terminalMarkerState: lease.recoveryTerminalMarkerState,
        terminalDataRootFence: lease.recoveryTerminalDataRootFence
      },
      privateHooks.daemonStop
    )
  } finally {
    await lease.release()
  }
  if (recovered && restartManifest?.features.daemon) {
    const started = await startDaemonDetached(restartManifest.packageRoot, host, restartManifest.dataRoot)
    if (!started.ok) throw new Error(`post-recovery daemon start failed: ${started.detail}`)
  }
  return recovered
}

function freezeInstallEnvironment(host: InstallHost): FrozenInstallEnvironment {
  return Object.freeze({ ...host.environment() })
}

function environmentBoundToManifestPaths(
  environment: FrozenInstallEnvironment,
  paths: InstallPaths
): FrozenInstallEnvironment {
  return Object.freeze({
    ...environment,
    [PRIMARY_DATA_ROOT_ENV]: paths.dataRoot,
    [LEGACY_DATA_ROOT_ENV]: paths.dataRoot,
    HUB_API_PORT: String(paths.port),
    SG_INSTALL_DIR: paths.installDir,
    SG_TASK_NAME: paths.taskName
  })
}

function resolveDataRootFromEnvironment(
  packageRoot: string,
  platform: NodeJS.Platform | string,
  environment: FrozenInstallEnvironment,
  dataRoot?: string,
  defaultDataRoot?: string
): string {
  if (!dataRoot && !environment[PRIMARY_DATA_ROOT_ENV] && !environment[LEGACY_DATA_ROOT_ENV] && defaultDataRoot) {
    return resolve(defaultDataRoot)
  }
  return resolveLocalDataRoot({
    packageRoot,
    dataRoot,
    environment: {
      SKILL_GRAFT_HOME: environment[PRIMARY_DATA_ROOT_ENV],
      HUB_ROOT: environment[LEGACY_DATA_ROOT_ENV]
    },
    platform
  })
}

export function resolveDataRoot(packageRoot: string, host: InstallHost = createInstallHost(), dataRoot?: string): string {
  return resolveDataRootFromEnvironment(
    packageRoot,
    host.platform,
    freezeInstallEnvironment(host),
    dataRoot,
    defaultInstallDataRoot(host)
  )
}

function defaultInstallDataRoot(host: InstallHost): string {
  if (host.platform === 'win32') return join(host.localAppData || join(host.home, 'AppData', 'Local'), DATA_ROOT_DIR_NAME)
  return join(host.home || homedir(), '.local', 'share', DATA_ROOT_DIR_NAME)
}

export function installPathsFor(
  packageRoot: string,
  host: InstallHost = createInstallHost(),
  dataRoot?: string,
  environment: FrozenInstallEnvironment = freezeInstallEnvironment(host),
  options: { resolveHostExtraShim?: boolean } = {}
) {
  const taskName = environment.SG_TASK_NAME || TASK_NAME
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(taskName)) {
    throw new Error('SG_TASK_NAME must be a safe 1-96 character task name')
  }
  const installDir = resolveInstallDir({
    platform: host.platform,
    home: host.home || homedir(),
    localAppData: host.localAppData,
    override: environment.SG_INSTALL_DIR
  })
  const extra = host.skipPath || !options.resolveHostExtraShim
    ? null
    : environment.SG_EXTRA_SHIM_DIR || host.extraShimDir()
  const rawPort = environment.HUB_API_PORT
  let port = API_PORT
  if (rawPort !== undefined) {
    if (!/^[1-9][0-9]{0,4}$/.test(rawPort)) throw new Error('HUB_API_PORT must be a canonical decimal port from 1 to 65535')
    port = Number(rawPort)
    if (port < 1 || port > 65_535 || String(port) !== rawPort) {
      throw new Error('HUB_API_PORT must be a canonical decimal port from 1 to 65535')
    }
  }
  return resolveInstallPaths(pathApi, {
    hubRoot: packageRoot,
    packageRoot,
    dataRoot: resolveDataRootFromEnvironment(
      packageRoot,
      host.platform,
      environment,
      dataRoot,
      defaultInstallDataRoot(host)
    ),
    nodePath: process.execPath,
    installDir,
    extraShimDir: extra,
    taskName,
    port
  })
}

export function collectDoctorFacts(
  packageRoot: string,
  host: InstallHost = createInstallHost(),
  dataRoot?: string,
  environment: FrozenInstallEnvironment = freezeInstallEnvironment(host)
): DoctorFacts {
  const paths = installPathsFor(packageRoot, host, dataRoot, environment)
  let candidate: PackageIdentity | null = null
  let manifest: InstallManifestV2 | null = null
  let ownedPaths = paths
  let manifestOwned = false
  let dataMarkerOk = false
  let integrationInspectionError = ''
  try { candidate = packageIdentity(packageRoot) } catch { /* reported through dist/lifecycle facts */ }
  try {
    manifest = readInstallManifest(paths, host.platform)
    if (manifest) ownedPaths = pathsForManifest(manifest, paths, host)
    if (manifest) {
      const inspection = inspectManifestIntegrationOwnership(ownedPaths, manifest, host)
      manifestOwned = inspection.owned
      integrationInspectionError = inspection.inspectionError || ''
    }
  } catch (error) {
    integrationInspectionError = error instanceof Error ? error.message : String(error)
  }
  try {
    const marker = readDataRootMarker(paths, host.platform)
    const activePackageFacts = manifest
      ? publicRuntimeFacts(manifest.packageRoot).sort((left, right) => left.path.localeCompare(right.path))
      : []
    const recordedFacts = marker
      ? [...marker.runtime.files].sort((left, right) => left.path.localeCompare(right.path))
      : []
    dataMarkerOk = Boolean(marker && manifest && marker.dataRootId === manifest.dataRootId
      && marker.activeInstallId === manifest.installId
      && canonicalJson(recordedFacts) === canonicalJson(activePackageFacts)
      && publicRuntimeFacts(paths.dataRoot).sort((left, right) => left.path.localeCompare(right.path)).every((fact, index) => {
        const recorded = recordedFacts[index]
        return recorded?.path === fact.path && recorded.sha256 === fact.sha256 && recorded.size === fact.size
      }))
  } catch { /* invalid marker is reported by doctor */ }
  const layout = layoutSpec(paths.dataRoot, pathApi)
  const missingLayout = [
    ...layout.dirs.filter((dir) => !plainPathHasKind(dir, 'directory', paths.dataRoot)),
    ...layout.files.filter((file) => !plainPathHasKind(file.path, 'file', paths.dataRoot)).map((file) => file.path),
    ...requiredDataAssets(paths.dataRoot).filter((file) => !plainPathHasKind(file, 'file', paths.dataRoot))
  ]
  const gitPath = host.which('git')
  const nodePath = process.execPath || host.which('node')
  const codexRuntime = resolveLocalCodexRuntime({
    packageRoot,
    environment,
    allowStandardPaths: true,
    fallbackNodeExecutable: nodePath
  })
  let corpusEmpty = false
  let corpusInspectionError = ''
  try {
    corpusEmpty = privateCorpusEmpty(paths.dataRoot)
  } catch (error) {
    corpusInspectionError = error instanceof Error ? error.message : String(error)
  }
  const reviewLocks = reviewLockFacts(paths.dataRoot, host)
  const lockState = lifecycleLockState(paths, host)
  let userPath = ''
  let taskRegistered = false
  if (manifest?.features.path) {
    try {
      userPath = host.userPath()
    } catch (error) {
      integrationInspectionError ||= error instanceof Error ? error.message : String(error)
    }
  }
  if (manifest?.features.task && manifest.owned.task) {
    try {
      taskRegistered = host.taskExists(manifest.owned.task.name)
    } catch (error) {
      integrationInspectionError ||= error instanceof Error ? error.message : String(error)
    }
  }
  return {
    hubRoot: paths.dataRoot,
    nodePath,
    nodeVersion: process.version,
    gitPath,
    gitVersion: gitPath ? host.commandVersion(gitPath) : '',
    codexPath: codexRuntime.codexModule,
    codexRunnerReady: codexRuntime.ready,
    codexRunnerDetail: describeLocalCodexRuntime(codexRuntime),
    distExists: fs.existsSync(paths.cliPath),
    cliPath: paths.cliPath,
    missingLayout,
    shimCmdExists: fs.existsSync(paths.shimCmd),
    shimAliasExists: fs.existsSync(paths.shimAliasCmd),
    shimUnixExists: fs.existsSync(paths.shimUnix),
    extraShimExists: Boolean(ownedPaths.extraShimCmd && fs.existsSync(ownedPaths.extraShimCmd)),
    extraShimDir: ownedPaths.extraShimDir,
    userPath,
    pathSep: host.pathSep,
    caseInsensitive: host.caseInsensitive,
    taskRegistered,
    daemonPid: 0,
    apiPid: 0,
    daemonAlive: false,
    apiHealthy: false,
    apiPort: paths.port,
    manifestExists: fs.existsSync(paths.manifestPath),
    manifestOwned,
    lifecycleExpected: manifest?.features,
    lifecycleLockHealthy: lifecycleLockHealthy(paths, host),
    lifecycleLockState: lockState,
    lifecycleWalPending: fs.existsSync(paths.lifecycleWalPath),
    durablePending: durablePendingCount(paths.dataRoot),
    reviewLockActive: reviewLocks.active,
    reviewLockStale: reviewLocks.stale,
    reviewLockUnverifiable: reviewLocks.unverifiable,
    integrationInspectionError: integrationInspectionError || undefined,
    daemonInspectionError: undefined,
    corpusInspectionError: corpusInspectionError || undefined,
    dataMarkerOk,
    packageVersion: candidate?.version || '',
    installedVersion: manifest?.packageVersion || '',
    versionMatch: Boolean(candidate && manifest
      && samePath(candidate.packageRoot, manifest.packageRoot, host.platform)
      && candidate.version === manifest.packageVersion
      && candidate.sha256 === manifest.packageSha256),
    corpusEmpty
  }
}

function assertOwnedLifecycleProof(paths: InstallPaths, host: InstallHost, proof: OwnedLifecycleProof): void {
  const lock = readLifecycleLock(paths, host)
  const wal = readLifecycleWal(paths, host)
  if (lock?.token !== proof.lockToken) {
    throw new Error('lifecycle owner lock changed during the operation')
  }
  if (wal?.walId !== proof.wal.walId
    || !sameOptionalBuffer(currentFileBytes(paths.lifecycleWalPath), recordBytes(proof.wal))
    || canonicalJson(wal) !== canonicalJson(proof.wal)) {
    throw new Error('lifecycle WAL changed during the operation')
  }
  const applicationOwner = readJsonRecord(join(
    applicationLeaseRoot(paths.dataRoot),
    'leases',
    'hub-global.lock',
    'owner.json'
  ))
  const validated = validateLockRecordV1(applicationOwner)
  if (!validated.valid || !sameApplicationOwnerBinding(validated.value, proof.applicationOwner)
    || validated.value.pid !== process.pid || Date.parse(validated.value.leaseUntil) <= Date.now()) {
    throw new Error('application writer gate changed during the lifecycle operation')
  }
  assertApplicationQuiescent(paths.dataRoot, host, proof.applicationOwner)
}

function ownedLifecycleProof(lease: LifecycleLease, wal: LifecycleWalV1): OwnedLifecycleProof {
  if (!lease.applicationOwner) throw new Error('lifecycle operation has no application writer gate')
  return { lockToken: lease.token, applicationOwner: lease.applicationOwner, wal }
}

export async function doctorHub(
  packageRoot: string,
  host: InstallHost = createInstallHost(),
  dataRoot?: string,
  environment: FrozenInstallEnvironment = freezeInstallEnvironment(host),
  ownedLifecycle?: OwnedLifecycleProof
): Promise<DoctorReport> {
  const paths = installPathsFor(packageRoot, host, dataRoot, environment)
  try {
    return await withLifecycleReadMutex(paths, host, async () => {
      const observation = await observeInstalledDaemon(paths, host)
      // Recollect static installation facts after the asynchronous process /
      // listener / epoch probe. The held lifecycle read mutex excludes a
      // lifecycle writer, while the daemon observer sandwiches its own v1
      // protocol proof around every provider call.
      const facts = collectDoctorFacts(packageRoot, host, paths.dataRoot, environment)
      if (ownedLifecycle) {
        try {
          assertOwnedLifecycleProof(paths, host, ownedLifecycle)
          facts.lifecycleLockHealthy = true
          facts.lifecycleLockState = 'clear'
          facts.lifecycleWalPending = false
          facts.reviewLockActive = 0
          facts.reviewLockStale = 0
          facts.reviewLockUnverifiable = 0
        } catch { /* strict doctor reports the still-visible foreign lock/WAL facts */ }
      }
      const exactDaemon = facts.lifecycleExpected?.daemon && observation.state === 'exact'
        ? observation
        : null
      facts.daemonPid = exactDaemon?.instance.pid || 0
      facts.apiPid = exactDaemon?.instance.apiPid || 0
      facts.daemonAlive = Boolean(exactDaemon)
      facts.apiHealthy = Boolean(exactDaemon)
      if (exactDaemon) {
        facts.daemonInspectionError = undefined
      } else if (facts.lifecycleExpected?.daemon) {
        facts.daemonInspectionError = observation.state === 'dead'
          || observation.state === 'foreign' || observation.state === 'unknown'
          ? observation.reason
          : `daemon protocol is ${observation.protocolKind}`
      }
      return evaluateDoctor(paths, facts)
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const facts: DoctorFacts = {
      hubRoot: paths.dataRoot,
      nodePath: process.execPath,
      nodeVersion: process.version,
      gitPath: '',
      gitVersion: '',
      codexPath: '',
      codexRunnerReady: false,
      codexRunnerDetail: 'Codex Session Runner readiness could not be inspected',
      distExists: false,
      cliPath: paths.cliPath,
      missingLayout: [paths.dataRoot],
      shimCmdExists: false,
      shimAliasExists: false,
      shimUnixExists: false,
      extraShimExists: false,
      extraShimDir: null,
      userPath: '',
      pathSep: host.pathSep,
      caseInsensitive: host.caseInsensitive,
      taskRegistered: false,
      daemonPid: 0,
      apiPid: 0,
      daemonAlive: false,
      apiHealthy: false,
      apiPort: paths.port,
      manifestExists: false,
      manifestOwned: false,
      lifecycleLockHealthy: false,
      lifecycleLockState: /already held|EADDRINUSE/i.test(detail) ? 'active' : 'unverifiable',
      lifecycleWalPending: false,
      durablePending: 0,
      reviewLockActive: 0,
      reviewLockStale: 0,
      reviewLockUnverifiable: 1,
      integrationInspectionError: `strict doctor snapshot unavailable: ${detail}`,
      dataMarkerOk: false,
      packageVersion: '',
      installedVersion: '',
      versionMatch: false,
      corpusEmpty: false
    }
    return evaluateDoctor(paths, facts)
  }
}

type DaemonObservationDependencies = Readonly<{
  processHost?: DaemonProcessHost
  healthProbe?: DaemonRuntimeHealthProbe
  ping?: typeof pingApi
}>

function installedDaemonRuntimeOptions(
  paths: Pick<InstallPaths, 'dataRoot'>,
  host: InstallHost
): DaemonRuntimeProtocolOptions {
  return Object.freeze({
    home: host.home,
    dataRoot: paths.dataRoot,
    platform: host.platform,
    readReceiptAuthority: () => readDaemonLifecycleReceiptAuthority(paths.dataRoot, host)
  })
}

function installedDaemonHealthProbe(
  paths: Pick<InstallPaths, 'packageRoot' | 'dataRoot'>,
  ping?: typeof pingApi
): DaemonRuntimeHealthProbe {
  if (!ping) return async (request) => probeDaemonApiHealth(request.port, 1500)
  return async (request) => await ping(request.port, 1500, {
    packageRoot: paths.packageRoot,
    dataRoot: paths.dataRoot,
    daemonEpoch: request.epochId
  }) ? Object.freeze({
        state: 'exact' as const,
        epochId: request.epochId,
        packageRoot: paths.packageRoot,
        dataRoot: paths.dataRoot
      }) : Object.freeze({ state: 'unknown' as const })
}

async function observeInstalledDaemon(
  paths: InstallPaths,
  host: InstallHost,
  dependencies: DaemonObservationDependencies = {}
): Promise<DaemonAuthorityObservation> {
  const processHost = dependencies.processHost || createDaemonProcessHost()
  const healthProbe = dependencies.healthProbe
    || installedDaemonHealthProbe(paths, dependencies.ping)
  return observeDaemonAuthority(installedDaemonRuntimeOptions(paths, host), processHost, healthProbe)
}

function legacyDaemonControlHint(
  paths: InstallPaths,
  host: InstallHost,
  runtimeOptions: DaemonRuntimeProtocolOptions
): DaemonLegacyControlHint | null {
  const inspection = inspectDaemonProtocol(runtimeOptions)
  if (inspection.kind !== 'LEGACY' && inspection.kind !== 'LEGACY-NAMESPACE-RECOVERABLE') return null
  const markers = inspectDaemonMarkerSet(paths.dataRoot)
  if (markers.kind !== 'complete' || markers.pid !== markers.apiPid
    || markers.pid !== markers.advertisedPid || markers.apiPid !== markers.advertisedApiPid
    || !daemonHeartbeatStructurallyBinds(markers.heartbeat, {
      pid: markers.pid,
      apiPid: markers.apiPid,
      packageRoot: paths.packageRoot,
      dataRoot: paths.dataRoot,
      port: paths.port
    })) {
    throw new Error('legacy daemon projections do not exactly bind the installed release')
  }
  if (!daemonProcessMatches(host, markers.pid, paths.packageRoot)
    || !apiProcessMatches(host, markers.apiPid, paths.packageRoot)) {
    throw new Error('legacy daemon projections do not identify the installed process')
  }
  return Object.freeze({ pid: markers.pid, apiPid: markers.apiPid, port: paths.port })
}

async function stopInstalledDaemonRuntime(
  paths: InstallPaths,
  host: InstallHost,
  lifecycleAuthority: DaemonLifecycleControlAuthority | null = null,
  dependencies: StopDaemonDependencies = {}
): Promise<boolean> {
  const runtimeOptions = installedDaemonRuntimeOptions(paths, host)
  const processHost = dependencies.processHost || createDaemonProcessHost()
  const healthProbe = dependencies.healthProbe
    || installedDaemonHealthProbe(paths, dependencies.ping)
  const terminal = await stopDaemonRuntime({
    protocol: runtimeOptions,
    processHost,
    healthProbe,
    lifecycleOwnerBinding: lifecycleAuthority?.binding || null,
    ...(lifecycleAuthority ? { readLifecycleOwnerAuthority: lifecycleAuthority.reader } : {}),
    legacyHint: legacyDaemonControlHint(paths, host, runtimeOptions),
    ...(dependencies.checkpoint ? { checkpoint: dependencies.checkpoint } : {}),
    ...(dependencies.timeoutMs === undefined ? {} : { timeoutMs: dependencies.timeoutMs })
  })
  return terminal.stopped
}

export async function daemonStatus(
  packageRoot: string,
  host: InstallHost = createInstallHost(),
  dataRoot?: string,
  environment: FrozenInstallEnvironment = freezeInstallEnvironment(host),
  dependencies: DaemonObservationDependencies = {}
): Promise<DaemonStatus> {
  const paths = installPathsFor(packageRoot, host, dataRoot, environment)
  const observation = await observeInstalledDaemon(paths, host, dependencies)
  const running = observation.state === 'exact'
  const pid = running ? observation.instance.pid : 0
  const apiPid = running ? observation.instance.apiPid : 0
  const heartbeat = running ? readHeartbeat(paths.dataRoot) : null
  return {
    ok: running,
    action: 'daemon-status',
    taskName: paths.taskName,
    taskRegistered: host.taskExists(paths.taskName),
    running,
    pid,
    apiPid,
    apiHealthy: running,
    apiUrl: paths.apiUrl,
    heartbeat
  }
}

export function heartbeatMatchesInstance(
  heartbeat: Record<string, unknown> | null,
  expected: { pid: number; apiPid: number; packageRoot: string; dataRoot: string; port: number },
  maxAgeMs = 20000,
  now = Date.now()
) {
  return heartbeatBindsInstance(heartbeat, expected, maxAgeMs, now)
}

export async function setupHub(
  packageRoot: string,
  flags: SetupFlags,
  host: InstallHost = createInstallHost(),
  dataRoot?: string
): Promise<SetupResult> {
  const environment = freezeInstallEnvironment(host)
  const pathEnabled = !flags.noPath && !host.skipPath && host.platform === 'win32'
  const taskEnabled = !flags.noTask && !flags.noDaemon && !host.skipTask && host.platform === 'win32'
  const daemonEnabled = !flags.noDaemon
  const requestedPaths = installPathsFor(packageRoot, host, dataRoot, environment, { resolveHostExtraShim: pathEnabled })
  let paths = requestedPaths
  let receiptBefore: LifecycleRootReceiptV1 | null = null
  let receiptFinalBefore: LifecycleRootReceiptV1 | null = null
  let receiptPendingBefore: LifecycleRootReceiptV1 | null = null
  let receiptSelectionError = ''
  try {
    const namespace = readLifecycleRootReceiptNamespace(host)
    assertNoPurgingLifecycleRootReceipt(namespace, 'setup')
    receiptFinalBefore = namespace.receipt
    receiptPendingBefore = namespace.pendingReceipt
    receiptBefore = receiptPendingBefore || receiptFinalBefore
    if (receiptBefore) {
      if (setupSelectionExplicit(environment, dataRoot)) {
        assertExplicitSelectionMatchesReceipt(requestedPaths, receiptBefore, host)
      }
      paths = installPathsForLifecycleRootReceipt(packageRoot, host, receiptBefore, environment, pathEnabled)
    }
  } catch (error) {
    receiptSelectionError = error instanceof Error ? error.message : String(error)
  }
  const steps: SetupStep[] = []
  const issues: DoctorIssue[] = []
  const add = (step: SetupStep) => {
    steps.push(step)
    if (!step.ok && !step.skipped) issues.push({ level: 'error', message: `${step.id}: ${step.detail}` })
  }

  let tracePreflight: FrozenDaemonTracePreflight = Object.freeze({ baseEnvironment: environment })
  let candidate: PackageIdentity | null = null
  let existing: InstallManifestV2 | null = null
  let priorMarker: DataRootMarkerV1 | null = null
  let plannedEnvironment: OwnedEnvironmentValue[] = []
  let plannedTask: InstallManifestV2['owned']['task'] = null
  let pathAdded = false
  let plannedPathPrior: UserPathState | null = null
  let plannedInstallId = ''
  let plannedReceipt: LifecycleRootReceiptV1 | null = null
  let preflightError = ''
  let staticCommitCompleted = false
  try {
    if (receiptSelectionError) throw new Error(receiptSelectionError)
    preflightLifecycleRoots(paths, host)
    if (fs.existsSync(paths.lifecycleWalPath)) {
      if (flags.dryRun) throw new Error('lifecycle WAL requires recovery before setup dry-run')
      const receiptBeforeRecovery = receiptBefore
      await recoverLifecycleWalUnderLock(paths, host, environment)
      const recoveredNamespace = readLifecycleRootReceiptNamespace(host)
      const recoveredReceipt = recoveredNamespace.pendingReceipt || recoveredNamespace.receipt
      if (!recoveredReceipt) throw new Error('setup lifecycle WAL recovery lost its preserved root receipt')
      if (receiptBeforeRecovery
        && !sameLifecycleRootReceiptNamespace(receiptBeforeRecovery, recoveredReceipt, host)) {
        throw new Error('setup lifecycle WAL recovery changed the preserved root namespace')
      }
      if (setupSelectionExplicit(environment, dataRoot)) {
        assertExplicitSelectionMatchesReceipt(requestedPaths, recoveredReceipt, host)
      }
      receiptBefore = recoveredReceipt
      receiptFinalBefore = recoveredNamespace.receipt
      receiptPendingBefore = recoveredNamespace.pendingReceipt
      paths = installPathsForLifecycleRootReceipt(packageRoot, host, recoveredReceipt, environment, pathEnabled)
      preflightLifecycleRoots(paths, host)
    }
    tracePreflight = preflightDaemonTraceEnvironment(environment, host.platform, paths.dataRoot)
    if (flags.rebuild) {
      throw new Error('setup --rebuild is unsupported; build an immutable candidate package before lifecycle setup or upgrade')
    }
    if (!flags.dryRun) {
      const dependencies = ensureDependencies(packageRoot, false, host)
      add(dependencies)
      if (!dependencies.ok) throw new Error(dependencies.detail)
    }
    candidate = packageIdentity(packageRoot)
    const locatedManifest = readInstallManifest(paths, host.platform, 'install-only')
    if (locatedManifest) {
      const locatedPaths = pathsForManifest(locatedManifest, paths, host)
      if (!manifestIntegrationOwned(locatedPaths, locatedManifest, host)) {
        throw new Error('existing installation no longer matches its ownership manifest')
      }
      existing = locatedManifest
      paths = locatedPaths
    } else {
      existing = preflightExistingOwnership(paths, host, { path: pathEnabled, task: taskEnabled })
    }
    if (existing && (existing.packageSha256 !== candidate.sha256
      || !samePath(existing.packageRoot, candidate.packageRoot, host.platform))) {
      throw new Error('a different package is installed; use sg upgrade from the candidate package')
    }
    if (existing?.features.path && (
      (existing.extraShimDir === null) !== (paths.extraShimDir === null)
      || Boolean(existing.extraShimDir && paths.extraShimDir
        && !samePath(existing.extraShimDir, paths.extraShimDir, host.platform))
    )) {
      throw new Error('setup extra-shim selection differs from the manifest-bound installation')
    }
    if (existing && (existing.features.path !== pathEnabled
      || existing.features.task !== taskEnabled
      || existing.features.daemon !== daemonEnabled)) {
      throw new Error('setup feature flags differ from the owned installation; uninstall or upgrade explicitly')
    }
    priorMarker = preflightDataRoot(paths, candidate, host, Boolean(existing))
    if (existing && (!priorMarker || priorMarker.dataRootId !== existing.dataRootId)) {
      throw new Error('installed data-root marker is missing or does not match the ownership manifest')
    }
    const protocolNamespace = readLifecycleRootReceiptNamespace(host)
    const protocolLocator = protocolNamespace.pendingReceipt || protocolNamespace.receipt
    if (protocolLocator && (!samePath(protocolLocator.dataRoot, paths.dataRoot, host.platform)
      || !samePath(protocolLocator.installDir, paths.installDir, host.platform))) {
      throw new Error('lifecycle root receipt protocol state changed to another preserved root during setup preflight')
    }
    receiptFinalBefore = protocolNamespace.receipt
    receiptPendingBefore = protocolNamespace.pendingReceipt
    receiptBefore = receiptPendingBefore || receiptFinalBefore
    if (flags.dryRun && (protocolNamespace.pendingState || protocolNamespace.writingState)) {
      throw new Error('lifecycle root receipt publication requires non-dry-run recovery')
    }
    if (!flags.dryRun && !existing && protocolNamespace.writingState && !protocolNamespace.pendingState) {
      const candidateAuthority = capturePackageAuthoritySnapshot(
        candidate,
        'complete lifecycle root receipt reservation package'
      )
      const allowedReservationCurrent = [receiptFinalBefore, receiptBefore]
      const adoptedReservation = await withLifecycleReadMutex(
        paths,
        host,
        () => {
          assertPackageAuthoritySnapshot(
            candidate!,
            candidateAuthority,
            'complete lifecycle root receipt reservation package'
          )
          const adopted = adoptCompleteLifecycleRootReceiptWriterReservation(
            paths,
            candidate!,
            host,
            allowedReservationCurrent
          )
          assertPackageAuthoritySnapshot(
            candidate!,
            candidateAuthority,
            'complete lifecycle root receipt reservation package terminal seal'
          )
          return adopted
        },
        () => {
          preflightLifecycleRoots(paths, host)
          assertPackageAuthoritySnapshot(
            candidate!,
            candidateAuthority,
            'complete lifecycle root receipt reservation package post-mutex preflight'
          )
        }
      )
      if (adoptedReservation) {
        receiptBefore = adoptedReservation
        receiptFinalBefore = adoptedReservation
        receiptPendingBefore = null
        paths = installPathsForLifecycleRootReceipt(packageRoot, host, adoptedReservation, environment, pathEnabled)
        preflightLifecycleRoots(paths, host)
      }
    }
    if (receiptPendingBefore) {
      const existingPendingTarget = existing
        ? lifecycleRootReceiptForManifest(existing, 'active', receiptFinalBefore, existing.updatedAt)
        : null
      if (existing ? !sameLifecycleRootReceipt(receiptPendingBefore, existingPendingTarget) : (
        receiptPendingBefore.state !== 'active'
        || !samePath(receiptPendingBefore.packageRoot, candidate.packageRoot, host.platform)
        || receiptPendingBefore.packageVersion !== candidate.version
        || receiptPendingBefore.packageSha256 !== candidate.sha256
        || !samePath(receiptPendingBefore.dataRoot, paths.dataRoot, host.platform)
        || !samePath(receiptPendingBefore.installDir, paths.installDir, host.platform)
        || priorMarker && (priorMarker.activeInstallId !== null
          || priorMarker.dataRootId !== receiptPendingBefore.dataRootId))) {
        throw new Error('pending lifecycle root receipt is not the exact setup reservation')
      }
    }
    if (receiptBefore && priorMarker && receiptBefore.dataRootId !== priorMarker.dataRootId) {
      throw new Error('lifecycle root receipt and data-root marker identify different preserved roots')
    }
    if (existing && priorMarker?.activeInstallId !== existing.installId) throw new Error('data-root active install binding is invalid')
    if (!existing && priorMarker?.activeInstallId) throw new Error('data root is still bound to another active installation')
    if (!existing) assertNoForeignLiveLifecycleProcess(paths, host, [])
    if (existing && !flags.dryRun) {
      const activeReceipt = lifecycleRootReceiptForManifest(existing, 'active', receiptBefore)
      const authoritySnapshot = captureInstalledLifecycleAuthoritySnapshot(
        paths,
        candidate,
        existing,
        priorMarker!,
        host,
        'already-current setup'
      )
      await withLifecycleReadMutex(paths, host, () => {
        assertInstalledLifecycleAuthoritySnapshot(
          paths,
          candidate!,
          existing!,
          priorMarker!,
          authoritySnapshot,
          host,
          'already-current setup'
        )
        ensureLifecycleRootReceipt(host, activeReceipt, [receiptFinalBefore, activeReceipt])
        assertLifecycleRootReceiptCurrentExact(host, activeReceipt)
        retireStaleLifecycleOwnerWithoutWal(paths, host)
        assertInstalledLifecycleAuthoritySnapshot(
          paths,
          candidate!,
          existing!,
          priorMarker!,
          authoritySnapshot,
          host,
          'already-current setup terminal seal'
        )
        assertLifecycleRootReceiptCurrentExact(host, activeReceipt)
      }, () => assertInstalledLifecycleAuthoritySnapshot(
        paths,
        candidate!,
        existing!,
        priorMarker!,
        authoritySnapshot,
        host,
        'already-current setup post-mutex preflight'
      ))
      receiptBefore = activeReceipt
      receiptFinalBefore = activeReceipt
      receiptPendingBefore = null
    }
    if (existing && receiptBefore) assertLifecycleRootReceiptBindsManifest(receiptBefore, existing, 'active', host)
    if (!existing && receiptBefore?.state === 'active') {
      if (!samePath(receiptBefore.packageRoot, candidate.packageRoot, host.platform)
        || receiptBefore.packageVersion !== candidate.version || receiptBefore.packageSha256 !== candidate.sha256) {
        throw new Error('active lifecycle root receipt belongs to another package release')
      }
    }
    plannedInstallId = existing?.installId
      || (receiptBefore?.state === 'active' ? receiptBefore.installId : randomUUID())
    const preflightPath = pathEnabled ? host.userPathState() : unmanagedUserPathState()
    const merged = mergeUserPath(preflightPath.value, paths.binDir, host.pathSep, host.caseInsensitive)
    pathAdded = existing?.owned.pathEntry.added ?? (pathEnabled && host.platform === 'win32' && merged.changed)
    plannedPathPrior = existing?.owned.pathEntry.prior ?? (pathAdded ? preflightPath : null)
    plannedEnvironment = existing ? [...existing.owned.environment] : planEnvironmentOwnership(paths, pathEnabled, host)
    plannedTask = existing?.owned.task || planTaskOwnership(paths, taskEnabled, host)
  } catch (error) {
    const rawPreflightError = error instanceof Error ? error.message : String(error)
    const traceFailure = /(?:invocation trace|real E2E detached launcher|preflight data root must identify|SKILL_GRAFT_HOME must identify selected data root)/i.test(rawPreflightError)
    preflightError = traceFailure
      ? `invocation trace gate is invalid: ${rawPreflightError}`
      : rawPreflightError
    add({
      id: traceFailure ? 'trace' : 'preflight',
      ok: false,
      detail: preflightError
    })
  }

  const stepIds = ['deps', 'layout', 'shims', 'path', 'env', 'task', 'daemon'] as const
  if (preflightError) {
    for (const id of stepIds) if (!steps.some((step) => step.id === id)) add({ id, ok: true, skipped: true, detail: 'skipped after preflight failed' })
  } else if (existing && !flags.dryRun) {
    for (const id of stepIds) {
      if (id !== 'daemon' && !steps.some((step) => step.id === id)) add({ id, ok: true, skipped: true, detail: 'already current' })
    }
  } else if (flags.dryRun) {
    add({ id: 'deps', ok: true, skipped: true, detail: 'dry-run' })
    add({ id: 'layout', ok: true, skipped: true, detail: priorMarker ? 'already owned' : 'would bootstrap public runtime and data marker' })
    add({ id: 'shims', ok: true, skipped: true, detail: paths.binDir })
    const merged = mergeUserPath(pathEnabled ? host.userPathState().value : '', paths.binDir, host.pathSep, host.caseInsensitive)
    add({
      id: 'path',
      ok: true,
      skipped: !pathEnabled,
      detail: !pathEnabled ? 'skipped' : merged.already ? 'already on user PATH' : `would prepend ${paths.binDir}`
    })
    add({
      id: 'task',
      ok: true,
      skipped: !taskEnabled,
      detail: !taskEnabled ? 'skipped' : `would register ${paths.taskName} at logon`
    })
    add({ id: 'env', ok: true, skipped: !pathEnabled, detail: !pathEnabled ? 'skipped' : 'would bind user data-root environment' })
    add({
      id: 'daemon',
      ok: true,
      skipped: !daemonEnabled,
      detail: !daemonEnabled ? 'skipped' : `would start keep-alive for ${paths.apiUrl}`
    })
  } else {
    const artifacts = renderedArtifacts(paths, tracePreflight, pathEnabled, host)
    const markerPlannedAt = !existing && receiptBefore?.state === 'active'
      ? receiptBefore.updatedAt
      : new Date().toISOString()
    const plannedMarker: DataRootMarkerV1 = priorMarker || {
      schemaVersion: DATA_ROOT_MARKER_VERSION,
      dataRootId: receiptBefore?.dataRootId || randomUUID(),
      activeInstallId: plannedInstallId,
      canonicalRoot: paths.dataRoot,
      createdAt: markerPlannedAt,
      runtime: { schemaVersion: PUBLIC_RUNTIME_CORPUS_VERSION, files: [...candidate!.publicRuntimeFacts] }
    }
    const activePlannedMarker: DataRootMarkerV1 = {
      ...plannedMarker,
      activeInstallId: plannedInstallId,
      runtime: { schemaVersion: PUBLIC_RUNTIME_CORPUS_VERSION, files: [...candidate!.publicRuntimeFacts] }
    }
    const plannedManifest = createInstallManifest({
      paths,
      candidate: candidate!,
      marker: activePlannedMarker,
      artifacts,
      pathEnabled,
      taskEnabled,
      daemonEnabled,
      pathAdded,
      pathPrior: plannedPathPrior,
      environment: plannedEnvironment,
      task: plannedTask,
      installId: plannedInstallId,
      plannedAt: markerPlannedAt
    })
    plannedReceipt = lifecycleRootReceiptForManifest(plannedManifest, 'active', receiptBefore)
    if (receiptPendingBefore && !sameLifecycleRootReceipt(plannedReceipt, receiptPendingBefore)) {
      throw new Error('pending lifecycle root receipt cannot be reconstructed as the exact setup reservation')
    }
    const layout = layoutSpec(paths.dataRoot, pathApi)
    const snapshotFiles = [
      ...artifacts.keys(),
      paths.manifestPath,
      paths.dataMarkerPath,
      ...requiredDataAssets(paths.dataRoot),
      ...layout.files.map((file) => file.path)
    ]
    const snapshot = snapshotIntegration(paths, host, snapshotFiles, layout.dirs, { path: pathEnabled, task: taskEnabled })
    const expectedFiles = new Map<string, string | Buffer | null>([
      ...[...artifacts].map(([file, content]) => [file, content] as const),
      [paths.manifestPath, `${JSON.stringify(plannedManifest, null, 2)}\n`],
      [paths.dataMarkerPath, `${JSON.stringify(activePlannedMarker, null, 2)}\n`],
      ...PUBLIC_RUNTIME_FILES.map((relativePath) => [
        join(paths.dataRoot, ...relativePath.split('/')),
        Buffer.from(candidate!.publicRuntime.get(relativePath) as Buffer)
      ] as const),
      ...layout.files.filter((file) => !fs.existsSync(file.path)).map((file) => [file.path, file.content] as const)
    ])
    const expectedEnvironment = new Map(snapshot.environment)
    for (const entry of plannedEnvironment) if (entry.created) {
      expectedEnvironment.set(entry.name, { exists: true, value: entry.value, kind: entry.kind })
    }
    const expectedState = expectedIntegration(snapshot, {
      files: expectedFiles,
      userPath: pathEnabled && host.platform === 'win32'
        ? userPathStateWithValue(snapshot.userPath, mergeUserPath(snapshot.userPath.value, paths.binDir, host.pathSep, host.caseInsensitive).path)
        : snapshot.userPath,
      pathManaged: pathEnabled,
      environment: expectedEnvironment,
      taskExisted: plannedTask?.created ? true : snapshot.taskExisted,
      taskLauncher: plannedTask?.created ? expectedTaskAction(plannedTask.launcher) : snapshot.taskLauncher
    })
    const receiptPackageAuthority = capturePackageAuthoritySnapshot(candidate!, 'setup receipt candidate package')
    const sealSetupReceiptAuthority = () => {
      preflightLifecycleRoots(paths, host)
      assertPackageAuthoritySnapshot(candidate!, receiptPackageAuthority, 'setup receipt candidate package')
      if (preflightExistingOwnership(paths, host, { path: pathEnabled, task: taskEnabled })) {
        throw new Error('installation appeared before setup receipt publication')
      }
      const receiptMarker = preflightDataRoot(paths, candidate!, host, false)
      if (canonicalJson(receiptMarker) !== canonicalJson(priorMarker)) {
        throw new Error('data-root marker changed before setup receipt publication')
      }
      assertIntegrationSnapshotCurrent(paths, host, snapshot)
      assertNoForeignLiveLifecycleProcess(paths, host, [])
    }
    let lifecycleLease: LifecycleLease | null = null
    let mutationStarted = false
    let lifecycleWal: LifecycleWalV1 | null = null
    let lifecycleCommitted = false
    try {
      lifecycleLease = await acquireLifecycleLock(paths, host, 'setup', true, {
        target: plannedReceipt!,
        allowedCurrent: [receiptFinalBefore, plannedReceipt],
        sealBeforePublication: sealSetupReceiptAuthority,
        sealAfterPublication: sealSetupReceiptAuthority
      })
      // Revalidate every external ownership fact after claiming the write lock.
      const lockedCandidate = packageIdentity(packageRoot)
      await lifecycleLease.revalidateApplicationGate()
      if (!candidate || lockedCandidate.sha256 !== candidate.sha256) throw new Error('candidate package changed after preflight')
      if (preflightExistingOwnership(paths, host, { path: pathEnabled, task: taskEnabled })) {
        throw new Error('installation appeared after preflight')
      }
      assertApplicationQuiescent(paths.dataRoot, host, lifecycleLease.applicationOwner || undefined)
      assertNoForeignLiveLifecycleProcess(paths, host, [])
      if (await sealDaemonLifecycleStateBeforeMutation(
        paths,
        host,
        candidate.packageRoot,
        paths.port,
        lifecycleLease.revalidateApplicationGate
      )) {
        throw new Error('setup found a live daemon/API without an installed lifecycle authority')
      }
      const lockedMarker = preflightDataRoot(paths, candidate, host, false)
      if (canonicalJson(lockedMarker) !== canonicalJson(priorMarker)) throw new Error('data-root marker changed after setup preflight')
      const lockedPathState = pathEnabled ? host.userPathState() : unmanagedUserPathState()
      const lockedMerged = mergeUserPath(lockedPathState.value, paths.binDir, host.pathSep, host.caseInsensitive)
      const lockedPathAdded = pathEnabled && host.platform === 'win32' && lockedMerged.changed
      const lockedEnvironment = planEnvironmentOwnership(paths, pathEnabled, host)
      const lockedTask = planTaskOwnership(paths, taskEnabled, host)
      if (lockedPathAdded !== pathAdded
        || canonicalJson(pathAdded ? lockedPathState : null) !== canonicalJson(plannedPathPrior)
        || canonicalJson(lockedEnvironment) !== canonicalJson(plannedEnvironment)
        || canonicalJson(lockedTask) !== canonicalJson(plannedTask)) {
        throw new Error('integration ownership changed after setup preflight')
      }
      assertIntegrationSnapshotCurrent(paths, host, snapshot)

      lifecycleWal = {
        schemaVersion: 1,
        walId: randomUUID(),
        lockToken: lifecycleLease.token,
        operation: 'setup',
        phase: 'prepared',
        installDir: paths.installDir,
        oldManifest: null,
        newManifest: plannedManifest,
        oldReceipt: receiptFinalBefore,
        newReceipt: plannedReceipt!,
        oldMarker: priorMarker,
        newMarker: activePlannedMarker,
        oldIntegration: lifecycleIntegrationState(snapshot),
        newIntegration: lifecycleIntegrationState(expectedState),
        externalArtifacts: [],
        tombstone: null,
        oldDaemonRunning: daemonEnabled,
        createdAt: markerPlannedAt
      }
      registerLifecycleMutationFence(paths, lifecycleWal)
      await lifecycleLease.revalidateApplicationGate()
      if (!sameLifecycleRootReceipt(readLifecycleRootReceipt(host), plannedReceipt)) {
        throw new Error('setup lifecycle root receipt changed before WAL publication')
      }
      writeLifecycleWal(paths, lifecycleWal, null, host)
      mutationStarted = true
      await lifecycleLease.revalidateApplicationGate()
      const marker = bootstrapDataRoot(
        paths,
        candidate,
        priorMarker,
        priorMarker !== null,
        plannedInstallId,
        activePlannedMarker,
        snapshot.files,
        lifecycleWal
      )
      add({ id: 'layout', ok: true, detail: priorMarker ? 'owned data layout ready' : 'public runtime and data marker bootstrapped' })
      await lifecycleLease.revalidateApplicationGate()
      writeArtifacts(artifacts, snapshot.files, lifecycleWal)
      add({ id: 'shims', ok: true, detail: `${PRODUCT_COMMAND} and ${PRODUCT_ALIAS} -> ${paths.cliPath}` })

      if (pathEnabled && host.platform === 'win32') {
        await lifecycleLease.revalidateApplicationGate()
        const current = host.userPathState()
        if (!sameUserPathState(current, snapshot.userPath)) throw new Error('user PATH changed before setup write')
        if (!sameUserPathState(current, expectedState.userPath)
          && !host.compareExchangeUserPath(current, expectedState.userPath)) {
          throw new Error('user PATH setup compare-exchange failed')
        }
        if (!sameUserPathState(host.userPathState(), expectedState.userPath)) throw new Error('user PATH setup postcondition failed')
      }
      add({ id: 'path', ok: true, skipped: !pathEnabled, detail: pathEnabled ? paths.binDir : 'skipped' })
      if (pathEnabled && host.platform === 'win32') {
        for (const entry of plannedEnvironment) {
          if (!entry.created) continue
          await lifecycleLease.revalidateApplicationGate()
          const current = host.userEnvState(entry.name)
          const before = snapshot.environment.get(entry.name)
          const next = { exists: true, value: entry.value, kind: entry.kind }
          if (!before || !sameUserEnvironmentState(current, before)) {
            throw new Error(`user environment changed before setup write: ${entry.name}`)
          }
          if (!host.compareExchangeUserEnv(entry.name, current, next)) {
            throw new Error(`user environment setup compare-exchange failed: ${entry.name}`)
          }
          if (!sameUserEnvironmentState(host.userEnvState(entry.name), next)) {
            throw new Error(`user environment setup postcondition failed: ${entry.name}`)
          }
        }
        host.broadcastEnv()
      }
      add({ id: 'env', ok: true, skipped: !pathEnabled, detail: pathEnabled ? `data root ${paths.dataRoot}` : 'skipped' })
      if (canonicalJson(marker) !== canonicalJson(activePlannedMarker)) throw new Error('setup data marker differs from the frozen plan')
      await lifecycleLease.revalidateApplicationGate()
      writeManifest(paths, plannedManifest, [snapshot.files.get(resolve(paths.manifestPath)) ?? null], lifecycleWal)
      if (plannedTask?.created) {
        await lifecycleLease.revalidateApplicationGate()
        if (host.taskExists(plannedTask.name)) throw new Error('scheduled task changed before setup write')
        host.registerLogonTask(plannedTask.name, plannedTask.launcher)
        if (!host.taskExists(plannedTask.name)
          || host.taskAction(plannedTask.name).toLowerCase() !== expectedTaskAction(plannedTask.launcher).toLowerCase()) {
          throw new Error('scheduled task setup postcondition failed')
        }
      }
      add({ id: 'task', ok: true, skipped: !taskEnabled, detail: taskEnabled ? paths.taskName : 'skipped' })
      const terminalRelease: RecoverableRelease = {
        manifest: plannedManifest,
        paths,
        identity: candidate,
        artifacts
      }
      await assertInstalledWalTerminalSeal(terminalRelease, activePlannedMarker, lifecycleWal, host, lifecycleLease, false)
      await lifecycleLease.revalidateApplicationGate()
      assertOwnedLifecycleProof(paths, host, ownedLifecycleProof(lifecycleLease, lifecycleWal))
      const committedWal: LifecycleWalV1 = { ...lifecycleWal, phase: 'committed' }
      writeLifecycleWal(paths, committedWal, lifecycleWal, host)
      lifecycleWal = committedWal
      lifecycleCommitted = true
      await assertInstalledWalTerminalSeal(terminalRelease, activePlannedMarker, lifecycleWal, host, lifecycleLease, false)
      await lifecycleLease.revalidateApplicationGate()
      assertOwnedLifecycleProof(paths, host, ownedLifecycleProof(lifecycleLease, lifecycleWal))
      ensureLifecycleRootReceipt(host, lifecycleWal.newReceipt, [lifecycleWal.oldReceipt, lifecycleWal.newReceipt])
      await lifecycleLease.revalidateApplicationGate()
      assertLifecycleRootReceiptCurrentExact(host, lifecycleWal.newReceipt)
      assertOwnedLifecycleProof(paths, host, ownedLifecycleProof(lifecycleLease, lifecycleWal))
      removeLifecycleWal(paths, lifecycleWal)
      staticCommitCompleted = true
    } catch (error) {
      if (error instanceof LifecycleWalPublicationError) lifecycleLease?.preserveOwnerRecord()
      const message = error instanceof Error ? error.message : String(error)
      issues.push({ level: 'error', message })
      if (mutationStarted && !lifecycleCommitted) {
        try {
          if (!lifecycleWal || !lifecycleLease) throw new Error('setup rollback lost its lifecycle ownership proof')
          assertOwnedLifecycleProof(paths, host, ownedLifecycleProof(lifecycleLease, lifecycleWal))
          await lifecycleLease.revalidateApplicationGate()
          const lifecycleAuthority = daemonLifecycleControlAuthority(
            paths,
            host,
            lifecycleLease.token
          )
          if (!await stopInstalledDaemonRuntime(paths, host, lifecycleAuthority)) {
            throw new Error('candidate daemon/API could not be safely stopped before setup rollback')
          }
          await lifecycleLease.revalidateApplicationGate()
          restoreIntegration(paths, host, snapshot, expectedState, lifecycleWal)
          await lifecycleLease.revalidateApplicationGate()
          await cleanupFreshRollbackRoots(paths, snapshot, lifecycleLease.revalidateApplicationGate)
          await lifecycleLease.revalidateApplicationGate()
          ensureLifecycleRootReceipt(host, lifecycleWal.newReceipt, [lifecycleWal.oldReceipt, lifecycleWal.newReceipt])
          await lifecycleLease.revalidateApplicationGate()
          assertLifecycleRootReceiptCurrentExact(host, lifecycleWal.newReceipt)
          assertOwnedLifecycleProof(paths, host, ownedLifecycleProof(lifecycleLease, lifecycleWal))
          removeLifecycleWal(paths, lifecycleWal)
        } catch (rollbackError) {
          issues.push({ level: 'error', message: `setup rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}` })
        }
      }
      for (const id of stepIds) {
        if (!steps.some((step) => step.id === id)) add({ id, ok: true, skipped: true, detail: 'skipped after setup failed' })
      }
    } finally {
      if (lifecycleLease) await lifecycleLease.release()
    }
  }

  const shouldRepairDaemon = !flags.dryRun && !preflightError
    && (staticCommitCompleted && daemonEnabled || Boolean(existing?.features.daemon))
  if (shouldRepairDaemon) {
    const daemon = await applyDaemon(paths, false, host, tracePreflight)
    add(daemon)
  } else if (!flags.dryRun && !preflightError && !steps.some((step) => step.id === 'daemon')) {
    add({ id: 'daemon', ok: true, skipped: true, detail: 'skipped' })
  }

  const doctor = await doctorHub(
    packageRoot,
    host,
    paths.dataRoot,
    environmentBoundToManifestPaths(environment, paths)
  )
  const setupErrors = issues.filter((issue) => issue.level === 'error')
  return {
    ok: setupErrors.length === 0 && !preflightError && (flags.dryRun || doctor.ok),
    action: 'setup',
    dryRun: flags.dryRun,
    product: PRODUCT_NAME,
    command: PRODUCT_COMMAND,
    hubRoot: paths.dataRoot,
    installDir: paths.installDir,
    binDir: paths.binDir,
    apiUrl: paths.apiUrl,
    taskName: paths.taskName,
    steps,
    doctor,
    issues: [...setupErrors, ...doctor.issues.filter((issue) => !setupErrors.some((item) => item.message === issue.message))]
  }
}

function assertUninstallProvidersAvailable(manifest: InstallManifestV2, host: InstallHost): void {
  // SG_SKIP_* controls fresh feature selection and test isolation only. It
  // cannot make an already-owned persistent authority disappear during
  // uninstall: doing so would let terminal checks observe synthetic absence
  // and leave PATH/environment/task launchers pointing at deleted files.
  if (manifest.features.path && (host.platform !== 'win32' || host.skipPath)) {
    throw new Error('owned persistent PATH/environment provider is unavailable for uninstall')
  }
  if (manifest.features.task && (host.platform !== 'win32' || host.skipTask)) {
    throw new Error('owned persistent scheduled-task provider is unavailable for uninstall')
  }
}

function assertLifecycleWalProvidersAvailable(wal: LifecycleWalV1, host: InstallHost): void {
  if (wal.operation === 'uninstall' && wal.phase === 'committed') return
  for (const manifest of [wal.oldManifest, wal.newManifest]) {
    if (manifest) assertUninstallProvidersAvailable(manifest, host)
  }
}

export async function uninstallHub(
  packageRoot: string,
  host: InstallHost = createInstallHost(),
  privateHooks: LifecycleRecoveryPrivateHooks = {}
): Promise<UninstallResult> {
  const environment = freezeInstallEnvironment(host)
  const issues: DoctorIssue[] = []
  const failure = (installDir: string, message: string): UninstallResult => ({
    ok: false,
    action: 'uninstall',
    status: 'failed',
    stopped: false,
    taskRemoved: false,
    pathRemoved: false,
    filesRemoved: false,
    extraShimsRemoved: false,
    installDir,
    issues: [{ level: 'error', message }]
  })
  let locatorPaths: InstallPaths
  let lifecycleReceipt: LifecycleRootReceiptV1 | null = null
  try {
    const receiptNamespace = readLifecycleRootReceiptNamespace(host)
    assertNoPurgingLifecycleRootReceipt(receiptNamespace, 'uninstall')
    lifecycleReceipt = receiptNamespace.receipt || receiptNamespace.pendingReceipt
    if (lifecycleReceipt) {
      locatorPaths = installPathsForLifecycleRootReceipt(
        lifecycleReceipt.packageRoot,
        host,
        lifecycleReceipt,
        environment,
        false
      )
    } else {
      const locatorEnvironment = Object.freeze({
        SG_INSTALL_DIR: environment.SG_INSTALL_DIR
      }) as FrozenInstallEnvironment
      locatorPaths = installPathsFor(packageRoot, host, undefined, locatorEnvironment)
    }
  } catch (error) {
    return failure(
      typeof environment.SG_INSTALL_DIR === 'string' ? environment.SG_INSTALL_DIR : '',
      error instanceof Error ? error.message : String(error)
    )
  }
  let paths = locatorPaths
  let lifecycleEnvironment = lifecycleReceipt
    ? environmentBoundToManifestPaths(environment, locatorPaths)
    : environment
  const failed = (message: string): UninstallResult => failure(paths.installDir, message)
  let manifest: InstallManifestV2 | null
  let dataMarker: DataRootMarkerV1 | null = null
  let installedPackage: PackageIdentity | null = null
  const alreadyUninstalled = (): UninstallResult => ({
    ok: true,
    action: 'uninstall',
    status: 'already-uninstalled',
    stopped: false,
    taskRemoved: false,
    pathRemoved: false,
    filesRemoved: false,
    extraShimsRemoved: false,
    installDir: paths.installDir,
    issues: []
  })
  try {
    let ambientPaths: InstallPaths | null = null
    let ambientSelectionError: unknown = null
    if (lifecycleReceipt) {
      // The preserved per-user locator is the discovery authority. Ambient
      // environment is intentionally ignored here: uninstall may have already
      // removed owned root variables before a committed crash.
      paths = locatorPaths
      // The receipt is the stable locator, but an active receipt can accompany
      // a committed-uninstall WAL whose package/install bytes are already gone.
      // First prove only the preserved roots and exact receipt, then classify
      // the strict WAL. Historical package bytes are required only for an
      // active non-terminal state or a non-terminal recovery.
      preflightTerminalPreservedRootReceiptPaths(paths, lifecycleReceipt, host)
      let receiptProtocol = readLifecycleRootReceiptNamespace(host)
      if (lifecycleReceipt.state === 'inactive' && (receiptProtocol.pendingState || receiptProtocol.writingState)) {
        throw new Error('inactive lifecycle root receipt has an unfinished publication that requires setup recovery')
      }
      const receiptWal = readLifecycleWal(paths, host)
      if (receiptWal) {
        if (!(receiptWal.operation === 'uninstall' && receiptWal.phase === 'committed')) {
          preflightLifecycleRoots(paths, host)
        }
        assertLifecycleWalProvidersAvailable(receiptWal, host)
        const receiptBeforeRecovery = lifecycleReceipt
        await recoverLifecycleWalUnderLock(paths, host, lifecycleEnvironment, privateHooks)
        lifecycleReceipt = readLifecycleRootReceipt(host)
        if (!lifecycleReceipt) throw new Error('lifecycle WAL recovery lost its preserved root receipt')
        if (!sameLifecycleRootReceiptNamespace(receiptBeforeRecovery, lifecycleReceipt, host)) {
          throw new Error('uninstall lifecycle WAL recovery changed the preserved root namespace')
        }
        locatorPaths = installPathsForLifecycleRootReceipt(
          lifecycleReceipt.packageRoot,
          host,
          lifecycleReceipt,
          environment,
          false
        )
        paths = locatorPaths
        lifecycleEnvironment = environmentBoundToManifestPaths(environment, paths)
        if (lifecycleReceipt.state === 'inactive') {
          preflightTerminalPreservedRootReceiptPaths(paths, lifecycleReceipt, host)
        } else {
          preflightLifecycleRoots(paths, host)
        }
        receiptProtocol = readLifecycleRootReceiptNamespace(host)
        if (lifecycleReceipt.state === 'inactive' && (receiptProtocol.pendingState || receiptProtocol.writingState)) {
          throw new Error('recovered inactive lifecycle root receipt still has unfinished publication residue')
        }
      } else if (lifecycleReceipt.state === 'active') {
        preflightLifecycleRoots(paths, host)
      }
      if (lifecycleReceipt.state === 'inactive') {
        const terminalMarker = captureReceiptBoundInactiveMarker(paths, lifecycleReceipt, host)
        if (!terminalMarker) {
          throw new Error('inactive lifecycle root receipt has no matching terminal data marker')
        }
        await withLifecycleReadMutex(paths, host, () => {
          assertLifecycleRootReceiptCurrentExact(host, lifecycleReceipt!)
          assertReceiptBoundInactiveMarker(paths, lifecycleReceipt!, host, terminalMarker)
          retireStaleLifecycleOwnerWithoutWal(paths, host)
          assertLifecycleRootReceiptCurrentExact(host, lifecycleReceipt!)
          assertReceiptBoundInactiveMarker(paths, lifecycleReceipt!, host, terminalMarker)
        }, () => preflightTerminalPreservedRootReceiptPaths(paths, lifecycleReceipt!, host))
        return alreadyUninstalled()
      }
    } else {
      try {
        ambientPaths = installPathsFor(packageRoot, host, undefined, environment)
      } catch (error) {
        ambientSelectionError = error
      }
      if (ambientPaths) {
        paths = ambientPaths
        const terminalMarker = readAlreadyUninstalledMarker(paths, host)
        if (terminalMarker) {
          await withLifecycleReadMutex(paths, host, () => {
            const locked = readAlreadyUninstalledMarker(paths, host)
            if (!locked || canonicalJson(locked) !== canonicalJson(terminalMarker)) {
              throw new Error('already-uninstalled terminal receipt changed while acquiring the lifecycle mutex')
            }
            retireStaleLifecycleOwnerWithoutWal(paths, host)
            const afterRetirement = readAlreadyUninstalledMarker(paths, host)
            if (!afterRetirement || canonicalJson(afterRetirement) !== canonicalJson(terminalMarker)) {
              throw new Error('already-uninstalled terminal receipt changed during stale-owner retirement')
            }
          }, () => preflightLifecycleNamespaceMutationPaths(paths, host))
          return alreadyUninstalled()
        }
        const pendingWal = readLifecycleWal(paths, host)
        if (pendingWal) assertLifecycleWalProvidersAvailable(pendingWal, host)
        if (pendingWal?.operation === 'uninstall' && pendingWal.phase === 'committed') {
          await recoverLifecycleWalUnderLock(paths, host, environment, privateHooks)
          const marker = readAlreadyUninstalledMarker(paths, host)
          if (!marker) throw new Error('committed uninstall receipt cleanup did not retain its inactive marker')
          return alreadyUninstalled()
        }
      }
    }

    const locatedManifest = readInstallManifest(locatorPaths, host.platform, 'install-only')
    if (locatedManifest) {
      assertUninstallProvidersAvailable(locatedManifest, host)
      paths = pathsForManifest(locatedManifest, locatorPaths, host)
      lifecycleEnvironment = environmentBoundToManifestPaths(environment, paths)
      if (lifecycleReceipt) assertLifecycleRootReceiptBindsManifest(lifecycleReceipt, locatedManifest, 'active', host)
      const locatedWal = readLifecycleWal(paths, host)
      if (locatedWal) assertLifecycleWalProvidersAvailable(locatedWal, host)
      await recoverLifecycleWalUnderLock(paths, host, lifecycleEnvironment, privateHooks)
      manifest = readInstallManifest(paths, host.platform)
      if (!manifest) {
        if (readAlreadyUninstalledMarker(paths, host)) return alreadyUninstalled()
        throw new Error('installation manifest disappeared without an inactive terminal receipt')
      }
    } else {
      if (lifecycleReceipt) {
        throw new Error('active lifecycle root receipt has no owned installation manifest')
      }
      if (ambientSelectionError) throw ambientSelectionError
      paths = ambientPaths as InstallPaths
      preflightLifecycleRoots(paths, host)
      const ambientWal = readLifecycleWal(paths, host)
      if (ambientWal) assertLifecycleWalProvidersAvailable(ambientWal, host)
      await recoverLifecycleWalUnderLock(paths, host, environment, privateHooks)
      manifest = readInstallManifest(paths, host.platform)
    }
    if (!manifest) {
      const lease = await acquireLifecycleLock(paths, host, 'uninstall', false)
      try {
        if (fs.existsSync(paths.lifecycleWalPath)) throw new Error('lifecycle WAL remains without an installation manifest')
        if (readInstallManifest(paths, host.platform)) throw new Error('installation appeared during idempotent uninstall')
        const marker = readDataRootMarker(paths, host.platform)
        if (marker?.activeInstallId) throw new Error('data root still names an active installation')
        if (!marker && fs.existsSync(paths.installDir)) throw new Error('install directory has no ownership manifest')
      } finally {
        await lease.release()
      }
      return alreadyUninstalled()
    }
    assertUninstallProvidersAvailable(manifest, host)
    const manifestPaths = pathsForManifest(manifest, paths, host)
    if (!manifestIntegrationOwned(manifestPaths, manifest, host, 'uninstall')) {
      throw new Error('existing installation no longer matches its ownership manifest')
    }
    // From this point every external-artifact authority comes from the
    // embedded manifest, never the current APPDATA/npm heuristic.
    paths = manifestPaths
    installedPackage = packageIdentity(packageRoot)
    if (installedPackage.sha256 !== manifest.packageSha256
      || !samePath(installedPackage.packageRoot, manifest.packageRoot, host.platform)) {
      return failed('uninstall must run from the package bound by the ownership manifest')
    }
    dataMarker = readDataRootMarker(paths, host.platform)
    if (!dataMarker || dataMarker.dataRootId !== manifest.dataRootId || dataMarker.activeInstallId !== manifest.installId) {
      return failed('data-root marker does not match the installation')
    }
    assertMarkerBindsPackage(dataMarker, manifest.packageRoot, 'installed')
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error))
  }
  const internalOwnedFiles = manifest.owned.files
    .filter((entry) => isSameOrInside(paths.installDir, entry.path, host.platform))
    .map((entry) => entry.path)
  const externalArtifacts = planUninstallExternalArtifacts(paths, manifest, host.platform)
  const snapshot = snapshotIntegration(
    paths,
    host,
    [paths.manifestPath, paths.dataMarkerPath, ...internalOwnedFiles],
    [],
    { path: manifest.features.path, task: manifest.features.task }
  )
  const inactiveMarker = { ...dataMarker!, activeInstallId: null }
  const activeRootReceipt = lifecycleRootReceiptForManifest(manifest, 'active', lifecycleReceipt)
  const inactiveRootReceipt = lifecycleRootReceiptForManifest(
    manifest,
    'inactive',
    activeRootReceipt,
    new Date().toISOString()
  )
  const uninstallWalId = randomUUID()
  const receiptAuthority = captureInstalledLifecycleAuthoritySnapshot(
    paths,
    installedPackage!,
    manifest,
    dataMarker!,
    host,
    'uninstall receipt',
    'uninstall'
  )
  const sealUninstallReceiptAuthority = () => assertInstalledLifecycleAuthoritySnapshot(
    paths,
    installedPackage!,
    manifest,
    dataMarker!,
    receiptAuthority,
    host,
    'uninstall receipt',
    'uninstall'
  )
  const tombstone = `${paths.installDir}.uninstalling-${manifest.installId}-${uninstallWalId}`
  const uninstallFiles = new Map<string, string | Buffer | null>([
    [paths.manifestPath, null],
    [paths.dataMarkerPath, `${JSON.stringify(inactiveMarker, null, 2)}\n`],
    ...internalOwnedFiles.map((file) => [file, null] as const)
  ])
  const frozenIntegration = lifecycleIntegrationState(snapshot)
  const projectedIntegration = projectedLifecycleIntegration('uninstall', frozenIntegration, manifest, host)
  const uninstallEnvironment = new Map<(typeof LIFECYCLE_ENV_NAMES)[number], UserEnvironmentState>(projectedIntegration.environment.map((entry) => [entry.name, {
    exists: entry.exists,
    value: entry.value,
    kind: entry.kind
  } as UserEnvironmentState] as const))
  const uninstallExpected = expectedIntegration(snapshot, {
    files: uninstallFiles,
    userPath: {
      exists: projectedIntegration.userPath.exists,
      value: projectedIntegration.userPath.value,
      kind: projectedIntegration.userPath.kind
    },
    pathManaged: manifest.features.path,
    environment: uninstallEnvironment,
    taskExisted: projectedIntegration.task.exists,
    taskLauncher: projectedIntegration.task.action
  })
  let wasDaemonRunning = false
  let lifecycleLease: LifecycleLease | null = null
  let stopped = false
  let taskRemoved = false
  let pathRemoved = false
  let filesRemoved = false
  let extraShimsRemoved = false
  let lifecycleWal: LifecycleWalV1 | null = null
  let lifecycleCommitted = false
  let rollbackCompleted = false
  try {
    lifecycleLease = await acquireLifecycleLock(paths, host, 'uninstall', true, {
      target: activeRootReceipt,
      allowedCurrent: [lifecycleReceipt, activeRootReceipt],
      sealBeforePublication: sealUninstallReceiptAuthority,
      sealAfterPublication: sealUninstallReceiptAuthority
    })
    assertApplicationQuiescent(paths.dataRoot, host, lifecycleLease.applicationOwner || undefined)
    const lockedPackage = packageIdentity(manifest.packageRoot)
    await lifecycleLease.revalidateApplicationGate()
    const lockedManifest = readInstallManifest(paths, host.platform)
    if (lockedManifest && !manifestIntegrationOwned(paths, lockedManifest, host, 'uninstall')) {
      throw new Error('internal install ownership changed after uninstall preflight')
    }
    if (lockedPackage.sha256 !== manifest.packageSha256
      || lockedPackage.version !== manifest.packageVersion
      || !lockedManifest || canonicalJson(lockedManifest) !== canonicalJson(manifest)) {
      throw new Error('ownership manifest changed after uninstall preflight')
    }
    const lockedMarker = preflightDataRoot(paths, lockedPackage, host, true)
    if (canonicalJson(lockedMarker) !== canonicalJson(dataMarker)) throw new Error('data-root marker changed after uninstall preflight')
    assertMarkerBindsPackage(dataMarker!, manifest.packageRoot, 'installed')
    assertIntegrationSnapshotCurrent(paths, host, snapshot)
    for (const artifact of externalArtifacts) {
      assertExternalArtifactFactCurrent(artifact.path, artifact.before, `external artifact ${artifact.path}`)
    }
    assertNoForeignLiveLifecycleProcess(paths, host, manifest.features.daemon ? [manifest.packageRoot] : [])
    if (manifest.features.daemon) {
      wasDaemonRunning = await sealDaemonLifecycleStateBeforeMutation(
        paths,
        host,
        manifest.packageRoot,
        manifest.port,
        lifecycleLease.revalidateApplicationGate
      )
    }
    lifecycleWal = {
      schemaVersion: 1,
      walId: uninstallWalId,
      lockToken: lifecycleLease.token,
      operation: 'uninstall',
      phase: 'prepared',
      installDir: paths.installDir,
      oldManifest: manifest,
      newManifest: null,
      oldReceipt: activeRootReceipt,
      newReceipt: inactiveRootReceipt,
      oldMarker: dataMarker,
      newMarker: inactiveMarker,
      oldIntegration: frozenIntegration,
      newIntegration: lifecycleIntegrationState(uninstallExpected),
      externalArtifacts,
      tombstone,
      oldDaemonRunning: wasDaemonRunning,
      createdAt: new Date().toISOString()
    }
    registerLifecycleMutationFence(paths, lifecycleWal)
    await lifecycleLease.revalidateApplicationGate()
    writeLifecycleWal(paths, lifecycleWal, null, host)
    await lifecycleLease.revalidateApplicationGate()
    taskRemoved = await closeWalBoundTaskRestartSource(paths, lifecycleWal, host, lifecycleLease.revalidateApplicationGate)
    await lifecycleLease.revalidateApplicationGate()
    if (manifest.features.daemon) {
      const lifecycleAuthority = daemonLifecycleControlAuthority(
        paths,
        host,
        lifecycleLease.token
      )
      const daemonTerminal = await stopInstalledDaemonRuntime(paths, host, lifecycleAuthority, privateHooks.daemonStop)
      if (!daemonTerminal) throw new Error('daemon stop failed or was refused; uninstall preserved owned state')
      stopped = wasDaemonRunning
    }
    await lifecycleLease.revalidateApplicationGate()
    assertLegacyApplicationLeaseNamespaceClear(paths.dataRoot)
    assertApplicationQuiescent(paths.dataRoot, host, lifecycleLease.applicationOwner || undefined)
    assertNoForeignLiveLifecycleProcess(paths, host, [])

    if (!host.skipPath && host.platform === 'win32') {
      if (!sameUserPathState(snapshot.userPath, uninstallExpected.userPath)) {
        await lifecycleLease.revalidateApplicationGate()
        const current = host.userPathState()
        if (!sameUserPathState(current, snapshot.userPath)) throw new Error('owned user PATH changed during uninstall')
        const next = uninstallExpected.userPath
        if (!sameUserPathState(next, uninstallExpected.userPath)
          || !host.compareExchangeUserPath(current, next)
          || !sameUserPathState(host.userPathState(), uninstallExpected.userPath)) {
          throw new Error('user PATH uninstall postcondition failed')
        }
      }
      for (const entry of manifest.owned.environment) {
        const oldState = snapshot.environment.get(entry.name) || absentUserEnvironmentState()
        const next = uninstallEnvironment.get(entry.name) || absentUserEnvironmentState()
        if (sameUserEnvironmentState(oldState, next)) continue
        await lifecycleLease.revalidateApplicationGate()
        const current = host.userEnvState(entry.name)
        if (!sameUserEnvironmentState(current, oldState)
          || !host.compareExchangeUserEnv(entry.name, current, next)) {
          throw new Error(`owned user environment changed during uninstall: ${entry.name}`)
        }
        if (!sameUserEnvironmentState(host.userEnvState(entry.name), next)) {
          throw new Error(`user environment uninstall postcondition failed: ${entry.name}`)
        }
      }
      if (!sameUserPathState(snapshot.userPath, uninstallExpected.userPath)
        || [...snapshot.environment].some(([name, state]) => !sameUserEnvironmentState(
          state,
          uninstallEnvironment.get(name as (typeof LIFECYCLE_ENV_NAMES)[number]) || absentUserEnvironmentState()
        ))) host.broadcastEnv()
    }
    pathRemoved = !sameUserPathState(snapshot.userPath, uninstallExpected.userPath)

    assertLifecycleExternalArtifactsCurrent(lifecycleWal, false)
    for (const entry of externalArtifacts.filter((candidate) => candidate.action === 'delete-exact')) {
      await lifecycleLease.revalidateApplicationGate()
      unlinkOwnedFileByIsolation(entry.path, entry.ownedSha256, lifecycleWal, `owned global shim ${entry.path}`)
      if (fs.existsSync(entry.path)) throw new Error(`owned global shim uninstall postcondition failed: ${entry.path}`)
    }
    extraShimsRemoved = externalArtifacts.some((entry) => entry.action === 'delete-exact')

    assertManagedInstallTree(paths, manifest, host.platform)
    await lifecycleLease.revalidateApplicationGate()
    writeFileFromAllowed(paths.dataMarkerPath, recordBytes(inactiveMarker), [recordBytes(dataMarker!)], 'uninstall data-root marker', lifecycleWal)
    assertOwnedLifecycleProof(paths, host, ownedLifecycleProof(lifecycleLease, lifecycleWal))
    if (fs.existsSync(tombstone)) throw new Error('uninstall tombstone already exists; recovery is required')
    await lifecycleLease.revalidateApplicationGate()
    assertManagedInstallTree(paths, manifest, host.platform)
    assertCurrentFileAllowed(paths.dataMarkerPath, [recordBytes(inactiveMarker)], 'uninstall marker before install isolation')
    lifecycleRenameSync(paths.installDir, tombstone, lifecycleWal, paths.installDir, true)
    const tombstoneProof = assertUninstallTombstoneClosure(paths, lifecycleWal, true)
    // Once the install root has been isolated, never relabel a partially
    // deleted tombstone as the canonical install. Any interruption leaves the
    // WAL plus its private quarantine for same-process or restart recovery.
    await removeFrozenTree(tombstone, tombstoneProof.entries, lifecycleLease.revalidateApplicationGate)
    filesRemoved = !fs.existsSync(paths.installDir)
    if (!filesRemoved) throw new Error(`failed to remove install directory ${paths.installDir}`)
    const priorRelease = recoverableRelease(manifest, paths, host, lifecycleEnvironment, 'uninstall source')
    await assertCommittedWalTerminal(lifecycleWal, [priorRelease], host)
    await lifecycleLease.revalidateApplicationGate()
    assertCommittedUninstallTerminal(lifecycleWal, [priorRelease], host)
    assertOwnedLifecycleProof(paths, host, ownedLifecycleProof(lifecycleLease, lifecycleWal))
    const committedWal: LifecycleWalV1 = { ...lifecycleWal, phase: 'committed' }
    writeLifecycleWal(paths, committedWal, lifecycleWal, host)
    lifecycleWal = committedWal
    lifecycleCommitted = true
    const committedProtocolEpoch = createCommittedUninstallProtocolEpoch(
      paths,
      lifecycleWal,
      host,
      captureFileState(paths.lifecycleWalPath, LIFECYCLE_WAL_MAX_BYTES),
      undefined,
      undefined,
      lifecycleLease.sealApplicationGate
    )
    committedProtocolEpoch.seal()
    ensureLifecycleRootReceipt(host, inactiveRootReceipt, [activeRootReceipt, inactiveRootReceipt])
    committedProtocolEpoch.advanceReceipt(inactiveRootReceipt)
    committedProtocolEpoch.seal()
    removeLifecycleWal(paths, lifecycleWal)
    committedProtocolEpoch.advanceWalRemoval()
  } catch (error) {
    if (error instanceof LifecycleWalPublicationError) lifecycleLease?.preserveOwnerRecord()
    issues.push({ level: 'error', message: error instanceof Error ? error.message : String(error) })
    if (!lifecycleCommitted) {
      try {
        if (lifecycleWal) {
          if (!lifecycleLease) throw new Error('uninstall rollback lost its lifecycle lock')
          assertOwnedLifecycleProof(paths, host, ownedLifecycleProof(lifecycleLease, lifecycleWal))
          const recovered = await recoverLifecycleWalIfNeeded(
            paths,
            host,
            lifecycleEnvironment,
            lifecycleLease.applicationOwner || undefined,
            lifecycleLease.revalidateApplicationGate,
            undefined,
            privateHooks.daemonStop
          )
          if (!recovered) throw new Error('lifecycle WAL vanished before uninstall rollback')
          rollbackCompleted = true
        }
      } catch (rollbackError) {
        issues.push({ level: 'error', message: `uninstall rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}` })
      }
    }
    if (rollbackCompleted) {
      stopped = false
      taskRemoved = false
      pathRemoved = false
      filesRemoved = false
      extraShimsRemoved = false
    }
  } finally {
    if (lifecycleLease) await lifecycleLease.release()
  }
  if (rollbackCompleted && lifecycleWal?.oldDaemonRunning) {
    const started = await startDaemonDetached(manifest.packageRoot, host, manifest.dataRoot)
    if (!started.ok) issues.push({ level: 'error', message: `post-rollback daemon start failed: ${started.detail}` })
  }
  const ok = filesRemoved && issues.every((issue) => issue.level !== 'error')
  return {
    ok,
    action: 'uninstall',
    status: ok ? 'uninstalled' : 'failed',
    stopped,
    taskRemoved,
    pathRemoved,
    filesRemoved,
    extraShimsRemoved,
    installDir: paths.installDir,
    issues
  }
}

export async function startDaemonDetached(
  packageRoot: string,
  host: InstallHost = createInstallHost(),
  dataRoot?: string,
  dependencies: StartDaemonDependencies = {}
): Promise<{ ok: boolean; pid: number; apiHealthy: boolean; detail: string }> {
  const environment = freezeInstallEnvironment(host)
  const paths = installPathsFor(packageRoot, host, dataRoot, environment)
  let tracePreflight: FrozenDaemonTracePreflight
  try {
    tracePreflight = preflightDaemonTraceEnvironment(environment, host.platform, paths.dataRoot)
  } catch (error) {
    return {
      ok: false,
      pid: 0,
      apiHealthy: false,
      detail: `invocation trace gate is invalid: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  return startDaemonDetachedAfterPreflight(paths, host, tracePreflight, dependencies)
}

export type DaemonRunLifecycleGuard = {
  revalidate: () => void
  release: (terminalSeal?: () => void | Promise<void>) => Promise<void>
  taskRestartSource: { name: string; launcher: string; owned: boolean } | null
}

function assertDaemonStartupTargetsSafe(dataRoot: string): void {
  const files = reviewFiles(dataRoot)
  const reviewStat = lstatOptional(files.review)
  if (reviewStat && (!reviewStat.isDirectory() || reviewStat.isSymbolicLink())) {
    throw new Error('daemon startup review root is not a plain directory')
  }
  // The v1 daemon protocol owns pid/api/heartbeat and deliberately forms R2
  // hard-link pairs while publishing or collapsing a START stage.  Treating
  // those transient links as generic mutable targets would make the lifecycle
  // guard reject the protocol's own legal checkpoints.  The protocol performs
  // the exact inode/link/content validation for those three paths; this outer
  // static guard retains responsibility only for the non-authority log file.
  for (const [file, limit] of [[files.logFile, 2_000_000]] as const) {
    const stat = lstatOptional(file)
    if (!stat) continue
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit) {
      throw new Error(`daemon startup target is unsafe: ${file}`)
    }
  }
}

function assertDaemonLifecycleWalClear(paths: InstallPaths): void {
  if (lstatOptional(paths.lifecycleWalPath)) {
    throw new Error('lifecycle WAL still requires recovery before daemon startup')
  }
  const parent = dirname(paths.lifecycleWalPath)
  if (!lstatOptional(parent)) return
  assertPlainDirectory(parent, 'daemon lifecycle authority parent')
  const prefix = `${basename(paths.lifecycleWalPath)}.`
  const pending = boundedMatchingDirectoryEntries(
    parent,
    (entry) => entry.name.startsWith(prefix) && entry.name.endsWith('.pending'),
    2,
    'daemon lifecycle pending authority inventory'
  )
  if (pending.length > 0) {
    throw new Error('lifecycle pending authority still requires recovery before daemon startup')
  }
}

export async function acquireDaemonRunLifecycleGuard(
  packageRoot: string,
  dataRoot?: string,
  host: InstallHost = createInstallHost()
): Promise<DaemonRunLifecycleGuard> {
  const environment = freezeInstallEnvironment(host)
  const requested = installPathsFor(packageRoot, host, dataRoot, environment)
  preflightLifecycleRoots(requested, host)
  const mutex = createServer((socket) => socket.destroy())
  let closed = false
  let validateStaticAuthority = () => {}
  const release = async (terminalSeal?: () => void | Promise<void>) => {
    if (closed) return
    try {
      validateStaticAuthority()
      if (terminalSeal) {
        await terminalSeal()
        validateStaticAuthority()
      }
    } finally {
      closed = true
      await closeLifecycleMutex(mutex)
    }
  }
  try {
    await listenLifecycleMutex(mutex, lifecycleMutexName(requested, host))
    preflightLifecycleRoots(requested, host)
    assertDaemonLifecycleWalClear(requested)
    const durable = durablePendingCount(requested.dataRoot)
    if (durable > 0) throw new Error(`${durable} durable transaction artifact(s) require recovery before daemon startup`)
    const receiptNamespace = readLifecycleRootReceiptNamespace(host)
    if (receiptNamespace.pendingState || receiptNamespace.writingState) {
      throw new Error('daemon startup requires a terminal lifecycle root receipt with no publication residue')
    }
    const receipt = receiptNamespace.receipt
    if (!receipt || receipt.state !== 'active' || !receiptNamespace.receiptState?.stat
      || receiptNamespace.receiptState.stat.nlink !== 1) {
      throw new Error('daemon startup requires a uniquely published active lifecycle root receipt')
    }
    const manifest = readInstallManifest(requested, host.platform)
    if (!manifest || !manifest.features.daemon) throw new Error('daemon startup requires an active daemon-enabled installation manifest')
    if (!samePath(manifest.packageRoot, packageRoot, host.platform)) {
      throw new Error('daemon startup package differs from the active installation manifest')
    }
    const paths = pathsForManifest(manifest, requested, host)
    const identity = packageIdentity(packageRoot)
    if (identity.sha256 !== manifest.packageSha256 || identity.version !== manifest.packageVersion) {
      throw new Error('daemon startup package identity differs from the active installation manifest')
    }
    const marker = readDataRootMarker(paths, host.platform)
    if (!marker || marker.activeInstallId !== manifest.installId || marker.dataRootId !== manifest.dataRootId) {
      throw new Error('daemon startup data marker differs from the active installation manifest')
    }
    assertMarkerBindsPackage(marker, manifest.packageRoot, 'daemon startup')
    const runtimeMarker = preflightDataRoot(paths, identity, host, true)
    if (!runtimeMarker || canonicalJson(runtimeMarker) !== canonicalJson(marker)) {
      throw new Error('daemon startup data runtime differs from its active marker')
    }
    if (!manifestIntegrationOwned(paths, manifest, host)) {
      throw new Error('daemon startup integration differs from the active installation manifest')
    }
    assertLifecycleRootReceiptBindsManifest(receipt, manifest, 'active', host)
    assertDaemonStartupTargetsSafe(paths.dataRoot)
    const installedAuthority = captureInstalledLifecycleAuthoritySnapshot(
      paths,
      identity,
      manifest,
      marker,
      host,
      'daemon startup',
      // PATH, user-environment, and Scheduled Task ownership are checked
      // strictly above before the guard is issued and again by setup/doctor.
      // They are not inputs to the running daemon. Revalidating the frozen
      // startup authority therefore uses the existing internal-files mode and
      // avoids spawning a registry/task provider at every protocol checkpoint.
      'uninstall'
    )
    const receiptDirectoryFence = captureDirectoryFence(receiptNamespace.directory)
    const receiptState = receiptNamespace.receiptState
    const files = reviewFiles(paths.dataRoot)
    let reviewFence: DirectoryFence | null = lstatOptional(files.review)
      ? captureDirectoryFence(files.review)
      : null
    let requireOwnerAbsent = false
    validateStaticAuthority = () => {
      if (closed) throw new Error('daemon lifecycle guard is already closed')
      assertDirectoryFence(receiptNamespace.directory, receiptDirectoryFence)
      assertCapturedFileState(
        receiptNamespace.file,
        receiptState,
        'daemon startup lifecycle root receipt',
        LIFECYCLE_ROOT_RECEIPT_MAX_BYTES
      )
      const currentReceiptNamespace = readLifecycleRootReceiptNamespace(host)
      if (currentReceiptNamespace.pendingState || currentReceiptNamespace.writingState
        || !sameLifecycleRootReceipt(currentReceiptNamespace.receipt, receipt)) {
        throw new Error('daemon startup lifecycle root receipt changed while publishing the service')
      }
      assertDaemonLifecycleWalClear(requested)
      const currentDurable = durablePendingCount(requested.dataRoot)
      if (currentDurable > 0) throw new Error(`${currentDurable} durable transaction artifact(s) appeared during daemon startup`)
      assertInstalledLifecycleAuthoritySnapshot(
        paths,
        identity,
        manifest,
        marker,
        installedAuthority,
        host,
        'daemon startup',
        'uninstall'
      )
      if (requireOwnerAbsent && lstatOptional(requested.lifecycleLockPath)) {
        throw new Error('daemon startup lifecycle owner reappeared while publishing the service')
      }
      assertDaemonStartupTargetsSafe(paths.dataRoot)
      if (reviewFence) {
        assertDirectoryFence(files.review, reviewFence)
      } else if (lstatOptional(files.review)) {
        throw new Error('daemon startup review root appeared before its guarded publication')
      }
      assertCapturedFileState(
        receiptNamespace.file,
        receiptState,
        'daemon startup lifecycle root receipt terminal seal',
        LIFECYCLE_ROOT_RECEIPT_MAX_BYTES
      )
    }
    validateStaticAuthority()
    // Only a fully sealed active install/receipt may authorize normalization or
    // retirement of a stale lifecycle owner. A malformed receipt or static
    // installation therefore leaves all prior owner evidence untouched.
    retireStaleLifecycleOwnerWithoutWal(requested, host)
    requireOwnerAbsent = true
    validateStaticAuthority()
    if (!reviewFence) {
      validateStaticAuthority()
      fs.mkdirSync(files.review)
      flushDirectory(paths.dataRoot)
      reviewFence = captureDirectoryFence(files.review)
      validateStaticAuthority()
    }
    return {
      revalidate: validateStaticAuthority,
      release,
      taskRestartSource: manifest.features.task
        ? { name: paths.taskName, launcher: paths.silentVbs, owned: Boolean(manifest.owned.task?.created) }
        : null
    }
  } catch (error) {
    await release()
    throw error
  }
}

export async function stopDaemonGuarded(
  packageRoot: string,
  host: InstallHost = createInstallHost(),
  dataRoot?: string,
  dependencies: StopDaemonDependencies = {}
): Promise<boolean> {
  const environment = freezeInstallEnvironment(host)
  const paths = installPathsFor(packageRoot, host, dataRoot, environment)
  let guard: DaemonRunLifecycleGuard
  try {
    guard = await acquireDaemonRunLifecycleGuard(packageRoot, paths.dataRoot, host)
  } catch {
    return false
  }
  let stopped = false
  let released = false
  try {
    if (guard.taskRestartSource) {
      if (!guard.taskRestartSource.owned) return false
      guard.revalidate()
      host.stopScheduledTaskInstance(guard.taskRestartSource.name, guard.taskRestartSource.launcher)
      guard.revalidate()
    }
    const checkpoint: DaemonProtocolCheckpoint = (name, facts) => {
      guard.revalidate()
      dependencies.checkpoint?.(name, facts)
      guard.revalidate()
    }
    guard.revalidate()
    stopped = await stopInstalledDaemonRuntime(paths, host, null, { ...dependencies, checkpoint })
    guard.revalidate()
  } catch {
    stopped = false
  } finally {
    try {
      await guard.release()
      released = true
    } catch {
      released = false
    }
  }
  return stopped && released
}

async function startDaemonDetachedAfterPreflight(
  paths: ReturnType<typeof installPathsFor>,
  host: InstallHost,
  tracePreflight: FrozenDaemonTracePreflight,
  dependencies: StartDaemonDependencies = {}
): Promise<{ ok: boolean; pid: number; apiHealthy: boolean; detail: string }> {
  const now = dependencies.now || Date.now
  const pause = dependencies.sleep || ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const processHost = dependencies.processHost || createDaemonProcessHost()
  const daemonTrace = tracePreflight.daemonTrace
  const runtimeOptions = installedDaemonRuntimeOptions(paths, host)
  const healthProbe = installedDaemonHealthProbe(paths, dependencies.ping)
  const startupWindowMs = 240_000
  let deadline = now() + startupWindowMs
  const confirmReleasedStartupAuthority = async (
    expectedEpoch: string
  ): Promise<Extract<DaemonAuthorityObservation, { state: 'exact' }> | null> => {
    try {
      return await withLifecycleReadMutex(paths, host, async () => {
        const sealed = await observeDaemonAuthority(runtimeOptions, processHost, healthProbe)
        return sealed.state === 'exact' && sealed.instance.epochId === expectedEpoch ? sealed : null
      })
    } catch (error) {
      if ((error instanceof Error ? error.message : String(error)).includes('EADDRINUSE')) return null
      throw error
    }
  }
  let observation = await observeDaemonAuthority(runtimeOptions, processHost, healthProbe)
  if (observation.state === 'exact') {
    while (now() < deadline) {
      const sealed = await confirmReleasedStartupAuthority(observation.instance.epochId)
      if (sealed) {
        return {
          ok: true,
          pid: sealed.instance.pid,
          apiHealthy: true,
          detail: `pid ${sealed.instance.pid} ${paths.apiUrl}`
        }
      }
      await pause(250)
      observation = await observeDaemonAuthority(runtimeOptions, processHost, healthProbe)
      if (observation.state !== 'exact') break
    }
  }
  const startupRecoverable = observation.state === 'not-running'
      && (observation.protocolKind === 'ABSENT' || observation.protocolKind === 'NAMESPACE-RECOVERABLE')
    || observation.state === 'control-required' && [
      'STARTING-PARTIAL',
      'STARTING',
      'RUNNING-LINKED',
      'RUNNING-COLLAPSING'
    ].includes(observation.protocolKind)
  if (!startupRecoverable) {
    return {
      ok: false,
      pid: 0,
      apiHealthy: false,
      detail: `refusing daemon launch while v1 authority is ${observation.state}; evidence preserved`
    }
  }
  const listenerBeforeLaunch = processHost.listenerFacts(paths.port)
  if (listenerBeforeLaunch.state !== 'absent') {
    return {
      ok: false,
      pid: 0,
      apiHealthy: false,
      detail: `refusing daemon launch while listener facts are ${listenerBeforeLaunch.state}`
    }
  }
  if (host.platform === 'win32') {
    const launchers = renderShims(
      paths,
      daemonTrace,
      daemonLauncherEnvironment(host, tracePreflight.baseEnvironment, paths)
    )
    const expected = new Map<string, Buffer>([
      [paths.silentVbs, Buffer.from(launchers.vbs, 'utf8')],
      [paths.runDaemonCmd, Buffer.from(launchers.runDaemonCmd, 'utf8')]
    ])
    for (const [file, bytes] of expected) {
      const actual = readBoundedPlainFile(file, 1024 * 1024, 'installed daemon launcher')
      if (!actual.equals(bytes)) {
        return { ok: false, pid: 0, apiHealthy: false, detail: `installed daemon launcher changed: ${file}` }
      }
    }
  }
  const launchDaemon = () => host.platform === 'win32'
    ? host.wmiCreate(`cmd.exe /c "${paths.runDaemonCmd}"`, paths.packageRoot)
    : (() => {
        const launch = createPosixDaemonLaunchSpec(
          paths,
          tracePreflight.baseEnvironment,
          daemonTrace,
          host.platform
        )
        return host.launchDetached(launch.command, launch.args, launch.opts)
      })()
  let launched = launchDaemon()
  if (!Number.isSafeInteger(launched) || launched < 1) {
    return { ok: false, pid: 0, apiHealthy: false, detail: 'daemon launcher did not return a process id' }
  }
  // Preflight and launcher creation can be expensive on Windows.  The daemon
  // gets the complete convergence window only after a valid launcher PID has
  // actually been returned.
  deadline = now() + startupWindowMs
  const launchedPids = [launched]
  observation = await observeDaemonAuthority(runtimeOptions, processHost, healthProbe)
  let terminal: Extract<DaemonAuthorityObservation, { state: 'exact' }> | null = null
  let transientInvalidSamples = 0
  let absentAfterLauncherExitSamples = 0
  while (now() < deadline) {
    if (observation.state === 'exact') {
      transientInvalidSamples = 0
      terminal = await confirmReleasedStartupAuthority(observation.instance.epochId)
      if (terminal) break
    } else if (observation.state === 'dead' || observation.state === 'foreign') {
      break
    } else if (observation.state === 'control-required') {
      const canonicalStartTransition = [
        'STARTING-PARTIAL',
        'STARTING',
        'RUNNING-LINKED',
        'RUNNING-COLLAPSING'
      ].includes(observation.protocolKind)
      // The detached parent observes the same namespace while the child is
      // unlinking/fsyncing a committed START.  A single inspection can straddle
      // that mutation and classify the otherwise canonical reservation as
      // INVALID.  Do not turn that read race into a failed setup (whose cleanup
      // would then kill the still-publishing child).  INVALID inspections
      // deliberately erase parsed reservation facts, so this cannot safely
      // key off an operation id.  Instead it grants only a short observation
      // retry after this function has launched the child; it grants no
      // mutation authority, and a stable INVALID state still fails closed.
      const transientStartInspection = observation.protocolKind === 'INVALID'
      if (canonicalStartTransition) {
        transientInvalidSamples = 0
      } else if (transientStartInspection && transientInvalidSamples < 8) {
        transientInvalidSamples += 1
      } else {
        break
      }
    } else if (observation.state === 'not-running') {
      let launcherState: ReturnType<DaemonProcessHost['processFacts']> = Object.freeze({ state: 'unknown' })
      try {
        launcherState = processHost.processFacts(launched)
      } catch {
        // Provider failure remains unknown and never authorizes a relaunch.
      }
      if (launcherState.state === 'dead') {
        absentAfterLauncherExitSamples += 1
        if (absentAfterLauncherExitSamples >= 4) {
          if (launchedPids.length >= 2) break
          const retryListener = processHost.listenerFacts(paths.port)
          const retryObservation = await observeDaemonAuthority(runtimeOptions, processHost, healthProbe)
          const retryableAbsence = retryObservation.state === 'not-running'
            && (retryObservation.protocolKind === 'ABSENT'
              || retryObservation.protocolKind === 'NAMESPACE-RECOVERABLE')
          if (retryListener.state !== 'absent' || !retryableAbsence) {
            observation = retryObservation
            absentAfterLauncherExitSamples = 0
          } else {
            const retried = launchDaemon()
            if (!Number.isSafeInteger(retried) || retried < 1) break
            launched = retried
            launchedPids.push(retried)
            // A proven-dead launcher consumed part of the original budget
            // without starting a daemon.  The single authorized retry gets
            // one complete startup window; the one-retry cap and terminal
            // evidence checks above still bound the operation.
            deadline = now() + startupWindowMs
            absentAfterLauncherExitSamples = 0
            observation = await observeDaemonAuthority(runtimeOptions, processHost, healthProbe)
            continue
          }
        }
      } else {
        absentAfterLauncherExitSamples = 0
      }
    }
    await pause(250)
    observation = await observeDaemonAuthority(runtimeOptions, processHost, healthProbe)
  }
  const livePid = terminal?.instance.pid || 0
  const ok = livePid > 0
  const observationDetail = observation.state === 'control-required'
    ? `${observation.state}/${observation.protocolKind}${observation.inspection.reason ? ` (${observation.inspection.reason})` : ''}`
    : observation.state
  return {
    ok,
    pid: livePid,
    apiHealthy: ok,
    detail: ok
      ? `pid ${livePid} ${paths.apiUrl}`
      : `launched pid${launchedPids.length === 1 ? '' : 's'} ${launchedPids.join(',')}; v1 daemon authority is ${observationDetail}; evidence preserved`
  }
}

export async function upgradeHub(
  packageRoot: string,
  flags: UpgradeFlags,
  host: InstallHost = createInstallHost()
): Promise<UpgradeResult> {
  const environment = freezeInstallEnvironment(host)
  const requestedPaths = installPathsFor(packageRoot, host, undefined, environment)
  let paths = requestedPaths
  const issues: DoctorIssue[] = []
  let candidate: PackageIdentity | null = null
  let oldPackage: PackageIdentity | null = null
  let oldManifest: InstallManifestV2 | null = null
  let oldMarker: DataRootMarkerV1 | null = null
  let receiptBefore: LifecycleRootReceiptV1 | null = null
  let oldRootReceipt: LifecycleRootReceiptV1 | null = null
  let lifecycleEnvironment = environment
  let postCommitDaemon = false
  let rollbackDaemonManifest: InstallManifestV2 | null = null
  let existingPaths: InstallPaths | null = null
  let status: UpgradeResult['status'] = 'failed'
  try {
    const receiptNamespace = readLifecycleRootReceiptNamespace(host)
    assertNoPurgingLifecycleRootReceipt(receiptNamespace, 'upgrade')
    receiptBefore = receiptNamespace.receipt || receiptNamespace.pendingReceipt
    if (receiptBefore) {
      if (setupSelectionExplicit(environment)) assertExplicitSelectionMatchesReceipt(requestedPaths, receiptBefore, host)
      paths = installPathsForLifecycleRootReceipt(packageRoot, host, receiptBefore, environment, false)
      lifecycleEnvironment = environmentBoundToManifestPaths(environment, paths)
    }
    preflightLifecycleRoots(paths, host)
    if (fs.existsSync(paths.lifecycleWalPath)) {
      if (flags.dryRun) throw new Error('lifecycle WAL requires recovery before upgrade dry-run')
      const receiptBeforeRecovery = receiptBefore
      await recoverLifecycleWalUnderLock(paths, host, lifecycleEnvironment)
      const recoveredReceipt = readLifecycleRootReceipt(host)
      if (!recoveredReceipt) throw new Error('upgrade lifecycle WAL recovery lost its preserved root receipt')
      if (receiptBeforeRecovery
        && !sameLifecycleRootReceiptNamespace(receiptBeforeRecovery, recoveredReceipt, host)) {
        throw new Error('upgrade lifecycle WAL recovery changed the preserved root namespace')
      }
      if (setupSelectionExplicit(environment)) assertExplicitSelectionMatchesReceipt(requestedPaths, recoveredReceipt, host)
      receiptBefore = recoveredReceipt
      paths = installPathsForLifecycleRootReceipt(packageRoot, host, recoveredReceipt, environment, false)
      lifecycleEnvironment = environmentBoundToManifestPaths(environment, paths)
      preflightLifecycleRoots(paths, host)
    }
    preflightDaemonTraceEnvironment(lifecycleEnvironment, host.platform, paths.dataRoot)
    candidate = packageIdentity(packageRoot)
    existingPaths = receiptBefore
      ? (() => {
          const located = readInstallManifest(paths, host.platform, 'install-only')
          if (!located) throw new Error('preserved root receipt has no owned installation manifest')
          return pathsForManifest(located, paths, host)
        })()
      : existingManifestPathsForUpgrade(paths, host, environment)
    oldManifest = preflightExistingOwnership(existingPaths, host)
    if (!oldManifest) throw new Error('upgrade requires an owned existing installation')
    if (receiptBefore) assertLifecycleRootReceiptBindsManifest(receiptBefore, oldManifest, 'active', host)
    oldRootReceipt = lifecycleRootReceiptForManifest(oldManifest, 'active', receiptBefore)
    paths = resolveInstallPaths(pathApi, {
      hubRoot: candidate.packageRoot,
      packageRoot: candidate.packageRoot,
      dataRoot: oldManifest.dataRoot,
      nodePath: oldManifest.nodePath,
      installDir: oldManifest.installDir,
      extraShimDir: oldManifest.extraShimDir,
      taskName: oldManifest.taskName,
      port: oldManifest.port
    })
    lifecycleEnvironment = environmentBoundToManifestPaths(environment, paths)
    if (flags.noDaemon && oldManifest.features.daemon) {
      throw new Error('upgrade --no-daemon cannot change an installed daemon feature in place; uninstall and set up with daemon/task disabled')
    }
    if (flags.noDaemon && oldManifest.features.task) {
      throw new Error('upgrade --no-daemon cannot leave an owned logon task; uninstall and set up with daemon/task disabled')
    }
    oldPackage = packageIdentity(oldManifest.packageRoot)
    if (oldPackage.sha256 !== oldManifest.packageSha256 || oldPackage.version !== oldManifest.packageVersion) {
      throw new Error('installed package no longer matches the ownership manifest')
    }
    const versionPrecedence = compareSemVerVersions(candidate.version, oldManifest.packageVersion)
    if (versionPrecedence < 0) {
      throw new Error(`candidate release version ${candidate.version} is lower than installed version ${oldManifest.packageVersion}; semantic version downgrade is refused`)
    }
    if (versionPrecedence === 0 && candidate.sha256 !== oldManifest.packageSha256) {
      if (candidate.version === oldManifest.packageVersion) {
        throw new Error('candidate release reuses the installed version with different package bytes')
      }
      throw new Error('candidate release has the installed semantic version precedence with different package bytes')
    }
    oldMarker = preflightDataRoot(paths, candidate, host, false)
    if (!oldMarker || oldMarker.dataRootId !== oldManifest.dataRootId || oldMarker.activeInstallId !== oldManifest.installId) {
      throw new Error('data-root marker does not match the installation')
    }
    assertMarkerBindsPackage(oldMarker, oldManifest.packageRoot, 'installed')
    if (candidate.sha256 === oldManifest.packageSha256
      && samePath(candidate.packageRoot, oldManifest.packageRoot, host.platform)) {
      status = 'already-current'
      if (!flags.dryRun) {
        const authoritySnapshot = captureInstalledLifecycleAuthoritySnapshot(
          paths,
          candidate,
          oldManifest,
          oldMarker,
          host,
          'already-current upgrade'
        )
        await withLifecycleReadMutex(paths, host, () => {
          assertInstalledLifecycleAuthoritySnapshot(
            paths,
            candidate!,
            oldManifest!,
            oldMarker!,
            authoritySnapshot,
            host,
            'already-current upgrade'
          )
          ensureLifecycleRootReceipt(host, oldRootReceipt!, [receiptBefore, oldRootReceipt])
          assertLifecycleRootReceiptCurrentExact(host, oldRootReceipt!)
          retireStaleLifecycleOwnerWithoutWal(paths, host)
          assertInstalledLifecycleAuthoritySnapshot(
            paths,
            candidate!,
            oldManifest!,
            oldMarker!,
            authoritySnapshot,
            host,
            'already-current upgrade terminal seal'
          )
          assertLifecycleRootReceiptCurrentExact(host, oldRootReceipt!)
        }, () => assertInstalledLifecycleAuthoritySnapshot(
          paths,
          candidate!,
          oldManifest!,
          oldMarker!,
          authoritySnapshot,
          host,
          'already-current upgrade post-mutex preflight'
        ))
      }
    } else {
      status = flags.dryRun ? 'planned' : 'failed'
    }
  } catch (error) {
    issues.push({ level: 'error', message: error instanceof Error ? error.message : String(error) })
  }

  if (issues.length === 0 && candidate && oldManifest && oldMarker
    && !flags.dryRun && status !== 'already-current') {
    const tracePreflight = preflightDaemonTraceEnvironment(lifecycleEnvironment, host.platform, paths.dataRoot)
    const daemonEnabled = oldManifest.features.daemon && !flags.noDaemon
    const upgradePaths = resolveInstallPaths(pathApi, {
      hubRoot: candidate.packageRoot,
      packageRoot: candidate.packageRoot,
      dataRoot: oldManifest.dataRoot,
      nodePath: oldManifest.nodePath,
      installDir: oldManifest.installDir,
      extraShimDir: oldManifest.extraShimDir,
      taskName: oldManifest.taskName,
      port: oldManifest.port
    })
    const artifacts = renderedArtifacts(upgradePaths, tracePreflight, oldManifest.features.path, host)
    const plannedMarker: DataRootMarkerV1 = {
      schemaVersion: DATA_ROOT_MARKER_VERSION,
      dataRootId: oldMarker.dataRootId,
      activeInstallId: oldManifest.installId,
      canonicalRoot: paths.dataRoot,
      createdAt: oldMarker.createdAt,
      runtime: { schemaVersion: PUBLIC_RUNTIME_CORPUS_VERSION, files: [...candidate.publicRuntimeFacts] }
    }
    const nextManifest = createInstallManifest({
      paths: upgradePaths,
      candidate,
      marker: plannedMarker,
      artifacts,
      pathEnabled: oldManifest.features.path,
      taskEnabled: oldManifest.features.task,
      daemonEnabled,
      pathAdded: oldManifest.owned.pathEntry.added,
      pathPrior: oldManifest.owned.pathEntry.prior,
      environment: oldManifest.owned.environment,
      task: oldManifest.owned.task,
      previous: oldManifest
    })
    const nextRootReceipt = lifecycleRootReceiptForManifest(
      nextManifest,
      'active',
      oldRootReceipt,
      nextManifest.updatedAt
    )
    const snapshot = snapshotIntegration(
      paths,
      host,
      [
        paths.manifestPath,
        paths.dataMarkerPath,
        ...oldManifest.owned.files.map((entry) => entry.path),
        ...artifacts.keys(),
        ...requiredDataAssets(paths.dataRoot)
      ],
      [],
      { path: oldManifest.features.path, task: oldManifest.features.task }
    )
    const upgradeExpected = expectedIntegration(snapshot, {
      files: new Map<string, string | Buffer | null>([
        ...[...artifacts].map(([file, content]) => [file, content] as const),
        [paths.manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`],
        [paths.dataMarkerPath, `${JSON.stringify(plannedMarker, null, 2)}\n`],
        ...PUBLIC_RUNTIME_FILES.map((relativePath) => [
          join(paths.dataRoot, ...relativePath.split('/')),
          Buffer.from(candidate!.publicRuntime.get(relativePath) as Buffer)
        ] as const)
      ]),
      pathManaged: oldManifest.features.path,
      taskManaged: oldManifest.features.task
    })
    let wasDaemonRunning = false
    const installedReceiptAuthority = captureInstalledLifecycleAuthoritySnapshot(
      paths,
      oldPackage!,
      oldManifest,
      oldMarker,
      host,
      'upgrade prior receipt'
    )
    const candidateReceiptAuthority = capturePackageAuthoritySnapshot(candidate, 'upgrade candidate receipt package')
    const sealUpgradeReceiptAuthority = () => {
      assertInstalledLifecycleAuthoritySnapshot(
        paths,
        oldPackage!,
        oldManifest!,
        oldMarker!,
        installedReceiptAuthority,
        host,
        'upgrade prior receipt'
      )
      assertPackageAuthoritySnapshot(candidate!, candidateReceiptAuthority, 'upgrade candidate receipt package')
      assertIntegrationSnapshotCurrent(paths, host, snapshot)
    }
    let lifecycleLease: LifecycleLease | null = null
    let lifecycleWal: LifecycleWalV1 | null = null
    let lifecycleCommitted = false
    try {
      lifecycleLease = await acquireLifecycleLock(paths, host, 'upgrade', true, {
        target: oldRootReceipt!,
        allowedCurrent: [receiptBefore, oldRootReceipt],
        sealBeforePublication: sealUpgradeReceiptAuthority,
        sealAfterPublication: sealUpgradeReceiptAuthority
      })
      assertApplicationQuiescent(paths.dataRoot, host, lifecycleLease.applicationOwner || undefined)
      const lockedCandidate = packageIdentity(packageRoot)
      const lockedOldPackage = packageIdentity(oldManifest.packageRoot)
      await lifecycleLease.revalidateApplicationGate()
      const lockedExistingPaths = existingManifestPathsForUpgrade(paths, host, environment)
      const lockedManifest = preflightExistingOwnership(lockedExistingPaths, host)
      if (lockedCandidate.sha256 !== candidate.sha256
        || lockedCandidate.version !== candidate.version
        || lockedOldPackage.sha256 !== oldManifest.packageSha256
        || lockedOldPackage.version !== oldManifest.packageVersion
        || !existingPaths
        || !samePath(lockedExistingPaths.packageRoot, existingPaths.packageRoot, host.platform)
        || !lockedManifest || canonicalJson(lockedManifest) !== canonicalJson(oldManifest)) {
        throw new Error('upgrade inputs changed after preflight')
      }
      const lockedMarker = preflightDataRoot(paths, candidate, host, false)
      if (canonicalJson(lockedMarker) !== canonicalJson(oldMarker)) throw new Error('data-root marker changed after upgrade preflight')
      assertMarkerBindsPackage(oldMarker, oldManifest.packageRoot, 'installed')
      assertIntegrationSnapshotCurrent(paths, host, snapshot)
      assertNoForeignLiveLifecycleProcess(paths, host, oldManifest.features.daemon ? [oldManifest.packageRoot] : [])
      if (oldManifest.features.daemon) {
        wasDaemonRunning = await sealDaemonLifecycleStateBeforeMutation(
          paths,
          host,
          oldManifest.packageRoot,
          oldManifest.port,
          lifecycleLease.revalidateApplicationGate
        )
      }
      lifecycleWal = {
        schemaVersion: 1,
        walId: randomUUID(),
        lockToken: lifecycleLease.token,
        operation: 'upgrade',
        phase: 'prepared',
        installDir: paths.installDir,
        oldManifest,
        newManifest: nextManifest,
        oldReceipt: oldRootReceipt!,
        newReceipt: nextRootReceipt,
        oldMarker,
        newMarker: plannedMarker,
        oldIntegration: lifecycleIntegrationState(snapshot),
        newIntegration: lifecycleIntegrationState(upgradeExpected),
        externalArtifacts: [],
        tombstone: null,
        oldDaemonRunning: wasDaemonRunning,
        createdAt: new Date().toISOString()
      }
      registerLifecycleMutationFence(paths, lifecycleWal)
      await lifecycleLease.revalidateApplicationGate()
      writeLifecycleWal(paths, lifecycleWal, null, host)
      await lifecycleLease.revalidateApplicationGate()
      await closeWalBoundTaskRestartSource(paths, lifecycleWal, host, lifecycleLease.revalidateApplicationGate)
      await lifecycleLease.revalidateApplicationGate()
      if (oldManifest.features.daemon) {
        const lifecycleAuthority = daemonLifecycleControlAuthority(
          paths,
          host,
          lifecycleLease.token
        )
        if (!await stopInstalledDaemonRuntime(paths, host, lifecycleAuthority)) {
          throw new Error('failed to stop the owned prior daemon for upgrade')
        }
      }
      await lifecycleLease.revalidateApplicationGate()
      assertLegacyApplicationLeaseNamespaceClear(paths.dataRoot)
      assertApplicationQuiescent(paths.dataRoot, host, lifecycleLease.applicationOwner || undefined)
      assertNoForeignLiveLifecycleProcess(paths, host, [])
      const marker = bootstrapDataRoot(
        paths,
        candidate,
        oldMarker,
        true,
        oldManifest.installId,
        plannedMarker,
        snapshot.files,
        lifecycleWal
      )
      if (canonicalJson(marker) !== canonicalJson(plannedMarker)) throw new Error('upgraded data marker differs from the frozen plan')
      await lifecycleLease.revalidateApplicationGate()
      writeArtifacts(artifacts, snapshot.files, lifecycleWal)
      await lifecycleLease.revalidateApplicationGate()
      writeManifest(paths, nextManifest, [snapshot.files.get(resolve(paths.manifestPath)) ?? null], lifecycleWal)
      await lifecycleLease.revalidateApplicationGate()
      const switchedWal: LifecycleWalV1 = { ...lifecycleWal, phase: 'switched' }
      writeLifecycleWal(paths, switchedWal, lifecycleWal, host)
      lifecycleWal = switchedWal
      await applyLifecycleIntegrationTarget(
        paths,
        lifecycleWal,
        nextManifest,
        lifecycleWal.newIntegration,
        host,
        lifecycleLease.revalidateApplicationGate
      )
      const terminalRelease: RecoverableRelease = {
        manifest: nextManifest,
        paths: upgradePaths,
        identity: candidate,
        artifacts
      }
      await assertInstalledWalTerminalSeal(terminalRelease, plannedMarker, lifecycleWal, host, lifecycleLease, false)
      await lifecycleLease.revalidateApplicationGate()
      assertOwnedLifecycleProof(paths, host, ownedLifecycleProof(lifecycleLease, lifecycleWal))
      const committedWal: LifecycleWalV1 = { ...lifecycleWal, phase: 'committed' }
      writeLifecycleWal(paths, committedWal, lifecycleWal, host)
      lifecycleWal = committedWal
      lifecycleCommitted = true
      await assertInstalledWalTerminalSeal(terminalRelease, plannedMarker, lifecycleWal, host, lifecycleLease, false)
      await lifecycleLease.revalidateApplicationGate()
      assertOwnedLifecycleProof(paths, host, ownedLifecycleProof(lifecycleLease, lifecycleWal))
      ensureLifecycleRootReceipt(host, nextRootReceipt, [oldRootReceipt, nextRootReceipt])
      await lifecycleLease.revalidateApplicationGate()
      if (!sameLifecycleRootReceipt(readLifecycleRootReceipt(host), nextRootReceipt)) {
        throw new Error('upgrade lifecycle root receipt did not reach the target release before WAL cleanup')
      }
      assertOwnedLifecycleProof(paths, host, ownedLifecycleProof(lifecycleLease, lifecycleWal))
      removeLifecycleWal(paths, lifecycleWal)
      status = 'upgraded'
      postCommitDaemon = daemonEnabled
    } catch (error) {
      if (error instanceof LifecycleWalPublicationError) lifecycleLease?.preserveOwnerRecord()
      issues.push({ level: 'error', message: error instanceof Error ? error.message : String(error) })
      if (!lifecycleCommitted) {
        try {
          if (lifecycleWal) {
            if (!lifecycleLease) throw new Error('upgrade rollback lost its lifecycle lock')
            assertOwnedLifecycleProof(paths, host, ownedLifecycleProof(lifecycleLease, lifecycleWal))
            const recovered = await recoverLifecycleWalIfNeeded(
              paths,
              host,
              lifecycleEnvironment,
              lifecycleLease.applicationOwner || undefined,
              lifecycleLease.revalidateApplicationGate
            )
            if (!recovered) throw new Error('lifecycle WAL vanished before upgrade rollback')
            if (lifecycleWal.oldDaemonRunning) rollbackDaemonManifest = oldManifest
          }
        } catch (rollbackError) {
          issues.push({ level: 'error', message: `upgrade rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}` })
        }
      }
      status = 'failed'
    } finally {
      if (lifecycleLease) await lifecycleLease.release()
    }
  }

  if (status === 'failed' && rollbackDaemonManifest) {
    const started = await startDaemonDetached(rollbackDaemonManifest.packageRoot, host, rollbackDaemonManifest.dataRoot)
    if (!started.ok) issues.push({ level: 'error', message: `post-rollback daemon start failed: ${started.detail}` })
  }

  if (status === 'upgraded' && postCommitDaemon
    || status === 'already-current' && Boolean(oldManifest?.features.daemon)) {
    const activePackage = status === 'already-current' ? oldManifest!.packageRoot : packageRoot
    const started = await startDaemonDetached(activePackage, host, paths.dataRoot)
    if (!started.ok) issues.push({ level: 'error', message: `post-commit daemon start failed: ${started.detail}` })
  }

  const activeDoctorRoot = status === 'upgraded' || status === 'already-current'
    ? packageRoot
    : oldManifest?.packageRoot || packageRoot
  const doctor = await doctorHub(activeDoctorRoot, host, paths.dataRoot, lifecycleEnvironment)
  const successfulStatus = status === 'planned' || status === 'upgraded' || status === 'already-current'
  return {
    ok: issues.length === 0 && successfulStatus && doctor.ok,
    action: 'upgrade',
    dryRun: flags.dryRun,
    status,
    fromVersion: oldManifest?.packageVersion || '',
    toVersion: candidate?.version || '',
    packageRoot: candidate?.packageRoot || resolve(packageRoot),
    installDir: paths.installDir,
    doctor,
    issues
  }
}

function purgeTreeFactsFromEntries(entries: readonly PlainTreeEntry[]): Pick<PurgePlanV1, 'treeSha256' | 'entries' | 'bytes'> {
  const bytes = entries.reduce((total, entry) => total + entry.size, 0)
  const treeSha256 = sha256Bytes(canonicalJson(entries.map((entry) => ({
    path: entry.path,
    kind: entry.kind,
    size: entry.size,
    sha256: entry.sha256 || null
  }))))
  return { treeSha256, entries: entries.length, bytes }
}

function purgeTreeFacts(root: string): Pick<PurgePlanV1, 'treeSha256' | 'entries' | 'bytes'> {
  return purgeTreeFactsFromEntries(walkPlainTree(root, {
    maxEntries: 100_000,
    maxBytes: 10 * 1024 * 1024 * 1024,
    label: 'purge data root'
  }))
}

function createPurgePlan(paths: InstallPaths, host: InstallHost, expectedDataRootId: string): PurgePlanV1 {
  const marker = readDataRootMarker(paths, host.platform)
  if (!marker) throw new Error('purge requires a valid data-root ownership marker')
  if (marker.activeInstallId !== null) throw new Error('purge requires an uninstalled data-root marker')
  if (marker.dataRootId !== expectedDataRootId) {
    throw new Error('purge data-root marker differs from the preserved root receipt')
  }
  const tree = purgeTreeFacts(paths.dataRoot)
  const core = {
    schemaVersion: 1 as const,
    action: 'purge' as const,
    dataRootId: marker.dataRootId,
    ...tree
  }
  return { ...core, planHash: sha256Bytes(canonicalJson(core)) }
}

async function createPurgePlanWithRevalidation(
  paths: InstallPaths,
  host: InstallHost,
  expectedDataRootId: string,
  revalidate: () => Promise<void>,
  expectedMetadata?: PlainTreeMetadataSnapshot
): Promise<{ plan: PurgePlanV1; entries: PlainTreeEntry[]; metadata: PlainTreeMetadataSnapshot }> {
  const marker = readDataRootMarker(paths, host.platform)
  if (!marker) throw new Error('purge requires a valid data-root ownership marker')
  if (marker.activeInstallId !== null) throw new Error('purge requires an uninstalled data-root marker')
  if (marker.dataRootId !== expectedDataRootId) {
    throw new Error('purge data-root marker differs from the preserved root receipt')
  }
  const limits = {
    maxEntries: 100_000,
    maxBytes: 10 * 1024 * 1024 * 1024,
    label: 'purge data root'
  }
  const initialMetadata = expectedMetadata || capturePlainTreeMetadata(paths.dataRoot, limits)
  const entries = await walkPlainTreeWithRevalidation(paths.dataRoot, limits, revalidate, initialMetadata)
  await revalidate()
  assertPlainTreeMetadataCurrent(paths.dataRoot, initialMetadata, entries, 'purge data root')
  const currentMarker = readDataRootMarker(paths, host.platform)
  if (canonicalJson(currentMarker) !== canonicalJson(marker)) throw new Error('purge data-root marker changed during the locked scan')
  const core = {
    schemaVersion: 1 as const,
    action: 'purge' as const,
    dataRootId: marker.dataRootId,
    ...purgeTreeFactsFromEntries(entries)
  }
  return { plan: { ...core, planHash: sha256Bytes(canonicalJson(core)) }, entries, metadata: initialMetadata }
}

function assertPurgeWalRootIdentity(root: string, wal: PurgeWalV1, label: string): fs.Stats {
  const stat = fs.lstatSync(root)
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || String(stat.dev) !== wal.rootDev || String(stat.ino) !== wal.rootIno) {
    throw new Error(`${label} is not the data-root inode frozen by the purge WAL`)
  }
  return stat
}

async function assertFullPurgeWalTree(
  root: string,
  wal: PurgeWalV1,
  revalidate: () => Promise<void>,
  label: string,
  expectedMetadata?: PlainTreeMetadataSnapshot
): Promise<PlainTreeEntry[]> {
  assertPurgeWalRootIdentity(root, wal, label)
  const limits = {
    maxEntries: wal.entries.length,
    maxBytes: wal.plan.bytes,
    label
  }
  const initialMetadata = expectedMetadata || capturePlainTreeMetadata(root, limits)
  assertPlainTreeMetadataManifest(initialMetadata, wal.entries, label)
  const entries = await walkPlainTreeWithRevalidation(root, limits, revalidate, initialMetadata)
  await revalidate()
  assertPurgeWalRootIdentity(root, wal, label)
  assertPlainTreeMetadataCurrent(root, initialMetadata, entries, label)
  if (canonicalPlainTree(entries) !== canonicalJson(wal.entries)) {
    throw new Error(`${label} differs from the full purge WAL manifest`)
  }
  return entries
}

function assertPurgeWalTerminalAbsence(paths: InstallPaths, wal: PurgeWalV1): void {
  for (const [target, label] of [
    [paths.dataRoot, 'purge canonical data root'],
    [wal.tombstone, 'purge tombstone'],
    [wal.quarantine, 'purge delete quarantine']
  ] as const) {
    if (lstatOptional(target)) throw new Error(`${label} must be absent at the deleted phase`)
  }
  flushDirectory(dirname(paths.dataRoot))
  for (const target of [paths.dataRoot, wal.tombstone, wal.quarantine]) {
    if (lstatOptional(target)) throw new Error('purge terminal absence changed during parent durability proof')
  }
}

function assertNoLifecycleWalHiddenStageResidue(paths: InstallPaths, host: InstallHost): void {
  const parent = dirname(paths.lifecycleWalPath)
  if (!lstatOptional(parent)) return
  assertPlainDirectory(parent, 'lifecycle WAL stage parent')
  const fold = (value: string) => host.platform === 'win32' ? value.toLowerCase() : value
  const prefix = `.${fold(basename(paths.lifecycleWalPath))}.`
  const stages = boundedMatchingDirectoryEntries(
    parent,
    (entry) => fold(entry.name).startsWith(prefix),
    2,
    'lifecycle WAL hidden-stage residue inventory'
  )
  if (stages.length > 0) {
    throw new Error('purge found a hidden lifecycle WAL stage that requires ordinary lifecycle recovery')
  }
}

function assertPurgeReservedSiblingInventory(
  paths: InstallPaths,
  host: InstallHost,
  wal: PurgeWalV1 | null,
  ownerPublication = readLifecycleOwnerPublicationHint(paths, host)
): void {
  const parent = dirname(paths.dataRoot)
  const parentStat = lstatOptional(parent)
  if (!parentStat) return
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error('purge reserved sibling parent is not a plain directory')
  }
  const fold = (value: string) => host.platform === 'win32' ? value.toLowerCase() : value
  const base = fold(basename(paths.dataRoot))
  const tombstonePrefix = `${base}.purging-`
  const directQuarantine = `${base}.deleting`
  const walBase = fold(basename(paths.lifecycleWalPath))
  const walPrefix = `${walBase}.`
  const hiddenWalPrefix = `.${walBase}.`
  const ownerPrefix = `${fold(basename(paths.lifecycleLockPath))}.`
  const ownerStageName = fold(basename(lifecycleOwnerStageNamespacePath(paths)))
  const daemonStageName = `${base}.daemon-instance-stages`
  const allowed = new Set<string>()
  if (wal && wal.phase !== 'deleted') {
    allowed.add(fold(basename(wal.tombstone)))
    if (wal.phase === 'deleting') allowed.add(fold(basename(wal.quarantine)))
  }
  for (const artifact of ownerPublication.artifacts) allowed.add(fold(basename(artifact.file)))
  if (ownerPublication.stageNamespace.directoryState) allowed.add(ownerStageName)
  const reserved = boundedMatchingDirectoryEntries(
    parent,
    (entry) => {
      const name = fold(entry.name)
      return name.startsWith(tombstonePrefix)
        || name === directQuarantine
        || name.startsWith(walPrefix)
        || name.startsWith(hiddenWalPrefix)
        || name.startsWith(ownerPrefix)
        || name === ownerStageName
        || name === daemonStageName
    },
    16,
    'purge reserved sibling protocol inventory'
  )
  for (const entry of reserved) {
    if (!allowed.has(fold(entry.name))) {
      throw new Error(`purge found an unauthorized reserved sibling: ${entry.name}`)
    }
  }
}

function assertPurgeOwnerPublicationBinding(
  paths: InstallPaths,
  host: InstallHost,
  receipt: LifecycleRootReceiptV1,
  expectedToken: string | null,
  publication: LifecycleOwnerPublicationHint
): void {
  const reservations = publication.stageNamespace.reservations
  const pendingRecords = publication.artifacts.map((artifact) => {
    const linked = artifact.state.stat?.nlink === 2
    return readLifecycleLockFile(artifact.file, paths, host.platform, linked)
  })
  if (pendingRecords.some((owner) => !owner)) {
    throw new Error('purge lifecycle owner pending publication is malformed')
  }
  for (const [index, pending] of pendingRecords.entries()) {
    if (!pending || !samePath(
      publication.artifacts[index].file,
      lifecycleOwnerPendingPath(paths, pending.token),
      host.platform
    )) {
      throw new Error('purge lifecycle owner pending name does not bind its record token')
    }
  }
  const records = [publication.record, ...pendingRecords, ...reservations.map((item) => item.record)]
    .filter(Boolean) as LifecycleLockRecord[]
  if (records.length > 0 && !expectedToken) {
    throw new Error('purge found lifecycle owner publication without purge recovery authority')
  }
  for (const owner of records) {
    if (owner.token !== expectedToken || owner.operation !== 'purge'
      || !samePath(owner.installDir, receipt.installDir, host.platform)) {
      throw new Error('purge lifecycle owner publication is not bound to the purge receipt/WAL')
    }
  }
  if (publication.record && reservations.length > 0) {
    throw new Error('purge lifecycle owner final conflicts with a staged reservation')
  }
  if (!publication.record && reservations.length > 1) {
    throw new Error('purge lifecycle owner publication has multiple staged reservations')
  }
  const finalStat = publication.finalState.stat
  const pendingStat = publication.artifacts[0]?.state.stat || null
  if (publication.record) {
    if (!finalStat) throw new Error('purge lifecycle owner final lost its exact file state')
    if (publication.artifacts.length === 0) {
      if (finalStat.nlink !== 1) throw new Error('purge lifecycle owner final has an unsafe link count')
    } else if (publication.artifacts.length === 1) {
      if (!pendingStat || finalStat.nlink !== 2 || pendingStat.nlink !== 2
        || finalStat.dev !== pendingStat.dev || finalStat.ino !== pendingStat.ino
        || canonicalJson(publication.record) !== canonicalJson(pendingRecords[0])) {
        throw new Error('purge lifecycle owner final/pending publication is not an exact link pair')
      }
    } else {
      throw new Error('purge lifecycle owner final has multiple pending artifacts')
    }
  } else if (reservations.length === 0 && publication.artifacts.length === 1) {
    if (!pendingStat || pendingStat.nlink !== 1) {
      throw new Error('purge lifecycle owner pending-only publication has an unsafe link count')
    }
  }
  if (!publication.record && reservations.length === 1 && publication.artifacts.length === 1) {
    const reservation = reservations[0]
    const pending = publication.artifacts[0]
    const recordStat = reservation.recordState?.stat
    const linkedPendingStat = pending.state.stat
    if (!recordStat || !linkedPendingStat || recordStat.nlink !== 2 || linkedPendingStat.nlink !== 2
      || recordStat.dev !== linkedPendingStat.dev || recordStat.ino !== linkedPendingStat.ino
      || canonicalJson(reservation.record) !== canonicalJson(pendingRecords[0])) {
      throw new Error('purge lifecycle owner staged reservation is not an exact pending link pair')
    }
  } else if (!publication.record && reservations.length === 1) {
    const recordStat = reservations[0].recordState?.stat
    if (recordStat && recordStat.nlink !== 1) {
      throw new Error('purge lifecycle owner staged reservation has an unsafe record link count')
    }
  }
  if (reservations.length === 1 && host.pidAlive(reservations[0].record.pid)) {
    throw new Error('purge lifecycle owner staged publisher is still live')
  }
}

type PurgeRootShapeProof = {
  canonical: CapturedOptionalPlainDirectoryIdentity
  tombstone: CapturedOptionalPlainDirectoryIdentity
  quarantine: CapturedOptionalPlainDirectoryIdentity
}

type PurgeProtocolEpoch = (() => Promise<void>) & {
  /** Synchronous lease + exact protocol seal used immediately before every mutation. */
  seal: () => void
  /** Advance only the canonical-root -> tombstone rename performed by this operation. */
  advanceCanonicalIsolation: (wal: PurgeWalV1) => void
  /** Advance only a WAL publication/phase transition that just completed exact readback. */
  advanceWal: (wal: PurgeWalV1) => void
  /** Advance only cleanup of the exact partial WAL stage frozen by this epoch. */
  advancePartialWalStageRemoval: () => void
  /** Advance only the final removal of the deleting tombstone inode. */
  advanceDeletingRootRemoval: (wal: PurgeWalV1) => void
  /** Advance only the inactive -> purging receipt handoff. */
  advanceReceiptHandoff: (receipt: LifecycleRootReceiptV1, wal: PurgeWalV1) => void
  /** Advance only exact removal of the terminal deleted WAL. */
  advanceWalRemoval: (wal: PurgeWalV1) => void
  /** Advance only exact removal of the owner-stage namespace + HOME authority. */
  advanceOwnerStageRemoval: () => void
  /** Advance only exact retirement of the lifecycle owner final. */
  advanceOwnerRemoval: () => void
}

type PurgeMutationRevalidator = PurgeProtocolEpoch

type PurgeDataMarkerAuthority = { file: string; state: CapturedFileState } | null

function capturePurgeDataMarkerAuthority(
  paths: InstallPaths,
  receipt: LifecycleRootReceiptV1,
  wal: PurgeWalV1 | null,
  host: InstallHost
): PurgeDataMarkerAuthority {
  if (wal?.phase === 'deleting' || wal?.phase === 'deleted') return null
  const relativeMarker = relative(paths.dataRoot, paths.dataMarkerPath)
  const candidates = !wal
    ? [paths.dataMarkerPath]
    : wal.phase === 'prepared'
      ? [paths.dataMarkerPath, join(wal.tombstone, relativeMarker)]
      : [join(wal.tombstone, relativeMarker)]
  const existing = candidates.filter((file) => Boolean(lstatOptional(file)))
  if (existing.length !== 1) throw new Error('purge data marker has no unique phase-bound location')
  const markerValue = readJsonRecord(existing[0], MARKER_MAX_BYTES)
  const marker = markerValue ? validateDataRootMarker(markerValue, paths, host.platform) : null
  const markerState = captureFileState(existing[0], MARKER_MAX_BYTES)
  if (!marker || marker.activeInstallId !== null || marker.dataRootId !== receipt.dataRootId
    || !markerState.stat || markerState.stat.nlink !== 1) {
    throw new Error('purge data marker is not bound to the preserved root receipt')
  }
  return { file: existing[0], state: markerState }
}

function assertPurgeDataMarkerAuthority(
  authority: PurgeDataMarkerAuthority
): void {
  if (!authority) return
  assertCapturedFileState(
    authority.file,
    authority.state,
    'purge data marker mutation authority',
    MARKER_MAX_BYTES
  )
}

function capturePurgeRootShape(
  paths: InstallPaths,
  wal: PurgeWalV1 | null
): PurgeRootShapeProof {
  const canonical = captureOptionalPlainDirectoryIdentity(paths.dataRoot, 'purge canonical root')
  if (!wal) {
    if (!canonical) throw new Error('purge planning requires the canonical data-root inode')
    return { canonical, tombstone: null, quarantine: null }
  }
  const tombstone = captureOptionalPlainDirectoryIdentity(wal.tombstone, 'purge tombstone')
  const quarantine = captureOptionalPlainDirectoryIdentity(wal.quarantine, 'purge delete quarantine')
  const matchesWalRoot = (identity: CapturedOptionalPlainDirectoryIdentity) => Boolean(identity
    && String(identity.dev) === wal.rootDev && String(identity.ino) === wal.rootIno)
  if (wal.phase === 'prepared') {
    if (Boolean(canonical) === Boolean(tombstone) || quarantine
      || !matchesWalRoot(canonical || tombstone)) {
      throw new Error('prepared purge WAL has an invalid canonical/tombstone/quarantine shape')
    }
  } else if (wal.phase === 'renamed') {
    if (canonical || quarantine || !matchesWalRoot(tombstone)) {
      throw new Error('renamed purge WAL has an invalid root/quarantine shape')
    }
  } else if (wal.phase === 'deleting') {
    if (canonical || tombstone && !matchesWalRoot(tombstone) || !tombstone && quarantine) {
      throw new Error('deleting purge WAL has an invalid root/quarantine shape')
    }
  } else if (canonical || tombstone || quarantine) {
    throw new Error('deleted purge WAL retained a canonical/tombstone/quarantine inode')
  }
  return { canonical, tombstone, quarantine }
}

function assertPurgeRootShape(
  paths: InstallPaths,
  wal: PurgeWalV1 | null,
  expected: PurgeRootShapeProof
): void {
  const current = capturePurgeRootShape(paths, wal)
  const comparableCurrent = wal?.phase === 'deleting'
    ? { canonical: current.canonical, tombstone: current.tombstone }
    : current
  const comparableExpected = wal?.phase === 'deleting'
    ? { canonical: expected.canonical, tombstone: expected.tombstone }
    : expected
  if (canonicalJson(comparableCurrent) !== canonicalJson(comparableExpected)) {
    throw new Error('purge canonical/tombstone/quarantine identity changed across an authority boundary')
  }
}

function assertPurgeQuiescent(
  paths: InstallPaths,
  host: InstallHost,
  ownedLockToken?: string,
  allowedHubOwner?: ApplicationOwnerBinding,
  expectedPurgeWal: PurgeWalV1 | null = null
): void {
  assertNoLifecycleWalHiddenStageResidue(paths, host)
  assertPurgeReservedSiblingInventory(paths, host, expectedPurgeWal)
  if (fs.existsSync(paths.lifecycleWalPath)) throw new Error('lifecycle WAL must be recovered before purge')
  if (ownedLockToken) {
    const lock = readLifecycleLock(paths, host)
    if (lock?.token !== ownedLockToken) {
      throw new Error('purge lifecycle lock changed during the operation')
    }
  } else if (lifecycleLockState(paths, host) !== 'clear') {
    throw new Error('lifecycle lock state must be clear before purge')
  }
  assertApplicationQuiescent(paths.dataRoot, host, allowedHubOwner)
  assertNoForeignLiveLifecycleProcess(paths, host, [])
}

function assertPurgeNotInstalled(paths: InstallPaths, host: InstallHost): void {
  if (!fs.existsSync(paths.manifestPath)) return
  const raw = readJsonRecord(paths.manifestPath)
  if (!raw) return
  if (typeof raw.dataRoot !== 'string') throw new Error('cannot purge while an unreadable install manifest exists')
  if (samePath(raw.dataRoot, paths.dataRoot, host.platform)) {
    throw new Error('uninstall the active installation before purging its data root')
  }
}

function assertPurgeReceiptCleanupOnlySafe(receipt: LifecycleRootReceiptV1, paths: InstallPaths): void {
  if (receipt.state !== 'purging') throw new Error('purge receipt cleanup requires a durable purging handoff')
  if (lstatOptional(receipt.dataRoot) || lstatOptional(paths.lifecycleWalPath)
    || lstatOptional(purgeWalPath(receipt.dataRoot))
    || lstatOptional(receipt.tombstone) || lstatOptional(receipt.quarantine)) {
    throw new Error('purge receipt cleanup requires absent data, purge, and lifecycle WAL authorities')
  }
}

function assertPurgeTerminalReceiptRemovalSafe(
  receipt: LifecycleRootReceiptV1,
  paths: InstallPaths,
  host: InstallHost
): void {
  assertPurgeReceiptCleanupOnlySafe(receipt, paths)
  // This helper deliberately ignores the still-published terminal receipt but
  // proves every data-root sibling protocol/deletion namespace is absent.
  // Receipt removal is the final locator mutation, so no lifecycle owner,
  // pending publication, hidden WAL stage, or tombstone may survive it.
  assertPurgeAlreadyAbsentWithoutReceipt(paths.dataRoot, host)
  const namespace = readLifecycleRootReceiptNamespace(host)
  if (!sameLifecycleRootReceipt(namespace.receipt, receipt)
    || !namespace.receiptState?.stat || namespace.receiptState.stat.nlink !== 1
    || namespace.pendingState || namespace.writingState
    || namespace.ownerStageAuthorityMarker || namespace.ownerStageNamespaceId
    || namespace.daemonStageAuthorityMarker || namespace.daemonStageNamespaceId) {
    throw new Error('purge terminal receipt namespace is not uniquely sealed for removal')
  }
}

function assertPurgeAlreadyAbsentWithoutReceipt(dataRoot: string, host: InstallHost): void {
  const absoluteRoot = resolve(dataRoot)
  assertLocalLifecycleRoot(absoluteRoot, 'purge data root', host.platform)
  assertOutsideProtectedRoots(absoluteRoot, 'purge data root', host)
  if (host.localVolumeKind(absoluteRoot) !== 'local') {
    throw new Error('purge data root must be on a proven local fixed volume')
  }
  assertSafeRecursiveRoot(absoluteRoot, 'purge data root', [], host.platform)
  physicalLifecyclePath(absoluteRoot, 'purge data root', host.platform, false)
  if (lstatOptional(absoluteRoot)) {
    throw new Error('purge found a data-root inode without a preserved root receipt')
  }
  for (const [file, label] of [
    [`${absoluteRoot}.lifecycle-wal.json`, 'lifecycle WAL'],
    [`${absoluteRoot}.lifecycle.lock`, 'lifecycle owner'],
    [purgeWalPath(absoluteRoot), 'purge WAL']
  ] as const) {
    if (lstatOptional(file)) throw new Error(`purge found ${label} evidence without a preserved root receipt`)
  }
  const parent = dirname(absoluteRoot)
  const parentStat = lstatOptional(parent)
  if (!parentStat) return
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error('purge data-root parent is not a plain directory')
  }
  assertSafeRecursiveRoot(parent, 'purge data-root parent', [], host.platform)
  physicalLifecyclePath(parent, 'purge data-root parent', host.platform, true)
  const fold = (value: string) => host.platform === 'win32' ? value.toLowerCase() : value
  const base = fold(basename(absoluteRoot))
  const tombstonePrefix = `${base}.purging-`
  const directQuarantine = `${base}.deleting`
  const ownerStageNamespace = `${base}.lifecycle-owner-stages`
  const daemonStageNamespace = `${base}.daemon-instance-stages`
  const lifecycleWalSiblingPrefix = `${fold(basename(`${absoluteRoot}.lifecycle-wal.json`))}.`
  const lifecycleWalHiddenStagePrefix = `.${fold(basename(`${absoluteRoot}.lifecycle-wal.json`))}.`
  const lifecycleOwnerSiblingPrefix = `${fold(basename(`${absoluteRoot}.lifecycle.lock`))}.`
  const residues = boundedMatchingDirectoryEntries(
    parent,
    (entry) => {
      const name = fold(entry.name)
      return name.startsWith(tombstonePrefix)
        || name === directQuarantine
        || name === ownerStageNamespace
        || name === daemonStageNamespace
        // With no receipt there is no authority to normalize even a
        // well-formed owner/WAL publication.  Treat the complete reserved
        // sibling prefixes as evidence so malformed or partially-named
        // pending files are also preserved and reported instead of being
        // hidden behind an `already-absent` result.
        || name.startsWith(lifecycleWalSiblingPrefix)
        || name.startsWith(lifecycleWalHiddenStagePrefix)
        || name.startsWith(lifecycleOwnerSiblingPrefix)
    },
    8,
    'purge receipt-free residue inventory'
  )
  if (residues.length > 0) {
    throw new Error('purge found lifecycle or deletion residue without a preserved root receipt')
  }
}

async function settleReceiptFreeApplicationGate(
  packageRoot: string,
  dataRoot: string,
  host: InstallHost,
  mutate: boolean
): Promise<void> {
  const absoluteRoot = resolve(dataRoot)
  const gatePaths: Pick<InstallPaths, 'dataRoot'> = { dataRoot: absoluteRoot }
  const mutex = createServer((socket) => socket.destroy())
  try {
    await listenLifecycleMutex(mutex, lifecycleMutexName(gatePaths, host))
  } catch (error) {
    await closeLifecycleMutex(mutex)
    throw error
  }
  let gate: ApplicationLifecycleGate | null = null
  const sealReceiptFreeState = () => {
    const namespace = readLifecycleRootReceiptNamespace(host)
    if (classifyPurgeReceiptPublication(namespace, host)) {
      throw new Error('preserved root receipt reappeared during receipt-free purge recovery')
    }
    assertPurgeAlreadyAbsentWithoutReceipt(absoluteRoot, host)
  }
  try {
    sealReceiptFreeState()
    const externalRoot = applicationLeaseRoot(absoluteRoot)
    const externalStat = lstatOptional(externalRoot)
    if (!externalStat) {
      // With no durable product namespace left, an ambient same-root manifest
      // is the only remaining evidence that a locator was lost from an active
      // install. This is the sole receipt-free branch allowed to consult the
      // historical install selection. A published Application namespace below
      // is itself the successful-purge terminal authority and deliberately
      // ignores all later install/package/environment bytes.
      const environment = Object.freeze({
        ...freezeInstallEnvironment(host),
        [PRIMARY_DATA_ROOT_ENV]: absoluteRoot,
        [LEGACY_DATA_ROOT_ENV]: absoluteRoot
      }) as FrozenInstallEnvironment
      const paths = installPathsFor(packageRoot, host, absoluteRoot, environment)
      assertPurgeNotInstalled(paths, host)
      sealReceiptFreeState()
      if (lstatOptional(externalRoot)) {
        throw new Error('receipt-free application lease namespace appeared during absent-terminal classification')
      }
      return
    }
    if (!externalStat.isDirectory() || externalStat.isSymbolicLink()) {
      throw new Error('receipt-free application lease namespace is not a plain directory')
    }
    const publishedProof = capturePublishedApplicationLeaseNamespace(externalRoot)
    const externalFence = captureDirectoryFence(externalRoot)
    const leasesDirectory = join(externalRoot, 'leases')
    const leasesBefore = capturePlainDirectoryState(
      leasesDirectory,
      'receipt-free application lease inventory',
      10_000
    )
    const sealPublishedExternalRoot = () => {
      sealReceiptFreeState()
      assertDirectoryFence(externalRoot, externalFence)
      assertPublishedApplicationLeaseNamespace(externalRoot, publishedProof)
      if (lstatOptional(absoluteRoot)) throw new Error('receipt-free purge data root reappeared during gate recovery')
    }
    const sealInitialLeaseInventory = () => {
      sealPublishedExternalRoot()
      assertPlainDirectoryState(
        leasesDirectory,
        leasesBefore,
        'receipt-free application lease inventory',
        10_000
      )
    }
    if (leasesBefore.entries.length === 0) {
      sealInitialLeaseInventory()
      return
    }
    if (!mutate) {
      sealInitialLeaseInventory()
      throw new Error('receipt-free purge found an application lease namespace that requires terminal cleanup')
    }
    sealInitialLeaseInventory()
    gate = await acquireApplicationLifecycleGate(gatePaths, host, {
      requireExistingRoot: { root: externalRoot, fence: externalFence, seal: sealPublishedExternalRoot }
    })
    await gate.revalidate()
    sealPublishedExternalRoot()
    assertApplicationQuiescent(absoluteRoot, host, gate.owner)
    sealPublishedExternalRoot()
    await gate.release()
    gate = null
  } finally {
    if (gate) {
      try { await gate.release() } catch { /* preserve the primary terminal-recovery failure */ }
    }
    await closeLifecycleMutex(mutex)
  }
}

export async function purgeHub(
  packageRoot: string,
  flags: PurgeFlags,
  host: InstallHost = createInstallHost(),
  privateHooks: {
    checkpoint?: (name: 'after-application-gate-revalidate-before-seal') => void | Promise<void>
  } = {}
): Promise<PurgeResult> {
  const issues: DoctorIssue[] = []
  const mode: PurgeResult['mode'] = flags.dryRun ? 'dryRun' : 'commit'
  let plan: PurgePlanV1 | null = null
  let paths: InstallPaths
  let receipt: LifecycleRootReceiptV1
  let receiptPublication: PurgeReceiptPublicationSelection
  let cleanupOnly = false
  let authorityBefore: PurgeAuthoritySnapshot
  let initialPlanMetadata: PlainTreeMetadataSnapshot | null = null
  let initialPlanEntries: PlainTreeEntry[] | null = null
  try {
    if (flags.dryRun === flags.commit) throw new Error('purge requires exactly one of dry-run or commit')
    if (!isAbsolute(flags.dataRoot)) throw new Error('purge data root must be absolute')
    const receiptNamespace = readLifecycleRootReceiptNamespace(host)
    const classifiedReceipt = classifyPurgeReceiptPublication(receiptNamespace, host)
    if (!classifiedReceipt) {
      assertPurgeAlreadyAbsentWithoutReceipt(flags.dataRoot, host)
      await settleReceiptFreeApplicationGate(packageRoot, flags.dataRoot, host, flags.commit)
      return { ok: true, action: 'purge', mode, status: 'already-absent', plan: null, issues }
    }
    receiptPublication = classifiedReceipt
    const discovered = classifiedReceipt.final
    if (!samePath(flags.dataRoot, discovered.dataRoot, host.platform)) {
      throw new Error('purge data root differs from the preserved root receipt')
    }
    const environment = freezeInstallEnvironment(host)
    receipt = classifiedReceipt.target || discovered
    paths = installPathsForLifecycleRootReceipt(discovered.packageRoot, host, discovered, environment, false)
    // The purge-specific publication classifier above freezes the complete
    // final/pending/writer shape.  A durable handoff may legitimately still
    // have an R1 writer or linked pending state here, so do not route it back
    // through the generic receipt reader (which intentionally rejects every
    // writer).  The locked before/after publication seals below retain the
    // exact namespace authority while this narrow root preflight only proves
    // the receipt-bound paths remain safe.
    preflightTerminalPreservedRootPaths(paths, discovered, host)
    assertNoLifecycleWalHiddenStageResidue(paths, host)
    authorityBefore = readPurgeAuthoritySnapshot(paths, receipt, host)
    const initialPurgeWal = authorityBefore.stage || authorityBefore.final
    if (receipt.state !== 'purging' && initialPurgeWal?.phase !== 'deleted') {
      preflightPreservedRootPaths(paths, discovered, host)
    }
    const initialPurgeToken = authorityBefore.final?.lockToken
      || authorityBefore.stage?.lockToken
      || authorityBefore.stageNamespace.purgeStage?.lockToken
      || (receipt.state === 'purging' ? receipt.lockToken : null)
    assertPurgeOwnerPublicationBinding(
      paths,
      host,
      receipt,
      initialPurgeToken,
      readLifecycleOwnerPublicationHint(paths, host)
    )
    assertPurgeReservedSiblingInventory(
      paths,
      host,
      initialPurgeWal
    )
    if (initialPurgeWal) {
      capturePurgeRootShape(paths, initialPurgeWal)
    }
    if (classifiedReceipt.partialWriter && !classifiedReceipt.target) {
      const deleted = authorityBefore.final
      if (!deleted || deleted.phase !== 'deleted' || authorityBefore.stage || authorityBefore.stagePartial) {
        throw new Error('partial purge receipt writer has no exact deleted purge WAL authority')
      }
      receipt = purgingLifecycleRootReceipt(discovered, deleted, host)
      const partial = classifiedReceipt.namespace.writingState?.bytes
      const expected = recordBytes(receipt)
      if (!partial || partial.length > expected.length || !expected.subarray(0, partial.length).equals(partial)) {
        throw new Error('partial purging receipt writer is not a prefix of the canonical deleted-WAL handoff')
      }
      authorityBefore = readPurgeAuthoritySnapshot(paths, receipt, host)
    }
    if (!sameLifecycleRootReceipt(receipt, discovered) || classifiedReceipt.hasTransitionArtifacts) {
      if (receipt.state !== 'purging'
        || !authorityBefore.final || authorityBefore.final.phase !== 'deleted'
        || authorityBefore.stage || authorityBefore.stagePartial) {
        throw new Error('unfinished purging receipt publication has no exact deleted WAL handoff')
      }
      validatePurgeWal(authorityBefore.final as unknown as Record<string, unknown>, paths, receipt, host)
      if (discovered.state === 'inactive') {
        const exactHandoff = purgingLifecycleRootReceipt(discovered, authorityBefore.final, host)
        if (!sameLifecycleRootReceipt(receipt, exactHandoff)) {
          throw new Error('unfinished purging receipt publication is not the canonical deleted-WAL handoff')
        }
      } else if (!sameLifecycleRootReceipt(receipt, discovered)) {
        throw new Error('published purging receipt differs from its linked terminal transition')
      }
    }
    const hintedWal = authorityBefore.stage || authorityBefore.final
    if (receipt.state === 'purging' && (authorityBefore.stage || authorityBefore.stagePartial)) {
      throw new Error('purging receipt contains an impossible purge WAL stage')
    }
    const terminalReceiptWithoutWal = receipt.state === 'purging'
      && !hintedWal && !authorityBefore.stagePartial
    if (terminalReceiptWithoutWal) {
      // Once the deleted WAL has handed authority to the purging receipt, it
      // is a terminal cleanup receipt only.  A reappearing canonical root,
      // tombstone, or quarantine is foreign evidence; never reinterpret it as
      // a fresh purge tree and publish a new owner/WAL around it.
      assertPurgeReceiptCleanupOnlySafe(receipt, paths)
      plan = purgePlanFromPurgingReceipt(receipt)
      if (flags.dryRun) throw new Error('purging receipt requires terminal commit recovery')
      if (!flags.planHash || !SHA256_DIGEST.test(flags.planHash) || flags.dataRootId !== receipt.dataRootId
        || flags.planHash !== plan.planHash || flags.dataRootId !== plan.dataRootId) {
        throw new Error('purging receipt cleanup retry requires its prior plan hash and data-root ID')
      }
      cleanupOnly = true
    }
    if (flags.dryRun) {
      if (hintedWal || authorityBefore.stagePartial) {
        throw new Error('purge dry-run found durable purge recovery authority')
      }
      if (!fs.existsSync(paths.dataRoot)) throw new Error('purge dry-run requires the preserved data root')
      assertPurgeQuiescent(paths, host)
      assertPurgeNotInstalled(paths, host)
      plan = createPurgePlan(paths, host, receipt.dataRootId)
      if (flags.planHash || flags.dataRootId) throw new Error('purge dry-run does not accept commit proof')
    } else {
      if (fs.existsSync(paths.lifecycleWalPath)) throw new Error('lifecycle WAL must be recovered before purge')
      if (!cleanupOnly && !hintedWal && !fs.existsSync(paths.dataRoot)) {
        if (authorityBefore.stagePartial) {
          throw new Error('partial purge WAL stage has no canonical data root or complete recovery authority')
        }
        if (receipt.state !== 'purging') {
          throw new Error('absent purge root has no durable purging receipt handoff')
        }
        if (!flags.planHash || !SHA256_DIGEST.test(flags.planHash) || flags.dataRootId !== receipt.dataRootId) {
          throw new Error('purge cleanup-only retry requires its prior plan hash and data-root ID')
        }
        assertPurgeReceiptCleanupOnlySafe(receipt, paths)
        if (receipt.state === 'purging') {
          plan = purgePlanFromPurgingReceipt(receipt)
          if (flags.planHash !== plan.planHash || flags.dataRootId !== plan.dataRootId) {
            throw new Error('purging receipt differs from the supplied commit proof')
          }
        }
        cleanupOnly = true
      } else if (!cleanupOnly) {
        if (hintedWal) {
          plan = hintedWal.plan
        } else {
          const capturedPlan = await createPurgePlanWithRevalidation(
            paths,
            host,
            receipt.dataRootId,
            async () => {}
          )
          plan = capturedPlan.plan
          initialPlanMetadata = capturedPlan.metadata
          initialPlanEntries = capturedPlan.entries
        }
        if (!flags.planHash || !flags.dataRootId) throw new Error('purge commit requires plan hash and data-root ID')
        if (flags.planHash !== plan.planHash || flags.dataRootId !== plan.dataRootId) {
          throw new Error('purge commit proof is stale or identifies another data root')
        }
        if (hintedWal?.phase === 'prepared' && fs.existsSync(paths.dataRoot)) {
          const current = createPurgePlan(paths, host, receipt.dataRootId)
          if (canonicalJson(current) !== canonicalJson(plan)) {
            throw new Error('purge data root no longer matches the durable recovery plan')
          }
        }
      }
      const durable = durablePendingCount(paths.dataRoot)
      if (durable > 0) throw new Error(`${durable} durable transaction artifact(s) must be recovered before purge`)
      assertNoForeignLiveLifecycleProcess(paths, host, [])
      if (!cleanupOnly && receipt.state !== 'purging' && hintedWal?.phase !== 'deleted') {
        assertPurgeNotInstalled(paths, host)
      }
    }
  } catch (error) {
    issues.push({ level: 'error', message: error instanceof Error ? error.message : String(error) })
    return { ok: false, action: 'purge', mode, status: 'failed', plan, issues }
  }
  if (flags.dryRun) return { ok: true, action: 'purge', mode, status: 'planned', plan, issues }

  const purgePaths = paths
  const purgeReceiptTarget = receipt!
  const initialPurgeWal = authorityBefore.stage || authorityBefore.final
  const initialPurgeRootShape = cleanupOnly
    ? null
    : capturePurgeRootShape(purgePaths, initialPurgeWal)
  const initialPurgeDataMarkerAuthority = cleanupOnly
    ? null
    : capturePurgeDataMarkerAuthority(purgePaths, purgeReceiptTarget, initialPurgeWal, host)
  let initialWalTreeRoot: string | null = null
  let initialWalTreeMetadata: PlainTreeMetadataSnapshot | null = null
  let initialDeletingFrozen: PlainTreeEntry[] | null = null
  let initialDeletingHashes: ReadonlyMap<string, Sha256Digest> | null = null
  let initialDeletingMetadata: FrozenDeleteMetadata | null = null
  if (initialPurgeWal?.phase === 'prepared' || initialPurgeWal?.phase === 'renamed') {
    initialWalTreeRoot = initialPurgeRootShape?.canonical
      ? purgePaths.dataRoot
      : initialPurgeWal.tombstone
    const limits = {
      maxEntries: initialPurgeWal.entries.length,
      maxBytes: initialPurgeWal.plan.bytes,
      label: 'purge durable WAL pre-gate tree'
    }
    initialWalTreeMetadata = capturePlainTreeMetadata(initialWalTreeRoot, limits)
    assertPlainTreeMetadataManifest(initialWalTreeMetadata, initialPurgeWal.entries, limits.label)
  } else if (initialPurgeWal?.phase === 'deleting' && initialPurgeRootShape?.tombstone) {
    initialDeletingFrozen = materializePurgeWalEntries(initialPurgeWal)
    initialDeletingHashes = new Map(
      initialPurgeWal.entries.filter((entry) => entry.kind === 'file')
        .map((entry) => [entry.path, entry.sha256!])
    )
    initialDeletingMetadata = captureFrozenDeleteMetadata(
      initialPurgeWal.tombstone,
      initialDeletingFrozen,
      initialDeletingHashes
    )
  }
  const purgeReceiptInitial = receiptPublication!.namespace
  const purgeReceiptDirectoryFence = captureDirectoryFence(purgeReceiptInitial.directory)
  if (!purgeReceiptInitial.receiptState?.stat) {
    return {
      ok: false,
      action: 'purge',
      mode,
      status: 'failed',
      plan,
      issues: [{ level: 'error', message: 'purge root receipt disappeared before lifecycle mutex acquisition' }]
    }
  }
  const assertInitialPurgeReceiptPublicationAuthority = () => {
    preflightPurgeAuthorityPaths(purgePaths, purgeReceiptTarget, initialPurgeWal, host)
    const current = readLifecycleRootReceiptNamespace(host)
    if (current.directory !== purgeReceiptInitial.directory
      || current.directoryExists !== purgeReceiptInitial.directoryExists
      || current.homeIdentity !== purgeReceiptInitial.homeIdentity
      || current.ownerStageNamespaceId !== purgeReceiptInitial.ownerStageNamespaceId
      || current.ownerStageAuthorityMarker !== purgeReceiptInitial.ownerStageAuthorityMarker
      || current.daemonStageNamespaceId !== purgeReceiptInitial.daemonStageNamespaceId
      || current.daemonStageAuthorityMarker !== purgeReceiptInitial.daemonStageAuthorityMarker
      || current.writing !== purgeReceiptInitial.writing
      || canonicalJson(current.receipt) !== canonicalJson(purgeReceiptInitial.receipt)
      || canonicalJson(current.pendingReceipt) !== canonicalJson(purgeReceiptInitial.pendingReceipt)
      || canonicalJson(current.writingReceipt) !== canonicalJson(purgeReceiptInitial.writingReceipt)) {
      throw new Error('purge receipt publication authority changed while acquiring the lifecycle mutex')
    }
    const absent: CapturedFileState = { bytes: null, stat: null }
    assertDirectoryFence(purgeReceiptInitial.directory, purgeReceiptDirectoryFence)
    assertCapturedFileState(
      join(purgeReceiptInitial.directory, LIFECYCLE_ROOT_RECEIPT_NAMESPACE_MARKER),
      purgeReceiptInitial.markerState || absent,
      'purge receipt namespace marker authority',
      0
    )
    if (purgeReceiptInitial.ownerStageAuthorityMarker) {
      assertCapturedFileState(
        purgeReceiptInitial.ownerStageAuthorityMarker,
        purgeReceiptInitial.ownerStageAuthorityMarkerState || absent,
        'purge HOME owner-stage authority marker',
        0
      )
    }
    if (purgeReceiptInitial.daemonStageAuthorityMarker) {
      assertCapturedFileState(
        purgeReceiptInitial.daemonStageAuthorityMarker,
        purgeReceiptInitial.daemonStageAuthorityMarkerState || absent,
        'purge HOME daemon-stage authority marker',
        0
      )
    }
    assertCapturedFileState(
      current.file,
      purgeReceiptInitial.receiptState || absent,
      'purge published receipt authority',
      LIFECYCLE_ROOT_RECEIPT_MAX_BYTES
    )
    assertCapturedFileState(
      current.pending,
      purgeReceiptInitial.pendingState || absent,
      'purge pending receipt authority',
      LIFECYCLE_ROOT_RECEIPT_MAX_BYTES
    )
    if (purgeReceiptInitial.writing && purgeReceiptInitial.writingState) {
      assertCapturedFileState(
        purgeReceiptInitial.writing,
        purgeReceiptInitial.writingState,
        'purge receipt writer authority',
        LIFECYCLE_ROOT_RECEIPT_MAX_BYTES
      )
    }
  }
  const assertTerminalPurgeReceiptPublicationAuthority = () => {
    preflightPurgeAuthorityPaths(purgePaths, purgeReceiptTarget, initialPurgeWal, host)
    const current = readLifecycleRootReceiptNamespace(host)
    if (current.directory !== purgeReceiptInitial.directory
      || current.homeIdentity !== purgeReceiptInitial.homeIdentity
      || current.ownerStageNamespaceId !== purgeReceiptInitial.ownerStageNamespaceId
      || current.ownerStageAuthorityMarker !== purgeReceiptInitial.ownerStageAuthorityMarker
      || current.daemonStageNamespaceId !== purgeReceiptInitial.daemonStageNamespaceId
      || current.daemonStageAuthorityMarker !== purgeReceiptInitial.daemonStageAuthorityMarker
      || !sameLifecycleRootReceipt(current.receipt, purgeReceiptTarget)
      || current.pendingState || current.writingState
      || !current.receiptState?.stat || current.receiptState.stat.nlink !== 1) {
      throw new Error('purging receipt publication did not reach its unique terminal target')
    }
    const absent: CapturedFileState = { bytes: null, stat: null }
    assertDirectoryFence(purgeReceiptInitial.directory, purgeReceiptDirectoryFence)
    assertCapturedFileState(
      join(purgeReceiptInitial.directory, LIFECYCLE_ROOT_RECEIPT_NAMESPACE_MARKER),
      purgeReceiptInitial.markerState || absent,
      'purge terminal receipt namespace marker authority',
      0
    )
    if (purgeReceiptInitial.ownerStageAuthorityMarker) {
      assertCapturedFileState(
        purgeReceiptInitial.ownerStageAuthorityMarker,
        purgeReceiptInitial.ownerStageAuthorityMarkerState || absent,
        'purge terminal HOME owner-stage authority marker',
        0
      )
    }
    if (purgeReceiptInitial.daemonStageAuthorityMarker) {
      assertCapturedFileState(
        purgeReceiptInitial.daemonStageAuthorityMarker,
        purgeReceiptInitial.daemonStageAuthorityMarkerState || absent,
        'purge terminal HOME daemon-stage authority marker',
        0
      )
    }
    assertLifecycleRootReceiptCurrentExact(host, purgeReceiptTarget)
  }
  const sealPurgeExternalAuthority = () => {
    assertNoLifecycleWalHiddenStageResidue(purgePaths, host)
    assertPurgeReservedSiblingInventory(
      purgePaths,
      host,
      authorityBefore.stage || authorityBefore.final
    )
    if (initialPurgeRootShape) {
      assertPurgeRootShape(purgePaths, initialPurgeWal, initialPurgeRootShape)
    }
    if (initialPlanMetadata && plan) {
      assertPlainTreeMetadataSnapshotCurrent(purgePaths.dataRoot, initialPlanMetadata, {
        maxEntries: plan.entries,
        maxBytes: plan.bytes,
        label: 'purge fresh pre-gate tree'
      })
    }
    if (initialWalTreeRoot && initialWalTreeMetadata && initialPurgeWal) {
      assertPlainTreeMetadataSnapshotCurrent(initialWalTreeRoot, initialWalTreeMetadata, {
        maxEntries: initialPurgeWal.entries.length,
        maxBytes: initialPurgeWal.plan.bytes,
        label: 'purge durable WAL pre-gate tree'
      })
    }
    if (initialDeletingFrozen && initialDeletingHashes && initialDeletingMetadata && initialPurgeWal) {
      assertFrozenDeleteMetadataSnapshotCurrent(
        initialPurgeWal.tombstone,
        initialDeletingFrozen,
        initialDeletingHashes,
        initialDeletingMetadata
      )
    }
    assertPurgeDataMarkerAuthority(initialPurgeDataMarkerAuthority)
    const terminalPurgeAuthority = purgeReceiptTarget.state === 'purging'
      || initialPurgeWal?.phase === 'deleted'
    if (initialPurgeWal?.phase === 'deleted') {
      assertPurgeWalTerminalAbsence(purgePaths, initialPurgeWal)
    }
    if (cleanupOnly) {
      assertPurgeReceiptCleanupOnlySafe(purgeReceiptTarget, purgePaths)
    } else if (!terminalPurgeAuthority) {
      if (!plan) throw new Error('purge lost its authorized plan while acquiring the lifecycle mutex')
      assertPurgeNotInstalled(purgePaths, host)
      assertNoForeignLiveLifecycleProcess(purgePaths, host, [])
    }
    assertNoLifecycleWalHiddenStageResidue(purgePaths, host)
  }
  const sealPurgeNonReceiptAuthority = () => {
    sealPurgeExternalAuthority()
    assertPurgeAuthoritySnapshot(
      purgePaths,
      purgeReceiptTarget,
      host,
      authorityBefore,
      'purge recovery authority while acquiring the lifecycle mutex'
    )
    sealPurgeExternalAuthority()
  }
  const sealPurgeReceiptAuthorityBefore = () => {
    assertInitialPurgeReceiptPublicationAuthority()
    sealPurgeNonReceiptAuthority()
    assertInitialPurgeReceiptPublicationAuthority()
  }
  const sealPurgeReceiptAuthorityAfter = () => {
    assertTerminalPurgeReceiptPublicationAuthority()
    sealPurgeNonReceiptAuthority()
    assertTerminalPurgeReceiptPublicationAuthority()
  }
  const revalidateInitialPurgeTreeAuthority = async (renew: () => Promise<void>) => {
    if (initialPlanMetadata && initialPlanEntries) {
      const verified = await createPurgePlanWithRevalidation(
        purgePaths,
        host,
        purgeReceiptTarget.dataRootId,
        renew,
        initialPlanMetadata
      )
      if (canonicalJson(verified.plan) !== canonicalJson(plan)
        || canonicalPlainTree(verified.entries) !== canonicalPlainTree(initialPlanEntries)) {
        throw new Error('purge data root changed from the pre-gate frozen plan')
      }
      return
    }
    if (initialWalTreeRoot && initialWalTreeMetadata && initialPurgeWal) {
      await assertFullPurgeWalTree(
        initialWalTreeRoot,
        initialPurgeWal,
        renew,
        'purge durable WAL pre-gate tree',
        initialWalTreeMetadata
      )
      return
    }
    if (initialDeletingFrozen && initialDeletingHashes && initialDeletingMetadata && initialPurgeWal) {
      const state = await inspectFrozenDeleteStateWithRevalidation(
        initialPurgeWal.tombstone,
        initialDeletingFrozen,
        initialDeletingHashes,
        true,
        renew
      )
      assertFrozenDeleteMetadataCurrent(initialDeletingMetadata, state)
    }
  }
  const hasInitialTreeAuthority = Boolean(
    initialPlanMetadata || initialWalTreeMetadata || initialDeletingMetadata
  )
  let lifecycleLease: LifecycleLease | null = null
  try {
    lifecycleLease = await acquireLifecycleLock(purgePaths, host, 'purge', true, {
      target: purgeReceiptTarget,
      allowedCurrent: [receiptPublication!.final, purgeReceiptTarget],
      terminalPreflight: purgeReceiptTarget.state === 'purging' || initialPurgeWal?.phase === 'deleted',
      sealBeforePublication: sealPurgeReceiptAuthorityBefore,
      sealAfterPublication: sealPurgeReceiptAuthorityAfter,
      sealPostOwnerPublication: sealPurgeExternalAuthority,
      revalidateExternalAuthority: hasInitialTreeAuthority ? revalidateInitialPurgeTreeAuthority : undefined,
      afterApplicationGateRevalidate: privateHooks.checkpoint
        ? () => privateHooks.checkpoint!('after-application-gate-revalidate-before-seal')
        : undefined
    })
    lifecycleLease.assertPostPublicationAuthority()
    receipt = purgeReceiptTarget
    assertLifecycleRootReceiptCurrentExact(host, purgeReceiptTarget)
    const createPurgeProtocolEpoch = (
      initialReceipt: LifecycleRootReceiptV1,
      initialWal: PurgeWalV1 | null,
      initialAuthority?: PurgeAuthoritySnapshot
    ): PurgeProtocolEpoch => {
      let expectedReceipt = initialReceipt
      let expectedWal = initialWal
      let ownerPublication = readLifecycleOwnerPublicationHint(paths, host)
      let receiptNamespace = readLifecycleRootReceiptNamespace(host)
      const receiptFence = captureDirectoryFence(receiptNamespace.directory)
      const protocolFence = captureDirectoryFence(dirname(paths.lifecycleLockPath))
      let expectedAuthority = initialAuthority || readPurgeAuthoritySnapshot(paths, expectedReceipt, host)
      const ordinaryWal = readLifecycleWal(paths, host)
      const ordinaryWalState = captureFileState(paths.lifecycleWalPath, LIFECYCLE_WAL_MAX_BYTES)
      const installManifestAuthority = initialReceipt.state === 'inactive' && initialWal?.phase !== 'deleted'
        ? captureFileState(paths.manifestPath, MANIFEST_MAX_BYTES)
        : null
      let dataMarkerAuthority = capturePurgeDataMarkerAuthority(paths, expectedReceipt, expectedWal, host)

      const captureEpochRootShape = (
        receiptValue: LifecycleRootReceiptV1,
        walValue: PurgeWalV1 | null
      ): PurgeRootShapeProof => {
        if (walValue || receiptValue.state !== 'purging') return capturePurgeRootShape(paths, walValue)
        const terminal = {
          canonical: captureOptionalPlainDirectoryIdentity(paths.dataRoot, 'purge terminal canonical root'),
          tombstone: captureOptionalPlainDirectoryIdentity(receiptValue.tombstone, 'purge terminal tombstone'),
          quarantine: captureOptionalPlainDirectoryIdentity(receiptValue.quarantine, 'purge terminal quarantine')
        }
        if (terminal.canonical || terminal.tombstone || terminal.quarantine) {
          throw new Error('purging receipt retained terminal data-root state')
        }
        return terminal
      }
      let rootShape = captureEpochRootShape(expectedReceipt, expectedWal)

      const assertUniqueReceipt = (
        namespace: LifecycleRootReceiptNamespace,
        target: LifecycleRootReceiptV1,
        label: string
      ) => {
        if (!sameLifecycleRootReceipt(namespace.receipt, target)
          || !namespace.receiptState?.stat || namespace.receiptState.stat.nlink !== 1
          || namespace.pendingState || namespace.writingState || !namespace.markerState?.stat) {
          throw new Error(`${label} is not a unique exact receipt publication`)
        }
      }
      const assertUniqueOwner = (publication: LifecycleOwnerPublicationHint, allowAbsent = false) => {
        const owner = publication.record
        if (!owner) {
          if (allowAbsent && !publication.finalState.stat && publication.artifacts.length === 0) return
          throw new Error('purge mutation has no exact lifecycle owner authority')
        }
        if (owner.token !== lifecycleLease!.token
          || !publication.finalState.stat || publication.finalState.stat.nlink !== 1
          || publication.artifacts.length !== 0
          || !sameOptionalBuffer(publication.finalState.bytes, recordBytes(owner))) {
          throw new Error('purge lifecycle owner is not uniquely frozen')
        }
      }
      assertUniqueOwner(ownerPublication)
      assertUniqueReceipt(receiptNamespace, expectedReceipt, 'purge receipt mutation authority')
      if (canonicalJson(expectedAuthority.final) !== canonicalJson(expectedWal)
        || expectedWal && (!expectedAuthority.finalState.stat
          || expectedAuthority.finalState.stat.nlink < 1
          || expectedAuthority.finalState.stat.nlink > 2)) {
        throw new Error('purge mutation WAL authority does not match its frozen final')
      }
      if (ordinaryWal || ordinaryWalState.stat) {
        throw new Error('ordinary lifecycle WAL appeared during purge mutation authority capture')
      }

      const stableStageNamespace = (namespace: LifecycleOwnerStageNamespace) => ({
        directory: namespace.directory,
        directoryIdentity: namespace.directoryState
          ? {
              dev: namespace.directoryState.stat.dev,
              ino: namespace.directoryState.stat.ino,
              nlink: namespace.directoryState.stat.nlink,
              entries: namespace.directoryState.entries.filter((name) => !PURGE_WAL_STAGE.test(name))
            }
          : null,
        namespaceId: namespace.namespaceId,
        marker: namespace.marker,
        markerState: namespace.markerState,
        reservations: namespace.reservations
      })
      const assertOwnerStableExceptPurgeStage = (
        previous: LifecycleOwnerPublicationHint,
        current: LifecycleOwnerPublicationHint
      ) => {
        if (canonicalJson(previous.record) !== canonicalJson(current.record)
          || canonicalJson(previous.finalState.stat) !== canonicalJson(current.finalState.stat)
          || !sameOptionalBuffer(previous.finalState.bytes, current.finalState.bytes)
          || previous.artifacts.length !== current.artifacts.length
          || previous.artifacts.some((artifact, index) => {
            const next = current.artifacts[index]
            return !next || artifact.file !== next.file
              || canonicalJson(artifact.state.stat) !== canonicalJson(next.state.stat)
              || !sameOptionalBuffer(artifact.state.bytes, next.state.bytes)
          })
          || canonicalJson(stableStageNamespace(previous.stageNamespace))
            !== canonicalJson(stableStageNamespace(current.stageNamespace))) {
          throw new Error('purge WAL transition changed unrelated lifecycle owner authority')
        }
      }
      const assertReceiptSnapshot = () => {
        assertDirectoryFence(receiptNamespace.directory, receiptFence)
        assertLifecycleRootReceiptNamespaceExact(
          host,
          receiptNamespace,
          'purge receipt mutation authority'
        )
      }
      const assertOrdinaryWalAbsent = () => {
        assertCapturedFileState(
          paths.lifecycleWalPath,
          ordinaryWalState,
          'ordinary lifecycle WAL absence during purge mutation',
          LIFECYCLE_WAL_MAX_BYTES
        )
        if (readLifecycleWal(paths, host)) {
          throw new Error('ordinary lifecycle WAL appeared during purge mutation')
        }
      }
      const assertCurrentRootShape = () => {
        const current = captureEpochRootShape(expectedReceipt, expectedWal)
        const comparableCurrent = expectedWal?.phase === 'deleting'
          ? { canonical: current.canonical, tombstone: current.tombstone }
          : current
        const comparableExpected = expectedWal?.phase === 'deleting'
          ? { canonical: rootShape.canonical, tombstone: rootShape.tombstone }
          : rootShape
        if (canonicalJson(comparableCurrent) !== canonicalJson(comparableExpected)) {
          throw new Error('purge canonical/tombstone/quarantine identity changed across an authority boundary')
        }
      }
      const seal = () => {
        lifecycleLease!.sealApplicationGate()
        preflightPurgeAuthorityPaths(paths, expectedReceipt, expectedWal, host)
        if (expectedReceipt.state === 'inactive' && expectedWal?.phase !== 'deleted') {
          if (!installManifestAuthority) throw new Error('purge evolving install-manifest authority was not frozen')
          assertCapturedFileState(
            paths.manifestPath,
            installManifestAuthority,
            'purge evolving install-manifest authority',
            MANIFEST_MAX_BYTES
          )
          assertPurgeNotInstalled(paths, host)
        }
        assertDirectoryFence(dirname(paths.lifecycleLockPath), protocolFence)
        assertLifecycleOwnerPublicationHint(
          paths,
          host,
          ownerPublication,
          'purge lifecycle owner mutation authority'
        )
        assertPurgeReservedSiblingInventory(paths, host, expectedWal, ownerPublication)
        assertReceiptSnapshot()
        assertPurgeAuthoritySnapshot(
          paths,
          expectedReceipt,
          host,
          expectedAuthority,
          'purge WAL mutation authority'
        )
        assertOrdinaryWalAbsent()
        assertPurgeDataMarkerAuthority(dataMarkerAuthority)
        assertCurrentRootShape()
        lifecycleLease!.sealApplicationGate()
      }
      const checkpoint = async () => {
        seal()
        await lifecycleLease!.revalidateApplicationGate()
        seal()
      }

      const assertUnchangedForAdvance = (allowPurgeStageChange = false) => {
        lifecycleLease!.sealApplicationGate()
        preflightPurgeAuthorityPaths(paths, expectedReceipt, expectedWal, host)
        assertDirectoryFence(dirname(paths.lifecycleLockPath), protocolFence)
        assertReceiptSnapshot()
        assertOrdinaryWalAbsent()
        const currentOwner = readLifecycleOwnerPublicationHint(paths, host)
        if (allowPurgeStageChange) assertOwnerStableExceptPurgeStage(ownerPublication, currentOwner)
        else assertLifecycleOwnerPublicationHint(paths, host, ownerPublication, 'purge epoch owner authority')
        return currentOwner
      }

      checkpoint.seal = seal
      checkpoint.advanceCanonicalIsolation = (wal: PurgeWalV1) => {
        if (canonicalJson(wal) !== canonicalJson(expectedWal) || wal.phase !== 'prepared'
          || !rootShape.canonical || rootShape.tombstone || rootShape.quarantine) {
          throw new Error('purge epoch cannot advance an unauthorized canonical-root isolation')
        }
        assertUnchangedForAdvance()
        assertPurgeAuthoritySnapshot(paths, expectedReceipt, host, expectedAuthority, 'purge WAL during root isolation')
        const nextShape = capturePurgeRootShape(paths, wal)
        if (nextShape.canonical || !nextShape.tombstone || nextShape.quarantine
          || canonicalJson(nextShape.tombstone) !== canonicalJson(rootShape.canonical)) {
          throw new Error('purge canonical-root isolation did not preserve the frozen root inode')
        }
        const nextMarker = capturePurgeDataMarkerAuthority(paths, expectedReceipt, wal, host)
        if (!dataMarkerAuthority || !nextMarker
          || canonicalJson(dataMarkerAuthority.state.stat) !== canonicalJson(nextMarker.state.stat)
          || !sameOptionalBuffer(dataMarkerAuthority.state.bytes, nextMarker.state.bytes)) {
          throw new Error('purge canonical-root isolation changed the owned data marker')
        }
        dataMarkerAuthority = nextMarker
        rootShape = nextShape
        lifecycleLease!.sealApplicationGate()
      }
      checkpoint.advanceWal = (wal: PurgeWalV1) => {
        const linkedTargetRecovery = expectedWal
          && canonicalJson(expectedWal) === canonicalJson(wal)
          && canonicalJson(expectedAuthority.stage) === canonicalJson(wal)
        if (expectedWal && !linkedTargetRecovery) assertPurgeWalTransition(expectedWal, wal)
        else if (!expectedWal && wal.phase !== 'prepared') {
          throw new Error('purge epoch can only publish an initial prepared WAL')
        }
        const currentOwner = assertUnchangedForAdvance(true)
        const currentAuthority = readPurgeAuthoritySnapshot(paths, expectedReceipt, host)
        if (currentAuthority.stage || currentAuthority.stagePartial
          || canonicalJson(currentAuthority.final) !== canonicalJson(wal)
          || currentAuthority.finalState.stat?.nlink !== 1) {
          throw new Error('purge WAL transition did not reach its unique exact target')
        }
        const nextRootShape = capturePurgeRootShape(paths, wal)
        if (canonicalJson(nextRootShape) !== canonicalJson(rootShape)) {
          throw new Error('purge WAL transition changed the frozen root identity')
        }
        ownerPublication = currentOwner
        expectedWal = wal
        expectedAuthority = currentAuthority
        dataMarkerAuthority = capturePurgeDataMarkerAuthority(paths, expectedReceipt, expectedWal, host)
        rootShape = nextRootShape
        lifecycleLease!.sealApplicationGate()
      }
      checkpoint.advancePartialWalStageRemoval = () => {
        if (!expectedAuthority.stagePartial || !expectedAuthority.stageNamespace.purgeStage) {
          throw new Error('purge epoch has no partial WAL stage to remove')
        }
        const currentOwner = assertUnchangedForAdvance(true)
        const currentAuthority = readPurgeAuthoritySnapshot(paths, expectedReceipt, host)
        if (currentAuthority.stage || currentAuthority.stagePartial
          || canonicalJson(currentAuthority.final) !== canonicalJson(expectedWal)) {
          throw new Error('partial purge WAL stage cleanup changed the frozen final authority')
        }
        ownerPublication = currentOwner
        expectedAuthority = currentAuthority
        lifecycleLease!.sealApplicationGate()
      }
      checkpoint.advanceDeletingRootRemoval = (wal: PurgeWalV1) => {
        if (canonicalJson(wal) !== canonicalJson(expectedWal) || wal.phase !== 'deleting'
          || !rootShape.tombstone) {
          throw new Error('purge epoch cannot advance an unauthorized deleting-root removal')
        }
        assertUnchangedForAdvance()
        assertPurgeAuthoritySnapshot(paths, expectedReceipt, host, expectedAuthority, 'purge WAL during deleting-root removal')
        const nextShape = capturePurgeRootShape(paths, wal)
        if (nextShape.canonical || nextShape.tombstone || nextShape.quarantine) {
          throw new Error('purge deleting-root removal retained protocol root state')
        }
        rootShape = nextShape
        lifecycleLease!.sealApplicationGate()
      }
      checkpoint.advanceReceiptHandoff = (target: LifecycleRootReceiptV1, wal: PurgeWalV1) => {
        if (expectedReceipt.state !== 'inactive' || target.state !== 'purging'
          || canonicalJson(wal) !== canonicalJson(expectedWal) || wal.phase !== 'deleted'
          || !sameLifecycleRootReceipt(target, purgingLifecycleRootReceipt(expectedReceipt, wal, host))) {
          throw new Error('purge epoch cannot advance an unauthorized receipt handoff')
        }
        lifecycleLease!.sealApplicationGate()
        preflightPurgeAuthorityPaths(paths, target, wal, host)
        assertDirectoryFence(dirname(paths.lifecycleLockPath), protocolFence)
        assertDirectoryFence(receiptNamespace.directory, receiptFence)
        assertLifecycleOwnerPublicationHint(paths, host, ownerPublication, 'purge receipt-handoff owner authority')
        assertPurgeReservedSiblingInventory(paths, host, expectedWal, ownerPublication)
        assertOrdinaryWalAbsent()
        assertCurrentRootShape()
        const currentReceipt = readLifecycleRootReceiptNamespace(host)
        assertUniqueReceipt(currentReceipt, target, 'purging receipt handoff')
        if (currentReceipt.directory !== receiptNamespace.directory
          || currentReceipt.homeIdentity !== receiptNamespace.homeIdentity
          || canonicalJson(currentReceipt.markerState?.stat) !== canonicalJson(receiptNamespace.markerState?.stat)
          || !sameOptionalBuffer(currentReceipt.markerState?.bytes || null, receiptNamespace.markerState?.bytes || null)
          || currentReceipt.ownerStageNamespaceId !== receiptNamespace.ownerStageNamespaceId
          || currentReceipt.ownerStageAuthorityMarker !== receiptNamespace.ownerStageAuthorityMarker
          || currentReceipt.daemonStageNamespaceId !== receiptNamespace.daemonStageNamespaceId
          || currentReceipt.daemonStageAuthorityMarker !== receiptNamespace.daemonStageAuthorityMarker
          || currentReceipt.daemonStageAuthorityMarker || currentReceipt.daemonStageNamespaceId) {
          throw new Error('purging receipt handoff changed preserved namespace authority')
        }
        const currentAuthority = readPurgeAuthoritySnapshot(paths, target, host)
        if (currentAuthority.stage || currentAuthority.stagePartial
          || canonicalJson(currentAuthority.final) !== canonicalJson(wal)
          || currentAuthority.finalState.stat?.nlink !== 1) {
          throw new Error('purging receipt handoff lost its deleted WAL authority')
        }
        expectedReceipt = target
        receiptNamespace = currentReceipt
        expectedAuthority = currentAuthority
        dataMarkerAuthority = null
        rootShape = captureEpochRootShape(expectedReceipt, expectedWal)
        lifecycleLease!.sealApplicationGate()
      }
      checkpoint.advanceWalRemoval = (wal: PurgeWalV1) => {
        if (canonicalJson(wal) !== canonicalJson(expectedWal) || wal.phase !== 'deleted'
          || expectedReceipt.state !== 'purging') {
          throw new Error('purge epoch cannot advance an unauthorized WAL removal')
        }
        const currentOwner = assertUnchangedForAdvance(true)
        const currentAuthority = readPurgeAuthoritySnapshot(paths, expectedReceipt, host)
        if (currentAuthority.final || currentAuthority.stage || currentAuthority.stagePartial) {
          throw new Error('purge WAL removal did not reach exact absence')
        }
        ownerPublication = currentOwner
        expectedWal = null
        expectedAuthority = currentAuthority
        dataMarkerAuthority = null
        rootShape = captureEpochRootShape(expectedReceipt, null)
        lifecycleLease!.sealApplicationGate()
      }
      checkpoint.advanceOwnerStageRemoval = () => {
        if (expectedWal || expectedReceipt.state !== 'purging') {
          throw new Error('purge epoch cannot remove owner-stage authority before terminal handoff')
        }
        lifecycleLease!.sealApplicationGate()
        preflightPurgeAuthorityPaths(paths, expectedReceipt, expectedWal, host)
        assertDirectoryFence(dirname(paths.lifecycleLockPath), protocolFence)
        assertOrdinaryWalAbsent()
        const currentReceipt = readLifecycleRootReceiptNamespace(host)
        assertUniqueReceipt(currentReceipt, expectedReceipt, 'purge owner-stage cleanup receipt')
        if (currentReceipt.ownerStageAuthorityMarker || currentReceipt.ownerStageNamespaceId
          || currentReceipt.daemonStageAuthorityMarker || currentReceipt.daemonStageNamespaceId
          || currentReceipt.directory !== receiptNamespace.directory
          || currentReceipt.homeIdentity !== receiptNamespace.homeIdentity
          || canonicalJson(currentReceipt.receiptState?.stat) !== canonicalJson(receiptNamespace.receiptState?.stat)
          || !sameOptionalBuffer(currentReceipt.receiptState?.bytes || null, receiptNamespace.receiptState?.bytes || null)
          || canonicalJson(currentReceipt.markerState?.stat) !== canonicalJson(receiptNamespace.markerState?.stat)
          || !sameOptionalBuffer(currentReceipt.markerState?.bytes || null, receiptNamespace.markerState?.bytes || null)) {
          throw new Error('purge owner-stage cleanup changed unrelated receipt authority')
        }
        const currentOwner = readLifecycleOwnerPublicationHint(paths, host)
        if (canonicalJson(currentOwner.record) !== canonicalJson(ownerPublication.record)
          || canonicalJson(currentOwner.finalState.stat) !== canonicalJson(ownerPublication.finalState.stat)
          || !sameOptionalBuffer(currentOwner.finalState.bytes, ownerPublication.finalState.bytes)
          || currentOwner.artifacts.length !== ownerPublication.artifacts.length
          || currentOwner.stageNamespace.directoryState || currentOwner.stageNamespace.reservations.length
          || currentOwner.stageNamespace.purgeStage || currentOwner.stageNamespace.namespaceId) {
          throw new Error('purge owner-stage cleanup changed unrelated lifecycle owner authority')
        }
        receiptNamespace = currentReceipt
        ownerPublication = currentOwner
        expectedAuthority = readPurgeAuthoritySnapshot(paths, expectedReceipt, host)
        lifecycleLease!.sealApplicationGate()
      }
      checkpoint.advanceOwnerRemoval = () => {
        if (expectedWal || expectedReceipt.state !== 'purging') {
          throw new Error('purge epoch cannot retire the lifecycle owner before terminal handoff')
        }
        lifecycleLease!.sealApplicationGate()
        assertReceiptSnapshot()
        assertOrdinaryWalAbsent()
        const currentOwner = readLifecycleOwnerPublicationHint(paths, host)
        if (currentOwner.record || currentOwner.finalState.stat || currentOwner.artifacts.length
          || currentOwner.stageNamespace.directoryState || currentOwner.stageNamespace.reservations.length
          || currentOwner.stageNamespace.purgeStage) {
          throw new Error('purge lifecycle owner retirement did not reach exact absence')
        }
        ownerPublication = currentOwner
        lifecycleLease!.sealApplicationGate()
      }
      return checkpoint
    }
    let authority = readPurgeAuthoritySnapshot(paths, receipt!, host)
    const purgeEpoch = createPurgeProtocolEpoch(receipt!, authority.final, authority)
    if (authority.stagePartial) {
      const stagedToken = authority.stageNamespace.purgeStage?.lockToken
      if (stagedToken !== lifecycleLease.token) throw new Error('partial purge WAL stage is not bound to the adopted lifecycle owner')
      purgeEpoch.seal()
      authority = removePartialPurgeWalStage(paths, receipt!, host, authority)
      purgeEpoch.advancePartialWalStageRemoval()
    }
    let purgeWal = authority.final
    if (authority.stage) {
      if (authority.stage.lockToken !== lifecycleLease.token) throw new Error('staged purge WAL is not bound to the adopted lifecycle owner')
      purgeEpoch.seal()
      purgeWal = writePurgeWal(paths, receipt!, host, authority.stage, authority.final)
      purgeEpoch.advanceWal(purgeWal)
    }
    if (!purgeWal && !cleanupOnly) {
      if (!plan) throw new Error('purge commit lost its authorized plan')
      assertPurgeQuiescent(paths, host, lifecycleLease.token, lifecycleLease.applicationOwner || undefined)
      assertPurgeNotInstalled(paths, host)
      const canonicalFence = captureDirectoryFence(paths.dataRoot)
      const rootState = fs.lstatSync(paths.dataRoot)
      const locked = await createPurgePlanWithRevalidation(
        paths,
        host,
        receipt!.dataRootId,
        purgeEpoch,
        initialPlanMetadata || undefined
      )
      assertDirectoryFence(paths.dataRoot, canonicalFence)
      assertPurgeWalRootIdentity(paths.dataRoot, {
        rootDev: String(rootState.dev),
        rootIno: String(rootState.ino)
      } as PurgeWalV1, 'purge canonical root')
      if (canonicalJson(locked.plan) !== canonicalJson(plan)) throw new Error('purge plan changed after lock acquisition')
      purgeWal = createPreparedPurgeWal(paths, receipt!, lifecycleLease.token, locked.plan, locked.entries, rootState, host)
      if (lstatOptional(purgeWal.tombstone) || lstatOptional(purgeWal.quarantine)) {
        throw new Error('purge reserved tombstone namespace already exists')
      }
      purgeEpoch.seal()
      purgeWal = writePurgeWal(paths, receipt!, host, purgeWal, null)
      purgeEpoch.advanceWal(purgeWal)
    }

    if (purgeWal) {
      if (!plan || canonicalJson(plan) !== canonicalJson(purgeWal.plan)) {
        throw new Error('purge WAL plan differs from the supplied commit proof')
      }
      if (purgeWal.lockToken !== lifecycleLease.token) throw new Error('purge WAL is not bound to the lifecycle recovery owner')
      assertSafeRecursiveRoot(
        purgeWal.tombstone,
        'purge tombstone',
        [paths.dataRoot, paths.installDir, paths.packageRoot, host.home],
        host.platform
      )
      assertSafeRecursiveRoot(
        purgeWal.quarantine,
        'purge delete quarantine',
        [paths.dataRoot, paths.installDir, paths.packageRoot, host.home],
        host.platform
      )

      if (purgeWal.phase === 'prepared') {
        const canonicalState = lstatOptional(paths.dataRoot)
        const tombstoneState = lstatOptional(purgeWal.tombstone)
        if (canonicalState && tombstoneState) throw new Error('purge prepared authority found both canonical and tombstone roots')
        const quarantineAbsent = captureFileState(purgeWal.quarantine, 0)
        if (quarantineAbsent.stat) throw new Error('purge prepared authority found a premature delete quarantine')
        if (canonicalState) {
          const tombstoneAbsent = captureFileState(purgeWal.tombstone, 0)
          if (tombstoneAbsent.stat) throw new Error('purge tombstone appeared before canonical-root scan')
          const parentFence = captureDirectoryFence(dirname(paths.dataRoot))
          const rootFence = captureDirectoryFence(paths.dataRoot)
          await assertFullPurgeWalTree(
            paths.dataRoot,
            purgeWal,
            purgeEpoch,
            'purge canonical root',
            initialWalTreeRoot && samePath(initialWalTreeRoot, paths.dataRoot, host.platform)
              ? initialWalTreeMetadata || undefined
              : undefined
          )
          await purgeEpoch()
          assertPurgeQuiescent(paths, host, lifecycleLease.token, lifecycleLease.applicationOwner || undefined, purgeWal)
          assertLifecycleRootReceiptCurrentExact(host, receipt!)
          const exactWal = readPurgeAuthoritySnapshot(paths, receipt!, host)
          if (exactWal.stageNamespace.purgeStage || canonicalJson(exactWal.final) !== canonicalJson(purgeWal)) {
            throw new Error('purge WAL changed before canonical-root isolation')
          }
          assertDirectoryFence(paths.dataRoot, rootFence)
          assertDirectoryFence(dirname(paths.dataRoot), parentFence)
          assertPurgeWalRootIdentity(paths.dataRoot, purgeWal, 'purge canonical root')
          assertCapturedFileState(purgeWal.tombstone, tombstoneAbsent, 'absent purge tombstone before atomic isolation', 0)
          assertCapturedFileState(purgeWal.quarantine, quarantineAbsent, 'absent purge quarantine before atomic isolation', 0)
          purgeEpoch.seal()
          fs.renameSync(paths.dataRoot, purgeWal.tombstone)
          flushDirectory(dirname(paths.dataRoot))
          assertPurgeWalRootIdentity(purgeWal.tombstone, purgeWal, 'purge tombstone')
          assertCapturedFileState(purgeWal.quarantine, quarantineAbsent, 'absent purge quarantine after atomic isolation', 0)
          purgeEpoch.advanceCanonicalIsolation(purgeWal)
        } else if (tombstoneState) {
          const canonicalAbsent = captureFileState(paths.dataRoot, 0)
          if (canonicalAbsent.stat) throw new Error('purge canonical root appeared before tombstone recovery scan')
          await assertFullPurgeWalTree(
            purgeWal.tombstone,
            purgeWal,
            purgeEpoch,
            'purge prepared tombstone recovery',
            initialWalTreeRoot && samePath(initialWalTreeRoot, purgeWal.tombstone, host.platform)
              ? initialWalTreeMetadata || undefined
              : undefined
          )
          assertCapturedFileState(paths.dataRoot, canonicalAbsent, 'absent purge canonical root before renamed phase', 0)
          assertCapturedFileState(purgeWal.quarantine, quarantineAbsent, 'absent purge quarantine before renamed phase', 0)
        } else {
          throw new Error('purge prepared authority lost both canonical and tombstone roots')
        }
        purgeEpoch.seal()
        purgeWal = writePurgeWal(paths, receipt!, host, transitionPurgeWal(purgeWal, 'renamed'), purgeWal)
        purgeEpoch.advanceWal(purgeWal)
      }

      if (purgeWal.phase === 'renamed') {
        const canonicalAbsent = captureFileState(paths.dataRoot, 0)
        const quarantineAbsent = captureFileState(purgeWal.quarantine, 0)
        if (canonicalAbsent.stat || quarantineAbsent.stat) {
          throw new Error('renamed purge authority has an invalid canonical/quarantine state')
        }
        await assertFullPurgeWalTree(
          purgeWal.tombstone,
          purgeWal,
          purgeEpoch,
          'purge renamed tombstone',
          initialWalTreeRoot && samePath(initialWalTreeRoot, purgeWal.tombstone, host.platform)
            ? initialWalTreeMetadata || undefined
            : undefined
        )
        assertPurgeQuiescent(paths, host, lifecycleLease.token, lifecycleLease.applicationOwner || undefined, purgeWal)
        assertCapturedFileState(paths.dataRoot, canonicalAbsent, 'absent purge canonical root before deleting phase', 0)
        assertCapturedFileState(purgeWal.quarantine, quarantineAbsent, 'absent purge quarantine before deleting phase', 0)
        purgeEpoch.seal()
        purgeWal = writePurgeWal(paths, receipt!, host, transitionPurgeWal(purgeWal, 'deleting'), purgeWal)
        purgeEpoch.advanceWal(purgeWal)
      }

      if (purgeWal.phase === 'deleting') {
        if (lstatOptional(paths.dataRoot)) throw new Error('purge canonical root reappeared during durable deletion')
        const tombstoneState = lstatOptional(purgeWal.tombstone)
        if (tombstoneState) {
          assertPurgeWalRootIdentity(purgeWal.tombstone, purgeWal, 'purge deleting tombstone')
          const frozen = materializePurgeWalEntries(purgeWal)
          const expectedHashes = new Map(
            purgeWal.entries.filter((entry) => entry.kind === 'file')
              .map((entry) => [entry.path, entry.sha256!])
          )
          await removeFrozenTree(
            purgeWal.tombstone,
            frozen,
            purgeEpoch,
            {
              allowPartial: true,
              expectedHashes,
              initialMetadata: initialDeletingMetadata || undefined
            }
          )
          purgeEpoch.advanceDeletingRootRemoval(purgeWal)
        } else if (lstatOptional(purgeWal.quarantine)) {
          throw new Error('purge delete quarantine remains without its frozen tombstone root')
        }
        await purgeEpoch()
        assertPurgeQuiescent(paths, host, lifecycleLease.token, lifecycleLease.applicationOwner || undefined, purgeWal)
        assertPurgeWalTerminalAbsence(paths, purgeWal)
        purgeEpoch.seal()
        purgeWal = writePurgeWal(paths, receipt!, host, transitionPurgeWal(purgeWal, 'deleted'), purgeWal)
        purgeEpoch.advanceWal(purgeWal)
      }

      if (purgeWal.phase !== 'deleted') throw new Error('purge WAL did not reach its deleted terminal phase')
      await purgeEpoch()
      assertPurgeWalTerminalAbsence(paths, purgeWal)
      assertLifecycleRootReceiptCurrentExact(host, receipt!)
      if (receipt!.state === 'inactive') {
        const handoff = purgingLifecycleRootReceipt(receipt!, purgeWal, host)
        purgeEpoch.seal()
        ensureLifecycleRootReceipt(host, handoff, [receipt!, handoff])
        assertLifecycleRootReceiptCurrentExact(host, handoff)
        purgeEpoch.advanceReceiptHandoff(handoff, purgeWal)
        receipt = handoff
      } else if (receipt!.state !== 'purging') {
        throw new Error('deleted purge WAL cannot hand off to a non-terminal receipt state')
      } else {
        validatePurgeWal(purgeWal as unknown as Record<string, unknown>, paths, receipt!, host)
      }
      purgeEpoch.seal()
      removePurgeWalExact(paths, receipt!, host, purgeWal)
      purgeEpoch.advanceWalRemoval(purgeWal)
    }

    assertPurgeReceiptCleanupOnlySafe(receipt!, paths)
    purgeEpoch.seal()
    removeLifecycleOwnerStageNamespaceAuthority(paths, receipt!, host)
    assertLifecycleRootReceiptCurrentExact(host, receipt!)
    purgeEpoch.advanceOwnerStageRemoval()
    purgeEpoch.seal()
    lifecycleLease.retireOwnerRecord()
    purgeEpoch.advanceOwnerRemoval()
    assertPurgeTerminalReceiptRemovalSafe(receipt!, paths, host)
    const terminalReceiptNamespace = readLifecycleRootReceiptNamespace(host)
    const terminalReceiptFence = captureDirectoryFence(terminalReceiptNamespace.directory)
    const terminalProtocolFence = captureDirectoryFence(dirname(paths.lifecycleLockPath))
    const sealTerminalReceiptEpoch = (receiptAbsent = false) => {
      lifecycleLease!.sealApplicationGate()
      preflightPurgeAuthorityPaths(paths, receipt!, null, host)
      assertDirectoryFence(terminalReceiptNamespace.directory, terminalReceiptFence)
      assertDirectoryFence(dirname(paths.lifecycleLockPath), terminalProtocolFence)
      assertPurgeReceiptCleanupOnlySafe(receipt!, paths)
      assertPurgeAlreadyAbsentWithoutReceipt(paths.dataRoot, host)
      const current = readLifecycleRootReceiptNamespace(host)
      if (current.directory !== terminalReceiptNamespace.directory
        || current.homeIdentity !== terminalReceiptNamespace.homeIdentity
        || current.pendingState || current.writingState
        || current.ownerStageAuthorityMarker || current.ownerStageNamespaceId
        || current.daemonStageAuthorityMarker || current.daemonStageNamespaceId) {
        throw new Error('purge terminal receipt namespace changed during durable removal')
      }
      assertCapturedFileState(
        join(current.directory, LIFECYCLE_ROOT_RECEIPT_NAMESPACE_MARKER),
        terminalReceiptNamespace.markerState!,
        'purge terminal receipt namespace marker',
        0
      )
      if (receiptAbsent) {
        assertCapturedFileState(
          current.file,
          { bytes: null, stat: null },
          'purge terminal receipt durable absence',
          LIFECYCLE_ROOT_RECEIPT_MAX_BYTES
        )
      } else {
        assertLifecycleRootReceiptNamespaceExact(
          host,
          terminalReceiptNamespace,
          'purge terminal receipt epoch'
        )
      }
      lifecycleLease!.sealApplicationGate()
    }
    sealTerminalReceiptEpoch()
    await lifecycleLease.revalidateApplicationGate()
    sealTerminalReceiptEpoch()
    assertApplicationQuiescent(paths.dataRoot, host, lifecycleLease.applicationOwner || undefined)
    sealTerminalReceiptEpoch()
    removeLifecycleRootReceiptWithDurableRetry(
      host,
      receipt!,
      terminalReceiptNamespace,
      sealTerminalReceiptEpoch
    )
    await lifecycleLease.releaseApplicationGate()
    return { ok: true, action: 'purge', mode, status: 'purged', plan, issues }
  } catch (error) {
    issues.push({ level: 'error', message: error instanceof Error ? error.message : String(error) })
    return { ok: false, action: 'purge', mode, status: 'failed', plan, issues }
  } finally {
    if (lifecycleLease) await lifecycleLease.release()
  }
}

export type PosixDaemonLaunchSpec = {
  command: string
  args: readonly [string, 'daemon', 'run']
  opts: {
    cwd: string
    env: NodeJS.ProcessEnv
  }
}

/** Pure launch description used by the POSIX lifecycle and cross-platform execution tests. */
export function createPosixDaemonLaunchSpec(
  paths: Pick<InstallPaths, 'nodePath' | 'cliPath' | 'packageRoot' | 'dataRoot' | 'port'>,
  baseEnvironment: NodeJS.ProcessEnv,
  daemonTrace?: DaemonTraceEnvironment,
  platform: NodeJS.Platform | string = 'linux'
): PosixDaemonLaunchSpec {
  if (platform === 'win32') {
    throw new Error('POSIX daemon launch spec cannot target win32')
  }
  if (daemonTrace && !localDataRootsEqual(daemonTrace.pinned.SKILL_GRAFT_HOME, paths.dataRoot, platform)) {
    throw new Error(`POSIX daemon trace root must identify selected data root ${paths.dataRoot}`)
  }
  const reviewedBaseEnvironment = daemonTrace
    ? Object.fromEntries(Object.entries(baseEnvironment).filter(([name]) => !/^(?:GIT_|DSH_)/i.test(name)))
    : { ...baseEnvironment }
  return {
    command: paths.nodePath,
    args: [paths.cliPath, 'daemon', 'run'],
    opts: {
      cwd: paths.packageRoot,
      env: {
        ...reviewedBaseEnvironment,
        ...(daemonTrace ? daemonTrace.pinned : {}),
        ...coherentDataRootEnvironment(paths.dataRoot, platform),
        HUB_API_PORT: String(paths.port),
        ...(daemonTrace ? {
          SKILL_GRAFT_INVOCATION_TRACE: '1',
          SKILL_GRAFT_REAL_E2E: '1',
          SKILL_GRAFT_RUN_ID: daemonTrace.runId,
          SKILL_GRAFT_E2E_ROOT: daemonTrace.runRoot
        } : {})
      }
    }
  }
}

function ensureDependencies(packageRoot: string, rebuild: boolean, host: InstallHost): SetupStep {
  try {
    const cli = join(packageRoot, 'dist', 'control', 'cli.js')
    if (!rebuild && fs.existsSync(cli)) {
      return { id: 'deps', ok: true, detail: `node ${process.version} (prebuilt)` }
    }
    const buildInputs = [
      join(packageRoot, 'scripts', 'clean-dist.mjs'),
      join(packageRoot, 'src'),
      join(packageRoot, 'tsconfig.json')
    ]
    if (buildInputs.some((target) => !fs.existsSync(target))) {
      return {
        id: 'deps',
        ok: false,
        detail: rebuild
          ? 'this prebuilt distribution cannot be rebuilt in place'
          : `prebuilt CLI is missing (${cli})`
      }
    }
    const modules = join(packageRoot, 'node_modules')
    if (!fs.existsSync(modules)) {
      const ran = host.runNpm(['install'], packageRoot)
      if (ran.status !== 0) return { id: 'deps', ok: false, detail: ran.stderr || ran.stdout || 'npm install failed' }
    }
    const ran = host.runNpm(['run', 'build'], packageRoot)
    if (ran.status !== 0) return { id: 'deps', ok: false, detail: ran.stderr || ran.stdout || 'npm run build failed' }
    return {
      id: 'deps',
      ok: true,
      detail: `node ${process.version}`
    }
  } catch (error) {
    return { id: 'deps', ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

function ensureLayout(dataRoot: string): SetupStep {
  try {
    const spec = layoutSpec(dataRoot, pathApi)
    for (const dir of spec.dirs) fs.mkdirSync(dir, { recursive: true })
    for (const file of spec.files) {
      if (!fs.existsSync(file.path)) {
        fs.mkdirSync(pathApi.dirname(file.path), { recursive: true })
        fs.writeFileSync(file.path, file.content, 'utf8')
      }
    }
    const missing = requiredDataAssets(dataRoot).filter((file) => !fs.existsSync(file))
    return missing.length > 0
      ? { id: 'layout', ok: false, detail: `required Hub assets are missing: ${missing.join(', ')}` }
      : { id: 'layout', ok: true, detail: 'hub directories ready' }
  } catch (error) {
    return { id: 'layout', ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

function resolveDaemonTraceEnvironment(
  environment: FrozenInstallEnvironment,
  platform: NodeJS.Platform | string,
  dataRoot: string
): DaemonTraceEnvironment | undefined {
  const gate = resolveLocalInvocationTraceGate(environment)
  if (!gate) return undefined

  const requiredPinnedValue = (name: string) => {
    const value = environment[name]
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`real E2E detached launcher requires ${name}`)
    }
    if (/[\0\r\n"]/.test(value)) {
      throw new Error(`real E2E detached launcher ${name} is unsafe for a cmd environment assignment`)
    }
    return value
  }
  const pinned: DaemonTraceEnvironment['pinned'] = {
    PATH: requiredPinnedValue('PATH'),
    DSH_HOME: requiredPinnedValue('DSH_HOME'),
    HOME: requiredPinnedValue('HOME'),
    XDG_CONFIG_HOME: requiredPinnedValue('XDG_CONFIG_HOME'),
    USERPROFILE: requiredPinnedValue('USERPROFILE'),
    APPDATA: requiredPinnedValue('APPDATA'),
    LOCALAPPDATA: requiredPinnedValue('LOCALAPPDATA'),
    TEMP: requiredPinnedValue('TEMP'),
    TMP: requiredPinnedValue('TMP'),
    HUB_SPAWN_CODEX: requiredPinnedValue('HUB_SPAWN_CODEX'),
    SKILL_GRAFT_HOME: requiredPinnedValue('SKILL_GRAFT_HOME'),
    GIT_CONFIG_GLOBAL: requiredPinnedValue('GIT_CONFIG_GLOBAL'),
    GIT_CONFIG_NOSYSTEM: requiredPinnedValue('GIT_CONFIG_NOSYSTEM'),
    GIT_OPTIONAL_LOCKS: requiredPinnedValue('GIT_OPTIONAL_LOCKS')
  }
  const expectedHome = join(gate.runRoot, 'home')
  for (const [name, expected] of [
    ['HOME', expectedHome],
    ['XDG_CONFIG_HOME', join(expectedHome, 'xdg-config')],
    ['USERPROFILE', expectedHome],
    ['APPDATA', join(expectedHome, 'appdata')],
    ['LOCALAPPDATA', join(expectedHome, 'localappdata')],
    ['TEMP', join(expectedHome, 'temp')],
    ['TMP', join(expectedHome, 'temp')],
    ['DSH_HOME', join(expectedHome, 'dsh-home')],
    ['SKILL_GRAFT_HOME', join(gate.runRoot, 'hub-data')]
  ] as const) {
    if (!samePath(pinned[name], expected, platform)) {
      throw new Error(`real E2E detached launcher ${name} must identify ${expected}`)
    }
  }
  if (!localDataRootsEqual(pinned.SKILL_GRAFT_HOME, dataRoot, platform)) {
    throw new Error(`real E2E detached launcher SKILL_GRAFT_HOME must identify selected data root ${dataRoot}`)
  }
  if (pinned.HUB_SPAWN_CODEX !== '0') {
    throw new Error('real E2E detached launcher requires HUB_SPAWN_CODEX=0')
  }
  const expectedGlobalConfig = platform === 'win32' ? 'NUL' : '/dev/null'
  const globalConfigMatches = platform === 'win32'
    ? pinned.GIT_CONFIG_GLOBAL.toLowerCase() === expectedGlobalConfig.toLowerCase()
    : pinned.GIT_CONFIG_GLOBAL === expectedGlobalConfig
  if (!globalConfigMatches
    || pinned.GIT_CONFIG_NOSYSTEM !== '1'
    || pinned.GIT_OPTIONAL_LOCKS !== '0') {
    throw new Error('real E2E detached launcher requires isolated Git config and GIT_OPTIONAL_LOCKS=0')
  }
  return { runId: gate.runId, runRoot: gate.runRoot, pinned }
}

function preflightDaemonTraceEnvironment(
  environment: FrozenInstallEnvironment,
  platform: NodeJS.Platform | string,
  dataRoot: string
): FrozenDaemonTracePreflight {
  const revalidatedDataRoot = resolveDataRootFromEnvironment(dataRoot, platform, environment, dataRoot)
  if (!localDataRootsEqual(revalidatedDataRoot, dataRoot, platform)) {
    throw new Error(`preflight data root must identify selected data root ${dataRoot}`)
  }
  const daemonTrace = resolveDaemonTraceEnvironment(environment, platform, dataRoot)
  if (!daemonTrace) return Object.freeze({ baseEnvironment: environment })
  const pinned = Object.freeze({ ...daemonTrace.pinned }) as DaemonTraceEnvironment['pinned']
  return Object.freeze({
    baseEnvironment: environment,
    daemonTrace: Object.freeze({ ...daemonTrace, pinned })
  })
}

function installPathsForLifecycleRootReceipt(
  packageRoot: string,
  host: InstallHost,
  receipt: LifecycleRootReceiptV1,
  environment: FrozenInstallEnvironment,
  resolveHostExtraShim: boolean
): InstallPaths {
  const boundEnvironment = Object.freeze({
    ...environment,
    [PRIMARY_DATA_ROOT_ENV]: receipt.dataRoot,
    [LEGACY_DATA_ROOT_ENV]: receipt.dataRoot,
    SG_INSTALL_DIR: receipt.installDir
  })
  return installPathsFor(packageRoot, host, receipt.dataRoot, boundEnvironment, { resolveHostExtraShim })
}

function setupSelectionExplicit(environment: FrozenInstallEnvironment, dataRoot?: string): boolean {
  return Boolean(dataRoot || environment[PRIMARY_DATA_ROOT_ENV] || environment[LEGACY_DATA_ROOT_ENV] || environment.SG_INSTALL_DIR)
}

function assertExplicitSelectionMatchesReceipt(
  requested: InstallPaths,
  receipt: LifecycleRootReceiptV1,
  host: InstallHost
): void {
  if (!samePath(requested.dataRoot, receipt.dataRoot, host.platform)
    || !samePath(requested.installDir, receipt.installDir, host.platform)) {
    throw new Error('explicit lifecycle selection differs from the preserved root receipt')
  }
}

function writeShims(
  paths: ReturnType<typeof installPathsFor>,
  tracePreflight: FrozenDaemonTracePreflight
): SetupStep {
  const rendered = renderShims(paths, tracePreflight.daemonTrace)
  fs.mkdirSync(paths.binDir, { recursive: true })
  fs.mkdirSync(paths.installDir, { recursive: true })
  fs.writeFileSync(paths.shimCmd, rendered.sgCmd, 'utf8')
  fs.writeFileSync(paths.shimAliasCmd, rendered.aliasCmd, 'utf8')
  fs.writeFileSync(paths.shimUnix, rendered.unix, 'utf8')
  writeDaemonLaunchers(paths, rendered)
  const manifest = JSON.parse(rendered.manifest) as Record<string, unknown>
  manifest.installedAt = new Date().toISOString()
  fs.writeFileSync(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  if (paths.extraShimCmd) fs.writeFileSync(paths.extraShimCmd, rendered.sgCmd, 'utf8')
  if (paths.extraShimAliasCmd) fs.writeFileSync(paths.extraShimAliasCmd, rendered.aliasCmd, 'utf8')
  return {
    id: 'shims',
    ok: fs.existsSync(paths.shimCmd),
    detail: `${PRODUCT_COMMAND} and ${PRODUCT_ALIAS} -> ${paths.cliPath}`
  }
}

function writeDaemonLaunchers(
  paths: ReturnType<typeof installPathsFor>,
  rendered = renderShims(paths)
) {
  fs.mkdirSync(paths.installDir, { recursive: true })
  fs.writeFileSync(paths.silentVbs, rendered.vbs, 'utf8')
  fs.writeFileSync(paths.runDaemonCmd, rendered.runDaemonCmd, 'utf8')
}

function applyPath(
  paths: ReturnType<typeof installPathsFor>,
  noPath: boolean,
  host: InstallHost
): SetupStep {
  if (noPath || host.skipPath) return { id: 'path', ok: true, skipped: true, detail: 'skipped' }
  if (host.platform !== 'win32') {
    const onPath = pathHasDir(process.env.PATH || '', paths.binDir, host.pathSep, host.caseInsensitive)
    return {
      id: 'path',
      ok: true,
      detail: onPath ? `${paths.binDir} already on PATH` : `wrote ${paths.binDir}; add it to PATH if sg is not found`
    }
  }
  const current = host.userPath()
  const merged = mergeUserPath(current, paths.binDir, host.pathSep, host.caseInsensitive)
  if (merged.changed) host.setUserPath(merged.path)
  return {
    id: 'path',
    ok: true,
    detail: merged.already ? `${paths.binDir} already on user PATH` : `prepended ${paths.binDir} to user PATH`
  }
}

function applyUserEnv(
  paths: ReturnType<typeof installPathsFor>,
  noPath: boolean,
  host: InstallHost,
  environment: FrozenInstallEnvironment
): SetupStep {
  if (noPath || host.skipPath || host.platform !== 'win32') {
    return { id: 'env', ok: true, skipped: true, detail: stepsEnvDetail(host) }
  }
  const existingPrimary = environment[PRIMARY_DATA_ROOT_ENV]
  const existingLegacy = environment[LEGACY_DATA_ROOT_ENV]
  const existingPort = environment.HUB_API_PORT
  if (existingPrimary !== paths.dataRoot) host.setUserEnv(PRIMARY_DATA_ROOT_ENV, paths.dataRoot)
  if (existingLegacy !== paths.dataRoot) host.setUserEnv(LEGACY_DATA_ROOT_ENV, paths.dataRoot)
  if (!existingPort) host.setUserEnv('HUB_API_PORT', String(paths.port))
  return {
    id: 'env',
    ok: true,
    detail: `${PRIMARY_DATA_ROOT_ENV}=${paths.dataRoot}; ${LEGACY_DATA_ROOT_ENV}=${paths.dataRoot}`
  }
}

function stepsEnvDetail(host: InstallHost) {
  return `node ${process.version}${host.skipPath ? ' (PATH skipped)' : ''}`
}

function applyTask(
  paths: ReturnType<typeof installPathsFor>,
  noTask: boolean,
  host: InstallHost
): SetupStep {
  if (noTask || host.skipTask) return { id: 'task', ok: true, skipped: true, detail: 'skipped' }
  if (host.platform !== 'win32') {
    return { id: 'task', ok: true, skipped: true, detail: 'logon task is Windows-only' }
  }
  host.registerLogonTask(paths.taskName, paths.silentVbs)
  const registered = host.taskExists(paths.taskName)
  return {
    id: 'task',
    ok: registered,
    detail: registered ? `${TASK_NAME} runs at logon (hidden)` : `failed to register ${TASK_NAME}`
  }
}

async function applyDaemon(
  paths: ReturnType<typeof installPathsFor>,
  noDaemon: boolean,
  host: InstallHost,
  tracePreflight: FrozenDaemonTracePreflight
): Promise<SetupStep> {
  if (noDaemon) return { id: 'daemon', ok: true, skipped: true, detail: 'skipped' }
  const started = await startDaemonDetachedAfterPreflight(paths, host, tracePreflight)
  return { id: 'daemon', ok: started.ok, detail: started.detail }
}

function removeIfExists(target: string | null) {
  if (!target) return
  if (fs.existsSync(target)) fs.unlinkSync(target)
}

function samePath(left: string, right: string, platform: NodeJS.Platform | string) {
  const a = left.replace(/[\\/]+$/, '')
  const b = right.replace(/[\\/]+$/, '')
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}
