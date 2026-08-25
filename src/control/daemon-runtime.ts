import { isIP } from 'node:net'
import { isAbsolute, resolve } from 'node:path'
import { URL } from 'node:url'

import type {
  DaemonAliveProcessFacts,
  DaemonExactProcessTree,
  DaemonListenerBinding,
  DaemonListenerFacts,
  DaemonProcessFacts,
  DaemonProcessHost
} from '../adapters/daemon-process-host.js'
import {
  acquireAbandonedDaemonStartCleanupAuthority,
  acquireCommittedDaemonStartCollapseAuthority,
  assertDaemonInspectionCurrent,
  bootstrapDaemonStageNamespace,
  cleanupAbandonedDaemonStart,
  collapseCommittedDaemonStart,
  commitDaemonStartInstance,
  createDaemonStartStage,
  inspectDaemonProtocol,
  inspectDaemonReceiptNamespace,
  publishDaemonStartProjection,
  recoverDaemonStartStage,
  type CreateDaemonStartStageOptions,
  type DaemonInstanceRecordV1,
  type DaemonProtocolCheckpoint,
  type DaemonProtocolInspection,
  type DaemonProtocolKind,
  type DaemonReceiptAuthorityReader,
  type DaemonStageNamespaceAuthority,
  type DaemonStartActorProbeFacts,
  type InspectDaemonProtocolOptions
} from './daemon-protocol.js'

export type DaemonRuntimeProtocolOptions = Readonly<{
  home: string
  dataRoot: string
  platform?: string
  readReceiptAuthority: DaemonReceiptAuthorityReader
}>

export type DaemonRuntimeHealthProbeRequest = Readonly<{
  port: number
  epochId: string
  packageRoot: string
  dataRoot: string
  pid: number
  apiPid: number
}>

export type DaemonRuntimeHealthFacts =
  | Readonly<{
      state: 'exact'
      epochId: string
      packageRoot: string
      dataRoot: string
    }>
  | Readonly<{ state: 'dead' }>
  | Readonly<{ state: 'foreign' }>
  | Readonly<{ state: 'unknown' }>

export type DaemonRuntimeHealthProbe = (
  request: DaemonRuntimeHealthProbeRequest
) => unknown | Promise<unknown>

export type DaemonAuthorityObservation =
  | Readonly<{
      state: 'not-running'
      protocolKind: 'ABSENT' | 'NAMESPACE-RECOVERABLE' | 'LEGACY-NAMESPACE-RECOVERABLE'
      inspection: DaemonProtocolInspection
    }>
  | Readonly<{
      state: 'control-required'
      protocolKind: Exclude<DaemonProtocolKind,
        | 'ABSENT'
        | 'NAMESPACE-RECOVERABLE'
        | 'LEGACY-NAMESPACE-RECOVERABLE'
        | 'RUNNING-CLEAN'>
      inspection: DaemonProtocolInspection
    }>
  | Readonly<{
      state: 'exact'
      protocolKind: 'RUNNING-CLEAN'
      inspection: DaemonProtocolInspection
      instance: DaemonInstanceRecordV1
      rootProcess: DaemonAliveProcessFacts
      apiProcess: DaemonAliveProcessFacts
      processTree: DaemonExactProcessTree
      listener: Extract<DaemonListenerFacts, { state: 'present' }>
      health: Extract<DaemonRuntimeHealthFacts, { state: 'exact' }>
    }>
  | Readonly<{
      state: 'dead' | 'foreign' | 'unknown'
      protocolKind: DaemonProtocolKind | null
      inspection: DaemonProtocolInspection | null
      reason: string
    }>

export type DaemonRunningObservation =
  | Readonly<{ state: 'exact' }>
  | Readonly<{ state: 'dead' }>
  | Readonly<{ state: 'foreign' }>
  | Readonly<{ state: 'unknown' }>

export type DaemonRuntimeReconcilePort = Readonly<{
  observeActor(pid: number): Promise<DaemonStartActorProbeFacts>
  observeRunning(instance: DaemonInstanceRecordV1): Promise<DaemonRunningObservation>
}>

export type DaemonRuntimeStartCandidate = Readonly<{
  epochId: string
  pid: number
  apiPid: number
  processIdentity: string
  pgid: number
  port: number
  createdAt: string
}>

export type DaemonRuntimeEmptyAuthority = Readonly<{
  kind: 'EMPTY'
  namespaceId: string
}>

export type DaemonRuntimeReconcileResult =
  | DaemonRuntimeEmptyAuthority
  | Readonly<{ kind: 'EXISTING'; inspection: DaemonProtocolInspection; instance: DaemonInstanceRecordV1 }>

