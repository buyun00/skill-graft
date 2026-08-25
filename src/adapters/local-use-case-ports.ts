import type {
  ArtifactFactsEffectPort,
  GitFactsPort,
  HubStateRepositoryPort,
  SharedUseCasePorts
} from '../application/use-case-ports.js'
import type { LocalHostContext } from './host-context.js'
import type {
  ArtifactEffect,
  ArtifactFact,
  ArtifactInspectionRequest,
  ArtifactRef,
  HubStateDocument
} from '../core/use-case-plan-types.js'

const SAFE_SEGMENT = /^(?!\.{1,2}$)(?!\s)(?!.*\s$)[^\\/:*?"<>|\u0000-\u001f\u007f]+$/
const SAFE_RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function validateSegments(segments: readonly string[], allowEmpty: boolean): void {
  if ((!allowEmpty && segments.length === 0) || segments.some((segment) => !SAFE_SEGMENT.test(segment))) {
    throw new Error('artifact reference has unsafe path segments')
  }
}

function createReferenceResolver(context: LocalHostContext) {
  function resolve(ref: ArtifactRef, options: { allowMissingRoot?: boolean } = {}): string {
    const base = ref.scope === 'hub' ? context.path.resolve(context.hubRoot) : context.path.resolve(ref.worktree)
    validateSegments(ref.segments, ref.scope === 'worktree')
    const target = context.path.resolve(base, ...ref.segments)
    if (!context.path.isSameOrInside(base, target)) throw new Error('artifact reference escapes its root')

    const realBase = context.fs.realpath(base)
    if (!realBase) {
      if (options.allowMissingRoot) return target
      throw new Error('artifact reference root does not exist')
    }
    // The final node may intentionally be a managed link outside this root.
    // Only ancestors must remain contained; effects operate on the link node,
    // never on a path beneath an unchecked link.
    let existing = context.link.samePath(target, base) ? target : context.path.dirname(target)
    while (!context.fs.exists(existing)
      && !context.fs.isSymbolicLink?.(existing)
      && !context.link.samePath(existing, base)) {
      const parent = context.path.dirname(existing)
      if (context.link.samePath(parent, existing)) break
      existing = parent
    }
    if (context.fs.isSymbolicLink?.(existing) && !context.fs.realpath(existing)) {
      throw new Error('artifact reference crosses a dangling linked ancestor')
    }
    const realExisting = context.fs.realpath(existing)
    if (!realExisting) throw new Error('artifact reference ancestor cannot be resolved')
    if (!context.path.isSameOrInside(realBase, realExisting)) {
      throw new Error('artifact reference crosses a linked ancestor')
    }
    return target
  }
  return resolve
}

function createStateRepository(context: LocalHostContext): HubStateRepositoryPort {
  const resolve = createReferenceResolver(context)
  const fixedFile = (segments: readonly string[]) => {
    const target = resolve({ scope: 'hub', segments })
    if (context.fs.isSymbolicLink?.(target)) throw new Error('repository file must not be a link')
    return target
  }
  return {
    readState() {
      const raw = context.persist.readState(fixedFile(['skill-review', 'state.json']))
      const last = raw.lastIngest
      return {
        version: raw.version,
        items: (raw.items || []).map((item) => {
          const { suggestion, ...rest } = item
          return suggestion ? { ...rest, suggestion: { ...suggestion } } : rest
        }),
        lastIngest: last &&
          typeof last.ref === 'string' &&
          typeof last.old === 'string' &&
          typeof last.new === 'string' &&
          typeof last.gameRepo === 'string'
          ? { ref: last.ref, old: last.old, new: last.new, gameRepo: last.gameRepo }
          : null
      }
    },
    writeState(state) {
      context.persist.writeState(fixedFile(['skill-review', 'state.json']), {
        version: state.version,
        items: state.items.map((item) => {
          const { suggestion, ...rest } = item
          return suggestion ? { ...rest, suggestion: { ...suggestion } } : rest
        }),
        lastIngest: state.lastIngest ? { ...state.lastIngest } : null
      })
    },
    appendHistory(write) {
      if (!SAFE_RECORD_ID.test(write.id)) throw new Error('history id is unsafe')
      context.persist.writeJson(
        fixedFile(['skill-review', 'history', `${write.id}.json`]),
        write.record
      )
    },
    configuredGameRepo() {
      return context.git.configGet(context.hubRoot, 'ozdqp.gameRepo')
    },
    listAttachedWorktrees() {
      const unique: string[] = []
      for (const candidate of context.persist.readList(fixedFile(['overlay', 'attached-worktrees.txt']))) {
        if (!unique.some((existing) => context.link.samePath(existing, candidate))) unique.push(candidate)
      }
      return unique
    }
  }
}

function createGitFacts(context: LocalHostContext): GitFactsPort {
  return {
    revisionExists(repo, revision) {
      if (!revision.trim()) return false
      return Boolean(context.git.output(repo, ['rev-parse', '--verify', `${revision}^{commit}`]).trim())
    },
    changedPaths(input) {
      const text = context.git.output(input.repo, [
        '-c',
        'core.quotepath=false',
        'diff',
        '--name-status',
        '--find-renames',
        input.oldRevision,
        input.newRevision,
        '--',
        ...input.pathspecs
      ])
      const changes = []
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        const parts = line.split('\t')
        if (parts.length < 2) continue
        const status = parts[0]
        if ((status.startsWith('R') || status.startsWith('C')) && parts.length >= 3) {
          changes.push({ status, previousPath: parts[1], path: parts[parts.length - 1] })
        } else {
          changes.push({ status, path: parts[1] })
        }
      }
      return changes
    },
    readTree(input) {
      const files = context.git.output(input.repo, [
        '-c',
        'core.quotepath=false',
        'ls-tree',
        '-r',
        '--name-only',
        input.revision,
        '--',
        input.prefix
      ]).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      return files.map((file) => ({
        path: file.slice(input.prefix.length).replace(/^[/\\]+/, '') || context.path.basename(file),
        content: context.git.output(input.repo, ['show', `${input.revision}:${file}`])
      }))
    },
    readBlob(input) {
      const found = context.git.output(input.repo, [
        '-c',
        'core.quotepath=false',
        'ls-tree',
        '--name-only',
        input.revision,
        '--',
        input.path
      ]).split(/\r?\n/).some((line) => line.trim() === input.path)
      return found ? context.git.output(input.repo, ['show', `${input.revision}:${input.path}`]) : null
    }
  }
}

