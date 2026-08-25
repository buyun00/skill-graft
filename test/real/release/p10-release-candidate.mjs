import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createWindowsBatchInvocation,
  getAvailableLoopbackPort
} from '../../support/real-e2e.mjs'

const VERSION_A = '0.1.0'
const VERSION_B = '0.1.1-rc.1'
const DSH_PACKAGE = '@ozdqp/skill-graft-dsh'
const RUN_ID_PATTERN = /^p10-[a-f0-9-]{36}$/i
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const harnessRoot = path.resolve(process.env.SKILL_GRAFT_DSH_SOURCE || 'E:\\deepseek-harness-master')
const e2eBase = path.resolve(process.env.SKILL_GRAFT_P10_E2E_BASE || 'E:\\skill-graft-e2e')
const runId = `p10-${randomUUID()}`
const runRoot = path.join(e2eBase, runId)

if (process.platform !== 'win32') throw new Error('P10 release-candidate runner is a real Windows-only gate')
if (process.env.SKILL_GRAFT_REAL_E2E !== '1') {
  throw new Error('P10 release-candidate runner requires SKILL_GRAFT_REAL_E2E=1')
}
if (!RUN_ID_PATTERN.test(runId) || path.basename(runRoot) !== runId) {
  throw new Error('P10 generated an invalid run identity')
}

function comparable(target) {
  const resolved = path.resolve(target).replace(/[\\/]+$/, '') || path.parse(path.resolve(target)).root
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function samePath(left, right) {
  return comparable(left) === comparable(right)
}

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return Boolean(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
}

function isSameOrInside(root, target) {
  return samePath(root, target) || isInside(root, target)
}

function canonicalizeMissing(target) {
  const absolute = path.resolve(target)
  const suffix = []
  let cursor = absolute
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor)
    if (samePath(parent, cursor)) break
    suffix.unshift(path.basename(cursor))
    cursor = parent
  }
  const ancestor = fs.existsSync(cursor) ? fs.realpathSync.native(cursor) : cursor
  return path.resolve(ancestor, ...suffix)
}

function assertPlainDirectory(target, label) {
  const stat = fs.lstatSync(target)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a plain directory`)
  return stat
}

function assertPlainFile(target, label) {
  const stat = fs.lstatSync(target)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a plain file`)
  return stat
}

function assertOwnedPath(target, label) {
  const canonicalRoot = canonicalizeMissing(runRoot)
  const canonicalTarget = canonicalizeMissing(target)
  if (!isInside(canonicalRoot, canonicalTarget)) {
    throw new Error(`${label} must stay inside the P10 run root`)
  }
  return path.resolve(target)
}

function ensureOwnedDirectory(target, label) {
  const resolved = path.resolve(target)
  const canonicalRoot = canonicalizeMissing(runRoot)
  const canonicalTarget = canonicalizeMissing(resolved)
  if (!samePath(canonicalRoot, canonicalTarget)) assertOwnedPath(resolved, label)
  fs.mkdirSync(resolved, { recursive: true })
  assertPlainDirectory(resolved, label)
  const realRoot = fs.realpathSync.native(runRoot)
  const realResolved = fs.realpathSync.native(resolved)
  if (!samePath(realRoot, realResolved) && !isInside(realRoot, realResolved)) {
    throw new Error(`${label} escaped the canonical P10 run root`)
  }
  return resolved
}

function writeOwnedFile(target, value, options = {}) {
  const resolved = assertOwnedPath(target, options.label || 'owned file')
  ensureOwnedDirectory(path.dirname(resolved), `${options.label || 'owned file'} parent`)
  fs.writeFileSync(resolved, value, {
    encoding: options.encoding,
    flag: options.flag || 'w',
    mode: options.mode
  })
  assertPlainFile(resolved, options.label || 'owned file')
  return resolved
}

function writeOwnedJson(target, value, label = 'JSON evidence') {
  return writeOwnedFile(target, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', label })
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function fileFact(file) {
  if (!fs.existsSync(file)) return { exists: false }
  const stat = assertPlainFile(file, file)
  const bytes = fs.readFileSync(file)
  return { exists: true, bytes: stat.size, sha256: sha256(bytes) }
}

function portable(relative) {
  return relative.split(path.sep).join('/')
}

function treeManifest(root, { exclude = () => false } = {}) {
  if (!fs.existsSync(root)) return []
  const rows = []
  const walk = (absolute, relative) => {
    const normalized = portable(relative)
    if (normalized && exclude(normalized)) return
    const stat = fs.lstatSync(absolute)
    if (stat.isSymbolicLink()) {
      rows.push({ path: normalized, kind: 'link', target: sha256(fs.readlinkSync(absolute)) })
      return
    }
    if (stat.isDirectory()) {
      if (normalized) rows.push({ path: normalized, kind: 'directory' })
      for (const name of fs.readdirSync(absolute).sort()) {
        walk(path.join(absolute, name), relative ? path.join(relative, name) : name)
      }
      return
    }
    if (!stat.isFile()) throw new Error(`unsupported filesystem entry under ${root}: ${normalized}`)
    const bytes = fs.readFileSync(absolute)
    rows.push({ path: normalized, kind: 'file', bytes: bytes.length, sha256: sha256(bytes) })
  }
  walk(root, '')
  return rows
}

function copyPlainTree(source, destination, label) {
  assertPlainDirectory(source, `${label} source`)
  ensureOwnedDirectory(destination, `${label} destination`)
  const walk = (from, to) => {
    for (const name of fs.readdirSync(from).sort()) {
      const sourceEntry = path.join(from, name)
      const destinationEntry = path.join(to, name)
      const stat = fs.lstatSync(sourceEntry)
      if (stat.isSymbolicLink()) throw new Error(`${label} refuses linked input ${sourceEntry}`)
      if (stat.isDirectory()) {
        ensureOwnedDirectory(destinationEntry, `${label} directory`)
        walk(sourceEntry, destinationEntry)
      } else if (stat.isFile()) {
        writeOwnedFile(destinationEntry, fs.readFileSync(sourceEntry), { label: `${label} file` })
      } else {
        throw new Error(`${label} refuses unsupported input ${sourceEntry}`)
      }
    }
  }
  walk(source, destination)
}

function parseJson(text, label) {
  const value = String(text || '').trim()
  try {
    return JSON.parse(value)
  } catch (error) {
    throw new Error(`${label} did not return JSON: ${error instanceof Error ? error.message : error}`)
  }
}

function tail(value, limit = 16 * 1024) {
  const text = String(value || '')
  return text.length <= limit ? text : text.slice(-limit)
}

function commandPaths(name, env = process.env) {
  const result = spawnSync('where.exe', [name], {
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000
  })
  if (result.status !== 0) return []
  return String(result.stdout || '').split(/\r?\n/).map(item => item.trim()).filter(Boolean)
}

function absoluteCommand(name) {
  const candidates = commandPaths(name)
  const selected = candidates.find(item => item.toLowerCase().endsWith('.cmd')) || candidates[0]
  if (!selected || !path.isAbsolute(selected)) throw new Error(`${name} is required on the host PATH`)
  return path.resolve(selected)
}

const gitCommand = absoluteCommand('git')
const pnpmCommand = absoluteCommand('pnpm')
const npmExecPath = String(process.env.npm_execpath || '').trim()
const npmCommand = npmExecPath && fs.existsSync(npmExecPath) ? process.execPath : absoluteCommand('npm')
const npmPrefix = npmExecPath && fs.existsSync(npmExecPath) ? [npmExecPath] : []

const layout = Object.freeze({
  runRoot,
  marker: path.join(runRoot, '.skill-graft-e2e-run.json'),
  logs: path.join(runRoot, 'logs'),
  packages: path.join(runRoot, 'packages'),
  stages: path.join(runRoot, 'stages'),
  appRoot: path.join(runRoot, 'app'),
  home: path.join(runRoot, 'home'),
  localHub: path.join(runRoot, 'hub-data'),
  localInstall: path.join(runRoot, 'local-install'),
  localUnusedDshHome: path.join(runRoot, 'home', 'dsh-home'),
  dshOsHome: path.join(runRoot, 'dsh-os-home'),
  dshHome: path.join(runRoot, 'dsh-home'),
  dshHub: path.join(runRoot, 'dsh-home', 'skill-graft'),
  temp: path.join(runRoot, 'temp'),
  npmCache: path.join(runRoot, 'npm-cache'),
  toolBin: path.join(runRoot, 'tool-bin')
})

let commandSequence = 0

function batchInvocation(executable, args, env) {
  if (!/\.(?:cmd|bat)$/i.test(executable)) return { command: executable, args, windowsVerbatimArguments: false }
  return createWindowsBatchInvocation(executable, args, { comspec: env.ComSpec })
}

function recordCommand(label, result) {
  const prefix = `${String(++commandSequence).padStart(3, '0')}-${label.replace(/[^a-z0-9._-]+/gi, '-')}`
  writeOwnedFile(path.join(layout.logs, `${prefix}.stdout.log`), tail(result.stdout, 256 * 1024), {
    encoding: 'utf8', label: `${label} stdout`
  })
  writeOwnedFile(path.join(layout.logs, `${prefix}.stderr.log`), tail(result.stderr, 256 * 1024), {
    encoding: 'utf8', label: `${label} stderr`
  })
  return {
    label,
    exitCode: result.status,
    stdoutBytes: Buffer.byteLength(String(result.stdout || ''), 'utf8'),
    stderrBytes: Buffer.byteLength(String(result.stderr || ''), 'utf8')
  }
}

function runCommand(executable, args, { cwd, env, label, timeout = 20 * 60 * 1000, expected = 'zero' }) {
  const invocation = batchInvocation(executable, args, env)
  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    shell: false
  })
  const evidence = recordCommand(label, result)
  if (result.error) throw new Error(`${label} spawn failed: ${result.error.message}`)
  if (expected === 'zero' && result.status !== 0) {
    throw new Error(`${label} failed (${result.status}): ${tail(result.stderr || result.stdout)}`)
  }
  if (expected === 'nonzero' && result.status === 0) {
    throw new Error(`${label} unexpectedly returned exit 0`)
  }
  return { ...result, evidence }
}