type PrivateEmptyAuthority = Readonly<{
  options: InspectDaemonProtocolOptions
  authority: DaemonStageNamespaceAuthority
  issuedSignature: string
}>

const privateEmptyAuthorities = new WeakMap<object, PrivateEmptyAuthority>()

function protocolOptions(options: DaemonRuntimeProtocolOptions): InspectDaemonProtocolOptions {
  return Object.freeze({
    home: options.home,
    dataRoot: options.dataRoot,
    ...(options.platform ? { platform: options.platform } : {}),
    readReceiptAuthority: options.readReceiptAuthority
  })
}

const DEAD_PROCESS = Object.freeze({ state: 'dead' as const })
const UNKNOWN_PROCESS = Object.freeze({ state: 'unknown' as const })
const UNKNOWN_TREE = Object.freeze({ state: 'unknown' as const })
const ABSENT_LISTENER = Object.freeze({ state: 'absent' as const })
const UNKNOWN_LISTENER = Object.freeze({ state: 'unknown' as const })
const UNKNOWN_HEALTH = Object.freeze({ state: 'unknown' as const })
const SAFE_PROCESS_IDENTITY = /^[A-Za-z0-9:._-]{1,512}$/
const MAX_COMMAND_LINE_BYTES = 1024 * 1024

function exactDataRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const actual = Object.keys(value).sort()
    const expected = [...keys].sort()
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const record: Record<string, unknown> = Object.create(null)
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return null
      record[key] = descriptor.value
    }
    return record
  } catch {
    return null
  }
}

function normalizeProcessFacts(value: unknown, expectedPid: number): DaemonProcessFacts {
  const terminal = exactDataRecord(value, ['state'])
  if (terminal?.state === 'dead') return DEAD_PROCESS
  if (terminal?.state === 'unknown') return UNKNOWN_PROCESS
  const record = exactDataRecord(value, ['state', 'pid', 'ppid', 'processIdentity', 'pgid', 'commandLine'])
  if (!record || record.state !== 'alive' || record.pid !== expectedPid
    || !Number.isSafeInteger(record.pid) || Number(record.pid) < 1
    || !Number.isSafeInteger(record.ppid) || Number(record.ppid) < 0 || record.ppid === record.pid
    || typeof record.processIdentity !== 'string' || !SAFE_PROCESS_IDENTITY.test(record.processIdentity)
    || !Number.isSafeInteger(record.pgid) || Number(record.pgid) < 1
    || typeof record.commandLine !== 'string'
    || Buffer.byteLength(record.commandLine, 'utf8') > MAX_COMMAND_LINE_BYTES) return UNKNOWN_PROCESS
  return Object.freeze({
    state: 'alive' as const,
    pid: Number(record.pid),
    ppid: Number(record.ppid),
    processIdentity: record.processIdentity,
    pgid: Number(record.pgid),
    commandLine: record.commandLine
  })
}

function sameProcess(left: DaemonAliveProcessFacts, right: DaemonAliveProcessFacts): boolean {
  return left.pid === right.pid && left.ppid === right.ppid
    && left.processIdentity === right.processIdentity && left.pgid === right.pgid
    && left.commandLine === right.commandLine
}

function normalizeProcessTree(
  value: unknown,
  expectedRootPid: number,
  expectedRootIdentity: string
): DaemonExactProcessTree | typeof UNKNOWN_TREE {
  const terminal = exactDataRecord(value, ['state'])
  if (terminal?.state === 'unknown') return UNKNOWN_TREE
  const record = exactDataRecord(value, ['state', 'rootPid', 'rootProcessIdentity', 'entries'])
  if (!record || record.state !== 'exact' || record.rootPid !== expectedRootPid
    || record.rootProcessIdentity !== expectedRootIdentity || !Array.isArray(record.entries)
    || record.entries.length === 0) return UNKNOWN_TREE
  const entries: DaemonAliveProcessFacts[] = []
  let priorPid = 0
  for (const raw of record.entries) {
    const entryRecord = exactDataRecord(raw, ['state', 'pid', 'ppid', 'processIdentity', 'pgid', 'commandLine'])
    const entryPid = entryRecord?.pid
    if (!Number.isSafeInteger(entryPid) || Number(entryPid) < 1) return UNKNOWN_TREE
    const entry = normalizeProcessFacts(raw, Number(entryPid))
    if (entry.state !== 'alive' || entry.pid <= priorPid) return UNKNOWN_TREE
    priorPid = entry.pid
    entries.push(entry)
  }
  const byPid = new Map(entries.map((entry) => [entry.pid, entry]))
  const root = byPid.get(expectedRootPid)
  if (!root || root.processIdentity !== expectedRootIdentity
    || entries.some((entry) => entry.pid !== expectedRootPid && !byPid.has(entry.ppid))) return UNKNOWN_TREE
  for (const entry of entries) {
    const seen = new Set<number>()
    let cursor = entry
    while (cursor.pid !== expectedRootPid) {
      if (seen.has(cursor.pid)) return UNKNOWN_TREE
      seen.add(cursor.pid)
      const parent = byPid.get(cursor.ppid)
      if (!parent) return UNKNOWN_TREE
      cursor = parent
    }
  }
  return Object.freeze({
    state: 'exact' as const,
    rootPid: expectedRootPid,
    rootProcessIdentity: expectedRootIdentity,
    entries: Object.freeze(entries)
  })
}

