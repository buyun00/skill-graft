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
  createVisibilityOwnershipState,
  planMaterialization
} from '../dist/core/index.js'
import { ApplicationTransactionErrorBase } from '../dist/application/transaction-port.js'

function sha(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function git(cwd, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')))
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024, env
  })
  assert.equal(result.status, 0, String(result.stderr || result.stdout))
  return String(result.stdout || '')
}

function gitProbe(cwd, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')))
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024, env
  })
  return {
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || '')
  }
}

function gitStatusFor(cwd, targetRelativePath) {
  return git(cwd, ['status', '--porcelain=v1', '--untracked-files=all', '--', targetRelativePath])
}

function gitIgnored(cwd, targetRelativePath) {
  const result = gitProbe(cwd, ['check-ignore', '--no-index', '-q', '--', targetRelativePath])
  assert.ok(result.status === 0 || result.status === 1, result.stderr || result.stdout)
  return result.status === 0
}

function gitPath(cwd, relative) {
  return path.resolve(cwd, git(cwd, ['rev-parse', '--git-path', relative]).trim())
}

function file(path, bytes, mode = '100644') {
  return { path, size: Buffer.byteLength(bytes), sha256: sha(bytes), mode, isReparsePoint: false }
}

function manifest(files, revision) {
  const created = createLibrarySnapshotManifest({
    source: { kind: 'library', id: 'materializer-test', revision },
    createdAt: '2035-01-02T03:04:05.000Z',
    files: Object.entries(files).map(([name, bytes]) => file(name, bytes))
  })
  assert.equal(created.ok, true, JSON.stringify(created))
  return created.manifest
}

function runtime(files, revision = 'runtime-r1') {
  const created = createRuntimeAssetManifest({
    runtimeRevision: revision,
    files: Object.entries(files).map(([name, bytes]) => file(name, bytes))
  })
  assert.equal(created.ok, true, JSON.stringify(created))
  return created.manifest
}

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-materializer-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const packageRoot = `${root}-package`
  const dataRoot = `${root}-data`
  fs.mkdirSync(path.join(packageRoot, 'overlay', 'hooks'), { recursive: true })
  fs.mkdirSync(dataRoot, { recursive: true })
  t.after(() => fs.rmSync(packageRoot, { recursive: true, force: true }))
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }))
  git(root, ['init', '--quiet'])
  git(root, ['config', 'user.email', 'fixture@example.invalid'])
  git(root, ['config', 'user.name', 'Fixture'])
  git(root, ['config', 'extensions.worktreeConfig', 'true'])
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'project-owned\n')
  fs.mkdirSync(path.join(root, '.agents', 'skills', 'unity-skills'), { recursive: true })
  fs.writeFileSync(path.join(root, '.agents', 'skills', 'unity-skills', 'SKILL.md'), 'unity-owned\n')
  git(root, ['add', 'AGENTS.md', '.agents/skills/unity-skills/SKILL.md'])
  git(root, ['commit', '--quiet', '-m', 'fixture'])

  const identity = { pathKey: sha(path.resolve(root).toLowerCase()), worktreeId: 'worktree:materializer-test' }
  const identitiesByPath = new Map([[path.resolve(root).toLowerCase(), identity]])
  const identityResolutions = new Map()
  const snapshots = new Map()
  const runtimeAssets = new Map()
  const identities = { async resolve(candidate) {
    const key = path.resolve(candidate).toLowerCase()
    identityResolutions.set(key, (identityResolutions.get(key) ?? 0) + 1)
    const found = identitiesByPath.get(key)
    assert.ok(found, `unknown fixture identity: ${candidate}`)
    return found
  } }
  const snapshotContent = { async readVerifiedFile(input) {
    const entry = snapshots.get(input.snapshotId)?.get(input.path)
    if (!entry) return null
    assert.equal(Buffer.byteLength(entry), input.expectedSize)
    assert.equal(sha(entry), input.expectedSha256)
    return Buffer.from(entry)
  } }
  const runtimePort = {
    current: null,
    async observe() { return this.current },
    async readVerifiedFile(input) {
      const entry = runtimeAssets.get(input.runtimeAssetId)?.get(input.path)
      if (!entry) return null
      assert.equal(Buffer.byteLength(entry), input.expectedSize)
      assert.equal(sha(entry), input.expectedSha256)
      return Buffer.from(entry)
    }
  }
  const adapter = createLocalMaterializer({
    packageRoot,
    dataRoot,
    identities,
    snapshots: snapshotContent,
    runtimeAssets: runtimePort,
    checkpoint: options.checkpoint,
    limits: options.limits,
    token: (() => { let sequence = 0; return () => `fixture-${String(++sequence).padStart(16, '0')}` })()
  })
  return {
    root, packageRoot, dataRoot, identity, adapter, runtimePort,
    registerIdentity(candidate, value) { identitiesByPath.set(path.resolve(candidate).toLowerCase(), value) },
    identityResolutionCount(candidate) { return identityResolutions.get(path.resolve(candidate).toLowerCase()) ?? 0 },
    registerSnapshot(value, files) { snapshots.set(value.snapshotId, new Map(Object.entries(files))) },
    registerRuntime(value, files) { runtimeAssets.set(value.runtimeAssetId, new Map(Object.entries(files))); runtimePort.current = value }
  }
}

