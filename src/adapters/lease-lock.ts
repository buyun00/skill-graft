import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  ApplicationTransactionErrorBase,
  type ApplicationTransactionIdentity
} from '../application/transaction-port.js'
import {
  HUB_GLOBAL_LOCK_KEY,
  LOCK_RECORD_SCHEMA_VERSION,
  WRITE_COMMAND_KINDS,
  type LockRecordV1,
  validateLockRecordV1
} from '../contracts/index.js'
import {
  authorizeLockOwner,
  evaluateLockReclaim,
  type LockOwnerProbeStatus
} from '../core/index.js'
import {
  DurableFileRoot,
  decodeUtf8Fatal,
  durableToken,
  flushDirectory,
  normalizeDurableRelative,
  sha256Identifier,
  type DurableCheckpoint
} from './durable-files.js'
import type { DurableLease, DurableTransactionLockPort } from './durable-state.js'

const execFileAsync = promisify(execFile)
const LOCKS_DIRECTORY = 'leases'
const OWNER_FILE = 'owner.json'
const OWNER_TOKEN_PATTERN = /^[A-Za-z0-9._-]{16,64}$/
const SAFE_PROCESS_IDENTITY = /^[A-Za-z0-9:._-]{1,512}$/
const SAFE_HOST_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/
const SAFE_REQUEST_ID = /^[A-Za-z0-9:._-]{1,512}$/
const SHA256_PATH_KEY = /^sha256:[a-f0-9]{64}$/
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/
const LOCK_RECORD_MAX_BYTES = 64 * 1024
const LOCK_DIRECTORY_MAX_ENTRIES = 32
const RETIRE_CLAIM_FORMAT = 'skill-graft.lease-retire-claim/v1' as const
const BACKGROUND_RELEASE_RETRY_DELAYS_MS = [25, 100, 250] as const
const WINDOWS_STAGING_RMDIR_RETRY_DELAYS_MS = [0, 5, 20, 50, 100] as const
const EXTERNAL_LEASE_NAMESPACE_PREFIX = '.skill-graft-application-locks-'
export const APPLICATION_LEASE_NAMESPACE_MARKER = '.skill-graft-application-lease-namespace.json'
const APPLICATION_LEASE_NAMESPACE_FORMAT = 'skill-graft.application-lease-namespace/v1' as const
const APPLICATION_LEASE_NAMESPACE_MAX_ENTRIES = 8
const APPLICATION_LEASE_NAMESPACE_TEMP = /^\.namespace-bootstrap-([A-Za-z0-9._-]{16,64})\.pending\.json$/

type ApplicationLeaseNamespaceMarker = {
  format: typeof APPLICATION_LEASE_NAMESPACE_FORMAT
  dataRootIdentity: `sha256:${string}`
  ownerToken: string
  pid: number
  processIdentity: string
  createdAt: string
  leaseUntil: string
}

type OwnerIdentity = Pick<LockRecordV1, 'ownerToken' | 'hostId' | 'pid' | 'processIdentity'>
type LeaseRevision = Pick<LockRecordV1, 'heartbeatAt' | 'leaseUntil'>
type FilesystemIdentity = Readonly<Pick<fs.Stats, 'dev' | 'ino'>>

type StagingRecordRead =
  | { status: 'gone' }
  | {
      status: 'transient'
      reason: 'empty-directory' | 'incomplete-owner-json' | 'growing-owner-file'
      directoryIdentity: FilesystemIdentity
    }
  | { status: 'complete'; record: LockRecordV1; directoryIdentity: FilesystemIdentity }

type RetireClaim = {
  format: typeof RETIRE_CLAIM_FORMAT
  scope: LockRecordV1['scope']
  lockKey: string
  ownerHash: `sha256:${string}`
  actorPid: number
  actorProcessIdentity: string
  createdAt: string
}

type CapturedRetireClaim = { claim: RetireClaim; capture: CapturedLeaseFile }

export interface LeaseProcessInspector {
  currentIdentity(pid: number): Promise<string>
  probe(pid: number, expectedIdentity: string): Promise<LockOwnerProbeStatus>
}

export type LeaseLockManagerOptions = {
  root: string
  leaseMs: number
  preflightRoot?: () => void
  now?: () => number
  token?: () => string
  pid?: number
  processInspector?: LeaseProcessInspector
  checkpoint?: DurableCheckpoint
  fault?: DurableCheckpoint
}

export type LeaseLockManager = DurableTransactionLockPort & {
  reapOrphanedWorktreeLeases(hubOwnerToken: string, revalidateHub?: () => Promise<void>): Promise<number>
}

function canonicalLeaseIdentity(target: string, platform: NodeJS.Platform | string): { path: string; key: string } {
  const absolute = path.resolve(target)
  if (path.dirname(absolute) === absolute) throw new Error('application lease identity cannot use a filesystem root')
  let ancestor = absolute
  while (lstatMaybe(ancestor) === null) {
    const parent = path.dirname(ancestor)
    if (parent === ancestor) break
    ancestor = parent
  }
  const ancestorStat = lstatMaybe(ancestor)
  if (!ancestorStat) throw new Error('application lease identity has no existing directory ancestor')
  // P4 mutating LocalHost/lifecycle paths support only plain local path
  // components. Do not follow a parent junction and then derive a second
  // namespace identity from its target: reject every existing component before
  // any external namespace or business-data write.
  let cursor = ancestor
  for (;;) {
    const stat = fs.lstatSync(cursor)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('application lease identity has a non-directory or reparse ancestor')
    }
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  const realAncestor = fs.realpathSync.native(ancestor)
  const ancestorAfter = fs.lstatSync(ancestor)
  if (ancestorAfter.dev !== ancestorStat.dev || ancestorAfter.ino !== ancestorStat.ino
    || ancestorAfter.size !== ancestorStat.size || ancestorAfter.mtimeMs !== ancestorStat.mtimeMs) {
    throw new Error('application lease identity ancestor changed during canonicalization')
  }
  const comparableReal = platform === 'win32' ? realAncestor.toLowerCase() : realAncestor
  const comparableLexical = platform === 'win32' ? path.resolve(ancestor).toLowerCase() : path.resolve(ancestor)
  if (comparableReal !== comparableLexical) {
    throw new Error('application lease identity crosses a reparse ancestor')
  }
  const canonicalPath = path.resolve(realAncestor, path.relative(ancestor, absolute))
  const key = platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath
  return { path: canonicalPath, key }
}

/**
 * The Application and lifecycle must lock outside the mutable data root so an
 * atomic purge rename cannot move or erase the live hub-global lease.
 */
export function applicationLeaseRoot(
  dataRoot: string,
  platform: NodeJS.Platform | string = process.platform
): string {
  const canonical = canonicalLeaseIdentity(dataRoot, platform)
  const digest = sha256Identifier(canonical.key).slice('sha256:'.length)
  return path.join(path.dirname(canonical.path), `${EXTERNAL_LEASE_NAMESPACE_PREFIX}${digest}`)
}

function externalNamespaceIdentity(root: string): `sha256:${string}` | null {
  const name = path.basename(path.resolve(root))
  const match = new RegExp(`^${EXTERNAL_LEASE_NAMESPACE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([a-f0-9]{64})$`).exec(name)
  return match ? `sha256:${match[1]}` : null
}

function validateNamespaceMarker(value: unknown, identity: `sha256:${string}`): ApplicationLeaseNamespaceMarker {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !exactKeys(value, ['format', 'dataRootIdentity', 'ownerToken', 'pid', 'processIdentity', 'createdAt', 'leaseUntil'])) {
    throw new Error('application lease namespace marker has an invalid schema')
  }
  const marker = value as ApplicationLeaseNamespaceMarker
  if (marker.format !== APPLICATION_LEASE_NAMESPACE_FORMAT
    || marker.dataRootIdentity !== identity
    || !OWNER_TOKEN_PATTERN.test(marker.ownerToken)
    || !Number.isSafeInteger(marker.pid) || marker.pid < 1
    || !SAFE_PROCESS_IDENTITY.test(marker.processIdentity)
    || !Number.isFinite(Date.parse(marker.createdAt))
    || !Number.isFinite(Date.parse(marker.leaseUntil))
    || Date.parse(marker.leaseUntil) <= Date.parse(marker.createdAt)) {
    throw new Error('application lease namespace marker is inconsistent')
  }
  return marker
}

function readNamespaceMarker(file: string, identity: `sha256:${string}`, allowLinked = false): {
  record: ApplicationLeaseNamespaceMarker
  bytes: Buffer
  stat: fs.Stats
} {
  let descriptor = -1
  let stat: fs.Stats
  let bytes: Buffer
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    stat = fs.fstatSync(descriptor)
    if (!stat.isFile() || stat.size < 1 || stat.size > LOCK_RECORD_MAX_BYTES
      || stat.nlink < 1 || stat.nlink > (allowLinked ? 2 : 1)) {
      throw new Error('application lease namespace marker is missing or unsafe')
    }
    const chunks: Buffer[] = []
    let total = 0
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(8192, LOCK_RECORD_MAX_BYTES + 1 - total))
      const read = fs.readSync(descriptor, chunk, 0, chunk.length, null)
      if (read === 0) break
      total += read
      if (total > LOCK_RECORD_MAX_BYTES) throw new Error('application lease namespace marker exceeds its bound')
      chunks.push(chunk.subarray(0, read))
    }
    bytes = Buffer.concat(chunks, total)
    const after = fs.fstatSync(descriptor)
    if (!after.isFile() || after.dev !== stat.dev || after.ino !== stat.ino
      || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.nlink !== stat.nlink) {
      throw new Error('application lease namespace marker changed while read')
    }
  } finally {
    if (descriptor >= 0) fs.closeSync(descriptor)
  }
  const record = validateNamespaceMarker(JSON.parse(decodeUtf8Fatal(bytes, 'application lease namespace marker')), identity)
  if (!bytes.equals(jsonBytes(record))) throw new Error('application lease namespace marker is not canonical')
  const after = fs.lstatSync(file)
  if (!after.isFile() || after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino
    || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.nlink !== stat.nlink) {
    throw new Error('application lease namespace marker changed while read')
  }
  return { record, bytes, stat: after }
}

function readBootstrapBytes(file: string, expected: fs.Stats): Buffer {
  let descriptor = -1
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    const before = fs.fstatSync(descriptor)
    if (!before.isFile() || before.dev !== expected.dev || before.ino !== expected.ino
      || before.size !== expected.size || before.mtimeMs !== expected.mtimeMs || before.nlink !== expected.nlink
      || before.size > LOCK_RECORD_MAX_BYTES) {
      throw new Error('namespace bootstrap changed while classifying')
    }
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset)
      if (count === 0) throw new Error('namespace bootstrap ended during classification')
      offset += count
    }
    const after = fs.fstatSync(descriptor)
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.nlink !== before.nlink) {
      throw new Error('namespace bootstrap changed while classifying')
    }
    return bytes
  } finally {
    if (descriptor >= 0) fs.closeSync(descriptor)
  }
}

type NamespaceBootstrapCandidate = {
  name: string
  file: string
  token: string
  bytes: Buffer
  stat: fs.Stats
  record: ApplicationLeaseNamespaceMarker | null
}

function readNamespaceBootstrapCandidate(
  root: string,
  name: string,
  identity: `sha256:${string}`
): NamespaceBootstrapCandidate {
  const match = APPLICATION_LEASE_NAMESPACE_TEMP.exec(name)
  if (!match) throw new Error('namespace bootstrap candidate name is invalid')
  const file = path.join(root, name)
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink < 1 || stat.nlink > 2
    || stat.size > LOCK_RECORD_MAX_BYTES) {
    throw new Error('namespace bootstrap candidate is unsafe')
  }
  const bytes = readBootstrapBytes(file, stat)
  const raw = parseLeaseJsonOrPartial(bytes, 'namespace bootstrap candidate')
  let record: ApplicationLeaseNamespaceMarker | null = null
  if (raw !== null) {
    record = validateNamespaceMarker(raw, identity)
    if (!bytes.equals(jsonBytes(record))) throw new Error('namespace bootstrap candidate is not canonical')
    if (record.ownerToken !== match[1]) throw new Error('namespace bootstrap filename does not match its owner')
  }
  return { name, file, token: match[1], bytes, stat, record }
}

function captureNamespaceBootstrapInventory(
  root: string,
  identity: `sha256:${string}`
): NamespaceBootstrapCandidate[] {
  return listNamespace(root)
    .filter((entry) => APPLICATION_LEASE_NAMESPACE_TEMP.test(entry.name))
    .map((entry) => readNamespaceBootstrapCandidate(root, entry.name, identity))
    .sort((left, right) => left.name.localeCompare(right.name))
}

function sameNamespaceBootstrapCandidate(
  left: NamespaceBootstrapCandidate,
  right: NamespaceBootstrapCandidate
): boolean {
  return left.name === right.name && left.token === right.token
    && left.stat.dev === right.stat.dev && left.stat.ino === right.stat.ino
    && left.stat.nlink === right.stat.nlink && left.stat.size === right.stat.size
    && left.stat.mtimeMs === right.stat.mtimeMs && left.bytes.equals(right.bytes)
    && (left.record === null) === (right.record === null)
}

function assertNamespaceBootstrapInventory(
  root: string,
  identity: `sha256:${string}`,
  expected: readonly NamespaceBootstrapCandidate[]
): void {
  const current = captureNamespaceBootstrapInventory(root, identity)
  if (current.length !== expected.length
    || current.some((entry, index) => !sameNamespaceBootstrapCandidate(entry, expected[index]))) {
    throw new Error('namespace bootstrap inventory changed during authorization')
  }
}

function listNamespace(root: string, limit = APPLICATION_LEASE_NAMESPACE_MAX_ENTRIES): fs.Dirent[] {
  const directory = fs.opendirSync(root)
  const entries: fs.Dirent[] = []
  try {
    for (;;) {
      const entry = directory.readSync()
      if (!entry) break
      entries.push(entry)
      if (entries.length > limit) throw new Error('application lease namespace inventory exceeds its limit')
    }
  } finally {
    directory.closeSync()
  }
  return entries
}

const LIVE_LEASE_NAME = /^(hub-global|worktree-([a-f0-9]{64}))\.lock$/
const ACQUIRE_LEASE_NAME = /^\.acquire-((?:hub-global|worktree-[a-f0-9]{64})\.lock)-([A-Za-z0-9._-]{16,64})\.tmp$/
const RETIRE_CLAIM_NAME = /^\.retire-((?:hub-global|worktree-[a-f0-9]{64})\.lock)-([a-f0-9]{64})\.claim\.json$/
const RETIRED_LEASE_NAME = /^\.retired-((?:hub-global|worktree-[a-f0-9]{64})\.lock)-([a-f0-9]{64})\.tmp$/
const RETIRE_CLAIM_TEMP_NAME = /^\.retire-claim-[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.tmp$/
const RENEW_TEMP_NAME = /^\.owner\.skill-graft-renew-[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.tmp$/

function leaseIdentityFromName(name: string): { scope: LockRecordV1['scope']; lockKey: string } {
  const match = LIVE_LEASE_NAME.exec(name)
  if (!match) throw new Error('lease artifact name is invalid')
  return match[1] === 'hub-global'
    ? { scope: 'hub-global', lockKey: HUB_GLOBAL_LOCK_KEY }
    : { scope: 'worktree', lockKey: `sha256:${match[2]}` }
}

function readPlainLeaseBytes(file: string, label: string, allowEmpty = false): Buffer {
  let descriptor = -1
  try {
    const pathBefore = fs.lstatSync(file)
    if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || pathBefore.nlink !== 1
      || pathBefore.size > LOCK_RECORD_MAX_BYTES || !allowEmpty && pathBefore.size < 1) {
      throw new Error(`${label} is unsafe`)
    }
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    const before = fs.fstatSync(descriptor)
    if (!before.isFile() || before.nlink !== 1 || before.size > LOCK_RECORD_MAX_BYTES
      || !allowEmpty && before.size < 1 || before.dev !== pathBefore.dev || before.ino !== pathBefore.ino
      || before.size !== pathBefore.size || before.mtimeMs !== pathBefore.mtimeMs) {
      throw new Error(`${label} is unsafe`)
    }
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const read = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset)
      if (read === 0) throw new Error(`${label} ended while read`)
      offset += read
    }
    const after = fs.fstatSync(descriptor)
    const pathAfter = fs.lstatSync(file)
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.nlink !== before.nlink
      || !pathAfter.isFile() || pathAfter.isSymbolicLink() || pathAfter.dev !== before.dev
      || pathAfter.ino !== before.ino || pathAfter.size !== before.size
      || pathAfter.mtimeMs !== before.mtimeMs || pathAfter.nlink !== before.nlink) {
      throw new Error(`${label} changed while read`)
    }
    return bytes
  } finally {
    if (descriptor >= 0) fs.closeSync(descriptor)
  }
}

type CapturedLeaseFile = { bytes: Buffer; stat: fs.Stats }
type CapturedLeaseDirectory = { stat: fs.Stats }
type LeaseExactProof = {
  directory: CapturedLeaseDirectory
  owner: CapturedLeaseFile
  record: LockRecordV1
}
type LeaseReleaseProof = LeaseExactProof | readonly LeaseExactProof[]

