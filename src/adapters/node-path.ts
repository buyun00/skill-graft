import path from 'node:path'
import type { PathPort } from './host-context.js'

export function createNodePath(platform = process.platform): PathPort {
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const foldCase = platform === 'win32' || platform === 'darwin'
  const comparisonKey = (value: string) => {
    const resolved = pathApi.resolve(value)
    const root = pathApi.parse(resolved).root
    const trimmed = resolved === root ? root : resolved.replace(/[\\/]+$/, '')
    return foldCase ? trimmed.toLowerCase() : trimmed
  }
  const isSameOrInside = (root: string, target: string) => {
    const relation = pathApi.relative(comparisonKey(root), comparisonKey(target))
    return relation === '' || (
      relation !== '..'
      && !relation.startsWith(`..${pathApi.sep}`)
      && !pathApi.isAbsolute(relation)
    )
  }
  return {
    join: (...parts) => pathApi.join(...parts),
    resolve: (...parts) => pathApi.resolve(...parts),
    isAbsolute: (value) => pathApi.isAbsolute(value),
    dirname: (value) => pathApi.dirname(value),
    basename: (value) => pathApi.basename(value),
    comparisonKey,
    isSameOrInside
  }
}
