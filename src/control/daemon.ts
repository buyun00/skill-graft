import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import type { Server as HttpServer } from 'node:http'
import { createConnection } from 'node:net'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHub } from '../adapters/create-hub.js'
import { API_PORT } from '../local/lifecycle/install-domain.js'
import { createLocalHost, type LocalHost } from '../local/create-local-host.js'
import { resolveLocalDataRoot } from '../local/data-root.js'
import { createCodexSessionRunner } from '../local/session/codex-session-runner.js'
import { createInstallHost, type InstallHost } from '../adapters/install-host.js'
import {
  createDaemonProcessHost,
  type DaemonProcessHost
} from '../adapters/daemon-process-host.js'
import type {
  DaemonProtocolCheckpoint,
  DaemonReceiptAuthorityReader
} from './daemon-protocol.js'
import { assertDaemonInspectionCurrent } from './daemon-protocol.js'
import {
  commitDaemonRuntimeStart,
  createDaemonRuntimeReconcilePort,
  observeDaemonAuthority,
  reconcileDaemonRuntimeForStart,
  type DaemonRunningObservation,
  type DaemonRuntimeReconcileResult,
  type DaemonRuntimeHealthProbe,
  type DaemonRuntimeStartCandidate
} from './daemon-runtime.js'

export type DaemonRunOptions = {
  packageRoot?: string
  dataRoot?: string
  /** @deprecated use packageRoot; retained for the Local lifecycle compatibility surface. */
  hubRoot: string
  port?: number
  intervalMs?: number
  host?: InstallHost
  /** HOME namespace already frozen by the lifecycle composition root. */
  home?: string
  /** Narrow lifecycle receipt reader; required by the v1 daemon protocol. */
  readReceiptAuthority?: DaemonReceiptAuthorityReader
  /** Exact host facts/control seam. Production uses the local OS adapter. */
  processHost?: DaemonProcessHost
  /** Durable protocol checkpoint seam used by kill-cut tests. */
  protocolCheckpoint?: DaemonProtocolCheckpoint
  /** Internal transport seam used to prove startup cleanup without a child API process. */
  httpModule?: HttpTransportModule
  /** Awaitable readiness checkpoint that still runs under the startup authority. */
  onStartupReady?: () => void | Promise<void>
  /** Revalidates the frozen lifecycle/static authority at startup checkpoints. */
  onStartupRevalidate?: () => void
  /** Releases the lifecycle startup authority around its own static/terminal/static seal. */
  releaseStartupAuthority?: (terminalSeal: () => void | Promise<void>) => void | Promise<void>
}

export type ApiInstanceExpectation = {
  packageRoot?: string
  dataRoot?: string
  daemonEpoch?: string
}

export type DaemonInstanceBinding = {
  pid: number
  apiPid: number
  packageRoot: string
  dataRoot: string
  port: number
}

export const API_PACKAGE_ROOT_HEADER = 'x-skill-graft-package-root'
export const API_DATA_ROOT_HEADER = 'x-skill-graft-data-root'
export const API_DAEMON_EPOCH_HEADER = 'x-skill-graft-daemon-epoch'
const DAEMON_EPOCH = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const DAEMON_STOP_TIMEOUT_MS = 5000
const DAEMON_LOG_MAX_BYTES = 2_000_000

export function reviewFiles(dataRoot: string) {
  const review = join(dataRoot, 'skill-review')
  return {
    review,
    pidFile: join(review, 'daemon.pid'),
    apiPidFile: join(review, 'api.pid'),
    heartbeatFile: join(review, 'daemon-heartbeat.json'),
    logFile: join(review, 'daemon.log')
  }
}

export function readPid(file: string): number {
  try {
    const n = Number(String(fs.readFileSync(file, 'utf8')).trim())
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

export function readHeartbeat(dataRoot: string): Record<string, unknown> | null {
  const file = reviewFiles(dataRoot).heartbeatFile
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

export async function pingApi(
  port: number,
  timeoutMs = 1500,
  expected: ApiInstanceExpectation = {}
): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return false
    const body = await res.json() as { ok?: unknown }
    return body?.ok === true && apiHeadersMatch(res.headers, expected)
  } catch {
    return false
  }
}

export type DaemonApiHealthFacts =
  | Readonly<{ state: 'exact'; epochId: string; packageRoot: string; dataRoot: string }>
  | Readonly<{ state: 'foreign' | 'unknown' }>

function decodedAbsoluteHeader(headers: Pick<Headers, 'get'>, name: string): string | null {
  const raw = headers.get(name)
  if (!raw) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return null
  }
  return isAbsolute(decoded) ? resolve(decoded) : null
}

/**
 * Returns the health authority actually advertised by the listener.  An HTTP
 * response with malformed or mismatched daemon metadata is foreign evidence;
 * transport failure remains unknown because fetch cannot prove process death.
 */
export async function probeDaemonApiHealth(
  port: number,
  timeoutMs = 1500
): Promise<DaemonApiHealthFacts> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { connection: 'close' },
      signal: AbortSignal.timeout(timeoutMs)
    })
    const text = await response.text()
    if (!response.ok || Buffer.byteLength(text) > 64 * 1024) {
      return Object.freeze({ state: 'foreign' as const })
    }
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      return Object.freeze({ state: 'foreign' as const })
    }
    const epochId = response.headers.get(API_DAEMON_EPOCH_HEADER) || ''
    const packageRoot = decodedAbsoluteHeader(response.headers, API_PACKAGE_ROOT_HEADER)
    const dataRoot = decodedAbsoluteHeader(response.headers, API_DATA_ROOT_HEADER)
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || (body as { ok?: unknown }).ok !== true || !DAEMON_EPOCH.test(epochId)
      || !packageRoot || !dataRoot) {
      return Object.freeze({ state: 'foreign' as const })
    }
    return Object.freeze({ state: 'exact' as const, epochId, packageRoot, dataRoot })
  } catch {
    return Object.freeze({ state: 'unknown' as const })
  }
}

