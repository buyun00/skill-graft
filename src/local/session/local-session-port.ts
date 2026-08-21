import type { SessionPort, SessionResumeRequest, SessionStartRequest } from '../../application/ports.js'
import { portFault } from '../../application/port-fault.js'
import type { SessionView } from '../../contracts/index.js'
import type { LocalHostContext as HubContext } from '../../adapters/host-context.js'
import {
  enqueueSession,
  finalizeSession,
  findSession,
  listSessions,
  markSessionSpawned,
  presentSession,
  reapSessions,
  resumeSession,
  saveSession,
  sessionsNeedReap,
  toSessionView,
  toSessionViews
} from './legacy-sessions.js'
import {
  createCodexSessionRunner,
  DEFAULT_RUNNER_PROFILE,
  DEFAULT_RUNNER_QUALITY,
  type LocalSessionRunner
} from './codex-session-runner.js'
import type { HubSession } from './types.js'

export type LocalSessionPort = SessionPort & {
  needsReap(sessionIds?: readonly string[]): boolean
  listLegacy(): HubSession[]
  getLegacy(sessionId: string): HubSession | null
  readLog(sessionId: string): string
}

export type LocalSessionPortOptions = {
  runner?: LocalSessionRunner
  waitTimeoutMs?: number
  pollMs?: number
  sleep?: (ms: number) => Promise<void>
}

function legacyTarget(input: SessionStartRequest) {
  const worktree = input.locator?.kind === 'worktree' ? input.locator.value : ''
  const skillPath = input.locator?.kind === 'skill' ? input.locator.value : ''
  return { worktree, skillPath }
}

export function createLocalSessionPort(ctx: HubContext, options: LocalSessionPortOptions = {}): LocalSessionPort {
  const runner = options.runner || createCodexSessionRunner(ctx)
  const waitTimeoutMs = options.waitTimeoutMs ?? Number(process.env.HUB_WAIT_TIMEOUT_MS || 30 * 60 * 1000)
  const pollMs = options.pollMs ?? 250
  const sleep = options.sleep || ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  const preflightRunner = (
    sessionOptions: SessionStartRequest['options'],
    failIfUnavailable: boolean
  ) => {
    const requested = sessionOptions?.start !== false
    const enabled = requested && runner.enabled()
    const available = enabled && runner.available()
    if (enabled && failIfUnavailable && !available) {
      throw portFault('runner-unavailable')
    }
    return { requested, enabled, available }
  }

  const waitFor = async (session: HubSession): Promise<HubSession> => {
    const started = ctx.clock.nowMs()
    for (;;) {
      reapSessions(ctx, (pid) => runner.pidAlive(pid), [session.id])
      const current = findSession(ctx, session.id)
      if (!current) throw new Error(`session not found: ${session.id}`)
      if (current.status !== 'running') return presentSession(ctx, current)
      if (ctx.clock.nowMs() - started > waitTimeoutMs) {
        // Waiting is a transport convenience, not the business outcome. The
        // runner may still complete after this caller's deadline, so return the
        // durable running state instead of caching a false terminal failure.
        return presentSession(ctx, current)
      }
      await sleep(pollMs)
    }
  }

  const maybeStart = async (
    session: HubSession,
    input: {
      options?: SessionStartRequest['options']
      prompt: string
      continuationToken?: string
      runnerState?: ReturnType<typeof preflightRunner>
    }
  ): Promise<HubSession> => {
    session.model = input.options?.profile || process.env.HUB_CODEX_MODEL || DEFAULT_RUNNER_PROFILE
    session.effort = input.options?.quality || process.env.HUB_CODEX_EFFORT || DEFAULT_RUNNER_QUALITY
    const runnerState = input.runnerState || preflightRunner(input.options, false)
    if (runnerState.enabled && runnerState.available) {
      const pid = runner.start({
        session,
        prompt: input.prompt,
        continuationToken: input.continuationToken,
        profile: session.model,
        quality: session.effort
      })
      session = markSessionSpawned(ctx, session, pid)
      if (!pid) session = finalizeSession(ctx, session, { exitCode: 1, error: 'spawn failed' })
    } else {
      saveSession(ctx, session)
    }
    if (input.options?.wait) session = await waitFor(session)
    return session
  }

  const port: LocalSessionPort = {
    list() {
      return toSessionViews(ctx, listSessions(ctx))
    },
    get(sessionId) {
      const session = findSession(ctx, sessionId)
      return session ? toSessionView(ctx, session) : null
    },
    async start(input: SessionStartRequest) {
      const runnerState = preflightRunner(input.options, input.kind === 'attach')
      const target = legacyTarget(input)
      let session = enqueueSession(ctx, {
        kind: input.kind,
        worktree: target.worktree,
        skillPath: target.skillPath,
        intent: input.intent,
        inboxIds: input.inboxIds ? [...input.inboxIds] : undefined
      })
      const prompt = ctx.fs.readText(session.promptFile) || input.intent || input.kind
      session = await maybeStart(session, {
        options: input.options,
        prompt,
        runnerState
      })
      return toSessionView(ctx, session)
    },
    async resume(input: SessionResumeRequest) {
      let session = resumeSession(ctx, { id: input.sessionId, message: input.message })
      if (!session.codexSessionId) {
        saveSession(ctx, session)
        return toSessionView(ctx, session)
      }
      session = await maybeStart(session, {
        options: input.options,
        prompt: input.message,
        continuationToken: session.codexSessionId || undefined
      })
      return toSessionView(ctx, session)
    },
    reap(sessionIds?: readonly string[]) {
      return toSessionViews(ctx, reapSessions(ctx, (pid) => runner.pidAlive(pid), sessionIds))
    },
    needsReap(sessionIds?: readonly string[]) {
      return sessionsNeedReap(ctx, (pid) => runner.pidAlive(pid), sessionIds)
    },
    listLegacy() {
      return listSessions(ctx)
    },
    getLegacy(sessionId) {
      const session = findSession(ctx, sessionId)
      return session ? presentSession(ctx, session) : null
    },
    readLog(sessionId) {
      const session = findSession(ctx, sessionId)
      return session ? ctx.fs.readText(session.logFile) || '' : ''
    }
  }
  return port
}