function capturePlainLeaseFile(file: string, label: string, allowEmpty = false): CapturedLeaseFile {
  const bytes = readPlainLeaseBytes(file, label, allowEmpty)
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== bytes.length) {
    throw new Error(`${label} changed after readback`)
  }
  return { bytes, stat }
}

function captureLinkedLeaseFile(file: string, label: string): CapturedLeaseFile {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 2
    || stat.size < 1 || stat.size > LOCK_RECORD_MAX_BYTES) throw new Error(`${label} is unsafe`)
  const bytes = readBootstrapBytes(file, stat)
  const after = fs.lstatSync(file)
  if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 2
    || after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size
    || after.mtimeMs !== stat.mtimeMs) throw new Error(`${label} changed while read`)
  return { bytes, stat: after }
}

function unlinkCapturedLeaseFile(file: string, expected: CapturedLeaseFile, label: string): void {
  const current = capturePlainLeaseFile(file, label, expected.bytes.length === 0)
  if (current.stat.dev !== expected.stat.dev || current.stat.ino !== expected.stat.ino
    || current.stat.size !== expected.stat.size || current.stat.mtimeMs !== expected.stat.mtimeMs
    || current.stat.nlink !== expected.stat.nlink || !current.bytes.equals(expected.bytes)) {
    throw new Error(`${label} changed before cleanup`)
  }
  fs.unlinkSync(file)
}

function assertCapturedLeaseFile(file: string, expected: CapturedLeaseFile, label: string): void {
  const current = expected.stat.nlink === 2
    ? captureLinkedLeaseFile(file, label)
    : capturePlainLeaseFile(file, label, expected.bytes.length === 0)
  if (current.stat.dev !== expected.stat.dev || current.stat.ino !== expected.stat.ino
    || current.stat.size !== expected.stat.size || current.stat.mtimeMs !== expected.stat.mtimeMs
    || current.stat.nlink !== expected.stat.nlink || !current.bytes.equals(expected.bytes)) {
    throw new Error(`${label} changed after it was authorized`)
  }
}

