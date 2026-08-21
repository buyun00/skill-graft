import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import type { LegacyAttachPort, LegacyDetachPort, MaybePromise, WorktreeInspection } from '../application/ports.js'
import type {
  ApprovedLegacyAttachPlan,
  ApprovedLegacyDetachPlan,
  LegacyAttachArtifactFact,
  LegacyAttachApplyEffect,
  LegacyAttachInspection,
  LegacyAttachObservedArtifact
} from '../contracts/index.js'
import { RESIDENT_SKILLS } from '../core/constants.js'
import type { LocalHostContext } from './host-context.js'

type WorktreeInspector = (worktree: string) => MaybePromise<WorktreeInspection>

export type LocalLegacyAttachPortOptions = {
  /** Test/diagnostic seam. Production composition leaves this undefined. */
  checkpoint?: (step: string) => void
}

type UndoJournal = Array<() => void>

type GitConfigSnapshot = {
  cwd: string
  key: string
  values: readonly string[]
}

function lstat(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target)
  } catch {
    return null
  }
}

function normalizedRelative(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

function relativeKey(value: string): string {
  const normalized = normalizedRelative(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function relativeAtOrBelow(candidate: string, root: string): boolean {
  const value = relativeKey(candidate)
  const base = relativeKey(root).replace(/\/+$/, '')
  return value === base || value.startsWith(`${base}/`)
}

function comparable(value: string): string {
  const resolved = path.resolve(value).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isInside(root: string, target: string): boolean {
  const relation = path.relative(root, target)
  return relation === '' || relation !== '..' && !relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation)
}

function safeInside(root: string, relative: string, options: { allowFinalLink?: boolean } = {}): string {
  const normalized = normalizedRelative(relative)
  if (!normalized || path.isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new Error('legacy attach plan contains an unsafe relative path')
  }
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(resolvedRoot, ...normalized.split('/'))
  const relation = path.relative(resolvedRoot, resolved)
  if (!relation || relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error('legacy attach plan escaped its worktree')
  }

  const rootReal = lstat(resolvedRoot) ? fs.realpathSync.native(resolvedRoot) : resolvedRoot
  let current = resolvedRoot
  const parts = normalized.split('/').filter(Boolean)
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index])
    const stat = lstat(current)
    if (!stat) break
    const final = index === parts.length - 1
    if (stat.isSymbolicLink()) {
      if (final && options.allowFinalLink) continue
      throw new Error('legacy attach path crosses a linked ancestor')
    }
    const real = fs.realpathSync.native(current)
    if (!isInside(comparable(rootReal), comparable(real))) {
      throw new Error('legacy attach path escaped through an existing ancestor')
    }
  }
  return resolved
}

function hashBytes(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function digestPath(target: string): string | undefined {
  const stat = lstat(target)
  if (!stat) return
  if (stat.isSymbolicLink()) {
    try {
      return hashBytes(`link:${fs.readlinkSync(target)}`)
    } catch {
      return hashBytes('link:unreadable')
    }
  }
  if (stat.isFile()) return hashBytes(fs.readFileSync(target))
  if (!stat.isDirectory()) return hashBytes(`other:${stat.mode}`)

  const entries: string[] = []
  const visit = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(dir, entry.name)
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const child = fs.lstatSync(absolute)
      if (child.isSymbolicLink()) {
        entries.push(`l:${relative}:${fs.readlinkSync(absolute)}`)
      } else if (child.isDirectory()) {
        visit(absolute, relative)
      } else if (child.isFile()) {
        entries.push(`f:${relative}:${hashBytes(fs.readFileSync(absolute))}`)
      }
    }
  }
  visit(target, '')
  return hashBytes(entries.join('\n'))
}

function assertNoLinkedDescendants(target: string) {
  const stat = lstat(target)
  if (!stat) throw new Error('legacy attach promotion source is missing')
  if (stat.isSymbolicLink()) throw new Error('legacy attach promotion source contains a linked path')
  if (!stat.isDirectory()) return
  const rootReal = fs.realpathSync.native(target)
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name)
      const childStat = fs.lstatSync(child)
      if (childStat.isSymbolicLink()) {
        throw new Error('legacy attach promotion source contains a linked path')
      }
      const childReal = fs.realpathSync.native(child)
      if (!isInside(comparable(rootReal), comparable(childReal))) {
        throw new Error('legacy attach promotion source escapes through a reparse point')
      }
      if (childStat.isDirectory()) visit(child)
    }
  }
  visit(target)
}