function runNpm(args, options) {
  return runCommand(npmCommand, [...npmPrefix, ...args], options)
}

function runPnpm(args, options) {
  return runCommand(pnpmCommand, args, options)
}

function gitRead(cwd, args, env, label) {
  const result = spawnSync(gitCommand, ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024
  })
  if (result.status !== 0) throw new Error(`${label}: ${result.stderr || result.stdout}`)
  return String(result.stdout || '').trim()
}

function gitCapture(cwd, args, env, label) {
  const result = spawnSync(gitCommand, ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024
  })
  if (result.status !== 0) throw new Error(`${label}: ${result.stderr || result.stdout}`)
  return String(result.stdout || '')
}

function workingPathFact(root, relative) {
  const absolute = path.join(root, ...relative.split('/'))
  if (!fs.existsSync(absolute)) return { path: relative, exists: false }
  const stat = fs.lstatSync(absolute)
  if (stat.isSymbolicLink()) {
    return { path: relative, exists: true, kind: 'link', targetSha256: sha256(fs.readlinkSync(absolute)) }
  }
  if (!stat.isFile()) return { path: relative, exists: true, kind: stat.isDirectory() ? 'directory' : 'other' }
  const bytes = fs.readFileSync(absolute)
  return { path: relative, exists: true, kind: 'file', bytes: bytes.length, sha256: sha256(bytes) }
}

function scrubEnvironment(base) {
  const env = { ...base }
  for (const name of Object.keys(env)) {
    if (/^(?:SKILL_GRAFT|HUB_|DSH_|GIT_)/i.test(name)
      || /(?:TOKEN|PASSWORD|SECRET|API_KEY|AUTH)/i.test(name)) delete env[name]
  }
  Object.assign(env, {
    NO_COLOR: '1',
    GIT_CONFIG_GLOBAL: 'NUL',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
    npm_config_cache: layout.npmCache,
    NPM_CONFIG_CACHE: layout.npmCache,
    npm_config_userconfig: path.join(runRoot, '.npmrc'),
    NPM_CONFIG_USERCONFIG: path.join(runRoot, '.npmrc')
  })
  return env
}

function withoutHostEntries(base, names) {
  const excluded = new Set()
  for (const name of names) {
    for (const entry of commandPaths(name, base)) excluded.add(comparable(path.dirname(entry)))
  }
  const pathValue = String(base.PATH || '').split(path.delimiter)
    .map(item => item.trim())
    .filter(Boolean)
    .filter(item => !excluded.has(comparable(item)))
    .join(path.delimiter)
  return { ...base, PATH: [layout.toolBin, pathValue].filter(Boolean).join(path.delimiter) }
}

function localEnvironment(base, port) {
  return {
    ...base,
    HOME: layout.home,
    USERPROFILE: layout.home,
    APPDATA: path.join(layout.home, 'appdata'),
    LOCALAPPDATA: path.join(layout.home, 'localappdata'),
    XDG_CONFIG_HOME: path.join(layout.home, 'xdg-config'),
    TEMP: layout.temp,
    TMP: layout.temp,
    DSH_HOME: layout.localUnusedDshHome,
    SKILL_GRAFT_HOME: layout.localHub,
    HUB_ROOT: layout.localHub,
    HUB_API_PORT: String(port),
    HUB_SPAWN_CODEX: '0',
    SG_INSTALL_DIR: layout.localInstall,
    SG_TASK_NAME: `SkillGraft-P10-${runId}`.slice(0, 96),
    SG_SKIP_PATH: '1',
    SG_SKIP_TASK: '1',
    SKILL_GRAFT_REAL_E2E: '1',
    SKILL_GRAFT_RUN_ID: runId,
    SKILL_GRAFT_E2E_ROOT: runRoot
  }
}

function dshEnvironment(base) {
  return {
    ...base,
    HOME: layout.dshOsHome,
    USERPROFILE: layout.dshOsHome,
    APPDATA: path.join(layout.dshOsHome, 'appdata'),
    LOCALAPPDATA: path.join(layout.dshOsHome, 'localappdata'),
    XDG_CONFIG_HOME: path.join(layout.dshOsHome, 'xdg-config'),
    TEMP: layout.temp,
    TMP: layout.temp,
    DSH_HOME: layout.dshHome,
    SKILL_GRAFT_HOME: layout.dshHub,
    HUB_ROOT: layout.dshHub,
    HUB_SPAWN_CODEX: '0'
  }
}

function collectProtectedRoots(env) {
  const roots = new Set([
    sourceRoot,
    harnessRoot,
    'E:\\ozdqp-skill-hub',
    'C:\\Users\\win11\\.codex\\worktrees\\aa1d\\ozdqp-skill-hub',
    'E:\\ozdqp-cli-attach-probe',
    'E:\\ozdqp-main-ntfs',
    'E:\\ozdqp-main',
    'E:\\ozdqp-main-active',
    'E:\\ozdqp-main-fix',
    'E:\\ozdqp-erhe-activity',
    'F:\\ozdqp-main-view',
    'F:\\ozdqp-ai-testing'
  ].filter(item => fs.existsSync(item)).map(item => fs.realpathSync.native(item)))
  const addOzdqpChildren = (base) => {
    if (!fs.existsSync(base)) return
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.name.toLowerCase().startsWith('ozdqp-')) continue
      const candidate = path.join(base, entry.name)
      if (fs.existsSync(candidate)) roots.add(fs.realpathSync.native(candidate))
    }
  }
  addOzdqpChildren('E:\\')
  addOzdqpChildren('F:\\')
  const codexWorktrees = path.join(os.homedir(), '.codex', 'worktrees')
  if (fs.existsSync(codexWorktrees)) {
    for (const entry of fs.readdirSync(codexWorktrees, { withFileTypes: true })) {
      if (entry.isDirectory()) addOzdqpChildren(path.join(codexWorktrees, entry.name))
    }
  }
  for (const item of String(process.env.SKILL_GRAFT_PROTECTED_ROOTS || '').split(path.delimiter)) {
    if (item.trim() && fs.existsSync(item.trim())) roots.add(fs.realpathSync.native(item.trim()))
  }
  const listed = spawnSync(gitCommand, ['-C', sourceRoot, 'worktree', 'list', '--porcelain'], {
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000
  })
  if (listed.status !== 0) throw new Error(`cannot enumerate protected worktrees: ${listed.stderr || listed.stdout}`)
  for (const line of String(listed.stdout || '').split(/\r?\n/)) {
    if (!line.startsWith('worktree ')) continue
    const worktree = line.slice('worktree '.length)
    if (fs.existsSync(worktree)) roots.add(fs.realpathSync.native(worktree))
  }
  return [...roots].sort((left, right) => comparable(left).localeCompare(comparable(right)))
}