export async function waitForApi(
  port: number,
  timeoutMs = 8000,
  expected: ApiInstanceExpectation = {}
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await pingApi(port, 1500, expected)) return true
    await sleep(250)
  }
  return pingApi(port, 1500, expected)
}

export function apiHeadersMatch(headers: Pick<Headers, 'get'>, expected: ApiInstanceExpectation): boolean {
  return headerPathMatches(headers.get(API_PACKAGE_ROOT_HEADER), expected.packageRoot)
    && headerPathMatches(headers.get(API_DATA_ROOT_HEADER), expected.dataRoot)
    && (!expected.daemonEpoch || headers.get(API_DAEMON_EPOCH_HEADER) === expected.daemonEpoch)
}

function headerPathMatches(actual: string | null, expected?: string): boolean {
  if (!expected) return true
  if (!actual) return false
  let decoded = actual
  try {
    decoded = decodeURIComponent(actual)
  } catch {
    /* compare the raw header below */
  }
  return sameResolvedPath(decoded, expected)
}

export function daemonProcessMatches(host: InstallHost, pid: number, packageRoot: string): boolean {
  const tokens = commandTokens(host.processCommandLine(pid))
  return tokens.length === 4
    && nodeExecutableMatches(tokens[0], host.caseInsensitive)
    && pathTokenMatches(tokens[1], join(packageRoot, 'dist', 'control', 'cli.js'), host.caseInsensitive)
    && tokens[2]?.toLowerCase() === 'daemon'
    && tokens[3]?.toLowerCase() === 'run'
}

export function apiProcessMatches(host: InstallHost, pid: number, packageRoot: string): boolean {
  const tokens = commandTokens(host.processCommandLine(pid))
  const standaloneApi = tokens.length === 2
    && nodeExecutableMatches(tokens[0], host.caseInsensitive)
    && pathTokenMatches(tokens[1], join(packageRoot, 'server', 'index.mjs'), host.caseInsensitive)
  return standaloneApi || daemonProcessMatches(host, pid, packageRoot)
}

function commandTokens(command: string): string[] {
  if (!command) return []
  const tokens: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|([^\s]+)/g
  for (const match of command.matchAll(pattern)) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '')
  }
  return tokens.filter(Boolean)
}

function nodeExecutableMatches(token: string | undefined, caseInsensitive: boolean): boolean {
  if (!token) return false
  if (!/[\\/]/.test(token)) return /^(?:node|node\.exe)$/i.test(token)
  return comparablePath(token, caseInsensitive) === comparablePath(process.execPath, caseInsensitive)
}

function pathTokenMatches(token: string | undefined, expected: string, caseInsensitive: boolean): boolean {
  return Boolean(token) && comparablePath(token as string, caseInsensitive) === comparablePath(expected, caseInsensitive)
}

function comparablePath(value: string, caseInsensitive: boolean): string {
  const normalized = resolve(value).replaceAll('/', '\\').replace(/[\\]+$/, '')
  return caseInsensitive ? normalized.toLowerCase() : normalized
}

function sameResolvedPath(left: string, right: string): boolean {
  return comparablePath(left, process.platform === 'win32' || process.platform === 'darwin')
    === comparablePath(right, process.platform === 'win32' || process.platform === 'darwin')
}

export function heartbeatBindsInstance(
  heartbeat: Record<string, unknown> | null,
  expected: DaemonInstanceBinding,
  maxAgeMs = 20000,
  now = Date.now()
): boolean {
  if (!heartbeat?.lastBeat) return false
  const at = Date.parse(String(heartbeat.lastBeat))
  const age = now - at
  const heartbeatPackageRoot = typeof heartbeat.packageRoot === 'string' ? heartbeat.packageRoot.trim() : ''
  const heartbeatDataRoot = typeof heartbeat.dataRoot === 'string' ? heartbeat.dataRoot.trim() : ''
  return Number.isFinite(at)
    && age >= 0
    && age < maxAgeMs
    && Number(heartbeat.pid || 0) === expected.pid
    && Number(heartbeat.apiPid || 0) === expected.apiPid
    && Number(heartbeat.port || 0) === expected.port
    && Boolean(heartbeatPackageRoot)
    && Boolean(heartbeatDataRoot)
    && sameResolvedPath(heartbeatPackageRoot, expected.packageRoot)
    && sameResolvedPath(heartbeatDataRoot, expected.dataRoot)
}

export type DaemonPidClaim = {
  claimed: boolean
  existingPid: number
  reason: 'claimed' | 'already-running' | 'unverified-live-pid' | 'claim-failed'
  /** Exact path identity published by this claim. Present only for `claimed`. */
  ownerState?: MutableFileState
}

type MutableFileState = {
  dev: number
  ino: number
  size: number
  mtimeMs: number
  nlink: number
}

type DaemonDirectoryIdentity = { dev: number; ino: number }

type CapturedDaemonMarker = {
  state: MutableFileState
  bytes: Buffer
}

export type DaemonMarkerInspection = {
  kind: 'absent' | 'partial' | 'complete'
  pid: number
  apiPid: number
  advertisedPid: number
  advertisedApiPid: number
  heartbeat: Record<string, unknown> | null
  reviewIdentity: DaemonDirectoryIdentity | null
  pidMarker: CapturedDaemonMarker | null
  apiPidMarker: CapturedDaemonMarker | null
  heartbeatMarker: CapturedDaemonMarker | null
}