function actualKind(stat: fs.Stats | null): LegacyAttachObservedArtifact['actualKind'] {
  if (!stat) return
  if (stat.isSymbolicLink()) return 'link'
  if (stat.isDirectory()) return 'directory'
  return 'file'
}

function runGit(cwd: string, args: readonly string[], required = true): string {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  })
  if (result.status !== 0) {
    if (!required) return ''
    throw new Error('legacy attach git operation failed')
  }
  return result.stdout || ''
}

function runGitWithPathInput(cwd: string, args: readonly string[], paths: readonly string[]): string {
  const input = Buffer.from(`${paths.map(normalizedRelative).join('\0')}\0`, 'utf8')
  const result = spawnSync('git', ['-C', cwd, ...args], {
    input,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  })
  if (result.status !== 0) throw new Error('legacy attach git path operation failed')
  return result.stdout || ''
}

function readGitConfigValues(cwd: string, key: string): string[] {
  const result = spawnSync('git', ['-C', cwd, 'config', '--local', '--null', '--get-all', key], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  })
  if (result.status === 1) return []
  if (result.status !== 0) throw new Error('legacy attach git configuration preflight failed')
  return String(result.stdout || '').split('\0').filter((value) => value !== '')
}

function restoreGitConfig(snapshot: GitConfigSnapshot) {
  const unset = spawnSync('git', ['-C', snapshot.cwd, 'config', '--local', '--unset-all', snapshot.key], {
    encoding: 'utf8',
    windowsHide: true
  })
  if (unset.status !== 0 && unset.status !== 1 && unset.status !== 5) {
    throw new Error('legacy attach git configuration rollback failed')
  }
  for (const value of snapshot.values) {
    runGit(snapshot.cwd, ['config', '--local', '--add', snapshot.key, value])
  }
}

function readSkipWorktree(context: LocalHostContext, worktree: string, paths: readonly string[]): Map<string, boolean> {
  const states = new Map<string, boolean>()
  for (const relative of paths) states.set(relativeKey(relative), false)
  for (let offset = 0; offset < paths.length; offset += 100) {
    const batch = paths.slice(offset, offset + 100)
    const output = runGit(worktree, ['-c', 'core.quotepath=false', 'ls-files', '-v', '-z', '--', ...batch])
    for (const record of output.split('\0').filter(Boolean)) {
      const match = record.match(/^(.)(?:\s)(.*)$/s)
      if (!match) continue
      states.set(relativeKey(match[2]), match[1].toUpperCase() === 'S')
    }
  }
  return states
}

function restoreSkipWorktree(worktree: string, paths: readonly string[], states: ReadonlyMap<string, boolean>) {
  if (paths.length > 0) runGitWithPathInput(worktree, ['update-index', '--no-skip-worktree', '-z', '--stdin'], paths)
  const skipped = paths.filter((relative) => states.get(relativeKey(relative)))
  if (skipped.length > 0) runGitWithPathInput(worktree, ['update-index', '--skip-worktree', '-z', '--stdin'], skipped)
}

function gitRoot(candidate: string): string | null {
  const value = runGit(candidate, ['rev-parse', '--show-toplevel'], false).trim()
  return value ? path.resolve(value) : null
}

function artifactFact(
  context: LocalHostContext,
  worktree: string,
  input: Omit<LegacyAttachArtifactFact, 'libraryExists' | 'observed'>
): LegacyAttachArtifactFact {
  const target = safeInside(worktree, input.targetRelativePath, { allowFinalLink: true })
  const library = safeInside(context.hubRoot, input.hubRelativePath)
  const targetStat = lstat(target)
  const libraryStat = lstat(library)
  const linkedToExpected = Boolean(targetStat && libraryStat && context.link.isLinked(target, library))
  const kind = actualKind(targetStat)
  const observedDigest = digestPath(target)
  const libraryDigest = digestPath(library)
  return {
    ...input,
    libraryExists: Boolean(libraryStat),
    observed: {
      exists: Boolean(targetStat),
      actualKind: kind,
      linkedToExpected,
      pointsElsewhere: kind === 'link' && !linkedToExpected,
      contentMatches: linkedToExpected || Boolean(observedDigest && libraryDigest && observedDigest === libraryDigest),
      observedDigest,
      libraryDigest
    }
  }
}

