import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { TextDecoder } from 'node:util'
import {
  assertRunLayoutOwned,
  createIsolatedGitEnvironment,
  validateRealE2eEnvironment
} from './real-e2e.mjs'

const RUN_MARKER = '.skill-graft-e2e-run.json'
const FIXTURE_MANIFEST = '.skill-graft-p0-fixture.json'
const REQUIRED_SKILLS = ['ozdqp-development', 'ozdqp-ui-development', 'ozdqp-git-workflow']
const INDEPENDENT_CLONE_MODE = 'independent-no-local-no-hardlinks-no-checkout'
const ALLOWED_EMPTY_SKILLS_DIRECTORIES = new Set(['adopted', 'inbox'])
const ALLOWED_GIT_BLOB_MODES = new Set(['100644', '100755'])
const MATERIALIZATION_POLICY = 'git-blob-exact-or-strict-crlf-v1'
const GENERATED_ATTRIBUTES_HEADER = '# Skill Graft generated skills worktree policy v1'
const P0_V2_CLEAN_PROJECTION_SHA256 = createHash('sha256')
  .update('skill-graft:p0-v2-clean-projection:v1\0', 'utf8')
  .digest('hex')
const FATAL_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function required(name) {
  const value = String(process.env[name] || '').trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function absoluteDirectory(name) {
  const value = required(name)
  if (!path.isAbsolute(value)) throw new Error(`${name} must be absolute`)
  const resolved = path.resolve(value)
  assertPlainDirectory(resolved, name)
  return resolved
}

function comparable(target) {
  const resolved = path.resolve(target)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function samePath(left, right) {
  return comparable(left) === comparable(right)
}

function isSameOrInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  )
}

function canonicalize(target) {
  const resolved = path.resolve(target)
  const suffix = []
  let cursor = resolved
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor)
    if (samePath(parent, cursor)) break
    suffix.unshift(path.basename(cursor))
    cursor = parent
  }
  const existing = fs.existsSync(cursor) ? fs.realpathSync.native(cursor) : cursor
  return path.resolve(existing, ...suffix)
}

function assertPlainDirectory(target, label) {
  if (!fs.existsSync(target)) throw new Error(`${label} is not a directory: ${target}`)
  const stat = fs.lstatSync(target)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a plain directory, not a link or reparse point: ${target}`)
  }
  return target
}

function assertPlainFile(target, label) {
  if (!fs.existsSync(target)) throw new Error(`${label} is missing: ${target}`)
  const stat = fs.lstatSync(target)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a plain file, not a link or reparse point: ${target}`)
  }
  return target
}

function assertPathInside(root, target, label) {
  const canonicalRoot = fs.realpathSync.native(root)
  const canonicalTarget = fs.realpathSync.native(target)
  if (!isSameOrInside(canonicalRoot, canonicalTarget)) {
    throw new Error(`${label} escaped its marker-owned root: ${canonicalTarget}`)
  }
  return canonicalTarget
}

function readJsonFile(file, label) {
  assertPlainFile(file, label)
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`${label} must contain valid JSON: ${error instanceof Error ? error.message : error}`)
  }
}

function readHistoricalMetadata(sourceRun) {
  const markerFile = path.join(sourceRun, RUN_MARKER)
  const manifestFile = path.join(sourceRun, FIXTURE_MANIFEST)
  const marker = readJsonFile(markerFile, 'historical run ownership marker')
  const manifest = readJsonFile(manifestFile, 'historical P0 fixture manifest')
  if (marker.version !== 1
    || typeof marker.runId !== 'string'
    || !marker.runId
    || !path.isAbsolute(String(marker.runRoot || ''))
    || !samePath(marker.runRoot, sourceRun)
    || !samePath(path.basename(sourceRun), marker.runId)) {
    throw new Error('historical run ownership marker does not own SKILL_GRAFT_P0_SOURCE_RUN')
  }
  if (![1, 2].includes(manifest.version) || manifest.runId !== marker.runId) {
    throw new Error('historical P0 fixture manifest must be marker-owned version 1 or 2')
  }
  for (const field of ['hubCommit', 'probeCommit']) {
    if (!/^[0-9a-f]{40}$/i.test(String(manifest[field] || ''))) {
      throw new Error(`historical P0 fixture manifest has an invalid ${field}`)
    }
  }
  if (manifest.remoteRemoved !== true || manifest.runtimeStateInitialized !== true) {
    throw new Error('historical P0 fixture manifest is missing completed P0 state')
  }
  if (manifest.version === 1 && manifest.probeCloneMode !== 'shared-no-checkout') {
    throw new Error('historical P0 fixture v1 must declare shared-no-checkout')
  }
  if (manifest.version === 2 && (
    manifest.probeCloneMode !== INDEPENDENT_CLONE_MODE
    || manifest.probeAlternatesPresent !== false
  )) {
    throw new Error('historical P0 fixture v2 does not satisfy the independent clone contract')
  }
  return { marker, manifest, markerFile, manifestFile }
}

function assertEmptyPlainDirectory(target, label) {
  assertPlainDirectory(target, label)
  if (fs.readdirSync(target).length > 0) {
    throw new Error(`${label} must be empty before independent P0 source preparation: ${target}`)
  }
}

function runGit(args, cwd, env, { allowStatus = [] } = {}) {
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
    timeout: 120000,
    maxBuffer: 32 * 1024 * 1024
  })
  if (result.error) throw new Error(`git ${args.join(' ')} could not start: ${result.error.message}`)
  if (result.status !== 0 && !allowStatus.includes(result.status)) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return { status: result.status, stdout: String(result.stdout || '').trim() }
}

function runGitBuffer(args, cwd, env, { allowStatus = [] } = {}) {
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
    timeout: 120000,
    maxBuffer: 64 * 1024 * 1024
  })
  if (result.error) throw new Error(`Git fingerprint command could not start: ${result.error.message}`)
  if (result.status !== 0 && !allowStatus.includes(result.status)) {
    throw new Error(`Git fingerprint command failed with status ${result.status}`)
  }
  return { status: result.status, stdout: Buffer.from(result.stdout || []) }
}

function alternateRoots(probeRoot) {
  const objectsRoot = path.join(probeRoot, '.git', 'objects')
  assertPlainDirectory(path.join(probeRoot, '.git'), 'historical probe .git')
  assertPlainDirectory(objectsRoot, 'historical probe object database')
  const roots = []
  const seen = new Set()
  const queue = [objectsRoot]
  while (queue.length > 0) {
    const objectDatabase = queue.shift()
    const alternatesFile = path.join(objectDatabase, 'info', 'alternates')
    if (!fs.existsSync(alternatesFile)) continue
    assertPlainFile(alternatesFile, 'historical probe alternates file')
    const lines = fs.readFileSync(alternatesFile, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    for (const line of lines) {
      if (line.startsWith('"') || line.endsWith('"')) {
        throw new Error(`quoted Git alternate paths are not supported by the bounded converter: ${line}`)
      }
      const resolved = path.isAbsolute(line)
        ? path.resolve(line)
        : path.resolve(objectDatabase, line)
      const key = comparable(resolved)
      if (seen.has(key)) continue
      if (seen.size >= 32) throw new Error('historical probe has too many chained alternate object databases')
      assertPlainDirectory(resolved, 'historical probe alternate object database')
      seen.add(key)
      roots.push(resolved)
      queue.push(resolved)
    }
  }
  return roots
}

function fileDigest(file, expectedStat) {
  const hash = createHash('sha256')
  const descriptor = fs.openSync(file, 'r')
  const buffer = Buffer.allocUnsafe(128 * 1024)
  try {
    for (;;) {
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null)
      if (bytes === 0) break
      hash.update(buffer.subarray(0, bytes))
    }
  } finally {
    fs.closeSync(descriptor)
  }
  const after = fs.lstatSync(file, { bigint: true })
  if (after.size !== expectedStat.size
    || after.mtimeNs !== expectedStat.mtimeNs
    || after.ctimeNs !== expectedStat.ctimeNs) {
    throw new Error(`protected file changed while it was being fingerprinted: ${file}`)
  }
  return hash.digest('hex')
}

function treeFingerprint(root, { linkBoundary = null } = {}) {
  const hash = createHash('sha256')
  let entries = 0
  let bytes = 0n
  const canonicalBoundary = linkBoundary ? fs.realpathSync.native(linkBoundary) : null
  const visit = (target, relative) => {
    const before = fs.lstatSync(target, { bigint: true })
    entries += 1
    const normalized = relative.replaceAll('\\', '/') || '.'
    if (before.isSymbolicLink()) {
      const link = fs.readlinkSync(target)
      if (canonicalBoundary) {
        let linked
        try {
          linked = fs.realpathSync.native(target)
        } catch (error) {
          throw new Error(`source link is broken and cannot be proven contained: ${target}: ${error instanceof Error ? error.message : error}`)
        }
        if (!isSameOrInside(canonicalBoundary, linked)) {
          throw new Error(`source link or reparse point escaped its marker-owned run: ${target} -> ${linked}`)
        }
      }
      hash.update(`l\0${normalized}\0${before.mode}\0${link}\0`, 'utf8')
      return
    }
    if (before.isDirectory()) {
      hash.update(`d\0${normalized}\0${before.mode}\0`, 'utf8')
      const children = fs.readdirSync(target, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name, 'en'))
      for (const child of children) visit(path.join(target, child.name), path.join(relative, child.name))
      const after = fs.lstatSync(target, { bigint: true })
      if (after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
        throw new Error(`protected directory changed while it was being fingerprinted: ${target}`)
      }
      return
    }
    if (before.isFile()) {
      bytes += before.size
      hash.update(`f\0${normalized}\0${before.mode}:${before.size}\0${fileDigest(target, before)}\0`, 'utf8')
      return
    }
    hash.update(`o\0${normalized}\0${before.mode}:${before.size}\0`, 'utf8')
  }
  if (!fs.existsSync(root)) return { exists: false, sha256: '', entries: 0, bytes: '0' }
  visit(root, '')
  return { exists: true, sha256: hash.digest('hex'), entries, bytes: bytes.toString() }
}

