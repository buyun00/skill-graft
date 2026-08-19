import type { FsPort, LinkPort, PathPort } from '../../core/ports.js'
import { createSharedLinkPort } from './shared.js'

export function createWinLinkPort(fs: FsPort, pathApi: PathPort): LinkPort {
  return createSharedLinkPort(fs, pathApi, { foldCase: true, platform: 'win32' })
}
