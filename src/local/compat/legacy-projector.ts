import type { HubCommandResult } from '../../contracts/index.js'
import type { LocalHost } from '../create-local-host.js'

export class LegacyCommandError extends Error {
  readonly code: string
  readonly retryable: boolean

  constructor(code: string, message: string, retryable: boolean) {
    super(message)
    this.code = code
    this.retryable = retryable
  }
}

export function requireApplicationData(result: HubCommandResult): unknown {
  if (!result.ok) throw new LegacyCommandError(result.error.code, result.error.message, result.error.retryable)
  return result.data
}

type ApplicationSession = Record<string, unknown> & { id?: unknown }

function applicationSession(value: unknown): ApplicationSession | undefined {
  return value && typeof value === 'object' ? value as ApplicationSession : undefined
}

function projectSession(value: unknown, host?: LocalHost): unknown {
  const typed = applicationSession(value)
  if (!typed) return value
  const id = typeof typed.id === 'string' ? typed.id : ''
  const legacy = id ? host?.localSessions?.getLegacy(id) : null
  // The Application result owns identity and every shared business field. The
  // point lookup only preserves runner-owned v0 details such as pid/log files;
  // it must never select a different session or override typed state.
  return legacy ? { ...legacy, ...typed } : typed
}

function projectSessions(value: unknown, host?: LocalHost): unknown {
  return Array.isArray(value) ? value.map((session) => projectSession(session, host)) : value
}

export function projectLegacyResult(result: HubCommandResult, host?: LocalHost): unknown {
  const data = requireApplicationData(result) as Record<string, unknown>
  switch (result.commandKind) {
    case 'status': {
      return { ...data, sessions: projectSessions(data.sessions, host) }
    }
    case 'repairLegacy':
      return {
        ok: true,
        action: 'repair-links',
        worktree: data.worktree,
        attached: data.attached,
        blocked: data.blocked,
        repaired: data.repaired,
        reason: data.reason,
        links: data.artifacts
      }
    case 'applyLegacyAttach':
      return {
        ok: true,
        action: 'attach-library',
        worktree: data.worktree,
        attached: true,
        changed: data.changed,
        claim: data.claim,
        sourcePolicy: data.sourcePolicy,
        plan: data.plan,
        results: data.effects,
        visibility: data.visibility,
        gitConfigured: data.gitConfigured
      }
    case 'applyLegacyDetach':
      return {
        ok: true,
        action: 'detach-library',
        worktree: data.worktree,
        attached: false,
        changed: data.changed,
        detached: data.detached,
        reason: data.reason,
        claim: data.claim,
        plan: data.plan,
        results: data.effects,
        restoredTracked: data.restoredTracked
      }
    case 'ingest': {
      const session = projectSession(data.session, host)
      return {
        ok: true,
        ...data,
        ...(data.session ? { session } : {}),
        ...(data.session ? { applied: null } : {})
      }
    }
    case 'decide': {
      const worktrees = data.worktrees as { applied?: unknown[]; skipped?: unknown[] } | undefined
      return {
        ok: true,
        action: data.action,
        item: data.item,
        trees: {
          linked: worktrees?.applied || [],
          skipped: worktrees?.skipped || []
        }
      }
    }
    case 'attach':
    case 'detach':
    case 'edit':
    case 'chat':
    case 'analyze': {
      return { ok: true, action: result.commandKind, session: projectSession(data.session, host), applied: null }
    }
    case 'resumeSession': {
      return { ok: true, action: 'resume', session: projectSession(data.session, host) }
    }
    case 'getSession': {
      return { ok: true, action: 'session', session: projectSession(data.session, host) }
    }
    case 'listSessions': {
      return { ...data, sessions: projectSessions(data.sessions, host) }
    }
    default:
      return data
  }
}
