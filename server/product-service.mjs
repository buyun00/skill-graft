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
 * POST /version/rollback
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

const execFileAsync = promisify(execFile)

const SCHEMA_VERSION = 1
const MAX_ANALYSIS_DEPTH = 8
const MAX_ANALYSIS_ENTRIES = 150000
const MAX_ANALYSIS_FILE_BYTES = 4 * 1024 * 1024
const MAX_INLINE_BYTES = 256 * 1024
const MAX_CHAT_BYTES = 128 * 1024
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
const CACHE_NAMES = /(?:cache|backup|pre-hub-)/iu
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
  if (CACHE_NAMES.test(path.basename(relative))) return { status: 'reference-only', kind: 'cache' }
  return { status: 'active', kind: 'active' }
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
        if (CACHE_NAMES.test(entry.name)) {
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
    if (linked && real && visitedReal.has(real)) return
    if (linked && real) visitedReal.add(real)
    if (stat.isDirectory()) {
      if (linked && external) {
        collected.push({ path: relative, type: 'directory-alias', canonicalTarget: real, referenceOnly: true })
        return
      }
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

async function nestedFamilyRoots(absolute) {
  const entries = await fsp.readdir(absolute, { withFileTypes: true }).catch(() => [])
  const roots = []
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    if (/^unity-skills$/iu.test(entry.name)) roots.push(entry.name)
    else {
      const nested = await fsp.readdir(path.join(absolute, entry.name), { withFileTypes: true }).catch(() => [])
      if (nested.some((item) => (item.isDirectory() || item.isSymbolicLink()) && /^skills$/iu.test(item.name))) roots.push(entry.name)
    }
  }
  return roots
}

async function directoryHasSkillFile(absolute, maxDepth = 5) {
  async function walk(current, depth) {
    if (depth > maxDepth) return false
    const entries = await fsp.readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isFile() && /^SKILL\.md$/iu.test(entry.name)) return true
      if (entry.isDirectory() && !entry.isSymbolicLink() && !SKIP_DIRS.has(entry.name) && await walk(path.join(current, entry.name), depth + 1)) return true
    }
    return false
  }
  return walk(absolute, 0)
}

async function analyzeWorkspaceReadOnly(workspaceInput, productRoot) {
  const supplied = requiredText(workspaceInput, 'workspacePath')
  const resolved = path.resolve(supplied)
  const stat = await lstatOrNull(resolved)
  if (!stat || !stat.isDirectory()) throw bad('workspacePath must be an existing directory', 'PRODUCT_WORKSPACE_INVALID')
  const canonicalWorkspace = await fsp.realpath(resolved).catch(() => resolved)
  const analysisId = randomId('analysis')
  const analysisDir = productPath(productRoot, 'analyses', analysisId)
  const analysisFiles = productPath(analysisDir, 'files')
  await fsp.mkdir(analysisFiles, { recursive: true })
  const dirtyPaths = await gitDirtyPaths(canonicalWorkspace)
  const systems = new Map()
  const systemCandidates = []

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
        const nested = await nestedFamilyRoots(childAbsolute)
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
    if (!await directoryHasSkillFile(workspacePath(canonicalWorkspace, relative))) continue
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
  if (cacheEvidence.size) {
    const cacheSystem = addSystem(systems, 'evidence/cache', '缓存与备份', 'cache', 'reference-only', null)
    for (const relative of [...cacheEvidence].sort()) {
      cacheSystem.projections.push({
        host: 'cache', path: relative, canonicalTarget: path.resolve(canonicalWorkspace, relative), projection: 'cache'
      })
      systemCandidates.push({ system: cacheSystem, relative, mode: 'reference-only', evidenceOnly: true })
    }
  }

  for (const candidate of systemCandidates) {
    const files = candidate.evidenceOnly
      ? [{ id: fileId(candidate.relative), path: candidate.relative, logicalPath: candidate.relative, physicalPath: candidate.relative, sourcePath: path.resolve(canonicalWorkspace, candidate.relative), size: 0, contentHash: null, canonicalTarget: path.resolve(canonicalWorkspace, candidate.relative), alias: false, external: false, stored: false, referenceOnly: true, evidenceOnly: true }]
      : await inspectSystemFiles(canonicalWorkspace, candidate.relative, candidate.mode, analysisFiles, { excludeRoots: candidate.excludeRoots })
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
      declaredMissing: [...systems.values()].filter((item) => !item.hidden && item.kind === 'declared-missing').length
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
    chats: {}
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
    chats: raw.chats && typeof raw.chats === 'object' ? raw.chats : {}
  }
}

function workspaceKey(workspacePath) {
  return portableKey(path.resolve(workspacePath))
}