function sameProcessTree(left: DaemonExactProcessTree, right: DaemonExactProcessTree): boolean {
  return left.rootPid === right.rootPid && left.rootProcessIdentity === right.rootProcessIdentity
    && left.entries.length === right.entries.length
    && left.entries.every((entry, index) => sameProcess(entry, right.entries[index]))
}

function compareListenerBinding(left: DaemonListenerBinding, right: DaemonListenerBinding): number {
  return left.family < right.family ? -1 : left.family > right.family ? 1
    : left.address < right.address ? -1 : left.address > right.address ? 1
      : left.pid - right.pid
}

function normalizeListenerAddress(family: DaemonListenerBinding['family'], address: string): string | null {
  if (isIP(address) !== (family === 'ipv4' ? 4 : 6)) return null
  if (family === 'ipv4') return address
  try {
    const hostname = new URL(`http://[${address}]/`).hostname
    if (!hostname.startsWith('[') || !hostname.endsWith(']')) return null
    return hostname.slice(1, -1).toLowerCase()
  } catch {
    return null
  }
}

function isLoopbackListenerBinding(binding: DaemonListenerBinding): boolean {
  return binding.family === 'ipv4'
    ? binding.address === '127.0.0.1'
    : binding.address === '::1'
}

function normalizeListenerFacts(value: unknown, expectedPort: number): DaemonListenerFacts {
  const terminal = exactDataRecord(value, ['state'])
  if (terminal?.state === 'absent') return ABSENT_LISTENER
  if (terminal?.state === 'unknown') return UNKNOWN_LISTENER
  const record = exactDataRecord(value, ['state', 'pids', 'bindings'])
  if (!record || record.state !== 'present' || !Array.isArray(record.pids)
    || !Array.isArray(record.bindings) || record.bindings.length === 0) return UNKNOWN_LISTENER
  const pids: number[] = []
  let priorPid = 0
  for (const rawPid of record.pids) {
    if (!Number.isSafeInteger(rawPid) || Number(rawPid) < 1 || Number(rawPid) <= priorPid) return UNKNOWN_LISTENER
    priorPid = Number(rawPid)
    pids.push(Number(rawPid))
  }
  const bindings: DaemonListenerBinding[] = []
  let priorBinding: DaemonListenerBinding | null = null
  for (const raw of record.bindings) {
    const binding = exactDataRecord(raw, ['family', 'address', 'port', 'pid'])
    if (!binding || binding.family !== 'ipv4' && binding.family !== 'ipv6'
      || typeof binding.address !== 'string'
      || binding.port !== expectedPort || !Number.isSafeInteger(binding.pid) || Number(binding.pid) < 1) {
      return UNKNOWN_LISTENER
    }
    const address = normalizeListenerAddress(binding.family, binding.address)
    if (!address) return UNKNOWN_LISTENER
    const normalized = Object.freeze({
      family: binding.family,
      address,
      port: expectedPort,
      pid: Number(binding.pid)
    })
    if (priorBinding && compareListenerBinding(priorBinding, normalized) >= 0) return UNKNOWN_LISTENER
    priorBinding = normalized
    bindings.push(normalized)
  }
  const bindingPids = [...new Set(bindings.map((binding) => binding.pid))].sort((left, right) => left - right)
  if (pids.length !== bindingPids.length || pids.some((pid, index) => pid !== bindingPids[index])) {
    return UNKNOWN_LISTENER
  }
  return Object.freeze({ state: 'present' as const, pids: Object.freeze(pids), bindings: Object.freeze(bindings) })
}

function sameListener(
  left: Extract<DaemonListenerFacts, { state: 'present' }>,
  right: Extract<DaemonListenerFacts, { state: 'present' }>
): boolean {
  return left.pids.length === right.pids.length && left.pids.every((pid, index) => pid === right.pids[index])
    && left.bindings.length === right.bindings.length
    && left.bindings.every((binding, index) => compareListenerBinding(binding, right.bindings[index]) === 0
      && binding.port === right.bindings[index].port)
}

