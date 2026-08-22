import { createHub } from '../adapters/create-hub.js'
import { createDurableTransactionHost } from '../adapters/durable-state.js'
import { createLeaseLockManager } from '../adapters/lease-lock.js'
import { createLocalApplicationPorts } from '../adapters/local-application-ports.js'
import { createLocalDurableSchemaResolver } from '../adapters/local-durable-schema.js'
import { createLocalInvocationTraceAdapter } from '../adapters/local-invocation-trace.js'
import {
  createLocalP2ApplicationPorts,
  localLibraryCaptureRoots
} from '../adapters/local-p2-ports.js'
import { createPersistentRequestLedger } from '../adapters/persistent-request-ledger.js'
import { createSnapshotRepository } from '../adapters/snapshot-repository.js'
import { createHubApplication, type HubApplication } from '../application/index.js'
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
  transactions?: ApplicationTransactionPort
  runtimeRevision?: string
  leaseMs?: number
  renewalIntervalMs?: number
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
  if (Boolean(options.p2) !== Boolean(options.transactions)) {
    throw new Error('p2 and transactions must be supplied together')
  }
  const trace = options.trace ?? createLocalInvocationTraceAdapter({
    packageRoot: options.packageRoot,
    env: options.traceEnvironment
  })
  let context = options.context || createHub(options.dataRoot || options.packageRoot)
  const hostId = options.hostId || 'local'
  let p2 = options.p2
  let transactions = options.transactions
  let ensureReady = async () => {}

  if (!p2 || !transactions) {
    const lock = createLeaseLockManager({
      root: context.path.join(context.hubRoot, 'skill-review', 'locks'),
      leaseMs: options.leaseMs ?? 30_000
    })
    const durable = createDurableTransactionHost({
      root: context.hubRoot,
      schemaFor: createLocalDurableSchemaResolver(),
      lock,
      renewalIntervalMs: options.renewalIntervalMs ?? 10_000
    })
    context = { ...context, persist: durable.persist }
    const queries = createLocalApplicationPorts(context).queries
    const snapshots = createSnapshotRepository({
      root: context.path.join(context.hubRoot, 'skill-review', 'library'),
      sourceRoot: context.hubRoot,
      source: { kind: 'library', id: 'skill-graft-library' },
      captureRoots: () => localLibraryCaptureRoots(context),
      persist: durable.persist
    })
    p2 = createLocalP2ApplicationPorts(context, {
      runtimeRevision: runtimeRevisionOf(context, options.packageRoot, options.runtimeRevision),
      queries,
      snapshots,
      persist: durable.persist
    })
    transactions = durable.transactions
    let inFlightRecovery: Promise<void> | undefined
    ensureReady = () => {
      if (inFlightRecovery) return inFlightRecovery
      const attempt = durable.recover({
        scope: 'hub-global',
        key: 'hub-global',
        hostId,
        commandKind: 'migrateState',
        requestId: 'startup-recovery'
      }).then(() => undefined)
      inFlightRecovery = attempt
      const clear = () => {
        if (inFlightRecovery === attempt) inFlightRecovery = undefined
      }
      // Use both settlement handlers instead of an ignored finally promise so
      // a rejected recovery cannot create a secondary unhandled rejection.
      void attempt.then(clear, clear)
      return attempt
    }
  }
  const localSessions = options.sessions ? undefined : createLocalSessionPort(context, options.localSessionOptions)
  const sessions = options.sessions || localSessions as LocalSessionPort
  const ledger = options.ledger || createPersistentRequestLedger(context)
  const applicationPorts = createLocalApplicationPorts(context)
  const application = createHubApplication({
    ...applicationPorts,
    recovery: { recover: ensureReady },
    sessions,
    ledger,
    p2,
    transactions,
    trace
  })
  return {
    packageRoot: options.packageRoot,
    dataRoot: context.hubRoot,
    hostId,
    context,
    sessions,
    localSessions,
    ledger,
    application,
    ready: ensureReady,
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