function parseNullPaths(buffer) {
  const text = buffer.toString('utf8')
  const paths = text.split('\0')
  if (paths.at(-1) === '') paths.pop()
  return paths
}

function assertSafeGitRelativePath(relative) {
  const normalized = path.normalize(relative)
  if (!relative
    || path.isAbsolute(relative)
    || normalized === '..'
    || normalized.startsWith(`..${path.sep}`)) {
    throw new Error('Git fingerprint returned a path outside its worktree')
  }
  return normalized
}

function hashGitWorktreeEntry(root, relative, hash, counters, domain) {
  const normalized = assertSafeGitRelativePath(relative)
  const target = path.resolve(root, normalized)
  if (!isSameOrInside(root, target)) throw new Error('Git fingerprint path escaped its worktree')
  const portable = relative.replaceAll('\\', '/')
  if (!fs.existsSync(target)) {
    hash.update(`${domain}\0missing\0${portable}\0`, 'utf8')
    counters.entries += 1
    return
  }
  const stat = fs.lstatSync(target, { bigint: true })
  counters.entries += 1
  if (stat.isSymbolicLink()) {
    hash.update(`${domain}\0link\0${portable}\0${stat.mode}\0${fs.readlinkSync(target)}\0`, 'utf8')
    return
  }
  if (stat.isFile()) {
    counters.bytes += stat.size
    hash.update(`${domain}\0file\0${portable}\0${stat.mode}:${stat.size}\0${fileDigest(target, stat)}\0`, 'utf8')
    return
  }
  if (stat.isDirectory()) {
    hash.update(`${domain}\0directory\0${portable}\0${stat.mode}\0`, 'utf8')
    return
  }
  hash.update(`${domain}\0other\0${portable}\0${stat.mode}:${stat.size}\0`, 'utf8')
}

function gitWorktreeFingerprint(root, gitEnv) {
  const snapshot = () => ({
    head: runGitBuffer(['rev-parse', 'HEAD'], root, gitEnv).stdout,
    index: runGitBuffer(['ls-files', '--stage', '-z'], root, gitEnv).stdout,
    tracked: runGitBuffer(['ls-files', '-z'], root, gitEnv).stdout,
    untracked: runGitBuffer(['ls-files', '--others', '--exclude-standard', '-z'], root, gitEnv).stdout
  })
  const before = snapshot()
  const hash = createHash('sha256')
  const counters = { entries: 0, bytes: 0n }
  hash.update('skill-graft:git-worktree-fingerprint:v2\0', 'utf8')
  for (const [name, value] of [
    ['head', before.head],
    ['index', before.index],
    ['tracked', before.tracked],
    ['untracked', before.untracked]
  ]) {
    hash.update(`${name}\0`, 'utf8')
    hash.update(value)
    hash.update('\0', 'utf8')
  }
  for (const relative of parseNullPaths(before.tracked)) {
    hashGitWorktreeEntry(root, relative, hash, counters, 'tracked')
  }
  for (const relative of parseNullPaths(before.untracked)) {
    hashGitWorktreeEntry(root, relative, hash, counters, 'untracked')
  }

  const after = snapshot()
  if (!after.head.equals(before.head)
    || !after.index.equals(before.index)
    || !after.tracked.equals(before.tracked)
    || !after.untracked.equals(before.untracked)) {
    throw new Error('Git worktree changed while it was being fingerprinted')
  }
  return {
    exists: true,
    mode: 'git-worktree-semantic-v2',
    sha256: hash.digest('hex'),
    entries: counters.entries,
    bytes: counters.bytes.toString()
  }
}

function isGitWorktreeRoot(root, gitEnv) {
  if (!fs.existsSync(root)) return false
  const result = runGitBuffer(['rev-parse', '--show-toplevel'], root, gitEnv, { allowStatus: [128] })
  if (result.status !== 0) return false
  const topLevel = result.stdout.toString('utf8').trim()
  return Boolean(topLevel) && samePath(canonicalize(topLevel), canonicalize(root))
}

function rootIdentity(root) {
  return createHash('sha256')
    .update('skill-graft:protected-root-identity:v1\0', 'utf8')
    .update(comparable(root), 'utf8')
    .digest('hex')
}

function watchRoots(candidates, gitEnv) {
  const roots = []
  for (const candidate of candidates.filter((item) => item?.root)) {
    if (!path.isAbsolute(candidate.root)) throw new Error(`protected fingerprint root must be absolute: ${candidate.root}`)
    const canonical = canonicalize(candidate.root)
    const mode = candidate.forceFullTree || !isGitWorktreeRoot(canonical, gitEnv)
      ? 'full-tree'
      : 'git-worktree'
    const key = `${comparable(canonical)}\0${mode}`
    if (roots.some((root) => root.key === key)) continue
    roots.push({ key, root: canonical, mode, identity: rootIdentity(canonical) })
  }
  return roots.sort((left, right) => left.identity.localeCompare(right.identity, 'en'))
}

function fingerprintSet(watches, sourceRun, gitEnv) {
  let canonicalSource
  try {
    canonicalSource = fs.realpathSync.native(sourceRun)
  } catch {
    throw new Error(`protected fingerprint failed for rootIdentitySha256=${rootIdentity(sourceRun)}`)
  }
  return watches.map((watch) => {
    try {
      const fingerprint = watch.mode === 'git-worktree'
        ? gitWorktreeFingerprint(watch.root, gitEnv)
        : treeFingerprint(watch.root, {
            linkBoundary: isSameOrInside(canonicalSource, watch.root) ? canonicalSource : null
          })
      return { identity: watch.identity, mode: watch.mode, fingerprint }
    } catch {
      // Never retain the underlying error: filesystem and Git failures commonly
      // include the protected absolute path in their message or stack.
      throw new Error(`protected fingerprint failed for rootIdentitySha256=${watch.identity}`)
    }
  })
}

function fingerprintDigest(value) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
}

function assertFingerprintsUnchanged(before, after) {
  if (before.length !== after.length) throw new Error('protected fingerprint watch set changed during conversion')
  for (let index = 0; index < before.length; index += 1) {
    const left = before[index]
    const right = after[index]
    if (left.identity !== right.identity || left.mode !== right.mode || JSON.stringify(left.fingerprint) !== JSON.stringify(right.fingerprint)) {
      throw new Error([
        'historical P0 source or a protected root changed during conversion',
        `rootIdentitySha256=${left.identity}`,
        `beforeFingerprintSha256=${fingerprintDigest(left.fingerprint)}`,
        `afterFingerprintSha256=${fingerprintDigest(right.fingerprint)}`
      ].join(' '))
    }
  }
}

function assertNoGitControlEntry(relative, label) {
  const segments = relative.split(path.sep)
  if (segments.some((segment) => segment.toLowerCase() === '.git')) {
    throw new Error(`${label} contains a nested Git control path: ${relative}`)
  }
}

