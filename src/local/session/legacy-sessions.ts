import type { SessionKind, SessionStatus, SessionTarget, SessionView } from '../../contracts/state.js'
import type { LocalHostContext as HubContext } from '../../adapters/host-context.js'
import { worktreeTargetId } from '../../adapters/worktree-target.js'
import type { HubSession } from './types.js'

const SESSION_KINDS = new Set(['attach', 'detach', 'edit', 'chat', 'analyze'])

export type PidAlive = (pid: number) => boolean

function sessionsFile(ctx: HubContext) {
  return ctx.path.join(ctx.hubRoot, 'skill-review', 'sessions.json')
}

export function sessionExitFile(ctx: HubContext, session: { id: string }) {
  return ctx.path.join(ctx.hubRoot, 'skill-review', `session-${session.id}.exit`)
}

function loadSessions(ctx: HubContext): HubSession[] {
  const data = ctx.persist.readJson<{ sessions?: HubSession[] }>(sessionsFile(ctx), { sessions: [] })
  return Array.isArray(data.sessions) ? data.sessions : []
}

function saveSessions(ctx: HubContext, sessions: HubSession[]) {
  ctx.persist.writeJson(sessionsFile(ctx), { sessions })
}

function newId(ctx: HubContext) {
  return ctx.ids.next('session')
}

function buildPrompt(ctx: HubContext, input: { kind: string; sessionId: string; skillPath: string; intent: string; worktree: string }) {
  const templateName = input.kind === 'analyze-note' ? 'chat' : input.kind
  const templateFile = ctx.path.join(ctx.hubRoot, 'overlay', 'prompts', `${templateName}.txt`)
  const template = ctx.fs.readText(templateFile)
  if (!template) return (input.intent || '').trim()
  return template
    .replaceAll('{{HUB}}', ctx.hubRoot)
    .replaceAll('{{PATH}}', input.skillPath || '')
    .replaceAll('{{INTENT}}', input.intent || '')
    .replaceAll('{{WORKTREE}}', input.worktree || '')
    .replaceAll('{{SESSION_ID}}', input.sessionId || '')
    .trim()
}

export function extractCodexSessionId(text: string): string {
  const match = String(text || '').match(/session id:\s*([0-9a-fA-F-]{16,})/i)
  return match ? match[1] : ''
}

export function extractAcceptanceSummary(text: string): string {
  const raw = String(text || '')
  const labeled = raw.match(/验收摘要[:：]\s*([\s\S]+)/) || raw.match(/acceptance summary[:：]\s*([\s\S]+)/i)
  const picked = (labeled ? labeled[1] : raw).trim()
  return picked.slice(0, 2000)
}

function refreshFromDisk(ctx: HubContext, session: HubSession) {
  const log = ctx.fs.readText(session.logFile) || ''
  const last = ctx.fs.readText(session.lastFile) || ''
  if (last) session.lastMessage = last
  const id = extractCodexSessionId(log) || extractCodexSessionId(last)
  if (id) session.codexSessionId = id
  const summary = extractAcceptanceSummary(last || log)
  if (summary) session.summary = summary
  if (session.status === 'completed') {
    session.status = session.exitCode === 0 ? 'waiting' : 'failed'
  }
}

function resolveExitCode(ctx: HubContext, session: HubSession): number {
  const text = ctx.fs.readText(sessionExitFile(ctx, session))
  if (text != null) {
    const parsed = Number.parseInt(String(text).trim(), 10)
    if (Number.isFinite(parsed)) return parsed
  }
  if (session.exitCode != null) return session.exitCode
  const log = ctx.fs.readText(session.logFile) || ''
  if (/\[spawn error\]/.test(log)) return 1
  if (extractCodexSessionId(log)) return 0
  return 1
}

function applyFinalize(ctx: HubContext, session: HubSession, exitCode: number, error?: string) {
  session.exitCode = exitCode
  session.status = exitCode === 0 ? 'waiting' : 'failed'
  session.endedAt = ctx.clock.nowIso()
  if (exitCode !== 0) {
    session.error = error || session.error || `process exited with code ${exitCode}`
  } else if (!session.error) {
    session.error = ''
  }
}

