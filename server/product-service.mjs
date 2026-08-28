/**
 * Skill Graft product-facing service layer.
 *
 * This module intentionally sits beside (rather than inside) the existing
 * command transport. It gives the product UI a small, user-facing contract
 * while reusing the existing Application command bus for Codex sessions and
 * worktree materialization.
 *
 * Contract summary
 * - All state owned by this service is below <dataRoot>/product/.
 * - Workspace analysis is read-only. Workspace writes happen only through
 *   takeover/apply and takeover/rollback after an explicit request.
 * - JSON writes are atomic and every returned object is JSON-serialisable.
 * - Product routes use paths without the `/api/product` prefix below; the
 *   HTTP adapter may mount this handler at `/api/product`.
 * - Unknown routes throw an Error carrying `status` and `code`.
 *
 * Routes
 * GET  /overview
 * POST /pick-folder
 * POST /analyze
 * POST /workspace/check (analyze and report changes for an observed workspace)
 * POST /library/initialize
 * GET  /library
 * GET  /library/file
 * POST /library/draft
 *       body may use comparisonId or { planId, versionId?, paths? } for a manual draft
 * POST /compare
 *       also accepts { planId, fromVersion, toVersion } for center-version diffs
 * POST /version/compare
 * GET  /draft
 * GET  /comparison
 * POST /draft/file
 * POST /draft/confirm
 * POST /draft/ai
 * POST /draft/commit
 * POST /version/rollback/preview
 * POST /version/rollback
 * POST /workspace/complete-connection
 * POST /takeover/preview
 * POST /takeover/apply
 * POST /takeover/rollback
 * POST /chat
 * GET  /chat/status
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolvePersistedSelectionReference } from '../panel/lib/selection-flow.mjs'

const execFileAsync = promisify(execFile)

const SCHEMA_VERSION = 1
const MAX_ANALYSIS_DEPTH = 8
const MAX_ANALYSIS_ENTRIES = 150000
const MAX_ANALYSIS_FILE_BYTES = 4 * 1024 * 1024
const MAX_INLINE_BYTES = 256 * 1024
const MAX_CHAT_BYTES = 128 * 1024
const MAX_CHAT_LIBRARY_PATHS = 120
const MAX_CHAT_LIBRARY_SYSTEMS = 24
const MAX_CHAT_LIBRARY_SOURCES_PER_SYSTEM = 6
const SKIP_DIRS = new Set(['.git', 'node_modules', 'Library', 'Temp', 'obj', 'bin'])
const HOST_ROOTS = ['.agents', '.claude', '.cursor', '.codex']
const TAKEOVER_PROJECTION_ROOTS = [
  ['.agents', 'skills'],
  ['.claude', 'skills'],
  ['.cursor', 'skills'],
  ['.codex', 'skills'],
  ['skills'],
  ['agent_skills']
]
const TAKEOVER_SKILL_PROJECTION_PATHS = [
  '.agents/skills', '.claude/skills', '.cursor/skills', '.codex/skills', 'skills'
]
// These are exact names of generated/cache locations.  Do not use a
// substring/regex over a skill name: `cache-control` and `backup-plans` are
// valid, user-authored Skill directories.
const CACHE_DIRECTORY_NAMES = new Set([
  '__pycache__', '.pytest_cache', '.ruff_cache', 'packagecache', 'library',
  'temp', 'tmp', 'logs', 'bundles', 'localdata', 'pcdownload', 'usersettings',
  'cache', 'caches', 'backup', 'backups'
])
const CACHE_FILE_EXTENSIONS = new Set(['.pyc', '.pyo'])
const HISTORICAL_BACKUP_NAME = /^(?:local-overlay\.pre-hub-|pre-hub-)[0-9a-z][0-9a-z._-]*$/iu
const PRIVATE_MARKER = /(?:^|[\\/])(?:tools[\\/]aigametesting|agent_skills)(?:[\\/]|$)/i

function serviceError(status, code, message, details) {
  const error = new Error(message)
  error.status = status
  error.code = code
  if (details !== undefined) error.details = details
  return error
}

function bad(message, code = 'PRODUCT_INVALID_ARGUMENT', details) {
  return serviceError(400, code, message, details)
}

function notFound(message, code = 'PRODUCT_NOT_FOUND') {
  return serviceError(404, code, message)
}

function conflict(message, code = 'PRODUCT_CONFLICT', details) {
  return serviceError(409, code, message, details)
}

function text(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function requiredText(value, label) {
  const result = text(value).trim()
  if (!result) throw bad(`${label} is required`)
  return result
}

function bool(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback
}

function nowIso() {
  return new Date().toISOString()
}

function randomId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`
}

function hashBytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function hashText(value) {
  return hashBytes(Buffer.from(String(value || ''), 'utf8'))
}

function canonicalText(value) {
  return String(value || '').replace(/\r\n/gu, '\n').replace(/\r/gu, '\n')
}

function contentHash(value) {
  return hashBytes(Buffer.from(canonicalText(value), 'utf8'))
}

function stableJson(value) {
  return JSON.stringify(value, Object.keys(value || {}).sort())
}

function hashJson(value) {
  return hashText(JSON.stringify(value))
}

function normalizeRelative(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  let normalized = value.trim().replaceAll('\\', '/')
  while (normalized.startsWith('./')) normalized = normalized.slice(2)
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return null
  const segments = normalized.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null
  if (segments.some((segment) => /[<>:"|?*\u0000-\u001f\u007f]/u.test(segment))) return null
  if (segments.some((segment) => /[ .]$/u.test(segment))) return null
  if (segments.some((segment) => /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu.test(segment))) return null
  return segments.join('/')
}

function portableKey(value) {
  return String(value).replaceAll('\\', '/').toLocaleLowerCase('en-US')
}

function physicalIdentityKey(value) {
  const resolved = path.resolve(String(value || '')).replaceAll('\\', '/')
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved
}

function inside(root, target) {
  const a = path.resolve(root)
  const b = path.resolve(target)
  const folded = process.platform === 'win32' ? (value) => value.toLowerCase() : (value) => value
  const left = folded(a)
  const right = folded(b)
  return right === left || right.startsWith(`${left}${path.sep}`)
}

function assertInside(root, target, label = 'path') {
  if (!inside(root, target)) throw bad(`${label} escapes product storage`, 'PRODUCT_PATH_ESCAPE')
  return target
}

function productPath(productRoot, ...parts) {
  const result = path.resolve(productRoot, ...parts)
  return assertInside(productRoot, result, 'product path')
}

function workspacePath(root, relative) {
  const normalized = normalizeRelative(relative)
  if (!normalized) throw bad(`unsafe relative path: ${relative}`, 'PRODUCT_PATH_ESCAPE')
  return assertInside(root, path.resolve(root, ...normalized.split('/')), 'workspace path')
}

async function exists(target) {
  try {
    await fsp.lstat(target)
    return true
  } catch {
    return false
  }
}

async function lstatOrNull(target) {
  try { return await fsp.lstat(target) } catch { return null }
}

async function readJson(file, fallback) {
  try {
    const value = JSON.parse(await fsp.readFile(file, 'utf8'))
    return value
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw serviceError(500, 'PRODUCT_STATE_INVALID', `cannot read ${path.basename(file)}`)
  }
}

async function atomicJson(file, value, productRoot) {
  assertInside(productRoot, file, 'JSON path')
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomId('tmp')}.json`
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  try {
    await fsp.rename(temporary, file)
  } catch (error) {
    if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') throw error
    // Windows can reject rename-over-existing. The temporary file is already
    // complete; replace the target only after it has been fully written.
    await fsp.rm(file, { force: true })
    await fsp.rename(temporary, file)
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => {})
  }
}

async function atomicBytes(file, value, root) {
  assertInside(root, file, 'file path')
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomId('tmp')}.bin`
  await fsp.writeFile(temporary, value)
  try {
    await fsp.rename(temporary, file)
  } catch (error) {
    if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') throw error
    await fsp.rm(file, { force: true })
    await fsp.rename(temporary, file)
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => {})
  }
}

async function safeExternalWrite(file, value, root) {
  if (!inside(root, file)) throw bad('takeover target escapes the selected worktree', 'PRODUCT_PATH_ESCAPE')
  const relative = path.relative(root, file)
  const segments = relative.split(path.sep)
  let current = root
  for (let index = 0; index < segments.length - 1; index += 1) {
    current = path.join(current, segments[index])
    const stat = await lstatOrNull(current)
    if (stat?.isSymbolicLink()) throw conflict(`takeover path crosses a link: ${relative}`, 'PRODUCT_EXTERNAL_LINK')
  }
  const existing = await lstatOrNull(file)
  if (existing?.isSymbolicLink()) throw conflict(`takeover target is a link: ${relative}`, 'PRODUCT_EXTERNAL_LINK')
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await atomicExternalReplace(file, value)
}

async function atomicExternalReplace(file, value) {
  const temporary = `${file}.${randomId('takeover')}.tmp`
  await fsp.writeFile(temporary, value)
  try {
    await fsp.rename(temporary, file)
  } catch (error) {
    if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') throw error
    await fsp.rm(file, { force: true })
    await fsp.rename(temporary, file)
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => {})
  }
}

async function readSmallFile(file, maxBytes = MAX_ANALYSIS_FILE_BYTES) {
  const stat = await lstatOrNull(file)
  if (!stat || !stat.isFile()) return { exists: false, size: 0, hash: null, content: null }
  if (stat.size > maxBytes) {
    const digest = crypto.createHash('sha256')
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(file)
      stream.on('data', (chunk) => digest.update(chunk))
      stream.on('end', resolve)
      stream.on('error', reject)
    })
    return { exists: true, size: stat.size, hash: digest.digest('hex'), content: null, tooLarge: true }
  }
  const bytes = await fsp.readFile(file)
  const content = bytes.toString('utf8')
  return { exists: true, size: stat.size, hash: contentHash(content), content }
}

async function readFileOrEmpty(file) {
  try { return await fsp.readFile(file, 'utf8') } catch (error) {
    if (error?.code === 'ENOENT') return ''
    throw error
  }
}

function contentPreview(value) {
  const raw = String(value || '')
  if (Buffer.byteLength(raw, 'utf8') <= MAX_INLINE_BYTES) return { value: raw, truncated: false }
  return { value: Buffer.from(raw, 'utf8').subarray(0, MAX_INLINE_BYTES).toString('utf8'), truncated: true }
}

function diffLines(oldContent, newContent) {
  const oldLines = String(oldContent || '').split(/\r?\n/)
  const newLines = String(newContent || '').split(/\r?\n/)
  const max = 5000
  if (oldLines.length > max || newLines.length > max) {
    return [{ type: 'replace', oldLine: null, newLine: null, text: '文件过大，打开文件后查看完整内容' }]
  }
  const rows = oldLines.length
  const cols = newLines.length
  const table = Array.from({ length: rows + 1 }, () => new Uint32Array(cols + 1))
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i][j] = oldLines[i] === newLines[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const result = []
  let i = 0
  let j = 0
  let oldNo = 1
  let newNo = 1
  while (i < rows && j < cols) {
    if (oldLines[i] === newLines[j]) {
      result.push({ type: 'context', oldLine: oldNo++, newLine: newNo++, text: oldLines[i] })
      i += 1; j += 1
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      result.push({ type: 'remove', oldLine: oldNo++, newLine: null, text: oldLines[i++] })
    } else {
      result.push({ type: 'add', oldLine: null, newLine: newNo++, text: newLines[j++] })
    }
  }
  while (i < rows) result.push({ type: 'remove', oldLine: oldNo++, newLine: null, text: oldLines[i++] })
  while (j < cols) result.push({ type: 'add', oldLine: null, newLine: newNo++, text: newLines[j++] })
  return result
}

function fileId(relative) {
  return `file-${hashText(relative).slice(0, 16)}`
}

function systemId(relative, kind = 'skill') {
  return `system-${hashText(`${kind}:${relative}`).slice(0, 16)}`
}

function statusForPath(relative) {
  if (PRIVATE_MARKER.test(relative)) return { status: 'keep-private', kind: 'private' }
  if (artifactInfo(relative)) return { status: 'reference-only', kind: 'cache' }
  return { status: 'active', kind: 'active' }
}

function isCacheDirectoryName(value) {
  const name = String(value || '').trim().toLocaleLowerCase('en-US')
  return CACHE_DIRECTORY_NAMES.has(name) || HISTORICAL_BACKUP_NAME.test(name)
}

function isSkillProjectionChild(parts, index) {
  const parent = String(parts[index - 1] || '').toLocaleLowerCase('en-US')
  if (!/^(?:skills|agent_skills)$/u.test(parent)) return false
  const host = String(parts[index - 2] || '').toLocaleLowerCase('en-US')
  return index < 2 || HOST_ROOTS.includes(host)
}

function artifactInfo(relative) {
  const normalized = String(relative || '').replaceAll('\\', '/').replace(/^\.\//u, '')
  const parts = normalized.split('/').filter(Boolean)
  const basename = (parts.at(-1) || '').toLocaleLowerCase('en-US')
  if (CACHE_FILE_EXTENSIONS.has(path.posix.extname(basename))) {
    return { kind: 'cache', reason: '编译缓存文件' }
  }
  if (parts.some((part, index) => isCacheDirectoryName(part) && !isSkillProjectionChild(parts, index))) {
    return { kind: 'cache', reason: '缓存或备份目录' }
  }
  return null
}

function externalLinkRecord(relative, absolute, canonicalTarget, physicalBoundary = absolute) {
  const normalized = normalizeRelative(relative) || String(relative || '').replaceAll('\\', '/')
  return {
    id: fileId(`external-link:${normalized}`),
    path: normalized,
    logicalPath: logicalFilePath(normalized),
    physicalPath: normalized,
    sourcePath: path.resolve(absolute),
    physicalBoundary: path.resolve(physicalBoundary || absolute),
    size: 0,
    contentHash: null,
    canonicalTarget: canonicalTarget || null,
    alias: true,
    external: true,
    stored: false,
    referenceOnly: true,
    evidenceOnly: true,
    linkKind: 'junction-or-symlink',
    unavailableReason: '工作区外部链接已阻止，未读取链接目标内容',
    safeReason: '检测到指向工作区外部的 Junction / 链接。请将目标移入所选工作区，或改用工作区内的规范目录后重试。'
  }
}

function externalLinkIdentity(record) {
  const physical = physicalIdentityKey(record?.physicalBoundary || record?.sourcePath || record?.physicalPath || '')
  const target = physicalIdentityKey(record?.canonicalTarget || '')
  return `${physical}\u0000${target}`
}

function externalLinkPhysicalIdentity(record) {
  return physicalIdentityKey(record?.physicalBoundary || record?.physicalPath || record?.sourcePath || '')
}

async function resolvePhysicalBoundary(workspace, absolute) {
  const resolved = path.resolve(absolute)
  const parent = path.dirname(resolved)
  const canonicalParent = await fsp.realpath(parent).catch(() => parent)
  if (!inside(workspace, canonicalParent)) return resolved
  // Resolve only the parent chain. Keeping the boundary's own name preserves
  // distinct Junction entries even when they point at the same target.
  return path.resolve(canonicalParent, path.basename(resolved))
}

async function externalLinkBoundary(workspace, absolute) {
  const workspaceRoot = path.resolve(workspace)
  let current = path.resolve(absolute)
  while (inside(workspaceRoot, current) && current !== workspaceRoot) {
    const stat = await lstatOrNull(current)
    if (stat?.isSymbolicLink()) {
      const target = await fsp.realpath(current).catch(() => '')
      if (target && !inside(workspaceRoot, target)) {
        return {
          absolute: current,
          physicalBoundary: await resolvePhysicalBoundary(workspaceRoot, current),
          relative: path.relative(workspaceRoot, current).replaceAll('\\', '/'),
          canonicalTarget: target
        }
      }
    }
    current = path.dirname(current)
  }
  return null
}

function workspaceName(workspace) {
  return path.basename(workspace.replace(/[\\/]$/, '')) || workspace
}

function logicalFilePath(relative) {
  const normalized = String(relative || '').replaceAll('\\', '/').replace(/^\.\//u, '')
  const parts = normalized.split('/').filter(Boolean)
  if (/^(?:AGENTS.*\.md|CLAUDE\.md)$/iu.test(parts.at(-1) || '')) return ['rules', ...parts].join('/')
  const privateIndex = parts.findIndex((part) => /^agent_skills$/iu.test(part))
  if (privateIndex >= 0) return ['agent_skills', ...parts.slice(privateIndex + 1)].join('/')
  const hostIndex = parts.findIndex((part) => HOST_ROOTS.includes(part.toLocaleLowerCase('en-US')))
  if (hostIndex >= 0 && /^(?:skills|agent_skills)$/iu.test(parts[hostIndex + 1] || '')) {
    const root = parts[hostIndex + 1].toLocaleLowerCase('en-US') === 'skills' ? 'skills' : 'agent_skills'
    return [root, ...parts.slice(hostIndex + 2)].join('/')
  }
  if (/^skills$/iu.test(parts[0] || '')) return ['skills', ...parts.slice(1)].join('/')
  return normalized
}

// Version manifests created by older service revisions may have stored a
// host projection (`.agents/skills/foo/...`) in `path`, while current
// manifests expose the canonical `skills/foo/...` path.  Keep the on-disk
// location separate from the public logical path so those immutable versions
// remain readable without rewriting them.
function canonicalVersionPath(value) {
  const normalized = normalizeRelative(value)
  if (!normalized) return null
  if (/^(?:skills|agent_skills|rules)\//iu.test(normalized)) return normalized
  return logicalFilePath(normalized)
}

async function gitSkipWorktree(workspace) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', workspace, '-c', 'core.quotepath=false', 'ls-files', '-t', '-z'], {
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024
    })
    const missing = []
    const rows = String(stdout || '').split('\0').filter(Boolean)
    for (const row of rows) {
      const flag = row.slice(0, 1)
      const relative = normalizeRelative(row.slice(1).trim())
      if (flag !== 'S' || !relative) continue
      if (!(await exists(workspacePath(workspace, relative)))) missing.push(relative)
    }
    return missing
  } catch {
    return []
  }
}

async function gitDirtyPaths(workspace) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', workspace, 'status', '--porcelain=v1', '-z'], {
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024
    })
    const paths = new Set()
    const rows = String(stdout || '').split('\0')
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]
      if (!row || row.length < 4) continue
      const value = row.slice(3)
      const relative = normalizeRelative(value)
      if (relative) paths.add(relative)
      // Rename/copy records carry an additional NUL-delimited old path.
      if (/^[RC]/u.test(row.slice(0, 2)) && rows[index + 1]) {
        const oldPath = normalizeRelative(rows[++index])
        if (oldPath) paths.add(oldPath)
      }
    }
    return paths
  } catch {
    return new Set()
  }
}

async function findNamed(workspace, names, maxDepth = MAX_ANALYSIS_DEPTH) {
  const found = []
  let visited = 0
  async function walk(relative, depth) {
    if (depth > maxDepth || visited >= MAX_ANALYSIS_ENTRIES) return
    const absolute = relative ? workspacePath(workspace, relative) : workspace
    const stat = await lstatOrNull(absolute)
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) return
    let entries
    try { entries = await fsp.readdir(absolute, { withFileTypes: true }) } catch { return }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      visited += 1
      if (visited >= MAX_ANALYSIS_ENTRIES) break
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name
      const named = names.some((name) => name(entry.name, childRelative))
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        const childParts = childRelative.replaceAll('\\', '/').split('/').filter(Boolean)
        const childIsSkillName = isSkillProjectionChild(childParts, childParts.length - 1)
        if (isCacheDirectoryName(entry.name) && !childIsSkillName) {
          // Cache/backup folders are evidence only.  They are returned only by
          // the dedicated cache discovery pass (which calls findNamed with no
          // name predicates); otherwise they would masquerade as every kind
          // of requested root, such as `skills` or `agent_skills`.
          if (!names.length) found.push({ relative: childRelative, type: 'directory' })
          continue
        }
        if (named) found.push({ relative: childRelative, type: 'directory' })
        if (!SKIP_DIRS.has(entry.name)) await walk(childRelative, depth + 1)
      } else if (entry.isSymbolicLink() && named) {
        found.push({ relative: childRelative, type: 'directory-alias' })
      } else if (entry.isFile() && named) {
        found.push({ relative: childRelative, type: 'file' })
      }
    }
  }
  await walk('', 0)
  return found
}

async function inspectSystemFiles(workspace, relativeRoot, mode, analysisFiles, options = {}) {
  const root = workspacePath(workspace, relativeRoot)
  const excluded = new Set((options.excludeRoots || []).map((item) => String(item).replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '')))
  const rootStat = await lstatOrNull(root)
  if (!rootStat) return []
  const collected = []
  const visitedReal = new Set()
  let count = 0

  async function walk(relative, absolute, depth) {
    if (depth > MAX_ANALYSIS_DEPTH || count >= MAX_ANALYSIS_ENTRIES) return
    const linkStat = await lstatOrNull(absolute)
    if (!linkStat) return
    const real = await fsp.realpath(absolute).catch(() => '')
    const linked = linkStat.isSymbolicLink()
    const stat = linked ? await fsp.stat(absolute).catch(() => linkStat) : linkStat
    const external = real ? !inside(workspace, real) : false
    if (external) {
      const boundary = await externalLinkBoundary(workspace, absolute)
      const blocked = externalLinkRecord(
        boundary?.relative || relative,
        boundary?.absolute || absolute,
        boundary?.canonicalTarget || real,
        boundary?.physicalBoundary || boundary?.absolute || absolute
      )
      options.externalLinks?.push(blocked)
      collected.push(blocked)
      return
    }
    // External links are keyed by their physical boundary plus canonical
    // target below. Do not collapse two different Junctions merely because
    // they point at the same outside directory; only internal aliases use
    // realpath de-duplication during traversal.
    if (linked && real && visitedReal.has(real)) return
    if (linked && real) visitedReal.add(real)
    const artifact = artifactInfo(relative)
    if (artifact) {
      const evidence = {
        id: fileId(relative),
        path: logicalFilePath(normalizeRelative(relative) || relative),
        logicalPath: logicalFilePath(normalizeRelative(relative) || relative),
        physicalPath: String(relative).replaceAll('\\', '/'),
        sourcePath: path.resolve(absolute),
        size: stat.size || 0,
        contentHash: null,
        canonicalTarget: real || absolute,
        alias: linked,
        external,
        stored: false,
        referenceOnly: true,
        evidenceOnly: true,
        artifactKind: artifact.kind,
        artifactReason: artifact.reason
      }
      options.evidence?.push({ ...evidence, type: stat.isDirectory() ? 'directory' : 'file' })
      return
    }
    if (stat.isDirectory()) {
      const entries = await fsp.readdir(absolute, { withFileTypes: true }).catch(() => [])
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (SKIP_DIRS.has(entry.name)) continue
        const childRelative = `${relative}/${entry.name}`.replace(/^\//u, '')
        if (excluded.has(childRelative.replaceAll('\\', '/'))) continue
        count += 1
        if (count >= MAX_ANALYSIS_ENTRIES) break
        await walk(childRelative, path.join(absolute, entry.name), depth + 1)
      }
      return
    }
    if (!stat.isFile()) return
    const normalized = normalizeRelative(relative)
    if (!normalized) return
    const logicalPath = logicalFilePath(normalized)
    const read = mode === 'reference-only'
      ? { exists: true, size: stat.size, hash: null, content: null, referenceOnly: true }
      : await readSmallFile(absolute)
    const canonicalTarget = real || absolute
    const record = {
      id: fileId(normalized),
      path: logicalPath,
      physicalPath: normalized,
      logicalPath,
      sourcePath: path.resolve(absolute),
      size: read.size,
      contentHash: read.hash,
      canonicalTarget,
      alias: linked,
      external,
      stored: Boolean(read.content !== null && !external && !read.referenceOnly),
      referenceOnly: Boolean(mode === 'reference-only' || external || read.tooLarge),
      tooLarge: Boolean(read.tooLarge)
    }
    if (record.stored) {
      const target = productPath(analysisFiles, ...normalized.split('/'))
      await atomicBytes(target, Buffer.from(read.content, 'utf8'), analysisFiles)
    }
    collected.push(record)
  }
  await walk(relativeRoot, root, 0)
  return collected
}

function addSystem(systems, relative, name, kind, status, projection) {
  const id = systemId(relative, kind)
  let system = systems.get(id)
  if (!system) {
    system = {
      id,
      name,
      kind,
      status,
      sourcePath: relative,
      summary: '',
      fileCount: 0,
      contentHash: null,
      canonicalTarget: null,
      projections: [],
      files: []
    }
    systems.set(id, system)
  }
  if (projection) system.projections.push(projection)
  return system
}

function systemRelativeRoots(rootName, entries) {
  const roots = []
  const skillRoots = entries.filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && /^(?:skills|agent_skills|agents)$/i.test(entry.name))
  for (const root of skillRoots) roots.push(root.name)
  return roots
}

function projectRootFor(relative) {
  const segments = String(relative || '').replaceAll('\\', '/').split('/').filter(Boolean)
  const marker = segments.findIndex((segment) => HOST_ROOTS.includes(segment.toLocaleLowerCase('en-US')))
  if (marker >= 0) return segments.slice(0, marker).join('/')
  const skillMarker = segments.findIndex((segment) => /^(?:skills|agent_skills)$/iu.test(segment))
  if (skillMarker >= 0) return segments.slice(0, skillMarker).join('/')
  return ''
}

function projectRootAbsolute(workspace, relative) {
  return relative ? workspacePath(workspace, relative) : workspace
}

function projectRootForAbsolute(workspace, target) {
  const relative = path.relative(workspace, target).replaceAll('\\', '/')
  return projectRootFor(relative)
}

async function nestedFamilyRoots(absolute, workspaceRoot) {
  const entries = await fsp.readdir(absolute, { withFileTypes: true }).catch(() => [])
  const roots = []
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const candidate = path.join(absolute, entry.name)
    if (entry.isSymbolicLink()) {
      const real = await fsp.realpath(candidate).catch(() => '')
      if (!real || !inside(workspaceRoot, real)) continue
    }
    if (/^unity-skills$/iu.test(entry.name)) roots.push(entry.name)
    else {
      const nested = await fsp.readdir(candidate, { withFileTypes: true }).catch(() => [])
      if (nested.some((item) => (item.isDirectory() || item.isSymbolicLink()) && /^skills$/iu.test(item.name))) roots.push(entry.name)
    }
  }
  return roots
}

async function directoryHasSkillFile(absolute, workspaceRoot, maxDepth = 5) {
  async function walk(current, depth) {
    if (depth > maxDepth) return false
    const currentStat = await lstatOrNull(current)
    if (currentStat?.isSymbolicLink()) {
      const real = await fsp.realpath(current).catch(() => '')
      if (!real || !inside(workspaceRoot, real)) return false
    }
    const entries = await fsp.readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isFile() && /^SKILL\.md$/iu.test(entry.name)) return true
      if (entry.isDirectory() && !entry.isSymbolicLink() && !SKIP_DIRS.has(entry.name) && await walk(path.join(current, entry.name), depth + 1)) return true
    }
    return false
  }
  return walk(absolute, 0)
}

async function analyzeWorkspaceReadOnly(workspaceInput, productRoot, options = {}) {
  const supplied = requiredText(workspaceInput, 'workspacePath')
  const resolved = path.resolve(supplied)
  const stat = await lstatOrNull(resolved)
  if (!stat || !stat.isDirectory()) throw bad('workspacePath must be an existing directory', 'PRODUCT_WORKSPACE_INVALID')
  const canonicalWorkspace = await fsp.realpath(resolved).catch(() => resolved)
  const analysisId = text(options.analysisId).trim() || randomId('analysis')
  const analysisDir = productPath(productRoot, 'analyses', analysisId)
  const analysisFiles = productPath(analysisDir, 'files')
  await fsp.mkdir(analysisFiles, { recursive: true })
  const dirtyPaths = await gitDirtyPaths(canonicalWorkspace)
  const systems = new Map()
  const systemCandidates = []
  const externalLinkEvidence = []

  // Host roots may live below a monorepo/project directory (for example
  // baloot_client/.agents), so discover them recursively rather than only
  // checking the selected workspace root.
  const hostDirs = await findNamed(canonicalWorkspace, [
    (name) => HOST_ROOTS.includes(String(name).toLocaleLowerCase('en-US'))
  ], MAX_ANALYSIS_DEPTH)
  const discoveredHostRoots = new Set()
  for (const entry of hostDirs.filter((item) => item.type === 'directory' || item.type === 'directory-alias')) {
    const hostRoot = path.posix.basename(entry.relative.replaceAll('\\', '/'))
    if (!HOST_ROOTS.includes(hostRoot.toLocaleLowerCase('en-US'))) continue
    const relativeHost = entry.relative.replaceAll('\\', '/')
    if (discoveredHostRoots.has(relativeHost)) continue
    discoveredHostRoots.add(relativeHost)
    const absolute = workspacePath(canonicalWorkspace, relativeHost)
    const rootStat = await lstatOrNull(absolute)
    if (!rootStat) continue
    const rootReal = await fsp.realpath(absolute).catch(() => absolute)
    const realParent = path.dirname(rootReal)
    const canonicalProjectRoot = inside(canonicalWorkspace, realParent)
      ? path.relative(canonicalWorkspace, realParent).replaceAll('\\', '/')
      : projectRootFor(relativeHost)
    const rootEntries = rootStat.isDirectory() && !rootStat.isSymbolicLink()
      ? await fsp.readdir(absolute, { withFileTypes: true }).catch(() => [])
      : []
    const directRoots = systemRelativeRoots(hostRoot, rootEntries)
    if (rootStat.isSymbolicLink() && directRoots.length === 0) {
      if (rootReal && !inside(canonicalWorkspace, rootReal)) {
        externalLinkEvidence.push(externalLinkRecord(
          relativeHost,
          absolute,
          rootReal,
          await resolvePhysicalBoundary(canonicalWorkspace, absolute)
        ))
      }
      const alias = addSystem(systems, relativeHost, `${relativeHost} 别名`, 'alias', 'reference-only', {
        host: hostRoot,
        projectRoot: canonicalProjectRoot,
        path: relativeHost,
        canonicalTarget: rootReal,
        projection: 'junction-or-symlink'
      })
      alias.canonicalTarget = rootReal
      alias.summary = `Junction / 符号链接别名 → ${rootReal}；只作来源证据，不重复纳入`
      continue
    }
    for (const child of directRoots) {
      if (/^agent_skills$/iu.test(child)) continue
      const relative = child ? `${relativeHost}/${child}` : relativeHost
      const childAbsolute = workspacePath(canonicalWorkspace, relative)
      const childReal = await fsp.realpath(childAbsolute).catch(() => childAbsolute)
      const childProjectRoot = projectRootForAbsolute(canonicalWorkspace, childReal) || canonicalProjectRoot
      if (/^skills$/iu.test(child)) {
        const nested = await nestedFamilyRoots(childAbsolute, canonicalWorkspace)
        for (const familyRoot of nested) {
          const familyRelative = `${relative}/${familyRoot}`
          const familyAbsolute = workspacePath(canonicalWorkspace, familyRelative)
          const familyStat = await lstatOrNull(familyAbsolute)
          const familyReal = await fsp.realpath(familyAbsolute).catch(() => familyAbsolute)
          const familyProjectRoot = projectRootForAbsolute(canonicalWorkspace, familyReal) || childProjectRoot
          const policy = statusForPath(familyRelative)
          const system = addSystem(systems, familyRelative, /^unity-skills$/iu.test(familyRoot) ? 'UnitySkills REST' : familyRoot, 'skill', policy.status, {
            host: hostRoot,
            projectRoot: familyProjectRoot,
            familyKey: `nested:${familyRoot.toLocaleLowerCase('en-US')}`,
            path: familyRelative,
            canonicalTarget: familyReal,
            alias: Boolean(familyStat?.isSymbolicLink()),
            projection: hostRoot
          })
          systemCandidates.push({ system, relative: familyRelative, mode: policy.status === 'active' ? 'active' : 'reference-only', familyKey: `nested:${familyRoot.toLocaleLowerCase('en-US')}` })
        }
        const genericRelative = relative
        const genericPolicy = statusForPath(genericRelative)
        const generic = addSystem(systems, genericRelative, `${hostRoot} Skills`, 'skill', genericPolicy.status, {
          host: hostRoot,
          projectRoot: childProjectRoot,
          familyKey: 'host-cli',
          path: genericRelative,
          canonicalTarget: childReal,
          alias: Boolean(rootStat.isSymbolicLink() || (await lstatOrNull(childAbsolute))?.isSymbolicLink()),
          projection: hostRoot
        })
        systemCandidates.push({
          system: generic,
          relative: genericRelative,
          mode: genericPolicy.status === 'active' ? 'active' : 'reference-only',
          familyKey: 'host-cli',
          excludeRoots: nested.map((familyRoot) => `${relative}/${familyRoot}`)
        })
      } else {
        const name = child || hostRoot
        const policy = statusForPath(relative)
        const familyKey = child === 'agents' ? 'host-cli' : `root:${name.toLocaleLowerCase('en-US')}`
        const system = addSystem(systems, relative, name, child === 'agents' ? 'agent' : 'skill', policy.status, {
          host: hostRoot,
          projectRoot: childProjectRoot,
          familyKey,
          path: relative,
          canonicalTarget: child ? childReal : rootReal,
          projection: hostRoot
        })
        systemCandidates.push({ system, relative, mode: policy.status === 'active' ? 'active' : 'reference-only', familyKey })
      }
    }
  }

  // A project may keep its skills directly in `skills/` (outside a host
  // folder). Treat those as a projection of the same project-level system.
  const directSkillDirs = await findNamed(canonicalWorkspace, [
    (name) => String(name).toLocaleLowerCase('en-US') === 'skills'
  ], MAX_ANALYSIS_DEPTH)
  for (const entry of directSkillDirs.filter((item) => item.type === 'directory' || item.type === 'directory-alias')) {
    const relative = entry.relative.replaceAll('\\', '/')
    const parts = relative.split('/').filter(Boolean)
    const hostIndex = parts.findIndex((part) => HOST_ROOTS.includes(part.toLocaleLowerCase('en-US')))
    if (hostIndex >= 0 && /^skills$/iu.test(parts[hostIndex + 1] || '')) continue
    if (systemCandidates.some((candidate) => candidate.relative === relative)) continue
    if (!await directoryHasSkillFile(workspacePath(canonicalWorkspace, relative), canonicalWorkspace)) continue
    const real = await fsp.realpath(workspacePath(canonicalWorkspace, relative)).catch(() => workspacePath(canonicalWorkspace, relative))
    const policy = statusForPath(relative)
    const system = addSystem(systems, relative, path.posix.basename(relative), 'skill', policy.status, {
      host: 'skills',
      projectRoot: projectRootForAbsolute(canonicalWorkspace, real) || projectRootFor(relative),
      familyKey: 'local-skills',
      path: relative,
      canonicalTarget: real,
      projection: 'skills'
    })
    systemCandidates.push({ system, relative, mode: policy.status === 'active' ? 'active' : 'reference-only', familyKey: 'local-skills' })
  }

  const namedAgentRoots = await findNamed(canonicalWorkspace, [
    (name) => name.toLowerCase() === 'agent_skills'
  ])
  for (const candidate of namedAgentRoots.filter((item) => item.type === 'directory' || item.type === 'directory-alias')) {
    const policy = statusForPath(candidate.relative)
    const system = addSystem(systems, candidate.relative, path.basename(candidate.relative), 'private', policy.status === 'active' ? 'keep-private' : policy.status, {
      host: 'agent_skills',
      path: candidate.relative,
      canonicalTarget: await fsp.realpath(workspacePath(canonicalWorkspace, candidate.relative)).catch(() => workspacePath(canonicalWorkspace, candidate.relative)),
      projection: 'agent_skills'
    })
    // Keep the default policy private, but retain a local read-only copy so a
    // user who explicitly selects it can still review or include it later.
    systemCandidates.push({ system, relative: candidate.relative, mode: 'active' })
  }

  const rules = await findNamed(canonicalWorkspace, [
    (name) => /^AGENTS.*\.md$/i.test(name) || /^CLAUDE\.md$/i.test(name)
  ], 7)
  for (const rule of rules.filter((item) => item.type === 'file')) {
    const policy = statusForPath(rule.relative)
    const system = addSystem(systems, rule.relative, path.basename(rule.relative), 'rules', policy.status, {
      host: 'rules', familyKey: 'rules', path: rule.relative, canonicalTarget: path.resolve(canonicalWorkspace, rule.relative), projection: 'rules'
    })
    systemCandidates.push({ system, relative: rule.relative, mode: policy.status === 'active' ? 'active' : 'reference-only', familyKey: 'rules' })
  }

  const locks = await findNamed(canonicalWorkspace, [(name) => name.toLowerCase() === 'skills-lock.json'], 7)
  for (const lock of locks.filter((item) => item.type === 'file')) {
    const policy = statusForPath(lock.relative)
    const system = addSystem(systems, lock.relative, path.basename(lock.relative), 'declaration', 'reference-only', {
      host: 'declaration', path: lock.relative, canonicalTarget: path.resolve(canonicalWorkspace, lock.relative), projection: 'skills-lock'
    })
    // The declaration itself is reference-only in the UI, but it must be read
    // into the analysis store so missing declarations can be identified.
    systemCandidates.push({ system, relative: lock.relative, mode: 'active' })
  }

  const caches = await findNamed(canonicalWorkspace, [], 6)
  const cacheEvidence = new Set(caches.filter((item) => item.type === 'directory').map((item) => item.relative.replaceAll('\\', '/')))
  const cacheEvidenceRecords = []
  const projectRoots = new Set([''])
  for (const relative of discoveredHostRoots) projectRoots.add(projectRootFor(relative))
  for (const candidate of systemCandidates) {
    projectRoots.add(projectRootFor(candidate.relative))
    for (const projection of candidate.system.projections || []) {
      if (projection.projectRoot) projectRoots.add(projection.projectRoot)
    }
  }
  for (const projectRoot of projectRoots) {
    for (const relative of [projectRoot ? `${projectRoot}/Library/PackageCache` : 'Library/PackageCache', projectRoot ? `${projectRoot}/PackageCache` : 'PackageCache']) {
      const normalized = relative.replaceAll('\\', '/')
      if (cacheEvidence.has(normalized)) continue
      const stat = await lstatOrNull(workspacePath(canonicalWorkspace, normalized))
      if (stat?.isDirectory()) cacheEvidence.add(normalized)
    }
  }
  let cacheSystem = null
  if (cacheEvidence.size) {
    cacheSystem = addSystem(systems, 'evidence/cache', '缓存与备份', 'cache', 'reference-only', null)
    for (const relative of [...cacheEvidence].sort()) {
      cacheSystem.projections.push({
        host: 'cache', path: relative, canonicalTarget: path.resolve(canonicalWorkspace, relative), projection: 'cache'
      })
      systemCandidates.push({ system: cacheSystem, relative, mode: 'reference-only', evidenceOnly: true })
    }
  }

  for (const candidate of systemCandidates) {
    const files = candidate.evidenceOnly
      ? [{
        id: fileId(candidate.relative), path: candidate.relative, logicalPath: candidate.relative, physicalPath: candidate.relative,
        sourcePath: path.resolve(canonicalWorkspace, candidate.relative), size: 0, contentHash: null,
        canonicalTarget: path.resolve(canonicalWorkspace, candidate.relative), alias: false, external: false,
        stored: false, referenceOnly: true, evidenceOnly: true, artifactKind: 'cache', artifactReason: '缓存或备份目录'
      }]
      : await inspectSystemFiles(canonicalWorkspace, candidate.relative, candidate.mode, analysisFiles, { excludeRoots: candidate.excludeRoots, evidence: cacheEvidenceRecords, externalLinks: externalLinkEvidence })
    candidate.system.files.push(...files)
    candidate.system.fileCount += files.length
    candidate.system.skillCount = candidate.system.files.filter((file) => /(?:^|\/)SKILL\.md$/iu.test(file.path)).length
    candidate.system.ruleCount = candidate.system.files.filter((file) => /^rules\//iu.test(file.logicalPath || file.path) || /(?:^|\/)(?:AGENTS(?:\.[^/]*)?|CLAUDE)\.md$/iu.test(file.path)).length
    for (const file of files) file.dirty = dirtyPaths.has(file.physicalPath || file.path)
    candidate.system.dirtyFiles = files.filter((file) => dirtyPaths.has(file.physicalPath || file.path)).map((file) => file.path)
    candidate.system.dirty = candidate.system.dirtyFiles.length > 0
    candidate.system.requiresExplicit = candidate.system.dirty
    if (candidate.system.kind === 'private') {
      // Private project systems are selectable only by an explicit user
      // choice, but they are still real candidates rather than evidence.
      candidate.system.selectable = true
      candidate.system.role = 'candidate'
    }
    if (candidate.system.dirty && candidate.system.status === 'active') candidate.system.status = 'keep-private'
    const rootKey = portableKey(candidate.system.sourcePath).replace(/\/$/u, '')
    const hashes = files.map((file) => {
      const fileKey = portableKey(file.path)
      const localKey = fileKey === rootKey ? '' : fileKey.startsWith(`${rootKey}/`) ? fileKey.slice(rootKey.length + 1) : fileKey
      return `${localKey}:${file.contentHash || 'reference'}`
    }).sort().join('|')
    candidate.system.contentHash = hashText(hashes)
    candidate.system.canonicalTarget = candidate.system.projections[0]?.canonicalTarget || null
    candidate.system.summary = `${candidate.system.fileCount} 个文件 · ${candidate.system.dirty ? '含用户脏改，需明确选择' : candidate.system.status === 'active' ? '可纳入中心库' : candidate.system.status === 'keep-private' ? '默认保留在项目内' : '仅作参考'}`
    if (!files.some((file) => file.stored) && ['skill', 'agent', 'rules'].includes(candidate.system.kind)) candidate.system.hidden = true
  }

  // Cache-like entries are deliberately kept as analysis evidence only. They
  // must be visible for audit, but are never copied into a library version or
  // proposed as a takeover operation.
  if (!cacheSystem && cacheEvidenceRecords.length) {
    cacheSystem = addSystem(systems, 'evidence/cache', '缓存与备份', 'cache', 'reference-only', null)
  }
  if (cacheSystem && cacheEvidenceRecords.length) {
    const known = new Set(cacheSystem.files.map((file) => file.physicalPath || file.path))
    for (const record of cacheEvidenceRecords) {
      const key = record.physicalPath || record.path
      if (known.has(key)) continue
      cacheSystem.files.push(record)
      cacheSystem.projections.push({
        host: 'cache', path: record.physicalPath || record.path, canonicalTarget: record.canonicalTarget || null, projection: 'cache'
      })
      known.add(key)
    }
    cacheSystem.fileCount = cacheSystem.files.length
    cacheSystem.skillCount = 0
    cacheSystem.ruleCount = 0
    cacheSystem.summary = `${cacheSystem.fileCount} 个证据项 · 不进入中心库或接管计划`
  }

  // An external Junction/symlink is a safety decision, not an absent file.
  // Keep the evidence visible so the main flow can explain the block and give
  // the user a recovery path without reading anything outside the workspace.
  if (externalLinkEvidence.length) {
    const unique = []
    const seenExternal = new Set()
    for (const record of externalLinkEvidence) {
      const identity = externalLinkPhysicalIdentity(record)
      if (seenExternal.has(identity)) continue
      seenExternal.add(identity)
      unique.push(record)
    }
    const externalSystem = addSystem(systems, 'evidence/external-links', '工作区外部链接（已阻止）', 'external-link', 'reference-only', null)
    externalSystem.selectable = false
    externalSystem.blocked = true
    externalSystem.role = 'blocked-evidence'
    externalSystem.unavailableReason = '检测到指向所选工作区外部的 Junction / 链接，已停止读取。'
    externalSystem.safeReason = '请将链接目标移入所选工作区，或改用工作区内的规范目录后重新分析。'
    externalSystem.diagnosticPaths = unique.map((record) => record.canonicalTarget).filter(Boolean)
    externalSystem.files.push(...unique)
    externalSystem.fileCount = unique.length
    externalSystem.contentHash = hashJson(unique.map((record) => ({ path: record.path, target: record.canonicalTarget })))
    externalSystem.summary = `${unique.length} 个工作区外部链接已阻止读取 · 不进入中心库或接管计划`
    externalSystem.projections = unique.map((record) => ({
      host: 'external-link',
      path: record.physicalPath,
      canonicalTarget: record.canonicalTarget,
      projection: 'blocked-external-link'
    }))
  }

  // Collapse host projections and project-level rules into one selectable
  // project system. The raw projections remain in the manifest for auditing,
  // but the normal UI should present one project choice rather than one card
  // per .agents/.cursor/.claude/.codex directory or rule file.
  const projectGroups = new Map()
  const projectRootCandidates = [...projectRoots].filter(Boolean).sort((a, b) => b.length - a.length)
  for (const candidate of systemCandidates) {
    if (!['active', 'keep-private'].includes(candidate.system.status) || candidate.evidenceOnly) continue
    if (!['skill', 'agent', 'rules'].includes(candidate.system.kind)) continue
    const normalized = candidate.relative.replaceAll('\\', '/')
    const nearest = projectRootCandidates.find((root) => normalized === root || normalized.startsWith(`${root}/`))
    const projectionProjectRoot = candidate.system.projections.find((projection) => projection.projectRoot)?.projectRoot
    const projectRoot = projectionProjectRoot || nearest || projectRootFor(normalized)
    let familyKey = candidate.familyKey || candidate.system.projections.find((projection) => projection.familyKey)?.familyKey || 'project'
    if (candidate.system.kind === 'rules') {
      const sameProject = systemCandidates.find((other) => {
        if (other === candidate || !['active', 'keep-private'].includes(other.system.status)) return false
        if (!['skill', 'agent'].includes(other.system.kind)) return false
        const otherRoot = other.system.projections.find((projection) => projection.projectRoot)?.projectRoot || projectRootFor(other.relative)
        return otherRoot === projectRoot
      })
      familyKey = sameProject?.familyKey || familyKey
    }
    const groupKey = `${projectRoot}\u0000${familyKey}`
    const group = projectGroups.get(groupKey) || { projectRoot, familyKey, candidates: [], files: new Map() }
    projectGroups.set(groupKey, group)
    group.candidates.push(candidate)
    for (const file of candidate.system.files) {
      if (!file.stored || file.referenceOnly || file.dormant) continue
      let logicalPath = file.logicalPath || logicalFilePath(file.physicalPath || file.path)
      if (projectRootFor(normalized) && /^rules\//iu.test(logicalPath)) {
        const projectPrefix = `rules/${projectRootFor(normalized)}/`
        if (logicalPath.startsWith(projectPrefix)) logicalPath = `rules/${logicalPath.slice(projectPrefix.length)}`
      }
      const prior = group.files.get(logicalPath)
      if (!prior) {
        group.files.set(logicalPath, { ...file, path: logicalPath, logicalPath, storedPath: file.storedPath || file.physicalPath || file.path, sourceSystemIds: [candidate.system.id], projectionPaths: [file.physicalPath || file.path] })
      } else if (prior.contentHash === file.contentHash) {
        prior.sourceSystemIds = [...new Set([...prior.sourceSystemIds, candidate.system.id])]
        prior.projectionPaths = [...new Set([...prior.projectionPaths, file.physicalPath || file.path])]
      } else {
        prior.projectionConflicts = [...(prior.projectionConflicts || []), { sourceSystemId: candidate.system.id, physicalPath: file.physicalPath || file.path, contentHash: file.contentHash }]
      }
    }
  }
  for (const group of projectGroups.values()) {
    const { projectRoot } = group
    if (group.files.size === 0) continue
    const hasSkill = [...group.files.values()].some((file) => /(?:^|\/)SKILL\.md$/iu.test(file.path))
    const hasRule = [...group.files.values()].some((file) => /^rules\//iu.test(file.path))
    if (!hasSkill && !hasRule) {
      for (const candidate of group.candidates) candidate.system.hidden = true
      continue
    }
    const relative = projectRoot || 'project'
    const dirty = group.candidates.some((candidate) => candidate.system.dirty)
    const familyLabel = !hasSkill && hasRule
      ? '项目规则'
      : group.familyKey === 'host-cli'
      ? 'Unity MCP CLI'
      : group.familyKey === 'nested:unity-skills'
        ? 'UnitySkills REST'
        : group.familyKey === 'local-skills'
          ? '本地 Skill'
          : group.familyKey === 'rules' ? '项目规则' : group.familyKey
    const systemKey = `project/${relative}/${group.familyKey}`
    // A project aggregate is a real selectable source when it contains at
    // least one stored SKILL.md.  Keep clean candidates active; only dirty
    // candidates are protected by the explicit-selection policy.  Evidence
    // groups (rules/cache/declarations without skills) remain reference-only
    // and are intentionally not selectable.
    const aggregateStatus = hasSkill ? (dirty ? 'keep-private' : 'active') : 'reference-only'
    const system = addSystem(systems, systemKey, projectRoot ? `${path.posix.basename(projectRoot)} · ${familyLabel}` : `${workspaceName(canonicalWorkspace)} · ${familyLabel}`, hasSkill ? 'project' : 'evidence', aggregateStatus, null)
    system.sourcePath = projectRoot || '.'
    system.canonicalTarget = projectRootAbsolute(canonicalWorkspace, projectRoot)
    system.projections = group.candidates.flatMap((candidate) => candidate.system.projections).map((projection) => ({ ...projection, systemId: group.candidates.find((item) => item.system.projections.includes(projection))?.system.id }))
    const normalizedFiles = new Map()
    for (const file of group.files.values()) {
      let logicalPath = file.path
      const projectPrefix = projectRoot ? `rules/${projectRoot}/` : ''
      if (projectPrefix && logicalPath.startsWith(projectPrefix)) logicalPath = `rules/${logicalPath.slice(projectPrefix.length)}`
      const existing = normalizedFiles.get(logicalPath)
      if (!existing) normalizedFiles.set(logicalPath, { ...file, path: logicalPath, logicalPath, storedPath: file.storedPath || file.physicalPath || file.path })
      else if (existing.contentHash === file.contentHash) {
        existing.projectionPaths = [...new Set([...(existing.projectionPaths || []), ...(file.projectionPaths || [])])]
      } else {
        existing.projectionConflicts = [...(existing.projectionConflicts || []), { sourceSystemId: file.sourceSystemIds?.[0] || '', physicalPath: file.physicalPath || file.path, contentHash: file.contentHash }]
      }
    }
    system.files = [...normalizedFiles.values()]
    system.projectionConflicts = system.files
      .filter((file) => file.projectionConflicts?.length)
      .map((file) => ({ path: file.path, variants: file.projectionConflicts }))
    system.fileCount = system.files.length
    system.skillCount = system.files.filter((file) => /(?:^|\/)SKILL\.md$/iu.test(file.path)).length
    system.ruleCount = system.files.filter((file) => /^rules\//iu.test(file.path)).length
    system.contentHash = hashText(system.files.map((file) => `${file.path}:${file.contentHash || 'reference'}`).sort().join('|'))
    system.versionFamily = projectRoot.toLocaleLowerCase('en-US')
    system.selectable = hasSkill
    system.role = hasSkill ? 'candidate' : 'evidence'
    system.recommended = system.files.some((file) => /AGENTS\.override\.md$/iu.test(file.path) || /AGENTS\.override\.md$/iu.test(file.physicalPath || ''))
    system.dirty = dirty
    system.requiresExplicit = dirty
    system.dirtyFiles = [...new Set(group.candidates.flatMap((candidate) => candidate.system.dirtyFiles || []))]
    system.summary = `${system.skillCount} 个 Skill · ${system.ruleCount} 条规则 · ${system.projections.length} 个宿主投影${dirty ? ' · 含用户脏改，默认保全' : ''}`
    for (const candidate of group.candidates) candidate.system.hidden = true
  }

  const dormant = await gitSkipWorktree(canonicalWorkspace)
  if (dormant.length) {
    const system = addSystem(systems, 'git-index/dormant', 'Git 中的休眠 Skill / 规则', 'dormant', 'reference-only', {
      host: 'git-index', path: 'git-index', canonicalTarget: null, projection: 'skip-worktree', count: dormant.length
    })
    const sample = dormant.slice(0, 120)
    system.files = sample.map((relative) => ({
      id: fileId(`git-index/${relative}`),
      path: relative,
      logicalPath: relative,
      physicalPath: relative,
      sourcePath: path.resolve(canonicalWorkspace, relative),
      size: 0,
      contentHash: null,
      canonicalTarget: null,
      alias: false,
      external: false,
      stored: false,
      referenceOnly: true,
      dormant: true
    }))
    system.fileCount = dormant.length
    system.sampleCount = sample.length
    system.missingPaths = dormant
    system.contentHash = hashJson({ dormant: dormant.length, paths: dormant })
    system.summary = `Git index 中存在但物理缺失，休眠体系（${dormant.length} 个，展示 ${sample.length} 个样例）`
  }

  const allFiles = []
  const canonicalGroups = new Map()
  const hashGroups = new Map()
  for (const system of systems.values()) {
    if (system.hidden) continue
    for (const file of system.files) {
      allFiles.push(file)
      const canonical = file.canonicalTarget ? portableKey(file.canonicalTarget) : ''
      if (canonical) canonicalGroups.set(canonical, [...(canonicalGroups.get(canonical) || []), system.id])
      if (file.contentHash) hashGroups.set(file.contentHash, [...(hashGroups.get(file.contentHash) || []), system.id])
    }
  }
  for (const system of systems.values()) {
    const related = new Set()
    for (const file of system.files) {
      const canonical = file.canonicalTarget ? portableKey(file.canonicalTarget) : ''
      for (const id of canonicalGroups.get(canonical) || []) related.add(id)
      for (const id of hashGroups.get(file.contentHash) || []) related.add(id)
    }
    related.delete(system.id)
    system.relatedSystemIds = [...related]
    system.duplicateOf = system.relatedSystemIds.find((id) => {
      const other = systems.get(id)
      return other && other.contentHash === system.contentHash
    }) || null
    system.versionFamily ||= system.name.toLocaleLowerCase('en-US')
  }

  const declaredMissing = []
  for (const system of systems.values()) {
    if (system.kind !== 'declaration') continue
    const lockFile = system.files[0]
    if (!lockFile?.stored) continue
    const lockPath = productPath(analysisFiles, ...(lockFile.physicalPath || lockFile.path).split('/'))
    const raw = await readFileOrEmpty(lockPath)
    try {
      const parsed = JSON.parse(raw)
      const values = []
      if (Array.isArray(parsed)) values.push(...parsed)
      else if (parsed && typeof parsed === 'object') {
        if (parsed.skills && typeof parsed.skills === 'object' && !Array.isArray(parsed.skills)) {
          for (const name of Object.keys(parsed.skills)) {
            values.push(name)
          }
        } else {
          values.push(...Object.values(parsed))
        }
      }
      for (const value of values) {
        const name = typeof value === 'string' ? value : value?.name || value?.path || value?.skillPath || value?.skill || value?.id || value?.package
        if (typeof name !== 'string' || !name.trim()) continue
        const normalizedName = name.trim().replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '')
        const present = [...systems.values()].some((candidate) => candidate.files.some((file) => {
          if (!file.stored || file.referenceOnly || file.dormant || file.evidenceOnly) return false
          const logical = file.logicalPath || file.path
          return candidate.name === name || logical.split('/').some((segment) => segment.localeCompare(normalizedName, undefined, { sensitivity: 'accent' }) === 0)
        }))
        if (!present) declaredMissing.push(name)
      }
    } catch {
      /* malformed declarations remain visible as the declaration system */
    }
  }
  for (const name of [...new Set(declaredMissing)]) {
    const relative = `declared-missing/${name}`
    const system = addSystem(systems, relative, name, 'declared-missing', 'reference-only', {
      host: 'skills-lock', path: relative, canonicalTarget: null, projection: 'declared-missing'
    })
    system.summary = '声明存在但当前工作区未落盘，仅作参考'
  }

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    analysisId,
    workspacePath: canonicalWorkspace,
    workspaceName: workspaceName(canonicalWorkspace),
    createdAt: nowIso(),
    systems: [...systems.values()],
    summary: {
      systems: [...systems.values()].filter((item) => !item.hidden).length,
      active: [...systems.values()].filter((item) => !item.hidden && item.status === 'active' && item.selectable !== false).length,
      private: [...systems.values()].filter((item) => !item.hidden && item.status === 'keep-private').length,
      referenceOnly: [...systems.values()].filter((item) => !item.hidden && item.status === 'reference-only').length,
      files: allFiles.length,
      dirtySystems: [...systems.values()].filter((item) => !item.hidden && item.dirty).length,
      dirtyFiles: [...systems.values()].filter((item) => !item.hidden).reduce((sum, item) => sum + (item.dirtyFiles?.length || 0), 0),
      dormant: [...systems.values()].filter((item) => !item.hidden && item.kind === 'dormant').length,
      declaredMissing: [...systems.values()].filter((item) => !item.hidden && item.kind === 'declared-missing').length,
      externalLinks: [...new Set(externalLinkEvidence.map(externalLinkPhysicalIdentity).filter(Boolean))].length
    }
  }
  await atomicJson(productPath(productRoot, 'analyses', analysisId, 'manifest.json'), manifest, productRoot)
  return manifest
}

