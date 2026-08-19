import type { FsPort, LinkPort, PathPort } from '../../core/ports.js'

export function createSharedLinkPort(
  fs: FsPort,
  pathApi: PathPort,
  options: { foldCase: boolean }
): LinkPort {
  const fold = (value: string) => (options.foldCase ? pathApi.resolve(value).toLowerCase() : pathApi.resolve(value))
  return {
    samePath(left, right) {
      return fold(left) === fold(right)
    },
    isLinked(linkPath, expected) {
      const real = fs.realpath(linkPath)
      if (real && fold(real) === fold(expected)) return true
      const left = fs.statId(linkPath)
      const right = fs.statId(expected)
      return Boolean(left && right && left.ino && right.ino && left.ino === right.ino && left.dev === right.dev)
    }
  }
}
