import { createHash, createHmac, randomBytes as systemRandomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  QUERY_COMMAND_KINDS,
  WRITE_COMMAND_KINDS
} from '../contracts/index.js'
import type { InvocationTraceEvent, InvocationTracePort } from '../application/ports.js'

const TRACE_FLAG = 'SKILL_GRAFT_INVOCATION_TRACE'
const REAL_E2E_FLAG = 'SKILL_GRAFT_REAL_E2E'
const RUN_ID_ENV = 'SKILL_GRAFT_RUN_ID'
const RUN_ROOT_ENV = 'SKILL_GRAFT_E2E_ROOT'
const MARKER_NAME = '.skill-graft-e2e-run.json'
const TRACE_KEY_NAME = '.invocation-trace-key'
const TRACE_DIRECTORY_NAME = 'invocation-trace'
const HANDLER_RELATIVE_PATH = ['dist', 'application', 'hub-application.js'] as const
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,95}$/
const REQUEST_HASH_PATTERN = /^hmac-sha256:v1:[a-f0-9]{64}$/
const INSTANCE_ID_PATTERN = /^[a-f0-9]{24}$/
const MAX_MARKER_BYTES = 16 * 1024
const MAX_REQUEST_ID_BYTES = 4 * 1024
const MAX_RECORD_BYTES = 1024
const REQUEST_HASH_DOMAIN = 'skill-graft:invocation-trace:request-id:v1\0'
const ENVIRONMENT_IDENTITY_DOMAIN = 'skill-graft:invocation-trace:environment:v1\0'
const HANDLER_IDENTITY = 'application.commandBus' as const
const ADAPTER_IDENTITY = 'local.invocationTrace.v1' as const
const ENVIRONMENT_IDENTITY_KEYS = [
  'PATH',
  'DSH_HOME',
  'HOME',
  'XDG_CONFIG_HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'HUB_SPAWN_CODEX',
  'HUB_ROOT',
  'SKILL_GRAFT_HOME',
  'HUB_API_PORT',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_OPTIONAL_LOCKS'
] as const

const COMMAND_KINDS = new Set<string>([...QUERY_COMMAND_KINDS, ...WRITE_COMMAND_KINDS])
const TRANSPORTS = new Set([
  'cli',
  'daemon',
  'http',
  'http-session-reap',
  'http-sse'
])

export type LocalInvocationTraceEvent = InvocationTraceEvent

export interface LocalInvocationTraceAdapter extends InvocationTracePort {
  readonly environmentIdentity: string
  readonly handlerBuildIdentity: string
  readonly processInstanceId: string
  readonly traceFile: string
  readonly traceRoot: string
  hashRequestId(requestId: string): string
  append(event: LocalInvocationTraceEvent): void
  close(): void
}

export function localInvocationEnvironmentIdentity(env: NodeJS.ProcessEnv): string {
  const allowlisted = ENVIRONMENT_IDENTITY_KEYS.map((name) => [
    name,
    typeof env[name] === 'string' ? env[name] : null
  ])
  const digest = createHash('sha256')
    .update(ENVIRONMENT_IDENTITY_DOMAIN, 'utf8')
    .update(JSON.stringify(allowlisted), 'utf8')
    .digest('hex')
  return `sha256:v1:${digest}`
}

export type LocalInvocationTraceDependencies = {
  nowIso?: () => string
  pid?: number
  ppid?: number
  randomBytes?: (size: number) => Buffer
}

export type CreateLocalInvocationTraceAdapterOptions = {
  packageRoot: string
  env?: NodeJS.ProcessEnv
  dependencies?: LocalInvocationTraceDependencies
}

export type LocalInvocationTraceGate = {
  runId: string
  runRoot: string
  logsRoot: string
  keyFile: string
}

type OwnedMarker = {
  version: number
  runId: string
  runRoot: string
}

function comparable(target: string): string {
  const resolved = path.resolve(target).replace(/[\\/]+$/, '') || path.parse(path.resolve(target)).root
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function samePath(left: string, right: string): boolean {
  return comparable(left) === comparable(right)
}

function isSameOrInside(root: string, target: string): boolean {
  const relation = path.relative(root, target)
  return relation === '' || (
    relation !== '..'
    && !relation.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relation)
  )
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (typeof value !== 'string' || !value || value !== value.trim()) {
    throw new Error(`invocation trace requires ${name}`)
  }
  return value
}

