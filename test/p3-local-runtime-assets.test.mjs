import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const outputRoot = path.resolve(process.env.SKILL_GRAFT_TEST_DIST || 'dist')
const runtimeAssets = await import(pathToFileURL(
  path.join(outputRoot, 'adapters', 'local-runtime-assets.js')
).href)
const contracts = await import(pathToFileURL(path.join(outputRoot, 'contracts', 'index.js')).href)
const core = await import(pathToFileURL(path.join(outputRoot, 'core', 'index.js')).href)

const MUTABLE_FILES = [
  'attached-worktrees.txt',
  'do-not-auto-attach.txt',
  'scan-roots.txt'
]
const IMMUTABLE_FILES = [...runtimeAssets.LOCAL_RUNTIME_ASSET_PATHS]
const DEFAULT_IMMUTABLE_FILES = Object.fromEntries(
  IMMUTABLE_FILES.map((relativePath) => [relativePath, `fixture:${relativePath}\n`])
)

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-runtime-assets-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function writeFile(root, relativePath, bytes, mode = 0o644) {
  const target = path.join(root, ...relativePath.split('/'))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, bytes, { mode })
  return target
}

function createPackage(t, files = {}) {
  const packageRoot = path.join(fixture(t), 'package')
  const overlay = path.join(packageRoot, 'overlay')
  fs.mkdirSync(overlay, { recursive: true })
  for (const [relativePath, bytes] of Object.entries({
    ...DEFAULT_IMMUTABLE_FILES,
    ...files
  })) writeFile(overlay, relativePath, bytes)
  for (const mutable of MUTABLE_FILES) {
    if (!fs.existsSync(path.join(overlay, mutable))) {
      writeFile(overlay, mutable, `private:${mutable}\n`)
    }
  }
  return { packageRoot, overlay }
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function inventory(root) {
  const entries = []
  function walk(absolute, relative) {
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })
      .sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)))) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name
      const child = path.join(absolute, entry.name)
      const stat = fs.lstatSync(child)
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        entries.push({ path: childRelative, kind: 'directory' })
        walk(child, childRelative)
      } else if (stat.isFile() && !stat.isSymbolicLink()) {
        const bytes = fs.readFileSync(child)
        entries.push({ path: childRelative, kind: 'file', size: bytes.length, sha256: sha256(bytes) })
      } else {
        entries.push({ path: childRelative, kind: 'other' })
      }
    }
  }
  walk(root, '')
  return entries
}

function repository(packageRoot, overrides = {}) {
  return runtimeAssets.createLocalRuntimeAssetRepository({
    packageRoot,
    runtimeRevision: '0.3.0+runtime@p3',
    modeFor: (relativePath) => relativePath.startsWith('hooks/') ? '100755' : '100644',
    ...overrides
  })
}

