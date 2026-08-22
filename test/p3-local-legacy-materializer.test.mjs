import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { createLocalMaterializer } from '../dist/adapters/local-materializer.js'
import {
  buildDesiredMaterialization,
  createLibrarySnapshotManifest,
  createRuntimeAssetManifest,
  materializationSourceArtifactId,
  planLegacyMigration,
  planLegacyRollback,
  verifyLegacyMigrationRecordIdentity,
  verifyMaterializationMarker
} from '../dist/core/index.js'
import { ApplicationTransactionErrorBase } from '../dist/application/transaction-port.js'

function sha(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function git(cwd, args) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_'))
  )
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024, env
  })
  assert.equal(result.status, 0, String(result.stderr || result.stdout))
  return String(result.stdout || '')
}

function gitPath(cwd, relative) {
  return path.resolve(cwd, git(cwd, ['rev-parse', '--git-path', relative]).trim())
}

function file(name, bytes, mode = '100644') {
  return { path: name, size: Buffer.byteLength(bytes), sha256: sha(bytes), mode, isReparsePoint: false }
}

function manifest(files, revision = 'legacy-library-r1') {
  const created = createLibrarySnapshotManifest({
    source: { kind: 'library', id: 'legacy-materializer-test', revision },
    createdAt: '2035-01-02T03:04:05.000Z',
    files: Object.entries(files).map(([name, bytes]) => file(name, bytes))
  })
  assert.equal(created.ok, true, JSON.stringify(created))
  return created.manifest
}

function runtime(files, revision = 'legacy-runtime-r1') {
  const created = createRuntimeAssetManifest({
    runtimeRevision: revision,
    files: Object.entries(files).map(([name, bytes]) => file(name, bytes))
  })
  assert.equal(created.ok, true, JSON.stringify(created))
  return created.manifest
}

function writeTree(root, files) {
  for (const [relative, bytes] of Object.entries(files)) {
    const target = path.join(root, ...relative.split('/'))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, bytes)
  }
}

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-legacy-materializer-'))
  const packageRoot = `${root}-package`
  const dataRoot = `${root}-data`
  const legacySourceRoot = `${root}-legacy-source`
  for (const target of [packageRoot, dataRoot, legacySourceRoot]) fs.mkdirSync(target, { recursive: true })
  fs.mkdirSync(path.join(packageRoot, 'overlay', 'hooks'), { recursive: true })
  t.after(() => {
    for (const target of [root, packageRoot, dataRoot, legacySourceRoot]) {
      fs.rmSync(target, { recursive: true, force: true })
    }
  })
  git(root, ['init', '--quiet'])
  git(root, ['config', 'user.email', 'fixture@example.invalid'])
  git(root, ['config', 'user.name', 'Fixture'])
  git(root, ['config', 'extensions.worktreeConfig', 'true'])
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'project-owned\n')
  fs.mkdirSync(path.join(root, '.agents', 'skills', 'unity-skills'), { recursive: true })
  fs.writeFileSync(path.join(root, '.agents', 'skills', 'unity-skills', 'SKILL.md'), 'unity-owned\n')
  git(root, ['add', 'AGENTS.md', '.agents/skills/unity-skills/SKILL.md'])
  git(root, ['commit', '--quiet', '-m', 'fixture'])

  const identity = {
    pathKey: sha(path.resolve(root).toLowerCase()),
    worktreeId: 'worktree:legacy-materializer-test'
  }
  const snapshots = new Map()
  const runtimeAssets = new Map()
  let tokenSequence = 0
  const createAdapter = () => createLocalMaterializer({
    packageRoot,
    dataRoot,
    legacySourceRoot,
    identities: { async resolve(candidate) {
      assert.equal(path.resolve(candidate), path.resolve(root))
      return identity
    } },
    snapshots: { async readVerifiedFile(input) {
      const bytes = snapshots.get(input.snapshotId)?.get(input.path)
      return bytes == null ? null : Buffer.from(bytes)
    } },
    runtimeAssets: {
      async observe() { return null },
      async readVerifiedFile(input) {
        const bytes = runtimeAssets.get(input.runtimeAssetId)?.get(input.path)
        return bytes == null ? null : Buffer.from(bytes)
      }
    },
    checkpoint: options.checkpoint,
    token: () => `legacy-fixture-${String(++tokenSequence).padStart(16, '0')}`
  })
  const adapter = createAdapter()
  return {
    root,
    packageRoot,
    dataRoot,
    legacySourceRoot,
    identity,
    adapter,
    reopen: createAdapter,
    registerSnapshot(value, files) { snapshots.set(value.snapshotId, new Map(Object.entries(files))) },
    registerRuntime(value, files) { runtimeAssets.set(value.runtimeAssetId, new Map(Object.entries(files))) }
  }
}

function pinFor(model, snapshot, selectedSkills, materializedSnapshot = null) {
  return {
    schemaVersion: 1,
    pathKey: model.identity.pathKey,
    worktreeId: model.identity.worktreeId,
    requestedSnapshot: snapshot.snapshotId,
    materializedSnapshot,
    selectedSkills,
    claimState: 'claimed'
  }
}

async function approvedLegacyMigration(model, source, revision = 1) {
  const selectedSkills = source.selectedSkills ?? ['ozdqp-development']
  const inspection = await inspect(model, source)
  const result = planLegacyMigration({
    pathKey: model.identity.pathKey,
    worktreeId: model.identity.worktreeId,
    stateRevision: revision,
    pin: pinFor(model, source.snapshot, selectedSkills),
    snapshot: source.snapshot,
    runtimeAsset: source.runtimeAsset,
    durableMarker: null,
    observedMarker: inspection.observedMarker,
    currentVisibilityState: inspection.currentVisibilityState,
    desiredVisibilityState: inspection.desiredVisibilityState,
    backupPrivateStateId: inspection.backupPrivateStateId,
    migrationRecord: null,
    artifacts: inspection.artifacts,
    gitFacts: inspection.gitFacts,
    gitConfiguration: inspection.gitConfiguration
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.status, 'planned', JSON.stringify(result))
  assert.equal(result.plan.executable, true, JSON.stringify(result.plan))
  return { inspection, plan: result.plan }
}

function legacyRollbackPlan(model, source, marker, migration, inspection, revision = 2) {
  const selectedSkills = source.selectedSkills ?? ['ozdqp-development']
  return planLegacyRollback({
    pathKey: model.identity.pathKey,
    worktreeId: model.identity.worktreeId,
    stateRevision: revision,
    pin: pinFor(model, source.snapshot, selectedSkills, source.snapshot.snapshotId),
    snapshot: source.snapshot,
    runtimeAsset: source.runtimeAsset,
    durableMarker: { schemaVersion: 1, pathKey: model.identity.pathKey, marker },
    observedMarker: inspection.observedMarker,
    currentVisibilityState: inspection.currentVisibilityState,
    desiredVisibilityState: inspection.desiredVisibilityState,
    backupPrivateStateId: inspection.backupPrivateStateId,
    migrationRecord: migration,
    artifacts: inspection.artifacts,
    gitFacts: inspection.gitFacts,
    gitConfiguration: inspection.gitConfiguration,
    restoreSources: inspection.restoreSources,
    restoreGitFacts: inspection.restoreGitFacts,
    restoreGitConfiguration: inspection.restoreGitConfiguration
  })
}

async function approvedLegacyRollback(model, source, marker, migration, revision = 2) {
  const selectedSkills = source.selectedSkills ?? ['ozdqp-development']
  const inspection = await model.adapter.inspectLegacyRollback({
    worktree: model.root,
    identity: model.identity,
    snapshot: source.snapshot,
    runtimeAsset: source.runtimeAsset,
    selectedSkills,
    migration
  })
  const result = legacyRollbackPlan(model, source, marker, migration, inspection, revision)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.status, 'planned', JSON.stringify(result))
  assert.equal(result.plan.executable, true, JSON.stringify(result.plan))
  return { inspection, plan: result.plan }
}

const lease = { async revalidateLease() {} }

class LostLease extends ApplicationTransactionErrorBase {
  code = 'LOCK_NOT_OWNED'
  retryable = true
  constructor() { super('fixture lease lost') }
}

function sources(model) {
  const snapshotFiles = {
    'AGENTS.override.md': 'override-v1\n',
    'skills/ozdqp-development/SKILL.md': '# development-v1\n'
  }
  const runtimeFiles = { 'HubLib.ps1': 'hub-lib-v1\n' }
  const snapshot = manifest(snapshotFiles)
  const runtimeAsset = runtime(runtimeFiles)
  model.registerSnapshot(snapshot, snapshotFiles)
  model.registerRuntime(runtimeAsset, runtimeFiles)
  writeTree(model.legacySourceRoot, {
    'AGENTS.override.md': snapshotFiles['AGENTS.override.md'],
    'skills/ozdqp-development/SKILL.md': snapshotFiles['skills/ozdqp-development/SKILL.md'],
    'overlay/HubLib.ps1': runtimeFiles['HubLib.ps1']
  })
  return { snapshot, runtimeAsset, snapshotFiles, runtimeFiles }
}

function linkDirectory(source, target, t) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  try {
    fs.symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') t.skip(`junction unavailable: ${error.code}`)
    throw error
  }
}

async function inspect(model, source, migration = null) {
  return model.adapter.inspectLegacy({
    worktree: model.root,
    identity: model.identity,
    snapshot: source.snapshot,
    runtimeAsset: source.runtimeAsset,
    selectedSkills: source.selectedSkills ?? ['ozdqp-development'],
    migration
  })
}

test('legacy inspection recognizes exact hardlink and junction while leaving missing targets creatable', async (t) => {
  const model = fixture(t)
  const source = sources(model)
  fs.linkSync(
    path.join(model.legacySourceRoot, 'AGENTS.override.md'),
    path.join(model.root, 'AGENTS.override.md')
  )
  linkDirectory(
    path.join(model.legacySourceRoot, 'skills', 'ozdqp-development'),
    path.join(model.root, '.agents', 'skills', 'ozdqp-development'),
    t
  )

  const result = await inspect(model, source)
  const desired = buildDesiredMaterialization({
    snapshot: source.snapshot,
    runtimeAsset: source.runtimeAsset,
    selectedSkills: ['ozdqp-development'],
    visibilityStateId: result.desiredVisibilityState.visibilityStateId
  })
  assert.equal(desired.ok, true, JSON.stringify(desired))
  assert.deepEqual(result.artifacts.map((fact) => fact.targetRelativePath),
    desired.desired.artifacts.map((artifact) => artifact.targetRelativePath))
  const desiredByPath = new Map(desired.desired.artifacts.map((artifact) => [artifact.targetRelativePath, artifact]))
  const override = result.artifacts.find((fact) => fact.targetRelativePath === 'AGENTS.override.md')
  const skill = result.artifacts.find((fact) => fact.targetRelativePath === '.agents/skills/ozdqp-development')
  const overlay = result.artifacts.find((fact) => fact.targetRelativePath === '.codex/local-overlay')
  assert.deepEqual(
    [override.observedKind, override.legacyKind, override.isReparsePoint],
    ['hardlink', 'fileHardlink', false]
  )
  assert.deepEqual(
    [skill.observedKind, skill.legacyKind, skill.isReparsePoint],
    ['junction', 'directoryLink', true]
  )
  assert.deepEqual(
    [overlay.observedKind, overlay.digest, overlay.legacyKind, overlay.sourceArtifactId],
    ['missing', null, null, null]
  )
  for (const fact of [override, skill]) {
    const artifact = desiredByPath.get(fact.targetRelativePath)
    assert.equal(fact.digest, artifact.digest)
    assert.equal(fact.sourceArtifactId, materializationSourceArtifactId({
      digest: artifact.digest,
      source: artifact.source
    }))
  }
  assert.match(result.backupPrivateStateId, /^sha256:[0-9a-f]{64}$/)
  assert.equal((await inspect(model, source)).backupPrivateStateId, result.backupPrivateStateId)
  const publicBytes = JSON.stringify(result)
  for (const locator of [model.root, model.legacySourceRoot, model.packageRoot, model.dataRoot]) {
    assert.equal(publicBytes.includes(locator), false, `public inspection leaked locator: ${locator}`)
  }
})