async function approvedPlan(model, snapshot, runtimeAsset, selectedSkills, durable, materializedSnapshot = null, revision = 1) {
  const inspection = await model.adapter.inspect({
    worktree: model.root,
    identity: model.identity,
    snapshot,
    runtimeAsset,
    selectedSkills
  })
  const result = planMaterialization({
    pathKey: model.identity.pathKey,
    worktreeId: model.identity.worktreeId,
    stateRevision: revision,
    pin: pinFor(model, snapshot, selectedSkills, materializedSnapshot),
    snapshot,
    runtimeAsset,
    durableMarker: durable,
    observedMarker: inspection.observedMarker,
    currentVisibilityState: inspection.currentVisibilityState,
    desiredVisibilityState: inspection.desiredVisibilityState,
    observations: inspection.observations,
    gitFacts: inspection.gitFacts,
    gitConfiguration: inspection.gitConfiguration
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.plan.executable, true, JSON.stringify(result.plan))
  return result.plan
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

const lease = { async revalidateLease() {} }

class LostLease extends ApplicationTransactionErrorBase {
  code = 'LOCK_NOT_OWNED'
  retryable = true
  constructor() { super('fixture lease lost') }
}

const gitLockCutPoints = [
  'materializer-after-git-lock-target-parent-pre-fsync',
  'materializer-after-git-lock-placeholder-open',
  'materializer-after-git-lock-placeholder-write',
  'materializer-after-git-lock-placeholder-fsync',
  'materializer-after-git-lock-placeholder-parent-fsync',
  'materializer-after-git-lock-link',
  'materializer-after-git-lock-target-parent-fsync',
  'materializer-after-git-lock-placeholder-unlink',
  'materializer-after-git-lock-placeholder-unlink-parent-fsync'
]

const rollbackPhaseCutPoints = [
  'materializer-after-marker-retraction-phase',
  'materializer-after-create-rollback-phase',
  'materializer-after-git-visibility-rollback-phase',
  'materializer-after-update-delete-rollback-phase',
  'materializer-after-visibility-sidecar-rollback-phase',
  'materializer-after-old-marker-rollback-phase'
]

test('copy materializer publishes exact copies and durable-new recovery finalizes without touching protected files', async (t) => {
  const model = fixture(t)
  const snapshotFiles = {
    'AGENTS.override.md': 'override-v1\n',
    'skills/ozdqp-development/SKILL.md': 'development-v1\n',
    'skills/ozdqp-development/references/rules.md': 'rules-v1\n'
  }
  const runtimeFiles = { 'HubLib.ps1': 'hub-lib-v1\n', 'hooks/post-checkout': 'hook-v1\n' }
  const snapshot = manifest(snapshotFiles, 'library-r1')
  const runtimeAsset = runtime(runtimeFiles)
  model.registerSnapshot(snapshot, snapshotFiles)
  model.registerRuntime(runtimeAsset, runtimeFiles)

  const plan = await approvedPlan(model, snapshot, runtimeAsset, ['ozdqp-development'], null)
  assert.deepEqual(plan.summary, { create: 3, update: 0, delete: 0, keep: 0, conflict: 0 })
  const prepared = await model.adapter.prepare({ worktree: model.root, identity: model.identity, guard: lease, plan, snapshot, runtimeAsset })
  assert.equal(fs.existsSync(path.join(model.root, 'AGENTS.override.md')), false, 'prepare is target-zero-write')
  const transactionRoot = fs.readdirSync(gitPath(model.root, 'skill-graft/transactions'))
    .map((name) => path.join(gitPath(model.root, 'skill-graft/transactions'), name))
    .find((candidate) => !path.basename(candidate).startsWith('.'))
  const journal = JSON.parse(fs.readFileSync(path.join(transactionRoot, 'journal.json'), 'utf8'))
  const resourceKinds = journal.resources.map((resource) => resource.kind)
  assert.deepEqual(resourceKinds, [
    'privateExclude', 'worktreeConfig', 'gitIndex',
    'visibilityPrivate', 'visibilityState', 'marker'
  ])
  assert.match(journal.siblingConfigDigest, /^sha256:[0-9a-f]{64}$/)
  assert.equal(journal.resources[2].disposition, 'keep')
  assert.equal(journal.resources[2].stageName, null)
  assert.equal(journal.resources[2].backupName, null)
  assert.equal(journal.resources.some((resource) => resource.kind === 'commonConfig'), false)
  assert.ok(resourceKinds.indexOf('visibilityPrivate') < resourceKinds.indexOf('visibilityState'))
  assert.ok(resourceKinds.indexOf('visibilityState') < resourceKinds.indexOf('marker'))
  assert.equal(resourceKinds.at(-1), 'marker', 'marker is the final publication resource')
  const keptIndexLock = `${gitPath(model.root, 'index')}.lock`
  fs.writeFileSync(keptIndexLock, 'foreign lock for kept index\n')
  await prepared.participant.publish(lease)
  assert.equal(fs.readFileSync(keptIndexLock, 'utf8'), 'foreign lock for kept index\n')
  fs.unlinkSync(keptIndexLock)
  assert.equal(fs.readFileSync(path.join(model.root, 'AGENTS.override.md'), 'utf8'), 'override-v1\n')
  assert.equal(fs.readFileSync(path.join(model.root, '.agents', 'skills', 'ozdqp-development', 'references', 'rules.md'), 'utf8'), 'rules-v1\n')
  assert.equal(fs.readFileSync(path.join(model.root, '.codex', 'local-overlay', 'HubLib.ps1'), 'utf8'), 'hub-lib-v1\n')
  assert.equal(fs.readFileSync(path.join(model.root, 'AGENTS.md'), 'utf8'), 'project-owned\n')
  assert.equal(fs.readFileSync(path.join(model.root, '.agents', 'skills', 'unity-skills', 'SKILL.md'), 'utf8'), 'unity-owned\n')
  const visibilityHex = prepared.marker.visibilityStateId.slice('sha256:'.length)
  const sharedVisibilityPath = gitPath(model.root, `skill-graft/visibility/${visibilityHex}.json`)
  const privateVisibilityPath = gitPath(model.root, `skill-graft/visibility-private/${visibilityHex}.json`)
  const sharedVisibility = JSON.parse(fs.readFileSync(
    sharedVisibilityPath, 'utf8'
  ))
  const privateVisibility = JSON.parse(fs.readFileSync(
    privateVisibilityPath, 'utf8'
  ))
  assert.equal(sharedVisibility.visibilityStateId, prepared.marker.visibilityStateId)
  assert.equal(privateVisibility.visibilityStateId, prepared.marker.visibilityStateId)
  assert.equal(sharedVisibility.privateStateId, privateVisibility.privateStateId)
  assert.equal(JSON.stringify(sharedVisibility).includes(privateVisibility.baseExclude.locator), false)

  const durable = { schemaVersion: 1, pathKey: model.identity.pathKey, marker: prepared.marker }
  const recovered = await model.adapter.recover({
    worktree: model.root, identity: model.identity, durable, guard: lease,
    pin: pinFor(model, snapshot, ['ozdqp-development'], snapshot.snapshotId), stateRevision: 2
  })
  assert.deepEqual(recovered, { status: 'finalized', recoveredTransactions: 1 })
  assert.deepEqual(await model.adapter.recover({
    worktree: model.root, identity: model.identity, durable, guard: lease,
    pin: pinFor(model, snapshot, ['ozdqp-development'], snapshot.snapshotId), stateRevision: 2
  }), {
    status: 'clean', recoveredTransactions: 0
  })
  const tamperedPrivate = structuredClone(privateVisibility)
  tamperedPrivate.baseExclude.exists = !tamperedPrivate.baseExclude.exists
  fs.writeFileSync(privateVisibilityPath, `${JSON.stringify(tamperedPrivate, null, 2)}\n`)
  await assert.rejects(model.adapter.recover({
    worktree: model.root, identity: model.identity, durable, guard: lease,
    pin: pinFor(model, snapshot, ['ozdqp-development'], snapshot.snapshotId), stateRevision: 2
  }), (error) => error?.code === 'STATE_CORRUPT')
  fs.writeFileSync(privateVisibilityPath, `${JSON.stringify(privateVisibility, null, 2)}\n`)
  fs.writeFileSync(
    sharedVisibilityPath,
    '{"schemaVersion":1}\n'
  )
  await assert.rejects(model.adapter.recover({
    worktree: model.root, identity: model.identity, durable, guard: lease,
    pin: pinFor(model, snapshot, ['ozdqp-development'], snapshot.snapshotId), stateRevision: 2
  }), (error) => error?.code === 'STATE_CORRUPT')
})

test('recovery rejects a valid ownership state whose targets do not equal marker artifacts', async (t) => {
  const model = fixture(t)
  const snapshotFiles = { 'AGENTS.override.md': 'target-binding\n' }
  const runtimeFiles = { 'HubLib.ps1': 'target-binding-runtime\n' }
  const snapshot = manifest(snapshotFiles, 'library-target-binding')
  const runtimeAsset = runtime(runtimeFiles, 'runtime-target-binding')
  model.registerSnapshot(snapshot, snapshotFiles)
  model.registerRuntime(runtimeAsset, runtimeFiles)
  const plan = await approvedPlan(model, snapshot, runtimeAsset, [], null)
  const prepared = await model.adapter.prepare({
    worktree: model.root, identity: model.identity, guard: lease, plan, snapshot, runtimeAsset
  })
  await prepared.participant.publish(lease)
  await prepared.participant.finalize(lease)

  const oldHex = prepared.marker.visibilityStateId.slice('sha256:'.length)
  const state = JSON.parse(fs.readFileSync(gitPath(
    model.root, `skill-graft/visibility/${oldHex}.json`
  ), 'utf8'))
  const privateState = JSON.parse(fs.readFileSync(gitPath(
    model.root, `skill-graft/visibility-private/${oldHex}.json`
  ), 'utf8'))
  assert.ok(state.targets.length > 0)
  const mismatched = createVisibilityOwnershipState({
    privateStateId: state.privateStateId,
    pathKey: state.pathKey,
    worktreeId: state.worktreeId,
    baseExclude: state.baseExclude,
    targets: state.targets.slice(0, -1)
  })
  assert.equal(mismatched.ok, true, JSON.stringify(mismatched))
  const mismatchedHex = mismatched.state.visibilityStateId.slice('sha256:'.length)
  fs.writeFileSync(
    gitPath(model.root, `skill-graft/visibility/${mismatchedHex}.json`),
    `${JSON.stringify(mismatched.state, null, 2)}\n`
  )
  fs.writeFileSync(
    gitPath(model.root, `skill-graft/visibility-private/${mismatchedHex}.json`),
    `${JSON.stringify({ ...privateState, visibilityStateId: mismatched.state.visibilityStateId }, null, 2)}\n`
  )
  const marker = { ...prepared.marker, visibilityStateId: mismatched.state.visibilityStateId }
  fs.writeFileSync(gitPath(model.root, 'skill-graft/materialized-v1.json'), `${JSON.stringify(marker, null, 2)}\n`)
  await assert.rejects(model.adapter.recover({
    worktree: model.root,
    identity: model.identity,
    durable: { schemaVersion: 1, pathKey: model.identity.pathKey, marker },
    guard: lease,
    pin: pinFor(model, snapshot, [], snapshot.snapshotId),
    stateRevision: 2
  }), (error) => error?.code === 'STATE_CORRUPT')
})

test('publish rollback and durable-old recovery restore update/delete/create and their marker', async (t) => {
  const model = fixture(t)
  const runtimeFiles = { 'HubLib.ps1': 'hub-lib-v1\n' }
  const runtimeAsset = runtime(runtimeFiles)
  model.registerRuntime(runtimeAsset, runtimeFiles)
  const firstFiles = {
    'AGENTS.override.md': 'override-v1\n',
    'skills/ozdqp-development/SKILL.md': 'development-v1\n'
  }
  const first = manifest(firstFiles, 'library-r1')
  model.registerSnapshot(first, firstFiles)
  const firstPlan = await approvedPlan(model, first, runtimeAsset, ['ozdqp-development'], null)
  const firstPrepared = await model.adapter.prepare({ worktree: model.root, identity: model.identity, guard: lease, plan: firstPlan, snapshot: first, runtimeAsset })
  await firstPrepared.participant.publish(lease)
  await firstPrepared.participant.finalize(lease)
  const oldDurable = { schemaVersion: 1, pathKey: model.identity.pathKey, marker: firstPrepared.marker }
  git(model.root, ['add', '-f', 'AGENTS.override.md'])
  git(model.root, ['commit', '--quiet', '-m', 'track controlled target for index fencing'])

  const secondFiles = { 'AGENTS.override.md': 'override-v2\n' }
  const second = manifest(secondFiles, 'library-r2')
  model.registerSnapshot(second, secondFiles)
  const secondPlan = await approvedPlan(model, second, runtimeAsset, [], oldDurable, first.snapshotId, 2)
  assert.equal(secondPlan.summary.update, 1)
  assert.equal(secondPlan.summary.delete, 1)
  const secondPrepared = await model.adapter.prepare({ worktree: model.root, identity: model.identity, guard: lease, plan: secondPlan, snapshot: second, runtimeAsset })
  const index = path.resolve(model.root, git(model.root, ['rev-parse', '--git-path', 'index']).trim())
  fs.writeFileSync(`${index}.lock`, 'foreign git process\n')
  await assert.rejects(secondPrepared.participant.publish(lease), (error) => error?.code === 'LOCK_BUSY')
  assert.equal(fs.readFileSync(path.join(model.root, 'AGENTS.override.md'), 'utf8'), 'override-v1\n')
  fs.unlinkSync(`${index}.lock`)
  await secondPrepared.participant.publish(lease)
  assert.equal(fs.readFileSync(path.join(model.root, 'AGENTS.override.md'), 'utf8'), 'override-v2\n')
  assert.equal(fs.existsSync(path.join(model.root, '.agents', 'skills', 'ozdqp-development')), false)
  await secondPrepared.participant.rollback(lease)
  assert.equal(fs.readFileSync(path.join(model.root, 'AGENTS.override.md'), 'utf8'), 'override-v1\n')
  assert.equal(fs.readFileSync(path.join(model.root, '.agents', 'skills', 'ozdqp-development', 'SKILL.md'), 'utf8'), 'development-v1\n')
  await secondPrepared.participant.finalize(lease)

  const retryPlan = await approvedPlan(model, second, runtimeAsset, [], oldDurable, first.snapshotId, 2)
  const crash = await model.adapter.prepare({ worktree: model.root, identity: model.identity, guard: lease, plan: retryPlan, snapshot: second, runtimeAsset })
  await crash.participant.publish(lease)
  const recovered = await model.adapter.recover({
    worktree: model.root, identity: model.identity, durable: oldDurable, guard: lease,
    pin: pinFor(model, first, ['ozdqp-development'], first.snapshotId), stateRevision: 2
  })
  assert.deepEqual(recovered, { status: 'rolled-back', recoveredTransactions: 1 })
  assert.equal(fs.readFileSync(path.join(model.root, 'AGENTS.override.md'), 'utf8'), 'override-v1\n')
  assert.equal(fs.readFileSync(path.join(model.root, '.agents', 'skills', 'ozdqp-development', 'SKILL.md'), 'utf8'), 'development-v1\n')
})

test('resource publication and rollback preserve private-exclude before worktree-config ordering', async (t) => {
  const publishOrder = []
  const rollbackOrder = []
  let privateExclude
  let worktreeConfig
  const model = fixture(t, {
    checkpoint(step, facts) {
      if (step === 'materializer-before-resource-publish') {
        publishOrder.push(facts.resource)
        if (facts.resource === 'worktreeConfig') {
          assert.equal(fs.existsSync(privateExclude), true)
          assert.match(fs.readFileSync(privateExclude, 'utf8'), /skill-graft managed excludes v1 begin/)
        }
      }
      if (step === 'materializer-before-resource-rollback') {
        rollbackOrder.push(facts.resource)
        if (facts.resource === 'privateExclude') {
          assert.equal(fs.existsSync(worktreeConfig), false)
          assert.equal(fs.existsSync(privateExclude), true)
        }
      }
    }
  })
  const snapshotFiles = { 'AGENTS.override.md': 'resource-order\n' }
  const runtimeFiles = { 'HubLib.ps1': 'resource-order-runtime\n' }
  const snapshot = manifest(snapshotFiles, 'library-resource-order')
  const runtimeAsset = runtime(runtimeFiles, 'runtime-resource-order')
  model.registerSnapshot(snapshot, snapshotFiles)
  model.registerRuntime(runtimeAsset, runtimeFiles)
  const plan = await approvedPlan(model, snapshot, runtimeAsset, [], null)
  const prepared = await model.adapter.prepare({
    worktree: model.root, identity: model.identity, guard: lease, plan, snapshot, runtimeAsset
  })
  privateExclude = gitPath(model.root, 'skill-graft/excludes-v1')
  worktreeConfig = gitPath(model.root, 'config.worktree')
  await prepared.participant.publish(lease)
  assert.deepEqual(publishOrder, [
    'privateExclude', 'worktreeConfig', 'gitIndex',
    'visibilityPrivate', 'visibilityState', 'marker'
  ])
  await prepared.participant.rollback(lease)
  assert.deepEqual(rollbackOrder, [
    'gitIndex', 'worktreeConfig', 'privateExclude',
    'visibilityState', 'visibilityPrivate', 'marker'
  ])
  await prepared.participant.finalize(lease)
})

test('artifact and Git visibility phases fence fresh, tracked, deselected, and mixed targets', async (t) => {
  const publishPhases = []
  const rollbackPhases = []
  let observe = false
  let rollingBack = false
  let markerPath
  const override = 'AGENTS.override.md'
  const oldSkill = '.agents/skills/old-skill/SKILL.md'
  const freshSkill = '.agents/skills/new-untracked/SKILL.md'
  const trackedCreate = '.agents/skills/tracked-create/tracked.txt'
  let model

  const assertEmptyStatus = (...targets) => {
    for (const target of targets) assert.equal(gitStatusFor(model.root, target), '', target)
  }
  const assertTrackedFlag = (flag) => {
    assert.match(git(model.root, ['ls-files', '-v', '--', trackedCreate]), new RegExp(`^${flag} `))
  }
  const assertNewVisibility = () => {
    assert.equal(gitIgnored(model.root, freshSkill), true)
    assert.equal(gitIgnored(model.root, trackedCreate), true)
    assert.equal(gitIgnored(model.root, oldSkill), false)
    assertTrackedFlag('S')
    assertEmptyStatus(override, oldSkill, freshSkill, trackedCreate)
  }
  const assertOldVisibility = () => {
    assert.equal(gitIgnored(model.root, oldSkill), true)
    assert.equal(gitIgnored(model.root, freshSkill), false)
    assert.equal(gitIgnored(model.root, trackedCreate), false)
    assertTrackedFlag('H')
    assert.match(gitStatusFor(model.root, trackedCreate), /^ D /)
    assertEmptyStatus(override, oldSkill, freshSkill)
  }

  model = fixture(t, {
    checkpoint(step) {
      if (!observe) return
      if (!rollingBack && step === 'materializer-after-delete-publication-phase') {
        publishPhases.push(step)
        assert.equal(gitIgnored(model.root, oldSkill), true)
        assertTrackedFlag('H')
        assert.match(gitStatusFor(model.root, trackedCreate), /^ D /)
        assertEmptyStatus(override, oldSkill, freshSkill)
      } else if (!rollingBack && [
        'materializer-after-git-visibility-publication-phase',
        'materializer-after-create-update-publication-phase',
        'materializer-after-visibility-sidecar-publication-phase',
        'materializer-after-marker-publication-phase'
      ].includes(step)) {
        publishPhases.push(step)
        assertNewVisibility()
        if (step === 'materializer-after-git-visibility-publication-phase') {
          assert.equal(fs.existsSync(path.join(model.root, freshSkill)), false)
          assert.equal(fs.existsSync(path.join(model.root, trackedCreate)), false)
        }
        if (step === 'materializer-after-marker-publication-phase') assert.equal(fs.existsSync(markerPath), true)
      } else if (rollingBack && [
        'materializer-after-marker-retraction-phase',
        'materializer-after-create-rollback-phase'
      ].includes(step)) {
        rollbackPhases.push(step)
        assertNewVisibility()
        assert.equal(fs.existsSync(markerPath), false)
      } else if (rollingBack && [
        'materializer-after-git-visibility-rollback-phase',
        'materializer-after-update-delete-rollback-phase',
        'materializer-after-visibility-sidecar-rollback-phase',
        'materializer-after-old-marker-rollback-phase'
      ].includes(step)) {
        rollbackPhases.push(step)
        assertOldVisibility()
        if (step === 'materializer-after-old-marker-rollback-phase') assert.equal(fs.existsSync(markerPath), true)
      }
    }
  })
  markerPath = gitPath(model.root, 'skill-graft/materialized-v1.json')

  const trackedAbsolute = path.join(model.root, trackedCreate)
  fs.mkdirSync(path.dirname(trackedAbsolute), { recursive: true })
  fs.writeFileSync(trackedAbsolute, 'tracked-baseline\n')
  git(model.root, ['add', trackedCreate])
  git(model.root, ['commit', '--quiet', '-m', 'tracked create baseline'])
  fs.rmSync(path.dirname(trackedAbsolute), { recursive: true, force: true })
  assertTrackedFlag('H')
  assert.match(gitStatusFor(model.root, trackedCreate), /^ D /)

  const runtimeFiles = { 'HubLib.ps1': 'visibility-phase-runtime\n' }
  const runtimeAsset = runtime(runtimeFiles, 'runtime-visibility-phase')
  model.registerRuntime(runtimeAsset, runtimeFiles)
  const oldFiles = {
    'AGENTS.override.md': 'visibility-old\n',
    'skills/adopted/old-skill/SKILL.md': 'old-skill\n'
  }
  const oldSnapshot = manifest(oldFiles, 'library-visibility-old')
  model.registerSnapshot(oldSnapshot, oldFiles)
  const oldPlan = await approvedPlan(model, oldSnapshot, runtimeAsset, ['old-skill'], null)
  const oldPrepared = await model.adapter.prepare({
    worktree: model.root, identity: model.identity, guard: lease,
    plan: oldPlan, snapshot: oldSnapshot, runtimeAsset
  })
  await oldPrepared.participant.publish(lease)
  await oldPrepared.participant.finalize(lease)
  const oldDurable = { schemaVersion: 1, pathKey: model.identity.pathKey, marker: oldPrepared.marker }
  assertOldVisibility()

  const newFiles = {
    'AGENTS.override.md': 'visibility-new\n',
    'skills/adopted/new-untracked/SKILL.md': 'new-untracked\n',
    'skills/adopted/tracked-create/SKILL.md': 'tracked-create\n',
    'skills/adopted/tracked-create/tracked.txt': 'tracked-baseline\n'
  }
  const newSnapshot = manifest(newFiles, 'library-visibility-new')
  model.registerSnapshot(newSnapshot, newFiles)
  const newPlan = await approvedPlan(
    model, newSnapshot, runtimeAsset, ['new-untracked', 'tracked-create'],
    oldDurable, oldSnapshot.snapshotId, 2
  )
  assert.ok(newPlan.summary.create > 0)
  assert.ok(newPlan.summary.update > 0)
  assert.ok(newPlan.summary.delete > 0)
  const prepared = await model.adapter.prepare({
    worktree: model.root, identity: model.identity, guard: lease,
    plan: newPlan, snapshot: newSnapshot, runtimeAsset
  })
  observe = true
  await prepared.participant.publish(lease)
  assert.deepEqual(publishPhases, [
    'materializer-after-delete-publication-phase',
    'materializer-after-git-visibility-publication-phase',
    'materializer-after-create-update-publication-phase',
    'materializer-after-visibility-sidecar-publication-phase',
    'materializer-after-marker-publication-phase'
  ])
  assertNewVisibility()

  rollingBack = true
  await prepared.participant.rollback(lease)
  assert.deepEqual(rollbackPhases, rollbackPhaseCutPoints)
  assertOldVisibility()
  assert.equal(fs.readFileSync(path.join(model.root, override), 'utf8'), 'visibility-old\n')
  assert.equal(fs.readFileSync(path.join(model.root, oldSkill), 'utf8'), 'old-skill\n')
  assert.equal(fs.existsSync(path.join(model.root, freshSkill)), false)
  assert.equal(fs.existsSync(path.join(model.root, trackedCreate)), false)
  await prepared.participant.finalize(lease)
})

test('durable-old and durable-new recovery resume visibility-safe forward phase cuts', async (t) => {
  const cases = [
    {
      name: 'durable old after create-update',
      cut: 'materializer-after-create-update-publication-phase',
      direction: 'old'
    },
    {
      name: 'durable new after Git visibility',
      cut: 'materializer-after-git-visibility-publication-phase',
      direction: 'new'
    }
  ]
  for (const fixtureCase of cases) {
    await t.test(fixtureCase.name, async (child) => {
      let armed = false
      let lost = false
      const observed = []
      let model
      const target = 'AGENTS.override.md'
      model = fixture(child, {
        checkpoint(step) {
          if (!armed || !step.startsWith('materializer-after-') || step.includes('git-lock')) return
          observed.push(step)
          if (step !== fixtureCase.cut) return
          if (fixtureCase.cut === 'materializer-after-git-visibility-publication-phase') {
            assert.equal(fs.existsSync(path.join(model.root, target)), false)
            assert.equal(gitIgnored(model.root, target), true)
            assert.equal(gitStatusFor(model.root, target), '')
          } else {
            assert.equal(fs.existsSync(path.join(model.root, target)), true)
            assert.equal(gitIgnored(model.root, target), true)
            assert.equal(gitStatusFor(model.root, target), '')
          }
          lost = true
        }
      })
      const snapshotFiles = { 'AGENTS.override.md': `phase-cut-${fixtureCase.direction}\n` }
      const runtimeFiles = { 'HubLib.ps1': `phase-cut-runtime-${fixtureCase.direction}\n` }
      const snapshot = manifest(snapshotFiles, `library-phase-cut-${fixtureCase.direction}`)
      const runtimeAsset = runtime(runtimeFiles, `runtime-phase-cut-${fixtureCase.direction}`)
      model.registerSnapshot(snapshot, snapshotFiles)
      model.registerRuntime(runtimeAsset, runtimeFiles)
      const plan = await approvedPlan(model, snapshot, runtimeAsset, [], null)
      const prepared = await model.adapter.prepare({
        worktree: model.root, identity: model.identity, guard: lease, plan, snapshot, runtimeAsset
      })
      const losingGuard = { async revalidateLease() { if (lost) throw new LostLease() } }
      armed = true
      await assert.rejects(prepared.participant.publish(losingGuard), (error) => error?.code === 'LOCK_NOT_OWNED')
      assert.equal(observed.at(-1), fixtureCase.cut)
      assert.equal(fs.existsSync(gitPath(model.root, 'skill-graft/transactions')), true)

      armed = false
      lost = false
      const durable = fixtureCase.direction === 'new'
        ? { schemaVersion: 1, pathKey: model.identity.pathKey, marker: prepared.marker }
        : null
      const recovered = await model.adapter.recover({
        worktree: model.root,
        identity: model.identity,
        durable,
        guard: lease,
        pin: fixtureCase.direction === 'new'
          ? pinFor(model, snapshot, [], snapshot.snapshotId)
          : null,
        stateRevision: fixtureCase.direction === 'new' ? 2 : 1
      })
      if (fixtureCase.direction === 'new') {
        assert.deepEqual(recovered, { status: 'finalized', recoveredTransactions: 1 })
        assert.equal(fs.readFileSync(path.join(model.root, target), 'utf8'), snapshotFiles[target])
        assert.equal(gitIgnored(model.root, target), true)
        assert.equal(gitStatusFor(model.root, target), '')
      } else {
        assert.deepEqual(recovered, { status: 'rolled-back', recoveredTransactions: 1 })
        assert.equal(fs.existsSync(path.join(model.root, target)), false)
        assert.equal(fs.existsSync(gitPath(model.root, 'skill-graft/materialized-v1.json')), false)
      }
    })
  }
})

test('durable-old recovery resumes every marker and visibility rollback phase cut', async (t) => {
  for (const cut of rollbackPhaseCutPoints) {
    await t.test(cut, async (child) => {
      let armed = false
      let lost = false
      const seen = []
      const model = fixture(child, {
        checkpoint(step) {
          if (!armed || !rollbackPhaseCutPoints.includes(step)) return
          seen.push(step)
          if (step === cut) lost = true
        }
      })
      const runtimeFiles = { 'HubLib.ps1': `rollback-cut-runtime-${cut}\n` }
      const runtimeAsset = runtime(runtimeFiles, `runtime-rollback-cut-${cut}`)
      model.registerRuntime(runtimeAsset, runtimeFiles)
      const oldFiles = {
        'AGENTS.override.md': 'rollback-cut-old\n',
        'skills/adopted/rollback-old/SKILL.md': 'rollback-old\n'
      }
      const oldSnapshot = manifest(oldFiles, `library-rollback-old-${cut}`)
      model.registerSnapshot(oldSnapshot, oldFiles)
      const oldPlan = await approvedPlan(model, oldSnapshot, runtimeAsset, ['rollback-old'], null)
      const oldPrepared = await model.adapter.prepare({
        worktree: model.root, identity: model.identity, guard: lease,
        plan: oldPlan, snapshot: oldSnapshot, runtimeAsset
      })
      await oldPrepared.participant.publish(lease)
      await oldPrepared.participant.finalize(lease)
      const oldDurable = { schemaVersion: 1, pathKey: model.identity.pathKey, marker: oldPrepared.marker }

      const newFiles = {
        'AGENTS.override.md': 'rollback-cut-new\n',
        'skills/adopted/rollback-new/SKILL.md': 'rollback-new\n'
      }
      const newSnapshot = manifest(newFiles, `library-rollback-new-${cut}`)
      model.registerSnapshot(newSnapshot, newFiles)
      const newPlan = await approvedPlan(
        model, newSnapshot, runtimeAsset, ['rollback-new'], oldDurable, oldSnapshot.snapshotId, 2
      )
      const prepared = await model.adapter.prepare({
        worktree: model.root, identity: model.identity, guard: lease,
        plan: newPlan, snapshot: newSnapshot, runtimeAsset
      })
      await prepared.participant.publish(lease)
      const losingGuard = { async revalidateLease() { if (lost) throw new LostLease() } }
      armed = true
      await assert.rejects(prepared.participant.rollback(losingGuard), (error) => error?.code === 'LOCK_NOT_OWNED')
      assert.equal(seen.at(-1), cut)
      const markerPath = gitPath(model.root, 'skill-graft/materialized-v1.json')
      if (cut === 'materializer-after-old-marker-rollback-phase') {
        assert.deepEqual(JSON.parse(fs.readFileSync(markerPath, 'utf8')), oldPrepared.marker)
      } else {
        assert.equal(fs.existsSync(markerPath), false)
      }

      armed = false
      lost = false
      assert.deepEqual(await model.adapter.recover({
        worktree: model.root,
        identity: model.identity,
        durable: oldDurable,
        guard: lease,
        pin: pinFor(model, oldSnapshot, ['rollback-old'], oldSnapshot.snapshotId),
        stateRevision: 2
      }), { status: 'rolled-back', recoveredTransactions: 1 })
      assert.equal(fs.readFileSync(path.join(model.root, 'AGENTS.override.md'), 'utf8'), 'rollback-cut-old\n')
      assert.equal(fs.readFileSync(path.join(model.root, '.agents/skills/rollback-old/SKILL.md'), 'utf8'), 'rollback-old\n')
      assert.equal(fs.existsSync(path.join(model.root, '.agents/skills/rollback-new')), false)
      assert.equal(gitIgnored(model.root, '.agents/skills/rollback-old/SKILL.md'), true)
      assert.equal(gitIgnored(model.root, '.agents/skills/rollback-new/SKILL.md'), false)
      assert.equal(gitStatusFor(model.root, 'AGENTS.override.md'), '')
      assert.deepEqual(JSON.parse(fs.readFileSync(markerPath, 'utf8')), oldPrepared.marker)
    })
  }
})

test('prepare refuses stale targets and recovery fails closed on mirror mismatch or tampered journal paths', async (t) => {
  const model = fixture(t)
  const snapshotFiles = { 'AGENTS.override.md': 'override-v1\n' }
  const runtimeFiles = { 'HubLib.ps1': 'hub-lib-v1\n' }
  const snapshot = manifest(snapshotFiles, 'library-r1')
  const runtimeAsset = runtime(runtimeFiles)
  model.registerSnapshot(snapshot, snapshotFiles)
  model.registerRuntime(runtimeAsset, runtimeFiles)
  const plan = await approvedPlan(model, snapshot, runtimeAsset, [], null)
  fs.writeFileSync(path.join(model.root, 'AGENTS.override.md'), 'foreign\n')
  await assert.rejects(
    model.adapter.prepare({ worktree: model.root, identity: model.identity, guard: lease, plan, snapshot, runtimeAsset }),
    /changed after planning/
  )
  fs.unlinkSync(path.join(model.root, 'AGENTS.override.md'))

  const prepared = await model.adapter.prepare({ worktree: model.root, identity: model.identity, guard: lease, plan, snapshot, runtimeAsset })
  const transactions = path.resolve(model.root, git(model.root, ['rev-parse', '--git-path', 'skill-graft/transactions']).trim())
  const txRoot = path.join(transactions, fs.readdirSync(transactions)[0])
  const journalFile = path.join(txRoot, 'journal.json')
  const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'))
  journal.resources.at(-1).target = path.join(model.root, 'AGENTS.md')
  fs.writeFileSync(journalFile, `${JSON.stringify(journal)}\n`)
  await assert.rejects(
    model.adapter.recover({
      worktree: model.root, identity: model.identity, durable: null, guard: lease,
      pin: pinFor(model, snapshot, [], null), stateRevision: 1
    }),
    /resource journal is invalid/
  )
  assert.equal(fs.readFileSync(path.join(model.root, 'AGENTS.md'), 'utf8'), 'project-owned\n')
  assert.ok(prepared.marker)
})

test('durable-old recovery rejects an omitted partially published artifact and retains its journal', async (t) => {
  const model = fixture(t)
  const snapshotFiles = {
    'AGENTS.override.md': 'artifact-closure\n',
    'skills/adopted/closure/SKILL.md': 'artifact-closure-skill\n'
  }
  const runtimeFiles = { 'HubLib.ps1': 'artifact-closure-runtime\n' }
  const snapshot = manifest(snapshotFiles, 'library-artifact-closure')
  const runtimeAsset = runtime(runtimeFiles, 'runtime-artifact-closure')
  model.registerSnapshot(snapshot, snapshotFiles)
  model.registerRuntime(runtimeAsset, runtimeFiles)
  const plan = await approvedPlan(model, snapshot, runtimeAsset, ['closure'], null)
  await model.adapter.prepare({
    worktree: model.root, identity: model.identity, guard: lease, plan, snapshot, runtimeAsset
  })
  const transactions = gitPath(model.root, 'skill-graft/transactions')
  const txRoot = path.join(transactions, fs.readdirSync(transactions).find((name) => !name.startsWith('.')))
  const journalPath = path.join(txRoot, 'journal.json')
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'))
  const omitted = journal.artifacts[0]
  assert.equal(omitted.action, 'create')
  const target = path.join(model.root, ...omitted.targetRelativePath.split('/'))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.renameSync(path.join(txRoot, 'staging', omitted.stageName), target)
  journal.artifacts.splice(0, 1)
  fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`)

  await assert.rejects(model.adapter.recover({
    worktree: model.root, identity: model.identity, durable: null, guard: lease,
    pin: null, stateRevision: 1
  }), (error) => error?.code === 'STATE_CORRUPT')
  assert.equal(fs.existsSync(target), true)
  assert.equal(fs.existsSync(txRoot), true)
  assert.equal(fs.existsSync(journalPath), true)
})

test('durable-old recovery rejects omitted published Git resources before cleanup', async (t) => {
  for (const kind of ['gitIndex', 'worktreeConfig', 'privateExclude']) {
    await t.test(kind, async (child) => {
      const model = fixture(child)
      fs.writeFileSync(path.join(model.root, 'AGENTS.override.md'), 'tracked-baseline\n')
      git(model.root, ['add', 'AGENTS.override.md'])
      git(model.root, ['commit', '--quiet', '-m', 'tracked controlled baseline'])
      fs.unlinkSync(path.join(model.root, 'AGENTS.override.md'))
      git(model.root, ['config', '--worktree', 'fixture.before', 'true'])
      const snapshotFiles = { 'AGENTS.override.md': 'tracked-baseline\n' }
      const runtimeFiles = { 'HubLib.ps1': 'resource-closure-runtime\n' }
      const snapshot = manifest(snapshotFiles, `library-resource-closure-${kind}`)
      const runtimeAsset = runtime(runtimeFiles, `runtime-resource-closure-${kind}`)
      model.registerSnapshot(snapshot, snapshotFiles)
      model.registerRuntime(runtimeAsset, runtimeFiles)
      const plan = await approvedPlan(model, snapshot, runtimeAsset, [], null)
      await model.adapter.prepare({
        worktree: model.root, identity: model.identity, guard: lease, plan, snapshot, runtimeAsset
      })
      const transactions = gitPath(model.root, 'skill-graft/transactions')
      const txRoot = path.join(transactions, fs.readdirSync(transactions).find((name) => !name.startsWith('.')))
      const journalPath = path.join(txRoot, 'journal.json')
      const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'))
      const resourceIndex = journal.resources.findIndex((resource) => resource.kind === kind)
      const omitted = journal.resources[resourceIndex]
      assert.equal(omitted.disposition, 'publish', `${kind} fixture must publish`)
      const backup = path.join(txRoot, 'backups', omitted.backupName)
      if (omitted.before !== null) fs.renameSync(omitted.target, backup)
      fs.renameSync(path.join(txRoot, 'staging', omitted.stageName), omitted.target)
      const publishedBytes = fs.readFileSync(omitted.target)
      journal.resources.splice(resourceIndex, 1)
      fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`)

      await assert.rejects(model.adapter.recover({
        worktree: model.root, identity: model.identity, durable: null, guard: lease,
        pin: null, stateRevision: 1
      }), (error) => error?.code === 'STATE_CORRUPT')
      assert.deepEqual(fs.readFileSync(omitted.target), publishedBytes)
      if (omitted.before !== null) assert.equal(fs.existsSync(backup), true)
      assert.equal(fs.existsSync(txRoot), true)
      assert.equal(fs.existsSync(journalPath), true)
    })
  }
})