function normalizeHealthFacts(value: unknown): DaemonRuntimeHealthFacts {
  const terminal = exactDataRecord(value, ['state'])
  if (terminal?.state === 'dead') return Object.freeze({ state: 'dead' as const })
  if (terminal?.state === 'foreign') return Object.freeze({ state: 'foreign' as const })
  if (terminal?.state === 'unknown') return UNKNOWN_HEALTH
  const record = exactDataRecord(value, ['state', 'epochId', 'packageRoot', 'dataRoot'])
  if (!record || record.state !== 'exact' || typeof record.epochId !== 'string'
    || typeof record.packageRoot !== 'string' || !isAbsolute(record.packageRoot)
    || typeof record.dataRoot !== 'string' || !isAbsolute(record.dataRoot)) return UNKNOWN_HEALTH
  return Object.freeze({
    state: 'exact' as const,
    epochId: record.epochId,
    packageRoot: record.packageRoot,
    dataRoot: record.dataRoot
  })
}

function sameRuntimePath(left: string, right: string, platform: string): boolean {
  try {
    const first = resolve(left)
    const second = resolve(right)
    return platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second
  } catch {
    return false
  }
}

function sameInstanceAuthority(left: DaemonInstanceRecordV1, right: DaemonInstanceRecordV1, platform: string): boolean {
  return left.epochId === right.epochId && left.pid === right.pid && left.apiPid === right.apiPid
    && left.processIdentity === right.processIdentity && left.pgid === right.pgid && left.port === right.port
    && sameRuntimePath(left.packageRoot, right.packageRoot, platform)
    && sameRuntimePath(left.dataRoot, right.dataRoot, platform)
}

function inspectionIsCurrent(inspection: DaemonProtocolInspection): boolean {
  try {
    assertDaemonInspectionCurrent(inspection)
    return true
  } catch {
    return false
  }
}

type ProtocolBoundSample<T> =
  | Readonly<{ state: 'exact'; value: T }>
  | Readonly<{ state: 'unknown'; reason: 'protocol-drift' | 'provider-unavailable' }>

async function sampleProtocolBound<T>(
  inspection: DaemonProtocolInspection,
  provider: () => T | Promise<T>
): Promise<ProtocolBoundSample<T>> {
  if (!inspectionIsCurrent(inspection)) return Object.freeze({ state: 'unknown', reason: 'protocol-drift' })
  let value: T
  try {
    value = await provider()
  } catch {
    return Object.freeze({
      state: 'unknown',
      reason: inspectionIsCurrent(inspection) ? 'provider-unavailable' : 'protocol-drift'
    })
  }
  if (!inspectionIsCurrent(inspection)) return Object.freeze({ state: 'unknown', reason: 'protocol-drift' })
  return Object.freeze({ state: 'exact', value })
}

type RuntimeFactFailure = Readonly<{
  state: 'dead' | 'foreign' | 'unknown'
  reason: string
}>

type ExpectedProcessObservation =
  | Readonly<{ state: 'exact'; facts: DaemonAliveProcessFacts }>
  | RuntimeFactFailure

type RuntimeFactSnapshot = Readonly<{
  state: 'exact'
  rootProcess: DaemonAliveProcessFacts
  apiProcess: DaemonAliveProcessFacts
  processTree: DaemonExactProcessTree
  listener: Extract<DaemonListenerFacts, { state: 'present' }>
}>

type RuntimeInstanceObservation =
  | Readonly<{
      state: 'exact'
      snapshot: RuntimeFactSnapshot
      health: Extract<DaemonRuntimeHealthFacts, { state: 'exact' }>
    }>
  | RuntimeFactFailure

function factFailure(state: RuntimeFactFailure['state'], reason: string): RuntimeFactFailure {
  return Object.freeze({ state, reason })
}

function expectedProcess(
  value: unknown,
  expectedPid: number,
  instance: DaemonInstanceRecordV1,
  label: 'root' | 'api' | 'listener-owner'
): ExpectedProcessObservation {
  const facts = normalizeProcessFacts(value, expectedPid)
  if (facts.state === 'dead') return factFailure('dead', `${label}-process-dead`)
  if (facts.state === 'unknown') return factFailure('unknown', `${label}-process-unknown`)
  if (facts.processIdentity !== instance.processIdentity) {
    return factFailure('foreign', `${label}-process-identity-mismatch`)
  }
  if (facts.pgid !== instance.pgid) return factFailure('foreign', `${label}-process-pgid-mismatch`)
  return Object.freeze({ state: 'exact' as const, facts })
}

