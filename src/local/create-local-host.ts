import { createHub } from '../adapters/create-hub.js'
import { createDurableTransactionHost } from '../adapters/durable-state.js'
import {
  applicationLeaseRoot,
  assertApplicationLeaseNamespaceSafe,
  assertLegacyApplicationLeaseNamespaceClear,
  createLeaseLockManager,
  type LeaseProcessInspector
} from '../adapters/lease-lock.js'
import { createLocalApplicationPorts } from '../adapters/local-application-ports.js'
import { createLocalDurableSchemaResolver } from '../adapters/local-durable-schema.js'
import { createLocalInvocationTraceAdapter } from '../adapters/local-invocation-trace.js'
import { createLocalMaterializationRecordPort } from '../adapters/local-materialization-records.js'
import { createLocalMaterializer } from '../adapters/local-materializer.js'
import {
  createLocalP2ApplicationPorts,
  localLibraryCaptureRoots
} from '../adapters/local-p2-ports.js'
import { createLocalRuntimeAssetRepository } from '../adapters/local-runtime-assets.js'
import { createPersistentRequestLedger } from '../adapters/persistent-request-ledger.js'
import { createSnapshotRepository } from '../adapters/snapshot-repository.js'
import {
  createHubApplication,
  type HubApplication,
  type P3ApplicationPorts
} from '../application/index.js'
import { CONTRACT_VERSION, isPortableOpaqueIdentifier, type CommandMeta } from '../contracts/index.js'
import type { LocalHostContext } from '../adapters/host-context.js'
import { createLocalSessionPort, type LocalSessionPort, type LocalSessionPortOptions } from './session/local-session-port.js'
import type {
  InvocationTracePort,
  P2ApplicationPorts,
  RequestLedgerPort,
  SessionPort
} from '../application/ports.js'
import type { ApplicationTransactionPort } from '../application/transaction-port.js'

export type LocalHost = {
  packageRoot: string
  dataRoot: string
  hostId: string
  context: LocalHostContext
  sessions: SessionPort
  localSessions?: LocalSessionPort
  ledger: RequestLedgerPort
  application: HubApplication
  ready(): Promise<void>
  commandMeta(transport: string, requestId?: string): CommandMeta
}

export type CreateLocalHostOptions = {
  packageRoot: string
  dataRoot?: string
  hostId?: string
  context?: LocalHostContext
  sessions?: SessionPort
  ledger?: RequestLedgerPort
  trace?: InvocationTracePort
  traceEnvironment?: NodeJS.ProcessEnv
  localSessionOptions?: LocalSessionPortOptions
  p2?: P2ApplicationPorts
  p3?: P3ApplicationPorts
  transactions?: ApplicationTransactionPort
  runtimeRevision?: string
  leaseMs?: number
  renewalIntervalMs?: number
  leaseProcessInspector?: LeaseProcessInspector
}

function runtimeRevisionOf(context: LocalHostContext, packageRoot: string, explicit?: string): string {
  if (explicit?.trim()) return explicit.trim()
  let version = '0.0.0'
  const raw = context.fs.readText(context.path.join(packageRoot, 'package.json'))
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { version?: unknown }
      if (typeof parsed.version === 'string' && parsed.version.trim()) version = parsed.version.trim()
    } catch {
      throw new Error('runtime package metadata is invalid')
    }
  }
  // Installed packages are not necessarily Git worktrees and process-level
  // GIT_* variables are caller-controlled. The package version is therefore
  // the only implicit cross-host runtime identity; a trusted release builder
  // may inject an already-validated version+revision string explicitly.
  const value = version
  if (!isPortableOpaqueIdentifier(value)) {
    throw new Error('runtime revision is invalid')
  }
  return value
}

