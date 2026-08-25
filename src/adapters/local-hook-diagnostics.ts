import { createHash, randomBytes as systemRandomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const LOCAL_HOOK_DIAGNOSTIC_SCHEMA = 'skill-graft.hook-diagnostic.v1' as const
export const LOCAL_HOOK_DIAGNOSTIC_SCHEMA_VERSION = 1 as const
export const LOCAL_HOOK_DIAGNOSTIC_GIT_PATH = 'skill-graft/hook-diagnostics-v1' as const
export const LOCAL_HOOK_DIAGNOSTIC_MAX_RECORDS = 32
export const LOCAL_HOOK_DIAGNOSTIC_MAX_TOTAL_BYTES = 64 * 1024

const MAX_RECORD_BYTES = 1024
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,159}$/u
const REQUEST_ID_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u
const OWNED_FILE_PATTERN = /^diag-[0-9]{13}-[a-f0-9]{16}\.json$/u
const HOOKS = new Set<LocalHookDiagnosticHook>(['post-checkout', 'reference-transaction'])
const PHASES = new Set<LocalHookDiagnosticPhase>(['launch', 'command'])
const CODES = new Set<LocalHookDiagnosticCode>([
  'NODE_UNAVAILABLE',
  'CLI_MISSING',
  'COMMAND_FAILED'
])

export type LocalHookDiagnosticHook = 'post-checkout' | 'reference-transaction'
export type LocalHookDiagnosticPhase = 'launch' | 'command'
export type LocalHookDiagnosticCode = 'NODE_UNAVAILABLE' | 'CLI_MISSING' | 'COMMAND_FAILED'

export type LocalHookDiagnosticRecordV1 = Readonly<{
  schema: typeof LOCAL_HOOK_DIAGNOSTIC_SCHEMA
  schemaVersion: typeof LOCAL_HOOK_DIAGNOSTIC_SCHEMA_VERSION
  at: string
  hook: LocalHookDiagnosticHook
  phase: LocalHookDiagnosticPhase
  code: LocalHookDiagnosticCode
  exitCode: number | null
  requestIdHash: `sha256:${string}` | null
}>

export type RecordLocalHookDiagnosticInput = Readonly<{
  /** Used only to locate the per-worktree Git admin directory; never persisted. */
  worktree: string
  hook: LocalHookDiagnosticHook
  phase: LocalHookDiagnosticPhase
  code: LocalHookDiagnosticCode
  exitCode?: number | null
  /** Hashed in memory before the record is serialized. */
  requestId?: string | null
}>

export type LocalHookDiagnosticWriteResult =
  | Readonly<{ status: 'recorded'; record: LocalHookDiagnosticRecordV1 }>
  | Readonly<{
      status: 'refused'
      reason: 'invalid-input' | 'not-worktree' | 'unsafe-git-admin' | 'unsafe-diagnostics-root' | 'io-failed'
    }>

export type LocalHookDiagnosticReadResult =
  | Readonly<{ status: 'ok'; records: readonly LocalHookDiagnosticRecordV1[] }>
  | Readonly<{
      status: 'refused'
      reason: 'not-worktree' | 'unsafe-git-admin' | 'unsafe-diagnostics-root' | 'io-failed'
    }>

export type LocalHookDiagnosticAdapter = Readonly<{
  record(input: RecordLocalHookDiagnosticInput): LocalHookDiagnosticWriteResult
  list(worktree: string): LocalHookDiagnosticReadResult
}>

export type LocalHookDiagnosticDependencies = Readonly<{
  environment?: NodeJS.ProcessEnv
  nowIso?: () => string
  randomBytes?: (size: number) => Buffer
}>

type GitAdminLayout = Readonly<{
  adminRoot: string
  canonicalAdminRoot: string
  diagnosticsRoot: string
}>

type GitAdminLayoutResult =
  | Readonly<{ status: 'ok'; layout: GitAdminLayout }>
  | Readonly<{ status: 'refused'; reason: 'not-worktree' | 'unsafe-git-admin' }>

type OwnedRecordFile = Readonly<{
  name: string
  absolute: string
  bytes: number
  record: LocalHookDiagnosticRecordV1
}>

class UnsafeDiagnosticDirectoryError extends Error {}