function lstatMaybe(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function assertDaemonPlainAncestorChain(target: string, label: string): void {
  let cursor = resolve(target)
  for (;;) {
    const stat = lstatMaybe(cursor)
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
      throw new Error(`${label} has a non-plain ancestor: ${cursor}`)
    }
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
}

function captureDaemonMarker(file: string, maxBytes: number, label: string): CapturedDaemonMarker | null {
  const before = lstatMaybe(file)
  if (!before) return null
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes) {
    throw new Error(`${label} is not a bounded unique plain file`)
  }
  let descriptor = -1
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    const opened = fs.fstatSync(descriptor)
    if (!sameMutableFileState(opened, {
      dev: before.dev,
      ino: before.ino,
      size: before.size,
      mtimeMs: before.mtimeMs,
      nlink: before.nlink
    })) {
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
    const pathAfter = fs.lstatSync(file)
    const state = {
      dev: opened.dev,
      ino: opened.ino,
      size: opened.size,
      mtimeMs: opened.mtimeMs,
      nlink: opened.nlink
    }
    if (!sameMutableFileState(after, state) || !sameMutableFileState(pathAfter, state)) {
      throw new Error(`${label} changed while read`)
    }
    return { state, bytes }
  } finally {
    if (descriptor >= 0) fs.closeSync(descriptor)
  }
}

function parseDaemonPidMarker(marker: CapturedDaemonMarker | null, label: string): number {
  if (!marker) return 0
  let value = ''
  try {
    value = new TextDecoder('utf-8', { fatal: true }).decode(marker.bytes)
  } catch {
    throw new Error(`${label} is not valid UTF-8`)
  }
  if (!/^[1-9][0-9]{0,9}(?:\r?\n)?$/.test(value)) throw new Error(`${label} is not a canonical PID marker`)
  const pid = Number(value.trim())
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error(`${label} is not a valid PID marker`)
  return pid
}

function parseDaemonHeartbeatMarker(marker: CapturedDaemonMarker | null): Record<string, unknown> | null {
  if (!marker) return null
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(marker.bytes))
  } catch {
    throw new Error('daemon heartbeat is not valid bounded JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('daemon heartbeat is not a JSON object')
  }
  const heartbeat = value as Record<string, unknown>
  for (const name of ['pid', 'apiPid', 'port'] as const) {
    if (!Number.isSafeInteger(heartbeat[name]) || Number(heartbeat[name]) < (name === 'apiPid' ? 0 : 1)) {
      throw new Error(`daemon heartbeat ${name} is invalid`)
    }
  }
  if (typeof heartbeat.packageRoot !== 'string' || !heartbeat.packageRoot
    || typeof heartbeat.dataRoot !== 'string' || !heartbeat.dataRoot
    || typeof heartbeat.lastBeat !== 'string' || !Number.isFinite(Date.parse(heartbeat.lastBeat))) {
    throw new Error('daemon heartbeat instance binding is invalid')
  }
  if (heartbeat.apiHealthy !== undefined && typeof heartbeat.apiHealthy !== 'boolean') {
    throw new Error('daemon heartbeat health flag is invalid')
  }
  return heartbeat
}

export function inspectDaemonMarkerSet(dataRoot: string): DaemonMarkerInspection {
  const files = reviewFiles(dataRoot)
  assertDaemonPlainAncestorChain(dataRoot, 'daemon data root')
  assertDaemonPlainAncestorChain(files.review, 'daemon review root')
  const review = lstatMaybe(files.review)
  if (!review) {
    return {
      kind: 'absent',
      pid: 0,
      apiPid: 0,
      advertisedPid: 0,
      advertisedApiPid: 0,
      heartbeat: null,
      reviewIdentity: null,
      pidMarker: null,
      apiPidMarker: null,
      heartbeatMarker: null
    }
  }
  const reviewIdentity = { dev: review.dev, ino: review.ino }
  const pidMarker = captureDaemonMarker(files.pidFile, 128, 'daemon PID marker')
  const apiPidMarker = captureDaemonMarker(files.apiPidFile, 128, 'daemon API PID marker')
  const heartbeatMarker = captureDaemonMarker(files.heartbeatFile, 64 * 1024, 'daemon heartbeat marker')
  const pid = parseDaemonPidMarker(pidMarker, 'daemon PID marker')
  const apiPid = parseDaemonPidMarker(apiPidMarker, 'daemon API PID marker')
  const heartbeat = parseDaemonHeartbeatMarker(heartbeatMarker)
  const advertisedPid = Number.isSafeInteger(heartbeat?.pid) && Number(heartbeat?.pid) > 0
    ? Number(heartbeat?.pid)
    : 0
  const advertisedApiPid = Number.isSafeInteger(heartbeat?.apiPid) && Number(heartbeat?.apiPid) > 0
    ? Number(heartbeat?.apiPid)
    : 0
  const count = [pidMarker, apiPidMarker, heartbeatMarker].filter(Boolean).length
  return {
    kind: count === 0 ? 'absent' : count === 3 ? 'complete' : 'partial',
    pid,
    apiPid,
    advertisedPid,
    advertisedApiPid,
    heartbeat,
    reviewIdentity,
    pidMarker,
    apiPidMarker,
    heartbeatMarker
  }
}

function assertDaemonReviewIdentity(dataRoot: string, expected: DaemonDirectoryIdentity | null): void {
  const files = reviewFiles(dataRoot)
  assertDaemonPlainAncestorChain(dataRoot, 'daemon data root')
  assertDaemonPlainAncestorChain(files.review, 'daemon review root')
  const current = lstatMaybe(files.review)
  if (expected === null ? current !== null : !current
    || expected !== null && current !== null && (current.dev !== expected.dev || current.ino !== expected.ino)) {
    throw new Error('daemon review root identity changed')
  }
}