function defaultState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    activePlanId: null,
    plans: {},
    analyses: {},
    workspaces: {},
    comparisons: {},
    drafts: {},
    takeovers: {},
    protections: {},
    rollbackPreviews: {},
    commitReceipts: {},
    mergeReceipt: null,
    chats: {},
    aiRequests: {}
  }
}

function normalizeState(raw) {
  const base = defaultState()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base
  return {
    ...base,
    ...raw,
    schemaVersion: SCHEMA_VERSION,
    plans: raw.plans && typeof raw.plans === 'object' ? raw.plans : {},
    analyses: raw.analyses && typeof raw.analyses === 'object' ? raw.analyses : {},
    workspaces: raw.workspaces && typeof raw.workspaces === 'object' ? raw.workspaces : {},
    comparisons: raw.comparisons && typeof raw.comparisons === 'object' ? raw.comparisons : {},
    drafts: raw.drafts && typeof raw.drafts === 'object' ? raw.drafts : {},
    takeovers: raw.takeovers && typeof raw.takeovers === 'object' ? raw.takeovers : {},
    protections: raw.protections && typeof raw.protections === 'object' ? raw.protections : {},
    rollbackPreviews: raw.rollbackPreviews && typeof raw.rollbackPreviews === 'object' ? raw.rollbackPreviews : {},
    commitReceipts: raw.commitReceipts && typeof raw.commitReceipts === 'object' && !Array.isArray(raw.commitReceipts) ? raw.commitReceipts : {},
    mergeReceipt: raw.mergeReceipt && typeof raw.mergeReceipt === 'object' && !Array.isArray(raw.mergeReceipt) ? raw.mergeReceipt : null,
    chats: raw.chats && typeof raw.chats === 'object' ? raw.chats : {},
    aiRequests: raw.aiRequests && typeof raw.aiRequests === 'object' ? raw.aiRequests : {}
  }
}

function workspaceKey(workspacePath) {
  return portableKey(path.resolve(workspacePath))
}

