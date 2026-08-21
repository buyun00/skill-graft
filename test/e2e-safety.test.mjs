import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  ProcessTracker,
  assertSourceOutsideProtectedRoots,
  cleanupRunLayout,
  createIsolatedGitEnvironment,
  createRunLayout,
  getAvailableLoopbackPort,
  removeOwnedPath,
  validateRealE2eEnvironment
} from './support/real-e2e.mjs'

const prepareP0FixtureScript = fileURLToPath(new URL('./support/prepare-p0-fixture.mjs', import.meta.url))
const skillsMaterializationPolicy = 'git-blob-exact-or-strict-crlf-v1'

function makePaths(prefix = 'p0-contract-20260821-000000') {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-e2e-contract-'))
  const root = path.join(parent, prefix)
  return {
    parent,
    runId: prefix,
    root,
    probe: path.join(root, 'probe'),
    hubData: path.join(root, 'hub-data'),
    cli: path.join(root, 'app', 'node_modules', 'ozdqp-skill-hub', 'dist', 'control', 'cli.js')
  }
}

function envFor(paths) {
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

function safeOptions(paths, protectedRoots = []) {
  return {
    homeDir: path.join(paths.parent, 'unrelated-home'),
    workspaceRoot: path.join(paths.parent, 'unrelated-workspace'),
    protectedRoots
  }
}

function runGit(cwd, args, homeRoot) {
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
    env: createIsolatedGitEnvironment(process.env, homeRoot),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024
  })
  assert.equal(result.error, undefined, `git spawn failed: ${result.error?.message || ''}`)
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  return String(result.stdout || '').trim()
}

function treeFingerprint(root) {
  const hash = createHash('sha256')
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name)
      const relative = path.relative(root, absolute).replaceAll('\\', '/')
      hash.update(`${entry.isDirectory() ? 'd' : entry.isSymbolicLink() ? 'l' : 'f'}:${relative}\0`, 'utf8')
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(absolute)
      else if (entry.isSymbolicLink()) hash.update(fs.readlinkSync(absolute), 'utf8')
      else hash.update(fs.readFileSync(absolute))
    }
  }
  visit(root)
  return hash.digest('hex')
}