function assistantPathsOnDisk(worktree: string): string[] {
  const paths = ['.claude', '.codex/agents', '.codex/scripts', '.codex/skills', '.codex/cursor-rules.env']
    .filter((relative) => lstat(safeInside(worktree, relative)))
  const skillRoot = safeInside(worktree, '.agents/skills')
  if (lstat(skillRoot)?.isDirectory()) {
    for (const entry of fs.readdirSync(skillRoot, { withFileTypes: true })) {
      if (entry.isDirectory() || entry.isSymbolicLink()) paths.push(`.agents/skills/${entry.name}`)
    }
  }
  return paths
}

function trackedAssistantPaths(worktree: string, isGitWorktree: boolean): string[] {
  if (!isGitWorktree) return []
  return runGit(worktree, ['-c', 'core.quotepath=false', 'ls-files', '-z', '--', 'AGENTS.override.md', '.agents', '.claude', '.codex'])
    .split('\0')
    .map(normalizedRelative)
    .filter(Boolean)
}

function adoptedNames(context: LocalHostContext): string[] {
  const root = safeInside(context.hubRoot, 'skills/adopted')
  const stat = lstat(root)
  if (!stat?.isDirectory()) return []
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right))
}

function backupStamp(context: LocalHostContext): string {
  return context.clock.nowIso().replace(/[^0-9]/g, '').slice(0, 14) || 'unknown'
}

function artifactDefinitions(context: LocalHostContext) {
  return [
    {
      id: 'agentsOverride',
      kind: 'agentsOverride' as const,
      label: 'AGENTS.override.md',
      targetRelativePath: 'AGENTS.override.md',
      hubRelativePath: 'AGENTS.override.md',
      expectedKind: 'file' as const
    },
    ...RESIDENT_SKILLS.map((name) => ({
      id: `resident:${name}`,
      kind: 'residentSkill' as const,
      name,
      label: name,
      targetRelativePath: `.agents/skills/${name}`,
      hubRelativePath: `skills/${name}`,
      expectedKind: 'directory' as const
    })),
    ...adoptedNames(context).map((name) => ({
      id: `adopted:${name}`,
      kind: 'adoptedSkill' as const,
      name,
      label: `adopted:${name}`,
      targetRelativePath: `.agents/skills/${name}`,
      hubRelativePath: `skills/adopted/${name}`,
      expectedKind: 'directory' as const
    })),
    {
      id: 'localOverlay',
      kind: 'localOverlay' as const,
      label: 'overlay',
      targetRelativePath: '.codex/local-overlay',
      hubRelativePath: 'overlay',
      expectedKind: 'directory' as const,
      backupRelativePath: `.codex/local-overlay.pre-hub-${backupStamp(context)}`
    }
  ]
}

function sameObserved(left: LegacyAttachArtifactFact, right: LegacyAttachArtifactFact): boolean {
  return left.id === right.id
    && left.targetRelativePath === right.targetRelativePath
    && left.hubRelativePath === right.hubRelativePath
    && left.expectedKind === right.expectedKind
    && left.libraryExists === right.libraryExists
    && JSON.stringify(left.observed) === JSON.stringify(right.observed)
}

function removeExisting(target: string) {
  if (lstat(target)) fs.rmSync(target, { recursive: true, force: true })
}

function linkArtifact(context: LocalHostContext, worktree: string, artifact: ApprovedLegacyAttachPlan['artifacts'][number]): string {
  const target = safeInside(worktree, artifact.targetRelativePath, { allowFinalLink: true })
  const library = safeInside(context.hubRoot, artifact.hubRelativePath)
  if (artifact.expectedKind === 'file') context.link.linkFile(target, library)
  else context.link.linkDirectory(target, library)
  const stat = fs.lstatSync(target)
  if (stat.isSymbolicLink()) return artifact.expectedKind === 'directory' && process.platform === 'win32' ? 'junction' : 'symlink'
  return 'hardlink'
}

function gitConfiguration(context: LocalHostContext, worktree: string) {
  const hooks = safeInside(context.hubRoot, 'overlay/hooks')
  return [
    { cwd: worktree, key: 'core.hooksPath', value: hooks },
    { cwd: worktree, key: 'ozdqp.localOverlaySource', value: context.hubRoot },
    { cwd: worktree, key: 'ozdqp.skillWatchWorkspace', value: context.hubRoot },
    { cwd: worktree, key: 'ozdqp.skillWatchEnabled', value: 'true' },
    { cwd: context.hubRoot, key: 'ozdqp.gameRepo', value: worktree }
  ] as const
}