function analysisSignature(analysis, selectedSystemIds) {
  const hasExplicitSelection = Array.isArray(selectedSystemIds)
  const selected = new Set(hasExplicitSelection ? selectedSystemIds : [])
  const systems = (analysis?.systems || [])
    .filter((system) => !system.hidden && system.selectable !== false && (!hasExplicitSelection ? system.status === 'active' : selected.has(system.id)))
    .map((system) => ({ id: system.id, hash: system.contentHash, files: system.fileCount }))
    .sort((a, b) => a.id.localeCompare(b.id))
  return hashJson(systems)
}

function analysisSafetySignature(analysis) {
  const evidence = []
  const seen = new Set()
  for (const system of analysis?.systems || []) {
    if (!system?.blocked && system?.kind !== 'external-link') continue
    for (const file of system.files || []) {
      if (!file?.external && system.kind !== 'external-link') continue
      const record = {
        path: file.physicalPath || file.path || '',
        target: file.canonicalTarget || '',
        kind: file.linkKind || system.kind || 'blocked'
      }
      const identity = externalLinkIdentity({
        sourcePath: file.sourcePath,
        physicalPath: record.path,
        physicalBoundary: file.physicalBoundary,
        canonicalTarget: record.target
      })
      if (seen.has(identity)) continue
      seen.add(identity)
      evidence.push(record)
    }
    if (!system.files?.length) {
      const record = { path: system.sourcePath || system.id, target: system.canonicalTarget || '', kind: system.kind || 'blocked' }
      const identity = externalLinkIdentity({ physicalPath: record.path, canonicalTarget: record.target })
      if (!seen.has(identity)) {
        seen.add(identity)
        evidence.push(record)
      }
    }
  }
  evidence.sort((a, b) => `${a.path}\u0000${a.target}`.localeCompare(`${b.path}\u0000${b.target}`))
  return hashJson(evidence)
}

function workspaceStatus(workspace, changed = Boolean(workspace?.hasUpdates)) {
  if (workspace?.safetyBlocked) return workspace.connectionMode ? 'connected-safety-blocked' : 'observed-safety-blocked'
  if (workspace?.selectionNeedsReview) return workspace.connectionMode ? 'connected-selection-review' : 'observed-selection-review'
  if (workspace?.connectionRecoveryRequired) return 'needs-connection'
  if (changed) return workspace.connectionMode ? 'connected-with-updates' : 'observed-with-updates'
  return workspace.connectionMode ? 'connected' : 'observed'
}

function stablePathKey(value) {
  const normalized = String(value || '').trim().replaceAll('\\', '/').replace(/\/+$/u, '')
  return normalized ? portableKey(normalized) : ''
}

function stableTakeoverOperation(operation) {
  const boundaries = (Array.isArray(operation?.linkBoundaries) ? operation.linkBoundaries : [])
    .map((boundary) => ({
      path: stablePathKey(boundary?.path),
      canonicalTarget: stablePathKey(boundary?.canonicalTarget || boundary?.target)
    }))
    .filter((boundary) => boundary.path || boundary.canonicalTarget)
    .sort((left, right) => `${left.path}\u0000${left.canonicalTarget}`.localeCompare(`${right.path}\u0000${right.canonicalTarget}`))
  return {
    path: stablePathKey(operation?.path),
    targetPath: stablePathKey(operation?.targetPath),
    projection: stablePathKey(operation?.projection),
    canonicalTarget: stablePathKey(operation?.canonicalTarget),
    action: text(operation?.action),
    available: operation?.available !== false,
    dirty: Boolean(operation?.dirty),
    beforeExists: Boolean(operation?.beforeExists),
    beforeHash: text(operation?.beforeHash),
    afterHash: text(operation?.afterHash),
    size: Number(operation?.size) || 0,
    managed: operation?.managed !== false,
    linkBoundaries: boundaries
  }
}

function takeoverPlanMaterial(input) {
  const operations = (Array.isArray(input?.operations) ? input.operations : [])
    .map(stableTakeoverOperation)
    .sort((left, right) => `${left.path}\u0000${left.targetPath}`.localeCompare(`${right.path}\u0000${right.targetPath}`))
  return {
    planId: text(input?.planId),
    versionId: text(input?.versionId).toLowerCase(),
    worktreePath: stablePathKey(input?.worktreePath),
    targetProjection: stablePathKey(input?.targetProjection),
    canonicalTarget: stablePathKey(input?.canonicalTarget),
    selectedSystemIds: [...new Set((Array.isArray(input?.selectedSystemIds) ? input.selectedSystemIds : []).map((id) => text(id)).filter(Boolean))].sort(),
    operations
  }
}

function takeoverPlanHash(input) {
  return hashJson(takeoverPlanMaterial(input))
}

function systemSourcePaths(system) {
  const values = [
    system?.sourcePath,
    system?.canonicalTarget,
    ...(system?.projections || []).flatMap((projection) => [projection?.path, projection?.sourcePath, projection?.canonicalTarget])
  ]
  return [...new Set(values.map(stablePathKey).filter(Boolean))]
}

function durableSystemSourcePaths(system) {
  const values = [
    system?.sourcePath,
    ...(Array.isArray(system?.sourcePaths) ? system.sourcePaths : []),
    system?.canonicalTarget,
    ...(system?.projections || []).flatMap((projection) => [projection?.path, projection?.sourcePath, projection?.canonicalTarget])
  ]
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))]
}

function systemSelectionRef(system) {
  return {
    id: system.id,
    name: system.name,
    kind: system.kind,
    sourcePath: system.sourcePath || '',
    sourcePaths: durableSystemSourcePaths(system),
    fingerprint: system.contentHash || null,
    contentHash: system.contentHash || null,
    canonicalTarget: system.canonicalTarget || null,
    paths: (system.files || [])
      .filter((file) => file?.stored !== false && !file?.referenceOnly && !file?.dormant)
      .map((file) => file.logicalPath || file.path)
      .filter(Boolean),
    projections: (system.projections || []).map((projection) => ({ ...projection }))
  }
}

function isDurableSelectionRef(reference) {
  return Boolean(reference && typeof reference === 'object'
    && text(reference.id).trim()
    && text(reference.name).trim()
    && text(reference.kind).trim()
    && text(reference.sourcePath).trim()
    && Array.isArray(reference.paths)
    && reference.paths.length > 0
    && Array.isArray(reference.projections))
}

function mergeSelectionReference(existing, system) {
  const current = systemSelectionRef(system)
  if (!existing || typeof existing !== 'object') return current
  return {
    ...current,
    name: current.name || existing.name || current.id,
    kind: current.kind || existing.kind || 'skill',
    sourcePath: current.sourcePath || existing.sourcePath || '',
    canonicalTarget: current.canonicalTarget || existing.canonicalTarget || null,
    fingerprint: current.fingerprint || existing.fingerprint || null,
    contentHash: current.contentHash || existing.contentHash || current.fingerprint || existing.fingerprint || null,
    // The durable path set is the connected scope, not only the files that
    // happened to survive the latest read. Retaining it lets a deleted file
    // be recognized as a workspace change and later restored without losing
    // the selected system identity.
    paths: [...new Set([
      ...(Array.isArray(existing.paths) ? existing.paths : []),
      ...current.paths
    ].map((value) => String(value || '').trim()).filter(Boolean))],
    sourcePaths: [...new Set([
      ...(Array.isArray(existing.sourcePaths) ? existing.sourcePaths : []),
      ...current.sourcePaths
    ].map((value) => String(value || '').trim()).filter(Boolean))],
    projections: current.projections.length
      ? current.projections
      : (Array.isArray(existing.projections) ? existing.projections.map((projection) => ({ ...projection })) : [])
  }
}

function selectionRefsForSystems(systems, selectedIds) {
  const selected = new Set(Array.isArray(selectedIds) ? selectedIds : [])
  return (systems || []).filter((system) => selected.has(system.id)).map(systemSelectionRef)
}

function selectionRefsForIds(references, selectedIds) {
  const wanted = [...new Set(Array.isArray(selectedIds) ? selectedIds.filter(Boolean) : [])]
  if (!wanted.length) return []
  const byId = new Map((Array.isArray(references) ? references : [])
    .filter((reference) => reference?.id)
    .map((reference) => [String(reference.id), reference]))
  const resolved = wanted.map((id) => byId.get(String(id)) || null)
  return resolved.length === wanted.length && resolved.every(isDurableSelectionRef) ? resolved : []
}

function selectionCandidate(system) {
  return {
    ...system,
    sourceKeys: systemSourcePaths(system),
    fingerprint: system.contentHash || '',
    paths: (system.files || [])
      .filter((file) => file?.stored !== false && !file?.referenceOnly && !file?.dormant)
      .map((file) => file.logicalPath || file.path)
      .filter(Boolean)
  }
}

function resolveSelectionReference(reference, candidates) {
  const resolved = resolvePersistedSelectionReference(reference, (candidates || []).map(selectionCandidate))
  return resolved.match
    ? { ...resolved, match: candidates.find((candidate) => candidate.id === resolved.match.id) || null }
    : resolved
}

function reconcileWorkspaceSelection(workspace, analysis) {
  const candidates = (analysis?.systems || []).filter((system) => !system.hidden && system.selectable !== false)
  const existingIds = [...new Set(Array.isArray(workspace.selectedSystemIds) ? workspace.selectedSystemIds : [])]
  const existingRefs = [
    ...(Array.isArray(workspace.selectedSystemRefs) ? workspace.selectedSystemRefs : []),
    ...(Array.isArray(workspace.unresolvedSelectedSystemRefs) ? workspace.unresolvedSelectedSystemRefs : [])
  ]
  const selectedIds = []
  const selectedSystems = []
  const unresolved = []
  const used = new Set()
  const add = (system) => {
    if (!system?.id || used.has(system.id)) return
    used.add(system.id)
    selectedIds.push(system.id)
    selectedSystems.push(system)
  }

  // An exact id is useful when the analysis is unchanged, but it is not enough
  // for a new analysis because ids can be derived from discovered paths.  Every
  // persisted scope therefore gets resolved through stable source paths,
  // content fingerprints and finally a unique friendly name.  Ambiguity is a
  // read-only state; it must never turn into a recommendation-based expansion.
  const refsById = new Map(existingRefs.filter((ref) => ref?.id).map((ref) => [String(ref.id), ref]))
  for (const id of existingIds) {
    if (refsById.has(id)) continue
    const result = resolveSelectionReference({ id }, candidates)
    if (result.match) add(result.match)
    else unresolved.push({ id, reason: result.reason })
  }
  for (const reference of existingRefs) {
    const result = resolveSelectionReference(reference, candidates.filter((candidate) => !used.has(candidate.id)))
    if (result.match) add(result.match)
    else unresolved.push({ ...reference, reason: result.reason })
  }
  const hadPersistedScope = existingIds.length > 0 || existingRefs.length > 0
  if (hadPersistedScope) {
    // One unresolved persisted reference invalidates the whole durable scope.
    // Keeping the other matches would silently widen or alter the user's
    // original selection while the review page is still waiting for input.
    const scopeIsSafe = unresolved.length === 0
    workspace.selectedSystemIds = scopeIsSafe ? selectedIds : []
    workspace.selectedSystemRefs = scopeIsSafe
      ? selectedSystems.map((system) => mergeSelectionReference(refsById.get(String(system.id)), system))
      : []
    workspace.unresolvedSelectedSystemRefs = unresolved
    workspace.selectionNeedsReview = unresolved.length > 0
    workspace.selectionReviewMessage = unresolved.length
      ? '原有项目体系无法唯一匹配。当前只读分析不会自动扩大范围，请选择要连接的体系。'
      : ''
  }
  return selectedIds
}

function publicWorkspace(workspace) {
  if (!workspace) return null
  return {
    workspaceId: workspace.workspaceId,
    workspacePath: workspace.workspacePath,
    workspaceName: workspace.workspaceName,
    planId: workspace.planId || null,
    connectedVersion: workspace.connectedVersion || null,
    connectionMode: workspace.connectionMode || null,
    status: workspace.status || 'observed',
    hasUpdates: Boolean(workspace.hasUpdates),
    pendingAnalysisId: workspace.pendingAnalysisId || null,
    pendingComparisonId: workspace.pendingComparisonId || null,
    pendingSummary: workspace.pendingSummary || null,
    selectedSystemIds: workspace.selectedSystemIds || [],
    selectedSystemRefs: workspace.selectedSystemRefs || [],
    unresolvedSelectedSystemRefs: workspace.unresolvedSelectedSystemRefs || [],
    selectionNeedsReview: Boolean(workspace.selectionNeedsReview),
    selectionReviewMessage: workspace.selectionReviewMessage || '',
    baselineVersion: workspace.baselineVersion || workspace.connectedVersion || null,
    baselineSignature: workspace.baselineSignature || null,
    baselineSafetySignature: workspace.baselineSafetySignature || null,
    observedSafetySignature: workspace.observedSafetySignature || null,
    safetyBlocked: Boolean(workspace.safetyBlocked),
    connectionRecoveryRequired: Boolean(workspace.connectionRecoveryRequired),
    protectionId: workspace.protectionId || null,
    rollbackPreviewId: workspace.rollbackPreviewId || null,
    lastAnalysisId: workspace.lastAnalysisId || null,
    lastAnalyzedAt: workspace.lastAnalyzedAt || null
  }
}

function observeWorkspace(state, analysis) {
  const key = workspaceKey(analysis.workspacePath)
  const current = state.workspaces[key] || {
    workspaceId: `workspace-${hashText(key).slice(0, 16)}`,
    workspacePath: analysis.workspacePath,
    workspaceName: analysis.workspaceName,
    status: 'observed',
    createdAt: nowIso()
  }
  reconcileWorkspaceSelection(current, analysis)
  const observed = analysisSignature(analysis, Array.isArray(current.selectedSystemIds) ? current.selectedSystemIds : undefined)
  const observedSafety = analysisSafetySignature(analysis)
  current.workspacePath = analysis.workspacePath
  current.workspaceName = analysis.workspaceName
  current.lastAnalysisId = analysis.analysisId
  current.lastAnalyzedAt = analysis.createdAt
  current.observedSignature = observed
  current.observedSafetySignature = observedSafety
  current.safetyBlocked = Number(analysis.summary?.externalLinks || 0) > 0
  const baselineSafety = current.baselineSafetySignature || analysisSafetySignature(null)
  const safetyChanged = Boolean(current.baselineSignature) && observedSafety !== baselineSafety
  const scopeChanged = Boolean(current.baselineSignature) && current.baselineSignature !== observed
  const needsSelection = Boolean(current.selectionNeedsReview)
  // Safety evidence and an unresolved durable scope are actionable even for
  // legacy connected records that predate a persisted baseline signature.
  // Never turn a blocked quick re-analysis into a false "no changes" result.
  if (current.safetyBlocked || needsSelection || (current.baselineSignature && (scopeChanged || safetyChanged))) {
    current.hasUpdates = true
    current.pendingAnalysisId = analysis.analysisId
    current.pendingSummary = analysis.summary
    current.status = workspaceStatus(current, true)
  } else if (!current.baselineSignature) {
    current.hasUpdates = false
    current.pendingAnalysisId = null
    current.pendingComparisonId = null
    current.pendingSummary = null
    current.status = workspaceStatus(current, false)
  } else {
    current.hasUpdates = false
    current.pendingAnalysisId = null
    current.pendingComparisonId = null
    current.pendingSummary = null
    current.status = workspaceStatus(current, false)
  }
  state.workspaces[key] = current
  return current
}

function publicSystem(system, analysisId) {
  return {
    id: system.id,
    analysisId,
    name: system.name,
    kind: system.kind,
    status: system.status,
    sourcePath: system.sourcePath,
    summary: system.summary,
    fileCount: system.fileCount,
    skillCount: system.skillCount || 0,
    ruleCount: system.ruleCount || 0,
    sampleCount: system.sampleCount || 0,
    samplePaths: (system.samplePaths || system.missingPaths || system.files.filter((file) => file.dormant).map((file) => file.path)).slice(0, 120),
    contentHash: system.contentHash,
    canonicalTarget: system.canonicalTarget,
    duplicateOf: system.duplicateOf,
    relatedSystemIds: system.relatedSystemIds || [],
    versionFamily: system.versionFamily,
    recommended: Boolean(system.recommended),
    selectable: Boolean(system.selectable),
    role: system.role || (system.selectable ? 'candidate' : 'evidence'),
    dirty: Boolean(system.dirty),
    requiresExplicit: Boolean(system.requiresExplicit),
    dirtyFiles: system.dirtyFiles || [],
    blocked: Boolean(system.blocked),
    unavailableReason: system.unavailableReason || '',
    safeReason: system.safeReason || '',
    diagnosticPaths: system.diagnosticPaths || [],
    projectionConflicts: system.projectionConflicts || [],
    projections: system.projections,
    sources: (system.projections || []).map((projection) => ({
      kind: projection.host || projection.projection || '来源',
      path: projection.path || projection.sourcePath || projection.canonicalTarget || ''
    })).filter((source) => source.path),
    files: system.files.map((file) => ({
      id: file.id,
      path: file.logicalPath || file.path,
      logicalPath: file.logicalPath || file.path,
      physicalPath: file.physicalPath || file.path,
      physicalBoundary: file.physicalBoundary || file.physicalPath || file.path,
      sourcePath: file.sourcePath,
      size: file.size,
      contentHash: file.contentHash,
      stored: file.stored,
      referenceOnly: file.referenceOnly,
      alias: file.alias,
      canonicalTarget: file.canonicalTarget,
      evidenceOnly: file.evidenceOnly || false,
      artifactKind: file.artifactKind || null,
      artifactReason: file.artifactReason || '',
      dormant: file.dormant || false,
      projectionPaths: file.projectionPaths || [],
      projectionConflicts: file.projectionConflicts || [],
      origins: file.origins || [],
      dirty: Boolean(file.dirty),
      linkKind: file.linkKind || '',
      external: Boolean(file.external),
      unavailableReason: file.unavailableReason || '',
      safeReason: file.safeReason || ''
    }))
  }
}

function publicAnalysis(manifest) {
  const blockedSystems = manifest.systems
    .filter((system) => system.blocked || system.kind === 'external-link')
    .map((system) => ({
      id: system.id,
      kind: system.kind,
      name: system.name,
      reason: system.unavailableReason || '检测到工作区外部链接，已停止读取。',
      safeReason: system.safeReason || '请将链接目标移入所选工作区，或改用工作区内的规范目录后重新分析。',
      diagnosticPaths: system.diagnosticPaths || []
    }))
  return {
    analysisId: manifest.analysisId,
    workspacePath: manifest.workspacePath,
    workspaceName: manifest.workspaceName,
    createdAt: manifest.createdAt,
    summary: manifest.summary,
    safety: {
      blocked: blockedSystems.length > 0,
      blockedSystems
    },
    systems: manifest.systems.filter((system) => !system.hidden).map((system) => publicSystem(system, manifest.analysisId))
  }
}

function versionDir(productRoot, planId, versionId) {
  const version = /^v\d+$/i.test(versionId) ? versionId.toLowerCase() : null
  if (!version) throw bad('version must look like v1', 'PRODUCT_VERSION_INVALID')
  return productPath(productRoot, 'library', planId, 'versions', version)
}

async function versionManifest(productRoot, planId, versionId) {
  const dir = versionDir(productRoot, planId, versionId)
  const value = await readJson(productPath(dir, 'manifest.json'), null)
  if (!value) throw notFound(`version not found: ${versionId}`)
  const files = Array.isArray(value.files)
    ? value.files.map((file) => {
      const storagePath = normalizeRelative(file?.storagePath || file?.path)
      const logicalPath = canonicalVersionPath(file?.logicalPath || file?.path)
      if (!storagePath || !logicalPath) return null
      return { ...file, path: logicalPath, logicalPath, storagePath }
    }).filter(Boolean)
    : []
  return { ...value, files }
}

async function versionContent(productRoot, planId, versionId, relative) {
  const normalized = normalizeRelative(relative)
  if (!normalized) throw bad('file path is unsafe', 'PRODUCT_PATH_ESCAPE')
  const file = productPath(versionDir(productRoot, planId, versionId), 'files', ...normalized.split('/'))
  const value = await readFileOrEmpty(file)
  const stat = await lstatOrNull(file)
  if (!stat?.isFile()) throw notFound(`file not found: ${normalized}`)
  return value
}

async function versionRecordContent(productRoot, planId, versionId, record) {
  return versionContent(productRoot, planId, versionId, record?.storagePath || record?.path)
}

function commitReceiptPath(productRoot, planId, versionId) {
  return productPath(versionDir(productRoot, planId, versionId), 'commit-receipt.json')
}

function mergeReceiptPath(productRoot, planId, versionId) {
  return productPath(versionDir(productRoot, planId, versionId), 'merge-receipt.json')
}

function isCommitReceipt(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && text(value.status) === 'committed'
    && text(value.planId)
    && text(value.versionId)
    && text(value.draftId))
}

function isMergeReceipt(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && text(value.status) === 'merged'
    && text(value.planId)
    && text(value.versionId)
    && text(value.draftId)
    && text(value.workspacePath))
}

async function readCommitReceiptForVersion(productRoot, planId, versionId) {
  if (!planId || !versionId) return null
  const normalizedVersionId = /^v\d+$/iu.test(versionId) ? String(versionId).toLowerCase() : versionId
  const value = await readJson(commitReceiptPath(productRoot, planId, normalizedVersionId), null)
  if (isCommitReceipt(value) && value.planId === planId && value.versionId === normalizedVersionId) return value
  const manifest = await readJson(productPath(versionDir(productRoot, planId, normalizedVersionId), 'manifest.json'), null)
  return isCommitReceipt(manifest?.commitReceipt)
    && manifest.commitReceipt.planId === planId
    && manifest.commitReceipt.versionId === normalizedVersionId
    ? manifest.commitReceipt
    : null
}

async function readMergeReceiptForVersion(productRoot, planId, versionId) {
  if (!planId || !versionId) return null
  const normalizedVersionId = /^v\d+$/iu.test(versionId) ? String(versionId).toLowerCase() : versionId
  const value = await readJson(mergeReceiptPath(productRoot, planId, normalizedVersionId), null)
  if (isMergeReceipt(value) && value.planId === planId && value.versionId === normalizedVersionId) return value
  const manifest = await readJson(productPath(versionDir(productRoot, planId, normalizedVersionId), 'manifest.json'), null)
  return isMergeReceipt(manifest?.mergeReceipt)
    && manifest.mergeReceipt.planId === planId
    && manifest.mergeReceipt.versionId === normalizedVersionId
    ? manifest.mergeReceipt
    : null
}

function mergeReceiptFromCommitReceipt(receipt) {
  if (text(receipt?.origin) !== 'workspace-review' || !text(receipt?.workspacePath)) return null
  return {
    status: 'merged',
    planId: receipt.planId,
    versionId: receipt.versionId,
    workspacePath: receipt.workspacePath,
    draftId: receipt.draftId,
    fileCount: receipt.fileCount,
    createdAt: receipt.createdAt
  }
}

function stateCommitReceipts(state) {
  return Object.values(state?.commitReceipts || {}).filter(isCommitReceipt)
}

async function resolveCommitReceipt(productRoot, state, options = {}) {
  const planId = text(options.planId)
  const versionId = text(options.versionId)
  const draftId = text(options.draftId)
  const comparisonId = text(options.comparisonId)
  if (!planId && !versionId && !draftId && !comparisonId) return null
  if (planId && versionId) {
    const persisted = await readCommitReceiptForVersion(productRoot, planId, versionId)
    if (persisted
      && (!draftId || persisted.draftId === draftId)
      && (!comparisonId || persisted.comparisonId === comparisonId)) return persisted
  }
  const records = stateCommitReceipts(state)
  const inState = records.find((receipt) => (
    (!planId || receipt.planId === planId)
    && (!versionId || receipt.versionId === versionId)
    && (!draftId || receipt.draftId === draftId)
    && (!comparisonId || receipt.comparisonId === comparisonId)
  ))
  if (inState) {
    // The per-version receipt file is the immutable authority. State is a
    // recovery index only, so a refresh or a partially written state file can
    // never replace a durable receipt with stale metadata.
    const persisted = await readCommitReceiptForVersion(productRoot, inState.planId, inState.versionId)
    return persisted || inState
  }
  // Older result URLs sometimes retain only `versionId`. Search the durable
  // plan index rather than relying on today's active plan or mutable browser
  // state. The per-version sidecar/manifest remains authoritative.
  if (versionId && !planId) {
    for (const candidatePlanId of Object.keys(state?.plans || {})) {
      const persisted = await readCommitReceiptForVersion(productRoot, candidatePlanId, versionId)
      if (persisted
        && (!draftId || persisted.draftId === draftId)
        && (!comparisonId || persisted.comparisonId === comparisonId)) return persisted
    }
  }
  if (draftId) {
    const draft = await readJson(productPath(productRoot, 'drafts', draftId, 'manifest.json'), null)
    if (draft?.planId && draft?.committedVersion
      && (!planId || draft.planId === planId)
      && (!versionId || draft.committedVersion === versionId)) {
      return readCommitReceiptForVersion(productRoot, draft.planId, draft.committedVersion)
    }
  }
  return null
}

async function resolveMergeReceipt(productRoot, state, options = {}) {
  const planId = text(options.planId)
  const versionId = text(options.versionId)
  const draftId = text(options.draftId)
  const comparisonId = text(options.comparisonId)
  if (!planId && !versionId && !draftId && !comparisonId) return null

  const matches = (receipt) => isMergeReceipt(receipt)
    && (!planId || receipt.planId === planId)
    && (!versionId || receipt.versionId === versionId || receipt.versionId === String(versionId).toLowerCase())
    && (!draftId || receipt.draftId === draftId)
    && (!comparisonId || receipt.comparisonId === comparisonId)

  // A comparison URL identifies the commit through its comparisonId. Resolve
  // that commit first, then load the version-local merge sidecar/manifest;
  // never return an unrelated current state receipt for an uncommitted or
  // historical comparison that happens to share the same plan.
  if (comparisonId) {
    const comparisonCommit = await resolveCommitReceipt(productRoot, state, { planId, comparisonId })
    if (comparisonCommit) {
      const persisted = await readMergeReceiptForVersion(productRoot, comparisonCommit.planId, comparisonCommit.versionId)
      return persisted || mergeReceiptFromCommitReceipt(comparisonCommit)
    }
    return null
  }

  if (planId && versionId) {
    const persisted = await readMergeReceiptForVersion(productRoot, planId, versionId)
    if (matches(persisted)) return persisted
  }

  const stateReceipt = state?.mergeReceipt
  if (matches(stateReceipt)) {
    const persisted = await readMergeReceiptForVersion(productRoot, stateReceipt.planId, stateReceipt.versionId)
    return persisted || stateReceipt
  }

  if (draftId) {
    const draft = await readJson(productPath(productRoot, 'drafts', draftId, 'manifest.json'), null)
    if (draft?.planId && draft?.committedVersion
      && (!planId || draft.planId === planId)
      && (!versionId || draft.committedVersion === versionId)) {
      const persisted = await readMergeReceiptForVersion(productRoot, draft.planId, draft.committedVersion)
      if (matches(persisted)) return persisted
    }
  }

  if (versionId && !planId) {
    for (const candidatePlanId of Object.keys(state?.plans || {})) {
      const persisted = await readMergeReceiptForVersion(productRoot, candidatePlanId, versionId)
      if (matches(persisted)) return persisted
    }
  }

  const commitReceipt = await resolveCommitReceipt(productRoot, state, { planId, versionId, draftId, comparisonId })
  return mergeReceiptFromCommitReceipt(commitReceipt)
}

async function commitReceiptList(productRoot, state, planId) {
  const fromState = []
  for (const receipt of stateCommitReceipts(state).filter((item) => !planId || item.planId === planId)) {
    const persisted = await readCommitReceiptForVersion(productRoot, receipt.planId, receipt.versionId)
    fromState.push(persisted || receipt)
  }
  const versions = new Set(fromState.map((receipt) => `${receipt.planId}\u0000${receipt.versionId}`))
  const plan = planId ? state.plans?.[planId] : null
  for (const version of plan?.versions || []) {
    const versionId = text(version?.versionId)
    if (!versionId || versions.has(`${planId}\u0000${versionId}`)) continue
    const receipt = await readCommitReceiptForVersion(productRoot, planId, versionId)
    if (!receipt) continue
    fromState.push(receipt)
    versions.add(`${planId}\u0000${versionId}`)
  }
  return fromState.sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
}

async function assertVersionBodiesAvailable(productRoot, planId, versionId, manifest, options = {}) {
  const code = options.code || 'PRODUCT_CURRENT_VERSION_CONTENT_UNAVAILABLE'
  const missing = []
  for (const record of manifest?.files || []) {
    const storagePath = normalizeRelative(record?.storagePath || record?.path)
    const target = storagePath
      ? productPath(versionDir(productRoot, planId, versionId), 'files', ...storagePath.split('/'))
      : null
    const stat = target ? await lstatOrNull(target) : null
    if (!stat?.isFile()) {
      missing.push({
        path: record?.path || record?.logicalPath || '',
        storagePath: storagePath || record?.storagePath || record?.path || ''
      })
    }
  }
  if (!missing.length) return manifest
  const message = code === 'PRODUCT_DRAFT_ORIGINAL_CONTENT_UNAVAILABLE'
    ? '待删除文件的当前中心库正文不可用，已阻止保存。'
    : code === 'PRODUCT_VERSION_CONTENT_UNAVAILABLE'
      ? '中心库版本正文不可用，已阻止保存新版本。'
      : '当前中心库版本正文不可用，已阻止保存新版本。'
  throw conflict(message, code, {
    planId,
    versionId,
    paths: missing.map((item) => item.path).filter(Boolean),
    missing
  })
}