function analysisSignature(analysis, selectedSystemIds = []) {
  const selected = new Set(Array.isArray(selectedSystemIds) ? selectedSystemIds : [])
  const systems = (analysis?.systems || [])
    .filter((system) => !system.hidden && system.selectable !== false && (selected.size === 0 ? system.status === 'active' : selected.has(system.id)))
    .map((system) => ({ id: system.id, hash: system.contentHash, files: system.fileCount }))
    .sort((a, b) => a.id.localeCompare(b.id))
  return hashJson(systems)
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
    protectionId: workspace.protectionId || null,
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
  const observed = analysisSignature(analysis, current.selectedSystemIds)
  current.workspacePath = analysis.workspacePath
  current.workspaceName = analysis.workspaceName
  current.lastAnalysisId = analysis.analysisId
  current.lastAnalyzedAt = analysis.createdAt
  current.observedSignature = observed
  if (current.baselineSignature && current.baselineSignature !== observed) {
    current.hasUpdates = true
  current.pendingAnalysisId = analysis.analysisId
    current.pendingSummary = analysis.summary
    current.status = current.connectionMode ? 'connected-with-updates' : 'observed-with-updates'
  } else if (!current.baselineSignature) {
    current.hasUpdates = false
  } else {
    current.hasUpdates = false
    current.pendingAnalysisId = null
    current.pendingSummary = null
    current.status = current.connectionMode ? 'connected' : 'observed'
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
    projectionConflicts: system.projectionConflicts || [],
    projections: system.projections,
    files: system.files.map((file) => ({
      id: file.id,
      path: file.logicalPath || file.path,
      logicalPath: file.logicalPath || file.path,
      physicalPath: file.physicalPath || file.path,
      sourcePath: file.sourcePath,
      size: file.size,
      contentHash: file.contentHash,
      stored: file.stored,
      referenceOnly: file.referenceOnly,
      alias: file.alias,
      canonicalTarget: file.canonicalTarget,
      dormant: file.dormant || false,
      projectionPaths: file.projectionPaths || [],
      projectionConflicts: file.projectionConflicts || [],
      dirty: Boolean(file.dirty)
    }))
  }
}