function comparable(target: string): string {
  const resolved = path.resolve(target).replace(/[\\/]+$/u, '') || path.parse(path.resolve(target)).root
  return process.platform === 'win32' || process.platform === 'darwin'
    ? resolved.normalize('NFC').toLocaleLowerCase('en-US')
    : resolved
}

function samePath(left: string, right: string): boolean {
  return comparable(left) === comparable(right)
}

function sameOrInside(root: string, target: string): boolean {
  const relation = path.relative(comparable(root), comparable(target))
  return relation === '' || (
    relation !== '..'
    && !relation.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relation)
  )
}

function sanitizedGitEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([name]) => (
    !name.toLocaleUpperCase('en-US').startsWith('GIT_')
  ))) as NodeJS.ProcessEnv
}

function singleGitPath(worktree: string, args: readonly string[], environment: NodeJS.ProcessEnv): string | null {
  const result = spawnSync('git', ['-C', worktree, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: environment,
    maxBuffer: 64 * 1024
  })
  if (result.status !== 0 || result.error) return null
  const output = String(result.stdout || '').trim()
  if (!output || output.includes('\0') || output.includes('\n') || output.includes('\r')) return null
  return path.resolve(output)
}

function gitAdminLayout(worktree: string, sourceEnvironment: NodeJS.ProcessEnv): GitAdminLayoutResult {
  if (typeof worktree !== 'string' || !worktree || worktree !== worktree.trim() || worktree.includes('\0')) {
    return { status: 'refused', reason: 'not-worktree' }
  }
  const environment = sanitizedGitEnvironment(sourceEnvironment)
  const adminRoot = singleGitPath(worktree, ['rev-parse', '--absolute-git-dir'], environment)
  const diagnosticsRoot = singleGitPath(
    worktree,
    ['rev-parse', '--path-format=absolute', '--git-path', LOCAL_HOOK_DIAGNOSTIC_GIT_PATH],
    environment
  )
  if (!adminRoot || !diagnosticsRoot) return { status: 'refused', reason: 'not-worktree' }
  const expected = path.resolve(adminRoot, ...LOCAL_HOOK_DIAGNOSTIC_GIT_PATH.split('/'))
  if (!samePath(expected, diagnosticsRoot)) return { status: 'refused', reason: 'unsafe-git-admin' }
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(adminRoot)
  } catch {
    return { status: 'refused', reason: 'unsafe-git-admin' }
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return { status: 'refused', reason: 'unsafe-git-admin' }
  let canonicalAdminRoot: string
  try {
    canonicalAdminRoot = fs.realpathSync.native(adminRoot)
  } catch {
    return { status: 'refused', reason: 'unsafe-git-admin' }
  }
  return { status: 'ok', layout: { adminRoot, canonicalAdminRoot, diagnosticsRoot } }
}