test('runtime assets are content-addressed, exclude mutable lists, and read exact verified bytes', (t) => {
  const { packageRoot } = createPackage(t, {
    'HubLib.ps1': 'hub-lib\n',
    'hooks/post-checkout': '#!/bin/sh\nexit 0\n',
    'prompts/attach.txt': 'attach prompt\n'
  })
  const before = inventory(packageRoot)
  const assets = repository(packageRoot)
  const manifest = assets.observe()

  assert.equal(contracts.validateRuntimeAssetManifestV1(manifest).valid, true)
  assert.equal(core.verifyRuntimeAssetManifest(manifest), true)
  assert.equal(manifest.runtimeRevision, '0.3.0+runtime@p3')
  assert.deepEqual(manifest.files.map((file) => file.path), IMMUTABLE_FILES)
  assert.deepEqual(runtimeAssets.LOCAL_RUNTIME_COMPATIBILITY_ASSET_PATHS, [
    'analyze-remote-skill-update.ps1',
    'dispatch-hub-codex.ps1',
    'promote-inbox.ps1',
    'start-codex-session.ps1'
  ])
  assert.equal(manifest.files.some((file) => MUTABLE_FILES.includes(file.path)), false)
  assert.deepEqual(inventory(packageRoot), before)

  const hook = manifest.files.find((file) => file.path === 'hooks/post-checkout')
  const bytes = assets.readVerifiedFile({
    runtimeAssetId: manifest.runtimeAssetId,
    path: hook.path,
    expectedSize: hook.size,
    expectedSha256: hook.sha256,
    expectedMode: hook.mode
  })
  assert.deepEqual(Buffer.from(bytes), Buffer.from('#!/bin/sh\nexit 0\n'))
  assert.equal(hook.mode, '100755')

  assert.equal(assets.readVerifiedFile({
    runtimeAssetId: manifest.runtimeAssetId,
    path: 'not-present.txt',
    expectedSize: 0,
    expectedSha256: `sha256:${'0'.repeat(64)}`,
    expectedMode: '100644'
  }), null)
  assert.throws(() => assets.readVerifiedFile({
    runtimeAssetId: manifest.runtimeAssetId,
    path: hook.path,
    expectedSize: hook.size + 1,
    expectedSha256: hook.sha256,
    expectedMode: hook.mode
  }), /does not match its manifest/)
  assert.throws(() => assets.readVerifiedFile({
    runtimeAssetId: manifest.runtimeAssetId,
    path: hook.path,
    expectedSize: hook.size,
    expectedSha256: `sha256:${'f'.repeat(64)}`,
    expectedMode: hook.mode
  }), /does not match its manifest/)
  assert.throws(() => assets.readVerifiedFile({
    runtimeAssetId: manifest.runtimeAssetId,
    path: hook.path,
    expectedSize: hook.size,
    expectedSha256: hook.sha256,
    expectedMode: '100644'
  }), /does not match its manifest/)
  assert.throws(() => assets.readVerifiedFile({
    runtimeAssetId: manifest.runtimeAssetId,
    path: '../outside',
    expectedSize: hook.size,
    expectedSha256: hook.sha256,
    expectedMode: hook.mode
  }), /not portable/)

  writeFile(path.join(packageRoot, 'overlay'), 'HubLib.ps1', 'changed\n')
  assert.throws(() => assets.readVerifiedFile({
    runtimeAssetId: manifest.runtimeAssetId,
    path: hook.path,
    expectedSize: hook.size,
    expectedSha256: hook.sha256,
    expectedMode: hook.mode
  }), /changed after the requested manifest/)
})

test('runtimeRevision is explicit metadata and does not alter the content identity', (t) => {
  const { packageRoot } = createPackage(t, { 'HubLib.ps1': 'same bytes\n' })
  const first = repository(packageRoot, { runtimeRevision: 'runtime-a' }).observe()
  const second = repository(packageRoot, { runtimeRevision: 'runtime-b' }).observe()
  assert.equal(first.runtimeAssetId, second.runtimeAssetId)
  assert.equal(first.runtimeRevision, 'runtime-a')
  assert.equal(second.runtimeRevision, 'runtime-b')

  assert.throws(
    () => repository(packageRoot, { runtimeRevision: 'E:/private/revision' }),
    /portable opaque identifier/
  )
  assert.throws(
    () => runtimeAssets.createLocalRuntimeAssetRepository({
      packageRoot: 'relative-package',
      runtimeRevision: 'runtime-a'
    }),
    /packageRoot must be absolute/
  )
})

test('runtime asset inventory is a positive allowlist and rejects future files or directories', (t) => {
  const unknownFile = createPackage(t, { 'future-runtime.ps1': 'not reviewed\n' })
  assert.throws(
    () => repository(unknownFile.packageRoot).observe(),
    /unrecognized file/
  )

  const unknownDirectory = createPackage(t)
  writeFile(unknownDirectory.overlay, 'future/runtime.ps1', 'not reviewed\n')
  assert.throws(
    () => repository(unknownDirectory.packageRoot).observe(),
    /unrecognized directory/
  )

  const missing = createPackage(t)
  fs.unlinkSync(path.join(missing.overlay, 'prompts', 'chat.txt'))
  assert.throws(
    () => repository(missing.packageRoot).observe(),
    /missing a required immutable asset/
  )
})

