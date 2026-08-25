import path from 'node:path'
import type { LocalHostContext } from '../adapters/host-context.js'
import type { SessionStartRequest } from '../application/ports.js'
import type { SessionTask } from '../contracts/index.js'

export type DshSessionBinding = {
  bindingVersion: 1
  sessionId: string
  attemptId: string
  task: SessionTask
  locator?: SessionStartRequest['locator']
  workingDirectory: string
  prompt: string
}

export type DshSessionBindingPort = {
  prepare(input: {
    sessionId: string
    attemptId: string
    task: SessionTask
    locator?: SessionStartRequest['locator']
  }): DshSessionBinding
  read(sessionId: string, attemptId: string): DshSessionBinding | null
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`${label} is not a safe DSH session identifier`)
}

function bindingFile(ctx: LocalHostContext, sessionId: string, attemptId: string): string {
  return ctx.path.join(
    ctx.hubRoot,
    'skill-review',
    'dsh-sessions',
    sessionId,
    'attempts',
    attemptId,
    'binding.json'
  )
}

function realDirectory(ctx: LocalHostContext, candidate: string, label: string): string {
  const canonical = ctx.fs.realpath(ctx.path.resolve(candidate))
  if (!canonical || !ctx.fs.isDirectory(canonical)) {
    throw new Error(`${label} must name an existing directory`)
  }
  return canonical
}

function workingDirectory(ctx: LocalHostContext, locator?: SessionStartRequest['locator']): string {
  const hubRoot = realDirectory(ctx, ctx.hubRoot, 'DSH hub root')
  if (!locator) return hubRoot

  if (locator.kind === 'worktree') {
    if (!path.isAbsolute(locator.value)) {
      throw new Error('DSH worktree locator must be absolute')
    }
    return realDirectory(ctx, locator.value, 'DSH worktree locator')
  }

  const resolved = path.isAbsolute(locator.value)
    ? ctx.path.resolve(locator.value)
    : ctx.path.resolve(hubRoot, locator.value)
  if (!ctx.path.isSameOrInside(hubRoot, resolved)) {
    throw new Error('DSH Skill locator escapes the hub root')
  }
  const canonical = ctx.fs.realpath(resolved)
  if (!canonical || !ctx.path.isSameOrInside(hubRoot, canonical)) {
    throw new Error('DSH Skill locator is missing or escapes the hub root')
  }
  if (ctx.fs.isDirectory(canonical)) return canonical
  if (ctx.fs.isFile(canonical)) return realDirectory(ctx, ctx.path.dirname(canonical), 'DSH Skill directory')
  throw new Error('DSH Skill locator must name an existing file or directory')
}

function hostInstructions(task: SessionTask, locator?: SessionStartRequest['locator']): readonly string[] {
  const target = locator?.value
  switch (task.kind) {
    case 'attach':
      return target
        ? [
            `The DSH-bound worktree is ${target}. Inspect it only as needed.`,
            'Prepare the snapshot handoff, then stop. Claim, pin, sync, and materialization proof remain Application-owned.'
          ]
        : ['No worktree binding was supplied; fail without guessing a workspace.']
    case 'detach':
      return target
        ? [`The DSH-bound worktree is ${target}. Use only Skill Graft Application commands for detach effects.`]
        : ['No worktree binding was supplied; fail without guessing a workspace.']
    case 'edit':
      return target
        ? [`The DSH-bound Skill is ${target}. Do not edit outside that Skill directory.`]
        : ['No Skill binding was supplied; fail without guessing a Skill.']
    case 'chat':
      return target ? [`The DSH-bound worktree available to this request is ${target}.`] : []
    case 'analyze':
      return ['Analyze only the Application-selected inbox identities; do not mutate inbox state.']
  }
}

function renderPrompt(task: SessionTask, locator?: SessionStartRequest['locator']): string {
  return [
    'Session task (Application-owned):',
    `- ${task.prompt.summary}`,
    ...task.prompt.instructions.map((line) => `- ${line}`),
    '',
    'DeepSeek Harness execution binding (host-owned):',
    `- Opaque Skill Graft session: ${task.id}`,
    ...hostInstructions(task, locator).map((line) => `- ${line}`),
    '',
    'Finish the runner-owned steps and return normally. Do not report claim or materialization complete; the trusted Application records those facts.'
  ].join('\n')
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function createDshSessionBinding(ctx: LocalHostContext): DshSessionBindingPort {
  return {
    prepare(input) {
      assertSafeId(input.sessionId, 'sessionId')
      assertSafeId(input.attemptId, 'attemptId')
      const value: DshSessionBinding = {
        bindingVersion: 1,
        sessionId: input.sessionId,
        attemptId: input.attemptId,
        task: clone(input.task),
        locator: input.locator ? { ...input.locator } : undefined,
        workingDirectory: workingDirectory(ctx, input.locator),
        prompt: renderPrompt(input.task, input.locator)
      }
      ctx.persist.writeJson(bindingFile(ctx, input.sessionId, input.attemptId), value)
      return clone(value)
    },
    read(sessionId, attemptId) {
      assertSafeId(sessionId, 'sessionId')
      assertSafeId(attemptId, 'attemptId')
      const value = ctx.persist.readJson<DshSessionBinding | null>(bindingFile(ctx, sessionId, attemptId), null)
      if (!value
        || value.bindingVersion !== 1
        || value.sessionId !== sessionId
        || value.attemptId !== attemptId
        || value.task?.taskVersion !== 1) return null
      return clone(value)
    }
  }
}
