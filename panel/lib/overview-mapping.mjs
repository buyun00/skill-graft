/** Pure Skill Hub overview mapper. No DOM and no disk or command-layer imports. */

export const HUB_PATHS = {
  overview: '/',
  skills: '/skills',
  updates: '/updates',
  workspaces: '/workspaces',
  store: '/store',
  codex: '/codex',
  settings: '/settings'
}

export const API_PATHS = {
  health: '/api/health',
  state: '/api/state',
  daemon: '/api/daemon',
  worktrees: '/api/worktrees',
  skill: '/api/skill',
  history: '/api/history',
  sessions: '/api/codex/sessions',
  session: '/api/codex/session',
  stream: '/api/codex/session/stream',
  decide: '/api/decide',
  analyze: '/api/analyze',
  start: '/api/codex/start',
  resume: '/api/codex/resume',
  attach: '/api/worktree/attach',
  detach: '/api/worktree/detach'
}

export function shortHash(value) {
  if (value == null || value === '') return ''
  const text = String(value).trim()
  if (!text) return ''
  return text.length > 7 ? text.slice(0, 7) : text
}

export function needsRepair(tree) {
  return tree != null && tree.attached === true && (tree.overrideLinked === false || tree.officialPresent === true)
}

export function workspaceStatus(tree) {
  if (tree && tree.attached === true && tree.overrideLinked === true && tree.officialPresent === false) {
    return { status: 'ok', statusLabel: '正常' }
  }
  if (!tree || tree.attached === false) {
    return { status: 'off', statusLabel: '未连接' }
  }
  return { status: 'warn', statusLabel: '需要修复' }
}

export function versionParts(item) {
  const fromVersion = shortHash(item && item.oldCommit)
  const toVersion = shortHash(item && item.newCommit)
  return {
    fromVersion: fromVersion || undefined,
    toVersion: toVersion || undefined,
    showVersionChip: Boolean(fromVersion || toVersion),
    versionPrefix: ''
  }
}

export function mapUpdateAttention(item) {
  const versions = versionParts(item)
  return {
    id: String(item.id),
    kind: 'update',
    title: item.name,
    description: (item.suggestion && item.suggestion.reason) || '',
    fromVersion: versions.fromVersion,
    toVersion: versions.toVersion,
    showVersionChip: versions.showVersionChip,
    versionPrefix: versions.versionPrefix,
    href: `${HUB_PATHS.updates}/${encodeURIComponent(item.id)}`
  }
}

export function mapRepairAttention(tree) {
  const name = (tree && tree.name) || '工作区'
  return {
    id: `repair:${(tree && (tree.path || tree.name)) || name}`,
    kind: 'repair',
    title: `${name} 工作区`,
    description: 'Skill 链接不完整，需要修复',
    path: tree && tree.path,
    href: HUB_PATHS.workspaces
  }
}

export function mapWorkspaceRow(tree) {
  const status = workspaceStatus(tree)
  return {
    id: (tree && (tree.path || tree.name)) || '',
    name: (tree && tree.name) || '',
    path: tree && tree.path,
    attached: tree && tree.attached,
    overrideLinked: tree && tree.overrideLinked,
    officialPresent: tree && tree.officialPresent,
    status: status.status,
    statusLabel: status.statusLabel
  }
}

export function displayNameOf(userName) {
  const name = userName == null ? '' : String(userName).trim()
  return name || '本机'
}

export function overviewPrimary(attention) {
  return (attention && attention.length) ? '需要你处理' : '一切正常'
}

export function sessionFromEnvelope(payload) {
  if (!payload || typeof payload !== 'object') return null
  const nested = payload.session
  if (nested && typeof nested === 'object') return nested
  if (payload.id || payload.status) return payload
  return null
}

export function queuedSessionView(payload) {
  const session = sessionFromEnvelope(payload)
  if (!session) {
    return { id: '', status: '', label: '', attachedUnchanged: true }
  }
  const id = session.id || ''
  const status = session.status || ''
  const label = id || status === 'running' || status ? '已入队' : ''
  return { id, status, label, attachedUnchanged: true }
}

