import path from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import type { HubCommand } from '../../../src/contracts/index.js'
import { openDshHost } from '../../../src/dsh/create-dsh-host.js'
import {
  createDshWorkspaceLifecycle,
  type DshRuntimeSkill,
  type DshSettingsScope,
  type DshSettingsValue,
  type DshSkillsRegistry,
  type DshSystemPrompt,
  type DshWorkspace,
  type DshWorkspaceLifecycle,
  type DshWorkspaceRegistry
} from '../../../src/dsh/workspace-lifecycle.js'

export const name = 'skill-graft-dsh'
export const inject = ['connection', 'settings', 'workspaceRegistry', 'skills', 'systemPrompt']

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

const SettingsConfig = z.object({
  workspaceId: z.string().default(''),
  autoSync: z.union(['off', 'plan', 'sync']).default('off')
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
  settings: {
    register(
      namespace: string,
      schema: unknown,
      options: { base: DshSettingsValue; applies: 'live' | 'restart' }
    ): DshSettingsScope
  }
  workspaceRegistry: DshWorkspaceRegistry
  skills: DshSkillsRegistry
  systemPrompt: DshSystemPrompt
  provide(name: string, value: unknown): unknown
  effect<T>(callback: () => T, label?: string): T
  logger?(name: string): { info?(message: string): void; warn?(message: string): void }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function badRequest(message: string) {
  return { ok: false as const, error: { code: 'bad-request' as const, message, details: { issues: [] } } }
}

function internalError(error: unknown) {
  return {
    ok: false as const,
    error: {
      code: 'internal' as const,
      message: error instanceof Error ? error.message : String(error),
      details: {}
    }
  }
}

function cancelledError() {
  return { ok: false as const, error: { code: 'cancelled' as const, message: 'request was cancelled', details: {} } }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const error = new Error('request was cancelled')
  error.name = 'AbortError'
  throw error
}

function resolvedDataRoot(config: DshPluginConfig): string {
  const explicit = config.dataRoot?.trim()
  if (explicit) return path.resolve(explicit)
  const dshHome = process.env.DSH_HOME?.trim()
  if (!dshHome) throw new Error('Skill Graft DSH requires dataRoot or DSH_HOME')
  return path.resolve(dshHome, 'skill-graft')
}

function commandFromPayload(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload) || !isRecord(payload.command)) return null
  return payload.command
}

function workspacePayload(payload: unknown): { workspaceId: string } | null {
  if (!isRecord(payload) || typeof payload.workspaceId !== 'string') return null
  return { workspaceId: payload.workspaceId }
}

