import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const OUTPUT_LIMIT = 64 * 1024 * 1024
const POWERSHELL_TIMEOUT_MS = 60_000
const PROTECTED_PLAIN_LIMITS = Object.freeze({
  maxEntries: 200_000,
  maxBytes: 4 * 1024 * 1024 * 1024,
  allowLinks: true
})
const PROTECTED_UNTRACKED_LIMITS = Object.freeze({
  maxEntries: 100_000,
  maxBytes: 2 * 1024 * 1024 * 1024
})

function comparable(target) {
  const resolved = path.resolve(target)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export function samePath(left, right) {
  return comparable(left) === comparable(right)
}

export function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return Boolean(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
}

export function tail(value, limit = 8_000) {
  const text = String(value || '')
  return text.length <= limit ? text : text.slice(-limit)
}

export function isExactTransientWriteLockBusy(result) {
  if (!result || result.error !== undefined || result.status !== 1) return false
  const stdout = String(result.stdout || '').trim()
  const stderr = String(result.stderr || '').trim()
  return (stdout === 'write lock is busy' && stderr === '')
    || (stderr === 'write lock is busy' && stdout === '')
}

export function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function sha256File(file) {
  return sha256Bytes(fs.readFileSync(file))
}

export function assertPlainDirectory(target, label) {
  if (!fs.existsSync(target)) throw new Error(`${label} must exist`)
  const stat = fs.lstatSync(target)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a plain directory`)
  if (!samePath(target, fs.realpathSync.native(target))) throw new Error(`${label} must resolve exactly`)
}

export function assertPlainFile(target, label) {
  if (!fs.existsSync(target)) throw new Error(`${label} must exist`)
  const stat = fs.lstatSync(target)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a plain file`)
  if (!samePath(target, fs.realpathSync.native(target))) throw new Error(`${label} must resolve exactly`)
}

export function assertPlainDirectoryChain(target, label) {
  const chain = []
  let cursor = path.resolve(target)
  for (;;) {
    chain.push(cursor)
    const parent = path.dirname(cursor)
    if (samePath(parent, cursor)) break
    cursor = parent
  }
  for (const directory of chain.reverse()) {
    if (fs.existsSync(directory)) assertPlainDirectory(directory, label)
  }
}

export function assertFreshRunLayout(context) {
  for (const [label, directory] of [
    ['app root', context.appRoot],
    ['home root', context.homeRoot],
    ['data root', context.hubDataRoot],
    ['probe root', context.probeRoot],
    ['logs root', context.logsRoot]
  ]) {
    assertPlainDirectoryChain(directory, label)
    const entries = fs.readdirSync(directory)
    if (entries.length !== 0) throw new Error(`${label} must be fresh; found ${entries.length} entries`)
  }
}

export function assertOwnedPath(context, target, firstSegment, label) {
  const resolved = path.resolve(target)
  if (!isInside(context.runRoot, resolved)) throw new Error(`${label} must stay inside the marker-owned run root`)
  const segment = path.relative(context.runRoot, resolved).split(path.sep)[0]
  if (segment.toLowerCase() !== firstSegment.toLowerCase()) {
    throw new Error(`${label} must stay under ${firstSegment}`)
  }
  return resolved
}

export function ensureOwnedDirectory(context, target, firstSegment, label) {
  const resolved = assertOwnedPath(context, target, firstSegment, label)
  if (!fs.existsSync(resolved)) fs.mkdirSync(resolved, { recursive: true })
  assertPlainDirectoryChain(resolved, label)
  return resolved
}

