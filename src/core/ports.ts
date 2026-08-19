import type { HubStateFile } from './types.js'

export type DirEntry = {
  name: string
  isDirectory: boolean
  isSymbolicLink: boolean
}

export type FileId = {
  ino: number
  dev: number
}

export interface PathPort {
  join(...parts: string[]): string
  resolve(...parts: string[]): string
  dirname(value: string): string
  basename(value: string): string
}

export interface FsPort {
  exists(target: string): boolean
  isDirectory(target: string): boolean
  isFile(target: string): boolean
  readDir(target: string): DirEntry[]
  readText(target: string): string | null
  writeText(target: string, contents: string): void
  mkdirp(target: string): void
  remove(target: string): void
  rename(from: string, to: string): void
  statMtimeMs(target: string): number
  statId(target: string): FileId | null
  realpath(target: string): string | null
}

export interface LinkPort {
  samePath(left: string, right: string): boolean
  isLinked(linkPath: string, expected: string): boolean
}

export interface GitPort {
  configGet(cwd: string, key: string): string | null
  output(cwd: string, args: string[]): string
}

export interface PersistPort {
  readJson<T>(file: string, fallback: T): T
  writeJson(file: string, value: unknown): void
  readList(file: string): string[]
  readState(file: string): HubStateFile
  writeState(file: string, state: HubStateFile): void
}

export interface HubContext {
  hubRoot: string
  path: PathPort
  fs: FsPort
  link: LinkPort
  git: GitPort
  persist: PersistPort
}
