import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  assertSourceOutsideProtectedRoots,
  assertRunLayoutOwned,
  createIsolatedGitEnvironment,
  validateRealE2eEnvironment
} from './real-e2e.mjs'

const SKILLS_MATERIALIZATION_POLICY = 'git-blob-exact-or-strict-crlf-v1'
const GENERATED_ATTRIBUTES_HEADER = '# Skill Graft generated skills worktree policy v1'
const ALLOWED_GIT_BLOB_MODES = new Set(['100644', '100755'])
const ALLOWED_EMPTY_SKILLS_DIRECTORIES = new Set(['adopted', 'inbox'])

function required(name) {
  const value = String(process.env[name] || '').trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function absoluteDirectory(name) {
  const value = required(name)
  if (!path.isAbsolute(value)) throw new Error(`${name} must be absolute`)
  const resolved = path.resolve(value)
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`${name} is not a directory: ${resolved}`)
  }
  return resolved
}

function runGit(args, cwd, env) {
  const result = spawnSync('git', [
    '--no-optional-locks',
    '-c', 'core.fsmonitor=false',
    '-c', 'core.hooksPath=',
    ...args
  ], {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60000,
    maxBuffer: 16 * 1024 * 1024
  })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout.trim()
}

function runGitBuffer(args, cwd, env) {
  const result = spawnSync('git', [
    '--no-optional-locks',
    '-c', 'core.fsmonitor=false',
    '-c', 'core.hooksPath=',
    ...args
  ], {
    cwd,
    env,
    encoding: null,
    windowsHide: true,
    timeout: 60000,
    maxBuffer: 16 * 1024 * 1024
  })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${Buffer.concat([result.stderr || Buffer.alloc(0), result.stdout || Buffer.alloc(0)]).toString('utf8')}`)
  }
  return result.stdout || Buffer.alloc(0)
}

function assertEmptyDirectory(dir, label) {
  if (fs.readdirSync(dir).length > 0) throw new Error(`${label} must be empty before P0 fixture preparation: ${dir}`)
}

function samePath(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(value)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  return normalize(left) === normalize(right)
}

function isSameOrInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  )
}

function assertPlainDirectoryChain(boundary, target, label) {
  const resolvedBoundary = path.resolve(boundary)
  const resolvedTarget = path.resolve(target)
  if (!isSameOrInside(resolvedBoundary, resolvedTarget)) {
    throw new Error(`${label} must remain inside its marker-owned boundary`)
  }
  const boundaryStat = fs.lstatSync(resolvedBoundary)
  if (!boundaryStat.isDirectory() || boundaryStat.isSymbolicLink()) {
    throw new Error(`${label} boundary must be a plain directory, not a link or reparse point: ${resolvedBoundary}`)
  }
  const canonicalBoundary = fs.realpathSync.native(resolvedBoundary)
  const relative = path.relative(resolvedBoundary, resolvedTarget)
  let cursor = resolvedBoundary
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment)
    const stat = fs.lstatSync(cursor)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`${label} ancestor must be a plain directory, not a link or reparse point: ${cursor}`)
    }
    const canonical = fs.realpathSync.native(cursor)
    if (!isSameOrInside(canonicalBoundary, canonical)) {
      throw new Error(`${label} ancestor escaped its marker-owned boundary: ${cursor}`)
    }
  }
  return canonicalBoundary
}

function lstatIfPresent(target) {
  try {
    return fs.lstatSync(target)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function ensurePlainContainedDirectory(target, boundary, label) {
  const existing = lstatIfPresent(target)
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
    throw new Error(`${label} must be a plain directory, not a link or reparse point: ${target}`)
  }
  if (!existing) fs.mkdirSync(target)
  assertPlainDirectoryChain(boundary, target, label)
}

function assertIsolatedGitAttributesEnvironment(context, gitEnv) {
  const expectedXdgRoot = path.join(path.resolve(context.homeRoot), 'xdg-config')
  if (gitEnv.XDG_CONFIG_HOME !== expectedXdgRoot) {
    throw new Error('isolated Git XDG_CONFIG_HOME must exactly equal marker-owned home/xdg-config')
  }
  if (gitEnv.GIT_ATTR_NOSYSTEM !== '1') {
    throw new Error('isolated Git must disable system attributes with GIT_ATTR_NOSYSTEM=1')
  }

  assertPlainDirectoryChain(context.runRoot, context.homeRoot, 'isolated Git home')
  ensurePlainContainedDirectory(expectedXdgRoot, context.runRoot, 'isolated Git XDG_CONFIG_HOME')
  const globalGitRoot = path.join(expectedXdgRoot, 'git')
  ensurePlainContainedDirectory(globalGitRoot, context.runRoot, 'isolated Git global attributes directory')
  const globalAttributes = path.join(globalGitRoot, 'attributes')
  if (lstatIfPresent(globalAttributes)) {
    throw new Error('isolated Git global attributes file must not exist before source preflight')
  }
}

function assertPlainContainedTree(root, boundary, label) {
  const canonicalBoundary = assertPlainDirectoryChain(boundary, root, label)
  const hash = createHash('sha256')
  const contentEntries = []
  const fileEntries = []
  const structureEntries = []
  const visit = (target, relative = '') => {
    const stat = fs.lstatSync(target)
    const portable = relative.replaceAll('\\', '/') || '.'
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} contains a link or reparse point: ${target}`)
    }
    const canonical = fs.realpathSync.native(target)
    if (!isSameOrInside(canonicalBoundary, canonical)) {
      throw new Error(`${label} escaped its marker-owned boundary: ${target}`)
    }
    if (stat.isDirectory()) {
      hash.update(`d\0${portable}\0${stat.mode}\0`, 'utf8')
      if (relative) structureEntries.push({ path: portable, type: 'directory' })
      const children = fs.readdirSync(target, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name, 'en'))
      for (const child of children) visit(path.join(target, child.name), path.join(relative, child.name))
      return
    }
    if (!stat.isFile()) {
      throw new Error(`${label} contains a non-regular filesystem object: ${target}`)
    }
    const contents = fs.readFileSync(target)
    const sha256 = createHash('sha256').update(contents).digest('hex')
    contentEntries.push({ path: portable, sha256 })
    const fileEntry = { path: portable, sha256, size: String(stat.size) }
    fileEntries.push(fileEntry)
    structureEntries.push({ ...fileEntry, type: 'file' })
    hash.update(`f\0${portable}\0${stat.mode}:${stat.size}\0`, 'utf8')
    hash.update(sha256, 'utf8')
    hash.update('\0', 'utf8')
  }
  visit(root)
  contentEntries.sort((left, right) => Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8')))
  fileEntries.sort(compareManifestEntries)
  structureEntries.sort(compareManifestEntries)
  return {
    sha256: hash.digest('hex'),
    contentSha256: createHash('sha256')
      .update('skill-graft:skills-content-manifest:v1\0', 'utf8')
      .update(JSON.stringify(contentEntries), 'utf8')
      .digest('hex'),
    fileEntries,
    structureEntries
  }
}

