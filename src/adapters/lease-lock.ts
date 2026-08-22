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

export interface LeaseProcessInspector {
  currentIdentity(pid: number): Promise<string>
  probe(pid: number, expectedIdentity: string): Promise<LockOwnerProbeStatus>
}

export type LeaseLockManagerOptions = {
  root: string
  leaseMs: number
  now?: () => number
  token?: () => string
  pid?: number
  processInspector?: LeaseProcessInspector
  checkpoint?: DurableCheckpoint
  fault?: DurableCheckpoint
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

export function createLeaseLockManager(options: LeaseLockManagerOptions): DurableTransactionLockPort {
  if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs < 1) {
    throw new Error('leaseMs must be a positive safe integer')
  }
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
  }>()
  const pendingStagingCleanups = new Map<string, {
    identity: ApplicationTransactionIdentity
    expected: LockRecordV1
  }>()
  const pendingReleases = new Map<string, {
    identity: ApplicationTransactionIdentity
    owner: OwnerIdentity
    actorProcessIdentity: string
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
    observedIdentity?: FilesystemIdentity
  ): void {
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
      let removed: boolean
      try {
        removed = files.removeIfPlain(path.posix.join(relativeDirectory, entry.name))
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
      if (!removed) {
        removeDirectoryAndProveGone()
        return
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
      removeOwnedStaging(relative, removalIdentity)
      pendingStagingCleanups.delete(relative)
    }
  }

  async function sweepArtifacts(): Promise<void> {
    const entries = files.list(LOCKS_DIRECTORY, 10_000)
    const names = new Set(entries.map((entry) => entry.name))
    for (const entry of entries) {
      const retired = /^\.retired-((?:hub-global|worktree-[a-f0-9]{64})\.lock)-([a-f0-9]{64})\.tmp$/.exec(entry.name)
      if (retired) {
        const matchingClaim = `.retire-${retired[1]}-${retired[2]}.claim.json`
        if (!names.has(matchingClaim)) {
          throw new Error('retired lease artifact is missing its fencing claim')
        }
      }
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
        if (status === 'dead' || status === 'pid-reused') {
          removeOwnedStaging(relative, observed.directoryIdentity)
        }
        continue
      }
      if (/^\.retire-(?:hub-global|worktree-[a-f0-9]{64})\.lock-[a-f0-9]{64}\.claim\.json$/.test(entry.name)) {
        if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('lease retirement claim is unsafe')
        const claim = readRetireClaim(relative)
        const identity = identityFromClaim(claim)
        if (path.posix.basename(retireClaimRelative(identity, claim.ownerHash)) !== entry.name) {
          throw new Error('lease retirement claim name is inconsistent')
        }
        const status = await inspector.probe(claim.actorPid, claim.actorProcessIdentity)
        if (status === 'dead' || status === 'pid-reused') {
          cleanupRetired(identity, claim.ownerHash)
          files.removeIfPlain(relative)
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
        if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('retirement claim temporary is unsafe')
        const stat = fs.lstatSync(files.absolute(relative, 'retirement claim temporary'))
        if (now() - stat.mtimeMs >= options.leaseMs) files.removeIfPlain(relative)
        continue
      }
      throw new Error(`unexpected lease artifact: ${entry.name}`)
    }
  }

  function tryPublishStaging(
    identity: ApplicationTransactionIdentity,
    staging: string,
    expected: LockRecordV1
  ): 'published' | 'contended' | 'expired-before-rename' {
    if (now() >= Date.parse(expected.leaseUntil)) return 'expired-before-rename'
    const source = files.absolute(staging, 'lease acquisition staging')
    const target = files.absolute(lockRelative(identity), 'lease live directory')
    try {
      fs.renameSync(source, target)
    } catch (error) {
      const code = String((error as NodeJS.ErrnoException).code)
      if (!['EACCES', 'EEXIST', 'ENOTEMPTY', 'EPERM'].includes(code)) throw error
      return 'contended'
    }
    // A successful directory rename is the acquisition truth. Returning a
    // false failure after this point would forget a live owner in this process.
    // Observation/fsync failures are therefore contained; the returned lease
    // and its retained release queue own cleanup from here.
    try { fault('lease-after-live-rename', { scope: identity.scope, lockKey: identity.key }) } catch { /* renamed truth */ }
    try { flushDirectory(path.dirname(target)) } catch { /* renamed truth */ }
    try { fault('lease-after-live-directory-flush', { scope: identity.scope, lockKey: identity.key }) } catch { /* renamed truth */ }
    try { checkpoint('lease-acquired', { scope: identity.scope, lockKey: identity.key }) } catch { /* observation only */ }
    return 'published'
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
    claim: RetireClaim
  ): void {
    const claimKey = retireClaimRelative(identity, hash)
    pendingCleanups.set(claimKey, {
      identity,
      ownerHash: hash,
      claim
    })
    backgroundReleaseAttempt = 0
    scheduleBackgroundReleaseDrain()
  }

  function cleanupRetired(
    identity: ApplicationTransactionIdentity,
    hash: `sha256:${string}`
  ): void {
    const relative = retiredRelative(identity, hash)
    const absolute = files.absolute(relative, 'retired lease directory')
    const stat = lstatMaybe(absolute)
    if (!stat) return
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('retired lease artifact is not a plain directory')
    }
    for (const entry of files.list(relative, LOCK_DIRECTORY_MAX_ENTRIES)) {
      const allowedRenew = /^\.owner\.skill-graft-renew-[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.tmp$/.test(entry.name)
      if (entry.isSymbolicLink() || !entry.isFile()
        || entry.name !== OWNER_FILE && !allowedRenew) {
        throw new Error('retired lease contains an unexpected artifact')
      }
      files.removeIfPlain(path.posix.join(relative, entry.name))
    }
    fs.rmdirSync(absolute)
    flushDirectory(path.dirname(absolute))
  }

  function releaseRetireClaim(
    identity: ApplicationTransactionIdentity,
    hash: `sha256:${string}`
  ): void {
    files.removeIfPlain(retireClaimRelative(identity, hash))
  }

  async function acquireRetireClaim(
    identity: ApplicationTransactionIdentity,
    hash: `sha256:${string}`,
    actorProcessIdentity: string
  ): Promise<RetireClaim | null> {
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
      const temporary = normalizeDurableRelative(path.posix.join(
        LOCKS_DIRECTORY,
        `.retire-claim-${files.token()}.tmp`
      ))
      files.writeExclusive(temporary, jsonBytes(claim), false, true, LOCK_RECORD_MAX_BYTES)
      const temporaryPath = files.absolute(temporary, 'retirement claim temporary')
      const claimPath = files.absolute(claimRelative, 'retirement claim')
      let acquired = false
      let linked = false
      try {
        fs.linkSync(temporaryPath, claimPath)
        linked = true
        // The hard-link publication is the claim truth. Register its exact
        // actor/owner facts before any readback, flush, or injected failure.
        retainPendingCleanup(identity, hash, claim)
        try {
          files.removeIfPlain(temporary)
        } catch (cleanupError) {
          if (lstatMaybe(temporaryPath) !== null) throw cleanupError
        }
        fault('lease-after-retire-claim-link', {
          scope: identity.scope,
          lockKey: identity.key
        })
        flushDirectory(path.dirname(claimPath))
        acquired = true
      } catch (error) {
        if (linked) {
          // Drop our staging link before reading the published claim: all
          // DurableFileRoot reads require a single-link file identity.
          try {
            files.removeIfPlain(temporary)
          } catch (cleanupError) {
            if (lstatMaybe(temporaryPath) !== null) throw cleanupError
          }
          fault('lease-before-retire-claim-readback', {
            scope: identity.scope,
            lockKey: identity.key
          })
          const observed = readRetireClaim(claimRelative)
          if (observed.actorPid === claim.actorPid
            && observed.actorProcessIdentity === claim.actorProcessIdentity
            && observed.scope === claim.scope
            && observed.lockKey === claim.lockKey
            && observed.ownerHash === claim.ownerHash) {
            acquired = true
          } else {
            throw error
          }
        } else if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error
        }
      } finally {
        files.removeIfPlain(temporary)
      }
      if (acquired) return claim
      const existing = readRetireClaim(claimRelative)
      if (existing.scope !== identity.scope || existing.lockKey !== identity.key
        || existing.ownerHash !== hash) return null
      const status = await inspector.probe(existing.actorPid, existing.actorProcessIdentity)
      if (status !== 'dead' && status !== 'pid-reused') return null
      cleanupRetired(identity, hash)
      files.removeIfPlain(claimRelative)
    }
    return null
  }

  async function drainPendingCleanups(): Promise<void> {
    for (const [key, cleanup] of pendingCleanups) {
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
      cleanupRetired(cleanup.identity, cleanup.ownerHash)
      releaseRetireClaim(cleanup.identity, cleanup.ownerHash)
      pendingCleanups.delete(key)
    }
  }

  async function retire(
    identity: ApplicationTransactionIdentity,
    expectedOwner: OwnerIdentity,
    actorProcessIdentity: string
  ): Promise<boolean> {
    const hash = ownerHash(expectedOwner.ownerToken)
    const claim = await acquireRetireClaim(identity, hash, actorProcessIdentity)
    if (!claim) return false
    const claimKey = retireClaimRelative(identity, hash)
    retainPendingCleanup(identity, hash, claim)
    try {
      const current = readRecord(identity)
      if (!current || !authorizeLockOwner(current, expectedOwner)) {
        releaseRetireClaim(identity, hash)
        pendingCleanups.delete(claimKey)
        return false
      }
      cleanupRetired(identity, hash)
      const live = files.absolute(lockRelative(identity), 'lease live directory')
      const retired = files.absolute(retiredRelative(identity, hash), 'retired lease directory')
      let renamed = false
      try {
        fs.renameSync(live, retired)
        renamed = true
        fault('lease-after-retire-rename', { scope: identity.scope, lockKey: identity.key })
        flushDirectory(path.dirname(live))
      } catch (error) {
        if (!renamed) {
          const code = String((error as NodeJS.ErrnoException).code)
          if (['EACCES', 'ENOENT', 'EPERM'].includes(code)) {
            releaseRetireClaim(identity, hash)
            pendingCleanups.delete(claimKey)
            return false
          }
          throw error
        }
        // Rename already removed the live lock. Continue exact cleanup even if
        // the following directory flush reported a synchronous failure.
      }
      fault('lease-before-retired-cleanup', { scope: identity.scope, lockKey: identity.key })
      cleanupRetired(identity, hash)
      releaseRetireClaim(identity, hash)
      pendingCleanups.delete(claimKey)
      try { checkpoint('lease-retired', { scope: identity.scope, lockKey: identity.key }) } catch { /* observation only */ }
      return true
    } catch (error) {
      // This process owns the claim. Keep an exact cleanup registry so a
      // transient failure is retried in the background and before the next
      // acquisition, including retirement performed by a stale-lock reaper.
      backgroundReleaseAttempt = 0
      scheduleBackgroundReleaseDrain()
      throw error
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
    assertRenewable(identity, owner, expected)
    for (const entry of files.list(lockRelative(identity), LOCK_DIRECTORY_MAX_ENTRIES)) {
      if (/^\.owner\.skill-graft-renew-[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.tmp$/.test(entry.name)) {
        assertRenewable(identity, owner, expected)
        files.removeIfPlain(path.posix.join(lockRelative(identity), entry.name))
      }
    }
    assertRenewable(identity, owner, expected)
  }

  function assertRenewable(
    identity: ApplicationTransactionIdentity,
    owner: OwnerIdentity,
    expected?: LeaseRevision
  ): { record: LockRecordV1; observedAt: number } {
    const record = readRecord(identity)
    const observedAt = now()
    if (!record || !authorizeLockOwner(record, owner)
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
    actorProcessIdentity: string
  ): void {
    pendingReleases.set(owner.ownerToken, { identity, owner, actorProcessIdentity })
    backgroundReleaseAttempt = 0
    scheduleBackgroundReleaseDrain()
  }

  async function releaseOwner(
    identity: ApplicationTransactionIdentity,
    owner: OwnerIdentity,
    actorProcessIdentity: string
  ): Promise<void> {
    await drainPendingCleanups()
    const current = readRecord(identity)
    if (!current || !authorizeLockOwner(current, owner)) return
    if (!await retire(identity, owner, actorProcessIdentity)) {
      const verify = readRecord(identity)
      if (verify && authorizeLockOwner(verify, owner)) throw new LeaseLockNotOwnedError('lease retirement is contended')
    }
  }

  async function drainPendingReleases(): Promise<void> {
    if (pendingReleaseDrain) return pendingReleaseDrain
    const draining = (async () => {
      drainPendingStagingCleanups()
      await drainPendingCleanups()
      for (const [key, pending] of pendingReleases) {
        let failure: unknown
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            await releaseOwner(pending.identity, pending.owner, pending.actorProcessIdentity)
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

  function leaseFor(identity: ApplicationTransactionIdentity, initial: LockRecordV1): DurableLease {
    const owner = ownerIdentity(initial)
    return {
      ownerToken: initial.ownerToken,
      async renew() {
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
        const beforeWrite = assertRenewable(identity, owner, expected)
        const updated = validationReason({
          ...beforeWrite.record,
          heartbeatAt: new Date(beforeWrite.observedAt).toISOString(),
          leaseUntil: new Date(beforeWrite.observedAt + options.leaseMs).toISOString()
        })
        const directory = path.posix.dirname(ownerRelative(identity))
        const temporary = normalizeDurableRelative(path.posix.join(
          directory,
          `.owner.skill-graft-renew-${token}.tmp`
        ))
        files.writeExclusive(
          temporary,
          jsonBytes(updated),
          false,
          true,
          LOCK_RECORD_MAX_BYTES
        )
        let replaced = false
        try {
          fault('lease-after-renew-temporary', { scope: identity.scope, lockKey: identity.key })
          // The old expiry is checked at the last synchronous point before
          // replacement; an expired lease can never be revived.
          const beforeReplace = assertRenewable(identity, owner, expected)
          if (beforeReplace.observedAt >= Date.parse(updated.leaseUntil)) {
            throw new LeaseLockNotOwnedError('replacement lease already expired during preparation')
          }
          try {
            files.replace(temporary, ownerRelative(identity), false, true)
            replaced = true
          } catch (error) {
            // rename consumes the temporary. If a following directory fsync
            // failed, retain cleanup ownership instead of forgetting the
            // newly published record behind a false renewal failure.
            if (lstatMaybe(files.absolute(temporary, 'lease renewal temporary')) === null) {
              replaced = true
              throw new LeaseLockNotOwnedError(
                `lease renewal publication could not be confirmed: ${error instanceof Error ? error.message : String(error)}`
              )
            }
            throw error
          }
          fault('lease-after-renew-replace', { scope: identity.scope, lockKey: identity.key })
        } catch (error) {
          if (!replaced) {
            try { files.removeIfPlain(temporary) } catch { /* preserve ownership failure */ }
          } else {
            retainPendingRelease(identity, owner, initial.processIdentity)
          }
          throw error
        }
        let persisted: LockRecordV1 | null
        let observedAt: number
        try {
          persisted = readRecord(identity)
          observedAt = now()
        } catch (error) {
          retainPendingRelease(identity, owner, initial.processIdentity)
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
            await releaseOwner(identity, owner, initial.processIdentity)
          } catch {
            retainPendingRelease(identity, owner, initial.processIdentity)
          }
          throw new LeaseLockNotOwnedError('lease renewal was not durably observed')
        }
        try { checkpoint('lease-renewed', { scope: identity.scope, lockKey: identity.key }) } catch { /* observation only */ }
      },
      async release() {
        let failure: unknown
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            await releaseOwner(identity, owner, initial.processIdentity)
            pendingReleases.delete(initial.ownerToken)
            return
          } catch (error) {
            failure = error
          }
        }
        retainPendingRelease(identity, owner, initial.processIdentity)
        throw failure
      }
    }
  }

  return {
    async acquire(identity) {
      validateIdentity(identity)
      const ownerToken = nextToken()
      if (!OWNER_TOKEN_PATTERN.test(ownerToken)) throw new Error('lease owner token is invalid')
      const processIdentity = safeProcessIdentity(await inspector.currentIdentity(pid))
      await drainPendingReleases()
      await sweepArtifacts()

      for (let attempt = 0; attempt < 8; attempt += 1) {
        files.ensureDirectory(LOCKS_DIRECTORY)
        const staging = stagingRelative(identity, ownerToken)
        const stagingPath = files.absolute(staging, 'lease acquisition staging')
        const initial = recordFor(identity, ownerToken, processIdentity, now())
        let stagingOwned = false
        try {
          fs.mkdirSync(stagingPath)
          stagingOwned = true
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
          if (publication === 'published') {
            stagingOwned = false
            let observedAt: number
            try {
              observedAt = now()
            } catch (error) {
              try {
                await releaseOwner(identity, ownerIdentity(initial), initial.processIdentity)
              } catch {
                retainPendingRelease(identity, ownerIdentity(initial), initial.processIdentity)
              }
              throw error
            }
            if (observedAt >= Date.parse(initial.leaseUntil)) {
              try {
                await releaseOwner(identity, ownerIdentity(initial), initial.processIdentity)
              } catch (error) {
                retainPendingRelease(identity, ownerIdentity(initial), initial.processIdentity)
                await drainPendingReleases().catch(() => { throw error })
              }
              continue
            }
            return { status: 'acquired', lease: leaseFor(identity, initial) }
          }
        } finally {
          if (stagingOwned) {
            try {
              fault('lease-before-acquire-staging-cleanup', {
                scope: identity.scope,
                lockKey: identity.key
              })
              removeOwnedStaging(staging)
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
          return {
            status: 'busy',
            reason: activeDecision.reason,
            retryAfterMs: activeDecision.retryAfterMs
          }
        }
        const processStatus = await inspector.probe(current.pid, current.processIdentity)
        const decision = evaluateLockReclaim(current, { nowEpochMs: time, processStatus })
        if (!decision.reclaim) {
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
      return { status: 'busy', reason: 'lock-contention' }
    }
  }
}