async function sampleExpectedProcess(
  inspection: DaemonProtocolInspection,
  processHost: DaemonProcessHost,
  instance: DaemonInstanceRecordV1,
  pid: number,
  label: 'root' | 'api' | 'listener-owner'
): Promise<ExpectedProcessObservation> {
  const sampled = await sampleProtocolBound(inspection, () => processHost.processFacts(pid))
  if (sampled.state !== 'exact') return factFailure('unknown', sampled.reason)
  return expectedProcess(sampled.value, pid, instance, label)
}

async function collectRuntimeFactSnapshot(
  inspection: DaemonProtocolInspection,
  processHost: DaemonProcessHost,
  instance: DaemonInstanceRecordV1
): Promise<RuntimeFactSnapshot | RuntimeFactFailure> {
  const root = await sampleExpectedProcess(inspection, processHost, instance, instance.pid, 'root')
  if (root.state !== 'exact') return root
  const api = instance.pid === instance.apiPid
    ? root
    : await sampleExpectedProcess(inspection, processHost, instance, instance.apiPid, 'api')
  if (api.state !== 'exact') return api

  const sampledTree = await sampleProtocolBound(
    inspection,
    () => processHost.processTree(instance.pid, instance.processIdentity)
  )
  if (sampledTree.state !== 'exact') return factFailure('unknown', sampledTree.reason)
  const tree = normalizeProcessTree(sampledTree.value, instance.pid, instance.processIdentity)
  if (tree.state !== 'exact') return factFailure('unknown', 'process-tree-unknown')
  const rootEntry = tree.entries.find((entry) => entry.pid === instance.pid)
  if (!rootEntry || !sameProcess(rootEntry, root.facts)) {
    return factFailure('unknown', 'process-tree-root-facts-drift')
  }
  const apiEntry = tree.entries.find((entry) => entry.pid === instance.apiPid)
  if (!apiEntry) return factFailure('foreign', 'api-process-not-in-root-tree')
  if (apiEntry.processIdentity !== instance.processIdentity || apiEntry.pgid !== instance.pgid) {
    return factFailure('foreign', 'api-process-tree-authority-mismatch')
  }
  if (!sameProcess(apiEntry, api.facts)) return factFailure('unknown', 'process-tree-api-facts-drift')

  const sampledListener = await sampleProtocolBound(inspection, () => processHost.listenerFacts(instance.port))
  if (sampledListener.state !== 'exact') return factFailure('unknown', sampledListener.reason)
  const listener = normalizeListenerFacts(sampledListener.value, instance.port)
  if (listener.state === 'unknown') return factFailure('unknown', 'listener-facts-unknown')
  if (listener.state === 'absent') return factFailure('dead', 'listener-absent')
  if (listener.bindings.some((binding) => !isLoopbackListenerBinding(binding))) {
    return factFailure('foreign', 'listener-address-not-loopback')
  }
  if (listener.pids.length !== 1 || listener.pids[0] !== instance.apiPid
    || listener.bindings.some((binding) => binding.pid !== instance.apiPid)) {
    return factFailure('foreign', 'listener-owner-mismatch')
  }

  return Object.freeze({
    state: 'exact' as const,
    rootProcess: root.facts,
    apiProcess: api.facts,
    processTree: tree,
    listener
  })
}

function sameRuntimeFactSnapshot(left: RuntimeFactSnapshot, right: RuntimeFactSnapshot): boolean {
  return sameProcess(left.rootProcess, right.rootProcess) && sameProcess(left.apiProcess, right.apiProcess)
    && sameProcessTree(left.processTree, right.processTree) && sameListener(left.listener, right.listener)
}

async function observeFrozenDaemonInstance(
  inspection: DaemonProtocolInspection,
  instance: DaemonInstanceRecordV1,
  processHost: DaemonProcessHost,
  healthProbe: DaemonRuntimeHealthProbe
): Promise<RuntimeInstanceObservation> {
  let hostPlatform: string
  try {
    hostPlatform = processHost.platform
  } catch {
    return factFailure('unknown', 'process-host-platform-unknown')
  }
  if (typeof hostPlatform !== 'string' || hostPlatform !== inspection.proof.platform) {
    return factFailure('unknown', 'process-host-platform-mismatch')
  }

  const before = await collectRuntimeFactSnapshot(inspection, processHost, instance)
  if (before.state !== 'exact') return before
  const healthRequest: DaemonRuntimeHealthProbeRequest = Object.freeze({
    port: instance.port,
    epochId: instance.epochId,
    packageRoot: instance.packageRoot,
    dataRoot: instance.dataRoot,
    pid: instance.pid,
    apiPid: instance.apiPid
  })
  const sampledHealth = await sampleProtocolBound(inspection, () => healthProbe(healthRequest))
  if (sampledHealth.state !== 'exact') return factFailure('unknown', sampledHealth.reason)
  const health = normalizeHealthFacts(sampledHealth.value)
  if (health.state === 'dead') return factFailure('dead', 'health-dead')
  if (health.state === 'foreign') return factFailure('foreign', 'health-foreign')
  if (health.state === 'unknown') return factFailure('unknown', 'health-unknown')
  if (health.epochId !== instance.epochId
    || !sameRuntimePath(health.packageRoot, instance.packageRoot, inspection.proof.platform)
    || !sameRuntimePath(health.dataRoot, instance.dataRoot, inspection.proof.platform)) {
    return factFailure('foreign', 'health-authority-mismatch')
  }

  const after = await collectRuntimeFactSnapshot(inspection, processHost, instance)
  if (after.state !== 'exact') return after
  if (!sameRuntimeFactSnapshot(before, after)) return factFailure('unknown', 'runtime-facts-drift')
  if (!inspectionIsCurrent(inspection)) return factFailure('unknown', 'protocol-drift')
  return Object.freeze({ state: 'exact' as const, snapshot: after, health })
}

