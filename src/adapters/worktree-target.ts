import type { LocalHostContext } from './host-context.js'

/** Local-host opaque identity. Shared Application compares this value but never derives it. */
export function worktreeTargetId(context: LocalHostContext, value: string): string {
  return `worktree:${context.hash.sha256(context.path.comparisonKey(value)).slice(0, 24)}`
}
