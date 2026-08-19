import fs from 'node:fs'
import path from 'node:path'
import type { DirEntry, FileId, FsPort } from '../core/ports.js'

export function createNodeFs(): FsPort {
  return {
    exists(target) {
      return fs.existsSync(target)
    },
    isDirectory(target) {
      try {
        return fs.statSync(target).isDirectory()
      } catch {
        return false
      }
    },
    isFile(target) {
      try {
        return fs.statSync(target).isFile()
      } catch {
        return false
      }
    },
    readDir(target) {
      return fs.readdirSync(target, { withFileTypes: true }).map((entry): DirEntry => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isSymbolicLink: entry.isSymbolicLink()
      }))
    },
    readText(target) {
      if (!fs.existsSync(target)) return null
      return fs.readFileSync(target, 'utf8')
    },
    writeText(target, contents) {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, contents, 'utf8')
    },
    mkdirp(target) {
      fs.mkdirSync(target, { recursive: true })
    },
    remove(target) {
      fs.rmSync(target, { recursive: true, force: true })
    },
    rename(from, to) {
      fs.mkdirSync(path.dirname(to), { recursive: true })
      fs.renameSync(from, to)
    },
    statMtimeMs(target) {
      try {
        return fs.statSync(target).mtimeMs || 0
      } catch {
        return 0
      }
    },
    statId(target) {
      try {
        const stat = fs.statSync(target)
        const id: FileId = { ino: Number(stat.ino), dev: Number(stat.dev) }
        return id
      } catch {
        return null
      }
    },
    realpath(target) {
      try {
        return fs.realpathSync(target)
      } catch {
        return null
      }
    }
  }
}
