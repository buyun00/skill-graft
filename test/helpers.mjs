import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const hubRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const cliPath = path.join(hubRoot, 'dist', 'control', 'cli.js')

export function makeFs(files) {
  const resolveKey = (target) => path.resolve(target)
  return {
    exists: (target) => Object.prototype.hasOwnProperty.call(files, resolveKey(target)),
    isDirectory: (target) => Boolean(files[resolveKey(target)]?.dir),
    isFile: (target) => Boolean(files[resolveKey(target)] && !files[resolveKey(target)].dir),
    readDir: (target) => {
      const rec = files[resolveKey(target)]
      if (rec?.readDirError) throw new Error(rec.readDirError)
      return (rec?.entries || []).map((entry) => ({
        name: entry,
        isDirectory: Boolean(files[path.join(resolveKey(target), entry)]?.dir),
        isSymbolicLink: Boolean(files[path.join(resolveKey(target), entry)]?.symlink)
      }))
    },
    readText: (target) => files[resolveKey(target)]?.text ?? null,
    writeText: (target, contents) => {
      files[resolveKey(target)] = { ...(files[resolveKey(target)] || {}), text: contents }
    },
    mkdirp: (target) => {
      files[resolveKey(target)] = { ...(files[resolveKey(target)] || {}), dir: true }
    },
    remove: (target) => {
      delete files[resolveKey(target)]
    },
    rename: (from, to) => {
      const rec = files[resolveKey(from)]
      delete files[resolveKey(from)]
      if (rec) files[resolveKey(to)] = rec
    },
    statMtimeMs: (target) => files[resolveKey(target)]?.mtimeMs || 0,
    statId: (target) => files[resolveKey(target)]?.id || null,
    realpath: (target) => files[resolveKey(target)]?.real || (files[resolveKey(target)] ? target : null)
  }
}

export function spawnHub(args, options = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    cwd: hubRoot,
    env: { ...process.env, ...(options.env || {}) },
    input: options.input
  })
}
