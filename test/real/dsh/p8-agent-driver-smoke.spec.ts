import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { MockAdapter, textResponse } from './mock-adapter.ts'
import { createDshAgentDriver } from './skill-graft-p8-agent-driver.temp.ts'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('Skill Graft DSH Agent driver', () => {
  it('starts, resumes from JSONL after driver disposal, and confirms cancellation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skill-graft-dsh-agent-'))
    roots.push(root)
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
    const adapter = new MockAdapter([
      textResponse('started'),
      textResponse('resumed'),
      'hang'
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const driverContext = {
      agents: ctx.agents,
      sessions: ctx.sessions,
      sessionPersistence: ctx.sessionPersistence,
      agentDefaultModel: {
        currentSelection: () => ({ provider: 'mock', model: 'mock' })
      }
    }

    const first = createDshAgentDriver(driverContext)
    const started = await first.start({
      runnerId: 'skill-graft-p8-start',
      prompt: 'start through the real AgentLoop',
      workingDirectory: root,
      profile: 'mock',
      quality: 'mock'
    })
    expect(await started.result).toMatchObject({ state: 'succeeded', exitCode: 0 })
    await first.dispose()

    const second = createDshAgentDriver(driverContext)
    const resumed = await second.resume({
      runnerId: started.runnerId,
      continuationToken: started.continuationToken,
      prompt: 'resume the persisted root session',
      workingDirectory: root,
      profile: 'mock',
      quality: 'mock'
    })
    expect(await resumed.result).toMatchObject({ state: 'succeeded', exitCode: 0 })

    const pending = await second.start({
      runnerId: 'skill-graft-p8-cancel',
      prompt: 'wait for cancellation',
      workingDirectory: root,
      profile: 'mock',
      quality: 'mock'
    })
    await expect.poll(() => adapter.requests.length).toBe(3)
    expect(await second.cancel(pending.runnerId, 'P8 smoke')).toMatchObject({ state: 'cancelling' })
    expect(await pending.result).toMatchObject({ state: 'cancelled', exitCode: null })
    await second.dispose()
    await ctx.fiber.dispose()
  })
})