function assertPlainContainedFile(file, boundary, label) {
  const canonicalBoundary = assertPlainDirectoryChain(boundary, path.dirname(file), label)
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a plain file, not a link or reparse point: ${file}`)
  }
  const canonical = fs.realpathSync.native(file)
  if (!isSameOrInside(canonicalBoundary, canonical)) {
    throw new Error(`${label} escaped its marker-owned boundary: ${file}`)
  }
  const contents = fs.readFileSync(file)
  return {
    contents,
    sha256: createHash('sha256').update(contents).digest('hex')
  }
}

function assertSamePhysicalSkills(actual, expected, label) {
  if (actual.sha256 !== expected.sha256 || actual.contentSha256 !== expected.contentSha256) {
    throw new Error(`${label} physical skills digest does not match the verified source materialization`)
  }
}

function gitPathCompare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function compareManifestEntries(left, right) {
  const byPath = gitPathCompare(left.path, right.path)
  return byPath || String(left.type).localeCompare(String(right.type), 'en')
}

function parseNullPaths(buffer) {
  const text = buffer.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(buffer)) throw new Error('source Git manifest contains a non-UTF-8 path')
  return text.split('\0').filter(Boolean)
}

function assertGitSkillsPath(relative) {
  const portable = relative.replaceAll('\\', '/')
  const normalized = path.posix.normalize(portable)
  if (!portable
    || portable.startsWith('/')
    || normalized === '..'
    || normalized.startsWith('../')
    || normalized !== portable) {
    throw new Error('source Git skills manifest contains an unsafe path')
  }
  return portable
}

function gitManifestSha256(entries) {
  return createHash('sha256')
    .update('skill-graft:skills-git-manifest:v1\0', 'utf8')
    .update(JSON.stringify(entries), 'utf8')
    .digest('hex')
}

function finalizeGitSkillsManifest(entries, blobs = new Map()) {
  entries.sort(compareManifestEntries)
  return { entries, sha256: gitManifestSha256(entries), blobs }
}

function gitHeadSkillsManifest(sourceHub, commit, gitEnv) {
  const entries = []
  const blobs = new Map()
  for (const record of parseNullPaths(runGitBuffer(['ls-tree', '-r', '-t', '-z', `${commit}:skills`], sourceHub, gitEnv))) {
    const separator = record.indexOf('\t')
    const header = separator >= 0 ? record.slice(0, separator) : ''
    const relative = separator >= 0 ? record.slice(separator + 1) : ''
    const [mode, type, objectId] = header.split(' ')
    if (!relative || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(String(objectId || ''))) {
      throw new Error('source Git skills HEAD contains an unsupported entry')
    }
    const entryPath = assertGitSkillsPath(relative)
    if (type === 'tree') {
      if (mode !== '040000') throw new Error('source Git skills HEAD contains an unsupported directory mode')
      entries.push({ path: entryPath, type: 'directory', mode })
      continue
    }
    if (type !== 'blob' || !ALLOWED_GIT_BLOB_MODES.has(mode)) {
      throw new Error('source Git skills HEAD contains a symlink, submodule, or unsupported blob mode')
    }
    const contents = runGitBuffer(['cat-file', 'blob', objectId], sourceHub, gitEnv)
    blobs.set(entryPath, contents)
    entries.push({
      path: entryPath,
      type: 'file',
      mode,
      objectId,
      sha256: createHash('sha256').update(contents).digest('hex'),
      size: String(contents.length)
    })
  }
  return finalizeGitSkillsManifest(entries, blobs)
}

function gitIndexSkillsManifest(sourceHub, gitEnv) {
  const files = []
  const directories = new Set()
  const blobs = new Map()
  for (const record of parseNullPaths(runGitBuffer(['ls-files', '--stage', '-z', '--', 'skills'], sourceHub, gitEnv))) {
    const separator = record.indexOf('\t')
    const header = separator >= 0 ? record.slice(0, separator) : ''
    const trackedPath = separator >= 0 ? record.slice(separator + 1).replaceAll('\\', '/') : ''
    const [mode, objectId, stage] = header.split(' ')
    if (!trackedPath.startsWith('skills/')
      || stage !== '0'
      || !ALLOWED_GIT_BLOB_MODES.has(mode)
      || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(String(objectId || ''))) {
      throw new Error('source Git skills index contains an unsupported entry')
    }
    const entryPath = assertGitSkillsPath(trackedPath.slice('skills/'.length))
    if (runGit(['cat-file', '-t', objectId], sourceHub, gitEnv) !== 'blob') {
      throw new Error('source Git skills index contains a non-blob entry')
    }
    const contents = runGitBuffer(['cat-file', 'blob', objectId], sourceHub, gitEnv)
    blobs.set(entryPath, contents)
    const segments = entryPath.split('/')
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join('/'))
    }
    files.push({
      path: entryPath,
      type: 'file',
      mode,
      objectId,
      sha256: createHash('sha256').update(contents).digest('hex'),
      size: String(contents.length)
    })
  }
  return finalizeGitSkillsManifest([
    ...[...directories].map((entryPath) => ({ path: entryPath, type: 'directory', mode: '040000' })),
    ...files
  ], blobs)
}

function assertGitSkillsManifestEqual(actual, expected) {
  if (actual.sha256 !== expected.sha256 || JSON.stringify(actual.entries) !== JSON.stringify(expected.entries)) {
    throw new Error('source Git skills index does not exactly match HEAD structure, modes, object IDs, and blob bytes')
  }
}

function assertPhysicalSkillsStructureMatchesGit(physical, gitManifest) {
  const physicalByPath = new Map(physical.structureEntries.map((entry) => [entry.path, entry]))
  const gitByPath = new Map(gitManifest.entries.map((entry) => [entry.path, entry]))
  for (const requiredDirectory of ALLOWED_EMPTY_SKILLS_DIRECTORIES) {
    if (physicalByPath.get(requiredDirectory)?.type !== 'directory') {
      throw new Error(`source physical skills must contain the explicit ${requiredDirectory} directory`)
    }
  }
  for (const [entryPath, expected] of gitByPath) {
    if (physicalByPath.get(entryPath)?.type !== expected.type) {
      throw new Error('source physical skills directory/file structure does not match its Git tree')
    }
  }
  for (const [entryPath, actual] of physicalByPath) {
    if (gitByPath.has(entryPath)) continue
    const hasChildren = physical.structureEntries.some((entry) => entry.path.startsWith(`${entryPath}/`))
    if (actual.type !== 'directory'
      || hasChildren
      || !ALLOWED_EMPTY_SKILLS_DIRECTORIES.has(entryPath)) {
      throw new Error('source physical skills contain an untracked directory or file outside the adopted/inbox allowance')
    }
  }
}

function expandLfToCrlf(blob) {
  let lineFeeds = 0
  for (const byte of blob) if (byte === 0x0a) lineFeeds += 1
  const projected = Buffer.allocUnsafe(blob.length + lineFeeds)
  let offset = 0
  for (const byte of blob) {
    if (byte === 0x0a) projected[offset++] = 0x0d
    projected[offset++] = byte
  }
  return projected
}

function classifySkillsProjection(sourceSkills, physical, gitManifest) {
  assertPhysicalSkillsStructureMatchesGit(physical, gitManifest)
  const physicalFiles = new Map(physical.fileEntries.map((entry) => [entry.path, entry]))
  const entries = []
  for (const gitEntry of gitManifest.entries.filter((entry) => entry.type === 'file')) {
    const entryPath = assertGitSkillsPath(gitEntry.path)
    if (!/^[A-Za-z0-9._/-]+$/.test(entryPath)
      || entryPath.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
      throw new Error('source skills path cannot be encoded safely in the generated attributes policy')
    }
    const blob = gitManifest.blobs.get(entryPath)
    const physicalEntry = physicalFiles.get(entryPath)
    if (!blob || !physicalEntry) throw new Error('source skills projection is missing a Git or physical file')
    const physicalBytes = fs.readFileSync(path.join(sourceSkills, ...entryPath.split('/')))
    if (physicalEntry.sha256 !== createHash('sha256').update(physicalBytes).digest('hex')
      || physicalEntry.size !== String(physicalBytes.length)) {
      throw new Error('source physical skills changed during materialization preflight')
    }
    let kind = 'exact'
    if (!physicalBytes.equals(blob)) {
      let blobHasLf = false
      for (const byte of blob) {
        if (byte === 0x00 || byte === 0x0d) {
          throw new Error('source skills physical bytes are not an exact or strict-crlf projection of the Git blob')
        }
        if (byte === 0x0a) blobHasLf = true
      }
      if (!blobHasLf) throw new Error('source strict-crlf projection requires at least one canonical LF byte')
      for (let index = 0; index < physicalBytes.length; index += 1) {
        const byte = physicalBytes[index]
        if (byte === 0x00) throw new Error('source strict-crlf projection rejects NUL bytes')
        if (byte === 0x0d) {
          if (physicalBytes[index + 1] !== 0x0a) throw new Error('source strict-crlf projection rejects a bare CR byte')
          index += 1
          continue
        }
        if (byte === 0x0a) throw new Error('source strict-crlf projection rejects a bare LF byte')
      }
      if (!expandLfToCrlf(blob).equals(physicalBytes)) {
        throw new Error('source skills physical bytes are not an exact or strict-crlf projection of the Git blob')
      }
      kind = 'strict-crlf'
    }
    entries.push({
      path: entryPath,
      mode: gitEntry.mode,
      kind,
      blobObjectId: gitEntry.objectId,
      blobSha256: gitEntry.sha256,
      physicalSha256: physicalEntry.sha256,
      blobSize: gitEntry.size,
      physicalSize: physicalEntry.size
    })
  }
  entries.sort(compareManifestEntries)
  const exactEntries = entries.filter((entry) => entry.kind === 'exact').length
  const crlfEntries = entries.filter((entry) => entry.kind === 'strict-crlf').length
  const attributes = [
    GENERATED_ATTRIBUTES_HEADER,
    '/skills/** -text -filter -ident -working-tree-encoding',
    ...entries
      .filter((entry) => entry.kind === 'strict-crlf')
      .map((entry) => `/skills/${entry.path} text eol=crlf -filter -ident -working-tree-encoding`),
    ''
  ].join('\n')
  return {
    entries,
    sha256: createHash('sha256')
      .update('skill-graft:skills-worktree-projection:v1\0', 'utf8')
      .update(JSON.stringify(entries), 'utf8')
      .digest('hex'),
    exactEntries,
    crlfEntries,
    attributes,
    attributesSha256: createHash('sha256').update(attributes, 'utf8').digest('hex')
  }
}

function readJsonFile(file, label) {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a plain file: ${file}`)
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`${label} must contain valid JSON: ${error instanceof Error ? error.message : error}`)
  }
}

