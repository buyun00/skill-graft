import type { LocalHostContext } from './host-context.js'

/** Stable canonical worktree path shared by P2 persistence and query readback. */
export function canonicalLocalWorktreePath(
  context: LocalHostContext,
  worktree: string
): string | null {
  const resolved = context.path.resolve(worktree)
  if (!context.fs.isDirectory(resolved)) return null
  const firstRealpath = context.fs.realpath(resolved)
  const secondRealpath = context.fs.realpath(resolved)
  if (!firstRealpath || !secondRealpath
    || context.path.comparisonKey(firstRealpath) !== context.path.comparisonKey(secondRealpath)
    || !context.fs.isDirectory(firstRealpath)) {
    return null
  }
  return context.path.resolve(firstRealpath)
}