function authorityFailure(
  state: RuntimeFactFailure['state'],
  inspection: DaemonProtocolInspection | null,
  reason: string
): DaemonAuthorityObservation {
  return Object.freeze({
    state,
    protocolKind: inspection?.kind || null,
    inspection,
    reason
  })
}

/**
 * Resolves public daemon authority without consulting legacy marker fallbacks.
 * Only RUNNING-CLEAN can become an exact live observation.
 */
export async function observeDaemonAuthority(
  runtimeOptions: DaemonRuntimeProtocolOptions,
  processHost: DaemonProcessHost,
  healthProbe: DaemonRuntimeHealthProbe
): Promise<DaemonAuthorityObservation> {
  let options: InspectDaemonProtocolOptions
  let inspection: DaemonProtocolInspection
  try {
    options = protocolOptions(runtimeOptions)
    inspection = inspectDaemonProtocol(options)
  } catch {
    return authorityFailure('unknown', null, 'protocol-inspection-unavailable')
  }
  if (inspection.kind === 'INVALID') {
    return Object.freeze({
      state: 'control-required' as const,
      protocolKind: inspection.kind,
      inspection
    })
  }
  if (!inspectionIsCurrent(inspection)) return authorityFailure('unknown', inspection, 'protocol-drift')
  if (inspection.kind === 'ABSENT' || inspection.kind === 'NAMESPACE-RECOVERABLE'
    || inspection.kind === 'LEGACY-NAMESPACE-RECOVERABLE') {
    return Object.freeze({ state: 'not-running' as const, protocolKind: inspection.kind, inspection })
  }
  if (inspection.kind !== 'RUNNING-CLEAN') {
    return Object.freeze({ state: 'control-required' as const, protocolKind: inspection.kind, inspection })
  }
  if (!inspection.instance) return authorityFailure('unknown', inspection, 'running-instance-missing')
  const observed = await observeFrozenDaemonInstance(inspection, inspection.instance, processHost, healthProbe)
  if (observed.state !== 'exact') return authorityFailure(observed.state, inspection, observed.reason)
  return Object.freeze({
    state: 'exact' as const,
    protocolKind: 'RUNNING-CLEAN' as const,
    inspection,
    instance: inspection.instance,
    rootProcess: observed.snapshot.rootProcess,
    apiProcess: observed.snapshot.apiProcess,
    processTree: observed.snapshot.processTree,
    listener: observed.snapshot.listener,
    health: observed.health
  })
}

/** Creates the process/listener/health observer used by START reconciliation. */
export function createDaemonRuntimeReconcilePort(
  runtimeOptions: DaemonRuntimeProtocolOptions,
  processHost: DaemonProcessHost,
  healthProbe: DaemonRuntimeHealthProbe
): DaemonRuntimeReconcilePort {
  const capturedOptions: DaemonRuntimeProtocolOptions = Object.freeze({
    home: runtimeOptions.home,
    dataRoot: runtimeOptions.dataRoot,
    ...(runtimeOptions.platform ? { platform: runtimeOptions.platform } : {}),
    readReceiptAuthority: runtimeOptions.readReceiptAuthority
  })
  let hostPlatform: string | null = null
  try {
    hostPlatform = processHost.platform
  } catch {
    // A hostile or unavailable provider stays permanently fail-closed.
  }
  const expectedPlatform = capturedOptions.platform || process.platform

  return Object.freeze({
    async observeActor(pid: number): Promise<DaemonStartActorProbeFacts> {
      if (hostPlatform !== expectedPlatform) return UNKNOWN_PROCESS
      let value: unknown
      try {
        value = processHost.processFacts(pid)
      } catch {
        return UNKNOWN_PROCESS
      }
      const facts = normalizeProcessFacts(value, pid)
      if (facts.state !== 'alive') return facts
      return Object.freeze({ state: 'alive' as const, processIdentity: facts.processIdentity, pgid: facts.pgid })
    },
    async observeRunning(instance: DaemonInstanceRecordV1): Promise<DaemonRunningObservation> {
      if (hostPlatform !== expectedPlatform) return Object.freeze({ state: 'unknown' as const })
      let inspection: DaemonProtocolInspection
      try {
        inspection = inspectDaemonProtocol(protocolOptions(capturedOptions))
      } catch {
        return Object.freeze({ state: 'unknown' as const })
      }
      if (!inspection.instance || !sameInstanceAuthority(inspection.instance, instance, expectedPlatform)
        || inspection.kind !== 'STARTING' && inspection.kind !== 'RUNNING-LINKED'
          && inspection.kind !== 'RUNNING-COLLAPSING' && inspection.kind !== 'RUNNING-CLEAN') {
        return Object.freeze({ state: 'unknown' as const })
      }
      const observed = await observeFrozenDaemonInstance(inspection, inspection.instance, processHost, healthProbe)
      return Object.freeze({ state: observed.state })
    }
  })
}

