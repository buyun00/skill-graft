import type { FsPort, LinkPort, PathPort } from '../host-context.js'
import { createSharedLinkPort } from './shared.js'

export function createPosixLinkPort(fs: FsPort, pathApi: PathPort, options?: { foldCase?: boolean }): LinkPort {
  return createSharedLinkPort(fs, pathApi, { foldCase: Boolean(options?.foldCase), platform: 'posix' })
}
