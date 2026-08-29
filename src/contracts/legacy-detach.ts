import type { LegacyAttachArtifactFact, LegacyAttachInspection } from './legacy-attach.js'

export type LegacyDetachInspection = LegacyAttachInspection

export type LegacyDetachArtifactAction = 'unlink' | 'keepMissing'

export type LegacyDetachPlanArtifact = LegacyAttachArtifactFact & {
  action: LegacyDetachArtifactAction
}

export type ApprovedLegacyDetachPlan = {
  worktree: string
  artifacts: readonly LegacyDetachPlanArtifact[]
  restorePaths: readonly string[]
  removeClaim: true
}

export type LegacyDetachApplyEffect = {
  id: string
  status: 'unlinked' | 'missing'
}

export type LegacyDetachApplyReport = {
  changed: boolean
  effects: readonly LegacyDetachApplyEffect[]
  restoredTracked: number
  claim: 'removed'
}
