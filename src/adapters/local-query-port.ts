import type {
  HubQueryPort,
  SkillReadPortResult,
  WorktreeInspection
} from '../application/ports.js'
import {
  validateHubStateV2,
  type HistoryRecordView,
  type SkillKind,
  type WorktreePinV1
} from '../contracts/index.js'
import type {
  HubStatusFacts,
  SkillHostFact,
  WorktreeCloneObservation,
  WorktreeDiscoveryFacts,
  WorktreeProjectionFact,
  WorktreeSeedFact
} from '../core/query-projections.js'
import {
  isEphemeralPath,
  parseCheckoutRules,
  parseWorktreePorcelain,
  type CheckoutRules,
  type GitWorktreeFact
} from '../core/worktree-facts.js'
import type { LocalHostContext } from './host-context.js'
import { adoptedSkillNames, residentSkillNames } from './local-skill-corpus.js'
import { canonicalLocalWorktreePath } from './local-worktree-path.js'
import { worktreeTargetId } from './worktree-target.js'
import { readRegisteredWorktrees } from './local-worktree-registry.js'

function resolveSkillTarget(context: LocalHostContext, requested: string): SkillReadPortResult {
  const root = context.path.resolve(context.hubRoot)
  let target = context.path.resolve(root, requested)
  if (!context.path.isSameOrInside(root, target)) {
    return { status: 'invalid-path', reason: 'escaped' }
  }

  if (!context.fs.exists(target)) return { status: 'not-found', reason: 'missing' }
  if (context.fs.isDirectory(target)) {
    const skillMd = context.path.join(target, 'SKILL.md')
    if (!context.fs.exists(skillMd)) return { status: 'not-found', reason: 'skill-md-missing' }
    target = skillMd
  }

  const realRoot = context.fs.realpath(root)
  const realTarget = context.fs.realpath(target)
  if (!realRoot || !realTarget || !context.path.isSameOrInside(realRoot, realTarget)) {
    return { status: 'invalid-path', reason: 'escaped-link' }
  }

  const content = context.fs.readText(target)
  return content === null
    ? { status: 'not-found', reason: 'missing' }
    : { status: 'found', content }
}

function gameRepoOf(context: LocalHostContext): string | null {
  return context.git.configGet(context.hubRoot, 'ozdqp.gameRepo')
}

function skillGroupFacts(
  context: LocalHostContext,
  relative: string,
  source: SkillKind,
  startOrdinal: number,
  gameRepo: string | null,
  materializedSkills: ReadonlySet<string>
): SkillHostFact[] {
  const absolute = context.path.join(context.hubRoot, ...relative.split('/'))
  if (!context.fs.exists(absolute) || !context.fs.isDirectory(absolute)) return []
  return context.fs.readDir(absolute)
    .filter((entry) => entry.isDirectory)
    .map((entry, index) => ({
      source,
      name: entry.name,
      path: `${relative.replaceAll('\\', '/')}/${entry.name}`,
      hasSkillMd: context.fs.exists(context.path.join(absolute, entry.name, 'SKILL.md')),
      attached: source === 'adopted' && (
        materializedSkills.has(entry.name)
        || Boolean(gameRepo && context.link.isLinked(
          context.path.join(gameRepo, '.agents', 'skills', entry.name),
          context.path.join(context.hubRoot, 'skills', 'adopted', entry.name)
        ))
      ),
      ordinal: startOrdinal + index
    }))
}

function listSkillFacts(context: LocalHostContext): SkillHostFact[] {
  const gameRepo = gameRepoOf(context)
  const materializedSkills = materializedSkillNames(context)
  const resident: SkillHostFact[] = residentSkillNames(context).map((name, ordinal) => ({
    source: 'resident',
    name,
    path: `skills/${name}`,
    hasSkillMd: true,
    attached: materializedSkills.has(name) || Boolean(gameRepo && context.link.isLinked(
      context.path.join(gameRepo, '.agents', 'skills', name),
      context.path.join(context.hubRoot, 'skills', name)
    )),
    ordinal
  }))
  const adoptedNames = new Set(adoptedSkillNames(context))
  const adopted = skillGroupFacts(
    context,
    'skills/adopted',
    'adopted',
    resident.length,
    gameRepo,
    materializedSkills
  ).filter((skill) => adoptedNames.has(skill.name))
  const inbox = skillGroupFacts(
    context,
    'skills/inbox',
    'inbox',
    resident.length + adopted.length,
    gameRepo,
    materializedSkills
  )
  return [...resident, ...adopted, ...inbox]
}

