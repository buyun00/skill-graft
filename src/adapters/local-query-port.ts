import type {
  HubQueryPort,
  SkillReadPortResult,
  WorktreeInspection
} from '../application/ports.js'
import { validateHubStateV2, type HistoryRecordView, type SkillKind } from '../contracts/index.js'
import { RESIDENT_SKILLS } from '../core/constants.js'
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
import { worktreeTargetId } from './worktree-target.js'

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
  gameRepo: string | null
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
      attached: Boolean(source === 'adopted' && gameRepo && context.link.isLinked(
        context.path.join(gameRepo, '.agents', 'skills', entry.name),
        context.path.join(context.hubRoot, 'skills', 'adopted', entry.name)
      )),
      ordinal: startOrdinal + index
    }))
}

function listSkillFacts(context: LocalHostContext): SkillHostFact[] {
  const gameRepo = gameRepoOf(context)
  const resident: SkillHostFact[] = RESIDENT_SKILLS.map((name, ordinal) => ({
    source: 'resident',
    name,
    path: `skills/${name}`,
    hasSkillMd: context.fs.exists(context.path.join(context.hubRoot, 'skills', name, 'SKILL.md')),
    attached: Boolean(gameRepo && context.link.isLinked(
      context.path.join(gameRepo, '.agents', 'skills', name),
      context.path.join(context.hubRoot, 'skills', name)
    )),
    ordinal
  }))
  const adopted = skillGroupFacts(context, 'skills/adopted', 'adopted', resident.length, gameRepo)
  const inbox = skillGroupFacts(context, 'skills/inbox', 'inbox', resident.length + adopted.length, gameRepo)
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

function checkoutRules(context: LocalHostContext): CheckoutRules {
  return parseCheckoutRules(context.fs.readText(context.path.join(context.hubRoot, 'overlay', 'checkout-rules.txt')))
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

function discoveryCandidates(context: LocalHostContext, scanRoots: readonly string[], rules: CheckoutRules): string[] {
  const candidates: string[] = []
  for (const root of scanRoots) {
    if (!root || !context.fs.exists(root)) continue
    try {
      for (const entry of context.fs.readDir(root)) {
        if (!entry.isDirectory && !entry.isSymbolicLink) continue
        candidates.push(context.path.join(root, entry.name))
      }
    } catch {
      /* unreadable scan roots contribute no host facts */
    }
  }
  candidates.push(...rules.paths)
  return candidates
}

function projectionFact(
  context: LocalHostContext,
  info: GitWorktreeFact,
  attached: readonly string[],
  blocked: readonly string[],
  ordinal: number
): WorktreeProjectionFact {
  const resolved = context.path.resolve(info.path)
  return {
    identity: worktreeTargetId(context, resolved),
    ordinal,
    name: context.path.basename(resolved),
    path: info.path,
    branch: info.branch || context.git.output(info.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() || '(unknown)',
    head: info.head || context.git.output(info.path, ['rev-parse', 'HEAD']).trim(),
    changedAtMs: latestLocalChangeMs(context, resolved),
    exists: context.fs.exists(info.path),
    sameAsHub: context.link.samePath(info.path, context.hubRoot),
    attached: attached.some((item) => context.link.samePath(item, info.path)),
    doNotAuto: blocked.some((item) => context.link.samePath(item, info.path)),
    officialPresent: context.fs.exists(context.path.join(info.path, '.claude', 'skills'))
      || context.fs.exists(context.path.join(info.path, '.codex', 'skills')),
    overrideLinked: context.link.isLinked(
      context.path.join(info.path, 'AGENTS.override.md'),
      context.path.join(context.hubRoot, 'AGENTS.override.md')
    ),
    locked: Boolean(info.locked),
    prunable: Boolean(info.prunable)
  }
}

function readWorktreeFacts(context: LocalHostContext): WorktreeDiscoveryFacts {
  const scanRoots = context.persist.readList(context.path.join(context.hubRoot, 'overlay', 'scan-roots.txt'))
  const rules = checkoutRules(context)
  const attached = context.persist.readList(context.path.join(context.hubRoot, 'overlay', 'attached-worktrees.txt'))
  const blocked = context.persist.readList(context.path.join(context.hubRoot, 'overlay', 'do-not-auto-attach.txt'))
  let ordinal = 0
  const observations: WorktreeCloneObservation[] = []
  for (const candidate of discoveryCandidates(context, scanRoots, rules)) {
    const resolved = context.path.resolve(candidate)
    const rawCommon = context.git.output(candidate, ['rev-parse', '--git-common-dir']).trim()
    const common = rawCommon ? context.path.resolve(candidate, rawCommon) : context.path.resolve(candidate, '.git')
    const seedBase = projectionFact(context, {
      path: candidate,
      branch: '',
      head: '',
      locked: false,
      prunable: false
    }, attached, blocked, ordinal++)
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
    const listed = parseWorktreePorcelain(context.git.output(candidate, ['worktree', 'list', '--porcelain']))
      .map((info) => projectionFact(context, info, attached, blocked, ordinal++))
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
  const rules = checkoutRules(context)
  const name = context.path.basename(resolvedPath).toLowerCase()
  const attached = context.persist.readList(context.path.join(context.hubRoot, 'overlay', 'attached-worktrees.txt'))
  const blocked = context.persist.readList(context.path.join(context.hubRoot, 'overlay', 'do-not-auto-attach.txt'))
  return {
    targetId: worktreeTargetId(context, resolvedPath),
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
    claimed: attached.some((item) => context.link.samePath(item, resolvedPath))
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