export function treeManifest(root, limits = {}) {
  if (!fs.existsSync(root)) return []
  assertPlainDirectory(root, 'manifest root')
  const maxEntries = limits.maxEntries ?? 100_000
  const maxBytes = limits.maxBytes ?? 2 * 1024 * 1024 * 1024
  const rows = []
  let totalBytes = 0
  const walk = (directory, prefix) => {
    for (const name of fs.readdirSync(directory).sort((a, b) => Buffer.from(a).compare(Buffer.from(b)))) {
      if (rows.length >= maxEntries) throw new Error('tree manifest entry limit exceeded')
      const absolute = path.join(directory, name)
      const relative = prefix ? `${prefix}/${name}` : name
      const stat = fs.lstatSync(absolute)
      if (stat.isSymbolicLink()) {
        if (!limits.allowLinks) throw new Error(`tree manifest refuses a symbolic/reparse entry: ${relative}`)
        rows.push({ path: relative, kind: 'link', target: fs.readlinkSync(absolute) })
        continue
      }
      if (stat.isDirectory()) {
        if (!samePath(absolute, fs.realpathSync.native(absolute))) {
          throw new Error(`tree manifest refuses a reparse directory: ${relative}`)
        }
        rows.push({ path: `${relative}/`, kind: 'directory' })
        walk(absolute, relative)
      } else if (stat.isFile()) {
        totalBytes += stat.size
        if (totalBytes > maxBytes) throw new Error('tree manifest byte limit exceeded')
        rows.push({ path: relative, kind: 'file', size: stat.size, sha256: `sha256:${sha256File(absolute)}` })
      } else throw new Error(`tree manifest refuses an unsupported entry: ${relative}`)
    }
  }
  walk(root, '')
  return rows
}

export function copyPlainTree(source, target, limits = {}) {
  assertPlainDirectory(source, 'plain copy source')
  if (fs.existsSync(target)) throw new Error('plain copy target must be fresh')
  fs.mkdirSync(target, { recursive: false })
  const maxEntries = limits.maxEntries ?? 100_000
  const maxBytes = limits.maxBytes ?? 2 * 1024 * 1024 * 1024
  let entries = 0
  let bytes = 0
  const copy = (from, to) => {
    for (const name of fs.readdirSync(from).sort((a, b) => Buffer.from(a).compare(Buffer.from(b)))) {
      entries += 1
      if (entries > maxEntries) throw new Error('plain copy entry limit exceeded')
      const sourceEntry = path.join(from, name)
      const targetEntry = path.join(to, name)
      const stat = fs.lstatSync(sourceEntry)
      if (stat.isSymbolicLink()) throw new Error(`plain copy refuses symbolic/reparse entry: ${sourceEntry}`)
      if (stat.isDirectory()) {
        if (!samePath(sourceEntry, fs.realpathSync.native(sourceEntry))) {
          throw new Error(`plain copy refuses a reparse directory: ${sourceEntry}`)
        }
        fs.mkdirSync(targetEntry)
        copy(sourceEntry, targetEntry)
      } else if (stat.isFile()) {
        bytes += stat.size
        if (bytes > maxBytes) throw new Error('plain copy byte limit exceeded')
        fs.copyFileSync(sourceEntry, targetEntry, fs.constants.COPYFILE_EXCL)
      } else throw new Error(`plain copy refuses unsupported entry: ${sourceEntry}`)
    }
  }
  copy(source, target)
}

function allStrings(value, output = []) {
  if (typeof value === 'string') output.push(value)
  else if (Array.isArray(value)) for (const item of value) allStrings(item, output)
  else if (value && typeof value === 'object') for (const item of Object.values(value)) allStrings(item, output)
  return output
}

export function assertLocatorFree(value, locators, label) {
  const needles = locators
    .filter(Boolean)
    .map((item) => path.resolve(item).replaceAll('\\', '/').toLowerCase())
  for (const candidate of allStrings(value)) {
    const normalized = candidate.replaceAll('\\', '/').toLowerCase()
    for (const needle of needles) {
      if (normalized.includes(needle)) throw new Error(`${label} leaked a raw locator`)
    }
  }
}

export function writeBoundedJson(file, value, { maxBytes = 32 * 1024, locators = [] } = {}) {
  assertLocatorFree(value, locators, path.basename(file))
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
  if (bytes.length > maxBytes) throw new Error(`${path.basename(file)} exceeds its bounded evidence limit`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 })
  return `sha256:${sha256Bytes(bytes)}`
}

function powershell(command, extraEnv = {}) {
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    windowsHide: true,
    timeout: POWERSHELL_TIMEOUT_MS,
    maxBuffer: OUTPUT_LIMIT
  })
}