function lstatRequired(target: string, label: string): fs.Stats {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(target)
  } catch {
    throw new Error(`invocation trace ${label} is missing`)
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`invocation trace ${label} must not be a symlink or junction`)
  }
  return stat
}

function assertPlainDirectory(target: string, label: string): fs.Stats {
  const stat = lstatRequired(target, label)
  if (!stat.isDirectory()) throw new Error(`invocation trace ${label} must be a directory`)
  return stat
}

function assertPlainFile(target: string, label: string): fs.Stats {
  const stat = lstatRequired(target, label)
  if (!stat.isFile()) throw new Error(`invocation trace ${label} must be a regular file`)
  return stat
}

function canonicalInside(canonicalRoot: string, target: string, label: string): string {
  const canonicalTarget = fs.realpathSync.native(target)
  if (!isSameOrInside(comparable(canonicalRoot), comparable(canonicalTarget))) {
    throw new Error(`invocation trace ${label} escaped its owned root`)
  }
  return canonicalTarget
}

function assertNoLinkedComponents(root: string, target: string, label: string): void {
  const resolvedRoot = path.resolve(root)
  const resolvedTarget = path.resolve(target)
  if (!isSameOrInside(comparable(resolvedRoot), comparable(resolvedTarget))) {
    throw new Error(`invocation trace ${label} is outside its lexical root`)
  }
  const relation = path.relative(resolvedRoot, resolvedTarget)
  let cursor = resolvedRoot
  for (const part of relation.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part)
    if (!fs.existsSync(cursor)) break
    if (fs.lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`invocation trace ${label} crosses a symlink or junction`)
    }
  }
}

function enclosingGitCheckout(target: string): string | null {
  let cursor = target
  for (;;) {
    if (fs.existsSync(path.join(cursor, '.git'))) return cursor
    const parent = path.dirname(cursor)
    if (samePath(parent, cursor)) return null
    cursor = parent
  }
}

function readMarker(markerFile: string): OwnedMarker {
  const stat = assertPlainFile(markerFile, 'ownership marker')
  if (stat.size <= 0 || stat.size > MAX_MARKER_BYTES) {
    throw new Error('invocation trace ownership marker has an invalid size')
  }
  let marker: unknown
  try {
    marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'))
  } catch {
    throw new Error('invocation trace ownership marker is invalid JSON')
  }
  if (!marker || typeof marker !== 'object') {
    throw new Error('invocation trace ownership marker must be an object')
  }
  const owned = marker as Partial<OwnedMarker>
  if (owned.version !== 1 || typeof owned.runId !== 'string' || typeof owned.runRoot !== 'string') {
    throw new Error('invocation trace ownership marker has an invalid schema')
  }
  return owned as OwnedMarker
}

function sha256File(file: string): string {
  const hash = createHash('sha256')
  const descriptor = fs.openSync(file, 'r')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  try {
    for (;;) {
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null)
      if (bytes === 0) break
      hash.update(buffer.subarray(0, bytes))
    }
  } finally {
    fs.closeSync(descriptor)
  }
  return hash.digest('hex')
}

function writeAll(descriptor: number, value: Buffer): void {
  let offset = 0
  while (offset < value.length) {
    const written = fs.writeSync(descriptor, value, offset, value.length - offset)
    if (written <= 0) throw new Error('invocation trace JSONL write made no progress')
    offset += written
  }
  fs.fsyncSync(descriptor)
}