function copyPlainTree(source, destination, label, relative = '') {
  const stat = fs.lstatSync(source)
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} contains a link or reparse point: ${source}`)
  }
  if (relative) assertNoGitControlEntry(relative, label)
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { mode: stat.mode & 0o777 })
    const children = fs.readdirSync(source, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const child of children) {
      copyPlainTree(
        path.join(source, child.name),
        path.join(destination, child.name),
        label,
        path.join(relative, child.name)
      )
    }
    return
  }
  if (!stat.isFile()) throw new Error(`${label} contains an unsupported filesystem entry: ${source}`)
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL)
  fs.chmodSync(destination, stat.mode & 0o777)
}

function applyVerifiedGitModes(targetHub, verifiedGitManifest, gitEnv) {
  for (const mode of ALLOWED_GIT_BLOB_MODES) {
    const paths = verifiedGitManifest.entries
      .filter((entry) => entry.type === 'file' && entry.mode === mode)
      .map((entry) => `skills/${entry.path}`)
    for (let offset = 0; offset < paths.length; offset += 50) {
      runGit([
        'update-index',
        mode === '100755' ? '--chmod=+x' : '--chmod=-x',
        '--',
        ...paths.slice(offset, offset + 50)
      ], targetHub, gitEnv)
    }
  }
}

function materializeSkillsFromGit(targetSkills, verifiedSourceSkills) {
  fs.mkdirSync(targetSkills)
  const directories = new Set([
    ...verifiedSourceSkills.gitManifest.entries
      .filter((entry) => entry.type === 'directory')
      .map((entry) => entry.path),
    ...ALLOWED_EMPTY_SKILLS_DIRECTORIES
  ])
  for (const entryPath of [...directories].sort((left, right) => {
    const depth = left.split('/').length - right.split('/').length
    return depth || gitPathCompare(left, right)
  })) {
    assertSafeAttributesPath(entryPath)
    fs.mkdirSync(path.join(targetSkills, ...entryPath.split('/')))
  }
  const projections = new Map(verifiedSourceSkills.projection.entries.map((entry) => [entry.path, entry]))
  for (const gitEntry of verifiedSourceSkills.gitManifest.entries.filter((entry) => entry.type === 'file')) {
    const blob = verifiedSourceSkills.gitManifest.blobs.get(gitEntry.path)
    const projection = projections.get(gitEntry.path)
    if (!blob || !projection) throw new Error('verified skills materialization input is incomplete')
    const contents = projection.kind === 'strict-crlf' ? expandLfToCrlf(blob) : blob
    const target = path.join(targetSkills, ...gitEntry.path.split('/'))
    fs.writeFileSync(target, contents, { flag: 'wx', mode: gitEntry.mode === '100755' ? 0o755 : 0o644 })
    fs.chmodSync(target, gitEntry.mode === '100755' ? 0o755 : 0o644)
  }
}

function assertTargetPhysicalManifest(targetSkills, verifiedSourceSkills, boundary, label) {
  const physical = plainTreeManifest(targetSkills, boundary, label)
  assertPhysicalSkillsStructureMatchesGit(physical, verifiedSourceSkills.gitManifest, label)
  assertPhysicalSkillsMatchesProjection(physical, verifiedSourceSkills.projection, label)
  if (physical.sha256 !== verifiedSourceSkills.physicalSha256
    || contentManifestSha256(physical.fileEntries) !== verifiedSourceSkills.contentSha256
    || JSON.stringify(physical.structureEntries) !== JSON.stringify(verifiedSourceSkills.structureEntries)) {
    throw new Error(`${label} does not preserve the verified source physical skills tree`)
  }
  return physical
}

function verifyIndependentHubCheckout(context, targetHub, verifiedSourceSkills, gitEnv) {
  const checkout = path.join(context.runRoot, 'hub-roundtrip-verification')
  if (fs.existsSync(checkout)) throw new Error('target-owned Hub round-trip verification path already exists')
  const targetCommit = runGit(['rev-parse', 'HEAD'], targetHub, gitEnv).stdout
  runGit(['clone', '--no-local', '--no-hardlinks', '--no-tags', '--no-checkout', targetHub, checkout], context.runRoot, gitEnv)
  const alternatesFile = path.join(checkout, '.git', 'objects', 'info', 'alternates')
  if (fs.existsSync(alternatesFile)) throw new Error('independent target Hub checkout retained an object alternate')
  runGit(['config', 'core.autocrlf', 'false'], checkout, gitEnv)
  runGit(['config', 'core.safecrlf', 'true'], checkout, gitEnv)
  runGit(['checkout', '--detach', targetCommit], checkout, gitEnv)
  if (fs.existsSync(alternatesFile)) throw new Error('independent target Hub checkout gained an object alternate')
  for (const name of ALLOWED_EMPTY_SKILLS_DIRECTORIES) {
    const directory = path.join(checkout, 'skills', name)
    if (!fs.existsSync(directory)) fs.mkdirSync(directory)
  }
  const attributes = fs.readFileSync(assertPlainFile(path.join(checkout, '.gitattributes'), 'round-trip generated .gitattributes'), 'utf8')
  if (attributes !== verifiedSourceSkills.projection.attributes) {
    throw new Error('independent target Hub checkout changed the generated attributes policy')
  }
  const tree = runGit(['rev-parse', 'HEAD:skills'], checkout, gitEnv).stdout
  if (tree !== verifiedSourceSkills.treeOid) throw new Error('independent target Hub checkout changed the skills tree OID')
  assertTargetPhysicalManifest(
    path.join(checkout, 'skills'),
    verifiedSourceSkills,
    checkout,
    'independent target Hub checkout skills'
  )
  const status = runGit(['status', '--porcelain=v1', '--untracked-files=all'], checkout, gitEnv).stdout
  if (status) throw new Error('independent target Hub checkout is not clean after physical projection verification')
  if (!isSameOrInside(context.runRoot, checkout) || samePath(context.runRoot, checkout)) {
    throw new Error('round-trip verification cleanup escaped the target run')
  }
  fs.rmSync(checkout, { recursive: true, force: false })
}

function initializeHubFixture(packageRoot, verifiedSourceSkills, context, gitEnv) {
  const overrideSource = assertPlainFile(path.join(packageRoot, 'AGENTS.override.md'), 'package AGENTS.override.md')
  const overlaySource = assertPlainDirectory(path.join(packageRoot, 'overlay'), 'package overlay')
  const targetOverride = path.join(context.hubDataRoot, 'AGENTS.override.md')
  fs.copyFileSync(overrideSource, targetOverride, fs.constants.COPYFILE_EXCL)
  copyPlainTree(overlaySource, path.join(context.hubDataRoot, 'overlay'), 'package overlay')
  const targetSkills = path.join(context.hubDataRoot, 'skills')
  materializeSkillsFromGit(targetSkills, verifiedSourceSkills)
  const materializedSkills = assertTargetPhysicalManifest(
    targetSkills,
    verifiedSourceSkills,
    context.runRoot,
    'materialized target hub-data/skills'
  )
  fs.writeFileSync(path.join(context.hubDataRoot, '.gitattributes'), verifiedSourceSkills.projection.attributes, {
    encoding: 'utf8',
    flag: 'wx'
  })

  for (const name of REQUIRED_SKILLS) {
    assertPlainFile(path.join(context.hubDataRoot, 'skills', name, 'SKILL.md'), `historical ${name}/SKILL.md`)
  }
  for (const name of ['adopted', 'inbox']) {
    const directory = path.join(context.hubDataRoot, 'skills', name)
    assertPlainDirectory(directory, `historical skills/${name}`)
  }
  assertTargetPhysicalManifest(targetSkills, verifiedSourceSkills, context.runRoot, 'initialized target hub-data/skills')
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
  applyVerifiedGitModes(context.hubDataRoot, verifiedSourceSkills.gitManifest, gitEnv)
  assertGitSkillsManifestEqual(
    gitIndexSkillsManifest(context.hubDataRoot, gitEnv),
    verifiedSourceSkills.gitManifest,
    'staged target Git skills manifest'
  )
  const stagedSkillsTree = runGit(['write-tree', '--prefix=skills/'], context.hubDataRoot, gitEnv).stdout
  if (stagedSkillsTree !== verifiedSourceSkills.treeOid) {
    throw new Error('staged target Git skills tree OID does not match the verified source skills tree')
  }
  runGit(['commit', '-m', 'P0 isolated hub fixture'], context.hubDataRoot, gitEnv)
  const hubCommit = runGit(['rev-parse', 'HEAD'], context.hubDataRoot, gitEnv).stdout
  const committedSkillsTree = runGit(['rev-parse', `${hubCommit}:skills`], context.hubDataRoot, gitEnv).stdout
  if (committedSkillsTree !== verifiedSourceSkills.treeOid) {
    throw new Error('committed target Git skills tree OID does not match the verified source skills tree')
  }
  assertGitSkillsManifestEqual(
    gitSkillsManifest(context.hubDataRoot, hubCommit, gitEnv),
    verifiedSourceSkills.gitManifest,
    'committed target Git skills manifest'
  )
  assertTargetPhysicalManifest(targetSkills, verifiedSourceSkills, context.runRoot, 'committed target hub-data/skills')
  const status = runGit(['status', '--porcelain=v1', '--untracked-files=all'], context.hubDataRoot, gitEnv).stdout
  if (status) throw new Error(`converted hub-data is not clean:\n${status}`)
  verifyIndependentHubCheckout(context, context.hubDataRoot, verifiedSourceSkills, gitEnv)
  return {
    hubCommit,
    skillsContentSha256: contentManifestSha256(materializedSkills.fileEntries),
    materialization: {
      version: 1,
      policy: MATERIALIZATION_POLICY,
      gitManifestSha256: verifiedSourceSkills.gitManifest.sha256,
      projectionSha256: verifiedSourceSkills.projection.sha256,
      projectionEntries: verifiedSourceSkills.projection.entries.length,
      exactEntries: verifiedSourceSkills.projection.exactEntries,
      crlfEntries: verifiedSourceSkills.projection.crlfEntries,
      attributesSha256: verifiedSourceSkills.projection.attributesSha256,
      targetSkillsTree: verifiedSourceSkills.treeOid,
      physicalSkillsSha256: verifiedSourceSkills.physicalSha256,
      physicalSkillsContentSha256: verifiedSourceSkills.contentSha256
    }
  }
}

function assertTreeLinksContained(root, boundary, label) {
  const canonicalBoundary = fs.realpathSync.native(boundary)
  const visit = (target) => {
    const stat = fs.lstatSync(target)
    if (stat.isSymbolicLink()) {
      const linked = fs.realpathSync.native(target)
      if (!isSameOrInside(canonicalBoundary, linked)) {
        throw new Error(`${label} link or reparse point escaped the target run: ${target} -> ${linked}`)
      }
      return
    }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(target)) visit(path.join(target, name))
    }
  }
  visit(root)
}

function plainTreeManifest(root, boundary, label) {
  const canonicalBoundary = fs.realpathSync.native(boundary)
  const hash = createHash('sha256')
  const files = []
  const fileEntries = []
  const structureEntries = []
  let entries = 0
  let bytes = 0n
  const visit = (target, relative) => {
    const stat = fs.lstatSync(target, { bigint: true })
    const portable = relative.replaceAll('\\', '/') || '.'
    if (stat.isSymbolicLink()) throw new Error(`${label} contains a link or reparse point`)
    const canonical = fs.realpathSync.native(target)
    if (!isSameOrInside(canonicalBoundary, canonical)) throw new Error(`${label} escaped its marker-owned run`)
    entries += 1
    if (stat.isDirectory()) {
      hash.update(`d\0${portable}\0${stat.mode}\0`, 'utf8')
      if (relative) structureEntries.push({ path: portable, type: 'directory' })
      const children = fs.readdirSync(target, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name, 'en'))
      for (const child of children) visit(path.join(target, child.name), path.join(relative, child.name))
      return
    }
    if (!stat.isFile()) throw new Error(`${label} contains a non-regular filesystem object`)
    bytes += stat.size
    files.push(portable)
    const sha256 = fileDigest(target, stat)
    const fileEntry = { path: portable, sha256, size: stat.size.toString() }
    fileEntries.push(fileEntry)
    structureEntries.push({ ...fileEntry, type: 'file' })
    hash.update(`f\0${portable}\0${stat.mode}:${stat.size}\0${sha256}\0`, 'utf8')
  }
  visit(root, '')
  return {
    sha256: hash.digest('hex'),
    files: sortGitPaths(files),
    fileEntries: fileEntries.sort((left, right) => gitPathCompare(left.path, right.path)),
    structureEntries: structureEntries.sort(compareManifestEntries),
    entries,
    bytes: bytes.toString()
  }
}

function gitPathCompare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function sortGitPaths(values) {
  return [...values].sort(gitPathCompare)
}

function compareManifestEntries(left, right) {
  const byPath = gitPathCompare(left.path, right.path)
  return byPath || String(left.type).localeCompare(String(right.type), 'en')
}

function contentManifestSha256(entries) {
  return createHash('sha256')
    .update('skill-graft:skills-content-manifest:v1\0', 'utf8')
    .update(JSON.stringify(entries.map(({ path: entryPath, sha256 }) => ({ path: entryPath, sha256 }))), 'utf8')
    .digest('hex')
}

function gitManifestSha256(entries) {
  return createHash('sha256')
    .update('skill-graft:skills-git-manifest:v1\0', 'utf8')
    .update(JSON.stringify(entries), 'utf8')
    .digest('hex')
}

function assertGitSkillsPath(relative) {
  const portable = relative.replaceAll('\\', '/')
  const normalized = path.posix.normalize(portable)
  if (!portable
    || portable.startsWith('/')
    || normalized === '..'
    || normalized.startsWith('../')
    || normalized !== portable) {
    throw new Error('historical Git skills tree contains an unsafe path')
  }
  return portable
}

function finalizeGitSkillsManifest(entries, blobs = new Map()) {
  entries.sort(compareManifestEntries)
  const files = entries.filter((entry) => entry.type === 'file')
  return {
    entries,
    sha256: gitManifestSha256(entries),
    contentSha256: contentManifestSha256(files),
    blobs
  }
}

function gitSkillsManifest(sourceHub, commit, gitEnv) {
  const raw = runGitBuffer(['ls-tree', '-r', '-t', '-z', `${commit}:skills`], sourceHub, gitEnv).stdout
  const entries = []
  const blobs = new Map()
  for (const record of parseNullPaths(raw)) {
    const separator = record.indexOf('\t')
    const header = separator >= 0 ? record.slice(0, separator) : ''
    const relative = separator >= 0 ? record.slice(separator + 1) : ''
    const [mode, type, objectId] = header.split(' ')
    if (!relative || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(String(objectId || ''))) {
      throw new Error('historical Git skills tree contains an unsupported entry')
    }
    const entryPath = assertGitSkillsPath(relative)
    if (type === 'tree') {
      if (mode !== '040000') throw new Error('historical Git skills tree contains an unsupported directory mode')
      entries.push({ path: entryPath, type: 'directory', mode })
      continue
    }
    if (type !== 'blob' || !ALLOWED_GIT_BLOB_MODES.has(mode)) {
      throw new Error('historical Git skills tree contains a symlink, submodule, or unsupported blob mode')
    }
    const contents = runGitBuffer(['cat-file', 'blob', objectId], sourceHub, gitEnv).stdout
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
  const raw = runGitBuffer(['ls-files', '--stage', '-z', '--', 'skills'], sourceHub, gitEnv).stdout
  const files = []
  const directories = new Set()
  for (const record of parseNullPaths(raw)) {
    const separator = record.indexOf('\t')
    const header = separator >= 0 ? record.slice(0, separator) : ''
    const trackedPath = separator >= 0 ? record.slice(separator + 1).replaceAll('\\', '/') : ''
    const [mode, objectId, stage] = header.split(' ')
    if (!trackedPath.startsWith('skills/')
      || stage !== '0'
      || !ALLOWED_GIT_BLOB_MODES.has(mode)
      || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(String(objectId || ''))) {
      throw new Error('target Git skills index contains an unsupported entry')
    }
    const entryPath = assertGitSkillsPath(trackedPath.slice('skills/'.length))
    const objectType = runGit(['cat-file', '-t', objectId], sourceHub, gitEnv).stdout
    if (objectType !== 'blob') throw new Error('target Git skills index contains a non-blob entry')
    const contents = runGitBuffer(['cat-file', 'blob', objectId], sourceHub, gitEnv).stdout
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
  ])
}

function assertGitSkillsManifestEqual(actual, expected, label) {
  if (actual.sha256 !== expected.sha256 || JSON.stringify(actual.entries) !== JSON.stringify(expected.entries)) {
    throw new Error(`${label} does not match the verified source Git skills structure, content, and modes`)
  }
}

function assertPhysicalSkillsStructureMatchesGit(physical, gitManifest, label) {
  const physicalByPath = new Map(physical.structureEntries.map((entry) => [entry.path, entry]))
  const gitByPath = new Map(gitManifest.entries.map((entry) => [entry.path, entry]))
  for (const requiredDirectory of ALLOWED_EMPTY_SKILLS_DIRECTORIES) {
    if (physicalByPath.get(requiredDirectory)?.type !== 'directory') {
      throw new Error(`${label} must contain the explicit ${requiredDirectory} directory`)
    }
  }
  for (const [entryPath, expected] of gitByPath) {
    const actual = physicalByPath.get(entryPath)
    if (!actual || actual.type !== expected.type) {
      throw new Error(`${label} directory/file structure does not match its Git tree`)
    }
  }
  for (const [entryPath, actual] of physicalByPath) {
    if (gitByPath.has(entryPath)) continue
    const hasChildren = physical.structureEntries.some((entry) => entry.path.startsWith(`${entryPath}/`))
    if (actual.type !== 'directory'
      || hasChildren
      || !ALLOWED_EMPTY_SKILLS_DIRECTORIES.has(entryPath)) {
      throw new Error(`${label} contains an untracked directory or file outside the adopted/inbox empty-directory allowance`)
    }
  }
}

function assertSafeAttributesPath(entryPath) {
  if (!/^[A-Za-z0-9._/-]+$/.test(entryPath)
    || entryPath.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('skills path cannot be encoded safely in the generated attributes policy')
  }
  return entryPath
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
  assertPhysicalSkillsStructureMatchesGit(physical, gitManifest, 'historical physical skills tree')
  const physicalFiles = new Map(physical.fileEntries.map((entry) => [entry.path, entry]))
  const entries = []
  for (const gitEntry of gitManifest.entries.filter((entry) => entry.type === 'file')) {
    const entryPath = assertSafeAttributesPath(gitEntry.path)
    const blob = gitManifest.blobs.get(entryPath)
    const physicalEntry = physicalFiles.get(entryPath)
    if (!blob || !physicalEntry) throw new Error('skills projection is missing a verified Git or physical file')
    const physicalBytes = fs.readFileSync(path.join(sourceSkills, ...entryPath.split('/')))
    let kind = 'exact'
    if (!physicalBytes.equals(blob)) {
      let blobHasLf = false
      for (const byte of blob) {
        if (byte === 0x00 || byte === 0x0d) {
          throw new Error('skills physical bytes are not an exact or strict-crlf projection of the Git blob')
        }
        if (byte === 0x0a) blobHasLf = true
      }
      if (!blobHasLf) throw new Error('strict-crlf projection requires at least one canonical LF byte')
      for (let index = 0; index < physicalBytes.length; index += 1) {
        const byte = physicalBytes[index]
        if (byte === 0x00) throw new Error('strict-crlf projection rejects NUL bytes')
        if (byte === 0x0d) {
          if (physicalBytes[index + 1] !== 0x0a) throw new Error('strict-crlf projection rejects a bare CR byte')
          index += 1
          continue
        }
        if (byte === 0x0a) throw new Error('strict-crlf projection rejects a bare LF byte')
      }
      if (!expandLfToCrlf(blob).equals(physicalBytes)) {
        throw new Error('skills physical bytes are not an exact or strict-crlf projection of the Git blob')
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
    policy: MATERIALIZATION_POLICY,
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

function assertPhysicalSkillsMatchesProjection(physical, projection, label) {
  const physicalFiles = physical.fileEntries.map(({ path: entryPath, sha256, size }) => ({
    path: entryPath,
    physicalSha256: sha256,
    physicalSize: size
  }))
  const expected = projection.entries.map(({ path: entryPath, physicalSha256, physicalSize }) => ({
    path: entryPath,
    physicalSha256,
    physicalSize
  }))
  if (JSON.stringify(physicalFiles) !== JSON.stringify(expected)) {
    throw new Error(`${label} does not match the verified physical worktree projection`)
  }
}

function configKey(record) {
  return record.split(/[\n=]/, 1)[0].toLowerCase()
}

function conversionConfigRecords(sourceRoot, gitEnv) {
  const records = parseNullPaths(runGitBuffer([
    'config', '--no-includes', '--null', '--list'
  ], sourceRoot, gitEnv).stdout)
  const worktreeConfig = path.join(sourceRoot, '.git', 'config.worktree')
  if (fs.existsSync(worktreeConfig)) {
    assertPlainFile(worktreeConfig, 'source Git config.worktree')
    records.push(...parseNullPaths(runGitBuffer([
      'config', '--no-includes', '--file', worktreeConfig, '--null', '--list'
    ], sourceRoot, gitEnv).stdout))
  }
  return records
}

function assertNoExternalConversionConfig(sourceRoot, gitEnv, label) {
  for (const record of conversionConfigRecords(sourceRoot, gitEnv)) {
    const key = configKey(record)
    if (key.startsWith('filter.')
      || key.startsWith('include.')
      || key.startsWith('includeif.')
      || key === 'core.attributesfile') {
      throw new Error(`${label} contains an external Git conversion policy`)
    }
  }
}

function assertNoExternalSkillsConversionPolicy(sourceHub, gitManifest, gitEnv, { allowGeneratedRoot = false } = {}) {
  if (gitManifest.entries.some((entry) => path.posix.basename(entry.path).toLowerCase() === '.gitattributes')) {
    throw new Error('skills tree contains a nested .gitattributes conversion policy')
  }
  const rootAttributes = path.join(sourceHub, '.gitattributes')
  if (!allowGeneratedRoot && fs.existsSync(rootAttributes)) {
    throw new Error('historical P0 v1 source must not contain a root .gitattributes conversion policy')
  }
  const infoAttributes = path.join(sourceHub, '.git', 'info', 'attributes')
  if (fs.existsSync(infoAttributes)) {
    throw new Error('historical source must not use .git/info/attributes for skills conversion')
  }
  assertNoExternalConversionConfig(sourceHub, gitEnv, 'historical Hub source')
}

function rootAttributesTreeEntry(sourceHub, treeish, gitEnv) {
  const records = parseNullPaths(runGitBuffer([
    'ls-tree', '-z', treeish, '--', '.gitattributes'
  ], sourceHub, gitEnv).stdout)
  if (records.length === 0) return null
  if (records.length !== 1) throw new Error('historical source has an ambiguous root .gitattributes entry')
  const separator = records[0].indexOf('\t')
  const [mode, type, objectId] = records[0].slice(0, separator).split(' ')
  if (records[0].slice(separator + 1) !== '.gitattributes'
    || mode !== '100644'
    || type !== 'blob'
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(String(objectId || ''))) {
    throw new Error('historical source root .gitattributes must be a regular 100644 blob')
  }
  return { mode, objectId }
}

function rootAttributesIndexEntry(sourceHub, gitEnv) {
  const records = parseNullPaths(runGitBuffer([
    'ls-files', '--stage', '-z', '--', '.gitattributes'
  ], sourceHub, gitEnv).stdout)
  if (records.length === 0) return null
  if (records.length !== 1) throw new Error('historical source index has an ambiguous root .gitattributes entry')
  const separator = records[0].indexOf('\t')
  const [mode, objectId, stage] = records[0].slice(0, separator).split(' ')
  if (records[0].slice(separator + 1) !== '.gitattributes'
    || mode !== '100644'
    || stage !== '0'
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(String(objectId || ''))) {
    throw new Error('historical source index root .gitattributes must be a stage-0 100644 blob')
  }
  return { mode, objectId }
}

function preflightRootAttributes(sourceHub, declaredCommit, actualCommit, fixtureVersion, gitEnv) {
  const declared = rootAttributesTreeEntry(sourceHub, declaredCommit, gitEnv)
  const actual = rootAttributesTreeEntry(sourceHub, actualCommit, gitEnv)
  const index = rootAttributesIndexEntry(sourceHub, gitEnv)
  if (fixtureVersion === 1) {
    if (declared || actual || index || fs.existsSync(path.join(sourceHub, '.gitattributes'))) {
      throw new Error('historical P0 v1 source must not contain root .gitattributes in physical, index, declared, or actual state')
    }
    return null
  }
  if (!declared || !actual || !index
    || declared.objectId !== actual.objectId
    || declared.objectId !== index.objectId) {
    throw new Error('historical P0 v2 generated .gitattributes is not identical in declared, actual, and index state')
  }
  assertPlainFile(path.join(sourceHub, '.gitattributes'), 'historical P0 v2 generated .gitattributes')
  return declared
}

function validateBoundV2Materialization(sourceHub, commit, manifest, physical, gitManifest, projection, gitEnv) {
  const attributesFile = assertPlainFile(path.join(sourceHub, '.gitattributes'), 'historical P0 v2 generated .gitattributes')
  const attributes = fs.readFileSync(attributesFile, 'utf8')
  const committedAttributes = runGitBuffer(['show', `${commit}:.gitattributes`], sourceHub, gitEnv).stdout.toString('utf8')
  const candidate = manifest.skillsMaterialization
  if (!candidate
    || candidate.version !== 1
    || candidate.policy !== MATERIALIZATION_POLICY
    || !/^[0-9a-f]{64}$/i.test(String(candidate.gitManifestSha256 || ''))
    || !/^[0-9a-f]{64}$/i.test(String(candidate.projectionSha256 || ''))
    || !Number.isInteger(candidate.projectionEntries)
    || !Number.isInteger(candidate.exactEntries)
    || !Number.isInteger(candidate.crlfEntries)
    || candidate.projectionEntries <= 0
    || candidate.exactEntries < 0
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
    || candidate.targetSkillsTree !== runGit(['rev-parse', `${commit}:skills`], sourceHub, gitEnv).stdout
    || candidate.physicalSkillsSha256 !== physical.sha256
    || candidate.physicalSkillsContentSha256 !== contentManifestSha256(physical.fileEntries)
    || manifest.skillsContentSha256 !== candidate.physicalSkillsContentSha256
    || attributes !== projection.attributes
    || committedAttributes !== projection.attributes) {
    throw new Error('historical P0 v2 skills materialization provenance is invalid or was tampered')
  }
  const autocrlf = runGit(['config', '--local', '--get', 'core.autocrlf'], sourceHub, gitEnv, { allowStatus: [1] })
  const safecrlf = runGit(['config', '--local', '--get', 'core.safecrlf'], sourceHub, gitEnv, { allowStatus: [1] })
  if (autocrlf.status !== 0 || autocrlf.stdout !== 'false'
    || safecrlf.status !== 0 || safecrlf.stdout !== 'true') {
    throw new Error('historical P0 v2 source does not retain its bound safe Git materialization policy')
  }
  return candidate
}

function assertPlainProjectionParent(target, boundary, label) {
  assertPlainDirectory(target, label)
  assertPathInside(boundary, target, label)
}

function assertExactDirectoryChildren(target, expected, label) {
  const actual = sortGitPaths(fs.readdirSync(target))
  const wanted = sortGitPaths(expected)
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} contains an extra or missing projection entry`)
  }
}