async function assertDraftCenterContentAvailable(productRoot, state, draft, options = {}) {
  const plan = state.plans[draft?.planId]
  if (!plan?.currentVersion) throw notFound(`library not found: ${draft?.planId || ''}`)
  const manifest = await versionManifest(productRoot, draft.planId, plan.currentVersion)
  const code = options.code || (draft?.files?.some((file) => file.deleted)
    ? 'PRODUCT_DRAFT_ORIGINAL_CONTENT_UNAVAILABLE'
    : undefined)
  await assertVersionBodiesAvailable(productRoot, draft.planId, plan.currentVersion, manifest, { code })
  return { plan, manifest }
}

async function analysisManifest(productRoot, analysisId) {
  const id = requiredText(analysisId, 'analysisId')
  const value = await readJson(productPath(productRoot, 'analyses', id, 'manifest.json'), null)
  if (!value) throw notFound(`analysis not found: ${id}`)
  return value
}

async function analysisFileContent(productRoot, analysisId, relative, storedPath = relative) {
  const normalized = normalizeRelative(storedPath)
  if (!normalized) return ''
  return readFileOrEmpty(productPath(productRoot, 'analyses', analysisId, 'files', ...normalized.split('/')))
}

function selectedSystemIds(body) {
  const selected = body?.selectedSystems ?? body?.systemIds ?? body?.selectedSystemIds ?? []
  if (!Array.isArray(selected)) throw bad('selectedSystems must be an array')
  return [...new Set(selected.map((value) => requiredText(value, 'selected system id')))]
}

function currentVersionOf(plan) {
  return plan?.currentVersion || null
}

async function completeConnection(productRoot, state, body) {
  const planId = requiredText(body?.planId || state.activePlanId, 'planId')
  const plan = state.plans[planId]
  if (!plan?.currentVersion) throw notFound(`library not found: ${planId}`)
  const currentManifest = await versionManifest(productRoot, planId, plan.currentVersion)
  const suppliedWorkspace = requiredText(body?.workspacePath || body?.worktreePath, 'workspacePath')
  const stat = await lstatOrNull(suppliedWorkspace)
  if (!stat?.isDirectory()) throw bad('workspacePath must be an existing directory', 'PRODUCT_WORKSPACE_INVALID')
  const canonicalWorkspace = await fsp.realpath(suppliedWorkspace).catch(() => path.resolve(suppliedWorkspace))
  const key = workspaceKey(canonicalWorkspace)
  const workspace = state.workspaces[key] || {
    workspaceId: `workspace-${hashText(key).slice(0, 16)}`,
    workspacePath: canonicalWorkspace,
    workspaceName: workspaceName(canonicalWorkspace),
    createdAt: nowIso()
  }
  const requestedIds = selectedSystemIds(body)
  const persistedIds = [...new Set((workspace.selectedSystemIds || []).filter(Boolean))]
  const selectionConfirmed = bool(body?.selectionConfirmed) || bool(body?.confirmSelection)
  const ids = selectionConfirmed && requestedIds.length
    ? requestedIds
    : persistedIds.length
      ? persistedIds
      : requestedIds
  if (!ids.length) throw conflict('完成连接前请先选择一个项目体系', 'PRODUCT_SYSTEM_SELECTION_REQUIRED')
  if (workspace.selectionNeedsReview && (!selectionConfirmed || !requestedIds.length)) {
    throw conflict(workspace.selectionReviewMessage || '原有项目体系无法唯一匹配，请明确选择要连接的体系', 'PRODUCT_SYSTEM_SELECTION_REQUIRED', {
      unresolved: workspace.unresolvedSelectedSystemRefs || []
    })
  }
  const analysisId = text(body?.analysisId, workspace.pendingAnalysisId || workspace.lastAnalysisId)
  const analysis = analysisId ? await analysisManifest(productRoot, analysisId).catch(() => null) : null
  if (analysis) {
    const blockedSystems = (analysis.systems || []).filter((system) => system.blocked || system.kind === 'external-link')
    if (blockedSystems.length) throw conflict('检测到工作区外部链接，已停止读取；请先处理安全阻止项后再完成连接', 'PRODUCT_EXTERNAL_LINK', { systems: blockedSystems.map((system) => ({ id: system.id, name: system.name, diagnosticPaths: system.diagnosticPaths || [] })) })
    const selected = analysis.systems.filter((system) => ids.includes(system.id) && system.selectable !== false)
    if (selected.length !== ids.length) throw bad('one or more systems are not in the analysis')
    const freshRefs = selectionRefsForSystems(analysis.systems, ids)
    const retainedRefs = selectionRefsForIds(workspace.selectedSystemRefs, ids)
    if (selectionConfirmed || retainedRefs.length !== ids.length) workspace.selectedSystemRefs = freshRefs
    else workspace.selectedSystemRefs = retainedRefs
    workspace.baselineSignature = analysisSignature(analysis, ids)
    workspace.baselineSafetySignature = analysisSafetySignature(analysis)
    workspace.observedSignature = workspace.baselineSignature
    workspace.observedSafetySignature = workspace.baselineSafetySignature
    workspace.lastAnalysisId = analysis.analysisId
    workspace.lastAnalyzedAt = analysis.createdAt
  } else if (Array.isArray(body?.selectedSystemRefs) && body.selectedSystemRefs.length) {
    const suppliedRefs = selectionRefsForIds(body.selectedSystemRefs, ids)
    const retainedRefs = selectionRefsForIds(workspace.selectedSystemRefs, ids)
    if (suppliedRefs.length === ids.length) workspace.selectedSystemRefs = suppliedRefs
    else if (retainedRefs.length === ids.length) workspace.selectedSystemRefs = retainedRefs
    else throw conflict('连接范围缺少完整的项目体系引用，请重新分析并确认', 'PRODUCT_SYSTEM_SELECTION_REQUIRED')
  }
  workspace.workspacePath = canonicalWorkspace
  workspace.workspaceName = workspaceName(canonicalWorkspace)
  workspace.planId = planId
  workspace.connectedVersion = plan.currentVersion
  workspace.baselineVersion = plan.currentVersion
  workspace.selectedSystemIds = ids
  workspace.unresolvedSelectedSystemRefs = []
  workspace.selectionNeedsReview = false
  workspace.selectionReviewMessage = ''
  workspace.connectionMode = workspace.connectionMode || 'contributed'
  workspace.connectionRecoveryRequired = false
  workspace.safetyBlocked = false
  workspace.hasUpdates = false
  workspace.pendingAnalysisId = null
  workspace.pendingComparisonId = null
  workspace.pendingSummary = null
  workspace.status = workspaceStatus(workspace, false)
  state.workspaces[key] = workspace
  return {
    status: 'connected-noop',
    createdVersion: null,
    version: { versionId: plan.currentVersion, created: false },
    plan: planPublic(plan, currentManifest),
    workspace: publicWorkspace(workspace)
  }
}

async function buildComparison(productRoot, state, body) {
  const planId = requiredText(body?.planId, 'planId')
  const analysisId = requiredText(body?.analysisId, 'analysisId')
  const plan = state.plans[planId]
  if (!plan) throw notFound(`library not found: ${planId}`)
  const analysis = await analysisManifest(productRoot, analysisId)
  const workspace = state.workspaces[workspaceKey(analysis.workspacePath)]
  const blockedSystems = (analysis.systems || []).filter((system) => system.blocked || system.kind === 'external-link')
  if (blockedSystems.length) {
    throw conflict('检测到工作区外部链接，已停止读取；请先处理安全阻止项后再比较', 'PRODUCT_EXTERNAL_LINK', {
      systems: blockedSystems.map((system) => ({
        id: system.id,
        name: system.name,
        unavailableReason: system.unavailableReason || '检测到工作区外部链接，已停止读取。',
        safeReason: system.safeReason || '请将链接目标移入所选工作区，或改用工作区内的规范目录后重新分析。',
        diagnosticPaths: system.diagnosticPaths || []
      }))
    })
  }
  const requestedIds = selectedSystemIds(body)
  const persistedIds = [...new Set(Array.isArray(workspace?.selectedSystemIds) ? workspace.selectedSystemIds.filter(Boolean) : [])]
  const selectionConfirmed = bool(body?.selectionConfirmed) || bool(body?.confirmSelection)
  if (workspace?.selectionNeedsReview && (!selectionConfirmed || !requestedIds.length)) {
    throw conflict(workspace.selectionReviewMessage || '原有项目体系无法唯一匹配，请明确选择要连接的体系', 'PRODUCT_SYSTEM_SELECTION_REQUIRED', {
      unresolved: workspace.unresolvedSelectedSystemRefs || []
    })
  }
  // Once a workspace is connected, its selected systems are the durable
  // scope.  A stale/browser-generated request must not silently widen a
  // re-analysis to every active system discovered in the tree.
  const selectedIds = selectionConfirmed && requestedIds.length
    ? requestedIds
    : persistedIds.length
      ? persistedIds
      : requestedIds
  const includePrivate = bool(body?.includePrivate)
  const selected = analysis.systems.filter((system) => selectedIds.includes(system.id))
  const missingSelectedIds = selectedIds.filter((id) => !selected.some((system) => system.id === id))
  for (const id of missingSelectedIds) {
    const persisted = workspace?.selectedSystemIds?.includes(id)
    if (!persisted) continue
    const reference = workspace.selectedSystemRefs?.find((item) => item?.id === id)
    selected.push({
      id,
      name: reference?.name || id,
      kind: reference?.kind || 'skill',
      status: 'active',
      sourcePath: reference?.sourcePath || '',
      files: []
    })
  }
  if (selected.length !== selectedIds.length) throw bad('one or more systems are not in the analysis')
  const evidenceOnly = selected.filter((system) => system.selectable === false)
  if (evidenceOnly.length) throw conflict('缓存、规则、休眠和其他证据不能直接作为中心库体系', 'PRODUCT_EVIDENCE_NOT_SELECTABLE', { systems: evidenceOnly.map((item) => ({ id: item.id, name: item.name })) })
  const blocked = selected.filter((system) => system.status === 'keep-private' || system.status === 'reference-only')
  if (blocked.length > 0 && !includePrivate) {
    throw conflict('private/reference systems require explicit inclusion', 'PRODUCT_PROTECTED_SYSTEM', {
      systems: blocked.map((item) => ({ id: item.id, name: item.name, status: item.status }))
    })
  }
  const persistedSelectedRefs = selectionRefsForIds(workspace?.selectedSystemRefs, selectedIds)
  const selectedSystemRefs = !selectionConfirmed && persistedSelectedRefs.length === selectedIds.length
    ? persistedSelectedRefs
    : selected.map(systemSelectionRef)
  const selectedFiles = new Map()
  for (const system of selected) {
    if (system.status === 'reference-only' && !includePrivate) continue
    if (system.status === 'keep-private' && !includePrivate) continue
    for (const file of system.files) {
      if (file.dormant || file.referenceOnly || !file.stored) continue
      const logicalPath = file.logicalPath || file.path
      const prior = selectedFiles.get(logicalPath)
      if (prior && prior.contentHash !== file.contentHash) {
        throw conflict(`two selected systems provide different files: ${logicalPath}`, 'PRODUCT_FILE_CONFLICT', { path: logicalPath })
      }
      const origin = {
        systemId: system.id,
        analysisId,
        path: logicalPath,
        physicalPath: file.physicalPath || file.path,
        sourcePath: file.sourcePath || null,
        readOnly: true
      }
      if (!prior) selectedFiles.set(logicalPath, {
        ...file,
        path: logicalPath,
        logicalPath,
        storedPath: file.physicalPath || file.path,
        sourceSystemIds: [system.id],
        origins: [origin]
      })
      else {
        prior.sourceSystemIds = [...new Set([...prior.sourceSystemIds, system.id])]
        prior.origins = [...(prior.origins || []), origin]
      }
    }
  }
  // A connected workspace has a durable baseline. Compare all three sides:
  // baseline at connection time, current center-library version, and the
  // newly observed workspace. This prevents a center-only update from being
  // mislabeled as a workspace addition (and then silently rolled back).
  const baselineVersionId = text(body?.baselineVersion, workspace?.baselineVersion || workspace?.connectedVersion, plan.currentVersion)
  const baselineVersion = baselineVersionId ? await versionManifest(productRoot, planId, baselineVersionId).catch(() => null) : null
  const centerVersionId = plan.currentVersion || null
  const centerVersion = centerVersionId ? await versionManifest(productRoot, planId, centerVersionId) : null
  const baselineByPath = new Map((baselineVersion?.files || []).map((file) => [file.path, file]))
  const centerByPath = new Map((centerVersion?.files || []).map((file) => [file.path, file]))
  const desiredByPath = new Map()
  const files = []
  const workspaceUpdate = text(body?.mode).trim().toLowerCase() === 'update'
  const selectedScope = new Set(selectedIds)
  const selectedScopePaths = new Set(selectedSystemRefs
    .flatMap((reference) => Array.isArray(reference.paths) ? reference.paths : [])
    .map(stablePathKey)
    .filter(Boolean))
  const allowDeletions = bool(body?.allowDeletions)
  const detectDeletions = allowDeletions || Boolean(workspace?.connectionMode || workspace?.baselineVersion || workspace?.connectedVersion)
  const belongsToSelectedScope = (record) => {
    if (!record || !selectedScope.size) return false
    // A durable path set is the authoritative connected scope. Source-system
    // ids are only a compatibility fallback for legacy records that never
    // persisted the complete reference.
    if (selectedScopePaths.size) return selectedScopePaths.has(stablePathKey(record.path))
    const sourceIds = [
      ...(Array.isArray(record.sourceSystemIds) ? record.sourceSystemIds : []),
      ...(Array.isArray(record.origins) ? record.origins.map((origin) => origin?.systemId) : [])
    ].filter(Boolean)
    return sourceIds.some((id) => selectedScope.has(id))
  }
  const sameState = (leftRecord, leftContent, rightRecord, rightContent) => (
    Boolean(leftRecord) === Boolean(rightRecord) && canonicalText(leftContent) === canonicalText(rightContent)
  )
  const sourceFor = (record, direction) => {
    if (!record) return null
    if (direction === 'workspace-only' || direction === 'both-same') {
      return { kind: 'analysis', analysisId, storedPath: record.storedPath || record.physicalPath || record.path }
    }
    return { kind: 'version', versionId: centerVersionId || baselineVersionId }
  }
  const allPaths = new Set([...baselineByPath.keys(), ...centerByPath.keys(), ...selectedFiles.keys()])
  for (const relative of [...allPaths].sort()) {
    const baselineRecord = baselineByPath.get(relative) || null
    const centerRecord = centerByPath.get(relative) || null
    const baselineInSelectedScope = belongsToSelectedScope(baselineRecord)
    const observedInWorkspace = selectedFiles.has(relative)
    // A center-only record may be present in an older library manifest even
    // though it was never part of the selected workspace scope. If the
    // current center version no longer has that record and the workspace did
    // not observe it either, both sides are intentionally absent; there is no
    // workspace deletion or conflict to review.
    if (!baselineInSelectedScope && !observedInWorkspace && !centerRecord && baselineRecord) continue
    // In an update flow only an observed file or a file that belonged to the
    // connected workspace baseline may participate.  Center-only records are
    // library state, not evidence that the workspace deleted anything.
    if (workspaceUpdate && !observedInWorkspace && !baselineInSelectedScope) continue
    const observedRecord = selectedFiles.has(relative)
      ? selectedFiles.get(relative)
      : detectDeletions && baselineInSelectedScope ? null : baselineRecord
    const baselineContent = baselineRecord ? await versionRecordContent(productRoot, planId, baselineVersionId, baselineRecord) : ''
    const centerContent = centerRecord ? await versionRecordContent(productRoot, planId, centerVersionId, centerRecord) : ''
    const observedContent = observedRecord
      ? observedInWorkspace
        ? await analysisFileContent(productRoot, analysisId, relative, observedRecord.storedPath || observedRecord.physicalPath || observedRecord.path)
        // A non-selected baseline record is a library lineage record, not a
        // missing workspace observation. Reusing its baseline body keeps
        // center-only edits on the center side of the comparison.
        : baselineContent
      : ''
    const centerChanged = !sameState(centerRecord, centerContent, baselineRecord, baselineContent)
    const workspaceChanged = !sameState(observedRecord, observedContent, baselineRecord, baselineContent)
    let direction = 'unchanged'
    let desiredRecord = centerRecord || observedRecord || null
    let desiredContent = centerRecord ? centerContent : observedContent
    let resolutionRequired = false
    if (!workspaceChanged) {
      direction = centerChanged ? 'center-only' : 'unchanged'
      desiredRecord = centerRecord || null
      desiredContent = centerContent
    } else if (!centerChanged) {
      direction = 'workspace-only'
      desiredRecord = observedRecord
      desiredContent = observedContent
    } else if (sameState(centerRecord, centerContent, observedRecord, observedContent)) {
      direction = 'both-same'
      desiredRecord = centerRecord || observedRecord || null
      desiredContent = centerRecord ? centerContent : observedContent
    } else {
      direction = 'conflict'
      resolutionRequired = true
      // Keep the center side as the safe, explicit default. The UI exposes
      // the two sides and requires a resolution before a draft can commit.
      desiredRecord = centerRecord || observedRecord || null
      desiredContent = centerRecord ? centerContent : observedContent
    }
    if (desiredRecord) {
      desiredByPath.set(relative, {
        ...desiredRecord,
        path: relative,
        logicalPath: relative,
        contentSource: sourceFor(desiredRecord, direction),
        sourceSystemIds: desiredRecord.sourceSystemIds || []
      })
    }
    // Both sides already contain the same canonical body. Preserve its
    // provenance in desiredFiles, but do not present or select it as work the
    // merge still needs to perform.
    if (direction === 'unchanged' || direction === 'both-same') continue
    const diffOldContent = direction === 'center-only' ? baselineContent : centerContent
    const oldPreview = contentPreview(diffOldContent)
    const newPreview = contentPreview(desiredContent)
    files.push({
      path: relative,
      changeType: centerRecord ? desiredRecord ? 'modified' : 'deleted' : desiredRecord ? 'added' : 'deleted',
      direction,
      resolutionRequired,
      defaultResolution: resolutionRequired ? 'keep-center' : direction === 'center-only' ? 'keep-center' : 'apply-workspace',
      baselineContent: contentPreview(baselineContent).value,
      baselineHash: baselineRecord?.contentHash || null,
      centerHash: centerRecord?.contentHash || null,
      workspaceHash: selectedFiles.get(relative)?.contentHash || null,
      oldHash: direction === 'center-only' ? baselineRecord?.contentHash || null : centerRecord?.contentHash || null,
      newHash: desiredRecord?.contentHash || null,
      oldContent: oldPreview.value,
      newContent: newPreview.value,
      oldTruncated: oldPreview.truncated,
      newTruncated: newPreview.truncated,
      diff: diffLines(diffOldContent, desiredContent),
      sourceSystemIds: desiredRecord?.sourceSystemIds || observedRecord?.sourceSystemIds || centerRecord?.sourceSystemIds || [],
      managed: desiredRecord?.managed !== false,
      contentSource: desiredRecord ? sourceFor(desiredRecord, direction) : null,
      centerContentSource: centerRecord ? { kind: 'version', versionId: centerVersionId, storagePath: centerRecord.storagePath || centerRecord.path } : null,
      workspaceContentSource: observedRecord ? { kind: 'analysis', analysisId, storedPath: observedRecord.storedPath || observedRecord.physicalPath || observedRecord.path } : null
    })
  }
  const workspaceChangedFiles = files.filter((file) => ['workspace-only', 'conflict'].includes(file.direction))
  const comparisonId = randomId('comparison')
  const comparison = {
    schemaVersion: SCHEMA_VERSION,
    comparisonId,
    planId,
    analysisId,
    sourceWorkspace: analysis.workspacePath,
    baseVersion: centerVersionId,
    baselineVersion: baselineVersionId || null,
    centerVersion: centerVersionId,
    workspaceAnalysisId: analysisId,
    selectedSystemIds: [...selectedIds],
    selectedSystemRefs,
    // Keep this compact view for existing clients; it is not the durable
    // selection record and must never be used to reconstruct one.
    selectedSystems: selected.map((system) => ({ id: system.id, name: system.name, kind: system.kind, sourcePath: system.sourcePath || '', status: system.status })),
    createdAt: nowIso(),
    summary: {
      changedFiles: files.length,
      added: files.filter((file) => file.changeType === 'added').length,
      modified: files.filter((file) => file.changeType === 'modified').length,
      deleted: files.filter((file) => file.changeType === 'deleted').length,
      workspaceChanged: workspaceChangedFiles.length,
      noOp: workspaceChangedFiles.length === 0,
      centerOnly: files.filter((file) => file.direction === 'center-only').length,
      conflicts: files.filter((file) => file.resolutionRequired).length
    },
    files,
    desiredFiles: [...desiredByPath.values()].map((file) => ({
      path: file.path,
      contentHash: file.contentHash,
      size: file.size,
      mode: file.mode || '100644',
      sourceSystemIds: file.sourceSystemIds || [],
      managed: file.managed !== false,
      contentSource: file.contentSource,
      direction: files.find((change) => change.path === file.path)?.direction || 'unchanged',
      resolutionRequired: Boolean(files.find((change) => change.path === file.path)?.resolutionRequired)
    }))
  }
  await atomicJson(productPath(productRoot, 'comparisons', comparisonId, 'manifest.json'), comparison, productRoot)
  if (selectionConfirmed && workspace) {
    workspace.selectedSystemIds = [...selectedIds]
    workspace.selectedSystemRefs = selectionRefsForSystems(analysis.systems, selectedIds)
    workspace.unresolvedSelectedSystemRefs = []
    workspace.selectionNeedsReview = false
    workspace.selectionReviewMessage = ''
  }
  state.comparisons[comparisonId] = { comparisonId, planId, analysisId, createdAt: comparison.createdAt, dir: `comparisons/${comparisonId}` }
  return comparison
}

async function readComparison(productRoot, comparisonId) {
  const value = await readJson(productPath(productRoot, 'comparisons', requiredText(comparisonId, 'comparisonId'), 'manifest.json'), null)
  if (!value) throw notFound(`comparison not found: ${comparisonId}`)
  return value
}

async function buildVersionDiff(productRoot, planId, fromVersion, toVersion) {
  const from = await versionManifest(productRoot, planId, fromVersion)
  const to = await versionManifest(productRoot, planId, toVersion)
  const fromByPath = new Map((from.files || []).map((file) => [file.path, file]))
  const toByPath = new Map((to.files || []).map((file) => [file.path, file]))
  const files = []
  for (const relative of [...new Set([...fromByPath.keys(), ...toByPath.keys()])].sort()) {
    const oldRecord = fromByPath.get(relative) || null
    const newRecord = toByPath.get(relative) || null
    const oldContent = oldRecord ? await versionRecordContent(productRoot, planId, fromVersion, oldRecord) : ''
    const newContent = newRecord ? await versionRecordContent(productRoot, planId, toVersion, newRecord) : ''
    if (Boolean(oldRecord) === Boolean(newRecord) && canonicalText(oldContent) === canonicalText(newContent)) continue
    const oldPreview = contentPreview(oldContent)
    const newPreview = contentPreview(newContent)
    files.push({
      path: relative,
      changeType: oldRecord ? newRecord ? 'modified' : 'deleted' : 'added',
      oldHash: oldRecord?.contentHash || null,
      newHash: newRecord?.contentHash || null,
      oldContent: oldPreview.value,
      newContent: newPreview.value,
      oldTruncated: oldPreview.truncated,
      newTruncated: newPreview.truncated,
      diff: diffLines(oldContent, newContent),
      managed: newRecord?.managed !== false,
      contentSource: newRecord ? { kind: 'version', versionId: toVersion } : null
    })
  }
  return { from, to, files }
}

async function buildVersionComparison(productRoot, state, body) {
  const planId = requiredText(body?.planId, 'planId')
  const fromVersion = requiredText(body?.fromVersion || body?.baseVersion, 'fromVersion')
  const toVersion = requiredText(body?.toVersion || body?.versionId, 'toVersion')
  if (!state.plans[planId]) throw notFound(`library not found: ${planId}`)
  const { to, files } = await buildVersionDiff(productRoot, planId, fromVersion, toVersion)
  const comparison = {
    schemaVersion: SCHEMA_VERSION,
    comparisonId: randomId('comparison'),
    planId,
    analysisId: null,
    sourceWorkspace: state.plans[planId].sourceWorkspace,
    baseVersion: fromVersion,
    targetVersion: toVersion,
    selectedSystems: [],
    createdAt: nowIso(),
    summary: {
      changedFiles: files.length,
      added: files.filter((file) => file.changeType === 'added').length,
      modified: files.filter((file) => file.changeType === 'modified').length,
      deleted: files.filter((file) => file.changeType === 'deleted').length
    },
    files,
    desiredFiles: (to.files || []).map((file) => ({ ...file, contentSource: { kind: 'version', versionId: toVersion } }))
  }
  await atomicJson(productPath(productRoot, 'comparisons', comparison.comparisonId, 'manifest.json'), comparison, productRoot)
  state.comparisons[comparison.comparisonId] = { comparisonId: comparison.comparisonId, planId, createdAt: comparison.createdAt, dir: `comparisons/${comparison.comparisonId}` }
  return comparison
}

async function draftContent(productRoot, draft, relative) {
  const normalized = normalizeRelative(relative)
  if (!normalized) throw bad('draft file path is unsafe', 'PRODUCT_PATH_ESCAPE')
  const file = productPath(productRoot, 'drafts', draft.draftId, 'files', ...normalized.split('/'))
  const stat = await lstatOrNull(file)
  if (!stat?.isFile()) throw notFound(`draft file not found: ${normalized}`)
  return readFileOrEmpty(file)
}

function publicDraft(draft) {
  const reviewFiles = draft.files.filter((file) => file.editable !== false)
  return {
    draftId: draft.draftId,
    planId: draft.planId,
    comparisonId: draft.comparisonId,
    baseVersion: draft.baseVersion,
    status: draft.status,
    commitReceipt: draft.commitReceipt || null,
    mergeReceipt: draft.mergeReceipt || mergeReceiptFromCommitReceipt(draft.commitReceipt),
    action: draft.action || 'edit',
    origin: draft.origin || 'workspace-review',
    message: draft.message || '',
    preview: draft.preview || null,
    conflicts: draft.files.filter((file) => file.resolutionRequired).map((file) => file.path),
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    files: reviewFiles,
    editablePaths: draft.editablePaths,
    confirmedCount: reviewFiles.filter((file) => file.confirmed).length,
    fileCount: reviewFiles.length,
    allConfirmed: reviewFiles.length > 0 && reviewFiles.every((file) => file.confirmed)
  }
}

