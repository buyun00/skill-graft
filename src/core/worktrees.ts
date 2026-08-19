import { EPHEMERAL_PATH_MARKERS, EXCLUDED_CHECKOUT_NAMES } from './constants.js'
import type { HubContext } from './ports.js'
import type { GitWorktreeRef, WorktreeInfo, WorktreeList } from './types.js'

export function isEphemeralPath(dir: string): boolean {
  const normalized = dir.replaceAll('\\', '/').toLowerCase()
  return EPHEMERAL_PATH_MARKERS.some((marker) => normalized.includes(marker))
}

export function isClientCheckout(ctx: HubContext, dir: string): boolean {
  if (!dir || !ctx.fs.exists(dir)) return false
  if (ctx.link.samePath(dir, ctx.hubRoot)) return false
  const name = ctx.path.basename(dir).toLowerCase()
  if ((EXCLUDED_CHECKOUT_NAMES as readonly string[]).includes(name)) return false
  if (name.includes('.partial-')) return false
  return ctx.fs.exists(ctx.path.join(dir, 'AGENTS.md')) && ctx.fs.exists(ctx.path.join(dir, 'baloot_client'))
}

export function parseWorktreePorcelain(text: string): GitWorktreeRef[] {
  const trees: GitWorktreeRef[] = []
  let current: Partial<GitWorktreeRef> & { detached?: boolean } = {}
  const flush = () => {
    if (!current.path) return
    trees.push({
      path: current.path,
      branch: current.branch || (current.detached ? '(detached)' : ''),
      head: current.head || '',
      locked: Boolean(current.locked),
      prunable: Boolean(current.prunable)
    })
    current = {}
  }
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      flush()
      current.path = line.slice(9)
    } else if (line.startsWith('HEAD ')) current.head = line.slice(5)
    else if (line.startsWith('branch ')) current.branch = line.slice(7).replace('refs/heads/', '')
    else if (line === 'detached') current.detached = true
    else if (line.startsWith('locked')) current.locked = true
    else if (line.startsWith('prunable')) current.prunable = true
    else if (line === '') flush()
  }
  flush()
  return trees
}

export function cloneRootFromCommonDir(ctx: HubContext, commonDir: string): string {
  const resolved = ctx.path.resolve(commonDir)
  const base = ctx.path.basename(resolved)
  const parent = ctx.path.dirname(resolved)
  if (base === '.git') return parent
  if (ctx.path.basename(parent) === 'worktrees' && ctx.path.basename(ctx.path.dirname(parent)) === '.git') {
    return ctx.path.dirname(ctx.path.dirname(parent))
  }
  return parent
}

function latestLocalChangeMs(ctx: HubContext, dir: string): number {
  const times = [
    ctx.fs.statMtimeMs(dir),
    ctx.fs.statMtimeMs(ctx.path.join(dir, '.git')),
    ctx.fs.statMtimeMs(ctx.path.join(dir, 'AGENTS.override.md'))
  ]
  const gitDir = ctx.git.output(dir, ['rev-parse', '--absolute-git-dir']).trim()
  if (gitDir) {
    times.push(
      ctx.fs.statMtimeMs(gitDir),
      ctx.fs.statMtimeMs(ctx.path.join(gitDir, 'HEAD')),
      ctx.fs.statMtimeMs(ctx.path.join(gitDir, 'index'))
    )
  }
  return Math.max(0, ...times)
}

function discoverClientDirs(ctx: HubContext, roots: string[]): string[] {
  const found: string[] = []
  for (const root of roots) {
    if (!root || !ctx.fs.exists(root)) continue
    let entries = []
    try {
      entries = ctx.fs.readDir(root)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory && !entry.isSymbolicLink) continue
      const full = ctx.path.join(root, entry.name)
      if (isClientCheckout(ctx, full)) found.push(full)
    }
  }
  return found
}

export function listWorktrees(ctx: HubContext): WorktreeList {
  const scanRoots = ctx.persist.readList(ctx.path.join(ctx.hubRoot, 'overlay', 'scan-roots.txt'))
  const discovered = discoverClientDirs(ctx, scanRoots)
  const cloneSeeds = new Map<string, { seed: string; common: string }>()
  for (const dir of discovered) {
    const raw = ctx.git.output(dir, ['rev-parse', '--git-common-dir']).trim()
    const common = raw ? ctx.path.resolve(dir, raw) : ctx.path.resolve(dir, '.git')
    if (!cloneSeeds.has(common.toLowerCase())) cloneSeeds.set(common.toLowerCase(), { seed: dir, common })
  }

  const attached = ctx.persist.readList(ctx.path.join(ctx.hubRoot, 'overlay', 'attached-worktrees.txt'))
  const blocked = ctx.persist.readList(ctx.path.join(ctx.hubRoot, 'overlay', 'do-not-auto-attach.txt'))
  const byPath = new Map<string, WorktreeInfo>()

  const addTree = (info: GitWorktreeRef, cloneRoot: string, requireClient: boolean) => {
    if (!info.path || !ctx.fs.exists(info.path) || ctx.link.samePath(info.path, ctx.hubRoot)) return
    if (requireClient && !isClientCheckout(ctx, info.path)) return
    const resolved = ctx.path.resolve(info.path)
    const key = resolved.toLowerCase()
    if (byPath.has(key)) return
    const changedAtMs = latestLocalChangeMs(ctx, resolved)
    byPath.set(key, {
      name: ctx.path.basename(resolved),
      path: info.path,
      branch: info.branch || ctx.git.output(info.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() || '(unknown)',
      head: info.head || ctx.git.output(info.path, ['rev-parse', 'HEAD']).trim(),
      cloneRoot,
      changedAt: changedAtMs ? new Date(changedAtMs).toISOString() : '',
      changedAtMs,
      attached: attached.some((item) => ctx.link.samePath(item, info.path)),
      doNotAuto: blocked.some((item) => ctx.link.samePath(item, info.path)),
      officialPresent:
        ctx.fs.exists(ctx.path.join(info.path, '.claude', 'skills'))
        || ctx.fs.exists(ctx.path.join(info.path, '.codex', 'skills')),
      overrideLinked: ctx.link.isLinked(
        ctx.path.join(info.path, 'AGENTS.override.md'),
        ctx.path.join(ctx.hubRoot, 'AGENTS.override.md')
      ),
      ephemeral: isEphemeralPath(info.path),
      locked: Boolean(info.locked),
      prunable: Boolean(info.prunable)
    })
  }

  for (const { seed, common } of cloneSeeds.values()) {
    const porcelain = ctx.git.output(seed, ['worktree', 'list', '--porcelain'])
    const listed = parseWorktreePorcelain(porcelain)
    const cloneRoot = cloneRootFromCommonDir(ctx, common)
    if (listed.length === 0) {
      addTree({ path: seed, branch: '', head: '', locked: false, prunable: false }, cloneRoot, true)
      continue
    }
    for (const tree of listed) addTree(tree, cloneRoot, false)
  }

  for (const dir of discovered) {
    const raw = ctx.git.output(dir, ['rev-parse', '--git-common-dir']).trim()
    const common = raw ? ctx.path.resolve(dir, raw) : ctx.path.resolve(dir, '.git')
    addTree({ path: dir, branch: '', head: '', locked: false, prunable: false }, cloneRootFromCommonDir(ctx, common), true)
  }

  const worktrees = [...byPath.values()].sort((left, right) => (right.changedAtMs || 0) - (left.changedAtMs || 0))
  return { worktrees, scanRoots }
}