test('legacy inspection classifies wrong inode, wrong junction and plain exact bytes as external or unmanaged', async (t) => {
  const model = fixture(t)
  const source = sources(model)
  const external = `${model.root}-external`
  fs.mkdirSync(external, { recursive: true })
  t.after(() => fs.rmSync(external, { recursive: true, force: true }))
  fs.writeFileSync(path.join(external, 'AGENTS.override.md'), source.snapshotFiles['AGENTS.override.md'])
  fs.linkSync(path.join(external, 'AGENTS.override.md'), path.join(model.root, 'AGENTS.override.md'))
  writeTree(external, { 'skill/SKILL.md': source.snapshotFiles['skills/ozdqp-development/SKILL.md'] })
  linkDirectory(
    path.join(external, 'skill'),
    path.join(model.root, '.agents', 'skills', 'ozdqp-development'),
    t
  )
  writeTree(path.join(model.root, '.codex', 'local-overlay'), source.runtimeFiles)

  const result = await inspect(model, source)
  const override = result.artifacts.find((fact) => fact.targetRelativePath === 'AGENTS.override.md')
  const skill = result.artifacts.find((fact) => fact.targetRelativePath === '.agents/skills/ozdqp-development')
  const overlay = result.artifacts.find((fact) => fact.targetRelativePath === '.codex/local-overlay')
  assert.equal(override.observedKind, 'hardlink')
  assert.equal(override.legacyKind, null)
  assert.match(override.sourceArtifactId, /^sha256:[0-9a-f]{64}$/)
  assert.equal(skill.observedKind, 'junction')
  assert.equal(skill.legacyKind, null)
  assert.match(skill.sourceArtifactId, /^sha256:[0-9a-f]{64}$/)
  assert.equal(overlay.observedKind, 'directory')
  assert.equal(overlay.digest, result.desiredVisibilityState.targets.length > 0
    ? overlay.digest : null)
  assert.equal(overlay.legacyKind, null, 'plain exact content is never silently adopted')
  assert.equal(overlay.sourceArtifactId, null)
})

test('legacy migration publishes independent copies, exact Git effects and marker-last proof while retaining backup', async (t) => {
  const steps = []
  const model = fixture(t, { checkpoint(step) { steps.push(step) } })
  const source = sources(model)
  fs.linkSync(
    path.join(model.legacySourceRoot, 'AGENTS.override.md'),
    path.join(model.root, 'AGENTS.override.md')
  )
  linkDirectory(
    path.join(model.legacySourceRoot, 'skills', 'ozdqp-development'),
    path.join(model.root, '.agents', 'skills', 'ozdqp-development'),
    t
  )
  linkDirectory(
    path.join(model.legacySourceRoot, 'overlay'),
    path.join(model.root, '.codex', 'local-overlay'),
    t
  )
  const commonExclude = path.resolve(
    model.root,
    git(model.root, ['rev-parse', '--git-path', 'info/exclude']).trim()
  )
  fs.appendFileSync(commonExclude, Buffer.from(
    'project-owned-pattern\r\n/AGENTS.override.md\r\n/.agents/skills/ozdqp-development\r\n/.codex/local-overlay\r\n',
    'utf8'
  ))
  const legacyCommonBytes = fs.readFileSync(commonExclude)
  const sibling = `${model.root}-happy-sibling`
  git(model.root, ['worktree', 'add', '--quiet', '--detach', sibling, 'HEAD'])
  t.after(() => fs.rmSync(sibling, { recursive: true, force: true }))
  fs.writeFileSync(path.join(sibling, '.gitignore'), [
    '/AGENTS.override.md',
    '/.agents/skills/ozdqp-development',
    '/.codex/local-overlay',
    ''
  ].join('\n'))

  const { plan } = await approvedLegacyMigration(model, source)
  assert.equal(plan.summary.replaceWithCopy, 3)
  assert.ok(plan.git.configuration.effects.includes('removeOwnedCommonInfoExcludeEntries'))
  const prepared = await model.adapter.prepareLegacyMigration({
    worktree: model.root,
    identity: model.identity,
    guard: lease,
    plan,
    snapshot: source.snapshot,
    runtimeAsset: source.runtimeAsset
  })
  assert.equal(fs.lstatSync(path.join(model.root, 'AGENTS.override.md')).nlink >= 2, true)
  assert.equal(fs.lstatSync(path.join(model.root, '.agents', 'skills', 'ozdqp-development')).isSymbolicLink(), true)
  assert.equal(verifyMaterializationMarker(prepared.marker), true)
  assert.equal(prepared.marker.origin.kind, 'legacyMigration')
  assert.equal(verifyLegacyMigrationRecordIdentity(prepared.record), true)
  assert.equal(prepared.record.status, 'committed')
  assert.equal('rollbackPlanHash' in prepared.record, false)

  await prepared.participant.publish(lease)
  const override = path.join(model.root, 'AGENTS.override.md')
  const skill = path.join(model.root, '.agents', 'skills', 'ozdqp-development')
  const overlay = path.join(model.root, '.codex', 'local-overlay')
  assert.equal(fs.lstatSync(override).nlink, 1, 'hardlink was replaced by an independent file')
  assert.equal(fs.lstatSync(skill).isSymbolicLink(), false)
  assert.equal(fs.lstatSync(overlay).isSymbolicLink(), false)
  assert.equal(fs.readFileSync(override, 'utf8'), source.snapshotFiles['AGENTS.override.md'])
  assert.equal(fs.readFileSync(path.join(skill, 'SKILL.md'), 'utf8'), source.snapshotFiles['skills/ozdqp-development/SKILL.md'])
  assert.equal(fs.readFileSync(path.join(overlay, 'HubLib.ps1'), 'utf8'), source.runtimeFiles['HubLib.ps1'])
  assert.match(fs.readFileSync(commonExclude, 'utf8'), /project-owned-pattern\r?\n/)
  assert.doesNotMatch(fs.readFileSync(commonExclude, 'utf8'), /AGENTS\.override\.md|ozdqp-development|local-overlay/)
  const marker = JSON.parse(fs.readFileSync(
    path.resolve(model.root, git(model.root, ['rev-parse', '--git-path', 'skill-graft/materialized-v1.json']).trim()),
    'utf8'
  ))
  assert.deepEqual(marker, prepared.marker)
  assert.ok(steps.indexOf('legacy-materializer-after-sidecar-phase')
    < steps.indexOf('legacy-materializer-after-marker-phase'))
  const backupRoot = path.resolve(
    model.root,
    git(model.root, ['rev-parse', '--git-path', `skill-graft/legacy-backups/${plan.migrationId.slice('sha256:'.length)}`]).trim()
  )
  assert.equal(fs.existsSync(path.join(backupRoot, 'envelope.json')), true)
  assert.equal(fs.readdirSync(path.join(backupRoot, 'artifacts')).length, 3)
  await prepared.participant.finalize(lease)
  assert.equal(fs.existsSync(backupRoot), true, 'committed migration retains permanent backup')
  const reopenedModel = { ...model, adapter: model.reopen() }
  const reopenedInspection = await inspect(reopenedModel, source, prepared.record)
  assert.equal(reopenedInspection.backupPrivateStateId, prepared.record.backupPrivateStateId)
  const reopenedPlan = planLegacyMigration({
    pathKey: model.identity.pathKey,
    worktreeId: model.identity.worktreeId,
    stateRevision: 2,
    pin: pinFor(model, source.snapshot, ['ozdqp-development'], source.snapshot.snapshotId),
    snapshot: source.snapshot,
    runtimeAsset: source.runtimeAsset,
    durableMarker: { schemaVersion: 1, pathKey: model.identity.pathKey, marker: prepared.marker },
    observedMarker: reopenedInspection.observedMarker,
    currentVisibilityState: reopenedInspection.currentVisibilityState,
    desiredVisibilityState: reopenedInspection.desiredVisibilityState,
    backupPrivateStateId: reopenedInspection.backupPrivateStateId,
    migrationRecord: prepared.record,
    artifacts: reopenedInspection.artifacts,
    gitFacts: reopenedInspection.gitFacts,
    gitConfiguration: reopenedInspection.gitConfiguration
  })
  assert.equal(reopenedPlan.ok, true, JSON.stringify(reopenedPlan))
  assert.equal(reopenedPlan.status, 'already-migrated')
  assert.equal(reopenedPlan.plan, null)
  assert.deepEqual(reopenedPlan.record, prepared.record)

  const envelopePath = path.join(backupRoot, 'envelope.json')
  const originalEnvelope = fs.readFileSync(envelopePath)
  const tamperedEnvelope = JSON.parse(originalEnvelope.toString('utf8'))
  tamperedEnvelope.privatePayload.artifacts[0].rawLinkTarget = 'tampered-after-commit'
  fs.writeFileSync(envelopePath, `${JSON.stringify(tamperedEnvelope)}\n`)
  try {
    await assert.rejects(
      inspect(reopenedModel, source, prepared.record),
      (error) => error?.code === 'STATE_CORRUPT'
    )
  } finally {
    fs.writeFileSync(envelopePath, originalEnvelope)
  }
  fs.unlinkSync(envelopePath)
  try {
    await assert.rejects(
      inspect(reopenedModel, source, prepared.record),
      (error) => error?.code === 'STATE_CORRUPT'
    )
  } finally {
    fs.writeFileSync(envelopePath, originalEnvelope)
  }
  const mismatchedEnvelope = JSON.parse(originalEnvelope.toString('utf8'))
  mismatchedEnvelope.backupPrivateStateId = `sha256:${'0'.repeat(64)}`
  fs.writeFileSync(envelopePath, `${JSON.stringify(mismatchedEnvelope)}\n`)
  try {
    await assert.rejects(
      inspect(reopenedModel, source, prepared.record),
      (error) => error?.code === 'STATE_CORRUPT'
    )
  } finally {
    fs.writeFileSync(envelopePath, originalEnvelope)
  }
  const rollback = await approvedLegacyRollback(model, source, prepared.marker, prepared.record)
  assert.equal(rollback.inspection.gitConfiguration.commonInfoExcludeClean, true)
  assert.equal(rollback.inspection.restoreGitConfiguration.commonInfoExcludeClean, false)
  assert.equal(
    rollback.plan.git.configuration.siblingFactsDigest,
    plan.git.configuration.siblingFactsDigest,
    'rollback freezes the safe sibling proof needed to restore the common exclude'
  )
  assert.equal(rollback.inspection.restoreSources.length, 3)
  assert.deepEqual(rollback.inspection.restoreSources.map((fact) => fact.status), ['valid', 'valid', 'valid'])
  assert.equal(rollback.inspection.desiredVisibilityState.targets.length, 0)
  assert.equal(JSON.stringify(rollback.inspection).includes(model.legacySourceRoot), false)
  const rollbackPrepared = await model.adapter.prepareLegacyRollback({
    worktree: model.root,
    identity: model.identity,
    guard: lease,
    plan: rollback.plan,
    migration: prepared.record,
    snapshot: source.snapshot,
    runtimeAsset: source.runtimeAsset
  })
  assert.equal(rollbackPrepared.record.status, 'rolledBack')
  assert.equal(rollbackPrepared.record.rollbackPlanHash, rollback.plan.planHash)
  assert.equal(rollbackPrepared.record.migrationId, prepared.record.migrationId)
  await rollbackPrepared.participant.publish(lease)
  assert.equal(fs.lstatSync(override).nlink >= 2, true)
  assert.equal(
    fs.statSync(override).ino,
    fs.statSync(path.join(model.legacySourceRoot, 'AGENTS.override.md')).ino
  )
  assert.equal(fs.lstatSync(skill).isSymbolicLink(), true)
  assert.equal(
    path.resolve(fs.realpathSync.native(skill)),
    path.resolve(fs.realpathSync.native(path.join(model.legacySourceRoot, 'skills', 'ozdqp-development')))
  )
  assert.equal(fs.lstatSync(overlay).isSymbolicLink(), true)
  assert.deepEqual(fs.readFileSync(commonExclude), legacyCommonBytes)
  assert.equal(fs.existsSync(path.resolve(
    model.root,
    git(model.root, ['rev-parse', '--git-path', 'skill-graft/materialized-v1.json']).trim()
  )), false, 'rollback deletes marker as its last commit proof')
  assert.equal(fs.readdirSync(path.join(backupRoot, 'artifacts')).length, 0)
  await rollbackPrepared.participant.finalize(lease)
  assert.equal(fs.existsSync(path.join(backupRoot, 'envelope.json')), true)
  const protectedAgents = path.join(model.root, 'AGENTS.md')
  const protectedUnity = path.join(model.root, '.agents', 'skills', 'unity-skills', 'SKILL.md')
  assert.equal(fs.readFileSync(protectedAgents, 'utf8'), 'project-owned\n')
  assert.equal(fs.readFileSync(protectedUnity, 'utf8'), 'unity-owned\n')
  assert.equal(fs.lstatSync(protectedAgents).isSymbolicLink(), false)
  assert.equal(fs.lstatSync(protectedUnity).isSymbolicLink(), false)
})

