import type { FsPort, LocalHubStateFile, PersistPort } from './host-context.js'

export function createNodePersist(fs: FsPort): PersistPort {
  return {
    readJson(file, fallback) {
      const text = fs.readText(file)
      if (text === null) return fallback
      return JSON.parse(text) as typeof fallback
    },
    writeJson(file, value) {
      fs.writeText(file, `${JSON.stringify(value, null, 2)}\n`)
    },
    readList(file) {
      const text = fs.readText(file)
      if (text === null) return []
      return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
    },
    readState(file) {
      const text = fs.readText(file)
      if (text === null) return { version: 1, items: [], lastIngest: null }
      return JSON.parse(text) as LocalHubStateFile
    },
    writeState(file, state) {
      fs.writeText(file, `${JSON.stringify(state, null, 2)}\n`)
    }
  }
}