function validIso(value: string): boolean {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function normalizeTransport(value: string): string {
  return TRANSPORTS.has(value) ? value : 'other'
}

function assertSafeEvent(event: LocalInvocationTraceEvent): void {
  if (!event || typeof event !== 'object') throw new Error('invocation trace event must be an object')
  if (event.phase !== 'entry' && event.phase !== 'result') throw new Error('invocation trace phase is invalid')
  if (!Number.isSafeInteger(event.sequence) || event.sequence <= 0) {
    throw new Error('invocation trace sequence is invalid')
  }
  if (typeof event.transport !== 'string') throw new Error('invocation trace transport is invalid')
  if (!COMMAND_KINDS.has(event.commandKind)) throw new Error('invocation trace command kind is invalid')
  if (!REQUEST_HASH_PATTERN.test(event.requestHash)) throw new Error('invocation trace request hash is invalid')
  if (event.handlerIdentity !== HANDLER_IDENTITY) throw new Error('invocation trace handler identity is invalid')
  if (event.phase === 'result' && (typeof event.ok !== 'boolean' || typeof event.replayed !== 'boolean')) {
    throw new Error('invocation trace result flags are invalid')
  }
}

/**
 * Resolve and validate the complete opt-in gate without opening a trace file.
 * Detached launchers use this result only to pin the four public gate values;
 * the HMAC key remains a marker-owned file and is never copied into a command.
 */
export function resolveLocalInvocationTraceGate(
  env: NodeJS.ProcessEnv = process.env
): LocalInvocationTraceGate | undefined {
  const requested = env[TRACE_FLAG]
  if (requested === undefined || requested === '' || requested === '0') return undefined
  if (requested !== '1') throw new Error(`${TRACE_FLAG} must be 0 or 1`)
  if (env[REAL_E2E_FLAG] !== '1') {
    throw new Error(`invocation trace requires ${REAL_E2E_FLAG}=1`)
  }

  const runId = requiredEnv(env, RUN_ID_ENV)
  if (!RUN_ID_PATTERN.test(runId)) throw new Error(`${RUN_ID_ENV} is invalid for invocation trace`)
  const rawRunRoot = requiredEnv(env, RUN_ROOT_ENV)
  if (!path.isAbsolute(rawRunRoot)) throw new Error(`${RUN_ROOT_ENV} must be absolute for invocation trace`)
  const runRoot = path.resolve(rawRunRoot)
  if (!samePath(path.basename(runRoot), runId)) {
    throw new Error('invocation trace run root basename must equal its run id')
  }
  if (samePath(runRoot, path.parse(runRoot).root)) {
    throw new Error('invocation trace run root cannot be a drive or filesystem root')
  }

  assertPlainDirectory(runRoot, 'run root')
  const canonicalRunRoot = fs.realpathSync.native(runRoot)
  const gitCheckout = enclosingGitCheckout(canonicalRunRoot)
  if (gitCheckout) throw new Error('invocation trace run root must not be inside a Git checkout')

  const markerFile = path.join(runRoot, MARKER_NAME)
  assertNoLinkedComponents(runRoot, markerFile, 'ownership marker')
  const marker = readMarker(markerFile)
  canonicalInside(canonicalRunRoot, markerFile, 'ownership marker')
  if (marker.runId !== runId || !path.isAbsolute(marker.runRoot) || !samePath(marker.runRoot, runRoot)) {
    throw new Error('invocation trace ownership marker does not own this run root')
  }

  const logsRoot = path.join(runRoot, 'logs')
  assertNoLinkedComponents(runRoot, logsRoot, 'logs root')
  assertPlainDirectory(logsRoot, 'logs root')
  const canonicalLogsRoot = canonicalInside(canonicalRunRoot, logsRoot, 'logs root')

  const keyFile = path.join(logsRoot, TRACE_KEY_NAME)
  assertNoLinkedComponents(logsRoot, keyFile, 'HMAC key')
  const keyStat = assertPlainFile(keyFile, 'HMAC key')
  if (keyStat.size !== 32) throw new Error('invocation trace HMAC key must contain exactly 32 bytes')
  canonicalInside(canonicalLogsRoot, keyFile, 'HMAC key')

  return { runId, runRoot, logsRoot, keyFile }
}

export function createLocalInvocationTraceAdapter(
  options: CreateLocalInvocationTraceAdapterOptions
): LocalInvocationTraceAdapter | undefined {
  const env = options.env || process.env
  const gate = resolveLocalInvocationTraceGate(env)
  if (!gate) return undefined
  const { runRoot, logsRoot, keyFile } = gate
  const canonicalRunRoot = fs.realpathSync.native(runRoot)
  const canonicalLogsRoot = canonicalInside(canonicalRunRoot, logsRoot, 'logs root')
  const keyStat = assertPlainFile(keyFile, 'HMAC key')
  if (keyStat.size !== 32) throw new Error('invocation trace HMAC key must contain exactly 32 bytes')
  canonicalInside(canonicalLogsRoot, keyFile, 'HMAC key')

  const appRoot = path.join(runRoot, 'app')
  assertNoLinkedComponents(runRoot, appRoot, 'app root')
  assertPlainDirectory(appRoot, 'app root')
  const canonicalAppRoot = canonicalInside(canonicalRunRoot, appRoot, 'app root')
  const packageRoot = path.resolve(options.packageRoot)
  assertNoLinkedComponents(appRoot, packageRoot, 'package root')
  assertPlainDirectory(packageRoot, 'package root')
  const canonicalPackageRoot = canonicalInside(canonicalAppRoot, packageRoot, 'package root')
  const handlerFile = path.join(packageRoot, ...HANDLER_RELATIVE_PATH)
  assertNoLinkedComponents(packageRoot, handlerFile, 'Application handler')
  assertPlainFile(handlerFile, 'Application handler')
  canonicalInside(canonicalPackageRoot, handlerFile, 'Application handler')
  const handlerBuildIdentity = `sha256:${sha256File(handlerFile)}`
  const environmentIdentity = localInvocationEnvironmentIdentity(env)

  const traceRoot = path.join(logsRoot, TRACE_DIRECTORY_NAME)
  if (!fs.existsSync(traceRoot)) {
    try {
      fs.mkdirSync(traceRoot, { recursive: false, mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  assertNoLinkedComponents(logsRoot, traceRoot, 'trace root')
  assertPlainDirectory(traceRoot, 'trace root')
  const canonicalTraceRoot = canonicalInside(canonicalLogsRoot, traceRoot, 'trace root')

  const pid = options.dependencies?.pid ?? process.pid
  const ppid = options.dependencies?.ppid ?? process.ppid
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || ppid < 0) {
    throw new Error('invocation trace process identity is invalid')
  }
  const randomBytes = options.dependencies?.randomBytes || systemRandomBytes
  const processInstanceId = randomBytes(12).toString('hex')
  if (!INSTANCE_ID_PATTERN.test(processInstanceId)) {
    throw new Error('invocation trace process instance id is invalid')
  }
  const traceFile = path.join(traceRoot, `${pid}-${processInstanceId}.jsonl`)
  assertNoLinkedComponents(traceRoot, traceFile, 'JSONL file')

  const key = fs.readFileSync(keyFile)
  let descriptor: number | undefined
  try {
    descriptor = fs.openSync(traceFile, 'wx', 0o600)
    const fileStat = fs.fstatSync(descriptor)
    if (!fileStat.isFile()) throw new Error('invocation trace JSONL target is not a regular file')
    const canonicalTraceFile = fs.realpathSync.native(traceFile)
    if (!isSameOrInside(comparable(canonicalTraceRoot), comparable(canonicalTraceFile))) {
      throw new Error('invocation trace JSONL file escaped its trace root')
    }
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    key.fill(0)
    throw error
  }

  const nowIso = options.dependencies?.nowIso || (() => new Date().toISOString())
  let closed = false
  return {
    environmentIdentity,
    handlerBuildIdentity,
    processInstanceId,
    traceFile,
    traceRoot,
    hashRequestId(requestId) {
      if (closed) throw new Error('invocation trace adapter is closed')
      if (typeof requestId !== 'string' || !requestId || Buffer.byteLength(requestId, 'utf8') > MAX_REQUEST_ID_BYTES) {
        throw new Error('invocation trace request id is invalid')
      }
      const digest = createHmac('sha256', key)
        .update(REQUEST_HASH_DOMAIN, 'utf8')
        .update(requestId, 'utf8')
        .digest('hex')
      return `hmac-sha256:v1:${digest}`
    },
    append(event) {
      if (closed || descriptor === undefined) throw new Error('invocation trace adapter is closed')
      assertSafeEvent(event)
      const at = nowIso()
      if (!validIso(at)) throw new Error('invocation trace timestamp is invalid')
      const common = {
        schemaVersion: 1,
        at,
        phase: event.phase,
        sequence: event.sequence,
        transport: normalizeTransport(event.transport),
        commandKind: event.commandKind,
        requestHash: event.requestHash,
        handlerIdentity: HANDLER_IDENTITY,
        handlerBuildIdentity,
        environmentIdentity,
        adapterIdentity: ADAPTER_IDENTITY,
        processInstanceId,
        pid,
        ppid
      }
      const record = event.phase === 'result'
        ? { ...common, ok: event.ok, replayed: event.replayed }
        : common
      const line = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8')
      if (line.length > MAX_RECORD_BYTES) throw new Error('invocation trace record exceeds its size limit')
      writeAll(descriptor, line)
    },
    close() {
      if (closed) return
      closed = true
      if (descriptor !== undefined) {
        fs.closeSync(descriptor)
        descriptor = undefined
      }
      key.fill(0)
    }
  }
}