test('legacy migration and rollback preserve a missing common info exclude as physical absence', async (t) => {
  const model = fixture(t)
  const source = sources(model)
  const sourceOverride = path.join(model.legacySourceRoot, 'AGENTS.override.md')
  const targetOverride = path.join(model.root, 'AGENTS.override.md')
  fs.linkSync(sourceOverride, targetOverride)
  const commonExclude = gitPath(model.root, 'info/exclude')
  fs.unlinkSync(commonExclude)
  const { plan } = await approvedLegacyMigration(model, source)
  assert.equal(plan.git.configuration.effects.includes('removeOwnedCommonInfoExcludeEntries'), false)
  const migration = await model.adapter.prepareLegacyMigration({
    worktree: model.root,
    identity: model.identity,
    guard: lease,
    plan,
    snapshot: source.snapshot,
    runtimeAsset: source.runtimeAsset
  })
  await migration.participant.publish(lease)
  assert.equal(fs.existsSync(commonExclude), false)
  await migration.participant.finalize(lease)
  const rollback = await approvedLegacyRollback(model, source, migration.marker, migration.record)
  const preparedRollback = await model.adapter.prepareLegacyRollback({
    worktree: model.root,
    identity: model.identity,
    guard: lease,
    plan: rollback.plan,
    migration: migration.record,
    snapshot: source.snapshot,
    runtimeAsset: source.runtimeAsset
  })
  await preparedRollback.participant.publish(lease)
  assert.equal(fs.existsSync(commonExclude), false)
  await preparedRollback.participant.finalize(lease)
  assert.equal(fs.existsSync(commonExclude), false)
})

test('legacy remigration reuses an exact retained backup across reopen and rolls back again', async (t) => {
  const model = fixture(t)
  const source = sources(model)
  const sourceOverride = path.join(model.legacySourceRoot, 'AGENTS.override.md')
  const targetOverride = path.join(model.root, 'AGENTS.override.md')
  fs.linkSync(sourceOverride, targetOverride)

  const firstApproved = await approvedLegacyMigration(model, source)
  const firstPlan = firstApproved.plan
  const first = await model.adapter.prepareLegacyMigration({
    worktree: model.root,
    identity: model.identity,
    guard: lease,
    plan: firstPlan,
    snapshot: source.snapshot,
    runtimeAsset: source.runtimeAsset
  })
  await first.participant.publish(lease)
  await first.participant.finalize(lease)
  const firstRollbackPlan = (await approvedLegacyRollback(
    model, source, first.marker, first.record
  )).plan
  const firstRollback = await model.adapter.prepareLegacyRollback({
    worktree: model.root,
    identity: model.identity,
    guard: lease,
    plan: firstRollbackPlan,
    migration: first.record,
    snapshot: source.snapshot,
    runtimeAsset: source.runtimeAsset
  })
  await firstRollback.participant.publish(lease)
  await firstRollback.participant.finalize(lease)

  const backupRoot = gitPath(
    model.root,
    `skill-graft/legacy-backups/${firstPlan.migrationId.slice('sha256:'.length)}`
  )
  const retainedEnvelope = JSON.parse(fs.readFileSync(path.join(backupRoot, 'envelope.json'), 'utf8'))
  assert.equal(fs.readdirSync(path.join(backupRoot, 'artifacts')).length, 0)
  const secondApproved = await approvedLegacyMigration(model, source)
  assert.deepEqual(secondApproved.inspection.artifacts, firstApproved.inspection.artifacts)
  assert.deepEqual(secondApproved.inspection.gitFacts, firstApproved.inspection.gitFacts)
  assert.deepEqual(secondApproved.inspection.gitConfiguration, firstApproved.inspection.gitConfiguration)
  assert.deepEqual(
    secondApproved.inspection.desiredVisibilityState,
    firstApproved.inspection.desiredVisibilityState
  )
  const secondPlan = secondApproved.plan
  const second = await model.adapter.prepareLegacyMigration({
    worktree: model.root,
    identity: model.identity,
    guard: lease,
    plan: secondPlan,
    snapshot: source.snapshot,
    runtimeAsset: source.runtimeAsset
  })
  const secondBackupRoot = gitPath(
    model.root,
    `skill-graft/legacy-backups/${secondPlan.migrationId.slice('sha256:'.length)}`
  )
  const secondEnvelope = JSON.parse(fs.readFileSync(path.join(secondBackupRoot, 'envelope.json'), 'utf8'))
  assert.deepEqual(secondEnvelope.privatePayload, retainedEnvelope.privatePayload)
  assert.equal(secondPlan.migrationId, firstPlan.migrationId)
  assert.equal(secondPlan.planHash, firstPlan.planHash)
  await second.participant.publish(lease)
  await second.participant.finalize(lease)
  assert.equal(second.record.migrationId, first.record.migrationId)
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(backupRoot, 'envelope.json'), 'utf8')).prepareToken,
    retainedEnvelope.prepareToken,
    'remigration preserves the original verified backup token'
  )

  const reopenedModel = { ...model, adapter: model.reopen() }
  const secondRollbackPlan = (await approvedLegacyRollback(
    reopenedModel, source, second.marker, second.record
  )).plan
  const secondRollback = await reopenedModel.adapter.prepareLegacyRollback({
    worktree: reopenedModel.root,
    identity: reopenedModel.identity,
    guard: lease,
    plan: secondRollbackPlan,
    migration: second.record,
    snapshot: source.snapshot,
    runtimeAsset: source.runtimeAsset
  })
  await secondRollback.participant.publish(lease)
  await secondRollback.participant.finalize(lease)
  assert.equal(fs.statSync(targetOverride).ino, fs.statSync(sourceOverride).ino)
  assert.equal(fs.existsSync(path.join(backupRoot, 'envelope.json')), true)
  assert.equal(fs.readdirSync(path.join(backupRoot, 'artifacts')).length, 0)
})

test('legacy migration recovery distinguishes durable absent, explicit null and durable new at a visibility-safe cut', async (t) => {
  for (const direction of ['old-absent', 'old-null', 'new']) {
    await t.test(direction, async (child) => {
      let armed = false
      let lost = false
      const observed = []
      const model = fixture(child, {
        checkpoint(step) {
          if (!armed || step !== 'legacy-materializer-after-git-publication-phase') return
          observed.push(step)
          lost = true
        }
      })
      const source = sources(model)
      fs.linkSync(
        path.join(model.legacySourceRoot, 'AGENTS.override.md'),
        path.join(model.root, 'AGENTS.override.md')
      )
      linkDirectory(
        path.join(model.legacySourceRoot, 'skills', 'ozdqp-development'),
        path.join(model.root, '.agents', 'skills', 'ozdqp-development'),
        child
      )
      linkDirectory(
        path.join(model.legacySourceRoot, 'overlay'),
        path.join(model.root, '.codex', 'local-overlay'),
        child
      )
      const { plan } = await approvedLegacyMigration(model, source)
      const prepared = await model.adapter.prepareLegacyMigration({
        worktree: model.root,
        identity: model.identity,
        guard: lease,
        plan,
        snapshot: source.snapshot,
        runtimeAsset: source.runtimeAsset
      })
      armed = true
      const losingGuard = {
        async revalidateLease() { if (lost) throw new LostLease() }
      }
      await assert.rejects(
        prepared.participant.publish(losingGuard),
        (error) => error?.code === 'LOCK_NOT_OWNED'
      )
      assert.deepEqual(observed, ['legacy-materializer-after-git-publication-phase'])
      armed = false
      lost = false

      const durable = direction === 'new'
        ? { schemaVersion: 1, pathKey: model.identity.pathKey, marker: prepared.marker }
        : direction === 'old-null'
          ? { schemaVersion: 1, pathKey: model.identity.pathKey, marker: null }
          : null
      const materializedSnapshot = direction === 'new' ? source.snapshot.snapshotId : null
      const recovered = await model.adapter.recover({
        worktree: model.root,
        identity: model.identity,
        durable,
        guard: lease,
        pin: pinFor(
          model, source.snapshot, ['ozdqp-development'], materializedSnapshot
        ),
        stateRevision: direction === 'new' ? 2 : 1
      })
      assert.deepEqual(recovered, direction === 'new'
        ? { status: 'finalized', recoveredTransactions: 1 }
        : { status: 'rolled-back', recoveredTransactions: 1 })

      const override = path.join(model.root, 'AGENTS.override.md')
      const skill = path.join(model.root, '.agents', 'skills', 'ozdqp-development')
      const overlay = path.join(model.root, '.codex', 'local-overlay')
      const markerPath = gitPath(model.root, 'skill-graft/materialized-v1.json')
      const backupRoot = gitPath(
        model.root,
        `skill-graft/legacy-backups/${plan.migrationId.slice('sha256:'.length)}`
      )
      if (direction === 'new') {
        assert.equal(fs.lstatSync(override).nlink, 1)
        assert.equal(fs.lstatSync(skill).isSymbolicLink(), false)
        assert.equal(fs.lstatSync(overlay).isSymbolicLink(), false)
        assert.deepEqual(JSON.parse(fs.readFileSync(markerPath, 'utf8')), prepared.marker)
        assert.equal(fs.existsSync(path.join(backupRoot, 'envelope.json')), true)
      } else {
        assert.equal(fs.lstatSync(override).nlink >= 2, true)
        assert.equal(fs.lstatSync(skill).isSymbolicLink(), true)
        assert.equal(fs.lstatSync(overlay).isSymbolicLink(), true)
        assert.equal(fs.existsSync(markerPath), false)
        assert.equal(fs.existsSync(backupRoot), false)
      }
      assert.equal(fs.readdirSync(gitPath(model.root, 'skill-graft/legacy-transactions')).length, 0)
      assert.deepEqual(await model.adapter.recover({
        worktree: model.root,
        identity: model.identity,
        durable,
        guard: lease,
        pin: pinFor(
          model, source.snapshot, ['ozdqp-development'], materializedSnapshot
        ),
        stateRevision: direction === 'new' ? 2 : 1
      }), { status: 'clean', recoveredTransactions: 0 })
    })
  }
})

