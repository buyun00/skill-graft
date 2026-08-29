import type {
  HubErrorCode,
  InboxDecisionAction,
  InboxItemView
} from '../contracts/index.js'
import { transitionInbox } from './policies.js'
import {
  cloneHubState,
  cloneInboxItem,
  safePathSegment,
  safeSegments,
  type ArtifactEffect,
  type ArtifactFact,
  type ArtifactInspectionRequest,
  type ArtifactRef,
  type HubStateDocument,
  type PlannedHistoryWrite
} from './use-case-plan-types.js'

export type DecisionInput = {
  id: string
  action: InboxDecisionAction
  note?: string
  mergeTarget?: string
}

export type WorktreeDecisionResult = {
  worktree: string
  status: string
}

export type WorktreeDecisionSkip = {
  worktree: string
  reason: string
}

export type DecisionDescription = {
  state: HubStateDocument
  input: DecisionInput
  item: InboxItemView
  nextStatus: InboxItemView['status']
  source?: ArtifactRef
  destination?: ArtifactRef
  mergeTarget?: ArtifactRef
  attachedWorktrees: readonly string[]
  inspectionRequests: readonly ArtifactInspectionRequest[]
}

export type DecisionNoop = {
  action: InboxDecisionAction
  item: InboxItemView
  linked: readonly WorktreeDecisionResult[]
  skipped: readonly WorktreeDecisionSkip[]
}

export type DecisionDescriptionDecision =
  | { decision: 'inspect'; description: DecisionDescription }
  | { decision: 'noop'; result: DecisionNoop }
  | { decision: 'rejected'; code: HubErrorCode; reason: string }

export type DecisionPlan = {
  action: InboxDecisionAction
  item: InboxItemView
  nextState: HubStateDocument
  effects: readonly ArtifactEffect[]
  history: PlannedHistoryWrite
  linked: readonly WorktreeDecisionResult[]
  skipped: readonly WorktreeDecisionSkip[]
}

export type DecisionPlanDecision =
  | { decision: 'apply'; plan: DecisionPlan }
  | { decision: 'rejected'; code: HubErrorCode; reason: string }

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function rejected(code: HubErrorCode, reason: string): { decision: 'rejected'; code: HubErrorCode; reason: string } {
  return { decision: 'rejected', code, reason }
}

function hubRef(value: string | undefined): ArtifactRef | null {
  if (!value) return null
  const segments = safeSegments(value)
  return segments ? { scope: 'hub', segments } : null
}

function treeRef(worktree: string, segments: readonly string[]): ArtifactRef {
  return { scope: 'worktree', worktree, segments }
}

/**
 * Purely validates the requested transition and describes the exact facts the
 * host must inspect. No host path resolution or I/O occurs here.
 */
export function describeDecision(input: {
  state: HubStateDocument
  command: DecisionInput
  attachedWorktrees: readonly string[]
}): DecisionDescriptionDecision {
  if (input.command.action !== 'adopt' && input.command.action !== 'merge' && input.command.action !== 'reject') {
    return rejected('INVALID_ARGUMENT', 'decision action is invalid')
  }
  const item = input.state.items.find((entry) => entry.id === input.command.id)
  if (!item) return rejected('NOT_FOUND', 'inbox item not found')

  const transition = transitionInbox(item.status, input.command.action, { mergeTarget: input.command.mergeTarget })
  if (!transition.accepted) {
    return rejected('INVALID_INBOX_TRANSITION', `inbox transition rejected: ${transition.reason}`)
  }
  if (transition.idempotent) {
    return {
      decision: 'noop',
      result: {
        action: input.command.action,
        item: cloneInboxItem(item),
        linked: [],
        skipped: []
      }
    }
  }

  const source = hubRef(item.inboxPath)
  if (item.inboxPath && !source) return rejected('INVALID_ARGUMENT', 'inbox path is unsafe')
  const inspectionRequests: ArtifactInspectionRequest[] = []
  if (source) inspectionRequests.push({ key: 'source', target: source, expectedKind: 'directory' })

  let destination: ArtifactRef | undefined
  let mergeTarget: ArtifactRef | undefined
  if (input.command.action === 'adopt') {
    if (!safePathSegment(item.name)) return rejected('INVALID_ARGUMENT', 'inbox item name is unsafe')
    if (!source) return rejected('NOT_FOUND', 'inbox source is missing')
    destination = { scope: 'hub', segments: ['skills', 'adopted', item.name] }
    inspectionRequests.push({ key: 'destination', target: destination, expectedKind: 'directory' })
    input.attachedWorktrees.forEach((worktree, index) => {
      inspectionRequests.push({
        key: `tree:${index}:root`,
        target: treeRef(worktree, []),
        expectedKind: 'directory'
      })
      inspectionRequests.push({
        key: `tree:${index}:link`,
        target: treeRef(worktree, ['.agents', 'skills', item.name]),
        expectedKind: 'directory',
        expectedSource: destination
      })
    })
  } else if (input.command.action === 'merge') {
    const resolvedMergeTarget = hubRef(transition.mergeTarget)
    if (!resolvedMergeTarget) return rejected('INVALID_ARGUMENT', 'merge target path is unsafe')
    mergeTarget = resolvedMergeTarget
    inspectionRequests.push({ key: 'merge-target', target: mergeTarget })
  }

  return {
    decision: 'inspect',
    description: {
      state: input.state,
      input: {
        ...input.command,
        mergeTarget: transition.mergeTarget
      },
      item: cloneInboxItem(item),
      nextStatus: transition.next,
      source: source || undefined,
      destination,
      mergeTarget,
      attachedWorktrees: [...input.attachedWorktrees],
      inspectionRequests
    }
  }
}

