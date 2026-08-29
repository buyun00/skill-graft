import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const target = path.resolve(packageRoot, 'dist')
if (path.dirname(target) !== packageRoot || path.basename(target) !== 'dist') {
  throw new Error(`refusing to clean unexpected build target: ${target}`)
}
fs.rmSync(target, { recursive: true, force: true })
