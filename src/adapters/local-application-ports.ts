import type { ApplicationRuntimePort, HubQueryPort, LegacyAttachPort, LegacyDetachPort } from '../application/ports.js'
import type { SharedUseCasePorts } from '../application/use-case-ports.js'
import type { LocalHostContext } from './host-context.js'
import { createLocalLegacyAttachPort, createLocalLegacyDetachPort } from './local-legacy-attach-port.js'
import { createLocalQueryPort } from './local-query-port.js'
import { createLocalUseCasePorts } from './local-use-case-ports.js'

export type LocalApplicationPorts = {
  runtime: ApplicationRuntimePort
  queries: HubQueryPort
  useCases: SharedUseCasePorts
  legacyAttach: LegacyAttachPort
  legacyDetach: LegacyDetachPort
}

/**
 * Local composition only: the host supplies runtime, read models, and low-level
 * facts/effects; shared Application/Core own write-use-case behavior.
 */
export function createLocalApplicationPorts(context: LocalHostContext): LocalApplicationPorts {
  const queries = createLocalQueryPort(context)
  return {
    runtime: {
      nowIso: () => context.clock.nowIso(),
      nextId: (scope) => context.ids.next(scope),
      sha256: (value) => context.hash.sha256(value)
    },
    queries,
    useCases: createLocalUseCasePorts(context),
    legacyAttach: createLocalLegacyAttachPort(context, queries.inspectWorktree),
    legacyDetach: createLocalLegacyDetachPort(context, queries.inspectWorktree)
  }
}