function capturePlainLeaseDirectory(directory: string, label: string): CapturedLeaseDirectory {
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} is unsafe`)
  return { stat }
}

function assertCapturedLeaseDirectory(
  directory: string,
  expected: CapturedLeaseDirectory,
  label: string
): void {
  const current = fs.lstatSync(directory)
  if (!current.isDirectory() || current.isSymbolicLink()
    || current.dev !== expected.stat.dev || current.ino !== expected.stat.ino) {
    throw new Error(`${label} changed after it was authorized`)
  }
}

function parseLeaseJsonOrPartial(bytes: Buffer, label: string): unknown | null {
  if (bytes.length === 0) return null
  const text = decodeUtf8Fatal(bytes, label)
  try {
    return JSON.parse(text)
  } catch (error) {
    if (error instanceof SyntaxError && (/Unexpected end|unterminated|end of data/i.test(error.message)
      || /position (\d+)/i.exec(error.message)?.[1] === String(text.length))) return null
    throw new Error(`${label} is malformed`)
  }
}

function sameLeaseAuthority(left: LockRecordV1, right: LockRecordV1): boolean {
  return left.schemaVersion === right.schemaVersion && left.scope === right.scope
    && left.lockKey === right.lockKey && left.ownerToken === right.ownerToken
    && left.hostId === right.hostId && left.pid === right.pid
    && left.processIdentity === right.processIdentity && left.command === right.command
    && left.requestId === right.requestId && left.acquiredAt === right.acquiredAt
}

/** A pure, mutation-free validation of every byte below the leases container. */
function assertLeaseContainerInventorySafe(container: string): void {
  const entries = listNamespace(container, 10_000)
  const claims = new Map<string, RetireClaim>()
  const linkedClaimTemps = new Map<string, string>()
  const readOwner = (file: string, label: string, allowPartial = false): LockRecordV1 | null => {
    const bytes = readPlainLeaseBytes(file, label, allowPartial)
    const raw = parseLeaseJsonOrPartial(bytes, label)
    if (raw === null) {
      if (allowPartial) return null
      throw new Error(`${label} is incomplete`)
    }
    const record = validationReason(raw)
    if (!bytes.equals(jsonBytes(record))) throw new Error(`${label} is not canonical`)
    return record
  }
  for (const entry of entries) {
    const claimMatch = RETIRE_CLAIM_NAME.exec(entry.name)
    if (!claimMatch) continue
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('lease retirement claim is unsafe')
    const claimFile = path.join(container, entry.name)
    const claimStat = fs.lstatSync(claimFile)
    let bytes: Buffer
    if (claimStat.nlink === 1) {
      bytes = readPlainLeaseBytes(claimFile, 'lease retirement claim')
    } else if (claimStat.nlink === 2) {
      const linked = entries.filter((candidate) => RETIRE_CLAIM_TEMP_NAME.test(candidate.name)).filter((candidate) => {
        const stat = fs.lstatSync(path.join(container, candidate.name))
        return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 2
          && stat.dev === claimStat.dev && stat.ino === claimStat.ino
      })
      if (linked.length !== 1) throw new Error('lease retirement claim has an unowned additional hard link')
      const claimCapture = captureLinkedLeaseFile(claimFile, 'lease retirement claim')
      const tempCapture = captureLinkedLeaseFile(path.join(container, linked[0].name), 'retirement claim temporary')
      if (claimCapture.stat.dev !== tempCapture.stat.dev || claimCapture.stat.ino !== tempCapture.stat.ino
        || !claimCapture.bytes.equals(tempCapture.bytes)) {
        throw new Error('lease retirement claim hard-link pair is inconsistent')
      }
      bytes = claimCapture.bytes
      linkedClaimTemps.set(linked[0].name, entry.name)
    } else {
      throw new Error('lease retirement claim is unsafe')
    }
    const claim = validateRetireClaim(JSON.parse(decodeUtf8Fatal(bytes, 'lease retirement claim')))
    if (!bytes.equals(jsonBytes(claim))) throw new Error('lease retirement claim is not canonical')
    const identity = leaseIdentityFromName(claimMatch[1])
    if (claim.scope !== identity.scope || claim.lockKey !== identity.lockKey
      || claim.ownerHash !== `sha256:${claimMatch[2]}`) {
      throw new Error('lease retirement claim name does not match its authority')
    }
    claims.set(entry.name, claim)
  }
  for (const entry of entries) {
    const absolute = path.join(container, entry.name)
    const liveMatch = LIVE_LEASE_NAME.exec(entry.name)
    const acquireMatch = ACQUIRE_LEASE_NAME.exec(entry.name)
    const claimMatch = RETIRE_CLAIM_NAME.exec(entry.name)
    const retiredMatch = RETIRED_LEASE_NAME.exec(entry.name)
    if (liveMatch) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('live lease is not a plain directory')
      const identity = leaseIdentityFromName(entry.name)
      const children = listNamespace(absolute, LOCK_DIRECTORY_MAX_ENTRIES)
      if (!children.some((child) => child.name === OWNER_FILE)) throw new Error('live lease owner is missing')
      const owner = readOwner(path.join(absolute, OWNER_FILE), 'live lease owner')!
      if (owner.scope !== identity.scope || owner.lockKey !== identity.lockKey) throw new Error('live lease owner is misbound')
      for (const child of children) {
        if (child.name === OWNER_FILE) {
          if (!child.isFile() || child.isSymbolicLink()) throw new Error('live lease owner is unsafe')
          continue
        }
        if (!RENEW_TEMP_NAME.test(child.name) || !child.isFile() || child.isSymbolicLink()) {
          throw new Error('live lease contains an unexpected artifact')
        }
        const renew = readOwner(path.join(absolute, child.name), 'lease renewal temporary', true)
        if (renew && (!sameLeaseAuthority(owner, renew) || renew.scope !== identity.scope || renew.lockKey !== identity.lockKey)) {
          throw new Error('lease renewal temporary is not bound to its live owner')
        }
      }
      continue
    }
    if (acquireMatch) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('lease acquisition staging is unsafe')
      const identity = leaseIdentityFromName(acquireMatch[1])
      const directoryBefore = fs.lstatSync(absolute)
      if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()) {
        throw new Error('lease acquisition staging is unsafe')
      }
      const children = listNamespace(absolute, LOCK_DIRECTORY_MAX_ENTRIES)
      if (children.length === 0) continue
      if (children.length !== 1 || children[0].name !== OWNER_FILE
        || !children[0].isFile() || children[0].isSymbolicLink()) {
        throw new Error('lease acquisition staging contains an unexpected artifact')
      }
      let owner: LockRecordV1 | null
      try {
        owner = readOwner(path.join(absolute, OWNER_FILE), 'lease acquisition owner', true)
      } catch (error) {
        const directoryAfter = lstatMaybe(absolute)
        if (!directoryAfter) continue
        if (directoryAfter.isDirectory() && !directoryAfter.isSymbolicLink()
          && sameFilesystemIdentity(directoryBefore, directoryAfter)) {
          try {
            if (listNamespace(absolute, LOCK_DIRECTORY_MAX_ENTRIES).length === 0) continue
          } catch {
            if (!lstatMaybe(absolute)) continue
          }
        }
        throw error
      }
      const directoryAfter = lstatMaybe(absolute)
      if (!directoryAfter) continue
      if (!directoryAfter.isDirectory() || directoryAfter.isSymbolicLink()
        || !sameFilesystemIdentity(directoryBefore, directoryAfter)) {
        throw new Error('lease acquisition staging changed during validation')
      }
      if (owner && (owner.scope !== identity.scope || owner.lockKey !== identity.lockKey
        || owner.ownerToken !== acquireMatch[2])) throw new Error('lease acquisition staging is misbound')
      continue
    }
    if (claimMatch) continue
    if (retiredMatch) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('retired lease is unsafe')
      const claimName = `.retire-${retiredMatch[1]}-${retiredMatch[2]}.claim.json`
      const claim = claims.get(claimName)
      if (!claim) throw new Error('retired lease is missing its fencing claim')
      const children = listNamespace(absolute, LOCK_DIRECTORY_MAX_ENTRIES)
      const ownerEntry = children.find((child) => child.name === OWNER_FILE)
      if (!ownerEntry && children.length !== 0) throw new Error('ownerless retired lease contains artifacts')
      if (ownerEntry) {
        if (!ownerEntry.isFile() || ownerEntry.isSymbolicLink()) throw new Error('retired lease owner is unsafe')
        const owner = readOwner(path.join(absolute, OWNER_FILE), 'retired lease owner')!
        if (owner.scope !== claim.scope || owner.lockKey !== claim.lockKey
          || ownerHashValue(owner.ownerToken) !== claim.ownerHash) throw new Error('retired lease owner is misbound')
        for (const child of children) {
          if (child.name === OWNER_FILE) continue
          if (!RENEW_TEMP_NAME.test(child.name) || !child.isFile() || child.isSymbolicLink()) {
            throw new Error('retired lease contains an unexpected artifact')
          }
          const renew = readOwner(path.join(absolute, child.name), 'retired lease renewal temporary', true)
          if (renew && !sameLeaseAuthority(owner, renew)) throw new Error('retired renewal temporary is misbound')
        }
      }
      continue
    }
    if (RETIRE_CLAIM_TEMP_NAME.test(entry.name)) {
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('retirement claim temporary is unsafe')
      if (linkedClaimTemps.has(entry.name)) continue
      const bytes = readPlainLeaseBytes(absolute, 'retirement claim temporary', true)
      const raw = parseLeaseJsonOrPartial(bytes, 'retirement claim temporary')
      if (raw !== null) validateRetireClaim(raw)
      continue
    }
    throw new Error(`unexpected lease artifact: ${entry.name}`)
  }
}

function ownerHashValue(ownerToken: string): `sha256:${string}` {
  return sha256Identifier(ownerToken)
}

/**
 * Read-only authority check shared by Local composition, lifecycle, and the
 * lease manager itself. An existing namespace may contain only its standard
 * `leases` container; every other top-level byte is foreign evidence.
 */
export function assertApplicationLeaseNamespaceSafe(root: string, validateLeaseContents = true): void {
  const absolute = path.resolve(root)
  let cursor = absolute
  let cursorStat = lstatMaybe(cursor)
  while (cursorStat === null) {
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
    cursorStat = lstatMaybe(cursor)
  }
  if (cursorStat) {
    if (!cursorStat.isDirectory() || cursorStat.isSymbolicLink()) {
      throw new Error('application lease namespace has a non-directory or reparse ancestor')
    }
    const canonicalAncestor = fs.realpathSync.native(cursor)
    const ancestorMatches = process.platform === 'win32'
      ? canonicalAncestor.toLowerCase() === path.resolve(cursor).toLowerCase()
      : canonicalAncestor === path.resolve(cursor)
    if (!ancestorMatches) throw new Error('application lease namespace has a reparse ancestor')
  }
  const rootStat = lstatMaybe(absolute)
  if (!rootStat) return
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('application lease namespace is not a plain directory')
  }
  const canonical = fs.realpathSync.native(absolute)
  const same = process.platform === 'win32'
    ? canonical.toLowerCase() === absolute.toLowerCase()
    : canonical === absolute
  if (!same) throw new Error('application lease namespace crosses a reparse point')
  const identity = externalNamespaceIdentity(absolute)
  const entries = listNamespace(absolute)
  for (const entry of entries) {
    const bootstrap = identity && APPLICATION_LEASE_NAMESPACE_TEMP.test(entry.name)
    if (entry.name !== LOCKS_DIRECTORY && entry.name !== APPLICATION_LEASE_NAMESPACE_MARKER && !bootstrap) {
      throw new Error('application lease namespace contains a foreign top-level artifact')
    }
    if (entry.name === LOCKS_DIRECTORY) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error('application lease container is not a plain directory')
      }
      const leases = path.join(absolute, LOCKS_DIRECTORY)
      const leasesStat = fs.lstatSync(leases)
      if (!leasesStat.isDirectory() || leasesStat.isSymbolicLink()) {
        throw new Error('application lease container is not a plain directory')
      }
      if (validateLeaseContents) {
        let validated = false
        let lastRace: unknown
        for (let attempt = 0; attempt < 3 && !validated; attempt += 1) {
          try {
            assertLeaseContainerInventorySafe(leases)
            validated = true
          } catch (error) {
            lastRace = error
          }
        }
        if (!validated) throw lastRace
      }
    } else if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error('application lease namespace marker is not a plain file')
    } else {
      const stat = fs.lstatSync(path.join(absolute, entry.name))
      if (stat.nlink < 1 || stat.nlink > 2 || stat.size > LOCK_RECORD_MAX_BYTES) {
        throw new Error('application lease namespace marker or bootstrap file is unsafe')
      }
    }
  }
  if (identity) {
    const marker = entries.find((entry) => entry.name === APPLICATION_LEASE_NAMESPACE_MARKER)
    const leases = entries.find((entry) => entry.name === LOCKS_DIRECTORY)
    const pendingInventory = captureNamespaceBootstrapInventory(absolute, identity)
    if (!marker && leases) {
      throw new Error('unmarked application lease namespace cannot contain a lease container')
    }
    if (marker) {
      const markerRead = readNamespaceMarker(path.join(absolute, marker.name), identity, true)
      if (markerRead.stat.nlink === 2) {
        const linked = entries.filter((entry) => APPLICATION_LEASE_NAMESPACE_TEMP.test(entry.name)).filter((entry) => {
          const stat = fs.lstatSync(path.join(absolute, entry.name))
          return stat.dev === markerRead.stat.dev && stat.ino === markerRead.stat.ino
        })
        if (linked.length !== 1
          || APPLICATION_LEASE_NAMESPACE_TEMP.exec(linked[0].name)?.[1] !== markerRead.record.ownerToken) {
          throw new Error('application lease namespace marker has an unowned additional hard link')
        }
      }
      for (const pending of pendingInventory) {
        if (pending.stat.nlink === 2
          && (markerRead.stat.nlink !== 2 || pending.stat.dev !== markerRead.stat.dev || pending.stat.ino !== markerRead.stat.ino
            || pending.token !== markerRead.record.ownerToken || !pending.record)) {
          throw new Error('application lease bootstrap has an unowned additional hard link')
        }
      }
    } else {
      for (const pending of pendingInventory) {
        if (pending.stat.nlink !== 1) {
          throw new Error('unpublished application lease bootstrap has an unsafe hard link')
        }
      }
    }
  }
}

function unlinkExactFile(file: string, expected: fs.Stats): boolean {
  try {
    const current = fs.lstatSync(file)
    if (!current.isFile() || current.isSymbolicLink()
      || current.dev !== expected.dev || current.ino !== expected.ino
      || current.size !== expected.size || current.mtimeMs !== expected.mtimeMs
      || current.nlink !== expected.nlink) return false
    fs.unlinkSync(file)
    return true
  } catch {
    return false
  }
}

function cleanupPublishedNamespaceTemps(root: string): void {
  const absolute = path.resolve(root)
  const identity = externalNamespaceIdentity(absolute)
  if (!identity) return
  assertApplicationLeaseNamespaceSafe(absolute)
  const markerFile = path.join(absolute, APPLICATION_LEASE_NAMESPACE_MARKER)
  const marker = readNamespaceMarker(markerFile, identity, true)
  const candidates: Array<{ file: string; stat: fs.Stats }> = []
  for (const pending of captureNamespaceBootstrapInventory(absolute, identity)) {
    if (pending.stat.nlink === 2
      && (marker.stat.nlink !== 2 || pending.stat.dev !== marker.stat.dev || pending.stat.ino !== marker.stat.ino
        || pending.token !== marker.record.ownerToken || !pending.record)) {
      throw new Error('published namespace bootstrap artifact has an unowned hard link')
    }
    // A unique pending can belong to a concurrent live bootstrapper. Only the
    // exact hard-link pair is unambiguously owned by the published marker here;
    // dead/aged unique residues are classified by bootstrap under an inspector.
    if (pending.stat.nlink === 2) candidates.push({ file: pending.file, stat: pending.stat })
  }
  for (const candidate of candidates) {
    if (!unlinkExactFile(candidate.file, candidate.stat)) {
      throw new Error('published namespace bootstrap artifact changed before cleanup')
    }
  }
  if (candidates.length > 0) flushDirectory(absolute)
  if (readNamespaceMarker(markerFile, identity).stat.nlink !== 1) {
    throw new Error('published namespace marker retains an unexpected hard link')
  }
}

async function bootstrapApplicationLeaseNamespace(
  root: string,
  ownerToken: string,
  pid: number,
  processIdentity: string,
  leaseMs: number,
  now: () => number,
  inspector: LeaseProcessInspector,
  fault: DurableCheckpoint,
  preflightRoot: () => void
): Promise<void> {
  const absolute = path.resolve(root)
  const dataRootIdentity = externalNamespaceIdentity(absolute)
  if (!dataRootIdentity) return
  let rootIdentity: fs.Stats
  let ownedPending: { file: string; stat: fs.Stats } | null = null
  const parent = path.dirname(absolute)
  preflightRoot()
  try {
    fs.mkdirSync(absolute)
    flushDirectory(parent)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  rootIdentity = fs.lstatSync(absolute)
  if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink()) {
    throw new Error('application lease namespace is not a plain directory')
  }
  const finalMarker = path.join(absolute, APPLICATION_LEASE_NAMESPACE_MARKER)
  const assertRootAndInventory = () => {
    preflightRoot()
    const current = fs.lstatSync(absolute)
    if (!current.isDirectory() || current.isSymbolicLink()
      || current.dev !== rootIdentity.dev || current.ino !== rootIdentity.ino) {
      throw new Error('application lease namespace root changed during bootstrap')
    }
    assertApplicationLeaseNamespaceSafe(absolute)
  }
  try {
  fault('lease-namespace-after-root-reservation', {})
  assertRootAndInventory()
  const publishedBeforeSweep = lstatMaybe(finalMarker)
    ? readNamespaceMarker(finalMarker, dataRootIdentity, true)
    : null

  const cleanup: Array<{ file: string; stat: fs.Stats }> = []
  const observedBootstrapInventory = captureNamespaceBootstrapInventory(absolute, dataRootIdentity)
  for (const pending of observedBootstrapInventory) {
    if (publishedBeforeSweep) {
      if (pending.stat.nlink === 2
        && (publishedBeforeSweep.stat.nlink !== 2 || pending.stat.dev !== publishedBeforeSweep.stat.dev
          || pending.stat.ino !== publishedBeforeSweep.stat.ino
          || pending.token !== publishedBeforeSweep.record.ownerToken || !pending.record)) {
        throw new Error('published namespace bootstrap artifact has an unowned hard link')
      }
      if (pending.stat.nlink === 2) {
        cleanup.push({ file: pending.file, stat: pending.stat })
        continue
      }
      if (!pending.record) {
        if (now() - pending.stat.mtimeMs >= leaseMs) cleanup.push({ file: pending.file, stat: pending.stat })
        // A recent partial can belong to a live losing bootstrapper. The final
        // marker is already shared truth, so preserve it rather than deleting
        // an inode whose process ownership cannot yet be proven.
        continue
      }
      if (now() >= Date.parse(pending.record.leaseUntil)) {
        const status = await inspector.probe(pending.record.pid, pending.record.processIdentity)
        assertRootAndInventory()
        assertNamespaceBootstrapInventory(absolute, dataRootIdentity, observedBootstrapInventory)
        if (status === 'dead' || status === 'pid-reused') {
          cleanup.push({ file: pending.file, stat: pending.stat })
        }
      }
      continue
    }
    if (!pending.record) {
      if (now() - pending.stat.mtimeMs >= leaseMs) {
        cleanup.push({ file: pending.file, stat: pending.stat })
        continue
      }
      throw new Error('application lease namespace has a live or recent incomplete bootstrap')
    }
    if (pending.record.ownerToken === ownerToken) continue
    const expired = now() >= Date.parse(pending.record.leaseUntil)
    const status = expired
      ? await inspector.probe(pending.record.pid, pending.record.processIdentity)
      : 'alive'
    assertRootAndInventory()
    assertNamespaceBootstrapInventory(absolute, dataRootIdentity, observedBootstrapInventory)
    if (expired && (status === 'dead' || status === 'pid-reused')) {
      cleanup.push({ file: pending.file, stat: pending.stat })
      continue
    }
    throw new Error('application lease namespace bootstrap is owned by another live or unverifiable process')
  }
  // Every candidate was classified without mutation. Repeat the complete
  // namespace check after the last process probe so a concurrently injected
  // foreign top-level/lease artifact prevents all cleanup.
  assertRootAndInventory()
  assertNamespaceBootstrapInventory(absolute, dataRootIdentity, observedBootstrapInventory)
  for (const candidate of cleanup) {
    if (!unlinkExactFile(candidate.file, candidate.stat)) {
      throw new Error('namespace bootstrap artifact changed before cleanup')
    }
  }
  if (cleanup.length > 0) flushDirectory(absolute)

  if (!lstatMaybe(finalMarker)) {
    const createdAtMs = now()
    const createdAt = new Date(createdAtMs).toISOString()
    const record: ApplicationLeaseNamespaceMarker = {
      format: APPLICATION_LEASE_NAMESPACE_FORMAT,
      dataRootIdentity,
      ownerToken,
      pid,
      processIdentity,
      createdAt,
      leaseUntil: new Date(createdAtMs + leaseMs).toISOString()
    }
    const pending = path.join(absolute, `.namespace-bootstrap-${ownerToken}.pending.json`)
    let descriptor = -1
    try {
      // now() is injectable and can yield control to a root swap. Rebind the
      // data-root callback and exact namespace inventory before the first
      // bootstrap file mutation.
      assertRootAndInventory()
      descriptor = fs.openSync(pending, 'wx')
      ownedPending = { file: pending, stat: fs.fstatSync(descriptor) }
      const bytes = jsonBytes(record)
      try {
        fs.writeFileSync(descriptor, bytes)
        fs.fsyncSync(descriptor)
      } catch (error) {
        ownedPending = { file: pending, stat: fs.fstatSync(descriptor) }
        throw error
      }
      fs.closeSync(descriptor)
      descriptor = -1
      const pendingRead = readNamespaceMarker(pending, dataRootIdentity)
      ownedPending = { file: pending, stat: pendingRead.stat }
      fault('lease-namespace-after-marker-write', {})
      assertRootAndInventory()
      const pendingBeforePublish = readNamespaceMarker(pending, dataRootIdentity)
      if (pendingBeforePublish.stat.dev !== pendingRead.stat.dev || pendingBeforePublish.stat.ino !== pendingRead.stat.ino
        || pendingBeforePublish.stat.size !== pendingRead.stat.size
        || pendingBeforePublish.stat.mtimeMs !== pendingRead.stat.mtimeMs
        || !pendingBeforePublish.bytes.equals(pendingRead.bytes)) {
        throw new Error('namespace bootstrap pending changed before publication')
      }
      const publicationInventory = captureNamespaceBootstrapInventory(absolute, dataRootIdentity)
      const markerBeforePublish = lstatMaybe(finalMarker)
        ? readNamespaceMarker(finalMarker, dataRootIdentity, true)
        : null
      for (const candidate of publicationInventory) {
        if (!candidate.record) {
          throw new Error('namespace bootstrap publication is blocked by an incomplete pending writer')
        }
        if (candidate.stat.nlink === 2
          && (!markerBeforePublish || markerBeforePublish.stat.nlink !== 2
            || candidate.stat.dev !== markerBeforePublish.stat.dev || candidate.stat.ino !== markerBeforePublish.stat.ino
            || candidate.token !== markerBeforePublish.record.ownerToken)) {
          throw new Error('namespace bootstrap publication found an unowned linked pending')
        }
      }
      const ownedBeforePublish = publicationInventory.find((candidate) => candidate.name === path.basename(pending))
      if (!ownedBeforePublish || ownedBeforePublish.stat.nlink !== 1
        || ownedBeforePublish.stat.dev !== pendingRead.stat.dev || ownedBeforePublish.stat.ino !== pendingRead.stat.ino
        || !ownedBeforePublish.bytes.equals(pendingRead.bytes)) {
        throw new Error('namespace bootstrap owned pending changed before publication')
      }
      let linkedByOwner = false
      try {
        fs.linkSync(pending, finalMarker)
        linkedByOwner = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        readNamespaceMarker(finalMarker, dataRootIdentity, true)
      }
      flushDirectory(absolute)
      fault('lease-namespace-after-marker-publication', {})
      assertRootAndInventory()
      const pendingAfterLink = fs.lstatSync(pending)
      if (linkedByOwner) {
        const currentFinal = readNamespaceMarker(finalMarker, dataRootIdentity, true)
        if (currentFinal.stat.nlink !== 2 || pendingAfterLink.nlink !== 2
          || currentFinal.stat.dev !== pendingAfterLink.dev || currentFinal.stat.ino !== pendingAfterLink.ino
          || currentFinal.record.ownerToken !== ownerToken
          || pendingAfterLink.dev !== pendingRead.stat.dev || pendingAfterLink.ino !== pendingRead.stat.ino
          || !currentFinal.bytes.equals(pendingRead.bytes)) {
          throw new Error('namespace bootstrap publication did not preserve the exact hard-link authority')
        }
      } else {
        const losingPending = readNamespaceMarker(pending, dataRootIdentity)
        if (pendingAfterLink.nlink !== 1 || losingPending.stat.dev !== pendingRead.stat.dev
          || losingPending.stat.ino !== pendingRead.stat.ino || !losingPending.bytes.equals(pendingRead.bytes)) {
          throw new Error('losing namespace bootstrap pending file changed before cleanup')
        }
      }
      if (!unlinkExactFile(pending, pendingAfterLink)) {
        throw new Error('namespace bootstrap pending file changed after marker publication')
      }
      ownedPending = null
      flushDirectory(absolute)
    } finally {
      if (descriptor >= 0) fs.closeSync(descriptor)
    }
  }

  readNamespaceMarker(finalMarker, dataRootIdentity, true)
  assertRootAndInventory()
  const leases = path.join(absolute, LOCKS_DIRECTORY)
  try {
    fs.mkdirSync(leases)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const leasesStat = fs.lstatSync(leases)
  if (!leasesStat.isDirectory() || leasesStat.isSymbolicLink()) throw new Error('application lease container is unsafe')
  const leasesDirectory = { stat: leasesStat } as CapturedLeaseDirectory
  fault('lease-namespace-after-container-create', {})
  assertRootAndInventory()
  assertCapturedLeaseDirectory(leases, leasesDirectory, 'application lease container')
  flushDirectory(absolute)
  const finalRoot = fs.lstatSync(absolute)
  if (finalRoot.dev !== rootIdentity.dev || finalRoot.ino !== rootIdentity.ino) {
    throw new Error('application lease namespace changed during bootstrap')
  }
  assertRootAndInventory()
  assertCapturedLeaseDirectory(leases, leasesDirectory, 'application lease container')
  } catch (error) {
    let rollbackRefused = false
    try { assertRootAndInventory() } catch { rollbackRefused = true }
    if (!rollbackRefused && ownedPending && !unlinkExactFile(ownedPending.file, ownedPending.stat)) rollbackRefused = true
    try { flushDirectory(absolute) } catch { rollbackRefused = true }
    if (rollbackRefused) {
      throw new Error(`application lease namespace bootstrap failed and exact pending cleanup was refused: ${error instanceof Error ? error.message : String(error)}`)
    }
    throw error
  }
}

/** Existing pre-P4 in-root lock directories are compatible only when empty. */
export function assertLegacyApplicationLeaseNamespaceClear(dataRoot: string): void {
  const resolvedDataRoot = path.resolve(dataRoot)
  const legacy = path.join(resolvedDataRoot, 'skill-review', 'locks')
  if (lstatMaybe(legacy) === null) return
  const dataRootStat = lstatMaybe(resolvedDataRoot)
  if (!dataRootStat?.isDirectory() || dataRootStat.isSymbolicLink()) {
    throw new Error('legacy application lease data root is not a plain directory')
  }
  const canonicalDataRoot = fs.realpathSync.native(resolvedDataRoot)
  let cursor = legacy
  for (;;) {
    const stat = fs.lstatSync(cursor)
    const canonical = fs.realpathSync.native(cursor)
    const expectedCanonical = path.resolve(
      canonicalDataRoot,
      path.relative(resolvedDataRoot, cursor)
    )
    const exact = process.platform === 'win32'
      ? canonical.toLowerCase() === expectedCanonical.toLowerCase()
      : canonical === expectedCanonical
    if (!stat.isDirectory() || stat.isSymbolicLink() || !exact) {
      throw new Error('legacy application lease namespace crosses a reparse or non-directory component')
    }
    if (cursor === resolvedDataRoot) break
    const parent = path.dirname(cursor)
    const within = path.relative(resolvedDataRoot, cursor)
    if (parent === cursor || !within || within === '..' || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) {
      throw new Error('legacy application lease namespace escapes its data root')
    }
    cursor = parent
  }
  const allowedContainers = new Set(['leases', 'staging', 'retired'])
  for (const entry of fs.readdirSync(legacy, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !allowedContainers.has(entry.name)) {
      throw new Error('legacy application lease namespace is non-empty or unverifiable')
    }
    const container = path.join(legacy, entry.name)
    const stat = fs.lstatSync(container)
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.readdirSync(container).length !== 0) {
      throw new Error('legacy application lease namespace contains lock state and requires explicit recovery')
    }
  }
}

export class LeaseLockNotOwnedError extends ApplicationTransactionErrorBase {
  readonly code = 'LOCK_NOT_OWNED' as const
  readonly retryable = true

  constructor(message = 'lease owner identity no longer matches the live lock') {
    super(message)
    this.name = 'LeaseLockNotOwnedError'
  }
}

class MissingProcessError extends Error {}

function lstatMaybe(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function filesystemIdentity(stat: fs.Stats): FilesystemIdentity {
  return { dev: stat.dev, ino: stat.ino }
}

function sameFilesystemIdentity(left: FilesystemIdentity, right: FilesystemIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function safeProcessIdentity(identity: string): string {
  if (!SAFE_PROCESS_IDENTITY.test(identity)) {
    throw new Error('process creation identity is unavailable or unsafe')
  }
  return identity
}

function readLinuxIdentity(pid: number): string {
  let stat: string
  let bootId: string
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim().replaceAll('-', '')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ESRCH') throw new MissingProcessError()
    throw error
  }
  const closing = stat.lastIndexOf(')')
  if (closing < 0) throw new Error('Linux process stat is malformed')
  const fields = stat.slice(closing + 1).trim().split(/\s+/)
  const startTicks = fields[19]
  if (!/^\d+$/.test(startTicks || '') || !/^[a-f0-9]{32}$/i.test(bootId)) {
    throw new Error('Linux process creation identity is malformed')
  }
  return safeProcessIdentity(`linux:${bootId.toLowerCase()}:${startTicks}`)
}

async function readWindowsIdentity(pid: number): Promise<string> {
  const windowsRoot = process.env.SystemRoot || 'C:\\Windows'
  const powershell = path.join(
    windowsRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop`,
    'if ($null -eq $p) { exit 3 }',
    '[Console]::Out.Write($p.CreationDate.ToUniversalTime().Ticks)'
  ].join('; ')
  try {
    const { stdout } = await execFileAsync(powershell, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script
    ], { windowsHide: true, timeout: 10_000 })
    const ticks = stdout.trim()
    if (!/^\d+$/.test(ticks)) throw new Error('Windows process creation identity is malformed')
    return safeProcessIdentity(`windows:${ticks}`)
  } catch (error) {
    if (Number((error as { code?: unknown }).code) === 3) throw new MissingProcessError()
    throw error
  }
}

async function readPsIdentity(pid: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
      timeout: 10_000
    })
    const started = stdout.trim()
    if (!started) throw new MissingProcessError()
    return safeProcessIdentity(`ps:${sha256Identifier(started).slice('sha256:'.length)}`)
  } catch (error) {
    const code = Number((error as { code?: unknown }).code)
    if (code === 1) throw new MissingProcessError()
    throw error
  }
}

async function systemIdentity(pid: number): Promise<string> {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('process id is invalid')
  if (process.platform === 'win32') return readWindowsIdentity(pid)
  if (process.platform === 'linux') return readLinuxIdentity(pid)
  return readPsIdentity(pid)
}

