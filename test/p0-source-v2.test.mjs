import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  createIsolatedGitEnvironment,
  createRunLayout,
  validateRealE2eEnvironment
} from './support/real-e2e.mjs'

const converter = fileURLToPath(new URL('./support/prepare-independent-p0-source.mjs', import.meta.url))
const requiredSkills = ['ozdqp-development', 'ozdqp-ui-development', 'ozdqp-git-workflow']

function runGit(cwd, args, homeRoot) {
  const result = spawnSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
    env: createIsolatedGitEnvironment(process.env, homeRoot),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 16 * 1024 * 1024
  })
  assert.equal(result.error, undefined, `git ${args.join(' ')} spawn error: ${result.error?.message || ''}`)
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  return String(result.stdout || '').trim()
}

function runGitBuffer(cwd, args, homeRoot) {
  const result = spawnSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
    env: createIsolatedGitEnvironment(process.env, homeRoot),
    encoding: null,
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 32 * 1024 * 1024
  })
  assert.equal(result.error, undefined, `git ${args.join(' ')} spawn error: ${result.error?.message || ''}`)
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${Buffer.from(result.stderr || []).toString('utf8')}`)
  return Buffer.from(result.stdout || [])
}

function testGitPathCompare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function testManifestEntryCompare(left, right) {
  return testGitPathCompare(left.path, right.path) || String(left.type).localeCompare(String(right.type), 'en')
}

function parseNullRecords(buffer) {
  const records = buffer.toString('utf8').split('\0')
  if (records.at(-1) === '') records.pop()
  return records
}

function fixtureSkillsGitManifest(root, commit, homeRoot) {
  const entries = []
  for (const record of parseNullRecords(runGitBuffer(root, ['ls-tree', '-r', '-t', '-z', `${commit}:skills`], homeRoot))) {
    const separator = record.indexOf('\t')
    const [mode, type, objectId] = record.slice(0, separator).split(' ')
    const entryPath = record.slice(separator + 1)
    if (type === 'tree') entries.push({ path: entryPath, type: 'directory', mode })
    else {
      const blob = runGitBuffer(root, ['cat-file', 'blob', objectId], homeRoot)
      entries.push({
        path: entryPath,
        type: 'file',
        mode,
        objectId,
        sha256: createHash('sha256').update(blob).digest('hex'),
        size: String(blob.length)
      })
    }
  }
  entries.sort(testManifestEntryCompare)
  return {
    entries,
    sha256: createHash('sha256')
      .update('skill-graft:skills-git-manifest:v1\0', 'utf8')
      .update(JSON.stringify(entries), 'utf8')
      .digest('hex')
  }
}

function fixturePhysicalSkillsManifest(root) {
  const hash = createHash('sha256')
  const files = []
  const visit = (target, relative = '') => {
    const stat = fs.lstatSync(target, { bigint: true })
    const portable = relative.replaceAll('\\', '/') || '.'
    if (stat.isDirectory()) {
      hash.update(`d\0${portable}\0${stat.mode}\0`, 'utf8')
      for (const name of fs.readdirSync(target).sort((left, right) => left.localeCompare(right, 'en'))) {
        visit(path.join(target, name), path.join(relative, name))
      }
      return
    }
    const contents = fs.readFileSync(target)
    const sha256 = createHash('sha256').update(contents).digest('hex')
    files.push({ path: portable, sha256, size: stat.size.toString() })
    hash.update(`f\0${portable}\0${stat.mode}:${stat.size}\0${sha256}\0`, 'utf8')
  }
  visit(root)
  files.sort((left, right) => testGitPathCompare(left.path, right.path))
  return {
    sha256: hash.digest('hex'),
    files,
    contentSha256: createHash('sha256')
      .update('skill-graft:skills-content-manifest:v1\0', 'utf8')
      .update(JSON.stringify(files.map(({ path: entryPath, sha256 }) => ({ path: entryPath, sha256 }))), 'utf8')
      .digest('hex')
  }
}

function exactFixtureMaterialization(hubData, skills, hubCommit, homeRoot) {
  const git = fixtureSkillsGitManifest(hubData, hubCommit, homeRoot)
  const physical = fixturePhysicalSkillsManifest(skills)
  const projectionEntries = git.entries.filter((entry) => entry.type === 'file').map((entry) => {
    const physicalEntry = physical.files.find((candidate) => candidate.path === entry.path)
    return {
      path: entry.path,
      mode: entry.mode,
      kind: 'exact',
      blobObjectId: entry.objectId,
      blobSha256: entry.sha256,
      physicalSha256: physicalEntry.sha256,
      blobSize: entry.size,
      physicalSize: physicalEntry.size
    }
  })
  const attributes = '# Skill Graft generated skills worktree policy v1\n/skills/** -text -filter -ident -working-tree-encoding\n'
  return {
    attributes,
    manifest: {
      version: 1,
      policy: 'git-blob-exact-or-strict-crlf-v1',
      gitManifestSha256: git.sha256,
      projectionSha256: createHash('sha256')
        .update('skill-graft:skills-worktree-projection:v1\0', 'utf8')
        .update(JSON.stringify(projectionEntries), 'utf8')
        .digest('hex'),
      projectionEntries: projectionEntries.length,
      exactEntries: projectionEntries.length,
      crlfEntries: 0,
      attributesSha256: createHash('sha256').update(attributes, 'utf8').digest('hex'),
      targetSkillsTree: runGit(hubData, ['rev-parse', `${hubCommit}:skills`], homeRoot),
      physicalSkillsSha256: physical.sha256,
      physicalSkillsContentSha256: physical.contentSha256
    }
  }
}

function treeFingerprint(root) {
  const hash = createHash('sha256')
  const visit = (directory, relativeRoot = '') => {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name)
      const relative = path.join(relativeRoot, entry.name).replaceAll('\\', '/')
      const stat = fs.lstatSync(absolute)
      const kind = stat.isSymbolicLink() ? 'l' : stat.isDirectory() ? 'd' : stat.isFile() ? 'f' : 'o'
      hash.update(`${kind}:${relative}:${stat.size}:${stat.mtimeMs}\0`, 'utf8')
      if (stat.isSymbolicLink()) hash.update(fs.readlinkSync(absolute), 'utf8')
      else if (stat.isDirectory()) visit(absolute, relative)
      else if (stat.isFile()) hash.update(fs.readFileSync(absolute))
    }
  }
  visit(root)
  return hash.digest('hex')
}

function contentTreeDigest(root) {
  const entries = []
  const visit = (directory, relativeRoot = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      const relative = path.join(relativeRoot, entry.name).replaceAll('\\', '/')
      const stat = fs.lstatSync(absolute)
      assert.equal(stat.isSymbolicLink(), false, `content manifest rejects link ${relative}`)
      if (stat.isDirectory()) visit(absolute, relative)
      else {
        assert.equal(stat.isFile(), true, `content manifest requires regular file ${relative}`)
        entries.push({ path: relative, sha256: createHash('sha256').update(fs.readFileSync(absolute)).digest('hex') })
      }
    }
  }
  visit(root)
  entries.sort((left, right) => Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8')))
  return createHash('sha256')
    .update('skill-graft:skills-content-manifest:v1\0', 'utf8')
    .update(JSON.stringify(entries), 'utf8')
    .digest('hex')
}

function createPackageSource(parent, homeRoot) {
  const root = path.join(parent, 'package-source')
  fs.mkdirSync(path.join(root, 'overlay', 'prompts'), { recursive: true })
  fs.writeFileSync(path.join(root, 'AGENTS.override.md'), '# package-owned override\n')
  for (const name of ['analyze', 'attach', 'chat', 'detach', 'edit']) {
    fs.writeFileSync(path.join(root, 'overlay', 'prompts', `${name}.txt`), `${name}\n`)
  }
  fs.writeFileSync(path.join(root, 'overlay', 'attach-library.ps1'), '# fixture\n')
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n')
  runGit(root, ['init', '--initial-branch=main'], homeRoot)
  runGit(root, ['config', 'user.name', 'P0 Package Fixture'], homeRoot)
  runGit(root, ['config', 'user.email', 'p0-package@invalid.local'], homeRoot)
  runGit(root, ['add', '--all'], homeRoot)
  runGit(root, ['commit', '-m', 'package fixture'], homeRoot)
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true })
  fs.writeFileSync(path.join(root, 'node_modules', 'transient.json'), '{"tick":0}\n')
  return root
}

function initializeRepo(root, homeRoot, files, message) {
  fs.mkdirSync(root, { recursive: true })
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(root, ...relative.split('/'))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, contents)
  }
  runGit(root, ['init', '--initial-branch=main'], homeRoot)
  runGit(root, ['config', 'user.name', 'P0 Converter Fixture'], homeRoot)
  runGit(root, ['config', 'user.email', 'p0-converter@invalid.local'], homeRoot)
  runGit(root, ['add', '--all'], homeRoot)
  runGit(root, ['commit', '-m', message], homeRoot)
  return runGit(root, ['rev-parse', 'HEAD'], homeRoot)
}

function createHistoricalV1(parent, homeRoot, {
  declaredClaimContents = '',
  declaredClaimMissing = false,
  evilEmptyDirectory = false,
  exactBinary = false,
  followupSkillMutation = false,
  manifestUsesActualHead = false,
  nonUtf8Crlf = false,
  omitClaim = false,
  probeAttributes = '',
  probeNestedAttributes = '',
  realSkillShape29 = false,
  rootAttributes = '',
  secondFollowup = false,
  unsafeSkillPath = '',
  unsupportedGitMode = false,
  worktreeProjection = 'exact',
  wrongClaim = false
} = {}) {
  const seed = path.join(parent, 'alternate-live-ozdqp')
  const probeFiles = {
    'AGENTS.md': '# isolated probe\n',
    'baloot_client/fixture.txt': 'fixture\n'
  }
  if (probeAttributes) probeFiles['.gitattributes'] = probeAttributes
  if (probeNestedAttributes) probeFiles['baloot_client/.gitattributes'] = probeNestedAttributes
  const probeCommit = initializeRepo(seed, homeRoot, probeFiles, 'probe seed')

  const runId = `p0-source-${path.basename(parent).slice(-8)}`
  const runRoot = path.join(parent, runId)
  const probe = path.join(runRoot, 'probe')
  const hubData = path.join(runRoot, 'hub-data')
  const skills = path.join(hubData, 'skills')
  fs.mkdirSync(runRoot, { recursive: true })
  runGit(parent, ['clone', '--shared', '--no-checkout', seed, probe], homeRoot)
  runGit(probe, ['remote', 'remove', 'origin'], homeRoot)
  runGit(probe, ['checkout', '--detach', probeCommit], homeRoot)
  assert.equal(fs.existsSync(path.join(probe, '.git', 'objects', 'info', 'alternates')), true)

  const hubFiles = {
    '.gitignore': 'private-runtime/\n',
    'AGENTS.override.md': '# historical override must not be copied\n',
    'overlay/attached-worktrees.txt': declaredClaimContents,
    'overlay/prompts/attach.txt': 'attach fixture\n'
  }
  if (declaredClaimMissing) delete hubFiles['overlay/attached-worktrees.txt']
  for (const name of requiredSkills) hubFiles[`skills/${name}/SKILL.md`] = `# ${name}\n`
  hubFiles['skills/ozdqp-development/scripts/executable-fixture.sh'] = '#!/bin/sh\nexit 0\n'
  if (nonUtf8Crlf) hubFiles['skills/ozdqp-development/references/non-utf8.yaml'] = Buffer.from([0x6b, 0x65, 0x79, 0x3a, 0x20, 0xff, 0x0a])
  if (exactBinary) hubFiles['skills/ozdqp-development/references/exact-binary.bin'] = Buffer.from([0x00, 0x01, 0x02, 0xff])
  if (unsafeSkillPath) hubFiles[unsafeSkillPath] = '# unsafe attributes path fixture\n'
  if (realSkillShape29) {
    let trackedSkillFiles = Object.keys(hubFiles).filter((relative) => relative.startsWith('skills/')).length
    while (trackedSkillFiles < 29) {
      hubFiles[`skills/ozdqp-development/references/real-shape-${String(trackedSkillFiles + 1).padStart(2, '0')}.md`] = `# real shape ${trackedSkillFiles + 1}\n`
      trackedSkillFiles += 1
    }
    assert.equal(trackedSkillFiles, 29)
  } else {
    hubFiles['skills/adopted/.keep'] = ''
    hubFiles['skills/inbox/.keep'] = ''
  }
  let hubCommit = initializeRepo(hubData, homeRoot, hubFiles, 'historical hub fixture')
  if (rootAttributes) {
    fs.writeFileSync(path.join(hubData, '.gitattributes'), rootAttributes)
    runGit(hubData, ['add', '--', '.gitattributes'], homeRoot)
  }
  if (realSkillShape29) {
    fs.mkdirSync(path.join(skills, 'adopted'))
    fs.mkdirSync(path.join(skills, 'inbox'))
  }
  const executableFixture = path.join(skills, 'ozdqp-development', 'scripts', 'executable-fixture.sh')
  fs.chmodSync(executableFixture, 0o755)
  runGit(hubData, ['update-index', '--chmod=+x', '--', 'skills/ozdqp-development/scripts/executable-fixture.sh'], homeRoot)
  if (unsupportedGitMode === 'symlink') {
    const evilLink = path.join(skills, 'evil-link')
    fs.writeFileSync(evilLink, '../outside-target\n')
    runGit(hubData, ['add', '--', 'skills/evil-link'], homeRoot)
    const objectId = runGit(hubData, ['rev-parse', ':skills/evil-link'], homeRoot)
    runGit(hubData, ['update-index', '--add', '--cacheinfo', `120000,${objectId},skills/evil-link`], homeRoot)
  }
  if (unsupportedGitMode === 'submodule') {
    const submoduleSeed = path.join(parent, 'unsupported-submodule-seed')
    initializeRepo(submoduleSeed, homeRoot, { 'README.md': '# unsupported submodule\n' }, 'unsupported submodule seed')
    runGit(hubData, ['-c', 'protocol.file.allow=always', 'submodule', 'add', submoduleSeed, 'skills/evil-submodule'], homeRoot)
  }
  runGit(hubData, ['commit', '--amend', '--no-edit'], homeRoot)
  hubCommit = runGit(hubData, ['rev-parse', 'HEAD'], homeRoot)
  if (worktreeProjection === 'crlf') {
    const declaredSkillsTree = runGit(hubData, ['rev-parse', `${hubCommit}:skills`], homeRoot)
    for (const relative of runGit(hubData, ['ls-files', '--', 'skills'], homeRoot).split(/\r?\n/).filter(Boolean)) {
      if (relative.endsWith('/exact-binary.bin')) continue
      const file = path.join(hubData, ...relative.split('/'))
      const bytes = fs.readFileSync(file)
      const projected = []
      for (const byte of bytes) {
        if (byte === 0x0d || byte === 0x00) throw new Error(`fixture cannot CRLF-project ${relative}`)
        if (byte === 0x0a) projected.push(0x0d)
        projected.push(byte)
      }
      fs.writeFileSync(file, Buffer.from(projected))
    }
    runGit(hubData, ['config', 'core.autocrlf', 'true'], homeRoot)
    runGit(hubData, ['add', '--', 'skills'], homeRoot)
    const projectedIndexTree = runGit(hubData, ['write-tree'], homeRoot)
    assert.equal(
      runGit(hubData, ['rev-parse', `${projectedIndexTree}:skills`], homeRoot),
      declaredSkillsTree,
      'CRLF fixture projection must preserve every declared skills blob and Git mode'
    )
  }
  if (evilEmptyDirectory) fs.mkdirSync(path.join(skills, 'evil-empty'))
  fs.mkdirSync(path.join(hubData, 'private-runtime'), { recursive: true })
  fs.writeFileSync(path.join(hubData, 'private-runtime', 'must-not-copy.txt'), 'historical runtime\n')
  if (!rootAttributes) {
    assert.equal(runGit(hubData, ['status', '--porcelain=v1', '--untracked-files=all'], homeRoot), '')
  }

  fs.writeFileSync(path.join(runRoot, '.skill-graft-e2e-run.json'), `${JSON.stringify({
    version: 1,
    runId,
    runRoot,
    createdAt: '2026-08-21T00:00:00.000Z'
  }, null, 2)}\n`)
  fs.writeFileSync(path.join(runRoot, '.skill-graft-p0-fixture.json'), `${JSON.stringify({
    version: 1,
    runId,
    preparedAt: '2026-08-21T00:01:00.000Z',
    hubCommit,
    probeCommit,
    probeCloneMode: 'shared-no-checkout',
    remoteRemoved: true,
    runtimeStateInitialized: true
  }, null, 2)}\n`)
  if (!omitClaim) {
    const claim = wrongClaim ? path.join(runRoot, 'wrong-probe') : probe
    fs.writeFileSync(path.join(hubData, 'overlay', 'attached-worktrees.txt'), `${claim}${process.platform === 'win32' ? '\r\n' : '\n'}`)
  }
  fs.mkdirSync(path.join(hubData, 'skill-review', 'history'), { recursive: true })
  fs.writeFileSync(path.join(hubData, 'skill-review', 'history', 'p0-attach.md'), '# P0 attach acceptance\n')
  if (followupSkillMutation) {
    fs.appendFileSync(path.join(skills, 'ozdqp-development', 'SKILL.md'), 'forbidden follow-up mutation\n')
  }
  runGit(hubData, ['add', '--', ...(!omitClaim ? ['overlay/attached-worktrees.txt'] : []), 'skill-review/history/p0-attach.md', ...(followupSkillMutation ? ['skills/ozdqp-development/SKILL.md'] : [])], homeRoot)
  runGit(hubData, ['commit', '-m', 'record P0 local Skill attach acceptance'], homeRoot)
  let actualHubCommit = runGit(hubData, ['rev-parse', 'HEAD'], homeRoot)
  if (secondFollowup) {
    fs.writeFileSync(path.join(hubData, 'skill-review', 'history', 'p0-attach-second.md'), '# unexpected second acceptance\n')
    runGit(hubData, ['add', '--', 'skill-review/history/p0-attach-second.md'], homeRoot)
    runGit(hubData, ['commit', '-m', 'unexpected second P0 acceptance commit'], homeRoot)
    actualHubCommit = runGit(hubData, ['rev-parse', 'HEAD'], homeRoot)
  }
  if (manifestUsesActualHead) {
    const manifestFile = path.join(runRoot, '.skill-graft-p0-fixture.json')
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
    manifest.hubCommit = actualHubCommit
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
  }

  fs.mkdirSync(path.join(probe, '.agents', 'skills'), { recursive: true })
  fs.mkdirSync(path.join(probe, '.codex'), { recursive: true })
  for (const name of requiredSkills) {
    fs.symlinkSync(
      path.join(skills, name),
      path.join(probe, '.agents', 'skills', name),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
  }
  fs.symlinkSync(
    path.join(hubData, 'overlay'),
    path.join(probe, '.codex', 'local-overlay'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  fs.linkSync(path.join(hubData, 'AGENTS.override.md'), path.join(probe, 'AGENTS.override.md'))
  return { actualHubCommit, executableFixture, runRoot, probe, hubData, skills, hubCommit, probeCommit, seed }
}

function createHistoricalV2(parent, homeRoot, {
  dirtyProbe = false,
  hubHeadDrift = false,
  retainedAlternate = false
} = {}) {
  const seed = path.join(parent, 'independent-v2-seed')
  const probeCommit = initializeRepo(seed, homeRoot, {
    'AGENTS.md': '# independent v2 probe\n',
    'baloot_client/fixture.txt': 'fixture\n'
  }, 'independent v2 probe seed')
  const runId = `p0-v2-source-${path.basename(parent).slice(-8)}`
  const runRoot = path.join(parent, runId)
  const probe = path.join(runRoot, 'probe')
  const hubData = path.join(runRoot, 'hub-data')
  const skills = path.join(hubData, 'skills')
  fs.mkdirSync(runRoot, { recursive: true })
  runGit(parent, ['clone', '--no-local', '--no-hardlinks', '--no-checkout', seed, probe], homeRoot)
  runGit(probe, ['remote', 'remove', 'origin'], homeRoot)
  runGit(probe, ['checkout', '--detach', probeCommit], homeRoot)
  assert.equal(fs.existsSync(path.join(probe, '.git', 'objects', 'info', 'alternates')), false)

  const hubFiles = {
    '.gitattributes': '# Skill Graft generated skills worktree policy v1\n/skills/** -text -filter -ident -working-tree-encoding\n',
    '.gitignore': 'private-runtime/\n',
    'AGENTS.override.md': '# independent v2 historical override\n',
    'overlay/attached-worktrees.txt': '',
    'overlay/prompts/attach.txt': 'attach fixture\n',
    'skills/ozdqp-development/scripts/executable-fixture.sh': '#!/bin/sh\nexit 0\n'
  }
  for (const name of requiredSkills) hubFiles[`skills/${name}/SKILL.md`] = `# ${name}\n`
  let hubCommit = initializeRepo(hubData, homeRoot, hubFiles, 'independent v2 hub fixture')
  fs.mkdirSync(path.join(skills, 'adopted'))
  fs.mkdirSync(path.join(skills, 'inbox'))
  const executableFixture = path.join(skills, 'ozdqp-development', 'scripts', 'executable-fixture.sh')
  fs.chmodSync(executableFixture, 0o755)
  runGit(hubData, ['update-index', '--chmod=+x', '--', 'skills/ozdqp-development/scripts/executable-fixture.sh'], homeRoot)
  runGit(hubData, ['commit', '--amend', '--no-edit'], homeRoot)
  hubCommit = runGit(hubData, ['rev-parse', 'HEAD'], homeRoot)
  runGit(hubData, ['config', 'core.autocrlf', 'false'], homeRoot)
  runGit(hubData, ['config', 'core.safecrlf', 'true'], homeRoot)
  const materialization = exactFixtureMaterialization(hubData, skills, hubCommit, homeRoot)

  fs.writeFileSync(path.join(runRoot, '.skill-graft-e2e-run.json'), `${JSON.stringify({
    version: 1,
    runId,
    runRoot,
    createdAt: '2026-08-21T00:00:00.000Z'
  }, null, 2)}\n`)
  fs.writeFileSync(path.join(runRoot, '.skill-graft-p0-fixture.json'), `${JSON.stringify({
    version: 2,
    runId,
    preparedAt: '2026-08-21T00:01:00.000Z',
    hubCommit,
    probeCommit,
    probeCloneMode: 'independent-no-local-no-hardlinks-no-checkout',
    probeAlternatesPresent: false,
    remoteRemoved: true,
    runtimeStateInitialized: true,
    skillsContentSha256: materialization.manifest.physicalSkillsContentSha256,
    skillsMaterialization: materialization.manifest
  }, null, 2)}\n`)

  if (hubHeadDrift) {
    fs.writeFileSync(path.join(hubData, 'post-manifest-drift.txt'), 'forbidden v2 drift\n')
    runGit(hubData, ['add', '--', 'post-manifest-drift.txt'], homeRoot)
    runGit(hubData, ['commit', '-m', 'forbidden post-manifest v2 drift'], homeRoot)
  }
  if (dirtyProbe) fs.appendFileSync(path.join(probe, 'AGENTS.md'), 'dirty v2 probe\n')
  if (retainedAlternate) {
    const info = path.join(probe, '.git', 'objects', 'info')
    fs.mkdirSync(info, { recursive: true })
    fs.writeFileSync(path.join(info, 'alternates'), `${path.join(seed, '.git', 'objects')}\n`)
  }
  return { executableFixture, hubCommit, hubData, probe, probeCommit, runRoot, seed, skills }
}

function targetPaths(parent, runId) {
  const root = path.join(parent, runId)
  return {
    runId,
    root,
    probe: path.join(root, 'probe'),
    hubData: path.join(root, 'hub-data'),
    cli: path.join(root, 'app', 'node_modules', '.bin', process.platform === 'win32' ? 'sg.cmd' : 'sg')
  }
}

function targetEnv(paths) {
  return {
    SKILL_GRAFT_REAL_E2E: '1',
    SKILL_GRAFT_RUN_ID: paths.runId,
    SKILL_GRAFT_E2E_ROOT: paths.root,
    SKILL_GRAFT_REAL_PROBE: paths.probe,
    SKILL_GRAFT_HOME: paths.hubData,
    HUB_ROOT: paths.hubData,
    SKILL_GRAFT_CLI: paths.cli
  }
}

function prepareTarget(paths, packageSource, protectedRoots = []) {
  const context = validateRealE2eEnvironment(targetEnv(paths), {
    homeDir: path.join(path.dirname(paths.root), 'unrelated-user-home'),
    workspaceRoot: packageSource,
    protectedRoots
  })
  createRunLayout(context)
  return context
}

function spawnConverter(env) {
  return spawnSync(process.execPath, [converter], {
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000,
    maxBuffer: 32 * 1024 * 1024
  })
}

function assertConversionTargetUntouched(paths) {
  assert.deepEqual(fs.readdirSync(paths.hubData), [])
  assert.deepEqual(fs.readdirSync(paths.probe), [])
  assert.equal(fs.existsSync(path.join(paths.root, '.skill-graft-p0-fixture.json')), false)
}

function markPhysicalMutationAssumeUnchanged(historical, relative, bytes, homeRoot) {
  fs.writeFileSync(path.join(historical.hubData, ...relative.split('/')), bytes)
  runGit(historical.hubData, ['update-index', '--assume-unchanged', '--', relative], homeRoot)
}

test('historical P0 v1 shared source converts to a marker-owned v2 fixture without alternates under hostile Git env', {
  timeout: 120000
}, (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-p0-v2-'))
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
  const homeRoot = path.join(parent, 'fixture-home')
  fs.mkdirSync(homeRoot)
  const packageSource = createPackageSource(parent, homeRoot)
  const historical = createHistoricalV1(parent, homeRoot, {
    exactBinary: true,
    nonUtf8Crlf: true,
    probeAttributes: '# 根目录中文注释：仅注释可使用 UTF-8\nAGENTS.md text eol=lf diff merge\n*.png binary\n',
    probeNestedAttributes: '  # 嵌套中文注释\n*.mat diff=unity-material merge=binary\nfixture.txt text eol=lf merge=unityyamlmerge\n*.png binary\n',
    realSkillShape29: true,
    worktreeProjection: 'crlf'
  })
  const victim = path.join(parent, 'hostile-git-victim')
  initializeRepo(victim, homeRoot, { 'sentinel.txt': 'victim must not change\n' }, 'victim baseline')
  const liveHub = path.join(parent, 'protected-live-hub')
  initializeRepo(liveHub, homeRoot, {
    '.gitignore': 'skill-review/daemon-heartbeat.json\n',
    'tracked-sentinel.txt': 'protected live Hub\n'
  }, 'protected live Hub baseline')
  const liveHeartbeat = path.join(liveHub, 'skill-review', 'daemon-heartbeat.json')
  fs.mkdirSync(path.dirname(liveHeartbeat), { recursive: true })
  fs.writeFileSync(liveHeartbeat, '{"tick":0}\n')
  const paths = targetPaths(parent, 'p0-convert-20260821-000000')
  prepareTarget(paths, packageSource, [historical.runRoot, victim, liveHub, historical.seed])

  const sourceBefore = treeFingerprint(historical.runRoot)
  const alternateBefore = treeFingerprint(path.join(historical.seed, '.git', 'objects'))
  const victimBefore = treeFingerprint(victim)
  const hostileConfig = path.join(parent, 'hostile.gitconfig')
  fs.writeFileSync(hostileConfig, '[core]\n\thooksPath = hostile-hooks\n')
  const env = {
    ...process.env,
    ...targetEnv(paths),
    SKILL_GRAFT_FIXTURE_SOURCE: packageSource,
    SKILL_GRAFT_P0_SOURCE_RUN: historical.runRoot,
    SKILL_GRAFT_PROTECTED_ROOTS: [victim, liveHub, historical.seed].join(path.delimiter),
    HOME: victim,
    USERPROFILE: victim,
    XDG_CONFIG_HOME: victim,
    APPDATA: victim,
    LOCALAPPDATA: victim,
    GIT_DIR: path.join(victim, '.git'),
    GIT_WORK_TREE: victim,
    GIT_INDEX_FILE: path.join(victim, '.git', 'index'),
    GIT_COMMON_DIR: path.join(victim, '.git'),
    GIT_OBJECT_DIRECTORY: path.join(victim, '.git', 'objects'),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(victim, '.git', 'objects'),
    GIT_CONFIG_GLOBAL: hostileConfig,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: path.join(parent, 'hostile-hooks'),
    GIT_OPTIONAL_LOCKS: '1',
    GIT_SSH_COMMAND: 'hostile-command'
  }
  const mutator = spawn(process.execPath, ['-e', [
    "const fs = require('node:fs')",
    'const files = process.argv.slice(1)',
    'let tick = 0',
    "const timer = setInterval(() => { tick += 1; for (const file of files) fs.writeFileSync(file, JSON.stringify({ tick }) + '\\n') }, 20)",
    'setTimeout(() => { clearInterval(timer); process.exit(0) }, 3000)'
  ].join(';'), path.join(packageSource, 'node_modules', 'transient.json'), liveHeartbeat], {
    stdio: 'ignore',
    windowsHide: true
  })
  t.after(() => { if (mutator.exitCode == null) mutator.kill('SIGKILL') })
  const converted = spawnConverter(env)
  assert.equal(converted.error, undefined, `converter spawn error: ${converted.error?.message || ''}`)
  assert.equal(converted.status, 0, `converter failed: ${converted.stderr || converted.stdout}`)

  const manifest = JSON.parse(fs.readFileSync(path.join(paths.root, '.skill-graft-p0-fixture.json'), 'utf8'))
  assert.deepEqual({
    version: manifest.version,
    runId: manifest.runId,
    probeCommit: manifest.probeCommit,
    probeCloneMode: manifest.probeCloneMode,
    probeAlternatesPresent: manifest.probeAlternatesPresent,
    remoteRemoved: manifest.remoteRemoved,
    runtimeStateInitialized: manifest.runtimeStateInitialized,
    convertedFromFixtureVersion: manifest.convertedFromFixtureVersion
  }, {
    version: 2,
    runId: paths.runId,
    probeCommit: historical.probeCommit,
    probeCloneMode: 'independent-no-local-no-hardlinks-no-checkout',
    probeAlternatesPresent: false,
    remoteRemoved: true,
    runtimeStateInitialized: true,
    convertedFromFixtureVersion: 1
  })
  assert.match(manifest.hubCommit, /^[0-9a-f]{40}$/i)
  assert.equal(manifest.convertedFrom.declaredHubCommit, historical.hubCommit)
  assert.equal(manifest.convertedFrom.actualHubCommit, historical.actualHubCommit)
  assert.match(manifest.convertedFrom.skillsTree, /^[0-9a-f]{40}$/i)
  assert.match(manifest.convertedFrom.physicalSkillsSha256, /^[0-9a-f]{64}$/i)
  assert.match(manifest.convertedFrom.physicalSkillsContentSha256, /^[0-9a-f]{64}$/i)
  assert.equal(manifest.skillsContentSha256, manifest.convertedFrom.physicalSkillsContentSha256)
  assert.equal(manifest.skillsMaterialization.policy, 'git-blob-exact-or-strict-crlf-v1')
  assert.equal(manifest.skillsMaterialization.projectionEntries, manifest.skillsMaterialization.exactEntries + manifest.skillsMaterialization.crlfEntries)
  assert.ok(manifest.skillsMaterialization.exactEntries >= 1)
  assert.ok(manifest.skillsMaterialization.crlfEntries >= 1)
  assert.equal(manifest.skillsMaterialization.targetSkillsTree, manifest.convertedFrom.skillsTree)
  assert.equal(manifest.convertedFrom.skillsMaterializationPolicy, manifest.skillsMaterialization.policy)
  assert.equal(manifest.convertedFrom.skillsGitManifestSha256, manifest.skillsMaterialization.gitManifestSha256)
  assert.equal(manifest.convertedFrom.skillsProjectionSha256, manifest.skillsMaterialization.projectionSha256)
  assert.equal(manifest.convertedFrom.skillsAttributesSha256, manifest.skillsMaterialization.attributesSha256)
  assert.equal(runGit(historical.hubData, ['ls-files', '--', 'skills'], homeRoot).split(/\r?\n/).filter(Boolean).length, 29)
  assert.equal(runGit(paths.hubData, ['ls-files', '--', 'skills'], path.join(paths.root, 'home')).split(/\r?\n/).filter(Boolean).length, 29)
  assert.equal(contentTreeDigest(paths.hubData + path.sep + 'skills'), contentTreeDigest(historical.skills))
  assert.equal(contentTreeDigest(paths.hubData + path.sep + 'skills'), manifest.skillsContentSha256)
  assert.equal(manifest.convertedFrom.probeProjectionKind, 'p0-v1-post-acceptance-attach-v1')
  assert.match(manifest.convertedFrom.probeProjectionSha256, /^[0-9a-f]{64}$/i)
  assert.ok(manifest.convertedFrom.probeProjectionEntries > 0)
  assert.equal(runGit(paths.probe, ['rev-parse', 'HEAD'], path.join(paths.root, 'home')), historical.probeCommit)
  assert.equal(runGit(paths.probe, ['remote'], path.join(paths.root, 'home')), '')
  assert.equal(runGit(paths.probe, ['status', '--porcelain=v1', '--untracked-files=all'], path.join(paths.root, 'home')), '')
  assert.equal(fs.existsSync(path.join(paths.probe, '.git', 'objects', 'info', 'alternates')), false)
  assert.equal(runGit(paths.hubData, ['rev-parse', 'HEAD'], path.join(paths.root, 'home')), manifest.hubCommit)
  assert.match(
    runGit(paths.hubData, ['ls-tree', 'HEAD', '--', 'skills/ozdqp-development/scripts/executable-fixture.sh'], path.join(paths.root, 'home')),
    /^100755 blob /,
    'target commit must preserve the verified source executable Git mode'
  )
  for (const name of requiredSkills) {
    assert.deepEqual(
      fs.readFileSync(path.join(paths.hubData, 'skills', name, 'SKILL.md')),
      fs.readFileSync(path.join(historical.skills, name, 'SKILL.md'))
    )
  }
  assert.deepEqual(
    fs.readFileSync(path.join(paths.hubData, 'skills', 'ozdqp-development', 'references', 'non-utf8.yaml')),
    fs.readFileSync(path.join(historical.skills, 'ozdqp-development', 'references', 'non-utf8.yaml'))
  )
  assert.equal(fs.readFileSync(path.join(paths.hubData, 'AGENTS.override.md'), 'utf8'), '# package-owned override\n')
  assert.equal(fs.existsSync(path.join(paths.hubData, 'private-runtime')), false, 'historical hub runtime must not be copied')
  assert.equal(treeFingerprint(historical.runRoot), sourceBefore, 'historical run must remain byte-for-byte unchanged')
  assert.equal(treeFingerprint(path.join(historical.seed, '.git', 'objects')), alternateBefore, 'alternate live objects must remain unchanged')
  assert.equal(treeFingerprint(victim), victimBefore, 'hostile Git variables must not mutate the victim repo')
  assert.ok(JSON.parse(fs.readFileSync(path.join(packageSource, 'node_modules', 'transient.json'), 'utf8')).tick > 0)
  assert.ok(JSON.parse(fs.readFileSync(liveHeartbeat, 'utf8')).tick > 0)

  const reconvertedPaths = targetPaths(parent, 'p0-reconvert-20260821-000001')
  prepareTarget(reconvertedPaths, packageSource, [paths.root, historical.runRoot, historical.seed, victim, liveHub])
  const reconverted = spawnConverter({
    ...process.env,
    ...targetEnv(reconvertedPaths),
    HOME: homeRoot,
    USERPROFILE: homeRoot,
    SKILL_GRAFT_FIXTURE_SOURCE: packageSource,
    SKILL_GRAFT_P0_SOURCE_RUN: paths.root,
    SKILL_GRAFT_PROTECTED_ROOTS: [historical.runRoot, historical.seed, victim, liveHub].join(path.delimiter)
  })
  assert.equal(reconverted.error, undefined, `reconverter spawn error: ${reconverted.error?.message || ''}`)
  assert.equal(reconverted.status, 0, `reconverter failed: ${reconverted.stderr || reconverted.stdout}`)
  const reconvertedManifest = JSON.parse(fs.readFileSync(path.join(reconvertedPaths.root, '.skill-graft-p0-fixture.json'), 'utf8'))
  assert.equal(reconvertedManifest.convertedFromFixtureVersion, manifest.convertedFromFixtureVersion)
  assert.deepEqual(reconvertedManifest.convertedFrom, manifest.convertedFrom)
  assert.deepEqual(reconvertedManifest.skillsMaterialization, manifest.skillsMaterialization)
})

test('exact-clean historical P0 v2 source converts while preserving empty allowances and Git modes', {
  timeout: 120000
}, (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-p0-v2-clean-'))
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
  const homeRoot = path.join(parent, 'fixture-home')
  fs.mkdirSync(homeRoot)
  const packageSource = createPackageSource(parent, homeRoot)
  const historical = createHistoricalV2(parent, homeRoot)
  const paths = targetPaths(parent, 'p0-convert-v2-clean-20260821')
  prepareTarget(paths, packageSource, [historical.runRoot, historical.seed])
  const converted = spawnConverter({
    ...process.env,
    ...targetEnv(paths),
    HOME: homeRoot,
    USERPROFILE: homeRoot,
    SKILL_GRAFT_FIXTURE_SOURCE: packageSource,
    SKILL_GRAFT_P0_SOURCE_RUN: historical.runRoot,
    SKILL_GRAFT_PROTECTED_ROOTS: historical.seed
  })
  assert.equal(converted.error, undefined, `converter spawn error: ${converted.error?.message || ''}`)
  assert.equal(converted.status, 0, `converter failed: ${converted.stderr || converted.stdout}`)
  const manifest = JSON.parse(fs.readFileSync(path.join(paths.root, '.skill-graft-p0-fixture.json'), 'utf8'))
  const sourceManifest = JSON.parse(fs.readFileSync(path.join(historical.runRoot, '.skill-graft-p0-fixture.json'), 'utf8'))
  assert.equal(manifest.convertedFromFixtureVersion, 2)
  assert.equal(manifest.convertedFrom.declaredHubCommit, historical.hubCommit)
  assert.equal(manifest.convertedFrom.actualHubCommit, historical.hubCommit)
  assert.equal(manifest.convertedFrom.probeProjectionKind, 'p0-v2-clean')
  assert.equal(manifest.convertedFrom.probeProjectionEntries, 0)
  assert.equal(manifest.skillsContentSha256, contentTreeDigest(historical.skills))
  assert.deepEqual(manifest.skillsMaterialization, sourceManifest.skillsMaterialization)
  assert.deepEqual(fs.readdirSync(path.join(paths.hubData, 'skills', 'adopted')), [])
  assert.deepEqual(fs.readdirSync(path.join(paths.hubData, 'skills', 'inbox')), [])
  assert.match(
    runGit(paths.hubData, ['ls-tree', 'HEAD', '--', 'skills/ozdqp-development/scripts/executable-fixture.sh'], path.join(paths.root, 'home')),
    /^100755 blob /
  )
  assert.equal(runGit(paths.probe, ['status', '--porcelain=v1', '--untracked-files=all'], path.join(paths.root, 'home')), '')
  assert.equal(fs.existsSync(path.join(paths.probe, '.git', 'objects', 'info', 'alternates')), false)

  const reconvertedPaths = targetPaths(parent, 'p0-convert-v2-clean-reconvert-20260821')
  prepareTarget(reconvertedPaths, packageSource, [paths.root, historical.runRoot, historical.seed])
  const reconverted = spawnConverter({
    ...process.env,
    ...targetEnv(reconvertedPaths),
    HOME: homeRoot,
    USERPROFILE: homeRoot,
    SKILL_GRAFT_FIXTURE_SOURCE: packageSource,
    SKILL_GRAFT_P0_SOURCE_RUN: paths.root,
    SKILL_GRAFT_PROTECTED_ROOTS: [historical.runRoot, historical.seed].join(path.delimiter)
  })
  assert.equal(reconverted.error, undefined, `reconverter spawn error: ${reconverted.error?.message || ''}`)
  assert.equal(reconverted.status, 0, `reconverter failed: ${reconverted.stderr || reconverted.stdout}`)
  const reconvertedManifest = JSON.parse(fs.readFileSync(path.join(reconvertedPaths.root, '.skill-graft-p0-fixture.json'), 'utf8'))
  assert.equal(reconvertedManifest.convertedFromFixtureVersion, 2)
  assert.deepEqual(reconvertedManifest.convertedFrom, manifest.convertedFrom)
  assert.deepEqual(reconvertedManifest.skillsMaterialization, manifest.skillsMaterialization)
})

for (const scenario of [
  {
    name: 'Hub HEAD drift',
    options: { hubHeadDrift: true },
    expected: /v2 hub-data HEAD does not match/i
  },
  {
    name: 'dirty probe',
    options: { dirtyProbe: true },
    expected: /v2 probe must be clean/i
  },
  {
    name: 'retained alternate',
    options: { retainedAlternate: true },
    expected: /v2 unexpectedly retained an alternate/i
  }
]) {
  test(`converter rejects historical P0 v2 source with ${scenario.name}`, { timeout: 60000 }, (t) => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-p0-v2-refuse-'))
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
    const homeRoot = path.join(parent, 'fixture-home')
    fs.mkdirSync(homeRoot)
    const packageSource = createPackageSource(parent, homeRoot)
    const historical = createHistoricalV2(parent, homeRoot, scenario.options)
    const paths = targetPaths(parent, `p0-v2-refuse-${Date.now().toString(36)}-${scenario.name.replaceAll(' ', '-').toLowerCase()}`)
    prepareTarget(paths, packageSource, [historical.runRoot])
    const refused = spawnConverter({
      ...process.env,
      ...targetEnv(paths),
      HOME: homeRoot,
      USERPROFILE: homeRoot,
      SKILL_GRAFT_FIXTURE_SOURCE: packageSource,
      SKILL_GRAFT_P0_SOURCE_RUN: historical.runRoot
    })
    assert.equal(refused.error, undefined, `converter spawn error: ${refused.error?.message || ''}`)
    assert.notEqual(refused.status, 0)
    assert.match(`${refused.stderr}\n${refused.stdout}`, scenario.expected)
    assert.deepEqual(fs.readdirSync(paths.hubData), [])
    assert.deepEqual(fs.readdirSync(paths.probe), [])
    assert.equal(fs.existsSync(path.join(paths.root, '.skill-graft-p0-fixture.json')), false)
  })
}

for (const scenario of [
  {
    name: 'single non-newline byte drift',
    bytes: Buffer.from('#!/bin/bash\r\nexit 0\r\n'),
    expected: /not an exact or strict-crlf projection/i
  },
  {
    name: 'bare LF bytes',
    bytes: Buffer.from('#!/bin/bash\nexit 0\n'),
    expected: /rejects a bare LF byte/i
  },
  {
    name: 'mixed LF and CRLF bytes',
    bytes: Buffer.from('#!/bin/sh\r\nexit 1\n'),
    expected: /rejects a bare LF byte/i
  },
  {
    name: 'bare CR bytes',
    bytes: Buffer.from('#!/bin/sh\rexit 0\r\n'),
    expected: /rejects a bare CR byte/i
  },
  {
    name: 'CRCRLF bytes',
    bytes: Buffer.from('#!/bin/sh\r\r\nexit 0\r\n'),
    expected: /rejects a bare CR byte/i
  },
  {
    name: 'physical NUL in a nonexact text projection',
    bytes: Buffer.concat([Buffer.from('#!/bin/sh\r\nexit 0\r\n'), Buffer.from([0])]),
    expected: /rejects NUL bytes/i
  },
  {
    name: 'blob NUL in a nonexact binary projection',
    historicalOptions: { exactBinary: true },
    relative: 'skills/ozdqp-development/references/exact-binary.bin',
    bytes: Buffer.from([0x00, 0x01, 0x03, 0xff]),
    expected: /not an exact or strict-crlf projection/i
  }
]) {
  test(`converter rejects ${scenario.name} before target materialization`, { timeout: 60000 }, (t) => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-p0-byte-refuse-'))
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
    const homeRoot = path.join(parent, 'fixture-home')
    fs.mkdirSync(homeRoot)
    const packageSource = createPackageSource(parent, homeRoot)
    const historical = createHistoricalV1(parent, homeRoot, scenario.historicalOptions)
    const relative = scenario.relative || 'skills/ozdqp-development/scripts/executable-fixture.sh'
    markPhysicalMutationAssumeUnchanged(historical, relative, scenario.bytes, homeRoot)
    const paths = targetPaths(parent, `p0-byte-refuse-${Date.now().toString(36)}`)
    prepareTarget(paths, packageSource, [historical.runRoot])
    const refused = spawnConverter({
      ...process.env,
      ...targetEnv(paths),
      HOME: homeRoot,
      USERPROFILE: homeRoot,
      SKILL_GRAFT_FIXTURE_SOURCE: packageSource,
      SKILL_GRAFT_P0_SOURCE_RUN: historical.runRoot
    })
    assert.equal(refused.error, undefined, `converter spawn error: ${refused.error?.message || ''}`)
    assert.notEqual(refused.status, 0)
    assert.match(`${refused.stderr}\n${refused.stdout}`, scenario.expected)
    assertConversionTargetUntouched(paths)
  })
}