function publicAnalysis(manifest) {
  return {
    analysisId: manifest.analysisId,
    workspacePath: manifest.workspacePath,
    workspaceName: manifest.workspaceName,
    createdAt: manifest.createdAt,
    summary: manifest.summary,
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
  const selected = body?.selectedSystems ?? body?.systemIds ?? []
  if (!Array.isArray(selected)) throw bad('selectedSystems must be an array')
  return [...new Set(selected.map((value) => requiredText(value, 'selected system id')))]
}

function currentVersionOf(plan) {
  return plan?.currentVersion || null
}

async function buildComparison(productRoot, state, body) {
  const planId = requiredText(body?.planId, 'planId')
  const analysisId = requiredText(body?.analysisId, 'analysisId')
  const plan = state.plans[planId]
  if (!plan) throw notFound(`library not found: ${planId}`)
  const analysis = await analysisManifest(productRoot, analysisId)
  const selectedIds = selectedSystemIds(body)
  const includePrivate = bool(body?.includePrivate)
  const selected = analysis.systems.filter((system) => selectedIds.includes(system.id))
  if (selected.length !== selectedIds.length) throw bad('one or more systems are not in the analysis')
  const evidenceOnly = selected.filter((system) => system.selectable === false)
  if (evidenceOnly.length) throw conflict('缓存、规则、休眠和其他证据不能直接作为中心库体系', 'PRODUCT_EVIDENCE_NOT_SELECTABLE', { systems: evidenceOnly.map((item) => ({ id: item.id, name: item.name })) })
  const blocked = selected.filter((system) => system.status === 'keep-private' || system.status === 'reference-only')
  if (blocked.length > 0 && !includePrivate) {
    throw conflict('private/reference systems require explicit inclusion', 'PRODUCT_PROTECTED_SYSTEM', {
      systems: blocked.map((item) => ({ id: item.id, name: item.name, status: item.status }))
    })
  }
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
      if (!prior) selectedFiles.set(logicalPath, { ...file, path: logicalPath, logicalPath, storedPath: file.physicalPath || file.path, sourceSystemIds: [system.id] })
      else prior.sourceSystemIds = [...new Set([...prior.sourceSystemIds, system.id])]
    }
  }
  const baseVersion = currentVersionOf(plan) ? await versionManifest(productRoot, planId, plan.currentVersion) : null
  const baseByPath = new Map((baseVersion?.files || []).map((file) => [file.path, file]))
  const desiredByPath = new Map()
  for (const file of baseVersion?.files || []) desiredByPath.set(file.path, { ...file, contentSource: { kind: 'version', versionId: plan.currentVersion } })
  for (const file of selectedFiles.values()) desiredByPath.set(file.path, { ...file, contentSource: { kind: 'analysis', analysisId, storedPath: file.storedPath || file.physicalPath || file.path } })
  const files = []
  // A comparison is scoped to the systems the user selected. Files belonging
  // to unrelated systems in the current library remain untouched; they are
  // not deletions merely because the incoming projection did not include them.
  // `sourceSystemIds` belong to one analysis snapshot.  They are therefore
  // not stable identifiers across worktrees (or even across two analyses of
  // the same worktree).  Filtering the base by those IDs makes an unchanged
  // logical file look like an addition whenever the incoming projection has
  // a different physical root/system id.  The comparison is already scoped
  // by `touched` below, so resolve the old side by its canonical logical path
  // only.  This also keeps existing v1 manifests usable after re-analysis.
  const relevantBaseByPath = baseByPath
  // Missing incoming paths are not treated as deletions in the default flow.
  // A selected projection can be partial, and deleting center-library content
  // requires a separate explicit destructive review that this product layer
  // does not currently expose.
  const touched = new Set(selectedFiles.keys())
  for (const relative of [...touched].sort()) {
    const oldRecord = relevantBaseByPath.get(relative) || null
    const newRecord = selectedFiles.get(relative) || null
    const oldContent = oldRecord ? await versionRecordContent(productRoot, planId, plan.currentVersion, oldRecord) : ''
    const newContent = newRecord ? await analysisFileContent(productRoot, analysisId, relative, newRecord.storedPath || newRecord.physicalPath || newRecord.path) : ''
    const changed = Boolean(oldRecord) !== Boolean(newRecord) || canonicalText(oldContent) !== canonicalText(newContent)
    if (!changed) continue
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
      sourceSystemIds: newRecord?.sourceSystemIds || oldRecord?.sourceSystemIds || [],
      managed: true,
      contentSource: newRecord ? { kind: 'analysis', analysisId, storedPath: newRecord.storedPath || newRecord.physicalPath || newRecord.path } : null
    })
  }
  const comparisonId = randomId('comparison')
  const comparison = {
    schemaVersion: SCHEMA_VERSION,
    comparisonId,
    planId,
    analysisId,
    sourceWorkspace: analysis.workspacePath,
    baseVersion: plan.currentVersion || null,
    selectedSystems: selected.map((system) => ({ id: system.id, name: system.name, status: system.status })),
    createdAt: nowIso(),
    summary: {
      changedFiles: files.length,
      added: files.filter((file) => file.changeType === 'added').length,
      modified: files.filter((file) => file.changeType === 'modified').length,
      deleted: files.filter((file) => file.changeType === 'deleted').length
    },
    files,
    desiredFiles: [...desiredByPath.values()].map((file) => ({
      path: file.path,
      contentHash: file.contentHash,
      size: file.size,
      mode: file.mode || '100644',
      sourceSystemIds: file.sourceSystemIds || [],
      managed: file.managed !== false,
      contentSource: file.contentSource
    }))
  }
  await atomicJson(productPath(productRoot, 'comparisons', comparisonId, 'manifest.json'), comparison, productRoot)
  state.comparisons[comparisonId] = { comparisonId, planId, analysisId, createdAt: comparison.createdAt, dir: `comparisons/${comparisonId}` }
  return comparison
}

async function readComparison(productRoot, comparisonId) {
  const value = await readJson(productPath(productRoot, 'comparisons', requiredText(comparisonId, 'comparisonId'), 'manifest.json'), null)
  if (!value) throw notFound(`comparison not found: ${comparisonId}`)
  return value
}

