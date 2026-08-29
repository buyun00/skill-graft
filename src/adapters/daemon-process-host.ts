import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { isIP } from 'node:net'
import path from 'node:path'

const SAFE_PROCESS_IDENTITY = /^[A-Za-z0-9:._-]{1,512}$/
const MAX_COMMAND_LINE_BYTES = 1024 * 1024
const MAX_POWERSHELL_OUTPUT_BYTES = 32 * 1024 * 1024

export type DaemonAliveProcessFacts = Readonly<{
  state: 'alive'
  pid: number
  ppid: number
  processIdentity: string
  pgid: number
  commandLine: string
}>

export type DaemonProcessFacts =
  | Readonly<{ state: 'dead' }>
  | Readonly<{ state: 'unknown' }>
  | DaemonAliveProcessFacts

export type DaemonExactProcessTree = Readonly<{
  state: 'exact'
  rootPid: number
  rootProcessIdentity: string
  entries: readonly DaemonAliveProcessFacts[]
}>

export type DaemonProcessTreeFacts =
  | Readonly<{ state: 'unknown' }>
  | DaemonExactProcessTree

export type DaemonListenerBinding = Readonly<{
  family: 'ipv4' | 'ipv6'
  address: string
  port: number
  pid: number
}>

export type DaemonListenerFacts =
  | Readonly<{ state: 'absent' }>
  | Readonly<{ state: 'unknown' }>
  | Readonly<{
      state: 'present'
      pids: readonly number[]
      bindings: readonly DaemonListenerBinding[]
    }>

export type DaemonTreeTerminationResult = Readonly<{
  state: 'signaled' | 'already-exited' | 'unknown'
  pids: readonly number[]
}>

export type DaemonTreeExitWait =
  | Readonly<{ state: 'exited' }>
  | Readonly<{ state: 'timeout'; pids: readonly number[] }>
  | Readonly<{ state: 'unknown'; pids: readonly number[] }>

type PowerShellResult = Readonly<{ status: number; stdout: string; stderr: string }>
type ProviderListResult =
  | Readonly<{ state: 'ok'; processes: readonly unknown[] }>
  | Readonly<{ state: 'unknown' }>
type ProviderListSnapshotsResult =
  | Readonly<{ state: 'ok'; first: readonly unknown[]; second: readonly unknown[] }>
  | Readonly<{ state: 'unknown' }>
type ProviderListenerResult =
  | Readonly<{ state: 'absent' }>
  | Readonly<{ state: 'unknown' }>
  | Readonly<{ state: 'present'; bindings: readonly unknown[] }>
type ProviderSignalResult = 'accepted' | 'dead' | 'unknown'

export type DaemonProcessHostSystem = Readonly<{
  platform?: string
  procRoot?: string
  runPowerShell?: (command: string, extraEnv?: Readonly<Record<string, string>>) => PowerShellResult
  readProcess?: (pid: number) => unknown
  listProcesses?: () => unknown
  listProcessSnapshots?: () => unknown
  readListeners?: (port: number) => unknown
  terminateWindowsTree?: (rootPid: number) => ProviderSignalResult
  signalPosix?: (pid: number, signal: NodeJS.Signals) => ProviderSignalResult
  now?: () => number
  sleep?: (milliseconds: number) => void
}>

export interface DaemonProcessHost {
  readonly platform: string
  processFacts(pid: number): DaemonProcessFacts
  processTree(rootPid: number, expectedIdentity: string): DaemonProcessTreeFacts
  listenerFacts(port: number): DaemonListenerFacts
  terminateExactTree(tree: DaemonExactProcessTree): DaemonTreeTerminationResult
  waitForExit(tree: DaemonExactProcessTree, timeoutMs: number): DaemonTreeExitWait
}

const DEAD = Object.freeze({ state: 'dead' as const })
const UNKNOWN_PROCESS = Object.freeze({ state: 'unknown' as const })
const UNKNOWN_TREE = Object.freeze({ state: 'unknown' as const })
const ABSENT_LISTENER = Object.freeze({ state: 'absent' as const })
const UNKNOWN_LISTENER = Object.freeze({ state: 'unknown' as const })

class MissingProcessError extends Error {}
class UnaddressableProcessError extends Error {}