function assertExactJunction(target, expected, sourceRun, label) {
  if (!fs.existsSync(target)) throw new Error(`${label} is missing`)
  const stat = fs.lstatSync(target)
  if (!stat.isSymbolicLink()) throw new Error(`${label} must be a Junction or directory symlink`)
  const canonicalTarget = fs.realpathSync.native(target)
  const canonicalExpected = fs.realpathSync.native(expected)
  if (!samePath(canonicalTarget, canonicalExpected)) throw new Error(`${label} points to the wrong target`)
  if (!isSameOrInside(fs.realpathSync.native(sourceRun), canonicalTarget)) {
    throw new Error(`${label} escaped its marker-owned source run`)
  }
}

function assertExactOverrideHardlink(projectedOverride, hubOverride, sourceRun) {
  assertPlainFile(projectedOverride, 'historical probe AGENTS.override.md projection')
  assertPlainFile(hubOverride, 'historical hub AGENTS.override.md')
  assertPathInside(sourceRun, projectedOverride, 'historical probe AGENTS.override.md projection')
  assertPathInside(sourceRun, hubOverride, 'historical hub AGENTS.override.md')
  const projected = fs.statSync(projectedOverride, { bigint: true })
  const source = fs.statSync(hubOverride, { bigint: true })
  if (projected.dev !== source.dev
    || projected.ino !== source.ino
    || projected.nlink !== 2n
    || source.nlink !== 2n
    || projected.nlink !== source.nlink) {
    throw new Error('historical probe AGENTS.override.md must be the exact Hub hardlink')
  }
}

