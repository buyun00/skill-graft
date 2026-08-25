import { EPHEMERAL_PATH_MARKERS, EXCLUDED_CHECKOUT_NAMES } from './constants.js'

export type GitWorktreeFact = {
  path: string
  branch: string
  head: string
  locked: boolean
  prunable: boolean
}

export type CheckoutRules = {
  exclude: readonly string[]
  require: readonly string[]
  paths: readonly string[]
}

export function isEphemeralPath(dir: string): boolean {
  const normalized = dir.replaceAll('\\', '/').toLowerCase()
  return EPHEMERAL_PATH_MARKERS.some((marker) => normalized.includes(marker))
}

export function parseCheckoutRules(text: string | null): CheckoutRules {
  const defaults: CheckoutRules = {
    exclude: [...EXCLUDED_CHECKOUT_NAMES],
    require: ['AGENTS.md', 'baloot_client'],
    paths: []
  }
  if (text == null) return defaults
  const exclude: string[] = [...EXCLUDED_CHECKOUT_NAMES]
  const require: string[] = []
  const paths: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const space = line.indexOf(' ')
    const key = (space < 0 ? line : line.slice(0, space)).toLowerCase()
    const value = (space < 0 ? '' : line.slice(space + 1)).trim()
    if (!value) continue
    if (key === 'exclude') exclude.push(value)
    else if (key === 'require') require.push(value)
    else if (key === 'path') paths.push(value)
  }
  if (require.length === 0 && paths.length === 0) require.push(...defaults.require)
  return { exclude, require, paths }
}

export function parseWorktreePorcelain(text: string): GitWorktreeFact[] {
  const trees: GitWorktreeFact[] = []
  let current: Partial<GitWorktreeFact> & { detached?: boolean } = {}
  const flush = () => {
    if (!current.path) return
    trees.push({
      path: current.path,
      branch: current.branch || (current.detached ? '(detached)' : ''),
      head: current.head || '',
      locked: Boolean(current.locked),
      prunable: Boolean(current.prunable)
    })
    current = {}
  }
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      flush()
      current.path = line.slice(9)
    } else if (line.startsWith('HEAD ')) current.head = line.slice(5)
    else if (line.startsWith('branch ')) current.branch = line.slice(7).replace('refs/heads/', '')
    else if (line === 'detached') current.detached = true
    else if (line.startsWith('locked')) current.locked = true
    else if (line.startsWith('prunable')) current.prunable = true
    else if (line === '') flush()
  }
  flush()
  return trees
}