async function buildVersionComparison(productRoot, state, body) {
  const planId = requiredText(body?.planId, 'planId')
  const fromVersion = requiredText(body?.fromVersion || body?.baseVersion, 'fromVersion')
  const toVersion = requiredText(body?.toVersion || body?.versionId, 'toVersion')
  if (!state.plans[planId]) throw notFound(`library not found: ${planId}`)
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
  const draftId = randomId('draft')
  const requestedPaths = Array.isArray(body?.paths)
    ? new Set(body.paths.map((item) => normalizeRelative(item)).filter(Boolean))
    : null
  const comparisonPaths = Array.isArray(comparison.files)
    ? new Set(comparison.files.map((item) => normalizeRelative(item?.path)).filter(Boolean))
    : null
  const reviewPaths = requestedPaths || comparisonPaths
  const draft = {
    schemaVersion: SCHEMA_VERSION,
    draftId,
    planId: comparison.planId,
    comparisonId: comparison.comparisonId,
    baseVersion: comparison.baseVersion,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    status: 'editing',
    editablePaths: reviewPaths ? [...reviewPaths] : null,
    files: []
  }
  for (const desired of comparison.desiredFiles) {
    let content = ''
    if (desired.contentSource?.kind === 'version') {
      content = await versionContent(productRoot, comparison.planId, desired.contentSource.versionId, desired.storagePath || desired.path)
    } else if (desired.contentSource?.kind === 'analysis') {
      content = await analysisFileContent(productRoot, desired.contentSource.analysisId, desired.path, desired.contentSource.storedPath || desired.path)
    }
    const target = productPath(productRoot, 'drafts', draftId, 'files', ...desired.path.split('/'))
    await atomicBytes(target, Buffer.from(content, 'utf8'), productPath(productRoot, 'drafts', draftId))
    draft.files.push({
      path: desired.path,
      contentHash: contentHash(content),
      size: Buffer.byteLength(content, 'utf8'),
      sourceSystemIds: desired.sourceSystemIds || [],
      managed: desired.managed !== false,
      editable: reviewPaths ? reviewPaths.has(desired.path) : true,
      confirmed: reviewPaths ? !reviewPaths.has(desired.path) : false
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
    files.push({ ...file, content: preview.value, finalContent: preview.value, truncated })
    remaining -= Buffer.byteLength(preview.value, 'utf8')
    if (!selected && remaining <= 0) break
  }
  return { ...publicDraft(draft), files, file: selected ? files[0] || null : undefined }
}

async function saveDraft(productRoot, draft) {
  draft.updatedAt = nowIso()
  await atomicJson(productPath(productRoot, 'drafts', draft.draftId, 'manifest.json'), draft, productRoot)
}

function planPublic(plan) {
  return {
    planId: plan.planId,
    name: plan.name,
    sourceWorkspace: plan.sourceWorkspace,
    currentVersion: plan.currentVersion,
    skillCount: plan.skillCount || 0,
    ruleCount: plan.ruleCount || 0,
    fileCount: plan.fileCount || 0,
    versions: plan.versions,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt
  }
}

async function initializeLibrary(productRoot, state, body) {
  const analysis = await analysisManifest(productRoot, body?.analysisId)
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
        managed: true
      }
      files.push(record)
      seen.set(logicalPath, record)
    }
  }
  if (!files.length) throw bad('selected systems contain no copyable files', 'PRODUCT_EMPTY_LIBRARY')
  const manifest = { schemaVersion: SCHEMA_VERSION, planId, versionId, createdAt, message: text(body?.message, '首次选择的中心库'), sourceAnalysisId: analysis.analysisId, sourceWorkspace: analysis.workspacePath, files: files.sort((a, b) => a.path.localeCompare(b.path)) }
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
  workspace.selectedSystemIds = selected.map((item) => item.id)
  workspace.baselineSignature = analysisSignature(analysis, workspace.selectedSystemIds)
  workspace.observedSignature = workspace.baselineSignature
  workspace.hasUpdates = false
  workspace.pendingAnalysisId = null
  workspace.pendingSummary = null
  workspace.status = 'connected'
  return { plan: planPublic(plan), version: manifest, selectedSystems: selected.map((item) => publicSystem(item, analysis.analysisId)), workspace: publicWorkspace(workspace) }
}

async function readLibrary(productRoot, state, body) {
  const planId = text(body?.planId, state.activePlanId)
  const plans = Object.values(state.plans).map(planPublic)
  if (!planId) return { activePlanId: null, plans }
  const plan = state.plans[planId]
  if (!plan) throw notFound(`library not found: ${planId}`)
  const current = plan.currentVersion ? await versionManifest(productRoot, planId, plan.currentVersion) : null
  return { activePlanId: state.activePlanId, plan: planPublic(plan), current }
}

