export type LegacyAttachSourcePolicy = 'requireMatch' | 'preferLibrary' | 'promoteFromWorktree'

export type LegacyVisibilityMode = 'disable' | 'preserve'

export type LegacyAttachArtifactKind = 'agentsOverride' | 'residentSkill' | 'adoptedSkill' | 'localOverlay'

export type LegacyAttachObservedArtifact = {
  exists: boolean
  actualKind?: 'file' | 'directory' | 'link'
  linkedToExpected: boolean
  pointsElsewhere: boolean
  contentMatches: boolean
  observedDigest?: string
  libraryDigest?: string
}

export type LegacyAttachArtifactFact = {
  id: string
  kind: LegacyAttachArtifactKind
  name?: string
  label: string
  targetRelativePath: string
  hubRelativePath: string
  expectedKind: 'file' | 'directory'
  libraryExists: boolean
  observed: LegacyAttachObservedArtifact
  backupRelativePath?: string
}

export type LegacyAttachWorktreeInspection = {
  /** Opaque, host-generated identity used to bind attach authorization. */
  targetId: string
  resolvedPath: string
  recognition: {
    exists: boolean
    isDirectory: boolean
    sameAsHub: boolean
    excluded: boolean
    partialCheckout: boolean
    explicitlyAllowed: boolean
    ephemeral: boolean
    requiredMarkers: readonly {
      name: string
      present: boolean
    }[]
  }
  blocked: boolean
  claimed: boolean
}

export type LegacyAttachInspection = {
  worktree: LegacyAttachWorktreeInspection
  gitWorktree: boolean
  artifacts: readonly LegacyAttachArtifactFact[]
  trackedAssistantPaths: readonly string[]
  presentAssistantPaths: readonly string[]
}

export type LegacyAttachArtifactAction =
  | 'keep'
  | 'link'
  | 'replaceWithLibrary'
  | 'promoteToLibraryThenLink'
  | 'backupThenLink'

export type LegacyAttachPlanArtifact = LegacyAttachArtifactFact & {
  action: LegacyAttachArtifactAction
}

export type ApprovedLegacyAttachPlan = {
  mode: 'firstAttach' | 'repair'
  worktree: string
  sourcePolicy: LegacyAttachSourcePolicy
  artifacts: readonly LegacyAttachPlanArtifact[]
  visibility: {
    mode: LegacyVisibilityMode
    trackedPaths: readonly string[]
    removePaths: readonly string[]
  }
  configureGit: boolean
  claim: 'create' | 'keep'
}

export type LegacyAttachApplyEffect = {
  id: string
  status: 'applied' | 'unchanged'
  mechanism?: string
}

export type LegacyAttachApplyReport = {
  changed: boolean
  effects: readonly LegacyAttachApplyEffect[]
  visibility: {
    trackedChanged: number
    removed: number
  }
  gitConfigured: boolean
  claim: 'created' | 'alreadyClaimed'
}