for (const unsafeSkillPath of [
  'skills/ozdqp-development/references/unsafe name.md',
  'skills/ozdqp-development/references/\u4e0d\u5b89\u5168.md'
]) {
  test(`converter rejects generated-attributes-unsafe skills path ${JSON.stringify(unsafeSkillPath)}`, { timeout: 60000 }, (t) => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-p0-attr-path-refuse-'))
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
    const homeRoot = path.join(parent, 'fixture-home')
    fs.mkdirSync(homeRoot)
    const packageSource = createPackageSource(parent, homeRoot)
    const historical = createHistoricalV1(parent, homeRoot, { unsafeSkillPath })
    const paths = targetPaths(parent, `p0-attr-path-refuse-${Date.now().toString(36)}`)
    prepareTarget(paths, packageSource, [historical.runRoot])
    const refused = spawnConverter({
      ...process.env,
      ...targetEnv(paths),
      HOME: homeRoot,
      USERPROFILE: homeRoot,
      SKILL_GRAFT_FIXTURE_SOURCE: packageSource,
      SKILL_GRAFT_P0_SOURCE_RUN: historical.runRoot
    })
    assert.equal(refused.error, undefined, `converter spawn error: ${refused.error?.message || ''}`)
    assert.notEqual(refused.status, 0)
    assert.match(`${refused.stderr}\n${refused.stdout}`, /cannot be encoded safely in the generated attributes policy/i)
    assertConversionTargetUntouched(paths)
  })
}

