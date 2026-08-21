import { createHub } from '../adapters/create-hub.js'
import { createLocalApplicationPorts } from '../adapters/local-application-ports.js'
import { createLocalInvocationTraceAdapter } from '../adapters/local-invocation-trace.js'
import { createPersistentRequestLedger } from '../adapters/persistent-request-ledger.js'
import { createHubApplication, type HubApplication } from '../application/index.js'
import { CONTRACT_VERSION, type CommandMeta } from '../contracts/index.js'
import type { LocalHostContext } from '../adapters/host-context.js'
import { createLocalSessionPort, type LocalSessionPort, type LocalSessionPortOptions } from './session/local-session-port.js'
import type { InvocationTracePort, RequestLedgerPort, SessionPort } from '../application/ports.js'

export type LocalHost = {
  packageRoot: string
  dataRoot: string
  hostId: string
  context: LocalHostContext
  sessions: SessionPort
  localSessions?: LocalSessionPort
  ledger: RequestLedgerPort
  application: HubApplication
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
}

export function createLocalHost(options: CreateLocalHostOptions): LocalHost {
  const trace = options.trace ?? createLocalInvocationTraceAdapter({
    packageRoot: options.packageRoot,
    env: options.traceEnvironment
  })
  const context = options.context || createHub(options.dataRoot || options.packageRoot)
  const localSessions = options.sessions ? undefined : createLocalSessionPort(context, options.localSessionOptions)
  const sessions = options.sessions || localSessions as LocalSessionPort
  const ledger = options.ledger || createPersistentRequestLedger(context)
  const hostId = options.hostId || 'local'
  const applicationPorts = createLocalApplicationPorts(context)
  const application = createHubApplication({ ...applicationPorts, sessions, ledger, trace })
  return {
    packageRoot: options.packageRoot,
    dataRoot: context.hubRoot,
    hostId,
    context,
    sessions,
    localSessions,
    ledger,
    application,
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