async function createDraft(productRoot, state, body) {
  let comparison
  if (body?.comparisonId) {
    comparison = await readComparison(productRoot, body.comparisonId)
  } else {
    const planId = requiredText(body?.planId, 'planId')
    const plan = state.plans[planId]
    if (!plan?.currentVersion) throw notFound(`library not found: ${planId}`)
    const versionId = text(body?.versionId, plan.currentVersion)
    const version = await versionManifest(productRoot, planId, versionId)
    comparison = {
      comparisonId: randomId('manual-draft-source'),
      planId,
      baseVersion: versionId,
      analysisId: null,
      desiredFiles: (version.files || []).map((file) => ({ ...file, contentSource: { kind: 'version', versionId } }))
    }
  }
  const action = text(body?.action, 'edit').trim().toLowerCase()
  if (!['edit', 'create', 'delete'].includes(action)) throw bad('draft action is unsupported')
  const plan = state.plans[comparison.planId]
  const centerVersion = plan?.currentVersion
  const currentVersion = comparison.baseVersion || centerVersion
  if (!currentVersion) throw notFound(`library not found: ${comparison.planId}`)
  if (!centerVersion) throw notFound(`library not found: ${comparison.planId}`)
  const contentCode = action === 'delete' ? 'PRODUCT_DRAFT_ORIGINAL_CONTENT_UNAVAILABLE' : 'PRODUCT_CURRENT_VERSION_CONTENT_UNAVAILABLE'
  const currentVersionManifest = await versionManifest(productRoot, comparison.planId, currentVersion)
  await assertVersionBodiesAvailable(productRoot, comparison.planId, currentVersion, currentVersionManifest, {
    // Keep the existing deletion-specific contract while making every
    // manual/edit draft fail closed before it can write a draft body.
    code: contentCode
  })
  if (currentVersion !== centerVersion) {
    const centerManifest = await versionManifest(productRoot, comparison.planId, centerVersion)
    await assertVersionBodiesAvailable(productRoot, comparison.planId, centerVersion, centerManifest, { code: contentCode })
  }
  const existingPaths = new Set((currentVersionManifest.files || []).map((file) => file.path))
  const suppliedPath = text(body?.path || body?.filePath).trim()
  const requestedPath = suppliedPath ? normalizeRelative(suppliedPath) : null
  if ((action === 'create' || action === 'delete' || suppliedPath) && !requestedPath) throw bad('path is unsafe', 'PRODUCT_PATH_ESCAPE')
  if ((action === 'create' && existingPaths.has(requestedPath)) || (action === 'delete' && !existingPaths.has(requestedPath))) {
    throw conflict(action === 'create' ? `中心库已经存在文件: ${requestedPath}` : `中心库没有这个文件: ${requestedPath}`, 'PRODUCT_FILE_STATE_CONFLICT')
  }
  if (action === 'create') {
    const inlineContent = text(body?.content, '')
    comparison = {
      ...comparison,
      desiredFiles: [
        ...(comparison.desiredFiles || []),
        {
          path: requestedPath,
          logicalPath: requestedPath,
          size: Buffer.byteLength(inlineContent, 'utf8'),
          contentHash: contentHash(inlineContent),
          mode: '100644',
          sourceSystemIds: [],
          managed: true,
          contentSource: { kind: 'inline', content: inlineContent }
        }
      ]
    }
  }
  const draftId = randomId('draft')
  const comparisonChanges = Array.isArray(comparison.files) ? comparison.files : []
  let requestedPaths = null
  if (Array.isArray(body?.paths)) {
    const normalizedPaths = body.paths.map((item) => normalizeRelative(item))
    if (normalizedPaths.some((item) => !item)) throw bad('selected file path is unsafe', 'PRODUCT_PATH_ESCAPE')
    requestedPaths = new Set(normalizedPaths)
    if (!requestedPaths.size) throw conflict('请至少选择一个要进入草稿的文件', 'PRODUCT_FILE_SELECTION_REQUIRED')
  }
  const comparisonPaths = Array.isArray(comparison.files)
    ? new Set(comparison.files.filter((item) => item?.direction !== 'center-only').map((item) => normalizeRelative(item?.path)).filter(Boolean))
    : null
  const reviewPaths = requestedPath ? new Set([requestedPath]) : requestedPaths || comparisonPaths
  const desiredFiles = Array.isArray(comparison.desiredFiles) ? comparison.desiredFiles : []
  const knownPaths = new Set([
    ...desiredFiles.map((file) => normalizeRelative(file?.path)).filter(Boolean),
    ...comparisonChanges.filter((file) => file?.direction !== 'center-only').map((file) => normalizeRelative(file?.path)).filter(Boolean)
  ])
  if (requestedPaths && Array.isArray(comparison.files)) {
    const unknown = [...requestedPaths].filter((relative) => !knownPaths.has(relative))
    if (unknown.length) throw conflict(`所选文件不在当前差异范围内: ${unknown.join(', ')}`, 'PRODUCT_FILE_NOT_EDITABLE')
    const centerOnly = comparisonChanges.find((file) => requestedPaths.has(normalizeRelative(file?.path)) && file?.direction === 'center-only')
    if (centerOnly) throw conflict(`中心库单边变化不能作为工作区草稿: ${centerOnly.path}`, 'PRODUCT_FILE_NOT_EDITABLE')
  }
  // A draft is a user-selected patch, not a second copy of the whole center
  // library.  Commit overlays these records onto the current version so every
  // unselected file remains intact.
  const draftDesiredFiles = desiredFiles.filter((desired) => !reviewPaths || reviewPaths.has(normalizeRelative(desired?.path)))
  const draftDesiredPaths = new Set(draftDesiredFiles.map((file) => file.path))
  // A missing workspace file has no desired record. Keep a zero-content
  // tombstone in the draft so deletion is visible, individually confirmable,
  // and only removed from the next library version after that confirmation.
  for (const change of comparisonChanges) {
    if (change.direction === 'center-only' || change.changeType !== 'deleted' || !reviewPaths?.has(change.path) || draftDesiredPaths.has(change.path)) continue
    draftDesiredFiles.push({
      path: change.path,
      logicalPath: change.path,
      size: 0,
      contentHash: null,
      mode: '100644',
      sourceSystemIds: [],
      origins: [],
      managed: change.managed !== false,
      deleted: true,
      direction: change.direction,
      resolutionRequired: Boolean(change.resolutionRequired),
      originalContent: '',
      originalContentSource: change.centerContentSource || null,
      diff: change.diff || []
    })
    draftDesiredPaths.add(change.path)
  }
  const draft = {
    schemaVersion: SCHEMA_VERSION,
    draftId,
    planId: comparison.planId,
    comparisonId: comparison.comparisonId,
    baseVersion: comparison.baseVersion,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    status: 'editing',
    action,
    origin: text(body?.origin, action === 'create' ? 'library-create' : action === 'delete' ? 'library-delete' : body?.comparisonId ? 'workspace-review' : 'library-manual-edit'),
    message: text(body?.message, action === 'create' ? `创建文件 ${requestedPath}` : action === 'delete' ? `删除文件 ${requestedPath}` : '中心库手动编辑'),
    preview: {
      title: action === 'create' ? '新建文件预览' : action === 'delete' ? '删除文件预览' : '中心库手动编辑预览',
      protection: '保存前保留原版本，可回滚',
      targetPath: requestedPath || null
    },
    editablePaths: reviewPaths ? [...reviewPaths] : null,
    files: []
  }
  for (const desired of draftDesiredFiles) {
    const comparisonChange = comparisonChanges.find((change) => change.path === desired.path)
    const isDeleted = Boolean(desired.deleted || (action === 'delete' && desired.path === requestedPath))
    let content = ''
    let originalContent = ''
    let originalContentAvailable = !isDeleted
    if (!isDeleted && desired.contentSource?.kind === 'version') {
      content = await versionContent(productRoot, comparison.planId, desired.contentSource.versionId, desired.storagePath || desired.path)
    } else if (!isDeleted && desired.contentSource?.kind === 'analysis') {
      content = await analysisFileContent(productRoot, desired.contentSource.analysisId, desired.path, desired.contentSource.storedPath || desired.path)
    } else if (!isDeleted && desired.contentSource?.kind === 'inline') {
      content = text(desired.contentSource.content)
    }
    if (isDeleted) {
      const source = comparisonChange?.centerContentSource || desired.originalContentSource || (desired.contentSource?.kind === 'version' ? desired.contentSource : null)
      const sourceVersionId = text(source?.versionId, currentVersion)
      const sourcePath = text(source?.storagePath) || text(source?.path) || text(desired.storagePath) || desired.path
      if (!sourceVersionId || !sourcePath) {
        throw conflict(`无法读取待删除文件的当前中心库正文: ${desired.path}`, 'PRODUCT_DRAFT_ORIGINAL_CONTENT_UNAVAILABLE', { path: desired.path })
      }
      try {
        originalContent = await versionContent(productRoot, comparison.planId, sourceVersionId, sourcePath)
        originalContentAvailable = true
      } catch (error) {
        throw conflict(`无法读取待删除文件的当前中心库正文: ${desired.path}`, 'PRODUCT_DRAFT_ORIGINAL_CONTENT_UNAVAILABLE', {
          path: desired.path,
          versionId: sourceVersionId,
          cause: error?.message || String(error)
        })
      }
    }
    const diff = isDeleted ? diffLines(originalContent, '') : desired.diff || comparisonChange?.diff || diffLines(originalContent || content, content)
    const additions = Array.isArray(diff) ? diff.filter((line) => line.type === 'add').length : 0
    const deletions = Array.isArray(diff) ? diff.filter((line) => line.type === 'remove').length : 0
    const target = productPath(productRoot, 'drafts', draftId, 'files', ...desired.path.split('/'))
    await atomicBytes(target, Buffer.from(content, 'utf8'), productPath(productRoot, 'drafts', draftId))
    draft.files.push({
      path: desired.path,
      contentHash: isDeleted ? null : contentHash(content),
      size: Buffer.byteLength(content, 'utf8'),
      mode: desired.mode || '100644',
      sourceSystemIds: desired.sourceSystemIds || [],
      origins: desired.origins || [],
      managed: desired.managed !== false,
      editable: reviewPaths ? reviewPaths.has(desired.path) : true,
      // Tombstones remain visible and human-confirmable, but they are never
      // an AI-editable scope. Their original body is an immutable echo only.
      aiEditable: !isDeleted && (reviewPaths ? reviewPaths.has(desired.path) : true),
      confirmed: reviewPaths ? !reviewPaths.has(desired.path) : false,
      deleted: isDeleted,
      direction: desired.direction || comparisonChange?.direction || 'manual',
      resolutionRequired: Boolean(desired.resolutionRequired || comparisonChange?.resolutionRequired),
      originalContent,
      originalContentAvailable,
      additions,
      deletions,
      diff
    })
  }
  await atomicJson(productPath(productRoot, 'drafts', draftId, 'manifest.json'), draft, productRoot)
  state.drafts[draftId] = { draftId, planId: draft.planId, comparisonId: draft.comparisonId, createdAt: draft.createdAt, dir: `drafts/${draftId}` }
  return draft
}

async function readDraft(productRoot, draftId) {
  const id = requiredText(draftId, 'draftId')
  const value = await readJson(productPath(productRoot, 'drafts', id, 'manifest.json'), null)
  if (!value) throw notFound(`draft not found: ${id}`)
  if (value.committedVersion) {
    const receipt = await readCommitReceiptForVersion(productRoot, value.planId, value.committedVersion)
    // A committed draft is readable only with its immutable per-version
    // receipt. Never surface a mutable receipt field copied into a draft
    // manifest when the authoritative file is absent or malformed.
    const mergeReceipt = await readMergeReceiptForVersion(productRoot, value.planId, value.committedVersion)
    return { ...value, commitReceipt: receipt, mergeReceipt }
  }
  return value
}

async function publicDraftWithContent(productRoot, draft, requestedPath) {
  const selected = requestedPath ? normalizeRelative(requestedPath) : null
  if (requestedPath && !selected) throw bad('draft file path is unsafe', 'PRODUCT_PATH_ESCAPE')
  if (selected && !draft.files.some((file) => file.path === selected)) throw notFound(`draft file not found: ${selected}`)
  const files = []
  let remaining = MAX_INLINE_BYTES
  const reviewFiles = draft.files.filter((file) => file.editable !== false)
  for (const file of reviewFiles) {
    if (selected && file.path !== selected) continue
    const content = await draftContent(productRoot, draft, file.path)
    const limit = selected ? MAX_ANALYSIS_FILE_BYTES : Math.max(0, remaining)
    const preview = contentPreview(content.slice(0, limit))
    const truncated = Buffer.byteLength(content, 'utf8') > limit || preview.truncated
    const originalContentAvailable = !file.deleted
      ? true
      : file.originalContentAvailable === true || (file.originalContentAvailable === undefined && typeof file.originalContent === 'string' && file.originalContent.length > 0)
    files.push({
      ...file,
      content: preview.value,
      finalContent: preview.value,
      originalContent: file.deleted ? (originalContentAvailable ? String(file.originalContent || '') : '') : (file.originalContent || preview.value),
      originalContentAvailable,
      diff: file.diff || diffLines(file.deleted ? (originalContentAvailable ? String(file.originalContent || '') : '') : (file.originalContent || preview.value), preview.value),
      truncated
    })
    remaining -= Buffer.byteLength(preview.value, 'utf8')
    if (!selected && remaining <= 0) break
  }
  return { ...publicDraft(draft), files, file: selected ? files[0] || null : undefined }
}

async function saveDraft(productRoot, draft) {
  draft.updatedAt = nowIso()
  await atomicJson(productPath(productRoot, 'drafts', draft.draftId, 'manifest.json'), draft, productRoot)
}

