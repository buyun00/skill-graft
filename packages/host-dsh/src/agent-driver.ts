import { installModelSelection, type Agent, type AgentHandle, type AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent, type SessionStore } from '@deepseek-ai/dsh-session'
import type { DshDriverOutcome, DshDriverStatus, DshRunDriver } from '../../../src/dsh/session-runner.js'

type DefaultModelService = {
  currentSelection(): { provider: string; model: string }
}

type DriverContext = {
  agents: AgentRegistry
  sessions: SessionStore
  agentDefaultModel: DefaultModelService
  sessionPersistence: unknown
}

type DriverInput = {
  runnerId: string
  prompt: string
  workingDirectory: string
  profile?: string
  quality?: string
}

type OwnedRun = {
  handle: AgentHandle
  state: 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled'
  outcome?: DshDriverOutcome
  result: Promise<DshDriverOutcome>
}

function terminalOutcome(events: readonly SessionEvent[], firstSeq: number): DshDriverOutcome {
  const ending = events.findLast((event) => event.seq >= firstSeq && event.type === 'turn/end')
  const at = new Date().toISOString()
  if (!ending || ending.type !== 'turn/end') {
    return { state: 'failed', endedAt: at, exitCode: 1, errorCode: 'RUNNER_PROTOCOL_ERROR' }
  }
  switch (ending.data.reason.kind) {
    case 'completed':
      return { state: 'succeeded', endedAt: at, exitCode: 0 }
    case 'aborted':
      return { state: 'cancelled', endedAt: at, exitCode: null }
    default:
      return { state: 'failed', endedAt: at, exitCode: 1, errorCode: 'RUNNER_PROTOCOL_ERROR' }
  }
}

function driverStatus(run: OwnedRun): DshDriverStatus {
  if (run.outcome) return { ...run.outcome }
  return { state: run.state === 'cancelling' ? 'cancelling' : 'running' }
}

export function createDshAgentDriver(ctx: DriverContext): DshRunDriver {
  const runs = new Map<string, OwnedRun>()
  let accepting = true

  const selectionFor = (input: Pick<DriverInput, 'profile' | 'quality'>) => {
    const fallback = ctx.agentDefaultModel.currentSelection()
    return {
      provider: input.profile?.trim() || fallback.provider,
      model: input.quality?.trim() || fallback.model
    }
  }

  const setupFor = (selection: { provider: string; model: string }) => (agentCtx: any) => {
    const selected: ModelSelectionRef = { current: selection, assembled: undefined }
    installModelSelection(agentCtx, selected)
  }

  const drive = async (handle: AgentHandle, prompt: string): Promise<DshDriverOutcome> => {
    const agent = handle.agent
    await agent.whenIdle()
    const firstSeq = agent.session.seq
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' }
    }))
    await agent.whenIdle()
    await ctx.sessions.flush(agent.session)
    return terminalOutcome(agent.session.events, firstSeq)
  }

  const publish = (runnerId: string, handle: AgentHandle, prompt: string) => {
    let resolveResult!: (outcome: DshDriverOutcome) => void
    const result = new Promise<DshDriverOutcome>((resolve) => { resolveResult = resolve })
    const run: OwnedRun = { handle, state: 'running', result }
    runs.set(runnerId, run)
    void drive(handle, prompt).then(
      (outcome) => {
        if (runs.get(runnerId) !== run) return
        run.outcome = outcome
        run.state = outcome.state
        resolveResult(outcome)
      },
      async () => {
        const outcome: DshDriverOutcome = {
          state: 'failed',
          endedAt: new Date().toISOString(),
          exitCode: 1,
          errorCode: 'RUNNER_PROTOCOL_ERROR'
        }
        run.outcome = outcome
        run.state = 'failed'
        try { await ctx.sessions.flush(handle.agent.session) } catch { /* normalized below */ }
        resolveResult(outcome)
      }
    )
    return {
      runnerId,
      continuationToken: runnerId,
      startedAt: new Date().toISOString(),
      result
    }
  }

  const createHandle = async (input: DriverInput): Promise<AgentHandle> => {
    const selection = selectionFor(input)
    return await ctx.agents.create({
      sessionId: SessionId(input.runnerId),
      meta: { cwd: input.workingDirectory },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: setupFor(selection)
    })
  }

  const resumeHandle = async (input: DriverInput): Promise<AgentHandle> => {
    const existing = runs.get(input.runnerId)
    if (existing) {
      if (existing.state === 'running' || existing.state === 'cancelling') {
        throw new Error('DSH runner is still active')
      }
      return existing.handle
    }
    const selection = selectionFor(input)
    return await ctx.agents.resume({
      resumeSessionId: SessionId(input.runnerId),
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: setupFor(selection)
    })
  }

  return {
    available() {
      return accepting
        && Boolean(ctx.agents && ctx.sessions && ctx.agentDefaultModel && ctx.sessionPersistence)
    },
    async start(input) {
      if (!accepting) throw new Error('DSH runner is stopping')
      if (runs.has(input.runnerId)) throw new Error('DSH runner id already exists')
      const handle = await createHandle(input)
      try {
        return publish(input.runnerId, handle, input.prompt)
      } catch (error) {
        await handle.dispose()
        throw error
      }
    },
    async resume(input) {
      if (!accepting) throw new Error('DSH runner is stopping')
      if (input.continuationToken !== input.runnerId) throw new Error('DSH continuation identity is invalid')
      const previous = runs.get(input.runnerId)
      const handle = await resumeHandle(input)
      if (previous) runs.delete(input.runnerId)
      try {
        return publish(input.runnerId, handle, input.prompt)
      } catch (error) {
        if (!previous) await handle.dispose()
        throw error
      }
    },
    async cancel(runnerId) {
      const run = runs.get(runnerId)
      if (!run) return { state: 'not-found' }
      if (run.outcome) return { ...run.outcome }
      run.state = 'cancelling'
      run.handle.agent.cancel({ kind: 'user' })
      return { state: 'cancelling' }
    },
    async status(runnerId) {
      const run = runs.get(runnerId)
      return run ? driverStatus(run) : { state: 'not-found' }
    },
    async dispose() {
      accepting = false
      const active = [...runs.values()].filter((run) => !run.outcome)
      for (const run of active) {
        run.state = 'cancelling'
        run.handle.agent.cancel({ kind: 'disposed' })
      }
      await Promise.allSettled(active.map((run) => run.result))
      await Promise.allSettled([...runs.values()].map((run) => run.handle.dispose()))
    }
  }
}