function expectedV1Projection(sourceRun, sourceHub, sourceProbe) {
  const sourceSkills = path.join(sourceHub, 'skills')
  const sourceOverlay = path.join(sourceHub, 'overlay')
  const skills = plainTreeManifest(sourceSkills, sourceRun, 'historical physical skills tree')
  const overlay = plainTreeManifest(sourceOverlay, sourceRun, 'historical physical overlay tree')
  const hubOverride = path.join(sourceHub, 'AGENTS.override.md')
  const overrideStat = fs.lstatSync(assertPlainFile(hubOverride, 'historical hub AGENTS.override.md'), { bigint: true })
  const overrideSha256 = fileDigest(hubOverride, overrideStat)

  assertPlainProjectionParent(path.join(sourceProbe, '.agents'), sourceRun, 'historical probe .agents')
  assertPlainProjectionParent(path.join(sourceProbe, '.agents', 'skills'), sourceRun, 'historical probe .agents/skills')
  assertPlainProjectionParent(path.join(sourceProbe, '.codex'), sourceRun, 'historical probe .codex')
  assertExactDirectoryChildren(path.join(sourceProbe, '.agents'), ['skills'], 'historical probe .agents')
  assertExactDirectoryChildren(path.join(sourceProbe, '.agents', 'skills'), REQUIRED_SKILLS, 'historical probe .agents/skills')
  assertExactDirectoryChildren(path.join(sourceProbe, '.codex'), ['local-overlay'], 'historical probe .codex')
  for (const name of REQUIRED_SKILLS) {
    assertExactJunction(
      path.join(sourceProbe, '.agents', 'skills', name),
      path.join(sourceSkills, name),
      sourceRun,
      `historical probe resident Skill projection ${name}`
    )
  }
  assertExactJunction(
    path.join(sourceProbe, '.codex', 'local-overlay'),
    sourceOverlay,
    sourceRun,
    'historical probe local-overlay projection'
  )
  assertExactOverrideHardlink(path.join(sourceProbe, 'AGENTS.override.md'), hubOverride, sourceRun)

  const projectedFiles = [
    ...REQUIRED_SKILLS.flatMap((name) => {
      const tree = plainTreeManifest(path.join(sourceSkills, name), sourceRun, `historical physical ${name} tree`)
      return tree.files.map((relative) => `.agents/skills/${name}/${relative}`)
    }),
    ...overlay.files.map((relative) => `.codex/local-overlay/${relative}`),
    'AGENTS.override.md'
  ]
  const sortedProjectedFiles = sortGitPaths(projectedFiles)
  const projectionSha256 = createHash('sha256')
    .update('skill-graft:p0-v1-post-acceptance-attach:v1\0', 'utf8')
    .update(JSON.stringify({ projectedFiles: sortedProjectedFiles, skillsSha256: skills.sha256, overlaySha256: overlay.sha256, overrideSha256 }), 'utf8')
    .digest('hex')
  return { projectedFiles: sortedProjectedFiles, projectionSha256, skills }
}