function historyRecords(context: LocalHostContext, limit: number): HistoryRecordView[] {
  const dir = context.path.join(context.hubRoot, 'skill-review', 'history')
  const records: HistoryRecordView[] = []
  if (!context.fs.exists(dir) || !context.fs.isDirectory(dir)) return records
  const files = context.fs.readDir(dir)
    .map((entry) => entry.name)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .reverse()
  for (const name of files) {
    if (records.length >= limit) break
    records.push(context.persist.readJson<Record<string, unknown>>(
      context.path.join(dir, name),
      {}
    ) as HistoryRecordView)
  }
  return records
}

function configuredCheckoutRules(context: LocalHostContext): CheckoutRules {
  return parseCheckoutRules(context.fs.readText(context.path.join(context.hubRoot, 'overlay', 'checkout-rules.txt')))
}

function effectiveCheckoutRules(context: LocalHostContext): CheckoutRules {
  const base = configuredCheckoutRules(context)
  return {
    ...base,
    paths: [...base.paths, ...readRegisteredWorktrees(context)]
  }
}

function v2WorktreePins(context: LocalHostContext): readonly WorktreePinV1[] {
  const stateFile = context.path.join(context.hubRoot, 'skill-review', 'state.json')
  const raw = context.persist.readJson<unknown | null>(stateFile, null)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || (raw as { schemaVersion?: unknown }).schemaVersion !== 2) return []
  const validation = validateHubStateV2(raw)
  if (!validation.valid) throw new Error('HubStateV2 failed shared validation')
  return Object.values(validation.value.worktrees)
}

function claimedWorktreeIds(context: LocalHostContext): ReadonlySet<string> {
  return new Set(v2WorktreePins(context)
    .filter((pin) => pin.claimState === 'claimed')
    .map((pin) => pin.worktreeId))
}

function materializedWorktreeIds(context: LocalHostContext): ReadonlySet<string> {
  return new Set(v2WorktreePins(context)
    .filter((pin) => pin.claimState === 'claimed' && pin.materializedSnapshot !== null)
    .map((pin) => pin.worktreeId))
}

function materializedSkillNames(context: LocalHostContext): ReadonlySet<string> {
  return new Set(v2WorktreePins(context)
    .filter((pin) => pin.claimState === 'claimed' && pin.materializedSnapshot !== null)
    .flatMap((pin) => pin.selectedSkills))
}

function cloneRootFromCommonDir(context: LocalHostContext, commonDir: string): string {
  const resolved = context.path.resolve(commonDir)
  const base = context.path.basename(resolved)
  const parent = context.path.dirname(resolved)
  if (base === '.git') return parent
  if (context.path.basename(parent) === 'worktrees' && context.path.basename(context.path.dirname(parent)) === '.git') {
    return context.path.dirname(context.path.dirname(parent))
  }
  return parent
}

function latestLocalChangeMs(context: LocalHostContext, dir: string): number {
  const times = [
    context.fs.statMtimeMs(dir),
    context.fs.statMtimeMs(context.path.join(dir, '.git')),
    context.fs.statMtimeMs(context.path.join(dir, 'AGENTS.override.md'))
  ]
  const gitDir = context.git.output(dir, ['rev-parse', '--absolute-git-dir']).trim()
  if (gitDir) {
    times.push(
      context.fs.statMtimeMs(gitDir),
      context.fs.statMtimeMs(context.path.join(gitDir, 'HEAD')),
      context.fs.statMtimeMs(context.path.join(gitDir, 'index'))
    )
  }
  return Math.max(0, ...times)
}