function issuedEmptySignature(value: DaemonRuntimeEmptyAuthority): string {
  return JSON.stringify({ kind: value.kind, namespaceId: value.namespaceId })
}

function issueEmptyAuthority(
  options: InspectDaemonProtocolOptions,
  authority: DaemonStageNamespaceAuthority
): DaemonRuntimeEmptyAuthority {
  const issued = Object.freeze({ kind: 'EMPTY' as const, namespaceId: authority.namespaceId })
  privateEmptyAuthorities.set(issued, {
    options,
    authority,
    issuedSignature: issuedEmptySignature(issued)
  })
  return issued
}

function privateEmptyAuthority(issued: DaemonRuntimeEmptyAuthority): PrivateEmptyAuthority {
  const privateAuthority = privateEmptyAuthorities.get(issued)
  if (!privateAuthority || issuedEmptySignature(issued) !== privateAuthority.issuedSignature) {
    throw new Error('daemon runtime empty authority was not issued by this runtime')
  }
  return privateAuthority
}

function exactRunningObservation(value: DaemonRunningObservation): boolean {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 1 && value.state === 'exact')
}

function existingResult(inspection: DaemonProtocolInspection): DaemonRuntimeReconcileResult {
  if (inspection.kind !== 'RUNNING-CLEAN' || !inspection.instance) {
    throw new Error('daemon runtime reconciliation did not reach RUNNING-CLEAN')
  }
  return Object.freeze({ kind: 'EXISTING' as const, inspection, instance: inspection.instance })
}

/**
 * Reconciles only START-owned protocol residue. STOP and LEGACY mutation are a
 * separate D2 authority and deliberately remain fail-closed here.
 */