test('durable-new recovery safely forwards a journal-proven partial artifact publication', async (t) => {
  let armed = false
  let lost = false
  let artifactStarts = 0
  const model = fixture(t, {
    checkpoint(step) {
      if (!armed || step !== 'materializer-before-artifact-publish') return
      artifactStarts += 1
      if (artifactStarts === 2) lost = true
    }
  })
  const snapshotFiles = {
    'AGENTS.override.md': 'forward-v1\n',
    'skills/ozdqp-development/SKILL.md': 'forward-skill\n'
  }
  const runtimeFiles = { 'HubLib.ps1': 'forward-runtime\n' }
  const snapshot = manifest(snapshotFiles, 'library-forward')
  const runtimeAsset = runtime(runtimeFiles, 'runtime-forward')
  model.registerSnapshot(snapshot, snapshotFiles)
  model.registerRuntime(runtimeAsset, runtimeFiles)
  const plan = await approvedPlan(model, snapshot, runtimeAsset, ['ozdqp-development'], null)
  const prepared = await model.adapter.prepare({ worktree: model.root, identity: model.identity, guard: lease, plan, snapshot, runtimeAsset })
  const transactions = path.resolve(model.root, git(model.root, ['rev-parse', '--git-path', 'skill-graft/transactions']).trim())
  const txRoot = path.join(transactions, fs.readdirSync(transactions).find((name) => !name.startsWith('.')))
  const journal = JSON.parse(fs.readFileSync(path.join(txRoot, 'journal.json'), 'utf8'))
  const first = journal.artifacts[0]
  const target = path.join(model.root, ...first.targetRelativePath.split('/'))
  const losingGuard = { async revalidateLease() { if (lost) throw new LostLease() } }
  armed = true
  await assert.rejects(prepared.participant.publish(losingGuard), (error) => error?.code === 'LOCK_NOT_OWNED')
  assert.equal(artifactStarts, 2)
  assert.equal(fs.existsSync(target), true)
  assert.equal(gitStatusFor(model.root, first.targetRelativePath), '')

  armed = false
  lost = false
  const durable = { schemaVersion: 1, pathKey: model.identity.pathKey, marker: prepared.marker }
  const recovered = await model.adapter.recover({
    worktree: model.root, identity: model.identity, durable, guard: lease,
    pin: pinFor(model, snapshot, ['ozdqp-development'], snapshot.snapshotId), stateRevision: 2
  })
  assert.deepEqual(recovered, { status: 'finalized', recoveredTransactions: 1 })
  assert.equal(fs.readFileSync(path.join(model.root, 'AGENTS.override.md'), 'utf8'), 'forward-v1\n')
  assert.equal(fs.readFileSync(path.join(model.root, '.agents', 'skills', 'ozdqp-development', 'SKILL.md'), 'utf8'), 'forward-skill\n')
})

