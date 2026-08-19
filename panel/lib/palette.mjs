import { HUB_PATHS } from './overview-mapping.mjs'

export const HUB_QUICK_LINKS = [
  { label: '总览', href: HUB_PATHS.overview },
  { label: '技能库', href: HUB_PATHS.skills },
  { label: '更新中心', href: HUB_PATHS.updates },
  { label: '工作区', href: HUB_PATHS.workspaces },
  { label: 'Codex 助手', href: HUB_PATHS.codex },
  { label: '设置', href: HUB_PATHS.settings }
]

export function buildPaletteEntries({ state, worktrees } = {}) {
  const entries = []
  const groups = [
    ['resident', (state && state.resident) || []],
    ['adopted', (state && state.adopted) || []],
    ['inbox', (state && state.inbox) || []]
  ]
  for (const [kind, list] of groups) {
    for (const skill of list) {
      const skillPath = (skill && skill.path) || ''
      entries.push({
        id: `skill:${skillPath || skill.name}`,
        title: skill.name,
        category: kind,
        href: skillPath ? `${HUB_PATHS.skills}?path=${encodeURIComponent(skillPath)}` : HUB_PATHS.skills
      })
    }
  }
  for (const tree of (worktrees && worktrees.worktrees) || []) {
    const treePath = (tree && tree.path) || ''
    entries.push({
      id: `worktree:${treePath || tree.name}`,
      title: tree.name,
      category: 'workspace',
      href: treePath ? `${HUB_PATHS.workspaces}?path=${encodeURIComponent(treePath)}` : HUB_PATHS.workspaces
    })
  }
  for (const item of (state && state.items) || []) {
    if (!item || !item.id) continue
    entries.push({
      id: `update:${item.id}`,
      title: item.name || item.id,
      category: item.status || 'update',
      href: `${HUB_PATHS.updates}/${encodeURIComponent(item.id)}`
    })
  }
  return entries
}

export function filterPaletteEntries(entries, query) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return entries
  return (entries || []).filter((item) => {
    const title = String(item.title || '').toLowerCase()
    const category = String(item.category || '').toLowerCase()
    const href = String(item.href || '').toLowerCase()
    return title.includes(q) || category.includes(q) || href.includes(q)
  })
}
