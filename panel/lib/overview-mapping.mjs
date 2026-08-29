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
  diagnostics: '/api/host/diagnostics',
  command: '/api/command',
  stream: '/api/codex/session/stream',
}

export function shortHash(value) {
  if (value == null || value === '') return ''
  const text = String(value).trim()
  if (!text) return ''
  return text.length > 7 ? text.slice(0, 7) : text
}

export function needsRepair(tree) {
  return tree != null && tree.attached === true && (
    tree.officialPresent === true
    || (tree.materialized !== true && tree.overrideLinked === false)
  )
}

export function workspaceStatus(tree) {
  if (tree && tree.attached === true && tree.officialPresent === false
    && (tree.materialized === true || tree.overrideLinked === true)) {
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
    materialized: tree && tree.materialized,
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

function diagnosticStatus(diagnostics, key, checked) {
  if (checked !== true) return { status: 'warn', label: '检测中' }
  const record = diagnostics && typeof diagnostics === 'object' ? diagnostics[key] : null
  if (record && typeof record === 'object' && record.ok === true) {
    return { status: 'ok', label: '可用' }
  }
  if (record && typeof record === 'object' && record.ok === false) {
    return { status: 'off', label: '不可用' }
  }
  return { status: 'warn', label: '检测失败' }
}

export function sessionFromEnvelope(payload) {
  if (!payload || typeof payload !== 'object') return null
  const body = payload.data && typeof payload.data === 'object' ? payload.data : payload
  const nested = body.session
  if (nested && typeof nested === 'object') return nested
  if (body.id || body.status) return body
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
  const stateAvailable = input.state != null && typeof input.state === 'object'
  const state = input.state || {}
  const worktreesPayload = input.worktrees || {}
  const items = Array.isArray(state.items) ? state.items : []
  const trees = Array.isArray(worktreesPayload.worktrees) ? worktreesPayload.worktrees : []
  const residentSkills = Array.isArray(state.resident) ? state.resident : []
  const adoptedSkills = Array.isArray(state.adopted) ? state.adopted : []
  const librarySkills = [...residentSkills, ...adoptedSkills]
    .filter((skill) => skill && skill.hasSkillMd !== false)
  const counts = state.counts || {}
  const queued = Number(counts.queued || 0)
  const proposed = Number(counts.proposed || 0)

  const updateItems = items.filter((item) => item && (item.status === 'queued' || item.status === 'proposed'))
  const repairTrees = trees.filter(needsRepair)
  const attention = [...updateItems.map(mapUpdateAttention), ...repairTrees.map(mapRepairAttention)]
  const pending = queued + proposed + repairTrees.length
  const librarySkillCount = librarySkills.length
  const connectedSkillCount = librarySkills.filter((skill) => skill.attached === true).length
  const worktreeCount = trees.length
  const attachedWorktreeCount = trees.filter((tree) => tree && tree.attached === true).length
  const worktreesPhase = input.worktreesPhase || (input.worktrees ? 'ready' : 'loading')

  const statsParts = [
    `技能库内容 ${librarySkillCount}`,
    `工作树已连接 Skill ${connectedSkillCount}`
  ]
  if (worktreesPhase === 'ready') {
    statsParts.push(`已识别工作树 ${worktreeCount}`, `已连接工作树 ${attachedWorktreeCount}`)
  } else if (worktreesPhase === 'error') {
    statsParts.push('工作树扫描失败')
  } else {
    statsParts.push('工作树扫描中')
  }
  if (pending > 0) statsParts.push(`${pending} 待处理`)

  const displayName = displayNameOf(input.userName)
  const hubRoot = state.hubRoot || ''
  const gameRepo = state.gameRepo || null
  const repositorySelected = typeof gameRepo === 'string' && gameRepo.trim().length > 0
  const stateChecked = input.stateChecked === true || stateAvailable

  return {
    displayName,
    envLabel: `${displayName} 开发环境`,
    stats: statsParts.join(' · '),
    pending,
    skillCount: librarySkillCount,
    librarySkillCount,
    connectedSkillCount,
    worktreeCount,
    attachedWorktreeCount,
    attention,
    workspaces: trees.map(mapWorkspaceRow),
    updateCount: updateItems.length,
    overviewPrimary: overviewPrimary(attention),
    git: diagnosticStatus(input.diagnostics, 'git', input.diagnosticsChecked),
    repository: !stateChecked
      ? { status: 'warn', label: '读取中' }
      : !stateAvailable
        ? { status: 'warn', label: '读取失败' }
        : repositorySelected
          ? { status: 'ok', label: '已选择' }
          : { status: 'off', label: '未选择' },
    codex: diagnosticStatus(input.diagnostics, 'codex', input.diagnosticsChecked),
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
