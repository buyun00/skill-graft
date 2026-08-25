import type { FsPort, LinkPort, PathPort } from '../host-context.js'
import { createPosixLinkPort } from './posix.js'
import { createWinLinkPort } from './win.js'

export function createLinkPort(
  fs: FsPort,
  pathApi: PathPort,
  platform = process.platform
): LinkPort {
  if (platform === 'win32') return createWinLinkPort(fs, pathApi)
  if (platform === 'darwin') return createPosixLinkPort(fs, pathApi, { foldCase: true })
  return createPosixLinkPort(fs, pathApi)
}