test('missing and empty sources fail closed without creating package or data paths', (t) => {
  const root = fixture(t)
  const missingPackage = path.join(root, 'missing-package')
  const missing = repository(missingPackage)
  assert.equal(fs.existsSync(missingPackage), false)
  assert.throws(() => missing.observe(), /missing or unreadable/)
  assert.equal(fs.existsSync(missingPackage), false)

  const { packageRoot } = createPackage(t)
  for (const relativePath of [...MUTABLE_FILES, ...IMMUTABLE_FILES]) {
    fs.unlinkSync(path.join(packageRoot, 'overlay', ...relativePath.split('/')))
  }
  assert.throws(() => repository(packageRoot).observe(), /missing a required immutable asset/)
})

test('runtime observation enforces entry, file-size, aggregate, and configured limits', (t) => {
  const { packageRoot } = createPackage(t)
  assert.throws(
    () => repository(packageRoot, { limits: { maxEntries: 2, maxFiles: 2 } }).observe(),
    /entry limit/
  )
  assert.throws(
    () => repository(packageRoot, { limits: { maxFileBytes: 1 } }).observe(),
    /file exceeds/
  )
  assert.throws(
    () => repository(packageRoot, { limits: { maxTotalBytes: 3 } }).observe(),
    /aggregate byte limit/
  )
  assert.throws(
    () => repository(packageRoot, { limits: { maxDepth: 0 } }),
    /limit is invalid/
  )
  assert.throws(
    () => repository(packageRoot, { limits: { maxEntries: 1, maxFiles: 2 } }),
    /maxFiles cannot exceed maxEntries/
  )
})

