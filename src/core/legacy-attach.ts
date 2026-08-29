import type {
  ApprovedLegacyAttachPlan,
  LegacyAttachArtifactFact,
  LegacyAttachInspection,
  LegacyAttachSourcePolicy,
  LegacyVisibilityMode
} from '../contracts/index.js'
import {
  classifyConflict,
  decideFirstAttach,
  evaluateClaim,
  recognizeWorktree,
  type ConflictKind
} from './policies.js'

export type LegacyAttachPlanInput = {
  inspection: LegacyAttachInspection
  mode: 'firstAttach' | 'repair'
  sourcePolicy?: LegacyAttachSourcePolicy
  visibility?: LegacyVisibilityMode
  configureGit?: boolean
  attachSessionAuthorized?: boolean
}

export type LegacyAttachPlanDecision =
  | { decision: 'apply'; plan: ApprovedLegacyAttachPlan }
  | { decision: 'noop'; reason: 'not-attached' | 'blocked'; worktree: string }
  | { decision: 'session-required'; worktree: string }
  | {
      decision: 'rejected'
      reason: 'unrecognized' | 'blocked' | 'library-missing' | 'conflict'
      worktree: string
      conflict?: ConflictKind
      artifact?: string
    }

function normalizedRelative(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '').toLowerCase()
}

function isLegacyAssistantPath(relative: string): boolean {
  const value = normalizedRelative(relative)
  if (value === '.claude' || value.startsWith('.claude/')) return true
  if (value === '.codex/agents' || value.startsWith('.codex/agents/')) return true
  if (value === '.codex/scripts' || value.startsWith('.codex/scripts/')) return true
  if (value === '.codex/skills' || value.startsWith('.codex/skills/')) return true
  if (value === '.codex/cursor-rules.env') return true
  // .agents/skills is project-owned unless an exact Skill is separately
  // represented by an approved Hub artifact. Unknown private Skills are never
  // visibility-cleanup targets.
  return false
}

function artifactConflict(fact: LegacyAttachArtifactFact) {
  return classifyConflict({
    targetExists: fact.observed.exists,
    expectedKind: fact.expectedKind,
    actualKind: fact.observed.actualKind,
    linkedToExpected: fact.observed.linkedToExpected,
    pointsElsewhere: fact.observed.pointsElsewhere,
    contentMatches: fact.observed.contentMatches
  })
}

function artifactAction(
  fact: LegacyAttachArtifactFact,
  sourcePolicy: LegacyAttachSourcePolicy
): { action: ApprovedLegacyAttachPlan['artifacts'][number]['action'] } | { conflict: ConflictKind } {
  const conflict = artifactConflict(fact)
  if (conflict.kind === 'none') {
    return { action: fact.observed.linkedToExpected ? 'keep' : 'link' }
  }
  if (conflict.kind === 'external-link'
    || conflict.kind === 'kind-mismatch'
    || conflict.kind === 'dirty'
    || conflict.kind === 'protected-target') {
    return { conflict: conflict.kind }
  }
  if (fact.kind === 'localOverlay' && fact.observed.actualKind === 'directory') {
    return { action: 'backupThenLink' }
  }
  if (conflict.kind === 'identical-content') return { action: 'replaceWithLibrary' }
  if (sourcePolicy === 'preferLibrary') return { action: 'replaceWithLibrary' }
  if (sourcePolicy === 'promoteFromWorktree') return { action: 'promoteToLibraryThenLink' }
  return { conflict: conflict.kind }
}

export function planLegacyAttach(input: LegacyAttachPlanInput): LegacyAttachPlanDecision {
  const sourcePolicy = input.sourcePolicy || 'requireMatch'
  const visibility = input.mode === 'repair' ? 'preserve' : input.visibility || 'disable'
  const worktree = input.inspection.worktree
  const recognition = recognizeWorktree(worktree.recognition)

  if (input.mode === 'repair') {
    if (!input.inspection.gitWorktree || !recognition.recognized) {
      return { decision: 'rejected', reason: 'unrecognized', worktree: worktree.resolvedPath }
    }
    if (worktree.blocked) return { decision: 'noop', reason: 'blocked', worktree: worktree.resolvedPath }
    if (!worktree.claimed) return { decision: 'noop', reason: 'not-attached', worktree: worktree.resolvedPath }
  } else {
    if (!input.inspection.gitWorktree) {
      return { decision: 'rejected', reason: 'unrecognized', worktree: worktree.resolvedPath }
    }
    const claim = evaluateClaim({ recognition, blocked: worktree.blocked, claimed: worktree.claimed })
    const firstAttach = decideFirstAttach(claim)
    if (firstAttach.decision === 'rejected') {
      return {
        decision: 'rejected',
        reason: firstAttach.reason,
        worktree: worktree.resolvedPath
      }
    }
    // Applying managed attach effects is always an explicitly authorized attach
    // action. A prior claim only changes claim persistence; it is not reusable
    // authorization for promotion, visibility, or Git effects.
    if (!input.attachSessionAuthorized) {
      return { decision: 'session-required', worktree: worktree.resolvedPath }
    }
    if (!recognition.recognized) {
      return { decision: 'rejected', reason: 'unrecognized', worktree: worktree.resolvedPath }
    }
  }

  const artifacts: ApprovedLegacyAttachPlan['artifacts'][number][] = []
  for (const fact of input.inspection.artifacts) {
    if (!fact.libraryExists) {
      return {
        decision: 'rejected',
        reason: 'library-missing',
        worktree: worktree.resolvedPath,
        artifact: fact.id
      }
    }
    const resolved = artifactAction(fact, sourcePolicy)
    if ('conflict' in resolved) {
      return {
        decision: 'rejected',
        reason: 'conflict',
        conflict: resolved.conflict,
        worktree: worktree.resolvedPath,
        artifact: fact.id
      }
    }
    artifacts.push({ ...fact, action: resolved.action })
  }

  const trackedPaths = visibility === 'disable'
    ? input.inspection.trackedAssistantPaths.filter((relative) => isLegacyAssistantPath(relative))
    : []
  const removePaths = visibility === 'disable'
    ? input.inspection.presentAssistantPaths.filter((relative) => isLegacyAssistantPath(relative))
    : []

  return {
    decision: 'apply',
    plan: {
      mode: input.mode,
      worktree: worktree.resolvedPath,
      sourcePolicy,
      artifacts,
      visibility: { mode: visibility, trackedPaths, removePaths },
      configureGit: input.mode === 'firstAttach' && Boolean(input.configureGit),
      claim: input.mode === 'firstAttach' && !worktree.claimed ? 'create' : 'keep'
    }
  }
}
