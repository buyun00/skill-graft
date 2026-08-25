import { createHub } from '../adapters/create-hub.js'
import { createDurableTransactionHost } from '../adapters/durable-state.js'
import {
  applicationLeaseRoot,
  assertApplicationLeaseNamespaceSafe,
  assertLegacyApplicationLeaseNamespaceClear,
  createLeaseLockManager,
  type LeaseProcessInspector
} from '../adapters/lease-lock.js'
import { createLocalDurableSchemaResolver } from '../adapters/local-durable-schema.js'
import { createLocalMaterializationRecordPort } from '../adapters/local-materialization-records.js'
import { createLocalMaterializer } from '../adapters/local-materializer.js'
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
  type P2ApplicationPorts,
  type P3ApplicationPorts,
  type RequestLedgerPort,
  type SessionPort
} from '../application/index.js'
import { CONTRACT_VERSION, isPortableOpaqueIdentifier, type CommandMeta } from '../contracts/index.js'
import type { LocalHostContext } from '../adapters/host-context.js'
import { createDshRuntimeAssetRepository } from './runtime-assets.js'

export type DshHost = {
  packageRoot: string
  dataRoot: string
  hostId: string
  context: LocalHostContext
  sessions: SessionPort
  ledger: RequestLedgerPort
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
}

function disabledLegacyPort(): LegacyAttachPort & LegacyDetachPort {
  const unavailable = (): never => {
    throw new Error('legacy live-link operations are not available in the DSH host')
  }
  return { inspect: unavailable, apply: unavailable }
}

/** P6/P7 intentionally expose no runner. P8 replaces this only after P5 freezes the shared contract. */
function unavailableSessions(): SessionPort {
  const unavailable = (): never => {
    throw new Error('DSH SessionRunner is unavailable until the shared P5 contract is consumed')
  }
  return {
    list: () => [],
    get: () => null,
    start: unavailable,
    resume: unavailable,
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
    schemaFor: createLocalDurableSchemaResolver(),
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
  const sessions = unavailableSessions()
  const ledger = createPersistentRequestLedger(context)
  const legacy = disabledLegacyPort()
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
    legacyAttach: legacy,
    legacyDetach: legacy,
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
    ledger,
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
      await Promise.allSettled([inFlightReady, inFlightRecovery].filter(Boolean) as Promise<void>[])
    }
  }
}

export async function openDshHost(options: CreateDshHostOptions): Promise<DshHost> {
  const host = createDshHost(options)
  await host.ready()
  return host
}