function hasClaim(context: LocalHostContext, worktree: string): boolean {
  const list = context.persist.readList(safeInside(context.hubRoot, 'overlay/attached-worktrees.txt'))
  return list.some((candidate) => context.link.samePath(candidate, worktree))
}

function transactionSlot(root: string, ordinal: number, label: string): string {
  const suffix = hashBytes(`${ordinal}:${label}`).slice(0, 16)
  return path.join(root, `${String(ordinal).padStart(3, '0')}-${suffix}`)
}

function rollback(journal: UndoJournal) {
  const failures: unknown[] = []
  for (const undo of [...journal].reverse()) {
    try { undo() } catch (error) { failures.push(error) }
  }
  if (failures.length > 0) throw new Error('legacy attach transaction rollback failed')
}

function cleanupStaging(...entries: { root: string; parentExisted: boolean }[]) {
  for (const { root, parentExisted } of entries) {
    try { removeExisting(root) } catch {}
    const parent = path.dirname(root)
    try {
      if (!parentExisted && lstat(parent)?.isDirectory() && fs.readdirSync(parent).length === 0) fs.rmdirSync(parent)
    } catch {}
  }
}

function missingParentDirectories(root: string, target: string): string[] {
  const missing: string[] = []
  let current = path.dirname(target)
  const rootKey = comparable(root)
  while (comparable(current) !== rootKey) {
    if (lstat(current)) break
    missing.push(current)
    const parent = path.dirname(current)
    if (comparable(parent) === comparable(current)) break
    current = parent
  }
  return missing
}

function removeCreatedTarget(target: string, missingParents: readonly string[]) {
  removeExisting(target)
  for (const directory of missingParents) {
    try {
      if (lstat(directory)?.isDirectory() && fs.readdirSync(directory).length === 0) fs.rmdirSync(directory)
    } catch {}
  }
}

