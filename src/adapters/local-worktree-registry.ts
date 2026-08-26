import type {
  WorktreeRegistryInvalidReason,
  WorktreeRegistryPort,
  WorktreeRegistryResult
} from '../application/ports.js'
import { parseCheckoutRules } from '../core/worktree-facts.js'
import type { LocalHostContext } from './host-context.js'

const REGISTRY_FILE = 'skill-review/worktree-registry.json'
const REGISTRY_SCHEMA_VERSION = 1
const MAX_WORKTREES = 128
const MAX_PATH_LENGTH = 8_192

type WorktreeRegistry = {
  schemaVersion: 1
  worktrees: string[]
}

const emptyRegistry = (): WorktreeRegistry => ({
  schemaVersion: REGISTRY_SCHEMA_VERSION,
  worktrees: []
})

function registryFile(context: LocalHostContext): string {
  return context.path.join(context.hubRoot, ...REGISTRY_FILE.split('/'))
}

export function validateWorktreeRegistry(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== REGISTRY_SCHEMA_VERSION
    || !Array.isArray(record.worktrees)
    || record.worktrees.length > MAX_WORKTREES
    || Object.keys(record).some((key) => !['schemaVersion', 'worktrees'].includes(key))) return false
  return record.worktrees.every((entry) => typeof entry === 'string'
    && entry.length > 0
    && entry.length <= MAX_PATH_LENGTH
    && entry === entry.trim()
    && !/[\u0000-\u001f\u007f]/u.test(entry))
}

export function readRegisteredWorktrees(context: LocalHostContext): string[] {
  const value = context.persist.readJson<unknown>(registryFile(context), emptyRegistry())
  if (!validateWorktreeRegistry(value)) throw new Error('worktree registry is invalid')
  const worktrees = (value as WorktreeRegistry).worktrees
  if (!worktrees.every((entry) => context.path.isAbsolute(entry))) {
    throw new Error('worktree registry contains a non-absolute path')
  }
  return [...worktrees]
}

function invalid(reason: WorktreeRegistryInvalidReason): WorktreeRegistryResult {
  return { status: 'invalid', reason }
}

function register(context: LocalHostContext, requestedWorktree: string): WorktreeRegistryResult {
  const input = requestedWorktree.trim()
  if (!input || input.length > MAX_PATH_LENGTH || /[\u0000-\u001f\u007f]/u.test(input)) {
    return invalid('invalid-path')
  }
  if (!context.path.isAbsolute(input)) return invalid('not-absolute')

  const resolved = context.path.resolve(input)
  if (!context.fs.exists(resolved)) return invalid('not-found')
  if (!context.fs.isDirectory(resolved)) return invalid('not-directory')
  const canonical = context.fs.realpath(resolved)
  if (!canonical || !context.path.isAbsolute(canonical)) return invalid('cannot-canonicalize')

  const rawTopLevel = context.git.output(canonical, ['rev-parse', '--show-toplevel']).trim()
  if (!rawTopLevel) return invalid('not-git-worktree')
  const resolvedTopLevel = context.path.resolve(canonical, rawTopLevel)
  const canonicalTopLevel = context.fs.realpath(resolvedTopLevel)
  if (!canonicalTopLevel || !context.link.samePath(canonicalTopLevel, canonical)) {
    return invalid('not-exact-worktree')
  }
  const canonicalHubRoot = context.fs.realpath(context.hubRoot) || context.path.resolve(context.hubRoot)
  if (context.link.samePath(canonicalTopLevel, canonicalHubRoot)) return invalid('hub-root')
  const rules = parseCheckoutRules(
    context.fs.readText(context.path.join(context.hubRoot, 'overlay', 'checkout-rules.txt'))
  )
  const foldedName = context.path.basename(canonicalTopLevel).toLowerCase()
  if (rules.exclude.some((entry) => entry.toLowerCase() === foldedName)
    || foldedName.includes('.partial-')) return invalid('not-recognized')

  const current = readRegisteredWorktrees(context)
  if (current.some((entry) => context.link.samePath(entry, canonicalTopLevel))) {
    return { status: 'registered', worktree: canonicalTopLevel, changed: false }
  }
  if (current.length >= MAX_WORKTREES) return invalid('too-many-worktrees')
  context.persist.writeJson(registryFile(context), {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    worktrees: [...current, canonicalTopLevel]
  } satisfies WorktreeRegistry)
  return { status: 'registered', worktree: canonicalTopLevel, changed: true }
}

export function createLocalWorktreeRegistryPort(context: LocalHostContext): WorktreeRegistryPort {
  return { register: (worktree) => register(context, worktree) }
}
