import type { InboxDecisionAction, InboxStatus } from '../contracts/state.js'

export type RecognitionRejectionReason =
  | 'missing'
  | 'not-directory'
  | 'hub-root'
  | 'excluded'
  | 'partial-checkout'
  | 'not-explicitly-allowed'
  | 'required-marker-missing'

export type WorktreeRecognitionInput = {
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

export type WorktreeRecognition =
  | {
      recognized: true
      via: 'explicit' | 'markers'
      ephemeral: boolean
    }
  | {
      recognized: false
      reason: RecognitionRejectionReason
      missingMarkers: readonly string[]
    }

export function recognizeWorktree(input: WorktreeRecognitionInput): WorktreeRecognition {
  if (!input.exists) return { recognized: false, reason: 'missing', missingMarkers: [] }
  if (!input.isDirectory) return { recognized: false, reason: 'not-directory', missingMarkers: [] }
  if (input.sameAsHub) return { recognized: false, reason: 'hub-root', missingMarkers: [] }
  if (input.excluded) return { recognized: false, reason: 'excluded', missingMarkers: [] }
  if (input.partialCheckout) return { recognized: false, reason: 'partial-checkout', missingMarkers: [] }
  if (input.explicitlyAllowed) return { recognized: true, via: 'explicit', ephemeral: input.ephemeral }
  if (input.requiredMarkers.length === 0) {
    return { recognized: false, reason: 'not-explicitly-allowed', missingMarkers: [] }
  }
  const missingMarkers = input.requiredMarkers.filter((marker) => !marker.present).map((marker) => marker.name)
  if (missingMarkers.length > 0) {
    return { recognized: false, reason: 'required-marker-missing', missingMarkers }
  }
  return { recognized: true, via: 'markers', ephemeral: input.ephemeral }
}

export type ConflictKind =
  | 'none'
  | 'protected-target'
  | 'kind-mismatch'
  | 'external-link'
  | 'dirty'
  | 'identical-content'
  | 'content-mismatch'

export type ConflictInput = {
  targetExists: boolean
  expectedKind: 'file' | 'directory'
  actualKind?: 'file' | 'directory' | 'link'
  linkedToExpected?: boolean
  pointsElsewhere?: boolean
  dirty?: boolean
  contentMatches?: boolean
  protected?: boolean
}

export type ConflictClassification = {
  kind: ConflictKind
  blocking: boolean
  mayWrite: boolean
  recommendedAction: 'create' | 'keep' | 'replace-identical' | 'stop'
}

export function classifyConflict(input: ConflictInput): ConflictClassification {
  if (input.protected) return { kind: 'protected-target', blocking: true, mayWrite: false, recommendedAction: 'stop' }
  if (!input.targetExists) return { kind: 'none', blocking: false, mayWrite: true, recommendedAction: 'create' }
  if (input.linkedToExpected) return { kind: 'none', blocking: false, mayWrite: false, recommendedAction: 'keep' }
  if (input.pointsElsewhere || input.actualKind === 'link') {
    return { kind: 'external-link', blocking: true, mayWrite: false, recommendedAction: 'stop' }
  }
  if (input.actualKind && input.actualKind !== input.expectedKind) {
    return { kind: 'kind-mismatch', blocking: true, mayWrite: false, recommendedAction: 'stop' }
  }
  if (input.dirty) return { kind: 'dirty', blocking: true, mayWrite: false, recommendedAction: 'stop' }
  if (input.contentMatches) {
    return { kind: 'identical-content', blocking: false, mayWrite: true, recommendedAction: 'replace-identical' }
  }
  return { kind: 'content-mismatch', blocking: true, mayWrite: false, recommendedAction: 'stop' }
}

export type ClaimEvaluation =
  | { decision: 'eligible' }
  | { decision: 'requires-resolution'; conflict: ConflictKind }
  | { decision: 'already-claimed' }
  | { decision: 'rejected'; reason: 'unrecognized' | 'blocked' }

export function evaluateClaim(input: {
  recognition: WorktreeRecognition
  blocked: boolean
  claimed: boolean
  conflict?: ConflictClassification
}): ClaimEvaluation {
  if (!input.recognition.recognized) return { decision: 'rejected', reason: 'unrecognized' }
  if (input.blocked) return { decision: 'rejected', reason: 'blocked' }
  if (input.conflict?.blocking) {
    return { decision: 'requires-resolution', conflict: input.conflict.kind }
  }
  if (input.claimed) return { decision: 'already-claimed' }
  return { decision: 'eligible' }
}

export type FirstAttachDecision =
  | {
      decision: 'session-required'
      allowSilentWrite: false
      conflict?: ConflictKind
    }
  | {
      decision: 'not-required'
      reason: 'already-claimed'
      allowSilentWrite: false
    }
  | {
      decision: 'rejected'
      reason: 'unrecognized' | 'blocked'
      allowSilentWrite: false
    }

export function decideFirstAttach(claim: ClaimEvaluation): FirstAttachDecision {
  if (claim.decision === 'eligible') return { decision: 'session-required', allowSilentWrite: false }
  if (claim.decision === 'requires-resolution') {
    return { decision: 'session-required', conflict: claim.conflict, allowSilentWrite: false }
  }
  if (claim.decision === 'already-claimed') {
    return { decision: 'not-required', reason: 'already-claimed', allowSilentWrite: false }
  }
  return {
    decision: 'rejected',
    reason: claim.reason,
    allowSilentWrite: false
  }
}

export type InboxTransitionAction = 'propose' | InboxDecisionAction

export type InboxTransition =
  | {
      accepted: true
      current: InboxStatus
      next: InboxStatus
      idempotent: boolean
      mergeTarget?: string
    }
  | {
      accepted: false
      current: InboxStatus
      action: InboxTransitionAction
      reason: 'terminal-state' | 'merge-target-required' | 'transition-not-allowed'
    }

const INBOX_TARGETS: Readonly<Record<InboxTransitionAction, InboxStatus>> = {
  propose: 'proposed',
  adopt: 'adopted',
  merge: 'merged-into-3skill',
  reject: 'rejected'
}

export function transitionInbox(
  current: InboxStatus,
  action: InboxTransitionAction,
  options: { mergeTarget?: string } = {}
): InboxTransition {
  const next = INBOX_TARGETS[action]
  if (current === next) {
    return { accepted: true, current, next, idempotent: true, mergeTarget: options.mergeTarget }
  }
  if (action === 'merge' && !options.mergeTarget?.trim()) {
    return { accepted: false, current, action, reason: 'merge-target-required' }
  }
  if (current === 'adopted' || current === 'merged-into-3skill' || current === 'rejected') {
    return { accepted: false, current, action, reason: 'terminal-state' }
  }
  if (action === 'propose' && current !== 'queued') {
    return { accepted: false, current, action, reason: 'transition-not-allowed' }
  }
  return {
    accepted: true,
    current,
    next,
    idempotent: false,
    mergeTarget: action === 'merge' ? options.mergeTarget?.trim() : undefined
  }
}

export const PIN_SCHEMA_VERSION = 1 as const

export type SkillPinCandidate = {
  name: string
  snapshot?: string
}

export type TreePinCandidate = {
  schemaVersion: number
  worktreeId: string
  librarySnapshot: string
  skills: readonly SkillPinCandidate[]
}

export type TreePin = {
  schemaVersion: typeof PIN_SCHEMA_VERSION
  worktreeId: string
  librarySnapshot: string
  skills: readonly {
    name: string
    snapshot?: string
  }[]
}

export type PinValidationErrorCode =
  | 'unsupported-schema-version'
  | 'worktree-id-required'
  | 'library-snapshot-required'
  | 'skills-required'
  | 'invalid-skill-name'
  | 'duplicate-skill'
  | 'forbidden-skill'
  | 'invalid-snapshot'
  | 'runtime-revision-forbidden'

export type PinValidation =
  | { valid: true; pin: TreePin }
  | {
      valid: false
      errors: readonly {
        code: PinValidationErrorCode
        field: string
        value?: string
      }[]
    }

const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function validRevision(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)
}

