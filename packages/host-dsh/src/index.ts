import path from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import type { HubCommand } from '../../../src/contracts/index.js'
import { openDshHost } from '../../../src/dsh/create-dsh-host.js'

export const name = 'skill-graft-dsh'
export const inject = ['connection']

export type DshPluginConfig = {
  dataRoot?: string
  workspace?: string
  autoSync?: 'off' | 'plan' | 'sync'
  lockTimeoutMs?: number
  logLevel?: 'error' | 'warn' | 'info' | 'debug'
}

export const Config = z.object({
  dataRoot: z.string().default(''),
  workspace: z.string().default(''),
  autoSync: z.union(['off', 'plan', 'sync']).default('off'),
  lockTimeoutMs: z.natural().min(1000).default(30_000),
  logLevel: z.union(['error', 'warn', 'info', 'debug']).default('info')
})

type CordisContext = {
  connection: {
    rpc: {
      handle(
        channel: string,
        handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>,
        options: { authority: 'loopback' | 'trusted-host' }
      ): () => Promise<void>
    }
  }
  provide(name: string, value: unknown): unknown
  effect<T>(callback: () => T, label?: string): T
  logger?(name: string): { info?(message: string): void; warn?(message: string): void }
}

type ExecutePayload = { command: HubCommand }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function badRequest(message: string) {
  return { ok: false as const, error: { code: 'bad-request' as const, message, details: { issues: [] } } }
}

function resolvedDataRoot(config: DshPluginConfig): string {
  const explicit = config.dataRoot?.trim()
  if (explicit) return path.resolve(explicit)
  const dshHome = process.env.DSH_HOME?.trim()
  if (!dshHome) throw new Error('Skill Graft DSH requires dataRoot or DSH_HOME')
  return path.resolve(dshHome, 'skill-graft')
}

export async function apply(ctx: CordisContext, config: DshPluginConfig = {}): Promise<void> {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const host = await openDshHost({
    packageRoot,
    dataRoot: resolvedDataRoot(config),
    hostId: 'dsh',
    leaseMs: config.lockTimeoutMs ?? 30_000
  })
  const service = Object.freeze({
    application: host.application,
    dataRoot: host.dataRoot,
    workspace: config.workspace?.trim() || null,
    autoSync: config.autoSync ?? 'off',
    execute: (command: HubCommand) => host.application.execute(command)
  })
  ctx.provide('skillGraft', service)
  ctx.connection.rpc.handle('/skill-graft', async (endpoint, payload, signal) => {
    if (signal.aborted) {
      return { ok: false, error: { code: 'cancelled', message: 'request was cancelled', details: {} } }
    }
    if (endpoint !== 'execute' || !isRecord(payload) || !isRecord(payload.command)) {
      return badRequest('Skill Graft expects execute with a shared HubCommand payload')
    }
    const rawCommand = payload.command
    const requestId = isRecord(rawCommand.meta) && typeof rawCommand.meta.requestId === 'string'
      ? rawCommand.meta.requestId
      : undefined
    const command = {
      ...rawCommand,
      meta: host.commandMeta('dsh-rpc', requestId)
    } as HubCommand
    return { ok: true, value: await host.application.execute(command) }
  }, { authority: 'loopback' })
  ctx.effect(() => () => host.dispose(), 'skill-graft-dsh: host lifecycle')
  ctx.logger?.(name).info?.(`ready at ${host.dataRoot}`)
}