function assertPlainOwnedDirectory(layout: GitAdminLayout, target: string): void {
  if (!sameOrInside(layout.adminRoot, target)) throw new Error('outside-git-admin')
  const relation = path.relative(layout.adminRoot, target)
  let cursor = layout.adminRoot
  for (const part of relation.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part)
    try {
      fs.mkdirSync(cursor, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const stat = fs.lstatSync(cursor)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('linked-diagnostics-directory')
    const canonical = fs.realpathSync.native(cursor)
    if (!sameOrInside(layout.canonicalAdminRoot, canonical)) throw new Error('escaped-git-admin')
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function hasValidDiagnosticSemantics(phase: unknown, code: unknown, exitCode: unknown): boolean {
  if (phase === 'launch') {
    return (code === 'NODE_UNAVAILABLE' || code === 'CLI_MISSING') && exitCode === null
  }
  return phase === 'command'
    && code === 'COMMAND_FAILED'
    && Number.isInteger(exitCode)
    && Number(exitCode) > 0
    && Number(exitCode) <= 255
}

export function isLocalHookDiagnosticRecord(value: unknown): value is LocalHookDiagnosticRecordV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (!exactKeys(record, [
    'schema',
    'schemaVersion',
    'at',
    'hook',
    'phase',
    'code',
    'exitCode',
    'requestIdHash'
  ])) return false
  if (record.schema !== LOCAL_HOOK_DIAGNOSTIC_SCHEMA
    || record.schemaVersion !== LOCAL_HOOK_DIAGNOSTIC_SCHEMA_VERSION
    || typeof record.at !== 'string'
    || !HOOKS.has(record.hook as LocalHookDiagnosticHook)
    || !PHASES.has(record.phase as LocalHookDiagnosticPhase)
    || !CODES.has(record.code as LocalHookDiagnosticCode)) return false
  try {
    if (new Date(record.at).toISOString() !== record.at) return false
  } catch {
    return false
  }
  if (!hasValidDiagnosticSemantics(record.phase, record.code, record.exitCode)) return false
  return record.requestIdHash === null || (
    typeof record.requestIdHash === 'string' && REQUEST_ID_HASH_PATTERN.test(record.requestIdHash)
  )
}

function readOwnedRecord(file: string, name: string): OwnedRecordFile | null {
  if (!OWNED_FILE_PATTERN.test(name)) return null
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(file)
  } catch {
    return null
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_RECORD_BYTES) return null
  let value: unknown
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  if (!isLocalHookDiagnosticRecord(value)) return null
  return { name, absolute: file, bytes: stat.size, record: value }
}

function ownedRecords(layout: GitAdminLayout): OwnedRecordFile[] {
  const rootStat = fs.lstatSync(layout.diagnosticsRoot)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new UnsafeDiagnosticDirectoryError('unsafe-diagnostics-root')
  }
  const canonical = fs.realpathSync.native(layout.diagnosticsRoot)
  if (!sameOrInside(layout.canonicalAdminRoot, canonical)) {
    throw new UnsafeDiagnosticDirectoryError('escaped-diagnostics-root')
  }
  const records: OwnedRecordFile[] = []
  for (const name of fs.readdirSync(layout.diagnosticsRoot)) {
    if (!OWNED_FILE_PATTERN.test(name)) throw new UnsafeDiagnosticDirectoryError('unknown-diagnostic-entry')
    const record = readOwnedRecord(path.join(layout.diagnosticsRoot, name), name)
    if (!record) throw new UnsafeDiagnosticDirectoryError('invalid-diagnostic-entry')
    records.push(record)
  }
  return records.sort((left, right) => left.name.localeCompare(right.name, 'en-US'))
}

function pruneOwnedRecords(layout: GitAdminLayout, reserveBytes: number): void {
  const records = ownedRecords(layout)
  let totalBytes = records.reduce((sum, record) => sum + record.bytes, 0)
  const reservedRecords = reserveBytes > 0 ? 1 : 0
  while (records.length + reservedRecords > LOCAL_HOOK_DIAGNOSTIC_MAX_RECORDS
    || totalBytes + reserveBytes > LOCAL_HOOK_DIAGNOSTIC_MAX_TOTAL_BYTES) {
    const oldest = records.shift()
    if (!oldest) throw new Error('diagnostic-bound-unavailable')
    const current = readOwnedRecord(oldest.absolute, oldest.name)
    if (!current) throw new UnsafeDiagnosticDirectoryError('diagnostic-changed-before-prune')
    fs.unlinkSync(oldest.absolute)
    totalBytes -= oldest.bytes
  }
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined
  try {
    descriptor = fs.openSync(directory, 'r')
    fs.fsyncSync(descriptor)
  } catch {
    // Some Windows filesystems do not expose directory handles to fsync. The
    // unique-file protocol remains fail-closed and bounded without this hint.
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch { /* best effort */ }
    }
  }
}

function safeNow(nowIso: () => string): string {
  const candidate = nowIso()
  return new Date(candidate).toISOString()
}

function requestIdHash(requestId: string | null | undefined): `sha256:${string}` | null {
  if (requestId == null) return null
  if (!REQUEST_ID_PATTERN.test(requestId)) throw new Error('invalid-request-id')
  return `sha256:${createHash('sha256').update(requestId, 'utf8').digest('hex')}`
}

function validInput(input: RecordLocalHookDiagnosticInput): boolean {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false
  if (!exactKeys(input as unknown as Record<string, unknown>, [
    'worktree',
    'hook',
    'phase',
    'code',
    ...(Object.prototype.hasOwnProperty.call(input, 'exitCode') ? ['exitCode'] : []),
    ...(Object.prototype.hasOwnProperty.call(input, 'requestId') ? ['requestId'] : [])
  ])) return false
  if (typeof input.worktree !== 'string' || !input.worktree || input.worktree !== input.worktree.trim()) return false
  if (!HOOKS.has(input.hook) || !PHASES.has(input.phase) || !CODES.has(input.code)) return false
  if (!hasValidDiagnosticSemantics(input.phase, input.code, input.exitCode ?? null)) return false
  return input.requestId === undefined || input.requestId === null || (
    typeof input.requestId === 'string' && REQUEST_ID_PATTERN.test(input.requestId)
  )
}