test('converter rejects a v1 working-tree-encoding attributes policy before status or target writes', { timeout: 60000 }, (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-p0-wte-refuse-'))
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
  const homeRoot = path.join(parent, 'fixture-home')
  fs.mkdirSync(homeRoot)
  const packageSource = createPackageSource(parent, homeRoot)
  const historical = createHistoricalV1(parent, homeRoot, {
    rootAttributes: 'skills/** working-tree-encoding=UTF-16LE\n'
  })
  const paths = targetPaths(parent, 'p0-wte-refuse-20260821')
  prepareTarget(paths, packageSource, [historical.runRoot])
  const refused = spawnConverter({
    ...process.env,
    ...targetEnv(paths),
    HOME: homeRoot,
    USERPROFILE: homeRoot,
    SKILL_GRAFT_FIXTURE_SOURCE: packageSource,
    SKILL_GRAFT_P0_SOURCE_RUN: historical.runRoot
  })
  assert.equal(refused.error, undefined, `converter spawn error: ${refused.error?.message || ''}`)
  assert.notEqual(refused.status, 0)
  assert.match(`${refused.stderr}\n${refused.stdout}`, /v1 source must not contain root \.gitattributes/i)
  assertConversionTargetUntouched(paths)
})

test('converter rejects source index skills OID drift before status or target writes', { timeout: 60000 }, (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-p0-index-refuse-'))
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
  const homeRoot = path.join(parent, 'fixture-home')
  fs.mkdirSync(homeRoot)
  const packageSource = createPackageSource(parent, homeRoot)
  const historical = createHistoricalV1(parent, homeRoot)
  const relative = 'skills/ozdqp-development/SKILL.md'
  const physical = path.join(historical.hubData, ...relative.split('/'))
  const original = fs.readFileSync(physical)
  fs.writeFileSync(physical, Buffer.concat([original, Buffer.from('index-only drift\n')]))
  runGit(historical.hubData, ['add', '--', relative], homeRoot)
  fs.writeFileSync(physical, original)
  const paths = targetPaths(parent, 'p0-index-refuse-20260821')
  prepareTarget(paths, packageSource, [historical.runRoot])
  const refused = spawnConverter({
    ...process.env,
    ...targetEnv(paths),
    HOME: homeRoot,
    USERPROFILE: homeRoot,
    SKILL_GRAFT_FIXTURE_SOURCE: packageSource,
    SKILL_GRAFT_P0_SOURCE_RUN: historical.runRoot
  })
  assert.equal(refused.error, undefined, `converter spawn error: ${refused.error?.message || ''}`)
  assert.notEqual(refused.status, 0)
  assert.match(`${refused.stderr}\n${refused.stdout}`, /historical source index skills manifest does not match/i)
  assertConversionTargetUntouched(paths)
})