export function createLocalLegacyAttachPort(
  context: LocalHostContext,
  inspectWorktree: WorktreeInspector,
  options: LocalLegacyAttachPortOptions = {}
): LegacyAttachPort {
  const inspect = async (candidate: string): Promise<LegacyAttachInspection> => {
    const root = gitRoot(candidate)
    const resolved = root || context.path.resolve(candidate)
    const worktree = await inspectWorktree(resolved)
    return {
      worktree,
      gitWorktree: Boolean(root),
      artifacts: artifactDefinitions(context).map((definition) => artifactFact(context, worktree.resolvedPath, definition)),
      trackedAssistantPaths: trackedAssistantPaths(worktree.resolvedPath, Boolean(root)),
      presentAssistantPaths: worktree.recognition.exists && worktree.recognition.isDirectory
        ? assistantPathsOnDisk(worktree.resolvedPath)
        : []
    }
  }

  return {
    inspect,
    async apply(plan) {
      const current = await inspect(plan.worktree)
      if (comparable(current.worktree.resolvedPath) !== comparable(plan.worktree)) {
        throw new Error('legacy attach worktree changed before apply')
      }

      const expectedClaimed = plan.claim === 'keep'
      if (current.worktree.claimed !== expectedClaimed || hasClaim(context, plan.worktree) !== expectedClaimed) {
        throw new Error('legacy attach claim changed before apply')
      }

      for (const artifact of plan.artifacts) {
        const now = current.artifacts.find((candidate) => candidate.id === artifact.id)
        if (!now || !sameObserved(artifact, now)) throw new Error('legacy attach artifact changed before apply')
        if (artifact.targetRelativePath !== now.targetRelativePath || artifact.hubRelativePath !== now.hubRelativePath) {
          throw new Error('legacy attach artifact path was not approved')
        }
        if (artifact.backupRelativePath && lstat(safeInside(plan.worktree, artifact.backupRelativePath))) {
          throw new Error('legacy attach backup target already exists')
        }
        if (artifact.action === 'promoteToLibraryThenLink') {
          assertNoLinkedDescendants(safeInside(plan.worktree, artifact.targetRelativePath, { allowFinalLink: true }))
        }
      }

      const tracked = new Set(current.trackedAssistantPaths.map((value) => normalizedRelative(value).toLowerCase()))
      const present = new Set(current.presentAssistantPaths.map((value) => normalizedRelative(value).toLowerCase()))
      for (const relative of plan.visibility.trackedPaths) {
        safeInside(plan.worktree, relative)
        if (!tracked.has(normalizedRelative(relative).toLowerCase())) throw new Error('legacy attach tracked path changed before apply')
      }
      for (const relative of plan.visibility.removePaths) {
        safeInside(plan.worktree, relative)
        if (!present.has(normalizedRelative(relative).toLowerCase())) throw new Error('legacy attach removal path changed before apply')
      }

      // All mutable host facts are captured before the first staging directory
      // is created. TODO(P3): classify unknown project-owned Skill roots before
      // changing their visibility. P1 deliberately follows the Core-approved
      // list, which already excludes unity-skills and adopted Skill names.
      const skipSnapshot = plan.visibility.mode === 'disable'
        ? readSkipWorktree(context, plan.worktree, plan.visibility.trackedPaths)
        : new Map<string, boolean>()
      const configuration = plan.configureGit ? gitConfiguration(context, plan.worktree) : []
      const configSnapshots: GitConfigSnapshot[] = configuration.map((entry) => ({
        cwd: entry.cwd,
        key: entry.key,
        values: readGitConfigValues(entry.cwd, entry.key)
      }))
      const claimFile = safeInside(context.hubRoot, 'overlay/attached-worktrees.txt')
      const claimStat = lstat(claimFile)
      if (claimStat && !claimStat.isFile()) throw new Error('legacy attach claim store is not a file')
      const claimBefore = context.fs.readText(claimFile)

      const token = hashBytes(`${context.ids.next('legacy-attach-transaction')}:${context.clock.nowIso()}:${plan.worktree}`).slice(0, 24)
      const worktreeStage = safeInside(plan.worktree, `.skill-graft-transactions/${token}`)
      const hubStage = safeInside(context.hubRoot, `.skill-graft-transactions/${token}`)
      const worktreeStageParentExisted = Boolean(lstat(path.dirname(worktreeStage)))
      const hubStageParentExisted = Boolean(lstat(path.dirname(hubStage)))
      if (lstat(worktreeStage) || lstat(hubStage)) throw new Error('legacy attach transaction staging already exists')

      const journal: UndoJournal = []
      const effects: LegacyAttachApplyEffect[] = []
      let ordinal = 0
      let visibility = { trackedChanged: 0, removed: 0 }
      let claimed = false
      const checkpoint = (step: string) => options.checkpoint?.(step)
      const nextSlot = (root: string, label: string) => transactionSlot(root, ++ordinal, label)
      const stageExisting = (source: string, stageRoot: string, label: string) => {
        const staged = nextSlot(stageRoot, label)
        fs.mkdirSync(path.dirname(staged), { recursive: true })
        fs.renameSync(source, staged)
        journal.push(() => {
          removeExisting(source)
          fs.mkdirSync(path.dirname(source), { recursive: true })
          if (lstat(staged)) fs.renameSync(staged, source)
        })
        return staged
      }
      const linkWithUndo = (artifact: ApprovedLegacyAttachPlan['artifacts'][number]) => {
        const target = safeInside(plan.worktree, artifact.targetRelativePath, { allowFinalLink: true })
        const missingParents = missingParentDirectories(plan.worktree, target)
        journal.push(() => removeCreatedTarget(target, missingParents))
        return linkArtifact(context, plan.worktree, artifact)
      }

      try {
        fs.mkdirSync(worktreeStage, { recursive: true })
        fs.mkdirSync(hubStage, { recursive: true })
        checkpoint('transaction:staged')

        for (const artifact of plan.artifacts) {
          const now = artifactFact(context, plan.worktree, artifact)
          if (!sameObserved(artifact, now)) throw new Error('legacy attach artifact changed during apply')
          if (artifact.action === 'keep') {
            effects.push({ id: artifact.id, status: 'unchanged' })
            continue
          }

          const target = safeInside(plan.worktree, artifact.targetRelativePath, { allowFinalLink: true })
          const library = safeInside(context.hubRoot, artifact.hubRelativePath)
          let targetStaged: string | undefined
          let mechanism: string

          if (artifact.action === 'promoteToLibraryThenLink') {
            assertNoLinkedDescendants(target)
            const originalDigest = digestPath(target)
            if (!originalDigest) throw new Error('legacy attach promotion source is missing')
            const incoming = nextSlot(hubStage, `${artifact.id}:incoming`)
            fs.cpSync(target, incoming, {
              recursive: artifact.expectedKind === 'directory',
              errorOnExist: true,
              force: false
            })
            if (digestPath(incoming) !== originalDigest || digestPath(target) !== originalDigest) {
              throw new Error('legacy attach promotion copy verification failed')
            }
            targetStaged = stageExisting(target, worktreeStage, `${artifact.id}:target`)
            stageExisting(library, hubStage, `${artifact.id}:library`)
            fs.renameSync(incoming, library)
            journal.push(() => removeExisting(library))
            mechanism = linkWithUndo(artifact)
          } else {
            if (artifact.action === 'replaceWithLibrary' || artifact.action === 'backupThenLink') {
              targetStaged = stageExisting(target, worktreeStage, `${artifact.id}:target`)
            }
            mechanism = linkWithUndo(artifact)
          }

          if (artifact.action === 'backupThenLink') {
            if (!artifact.backupRelativePath || !targetStaged) throw new Error('legacy attach backup path is missing')
            const backup = safeInside(plan.worktree, artifact.backupRelativePath)
            fs.mkdirSync(path.dirname(backup), { recursive: true })
            fs.renameSync(targetStaged, backup)
            journal.push(() => {
              if (lstat(backup)) fs.renameSync(backup, targetStaged as string)
            })
          }
          effects.push({ id: artifact.id, status: 'applied', mechanism })
          checkpoint(`artifact:${artifact.id}:applied`)
        }

        if (plan.visibility.mode === 'disable') {
          if (plan.visibility.trackedPaths.length > 0) {
            journal.push(() => restoreSkipWorktree(plan.worktree, plan.visibility.trackedPaths, skipSnapshot))
            for (let offset = 0; offset < plan.visibility.trackedPaths.length; offset += 100) {
              runGit(plan.worktree, ['update-index', '--skip-worktree', '--', ...plan.visibility.trackedPaths.slice(offset, offset + 100)])
            }
            visibility.trackedChanged = plan.visibility.trackedPaths.length
            checkpoint('visibility:index')
          }
          for (const relative of plan.visibility.removePaths) {
            const target = safeInside(plan.worktree, relative)
            if (!lstat(target)) continue
            stageExisting(target, worktreeStage, `visibility:${relative}`)
            visibility.removed += 1
            checkpoint(`visibility:remove:${normalizedRelative(relative)}`)
          }
        }

        if (plan.configureGit) {
          journal.push(() => {
            for (const snapshot of [...configSnapshots].reverse()) restoreGitConfig(snapshot)
          })
          for (const entry of configuration) {
            runGit(entry.cwd, ['config', '--local', '--replace-all', entry.key, entry.value])
            checkpoint(`config:${entry.key}`)
          }
        }

        if (plan.claim === 'create') {
          const nextClaim = nextSlot(hubStage, 'claim:next')
          const separator = claimBefore && !claimBefore.endsWith('\n') ? '\n' : ''
          context.fs.writeText(nextClaim, `${claimBefore || ''}${separator}${plan.worktree}\n`)
          if (claimStat) stageExisting(claimFile, hubStage, 'claim:original')
          journal.push(() => removeExisting(claimFile))
          fs.renameSync(nextClaim, claimFile)
          claimed = true
          checkpoint('claim:written')
        }
      } catch (error) {
        // If rollback itself cannot complete, retain marker-owned staging for
        // recovery instead of deleting the only remaining originals.
        rollback(journal)
        cleanupStaging(
          { root: worktreeStage, parentExisted: worktreeStageParentExisted },
          { root: hubStage, parentExisted: hubStageParentExisted }
        )
        throw error
      }

      // Committed staged originals are redundant backups except for the
      // explicit backupThenLink destination already moved out of staging.
      // Cleanup is best-effort: a failure leaves recoverable marker-owned data
      // but never deletes the committed library/target/claim state.
      cleanupStaging(
        { root: worktreeStage, parentExisted: worktreeStageParentExisted },
        { root: hubStage, parentExisted: hubStageParentExisted }
      )
      return {
        changed: effects.some((effect) => effect.status === 'applied')
          || visibility.trackedChanged > 0
          || visibility.removed > 0
          || plan.configureGit
          || claimed,
        effects,
        visibility,
        gitConfigured: plan.configureGit,
        claim: claimed ? 'created' : 'alreadyClaimed'
      }
    }
  }
}

