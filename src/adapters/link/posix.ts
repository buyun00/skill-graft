import type { FsPort, LinkPort, PathPort } from '../../core/ports.js'
import { createSharedLinkPort } from './shared.js'

export function createPosixLinkPort(fs: FsPort, pathApi: PathPort, options?: { foldCase?: boolean }): LinkPort {
  return createSharedLinkPort(fs, pathApi, { foldCase: Boolean(options?.foldCase) })
}
