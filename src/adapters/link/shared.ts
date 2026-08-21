import fs from 'node:fs'
import path from 'node:path'
import type { FsPort, LinkPort, PathPort } from '../host-context.js'

export function createSharedLinkPort(
  fsPort: FsPort,
  pathApi: PathPort,
  options: { foldCase: boolean; platform: 'win32' | 'posix' }
): LinkPort {
  const fold = (value: string) => (options.foldCase ? pathApi.resolve(value).toLowerCase() : pathApi.resolve(value))

  const existsHere = (target: string) => {
    try {
      fs.lstatSync(target)
      return true
    } catch {
      return false
    }
  }

  const port: LinkPort = {
    samePath(left, right) {
      return fold(left) === fold(right)
    },
    isLinked(linkPath, expected) {
      const real = fsPort.realpath(linkPath)
      if (real && fold(real) === fold(expected)) return true
      const left = fsPort.statId(linkPath)
      const right = fsPort.statId(expected)
      return Boolean(left && right && left.ino && right.ino && left.ino === right.ino && left.dev === right.dev)
    },
    linkDirectory(linkPath, target) {
      if (port.isLinked(linkPath, target)) return
      if (existsHere(linkPath)) throw new Error(`refusing to replace existing path: ${linkPath}`)
      fs.mkdirSync(path.dirname(linkPath), { recursive: true })
      const abs = path.resolve(target)
      if (options.platform === 'win32') {
        fs.symlinkSync(abs, linkPath, 'junction')
        return
      }
      fs.symlinkSync(abs, linkPath)
    },
    linkFile(linkPath, target) {
      if (port.isLinked(linkPath, target)) return
      if (existsHere(linkPath)) throw new Error(`refusing to replace existing path: ${linkPath}`)
      fs.mkdirSync(path.dirname(linkPath), { recursive: true })
      const abs = path.resolve(target)
      try {
        if (options.platform === 'win32') fs.symlinkSync(abs, linkPath, 'file')
        else fs.symlinkSync(abs, linkPath)
      } catch (error) {
        if (options.platform === 'win32') {
          fs.linkSync(abs, linkPath)
          return
        }
        throw error
      }
    },
    unlink(linkPath) {
      let stat: fs.Stats
      try {
        stat = fs.lstatSync(linkPath)
      } catch {
        return
      }
      if (stat.isSymbolicLink() || stat.isFile()) {
        fs.unlinkSync(linkPath)
        return
      }
      if (stat.isDirectory()) {
        fs.rmdirSync(linkPath)
      }
    }
  }
  return port
}
