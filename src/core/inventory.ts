import { RESIDENT_SKILLS } from './constants.js'
import type { HubContext } from './ports.js'
import type { SkillKind, SkillNode } from './types.js'

export function listSkillGroup(ctx: HubContext, rel: string, kind: SkillKind): SkillNode[] {
  const abs = ctx.path.join(ctx.hubRoot, ...rel.split('/'))
  if (!ctx.fs.exists(abs) || !ctx.fs.isDirectory(abs)) return []
  return ctx.fs.readDir(abs)
    .filter((entry) => entry.isDirectory)
    .map((entry) => ({
      name: entry.name,
      kind,
      path: `${rel.replaceAll('\\', '/')}/${entry.name}`,
      hasSkillMd: ctx.fs.exists(ctx.path.join(abs, entry.name, 'SKILL.md')),
      attached: false
    }))
}

export function listResidentSkills(ctx: HubContext, gameRepo: string | null): SkillNode[] {
  return RESIDENT_SKILLS.map((name) => ({
    name,
    kind: 'resident' as const,
    path: `skills/${name}`,
    hasSkillMd: ctx.fs.exists(ctx.path.join(ctx.hubRoot, 'skills', name, 'SKILL.md')),
    attached: Boolean(
      gameRepo
      && ctx.link.isLinked(
        ctx.path.join(gameRepo, '.agents', 'skills', name),
        ctx.path.join(ctx.hubRoot, 'skills', name)
      )
    )
  }))
}

export function listAdoptedSkills(ctx: HubContext, gameRepo: string | null): SkillNode[] {
  return listSkillGroup(ctx, 'skills/adopted', 'adopted').map((node) => ({
    ...node,
    attached: Boolean(
      gameRepo
      && ctx.link.isLinked(
        ctx.path.join(gameRepo, '.agents', 'skills', node.name),
        ctx.path.join(ctx.hubRoot, 'skills', 'adopted', node.name)
      )
    )
  }))
}

export function listInboxSkills(ctx: HubContext): SkillNode[] {
  return listSkillGroup(ctx, 'skills/inbox', 'inbox')
}

export function listSkills(ctx: HubContext, gameRepo: string | null) {
  return {
    resident: listResidentSkills(ctx, gameRepo),
    adopted: listAdoptedSkills(ctx, gameRepo),
    inbox: listInboxSkills(ctx)
  }
}