export async function reconcileDaemonRuntimeForStart(
  runtimeOptions: DaemonRuntimeProtocolOptions,
  port: DaemonRuntimeReconcilePort,
  checkpoint: DaemonProtocolCheckpoint = () => {}
): Promise<DaemonRuntimeReconcileResult> {
  const options = protocolOptions(runtimeOptions)
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const inspection = inspectDaemonProtocol(options)
    if (inspection.kind === 'INVALID') {
      throw new Error(inspection.reason || 'daemon protocol state is invalid')
    }
    if (inspection.kind === 'ABSENT' || inspection.kind === 'NAMESPACE-RECOVERABLE') {
      const receipt = inspectDaemonReceiptNamespace(
        options.home,
        options.dataRoot,
        options.readReceiptAuthority,
        options.platform
      )
      const authority = bootstrapDaemonStageNamespace({
        ...options,
        expectedInspection: inspection,
        expectedReceiptAuthority: receipt,
        checkpoint
      })
      const terminal = inspectDaemonProtocol(options)
      if (terminal.kind !== 'ABSENT') {
        throw new Error(`daemon bootstrap reached unexpected ${terminal.kind}`)
      }
      assertDaemonInspectionCurrent(terminal)
      return issueEmptyAuthority(options, authority)
    }
    if (inspection.kind === 'STARTING-PARTIAL' || inspection.kind === 'STARTING') {
      if (!inspection.reservation) throw new Error('daemon START residue has no reservation')
      const actorFacts = await port.observeActor(inspection.reservation.actorPid)
      assertDaemonInspectionCurrent(inspection)
      const actorOwnsCompleteStart = inspection.kind === 'STARTING' && inspection.instance
        && actorFacts.state === 'alive'
        && actorFacts.processIdentity === inspection.instance.processIdentity
        && actorFacts.pgid === inspection.instance.pgid
      if (actorOwnsCompleteStart && inspection.instance
        && exactRunningObservation(await port.observeRunning(inspection.instance))) {
        assertDaemonInspectionCurrent(inspection)
        const stage = recoverDaemonStartStage(options, inspection, checkpoint)
        const order = ['pid', 'apiPid', 'heartbeat'] as const
        for (const projection of order.slice(inspection.publicProjectionCount)) {
          publishDaemonStartProjection(stage, projection, checkpoint)
        }
        commitDaemonStartInstance(stage, checkpoint)
        const linked = inspectDaemonProtocol(options)
        const collapsed = collapseCommittedDaemonStart(
          acquireCommittedDaemonStartCollapseAuthority(options, linked),
          checkpoint
        )
        return existingResult(collapsed)
      }
      const cleanup = acquireAbandonedDaemonStartCleanupAuthority(
        options,
        inspection,
        () => actorFacts
      )
      cleanupAbandonedDaemonStart(cleanup, checkpoint)
      continue
    }
    if (inspection.kind === 'RUNNING-LINKED' || inspection.kind === 'RUNNING-COLLAPSING') {
      if (!inspection.instance) throw new Error('committed daemon START has no instance')
      const observed = await port.observeRunning(inspection.instance)
      assertDaemonInspectionCurrent(inspection)
      if (!exactRunningObservation(observed)) {
        throw new Error(`committed daemon START is not an exact live instance: ${observed.state}`)
      }
      const collapsed = collapseCommittedDaemonStart(
        acquireCommittedDaemonStartCollapseAuthority(options, inspection),
        checkpoint
      )
      return existingResult(collapsed)
    }
    if (inspection.kind === 'RUNNING-CLEAN') {
      if (!inspection.instance) throw new Error('running daemon protocol has no instance')
      const observed = await port.observeRunning(inspection.instance)
      assertDaemonInspectionCurrent(inspection)
      if (!exactRunningObservation(observed)) {
        throw new Error(`running daemon authority is not an exact live instance: ${observed.state}`)
      }
      return existingResult(inspection)
    }
    if (inspection.kind === 'LEGACY') {
      throw new Error('legacy daemon state requires D2 retirement before v1 startup')
    }
    throw new Error(`daemon ${inspection.kind} requires D2 control recovery before startup`)
  }
  throw new Error('daemon START reconciliation did not converge')
}

export type DaemonRuntimeStartSeals = Readonly<{
  sealStatic(): void
  sealRuntime(candidate: DaemonRuntimeStartCandidate): Promise<void>
}>

export async function commitDaemonRuntimeStart(
  issuedAuthority: DaemonRuntimeEmptyAuthority,
  candidate: DaemonRuntimeStartCandidate,
  seals: DaemonRuntimeStartSeals,
  checkpoint?: DaemonProtocolCheckpoint
): Promise<DaemonProtocolInspection> {
  const privateAuthority = privateEmptyAuthority(issuedAuthority)
  const capturedCandidate: DaemonRuntimeStartCandidate = Object.freeze({
    epochId: candidate.epochId,
    pid: candidate.pid,
    apiPid: candidate.apiPid,
    processIdentity: candidate.processIdentity,
    pgid: candidate.pgid,
    port: candidate.port,
    createdAt: candidate.createdAt
  })
  const sealedCheckpoint: DaemonProtocolCheckpoint = (name, facts) => {
    seals.sealStatic()
    if (checkpoint) {
      checkpoint(name, facts)
      seals.sealStatic()
    }
  }
  const sealRuntime = async () => {
    seals.sealStatic()
    await seals.sealRuntime(capturedCandidate)
    seals.sealStatic()
  }
  await sealRuntime()
  const stage = createDaemonStartStage(privateAuthority.authority, {
    ...(capturedCandidate as CreateDaemonStartStageOptions),
    checkpoint: sealedCheckpoint
  })
  await sealRuntime()
  for (const projection of ['pid', 'apiPid', 'heartbeat'] as const) {
    publishDaemonStartProjection(stage, projection, sealedCheckpoint)
    await sealRuntime()
  }
  commitDaemonStartInstance(stage, sealedCheckpoint)
  await sealRuntime()
  const linked = inspectDaemonProtocol(privateAuthority.options)
  assertDaemonInspectionCurrent(linked)
  const terminal = collapseCommittedDaemonStart(
    acquireCommittedDaemonStartCollapseAuthority(privateAuthority.options, linked),
    sealedCheckpoint
  )
  await sealRuntime()
  if (terminal.kind !== 'RUNNING-CLEAN' || terminal.instance?.epochId !== capturedCandidate.epochId) {
    throw new Error('daemon runtime START did not publish the exact candidate epoch')
  }
  assertDaemonInspectionCurrent(terminal)
  return terminal
}