test('legacy rollback recovery uses explicit null as new truth and the committed marker as old truth', async (t) => {
  for (const direction of ['old', 'new']) {
    await t.test(direction, async (child) => {
      let armed = false
      let lost = false
      const observed = []
      const model = fixture(child, {
        checkpoint(step) {
          if (!armed || step !== 'legacy-materializer-after-rollback-git-phase') return
          observed.push(step)
          lost = true
        }
      })
      const source = sources(model)
      fs.linkSync(
        path.join(model.legacySourceRoot, 'AGENTS.override.md'),
        path.join(model.root, 'AGENTS.override.md')
      )
      linkDirectory(
        path.join(model.legacySourceRoot, 'skills', 'ozdqp-development'),
        path.join(model.root, '.agents', 'skills', 'ozdqp-development'),
        child
      )
      linkDirectory(
        path.join(model.legacySourceRoot, 'overlay'),
        path.join(model.root, '.codex', 'local-overlay'),
        child
      )
      const migrationPlan = (await approvedLegacyMigration(model, source)).plan
      const migration = await model.adapter.prepareLegacyMigration({
        worktree: model.root,
        identity: model.identity,
        guard: lease,
        plan: migrationPlan,
        snapshot: source.snapshot,
        runtimeAsset: source.runtimeAsset
      })
      await migration.participant.publish(lease)
      await migration.participant.finalize(lease)

      const rollbackPlan = (await approvedLegacyRollback(
        model, source, migration.marker, migration.record
      )).plan
      const rollback = await model.adapter.prepareLegacyRollback({
        worktree: model.root,
        identity: model.identity,
        guard: lease,
        plan: rollbackPlan,
        migration: migration.record,
        snapshot: source.snapshot,
        runtimeAsset: source.runtimeAsset
      })
      armed = true
      const losingGuard = {
        async revalidateLease() { if (lost) throw new LostLease() }
      }
      await assert.rejects(
        rollback.participant.publish(losingGuard),
        (error) => error?.code === 'LOCK_NOT_OWNED'
      )
      assert.deepEqual(observed, ['legacy-materializer-after-rollback-git-phase'])
      armed = false
      lost = false

      const durable = {
        schemaVersion: 1,
        pathKey: model.identity.pathKey,
        marker: direction === 'new' ? null : migration.marker
      }
      const recovered = await model.adapter.recover({
        worktree: model.root,
        identity: model.identity,
        durable,
        guard: lease,
        pin: pinFor(
          model,
          source.snapshot,
          ['ozdqp-development'],
          direction === 'new' ? null : source.snapshot.snapshotId
        ),
        stateRevision: direction === 'new' ? 3 : 2
      })
      assert.deepEqual(recovered, direction === 'new'
        ? { status: 'finalized', recoveredTransactions: 1 }
        : { status: 'rolled-back', recoveredTransactions: 1 })

      const override = path.join(model.root, 'AGENTS.override.md')
      const skill = path.join(model.root, '.agents', 'skills', 'ozdqp-development')
      const overlay = path.join(model.root, '.codex', 'local-overlay')
      const markerPath = gitPath(model.root, 'skill-graft/materialized-v1.json')
      const backupRoot = gitPath(
        model.root,
        `skill-graft/legacy-backups/${migration.record.migrationId.slice('sha256:'.length)}`
      )
      if (direction === 'new') {
        assert.equal(fs.lstatSync(override).nlink >= 2, true)
        assert.equal(fs.lstatSync(skill).isSymbolicLink(), true)
        assert.equal(fs.lstatSync(overlay).isSymbolicLink(), true)
        assert.equal(fs.existsSync(markerPath), false)
        assert.equal(fs.readdirSync(path.join(backupRoot, 'artifacts')).length, 0)
      } else {
        assert.equal(fs.lstatSync(override).nlink, 1)
        assert.equal(fs.lstatSync(skill).isSymbolicLink(), false)
        assert.equal(fs.lstatSync(overlay).isSymbolicLink(), false)
        assert.deepEqual(JSON.parse(fs.readFileSync(markerPath, 'utf8')), migration.marker)
        assert.equal(fs.readdirSync(path.join(backupRoot, 'artifacts')).length, 3)
      }
      assert.equal(fs.existsSync(path.join(backupRoot, 'envelope.json')), true)
      assert.equal(fs.readdirSync(gitPath(model.root, 'skill-graft/legacy-transactions')).length, 0)
    })
  }

  await t.test('durable-absent-is-not-rollback-new', async (child) => {
    const model = fixture(child)
    const source = sources(model)
    fs.linkSync(
      path.join(model.legacySourceRoot, 'AGENTS.override.md'),
      path.join(model.root, 'AGENTS.override.md')
    )
    const migrationPlan = (await approvedLegacyMigration(model, source)).plan
    const migration = await model.adapter.prepareLegacyMigration({
      worktree: model.root,
      identity: model.identity,
      guard: lease,
      plan: migrationPlan,
      snapshot: source.snapshot,
      runtimeAsset: source.runtimeAsset
    })
    await migration.participant.publish(lease)
    await migration.participant.finalize(lease)
    const rollbackPlan = (await approvedLegacyRollback(
      model, source, migration.marker, migration.record
    )).plan
    await model.adapter.prepareLegacyRollback({
      worktree: model.root,
      identity: model.identity,
      guard: lease,
      plan: rollbackPlan,
      migration: migration.record,
      snapshot: source.snapshot,
      runtimeAsset: source.runtimeAsset
    })
    await assert.rejects(model.adapter.recover({
      worktree: model.root,
      identity: model.identity,
      durable: null,
      guard: lease,
      pin: pinFor(model, source.snapshot, ['ozdqp-development'], null),
      stateRevision: 3
    }), (error) => error?.code === 'STATE_CORRUPT')
  })
})

test('legacy backward recovery resumes after a second lease loss with marker proof still last', async (t) => {
  await t.test('migration-backward', async (child) => {
    let armed = false
    let lost = false
    const model = fixture(child, {
      checkpoint(step) {
        if (armed && step === 'legacy-materializer-after-git-rollback-phase') lost = true
      }
    })
    const source = sources(model)
    fs.linkSync(
      path.join(model.legacySourceRoot, 'AGENTS.override.md'),
      path.join(model.root, 'AGENTS.override.md')
    )
    linkDirectory(
      path.join(model.legacySourceRoot, 'skills', 'ozdqp-development'),
      path.join(model.root, '.agents', 'skills', 'ozdqp-development'),
      child
    )
    const plan = (await approvedLegacyMigration(model, source)).plan
    const prepared = await model.adapter.prepareLegacyMigration({
      worktree: model.root,
      identity: model.identity,
      guard: lease,
      plan,
      snapshot: source.snapshot,
      runtimeAsset: source.runtimeAsset
    })
    await prepared.participant.publish(lease)
    armed = true
    const losingGuard = {
      async revalidateLease() { if (lost) throw new LostLease() }
    }
    await assert.rejects(model.adapter.recover({
      worktree: model.root,
      identity: model.identity,
      durable: null,
      guard: losingGuard,
      pin: pinFor(model, source.snapshot, ['ozdqp-development'], null),
      stateRevision: 1
    }), (error) => error?.code === 'LOCK_NOT_OWNED')
    assert.equal(lost, true)
    assert.equal(fs.readdirSync(gitPath(model.root, 'skill-graft/legacy-transactions')).length, 1)
    armed = false
    lost = false
    assert.deepEqual(await model.adapter.recover({
      worktree: model.root,
      identity: model.identity,
      durable: null,
      guard: lease,
      pin: pinFor(model, source.snapshot, ['ozdqp-development'], null),
      stateRevision: 1
    }), { status: 'rolled-back', recoveredTransactions: 1 })
    assert.equal(fs.lstatSync(path.join(model.root, 'AGENTS.override.md')).nlink >= 2, true)
    assert.equal(fs.lstatSync(
      path.join(model.root, '.agents', 'skills', 'ozdqp-development')
    ).isSymbolicLink(), true)
    assert.equal(fs.existsSync(gitPath(model.root, 'skill-graft/materialized-v1.json')), false)
    assert.equal(fs.existsSync(gitPath(
      model.root,
      `skill-graft/legacy-backups/${plan.migrationId.slice('sha256:'.length)}`
    )), false)
  })

  await t.test('rollback-backward', async (child) => {
    let armed = false
    let lost = false
    const model = fixture(child, {
      checkpoint(step) {
        if (armed && step === 'legacy-materializer-after-rollback-old-git-phase') lost = true
      }
    })
    const source = sources(model)
    fs.linkSync(
      path.join(model.legacySourceRoot, 'AGENTS.override.md'),
      path.join(model.root, 'AGENTS.override.md')
    )
    linkDirectory(
      path.join(model.legacySourceRoot, 'skills', 'ozdqp-development'),
      path.join(model.root, '.agents', 'skills', 'ozdqp-development'),
      child
    )
    const migrationPlan = (await approvedLegacyMigration(model, source)).plan
    const migration = await model.adapter.prepareLegacyMigration({
      worktree: model.root,
      identity: model.identity,
      guard: lease,
      plan: migrationPlan,
      snapshot: source.snapshot,
      runtimeAsset: source.runtimeAsset
    })
    await migration.participant.publish(lease)
    await migration.participant.finalize(lease)
    const rollbackPlan = (await approvedLegacyRollback(
      model, source, migration.marker, migration.record
    )).plan
    const rollback = await model.adapter.prepareLegacyRollback({
      worktree: model.root,
      identity: model.identity,
      guard: lease,
      plan: rollbackPlan,
      migration: migration.record,
      snapshot: source.snapshot,
      runtimeAsset: source.runtimeAsset
    })
    await rollback.participant.publish(lease)
    armed = true
    const losingGuard = {
      async revalidateLease() { if (lost) throw new LostLease() }
    }
    const durable = {
      schemaVersion: 1, pathKey: model.identity.pathKey, marker: migration.marker
    }
    await assert.rejects(model.adapter.recover({
      worktree: model.root,
      identity: model.identity,
      durable,
      guard: losingGuard,
      pin: pinFor(
        model, source.snapshot, ['ozdqp-development'], source.snapshot.snapshotId
      ),
      stateRevision: 2
    }), (error) => error?.code === 'LOCK_NOT_OWNED')
    assert.equal(lost, true)
    assert.equal(fs.existsSync(gitPath(model.root, 'skill-graft/materialized-v1.json')), false,
      'old marker remains retracted until every old effect is restored')
    armed = false
    lost = false
    assert.deepEqual(await model.adapter.recover({
      worktree: model.root,
      identity: model.identity,
      durable,
      guard: lease,
      pin: pinFor(
        model, source.snapshot, ['ozdqp-development'], source.snapshot.snapshotId
      ),
      stateRevision: 2
    }), { status: 'rolled-back', recoveredTransactions: 1 })
    assert.deepEqual(JSON.parse(fs.readFileSync(
      gitPath(model.root, 'skill-graft/materialized-v1.json'), 'utf8'
    )), migration.marker)
    assert.equal(fs.lstatSync(path.join(model.root, 'AGENTS.override.md')).nlink, 1)
    assert.equal(fs.lstatSync(
      path.join(model.root, '.agents', 'skills', 'ozdqp-development')
    ).isSymbolicLink(), false)
  })
})

