import type { HubErrorCode, InboxItemView, LastIngestView } from '../contracts/index.js'
import {
  cloneHubState,
  safePathSegment,
  safeSegments,
  type ArtifactEffect,
  type HubStateDocument,
  type PlannedHistoryWrite
} from './use-case-plan-types.js'

export const INGEST_WATCHED_PATHS = [
  '.agents/skills',
  '.codex/skills',
  '.claude/skills',
  'AGENTS.md',
  'CLAUDE.md'
] as const

export type GitChangeFact = {
  status: string
  path: string
  previousPath?: string
}

export type IngestTransactionFact = {
  old: string
  next: string
  ref: string
  oldExists: boolean
  nextExists: boolean
  changes: readonly GitChangeFact[]
}

export type ParsedIngestTransaction = Pick<IngestTransactionFact, 'old' | 'next' | 'ref'>

export function parseIngestTransactions(text: string): ParsedIngestTransaction[] {
  const rows: ParsedIngestTransaction[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split(/\s+/)
    if (parts.length < 3) continue
    rows.push({ old: parts[0], next: parts[1], ref: parts.slice(2).join(' ') })
  }
  return rows
}

export type IngestUnitSeed = {
  key: string
  name: string
  prefix: string
  isSkill: boolean
  ref: string
  old: string
  next: string
  idMaterial: string
}

export type IngestDiscovery = {
  candidates: readonly IngestUnitSeed[]
  lastIngest: LastIngestView | null
}

export type IngestSnapshotFile = {
  path: string
  content: string
}

export type IngestCandidateSnapshot = {
  id: string
  candidate: IngestUnitSeed
  /** Omitted when the derived id already exists and no Git tree read is needed. */
  files?: readonly IngestSnapshotFile[]
}

export type IngestPlan = {
  gameRepo: string
  nextState: HubStateDocument
  effects: readonly ArtifactEffect[]
  history?: PlannedHistoryWrite
  createdItems: readonly InboxItemView[]
  lastIngest: LastIngestView | null
}

export type IngestPlanDecision =
  | { decision: 'apply'; plan: IngestPlan }
  | { decision: 'rejected'; code: Extract<HubErrorCode, 'INVALID_ARGUMENT' | 'PORT_FAILURE'>; reason: string }

const ZERO_OID = /^0{40,64}$/
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function normalizedPath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '')
}

function watchedUnit(pathText: string): Pick<IngestUnitSeed, 'key' | 'name' | 'prefix' | 'isSkill'> | null {
  const normalized = normalizedPath(pathText)
  const skill = normalized.match(/^\.(agents|codex|claude)\/skills\/([^/]+)(?:\/|$)/)
  if (skill) {
    const prefix = `.${skill[1]}/skills/${skill[2]}`
    return { key: prefix, name: skill[2], prefix, isSkill: true }
  }
  if (normalized === 'AGENTS.md' || normalized === 'CLAUDE.md') {
    return { key: normalized, name: normalized, prefix: normalized, isSkill: false }
  }
  return null
}

/**
 * Purely derives ingest units from host-observed revision and diff facts.
 * The host owns Git access; Core owns remote-ref, zero-OID, watched-path, and
 * transaction ordering policy.
 */
export function discoverIngestCandidates(input: {
  gameRepo: string
  transactions: readonly IngestTransactionFact[]
}): IngestDiscovery {
  const candidates: IngestUnitSeed[] = []
  let lastIngest: LastIngestView | null = null

  for (const transaction of input.transactions) {
    if (!transaction.ref.toLowerCase().startsWith('refs/remotes/')) continue
    if (ZERO_OID.test(transaction.old) || ZERO_OID.test(transaction.next)) continue
    if (!transaction.oldExists || !transaction.nextExists) continue

    const seen = new Set<string>()
    for (const change of transaction.changes) {
      const unit = watchedUnit(change.path)
      if (!unit || seen.has(unit.key)) continue
      seen.add(unit.key)
      candidates.push({
        ...unit,
        ref: transaction.ref,
        old: transaction.old,
        next: transaction.next,
        idMaterial: `${transaction.ref}|${transaction.next}|${unit.key}`
      })
    }

    lastIngest = {
      ref: transaction.ref,
      old: transaction.old,
      new: transaction.next,
      gameRepo: input.gameRepo
    }
  }

  return { candidates, lastIngest }
}

function rejected(code: 'INVALID_ARGUMENT' | 'PORT_FAILURE', reason: string): IngestPlanDecision {
  return { decision: 'rejected', code, reason }
}

