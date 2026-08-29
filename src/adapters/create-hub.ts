import type { LocalHostContext } from './host-context.js'
import { createLinkPort } from './link/index.js'
import { createNodeFs } from './node-fs.js'
import { createNodeGit } from './node-git.js'
import { createNodePath } from './node-path.js'
import { createNodePersist } from './node-persist.js'
import { createNodeClock, createNodeHash, createNodeIds } from './node-runtime.js'

export function createHub(
  hubRoot: string,
  overrides: Partial<Pick<LocalHostContext, 'fs' | 'git' | 'link' | 'persist' | 'path' | 'clock' | 'ids' | 'hash'>> = {}
): LocalHostContext {
  const pathApi = overrides.path ?? createNodePath()
  const fs = overrides.fs ?? createNodeFs()
  return {
    hubRoot: pathApi.resolve(hubRoot),
    path: pathApi,
    fs,
    git: overrides.git ?? createNodeGit(),
    persist: overrides.persist ?? createNodePersist(fs),
    link: overrides.link ?? createLinkPort(fs, pathApi),
    clock: overrides.clock ?? createNodeClock(),
    ids: overrides.ids ?? createNodeIds(),
    hash: overrides.hash ?? createNodeHash()
  }
}
