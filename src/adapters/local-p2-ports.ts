import type {
  HubQueryPort,
  LibrarySnapshotRepositoryPort,
  P2ApplicationPorts,
  WorktreeIdentity
} from '../application/ports.js'
import { isPortableOpaqueIdentifier, type HubStateV2, type Sha256Identifier } from '../contracts/index.js'
import { compareUtf8Bytes } from '../core/canonical.js'
import { projectWorktreeList } from '../core/query-projections.js'
import type { LocalHostContext } from './host-context.js'
import type { TransactionAwarePersistPort } from './durable-state.js'
import { adoptedSkillNames, residentSkillNames } from './local-skill-corpus.js'
import { canonicalLocalWorktreePath } from './local-worktree-path.js'
import { worktreeTargetId } from './worktree-target.js'

const FULL_SHA256 = /^[a-f0-9]{64}$/

export type LocalP2ApplicationPortOptions = {
  runtimeRevision: string
  queries: HubQueryPort
  snapshots: LibrarySnapshotRepositoryPort
  persist: Pick<TransactionAwarePersistPort, 'readOptionalJson'>
}

function fullIdentifier(context: LocalHostContext, value: string): Sha256Identifier {
  const raw = context.hash.sha256(value).toLowerCase()
  const hex = raw.startsWith('sha256:') ? raw.slice('sha256:'.length) : raw
  if (!FULL_SHA256.test(hex)) throw new Error('host SHA-256 primitive returned an invalid digest')
  return `sha256:${hex}`
}

function identityFor(context: LocalHostContext, worktree: string): WorktreeIdentity {
  const canonical = canonicalLocalWorktreePath(context, worktree)
  if (!canonical) {
    throw new Error('worktree identity could not be resolved safely')
  }
  const comparisonKey = context.path.comparisonKey(canonical)
  return {
    pathKey: fullIdentifier(context, comparisonKey),
    worktreeId: worktreeTargetId(context, canonical)
  }
}

function selectedLegacySkills(context: LocalHostContext, worktree: string): string[] {
  const sources = [
    ...residentSkillNames(context).map((name) => ({
      name,
      source: context.path.join(context.hubRoot, 'skills', name)
    })),
    ...adoptedSkillNames(context).map((name) => ({
      name,
      source: context.path.join(context.hubRoot, 'skills', 'adopted', name)
    }))
  ]
  return sources.filter(({ name, source }) => {
    const target = context.path.join(worktree, '.agents', 'skills', name)
    return context.link.isLinked(target, source)
  }).map(({ name }) => name).sort(compareUtf8Bytes)
}

/**
 * Explicit content allowlist for one library snapshot. Inbox/runtime state and
 * repository objects are deliberately excluded.
 */
export function localLibraryCaptureRoots(context: LocalHostContext): readonly string[] {
  const roots: string[] = []
  const override = context.path.join(context.hubRoot, 'AGENTS.override.md')
  if (context.fs.isFile(override)) roots.push('AGENTS.override.md')
  for (const name of residentSkillNames(context)) roots.push(`skills/${name}`)
  for (const name of adoptedSkillNames(context)) roots.push(`skills/adopted/${name}`)
  return roots.sort(compareUtf8Bytes)
}

export function createLocalP2ApplicationPorts(
  context: LocalHostContext,
  options: LocalP2ApplicationPortOptions
): P2ApplicationPorts {
  const runtimeRevision = options.runtimeRevision.trim()
  if (!isPortableOpaqueIdentifier(runtimeRevision)) {
    throw new Error('runtime revision is unavailable or invalid')
  }
  const stateFile = context.path.join(context.hubRoot, 'skill-review', 'state.json')
  const attachedFile = context.path.join(context.hubRoot, 'overlay', 'attached-worktrees.txt')

  return {
    identities: {
      resolve: (worktree) => identityFor(context, worktree)
    },
    snapshots: options.snapshots,
    state: {
      readDocument: () => options.persist.readOptionalJson<unknown>(stateFile),
      writeV2: (state: HubStateV2) => context.persist.writeJson(stateFile, state),
      runtimeRevision: () => runtimeRevision,
      async observeV1Worktrees() {
        const projected = projectWorktreeList(await options.queries.readWorktreeFacts())
        const attached = context.persist.readList(attachedFile)
        const candidates: string[] = []
        const add = (candidate: string) => {
          const resolved = context.path.resolve(candidate)
          if (!candidates.some((current) => context.link.samePath(current, resolved))) candidates.push(resolved)
        }
        for (const view of projected.worktrees) add(view.path)
        for (const claimed of attached) add(claimed)

        return candidates.map((worktree) => {
          const selectedSkills = selectedLegacySkills(context, worktree)
          const overrideLinked = context.link.isLinked(
            context.path.join(worktree, 'AGENTS.override.md'),
            context.path.join(context.hubRoot, 'AGENTS.override.md')
          )
          const localOverlayLinked = context.link.isLinked(
            context.path.join(worktree, '.codex', 'local-overlay'),
            context.path.join(context.hubRoot, 'overlay')
          )
          return {
            ...identityFor(context, worktree),
            linked: overrideLinked || localOverlayLinked || selectedSkills.length > 0,
            claimed: attached.some((candidate) => context.link.samePath(candidate, worktree)),
            selectedSkills
          }
        }).sort((left, right) => compareUtf8Bytes(left.pathKey, right.pathKey))
      }
    }
  }
}