function fingerprintProtectedRoot(root, env) {
  const canonical = fs.realpathSync.native(root)
  const top = spawnSync(gitCommand, ['--no-optional-locks', '-C', canonical, 'rev-parse', '--show-toplevel'], {
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000
  })
  const head = top.status === 0
    ? spawnSync(gitCommand, ['--no-optional-locks', '-C', canonical, 'rev-parse', 'HEAD'], {
        env,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 120_000
      })
    : null
  if (top.status === 0 && head?.status === 0) {
    const status = gitCapture(canonical, ['status', '--porcelain=v2', '-z', '--untracked-files=all'], env,
      `fingerprint status ${canonical}`)
    const index = gitCapture(canonical, ['ls-files', '--stage', '-z'], env, `fingerprint index ${canonical}`)
    const changed = new Set([
      ...gitCapture(canonical, ['diff', '--name-only', '-z', 'HEAD', '--'], env,
        `fingerprint changed files ${canonical}`).split('\0'),
      ...gitCapture(canonical, ['ls-files', '--others', '--exclude-standard', '-z'], env,
        `fingerprint untracked files ${canonical}`).split('\0')
    ].filter(Boolean).map(portable))
    return {
      root: canonical,
      kind: 'git',
      head: String(head.stdout || '').trim(),
      statusSha256: sha256(status),
      indexSha256: sha256(index),
      changedFiles: [...changed].sort().map(relative => workingPathFact(canonical, relative))
    }
  }
  const keyFiles = ['package.json', 'pnpm-lock.yaml', 'apps/cli/src/bin.ts', 'README.md']
    .map(relative => ({ relative, file: path.join(canonical, ...relative.split('/')) }))
    .filter(entry => fs.existsSync(entry.file))
    .map(entry => ({ path: entry.relative, ...fileFact(entry.file) }))
  const stat = assertPlainDirectory(canonical, `protected root ${canonical}`)
  return {
    root: canonical,
    kind: 'directory',
    identity: { dev: String(stat.dev), ino: String(stat.ino), mtimeMs: stat.mtimeMs },
    keyFiles
  }
}

function fingerprintProtectedRoots(roots, env) {
  return roots.map(root => fingerprintProtectedRoot(root, env))
}

function assertFreshRunRoot(protectedRoots) {
  if (!path.isAbsolute(e2eBase) || samePath(e2eBase, path.parse(e2eBase).root)) {
    throw new Error('P10 E2E base must be an absolute non-root directory')
  }
  const canonicalRun = canonicalizeMissing(runRoot)
  const home = canonicalizeMissing(os.homedir())
  if (isSameOrInside(home, canonicalRun) || isSameOrInside(canonicalRun, home)) {
    throw new Error('P10 run root must not overlap the user home')
  }
  for (const protectedRoot of protectedRoots) {
    if (isSameOrInside(protectedRoot, canonicalRun) || isSameOrInside(canonicalRun, protectedRoot)) {
      throw new Error(`P10 run root overlaps protected root ${protectedRoot}`)
    }
  }
  if (fs.existsSync(runRoot)) throw new Error('P10 UUID run root must be fresh')
}

function createRunLayout() {
  fs.mkdirSync(e2eBase, { recursive: true })
  assertPlainDirectory(e2eBase, 'P10 E2E base')
  fs.mkdirSync(runRoot, { recursive: false })
  assertPlainDirectory(runRoot, 'P10 run root')
  for (const directory of [
    layout.logs, layout.packages, layout.stages, layout.appRoot, layout.home,
    layout.localHub, layout.localUnusedDshHome, layout.dshOsHome, layout.dshHome,
    layout.temp, layout.npmCache, layout.toolBin
  ]) ensureOwnedDirectory(directory, 'P10 layout directory')
  writeOwnedJson(layout.marker, {
    version: 1,
    runId,
    runRoot,
    sourceRoot,
    createdAt: new Date().toISOString()
  }, 'P10 ownership marker')
  writeOwnedFile(path.join(layout.logs, '.invocation-trace-key'), randomBytes(32), {
    mode: 0o600,
    label: 'P10 invocation trace key'
  })
  writeOwnedFile(path.join(runRoot, '.npmrc'), '', { encoding: 'utf8', label: 'isolated npm config' })
  writeOwnedFile(path.join(layout.toolBin, 'node.cmd'), [
    '@echo off',
    `"${process.execPath.replaceAll('%', '%%')}" %*`,
    ''
  ].join('\r\n'), { encoding: 'utf8', label: 'isolated absolute Node wrapper' })
}