export function enqueueSession(
  ctx: HubContext,
  input: { kind: string; worktree?: string; skillPath?: string; intent?: string; inboxIds?: string[] }
): HubSession {
  const kind = input.kind || 'chat'
  if (!SESSION_KINDS.has(kind)) throw new Error(`unsupported session kind: ${kind}`)
  if (kind === 'edit' && !input.skillPath) throw new Error('edit requires --path')
  if ((kind === 'attach' || kind === 'detach') && !input.worktree) throw new Error(`${kind} requires --worktree`)

  const id = newId(ctx)
  const prompt = buildPrompt(ctx, {
    kind,
    sessionId: id,
    skillPath: input.skillPath || '',
    intent: input.intent || '',
    worktree: input.worktree || ''
  })
  const promptFile = ctx.path.join(ctx.hubRoot, 'skill-review', `prompt-${id}.txt`)
  const logFile = ctx.path.join(ctx.hubRoot, 'skill-review', `session-${id}.log`)
  const lastFile = ctx.path.join(ctx.hubRoot, 'skill-review', `session-${id}.last.txt`)
  ctx.fs.writeText(promptFile, prompt)
  ctx.fs.writeText(logFile, '')
  const session: HubSession = {
    id,
    kind,
    path: input.skillPath || '',
    worktree: input.worktree || '',
    intent: input.intent || '',
    pid: 0,
    promptFile,
    logFile,
    lastFile,
    startedAt: ctx.clock.nowIso(),
    status: 'queued',
    exitCode: null,
    error: '',
    codexSessionId: '',
    summary: '',
    lastMessage: '',
    inboxIds: input.inboxIds || []
  }
  const sessions = loadSessions(ctx)
  sessions.push(session)
  saveSessions(ctx, sessions)
  ctx.persist.writeJson(ctx.path.join(ctx.hubRoot, 'skill-review', 'history', `${id}.json`), {
    type: 'codex-session',
    kind,
    path: session.path,
    worktree: session.worktree,
    sessionId: id
  })
  return session
}

export function findSession(ctx: HubContext, id: string): HubSession | null {
  return loadSessions(ctx).find((item) => item.id === id) || null
}

export function saveSession(ctx: HubContext, session: HubSession) {
  const sessions = loadSessions(ctx)
  const index = sessions.findIndex((item) => item.id === session.id)
  if (index >= 0) sessions[index] = session
  else sessions.push(session)
  saveSessions(ctx, sessions)
}

export function resumeSession(ctx: HubContext, input: { id: string; message: string }): HubSession {
  if (!input.id) throw new Error('resume requires --id')
  const message = (input.message || '').trim()
  if (!message) throw new Error('resume requires --message')
  const session = findSession(ctx, input.id)
  if (!session) throw new Error('session not found')
  if (session.status === 'running') throw new Error('session still running')
  const prev = ctx.fs.readText(session.logFile) || ''
  ctx.fs.writeText(session.logFile, `${prev}\n\n--------\nuser\n${message}\n`)
  session.intent = message
  session.status = 'queued'
  session.error = ''
  session.exitCode = null
  session.endedAt = ''
  saveSession(ctx, session)
  return session
}

export function markSessionSpawned(ctx: HubContext, session: HubSession, pid: number) {
  session.pid = pid
  session.status = pid ? 'running' : 'queued'
  saveSession(ctx, session)
  return session
}

export function presentSession(ctx: HubContext, session: HubSession): HubSession {
  const copy: HubSession = { ...session }
  refreshFromDisk(ctx, copy)
  return {
    ...copy,
    canResume: Boolean(copy.codexSessionId) && copy.status !== 'running' && copy.status !== 'queued'
  }
}

function toSessionKind(value: string): SessionKind {
  return SESSION_KINDS.has(value) ? (value as SessionKind) : 'chat'
}