function createArtifactPort(context: LocalHostContext): ArtifactFactsEffectPort {
  const resolve = createReferenceResolver(context)

  function inspectOne(request: ArtifactInspectionRequest): ArtifactFact {
    const target = resolve(request.target, { allowMissingRoot: true })
    const exists = context.fs.exists(target)
    let actualKind: ArtifactFact['actualKind']
    if (exists) {
      if (context.fs.isSymbolicLink?.(target)) actualKind = 'link'
      else if (context.fs.isDirectory(target)) actualKind = 'directory'
      else if (context.fs.isFile(target)) actualKind = 'file'
      else actualKind = 'link'
    }
    const expected = request.expectedSource ? resolve(request.expectedSource) : undefined
    const linkedToExpected = expected && exists ? context.link.isLinked(target, expected) : undefined
    return {
      key: request.key,
      exists,
      actualKind,
      linkedToExpected,
      pointsElsewhere: exists && actualKind === 'link' ? !linkedToExpected : undefined
    }
  }

  function applyOne(effect: ArtifactEffect): void {
    if (effect.kind === 'remove') {
      context.fs.remove(resolve(effect.target))
      return
    }
    if (effect.kind === 'move') {
      const source = resolve(effect.source)
      const target = resolve(effect.target)
      if (!context.fs.exists(source) || context.fs.isSymbolicLink?.(source)) {
        throw new Error('move source changed before apply')
      }
      if (context.fs.exists(target) || context.fs.isSymbolicLink?.(target)) {
        throw new Error('move target changed before apply')
      }
      context.fs.mkdirp(context.path.dirname(target))
      context.fs.rename(source, target)
      return
    }
    if (effect.kind === 'link') {
      const source = resolve(effect.source)
      const target = resolve(effect.target)
      if (!context.fs.exists(source) || context.fs.isSymbolicLink?.(source)) {
        throw new Error('link source changed before apply')
      }
      if (context.fs.exists(target) || context.fs.isSymbolicLink?.(target)) {
        throw new Error('link target changed before apply')
      }
      if (effect.artifactKind === 'directory') context.link.linkDirectory(target, source)
      else context.link.linkFile(target, source)
      return
    }
    if (effect.kind === 'unlink') {
      context.link.unlink(resolve(effect.target))
      return
    }

    const target = resolve(effect.target)
    if (context.fs.exists(target)) context.fs.remove(target)
    context.fs.mkdirp(target)
    for (const file of effect.files) {
      validateSegments(file.segments, false)
      const destination = context.path.resolve(target, ...file.segments)
      if (!context.path.isSameOrInside(target, destination)) throw new Error('replacement file escapes target')
      context.fs.writeText(destination, file.content)
    }
  }

  return {
    inspect(requests) {
      return requests.map(inspectOne)
    },
    apply(effects) {
      for (const effect of effects) applyOne(effect)
    }
  }
}

export function createLocalUseCasePorts(context: LocalHostContext): SharedUseCasePorts {
  return {
    state: createStateRepository(context),
    git: createGitFacts(context),
    artifacts: createArtifactPort(context)
  }
}