function plainTreeDigests(root) {
  const hash = createHash('sha256')
  const contentEntries = []
  const visit = (target, relative = '') => {
    const stat = fs.lstatSync(target)
    const portable = relative.replaceAll('\\', '/') || '.'
    if (stat.isDirectory()) {
      hash.update(`d\0${portable}\0${stat.mode}\0`, 'utf8')
      for (const child of fs.readdirSync(target, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
        visit(path.join(target, child.name), path.join(relative, child.name))
      }
      return
    }
    assert.equal(stat.isFile(), true, `${target} must be a regular file`)
    const contents = fs.readFileSync(target)
    const sha256 = createHash('sha256').update(contents).digest('hex')
    contentEntries.push({ path: portable, sha256 })
    hash.update(`f\0${portable}\0${stat.mode}:${stat.size}\0`, 'utf8')
    hash.update(sha256, 'utf8')
    hash.update('\0', 'utf8')
  }
  visit(root)
  contentEntries.sort((left, right) => Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8')))
  return {
    sha256: hash.digest('hex'),
    contentSha256: createHash('sha256')
      .update('skill-graft:skills-content-manifest:v1\0', 'utf8')
      .update(JSON.stringify(contentEntries), 'utf8')
      .digest('hex')
  }
}

function compareManifestEntries(left, right) {
  const byPath = Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8'))
  return byPath || String(left.type || '').localeCompare(String(right.type || ''), 'en')
}

function sha256Manifest(prefix, entries) {
  return createHash('sha256')
    .update(prefix, 'utf8')
    .update(JSON.stringify(entries), 'utf8')
    .digest('hex')
}

function createHistoricalP0Source(parent, homeRoot) {
  const runId = `p0-source-${path.basename(parent).slice(-8)}`
  const runRoot = path.join(parent, runId)
  const probe = path.join(runRoot, 'probe')
  const skills = path.join(runRoot, 'hub-data', 'skills')
  fs.mkdirSync(probe, { recursive: true })
  fs.mkdirSync(skills, { recursive: true })
  fs.mkdirSync(path.join(probe, 'baloot_client'), { recursive: true })
  fs.writeFileSync(path.join(probe, 'AGENTS.md'), '# isolated probe\n')
  fs.writeFileSync(path.join(probe, 'baloot_client', 'fixture.txt'), 'fixture\n')
  runGit(probe, ['init', '--initial-branch=main'], homeRoot)
  runGit(probe, ['config', 'user.name', 'P0 Source Fixture'], homeRoot)
  runGit(probe, ['config', 'user.email', 'p0-source@invalid.local'], homeRoot)
  runGit(probe, ['add', '--', 'AGENTS.md', 'baloot_client/fixture.txt'], homeRoot)
  runGit(probe, ['commit', '-m', 'isolated source fixture'], homeRoot)
  const probeCommit = runGit(probe, ['rev-parse', 'HEAD'], homeRoot)
  runGit(probe, ['checkout', '--detach', probeCommit], homeRoot)
  const physicalRecords = ['ozdqp-development', 'ozdqp-ui-development', 'ozdqp-git-workflow']
    .map((name) => {
      const blob = Buffer.from(`# ${name}\n`, 'utf8')
      const physical = Buffer.from(`# ${name}\r\n`, 'utf8')
      return {
        path: `${name}/SKILL.md`,
        mode: '100644',
        kind: 'strict-crlf',
        blob,
        physical
      }
    })
    .sort(compareManifestEntries)
  for (const record of physicalRecords) {
    const skill = path.join(skills, path.dirname(record.path))
    fs.mkdirSync(skill, { recursive: true })
    fs.writeFileSync(path.join(skills, record.path), record.physical)
  }
  fs.mkdirSync(path.join(skills, 'adopted'))
  fs.mkdirSync(path.join(skills, 'inbox'))
  const hubData = path.dirname(skills)
  const attributes = [
    '# Skill Graft generated skills worktree policy v1',
    '/skills/** -text -filter -ident -working-tree-encoding',
    ...physicalRecords.map((record) => `/skills/${record.path} text eol=crlf -filter -ident -working-tree-encoding`),
    ''
  ].join('\n')
  fs.writeFileSync(path.join(hubData, '.gitattributes'), attributes, 'utf8')
  runGit(hubData, ['init', '--initial-branch=main'], homeRoot)
  runGit(hubData, ['config', 'user.name', 'P0 Source Hub Fixture'], homeRoot)
  runGit(hubData, ['config', 'user.email', 'p0-source-hub@invalid.local'], homeRoot)
  runGit(hubData, ['config', 'core.autocrlf', 'false'], homeRoot)
  runGit(hubData, ['config', 'core.safecrlf', 'true'], homeRoot)
  runGit(hubData, ['add', '--', '.gitattributes', 'skills'], homeRoot)
  runGit(hubData, ['commit', '-m', 'isolated source hub fixture'], homeRoot)
  const hubCommit = runGit(hubData, ['rev-parse', 'HEAD'], homeRoot)
  const targetSkillsTree = runGit(hubData, ['rev-parse', 'HEAD:skills'], homeRoot)
  const physicalSkills = plainTreeDigests(skills)
  const gitEntries = physicalRecords.flatMap((record) => [
    { path: path.posix.dirname(record.path), type: 'directory', mode: '040000' },
    {
      path: record.path,
      type: 'file',
      mode: record.mode,
      objectId: runGit(hubData, ['rev-parse', `HEAD:skills/${record.path}`], homeRoot),
      sha256: createHash('sha256').update(record.blob).digest('hex'),
      size: String(record.blob.length)
    }
  ]).sort(compareManifestEntries)
  const projectionEntries = physicalRecords.map((record) => ({
    path: record.path,
    mode: record.mode,
    kind: record.kind,
    blobObjectId: runGit(hubData, ['rev-parse', `HEAD:skills/${record.path}`], homeRoot),
    blobSha256: createHash('sha256').update(record.blob).digest('hex'),
    physicalSha256: createHash('sha256').update(record.physical).digest('hex'),
    blobSize: String(record.blob.length),
    physicalSize: String(record.physical.length)
  })).sort(compareManifestEntries)
  const materialization = {
    version: 1,
    policy: skillsMaterializationPolicy,
    gitManifestSha256: sha256Manifest('skill-graft:skills-git-manifest:v1\0', gitEntries),
    projectionSha256: sha256Manifest('skill-graft:skills-worktree-projection:v1\0', projectionEntries),
    projectionEntries: projectionEntries.length,
    exactEntries: 0,
    crlfEntries: projectionEntries.length,
    attributesSha256: createHash('sha256').update(attributes, 'utf8').digest('hex'),
    targetSkillsTree,
    physicalSkillsSha256: physicalSkills.sha256,
    physicalSkillsContentSha256: physicalSkills.contentSha256
  }
  const materializationLineage = {
    skillsMaterializationPolicy: materialization.policy,
    skillsGitManifestSha256: materialization.gitManifestSha256,
    skillsProjectionSha256: materialization.projectionSha256,
    skillsProjectionEntries: materialization.projectionEntries,
    skillsExactEntries: materialization.exactEntries,
    skillsCrlfEntries: materialization.crlfEntries,
    skillsAttributesSha256: materialization.attributesSha256,
    targetSkillsTree: materialization.targetSkillsTree
  }
  fs.writeFileSync(path.join(runRoot, '.skill-graft-e2e-run.json'), `${JSON.stringify({
    version: 1,
    runId,
    runRoot,
    createdAt: '2026-08-21T00:00:00.000Z'
  }, null, 2)}\n`)
  fs.writeFileSync(path.join(runRoot, '.skill-graft-p0-fixture.json'), `${JSON.stringify({
    version: 2,
    runId,
    hubCommit,
    probeCommit,
    probeCloneMode: 'independent-no-local-no-hardlinks-no-checkout',
    probeAlternatesPresent: false,
    remoteRemoved: true,
    runtimeStateInitialized: true,
    skillsContentSha256: physicalSkills.contentSha256,
    skillsMaterialization: materialization,
    convertedFromFixtureVersion: 2,
    convertedFrom: {
      fixtureVersion: 2,
      declaredHubCommit: hubCommit,
      actualHubCommit: hubCommit,
      skillsTree: targetSkillsTree,
      physicalSkillsSha256: physicalSkills.sha256,
      physicalSkillsContentSha256: physicalSkills.contentSha256,
      probeProjectionKind: 'p0-v2-clean',
      probeProjectionSha256: createHash('sha256').update('skill-graft:p0-v2-clean-projection:v1\0', 'utf8').digest('hex'),
      probeProjectionEntries: 0,
      ...materializationLineage
    }
  }, null, 2)}\n`)
  return {
    attributes,
    hubCommit,
    hubData,
    materialization,
    physicalSkills,
    probe,
    probeCommit,
    runId,
    runRoot,
    skills,
    targetSkillsTree
  }
}

function createPackageFixture(parent) {
  const root = path.join(parent, 'package-source')
  fs.mkdirSync(path.join(root, 'overlay'), { recursive: true })
  fs.writeFileSync(path.join(root, 'AGENTS.override.md'), '# isolated package fixture\n')
  return root
}

function createP0ProvenanceCase(label) {
  const paths = makePaths(`p0-${label}-20260821-000000`)
  const sourceHome = path.join(paths.parent, 'source-home')
  const sourceContainer = path.join(paths.parent, `historical-${label}`)
  fs.mkdirSync(sourceHome)
  fs.mkdirSync(sourceContainer)
  const historical = createHistoricalP0Source(sourceContainer, sourceHome)
  const packageSource = createPackageFixture(paths.parent)
  const context = validateRealE2eEnvironment(envFor(paths), {
    ...safeOptions(paths),
    workspaceRoot: packageSource
  })
  createRunLayout(context)
  const env = {
    ...process.env,
    ...envFor(paths),
    HOME: sourceHome,
    USERPROFILE: sourceHome,
    SKILL_GRAFT_FIXTURE_SOURCE: packageSource,
    SKILL_GRAFT_LIBRARY_SOURCE: historical.skills,
    SKILL_GRAFT_PROBE_SOURCE: historical.probe,
    SKILL_GRAFT_PROBE_COMMIT: historical.probeCommit
  }
  return { context, env, historical, packageSource, paths, sourceHome }
}

function writeFixtureManifest(historical, mutate) {
  const file = path.join(historical.runRoot, '.skill-graft-p0-fixture.json')
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  mutate(manifest)
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
}

function spawnP0Preparation(env) {
  return spawnSync(process.execPath, [prepareP0FixtureScript], {
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60000,
    maxBuffer: 16 * 1024 * 1024
  })
}

function assertP0PreparationRefused(result, context, expected) {
  assert.equal(result.error, undefined, `P0 preparation spawn error: ${result.error?.message || ''}`)
  assert.notEqual(result.status, 0, 'invalid source provenance must be refused')
  assert.match(`${result.stderr}\n${result.stdout}`, expected)
  assert.deepEqual(fs.readdirSync(context.hubDataRoot), [], 'provenance refusal must precede target hub writes')
  assert.deepEqual(fs.readdirSync(context.probeRoot), [], 'provenance refusal must precede target probe writes')
}

test('isolated Git environments discard every inherited GIT_* value and source gates reject overlaps', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-git-env-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const homeRoot = path.join(root, 'isolated-home')
  const hostileXdgRoot = path.join(root, 'hostile-xdg-config')
  const env = createIsolatedGitEnvironment({
    PATH: process.env.PATH,
    XDG_CONFIG_HOME: hostileXdgRoot,
    GIT_DIR: path.join(root, 'victim', '.git'),
    git_work_tree: path.join(root, 'victim'),
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: path.join(root, 'hostile-hooks'),
    gIt_AtTr_NoSyStEm: '0',
    GIT_SSH_COMMAND: 'hostile-command'
  }, homeRoot)
  assert.deepEqual(
    Object.keys(env).filter((name) => /^GIT_/i.test(name)).sort(),
    ['GIT_ATTR_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_OPTIONAL_LOCKS']
  )
  assert.equal(env.HOME, path.resolve(homeRoot))
  assert.equal(env.USERPROFILE, path.resolve(homeRoot))
  assert.equal(env.XDG_CONFIG_HOME, path.join(path.resolve(homeRoot), 'xdg-config'))
  assert.equal(path.isAbsolute(env.XDG_CONFIG_HOME), true)
  assert.notEqual(env.XDG_CONFIG_HOME, hostileXdgRoot)
  assert.equal(env.GIT_ATTR_NOSYSTEM, '1')
  assert.equal('gIt_AtTr_NoSyStEm' in env, false)
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1')
  assert.equal(env.GIT_OPTIONAL_LOCKS, '0')

  const live = path.join(root, 'live')
  const nested = path.join(live, 'nested')
  const sibling = path.join(root, 'isolated-source')
  fs.mkdirSync(nested, { recursive: true })
  fs.mkdirSync(sibling)
  assert.throws(() => assertSourceOutsideProtectedRoots(live, [live], 'probe'), /protected or live source/)
  assert.throws(() => assertSourceOutsideProtectedRoots(nested, [live], 'probe'), /protected or live source/)
  assert.throws(() => assertSourceOutsideProtectedRoots(live, [nested], 'probe'), /protected or live source/)
  assert.equal(assertSourceOutsideProtectedRoots(sibling, [live], 'probe'), fs.realpathSync.native(sibling))
})

test('P0 fixture preflight rejects isolated global attributes files and reparse chains before source status', {
  timeout: 60000
}, (t) => {
  const attributes = createP0ProvenanceCase('isolated-global-attributes')
  t.after(() => fs.rmSync(attributes.paths.parent, { recursive: true, force: true }))
  const attributesSentinel = path.join(attributes.paths.parent, 'isolated-global-filter-executed.txt')
  const attributesCommand = `echo isolated-global-filter-executed > "${attributesSentinel.replaceAll('\\', '/')}"`
  runGit(attributes.historical.hubData, ['config', 'filter.sentinel.clean', attributesCommand], attributes.sourceHome)
  runGit(attributes.historical.hubData, ['config', 'filter.sentinel.required', 'true'], attributes.sourceHome)
  fs.appendFileSync(path.join(attributes.historical.hubData, 'AGENTS.override.md'), 'force source status inspection\n')
  const isolatedGlobalRoot = path.join(attributes.context.homeRoot, 'xdg-config', 'git')
  fs.mkdirSync(isolatedGlobalRoot, { recursive: true })
  const isolatedGlobalAttributes = path.join(isolatedGlobalRoot, 'attributes')
  fs.writeFileSync(isolatedGlobalAttributes, [
    '[attr]binary filter=sentinel',
    'AGENTS.override.md binary',
    ''
  ].join('\n'))

  assertP0PreparationRefused(
    spawnP0Preparation(attributes.env),
    attributes.context,
    /isolated Git global attributes file must not exist before source preflight/i
  )
  assert.equal(fs.existsSync(attributesSentinel), false, 'isolated global attributes filter must not execute')
  assert.equal(fs.existsSync(isolatedGlobalAttributes), true, 'refusal must not remove the hostile attributes file')

  const reparse = createP0ProvenanceCase('isolated-global-attributes-reparse')
  t.after(() => fs.rmSync(reparse.paths.parent, { recursive: true, force: true }))
  const reparseSentinel = path.join(reparse.paths.parent, 'isolated-global-reparse-filter-executed.txt')
  const reparseCommand = `echo isolated-global-reparse-filter-executed > "${reparseSentinel.replaceAll('\\', '/')}"`
  runGit(reparse.historical.hubData, ['config', 'filter.sentinel.clean', reparseCommand], reparse.sourceHome)
  runGit(reparse.historical.hubData, ['config', 'filter.sentinel.required', 'true'], reparse.sourceHome)
  fs.appendFileSync(path.join(reparse.historical.hubData, 'AGENTS.override.md'), 'force source status inspection\n')
  const externalGitRoot = path.join(reparse.paths.parent, 'external-global-git')
  fs.mkdirSync(externalGitRoot)
  fs.writeFileSync(path.join(externalGitRoot, 'attributes'), [
    '[attr]binary filter=sentinel',
    'AGENTS.override.md binary',
    ''
  ].join('\n'))
  const externalBefore = treeFingerprint(externalGitRoot)
  const reparseXdgRoot = path.join(reparse.context.homeRoot, 'xdg-config')
  fs.mkdirSync(reparseXdgRoot)
  fs.symlinkSync(externalGitRoot, path.join(reparseXdgRoot, 'git'), process.platform === 'win32' ? 'junction' : 'dir')

  assertP0PreparationRefused(
    spawnP0Preparation(reparse.env),
    reparse.context,
    /isolated Git global attributes directory must be a plain directory, not a link or reparse point/i
  )
  assert.equal(fs.existsSync(reparseSentinel), false, 'isolated global attributes reparse filter must not execute')
  assert.equal(treeFingerprint(externalGitRoot), externalBefore, 'reparse refusal must not mutate external attributes bytes')
})

test('P0 fixture preparation rejects source alternates and hostile Git injection cannot mutate a victim repo', {
  timeout: 60000
}, (t) => {
  const paths = makePaths('p0-hostile-git-20260821-000000')
  t.after(() => fs.rmSync(paths.parent, { recursive: true, force: true }))
  const sourceHome = path.join(paths.parent, 'source-home')
  fs.mkdirSync(sourceHome)
  const historical = createHistoricalP0Source(paths.parent, sourceHome)
  const packageSource = createPackageFixture(paths.parent)
  const victim = path.join(paths.parent, 'victim-repo')
  fs.mkdirSync(victim)
  fs.writeFileSync(path.join(victim, 'sentinel.txt'), 'victim-must-not-change\n')
  runGit(victim, ['init', '--initial-branch=main'], sourceHome)
  runGit(victim, ['config', 'user.name', 'Victim Fixture'], sourceHome)
  runGit(victim, ['config', 'user.email', 'victim@invalid.local'], sourceHome)
  runGit(victim, ['add', '--', 'sentinel.txt'], sourceHome)
  runGit(victim, ['commit', '-m', 'victim baseline'], sourceHome)

  const context = validateRealE2eEnvironment(envFor(paths), {
    ...safeOptions(paths, [victim]),
    workspaceRoot: packageSource
  })
  createRunLayout(context)
  const victimBefore = treeFingerprint(victim)
  const hostileConfig = path.join(paths.parent, 'hostile.gitconfig')
  fs.writeFileSync(hostileConfig, '[core]\n\thooksPath = hostile-hooks\n')
  const hostileEnv = {
    ...process.env,
    ...envFor(paths),
    HOME: sourceHome,
    USERPROFILE: sourceHome,
    SKILL_GRAFT_FIXTURE_SOURCE: packageSource,
    SKILL_GRAFT_LIBRARY_SOURCE: historical.skills,
    SKILL_GRAFT_PROBE_SOURCE: historical.probe,
    SKILL_GRAFT_PROBE_COMMIT: historical.probeCommit,
    SKILL_GRAFT_PROTECTED_ROOTS: victim,
    GIT_DIR: path.join(victim, '.git'),
    GIT_WORK_TREE: victim,
    GIT_INDEX_FILE: path.join(victim, '.git', 'index'),
    GIT_COMMON_DIR: path.join(victim, '.git'),
    GIT_OBJECT_DIRECTORY: path.join(victim, '.git', 'objects'),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(victim, '.git', 'objects'),
    GIT_CONFIG_GLOBAL: hostileConfig,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: path.join(paths.parent, 'hostile-hooks'),
    GIT_OPTIONAL_LOCKS: '1',
    GIT_SSH_COMMAND: 'hostile-command'
  }
  const spawnPrepare = () => spawnSync(process.execPath, [prepareP0FixtureScript], {
    env: hostileEnv,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60000,
    maxBuffer: 16 * 1024 * 1024
  })

  const alternateObjects = path.join(victim, '.git', 'objects')
  const hubAlternates = path.join(historical.hubData, '.git', 'objects', 'info', 'alternates')
  fs.mkdirSync(path.dirname(hubAlternates), { recursive: true })
  fs.writeFileSync(hubAlternates, `${alternateObjects}\n`)
  const refusedHub = spawnPrepare()
  assert.equal(refusedHub.error, undefined, `Hub alternate refusal spawn error: ${refusedHub.error?.message || ''}`)
  assert.notEqual(refusedHub.status, 0, 'P0 preparation must reject a source Hub with object alternates')
  assert.match(`${refusedHub.stderr}\n${refusedHub.stdout}`, /source hub-data must not retain an object alternate/)
  assert.deepEqual(fs.readdirSync(context.hubDataRoot), [], 'alternate refusal must precede hub fixture writes')
  assert.deepEqual(fs.readdirSync(context.probeRoot), [], 'alternate refusal must precede probe clone writes')
  assert.equal(treeFingerprint(victim), victimBefore, 'alternate refusal must not mutate the injected victim repo')
  fs.rmSync(hubAlternates)

  const probeAlternates = path.join(historical.probe, '.git', 'objects', 'info', 'alternates')
  fs.mkdirSync(path.dirname(probeAlternates), { recursive: true })
  fs.writeFileSync(probeAlternates, `${alternateObjects}\n`)
  const refusedProbe = spawnPrepare()
  assert.equal(refusedProbe.error, undefined, `probe alternate refusal spawn error: ${refusedProbe.error?.message || ''}`)
  assert.notEqual(refusedProbe.status, 0, 'P0 preparation must reject a source probe with object alternates')
  assert.match(`${refusedProbe.stderr}\n${refusedProbe.stdout}`, /SKILL_GRAFT_PROBE_SOURCE must not retain an object alternate/)
  assert.deepEqual(fs.readdirSync(context.hubDataRoot), [], 'probe alternate refusal must precede hub fixture writes')
  assert.deepEqual(fs.readdirSync(context.probeRoot), [], 'probe alternate refusal must precede probe clone writes')
  assert.equal(treeFingerprint(victim), victimBefore, 'probe alternate refusal must not mutate the injected victim repo')

  fs.rmSync(probeAlternates)
  const prepared = spawnPrepare()
  assert.equal(prepared.error, undefined, `P0 preparation spawn error: ${prepared.error?.message || ''}`)
  assert.equal(prepared.status, 0, `P0 preparation failed: ${prepared.stderr || prepared.stdout}`)
  assert.deepEqual(fs.readdirSync(context.homeRoot), [], 'P0 preparation must leave the target home empty')
  const manifest = JSON.parse(fs.readFileSync(path.join(context.runRoot, '.skill-graft-p0-fixture.json'), 'utf8'))
  assert.equal(manifest.version, 2)
  assert.equal(manifest.probeCloneMode, 'independent-no-local-no-hardlinks-no-checkout')
  assert.equal(manifest.probeAlternatesPresent, false)
  assert.equal(manifest.sourceProvenance.schemaVersion, 1)
  assert.match(manifest.sourceProvenance.runIdentitySha256, /^[0-9a-f]{64}$/i)
  assert.equal(manifest.sourceProvenance.fixtureVersion, 2)
  assert.equal(manifest.sourceProvenance.hubCommit, historical.hubCommit)
  assert.equal(manifest.sourceProvenance.probeCommit, historical.probeCommit)
  assert.equal(manifest.sourceProvenance.probeCloneMode, 'independent-no-local-no-hardlinks-no-checkout')
  assert.equal(manifest.sourceProvenance.probeAlternatesPresent, false)
  assert.equal(manifest.sourceProvenance.remoteRemoved, true)
  assert.equal(manifest.sourceProvenance.declaredHubCommit, historical.hubCommit)
  assert.equal(manifest.sourceProvenance.actualHubCommit, historical.hubCommit)
  assert.match(manifest.sourceProvenance.skillsTree, /^[0-9a-f]{40}$/i)
  assert.match(manifest.sourceProvenance.physicalSkillsSha256, /^[0-9a-f]{64}$/i)
  assert.match(manifest.sourceProvenance.physicalSkillsContentSha256, /^[0-9a-f]{64}$/i)
  assert.equal(manifest.sourceProvenance.probeProjectionKind, 'p0-v2-clean')
  assert.match(manifest.sourceProvenance.probeProjectionSha256, /^[0-9a-f]{64}$/i)
  assert.equal(manifest.sourceProvenance.probeProjectionEntries, 0)
  assert.equal(manifest.sourceProvenance.skillsMaterializationPolicy, skillsMaterializationPolicy)
  assert.equal(manifest.sourceProvenance.skillsGitManifestSha256, historical.materialization.gitManifestSha256)
  assert.equal(manifest.sourceProvenance.skillsProjectionSha256, historical.materialization.projectionSha256)
  assert.equal(manifest.sourceProvenance.skillsProjectionEntries, historical.materialization.projectionEntries)
  assert.equal(manifest.sourceProvenance.skillsExactEntries, historical.materialization.exactEntries)
  assert.equal(manifest.sourceProvenance.skillsCrlfEntries, historical.materialization.crlfEntries)
  assert.equal(manifest.sourceProvenance.skillsAttributesSha256, historical.materialization.attributesSha256)
  assert.equal(manifest.sourceProvenance.targetSkillsTree, historical.targetSkillsTree)
  assert.equal(JSON.stringify(manifest).includes(historical.runRoot), false, 'target manifest must not expose the private source path')
  assert.deepEqual(
    fs.readFileSync(path.join(context.hubDataRoot, '.gitattributes')),
    fs.readFileSync(path.join(historical.hubData, '.gitattributes')),
    'target must preserve the verified source .gitattributes bytes'
  )
  assert.equal(runGit(context.hubDataRoot, ['rev-parse', 'HEAD:skills'], context.homeRoot), historical.targetSkillsTree)
  assert.deepEqual(plainTreeDigests(path.join(context.hubDataRoot, 'skills')), historical.physicalSkills)
  assert.equal(runGit(context.hubDataRoot, ['config', '--local', '--get', 'core.autocrlf'], context.homeRoot), 'false')
  assert.equal(runGit(context.hubDataRoot, ['config', '--local', '--get', 'core.safecrlf'], context.homeRoot), 'true')
  assert.equal(runGit(context.hubDataRoot, ['status', '--porcelain=v1', '--untracked-files=all'], context.homeRoot), '')
  assert.equal(fs.existsSync(path.join(context.probeRoot, '.git', 'objects', 'info', 'alternates')), false)
  assert.equal(runGit(context.probeRoot, ['remote'], context.homeRoot), '')
  assert.equal(runGit(context.probeRoot, ['rev-parse', 'HEAD'], context.homeRoot), historical.probeCommit)
  assert.equal(treeFingerprint(victim), victimBefore, 'hostile Git injection must not mutate any victim repo bytes')
})

test('P0 fixture provenance rejects mixed v2 source runs and v1 source manifests before target writes', {
  timeout: 60000
}, (t) => {
  const fixture = createP0ProvenanceCase('mixed-source')
  t.after(() => fs.rmSync(fixture.paths.parent, { recursive: true, force: true }))
  const secondContainer = path.join(fixture.paths.parent, 'historical-mixed-second')
  fs.mkdirSync(secondContainer)
  const second = createHistoricalP0Source(secondContainer, fixture.sourceHome)
  const mixed = spawnP0Preparation({
    ...fixture.env,
    SKILL_GRAFT_PROBE_SOURCE: second.probe,
    SKILL_GRAFT_PROBE_COMMIT: second.probeCommit
  })
  assertP0PreparationRefused(mixed, fixture.context, /same marker-owned P0 fixture v2 run/i)

  writeFixtureManifest(fixture.historical, (manifest) => {
    manifest.version = 1
    manifest.probeCloneMode = 'shared-no-checkout'
    delete manifest.probeAlternatesPresent
  })
  const legacy = spawnP0Preparation(fixture.env)
  assertP0PreparationRefused(legacy, fixture.context, /independent P0 fixture v2 run/i)
})

test('P0 fixture provenance rejects dirty source hub and dirty source probe states', {
  timeout: 60000
}, (t) => {
  const dirtyHub = createP0ProvenanceCase('dirty-hub')
  t.after(() => fs.rmSync(dirtyHub.paths.parent, { recursive: true, force: true }))
  const hubSkill = path.join(dirtyHub.historical.skills, 'ozdqp-development', 'SKILL.md')
  fs.appendFileSync(hubSkill, 'staged source mutation\r\n')
  runGit(dirtyHub.historical.hubData, ['add', '--', 'skills/ozdqp-development/SKILL.md'], dirtyHub.sourceHome)
  fs.appendFileSync(hubSkill, 'unstaged source mutation\r\n')
  assertP0PreparationRefused(
    spawnP0Preparation(dirtyHub.env),
    dirtyHub.context,
    /source Git skills index does not exactly match HEAD|skillsMaterialization provenance is invalid|source hub-data must be clean/i
  )

  const dirtyProbe = createP0ProvenanceCase('dirty-probe')
  t.after(() => fs.rmSync(dirtyProbe.paths.parent, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dirtyProbe.historical.probe, 'untracked-provenance.txt'), 'must be refused\n')
  assertP0PreparationRefused(
    spawnP0Preparation(dirtyProbe.env),
    dirtyProbe.context,
    /source probe must be clean/i
  )
})

test('P0 fixture provenance rejects a nested source skills reparse escape without touching target or external bytes', {
  timeout: 60000
}, (t) => {
  const fixture = createP0ProvenanceCase('skills-reparse')
  t.after(() => fs.rmSync(fixture.paths.parent, { recursive: true, force: true }))
  const outside = path.join(fixture.paths.parent, 'external-protected-skills')
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'external bytes must not change\n')
  const externalBefore = treeFingerprint(outside)
  const nestedParent = path.join(fixture.historical.skills, 'ozdqp-development', 'references')
  fs.mkdirSync(nestedParent)
  const escaped = path.join(nestedParent, 'escaped')
  fs.symlinkSync(outside, escaped, process.platform === 'win32' ? 'junction' : 'dir')

  const refused = spawnP0Preparation({
    ...fixture.env,
    SKILL_GRAFT_PROTECTED_ROOTS: outside
  })
  assertP0PreparationRefused(refused, fixture.context, /source hub-data\/skills.*link or reparse point/i)
  assert.equal(treeFingerprint(outside), externalBefore, 'reparse refusal must not mutate external source bytes')
  assert.equal(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8'), 'external bytes must not change\n')
  fs.unlinkSync(escaped)
})

test('P0 fixture provenance rejects mismatched source HEAD declarations and retained probe remotes', {
  timeout: 60000
}, (t) => {
  const hubMismatch = createP0ProvenanceCase('hub-head')
  t.after(() => fs.rmSync(hubMismatch.paths.parent, { recursive: true, force: true }))
  writeFixtureManifest(hubMismatch.historical, (manifest) => {
    manifest.hubCommit = '0'.repeat(40)
  })
  assertP0PreparationRefused(
    spawnP0Preparation(hubMismatch.env),
    hubMismatch.context,
    /source hub-data HEAD does not match/i
  )

  const probeMismatch = createP0ProvenanceCase('probe-head')
  t.after(() => fs.rmSync(probeMismatch.paths.parent, { recursive: true, force: true }))
  const missingCommit = '1'.repeat(40)
  writeFixtureManifest(probeMismatch.historical, (manifest) => {
    manifest.probeCommit = missingCommit
  })
  assertP0PreparationRefused(
    spawnP0Preparation({ ...probeMismatch.env, SKILL_GRAFT_PROBE_COMMIT: missingCommit }),
    probeMismatch.context,
    /source probe HEAD does not match/i
  )

  const retainedRemote = createP0ProvenanceCase('probe-remote')
  t.after(() => fs.rmSync(retainedRemote.paths.parent, { recursive: true, force: true }))
  runGit(retainedRemote.historical.probe, ['remote', 'add', 'origin', retainedRemote.historical.runRoot], retainedRemote.sourceHome)
  assertP0PreparationRefused(
    spawnP0Preparation(retainedRemote.env),
    retainedRemote.context,
    /source probe must not retain a remote/i
  )
})

test('P0 fixture provenance rejects Hub and probe object database reparses before object lookup', {
  timeout: 60000
}, (t) => {
  const hub = createP0ProvenanceCase('hub-objects-junction')
  t.after(() => fs.rmSync(hub.paths.parent, { recursive: true, force: true }))
  const hubOutside = path.join(hub.paths.parent, 'external-hub-objects')
  fs.mkdirSync(hubOutside)
  const hubSentinel = path.join(hubOutside, 'sentinel.txt')
  fs.writeFileSync(hubSentinel, 'hub-object-sentinel\n')
  const hubObjects = path.join(hub.historical.hubData, '.git', 'objects')
  fs.rmSync(hubObjects, { recursive: true, force: true })
  fs.symlinkSync(hubOutside, hubObjects, process.platform === 'win32' ? 'junction' : 'dir')
  assertP0PreparationRefused(
    spawnP0Preparation(hub.env),
    hub.context,
    /source hub-data object database.*plain directory|ancestor must be a plain directory/i
  )
  assert.equal(fs.readFileSync(hubSentinel, 'utf8'), 'hub-object-sentinel\n')

  const probe = createP0ProvenanceCase('probe-info-junction')
  t.after(() => fs.rmSync(probe.paths.parent, { recursive: true, force: true }))
  const probeOutside = path.join(probe.paths.parent, 'external-probe-info')
  fs.mkdirSync(probeOutside)
  const probeSentinel = path.join(probeOutside, 'sentinel.txt')
  fs.writeFileSync(probeSentinel, 'probe-info-sentinel\n')
  const probeInfo = path.join(probe.historical.probe, '.git', 'objects', 'info')
  fs.rmSync(probeInfo, { recursive: true, force: true })
  fs.symlinkSync(probeOutside, probeInfo, process.platform === 'win32' ? 'junction' : 'dir')
  assertP0PreparationRefused(
    spawnP0Preparation(probe.env),
    probe.context,
    /source probe object database.*plain directory|ancestor must be a plain directory/i
  )
  assert.equal(fs.readFileSync(probeSentinel, 'utf8'), 'probe-info-sentinel\n')
})

test('P0 fixture provenance rejects effective config.worktree filters in Hub and probe before status', {
  timeout: 60000
}, (t) => {
  const hub = createP0ProvenanceCase('hub-config-worktree')
  t.after(() => fs.rmSync(hub.paths.parent, { recursive: true, force: true }))
  const hubSentinel = path.join(hub.paths.parent, 'hub-config-worktree-filter.txt')
  const hubAttributes = path.join(hub.paths.parent, 'hub-config-worktree-attributes')
  fs.writeFileSync(hubAttributes, '* filter=sentinel\n')
  runGit(hub.historical.hubData, ['config', 'extensions.worktreeConfig', 'true'], hub.sourceHome)
  runGit(hub.historical.hubData, [
    'config', '--worktree', 'filter.sentinel.clean', `echo hub-config-worktree > "${hubSentinel.replaceAll('\\', '/')}"`
  ], hub.sourceHome)
  runGit(hub.historical.hubData, ['config', '--worktree', 'filter.sentinel.required', 'true'], hub.sourceHome)
  runGit(hub.historical.hubData, [
    'config', '--worktree', 'core.attributesFile', hubAttributes.replaceAll('\\', '/')
  ], hub.sourceHome)
  assertP0PreparationRefused(spawnP0Preparation(hub.env), hub.context, /source hub-data contains an external Git conversion policy/i)
  assert.equal(fs.existsSync(hubSentinel), false, 'Hub config.worktree filter must not execute')

  const probe = createP0ProvenanceCase('probe-config-worktree')
  t.after(() => fs.rmSync(probe.paths.parent, { recursive: true, force: true }))
  const probeSentinel = path.join(probe.paths.parent, 'probe-config-worktree-filter.txt')
  const probeAttributes = path.join(probe.paths.parent, 'probe-config-worktree-attributes')
  fs.writeFileSync(probeAttributes, '* filter=sentinel\n')
  runGit(probe.historical.probe, ['config', 'extensions.worktreeConfig', 'true'], probe.sourceHome)
  runGit(probe.historical.probe, [
    'config', '--worktree', 'filter.sentinel.clean', `echo probe-config-worktree > "${probeSentinel.replaceAll('\\', '/')}"`
  ], probe.sourceHome)
  runGit(probe.historical.probe, ['config', '--worktree', 'filter.sentinel.required', 'true'], probe.sourceHome)
  runGit(probe.historical.probe, [
    'config', '--worktree', 'core.attributesFile', probeAttributes.replaceAll('\\', '/')
  ], probe.sourceHome)
  assertP0PreparationRefused(spawnP0Preparation(probe.env), probe.context, /source probe contains an external Git conversion policy/i)
  assert.equal(fs.existsSync(probeSentinel), false, 'probe config.worktree filter must not execute')
})

test('P0 fixture provenance rejects probe attributes conversion policies before probe status', {
  timeout: 60000
}, (t) => {
  const tracked = createP0ProvenanceCase('probe-tracked-attributes')
  t.after(() => fs.rmSync(tracked.paths.parent, { recursive: true, force: true }))
  const trackedSentinel = path.join(tracked.paths.parent, 'probe-tracked-filter.txt')
  fs.writeFileSync(path.join(tracked.historical.probe, '.gitattributes'), '* filter=sentinel\n')
  runGit(tracked.historical.probe, ['add', '--', '.gitattributes'], tracked.sourceHome)
  runGit(tracked.historical.probe, ['commit', '-m', 'bind malicious probe attributes'], tracked.sourceHome)
  const trackedCommit = runGit(tracked.historical.probe, ['rev-parse', 'HEAD'], tracked.sourceHome)
  runGit(tracked.historical.probe, [
    'config', 'filter.sentinel.clean', `echo probe-tracked-filter > "${trackedSentinel.replaceAll('\\', '/')}"`
  ], tracked.sourceHome)
  runGit(tracked.historical.probe, ['config', 'filter.sentinel.required', 'true'], tracked.sourceHome)
  writeFixtureManifest(tracked.historical, (manifest) => { manifest.probeCommit = trackedCommit })
  assertP0PreparationRefused(
    spawnP0Preparation({ ...tracked.env, SKILL_GRAFT_PROBE_COMMIT: trackedCommit }),
    tracked.context,
    /source probe \.gitattributes contains an unsafe conversion attribute/i
  )
  assert.equal(fs.existsSync(trackedSentinel), false, 'tracked probe attributes filter must not execute')

  const info = createP0ProvenanceCase('probe-info-attributes')
  t.after(() => fs.rmSync(info.paths.parent, { recursive: true, force: true }))
  const infoSentinel = path.join(info.paths.parent, 'probe-info-filter.txt')
  fs.writeFileSync(path.join(info.historical.probe, '.git', 'info', 'attributes'), '* filter=sentinel\n')
  runGit(info.historical.probe, [
    'config', 'filter.sentinel.clean', `echo probe-info-filter > "${infoSentinel.replaceAll('\\', '/')}"`
  ], info.sourceHome)
  runGit(info.historical.probe, ['config', 'filter.sentinel.required', 'true'], info.sourceHome)
  assertP0PreparationRefused(spawnP0Preparation(info.env), info.context, /source probe must not use \.git\/info\/attributes/i)
  assert.equal(fs.existsSync(infoSentinel), false, 'probe info attributes filter must not execute')
})

test('P0 fixture provenance rejects materialization attributes, lineage, tree, and physical digest tampering', {
  timeout: 120000
}, (t) => {
  const attributes = createP0ProvenanceCase('materialization-attrs')
  t.after(() => fs.rmSync(attributes.paths.parent, { recursive: true, force: true }))
  writeFixtureManifest(attributes.historical, (manifest) => {
    manifest.skillsMaterialization.attributesSha256 = 'a'.repeat(64)
  })
  assertP0PreparationRefused(
    spawnP0Preparation(attributes.env),
    attributes.context,
    /skillsMaterialization provenance/i
  )

  const lineage = createP0ProvenanceCase('materialization-lineage')
  t.after(() => fs.rmSync(lineage.paths.parent, { recursive: true, force: true }))
  writeFixtureManifest(lineage.historical, (manifest) => {
    manifest.convertedFrom.skillsGitManifestSha256 = 'b'.repeat(64)
  })
  assertP0PreparationRefused(
    spawnP0Preparation(lineage.env),
    lineage.context,
    /convertedFrom provenance is invalid/i
  )

  const deletedLineage = createP0ProvenanceCase('converted-lineage-deleted')
  t.after(() => fs.rmSync(deletedLineage.paths.parent, { recursive: true, force: true }))
  writeFixtureManifest(deletedLineage.historical, (manifest) => {
    delete manifest.convertedFromFixtureVersion
    delete manifest.convertedFrom
  })
  assertP0PreparationRefused(
    spawnP0Preparation(deletedLineage.env),
    deletedLineage.context,
    /convertedFrom provenance is invalid/i
  )

  const lineageVersion = createP0ProvenanceCase('converted-lineage-version')
  t.after(() => fs.rmSync(lineageVersion.paths.parent, { recursive: true, force: true }))
  writeFixtureManifest(lineageVersion.historical, (manifest) => {
    manifest.convertedFromFixtureVersion = 1
  })
  assertP0PreparationRefused(
    spawnP0Preparation(lineageVersion.env),
    lineageVersion.context,
    /convertedFrom provenance is invalid/i
  )

  const noncanonicalClean = createP0ProvenanceCase('converted-lineage-noncanonical-clean')
  t.after(() => fs.rmSync(noncanonicalClean.paths.parent, { recursive: true, force: true }))
  writeFixtureManifest(noncanonicalClean.historical, (manifest) => {
    manifest.convertedFrom.probeProjectionSha256 = '3'.repeat(64)
  })
  assertP0PreparationRefused(
    spawnP0Preparation(noncanonicalClean.env),
    noncanonicalClean.context,
    /convertedFrom provenance is invalid/i
  )

  const tree = createP0ProvenanceCase('materialization-tree')
  t.after(() => fs.rmSync(tree.paths.parent, { recursive: true, force: true }))
  writeFixtureManifest(tree.historical, (manifest) => {
    manifest.skillsMaterialization.targetSkillsTree = 'c'.repeat(40)
    manifest.convertedFrom.targetSkillsTree = 'c'.repeat(40)
  })
  assertP0PreparationRefused(
    spawnP0Preparation(tree.env),
    tree.context,
    /skillsMaterialization provenance is invalid/i
  )

  const physical = createP0ProvenanceCase('materialization-physical')
  t.after(() => fs.rmSync(physical.paths.parent, { recursive: true, force: true }))
  writeFixtureManifest(physical.historical, (manifest) => {
    manifest.skillsMaterialization.physicalSkillsSha256 = 'd'.repeat(64)
    manifest.convertedFrom.physicalSkillsSha256 = 'd'.repeat(64)
  })
  assertP0PreparationRefused(
    spawnP0Preparation(physical.env),
    physical.context,
    /skillsMaterialization provenance is invalid/i
  )

  const bareLf = createP0ProvenanceCase('materialization-bare-lf')
  t.after(() => fs.rmSync(bareLf.paths.parent, { recursive: true, force: true }))
  fs.appendFileSync(path.join(bareLf.historical.skills, 'ozdqp-development', 'SKILL.md'), 'bare-lf\n')
  assertP0PreparationRefused(
    spawnP0Preparation(bareLf.env),
    bareLf.context,
    /strict-crlf projection rejects a bare LF byte/i
  )

  const content = createP0ProvenanceCase('materialization-content')
  t.after(() => fs.rmSync(content.paths.parent, { recursive: true, force: true }))
  writeFixtureManifest(content.historical, (manifest) => {
    manifest.skillsContentSha256 = 'e'.repeat(64)
  })
  assertP0PreparationRefused(
    spawnP0Preparation(content.env),
    content.context,
    /skillsMaterialization provenance is invalid/i
  )

  const synchronized = createP0ProvenanceCase('materialization-synchronized')
  t.after(() => fs.rmSync(synchronized.paths.parent, { recursive: true, force: true }))
  const synchronizedSentinel = path.join(synchronized.paths.parent, 'synchronized-filter-executed.txt')
  const synchronizedInfoAttributes = path.join(synchronized.historical.hubData, '.git', 'info', 'attributes')
  fs.mkdirSync(path.dirname(synchronizedInfoAttributes), { recursive: true })
  fs.writeFileSync(synchronizedInfoAttributes, 'skills/** filter=sentinel\n')
  runGit(synchronized.historical.hubData, [
    'config', 'filter.sentinel.clean', `echo synchronized-filter-executed > "${synchronizedSentinel.replaceAll('\\', '/')}"`
  ], synchronized.sourceHome)
  runGit(synchronized.historical.hubData, ['config', 'filter.sentinel.required', 'true'], synchronized.sourceHome)
  writeFixtureManifest(synchronized.historical, (manifest) => {
    manifest.skillsMaterialization.gitManifestSha256 = '1'.repeat(64)
    manifest.skillsMaterialization.projectionSha256 = '2'.repeat(64)
    manifest.skillsMaterialization.exactEntries = 1
    manifest.skillsMaterialization.crlfEntries = manifest.skillsMaterialization.projectionEntries - 1
    manifest.convertedFrom.skillsGitManifestSha256 = manifest.skillsMaterialization.gitManifestSha256
    manifest.convertedFrom.skillsProjectionSha256 = manifest.skillsMaterialization.projectionSha256
    manifest.convertedFrom.skillsExactEntries = manifest.skillsMaterialization.exactEntries
    manifest.convertedFrom.skillsCrlfEntries = manifest.skillsMaterialization.crlfEntries
  })
  assertP0PreparationRefused(
    spawnP0Preparation(synchronized.env),
    synchronized.context,
    /skillsMaterialization provenance is invalid/i
  )
  assert.equal(fs.existsSync(synchronizedSentinel), false, 'synchronized provenance tampering must fail before source filter execution')

  const omitted = createP0ProvenanceCase('materialization-schema-omitted')
  t.after(() => fs.rmSync(omitted.paths.parent, { recursive: true, force: true }))
  const omittedSentinel = path.join(omitted.paths.parent, 'omitted-schema-filter-executed.txt')
  const omittedInfoAttributes = path.join(omitted.historical.hubData, '.git', 'info', 'attributes')
  fs.mkdirSync(path.dirname(omittedInfoAttributes), { recursive: true })
  fs.writeFileSync(omittedInfoAttributes, 'skills/** filter=sentinel\n')
  runGit(omitted.historical.hubData, [
    'config', 'filter.sentinel.clean', `echo omitted-schema-filter-executed > "${omittedSentinel.replaceAll('\\', '/')}"`
  ], omitted.sourceHome)
  runGit(omitted.historical.hubData, ['config', 'filter.sentinel.required', 'true'], omitted.sourceHome)
  writeFixtureManifest(omitted.historical, (manifest) => {
    delete manifest.skillsMaterialization.projectionSha256
    delete manifest.convertedFrom.skillsProjectionSha256
  })
  assertP0PreparationRefused(
    spawnP0Preparation(omitted.env),
    omitted.context,
    /skillsMaterialization provenance is invalid/i
  )
  assert.equal(fs.existsSync(omittedSentinel), false, 'omitted materialization schema must fail before source filter execution')
})

test('P0 fixture preparation rejects a bound malicious attributes filter before source status can execute it', {
  timeout: 60000
}, (t) => {
  const fixture = createP0ProvenanceCase('materialization-filter-sentinel')
  t.after(() => fs.rmSync(fixture.paths.parent, { recursive: true, force: true }))
  const sentinel = path.join(fixture.paths.parent, 'source-filter-executed.txt')
  const sentinelCommand = `echo source-filter-executed > "${sentinel.replaceAll('\\', '/')}"`
  runGit(fixture.historical.hubData, ['config', 'filter.sentinel.clean', sentinelCommand], fixture.sourceHome)
  runGit(fixture.historical.hubData, ['config', 'filter.sentinel.required', 'true'], fixture.sourceHome)
  const externalPolicy = spawnP0Preparation(fixture.env)
  assertP0PreparationRefused(externalPolicy, fixture.context, /external Git conversion policy/i)
  assert.equal(fs.existsSync(sentinel), false, 'source filter config must be refused before source status')
  runGit(fixture.historical.hubData, ['config', '--unset-all', 'filter.sentinel.clean'], fixture.sourceHome)
  runGit(fixture.historical.hubData, ['config', '--unset-all', 'filter.sentinel.required'], fixture.sourceHome)

  const attributesFile = path.join(fixture.historical.hubData, '.gitattributes')
  const maliciousAttributes = [
    '# Skill Graft generated skills worktree policy v1',
    '/skills/** filter=sentinel',
    ''
  ].join('\n')
  fs.writeFileSync(attributesFile, maliciousAttributes, 'utf8')
  runGit(fixture.historical.hubData, ['add', '--', '.gitattributes'], fixture.sourceHome)
  runGit(fixture.historical.hubData, ['commit', '-m', 'bind malicious source attributes'], fixture.sourceHome)
  const maliciousHead = runGit(fixture.historical.hubData, ['rev-parse', 'HEAD'], fixture.sourceHome)
  runGit(fixture.historical.hubData, ['config', 'filter.sentinel.clean', sentinelCommand], fixture.sourceHome)
  runGit(fixture.historical.hubData, ['config', 'filter.sentinel.required', 'true'], fixture.sourceHome)
  const attributesSha256 = createHash('sha256').update(maliciousAttributes, 'utf8').digest('hex')
  writeFixtureManifest(fixture.historical, (manifest) => {
    manifest.hubCommit = maliciousHead
    manifest.skillsMaterialization.attributesSha256 = attributesSha256
    manifest.convertedFrom.skillsAttributesSha256 = attributesSha256
  })

  const refused = spawnP0Preparation(fixture.env)
  assertP0PreparationRefused(refused, fixture.context, /independently regenerated skills policy/i)
  assert.equal(fs.existsSync(sentinel), false, 'source filter command must not execute before refusal')

  runGit(fixture.historical.hubData, ['config', '--unset-all', 'filter.sentinel.clean'], fixture.sourceHome)
  runGit(fixture.historical.hubData, ['config', '--unset-all', 'filter.sentinel.required'], fixture.sourceHome)
  const unsafePolicy = spawnP0Preparation(fixture.env)
  assertP0PreparationRefused(unsafePolicy, fixture.context, /independently regenerated skills policy/i)
  assert.equal(fs.existsSync(sentinel), false, 'malicious attributes must be refused without executing a source filter')
})

test('real E2E requires an explicit enable flag and run-id-owned paths', (t) => {
  const paths = makePaths()
  t.after(() => fs.rmSync(paths.parent, { recursive: true, force: true }))

  assert.throws(
    () => validateRealE2eEnvironment({ ...envFor(paths), SKILL_GRAFT_REAL_E2E: '0' }, safeOptions(paths)),
    /SKILL_GRAFT_REAL_E2E=1/
  )
  assert.throws(
    () => validateRealE2eEnvironment({ ...envFor(paths), SKILL_GRAFT_RUN_ID: '' }, safeOptions(paths)),
    /SKILL_GRAFT_RUN_ID/
  )
  assert.throws(
    () => validateRealE2eEnvironment({ ...envFor(paths), SKILL_GRAFT_REAL_PROBE: path.join(paths.parent, 'outside') }, safeOptions(paths)),
    /probe.*run root/i
  )

  const context = validateRealE2eEnvironment(envFor(paths), safeOptions(paths))
  assert.equal(context.runId, paths.runId)
  assert.equal(context.runRoot, path.resolve(paths.root))
  assert.equal(context.probeRoot, path.resolve(paths.probe))
  assert.equal(context.hubDataRoot, path.resolve(paths.hubData))
  assert.equal(context.cliPath, path.resolve(paths.cli))
})

test('real E2E rejects the workspace, user home, drive root, and protected live trees', (t) => {
  const paths = makePaths('p0-protected-20260821-000000')
  t.after(() => fs.rmSync(paths.parent, { recursive: true, force: true }))
  const options = {
    workspaceRoot: paths.root,
    homeDir: path.join(paths.parent, 'unrelated-home'),
    protectedRoots: [paths.root]
  }

  assert.throws(() => validateRealE2eEnvironment(envFor(paths), options), /protected/i)

  const homeRunId = 'p0-home-20260821-000000'
  const homeRoot = path.join(os.homedir(), homeRunId)
  const homeRun = {
    ...paths,
    runId: homeRunId,
    root: homeRoot,
    probe: path.join(homeRoot, 'probe'),
    hubData: path.join(homeRoot, 'hub-data'),
    cli: path.join(homeRoot, 'app', 'node_modules', 'ozdqp-skill-hub', 'dist', 'control', 'cli.js')
  }
  assert.throws(() => validateRealE2eEnvironment(envFor(homeRun), { homeDir: os.homedir() }), /user home/i)

  const drive = path.parse(paths.root).root
  const driveRun = { ...paths, root: drive, probe: path.join(drive, 'probe'), hubData: path.join(drive, 'hub-data') }
  assert.throws(() => validateRealE2eEnvironment(envFor(driveRun)), /drive root|run.?id/i)
})

test('real E2E rejects a run root nested in any Git checkout ancestor', (t) => {
  const paths = makePaths('p0-git-tree-20260821-000000')
  t.after(() => fs.rmSync(paths.parent, { recursive: true, force: true }))
  const liveTree = path.join(paths.parent, 'unlisted-live-tree')
  fs.mkdirSync(path.join(liveTree, '.git'), { recursive: true })
  const root = path.join(liveTree, paths.runId)
  const nested = {
    ...paths,
    root,
    probe: path.join(root, 'probe'),
    hubData: path.join(root, 'hub-data'),
    cli: path.join(root, 'app', 'node_modules', 'ozdqp-skill-hub', 'dist', 'control', 'cli.js')
  }

  assert.throws(
    () => validateRealE2eEnvironment(envFor(nested), safeOptions(nested)),
    /inside a Git checkout/i
  )
})

test('run layout only creates and removes marker-owned paths', (t) => {
  const paths = makePaths('p0-layout-20260821-000000')
  t.after(() => fs.rmSync(paths.parent, { recursive: true, force: true }))
  const context = validateRealE2eEnvironment(envFor(paths), safeOptions(paths))
  const layout = createRunLayout(context)

  for (const key of ['appRoot', 'homeRoot', 'hubDataRoot', 'probeRoot', 'logsRoot']) {
    assert.equal(fs.statSync(layout[key]).isDirectory(), true, key)
  }
  assert.equal(fs.existsSync(layout.markerFile), true)

  const scratch = path.join(layout.logsRoot, 'delete-me')
  fs.mkdirSync(scratch)
  removeOwnedPath(context, scratch)
  assert.equal(fs.existsSync(scratch), false)
  assert.throws(() => removeOwnedPath(context, paths.parent), /outside|refusing/i)
  assert.throws(() => removeOwnedPath(context, context.runRoot), /run root/i)

  cleanupRunLayout(context)
  assert.equal(fs.existsSync(context.runRoot), false)
})

test('a probe Junction cannot escape the run root', (t) => {
  const paths = makePaths('p0-reparse-20260821-000000')
  t.after(() => fs.rmSync(paths.parent, { recursive: true, force: true }))
  const context = validateRealE2eEnvironment(envFor(paths), safeOptions(paths))
  createRunLayout(context)
  const outside = path.join(paths.parent, 'protected-live-tree')
  fs.mkdirSync(outside)
  const sentinel = path.join(outside, 'sentinel.txt')
  fs.writeFileSync(sentinel, 'must-survive\n')
  removeOwnedPath(context, context.probeRoot)
  fs.symlinkSync(outside, context.probeRoot, process.platform === 'win32' ? 'junction' : 'dir')

  assert.throws(
    () => validateRealE2eEnvironment(envFor(paths), safeOptions(paths, [outside])),
    /probe.*run root|protected/i
  )
  assert.throws(() => removeOwnedPath(context, context.probeRoot), /outside.*run root/i)
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'must-survive\n')
  cleanupRunLayout(context)
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'must-survive\n')
})

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('random loopback port is reusable after service exit', async () => {
  const port = await getAvailableLoopbackPort()
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535)
  assert.notEqual(port, 18765)
  assert.notEqual(port, 3080)

  const first = net.createServer()
  await listen(first, port)
  await close(first)
  const second = net.createServer()
  await listen(second, port)
  await close(second)
})