function toSessionStatus(value: string): SessionStatus {
  switch (value) {
    case 'queued':
    case 'running':
    case 'waiting':
    case 'completed':
    case 'failed':
    case 'cancelled':
      return value
    default:
      return 'failed'
  }
}

function logicalName(ctx: HubContext, value: string): string {
  if (!value) return ''
  const name = ctx.path.basename(value)
  return name.toLowerCase() === 'skill.md' ? ctx.path.basename(ctx.path.dirname(value)) : name
}

function toSessionTarget(ctx: HubContext, session: HubSession): SessionTarget {
  if (session.kind === 'attach' || session.kind === 'detach') {
    return { kind: 'worktree', id: worktreeTargetId(ctx, session.worktree) }
  }
  if (session.kind === 'edit') {
    return { kind: 'skill', id: logicalName(ctx, session.path) || 'skill' }
  }
  if (session.kind === 'analyze') {
    return { kind: 'inbox', id: session.inboxIds?.[0] || 'inbox' }
  }
  if (session.worktree) {
    return { kind: 'worktree', id: worktreeTargetId(ctx, session.worktree) }
  }
  return { kind: 'hub', id: 'hub' }
}

export function toSessionView(ctx: HubContext, session: HubSession): SessionView {
  const current = presentSession(ctx, session)
  return {
    id: current.id,
    kind: toSessionKind(current.kind),
    status: toSessionStatus(current.status),
    target: toSessionTarget(ctx, current),
    intent: current.intent || undefined,
    runnerId: current.pid ? `local:${current.id}` : undefined,
    continuationToken: current.codexSessionId || undefined,
    startedAt: current.startedAt,
    endedAt: current.endedAt || undefined,
    exitCode: current.exitCode,
    error: current.error || undefined,
    summary: current.summary || undefined,
    lastMessage: current.lastMessage || undefined,
    canResume: Boolean(current.canResume),
    inboxIds: current.inboxIds
  }
}

export function toSessionViews(ctx: HubContext, sessions: readonly HubSession[]): SessionView[] {
  return sessions.map((session) => toSessionView(ctx, session))
}

export function listSessions(ctx: HubContext): HubSession[] {
  return loadSessions(ctx).map((item) => presentSession(ctx, item))
}

export function inProgressSessions(ctx: HubContext): HubSession[] {
  return listSessions(ctx).filter((item) => item.status === 'running' || item.status === 'queued')
}

export function finalizeSession(
  ctx: HubContext,
  session: HubSession,
  result: { exitCode: number; error?: string }
): HubSession {
  refreshFromDisk(ctx, session)
  applyFinalize(ctx, session, result.exitCode, result.error)
  saveSession(ctx, session)
  return presentSession(ctx, session)
}

export function sessionsNeedReap(
  ctx: HubContext,
  pidAlive: PidAlive,
  sessionIds?: readonly string[]
): boolean {
  const allowed = sessionIds === undefined ? null : new Set(sessionIds)
  return loadSessions(ctx).some((session) => {
    if (allowed && !allowed.has(session.id)) return false
    return session.status === 'running' && (!session.pid || !pidAlive(session.pid))
  })
}

export function reapSessions(
  ctx: HubContext,
  pidAlive: PidAlive,
  sessionIds?: readonly string[]
): HubSession[] {
  const sessions = loadSessions(ctx)
  const allowed = sessionIds === undefined ? null : new Set(sessionIds)
  const finalized: HubSession[] = []
  let dirty = false
  for (const session of sessions) {
    if (allowed && !allowed.has(session.id)) continue
    const before = JSON.stringify(session)
    refreshFromDisk(ctx, session)
    if (session.status === 'running') {
      const alive = Boolean(session.pid) && pidAlive(session.pid)
      if (!alive) {
        applyFinalize(ctx, session, resolveExitCode(ctx, session))
        finalized.push(session)
      }
    }
    if (JSON.stringify(session) !== before) dirty = true
  }
  if (dirty) saveSessions(ctx, sessions)
  return finalized
}