function checked(result, label, expectedStatus = 0) {
  if (result.error) throw new Error(`${label} spawn failed: ${result.error.message}`)
  if (result.status !== expectedStatus) {
    throw new Error(`${label} exited ${result.status}: ${tail(result.stderr || result.stdout)}`)
  }
  return String(result.stdout || '')
}

export function readUserEnvironmentValue(name) {
  const result = powershell([
    "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $false)",
    'if ($null -eq $key) { [Console]::Out.Write(\'{"exists":false,"value":null,"kind":null}\'); exit 0 }',
    'try {',
    '  $actual = @($key.GetValueNames() | Where-Object { $_.Equals($env:SG_ENV_NAME, [StringComparison]::OrdinalIgnoreCase) }) | Select-Object -First 1',
    '  if ($null -eq $actual) { [Console]::Out.Write(\'{"exists":false,"value":null,"kind":null}\'); exit 0 }',
    '  $value = $key.GetValue($actual, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)',
    '  $kind = [string]$key.GetValueKind($actual)',
    '  @{ exists = $true; value = [string]$value; kind = $kind } | ConvertTo-Json -Compress | Write-Output -NoEnumerate',
    '} finally { $key.Dispose() }'
  ].join('\n'), { SG_ENV_NAME: name })
  const raw = checked(result, `read HKCU environment ${name}`).trim()
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed?.exists !== 'boolean'
      || (parsed.exists && (typeof parsed.value !== 'string' || typeof parsed.kind !== 'string'))
      || (!parsed.exists && (parsed.value !== null || parsed.kind !== null))) throw new Error('shape')
    return Object.freeze({
      exists: parsed.exists,
      value: parsed.exists ? parsed.value : null,
      kind: parsed.exists ? parsed.kind : null
    })
  } catch (error) {
    throw new Error(`read HKCU environment ${name} returned invalid JSON: ${error instanceof Error ? error.message : error}`)
  }
}

export function writeUserEnvironmentValue(name, value, kind = 'String') {
  const result = powershell(value === null
    ? "[Environment]::SetEnvironmentVariable($env:SG_ENV_NAME, $null, 'User')"
    : [
        "$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment', $true)",
        'try {',
        '  $valueKind = [System.Enum]::Parse([Microsoft.Win32.RegistryValueKind], $env:SG_ENV_KIND, $true)',
        '  $key.SetValue($env:SG_ENV_NAME, $env:SG_ENV_VALUE, $valueKind)',
        '} finally { $key.Dispose() }'
      ].join('\n'),
  { SG_ENV_NAME: name, SG_ENV_VALUE: value ?? '', SG_ENV_KIND: kind || 'String' })
  checked(result, `restore HKCU environment ${name}`)
}