test('durable-new recovery rejects artifact progress ahead of the Git visibility phase', async (t) => {
  const model = fixture(t)
  const snapshotFiles = { 'AGENTS.override.md': 'out-of-order\n' }
  const runtimeFiles = { 'HubLib.ps1': 'out-of-order-runtime\n' }
  const snapshot = manifest(snapshotFiles, 'library-out-of-order')
  const runtimeAsset = runtime(runtimeFiles, 'runtime-out-of-order')
  model.registerSnapshot(snapshot, snapshotFiles)
  model.registerRuntime(runtimeAsset, runtimeFiles)
  const plan = await approvedPlan(model, snapshot, runtimeAsset, [], null)
  const prepared = await model.adapter.prepare({
    worktree: model.root, identity: model.identity, guard: lease, plan, snapshot, runtimeAsset
  })
  const transactions = gitPath(model.root, 'skill-graft/transactions')
  const txRoot = path.join(transactions, fs.readdirSync(transactions).find((name) => !name.startsWith('.')))
  const journal = JSON.parse(fs.readFileSync(path.join(txRoot, 'journal.json'), 'utf8'))
  const first = journal.artifacts[0]
  const target = path.join(model.root, ...first.targetRelativePath.split('/'))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.renameSync(path.join(txRoot, 'staging', first.stageName), target)

  await assert.rejects(model.adapter.recover({
    worktree: model.root,
    identity: model.identity,
    durable: { schemaVersion: 1, pathKey: model.identity.pathKey, marker: prepared.marker },
    guard: lease,
    pin: pinFor(model, snapshot, [], snapshot.snapshotId),
    stateRevision: 2
  }), (error) => error?.code === 'STATE_CORRUPT')
  assert.equal(fs.existsSync(target), true)
  assert.equal(fs.existsSync(path.join(txRoot, 'journal.json')), true)
  for (const resource of journal.resources.filter((entry) => (
    entry.disposition === 'publish' && ['gitIndex', 'worktreeConfig'].includes(entry.kind)
  ))) {
    assert.equal(fs.existsSync(`${resource.target}.lock`), false)
  }
})

