import type {
  InboxItemView,
  JsonObject,
  LastIngestView
} from '../contracts/index.js'

export type HubStateDocument = {
  version?: number
  items: readonly InboxItemView[]
  lastIngest: LastIngestView | null
}

export type PlannedHistoryWrite = {
  id: string
  record: JsonObject
}

export type ArtifactRef =
  | { scope: 'hub'; segments: readonly string[] }
  | { scope: 'worktree'; worktree: string; segments: readonly string[] }

export type ArtifactInspectionRequest = {
  key: string
  target: ArtifactRef
  expectedKind?: 'file' | 'directory'
  expectedSource?: ArtifactRef
}

export type ArtifactFact = {
  key: string
  exists: boolean
  actualKind?: 'file' | 'directory' | 'link'
  linkedToExpected?: boolean
  pointsElsewhere?: boolean
  contentMatches?: boolean
  observedDigest?: string
  expectedDigest?: string
}

export type ArtifactEffect =
  | { kind: 'remove'; target: ArtifactRef }
  | { kind: 'move'; source: ArtifactRef; target: ArtifactRef }
  | {
      kind: 'link'
      source: ArtifactRef
      target: ArtifactRef
      artifactKind: 'file' | 'directory'
    }
  | { kind: 'unlink'; target: ArtifactRef }
  | {
      kind: 'replace-tree'
      target: ArtifactRef
      files: readonly {
        segments: readonly string[]
        content: string
      }[]
    }

export function cloneInboxItem(item: InboxItemView): InboxItemView {
  const { suggestion, ...rest } = item
  return suggestion ? { ...rest, suggestion: { ...suggestion } } : rest
}

export function cloneHubState(state: HubStateDocument): HubStateDocument {
  return {
    version: state.version,
    items: state.items.map(cloneInboxItem),
    lastIngest: state.lastIngest ? { ...state.lastIngest } : null
  }
}

export function safeSegments(value: string): readonly string[] | null {
  const trimmed = value.trim()
  if (!trimmed || /^[\\/]/.test(trimmed) || /^[A-Za-z]:/.test(trimmed)) return null
  const normalized = trimmed.replaceAll('\\', '/').replace(/^\.\//, '')
  const segments = normalized.split('/').filter(Boolean)
  if (segments.length === 0 || segments.some((segment) => !safePathSegment(segment))) {
    return null
  }
  return segments
}

export function safePathSegment(value: string): boolean {
  return value.length > 0
    && value.length <= 255
    && value === value.trim()
    && value !== '.'
    && value !== '..'
    && !/[\\/:*?"<>|\u0000-\u001f\u007f]/.test(value)
    && !/^[A-Za-z]:/.test(value)
}