export function validatePin(
  candidate: TreePinCandidate,
  options: { forbiddenSkills?: readonly string[] } = {}
): PinValidation {
  const errors: Array<{ code: PinValidationErrorCode; field: string; value?: string }> = []
  const worktreeId = candidate.worktreeId.trim()
  const librarySnapshot = candidate.librarySnapshot.trim()
  if (candidate.schemaVersion !== PIN_SCHEMA_VERSION) {
    errors.push({ code: 'unsupported-schema-version', field: 'schemaVersion', value: String(candidate.schemaVersion) })
  }
  if (!worktreeId) errors.push({ code: 'worktree-id-required', field: 'worktreeId' })
  if (!librarySnapshot) errors.push({ code: 'library-snapshot-required', field: 'librarySnapshot' })
  else if (!validRevision(librarySnapshot)) {
    errors.push({ code: 'invalid-snapshot', field: 'librarySnapshot', value: librarySnapshot })
  }
  if (Object.hasOwn(candidate, 'runtimeRevision')) {
    errors.push({
      code: 'runtime-revision-forbidden',
      field: 'runtimeRevision',
      value: String((candidate as TreePinCandidate & { runtimeRevision?: unknown }).runtimeRevision ?? '')
    })
  }
  if (candidate.skills.length === 0) errors.push({ code: 'skills-required', field: 'skills' })

  const forbidden = new Set(['unity-skills', ...(options.forbiddenSkills || [])].map((name) => name.toLowerCase()))
  const seen = new Set<string>()
  const skills = candidate.skills.map((entry, index) => {
    const name = entry.name.trim()
    const snapshot = entry.snapshot?.trim()
    const folded = name.toLowerCase()
    if (!SKILL_NAME.test(name)) errors.push({ code: 'invalid-skill-name', field: `skills[${index}].name`, value: name })
    if (seen.has(folded)) errors.push({ code: 'duplicate-skill', field: `skills[${index}].name`, value: name })
    seen.add(folded)
    if (forbidden.has(folded)) errors.push({ code: 'forbidden-skill', field: `skills[${index}].name`, value: name })
    if (snapshot != null && !validRevision(snapshot)) {
      errors.push({ code: 'invalid-snapshot', field: `skills[${index}].snapshot`, value: snapshot })
    }
    return { name, snapshot }
  })

  if (errors.length > 0) return { valid: false, errors }
  return {
    valid: true,
    pin: {
      schemaVersion: PIN_SCHEMA_VERSION,
      worktreeId,
      librarySnapshot,
      skills
    }
  }
}