export function createLocalHost(options: CreateLocalHostOptions): LocalHost {
  const suppliedInfrastructure = [options.p2, options.p3, options.transactions]
    .filter((value) => value !== undefined)
    .length
  if (suppliedInfrastructure !== 0 && suppliedInfrastructure !== 3) {
    throw new Error('p2, p3, and transactions must be supplied together')
  }
  const trace = options.trace ?? createLocalInvocationTraceAdapter({
    packageRoot: options.packageRoot,
    env: options.traceEnvironment
  })
  let context = options.context || createHub(options.dataRoot || options.packageRoot)
  const hostId = options.hostId || 'local'
  let p2 = options.p2
  let p3 = options.p3
  let transactions = options.transactions
  let ensureReady = async () => {}
  let recoverBeforeCommand = async () => {}

  if (!p2 || !p3 || !transactions) {
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
        if (!same) throw new Error('local host data root changed after lease namespace binding')
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
    const queries = createLocalApplicationPorts(context, { packageRoot: options.packageRoot }).queries
    const snapshots = createSnapshotRepository({
      root: context.path.join(context.hubRoot, 'skill-review', 'library'),
      sourceRoot: context.hubRoot,
      source: { kind: 'library', id: 'skill-graft-library' },
      captureRoots: () => localLibraryCaptureRoots(context),
      persist: durable.persist
    })
    const runtimeRevision = runtimeRevisionOf(context, options.packageRoot, options.runtimeRevision)
    p2 = createLocalP2ApplicationPorts(context, {
      runtimeRevision,
      queries,
      snapshots,
      persist: durable.persist
    })
    if (!p3) {
      const runtimeAssets = createLocalRuntimeAssetRepository({
        packageRoot: options.packageRoot,
        runtimeRevision
      })
      p3 = {
        runtimeAssets,
        materialize: createLocalMaterializer({
          packageRoot: options.packageRoot,
          dataRoot: context.hubRoot,
          identities: p2.identities,
          snapshots,
          runtimeAssets,
          legacySourceRoot: context.hubRoot
        }),
        records: createLocalMaterializationRecordPort(context, durable.persist)
      }
    }
    transactions = durable.transactions
    const recoveryIdentity = {
      scope: 'hub-global',
      key: 'hub-global',
      hostId,
      commandKind: 'migrateState',
      requestId: 'startup-recovery'
    } as const
    // A WAL can appear after startup, so only concurrent durable recovery is
    // shared; a settled attempt is always cleared and the next command checks
    // the journal again.
    let inFlightDurableRecovery: Promise<void> | undefined
    const recoverDurable = (): Promise<void> => {
      if (inFlightDurableRecovery) return inFlightDurableRecovery
      const operation = durable.recover(recoveryIdentity).then(() => undefined)
      inFlightDurableRecovery = operation.then(
        () => { inFlightDurableRecovery = undefined },
        (error: unknown) => {
          inFlightDurableRecovery = undefined
          throw error
        }
      )
      return inFlightDurableRecovery
    }
    // Orphan lease reaping is a startup concern. Memoize only a successful
    // sweep for this host instance; a failed attempt must remain retryable.
    let startupReady = false
    let inFlightStartup: Promise<void> | undefined
    ensureReady = () => {
      if (startupReady) return Promise.resolve()
      if (inFlightStartup) return inFlightStartup
      const operation = recoverDurable().then(async () => {
        const acquired = await lock.acquire(recoveryIdentity)
        if (acquired.status !== 'acquired') {
          throw new Error(`startup lease recovery is busy (${acquired.reason})`)
        }
        try {
          await lock.reapOrphanedWorktreeLeases(acquired.lease.ownerToken, async () => acquired.lease.renew())
        } finally {
          await acquired.lease.release()
        }
      })
      inFlightStartup = operation.then(
        () => {
          startupReady = true
          inFlightStartup = undefined
        },
        (error: unknown) => {
          inFlightStartup = undefined
          throw error
        }
      )
      return inFlightStartup
    }
    recoverBeforeCommand = async () => {
      await ensureReady()
      await recoverDurable()
    }
  }
  const localSessions = options.sessions ? undefined : createLocalSessionPort(context, {
    ...options.localSessionOptions,
    packageRoot: options.packageRoot
  })
  const sessions = options.sessions || localSessions as LocalSessionPort
  const ledger = options.ledger || createPersistentRequestLedger(context)
  const applicationPorts = createLocalApplicationPorts(context, { packageRoot: options.packageRoot })
  const application = createHubApplication({
    ...applicationPorts,
    recovery: { recover: recoverBeforeCommand },
    sessions,
    ledger,
    p2,
    p3,
    transactions,
    trace
  })
  let sessionRecoveryCompleted = false
  let sessionRecoveryInFlight: Promise<void> | undefined
  const ensureSessionsRecovered = async () => {
    await ensureReady()
    if (!localSessions || sessionRecoveryCompleted) return
    if (sessionRecoveryInFlight) return sessionRecoveryInFlight
    const operation = application.execute({
      kind: 'reapSessions',
      meta: {
        contractVersion: CONTRACT_VERSION,
        requestId: context.ids.next('request-session-recovery'),
        hostId,
        transport: 'startup-recovery'
      }
    }).then((result) => {
      if (!result.ok) throw new Error(`startup session recovery failed (${result.error.code})`)
    })
    sessionRecoveryInFlight = operation.then(
      () => {
        sessionRecoveryCompleted = true
        sessionRecoveryInFlight = undefined
      },
      (error: unknown) => {
        sessionRecoveryInFlight = undefined
        throw error
      }
    )
    return sessionRecoveryInFlight
  }
  return {
    packageRoot: options.packageRoot,
    dataRoot: context.hubRoot,
    hostId,
    context,
    sessions,
    localSessions,
    ledger,
    application,
    ready: ensureSessionsRecovered,
    commandMeta(transport, requestId) {
      return {
        contractVersion: CONTRACT_VERSION,
        requestId: requestId || context.ids.next(`request-${transport}`),
        hostId,
        transport
      }
    }
  }
}

export async function openLocalHost(options: CreateLocalHostOptions): Promise<LocalHost> {
  const host = createLocalHost(options)
  await host.ready()
  return host
}