export function broadcastEnvironmentChange() {
  const result = powershell([
    "Add-Type -TypeDefinition @'",
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class P4EnvironmentBroadcast {',
    '  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)]',
    '  public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);',
    '}',
    "'@",
    '$result = [UIntPtr]::Zero',
    '[void][P4EnvironmentBroadcast]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, "Environment", 2, 5000, [ref]$result)'
  ].join('\n'))
  checked(result, 'broadcast restored HKCU environment')
}

export function readExternalEnvironmentSnapshot() {
  return Object.freeze({
    Path: readUserEnvironmentValue('Path'),
    SKILL_GRAFT_HOME: readUserEnvironmentValue('SKILL_GRAFT_HOME'),
    HUB_ROOT: readUserEnvironmentValue('HUB_ROOT'),
    HUB_API_PORT: readUserEnvironmentValue('HUB_API_PORT')
  })
}

export function assertExternalEnvironmentEqual(actual, expected, label) {
  for (const name of Object.keys(expected)) {
    const left = actual[name]
    const right = expected[name]
    if (left?.exists !== right?.exists || left?.value !== right?.value || left?.kind !== right?.kind) {
      throw new Error(`${label} changed HKCU environment ${name}`)
    }
  }
}

export function taskState(name) {
  const result = powershell([
    '$task = Get-ScheduledTask -TaskName $env:SG_TASK_NAME -ErrorAction SilentlyContinue',
    'if (-not $task) { exit 3 }',
    '$actions = @($task.Actions)',
    'if ($actions.Count -ne 1) { exit 4 }',
    '$action = $actions[0]',
    '[Console]::Out.Write(([string]$action.Execute) + [char]0 + ([string]$action.Arguments))'
  ].join('; '), { SG_TASK_NAME: name })
  if (result.error) throw new Error(`scheduled task query failed: ${result.error.message}`)
  if (result.status === 3) return Object.freeze({ exists: false, action: '' })
  if (result.status !== 0) throw new Error(`scheduled task query exited ${result.status}: ${tail(result.stderr || result.stdout)}`)
  return Object.freeze({ exists: true, action: String(result.stdout || '').replace(/\r?\n$/, '') })
}

export function deleteExactOwnedTask(name, expectedAction) {
  const current = taskState(name)
  if (!current.exists) return false
  if (current.action.toLowerCase() !== expectedAction.toLowerCase()) {
    throw new Error('refusing emergency cleanup of a concurrently changed scheduled task')
  }
  const result = spawnSync('schtasks.exe', ['/Delete', '/TN', name, '/F'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: POWERSHELL_TIMEOUT_MS,
    maxBuffer: OUTPUT_LIMIT
  })
  checked(result, 'delete exact owned scheduled task')
  if (taskState(name).exists) throw new Error('exact owned scheduled task survived cleanup')
  return true
}

function expandWindowsEnvironment(value, environment = process.env) {
  return String(value || '').replace(/%([^%]+)%/g, (_match, name) => {
    const entry = Object.entries(environment).find(([candidate]) => candidate.toLowerCase() === name.toLowerCase())
    return entry ? String(entry[1] || '') : ''
  })
}

export function pathEntries(rawPath, environment = process.env) {
  return String(rawPath || '')
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter(Boolean)
    .map((entry) => ({ raw: entry, expanded: path.resolve(expandWindowsEnvironment(entry, environment)) }))
}

export function commandCandidates(directory, command) {
  return [command, `${command}.cmd`, `${command}.exe`, `${command}.bat`, `${command}.ps1`]
    .map((name) => path.join(directory, name))
}

export function findCommandsOnPath(command, rawPath, environment = process.env) {
  const found = []
  for (const entry of pathEntries(rawPath, environment)) {
    for (const candidate of commandCandidates(entry.expanded, command)) {
      if (fs.existsSync(candidate) && fs.lstatSync(candidate).isFile()) found.push(comparable(candidate))
    }
  }
  return [...new Set(found)]
}

export function withoutHostCommandBins(rawPath, environment = process.env) {
  const kept = []
  const removed = []
  for (const entry of pathEntries(rawPath, environment)) {
    const ownsHost = ['sg', 'ozdqp-hub', 'dsh'].some((command) =>
      commandCandidates(entry.expanded, command).some((candidate) => fs.existsSync(candidate)))
    if (ownsHost) removed.push(entry.expanded)
    else kept.push(entry.raw)
  }
  return Object.freeze({ value: kept.join(path.delimiter), removed: Object.freeze(removed) })
}

function protectedGitEnvironment(isolatedHome) {
  const env = { ...process.env }
  for (const name of Object.keys(env)) if (/^GIT_/i.test(name)) delete env[name]
  Object.assign(env, {
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    LANG: 'C',
    LC_ALL: 'C',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: 'NUL',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    NO_COLOR: '1',
    PAGER: 'cat',
    TERM: 'dumb'
  })
  return env
}

function spawnProtectedGit(root, isolatedHome, args, encoding = null, extraEnvironment = {}) {
  return spawnSync('git', [
    '--no-optional-locks',
    '-c', 'color.ui=false',
    '-c', 'core.fsmonitor=false',
    '-c', 'core.quotePath=false',
    '-C', root,
    ...args
  ], {
    env: { ...protectedGitEnvironment(isolatedHome), ...extraEnvironment },
    encoding,
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: OUTPUT_LIMIT
  })
}

function protectedGitBytes(root, isolatedHome, args, label, extraEnvironment = {}) {
  const result = spawnProtectedGit(root, isolatedHome, args, null, extraEnvironment)
  if (result.error) throw new Error(`${label} spawn failed: ${result.error.message}`)
  if (result.status !== 0) {
    throw new Error(`${label} exited ${result.status}: ${tail(result.stderr || result.stdout)}`)
  }
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout || '')
}