test('converter rejects source local filter and attributes without invoking the filter', { timeout: 60000 }, (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-p0-filter-refuse-'))
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
  const homeRoot = path.join(parent, 'fixture-home')
  fs.mkdirSync(homeRoot)
  const packageSource = createPackageSource(parent, homeRoot)
  const historical = createHistoricalV1(parent, homeRoot)
  const sentinel = path.join(parent, 'filter-must-not-run.txt')
  const filterScript = path.join(parent, 'hostile-filter.mjs')
  fs.writeFileSync(filterScript, [
    "import fs from 'node:fs'",
    `fs.writeFileSync(${JSON.stringify(sentinel)}, 'filter executed\\n')`,
    'process.stdin.pipe(process.stdout)',
    ''
  ].join('\n'))
  const infoAttributes = path.join(historical.hubData, '.git', 'info', 'attributes')
  fs.mkdirSync(path.dirname(infoAttributes), { recursive: true })
  fs.writeFileSync(infoAttributes, 'skills/** filter=hostile\n')
  runGit(historical.hubData, ['config', 'filter.hostile.clean', `"${process.execPath}" "${filterScript}"`], homeRoot)
  runGit(historical.hubData, ['config', 'filter.hostile.smudge', `"${process.execPath}" "${filterScript}"`], homeRoot)
  const paths = targetPaths(parent, 'p0-filter-refuse-20260821')
  prepareTarget(paths, packageSource, [historical.runRoot, filterScript])
  const refused = spawnConverter({
    ...process.env,
    ...targetEnv(paths),
    HOME: homeRoot,
    USERPROFILE: homeRoot,
    SKILL_GRAFT_FIXTURE_SOURCE: packageSource,
    SKILL_GRAFT_P0_SOURCE_RUN: historical.runRoot
  })
  assert.equal(refused.error, undefined, `converter spawn error: ${refused.error?.message || ''}`)
  assert.notEqual(refused.status, 0)
  assert.match(`${refused.stderr}\n${refused.stdout}`, /\.git\/info\/attributes|external Git conversion policy/i)
  assert.equal(fs.existsSync(sentinel), false, 'hostile clean/smudge filter must not execute')
  assertConversionTargetUntouched(paths)
})