export function assertDaemonMarkerSetCurrent(dataRoot: string, expected: DaemonMarkerInspection): void {
  const files = reviewFiles(dataRoot)
  assertDaemonReviewIdentity(dataRoot, expected.reviewIdentity)
  for (const [file, marker, label] of [
    [files.pidFile, expected.pidMarker, 'daemon PID marker'],
    [files.apiPidFile, expected.apiPidMarker, 'daemon API PID marker'],
    [files.heartbeatFile, expected.heartbeatMarker, 'daemon heartbeat marker']
  ] as const) {
    if (!marker) assertMutableFileState(file, null)
    else assertMutableFileBytes(file, marker.state, marker.bytes)
    void label
  }
}

function heartbeatStructurallyBindsInstance(
  heartbeat: Record<string, unknown> | null,
  expected: DaemonInstanceBinding
): boolean {
  const at = Date.parse(String(heartbeat?.lastBeat || ''))
  return Number.isFinite(at) && heartbeatBindsInstance(heartbeat, expected, 2, at + 1)
}

async function loopbackAddressListening(port: number, host: '127.0.0.1' | '::1', timeoutMs: number): Promise<boolean> {
  return new Promise((resolveListening) => {
    const socket = createConnection({ port, host })
    let settled = false
    const finish = (listening: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolveListening(listening)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(timeoutMs, () => finish(false))
  })
}

export async function loopbackListenerPresent(port: number, timeoutMs = 500): Promise<boolean> {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('daemon listener port is invalid')
  if (await loopbackAddressListening(port, '127.0.0.1', timeoutMs)) return true
  return loopbackAddressListening(port, '::1', timeoutMs)
}

export async function stopDaemonWithListenerSeal(
  dataRoot: string,
  host: InstallHost,
  packageRoot: string,
  port: number,
  revalidate: () => void | Promise<void> = () => {},
  revalidateMutation: () => void = () => {}
): Promise<boolean> {
  let markerSnapshot: DaemonMarkerInspection
  try {
    markerSnapshot = inspectDaemonMarkerSet(dataRoot)
  } catch {
    return false
  }
  const listenerPresent = await loopbackListenerPresent(port)
  try {
    await revalidate()
    assertDaemonMarkerSetCurrent(dataRoot, markerSnapshot)
  } catch {
    return false
  }
  if (markerSnapshot.kind === 'partial') return false
  if (markerSnapshot.kind === 'absent') return !listenerPresent
  if (listenerPresent && (!host.pidAlive(markerSnapshot.apiPid)
    || !apiProcessMatches(host, markerSnapshot.apiPid, packageRoot))) {
    return false
  }
  if (!stopDaemon(dataRoot, host, packageRoot, port, revalidateMutation)) return false
  const listenerAfter = await loopbackListenerPresent(port)
  try {
    await revalidate()
    const terminal = inspectDaemonMarkerSet(dataRoot)
    if (terminal.kind !== 'absent') return false
  } catch {
    return false
  }
  return !listenerAfter
}

function mutableFileState(file: string): MutableFileState | null {
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error(`daemon marker target is unsafe: ${file}`)
    }
    return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, nlink: stat.nlink }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function sameMutableFileState(stat: fs.Stats, expected: MutableFileState): boolean {
  return stat.isFile() && !stat.isSymbolicLink()
    && stat.dev === expected.dev && stat.ino === expected.ino
    && stat.size === expected.size && stat.mtimeMs === expected.mtimeMs
    && stat.nlink === expected.nlink
}

function assertMutableFileState(file: string, expected: MutableFileState | null): void {
  const current = mutableFileState(file)
  const changed = expected === null
    ? current !== null
    : !current
      || current.dev !== expected.dev || current.ino !== expected.ino
      || current.size !== expected.size || current.mtimeMs !== expected.mtimeMs
      || current.nlink !== expected.nlink
  if (changed) {
    throw new Error(`daemon marker target changed: ${file}`)
  }
}

function writeMutableFileExact(
  file: string,
  bytes: Buffer,
  expected: MutableFileState | null,
  beforeMutation: () => void
): MutableFileState {
  beforeMutation()
  assertMutableFileState(file, expected)
  let descriptor = -1
  try {
    const noFollow = fs.constants.O_NOFOLLOW || 0
    descriptor = expected === null
      ? fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600)
      : fs.openSync(file, fs.constants.O_WRONLY | noFollow)
    const opened = fs.fstatSync(descriptor)
    if (!opened.isFile() || opened.nlink !== 1
      || expected !== null && !sameMutableFileState(opened, expected)) {
      throw new Error(`daemon marker descriptor changed: ${file}`)
    }
    if (expected !== null) fs.ftruncateSync(descriptor, 0)
    let offset = 0
    while (offset < bytes.length) offset += fs.writeSync(descriptor, bytes, offset, bytes.length - offset, offset)
    fs.fsyncSync(descriptor)
    const after = fs.fstatSync(descriptor)
    if (!after.isFile() || after.nlink !== 1 || after.size !== bytes.length) {
      throw new Error(`daemon marker write failed its descriptor postcondition: ${file}`)
    }
    const pathAfter = fs.lstatSync(file)
    if (pathAfter.dev !== after.dev || pathAfter.ino !== after.ino || pathAfter.nlink !== 1) {
      throw new Error(`daemon marker path changed during write: ${file}`)
    }
    return {
      dev: pathAfter.dev,
      ino: pathAfter.ino,
      size: pathAfter.size,
      mtimeMs: pathAfter.mtimeMs,
      nlink: pathAfter.nlink
    }
  } finally {
    if (descriptor >= 0) fs.closeSync(descriptor)
  }
}

function removeMutableFileExact(
  file: string,
  expected: MutableFileState | null,
  beforeMutation: () => void = () => {}
): void {
  if (!expected) return
  try {
    beforeMutation()
    assertMutableFileState(file, expected)
    fs.unlinkSync(file)
  } catch {
    // Preserve a replaced or otherwise unverifiable marker.
  }
}