function protectedGitText(root, isolatedHome, args, label, extraEnvironment = {}) {
  return protectedGitBytes(root, isolatedHome, args, label, extraEnvironment).toString('utf8')
}

function byteEvidence(bytes) {
  return Object.freeze({
    bytes: bytes.length,
    sha256: `sha256:${sha256Bytes(bytes)}`
  })
}

function classifyProtectedRoot(root, isolatedHome) {
  assertPlainDirectory(root, 'protected root')
  const result = spawnProtectedGit(root, isolatedHome, ['rev-parse', '--show-toplevel'], 'utf8')
  if (result.error) throw new Error(`protected Git classification failed: ${result.error.message}`)
  if (result.status === 0) {
    const top = String(result.stdout || '').trim()
    if (!top || !samePath(top, root)) {
      throw new Error('protected root inside Git must be the exact worktree root')
    }
    return 'git'
  }
  const detail = String(result.stderr || result.stdout || '')
  if (fs.existsSync(path.join(root, '.git')) || !/not a git repository/i.test(detail)) {
    throw new Error(`protected root Git classification failed closed: ${tail(detail)}`)
  }
  return 'plain'
}

function parseNullTerminatedGitPaths(bytes, label) {
  if (bytes.length === 0) return []
  if (bytes[bytes.length - 1] !== 0) throw new Error(`${label} did not end with NUL`)
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const paths = []
  let start = 0
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue
    if (index === start) throw new Error(`${label} contained an empty path`)
    let relative
    try { relative = decoder.decode(bytes.subarray(start, index)) } catch (error) {
      throw new Error(`${label} contained a non-UTF-8 path: ${error instanceof Error ? error.message : error}`)
    }
    if (path.posix.isAbsolute(relative)
      || relative === '.'
      || relative === '..'
      || path.posix.normalize(relative) !== relative
      || relative.startsWith('../')) {
      throw new Error(`${label} contained an unsafe path`)
    }
    paths.push(relative)
    start = index + 1
  }
  return paths
}

function protectedUntrackedManifest(root, listingBytes, limits = PROTECTED_UNTRACKED_LIMITS) {
  const paths = parseNullTerminatedGitPaths(listingBytes, 'protected Git untracked listing')
  if (paths.length > limits.maxEntries) throw new Error('protected Git untracked entry limit exceeded')
  const seen = new Set()
  const entries = []
  let totalBytes = 0
  for (const relative of paths) {
    const key = process.platform === 'win32' ? relative.toLowerCase() : relative
    if (seen.has(key)) throw new Error('protected Git untracked listing contained a duplicate path')
    seen.add(key)
    const absolute = path.join(root, ...relative.split('/'))
    if (!isInside(root, absolute)) throw new Error('protected Git untracked path escaped its root')
    assertPlainFile(absolute, `protected Git untracked file ${relative}`)
    const bytes = fs.readFileSync(absolute)
    totalBytes += bytes.length
    if (totalBytes > limits.maxBytes) throw new Error('protected Git untracked byte limit exceeded')
    entries.push(Object.freeze({
      path: relative,
      bytes: bytes.length,
      sha256: `sha256:${sha256Bytes(bytes)}`
    }))
  }
  return Object.freeze({
    listing: byteEvidence(listingBytes),
    entries: Object.freeze(entries),
    totalBytes
  })
}