function factsByKey(facts: readonly ArtifactFact[]): Map<string, ArtifactFact> | null {
  const result = new Map<string, ArtifactFact>()
  for (const fact of facts) {
    if (result.has(fact.key)) return null
    result.set(fact.key, fact)
  }
  return result
}

function requiredFact(
  facts: ReadonlyMap<string, ArtifactFact>,
  key: string
): ArtifactFact | { missing: true } {
  return facts.get(key) || { missing: true }
}

function isMissing(value: ArtifactFact | { missing: true }): value is { missing: true } {
  return 'missing' in value
}

/**
 * Purely converts observed artifact facts into a state transition and generic,
 * approved effects. The effect adapter need not understand decision actions.
 */
export function planDecision(input: {
  description: DecisionDescription
  facts: readonly ArtifactFact[]
  now: string
  historyId: string
}): DecisionPlanDecision {
  if (!SAFE_ID.test(input.historyId)) return rejected('INVALID_ARGUMENT', 'invalid decision history id')
  const facts = factsByKey(input.facts)
  if (!facts) return rejected('PORT_FAILURE', 'duplicate artifact fact key')
  for (const request of input.description.inspectionRequests) {
    if (!facts.has(request.key)) return rejected('PORT_FAILURE', `artifact fact missing: ${request.key}`)
  }

  const effects: ArtifactEffect[] = []
  const linked: WorktreeDecisionResult[] = []
  const skipped: WorktreeDecisionSkip[] = []
  const { action } = input.description.input
  const sourceFact = requiredFact(facts, 'source')

  if (action === 'adopt') {
    const destinationFact = requiredFact(facts, 'destination')
    if (isMissing(sourceFact) || !sourceFact.exists) return rejected('NOT_FOUND', 'inbox source is missing')
    if (sourceFact.actualKind !== 'directory') return rejected('CONFLICT_CONTENT', 'inbox source has an unexpected kind')
    if (isMissing(destinationFact)) return rejected('PORT_FAILURE', 'artifact fact missing: destination')
    if (destinationFact.exists) return rejected('CONFLICT_CONTENT', 'adopted destination already exists')
    if (!input.description.source || !input.description.destination) {
      return rejected('PORT_FAILURE', 'adopt artifact references are missing')
    }
    effects.push({ kind: 'move', source: input.description.source, target: input.description.destination })

    input.description.attachedWorktrees.forEach((worktree, index) => {
      const root = requiredFact(facts, `tree:${index}:root`)
      const link = requiredFact(facts, `tree:${index}:link`)
      if (isMissing(root) || isMissing(link)) return
      if (!root.exists || root.actualKind !== 'directory') {
        skipped.push({ worktree, reason: 'missing' })
      } else if (link.linkedToExpected) {
        linked.push({ worktree, status: 'ok' })
      } else if (link.exists) {
        skipped.push({ worktree, reason: 'already points elsewhere' })
      } else {
        effects.push({
          kind: 'link',
          source: input.description.destination as ArtifactRef,
          target: treeRef(worktree, ['.agents', 'skills', input.description.item.name]),
          artifactKind: 'directory'
        })
        linked.push({ worktree, status: 'linked' })
      }
    })
  } else if (action === 'merge') {
    const targetFact = requiredFact(facts, 'merge-target')
    if (isMissing(targetFact)) return rejected('PORT_FAILURE', 'artifact fact missing: merge-target')
    if (!targetFact.exists) return rejected('NOT_FOUND', 'merge target is missing')
    if (input.description.source && !isMissing(sourceFact) && sourceFact.exists) {
      effects.push({ kind: 'remove', target: input.description.source })
    }
  } else if (input.description.source && !isMissing(sourceFact) && sourceFact.exists) {
    effects.push({ kind: 'remove', target: input.description.source })
  }

  const nextState = cloneHubState(input.description.state)
  const itemIndex = nextState.items.findIndex((item) => item.id === input.description.item.id)
  if (itemIndex < 0) return rejected('PORT_FAILURE', 'inbox item disappeared from decision state')
  const updated: InboxItemView = {
    ...nextState.items[itemIndex],
    status: input.description.nextStatus,
    note: input.description.input.note,
    updatedAt: input.now
  }
  if (action === 'adopt') updated.adoptedPath = `skills/adopted/${input.description.item.name}`
  if (action === 'merge') updated.mergeTarget = input.description.input.mergeTarget
  const nextItems = [...nextState.items]
  nextItems[itemIndex] = updated
  nextState.items = nextItems

  const historyRecord: Record<string, string> = {
    type: 'decide',
    id: input.description.input.id,
    action
  }
  if (input.description.input.note !== undefined) historyRecord.note = input.description.input.note
  if (input.description.input.mergeTarget !== undefined) historyRecord.mergeTarget = input.description.input.mergeTarget

  return {
    decision: 'apply',
    plan: {
      action,
      item: updated,
      nextState,
      effects,
      history: { id: input.historyId, record: historyRecord },
      linked,
      skipped
    }
  }
}
