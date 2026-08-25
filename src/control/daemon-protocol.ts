import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { TextDecoder } from 'node:util'

import { flushDirectory, readBoundedDescriptor } from '../adapters/durable-files.js'
import {
  PRODUCT_NAME,
  type DaemonLifecycleReceiptAuthoritySnapshot,
  type LifecycleRootReceiptV1
} from '../local/lifecycle/install-domain.js'

export const DAEMON_PROTOCOL_VERSION = 1 as const
export const DAEMON_INSTANCE_MAX_BYTES = 64 * 1024
export const DAEMON_STAGE_MANIFEST_MAX_BYTES = 64 * 1024
export const DAEMON_RECEIPT_NAMESPACE_MAX_ENTRIES = 6
export const DAEMON_STAGE_NAMESPACE_MAX_ENTRIES = 3
export const DAEMON_START_STAGE_PAYLOADS = Object.freeze([
  'daemon.pid',
  'api.pid',
  'daemon-heartbeat.json',
  'daemon-instance-v1.json',
  'stage-manifest-v1.json'
] as const)

const RECEIPT_DIRECTORY = '.skill-graft-lifecycle'
const RECEIPT_NAMESPACE_MARKER = '.namespace-v1.skill-graft.marker'
const RECEIPT_FILE = 'root-receipt-v1.json'
const RECEIPT_PENDING = 'root-receipt-v1.pending.json'
const UUID_PATTERN = '[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}'
const RECEIPT_WRITER_UUID_PATTERN = '[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}'
const RECEIPT_WRITER = new RegExp(
  `^\\.root-receipt-v1\\.[a-f0-9]{64}\\.${RECEIPT_WRITER_UUID_PATTERN}\\.[1-9][0-9]{0,15}\\.[a-f0-9]{64}\\.[1-9][0-9]{0,15}\\.writing$`
)
const OWNER_STAGE_AUTHORITY = new RegExp(`^\\.owner-stage-namespace-v1\\.(${UUID_PATTERN})\\.marker$`, 'i')
export const DAEMON_STAGE_AUTHORITY = new RegExp(`^\\.daemon-stage-namespace-v1\\.(${UUID_PATTERN})\\.marker$`)
export const DAEMON_STAGE_INNER_MARKER = new RegExp(`^\\.namespace-v1\\.(${UUID_PATTERN})\\.skill-graft\\.marker$`)
const RESERVATION = /^\.d1\.([a-f0-9]{32})\.([a-f0-9]{24})\.([a-f0-9]{32})\.([a-f0-9]{32})\.([a-f0-9]{32})\.([1-9][0-9]{0,15})\.([a-f0-9]{16})\.([1-9][0-9]{0,15})\.([stl])\.([a-f0-9]{12})\.([1-9][0-9]{0,15})\.r$/
const UUID = new RegExp(`^${UUID_PATTERN}$`)
const UUID_COMPACT = /^[a-f0-9]{32}$/
const SHA256 = /^sha256:[a-f0-9]{64}$/
const CANONICAL_DECIMAL = /^(?:0|[1-9][0-9]*)$/
const SAFE_PROCESS_IDENTITY = /^[A-Za-z0-9:._-]{1,512}$/
const utf8 = new TextDecoder('utf-8', { fatal: true })

export type DaemonProtocolKind =
  | 'ABSENT'
  | 'NAMESPACE-RECOVERABLE'
  | 'LEGACY-NAMESPACE-RECOVERABLE'
  | 'STARTING-PARTIAL'
  | 'STARTING'
  | 'RUNNING-LINKED'
  | 'RUNNING-COLLAPSING'
  | 'RUNNING-CLEAN'
  | 'STOPPING-PARTIAL'
  | 'STOPPING'
  | 'LEGACY-RETIRING-PARTIAL'
  | 'LEGACY-RETIRING'
  | 'LEGACY'
  | 'INVALID'

export type DaemonReservationOperation = 'start' | 'stop' | 'legacy-retire'
export type DaemonSha256 = `sha256:${string}`

export type DaemonFileState = Readonly<{
  dev: number
  ino: number
  size: number
  mtimeMs: number
  nlink: number
}>

export type DaemonCapturedFile = Readonly<{
  file: string
  bytes: Buffer
  sha256: DaemonSha256
  state: DaemonFileState
}>

export type DaemonFileIdentityV1 = Readonly<{
  sha256: DaemonSha256
  dev: string
  ino: string
  size: number
}>

export type DaemonProjectionIdentitiesV1 = Readonly<{
  pid: DaemonFileIdentityV1
  apiPid: DaemonFileIdentityV1
  heartbeat: DaemonFileIdentityV1
}>

export type DaemonOptionalProjectionIdentitiesV1 = Readonly<{
  pid: DaemonFileIdentityV1 | null
  apiPid: DaemonFileIdentityV1 | null
  heartbeat: DaemonFileIdentityV1 | null
}>

export type DaemonDirectoryIdentityV1 = Readonly<{
  dev: string
  ino: string
}>

export type DaemonProtocolRootIdentitiesV1 = Readonly<{
  dataRoot: DaemonDirectoryIdentityV1
  review: DaemonDirectoryIdentityV1
  stage: DaemonDirectoryIdentityV1
  reservation: DaemonDirectoryIdentityV1
}>

export type DaemonPersistentAuthorityV1 = Readonly<{
  homeIdentity: string
  receiptDirectory: DaemonDirectoryIdentityV1
  receiptInventory: readonly string[]
  receiptNamespaceMarker: DaemonFileIdentityV1
  receipt: DaemonFileIdentityV1
  ownerStageAuthority: DaemonFileIdentityV1 | null
  daemonStageAuthority: DaemonFileIdentityV1
  dataRoot: DaemonDirectoryIdentityV1
  review: DaemonDirectoryIdentityV1
  stage: DaemonDirectoryIdentityV1
  innerMarker: DaemonFileIdentityV1
}>

export type DaemonInstanceRecordV1 = Readonly<{
  schemaVersion: typeof DAEMON_PROTOCOL_VERSION
  product: typeof PRODUCT_NAME
  epochId: string
  stageNamespaceId: string
  receiptSha256: DaemonSha256
  installId: string
  dataRootId: string
  packageRoot: string
  packageVersion: string
  packageSha256: DaemonSha256
  dataRoot: string
  port: number
  pid: number
  apiPid: number
  processIdentity: string
  pgid: number
  createdAt: string
  projections: DaemonProjectionIdentitiesV1
  authority: DaemonPersistentAuthorityV1
}>

export type DaemonActorV1 = Readonly<{
  pid: number
  processIdentity: string
  pgid: number
  createdAt: string
}>

export type DaemonProcessTreeEntryV1 = Readonly<{
  pid: number
  processIdentity: string
}>

export type DaemonLifecycleOwnerBindingV1 = Readonly<{
  lockToken: string
  operation: 'setup' | 'upgrade' | 'uninstall' | 'recover' | 'purge'
  ownerRecord: DaemonFileIdentityV1
  ownerStageNamespaceId: string
  receiptSha256: DaemonSha256
  installId: string
  dataRootId: string
}>

export type DaemonStopTargetV1 = Readonly<{
  instance: DaemonFileIdentityV1
  projections: DaemonProjectionIdentitiesV1
  epochId: string
  pid: number
  apiPid: number
  processIdentity: string
  pgid: number
  port: number
  processTree: readonly DaemonProcessTreeEntryV1[]
}>

export type DaemonLegacyTargetV1 = Readonly<{
  projections: DaemonOptionalProjectionIdentitiesV1
  pid: number
  apiPid: number
  processIdentity: string
  pgid: number
  port: number
  processTree: readonly DaemonProcessTreeEntryV1[]
}>

type DaemonStageManifestCommonV1 = Readonly<{
  schemaVersion: typeof DAEMON_PROTOCOL_VERSION
  product: typeof PRODUCT_NAME
  reservationName: string
  stageNamespaceId: string
  receiptSha256: DaemonSha256
  installId: string
  dataRootId: string
  operationId: string
  packageRoot: string
  packageVersion: string
  packageSha256: DaemonSha256
  dataRoot: string
  actor: DaemonActorV1
  roots: DaemonProtocolRootIdentitiesV1
}>

export type DaemonStartStageManifestV1 = DaemonStageManifestCommonV1 & Readonly<{
  operation: 'start'
  instance: DaemonFileIdentityV1
  projections: DaemonProjectionIdentitiesV1
}>

export type DaemonStopStageManifestV1 = DaemonStageManifestCommonV1 & Readonly<{
  operation: 'stop'
  lifecycleOwnerBinding: DaemonLifecycleOwnerBindingV1 | null
  target: DaemonStopTargetV1
}>

export type DaemonLegacyRetireStageManifestV1 = DaemonStageManifestCommonV1 & Readonly<{
  operation: 'legacy-retire'
  lifecycleOwnerBinding: DaemonLifecycleOwnerBindingV1 | null
  target: DaemonLegacyTargetV1
}>

export type DaemonStageManifestV1 =
  | DaemonStartStageManifestV1
  | DaemonStopStageManifestV1
  | DaemonLegacyRetireStageManifestV1

export type DaemonReservationBinding = Readonly<{
  stageNamespaceId: string
  receiptSha256: DaemonSha256
  installId: string
  dataRootId: string
  operationId: string
  actorPid: number
  actorProcessIdentity: string
  actorPgid: number
  operation: DaemonReservationOperation
  packageSha256: DaemonSha256
  createdAt: string
}>

export type ParsedDaemonReservationName = Readonly<{
  name: string
  stageNamespaceId: string
  receiptSha24: string
  installId: string
  dataRootId: string
  operationId: string
  actorPid: number
  actorProcessIdentitySha16: string
  actorPgid: number
  operation: DaemonReservationOperation
  packageSha12: string
  createdAtMs: number
}>

export type DaemonProtocolPaths = Readonly<{
  home: string
  receiptDirectory: string
  receiptNamespaceMarker: string
  receiptFile: string
  receiptPending: string
  dataRoot: string
  stageDirectory: string
  reviewDirectory: string
  finalInstance: string
  pidProjection: string
  apiPidProjection: string
  heartbeatProjection: string
}>

export type DaemonReceiptNamespaceSnapshot = Readonly<{
  paths: DaemonProtocolPaths
  homeIdentity: string
  directoryState: DaemonFileState
  namespaceMarker: DaemonCapturedFile
  receipt: LifecycleRootReceiptV1
  receiptFile: DaemonCapturedFile
  receiptSha256: DaemonSha256
  ownerStageNamespaceId: string | null
  ownerStageAuthorityMarker: DaemonCapturedFile | null
  daemonStageNamespaceId: string | null
  daemonAuthorityMarker: DaemonCapturedFile | null
  entries: readonly string[]
}>

export type DaemonStageNamespaceAuthority = Readonly<{
  paths: DaemonProtocolPaths
  platform: string
  readReceiptAuthority: DaemonReceiptAuthorityReader
  receipt: DaemonReceiptNamespaceSnapshot
  namespaceId: string
  reservationName: string | null
  homeMarker: DaemonCapturedFile
  dataRootState: DaemonFileState
  dataParentState: DaemonFileState
  reviewDirectoryState: DaemonFileState | null
  stageDirectoryState: DaemonFileState
  innerMarker: DaemonCapturedFile
  ancestorIdentities: readonly DaemonCapturedDirectoryIdentity[]
  recoveredInspection: DaemonProtocolInspection | null
  recoveredInspectionScope: 'FULL' | 'EXTERNAL' | 'START'
}>

export type DaemonStartStage = Readonly<{
  authority: DaemonStageNamespaceAuthority
  binding: DaemonReservationBinding
  reservationName: string
  reservationDirectory: string
  instance: DaemonInstanceRecordV1
  manifest: DaemonStartStageManifestV1
  files: Readonly<{
    pid: DaemonCapturedFile
    apiPid: DaemonCapturedFile
    heartbeat: DaemonCapturedFile
    instance: DaemonCapturedFile
    manifest: DaemonCapturedFile
  }>
}>

export type DaemonCapturedDirectory = Readonly<{
  directory: string
  state: DaemonFileState
  entries: readonly Readonly<{ name: string; kind: 'file' | 'directory' }>[]
}>

export type DaemonCapturedDirectoryIdentity = Readonly<{
  directory: string
  state: DaemonFileState
}>

export type DaemonProtocolFrozenProof = Readonly<{
  platform: string
  readReceiptAuthority: DaemonReceiptAuthorityReader | null
  receipt: DaemonReceiptNamespaceSnapshot | null
  files: readonly DaemonCapturedFile[]
  directories: readonly DaemonCapturedDirectory[]
  directoryIdentities: readonly DaemonCapturedDirectoryIdentity[]
  absent: readonly string[]
}>

export type DaemonProtocolInspection = Readonly<{
  kind: DaemonProtocolKind
  reason: string | null
  paths: DaemonProtocolPaths
  namespaceId: string | null
  receipt: LifecycleRootReceiptV1 | null
  reservation: ParsedDaemonReservationName | null
  instance: DaemonInstanceRecordV1 | null
  manifest: DaemonStageManifestV1 | null
  publicProjectionCount: number
  stagePayloadCount: number
  recoveryAuthority: 'NONE' | 'START' | 'STOP' | 'LEGACY-RETIRE'
  proof: DaemonProtocolFrozenProof
}>

export type DaemonActionableControlInspection = DaemonProtocolInspection & Readonly<
  | { kind: 'STOPPING'; recoveryAuthority: 'STOP'; manifest: DaemonStopStageManifestV1 }
  | { kind: 'LEGACY-RETIRING'; recoveryAuthority: 'LEGACY-RETIRE'; manifest: DaemonLegacyRetireStageManifestV1 }
>

export function isDaemonActionableControlInspection(
  inspection: DaemonProtocolInspection
): inspection is DaemonActionableControlInspection {
  return inspection.kind === 'STOPPING' && inspection.recoveryAuthority === 'STOP'
    && inspection.manifest?.operation === 'stop'
    || inspection.kind === 'LEGACY-RETIRING' && inspection.recoveryAuthority === 'LEGACY-RETIRE'
      && inspection.manifest?.operation === 'legacy-retire'
}

export type DaemonLifecycleOwnerAuthoritySnapshot = Readonly<{
  lockToken: string
  operation: DaemonLifecycleOwnerBindingV1['operation']
  ownerStageNamespaceId: string
  receiptSha256: DaemonSha256
  installId: string
  dataRootId: string
  ownerRecord: DaemonCapturedFile
  files: readonly DaemonCapturedFile[]
  directories: readonly DaemonCapturedDirectory[]
}>

export type DaemonProtocolCheckpoint = (
  name: string,
  facts: Readonly<Record<string, string | number | boolean | null>>
) => void

export type DaemonMutationAuthoritySeal = (inFlight: DaemonCapturedFile | null) => void

export type DaemonStartActorProbeFacts =
  | Readonly<{ state: 'dead' }>
  | Readonly<{ state: 'alive'; processIdentity: string; pgid: number }>
  | Readonly<{ state: 'unknown' }>

export type DaemonStartActorProbe = (
  actor: Readonly<{ pid: number }>
) => DaemonStartActorProbeFacts

export type DaemonAbandonedStartCleanupAuthority = Readonly<{
  kind: 'ABANDONED-START-CLEANUP'
  disposition: 'dead' | 'pid-reused'
}>

export type DaemonCommittedStartCollapseAuthority = Readonly<{
  kind: 'COMMITTED-START-COLLAPSE'
}>

export type DaemonControlProcessFacts =
  | Readonly<{
    state: 'alive'
    pid: number
    processIdentity: string
    pgid: number
    processTree: readonly DaemonProcessTreeEntryV1[]
  }>
  | Readonly<{ state: 'dead'; pid: number }>
  | Readonly<{ state: 'unknown'; pid: number }>

export type DaemonControlListenerFacts =
  | Readonly<{ state: 'owned'; port: number; pid: number; processIdentity: string }>
  | Readonly<{ state: 'absent'; port: number }>
  | Readonly<{ state: 'foreign'; port: number; pid: number; processIdentity: string }>
  | Readonly<{ state: 'unknown'; port: number }>

export type DaemonControlTargetFacts = Readonly<{
  process: DaemonControlProcessFacts
  listener: DaemonControlListenerFacts
}>

export type CreateDaemonControlStageOptions = Readonly<{
  operationId: string
  actor: DaemonActorV1
  lifecycleOwnerBinding?: DaemonLifecycleOwnerBindingV1 | null
  targetFacts: DaemonControlTargetFacts
  checkpoint?: DaemonProtocolCheckpoint
}>

export type DaemonControlStage = Readonly<{
  kind: 'DAEMON-STOP-STAGE' | 'DAEMON-LEGACY-RETIRE-STAGE'
  reservationName: string
  reservationDirectory: string
  manifest: DaemonStopStageManifestV1 | DaemonLegacyRetireStageManifestV1
}>

export type DaemonControlSignalAuthority = Readonly<{
  kind: 'DAEMON-CONTROL-SIGNAL'
  operation: 'stop' | 'legacy-retire'
}>

export type DaemonControlSignalTarget = Readonly<{
  operation: 'stop' | 'legacy-retire'
  pid: number
  processIdentity: string
  pgid: number
  processTree: readonly DaemonProcessTreeEntryV1[]
}>

export type DaemonControlRetirementAuthority = Readonly<{
  kind: 'DAEMON-CONTROL-RETIREMENT'
  operation: 'stop' | 'legacy-retire'
  disposition: 'dead' | 'pid-reused'
}>

export type DaemonAbandonedControlStageCleanupAuthority = Readonly<{
  kind: 'ABANDONED-DAEMON-CONTROL-STAGE-CLEANUP'
  operation: 'stop' | 'legacy-retire'
  disposition: 'dead' | 'pid-reused'
}>

type DaemonStartPublicationSlot =
  | { phase: 'ABSENT' }
  | { phase: 'PENDING'; source: DaemonCapturedFile }
  | { phase: 'LINKED'; source: DaemonCapturedFile; target: DaemonCapturedFile }
  | { phase: 'PUBLISHED'; target: DaemonCapturedFile }

type DaemonStartPublicationEpoch = Record<'pid' | 'apiPid' | 'heartbeat' | 'final', DaemonStartPublicationSlot>

type DaemonPrivateStartStage = Readonly<{
  stage: DaemonStartStage
  publication: DaemonStartPublicationEpoch
  issuedView: DaemonStartStage
  issuedSignature: string
  issuedReceiptReader: DaemonStageNamespaceAuthority['readReceiptAuthority']
}>

const daemonPrivateStartStages = new WeakMap<object, DaemonPrivateStartStage>()

type DaemonDurableFileRemovalState = {
  expected: DaemonCapturedFile
  phase: 'PRESENT' | 'REMOVED' | 'DURABLE'
  parent: string
  parentState: DaemonFileState
  unlinkCheckpointComplete: boolean
  parentCheckpointComplete: boolean
}

type DaemonDurableDirectoryRemovalState = {
  expected: DaemonCapturedDirectory
  phase: 'PRESENT' | 'REMOVED' | 'DURABLE'
  parent: string
  parentState: DaemonFileState
  removeCheckpointComplete: boolean
  parentCheckpointComplete: boolean
}

type DaemonOwnedFileSlot = {
  path: string
  captured: DaemonCapturedFile | null
}

type DaemonStartMutationEpoch = {
  options: InspectDaemonProtocolOptions
  inspection: DaemonProtocolInspection
  mode: 'ABANDONED' | 'COLLAPSE'
  stageDirectory: DaemonCapturedDirectory
  reservationDirectory: DaemonCapturedDirectory
  reservationPresent: boolean
  reservationRemovalExpected: DaemonCapturedDirectory | null
  owned: Map<string, DaemonOwnedFileSlot>
  fileRemovalExpected: Map<string, DaemonCapturedFile>
  reviewBarrierComplete: boolean
  reservationBarrierComplete: boolean
}

const daemonDurableFileRemovals = new WeakMap<object, DaemonDurableFileRemovalState>()
const daemonDurableDirectoryRemovals = new WeakMap<object, DaemonDurableDirectoryRemovalState>()
const daemonAbandonedStartCleanupEpochs = new WeakMap<object, DaemonStartMutationEpoch>()
const daemonCommittedStartCollapseEpochs = new WeakMap<object, DaemonStartMutationEpoch>()

type DaemonPrivateControlStage = Readonly<{
  stage: DaemonControlStage
  issuedSignature: string
}>

type DaemonPrivateControlSignalAuthority = Readonly<{
  inspectionSignature: string
  target: DaemonControlSignalTarget
}>

type DaemonControlMutationEpoch = {
  options: InspectDaemonProtocolOptions
  inspection: DaemonProtocolInspection
  mode: 'RETIREMENT' | 'ABANDONED'
  operation: 'stop' | 'legacy-retire'
  stageDirectory: DaemonCapturedDirectory
  reservationDirectory: DaemonCapturedDirectory
  reservationPresent: boolean
  reservationRemovalExpected: DaemonCapturedDirectory | null
  owned: Map<string, DaemonOwnedFileSlot>
  fileRemovalExpected: Map<string, DaemonCapturedFile>
  reviewBarrierComplete: boolean
  reservationBarrierComplete: boolean
}

const daemonPrivateControlStages = new WeakMap<object, DaemonPrivateControlStage>()
const daemonPrivateControlSignalAuthorities = new WeakMap<object, DaemonPrivateControlSignalAuthority>()
const daemonControlRetirementEpochs = new WeakMap<object, DaemonControlMutationEpoch>()
const daemonAbandonedControlStageCleanupEpochs = new WeakMap<object, DaemonControlMutationEpoch>()

export type DaemonReceiptAuthorityReader = () => DaemonLifecycleReceiptAuthoritySnapshot
export type DaemonLifecycleOwnerAuthorityReader = (
  binding: DaemonLifecycleOwnerBindingV1
) => DaemonLifecycleOwnerAuthoritySnapshot

export type DaemonBootstrapOptions = Readonly<{
  home: string
  dataRoot: string
  platform?: string
  readReceiptAuthority: DaemonReceiptAuthorityReader
  expectedInspection: DaemonProtocolInspection
  expectedReceiptAuthority: DaemonReceiptNamespaceSnapshot
  namespaceId?: string
  checkpoint?: DaemonProtocolCheckpoint
}>

export type InspectDaemonProtocolOptions = Readonly<{
  home: string
  dataRoot: string
  platform?: string
  readReceiptAuthority: DaemonReceiptAuthorityReader
  readLifecycleOwnerAuthority?: DaemonLifecycleOwnerAuthorityReader
}>

export type CreateDaemonStartStageOptions = Readonly<{
  epochId: string
  pid: number
  apiPid: number
  processIdentity: string
  pgid: number
  port: number
  createdAt: string
  checkpoint?: DaemonProtocolCheckpoint
}>

function sha256(bytes: Buffer | string): DaemonSha256 {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function digestHex(value: DaemonSha256): string {
  if (!SHA256.test(value)) throw new Error('daemon digest is not canonical sha256')
  return value.slice('sha256:'.length)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function canonicalIso(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 20 || value.length > 32) return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value) || value !== value.toLowerCase()) {
    throw new Error(`${label} is not a canonical UUID`)
  }
  return value
}

function compactUuid(value: string): string {
  return uuid(value, 'daemon UUID').replaceAll('-', '')
}

function expandUuid(value: string): string {
  if (!UUID_COMPACT.test(value)) throw new Error('daemon compact UUID is invalid')
  return uuid(
    `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`,
    'daemon compact UUID'
  )
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`${label} is invalid`)
  return Number(value)
}

function portNumber(value: unknown): number {
  const port = positiveInteger(value, 'daemon port')
  if (port > 65_535) throw new Error('daemon port is invalid')
  return port
}

function boundedText(value: unknown, label: string, maximum = 32 * 1024): string {
  if (typeof value !== 'string' || !value || value !== value.trim()
    || Buffer.byteLength(value, 'utf8') > maximum || /[\u0000\r\n]/.test(value)) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function absolutePath(value: unknown, label: string): string {
  const candidate = boundedText(value, label)
  if (!isAbsolute(candidate)) throw new Error(`${label} is not absolute`)
  return resolve(candidate)
}

function operationCode(operation: DaemonReservationOperation): 's' | 't' | 'l' {
  if (operation === 'start') return 's'
  if (operation === 'stop') return 't'
  return 'l'
}

function operationFromCode(code: string): DaemonReservationOperation {
  if (code === 's') return 'start'
  if (code === 't') return 'stop'
  if (code === 'l') return 'legacy-retire'
  throw new Error('daemon reservation operation code is invalid')
}

function recordBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function canonicalDaemonJson(value: unknown): string {
  if (Buffer.isBuffer(value)) return JSON.stringify({ $buffer: value.toString('hex') })
  if (Array.isArray(value)) return `[${value.map((item) => canonicalDaemonJson(item)).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalDaemonJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function lstatOptional(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function fileState(stat: fs.Stats): DaemonFileState {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    nlink: stat.nlink
  }
}

function sameFileState(left: DaemonFileState, right: DaemonFileState): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.nlink === right.nlink
}

function samePath(left: string, right: string, platform: string = process.platform): boolean {
  const normalize = (value: string) => {
    const absolute = resolve(value)
    const normalized = absolute.replace(/[\\/]+$/, '') || absolute
    return platform === 'win32' || platform === 'darwin' ? normalized.toLowerCase() : normalized
  }
  return normalize(left) === normalize(right)
}

function assertPlainDirectory(directory: string, label: string): fs.Stats {
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} is not a plain directory`)
  const physical = fs.realpathSync.native(directory)
  if (!samePath(directory, physical)) throw new Error(`${label} crosses a reparse point`)
  return stat
}

function captureOptionalDirectoryState(directory: string, label: string): DaemonFileState | null {
  const stat = lstatOptional(directory)
  return stat ? fileState(assertPlainDirectory(directory, label)) : null
}

function assertOptionalDirectoryState(
  directory: string,
  expected: DaemonFileState | null,
  label: string
): void {
  const current = captureOptionalDirectoryState(directory, label)
  if (!expected && !current) return
  if (!expected || !current || !sameFileState(current, expected)) {
    throw new Error(`${label} changed after it was frozen`)
  }
}

function assertOptionalDirectoryIdentity(
  directory: string,
  expected: DaemonFileState | null,
  label: string
): void {
  const current = captureOptionalDirectoryState(directory, label)
  if (!expected && !current) return
  if (!expected || !current || current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new Error(`${label} identity changed after it was frozen`)
  }
}

