import type {
  GitChangeFact,
  IngestSnapshotFile
} from '../core/ingest-plan.js'
import type {
  ArtifactEffect,
  ArtifactFact,
  ArtifactInspectionRequest,
  HubStateDocument,
  PlannedHistoryWrite
} from '../core/use-case-plan-types.js'

export type UseCaseMaybePromise<T> = T | Promise<T>

/** Low-level durable state and configuration facts used by shared use cases. */
export interface HubStateRepositoryPort {
  readState(): UseCaseMaybePromise<HubStateDocument>
  writeState(state: HubStateDocument): UseCaseMaybePromise<void>
  appendHistory(write: PlannedHistoryWrite): UseCaseMaybePromise<void>
  configuredGameRepo(): UseCaseMaybePromise<string | null>
  listAttachedWorktrees(): UseCaseMaybePromise<readonly string[]>
}

/** Host Git observations. Watched-path and ingest-unit policy remain in Core. */
export interface GitFactsPort {
  revisionExists(repo: string, revision: string): UseCaseMaybePromise<boolean>
  changedPaths(input: {
    repo: string
    oldRevision: string
    newRevision: string
    pathspecs: readonly string[]
  }): UseCaseMaybePromise<readonly GitChangeFact[]>
  readTree(input: {
    repo: string
    revision: string
    prefix: string
  }): UseCaseMaybePromise<readonly IngestSnapshotFile[]>
  readBlob(input: {
    repo: string
    revision: string
    path: string
  }): UseCaseMaybePromise<string | null>
}

/** Generic artifact observations and execution of effects already approved by Core. */
export interface ArtifactFactsEffectPort {
  inspect(requests: readonly ArtifactInspectionRequest[]): UseCaseMaybePromise<readonly ArtifactFact[]>
  apply(effects: readonly ArtifactEffect[]): UseCaseMaybePromise<void>
}

export type SharedUseCasePorts = {
  state: HubStateRepositoryPort
  git: GitFactsPort
  artifacts: ArtifactFactsEffectPort
}
