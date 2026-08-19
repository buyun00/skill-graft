import type { HubContext } from '../core/ports.js'
import { createLinkPort } from './link/index.js'
import { createNodeFs } from './node-fs.js'
import { createNodeGit } from './node-git.js'
import { createNodePath } from './node-path.js'
import { createNodePersist } from './node-persist.js'

export function createHub(
  hubRoot: string,
  overrides: Partial<Pick<HubContext, 'fs' | 'git' | 'link' | 'persist' | 'path'>> = {}
): HubContext {
  const pathApi = overrides.path ?? createNodePath()
  const fs = overrides.fs ?? createNodeFs()
  return {
    hubRoot: pathApi.resolve(hubRoot),
    path: pathApi,
    fs,
    git: overrides.git ?? createNodeGit(),
    persist: overrides.persist ?? createNodePersist(fs),
    link: overrides.link ?? createLinkPort(fs, pathApi)
  }
}