function assertHistoricalRunSource(runRoot, expectedSource, actualSource, label) {
  if (!samePath(expectedSource, actualSource)) {
    throw new Error(`${label} must use the marker-owned historical run path ${expectedSource}`)
  }
  for (const [target, targetLabel] of [[runRoot, 'run root'], [actualSource, label]]) {
    const stat = fs.lstatSync(target)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`${targetLabel} must be a plain historical fixture directory: ${target}`)
    }
  }
  const marker = readJsonFile(path.join(runRoot, '.skill-graft-e2e-run.json'), `${label} ownership marker`)
  if (marker.version !== 1
    || typeof marker.runId !== 'string'
    || !samePath(path.join(path.dirname(runRoot), marker.runId), runRoot)
    || !path.isAbsolute(marker.runRoot)
    || !samePath(marker.runRoot, runRoot)) {
    throw new Error(`${label} ownership marker does not own its historical run root`)
  }
  const canonicalRunRoot = fs.realpathSync.native(runRoot)
  const canonicalSource = fs.realpathSync.native(actualSource)
  const relative = path.relative(canonicalRunRoot, canonicalSource)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escaped its marker-owned historical run root`)
  }
  const fixture = readJsonFile(path.join(runRoot, '.skill-graft-p0-fixture.json'), `${label} P0 fixture manifest`)
  if (fixture.runId !== marker.runId) throw new Error(`${label} P0 fixture manifest belongs to another run`)
  return {
    canonicalRunRoot,
    fixture,
    marker
  }
}

function assertPlainGitDirectory(root, label) {
  const gitDirectory = path.join(root, '.git')
  if (!fs.existsSync(gitDirectory)) throw new Error(`${label} is missing .git`)
  const stat = fs.lstatSync(gitDirectory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} .git must be a plain directory`)
  }
}

