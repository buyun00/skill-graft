import path from 'node:path'
import type { PathPort } from '../core/ports.js'

export function createNodePath(): PathPort {
  return {
    join: (...parts) => path.join(...parts),
    resolve: (...parts) => path.resolve(...parts),
    dirname: (value) => path.dirname(value),
    basename: (value) => path.basename(value)
  }
}
