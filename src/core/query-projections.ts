import type {
  HubStatusView,
  InboxItemView,
  LastIngestView,
  SessionView,
  SkillInventoryView,
  SkillKind,
  SkillView,
  WorktreeListView,
  WorktreeView
} from '../contracts/index.js'
import { isEphemeralPath, type CheckoutRules } from './worktree-facts.js'
import { recognizeWorktree, type WorktreeRecognitionInput } from './policies.js'

export type SkillHostFact = {
  source: SkillKind
  name: string
  path: string
  hasSkillMd: boolean
  attached: boolean
  ordinal: number
}

export type HubStatusFacts = {
  hubRoot: string
  gameRepo: string | null
  lastIngest: LastIngestView | null
  items: readonly InboxItemView[]
}

export type WorktreeRecognitionHostFact = Omit<
  WorktreeRecognitionInput,
  'excluded' | 'partialCheckout' | 'ephemeral'
> & {
  name: string
}

export type WorktreeProjectionFact = {
  identity: string
  ordinal: number
  name: string
  path: string
  branch: string
  head: string
  changedAtMs: number
  exists: boolean
  sameAsHub: boolean
  attached: boolean
  doNotAuto: boolean
  officialPresent: boolean
  overrideLinked: boolean
  locked: boolean
  prunable: boolean
}

export type WorktreeSeedFact = WorktreeProjectionFact & {
  recognition: WorktreeRecognitionHostFact
}

export type WorktreeCloneObservation = {
  cloneIdentity: string
  cloneRoot: string
  seed: WorktreeSeedFact
  listed: readonly WorktreeProjectionFact[]
}

export type WorktreeDiscoveryFacts = {
  scanRoots: readonly string[]
  rules: CheckoutRules
  observations: readonly WorktreeCloneObservation[]
}

export function projectSkillInventory(facts: readonly SkillHostFact[]): SkillInventoryView {
  const inventory: Record<SkillKind, SkillView[]> = {
    resident: [],
    adopted: [],
    inbox: []
  }
  for (const fact of [...facts].sort((left, right) => left.ordinal - right.ordinal)) {
    inventory[fact.source].push({
      name: fact.name,
      kind: fact.source,
      path: fact.path,
      hasSkillMd: fact.hasSkillMd,
      attached: fact.attached
    })
  }
  return inventory
}

export function projectHubStatus(input: {
  facts: HubStatusFacts
  skills: SkillInventoryView
  sessions: readonly SessionView[]
}): HubStatusView {
  const items = [...input.facts.items]
  return {
    hubRoot: input.facts.hubRoot,
    gameRepo: input.facts.gameRepo,
    lastIngest: input.facts.lastIngest,
    ...input.skills,
    items,
    sessions: [...input.sessions],
    counts: {
      resident: input.skills.resident.length,
      adopted: input.skills.adopted.length,
      queued: items.filter((item) => item.status === 'queued').length,
      proposed: items.filter((item) => item.status === 'proposed').length
    }
  }
}

function recognizedSeed(seed: WorktreeSeedFact, rules: CheckoutRules): boolean {
  const foldedName = seed.recognition.name.toLowerCase()
  return recognizeWorktree({
    ...seed.recognition,
    excluded: rules.exclude.some((item) => item.toLowerCase() === foldedName),
    partialCheckout: foldedName.includes('.partial-'),
    ephemeral: isEphemeralPath(seed.path)
  }).recognized
}

function worktreeView(fact: WorktreeProjectionFact, cloneRoot: string): WorktreeView {
  return {
    name: fact.name,
    path: fact.path,
    branch: fact.branch,
    head: fact.head,
    cloneRoot,
    changedAt: fact.changedAtMs ? new Date(fact.changedAtMs).toISOString() : '',
    changedAtMs: fact.changedAtMs,
    attached: fact.attached,
    doNotAuto: fact.doNotAuto,
    officialPresent: fact.officialPresent,
    overrideLinked: fact.overrideLinked,
    ephemeral: isEphemeralPath(fact.path),
    locked: fact.locked,
    prunable: fact.prunable
  }
}

export function projectWorktreeList(facts: WorktreeDiscoveryFacts): WorktreeListView {
  const active = facts.observations.filter((observation) => recognizedSeed(observation.seed, facts.rules))
  const seenClones = new Set<string>()
  const seenTrees = new Set<string>()
  const projected: Array<{ view: WorktreeView; ordinal: number }> = []
  const add = (fact: WorktreeProjectionFact, cloneRoot: string) => {
    if (!fact.exists || fact.sameAsHub || seenTrees.has(fact.identity)) return
    seenTrees.add(fact.identity)
    projected.push({ view: worktreeView(fact, cloneRoot), ordinal: projected.length })
  }

  for (const observation of active) {
    if (seenClones.has(observation.cloneIdentity)) continue
    seenClones.add(observation.cloneIdentity)
    if (observation.listed.length === 0) add(observation.seed, observation.cloneRoot)
    else for (const fact of observation.listed) add(fact, observation.cloneRoot)
  }
  for (const observation of active) add(observation.seed, observation.cloneRoot)

  projected.sort((left, right) =>
    right.view.changedAtMs - left.view.changedAtMs || left.ordinal - right.ordinal
  )
  return {
    scanRoots: [...facts.scanRoots],
    worktrees: projected.map((item) => item.view)
  }
}