test('linked, hard-linked, and non-NFC overlay entries are rejected including excluded files', (t) => {
  const linkedRootTarget = createPackage(t)
  const linkedRoot = path.join(path.dirname(linkedRootTarget.packageRoot), 'package-link')
  let rootLinked = false
  try {
    fs.symlinkSync(
      linkedRootTarget.packageRoot,
      linkedRoot,
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    rootLinked = true
  } catch (error) {
    if (error?.code !== 'EPERM') throw error
  }
  if (rootLinked) assert.throws(
    () => repository(linkedRoot).observe(),
    /plain directory|junction or reparse point/
  )

  const hardlinkPackage = createPackage(t)
  const outside = writeFile(path.dirname(hardlinkPackage.packageRoot), 'outside.bin', 'linked\n')
  fs.unlinkSync(path.join(hardlinkPackage.overlay, 'HubLib.ps1'))
  fs.linkSync(outside, path.join(hardlinkPackage.overlay, 'HubLib.ps1'))
  assert.throws(() => repository(hardlinkPackage.packageRoot).observe(), /single-link/)

  const excludedPackage = createPackage(t)
  fs.unlinkSync(path.join(excludedPackage.overlay, 'attached-worktrees.txt'))
  const excludedSource = writeFile(path.dirname(excludedPackage.packageRoot), 'excluded-source.txt', 'private\n')
  fs.linkSync(excludedSource, path.join(excludedPackage.overlay, 'attached-worktrees.txt'))
  assert.throws(() => repository(excludedPackage.packageRoot).observe(), /single-link/)

  const linkPackage = createPackage(t)
  const linkTarget = writeFile(path.dirname(linkPackage.packageRoot), 'link-target.txt', 'target\n')
  let linked = false
  try {
    fs.unlinkSync(path.join(linkPackage.overlay, 'HubLib.ps1'))
    fs.symlinkSync(linkTarget, path.join(linkPackage.overlay, 'HubLib.ps1'), 'file')
    linked = true
  } catch (error) {
    if (error?.code !== 'EPERM') throw error
  }
  if (linked) assert.throws(() => repository(linkPackage.packageRoot).observe(), /reparse point/)

  const junctionPackage = createPackage(t)
  const externalDirectory = path.join(path.dirname(junctionPackage.packageRoot), 'external-directory')
  fs.mkdirSync(externalDirectory)
  writeFile(externalDirectory, 'external.txt', 'external\n')
  let junction = false
  try {
    fs.symlinkSync(
      externalDirectory,
      path.join(junctionPackage.overlay, 'linked-directory'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    junction = true
  } catch (error) {
    if (error?.code !== 'EPERM') throw error
  }
  if (junction) assert.throws(() => repository(junctionPackage.packageRoot).observe(), /reparse point/)

  const unicodePackage = createPackage(t)
  const decomposed = `e${String.fromCharCode(0x301)}.txt`
  if (decomposed !== decomposed.normalize('NFC')) {
    writeFile(unicodePackage.overlay, decomposed, 'unicode\n')
    assert.throws(() => repository(unicodePackage.packageRoot).observe(), /portable NFC/)
  }
})

test('portable case collisions reject before Core even on case-sensitive filesystems', (t) => {
  const collision = createPackage(t)
  writeFile(collision.overlay, 'hublib.ps1', 'lower\n')
  const names = fs.readdirSync(collision.overlay).filter((name) => name.toLowerCase() === 'hublib.ps1')
  if (names.length === 2) {
    assert.throws(() => repository(collision.packageRoot).observe(), /portable path collision/)
  }
})

test('same-handle and path revalidation reject in-place mutation, replacement, and hardlink races', (t) => {
  const inPlace = createPackage(t, { 'HubLib.ps1': 'AAAA' })
  let mutated = false
  assert.throws(() => repository(inPlace.packageRoot, {
    checkpoint(name, facts) {
      if (!mutated && name === 'runtime-assets-after-file-read' && facts.relativePath === 'HubLib.ps1') {
        mutated = true
        const target = path.join(inPlace.overlay, 'HubLib.ps1')
        fs.writeFileSync(target, 'BBBB')
        const future = new Date(Date.now() + 60_000)
        fs.utimesSync(target, future, future)
      }
    }
  }).observe(), /changed on its opened handle/)

  const replacement = createPackage(t, { 'HubLib.ps1': 'old!' })
  const replacementFile = writeFile(replacement.packageRoot, 'replacement.bin', 'new!')
  let replaced = false
  assert.throws(() => repository(replacement.packageRoot, {
    checkpoint(name, facts) {
      if (!replaced && name === 'runtime-assets-before-file-path-recheck'
        && facts.relativePath === 'HubLib.ps1') {
        replaced = true
        fs.renameSync(path.join(replacement.overlay, 'HubLib.ps1'), path.join(replacement.packageRoot, 'old.bin'))
        fs.renameSync(replacementFile, path.join(replacement.overlay, 'HubLib.ps1'))
      }
    }
  }).observe(), /changed while it was read/)

  const hardlink = createPackage(t, { 'HubLib.ps1': 'link' })
  let hardlinked = false
  assert.throws(() => repository(hardlink.packageRoot, {
    checkpoint(name, facts) {
      if (!hardlinked && name === 'runtime-assets-after-file-read' && facts.relativePath === 'HubLib.ps1') {
        hardlinked = true
        fs.linkSync(path.join(hardlink.overlay, 'HubLib.ps1'), path.join(hardlink.packageRoot, 'race.link'))
      }
    }
  }).observe(), /changed on its opened handle/)
})

test('directory identity revalidation rejects an entry added after enumeration', (t) => {
  const changed = createPackage(t)
  let injected = false
  assert.throws(() => repository(changed.packageRoot, {
    checkpoint(name, facts) {
      if (!injected && name === 'runtime-assets-after-directory-read' && facts.relativePath === '.') {
        injected = true
        writeFile(changed.overlay, 'late.txt', 'late\n')
        const future = new Date(Date.now() + 60_000)
        fs.utimesSync(changed.overlay, future, future)
      }
    }
  }).observe(), /directory changed while it was read/)
})