function discoveryCandidates(
  context: LocalHostContext,
  scanRoots: readonly string[],
  rules: CheckoutRules,
  registeredWorktrees: readonly string[]
): Array<{ path: string; exact: boolean }> {
  const candidates: Array<{ path: string; exact: boolean }> = []
  for (const root of scanRoots) {
    if (!root || !context.fs.exists(root)) continue
    try {
      for (const entry of context.fs.readDir(root)) {
        if (!entry.isDirectory && !entry.isSymbolicLink) continue
        candidates.push({ path: context.path.join(root, entry.name), exact: false })
      }
    } catch {
      /* unreadable scan roots contribute no host facts */
    }
  }
  candidates.push(...rules.paths.map((path) => ({ path, exact: false })))
  candidates.push(...registeredWorktrees.map((path) => ({ path, exact: true })))
  return candidates
}

function projectionFact(
  context: LocalHostContext,
  info: GitWorktreeFact,
  attached: readonly string[],
  materializedIds: ReadonlySet<string>,
  blocked: readonly string[],
  ordinal: number
): WorktreeProjectionFact {
  const resolved = context.path.resolve(info.path)
  const canonical = canonicalLocalWorktreePath(context, resolved) || resolved
  const identity = worktreeTargetId(context, canonical)
  const materialized = materializedIds.has(identity)
  return {
    identity,
    ordinal,
    name: context.path.basename(canonical),
    path: canonical,
    branch: info.branch || context.git.output(canonical, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() || '(unknown)',
    head: info.head || context.git.output(canonical, ['rev-parse', 'HEAD']).trim(),
    changedAtMs: latestLocalChangeMs(context, canonical),
    exists: context.fs.exists(canonical),
    sameAsHub: context.link.samePath(canonical, context.hubRoot),
    attached: materialized
      || attached.some((item) => context.link.samePath(item, canonical)),
    materialized,
    doNotAuto: blocked.some((item) => context.link.samePath(item, canonical)),
    officialPresent: context.fs.exists(context.path.join(canonical, '.claude', 'skills'))
      || context.fs.exists(context.path.join(canonical, '.codex', 'skills')),
    overrideLinked: context.link.isLinked(
      context.path.join(canonical, 'AGENTS.override.md'),
      context.path.join(context.hubRoot, 'AGENTS.override.md')
    ),
    locked: Boolean(info.locked),
    prunable: Boolean(info.prunable)
  }
}

function readWorktreeFacts(context: LocalHostContext): WorktreeDiscoveryFacts {
  const scanRoots = context.persist.readList(context.path.join(context.hubRoot, 'overlay', 'scan-roots.txt'))
  const explicitWorktrees = readRegisteredWorktrees(context)
  const baseRules = configuredCheckoutRules(context)
  const rules: CheckoutRules = {
    ...baseRules,
    paths: [...baseRules.paths, ...explicitWorktrees]
  }
  const attached = context.persist.readList(context.path.join(context.hubRoot, 'overlay', 'attached-worktrees.txt'))
  const materializedIds = materializedWorktreeIds(context)
  const blocked = context.persist.readList(context.path.join(context.hubRoot, 'overlay', 'do-not-auto-attach.txt'))
  let ordinal = 0
  const observations: WorktreeCloneObservation[] = []
  for (const candidateFact of discoveryCandidates(context, scanRoots, baseRules, explicitWorktrees)) {
    const candidate = candidateFact.path
    const resolved = context.path.resolve(candidate)
    const rawCommon = context.git.output(candidate, ['rev-parse', '--git-common-dir']).trim()
    const common = rawCommon ? context.path.resolve(candidate, rawCommon) : context.path.resolve(candidate, '.git')
    const seedBase = projectionFact(context, {
      path: candidate,
      branch: '',
      head: '',
      locked: false,
      prunable: false
    }, attached, materializedIds, blocked, ordinal++)
    const seed: WorktreeSeedFact = {
      ...seedBase,
      recognition: {
        name: context.path.basename(resolved),
        exists: seedBase.exists,
        isDirectory: context.fs.isDirectory(resolved),
        sameAsHub: seedBase.sameAsHub,
        explicitlyAllowed: rules.paths.some((item) => context.link.samePath(item, resolved)),
        requiredMarkers: rules.require.map((marker) => ({
          name: marker,
          present: context.fs.exists(context.path.join(resolved, marker))
        }))
      }
    }
    const listed = candidateFact.exact
      ? []
      : parseWorktreePorcelain(context.git.output(candidate, ['worktree', 'list', '--porcelain']))
        .map((info) => projectionFact(context, info, attached, materializedIds, blocked, ordinal++))
    observations.push({
      cloneIdentity: `clone:${context.hash.sha256(context.path.comparisonKey(common)).slice(0, 24)}`,
      cloneRoot: cloneRootFromCommonDir(context, common),
      seed,
      listed
    })
  }
  return { scanRoots, rules, observations }
}

function inspectWorktree(context: LocalHostContext, worktree: string): WorktreeInspection {
  const resolvedPath = context.path.resolve(worktree)
  const rules = effectiveCheckoutRules(context)
  const name = context.path.basename(resolvedPath).toLowerCase()
  const attached = context.persist.readList(context.path.join(context.hubRoot, 'overlay', 'attached-worktrees.txt'))
  const canonical = canonicalLocalWorktreePath(context, resolvedPath) || resolvedPath
  const targetId = worktreeTargetId(context, canonical)
  const blocked = context.persist.readList(context.path.join(context.hubRoot, 'overlay', 'do-not-auto-attach.txt'))
  return {
    targetId,
    resolvedPath,
    recognition: {
      exists: context.fs.exists(resolvedPath),
      isDirectory: context.fs.isDirectory(resolvedPath),
      sameAsHub: context.link.samePath(resolvedPath, context.hubRoot),
      excluded: rules.exclude.some((item) => item.toLowerCase() === name),
      partialCheckout: name.includes('.partial-'),
      explicitlyAllowed: rules.paths.some((item) => context.link.samePath(item, resolvedPath)),
      ephemeral: isEphemeralPath(resolvedPath),
      requiredMarkers: rules.require.map((marker) => ({
        name: marker,
        present: context.fs.exists(context.path.join(resolvedPath, marker))
      }))
    },
    blocked: blocked.some((item) => context.link.samePath(item, resolvedPath)),
    claimed: claimedWorktreeIds(context).has(targetId)
      || attached.some((item) => context.link.samePath(item, resolvedPath))
  }
}

function readStatusFacts(context: LocalHostContext): HubStatusFacts {
  const stateFile = context.path.join(context.hubRoot, 'skill-review', 'state.json')
  const raw = context.persist.readJson<unknown>(stateFile, { version: 1, items: [], lastIngest: null })
  if (raw && typeof raw === 'object' && !Array.isArray(raw)
    && (raw as { schemaVersion?: unknown }).schemaVersion === 2) {
    const validation = validateHubStateV2(raw)
    if (!validation.valid) throw new Error('HubStateV2 failed shared validation')
    const gameRepo = gameRepoOf(context)
    return {
      hubRoot: context.hubRoot,
      gameRepo,
      lastIngest: validation.value.lastIngest
        ? {
            ref: validation.value.lastIngest.ref,
            old: validation.value.lastIngest.old,
            new: validation.value.lastIngest.new,
            gameRepo: gameRepo || validation.value.lastIngest.gameRepoId
          }
        : null,
      items: validation.value.items
    }
  }
  const state = raw as { items?: HubStatusFacts['items']; lastIngest?: HubStatusFacts['lastIngest'] }
  return {
    hubRoot: context.hubRoot,
    gameRepo: gameRepoOf(context),
    lastIngest: state.lastIngest || null,
    items: state.items || []
  }
}

export function createLocalQueryPort(context: LocalHostContext): HubQueryPort {
  return {
    readStatusFacts: () => readStatusFacts(context),
    listSkillFacts: () => listSkillFacts(context),
    readWorktreeFacts: () => readWorktreeFacts(context),
    readSkill: (requested) => resolveSkillTarget(context, requested),
    listHistory: (limit) => historyRecords(context, limit),
    inspectWorktree: (worktree) => inspectWorktree(context, worktree)
  }
}
