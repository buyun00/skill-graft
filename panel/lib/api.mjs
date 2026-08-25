import { API_PATHS, sessionFromEnvelope } from './overview-mapping.mjs'

let fallbackSequence = 0

function joinUrl(base, path) {
  if (!base) return path
  return `${String(base).replace(/\/$/, '')}${path}`
}

export function createPanelRequestId(kind) {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return `panel-${kind}-${uuid}`
  fallbackSequence += 1
  return `panel-${kind}-${Date.now().toString(36)}-${fallbackSequence.toString(36)}`
}

async function readBody(res) {
  const text = await res.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

function transportMessage(data, status) {
  const error = data && data.error
  if (error && typeof error === 'object' && typeof error.message === 'string') return error.message
  if (typeof error === 'string') return error
  if (data && typeof data.message === 'string') return data.message
  return `HTTP ${status}`
}

function assertEnvelope(kind, envelope) {
  if (
    envelope == null
    || typeof envelope !== 'object'
    || envelope.contractVersion !== 1
    || envelope.commandKind !== kind
    || typeof envelope.ok !== 'boolean'
  ) {
    const error = new Error(`invalid Application envelope for ${kind}`)
    error.code = 'PANEL_INVALID_ENVELOPE'
    error.data = envelope
    throw error
  }
  return envelope
}

export function createPanelApi(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch
  const base = options.base || ''

  async function request(path, init) {
    const res = await fetchImpl(joinUrl(base, path), {
      credentials: 'same-origin',
      ...init
    })
    const data = await readBody(res)
    if (!res.ok) {
      const error = new Error(transportMessage(data, res.status))
      error.status = res.status
      error.code = data?.error?.code || 'HTTP_ERROR'
      error.data = data
      throw error
    }
    return data
  }

  function post(path, body) {
    return request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    })
  }

  async function commandEnvelope(kind, input = {}, commandOptions = {}) {
    const requestId = commandOptions.requestId || createPanelRequestId(kind)
    const envelope = assertEnvelope(kind, await post(API_PATHS.command, {
      kind,
      ...input,
      requestId
    }))
    return envelope
  }

  async function command(kind, input = {}, commandOptions = {}) {
    const envelope = await commandEnvelope(kind, input, commandOptions)
    if (!envelope.ok) {
      const error = new Error(envelope.error?.message || `${kind} failed`)
      error.code = envelope.error?.code || 'APPLICATION_ERROR'
      error.requestId = envelope.requestId
      error.data = envelope
      throw error
    }
    return envelope.data
  }

  async function sessionCommand(kind, input = {}, commandOptions = {}) {
    const data = await command(kind, input, commandOptions)
    return sessionFromEnvelope(data) || data
  }

  const getDiagnostics = () => request(API_PATHS.diagnostics)

  return {
    getHealth: () => request(API_PATHS.health),
    getDiagnostics,
    getDaemon: async () => (await getDiagnostics())?.daemon || null,
    command,
    commandEnvelope,
    getState: () => command('status'),
    getWorktrees: () => command('listWorktrees'),
    getSkill: (skillPath) => command('readSkill', { path: skillPath || '' }),
    getHistory: (input = {}) => command('listHistory', { limit: 50, ...input }),
    getSessions: (input = {}) => command('listSessions', input),
    getSession: (id) => command('getSession', { sessionId: id || '' }),
    getSnapshots: () => command('listSnapshots'),
    getPin: (worktree) => command('getPin', { worktree }),
    setPin: (worktree, snapshotId, selectedSkills, commandOptions = {}) => command('setPin', {
      worktree,
      snapshotId,
      ...(Array.isArray(selectedSkills) ? { selectedSkills } : {})
    }, commandOptions),
    planSync: (worktree) => command('planSync', { worktree }),
    sync: (worktree, planHash, sessionId, commandOptions = {}) => command('sync', {
      worktree,
      planHash,
      ...(sessionId ? { sessionId } : {})
    }, commandOptions),
    migrateLegacy: (worktree, mode, planHash, commandOptions = {}) => command('migrateLegacy', {
      worktree,
      mode,
      ...(planHash ? { planHash } : {})
    }, commandOptions),
    rollbackLegacy: (worktree, migrationId, mode, planHash, commandOptions = {}) => command(
      'rollbackLegacyMigration',
      {
        worktree,
        migrationId,
        mode,
        ...(planHash ? { planHash } : {})
      },
      commandOptions
    ),
    analyze: (input = {}) => sessionCommand('analyze', {
      intent: 'Analyze queued inbox skill updates',
      runner: { start: true },
      ...input
    }),
    decide: (id, action, extra = {}, commandOptions = {}) => command('decide', {
      id,
      action,
      ...extra
    }, commandOptions),
    attachWorktree: (worktree, intent, commandOptions = {}) => sessionCommand('attach', {
      worktree,
      intent
    }, commandOptions),
    detachWorktree: (worktree, intent, commandOptions = {}) => sessionCommand('detach', {
      worktree,
      intent
    }, commandOptions),
    startCodex: (input = {}, commandOptions = {}) => {
      const kind = input.kind === 'analyze-note' ? 'chat' : (input.kind || 'chat')
      const { kind: _kind, model, effort, start, wait, ...rest } = input
      return sessionCommand(kind, {
        ...rest,
        runner: {
          ...(model ? { profile: model } : {}),
          ...(effort ? { quality: effort } : {}),
          ...(typeof start === 'boolean' ? { start } : {}),
          ...(typeof wait === 'boolean' ? { wait } : {})
        }
      }, commandOptions)
    },
    resumeCodex: (id, message, commandOptions = {}) => sessionCommand('resumeSession', {
      sessionId: id,
      message
    }, commandOptions),
    sessionStreamUrl: (id) => joinUrl(base, `${API_PATHS.stream}?id=${encodeURIComponent(id || '')}`)
  }
}

export const panelApi = createPanelApi()