function protectedGitProbe(root, isolatedHome) {
  const indexValue = protectedGitText(
    root,
    isolatedHome,
    ['rev-parse', '--git-path', 'index'],
    'protected Git index path'
  ).trim()
  if (!indexValue) throw new Error('protected Git index path was empty')
  const indexFile = path.isAbsolute(indexValue) ? path.resolve(indexValue) : path.resolve(root, indexValue)
  assertPlainFile(indexFile, 'protected Git index')
  const indexBefore = fs.readFileSync(indexFile)
  assertPlainDirectory(isolatedHome, 'protected Git isolated HOME')
  const temporaryRoot = fs.mkdtempSync(path.join(isolatedHome, '.p4-protected-index-'))
  assertPlainDirectory(temporaryRoot, 'protected Git temporary index root')
  const temporaryIndex = path.join(temporaryRoot, 'index')
  fs.writeFileSync(temporaryIndex, indexBefore, { flag: 'wx' })
  assertPlainFile(temporaryIndex, 'protected Git temporary index')
  const indexEnvironment = { GIT_INDEX_FILE: temporaryIndex }
  let head
  let status
  let workDiff
  let stagedDiff
  let untracked
  try {
    head = protectedGitText(root, isolatedHome, ['rev-parse', 'HEAD'], 'protected Git HEAD').trim()
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(head)) throw new Error('protected Git HEAD was not an object ID')
    status = protectedGitBytes(root, isolatedHome, [
      'status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z'
    ], 'protected Git status', indexEnvironment)
    workDiff = protectedGitBytes(root, isolatedHome, [
      'diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--'
    ], 'protected Git work diff', indexEnvironment)
    stagedDiff = protectedGitBytes(root, isolatedHome, [
      'diff', '--cached', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', 'HEAD', '--'
    ], 'protected Git staged diff', indexEnvironment)
    const untrackedListing = protectedGitBytes(root, isolatedHome, [
      'ls-files', '--others', '--exclude-standard', '-z', '--'
    ], 'protected Git untracked listing', indexEnvironment)
    untracked = protectedUntrackedManifest(root, untrackedListing)
  } finally {
    fs.unlinkSync(temporaryIndex)
    fs.rmdirSync(temporaryRoot)
  }

  const indexAfter = fs.readFileSync(indexFile)
  if (!indexBefore.equals(indexAfter)) {
    throw new Error(`protected Git capture changed index bytes despite isolated index use: ${root}`)
  }
  return Object.freeze({
    kind: 'git',
    root: path.resolve(root),
    head,
    index: byteEvidence(indexBefore),
    status: byteEvidence(status),
    workDiff: byteEvidence(workDiff),
    stagedDiff: byteEvidence(stagedDiff),
    untracked
  })
}

function protectedPlainProbe(root) {
  return Object.freeze({
    kind: 'plain',
    root: path.resolve(root),
    limits: PROTECTED_PLAIN_LIMITS,
    manifest: Object.freeze(treeManifest(root, PROTECTED_PLAIN_LIMITS))
  })
}

function protectedRootProbe(root, isolatedHome) {
  return classifyProtectedRoot(root, isolatedHome) === 'git'
    ? protectedGitProbe(root, isolatedHome)
    : protectedPlainProbe(root)
}

export function captureProtectedRootBaselines(roots, isolatedHome) {
  const unique = []
  for (const root of roots.filter(Boolean).map((item) => path.resolve(item))) {
    if (!fs.existsSync(root)) continue
    if (!unique.some((item) => samePath(item, root))) unique.push(root)
  }
  return Object.freeze(unique.map((root) => protectedRootProbe(root, isolatedHome)))
}

export function assertProtectedRootBaselines(baselines, isolatedHome) {
  for (const baseline of baselines) {
    const current = protectedRootProbe(baseline.root, isolatedHome)
    if (!isDeepStrictEqual(current, baseline)) {
      throw new Error(`protected ${baseline.kind} root baseline changed during P4 installed-real`)
    }
  }
}

export function runNpm(args, cwd, environment, { timeout = 15 * 60 * 1000 } = {}) {
  const npmExecPath = String(process.env.npm_execpath || '')
  const command = npmExecPath ? process.execPath : 'npm.cmd'
  const commandArgs = npmExecPath ? [npmExecPath, ...args] : args
  return spawnSync(command, commandArgs, {
    cwd,
    env: environment,
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    maxBuffer: OUTPUT_LIMIT
  })
}

export function parseNpmPack(result, label) {
  const raw = checked(result, label)
  let parsed
  try { parsed = JSON.parse(raw) } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error instanceof Error ? error.message : error}`)
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || typeof parsed[0]?.filename !== 'string') {
    throw new Error(`${label} returned an unexpected npm pack shape`)
  }
  return parsed[0]
}

export function runChecked(result, label, expectedStatus = 0) {
  return checked(result, label, expectedStatus)
}