test('owned detached PID cleanup terminates a real Node parent and child process tree', { timeout: 20000 }, async (t) => {
  const token = `p0-process-${Date.now().toString(36)}`
  const code = [
    "const { spawn } = require('node:child_process')",
    'const token = process.argv[1]',
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', token + '-child'], { stdio: 'ignore', windowsHide: true })",
    'process.stdout.write(String(child.pid) + "\\n")',
    'setInterval(() => {}, 1000)'
  ].join('; ')
  const parent = spawn(process.execPath, ['-e', code, token], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  const tracker = new ProcessTracker({ runId: token })
  tracker.track(parent)
  tracker.trackPid(parent.pid, { commandIncludes: token })
  t.after(async () => {
    await tracker.stopAll({ graceMs: 100 })
  })
  const childPid = await new Promise((resolve, reject) => {
    let text = ''
    const timer = setTimeout(() => reject(new Error('child PID was not reported')), 5000)
    parent.stdout.on('data', (chunk) => {
      text += chunk.toString('utf8')
      const line = text.split(/\r?\n/)[0].trim()
      if (line) {
        clearTimeout(timer)
        resolve(Number(line))
      }
    })
    parent.once('error', reject)
    parent.once('exit', (codeValue) => {
      if (!text.trim()) reject(new Error(`parent exited before reporting child PID: ${codeValue}`))
    })
  })
  assert.equal(pidAlive(parent.pid), true)
  assert.equal(pidAlive(childPid), true)
  await tracker.stopAll({ graceMs: 250 })
  assert.equal(pidAlive(parent.pid), false)
  assert.equal(pidAlive(childPid), false)
})

test('Windows owned-PID discovery only adopts a run-id and marker-path match', {
  timeout: 20000,
  skip: process.platform !== 'win32'
}, async (t) => {
  const token = `p0-sweep-${Date.now().toString(36)}`
  const markerPath = path.join(os.tmpdir(), token, 'session-owned.last.txt')
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', token, markerPath], {
    stdio: 'ignore',
    windowsHide: true
  })
  const tracker = new ProcessTracker({ runId: token })
  tracker.track(child)
  t.after(async () => tracker.stopAll({ graceMs: 100 }))
  const deadline = Date.now() + 5000
  let adopted = []
  while (adopted.length === 0 && Date.now() < deadline) {
    adopted = tracker.trackWindowsOwnedPids({ commandIncludes: token, pathIncludesAny: [markerPath] })
    if (adopted.length === 0) await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.deepEqual(adopted, [child.pid])
  await tracker.stopAll({ graceMs: 250 })
  assert.equal(pidAlive(child.pid), false)
})