export async function apply(ctx: CordisContext, config: DshPluginConfig = {}): Promise<void> {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const host = await openDshHost({
    packageRoot,
    dataRoot: resolvedDataRoot(config),
    hostId: 'dsh',
    leaseMs: config.lockTimeoutMs ?? 30_000
  })
  let accepting = true
  let lifecycle: DshWorkspaceLifecycle | undefined
  const inFlight = new Set<Promise<unknown>>()
  const tracked = <T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    if (!accepting) return Promise.reject(new Error('Skill Graft DSH is stopping'))
    try {
      throwIfAborted(signal)
    } catch (error) {
      return Promise.reject(error)
    }
    const running = operation()
    inFlight.add(running)
    void running.finally(() => inFlight.delete(running)).catch(() => undefined)
    return running
  }

  // Register the aggregate lifecycle before publishing services/routes. Cordis
  // disposes later effects first, so the RPC route and service disappear before
  // this drains accepted calls and snapshot-derived registrations.
  ctx.effect(() => async () => {
    accepting = false
    await Promise.allSettled([...inFlight])
    await lifecycle?.dispose()
    await host.dispose()
  }, 'skill-graft-dsh: aggregate lifecycle')

  const settings = ctx.settings.register('skill-graft', SettingsConfig, {
    base: {
      workspaceId: '',
      autoSync: config.autoSync ?? 'off'
    },
    applies: 'live'
  })
  lifecycle = createDshWorkspaceLifecycle({
    host,
    settings,
    workspaceRegistry: ctx.workspaceRegistry,
    skills: ctx.skills,
    systemPrompt: ctx.systemPrompt,
    configuredWorkspace: config.workspace,
    lockTimeoutMs: config.lockTimeoutMs ?? 30_000,
    logLevel: config.logLevel ?? 'info'
  })
  await lifecycle.refresh()

  const execute = (rawCommand: Record<string, unknown>, transport: string, signal?: AbortSignal) => {
    const requestId = isRecord(rawCommand.meta) && typeof rawCommand.meta.requestId === 'string'
      ? rawCommand.meta.requestId
      : undefined
    const command = {
      ...rawCommand,
      meta: host.commandMeta(transport, requestId)
    } as HubCommand
    return tracked(() => {
      // Shared Application commands are atomic once accepted. Cancellation is
      // therefore checked immediately before acceptance, never midway through
      // a write that dispose must drain to completion.
      throwIfAborted(signal)
      return host.application.execute(command)
    }, signal)
  }
  const service = Object.freeze({
    application: host.application,
    dataRoot: host.dataRoot,
    execute: (command: HubCommand) => execute(command as unknown as Record<string, unknown>, 'dsh-service'),
    describe: () => lifecycle?.describe(),
    refresh: () => tracked(() => lifecycle!.refresh()),
    updateSettings: (patch: Partial<DshSettingsValue>) => tracked(() => lifecycle!.updateSettings(patch)),
    selectWorkspace: (workspaceId: string) => tracked(() => lifecycle!.selectWorkspace(workspaceId)),
    registerWorkspace: (workspacePath: string, title?: string) => (
      tracked(() => lifecycle!.registerWorkspace(workspacePath, title))
    ),
    unregisterWorkspace: (workspaceId: string) => tracked(() => lifecycle!.unregisterWorkspace(workspaceId))
  })
  ctx.provide('skillGraft', service)
  ctx.connection.rpc.handle('/skill-graft', async (endpoint, payload, signal) => {
    if (signal.aborted || !accepting) {
      return { ok: false, error: { code: 'cancelled', message: 'request was cancelled', details: {} } }
    }
    try {
      if (endpoint === 'execute') {
        const rawCommand = commandFromPayload(payload)
        if (!rawCommand) return badRequest('Skill Graft expects execute with a shared HubCommand payload')
        return { ok: true, value: await execute(rawCommand, 'dsh-rpc', signal) }
      }
      if (endpoint === 'describe') return { ok: true, value: lifecycle!.describe() }
      if (endpoint === 'refresh') return { ok: true, value: await tracked(() => lifecycle!.refresh(signal), signal) }
      if (endpoint === 'update-settings') {
        if (!isRecord(payload) || !isRecord(payload.patch)) return badRequest('settings patch is required')
        return { ok: true, value: await tracked(() => lifecycle!.updateSettings(payload.patch, signal), signal) }
      }
      if (endpoint === 'select-workspace') {
        const input = workspacePayload(payload)
        if (!input) return badRequest('workspaceId is required')
        return { ok: true, value: await tracked(() => lifecycle!.selectWorkspace(input.workspaceId, signal), signal) }
      }
      if (endpoint === 'register-workspace') {
        if (!isRecord(payload) || typeof payload.path !== 'string'
          || (payload.title !== undefined && typeof payload.title !== 'string')) {
          return badRequest('workspace path and optional title are required')
        }
        return {
          ok: true,
          value: await tracked(
            () => lifecycle!.registerWorkspace(payload.path as string, payload.title as string | undefined, signal),
            signal
          )
        }
      }
      if (endpoint === 'unregister-workspace') {
        const input = workspacePayload(payload)
        if (!input) return badRequest('workspaceId is required')
        return { ok: true, value: await tracked(() => lifecycle!.unregisterWorkspace(input.workspaceId, signal), signal) }
      }
      return badRequest('unknown Skill Graft endpoint')
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) return cancelledError()
      return internalError(error)
    }
  }, { authority: 'loopback' })
  ctx.logger?.(name).info?.(`ready at ${host.dataRoot}`)
}

export type { DshRuntimeSkill, DshWorkspace }