function assertPlainGitObjectDirectories(root, sourceRun, label) {
  assertPlainGitDirectory(root, label)
  const infoDirectory = path.join(root, '.git', 'objects', 'info')
  assertPlainDirectoryChain(sourceRun, infoDirectory, `${label} object database`)
  return {
    objects: path.join(root, '.git', 'objects'),
    info: infoDirectory
  }
}

function assertNoExternalConversionConfig(root, label, gitEnv, { requireLineEndingPolicy = false } = {}) {
  const configSources = [
    runGitBuffer(['config', '--no-includes', '--local', '--null', '--list'], root, gitEnv),
    runGitBuffer(['config', '--no-includes', '--null', '--list'], root, gitEnv)
  ]
  const worktreeConfig = path.join(root, '.git', 'config.worktree')
  if (fs.existsSync(worktreeConfig)) {
    const stat = fs.lstatSync(worktreeConfig)
    if (!stat.isFile() || stat.isSymbolicLink()
      || !isSameOrInside(fs.realpathSync.native(path.join(root, '.git')), fs.realpathSync.native(worktreeConfig))) {
      throw new Error(`${label} config.worktree must be a plain file inside its Git directory`)
    }
    configSources.push(runGitBuffer([
      'config', '--no-includes', '--file', worktreeConfig, '--null', '--list'
    ], root, gitEnv))
  }
  for (const config of configSources) {
    for (const record of config.toString('utf8').split('\0').filter(Boolean)) {
      const key = record.split(/[\n=]/, 1)[0].toLowerCase()
      if (key.startsWith('filter.')
        || key.startsWith('include.')
        || key.startsWith('includeif.')
        || key === 'core.attributesfile') {
        throw new Error(`${label} contains an external Git conversion policy`)
      }
    }
  }
  if (requireLineEndingPolicy
    && (runGit(['config', '--no-includes', '--get', 'core.autocrlf'], root, gitEnv) !== 'false'
      || runGit(['config', '--no-includes', '--get', 'core.safecrlf'], root, gitEnv) !== 'true')) {
    throw new Error(`${label} does not retain its bound safe Git materialization policy`)
  }
}

function assertNoAdditionalAttributesPolicies(sourceHub, gitEnv) {
  const infoAttributes = path.join(sourceHub, '.git', 'info', 'attributes')
  if (fs.existsSync(infoAttributes)) {
    throw new Error('source hub-data must not use .git/info/attributes')
  }
  const assertOnlyRootAttributes = (entries, label) => {
    for (const entry of entries) {
      const portable = entry.replaceAll('\\', '/')
      if (path.posix.basename(portable).toLowerCase() === '.gitattributes' && portable !== '.gitattributes') {
        throw new Error(`${label} contains a nested .gitattributes conversion policy`)
      }
    }
  }
  const headPaths = runGitBuffer(['ls-tree', '-r', '--name-only', '-z', 'HEAD'], sourceHub, gitEnv)
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
  const indexPaths = runGitBuffer(['ls-files', '-z'], sourceHub, gitEnv)
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
  assertOnlyRootAttributes(headPaths, 'source hub-data HEAD')
  assertOnlyRootAttributes(indexPaths, 'source hub-data index')

  const physicalAttributes = []
  const visit = (directory, relative = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!relative && entry.name === '.git') continue
      const target = path.join(directory, entry.name)
      const portable = path.join(relative, entry.name).replaceAll('\\', '/')
      const stat = fs.lstatSync(target)
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) {
        visit(target, portable)
      } else if (entry.name.toLowerCase() === '.gitattributes') {
        physicalAttributes.push(portable)
      }
    }
  }
  visit(sourceHub)
  assertOnlyRootAttributes(physicalAttributes, 'source hub-data physical tree')
}