test('forward prefix rejects later intermediate states without advancing publication', async (t) => {
  await t.test('Git resource intermediate ahead of a pending delete', async (child) => {
    let observe = false
    const publicationPhases = []
    const model = fixture(child, {
      checkpoint(step) {
        if (observe && step.includes('-publication-phase')) publicationPhases.push(step)
      }
    })
    const runtimeFiles = { 'HubLib.ps1': 'prefix-git-runtime\n' }
    const runtimeAsset = runtime(runtimeFiles, 'runtime-prefix-git')
    model.registerRuntime(runtimeAsset, runtimeFiles)
    const oldFiles = {
      'AGENTS.override.md': 'prefix-git-override\n',
      'skills/adopted/prefix-old/SKILL.md': 'prefix-old\n'
    }
    const oldSnapshot = manifest(oldFiles, 'library-prefix-git-old')
    model.registerSnapshot(oldSnapshot, oldFiles)
    const oldPlan = await approvedPlan(model, oldSnapshot, runtimeAsset, ['prefix-old'], null)
    const oldPrepared = await model.adapter.prepare({
      worktree: model.root, identity: model.identity, guard: lease,
      plan: oldPlan, snapshot: oldSnapshot, runtimeAsset
    })
    await oldPrepared.participant.publish(lease)
    await oldPrepared.participant.finalize(lease)
    const oldDurable = { schemaVersion: 1, pathKey: model.identity.pathKey, marker: oldPrepared.marker }

    const nextFiles = { 'AGENTS.override.md': 'prefix-git-override\n' }
    const nextSnapshot = manifest(nextFiles, 'library-prefix-git-new')
    model.registerSnapshot(nextSnapshot, nextFiles)
    const nextPlan = await approvedPlan(
      model, nextSnapshot, runtimeAsset, [], oldDurable, oldSnapshot.snapshotId, 2
    )
    const prepared = await model.adapter.prepare({
      worktree: model.root, identity: model.identity, guard: lease,
      plan: nextPlan, snapshot: nextSnapshot, runtimeAsset
    })
    const transactions = gitPath(model.root, 'skill-graft/transactions')
    const txRoot = path.join(transactions, fs.readdirSync(transactions).find((name) => !name.startsWith('.')))
    const journalPath = path.join(txRoot, 'journal.json')
    const journalBytes = fs.readFileSync(journalPath)
    const journal = JSON.parse(journalBytes)
    const pendingDelete = journal.artifacts.find((entry) => entry.action === 'delete')
    const privateExclude = journal.resources.find((entry) => entry.kind === 'privateExclude')
    assert.ok(pendingDelete)
    assert.equal(privateExclude?.disposition, 'publish')
    assert.notEqual(privateExclude.before, null)
    const deleteTarget = path.join(model.root, ...pendingDelete.targetRelativePath.split('/'))
    const privateBefore = fs.readFileSync(privateExclude.target)
    const privateStage = path.join(txRoot, 'staging', privateExclude.stageName)
    const privateStageBytes = fs.readFileSync(privateStage)
    const privateBackup = path.join(txRoot, 'backups', privateExclude.backupName)
    fs.renameSync(privateExclude.target, privateBackup)
    const markerPath = gitPath(model.root, 'skill-graft/materialized-v1.json')
    const markerBefore = fs.readFileSync(markerPath)

    observe = true
    await assert.rejects(model.adapter.recover({
      worktree: model.root,
      identity: model.identity,
      durable: { schemaVersion: 1, pathKey: model.identity.pathKey, marker: prepared.marker },
      guard: lease,
      pin: pinFor(model, nextSnapshot, [], nextSnapshot.snapshotId),
      stateRevision: 3
    }), (error) => error?.code === 'STATE_CORRUPT')
    assert.deepEqual(publicationPhases, [])
    assert.equal(fs.existsSync(deleteTarget), true)
    assert.equal(fs.existsSync(privateExclude.target), false)
    assert.deepEqual(fs.readFileSync(privateBackup), privateBefore)
    assert.deepEqual(fs.readFileSync(privateStage), privateStageBytes)
    assert.deepEqual(fs.readFileSync(markerPath), markerBefore)
    assert.deepEqual(fs.readFileSync(journalPath), journalBytes)
    for (const resource of journal.resources.filter((entry) => (
      entry.disposition === 'publish' && ['gitIndex', 'worktreeConfig'].includes(entry.kind)
    ))) assert.equal(fs.existsSync(`${resource.target}.lock`), false)
  })

  await t.test('artifact update intermediate ahead of Git visibility', async (child) => {
    let observe = false
    const publicationPhases = []
    const model = fixture(child, {
      checkpoint(step) {
        if (observe && step.includes('-publication-phase')) publicationPhases.push(step)
      }
    })
    const runtimeFiles = { 'HubLib.ps1': 'prefix-artifact-runtime\n' }
    const runtimeAsset = runtime(runtimeFiles, 'runtime-prefix-artifact')
    model.registerRuntime(runtimeAsset, runtimeFiles)
    const oldFiles = { 'AGENTS.override.md': 'prefix-artifact-old\n' }
    const oldSnapshot = manifest(oldFiles, 'library-prefix-artifact-old')
    model.registerSnapshot(oldSnapshot, oldFiles)
    const oldPlan = await approvedPlan(model, oldSnapshot, runtimeAsset, [], null)
    const oldPrepared = await model.adapter.prepare({
      worktree: model.root, identity: model.identity, guard: lease,
      plan: oldPlan, snapshot: oldSnapshot, runtimeAsset
    })
    await oldPrepared.participant.publish(lease)
    await oldPrepared.participant.finalize(lease)
    const oldDurable = { schemaVersion: 1, pathKey: model.identity.pathKey, marker: oldPrepared.marker }

    const nextFiles = {
      'AGENTS.override.md': 'prefix-artifact-new\n',
      'skills/adopted/prefix-new/SKILL.md': 'prefix-new\n'
    }
    const nextSnapshot = manifest(nextFiles, 'library-prefix-artifact-new')
    model.registerSnapshot(nextSnapshot, nextFiles)
    const nextPlan = await approvedPlan(
      model, nextSnapshot, runtimeAsset, ['prefix-new'], oldDurable, oldSnapshot.snapshotId, 2
    )
    const prepared = await model.adapter.prepare({
      worktree: model.root, identity: model.identity, guard: lease,
      plan: nextPlan, snapshot: nextSnapshot, runtimeAsset
    })
    const transactions = gitPath(model.root, 'skill-graft/transactions')
    const txRoot = path.join(transactions, fs.readdirSync(transactions).find((name) => !name.startsWith('.')))
    const journalPath = path.join(txRoot, 'journal.json')
    const journalBytes = fs.readFileSync(journalPath)
    const journal = JSON.parse(journalBytes)
    const update = journal.artifacts.find((entry) => entry.action === 'update')
    assert.ok(update)
    assert.ok(journal.resources.some((entry) => (
      entry.disposition === 'publish' && ['privateExclude', 'worktreeConfig', 'gitIndex'].includes(entry.kind)
    )))
    const updateTarget = path.join(model.root, ...update.targetRelativePath.split('/'))
    const updateBefore = fs.readFileSync(updateTarget)
    const updateStage = path.join(txRoot, 'staging', update.stageName)
    const updateStageBytes = fs.readFileSync(updateStage)
    const updateBackup = path.join(txRoot, 'backups', update.backupName)
    const gitTargets = new Map(journal.resources.filter((entry) => (
      ['privateExclude', 'worktreeConfig', 'gitIndex'].includes(entry.kind)
    )).map((entry) => [entry.target, fs.existsSync(entry.target) ? fs.readFileSync(entry.target) : null]))
    fs.renameSync(updateTarget, updateBackup)
    const markerPath = gitPath(model.root, 'skill-graft/materialized-v1.json')
    const markerBefore = fs.readFileSync(markerPath)

    observe = true
    await assert.rejects(model.adapter.recover({
      worktree: model.root,
      identity: model.identity,
      durable: { schemaVersion: 1, pathKey: model.identity.pathKey, marker: prepared.marker },
      guard: lease,
      pin: pinFor(model, nextSnapshot, ['prefix-new'], nextSnapshot.snapshotId),
      stateRevision: 3
    }), (error) => error?.code === 'STATE_CORRUPT')
    assert.deepEqual(publicationPhases, [])
    assert.equal(fs.existsSync(updateTarget), false)
    assert.deepEqual(fs.readFileSync(updateBackup), updateBefore)
    assert.deepEqual(fs.readFileSync(updateStage), updateStageBytes)
    for (const [target, before] of gitTargets) {
      assert.equal(fs.existsSync(target), before !== null)
      if (before !== null) assert.deepEqual(fs.readFileSync(target), before)
    }
    assert.deepEqual(fs.readFileSync(markerPath), markerBefore)
    assert.deepEqual(fs.readFileSync(journalPath), journalBytes)
    for (const resource of journal.resources.filter((entry) => (
      entry.disposition === 'publish' && ['gitIndex', 'worktreeConfig'].includes(entry.kind)
    ))) assert.equal(fs.existsSync(`${resource.target}.lock`), false)
  })
})

