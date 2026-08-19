import { API_PATHS, sessionFromEnvelope } from './overview-mapping.mjs'

function joinUrl(base, path) {
  if (!base) return path
  return `${String(base).replace(/\/$/, '')}${path}`
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

export function createPanelApi(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch
  const base = options.base || ''

  async function request(path, init) {
    const res = await fetchImpl(joinUrl(base, path), init)
    const data = await readBody(res)
    if (!res.ok) {
      const message = (data && (data.error || data.message)) || `HTTP ${res.status}`
      const err = new Error(typeof message === 'string' ? message : JSON.stringify(message))
      err.status = res.status
      err.data = data
      throw err
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

  async function postSession(path, body) {
    const data = await post(path, body)
    return sessionFromEnvelope(data) || data
  }

  return {
    getHealth: () => request(API_PATHS.health),
    getState: () => request(API_PATHS.state),
    getDaemon: () => request(API_PATHS.daemon),
    getWorktrees: () => request(API_PATHS.worktrees),
    getSkill: (skillPath) => request(`${API_PATHS.skill}?path=${encodeURIComponent(skillPath || '')}`),
    getHistory: () => request(API_PATHS.history),
    getSessions: () => request(API_PATHS.sessions),
    getSession: (id) => request(`${API_PATHS.session}?id=${encodeURIComponent(id || '')}`),
    analyze: () => postSession(API_PATHS.analyze, {}),
    decide: (id, action, extra = {}) => post(API_PATHS.decide, { id, action, ...extra }),
    attachWorktree: (worktreePath, intent) => postSession(API_PATHS.attach, { path: worktreePath, intent }),
    detachWorktree: (worktreePath, intent) => postSession(API_PATHS.detach, { path: worktreePath, intent }),
    startCodex: (body = {}) => postSession(API_PATHS.start, body),
    resumeCodex: (id, message) => postSession(API_PATHS.resume, { id, message }),
    sessionStreamUrl: (id) => joinUrl(base, `${API_PATHS.stream}?id=${encodeURIComponent(id || '')}`)
  }
}

export const panelApi = createPanelApi()