test('converter rejects tampered v2 generated attributes before status or target writes', { timeout: 60000 }, (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-p0-v2-attrs-refuse-'))
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
  const homeRoot = path.join(parent, 'fixture-home')
  fs.mkdirSync(homeRoot)
  const packageSource = createPackageSource(parent, homeRoot)
  const historical = createHistoricalV2(parent, homeRoot)
  const attributes = path.join(historical.hubData, '.gitattributes')
  fs.appendFileSync(attributes, 'skills/** filter=hostile\n')
  runGit(historical.hubData, ['update-index', '--assume-unchanged', '--', '.gitattributes'], homeRoot)
  const paths = targetPaths(parent, 'p0-v2-attrs-refuse-20260821')
  prepareTarget(paths, packageSource, [historical.runRoot])
  const refused = spawnConverter({
    ...process.env,
    ...targetEnv(paths),
    HOME: homeRoot,
    USERPROFILE: homeRoot,
    SKILL_GRAFT_FIXTURE_SOURCE: packageSource,
    SKILL_GRAFT_P0_SOURCE_RUN: historical.runRoot
  })
  assert.equal(refused.error, undefined, `converter spawn error: ${refused.error?.message || ''}`)
  assert.notEqual(refused.status, 0)
  assert.match(`${refused.stderr}\n${refused.stdout}`, /v2 skills materialization provenance is invalid or was tampered/i)
  assertConversionTargetUntouched(paths)
})

