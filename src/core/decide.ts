import type { HubContext } from './ports.js'
import type { HubStateFile, InboxItem } from './types.js'

export type DecideAction = 'adopt' | 'merge' | 'reject'

function stateFile(ctx: HubContext) {
  return ctx.path.join(ctx.hubRoot, 'skill-review', 'state.json')
}

function writeHistory(ctx: HubContext, record: Record<string, unknown>) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const id = typeof record.id === 'string' ? record.id : 'decide'
  ctx.persist.writeJson(ctx.path.join(ctx.hubRoot, 'skill-review', 'history', `${stamp}-${id}.json`), record)
}

export function decide(
  ctx: HubContext,
  input: { id: string; action: DecideAction; note?: string; mergeTarget?: string }
) {
  if (!input.id) throw new Error('decide requires --id')
  if (input.action !== 'adopt' && input.action !== 'merge' && input.action !== 'reject') {
    throw new Error('decide --action must be adopt, merge, or reject')
  }
  const file = stateFile(ctx)
  const state: HubStateFile = ctx.persist.readState(file)
  const items = state.items || []
  const item = items.find((entry) => entry.id === input.id)
  if (!item) throw new Error(`Unknown inbox item: ${input.id}`)

  const now = new Date().toISOString()
  let trees: { linked: Array<{ worktree: string; status: string }>; skipped: Array<{ worktree: string; reason: string }> } = {
    linked: [],
    skipped: []
  }
  if (input.action === 'adopt') trees = applyAdopt(ctx, item)
  else if (input.action === 'merge') applyMerge(ctx, item, input.mergeTarget)
  else applyReject(ctx, item)

  item.note = input.note
  item.updatedAt = now
  state.items = items
  ctx.persist.writeState(file, state)
  writeHistory(ctx, { type: 'decide', id: input.id, action: input.action, note: input.note, mergeTarget: input.mergeTarget })
  return { ok: true, action: input.action, item, trees }
}

function inboxAbs(ctx: HubContext, item: InboxItem) {
  return item.inboxPath ? ctx.path.join(ctx.hubRoot, ...item.inboxPath.split('/')) : ''
}

function applyAdopt(ctx: HubContext, item: InboxItem) {
  const name = item.name || (item.inboxPath ? ctx.path.basename(item.inboxPath) : '')
  if (!name) throw new Error('adopt requires item name')
  const destRel = `skills/adopted/${name}`
  const dest = ctx.path.join(ctx.hubRoot, 'skills', 'adopted', name)
  if (ctx.fs.exists(dest)) throw new Error(`adopted already exists: ${destRel}`)
  const source = inboxAbs(ctx, item)
  if (!source || !ctx.fs.exists(source)) throw new Error(`inbox missing: ${item.inboxPath || name}`)
  ctx.fs.mkdirp(ctx.path.dirname(dest))
  ctx.fs.rename(source, dest)
  item.status = 'adopted'
  item.adoptedPath = destRel
  return linkAdopted(ctx, name, dest)
}

function linkAdopted(ctx: HubContext, name: string, dest: string) {
  const attached = ctx.persist.readList(ctx.path.join(ctx.hubRoot, 'overlay', 'attached-worktrees.txt'))
  const linked: Array<{ worktree: string; status: string }> = []
  const skipped: Array<{ worktree: string; reason: string }> = []
  for (const tree of attached) {
    if (!ctx.fs.exists(tree)) {
      skipped.push({ worktree: tree, reason: 'missing' })
      continue
    }
    const linkPath = ctx.path.join(tree, '.agents', 'skills', name)
    if (ctx.link.isLinked(linkPath, dest)) {
      linked.push({ worktree: tree, status: 'ok' })
      continue
    }
    if (ctx.fs.exists(linkPath)) {
      skipped.push({ worktree: tree, reason: 'already points elsewhere' })
      continue
    }
    ctx.link.linkDirectory(linkPath, dest)
    linked.push({ worktree: tree, status: 'linked' })
  }
  return { linked, skipped }
}

function applyMerge(ctx: HubContext, item: InboxItem, mergeTarget?: string) {
  if (!mergeTarget) throw new Error('merge requires --merge-target')
  const targetAbs = ctx.path.join(ctx.hubRoot, ...mergeTarget.split('/'))
  if (!ctx.fs.exists(targetAbs)) throw new Error(`merge target missing: ${mergeTarget}`)
  item.status = 'merged-into-3skill'
  item.mergeTarget = mergeTarget
  const source = inboxAbs(ctx, item)
  if (source && ctx.fs.exists(source)) ctx.fs.remove(source)
}

function applyReject(ctx: HubContext, item: InboxItem) {
  item.status = 'rejected'
  const source = inboxAbs(ctx, item)
  if (source && ctx.fs.exists(source)) ctx.fs.remove(source)
}