function assertSafeProbeAttributes(contents, relative) {
  const text = contents.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(contents) || text.includes('\0')) {
    throw new Error(`source probe ${relative} must be valid UTF-8 without NUL bytes`)
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const tokens = line.split(/\s+/).slice(1)
    for (const rawToken of tokens) {
      const token = rawToken.replace(/^['"]|['"]$/g, '').toLowerCase()
      if (token === '-filter' || token === '-working-tree-encoding') continue
      if (/^(?:!?filter|!?working-tree-encoding)(?:=.*)?$/.test(token)) {
        throw new Error(`source probe ${relative} contains an unsafe conversion attribute`)
      }
    }
  }
}

function probeAttributesTreeManifest(probeSource, commit, gitEnv) {
  const entries = []
  for (const record of parseNullPaths(runGitBuffer(['ls-tree', '-r', '-z', commit], probeSource, gitEnv))) {
    const separator = record.indexOf('\t')
    const header = separator >= 0 ? record.slice(0, separator) : ''
    const relative = separator >= 0 ? assertGitSkillsPath(record.slice(separator + 1)) : ''
    if (path.posix.basename(relative).toLowerCase() !== '.gitattributes') continue
    const [mode, type, objectId] = header.split(' ')
    if (mode !== '100644' || type !== 'blob' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(String(objectId || ''))) {
      throw new Error('source probe HEAD contains an unsupported .gitattributes entry')
    }
    const contents = runGitBuffer(['cat-file', 'blob', objectId], probeSource, gitEnv)
    entries.push({ path: relative, mode, objectId, contents })
  }
  entries.sort(compareManifestEntries)
  return entries
}

function probeAttributesIndexManifest(probeSource, gitEnv) {
  const entries = []
  for (const record of parseNullPaths(runGitBuffer(['ls-files', '--stage', '-z'], probeSource, gitEnv))) {
    const separator = record.indexOf('\t')
    const header = separator >= 0 ? record.slice(0, separator) : ''
    const relative = separator >= 0 ? assertGitSkillsPath(record.slice(separator + 1)) : ''
    if (path.posix.basename(relative).toLowerCase() !== '.gitattributes') continue
    const [mode, objectId, stage] = header.split(' ')
    if (mode !== '100644' || stage !== '0' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(String(objectId || ''))) {
      throw new Error('source probe index contains an unsupported .gitattributes entry')
    }
    entries.push({ path: relative, mode, objectId })
  }
  entries.sort(compareManifestEntries)
  return entries
}

function assertProbeAttributesPreflight(probeSource, sourceRun, commit, gitEnv) {
  const infoAttributes = path.join(probeSource, '.git', 'info', 'attributes')
  if (fs.existsSync(infoAttributes)) throw new Error('source probe must not use .git/info/attributes')
  const head = probeAttributesTreeManifest(probeSource, commit, gitEnv)
  const index = probeAttributesIndexManifest(probeSource, gitEnv)
  const headIdentity = head.map(({ path: entryPath, mode, objectId }) => ({ path: entryPath, mode, objectId }))
  if (JSON.stringify(index) !== JSON.stringify(headIdentity)) {
    throw new Error('source probe .gitattributes index entries must exactly match HEAD')
  }
  const canonicalProbe = fs.realpathSync.native(probeSource)
  for (const entry of head) {
    const physical = path.join(probeSource, ...entry.path.split('/'))
    const stat = fs.lstatSync(physical)
    if (!stat.isFile() || stat.isSymbolicLink()
      || !isSameOrInside(canonicalProbe, fs.realpathSync.native(physical))) {
      throw new Error(`source probe ${entry.path} must be a plain contained file`)
    }
    const contents = fs.readFileSync(physical)
    if (!contents.equals(entry.contents)) {
      throw new Error(`source probe ${entry.path} physical bytes must exactly match HEAD and index`)
    }
    assertSafeProbeAttributes(contents, entry.path)
  }
  const otherArgs = [
    ['ls-files', '--others', '--exclude-standard', '-z'],
    ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']
  ]
  for (const args of otherArgs) {
    for (const relative of parseNullPaths(runGitBuffer(args, probeSource, gitEnv))) {
      const portable = assertGitSkillsPath(relative)
      if (path.posix.basename(portable).toLowerCase() === '.gitattributes') {
        throw new Error('source probe contains an untracked or ignored .gitattributes policy')
      }
    }
  }
  assertPlainDirectoryChain(sourceRun, path.join(probeSource, '.git', 'objects', 'info'), 'source probe object database')
}

function assertSourceGitProvenance(sourceHub, probeSource, fixture, probeCommit, sourceRun, physicalSkills, gitEnv) {
  assertPlainGitObjectDirectories(sourceHub, sourceRun, 'source hub-data')
  assertPlainGitObjectDirectories(probeSource, sourceRun, 'source probe')
  const sourceHubAlternatesFile = path.join(sourceHub, '.git', 'objects', 'info', 'alternates')
  const sourceProbeAlternatesFile = path.join(probeSource, '.git', 'objects', 'info', 'alternates')
  if (fs.existsSync(sourceHubAlternatesFile)) {
    throw new Error('source hub-data must not retain an object alternate')
  }
  if (fs.existsSync(sourceProbeAlternatesFile)) {
    throw new Error('SKILL_GRAFT_PROBE_SOURCE must not retain an object alternate')
  }
  const hubHead = runGit(['rev-parse', 'HEAD'], sourceHub, gitEnv)
  if (hubHead !== fixture.hubCommit) {
    throw new Error('source hub-data HEAD does not match source P0 fixture manifest hubCommit')
  }
  const skillsTree = runGit(['rev-parse', 'HEAD:skills'], sourceHub, gitEnv)
  const gitManifest = gitHeadSkillsManifest(sourceHub, hubHead, gitEnv)
  const indexManifest = gitIndexSkillsManifest(sourceHub, gitEnv)
  assertGitSkillsManifestEqual(indexManifest, gitManifest)
  const projection = classifySkillsProjection(path.join(sourceHub, 'skills'), physicalSkills, gitManifest)
  const sourceGit = { hubHead, skillsTree, gitManifest, projection }
  const attributes = assertSourceAttributes(sourceHub, sourceRun, projection, gitEnv)
  const materialization = normalizedSkillsMaterialization(
    fixture,
    sourceGit,
    physicalSkills,
    attributes,
    gitManifest,
    projection
  )
  const convertedFrom = normalizedConvertedFrom(fixture, sourceGit, physicalSkills, materialization)
  const sourceProbeHead = runGit(['rev-parse', 'HEAD'], probeSource, gitEnv)
  if (sourceProbeHead !== fixture.probeCommit || sourceProbeHead !== probeCommit) {
    throw new Error('source probe HEAD does not match source P0 fixture manifest and SKILL_GRAFT_PROBE_COMMIT')
  }
  assertProbeAttributesPreflight(probeSource, sourceRun, sourceProbeHead, gitEnv)
  assertNoAdditionalAttributesPolicies(sourceHub, gitEnv)
  assertNoExternalConversionConfig(sourceHub, 'source hub-data', gitEnv, { requireLineEndingPolicy: true })
  assertNoExternalConversionConfig(probeSource, 'source probe', gitEnv)

  const hubStatus = runGit(['status', '--porcelain=v1', '--untracked-files=all'], sourceHub, gitEnv)
  if (hubStatus) throw new Error(`source hub-data must be clean:\n${hubStatus}`)
  const ignoredSkills = runGit([
    'status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching', '--', 'skills'
  ], sourceHub, gitEnv)
  if (ignoredSkills) throw new Error(`source hub-data skills contain ignored or dirty paths:\n${ignoredSkills}`)

  const sourceProbeStatus = runGit(['status', '--porcelain=v1', '--untracked-files=all'], probeSource, gitEnv)
  if (sourceProbeStatus) throw new Error(`source probe must be clean:\n${sourceProbeStatus}`)
  const branch = runGit(['branch', '--show-current'], probeSource, gitEnv)
  if (branch) throw new Error(`source probe must be detached, found branch ${branch}`)
  const remotes = runGit(['remote'], probeSource, gitEnv)
  if (remotes) throw new Error(`source probe must not retain a remote: ${remotes}`)
  return { ...sourceGit, probeHead: sourceProbeHead, attributes, materialization, convertedFrom }
}

function assertSourceAttributes(sourceHub, sourceRun, projection, gitEnv) {
  const attributesFile = path.join(sourceHub, '.gitattributes')
  const attributes = assertPlainContainedFile(attributesFile, sourceRun, 'source hub-data/.gitattributes')
  const trackedEntry = runGit(['ls-tree', 'HEAD', '--', '.gitattributes'], sourceHub, gitEnv)
  const tracked = /^100644 blob ((?:[0-9a-f]{40}|[0-9a-f]{64}))\t\.gitattributes$/i.exec(trackedEntry)
  if (!tracked) {
    throw new Error('source hub-data/.gitattributes must be tracked as a regular 100644 blob at HEAD')
  }
  const indexEntry = runGitBuffer(['ls-files', '--stage', '-z', '--', '.gitattributes'], sourceHub, gitEnv)
    .toString('utf8')
    .replace(/\0$/, '')
  const indexed = /^100644 ((?:[0-9a-f]{40}|[0-9a-f]{64})) 0\t\.gitattributes$/i.exec(indexEntry)
  if (!indexed || indexed[1] !== tracked[1]) {
    throw new Error('source hub-data/.gitattributes index blob must exactly match HEAD')
  }
  const committed = runGitBuffer(['cat-file', 'blob', tracked[1]], sourceHub, gitEnv)
  if (!committed.equals(attributes.contents)) {
    throw new Error('source hub-data/.gitattributes physical bytes must exactly match its tracked blob')
  }
  const regenerated = Buffer.from(projection.attributes, 'utf8')
  if (!attributes.contents.equals(regenerated) || attributes.sha256 !== projection.attributesSha256) {
    throw new Error('source hub-data/.gitattributes does not exactly match the independently regenerated skills policy')
  }
  return attributes
}

function materializationLineage(materialization) {
  return {
    skillsMaterializationPolicy: materialization.policy,
    skillsGitManifestSha256: materialization.gitManifestSha256,
    skillsProjectionSha256: materialization.projectionSha256,
    skillsProjectionEntries: materialization.projectionEntries,
    skillsExactEntries: materialization.exactEntries,
    skillsCrlfEntries: materialization.crlfEntries,
    skillsAttributesSha256: materialization.attributesSha256,
    targetSkillsTree: materialization.targetSkillsTree
  }
}

function normalizedSkillsMaterialization(fixture, sourceGit, physicalSkills, attributes, gitManifest, projection) {
  const candidate = fixture.skillsMaterialization
  if (!candidate
    || candidate.version !== 1
    || candidate.policy !== SKILLS_MATERIALIZATION_POLICY
    || !/^[0-9a-f]{64}$/i.test(String(candidate.gitManifestSha256 || ''))
    || !/^[0-9a-f]{64}$/i.test(String(candidate.projectionSha256 || ''))
    || !Number.isInteger(candidate.projectionEntries)
    || candidate.projectionEntries <= 0
    || !Number.isInteger(candidate.exactEntries)
    || candidate.exactEntries < 0
    || !Number.isInteger(candidate.crlfEntries)
    || candidate.crlfEntries < 0
    || candidate.exactEntries + candidate.crlfEntries !== candidate.projectionEntries
    || !/^[0-9a-f]{64}$/i.test(String(candidate.attributesSha256 || ''))
    || !/^[0-9a-f]{40}$/i.test(String(candidate.targetSkillsTree || ''))
    || !/^[0-9a-f]{64}$/i.test(String(candidate.physicalSkillsSha256 || ''))
    || !/^[0-9a-f]{64}$/i.test(String(candidate.physicalSkillsContentSha256 || ''))
    || candidate.gitManifestSha256 !== gitManifest.sha256
    || candidate.projectionSha256 !== projection.sha256
    || candidate.projectionEntries !== projection.entries.length
    || candidate.exactEntries !== projection.exactEntries
    || candidate.crlfEntries !== projection.crlfEntries
    || candidate.attributesSha256 !== projection.attributesSha256
    || candidate.attributesSha256 !== attributes.sha256
    || candidate.targetSkillsTree !== sourceGit.skillsTree
    || candidate.physicalSkillsSha256 !== physicalSkills.sha256
    || candidate.physicalSkillsContentSha256 !== physicalSkills.contentSha256
    || !/^[0-9a-f]{64}$/i.test(String(fixture.skillsContentSha256 || ''))
    || fixture.skillsContentSha256 !== physicalSkills.contentSha256) {
    throw new Error('source P0 v2 skillsMaterialization provenance is invalid')
  }
  return candidate
}

function normalizedConvertedFrom(fixture, sourceGit, physicalSkills, materialization) {
  const materializationFields = materializationLineage(materialization)
  const candidate = fixture.convertedFrom
  const cleanProjectionSha256 = createHash('sha256')
    .update('skill-graft:p0-v2-clean-projection:v1\0', 'utf8')
    .digest('hex')
  if (!candidate
    || ![1, 2].includes(fixture.convertedFromFixtureVersion)
    || candidate.fixtureVersion !== fixture.convertedFromFixtureVersion
    || !/^[0-9a-f]{40}$/i.test(String(candidate.declaredHubCommit || ''))
    || !/^[0-9a-f]{40}$/i.test(String(candidate.actualHubCommit || ''))
    || !/^[0-9a-f]{40}$/i.test(String(candidate.skillsTree || ''))
    || !/^[0-9a-f]{64}$/i.test(String(candidate.physicalSkillsSha256 || ''))
    || !/^[0-9a-f]{64}$/i.test(String(candidate.physicalSkillsContentSha256 || ''))
    || !/^p0-v(?:1-post-acceptance-attach-v1|2-clean)$/.test(String(candidate.probeProjectionKind || ''))
    || !/^[0-9a-f]{64}$/i.test(String(candidate.probeProjectionSha256 || ''))
    || !Number.isInteger(candidate.probeProjectionEntries)
    || candidate.probeProjectionEntries < 0
    || candidate.skillsTree !== sourceGit.skillsTree
    || candidate.physicalSkillsSha256 !== physicalSkills.sha256
    || candidate.physicalSkillsContentSha256 !== physicalSkills.contentSha256
    || fixture.skillsContentSha256 !== candidate.physicalSkillsContentSha256
    || (candidate.fixtureVersion === 1
      && (candidate.probeProjectionKind !== 'p0-v1-post-acceptance-attach-v1'
        || candidate.probeProjectionEntries <= 0))
    || (candidate.fixtureVersion === 2
      && (candidate.probeProjectionKind !== 'p0-v2-clean'
        || candidate.probeProjectionEntries !== 0
        || candidate.probeProjectionSha256 !== cleanProjectionSha256))
    || Object.entries(materializationFields).some(([key, value]) => candidate[key] !== value)) {
    throw new Error('source P0 v2 convertedFrom provenance is invalid')
  }
  return candidate
}

function sourceRunIdentity(runId) {
  return createHash('sha256')
    .update('skill-graft:p0-source-run:v1\0', 'utf8')
    .update(runId, 'utf8')
    .digest('hex')
}

const sourceRoot = absoluteDirectory('SKILL_GRAFT_FIXTURE_SOURCE')
const libraryRoot = absoluteDirectory('SKILL_GRAFT_LIBRARY_SOURCE')
const probeSource = absoluteDirectory('SKILL_GRAFT_PROBE_SOURCE')
const probeCommit = required('SKILL_GRAFT_PROBE_COMMIT')
const declaredProtectedRoots = String(process.env.SKILL_GRAFT_PROTECTED_ROOTS || '')
  .split(path.delimiter)
  .map((item) => item.trim())
  .filter(Boolean)
const fixedProbe = 'E:\\ozdqp-cli-attach-probe'
const liveSourceRoots = [...declaredProtectedRoots]
if (process.platform === 'win32') liveSourceRoots.push(fixedProbe)
assertSourceOutsideProtectedRoots(libraryRoot, liveSourceRoots, 'SKILL_GRAFT_LIBRARY_SOURCE')
assertSourceOutsideProtectedRoots(probeSource, liveSourceRoots, 'SKILL_GRAFT_PROBE_SOURCE')
const libraryRunRoot = path.resolve(libraryRoot, '..', '..')
const probeRunRoot = path.dirname(probeSource)
const librarySource = assertHistoricalRunSource(
  libraryRunRoot,
  path.join(libraryRunRoot, 'hub-data', 'skills'),
  libraryRoot,
  'SKILL_GRAFT_LIBRARY_SOURCE'
)
const probeSourceMetadata = assertHistoricalRunSource(
  probeRunRoot,
  path.join(probeRunRoot, 'probe'),
  probeSource,
  'SKILL_GRAFT_PROBE_SOURCE'
)
if (!samePath(libraryRunRoot, probeRunRoot)
  || !samePath(librarySource.canonicalRunRoot, probeSourceMetadata.canonicalRunRoot)
  || librarySource.marker.runId !== probeSourceMetadata.marker.runId
  || JSON.stringify(librarySource.fixture) !== JSON.stringify(probeSourceMetadata.fixture)) {
  throw new Error('SKILL_GRAFT_LIBRARY_SOURCE and SKILL_GRAFT_PROBE_SOURCE must originate from the same marker-owned P0 fixture v2 run')
}
const sourceFixture = librarySource.fixture
if (sourceFixture.version !== 2
  || !/^[0-9a-f]{40}$/i.test(String(sourceFixture.hubCommit || ''))
  || sourceFixture.probeCommit !== probeCommit
  || sourceFixture.probeCloneMode !== 'independent-no-local-no-hardlinks-no-checkout'
  || sourceFixture.probeAlternatesPresent !== false
  || sourceFixture.remoteRemoved !== true
  || sourceFixture.runtimeStateInitialized !== true) {
  throw new Error('library and probe sources must be a matching independent P0 fixture v2 run')
}
const sourcePhysicalSkills = assertPlainContainedTree(libraryRoot, libraryRunRoot, 'source hub-data/skills')
const protectedRoots = [sourceRoot, libraryRoot, probeSource, ...liveSourceRoots]
const context = validateRealE2eEnvironment(process.env, { workspaceRoot: sourceRoot, protectedRoots })
assertRunLayoutOwned(context)
assertEmptyDirectory(context.hubDataRoot, 'hub-data')
assertEmptyDirectory(context.probeRoot, 'probe')
const gitEnv = createIsolatedGitEnvironment(process.env, context.homeRoot)
assertIsolatedGitAttributesEnvironment(context, gitEnv)
const sourceHub = path.join(libraryRunRoot, 'hub-data')
const sourceGit = assertSourceGitProvenance(
  sourceHub,
  probeSource,
  sourceFixture,
  probeCommit,
  libraryRunRoot,
  sourcePhysicalSkills,
  gitEnv
)
const skillsMaterialization = sourceGit.materialization
const convertedFrom = sourceGit.convertedFrom

fs.copyFileSync(path.join(sourceRoot, 'AGENTS.override.md'), path.join(context.hubDataRoot, 'AGENTS.override.md'))
fs.cpSync(path.join(sourceRoot, 'overlay'), path.join(context.hubDataRoot, 'overlay'), { recursive: true })
for (const name of ['ozdqp-development', 'ozdqp-ui-development', 'ozdqp-git-workflow']) {
  const source = path.join(libraryRoot, name)
  if (!fs.existsSync(path.join(source, 'SKILL.md'))) throw new Error(`missing authoritative ${name}/SKILL.md`)
}
fs.copyFileSync(path.join(sourceHub, '.gitattributes'), path.join(context.hubDataRoot, '.gitattributes'))
fs.cpSync(libraryRoot, path.join(context.hubDataRoot, 'skills'), { recursive: true })
const targetPhysicalSkillsBeforeGit = assertPlainContainedTree(
  path.join(context.hubDataRoot, 'skills'),
  context.runRoot,
  'target hub-data/skills'
)
assertSamePhysicalSkills(targetPhysicalSkillsBeforeGit, sourcePhysicalSkills, 'copied target hub-data/skills')
const targetAttributesBeforeGit = assertPlainContainedFile(
  path.join(context.hubDataRoot, '.gitattributes'),
  context.runRoot,
  'target hub-data/.gitattributes'
)
if (targetAttributesBeforeGit.sha256 !== skillsMaterialization.attributesSha256) {
  throw new Error('copied target hub-data/.gitattributes digest does not match the verified source materialization')
}
fs.mkdirSync(path.join(context.hubDataRoot, 'skill-review', 'history'), { recursive: true })
fs.writeFileSync(path.join(context.hubDataRoot, 'overlay', 'attached-worktrees.txt'), '', 'utf8')
fs.writeFileSync(path.join(context.hubDataRoot, 'overlay', 'do-not-auto-attach.txt'), '', 'utf8')
fs.writeFileSync(path.join(context.hubDataRoot, 'overlay', 'scan-roots.txt'), `${path.dirname(context.probeRoot)}\n`, 'utf8')
fs.writeFileSync(path.join(context.hubDataRoot, 'skill-review', 'state.json'), '{\n  "version": 1,\n  "lastIngest": null,\n  "items": []\n}\n', 'utf8')
fs.writeFileSync(path.join(context.hubDataRoot, 'skill-review', 'sessions.json'), '{\n  "sessions": []\n}\n', 'utf8')
fs.writeFileSync(path.join(context.hubDataRoot, '.gitignore'), [
  'skill-review/state.json',
  'skill-review/sessions.json',
  'skill-review/application-ledger.json',
  'skill-review/application-audit.json',
  'skill-review/daemon.pid',
  'skill-review/api.pid',
  'skill-review/daemon-heartbeat.json',
  'skill-review/history/',
  'skill-review/prompt-*.txt',
  'skill-review/resume-*.txt',
  'skill-review/run-codex-*',
  'skill-review/session-*',
  'skill-review/*.log',
  ''
].join('\n'), 'utf8')

runGit(['init', '--initial-branch=main'], context.hubDataRoot, gitEnv)
runGit(['config', 'user.name', 'Skill Graft P0 E2E'], context.hubDataRoot, gitEnv)
runGit(['config', 'user.email', 'skill-graft-p0@invalid.local'], context.hubDataRoot, gitEnv)
runGit(['config', 'core.autocrlf', 'false'], context.hubDataRoot, gitEnv)
runGit(['config', 'core.safecrlf', 'true'], context.hubDataRoot, gitEnv)
runGit(['add', '--', '.gitattributes', '.gitignore', 'AGENTS.override.md', 'overlay', 'skills'], context.hubDataRoot, gitEnv)
runGit(['commit', '-m', 'P0 isolated hub fixture'], context.hubDataRoot, gitEnv)
const hubCommit = runGit(['rev-parse', 'HEAD'], context.hubDataRoot, gitEnv)
const targetSkillsTree = runGit(['rev-parse', 'HEAD:skills'], context.hubDataRoot, gitEnv)
if (targetSkillsTree !== skillsMaterialization.targetSkillsTree) {
  throw new Error('target hub-data HEAD:skills does not match the verified source materialization tree')
}
const targetPhysicalSkillsAfterGit = assertPlainContainedTree(
  path.join(context.hubDataRoot, 'skills'),
  context.runRoot,
  'committed target hub-data/skills'
)
assertSamePhysicalSkills(targetPhysicalSkillsAfterGit, sourcePhysicalSkills, 'committed target hub-data/skills')
assertSamePhysicalSkills(targetPhysicalSkillsAfterGit, targetPhysicalSkillsBeforeGit, 'committed target hub-data/skills')
const targetAttributesAfterGit = assertPlainContainedFile(
  path.join(context.hubDataRoot, '.gitattributes'),
  context.runRoot,
  'committed target hub-data/.gitattributes'
)
if (targetAttributesAfterGit.sha256 !== skillsMaterialization.attributesSha256) {
  throw new Error('committed target hub-data/.gitattributes digest does not match the verified source materialization')
}
const targetAttributesEntry = runGit(['ls-tree', 'HEAD', '--', '.gitattributes'], context.hubDataRoot, gitEnv)
const targetAttributesBlob = /^100644 blob ((?:[0-9a-f]{40}|[0-9a-f]{64}))\t\.gitattributes$/i.exec(targetAttributesEntry)
if (!targetAttributesBlob
  || !runGitBuffer(['cat-file', 'blob', targetAttributesBlob[1]], context.hubDataRoot, gitEnv).equals(sourceGit.attributes.contents)) {
  throw new Error('committed target hub-data/.gitattributes blob does not exactly match the verified source bytes')
}
if (runGit(['config', '--local', '--get', 'core.autocrlf'], context.hubDataRoot, gitEnv) !== 'false'
  || runGit(['config', '--local', '--get', 'core.safecrlf'], context.hubDataRoot, gitEnv) !== 'true') {
  throw new Error('target hub-data Git line-ending safety configuration is invalid')
}
const targetHubStatus = runGit(['status', '--porcelain=v1', '--untracked-files=all'], context.hubDataRoot, gitEnv)
if (targetHubStatus) throw new Error(`target hub-data must be clean after materialization commit:\n${targetHubStatus}`)

runGit(['cat-file', '-e', `${probeCommit}^{commit}`], probeSource, gitEnv)
runGit([
  'clone',
  '--no-local',
  '--no-hardlinks',
  '--no-checkout',
  probeSource,
  context.probeRoot
], context.runRoot, gitEnv)
const alternatesFile = path.join(context.probeRoot, '.git', 'objects', 'info', 'alternates')
if (fs.existsSync(alternatesFile)) {
  throw new Error(`independent probe clone unexpectedly retained an object alternate: ${alternatesFile}`)
}
runGit(['remote', 'remove', 'origin'], context.probeRoot, gitEnv)
runGit(['checkout', '--detach', probeCommit], context.probeRoot, gitEnv)
runGit(['config', 'user.name', 'Skill Graft P0 E2E'], context.probeRoot, gitEnv)
runGit(['config', 'user.email', 'skill-graft-p0@invalid.local'], context.probeRoot, gitEnv)
const checkedOut = runGit(['rev-parse', 'HEAD'], context.probeRoot, gitEnv)
const probeStatus = runGit(['status', '--porcelain=v1', '--untracked-files=all'], context.probeRoot, gitEnv)
if (probeStatus) throw new Error(`isolated probe is not clean after checkout:\n${probeStatus}`)
if (!fs.existsSync(path.join(context.probeRoot, 'AGENTS.md')) || !fs.existsSync(path.join(context.probeRoot, 'baloot_client'))) {
  throw new Error('isolated probe does not satisfy the OZDQP checkout contract')
}

const manifest = {
  version: 2,
  runId: context.runId,
  preparedAt: new Date().toISOString(),
  hubCommit,
  probeCommit: checkedOut,
  probeCloneMode: 'independent-no-local-no-hardlinks-no-checkout',
  probeAlternatesPresent: false,
  remoteRemoved: true,
  runtimeStateInitialized: true,
  sourceProvenance: {
    schemaVersion: 1,
    runIdentitySha256: sourceRunIdentity(librarySource.marker.runId),
    fixtureVersion: sourceFixture.version,
    hubCommit: sourceGit.hubHead,
    probeCommit: sourceGit.probeHead,
    probeCloneMode: sourceFixture.probeCloneMode,
    probeAlternatesPresent: sourceFixture.probeAlternatesPresent,
    remoteRemoved: sourceFixture.remoteRemoved,
    declaredHubCommit: convertedFrom.declaredHubCommit,
    actualHubCommit: convertedFrom.actualHubCommit,
    skillsTree: convertedFrom.skillsTree,
    physicalSkillsSha256: convertedFrom.physicalSkillsSha256,
    physicalSkillsContentSha256: convertedFrom.physicalSkillsContentSha256,
    probeProjectionKind: convertedFrom.probeProjectionKind,
    probeProjectionSha256: convertedFrom.probeProjectionSha256,
    probeProjectionEntries: convertedFrom.probeProjectionEntries,
    skillsMaterializationPolicy: skillsMaterialization.policy,
    skillsGitManifestSha256: skillsMaterialization.gitManifestSha256,
    skillsProjectionSha256: skillsMaterialization.projectionSha256,
    skillsProjectionEntries: skillsMaterialization.projectionEntries,
    skillsExactEntries: skillsMaterialization.exactEntries,
    skillsCrlfEntries: skillsMaterialization.crlfEntries,
    skillsAttributesSha256: skillsMaterialization.attributesSha256,
    targetSkillsTree: skillsMaterialization.targetSkillsTree
  }
}
fs.writeFileSync(path.join(context.runRoot, '.skill-graft-p0-fixture.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify({ ok: true, ...manifest }, null, 2)}\n`)