function expectedProtectionRejection(protectedRoots) {
  let message = ''
  const target = sourceRoot
  const canonical = canonicalizeMissing(target)
  assert.equal(protectedRoots.some(root => isSameOrInside(root, canonical) || isSameOrInside(canonical, root)), true,
    'intentional protected-root target must be in the protected inventory')
  try {
    assertOwnedPath(target, 'intentional protected-root probe')
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  if (!message.includes('must stay inside the P10 run root')) {
    throw new Error('intentional runner-side protected-root rejection did not fire')
  }
  return { layer: 'runner-preflight', target: canonical, message }
}

function npmPackDryRun(cwd, env, label) {
  const result = runNpm(['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd, env, label })
  const rows = parseJson(result.stdout, label)
  if (!Array.isArray(rows) || rows.length !== 1 || !Array.isArray(rows[0].files)) {
    throw new Error(`${label} returned an unexpected npm pack inventory`)
  }
  return rows[0]
}

function safePackRelative(value) {
  const normalized = String(value || '').replaceAll('\\', '/')
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) throw new Error('npm pack emitted an unsafe path')
  const canonical = path.posix.normalize(normalized)
  if (canonical === '..' || canonical.startsWith('../') || path.posix.isAbsolute(canonical)) {
    throw new Error(`npm pack path escapes its package: ${value}`)
  }
  return canonical
}

function copyPackInventory(source, destination, row, label) {
  ensureOwnedDirectory(destination, `${label} stage`)
  const canonicalSource = fs.realpathSync.native(source)
  for (const entry of row.files) {
    const relative = safePackRelative(entry.path)
    const from = path.resolve(source, ...relative.split('/'))
    const to = path.resolve(destination, ...relative.split('/'))
    assert.equal(isInside(canonicalSource, fs.realpathSync.native(from)), true, `${label} input stays in its source`)
    assertPlainFile(from, `${label} input ${relative}`)
    writeOwnedFile(to, fs.readFileSync(from), { label: `${label} staged ${relative}` })
  }
}

function setPackageVersion(stage, version, { updateBuildManifest = false } = {}) {
  const packageFile = path.join(stage, 'package.json')
  const pkg = parseJson(fs.readFileSync(packageFile, 'utf8'), `${stage} package.json`)
  pkg.version = version
  writeOwnedJson(packageFile, pkg, `${version} package.json`)
  if (updateBuildManifest) {
    const manifestFile = path.join(stage, 'build-manifest.json')
    const manifest = parseJson(fs.readFileSync(manifestFile, 'utf8'), `${stage} build-manifest.json`)
    manifest.version = version
    writeOwnedJson(manifestFile, manifest, `${version} DSH build manifest`)
  }
}

function auditPackageStage(stage, kind, version) {
  const files = treeManifest(stage).filter(entry => entry.kind === 'file').map(entry => entry.path)
  const pkg = parseJson(fs.readFileSync(path.join(stage, 'package.json'), 'utf8'), `${kind} package.json`)
  assert.equal(pkg.version, version, `${kind} staged version`)
  assert.equal(typeof pkg.license === 'string' && pkg.license !== '' && pkg.license !== 'UNLICENSED', true,
    `${kind} must declare a release license`)
  assert.equal(files.includes('LICENSE'), true, `${kind} must ship LICENSE`)
  const forbidden = files.filter(file => (
    /^(?:src|test|docs|artifacts|\.artifacts-local|node_modules|skill-review|\.agents|\.codex)(?:\/|$)/i.test(file)
    || /(?:^|\/)\.env(?:\.|$)/i.test(file)
    || /\.(?:pem|key|pfx|tgz)$/i.test(file)
    || /^skills\/(?!README\.md$)/i.test(file)
    || kind === 'local' && /^packages\//i.test(file)
  ))
  assert.deepEqual(forbidden, [], `${kind} package scope contains forbidden files`)
  for (const required of kind === 'local'
    ? ['package.json', 'LICENSE', 'dist/control/cli.js', 'web/index.html']
    : ['package.json', 'LICENSE', 'build-manifest.json', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js']) {
    assert.equal(files.includes(required), true, `${kind} package is missing ${required}`)
  }
  const runtimeSpecifiers = {}
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const entries = pkg[section] || {}
    assert.equal(entries !== null && typeof entries === 'object' && !Array.isArray(entries), true,
      `${kind} ${section} must be an object`)
    runtimeSpecifiers[section] = entries
    for (const [name, specifier] of Object.entries(entries)) {
      assert.equal(typeof specifier, 'string', `${kind} ${section}.${name} must be a string`)
      assert.doesNotMatch(specifier, /^(?:file|link|workspace):/i, `${kind} ${section}.${name} must not use a local specifier`)
      assert.equal(path.isAbsolute(specifier), false, `${kind} ${section}.${name} must not use an absolute path`)
      assert.equal(specifier.toLowerCase().includes(sourceRoot.toLowerCase()), false,
        `${kind} ${section}.${name} must not reference the source tree`)
      assert.equal(specifier.toLowerCase().includes(harnessRoot.toLowerCase()), false,
        `${kind} ${section}.${name} must not reference the Harness tree`)
    }
  }
  if (kind === 'dsh') {
    const manifest = parseJson(fs.readFileSync(path.join(stage, 'build-manifest.json'), 'utf8'), 'DSH build manifest')
    assert.equal(manifest.version, version, 'DSH build manifest version')
    assert.deepEqual(manifest.localDependencies, [], 'DSH build manifest must not contain local dependencies')
  }
  return { name: pkg.name, version: pkg.version, license: pkg.license, files, runtimeSpecifiers }
}

function packStage(stage, env, label) {
  const result = runNpm(['pack', '--json', '--ignore-scripts', '--pack-destination', layout.packages], {
    cwd: stage,
    env,
    label
  })
  const rows = parseJson(result.stdout, label)
  if (!Array.isArray(rows) || rows.length !== 1 || typeof rows[0].filename !== 'string') {
    throw new Error(`${label} returned an unexpected npm pack result`)
  }
  const tarball = path.resolve(layout.packages, rows[0].filename)
  assert.equal(isInside(runRoot, tarball), true, `${label} tarball stays in the run root`)
  assertPlainFile(tarball, `${label} tarball`)
  return {
    file: tarball,
    filename: path.basename(tarball),
    bytes: fs.statSync(tarball).size,
    sha256: sha256(fs.readFileSync(tarball)),
    npm: rows[0]
  }
}

function stagePackages(buildEnv) {
  const sourcePackage = parseJson(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8'), 'prepared Local package')
  assert.equal(sourcePackage.version, VERSION_B, 'prepared Local release version')
  assertPlainFile(path.join(sourceRoot, 'dist', 'control', 'cli.js'), 'prepared Local CLI')
  assertPlainFile(path.join(sourceRoot, 'web', 'index.html'), 'prepared Local Web release')
  const localInventory = npmPackDryRun(sourceRoot, buildEnv, 'local-pack-inventory')
  const builtDshStage = path.join(sourceRoot, '.artifacts-local', 'dsh-package')
  assertPlainDirectory(builtDshStage, 'built DSH stage')
  const preparedDshPackage = parseJson(
    fs.readFileSync(path.join(builtDshStage, 'package.json'), 'utf8'),
    'prepared DSH package'
  )
  const preparedDshManifest = parseJson(
    fs.readFileSync(path.join(builtDshStage, 'build-manifest.json'), 'utf8'),
    'prepared DSH build manifest'
  )
  assert.equal(preparedDshPackage.version, VERSION_B, 'prepared DSH release version')
  assert.equal(preparedDshManifest.version, VERSION_B, 'prepared DSH manifest version')
  const dshInventory = npmPackDryRun(builtDshStage, buildEnv, 'dsh-pack-inventory')

  const localA = path.join(layout.stages, 'local-a')
  const localB = path.join(layout.stages, 'local-b')
  const dshA = path.join(layout.stages, 'dsh-a')
  const dshB = path.join(layout.stages, 'dsh-b')
  copyPackInventory(sourceRoot, localA, localInventory, 'Local A')
  setPackageVersion(localA, VERSION_A)
  copyPlainTree(localA, localB, 'Local A to B')
  setPackageVersion(localB, VERSION_B)
  copyPackInventory(builtDshStage, dshA, dshInventory, 'DSH A')
  setPackageVersion(dshA, VERSION_A, { updateBuildManifest: true })
  copyPlainTree(dshA, dshB, 'DSH A to B')
  setPackageVersion(dshB, VERSION_B, { updateBuildManifest: true })

  const audits = {
    localA: auditPackageStage(localA, 'local', VERSION_A),
    localB: auditPackageStage(localB, 'local', VERSION_B),
    dshA: auditPackageStage(dshA, 'dsh', VERSION_A),
    dshB: auditPackageStage(dshB, 'dsh', VERSION_B)
  }
  const localCodeA = treeManifest(localA).filter(row => row.path !== 'package.json')
  const localCodeB = treeManifest(localB).filter(row => row.path !== 'package.json')
  assert.deepEqual(localCodeB, localCodeA, 'Local A/B must differ only by package version metadata')
  const dshCodeA = treeManifest(dshA).filter(row => !['package.json', 'build-manifest.json'].includes(row.path))
  const dshCodeB = treeManifest(dshB).filter(row => !['package.json', 'build-manifest.json'].includes(row.path))
  assert.deepEqual(dshCodeB, dshCodeA, 'DSH A/B must share identical code and assets')

  const packages = {
    localA: packStage(localA, buildEnv, 'pack-local-a'),
    localB: packStage(localB, buildEnv, 'pack-local-b'),
    dshA: packStage(dshA, buildEnv, 'pack-dsh-a'),
    dshB: packStage(dshB, buildEnv, 'pack-dsh-b')
  }
  assert.notEqual(packages.localA.sha256, packages.localB.sha256, 'Local version tarballs must differ')
  assert.notEqual(packages.dshA.sha256, packages.dshB.sha256, 'DSH version tarballs must differ')
  return {
    packages,
    audits,
    preparedRelease: {
      mode: 'prebuilt-inputs',
      localCli: fileFact(path.join(sourceRoot, 'dist', 'control', 'cli.js')),
      localWebFiles: treeManifest(path.join(sourceRoot, 'web')).filter(row => row.kind === 'file').length,
      dshHost: fileFact(path.join(builtDshStage, 'lib', 'index.js')),
      dshClient: fileFact(path.join(builtDshStage, 'lib', 'client.js'))
    }
  }
}

function installLocalTarball(tarball, prefix, env, label) {
  ensureOwnedDirectory(prefix, `${label} prefix`)
  runNpm([
    'install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', tarball
  ], { cwd: prefix, env, label })
  const packageRoot = path.join(prefix, 'node_modules', 'ozdqp-skill-hub')
  const cli = path.join(prefix, 'node_modules', '.bin', 'sg.cmd')
  assertPlainDirectory(packageRoot, `${label} installed package`)
  assertPlainFile(cli, `${label} installed CLI`)
  assert.equal(fs.existsSync(path.join(packageRoot, 'src')), false, `${label} installed package has no source`)
  assert.equal(isInside(sourceRoot, cli), false, `${label} CLI is outside the development tree`)
  return { prefix, packageRoot, cli }
}

function runCli(cli, args, env, label, expected = 'zero') {
  return runCommand(cli, args, { cwd: path.dirname(path.dirname(cli)), env, label, expected, timeout: 5 * 60 * 1000 })
}

function runCliJson(cli, args, env, label, expected = 'zero') {
  const result = runCli(cli, args, env, label, expected)
  return { result, value: parseJson(result.stdout, label) }
}

function listeners(port) {
  const result = spawnSync('netstat.exe', ['-ano', '-p', 'tcp'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000
  })
  if (result.status !== 0) throw new Error(`netstat failed: ${result.stderr || result.stdout}`)
  return String(result.stdout || '').split(/\r?\n/).map(line => line.trim()).filter(line => {
    const fields = line.split(/\s+/)
    return fields.length >= 5 && fields[1].endsWith(`:${port}`) && fields[3].toUpperCase() === 'LISTENING'
  }).map(line => Number(line.split(/\s+/).at(-1))).filter(Number.isSafeInteger).sort((a, b) => a - b)
}

async function waitForListener(port, expected, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const current = listeners(port)
    if ((current.length > 0) === expected) return current
    if (Date.now() >= deadline) throw new Error(`port ${port} did not become ${expected ? 'listening' : 'free'}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

function stableHubManifest(root) {
  const ignored = new Set([
    '.skill-graft-data-root.json',
    'skill-review/daemon.pid',
    'skill-review/api.pid',
    'skill-review/daemon-heartbeat.json',
    'skill-review/daemon.log'
  ])
  return treeManifest(root, { exclude: relative => ignored.has(relative) })
}

function localAuthoritySnapshot(local, localPort) {
  const manifestFile = path.join(layout.localInstall, 'install.json')
  const markerFile = path.join(layout.localHub, '.skill-graft-data-root.json')
  const receiptRoot = path.join(layout.home, '.skill-graft-lifecycle')
  return {
    manifest: fileFact(manifestFile),
    marker: fileFact(markerFile),
    installDir: treeManifest(layout.localInstall),
    receiptNamespace: treeManifest(receiptRoot),
    lifecycleAdjacent: {
      lock: fileFact(`${layout.localHub}.lifecycle.lock`),
      wal: fileFact(`${layout.localHub}.lifecycle-wal.json`),
      purgeWal: fileFact(`${layout.localHub}.purge-wal-v1.json`)
    },
    candidatePackageA: treeManifest(local.a.packageRoot),
    candidatePackageB: treeManifest(local.b.packageRoot),
    publicRuntime: [
      'AGENTS.override.md',
      'overlay/attached-worktrees.txt',
      'overlay/do-not-auto-attach.txt',
      'overlay/scan-roots.txt'
    ].map(relative => ({ path: relative, ...fileFact(path.join(layout.localHub, ...relative.split('/'))) })),
    hub: stableHubManifest(layout.localHub),
    listenerPids: listeners(localPort)
  }
}

async function runLocalGate(packages, baseEnv, localPort, runtimeState) {
  const env = localEnvironment(withoutHostEntries(baseEnv, ['sg', 'dsh']), localPort)
  for (const directory of [
    env.APPDATA, env.LOCALAPPDATA, env.XDG_CONFIG_HOME, env.TEMP, env.DSH_HOME
  ]) ensureOwnedDirectory(directory, 'Local isolated environment')
  assert.deepEqual(commandPaths('sg', env), [], 'Local PATH must not resolve an external sg')
  assert.deepEqual(commandPaths('dsh', env), [], 'Local PATH must not resolve an external dsh')

  const local = {
    a: installLocalTarball(packages.localA.file, path.join(layout.appRoot, 'local-a'), env, 'install-local-a'),
    b: installLocalTarball(packages.localB.file, path.join(layout.appRoot, 'local-b'), env, 'install-local-b')
  }
  runtimeState.local = { ...local, env, setup: false, uninstallAttempted: false, purged: false, activeCli: local.a.cli }
  assert.equal(parseJson(fs.readFileSync(path.join(local.a.packageRoot, 'package.json'), 'utf8'), 'installed Local A').version, VERSION_A)
  assert.equal(parseJson(fs.readFileSync(path.join(local.b.packageRoot, 'package.json'), 'utf8'), 'installed Local B').version, VERSION_B)

  const setup = runCliJson(local.a.cli, ['setup', '--no-path', '--no-task', '--json'], env, 'local-a-setup')
  runtimeState.local.setup = setup.value.ok === true
  assert.equal(setup.value.ok, true, JSON.stringify(setup.value.issues || []))
  assert.equal(setup.value.doctor?.ok, true, JSON.stringify(setup.value.doctor?.issues || []))
  const setupListeners = await waitForListener(localPort, true)

  const status = runCliJson(local.a.cli, [
    'status', '--contract-v1', '--request-id', `${runId}-local-status`
  ], env, 'local-a-status')
  assert.equal(status.value.ok, true)
  assert.equal(status.value.meta?.handler, 'application.commandBus')
  const upgradeDry = runCliJson(local.b.cli, ['upgrade', '--dry-run', '--json'], env, 'local-b-upgrade-dry-run')
  assert.equal(upgradeDry.value.ok, true, JSON.stringify(upgradeDry.value.issues || []))
  assert.equal(upgradeDry.value.status, 'planned')
  assert.equal(upgradeDry.value.fromVersion, VERSION_A)
  assert.equal(upgradeDry.value.toVersion, VERSION_B)
  const upgraded = runCliJson(local.b.cli, ['upgrade', '--json'], env, 'local-b-upgrade')
  runtimeState.local.activeCli = local.b.cli
  assert.equal(upgraded.value.ok, true, JSON.stringify(upgraded.value.issues || []))
  assert.equal(upgraded.value.status, 'upgraded')
  assert.equal(upgraded.value.fromVersion, VERSION_A)
  assert.equal(upgraded.value.toVersion, VERSION_B)
  assert.equal(upgraded.value.doctor?.ok, true, JSON.stringify(upgraded.value.doctor?.issues || []))
  await waitForListener(localPort, true)
  const manifestB = parseJson(
    fs.readFileSync(path.join(layout.localInstall, 'install.json'), 'utf8'),
    'upgraded Local manifest'
  )
  const receiptB = parseJson(
    fs.readFileSync(path.join(layout.home, '.skill-graft-lifecycle', 'root-receipt-v1.json'), 'utf8'),
    'upgraded Local root receipt'
  )
  assert.equal(manifestB.packageVersion, VERSION_B, 'Local manifest must name release B')
  assert.equal(receiptB.packageVersion, VERSION_B, 'Local root receipt must name release B')
  assert.equal(receiptB.packageSha256, manifestB.packageSha256, 'Local B receipt and manifest package authority must match')

  const authorityBefore = localAuthoritySnapshot(local, localPort)
  const downgrade = runCliJson(local.a.cli, ['upgrade', '--json'], env, 'local-a-downgrade-rejection', 'nonzero')
  assert.equal(downgrade.value.ok, false)
  assert.equal(downgrade.value.status, 'failed')
  assert.match(JSON.stringify(downgrade.value.issues || []), /downgrade|older|version/i)
  const authorityAfter = localAuthoritySnapshot(local, localPort)
  assert.deepEqual(authorityAfter, authorityBefore,
    'rejected Local downgrade must preserve manifest, marker, receipt, package, public runtime, and Hub authority bytes')

  const preservedBefore = stableHubManifest(layout.localHub)
  runtimeState.local.uninstallAttempted = true
  const uninstalled = runCliJson(local.b.cli, ['uninstall', '--json'], env, 'local-b-uninstall')
  assert.equal(uninstalled.value.ok, true, JSON.stringify(uninstalled.value.issues || []))
  assert.equal(uninstalled.value.status, 'uninstalled')
  assert.equal(uninstalled.value.stopped, true)
  assert.equal(uninstalled.value.filesRemoved, true)
  assert.equal(fs.existsSync(layout.localInstall), false, 'Local installed command entry must disappear')
  await waitForListener(localPort, false)
  assert.deepEqual(stableHubManifest(layout.localHub), preservedBefore, 'Local uninstall must preserve Hub user data')
  const inactiveMarker = parseJson(
    fs.readFileSync(path.join(layout.localHub, '.skill-graft-data-root.json'), 'utf8'),
    'Local inactive marker'
  )
  assert.equal(inactiveMarker.activeInstallId, null)

  const purgePlan = runCliJson(local.b.cli, [
    'purge', '--data-root', layout.localHub, '--dry-run', '--json'
  ], env, 'local-purge-dry-run')
  assert.equal(purgePlan.value.ok, true, JSON.stringify(purgePlan.value.issues || []))
  assert.equal(purgePlan.value.status, 'planned')
  const purge = runCliJson(local.b.cli, [
    'purge', '--data-root', layout.localHub, '--commit',
    '--data-root-id', purgePlan.value.plan.dataRootId,
    '--plan-hash', purgePlan.value.plan.planHash,
    '--json'
  ], env, 'local-purge-commit')
  assert.equal(purge.value.ok, true, JSON.stringify(purge.value.issues || []))
  assert.equal(purge.value.status, 'purged')
  runtimeState.local.purged = true
  assert.equal(fs.existsSync(layout.localHub), false, 'the sole Local purge must remove only its run-id data root')

  return {
    home: layout.home,
    hub: layout.localHub,
    installedVersions: [VERSION_A, VERSION_B],
    setup: { ok: setup.value.ok, listenerPids: setupListeners },
    status: { ok: status.value.ok, handler: status.value.meta?.handler },
    doctor: { integratedWithSetup: true, ok: setup.value.doctor?.ok === true },
    upgrade: { dryRun: upgradeDry.value.status, status: upgraded.value.status },
    downgrade: {
      rejected: true,
      exitCode: downgrade.result.status,
      authorityPreserved: true
    },
    uninstall: {
      status: uninstalled.value.status,
      commandEntryRemoved: !fs.existsSync(layout.localInstall),
      hubPreservedBeforePurge: true,
      listenerReleased: listeners(localPort).length === 0
    },
    purge: { dryRun: purgePlan.value.status, status: purge.value.status, commitCount: 1 }
  }
}

function spawnBatch(executable, args, { cwd, env }) {
  const invocation = batchInvocation(executable, args, env)
  return spawn(invocation.command, invocation.args, {
    cwd,
    env,
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function windowsProcess(pid) {
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(pid)}" -ErrorAction SilentlyContinue`,
    'if ($null -eq $p) { exit 3 }',
    '$p | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'
  ].join('; ')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000
  })
  if (result.status === 3 || !String(result.stdout || '').trim()) return null
  if (result.status !== 0) throw new Error(`cannot inspect process ${pid}: ${result.stderr || result.stdout}`)
  return parseJson(result.stdout, `process ${pid}`)
}

async function stopOwnedProfile(profile, label) {
  if (!profile || profile.exitCode != null || profile.signalCode != null) return
  const current = windowsProcess(profile.pid)
  if (!current || !String(current.CommandLine || '').toLowerCase().includes(runId.toLowerCase())) {
    throw new Error(`refusing to stop ${label} without the P10 run-id in its command line`)
  }
  const result = spawnSync('taskkill.exe', ['/PID', String(profile.pid), '/T', '/F'], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000
  })
  if (result.status !== 0 && windowsProcess(profile.pid)) {
    throw new Error(`cannot stop ${label}: ${result.stderr || result.stdout}`)
  }
  const deadline = Date.now() + 30_000
  while (profile.exitCode == null && profile.signalCode == null && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  if (profile.exitCode == null && profile.signalCode == null) throw new Error(`${label} did not exit`)
}

function collectBounded(stream, limit = 256 * 1024) {
  let value = ''
  stream?.on('data', chunk => { value = tail(value + chunk, limit) })
  return () => value
}

async function waitForWeb(profile, port) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (profile.exitCode != null || profile.signalCode != null) throw new Error('DSH profile exited before Web readiness')
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) })
      if (response.status === 200 && (await response.text()).length > 0) return
    } catch {
      // Readiness polling is not a business-RPC retry.
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('DSH profile did not reach Web readiness')
}