test('legacy finalize tombstones resume safely and never drop a backup under durable-new truth', async (t) => {
  for (const outcome of ['forward', 'backward']) {
    await t.test(outcome, async (child) => {
      let armed = false
      let lost = false
      const model = fixture(child, {
        checkpoint(step) {
          if (armed && step === 'legacy-materializer-after-finalize-tombstone') lost = true
        }
      })
      const source = sources(model)
      fs.linkSync(
        path.join(model.legacySourceRoot, 'AGENTS.override.md'),
        path.join(model.root, 'AGENTS.override.md')
      )
      const plan = (await approvedLegacyMigration(model, source)).plan
      const prepared = await model.adapter.prepareLegacyMigration({
        worktree: model.root,
        identity: model.identity,
        guard: lease,
        plan,
        snapshot: source.snapshot,
        runtimeAsset: source.runtimeAsset
      })
      if (outcome === 'forward') await prepared.participant.publish(lease)
      else await prepared.participant.rollback(lease)
      armed = true
      const losingGuard = {
        async revalidateLease() { if (lost) throw new LostLease() }
      }
      await assert.rejects(
        prepared.participant.finalize(losingGuard),
        (error) => error?.code === 'LOCK_NOT_OWNED'
      )
      assert.equal(lost, true)
      const transactionRoot = gitPath(model.root, 'skill-graft/legacy-transactions')
      const tombstones = fs.readdirSync(transactionRoot)
      assert.equal(tombstones.length, 1)
      assert.equal(tombstones[0].startsWith(outcome === 'forward'
        ? '.finalize-forward-'
        : '.finalize-drop-backup-'), true)
      const backupRoot = gitPath(
        model.root,
        `skill-graft/legacy-backups/${plan.migrationId.slice('sha256:'.length)}`
      )
      assert.equal(fs.existsSync(path.join(backupRoot, 'envelope.json')), true)
      armed = false
      lost = false

      if (outcome === 'backward') {
        const durableNew = {
          schemaVersion: 1, pathKey: model.identity.pathKey, marker: prepared.marker
        }
        await assert.rejects(model.adapter.recover({
          worktree: model.root,
          identity: model.identity,
          durable: durableNew,
          guard: lease,
          pin: pinFor(
            model, source.snapshot, ['ozdqp-development'], source.snapshot.snapshotId
          ),
          stateRevision: 2
        }), (error) => error?.code === 'STATE_CORRUPT')
        assert.equal(fs.existsSync(path.join(backupRoot, 'envelope.json')), true,
          'durable-new mismatch is rejected before permanent backup deletion')
      }
      const durable = outcome === 'forward'
        ? { schemaVersion: 1, pathKey: model.identity.pathKey, marker: prepared.marker }
        : null
      assert.deepEqual(await model.adapter.recover({
        worktree: model.root,
        identity: model.identity,
        durable,
        guard: lease,
        pin: pinFor(
          model,
          source.snapshot,
          ['ozdqp-development'],
          outcome === 'forward' ? source.snapshot.snapshotId : null
        ),
        stateRevision: outcome === 'forward' ? 2 : 1
      }), outcome === 'forward'
        ? { status: 'finalized', recoveredTransactions: 1 }
        : { status: 'rolled-back', recoveredTransactions: 1 })
      assert.equal(fs.readdirSync(transactionRoot).length, 0)
      assert.equal(fs.existsSync(backupRoot), outcome === 'forward')
    })
  }
})

test('legacy private envelope, resource bytes and journal parent inventory fail closed before publication', async (t) => {
  const model = fixture(t)
  const source = sources(model)
  const legacyOverride = path.join(model.legacySourceRoot, 'AGENTS.override.md')
  const targetOverride = path.join(model.root, 'AGENTS.override.md')
  fs.linkSync(legacyOverride, targetOverride)
  const before = fs.statSync(targetOverride)
  const plan = (await approvedLegacyMigration(model, source)).plan
  const prepared = await model.adapter.prepareLegacyMigration({
    worktree: model.root,
    identity: model.identity,
    guard: lease,
    plan,
    snapshot: source.snapshot,
    runtimeAsset: source.runtimeAsset
  })
  const backupRoot = gitPath(
    model.root,
    `skill-graft/legacy-backups/${plan.migrationId.slice('sha256:'.length)}`
  )
  const envelopePath = path.join(backupRoot, 'envelope.json')
  const indexBackupPath = path.join(backupRoot, 'resources', 'git-index.bin')
  const transactionRoot = gitPath(model.root, 'skill-graft/legacy-transactions')
  const token = fs.readdirSync(transactionRoot).find((name) => !name.startsWith('.'))
  assert.ok(token)
  const journalPath = path.join(transactionRoot, token, 'journal.json')
  const originalEnvelope = fs.readFileSync(envelopePath)
  const originalIndex = fs.readFileSync(indexBackupPath)
  const originalJournal = fs.readFileSync(journalPath)
  const assertStillOwned = () => {
    const current = fs.statSync(targetOverride)
    assert.equal(current.dev, before.dev)
    assert.equal(current.ino, before.ino)
    assert.equal(fs.lstatSync(targetOverride).nlink >= 2, true)
    assert.equal(fs.existsSync(gitPath(model.root, 'skill-graft/materialized-v1.json')), false)
  }
  const rejectPublish = async () => {
    await assert.rejects(
      prepared.participant.publish(lease),
      (error) => error?.code === 'STATE_CORRUPT'
    )
    assertStillOwned()
  }

  const tamperedEnvelope = JSON.parse(originalEnvelope.toString('utf8'))
  tamperedEnvelope.privatePayload.artifacts[0].rawLinkTarget = 'substituted-private-locator'
  fs.writeFileSync(envelopePath, `${JSON.stringify(tamperedEnvelope)}\n`)
  await rejectPublish()
  fs.writeFileSync(envelopePath, originalEnvelope)

  fs.writeFileSync(indexBackupPath, Buffer.concat([originalIndex, Buffer.from('tamper')]))
  await rejectPublish()
  fs.writeFileSync(indexBackupPath, originalIndex)

  const nullRecord = JSON.parse(originalJournal.toString('utf8'))
  nullRecord.record = null
  fs.writeFileSync(journalPath, `${JSON.stringify(nullRecord)}\n`)
  await rejectPublish()

  const parentOmission = JSON.parse(originalJournal.toString('utf8'))
  parentOmission.createdParents = []
  fs.writeFileSync(journalPath, `${JSON.stringify(parentOmission)}\n`)
  await rejectPublish()
  fs.writeFileSync(journalPath, originalJournal)

  await prepared.participant.rollback(lease)
  await prepared.participant.finalize(lease)
  assertStillOwned()
})

test('legacy rollback inspection reports locator-free valid, missing, changed and unsafe restore sources', async (t) => {
  const model = fixture(t)
  const snapshotFiles = {
    'AGENTS.override.md': 'restore-valid\n',
    'skills/ozdqp-development/SKILL.md': '# restore-missing\n',
    'skills/adopted/second-skill/SKILL.md': '# restore-changed\n'
  }
  const runtimeFiles = { 'HubLib.ps1': 'restore-unsafe\n' }
  const snapshot = manifest(snapshotFiles, 'legacy-restore-four-states')
  const runtimeAsset = runtime(runtimeFiles, 'legacy-restore-four-states')
  model.registerSnapshot(snapshot, snapshotFiles)
  model.registerRuntime(runtimeAsset, runtimeFiles)
  writeTree(model.legacySourceRoot, {
    'AGENTS.override.md': snapshotFiles['AGENTS.override.md'],
    'skills/ozdqp-development/SKILL.md': snapshotFiles['skills/ozdqp-development/SKILL.md'],
    'skills/adopted/second-skill/SKILL.md': snapshotFiles['skills/adopted/second-skill/SKILL.md'],
    'overlay/HubLib.ps1': runtimeFiles['HubLib.ps1']
  })
  fs.linkSync(
    path.join(model.legacySourceRoot, 'AGENTS.override.md'),
    path.join(model.root, 'AGENTS.override.md')
  )
  for (const [skill, sourceRelative] of [
    ['ozdqp-development', 'skills/ozdqp-development'],
    ['second-skill', 'skills/adopted/second-skill']
  ]) {
    linkDirectory(
      path.join(model.legacySourceRoot, ...sourceRelative.split('/')),
      path.join(model.root, '.agents', 'skills', skill),
      t
    )
  }
  linkDirectory(
    path.join(model.legacySourceRoot, 'overlay'),
    path.join(model.root, '.codex', 'local-overlay'),
    t
  )
  const source = {
    snapshot,
    runtimeAsset,
    snapshotFiles,
    runtimeFiles,
    selectedSkills: ['ozdqp-development', 'second-skill']
  }
  const plan = (await approvedLegacyMigration(model, source)).plan
  const migration = await model.adapter.prepareLegacyMigration({
    worktree: model.root,
    identity: model.identity,
    guard: lease,
    plan,
    snapshot,
    runtimeAsset
  })
  await migration.participant.publish(lease)
  await migration.participant.finalize(lease)
  assert.equal(migration.record.artifacts.length, 4)
  const backupRoot = gitPath(
    model.root,
    `skill-graft/legacy-backups/${plan.migrationId.slice('sha256:'.length)}`
  )
  const slotFor = (relative) => {
    const index = migration.record.artifacts.findIndex(
      (artifact) => artifact.targetRelativePath === relative
    )
    assert.notEqual(index, -1)
    return path.join(backupRoot, 'artifacts', `artifact-${String(index).padStart(4, '0')}`)
  }
  const missing = slotFor('.agents/skills/ozdqp-development')
  fs.unlinkSync(missing)
  const changed = slotFor('.agents/skills/second-skill')
  fs.unlinkSync(changed)
  const wrongSource = `${model.root}-wrong-restore-source`
  writeTree(wrongSource, { 'SKILL.md': '# wrong restore source\n' })
  t.after(() => fs.rmSync(wrongSource, { recursive: true, force: true }))
  fs.symlinkSync(wrongSource, changed, process.platform === 'win32' ? 'junction' : 'dir')
  const unsafe = slotFor('.codex/local-overlay')
  fs.unlinkSync(unsafe)
  fs.mkdirSync(unsafe)

  const result = await model.adapter.inspectLegacyRollback({
    worktree: model.root,
    identity: model.identity,
    snapshot,
    runtimeAsset,
    selectedSkills: source.selectedSkills,
    migration: migration.record
  })
  const statusByPath = new Map(result.restoreSources.map((sourceFact) => [
    sourceFact.targetRelativePath, sourceFact.status
  ]))
  assert.equal(statusByPath.get('AGENTS.override.md'), 'valid')
  assert.equal(statusByPath.get('.agents/skills/ozdqp-development'), 'missing')
  assert.equal(statusByPath.get('.agents/skills/second-skill'), 'changed')
  assert.equal(statusByPath.get('.codex/local-overlay'), 'unsafe')
  for (const fact of result.restoreSources) {
    assert.match(fact.sourceStateId, /^sha256:[0-9a-f]{64}$/)
  }
  const publicBytes = JSON.stringify(result)
  for (const locator of [model.root, model.legacySourceRoot, backupRoot, wrongSource]) {
    assert.equal(publicBytes.includes(locator), false, `restore inspection leaked locator: ${locator}`)
  }
})

