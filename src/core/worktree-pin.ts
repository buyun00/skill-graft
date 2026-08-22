import {
  WORKTREE_PIN_SCHEMA_VERSION,
  type Sha256Identifier,
  type WorktreePinV1,
  validateWorktreePinV1
} from '../contracts/index.js'
import { compareUtf8Bytes } from './canonical.js'

export type WorktreePinAction =
  | {
      kind: 'claim'
      requestedSnapshot: Sha256Identifier
      selectedSkills: readonly string[]
    }
  | {
      kind: 'setRequested'
      requestedSnapshot: Sha256Identifier
      selectedSkills: readonly string[]
    }
  | {
      kind: 'recordMaterialized'
      snapshotId: Sha256Identifier
    }
  | { kind: 'detach' }

export type WorktreePinTransitionErrorCode =
  | 'PIN_INVALID'
  | 'PIN_TRANSITION_NOT_ALLOWED'
  | 'PIN_MATERIALIZED_NOT_REQUESTED'

export type WorktreePinTransitionResult =
  | { ok: true; pin: WorktreePinV1; idempotent: boolean }
  | {
      ok: false
      error: {
        code: WorktreePinTransitionErrorCode
        message: string
      }
    }

function sameSkills(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index])
}

function canonicalSkills(skills: readonly string[]): readonly string[] | null {
  const normalized = skills.map((skill) => skill.trim()).sort(compareUtf8Bytes)
  const seen = new Set<string>()
  for (const skill of normalized) {
    const folded = skill.toLocaleLowerCase('en-US')
    if (seen.has(folded)) return null
    seen.add(folded)
  }
  return normalized
}

function accepted(current: WorktreePinV1, pin: WorktreePinV1): WorktreePinTransitionResult {
  const validation = validateWorktreePinV1(pin)
  if (!validation.valid) {
    return {
      ok: false,
      error: { code: 'PIN_INVALID', message: 'pin transition would violate WorktreePinV1' }
    }
  }
  return {
    ok: true,
    pin: validation.value,
    idempotent: JSON.stringify(current) === JSON.stringify(validation.value)
  }
}

export function transitionWorktreePin(
  current: WorktreePinV1,
  action: WorktreePinAction
): WorktreePinTransitionResult {
  const currentValidation = validateWorktreePinV1(current)
  if (!currentValidation.valid) {
    return { ok: false, error: { code: 'PIN_INVALID', message: 'current pin does not satisfy WorktreePinV1' } }
  }
  const pin = currentValidation.value
  if (action == null || typeof action !== 'object'
    || action.kind !== 'claim'
      && action.kind !== 'setRequested'
      && action.kind !== 'recordMaterialized'
      && action.kind !== 'detach') {
    return {
      ok: false,
      error: { code: 'PIN_TRANSITION_NOT_ALLOWED', message: 'unknown worktree pin transition' }
    }
  }
  if (action.kind === 'detach') {
    return accepted(pin, {
      schemaVersion: WORKTREE_PIN_SCHEMA_VERSION,
      pathKey: pin.pathKey,
      worktreeId: pin.worktreeId,
      requestedSnapshot: null,
      materializedSnapshot: null,
      selectedSkills: [],
      claimState: 'detached'
    })
  }
  if (action.kind === 'recordMaterialized') {
    if (pin.claimState !== 'claimed') {
      return {
        ok: false,
        error: { code: 'PIN_TRANSITION_NOT_ALLOWED', message: 'only a claimed pin can record materialization' }
      }
    }
    if (action.snapshotId !== pin.requestedSnapshot) {
      return {
        ok: false,
        error: {
          code: 'PIN_MATERIALIZED_NOT_REQUESTED',
          message: 'materialized snapshot must match the currently requested snapshot'
        }
      }
    }
    return accepted(pin, { ...pin, materializedSnapshot: action.snapshotId })
  }

  if (!Array.isArray(action.selectedSkills)
    || action.selectedSkills.some((skill) => typeof skill !== 'string')) {
    return {
      ok: false,
      error: { code: 'PIN_INVALID', message: 'selected skills must be a string array' }
    }
  }
  const selectedSkills = canonicalSkills(action.selectedSkills)
  if (selectedSkills == null) {
    return {
      ok: false,
      error: { code: 'PIN_INVALID', message: 'selected skills collide under portable case comparison' }
    }
  }
  if (action.kind === 'claim') {
    const next: WorktreePinV1 = {
      ...pin,
      requestedSnapshot: action.requestedSnapshot,
      materializedSnapshot: pin.claimState === 'claimed' ? pin.materializedSnapshot : null,
      selectedSkills,
      claimState: 'claimed'
    }
    if (pin.claimState === 'claimed'
      && pin.requestedSnapshot === action.requestedSnapshot
      && sameSkills(pin.selectedSkills, selectedSkills)) {
      return { ok: true, pin, idempotent: true }
    }
    return accepted(pin, next)
  }
  if (pin.claimState !== 'claimed') {
    return {
      ok: false,
      error: { code: 'PIN_TRANSITION_NOT_ALLOWED', message: 'only a claimed pin can change its requested snapshot' }
    }
  }
  return accepted(pin, {
    ...pin,
    requestedSnapshot: action.requestedSnapshot,
    selectedSkills
  })
}