function removeClaimRecord(context: LocalHostContext, contents: string, worktree: string): { contents: string; removed: boolean } {
  let removed = false
  const records = contents.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)?.filter((record) => record.length > 0) || []
  const kept = records.filter((record) => {
    const value = record.replace(/[\r\n]+$/, '').trim()
    if (!value || value.startsWith('#')) return true
    let matches = false
    try {
      matches = context.link.samePath(value, worktree)
    } catch {
      matches = false
    }
    if (matches) removed = true
    return !matches
  })
  return { contents: kept.join(''), removed }
}

/** Local host implementation for the Core-approved legacy detach transaction. */
export function createLocalLegacyDetachPort(
  context: LocalHostContext,
  inspectWorktree: WorktreeInspector,
  options: LocalLegacyAttachPortOptions = {}
): LegacyDetachPort {
  const inspect = async (candidate: string): Promise<LegacyAttachInspection> => {
    const root = gitRoot(candidate)
    const resolved = root || context.path.resolve(candidate)
    const worktree = await inspectWorktree(resolved)
    return {
      worktree,
      gitWorktree: Boolean(root),
      artifacts: artifactDefinitions(context).map((definition) => artifactFact(context, worktree.resolvedPath, definition)),
      trackedAssistantPaths: trackedAssistantPaths(worktree.resolvedPath, Boolean(root)),
      presentAssistantPaths: worktree.recognition.exists && worktree.recognition.isDirectory
        ? assistantPathsOnDisk(worktree.resolvedPath)
        : []
    }
  }

  return {
    inspect,
    async apply(plan: ApprovedLegacyDetachPlan) {
      const current = await inspect(plan.worktree)
      if (comparable(current.worktree.resolvedPath) !== comparable(plan.worktree)) {
        throw new Error('legacy detach worktree changed before apply')
      }
      if (!current.worktree.claimed || !hasClaim(context, plan.worktree)) {
        throw new Error('legacy detach claim changed before apply')
      }

      for (const artifact of plan.artifacts) {
        const now = current.artifacts.find((candidate) => candidate.id === artifact.id)
        if (!now || !sameObserved(artifact, now)) throw new Error('legacy detach artifact changed before apply')
        if (artifact.targetRelativePath !== now.targetRelativePath || artifact.hubRelativePath !== now.hubRelativePath) {
          throw new Error('legacy detach artifact path was not approved')
        }
        if (artifact.action === 'unlink' && (!now.observed.exists || !now.observed.linkedToExpected)) {
          throw new Error('legacy detach unlink target changed before apply')
        }
        if (artifact.action === 'keepMissing' && now.observed.exists) {
          throw new Error('legacy detach missing target changed before apply')
        }
      }

      const tracked = new Set(current.trackedAssistantPaths.map(relativeKey))
      for (const relative of plan.restorePaths) {
        const normalized = relativeKey(relative)
        if (!tracked.has(normalized)) throw new Error('legacy detach restore path changed before apply')
        const coveredByApprovedUnlink = plan.artifacts.some((artifact) => (
          artifact.action === 'unlink' && relativeAtOrBelow(relative, artifact.targetRelativePath)
        ))
        // A tracked file hidden below an expected managed Junction/link is
        // intentionally non-empty until that exact artifact is staged. Every
        // other restore target must already be empty before the first write.
        if (!coveredByApprovedUnlink) {
          const target = safeInside(plan.worktree, relative)
          if (lstat(target)) throw new Error('legacy detach restore target is not empty')
        }
      }

      const skipSnapshot = readSkipWorktree(context, plan.worktree, plan.restorePaths)
      const claimFile = safeInside(context.hubRoot, 'overlay/attached-worktrees.txt')
      const claimStat = lstat(claimFile)
      if (!claimStat?.isFile()) throw new Error('legacy detach claim store is not a file')
      const claimBefore = context.fs.readText(claimFile)
      if (claimBefore == null) throw new Error('legacy detach claim store cannot be read')
      const nextClaim = removeClaimRecord(context, claimBefore, plan.worktree)
      if (!nextClaim.removed) throw new Error('legacy detach claim changed before apply')

      const token = hashBytes(`${context.ids.next('legacy-detach-transaction')}:${context.clock.nowIso()}:${plan.worktree}`).slice(0, 24)
      const worktreeStage = safeInside(plan.worktree, `.skill-graft-transactions/${token}`)
      const hubStage = safeInside(context.hubRoot, `.skill-graft-transactions/${token}`)
      const worktreeStageParentExisted = Boolean(lstat(path.dirname(worktreeStage)))
      const hubStageParentExisted = Boolean(lstat(path.dirname(hubStage)))
      if (lstat(worktreeStage) || lstat(hubStage)) throw new Error('legacy detach transaction staging already exists')

      const journal: UndoJournal = []
      const effects: Array<{ id: string; status: 'unlinked' | 'missing' }> = []
      let ordinal = 0
      const checkpoint = (step: string) => options.checkpoint?.(step)
      const nextSlot = (root: string, label: string) => transactionSlot(root, ++ordinal, label)
      const stageExisting = (source: string, stageRoot: string, label: string) => {
        const staged = nextSlot(stageRoot, label)
        fs.mkdirSync(path.dirname(staged), { recursive: true })
        fs.renameSync(source, staged)
        journal.push(() => {
          removeExisting(source)
          fs.mkdirSync(path.dirname(source), { recursive: true })
          if (lstat(staged)) fs.renameSync(staged, source)
        })
        return staged
      }

      try {
        fs.mkdirSync(worktreeStage, { recursive: true })
        fs.mkdirSync(hubStage, { recursive: true })
        checkpoint('detach:transaction:staged')

        const restoreStage = path.join(worktreeStage, 'restore-index')
        if (plan.restorePaths.length > 0) {
          fs.mkdirSync(restoreStage, { recursive: true })
          const prefix = `${restoreStage.replaceAll('\\', '/')}/`
          runGitWithPathInput(plan.worktree, [
            'checkout-index',
            '--force',
            '--ignore-skip-worktree-bits',
            `--prefix=${prefix}`,
            '-z',
            '--stdin'
          ], plan.restorePaths)
          for (const relative of plan.restorePaths) {
            const staged = safeInside(restoreStage, relative)
            const stat = lstat(staged)
            if (!stat?.isFile() || stat.isSymbolicLink()) {
              throw new Error('legacy detach index restore did not produce a regular file')
            }
          }
          checkpoint('detach:restore-index:staged')
        }

        for (const artifact of plan.artifacts) {
          if (artifact.action === 'keepMissing') {
            effects.push({ id: artifact.id, status: 'missing' })
            continue
          }
          const target = safeInside(plan.worktree, artifact.targetRelativePath, { allowFinalLink: true })
          const now = current.artifacts.find((candidate) => candidate.id === artifact.id)
          if (!now || !sameObserved(artifact, artifactFact(context, plan.worktree, artifact))) {
            throw new Error('legacy detach artifact changed during apply')
          }
          stageExisting(target, worktreeStage, `detach:${artifact.id}`)
          effects.push({ id: artifact.id, status: 'unlinked' })
          checkpoint(`detach:artifact:${artifact.id}:staged`)
        }

        for (const relative of plan.restorePaths) {
          const staged = safeInside(restoreStage, relative)
          const target = safeInside(plan.worktree, relative)
          if (lstat(target)) throw new Error('legacy detach restore target changed during apply')
          const missingParents = missingParentDirectories(plan.worktree, target)
          fs.mkdirSync(path.dirname(target), { recursive: true })
          fs.renameSync(staged, target)
          journal.push(() => removeCreatedTarget(target, missingParents))
          checkpoint(`detach:restore:${normalizedRelative(relative)}`)
        }

        if (plan.restorePaths.length > 0) {
          journal.push(() => restoreSkipWorktree(plan.worktree, plan.restorePaths, skipSnapshot))
          runGitWithPathInput(plan.worktree, ['update-index', '--no-skip-worktree', '-z', '--stdin'], plan.restorePaths)
          checkpoint('detach:index:restored')
        }

        const stagedClaim = stageExisting(claimFile, hubStage, 'detach:claim:original')
        const replacement = nextSlot(hubStage, 'detach:claim:next')
        context.fs.writeText(replacement, nextClaim.contents)
        journal.push(() => removeExisting(claimFile))
        fs.renameSync(replacement, claimFile)
        if (!lstat(stagedClaim)) throw new Error('legacy detach original claim was not staged')
        checkpoint('detach:claim:removed')
      } catch (error) {
        rollback(journal)
        cleanupStaging(
          { root: worktreeStage, parentExisted: worktreeStageParentExisted },
          { root: hubStage, parentExisted: hubStageParentExisted }
        )
        throw error
      }

      cleanupStaging(
        { root: worktreeStage, parentExisted: worktreeStageParentExisted },
        { root: hubStage, parentExisted: hubStageParentExisted }
      )
      return {
        changed: true,
        effects,
        restoredTracked: plan.restorePaths.length,
        claim: 'removed'
      }
    }
  }
}