async function readLibraryFile(productRoot, state, searchParams) {
  const relative = requiredText(searchParams?.get?.('path') || searchParams?.path, 'path')
  const draftId = text(searchParams?.get?.('draftId') || searchParams?.draftId)
  if (draftId) {
    const draft = await readDraft(productRoot, draftId)
    return { draftId, path: normalizeRelative(relative), content: await draftContent(productRoot, draft, relative) }
  }
  const planId = requiredText(searchParams?.get?.('planId') || searchParams?.planId, 'planId')
  const plan = state.plans[planId]
  if (!plan?.currentVersion) throw notFound(`library not found: ${planId}`)
  const versionId = text(searchParams?.get?.('version') || searchParams?.version, plan.currentVersion)
  const current = await versionManifest(productRoot, planId, versionId)
  const logicalPath = canonicalVersionPath(relative)
  const record = (current.files || []).find((item) => item.path === logicalPath)
  if (!record) throw notFound(`file not found: ${logicalPath}`)
  return { planId, versionId, path: logicalPath, content: await versionRecordContent(productRoot, planId, versionId, record) }
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

async function startChat(productRoot, state, executeTyped, host, body, draft) {
  const message = requiredText(body?.message || body?.intent, 'message')
  const selectedFiles = draft ? (Array.isArray(body?.selectedFiles) ? body.selectedFiles.map((file) => normalizeRelative(file)).filter(Boolean) : []) : []
  if (draft && selectedFiles.length === 0) throw bad('select at least one draft file for AI')
  if (draft) {
    const known = new Set(draft.files.map((file) => file.path))
    if (selectedFiles.some((file) => !known.has(file))) throw bad('AI selection contains an unknown draft file')
    if (selectedFiles.some((file) => draft.files.find((item) => item.path === file)?.editable === false)) {
      throw conflict('AI 只能处理被选为可编辑的文件', 'PRODUCT_FILE_NOT_EDITABLE')
    }
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
    : message
  const sessionData = await executeCommand(executeTyped, host, 'chat', {
    intent,
    ...(aiScopeRoot ? { worktree: aiScopeRoot } : {}),
    runner: { start: true }
  })
  const session = sessionData?.session || sessionData
  if (!session?.id) throw serviceError(502, 'PRODUCT_SESSION_INVALID', 'chat session response is missing an id')
  state.chats[session.id] = {
    sessionId: session.id,
    draftId: draft?.draftId || null,
    selectedFiles,
    aiScopeId,
    userMessage: message,
    createdAt: nowIso()
  }
  return { session, chatId: session.id, draftId: draft?.draftId || null }
}

async function synchronizeAiDraft(productRoot, state, session, record) {
  if (!record?.draftId || !record.aiScopeId || record.importedAt || session?.status !== 'completed') return false
  const draft = await readDraft(productRoot, record.draftId)
  const scopeRoot = productPath(productRoot, 'ai-scopes', record.aiScopeId)
  for (const relative of record.selectedFiles || []) {
    const normalized = normalizeRelative(relative)
    const file = draft.files.find((item) => item.path === normalized && item.editable !== false)
    if (!normalized || !file) continue
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
  const synchronizedDraft = await synchronizeAiDraft(productRoot, state, session, record)
  return {
    session: {
      id: session.id,
      kind: session.kind,
      status: session.status,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      canResume: session.canResume,
      canCancel: session.capabilities?.canCancel || false,
      error: session.error || ''
    },
    userMessage: record?.userMessage || '',
    assistantMessage: await lastAssistantMessage(host, session),
    draftId: record?.draftId || null,
    selectedFiles: record?.selectedFiles || [],
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
  const operations = []
  for (const record of manifest.files) {
    if (record.managed === false) continue
    const relative = normalizeRelative(record.path)
    if (!relative) continue
    const targetRelative = await logicalTargetPath(canonicalRoot, relative, body?.targetProjection)
    const target = workspacePath(canonicalRoot, targetRelative)
    const current = await readSmallFile(target)
    const action = !current.exists ? 'create' : current.hash === record.contentHash ? 'keep' : 'update'
    operations.push({ path: relative, targetPath: targetRelative, action, dirty: dirtyPaths.has(targetRelative), beforeExists: current.exists, beforeHash: current.hash, afterHash: record.contentHash, size: record.size, managed: true })
  }
  const changed = operations.filter((operation) => operation.action !== 'keep')
  const preview = {
    schemaVersion: SCHEMA_VERSION,
    previewId: randomId('takeover-preview'),
    planId,
    versionId,
    worktreePath: canonicalRoot,
    targetProjection: text(body?.targetProjection, ''),
    createdAt: nowIso(),
    planHash: hashJson({ planId, versionId, worktreePath: canonicalRoot, operations }),
    operations,
    summary: { changed: changed.length, create: changed.filter((item) => item.action === 'create').length, update: changed.filter((item) => item.action === 'update').length, keep: operations.length - changed.length },
    requiresExplicit: operations.some((operation) => operation.dirty),
    dirtyFiles: operations.filter((operation) => operation.dirty).map((operation) => operation.path),
    preserve: ['未知文件不动', '项目私有 Skill 不动', '未列入中心库版本的文件不动']
  }
  await atomicJson(productPath(productRoot, 'takeovers', preview.previewId, 'preview.json'), preview, productRoot)
  state.takeovers[preview.previewId] = { previewId: preview.previewId, planId, versionId, worktreePath: canonicalRoot, createdAt: preview.createdAt, planHash: preview.planHash }
  return preview
}

async function readTakeoverPreview(productRoot, previewId) {
  const value = await readJson(productPath(productRoot, 'takeovers', requiredText(previewId, 'previewId'), 'preview.json'), null)
  if (!value) throw notFound(`takeover preview not found: ${previewId}`)
  return value
}

async function applyTakeover(productRoot, state, body) {
  const preview = await readTakeoverPreview(productRoot, body?.previewId)
  if (body?.planHash && body.planHash !== preview.planHash) throw conflict('takeover preview is stale', 'PRODUCT_PLAN_STALE')
  if (preview.requiresExplicit && !bool(body?.confirmDirty)) {
    throw conflict('接管会覆盖工作树中的用户脏改，请预览并明确确认', 'PRODUCT_DIRTY_REQUIRES_CONFIRM', { dirtyFiles: preview.dirtyFiles || [] })
  }
  const root = preview.worktreePath
  const currentPreview = await buildTakeoverPreview(productRoot, state, { planId: preview.planId, versionId: preview.versionId, worktreePath: root, targetProjection: preview.targetProjection })
  if (currentPreview.planHash !== preview.planHash) throw conflict('worktree changed after preview; analyze again', 'PRODUCT_PLAN_STALE', { previewId: preview.previewId })
  const protectionId = randomId('protection')
  const protectionRoot = productPath(productRoot, 'protection', protectionId)
  const projectionRootsBefore = {}
  for (const prefix of TAKEOVER_PROJECTION_ROOTS) {
    projectionRootsBefore[prefix.join('/')] = Boolean(await lstatOrNull(path.resolve(root, ...prefix)))
  }
  const protection = { schemaVersion: SCHEMA_VERSION, protectionId, previewId: preview.previewId, planId: preview.planId, versionId: preview.versionId, worktreePath: root, createdAt: nowIso(), status: 'prepared', projectionRootsBefore, files: [] }
  const manifest = await versionManifest(productRoot, preview.planId, preview.versionId)
  try {
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
      const content = await versionRecordContent(productRoot, preview.planId, preview.versionId, record)
      if (!record) throw serviceError(500, 'PRODUCT_STATE_INVALID', `version file disappeared: ${operation.path}`)
      await safeExternalWrite(workspacePath(root, operation.targetPath || operation.path), Buffer.from(content, 'utf8'), root)
    }
    protection.status = 'applied'
    protection.appliedAt = nowIso()
    await atomicJson(productPath(protectionRoot, 'manifest.json'), protection, productRoot)
    state.protections[protectionId] = { protectionId, previewId: preview.previewId, planId: preview.planId, versionId: preview.versionId, worktreePath: root, status: protection.status, createdAt: protection.createdAt }
    const workspaceId = workspaceKey(root)
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
    workspace.connectionMode = 'takeover'
    workspace.protectionId = protectionId
    workspace.status = 'connected'
    workspace.hasUpdates = false
    workspace.pendingAnalysisId = null
    workspace.pendingComparisonId = null
    workspace.pendingSummary = null
    state.workspaces[workspaceId] = workspace
    return { protectionId, previewId: preview.previewId, status: 'applied', summary: preview.summary, preserve: preview.preserve, workspace: publicWorkspace(workspace) }
  } catch (error) {
    await rollbackProtection(productRoot, protection).catch(() => {})
    throw error
  }
}

async function rollbackProtection(productRoot, protection) {
  const root = protection.worktreePath
  const rootResolved = path.resolve(root)
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
      if (currentParts.length === boundary && projectionExistedBefore !== false) break
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
        await cleanCreatedParents(entry.targetPath || entry.path)
      }
    }
  }
  protection.status = 'rolled-back'
  protection.rolledBackAt = nowIso()
  await atomicJson(productPath(productRoot, 'protection', protection.protectionId, 'manifest.json'), protection, productRoot)
  return { protectionId: protection.protectionId, status: protection.status, worktreePath: root }
}