function assertMutableFileBytes(file: string, expected: MutableFileState, expectedBytes: Buffer): void {
  let descriptor = -1
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    const opened = fs.fstatSync(descriptor)
    if (!sameMutableFileState(opened, expected) || opened.size !== expectedBytes.length) {
      throw new Error(`daemon marker descriptor changed: ${file}`)
    }
    const bytes = Buffer.alloc(opened.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset)
      if (count === 0) throw new Error(`daemon marker ended during readback: ${file}`)
      offset += count
    }
    const after = fs.fstatSync(descriptor)
    const pathAfter = fs.lstatSync(file)
    if (!sameMutableFileState(after, expected) || !sameMutableFileState(pathAfter, expected)
      || !bytes.equals(expectedBytes)) {
      throw new Error(`daemon marker terminal seal failed: ${file}`)
    }
  } finally {
    if (descriptor >= 0) fs.closeSync(descriptor)
  }
}

function openDaemonLog(file: string, beforeMutation: () => void): number {
  beforeMutation()
  const expected = mutableFileState(file)
  const noFollow = fs.constants.O_NOFOLLOW || 0
  const descriptor = expected === null
    ? fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600)
    : fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | noFollow)
  const opened = fs.fstatSync(descriptor)
  if (!opened.isFile() || opened.nlink !== 1 || expected !== null && !sameMutableFileState(opened, expected)) {
    fs.closeSync(descriptor)
    throw new Error('daemon log descriptor is unsafe')
  }
  const pathStat = fs.lstatSync(file)
  if (pathStat.dev !== opened.dev || pathStat.ino !== opened.ino || pathStat.nlink !== 1) {
    fs.closeSync(descriptor)
    throw new Error('daemon log path changed while opening')
  }
  return descriptor
}

function appendDaemonLog(descriptor: number, file: string, line: string, beforeMutation: () => void): void {
  beforeMutation()
  const opened = fs.fstatSync(descriptor)
  const pathStat = fs.lstatSync(file)
  if (!opened.isFile() || opened.nlink !== 1 || !pathStat.isFile() || pathStat.isSymbolicLink()
    || pathStat.nlink !== 1 || pathStat.dev !== opened.dev || pathStat.ino !== opened.ino) {
    throw new Error('daemon log authority changed')
  }
  const bytes = Buffer.from(line, 'utf8')
  // P4 does not rotate/truncate a live authority path. Drop a log line once
  // the bounded file is full so the next guarded startup remains admissible.
  if (opened.size + bytes.length > DAEMON_LOG_MAX_BYTES) return
  fs.writeSync(descriptor, bytes)
}

export function claimDaemonPid(
  pidFile: string,
  host: InstallHost,
  packageRoot: string,
  ownerPid = process.pid,
  dataRoot = dirname(dirname(pidFile)),
  port = Number(host.env('HUB_API_PORT') || API_PORT),
  beforeMutation: () => void = () => {}
): DaemonPidClaim {
  beforeMutation()
  fs.mkdirSync(dirname(pidFile), { recursive: true })
  const files = reviewFiles(dataRoot)
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const existingPid = readPid(pidFile)
    const existingApiPid = readPid(files.apiPidFile)
    const daemonAlive = Boolean(existingPid && host.pidAlive(existingPid))
    const apiAlive = Boolean(existingApiPid && host.pidAlive(existingApiPid))
    if (daemonAlive || apiAlive) {
      const heartbeat = readHeartbeat(dataRoot)
      const bound = heartbeatBindsInstance(heartbeat, {
        pid: existingPid,
        apiPid: existingApiPid,
        packageRoot,
        dataRoot,
        port
      })
      const daemonOwned = !daemonAlive || daemonProcessMatches(host, existingPid, packageRoot)
      const apiOwned = !apiAlive || apiProcessMatches(host, existingApiPid, packageRoot)
      if (daemonAlive && bound && daemonOwned && apiOwned) {
        return { claimed: false, existingPid, reason: 'already-running' }
      }
      return {
        claimed: false,
        existingPid: existingPid || existingApiPid,
        reason: 'unverified-live-pid'
      }
    }

    const staleState = mutableFileState(pidFile)
    if (staleState) {
      const quarantine = `${pidFile}.stale.${ownerPid}.${Date.now()}.${attempt}`
      try {
        beforeMutation()
        assertMutableFileState(pidFile, staleState)
        assertMutableFileState(quarantine, null)
        fs.renameSync(pidFile, quarantine)
        const isolatedState = mutableFileState(quarantine)
        if (!isolatedState || isolatedState.dev !== staleState.dev || isolatedState.ino !== staleState.ino
          || isolatedState.size !== staleState.size || isolatedState.mtimeMs !== staleState.mtimeMs
          || isolatedState.nlink !== staleState.nlink) {
          throw new Error('stale daemon PID isolation changed identity')
        }
        beforeMutation()
        assertMutableFileState(quarantine, isolatedState)
        fs.unlinkSync(quarantine)
      } catch {
        // Preserve any isolated evidence when the static/root authority changed.
        continue
      }
    }

    try {
      const ownerState = writeMutableFileExact(pidFile, Buffer.from(`${ownerPid}\n`, 'utf8'), null, beforeMutation)
      return { claimed: true, existingPid: 0, reason: 'claimed', ownerState }
    } catch (error) {
      if (!isAlreadyExists(error)) return { claimed: false, existingPid: 0, reason: 'claim-failed' }
    }

  }
  return { claimed: false, existingPid: readPid(pidFile), reason: 'claim-failed' }
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')
}

