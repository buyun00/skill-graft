import type { HubContext } from './ports.js'

export function repairPlan(ctx: HubContext, worktree: string) {
  const resolved = ctx.path.resolve(worktree)
  const attached = ctx.persist.readList(ctx.path.join(ctx.hubRoot, 'overlay', 'attached-worktrees.txt'))
  const blocked = ctx.persist.readList(ctx.path.join(ctx.hubRoot, 'overlay', 'do-not-auto-attach.txt'))
  const isAttached = attached.some((item) => ctx.link.samePath(item, resolved))
  const isBlocked = blocked.some((item) => ctx.link.samePath(item, resolved))
  return {
    action: 'repair-links' as const,
    worktree: resolved,
    attached: isAttached,
    blocked: isBlocked
  }
}