export function codexSessionHref(payload) {
  const session = sessionFromEnvelope(payload)
  if (!session || !session.id) return ''
  return `${HUB_PATHS.codex}?id=${encodeURIComponent(session.id)}`
}

export function mapOverview(input = {}) {
  const state = input.state || {}
  const worktreesPayload = input.worktrees || {}
  const health = input.health || {}
  const daemon = input.daemon || {}
  const items = Array.isArray(state.items) ? state.items : []
  const trees = Array.isArray(worktreesPayload.worktrees) ? worktreesPayload.worktrees : []
  const counts = state.counts || {}
  const resident = Number(counts.resident || 0)
  const adopted = Number(counts.adopted || 0)
  const queued = Number(counts.queued || 0)
  const proposed = Number(counts.proposed || 0)

  const updateItems = items.filter((item) => item && (item.status === 'queued' || item.status === 'proposed'))
  const repairTrees = trees.filter(needsRepair)
  const attention = [...updateItems.map(mapUpdateAttention), ...repairTrees.map(mapRepairAttention)]
  const pending = queued + proposed + repairTrees.length
  const skillCount = resident + adopted
  const worktreeCount = trees.length

  const statsParts = [`${skillCount} Skills`, `${worktreeCount} Worktrees`]
  if (pending > 0) statsParts.push(`${pending} 待处理`)

  const displayName = displayNameOf(input.userName)
  const hubRoot = state.hubRoot || ''
  const gameRepo = state.gameRepo || null
  const gitOk = Boolean(health.ok && gameRepo)
  const sessionsReachable = input.sessionsReachable === true || (input.sessions != null && typeof input.sessions === 'object')
  const daemonGreen = Boolean(daemon.ok)
  const codexOk = daemonGreen || sessionsReachable

  return {
    displayName,
    envLabel: `${displayName} 开发环境`,
    stats: statsParts.join(' · '),
    pending,
    skillCount,
    worktreeCount,
    attention,
    workspaces: trees.map(mapWorkspaceRow),
    updateCount: updateItems.length,
    overviewPrimary: overviewPrimary(attention),
    git: gitOk ? { status: 'ok', label: '正常' } : { status: 'off', label: '未连接' },
    codex: codexOk
      ? { status: 'ok', label: daemonGreen ? '正常' : '可访问' }
      : { status: 'off', label: '未连接' },
    storage: hubRoot ? `本机 hub · ${hubRoot}` : '本机 hub',
    hubRoot,
    gameRepo,
    user: { name: displayName, subtitle: '本机开发者' }
  }
}

export function navFromPath(pathname) {
  const path = String(pathname || '/')
  if (path === '/' || path === '') return 'overview'
  if (path === '/skills' || path.startsWith('/skills/')) return 'skills'
  if (path === '/updates' || path.startsWith('/updates/')) return 'updates'
  if (path === '/workspaces' || path.startsWith('/workspaces/')) return 'workspaces'
  if (path === '/store' || path.startsWith('/store/')) return 'store'
  if (path === '/codex' || path.startsWith('/codex/')) return 'codex'
  if (path === '/settings' || path.startsWith('/settings/')) return 'settings'
  return 'overview'
}

export function hrefForNav(id) {
  return HUB_PATHS[id] || '/'
}

export function updateIdFromLocation(pathname, search) {
  const path = String(pathname || '')
  const match = path.match(/^\/updates\/([^/]+)\/?$/)
  if (match && match[1]) {
    try {
      return decodeURIComponent(match[1])
    } catch {
      return match[1]
    }
  }
  const raw = String(search || '')
  const q = new URLSearchParams(raw.startsWith('?') ? raw.slice(1) : raw)
  return q.get('id') || ''
}

export function searchParam(search, key) {
  const raw = String(search || '')
  const q = new URLSearchParams(raw.startsWith('?') ? raw.slice(1) : raw)
  return q.get(key) || ''
}