function manifestCounts(manifest) {
  const files = Array.isArray(manifest?.files) ? manifest.files : []
  return {
    skillCount: files.filter((file) => /(?:^|\/)SKILL\.md$/iu.test(file.path)).length,
    ruleCount: files.filter((file) => /^rules\//iu.test(file.path)).length,
    fileCount: files.length
  }
}

function planPublic(plan, manifest = null) {
  const counts = manifest ? manifestCounts(manifest) : {
    skillCount: plan.skillCount || 0,
    ruleCount: plan.ruleCount || 0,
    fileCount: plan.fileCount || 0
  }
  return {
    planId: plan.planId,
    name: plan.name,
    sourceWorkspace: plan.sourceWorkspace,
    currentVersion: plan.currentVersion,
    skillCount: counts.skillCount,
    ruleCount: counts.ruleCount,
    fileCount: counts.fileCount,
    versions: plan.versions,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt
  }
}

function authoritativeLibrarySystems(plan, manifest) {
  const files = Array.isArray(manifest?.files) ? manifest.files : []
  const declared = Array.isArray(manifest?.sourceSystems) && manifest.sourceSystems.length
    ? manifest.sourceSystems
    : Array.isArray(plan?.sourceSystems) ? plan.sourceSystems : []
  if (!declared.length) {
    const counts = manifestCounts(manifest)
    return [{
      id: 'current-library',
      name: plan?.name || '中心库内容',
      kind: 'project',
      status: 'active',
      sourcePath: plan?.sourceWorkspace || '.',
      files,
      ...counts
    }]
  }
  const assigned = new Map(declared.map((system) => [system.id, []]))
  const unassigned = []
  for (const file of files) {
    const ids = [...new Set([
      ...(Array.isArray(file.sourceSystemIds) ? file.sourceSystemIds : []),
      ...(Array.isArray(file.origins) ? file.origins.map((origin) => origin?.systemId) : [])
    ].filter((id) => assigned.has(id)))]
    if (!ids.length) unassigned.push(file)
    else for (const id of ids) assigned.get(id).push(file)
  }
  const primaryId = declared[0]?.id
  if (primaryId && unassigned.length) assigned.get(primaryId).push(...unassigned)
  return declared.map((system) => {
    const systemFiles = assigned.get(system.id) || []
    const counts = manifestCounts({ files: systemFiles })
    return { ...system, files: systemFiles, ...counts }
  })
}

async function initializeLibrary(productRoot, state, body) {
  const analysis = await analysisManifest(productRoot, body?.analysisId)
  if (!bool(body?.acknowledgeProtection)) {
    throw conflict('请先查看纳入范围和保全边界，再创建中心库 v1', 'PRODUCT_PROTECTION_ACK_REQUIRED')
  }
  const selectedIds = selectedSystemIds(body)
  const selected = analysis.systems.filter((system) => selectedIds.includes(system.id))
  if (!selected.length) throw bad('select at least one active system')
  const evidenceOnly = selected.filter((system) => system.selectable === false)
  if (evidenceOnly.length) throw conflict('请选择有 Skill 内容的项目方案，证据项不能直接入库', 'PRODUCT_EVIDENCE_NOT_SELECTABLE', { systems: evidenceOnly.map((item) => ({ id: item.id, name: item.name })) })
  const includePrivate = bool(body?.includePrivate)
  const blocked = selected.filter((system) => system.status !== 'active')
  if (blocked.length && !includePrivate) throw conflict('私有或脏改体系默认不入库，请明确确认后再选择', 'PRODUCT_PROTECTED_SYSTEM')
  const planId = randomId('library')
  const createdAt = nowIso()
  const versionId = 'v1'
  const files = []
  const seen = new Map()
  for (const system of selected) {
    for (const file of system.files) {
      if (file.referenceOnly || !file.stored) continue
      const logicalPath = file.logicalPath || file.path
      const prior = seen.get(logicalPath)
      if (prior && prior.contentHash !== file.contentHash) throw conflict(`selected systems conflict at ${logicalPath}`, 'PRODUCT_FILE_CONFLICT')
      if (prior) {
        prior.sourceSystemIds = [...new Set([...prior.sourceSystemIds, system.id])]
        continue
      }
      const content = await analysisFileContent(productRoot, analysis.analysisId, logicalPath, file.physicalPath || file.path)
      const target = productPath(productRoot, 'library', planId, 'versions', versionId, 'files', ...logicalPath.split('/'))
      await atomicBytes(target, Buffer.from(content, 'utf8'), productPath(productRoot, 'library', planId))
      const record = {
        path: logicalPath,
        logicalPath,
        physicalPath: file.physicalPath || file.path,
        size: Buffer.byteLength(content, 'utf8'),
        contentHash: contentHash(content),
        mode: '100644',
        sourceSystemIds: [system.id],
        origins: [{
          systemId: system.id,
          analysisId: analysis.analysisId,
          path: logicalPath,
          physicalPath: file.physicalPath || file.path,
          sourcePath: file.sourcePath || null,
          readOnly: true
        }],
        managed: true
      }
      files.push(record)
      seen.set(logicalPath, record)
    }
  }
  if (!files.length) throw bad('selected systems contain no copyable files', 'PRODUCT_EMPTY_LIBRARY')
  const selectedSystemsPublic = selected.map((item) => publicSystem(item, analysis.analysisId))
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    planId,
    versionId,
    createdAt,
    message: text(body?.message, '首次选择的中心库'),
    sourceAnalysisId: analysis.analysisId,
    sourceWorkspace: analysis.workspacePath,
    sourceSystems: selectedSystemsPublic.map((system) => ({
      id: system.id, name: system.name, kind: system.kind, status: system.status,
      sourcePath: system.sourcePath, fileCount: system.fileCount, skillCount: system.skillCount, ruleCount: system.ruleCount,
      sources: system.sources || system.projections || [],
      files: system.files || []
    })),
    files: files.sort((a, b) => a.path.localeCompare(b.path))
  }
  await atomicJson(productPath(productRoot, 'library', planId, 'versions', versionId, 'manifest.json'), manifest, productRoot)
  const plan = {
    schemaVersion: SCHEMA_VERSION,
    planId,
    name: text(body?.name, `${analysis.workspaceName} 中心库`),
    sourceWorkspace: analysis.workspacePath,
    currentVersion: versionId,
    skillCount: files.filter((file) => /(?:^|\/)SKILL\.md$/iu.test(file.path)).length,
    ruleCount: files.filter((file) => /^rules\//iu.test(file.path)).length,
    fileCount: files.length,
    sourceAnalysisId: analysis.analysisId,
    sourceSystems: manifest.sourceSystems,
    versions: [{ versionId, createdAt, message: manifest.message, fileCount: files.length, sourceAnalysisId: analysis.analysisId }],
    createdAt,
    updatedAt: createdAt
  }
  state.plans[planId] = plan
  state.activePlanId = planId
  const workspace = observeWorkspace(state, analysis)
  workspace.planId = planId
  workspace.connectionMode = 'source'
  workspace.connectedVersion = versionId
  workspace.baselineVersion = versionId
  workspace.selectedSystemIds = selected.map((item) => item.id)
  workspace.selectedSystemRefs = selected.map(systemSelectionRef)
  workspace.baselineSignature = analysisSignature(analysis, workspace.selectedSystemIds)
  workspace.baselineSafetySignature = analysisSafetySignature(analysis)
  workspace.observedSafetySignature = workspace.baselineSafetySignature
  workspace.observedSignature = workspace.baselineSignature
  workspace.unresolvedSelectedSystemRefs = []
  workspace.selectionNeedsReview = false
  workspace.selectionReviewMessage = ''
  workspace.safetyBlocked = false
  workspace.connectionRecoveryRequired = false
  workspace.hasUpdates = false
  workspace.pendingAnalysisId = null
  workspace.pendingSummary = null
  workspace.status = 'connected'
  return { plan: planPublic(plan, manifest), version: manifest, selectedSystems: selectedSystemsPublic, workspace: publicWorkspace(workspace) }
}

async function readLibrary(productRoot, state, body) {
  const suppliedPlanId = text(body?.get?.('planId') || body?.planId)
  const planId = suppliedPlanId || state.activePlanId
  const plans = await Promise.all(Object.values(state.plans).map(async (item) => {
    const manifest = item.currentVersion ? await versionManifest(productRoot, item.planId, item.currentVersion).catch(() => null) : null
    return planPublic(item, manifest)
  }))
  if (!planId) return { activePlanId: null, plans }
  const plan = state.plans[planId]
  if (!plan) throw notFound(`library not found: ${planId}`)
  const current = plan.currentVersion ? await versionManifest(productRoot, planId, plan.currentVersion) : null
  const systems = current ? authoritativeLibrarySystems(plan, current) : []
  const requestedVersionId = text(body?.get?.('versionId') || body?.get?.('version') || body?.versionId || body?.version)
  const requestedDraftId = text(body?.get?.('draftId') || body?.draftId)
  const commitReceipt = await resolveCommitReceipt(productRoot, state, {
    // A draft id is authoritative even when the browser has not retained the
    // plan id. Do not accidentally constrain recovery to the active plan.
    planId: requestedDraftId && !suppliedPlanId ? '' : planId,
    versionId: requestedVersionId || (requestedDraftId ? '' : plan.currentVersion || ''),
    draftId: requestedDraftId
  })
  const mergeReceipt = await resolveMergeReceipt(productRoot, state, {
    planId: requestedDraftId && !suppliedPlanId ? '' : planId,
    versionId: requestedVersionId || (requestedDraftId ? '' : plan.currentVersion || ''),
    draftId: requestedDraftId,
    comparisonId: commitReceipt?.comparisonId || ''
  })
  return {
    activePlanId: state.activePlanId,
    plan: { ...planPublic(plan, current), sourceSystems: systems },
    current,
    systems,
    sources: systems.flatMap((system) => Array.isArray(system.sources) ? system.sources : []),
    commitReceipt,
    mergeReceipt,
    commitReceipts: await commitReceiptList(productRoot, state, planId)
  }
}

async function readLibraryFile(productRoot, state, searchParams) {
  const relative = requiredText(searchParams?.get?.('path') || searchParams?.path, 'path')
  const draftId = text(searchParams?.get?.('draftId') || searchParams?.draftId)
  if (draftId) {
    const draft = await readDraft(productRoot, draftId)
    return {
      draftId,
      path: normalizeRelative(relative),
      content: await draftContent(productRoot, draft, relative),
      commitReceipt: draft.commitReceipt || null,
      mergeReceipt: draft.mergeReceipt || mergeReceiptFromCommitReceipt(draft.commitReceipt)
    }
  }
  const planId = requiredText(searchParams?.get?.('planId') || searchParams?.planId, 'planId')
  const plan = state.plans[planId]
  if (!plan?.currentVersion) throw notFound(`library not found: ${planId}`)
  const versionId = text(searchParams?.get?.('versionId') || searchParams?.get?.('version') || searchParams?.versionId || searchParams?.version, plan.currentVersion)
  const current = await versionManifest(productRoot, planId, versionId)
  const logicalPath = canonicalVersionPath(relative)
  const record = (current.files || []).find((item) => item.path === logicalPath)
  if (!record) throw notFound(`file not found: ${logicalPath}`)
  const commitReceipt = await readCommitReceiptForVersion(productRoot, planId, versionId)
  return {
    planId,
    versionId,
    path: logicalPath,
    content: await versionRecordContent(productRoot, planId, versionId, record),
    commitReceipt,
    mergeReceipt: await resolveMergeReceipt(productRoot, state, { planId, versionId })
  }
}

function includesQuery(values, query) {
  const haystack = values.filter(Boolean).join(' ').toLocaleLowerCase('zh-CN')
  return !query || haystack.includes(query.toLocaleLowerCase('zh-CN'))
}

async function searchProduct(productRoot, state, searchParams) {
  const query = text(searchParams?.get?.('q') || searchParams?.q).trim()
  const results = []
  for (const plan of Object.values(state.plans)) {
    if (includesQuery([plan.name, plan.planId, plan.sourceWorkspace], query)) {
      results.push({ type: 'project', id: plan.planId, planId: plan.planId, title: plan.name, detail: plan.sourceWorkspace || '项目方案' })
    }
    for (const system of plan.sourceSystems || []) {
      if (includesQuery([system.name, system.id, system.kind, system.sourcePath], query)) {
        results.push({ type: 'system', id: `${plan.planId}:${system.id}`, planId: plan.planId, title: system.name, detail: system.sourcePath || system.kind, systemId: system.id })
      }
      for (const source of Array.isArray(system.sources) ? system.sources : []) {
        if (!includesQuery([system.name, source.kind, source.path], query)) continue
        results.push({ type: 'source', id: `${plan.planId}:${system.id}:${source.path}`, planId: plan.planId, title: source.path, detail: `${system.name} · ${source.kind}`, systemId: system.id, path: source.path })
      }
    }
    if (!plan.currentVersion) continue
    const current = await versionManifest(productRoot, plan.planId, plan.currentVersion).catch(() => null)
    for (const file of current?.files || []) {
      if (!includesQuery([plan.name, file.path, file.logicalPath, file.sourcePath], query)) continue
      results.push({ type: /^rules\//iu.test(file.path) || /(?:AGENTS|CLAUDE)\.md$/iu.test(file.path) ? 'rule' : 'file', id: `${plan.planId}:${file.path}`, planId: plan.planId, title: file.path, detail: /^rules\//iu.test(file.path) ? '项目规则' : 'Skill 文件', path: file.path })
    }
  }
  for (const workspace of Object.values(state.workspaces)) {
    if (includesQuery([workspace.workspaceName, workspace.workspacePath, workspace.planId], query)) {
      results.push({ type: 'workspace', id: workspace.workspaceId, planId: workspace.planId || null, title: workspace.workspaceName, detail: workspace.workspacePath, path: workspace.workspacePath })
    }
  }
  const seen = new Set()
  return { query, results: results.filter((result) => !seen.has(result.id) && seen.add(result.id)).slice(0, 100) }
}

async function readLibrarySource(productRoot, state, searchParams) {
  const readParam = (name) => searchParams?.get?.(name) || searchParams?.[name] || ''
  const planId = requiredText(readParam('planId') || state.activePlanId, 'planId')
  const plan = state.plans[planId]
  if (!plan) throw notFound(`library not found: ${planId}`)
  const systemId = text(readParam('systemId'))
  const requestedPath = text(readParam('path'))
  const requestedFilePath = text(readParam('filePath'))
  const current = plan.currentVersion ? await versionManifest(productRoot, planId, plan.currentVersion).catch(() => null) : null
  const systems = current ? authoritativeLibrarySystems(plan, current) : []
  const system = systems.find((item) => !systemId || item.id === systemId)
  if (!system) throw notFound('library source system not found')
  const sources = Array.isArray(system.sources) ? system.sources : []
  const sourceAnalysisId = current?.sourceAnalysisId || plan.sourceAnalysisId || null
  const sourceRecords = [
    ...(Array.isArray(system.files) ? system.files : []),
    ...(current?.files || []).filter((file) => (
      (file.sourceSystemIds || []).includes(system.id)
      || (file.origins || []).some((origin) => origin?.systemId === system.id)
    ))
  ]
  const sourceFiles = []
  const seen = new Set()
  for (const record of sourceRecords) {
    const logicalPath = canonicalVersionPath(record?.logicalPath || record?.path)
    if (!logicalPath || seen.has(logicalPath)) continue
    seen.add(logicalPath)
    const origin = Array.isArray(record.origins) ? record.origins.find((item) => item?.systemId === system.id) || record.origins[0] : null
    const originPath = origin?.physicalPath || record.physicalPath || record.sourcePath || record.path
    sourceFiles.push({
      path: logicalPath,
      filePath: originPath,
      originPath,
      sourcePath: origin?.sourcePath || record.sourcePath || null,
      analysisId: origin?.analysisId || sourceAnalysisId,
      contentAvailable: Boolean(record.stored !== false && (origin?.analysisId || sourceAnalysisId || current)),
      readOnly: true,
      origin: {
        path: originPath,
        sourcePath: origin?.sourcePath || record.sourcePath || null,
        analysisId: origin?.analysisId || sourceAnalysisId
      }
    })
  }
  const defaultSource = sources[0] || { kind: '中心库来源快照', path: system.sourcePath || '.' }
  const source = sources.find((item) => !requestedPath || item.path === requestedPath) || defaultSource
  const filePath = requestedFilePath || (sourceFiles.some((file) => file.path === canonicalVersionPath(requestedPath)) ? requestedPath : '')
  let file = null
  if (filePath) {
    const normalized = canonicalVersionPath(filePath)
    if (!normalized) throw bad('source file path is unsafe', 'PRODUCT_PATH_ESCAPE')
    const descriptor = sourceFiles.find((item) => item.path === normalized || item.originPath === filePath)
    if (!descriptor) throw notFound(`library source file not found: ${normalized}`)
    const rawRecord = sourceRecords.find((record) => canonicalVersionPath(record?.logicalPath || record?.path) === descriptor.path)
    let content = ''
    if (descriptor.analysisId && rawRecord) {
      content = await analysisFileContent(productRoot, descriptor.analysisId, descriptor.path, rawRecord.physicalPath || rawRecord.path)
    }
    if (content === '' && current) {
      const currentRecord = current.files.find((record) => record.path === descriptor.path)
      if (currentRecord) content = await versionRecordContent(productRoot, planId, current.versionId, currentRecord)
    }
    file = { ...descriptor, content, contentLoaded: true }
  }
  const commitReceipt = await resolveCommitReceipt(productRoot, state, {
    planId,
    versionId: current?.versionId || plan.currentVersion || ''
  })
  return {
    planId,
    system: { id: system.id, name: system.name, kind: system.kind },
    source,
    sources,
    files: sourceFiles,
    file,
    readOnly: true,
    commitReceipt,
    mergeReceipt: await resolveMergeReceipt(productRoot, state, {
      planId,
      versionId: current?.versionId || plan.currentVersion || ''
    })
  }
}

function commandMeta(host, kind) {
  if (typeof host?.commandMeta === 'function') return host.commandMeta('product-service')
  return { contractVersion: 1, requestId: randomId(`product-${kind}`), hostId: 'product-service', transport: 'product-service' }
}

async function executeCommand(executeTyped, host, kind, input) {
  if (typeof executeTyped !== 'function') throw serviceError(503, 'PRODUCT_APPLICATION_UNAVAILABLE', 'Application command bridge is unavailable')
  const result = await executeTyped({ kind, ...input, meta: commandMeta(host, kind) })
  if (result && result.ok === false) throw serviceError(409, result.error?.code || 'PRODUCT_APPLICATION_ERROR', result.error?.message || `${kind} failed`, result.error)
  return result?.data ?? result
}

async function lastAssistantMessage(host, session) {
  const direct = text(session?.lastMessage)
  if (direct) return contentPreview(direct).value
  const id = text(session?.id)
  const legacy = host?.localSessions?.getLegacy?.(id)
  const file = text(legacy?.lastFile)
  if (!file) return ''
  const dataRoot = text(host?.dataRoot)
  if (!dataRoot) return ''
  const root = path.resolve(dataRoot)
  if (!inside(root, file)) return ''
  const stat = await lstatOrNull(file)
  if (!stat?.isFile() || stat.size > MAX_CHAT_BYTES) return ''
  return readFileOrEmpty(file)
}

async function cancelSessionForRecord(executeTyped, host, record) {
  if (!record?.sessionId) return null
  if (record.cancelCommandStarted) return record.cancelResult || null
  record.cancelCommandStarted = true
  const result = await executeCommand(executeTyped, host, 'cancelSession', { sessionId: record.sessionId })
  record.cancelResult = result
  return result
}

function chatLibrarySourceSummary(system) {
  const source = system && typeof system === 'object' ? system : {}
  const sources = Array.isArray(source.sources) ? source.sources : []
  const sourceDetails = sources
    .map((item) => {
      const row = item && typeof item === 'object' ? item : {}
      const label = text(row.kind || row.host || row.projection, '来源')
      const sourcePath = text(row.path || row.sourcePath || row.canonicalTarget)
      return sourcePath ? `${label}: ${sourcePath}` : ''
    })
    .filter(Boolean)
    .slice(0, MAX_CHAT_LIBRARY_SOURCES_PER_SYSTEM)
  const sourcePath = text(source.sourcePath)
  return {
    name: text(source.name || source.id, '未命名体系'),
    kind: text(source.kind, '项目体系'),
    sourcePath,
    sources: sourceDetails,
  }
}

async function currentCenterLibraryChatContext(productRoot, state) {
  const planId = text(state?.activePlanId).trim()
  const plan = planId ? state?.plans?.[planId] : null
  if (!plan?.currentVersion) {
    return '中心库尚未初始化：当前没有 active plan/current version。'
  }

  // Read the manifest on every new ordinary chat request. Do not derive these
  // facts from browser context or cache counts from an older version.
  const current = await versionManifest(productRoot, plan.planId || planId, plan.currentVersion)
  const files = Array.isArray(current.files) ? current.files : []
  const paths = [...new Set(files
    .map((file) => canonicalVersionPath(file?.logicalPath || file?.path))
    .filter(Boolean))]
  const shownPaths = paths.slice(0, MAX_CHAT_LIBRARY_PATHS)
  const sourceSystems = (Array.isArray(current.sourceSystems) && current.sourceSystems.length
    ? current.sourceSystems
    : Array.isArray(plan.sourceSystems) ? plan.sourceSystems : [])
    .slice(0, MAX_CHAT_LIBRARY_SYSTEMS)
    .map(chatLibrarySourceSummary)
  const omittedPaths = Math.max(0, paths.length - shownPaths.length)
  const sourceLines = sourceSystems.length
    ? sourceSystems.map((system) => {
      const location = [system.sourcePath, ...system.sources].filter(Boolean).join('；') || '来源路径未提供'
      return `- ${system.name}（${system.kind}）；来源：${location}`
    })
    : ['- 当前版本未记录已选择体系来源。']

  return [
    '中心库权威只读上下文（由服务端从当前 active plan 和当前版本 manifest 实时生成）：',
    `- 方案：${text(plan.name, plan.planId || planId)}`,
    `- 当前版本：${plan.currentVersion}`,
    `- 当前内容计数：${files.length} 个文件，${files.filter((file) => /(?:^|\/)SKILL\.md$/iu.test(file.path)).length} 个 Skill，${files.filter((file) => /^rules\//iu.test(file.path)).length} 条 Rule。`,
    '- 已选择体系与来源：',
    ...sourceLines,
    `- 当前版本逻辑路径（共 ${paths.length} 条，以下列出 ${shownPaths.length} 条${omittedPaths ? `，另有 ${omittedPaths} 条省略` : ''}）：`,
    ...(shownPaths.length ? shownPaths.map((item) => `  - ${item}`) : ['  - 当前版本没有可列出的逻辑路径。']),
    '- 以上版本、计数、体系和逻辑路径是回答中心库问题的权威事实；当前中心库非空时不得声称为空。',
    '- 普通对话仅可读取和解释这些中心库 manifest/plan 元数据；不得创建、写入或修改中心库，也不得读取未被中心库选择的工作区私有 Skill。任何修改必须先形成产品草稿，再由用户预览、审阅和确认。',
  ].join('\n')
}

async function ordinaryChatIntent(productRoot, state, message) {
  const context = await currentCenterLibraryChatContext(productRoot, state)
  return [
    '你是 Skill Graft 的普通 AI 助手。请先依据下面的权威只读上下文回答用户问题。',
    context,
    `用户问题：${message}`,
  ].join('\n')
}

async function narrowDraftToSelectedFiles(productRoot, draft, selectedFiles) {
  const selected = new Set(selectedFiles)
  // The AI request is a scope change for the draft itself.  Keeping an
  // unselected manifest entry around would let it leak back into review or a
  // later commit even though the provider only received the selected copy.
  draft.files = draft.files.filter((file) => selected.has(file.path))
  draft.editablePaths = [...selected]
  await saveDraft(productRoot, draft)
  return draft
}

async function startChat(productRoot, state, executeTyped, host, body, draft) {
  const message = requiredText(body?.message || body?.intent, 'message')
  const requestId = text(body?.requestId || body?.clientRequestId).trim() || randomId('ai-request')
  const requestRecord = state.aiRequests[requestId] || {
    requestId,
    cancelRequested: false,
    createdAt: nowIso()
  }
  Object.assign(requestRecord, {
    requestId,
    draftId: draft?.draftId || null,
    userMessage: message,
    status: 'starting'
  })
  state.aiRequests[requestId] = requestRecord
  if (draft && !Array.isArray(body?.selectedFiles)) throw bad('selectedFiles must be an array')
  const normalizedSelectedFiles = draft ? body.selectedFiles.map((file) => normalizeRelative(file)) : []
  if (draft && normalizedSelectedFiles.some((file) => !file)) throw bad('AI selection contains an unsafe path', 'PRODUCT_PATH_ESCAPE')
  const selectedFiles = draft ? [...new Set(normalizedSelectedFiles)] : []
  if (draft && selectedFiles.length === 0) throw bad('select at least one draft file for AI')
  if (draft) {
    const known = new Set(draft.files.map((file) => file.path))
    const declaredEditable = new Set(Array.isArray(draft.editablePaths)
      ? draft.editablePaths
      : draft.files.filter((file) => file.editable !== false).map((file) => file.path))
    if (selectedFiles.some((file) => !known.has(file))) throw conflict('AI 只能处理当前草稿中的可编辑文件', 'PRODUCT_FILE_NOT_EDITABLE')
    if (selectedFiles.some((file) => {
      const record = draft.files.find((item) => item.path === file)
      return !declaredEditable.has(file) || record?.editable === false
    })) {
      throw conflict('AI 只能处理被选为可编辑的文件', 'PRODUCT_FILE_NOT_EDITABLE')
    }
    await narrowDraftToSelectedFiles(productRoot, draft, selectedFiles)
  }
  let aiScopeId = null
  let aiScopeRoot = null
  if (draft) {
    aiScopeId = randomId('ai-scope')
    aiScopeRoot = productPath(productRoot, 'ai-scopes', aiScopeId)
    for (const relative of selectedFiles) {
      const content = await draftContent(productRoot, draft, relative)
      await atomicBytes(productPath(aiScopeRoot, ...relative.split('/')), Buffer.from(content, 'utf8'), aiScopeRoot)
    }
  }
  const intent = draft
    ? `当前目录只包含用户勾选的草稿副本。请直接编辑这些相对路径：${selectedFiles.join(', ')}。用户要求：${message}。不要创建新文件，不要访问或修改当前目录以外的任何内容。完成后用正常语言简要说明处理结果。`
    : await ordinaryChatIntent(productRoot, state, message)
  let sessionData
  try {
    sessionData = await executeCommand(executeTyped, host, 'chat', {
      intent,
      ...(aiScopeRoot ? { worktree: aiScopeRoot } : {}),
      runner: { start: true }
    })
  } catch (error) {
    requestRecord.status = 'failed'
    requestRecord.error = error?.message || String(error)
    throw error
  }
  const session = sessionData?.session || sessionData
  if (!session?.id) {
    requestRecord.status = 'failed'
    throw serviceError(502, 'PRODUCT_SESSION_INVALID', 'chat session response is missing an id')
  }
  requestRecord.sessionId = session.id
  requestRecord.status = 'session-ready'
  const chatRecord = {
    sessionId: session.id,
    requestId,
    draftId: draft?.draftId || null,
    selectedFiles,
    aiScopeId,
    userMessage: message,
    createdAt: nowIso()
  }
  state.chats[session.id] = chatRecord
  if (requestRecord.cancelRequested) {
    requestRecord.status = 'cancelling'
    try {
      const cancelled = await cancelSessionForRecord(executeTyped, host, requestRecord)
      requestRecord.status = 'cancelled'
      chatRecord.cancelledAt = nowIso()
      chatRecord.cancelRequested = true
      const cancelledSession = cancelled?.session || cancelled || { ...session, status: 'cancelled' }
      return { session: cancelledSession, chatId: session.id, draftId: draft?.draftId || null, requestId, cancelled: true }
    } catch (error) {
      // Keep the cancellation marker even if the underlying bridge is
      // temporarily unavailable. Status polling will never import a result
      // from a request that the user already cancelled.
      requestRecord.status = 'cancel-requested'
      chatRecord.cancelRequested = true
      throw error
    }
  }
  return { session, chatId: session.id, draftId: draft?.draftId || null, requestId, cancelled: false }
}

async function synchronizeAiDraft(productRoot, state, session, record) {
  const requestRecord = record?.requestId ? state.aiRequests?.[record.requestId] : null
  if (!record?.draftId || !record.aiScopeId || record.importedAt || record.cancelRequested || requestRecord?.cancelRequested || session?.status !== 'completed') return false
  const draft = await readDraft(productRoot, record.draftId)
  await assertDraftCenterContentAvailable(productRoot, state, draft)
  const rawSelectedFiles = Array.isArray(record.selectedFiles) ? record.selectedFiles : []
  const normalizedSelectedFiles = rawSelectedFiles.map((relative) => normalizeRelative(relative))
  if (normalizedSelectedFiles.some((relative) => !relative)) throw conflict('AI 选择的文件路径不安全', 'PRODUCT_PATH_ESCAPE')
  const selectedFiles = [...new Set(normalizedSelectedFiles)]
  if (!selectedFiles.length) throw conflict('AI 只能同步用户勾选的草稿文件', 'PRODUCT_FILE_NOT_EDITABLE')
  const declaredEditable = new Set(Array.isArray(draft.editablePaths)
    ? draft.editablePaths
    : draft.files.filter((file) => file.editable !== false).map((file) => file.path))
  if (selectedFiles.some((relative) => {
    const file = draft.files.find((item) => item.path === relative)
    return !declaredEditable.has(relative) || !file || file.editable === false
  })) {
    throw conflict('AI 选择的文件已不在当前草稿可编辑范围内', 'PRODUCT_FILE_NOT_EDITABLE')
  }
  record.selectedFiles = selectedFiles
  await narrowDraftToSelectedFiles(productRoot, draft, selectedFiles)
  const scopeRoot = productPath(productRoot, 'ai-scopes', record.aiScopeId)
  for (const relative of selectedFiles) {
    const normalized = normalizeRelative(relative)
    const file = draft.files.find((item) => item.path === normalized && item.editable !== false)
    if (!normalized || !file) continue
    // A deletion is already a complete, structured proposal.  AI is allowed
    // to help with explanatory text, but it must not be the only path to a
    // deletion and it is not required to return an empty file body.
    if (file.deleted) {
      file.aiSkipped = true
      file.aiReviewNote = 'AI 未返回正文；保留删除标记，转入人工确认'
      continue
    }
    const source = productPath(scopeRoot, ...normalized.split('/'))
    const stat = await lstatOrNull(source)
    if (!stat?.isFile() || stat.size > MAX_ANALYSIS_FILE_BYTES) {
      throw conflict(`AI 没有返回可导入的文件: ${normalized}`, 'PRODUCT_AI_FILE_MISSING')
    }
    const content = await readFileOrEmpty(source)
    await atomicBytes(productPath(productRoot, 'drafts', draft.draftId, 'files', ...normalized.split('/')), Buffer.from(content, 'utf8'), productPath(productRoot, 'drafts', draft.draftId))
    file.contentHash = contentHash(content)
    file.size = Buffer.byteLength(content, 'utf8')
    file.confirmed = false
  }
  await saveDraft(productRoot, draft)
  record.importedAt = nowIso()
  return true
}

async function chatStatus(productRoot, state, executeTyped, host, sessionId) {
  const id = requiredText(sessionId, 'sessionId')
  const data = await executeCommand(executeTyped, host, 'getSession', { sessionId: id })
  const session = data?.session || data
  if (!session?.id) throw notFound(`chat session not found: ${id}`)
  const record = state.chats[id] || null
  const cancelled = Boolean(record?.cancelRequested || (record?.requestId && state.aiRequests?.[record.requestId]?.cancelRequested))
  // Cancellation is a durable client decision, not merely a provider hint.
  // A provider may finish (or expose a late assistant message) after the
  // cancel request, but that response must never become visible or importable
  // through the product contract.
  const synchronizedDraft = cancelled ? false : await synchronizeAiDraft(productRoot, state, session, record)
  return {
    session: {
      id: session.id,
      kind: session.kind,
      status: cancelled ? 'cancelled' : session.status,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      canResume: session.canResume,
      canCancel: cancelled ? false : session.capabilities?.canCancel || false,
      error: session.error || ''
    },
    userMessage: record?.userMessage || '',
    assistantMessage: cancelled ? '' : await lastAssistantMessage(host, session),
    draftId: record?.draftId || null,
    selectedFiles: record?.selectedFiles || [],
    cancelled,
    synchronizedDraft
  }
}

async function buildTakeoverPreview(productRoot, state, body) {
  const planId = requiredText(body?.planId, 'planId')
  const plan = state.plans[planId]
  if (!plan?.currentVersion) throw notFound(`library not found: ${planId}`)
  const versionId = text(body?.versionId, plan.currentVersion)
  const manifest = await versionManifest(productRoot, planId, versionId)
  const worktreePath = requiredText(body?.worktreePath, 'worktreePath')
  const rootStat = await lstatOrNull(worktreePath)
  if (!rootStat?.isDirectory()) throw bad('worktreePath must be an existing directory', 'PRODUCT_WORKSPACE_INVALID')
  const canonicalRoot = await fsp.realpath(worktreePath).catch(() => path.resolve(worktreePath))
  const dirtyPaths = await gitDirtyPaths(canonicalRoot)
  const sourceSystems = Array.isArray(manifest.sourceSystems) ? manifest.sourceSystems : []
  const workspace = state.workspaces[workspaceKey(canonicalRoot)]
  const requestedSystemIds = Array.isArray(body?.selectedSystemIds)
    ? [...new Set(body.selectedSystemIds.map((value) => text(value).trim()).filter(Boolean))]
    : []
  const persistedSystemIds = workspace?.planId === planId && Array.isArray(workspace.selectedSystemIds)
    ? [...new Set(workspace.selectedSystemIds.filter(Boolean))]
    : []
  const selectedSystemIds = persistedSystemIds.length
    ? persistedSystemIds
    : requestedSystemIds.length
      ? requestedSystemIds
    : sourceSystems.map((system) => system.id).filter(Boolean)
  const selectedSystemRefs = sourceSystems.filter((system) => selectedSystemIds.includes(system.id)).map(systemSelectionRef)
  const operations = []
  let selectedProjection = text(body?.targetProjection).trim().replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '')
  const scopedRecords = manifest.files.filter((record) => {
    if (record.managed === false) return false
    if (!selectedSystemIds.length || !Array.isArray(record.sourceSystemIds) || !record.sourceSystemIds.length) return true
    return record.sourceSystemIds.some((id) => selectedSystemIds.includes(id))
  })
  for (const record of scopedRecords) {
    const relative = normalizeRelative(record.path)
    if (!relative) continue
    const targetInfo = await logicalTargetPath(canonicalRoot, relative, body?.targetProjection)
    if (!selectedProjection && targetInfo.projection) selectedProjection = targetInfo.projection
    if (!targetInfo.available) {
      operations.push({
        path: relative,
        targetPath: targetInfo.targetPath || null,
        projection: targetInfo.projection,
        canonicalTarget: targetInfo.canonicalTarget || null,
        linkBoundaries: targetInfo.linkBoundaries || [],
        action: 'unavailable',
        available: false,
        unavailableReason: targetInfo.unavailableReason,
        dirty: false,
        beforeExists: false,
        beforeHash: null,
        afterHash: record.contentHash,
        size: record.size,
        managed: true
      })
      continue
    }
    const targetRelative = targetInfo.targetPath
    const target = workspacePath(canonicalRoot, targetRelative)
    const targetAvailability = await takeoverTargetAvailability(canonicalRoot, targetRelative)
    if (!targetAvailability.available) {
      operations.push({
        path: relative,
        targetPath: targetRelative,
        projection: targetInfo.projection,
        canonicalTarget: targetInfo.canonicalTarget || null,
        linkBoundaries: targetInfo.linkBoundaries || [],
        action: 'unavailable',
        available: false,
        unavailableReason: targetAvailability.unavailableReason,
        dirty: false,
        beforeExists: false,
        beforeHash: null,
        afterHash: record.contentHash,
        size: record.size,
        managed: true
      })
      continue
    }
    const current = await readSmallFile(target)
    const action = !current.exists ? 'create' : current.hash === record.contentHash ? 'keep' : 'update'
    operations.push({ path: relative, targetPath: targetRelative, projection: targetInfo.projection, canonicalTarget: targetInfo.canonicalTarget || null, linkBoundaries: targetInfo.linkBoundaries || [], action, available: true, dirty: dirtyPaths.has(targetRelative), beforeExists: current.exists, beforeHash: current.hash, afterHash: record.contentHash, size: record.size, managed: true })
  }
  if (!selectedProjection) selectedProjection = operations.find((operation) => operation.projection)?.projection || ''
  const targetOptions = await targetProjectionOptions(canonicalRoot, { ...manifest, files: scopedRecords })
  for (const option of targetOptions) option.selected = option.value === selectedProjection
  const selectedTarget = targetOptions.find((option) => option.value === selectedProjection) || null
  const selectedOperation = operations.find((operation) => operation.projection === selectedProjection && operation.available !== false)
  const selectedCanonicalTarget = selectedTarget?.canonicalTarget || selectedOperation?.canonicalTarget || canonicalRoot
  const linkBoundaries = []
  const seenLinkBoundaries = new Set()
  for (const boundary of operations.flatMap((operation) => operation.linkBoundaries || [])) {
    const key = stablePathKey(boundary.path)
    if (!key || seenLinkBoundaries.has(key)) continue
    seenLinkBoundaries.add(key)
    linkBoundaries.push(boundary)
  }
  const canonicalStatus = await canonicalTargetStatus(canonicalRoot, selectedCanonicalTarget)
  if (!canonicalStatus.valid) {
    throw conflict('当前投影缺少工作区内的规范目录根，已停止接管', 'PRODUCT_TAKEOVER_UNSUPPORTED', {
      canonicalTarget: selectedCanonicalTarget,
      reason: canonicalStatus.reason
    })
  }
  const requestedCanonicalTarget = text(body?.canonicalTarget || body?.targetCanonicalTarget).trim()
  if (requestedCanonicalTarget) {
    const requestedCanonicalStatus = await canonicalTargetStatus(canonicalRoot, requestedCanonicalTarget)
    if (!requestedCanonicalStatus.valid) {
      throw conflict('规范接管目标必须是工作区内目录根，不能是内容文件', 'PRODUCT_TAKEOVER_UNSUPPORTED', {
        canonicalTarget: requestedCanonicalTarget,
        reason: requestedCanonicalStatus.reason
      })
    }
  }
  if (requestedCanonicalTarget && requestedCanonicalTarget !== text(selectedCanonicalTarget)) {
    throw conflict('接管目标已经变化，请重新生成规范目标预览', 'PRODUCT_PLAN_STALE', {
      targetProjection: selectedProjection,
      canonicalTarget: selectedCanonicalTarget
    })
  }
  const changed = operations.filter((operation) => operation.action !== 'keep' && operation.available !== false)
  const unavailable = operations.filter((operation) => operation.available === false)
  const preview = {
    schemaVersion: SCHEMA_VERSION,
    previewId: randomId('takeover-preview'),
    planId,
    versionId,
    worktreePath: canonicalRoot,
    targetProjection: selectedProjection,
    canonicalTarget: selectedCanonicalTarget,
    canonicalTargetDirectory: selectedCanonicalTarget,
    linkBoundaries,
    targetPath: selectedTarget?.targetPath || null,
    targetOptions,
    selectedSystemIds,
    selectedSystemRefs,
    createdAt: nowIso(),
    planHash: takeoverPlanHash({
      planId,
      versionId,
      worktreePath: canonicalRoot,
      targetProjection: selectedProjection,
      canonicalTarget: selectedCanonicalTarget,
      selectedSystemIds,
      operations
    }),
    operations,
    summary: { changed: changed.length, create: changed.filter((item) => item.action === 'create').length, update: changed.filter((item) => item.action === 'update').length, keep: operations.filter((item) => item.action === 'keep').length, unavailable: unavailable.length },
    available: unavailable.length === 0,
    unavailable: unavailable.map((operation) => ({ path: operation.path, targetPath: operation.targetPath, reason: operation.unavailableReason })),
    requiresExplicit: operations.some((operation) => operation.dirty),
    dirtyFiles: operations.filter((operation) => operation.dirty).map((operation) => operation.path),
    preserve: ['未知文件不动', '项目私有 Skill 不动', '未列入中心库版本的文件不动']
  }
  await atomicJson(productPath(productRoot, 'takeovers', preview.previewId, 'preview.json'), preview, productRoot)
  state.takeovers[preview.previewId] = { previewId: preview.previewId, planId, versionId, worktreePath: canonicalRoot, createdAt: preview.createdAt, planHash: preview.planHash, targetProjection: selectedProjection, canonicalTarget: selectedCanonicalTarget, canonicalTargetDirectory: selectedCanonicalTarget, selectedSystemIds, selectedSystemRefs }
  return preview
}

async function readTakeoverPreview(productRoot, previewId) {
  const value = await readJson(productPath(productRoot, 'takeovers', requiredText(previewId, 'previewId'), 'preview.json'), null)
  if (!value) throw notFound(`takeover preview not found: ${previewId}`)
  return value
}

function cloneWorkspaceSnapshot(workspace) {
  return workspace ? JSON.parse(JSON.stringify(workspace)) : null
}

async function captureLinkTopology(root, boundaries) {
  const rootResolved = path.resolve(root)
  const topology = []
  const seen = new Set()
  for (const boundary of Array.isArray(boundaries) ? boundaries : []) {
    const relative = normalizeRelative(boundary?.path)
    if (!relative || seen.has(stablePathKey(relative))) continue
    seen.add(stablePathKey(relative))
    const absolute = path.resolve(rootResolved, ...relative.split('/'))
    if (!inside(rootResolved, absolute)) throw bad('takeover link boundary escapes the selected worktree', 'PRODUCT_PATH_ESCAPE')
    const stat = await lstatOrNull(absolute)
    if (!stat?.isSymbolicLink()) {
      throw conflict(`接管别名拓扑已经变化: ${relative}`, 'PRODUCT_TAKEOVER_TOPOLOGY_CONFLICT', { path: relative })
    }
    const target = await fsp.readlink(absolute)
    const canonicalTarget = await fsp.realpath(absolute).catch(() => '')
    if (!canonicalTarget || !inside(rootResolved, canonicalTarget)) {
      throw conflict(`接管别名不再指向工作区内部: ${relative}`, 'PRODUCT_TAKEOVER_TOPOLOGY_CONFLICT', { path: relative })
    }
    const targetStat = await lstatOrNull(canonicalTarget)
    topology.push({
      path: relative,
      type: targetStat?.isDirectory() ? 'junction' : 'symlink',
      target,
      canonicalTarget
    })
  }
  return topology
}

async function captureDirectoryTopology(root, operations) {
  const rootResolved = path.resolve(root)
  const topology = {}
  for (const operation of Array.isArray(operations) ? operations : []) {
    const relative = normalizeRelative(operation?.targetPath || operation?.path)
    if (!relative) continue
    const parts = relative.split('/')
    for (let length = 1; length < parts.length; length += 1) {
      const directoryRelative = parts.slice(0, length).join('/')
      if (Object.prototype.hasOwnProperty.call(topology, directoryRelative)) continue
      const absolute = path.resolve(rootResolved, ...parts.slice(0, length))
      if (!inside(rootResolved, absolute)) throw bad('takeover directory boundary escapes the selected worktree', 'PRODUCT_PATH_ESCAPE')
      const stat = await lstatOrNull(absolute)
      if (stat && !stat.isDirectory() && !stat.isSymbolicLink()) {
        throw conflict(`接管父路径不是目录: ${directoryRelative}`, 'PRODUCT_TAKEOVER_UNSUPPORTED', { path: directoryRelative })
      }
      topology[directoryRelative] = Boolean(stat)
    }
  }
  return topology
}

async function ensureTakeoverParentDirectories(root, targetRelative, protection) {
  const normalized = normalizeRelative(targetRelative)
  if (!normalized) throw bad('takeover target path is unsafe', 'PRODUCT_PATH_ESCAPE')
  const parts = normalized.split('/')
  const created = Array.isArray(protection.createdDirectories) ? protection.createdDirectories : (protection.createdDirectories = [])
  const known = new Set(created.map(stablePathKey))
  for (let length = 1; length < parts.length; length += 1) {
    const relative = parts.slice(0, length).join('/')
    const absolute = workspacePath(root, relative)
    let stat = await lstatOrNull(absolute)
    if (!stat) {
      await fsp.mkdir(absolute)
      stat = await lstatOrNull(absolute)
      if (!stat?.isDirectory() || stat.isSymbolicLink()) {
        throw conflict(`接管父路径创建后不是普通目录: ${relative}`, 'PRODUCT_TAKEOVER_TOPOLOGY_CONFLICT', { path: relative })
      }
      if (!known.has(stablePathKey(relative))) {
        created.push(relative)
        known.add(stablePathKey(relative))
      }
      continue
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw conflict(`接管父路径不是普通目录: ${relative}`, 'PRODUCT_TAKEOVER_TOPOLOGY_CONFLICT', { path: relative })
    }
  }
  return created
}

async function assertLinkTopology(root, topology, code = 'PRODUCT_ROLLBACK_TOPOLOGY_CONFLICT') {
  if (!Array.isArray(topology) || !topology.length) return true
  const rootResolved = path.resolve(root)
  for (const entry of topology) {
    const relative = normalizeRelative(entry?.path)
    const absolute = relative ? path.resolve(rootResolved, ...relative.split('/')) : ''
    if (!relative || !inside(rootResolved, absolute)) throw conflict('保护快照中的别名路径无效，已停止写入', code)
    const stat = await lstatOrNull(absolute)
    if (!stat?.isSymbolicLink()) {
      throw conflict(`别名拓扑已变化，未递归覆盖目录: ${relative}`, code, { path: relative, expectedType: entry.type })
    }
    const target = await fsp.readlink(absolute).catch(() => '')
    const canonicalTarget = await fsp.realpath(absolute).catch(() => '')
    if (target !== entry.target || portableKey(canonicalTarget) !== portableKey(entry.canonicalTarget)) {
      throw conflict(`别名目标已变化，已停止写入: ${relative}`, code, {
        path: relative,
        expectedTarget: entry.target,
        actualTarget: target || null
      })
    }
  }
  return true
}

async function cleanupOwnedAnalysis(productRoot, analysisId) {
  if (!/^analysis-[a-z0-9-]+$/iu.test(String(analysisId || ''))) return false
  const analysisRoot = productPath(productRoot, 'analyses')
  const target = productPath(analysisRoot, analysisId)
  if (!inside(analysisRoot, target)) return false
  await fsp.rm(target, { recursive: true, force: true })
  return true
}

function restoreTakeoverWorkspaceState(state, protection) {
  const key = workspaceKey(protection.worktreePath)
  const snapshot = protection.workspaceSnapshot
  if (snapshot && snapshot.existed === true && snapshot.workspace) {
    state.workspaces[key] = cloneWorkspaceSnapshot(snapshot.workspace)
    return state.workspaces[key]
  }
  if (snapshot && snapshot.existed === false) {
    delete state.workspaces[key]
    return null
  }

  // Protection records written before the workspace snapshot was introduced
  // cannot prove the old connection metadata. Keep the selected scope and
  // baseline for a safe, explicit no-op completion instead of pretending that
  // the workspace is a fresh connection or discarding its safety boundary.
  const current = state.workspaces[key]
  if (!current) return null
  current.connectionRecoveryRequired = true
  current.status = 'needs-connection'
  current.connectionMode = null
  current.protectionId = null
  current.hasUpdates = false
  current.pendingAnalysisId = null
  current.pendingComparisonId = null
  current.pendingSummary = null
  return current
}

async function applyTakeover(productRoot, state, body) {
  const preview = await readTakeoverPreview(productRoot, body?.previewId)
  if (preview.available === false || preview.unavailable?.length || preview.operations?.some((operation) => operation.available === false)) {
    throw conflict('当前投影无法安全接管，请先选择工作区内部的规范目标', 'PRODUCT_TAKEOVER_UNSUPPORTED', { unavailable: preview.unavailable || [] })
  }
  const previewCanonicalStatus = await canonicalTargetStatus(preview.worktreePath, preview.canonicalTarget)
  if (!previewCanonicalStatus.valid) {
    throw conflict('当前接管预览的规范目标不是工作区内目录根，已停止接管', 'PRODUCT_TAKEOVER_UNSUPPORTED', {
      canonicalTarget: preview.canonicalTarget || null,
      reason: previewCanonicalStatus.reason
    })
  }
  if (body?.planHash && body.planHash !== preview.planHash) throw conflict('takeover preview is stale', 'PRODUCT_PLAN_STALE')
  const requestedProjection = text(body?.targetProjection).trim().replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '')
  if (requestedProjection && requestedProjection !== text(preview.targetProjection)) {
    throw conflict('接管目标已经变化，请重新生成预览', 'PRODUCT_PLAN_STALE')
  }
  const requestedCanonicalTarget = text(body?.canonicalTarget || body?.targetCanonicalTarget).trim()
  if (requestedCanonicalTarget) {
    const requestedCanonicalStatus = await canonicalTargetStatus(preview.worktreePath, requestedCanonicalTarget)
    if (!requestedCanonicalStatus.valid) {
      throw conflict('规范接管目标必须是工作区内目录根，不能是内容文件', 'PRODUCT_TAKEOVER_UNSUPPORTED', {
        canonicalTarget: requestedCanonicalTarget,
        reason: requestedCanonicalStatus.reason
      })
    }
  }
  if (requestedCanonicalTarget && requestedCanonicalTarget !== text(preview.canonicalTarget)) {
    throw conflict('规范目标已经变化，请重新生成预览', 'PRODUCT_PLAN_STALE')
  }
  if (preview.requiresExplicit && !bool(body?.confirmDirty)) {
    throw conflict('接管会覆盖工作树中的用户脏改，请预览并明确确认', 'PRODUCT_DIRTY_REQUIRES_CONFIRM', { dirtyFiles: preview.dirtyFiles || [] })
  }
  const root = preview.worktreePath
  const currentPreview = await buildTakeoverPreview(productRoot, state, {
    planId: preview.planId,
    versionId: preview.versionId,
    worktreePath: root,
    targetProjection: preview.targetProjection,
    canonicalTarget: preview.canonicalTarget,
    selectedSystemIds: preview.selectedSystemIds,
    selectedSystemRefs: preview.selectedSystemRefs
  })
  if (takeoverPlanHash(currentPreview) !== takeoverPlanHash(preview)) {
    throw conflict('worktree changed after preview; analyze again', 'PRODUCT_PLAN_STALE', { previewId: preview.previewId })
  }
  const protectionId = randomId('protection')
  const protectionRoot = productPath(productRoot, 'protection', protectionId)
  const workspaceId = workspaceKey(root)
  const previousWorkspace = state.workspaces[workspaceId]
  const projectionRootsBefore = {}
  for (const prefix of TAKEOVER_PROJECTION_ROOTS) {
    projectionRootsBefore[prefix.join('/')] = Boolean(await lstatOrNull(path.resolve(root, ...prefix)))
  }
  const protection = {
    schemaVersion: SCHEMA_VERSION,
    protectionId,
    previewId: preview.previewId,
    planId: preview.planId,
    versionId: preview.versionId,
    worktreePath: root,
    createdAt: nowIso(),
    status: 'prepared',
    targetProjection: preview.targetProjection,
    canonicalTarget: preview.canonicalTarget,
    canonicalTargetDirectory: preview.canonicalTarget,
    projectionRootsBefore,
    linkTopology: await captureLinkTopology(root, preview.linkBoundaries),
    directoriesBefore: await captureDirectoryTopology(root, preview.operations.filter((item) => item.action !== 'keep')),
    createdDirectories: [],
    workspaceSnapshot: { existed: Boolean(previousWorkspace), workspace: cloneWorkspaceSnapshot(previousWorkspace) },
    files: []
  }
  const manifest = await versionManifest(productRoot, preview.planId, preview.versionId)
  let postApplyAnalysisId = null
  try {
    await assertLinkTopology(root, protection.linkTopology, 'PRODUCT_TAKEOVER_TOPOLOGY_CONFLICT')
    for (const operation of preview.operations.filter((item) => item.action !== 'keep')) {
      const target = workspacePath(root, operation.targetPath || operation.path)
      const current = await lstatOrNull(target)
      const beforeExists = Boolean(current?.isFile())
      const backupPath = productPath(protectionRoot, 'files', ...(operation.targetPath || operation.path).split('/'))
      if (beforeExists) {
        const bytes = await fsp.readFile(target)
        await atomicBytes(backupPath, bytes, protectionRoot)
      }
      protection.files.push({ path: operation.path, targetPath: operation.targetPath || operation.path, beforeExists, beforeHash: operation.beforeHash, afterHash: operation.afterHash, backupPath: beforeExists ? `files/${operation.targetPath || operation.path}` : null })
    }
    await atomicJson(productPath(protectionRoot, 'manifest.json'), protection, productRoot)
    for (const operation of preview.operations.filter((item) => item.action !== 'keep')) {
      const record = manifest.files.find((item) => item.path === operation.path)
      if (!record) throw serviceError(500, 'PRODUCT_STATE_INVALID', `version file disappeared: ${operation.path}`)
      const content = await versionRecordContent(productRoot, preview.planId, preview.versionId, record)
      const beforeCreatedDirectories = protection.createdDirectories.length
      await ensureTakeoverParentDirectories(root, operation.targetPath || operation.path, protection)
      if (protection.createdDirectories.length !== beforeCreatedDirectories) {
        await atomicJson(productPath(protectionRoot, 'manifest.json'), protection, productRoot)
      }
      await safeExternalWrite(workspacePath(root, operation.targetPath || operation.path), Buffer.from(content, 'utf8'), root)
    }
    await assertLinkTopology(root, protection.linkTopology, 'PRODUCT_TAKEOVER_TOPOLOGY_CONFLICT')
    protection.status = 'applied'
    protection.appliedAt = nowIso()
    await atomicJson(productPath(protectionRoot, 'manifest.json'), protection, productRoot)
    state.protections[protectionId] = {
      protectionId,
      previewId: preview.previewId,
      planId: preview.planId,
      versionId: preview.versionId,
      worktreePath: root,
      targetProjection: protection.targetProjection,
      canonicalTarget: protection.canonicalTarget,
      canonicalTargetDirectory: protection.canonicalTargetDirectory,
      status: protection.status,
      createdAt: protection.createdAt,
      createdDirectories: [...protection.createdDirectories]
    }
    const workspace = state.workspaces[workspaceId] || {
      workspaceId: `workspace-${hashText(workspaceId).slice(0, 16)}`,
      workspacePath: root,
      workspaceName: workspaceName(root),
      createdAt: nowIso()
    }
    workspace.workspacePath = root
    workspace.workspaceName = workspaceName(root)
    workspace.planId = preview.planId
    workspace.connectedVersion = preview.versionId
    workspace.baselineVersion = preview.versionId
    workspace.selectedSystemIds = [...(preview.selectedSystemIds || [])]
    workspace.selectedSystemRefs = [...(preview.selectedSystemRefs || [])]
    workspace.connectionMode = 'takeover'
    workspace.protectionId = protectionId
    workspace.status = 'connected'
    workspace.hasUpdates = false
    workspace.pendingAnalysisId = null
    workspace.pendingComparisonId = null
    workspace.pendingSummary = null
    workspace.connectionRecoveryRequired = false
    // Read the resulting worktree once to persist the exact post-takeover
    // baseline signature. The next analysis can then reuse the same selected
    // scope, even when a nested Junction changes the physical path.
    postApplyAnalysisId = randomId('analysis')
    const postApplyAnalysis = await analyzeWorkspaceReadOnly(root, productRoot, { analysisId: postApplyAnalysisId })
    state.analyses[postApplyAnalysis.analysisId] = {
      analysisId: postApplyAnalysis.analysisId,
      workspacePath: postApplyAnalysis.workspacePath,
      createdAt: postApplyAnalysis.createdAt,
      summary: postApplyAnalysis.summary,
      lifecycle: 'takeover-post-apply',
      protectionId
    }
    protection.postApplyAnalysisId = postApplyAnalysis.analysisId
    if (state.protections[protectionId]) state.protections[protectionId].postApplyAnalysisId = postApplyAnalysis.analysisId
    await atomicJson(productPath(protectionRoot, 'manifest.json'), protection, productRoot)
    reconcileWorkspaceSelection(workspace, postApplyAnalysis)
    workspace.lastAnalysisId = postApplyAnalysis.analysisId
    workspace.lastAnalyzedAt = postApplyAnalysis.createdAt
    workspace.baselineSignature = analysisSignature(postApplyAnalysis, workspace.selectedSystemIds)
    workspace.baselineSafetySignature = analysisSafetySignature(postApplyAnalysis)
    workspace.observedSafetySignature = workspace.baselineSafetySignature
    workspace.observedSignature = workspace.baselineSignature
    workspace.safetyBlocked = Number(postApplyAnalysis.summary?.externalLinks || 0) > 0
    workspace.status = workspaceStatus(workspace, false)
    state.workspaces[workspaceId] = workspace
    return {
      protectionId,
      previewId: preview.previewId,
      status: 'applied',
      summary: preview.summary,
      preserve: preview.preserve,
      targetProjection: preview.targetProjection,
      canonicalTarget: preview.canonicalTarget,
      canonicalTargetDirectory: preview.canonicalTarget,
      createdDirectories: [...protection.createdDirectories],
      selectedSystemIds: workspace.selectedSystemIds,
      baselineVersion: workspace.baselineVersion,
      baselineSignature: workspace.baselineSignature,
      workspace: publicWorkspace(workspace)
    }
  } catch (error) {
    await rollbackProtection(productRoot, protection).catch(() => {})
    restoreTakeoverWorkspaceState(state, protection)
    if (postApplyAnalysisId) {
      delete state.analyses[postApplyAnalysisId]
      if (state.protections[protectionId]) delete state.protections[protectionId].postApplyAnalysisId
      await cleanupOwnedAnalysis(productRoot, postApplyAnalysisId).catch(() => {})
      delete protection.postApplyAnalysisId
      // rollbackProtection may already have persisted the protection with the
      // transient post-apply id. Keep the durable manifest in sync with the
      // state/disk cleanup even when the rollback itself failed closed.
      await atomicJson(productPath(protectionRoot, 'manifest.json'), protection, productRoot).catch(() => {})
    }
    if (state.protections[protectionId]) state.protections[protectionId].status = 'rolled-back'
    throw error
  }
}

async function rollbackProtection(productRoot, protection) {
  const root = protection.worktreePath
  const rootResolved = path.resolve(root)
  if (protection.status === 'rolled-back') {
    return {
      protectionId: protection.protectionId,
      status: 'rolled-back',
      idempotent: true,
      worktreePath: root,
      targetProjection: protection.targetProjection || null,
      canonicalTarget: protection.canonicalTarget || null,
      canonicalTargetDirectory: protection.canonicalTargetDirectory || protection.canonicalTarget || null,
      createdDirectories: Array.isArray(protection.createdDirectories) ? [...protection.createdDirectories] : []
    }
  }
  // Takeover creates nested skill directories when a projection was absent.
  // Remove only empty ordinary directories below the projection root.  The
  // projection root itself is removed only when the protection manifest says
  // it did not exist before takeover. The selected worktree root, links, and
  // any directory that still contains an entry are never removed.
  async function cleanCreatedParents(targetRelative) {
    const normalized = normalizeRelative(targetRelative)
    if (!normalized) return
    const parts = normalized.split('/')
    const folded = (value) => value.toLocaleLowerCase('en-US')
    const boundary = TAKEOVER_PROJECTION_ROOTS
      .map((prefix) => prefix.every((part, index) => folded(parts[index] || '') === folded(part)) ? prefix.length : 0)
      .reduce((max, length) => Math.max(max, length), 0)
    if (!boundary || parts.length <= boundary) return
    const projectionKey = parts.slice(0, boundary).join('/')
    const projectionExistedBefore = protection.projectionRootsBefore?.[projectionKey]
    let current = path.resolve(rootResolved, ...parts.slice(0, -1))
    while (inside(rootResolved, current) && current !== rootResolved) {
      const relative = path.relative(rootResolved, current).replaceAll('\\', '/')
      const currentParts = relative.split('/').filter(Boolean)
      if (currentParts.length < boundary) break
      if (protection.directoriesBefore && Object.prototype.hasOwnProperty.call(protection.directoriesBefore, relative)) {
        if (protection.directoriesBefore[relative] !== false) break
      } else if (currentParts.length === boundary && projectionExistedBefore !== false) break
      const stat = await lstatOrNull(current)
      if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) break
      const entries = await fsp.readdir(current).catch(() => null)
      if (!entries || entries.length !== 0) break
      try {
        await fsp.rmdir(current)
      } catch {
        break
      }
      if (await lstatOrNull(current)) break
      current = path.dirname(current)
    }
  }

  async function cleanRecordedDirectories() {
    const recorded = [...new Set((Array.isArray(protection.createdDirectories) ? protection.createdDirectories : [])
      .map((relative) => normalizeRelative(relative))
      .filter(Boolean))]
      .sort((left, right) => {
        const depth = (value) => value.split('/').length
        return depth(right) - depth(left) || right.localeCompare(left)
      })
    for (const relative of recorded) {
      const current = workspacePath(rootResolved, relative)
      const stat = await lstatOrNull(current)
      if (!stat?.isDirectory() || stat.isSymbolicLink()) continue
      const entries = await fsp.readdir(current).catch(() => null)
      if (!entries || entries.length !== 0) continue
      await fsp.rmdir(current).catch(() => {})
    }
  }

  // Old protections did not carry a topology snapshot; retain their existing
  // file-only rollback behavior. New protections fail closed before touching
  // any file if a Junction/reparse boundary changed or was materialized.
  await assertLinkTopology(root, protection.linkTopology)
  for (const entry of protection.files) {
    const target = workspacePath(root, entry.targetPath || entry.path)
    const current = await readSmallFile(target)
    if (!current.exists || current.hash !== entry.afterHash) throw conflict(`cannot rollback changed target: ${entry.path}`, 'PRODUCT_ROLLBACK_CONFLICT')
    if (entry.beforeExists) {
      const backup = productPath(productRoot, 'protection', protection.protectionId, entry.backupPath || '')
      const backupStat = await lstatOrNull(backup)
      if (!entry.backupPath || !backupStat?.isFile()) {
        throw conflict(`rollback backup is unavailable: ${entry.path}`, 'PRODUCT_ROLLBACK_CONFLICT')
      }
    }
  }
  for (const entry of protection.files) {
    const target = workspacePath(root, entry.targetPath || entry.path)
    const current = await readSmallFile(target)
    if (current.exists && current.hash !== entry.afterHash) throw conflict(`cannot rollback changed target: ${entry.path}`, 'PRODUCT_ROLLBACK_CONFLICT')
    if (entry.beforeExists) {
      const bytes = await fsp.readFile(productPath(productRoot, 'protection', protection.protectionId, entry.backupPath || ''))
      await safeExternalWrite(target, bytes, root)
    } else {
      const stat = await lstatOrNull(target)
      if (stat?.isFile()) {
        await fsp.rm(target, { force: true })
        if (Array.isArray(protection.createdDirectories)) await cleanRecordedDirectories()
        else await cleanCreatedParents(entry.targetPath || entry.path)
      }
    }
  }
  if (Array.isArray(protection.createdDirectories)) await cleanRecordedDirectories()
  await assertLinkTopology(root, protection.linkTopology)
  protection.status = 'rolled-back'
  protection.rolledBackAt = nowIso()
  await atomicJson(productPath(productRoot, 'protection', protection.protectionId, 'manifest.json'), protection, productRoot)
  return {
    protectionId: protection.protectionId,
    status: protection.status,
    worktreePath: root,
    targetProjection: protection.targetProjection || null,
    canonicalTarget: protection.canonicalTarget || null,
    canonicalTargetDirectory: protection.canonicalTargetDirectory || protection.canonicalTarget || null,
    createdDirectories: Array.isArray(protection.createdDirectories) ? [...protection.createdDirectories] : []
  }
}