test('durable-new recovery retains its journal when published ownership proof is invalid', async (t) => {
  const model = fixture(t)
  const snapshotFiles = { 'AGENTS.override.md': 'proof-before-cleanup\n' }
  const runtimeFiles = { 'HubLib.ps1': 'proof-before-cleanup-runtime\n' }
  const snapshot = manifest(snapshotFiles, 'library-proof-before-cleanup')
  const runtimeAsset = runtime(runtimeFiles, 'runtime-proof-before-cleanup')
  model.registerSnapshot(snapshot, snapshotFiles)
  model.registerRuntime(runtimeAsset, runtimeFiles)
  const plan = await approvedPlan(model, snapshot, runtimeAsset, [], null)
  const prepared = await model.adapter.prepare({
    worktree: model.root, identity: model.identity, guard: lease, plan, snapshot, runtimeAsset
  })
  const transactions = gitPath(model.root, 'skill-graft/transactions')
  const txRoot = path.join(transactions, fs.readdirSync(transactions).find((name) => !name.startsWith('.')))
  const journalPath = path.join(txRoot, 'journal.json')
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'))
  const stateResource = journal.resources.find((resource) => resource.kind === 'visibilityState')
  assert.ok(stateResource)
  const invalidState = Buffer.from('{"schemaVersion":1}\n')
  fs.writeFileSync(path.join(txRoot, 'staging', stateResource.stageName), invalidState)
  stateResource.after = sha(invalidState)
  fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`)

  const durable = { schemaVersion: 1, pathKey: model.identity.pathKey, marker: prepared.marker }
  await assert.rejects(model.adapter.recover({
    worktree: model.root, identity: model.identity, durable, guard: lease,
    pin: pinFor(model, snapshot, [], snapshot.snapshotId), stateRevision: 2
  }), (error) => error?.code === 'STATE_CORRUPT')
  assert.equal(fs.existsSync(txRoot), true)
  assert.equal(fs.existsSync(journalPath), true)
  assert.equal(fs.readdirSync(transactions).some((name) => name.startsWith('.finalize-')), false)
})

test('lease loss at an artifact checkpoint stops publication and preserves its recovery journal', async (t) => {
  let revoked = false
  const model = fixture(t, {
    checkpoint(step) { if (step === 'materializer-before-artifact-publish') revoked = true }
  })
  const snapshotFiles = { 'AGENTS.override.md': 'lease-v1\n' }
  const runtimeFiles = { 'HubLib.ps1': 'lease-runtime\n' }
  const snapshot = manifest(snapshotFiles, 'library-lease')
  const runtimeAsset = runtime(runtimeFiles, 'runtime-lease')
  model.registerSnapshot(snapshot, snapshotFiles)
  model.registerRuntime(runtimeAsset, runtimeFiles)
  const plan = await approvedPlan(model, snapshot, runtimeAsset, [], null)
  const prepared = await model.adapter.prepare({ worktree: model.root, identity: model.identity, guard: lease, plan, snapshot, runtimeAsset })
  const guard = { async revalidateLease() { if (revoked) throw new LostLease() } }
  await assert.rejects(prepared.participant.publish(guard), (error) => error?.code === 'LOCK_NOT_OWNED')
  assert.equal(fs.existsSync(path.join(model.root, 'AGENTS.override.md')), false)
  assert.equal(fs.existsSync(path.join(model.root, '.codex', 'local-overlay')), false)
  const transactions = path.resolve(model.root, git(model.root, ['rev-parse', '--git-path', 'skill-graft/transactions']).trim())
  assert.equal(fs.readdirSync(transactions).some((name) => !name.startsWith('.')), true)
})

test('prepare lease loss stops after the guarded orphan root and recovery removes it', async (t) => {
  let revoked = false
  const model = fixture(t, {
    checkpoint(step) { if (step === 'materializer-after-prepare-root') revoked = true }
  })
  const snapshotFiles = { 'AGENTS.override.md': 'prepare-lease\n' }
  const runtimeFiles = { 'HubLib.ps1': 'prepare-lease-runtime\n' }
  const snapshot = manifest(snapshotFiles, 'library-prepare-lease')
  const runtimeAsset = runtime(runtimeFiles, 'runtime-prepare-lease')
  model.registerSnapshot(snapshot, snapshotFiles)
  model.registerRuntime(runtimeAsset, runtimeFiles)
  const plan = await approvedPlan(model, snapshot, runtimeAsset, [], null)
  const guard = { async revalidateLease() { if (revoked) throw new LostLease() } }
  await assert.rejects(model.adapter.prepare({
    worktree: model.root, identity: model.identity, guard, plan, snapshot, runtimeAsset
  }), (error) => error?.code === 'LOCK_NOT_OWNED')
  const transactions = gitPath(model.root, 'skill-graft/transactions')
  const entries = fs.readdirSync(transactions)
  assert.equal(entries.length, 1)
  assert.match(entries[0], /^\.prepare-/)
  assert.equal(fs.existsSync(path.join(model.root, 'AGENTS.override.md')), false)
  assert.equal(fs.existsSync(path.join(model.root, '.codex', 'local-overlay')), false)

  revoked = false
  assert.deepEqual(await model.adapter.recover({
    worktree: model.root, identity: model.identity, durable: null, guard,
    pin: null, stateRevision: 1
  }), { status: 'rolled-back', recoveredTransactions: 1 })
  assert.deepEqual(fs.readdirSync(transactions), [])
})

test('prepared publish lock initialization is recoverable at every guarded mutation cut point', async (t) => {
  for (const cutPoint of gitLockCutPoints) {
    await t.test(cutPoint, async (child) => {
      let armed = true
      let revoked = false
      const observedLockCuts = []
      const model = fixture(child, {
        checkpoint(step) {
          if (!step.startsWith('materializer-after-git-lock-')) return
          observedLockCuts.push(step)
          if (armed && step === cutPoint) revoked = true
        }
      })
      const snapshotFiles = { 'AGENTS.override.md': 'lock-cut-publish\n' }
      const runtimeFiles = { 'HubLib.ps1': 'lock-cut-publish-runtime\n' }
      const snapshot = manifest(snapshotFiles, `library-lock-publish-${gitLockCutPoints.indexOf(cutPoint)}`)
      const runtimeAsset = runtime(runtimeFiles, `runtime-lock-publish-${gitLockCutPoints.indexOf(cutPoint)}`)
      model.registerSnapshot(snapshot, snapshotFiles)
      model.registerRuntime(runtimeAsset, runtimeFiles)
      const plan = await approvedPlan(model, snapshot, runtimeAsset, [], null)
      const prepared = await model.adapter.prepare({
        worktree: model.root, identity: model.identity, guard: lease, plan, snapshot, runtimeAsset
      })
      assert.deepEqual(observedLockCuts, [], 'prepare must not acquire a live Git resource lock')
      const transactions = gitPath(model.root, 'skill-graft/transactions')
      const txRoot = path.join(transactions, fs.readdirSync(transactions).find((name) => !name.startsWith('.')))
      const journal = JSON.parse(fs.readFileSync(path.join(txRoot, 'journal.json'), 'utf8'))
      const resource = journal.resources.find((candidate) => candidate.kind === 'worktreeConfig')
      assert.equal(resource.disposition, 'publish')
      const lockTarget = `${resource.target}.lock`
      const placeholder = path.join(txRoot, 'staging', '.git-lock-worktreeConfig')
      const guard = { async revalidateLease() { if (revoked) throw new LostLease() } }

      await assert.rejects(prepared.participant.publish(guard), (error) => error?.code === 'LOCK_NOT_OWNED')
      assert.equal(observedLockCuts.at(-1), cutPoint, 'no later lock mutation checkpoint may run after lease loss')
      assert.equal(fs.existsSync(path.join(txRoot, 'journal.json')), true)
      if (fs.existsSync(lockTarget)) {
        const stat = fs.lstatSync(lockTarget)
        assert.ok(stat.nlink === 1 || stat.nlink === 2)
        assert.match(fs.readFileSync(lockTarget, 'utf8'), /^skill-graft-git-lock-v1\n/)
      }
      if (fs.existsSync(placeholder)) {
        const stat = fs.lstatSync(placeholder)
        assert.ok(stat.nlink === 1 || stat.nlink === 2)
      }

      armed = false
      revoked = false
      assert.deepEqual(await model.adapter.recover({
        worktree: model.root, identity: model.identity, durable: null, guard,
        pin: null, stateRevision: 1
      }), { status: 'rolled-back', recoveredTransactions: 1 })
      assert.equal(fs.existsSync(lockTarget), false)
      assert.equal(fs.existsSync(txRoot), false)
    })
  }
})

test('recovery lock initialization is recoverable at every guarded mutation cut point', async (t) => {
  for (const cutPoint of gitLockCutPoints) {
    await t.test(cutPoint, async (child) => {
      let armed = true
      let revoked = false
      const observedLockCuts = []
      const model = fixture(child, {
        checkpoint(step) {
          if (!step.startsWith('materializer-after-git-lock-')) return
          observedLockCuts.push(step)
          if (armed && step === cutPoint) revoked = true
        }
      })
      const snapshotFiles = { 'AGENTS.override.md': 'lock-cut-recovery\n' }
      const runtimeFiles = { 'HubLib.ps1': 'lock-cut-recovery-runtime\n' }
      const snapshot = manifest(snapshotFiles, `library-lock-recovery-${gitLockCutPoints.indexOf(cutPoint)}`)
      const runtimeAsset = runtime(runtimeFiles, `runtime-lock-recovery-${gitLockCutPoints.indexOf(cutPoint)}`)
      model.registerSnapshot(snapshot, snapshotFiles)
      model.registerRuntime(runtimeAsset, runtimeFiles)
      const plan = await approvedPlan(model, snapshot, runtimeAsset, [], null)
      await model.adapter.prepare({
        worktree: model.root, identity: model.identity, guard: lease, plan, snapshot, runtimeAsset
      })
      assert.deepEqual(observedLockCuts, [], 'prepare must not acquire a live Git resource lock')
      const transactions = gitPath(model.root, 'skill-graft/transactions')
      const txRoot = path.join(transactions, fs.readdirSync(transactions).find((name) => !name.startsWith('.')))
      const journal = JSON.parse(fs.readFileSync(path.join(txRoot, 'journal.json'), 'utf8'))
      const resource = journal.resources.find((candidate) => candidate.kind === 'worktreeConfig')
      const lockTarget = `${resource.target}.lock`
      const guard = { async revalidateLease() { if (revoked) throw new LostLease() } }

      await assert.rejects(model.adapter.recover({
        worktree: model.root, identity: model.identity, durable: null, guard,
        pin: null, stateRevision: 1
      }), (error) => error?.code === 'LOCK_NOT_OWNED')
      assert.equal(observedLockCuts.at(-1), cutPoint, 'no later lock mutation checkpoint may run after lease loss')
      assert.equal(fs.existsSync(path.join(txRoot, 'journal.json')), true)

      armed = false
      revoked = false
      assert.deepEqual(await model.adapter.recover({
        worktree: model.root, identity: model.identity, durable: null, guard,
        pin: null, stateRevision: 1
      }), { status: 'rolled-back', recoveredTransactions: 1 })
      assert.equal(fs.existsSync(lockTarget), false)
      assert.equal(fs.existsSync(txRoot), false)
    })
  }
})

test('linked worktree sync keeps common exclude and sibling private visibility unchanged', async (t) => {
  const model = fixture(t)
  const sibling = `${model.root}-linked`
  t.after(() => fs.rmSync(sibling, { recursive: true, force: true }))
  git(model.root, ['worktree', 'add', '--quiet', '--detach', sibling, 'HEAD'])
  const siblingIdentity = { pathKey: sha(path.resolve(sibling).toLowerCase()), worktreeId: 'worktree:materializer-sibling' }
  model.registerIdentity(sibling, siblingIdentity)
  const baseIgnore = path.join(model.packageRoot, 'fixture-global-ignore')
  fs.writeFileSync(baseIgnore, '*.sentinel\n')
  git(model.root, ['config', 'core.excludesFile', baseIgnore])
  fs.writeFileSync(path.join(model.root, 'non-controlled.sentinel'), 'ignored\n')
  assert.equal(git(model.root, ['check-ignore', 'non-controlled.sentinel']).trim(), 'non-controlled.sentinel')
  const commonExclude = path.resolve(model.root, git(model.root, ['rev-parse', '--git-path', 'info/exclude']).trim())
  const beforeExclude = fs.readFileSync(commonExclude)
  const beforeStatus = git(sibling, ['status', '--porcelain=v1', '--untracked-files=all'])
  const siblingConfig = path.resolve(sibling, git(sibling, ['rev-parse', '--git-path', 'config.worktree']).trim())
  const siblingPrivate = path.resolve(sibling, git(sibling, ['rev-parse', '--git-path', 'skill-graft/excludes-v1']).trim())

  const snapshotFiles = { 'AGENTS.override.md': 'linked-v1\n' }
  const runtimeFiles = { 'HubLib.ps1': 'linked-runtime\n' }
  const snapshot = manifest(snapshotFiles, 'library-linked')
  const runtimeAsset = runtime(runtimeFiles, 'runtime-linked')
  model.registerSnapshot(snapshot, snapshotFiles)
  model.registerRuntime(runtimeAsset, runtimeFiles)
  const plan = await approvedPlan(model, snapshot, runtimeAsset, [], null)
  assert.equal(model.identityResolutionCount(sibling), 0, 'ordinary inspection does not traverse sibling facts')
  const siblingConfigBytes = '[fixture]\n\ttouched-after-plan = true\n'
  fs.writeFileSync(siblingConfig, siblingConfigBytes)
  const prepared = await model.adapter.prepare({ worktree: model.root, identity: model.identity, guard: lease, plan, snapshot, runtimeAsset })
  assert.equal(model.identityResolutionCount(sibling), 0, 'ordinary prepare does not re-read sibling facts')
  await prepared.participant.publish(lease)
  await prepared.participant.finalize(lease)

  assert.deepEqual(fs.readFileSync(commonExclude), beforeExclude)
  assert.equal(git(model.root, ['check-ignore', 'non-controlled.sentinel']).trim(), 'non-controlled.sentinel')
  assert.equal(fs.readFileSync(siblingConfig, 'utf8'), siblingConfigBytes)
  assert.equal(fs.existsSync(siblingPrivate), false)
  assert.equal(git(sibling, ['status', '--porcelain=v1', '--untracked-files=all']), beforeStatus)
})

test('ordinary recovery rejects sibling sentinel and commonConfig journal tampering before locks or sibling traversal', async (t) => {
  const model = fixture(t)
  const sibling = `${model.root}-tamper-linked`
  t.after(() => fs.rmSync(sibling, { recursive: true, force: true }))
  git(model.root, ['worktree', 'add', '--quiet', '--detach', sibling, 'HEAD'])
  model.registerIdentity(sibling, {
    pathKey: sha(path.resolve(sibling).toLowerCase()), worktreeId: 'worktree:tamper-sibling'
  })
  const snapshotFiles = { 'AGENTS.override.md': 'journal-tamper\n' }
  const runtimeFiles = { 'HubLib.ps1': 'journal-tamper-runtime\n' }
  const snapshot = manifest(snapshotFiles, 'library-journal-tamper')
  const runtimeAsset = runtime(runtimeFiles, 'runtime-journal-tamper')
  model.registerSnapshot(snapshot, snapshotFiles)
  model.registerRuntime(runtimeAsset, runtimeFiles)
  const plan = await approvedPlan(model, snapshot, runtimeAsset, [], null)
  const prepared = await model.adapter.prepare({
    worktree: model.root, identity: model.identity, guard: lease, plan, snapshot, runtimeAsset
  })
  const transactions = gitPath(model.root, 'skill-graft/transactions')
  const txRoot = path.join(transactions, fs.readdirSync(transactions).find((name) => !name.startsWith('.')))
  const journalPath = path.join(txRoot, 'journal.json')
  const original = JSON.parse(fs.readFileSync(journalPath, 'utf8'))
  const commonConfig = path.join(path.resolve(model.root, git(model.root, ['rev-parse', '--git-common-dir']).trim()), 'config')
  const commonBefore = fs.readFileSync(commonConfig)

  const sentinelTamper = structuredClone(original)
  sentinelTamper.siblingConfigDigest = sha('tampered ordinary sentinel')
  fs.writeFileSync(journalPath, `${JSON.stringify(sentinelTamper, null, 2)}\n`)
  await assert.rejects(model.adapter.recover({
    worktree: model.root, identity: model.identity, durable: null, guard: lease,
    pin: null, stateRevision: 1
  }), (error) => error?.code === 'STATE_CORRUPT')
  assert.equal(model.identityResolutionCount(sibling), 0)
  assert.deepEqual(fs.readFileSync(commonConfig), commonBefore)

  const keepOmission = structuredClone(original)
  keepOmission.resources.splice(keepOmission.resources.findIndex((resource) => resource.kind === 'gitIndex'), 1)
  fs.writeFileSync(journalPath, `${JSON.stringify(keepOmission, null, 2)}\n`)
  await assert.rejects(model.adapter.recover({
    worktree: model.root, identity: model.identity, durable: null, guard: lease,
    pin: null, stateRevision: 1
  }), (error) => error?.code === 'STATE_CORRUPT')

  const kindTamper = structuredClone(original)
  kindTamper.resources.find((resource) => resource.kind === 'gitIndex').kind = 'worktreeConfig'
  fs.writeFileSync(journalPath, `${JSON.stringify(kindTamper, null, 2)}\n`)
  await assert.rejects(model.adapter.recover({
    worktree: model.root, identity: model.identity, durable: null, guard: lease,
    pin: null, stateRevision: 1
  }), (error) => error?.code === 'STATE_CORRUPT')

  const commonTamper = structuredClone(original)
  commonTamper.resources.splice(1, 0, {
    disposition: 'publish', kind: 'commonConfig', target: commonConfig,
    before: sha(commonBefore), after: sha('foreign common after'),
    stageName: 'common-config', backupName: 'common-config'
  })
  fs.writeFileSync(journalPath, `${JSON.stringify(commonTamper, null, 2)}\n`)
  await assert.rejects(model.adapter.recover({
    worktree: model.root, identity: model.identity, durable: null, guard: lease,
    pin: null, stateRevision: 1
  }), (error) => error?.code === 'STATE_CORRUPT')
  assert.equal(fs.existsSync(`${commonConfig}.lock`), false)
  assert.equal(model.identityResolutionCount(sibling), 0)
  assert.deepEqual(fs.readFileSync(commonConfig), commonBefore)
  assert.equal(fs.existsSync(journalPath), true)
  assert.ok(prepared.marker)
})

test('hostile Git environment is scrubbed and relative worktree config is replaced under config.lock', async (t) => {
  const model = fixture(t)
  const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-hostile-git-'))
  t.after(() => fs.rmSync(foreign, { recursive: true, force: true }))
  git(foreign, ['init', '--quiet'])
  git(foreign, ['config', 'user.email', 'fixture@example.invalid'])
  git(foreign, ['config', 'user.name', 'Fixture'])
  fs.writeFileSync(path.join(foreign, 'foreign.txt'), 'foreign\n')
  git(foreign, ['add', 'foreign.txt'])
  git(foreign, ['commit', '--quiet', '-m', 'foreign'])
  const foreignHead = git(foreign, ['rev-parse', 'HEAD']).trim()

  git(model.root, ['config', 'extensions.worktreeConfig', 'yes'])
  git(model.root, ['config', '--worktree', 'core.hooksPath', 'overlay/hooks'])
  git(model.root, ['config', '--worktree', 'ozdqp.localOverlaySource', '.'])
  const prior = Object.fromEntries(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CONFIG_GLOBAL']
    .map((name) => [name, process.env[name]]))
  process.env.GIT_DIR = path.join(foreign, '.git')
  process.env.GIT_WORK_TREE = foreign
  process.env.GIT_INDEX_FILE = path.join(foreign, '.git', 'index')
  process.env.GIT_CONFIG_GLOBAL = path.join(foreign, 'hostile-global-config')
  t.after(() => {
    for (const [name, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  const snapshotFiles = { 'AGENTS.override.md': 'hostile-v1\n' }
  const runtimeFiles = { 'HubLib.ps1': 'hostile-runtime\n' }
  const snapshot = manifest(snapshotFiles, 'library-hostile')
  const runtimeAsset = runtime(runtimeFiles, 'runtime-hostile')
  model.registerSnapshot(snapshot, snapshotFiles)
  model.registerRuntime(runtimeAsset, runtimeFiles)
  const plan = await approvedPlan(model, snapshot, runtimeAsset, [], null)
  const prepared = await model.adapter.prepare({ worktree: model.root, identity: model.identity, guard: lease, plan, snapshot, runtimeAsset })
  const worktreeConfig = path.resolve(model.root, git(model.root, ['rev-parse', '--git-path', 'config.worktree']).trim())
  fs.writeFileSync(`${worktreeConfig}.lock`, 'foreign git config process\n')
  await assert.rejects(prepared.participant.publish(lease), (error) => error?.code === 'LOCK_BUSY')
  assert.equal(fs.existsSync(path.join(model.root, 'AGENTS.override.md')), false)
  fs.unlinkSync(`${worktreeConfig}.lock`)
  await prepared.participant.publish(lease)
  await prepared.participant.finalize(lease)

  assert.equal(git(model.root, ['config', '--worktree', '--get', 'core.hooksPath']).trim(), path.join(model.packageRoot, 'overlay', 'hooks'))
  assert.equal(git(model.root, ['config', '--worktree', '--get', 'ozdqp.localOverlaySource']).trim(), model.packageRoot)
  assert.equal(git(model.root, ['config', '--worktree', '--get', 'ozdqp.skillWatchWorkspace']).trim(), model.dataRoot)
  assert.equal(path.isAbsolute(git(model.root, ['config', '--worktree', '--get', 'core.excludesFile']).trim()), true)
  assert.equal(git(foreign, ['rev-parse', 'HEAD']).trim(), foreignHead)
})

test('physical invalid marker documents are never treated as a missing marker', async (t) => {
  const model = fixture(t)
  const snapshotFiles = { 'AGENTS.override.md': 'marker-v1\n' }
  const runtimeFiles = { 'HubLib.ps1': 'marker-runtime\n' }
  const snapshot = manifest(snapshotFiles, 'library-marker')
  const runtimeAsset = runtime(runtimeFiles, 'runtime-marker')
  model.registerSnapshot(snapshot, snapshotFiles)
  model.registerRuntime(runtimeAsset, runtimeFiles)
  const marker = path.resolve(model.root, git(model.root, ['rev-parse', '--git-path', 'skill-graft/materialized-v1.json']).trim())
  fs.mkdirSync(path.dirname(marker), { recursive: true })
  for (const invalid of ['null\n', '[]\n', '{broken\n', '{"schemaVersion":99}\n']) {
    fs.writeFileSync(marker, invalid)
    const inspection = await model.adapter.inspect({
      worktree: model.root, identity: model.identity, snapshot, runtimeAsset, selectedSkills: []
    })
    assert.notEqual(inspection.observedMarker, null)
    await assert.rejects(model.adapter.recover({
      worktree: model.root, identity: model.identity, durable: null, guard: lease,
      pin: null, stateRevision: 1
    }), (error) => error?.code === 'STATE_CORRUPT')
  }
  fs.unlinkSync(marker)
  assert.deepEqual(await model.adapter.recover({
    worktree: model.root, identity: model.identity, durable: null, guard: lease,
    pin: null, stateRevision: 1
  }), { status: 'clean', recoveredTransactions: 0 })
  await assert.rejects(model.adapter.recover({
    worktree: model.root, identity: model.identity, durable: null, guard: lease,
    pin: pinFor(model, snapshot, [], null), stateRevision: null
  }), (error) => error?.code === 'STATE_CORRUPT')
})

test('ordinary prepare never auto-enables worktree config and writes no transaction when setup is disabled', async (t) => {
  const model = fixture(t)
  const snapshotFiles = { 'AGENTS.override.md': 'setup-v1\n' }
  const runtimeFiles = { 'HubLib.ps1': 'setup-runtime\n' }
  const snapshot = manifest(snapshotFiles, 'library-setup')
  const runtimeAsset = runtime(runtimeFiles, 'runtime-setup')
  model.registerSnapshot(snapshot, snapshotFiles)
  model.registerRuntime(runtimeAsset, runtimeFiles)
  const plan = await approvedPlan(model, snapshot, runtimeAsset, [], null)
  git(model.root, ['config', 'extensions.worktreeConfig', 'false'])
  await assert.rejects(
    model.adapter.prepare({ worktree: model.root, identity: model.identity, guard: lease, plan, snapshot, runtimeAsset }),
    (error) => error?.code === 'UNSUPPORTED_LAYOUT'
  )
  assert.equal(git(model.root, ['config', '--bool', '--get', 'extensions.worktreeConfig']).trim(), 'false')
  const graft = path.resolve(model.root, git(model.root, ['rev-parse', '--git-path', 'skill-graft']).trim())
  assert.equal(fs.existsSync(graft), false)
})

test('reserved private-exclude sentinel lines make LF and CRLF base projections non-executable', async (t) => {
  const cases = [
    ['LF begin', '# skill-graft managed excludes v1 begin\nforeign.tmp\n'],
    ['CRLF end', 'foreign.tmp\r\n# skill-graft managed excludes v1 end\r\n']
  ]
  for (const [name, baseBytes] of cases) {
    await t.test(name, async (child) => {
      const model = fixture(child)
      const slug = name.toLowerCase().replaceAll(' ', '-')
      const base = path.join(model.root, `.fixture-reserved-${slug}`)
      fs.writeFileSync(base, baseBytes)
      git(model.root, ['config', 'core.excludesFile', base])
      const snapshotFiles = { 'AGENTS.override.md': 'reserved-base\n' }
      const runtimeFiles = { 'HubLib.ps1': 'reserved-runtime\n' }
      const snapshot = manifest(snapshotFiles, `library-reserved-${slug}`)
      const runtimeAsset = runtime(runtimeFiles, `runtime-reserved-${slug}`)
      model.registerSnapshot(snapshot, snapshotFiles)
      model.registerRuntime(runtimeAsset, runtimeFiles)
      const inspection = await model.adapter.inspect({
        worktree: model.root, identity: model.identity, snapshot, runtimeAsset, selectedSkills: []
      })
      const result = planMaterialization({
        pathKey: model.identity.pathKey,
        worktreeId: model.identity.worktreeId,
        stateRevision: 1,
        pin: pinFor(model, snapshot, [], null),
        snapshot,
        runtimeAsset,
        durableMarker: null,
        observedMarker: inspection.observedMarker,
        currentVisibilityState: inspection.currentVisibilityState,
        desiredVisibilityState: inspection.desiredVisibilityState,
        observations: inspection.observations,
        gitFacts: inspection.gitFacts,
        gitConfiguration: inspection.gitConfiguration
      })
      assert.equal(result.ok, true, JSON.stringify(result))
      assert.equal(result.plan.executable, false)
      assert.equal(result.plan.git.configuration.action, 'conflict')
      assert.equal(result.plan.git.configuration.conflictKind, 'excludeBaseUnsafe')
      assert.equal(fs.existsSync(gitPath(model.root, 'skill-graft/transactions')), false)
    })
  }
})

test('cross-volume linked worktree layout fails before creating Git-admin transaction state', { skip: !fs.existsSync('E:\\') }, async (t) => {
  const model = fixture(t)
  if (path.parse(model.root).root.toLowerCase() === 'e:\\') t.skip('fixture already resides on E:')
  const cross = `E:\\skill-graft-cross-volume-${process.pid}-${Date.now()}`
  t.after(() => fs.rmSync(cross, { recursive: true, force: true }))
  git(model.root, ['worktree', 'add', '--quiet', '--detach', cross, 'HEAD'])
  const identity = { pathKey: sha(path.resolve(cross).toLowerCase()), worktreeId: 'worktree:cross-volume' }
  model.registerIdentity(cross, identity)
  const snapshotFiles = { 'AGENTS.override.md': 'cross-v1\n' }
  const runtimeFiles = { 'HubLib.ps1': 'cross-runtime\n' }
  const snapshot = manifest(snapshotFiles, 'library-cross')
  const runtimeAsset = runtime(runtimeFiles, 'runtime-cross')
  model.registerSnapshot(snapshot, snapshotFiles)
  model.registerRuntime(runtimeAsset, runtimeFiles)
  const admin = git(cross, ['rev-parse', '--absolute-git-dir']).trim()
  await assert.rejects(model.adapter.inspect({
    worktree: cross, identity, snapshot, runtimeAsset, selectedSkills: []
  }), (error) => error?.code === 'UNSUPPORTED_LAYOUT')
  assert.equal(fs.existsSync(path.join(admin, 'skill-graft')), false)
})

test('recovery cleans prepare orphans and resumes lease loss after finalize tombstone publication', async (t) => {
  let revokeFinalize = false
  let finalizeRevoked = false
  const model = fixture(t, {
    checkpoint(step) {
      if (revokeFinalize && step === 'materializer-after-finalize-tombstone') finalizeRevoked = true
    }
  })
  const transactions = path.resolve(model.root, git(model.root, ['rev-parse', '--git-path', 'skill-graft/transactions']).trim())
  const orphan = path.join(transactions, '.prepare-orphan-0000000000000001')
  fs.mkdirSync(path.join(orphan, 'staging'), { recursive: true })
  fs.writeFileSync(path.join(orphan, 'staging', 'partial'), 'partial\n')
  assert.deepEqual(await model.adapter.recover({
    worktree: model.root, identity: model.identity, durable: null, guard: lease,
    pin: null, stateRevision: 1
  }), { status: 'rolled-back', recoveredTransactions: 1 })
  assert.equal(fs.existsSync(orphan), false)

  const snapshotFiles = { 'AGENTS.override.md': 'finalize-v1\n' }
  const runtimeFiles = { 'HubLib.ps1': 'finalize-runtime\n' }
  const snapshot = manifest(snapshotFiles, 'library-finalize')
  const runtimeAsset = runtime(runtimeFiles, 'runtime-finalize')
  model.registerSnapshot(snapshot, snapshotFiles)
  model.registerRuntime(runtimeAsset, runtimeFiles)
  const plan = await approvedPlan(model, snapshot, runtimeAsset, [], null)
  const prepared = await model.adapter.prepare({ worktree: model.root, identity: model.identity, guard: lease, plan, snapshot, runtimeAsset })
  await prepared.participant.publish(lease)
  revokeFinalize = true
  const finalizeGuard = { async revalidateLease() { if (finalizeRevoked) throw new LostLease() } }
  await assert.rejects(prepared.participant.finalize(finalizeGuard), (error) => error?.code === 'LOCK_NOT_OWNED')
  assert.equal(fs.readdirSync(transactions).some((name) => name.startsWith('.finalize-')), true)
  const durable = { schemaVersion: 1, pathKey: model.identity.pathKey, marker: prepared.marker }
  assert.deepEqual(await model.adapter.recover({
    worktree: model.root, identity: model.identity, durable, guard: lease,
    pin: pinFor(model, snapshot, [], snapshot.snapshotId), stateRevision: 2
  }), { status: 'finalized', recoveredTransactions: 1 })
})

test('release restores the tracked baseline and removes only the owned private exclusion', async (t) => {
  const model = fixture(t)
  const tracked = path.join(model.root, '.agents', 'skills', 'release-skill', 'tracked.txt')
  fs.mkdirSync(path.dirname(tracked), { recursive: true })
  fs.writeFileSync(tracked, 'tracked-baseline\n')
  git(model.root, ['add', '.agents/skills/release-skill/tracked.txt'])
  git(model.root, ['commit', '--quiet', '-m', 'tracked baseline'])
  fs.rmSync(path.dirname(tracked), { recursive: true, force: true })

  const snapshotFiles = {
    'AGENTS.override.md': 'release-override\n',
    'skills/adopted/release-skill/SKILL.md': 'release-skill\n',
    'skills/adopted/release-skill/tracked.txt': 'tracked-baseline\n'
  }
  const runtimeFiles = { 'HubLib.ps1': 'release-runtime\n' }
  const snapshot = manifest(snapshotFiles, 'library-release')
  const runtimeAsset = runtime(runtimeFiles, 'runtime-release')
  model.registerSnapshot(snapshot, snapshotFiles)
  model.registerRuntime(runtimeAsset, runtimeFiles)

  const firstPlan = await approvedPlan(model, snapshot, runtimeAsset, ['release-skill'], null)
  const first = await model.adapter.prepare({
    worktree: model.root, identity: model.identity, guard: lease, plan: firstPlan, snapshot, runtimeAsset
  })
  await first.participant.publish(lease)
  await first.participant.finalize(lease)
  assert.match(git(model.root, ['ls-files', '-v', '--', '.agents/skills/release-skill/tracked.txt']), /^S /)
  assert.match(fs.readFileSync(gitPath(model.root, 'skill-graft/excludes-v1'), 'utf8'), /\/\.agents\/skills\/release-skill/)

  const durable = { schemaVersion: 1, pathKey: model.identity.pathKey, marker: first.marker }
  const releasePlan = await approvedPlan(
    model, snapshot, runtimeAsset, [], durable, snapshot.snapshotId, 2
  )
  const releaseOperation = releasePlan.git.operations.find((operation) => (
    operation.targetRelativePath === '.agents/skills/release-skill'
  ))
  assert.equal(releaseOperation?.action, 'release')
  const released = await model.adapter.prepare({
    worktree: model.root, identity: model.identity, guard: lease, plan: releasePlan, snapshot, runtimeAsset
  })
  await released.participant.publish(lease)
  assert.match(git(model.root, ['ls-files', '-v', '--', '.agents/skills/release-skill/tracked.txt']), /^H /)
  assert.doesNotMatch(
    fs.readFileSync(gitPath(model.root, 'skill-graft/excludes-v1'), 'utf8'),
    /\/\.agents\/skills\/release-skill/
  )
  assert.equal(fs.existsSync(path.dirname(tracked)), false)
  assert.notEqual(released.marker.visibilityStateId, first.marker.visibilityStateId)
  await released.participant.finalize(lease)
})

test('base exclude projection preserves unrelated visibility and stale plans refuse base drift', async (t) => {
  const model = fixture(t)
  const base = path.join(model.root, '.fixture-base-ignore')
  const sentinelA = path.join(model.root, 'sentinel-a.tmp')
  const sentinelB = path.join(model.root, 'sentinel-b.tmp')
  const sentinelC = path.join(model.root, 'sentinel-c.tmp')
  fs.writeFileSync(base, 'sentinel-a.tmp\n')
  fs.writeFileSync(sentinelA, 'a\n')
  fs.writeFileSync(sentinelB, 'b\n')
  fs.writeFileSync(sentinelC, 'c\n')
  git(model.root, ['config', 'core.excludesFile', base])
  assert.match(git(model.root, ['check-ignore', '-v', 'sentinel-a.tmp']), /sentinel-a\.tmp/)

  const snapshotFiles = { 'AGENTS.override.md': 'base-drift\n' }
  const runtimeFiles = { 'HubLib.ps1': 'base-runtime\n' }
  const snapshot = manifest(snapshotFiles, 'library-base-drift')
  const runtimeAsset = runtime(runtimeFiles, 'runtime-base-drift')
  model.registerSnapshot(snapshot, snapshotFiles)
  model.registerRuntime(runtimeAsset, runtimeFiles)
  const firstPlan = await approvedPlan(model, snapshot, runtimeAsset, [], null)
  const first = await model.adapter.prepare({
    worktree: model.root, identity: model.identity, guard: lease, plan: firstPlan, snapshot, runtimeAsset
  })
  await first.participant.publish(lease)
  await first.participant.finalize(lease)
  assert.match(git(model.root, ['check-ignore', '-v', 'sentinel-a.tmp']), /sentinel-a\.tmp/)

  fs.writeFileSync(base, 'sentinel-a.tmp\nsentinel-b.tmp\n')
  const durable = { schemaVersion: 1, pathKey: model.identity.pathKey, marker: first.marker }
  const stalePlan = await approvedPlan(
    model, snapshot, runtimeAsset, [], durable, snapshot.snapshotId, 2
  )
  assert.ok(stalePlan.git.configuration.effects.includes('refreshExcludeProjection'))
  fs.writeFileSync(base, 'sentinel-a.tmp\nsentinel-b.tmp\nsentinel-c.tmp\n')
  await assert.rejects(model.adapter.prepare({
    worktree: model.root, identity: model.identity, guard: lease, plan: stalePlan, snapshot, runtimeAsset
  }), /visibility ownership state changed after planning/)

  const refreshedPlan = await approvedPlan(
    model, snapshot, runtimeAsset, [], durable, snapshot.snapshotId, 3
  )
  const refreshed = await model.adapter.prepare({
    worktree: model.root, identity: model.identity, guard: lease, plan: refreshedPlan, snapshot, runtimeAsset
  })
  await refreshed.participant.publish(lease)
  assert.match(git(model.root, ['check-ignore', '-v', 'sentinel-a.tmp']), /sentinel-a\.tmp/)
  assert.match(git(model.root, ['check-ignore', '-v', 'sentinel-b.tmp']), /sentinel-b\.tmp/)
  assert.match(git(model.root, ['check-ignore', '-v', 'sentinel-c.tmp']), /sentinel-c\.tmp/)
  await refreshed.participant.finalize(lease)
})

test('an existing unmanaged exact target remains project-owned and conflicts', async (t) => {
  const model = fixture(t)
  const snapshotFiles = { 'AGENTS.override.md': 'project-exact\n' }
  const runtimeFiles = { 'HubLib.ps1': 'project-runtime\n' }
  const snapshot = manifest(snapshotFiles, 'library-project-exact')
  const runtimeAsset = runtime(runtimeFiles, 'runtime-project-exact')
  model.registerSnapshot(snapshot, snapshotFiles)
  model.registerRuntime(runtimeAsset, runtimeFiles)
  fs.writeFileSync(path.join(model.root, 'AGENTS.override.md'), snapshotFiles['AGENTS.override.md'])
  const inspection = await model.adapter.inspect({
    worktree: model.root, identity: model.identity, snapshot, runtimeAsset, selectedSkills: []
  })
  const result = planMaterialization({
    pathKey: model.identity.pathKey,
    worktreeId: model.identity.worktreeId,
    stateRevision: 1,
    pin: pinFor(model, snapshot, [], null),
    snapshot,
    runtimeAsset,
    durableMarker: null,
    observedMarker: inspection.observedMarker,
    currentVisibilityState: inspection.currentVisibilityState,
    desiredVisibilityState: inspection.desiredVisibilityState,
    observations: inspection.observations,
    gitFacts: inspection.gitFacts,
    gitConfiguration: inspection.gitConfiguration
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.plan.executable, false)
  assert.equal(result.plan.operations.find((operation) => operation.targetRelativePath === 'AGENTS.override.md')?.conflict?.kind, 'unowned-content')
  assert.equal(fs.existsSync(gitPath(model.root, 'skill-graft/transactions')), false)
})