function assertSafeProbeAttributesBytes(contents) {
  let text
  try {
    text = FATAL_UTF8_DECODER.decode(contents)
  } catch {
    throw new Error('historical probe .gitattributes must contain valid UTF-8')
  }
  for (const character of text) {
    const codePoint = character.codePointAt(0)
    if ((codePoint < 0x20 && ![0x09, 0x0a, 0x0d].includes(codePoint))
      || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      throw new Error('historical probe .gitattributes contains a NUL or control character')
    }
  }
  if (/\r(?!\n)/.test(text)) throw new Error('historical probe .gitattributes contains a bare CR byte')
  const allowed = new Set(['text', 'eol', 'diff', 'merge'])
  for (const rawLine of text.split(/\r?\n/)) {
    if (/^[ \t]*$/.test(rawLine) || /^[ \t]*#/.test(rawLine)) continue
    if ([...rawLine].some((character) => character.codePointAt(0) > 0x7e)) {
      throw new Error('historical probe active .gitattributes syntax must remain ASCII')
    }
    const line = rawLine.trim()
    const tokens = line.split(/[ \t]+/)
    const pattern = tokens.shift()
    if (!pattern
      || tokens.length === 0
      || pattern.startsWith('[attr]')
      || /["'\\]/.test(pattern)) {
      throw new Error('historical probe .gitattributes contains an unsafe pattern or macro')
    }
    for (const token of tokens) {
      const parsed = /^([!-]?)([A-Za-z][A-Za-z0-9._-]*)(?:=([A-Za-z0-9._+-]+))?$/.exec(token)
      if (!parsed) throw new Error('historical probe .gitattributes contains unsupported syntax')
      const [, state, rawName, value] = parsed
      const name = rawName.toLowerCase()
      if (!allowed.has(name)) {
        throw new Error('historical probe .gitattributes contains an unsafe conversion attribute')
      }
      if (value && state) throw new Error('historical probe .gitattributes contains an invalid attribute state')
      if (name === 'eol' && (state || !['lf', 'crlf'].includes(String(value || '').toLowerCase()))) {
        throw new Error('historical probe .gitattributes contains an unsafe eol attribute')
      }
      if (name === 'text' && value && value.toLowerCase() !== 'auto') {
        throw new Error('historical probe .gitattributes contains an unsafe text attribute')
      }
    }
  }
}

function gitTreeAttributesManifest(sourceProbe, commit, gitEnv) {
  const entries = []
  for (const record of parseNullPaths(runGitBuffer([
    'ls-tree', '-r', '-z', commit
  ], sourceProbe, gitEnv).stdout)) {
    const separator = record.indexOf('\t')
    if (separator < 0) throw new Error('historical probe HEAD tree record is malformed')
    const [mode, type, objectId] = record.slice(0, separator).split(' ')
    const entryPath = record.slice(separator + 1)
    if (path.posix.basename(entryPath).toLowerCase() !== '.gitattributes') continue
    if (mode !== '100644'
      || type !== 'blob'
      || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(String(objectId || ''))) {
      throw new Error('historical probe HEAD .gitattributes must be a regular 100644 blob')
    }
    const contents = runGitBuffer(['cat-file', 'blob', objectId], sourceProbe, gitEnv).stdout
    assertSafeProbeAttributesBytes(contents)
    entries.push({
      path: entryPath,
      mode,
      objectId,
      sha256: createHash('sha256').update(contents).digest('hex'),
      size: String(contents.length)
    })
  }
  return entries.sort(compareManifestEntries)
}

function gitIndexAttributesManifest(sourceProbe, gitEnv) {
  const entries = []
  for (const record of parseNullPaths(runGitBuffer([
    'ls-files', '--stage', '-z'
  ], sourceProbe, gitEnv).stdout)) {
    const separator = record.indexOf('\t')
    if (separator < 0) throw new Error('historical probe index record is malformed')
    const [mode, objectId, stage] = record.slice(0, separator).split(' ')
    const entryPath = record.slice(separator + 1)
    if (path.posix.basename(entryPath).toLowerCase() !== '.gitattributes') continue
    if (mode !== '100644'
      || stage !== '0'
      || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(String(objectId || ''))) {
      throw new Error('historical probe index .gitattributes must be a stage-0 100644 blob')
    }
    const contents = runGitBuffer(['cat-file', 'blob', objectId], sourceProbe, gitEnv).stdout
    assertSafeProbeAttributesBytes(contents)
    entries.push({
      path: entryPath,
      mode,
      objectId,
      sha256: createHash('sha256').update(contents).digest('hex'),
      size: String(contents.length)
    })
  }
  return entries.sort(compareManifestEntries)
}

function physicalAttributesManifest(sourceProbe, sourceRun) {
  const entries = []
  const canonicalBoundary = fs.realpathSync.native(sourceRun)
  const visit = (target, relative, ancestors) => {
    const stat = fs.lstatSync(target, { bigint: true })
    const portable = relative.replaceAll('\\', '/')
    const basename = path.posix.basename(portable).toLowerCase()
    if (stat.isSymbolicLink()) {
      if (basename === '.gitattributes') {
        throw new Error('historical probe physical .gitattributes must not be a link or reparse point')
      }
      const linked = fs.realpathSync.native(target)
      if (!isSameOrInside(canonicalBoundary, linked)) {
        throw new Error('historical probe reparse point escaped its marker-owned source run before status preflight')
      }
      const linkedStat = fs.statSync(linked)
      if (!linkedStat.isDirectory()) return
      const key = comparable(linked)
      if (ancestors.has(key)) throw new Error('historical probe reparse point introduced a directory cycle')
      const nestedAncestors = new Set(ancestors)
      nestedAncestors.add(key)
      for (const name of fs.readdirSync(linked).sort((left, right) => left.localeCompare(right, 'en'))) {
        visit(path.join(linked, name), path.posix.join(portable, name), nestedAncestors)
      }
      return
    }
    if (stat.isDirectory()) {
      if (portable === '.git') return
      const key = comparable(fs.realpathSync.native(target))
      if (ancestors.has(key)) throw new Error('historical probe physical tree introduced a directory cycle')
      const nestedAncestors = new Set(ancestors)
      nestedAncestors.add(key)
      for (const name of fs.readdirSync(target).sort((left, right) => left.localeCompare(right, 'en'))) {
        visit(path.join(target, name), path.posix.join(portable, name), nestedAncestors)
      }
      return
    }
    if (basename !== '.gitattributes') return
    if (!stat.isFile()) throw new Error('historical probe physical .gitattributes must be a regular file')
    const contents = fs.readFileSync(target)
    assertSafeProbeAttributesBytes(contents)
    entries.push({
      path: portable,
      sha256: createHash('sha256').update(contents).digest('hex'),
      size: String(contents.length)
    })
  }
  visit(sourceProbe, '', new Set())
  return entries.sort(compareManifestEntries)
}

function assertSafeProbeGitPolicy(sourceRun, sourceProbe, commit, gitEnv) {
  const infoAttributes = path.join(sourceProbe, '.git', 'info', 'attributes')
  if (fs.existsSync(infoAttributes)) {
    throw new Error('historical probe must not use .git/info/attributes before status')
  }
  assertNoExternalConversionConfig(sourceProbe, gitEnv, 'historical probe')
  const head = gitTreeAttributesManifest(sourceProbe, commit, gitEnv)
  const index = gitIndexAttributesManifest(sourceProbe, gitEnv)
  const physical = physicalAttributesManifest(sourceProbe, sourceRun)
  if (JSON.stringify(head) !== JSON.stringify(index)) {
    throw new Error('historical probe HEAD and index .gitattributes are not identical')
  }
  const expectedPhysical = head.map(({ path: entryPath, sha256, size }) => ({ path: entryPath, sha256, size }))
  if (JSON.stringify(expectedPhysical) !== JSON.stringify(physical)) {
    throw new Error('historical probe physical, index, and HEAD .gitattributes are not identical')
  }
}

function inspectProbeProjection(sourceRun, sourceHub, sourceProbe, fixtureVersion, gitEnv) {
  const status = parseNullPaths(runGitBuffer([
    'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=no'
  ], sourceProbe, gitEnv).stdout)
  const untracked = parseNullPaths(runGitBuffer([
    'ls-files', '--others', '--exclude-standard', '-z'
  ], sourceProbe, gitEnv).stdout)
  const ignored = parseNullPaths(runGitBuffer([
    'ls-files', '--others', '--ignored', '--exclude-standard', '-z'
  ], sourceProbe, gitEnv).stdout)
  if (ignored.length > 0) throw new Error('historical probe contains ignored projection or extra files')

  const physicalSkills = plainTreeManifest(path.join(sourceHub, 'skills'), sourceRun, 'historical physical skills tree')
  if (fixtureVersion === 2) {
    if (status.length > 0 || untracked.length > 0) throw new Error('historical P0 v2 probe must be clean')
    return {
      kind: 'p0-v2-clean',
      sha256: P0_V2_CLEAN_PROJECTION_SHA256,
      entries: 0,
      skillsSha256: physicalSkills.sha256
    }
  }

  const expected = expectedV1Projection(sourceRun, sourceHub, sourceProbe)
  const expectedStatus = sortGitPaths(expected.projectedFiles.map((relative) => `?? ${relative}`))
  if (JSON.stringify(sortGitPaths(status)) !== JSON.stringify(expectedStatus)
    || JSON.stringify(sortGitPaths(untracked)) !== JSON.stringify(expected.projectedFiles)) {
    throw new Error('historical P0 v1 probe projection does not exactly match the post-acceptance attach allowlist')
  }
  return {
    kind: 'p0-v1-post-acceptance-attach-v1',
    sha256: expected.projectionSha256,
    entries: expected.projectedFiles.length,
    skillsSha256: expected.skills.sha256
  }
}

function assertDeclaredAttachedWorktreesEmpty(sourceHub, declaredHubCommit, gitEnv) {
  const lookup = runGitBuffer([
    'rev-parse',
    '--verify',
    `${declaredHubCommit}:overlay/attached-worktrees.txt`
  ], sourceHub, gitEnv, { allowStatus: [128] })
  const objectId = lookup.stdout.toString('utf8').trim()
  if (lookup.status !== 0
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(objectId)
    || runGit(['cat-file', '-t', objectId], sourceHub, gitEnv).stdout !== 'blob') {
    throw new Error('declared P0 hub commit must contain overlay/attached-worktrees.txt as a regular blob')
  }
  const contents = runGitBuffer(['cat-file', 'blob', objectId], sourceHub, gitEnv).stdout
  if (contents.length !== 0) {
    throw new Error('declared P0 hub commit must contain an empty overlay/attached-worktrees.txt baseline')
  }
}

function assertAllowedV1HubFollowup(sourceHub, sourceProbe, declaredHubCommit, actualHubCommit, gitEnv) {
  const ancestor = runGit(['merge-base', '--is-ancestor', declaredHubCommit, actualHubCommit], sourceHub, gitEnv, {
    allowStatus: [1]
  })
  if (ancestor.status !== 0) {
    throw new Error('historical P0 v1 hub HEAD must descend from its declared manifest hubCommit')
  }
  const followupCount = runGit(['rev-list', '--count', `${declaredHubCommit}..${actualHubCommit}`], sourceHub, gitEnv).stdout
  if (followupCount !== '1') {
    throw new Error('historical P0 v1 hub acceptance follow-up must be exactly one commit')
  }
  assertDeclaredAttachedWorktreesEmpty(sourceHub, declaredHubCommit, gitEnv)
  const declaredSkillsTree = runGit(['rev-parse', `${declaredHubCommit}:skills`], sourceHub, gitEnv).stdout
  const actualSkillsTree = runGit(['rev-parse', `${actualHubCommit}:skills`], sourceHub, gitEnv).stdout
  if (declaredSkillsTree !== actualSkillsTree) {
    throw new Error('historical P0 v1 follow-up changed the skills tree')
  }

  const diff = runGitBuffer([
    'diff',
    '--name-status',
    '--no-renames',
    '-z',
    `${declaredHubCommit}..${actualHubCommit}`
  ], sourceHub, gitEnv).stdout
  const tokens = parseNullPaths(diff)
  if (tokens.length !== 4) {
    throw new Error('historical P0 v1 hub follow-up must contain exactly one claim and one history record')
  }
  let claimCount = 0
  let historyCount = 0
  for (let index = 0; index < tokens.length; index += 2) {
    const status = tokens[index]
    const relative = tokens[index + 1].replaceAll('\\', '/')
    const allowedClaim = status === 'M' && relative === 'overlay/attached-worktrees.txt'
    const allowedHistory = status === 'A' && /^skill-review\/history\/[^/]+\.md$/.test(relative)
    if (!allowedClaim && !allowedHistory) {
      throw new Error('historical P0 v1 hub follow-up exceeded the runtime claim/history allowlist')
    }
    if (allowedClaim) claimCount += 1
    if (allowedHistory) historyCount += 1
    const target = path.resolve(sourceHub, ...relative.split('/'))
    if (!isSameOrInside(sourceHub, target)) {
      throw new Error('historical P0 v1 hub follow-up path escaped hub-data')
    }
    assertPlainFile(target, `historical P0 v1 runtime follow-up ${relative}`)
    assertPathInside(sourceHub, target, `historical P0 v1 runtime follow-up ${relative}`)
  }
  if (claimCount !== 1 || historyCount !== 1) {
    throw new Error('historical P0 v1 hub follow-up must contain exactly one claim and one history record')
  }
  const claimLines = fs.readFileSync(path.join(sourceHub, 'overlay', 'attached-worktrees.txt'), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (claimLines.length !== 1
    || !path.isAbsolute(claimLines[0])
    || !samePath(claimLines[0], sourceProbe)
    || !samePath(fs.realpathSync.native(claimLines[0]), fs.realpathSync.native(sourceProbe))) {
    throw new Error('historical P0 v1 attached-worktrees claim must uniquely identify its marker-owned source probe')
  }
  return actualSkillsTree
}

function assertNoHubObjectAlternates(sourceHub) {
  const objects = assertPlainDirectory(path.join(sourceHub, '.git', 'objects'), 'historical hub-data object database')
  const info = path.join(objects, 'info')
  if (!fs.existsSync(info)) return
  assertPlainDirectory(info, 'historical hub-data object info')
  for (const name of ['alternates', 'http-alternates']) {
    if (fs.existsSync(path.join(info, name))) {
      throw new Error('historical hub-data must not use an alternate object database')
    }
  }
}

function verifyHistoricalGit(sourceRun, sourceHub, sourceProbe, metadata, gitEnv, alternates) {
  assertPathInside(sourceRun, sourceHub, 'historical hub-data')
  assertPathInside(sourceRun, sourceProbe, 'historical probe')
  assertPlainDirectory(path.join(sourceHub, '.git'), 'historical hub-data .git')
  // Hub alternates are never part of the historical fixture contract. Reject
  // them before the first object lookup so even validation cannot read from an
  // unowned object database. Historical v1 probe alternates remain separately
  // enumerated, watched, and allowed only for the bounded independent clone.
  assertNoHubObjectAlternates(sourceHub)
  const declaredHubCommit = metadata.manifest.hubCommit
  runGit(['cat-file', '-e', `${declaredHubCommit}^{commit}`], sourceHub, gitEnv)
  const actualHubCommit = runGit(['rev-parse', 'HEAD'], sourceHub, gitEnv).stdout
  let skillsTree
  if (metadata.manifest.version === 1) {
    skillsTree = assertAllowedV1HubFollowup(sourceHub, sourceProbe, declaredHubCommit, actualHubCommit, gitEnv)
  } else {
    assertDeclaredAttachedWorktreesEmpty(sourceHub, declaredHubCommit, gitEnv)
    if (actualHubCommit !== declaredHubCommit) {
      throw new Error('historical P0 v2 hub-data HEAD does not match its P0 manifest')
    }
    skillsTree = runGit(['rev-parse', `${declaredHubCommit}:skills`], sourceHub, gitEnv).stdout
  }
  const declaredSkillsGit = gitSkillsManifest(sourceHub, declaredHubCommit, gitEnv)
  const actualSkillsGit = gitSkillsManifest(sourceHub, actualHubCommit, gitEnv)
  assertGitSkillsManifestEqual(actualSkillsGit, declaredSkillsGit, 'actual historical Git skills manifest')
  preflightRootAttributes(
    sourceHub,
    declaredHubCommit,
    actualHubCommit,
    metadata.manifest.version,
    gitEnv
  )
  assertNoExternalSkillsConversionPolicy(sourceHub, declaredSkillsGit, gitEnv, {
    allowGeneratedRoot: metadata.manifest.version === 2
  })
  assertGitSkillsManifestEqual(
    gitIndexSkillsManifest(sourceHub, gitEnv),
    declaredSkillsGit,
    'historical source index skills manifest'
  )

  // Derive and, for v2, authenticate the complete physical projection before
  // asking Git for status. A tracked attributes file is itself untrusted input:
  // no command that consults attributes/filters may run until this policy gate
  // has proved that only our generated, filter-disabled policy is present.
  const physicalSkills = plainTreeManifest(path.join(sourceHub, 'skills'), sourceRun, 'historical physical skills tree')
  const physicalSkillsContentSha256 = contentManifestSha256(physicalSkills.fileEntries)
  const skillsProjection = classifySkillsProjection(
    path.join(sourceHub, 'skills'),
    physicalSkills,
    declaredSkillsGit
  )
  if (metadata.manifest.version === 2) {
    validateBoundV2Materialization(
      sourceHub,
      declaredHubCommit,
      metadata.manifest,
      physicalSkills,
      declaredSkillsGit,
      skillsProjection,
      gitEnv
    )
  }

  const hubStatus = runGit(['status', '--porcelain=v1', '--untracked-files=all'], sourceHub, gitEnv).stdout
  if (hubStatus) throw new Error(`historical hub-data is not clean:\n${hubStatus}`)

  const ignoredSkills = parseNullPaths(runGitBuffer([
    'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching', '--', 'skills'
  ], sourceHub, gitEnv).stdout)
  if (ignoredSkills.length > 0) throw new Error('historical physical skills tree contains ignored or dirty paths')

  assertSafeProbeGitPolicy(sourceRun, sourceProbe, metadata.manifest.probeCommit, gitEnv)
  const probeHead = runGit(['rev-parse', 'HEAD'], sourceProbe, gitEnv).stdout
  if (probeHead !== metadata.manifest.probeCommit) throw new Error('historical probe HEAD does not match its P0 manifest')
  const branch = runGit(['branch', '--show-current'], sourceProbe, gitEnv).stdout
  if (branch) throw new Error(`historical probe must be detached, found branch ${branch}`)
  const remotes = runGit(['remote'], sourceProbe, gitEnv).stdout
  if (remotes) throw new Error(`historical probe retained a remote: ${remotes}`)
  const probeProjection = inspectProbeProjection(
    sourceRun,
    sourceHub,
    sourceProbe,
    metadata.manifest.version,
    gitEnv
  )
  runGit(['cat-file', '-e', `${metadata.manifest.probeCommit}^{commit}`], sourceProbe, gitEnv)
  if (metadata.manifest.version === 2 && alternates.length > 0) {
    throw new Error('historical P0 fixture v2 unexpectedly retained an alternate object database')
  }
  assertPlainFile(path.join(sourceProbe, 'AGENTS.md'), 'historical probe AGENTS.md')
  assertPlainDirectory(path.join(sourceProbe, 'baloot_client'), 'historical probe baloot_client')
  return {
    actualHubCommit,
    declaredHubCommit,
    physicalSkillsSha256: physicalSkills.sha256,
    physicalSkillsContentSha256,
    physicalSkillsFileEntries: physicalSkills.fileEntries.map(({ path: entryPath, sha256, size }) => ({ path: entryPath, sha256, size })),
    physicalSkillsStructureEntries: physicalSkills.structureEntries,
    skillsGitManifest: declaredSkillsGit,
    skillsProjection,
    probeProjection,
    skillsTree
  }
}

function sourceMaterializationLineage(sourceGit) {
  return {
    skillsMaterializationPolicy: MATERIALIZATION_POLICY,
    skillsGitManifestSha256: sourceGit.skillsGitManifest.sha256,
    skillsProjectionSha256: sourceGit.skillsProjection.sha256,
    skillsProjectionEntries: sourceGit.skillsProjection.entries.length,
    skillsExactEntries: sourceGit.skillsProjection.exactEntries,
    skillsCrlfEntries: sourceGit.skillsProjection.crlfEntries,
    skillsAttributesSha256: sourceGit.skillsProjection.attributesSha256,
    targetSkillsTree: sourceGit.skillsTree
  }
}

function directSourceLineage(fixtureVersion, sourceGit) {
  return {
    fixtureVersion,
    declaredHubCommit: sourceGit.declaredHubCommit,
    actualHubCommit: sourceGit.actualHubCommit,
    skillsTree: sourceGit.skillsTree,
    physicalSkillsSha256: sourceGit.physicalSkillsSha256,
    physicalSkillsContentSha256: sourceGit.physicalSkillsContentSha256,
    probeProjectionKind: sourceGit.probeProjection.kind,
    probeProjectionSha256: sourceGit.probeProjection.sha256,
    probeProjectionEntries: sourceGit.probeProjection.entries,
    ...sourceMaterializationLineage(sourceGit)
  }
}

function normalizedSourceLineage(metadata, sourceGit) {
  if (metadata.manifest.version === 1) {
    return directSourceLineage(1, sourceGit)
  }
  const hasVersion = Object.hasOwn(metadata.manifest, 'convertedFromFixtureVersion')
  const hasLineage = Object.hasOwn(metadata.manifest, 'convertedFrom')
  if (hasVersion !== hasLineage) {
    throw new Error('historical P0 v2 convertedFrom provenance is incomplete')
  }
  if (!hasVersion) return directSourceLineage(2, sourceGit)

  const candidate = metadata.manifest.convertedFrom
  const fixtureVersion = metadata.manifest.convertedFromFixtureVersion
  const expectedMaterialization = sourceMaterializationLineage(sourceGit)
  const v1Projection = candidate?.probeProjectionKind === 'p0-v1-post-acceptance-attach-v1'
    && Number.isInteger(candidate?.probeProjectionEntries)
    && candidate.probeProjectionEntries > 0
  const v2Projection = candidate?.probeProjectionKind === 'p0-v2-clean'
    && candidate?.probeProjectionEntries === 0
    && candidate?.probeProjectionSha256 === P0_V2_CLEAN_PROJECTION_SHA256
  if (!candidate
    || ![1, 2].includes(fixtureVersion)
    || candidate.fixtureVersion !== fixtureVersion
    || !/^[0-9a-f]{40}$/i.test(String(candidate.declaredHubCommit || ''))
    || !/^[0-9a-f]{40}$/i.test(String(candidate.actualHubCommit || ''))
    || !/^[0-9a-f]{40}$/i.test(String(candidate.skillsTree || ''))
    || !/^[0-9a-f]{64}$/i.test(String(candidate.physicalSkillsSha256 || ''))
    || !/^[0-9a-f]{64}$/i.test(String(candidate.physicalSkillsContentSha256 || ''))
    || !/^[0-9a-f]{64}$/i.test(String(candidate.probeProjectionSha256 || ''))
    || (fixtureVersion === 1 ? !v1Projection : !v2Projection)
    || candidate.skillsTree !== sourceGit.skillsTree
    || candidate.physicalSkillsSha256 !== sourceGit.physicalSkillsSha256
    || candidate.physicalSkillsContentSha256 !== sourceGit.physicalSkillsContentSha256
    || Object.entries(expectedMaterialization).some(([key, value]) => candidate[key] !== value)) {
    throw new Error('historical P0 v2 convertedFrom provenance is invalid or was tampered')
  }
  return candidate
}

function createIndependentProbe(sourceProbe, context, commit, gitEnv) {
  runGit([
    'clone',
    '--no-local',
    '--no-hardlinks',
    '--no-checkout',
    sourceProbe,
    context.probeRoot
  ], context.runRoot, gitEnv)
  const alternatesFile = path.join(context.probeRoot, '.git', 'objects', 'info', 'alternates')
  if (fs.existsSync(alternatesFile)) {
    throw new Error(`independent target probe unexpectedly retained an object alternate: ${alternatesFile}`)
  }
  runGit(['remote', 'remove', 'origin'], context.probeRoot, gitEnv)
  runGit(['checkout', '--detach', commit], context.probeRoot, gitEnv)
  runGit(['config', 'user.name', 'Skill Graft P0 E2E'], context.probeRoot, gitEnv)
  runGit(['config', 'user.email', 'skill-graft-p0@invalid.local'], context.probeRoot, gitEnv)

  if (fs.existsSync(alternatesFile)) throw new Error('target probe gained an object alternate after checkout')
  const head = runGit(['rev-parse', 'HEAD'], context.probeRoot, gitEnv).stdout
  if (head !== commit) throw new Error('target probe HEAD does not match the declared historical commit')
  if (runGit(['branch', '--show-current'], context.probeRoot, gitEnv).stdout) {
    throw new Error('target probe checkout is not detached')
  }
  if (runGit(['remote'], context.probeRoot, gitEnv).stdout) {
    throw new Error('target probe retained a Git remote')
  }
  const status = runGit(['status', '--porcelain=v1', '--untracked-files=all'], context.probeRoot, gitEnv).stdout
  if (status) throw new Error(`target probe is not clean after checkout:\n${status}`)
  assertPlainFile(path.join(context.probeRoot, 'AGENTS.md'), 'target probe AGENTS.md')
  assertPlainDirectory(path.join(context.probeRoot, 'baloot_client'), 'target probe baloot_client')
  assertTreeLinksContained(context.probeRoot, context.runRoot, 'target probe')
  return head
}

const packageRoot = absoluteDirectory('SKILL_GRAFT_FIXTURE_SOURCE')
const sourceRun = absoluteDirectory('SKILL_GRAFT_P0_SOURCE_RUN')
const sourceProbe = assertPlainDirectory(path.join(sourceRun, 'probe'), 'historical probe')
const sourceHub = assertPlainDirectory(path.join(sourceRun, 'hub-data'), 'historical hub-data')
const sourceSkills = assertPlainDirectory(path.join(sourceHub, 'skills'), 'historical hub-data/skills')
assertPathInside(sourceRun, sourceProbe, 'historical probe')
assertPathInside(sourceRun, sourceSkills, 'historical hub-data/skills')

const initialMetadata = readHistoricalMetadata(sourceRun)
const sourceAlternates = alternateRoots(sourceProbe)
const declaredProtectedRoots = String(process.env.SKILL_GRAFT_PROTECTED_ROOTS || '')
  .split(path.delimiter)
  .map((item) => item.trim())
  .filter(Boolean)
const fixedProbe = process.platform === 'win32' ? 'E:\\ozdqp-cli-attach-probe' : ''
const liveRoots = [...declaredProtectedRoots]
if (fixedProbe) liveRoots.push(fixedProbe)

const context = validateRealE2eEnvironment(process.env, {
  workspaceRoot: packageRoot,
  protectedRoots: [sourceRun, ...sourceAlternates, ...liveRoots]
})
assertRunLayoutOwned(context)
assertEmptyPlainDirectory(context.hubDataRoot, 'target hub-data')
assertEmptyPlainDirectory(context.probeRoot, 'target probe')
if (isSameOrInside(sourceRun, context.runRoot) || isSameOrInside(context.runRoot, sourceRun)) {
  throw new Error('historical source and target run must not overlap')
}

const gitEnv = createIsolatedGitEnvironment(process.env, context.homeRoot)
Object.assign(gitEnv, {
  XDG_CONFIG_HOME: path.join(context.homeRoot, 'xdg-config'),
  APPDATA: path.join(context.homeRoot, 'appdata'),
  LOCALAPPDATA: path.join(context.homeRoot, 'localappdata')
})
fs.mkdirSync(gitEnv.XDG_CONFIG_HOME, { recursive: true })
fs.mkdirSync(gitEnv.APPDATA, { recursive: true })
fs.mkdirSync(gitEnv.LOCALAPPDATA, { recursive: true })

const protectedWatchRoots = watchRoots([
  { root: sourceRun, forceFullTree: true },
  { root: packageRoot },
  ...sourceAlternates.map((root) => ({ root, forceFullTree: true })),
  ...liveRoots.map((root) => ({ root }))
], gitEnv)
const fingerprintsBefore = fingerprintSet(protectedWatchRoots, sourceRun, gitEnv)
const verifiedMetadata = readHistoricalMetadata(sourceRun)
if (JSON.stringify(verifiedMetadata.marker) !== JSON.stringify(initialMetadata.marker)
  || JSON.stringify(verifiedMetadata.manifest) !== JSON.stringify(initialMetadata.manifest)) {
  throw new Error('historical P0 marker or manifest changed during initial fingerprinting')
}
const verifiedAlternates = alternateRoots(sourceProbe)
if (JSON.stringify(verifiedAlternates.map(comparable)) !== JSON.stringify(sourceAlternates.map(comparable))) {
  throw new Error('historical P0 alternate object databases changed during initial fingerprinting')
}

let conversionError = null
let result = null
try {
  const sourceGit = verifyHistoricalGit(sourceRun, sourceHub, sourceProbe, verifiedMetadata, gitEnv, verifiedAlternates)
  const lineage = normalizedSourceLineage(verifiedMetadata, sourceGit)
  const targetHub = initializeHubFixture(packageRoot, {
    contentSha256: sourceGit.physicalSkillsContentSha256,
    physicalSha256: sourceGit.physicalSkillsSha256,
    structureEntries: sourceGit.physicalSkillsStructureEntries,
    gitManifest: sourceGit.skillsGitManifest,
    projection: sourceGit.skillsProjection,
    treeOid: sourceGit.skillsTree
  }, context, gitEnv)
  const probeCommit = createIndependentProbe(sourceProbe, context, verifiedMetadata.manifest.probeCommit, gitEnv)
  result = {
    hubCommit: targetHub.hubCommit,
    probeCommit,
    skillsContentSha256: targetHub.skillsContentSha256,
    materialization: targetHub.materialization,
    lineage,
    sourceGit
  }
} catch (error) {
  conversionError = error
}

let fingerprintError = null
try {
  const fingerprintsAfter = fingerprintSet(protectedWatchRoots, sourceRun, gitEnv)
  assertFingerprintsUnchanged(fingerprintsBefore, fingerprintsAfter)
} catch (error) {
  fingerprintError = error
}
if (conversionError && fingerprintError) {
  throw new AggregateError([conversionError, fingerprintError], 'conversion failed and a protected source fingerprint changed')
}
if (conversionError) throw conversionError
if (fingerprintError) throw fingerprintError

const manifest = {
  version: 2,
  runId: context.runId,
  preparedAt: new Date().toISOString(),
  hubCommit: result.hubCommit,
  probeCommit: result.probeCommit,
  probeCloneMode: INDEPENDENT_CLONE_MODE,
  probeAlternatesPresent: false,
  remoteRemoved: true,
  runtimeStateInitialized: true,
  skillsContentSha256: result.skillsContentSha256,
  skillsMaterialization: result.materialization,
  convertedFromFixtureVersion: result.lineage.fixtureVersion,
  convertedFrom: result.lineage
}
fs.writeFileSync(path.join(context.runRoot, FIXTURE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, {
  encoding: 'utf8',
  flag: 'wx'
})
process.stdout.write(`${JSON.stringify({ ok: true, ...manifest }, null, 2)}\n`)