test('converter rejects historical Hub object alternates before object lookup or target writes', { timeout: 60000 }, (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-p0-hub-alternate-refuse-'))
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
  const homeRoot = path.join(parent, 'fixture-home')
  fs.mkdirSync(homeRoot)
  const packageSource = createPackageSource(parent, homeRoot)
  const historical = createHistoricalV1(parent, homeRoot)
  const info = path.join(historical.hubData, '.git', 'objects', 'info')
  fs.mkdirSync(info, { recursive: true })
  fs.writeFileSync(path.join(info, 'alternates'), `${path.join(historical.seed, '.git', 'objects')}\n`)
  const paths = targetPaths(parent, 'p0-hub-alternate-refuse-20260821')
  prepareTarget(paths, packageSource, [historical.runRoot, historical.seed])
  const refused = spawnConverter({
    ...process.env,
    ...targetEnv(paths),
    HOME: homeRoot,
    USERPROFILE: homeRoot,
    SKILL_GRAFT_FIXTURE_SOURCE: packageSource,
    SKILL_GRAFT_P0_SOURCE_RUN: historical.runRoot,
    SKILL_GRAFT_PROTECTED_ROOTS: historical.seed
  })
  assert.equal(refused.error, undefined, `converter spawn error: ${refused.error?.message || ''}`)
  assert.notEqual(refused.status, 0)
  assert.match(`${refused.stderr}\n${refused.stdout}`, /hub-data must not use an alternate object database/i)
  assertConversionTargetUntouched(paths)
})

test('converter preflights probe worktree filters and unsafe attributes without executing them', { timeout: 120000 }, (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-p0-probe-filter-refuse-'))
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
  const homeRoot = path.join(parent, 'fixture-home')
  fs.mkdirSync(homeRoot)
  const packageSource = createPackageSource(parent, homeRoot)
  const historical = createHistoricalV1(parent, homeRoot, {
    probeAttributes: 'AGENTS.md filter=hostile\n'
  })
  const sentinel = path.join(parent, 'probe-filter-must-not-run.txt')
  const filterScript = path.join(parent, 'hostile-probe-filter.mjs')
  fs.writeFileSync(filterScript, [
    "import fs from 'node:fs'",
    `fs.writeFileSync(${JSON.stringify(sentinel)}, 'probe filter executed\\n')`,
    'process.stdin.pipe(process.stdout)',
    ''
  ].join('\n'))
  const filterCommand = `"${process.execPath}" "${filterScript}"`
  runGit(historical.probe, ['config', 'extensions.worktreeConfig', 'true'], homeRoot)
  runGit(historical.probe, ['config', '--worktree', 'filter.hostile.clean', filterCommand], homeRoot)
  runGit(historical.probe, ['config', '--worktree', 'filter.hostile.smudge', filterCommand], homeRoot)

  const configPaths = targetPaths(parent, 'p0-probe-worktree-filter-refuse-20260821')
  prepareTarget(configPaths, packageSource, [historical.runRoot, filterScript])
  const configRefused = spawnConverter({
    ...process.env,
    ...targetEnv(configPaths),
    HOME: homeRoot,
    USERPROFILE: homeRoot,
    SKILL_GRAFT_FIXTURE_SOURCE: packageSource,
    SKILL_GRAFT_P0_SOURCE_RUN: historical.runRoot
  })
  assert.equal(configRefused.error, undefined, `converter spawn error: ${configRefused.error?.message || ''}`)
  assert.notEqual(configRefused.status, 0)
  assert.match(`${configRefused.stderr}\n${configRefused.stdout}`, /historical probe contains an external Git conversion policy/i)
  assert.equal(fs.existsSync(sentinel), false, 'probe filter must not execute during config preflight')
  assertConversionTargetUntouched(configPaths)

  runGit(historical.probe, ['config', '--worktree', '--unset-all', 'filter.hostile.clean'], homeRoot)
  runGit(historical.probe, ['config', '--worktree', '--unset-all', 'filter.hostile.smudge'], homeRoot)
  const attributesPaths = targetPaths(parent, 'p0-probe-attributes-refuse-20260821')
  prepareTarget(attributesPaths, packageSource, [historical.runRoot, filterScript])
  const attributesRefused = spawnConverter({
    ...process.env,
    ...targetEnv(attributesPaths),
    HOME: homeRoot,
    USERPROFILE: homeRoot,
    SKILL_GRAFT_FIXTURE_SOURCE: packageSource,
    SKILL_GRAFT_P0_SOURCE_RUN: historical.runRoot
  })
  assert.equal(attributesRefused.error, undefined, `converter spawn error: ${attributesRefused.error?.message || ''}`)
  assert.notEqual(attributesRefused.status, 0)
  assert.match(`${attributesRefused.stderr}\n${attributesRefused.stdout}`, /unsafe conversion attribute/i)
  assert.equal(fs.existsSync(sentinel), false, 'probe filter must not execute during attributes preflight')
  assertConversionTargetUntouched(attributesPaths)
})

test('converter rejects isolated global attributes before a binary macro can execute a filter', { timeout: 60000 }, (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-p0-global-attrs-refuse-'))
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
  const homeRoot = path.join(parent, 'fixture-home')
  fs.mkdirSync(homeRoot)
  const packageSource = createPackageSource(parent, homeRoot)
  const historical = createHistoricalV1(parent, homeRoot, {
    probeAttributes: 'AGENTS.md binary\n'
  })
  const sentinel = path.join(parent, 'global-attributes-filter-must-not-run.txt')
  const filterScript = path.join(parent, 'hostile-global-attributes-filter.mjs')
  fs.writeFileSync(filterScript, [
    "import fs from 'node:fs'",
    `fs.writeFileSync(${JSON.stringify(sentinel)}, 'global attributes filter executed\\n')`,
    'process.stdin.pipe(process.stdout)',
    ''
  ].join('\n'))
  const filterCommand = `"${process.execPath}" "${filterScript}"`
  runGit(historical.probe, ['config', 'filter.hostile.clean', filterCommand], homeRoot)
  runGit(historical.probe, ['config', 'filter.hostile.smudge', filterCommand], homeRoot)
  const paths = targetPaths(parent, 'p0-global-attrs-refuse-20260821')
  const context = prepareTarget(paths, packageSource, [historical.runRoot, filterScript])
  const globalAttributes = path.join(context.homeRoot, 'xdg-config', 'git', 'attributes')
  fs.mkdirSync(path.dirname(globalAttributes), { recursive: true })
  fs.writeFileSync(globalAttributes, '[attr]binary filter=hostile\n')
  const refused = spawnConverter({
    ...process.env,
    ...targetEnv(paths),
    HOME: homeRoot,
    USERPROFILE: homeRoot,
    SKILL_GRAFT_FIXTURE_SOURCE: packageSource,
    SKILL_GRAFT_P0_SOURCE_RUN: historical.runRoot
  })
  assert.equal(refused.error, undefined, `converter spawn error: ${refused.error?.message || ''}`)
  assert.notEqual(refused.status, 0)
  assert.match(`${refused.stderr}\n${refused.stdout}`, /isolated Git environment must not contain global attributes/i)
  assert.equal(fs.existsSync(sentinel), false, 'global attributes must be rejected before their filter can execute')
  assertConversionTargetUntouched(paths)
})