async function buildRollbackPreview(productRoot, state, body) {
  const planId = requiredText(body?.planId, 'planId')
  const plan = state.plans[planId]
  if (!plan?.currentVersion) throw notFound(`library not found: ${planId}`)
  const sourceVersion = text(body?.versionId, body?.version)
  if (!sourceVersion) throw bad('versionId is required')
  const currentVersion = plan.currentVersion
  const currentManifest = await versionManifest(productRoot, planId, currentVersion)
  await assertVersionBodiesAvailable(productRoot, planId, currentVersion, currentManifest)
  const sourceManifest = await versionManifest(productRoot, planId, sourceVersion)
  await assertVersionBodiesAvailable(productRoot, planId, sourceVersion, sourceManifest, { code: 'PRODUCT_VERSION_CONTENT_UNAVAILABLE' })
  const { files } = await buildVersionDiff(productRoot, planId, currentVersion, sourceVersion)
  const nextNumber = Math.max(0, ...(plan.versions || []).map((item) => Number(String(item.versionId).replace(/^v/i, '')) || 0)) + 1
  const nextVersion = `v${nextNumber}`
  const preview = {
    schemaVersion: SCHEMA_VERSION,
    previewId: randomId('rollback-preview'),
    planId,
    currentVersion,
    sourceVersion,
    nextVersion,
    createdAt: nowIso(),
    message: text(body?.message, `从 ${sourceVersion} 回滚创建`),
    confirmRequired: true,
    scope: files.map((file) => ({ path: file.path, changeType: file.changeType, oldHash: file.oldHash, newHash: file.newHash })),
    summary: {
      changedFiles: files.length,
      added: files.filter((file) => file.changeType === 'added').length,
      modified: files.filter((file) => file.changeType === 'modified').length,
      deleted: files.filter((file) => file.changeType === 'deleted').length
    },
    files,
    planHash: hashJson({ planId, currentVersion, sourceVersion, nextVersion, files })
  }
  await atomicJson(productPath(productRoot, 'rollback-previews', preview.previewId, 'preview.json'), preview, productRoot)
  state.rollbackPreviews[preview.previewId] = {
    previewId: preview.previewId,
    planId,
    currentVersion,
    sourceVersion,
    nextVersion,
    planHash: preview.planHash,
    createdAt: preview.createdAt
  }
  return preview
}

async function readRollbackPreview(productRoot, previewId) {
  const value = await readJson(productPath(productRoot, 'rollback-previews', requiredText(previewId, 'previewId'), 'preview.json'), null)
  if (!value) throw notFound(`rollback preview not found: ${previewId}`)
  return value
}

async function rollbackVersion(productRoot, state, body) {
  const preview = await readRollbackPreview(productRoot, body?.previewId)
  if (body?.planHash && body.planHash !== preview.planHash) throw conflict('回滚预览已经变化，请重新生成预览', 'PRODUCT_PLAN_STALE')
  if (!bool(body?.confirm)) {
    throw conflict('请先查看回滚范围和逐文件差异，再明确确认生成新版本', 'PRODUCT_ROLLBACK_CONFIRM_REQUIRED', {
      previewId: preview.previewId,
      scope: preview.scope,
      summary: preview.summary
    })
  }
  const plan = state.plans[preview.planId]
  if (!plan?.currentVersion) throw notFound(`library not found: ${preview.planId}`)
  if (plan.currentVersion !== preview.currentVersion) throw conflict('中心库已有新版本，请重新生成回滚预览', 'PRODUCT_PLAN_STALE')
  const currentManifest = await versionManifest(productRoot, preview.planId, preview.currentVersion)
  await assertVersionBodiesAvailable(productRoot, preview.planId, preview.currentVersion, currentManifest)
  const sourceManifest = await versionManifest(productRoot, preview.planId, preview.sourceVersion)
  await assertVersionBodiesAvailable(productRoot, preview.planId, preview.sourceVersion, sourceManifest, { code: 'PRODUCT_VERSION_CONTENT_UNAVAILABLE' })
  const currentDiff = await buildVersionDiff(productRoot, preview.planId, preview.currentVersion, preview.sourceVersion)
  const currentHash = hashJson({ planId: preview.planId, currentVersion: preview.currentVersion, sourceVersion: preview.sourceVersion, nextVersion: preview.nextVersion, files: currentDiff.files })
  if (currentHash !== preview.planHash) throw conflict('回滚范围已经变化，请重新生成预览', 'PRODUCT_PLAN_STALE')
  const source = sourceManifest
  const createdAt = nowIso()
  const rollbackFiles = []
  for (const file of source.files) {
    const content = await versionRecordContent(productRoot, preview.planId, preview.sourceVersion, file)
    await atomicBytes(productPath(productRoot, 'library', preview.planId, 'versions', preview.nextVersion, 'files', ...file.path.split('/')), Buffer.from(content, 'utf8'), productPath(productRoot, 'library', preview.planId))
    rollbackFiles.push({ ...file, path: file.path, logicalPath: file.path, storagePath: file.path })
  }
  const manifest = { ...source, versionId: preview.nextVersion, createdAt, message: text(body?.message, preview.message), rollbackOf: preview.sourceVersion, files: rollbackFiles }
  // A rollback is an append-only version operation, not a draft commit. Do
  // not copy the source version's receipt into the new version and make it
  // appear as if that new version had already been committed from a draft.
  delete manifest.commitReceipt
  delete manifest.mergeReceipt
  await atomicJson(productPath(productRoot, 'library', preview.planId, 'versions', preview.nextVersion, 'manifest.json'), manifest, productRoot)
  plan.currentVersion = preview.nextVersion
  plan.updatedAt = createdAt
  plan.fileCount = manifest.files.length
  plan.skillCount = manifest.files.filter((file) => /(?:^|\/)SKILL\.md$/iu.test(file.path)).length
  plan.ruleCount = manifest.files.filter((file) => /^rules\//iu.test(file.path)).length
  plan.versions = [...(plan.versions || []), { versionId: preview.nextVersion, createdAt, message: manifest.message, fileCount: manifest.files.length, rollbackOf: preview.sourceVersion }]
  preview.status = 'confirmed'
  preview.confirmedAt = createdAt
  preview.createdVersion = preview.nextVersion
  await atomicJson(productPath(productRoot, 'rollback-previews', preview.previewId, 'preview.json'), preview, productRoot)
  return { plan: planPublic(plan, manifest), version: manifest, preview, status: 'created-from-rollback' }
}

async function takeoverTargetAvailability(worktreeRoot, targetRelative) {
  const normalized = normalizeRelative(targetRelative)
  if (!normalized) return { available: false, unavailableReason: '目标路径不安全' }
  let current = worktreeRoot
  const parts = normalized.split('/')
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index])
    const stat = await lstatOrNull(current)
    if (!stat?.isSymbolicLink()) continue
    const real = await fsp.realpath(current).catch(() => '')
    if (!real || !inside(worktreeRoot, real)) {
      return { available: false, unavailableReason: '目标路径指向工作区外部链接，不能接管' }
    }
    return { available: false, unavailableReason: '目标路径仍包含工作区内部链接，需先转换为规范目标' }
  }
  return { available: true }
}

async function canonicalTargetStatus(worktreeRoot, canonicalTarget) {
  const resolved = path.resolve(canonicalTarget || '')
  if (!canonicalTarget || !inside(worktreeRoot, resolved)) {
    return { valid: false, reason: '规范接管目标必须位于所选工作区内' }
  }
  const stat = await lstatOrNull(resolved)
  if (stat && !stat.isDirectory() && !stat.isSymbolicLink()) {
    return { valid: false, reason: '规范接管目标必须是目录根，不能是内容文件' }
  }
  const real = await fsp.realpath(resolved).catch(() => resolved)
  if (!inside(worktreeRoot, real)) {
    return { valid: false, reason: '规范接管目标指向工作区外部链接，不能接管' }
  }
  const realStat = await lstatOrNull(real)
  if (realStat && !realStat.isDirectory()) {
    return { valid: false, reason: '规范接管目标必须解析为目录根，不能是内容文件' }
  }
  return { valid: true, canonicalTarget: resolved }
}

async function resolveTargetCandidate(worktreeRoot, projection, rest) {
  const projectionParts = projection.split('/').filter(Boolean)
  const restParts = rest.split('/').filter(Boolean)
  const targetParts = [...projectionParts, ...restParts]
  // For a logical file under `skills/<system>/...`, the canonical target is
  // the system directory (`<system>`), not the final content file.  A one-file
  // skill uses the projection root itself as its canonical directory.
  const canonicalBoundary = projectionParts.length + (restParts.length > 1 ? 0 : -1)
  let current = worktreeRoot
  let linked = false
  let canonicalTarget = null
  const linkBoundaries = []
  for (let index = 0; index < targetParts.length; index += 1) {
    current = path.join(current, targetParts[index])
    const stat = await lstatOrNull(current)
    if (stat && index < targetParts.length - 1 && !stat.isDirectory() && !stat.isSymbolicLink()) {
      return {
        available: false,
        projection,
        targetPath: path.relative(worktreeRoot, current).replaceAll('\\', '/'),
        unavailableReason: '目标投影不是文件夹'
      }
    }
    if (stat) {
      const real = await fsp.realpath(current).catch(() => '')
      const linkLike = stat.isSymbolicLink() || Boolean(real && portableKey(real) !== portableKey(path.resolve(current)))
      if (linkLike) {
        linked = true
        if (!real || !inside(worktreeRoot, real)) {
          return {
            available: false,
            projection,
            targetPath: path.relative(worktreeRoot, current).replaceAll('\\', '/') || projection,
            unavailableReason: '目标路径指向工作区外部链接，不能接管'
          }
        }
        linkBoundaries.push({
          path: path.relative(worktreeRoot, current).replaceAll('\\', '/'),
          canonicalTarget: real
        })
        current = real
      }
    }
    if (index === canonicalBoundary) canonicalTarget = current
  }
  const targetPath = path.relative(worktreeRoot, current).replaceAll('\\', '/')
  if (!targetPath || !inside(worktreeRoot, current)) {
    return { available: false, projection, targetPath: null, unavailableReason: '目标路径不在所选工作区内' }
  }
  if (!canonicalTarget) {
    const fallbackIndex = Math.max(0, Math.min(targetParts.length - 1, canonicalBoundary))
    canonicalTarget = path.resolve(worktreeRoot, ...targetParts.slice(0, fallbackIndex + 1))
  }
  const canonicalStatus = await canonicalTargetStatus(worktreeRoot, canonicalTarget)
  if (!canonicalStatus.valid) {
    return { available: false, projection, targetPath, canonicalTarget, unavailableReason: canonicalStatus.reason }
  }
  return {
    available: true,
    projection,
    targetPath,
    canonicalTarget: canonicalStatus.canonicalTarget,
    linked,
    linkBoundaries
  }
}

async function logicalTargetPath(worktreeRoot, logicalPath, requestedProjection) {
  const normalized = normalizeRelative(logicalPath)
  if (!normalized) throw bad(`unsafe logical path: ${logicalPath}`, 'PRODUCT_PATH_ESCAPE')
  const parts = normalized.split('/')
  if (parts[0].toLocaleLowerCase('en-US') === 'skills') {
    const rest = parts.slice(1).join('/')
    const requested = text(requestedProjection).trim().replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '')
    if (requested && !normalizeRelative(requested)) throw bad('targetProjection is unsafe', 'PRODUCT_PATH_ESCAPE')
    const candidates = requested ? [requested] : TAKEOVER_SKILL_PROJECTION_PATHS
    let firstUnavailable = null
    for (const candidate of candidates) {
      const root = normalizeRelative(candidate)
      if (!root) continue
      const rootStat = await lstatOrNull(workspacePath(worktreeRoot, root))
      if (!rootStat && !requested) continue
      const result = await resolveTargetCandidate(worktreeRoot, root, rest)
      if (result.available) return result
      if (!firstUnavailable) firstUnavailable = result
      if (requested) return result
    }
    if (firstUnavailable) return firstUnavailable
    const fallback = TAKEOVER_SKILL_PROJECTION_PATHS.at(-1) || 'skills'
    return resolveTargetCandidate(worktreeRoot, fallback, rest)
  }
  if (parts[0].toLocaleLowerCase('en-US') === 'rules') return { available: true, projection: 'rules', targetPath: parts.slice(1).join('/') || 'AGENTS.md', canonicalTarget: worktreeRoot, linked: false }
  return { available: true, projection: '', targetPath: normalized, canonicalTarget: path.resolve(worktreeRoot), linked: false }
}

function targetProjectionLabel(value) {
  const labels = {
    '.agents/skills': '工作区技能目录（Agents）',
    '.claude/skills': '工作区技能目录（Claude）',
    '.cursor/skills': '工作区技能目录（Cursor）',
    '.codex/skills': '工作区技能目录（Codex）',
    skills: '工作区技能目录（通用）'
  }
  return labels[value] || `工作区目标（${value}）`
}

