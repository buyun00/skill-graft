import { RESIDENT_SKILLS } from './constants.js'
import type { HubContext } from './ports.js'

type LinkJob = {
  label: string
  kind: 'file' | 'dir'
  linkPath: string
  hubPath: string
}

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

function jobs(ctx: HubContext, worktree: string): LinkJob[] {
  const resolved = ctx.path.resolve(worktree)
  return [
    {
      label: 'AGENTS.override.md',
      kind: 'file',
      linkPath: ctx.path.join(resolved, 'AGENTS.override.md'),
      hubPath: ctx.path.join(ctx.hubRoot, 'AGENTS.override.md')
    },
    ...RESIDENT_SKILLS.map((name) => ({
      label: name,
      kind: 'dir' as const,
      linkPath: ctx.path.join(resolved, '.agents', 'skills', name),
      hubPath: ctx.path.join(ctx.hubRoot, 'skills', name)
    })),
    {
      label: 'overlay',
      kind: 'dir',
      linkPath: ctx.path.join(resolved, '.codex', 'local-overlay'),
      hubPath: ctx.path.join(ctx.hubRoot, 'overlay')
    }
  ]
}

function fileBytesDiffer(ctx: HubContext, left: string, right: string): boolean {
  return (ctx.fs.readText(left) ?? '') !== (ctx.fs.readText(right) ?? '')
}

export function repairLinks(ctx: HubContext, worktree: string) {
  const plan = repairPlan(ctx, worktree)
  if (!plan.attached || plan.blocked) {
    return {
      ok: true,
      ...plan,
      repaired: false,
      reason: plan.blocked ? 'blocked' : 'not-attached',
      links: [] as Array<{ label: string; status: string }>
    }
  }

  const pending: LinkJob[] = []
  const links: Array<{ label: string; status: string }> = []
  for (const job of jobs(ctx, plan.worktree)) {
    if (!ctx.fs.exists(job.hubPath)) {
      throw new Error(`${job.label} is missing on the hub: ${job.hubPath}`)
    }
    if (ctx.link.isLinked(job.linkPath, job.hubPath)) {
      links.push({ label: job.label, status: 'ok' })
      continue
    }
    if (ctx.fs.exists(job.linkPath)) {
      if (job.kind === 'file' && fileBytesDiffer(ctx, job.linkPath, job.hubPath)) {
        throw new Error(`${job.label} differs from hub: ${job.linkPath}`)
      }
      if (job.kind === 'dir') {
        throw new Error(`${job.label} already points elsewhere: ${job.linkPath}`)
      }
    }
    pending.push(job)
  }

  for (const job of pending) {
    if (ctx.fs.exists(job.linkPath)) ctx.link.unlink(job.linkPath)
    if (job.kind === 'file') ctx.link.linkFile(job.linkPath, job.hubPath)
    else ctx.link.linkDirectory(job.linkPath, job.hubPath)
    links.push({ label: job.label, status: 'repaired' })
  }

  return { ok: true, ...plan, repaired: pending.length > 0, links }
}