function snapshotMatches(left: IngestUnitSeed, right: IngestUnitSeed): boolean {
  return left.idMaterial === right.idMaterial &&
    left.key === right.key &&
    left.name === right.name &&
    left.prefix === right.prefix &&
    left.isSkill === right.isSkill &&
    left.ref === right.ref &&
    left.old === right.old &&
    left.next === right.next
}

/**
 * Purely turns discovered candidates plus host-read snapshots into an approved
 * state transition and generic artifact effects.
 */
export function planIngest(input: {
  state: HubStateDocument
  gameRepo: string
  discovery: IngestDiscovery
  snapshots: readonly IngestCandidateSnapshot[]
  now: string
  historyId: string
}): IngestPlanDecision {
  const nextState = cloneHubState(input.state)
  const items = [...nextState.items]
  const knownIds = new Set(items.map((item) => item.id))
  const snapshotByMaterial = new Map(input.snapshots.map((snapshot) => [snapshot.candidate.idMaterial, snapshot]))
  const createdItems: InboxItemView[] = []
  const effects: ArtifactEffect[] = []

  for (const candidate of input.discovery.candidates) {
    if (!safePathSegment(candidate.name) || !safeSegments(candidate.prefix)) {
      return rejected('INVALID_ARGUMENT', `unsafe ingest unit: ${candidate.key}`)
    }

    const snapshot = snapshotByMaterial.get(candidate.idMaterial)
    if (!snapshot) return rejected('PORT_FAILURE', `snapshot missing for ingest unit: ${candidate.key}`)
    if (!snapshotMatches(candidate, snapshot.candidate)) {
      return rejected('PORT_FAILURE', `snapshot does not match ingest unit: ${candidate.key}`)
    }
    if (!snapshot.id.trim() || !SAFE_ID.test(snapshot.id)) {
      return rejected('INVALID_ARGUMENT', `invalid ingest item id for unit: ${candidate.key}`)
    }
    if (knownIds.has(snapshot.id)) continue
    if (!snapshot.files || !candidate.isSkill && snapshot.files.length === 0) {
      return rejected('PORT_FAILURE', `snapshot has no files for ingest unit: ${candidate.key}`)
    }

    if (!candidate.isSkill &&
      (snapshot.files.length !== 1 || normalizedPath(snapshot.files[0].path) !== candidate.name)) {
      return rejected('PORT_FAILURE', `file snapshot does not match ingest unit: ${candidate.key}`)
    }

    const plannedFiles: Array<{ segments: readonly string[]; content: string }> = []
    const seenFiles = new Set<string>()
    for (const file of snapshot.files) {
      const segments = safeSegments(file.path)
      if (!segments) return rejected('INVALID_ARGUMENT', `unsafe snapshot path: ${file.path}`)
      const key = segments.join('/')
      if (seenFiles.has(key)) return rejected('INVALID_ARGUMENT', `duplicate snapshot path: ${key}`)
      seenFiles.add(key)
      plannedFiles.push({ segments, content: file.content })
    }

    const inboxPath = `skills/inbox/${candidate.name}`
    const item: InboxItemView = {
      id: snapshot.id,
      name: candidate.name,
      unit: candidate.key,
      status: 'queued',
      sourceRef: candidate.ref,
      oldCommit: candidate.old,
      newCommit: candidate.next,
      inboxPath,
      createdAt: input.now,
      updatedAt: input.now,
      suggestion: { action: '', target: '', reason: '', confidence: '' }
    }
    items.push(item)
    knownIds.add(item.id)
    createdItems.push(item)
    effects.push({
      kind: 'replace-tree',
      target: { scope: 'hub', segments: ['skills', 'inbox', candidate.name] },
      files: plannedFiles
    })
  }

  nextState.items = items
  nextState.lastIngest = input.discovery.lastIngest ? { ...input.discovery.lastIngest } : nextState.lastIngest

  let history: PlannedHistoryWrite | undefined
  if (createdItems.length > 0) {
    if (!SAFE_ID.test(input.historyId)) return rejected('INVALID_ARGUMENT', 'invalid ingest history id')
    history = {
      id: input.historyId,
      record: {
        type: 'ingest',
        count: createdItems.length,
        lastIngest: nextState.lastIngest
      }
    }
  }

  return {
    decision: 'apply',
    plan: {
      gameRepo: input.gameRepo,
      nextState,
      effects,
      history,
      createdItems,
      lastIngest: nextState.lastIngest
    }
  }
}