export function createLocalHookDiagnosticAdapter(
  dependencies: LocalHookDiagnosticDependencies = {}
): LocalHookDiagnosticAdapter {
  const sourceEnvironment = dependencies.environment ?? process.env
  const nowIso = dependencies.nowIso ?? (() => new Date().toISOString())
  const randomBytes = dependencies.randomBytes ?? systemRandomBytes

  return Object.freeze({
    record(input: RecordLocalHookDiagnosticInput): LocalHookDiagnosticWriteResult {
      if (!validInput(input)) return { status: 'refused', reason: 'invalid-input' }
      const resolved = gitAdminLayout(input.worktree, sourceEnvironment)
      if (resolved.status === 'refused') return resolved
      const layout = resolved.layout
      try {
        assertPlainOwnedDirectory(layout, layout.diagnosticsRoot)
      } catch {
        return { status: 'refused', reason: 'unsafe-diagnostics-root' }
      }
      let record: LocalHookDiagnosticRecordV1
      let payload: Buffer
      let unique: string
      try {
        const at = safeNow(nowIso)
        record = Object.freeze({
          schema: LOCAL_HOOK_DIAGNOSTIC_SCHEMA,
          schemaVersion: LOCAL_HOOK_DIAGNOSTIC_SCHEMA_VERSION,
          at,
          hook: input.hook,
          phase: input.phase,
          code: input.code,
          exitCode: input.exitCode ?? null,
          requestIdHash: requestIdHash(input.requestId)
        })
        payload = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8')
        if (payload.byteLength <= 0 || payload.byteLength > MAX_RECORD_BYTES) {
          return { status: 'refused', reason: 'invalid-input' }
        }
        unique = randomBytes(8).toString('hex')
        if (!/^[a-f0-9]{16}$/u.test(unique)) return { status: 'refused', reason: 'io-failed' }
      } catch {
        return { status: 'refused', reason: 'invalid-input' }
      }

      const stamp = String(Date.parse(record.at)).padStart(13, '0')
      const fileName = `diag-${stamp}-${unique}.json`
      const finalFile = path.join(layout.diagnosticsRoot, fileName)
      const pendingFile = path.join(layout.diagnosticsRoot, `.pending-${stamp}-${unique}.tmp`)
      let descriptor: number | undefined
      try {
        pruneOwnedRecords(layout, payload.byteLength)
        assertPlainOwnedDirectory(layout, layout.diagnosticsRoot)
        descriptor = fs.openSync(pendingFile, 'wx', 0o600)
        fs.writeFileSync(descriptor, payload)
        fs.fsyncSync(descriptor)
        fs.closeSync(descriptor)
        descriptor = undefined
        assertPlainOwnedDirectory(layout, layout.diagnosticsRoot)
        fs.renameSync(pendingFile, finalFile)
        fsyncDirectory(layout.diagnosticsRoot)
        pruneOwnedRecords(layout, 0)
        return { status: 'recorded', record }
      } catch (error) {
        return {
          status: 'refused',
          reason: error instanceof UnsafeDiagnosticDirectoryError ? 'unsafe-diagnostics-root' : 'io-failed'
        }
      } finally {
        if (descriptor !== undefined) {
          try { fs.closeSync(descriptor) } catch { /* best effort */ }
        }
        try { fs.unlinkSync(pendingFile) } catch { /* already published or absent */ }
      }
    },

    list(worktree: string): LocalHookDiagnosticReadResult {
      const resolved = gitAdminLayout(worktree, sourceEnvironment)
      if (resolved.status === 'refused') return resolved
      const layout = resolved.layout
      if (!fs.existsSync(layout.diagnosticsRoot)) return { status: 'ok', records: [] }
      try {
        const records = ownedRecords(layout).map((entry) => entry.record)
        return { status: 'ok', records }
      } catch {
        return { status: 'refused', reason: 'unsafe-diagnostics-root' }
      }
    }
  })
}
