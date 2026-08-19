import { spawnSync } from 'node:child_process'
import type { GitPort } from '../core/ports.js'

function gitOut(cwd: string, args: string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) return ''
  return result.stdout || ''
}

export function createNodeGit(): GitPort {
  return {
    configGet(cwd, key) {
      const value = gitOut(cwd, ['config', '--get', key]).trim()
      return value || null
    },
    output(cwd, args) {
      return gitOut(cwd, args)
    }
  }
}