async function dshStatusAttempt(port, attempt) {
  const requestId = `${runId}-dsh-status-${attempt}`
  const at = new Date().toISOString()
  try {
    const message = {
      type: 'client-request',
      rpcId: requestId,
      method: 'execute',
      payload: { command: { kind: 'status', meta: { requestId } } }
    }
    const response = await fetch(`http://127.0.0.1:${port}/skill-graft/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(15_000)
    })
    const body = await response.text()
    let parsed = null
    let parseError = ''
    if (body) {
      try { parsed = JSON.parse(body) } catch (error) { parseError = error instanceof Error ? error.message : String(error) }
    }
    const success = response.status === 200
      && parsed?.type === 'server-response'
      && parsed?.rpcId === requestId
      && parsed?.result?.ok === true
      && parsed?.result?.value?.ok === true
      && parsed?.result?.value?.meta?.handler === 'application.commandBus'
    const evidence = {
      attempt,
      at,
      httpStatus: response.status,
      bodyBytes: Buffer.byteLength(body, 'utf8'),
      bodySha256: sha256(body),
      parseError,
      success
    }
    writeOwnedJson(path.join(layout.logs, `dsh-status-attempt-${attempt}.json`), {
      ...evidence,
      body: tail(body, 32 * 1024)
    }, `DSH status attempt ${attempt}`)
    return evidence
  } catch (error) {
    const evidence = {
      attempt,
      at,
      httpStatus: null,
      bodyBytes: 0,
      bodySha256: sha256(''),
      parseError: error instanceof Error ? error.message : String(error),
      success: false
    }
    writeOwnedJson(path.join(layout.logs, `dsh-status-attempt-${attempt}.json`), evidence, `DSH status attempt ${attempt}`)
    return evidence
  }
}

async function startDshProfile(env, port, runtimePatch, label, runtimeState) {
  const profile = spawnBatch(pnpmCommand, [
    'run', 'dsh', '--profile', 'web', '--patch', runtimePatch,
    '--host', '127.0.0.1', '--port', String(port)
  ], { cwd: harnessRoot, env })
  const stdout = collectBounded(profile.stdout)
  const stderr = collectBounded(profile.stderr)
  profile.once('error', error => { runtimeState.profileSpawnError = error.message })
  runtimeState.dshProfile = { profile, stdout, stderr, label }
  await waitForWeb(profile, port)
  await waitForListener(port, true)
  return runtimeState.dshProfile
}

async function finishDshProfile(runtimeState) {
  const owned = runtimeState.dshProfile
  if (!owned) return
  try {
    await stopOwnedProfile(owned.profile, owned.label)
  } finally {
    writeOwnedFile(path.join(layout.logs, `${owned.label}.stdout.log`), owned.stdout(), {
      encoding: 'utf8', label: `${owned.label} stdout`
    })
    writeOwnedFile(path.join(layout.logs, `${owned.label}.stderr.log`), owned.stderr(), {
      encoding: 'utf8', label: `${owned.label} stderr`
    })
    runtimeState.dshProfile = null
  }
}

async function runDshGate(packages, baseEnv, dshPort, runtimeState) {
  const env = dshEnvironment(withoutHostEntries(baseEnv, ['sg', 'dsh']))
  for (const directory of [env.HOME, env.APPDATA, env.LOCALAPPDATA, env.XDG_CONFIG_HOME, layout.dshHub]) {
    ensureOwnedDirectory(directory, 'DSH isolated environment')
  }
  assert.deepEqual(commandPaths('sg', env), [], 'DSH PATH must not resolve an external sg')
  assert.deepEqual(commandPaths('dsh', env), [], 'DSH PATH must not resolve an external dsh')

  runPnpm(['run', 'dsh', 'plugin', '--profile', 'web', 'add', packages.dshA.file], {
    cwd: harnessRoot, env, label: 'dsh-add-a'
  })
  runtimeState.dshAdded = true
  const dumpA = runPnpm(['run', 'dsh', '--profile', 'web', '--dump-config'], {
    cwd: harnessRoot, env, label: 'dsh-dump-a', timeout: 5 * 60 * 1000
  })
  assert.match(dumpA.stdout, /@ozdqp\/skill-graft-dsh/)
  const packageLink = path.join(layout.dshHome, 'profiles', 'web', 'node_modules', '@ozdqp', 'skill-graft-dsh')
  assert.equal(fs.existsSync(packageLink), true, 'DSH A installed package entry exists')
  const packageRootA = fs.realpathSync.native(packageLink)
  assert.equal(isInside(layout.dshHome, packageRootA), true, 'DSH A resolves inside isolated DSH_HOME')
  assert.equal(parseJson(fs.readFileSync(path.join(packageRootA, 'package.json'), 'utf8'), 'installed DSH A').version, VERSION_A)
  assert.equal(fs.existsSync(path.join(packageRootA, 'src')), false, 'installed DSH A has no source')

  const runtimePatch = path.join(runRoot, `${runId}-runtime.patch.yml`)
  writeOwnedFile(runtimePatch, [
    '- id: skill-graft-dsh',
    '  config:',
    `    dataRoot: '${layout.dshHub.replaceAll('\\', '/')}'`,
    "    workspace: ''",
    '    autoSync: off',
    '    lockTimeoutMs: 30000',
    '    logLevel: info',
    ''
  ].join('\n'), { encoding: 'utf8', label: 'DSH runtime patch' })

  await startDshProfile(env, dshPort, runtimePatch, 'dsh-profile-a', runtimeState)
  const rpcAttempts = [await dshStatusAttempt(dshPort, 1)]
  if (!rpcAttempts[0].success) {
    await new Promise(resolve => setTimeout(resolve, 750))
    rpcAttempts.push(await dshStatusAttempt(dshPort, 2))
  }
  await finishDshProfile(runtimeState)
  await waitForListener(dshPort, false)

  runPnpm(['run', 'dsh', 'plugin', '--profile', 'web', 'add', packages.dshB.file], {
    cwd: harnessRoot, env, label: 'dsh-upgrade-b'
  })
  const dumpB = runPnpm(['run', 'dsh', '--profile', 'web', '--dump-config'], {
    cwd: harnessRoot, env, label: 'dsh-dump-b', timeout: 5 * 60 * 1000
  })
  assert.match(dumpB.stdout, /@ozdqp\/skill-graft-dsh/)
  const packageRootB = fs.realpathSync.native(packageLink)
  assert.equal(isInside(layout.dshHome, packageRootB), true, 'DSH B resolves inside isolated DSH_HOME')
  assert.equal(parseJson(fs.readFileSync(path.join(packageRootB, 'package.json'), 'utf8'), 'installed DSH B').version, VERSION_B)

  await startDshProfile(env, dshPort, runtimePatch, 'dsh-profile-b', runtimeState)
  await finishDshProfile(runtimeState)
  await waitForListener(dshPort, false)
  const hubBeforeRemove = treeManifest(layout.dshHub)
  runtimeState.dshRemoveAttempted = true
  runPnpm(['run', 'dsh', 'plugin', '--profile', 'web', 'remove', DSH_PACKAGE], {
    cwd: harnessRoot, env, label: 'dsh-remove-b'
  })
  runtimeState.dshAdded = false
  const dumpRemoved = runPnpm(['run', 'dsh', '--profile', 'web', '--dump-config'], {
    cwd: harnessRoot, env, label: 'dsh-dump-removed', timeout: 5 * 60 * 1000
  })
  assert.doesNotMatch(dumpRemoved.stdout, /@ozdqp\/skill-graft-dsh/)
  assert.equal(fs.existsSync(packageLink), false, 'DSH package entry must disappear after remove')
  assert.deepEqual(treeManifest(layout.dshHub), hubBeforeRemove, 'DSH remove must preserve Hub data')

  const rpcVerified = rpcAttempts.some(attempt => attempt.success)
  return {
    home: layout.dshHome,
    hub: layout.dshHub,
    pathIndependent: true,
    addA: true,
    installedVersions: [VERSION_A, VERSION_B],
    rpc: {
      verified: rpcVerified,
      attempts: rpcAttempts,
      limitation: rpcVerified ? null : 'installed DSH profile reached Web readiness but status RPC did not return a valid Application envelope after one attempt and one minimal retry',
      fallbackUsed: false
    },
    upgradeB: true,
    remove: {
      completed: true,
      packageEntryRemoved: !fs.existsSync(packageLink),
      hubPreserved: true,
      listenerReleased: listeners(dshPort).length === 0
    }
  }
}

function runOwnedProcesses() {
  const escapedRunId = runId.replaceAll("'", "''")
  const escapedRoot = runRoot.replaceAll("'", "''")
  const script = [
    "$rows = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -in @('node.exe','cmd.exe','dsh.exe','pnpm.exe','wscript.exe') }",
    `$rows | Where-Object { [string]$_.CommandLine -like '*${escapedRunId}*' -and [string]$_.CommandLine -like '*${escapedRoot}*' } | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress`
  ].join('; ')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000
  })
  if (result.status !== 0) throw new Error(`cannot enumerate P10-owned processes: ${result.stderr || result.stdout}`)
  const output = String(result.stdout || '').trim()
  if (!output) return []
  const parsed = parseJson(output, 'P10-owned process inventory')
  return Array.isArray(parsed) ? parsed : [parsed]
}

function stopRunOwnedProcesses() {
  const errors = []
  for (const processInfo of runOwnedProcesses()) {
    const pid = Number(processInfo.ProcessId)
    const commandLine = String(processInfo.CommandLine || '')
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid
      || !commandLine.toLowerCase().includes(runId.toLowerCase())
      || !commandLine.toLowerCase().includes(runRoot.toLowerCase())) {
      errors.push(`refused process ${pid}`)
      continue
    }
    const killed = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      encoding: 'utf8', windowsHide: true, timeout: 30_000
    })
    if (killed.status !== 0 && windowsProcess(pid)) errors.push(`PID ${pid}: ${killed.stderr || killed.stdout}`)
  }
  if (errors.length > 0) throw new Error(`owned process cleanup failed: ${errors.join('; ')}`)
}

function applicationLeaseRoot(dataRoot) {
  const absolute = path.resolve(dataRoot)
  const suffix = []
  let cursor = absolute
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor)
    if (samePath(parent, cursor)) break
    suffix.unshift(path.basename(cursor))
    cursor = parent
  }
  const realAncestor = fs.existsSync(cursor) ? fs.realpathSync.native(cursor) : cursor
  const canonical = path.resolve(realAncestor, ...suffix)
  const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical
  const digest = createHash('sha256').update(key).digest('hex')
  return path.join(path.dirname(canonical), `.skill-graft-application-locks-${digest}`)
}

function finalResidue(localPort, dshPort) {
  const localLease = applicationLeaseRoot(layout.localHub)
  const dshLease = applicationLeaseRoot(layout.dshHub)
  const facts = {
    processes: runOwnedProcesses(),
    listeners: {
      local: listeners(localPort),
      dsh: listeners(dshPort),
      fixed18765ObservedOnly: listeners(18765)
    },
    leases: {
      local: treeManifest(path.join(localLease, 'leases')),
      dsh: treeManifest(path.join(dshLease, 'leases'))
    },
    transactions: {
      localHub: treeManifest(path.join(layout.localHub, '.skill-graft-transactions')),
      dshHub: treeManifest(path.join(layout.dshHub, '.skill-graft-transactions'))
    },
    lifecycle: {
      lock: fs.existsSync(`${layout.localHub}.lifecycle.lock`),
      wal: fs.existsSync(`${layout.localHub}.lifecycle-wal.json`),
      purgeWal: fs.existsSync(`${layout.localHub}.purge-wal-v1.json`),
      rootReceipt: fs.existsSync(path.join(layout.home, '.skill-graft-lifecycle', 'root-receipt-v1.json')),
      installDir: fs.existsSync(layout.localInstall),
      tombstones: fs.readdirSync(runRoot).filter(name => name.startsWith(`${path.basename(layout.localHub)}.purging-`))
    }
  }
  assert.deepEqual(facts.processes, [], 'P10-owned process residue must be zero')
  assert.deepEqual(facts.listeners.local, [], 'Local listener residue must be zero')
  assert.deepEqual(facts.listeners.dsh, [], 'DSH listener residue must be zero')
  assert.deepEqual(facts.leases.local, [], 'Local lease residue must be zero')
  assert.deepEqual(facts.leases.dsh, [], 'DSH lease residue must be zero')
  assert.deepEqual(facts.transactions.localHub, [], 'Local Hub transaction residue must be zero')
  assert.deepEqual(facts.transactions.dshHub, [], 'DSH Hub transaction residue must be zero')
  assert.deepEqual(facts.lifecycle, {
    lock: false,
    wal: false,
    purgeWal: false,
    rootReceipt: false,
    installDir: false,
    tombstones: []
  },
    'Local lifecycle residue must be zero')
  return facts
}

async function bestEffortCleanup(runtimeState, baseEnv) {
  const issues = []
  if (runtimeState.dshProfile) {
    try { await finishDshProfile(runtimeState) } catch (error) { issues.push(`DSH profile: ${error instanceof Error ? error.message : error}`) }
  }
  if (runtimeState.dshAdded && !runtimeState.dshRemoveAttempted) {
    runtimeState.dshRemoveAttempted = true
    try {
      runPnpm(['run', 'dsh', 'plugin', '--profile', 'web', 'remove', DSH_PACKAGE], {
        cwd: harnessRoot,
        env: dshEnvironment(withoutHostEntries(baseEnv, ['sg', 'dsh'])),
        label: 'cleanup-dsh-remove'
      })
      runtimeState.dshAdded = false
    } catch (error) {
      issues.push(`DSH remove: ${error instanceof Error ? error.message : error}`)
    }
  }
  if (runtimeState.local?.setup && !runtimeState.local.uninstallAttempted) {
    runtimeState.local.uninstallAttempted = true
    try {
      let cli = runtimeState.local.activeCli
      const manifestFile = path.join(layout.localInstall, 'install.json')
      if (fs.existsSync(manifestFile)) {
        const version = parseJson(fs.readFileSync(manifestFile, 'utf8'), 'cleanup Local manifest').packageVersion
        cli = version === VERSION_A ? runtimeState.local.a.cli : runtimeState.local.b.cli
      }
      runCliJson(cli, ['uninstall', '--json'], runtimeState.local.env, 'cleanup-local-uninstall')
    } catch (error) {
      issues.push(`Local uninstall: ${error instanceof Error ? error.message : error}`)
    }
  }
  try { stopRunOwnedProcesses() } catch (error) { issues.push(error instanceof Error ? error.message : String(error)) }
  return issues
}

async function main() {
  const summary = {
    schemaVersion: 1,
    phase: 'P10',
    status: 'running',
    run: { id: runId, root: runRoot, sourceRoot, harnessRoot, startedAt: new Date().toISOString() },
    versions: { a: VERSION_A, b: VERSION_B },
    packages: null,
    protection: null,
    local: null,
    dsh: null,
    cleanup: null,
    evidence: { real: [], fallback: [], unverified: [] },
    failure: null
  }
  const runtimeState = {
    dshProfile: null,
    dshAdded: false,
    dshRemoveAttempted: false,
    local: null,
    profileSpawnError: ''
  }
  let baseEnv
  let protectedRoots = []
  let protectedBefore = []
  let localPort = 0
  let dshPort = 0
  try {
    assertPlainDirectory(sourceRoot, 'P10 source root')
    assertPlainDirectory(harnessRoot, 'DeepSeek Harness root')
    baseEnv = scrubEnvironment(process.env)
    protectedRoots = collectProtectedRoots(baseEnv)
    assertFreshRunRoot(protectedRoots)
    createRunLayout()
    protectedBefore = fingerprintProtectedRoots(protectedRoots, baseEnv)
    writeOwnedJson(path.join(layout.logs, 'protected-before.json'), protectedBefore, 'protected root baseline')
    const rejection = expectedProtectionRejection(protectedRoots)
    summary.protection = { roots: protectedRoots, rejection, before: protectedBefore, after: null, unchanged: false }

    localPort = await getAvailableLoopbackPort({ forbidden: [18765, 3080] })
    dshPort = await getAvailableLoopbackPort({ forbidden: [18765, 3080, localPort] })
    const staged = stagePackages(baseEnv)
    summary.packages = {
      ...staged.packages,
      audits: staged.audits,
      preparedRelease: staged.preparedRelease
    }

    summary.local = await runLocalGate(staged.packages, baseEnv, localPort, runtimeState)
    summary.evidence.real.push(
      'Local A installed setup (integrated doctor) and status through the source-tree-external CLI',
      'Local A to B lifecycle upgrade',
      'Local B to A semver downgrade rejection with exact authority preservation',
      'Local uninstall preservation and one marker-owned purge'
    )

    summary.dsh = await runDshGate(staged.packages, baseEnv, dshPort, runtimeState)
    summary.evidence.real.push('DSH tgz A add, B upgrade, profile lifecycle, remove, and Hub preservation')
    if (summary.dsh.rpc.verified) {
      summary.evidence.real.push('installed DSH profile status RPC through application.commandBus')
    } else {
      summary.evidence.unverified.push(summary.dsh.rpc.limitation)
    }
    summary.evidence.unverified.push('real Codex and real DSH provider sessions were intentionally excluded from this minimal release lifecycle gate')

    summary.cleanup = finalResidue(localPort, dshPort)
    const protectedAfter = fingerprintProtectedRoots(protectedRoots, baseEnv)
    writeOwnedJson(path.join(layout.logs, 'protected-after.json'), protectedAfter, 'protected root final fingerprint')
    assert.deepEqual(protectedAfter, protectedBefore, 'all protected-root fingerprints must remain unchanged')
    summary.protection.after = protectedAfter
    summary.protection.unchanged = true
    summary.status = summary.dsh.rpc.verified ? 'passed' : 'completed-with-dsh-rpc-limitation'
  } catch (error) {
    summary.status = 'failed'
    summary.failure = { message: error instanceof Error ? error.message : String(error) }
    process.exitCode = 1
  } finally {
    if (baseEnv) {
      const cleanupIssues = await bestEffortCleanup(runtimeState, baseEnv)
      if (cleanupIssues.length > 0) {
        summary.failure ||= { message: 'one or more owned cleanup operations failed' }
        summary.failure.cleanupIssues = cleanupIssues
        summary.status = 'failed'
        process.exitCode = 1
      }
      if (layout.logs && fs.existsSync(layout.logs)) {
        try {
          if (!summary.protection?.after && protectedRoots.length > 0) {
            const protectedAfter = fingerprintProtectedRoots(protectedRoots, baseEnv)
            summary.protection ||= { roots: protectedRoots, rejection: null, before: protectedBefore }
            summary.protection.after = protectedAfter
            summary.protection.unchanged = JSON.stringify(protectedAfter) === JSON.stringify(protectedBefore)
          }
        } catch (error) {
          summary.failure ||= { message: 'protected-root final fingerprint failed' }
          summary.failure.protection = error instanceof Error ? error.message : String(error)
          summary.status = 'failed'
          process.exitCode = 1
        }
      }
    }
    summary.run.finishedAt = new Date().toISOString()
    if (fs.existsSync(layout.logs)) {
      writeOwnedJson(path.join(layout.logs, 'summary.json'), summary, 'P10 final summary')
      process.stdout.write(`P10_SUMMARY ${path.join(layout.logs, 'summary.json')}\n`)
    }
  }
}

await main()