test('converter requires probe physical index and HEAD attributes identity before status', { timeout: 60000 }, (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-p0-probe-attrs-drift-'))
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
  const homeRoot = path.join(parent, 'fixture-home')
  fs.mkdirSync(homeRoot)
  const packageSource = createPackageSource(parent, homeRoot)
  const historical = createHistoricalV1(parent, homeRoot, {
    probeAttributes: 'AGENTS.md text eol=lf diff merge\n'
  })
  fs.writeFileSync(path.join(historical.probe, '.gitattributes'), 'AGENTS.md text eol=crlf diff merge\n')
  const paths = targetPaths(parent, 'p0-probe-attrs-drift-20260821')
  prepareTarget(paths, packageSource, [historical.runRoot])
  const refused = spawnConverter({
    ...process.env,
    ...targetEnv(paths),
    HOME: homeRoot,
    USERPROFILE: homeRoot,
    SKILL_GRAFT_FIXTURE_SOURCE: packageSource,
    SKILL_GRAFT_P0_SOURCE_RUN: historical.runRoot
  })
  assert.equal(refused.error, undefined, `converter spawn error: ${refused.error?.message || ''}`)
  assert.notEqual(refused.status, 0)
  assert.match(`${refused.stderr}\n${refused.stdout}`, /physical, index, and HEAD \.gitattributes are not identical/i)
  assertConversionTargetUntouched(paths)
})

for (const scenario of [
  {
    name: 'non-ASCII active attributes syntax',
    probeAttributes: '技能/** text eol=lf\n',
    expected: /active \.gitattributes syntax must remain ASCII/i
  },
  {
    name: 'invalid UTF-8 in an attributes comment',
    probeAttributes: Buffer.from([0x23, 0x20, 0xff, 0x0a]),
    expected: /must contain valid UTF-8/i
  },
  {
    name: 'unset binary macro state',
    probeAttributes: '*.png -binary\n',
    expected: /only allows the exact built-in binary macro token/i
  },
  {
    name: 'valued binary macro state',
    probeAttributes: '*.png binary=custom\n',
    expected: /only allows the exact built-in binary macro token/i
  },
  {
    name: 'uppercase binary macro token',
    probeAttributes: '*.png BINARY\n',
    expected: /only allows the exact built-in binary macro token/i
  },
  {
    name: 'mixed-case binary macro token',
    probeAttributes: '*.png BiNaRy\n',
    expected: /only allows the exact built-in binary macro token/i
  },
  {
    name: 'user-defined binary macro',
    probeAttributes: '[attr]binary -text -diff -merge\n',
    expected: /unsafe pattern or macro/i
  }
]) {
  test(`converter rejects probe ${scenario.name} before status or target writes`, { timeout: 60000 }, (t) => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-p0-probe-utf8-refuse-'))
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
    const homeRoot = path.join(parent, 'fixture-home')
    fs.mkdirSync(homeRoot)
    const packageSource = createPackageSource(parent, homeRoot)
    const historical = createHistoricalV1(parent, homeRoot, {
      probeAttributes: scenario.probeAttributes
    })
    const paths = targetPaths(parent, `p0-probe-utf8-refuse-${Date.now().toString(36)}`)
    prepareTarget(paths, packageSource, [historical.runRoot])
    const refused = spawnConverter({
      ...process.env,
      ...targetEnv(paths),
      HOME: homeRoot,
      USERPROFILE: homeRoot,
      SKILL_GRAFT_FIXTURE_SOURCE: packageSource,
      SKILL_GRAFT_P0_SOURCE_RUN: historical.runRoot
    })
    assert.equal(refused.error, undefined, `converter spawn error: ${refused.error?.message || ''}`)
    assert.notEqual(refused.status, 0)
    assert.match(`${refused.stderr}\n${refused.stdout}`, scenario.expected)
    assertConversionTargetUntouched(paths)
  })
}

test('Git protected-root fingerprint never executes a hostile clean filter', { timeout: 120000 }, (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-p0-fingerprint-filter-'))
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
  const homeRoot = path.join(parent, 'fixture-home')
  fs.mkdirSync(homeRoot)
  const packageSource = createPackageSource(parent, homeRoot)
  const historical = createHistoricalV1(parent, homeRoot)
  const protectedRoot = path.join(parent, 'protected-hostile-filter')
  initializeRepo(protectedRoot, homeRoot, { 'tracked-sentinel.txt': 'must remain raw\n' }, 'protected filter baseline')
  const sentinel = path.join(parent, 'protected-filter-must-not-run.txt')
  const filterScript = path.join(parent, 'hostile-protected-filter.mjs')
  fs.writeFileSync(filterScript, [
    "import fs from 'node:fs'",
    `fs.writeFileSync(${JSON.stringify(sentinel)}, 'protected filter executed\\n')`,
    'process.stdin.pipe(process.stdout)',
    ''
  ].join('\n'))
  fs.writeFileSync(path.join(protectedRoot, '.gitattributes'), 'tracked-sentinel.txt filter=hostile\n')
  const filterCommand = `"${process.execPath}" "${filterScript}"`
  runGit(protectedRoot, ['config', 'filter.hostile.clean', filterCommand], homeRoot)
  runGit(protectedRoot, ['config', 'filter.hostile.smudge', filterCommand], homeRoot)
  const protectedBefore = treeFingerprint(protectedRoot)
  const paths = targetPaths(parent, 'p0-fingerprint-filter-20260821')
  prepareTarget(paths, packageSource, [historical.runRoot, protectedRoot, filterScript])
  const converted = spawnConverter({
    ...process.env,
    ...targetEnv(paths),
    HOME: homeRoot,
    USERPROFILE: homeRoot,
    SKILL_GRAFT_FIXTURE_SOURCE: packageSource,
    SKILL_GRAFT_P0_SOURCE_RUN: historical.runRoot,
    SKILL_GRAFT_PROTECTED_ROOTS: protectedRoot
  })
  assert.equal(converted.error, undefined, `converter spawn error: ${converted.error?.message || ''}`)
  assert.equal(converted.status, 0, `converter failed: ${converted.stderr || converted.stdout}`)
  assert.equal(fs.existsSync(sentinel), false, 'Git semantic fingerprint must never execute a clean filter')
  assert.equal(treeFingerprint(protectedRoot), protectedBefore, 'protected filter repository must remain unchanged')
})

test('converter rejects correlated convertedFrom tampering before v2 target writes', { timeout: 120000 }, (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-p0-lineage-refuse-'))
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
  const homeRoot = path.join(parent, 'fixture-home')
  fs.mkdirSync(homeRoot)
  const packageSource = createPackageSource(parent, homeRoot)
  const historical = createHistoricalV2(parent, homeRoot)
  const manifestFile = path.join(historical.runRoot, '.skill-graft-p0-fixture.json')
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  const materialization = manifest.skillsMaterialization
  manifest.convertedFromFixtureVersion = 2
  const canonicalLineage = {
    fixtureVersion: 2,
    declaredHubCommit: historical.hubCommit,
    actualHubCommit: historical.hubCommit,
    skillsTree: materialization.targetSkillsTree,
    physicalSkillsSha256: materialization.physicalSkillsSha256,
    physicalSkillsContentSha256: materialization.physicalSkillsContentSha256,
    probeProjectionKind: 'p0-v2-clean',
    probeProjectionSha256: createHash('sha256').update('skill-graft:p0-v2-clean-projection:v1\0', 'utf8').digest('hex'),
    probeProjectionEntries: 0,
    skillsMaterializationPolicy: materialization.policy,
    skillsGitManifestSha256: materialization.gitManifestSha256,
    skillsProjectionSha256: materialization.projectionSha256,
    skillsProjectionEntries: materialization.projectionEntries,
    skillsExactEntries: materialization.exactEntries,
    skillsCrlfEntries: materialization.crlfEntries,
    skillsAttributesSha256: materialization.attributesSha256,
    targetSkillsTree: materialization.targetSkillsTree
  }
  const refuse = (runId, mutate) => {
    manifest.convertedFrom = structuredClone(canonicalLineage)
    mutate(manifest.convertedFrom)
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
    const paths = targetPaths(parent, runId)
    prepareTarget(paths, packageSource, [historical.runRoot])
    const refused = spawnConverter({
      ...process.env,
      ...targetEnv(paths),
      HOME: homeRoot,
      USERPROFILE: homeRoot,
      SKILL_GRAFT_FIXTURE_SOURCE: packageSource,
      SKILL_GRAFT_P0_SOURCE_RUN: historical.runRoot
    })
    assert.equal(refused.error, undefined, `converter spawn error: ${refused.error?.message || ''}`)
    assert.notEqual(refused.status, 0)
    assert.match(`${refused.stderr}\n${refused.stdout}`, /convertedFrom provenance is invalid or was tampered/i)
    assertConversionTargetUntouched(paths)
  }
  refuse('p0-lineage-physical-refuse-20260821', (candidate) => {
    candidate.physicalSkillsContentSha256 = 'f'.repeat(64)
  })
  refuse('p0-lineage-clean-hash-refuse-20260821', (candidate) => {
    candidate.probeProjectionSha256 = 'e'.repeat(64)
  })
})