function assertPlainAncestorChain(target: string, label: string): void {
  let cursor = resolve(target)
  for (;;) {
    const stat = lstatOptional(cursor)
    if (stat) {
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} has a non-plain ancestor: ${cursor}`)
      if (!samePath(cursor, fs.realpathSync.native(cursor))) throw new Error(`${label} crosses a reparse point: ${cursor}`)
    }
    const parent = dirname(cursor)
    if (parent === cursor) return
    cursor = parent
  }
}

function capturePlainAncestorIdentities(target: string, label: string): readonly DaemonCapturedDirectoryIdentity[] {
  const identities: DaemonCapturedDirectoryIdentity[] = []
  let current = lstatOptional(resolve(target)) ? resolve(target) : dirname(resolve(target))
  for (;;) {
    const stat = assertPlainDirectory(current, `${label} ancestor`)
    identities.push({ directory: current, state: fileState(stat) })
    const parent = dirname(current)
    if (samePath(parent, current)) break
    current = parent
  }
  return identities
}

function boundedEntries(directory: string, maximum: number, label: string): fs.Dirent[] {
  const handle = fs.opendirSync(directory)
  const entries: fs.Dirent[] = []
  try {
    for (;;) {
      const entry = handle.readSync()
      if (!entry) break
      if (entries.length >= maximum) throw new Error(`${label} exceeds its entry bound`)
      entries.push(entry)
    }
  } finally {
    handle.closeSync()
  }
  return entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)))
}

function captureDaemonDirectory(
  directory: string,
  maximumEntries: number,
  label: string
): DaemonCapturedDirectory {
  const before = assertPlainDirectory(directory, label)
  const entries = boundedEntries(directory, maximumEntries, label).map((entry) => {
    if (entry.isSymbolicLink() || !entry.isFile() && !entry.isDirectory()) {
      throw new Error(`${label} contains a non-plain entry: ${entry.name}`)
    }
    return { name: entry.name, kind: entry.isFile() ? 'file' as const : 'directory' as const }
  })
  const after = assertPlainDirectory(directory, label)
  if (!sameFileState(fileState(before), fileState(after))) throw new Error(`${label} changed during inventory capture`)
  return { directory, state: fileState(before), entries }
}

function assertDaemonDirectoryCurrent(expected: DaemonCapturedDirectory, label: string): void {
  const current = captureDaemonDirectory(expected.directory, expected.entries.length + 1, label)
  if (!sameFileState(current.state, expected.state)
    || current.entries.length !== expected.entries.length
    || current.entries.some((entry, index) => entry.name !== expected.entries[index].name
      || entry.kind !== expected.entries[index].kind)) {
    throw new Error(`${label} changed after it was frozen`)
  }
}

function uniqueByPath<T extends { file?: string; directory?: string }>(values: readonly T[]): readonly T[] {
  const result: T[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const candidate = resolve(value.file || value.directory || '')
    const key = process.platform === 'win32' ? candidate.toLowerCase() : candidate
    if (!seen.has(key)) {
      seen.add(key)
      result.push(value)
    }
  }
  return result
}

export function assertDaemonInspectionCurrent(inspection: DaemonProtocolInspection): void {
  if (inspection.kind === 'INVALID') {
    throw new Error(inspection.reason || 'invalid daemon protocol state has no mutation authority')
  }
  const proof = inspection.proof
  if (proof.receipt && proof.readReceiptAuthority) {
    assertDaemonReceiptNamespaceSnapshot(proof.receipt, proof.readReceiptAuthority, proof.platform)
  }
  for (const directory of proof.directories) {
    assertDaemonDirectoryCurrent(directory, `daemon ${inspection.kind} directory`)
  }
  for (const expected of proof.directoryIdentities) {
    const current = assertPlainDirectory(expected.directory, `daemon ${inspection.kind} authority root`)
    if (current.dev !== expected.state.dev || current.ino !== expected.state.ino) {
      throw new Error(`daemon ${inspection.kind} authority root identity changed`)
    }
  }
  for (const file of proof.files) {
    assertCapturedCurrent(file, `daemon ${inspection.kind} file`, [file.state.nlink])
  }
  for (const file of proof.absent) {
    if (lstatOptional(file)) throw new Error(`daemon ${inspection.kind} absent path reappeared: ${file}`)
  }
}

function assertDaemonInspectionExternalCurrent(
  inspection: DaemonProtocolInspection,
  ignoredPaths: readonly string[] = []
): void {
  const proof = inspection.proof
  const ignored = (file: string) => ignoredPaths.some((candidate) => samePath(candidate, file, proof.platform))
  if (proof.receipt && proof.readReceiptAuthority) {
    assertDaemonReceiptNamespaceSnapshot(proof.receipt, proof.readReceiptAuthority, proof.platform)
  }
  for (const expected of proof.directoryIdentities) {
    const current = assertPlainDirectory(expected.directory, `daemon ${inspection.kind} external authority root`)
    if (current.dev !== expected.state.dev || current.ino !== expected.state.ino) {
      throw new Error(`daemon ${inspection.kind} external authority root identity changed`)
    }
  }
  for (const file of proof.files) {
    if (ignored(file.file)) continue
    assertCapturedCurrent(file, `daemon ${inspection.kind} external file`, [file.state.nlink])
  }
  for (const file of proof.absent) {
    if (ignored(file)) continue
    if (lstatOptional(file)) throw new Error(`daemon ${inspection.kind} external absent path reappeared: ${file}`)
  }
}

export function daemonProtocolPaths(home: string, dataRoot: string): DaemonProtocolPaths {
  const absoluteHome = resolve(home)
  const absoluteRoot = resolve(dataRoot)
  const receiptDirectory = join(absoluteHome, RECEIPT_DIRECTORY)
  const reviewDirectory = join(absoluteRoot, 'skill-review')
  return {
    home: absoluteHome,
    receiptDirectory,
    receiptNamespaceMarker: join(receiptDirectory, RECEIPT_NAMESPACE_MARKER),
    receiptFile: join(receiptDirectory, RECEIPT_FILE),
    receiptPending: join(receiptDirectory, RECEIPT_PENDING),
    dataRoot: absoluteRoot,
    stageDirectory: `${absoluteRoot}.daemon-instance-stages`,
    reviewDirectory,
    finalInstance: join(reviewDirectory, 'daemon-instance-v1.json'),
    pidProjection: join(reviewDirectory, 'daemon.pid'),
    apiPidProjection: join(reviewDirectory, 'api.pid'),
    heartbeatProjection: join(reviewDirectory, 'daemon-heartbeat.json')
  }
}

export function daemonHomeAuthorityMarker(paths: DaemonProtocolPaths, namespaceId: string): string {
  return join(paths.receiptDirectory, `.daemon-stage-namespace-v1.${uuid(namespaceId, 'daemon namespace id')}.marker`)
}

export function daemonInnerNamespaceMarker(paths: DaemonProtocolPaths, namespaceId: string): string {
  return join(paths.stageDirectory, `.namespace-v1.${uuid(namespaceId, 'daemon namespace id')}.skill-graft.marker`)
}

export function daemonReservationName(binding: DaemonReservationBinding): string {
  const createdAt = canonicalIso(binding.createdAt) ? binding.createdAt : null
  if (!createdAt) throw new Error('daemon reservation timestamp is not canonical')
  const receipt = digestHex(binding.receiptSha256)
  const packageHash = digestHex(binding.packageSha256)
  const identity = boundedText(binding.actorProcessIdentity, 'daemon actor process identity', 512)
  if (!SAFE_PROCESS_IDENTITY.test(identity)) throw new Error('daemon process identity is not portable')
  const name = [
    '.d1',
    compactUuid(binding.stageNamespaceId),
    receipt.slice(0, 24),
    compactUuid(binding.installId),
    compactUuid(binding.dataRootId),
    compactUuid(binding.operationId),
    String(positiveInteger(binding.actorPid, 'daemon actor PID')),
    createHash('sha256').update(identity).digest('hex').slice(0, 16),
    String(positiveInteger(binding.actorPgid, 'daemon actor process group')),
    operationCode(binding.operation),
    packageHash.slice(0, 12),
    String(Date.parse(createdAt)),
    'r'
  ].join('.')
  if (Buffer.byteLength(name, 'utf8') > 240 || !RESERVATION.test(name)) {
    throw new Error('daemon reservation name exceeds its portable grammar')
  }
  return name
}

export function parseDaemonReservationName(name: string): ParsedDaemonReservationName | null {
  const match = RESERVATION.exec(name)
  if (!match) return null
  const actorPid = Number(match[6])
  const actorPgid = Number(match[8])
  const createdAtMs = Number(match[11])
  if (!Number.isSafeInteger(actorPid) || actorPid < 1 || !Number.isSafeInteger(actorPgid) || actorPgid < 1
    || !Number.isSafeInteger(createdAtMs) || createdAtMs < 1) {
    throw new Error('daemon reservation name contains an invalid numeric binding')
  }
  return {
    name,
    stageNamespaceId: expandUuid(match[1]),
    receiptSha24: match[2],
    installId: expandUuid(match[3]),
    dataRootId: expandUuid(match[4]),
    operationId: expandUuid(match[5]),
    actorPid,
    actorProcessIdentitySha16: match[7],
    actorPgid,
    operation: operationFromCode(match[9]),
    packageSha12: match[10],
    createdAtMs
  }
}

export function captureDaemonProtocolFile(
  file: string,
  maximumBytes: number,
  label: string,
  allowedLinks: readonly number[] = [1]
): DaemonCapturedFile {
  const before = fs.lstatSync(file)
  if (!before.isFile() || before.isSymbolicLink() || !allowedLinks.includes(before.nlink)
    || before.size > maximumBytes) {
    throw new Error(`${label} is not a bounded plain protocol file`)
  }
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow)
  try {
    const opened = fs.fstatSync(descriptor)
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs || opened.nlink !== before.nlink) {
      throw new Error(`${label} changed before its bounded read`)
    }
    // The shared bounded reader deliberately rejects a zero-byte limit. Empty
    // protocol markers still need a one-byte growth probe so a concurrent
    // writer cannot turn an empty authority into data between lstat and read.
    const bytes = readBoundedDescriptor(descriptor, Math.max(maximumBytes, 1), label)
    if (bytes.length > maximumBytes) throw new Error(`${label} exceeds its byte bound`)
    const after = fs.fstatSync(descriptor)
    const pathAfter = fs.lstatSync(file)
    const expected = fileState(opened)
    if (bytes.length !== opened.size || !sameFileState(fileState(after), expected)
      || !sameFileState(fileState(pathAfter), expected)) {
      throw new Error(`${label} changed during its bounded read`)
    }
    return { file, bytes, sha256: sha256(bytes), state: expected }
  } finally {
    fs.closeSync(descriptor)
  }
}

function optionalFile(
  file: string,
  maximumBytes: number,
  label: string,
  allowedLinks: readonly number[] = [1]
): DaemonCapturedFile | null {
  return lstatOptional(file) ? captureDaemonProtocolFile(file, maximumBytes, label, allowedLinks) : null
}

export function daemonFileIdentity(file: DaemonCapturedFile): DaemonFileIdentityV1 {
  return {
    sha256: file.sha256,
    dev: String(file.state.dev),
    ino: String(file.state.ino),
    size: file.state.size
  }
}

function validateFileIdentity(value: unknown, label: string): DaemonFileIdentityV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !exactKeys(value as Record<string, unknown>, ['sha256', 'dev', 'ino', 'size'])) {
    throw new Error(`${label} has an invalid file identity`)
  }
  const record = value as Record<string, unknown>
  if (typeof record.sha256 !== 'string' || !SHA256.test(record.sha256)
    || typeof record.dev !== 'string' || !CANONICAL_DECIMAL.test(record.dev)
    || typeof record.ino !== 'string' || !CANONICAL_DECIMAL.test(record.ino)
    || !Number.isSafeInteger(record.size) || Number(record.size) < 0 || Number(record.size) > DAEMON_INSTANCE_MAX_BYTES) {
    throw new Error(`${label} has an invalid file identity`)
  }
  return {
    sha256: record.sha256 as DaemonSha256,
    dev: record.dev,
    ino: record.ino,
    size: Number(record.size)
  }
}

function validateProjectionIdentities(value: unknown): DaemonProjectionIdentitiesV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !exactKeys(value as Record<string, unknown>, ['pid', 'apiPid', 'heartbeat'])) {
    throw new Error('daemon projection identity set is invalid')
  }
  const record = value as Record<string, unknown>
  return {
    pid: validateFileIdentity(record.pid, 'daemon PID projection'),
    apiPid: validateFileIdentity(record.apiPid, 'daemon API PID projection'),
    heartbeat: validateFileIdentity(record.heartbeat, 'daemon heartbeat projection')
  }
}

function validateOptionalProjectionIdentities(value: unknown): DaemonOptionalProjectionIdentitiesV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !exactKeys(value as Record<string, unknown>, ['pid', 'apiPid', 'heartbeat'])) {
    throw new Error('daemon optional projection identity set is invalid')
  }
  const record = value as Record<string, unknown>
  return {
    pid: record.pid === null ? null : validateFileIdentity(record.pid, 'legacy daemon PID projection'),
    apiPid: record.apiPid === null ? null : validateFileIdentity(record.apiPid, 'legacy daemon API PID projection'),
    heartbeat: record.heartbeat === null ? null
      : validateFileIdentity(record.heartbeat, 'legacy daemon heartbeat projection')
  }
}

function daemonDirectoryIdentity(stat: Pick<fs.Stats, 'dev' | 'ino'>): DaemonDirectoryIdentityV1 {
  return { dev: String(stat.dev), ino: String(stat.ino) }
}

function validateDirectoryIdentity(value: unknown, label: string): DaemonDirectoryIdentityV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !exactKeys(value as Record<string, unknown>, ['dev', 'ino'])) {
    throw new Error(`${label} has an invalid directory identity`)
  }
  const record = value as Record<string, unknown>
  if (typeof record.dev !== 'string' || !CANONICAL_DECIMAL.test(record.dev)
    || typeof record.ino !== 'string' || !CANONICAL_DECIMAL.test(record.ino)) {
    throw new Error(`${label} has an invalid directory identity`)
  }
  return { dev: record.dev, ino: record.ino }
}

function validateRootIdentities(value: unknown): DaemonProtocolRootIdentitiesV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !exactKeys(value as Record<string, unknown>, ['dataRoot', 'review', 'stage', 'reservation'])) {
    throw new Error('daemon stage root identities are invalid')
  }
  const record = value as Record<string, unknown>
  return {
    dataRoot: validateDirectoryIdentity(record.dataRoot, 'daemon data-root identity'),
    review: validateDirectoryIdentity(record.review, 'daemon review-directory identity'),
    stage: validateDirectoryIdentity(record.stage, 'daemon stage-directory identity'),
    reservation: validateDirectoryIdentity(record.reservation, 'daemon reservation-directory identity')
  }
}

function validateReceiptInventory(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 3 || value.length > DAEMON_RECEIPT_NAMESPACE_MAX_ENTRIES
    || value.some((entry) => typeof entry !== 'string' || !entry || Buffer.byteLength(entry, 'utf8') > 240
      || /[\\/\u0000-\u001f\u007f]/.test(entry))) {
    throw new Error('daemon persistent receipt inventory is invalid')
  }
  const normalized = value.map(String)
  const sorted = [...normalized].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
  if (new Set(normalized).size !== normalized.length
    || normalized.some((entry, index) => entry !== sorted[index])) {
    throw new Error('daemon persistent receipt inventory is not canonical')
  }
  return normalized
}

function validatePersistentAuthority(value: unknown): DaemonPersistentAuthorityV1 {
  const keys = [
    'homeIdentity', 'receiptDirectory', 'receiptInventory', 'receiptNamespaceMarker', 'receipt',
    'ownerStageAuthority', 'daemonStageAuthority', 'dataRoot', 'review', 'stage', 'innerMarker'
  ]
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !exactKeys(value as Record<string, unknown>, keys)) {
    throw new Error('daemon persistent authority keys are invalid')
  }
  const record = value as Record<string, unknown>
  if (typeof record.homeIdentity !== 'string' || !/^[a-f0-9]{64}$/.test(record.homeIdentity)) {
    throw new Error('daemon HOME identity is invalid')
  }
  return {
    homeIdentity: record.homeIdentity,
    receiptDirectory: validateDirectoryIdentity(record.receiptDirectory, 'daemon receipt-directory identity'),
    receiptInventory: validateReceiptInventory(record.receiptInventory),
    receiptNamespaceMarker: validateFileIdentity(record.receiptNamespaceMarker, 'daemon receipt namespace marker'),
    receipt: validateFileIdentity(record.receipt, 'daemon lifecycle receipt'),
    ownerStageAuthority: record.ownerStageAuthority === null ? null
      : validateFileIdentity(record.ownerStageAuthority, 'daemon owner-stage authority'),
    daemonStageAuthority: validateFileIdentity(record.daemonStageAuthority, 'daemon HOME stage authority'),
    dataRoot: validateDirectoryIdentity(record.dataRoot, 'daemon persistent data-root identity'),
    review: validateDirectoryIdentity(record.review, 'daemon persistent review-directory identity'),
    stage: validateDirectoryIdentity(record.stage, 'daemon persistent stage-directory identity'),
    innerMarker: validateFileIdentity(record.innerMarker, 'daemon inner namespace marker')
  }
}

function validateInstanceAuthorityConsistency(
  common: ReturnType<typeof normalizeCommonRecord>,
  authority: DaemonPersistentAuthorityV1
): void {
  const emptySha = sha256(Buffer.alloc(0))
  for (const [identity, label] of [
    [authority.receiptNamespaceMarker, 'receipt namespace marker'],
    [authority.daemonStageAuthority, 'daemon HOME stage marker'],
    [authority.innerMarker, 'daemon inner stage marker'],
    ...(authority.ownerStageAuthority
      ? [[authority.ownerStageAuthority, 'owner-stage authority marker'] as const]
      : [])
  ] as const) {
    if (identity.size !== 0 || identity.sha256 !== emptySha) {
      throw new Error(`daemon ${label} identity is not canonical empty authority`)
    }
  }
  if (authority.receipt.sha256 !== common.receiptSha256
    || authority.dataRoot.dev !== authority.review.dev || authority.dataRoot.dev !== authority.stage.dev) {
    throw new Error('daemon instance persistent authority is internally inconsistent')
  }
  const daemonMarker = `.daemon-stage-namespace-v1.${common.stageNamespaceId}.marker`
  const ownerMarkers = authority.receiptInventory.filter((entry) => OWNER_STAGE_AUTHORITY.test(entry))
  const expected = [RECEIPT_NAMESPACE_MARKER, RECEIPT_FILE, daemonMarker, ...ownerMarkers]
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
  if (ownerMarkers.length > 1 || Boolean(authority.ownerStageAuthority) !== (ownerMarkers.length === 1)
    || authority.receiptInventory.length !== expected.length
    || authority.receiptInventory.some((entry, index) => entry !== expected[index])) {
    throw new Error('daemon instance receipt inventory does not match its persistent marker authority')
  }
}

function assertIdentityMatches(identity: DaemonFileIdentityV1, file: DaemonCapturedFile, label: string): void {
  if (identity.sha256 !== file.sha256 || identity.dev !== String(file.state.dev)
    || identity.ino !== String(file.state.ino) || identity.size !== file.state.size) {
    throw new Error(`${label} does not match its immutable file identity`)
  }
}

function capturedLifecycleAuthorityFile(
  file: string,
  expected: { bytes: Buffer | null; stat: DaemonFileState | null },
  maximumBytes: number,
  label: string
): DaemonCapturedFile {
  if (!expected.bytes || !expected.stat) throw new Error(`${label} is absent from lifecycle authority`)
  const captured = captureDaemonProtocolFile(file, maximumBytes, label, [expected.stat.nlink])
  if (!captured.bytes.equals(expected.bytes) || !sameFileState(captured.state, expected.stat)) {
    throw new Error(`${label} changed after lifecycle authority validation`)
  }
  return captured
}

export function inspectDaemonReceiptNamespace(
  home: string,
  dataRoot: string,
  readReceiptAuthority: DaemonReceiptAuthorityReader,
  platform: string = process.platform
): DaemonReceiptNamespaceSnapshot {
  const paths = daemonProtocolPaths(home, dataRoot)
  const authority: DaemonLifecycleReceiptAuthoritySnapshot = readReceiptAuthority()
  if (!samePath(authority.home, paths.home, platform) || !samePath(authority.directory, paths.receiptDirectory, platform)
    || authority.entries.length > DAEMON_RECEIPT_NAMESPACE_MAX_ENTRIES) {
    throw new Error('daemon lifecycle receipt authority names another namespace')
  }
  const directoryStat = assertPlainDirectory(paths.receiptDirectory, 'daemon receipt namespace')
  const directoryState = fileState(directoryStat)
  if (!sameFileState(directoryState, authority.directoryState)) {
    throw new Error('daemon receipt namespace identity changed after lifecycle validation')
  }
  const entries = boundedEntries(paths.receiptDirectory, DAEMON_RECEIPT_NAMESPACE_MAX_ENTRIES, 'daemon receipt namespace')
  if (entries.length !== authority.entries.length
    || entries.some((entry, index) => entry.name !== authority.entries[index])) {
    throw new Error('daemon receipt namespace inventory changed after lifecycle validation')
  }
  const namespaceMarker = capturedLifecycleAuthorityFile(
    authority.namespaceMarker, authority.namespaceMarkerState, 0, 'daemon receipt namespace marker'
  )
  const receiptFile = capturedLifecycleAuthorityFile(
    authority.receiptFile, authority.receiptState, DAEMON_INSTANCE_MAX_BYTES, 'daemon active lifecycle receipt'
  )
  const ownerStageAuthorityMarker = authority.ownerStageAuthorityMarker && authority.ownerStageAuthorityMarkerState
    ? capturedLifecycleAuthorityFile(
      authority.ownerStageAuthorityMarker,
      authority.ownerStageAuthorityMarkerState,
      0,
      'daemon receipt owner-stage authority'
    )
    : null
  const daemonAuthorityMarker = authority.daemonStageAuthorityMarker && authority.daemonStageAuthorityMarkerState
    ? capturedLifecycleAuthorityFile(
      authority.daemonStageAuthorityMarker,
      authority.daemonStageAuthorityMarkerState,
      0,
      'daemon HOME stage authority'
    )
    : null
  return {
    paths,
    homeIdentity: authority.homeIdentity,
    directoryState,
    namespaceMarker,
    receipt: authority.receipt,
    receiptFile,
    receiptSha256: receiptFile.sha256,
    ownerStageNamespaceId: authority.ownerStageNamespaceId,
    ownerStageAuthorityMarker,
    daemonStageNamespaceId: authority.daemonStageNamespaceId,
    daemonAuthorityMarker,
    entries: entries.map((entry) => entry.name)
  }
}

function assertCapturedCurrent(expected: DaemonCapturedFile, label: string, allowedLinks = [expected.state.nlink]): void {
  const current = captureDaemonProtocolFile(expected.file, Math.max(expected.bytes.length, 1), label, allowedLinks)
  if (!current.bytes.equals(expected.bytes) || current.sha256 !== expected.sha256
    || !sameFileState(current.state, expected.state)) {
    throw new Error(`${label} changed after it was frozen`)
  }
}

export function writeDaemonFileExclusiveDurable(
  file: string,
  bytes: Buffer,
  maximumBytes: number,
  label: string,
  checkpoint: DaemonProtocolCheckpoint = () => {},
  sealAuthority: DaemonMutationAuthoritySeal = () => {}
): DaemonCapturedFile {
  if (bytes.length > maximumBytes) throw new Error(`${label} exceeds its byte bound`)
  const parent = dirname(file)
  const parentStat = assertPlainDirectory(parent, `${label} parent`)
  if (lstatOptional(file)) throw new Error(`${label} already exists`)
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0
  sealAuthority(null)
  const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600)
  const created = fs.fstatSync(descriptor)
  const assertCreatedPath = (expectedSize: number) => {
    const opened = fs.fstatSync(descriptor)
    const visible = fs.lstatSync(file)
    if (!opened.isFile() || opened.dev !== created.dev || opened.ino !== created.ino || opened.nlink !== 1
      || opened.size !== expectedSize || visible.dev !== created.dev || visible.ino !== created.ino
      || visible.nlink !== 1 || visible.size !== expectedSize || visible.isSymbolicLink()) {
      throw new Error(`${label} exclusive inode changed during publication`)
    }
  }
  try {
    assertCreatedPath(0)
    checkpoint('daemon-exclusive-created', { label, file })
    assertCreatedPath(0)
    sealAuthority(captureDaemonProtocolFile(file, 0, `${label} in-flight empty file`))
    let offset = 0
    while (offset < bytes.length) {
      const written = fs.writeSync(descriptor, bytes, offset, bytes.length - offset, offset)
      if (written < 1) throw new Error(`${label} write made no progress`)
      offset += written
    }
    checkpoint('daemon-file-written', { label, file, bytes: bytes.length })
    assertCreatedPath(bytes.length)
    sealAuthority(captureDaemonProtocolFile(file, maximumBytes, `${label} in-flight written file`))
    fs.fsyncSync(descriptor)
    checkpoint('daemon-file-fsynced', { label, file })
    assertCreatedPath(bytes.length)
    sealAuthority(captureDaemonProtocolFile(file, maximumBytes, `${label} in-flight fsynced file`))
  } finally {
    fs.closeSync(descriptor)
  }
  const captured = captureDaemonProtocolFile(file, maximumBytes, label)
  if (!captured.bytes.equals(bytes) || captured.state.nlink !== 1
    || captured.state.dev !== created.dev || captured.state.ino !== created.ino) {
    throw new Error(`${label} failed exact readback`)
  }
  checkpoint('daemon-file-readback', { label, file })
  assertCapturedCurrent(captured, `${label} post-readback`)
  sealAuthority(captured)
  const parentCurrent = assertPlainDirectory(parent, `${label} parent`)
  if (parentCurrent.dev !== parentStat.dev || parentCurrent.ino !== parentStat.ino) {
    throw new Error(`${label} parent changed before durability flush`)
  }
  flushDirectory(parent)
  checkpoint('daemon-parent-fsynced', { label, file })
  assertCapturedCurrent(captured, `${label} durable readback`)
  sealAuthority(captured)
  return captured
}

export function linkDaemonFileNoReplaceDurable(
  source: DaemonCapturedFile,
  target: string,
  label: string,
  checkpoint: DaemonProtocolCheckpoint = () => {},
  sealAuthority: DaemonMutationAuthoritySeal = () => {}
): DaemonCapturedFile {
  sealAuthority(null)
  assertCapturedCurrent(source, `${label} source`, [1])
  if (lstatOptional(target)) throw new Error(`${label} target already exists`)
  const parent = dirname(target)
  const parentStat = assertPlainDirectory(parent, `${label} target parent`)
  fs.linkSync(source.file, target)
  const assertOriginalPair = () => {
    const sourceStat = fs.lstatSync(source.file)
    const targetStat = fs.lstatSync(target)
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || !targetStat.isFile() || targetStat.isSymbolicLink()
      || sourceStat.dev !== source.state.dev || sourceStat.ino !== source.state.ino
      || targetStat.dev !== source.state.dev || targetStat.ino !== source.state.ino
      || sourceStat.nlink !== 2 || targetStat.nlink !== 2) {
      throw new Error(`${label} hardlink pair no longer names the frozen source inode`)
    }
  }
  assertOriginalPair()
  sealAuthority(captureDaemonProtocolFile(target, Math.max(source.bytes.length, 1), `${label} in-flight target`, [2]))
  checkpoint('daemon-hardlink-created', { label, source: source.file, target })
  assertOriginalPair()
  sealAuthority(captureDaemonProtocolFile(target, Math.max(source.bytes.length, 1), `${label} checkpointed target`, [2]))
  flushDirectory(parent)
  checkpoint('daemon-hardlink-parent-fsynced', { label, target })
  assertOriginalPair()
  sealAuthority(captureDaemonProtocolFile(target, Math.max(source.bytes.length, 1), `${label} durable target`, [2]))
  const linkedSource = captureDaemonProtocolFile(source.file, Math.max(source.bytes.length, 1), `${label} linked source`, [2])
  const linkedTarget = captureDaemonProtocolFile(target, Math.max(source.bytes.length, 1), `${label} linked target`, [2])
  if (linkedSource.state.dev !== source.state.dev || linkedSource.state.ino !== source.state.ino
    || linkedTarget.state.dev !== source.state.dev || linkedTarget.state.ino !== source.state.ino
    || !linkedTarget.bytes.equals(source.bytes) || linkedTarget.sha256 !== source.sha256
    || fs.lstatSync(parent).dev !== parentStat.dev || fs.lstatSync(parent).ino !== parentStat.ino) {
    throw new Error(`${label} hardlink publication failed its exact topology seal`)
  }
  return linkedTarget
}

export function unlinkDaemonFileExactDurable(
  expected: DaemonCapturedFile,
  label: string,
  checkpoint: DaemonProtocolCheckpoint = () => {},
  sealAuthority: DaemonMutationAuthoritySeal = () => {},
  advanceAfterUnlink: () => void = () => {}
): void {
  let state = daemonDurableFileRemovals.get(expected)
  if (!state) {
    const frozenExpected = cloneDaemonCapturedFile(expected)
    sealAuthority(cloneDaemonCapturedFile(frozenExpected))
    assertCapturedCurrent(frozenExpected, label)
    const parent = dirname(frozenExpected.file)
    const parentState = fileState(assertPlainDirectory(parent, `${label} parent`))
    state = {
      expected: frozenExpected,
      phase: 'PRESENT',
      parent,
      parentState,
      unlinkCheckpointComplete: false,
      parentCheckpointComplete: false
    }
    daemonDurableFileRemovals.set(expected, state)
  }
  const frozenExpected = state.expected
  const assertParentIdentity = () => {
    const parent = assertPlainDirectory(state!.parent, `${label} parent`)
    if (parent.dev !== state!.parentState.dev || parent.ino !== state!.parentState.ino) {
      throw new Error(`${label} parent changed during exact unlink`)
    }
  }
  if (state.phase === 'PRESENT') {
    sealAuthority(cloneDaemonCapturedFile(frozenExpected))
    assertCapturedCurrent(frozenExpected, label)
    assertParentIdentity()
    fs.unlinkSync(frozenExpected.file)
    state.phase = 'REMOVED'
  }
  if (state.phase === 'REMOVED') {
    if (lstatOptional(frozenExpected.file)) throw new Error(`${label} reappeared after exact unlink`)
    advanceAfterUnlink()
    sealAuthority(null)
    if (!state.unlinkCheckpointComplete) {
      checkpoint('daemon-file-unlinked', { label, file: frozenExpected.file })
      state.unlinkCheckpointComplete = true
    }
    if (lstatOptional(frozenExpected.file)) throw new Error(`${label} reappeared before parent durability flush`)
    advanceAfterUnlink()
    sealAuthority(null)
    assertParentIdentity()
    flushDirectory(state.parent)
    if (!state.parentCheckpointComplete) {
      checkpoint('daemon-unlink-parent-fsynced', { label, file: frozenExpected.file })
      state.parentCheckpointComplete = true
    }
    if (lstatOptional(frozenExpected.file)) throw new Error(`${label} reappeared after exact unlink`)
    assertParentIdentity()
    advanceAfterUnlink()
    sealAuthority(null)
    state.phase = 'DURABLE'
    return
  }
  if (lstatOptional(frozenExpected.file)) throw new Error(`${label} reappeared after durable unlink`)
  assertParentIdentity()
  advanceAfterUnlink()
  sealAuthority(null)
}

export function removeDaemonDirectoryExactDurable(
  expected: DaemonCapturedDirectory,
  label: string,
  checkpoint: DaemonProtocolCheckpoint = () => {},
  sealAuthority: () => void = () => {},
  advanceAfterRemove: () => void = () => {}
): void {
  let state = daemonDurableDirectoryRemovals.get(expected)
  if (!state) {
    const frozenExpected = cloneDaemonCapturedDirectory(expected)
    if (frozenExpected.entries.length !== 0) throw new Error(`${label} is not an exact empty directory`)
    sealAuthority()
    assertDaemonDirectoryCurrent(frozenExpected, label)
    const parent = dirname(frozenExpected.directory)
    const parentState = fileState(assertPlainDirectory(parent, `${label} parent`))
    state = {
      expected: frozenExpected,
      phase: 'PRESENT',
      parent,
      parentState,
      removeCheckpointComplete: false,
      parentCheckpointComplete: false
    }
    daemonDurableDirectoryRemovals.set(expected, state)
  }
  const frozenExpected = state.expected
  const assertParentIdentity = () => {
    const parent = assertPlainDirectory(state!.parent, `${label} parent`)
    if (parent.dev !== state!.parentState.dev || parent.ino !== state!.parentState.ino) {
      throw new Error(`${label} parent changed during exact directory removal`)
    }
  }
  if (state.phase === 'PRESENT') {
    sealAuthority()
    assertDaemonDirectoryCurrent(frozenExpected, label)
    assertParentIdentity()
    fs.rmdirSync(frozenExpected.directory)
    state.phase = 'REMOVED'
  }
  if (state.phase === 'REMOVED') {
    if (lstatOptional(frozenExpected.directory)) throw new Error(`${label} reappeared after exact directory removal`)
    advanceAfterRemove()
    sealAuthority()
    if (!state.removeCheckpointComplete) {
      checkpoint('daemon-directory-removed', { label, directory: frozenExpected.directory })
      state.removeCheckpointComplete = true
    }
    if (lstatOptional(frozenExpected.directory)) throw new Error(`${label} reappeared before parent durability flush`)
    advanceAfterRemove()
    sealAuthority()
    assertParentIdentity()
    flushDirectory(state.parent)
    if (!state.parentCheckpointComplete) {
      checkpoint('daemon-directory-parent-fsynced', { label, directory: frozenExpected.directory })
      state.parentCheckpointComplete = true
    }
    if (lstatOptional(frozenExpected.directory)) throw new Error(`${label} reappeared after durable directory removal`)
    assertParentIdentity()
    advanceAfterRemove()
    sealAuthority()
    state.phase = 'DURABLE'
    return
  }
  if (lstatOptional(frozenExpected.directory)) throw new Error(`${label} reappeared after durable directory removal`)
  assertParentIdentity()
  advanceAfterRemove()
  sealAuthority()
}

function ensureExistingEmptyMarker(file: string, label: string): DaemonCapturedFile {
  const marker = captureDaemonProtocolFile(file, 0, label)
  if (marker.state.nlink !== 1 || marker.state.size !== 0) throw new Error(`${label} is not unique and empty`)
  const descriptor = fs.openSync(file, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0))
  try {
    const opened = fs.fstatSync(descriptor)
    if (opened.dev !== marker.state.dev || opened.ino !== marker.state.ino || opened.nlink !== 1 || opened.size !== 0) {
      throw new Error(`${label} changed before recovery fsync`)
    }
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  flushDirectory(dirname(file))
  assertCapturedCurrent(marker, `${label} recovered`)
  return marker
}

export function bootstrapDaemonStageNamespace(options: DaemonBootstrapOptions): DaemonStageNamespaceAuthority {
  const checkpoint = options.checkpoint || (() => {})
  const platform = options.platform || process.platform
  const expectedInspection = options.expectedInspection
  if (!samePath(expectedInspection.paths.home, options.home, platform)
    || !samePath(expectedInspection.paths.dataRoot, options.dataRoot, platform)
    || expectedInspection.kind !== 'ABSENT' && expectedInspection.kind !== 'LEGACY'
      && expectedInspection.kind !== 'NAMESPACE-RECOVERABLE'
      && expectedInspection.kind !== 'LEGACY-NAMESPACE-RECOVERABLE') {
    throw new Error('daemon bootstrap requires an absent or namespace-recoverable frozen inspection')
  }
  assertDaemonInspectionCurrent(expectedInspection)
  const expectedReceipt = options.expectedReceiptAuthority
  if (!samePath(expectedReceipt.paths.home, options.home, platform)
    || !samePath(expectedReceipt.paths.dataRoot, options.dataRoot, platform)) {
    throw new Error('daemon bootstrap receipt authority belongs to another namespace')
  }
  assertDaemonReceiptNamespaceSnapshot(expectedReceipt, options.readReceiptAuthority, platform)
  if (expectedInspection.receipt
    && (expectedInspection.receipt.installId !== expectedReceipt.receipt.installId
      || expectedInspection.receipt.dataRootId !== expectedReceipt.receipt.dataRootId
      || expectedInspection.namespaceId !== expectedReceipt.daemonStageNamespaceId)) {
    throw new Error('daemon bootstrap inspection and receipt authority disagree')
  }
  const fixedProtocolPaths = [
    expectedInspection.paths.finalInstance,
    expectedInspection.paths.pidProjection,
    expectedInspection.paths.apiPidProjection,
    expectedInspection.paths.heartbeatProjection
  ]
  const fixedProtocolEpoch = fixedProtocolPaths.map((file) => {
    const captured = expectedInspection.proof.files.find((candidate) => samePath(candidate.file, file, platform)) || null
    const absent = expectedInspection.proof.absent.some((candidate) => samePath(candidate, file, platform))
    if (!captured && !absent) throw new Error(`daemon bootstrap inspection did not freeze fixed path: ${file}`)
    return { file, captured }
  })
  const assertFixedProtocolEpoch = () => {
    for (const expected of fixedProtocolEpoch) {
      if (expected.captured) assertCapturedCurrent(expected.captured, 'daemon bootstrap fixed protocol file')
      else if (lstatOptional(expected.file)) throw new Error(`daemon bootstrap fixed path appeared: ${expected.file}`)
    }
    for (const expected of expectedInspection.proof.directoryIdentities) {
      const current = assertPlainDirectory(expected.directory, 'daemon bootstrap preflight ancestor')
      if (current.dev !== expected.state.dev || current.ino !== expected.state.ino) {
        throw new Error('daemon bootstrap preflight root identity changed')
      }
    }
  }
  assertFixedProtocolEpoch()
  let receipt = expectedReceipt
  const dataRootStat = assertPlainDirectory(receipt.paths.dataRoot, 'daemon data root')
  const dataParent = dirname(receipt.paths.dataRoot)
  const parentStat = assertPlainDirectory(dataParent, 'daemon data-root parent')
  const reviewDirectoryState = captureOptionalDirectoryState(receipt.paths.reviewDirectory, 'daemon review directory')
  const ancestorIdentities = uniqueByPath([
    ...capturePlainAncestorIdentities(receipt.paths.home, 'daemon bootstrap HOME'),
    ...capturePlainAncestorIdentities(receipt.paths.dataRoot, 'daemon bootstrap data root')
  ]) as readonly DaemonCapturedDirectoryIdentity[]
  const assertBootstrapRoots = () => {
    assertFixedProtocolEpoch()
    for (const expected of ancestorIdentities) {
      const current = assertPlainDirectory(expected.directory, 'daemon bootstrap ancestor')
      if (current.dev !== expected.state.dev || current.ino !== expected.state.ino) {
        throw new Error('daemon bootstrap ancestor identity changed')
      }
    }
    const currentRoot = assertPlainDirectory(receipt.paths.dataRoot, 'daemon bootstrap data root')
    const currentParent = assertPlainDirectory(dataParent, 'daemon bootstrap data-root parent')
    if (currentRoot.dev !== dataRootStat.dev || currentRoot.ino !== dataRootStat.ino
      || currentParent.dev !== parentStat.dev || currentParent.ino !== parentStat.ino) {
      throw new Error('daemon bootstrap root authority changed')
    }
    assertOptionalDirectoryIdentity(receipt.paths.reviewDirectory, reviewDirectoryState, 'daemon bootstrap review directory')
  }
  if (dataRootStat.dev !== parentStat.dev) throw new Error('daemon data root is not on its parent volume')
  if (reviewDirectoryState && reviewDirectoryState.dev !== dataRootStat.dev) {
    throw new Error('daemon review directory is not on the data-root volume')
  }
  if (options.platform && options.platform !== 'win32' && options.platform !== 'darwin'
    && options.platform !== 'linux') throw new Error('daemon bootstrap platform is unsupported')

  let namespaceId = receipt.daemonStageNamespaceId
  const requested = options.namespaceId ? uuid(options.namespaceId, 'daemon requested namespace id') : null
  const stageBefore = lstatOptional(receipt.paths.stageDirectory)
  if (!namespaceId) {
    if (stageBefore) throw new Error('daemon stage sibling exists without HOME authority')
    namespaceId = requested || randomUUID()
    const markerFile = daemonHomeAuthorityMarker(receipt.paths, namespaceId)
    const initialReceipt = receipt
    const marker = writeDaemonFileExclusiveDurable(
      markerFile,
      Buffer.alloc(0),
      0,
      'daemon HOME stage authority',
      checkpoint,
      (inFlight) => {
        assertBootstrapRoots()
        if (lstatOptional(initialReceipt.paths.stageDirectory)) {
          throw new Error('daemon stage sibling appeared during HOME authority publication')
        }
        if (inFlight) {
          assertDaemonReceiptNamespaceMarkerAdvance(
            initialReceipt,
            namespaceId!,
            inFlight,
            options.readReceiptAuthority,
            platform
          )
        } else {
          assertDaemonReceiptNamespaceSnapshot(initialReceipt, options.readReceiptAuthority, platform)
        }
      }
    )
    const publishedReceipt = inspectDaemonReceiptNamespace(
      options.home,
      options.dataRoot,
      options.readReceiptAuthority,
      platform
    )
    if (!sameOptionalCaptured(publishedReceipt.daemonAuthorityMarker, marker)) {
      throw new Error('daemon HOME marker publication did not preserve its created inode')
    }
    checkpoint('daemon-bootstrap-home-authority', { namespaceId })
    assertDaemonReceiptNamespaceSnapshot(publishedReceipt, options.readReceiptAuthority, platform)
    assertBootstrapRoots()
    receipt = publishedReceipt
  } else if (requested && requested !== namespaceId) {
    throw new Error('daemon HOME authority names another stage namespace')
  }
  if (!namespaceId || !receipt.daemonAuthorityMarker) throw new Error('daemon HOME authority publication failed')
  const homeMarker = ensureExistingEmptyMarker(receipt.daemonAuthorityMarker.file, 'daemon HOME stage authority')

  let stageStat = lstatOptional(receipt.paths.stageDirectory)
  const innerFile = daemonInnerNamespaceMarker(receipt.paths, namespaceId)
  let frozenInnerMarker: DaemonCapturedFile | null = null
  const assertBootstrapInnerPhase = (expected: DaemonCapturedFile | null = frozenInnerMarker) => {
    if (!stageStat) throw new Error('daemon stage namespace is absent while sealing its inner-marker phase')
    const currentStage = assertPlainDirectory(receipt.paths.stageDirectory, 'daemon stage namespace')
    if (currentStage.dev !== stageStat.dev || currentStage.ino !== stageStat.ino) {
      throw new Error('daemon stage namespace changed during inner-marker recovery')
    }
    const currentEntries = boundedEntries(receipt.paths.stageDirectory, 1, 'daemon stage inner-marker phase')
    if (!expected) {
      if (currentEntries.length !== 0 || lstatOptional(innerFile)) {
        throw new Error('daemon stage inner marker appeared before its owned publication')
      }
      return
    }
    if (currentEntries.length !== 1 || currentEntries[0].name !== basename(innerFile)
      || !currentEntries[0].isFile() || currentEntries[0].isSymbolicLink()) {
      throw new Error('daemon stage inner-marker inventory changed')
    }
    assertCapturedCurrent(expected, 'daemon stage inner marker')
  }
  if (!stageStat) {
    assertDaemonReceiptNamespaceSnapshot(receipt, options.readReceiptAuthority, platform)
    assertBootstrapRoots()
    const currentParent = assertPlainDirectory(dataParent, 'daemon data-root parent')
    if (currentParent.dev !== parentStat.dev || currentParent.ino !== parentStat.ino) {
      throw new Error('daemon data-root parent changed before stage namespace creation')
    }
    fs.mkdirSync(receipt.paths.stageDirectory)
    stageStat = assertPlainDirectory(receipt.paths.stageDirectory, 'daemon stage namespace')
    checkpoint('daemon-bootstrap-stage-directory-created', { namespaceId })
    const createdStage = fs.lstatSync(receipt.paths.stageDirectory)
    if (createdStage.dev !== stageStat.dev || createdStage.ino !== stageStat.ino
      || boundedEntries(receipt.paths.stageDirectory, 1, 'new daemon stage namespace').length !== 0) {
      throw new Error('daemon stage namespace changed before parent durability')
    }
    assertDaemonReceiptNamespaceSnapshot(receipt, options.readReceiptAuthority, platform)
    assertBootstrapRoots()
    assertBootstrapInnerPhase()
    flushDirectory(dataParent)
    checkpoint('daemon-bootstrap-stage-directory-parent-fsynced', { namespaceId })
    const durableStage = assertPlainDirectory(receipt.paths.stageDirectory, 'daemon stage namespace')
    if (durableStage.dev !== stageStat.dev || durableStage.ino !== stageStat.ino
      || boundedEntries(receipt.paths.stageDirectory, 1, 'new daemon stage namespace').length !== 0) {
      throw new Error('daemon stage namespace changed after parent durability')
    }
    assertDaemonReceiptNamespaceSnapshot(receipt, options.readReceiptAuthority, platform)
    assertBootstrapRoots()
    assertBootstrapInnerPhase()
  } else {
    stageStat = assertPlainDirectory(receipt.paths.stageDirectory, 'daemon stage namespace')
    const recoveryEntries = boundedEntries(
      receipt.paths.stageDirectory,
      DAEMON_STAGE_NAMESPACE_MAX_ENTRIES,
      'recovering daemon stage namespace'
    )
    const recoveryInner = daemonInnerNamespaceMarker(receipt.paths, namespaceId)
    if (recoveryEntries.length > 1
      || recoveryEntries.some((entry) => entry.name !== basename(recoveryInner)
        || !entry.isFile() || entry.isSymbolicLink())) {
      throw new Error('recovering daemon stage namespace contains foreign entries')
    }
    frozenInnerMarker = recoveryEntries.length
      ? captureDaemonProtocolFile(recoveryInner, 0, 'recovering daemon stage inner marker')
      : null
    assertDaemonReceiptNamespaceSnapshot(receipt, options.readReceiptAuthority, platform)
    assertBootstrapRoots()
    assertBootstrapInnerPhase()
    flushDirectory(dataParent)
    checkpoint('daemon-bootstrap-existing-stage-parent-fsynced', { namespaceId })
    const recoveredStage = assertPlainDirectory(receipt.paths.stageDirectory, 'daemon stage namespace')
    if (recoveredStage.dev !== stageStat.dev || recoveredStage.ino !== stageStat.ino) {
      throw new Error('daemon stage namespace changed during recovery durability')
    }
    assertDaemonReceiptNamespaceSnapshot(receipt, options.readReceiptAuthority, platform)
    assertBootstrapRoots()
    assertBootstrapInnerPhase()
  }
  if (stageStat.dev !== dataRootStat.dev) throw new Error('daemon stage namespace is not on the data-root volume')
  const entries = boundedEntries(receipt.paths.stageDirectory, DAEMON_STAGE_NAMESPACE_MAX_ENTRIES, 'daemon stage namespace')
  const innerExists = entries.some((entry) => entry.name === basename(innerFile))
  if (!innerExists) {
    if (entries.length !== 0) throw new Error('daemon stage namespace contains foreign entries before its inner marker')
    const expectedStageState = fileState(stageStat)
    frozenInnerMarker = writeDaemonFileExclusiveDurable(
      innerFile,
      Buffer.alloc(0),
      0,
      'daemon stage inner marker',
      checkpoint,
      (inFlight) => {
        assertDaemonReceiptNamespaceSnapshot(receipt, options.readReceiptAuthority, platform)
        assertBootstrapRoots()
        if (!stageStat || stageStat.dev !== expectedStageState.dev || stageStat.ino !== expectedStageState.ino) {
          throw new Error('daemon stage namespace changed during inner-marker publication')
        }
        assertBootstrapInnerPhase(inFlight)
      }
    )
    assertDaemonReceiptNamespaceSnapshot(receipt, options.readReceiptAuthority, platform)
    assertBootstrapRoots()
    assertBootstrapInnerPhase()
    flushDirectory(dataParent)
    checkpoint('daemon-bootstrap-inner-marker', { namespaceId })
    assertDaemonReceiptNamespaceSnapshot(receipt, options.readReceiptAuthority, platform)
    assertBootstrapRoots()
    assertBootstrapInnerPhase()
  } else if (entries.some((entry) => entry.name !== basename(innerFile))) {
    throw new Error('daemon stage namespace contains foreign entries during bootstrap')
  }
  const innerMarker = ensureExistingEmptyMarker(innerFile, 'daemon stage inner marker')
  if (!frozenInnerMarker) frozenInnerMarker = innerMarker
  if (!sameOptionalCaptured(frozenInnerMarker, innerMarker)) {
    throw new Error('daemon stage inner marker changed after its phase was frozen')
  }
  receipt = inspectDaemonReceiptNamespace(options.home, options.dataRoot, options.readReceiptAuthority, platform)
  if (receipt.daemonStageNamespaceId !== namespaceId || !receipt.daemonAuthorityMarker) {
    throw new Error('daemon receipt authority changed during stage bootstrap')
  }
  assertCapturedCurrent(receipt.receiptFile, 'daemon bootstrap active receipt')
  const finalDataRoot = fileState(assertPlainDirectory(receipt.paths.dataRoot, 'daemon data root'))
  const finalDataParent = fileState(assertPlainDirectory(dataParent, 'daemon data-root parent'))
  if (finalDataRoot.dev !== dataRootStat.dev || finalDataRoot.ino !== dataRootStat.ino
    || finalDataParent.dev !== parentStat.dev || finalDataParent.ino !== parentStat.ino) {
    throw new Error('daemon data-root authority changed during namespace bootstrap')
  }
  assertOptionalDirectoryIdentity(receipt.paths.reviewDirectory, reviewDirectoryState, 'daemon review directory')
  assertFixedProtocolEpoch()
  const postBootstrapInspection = inspectDaemonProtocol({
    home: options.home,
    dataRoot: options.dataRoot,
    platform,
    readReceiptAuthority: options.readReceiptAuthority
  })
  const expectedPostKind = fixedProtocolEpoch.some((entry) => entry.captured)
    ? 'LEGACY-NAMESPACE-RECOVERABLE'
    : 'ABSENT'
  if (postBootstrapInspection.kind !== expectedPostKind
    || postBootstrapInspection.namespaceId !== namespaceId) {
    throw new Error('daemon namespace bootstrap did not produce its exact recoverable topology')
  }
  assertDaemonInspectionCurrent(postBootstrapInspection)
  assertFixedProtocolEpoch()
  return {
    paths: receipt.paths,
    platform,
    readReceiptAuthority: options.readReceiptAuthority,
    receipt,
    namespaceId,
    reservationName: null,
    homeMarker,
    dataRootState: finalDataRoot,
    dataParentState: finalDataParent,
    reviewDirectoryState,
    stageDirectoryState: fileState(assertPlainDirectory(receipt.paths.stageDirectory, 'daemon stage namespace')),
    innerMarker,
    ancestorIdentities,
    recoveredInspection: postBootstrapInspection,
    recoveredInspectionScope: 'FULL'
  }
}

function normalizeCommonRecord(value: Record<string, unknown>): {
  epochId: string
  stageNamespaceId: string
  receiptSha256: DaemonSha256
  installId: string
  dataRootId: string
  packageRoot: string
  packageVersion: string
  packageSha256: DaemonSha256
  dataRoot: string
  port: number
  pid: number
  apiPid: number
  processIdentity: string
  pgid: number
  createdAt: string
} {
  if (value.schemaVersion !== DAEMON_PROTOCOL_VERSION || value.product !== PRODUCT_NAME
    || typeof value.receiptSha256 !== 'string' || !SHA256.test(value.receiptSha256)
    || typeof value.packageSha256 !== 'string' || !SHA256.test(value.packageSha256)
    || !canonicalIso(value.createdAt)) {
    throw new Error('daemon record common authority is invalid')
  }
  const packageVersion = boundedText(value.packageVersion, 'daemon package version', 128)
  const processIdentity = boundedText(value.processIdentity, 'daemon process identity', 512)
  if (!SAFE_PROCESS_IDENTITY.test(processIdentity)) throw new Error('daemon process identity is not portable')
  const pid = positiveInteger(value.pid, 'daemon PID')
  const apiPid = positiveInteger(value.apiPid, 'daemon API PID')
  if (apiPid !== pid) throw new Error('daemon v1 requires one process identity for daemon and API')
  return {
    epochId: uuid(value.epochId, 'daemon epoch id'),
    stageNamespaceId: uuid(value.stageNamespaceId, 'daemon stage namespace id'),
    receiptSha256: value.receiptSha256 as DaemonSha256,
    installId: uuid(value.installId, 'daemon install id'),
    dataRootId: uuid(value.dataRootId, 'daemon data-root id'),
    packageRoot: absolutePath(value.packageRoot, 'daemon package root'),
    packageVersion,
    packageSha256: value.packageSha256 as DaemonSha256,
    dataRoot: absolutePath(value.dataRoot, 'daemon data root'),
    port: portNumber(value.port),
    pid,
    apiPid,
    processIdentity,
    pgid: positiveInteger(value.pgid, 'daemon process group'),
    createdAt: value.createdAt
  }
}

export function validateDaemonInstanceRecord(value: unknown): DaemonInstanceRecordV1 {
  const keys = [
    'schemaVersion', 'product', 'epochId', 'stageNamespaceId', 'receiptSha256', 'installId', 'dataRootId',
    'packageRoot', 'packageVersion', 'packageSha256', 'dataRoot', 'port', 'pid', 'apiPid',
    'processIdentity', 'pgid', 'createdAt', 'projections', 'authority'
  ]
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !exactKeys(value as Record<string, unknown>, keys)) {
    throw new Error('daemon instance record keys are invalid')
  }
  const record = value as Record<string, unknown>
  const common = normalizeCommonRecord(record)
  const authority = validatePersistentAuthority(record.authority)
  validateInstanceAuthorityConsistency(common, authority)
  return {
    schemaVersion: DAEMON_PROTOCOL_VERSION,
    product: PRODUCT_NAME,
    epochId: common.epochId,
    stageNamespaceId: common.stageNamespaceId,
    receiptSha256: common.receiptSha256,
    installId: common.installId,
    dataRootId: common.dataRootId,
    packageRoot: common.packageRoot,
    packageVersion: common.packageVersion,
    packageSha256: common.packageSha256,
    dataRoot: common.dataRoot,
    port: common.port,
    pid: common.pid,
    apiPid: common.apiPid,
    processIdentity: common.processIdentity,
    pgid: common.pgid,
    createdAt: common.createdAt,
    projections: validateProjectionIdentities(record.projections),
    authority
  }
}

export function daemonInstanceRecordBytes(value: DaemonInstanceRecordV1): Buffer {
  const normalized = validateDaemonInstanceRecord(value)
  const bytes = recordBytes(normalized)
  if (bytes.length > DAEMON_INSTANCE_MAX_BYTES) throw new Error('daemon instance record exceeds 64 KiB')
  return bytes
}

export function parseDaemonInstanceRecord(file: DaemonCapturedFile): DaemonInstanceRecordV1 {
  if (file.bytes.length > DAEMON_INSTANCE_MAX_BYTES) throw new Error('daemon instance record exceeds 64 KiB')
  let value: unknown
  try { value = JSON.parse(utf8.decode(file.bytes)) } catch { throw new Error('daemon instance record is not valid bounded JSON') }
  const record = validateDaemonInstanceRecord(value)
  if (!file.bytes.equals(daemonInstanceRecordBytes(record))) throw new Error('daemon instance record is not canonical JSON')
  return record
}

function validateActor(value: unknown): DaemonActorV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !exactKeys(value as Record<string, unknown>, ['pid', 'processIdentity', 'pgid', 'createdAt'])) {
    throw new Error('daemon stage actor keys are invalid')
  }
  const record = value as Record<string, unknown>
  const processIdentity = boundedText(record.processIdentity, 'daemon actor process identity', 512)
  if (!SAFE_PROCESS_IDENTITY.test(processIdentity) || !canonicalIso(record.createdAt)) {
    throw new Error('daemon stage actor identity is invalid')
  }
  return {
    pid: positiveInteger(record.pid, 'daemon actor PID'),
    processIdentity,
    pgid: positiveInteger(record.pgid, 'daemon actor process group'),
    createdAt: record.createdAt
  }
}

function validateProcessTree(value: unknown, label: string): readonly DaemonProcessTreeEntryV1[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4096) {
    throw new Error(`${label} process tree is invalid`)
  }
  const entries = value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || !exactKeys(item as Record<string, unknown>, ['pid', 'processIdentity'])) {
      throw new Error(`${label} process tree entry ${index} is invalid`)
    }
    const record = item as Record<string, unknown>
    const processIdentity = boundedText(record.processIdentity, `${label} process identity`, 512)
    if (!SAFE_PROCESS_IDENTITY.test(processIdentity)) throw new Error(`${label} process identity is not portable`)
    return { pid: positiveInteger(record.pid, `${label} process PID`), processIdentity }
  })
  if (new Set(entries.map((entry) => entry.pid)).size !== entries.length
    || entries.some((entry, index) => index > 0 && entries[index - 1].pid >= entry.pid)) {
    throw new Error(`${label} process tree is not uniquely PID-sorted`)
  }
  return entries
}

function validateLifecycleOwnerBinding(value: unknown): DaemonLifecycleOwnerBindingV1 | null {
  if (value === null) return null
  const keys = [
    'lockToken', 'operation', 'ownerRecord', 'ownerStageNamespaceId',
    'receiptSha256', 'installId', 'dataRootId'
  ]
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !exactKeys(value as Record<string, unknown>, keys)) {
    throw new Error('daemon lifecycle-owner binding keys are invalid')
  }
  const record = value as Record<string, unknown>
  if (record.operation !== 'setup' && record.operation !== 'upgrade' && record.operation !== 'uninstall'
    && record.operation !== 'recover' && record.operation !== 'purge') {
    throw new Error('daemon lifecycle-owner operation is invalid')
  }
  if (typeof record.receiptSha256 !== 'string' || !SHA256.test(record.receiptSha256)) {
    throw new Error('daemon lifecycle-owner receipt digest is invalid')
  }
  return {
    lockToken: uuid(record.lockToken, 'daemon lifecycle-owner lock token'),
    operation: record.operation,
    ownerRecord: validateFileIdentity(record.ownerRecord, 'daemon lifecycle-owner record'),
    ownerStageNamespaceId: uuid(record.ownerStageNamespaceId, 'daemon lifecycle-owner stage namespace id'),
    receiptSha256: record.receiptSha256 as DaemonSha256,
    installId: uuid(record.installId, 'daemon lifecycle-owner install id'),
    dataRootId: uuid(record.dataRootId, 'daemon lifecycle-owner data-root id')
  }
}

function validateStopTarget(value: unknown): DaemonStopTargetV1 {
  const keys = [
    'instance', 'projections', 'epochId', 'pid', 'apiPid', 'processIdentity', 'pgid', 'port', 'processTree'
  ]
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !exactKeys(value as Record<string, unknown>, keys)) throw new Error('daemon stop target keys are invalid')
  const record = value as Record<string, unknown>
  const pid = positiveInteger(record.pid, 'daemon stop target PID')
  const apiPid = positiveInteger(record.apiPid, 'daemon stop target API PID')
  if (apiPid !== pid) throw new Error('daemon stop target must bind one v1 daemon/API process')
  const processIdentity = boundedText(record.processIdentity, 'daemon stop target process identity', 512)
  if (!SAFE_PROCESS_IDENTITY.test(processIdentity)) throw new Error('daemon stop target process identity is not portable')
  const processTree = validateProcessTree(record.processTree, 'daemon stop target')
  if (!processTree.some((entry) => entry.pid === pid && entry.processIdentity === processIdentity)
    || !processTree.some((entry) => entry.pid === apiPid)) {
    throw new Error('daemon stop target process tree does not contain its root and API processes')
  }
  return {
    instance: validateFileIdentity(record.instance, 'daemon stop target instance'),
    projections: validateProjectionIdentities(record.projections),
    epochId: uuid(record.epochId, 'daemon stop target epoch id'),
    pid,
    apiPid,
    processIdentity,
    pgid: positiveInteger(record.pgid, 'daemon stop target process group'),
    port: portNumber(record.port),
    processTree
  }
}

function validateLegacyTarget(value: unknown): DaemonLegacyTargetV1 {
  const keys = ['projections', 'pid', 'apiPid', 'processIdentity', 'pgid', 'port', 'processTree']
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !exactKeys(value as Record<string, unknown>, keys)) throw new Error('daemon legacy target keys are invalid')
  const record = value as Record<string, unknown>
  const projections = validateOptionalProjectionIdentities(record.projections)
  if (!projections.pid && !projections.apiPid && !projections.heartbeat) {
    throw new Error('daemon legacy target cannot authorize an already-absent projection set')
  }
  const pid = positiveInteger(record.pid, 'legacy daemon PID')
  const apiPid = positiveInteger(record.apiPid, 'legacy daemon API PID')
  const processIdentity = boundedText(record.processIdentity, 'legacy daemon process identity', 512)
  if (!SAFE_PROCESS_IDENTITY.test(processIdentity)) throw new Error('legacy daemon process identity is not portable')
  const processTree = validateProcessTree(record.processTree, 'legacy daemon target')
  if (!processTree.some((entry) => entry.pid === pid && entry.processIdentity === processIdentity)
    || !processTree.some((entry) => entry.pid === apiPid)) {
    throw new Error('legacy daemon process tree does not contain its root and API processes')
  }
  return {
    projections,
    pid,
    apiPid,
    processIdentity,
    pgid: positiveInteger(record.pgid, 'legacy daemon process group'),
    port: portNumber(record.port),
    processTree
  }
}

export function validateDaemonStageManifest(value: unknown): DaemonStageManifestV1 {
  const commonKeys = [
    'schemaVersion', 'product', 'operation', 'reservationName', 'stageNamespaceId', 'receiptSha256',
    'installId', 'dataRootId', 'operationId', 'packageRoot', 'packageVersion', 'packageSha256', 'dataRoot',
    'actor', 'roots'
  ]
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('daemon stage manifest keys are invalid')
  }
  const record = value as Record<string, unknown>
  if (record.operation !== 'start' && record.operation !== 'stop' && record.operation !== 'legacy-retire') {
    throw new Error('daemon stage manifest operation is invalid')
  }
  const operationKeys = record.operation === 'legacy-retire'
    ? [...commonKeys, 'lifecycleOwnerBinding', 'target']
    : record.operation === 'stop'
      ? [...commonKeys, 'lifecycleOwnerBinding', 'target']
      : [...commonKeys, 'instance', 'projections']
  if (!exactKeys(record, operationKeys)) throw new Error('daemon stage manifest keys are invalid for its operation')
  if (record.schemaVersion !== DAEMON_PROTOCOL_VERSION || record.product !== PRODUCT_NAME
    || typeof record.receiptSha256 !== 'string' || !SHA256.test(record.receiptSha256)
    || typeof record.packageSha256 !== 'string' || !SHA256.test(record.packageSha256)) {
    throw new Error('daemon stage manifest common authority is invalid')
  }
  const actor = validateActor(record.actor)
  const base: DaemonStageManifestCommonV1 = {
    schemaVersion: DAEMON_PROTOCOL_VERSION,
    product: PRODUCT_NAME,
    reservationName: boundedText(record.reservationName, 'daemon reservation name', 240),
    stageNamespaceId: uuid(record.stageNamespaceId, 'daemon stage namespace id'),
    receiptSha256: record.receiptSha256 as DaemonSha256,
    installId: uuid(record.installId, 'daemon install id'),
    dataRootId: uuid(record.dataRootId, 'daemon data-root id'),
    operationId: uuid(record.operationId, 'daemon operation id'),
    packageRoot: absolutePath(record.packageRoot, 'daemon package root'),
    packageVersion: boundedText(record.packageVersion, 'daemon package version', 128),
    packageSha256: record.packageSha256 as DaemonSha256,
    dataRoot: absolutePath(record.dataRoot, 'daemon data root'),
    actor,
    roots: validateRootIdentities(record.roots)
  }
  const manifest: DaemonStageManifestV1 = record.operation === 'legacy-retire'
    ? {
      ...base,
      operation: 'legacy-retire',
      lifecycleOwnerBinding: validateLifecycleOwnerBinding(record.lifecycleOwnerBinding),
      target: validateLegacyTarget(record.target)
    }
    : record.operation === 'start'
      ? {
        ...base,
        operation: 'start',
        instance: validateFileIdentity(record.instance, 'daemon start manifest instance'),
        projections: validateProjectionIdentities(record.projections)
      }
      : {
        ...base,
        operation: 'stop',
        lifecycleOwnerBinding: validateLifecycleOwnerBinding(record.lifecycleOwnerBinding),
        target: validateStopTarget(record.target)
      }
  if (manifest.operation !== 'start' && manifest.lifecycleOwnerBinding) {
    if (manifest.lifecycleOwnerBinding.receiptSha256 !== manifest.receiptSha256
      || manifest.lifecycleOwnerBinding.installId !== manifest.installId
      || manifest.lifecycleOwnerBinding.dataRootId !== manifest.dataRootId) {
      throw new Error('daemon lifecycle-owner binding does not bind the stage receipt authority')
    }
  }
  const parsedName = parseDaemonReservationName(manifest.reservationName)
  if (!parsedName) throw new Error('daemon stage manifest reservation name is invalid')
  assertReservationBinding(parsedName, manifest)
  return manifest
}

export function daemonStageManifestBytes(value: DaemonStageManifestV1): Buffer {
  const normalized = validateDaemonStageManifest(value)
  const bytes = recordBytes(normalized)
  if (bytes.length > DAEMON_STAGE_MANIFEST_MAX_BYTES) throw new Error('daemon stage manifest exceeds 64 KiB')
  return bytes
}

export function parseDaemonStageManifest(file: DaemonCapturedFile): DaemonStageManifestV1 {
  if (file.bytes.length > DAEMON_STAGE_MANIFEST_MAX_BYTES) throw new Error('daemon stage manifest exceeds 64 KiB')
  let value: unknown
  try { value = JSON.parse(utf8.decode(file.bytes)) } catch { throw new Error('daemon stage manifest is not valid bounded JSON') }
  const manifest = validateDaemonStageManifest(value)
  if (!file.bytes.equals(daemonStageManifestBytes(manifest))) throw new Error('daemon stage manifest is not canonical JSON')
  return manifest
}

function bindingForManifest(manifest: DaemonStageManifestV1): DaemonReservationBinding {
  return {
    stageNamespaceId: manifest.stageNamespaceId,
    receiptSha256: manifest.receiptSha256,
    installId: manifest.installId,
    dataRootId: manifest.dataRootId,
    operationId: manifest.operationId,
    actorPid: manifest.actor.pid,
    actorProcessIdentity: manifest.actor.processIdentity,
    actorPgid: manifest.actor.pgid,
    operation: manifest.operation,
    packageSha256: manifest.packageSha256,
    createdAt: manifest.actor.createdAt
  }
}

function assertReservationBinding(
  parsed: ParsedDaemonReservationName,
  binding: DaemonReservationBinding | DaemonStageManifestV1
): void {
  const full = 'reservationName' in binding ? bindingForManifest(binding) : binding
  if (parsed.name !== daemonReservationName(full)
    || parsed.stageNamespaceId !== full.stageNamespaceId
    || parsed.receiptSha24 !== digestHex(full.receiptSha256).slice(0, 24)
    || parsed.installId !== full.installId || parsed.dataRootId !== full.dataRootId
    || parsed.operationId !== full.operationId || parsed.actorPid !== full.actorPid
    || parsed.actorPgid !== full.actorPgid
    || parsed.operation !== full.operation
    || parsed.actorProcessIdentitySha16
      !== createHash('sha256').update(full.actorProcessIdentity).digest('hex').slice(0, 16)
    || parsed.packageSha12 !== digestHex(full.packageSha256).slice(0, 12)
    || parsed.createdAtMs !== Date.parse(full.createdAt)) {
    throw new Error('daemon reservation basename does not bind its canonical record')
  }
}

function assertRecordBindsReceipt(
  value: DaemonInstanceRecordV1 | DaemonStageManifestV1,
  receipt: DaemonReceiptNamespaceSnapshot,
  namespaceId: string
): void {
  if (value.stageNamespaceId !== namespaceId || value.receiptSha256 !== receipt.receiptSha256
    || value.installId !== receipt.receipt.installId || value.dataRootId !== receipt.receipt.dataRootId
    || value.packageSha256 !== receipt.receipt.packageSha256
    || !samePath(value.packageRoot, receipt.receipt.packageRoot)
    || !samePath(value.dataRoot, receipt.receipt.dataRoot)
    || value.packageVersion !== receipt.receipt.packageVersion) {
    throw new Error('daemon record does not bind the active lifecycle receipt')
  }
}

function parsePidProjection(file: DaemonCapturedFile, label: string): number {
  let text: string
  try { text = utf8.decode(file.bytes) } catch { throw new Error(`${label} is not valid UTF-8`) }
  if (!/^[1-9][0-9]{0,15}\n$/.test(text)) throw new Error(`${label} is not canonical`)
  return positiveInteger(Number(text.trim()), label)
}

type HeartbeatProjection = Readonly<{
  pid: number
  apiPid: number
  hubRoot: string
  packageRoot: string
  dataRoot: string
  port: number
  apiHealthy: boolean
  lastBeat: string
}>

function heartbeatBytes(value: HeartbeatProjection): Buffer {
  return recordBytes(value)
}

function parseHeartbeatProjection(file: DaemonCapturedFile): HeartbeatProjection {
  let value: unknown
  try { value = JSON.parse(utf8.decode(file.bytes)) } catch { throw new Error('daemon heartbeat projection is not bounded JSON') }
  const keys = ['pid', 'apiPid', 'hubRoot', 'packageRoot', 'dataRoot', 'port', 'apiHealthy', 'lastBeat']
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !exactKeys(value as Record<string, unknown>, keys)) throw new Error('daemon heartbeat projection keys are invalid')
  const record = value as Record<string, unknown>
  const heartbeat: HeartbeatProjection = {
    pid: positiveInteger(record.pid, 'daemon heartbeat PID'),
    apiPid: positiveInteger(record.apiPid, 'daemon heartbeat API PID'),
    hubRoot: absolutePath(record.hubRoot, 'daemon heartbeat hub root'),
    packageRoot: absolutePath(record.packageRoot, 'daemon heartbeat package root'),
    dataRoot: absolutePath(record.dataRoot, 'daemon heartbeat data root'),
    port: portNumber(record.port),
    apiHealthy: record.apiHealthy === true ? true : record.apiHealthy === false ? false
      : (() => { throw new Error('daemon heartbeat health is invalid') })(),
    lastBeat: canonicalIso(record.lastBeat) ? record.lastBeat : (() => { throw new Error('daemon heartbeat timestamp is invalid') })()
  }
  if (!samePath(heartbeat.hubRoot, heartbeat.dataRoot) || !file.bytes.equals(heartbeatBytes(heartbeat))) {
    throw new Error('daemon heartbeat projection is not canonical')
  }
  return heartbeat
}

function assertProjectionPayloads(
  instance: DaemonInstanceRecordV1,
  projections: { pid: DaemonCapturedFile; apiPid: DaemonCapturedFile; heartbeat: DaemonCapturedFile }
): void {
  assertIdentityMatches(instance.projections.pid, projections.pid, 'daemon PID projection')
  assertIdentityMatches(instance.projections.apiPid, projections.apiPid, 'daemon API PID projection')
  assertIdentityMatches(instance.projections.heartbeat, projections.heartbeat, 'daemon heartbeat projection')
  const pid = parsePidProjection(projections.pid, 'daemon PID projection')
  const apiPid = parsePidProjection(projections.apiPid, 'daemon API PID projection')
  const heartbeat = parseHeartbeatProjection(projections.heartbeat)
  if (pid !== instance.pid || apiPid !== instance.apiPid || heartbeat.pid !== instance.pid
    || heartbeat.apiPid !== instance.apiPid || heartbeat.port !== instance.port
    || heartbeat.apiHealthy !== true
    || !samePath(heartbeat.packageRoot, instance.packageRoot) || !samePath(heartbeat.dataRoot, instance.dataRoot)
    || heartbeat.lastBeat !== instance.createdAt) {
    throw new Error('daemon compatibility projections do not bind the immutable instance')
  }
}

function sameOptionalCaptured(
  left: DaemonCapturedFile | null,
  right: DaemonCapturedFile | null
): boolean {
  return !left && !right || Boolean(left && right
    && samePath(left.file, right.file)
    && left.sha256 === right.sha256
    && left.bytes.equals(right.bytes)
    && sameFileState(left.state, right.state))
}

function assertDaemonReceiptNamespaceSnapshot(
  expected: DaemonReceiptNamespaceSnapshot,
  readReceiptAuthority: DaemonReceiptAuthorityReader,
  platform: string
): void {
  const current = inspectDaemonReceiptNamespace(
    expected.paths.home,
    expected.paths.dataRoot,
    readReceiptAuthority,
    platform
  )
  if (current.homeIdentity !== expected.homeIdentity
    || !sameFileState(current.directoryState, expected.directoryState)
    || current.entries.length !== expected.entries.length
    || current.entries.some((entry, index) => entry !== expected.entries[index])
    || current.receiptSha256 !== expected.receiptSha256
    || canonicalDaemonJson(current.receipt) !== canonicalDaemonJson(expected.receipt)
    || !sameOptionalCaptured(current.namespaceMarker, expected.namespaceMarker)
    || !sameOptionalCaptured(current.receiptFile, expected.receiptFile)
    || current.ownerStageNamespaceId !== expected.ownerStageNamespaceId
    || !sameOptionalCaptured(current.ownerStageAuthorityMarker, expected.ownerStageAuthorityMarker)
    || current.daemonStageNamespaceId !== expected.daemonStageNamespaceId
    || !sameOptionalCaptured(current.daemonAuthorityMarker, expected.daemonAuthorityMarker)) {
    throw new Error('daemon lifecycle receipt namespace changed after it was frozen')
  }
}

function assertDaemonReceiptNamespaceMarkerAdvance(
  expected: DaemonReceiptNamespaceSnapshot,
  namespaceId: string,
  inFlight: DaemonCapturedFile,
  readReceiptAuthority: DaemonReceiptAuthorityReader,
  platform: string
): void {
  if (expected.daemonStageNamespaceId || expected.daemonAuthorityMarker) {
    throw new Error('daemon HOME marker advance did not start from an unclaimed receipt namespace')
  }
  const current = inspectDaemonReceiptNamespace(
    expected.paths.home,
    expected.paths.dataRoot,
    readReceiptAuthority,
    platform
  )
  const expectedEntries = [...expected.entries, basename(inFlight.file)]
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
  if (current.homeIdentity !== expected.homeIdentity
    || current.directoryState.dev !== expected.directoryState.dev
    || current.directoryState.ino !== expected.directoryState.ino
    || current.entries.length !== expectedEntries.length
    || current.entries.some((entry, index) => entry !== expectedEntries[index])
    || current.receiptSha256 !== expected.receiptSha256
    || !sameOptionalCaptured(current.namespaceMarker, expected.namespaceMarker)
    || !sameOptionalCaptured(current.receiptFile, expected.receiptFile)
    || current.ownerStageNamespaceId !== expected.ownerStageNamespaceId
    || !sameOptionalCaptured(current.ownerStageAuthorityMarker, expected.ownerStageAuthorityMarker)
    || current.daemonStageNamespaceId !== namespaceId
    || !current.daemonAuthorityMarker
    || !sameOptionalCaptured(current.daemonAuthorityMarker, inFlight)) {
    throw new Error('daemon HOME marker publication changed another receipt authority')
  }
}

function daemonStartStageExactSignature(stage: DaemonStartStage): string {
  const authority = daemonStageNamespaceAuthorityExactValue(stage.authority)
  return canonicalDaemonJson({
    authority,
    binding: stage.binding,
    reservationName: stage.reservationName,
    reservationDirectory: stage.reservationDirectory,
    instance: stage.instance,
    manifest: stage.manifest,
    files: stage.files
  })
}

function daemonStageNamespaceAuthorityExactValue(authority: DaemonStageNamespaceAuthority): unknown {
  return {
    ...authority,
    readReceiptAuthority: null,
    recoveredInspection: authority.recoveredInspection
      ? daemonInspectionExactSignature(authority.recoveredInspection)
      : null
  }
}

function daemonStageNamespaceAuthorityExactSignature(authority: DaemonStageNamespaceAuthority): string {
  return canonicalDaemonJson(daemonStageNamespaceAuthorityExactValue(authority))
}

function capturePrivateDaemonStageNamespaceAuthority(
  callerAuthority: DaemonStageNamespaceAuthority
): Readonly<{
  authority: DaemonStageNamespaceAuthority
  assertCallerViewCurrent: () => void
}> {
  assertDaemonStageNamespaceAuthority(callerAuthority)
  const issuedReader = callerAuthority.readReceiptAuthority
  const issuedSignature = daemonStageNamespaceAuthorityExactSignature(callerAuthority)
  const privateAuthority = cloneDaemonStageNamespaceAuthority(callerAuthority)
  const assertCallerViewCurrent = (): void => {
    let signature: string
    try {
      signature = daemonStageNamespaceAuthorityExactSignature(callerAuthority)
    } catch {
      throw new Error('caller-visible daemon stage namespace authority changed after capture')
    }
    if (callerAuthority.readReceiptAuthority !== issuedReader || signature !== issuedSignature) {
      throw new Error('caller-visible daemon stage namespace authority changed after capture')
    }
  }
  assertCallerViewCurrent()
  assertDaemonStageNamespaceAuthority(privateAuthority)
  assertCallerViewCurrent()
  return { authority: privateAuthority, assertCallerViewCurrent }
}

function cloneDaemonStartPublicationEpoch(epoch: DaemonStartPublicationEpoch): DaemonStartPublicationEpoch {
  const cloneSlot = (slot: DaemonStartPublicationSlot): DaemonStartPublicationSlot => {
    if (slot.phase === 'ABSENT') return { phase: 'ABSENT' }
    if (slot.phase === 'PENDING') return { phase: 'PENDING', source: cloneDaemonCapturedFile(slot.source) }
    if (slot.phase === 'LINKED') {
      return {
        phase: 'LINKED',
        source: cloneDaemonCapturedFile(slot.source),
        target: cloneDaemonCapturedFile(slot.target)
      }
    }
    return { phase: 'PUBLISHED', target: cloneDaemonCapturedFile(slot.target) }
  }
  return {
    pid: cloneSlot(epoch.pid),
    apiPid: cloneSlot(epoch.apiPid),
    heartbeat: cloneSlot(epoch.heartbeat),
    final: cloneSlot(epoch.final)
  }
}

function issueDaemonStartStage(
  stage: DaemonStartStage,
  publication: DaemonStartPublicationEpoch
): DaemonStartStage {
  const privateStage = cloneDaemonStartStage(stage)
  const issued = cloneDaemonStartStage(privateStage)
  const privateState: DaemonPrivateStartStage = {
    stage: privateStage,
    publication: cloneDaemonStartPublicationEpoch(publication),
    issuedView: issued,
    issuedSignature: daemonStartStageExactSignature(issued),
    issuedReceiptReader: issued.authority.readReceiptAuthority
  }
  daemonPrivateStartStages.set(issued, privateState)
  return issued
}

function assertDaemonStartStageIssuedView(state: DaemonPrivateStartStage): void {
  let signature: string
  try {
    signature = daemonStartStageExactSignature(state.issuedView)
  } catch {
    throw new Error('caller-visible daemon start stage changed after issuance')
  }
  if (state.issuedView.authority.readReceiptAuthority !== state.issuedReceiptReader
    || signature !== state.issuedSignature) {
    throw new Error('caller-visible daemon start stage changed after issuance')
  }
}

function privateDaemonStartStage(stage: DaemonStartStage): DaemonPrivateStartStage {
  if (!stage || typeof stage !== 'object') {
    throw new Error('daemon start stage was not issued by this protocol instance')
  }
  const state = daemonPrivateStartStages.get(stage)
  if (!state) throw new Error('daemon start stage was not issued by this protocol instance')
  assertDaemonStartStageIssuedView(state)
  return state
}

function daemonStartPublicationPaths(authority: DaemonStageNamespaceAuthority): Readonly<Record<keyof DaemonStartPublicationEpoch, string>> {
  return {
    pid: authority.paths.pidProjection,
    apiPid: authority.paths.apiPidProjection,
    heartbeat: authority.paths.heartbeatProjection,
    final: authority.paths.finalInstance
  }
}

function assertDaemonStartPublicationEpoch(
  privateStage: DaemonPrivateStartStage,
  inFlight: DaemonCapturedFile | null
): void {
  const authority = privateStage.stage.authority
  const epoch = privateStage.publication
  const paths = daemonStartPublicationPaths(authority)
  let matchedInFlight = false
  for (const key of Object.keys(paths) as (keyof DaemonStartPublicationEpoch)[]) {
    const file = paths[key]
    const slot = epoch[key]
    if (inFlight && samePath(inFlight.file, file, authority.platform)) {
      if (slot.phase !== 'LINKED') {
        throw new Error(`daemon start ${key} publication has no frozen linked source`)
      }
      const linkedTarget = captureDaemonStartLinkedPair(slot.source, file, key)
      if (!sameOptionalCaptured(linkedTarget, slot.target) || !sameOptionalCaptured(linkedTarget, inFlight)) {
        throw new Error(`daemon start in-flight ${key} publication is not its frozen source pair`)
      }
      matchedInFlight = true
    } else if (slot.phase === 'PENDING') {
      assertFrozenDaemonFile(slot.source, `daemon pending ${key} source`, 1)
      if (lstatOptional(file)) throw new Error(`daemon pending ${key} target appeared before its owned link`)
    } else if (slot.phase === 'LINKED') {
      const linkedTarget = captureDaemonStartLinkedPair(slot.source, file, key)
      if (!sameOptionalCaptured(linkedTarget, slot.target)) {
        throw new Error(`daemon linked ${key} target changed before publication durability`)
      }
    } else if (slot.phase === 'PUBLISHED') {
      assertCapturedCurrent(slot.target, `daemon start ${key} publication`, [slot.target.state.nlink])
    } else if (lstatOptional(file)) {
      throw new Error(`daemon start ${key} publication appeared without a frozen pending source`)
    }
  }
  if (inFlight && !matchedInFlight) throw new Error('daemon start publication wrote outside its frozen protocol paths')
}

function captureDaemonStartLinkedPair(
  source: DaemonCapturedFile,
  target: string,
  key: keyof DaemonStartPublicationEpoch
): DaemonCapturedFile {
  if (!lstatOptional(target)) throw new Error(`daemon linked ${key} target disappeared`)
  const currentSource = assertFrozenDaemonFile(source, `daemon pending ${key} source`, 2)
  const currentTarget = captureDaemonProtocolFile(
    target,
    Math.max(source.bytes.length, 1),
    `daemon pending ${key} target`,
    [2]
  )
  if (currentTarget.state.dev !== currentSource.state.dev || currentTarget.state.ino !== currentSource.state.ino
    || !currentTarget.bytes.equals(source.bytes) || currentTarget.sha256 !== source.sha256) {
    throw new Error(`daemon pending ${key} target is not the frozen source hardlink`)
  }
  return currentTarget
}

function recordDaemonStartLinkedPublication(
  privateStage: DaemonPrivateStartStage,
  key: keyof DaemonStartPublicationEpoch,
  source: DaemonCapturedFile,
  target: DaemonCapturedFile
): void {
  const authority = privateStage.stage.authority
  const epoch = privateStage.publication
  const slot = epoch[key]
  if (slot.phase === 'PENDING') {
    if (slot.source.state.dev !== source.state.dev || slot.source.state.ino !== source.state.ino) {
      throw new Error(`daemon start ${key} linked another source inode`)
    }
    const linkedTarget = captureDaemonStartLinkedPair(slot.source, daemonStartPublicationPaths(authority)[key], key)
    if (!sameOptionalCaptured(linkedTarget, target)) {
      throw new Error(`daemon start ${key} linked target changed before epoch advance`)
    }
    epoch[key] = { phase: 'LINKED', source: slot.source, target: linkedTarget }
    return
  }
  if (slot.phase !== 'LINKED' || !sameOptionalCaptured(slot.target, target)) {
    throw new Error(`daemon start ${key} linked publication cannot be recorded twice`)
  }
}

function beginDaemonStartPublicationEpoch(
  privateStage: DaemonPrivateStartStage,
  key: keyof DaemonStartPublicationEpoch,
  source: DaemonCapturedFile
): void {
  const authority = privateStage.stage.authority
  const epoch = privateStage.publication
  const slot = epoch[key]
  if (slot.phase === 'ABSENT') {
    assertFrozenDaemonFile(source, `daemon pending ${key} source`, 1)
    if (lstatOptional(daemonStartPublicationPaths(authority)[key])) {
      throw new Error(`daemon start ${key} target appeared before pending publication`)
    }
    epoch[key] = { phase: 'PENDING', source }
    return
  }
  if (slot.phase !== 'PENDING' || slot.source.state.dev !== source.state.dev || slot.source.state.ino !== source.state.ino) {
    throw new Error(`daemon start ${key} publication cannot enter pending twice`)
  }
}

function advanceDaemonStartPublicationEpoch(
  privateStage: DaemonPrivateStartStage,
  key: keyof DaemonStartPublicationEpoch,
  captured: DaemonCapturedFile
): void {
  const authority = privateStage.stage.authority
  const epoch = privateStage.publication
  const expectedPath = daemonStartPublicationPaths(authority)[key]
  if (epoch[key].phase !== 'LINKED' || !samePath(captured.file, expectedPath, authority.platform)) {
    throw new Error(`daemon start ${key} publication cannot advance from its current epoch`)
  }
  const linkedSlot = epoch[key]
  if (linkedSlot.phase !== 'LINKED') throw new Error(`daemon start ${key} publication lost its linked epoch`)
  const linkedTarget = captureDaemonStartLinkedPair(linkedSlot.source, expectedPath, key)
  if (!sameOptionalCaptured(linkedTarget, linkedSlot.target) || !sameOptionalCaptured(linkedTarget, captured)) {
    throw new Error(`daemon start ${key} publication advance lost its frozen hardlink pair`)
  }
  epoch[key] = { phase: 'PUBLISHED', target: cloneDaemonCapturedFile(captured) }
}

function assertDaemonStageAuthorityInventory(
  authority: DaemonStageNamespaceAuthority,
  reservationName: string | null,
  publicationInFlight: DaemonCapturedFile | null = null,
  privateStartStage: DaemonPrivateStartStage | null = null
): void {
  if (authority.recoveredInspection) {
    if (authority.recoveredInspectionScope === 'FULL') {
      assertDaemonInspectionCurrent(authority.recoveredInspection)
    } else if (authority.recoveredInspectionScope === 'EXTERNAL') {
      assertDaemonInspectionExternalCurrent(authority.recoveredInspection)
    } else {
      if (!privateStartStage || privateStartStage.stage.authority !== authority) {
        throw new Error('daemon START authority requires its module-private stage provenance')
      }
      const reservationDirectory = authority.reservationName
        ? join(authority.paths.stageDirectory, authority.reservationName)
        : null
      const ownedStartPaths = [
        ...Object.values(daemonStartPublicationPaths(authority)),
        ...authority.recoveredInspection.proof.files
          .filter((file) => reservationDirectory && samePath(dirname(file.file), reservationDirectory, authority.platform))
          .map((file) => file.file)
      ]
      assertDaemonInspectionExternalCurrent(authority.recoveredInspection, ownedStartPaths)
      assertDaemonStartPublicationEpoch(privateStartStage, publicationInFlight)
    }
  }
  assertDaemonReceiptNamespaceSnapshot(authority.receipt, authority.readReceiptAuthority, authority.platform)
  assertCapturedCurrent(authority.homeMarker, 'daemon HOME stage authority')
  assertCapturedCurrent(authority.innerMarker, 'daemon stage inner marker')
  for (const expected of authority.ancestorIdentities) {
    const current = assertPlainDirectory(expected.directory, 'daemon stage authority ancestor')
    if (current.dev !== expected.state.dev || current.ino !== expected.state.ino) {
      throw new Error('daemon stage authority ancestor identity changed')
    }
  }
  const dataRoot = fileState(assertPlainDirectory(authority.paths.dataRoot, 'daemon data root'))
  const dataParent = fileState(assertPlainDirectory(dirname(authority.paths.dataRoot), 'daemon data-root parent'))
  if (!sameFileState(dataRoot, authority.dataRootState)
    || !sameFileState(dataParent, authority.dataParentState)) {
    throw new Error('daemon data-root authority changed')
  }
  const review = captureOptionalDirectoryState(authority.paths.reviewDirectory, 'daemon review directory')
  if (!authority.reviewDirectoryState && review
    || authority.reviewDirectoryState && (!review
      || review.dev !== authority.reviewDirectoryState.dev || review.ino !== authority.reviewDirectoryState.ino)) {
    throw new Error('daemon review-directory authority changed')
  }
  const stage = assertPlainDirectory(authority.paths.stageDirectory, 'daemon stage namespace')
  if (stage.dev !== authority.stageDirectoryState.dev || stage.ino !== authority.stageDirectoryState.ino) {
    throw new Error('daemon stage namespace identity changed')
  }
  const expected = [basename(authority.innerMarker.file), ...(reservationName ? [reservationName] : [])]
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
  const entries = boundedEntries(authority.paths.stageDirectory, DAEMON_STAGE_NAMESPACE_MAX_ENTRIES, 'daemon stage namespace')
  if (entries.length !== expected.length || entries.some((entry, index) => entry.name !== expected[index])
    || entries.some((entry) => entry.name === basename(authority.innerMarker.file)
      ? !entry.isFile() || entry.isSymbolicLink()
      : !entry.isDirectory() || entry.isSymbolicLink())) {
    throw new Error('daemon stage namespace inventory changed')
  }
}

export function assertDaemonStageNamespaceAuthority(authority: DaemonStageNamespaceAuthority): void {
  assertDaemonStageAuthorityInventory(authority, authority.reservationName)
}

function assertDirectoryIdentityV1(directory: string, expected: DaemonDirectoryIdentityV1, label: string): fs.Stats {
  const current = assertPlainDirectory(directory, label)
  if (String(current.dev) !== expected.dev || String(current.ino) !== expected.ino) {
    throw new Error(`${label} identity changed`)
  }
  return current
}

function assertFrozenDaemonFile(
  expected: DaemonCapturedFile,
  label: string,
  expectedNlink: number
): DaemonCapturedFile {
  const current = captureDaemonProtocolFile(
    expected.file,
    Math.max(expected.bytes.length, 1),
    label,
    [expectedNlink]
  )
  if (!current.bytes.equals(expected.bytes) || current.sha256 !== expected.sha256
    || current.state.dev !== expected.state.dev || current.state.ino !== expected.state.ino
    || current.state.size !== expected.state.size || current.state.mtimeMs !== expected.state.mtimeMs) {
    throw new Error(`${label} no longer names the frozen inode`)
  }
  return current
}

function assertStartPublicAbsent(paths: DaemonProtocolPaths): void {
  for (const file of [paths.finalInstance, paths.pidProjection, paths.apiPidProjection, paths.heartbeatProjection]) {
    if (lstatOptional(file)) throw new Error(`daemon public protocol path appeared before manifest publication: ${file}`)
  }
}

function persistentAuthorityForStart(authority: DaemonStageNamespaceAuthority): DaemonPersistentAuthorityV1 {
  if (!authority.receipt.daemonAuthorityMarker || !authority.reviewDirectoryState) {
    throw new Error('daemon start requires durable HOME, stage, and review-directory authority')
  }
  return validatePersistentAuthority({
    homeIdentity: authority.receipt.homeIdentity,
    receiptDirectory: daemonDirectoryIdentity(authority.receipt.directoryState),
    receiptInventory: authority.receipt.entries,
    receiptNamespaceMarker: daemonFileIdentity(authority.receipt.namespaceMarker),
    receipt: daemonFileIdentity(authority.receipt.receiptFile),
    ownerStageAuthority: authority.receipt.ownerStageAuthorityMarker
      ? daemonFileIdentity(authority.receipt.ownerStageAuthorityMarker)
      : null,
    daemonStageAuthority: daemonFileIdentity(authority.receipt.daemonAuthorityMarker),
    dataRoot: daemonDirectoryIdentity(authority.dataRootState),
    review: daemonDirectoryIdentity(authority.reviewDirectoryState),
    stage: daemonDirectoryIdentity(authority.stageDirectoryState),
    innerMarker: daemonFileIdentity(authority.innerMarker)
  })
}

function assertInstancePersistentAuthority(
  instance: DaemonInstanceRecordV1,
  authority: DaemonStageNamespaceAuthority
): void {
  const expected = persistentAuthorityForStart(authority)
  if (JSON.stringify(instance.authority) !== JSON.stringify(expected)) {
    throw new Error('daemon instance does not bind its persistent lifecycle and root authority')
  }
}

function assertStartStagePrefix(
  authority: DaemonStageNamespaceAuthority,
  reservationName: string,
  reservationIdentity: DaemonDirectoryIdentityV1,
  roots: DaemonProtocolRootIdentitiesV1,
  files: readonly DaemonCapturedFile[]
): void {
  assertDaemonStageAuthorityInventory(authority, reservationName)
  assertDirectoryIdentityV1(authority.paths.dataRoot, roots.dataRoot, 'daemon data root')
  assertDirectoryIdentityV1(authority.paths.reviewDirectory, roots.review, 'daemon review directory')
  assertDirectoryIdentityV1(authority.paths.stageDirectory, roots.stage, 'daemon stage namespace')
  const reservation = join(authority.paths.stageDirectory, reservationName)
  assertDirectoryIdentityV1(reservation, reservationIdentity, 'daemon start reservation')
  const expectedNames = files.map((file) => basename(file.file))
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
  const entries = boundedEntries(reservation, DAEMON_START_STAGE_PAYLOADS.length + 1, 'daemon start reservation')
  if (entries.length !== expectedNames.length || entries.some((entry, index) => entry.name !== expectedNames[index])
    || entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error('daemon start reservation prefix changed')
  }
  for (const file of files) assertFrozenDaemonFile(file, `daemon staged ${basename(file.file)}`, 1)
  assertStartPublicAbsent(authority.paths)
}

function assertManifestRoots(manifest: DaemonStageManifestV1, paths: DaemonProtocolPaths): void {
  assertDirectoryIdentityV1(paths.dataRoot, manifest.roots.dataRoot, 'daemon manifest data root')
  assertDirectoryIdentityV1(paths.reviewDirectory, manifest.roots.review, 'daemon manifest review directory')
  assertDirectoryIdentityV1(paths.stageDirectory, manifest.roots.stage, 'daemon manifest stage namespace')
  assertDirectoryIdentityV1(
    join(paths.stageDirectory, manifest.reservationName),
    manifest.roots.reservation,
    'daemon manifest reservation'
  )
}

function assertStartManifestBindsInstance(
  manifest: DaemonStartStageManifestV1,
  instance: DaemonInstanceRecordV1,
  instanceFile: DaemonCapturedFile
): void {
  assertIdentityMatches(manifest.instance, instanceFile, 'daemon staged instance')
  if (manifest.operationId !== instance.epochId || manifest.stageNamespaceId !== instance.stageNamespaceId
    || manifest.receiptSha256 !== instance.receiptSha256 || manifest.installId !== instance.installId
    || manifest.dataRootId !== instance.dataRootId || manifest.packageSha256 !== instance.packageSha256
    || manifest.packageVersion !== instance.packageVersion || !samePath(manifest.packageRoot, instance.packageRoot)
    || !samePath(manifest.dataRoot, instance.dataRoot)
    || manifest.actor.pid !== instance.pid || manifest.actor.processIdentity !== instance.processIdentity
    || manifest.actor.pgid !== instance.pgid || manifest.actor.createdAt !== instance.createdAt
    || JSON.stringify(manifest.projections) !== JSON.stringify(instance.projections)) {
    throw new Error('daemon start manifest does not bind its immutable instance')
  }
  if (JSON.stringify(manifest.roots.dataRoot) !== JSON.stringify(instance.authority.dataRoot)
    || JSON.stringify(manifest.roots.review) !== JSON.stringify(instance.authority.review)
    || JSON.stringify(manifest.roots.stage) !== JSON.stringify(instance.authority.stage)) {
    throw new Error('daemon start manifest roots do not bind the immutable instance authority')
  }
}

function inspectCompleteStartStage(privateStage: DaemonPrivateStartStage, publicationInFlight: DaemonCapturedFile | null = null): {
  publicFiles: Readonly<{ pid: DaemonCapturedFile | null; apiPid: DaemonCapturedFile | null; heartbeat: DaemonCapturedFile | null }>
  final: DaemonCapturedFile | null
} {
  assertDaemonStartStageIssuedView(privateStage)
  const publicationSignature = canonicalDaemonJson(privateStage.publication)
  const stage = privateStage.stage
  assertDaemonStageAuthorityInventory(stage.authority, stage.reservationName, publicationInFlight, privateStage)
  assertManifestRoots(stage.manifest, stage.authority.paths)
  const reservationEntries = boundedEntries(
    stage.reservationDirectory,
    DAEMON_START_STAGE_PAYLOADS.length + 1,
    'complete daemon start reservation'
  )
  const expectedNames = [...DAEMON_START_STAGE_PAYLOADS]
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
  if (reservationEntries.length !== expectedNames.length
    || reservationEntries.some((entry, index) => entry.name !== expectedNames[index])
    || reservationEntries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error('complete daemon start reservation inventory changed')
  }
  const publicFiles = {
    pid: optionalFile(stage.authority.paths.pidProjection, 128, 'daemon public PID projection', [2]),
    apiPid: optionalFile(stage.authority.paths.apiPidProjection, 128, 'daemon public API PID projection', [2]),
    heartbeat: optionalFile(
      stage.authority.paths.heartbeatProjection,
      DAEMON_INSTANCE_MAX_BYTES,
      'daemon public heartbeat projection',
      [2]
    )
  }
  for (const [name, source] of [
    ['pid', stage.files.pid],
    ['apiPid', stage.files.apiPid],
    ['heartbeat', stage.files.heartbeat]
  ] as const) {
    const published = publicFiles[name]
    const staged = assertFrozenDaemonFile(source, `daemon staged ${name} projection`, published ? 2 : 1)
    if (published && (published.state.dev !== staged.state.dev || published.state.ino !== staged.state.ino
      || !published.bytes.equals(staged.bytes))) {
      throw new Error(`daemon ${name} projection is not the exact staged hardlink`)
    }
  }
  const instance = assertFrozenDaemonFile(stage.files.instance, 'daemon staged instance', lstatOptional(stage.authority.paths.finalInstance) ? 2 : 1)
  const final = optionalFile(stage.authority.paths.finalInstance, DAEMON_INSTANCE_MAX_BYTES, 'daemon final instance', [2])
  if (final && (final.state.dev !== instance.state.dev || final.state.ino !== instance.state.ino
    || !final.bytes.equals(instance.bytes))) {
    throw new Error('daemon final instance is not the exact staged hardlink')
  }
  assertFrozenDaemonFile(stage.files.manifest, 'daemon start manifest', 1)
  assertRecordBindsReceipt(stage.instance, stage.authority.receipt, stage.authority.namespaceId)
  assertInstancePersistentAuthority(stage.instance, stage.authority)
  assertRecordBindsReceipt(stage.manifest, stage.authority.receipt, stage.authority.namespaceId)
  assertStartManifestBindsInstance(stage.manifest, stage.instance, instance)
  assertProjectionPayloads(stage.instance, {
    pid: assertFrozenDaemonFile(stage.files.pid, 'daemon staged PID projection', publicFiles.pid ? 2 : 1),
    apiPid: assertFrozenDaemonFile(stage.files.apiPid, 'daemon staged API PID projection', publicFiles.apiPid ? 2 : 1),
    heartbeat: assertFrozenDaemonFile(
      stage.files.heartbeat,
      'daemon staged heartbeat projection',
      publicFiles.heartbeat ? 2 : 1
    )
  })
  assertDaemonStartStageIssuedView(privateStage)
  if (canonicalDaemonJson(privateStage.publication) !== publicationSignature) {
    throw new Error('daemon start publication epoch changed while it was being sealed')
  }
  return { publicFiles, final }
}

export function assertDaemonStartStageCurrent(
  stage: DaemonStartStage,
  expectedInspection?: DaemonProtocolInspection
): void {
  const privateStage = privateDaemonStartStage(stage)
  const before = inspectCompleteStartStage(privateStage)
  if (!expectedInspection) return

  const frozenStage = privateStage.stage
  const options: InspectDaemonProtocolOptions = {
    home: frozenStage.authority.paths.home,
    dataRoot: frozenStage.authority.paths.dataRoot,
    platform: frozenStage.authority.platform,
    readReceiptAuthority: frozenStage.authority.readReceiptAuthority
  }
  const captured = capturePrivateDaemonInspection(options, expectedInspection)
  const inspection = captured.inspection
  const after = inspectCompleteStartStage(privateStage)
  const beforeCount = [before.publicFiles.pid, before.publicFiles.apiPid, before.publicFiles.heartbeat]
    .filter(Boolean).length
  const afterCount = [after.publicFiles.pid, after.publicFiles.apiPid, after.publicFiles.heartbeat]
    .filter(Boolean).length
  if ((inspection.kind !== 'STARTING' && inspection.kind !== 'RUNNING-LINKED')
    || inspection.recoveryAuthority !== 'START'
    || inspection.namespaceId !== frozenStage.authority.namespaceId
    || canonicalDaemonJson(inspection.paths) !== canonicalDaemonJson(frozenStage.authority.paths)
    || canonicalDaemonJson(inspection.receipt) !== canonicalDaemonJson(frozenStage.authority.receipt.receipt)
    || inspection.reservation?.name !== frozenStage.reservationName
    || inspection.reservation?.operationId !== frozenStage.binding.operationId
    || canonicalDaemonJson(inspection.instance) !== canonicalDaemonJson(frozenStage.instance)
    || canonicalDaemonJson(inspection.manifest) !== canonicalDaemonJson(frozenStage.manifest)
    || beforeCount !== afterCount || Boolean(before.final) !== Boolean(after.final)
    || inspection.publicProjectionCount !== afterCount
    || Boolean(after.final) !== (inspection.kind === 'RUNNING-LINKED')) {
    throw new Error('daemon start inspection does not bind the issued stage epoch')
  }
}

function finishDaemonStartPendingPublication(
  privateStage: DaemonPrivateStartStage,
  key: keyof DaemonStartPublicationEpoch,
  checkpoint: DaemonProtocolCheckpoint,
  label: string
): DaemonCapturedFile | null {
  const stage = privateStage.stage
  const epoch = privateStage.publication
  const slot = epoch[key]
  if (slot.phase === 'PUBLISHED') {
    assertCapturedCurrent(slot.target, `${label} published target`, [slot.target.state.nlink])
    return cloneDaemonCapturedFile(slot.target)
  }
  if (slot.phase !== 'LINKED') return null
  const target = daemonStartPublicationPaths(stage.authority)[key]
  const pendingTarget = captureDaemonStartLinkedPair(slot.source, target, key)
  if (!sameOptionalCaptured(pendingTarget, slot.target)) {
    throw new Error(`${label} changed before recovery durability flush`)
  }
  inspectCompleteStartStage(privateStage)
  flushDirectory(dirname(target))
  checkpoint('daemon-hardlink-parent-fsynced', { label, target })
  inspectCompleteStartStage(privateStage)
  const durableTarget = captureDaemonStartLinkedPair(slot.source, target, key)
  advanceDaemonStartPublicationEpoch(privateStage, key, durableTarget)
  inspectCompleteStartStage(privateStage)
  return cloneDaemonCapturedFile(durableTarget)
}

function settleDaemonStartPublicationPredecessors(
  privateStage: DaemonPrivateStartStage,
  predecessors: readonly (keyof DaemonStartPublicationEpoch)[],
  checkpoint: DaemonProtocolCheckpoint
): void {
  const epoch = privateStage.publication
  for (const key of predecessors) {
    if (epoch[key].phase === 'LINKED') {
      finishDaemonStartPendingPublication(
        privateStage,
        key,
        checkpoint,
        `daemon ${key} publication predecessor`
      )
    }
    if (epoch[key].phase !== 'PUBLISHED') {
      throw new Error(`daemon start ${key} predecessor is not durably published`)
    }
  }
}

export function createDaemonStartStage(
  authority: DaemonStageNamespaceAuthority,
  options: CreateDaemonStartStageOptions
): DaemonStartStage {
  // Caller objects may expose getters or be mutated from a checkpoint. Capture
  // each field exactly once and normalize every scalar before the first file
  // system mutation so no later read can silently retarget the issued stage.
  const rawEpochId = options.epochId
  const rawPid = options.pid
  const rawApiPid = options.apiPid
  const rawProcessIdentity = options.processIdentity
  const rawPgid = options.pgid
  const rawPort = options.port
  const rawCreatedAt = options.createdAt
  const rawCheckpoint = options.checkpoint
  const epochId = uuid(rawEpochId, 'daemon epoch id')
  const actorPid = positiveInteger(rawPid, 'daemon PID')
  const apiPid = positiveInteger(rawApiPid, 'daemon API PID')
  if (apiPid !== actorPid) throw new Error('daemon v1 API PID must equal its daemon PID')
  const processIdentity = boundedText(rawProcessIdentity, 'daemon process identity', 512)
  if (!SAFE_PROCESS_IDENTITY.test(processIdentity)) throw new Error('daemon process identity is not portable')
  const pgid = positiveInteger(rawPgid, 'daemon process group')
  const port = portNumber(rawPort)
  if (!canonicalIso(rawCreatedAt)) throw new Error('daemon creation time is not canonical')
  const createdAt = rawCreatedAt
  if (rawCheckpoint !== undefined && typeof rawCheckpoint !== 'function') {
    throw new Error('daemon checkpoint is invalid')
  }
  const checkpoint = rawCheckpoint || (() => {})
  const capturedAuthority = capturePrivateDaemonStageNamespaceAuthority(authority)
  const privateAuthority = capturedAuthority.authority
  if (privateAuthority.reservationName) throw new Error('daemon start requires an empty stage namespace authority')
  const receipt = privateAuthority.receipt.receipt
  const dataRootStat = assertPlainDirectory(privateAuthority.paths.dataRoot, 'daemon data root')
  const reviewStat = assertPlainDirectory(privateAuthority.paths.reviewDirectory, 'daemon review directory')
  const stageStat = assertPlainDirectory(privateAuthority.paths.stageDirectory, 'daemon stage namespace')
  if (dataRootStat.dev !== reviewStat.dev || dataRootStat.dev !== stageStat.dev) {
    throw new Error('daemon stage, review, and data roots must share one local volume')
  }
  if (!privateAuthority.reviewDirectoryState
    || !sameFileState(fileState(dataRootStat), privateAuthority.dataRootState)
    || reviewStat.dev !== privateAuthority.reviewDirectoryState.dev || reviewStat.ino !== privateAuthority.reviewDirectoryState.ino
    || stageStat.dev !== privateAuthority.stageDirectoryState.dev || stageStat.ino !== privateAuthority.stageDirectoryState.ino) {
    throw new Error('daemon start roots changed after namespace bootstrap')
  }
  const persistentAuthority = persistentAuthorityForStart(privateAuthority)
  assertStartPublicAbsent(privateAuthority.paths)
  const binding: DaemonReservationBinding = {
    stageNamespaceId: privateAuthority.namespaceId,
    receiptSha256: privateAuthority.receipt.receiptSha256,
    installId: receipt.installId,
    dataRootId: receipt.dataRootId,
    operationId: epochId,
    actorPid,
    actorProcessIdentity: processIdentity,
    actorPgid: pgid,
    operation: 'start',
    packageSha256: receipt.packageSha256 as DaemonSha256,
    createdAt
  }
  const reservationName = daemonReservationName(binding)
  const reservationDirectory = join(privateAuthority.paths.stageDirectory, reservationName)
  if (lstatOptional(reservationDirectory)) throw new Error('daemon start reservation already exists')
  capturedAuthority.assertCallerViewCurrent()
  assertDaemonStageNamespaceAuthority(privateAuthority)
  capturedAuthority.assertCallerViewCurrent()
  fs.mkdirSync(reservationDirectory)
  const reservationStat = assertPlainDirectory(reservationDirectory, 'daemon start reservation')
  const reservationIdentity = daemonDirectoryIdentity(reservationStat)
  const stageAuthority: DaemonStageNamespaceAuthority = {
    ...privateAuthority,
    reservationName,
    recoveredInspectionScope: privateAuthority.recoveredInspection ? 'EXTERNAL' : privateAuthority.recoveredInspectionScope
  }
  const roots: DaemonProtocolRootIdentitiesV1 = {
    dataRoot: persistentAuthority.dataRoot,
    review: persistentAuthority.review,
    stage: persistentAuthority.stage,
    reservation: reservationIdentity
  }
  const assertPrivateStartStagePrefix = (files: readonly DaemonCapturedFile[]): void => {
    capturedAuthority.assertCallerViewCurrent()
    assertStartStagePrefix(stageAuthority, reservationName, reservationIdentity, roots, files)
    capturedAuthority.assertCallerViewCurrent()
  }
  checkpoint('daemon-start-reservation-directory-created', { reservationName })
  assertPrivateStartStagePrefix([])
  flushDirectory(stageAuthority.paths.stageDirectory)
  checkpoint('daemon-start-reservation-parent-fsynced', { reservationName })
  assertPrivateStartStagePrefix([])

  const writeStageFile = (
    file: string,
    bytes: Buffer,
    maximumBytes: number,
    label: string,
    prior: readonly DaemonCapturedFile[]
  ) => writeDaemonFileExclusiveDurable(
    file,
    bytes,
    maximumBytes,
    label,
    checkpoint,
    (inFlight) => assertPrivateStartStagePrefix([...prior, ...(inFlight ? [inFlight] : [])])
  )

  const pidBytes = Buffer.from(`${binding.actorPid}\n`, 'utf8')
  const apiPidBytes = Buffer.from(`${apiPid}\n`, 'utf8')
  const heartbeat = heartbeatBytes({
    pid: binding.actorPid,
    apiPid,
    hubRoot: resolve(receipt.dataRoot),
    packageRoot: resolve(receipt.packageRoot),
    dataRoot: resolve(receipt.dataRoot),
    port,
    apiHealthy: true,
    lastBeat: binding.createdAt
  })
  const pidFile = writeStageFile(
    join(reservationDirectory, 'daemon.pid'), pidBytes, 128, 'daemon staged PID projection', []
  )
  assertPrivateStartStagePrefix([pidFile])
  checkpoint('daemon-start-pid-projection', { reservationName })
  assertPrivateStartStagePrefix([pidFile])
  const apiPidFile = writeStageFile(
    join(reservationDirectory, 'api.pid'), apiPidBytes, 128, 'daemon staged API PID projection', [pidFile]
  )
  assertPrivateStartStagePrefix([pidFile, apiPidFile])
  checkpoint('daemon-start-api-projection', { reservationName })
  assertPrivateStartStagePrefix([pidFile, apiPidFile])
  const heartbeatFile = writeStageFile(
    join(reservationDirectory, 'daemon-heartbeat.json'), heartbeat, DAEMON_INSTANCE_MAX_BYTES,
    'daemon staged heartbeat projection', [pidFile, apiPidFile]
  )
  assertPrivateStartStagePrefix([pidFile, apiPidFile, heartbeatFile])
  checkpoint('daemon-start-heartbeat-projection', { reservationName })
  assertPrivateStartStagePrefix([pidFile, apiPidFile, heartbeatFile])
  const projections: DaemonProjectionIdentitiesV1 = {
    pid: daemonFileIdentity(pidFile),
    apiPid: daemonFileIdentity(apiPidFile),
    heartbeat: daemonFileIdentity(heartbeatFile)
  }
  const instance: DaemonInstanceRecordV1 = validateDaemonInstanceRecord({
    schemaVersion: DAEMON_PROTOCOL_VERSION,
    product: PRODUCT_NAME,
    epochId: binding.operationId,
    stageNamespaceId: binding.stageNamespaceId,
    receiptSha256: binding.receiptSha256,
    installId: binding.installId,
    dataRootId: binding.dataRootId,
    packageRoot: resolve(receipt.packageRoot),
    packageVersion: receipt.packageVersion,
    packageSha256: receipt.packageSha256,
    dataRoot: resolve(receipt.dataRoot),
    port,
    pid: binding.actorPid,
    apiPid,
    processIdentity: binding.actorProcessIdentity,
    pgid: binding.actorPgid,
    createdAt: binding.createdAt,
    projections,
    authority: persistentAuthority
  })
  const instanceFile = writeStageFile(
    join(reservationDirectory, 'daemon-instance-v1.json'),
    daemonInstanceRecordBytes(instance),
    DAEMON_INSTANCE_MAX_BYTES,
    'daemon staged instance',
    [pidFile, apiPidFile, heartbeatFile]
  )
  const prefix = [pidFile, apiPidFile, heartbeatFile, instanceFile] as const
  assertPrivateStartStagePrefix(prefix)
  checkpoint('daemon-start-instance', { reservationName })
  assertPrivateStartStagePrefix(prefix)
  const manifest = validateDaemonStageManifest({
    schemaVersion: DAEMON_PROTOCOL_VERSION,
    product: PRODUCT_NAME,
    operation: 'start',
    reservationName,
    stageNamespaceId: binding.stageNamespaceId,
    receiptSha256: binding.receiptSha256,
    installId: binding.installId,
    dataRootId: binding.dataRootId,
    operationId: binding.operationId,
    packageRoot: instance.packageRoot,
    packageVersion: instance.packageVersion,
    packageSha256: instance.packageSha256,
    dataRoot: instance.dataRoot,
    actor: {
      pid: binding.actorPid,
      processIdentity: binding.actorProcessIdentity,
      pgid: binding.actorPgid,
      createdAt: binding.createdAt
    },
    instance: daemonFileIdentity(instanceFile),
    projections,
    roots
  }) as DaemonStartStageManifestV1
  const manifestFile = writeStageFile(
    join(reservationDirectory, 'stage-manifest-v1.json'),
    daemonStageManifestBytes(manifest),
    DAEMON_STAGE_MANIFEST_MAX_BYTES,
    'daemon start stage manifest',
    prefix
  )
  assertPrivateStartStagePrefix([...prefix, manifestFile])
  checkpoint('daemon-start-manifest-durable', { reservationName })
  assertPrivateStartStagePrefix([...prefix, manifestFile])
  const publicationAuthority: DaemonStageNamespaceAuthority = {
    ...stageAuthority,
    recoveredInspectionScope: 'START'
  }
  const publication: DaemonStartPublicationEpoch = {
    pid: { phase: 'ABSENT' },
    apiPid: { phase: 'ABSENT' },
    heartbeat: { phase: 'ABSENT' },
    final: { phase: 'ABSENT' }
  }
  const issued = issueDaemonStartStage({
    authority: publicationAuthority,
    binding,
    reservationName,
    reservationDirectory,
    instance,
    manifest,
    files: { pid: pidFile, apiPid: apiPidFile, heartbeat: heartbeatFile, instance: instanceFile, manifest: manifestFile }
  }, publication)
  inspectCompleteStartStage(privateDaemonStartStage(issued))
  return issued
}

export function publishDaemonStartProjection(
  stage: DaemonStartStage,
  projection: 'pid' | 'apiPid' | 'heartbeat',
  checkpoint: DaemonProtocolCheckpoint = () => {}
): DaemonCapturedFile {
  const privateStage = privateDaemonStartStage(stage)
  const frozenStage = privateStage.stage
  let before = inspectCompleteStartStage(privateStage)
  const label = `daemon ${projection} projection publication`
  if (before.publicFiles[projection]) {
    const recovered = finishDaemonStartPendingPublication(privateStage, projection, checkpoint, label)
    if (recovered) return recovered
    throw new Error(`daemon ${projection} projection is already public without its owned epoch`)
  }
  const publicationOrder = ['pid', 'apiPid', 'heartbeat'] as const
  const projectionIndex = publicationOrder.indexOf(projection)
  settleDaemonStartPublicationPredecessors(privateStage, publicationOrder.slice(0, projectionIndex), checkpoint)
  before = inspectCompleteStartStage(privateStage)
  const present = publicationOrder.map((name) => Boolean(before.publicFiles[name]))
  const prefixLength = present.findIndex((value) => !value)
  const publishedCount = prefixLength < 0 ? publicationOrder.length : prefixLength
  if (present.some((value, index) => value !== (index < publishedCount))) {
    throw new Error('daemon public projections are not a canonical publication prefix')
  }
  if (projection !== publicationOrder[publishedCount]) {
    throw new Error(`daemon public projection order requires ${publicationOrder[publishedCount] || 'final instance'}`)
  }
  const source = frozenStage.files[projection]
  const target = projection === 'pid' ? frozenStage.authority.paths.pidProjection
    : projection === 'apiPid' ? frozenStage.authority.paths.apiPidProjection
      : frozenStage.authority.paths.heartbeatProjection
  beginDaemonStartPublicationEpoch(privateStage, projection, source)
  const published = linkDaemonFileNoReplaceDurable(
    source,
    target,
    label,
    checkpoint,
    (inFlight) => {
      if (inFlight) recordDaemonStartLinkedPublication(privateStage, projection, source, inFlight)
      inspectCompleteStartStage(privateStage, inFlight)
    }
  )
  advanceDaemonStartPublicationEpoch(privateStage, projection, published)
  inspectCompleteStartStage(privateStage)
  return cloneDaemonCapturedFile(published)
}

export function commitDaemonStartInstance(
  stage: DaemonStartStage,
  checkpoint: DaemonProtocolCheckpoint = () => {}
): DaemonCapturedFile {
  const privateStage = privateDaemonStartStage(stage)
  const frozenStage = privateStage.stage
  let before = inspectCompleteStartStage(privateStage)
  if (before.final) {
    const recovered = finishDaemonStartPendingPublication(
      privateStage,
      'final',
      checkpoint,
      'daemon final instance publication'
    )
    if (recovered) return recovered
    throw new Error('daemon final instance is already public without its owned epoch')
  }
  settleDaemonStartPublicationPredecessors(privateStage, ['pid', 'apiPid', 'heartbeat'], checkpoint)
  before = inspectCompleteStartStage(privateStage)
  if (!before.publicFiles.pid || !before.publicFiles.apiPid || !before.publicFiles.heartbeat) {
    throw new Error('daemon final instance requires all exact public projection hardlinks')
  }
  beginDaemonStartPublicationEpoch(privateStage, 'final', frozenStage.files.instance)
  const final = linkDaemonFileNoReplaceDurable(
    frozenStage.files.instance,
    frozenStage.authority.paths.finalInstance,
    'daemon final instance publication',
    checkpoint,
    (inFlight) => {
      if (inFlight) recordDaemonStartLinkedPublication(privateStage, 'final', frozenStage.files.instance, inFlight)
      inspectCompleteStartStage(privateStage, inFlight)
    }
  )
  advanceDaemonStartPublicationEpoch(privateStage, 'final', final)
  const after = inspectCompleteStartStage(privateStage)
  if (!after.final) throw new Error('daemon final instance publication did not reach linked state')
  return cloneDaemonCapturedFile(final)
}

function assertReservationNameBindsReceipt(
  reservation: ParsedDaemonReservationName,
  receipt: DaemonReceiptNamespaceSnapshot,
  namespaceId: string
): void {
  if (reservation.stageNamespaceId !== namespaceId
    || reservation.receiptSha24 !== digestHex(receipt.receiptSha256).slice(0, 24)
    || reservation.installId !== receipt.receipt.installId
    || reservation.dataRootId !== receipt.receipt.dataRootId
    || reservation.packageSha12 !== digestHex(receipt.receipt.packageSha256 as DaemonSha256).slice(0, 12)) {
    throw new Error('daemon reservation basename does not bind the active receipt authority')
  }
}

function readBoundLifecycleOwnerAuthority(
  manifest: DaemonStopStageManifestV1 | DaemonLegacyRetireStageManifestV1,
  receipt: DaemonReceiptNamespaceSnapshot,
  reader: DaemonLifecycleOwnerAuthorityReader | undefined
): DaemonLifecycleOwnerAuthoritySnapshot | null {
  const binding = manifest.lifecycleOwnerBinding
  if (!binding) return null
  if (!reader) throw new Error('daemon lifecycle-driven control stage has no lifecycle-owner authority reader')
  if (!receipt.ownerStageAuthorityMarker || !receipt.ownerStageNamespaceId
    || binding.ownerStageNamespaceId !== receipt.ownerStageNamespaceId) {
    throw new Error('daemon lifecycle-owner binding does not match the active owner-stage receipt authority')
  }
  const authority = reader(binding)
  if (authority.lockToken !== binding.lockToken || authority.operation !== binding.operation
    || authority.ownerStageNamespaceId !== binding.ownerStageNamespaceId
    || authority.receiptSha256 !== binding.receiptSha256 || authority.installId !== binding.installId
    || authority.dataRootId !== binding.dataRootId) {
    throw new Error('daemon lifecycle-owner authority does not match its durable binding')
  }
  assertIdentityMatches(binding.ownerRecord, authority.ownerRecord, 'daemon lifecycle-owner record')
  const ownerInProof = authority.files.some((file) => samePath(file.file, authority.ownerRecord.file)
    && file.state.dev === authority.ownerRecord.state.dev && file.state.ino === authority.ownerRecord.state.ino)
  if (!ownerInProof) throw new Error('daemon lifecycle-owner proof omits its bound owner record')
  return authority
}

function assertPersistentAuthoritySnapshot(
  instance: DaemonInstanceRecordV1,
  receipt: DaemonReceiptNamespaceSnapshot,
  dataRoot: fs.Stats,
  review: fs.Stats,
  stage: fs.Stats,
  innerMarker: DaemonCapturedFile
): void {
  const expected: DaemonPersistentAuthorityV1 = validatePersistentAuthority({
    homeIdentity: receipt.homeIdentity,
    receiptDirectory: daemonDirectoryIdentity(receipt.directoryState),
    receiptInventory: receipt.entries,
    receiptNamespaceMarker: daemonFileIdentity(receipt.namespaceMarker),
    receipt: daemonFileIdentity(receipt.receiptFile),
    ownerStageAuthority: receipt.ownerStageAuthorityMarker
      ? daemonFileIdentity(receipt.ownerStageAuthorityMarker)
      : null,
    daemonStageAuthority: receipt.daemonAuthorityMarker
      ? daemonFileIdentity(receipt.daemonAuthorityMarker)
      : (() => { throw new Error('daemon instance has no HOME stage authority') })(),
    dataRoot: daemonDirectoryIdentity(dataRoot),
    review: daemonDirectoryIdentity(review),
    stage: daemonDirectoryIdentity(stage),
    innerMarker: daemonFileIdentity(innerMarker)
  })
  if (JSON.stringify(instance.authority) !== JSON.stringify(expected)) {
    throw new Error('daemon instance persistent authority does not match current roots and receipt namespace')
  }
}

function capturePublicProjectionSet(paths: DaemonProtocolPaths): {
  pid: DaemonCapturedFile | null
  apiPid: DaemonCapturedFile | null
  heartbeat: DaemonCapturedFile | null
} {
  return {
    pid: optionalFile(paths.pidProjection, 128, 'daemon public PID projection', [1, 2]),
    apiPid: optionalFile(paths.apiPidProjection, 128, 'daemon public API PID projection', [1, 2]),
    heartbeat: optionalFile(paths.heartbeatProjection, DAEMON_INSTANCE_MAX_BYTES, 'daemon public heartbeat projection', [1, 2])
  }
}

function projectionPrefixCount(projections: {
  pid: DaemonCapturedFile | null
  apiPid: DaemonCapturedFile | null
  heartbeat: DaemonCapturedFile | null
}): number {
  const present = [Boolean(projections.pid), Boolean(projections.apiPid), Boolean(projections.heartbeat)]
  const count = present.filter(Boolean).length
  if (present.some((value, index) => value !== (index < count))) {
    throw new Error('daemon public compatibility projections are not a canonical publication prefix')
  }
  return count
}

function assertLegacyProjectionSet(
  projections: { pid: DaemonCapturedFile; apiPid: DaemonCapturedFile; heartbeat: DaemonCapturedFile },
  dataRoot: string
): void {
  const pid = parsePidProjection(projections.pid, 'legacy daemon PID projection')
  const apiPid = parsePidProjection(projections.apiPid, 'legacy daemon API PID projection')
  const heartbeat = parseHeartbeatProjection(projections.heartbeat)
  if (heartbeat.pid !== pid || heartbeat.apiPid !== apiPid || !samePath(heartbeat.dataRoot, dataRoot)) {
    throw new Error('legacy daemon projections do not describe one canonical instance')
  }
}

function assertLegacyProjectionSubset(
  projections: { pid: DaemonCapturedFile | null; apiPid: DaemonCapturedFile | null; heartbeat: DaemonCapturedFile | null },
  dataRoot: string
): void {
  const pid = projections.pid ? parsePidProjection(projections.pid, 'legacy daemon PID projection') : null
  const apiPid = projections.apiPid ? parsePidProjection(projections.apiPid, 'legacy daemon API PID projection') : null
  const heartbeat = projections.heartbeat ? parseHeartbeatProjection(projections.heartbeat) : null
  if (heartbeat && ((pid !== null && heartbeat.pid !== pid) || (apiPid !== null && heartbeat.apiPid !== apiPid)
    || !samePath(heartbeat.dataRoot, dataRoot))) {
    throw new Error('legacy daemon projection subset is internally inconsistent')
  }
}

function assertUniqueLegacyProjectionSubset(
  projections: { pid: DaemonCapturedFile | null; apiPid: DaemonCapturedFile | null; heartbeat: DaemonCapturedFile | null },
  dataRoot: string
): number {
  const files = [projections.pid, projections.apiPid, projections.heartbeat].filter(Boolean) as DaemonCapturedFile[]
  if (files.some((file) => file.state.nlink !== 1)) {
    throw new Error('legacy daemon projection subset contains a non-unique inode')
  }
  if (files.length) assertLegacyProjectionSubset(projections, dataRoot)
  return files.length
}

function assertControlProjectionSubset(
  target: Pick<DaemonStopTargetV1 | DaemonLegacyTargetV1, 'pid' | 'apiPid' | 'port'>,
  projections: { pid: DaemonCapturedFile | null; apiPid: DaemonCapturedFile | null; heartbeat: DaemonCapturedFile | null },
  dataRoot: string,
  packageRoot: string,
  requireHealthy: boolean,
  expectedLastBeat: string | null = null
): void {
  if (projections.pid && parsePidProjection(projections.pid, 'daemon control PID projection') !== target.pid) {
    throw new Error('daemon control PID projection does not bind its target')
  }
  if (projections.apiPid && parsePidProjection(projections.apiPid, 'daemon control API PID projection') !== target.apiPid) {
    throw new Error('daemon control API PID projection does not bind its target')
  }
  if (projections.heartbeat) {
    const heartbeat = parseHeartbeatProjection(projections.heartbeat)
    if (heartbeat.pid !== target.pid || heartbeat.apiPid !== target.apiPid || heartbeat.port !== target.port
      || !samePath(heartbeat.dataRoot, dataRoot) || !samePath(heartbeat.packageRoot, packageRoot)
      || requireHealthy && heartbeat.apiHealthy !== true
      || expectedLastBeat !== null && heartbeat.lastBeat !== expectedLastBeat) {
      throw new Error('daemon control heartbeat projection does not bind its target')
    }
  }
}

function protocolProof(
  platform: string,
  reader: DaemonReceiptAuthorityReader | null,
  receipt: DaemonReceiptNamespaceSnapshot | null,
  files: readonly (DaemonCapturedFile | null)[],
  directories: readonly DaemonCapturedDirectory[],
  absent: readonly string[],
  directoryIdentities: readonly DaemonCapturedDirectoryIdentity[] = []
): DaemonProtocolFrozenProof {
  return {
    platform,
    readReceiptAuthority: reader,
    receipt,
    files: uniqueByPath(files.filter(Boolean) as DaemonCapturedFile[]),
    directories: uniqueByPath(directories),
    directoryIdentities: uniqueByPath(directoryIdentities),
    absent: [...new Set(absent.map((file) => resolve(file)))]
  }
}

function daemonInspection(
  kind: DaemonProtocolKind,
  paths: DaemonProtocolPaths,
  proof: DaemonProtocolFrozenProof,
  facts: Partial<Omit<DaemonProtocolInspection, 'kind' | 'reason' | 'paths' | 'proof'>> = {},
  reason: string | null = null
): DaemonProtocolInspection {
  return {
    kind,
    reason,
    paths,
    namespaceId: facts.namespaceId ?? null,
    receipt: facts.receipt ?? null,
    reservation: facts.reservation ?? null,
    instance: facts.instance ?? null,
    manifest: facts.manifest ?? null,
    publicProjectionCount: facts.publicProjectionCount ?? 0,
    stagePayloadCount: facts.stagePayloadCount ?? 0,
    recoveryAuthority: facts.recoveryAuthority ?? 'NONE',
    proof
  }
}

function invalidDaemonInspection(paths: DaemonProtocolPaths, platform: string, error: unknown): DaemonProtocolInspection {
  return daemonInspection(
    'INVALID',
    paths,
    protocolProof(platform, null, null, [], [], []),
    {},
    error instanceof Error ? error.message : String(error)
  )
}

function assertStartTopology(
  instance: DaemonInstanceRecordV1,
  staged: { pid: DaemonCapturedFile | null; apiPid: DaemonCapturedFile | null; heartbeat: DaemonCapturedFile | null },
  published: { pid: DaemonCapturedFile | null; apiPid: DaemonCapturedFile | null; heartbeat: DaemonCapturedFile | null },
  final: DaemonCapturedFile | null,
  stagedInstance: DaemonCapturedFile | null
): void {
  for (const [name, identity] of [
    ['pid', instance.projections.pid],
    ['apiPid', instance.projections.apiPid],
    ['heartbeat', instance.projections.heartbeat]
  ] as const) {
    const source = staged[name]
    const target = published[name]
    if (source) assertIdentityMatches(identity, source, `daemon staged ${name} projection`)
    if (target) assertIdentityMatches(identity, target, `daemon public ${name} projection`)
    if (source && target) {
      if (source.state.nlink !== 2 || target.state.nlink !== 2
        || source.state.dev !== target.state.dev || source.state.ino !== target.state.ino) {
        throw new Error(`daemon ${name} projection is not an exact hardlink pair`)
      }
    } else if ((source && source.state.nlink !== 1) || (target && target.state.nlink !== 1)) {
      throw new Error(`daemon ${name} projection has an invalid collapse link count`)
    }
  }
  if (stagedInstance) {
    if (final) {
      if (stagedInstance.state.nlink !== 2 || final.state.nlink !== 2
        || stagedInstance.state.dev !== final.state.dev || stagedInstance.state.ino !== final.state.ino) {
        throw new Error('daemon instance is not an exact staged/final hardlink pair')
      }
    } else if (stagedInstance.state.nlink !== 1) throw new Error('staged daemon instance has an invalid link count')
  } else if (final?.state.nlink !== 1) {
    throw new Error('collapsed daemon final instance has an invalid link count')
  }
}

export function inspectDaemonProtocol(options: InspectDaemonProtocolOptions): DaemonProtocolInspection {
  const platform = options.platform || process.platform
  const paths = daemonProtocolPaths(options.home, options.dataRoot)
  try {
    assertPlainAncestorChain(paths.home, 'daemon protocol HOME')
    assertPlainAncestorChain(paths.dataRoot, 'daemon protocol data root')
    const dataRootEntry = lstatOptional(paths.dataRoot)
    const dataRootState = dataRootEntry
      ? fileState(assertPlainDirectory(paths.dataRoot, 'daemon protocol data root'))
      : null
    const ancestorIdentities = uniqueByPath([
      ...capturePlainAncestorIdentities(paths.home, 'daemon protocol HOME'),
      ...capturePlainAncestorIdentities(paths.dataRoot, 'daemon protocol data root')
    ]) as readonly DaemonCapturedDirectoryIdentity[]
    const receiptDirectoryStat = lstatOptional(paths.receiptDirectory)
    let daemonReceiptEntrySeen = false
    let receiptDirectorySnapshot: DaemonCapturedDirectory | null = null
    if (receiptDirectoryStat) {
      receiptDirectorySnapshot = captureDaemonDirectory(
        paths.receiptDirectory,
        DAEMON_RECEIPT_NAMESPACE_MAX_ENTRIES + 1,
        'daemon receipt namespace discovery'
      )
      daemonReceiptEntrySeen = receiptDirectorySnapshot.entries.some((entry) =>
        entry.name.toLowerCase().startsWith('.daemon-stage-namespace-v1.'))
    }
    const stageVisible = Boolean(lstatOptional(paths.stageDirectory))
    const finalVisible = Boolean(lstatOptional(paths.finalInstance))
    const v1Visible = daemonReceiptEntrySeen || stageVisible || finalVisible
    const reviewState = lstatOptional(paths.reviewDirectory)
      ? fileState(assertPlainDirectory(paths.reviewDirectory, 'daemon review directory'))
      : null
    const rootIdentities = uniqueByPath([
      ...ancestorIdentities,
      ...(reviewState ? [{ directory: paths.reviewDirectory, state: reviewState }] : [])
    ]) as readonly DaemonCapturedDirectoryIdentity[]
    const publicProjections = capturePublicProjectionSet(paths)

    if (!v1Visible) {
      const count = [publicProjections.pid, publicProjections.apiPid, publicProjections.heartbeat].filter(Boolean).length
      const absent = [
        paths.stageDirectory,
        paths.finalInstance,
        ...(!receiptDirectorySnapshot ? [paths.receiptDirectory] : []),
        ...(!reviewState ? [paths.reviewDirectory] : []),
        ...(!dataRootState ? [paths.dataRoot] : []),
        ...(!publicProjections.pid ? [paths.pidProjection] : []),
        ...(!publicProjections.apiPid ? [paths.apiPidProjection] : []),
        ...(!publicProjections.heartbeat ? [paths.heartbeatProjection] : [])
      ]
      const proof = protocolProof(
        platform,
        null,
        null,
        [publicProjections.pid, publicProjections.apiPid, publicProjections.heartbeat],
        [receiptDirectorySnapshot].filter(Boolean) as DaemonCapturedDirectory[],
        absent,
        rootIdentities
      )
      if (count === 0) return daemonInspection('ABSENT', paths, proof)
      assertUniqueLegacyProjectionSubset(publicProjections, paths.dataRoot)
      return daemonInspection('LEGACY', paths, proof, { publicProjectionCount: count })
    }

    const receipt = inspectDaemonReceiptNamespace(
      options.home,
      options.dataRoot,
      options.readReceiptAuthority,
      platform
    )
    if (!receipt.daemonStageNamespaceId || !receipt.daemonAuthorityMarker) {
      throw new Error('daemon v1 residue has no independent HOME authority')
    }
    if (!dataRootState) throw new Error('daemon v1 authority has no data root')
    const namespaceId = receipt.daemonStageNamespaceId
    const dataRootStat = assertPlainDirectory(paths.dataRoot, 'daemon data root')
    const publicCount = [publicProjections.pid, publicProjections.apiPid, publicProjections.heartbeat]
      .filter(Boolean).length
    if (!stageVisible) {
      if (finalVisible) throw new Error('daemon final state exists before its stage namespace')
      if (publicCount) assertUniqueLegacyProjectionSubset(publicProjections, paths.dataRoot)
      return daemonInspection(
        publicCount ? 'LEGACY-NAMESPACE-RECOVERABLE' : 'NAMESPACE-RECOVERABLE',
        paths,
        protocolProof(platform, options.readReceiptAuthority, receipt,
          [publicProjections.pid, publicProjections.apiPid, publicProjections.heartbeat], [],
          [paths.stageDirectory, paths.finalInstance,
            ...(!publicProjections.pid ? [paths.pidProjection] : []),
            ...(!publicProjections.apiPid ? [paths.apiPidProjection] : []),
            ...(!publicProjections.heartbeat ? [paths.heartbeatProjection] : []),
            ...(!reviewState ? [paths.reviewDirectory] : [])], rootIdentities),
        { namespaceId, receipt: receipt.receipt, publicProjectionCount: publicCount }
      )
    }
    const stageStat = assertPlainDirectory(paths.stageDirectory, 'daemon stage namespace')
    const stageSnapshot = captureDaemonDirectory(paths.stageDirectory, DAEMON_STAGE_NAMESPACE_MAX_ENTRIES, 'daemon stage namespace')
    const innerPath = daemonInnerNamespaceMarker(paths, namespaceId)
    const innerEntry = stageSnapshot.entries.find((entry) => entry.name === basename(innerPath))
    if (!innerEntry) {
      if (stageSnapshot.entries.length || finalVisible) {
        throw new Error('daemon stage namespace has no exact inner marker')
      }
      if (publicCount) assertUniqueLegacyProjectionSubset(publicProjections, paths.dataRoot)
      return daemonInspection(
        publicCount ? 'LEGACY-NAMESPACE-RECOVERABLE' : 'NAMESPACE-RECOVERABLE',
        paths,
        protocolProof(platform, options.readReceiptAuthority, receipt,
          [publicProjections.pid, publicProjections.apiPid, publicProjections.heartbeat],
          [stageSnapshot], [innerPath, paths.finalInstance,
          ...(!publicProjections.pid ? [paths.pidProjection] : []),
          ...(!publicProjections.apiPid ? [paths.apiPidProjection] : []),
          ...(!publicProjections.heartbeat ? [paths.heartbeatProjection] : []),
          ...(!reviewState ? [paths.reviewDirectory] : [])], rootIdentities),
        { namespaceId, receipt: receipt.receipt, publicProjectionCount: publicCount }
      )
    }
    if (innerEntry.kind !== 'file') throw new Error('daemon stage inner marker is not a plain file')
    const innerMarker = captureDaemonProtocolFile(innerPath, 0, 'daemon stage inner marker')
    const reservationEntries = stageSnapshot.entries.filter((entry) => entry.name !== basename(innerPath))
    if (reservationEntries.length > 1 || reservationEntries.some((entry) => entry.kind !== 'directory')) {
      throw new Error('daemon stage namespace contains multiple or non-directory reservations')
    }
    const commonDirectories = [stageSnapshot]
    if (!reservationEntries.length) {
      const final = optionalFile(paths.finalInstance, DAEMON_INSTANCE_MAX_BYTES, 'daemon final instance', [1])
      const files = [innerMarker, final, publicProjections.pid, publicProjections.apiPid, publicProjections.heartbeat]
      const absent = [
        ...(!final ? [paths.finalInstance] : []),
        ...(!reviewState ? [paths.reviewDirectory] : []),
        ...(!publicProjections.pid ? [paths.pidProjection] : []),
        ...(!publicProjections.apiPid ? [paths.apiPidProjection] : []),
        ...(!publicProjections.heartbeat ? [paths.heartbeatProjection] : [])
      ]
      const proof = protocolProof(
        platform,
        options.readReceiptAuthority,
        receipt,
        files,
        commonDirectories,
        absent,
        rootIdentities
      )
      if (!final && publicCount === 0) {
        return daemonInspection('ABSENT', paths, proof, { namespaceId, receipt: receipt.receipt })
      }
      if (!final && publicCount > 0) {
        assertUniqueLegacyProjectionSubset(publicProjections, paths.dataRoot)
        return daemonInspection('LEGACY-NAMESPACE-RECOVERABLE', paths, proof, {
          namespaceId,
          receipt: receipt.receipt,
          publicProjectionCount: publicCount
        })
      }
      if (!final || publicCount !== 3 || !publicProjections.pid || !publicProjections.apiPid
        || !publicProjections.heartbeat) throw new Error('reservation-free daemon public state is incomplete')
      const reviewStat = assertPlainDirectory(paths.reviewDirectory, 'daemon review directory')
      const instance = parseDaemonInstanceRecord(final)
      assertRecordBindsReceipt(instance, receipt, namespaceId)
      assertPersistentAuthoritySnapshot(instance, receipt, dataRootStat, reviewStat, stageStat, innerMarker)
      assertProjectionPayloads(instance, {
        pid: publicProjections.pid,
        apiPid: publicProjections.apiPid,
        heartbeat: publicProjections.heartbeat
      })
      assertStartTopology(instance, { pid: null, apiPid: null, heartbeat: null }, publicProjections, final, null)
      return daemonInspection('RUNNING-CLEAN', paths, proof, {
        namespaceId,
        receipt: receipt.receipt,
        instance,
        publicProjectionCount: 3
      })
    }

    const reviewStat = assertPlainDirectory(paths.reviewDirectory, 'daemon review directory')

    const reservationName = reservationEntries[0].name
    const parsedReservation = parseDaemonReservationName(reservationName)
    if (!parsedReservation) throw new Error('daemon stage namespace contains a foreign reservation basename')
    assertReservationNameBindsReceipt(parsedReservation, receipt, namespaceId)
    const reservationDirectory = join(paths.stageDirectory, reservationName)
    const reservationSnapshot = captureDaemonDirectory(
      reservationDirectory,
      DAEMON_START_STAGE_PAYLOADS.length + 1,
      'daemon reservation'
    )
    const names = reservationSnapshot.entries.map((entry) => entry.name)
    const manifestPath = join(reservationDirectory, 'stage-manifest-v1.json')
    const manifestEntry = reservationSnapshot.entries.find((entry) => entry.name === 'stage-manifest-v1.json')
    const manifestFile = manifestEntry
      ? captureDaemonProtocolFile(manifestPath, DAEMON_STAGE_MANIFEST_MAX_BYTES, 'daemon stage manifest')
      : null
    let manifest: DaemonStageManifestV1 | null = null
    if (manifestFile) {
      try { manifest = parseDaemonStageManifest(manifestFile) } catch { /* an exclusive-writer cut is opaque partial state */ }
    }
    if (manifest && (manifest.reservationName !== reservationName || manifest.operation !== parsedReservation.operation)) {
      throw new Error('daemon stage manifest does not bind its reservation basename')
    }
    if (manifest) {
      assertRecordBindsReceipt(manifest, receipt, namespaceId)
      assertManifestRoots(manifest, paths)
    }
    const lifecycleOwnerAuthority = manifest && manifest.operation !== 'start'
      ? readBoundLifecycleOwnerAuthority(manifest, receipt, options.readLifecycleOwnerAuthority)
      : null
    const baseProofFiles: (DaemonCapturedFile | null)[] = [
      innerMarker, manifestFile, publicProjections.pid, publicProjections.apiPid, publicProjections.heartbeat,
      ...(lifecycleOwnerAuthority?.files || [])
    ]
    const baseDirectories = [
      ...commonDirectories,
      reservationSnapshot,
      ...(lifecycleOwnerAuthority?.directories || [])
    ]

    if (parsedReservation.operation === 'start') {
      const startPublicCount = projectionPrefixCount(publicProjections)
      const startNames = [...DAEMON_START_STAGE_PAYLOADS]
      const allowedStartNames = new Set(startNames)
      if (names.some((name) => !allowedStartNames.has(name as typeof DAEMON_START_STAGE_PAYLOADS[number]))) {
        throw new Error('daemon start reservation contains a foreign payload')
      }
      const final = finalVisible
        ? captureDaemonProtocolFile(paths.finalInstance, DAEMON_INSTANCE_MAX_BYTES, 'daemon final instance', [1, 2])
        : null
      const collapsing = Boolean(final || startPublicCount)
      if (collapsing && manifestFile && !manifest) {
        throw new Error('daemon running topology contains a partial or malformed start manifest')
      }
      const internalLinks = collapsing ? [1, 2] : [1]
      const pidFile = names.includes('daemon.pid')
        ? captureDaemonProtocolFile(join(reservationDirectory, 'daemon.pid'), 128, 'staged daemon PID', internalLinks) : null
      const apiPidFile = names.includes('api.pid')
        ? captureDaemonProtocolFile(join(reservationDirectory, 'api.pid'), 128, 'staged daemon API PID', internalLinks) : null
      const heartbeatFile = names.includes('daemon-heartbeat.json')
        ? captureDaemonProtocolFile(join(reservationDirectory, 'daemon-heartbeat.json'), DAEMON_INSTANCE_MAX_BYTES,
          'staged daemon heartbeat', internalLinks) : null
      const instanceFile = names.includes('daemon-instance-v1.json')
        ? captureDaemonProtocolFile(join(reservationDirectory, 'daemon-instance-v1.json'), DAEMON_INSTANCE_MAX_BYTES,
          'staged daemon instance', internalLinks) : null
      const stagedFiles = [pidFile, apiPidFile, heartbeatFile, instanceFile]
      const internalAliasCount = stagedFiles.filter(Boolean).length
      if (collapsing && !manifestFile && internalAliasCount > 0) {
        throw new Error('daemon start manifest disappeared before all internal aliases collapsed')
      }

      if (!collapsing && !manifest) {
        const expectedPrefix = startNames.slice(0, names.length)
          .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
        if (names.length > startNames.length || names.some((name, index) => name !== expectedPrefix[index])) {
          throw new Error('partial daemon start reservation is not a canonical logical payload prefix')
        }
        const completedCount = Math.max(0, names.length - 1)
        if (completedCount >= 1 && (!pidFile
          || parsePidProjection(pidFile, 'completed partial daemon PID') !== parsedReservation.actorPid)) {
          throw new Error('completed partial daemon PID does not bind its reservation actor')
        }
        if (completedCount >= 2 && (!apiPidFile
          || parsePidProjection(apiPidFile, 'completed partial daemon API PID') !== parsedReservation.actorPid)) {
          throw new Error('completed partial daemon API PID does not bind its reservation actor')
        }
        if (completedCount >= 3) {
          if (!heartbeatFile) throw new Error('completed partial daemon heartbeat is absent')
          const heartbeat = parseHeartbeatProjection(heartbeatFile)
          if (heartbeat.pid !== parsedReservation.actorPid || heartbeat.apiPid !== parsedReservation.actorPid
            || heartbeat.apiHealthy !== true || Date.parse(heartbeat.lastBeat) !== parsedReservation.createdAtMs
            || !samePath(heartbeat.dataRoot, paths.dataRoot)
            || !samePath(heartbeat.packageRoot, receipt.receipt.packageRoot)) {
            throw new Error('completed partial daemon heartbeat does not bind its reservation authority')
          }
        }
        let completedInstance: DaemonInstanceRecordV1 | null = null
        if (completedCount >= 4) {
          if (!instanceFile || !pidFile || !apiPidFile || !heartbeatFile) {
            throw new Error('completed partial daemon instance has missing predecessor projections')
          }
          completedInstance = parseDaemonInstanceRecord(instanceFile)
          assertRecordBindsReceipt(completedInstance, receipt, namespaceId)
          assertPersistentAuthoritySnapshot(completedInstance, receipt, dataRootStat, reviewStat, stageStat, innerMarker)
          if (completedInstance.epochId !== parsedReservation.operationId
            || completedInstance.pid !== parsedReservation.actorPid
            || completedInstance.pgid !== parsedReservation.actorPgid
            || createHash('sha256').update(completedInstance.processIdentity).digest('hex').slice(0, 16)
              !== parsedReservation.actorProcessIdentitySha16) {
            throw new Error('completed partial daemon instance does not bind its reservation basename')
          }
          assertProjectionPayloads(completedInstance, { pid: pidFile, apiPid: apiPidFile, heartbeat: heartbeatFile })
        }
        const proof = protocolProof(platform, options.readReceiptAuthority, receipt,
          [...baseProofFiles, ...stagedFiles], baseDirectories,
          [paths.finalInstance, paths.pidProjection, paths.apiPidProjection, paths.heartbeatProjection], rootIdentities)
        return daemonInspection('STARTING-PARTIAL', paths, proof, {
          namespaceId, receipt: receipt.receipt, reservation: parsedReservation,
          instance: completedInstance,
          publicProjectionCount: 0, stagePayloadCount: names.length
        })
      }

      if (!final) {
        if (!manifest || manifest.operation !== 'start'
          || names.length !== startNames.length || names.some((name, index) => name !== [...startNames]
            .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))[index])
          || !pidFile || !apiPidFile || !heartbeatFile || !instanceFile) {
          throw new Error('starting daemon stage is not exactly complete')
        }
      } else if (startPublicCount !== 3 || !publicProjections.pid || !publicProjections.apiPid || !publicProjections.heartbeat) {
        throw new Error('committed daemon instance has incomplete public projections')
      }

      const authoritativeInstanceFile = instanceFile || final
      if (!authoritativeInstanceFile) throw new Error('daemon start topology has no immutable instance authority')
      const instance = parseDaemonInstanceRecord(authoritativeInstanceFile)
      assertRecordBindsReceipt(instance, receipt, namespaceId)
      assertPersistentAuthoritySnapshot(instance, receipt, dataRootStat, reviewStat, stageStat, innerMarker)
      if (instance.epochId !== parsedReservation.operationId || instance.pid !== parsedReservation.actorPid
        || instance.pgid !== parsedReservation.actorPgid
        || createHash('sha256').update(instance.processIdentity).digest('hex').slice(0, 16)
          !== parsedReservation.actorProcessIdentitySha16) {
        throw new Error('daemon immutable instance does not bind its reservation basename')
      }
      if (manifest) {
        if (manifest.operation !== 'start') throw new Error('daemon start reservation contains another operation manifest')
        assertStartManifestBindsInstance(manifest, instance, authoritativeInstanceFile)
      } else if (!final) {
        throw new Error('daemon public state appeared before a canonical start manifest')
      }
      assertStartTopology(instance, { pid: pidFile, apiPid: apiPidFile, heartbeat: heartbeatFile },
        publicProjections, final, instanceFile)
      const semanticProjections = {
        pid: pidFile || publicProjections.pid,
        apiPid: apiPidFile || publicProjections.apiPid,
        heartbeat: heartbeatFile || publicProjections.heartbeat
      }
      if (!semanticProjections.pid || !semanticProjections.apiPid || !semanticProjections.heartbeat) {
        throw new Error('daemon start topology cannot prove all compatibility projection payloads')
      }
      assertProjectionPayloads(instance, {
        pid: semanticProjections.pid,
        apiPid: semanticProjections.apiPid,
        heartbeat: semanticProjections.heartbeat
      })
      const absentPublic = [
        !publicProjections.pid ? paths.pidProjection : null,
        !publicProjections.apiPid ? paths.apiPidProjection : null,
        !publicProjections.heartbeat ? paths.heartbeatProjection : null,
        !final ? paths.finalInstance : null
      ].filter(Boolean) as string[]
      const proof = protocolProof(platform, options.readReceiptAuthority, receipt,
        [...baseProofFiles, ...stagedFiles, final], baseDirectories, absentPublic, rootIdentities)
      return daemonInspection(
        final ? names.length === startNames.length ? 'RUNNING-LINKED' : 'RUNNING-COLLAPSING' : 'STARTING',
        paths,
        proof,
        {
          namespaceId, receipt: receipt.receipt, reservation: parsedReservation, instance, manifest,
          publicProjectionCount: startPublicCount, stagePayloadCount: names.length,
          recoveryAuthority: 'START'
        }
      )
    }

    if (!manifest) {
      if (names.length > 1 || names.some((name) => name !== 'stage-manifest-v1.json')) {
        throw new Error('partial daemon control reservation contains foreign payloads')
      }
      let instance: DaemonInstanceRecordV1 | null = null
      let final: DaemonCapturedFile | null = null
      if ([publicProjections.pid, publicProjections.apiPid, publicProjections.heartbeat]
        .filter(Boolean).some((file) => file!.state.nlink !== 1)) {
        throw new Error('partial daemon control target has a non-unique public inode')
      }
      if (parsedReservation.operation === 'stop') {
        if (finalVisible) {
          if (publicCount !== 3 || !publicProjections.pid || !publicProjections.apiPid || !publicProjections.heartbeat) {
            throw new Error('partial daemon stop reservation has incomplete running target authority')
          }
          final = captureDaemonProtocolFile(paths.finalInstance, DAEMON_INSTANCE_MAX_BYTES, 'partial stop instance', [1])
          instance = parseDaemonInstanceRecord(final)
          assertRecordBindsReceipt(instance, receipt, namespaceId)
          assertPersistentAuthoritySnapshot(instance, receipt, dataRootStat, reviewStat, stageStat, innerMarker)
          assertProjectionPayloads(instance, {
            pid: publicProjections.pid,
            apiPid: publicProjections.apiPid,
            heartbeat: publicProjections.heartbeat
          })
        } else if (publicCount) {
          throw new Error('partial daemon stop reservation has projections without a final instance')
        }
      } else {
        if (finalVisible) throw new Error('partial legacy-retire reservation has v1 final authority')
        if (publicCount) assertLegacyProjectionSubset(publicProjections, paths.dataRoot)
      }
      const absent = [
        ...(!final ? [paths.finalInstance] : []),
        ...(!publicProjections.pid ? [paths.pidProjection] : []),
        ...(!publicProjections.apiPid ? [paths.apiPidProjection] : []),
        ...(!publicProjections.heartbeat ? [paths.heartbeatProjection] : [])
      ]
      return daemonInspection(
        parsedReservation.operation === 'stop' ? 'STOPPING-PARTIAL' : 'LEGACY-RETIRING-PARTIAL',
        paths,
        protocolProof(platform, options.readReceiptAuthority, receipt,
          [...baseProofFiles, final], baseDirectories, absent, rootIdentities),
        { namespaceId, receipt: receipt.receipt, reservation: parsedReservation, instance,
          publicProjectionCount: publicCount, stagePayloadCount: names.length }
      )
    }
    if (names.length !== 1 || names[0] !== 'stage-manifest-v1.json') {
      throw new Error('daemon control reservation contains extra payloads')
    }
    if (manifest.operation === 'stop') {
      const final = finalVisible
        ? captureDaemonProtocolFile(paths.finalInstance, DAEMON_INSTANCE_MAX_BYTES, 'stopping daemon instance', [1])
        : null
      if (!final && publicCount) throw new Error('stopping daemon removed final before its projections')
      let stoppingInstance: DaemonInstanceRecordV1 | null = null
      if (final) {
        assertIdentityMatches(manifest.target.instance, final, 'stopping daemon instance')
        const instance = parseDaemonInstanceRecord(final)
        stoppingInstance = instance
        assertRecordBindsReceipt(instance, receipt, namespaceId)
        assertPersistentAuthoritySnapshot(instance, receipt, dataRootStat, reviewStat, stageStat, innerMarker)
        if (manifest.target.epochId !== instance.epochId || manifest.target.pid !== instance.pid
          || manifest.target.apiPid !== instance.apiPid || manifest.target.processIdentity !== instance.processIdentity
          || manifest.target.pgid !== instance.pgid || manifest.target.port !== instance.port
          || JSON.stringify(manifest.target.projections) !== JSON.stringify(instance.projections)) {
          throw new Error('daemon stop target does not bind its immutable instance')
        }
      }
      for (const [name, file] of Object.entries(publicProjections) as [keyof DaemonProjectionIdentitiesV1, DaemonCapturedFile | null][]) {
        if (file) {
          if (file.state.nlink !== 1) throw new Error('stopping daemon projection is not unique')
          assertIdentityMatches(manifest.target.projections[name], file, `stopping daemon ${name} projection`)
        }
      }
      assertControlProjectionSubset(
        manifest.target,
        publicProjections,
        manifest.dataRoot,
        manifest.packageRoot,
        true,
        stoppingInstance?.createdAt || null
      )
      const absent = [
        ...(!final ? [paths.finalInstance] : []),
        ...(!publicProjections.pid ? [paths.pidProjection] : []),
        ...(!publicProjections.apiPid ? [paths.apiPidProjection] : []),
        ...(!publicProjections.heartbeat ? [paths.heartbeatProjection] : [])
      ]
      return daemonInspection('STOPPING', paths,
        protocolProof(platform, options.readReceiptAuthority, receipt,
          [...baseProofFiles, final], baseDirectories, absent, rootIdentities),
        { namespaceId, receipt: receipt.receipt, reservation: parsedReservation,
          instance: final ? parseDaemonInstanceRecord(final) : null, manifest,
          publicProjectionCount: publicCount, stagePayloadCount: 1, recoveryAuthority: 'STOP' })
    }
    if (manifest.operation !== 'legacy-retire' || finalVisible) {
      throw new Error('legacy-retire reservation has conflicting v1 instance authority')
    }
    for (const [name, identity] of Object.entries(manifest.target.projections) as [keyof DaemonProjectionIdentitiesV1, DaemonFileIdentityV1 | null][]) {
      const file = publicProjections[name]
      if (!identity && file) throw new Error(`legacy-retire found an unrecorded ${name} projection`)
      if (identity && file) {
        if (file.state.nlink !== 1) throw new Error(`legacy-retire ${name} projection is not unique`)
        assertIdentityMatches(identity, file, `legacy-retire ${name} projection`)
      }
    }
    assertControlProjectionSubset(
      manifest.target,
      publicProjections,
      manifest.dataRoot,
      manifest.packageRoot,
      false
    )
    const absent = [
      paths.finalInstance,
      ...(!publicProjections.pid ? [paths.pidProjection] : []),
      ...(!publicProjections.apiPid ? [paths.apiPidProjection] : []),
      ...(!publicProjections.heartbeat ? [paths.heartbeatProjection] : [])
    ]
    return daemonInspection('LEGACY-RETIRING', paths,
      protocolProof(platform, options.readReceiptAuthority, receipt, baseProofFiles, baseDirectories, absent, rootIdentities),
      { namespaceId, receipt: receipt.receipt, reservation: parsedReservation, manifest,
        publicProjectionCount: publicCount, stagePayloadCount: 1, recoveryAuthority: 'LEGACY-RETIRE' })
  } catch (error) {
    return invalidDaemonInspection(paths, platform, error)
  }
}

export function inspectDaemonStageNamespaceAuthority(
  options: InspectDaemonProtocolOptions,
  expectedInspection?: DaemonProtocolInspection
): DaemonStageNamespaceAuthority {
  const inspection = expectedInspection || inspectDaemonProtocol(options)
  if (expectedInspection && (!samePath(expectedInspection.paths.home, options.home, options.platform || process.platform)
    || !samePath(expectedInspection.paths.dataRoot, options.dataRoot, options.platform || process.platform))) {
    throw new Error('daemon expected inspection belongs to another protocol namespace')
  }
  if (inspection.kind === 'INVALID' || inspection.kind === 'LEGACY'
    || !inspection.namespaceId || !inspection.receipt) {
    throw new Error(inspection.reason || 'daemon stage namespace has no recoverable v1 authority')
  }
  if (inspection.kind === 'NAMESPACE-RECOVERABLE') {
    throw new Error('daemon stage namespace is not yet complete enough to recover a reservation')
  }
  assertDaemonInspectionCurrent(inspection)
  const platform = options.platform || process.platform
  const receipt = inspectDaemonReceiptNamespace(
    options.home,
    options.dataRoot,
    options.readReceiptAuthority,
    platform
  )
  if (receipt.daemonStageNamespaceId !== inspection.namespaceId || !receipt.daemonAuthorityMarker) {
    throw new Error('daemon stage namespace authority changed after inspection')
  }
  const dataRootState = fileState(assertPlainDirectory(receipt.paths.dataRoot, 'daemon recovered data root'))
  const dataParentState = fileState(assertPlainDirectory(dirname(receipt.paths.dataRoot), 'daemon recovered data-root parent'))
  const stageDirectoryState = fileState(assertPlainDirectory(receipt.paths.stageDirectory, 'daemon recovered stage namespace'))
  const innerMarker = captureDaemonProtocolFile(
    daemonInnerNamespaceMarker(receipt.paths, inspection.namespaceId),
    0,
    'daemon recovered inner namespace marker'
  )
  const authority: DaemonStageNamespaceAuthority = {
    paths: receipt.paths,
    platform,
    readReceiptAuthority: options.readReceiptAuthority,
    receipt,
    namespaceId: inspection.namespaceId,
    reservationName: inspection.reservation?.name || null,
    homeMarker: receipt.daemonAuthorityMarker,
    dataRootState,
    dataParentState,
    reviewDirectoryState: captureOptionalDirectoryState(receipt.paths.reviewDirectory, 'daemon recovered review directory'),
    stageDirectoryState,
    innerMarker,
    ancestorIdentities: inspection.proof.directoryIdentities,
    recoveredInspection: inspection,
    recoveredInspectionScope: 'FULL'
  }
  assertDaemonStageNamespaceAuthority(authority)
  return authority
}

function settleRecoveredStartStageDurability(
  expectedInspection: DaemonProtocolInspection,
  checkpoint: DaemonProtocolCheckpoint
): void {
  if (!expectedInspection.reservation) {
    throw new Error('daemon recovered start durability has no frozen reservation')
  }
  const reservationDirectory = join(
    expectedInspection.paths.stageDirectory,
    expectedInspection.reservation.name
  )
  const reservationSnapshot = expectedInspection.proof.directories.find((candidate) =>
    samePath(candidate.directory, reservationDirectory, expectedInspection.proof.platform))
  if (!reservationSnapshot) {
    throw new Error('daemon recovered start durability has no frozen reservation snapshot')
  }
  const expectedNames = [...DAEMON_START_STAGE_PAYLOADS]
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
  if (reservationSnapshot.entries.length !== expectedNames.length
    || reservationSnapshot.entries.some((entry, index) => entry.name !== expectedNames[index]
      || entry.kind !== 'file')) {
    throw new Error('daemon recovered start durability requires an exact complete payload inventory')
  }
  const frozenFiles = DAEMON_START_STAGE_PAYLOADS.map((name) => {
    const file = join(reservationDirectory, name)
    const expected = expectedInspection.proof.files.find((candidate) =>
      samePath(candidate.file, file, expectedInspection.proof.platform))
    if (!expected) throw new Error(`daemon recovered start durability did not freeze ${name}`)
    return { name, expected }
  })
  const assertOriginalDescriptor = (
    descriptor: number,
    expected: DaemonCapturedFile,
    label: string
  ) => {
    const opened = fs.fstatSync(descriptor)
    const visible = fs.lstatSync(expected.file)
    if (!opened.isFile() || opened.dev !== expected.state.dev || opened.ino !== expected.state.ino
      || opened.size !== expected.state.size || opened.nlink !== expected.state.nlink
      || !visible.isFile() || visible.isSymbolicLink()
      || visible.dev !== expected.state.dev || visible.ino !== expected.state.ino
      || visible.size !== expected.state.size || visible.nlink !== expected.state.nlink) {
      throw new Error(`${label} no longer names its frozen inode`)
    }
    assertCapturedCurrent(expected, label, [expected.state.nlink])
  }
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0
  for (const { name, expected } of frozenFiles) {
    assertDaemonInspectionCurrent(expectedInspection)
    const descriptor = fs.openSync(expected.file, fs.constants.O_RDWR | noFollow)
    try {
      assertOriginalDescriptor(descriptor, expected, `daemon recovered ${name}`)
      assertDaemonInspectionCurrent(expectedInspection)
      fs.fsyncSync(descriptor)
      assertOriginalDescriptor(descriptor, expected, `daemon recovered ${name}`)
      assertDaemonInspectionCurrent(expectedInspection)
      checkpoint('daemon-stage-durability-file-fsynced', {
        file: expected.file,
        payload: name
      })
      assertOriginalDescriptor(descriptor, expected, `daemon recovered ${name}`)
      assertDaemonInspectionCurrent(expectedInspection)
    } finally {
      fs.closeSync(descriptor)
    }
  }
  assertDaemonInspectionCurrent(expectedInspection)
  assertDaemonDirectoryCurrent(reservationSnapshot, 'daemon recovered start reservation')
  flushDirectory(reservationDirectory)
  assertDaemonDirectoryCurrent(reservationSnapshot, 'daemon recovered start reservation')
  assertDaemonInspectionCurrent(expectedInspection)
  checkpoint('daemon-stage-durability-reservation-fsynced', {
    directory: reservationDirectory
  })
  assertDaemonDirectoryCurrent(reservationSnapshot, 'daemon recovered start reservation')
  assertDaemonInspectionCurrent(expectedInspection)
}

export function recoverDaemonStartStage(
  options: InspectDaemonProtocolOptions,
  expectedInspection: DaemonProtocolInspection,
  checkpoint: DaemonProtocolCheckpoint = () => {}
): DaemonStartStage {
  if (expectedInspection.kind !== 'STARTING' && expectedInspection.kind !== 'RUNNING-LINKED') {
    throw new Error('daemon start recovery requires a frozen complete start-stage topology')
  }
  const capturedInspection = capturePrivateDaemonInspection(options, expectedInspection)
  const frozenInspection = capturedInspection.inspection
  if (frozenInspection.kind !== 'STARTING' && frozenInspection.kind !== 'RUNNING-LINKED') {
    throw new Error('daemon start recovery requires a frozen complete start-stage topology')
  }
  if (!frozenInspection.reservation || !frozenInspection.instance
    || !frozenInspection.manifest || frozenInspection.manifest.operation !== 'start') {
    throw new Error('daemon start recovery inspection has no complete start authority')
  }
  assertDaemonInspectionCurrent(frozenInspection)
  settleRecoveredStartStageDurability(frozenInspection, checkpoint)
  assertDaemonInspectionCurrent(frozenInspection)
  const authority = inspectDaemonStageNamespaceAuthority(capturedInspection.options, frozenInspection)
  const reservationName = frozenInspection.reservation.name
  const reservationDirectory = join(authority.paths.stageDirectory, reservationName)
  const frozenFile = (file: string, label: string) => {
    const captured = frozenInspection.proof.files.find((candidate) => samePath(candidate.file, file, authority.platform))
    if (!captured) throw new Error(`${label} is absent from the frozen start inspection`)
    assertCapturedCurrent(captured, label, [captured.state.nlink])
    return captured
  }
  const files = {
    pid: frozenFile(join(reservationDirectory, 'daemon.pid'), 'recovered staged daemon PID'),
    apiPid: frozenFile(join(reservationDirectory, 'api.pid'), 'recovered staged daemon API PID'),
    heartbeat: frozenFile(join(reservationDirectory, 'daemon-heartbeat.json'), 'recovered staged daemon heartbeat'),
    instance: frozenFile(join(reservationDirectory, 'daemon-instance-v1.json'), 'recovered staged daemon instance'),
    manifest: frozenFile(join(reservationDirectory, 'stage-manifest-v1.json'), 'recovered daemon start manifest')
  }
  const publicFiles = {
    pid: frozenInspection.proof.files.find((file) => samePath(file.file, authority.paths.pidProjection, authority.platform)) || null,
    apiPid: frozenInspection.proof.files.find((file) => samePath(file.file, authority.paths.apiPidProjection, authority.platform)) || null,
    heartbeat: frozenInspection.proof.files.find((file) => samePath(file.file, authority.paths.heartbeatProjection, authority.platform)) || null
  }
  const final = frozenInspection.proof.files.find((file) => samePath(file.file, authority.paths.finalInstance, authority.platform)) || null
  const publicationAuthority: DaemonStageNamespaceAuthority = {
    ...authority,
    reservationName,
    recoveredInspectionScope: 'START'
  }
  const prefix = ['pid', 'apiPid', 'heartbeat'] as const
  const publicCount = prefix.filter((key) => Boolean(publicFiles[key])).length
  const epoch = {} as DaemonStartPublicationEpoch
  for (const [index, key] of prefix.entries()) {
    const target = publicFiles[key]
    epoch[key] = !target
      ? { phase: 'ABSENT' }
      : !final && index === publicCount - 1
        ? { phase: 'LINKED', source: files[key], target }
        : { phase: 'PUBLISHED', target }
  }
  epoch.final = final ? { phase: 'LINKED', source: files.instance, target: final } : { phase: 'ABSENT' }
  const issued = issueDaemonStartStage({
    authority: publicationAuthority,
    binding: bindingForManifest(frozenInspection.manifest),
    reservationName,
    reservationDirectory,
    instance: frozenInspection.instance,
    manifest: frozenInspection.manifest,
    files
  }, epoch)
  inspectCompleteStartStage(privateDaemonStartStage(issued))
  return issued
}

type DaemonStartOwnedPaths = Readonly<{
  stagedPid: string
  stagedApiPid: string
  stagedHeartbeat: string
  stagedInstance: string
  manifest: string
  publicPid: string
  publicApiPid: string
  publicHeartbeat: string
  final: string
}>

function daemonStartOwnedPaths(paths: DaemonProtocolPaths, reservationName: string): DaemonStartOwnedPaths {
  const reservation = join(paths.stageDirectory, reservationName)
  return {
    stagedPid: join(reservation, 'daemon.pid'),
    stagedApiPid: join(reservation, 'api.pid'),
    stagedHeartbeat: join(reservation, 'daemon-heartbeat.json'),
    stagedInstance: join(reservation, 'daemon-instance-v1.json'),
    manifest: join(reservation, 'stage-manifest-v1.json'),
    publicPid: paths.pidProjection,
    publicApiPid: paths.apiPidProjection,
    publicHeartbeat: paths.heartbeatProjection,
    final: paths.finalInstance
  }
}

function cloneDaemonCapturedFile(file: DaemonCapturedFile): DaemonCapturedFile {
  return {
    file: file.file,
    bytes: Buffer.from(file.bytes),
    sha256: file.sha256,
    state: { ...file.state }
  }
}

function cloneDaemonCapturedDirectory(directory: DaemonCapturedDirectory): DaemonCapturedDirectory {
  return {
    directory: directory.directory,
    state: { ...directory.state },
    entries: directory.entries.map((entry) => ({ ...entry }))
  }
}

function cloneDaemonCanonicalRecord<T>(value: T): T {
  return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value)) as T
}

function cloneDaemonReceiptSnapshot(snapshot: DaemonReceiptNamespaceSnapshot): DaemonReceiptNamespaceSnapshot {
  return {
    paths: { ...snapshot.paths },
    homeIdentity: snapshot.homeIdentity,
    directoryState: { ...snapshot.directoryState },
    namespaceMarker: cloneDaemonCapturedFile(snapshot.namespaceMarker),
    receipt: cloneDaemonCanonicalRecord(snapshot.receipt),
    receiptFile: cloneDaemonCapturedFile(snapshot.receiptFile),
    receiptSha256: snapshot.receiptSha256,
    ownerStageNamespaceId: snapshot.ownerStageNamespaceId,
    ownerStageAuthorityMarker: snapshot.ownerStageAuthorityMarker
      ? cloneDaemonCapturedFile(snapshot.ownerStageAuthorityMarker)
      : null,
    daemonStageNamespaceId: snapshot.daemonStageNamespaceId,
    daemonAuthorityMarker: snapshot.daemonAuthorityMarker
      ? cloneDaemonCapturedFile(snapshot.daemonAuthorityMarker)
      : null,
    entries: [...snapshot.entries]
  }
}

function cloneDaemonStageNamespaceAuthority(
  authority: DaemonStageNamespaceAuthority
): DaemonStageNamespaceAuthority {
  return {
    paths: { ...authority.paths },
    platform: authority.platform,
    readReceiptAuthority: authority.readReceiptAuthority,
    receipt: cloneDaemonReceiptSnapshot(authority.receipt),
    namespaceId: authority.namespaceId,
    reservationName: authority.reservationName,
    homeMarker: cloneDaemonCapturedFile(authority.homeMarker),
    dataRootState: { ...authority.dataRootState },
    dataParentState: { ...authority.dataParentState },
    reviewDirectoryState: authority.reviewDirectoryState ? { ...authority.reviewDirectoryState } : null,
    stageDirectoryState: { ...authority.stageDirectoryState },
    innerMarker: cloneDaemonCapturedFile(authority.innerMarker),
    ancestorIdentities: authority.ancestorIdentities.map((directory) => ({
      directory: directory.directory,
      state: { ...directory.state }
    })),
    recoveredInspection: authority.recoveredInspection
      ? cloneDaemonProtocolInspection(authority.recoveredInspection)
      : null,
    recoveredInspectionScope: authority.recoveredInspectionScope
  }
}

function cloneDaemonStartStage(stage: DaemonStartStage): DaemonStartStage {
  return {
    authority: cloneDaemonStageNamespaceAuthority(stage.authority),
    binding: cloneDaemonCanonicalRecord(stage.binding),
    reservationName: stage.reservationName,
    reservationDirectory: stage.reservationDirectory,
    instance: cloneDaemonCanonicalRecord(stage.instance),
    manifest: cloneDaemonCanonicalRecord(stage.manifest),
    files: {
      pid: cloneDaemonCapturedFile(stage.files.pid),
      apiPid: cloneDaemonCapturedFile(stage.files.apiPid),
      heartbeat: cloneDaemonCapturedFile(stage.files.heartbeat),
      instance: cloneDaemonCapturedFile(stage.files.instance),
      manifest: cloneDaemonCapturedFile(stage.files.manifest)
    }
  }
}

function cloneDaemonProtocolInspection(inspection: DaemonProtocolInspection): DaemonProtocolInspection {
  return {
    kind: inspection.kind,
    reason: inspection.reason,
    paths: { ...inspection.paths },
    namespaceId: inspection.namespaceId,
    receipt: cloneDaemonCanonicalRecord(inspection.receipt),
    reservation: cloneDaemonCanonicalRecord(inspection.reservation),
    instance: cloneDaemonCanonicalRecord(inspection.instance),
    manifest: cloneDaemonCanonicalRecord(inspection.manifest),
    publicProjectionCount: inspection.publicProjectionCount,
    stagePayloadCount: inspection.stagePayloadCount,
    recoveryAuthority: inspection.recoveryAuthority,
    proof: {
      platform: inspection.proof.platform,
      readReceiptAuthority: inspection.proof.readReceiptAuthority,
      receipt: inspection.proof.receipt ? cloneDaemonReceiptSnapshot(inspection.proof.receipt) : null,
      files: inspection.proof.files.map(cloneDaemonCapturedFile),
      directories: inspection.proof.directories.map(cloneDaemonCapturedDirectory),
      directoryIdentities: inspection.proof.directoryIdentities.map((directory) => ({
        directory: directory.directory,
        state: { ...directory.state }
      })),
      absent: [...inspection.proof.absent]
    }
  }
}

function cloneInspectDaemonProtocolOptions(options: InspectDaemonProtocolOptions): InspectDaemonProtocolOptions {
  return {
    home: options.home,
    dataRoot: options.dataRoot,
    platform: options.platform,
    readReceiptAuthority: options.readReceiptAuthority,
    readLifecycleOwnerAuthority: options.readLifecycleOwnerAuthority
  }
}

function daemonInspectionExactSignature(inspection: DaemonProtocolInspection): string {
  const frozen = cloneDaemonProtocolInspection(inspection)
  const sortBy = <T>(values: readonly T[], selector: (value: T) => string) => [...values]
    .sort((left, right) => Buffer.compare(Buffer.from(selector(left)), Buffer.from(selector(right))))
  return canonicalDaemonJson({
    kind: frozen.kind,
    reason: frozen.reason,
    paths: frozen.paths,
    namespaceId: frozen.namespaceId,
    receipt: frozen.receipt,
    reservation: frozen.reservation,
    instance: frozen.instance,
    manifest: frozen.manifest,
    publicProjectionCount: frozen.publicProjectionCount,
    stagePayloadCount: frozen.stagePayloadCount,
    recoveryAuthority: frozen.recoveryAuthority,
    proof: {
      platform: frozen.proof.platform,
      receipt: frozen.proof.receipt,
      files: sortBy(frozen.proof.files, (file) => file.file),
      directories: sortBy(frozen.proof.directories, (directory) => directory.directory),
      directoryIdentities: sortBy(frozen.proof.directoryIdentities, (directory) => directory.directory)
        .map((directory) => ({
          directory: directory.directory,
          state: { dev: directory.state.dev, ino: directory.state.ino }
        })),
      absent: [...frozen.proof.absent].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
    }
  })
}

function capturePrivateDaemonInspection(
  options: InspectDaemonProtocolOptions,
  expectedInspection: DaemonProtocolInspection
): Readonly<{ options: InspectDaemonProtocolOptions; inspection: DaemonProtocolInspection }> {
  const frozenOptions = cloneInspectDaemonProtocolOptions(options)
  const callerProof = cloneDaemonProtocolInspection(expectedInspection)
  assertDaemonInspectionCurrent(callerProof)
  const privateInspection = cloneDaemonProtocolInspection(inspectDaemonProtocol(frozenOptions))
  assertDaemonInspectionCurrent(callerProof)
  if (daemonInspectionExactSignature(privateInspection) !== daemonInspectionExactSignature(callerProof)) {
    throw new Error('daemon inspection changed while private mutation authority was captured')
  }
  assertDaemonInspectionCurrent(privateInspection)
  return { options: frozenOptions, inspection: privateInspection }
}

function daemonMutationPathKey(file: string, platform: string): string {
  const absolute = resolve(file)
  return platform === 'win32' ? absolute.toLowerCase() : absolute
}

function daemonOwnedSlot(epoch: DaemonStartMutationEpoch, file: string): DaemonOwnedFileSlot {
  const slot = epoch.owned.get(daemonMutationPathKey(file, epoch.inspection.proof.platform))
  if (!slot) throw new Error(`daemon mutation epoch does not own protocol path: ${file}`)
  return slot
}

function daemonProofDirectory(
  inspection: DaemonProtocolInspection,
  directory: string,
  label: string
): DaemonCapturedDirectory {
  const captured = inspection.proof.directories.find((candidate) =>
    samePath(candidate.directory, directory, inspection.proof.platform))
  if (!captured) throw new Error(`${label} is absent from the frozen daemon inspection`)
  return captured
}

function daemonProofFile(inspection: DaemonProtocolInspection, file: string): DaemonCapturedFile | null {
  return inspection.proof.files.find((candidate) => samePath(candidate.file, file, inspection.proof.platform)) || null
}

function sameDaemonMutationPath(epoch: DaemonStartMutationEpoch, left: string, right: string): boolean {
  return samePath(left, right, epoch.inspection.proof.platform)
}

function createDaemonStartMutationEpoch(
  options: InspectDaemonProtocolOptions,
  inspection: DaemonProtocolInspection,
  mode: DaemonStartMutationEpoch['mode']
): DaemonStartMutationEpoch {
  const frozenOptions = cloneInspectDaemonProtocolOptions(options)
  const frozenInspection = cloneDaemonProtocolInspection(inspection)
  const platform = frozenOptions.platform || process.platform
  if (!samePath(frozenOptions.home, frozenInspection.paths.home, platform)
    || !samePath(frozenOptions.dataRoot, frozenInspection.paths.dataRoot, platform)) {
    throw new Error('daemon mutation inspection belongs to another protocol namespace')
  }
  if (!frozenInspection.reservation || !frozenInspection.namespaceId || !frozenInspection.receipt) {
    throw new Error('daemon start mutation has no frozen reservation authority')
  }
  assertDaemonInspectionCurrent(frozenInspection)
  const paths = daemonStartOwnedPaths(frozenInspection.paths, frozenInspection.reservation.name)
  const reservationDirectory = join(frozenInspection.paths.stageDirectory, frozenInspection.reservation.name)
  const stageDirectory = daemonProofDirectory(
    frozenInspection,
    frozenInspection.paths.stageDirectory,
    'daemon stage namespace'
  )
  const reservation = daemonProofDirectory(frozenInspection, reservationDirectory, 'daemon start reservation')
  const owned = new Map<string, DaemonOwnedFileSlot>()
  for (const file of Object.values(paths)) {
    const key = daemonMutationPathKey(file, frozenInspection.proof.platform)
    if (owned.has(key)) throw new Error('daemon start mutation paths are not disjoint')
    owned.set(key, { path: file, captured: daemonProofFile(frozenInspection, file) })
  }
  const epoch: DaemonStartMutationEpoch = {
    options: frozenOptions,
    inspection: frozenInspection,
    mode,
    stageDirectory,
    reservationDirectory: reservation,
    reservationPresent: true,
    reservationRemovalExpected: null,
    owned,
    fileRemovalExpected: new Map(),
    reviewBarrierComplete: false,
    reservationBarrierComplete: false
  }
  assertDaemonStartMutationEpoch(epoch)
  return epoch
}

function daemonStartMutationOwnedPaths(epoch: DaemonStartMutationEpoch): readonly string[] {
  return [...epoch.owned.values()].map((slot) => slot.path)
}

function assertDaemonStartMutationExternalAuthority(epoch: DaemonStartMutationEpoch): void {
  const proof = epoch.inspection.proof
  const ownedPaths = daemonStartMutationOwnedPaths(epoch)
  const ignored = (candidate: string) => ownedPaths.some((file) => samePath(file, candidate, proof.platform))
    || samePath(epoch.stageDirectory.directory, candidate, proof.platform)
    || samePath(epoch.reservationDirectory.directory, candidate, proof.platform)
  if (proof.receipt && proof.readReceiptAuthority) {
    assertDaemonReceiptNamespaceSnapshot(proof.receipt, proof.readReceiptAuthority, proof.platform)
  }
  for (const expected of proof.directoryIdentities) {
    const current = assertPlainDirectory(expected.directory, 'daemon start mutation authority root')
    if (current.dev !== expected.state.dev || current.ino !== expected.state.ino) {
      throw new Error('daemon start mutation authority root identity changed')
    }
  }
  for (const directory of proof.directories) {
    if (!ignored(directory.directory)) {
      assertDaemonDirectoryCurrent(directory, `daemon ${epoch.mode.toLowerCase()} external directory`)
    }
  }
  for (const file of proof.files) {
    if (!ignored(file.file)) {
      assertCapturedCurrent(file, `daemon ${epoch.mode.toLowerCase()} external file`, [file.state.nlink])
    }
  }
  for (const file of proof.absent) {
    if (!ignored(file) && lstatOptional(file)) {
      throw new Error(`daemon ${epoch.mode.toLowerCase()} external absent path reappeared: ${file}`)
    }
  }
}

function assertDaemonStartMutationInventory(epoch: DaemonStartMutationEpoch): void {
  const stage = assertPlainDirectory(epoch.stageDirectory.directory, 'daemon start mutation stage namespace')
  if (stage.dev !== epoch.stageDirectory.state.dev || stage.ino !== epoch.stageDirectory.state.ino) {
    throw new Error('daemon start mutation stage namespace identity changed')
  }
  const innerMarkerName = basename(daemonInnerNamespaceMarker(epoch.inspection.paths, epoch.inspection.namespaceId!))
  const expectedStageNames = [
    innerMarkerName,
    ...(epoch.reservationPresent ? [basename(epoch.reservationDirectory.directory)] : [])
  ].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
  const stageEntries = boundedEntries(
    epoch.stageDirectory.directory,
    DAEMON_STAGE_NAMESPACE_MAX_ENTRIES,
    'daemon start mutation stage namespace'
  )
  if (stageEntries.length !== expectedStageNames.length
    || stageEntries.some((entry, index) => entry.name !== expectedStageNames[index])
    || stageEntries.some((entry) => entry.name === innerMarkerName
      ? !entry.isFile() || entry.isSymbolicLink()
      : !entry.isDirectory() || entry.isSymbolicLink())) {
    throw new Error('daemon start mutation stage namespace inventory changed')
  }
  if (!epoch.reservationPresent) {
    if (lstatOptional(epoch.reservationDirectory.directory)) {
      throw new Error('daemon removed start reservation reappeared')
    }
    return
  }
  const reservation = assertPlainDirectory(
    epoch.reservationDirectory.directory,
    'daemon start mutation reservation'
  )
  if (reservation.dev !== epoch.reservationDirectory.state.dev
    || reservation.ino !== epoch.reservationDirectory.state.ino) {
    throw new Error('daemon start mutation reservation identity changed')
  }
  const expectedPayloads = [...epoch.owned.values()]
    .filter((slot) => slot.captured && samePath(dirname(slot.path), epoch.reservationDirectory.directory,
      epoch.inspection.proof.platform))
    .map((slot) => basename(slot.path))
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
  const reservationEntries = boundedEntries(
    epoch.reservationDirectory.directory,
    DAEMON_START_STAGE_PAYLOADS.length + 1,
    'daemon start mutation reservation'
  )
  if (reservationEntries.length !== expectedPayloads.length
    || reservationEntries.some((entry, index) => entry.name !== expectedPayloads[index])
    || reservationEntries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error('daemon start mutation reservation inventory changed')
  }
}

function assertDaemonStartMutationTopology(epoch: DaemonStartMutationEpoch): void {
  const paths = daemonStartOwnedPaths(epoch.inspection.paths, epoch.inspection.reservation!.name)
  const present = (file: string) => Boolean(daemonOwnedSlot(epoch, file).captured)
  const pairs = [
    [paths.stagedPid, paths.publicPid, 'PID'],
    [paths.stagedApiPid, paths.publicApiPid, 'API PID'],
    [paths.stagedHeartbeat, paths.publicHeartbeat, 'heartbeat'],
    [paths.stagedInstance, paths.final, 'instance']
  ] as const
  for (const [sourcePath, targetPath, label] of pairs) {
    const source = daemonOwnedSlot(epoch, sourcePath).captured
    const target = daemonOwnedSlot(epoch, targetPath).captured
    if (source && target) {
      if (source.state.nlink !== 2 || target.state.nlink !== 2
        || source.state.dev !== target.state.dev || source.state.ino !== target.state.ino
        || !source.bytes.equals(target.bytes) || source.sha256 !== target.sha256) {
        throw new Error(`daemon start mutation ${label} is not an exact hardlink pair`)
      }
    } else if (source && source.state.nlink !== 1) {
      throw new Error(`daemon start mutation ${label} source has an invalid link count`)
    } else if (target && target.state.nlink !== 1) {
      throw new Error(`daemon start mutation ${label} target has an invalid link count`)
    }
  }
  if (epoch.mode === 'ABANDONED') {
    if (present(paths.final)) throw new Error('abandoned daemon START unexpectedly has final authority')
    const publicPrefix = [present(paths.publicPid), present(paths.publicApiPid), present(paths.publicHeartbeat)]
    if (publicPrefix.some((value, index) => value !== (index < publicPrefix.filter(Boolean).length))) {
      throw new Error('abandoned daemon START public projections are not a canonical prefix')
    }
    const internalPrefix = [
      present(paths.stagedPid), present(paths.stagedApiPid), present(paths.stagedHeartbeat),
      present(paths.stagedInstance), present(paths.manifest)
    ]
    if (internalPrefix.some((value, index) => value !== (index < internalPrefix.filter(Boolean).length))) {
      throw new Error('abandoned daemon START payloads are not a canonical writer prefix')
    }
  } else {
    if (!present(paths.publicPid) || !present(paths.publicApiPid)
      || !present(paths.publicHeartbeat) || !present(paths.final)) {
      throw new Error('committed daemon collapse lost public or final authority')
    }
    const anyInternal = [paths.stagedPid, paths.stagedApiPid, paths.stagedHeartbeat, paths.stagedInstance]
      .some(present)
    if (anyInternal && !present(paths.manifest)) {
      throw new Error('committed daemon collapse removed its manifest before all internal aliases')
    }
  }
}

function assertDaemonStartMutationEpoch(epoch: DaemonStartMutationEpoch): void {
  assertDaemonStartMutationExternalAuthority(epoch)
  assertDaemonStartMutationInventory(epoch)
  for (const slot of epoch.owned.values()) {
    if (slot.captured) {
      assertFrozenDaemonFile(slot.captured, `daemon mutation ${basename(slot.path)}`, slot.captured.state.nlink)
    } else if (lstatOptional(slot.path)) {
      throw new Error(`daemon mutation absent path reappeared: ${slot.path}`)
    }
  }
  assertDaemonStartMutationTopology(epoch)
}

function captureDaemonMutationTransition(
  previous: DaemonCapturedFile,
  expectedNlink: number,
  label: string
): DaemonCapturedFile {
  return assertFrozenDaemonFile(previous, label, expectedNlink)
}

function advanceDaemonRemovedTarget(
  epoch: DaemonStartMutationEpoch,
  sourcePath: string,
  targetPath: string,
  label: string
): void {
  const source = daemonOwnedSlot(epoch, sourcePath)
  const target = daemonOwnedSlot(epoch, targetPath)
  if (lstatOptional(targetPath)) throw new Error(`${label} target reappeared after unlink`)
  if (!source.captured) throw new Error(`${label} lost its staged counterpart`)
  source.captured = captureDaemonMutationTransition(source.captured, 1, `${label} staged counterpart`)
  target.captured = null
}

function advanceDaemonRemovedSource(
  epoch: DaemonStartMutationEpoch,
  sourcePath: string,
  targetPath: string | null,
  label: string
): void {
  const source = daemonOwnedSlot(epoch, sourcePath)
  if (lstatOptional(sourcePath)) throw new Error(`${label} source reappeared after unlink`)
  source.captured = null
  if (targetPath) {
    const target = daemonOwnedSlot(epoch, targetPath)
    if (!target.captured) throw new Error(`${label} lost its public counterpart`)
    target.captured = captureDaemonMutationTransition(target.captured, 1, `${label} public counterpart`)
  }
}

function advanceDaemonRemovedStandalone(
  epoch: DaemonStartMutationEpoch,
  file: string,
  label: string
): void {
  if (lstatOptional(file)) throw new Error(`${label} reappeared after unlink`)
  daemonOwnedSlot(epoch, file).captured = null
}

function removeDaemonMutationFile(
  epoch: DaemonStartMutationEpoch,
  file: string,
  label: string,
  checkpoint: DaemonProtocolCheckpoint,
  advance: () => void
): void {
  const key = daemonMutationPathKey(file, epoch.inspection.proof.platform)
  const slot = daemonOwnedSlot(epoch, file)
  let expected = epoch.fileRemovalExpected.get(key)
  if (!expected) {
    if (!slot.captured) return
    expected = slot.captured
    epoch.fileRemovalExpected.set(key, expected)
  }
  unlinkDaemonFileExactDurable(
    expected,
    label,
    checkpoint,
    () => assertDaemonStartMutationEpoch(epoch),
    advance
  )
  epoch.fileRemovalExpected.delete(key)
}

function settleDaemonMutationDirectoryBarrier(
  epoch: DaemonStartMutationEpoch,
  kind: 'review' | 'reservation',
  checkpoint: DaemonProtocolCheckpoint
): void {
  if (kind === 'review' && epoch.reviewBarrierComplete
    || kind === 'reservation' && epoch.reservationBarrierComplete) return
  if (kind === 'reservation' && !epoch.reservationPresent) return
  const directory = kind === 'review'
    ? epoch.inspection.paths.reviewDirectory
    : epoch.reservationDirectory.directory
  assertDaemonStartMutationEpoch(epoch)
  flushDirectory(directory)
  checkpoint(`daemon-mutation-${kind}-parent-fsynced`, { directory })
  assertDaemonStartMutationEpoch(epoch)
  if (kind === 'review') epoch.reviewBarrierComplete = true
  else epoch.reservationBarrierComplete = true
}

function settleDaemonStartMutationEntryDurability(
  epoch: DaemonStartMutationEpoch,
  checkpoint: DaemonProtocolCheckpoint
): void {
  settleDaemonMutationDirectoryBarrier(epoch, 'review', checkpoint)
  settleDaemonMutationDirectoryBarrier(epoch, 'reservation', checkpoint)
}

function removeDaemonMutationReservation(
  epoch: DaemonStartMutationEpoch,
  checkpoint: DaemonProtocolCheckpoint
): void {
  if (!epoch.reservationPresent && !epoch.reservationRemovalExpected) return
  assertDaemonStartMutationEpoch(epoch)
  if (epoch.reservationPresent && !epoch.reservationRemovalExpected) {
    const empty = captureDaemonDirectory(
      epoch.reservationDirectory.directory,
      1,
      'daemon empty start reservation'
    )
    if (empty.entries.length !== 0 || empty.state.dev !== epoch.reservationDirectory.state.dev
      || empty.state.ino !== epoch.reservationDirectory.state.ino) {
      throw new Error('daemon start reservation is not the frozen empty directory')
    }
    epoch.reservationRemovalExpected = empty
  }
  const removalExpected = epoch.reservationRemovalExpected
  if (!removalExpected) throw new Error('daemon empty reservation removal lost its frozen directory')
  removeDaemonDirectoryExactDurable(
    removalExpected,
    'daemon empty start reservation',
    checkpoint,
    () => assertDaemonStartMutationEpoch(epoch),
    () => {
      if (lstatOptional(epoch.reservationDirectory.directory)) {
        throw new Error('daemon start reservation reappeared after rmdir')
      }
      epoch.reservationPresent = false
      epoch.fileRemovalExpected.clear()
    }
  )
}

function inspectDaemonStartMutationTerminal(
  epoch: DaemonStartMutationEpoch,
  expectedKind: 'ABSENT' | 'RUNNING-CLEAN'
): DaemonProtocolInspection {
  assertDaemonStartMutationEpoch(epoch)
  const current = cloneDaemonProtocolInspection(inspectDaemonProtocol(epoch.options))
  assertDaemonStartMutationEpoch(epoch)
  if (current.kind !== expectedKind || current.namespaceId !== epoch.inspection.namespaceId
    || current.receipt?.installId !== epoch.inspection.receipt?.installId
    || current.receipt?.dataRootId !== epoch.inspection.receipt?.dataRootId
    || canonicalDaemonJson(current.receipt) !== canonicalDaemonJson(epoch.inspection.receipt)
    || current.proof.receipt?.receiptSha256 !== epoch.inspection.proof.receipt?.receiptSha256) {
    throw new Error(`daemon start mutation did not reach ${expectedKind}`)
  }
  assertDaemonInspectionCurrent(current)
  return current
}

function validateDaemonActorProbeFacts(value: DaemonStartActorProbeFacts): DaemonStartActorProbeFacts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('daemon actor probe returned unknown authority')
  }
  let keys: string[]
  let state: unknown
  let processIdentity: unknown
  let pgid: unknown
  try {
    const record = value as unknown as Record<string, unknown>
    const prototype = Object.getPrototypeOf(record)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('daemon actor probe returned unknown authority')
    }
    keys = Object.keys(record)
    state = record.state
    if (state === 'alive') {
      processIdentity = record.processIdentity
      pgid = record.pgid
    }
  } catch {
    throw new Error('daemon actor probe returned unknown authority')
  }
  const hasExactKeys = (expected: readonly string[]) =>
    keys.length === expected.length && expected.every((key) => keys.includes(key))
  if (state === 'dead' && hasExactKeys(['state'])) return Object.freeze({ state: 'dead' })
  if (state === 'unknown' && hasExactKeys(['state'])) return Object.freeze({ state: 'unknown' })
  if (state === 'alive' && hasExactKeys(['state', 'processIdentity', 'pgid'])
    && typeof processIdentity === 'string' && SAFE_PROCESS_IDENTITY.test(processIdentity)
    && Number.isInteger(pgid) && (pgid as number) > 0) {
    return Object.freeze({ state: 'alive', processIdentity, pgid: pgid as number })
  }
  throw new Error('daemon actor probe returned unknown authority')
}

export function acquireAbandonedDaemonStartCleanupAuthority(
  options: InspectDaemonProtocolOptions,
  expectedInspection: DaemonProtocolInspection,
  probeActor: DaemonStartActorProbe
): DaemonAbandonedStartCleanupAuthority {
  const captured = capturePrivateDaemonInspection(options, expectedInspection)
  const privateInspection = captured.inspection
  if (privateInspection.kind !== 'STARTING-PARTIAL' && privateInspection.kind !== 'STARTING') {
    throw new Error('abandoned daemon START cleanup requires STARTING-PARTIAL or STARTING')
  }
  if (!privateInspection.reservation || privateInspection.reservation.operation !== 'start') {
    throw new Error('abandoned daemon START cleanup has no start reservation')
  }
  const facts = validateDaemonActorProbeFacts(probeActor({ pid: privateInspection.reservation.actorPid }))
  assertDaemonInspectionCurrent(privateInspection)
  let disposition: DaemonAbandonedStartCleanupAuthority['disposition']
  if (facts.state === 'dead') {
    disposition = 'dead'
  } else if (facts.state === 'unknown') {
    throw new Error('daemon START actor status is unknown')
  } else {
    const identitySha16 = createHash('sha256').update(facts.processIdentity).digest('hex').slice(0, 16)
    const completeIdentity = privateInspection.manifest?.operation === 'start'
      ? privateInspection.manifest.actor.processIdentity
      : privateInspection.instance?.processIdentity || null
    if (identitySha16 !== privateInspection.reservation.actorProcessIdentitySha16
      || completeIdentity && facts.processIdentity !== completeIdentity) {
      disposition = 'pid-reused'
    } else if (facts.pgid !== privateInspection.reservation.actorPgid) {
      throw new Error('daemon START actor PGID changed without proving PID reuse')
    } else {
      throw new Error('daemon START actor is still the live owner')
    }
  }
  const authority: DaemonAbandonedStartCleanupAuthority = Object.freeze({
    kind: 'ABANDONED-START-CLEANUP',
    disposition
  })
  daemonAbandonedStartCleanupEpochs.set(
    authority,
    createDaemonStartMutationEpoch(captured.options, privateInspection, 'ABANDONED')
  )
  return authority
}

export function cleanupAbandonedDaemonStart(
  authority: DaemonAbandonedStartCleanupAuthority,
  checkpoint: DaemonProtocolCheckpoint = () => {}
): DaemonProtocolInspection {
  const epoch = daemonAbandonedStartCleanupEpochs.get(authority)
  if (!epoch || authority.kind !== 'ABANDONED-START-CLEANUP') {
    throw new Error('daemon abandoned START cleanup authority was not issued by this protocol instance')
  }
  assertDaemonStartMutationEpoch(epoch)
  settleDaemonStartMutationEntryDurability(epoch, checkpoint)
  const paths = daemonStartOwnedPaths(epoch.inspection.paths, epoch.inspection.reservation!.name)
  for (const [source, target, label] of [
    [paths.stagedHeartbeat, paths.publicHeartbeat, 'daemon abandoned heartbeat projection'],
    [paths.stagedApiPid, paths.publicApiPid, 'daemon abandoned API PID projection'],
    [paths.stagedPid, paths.publicPid, 'daemon abandoned PID projection']
  ] as const) {
    removeDaemonMutationFile(epoch, target, label, checkpoint,
      () => advanceDaemonRemovedTarget(epoch, source, target, label))
  }
  for (const [file, label] of [
    [paths.manifest, 'daemon abandoned start manifest'],
    [paths.stagedInstance, 'daemon abandoned staged instance'],
    [paths.stagedHeartbeat, 'daemon abandoned staged heartbeat'],
    [paths.stagedApiPid, 'daemon abandoned staged API PID'],
    [paths.stagedPid, 'daemon abandoned staged PID']
  ] as const) {
    removeDaemonMutationFile(epoch, file, label, checkpoint,
      () => advanceDaemonRemovedSource(epoch, file, null, label))
  }
  removeDaemonMutationReservation(epoch, checkpoint)
  return inspectDaemonStartMutationTerminal(epoch, 'ABSENT')
}

export function acquireCommittedDaemonStartCollapseAuthority(
  options: InspectDaemonProtocolOptions,
  expectedInspection: DaemonProtocolInspection
): DaemonCommittedStartCollapseAuthority {
  const captured = capturePrivateDaemonInspection(options, expectedInspection)
  const privateInspection = captured.inspection
  if (privateInspection.kind !== 'RUNNING-LINKED' && privateInspection.kind !== 'RUNNING-COLLAPSING') {
    throw new Error('committed daemon START collapse requires RUNNING-LINKED or RUNNING-COLLAPSING')
  }
  if (!privateInspection.reservation || !privateInspection.instance
    || privateInspection.reservation.operation !== 'start') {
    throw new Error('committed daemon START collapse has no frozen start authority')
  }
  const authority: DaemonCommittedStartCollapseAuthority = Object.freeze({
    kind: 'COMMITTED-START-COLLAPSE'
  })
  daemonCommittedStartCollapseEpochs.set(
    authority,
    createDaemonStartMutationEpoch(captured.options, privateInspection, 'COLLAPSE')
  )
  return authority
}

export function collapseCommittedDaemonStart(
  authority: DaemonCommittedStartCollapseAuthority,
  checkpoint: DaemonProtocolCheckpoint = () => {}
): DaemonProtocolInspection {
  const epoch = daemonCommittedStartCollapseEpochs.get(authority)
  if (!epoch || authority.kind !== 'COMMITTED-START-COLLAPSE') {
    throw new Error('daemon committed START collapse authority was not issued by this protocol instance')
  }
  assertDaemonStartMutationEpoch(epoch)
  settleDaemonStartMutationEntryDurability(epoch, checkpoint)
  const paths = daemonStartOwnedPaths(epoch.inspection.paths, epoch.inspection.reservation!.name)
  for (const [source, target, label] of [
    [paths.stagedPid, paths.publicPid, 'daemon collapse staged PID'],
    [paths.stagedApiPid, paths.publicApiPid, 'daemon collapse staged API PID'],
    [paths.stagedHeartbeat, paths.publicHeartbeat, 'daemon collapse staged heartbeat'],
    [paths.stagedInstance, paths.final, 'daemon collapse staged instance']
  ] as const) {
    removeDaemonMutationFile(epoch, source, label, checkpoint,
      () => advanceDaemonRemovedSource(epoch, source, target, label))
  }
  removeDaemonMutationFile(epoch, paths.manifest, 'daemon collapse start manifest', checkpoint,
    () => advanceDaemonRemovedStandalone(epoch, paths.manifest, 'daemon collapse start manifest'))
  removeDaemonMutationReservation(epoch, checkpoint)
  return inspectDaemonStartMutationTerminal(epoch, 'RUNNING-CLEAN')
}

export function settleDaemonTerminalNamespaceDurability(
  options: InspectDaemonProtocolOptions,
  expectedInspection: DaemonProtocolInspection,
  checkpoint: DaemonProtocolCheckpoint = () => {}
): DaemonProtocolInspection {
  const captured = capturePrivateDaemonInspection(options, expectedInspection)
  const privateInspection = captured.inspection
  if (privateInspection.kind !== 'ABSENT' && privateInspection.kind !== 'RUNNING-CLEAN') {
    throw new Error('daemon terminal namespace durability requires ABSENT or RUNNING-CLEAN')
  }
  if (!privateInspection.namespaceId || !privateInspection.receipt) {
    throw new Error('daemon terminal namespace durability requires a published namespace')
  }
  const stage = daemonProofDirectory(
    privateInspection,
    privateInspection.paths.stageDirectory,
    'daemon terminal stage namespace'
  )
  const expectedInner = basename(daemonInnerNamespaceMarker(privateInspection.paths, privateInspection.namespaceId))
  if (stage.entries.length !== 1 || stage.entries[0].name !== expectedInner || stage.entries[0].kind !== 'file') {
    throw new Error('daemon terminal namespace is not exact inner-marker-only state')
  }
  flushDirectory(stage.directory)
  checkpoint('daemon-terminal-stage-parent-fsynced', { directory: stage.directory, kind: privateInspection.kind })
  assertDaemonInspectionCurrent(privateInspection)
  const current = cloneDaemonProtocolInspection(inspectDaemonProtocol(captured.options))
  assertDaemonInspectionCurrent(privateInspection)
  if (daemonInspectionExactSignature(current) !== daemonInspectionExactSignature(privateInspection)) {
    throw new Error('daemon terminal namespace changed during durability settle')
  }
  assertDaemonInspectionCurrent(current)
  return current
}

function daemonExactDataRecord(
  value: unknown,
  keys: readonly string[],
  label: string
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an exact plain record`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be an exact plain record`)
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (!exactKeys(descriptors as Record<string, unknown>, keys)
    || keys.some((key) => !descriptors[key]?.enumerable
      || !('value' in descriptors[key]) || descriptors[key].get || descriptors[key].set)) {
    throw new Error(`${label} must contain only exact data properties`)
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]))
}

function captureDaemonProcessTreeFacts(value: unknown, label: string): readonly DaemonProcessTreeEntryV1[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < 1 || value.length > 4096) {
    throw new Error(`${label} process tree is invalid`)
  }
  const values = value.map((entry, index) => {
    const record = daemonExactDataRecord(entry, ['pid', 'processIdentity'], `${label} process tree entry ${index}`)
    return {
      pid: positiveInteger(record.pid, `${label} process tree PID`),
      processIdentity: (() => {
        const identity = boundedText(record.processIdentity, `${label} process tree identity`, 512)
        if (!SAFE_PROCESS_IDENTITY.test(identity)) throw new Error(`${label} process tree identity is not portable`)
        return identity
      })()
    }
  })
  if (new Set(values.map((entry) => entry.pid)).size !== values.length
    || values.some((entry, index) => index > 0 && values[index - 1].pid >= entry.pid)) {
    throw new Error(`${label} process tree is not uniquely PID-sorted`)
  }
  return Object.freeze(values.map((entry) => Object.freeze({ ...entry })))
}

function captureDaemonControlTargetFacts(value: unknown): DaemonControlTargetFacts {
  const outer = daemonExactDataRecord(value, ['process', 'listener'], 'daemon control target facts')
  const rawProcess = daemonExactDataRecord(
    outer.process,
    (() => {
      if (!outer.process || typeof outer.process !== 'object') return []
      const state = Object.getOwnPropertyDescriptor(outer.process, 'state')?.value
      return state === 'alive'
        ? ['state', 'pid', 'processIdentity', 'pgid', 'processTree']
        : ['state', 'pid']
    })(),
    'daemon control process facts'
  )
  if (rawProcess.state !== 'alive' && rawProcess.state !== 'dead' && rawProcess.state !== 'unknown') {
    throw new Error('daemon control process state is invalid')
  }
  const pid = positiveInteger(rawProcess.pid, 'daemon control facts PID')
  const capturedProcess: DaemonControlProcessFacts = rawProcess.state === 'alive'
    ? (() => {
      const processIdentity = boundedText(rawProcess.processIdentity, 'daemon control facts identity', 512)
      if (!SAFE_PROCESS_IDENTITY.test(processIdentity)) throw new Error('daemon control facts identity is not portable')
      return Object.freeze({
        state: 'alive' as const,
        pid,
        processIdentity,
        pgid: positiveInteger(rawProcess.pgid, 'daemon control facts process group'),
        processTree: captureDaemonProcessTreeFacts(rawProcess.processTree, 'daemon control facts')
      })
    })()
    : Object.freeze({ state: rawProcess.state, pid })

  const listenerState = outer.listener && typeof outer.listener === 'object'
    ? Object.getOwnPropertyDescriptor(outer.listener, 'state')?.value
    : null
  const listenerKeys = listenerState === 'owned' || listenerState === 'foreign'
    ? ['state', 'port', 'pid', 'processIdentity']
    : ['state', 'port']
  const rawListener = daemonExactDataRecord(outer.listener, listenerKeys, 'daemon control listener facts')
  if (rawListener.state !== 'owned' && rawListener.state !== 'absent'
    && rawListener.state !== 'foreign' && rawListener.state !== 'unknown') {
    throw new Error('daemon control listener state is invalid')
  }
  const port = portNumber(rawListener.port)
  const capturedListener: DaemonControlListenerFacts = rawListener.state === 'owned' || rawListener.state === 'foreign'
    ? (() => {
      const processIdentity = boundedText(rawListener.processIdentity, 'daemon listener owner identity', 512)
      if (!SAFE_PROCESS_IDENTITY.test(processIdentity)) throw new Error('daemon listener owner identity is not portable')
      return Object.freeze({
        state: rawListener.state,
        port,
        pid: positiveInteger(rawListener.pid, 'daemon listener owner PID'),
        processIdentity
      })
    })()
    : Object.freeze({ state: rawListener.state, port })
  return Object.freeze({ process: capturedProcess, listener: capturedListener })
}

function captureDaemonControlActor(value: unknown): DaemonActorV1 {
  const raw = daemonExactDataRecord(value, ['pid', 'processIdentity', 'pgid', 'createdAt'], 'daemon control actor')
  return Object.freeze(validateActor(raw))
}

function captureDaemonLifecycleOwnerBinding(value: unknown): DaemonLifecycleOwnerBindingV1 | null {
  if (value === null || value === undefined) return null
  const raw = daemonExactDataRecord(value, [
    'lockToken', 'operation', 'ownerRecord', 'ownerStageNamespaceId',
    'receiptSha256', 'installId', 'dataRootId'
  ], 'daemon lifecycle-owner binding')
  return Object.freeze(validateLifecycleOwnerBinding(raw)!)
}

function daemonExactProcessTree(
  left: readonly DaemonProcessTreeEntryV1[],
  right: readonly DaemonProcessTreeEntryV1[]
): boolean {
  return left.length === right.length
    && left.every((entry, index) => entry.pid === right[index].pid
      && entry.processIdentity === right[index].processIdentity)
}

function assertDaemonLiveTargetFacts(
  target: Pick<DaemonStopTargetV1 | DaemonLegacyTargetV1,
    'pid' | 'apiPid' | 'processIdentity' | 'pgid' | 'port' | 'processTree'>,
  facts: DaemonControlTargetFacts
): void {
  if (facts.process.state !== 'alive') throw new Error('daemon control target is not exactly alive')
  if (facts.process.pid !== target.pid || facts.process.processIdentity !== target.processIdentity
    || facts.process.pgid !== target.pgid || !daemonExactProcessTree(facts.process.processTree, target.processTree)) {
    throw new Error('daemon control process identity, group, or tree drifted')
  }
  if (facts.listener.state !== 'owned' || facts.listener.port !== target.port
    || facts.listener.pid !== target.apiPid) {
    throw new Error('daemon control listener is not exactly owned by its target')
  }
  const apiProcess = target.processTree.find((entry) => entry.pid === target.apiPid)
  if (!apiProcess || apiProcess.processIdentity !== facts.listener.processIdentity) {
    throw new Error('daemon control listener owner identity drifted from the exact process tree')
  }
}

function daemonControlStageExactSignature(stage: DaemonControlStage): string {
  return canonicalDaemonJson({
    kind: stage.kind,
    reservationName: stage.reservationName,
    reservationDirectory: stage.reservationDirectory,
    manifest: stage.manifest
  })
}

function issueDaemonControlStage(
  inspection: DaemonProtocolInspection
): DaemonControlStage {
  if (!inspection.reservation || !inspection.manifest
    || inspection.manifest.operation === 'start') {
    throw new Error('daemon control stage inspection has no complete control manifest')
  }
  const stage: DaemonControlStage = Object.freeze({
    kind: inspection.manifest.operation === 'stop'
      ? 'DAEMON-STOP-STAGE' as const
      : 'DAEMON-LEGACY-RETIRE-STAGE' as const,
    reservationName: inspection.reservation.name,
    reservationDirectory: join(inspection.paths.stageDirectory, inspection.reservation.name),
    manifest: cloneDaemonCanonicalRecord(inspection.manifest)
  })
  daemonPrivateControlStages.set(stage, {
    stage: cloneDaemonCanonicalRecord(stage),
    issuedSignature: daemonControlStageExactSignature(stage)
  })
  return stage
}

function assertIssuedDaemonControlStage(stage: DaemonControlStage): DaemonPrivateControlStage {
  const privateStage = daemonPrivateControlStages.get(stage)
  if (!privateStage || daemonControlStageExactSignature(stage) !== privateStage.issuedSignature) {
    throw new Error('daemon control stage was not issued by this protocol instance or was changed')
  }
  return privateStage
}

type CapturedDaemonControlCreateOptions = Readonly<{
  operationId: string
  actor: DaemonActorV1
  lifecycleOwnerBinding: DaemonLifecycleOwnerBindingV1 | null
  targetFacts: DaemonControlTargetFacts
  checkpoint: DaemonProtocolCheckpoint
}>

function captureDaemonControlCreateOptions(value: CreateDaemonControlStageOptions): CapturedDaemonControlCreateOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('daemon control stage options must be an exact plain record')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('daemon control stage options must be an exact plain record')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const allowed = new Set(['operationId', 'actor', 'lifecycleOwnerBinding', 'targetFacts', 'checkpoint'])
  if (!descriptors.operationId || !descriptors.actor || !descriptors.targetFacts
    || Object.keys(descriptors).some((key) => !allowed.has(key))
    || Object.values(descriptors).some((descriptor) => !descriptor.enumerable
      || !('value' in descriptor) || descriptor.get || descriptor.set)) {
    throw new Error('daemon control stage options must contain only exact data properties')
  }
  const operationId = uuid(descriptors.operationId.value, 'daemon control operation id')
  const actor = captureDaemonControlActor(descriptors.actor.value)
  const lifecycleOwnerBinding = captureDaemonLifecycleOwnerBinding(descriptors.lifecycleOwnerBinding?.value)
  const targetFacts = captureDaemonControlTargetFacts(descriptors.targetFacts.value)
  const rawCheckpoint = descriptors.checkpoint?.value
  if (rawCheckpoint !== undefined && typeof rawCheckpoint !== 'function') {
    throw new Error('daemon control checkpoint is invalid')
  }
  return Object.freeze({
    operationId,
    actor,
    lifecycleOwnerBinding,
    targetFacts,
    checkpoint: rawCheckpoint || (() => {})
  })
}

function assertDaemonLifecycleOwnerSnapshotCurrent(
  authority: DaemonLifecycleOwnerAuthoritySnapshot | null
): void {
  if (!authority) return
  assertCapturedCurrent(authority.ownerRecord, 'daemon lifecycle-owner record')
  for (const file of authority.files) assertCapturedCurrent(file, 'daemon lifecycle-owner proof file')
  for (const directory of authority.directories) {
    assertDaemonDirectoryCurrent(directory, 'daemon lifecycle-owner proof directory')
  }
}

function assertDaemonControlStageCreationEpoch(
  inspection: DaemonProtocolInspection,
  reservation: DaemonCapturedDirectory,
  manifestPath: string,
  manifest: DaemonCapturedFile | null,
  lifecycleOwner: DaemonLifecycleOwnerAuthoritySnapshot | null
): void {
  assertDaemonInspectionExternalCurrent(inspection, [
    inspection.paths.stageDirectory,
    reservation.directory,
    manifestPath
  ])
  assertDaemonLifecycleOwnerSnapshotCurrent(lifecycleOwner)
  const stageState = inspection.proof.directories.find((directory) =>
    samePath(directory.directory, inspection.paths.stageDirectory, inspection.proof.platform))
  if (!stageState) throw new Error('daemon control creation has no frozen stage namespace')
  const currentStage = assertPlainDirectory(inspection.paths.stageDirectory, 'daemon control stage namespace')
  if (currentStage.dev !== stageState.state.dev || currentStage.ino !== stageState.state.ino) {
    throw new Error('daemon control stage namespace identity changed')
  }
  const expectedInner = basename(daemonInnerNamespaceMarker(inspection.paths, inspection.namespaceId!))
  const expectedStageEntries = [expectedInner, basename(reservation.directory)]
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
  const stageEntries = boundedEntries(
    inspection.paths.stageDirectory,
    DAEMON_STAGE_NAMESPACE_MAX_ENTRIES,
    'daemon control stage namespace'
  )
  if (stageEntries.length !== expectedStageEntries.length
    || stageEntries.some((entry, index) => entry.name !== expectedStageEntries[index])
    || stageEntries.some((entry) => entry.name === expectedInner
      ? !entry.isFile() || entry.isSymbolicLink()
      : !entry.isDirectory() || entry.isSymbolicLink())) {
    throw new Error('daemon control stage namespace inventory changed')
  }
  const currentReservation = assertPlainDirectory(reservation.directory, 'daemon control reservation')
  if (currentReservation.dev !== reservation.state.dev || currentReservation.ino !== reservation.state.ino) {
    throw new Error('daemon control reservation identity changed')
  }
  const reservationEntries = boundedEntries(reservation.directory, 2, 'daemon control reservation')
  const expectedManifestEntries = manifest ? ['stage-manifest-v1.json'] : []
  if (reservationEntries.length !== expectedManifestEntries.length
    || reservationEntries.some((entry, index) => entry.name !== expectedManifestEntries[index])
    || reservationEntries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error('daemon control reservation inventory changed')
  }
  if (manifest) assertCapturedCurrent(manifest, 'daemon control in-flight manifest', [manifest.state.nlink])
  else if (lstatOptional(manifestPath)) throw new Error('daemon control manifest appeared outside its writer epoch')
}

function deriveDaemonStopTarget(
  inspection: DaemonProtocolInspection,
  facts: DaemonControlTargetFacts
): DaemonStopTargetV1 {
  const instance = inspection.instance
  if (!instance) throw new Error('daemon stop creation has no immutable running instance')
  const final = daemonProofFile(inspection, inspection.paths.finalInstance)
  if (!final) throw new Error('daemon stop creation has no frozen final instance file')
  let processTree: readonly DaemonProcessTreeEntryV1[]
  if (facts.process.state === 'alive' && facts.process.processIdentity === instance.processIdentity) {
    processTree = facts.process.processTree
  } else if (facts.process.state === 'alive') {
    if (facts.process.pid !== instance.pid || facts.listener.state !== 'absent'
      || facts.listener.port !== instance.port) {
      throw new Error('PID-reused daemon stop target does not have an absent exact listener')
    }
    processTree = Object.freeze([Object.freeze({ pid: instance.pid, processIdentity: instance.processIdentity })])
  } else if (facts.process.state === 'dead') {
    if (facts.process.pid !== instance.pid || facts.listener.state !== 'absent'
      || facts.listener.port !== instance.port) {
      throw new Error('dead daemon stop target does not have an absent exact listener')
    }
    processTree = Object.freeze([Object.freeze({ pid: instance.pid, processIdentity: instance.processIdentity })])
  } else {
    throw new Error('daemon stop target process facts are unknown')
  }
  const target = validateStopTarget({
    instance: daemonFileIdentity(final),
    projections: instance.projections,
    epochId: instance.epochId,
    pid: instance.pid,
    apiPid: instance.apiPid,
    processIdentity: instance.processIdentity,
    pgid: instance.pgid,
    port: instance.port,
    processTree
  })
  if (facts.process.state === 'alive' && facts.process.processIdentity === instance.processIdentity) {
    assertDaemonLiveTargetFacts(target, facts)
  }
  return target
}

function deriveDaemonLegacyTarget(
  inspection: DaemonProtocolInspection,
  facts: DaemonControlTargetFacts
): DaemonLegacyTargetV1 {
  if (facts.process.state !== 'alive' || facts.listener.state !== 'owned') {
    throw new Error('legacy retirement requires an exactly live identity and owned listener before staging')
  }
  const projections = {
    pid: daemonProofFile(inspection, inspection.paths.pidProjection),
    apiPid: daemonProofFile(inspection, inspection.paths.apiPidProjection),
    heartbeat: daemonProofFile(inspection, inspection.paths.heartbeatProjection)
  }
  const target = validateLegacyTarget({
    projections: {
      pid: projections.pid ? daemonFileIdentity(projections.pid) : null,
      apiPid: projections.apiPid ? daemonFileIdentity(projections.apiPid) : null,
      heartbeat: projections.heartbeat ? daemonFileIdentity(projections.heartbeat) : null
    },
    pid: facts.process.pid,
    apiPid: facts.listener.pid,
    processIdentity: facts.process.processIdentity,
    pgid: facts.process.pgid,
    port: facts.listener.port,
    processTree: facts.process.processTree
  })
  assertControlProjectionSubset(
    target,
    projections,
    inspection.paths.dataRoot,
    inspection.receipt!.packageRoot,
    false
  )
  assertDaemonLiveTargetFacts(target, facts)
  return target
}

function createDaemonControlStageInternal(
  operation: 'stop' | 'legacy-retire',
  options: InspectDaemonProtocolOptions,
  expectedInspection: DaemonProtocolInspection,
  createOptions: CreateDaemonControlStageOptions
): DaemonControlStage {
  const capturedCreate = captureDaemonControlCreateOptions(createOptions)
  const captured = capturePrivateDaemonInspection(options, expectedInspection)
  const inspection = captured.inspection
  const expectedKind = operation === 'stop' ? 'RUNNING-CLEAN' : 'LEGACY-NAMESPACE-RECOVERABLE'
  if (inspection.kind !== expectedKind || !inspection.namespaceId || !inspection.receipt
    || !inspection.proof.receipt) {
    throw new Error(`daemon ${operation} creation requires frozen ${expectedKind}`)
  }
  const receipt = inspection.proof.receipt
  const lifecycleOwner = capturedCreate.lifecycleOwnerBinding
    ? readBoundLifecycleOwnerAuthority(
      { lifecycleOwnerBinding: capturedCreate.lifecycleOwnerBinding } as DaemonStopStageManifestV1,
      receipt,
      captured.options.readLifecycleOwnerAuthority
    )
    : null
  const target = operation === 'stop'
    ? deriveDaemonStopTarget(inspection, capturedCreate.targetFacts)
    : deriveDaemonLegacyTarget(inspection, capturedCreate.targetFacts)
  const binding: DaemonReservationBinding = {
    stageNamespaceId: inspection.namespaceId,
    receiptSha256: receipt.receiptSha256,
    installId: inspection.receipt.installId,
    dataRootId: inspection.receipt.dataRootId,
    operationId: capturedCreate.operationId,
    actorPid: capturedCreate.actor.pid,
    actorProcessIdentity: capturedCreate.actor.processIdentity,
    actorPgid: capturedCreate.actor.pgid,
    operation,
    packageSha256: inspection.receipt.packageSha256 as DaemonSha256,
    createdAt: capturedCreate.actor.createdAt
  }
  const reservationName = daemonReservationName(binding)
  const reservationDirectory = join(inspection.paths.stageDirectory, reservationName)
  if (lstatOptional(reservationDirectory)) throw new Error('daemon control reservation already exists')
  assertDaemonInspectionCurrent(inspection)
  assertDaemonLifecycleOwnerSnapshotCurrent(lifecycleOwner)
  fs.mkdirSync(reservationDirectory)
  const reservation = captureDaemonDirectory(reservationDirectory, 1, 'daemon control reservation')
  if (reservation.entries.length !== 0) throw new Error('new daemon control reservation is not empty')
  capturedCreate.checkpoint('daemon-control-reservation-directory-created', { operation, reservationName })
  assertDaemonControlStageCreationEpoch(inspection, reservation,
    join(reservationDirectory, 'stage-manifest-v1.json'), null, lifecycleOwner)
  flushDirectory(inspection.paths.stageDirectory)
  capturedCreate.checkpoint('daemon-control-reservation-parent-fsynced', { operation, reservationName })
  assertDaemonControlStageCreationEpoch(inspection, reservation,
    join(reservationDirectory, 'stage-manifest-v1.json'), null, lifecycleOwner)

  const dataRootStat = assertPlainDirectory(inspection.paths.dataRoot, 'daemon control data root')
  const reviewStat = assertPlainDirectory(inspection.paths.reviewDirectory, 'daemon control review directory')
  const stageStat = assertPlainDirectory(inspection.paths.stageDirectory, 'daemon control stage namespace')
  const manifest = validateDaemonStageManifest({
    schemaVersion: DAEMON_PROTOCOL_VERSION,
    product: PRODUCT_NAME,
    operation,
    reservationName,
    stageNamespaceId: binding.stageNamespaceId,
    receiptSha256: binding.receiptSha256,
    installId: binding.installId,
    dataRootId: binding.dataRootId,
    operationId: binding.operationId,
    packageRoot: resolve(inspection.receipt.packageRoot),
    packageVersion: inspection.receipt.packageVersion,
    packageSha256: inspection.receipt.packageSha256,
    dataRoot: resolve(inspection.receipt.dataRoot),
    actor: capturedCreate.actor,
    lifecycleOwnerBinding: capturedCreate.lifecycleOwnerBinding,
    target,
    roots: {
      dataRoot: daemonDirectoryIdentity(dataRootStat),
      review: daemonDirectoryIdentity(reviewStat),
      stage: daemonDirectoryIdentity(stageStat),
      reservation: daemonDirectoryIdentity(reservation.state)
    }
  }) as DaemonStopStageManifestV1 | DaemonLegacyRetireStageManifestV1
  const manifestPath = join(reservationDirectory, 'stage-manifest-v1.json')
  const manifestFile = writeDaemonFileExclusiveDurable(
    manifestPath,
    daemonStageManifestBytes(manifest),
    DAEMON_STAGE_MANIFEST_MAX_BYTES,
    `daemon ${operation} stage manifest`,
    capturedCreate.checkpoint,
    (inFlight) => assertDaemonControlStageCreationEpoch(
      inspection,
      reservation,
      manifestPath,
      inFlight,
      lifecycleOwner
    )
  )
  assertDaemonControlStageCreationEpoch(inspection, reservation, manifestPath, manifestFile, lifecycleOwner)
  capturedCreate.checkpoint('daemon-control-manifest-durable', { operation, reservationName })
  assertDaemonControlStageCreationEpoch(inspection, reservation, manifestPath, manifestFile, lifecycleOwner)
  const current = inspectDaemonProtocol(captured.options)
  if (current.kind !== (operation === 'stop' ? 'STOPPING' : 'LEGACY-RETIRING')
    || current.reservation?.name !== reservationName || current.manifest?.operation !== operation) {
    throw new Error(current.reason || `daemon ${operation} stage did not become actionable`)
  }
  assertDaemonInspectionCurrent(current)
  return issueDaemonControlStage(current)
}

export function createDaemonStopStage(
  options: InspectDaemonProtocolOptions,
  expectedInspection: DaemonProtocolInspection,
  createOptions: CreateDaemonControlStageOptions
): DaemonControlStage {
  return createDaemonControlStageInternal('stop', options, expectedInspection, createOptions)
}

export function createDaemonLegacyRetireStage(
  options: InspectDaemonProtocolOptions,
  expectedInspection: DaemonProtocolInspection,
  createOptions: CreateDaemonControlStageOptions
): DaemonControlStage {
  return createDaemonControlStageInternal('legacy-retire', options, expectedInspection, createOptions)
}

export function recoverDaemonControlStage(
  options: InspectDaemonProtocolOptions,
  expectedInspection: DaemonProtocolInspection,
  checkpoint: DaemonProtocolCheckpoint = () => {}
): DaemonControlStage {
  const captured = capturePrivateDaemonInspection(options, expectedInspection)
  const inspection = captured.inspection
  if (!isDaemonActionableControlInspection(inspection) || !inspection.reservation || !inspection.manifest) {
    throw new Error('daemon control stage recovery requires a complete STOPPING or LEGACY-RETIRING authority')
  }
  const manifestFile = daemonProofFile(
    inspection,
    join(inspection.paths.stageDirectory, inspection.reservation.name, 'stage-manifest-v1.json')
  )
  if (!manifestFile) throw new Error('daemon control stage recovery lost its manifest file')
  assertDaemonInspectionCurrent(inspection)
  const descriptor = fs.openSync(manifestFile.file, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0))
  try {
    const stat = fs.fstatSync(descriptor)
    if (stat.dev !== manifestFile.state.dev || stat.ino !== manifestFile.state.ino) {
      throw new Error('daemon control manifest changed before recovery fsync')
    }
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  checkpoint('daemon-control-manifest-recovered-fsynced', {
    operation: inspection.manifest.operation,
    reservationName: inspection.reservation.name
  })
  assertDaemonInspectionCurrent(inspection)
  flushDirectory(dirname(manifestFile.file))
  checkpoint('daemon-control-reservation-recovered-fsynced', {
    operation: inspection.manifest.operation,
    reservationName: inspection.reservation.name
  })
  assertDaemonInspectionCurrent(inspection)
  flushDirectory(inspection.paths.stageDirectory)
  checkpoint('daemon-control-stage-parent-recovered-fsynced', {
    operation: inspection.manifest.operation,
    reservationName: inspection.reservation.name
  })
  assertDaemonInspectionCurrent(inspection)
  return issueDaemonControlStage(inspection)
}

export function assertDaemonControlStageCurrent(stage: DaemonControlStage): void {
  assertIssuedDaemonControlStage(stage)
}

function daemonControlSignalAuthoritySignature(authority: DaemonControlSignalAuthority): string {
  return canonicalDaemonJson({ kind: authority.kind, operation: authority.operation })
}

export function acquireDaemonControlSignalAuthority(
  options: InspectDaemonProtocolOptions,
  expectedInspection: DaemonProtocolInspection,
  targetFacts: DaemonControlTargetFacts
): DaemonControlSignalAuthority {
  const captured = capturePrivateDaemonInspection(options, expectedInspection)
  const inspection = captured.inspection
  if (!isDaemonActionableControlInspection(inspection) || !inspection.manifest) {
    throw new Error('daemon signal authority requires a complete actionable control stage')
  }
  const facts = captureDaemonControlTargetFacts(targetFacts)
  assertDaemonInspectionCurrent(inspection)
  assertDaemonLiveTargetFacts(inspection.manifest.target, facts)
  assertDaemonInspectionCurrent(inspection)
  const authority: DaemonControlSignalAuthority = Object.freeze({
    kind: 'DAEMON-CONTROL-SIGNAL',
    operation: inspection.manifest.operation
  })
  daemonPrivateControlSignalAuthorities.set(authority, Object.freeze({
    inspectionSignature: daemonInspectionExactSignature(inspection),
    target: Object.freeze({
      operation: inspection.manifest.operation,
      pid: inspection.manifest.target.pid,
      processIdentity: inspection.manifest.target.processIdentity,
      pgid: inspection.manifest.target.pgid,
      processTree: Object.freeze(inspection.manifest.target.processTree
        .map((entry) => Object.freeze({ ...entry })))
    })
  }))
  return authority
}

export function readDaemonControlSignalTarget(
  authority: DaemonControlSignalAuthority
): DaemonControlSignalTarget {
  const privateAuthority = daemonPrivateControlSignalAuthorities.get(authority)
  if (!privateAuthority
    || daemonControlSignalAuthoritySignature(authority) !== canonicalDaemonJson({
      kind: 'DAEMON-CONTROL-SIGNAL',
      operation: privateAuthority.target.operation
    })) {
    throw new Error('daemon signal authority was not issued by this protocol instance or was changed')
  }
  return Object.freeze({
    ...privateAuthority.target,
    processTree: Object.freeze(privateAuthority.target.processTree.map((entry) => Object.freeze({ ...entry })))
  })
}

function createDaemonControlMutationEpoch(
  options: InspectDaemonProtocolOptions,
  inspection: DaemonProtocolInspection
): DaemonControlMutationEpoch {
  const frozenOptions = cloneInspectDaemonProtocolOptions(options)
  const frozenInspection = cloneDaemonProtocolInspection(inspection)
  if (!isDaemonActionableControlInspection(frozenInspection) || !frozenInspection.reservation
    || !frozenInspection.manifest) {
    throw new Error('daemon control mutation requires complete actionable authority')
  }
  assertDaemonInspectionCurrent(frozenInspection)
  const reservationDirectory = join(frozenInspection.paths.stageDirectory, frozenInspection.reservation.name)
  const stageDirectory = daemonProofDirectory(
    frozenInspection,
    frozenInspection.paths.stageDirectory,
    'daemon control stage namespace'
  )
  const reservation = daemonProofDirectory(frozenInspection, reservationDirectory, 'daemon control reservation')
  const ownedPaths = [
    frozenInspection.paths.heartbeatProjection,
    frozenInspection.paths.apiPidProjection,
    frozenInspection.paths.pidProjection,
    frozenInspection.paths.finalInstance,
    join(reservationDirectory, 'stage-manifest-v1.json')
  ]
  const owned = new Map<string, DaemonOwnedFileSlot>()
  for (const file of ownedPaths) {
    const key = daemonMutationPathKey(file, frozenInspection.proof.platform)
    if (owned.has(key)) throw new Error('daemon control mutation paths are not disjoint')
    owned.set(key, { path: file, captured: daemonProofFile(frozenInspection, file) })
  }
  const epoch: DaemonControlMutationEpoch = {
    options: frozenOptions,
    inspection: frozenInspection,
    mode: 'RETIREMENT',
    operation: frozenInspection.manifest.operation,
    stageDirectory,
    reservationDirectory: reservation,
    reservationPresent: true,
    reservationRemovalExpected: null,
    owned,
    fileRemovalExpected: new Map(),
    reviewBarrierComplete: false,
    reservationBarrierComplete: false
  }
  assertDaemonControlMutationEpoch(epoch)
  return epoch
}

function daemonControlOwnedSlot(epoch: DaemonControlMutationEpoch, file: string): DaemonOwnedFileSlot {
  const slot = epoch.owned.get(daemonMutationPathKey(file, epoch.inspection.proof.platform))
  if (!slot) throw new Error(`daemon control mutation does not own protocol path: ${file}`)
  return slot
}

function assertDaemonControlMutationExternalAuthority(epoch: DaemonControlMutationEpoch): void {
  const proof = epoch.inspection.proof
  const owned = [...epoch.owned.values()].map((slot) => slot.path)
  const ignored = (candidate: string) => owned.some((file) => samePath(file, candidate, proof.platform))
    || samePath(epoch.stageDirectory.directory, candidate, proof.platform)
    || samePath(epoch.reservationDirectory.directory, candidate, proof.platform)
  if (proof.receipt && proof.readReceiptAuthority) {
    assertDaemonReceiptNamespaceSnapshot(proof.receipt, proof.readReceiptAuthority, proof.platform)
  }
  for (const expected of proof.directoryIdentities) {
    const current = assertPlainDirectory(expected.directory, 'daemon control mutation authority root')
    if (current.dev !== expected.state.dev || current.ino !== expected.state.ino) {
      throw new Error('daemon control mutation authority root identity changed')
    }
  }
  for (const directory of proof.directories) {
    if (!ignored(directory.directory)) assertDaemonDirectoryCurrent(directory, 'daemon control external directory')
  }
  for (const file of proof.files) {
    if (!ignored(file.file)) assertCapturedCurrent(file, 'daemon control external file', [file.state.nlink])
  }
  for (const absent of proof.absent) {
    if (!ignored(absent) && lstatOptional(absent)) {
      throw new Error(`daemon control external absent path reappeared: ${absent}`)
    }
  }
}

function assertDaemonControlMutationInventory(epoch: DaemonControlMutationEpoch): void {
  const currentStage = assertPlainDirectory(epoch.stageDirectory.directory, 'daemon control mutation stage namespace')
  if (currentStage.dev !== epoch.stageDirectory.state.dev || currentStage.ino !== epoch.stageDirectory.state.ino) {
    throw new Error('daemon control mutation stage namespace identity changed')
  }
  const inner = basename(daemonInnerNamespaceMarker(epoch.inspection.paths, epoch.inspection.namespaceId!))
  const expectedStageEntries = [inner, ...(epoch.reservationPresent ? [basename(epoch.reservationDirectory.directory)] : [])]
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
  const stageEntries = boundedEntries(
    epoch.stageDirectory.directory,
    DAEMON_STAGE_NAMESPACE_MAX_ENTRIES,
    'daemon control mutation stage namespace'
  )
  if (stageEntries.length !== expectedStageEntries.length
    || stageEntries.some((entry, index) => entry.name !== expectedStageEntries[index])
    || stageEntries.some((entry) => entry.name === inner
      ? !entry.isFile() || entry.isSymbolicLink()
      : !entry.isDirectory() || entry.isSymbolicLink())) {
    throw new Error('daemon control mutation stage namespace inventory changed')
  }
  if (!epoch.reservationPresent) {
    if (lstatOptional(epoch.reservationDirectory.directory)) {
      throw new Error('removed daemon control reservation reappeared')
    }
    return
  }
  const currentReservation = assertPlainDirectory(epoch.reservationDirectory.directory, 'daemon control reservation')
  if (currentReservation.dev !== epoch.reservationDirectory.state.dev
    || currentReservation.ino !== epoch.reservationDirectory.state.ino) {
    throw new Error('daemon control reservation identity changed')
  }
  const manifestPath = join(epoch.reservationDirectory.directory, 'stage-manifest-v1.json')
  const expectedEntries = daemonControlOwnedSlot(epoch, manifestPath).captured
    ? ['stage-manifest-v1.json'] : []
  const entries = boundedEntries(epoch.reservationDirectory.directory, 2, 'daemon control reservation')
  if (entries.length !== expectedEntries.length
    || entries.some((entry, index) => entry.name !== expectedEntries[index])
    || entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error('daemon control reservation inventory changed')
  }
}

function assertDaemonControlMutationTopology(epoch: DaemonControlMutationEpoch): void {
  const paths = epoch.inspection.paths
  const pid = Boolean(daemonControlOwnedSlot(epoch, paths.pidProjection).captured)
  const apiPid = Boolean(daemonControlOwnedSlot(epoch, paths.apiPidProjection).captured)
  const heartbeat = Boolean(daemonControlOwnedSlot(epoch, paths.heartbeatProjection).captured)
  const final = Boolean(daemonControlOwnedSlot(epoch, paths.finalInstance).captured)
  const manifest = Boolean(daemonControlOwnedSlot(
    epoch,
    join(epoch.reservationDirectory.directory, 'stage-manifest-v1.json')
  ).captured)
  if (epoch.operation === 'stop') {
    if (!final && (pid || apiPid || heartbeat)) {
      throw new Error('daemon stop mutation removed final authority before its projections')
    }
    if (heartbeat && (!apiPid || !pid) || apiPid && !pid) {
      throw new Error('daemon stop mutation did not follow heartbeat, API PID, PID order')
    }
  } else if (final) {
    throw new Error('legacy retirement unexpectedly owns v1 final authority')
  }
  if (epoch.mode === 'RETIREMENT' && !manifest && (pid || apiPid || heartbeat || final)) {
    throw new Error('daemon control mutation removed manifest before its target files')
  }
}

function assertDaemonControlMutationEpoch(epoch: DaemonControlMutationEpoch): void {
  assertDaemonControlMutationExternalAuthority(epoch)
  assertDaemonControlMutationInventory(epoch)
  for (const slot of epoch.owned.values()) {
    if (slot.captured) {
      assertFrozenDaemonFile(slot.captured, `daemon control mutation ${basename(slot.path)}`, slot.captured.state.nlink)
    } else if (lstatOptional(slot.path)) {
      throw new Error(`daemon control mutation absent path reappeared: ${slot.path}`)
    }
  }
  assertDaemonControlMutationTopology(epoch)
}

function removeDaemonControlMutationFile(
  epoch: DaemonControlMutationEpoch,
  file: string,
  label: string,
  checkpoint: DaemonProtocolCheckpoint
): void {
  const slot = daemonControlOwnedSlot(epoch, file)
  const key = daemonMutationPathKey(file, epoch.inspection.proof.platform)
  let expected = epoch.fileRemovalExpected.get(key)
  if (!expected) {
    if (!slot.captured) return
    expected = slot.captured
    epoch.fileRemovalExpected.set(key, expected)
  }
  unlinkDaemonFileExactDurable(
    expected,
    label,
    checkpoint,
    () => assertDaemonControlMutationEpoch(epoch),
    () => {
      if (lstatOptional(file)) throw new Error(`${label} reappeared after unlink`)
      slot.captured = null
    }
  )
  epoch.fileRemovalExpected.delete(key)
}

function settleDaemonControlMutationBarrier(
  epoch: DaemonControlMutationEpoch,
  kind: 'review' | 'reservation',
  checkpoint: DaemonProtocolCheckpoint
): void {
  const complete = kind === 'review' ? epoch.reviewBarrierComplete : epoch.reservationBarrierComplete
  if (complete || kind === 'reservation' && !epoch.reservationPresent) return
  const directory = kind === 'review'
    ? epoch.inspection.paths.reviewDirectory
    : epoch.reservationDirectory.directory
  assertDaemonControlMutationEpoch(epoch)
  flushDirectory(directory)
  checkpoint(`daemon-control-${kind}-recovery-fsynced`, { operation: epoch.operation, directory })
  assertDaemonControlMutationEpoch(epoch)
  if (kind === 'review') epoch.reviewBarrierComplete = true
  else epoch.reservationBarrierComplete = true
}

function removeDaemonControlReservation(
  epoch: DaemonControlMutationEpoch,
  checkpoint: DaemonProtocolCheckpoint
): void {
  if (!epoch.reservationPresent && !epoch.reservationRemovalExpected) return
  assertDaemonControlMutationEpoch(epoch)
  if (!epoch.reservationRemovalExpected) {
    const empty = captureDaemonDirectory(epoch.reservationDirectory.directory, 1, 'empty daemon control reservation')
    if (empty.entries.length !== 0 || empty.state.dev !== epoch.reservationDirectory.state.dev
      || empty.state.ino !== epoch.reservationDirectory.state.ino) {
      throw new Error('daemon control reservation is not the frozen empty directory')
    }
    epoch.reservationRemovalExpected = empty
  }
  const removal = epoch.reservationRemovalExpected
  removeDaemonDirectoryExactDurable(
    removal,
    'empty daemon control reservation',
    checkpoint,
    () => assertDaemonControlMutationEpoch(epoch),
    () => {
      if (lstatOptional(epoch.reservationDirectory.directory)) {
        throw new Error('daemon control reservation reappeared after rmdir')
      }
      epoch.reservationPresent = false
    }
  )
}

function createAbandonedDaemonControlMutationEpoch(
  options: InspectDaemonProtocolOptions,
  inspection: DaemonProtocolInspection
): DaemonControlMutationEpoch {
  const frozenOptions = cloneInspectDaemonProtocolOptions(options)
  const frozenInspection = cloneDaemonProtocolInspection(inspection)
  if ((frozenInspection.kind !== 'STOPPING-PARTIAL'
      && frozenInspection.kind !== 'LEGACY-RETIRING-PARTIAL')
    || !frozenInspection.reservation || !frozenInspection.namespaceId || !frozenInspection.receipt) {
    throw new Error('abandoned daemon control cleanup requires a partial control reservation')
  }
  assertDaemonInspectionCurrent(frozenInspection)
  const reservationDirectory = join(frozenInspection.paths.stageDirectory, frozenInspection.reservation.name)
  const stageDirectory = daemonProofDirectory(
    frozenInspection,
    frozenInspection.paths.stageDirectory,
    'abandoned daemon control stage namespace'
  )
  const reservation = daemonProofDirectory(
    frozenInspection,
    reservationDirectory,
    'abandoned daemon control reservation'
  )
  const ownedPaths = [
    frozenInspection.paths.heartbeatProjection,
    frozenInspection.paths.apiPidProjection,
    frozenInspection.paths.pidProjection,
    frozenInspection.paths.finalInstance,
    join(reservationDirectory, 'stage-manifest-v1.json')
  ]
  const owned = new Map<string, DaemonOwnedFileSlot>()
  for (const file of ownedPaths) {
    owned.set(daemonMutationPathKey(file, frozenInspection.proof.platform), {
      path: file,
      captured: daemonProofFile(frozenInspection, file)
    })
  }
  const epoch: DaemonControlMutationEpoch = {
    options: frozenOptions,
    inspection: frozenInspection,
    mode: 'ABANDONED',
    operation: frozenInspection.reservation.operation === 'stop' ? 'stop' : 'legacy-retire',
    stageDirectory,
    reservationDirectory: reservation,
    reservationPresent: true,
    reservationRemovalExpected: null,
    owned,
    fileRemovalExpected: new Map(),
    reviewBarrierComplete: false,
    reservationBarrierComplete: false
  }
  assertDaemonControlMutationEpoch(epoch)
  return epoch
}

export function acquireAbandonedDaemonControlStageCleanupAuthority(
  options: InspectDaemonProtocolOptions,
  expectedInspection: DaemonProtocolInspection,
  probeActor: DaemonStartActorProbe
): DaemonAbandonedControlStageCleanupAuthority {
  if (typeof probeActor !== 'function') throw new Error('daemon control actor probe is invalid')
  const captured = capturePrivateDaemonInspection(options, expectedInspection)
  const inspection = captured.inspection
  if ((inspection.kind !== 'STOPPING-PARTIAL' && inspection.kind !== 'LEGACY-RETIRING-PARTIAL')
    || !inspection.reservation) {
    throw new Error('abandoned daemon control cleanup requires STOPPING-PARTIAL or LEGACY-RETIRING-PARTIAL')
  }
  const facts = validateDaemonActorProbeFacts(probeActor({ pid: inspection.reservation.actorPid }))
  assertDaemonInspectionCurrent(inspection)
  let disposition: DaemonAbandonedControlStageCleanupAuthority['disposition']
  if (facts.state === 'dead') {
    disposition = 'dead'
  } else if (facts.state === 'alive') {
    const identitySha16 = createHash('sha256').update(facts.processIdentity).digest('hex').slice(0, 16)
    if (identitySha16 !== inspection.reservation.actorProcessIdentitySha16) {
      disposition = 'pid-reused'
    } else if (facts.pgid !== inspection.reservation.actorPgid) {
      throw new Error('daemon control actor identity matches but its process group drifted')
    } else {
      throw new Error('daemon control stage actor is still alive')
    }
  } else {
    throw new Error('daemon control stage actor state is unknown')
  }
  assertDaemonInspectionCurrent(inspection)
  const authority: DaemonAbandonedControlStageCleanupAuthority = Object.freeze({
    kind: 'ABANDONED-DAEMON-CONTROL-STAGE-CLEANUP',
    operation: inspection.reservation.operation === 'stop' ? 'stop' : 'legacy-retire',
    disposition
  })
  daemonAbandonedControlStageCleanupEpochs.set(
    authority,
    createAbandonedDaemonControlMutationEpoch(captured.options, inspection)
  )
  return authority
}

export function cleanupAbandonedDaemonControlStage(
  authority: DaemonAbandonedControlStageCleanupAuthority,
  checkpoint: DaemonProtocolCheckpoint = () => {}
): DaemonProtocolInspection {
  const epoch = daemonAbandonedControlStageCleanupEpochs.get(authority)
  if (!epoch || epoch.mode !== 'ABANDONED'
    || authority.kind !== 'ABANDONED-DAEMON-CONTROL-STAGE-CLEANUP'
    || authority.operation !== epoch.operation
    || authority.disposition !== 'dead' && authority.disposition !== 'pid-reused') {
    throw new Error('abandoned daemon control cleanup authority was not issued or was changed')
  }
  settleDaemonControlMutationBarrier(epoch, 'review', checkpoint)
  settleDaemonControlMutationBarrier(epoch, 'reservation', checkpoint)
  removeDaemonControlMutationFile(
    epoch,
    join(epoch.reservationDirectory.directory, 'stage-manifest-v1.json'),
    'abandoned daemon control manifest',
    checkpoint
  )
  removeDaemonControlReservation(epoch, checkpoint)
  assertDaemonControlMutationEpoch(epoch)
  const current = cloneDaemonProtocolInspection(inspectDaemonProtocol(epoch.options))
  assertDaemonControlMutationEpoch(epoch)
  const expectedKind = epoch.operation === 'stop'
    ? epoch.inspection.publicProjectionCount > 0 || epoch.inspection.instance ? 'RUNNING-CLEAN' : 'ABSENT'
    : epoch.inspection.publicProjectionCount > 0 ? 'LEGACY-NAMESPACE-RECOVERABLE' : 'ABSENT'
  if (current.kind !== expectedKind || current.namespaceId !== epoch.inspection.namespaceId
    || canonicalDaemonJson(current.receipt) !== canonicalDaemonJson(epoch.inspection.receipt)) {
    throw new Error(`abandoned daemon control cleanup did not restore ${expectedKind}`)
  }
  assertDaemonInspectionCurrent(current)
  return current
}

export function acquireDaemonControlRetirementAuthority(
  options: InspectDaemonProtocolOptions,
  expectedInspection: DaemonProtocolInspection,
  targetFacts: DaemonControlTargetFacts
): DaemonControlRetirementAuthority {
  const captured = capturePrivateDaemonInspection(options, expectedInspection)
  const inspection = captured.inspection
  if (!isDaemonActionableControlInspection(inspection) || !inspection.manifest) {
    throw new Error('daemon retirement authority requires a complete actionable control stage')
  }
  const facts = captureDaemonControlTargetFacts(targetFacts)
  const target = inspection.manifest.target
  assertDaemonInspectionCurrent(inspection)
  if (facts.listener.state !== 'absent' || facts.listener.port !== target.port) {
    throw new Error('daemon retirement requires the exact target listener to be absent')
  }
  if (facts.process.pid !== target.pid) {
    throw new Error('daemon retirement process facts do not address the frozen target PID')
  }
  let disposition: DaemonControlRetirementAuthority['disposition']
  if (facts.process.state === 'dead') {
    disposition = 'dead'
  } else if (facts.process.state === 'alive') {
    if (facts.process.processIdentity === target.processIdentity) {
      if (facts.process.pgid !== target.pgid) {
        throw new Error('daemon retirement refuses matching identity with process-group drift')
      }
      throw new Error('daemon retirement refuses a still-live exact target')
    }
    disposition = 'pid-reused'
  } else {
    throw new Error('daemon retirement process facts are unknown')
  }
  assertDaemonInspectionCurrent(inspection)
  const authority: DaemonControlRetirementAuthority = Object.freeze({
    kind: 'DAEMON-CONTROL-RETIREMENT',
    operation: inspection.manifest.operation,
    disposition
  })
  daemonControlRetirementEpochs.set(authority, createDaemonControlMutationEpoch(captured.options, inspection))
  return authority
}

export function retireDaemonControlStage(
  authority: DaemonControlRetirementAuthority,
  checkpoint: DaemonProtocolCheckpoint = () => {}
): DaemonProtocolInspection {
  const epoch = daemonControlRetirementEpochs.get(authority)
  if (!epoch || authority.kind !== 'DAEMON-CONTROL-RETIREMENT'
    || authority.operation !== epoch.operation
    || authority.disposition !== 'dead' && authority.disposition !== 'pid-reused') {
    throw new Error('daemon retirement authority was not issued by this protocol instance or was changed')
  }
  settleDaemonControlMutationBarrier(epoch, 'review', checkpoint)
  settleDaemonControlMutationBarrier(epoch, 'reservation', checkpoint)
  const paths = epoch.inspection.paths
  removeDaemonControlMutationFile(epoch, paths.heartbeatProjection, 'daemon retirement heartbeat', checkpoint)
  removeDaemonControlMutationFile(epoch, paths.apiPidProjection, 'daemon retirement API PID', checkpoint)
  removeDaemonControlMutationFile(epoch, paths.pidProjection, 'daemon retirement PID', checkpoint)
  if (epoch.operation === 'stop') {
    removeDaemonControlMutationFile(epoch, paths.finalInstance, 'daemon retirement final instance', checkpoint)
  }
  const manifestPath = join(epoch.reservationDirectory.directory, 'stage-manifest-v1.json')
  removeDaemonControlMutationFile(epoch, manifestPath, 'daemon retirement stage manifest', checkpoint)
  removeDaemonControlReservation(epoch, checkpoint)
  assertDaemonControlMutationEpoch(epoch)
  const current = cloneDaemonProtocolInspection(inspectDaemonProtocol(epoch.options))
  assertDaemonControlMutationEpoch(epoch)
  if (current.kind !== 'ABSENT' || current.namespaceId !== epoch.inspection.namespaceId
    || canonicalDaemonJson(current.receipt) !== canonicalDaemonJson(epoch.inspection.receipt)) {
    throw new Error('daemon control retirement did not reach ABSENT')
  }
  assertDaemonInspectionCurrent(current)
  return current
}