export function createSystemLeaseProcessInspector(): LeaseProcessInspector {
  return {
    currentIdentity(pid) {
      return systemIdentity(pid)
    },
    async probe(pid, expectedIdentity) {
      try {
        const actual = await systemIdentity(pid)
        return actual === expectedIdentity ? 'alive-owner' : 'pid-reused'
      } catch (error) {
        return error instanceof MissingProcessError ? 'dead' : 'unknown'
      }
    }
  }
}

function validateIdentity(identity: ApplicationTransactionIdentity): void {
  if (identity.scope === 'hub-global') {
    if (identity.key !== HUB_GLOBAL_LOCK_KEY) throw new Error('hub-global lease requires hub-global key')
  } else if (!SHA256_PATH_KEY.test(identity.key)) {
    throw new Error('worktree lease requires a full sha256 path key')
  }
  if (!SAFE_HOST_ID.test(identity.hostId)) throw new Error('lease host id is invalid')
  if (!SAFE_REQUEST_ID.test(identity.requestId)) throw new Error('lease request id is invalid')
  if (!WRITE_COMMAND_KINDS.includes(identity.commandKind)) {
    throw new Error('lease command is not a frozen write command kind')
  }
}

function lockName(identity: ApplicationTransactionIdentity): string {
  return identity.scope === 'hub-global'
    ? 'hub-global.lock'
    : `worktree-${identity.key.slice('sha256:'.length)}.lock`
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function validationReason(record: unknown): LockRecordV1 {
  const result = validateLockRecordV1(record)
  if (!result.valid) {
    throw new Error(`lock record failed schema validation (${result.errors.length} violations)`)
  }
  if (!OWNER_TOKEN_PATTERN.test(result.value.ownerToken)) {
    throw new Error('lock record owner token is not path-safe')
  }
  if (!WRITE_COMMAND_KINDS.includes(result.value.command as (typeof WRITE_COMMAND_KINDS)[number])) {
    throw new Error('lock record command is not a frozen write command kind')
  }
  return result.value
}

function validateRetireClaim(value: unknown): RetireClaim {
  if (!value || typeof value !== 'object' || !exactKeys(value, [
    'actorPid', 'actorProcessIdentity', 'createdAt', 'format', 'lockKey', 'ownerHash', 'scope'
  ])) throw new Error('lease retirement claim has an invalid schema')
  const claim = value as RetireClaim
  if (claim.format !== RETIRE_CLAIM_FORMAT
    || claim.scope !== 'hub-global' && claim.scope !== 'worktree'
    || claim.scope === 'hub-global' && claim.lockKey !== HUB_GLOBAL_LOCK_KEY
    || claim.scope === 'worktree' && !SHA256_PATH_KEY.test(claim.lockKey)
    || !SHA256_PATTERN.test(claim.ownerHash)
    || !Number.isSafeInteger(claim.actorPid) || claim.actorPid < 1
    || !SAFE_PROCESS_IDENTITY.test(claim.actorProcessIdentity)
    || !Number.isFinite(Date.parse(claim.createdAt))) {
    throw new Error('lease retirement claim is inconsistent')
  }
  return claim
}

export function createLeaseLockManager(options: LeaseLockManagerOptions): LeaseLockManager {
  if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs < 1) {
    throw new Error('leaseMs must be a positive safe integer')
  }
  const preflightRoot = options.preflightRoot || (() => {})
  preflightRoot()
  assertApplicationLeaseNamespaceSafe(options.root)
  const files = new DurableFileRoot(options)
  const now = options.now || Date.now
  const nextToken = options.token || durableToken
  const pid = options.pid ?? process.pid
  const inspector = options.processInspector || createSystemLeaseProcessInspector()
  const checkpoint = options.checkpoint || (() => {})
  const fault = options.fault || (() => {})
  const pendingCleanups = new Map<string, {
    identity: ApplicationTransactionIdentity
    ownerHash: `sha256:${string}`
    claim: RetireClaim
    claimProof?: CapturedLeaseFile
    directory?: CapturedLeaseDirectory
  }>()
  const foregroundRetirements = new Set<string>()
  const pendingStagingCleanups = new Map<string, {
    identity: ApplicationTransactionIdentity
    expected: LockRecordV1
  }>()
  const pendingReleases = new Map<string, {
    identity: ApplicationTransactionIdentity
    owner: OwnerIdentity
    actorProcessIdentity: string
    proof?: LeaseReleaseProof
  }>()
  let pendingReleaseDrain: Promise<void> | null = null
  let backgroundReleaseTimer: NodeJS.Timeout | null = null
  let backgroundReleaseAttempt = 0

  function lockRelative(identity: ApplicationTransactionIdentity): string {
    return normalizeDurableRelative(path.posix.join(LOCKS_DIRECTORY, lockName(identity)))
  }

  function ownerRelative(identity: ApplicationTransactionIdentity): string {
    return normalizeDurableRelative(path.posix.join(lockRelative(identity), OWNER_FILE))
  }

  function acquisitionAbsoluteOrGone(relativePath: string, label: string): string | null {
    const normalized = normalizeDurableRelative(relativePath)
    const candidate = path.resolve(files.root, ...normalized.split('/'))
    const parentRelative = normalizeDurableRelative(path.posix.dirname(normalized))
    const parentAbsolute = files.absolute(parentRelative, `${label} parent`)
    const parentBefore = lstatMaybe(parentAbsolute)
    if (!parentBefore?.isDirectory() || parentBefore.isSymbolicLink()) {
      throw new Error(`${label} parent is not a plain directory`)
    }
    try {
      return files.absolute(normalized, label)
    } catch (error) {
      let resolvedParent: string
      try {
        resolvedParent = files.absolute(parentRelative, `${label} parent revalidation`)
      } catch {
        throw error
      }
      const parentAfter = lstatMaybe(resolvedParent)
      if (!parentAfter?.isDirectory() || parentAfter.isSymbolicLink()
        || !sameFilesystemIdentity(parentBefore, parentAfter)) {
        throw error
      }
      if (!lstatMaybe(candidate)) return null
      throw error
    }
  }

  function readRecord(identity: ApplicationTransactionIdentity): LockRecordV1 | null {
    const directory = files.absolute(lockRelative(identity), 'lease directory')
    const stat = lstatMaybe(directory)
    if (!stat) return null
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('lease path is not a plain directory')
    for (const entry of files.list(lockRelative(identity), LOCK_DIRECTORY_MAX_ENTRIES)) {
      const allowedRenew = /^\.owner\.skill-graft-renew-[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.tmp$/.test(entry.name)
      if (entry.isSymbolicLink() || !entry.isFile()
        || entry.name !== OWNER_FILE && !allowedRenew) {
        throw new Error('lease directory contains an unexpected artifact')
      }
    }
    const owner = files.read(ownerRelative(identity), LOCK_RECORD_MAX_BYTES)
    if (owner.status === 'missing') throw new Error('lease owner record is missing')
    let raw: unknown
    try {
      raw = JSON.parse(decodeUtf8Fatal(owner.bytes, 'lease owner record'))
    } catch (error) {
      throw new Error(`lease owner record is invalid: ${error instanceof Error ? error.message : String(error)}`)
    }
    const record = validationReason(raw)
    if (record.scope !== identity.scope || record.lockKey !== identity.key) {
      throw new Error('lease owner record does not match its lock key')
    }
    return record
  }

  function recordFor(
    identity: ApplicationTransactionIdentity,
    ownerToken: string,
    processIdentity: string,
    acquiredAtMs: number
  ): LockRecordV1 {
    const acquiredAt = new Date(acquiredAtMs).toISOString()
    const record = {
      schemaVersion: LOCK_RECORD_SCHEMA_VERSION,
      scope: identity.scope,
      lockKey: identity.key,
      ownerToken,
      hostId: identity.hostId,
      pid,
      processIdentity,
      command: identity.commandKind,
      requestId: identity.requestId,
      acquiredAt,
      heartbeatAt: acquiredAt,
      leaseUntil: new Date(acquiredAtMs + options.leaseMs).toISOString()
    } as LockRecordV1
    return validationReason(record)
  }

  function stagingRelative(identity: ApplicationTransactionIdentity, ownerToken: string): string {
    return normalizeDurableRelative(path.posix.join(
      LOCKS_DIRECTORY,
      `.acquire-${lockName(identity)}-${ownerToken}.tmp`
    ))
  }

  function ownerHash(ownerToken: string): `sha256:${string}` {
    return sha256Identifier(ownerToken)
  }

  function retireClaimRelative(
    identity: ApplicationTransactionIdentity,
    hash: `sha256:${string}`
  ): string {
    return normalizeDurableRelative(path.posix.join(
      LOCKS_DIRECTORY,
      `.retire-${lockName(identity)}-${hash.slice('sha256:'.length)}.claim.json`
    ))
  }

  function retiredRelative(
    identity: ApplicationTransactionIdentity,
    hash: `sha256:${string}`
  ): string {
    return normalizeDurableRelative(path.posix.join(
      LOCKS_DIRECTORY,
      `.retired-${lockName(identity)}-${hash.slice('sha256:'.length)}.tmp`
    ))
  }

  function removeOwnedStaging(
    relativeDirectory: string,
    observedIdentity?: FilesystemIdentity,
    expectedRecord?: LockRecordV1
  ): void {
    assertMutationBoundary()
    const resolvedAbsolute = acquisitionAbsoluteOrGone(relativeDirectory, 'lease acquisition staging')
    if (!resolvedAbsolute) return
    const absolute: string = resolvedAbsolute
    const initial = lstatMaybe(absolute)
    if (!initial) return
    if (!initial.isDirectory() || initial.isSymbolicLink()) {
      throw new Error('lease staging path is unsafe')
    }
    if (observedIdentity && !sameFilesystemIdentity(observedIdentity, initial)) {
      throw new Error('lease staging directory no longer matches its observed cleanup identity')
    }
    const expectedDirectory = observedIdentity || filesystemIdentity(initial)

    function sameDirectoryOrGone(): fs.Stats | null {
      const current = lstatMaybe(absolute)
      if (!current) return null
      if (!current.isDirectory() || current.isSymbolicLink()
        || !sameFilesystemIdentity(expectedDirectory, current)) {
        throw new Error('lease staging directory identity changed during cleanup')
      }
      return current
    }

    function removeDirectoryAndProveGone(): void {
      let removed = false
      let lastFailure: unknown
      const waiter = new Int32Array(new SharedArrayBuffer(4))
      for (const delay of WINDOWS_STAGING_RMDIR_RETRY_DELAYS_MS) {
        if (delay > 0) Atomics.wait(waiter, 0, 0, delay)
        if (!sameDirectoryOrGone()) {
          removed = true
          break
        }
        try {
          assertMutationBoundary()
          sameDirectoryOrGone()
          fs.rmdirSync(absolute)
          removed = true
          break
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code === 'ENOENT') {
            const current = lstatMaybe(absolute)
            if (!current) {
              removed = true
              break
            }
            if (!current.isDirectory() || current.isSymbolicLink()
              || !sameFilesystemIdentity(expectedDirectory, current)) {
              throw new Error('lease staging directory was replaced during cleanup')
            }
            throw new Error('lease staging directory still exists after a missing-directory cleanup result')
          }
          if (process.platform === 'win32' && (code === 'EACCES' || code === 'EPERM')) {
            lastFailure = error
            continue
          }
          throw error
        }
      }
      if (!removed) {
        const current = lstatMaybe(absolute)
        if (!current) removed = true
        else {
          if (!current.isDirectory() || current.isSymbolicLink()
            || !sameFilesystemIdentity(expectedDirectory, current)) {
            throw new Error('lease staging directory was replaced during cleanup')
          }
          throw lastFailure
        }
      }
      if (lstatMaybe(absolute)) {
        throw new Error('lease staging directory was replaced during cleanup')
      }
      flushDirectory(path.dirname(absolute))
    }

    let entries: fs.Dirent[]
    try {
      entries = files.list(relativeDirectory, LOCK_DIRECTORY_MAX_ENTRIES)
    } catch (error) {
      if (!sameDirectoryOrGone()) return
      throw error
    }
    if (!sameDirectoryOrGone()) return
    for (const entry of entries) {
      if (entry.name !== OWNER_FILE || !entry.isFile() || entry.isSymbolicLink()) {
        throw new Error('lease staging contains an unexpected artifact')
      }
      if (!sameDirectoryOrGone()) return
      const ownerAbsolute = path.join(absolute, OWNER_FILE)
      const ownerBefore = lstatMaybe(ownerAbsolute)
      if (!ownerBefore) {
        removeDirectoryAndProveGone()
        return
      }
      if (!ownerBefore.isFile() || ownerBefore.isSymbolicLink() || ownerBefore.nlink !== 1) {
        throw new Error('lease staging owner changed to an unsafe artifact during cleanup')
      }
      const capturedOwner = capturePlainLeaseFile(ownerAbsolute, 'lease staging owner cleanup', true)
      const rawOwner = parseLeaseJsonOrPartial(capturedOwner.bytes, 'lease staging owner cleanup')
      if (expectedRecord) {
        if (rawOwner === null || !sameLockRecord(validationReason(rawOwner), expectedRecord)) {
          throw new Error('lease staging cleanup no longer matches its expected owner record')
        }
      }
      try {
        assertMutationBoundary()
        if (!sameDirectoryOrGone()) return
        unlinkCapturedLeaseFile(ownerAbsolute, capturedOwner, 'lease staging owner cleanup')
      } catch (error) {
        if (!sameDirectoryOrGone()) {
          flushDirectory(path.dirname(absolute))
          return
        }
        const ownerAfter = lstatMaybe(ownerAbsolute)
        if (!ownerAfter) {
          removeDirectoryAndProveGone()
          return
        }
        if (!ownerAfter.isFile() || ownerAfter.isSymbolicLink() || ownerAfter.nlink !== 1
          || !sameFilesystemIdentity(ownerBefore, ownerAfter)) {
          throw new Error('lease staging owner identity changed during cleanup')
        }
        throw error
      }
      if (!sameDirectoryOrGone()) return
    }
    removeDirectoryAndProveGone()
  }

  function identityFromRecord(record: LockRecordV1): ApplicationTransactionIdentity {
    return {
      scope: record.scope,
      key: record.lockKey,
      hostId: record.hostId,
      commandKind: record.command as ApplicationTransactionIdentity['commandKind'],
      requestId: record.requestId
    } as ApplicationTransactionIdentity
  }

  function identityFromClaim(claim: RetireClaim): ApplicationTransactionIdentity {
    return {
      scope: claim.scope,
      key: claim.lockKey,
      hostId: 'lease-cleanup',
      commandKind: 'ingest',
      requestId: 'lease-cleanup'
    } as ApplicationTransactionIdentity
  }

  function incompleteJson(error: unknown, text: string): boolean {
    if (!(error instanceof SyntaxError)) return false
    if (error.message.includes('Unexpected end of JSON input')) return true
    const position = /\bposition (\d+)\b/.exec(error.message)
    return position !== null && Number(position[1]) >= text.length
  }

  function readStagingRecord(relativeDirectory: string): StagingRecordRead {
    const resolvedAbsolute = acquisitionAbsoluteOrGone(relativeDirectory, 'lease acquisition staging')
    if (!resolvedAbsolute) return { status: 'gone' }
    const absolute: string = resolvedAbsolute
    const directory = lstatMaybe(absolute)
    if (!directory) return { status: 'gone' }
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      throw new Error('lease staging path is unsafe')
    }
    const expectedDirectory = directory
    const observedDirectoryIdentity = filesystemIdentity(expectedDirectory)

    function sameDirectoryOrGone(): fs.Stats | null {
      const current = lstatMaybe(absolute)
      if (!current) return null
      if (!current.isDirectory() || current.isSymbolicLink()
        || !sameFilesystemIdentity(expectedDirectory, current)) {
        throw new Error('lease staging directory identity changed while it was read')
      }
      return current
    }

    function missingOwner(): StagingRecordRead {
      if (!sameDirectoryOrGone()) return { status: 'gone' }
      let remaining: fs.Dirent[]
      try {
        remaining = files.list(relativeDirectory, LOCK_DIRECTORY_MAX_ENTRIES)
      } catch (error) {
        if (!sameDirectoryOrGone()) return { status: 'gone' }
        throw error
      }
      if (!sameDirectoryOrGone()) return { status: 'gone' }
      if (remaining.length === 0) {
        return {
          status: 'transient',
          reason: 'empty-directory',
          directoryIdentity: observedDirectoryIdentity
        }
      }
      throw new Error('lease acquisition owner is missing')
    }

    let entries: fs.Dirent[]
    try {
      entries = files.list(relativeDirectory, LOCK_DIRECTORY_MAX_ENTRIES)
    } catch (error) {
      if (!sameDirectoryOrGone()) return { status: 'gone' }
      throw error
    }
    if (!sameDirectoryOrGone()) return { status: 'gone' }
    if (entries.length === 0) {
      return {
        status: 'transient',
        reason: 'empty-directory',
        directoryIdentity: observedDirectoryIdentity
      }
    }
    if (entries.length !== 1 || entries[0].name !== OWNER_FILE
      || !entries[0].isFile() || entries[0].isSymbolicLink()) {
      throw new Error('lease acquisition staging is incomplete')
    }
    const ownerRelativePath = path.posix.join(relativeDirectory, OWNER_FILE)
    // The staging directory itself is the identity-fenced parent already.
    // A second canonical traversal here would recreate the lstat/realpath
    // rename race that this reader is designed to classify.
    const ownerAbsolute = path.join(absolute, OWNER_FILE)
    const ownerBefore = lstatMaybe(ownerAbsolute)
    if (!ownerBefore) return missingOwner()
    if (!ownerBefore.isFile() || ownerBefore.isSymbolicLink() || ownerBefore.nlink !== 1) {
      throw new Error('lease acquisition owner is not a unique plain file')
    }
    if (ownerBefore.size > LOCK_RECORD_MAX_BYTES) {
      throw new Error(`lease acquisition owner exceeds the ${LOCK_RECORD_MAX_BYTES} byte limit`)
    }
    let file: ReturnType<DurableFileRoot['read']>
    try {
      fault('lease-before-acquisition-owner-read', {})
      file = files.read(ownerRelativePath, LOCK_RECORD_MAX_BYTES)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return missingOwner()
      }
      const currentDirectory = sameDirectoryOrGone()
      if (!currentDirectory) return { status: 'gone' }
      const ownerAfter = lstatMaybe(ownerAbsolute)
      if (ownerAfter?.isFile() && !ownerAfter.isSymbolicLink() && ownerAfter.nlink === 1
        && sameFilesystemIdentity(ownerBefore, ownerAfter)
        && ownerAfter.size > ownerBefore.size
        && ownerAfter.size <= LOCK_RECORD_MAX_BYTES
        && now() - currentDirectory.mtimeMs < options.leaseMs) {
        return {
          status: 'transient',
          reason: 'growing-owner-file',
          directoryIdentity: observedDirectoryIdentity
        }
      }
      throw error
    }
    if (file.status === 'missing') return missingOwner()
    if (!sameDirectoryOrGone()) return { status: 'gone' }
    const ownerAfterRead = lstatMaybe(ownerAbsolute)
    if (!ownerAfterRead || !ownerAfterRead.isFile() || ownerAfterRead.isSymbolicLink()
      || ownerAfterRead.nlink !== 1 || !sameFilesystemIdentity(ownerBefore, ownerAfterRead)
      || ownerAfterRead.size !== file.bytes.length) {
      throw new Error('lease acquisition owner identity changed while it was read')
    }
    const text = decodeUtf8Fatal(file.bytes, 'lease acquisition owner')
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch (error) {
      if (incompleteJson(error, text)) {
        if (!sameDirectoryOrGone()) return { status: 'gone' }
        return {
          status: 'transient',
          reason: 'incomplete-owner-json',
          directoryIdentity: observedDirectoryIdentity
        }
      }
      throw new Error(`lease acquisition owner is invalid: ${error instanceof Error ? error.message : String(error)}`)
    }
    const record = validationReason(raw)
    if (!sameDirectoryOrGone()) return { status: 'gone' }
    return { status: 'complete', record, directoryIdentity: observedDirectoryIdentity }
  }

  function sameLockRecord(left: LockRecordV1, right: LockRecordV1): boolean {
    return left.schemaVersion === right.schemaVersion
      && left.scope === right.scope
      && left.lockKey === right.lockKey
      && left.ownerToken === right.ownerToken
      && left.hostId === right.hostId
      && left.pid === right.pid
      && left.processIdentity === right.processIdentity
      && left.command === right.command
      && left.requestId === right.requestId
      && left.acquiredAt === right.acquiredAt
      && left.heartbeatAt === right.heartbeatAt
      && left.leaseUntil === right.leaseUntil
  }

  function retainPendingStagingCleanup(
    relativeDirectory: string,
    identity: ApplicationTransactionIdentity,
    expected: LockRecordV1
  ): void {
    pendingStagingCleanups.set(relativeDirectory, { identity, expected })
    backgroundReleaseAttempt = 0
    scheduleBackgroundReleaseDrain()
  }

  function drainPendingStagingCleanups(): void {
    assertMutationBoundary()
    for (const [relative, cleanup] of pendingStagingCleanups) {
      const absolute = acquisitionAbsoluteOrGone(relative, 'pending lease acquisition staging')
      if (!absolute) {
        pendingStagingCleanups.delete(relative)
        continue
      }
      const stat = lstatMaybe(absolute)
      if (!stat) {
        pendingStagingCleanups.delete(relative)
        continue
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error('pending lease staging path is unsafe')
      }
      const removalIdentity = filesystemIdentity(stat)
      let entries: fs.Dirent[]
      try {
        entries = files.list(relative, LOCK_DIRECTORY_MAX_ENTRIES)
      } catch (error) {
        const current = acquisitionAbsoluteOrGone(relative, 'pending lease acquisition staging')
        if (!current) {
          pendingStagingCleanups.delete(relative)
          continue
        }
        const currentStat = lstatMaybe(current)
        if (!currentStat) {
          pendingStagingCleanups.delete(relative)
          continue
        }
        if (!currentStat.isDirectory() || currentStat.isSymbolicLink()
          || !sameFilesystemIdentity(removalIdentity, currentStat)) {
          throw new Error('pending lease staging directory identity changed while it was listed')
        }
        throw error
      }
      if (entries.length > 0) {
        const observed = readStagingRecord(relative)
        if (observed.status === 'gone') {
          pendingStagingCleanups.delete(relative)
          continue
        }
        if (observed.status !== 'complete'
          || !sameFilesystemIdentity(removalIdentity, observed.directoryIdentity)
          || !sameLockRecord(observed.record, cleanup.expected)
          || observed.record.scope !== cleanup.identity.scope
          || observed.record.lockKey !== cleanup.identity.key) {
          throw new Error('pending lease staging no longer matches its exact owner facts')
        }
      }
      assertMutationBoundary()
      removeOwnedStaging(relative, removalIdentity, cleanup.expected)
      pendingStagingCleanups.delete(relative)
    }
  }

  const assertMutationBoundary = (): void => {
    preflightRoot()
    assertApplicationLeaseNamespaceSafe(files.root)
  }

  const revalidateMutationBoundary = async (revalidate: () => Promise<unknown> = async () => {}): Promise<void> => {
    await revalidate()
    assertMutationBoundary()
  }

  async function sweepArtifacts(revalidate: () => Promise<unknown> = async () => {}): Promise<void> {
    await revalidateMutationBoundary(revalidate)
    const container = files.absolute(LOCKS_DIRECTORY, 'application lease container')
    let entries = files.list(LOCKS_DIRECTORY, 10_000)
    let collapsedClaimPair = false
    for (const entry of entries) {
      if (!RETIRE_CLAIM_TEMP_NAME.test(entry.name)) continue
      const relative = normalizeDurableRelative(path.posix.join(LOCKS_DIRECTORY, entry.name))
      const file = files.absolute(relative, 'linked retirement claim temporary')
      const stat = fs.lstatSync(file)
      if (stat.nlink !== 2) continue
      const linked = entries.filter((candidate) => RETIRE_CLAIM_NAME.test(candidate.name)).filter((candidate) => {
        const candidateStat = fs.lstatSync(path.join(container, candidate.name))
        return candidateStat.isFile() && !candidateStat.isSymbolicLink() && candidateStat.nlink === 2
          && candidateStat.dev === stat.dev && candidateStat.ino === stat.ino
      })
      if (linked.length !== 1) throw new Error('retirement claim temporary has an unowned additional hard link')
      const capture = captureLinkedLeaseFile(file, 'linked retirement claim temporary')
      const claimCapture = captureLinkedLeaseFile(path.join(container, linked[0].name), 'linked retirement claim')
      if (!capture.bytes.equals(claimCapture.bytes)) throw new Error('retirement claim hard-link pair is inconsistent')
      await revalidateMutationBoundary(revalidate)
      assertCapturedLeaseFile(file, capture, 'linked retirement claim temporary')
      if (!unlinkExactFile(file, capture.stat)) throw new Error('linked retirement claim temporary changed before cleanup')
      flushDirectory(container)
      collapsedClaimPair = true
    }
    if (collapsedClaimPair) {
      assertApplicationLeaseNamespaceSafe(files.root)
      entries = files.list(LOCKS_DIRECTORY, 10_000)
    }
    const names = new Set(entries.map((entry) => entry.name))
    const claims = new Map<string, RetireClaim>()
    for (const entry of entries) {
      if (!/^\.retire-(?:hub-global|worktree-[a-f0-9]{64})\.lock-[a-f0-9]{64}\.claim\.json$/.test(entry.name)) continue
      const relative = normalizeDurableRelative(path.posix.join(LOCKS_DIRECTORY, entry.name))
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('lease retirement claim is unsafe')
      const claim = readRetireClaim(relative)
      const identity = identityFromClaim(claim)
      if (path.posix.basename(retireClaimRelative(identity, claim.ownerHash)) !== entry.name) {
        throw new Error('lease retirement claim name is inconsistent')
      }
      claims.set(entry.name, claim)
    }
    for (const entry of entries) {
      const retired = /^\.retired-((?:hub-global|worktree-[a-f0-9]{64})\.lock)-([a-f0-9]{64})\.tmp$/.exec(entry.name)
      if (retired) {
        const matchingClaim = `.retire-${retired[1]}-${retired[2]}.claim.json`
        if (!names.has(matchingClaim)) {
          throw new Error('retired lease artifact is missing its fencing claim')
        }
      }
    }
    // Classify and fully validate the frozen top-level inventory before any
    // stale cleanup. A mixed known-stale + foreign inventory must be a
    // byte-for-byte no-op rather than a partial cleanup.
    for (const entry of entries) {
      const live = /^(?:hub-global|worktree-[a-f0-9]{64})\.lock$/.test(entry.name)
      const acquire = /^\.acquire-(?:hub-global|worktree-[a-f0-9]{64})\.lock-[A-Za-z0-9._-]{16,64}\.tmp$/.test(entry.name)
      const claim = /^\.retire-(?:hub-global|worktree-[a-f0-9]{64})\.lock-[a-f0-9]{64}\.claim\.json$/.test(entry.name)
      const retired = /^\.retired-(?:hub-global|worktree-[a-f0-9]{64})\.lock-[a-f0-9]{64}\.tmp$/.test(entry.name)
      const claimTemp = /^\.retire-claim-[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.tmp$/.test(entry.name)
      const relative = normalizeDurableRelative(path.posix.join(LOCKS_DIRECTORY, entry.name))
      if (live) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('live lease artifact is not a plain directory')
        const children = files.list(relative, LOCK_DIRECTORY_MAX_ENTRIES)
        for (const child of children) {
          const renew = /^\.owner\.skill-graft-renew-[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.tmp$/.test(child.name)
          if (!child.isFile() || child.isSymbolicLink() || child.name !== OWNER_FILE && !renew) {
            throw new Error('live lease contains an unexpected artifact')
          }
        }
        const match = /^(hub-global|worktree-([a-f0-9]{64}))\.lock$/.exec(entry.name)
        if (!match) throw new Error('live lease name is invalid')
        const identity = match[1] === 'hub-global'
          ? { scope: 'hub-global', key: HUB_GLOBAL_LOCK_KEY, hostId: 'sweep', commandKind: 'migrateState', requestId: 'sweep' } as ApplicationTransactionIdentity
          : { scope: 'worktree', key: `sha256:${match[2]}`, hostId: 'sweep', commandKind: 'migrateState', requestId: 'sweep' } as ApplicationTransactionIdentity
        if (!readRecord(identity)) throw new Error('live lease owner record is missing')
        continue
      }
      if (acquire) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('lease acquisition artifact is not a plain directory')
        const observed = readStagingRecord(relative)
        if (observed.status === 'complete') {
          const identity = identityFromRecord(observed.record)
          if (path.posix.basename(stagingRelative(identity, observed.record.ownerToken)) !== entry.name) {
            throw new Error('lease acquisition staging name does not match its owner')
          }
        }
        continue
      }
      if (claim) {
        if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('lease retirement claim is unsafe')
        const value = readRetireClaim(relative)
        const identity = identityFromClaim(value)
        if (path.posix.basename(retireClaimRelative(identity, value.ownerHash)) !== entry.name) {
          throw new Error('lease retirement claim name is inconsistent')
        }
        continue
      }
      if (retired) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('retired lease artifact is unsafe')
        const retiredMatch = /^\.retired-((?:hub-global|worktree-[a-f0-9]{64})\.lock)-([a-f0-9]{64})\.tmp$/.exec(entry.name)
        if (!retiredMatch) throw new Error('retired lease name is invalid')
        const claimName = `.retire-${retiredMatch[1]}-${retiredMatch[2]}.claim.json`
        const claimValue = claims.get(claimName)
        if (!claimValue) throw new Error('retired lease artifact is missing its validated fencing claim')
        const children = files.list(relative, LOCK_DIRECTORY_MAX_ENTRIES)
        for (const child of children) {
          const renew = /^\.owner\.skill-graft-renew-[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.tmp$/.test(child.name)
          if (!child.isFile() || child.isSymbolicLink() || child.name !== OWNER_FILE && !renew) {
            throw new Error('retired lease contains an unexpected artifact')
          }
        }
        const owner = children.find((child) => child.name === OWNER_FILE)
        if (owner) {
          const ownerFile = files.read(path.posix.join(relative, OWNER_FILE), LOCK_RECORD_MAX_BYTES)
          if (ownerFile.status !== 'plain') throw new Error('retired lease owner record is unsafe')
          const record = validationReason(JSON.parse(decodeUtf8Fatal(ownerFile.bytes, 'retired lease owner')))
          if (record.scope !== claimValue.scope || record.lockKey !== claimValue.lockKey
            || ownerHash(record.ownerToken) !== claimValue.ownerHash) {
            throw new Error('retired lease owner does not match its fencing claim')
          }
        } else if (children.length !== 0) {
          throw new Error('partially cleaned retired lease contains ownerless artifacts')
        }
        continue
      }
      if (claimTemp) {
        if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('retirement claim temporary is unsafe')
        const tempFile = files.absolute(relative, 'retirement claim temporary')
        const stat = fs.lstatSync(tempFile)
        if (stat.size > LOCK_RECORD_MAX_BYTES || stat.nlink < 1 || stat.nlink > 2) {
          throw new Error('retirement claim temporary is unsafe')
        }
        if (stat.nlink === 2) {
          const linked = entries.filter((candidate) => RETIRE_CLAIM_NAME.test(candidate.name)).filter((candidate) => {
            const candidateStat = fs.lstatSync(path.join(container, candidate.name))
            return candidateStat.isFile() && !candidateStat.isSymbolicLink() && candidateStat.nlink === 2
              && candidateStat.dev === stat.dev && candidateStat.ino === stat.ino
          })
          if (linked.length !== 1) throw new Error('retirement claim temporary has an unowned additional hard link')
          const tempCapture = captureLinkedLeaseFile(tempFile, 'retirement claim temporary')
          const claimCapture = captureLinkedLeaseFile(path.join(container, linked[0].name), 'lease retirement claim')
          if (!tempCapture.bytes.equals(claimCapture.bytes)) throw new Error('retirement claim hard-link pair is inconsistent')
          validateRetireClaim(JSON.parse(decodeUtf8Fatal(tempCapture.bytes, 'retirement claim temporary')))
        }
        continue
      }
      throw new Error(`unexpected lease artifact: ${entry.name}`)
    }
    for (const entry of entries) {
      if (/^(?:hub-global|worktree-[a-f0-9]{64})\.lock$/.test(entry.name)) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          throw new Error('live lease artifact is not a plain directory')
        }
        continue
      }
      const relative = normalizeDurableRelative(path.posix.join(LOCKS_DIRECTORY, entry.name))
      if (/^\.acquire-(?:hub-global|worktree-[a-f0-9]{64})\.lock-[A-Za-z0-9._-]{16,64}\.tmp$/.test(entry.name)) {
        try {
          checkpoint('lease-acquisition-artifact-observed', {})
        } catch { /* observation only */ }
        await revalidateMutationBoundary(revalidate)
        const absolute = acquisitionAbsoluteOrGone(relative, 'lease acquisition artifact')
        if (!absolute) continue
        const artifact = lstatMaybe(absolute)
        if (!artifact) continue
        if (!artifact.isDirectory() || artifact.isSymbolicLink()) {
          throw new Error('lease acquisition artifact is not a plain directory')
        }
        let observed = readStagingRecord(relative)
        if (observed.status === 'gone') continue
        if (observed.status === 'transient') {
          const current = lstatMaybe(absolute)
          if (!current) continue
          if (!current.isDirectory() || current.isSymbolicLink()) {
            throw new Error('lease acquisition artifact is not a plain directory')
          }
          if (now() - current.mtimeMs >= options.leaseMs) {
            const rechecked = readStagingRecord(relative)
            if (rechecked.status === 'gone') continue
            if (rechecked.status === 'transient') {
              fault('lease-before-stale-acquisition-cleanup', {})
              await revalidateMutationBoundary(revalidate)
              removeOwnedStaging(relative, rechecked.directoryIdentity)
              continue
            }
            observed = rechecked
          } else {
            continue
          }
        }
        const record = observed.record
        const identity = identityFromRecord(record)
        if (path.posix.basename(stagingRelative(identity, record.ownerToken)) !== entry.name) {
          throw new Error('lease acquisition staging name does not match its owner')
        }
        const status = await inspector.probe(record.pid, record.processIdentity)
        await revalidateMutationBoundary(revalidate)
        if (status === 'dead' || status === 'pid-reused') {
          await revalidateMutationBoundary(revalidate)
          removeOwnedStaging(relative, observed.directoryIdentity, observed.record)
        }
        continue
      }
      if (/^\.retire-(?:hub-global|worktree-[a-f0-9]{64})\.lock-[a-f0-9]{64}\.claim\.json$/.test(entry.name)) {
        if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('lease retirement claim is unsafe')
        const claimed = captureRetireClaim(relative)
        const claim = claimed.claim
        const identity = identityFromClaim(claim)
        if (path.posix.basename(retireClaimRelative(identity, claim.ownerHash)) !== entry.name) {
          throw new Error('lease retirement claim name is inconsistent')
        }
        const status = await inspector.probe(claim.actorPid, claim.actorProcessIdentity)
        await revalidateMutationBoundary(revalidate)
        assertCapturedLeaseFile(files.absolute(relative, 'lease retirement claim'), claimed.capture, 'lease retirement claim')
        if (status === 'dead' || status === 'pid-reused') {
          await revalidateMutationBoundary(revalidate)
          cleanupRetired(identity, claim.ownerHash, claim, undefined, claimed.capture)
          await revalidateMutationBoundary(revalidate)
          releaseRetireClaim(identity, claim.ownerHash, claim, claimed.capture)
        }
        continue
      }
      if (/^\.retired-(?:hub-global|worktree-[a-f0-9]{64})\.lock-[a-f0-9]{64}\.tmp$/.test(entry.name)) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('retired lease artifact is unsafe')
        // Its matching, schema-validated claim is processed separately. Never
        // delete a retired directory without owning or proving that actor dead.
        continue
      }
      if (/^\.retire-claim-[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.tmp$/.test(entry.name)) {
        if (!lstatMaybe(files.absolute(relative, 'retirement claim temporary'))) continue
        if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('retirement claim temporary is unsafe')
        const file = files.absolute(relative, 'retirement claim temporary')
        const capture = capturePlainLeaseFile(file, 'retirement claim temporary', true)
        if (now() - capture.stat.mtimeMs >= options.leaseMs) {
          const raw = parseLeaseJsonOrPartial(capture.bytes, 'retirement claim temporary')
          if (raw !== null) validateRetireClaim(raw)
          await revalidateMutationBoundary(revalidate)
          assertCapturedLeaseFile(file, capture, 'retirement claim temporary')
          unlinkCapturedLeaseFile(file, capture, 'retirement claim temporary')
          flushDirectory(path.dirname(file))
        }
        continue
      }
      throw new Error(`unexpected lease artifact: ${entry.name}`)
    }
  }

  function tryPublishStaging(
    identity: ApplicationTransactionIdentity,
    staging: string,
    expected: LockRecordV1
  ):
    | { status: 'published'; directory: CapturedLeaseDirectory; owner: CapturedLeaseFile; postPublicationError?: unknown }
    | { status: 'contended' | 'expired-before-rename' } {
    if (now() >= Date.parse(expected.leaseUntil)) return { status: 'expired-before-rename' }
    assertMutationBoundary()
    const source = files.absolute(staging, 'lease acquisition staging')
    const target = files.absolute(lockRelative(identity), 'lease live directory')
    let stagedDirectory: CapturedLeaseDirectory
    let stagedOwner: CapturedLeaseFile
    try {
      assertApplicationLeaseNamespaceSafe(files.root)
      const staged = readStagingRecord(staging)
      if (staged.status !== 'complete' || !sameLockRecord(staged.record, expected)) {
        throw new Error('lease acquisition staging changed before publication')
      }
      // readStagingRecord contains an injectable owner-read boundary. Rebind
      // the mutable data root and the complete external inventory after it,
      // before the live-directory rename publishes authority.
      assertMutationBoundary()
      stagedDirectory = capturePlainLeaseDirectory(source, 'lease acquisition staging')
      stagedOwner = capturePlainLeaseFile(path.join(source, OWNER_FILE), 'lease acquisition owner')
      const capturedRecord = validationReason(JSON.parse(decodeUtf8Fatal(stagedOwner.bytes, 'lease acquisition owner')))
      if (!sameLockRecord(capturedRecord, expected)) throw new Error('lease acquisition owner changed before publication')
      assertCapturedLeaseDirectory(source, stagedDirectory, 'lease acquisition staging')
      assertCapturedLeaseFile(path.join(source, OWNER_FILE), stagedOwner, 'lease acquisition owner')
      assertMutationBoundary()
      fs.renameSync(source, target)
    } catch (error) {
      const code = String((error as NodeJS.ErrnoException).code)
      if (!['EACCES', 'EEXIST', 'ENOTEMPTY', 'EPERM'].includes(code)) throw error
      return { status: 'contended' }
    }
    // A successful directory rename is the acquisition truth. Returning a
    // false failure after this point would forget a live owner in this process.
    // Observation/fsync failures are therefore contained; the returned lease
    // and its retained release queue own cleanup from here.
    const sealPublished = () => {
      assertMutationBoundary()
      assertCapturedLeaseDirectory(target, stagedDirectory, 'published lease directory')
      assertCapturedLeaseFile(path.join(target, OWNER_FILE), stagedOwner, 'published lease owner')
      const current = readRecord(identity)
      if (!current || !sameLockRecord(current, expected)) throw new Error('published lease changed during acquisition')
    }
    let postPublicationError: unknown
    const seal = (): void => {
      if (postPublicationError !== undefined) return
      try { sealPublished() } catch (error) { postPublicationError = error }
    }
    // Once rename publishes the live directory, injected observation errors
    // are not false acquisition failures. Each one is followed by a strict
    // full seal; only a changed root/inventory/exact inode invalidates return.
    try { fault('lease-after-live-rename', { scope: identity.scope, lockKey: identity.key }) } catch { /* renamed truth */ }
    seal()
    // Do not perform the durability mutation after a failed seal. A directory
    // fsync error itself does not undo the already-published in-process lease;
    // exact readback below remains the return authority.
    if (postPublicationError === undefined) {
      try { flushDirectory(path.dirname(target)) } catch { /* renamed truth */ }
    }
    seal()
    try { fault('lease-after-live-directory-flush', { scope: identity.scope, lockKey: identity.key }) } catch { /* renamed truth */ }
    seal()
    try { checkpoint('lease-acquired', { scope: identity.scope, lockKey: identity.key }) } catch { /* observation only */ }
    seal()
    return {
      status: 'published',
      directory: stagedDirectory,
      owner: stagedOwner,
      ...(postPublicationError === undefined ? {} : { postPublicationError })
    }
  }

  function readRetireClaimOptional(relativePath: string): RetireClaim | null {
    const file = files.read(relativePath, LOCK_RECORD_MAX_BYTES)
    if (file.status === 'missing') return null
    try {
      return validateRetireClaim(JSON.parse(decodeUtf8Fatal(file.bytes, 'lease retirement claim')))
    } catch (error) {
      throw new Error(`lease retirement claim is invalid: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function readRetireClaim(relativePath: string): RetireClaim {
    const claim = readRetireClaimOptional(relativePath)
    if (!claim) throw new Error('lease retirement claim disappeared')
    return claim
  }

  function captureRetireClaim(relativePath: string): CapturedRetireClaim {
    const file = files.absolute(relativePath, 'lease retirement claim')
    const capture = capturePlainLeaseFile(file, 'lease retirement claim')
    const claim = validateRetireClaim(JSON.parse(decodeUtf8Fatal(capture.bytes, 'lease retirement claim')))
    if (!capture.bytes.equals(jsonBytes(claim))) throw new Error('lease retirement claim is not canonical')
    return { claim, capture }
  }

  function sameRetireClaim(left: RetireClaim, right: RetireClaim): boolean {
    return left.format === right.format
      && left.scope === right.scope
      && left.lockKey === right.lockKey
      && left.ownerHash === right.ownerHash
      && left.actorPid === right.actorPid
      && left.actorProcessIdentity === right.actorProcessIdentity
      && left.createdAt === right.createdAt
  }

  function retainPendingCleanup(
    identity: ApplicationTransactionIdentity,
    hash: `sha256:${string}`,
    claim: RetireClaim,
    claimProof?: CapturedLeaseFile,
    directory?: CapturedLeaseDirectory,
    schedule = true
  ): void {
    const claimKey = retireClaimRelative(identity, hash)
    pendingCleanups.set(claimKey, {
      identity,
      ownerHash: hash,
      claim,
      claimProof,
      directory
    })
    backgroundReleaseAttempt = 0
    if (schedule) scheduleBackgroundReleaseDrain()
  }

  function cleanupRetired(
    identity: ApplicationTransactionIdentity,
    hash: `sha256:${string}`,
    expectedClaim: RetireClaim,
    expectedDirectory?: CapturedLeaseDirectory,
    expectedClaimProof?: CapturedLeaseFile
  ): void {
    assertMutationBoundary()
    const claimFile = files.absolute(retireClaimRelative(identity, hash), 'retired lease fencing claim')
    const claimCapture = capturePlainLeaseFile(claimFile, 'retired lease fencing claim')
    if (expectedClaimProof && (claimCapture.stat.dev !== expectedClaimProof.stat.dev
      || claimCapture.stat.ino !== expectedClaimProof.stat.ino
      || claimCapture.stat.size !== expectedClaimProof.stat.size
      || claimCapture.stat.mtimeMs !== expectedClaimProof.stat.mtimeMs
      || !claimCapture.bytes.equals(expectedClaimProof.bytes))) {
      throw new Error('retired lease fencing claim inode changed before cleanup')
    }
    const claim = validateRetireClaim(JSON.parse(decodeUtf8Fatal(claimCapture.bytes, 'retired lease fencing claim')))
    if (!sameRetireClaim(claim, expectedClaim)) throw new Error('retired lease fencing claim changed before cleanup')
    const relative = retiredRelative(identity, hash)
    const absolute = files.absolute(relative, 'retired lease directory')
    const stat = lstatMaybe(absolute)
    if (!stat) return
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('retired lease artifact is not a plain directory')
    }
    const capturedDirectory = expectedDirectory || { stat }
    assertCapturedLeaseDirectory(absolute, capturedDirectory, 'retired lease directory')
    const captured: Array<{ entry: fs.Dirent; file: string; capture: CapturedLeaseFile }> = []
    for (const entry of files.list(relative, LOCK_DIRECTORY_MAX_ENTRIES)) {
      const allowedRenew = RENEW_TEMP_NAME.test(entry.name)
      if (entry.isSymbolicLink() || !entry.isFile()
        || entry.name !== OWNER_FILE && !allowedRenew) {
        throw new Error('retired lease contains an unexpected artifact')
      }
      const file = files.absolute(path.posix.join(relative, entry.name), 'retired lease child')
      captured.push({ entry, file, capture: capturePlainLeaseFile(file, 'retired lease child', allowedRenew) })
    }
    captured.sort((left, right) => Number(left.entry.name === OWNER_FILE) - Number(right.entry.name === OWNER_FILE))
    for (const child of captured) {
      assertMutationBoundary()
      assertCapturedLeaseFile(claimFile, claimCapture, 'retired lease fencing claim')
      assertCapturedLeaseDirectory(absolute, capturedDirectory, 'retired lease directory')
      unlinkCapturedLeaseFile(child.file, child.capture, 'retired lease child')
    }
    assertMutationBoundary()
    assertCapturedLeaseFile(claimFile, claimCapture, 'retired lease fencing claim')
    assertCapturedLeaseDirectory(absolute, capturedDirectory, 'retired lease directory')
    fs.rmdirSync(absolute)
    flushDirectory(path.dirname(absolute))
  }

  function releaseRetireClaim(
    identity: ApplicationTransactionIdentity,
    hash: `sha256:${string}`,
    expected?: RetireClaim,
    expectedProof?: CapturedLeaseFile
  ): void {
    assertMutationBoundary()
    const relative = retireClaimRelative(identity, hash)
    const file = files.absolute(relative, 'lease retirement claim cleanup')
    const stat = lstatMaybe(file)
    if (!stat) return
    const capture = capturePlainLeaseFile(file, 'lease retirement claim cleanup')
    if (expectedProof && (capture.stat.dev !== expectedProof.stat.dev || capture.stat.ino !== expectedProof.stat.ino
      || capture.stat.size !== expectedProof.stat.size || capture.stat.mtimeMs !== expectedProof.stat.mtimeMs
      || !capture.bytes.equals(expectedProof.bytes))) {
      throw new Error('lease retirement claim inode changed before cleanup')
    }
    const claim = validateRetireClaim(JSON.parse(decodeUtf8Fatal(capture.bytes, 'lease retirement claim cleanup')))
    if (claim.scope !== identity.scope || claim.lockKey !== identity.key || claim.ownerHash !== hash
      || expected && !sameRetireClaim(claim, expected)) {
      throw new Error('lease retirement claim changed before cleanup')
    }
    assertMutationBoundary()
    unlinkCapturedLeaseFile(file, capture, 'lease retirement claim cleanup')
    flushDirectory(path.dirname(file))
  }

  async function acquireRetireClaim(
    identity: ApplicationTransactionIdentity,
    hash: `sha256:${string}`,
    actorProcessIdentity: string,
    revalidate: () => Promise<unknown> = async () => {},
    deferBackgroundCleanup = false
  ): Promise<CapturedRetireClaim | null> {
    const claimRelative = retireClaimRelative(identity, hash)
    const claim: RetireClaim = {
      format: RETIRE_CLAIM_FORMAT,
      scope: identity.scope,
      lockKey: identity.key,
      ownerHash: hash,
      actorPid: pid,
      actorProcessIdentity,
      createdAt: new Date(now()).toISOString()
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const claimToken = files.token()
      const temporary = normalizeDurableRelative(path.posix.join(
        LOCKS_DIRECTORY,
        `.retire-claim-${claimToken}.tmp`
      ))
      await revalidateMutationBoundary(revalidate)
      files.writeExclusive(temporary, jsonBytes(claim), false, true, LOCK_RECORD_MAX_BYTES)
      const temporaryPath = files.absolute(temporary, 'retirement claim temporary')
      const claimPath = files.absolute(claimRelative, 'retirement claim')
      const temporaryCapture = capturePlainLeaseFile(temporaryPath, 'retirement claim temporary')
      let acquired = false
      let linked = false
      let temporaryOwned = true
      let linkedTemporary: CapturedLeaseFile | null = null
      try {
        await revalidateMutationBoundary(revalidate)
        assertCapturedLeaseFile(temporaryPath, temporaryCapture, 'retirement claim temporary')
        fs.linkSync(temporaryPath, claimPath)
        linked = true
        linkedTemporary = captureLinkedLeaseFile(temporaryPath, 'linked retirement claim temporary')
        const linkedClaim = captureLinkedLeaseFile(claimPath, 'linked retirement claim')
        if (linkedTemporary.stat.dev !== linkedClaim.stat.dev || linkedTemporary.stat.ino !== linkedClaim.stat.ino
          || !linkedTemporary.bytes.equals(linkedClaim.bytes)) {
          throw new Error('retirement claim publication did not preserve its exact inode')
        }
        fault('lease-after-retire-claim-link', {
          scope: identity.scope,
          lockKey: identity.key
        })
        await revalidateMutationBoundary(revalidate)
        assertCapturedLeaseFile(temporaryPath, linkedTemporary, 'linked retirement claim temporary')
        if (!unlinkExactFile(temporaryPath, linkedTemporary.stat)) {
          throw new Error('linked retirement claim temporary changed before cleanup')
        }
        temporaryOwned = false
        flushDirectory(path.dirname(claimPath))
        acquired = true
      } catch (error) {
        if (linked) {
          // Drop our staging link before reading the published claim: all
          // DurableFileRoot reads require a single-link file identity.
          if (temporaryOwned && linkedTemporary) {
            await revalidateMutationBoundary(revalidate)
            assertCapturedLeaseFile(temporaryPath, linkedTemporary, 'linked retirement claim temporary')
            if (!unlinkExactFile(temporaryPath, linkedTemporary.stat) && lstatMaybe(temporaryPath) !== null) {
              throw new Error('linked retirement claim temporary was replaced before recovery')
            }
            temporaryOwned = false
          }
          const recoveredClaim = captureRetireClaim(claimRelative)
          if (!sameRetireClaim(recoveredClaim.claim, claim)) {
            throw new Error('linked retirement claim changed before recovery readback')
          }
          retainPendingCleanup(identity, hash, claim, recoveredClaim.capture, undefined, !deferBackgroundCleanup)
          fault('lease-before-retire-claim-readback', {
            scope: identity.scope,
            lockKey: identity.key
          })
          await revalidateMutationBoundary(revalidate)
          assertCapturedLeaseFile(claimPath, recoveredClaim.capture, 'recovered retirement claim')
          const observed = captureRetireClaim(claimRelative)
          if (observed.capture.stat.dev !== recoveredClaim.capture.stat.dev
            || observed.capture.stat.ino !== recoveredClaim.capture.stat.ino
            || !observed.capture.bytes.equals(recoveredClaim.capture.bytes)) {
            throw new Error('linked retirement claim inode changed during recovery readback')
          }
          if (observed.claim.actorPid === claim.actorPid
            && observed.claim.actorProcessIdentity === claim.actorProcessIdentity
            && observed.claim.scope === claim.scope
            && observed.claim.lockKey === claim.lockKey
            && observed.claim.ownerHash === claim.ownerHash) {
            acquired = true
          } else {
            throw error
          }
        } else if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error
        }
      } finally {
        if (temporaryOwned) {
          try {
            await revalidateMutationBoundary(revalidate)
            unlinkCapturedLeaseFile(temporaryPath, temporaryCapture, 'retirement claim temporary')
          } catch {
            // A same-name replacement is foreign evidence. Never delete it in
            // a finally path that no longer owns its captured inode.
          }
        }
      }
      if (acquired) {
        const published = captureRetireClaim(claimRelative)
        if (!sameRetireClaim(published.claim, claim)) throw new Error('lease retirement claim changed after publication')
        retainPendingCleanup(identity, hash, claim, published.capture, undefined, !deferBackgroundCleanup)
        return published
      }
      const existing = captureRetireClaim(claimRelative)
      if (existing.claim.scope !== identity.scope || existing.claim.lockKey !== identity.key
        || existing.claim.ownerHash !== hash) return null
      const status = await inspector.probe(existing.claim.actorPid, existing.claim.actorProcessIdentity)
      if (status !== 'dead' && status !== 'pid-reused') return null
      await revalidateMutationBoundary(revalidate)
      assertCapturedLeaseFile(files.absolute(claimRelative, 'lease retirement claim'), existing.capture, 'lease retirement claim')
      cleanupRetired(identity, hash, existing.claim, undefined, existing.capture)
      await revalidateMutationBoundary(revalidate)
      releaseRetireClaim(identity, hash, existing.claim, existing.capture)
    }
    return null
  }

  async function drainPendingCleanups(): Promise<void> {
    assertMutationBoundary()
    for (const [key, cleanup] of pendingCleanups) {
      if (foregroundRetirements.has(key)) continue
      const observed = readRetireClaimOptional(key)
      if (!observed) {
        const retired = files.absolute(
          retiredRelative(cleanup.identity, cleanup.ownerHash),
          'pending retired lease directory'
        )
        if (lstatMaybe(retired) !== null) {
          throw new Error('retired lease remains without its exact fencing claim')
        }
        pendingCleanups.delete(key)
        continue
      }
      if (!sameRetireClaim(observed, cleanup.claim)) {
        throw new Error('pending retirement claim no longer matches its exact actor facts')
      }
      fault('lease-before-pending-cleanup', {
        scope: cleanup.identity.scope,
        lockKey: cleanup.identity.key
      })
      assertMutationBoundary()
      cleanupRetired(cleanup.identity, cleanup.ownerHash, cleanup.claim, cleanup.directory, cleanup.claimProof)
      assertMutationBoundary()
      releaseRetireClaim(cleanup.identity, cleanup.ownerHash, cleanup.claim, cleanup.claimProof)
      pendingCleanups.delete(key)
    }
  }

  async function retire(
    identity: ApplicationTransactionIdentity,
    expectedOwner: OwnerIdentity,
    actorProcessIdentity: string,
    expectedRecord?: LockRecordV1,
    expectedProof?: LeaseExactProof,
    revalidate: () => Promise<unknown> = async () => {}
  ): Promise<boolean> {
    if (expectedProof) {
      const live = files.absolute(lockRelative(identity), 'lease live directory')
      assertApplicationLeaseNamespaceSafe(files.root)
      assertCapturedLeaseDirectory(live, expectedProof.directory, 'lease live directory')
      assertCapturedLeaseFile(path.join(live, OWNER_FILE), expectedProof.owner, 'lease live owner')
    }
    const hash = ownerHash(expectedOwner.ownerToken)
    const claimKey = retireClaimRelative(identity, hash)
    if (foregroundRetirements.has(claimKey)) {
      throw new Error('lease retirement is already in flight for this exact owner')
    }
    foregroundRetirements.add(claimKey)
    try {
      let claimed: CapturedRetireClaim | null
      try {
        claimed = await acquireRetireClaim(identity, hash, actorProcessIdentity, revalidate, true)
      } catch (error) {
        scheduleBackgroundReleaseDrain()
        throw error
      }
      if (!claimed) return false
      const { claim, capture: claimProof } = claimed
      retainPendingCleanup(identity, hash, claim, claimProof, undefined, false)
      try {
      const current = readRecord(identity)
      if (!current || !authorizeLockOwner(current, expectedOwner)
        || expectedRecord && !sameLockRecord(current, expectedRecord)) {
        await revalidateMutationBoundary(revalidate)
        releaseRetireClaim(identity, hash, claim, claimProof)
        pendingCleanups.delete(claimKey)
        return false
      }
      const live = files.absolute(lockRelative(identity), 'lease live directory')
      const retired = files.absolute(retiredRelative(identity, hash), 'retired lease directory')
      if (lstatMaybe(retired) !== null) {
        throw new Error('new retirement claim found a pre-existing retired directory')
      }
      let renamed = false
      let retiredDirectory: CapturedLeaseDirectory | null = null
      try {
        await revalidateMutationBoundary(revalidate)
        const confirmed = readRecord(identity)
        if (!confirmed || !authorizeLockOwner(confirmed, expectedOwner)
          || expectedRecord && !sameLockRecord(confirmed, expectedRecord)
          || lstatMaybe(retired) !== null) {
          throw new LeaseLockNotOwnedError('lease changed before retirement isolation')
        }
        if (expectedProof) {
          assertCapturedLeaseDirectory(live, expectedProof.directory, 'lease live directory')
          assertCapturedLeaseFile(path.join(live, OWNER_FILE), expectedProof.owner, 'lease live owner')
        }
        const liveDirectory = capturePlainLeaseDirectory(live, 'lease live directory')
        const liveOwner = capturePlainLeaseFile(path.join(live, OWNER_FILE), 'lease live owner')
        const liveRecord = validationReason(JSON.parse(decodeUtf8Fatal(liveOwner.bytes, 'lease live owner')))
        if (!sameLockRecord(liveRecord, confirmed)) throw new LeaseLockNotOwnedError('lease owner changed before retirement isolation')
        assertCapturedLeaseFile(
          files.absolute(claimKey, 'retirement claim before lease isolation'),
          claimProof,
          'retirement claim before lease isolation'
        )
        assertCapturedLeaseDirectory(live, liveDirectory, 'lease live directory')
        assertCapturedLeaseFile(path.join(live, OWNER_FILE), liveOwner, 'lease live owner')
        fs.renameSync(live, retired)
        renamed = true
        retiredDirectory = liveDirectory
        retainPendingCleanup(identity, hash, claim, claimProof, retiredDirectory, false)
        assertCapturedLeaseDirectory(retired, liveDirectory, 'retired lease directory')
        assertCapturedLeaseFile(path.join(retired, OWNER_FILE), liveOwner, 'retired lease owner')
        fault('lease-after-retire-rename', { scope: identity.scope, lockKey: identity.key })
        await revalidateMutationBoundary(revalidate)
        assertCapturedLeaseDirectory(retired, liveDirectory, 'retired lease directory')
        assertCapturedLeaseFile(path.join(retired, OWNER_FILE), liveOwner, 'retired lease owner')
        flushDirectory(path.dirname(live))
      } catch (error) {
        if (!renamed) {
          const code = String((error as NodeJS.ErrnoException).code)
          if (['EACCES', 'ENOENT', 'EPERM'].includes(code)) {
            await revalidateMutationBoundary(revalidate)
            releaseRetireClaim(identity, hash, claim, claimProof)
            pendingCleanups.delete(claimKey)
            return false
          }
          throw error
        }
        // Rename already removed the live lock. Continue exact cleanup even if
        // the following directory flush reported a synchronous failure.
      }
      fault('lease-before-retired-cleanup', { scope: identity.scope, lockKey: identity.key })
      await revalidateMutationBoundary(revalidate)
      if (!retiredDirectory) throw new Error('retired lease directory identity was not captured')
      cleanupRetired(identity, hash, claim, retiredDirectory, claimProof)
      await revalidateMutationBoundary(revalidate)
      releaseRetireClaim(identity, hash, claim, claimProof)
      pendingCleanups.delete(claimKey)
      try { checkpoint('lease-retired', { scope: identity.scope, lockKey: identity.key }) } catch { /* observation only */ }
      await revalidateMutationBoundary(revalidate)
      return true
      } catch (error) {
        // This process owns the claim. Keep an exact cleanup registry so a
        // transient failure is retried in the background and before the next
        // acquisition, including retirement performed by a stale-lock reaper.
        backgroundReleaseAttempt = 0
        scheduleBackgroundReleaseDrain()
        throw error
      }
    } finally {
      foregroundRetirements.delete(claimKey)
      if (pendingCleanups.has(claimKey)) scheduleBackgroundReleaseDrain()
    }
  }

  function ownerIdentity(record: LockRecordV1) {
    return {
      ownerToken: record.ownerToken,
      hostId: record.hostId,
      pid: record.pid,
      processIdentity: record.processIdentity
    }
  }

  function cleanOwnedRenewTemporaries(
    identity: ApplicationTransactionIdentity,
    owner: OwnerIdentity,
    expected: LeaseRevision
  ): void {
    assertMutationBoundary()
    const authority = assertRenewable(identity, owner, expected).record
    assertApplicationLeaseNamespaceSafe(files.root)
    for (const entry of files.list(lockRelative(identity), LOCK_DIRECTORY_MAX_ENTRIES)) {
      if (RENEW_TEMP_NAME.test(entry.name)) {
        if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('lease renewal temporary is unsafe')
        const relative = path.posix.join(lockRelative(identity), entry.name)
        const file = files.absolute(relative, 'lease renewal temporary')
        const capture = capturePlainLeaseFile(file, 'lease renewal temporary')
        const record = validationReason(JSON.parse(decodeUtf8Fatal(capture.bytes, 'lease renewal temporary')))
        if (!sameLeaseAuthority(authority, record) || record.scope !== identity.scope || record.lockKey !== identity.key) {
          throw new Error('lease renewal temporary is not owned by the renewable lease')
        }
        assertRenewable(identity, owner, expected)
        assertMutationBoundary()
        assertRenewable(identity, owner, expected)
        unlinkCapturedLeaseFile(file, capture, 'lease renewal temporary')
      }
    }
    assertMutationBoundary()
    assertRenewable(identity, owner, expected)
  }

  function assertRenewable(
    identity: ApplicationTransactionIdentity,
    owner: OwnerIdentity,
    expected?: LeaseRevision
  ): { record: LockRecordV1; observedAt: number } {
    const before = readRecord(identity)
    const observedAt = now()
    // `now` is injectable in the crash/race harness. Rebind both roots and
    // reread the exact revision after it before the caller may mutate or
    // return authority.
    preflightRoot()
    assertApplicationLeaseNamespaceSafe(files.root)
    const record = readRecord(identity)
    if (!before || !record || !sameLockRecord(before, record)
      || !authorizeLockOwner(record, owner)
      || expected && (record.heartbeatAt !== expected.heartbeatAt
        || record.leaseUntil !== expected.leaseUntil)
      || observedAt >= Date.parse(record.leaseUntil)) {
      throw new LeaseLockNotOwnedError('lease expired or changed during renewal')
    }
    return { record, observedAt }
  }

  function retainPendingRelease(
    identity: ApplicationTransactionIdentity,
    owner: OwnerIdentity,
    actorProcessIdentity: string,
    proof?: LeaseReleaseProof
  ): void {
    pendingReleases.set(owner.ownerToken, { identity, owner, actorProcessIdentity, proof })
    backgroundReleaseAttempt = 0
    scheduleBackgroundReleaseDrain()
  }

  async function releaseOwner(
    identity: ApplicationTransactionIdentity,
    owner: OwnerIdentity,
    actorProcessIdentity: string,
    proof?: LeaseReleaseProof
  ): Promise<void> {
    assertMutationBoundary()
    await drainPendingCleanups()
    assertMutationBoundary()
    const current = readRecord(identity)
    if (!current || !authorizeLockOwner(current, owner)) return
    const proofCandidates = proof ? Array.isArray(proof) ? proof : [proof] : []
    const matchingProof = proofCandidates.find((candidate) => sameLockRecord(current, candidate.record))
    if (proof && !matchingProof) throw new LeaseLockNotOwnedError('lease revision changed before exact release')
    if (matchingProof) {
      const live = files.absolute(lockRelative(identity), 'lease live directory')
      assertCapturedLeaseDirectory(live, matchingProof.directory, 'lease live directory')
      assertCapturedLeaseFile(path.join(live, OWNER_FILE), matchingProof.owner, 'lease live owner')
    }
    if (!await retire(identity, owner, actorProcessIdentity, matchingProof?.record, matchingProof)) {
      const verify = readRecord(identity)
      if (verify && authorizeLockOwner(verify, owner)) throw new LeaseLockNotOwnedError('lease retirement is contended')
    }
  }

  async function drainPendingReleases(): Promise<void> {
    if (pendingReleaseDrain) return pendingReleaseDrain
    const draining = (async () => {
      assertMutationBoundary()
      drainPendingStagingCleanups()
      await drainPendingCleanups()
      assertMutationBoundary()
      for (const [key, pending] of pendingReleases) {
        let failure: unknown
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            assertMutationBoundary()
            await releaseOwner(pending.identity, pending.owner, pending.actorProcessIdentity, pending.proof)
            assertMutationBoundary()
            failure = undefined
            break
          } catch (error) {
            failure = error
          }
        }
        if (failure) throw failure
        pendingReleases.delete(key)
      }
    })()
    pendingReleaseDrain = draining
    try {
      await draining
    } finally {
      if (pendingReleaseDrain === draining) pendingReleaseDrain = null
    }
  }

  function scheduleBackgroundReleaseDrain(): void {
    if (backgroundReleaseTimer
      || pendingReleases.size === 0
        && pendingCleanups.size === 0
        && pendingStagingCleanups.size === 0) return
    if (backgroundReleaseAttempt >= BACKGROUND_RELEASE_RETRY_DELAYS_MS.length) return
    const delay = BACKGROUND_RELEASE_RETRY_DELAYS_MS[backgroundReleaseAttempt]
    backgroundReleaseTimer = setTimeout(() => {
      backgroundReleaseTimer = null
      void drainPendingReleases().then(() => {
        backgroundReleaseAttempt = 0
      }, () => {
        backgroundReleaseAttempt += 1
        scheduleBackgroundReleaseDrain()
      })
    }, delay)
    backgroundReleaseTimer.unref()
  }

  function leaseFor(
    identity: ApplicationTransactionIdentity,
    initial: LockRecordV1,
    initialProof?: LeaseExactProof
  ): DurableLease {
    const owner = ownerIdentity(initial)
    let currentProof = initialProof
    // A replace+fsync error can leave either the prior or candidate inode
    // published. Keep that ambiguity as lease state (not merely in the
    // background map), so a later explicit release cannot overwrite and lose
    // the candidate proof.
    let currentReleaseProof: LeaseReleaseProof | undefined = initialProof
    const assertCurrentProof = () => {
      if (!currentProof) return
      const live = files.absolute(lockRelative(identity), 'lease live directory')
      assertCapturedLeaseDirectory(live, currentProof.directory, 'lease live directory')
      assertCapturedLeaseFile(path.join(live, OWNER_FILE), currentProof.owner, 'lease live owner')
      const current = readRecord(identity)
      if (!current || !sameLockRecord(current, currentProof.record)) {
        throw new LeaseLockNotOwnedError('lease exact proof changed')
      }
    }
    return {
      ownerToken: initial.ownerToken,
      async renew() {
        assertMutationBoundary()
        assertCurrentProof()
        const first = assertRenewable(identity, owner)
        const expected: LeaseRevision = {
          heartbeatAt: first.record.heartbeatAt,
          leaseUntil: first.record.leaseUntil
        }
        cleanOwnedRenewTemporaries(identity, owner, expected)
        // Token generation is outside our control and may block. Check the
        // original lease immediately before and after it.
        assertRenewable(identity, owner, expected)
        const token = files.token()
        preflightRoot()
        assertApplicationLeaseNamespaceSafe(files.root)
        assertCurrentProof()
        const beforeWrite = assertRenewable(identity, owner, expected)
        const updated = validationReason({
          ...beforeWrite.record,
          heartbeatAt: new Date(beforeWrite.observedAt).toISOString(),
          leaseUntil: new Date(beforeWrite.observedAt + options.leaseMs).toISOString()
        })
        const directory = path.posix.dirname(ownerRelative(identity))
        const liveDirectoryFile = files.absolute(lockRelative(identity), 'renewed lease directory')
        const liveDirectory = capturePlainLeaseDirectory(liveDirectoryFile, 'renewed lease directory')
        const ownerFile = files.absolute(ownerRelative(identity), 'renewed lease owner')
        const temporary = normalizeDurableRelative(path.posix.join(
          directory,
          `.owner.skill-graft-renew-${token}.tmp`
        ))
        preflightRoot()
        assertApplicationLeaseNamespaceSafe(files.root)
        files.writeExclusive(
          temporary,
          jsonBytes(updated),
          false,
          true,
          LOCK_RECORD_MAX_BYTES
        )
        const temporaryFile = files.absolute(temporary, 'lease renewal temporary')
        const temporaryCapture = capturePlainLeaseFile(temporaryFile, 'lease renewal temporary')
        const temporaryRecord = validationReason(JSON.parse(decodeUtf8Fatal(
          temporaryCapture.bytes,
          'lease renewal temporary'
        )))
        if (!sameLockRecord(temporaryRecord, updated)) throw new Error('lease renewal temporary failed exact readback')
        let replaced = false
        try {
          fault('lease-after-renew-temporary', { scope: identity.scope, lockKey: identity.key })
          assertMutationBoundary()
          assertCapturedLeaseFile(temporaryFile, temporaryCapture, 'lease renewal temporary')
          // The old expiry is checked at the last synchronous point before
          // replacement; an expired lease can never be revived.
          const beforeReplace = assertRenewable(identity, owner, expected)
          if (beforeReplace.observedAt >= Date.parse(updated.leaseUntil)) {
            throw new LeaseLockNotOwnedError('replacement lease already expired during preparation')
          }
          assertCapturedLeaseDirectory(liveDirectoryFile, liveDirectory, 'renewed lease directory')
          assertCurrentProof()
          const oldOwnerCapture = capturePlainLeaseFile(ownerFile, 'renewed lease prior owner')
          const oldOwner = validationReason(JSON.parse(decodeUtf8Fatal(oldOwnerCapture.bytes, 'renewed lease prior owner')))
          if (!sameLockRecord(oldOwner, beforeReplace.record)) {
            throw new LeaseLockNotOwnedError('renewed lease prior owner changed before replacement')
          }
          assertCapturedLeaseFile(ownerFile, oldOwnerCapture, 'renewed lease prior owner')
          const candidateProof: LeaseExactProof = {
            directory: liveDirectory,
            owner: temporaryCapture,
            record: updated
          }
          try {
            files.replace(temporary, ownerRelative(identity), false, true)
            replaced = true
          } catch (error) {
            // Replacement may already have happened even when the following
            // directory flush, temp lstat, or owner readback fails. Register
            // both exact revisions before attempting any ambiguous read so a
            // later release can retire whichever inode is truly published.
            currentReleaseProof = currentProof ? [currentProof, candidateProof] : candidateProof
            retainPendingRelease(identity, owner, initial.processIdentity, currentReleaseProof)
            // rename consumes the temporary. If a following directory fsync
            // failed, retain cleanup ownership instead of forgetting the
            // newly published record behind a false renewal failure.
            if (lstatMaybe(files.absolute(temporary, 'lease renewal temporary')) === null) {
              replaced = true
              currentProof = candidateProof
              currentReleaseProof = candidateProof
              assertCapturedLeaseDirectory(liveDirectoryFile, liveDirectory, 'renewed lease directory')
              assertCapturedLeaseFile(ownerFile, temporaryCapture, 'renewed lease owner')
              throw new LeaseLockNotOwnedError(
                `lease renewal publication could not be confirmed: ${error instanceof Error ? error.message : String(error)}`
              )
            }
            throw error
          }
          currentProof = candidateProof
          currentReleaseProof = candidateProof
          fault('lease-after-renew-replace', { scope: identity.scope, lockKey: identity.key })
          assertMutationBoundary()
          assertCapturedLeaseDirectory(liveDirectoryFile, liveDirectory, 'renewed lease directory')
          assertCapturedLeaseFile(ownerFile, temporaryCapture, 'renewed lease owner')
          const afterFault = readRecord(identity)
          if (!afterFault || !sameLockRecord(afterFault, updated)) {
            throw new LeaseLockNotOwnedError('lease renewal changed after publication')
          }
        } catch (error) {
          if (!replaced) {
            try {
              assertMutationBoundary()
              unlinkCapturedLeaseFile(temporaryFile, temporaryCapture, 'lease renewal temporary')
              flushDirectory(path.dirname(temporaryFile))
            } catch { /* preserve ownership failure */ }
          } else {
            retainPendingRelease(identity, owner, initial.processIdentity, currentReleaseProof)
          }
          throw error
        }
        let persisted: LockRecordV1 | null
        let observedAt: number
        try {
          persisted = readRecord(identity)
          observedAt = now()
        } catch (error) {
          retainPendingRelease(identity, owner, initial.processIdentity, currentReleaseProof)
          throw new LeaseLockNotOwnedError(
            `lease renewal readback failed: ${error instanceof Error ? error.message : String(error)}`
          )
        }
        if (!persisted || !authorizeLockOwner(persisted, owner)
          || persisted.heartbeatAt !== updated.heartbeatAt
          || persisted.leaseUntil !== updated.leaseUntil
          || observedAt >= Date.parse(expected.leaseUntil)
          || observedAt >= Date.parse(persisted.leaseUntil)) {
          try {
            await releaseOwner(identity, owner, initial.processIdentity, currentReleaseProof)
          } catch {
            retainPendingRelease(identity, owner, initial.processIdentity, currentReleaseProof)
          }
          throw new LeaseLockNotOwnedError('lease renewal was not durably observed')
        }
        try { checkpoint('lease-renewed', { scope: identity.scope, lockKey: identity.key }) } catch { /* observation only */ }
        assertMutationBoundary()
        assertCapturedLeaseDirectory(liveDirectoryFile, liveDirectory, 'renewed lease directory')
        assertCapturedLeaseFile(ownerFile, temporaryCapture, 'renewed lease owner')
        const finalRecord = readRecord(identity)
        const finalObservedAt = now()
        assertMutationBoundary()
        assertCapturedLeaseDirectory(liveDirectoryFile, liveDirectory, 'renewed lease directory')
        assertCapturedLeaseFile(ownerFile, temporaryCapture, 'renewed lease owner')
        const returnRecord = readRecord(identity)
        if (!finalRecord || !returnRecord || !sameLockRecord(finalRecord, updated)
          || !sameLockRecord(returnRecord, updated)
          || finalObservedAt >= Date.parse(returnRecord.leaseUntil)) {
          retainPendingRelease(identity, owner, initial.processIdentity, currentReleaseProof)
          throw new LeaseLockNotOwnedError('lease renewal changed after its completion checkpoint')
        }
      },
      async release() {
        let failure: unknown
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            await releaseOwner(identity, owner, initial.processIdentity, currentReleaseProof)
            pendingReleases.delete(initial.ownerToken)
            return
          } catch (error) {
            failure = error
          }
        }
        retainPendingRelease(identity, owner, initial.processIdentity, currentReleaseProof)
        throw failure
      }
    }
  }

  async function reapOrphanedWorktreeLeases(
    hubOwnerToken: string,
    revalidateHub: () => Promise<void> = async () => {}
  ): Promise<number> {
    if (!OWNER_TOKEN_PATTERN.test(hubOwnerToken)) throw new Error('hub lease owner token is invalid')
    const hubIdentity = {
      scope: 'hub-global',
      key: HUB_GLOBAL_LOCK_KEY,
      hostId: 'lease-recovery',
      commandKind: 'migrateState',
      requestId: 'lease-recovery'
    } as ApplicationTransactionIdentity
    const assertHubOwned = async (): Promise<LockRecordV1> => {
      await revalidateHub()
      preflightRoot()
      assertApplicationLeaseNamespaceSafe(files.root)
      const processIdentity = await inspector.currentIdentity(pid)
      await revalidateHub()
      preflightRoot()
      assertApplicationLeaseNamespaceSafe(files.root)
      const hub = readRecord(hubIdentity)
      const observedAt = now()
      if (!hub || hub.ownerToken !== hubOwnerToken || hub.pid !== pid
        || observedAt >= Date.parse(hub.leaseUntil)
        || processIdentity !== hub.processIdentity) {
        throw new Error('orphan worktree lease recovery requires the live owned hub-global lease')
      }
      return hub
    }
    await assertHubOwned()
    const candidates: ApplicationTransactionIdentity[] = []
    for (const entry of files.list(LOCKS_DIRECTORY, 10_000)) {
      const match = /^worktree-([a-f0-9]{64})\.lock$/.exec(entry.name)
      if (!match) continue
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('worktree lease recovery found an unsafe live directory')
      const owner = files.read(path.posix.join(LOCKS_DIRECTORY, entry.name, OWNER_FILE), LOCK_RECORD_MAX_BYTES)
      if (owner.status !== 'plain') throw new Error('worktree lease recovery found a missing owner record')
      const record = validationReason(JSON.parse(decodeUtf8Fatal(owner.bytes, 'worktree lease owner')))
      if (record.scope !== 'worktree' || record.lockKey !== `sha256:${match[1]}`) {
        throw new Error('worktree lease recovery found a mismatched owner record')
      }
      const identity = identityFromRecord(record)
      const observedAt = now()
      const active = evaluateLockReclaim(record, { nowEpochMs: observedAt, processStatus: 'unknown' })
      if (active.reason === 'lease-active') throw new Error('active worktree lease blocks lifecycle mutation')
      await assertHubOwned()
      const processStatus = await inspector.probe(record.pid, record.processIdentity)
      await assertHubOwned()
      const current = readRecord(identity)
      if (!current || !sameLockRecord(current, record)) {
        throw new Error('worktree lease changed during orphan recovery preflight')
      }
      const decision = evaluateLockReclaim(current, { nowEpochMs: now(), processStatus })
      if (!decision.reclaim) throw new Error('unverifiable worktree lease blocks lifecycle mutation')
      candidates.push(identity)
    }
    let reaped = 0
    for (const identity of candidates) {
      let retired = false
      for (let attempt = 0; attempt < 3 && !retired; attempt += 1) {
        const hub = await assertHubOwned()
        const current = readRecord(identity)
        if (!current) { retired = true; break }
        const active = evaluateLockReclaim(current, { nowEpochMs: now(), processStatus: 'unknown' })
        if (active.reason === 'lease-active') throw new Error('renewed worktree lease blocks lifecycle mutation')
        const processStatus = await inspector.probe(current.pid, current.processIdentity)
        await assertHubOwned()
        const confirmed = readRecord(identity)
        if (!confirmed || !sameLockRecord(confirmed, current)) continue
        const decision = evaluateLockReclaim(confirmed, { nowEpochMs: now(), processStatus })
        if (!decision.reclaim) throw new Error('unverifiable worktree lease blocks lifecycle mutation')
        if (!await retire(identity, ownerIdentity(confirmed), hub.processIdentity, confirmed, undefined, assertHubOwned)) {
          continue
        }
        await assertHubOwned()
        retired = true
        reaped += 1
      }
      if (!retired) throw new Error('worktree lease could not be revision-fenced for orphan recovery')
    }
    await assertHubOwned()
    await sweepArtifacts(assertHubOwned)
    await assertHubOwned()
    return reaped
  }

  return {
    reapOrphanedWorktreeLeases,
    async acquire(identity) {
      validateIdentity(identity)
      const ownerToken = nextToken()
      if (!OWNER_TOKEN_PATTERN.test(ownerToken)) throw new Error('lease owner token is invalid')
      const processIdentity = safeProcessIdentity(await inspector.currentIdentity(pid))
      preflightRoot()
      await bootstrapApplicationLeaseNamespace(
        files.root,
        ownerToken,
        pid,
        processIdentity,
        options.leaseMs,
        now,
        inspector,
        fault,
        preflightRoot
      )
      preflightRoot()
      assertApplicationLeaseNamespaceSafe(files.root)
      await sweepArtifacts()
      preflightRoot()
      assertApplicationLeaseNamespaceSafe(files.root)
      cleanupPublishedNamespaceTemps(files.root)
      await drainPendingReleases()
      preflightRoot()
      assertApplicationLeaseNamespaceSafe(files.root)
      await sweepArtifacts()
      preflightRoot()
      assertApplicationLeaseNamespaceSafe(files.root)

      for (let attempt = 0; attempt < 8; attempt += 1) {
        assertApplicationLeaseNamespaceSafe(files.root)
        files.ensureDirectory(LOCKS_DIRECTORY)
        assertApplicationLeaseNamespaceSafe(files.root)
        const staging = stagingRelative(identity, ownerToken)
        const stagingPath = files.absolute(staging, 'lease acquisition staging')
        const initial = recordFor(identity, ownerToken, processIdentity, now())
        preflightRoot()
        assertApplicationLeaseNamespaceSafe(files.root)
        let stagingOwned = false
        let stagingDirectory: CapturedLeaseDirectory | null = null
        try {
          fs.mkdirSync(stagingPath)
          stagingOwned = true
          stagingDirectory = capturePlainLeaseDirectory(stagingPath, 'lease acquisition staging')
          flushDirectory(path.dirname(stagingPath))
          files.writeExclusive(
            path.posix.join(staging, OWNER_FILE),
            jsonBytes(initial),
            false,
            true,
            LOCK_RECORD_MAX_BYTES
          )
          flushDirectory(stagingPath)
          const publication = tryPublishStaging(identity, staging, initial)
          if (publication.status === 'published') {
            stagingOwned = false
            const publicationProof: LeaseExactProof = {
              directory: publication.directory,
              owner: publication.owner,
              record: initial
            }
            try {
              if (publication.postPublicationError !== undefined) throw publication.postPublicationError
              preflightRoot()
              assertApplicationLeaseNamespaceSafe(files.root)
              const live = files.absolute(lockRelative(identity), 'published lease directory')
              assertCapturedLeaseDirectory(live, publication.directory, 'published lease directory')
              assertCapturedLeaseFile(path.join(live, OWNER_FILE), publication.owner, 'published lease owner')
              const published = readRecord(identity)
              if (!published || !sameLockRecord(published, initial)) {
                throw new Error('published lease changed before acquisition returned')
              }
            } catch (error) {
              try {
                await releaseOwner(identity, ownerIdentity(initial), initial.processIdentity, publicationProof)
              } catch {
                retainPendingRelease(identity, ownerIdentity(initial), initial.processIdentity, publicationProof)
              }
              throw error
            }
            try {
              const observedAt = now()
              if (observedAt >= Date.parse(initial.leaseUntil)) {
                await releaseOwner(identity, ownerIdentity(initial), initial.processIdentity, publicationProof)
                continue
              }
              assertMutationBoundary()
              const live = files.absolute(lockRelative(identity), 'published lease directory')
              assertCapturedLeaseDirectory(live, publicationProof.directory, 'published lease directory')
              assertCapturedLeaseFile(path.join(live, OWNER_FILE), publicationProof.owner, 'published lease owner')
              const finalPublished = readRecord(identity)
              if (!finalPublished || !sameLockRecord(finalPublished, initial)) {
                throw new LeaseLockNotOwnedError('published lease changed at acquisition return boundary')
              }
              return { status: 'acquired', lease: leaseFor(identity, initial, publicationProof) }
            } catch (error) {
              try {
                await releaseOwner(identity, ownerIdentity(initial), initial.processIdentity, publicationProof)
              } catch {
                retainPendingRelease(identity, ownerIdentity(initial), initial.processIdentity, publicationProof)
              }
              throw error
            }
          }
        } finally {
          if (stagingOwned) {
            try {
              fault('lease-before-acquire-staging-cleanup', {
                scope: identity.scope,
                lockKey: identity.key
              })
              preflightRoot()
              assertApplicationLeaseNamespaceSafe(files.root)
              if (!stagingDirectory) throw new Error('lease acquisition staging identity was not captured')
              removeOwnedStaging(staging, filesystemIdentity(stagingDirectory.stat), initial)
            } catch (error) {
              retainPendingStagingCleanup(staging, identity, initial)
              throw error
            }
          }
        }

        let current: LockRecordV1
        try {
          const found = readRecord(identity)
          if (!found) continue
          current = found
        } catch {
          return { status: 'busy', reason: 'invalid-owner-record' }
        }
        const time = now()
        const activeDecision = evaluateLockReclaim(current, {
          nowEpochMs: time,
          processStatus: 'unknown'
        })
        if (activeDecision.reason === 'lease-active') {
          preflightRoot()
          assertApplicationLeaseNamespaceSafe(files.root)
          return {
            status: 'busy',
            reason: activeDecision.reason,
            retryAfterMs: activeDecision.retryAfterMs
          }
        }
        const processStatus = await inspector.probe(current.pid, current.processIdentity)
        preflightRoot()
        assertApplicationLeaseNamespaceSafe(files.root)
        const decision = evaluateLockReclaim(current, { nowEpochMs: time, processStatus })
        if (!decision.reclaim) {
          preflightRoot()
          assertApplicationLeaseNamespaceSafe(files.root)
          return {
            status: 'busy',
            reason: decision.reason,
            ...('retryAfterMs' in decision ? { retryAfterMs: decision.retryAfterMs } : {})
          }
        }
        // Re-read immediately before retirement. The exclusive claim fences
        // every release/reaper for this exact owner hash; retirement then
        // verifies the owner again while that claim remains published.
        const verify = readRecord(identity)
        if (!verify || !authorizeLockOwner(verify, ownerIdentity(current))) continue
        if (!await retire(identity, ownerIdentity(current), processIdentity)) continue
      }
      preflightRoot()
      assertApplicationLeaseNamespaceSafe(files.root)
      return { status: 'busy', reason: 'lock-contention' }
    }
  }
}