function positivePid(value: number, label = 'process id'): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} is invalid`)
  return value
}

function canonicalPort(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new TypeError('listener port is invalid')
  }
  return value
}

function dataRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const actual = Object.keys(value).sort()
    const expected = [...keys].sort()
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const clone: Record<string, unknown> = Object.create(null)
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return null
      clone[key] = descriptor.value
    }
    return clone
  } catch {
    return null
  }
}

function normalizeAliveProcess(value: unknown, expectedPid?: number): DaemonAliveProcessFacts | null {
  const record = dataRecord(value, ['state', 'pid', 'ppid', 'processIdentity', 'pgid', 'commandLine'])
  if (!record || record.state !== 'alive') return null
  const pid = Number(record.pid)
  const ppid = Number(record.ppid)
  const pgid = Number(record.pgid)
  const processIdentity = record.processIdentity
  const commandLine = record.commandLine
  if (!Number.isSafeInteger(pid) || pid < 1 || expectedPid !== undefined && pid !== expectedPid
    || !Number.isSafeInteger(ppid) || ppid < 0 || ppid === pid
    || !Number.isSafeInteger(pgid) || pgid < 1
    || typeof processIdentity !== 'string' || !SAFE_PROCESS_IDENTITY.test(processIdentity)
    || typeof commandLine !== 'string' || commandLine.includes('\0')
    || Buffer.byteLength(commandLine, 'utf8') > MAX_COMMAND_LINE_BYTES) return null
  return Object.freeze({ state: 'alive', pid, ppid, processIdentity, pgid, commandLine })
}

function normalizeProcessFacts(value: unknown, expectedPid: number): DaemonProcessFacts {
  try {
    const terminal = dataRecord(value, ['state'])
    if (terminal?.state === 'dead') return DEAD
    if (terminal?.state === 'unknown') return UNKNOWN_PROCESS
    return normalizeAliveProcess(value, expectedPid) || UNKNOWN_PROCESS
  } catch {
    return UNKNOWN_PROCESS
  }
}

function sameAliveProcess(left: DaemonAliveProcessFacts, right: DaemonAliveProcessFacts): boolean {
  return left.pid === right.pid && left.ppid === right.ppid
    && left.processIdentity === right.processIdentity && left.pgid === right.pgid
    && left.commandLine === right.commandLine
}

function normalizeProcessList(value: unknown): readonly DaemonAliveProcessFacts[] | null {
  const unknown = dataRecord(value, ['state'])
  if (unknown?.state === 'unknown') return null
  const record = dataRecord(value, ['state', 'processes'])
  if (!record || record.state !== 'ok' || !Array.isArray(record.processes)) return null
  const byPid = new Map<number, DaemonAliveProcessFacts>()
  for (const raw of record.processes) {
    const tentative = dataRecord(raw, ['state', 'pid', 'ppid', 'processIdentity', 'pgid', 'commandLine'])
    const pid = Number(tentative?.pid)
    const processFacts = Number.isSafeInteger(pid) ? normalizeAliveProcess(raw, pid) : null
    if (!processFacts) return null
    const prior = byPid.get(processFacts.pid)
    if (prior && !sameAliveProcess(prior, processFacts)) return null
    byPid.set(processFacts.pid, processFacts)
  }
  return Object.freeze([...byPid.values()].sort((left, right) => left.pid - right.pid))
}

function creationOrder(identity: string): Readonly<{ family: 'linux' | 'windows'; boot?: string; value: bigint }> | null {
  const linux = identity.match(/^linux:([a-f0-9]{32}):(\d+)$/)
  if (linux) return { family: 'linux', boot: linux[1], value: BigInt(linux[2]) }
  const windows = identity.match(/^windows:(\d+)$/)
  if (windows) return { family: 'windows', value: BigInt(windows[1]) }
  return null
}

function childCanBelongToParent(child: DaemonAliveProcessFacts, parent: DaemonAliveProcessFacts): boolean {
  const childOrder = creationOrder(child.processIdentity)
  const parentOrder = creationOrder(parent.processIdentity)
  if (!childOrder || !parentOrder || childOrder.family !== parentOrder.family) return false
  if (childOrder.family === 'linux' && childOrder.boot !== parentOrder.boot) return false
  return childOrder.value >= parentOrder.value
}

function deriveTree(
  processes: readonly DaemonAliveProcessFacts[],
  rootPid: number,
  expectedIdentity: string
): readonly DaemonAliveProcessFacts[] | null {
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]))
  const root = byPid.get(rootPid)
  if (!root || root.processIdentity !== expectedIdentity) return null
  const selected = new Set([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const entry of processes) {
      if (selected.has(entry.pid) || !selected.has(entry.ppid)) continue
      const parent = byPid.get(entry.ppid)
      if (!parent || !childCanBelongToParent(entry, parent)) return null
      selected.add(entry.pid)
      changed = true
    }
  }
  return Object.freeze(processes.filter((entry) => selected.has(entry.pid)))
}

function treeSignature(tree: Pick<DaemonExactProcessTree, 'rootPid' | 'rootProcessIdentity' | 'entries'>): string {
  return JSON.stringify({
    rootPid: tree.rootPid,
    rootProcessIdentity: tree.rootProcessIdentity,
    entries: tree.entries.map(({ pid, ppid, processIdentity, pgid, commandLine }) => ({
      pid, ppid, processIdentity, pgid, commandLine
    }))
  })
}

function powerShellPath(): string | null {
  const root = process.env.SystemRoot || process.env.WINDIR || ''
  if (!path.win32.isAbsolute(root)) return null
  return path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

function windowsToolPath(name: string): string | null {
  const root = process.env.SystemRoot || process.env.WINDIR || ''
  if (!path.win32.isAbsolute(root) || !/^[A-Za-z0-9.-]+$/.test(name)) return null
  return path.win32.join(root, 'System32', name)
}

function defaultPowerShell(command: string, extraEnv: Readonly<Record<string, string>> = {}): PowerShellResult {
  const executable = powerShellPath()
  if (!executable) return { status: 10, stdout: '', stderr: 'absolute Windows PowerShell path is unavailable' }
  const ran = spawnSync(executable, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command
  ], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: MAX_POWERSHELL_OUTPUT_BYTES,
    env: { ...process.env, ...extraEnv }
  })
  return {
    status: ran.status ?? 10,
    stdout: String(ran.stdout || ''),
    stderr: String(ran.stderr || ran.error?.message || '')
  }
}

function windowsProcessFromJson(value: unknown, expectedPid?: number): DaemonProcessFacts {
  const record = dataRecord(value, ['pid', 'ppid', 'creationTicks', 'commandLine'])
  if (!record) return UNKNOWN_PROCESS
  const pid = Number(record.pid)
  const ppid = Number(record.ppid)
  const ticks = record.creationTicks
  const commandLine = record.commandLine
  if (!Number.isSafeInteger(pid) || pid < 1 || expectedPid !== undefined && pid !== expectedPid
    || !Number.isSafeInteger(ppid) || ppid < 0 || ppid === pid
    || typeof ticks !== 'string' || !/^\d+$/.test(ticks)
    || typeof commandLine !== 'string') return UNKNOWN_PROCESS
  // Win32 exposes parentage and creation time but no POSIX PGID. The root PID
  // is the stable logical group anchor; exact membership comes from the frozen
  // identity-bearing process-tree snapshot, never from this number alone.
  return normalizeProcessFacts({
    state: 'alive', pid, ppid, processIdentity: `windows:${ticks}`, pgid: pid, commandLine
  }, pid)
}

function readWindowsProcess(pid: number, runPowerShell: NonNullable<DaemonProcessHostSystem['runPowerShell']>): DaemonProcessFacts {
  const script = [
    '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
    '$id = [int]$env:SG_DAEMON_FACT_PID',
    '$p = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId=" + $id) -ErrorAction Stop',
    'if ($null -eq $p) { exit 3 }',
    'if ($null -eq $p.CreationDate) { exit 4 }',
    '$row = [ordered]@{ pid = [int]$p.ProcessId; ppid = [int]$p.ParentProcessId; creationTicks = [string]$p.CreationDate.ToUniversalTime().Ticks; commandLine = [string]$p.CommandLine }',
    '[Console]::Out.Write((ConvertTo-Json -InputObject $row -Compress))'
  ].join('\n')
  const result = runPowerShell(script, { SG_DAEMON_FACT_PID: String(pid) })
  if (result.status === 3) return DEAD
  if (result.status !== 0) return UNKNOWN_PROCESS
  try {
    return windowsProcessFromJson(JSON.parse(result.stdout), pid)
  } catch {
    return UNKNOWN_PROCESS
  }
}

function normalizeWindowsProcessRows(value: unknown): ProviderListResult {
  const rows = Array.isArray(value) ? value : value == null ? [] : [value]
  const processes: DaemonAliveProcessFacts[] = []
  for (const row of rows) {
    const facts = windowsProcessFromJson(row)
    if (facts.state !== 'alive') return { state: 'unknown' }
    processes.push(facts)
  }
  return { state: 'ok', processes }
}

function listWindowsProcesses(runPowerShell: NonNullable<DaemonProcessHostSystem['runPowerShell']>): ProviderListResult {
  const script = [
    '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
    '$source = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)',
    '$rows = @()',
    'foreach ($p in $source) {',
    '  if ([int]$p.ProcessId -le 0 -or [int]$p.ProcessId -eq $PID) { continue }',
    '  if ($null -eq $p.CreationDate) { exit 4 }',
    '  $rows += [ordered]@{ pid = [int]$p.ProcessId; ppid = [int]$p.ParentProcessId; creationTicks = [string]$p.CreationDate.ToUniversalTime().Ticks; commandLine = [string]$p.CommandLine }',
    '}',
    '[Console]::Out.Write((ConvertTo-Json -InputObject $rows -Compress -Depth 3))'
  ].join('\n')
  const result = runPowerShell(script)
  if (result.status !== 0 || !result.stdout.trim()) return { state: 'unknown' }
  try {
    return normalizeWindowsProcessRows(JSON.parse(result.stdout))
  } catch {
    return { state: 'unknown' }
  }
}

function listWindowsProcessSnapshots(
  runPowerShell: NonNullable<DaemonProcessHostSystem['runPowerShell']>
): ProviderListSnapshotsResult {
  const script = [
    '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
    'function Read-Snapshot {',
    '  $source = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)',
    '  $rows = @()',
    '  foreach ($p in $source) {',
    '    if ([int]$p.ProcessId -le 0 -or [int]$p.ProcessId -eq $PID) { continue }',
    '    if ($null -eq $p.CreationDate) { throw "missing process creation date" }',
    '    $rows += [ordered]@{ pid = [int]$p.ProcessId; ppid = [int]$p.ParentProcessId; creationTicks = [string]$p.CreationDate.ToUniversalTime().Ticks; commandLine = [string]$p.CommandLine }',
    '  }',
    '  return $rows',
    '}',
    'try { $first = @(Read-Snapshot); $second = @(Read-Snapshot) } catch { [Console]::Error.Write([string]$_.Exception.Message); exit 10 }',
    '$pair = [ordered]@{ first = $first; second = $second }',
    '[Console]::Out.Write((ConvertTo-Json -InputObject $pair -Compress -Depth 4))'
  ].join('\n')
  const result = runPowerShell(script)
  if (result.status !== 0 || !result.stdout.trim()) return { state: 'unknown' }
  try {
    const decoded = dataRecord(JSON.parse(result.stdout), ['first', 'second'])
    if (!decoded) return { state: 'unknown' }
    const first = normalizeWindowsProcessRows(decoded.first)
    const second = normalizeWindowsProcessRows(decoded.second)
    if (first.state !== 'ok' || second.state !== 'ok') return { state: 'unknown' }
    return { state: 'ok', first: first.processes, second: second.processes }
  } catch {
    return { state: 'unknown' }
  }
}

function missingProcess(error: unknown): boolean {
  return ['ENOENT', 'ESRCH'].includes(String((error as NodeJS.ErrnoException)?.code || ''))
}

function linuxBootId(procRoot: string): string {
  const value = fs.readFileSync(path.join(procRoot, 'sys', 'kernel', 'random', 'boot_id'), 'utf8')
    .trim().replaceAll('-', '').toLowerCase()
  if (!/^[a-f0-9]{32}$/.test(value)) throw new Error('Linux boot id is malformed')
  return value
}

function readLinuxAliveProcess(pid: number, procRoot: string, bootId: string): DaemonAliveProcessFacts {
  let stat: string
  try {
    stat = fs.readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8')
  } catch (error) {
    if (missingProcess(error)) throw new MissingProcessError()
    throw error
  }
  const opening = stat.indexOf('(')
  const closing = stat.lastIndexOf(')')
  const statPid = Number(stat.slice(0, opening).trim())
  if (opening < 1 || closing <= opening || statPid !== pid) throw new Error('Linux process stat is malformed')
  const fields = stat.slice(closing + 1).trim().split(/\s+/)
  const state = fields[0]
  const ppid = Number(fields[1])
  const pgid = Number(fields[2])
  const startTicks = fields[19]
  if (state === 'Z' || state === 'X') throw new MissingProcessError()
  // Kernel threads can have process-group zero. They cannot belong to the
  // positive-PGID user daemon tree and are omitted from whole-system snapshots.
  if (pgid === 0) throw new UnaddressableProcessError()
  if (!Number.isSafeInteger(ppid) || ppid < 0 || ppid === pid
    || !Number.isSafeInteger(pgid) || pgid < 1 || !/^\d+$/.test(startTicks || '')) {
    throw new Error('Linux process stat is malformed')
  }
  let commandLine = ''
  try {
    commandLine = fs.readFileSync(path.join(procRoot, String(pid), 'cmdline'), 'utf8').replaceAll('\0', ' ').trim()
  } catch (error) {
    if (missingProcess(error)) throw new MissingProcessError()
    if (!['EACCES', 'EPERM'].includes(String((error as NodeJS.ErrnoException)?.code || ''))) throw error
  }
  const normalized = normalizeAliveProcess({
    state: 'alive', pid, ppid, processIdentity: `linux:${bootId}:${startTicks}`, pgid, commandLine
  }, pid)
  if (!normalized) throw new Error('Linux process facts are unsafe')
  return normalized
}

function readLinuxProcess(pid: number, procRoot: string): DaemonProcessFacts {
  try {
    return readLinuxAliveProcess(pid, procRoot, linuxBootId(procRoot))
  } catch (error) {
    return error instanceof MissingProcessError ? DEAD : UNKNOWN_PROCESS
  }
}

function listLinuxProcesses(procRoot: string): ProviderListResult {
  try {
    const bootId = linuxBootId(procRoot)
    const pids = fs.readdirSync(procRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[1-9]\d*$/.test(entry.name))
      .map((entry) => Number(entry.name))
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0)
      .sort((left, right) => left - right)
    const processes: DaemonAliveProcessFacts[] = []
    for (const pid of pids) {
      try {
        processes.push(readLinuxAliveProcess(pid, procRoot, bootId))
      } catch (error) {
        if (!(error instanceof MissingProcessError) && !(error instanceof UnaddressableProcessError)) {
          return { state: 'unknown' }
        }
      }
    }
    return { state: 'ok', processes }
  } catch {
    return { state: 'unknown' }
  }
}

function normalizeListenerBinding(value: unknown, expectedPort: number): DaemonListenerBinding | null {
  const record = dataRecord(value, ['family', 'address', 'port', 'pid'])
  if (!record || record.family !== 'ipv4' && record.family !== 'ipv6'
    || typeof record.address !== 'string' || record.address.length < 1 || record.address.length > 128
    || Number(record.port) !== expectedPort || !Number.isSafeInteger(record.pid) || Number(record.pid) < 1) return null
  const family = record.family
  const address = record.address.toLowerCase()
  if (isIP(address) !== (family === 'ipv4' ? 4 : 6)) return null
  return Object.freeze({ family, address, port: expectedPort, pid: Number(record.pid) })
}

function normalizeListenerFacts(value: unknown, port: number): DaemonListenerFacts {
  try {
    const terminal = dataRecord(value, ['state'])
    if (terminal?.state === 'absent') return ABSENT_LISTENER
    if (terminal?.state === 'unknown') return UNKNOWN_LISTENER
    const record = dataRecord(value, ['state', 'bindings'])
    if (!record || record.state !== 'present' || !Array.isArray(record.bindings)) return UNKNOWN_LISTENER
    const unique = new Map<string, DaemonListenerBinding>()
    for (const raw of record.bindings) {
      const binding = normalizeListenerBinding(raw, port)
      if (!binding) return UNKNOWN_LISTENER
      unique.set(`${binding.family}\0${binding.address}\0${binding.port}\0${binding.pid}`, binding)
    }
    const bindings = [...unique.values()].sort((left, right) => left.family.localeCompare(right.family)
      || left.address.localeCompare(right.address) || left.pid - right.pid)
    if (bindings.length === 0) return UNKNOWN_LISTENER
    const pids = [...new Set(bindings.map((binding) => binding.pid))].sort((left, right) => left - right)
    return Object.freeze({ state: 'present', pids: Object.freeze(pids), bindings: Object.freeze(bindings) })
  } catch {
    return UNKNOWN_LISTENER
  }
}

function readWindowsListeners(
  port: number,
  runPowerShell: NonNullable<DaemonProcessHostSystem['runPowerShell']>
): ProviderListenerResult {
  const script = [
    '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
    '$port = [int]$env:SG_DAEMON_FACT_PORT',
    'try { $source = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop) } catch {',
    '  $id = [string]$_.FullyQualifiedErrorId',
    '  if ($id -match "NoMatchingMSFT_NetTCPConnection|CmdletizationQuery_NotFound|Query_NotFound") { exit 3 }',
    '  [Console]::Error.Write([string]$_.Exception.Message); exit 10',
    '}',
    '$rows = @()',
    'foreach ($item in $source) {',
    '  $address = [string]$item.LocalAddress',
    '  $parsed = [System.Net.IPAddress]::Parse($address)',
    '  $family = if ([string]$parsed.AddressFamily -eq "InterNetwork") { "ipv4" } elseif ([string]$parsed.AddressFamily -eq "InterNetworkV6") { "ipv6" } else { exit 4 }',
    '  $rows += [ordered]@{ family = $family; address = $address; port = [int]$item.LocalPort; pid = [int]$item.OwningProcess }',
    '}',
    '[Console]::Out.Write((ConvertTo-Json -InputObject $rows -Compress -Depth 3))'
  ].join('\n')
  const result = runPowerShell(script, { SG_DAEMON_FACT_PORT: String(port) })
  if (result.status === 3) return { state: 'absent' }
  if (result.status !== 0) return { state: 'unknown' }
  try {
    const decoded = result.stdout.trim() ? JSON.parse(result.stdout) : []
    const bindings = Array.isArray(decoded) ? decoded : [decoded]
    return bindings.length > 0 ? { state: 'present', bindings } : { state: 'absent' }
  } catch {
    return { state: 'unknown' }
  }
}

function procIpv4Address(hex: string): string | null {
  if (!/^[a-f0-9]{8}$/i.test(hex)) return null
  return (hex.match(/../g) || []).reverse().map((byte) => Number.parseInt(byte, 16)).join('.')
}

function compressIpv6(bytes: readonly number[]): string {
  const groups: number[] = []
  for (let index = 0; index < 16; index += 2) groups.push(bytes[index] * 256 + bytes[index + 1])
  let bestStart = -1
  let bestLength = 0
  for (let index = 0; index < groups.length;) {
    if (groups[index] !== 0) { index += 1; continue }
    let end = index
    while (end < groups.length && groups[end] === 0) end += 1
    if (end - index > bestLength && end - index >= 2) {
      bestStart = index
      bestLength = end - index
    }
    index = end
  }
  if (bestStart < 0) return groups.map((group) => group.toString(16)).join(':')
  const left = groups.slice(0, bestStart).map((group) => group.toString(16)).join(':')
  const right = groups.slice(bestStart + bestLength).map((group) => group.toString(16)).join(':')
  if (!left && !right) return '::'
  if (!left) return `::${right}`
  if (!right) return `${left}::`
  return `${left}::${right}`
}

function procIpv6Address(hex: string): string | null {
  if (!/^[a-f0-9]{32}$/i.test(hex)) return null
  const bytes: number[] = []
  for (let group = 0; group < 4; group += 1) {
    const word = hex.slice(group * 8, group * 8 + 8)
    const pairs = word.match(/../g)
    if (!pairs) return null
    for (const pair of pairs.reverse()) bytes.push(Number.parseInt(pair, 16))
  }
  return compressIpv6(bytes)
}

type ProcListenerRow = Readonly<{
  family: 'ipv4' | 'ipv6'
  address: string
  port: number
  inode: string
}>

function procListenerRows(file: string, family: 'ipv4' | 'ipv6', port: number): readonly ProcListenerRow[] {
  let source: string
  try {
    source = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (family === 'ipv6' && String((error as NodeJS.ErrnoException)?.code || '') === 'ENOENT') return []
    throw error
  }
  const rows: ProcListenerRow[] = []
  for (const line of source.split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue
    const fields = line.trim().split(/\s+/)
    if (fields.length < 10) throw new Error('Linux TCP listener table is malformed')
    const separator = fields[1].lastIndexOf(':')
    if (separator < 0 || !/^[a-f0-9]{4}$/i.test(fields[1].slice(separator + 1))) {
      throw new Error('Linux TCP listener endpoint is malformed')
    }
    const rowPort = Number.parseInt(fields[1].slice(separator + 1), 16)
    if (fields[3] !== '0A' || rowPort !== port) continue
    const encodedAddress = fields[1].slice(0, separator)
    const address = family === 'ipv4' ? procIpv4Address(encodedAddress) : procIpv6Address(encodedAddress)
    const inode = fields[9]
    if (!address || isIP(address) !== (family === 'ipv4' ? 4 : 6) || !/^\d+$/.test(inode) || inode === '0') {
      throw new Error('Linux TCP listener row is malformed')
    }
    rows.push({ family, address, port, inode })
  }
  return rows
}

function readLinuxListeners(port: number, procRoot: string): ProviderListenerResult {
  try {
    const rows = [
      ...procListenerRows(path.join(procRoot, 'net', 'tcp'), 'ipv4', port),
      ...procListenerRows(path.join(procRoot, 'net', 'tcp6'), 'ipv6', port)
    ]
    if (rows.length === 0) return { state: 'absent' }
    const targetInodes = new Set(rows.map((row) => row.inode))
    const owners = new Map([...targetInodes].map((inode) => [inode, new Set<number>()]))
    let incomplete = false
    const processEntries = fs.readdirSync(procRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[1-9]\d*$/.test(entry.name))
    for (const processEntry of processEntries) {
      const pid = Number(processEntry.name)
      let descriptors: fs.Dirent[]
      try {
        descriptors = fs.readdirSync(path.join(procRoot, processEntry.name, 'fd'), { withFileTypes: true })
      } catch (error) {
        if (missingProcess(error)) continue
        incomplete = true
        continue
      }
      for (const descriptor of descriptors) {
        let link: string
        try {
          link = fs.readlinkSync(path.join(procRoot, processEntry.name, 'fd', descriptor.name))
        } catch (error) {
          if (!missingProcess(error)) incomplete = true
          continue
        }
        const socket = link.match(/^socket:\[(\d+)\]$/)
        if (socket && targetInodes.has(socket[1])) owners.get(socket[1])!.add(pid)
      }
    }
    if (incomplete || [...owners.values()].some((pids) => pids.size === 0)) return { state: 'unknown' }
    const bindings: DaemonListenerBinding[] = []
    for (const row of rows) {
      for (const pid of owners.get(row.inode) || []) {
        bindings.push({ family: row.family, address: row.address, port, pid })
      }
    }
    return { state: 'present', bindings }
  } catch {
    return { state: 'unknown' }
  }
}

function defaultWindowsTreeTermination(rootPid: number): ProviderSignalResult {
  const taskkill = windowsToolPath('taskkill.exe')
  if (!taskkill) return 'unknown'
  const result = spawnSync(taskkill, ['/PID', String(rootPid), '/T', '/F'], {
    encoding: 'utf8', windowsHide: true, timeout: 15_000
  })
  return result.status === 0 ? 'accepted' : 'unknown'
}

function defaultPosixSignal(pid: number, signal: NodeJS.Signals): ProviderSignalResult {
  try {
    process.kill(pid, signal)
    return 'accepted'
  } catch (error) {
    return String((error as NodeJS.ErrnoException)?.code || '') === 'ESRCH' ? 'dead' : 'unknown'
  }
}

function defaultSleep(milliseconds: number): void {
  const waiter = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(waiter, 0, 0, milliseconds)
}

export function createDaemonProcessHost(system: DaemonProcessHostSystem = {}): DaemonProcessHost {
  const platform = system.platform || process.platform
  const procRoot = path.resolve(system.procRoot || '/proc')
  const runPowerShell = system.runPowerShell || defaultPowerShell
  const readProcessProvider = system.readProcess || ((pid: number) => platform === 'win32'
    ? readWindowsProcess(pid, runPowerShell)
    : platform === 'linux' ? readLinuxProcess(pid, procRoot) : UNKNOWN_PROCESS)
  const listProcessesProvider = system.listProcesses || (() => platform === 'win32'
    ? listWindowsProcesses(runPowerShell)
    : platform === 'linux' ? listLinuxProcesses(procRoot) : { state: 'unknown' })
  const listProcessSnapshotsProvider = system.listProcessSnapshots
    || (platform === 'win32' && !system.listProcesses
      ? () => listWindowsProcessSnapshots(runPowerShell)
      : null)
  const readListenersProvider = system.readListeners || ((port: number) => platform === 'win32'
    ? readWindowsListeners(port, runPowerShell)
    : platform === 'linux' ? readLinuxListeners(port, procRoot) : { state: 'unknown' })
  const terminateWindowsTree = system.terminateWindowsTree || defaultWindowsTreeTermination
  const signalPosix = system.signalPosix || defaultPosixSignal
  const now = system.now || Date.now
  const sleep = system.sleep || defaultSleep
  const issuedTrees = new WeakMap<object, string>()

  const processFacts = (pidValue: number): DaemonProcessFacts => {
    const pid = positivePid(pidValue)
    try {
      return normalizeProcessFacts(readProcessProvider(pid), pid)
    } catch {
      return UNKNOWN_PROCESS
    }
  }

  const scanTree = (rootPid: number, expectedIdentity: string): readonly DaemonAliveProcessFacts[] | null => {
    let value: unknown
    try {
      value = listProcessesProvider()
    } catch {
      return null
    }
    const processes = normalizeProcessList(value)
    return processes ? deriveTree(processes, rootPid, expectedIdentity) : null
  }

  const processTree = (rootPidValue: number, expectedIdentityValue: string): DaemonProcessTreeFacts => {
    const rootPid = positivePid(rootPidValue, 'tree root process id')
    const expectedIdentity = String(expectedIdentityValue || '')
    if (!SAFE_PROCESS_IDENTITY.test(expectedIdentity)) throw new TypeError('tree root process identity is invalid')
    let first: readonly DaemonAliveProcessFacts[] | null
    let second: readonly DaemonAliveProcessFacts[] | null
    if (listProcessSnapshotsProvider) {
      let value: unknown
      try {
        value = listProcessSnapshotsProvider()
      } catch {
        return UNKNOWN_TREE
      }
      const unknown = dataRecord(value, ['state'])
      const pair = unknown?.state === 'unknown'
        ? null
        : dataRecord(value, ['state', 'first', 'second'])
      if (!pair || pair.state !== 'ok' || !Array.isArray(pair.first) || !Array.isArray(pair.second)) {
        return UNKNOWN_TREE
      }
      const firstProcesses = normalizeProcessList({ state: 'ok', processes: pair.first })
      const secondProcesses = normalizeProcessList({ state: 'ok', processes: pair.second })
      first = firstProcesses ? deriveTree(firstProcesses, rootPid, expectedIdentity) : null
      second = secondProcesses ? deriveTree(secondProcesses, rootPid, expectedIdentity) : null
    } else {
      first = scanTree(rootPid, expectedIdentity)
      second = first ? scanTree(rootPid, expectedIdentity) : null
    }
    if (!first) return UNKNOWN_TREE
    if (!second || first.length !== second.length
      || first.some((entry, index) => !sameAliveProcess(entry, second[index]))) return UNKNOWN_TREE
    const tree: DaemonExactProcessTree = Object.freeze({
      state: 'exact',
      rootPid,
      rootProcessIdentity: expectedIdentity,
      entries: Object.freeze([...second])
    })
    issuedTrees.set(tree, treeSignature(tree))
    return tree
  }

  const listenerFacts = (portValue: number): DaemonListenerFacts => {
    const port = canonicalPort(portValue)
    try {
      return normalizeListenerFacts(readListenersProvider(port), port)
    } catch {
      return UNKNOWN_LISTENER
    }
  }

  const assertIssuedTree = (tree: DaemonExactProcessTree): string => {
    if (!tree || typeof tree !== 'object' || tree.state !== 'exact') {
      throw new TypeError('exact process tree authority is required')
    }
    const signature = issuedTrees.get(tree)
    if (!signature || signature !== treeSignature(tree)) {
      throw new Error('process tree authority was not issued by this host')
    }
    return signature
  }

  const exactTargetsGone = (tree: DaemonExactProcessTree): 'gone' | 'live' | 'unknown' => {
    let live = false
    for (const entry of tree.entries) {
      const facts = processFacts(entry.pid)
      if (facts.state === 'unknown') return 'unknown'
      if (facts.state === 'alive' && facts.processIdentity === entry.processIdentity) live = true
    }
    return live ? 'live' : 'gone'
  }

  const revalidateTree = (tree: DaemonExactProcessTree, signature: string): boolean => {
    const current = processTree(tree.rootPid, tree.rootProcessIdentity)
    if (current.state !== 'exact' || treeSignature(current) !== signature) return false
    for (const expected of tree.entries) {
      const facts = processFacts(expected.pid)
      if (facts.state !== 'alive' || !sameAliveProcess(facts, expected)) return false
    }
    return true
  }

  const terminateExactTree = (tree: DaemonExactProcessTree): DaemonTreeTerminationResult => {
    const signature = assertIssuedTree(tree)
    if (tree.entries.some((entry) => entry.pid === process.pid)) {
      return Object.freeze({ state: 'unknown', pids: Object.freeze([]) })
    }
    const gone = exactTargetsGone(tree)
    if (gone === 'gone') return Object.freeze({ state: 'already-exited', pids: Object.freeze([]) })
    if (gone === 'unknown' || !revalidateTree(tree, signature)) {
      return Object.freeze({ state: 'unknown', pids: Object.freeze([]) })
    }
    if (platform === 'win32') {
      const result = terminateWindowsTree(tree.rootPid)
      return Object.freeze({
        state: result === 'accepted' ? 'signaled' : result === 'dead' ? 'already-exited' : 'unknown',
        pids: Object.freeze(result === 'accepted' ? [tree.rootPid] : [])
      })
    }
    if (platform !== 'linux') return Object.freeze({ state: 'unknown', pids: Object.freeze([]) })

    const byPid = new Map(tree.entries.map((entry) => [entry.pid, entry]))
    const depth = (entry: DaemonAliveProcessFacts): number => {
      let value = 0
      let cursor = entry
      const seen = new Set<number>()
      while (cursor.pid !== tree.rootPid) {
        if (seen.has(cursor.pid)) return -1
        seen.add(cursor.pid)
        const parent = byPid.get(cursor.ppid)
        if (!parent) return -1
        cursor = parent
        value += 1
      }
      return value
    }
    const ordered = [...tree.entries].sort((left, right) => depth(right) - depth(left) || left.pid - right.pid)
    if (ordered.some((entry) => depth(entry) < 0)) {
      return Object.freeze({ state: 'unknown', pids: Object.freeze([]) })
    }
    const signaled: number[] = []
    for (const expected of ordered) {
      const facts = processFacts(expected.pid)
      if (facts.state === 'dead' || facts.state === 'alive' && facts.processIdentity !== expected.processIdentity) continue
      if (facts.state !== 'alive' || !sameAliveProcess(facts, expected)) {
        return Object.freeze({ state: 'unknown', pids: Object.freeze(signaled) })
      }
      const result = signalPosix(expected.pid, 'SIGTERM')
      if (result === 'unknown') return Object.freeze({ state: 'unknown', pids: Object.freeze(signaled) })
      if (result === 'accepted') signaled.push(expected.pid)
    }
    return Object.freeze({
      state: signaled.length > 0 ? 'signaled' : 'already-exited',
      pids: Object.freeze(signaled)
    })
  }

  const waitForExit = (tree: DaemonExactProcessTree, timeoutMs: number): DaemonTreeExitWait => {
    assertIssuedTree(tree)
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) {
      throw new TypeError('process exit timeout is invalid')
    }
    const deadline = now() + timeoutMs
    for (;;) {
      const live: number[] = []
      const unknown: number[] = []
      for (const expected of tree.entries) {
        const facts = processFacts(expected.pid)
        if (facts.state === 'unknown') unknown.push(expected.pid)
        else if (facts.state === 'alive' && facts.processIdentity === expected.processIdentity) live.push(expected.pid)
      }
      if (unknown.length > 0) return Object.freeze({ state: 'unknown', pids: Object.freeze(unknown) })
      if (live.length === 0) return Object.freeze({ state: 'exited' })
      const remaining = deadline - now()
      if (remaining <= 0) return Object.freeze({ state: 'timeout', pids: Object.freeze(live) })
      sleep(Math.min(50, remaining))
    }
  }

  return Object.freeze({ platform, processFacts, processTree, listenerFacts, terminateExactTree, waitForExit })
}