async function targetProjectionOptions(worktreeRoot, manifest) {
  const sample = (manifest.files || []).find((file) => /^skills\//iu.test(file.path || ''))
  if (!sample) return []
  const options = []
  for (const value of TAKEOVER_SKILL_PROJECTION_PATHS) {
    const result = await logicalTargetPath(worktreeRoot, sample.path, value)
    options.push({
      value,
      label: targetProjectionLabel(value),
      available: result.available,
      targetPath: result.targetPath || null,
      canonicalTarget: result.canonicalTarget || null,
      canonicalTargetDirectory: result.canonicalTarget || null,
      reason: result.unavailableReason || '',
      selected: false
    })
  }
  return options
}

export function createProductService(options = {}) {
  const packageRoot = path.resolve(text(options.packageRoot, process.cwd()))
  const dataRoot = path.resolve(text(options.dataRoot, packageRoot))
  const productRoot = productPath(dataRoot, 'product')
  const host = options.host
  const executeTyped = options.executeTyped
  let stateCache = null
  let writeTail = Promise.resolve()

  async function ensureProduct() {
    await fsp.mkdir(productRoot, { recursive: true })
  }

  async function loadState() {
    await ensureProduct()
    if (!stateCache) stateCache = normalizeState(await readJson(productPath(productRoot, 'state.json'), null))
    return stateCache
  }

  async function saveState() {
    const state = await loadState()
    writeTail = writeTail.catch(() => {}).then(() => atomicJson(productPath(productRoot, 'state.json'), state, productRoot))
    await writeTail
  }

  async function withState(mutator) {
    const state = await loadState()
    const result = await mutator(state)
    await saveState()
    return result
  }

  function isWriteRoute(pathname) {
    const route = normalizeRoute(pathname)
    return new Set([
      '/pick-folder', '/analyze', '/workspace/check', '/workspace/complete-connection', '/library/initialize', '/library/draft', '/compare', '/version/compare',
      '/draft/file', '/draft/confirm', '/draft/ai', '/draft/commit', '/version/rollback/preview', '/version/rollback',
      '/takeover/preview', '/takeover/apply', '/takeover/rollback', '/chat', '/chat/cancel'
    ]).has(route)
  }

  function normalizeRoute(pathname) {
    const raw = text(pathname, '')
    if (raw === '/api/product') return '/'
    if (raw.startsWith('/api/product/')) return raw.slice('/api/product'.length)
    return raw
  }

  async function pickFolder() {
    if (process.platform !== 'win32') return { cancelled: true, reason: 'native folder picker is only available on Windows' }
    const script = [
      '$shell = New-Object -ComObject Shell.Application',
      '$folder = $shell.BrowseForFolder(0, "选择要分析的工作区", 1, 0)',
      'if ($null -ne $folder) { [Console]::Out.Write($folder.Self.Path) }'
    ].join('; ')
    try {
      const result = await execFileAsync('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
        windowsHide: false,
        // A native picker is user-controlled. Keep the server-side guard
        // short enough for the UI fallback to recover instead of holding the
        // product busy state indefinitely.
        timeout: 30000,
        maxBuffer: 256 * 1024
      })
      const selectedPath = text(result.stdout).trim()
      return selectedPath ? { cancelled: false, workspacePath: selectedPath } : { cancelled: true }
    } catch (error) {
      if (error?.code === 'ETIMEDOUT') throw serviceError(504, 'PRODUCT_PICKER_TIMEOUT', 'folder picker timed out')
      return { cancelled: true, error: text(error?.message, 'folder picker cancelled') }
    }
  }

  async function handle(input = {}) {
    const method = text(input.method, 'GET').toUpperCase()
    const pathname = normalizeRoute(input.pathname)
    const body = input.body && typeof input.body === 'object' ? input.body : {}
    const searchParams = input.searchParams || new URLSearchParams()
    const state = await loadState()

    if (method === 'GET' && pathname === '/overview') {
      const plans = await Promise.all(Object.values(state.plans).map(async (plan) => {
        const manifest = plan.currentVersion ? await versionManifest(productRoot, plan.planId, plan.currentVersion).catch(() => null) : null
        return planPublic(plan, manifest)
      }))
      const pendingDrafts = Object.keys(state.drafts).length
      const analyses = Object.keys(state.analyses).length
      const workspaces = Object.values(state.workspaces).map(publicWorkspace)
      const activePlan = plans.find((plan) => plan.planId === state.activePlanId) || null
      const suppliedPlanId = text(searchParams.get?.('planId') || searchParams.planId)
      const requestedPlanId = suppliedPlanId || state.activePlanId
      const requestedVersionId = text(searchParams.get?.('versionId') || searchParams.get?.('version') || searchParams.versionId || searchParams.version)
      const requestedDraftId = text(searchParams.get?.('draftId') || searchParams.draftId)
      const commitReceipt = await resolveCommitReceipt(productRoot, state, {
        // A direct old result URL may carry only its draft id. Let the draft
        // locate its own plan instead of filtering it through today's active
        // plan.
        planId: requestedDraftId && !suppliedPlanId ? '' : requestedPlanId,
        versionId: requestedVersionId || (requestedDraftId ? '' : activePlan?.currentVersion || ''),
        draftId: requestedDraftId
      })
      const commitReceipts = await commitReceiptList(productRoot, state, requestedPlanId)
      const mergeReceipt = await resolveMergeReceipt(productRoot, state, {
        planId: requestedDraftId && !suppliedPlanId ? '' : requestedPlanId,
        versionId: requestedVersionId || (requestedDraftId ? '' : activePlan?.currentVersion || ''),
        draftId: requestedDraftId,
        comparisonId: commitReceipt?.comparisonId || ''
      })
      return {
        activePlanId: state.activePlanId,
        plans,
        libraryCount: plans.length,
        skillCount: plans.reduce((sum, plan) => sum + (plan.skillCount || 0), 0),
        pendingUpdates: workspaces.filter((workspace) => workspace.hasUpdates).length,
        workspaces,
        pendingDrafts,
        analyses,
        commitReceipt,
        commitReceipts,
        mergeReceipt,
        productRoot
      }
    }
    if (method === 'POST' && pathname === '/pick-folder') return pickFolder()
    if (method === 'POST' && pathname === '/analyze') {
      const manifest = await analyzeWorkspaceReadOnly(body.workspacePath, productRoot)
      return withState((current) => {
        current.analyses[manifest.analysisId] = { analysisId: manifest.analysisId, workspacePath: manifest.workspacePath, createdAt: manifest.createdAt, summary: manifest.summary }
        const workspace = observeWorkspace(current, manifest)
        return { ...publicAnalysis(manifest), workspace: publicWorkspace(workspace) }
      })
    }
    if (method === 'POST' && pathname === '/workspace/check') {
      const manifest = await analyzeWorkspaceReadOnly(body.workspacePath, productRoot)
      return withState((current) => {
        current.analyses[manifest.analysisId] = { analysisId: manifest.analysisId, workspacePath: manifest.workspacePath, createdAt: manifest.createdAt, summary: manifest.summary }
        const workspace = observeWorkspace(current, manifest)
        return { ...publicAnalysis(manifest), workspace: publicWorkspace(workspace), changes: workspace.hasUpdates ? { detected: true, summary: workspace.pendingSummary } : { detected: false } }
      })
    }
    if (method === 'POST' && pathname === '/library/initialize') {
      return withState((current) => initializeLibrary(productRoot, current, body))
    }
    if (method === 'GET' && pathname === '/library') return readLibrary(productRoot, state, searchParams)
    if (method === 'GET' && pathname === '/library/file') return readLibraryFile(productRoot, state, searchParams)
    if (method === 'GET' && pathname === '/library/source') return readLibrarySource(productRoot, state, searchParams)
    if (method === 'GET' && pathname === '/search') return searchProduct(productRoot, state, searchParams)
    if (method === 'POST' && pathname === '/compare') {
      const comparison = body?.fromVersion && body?.toVersion
        ? await buildVersionComparison(productRoot, state, body)
        : await buildComparison(productRoot, state, body)
      if (comparison.sourceWorkspace) {
        const analysis = comparison.analysisId ? await analysisManifest(productRoot, comparison.analysisId) : null
        const workspace = analysis ? observeWorkspace(state, analysis) : state.workspaces[workspaceKey(comparison.sourceWorkspace)]
        if (workspace) {
          workspace.planId = comparison.planId
          const workspaceChanged = Number(comparison.summary?.workspaceChanged ?? comparison.files?.filter((file) => file.direction !== 'center-only').length ?? 0) > 0
          workspace.pendingComparisonId = workspaceChanged ? comparison.comparisonId : null
          workspace.pendingAnalysisId = workspaceChanged ? (comparison.analysisId || workspace.pendingAnalysisId || null) : null
          workspace.pendingSummary = workspaceChanged ? comparison.summary : null
          workspace.hasUpdates = workspaceChanged
          workspace.status = workspaceStatus(workspace, workspaceChanged)
        }
      }
      await saveState()
      return { comparisonId: comparison.comparisonId, planId: comparison.planId, analysisId: comparison.analysisId, sourceWorkspace: comparison.sourceWorkspace, baseVersion: comparison.baseVersion, targetVersion: comparison.targetVersion || null, selectedSystemIds: comparison.selectedSystemIds || [], selectedSystemRefs: comparison.selectedSystemRefs || [], selectedSystems: comparison.selectedSystems, summary: comparison.summary, files: comparison.files }
    }
    if (method === 'POST' && pathname === '/workspace/complete-connection') {
      const result = await completeConnection(productRoot, state, body)
      await saveState()
      return result
    }
    if (method === 'POST' && pathname === '/version/compare') {
      const comparison = await buildVersionComparison(productRoot, state, body)
      await saveState()
      return { comparisonId: comparison.comparisonId, planId: comparison.planId, baseVersion: comparison.baseVersion, targetVersion: comparison.targetVersion, summary: comparison.summary, files: comparison.files }
    }
    if (method === 'GET' && pathname === '/comparison') {
      const comparison = await readComparison(productRoot, searchParams.get?.('comparisonId') || searchParams.comparisonId)
      return {
        ...comparison,
        commitReceipt: await resolveCommitReceipt(productRoot, state, {
          planId: comparison.planId,
          comparisonId: comparison.comparisonId
        }),
        mergeReceipt: await resolveMergeReceipt(productRoot, state, {
          planId: comparison.planId,
          comparisonId: comparison.comparisonId
        })
      }
    }
    if (method === 'POST' && pathname === '/library/draft') {
      const draft = await createDraft(productRoot, state, body)
      await saveState()
      return publicDraft(draft)
    }
    if (method === 'GET' && pathname === '/draft') {
      const draft = await readDraft(productRoot, searchParams.get?.('draftId') || searchParams.draftId)
      return publicDraftWithContent(productRoot, draft, searchParams.get?.('path') || searchParams.path)
    }
    if (method === 'POST' && pathname === '/draft/file') {
      const draft = await readDraft(productRoot, body?.draftId)
      await assertDraftCenterContentAvailable(productRoot, state, draft)
      const relative = requiredText(body?.path, 'path')
      const normalized = normalizeRelative(relative)
      if (!normalized) throw bad('draft file path is unsafe', 'PRODUCT_PATH_ESCAPE')
      if (!draft.files.some((file) => file.path === normalized)) throw notFound(`draft file not found: ${normalized}`)
      const draftRecord = draft.files.find((file) => file.path === normalized)
      if (draftRecord.editable === false || draftRecord.deleted) throw conflict(`文件未被选为可编辑范围: ${normalized}`, 'PRODUCT_FILE_NOT_EDITABLE')
      const content = text(body?.content)
      await atomicBytes(productPath(productRoot, 'drafts', draft.draftId, 'files', ...normalized.split('/')), Buffer.from(content, 'utf8'), productPath(productRoot, 'drafts', draft.draftId))
      const file = draftRecord
      file.contentHash = contentHash(content)
      file.size = Buffer.byteLength(content, 'utf8')
      file.confirmed = false
      await saveDraft(productRoot, draft)
      await saveState()
      return { draftId: draft.draftId, file, content }
    }
    if (method === 'POST' && pathname === '/draft/confirm') {
      const draft = await readDraft(productRoot, body?.draftId)
      await assertDraftCenterContentAvailable(productRoot, state, draft)
      const normalized = normalizeRelative(requiredText(body?.path, 'path'))
      const file = draft.files.find((item) => item.path === normalized)
      if (!file) throw notFound(`draft file not found: ${normalized}`)
      if (file.deleted && (file.originalContentAvailable === false || typeof file.originalContent !== 'string')) {
        throw conflict(`无法读取待删除文件的当前中心库正文: ${normalized}`, 'PRODUCT_DRAFT_ORIGINAL_CONTENT_UNAVAILABLE', { path: normalized })
      }
      const carriesContent = Object.prototype.hasOwnProperty.call(body, 'content')
        || Object.prototype.hasOwnProperty.call(body, 'finalContent')
        || Object.prototype.hasOwnProperty.call(body, 'originalContent')
      if (carriesContent) {
        const contentCandidates = [
          ...(Object.prototype.hasOwnProperty.call(body, 'finalContent') ? [text(body.finalContent)] : []),
          ...(Object.prototype.hasOwnProperty.call(body, 'content') ? [text(body.content)] : []),
          // A tombstone confirmation may echo the immutable original body
          // explicitly. This is never written back as the draft body.
          ...(Object.prototype.hasOwnProperty.call(body, 'originalContent') ? [text(body.originalContent)] : [])
        ]
        const content = contentCandidates[0] || ''
        if (file.deleted) {
          // A delete confirmation may include the body currently displayed by
          // the review page. It is an immutable echo of the original center
          // content, never an editable replacement for the tombstone.
          const originalAvailable = file.originalContentAvailable === true
            || (file.originalContentAvailable === undefined && typeof file.originalContent === 'string')
          if (!originalAvailable || typeof file.originalContent !== 'string') {
            throw conflict(`无法读取待删除文件的当前中心库正文: ${normalized}`, 'PRODUCT_DRAFT_ORIGINAL_CONTENT_UNAVAILABLE', { path: normalized })
          }
          if (!contentCandidates.some((candidate) => canonicalText(candidate) === canonicalText(file.originalContent))) {
            throw conflict(`文件未被选为可编辑范围: ${normalized}`, 'PRODUCT_FILE_NOT_EDITABLE')
          }
        } else {
          if (file.editable === false) throw conflict(`文件未被选为可编辑范围: ${normalized}`, 'PRODUCT_FILE_NOT_EDITABLE')
          await atomicBytes(productPath(productRoot, 'drafts', draft.draftId, 'files', ...normalized.split('/')), Buffer.from(content, 'utf8'), productPath(productRoot, 'drafts', draft.draftId))
          file.contentHash = contentHash(content)
          file.size = Buffer.byteLength(content, 'utf8')
        }
      }
      file.confirmed = bool(body?.confirmed, true)
      await saveDraft(productRoot, draft)
      await saveState()
      return publicDraft(draft)
    }
    if (method === 'POST' && pathname === '/draft/ai') {
      const draft = await readDraft(productRoot, body?.draftId)
      await assertDraftCenterContentAvailable(productRoot, state, draft)
      const result = await startChat(productRoot, state, executeTyped, host, body, draft)
      await saveState()
      return result
    }
    if (method === 'POST' && pathname === '/draft/commit') {
      const draft = await readDraft(productRoot, body?.draftId)
      const plan = state.plans[draft.planId]
      if (!plan) throw notFound(`library not found: ${draft.planId}`)
      if (draft.baseVersion && plan.currentVersion && draft.baseVersion !== plan.currentVersion) {
        throw conflict('中心库在草稿创建后已有新版本，请重新打开比较并审阅', 'PRODUCT_PLAN_STALE', { baseVersion: draft.baseVersion, currentVersion: plan.currentVersion })
      }
      const current = plan.currentVersion ? await versionManifest(productRoot, draft.planId, plan.currentVersion) : null
      if (current) {
        const contentCode = draft.files.some((file) => file.deleted)
          ? 'PRODUCT_DRAFT_ORIGINAL_CONTENT_UNAVAILABLE'
          : undefined
        await assertVersionBodiesAvailable(productRoot, draft.planId, plan.currentVersion, current, { code: contentCode })
      }
      if (!draft.files.length || !draft.files.every((file) => file.confirmed)) throw conflict('所有草稿文件确认后才能生成中心库新版本', 'PRODUCT_DRAFT_UNCONFIRMED', { unconfirmed: draft.files.filter((file) => !file.confirmed).map((file) => file.path) })
      const unavailableOriginals = draft.files.filter((file) => file.deleted && (
        file.originalContentAvailable === false
        || (file.originalContentAvailable === undefined && (!Object.prototype.hasOwnProperty.call(file, 'originalContent') || typeof file.originalContent !== 'string' || file.originalContent.length === 0))
      ))
      if (unavailableOriginals.length) throw conflict('待删除文件的当前中心库正文不可用，已阻止保存', 'PRODUCT_DRAFT_ORIGINAL_CONTENT_UNAVAILABLE', { paths: unavailableOriginals.map((file) => file.path) })
      const comparison = await readComparison(productRoot, draft.comparisonId).catch(() => null)
      const comparisonAnalysis = comparison?.analysisId ? await analysisManifest(productRoot, comparison.analysisId).catch(() => null) : null
      const nextNumber = Math.max(0, ...(plan.versions || []).map((item) => Number(String(item.versionId).replace(/^v/i, '')) || 0)) + 1
      const nextVersion = `v${nextNumber}`
      const createdAt = nowIso()
      const draftByPath = new Map(draft.files.map((file) => [file.path, file]))
      const nextFilesByPath = new Map((current?.files || []).map((file) => [file.path, { ...file }]))
      const draftContents = new Map()
      for (const file of draft.files) {
        if (file.deleted) {
          nextFilesByPath.delete(file.path)
          continue
        }
        const content = await draftContent(productRoot, draft, file.path)
        draftContents.set(file.path, content)
        nextFilesByPath.set(file.path, {
          path: file.path,
          logicalPath: file.logicalPath || file.path,
          storagePath: file.storagePath || file.path,
          contentHash: contentHash(content),
          size: Buffer.byteLength(content, 'utf8'),
          mode: file.mode || '100644',
          sourceSystemIds: file.sourceSystemIds || [],
          origins: file.origins || [],
          managed: file.managed !== false
        })
      }
      const persistedFiles = [...nextFilesByPath.values()].sort((left, right) => left.path.localeCompare(right.path))
      for (const file of persistedFiles) {
        const draftFile = draftByPath.get(file.path)
        const content = draftFile && !draftFile.deleted
          ? draftContents.get(file.path)
          : await versionRecordContent(productRoot, draft.planId, current.versionId, file)
        await atomicBytes(productPath(productRoot, 'library', draft.planId, 'versions', nextVersion, 'files', ...file.path.split('/')), Buffer.from(content, 'utf8'), productPath(productRoot, 'library', draft.planId))
      }
      const sourceSystems = [...(current?.sourceSystems || plan.sourceSystems || [])]
      const knownSourceSystems = new Set(sourceSystems.map((system) => system.id).filter(Boolean))
      for (const system of comparisonAnalysis?.systems || []) {
        if (!comparison?.selectedSystemIds?.includes(system.id) || knownSourceSystems.has(system.id)) continue
        sourceSystems.push(publicSystem(system, comparisonAnalysis.analysisId))
        knownSourceSystems.add(system.id)
      }
      const manifest = {
        schemaVersion: SCHEMA_VERSION,
        planId: draft.planId,
        versionId: nextVersion,
        createdAt,
        message: text(body?.message, draft.message || '审阅后合并'),
        sourceDraftId: draft.draftId,
        sourceAnalysisId: comparison?.analysisId || current?.sourceAnalysisId || null,
        sourceWorkspace: current?.sourceWorkspace || plan.sourceWorkspace,
        sourceSystems,
        files: persistedFiles.map((file) => ({
          path: file.path,
          logicalPath: file.logicalPath || file.path,
          storagePath: file.storagePath || file.path,
          contentHash: file.contentHash,
          size: file.size,
          mode: file.mode || '100644',
          sourceSystemIds: file.sourceSystemIds || [],
          origins: file.origins || [],
          managed: file.managed !== false
        }))
      }
      manifest.sourceSystems = authoritativeLibrarySystems(plan, manifest)
      await atomicJson(productPath(productRoot, 'library', draft.planId, 'versions', nextVersion, 'manifest.json'), manifest, productRoot)
      plan.currentVersion = nextVersion
      plan.updatedAt = createdAt
      plan.fileCount = manifest.files.length
      plan.skillCount = manifest.files.filter((file) => /(?:^|\/)SKILL\.md$/iu.test(file.path)).length
      plan.ruleCount = manifest.files.filter((file) => /^rules\//iu.test(file.path)).length
      plan.sourceAnalysisId = manifest.sourceAnalysisId || plan.sourceAnalysisId || null
      plan.sourceSystems = manifest.sourceSystems || plan.sourceSystems || []
      plan.versions = [...(plan.versions || []), { versionId: nextVersion, createdAt, message: manifest.message, fileCount: manifest.files.length, sourceDraftId: draft.draftId }]
      draft.status = 'committed'
      draft.committedVersion = nextVersion
      await saveDraft(productRoot, draft)
      const analysis = comparisonAnalysis
      const workspace = analysis
        ? observeWorkspace(state, analysis)
        : comparison?.sourceWorkspace ? state.workspaces[workspaceKey(comparison.sourceWorkspace)] : null
      if (workspace) {
        workspace.planId = draft.planId
        workspace.connectionMode = workspace.connectionMode || 'contributed'
        workspace.connectedVersion = nextVersion
        workspace.baselineVersion = nextVersion
        const currentSelectedIds = [...new Set((workspace.selectedSystemIds || []).filter(Boolean))]
        const comparisonSelectedIds = Array.isArray(comparison?.selectedSystemIds)
          ? [...new Set(comparison.selectedSystemIds.filter(Boolean))]
          : [...new Set((comparison?.selectedSystems || []).map((item) => item.id).filter(Boolean))]
        const selectedIds = currentSelectedIds.length ? currentSelectedIds : comparisonSelectedIds
        workspace.selectedSystemIds = selectedIds
        if (selectedIds.length) {
          const retainedRefs = selectionRefsForIds(workspace.selectedSystemRefs, selectedIds)
          const comparisonRefs = selectionRefsForIds(comparison?.selectedSystemRefs, selectedIds)
          const analysisRefs = analysis ? selectionRefsForSystems(analysis.systems, selectedIds) : []
          // A comparison's compact selectedSystems view is presentation data;
          // it is never allowed to replace a complete durable reference.
          if (retainedRefs.length === selectedIds.length) workspace.selectedSystemRefs = retainedRefs
          else if (comparisonRefs.length === selectedIds.length) workspace.selectedSystemRefs = comparisonRefs
          else if (analysisRefs.length === selectedIds.length) workspace.selectedSystemRefs = analysisRefs
        }
        if (analysis) {
          workspace.baselineSignature = analysisSignature(analysis, workspace.selectedSystemIds)
          workspace.baselineSafetySignature = analysisSafetySignature(analysis)
          workspace.observedSafetySignature = workspace.baselineSafetySignature
          workspace.observedSignature = workspace.baselineSignature
          workspace.lastAnalysisId = analysis.analysisId
          workspace.lastAnalyzedAt = analysis.createdAt
        }
        workspace.hasUpdates = false
        workspace.pendingAnalysisId = null
        workspace.pendingComparisonId = null
        workspace.pendingSummary = null
        workspace.connectionRecoveryRequired = false
        workspace.safetyBlocked = false
        workspace.status = workspaceStatus(workspace, false)
      }
      const commitReceipt = {
        status: 'committed',
        planId: draft.planId,
        versionId: nextVersion,
        draftId: draft.draftId,
        comparisonId: draft.comparisonId || null,
        origin: draft.origin || 'workspace-review',
        action: draft.action || 'edit',
        message: manifest.message,
        baseVersion: draft.baseVersion || null,
        fileCount: draft.files.length,
        createdAt,
        workspacePath: draft.origin === 'workspace-review' ? workspace?.workspacePath || comparison?.sourceWorkspace || null : null,
        immutable: true
      }
      const mergeReceipt = draft.origin === 'workspace-review' && workspace?.workspacePath
        ? {
          status: 'merged',
          planId: draft.planId,
          versionId: nextVersion,
          workspacePath: workspace.workspacePath,
          draftId: draft.draftId,
          fileCount: draft.files.length,
          createdAt
        }
        : null
      const persistedManifest = { ...manifest, commitReceipt, mergeReceipt }
      // The immutable version owns both receipts. Keep a dedicated sidecar
      // for readers that do not load the full manifest, while embedding the
      // same values in the manifest/draft/state recovery records.
      await atomicJson(commitReceiptPath(productRoot, draft.planId, nextVersion), commitReceipt, productRoot)
      if (mergeReceipt) await atomicJson(mergeReceiptPath(productRoot, draft.planId, nextVersion), mergeReceipt, productRoot)
      await atomicJson(productPath(productRoot, 'library', draft.planId, 'versions', nextVersion, 'manifest.json'), persistedManifest, productRoot)
      draft.commitReceipt = commitReceipt
      draft.mergeReceipt = mergeReceipt
      const versionEntry = plan.versions.at(-1)
      if (versionEntry) {
        versionEntry.commitReceipt = commitReceipt
        versionEntry.mergeReceipt = mergeReceipt
      }
      state.commitReceipts[`${draft.planId}:${nextVersion}`] = commitReceipt
      await saveDraft(productRoot, draft)
      // A center-only/manual commit is a distinct product operation. Never
      // leave a stale workspace merge receipt looking like this commit.
      state.mergeReceipt = mergeReceipt
      await saveState()
      return {
        plan: planPublic(plan, persistedManifest),
        version: persistedManifest,
        draft: publicDraft(draft),
        commitReceipt,
        mergeReceipt: mergeReceipt ? { ...mergeReceipt } : null
      }
    }
    if (method === 'POST' && pathname === '/version/rollback') {
      const result = await rollbackVersion(productRoot, state, body)
      await saveState()
      return result
    }
    if (method === 'POST' && pathname === '/version/rollback/preview') {
      const result = await buildRollbackPreview(productRoot, state, body)
      await saveState()
      return result
    }
    if (method === 'POST' && pathname === '/takeover/preview') {
      const preview = await buildTakeoverPreview(productRoot, state, body)
      await saveState()
      return preview
    }
    if (method === 'POST' && pathname === '/takeover/apply') {
      const result = await applyTakeover(productRoot, state, body)
      await saveState()
      return result
    }
    if (method === 'POST' && pathname === '/takeover/rollback') {
      const protectionId = requiredText(body?.protectionId, 'protectionId')
      const protection = await readJson(productPath(productRoot, 'protection', protectionId, 'manifest.json'), null)
      if (!protection) throw notFound(`protection not found: ${protectionId}`)
      const result = await rollbackProtection(productRoot, protection)
      const workspace = result.idempotent
        ? state.workspaces[workspaceKey(protection.worktreePath)] || null
        : restoreTakeoverWorkspaceState(state, protection)
      if (state.protections[protectionId]) state.protections[protectionId].status = result.status
      if (protection.postApplyAnalysisId && state.analyses[protection.postApplyAnalysisId]) {
        state.analyses[protection.postApplyAnalysisId] = {
          ...state.analyses[protection.postApplyAnalysisId],
          lifecycle: 'takeover-rolled-back-history',
          protectionId,
          rolledBackAt: protection.rolledBackAt || state.analyses[protection.postApplyAnalysisId].rolledBackAt || nowIso()
        }
      }
      await saveState()
      return { ...result, workspace: workspace ? publicWorkspace(workspace) : null, workspaceStateRestored: Boolean(protection.workspaceSnapshot) }
    }
    if (method === 'POST' && pathname === '/chat') {
      const sessionId = text(body?.sessionId)
      if (sessionId) {
        const message = requiredText(body?.message, 'message')
        const result = await executeCommand(executeTyped, host, 'resumeSession', { sessionId, message, runner: { start: true } })
        const session = result?.session || result
        if (!session?.id) throw serviceError(502, 'PRODUCT_SESSION_INVALID', 'resume response is missing an id')
        state.chats[session.id] = { ...(state.chats[session.id] || {}), sessionId: session.id, userMessage: message, createdAt: state.chats[session.id]?.createdAt || nowIso() }
        await saveState()
        return { session, chatId: session.id }
      }
      const result = await startChat(productRoot, state, executeTyped, host, body, null)
      await saveState()
      return result
    }
    if (method === 'GET' && pathname === '/chat/status') {
      const result = await chatStatus(productRoot, state, executeTyped, host, searchParams.get?.('sessionId') || searchParams.sessionId)
      if (result.synchronizedDraft) await saveState()
      return result
    }
    if (method === 'POST' && pathname === '/chat/cancel') {
      let sessionId = text(body?.sessionId).trim()
      const requestId = text(body?.requestId || body?.clientRequestId).trim()
      if (!sessionId && !requestId) throw bad('sessionId or requestId is required')
      let requestRecord = requestId ? state.aiRequests[requestId] : null
      if (!requestRecord && sessionId) {
        const chat = state.chats[sessionId]
        requestRecord = chat?.requestId ? state.aiRequests[chat.requestId] : null
        if (requestRecord && !requestId) sessionId = requestRecord.sessionId || sessionId
      }
      if (!requestRecord && requestId) {
        // A cancellation can arrive before /draft/ai has finished creating the
        // provider session. Leave a durable tombstone for the late response.
        requestRecord = { requestId, createdAt: nowIso() }
        state.aiRequests[requestId] = requestRecord
      }
      if (!requestRecord && sessionId) {
        const chat = state.chats[sessionId]
        const linkedRequestId = chat?.requestId || randomId('ai-request')
        requestRecord = state.aiRequests[linkedRequestId] || { requestId: linkedRequestId, createdAt: nowIso() }
        state.aiRequests[linkedRequestId] = requestRecord
        requestRecord.sessionId = sessionId
      }
      requestRecord.cancelRequested = true
      requestRecord.cancelledAt = nowIso()
      requestRecord.status = 'cancel-requested'
      if (!sessionId) sessionId = text(requestRecord.sessionId).trim()
      if (!sessionId) {
        await saveState()
        return { requestId: requestRecord.requestId, sessionId: null, status: 'cancel-requested', cancelled: true }
      }
      requestRecord.sessionId = sessionId
      if (state.chats[sessionId]) {
        state.chats[sessionId].cancelRequested = true
        state.chats[sessionId].cancelledAt = requestRecord.cancelledAt
      }
      const result = await cancelSessionForRecord(executeTyped, host, requestRecord)
      const session = result?.session || result
      requestRecord.status = 'cancelled'
      await saveState()
      return { requestId: requestRecord.requestId, sessionId, status: session?.status || 'cancelled', cancelled: true }
    }
    throw serviceError(404, 'PRODUCT_ROUTE_NOT_FOUND', `product route not found: ${method} ${pathname}`)
  }

  return { handle, isWriteRoute }
}