test('legacy common-info effects fence siblings and reject stale proof before backup or target mutation', async (t) => {
  const model = fixture(t)
  const source = sources(model)
  fs.linkSync(
    path.join(model.legacySourceRoot, 'AGENTS.override.md'),
    path.join(model.root, 'AGENTS.override.md')
  )
  linkDirectory(
    path.join(model.legacySourceRoot, 'skills', 'ozdqp-development'),
    path.join(model.root, '.agents', 'skills', 'ozdqp-development'),
    t
  )
  linkDirectory(
    path.join(model.legacySourceRoot, 'overlay'),
    path.join(model.root, '.codex', 'local-overlay'),
    t
  )
  const commonExclude = gitPath(model.root, 'info/exclude')
  const commonBytes = Buffer.from(
    '/AGENTS.override.md\r\n/.agents/skills/ozdqp-development\r\n/.codex/local-overlay\r\n',
    'utf8'
  )
  fs.appendFileSync(commonExclude, commonBytes)
  const sibling = `${model.root}-sibling`
  git(model.root, ['worktree', 'add', '--quiet', '--detach', sibling, 'HEAD'])
  t.after(() => fs.rmSync(sibling, { recursive: true, force: true }))

  const unsafe = await inspect(model, source)
  assert.equal(unsafe.gitConfiguration.legacyCommonSiblingSafety, 'unsafe')
  const safePatterns = [
    '/AGENTS.override.md',
    '/.agents/skills/ozdqp-development',
    '/.codex/local-overlay'
  ].join('\n')
  fs.writeFileSync(path.join(sibling, '.gitignore'), `${safePatterns}\n`)
  const { plan } = await approvedLegacyMigration(model, source)
  assert.ok(plan.git.configuration.effects.includes('removeOwnedCommonInfoExcludeEntries'))
  fs.unlinkSync(path.join(sibling, '.gitignore'))
  const targetStat = fs.statSync(path.join(model.root, 'AGENTS.override.md'))
  await assert.rejects(model.adapter.prepareLegacyMigration({
    worktree: model.root,
    identity: model.identity,
    guard: lease,
    plan,
    snapshot: source.snapshot,
    runtimeAsset: source.runtimeAsset
  }), (error) => error?.code === 'LEGACY_PLAN_STALE')
  const after = fs.statSync(path.join(model.root, 'AGENTS.override.md'))
  assert.equal(after.dev, targetStat.dev)
  assert.equal(after.ino, targetStat.ino)
  assert.equal(fs.readFileSync(commonExclude).subarray(-commonBytes.length).equals(commonBytes), true)
  assert.equal(fs.existsSync(gitPath(model.root, 'skill-graft/legacy-transactions')), false)
  assert.equal(fs.existsSync(gitPath(
    model.root,
    `skill-graft/legacy-backups/${plan.migrationId.slice('sha256:'.length)}`
  )), false)
})

test('legacy rollback freezes the restore sibling proof and rejects drift after Git locks', async (t) => {
  let armLockDrift = false
  let completedLocks = 0
  let expectedLockCount = 0
  let finalLockResource = ''
  let siblingIgnore = ''
  const model = fixture(t, { checkpoint(step, facts) {
    if (!armLockDrift || step !== 'legacy-materializer-after-git-lock-placeholder-unlink-parent-fsync') return
    completedLocks += 1
    if (facts?.legacyResource === finalLockResource) fs.unlinkSync(siblingIgnore)
  } })
  const source = sources(model)
  fs.linkSync(
    path.join(model.legacySourceRoot, 'AGENTS.override.md'),
    path.join(model.root, 'AGENTS.override.md')
  )
  const commonExclude = gitPath(model.root, 'info/exclude')
  fs.appendFileSync(commonExclude, '/AGENTS.override.md\r\n')
  const sibling = `${model.root}-rollback-sibling`
  git(model.root, ['worktree', 'add', '--quiet', '--detach', sibling, 'HEAD'])
  t.after(() => fs.rmSync(sibling, { recursive: true, force: true }))
  siblingIgnore = path.join(sibling, '.gitignore')
  const safePatterns = [
    '/AGENTS.override.md',
    '/.agents/skills/ozdqp-development',
    '/.codex/local-overlay',
    ''
  ].join('\n')
  fs.writeFileSync(siblingIgnore, safePatterns)

  const migration = await approvedLegacyMigration(model, source)
  const migrated = await model.adapter.prepareLegacyMigration({
    worktree: model.root,
    identity: model.identity,
    guard: lease,
    plan: migration.plan,
    snapshot: source.snapshot,
    runtimeAsset: source.runtimeAsset
  })
  await migrated.participant.publish(lease)
  await migrated.participant.finalize(lease)
  assert.equal(migration.inspection.gitConfiguration.commonInfoExcludeClean, false)
  assert.equal(fs.readFileSync(commonExclude, 'utf8').includes('/AGENTS.override.md'), false)

  fs.unlinkSync(siblingIgnore)
  const unsafeInspection = await model.adapter.inspectLegacyRollback({
    worktree: model.root,
    identity: model.identity,
    snapshot: source.snapshot,
    runtimeAsset: source.runtimeAsset,
    selectedSkills: ['ozdqp-development'],
    migration: migrated.record
  })
  assert.equal(unsafeInspection.gitConfiguration.commonInfoExcludeClean, true)
  assert.equal(unsafeInspection.restoreGitConfiguration.commonInfoExcludeClean, false)
  assert.equal(unsafeInspection.gitConfiguration.legacyCommonSiblingSafety, 'unsafe')
  const unsafePlan = legacyRollbackPlan(
    model, source, migrated.marker, migrated.record, unsafeInspection
  )
  assert.equal(unsafePlan.ok, true, JSON.stringify(unsafePlan))
  assert.equal(unsafePlan.plan.executable, false)
  assert.equal(unsafePlan.plan.git.configuration.conflictKind, 'siblingVisibilityRisk')

  fs.writeFileSync(siblingIgnore, safePatterns)
  const rollback = await approvedLegacyRollback(model, source, migrated.marker, migrated.record)
  assert.equal(rollback.plan.git.configuration.conflictKind, null)
  assert.notEqual(
    rollback.plan.git.configuration.siblingFactsDigest,
    unsafePlan.plan.git.configuration.siblingFactsDigest
  )
  const prepared = await model.adapter.prepareLegacyRollback({
    worktree: model.root,
    identity: model.identity,
    guard: lease,
    plan: rollback.plan,
    migration: migrated.record,
    snapshot: source.snapshot,
    runtimeAsset: source.runtimeAsset
  })
  const transactionRoot = gitPath(model.root, 'skill-graft/legacy-transactions')
  const transactionEntries = fs.readdirSync(transactionRoot)
  assert.equal(transactionEntries.length, 1)
  const journal = JSON.parse(fs.readFileSync(
    path.join(transactionRoot, transactionEntries[0], 'journal.json'), 'utf8'
  ))
  const lockableResources = journal.resources
    .filter((resource) => resource.before !== resource.after
      && ['gitIndex', 'worktreeConfig', 'commonInfoExclude'].includes(resource.kind))
    .sort((left, right) => Buffer.compare(Buffer.from(left.target), Buffer.from(right.target)))
  expectedLockCount = lockableResources.length
  finalLockResource = lockableResources.at(-1)?.kind ?? ''
  assert.ok(expectedLockCount > 0)
  assert.notEqual(finalLockResource, '')
  const commonBeforePublish = fs.readFileSync(commonExclude)
  armLockDrift = true
  await assert.rejects(
    prepared.participant.publish(lease),
    (error) => error?.code === 'LEGACY_PLAN_STALE'
  )
  armLockDrift = false
  assert.equal(completedLocks, expectedLockCount, 'sibling drift happens only after all Git locks are held')
  assert.deepEqual(fs.readFileSync(commonExclude), commonBeforePublish)
  assert.equal(fs.existsSync(`${commonExclude}.lock`), false)
  assert.equal(fs.existsSync(`${gitPath(model.root, 'config.worktree')}.lock`), false)
  assert.equal(fs.existsSync(`${gitPath(model.root, 'index')}.lock`), false)
  fs.writeFileSync(siblingIgnore, safePatterns)
  await prepared.participant.rollback(lease)
  await prepared.participant.finalize(lease)
})

test('legacy common-info foreign lock fails before any target or owned byte mutation', async (t) => {
  const model = fixture(t)
  const source = sources(model)
  const sourceOverride = path.join(model.legacySourceRoot, 'AGENTS.override.md')
  const targetOverride = path.join(model.root, 'AGENTS.override.md')
  fs.linkSync(sourceOverride, targetOverride)
  const commonExclude = gitPath(model.root, 'info/exclude')
  fs.appendFileSync(commonExclude, '/AGENTS.override.md\r\n')
  const originalCommon = fs.readFileSync(commonExclude)
  const { plan } = await approvedLegacyMigration(model, source)
  const prepared = await model.adapter.prepareLegacyMigration({
    worktree: model.root,
    identity: model.identity,
    guard: lease,
    plan,
    snapshot: source.snapshot,
    runtimeAsset: source.runtimeAsset
  })
  const before = fs.statSync(targetOverride)
  const foreignLock = `${commonExclude}.lock`
  const foreignBytes = Buffer.from('foreign legacy common lock\n', 'utf8')
  fs.writeFileSync(foreignLock, foreignBytes)
  await assert.rejects(
    prepared.participant.publish(lease),
    (error) => error?.code === 'LOCK_BUSY'
  )
  const after = fs.statSync(targetOverride)
  assert.equal(after.dev, before.dev)
  assert.equal(after.ino, before.ino)
  assert.deepEqual(fs.readFileSync(commonExclude), originalCommon)
  assert.deepEqual(fs.readFileSync(foreignLock), foreignBytes)
  assert.equal(fs.existsSync(gitPath(model.root, 'skill-graft/materialized-v1.json')), false)
  assert.equal(fs.readdirSync(gitPath(model.root, 'skill-graft/legacy-transactions')).length, 1)
  fs.unlinkSync(foreignLock)
  await prepared.participant.rollback(lease)
  await prepared.participant.finalize(lease)
})

test('legacy migration and rollback preserve tracked H-S-H index semantics', async (t) => {
  const model = fixture(t)
  const source = sources(model)
  const sourceOverride = path.join(model.legacySourceRoot, 'AGENTS.override.md')
  const targetOverride = path.join(model.root, 'AGENTS.override.md')
  fs.linkSync(sourceOverride, targetOverride)
  git(model.root, ['add', 'AGENTS.override.md'])
  git(model.root, ['commit', '--quiet', '-m', 'track legacy override'])
  assert.match(git(model.root, ['ls-files', '-v', '--', 'AGENTS.override.md']), /^H /)
  const migrationPlan = (await approvedLegacyMigration(model, source)).plan
  const migration = await model.adapter.prepareLegacyMigration({
    worktree: model.root,
    identity: model.identity,
    guard: lease,
    plan: migrationPlan,
    snapshot: source.snapshot,
    runtimeAsset: source.runtimeAsset
  })
  await migration.participant.publish(lease)
  assert.match(git(model.root, ['ls-files', '-v', '--', 'AGENTS.override.md']), /^S /)
  assert.equal(git(model.root, ['status', '--porcelain=v1', '--', 'AGENTS.override.md']), '')
  await migration.participant.finalize(lease)
  const rollbackPlan = (await approvedLegacyRollback(
    model, source, migration.marker, migration.record
  )).plan
  const rollback = await model.adapter.prepareLegacyRollback({
    worktree: model.root,
    identity: model.identity,
    guard: lease,
    plan: rollbackPlan,
    migration: migration.record,
    snapshot: source.snapshot,
    runtimeAsset: source.runtimeAsset
  })
  await rollback.participant.publish(lease)
  assert.match(git(model.root, ['ls-files', '-v', '--', 'AGENTS.override.md']), /^H /)
  assert.equal(git(model.root, ['status', '--porcelain=v1', '--', 'AGENTS.override.md']), '')
  assert.equal(fs.statSync(targetOverride).ino, fs.statSync(sourceOverride).ino)
  await rollback.participant.finalize(lease)
})