export function stopDaemon(
  dataRoot: string,
  host: InstallHost = createInstallHost(),
  packageRoot?: string,
  port = Number(host.env('HUB_API_PORT') || API_PORT),
  beforeMutation: () => void = () => {}
): boolean {
  const files = reviewFiles(dataRoot)
  let markerSnapshot: DaemonMarkerInspection
  try {
    markerSnapshot = inspectDaemonMarkerSet(dataRoot)
  } catch {
    return false
  }
  if (markerSnapshot.kind === 'absent') return true
  if (markerSnapshot.kind !== 'complete') return false
  const daemonPid = markerSnapshot.pid
  const apiPid = markerSnapshot.apiPid
  const heartbeat = markerSnapshot.heartbeat
  const daemonAlive = Boolean(daemonPid && host.pidAlive(daemonPid))
  const apiAlive = Boolean(apiPid && host.pidAlive(apiPid))
  const anyLive = daemonAlive || apiAlive
  const bound = Boolean(packageRoot) && heartbeatStructurallyBindsInstance(heartbeat, {
    pid: daemonPid,
    apiPid,
    packageRoot: packageRoot || '',
    dataRoot,
    port
  })
  const daemonOwned = !daemonAlive || Boolean(packageRoot && daemonProcessMatches(host, daemonPid, packageRoot))
  const apiOwned = !apiAlive || Boolean(packageRoot && apiProcessMatches(host, apiPid, packageRoot))

  if (anyLive && (!bound || !daemonOwned || !apiOwned)) {
    return false
  }
  if (!bound) return false
  const livePids = [...new Set([
    ...(daemonAlive ? [daemonPid] : []),
    ...(apiAlive ? [apiPid] : [])
  ])]
  if (livePids.length > 0) {
    let markersUnchanged = false
    try {
      beforeMutation()
      assertDaemonMarkerSetCurrent(dataRoot, markerSnapshot)
      markersUnchanged = true
    } catch { /* fail closed below */ }
    const ownershipUnchanged = (!daemonAlive || Boolean(packageRoot && daemonProcessMatches(host, daemonPid, packageRoot)))
      && (!apiAlive || Boolean(packageRoot && apiProcessMatches(host, apiPid, packageRoot)))
    if (!markersUnchanged || !ownershipUnchanged) return false
  }
  let killAccepted = true
  for (const pid of livePids) {
    if (!host.pidAlive(pid)) continue
    const stillOwned = Boolean(packageRoot)
      && (pid !== daemonPid || daemonProcessMatches(host, pid, packageRoot || ''))
      && (pid !== apiPid || apiProcessMatches(host, pid, packageRoot || ''))
    if (!stillOwned) return false
    try {
      beforeMutation()
      assertDaemonMarkerSetCurrent(dataRoot, markerSnapshot)
      if (!host.killPid(pid)) killAccepted = false
    } catch {
      killAccepted = false
    }
  }
  if (!killAccepted) {
    return false
  }
  if (livePids.length > 0) {
    let exited = false
    try {
      exited = host.waitForPidsExit(livePids, DAEMON_STOP_TIMEOUT_MS)
    } catch {
      return false
    }
    if (!exited || livePids.some((pid) => host.pidAlive(pid))) return false
  }
  try {
    beforeMutation()
    assertDaemonMarkerSetCurrent(dataRoot, markerSnapshot)
  } catch {
    return false
  }
  for (const [file, marker] of [
    [files.pidFile, markerSnapshot.pidMarker],
    [files.apiPidFile, markerSnapshot.apiPidMarker],
    [files.heartbeatFile, markerSnapshot.heartbeatMarker]
  ] as const) {
    removeMutableFileExact(file, marker?.state || null, () => {
      beforeMutation()
      assertDaemonReviewIdentity(dataRoot, markerSnapshot.reviewIdentity)
    })
  }
  return [files.pidFile, files.apiPidFile, files.heartbeatFile]
    .every((file) => lstatMaybe(file) === null)
}

export async function reapDaemonSessions(
  local: Pick<LocalHost, 'application' | 'commandMeta' | 'localSessions'>
): Promise<boolean> {
  if (!local.localSessions?.needsReap()) return false
  const reaped = await local.application.execute({
    kind: 'reapSessions',
    meta: local.commandMeta('daemon')
  })
  if (!reaped.ok) throw new Error(`${reaped.error.code}: ${reaped.error.message}`)
  return true
}

type ExactDaemonRuntimeSnapshot = Readonly<{
  state: 'exact'
  signature: string
}>
type NonExactDaemonRuntimeObservation = Exclude<DaemonRunningObservation, Readonly<{ state: 'exact' }>>

function captureDaemonRuntimeSnapshot(
  processHost: DaemonProcessHost,
  candidate: DaemonRuntimeStartCandidate
): ExactDaemonRuntimeSnapshot | NonExactDaemonRuntimeObservation {
  // This seal executes inside the candidate process itself. Its numeric PID
  // cannot be reused while this code is running; the exact creation identity
  // and PGID were captured immediately before the first START mutation. The
  // expensive host process/tree proof is repeated at the terminal observer,
  // while each publication boundary sandwiches the externally visible
  // listener and epoch health facts below.
  if (candidate.pid !== candidate.apiPid || candidate.pid !== process.pid) {
    return Object.freeze({ state: 'foreign' })
  }
  const listeners = processHost.listenerFacts(candidate.port)
  if (listeners.state === 'unknown') return Object.freeze({ state: 'unknown' })
  if (listeners.state !== 'present' || listeners.bindings.length === 0
    || listeners.pids.length !== 1 || listeners.pids[0] !== candidate.apiPid
    || listeners.bindings.some((binding) => binding.pid !== candidate.apiPid
      || binding.port !== candidate.port
      || binding.address !== '127.0.0.1' && binding.address !== '::1')) {
    return Object.freeze({ state: 'foreign' })
  }
  return Object.freeze({
    state: 'exact',
    signature: JSON.stringify({
      listeners: listeners.bindings
    })
  })
}