async function rollbackVersion(productRoot, state, body) {
  const planId = requiredText(body?.planId, 'planId')
  const plan = state.plans[planId]
  if (!plan?.currentVersion) throw notFound(`library not found: ${planId}`)
  const sourceVersion = text(body?.versionId, body?.version)
  if (!sourceVersion) throw bad('versionId is required')
  const source = await versionManifest(productRoot, planId, sourceVersion)
  const nextNumber = Math.max(0, ...(plan.versions || []).map((item) => Number(String(item.versionId).replace(/^v/i, '')) || 0)) + 1
  const nextVersion = `v${nextNumber}`
  const createdAt = nowIso()
  const rollbackFiles = []
  for (const file of source.files) {
    const content = await versionRecordContent(productRoot, planId, sourceVersion, file)
    await atomicBytes(productPath(productRoot, 'library', planId, 'versions', nextVersion, 'files', ...file.path.split('/')), Buffer.from(content, 'utf8'), productPath(productRoot, 'library', planId))
    rollbackFiles.push({ ...file, path: file.path, logicalPath: file.path, storagePath: file.path })
  }
  const manifest = { ...source, versionId: nextVersion, createdAt, message: text(body?.message, `从 ${sourceVersion} 回滚创建`), rollbackOf: sourceVersion, files: rollbackFiles }
  await atomicJson(productPath(productRoot, 'library', planId, 'versions', nextVersion, 'manifest.json'), manifest, productRoot)
  plan.currentVersion = nextVersion
  plan.updatedAt = createdAt
  plan.fileCount = manifest.files.length
  plan.skillCount = manifest.files.filter((file) => /(?:^|\/)SKILL\.md$/iu.test(file.path)).length
  plan.ruleCount = manifest.files.filter((file) => /^rules\//iu.test(file.path)).length
  plan.versions = [...(plan.versions || []), { versionId: nextVersion, createdAt, message: manifest.message, fileCount: manifest.files.length, rollbackOf: sourceVersion }]
  return { plan: planPublic(plan), version: manifest, status: 'created-from-rollback' }
}

async function logicalTargetPath(worktreeRoot, logicalPath, requestedProjection) {
  const normalized = normalizeRelative(logicalPath)
  if (!normalized) throw bad(`unsafe logical path: ${logicalPath}`, 'PRODUCT_PATH_ESCAPE')
  const parts = normalized.split('/')
  if (parts[0].toLocaleLowerCase('en-US') === 'skills') {
    const rest = parts.slice(1).join('/')
    const requested = text(requestedProjection).trim().replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '')
    if (requested && !normalizeRelative(requested)) throw bad('targetProjection is unsafe', 'PRODUCT_PATH_ESCAPE')
    const candidates = requested
      ? [requested]
      : ['.agents/skills', '.claude/skills', '.cursor/skills', '.codex/skills', 'skills']
    for (const candidate of candidates) {
      const root = normalizeRelative(candidate)
      if (!root) continue
      const stat = await lstatOrNull(workspacePath(worktreeRoot, root))
      if (stat?.isDirectory()) return rest ? `${root}/${rest}` : root
    }
    return rest ? `skills/${rest}` : 'skills'
  }
  if (parts[0].toLocaleLowerCase('en-US') === 'rules') return parts.slice(1).join('/') || 'AGENTS.md'
  return normalized
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
      '/pick-folder', '/analyze', '/workspace/check', '/library/initialize', '/library/draft', '/compare', '/version/compare',
      '/draft/file', '/draft/confirm', '/draft/ai', '/draft/commit', '/version/rollback',
      '/takeover/preview', '/takeover/apply', '/takeover/rollback', '/chat'
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
        timeout: 120000,
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
      const plans = Object.values(state.plans).map(planPublic)
      const pendingDrafts = Object.keys(state.drafts).length
      const analyses = Object.keys(state.analyses).length
      const workspaces = Object.values(state.workspaces).map(publicWorkspace)
      return {
        activePlanId: state.activePlanId,
        plans,
        libraryCount: plans.length,
        skillCount: plans.reduce((sum, plan) => sum + (plan.skillCount || 0), 0),
        pendingUpdates: workspaces.filter((workspace) => workspace.hasUpdates).length,
        workspaces,
        pendingDrafts,
        analyses,
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
    if (method === 'POST' && pathname === '/compare') {
      const comparison = body?.fromVersion && body?.toVersion
        ? await buildVersionComparison(productRoot, state, body)
        : await buildComparison(productRoot, state, body)
      if (comparison.sourceWorkspace) {
        const analysis = comparison.analysisId ? await analysisManifest(productRoot, comparison.analysisId) : null
        const workspace = analysis ? observeWorkspace(state, analysis) : state.workspaces[workspaceKey(comparison.sourceWorkspace)]
        if (workspace) {
          workspace.planId = comparison.planId
          workspace.pendingComparisonId = comparison.comparisonId
          workspace.pendingAnalysisId = comparison.analysisId || workspace.pendingAnalysisId || null
          workspace.pendingSummary = comparison.summary
          workspace.hasUpdates = true
        }
      }
      await saveState()
      return { comparisonId: comparison.comparisonId, planId: comparison.planId, analysisId: comparison.analysisId, sourceWorkspace: comparison.sourceWorkspace, baseVersion: comparison.baseVersion, targetVersion: comparison.targetVersion || null, selectedSystems: comparison.selectedSystems, summary: comparison.summary, files: comparison.files }
    }
    if (method === 'POST' && pathname === '/version/compare') {
      const comparison = await buildVersionComparison(productRoot, state, body)
      await saveState()
      return { comparisonId: comparison.comparisonId, planId: comparison.planId, baseVersion: comparison.baseVersion, targetVersion: comparison.targetVersion, summary: comparison.summary, files: comparison.files }
    }
    if (method === 'GET' && pathname === '/comparison') {
      const comparison = await readComparison(productRoot, searchParams.get?.('comparisonId') || searchParams.comparisonId)
      return comparison
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
      const relative = requiredText(body?.path, 'path')
      const normalized = normalizeRelative(relative)
      if (!normalized) throw bad('draft file path is unsafe', 'PRODUCT_PATH_ESCAPE')
      if (!draft.files.some((file) => file.path === normalized)) throw notFound(`draft file not found: ${normalized}`)
      const draftRecord = draft.files.find((file) => file.path === normalized)
      if (draftRecord.editable === false) throw conflict(`文件未被选为可编辑范围: ${normalized}`, 'PRODUCT_FILE_NOT_EDITABLE')
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
      const normalized = normalizeRelative(requiredText(body?.path, 'path'))
      const file = draft.files.find((item) => item.path === normalized)
      if (!file) throw notFound(`draft file not found: ${normalized}`)
      file.confirmed = bool(body?.confirmed, true)
      await saveDraft(productRoot, draft)
      await saveState()
      return publicDraft(draft)
    }
    if (method === 'POST' && pathname === '/draft/ai') {
      const draft = await readDraft(productRoot, body?.draftId)
      const result = await startChat(productRoot, state, executeTyped, host, body, draft)
      await saveState()
      return result
    }
    if (method === 'POST' && pathname === '/draft/commit') {
      const draft = await readDraft(productRoot, body?.draftId)
      if (!draft.files.length || !draft.files.every((file) => file.confirmed)) throw conflict('所有草稿文件确认后才能生成中心库新版本', 'PRODUCT_DRAFT_UNCONFIRMED', { unconfirmed: draft.files.filter((file) => !file.confirmed).map((file) => file.path) })
      const plan = state.plans[draft.planId]
      if (!plan) throw notFound(`library not found: ${draft.planId}`)
      const current = plan.currentVersion ? await versionManifest(productRoot, draft.planId, plan.currentVersion) : null
      const nextNumber = Math.max(0, ...(plan.versions || []).map((item) => Number(String(item.versionId).replace(/^v/i, '')) || 0)) + 1
      const nextVersion = `v${nextNumber}`
      const createdAt = nowIso()
      for (const file of draft.files) {
        const content = await draftContent(productRoot, draft, file.path)
        await atomicBytes(productPath(productRoot, 'library', draft.planId, 'versions', nextVersion, 'files', ...file.path.split('/')), Buffer.from(content, 'utf8'), productPath(productRoot, 'library', draft.planId))
      }
      const manifest = { schemaVersion: SCHEMA_VERSION, planId: draft.planId, versionId: nextVersion, createdAt, message: text(body?.message, '审阅后合并'), sourceDraftId: draft.draftId, files: draft.files.map((file) => ({ ...file })) }
      await atomicJson(productPath(productRoot, 'library', draft.planId, 'versions', nextVersion, 'manifest.json'), manifest, productRoot)
      plan.currentVersion = nextVersion
      plan.updatedAt = createdAt
      plan.fileCount = manifest.files.length
      plan.skillCount = manifest.files.filter((file) => /(?:^|\/)SKILL\.md$/iu.test(file.path)).length
      plan.ruleCount = manifest.files.filter((file) => /^rules\//iu.test(file.path)).length
      plan.versions = [...(plan.versions || []), { versionId: nextVersion, createdAt, message: manifest.message, fileCount: manifest.files.length, sourceDraftId: draft.draftId }]
      draft.status = 'committed'
      draft.committedVersion = nextVersion
      await saveDraft(productRoot, draft)
      const comparison = await readComparison(productRoot, draft.comparisonId).catch(() => null)
      const analysis = comparison?.analysisId ? await analysisManifest(productRoot, comparison.analysisId).catch(() => null) : null
      const workspace = analysis
        ? observeWorkspace(state, analysis)
        : comparison?.sourceWorkspace ? state.workspaces[workspaceKey(comparison.sourceWorkspace)] : null
      if (workspace) {
        workspace.planId = draft.planId
        workspace.connectionMode = workspace.connectionMode || 'contributed'
        workspace.connectedVersion = nextVersion
        workspace.selectedSystemIds = comparison?.selectedSystems?.map((item) => item.id) || workspace.selectedSystemIds || []
        if (analysis) {
          workspace.baselineSignature = analysisSignature(analysis, workspace.selectedSystemIds)
          workspace.observedSignature = workspace.baselineSignature
          workspace.lastAnalysisId = analysis.analysisId
          workspace.lastAnalyzedAt = analysis.createdAt
        }
        workspace.hasUpdates = false
        workspace.pendingAnalysisId = null
        workspace.pendingComparisonId = null
        workspace.pendingSummary = null
        workspace.status = 'connected'
      }
      await saveState()
      return { plan: planPublic(plan), version: manifest, draft: publicDraft(draft) }
    }
    if (method === 'POST' && pathname === '/version/rollback') {
      const result = await rollbackVersion(productRoot, state, body)
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
      const workspace = state.workspaces[workspaceKey(protection.worktreePath)]
      if (workspace && workspace.protectionId === protectionId) {
        workspace.status = 'observed'
        workspace.connectionMode = null
        workspace.connectedVersion = null
        workspace.protectionId = null
        workspace.hasUpdates = false
      }
      await saveState()
      return { ...result, workspace: workspace ? publicWorkspace(workspace) : null }
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
    throw serviceError(404, 'PRODUCT_ROUTE_NOT_FOUND', `product route not found: ${method} ${pathname}`)
  }

  return { handle, isWriteRoute }
}
