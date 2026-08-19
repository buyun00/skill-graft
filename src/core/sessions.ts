import type { HubContext } from './ports.js'
import type { HubSession } from './types.js'

const SESSION_KINDS = new Set(['attach', 'detach', 'edit', 'chat'])

function sessionsFile(ctx: HubContext) {
  return ctx.path.join(ctx.hubRoot, 'skill-review', 'sessions.json')
}

function loadSessions(ctx: HubContext): HubSession[] {
  const data = ctx.persist.readJson<{ sessions?: HubSession[] }>(sessionsFile(ctx), { sessions: [] })
  return Array.isArray(data.sessions) ? data.sessions : []
}

function saveSessions(ctx: HubContext, sessions: HubSession[]) {
  ctx.persist.writeJson(sessionsFile(ctx), { sessions })
}

function newId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function buildPrompt(ctx: HubContext, input: { kind: string; skillPath: string; intent: string; worktree: string }) {
  const templateName = input.kind === 'analyze-note' ? 'chat' : input.kind
  const templateFile = ctx.path.join(ctx.hubRoot, 'overlay', 'prompts', `${templateName}.txt`)
  const template = ctx.fs.readText(templateFile)
  if (!template) return (input.intent || '').trim()
  return template
    .replaceAll('{{HUB}}', ctx.hubRoot)
    .replaceAll('{{PATH}}', input.skillPath || '')
    .replaceAll('{{INTENT}}', input.intent || '')
    .replaceAll('{{WORKTREE}}', input.worktree || '')
    .trim()
}

export function enqueueSession(
  ctx: HubContext,
  input: { kind: string; worktree?: string; skillPath?: string; intent?: string }
): HubSession {
  const kind = input.kind || 'chat'
  if (!SESSION_KINDS.has(kind)) throw new Error(`unsupported session kind: ${kind}`)
  if (kind === 'edit' && !input.skillPath) throw new Error('edit requires --path')
  if ((kind === 'attach' || kind === 'detach') && !input.worktree) throw new Error(`${kind} requires --worktree`)

  const id = newId()
  const prompt = buildPrompt(ctx, {
    kind,
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
    startedAt: new Date().toISOString(),
    status: 'queued',
    exitCode: null,
    error: '',
    codexSessionId: ''
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
  saveSession(ctx, session)
  return session
}

export function markSessionSpawned(ctx: HubContext, session: HubSession, pid: number) {
  session.pid = pid
  session.status = pid ? 'running' : 'queued'
  saveSession(ctx, session)
  return session
}
