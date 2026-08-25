import type { LocalHostContext } from '../adapters/host-context.js'
import type { SessionRunnerPort } from '../application/ports.js'
import { createDshSessionBinding } from './session-binding.js'
import { createDshSessionPort, type DshSessionPort, type DshSessionPortOptions } from './session-port.js'
import { createDshSessionRunner, type DshRunDriver } from './session-runner.js'

export type DshSessionRuntime = {
  sessions: DshSessionPort
  runner: SessionRunnerPort
  dispose(): Promise<void>
}

export function createDshSessionRuntime(
  context: LocalHostContext,
  driver: DshRunDriver,
  options: DshSessionPortOptions = {}
): DshSessionRuntime {
  const binding = createDshSessionBinding(context)
  const control = createDshSessionRunner({
    driver,
    binding,
    now: () => context.clock.nowIso(),
    nextId: () => context.ids.next('dsh-runner')
  })
  const sessions = createDshSessionPort(context, binding, control, options)
  return {
    sessions,
    runner: control.port,
    async dispose() {
      await control.dispose()
      // Session truth is transaction-owned. A later reapSessions write folds
      // the cancelled/lost native run; disposal must not write outside the
      // shared Application command boundary.
    }
  }
}