test('legacy inspection never auto-enables worktreeConfig', async (t) => {
  const model = fixture(t)
  const source = sources(model)
  fs.linkSync(
    path.join(model.legacySourceRoot, 'AGENTS.override.md'),
    path.join(model.root, 'AGENTS.override.md')
  )
  git(model.root, ['config', 'extensions.worktreeConfig', 'false'])
  const commonConfig = path.resolve(
    model.root, git(model.root, ['rev-parse', '--git-common-dir']).trim(), 'config'
  )
  const before = fs.readFileSync(commonConfig)
  const inspection = await inspect(model, source)
  assert.equal(inspection.gitConfiguration.worktreeConfigEnabled, false)
  const result = planLegacyMigration({
    pathKey: model.identity.pathKey,
    worktreeId: model.identity.worktreeId,
    stateRevision: 1,
    pin: pinFor(model, source.snapshot, ['ozdqp-development']),
    snapshot: source.snapshot,
    runtimeAsset: source.runtimeAsset,
    durableMarker: null,
    observedMarker: inspection.observedMarker,
    currentVisibilityState: inspection.currentVisibilityState,
    desiredVisibilityState: inspection.desiredVisibilityState,
    backupPrivateStateId: inspection.backupPrivateStateId,
    migrationRecord: null,
    artifacts: inspection.artifacts,
    gitFacts: inspection.gitFacts,
    gitConfiguration: inspection.gitConfiguration
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.plan.executable, false)
  assert.equal(result.plan.git.configuration.action, 'conflict')
  assert.equal(result.plan.git.configuration.conflictKind, 'unsupportedWorktreeConfig')
  assert.deepEqual(fs.readFileSync(commonConfig), before)
  assert.equal(fs.existsSync(gitPath(model.root, 'skill-graft/legacy-transactions')), false)
})

test('legacy prepare rechecks migration targets and rollback restore sources as trusted stale conflicts', async (t) => {
  await t.test('migration-target-drift', async (child) => {
    const model = fixture(child)
    const source = sources(model)
    const sourceOverride = path.join(model.legacySourceRoot, 'AGENTS.override.md')
    const targetOverride = path.join(model.root, 'AGENTS.override.md')
    fs.linkSync(sourceOverride, targetOverride)
    const plan = (await approvedLegacyMigration(model, source)).plan
    fs.unlinkSync(targetOverride)
    fs.writeFileSync(targetOverride, source.snapshotFiles['AGENTS.override.md'])
    await assert.rejects(model.adapter.prepareLegacyMigration({
      worktree: model.root,
      identity: model.identity,
      guard: lease,
      plan,
      snapshot: source.snapshot,
      runtimeAsset: source.runtimeAsset
    }), (error) => error?.code === 'LEGACY_PLAN_STALE')
    assert.equal(fs.lstatSync(targetOverride).nlink, 1)
    assert.equal(fs.existsSync(gitPath(model.root, 'skill-graft/legacy-transactions')), false)
    assert.equal(fs.existsSync(gitPath(
      model.root,
      `skill-graft/legacy-backups/${plan.migrationId.slice('sha256:'.length)}`
    )), false)
  })

  await t.test('rollback-source-drift', async (child) => {
    const model = fixture(child)
    const source = sources(model)
    const sourceOverride = path.join(model.legacySourceRoot, 'AGENTS.override.md')
    const targetOverride = path.join(model.root, 'AGENTS.override.md')
    fs.linkSync(sourceOverride, targetOverride)
    const migrationPlan = (await approvedLegacyMigration(model, source)).plan
    const migration = await model.adapter.prepareLegacyMigration({
      worktree: model.root,
      identity: model.identity,
      guard: lease,
      plan: migrationPlan,
      snapshot: source.snapshot,
      runtimeAsset: source.runtimeAsset
    })
    await migration.participant.publish(lease)
    await migration.participant.finalize(lease)
    const rollbackPlan = (await approvedLegacyRollback(
      model, source, migration.marker, migration.record
    )).plan
    fs.writeFileSync(sourceOverride, 'legacy source changed after approval\n')
    await assert.rejects(model.adapter.prepareLegacyRollback({
      worktree: model.root,
      identity: model.identity,
      guard: lease,
      plan: rollbackPlan,
      migration: migration.record,
      snapshot: source.snapshot,
      runtimeAsset: source.runtimeAsset
    }), (error) => error?.code === 'LEGACY_PLAN_STALE')
    assert.equal(fs.readFileSync(targetOverride, 'utf8'), source.snapshotFiles['AGENTS.override.md'])
    assert.equal(fs.readdirSync(gitPath(model.root, 'skill-graft/legacy-transactions')).length, 0)
    assert.deepEqual(JSON.parse(fs.readFileSync(
      gitPath(model.root, 'skill-graft/materialized-v1.json'), 'utf8'
    )), migration.marker)
  })
})

test('legacy recovery removes a newly published backup orphaned under a durable prepare claim', async (t) => {
  let armed = false
  let lost = false
  const model = fixture(t, {
    checkpoint(step) {
      if (armed && step === 'legacy-materializer-after-backup-published') lost = true
    }
  })
  const source = sources(model)
  const sourceOverride = path.join(model.legacySourceRoot, 'AGENTS.override.md')
  const targetOverride = path.join(model.root, 'AGENTS.override.md')
  fs.linkSync(sourceOverride, targetOverride)
  const plan = (await approvedLegacyMigration(model, source)).plan
  armed = true
  const losingGuard = {
    async revalidateLease() { if (lost) throw new LostLease() }
  }
  await assert.rejects(model.adapter.prepareLegacyMigration({
    worktree: model.root,
    identity: model.identity,
    guard: losingGuard,
    plan,
    snapshot: source.snapshot,
    runtimeAsset: source.runtimeAsset
  }), (error) => error?.code === 'LOCK_NOT_OWNED')
  assert.equal(lost, true)
  const backupRoot = gitPath(
    model.root,
    `skill-graft/legacy-backups/${plan.migrationId.slice('sha256:'.length)}`
  )
  const transactionRoot = gitPath(model.root, 'skill-graft/legacy-transactions')
  assert.equal(fs.existsSync(path.join(backupRoot, 'envelope.json')), true)
  assert.equal(fs.readdirSync(transactionRoot).length, 1)
  assert.equal(fs.readdirSync(transactionRoot)[0].startsWith('.prepare-'), true)
  assert.equal(fs.statSync(targetOverride).ino, fs.statSync(sourceOverride).ino)
  armed = false
  lost = false
  assert.deepEqual(await model.adapter.recover({
    worktree: model.root,
    identity: model.identity,
    durable: null,
    guard: lease,
    pin: pinFor(model, source.snapshot, ['ozdqp-development'], null),
    stateRevision: 1
  }), { status: 'rolled-back', recoveredTransactions: 1 })
  assert.equal(fs.existsSync(backupRoot), false)
  assert.equal(fs.readdirSync(transactionRoot).length, 0)
  assert.equal(fs.statSync(targetOverride).ino, fs.statSync(sourceOverride).ino)
})

test('legacy abort keeps its claim when backup cleanup loses the lease and recovery resumes safely', async (t) => {
  let armed = false
  let cleanupLost = false
  const model = fixture(t, {
    checkpoint(step) {
      if (!armed) return
      if (step === 'legacy-materializer-after-backup-published') {
        throw new Error('fixture abort after durable backup publication')
      }
      if (step === 'legacy-materializer-before-aborted-backup-cleanup') cleanupLost = true
    }
  })
  const source = sources(model)
  const sourceOverride = path.join(model.legacySourceRoot, 'AGENTS.override.md')
  const targetOverride = path.join(model.root, 'AGENTS.override.md')
  fs.linkSync(sourceOverride, targetOverride)
  const plan = (await approvedLegacyMigration(model, source)).plan
  armed = true
  await assert.rejects(model.adapter.prepareLegacyMigration({
    worktree: model.root,
    identity: model.identity,
    guard: { async revalidateLease() { if (cleanupLost) throw new LostLease() } },
    plan,
    snapshot: source.snapshot,
    runtimeAsset: source.runtimeAsset
  }), (error) => error?.code === 'LOCK_NOT_OWNED')
  const backupRoot = gitPath(
    model.root,
    `skill-graft/legacy-backups/${plan.migrationId.slice('sha256:'.length)}`
  )
  const transactionRoot = gitPath(model.root, 'skill-graft/legacy-transactions')
  assert.equal(cleanupLost, true)
  assert.equal(fs.existsSync(path.join(backupRoot, 'envelope.json')), true)
  assert.equal(fs.readdirSync(transactionRoot).length, 1, 'durable claim must outlive backup cleanup loss')
  assert.equal(fs.readdirSync(transactionRoot)[0].startsWith('.prepare-'), true)
  armed = false
  cleanupLost = false
  assert.deepEqual(await model.adapter.recover({
    worktree: model.root,
    identity: model.identity,
    durable: null,
    guard: lease,
    pin: pinFor(model, source.snapshot, ['ozdqp-development'], null),
    stateRevision: 1
  }), { status: 'rolled-back', recoveredTransactions: 1 })
  assert.equal(fs.existsSync(backupRoot), false)
  assert.equal(fs.readdirSync(transactionRoot).length, 0)
  assert.equal(fs.statSync(targetOverride).ino, fs.statSync(sourceOverride).ino)
})

test('legacy abort resumes a partially deleted backup tombstone after post-unlink lease loss', async (t) => {
  let armed = false
  let deletionLost = false
  let backupsRoot = ''
  const model = fixture(t, {
    checkpoint(step) {
      if (armed && step === 'legacy-materializer-after-backup-published') {
        throw new Error('fixture abort before backup cleanup tombstone')
      }
    }
  })
  const source = sources(model)
  const sourceOverride = path.join(model.legacySourceRoot, 'AGENTS.override.md')
  const targetOverride = path.join(model.root, 'AGENTS.override.md')
  fs.linkSync(sourceOverride, targetOverride)
  const plan = (await approvedLegacyMigration(model, source)).plan
  backupsRoot = gitPath(model.root, 'skill-graft/legacy-backups')
  const losingGuard = {
    async revalidateLease() {
      if (!armed || !fs.existsSync(backupsRoot)) return
      const tombstoneName = fs.readdirSync(backupsRoot).find((name) => name.startsWith('.abort-'))
      if (tombstoneName
        && !fs.existsSync(path.join(backupsRoot, tombstoneName, 'envelope.json'))) {
        deletionLost = true
        throw new LostLease()
      }
    }
  }
  armed = true
  await assert.rejects(model.adapter.prepareLegacyMigration({
    worktree: model.root,
    identity: model.identity,
    guard: losingGuard,
    plan,
    snapshot: source.snapshot,
    runtimeAsset: source.runtimeAsset
  }), (error) => error?.code === 'LOCK_NOT_OWNED')
  const transactionRoot = gitPath(model.root, 'skill-graft/legacy-transactions')
  const finalBackup = path.join(backupsRoot, plan.migrationId.slice('sha256:'.length))
  const tombstones = fs.readdirSync(backupsRoot).filter((name) => name.startsWith('.abort-'))
  assert.equal(deletionLost, true)
  assert.equal(fs.existsSync(finalBackup), false)
  assert.equal(tombstones.length, 1)
  assert.equal(fs.existsSync(path.join(backupsRoot, tombstones[0], 'envelope.json')), false)
  assert.equal(fs.readdirSync(transactionRoot).length, 1)
  armed = false
  deletionLost = false
  assert.deepEqual(await model.adapter.recover({
    worktree: model.root,
    identity: model.identity,
    durable: null,
    guard: lease,
    pin: pinFor(model, source.snapshot, ['ozdqp-development'], null),
    stateRevision: 1
  }), { status: 'rolled-back', recoveredTransactions: 1 })
  assert.equal(fs.readdirSync(backupsRoot).length, 0)
  assert.equal(fs.readdirSync(transactionRoot).length, 0)
  assert.equal(fs.statSync(targetOverride).ino, fs.statSync(sourceOverride).ino)
})

test('legacy orphan abort tombstones fail closed before recovery or new preparation mutations', async (t) => {
  await t.test('recovery-preflight', async (child) => {
    const model = fixture(child)
    const source = sources(model)
    const sourceOverride = path.join(model.legacySourceRoot, 'AGENTS.override.md')
    const targetOverride = path.join(model.root, 'AGENTS.override.md')
    fs.linkSync(sourceOverride, targetOverride)
    const plan = (await approvedLegacyMigration(model, source)).plan
    await model.adapter.prepareLegacyMigration({
      worktree: model.root,
      identity: model.identity,
      guard: lease,
      plan,
      snapshot: source.snapshot,
      runtimeAsset: source.runtimeAsset
    })
    const backupsRoot = gitPath(model.root, 'skill-graft/legacy-backups')
    const transactionRoot = gitPath(model.root, 'skill-graft/legacy-transactions')
    const canonicalBackup = path.join(backupsRoot, plan.migrationId.slice('sha256:'.length))
    const canonicalEnvelope = fs.readFileSync(path.join(canonicalBackup, 'envelope.json'))
    const orphan = path.join(
      backupsRoot,
      `.abort-${sha('orphan-abort').slice('sha256:'.length)}-legacy-orphan-0000000000000001`
    )
    const backupPrepare = path.join(
      backupsRoot,
      `.prepare-${sha('orphan-temp').slice('sha256:'.length)}-0123456789abcdef`
    )
    fs.mkdirSync(orphan)
    fs.mkdirSync(backupPrepare)
    fs.writeFileSync(path.join(backupPrepare, 'proof.bin'), 'must-remain-before-preflight-reject')
    const transactionsBefore = fs.readdirSync(transactionRoot)
    await assert.rejects(model.adapter.recover({
      worktree: model.root,
      identity: model.identity,
      durable: null,
      guard: lease,
      pin: pinFor(model, source.snapshot, ['ozdqp-development'], null),
      stateRevision: 1
    }), (error) => error?.code === 'STATE_CORRUPT')
    assert.deepEqual(fs.readdirSync(transactionRoot), transactionsBefore)
    assert.deepEqual(fs.readFileSync(path.join(canonicalBackup, 'envelope.json')), canonicalEnvelope)
    assert.equal(fs.readFileSync(path.join(backupPrepare, 'proof.bin'), 'utf8'),
      'must-remain-before-preflight-reject')
    assert.equal(fs.existsSync(orphan), true)
    assert.equal(fs.statSync(targetOverride).ino, fs.statSync(sourceOverride).ino)
  })

  await t.test('prepare-gate', async (child) => {
    const model = fixture(child)
    const source = sources(model)
    const sourceOverride = path.join(model.legacySourceRoot, 'AGENTS.override.md')
    const targetOverride = path.join(model.root, 'AGENTS.override.md')
    fs.linkSync(sourceOverride, targetOverride)
    const plan = (await approvedLegacyMigration(model, source)).plan
    const backupsRoot = gitPath(model.root, 'skill-graft/legacy-backups')
    fs.mkdirSync(backupsRoot, { recursive: true })
    const orphan = path.join(
      backupsRoot,
      `.abort-${sha('prepare-gate-orphan').slice('sha256:'.length)}-legacy-orphan-0000000000000002`
    )
    fs.mkdirSync(orphan)
    await assert.rejects(model.adapter.prepareLegacyMigration({
      worktree: model.root,
      identity: model.identity,
      guard: lease,
      plan,
      snapshot: source.snapshot,
      runtimeAsset: source.runtimeAsset
    }), (error) => error?.code === 'STATE_CORRUPT')
    assert.equal(fs.existsSync(gitPath(model.root, 'skill-graft/legacy-transactions')), false)
    assert.deepEqual(fs.readdirSync(backupsRoot), [path.basename(orphan)])
    assert.equal(fs.statSync(targetOverride).ino, fs.statSync(sourceOverride).ino)
  })
})

test('legacy recovery cleans a durable prepare claim written before backup publication', async (t) => {
  let armed = false
  let lost = false
  const model = fixture(t, {
    checkpoint(step) {
      if (armed && step === 'legacy-materializer-after-prepare-claim') lost = true
    }
  })
  const source = sources(model)
  const sourceOverride = path.join(model.legacySourceRoot, 'AGENTS.override.md')
  const targetOverride = path.join(model.root, 'AGENTS.override.md')
  fs.linkSync(sourceOverride, targetOverride)
  const plan = (await approvedLegacyMigration(model, source)).plan
  armed = true
  await assert.rejects(model.adapter.prepareLegacyMigration({
    worktree: model.root,
    identity: model.identity,
    guard: { async revalidateLease() { if (lost) throw new LostLease() } },
    plan,
    snapshot: source.snapshot,
    runtimeAsset: source.runtimeAsset
  }), (error) => error?.code === 'LOCK_NOT_OWNED')
  const backupRoot = gitPath(
    model.root,
    `skill-graft/legacy-backups/${plan.migrationId.slice('sha256:'.length)}`
  )
  const transactionRoot = gitPath(model.root, 'skill-graft/legacy-transactions')
  assert.equal(fs.existsSync(backupRoot), false)
  assert.equal(fs.readdirSync(transactionRoot).length, 1)
  armed = false
  lost = false
  assert.deepEqual(await model.adapter.recover({
    worktree: model.root,
    identity: model.identity,
    durable: null,
    guard: lease,
    pin: pinFor(model, source.snapshot, ['ozdqp-development'], null),
    stateRevision: 1
  }), { status: 'rolled-back', recoveredTransactions: 1 })
  assert.equal(fs.readdirSync(transactionRoot).length, 0)
  assert.equal(fs.existsSync(backupRoot), false)
  assert.equal(fs.statSync(targetOverride).ino, fs.statSync(sourceOverride).ino)
})

test('legacy recovery retains its permanent backup after the journal commit cut', async (t) => {
  let armed = false
  const model = fixture(t, {
    checkpoint(step) {
      if (armed && step === 'legacy-materializer-prepared') throw new LostLease()
    }
  })
  const source = sources(model)
  const sourceOverride = path.join(model.legacySourceRoot, 'AGENTS.override.md')
  const targetOverride = path.join(model.root, 'AGENTS.override.md')
  fs.linkSync(sourceOverride, targetOverride)
  const plan = (await approvedLegacyMigration(model, source)).plan
  armed = true
  await assert.rejects(model.adapter.prepareLegacyMigration({
    worktree: model.root,
    identity: model.identity,
    guard: lease,
    plan,
    snapshot: source.snapshot,
    runtimeAsset: source.runtimeAsset
  }), (error) => error?.code === 'LOCK_NOT_OWNED')
  const backupRoot = gitPath(
    model.root,
    `skill-graft/legacy-backups/${plan.migrationId.slice('sha256:'.length)}`
  )
  const transactionRoot = gitPath(model.root, 'skill-graft/legacy-transactions')
  assert.equal(fs.existsSync(path.join(backupRoot, 'envelope.json')), true)
  const transactions = fs.readdirSync(transactionRoot)
  assert.equal(transactions.length, 1)
  assert.equal(transactions[0].startsWith('.prepare-'), false)
  assert.equal(fs.existsSync(path.join(transactionRoot, transactions[0], 'journal.json')), true)
  assert.equal(fs.statSync(targetOverride).ino, fs.statSync(sourceOverride).ino)
  armed = false
  assert.deepEqual(await model.adapter.recover({
    worktree: model.root,
    identity: model.identity,
    durable: null,
    guard: lease,
    pin: pinFor(model, source.snapshot, ['ozdqp-development'], null),
    stateRevision: 1
  }), { status: 'rolled-back', recoveredTransactions: 1 })
  assert.equal(fs.existsSync(backupRoot), false)
  assert.equal(fs.readdirSync(transactionRoot).length, 0)
  assert.equal(fs.statSync(targetOverride).ino, fs.statSync(sourceOverride).ino)
})

test('legacy prepare-claim substitution is rejected before deleting any backup', async (t) => {
  let armed = false
  let lost = false
  const model = fixture(t, {
    checkpoint(step) {
      if (armed && step === 'legacy-materializer-after-backup-published') lost = true
    }
  })
  const source = sources(model)
  const sourceOverride = path.join(model.legacySourceRoot, 'AGENTS.override.md')
  const targetOverride = path.join(model.root, 'AGENTS.override.md')
  fs.linkSync(sourceOverride, targetOverride)
  const plan = (await approvedLegacyMigration(model, source)).plan
  armed = true
  await assert.rejects(model.adapter.prepareLegacyMigration({
    worktree: model.root,
    identity: model.identity,
    guard: { async revalidateLease() { if (lost) throw new LostLease() } },
    plan,
    snapshot: source.snapshot,
    runtimeAsset: source.runtimeAsset
  }), (error) => error?.code === 'LOCK_NOT_OWNED')
  armed = false
  lost = false
  const backupRoot = gitPath(
    model.root,
    `skill-graft/legacy-backups/${plan.migrationId.slice('sha256:'.length)}`
  )
  const victimId = sha('legacy-prepare-claim-substitution-victim')
  const victimRoot = gitPath(
    model.root,
    `skill-graft/legacy-backups/${victimId.slice('sha256:'.length)}`
  )
  fs.cpSync(backupRoot, victimRoot, { recursive: true, errorOnExist: true })
  const transactionRoot = gitPath(model.root, 'skill-graft/legacy-transactions')
  const prepareRoot = path.join(transactionRoot, fs.readdirSync(transactionRoot)[0])
  const claimPath = path.join(prepareRoot, 'prepare.json')
  const claim = JSON.parse(fs.readFileSync(claimPath, 'utf8'))
  claim.migrationId = victimId
  fs.writeFileSync(claimPath, `${JSON.stringify(claim)}\n`)
  const victimEnvelope = fs.readFileSync(path.join(victimRoot, 'envelope.json'))
  await assert.rejects(model.adapter.recover({
    worktree: model.root,
    identity: model.identity,
    durable: null,
    guard: lease,
    pin: pinFor(model, source.snapshot, ['ozdqp-development'], null),
    stateRevision: 1
  }), (error) => error?.code === 'STATE_CORRUPT')
  assert.deepEqual(fs.readFileSync(path.join(victimRoot, 'envelope.json')), victimEnvelope)
  assert.equal(fs.existsSync(backupRoot), true)
  assert.equal(fs.existsSync(prepareRoot), true)
  assert.equal(fs.statSync(targetOverride).ino, fs.statSync(sourceOverride).ino)
})
