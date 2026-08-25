import type { InboxItemView, LastIngestView } from '../contracts/index.js'

export type DirEntry = {
  name: string
  isDirectory: boolean
  isSymbolicLink: boolean
}

export type FileId = {
  ino: number
  dev: number
}

export type LocalHubStateFile = {
  version?: number
  items?: InboxItemView[]
  lastIngest?: LastIngestView | null
}

export interface PathPort {
  join(...parts: string[]): string
  resolve(...parts: string[]): string
  isAbsolute(value: string): boolean
  dirname(value: string): string
  basename(value: string): string
  /** Platform-aware stable key for comparing host paths; never expose it as a contract path. */
  comparisonKey(value: string): string
  /** True only when target is root itself or a lexical/canonical descendant on this host. */
  isSameOrInside(root: string, target: string): boolean
}

export interface FsPort {
  exists(target: string): boolean
  isDirectory(target: string): boolean
  isFile(target: string): boolean
  isSymbolicLink?(target: string): boolean
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
  linkDirectory(linkPath: string, target: string): void
  linkFile(linkPath: string, target: string): void
  unlink(linkPath: string): void
}

export interface GitPort {
  configGet(cwd: string, key: string): string | null
  output(cwd: string, args: string[]): string
}

export interface PersistPort {
  readJson<T>(file: string, fallback: T): T
  writeJson(file: string, value: unknown): void
  readList(file: string): string[]
  readState(file: string): LocalHubStateFile
  writeState(file: string, state: LocalHubStateFile): void
}

export interface ClockPort {
  nowIso(): string
  nowMs(): number
}

export interface IdPort {
  next(scope: string): string
}

export interface HashPort {
  sha256(value: string): string
}

/** Local/Node composition context. It is intentionally outside shared Core. */
export interface LocalHostContext {
  hubRoot: string
  path: PathPort
  fs: FsPort
  link: LinkPort
  git: GitPort
  persist: PersistPort
  clock: ClockPort
  ids: IdPort
  hash: HashPort
}
