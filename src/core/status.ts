import { listSkills } from './inventory.js'
import type { HubContext } from './ports.js'
import type { HubState } from './types.js'

export function gameRepoOf(ctx: HubContext): string | null {
  return ctx.git.configGet(ctx.hubRoot, 'ozdqp.gameRepo')
}

export function getStatus(ctx: HubContext): HubState {
  const gameRepo = gameRepoOf(ctx)
  const state = ctx.persist.readState(ctx.path.join(ctx.hubRoot, 'skill-review', 'state.json'))
  const skills = listSkills(ctx, gameRepo)
  const items = state.items || []
  return {
    hubRoot: ctx.hubRoot,
    gameRepo,
    lastIngest: state.lastIngest || null,
    ...skills,
    items,
    counts: {
      resident: skills.resident.length,
      adopted: skills.adopted.length,
      queued: items.filter((item) => item.status === 'queued').length,
      proposed: items.filter((item) => item.status === 'proposed').length
    }
  }
}
