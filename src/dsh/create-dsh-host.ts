import { createHub } from '../adapters/create-hub.js'
import { createDurableTransactionHost } from '../adapters/durable-state.js'
import {
  applicationLeaseRoot,
  assertApplicationLeaseNamespaceSafe,
  assertLegacyApplicationLeaseNamespaceClear,
  createLeaseLockManager,
  type LeaseProcessInspector
} from '../adapters/lease-lock.js'
import { createLocalMaterializationRecordPort } from '../adapters/local-materialization-records.js'
import { createLocalMaterializer } from '../adapters/local-materializer.js'
import {
  createLocalLegacyAttachPort,
  createLocalLegacyDetachPort
} from '../adapters/local-legacy-attach-port.js'
import { createLocalP2ApplicationPorts, localLibraryCaptureRoots } from '../adapters/local-p2-ports.js'
import { createLocalQueryPort } from '../adapters/local-query-port.js'
import { createLocalUseCasePorts } from '../adapters/local-use-case-ports.js'
import { createPersistentRequestLedger } from '../adapters/persistent-request-ledger.js'
import { createSnapshotRepository } from '../adapters/snapshot-repository.js'
import {
  createHubApplication,
  type HubApplication,
  type LegacyAttachPort,
  type LegacyDetachPort,
  type LibrarySnapshotRepositoryPort,
  type P2ApplicationPorts,
  type P3ApplicationPorts,
  type RequestLedgerPort,
  type SessionPort,
  type SessionRunnerPort,
  type SnapshotContentPort
} from '../application/index.js'
import { CONTRACT_VERSION, isPortableOpaqueIdentifier, type CommandMeta } from '../contracts/index.js'
import type { LocalHostContext } from '../adapters/host-context.js'
import { createDshRuntimeAssetRepository } from './runtime-assets.js'
import type { DshSessionRuntime } from './session-runtime.js'
import { createDshDurableSchemaResolver } from './durable-schema.js'

export type DshHost = {
  packageRoot: string
  dataRoot: string
  hostId: string
  context: LocalHostContext
  sessions: SessionPort
  runner?: SessionRunnerPort
  ledger: RequestLedgerPort
  snapshots: LibrarySnapshotRepositoryPort & SnapshotContentPort
  p2: P2ApplicationPorts
  p3: P3ApplicationPorts
  application: HubApplication
  ready(): Promise<void>
  commandMeta(transport: string, requestId?: string): CommandMeta
  dispose(): Promise<void>
}

export type CreateDshHostOptions = {
  packageRoot: string
  dataRoot: string
  hostId?: string
  runtimeRevision?: string
  leaseMs?: number
  renewalIntervalMs?: number
  leaseProcessInspector?: LeaseProcessInspector
  createSessionRuntime?: (context: LocalHostContext) => DshSessionRuntime
}

/**
 * The shared Application validates session targets through the legacy
 * inspection shape before it creates an attach/detach task. DSH consumes only
 * that read boundary; legacy live-link writes stay unavailable in this host.
 */
function inspectionOnlyLegacyPorts(
  context: LocalHostContext,
  inspectWorktree: ReturnType<typeof createLocalQueryPort>['inspectWorktree']
): { legacyAttach: LegacyAttachPort; legacyDetach: LegacyDetachPort } {
  const unavailable = (): never => {
    throw new Error('legacy live-link writes are not available in the DSH host')
  }
  const attach = createLocalLegacyAttachPort(context, inspectWorktree)
  const detach = createLocalLegacyDetachPort(context, inspectWorktree)
  return {
    legacyAttach: { inspect: attach.inspect, apply: unavailable },
    legacyDetach: { inspect: detach.inspect, apply: unavailable }
  }
}

/** Focused P6/P7 host tests may omit DSH services; production P8 always injects a runtime. */
function unavailableSessions(): SessionPort {
  const unavailable = (): never => {
    throw new Error('DSH SessionRunner is unavailable until the shared P5 contract is consumed')
  }
  return {
    list: () => [],
    get: () => null,
    start: unavailable,
    resume: unavailable,
    cancel: unavailable,
    reap: () => [],
    completeAttach: () => ({ status: 'not-authorized', reason: 'not-found' })
  }
}

function runtimeRevisionOf(context: LocalHostContext, packageRoot: string, explicit?: string): string {
  if (explicit?.trim()) {
    if (!isPortableOpaqueIdentifier(explicit.trim())) throw new Error('runtime revision is invalid')
    return explicit.trim()
  }
  const raw = context.fs.readText(context.path.join(packageRoot, 'package.json'))
  if (!raw) throw new Error('DSH package metadata is unavailable')
  let version: unknown
  try {
    version = (JSON.parse(raw) as { version?: unknown }).version
  } catch {
    throw new Error('DSH package metadata is invalid')
  }
  if (typeof version !== 'string' || !isPortableOpaqueIdentifier(version)) {
    throw new Error('DSH package version is invalid')
  }
  return version
}

