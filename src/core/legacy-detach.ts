import type {
  ApprovedLegacyDetachPlan,
  LegacyDetachInspection
} from '../contracts/index.js'
import { recognizeWorktree, type ConflictKind } from './policies.js'

export type LegacyDetachPlanInput = {
  inspection: LegacyDetachInspection
  detachSessionAuthorized?: boolean
}

export type LegacyDetachPlanDecision =
  | { decision: 'apply'; plan: ApprovedLegacyDetachPlan }
  | { decision: 'noop'; reason: 'not-attached'; worktree: string }
  | { decision: 'session-required'; worktree: string }
  | {
      decision: 'rejected'
      reason: 'unrecognized' | 'blocked' | 'conflict'
      worktree: string
      conflict?: ConflictKind
      artifact?: string
      path?: string
    }

function normalizedRelativeIdentity(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

function isRestorableAssistantPath(relative: string): boolean {
  // Fixed legacy assistant namespaces are intentionally classified without
  // case sensitivity. Path identity below remains case-sensitive so POSIX
  // paths such as .claude/A and .claude/a are never collapsed together.
  const value = normalizedRelativeIdentity(relative).toLowerCase()
  if (value === '.claude' || value.startsWith('.claude/')) return true
  if (value === '.codex/agents' || value.startsWith('.codex/agents/')) return true
  if (value === '.codex/scripts' || value.startsWith('.codex/scripts/')) return true
  if (value === '.codex/skills' || value.startsWith('.codex/skills/')) return true
  if (value === '.codex/cursor-rules.env') return true
  return false
}

function overlaps(left: string, right: string): boolean {
  const a = normalizedRelativeIdentity(left)
  const b = normalizedRelativeIdentity(right)
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

function uniqueSorted(paths: readonly string[]): string[] {
  const unique = new Map<string, string>()
  for (const path of paths) {
    const key = normalizedRelativeIdentity(path)
    if (key && !unique.has(key)) unique.set(key, key)
  }
  return [...unique.values()].sort((left, right) => normalizedRelativeIdentity(left).localeCompare(normalizedRelativeIdentity(right)))
}

export function planLegacyDetach(input: LegacyDetachPlanInput): LegacyDetachPlanDecision {
  const worktree = input.inspection.worktree
  const recognition = recognizeWorktree(worktree.recognition)
  if (!input.inspection.gitWorktree || !recognition.recognized) {
    return { decision: 'rejected', reason: 'unrecognized', worktree: worktree.resolvedPath }
  }
  if (worktree.blocked) return { decision: 'rejected', reason: 'blocked', worktree: worktree.resolvedPath }
  if (!input.detachSessionAuthorized) return { decision: 'session-required', worktree: worktree.resolvedPath }
  if (!worktree.claimed) return { decision: 'noop', reason: 'not-attached', worktree: worktree.resolvedPath }

  const artifacts: ApprovedLegacyDetachPlan['artifacts'][number][] = []
  for (const fact of input.inspection.artifacts) {
    if (!fact.observed.exists) {
      artifacts.push({ ...fact, action: 'keepMissing' })
      continue
    }
    if (!fact.observed.linkedToExpected) {
      return {
        decision: 'rejected',
        reason: 'conflict',
        conflict: fact.observed.pointsElsewhere ? 'external-link' : 'dirty',
        worktree: worktree.resolvedPath,
        artifact: fact.id
      }
    }
    artifacts.push({ ...fact, action: 'unlink' })
  }

  const unlinkTargets = artifacts
    .filter((artifact) => artifact.action === 'unlink')
    .map((artifact) => artifact.targetRelativePath)
  const managedTargets = artifacts.map((artifact) => artifact.targetRelativePath)
  const restorePaths = uniqueSorted(input.inspection.trackedAssistantPaths.filter((relative) => (
    isRestorableAssistantPath(relative)
      || managedTargets.some((target) => overlaps(relative, target))
  )))
  const unexpected = input.inspection.presentAssistantPaths
    .filter((relative) => isRestorableAssistantPath(relative)
      || unlinkTargets.some((target) => overlaps(relative, target)))
    .filter((relative) => !unlinkTargets.some((target) => overlaps(relative, target)))
    .find((present) => restorePaths.some((tracked) => overlaps(present, tracked)))
  if (unexpected) {
    return {
      decision: 'rejected',
      reason: 'conflict',
      conflict: 'dirty',
      worktree: worktree.resolvedPath,
      path: unexpected
    }
  }

  return {
    decision: 'apply',
    plan: {
      worktree: worktree.resolvedPath,
      artifacts,
      restorePaths,
      removeClaim: true
    }
  }
}
