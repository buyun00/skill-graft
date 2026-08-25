import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createTemporaryTestHub } from './support/test-hub.mjs'

export const hubRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const cliPath = path.join(hubRoot, 'dist', 'control', 'cli.js')
const temporaryHub = createTemporaryTestHub(hubRoot)
export const testHubRoot = temporaryHub.root
const testProfileRoot = path.dirname(testHubRoot)
const testHome = path.join(testProfileRoot, 'home')
const testAppData = path.join(testProfileRoot, 'appdata')
const testLocalAppData = path.join(testProfileRoot, 'localappdata')
const testDshHome = path.join(testProfileRoot, 'dsh-home')
for (const directory of [testHome, testAppData, testLocalAppData, testDshHome]) {
  fs.mkdirSync(directory, { recursive: true })
}
process.env.HOME = testHome
process.env.USERPROFILE = testHome
process.env.APPDATA = testAppData
process.env.LOCALAPPDATA = testLocalAppData
process.env.DSH_HOME = testDshHome
process.env.HUB_ROOT = testHubRoot
process.env.SKILL_GRAFT_HOME = testHubRoot
process.env.HUB_SPAWN_CODEX = '0'
process.once('exit', () => temporaryHub.cleanup())

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
  const requested = options.env || {}
  const requestedRoot = requested.SKILL_GRAFT_HOME || requested.HUB_ROOT || testHubRoot
  return spawnSync(process.execPath, [options.cliPath || cliPath, ...args], {
    encoding: 'utf8',
    cwd: hubRoot,
    env: {
      ...process.env,
      SKILL_GRAFT_HOME: requestedRoot,
      HUB_ROOT: requestedRoot,
      ...requested,
      HUB_SPAWN_CODEX: '0'
    },
    input: options.input
  })
}