async function observeDaemonRuntimeCandidate(
  processHost: DaemonProcessHost,
  candidate: DaemonRuntimeStartCandidate,
  packageRoot: string,
  dataRoot: string
): Promise<DaemonRunningObservation> {
  const before = captureDaemonRuntimeSnapshot(processHost, candidate)
  if (before.state !== 'exact') return before
  const health = await probeDaemonApiHealth(candidate.port, 1500)
  const after = captureDaemonRuntimeSnapshot(processHost, candidate)
  if (after.state !== 'exact') return after
  if (health.state === 'unknown') return Object.freeze({ state: 'unknown' })
  if (health.state !== 'exact' || health.epochId !== candidate.epochId
    || !sameResolvedPath(health.packageRoot, packageRoot)
    || !sameResolvedPath(health.dataRoot, dataRoot)
    || before.signature !== after.signature) return Object.freeze({ state: 'foreign' })
  return Object.freeze({ state: 'exact' })
}

function daemonRuntimeHealthProbe(): DaemonRuntimeHealthProbe {
  return async (request) => probeDaemonApiHealth(request.port, 1500)
}

export async function runDaemon(opts: DaemonRunOptions) {
  const host = opts.host || createInstallHost()
  const processHost = opts.processHost || createDaemonProcessHost()
  const packageRoot = resolve(opts.packageRoot || opts.hubRoot)
  const dataRoot = resolveLocalDataRoot({ packageRoot, dataRoot: opts.dataRoot })
  const port = opts.port || Number(process.env.HUB_API_PORT || API_PORT)
  const intervalMs = opts.intervalMs || 5000
  const files = reviewFiles(dataRoot)
  const home = resolve(opts.home || host.home)
  if (!opts.readReceiptAuthority) {
    throw new Error('daemon v1 startup requires a lifecycle receipt authority reader')
  }
  let startupAuthorityActive = true
  const revalidateStartup = () => {
    if (startupAuthorityActive) opts.onStartupRevalidate?.()
  }
  const finishStartup = async (terminalSeal: () => void | Promise<void>) => {
    await opts.onStartupReady?.()
    revalidateStartup()
    await terminalSeal()
    if (opts.releaseStartupAuthority) {
      await opts.releaseStartupAuthority(async () => {
        revalidateStartup()
        await terminalSeal()
      })
    }
    startupAuthorityActive = false
  }
  revalidateStartup()
  fs.mkdirSync(files.review, { recursive: true })
  const injectedProtocolCheckpoint = opts.protocolCheckpoint
  const reconciliationCheckpoint: DaemonProtocolCheckpoint = (name, facts) => {
    revalidateStartup()
    if (injectedProtocolCheckpoint) {
      injectedProtocolCheckpoint(name, facts)
      revalidateStartup()
    }
  }
  const runtimeOptions = Object.freeze({
    home,
    dataRoot,
    platform: host.platform,
    readReceiptAuthority: opts.readReceiptAuthority
  })
  const healthProbe = daemonRuntimeHealthProbe()
  const reconcilePort = createDaemonRuntimeReconcilePort(runtimeOptions, processHost, healthProbe)
  let reconciled: DaemonRuntimeReconcileResult
  try {
    reconciled = await reconcileDaemonRuntimeForStart(runtimeOptions, reconcilePort, reconciliationCheckpoint)
  } catch (error) {
    let diagnosticDescriptor = -1
    try {
      diagnosticDescriptor = openDaemonLog(files.logFile, revalidateStartup)
      appendDaemonLog(
        diagnosticDescriptor,
        files.logFile,
        `${new Date().toISOString()} daemon reconciliation failed: ${error instanceof Error ? error.stack || error.message : String(error)}\n`,
        revalidateStartup
      )
    } catch { /* retain the original protocol/startup error */ }
    finally { if (diagnosticDescriptor >= 0) fs.closeSync(diagnosticDescriptor) }
    throw error
  }
  revalidateStartup()
  if (reconciled.kind === 'EXISTING') {
    process.stderr.write(`skill-graft daemon already running pid ${reconciled.instance.pid}\n`)
    await finishStartup(async () => {
      assertDaemonInspectionCurrent(reconciled.inspection)
      const observed = await observeDaemonAuthority(runtimeOptions, processHost, healthProbe)
      if (observed.state !== 'exact'
        || observed.instance.epochId !== reconciled.instance.epochId) {
        throw new Error(`existing daemon terminal seal is ${observed.state}`)
      }
      assertDaemonInspectionCurrent(reconciled.inspection)
    })
    return
  }

  let logDescriptor = -1
  revalidateStartup()
  const transports: HttpTransport[] = []
  const closeLog = () => {
    if (logDescriptor >= 0) {
      try { fs.closeSync(logDescriptor) } catch { /* best effort */ }
      logDescriptor = -1
    }
  }
  let shuttingDown = false
  const shutdown = async (code: number) => {
    if (shuttingDown) return
    shuttingDown = true
    await Promise.allSettled(transports.map((transport) => transport.close()))
    closeLog()
    process.exit(code)
  }
  // Protocol projections are immutable authority.  A signal only stops the
  // process/listener; D2 retirement removes the exact frozen files afterwards.
  const onExit = () => closeLog()
  const onSigint = () => { void shutdown(0) }
  const onSigterm = () => { void shutdown(0) }
  const onSighup = () => { void shutdown(0) }
  const removeProcessHandlers = () => {
    process.off('exit', onExit)
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    process.off('SIGHUP', onSighup)
  }
  process.on('exit', onExit)
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)
  process.on('SIGHUP', onSighup)

  const log = (message: string) => {
    const line = `${new Date().toISOString()} ${message}\n`
    try {
      if (logDescriptor >= 0) appendDaemonLog(logDescriptor, files.logFile, line, revalidateStartup)
    } catch {
      /* ignore */
    }
  }

  let tick: (() => Promise<void>) | null = null
  try {
    logDescriptor = openDaemonLog(files.logFile, revalidateStartup)
    const serverPath = join(packageRoot, 'server', 'index.mjs')
    revalidateStartup()
    const context = createHub(dataRoot)
    const runner = createCodexSessionRunner(context)
    const local = createLocalHost({
      packageRoot,
      dataRoot,
      hostId: 'local-daemon',
      context,
      localSessionOptions: { runner: { ...runner, pidAlive: (pid) => host.pidAlive(pid) } }
    })
    await local.ready()
    revalidateStartup()

    if (!fs.existsSync(serverPath)) throw new Error(`missing API server ${serverPath}`)
    const httpModule = opts.httpModule || await loadHttpTransportModule(serverPath)
    revalidateStartup()
    const capability = httpModule.createHttpCapability()
    const epochId = randomUUID()
    const ipv4 = httpModule.createHttpServer({
      host: local, packageRoot, dataRoot, port, daemonEpoch: epochId, capability
    })
    transports.push(ipv4)
    await listenHttpTransport(ipv4, port, '127.0.0.1')
    revalidateStartup()
    const ipv6 = httpModule.createHttpServer({
      host: local, packageRoot, dataRoot, port, daemonEpoch: epochId, capability
    })
    try {
      await listenHttpTransport(ipv6, port, '::1')
      revalidateStartup()
      transports.push(ipv6)
    } catch (error) {
      await ipv6.close()
      revalidateStartup()
      if (!isOptionalIpv6ListenError(error)) throw error
      log(`IPv6 API unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
    revalidateStartup()

    const self = processHost.processFacts(process.pid)
    if (self.state !== 'alive') throw new Error(`daemon self process facts are ${self.state}`)
    const candidate: DaemonRuntimeStartCandidate = Object.freeze({
      epochId,
      pid: process.pid,
      apiPid: process.pid,
      processIdentity: self.processIdentity,
      pgid: self.pgid,
      port,
      createdAt: new Date().toISOString()
    })
    const terminal = await commitDaemonRuntimeStart(reconciled, candidate, {
      sealStatic: revalidateStartup,
      async sealRuntime(expected) {
        const observed = await observeDaemonRuntimeCandidate(
          processHost,
          expected,
          packageRoot,
          dataRoot
        )
        if (observed.state !== 'exact') {
          throw new Error(`daemon runtime START seal is ${observed.state}`)
        }
      }
    // commitDaemonRuntimeStart already sandwiches this callback with the exact
    // static seal. Passing the reconciliation wrapper here would nest the same
    // lifecycle/package validation twice at every durable START checkpoint.
    }, injectedProtocolCheckpoint)

    log(`daemon start pid=${process.pid} package=${packageRoot} data=${dataRoot} port=${port}`)
    process.stderr.write(`skill-graft daemon pid ${process.pid}\n`)

    tick = async () => {
      try {
        await reapDaemonSessions(local)
        revalidateStartup()
      } catch (error) {
        log(`session reap ${error instanceof Error ? error.message : String(error)}`)
      }
      const healthy = await pingApi(port, 1500, { packageRoot, dataRoot, daemonEpoch: epochId })
      revalidateStartup()
      if (!healthy) log('in-process API health check failed')
    }

    await reapDaemonSessions(local)
    await finishStartup(async () => {
      assertDaemonInspectionCurrent(terminal)
      const observed = await observeDaemonAuthority(runtimeOptions, processHost, healthProbe)
      if (observed.state !== 'exact' || observed.instance.epochId !== candidate.epochId) {
        throw new Error(`daemon terminal START seal is ${observed.state}`)
      }
      assertDaemonInspectionCurrent(terminal)
      revalidateStartup()
    })
  } catch (error) {
    const failureLine = `${new Date().toISOString()} daemon startup failed: ${error instanceof Error ? error.stack || error.message : String(error)}\n`
    // Startup authority itself can be the failing seal.  Keep the diagnostic
    // write independent from that failed callback while retaining the log
    // descriptor/path identity checks performed by appendDaemonLog.
    try {
      if (logDescriptor >= 0) appendDaemonLog(logDescriptor, files.logFile, failureLine, () => {})
    } catch {
      /* preserve the original startup error */
    }
    await Promise.allSettled(transports.map((transport) => transport.close()))
    closeLog()
    removeProcessHandlers()
    throw error
  }
  for (;;) {
    await sleep(intervalMs)
    await tick!()
  }
}

type HttpTransport = {
  server: HttpServer
  close(): Promise<void>
}

type HttpTransportFactory = (options: {
  host: LocalHost
  packageRoot: string
  dataRoot: string
  port: number
  daemonEpoch?: string
  capability: object
}) => HttpTransport

type HttpTransportModule = {
  createHttpServer: HttpTransportFactory
  createHttpCapability(): object
}

async function loadHttpTransportModule(serverPath: string): Promise<HttpTransportModule> {
  const module = await import(pathToFileURL(serverPath).href) as {
    createHttpServer?: unknown
    createHttpCapability?: unknown
  }
  if (typeof module.createHttpServer !== 'function') {
    throw new Error(`API server does not export createHttpServer: ${serverPath}`)
  }
  if (typeof module.createHttpCapability !== 'function') {
    throw new Error(`API server does not export createHttpCapability: ${serverPath}`)
  }
  return {
    createHttpServer: module.createHttpServer as HttpTransportFactory,
    createHttpCapability: module.createHttpCapability as () => object
  }
}

function listenHttpTransport(transport: HttpTransport, port: number, bindHost: string): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error: Error) => {
      transport.server.off('listening', onListening)
      rejectListen(error)
    }
    const onListening = () => {
      transport.server.off('error', onError)
      resolveListen()
    }
    transport.server.once('error', onError)
    transport.server.once('listening', onListening)
    transport.server.listen(port, bindHost)
  })
}

function isOptionalIpv6ListenError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false
  return ['EADDRINUSE', 'EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(String(error.code))
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