for (const scenario of [
  {
    name: 'extra projection file',
    mutate: ({ historical }) => fs.writeFileSync(path.join(historical.probe, 'extra-projection.txt'), 'extra\n'),
    expected: /projection does not exactly match/i
  },
  {
    name: 'wrong resident Skill Junction target',
    mutate: ({ historical }) => {
      const target = path.join(historical.probe, '.agents', 'skills', 'ozdqp-development')
      fs.unlinkSync(target)
      fs.symlinkSync(
        path.join(historical.skills, 'ozdqp-git-workflow'),
        target,
        process.platform === 'win32' ? 'junction' : 'dir'
      )
    },
    expected: /resident Skill projection.*wrong target/i
  },
  {
    name: 'ordinary override copy',
    mutate: ({ historical }) => {
      const override = path.join(historical.probe, 'AGENTS.override.md')
      fs.unlinkSync(override)
      fs.copyFileSync(path.join(historical.hubData, 'AGENTS.override.md'), override)
    },
    expected: /must be the exact Hub hardlink/i
  },
  {
    name: 'follow-up skills mutation',
    historicalOptions: { followupSkillMutation: true },
    mutate: () => {},
    expected: /follow-up changed the skills tree/i
  },
  {
    name: 'second follow-up commit',
    historicalOptions: { secondFollowup: true },
    mutate: () => {},
    expected: /must be exactly one commit/i
  },
  {
    name: 'missing claim diff',
    historicalOptions: { omitClaim: true },
    mutate: () => {},
    expected: /exactly one claim and one history/i
  },
  {
    name: 'wrong claim content',
    historicalOptions: { wrongClaim: true },
    mutate: () => {},
    expected: /claim must uniquely identify/i
  },
  {
    name: 'manifest hubCommit rewritten to actual HEAD',
    historicalOptions: { manifestUsesActualHead: true },
    mutate: () => {},
    expected: /must be exactly one commit/i
  },
  {
    name: 'nonempty declared claim baseline',
    historicalOptions: { declaredClaimContents: 'stale-claim\n' },
    mutate: () => {},
    expected: /empty overlay\/attached-worktrees\.txt baseline/i
  },
  {
    name: 'missing declared claim baseline',
    historicalOptions: { declaredClaimMissing: true },
    mutate: () => {},
    expected: /must contain overlay\/attached-worktrees\.txt as a regular blob/i
  },
  {
    name: 'untracked evil empty skills directory',
    historicalOptions: { evilEmptyDirectory: true },
    mutate: () => {},
    expected: /outside the adopted\/inbox empty-directory allowance/i
  },
  {
    name: 'unsupported Git symlink mode',
    historicalOptions: { unsupportedGitMode: 'symlink' },
    mutate: () => {},
    expected: /symlink, submodule, or unsupported blob mode/i
  },
  {
    name: 'unsupported Git submodule mode',
    historicalOptions: { unsupportedGitMode: 'submodule' },
    mutate: () => {},
    expected: /symlink, submodule, or unsupported blob mode/i
  },
  {
    name: 'malformed 41-character manifest object ID',
    mutate: ({ historical }) => {
      const manifestFile = path.join(historical.runRoot, '.skill-graft-p0-fixture.json')
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
      manifest.hubCommit = 'a'.repeat(41)
      fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
    },
    expected: /invalid hubCommit/i
  }
]) {
  test(`converter rejects v1 post-acceptance ${scenario.name}`, { timeout: 60000 }, (t) => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-p0-projection-'))
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
    const homeRoot = path.join(parent, 'fixture-home')
    fs.mkdirSync(homeRoot)
    const packageSource = createPackageSource(parent, homeRoot)
    const historical = createHistoricalV1(parent, homeRoot, scenario.historicalOptions)
    scenario.mutate({ historical })
    const paths = targetPaths(parent, `p0-refuse-${Date.now().toString(36)}-${scenario.name.replaceAll(' ', '-').toLowerCase()}`)
    prepareTarget(paths, packageSource, [historical.runRoot])
    const refused = spawnConverter({
      ...process.env,
      ...targetEnv(paths),
      HOME: homeRoot,
      USERPROFILE: homeRoot,
      SKILL_GRAFT_FIXTURE_SOURCE: packageSource,
      SKILL_GRAFT_P0_SOURCE_RUN: historical.runRoot
    })
    assert.equal(refused.error, undefined, `converter spawn error: ${refused.error?.message || ''}`)
    assert.notEqual(refused.status, 0)
    assert.match(`${refused.stderr}\n${refused.stdout}`, scenario.expected)
    assert.deepEqual(fs.readdirSync(paths.hubData), [])
    assert.deepEqual(fs.readdirSync(paths.probe), [])
    assert.equal(fs.existsSync(path.join(paths.root, '.skill-graft-p0-fixture.json')), false)
  })
}

test('initial source fingerprint escape is path-redacted and cannot write the target', {
  timeout: 60000
}, (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-p0-redaction-'))
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
  const homeRoot = path.join(parent, 'fixture-home')
  fs.mkdirSync(homeRoot)
  const packageSource = createPackageSource(parent, homeRoot)
  const historical = createHistoricalV1(parent, homeRoot)
  const outside = path.join(parent, 'outside-fingerprint-secret')
  const sentinel = path.join(outside, 'sentinel-private-name.txt')
  fs.mkdirSync(outside)
  fs.writeFileSync(sentinel, 'must remain private and unchanged\n')
  const escape = path.join(historical.runRoot, 'fingerprint-escape-junction')
  fs.symlinkSync(outside, escape, process.platform === 'win32' ? 'junction' : 'dir')
  const paths = targetPaths(parent, 'p0-redacted-fingerprint-20260821')
  prepareTarget(paths, packageSource, [historical.runRoot, outside])
  const refused = spawnConverter({
    ...process.env,
    ...targetEnv(paths),
    HOME: homeRoot,
    USERPROFILE: homeRoot,
    SKILL_GRAFT_FIXTURE_SOURCE: packageSource,
    SKILL_GRAFT_P0_SOURCE_RUN: historical.runRoot
  })
  assert.equal(refused.error, undefined, `converter spawn error: ${refused.error?.message || ''}`)
  assert.notEqual(refused.status, 0)
  const output = `${refused.stderr}\n${refused.stdout}`.toLowerCase()
  assert.match(output, /rootidentitysha256=[0-9a-f]{64}/i)
  for (const secret of [historical.runRoot, escape, outside, sentinel]) {
    assert.equal(output.includes(secret.toLowerCase()), false, `initial fingerprint refusal leaked ${path.basename(secret)}`)
  }
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'must remain private and unchanged\n')
  assert.deepEqual(fs.readdirSync(paths.hubData), [])
  assert.deepEqual(fs.readdirSync(paths.probe), [])
  assert.equal(fs.existsSync(path.join(paths.root, '.skill-graft-p0-fixture.json')), false)
})

test('converter reports a path-free root identity and before/after hashes when a protected tracked file changes', {
  timeout: 60000
}, (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-p0-fingerprint-'))
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
  const homeRoot = path.join(parent, 'fixture-home')
  fs.mkdirSync(homeRoot)
  const packageSource = createPackageSource(parent, homeRoot)
  const historical = createHistoricalV1(parent, homeRoot)
  const protectedRoot = path.join(parent, 'protected-git-worktree')
  initializeRepo(protectedRoot, homeRoot, { 'tracked-sentinel.txt': 'before\n' }, 'protected baseline')
  const paths = targetPaths(parent, 'p0-protected-change-20260821')
  prepareTarget(paths, packageSource, [historical.runRoot, protectedRoot])
  const mutator = spawn(process.execPath, ['-e', [
    "const fs = require('node:fs')",
    'const file = process.argv[1]',
    "setTimeout(() => { fs.writeFileSync(file, 'after\\n'); process.exit(0) }, 4000)"
  ].join(';'), path.join(protectedRoot, 'tracked-sentinel.txt')], {
    stdio: 'ignore',
    windowsHide: true
  })
  t.after(() => { if (mutator.exitCode == null) mutator.kill('SIGKILL') })
  const refused = spawnConverter({
    ...process.env,
    ...targetEnv(paths),
    HOME: homeRoot,
    USERPROFILE: homeRoot,
    SKILL_GRAFT_FIXTURE_SOURCE: packageSource,
    SKILL_GRAFT_P0_SOURCE_RUN: historical.runRoot,
    SKILL_GRAFT_PROTECTED_ROOTS: protectedRoot
  })
  assert.equal(refused.error, undefined, `converter spawn error: ${refused.error?.message || ''}`)
  assert.notEqual(refused.status, 0)
  const output = `${refused.stderr}\n${refused.stdout}`
  assert.match(output, /rootIdentitySha256=[0-9a-f]{64}/i)
  assert.match(output, /beforeFingerprintSha256=[0-9a-f]{64}/i)
  assert.match(output, /afterFingerprintSha256=[0-9a-f]{64}/i)
  assert.equal(output.includes(protectedRoot), false, 'fingerprint refusal must not expose the protected path')
  assert.equal(fs.existsSync(path.join(paths.root, '.skill-graft-p0-fixture.json')), false)
})

test('converter rejects source and target reparse escapes before copying or cloning', {
  timeout: 60000
}, (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-p0-reparse-'))
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
  const homeRoot = path.join(parent, 'fixture-home')
  fs.mkdirSync(homeRoot)
  const packageSource = createPackageSource(parent, homeRoot)
  const historical = createHistoricalV1(parent, homeRoot)

  const outsideSkills = path.join(parent, 'outside-skills')
  fs.renameSync(historical.skills, outsideSkills)
  fs.symlinkSync(outsideSkills, historical.skills, process.platform === 'win32' ? 'junction' : 'dir')
  const sourceEscapePaths = targetPaths(parent, 'p0-source-escape-20260821')
  prepareTarget(sourceEscapePaths, packageSource, [historical.runRoot, outsideSkills])
  const sourceEscape = spawnConverter({
    ...process.env,
    ...targetEnv(sourceEscapePaths),
    SKILL_GRAFT_FIXTURE_SOURCE: packageSource,
    SKILL_GRAFT_P0_SOURCE_RUN: historical.runRoot,
    SKILL_GRAFT_PROTECTED_ROOTS: outsideSkills
  })
  assert.notEqual(sourceEscape.status, 0)
  assert.match(`${sourceEscape.stderr}\n${sourceEscape.stdout}`, /historical hub-data\/skills.*plain directory|reparse point/i)
  assert.deepEqual(fs.readdirSync(sourceEscapePaths.hubData), [])
  assert.deepEqual(fs.readdirSync(sourceEscapePaths.probe), [])
  fs.unlinkSync(historical.skills)
  fs.renameSync(outsideSkills, historical.skills)

  const targetEscapePaths = targetPaths(parent, 'p0-target-escape-20260821')
  const context = prepareTarget(targetEscapePaths, packageSource, [historical.runRoot])
  const outsideTarget = path.join(parent, 'outside-target')
  fs.mkdirSync(outsideTarget)
  const sentinel = path.join(outsideTarget, 'sentinel.txt')
  fs.writeFileSync(sentinel, 'must survive\n')
  fs.rmSync(context.probeRoot, { recursive: true, force: true })
  fs.symlinkSync(outsideTarget, context.probeRoot, process.platform === 'win32' ? 'junction' : 'dir')
  const targetEscape = spawnConverter({
    ...process.env,
    ...targetEnv(targetEscapePaths),
    HOME: path.join(parent, 'spawn-home'),
    USERPROFILE: path.join(parent, 'spawn-home'),
    SKILL_GRAFT_FIXTURE_SOURCE: packageSource,
    SKILL_GRAFT_P0_SOURCE_RUN: historical.runRoot,
    SKILL_GRAFT_PROTECTED_ROOTS: outsideTarget
  })
  assert.notEqual(targetEscape.status, 0)
  assert.match(`${targetEscape.stderr}\n${targetEscape.stdout}`, /probe.*run root|protected|plain directory|reparse point/i)
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'must survive\n')
  assert.deepEqual(fs.readdirSync(context.hubDataRoot), [])
  fs.unlinkSync(context.probeRoot)
})