export function createDshHost(options: CreateDshHostOptions): DshHost {
  if (!options || !options.packageRoot || !options.dataRoot) {
    throw new Error('DSH packageRoot and dataRoot are required')
  }
  let context = createHub(options.dataRoot)
  const packageRoot = context.path.resolve(options.packageRoot)
  const hostId = options.hostId || 'dsh'
  assertLegacyApplicationLeaseNamespaceClear(context.hubRoot)
  const leaseRoot = applicationLeaseRoot(context.hubRoot)
  assertApplicationLeaseNamespaceSafe(leaseRoot)
  const lock = createLeaseLockManager({
    root: leaseRoot,
    preflightRoot() {
      const rebound = applicationLeaseRoot(context.hubRoot)
      const same = process.platform === 'win32'
        ? rebound.toLowerCase() === leaseRoot.toLowerCase()
        : rebound === leaseRoot
      if (!same) throw new Error('DSH data root changed after lease namespace binding')
    },
    leaseMs: options.leaseMs ?? 30_000,
    ...(options.leaseProcessInspector ? { processInspector: options.leaseProcessInspector } : {})
  })
  const durable = createDurableTransactionHost({
    root: context.hubRoot,
    schemaFor: createDshDurableSchemaResolver(),
    lock,
    renewalIntervalMs: options.renewalIntervalMs ?? 10_000
  })
  context = { ...context, persist: durable.persist }
  const queries = createLocalQueryPort(context)
  const snapshots = createSnapshotRepository({
    root: context.path.join(context.hubRoot, 'skill-review', 'library'),
    sourceRoot: context.hubRoot,
    source: { kind: 'library', id: 'skill-graft-library' },
    captureRoots: () => localLibraryCaptureRoots(context),
    persist: durable.persist
  })
  const runtimeRevision = runtimeRevisionOf(context, packageRoot, options.runtimeRevision)
  const p2 = createLocalP2ApplicationPorts(context, {
    runtimeRevision,
    queries,
    snapshots,
    persist: durable.persist
  })
  const runtimeAssets = createDshRuntimeAssetRepository({ packageRoot, runtimeRevision })
  const p3 = {
    runtimeAssets,
    materialize: createLocalMaterializer({
      packageRoot,
      dataRoot: context.hubRoot,
      identities: p2.identities,
      snapshots,
      runtimeAssets,
      legacySourceRoot: context.hubRoot
    }),
    records: createLocalMaterializationRecordPort(context, durable.persist)
  }
  const sessionRuntime = options.createSessionRuntime?.(context)
  const sessions = sessionRuntime?.sessions || unavailableSessions()
  const ledger = createPersistentRequestLedger(context)
  const legacy = inspectionOnlyLegacyPorts(context, queries.inspectWorktree)
  const recoveryIdentity = {
    scope: 'hub-global',
    key: 'hub-global',
    hostId,
    commandKind: 'migrateState',
    requestId: 'startup-recovery'
  } as const
  let ready = false
  let disposed = false
  let inFlightReady: Promise<void> | undefined
  let inFlightRecovery: Promise<void> | undefined

  const recoverDurable = (): Promise<void> => {
    if (disposed) return Promise.reject(new Error('DSH host is disposed'))
    if (inFlightRecovery) return inFlightRecovery
    const operation = durable.recover(recoveryIdentity).then(() => undefined)
    inFlightRecovery = operation.finally(() => { inFlightRecovery = undefined })
    return inFlightRecovery
  }
  const ensureReady = (): Promise<void> => {
    if (disposed) return Promise.reject(new Error('DSH host is disposed'))
    if (ready) return Promise.resolve()
    if (inFlightReady) return inFlightReady
    const operation = recoverDurable().then(async () => {
      const acquired = await lock.acquire(recoveryIdentity)
      if (acquired.status !== 'acquired') {
        throw new Error(`DSH startup lease recovery is busy (${acquired.reason})`)
      }
      try {
        await lock.reapOrphanedWorktreeLeases(acquired.lease.ownerToken, async () => {
          await acquired.lease.renew()
        })
      } finally {
        await acquired.lease.release()
      }
    })
    inFlightReady = operation.then(
      () => { ready = true; inFlightReady = undefined },
      (error: unknown) => { inFlightReady = undefined; throw error }
    )
    return inFlightReady
  }
  const application = createHubApplication({
    runtime: {
      nowIso: () => context.clock.nowIso(),
      nextId: (scope) => context.ids.next(scope),
      sha256: (value) => context.hash.sha256(value)
    },
    recovery: { recover: async () => { await ensureReady(); await recoverDurable() } },
    queries,
    useCases: createLocalUseCasePorts(context),
    legacyAttach: legacy.legacyAttach,
    legacyDetach: legacy.legacyDetach,
    sessions,
    ledger,
    p2,
    p3,
    transactions: durable.transactions
  })

  return {
    packageRoot,
    dataRoot: context.hubRoot,
    hostId,
    context,
    sessions,
    runner: sessionRuntime?.runner,
    ledger,
    snapshots,
    p2,
    p3,
    application,
    ready: ensureReady,
    commandMeta(transport, requestId) {
      return {
        contractVersion: CONTRACT_VERSION,
        requestId: requestId || context.ids.next(`request-${transport}`),
        hostId,
        transport
      }
    },
    async dispose() {
      disposed = true
      await sessionRuntime?.dispose()
      await Promise.allSettled([inFlightReady, inFlightRecovery].filter(Boolean) as Promise<void>[])
    }
  }
}

export async function openDshHost(options: CreateDshHostOptions): Promise<DshHost> {
  const host = createDshHost(options)
  await host.ready()
  return host
}
