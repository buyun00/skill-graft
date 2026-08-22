import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const transpiledRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-p3-legacy-planners-'))

function sourceFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(root, entry.name)
    return entry.isDirectory() ? sourceFiles(absolute) : entry.name.endsWith('.ts') ? [absolute] : []
  })
}

for (const layer of ['contracts', 'core']) {
  for (const sourceFile of sourceFiles(path.join(repoRoot, 'src', layer))) {
    const relative = path.relative(path.join(repoRoot, 'src'), sourceFile)
    const targetFile = path.join(transpiledRoot, relative).replace(/\.ts$/iu, '.js')
    const output = ts.transpileModule(fs.readFileSync(sourceFile, 'utf8'), {
      fileName: sourceFile,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ES2022,
        verbatimModuleSyntax: true
      }
    }).outputText
    fs.mkdirSync(path.dirname(targetFile), { recursive: true })
    fs.writeFileSync(targetFile, output, 'utf8')
  }
}
fs.writeFileSync(path.join(transpiledRoot, 'package.json'), '{"type":"module"}\n', 'utf8')

const contracts = await import(pathToFileURL(path.join(transpiledRoot, 'contracts', 'index.js')).href)
const core = await import(pathToFileURL(path.join(transpiledRoot, 'core', 'index.js')).href)
test.after(() => fs.rmSync(transpiledRoot, { recursive: true, force: true }))

const PATH_KEY = sha('legacy-path')
const WORKTREE_ID = 'worktree:legacy-probe'

function sha(value) {
  return `sha256:${createHash('sha256').update(String(value), 'utf8').digest('hex')}`
}

function fileFact(filePath, contents, mode = '100644') {
  return {
    path: filePath,
    size: Buffer.byteLength(contents),
    sha256: sha(contents),
    mode,
    isReparsePoint: false
  }
}

function sources() {
  const snapshot = core.createLibrarySnapshotManifest({
    source: { kind: 'library', id: 'legacy-library', revision: 'legacy-revision' },
    createdAt: '2030-01-02T03:04:05.000Z',
    files: [fileFact('AGENTS.override.md', 'override')]
  })
  const runtimeAsset = core.createRuntimeAssetManifest({
    runtimeRevision: 'runtime-legacy',
    files: [fileFact('hooks/post-checkout', 'hook', '100755')]
  })
  assert.equal(snapshot.ok, true, JSON.stringify(snapshot))
  assert.equal(runtimeAsset.ok, true, JSON.stringify(runtimeAsset))
  const provisional = core.buildDesiredMaterialization({
    snapshot: snapshot.manifest,
    runtimeAsset: runtimeAsset.manifest,
    selectedSkills: [],
    visibilityStateId: sha('provisional-visibility')
  })
  assert.equal(provisional.ok, true, JSON.stringify(provisional))
  const visibility = core.createVisibilityOwnershipState({
    privateStateId: sha('visibility-private-state'),
    pathKey: PATH_KEY,
    worktreeId: WORKTREE_ID,
    baseExclude: {
      scope: 'global',
      valueId: valueId('base-exclude'),
      contentDigest: sha('base-exclude-content')
    },
    targets: provisional.desired.artifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      owner: artifact.owner,
      targetRelativePath: artifact.targetRelativePath,
      baselineKind: 'missing',
      trackedPaths: artifact.kind === 'file'
        ? [{ path: artifact.targetRelativePath, skipWorktree: false }]
        : [
            { path: `${artifact.targetRelativePath}/tracked-a`, skipWorktree: false },
            { path: `${artifact.targetRelativePath}/tracked-b`, skipWorktree: true }
          ],
      ignoreOrigin: 'legacyCommon',
      privateExcluded: false
    }))
  })
  assert.equal(visibility.ok, true, JSON.stringify(visibility))
  const restoreVisibility = core.createVisibilityOwnershipState({
    privateStateId: sha('restore-visibility-private-state'),
    pathKey: PATH_KEY,
    worktreeId: WORKTREE_ID,
    baseExclude: visibility.state.baseExclude,
    targets: []
  })
  assert.equal(restoreVisibility.ok, true, JSON.stringify(restoreVisibility))
  const desired = core.buildDesiredMaterialization({
    snapshot: snapshot.manifest,
    runtimeAsset: runtimeAsset.manifest,
    selectedSkills: [],
    visibilityStateId: visibility.state.visibilityStateId
  })
  assert.equal(desired.ok, true, JSON.stringify(desired))
  return {
    snapshot: snapshot.manifest,
    runtimeAsset: runtimeAsset.manifest,
    desired: desired.desired,
    visibilityState: visibility.state,
    restoreVisibilityState: restoreVisibility.state
  }
}

function pin(snapshotId, materializedSnapshot = null) {
  return {
    schemaVersion: 1,
    pathKey: PATH_KEY,
    worktreeId: WORKTREE_ID,
    requestedSnapshot: snapshotId,
    materializedSnapshot,
    selectedSkills: [],
    claimState: 'claimed'
  }
}

function valueId(value) {
  return core.gitMaterializationConfigurationValueId(value)
}

function configuration(options = {}) {
  const siblings = core.createGitMaterializationSiblingProof(options.siblings ?? [])
  assert.equal(siblings.ok, true, JSON.stringify(siblings))
  return core.createGitMaterializationConfigurationFact({
    isLinkedWorktree: true,
    supportsWorktreeConfig: options.supportsWorktreeConfig ?? true,
    worktreeConfigEnabled: options.worktreeConfigEnabled ?? true,
    hooksPathValueId: valueId(options.hooksPath ?? 'desired-hooks'),
    desiredHooksPathValueId: valueId('desired-hooks'),
    overlaySourceValueId: valueId(options.overlaySource ?? 'desired-overlay'),
    desiredOverlaySourceValueId: valueId('desired-overlay'),
    watchWorkspaceValueId: valueId(options.watchWorkspace ?? 'desired-watch-workspace'),
    desiredWatchWorkspaceValueId: valueId('desired-watch-workspace'),
    excludesFileValueId: valueId(options.excludesFile ?? 'desired-excludes'),
    desiredExcludesFileValueId: valueId('desired-excludes'),
    baseExcludeSafe: options.baseExcludeSafe ?? true,
    baseExcludeValueId: valueId('base-exclude'),
    baseExcludeContentDigest: sha('base-exclude-content'),
    privateExcludeContentDigest: valueId(options.privateExclude ?? 'desired-private-exclude'),
    desiredPrivateExcludeContentDigest: valueId('desired-private-exclude'),
    commonInfoExcludeDigest: valueId(options.commonInfoExclude ?? 'clean-common'),
    cleanCommonInfoExcludeDigest: valueId('clean-common'),
    ...siblings.proof
  })
}

function visibilityFact(artifact, options = {}) {
  const trackedPaths = options.trackedPaths ?? (artifact.kind === 'file'
    ? [{ path: artifact.targetRelativePath, skipWorktree: options.skipped ?? false }]
    : [
        { path: `${artifact.targetRelativePath}/tracked-a`, skipWorktree: options.skipped ?? false },
        { path: `${artifact.targetRelativePath}/tracked-b`, skipWorktree: options.secondSkipped ?? true }
      ])
  const result = core.createGitVisibilityFact({
    targetRelativePath: artifact.targetRelativePath,
    trackedPaths,
    ignored: options.ignored ?? false,
    ignoreOrigin: options.ignoreOrigin ?? 'none',
    privateExcluded: options.privateExcluded ?? false,
    ownership: options.ownership ?? 'unmanaged',
    ownershipStateId: options.ownershipStateId ?? null,
    baselineDigest: options.baselineDigest ?? core.visibilityOwnershipTargetBaselineDigest({
      artifactId: artifact.artifactId,
      owner: artifact.owner,
      targetRelativePath: artifact.targetRelativePath,
      baselineKind: 'missing',
      trackedPaths,
      ignoreOrigin: options.ignoreOrigin ?? 'none',
      privateExcluded: options.privateExcluded ?? false
    }),
    restoreDigest: options.ownership === 'managed'
      ? options.restoreDigest ?? sha(`restore:${artifact.targetRelativePath}`)
      : null,
    restoreSafe: options.restoreSafe ?? true
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  return result.fact
}

function legacyArtifactFact(artifact, mode = 'link') {
  const after = { digest: artifact.digest, source: artifact.source }
  if (mode === 'missing') {
    return {
      artifactId: artifact.artifactId,
      owner: artifact.owner,
      targetRelativePath: artifact.targetRelativePath,
      kind: artifact.kind,
      observedKind: 'missing',
      digest: null,
      isReparsePoint: false,
      legacyKind: null,
      sourceArtifactId: null,
      pathEscaped: false,
      protected: false
    }
  }
  if (mode === 'plain') {
    return {
      artifactId: artifact.artifactId,
      owner: artifact.owner,
      targetRelativePath: artifact.targetRelativePath,
      kind: artifact.kind,
      observedKind: artifact.kind,
      digest: artifact.digest,
      isReparsePoint: false,
      legacyKind: null,
      sourceArtifactId: null,
      pathEscaped: false,
      protected: false
    }
  }
  return {
    artifactId: artifact.artifactId,
    owner: artifact.owner,
    targetRelativePath: artifact.targetRelativePath,
    kind: artifact.kind,
    observedKind: artifact.kind === 'file' ? 'hardlink' : 'junction',
    digest: artifact.digest,
    isReparsePoint: artifact.kind === 'directory',
    legacyKind: artifact.kind === 'file' ? 'fileHardlink' : 'directoryLink',
    sourceArtifactId: core.materializationSourceArtifactId(after),
    pathEscaped: false,
    protected: false
  }
}

function migrationInput(source, options = {}) {
  return {
    pathKey: PATH_KEY,
    worktreeId: WORKTREE_ID,
    stateRevision: options.stateRevision ?? 11,
    pin: options.pin ?? pin(source.snapshot.snapshotId),
    snapshot: source.snapshot,
    runtimeAsset: source.runtimeAsset,
    durableMarker: options.durableMarker ?? null,
    observedMarker: options.observedMarker ?? null,
    currentVisibilityState: Object.hasOwn(options, 'currentVisibilityState')
      ? options.currentVisibilityState
      : options.observedMarker ? source.visibilityState : null,
    desiredVisibilityState: options.desiredVisibilityState ?? source.visibilityState,
    backupPrivateStateId: options.backupPrivateStateId ?? sha('legacy-private-backup-state'),
    migrationRecord: options.migrationRecord ?? null,
    artifacts: options.artifacts ?? source.desired.artifacts.map((artifact) => legacyArtifactFact(artifact)),
    gitFacts: options.gitFacts ?? source.desired.artifacts.map((artifact) => visibilityFact(artifact, {
      ignored: true,
      ignoreOrigin: 'legacyCommon'
    })),
    gitConfiguration: options.gitConfiguration ?? configuration({
      worktreeConfigEnabled: true,
      hooksPath: 'legacy-hooks',
      overlaySource: 'legacy-overlay',
      excludesFile: 'legacy-excludes',
      commonInfoExclude: 'owned-legacy-lines'
    })
  }
}

function markerFromMigration(source, plan) {
  return {
    schemaVersion: 1,
    materializationId: plan.requested.materializationId,
    planHash: plan.planHash,
    pathKey: PATH_KEY,
    worktreeId: WORKTREE_ID,
    snapshotId: source.snapshot.snapshotId,
    selectedSkills: [],
    runtimeRevision: source.runtimeAsset.runtimeRevision,
    runtimeAssetId: source.runtimeAsset.runtimeAssetId,
    visibilityStateId: plan.requested.visibilityStateId,
    origin: { kind: 'legacyMigration', migrationId: plan.migrationId },
    artifacts: source.desired.artifacts.map(({ artifactId, owner, targetRelativePath, kind, digest }) => ({
      artifactId, owner, targetRelativePath, kind, digest
    }))
  }
}

function recordFromMigration(plan) {
  return {
    schemaVersion: 1,
    migrationId: plan.migrationId,
    planHash: plan.planHash,
    pathKey: plan.pathKey,
    worktreeId: plan.worktreeId,
    status: 'committed',
    snapshotId: plan.requested.snapshotId,
    materializationId: plan.requested.materializationId,
    visibilityStateId: plan.requested.visibilityStateId,
    backupManifestId: plan.backupManifestId,
    backupPrivateStateId: plan.backupPrivateStateId,
    artifacts: plan.operations
      .filter((operation) => operation.action === 'replaceWithCopy')
      .map((operation) => ({
        artifactId: operation.artifactId,
        owner: operation.owner,
        targetRelativePath: operation.targetRelativePath,
        kind: operation.kind,
        legacyKind: operation.legacy.legacyKind,
        sourceArtifactId: operation.legacy.sourceArtifactId,
        beforeDigest: operation.before.digest,
        afterDigest: operation.after.digest
      })),
    createdArtifacts: plan.operations
      .filter((operation) => operation.action === 'create')
      .map((operation) => ({
        artifactId: operation.artifactId,
        owner: operation.owner,
        targetRelativePath: operation.targetRelativePath,
        kind: operation.kind,
        digest: operation.after.digest
      })),
    gitVisibilityDigest: plan.gitBeforeDigest
  }
}

function restoreSources(record, status = 'valid') {
  return record.artifacts.map((artifact) => ({
    artifactId: artifact.artifactId,
    targetRelativePath: artifact.targetRelativePath,
    legacyKind: artifact.legacyKind,
    sourceArtifactId: artifact.sourceArtifactId,
    sourceStateId: sha(`restore-source:${artifact.targetRelativePath}:${status}`),
    status
  }))
}

test('Git visibility creator freezes compound tracked/untracked effects without leaking inner paths', () => {
  const source = sources()
  const artifact = source.desired.artifacts.find((entry) => entry.kind === 'directory')
  const fact = visibilityFact(artifact)
  assert.deepEqual(
    {
      trackedCount: fact.trackedCount,
      skippedTrackedCount: fact.skippedTrackedCount,
      ignored: fact.ignored,
      ignoreOrigin: fact.ignoreOrigin,
      privateExcluded: fact.privateExcluded
    },
    { trackedCount: 2, skippedTrackedCount: 1, ignored: false, ignoreOrigin: 'none', privateExcluded: false }
  )
  assert.notEqual(fact.factDigest, fact.desiredDigest)
  assert.equal(JSON.stringify(fact).includes('/tracked-a'), false)
  assert.equal(core.createGitVisibilityFact({
    targetRelativePath: artifact.targetRelativePath,
    trackedPaths: [
      { path: `${artifact.targetRelativePath}/Case`, skipWorktree: false },
      { path: `${artifact.targetRelativePath}/case`, skipWorktree: true }
    ],
    ignored: false,
    ignoreOrigin: 'none',
    privateExcluded: false
  }).ok, false)
})

test('sibling visibility proof is locator-free, canonical, exhaustive, and fail-closed', () => {
  const first = {
    siblingPathKey: sha('sibling-a'),
    visibilityDigest: sha('visibility-a'),
    equivalentlyHidden: true
  }
  const second = {
    siblingPathKey: sha('sibling-b'),
    visibilityDigest: sha('visibility-b'),
    equivalentlyHidden: true
  }
  const none = core.createGitMaterializationSiblingProof([])
  assert.equal(none.ok, true)
  assert.equal(none.proof.legacyCommonSiblingSafety, 'noSiblings')
  const ordered = core.createGitMaterializationSiblingProof([first, second])
  const reversed = core.createGitMaterializationSiblingProof([second, first])
  assert.deepEqual(reversed, ordered)
  assert.equal(ordered.proof.legacyCommonSiblingSafety, 'equivalentlyHidden')
  const unsafe = core.createGitMaterializationSiblingProof([
    first,
    { ...second, equivalentlyHidden: false }
  ])
  assert.equal(unsafe.ok, true)
  assert.equal(unsafe.proof.legacyCommonSiblingSafety, 'unsafe')
  assert.notEqual(unsafe.proof.siblingFactsDigest, ordered.proof.siblingFactsDigest)
  assert.equal(core.createGitMaterializationSiblingProof([first, first]).ok, false)
  assert.equal(core.createGitMaterializationSiblingProof([{
    ...first,
    siblingPathKey: 'C:/raw/sibling'
  }]).ok, false)
  assert.doesNotMatch(JSON.stringify(ordered.proof), /sibling-a|visibility-a|[A-Z]:[\\/]/u)
})

test('normal sync plans compound effects but refuses owned common info/exclude cleanup', () => {
  const source = sources()
  const input = migrationInput(source)
  const normal = core.planMaterialization({
    pathKey: PATH_KEY,
    worktreeId: WORKTREE_ID,
    stateRevision: input.stateRevision,
    pin: input.pin,
    snapshot: input.snapshot,
    runtimeAsset: input.runtimeAsset,
    durableMarker: null,
    observedMarker: null,
    currentVisibilityState: null,
    desiredVisibilityState: source.visibilityState,
    observations: source.desired.artifacts.map((artifact) => ({
      targetRelativePath: artifact.targetRelativePath,
      kind: 'missing',
      isReparsePoint: false
    })),
    gitFacts: input.gitFacts,
    gitConfiguration: input.gitConfiguration
  })
  assert.equal(normal.ok, true, JSON.stringify(normal))
  assert.ok(normal.plan.git.operations.some((operation) => operation.action === 'setSkipAndExclude'))
  assert.deepEqual(normal.plan.git.configuration, {
    action: 'conflict',
    beforeDigest: input.gitConfiguration.currentDigest,
    afterDigest: input.gitConfiguration.currentDigest,
    effects: [],
    conflictKind: 'legacyCommonInfoExclude',
    siblingFactsDigest: input.gitConfiguration.siblingFactsDigest
  })
  assert.equal(normal.plan.executable, false)

  const freshConfiguration = configuration({
    worktreeConfigEnabled: false,
    hooksPath: 'unset-hooks',
    overlaySource: 'unset-overlay',
    excludesFile: 'unset-excludes'
  })
  const fresh = core.planMaterialization({
    pathKey: PATH_KEY,
    worktreeId: WORKTREE_ID,
    stateRevision: input.stateRevision,
    pin: input.pin,
    snapshot: input.snapshot,
    runtimeAsset: input.runtimeAsset,
    durableMarker: null,
    observedMarker: null,
    currentVisibilityState: null,
    desiredVisibilityState: source.visibilityState,
    observations: source.desired.artifacts.map((artifact) => ({
      targetRelativePath: artifact.targetRelativePath,
      kind: 'missing',
      isReparsePoint: false
    })),
    gitFacts: input.gitFacts,
    gitConfiguration: freshConfiguration
  })
  assert.equal(fresh.ok, true, JSON.stringify(fresh))
  assert.equal(fresh.plan.git.configuration.action, 'conflict')
  assert.deepEqual(fresh.plan.git.configuration.effects, [])
  assert.equal(fresh.plan.git.configuration.conflictKind, 'unsupportedWorktreeConfig')
  assert.equal(fresh.plan.executable, false)

  const unsupported = core.planMaterialization({
    pathKey: PATH_KEY,
    worktreeId: WORKTREE_ID,
    stateRevision: input.stateRevision,
    pin: input.pin,
    snapshot: input.snapshot,
    runtimeAsset: input.runtimeAsset,
    durableMarker: null,
    observedMarker: null,
    currentVisibilityState: null,
    desiredVisibilityState: source.visibilityState,
    observations: source.desired.artifacts.map((artifact) => ({
      targetRelativePath: artifact.targetRelativePath,
      kind: 'missing',
      isReparsePoint: false
    })),
    gitFacts: input.gitFacts,
    gitConfiguration: configuration({ supportsWorktreeConfig: false })
  })
  assert.equal(unsupported.ok, true, JSON.stringify(unsupported))
  assert.equal(unsupported.plan.git.configuration.conflictKind, 'unsupportedWorktreeConfig')
  assert.equal(unsupported.plan.executable, false)
})

test('legacy migration is a deterministic pure plan over exact link, Git, and configuration facts', () => {
  const source = sources()
  const input = migrationInput(source)
  const first = core.planLegacyMigration(input)
  const replay = core.planLegacyMigration(structuredClone(input))
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.equal(first.status, 'planned')
  assert.deepEqual(replay, first)
  assert.equal(first.plan.summary.replaceWithCopy, source.desired.artifacts.length)
  assert.ok(first.plan.git.operations.some((operation) => operation.action === 'apply'))
  assert.ok(first.plan.git.operations.every((operation) => operation.after.ignoreOrigin === 'private'))
  assert.ok(first.plan.git.configuration.effects.includes('removeOwnedCommonInfoExcludeEntries'))
  assert.equal(first.plan.executable, true)
  assert.equal(first.plan.backupPrivateStateId, input.backupPrivateStateId)
  assert.equal(contracts.validateLegacyMigrationPlanV1(first.plan).valid, true)
  assert.equal(core.verifyLegacyMigrationPlanHash(first.plan), true)
  assert.equal(core.verifyLegacyMigrationPlanHash({
    ...first.plan,
    backupPrivateStateId: sha('tampered-private-backup')
  }), false)
  const backupPayload = {
    pathKey: first.plan.pathKey,
    worktreeId: first.plan.worktreeId,
    artifacts: recordFromMigration(first.plan).artifacts,
    gitBeforeDigest: first.plan.gitBeforeDigest,
    backupPrivateStateId: first.plan.backupPrivateStateId
  }
  assert.notEqual(
    core.canonicalLegacyBackupManifestPayload(backupPayload),
    core.canonicalLegacyBackupManifestPayload({ ...backupPayload, pathKey: sha('other-path') })
  )
  assert.notEqual(
    core.canonicalLegacyBackupManifestPayload(backupPayload),
    core.canonicalLegacyBackupManifestPayload({ ...backupPayload, worktreeId: 'worktree:other' })
  )
  assert.equal(core.verifyLegacyMigrationPlanHash({
    ...first.plan,
    git: {
      ...first.plan.git,
      configuration: { ...first.plan.git.configuration, afterDigest: sha('tampered') }
    }
  }), false)
  assert.equal(core.verifyLegacyMigrationPlanHash({
    ...first.plan,
    git: {
      ...first.plan.git,
      configuration: {
        ...first.plan.git.configuration,
        siblingFactsDigest: sha('tampered-sibling-proof')
      }
    }
  }), false)
  assert.doesNotMatch(JSON.stringify(first.plan), /[A-Z]:[\\/]|tracked-a|owned-legacy-lines/u)

  const wrongSource = structuredClone(input)
  wrongSource.artifacts[0].sourceArtifactId = sha('external-source')
  const conflict = core.planLegacyMigration(wrongSource)
  assert.equal(conflict.ok, true, JSON.stringify(conflict))
  assert.equal(conflict.plan.operations[0].conflict.kind, 'external-link')
  assert.equal(conflict.plan.executable, false)

  const extra = { ...input, rawWorktree: 'C:/private/worktree' }
  const rejected = core.planLegacyMigration(extra)
  assert.equal(rejected.ok, false)
  assert.equal(rejected.errors[0].code, 'LEGACY_INPUT_INVALID')

  const unsafeSiblings = core.planLegacyMigration({
    ...input,
    gitConfiguration: configuration({
      worktreeConfigEnabled: true,
      hooksPath: 'legacy-hooks',
      overlaySource: 'legacy-overlay',
      excludesFile: 'legacy-excludes',
      commonInfoExclude: 'owned-legacy-lines',
      siblings: [{
        siblingPathKey: sha('unsafe-sibling'),
        visibilityDigest: sha('unsafe-visibility'),
        equivalentlyHidden: false
      }]
    })
  })
  assert.equal(unsafeSiblings.ok, true, JSON.stringify(unsafeSiblings))
  assert.equal(unsafeSiblings.plan.git.configuration.action, 'conflict')
  assert.equal(unsafeSiblings.plan.git.configuration.conflictKind, 'siblingVisibilityRisk')
  assert.deepEqual(unsafeSiblings.plan.git.configuration.effects, [])
  assert.equal(unsafeSiblings.plan.executable, false)
})

test('plain exact content is never adopted; missing targets may be created with owned common cleanup', () => {
  const source = sources()
  const plain = source.desired.artifacts.map((artifact) => legacyArtifactFact(artifact, 'plain'))
  const settledGit = source.desired.artifacts.map((artifact, index) => visibilityFact(artifact, {
    trackedPaths: [],
    ignored: true,
    ignoreOrigin: 'repository',
    baselineDigest: core.visibilityOwnershipTargetBaselineDigest(source.visibilityState.targets[index])
  }))
  const configOnly = core.planLegacyMigration(migrationInput(source, {
    artifacts: plain,
    gitFacts: settledGit,
    gitConfiguration: configuration({ commonInfoExclude: 'owned-legacy-lines' })
  }))
  assert.equal(configOnly.ok, true, JSON.stringify(configOnly))
  assert.equal(configOnly.status, 'planned')
  assert.equal(configOnly.plan.summary.replaceWithCopy, 0)
  assert.equal(configOnly.plan.summary.conflict, source.desired.artifacts.length)
  assert.deepEqual(configOnly.plan.git.configuration.effects, ['removeOwnedCommonInfoExcludeEntries'])
  assert.equal(configOnly.plan.executable, false)

  const stillConflict = core.planLegacyMigration(migrationInput(source, {
    artifacts: plain,
    gitFacts: settledGit,
    gitConfiguration: configuration()
  }))
  assert.equal(stillConflict.ok, true, JSON.stringify(stillConflict))
  assert.equal(stillConflict.status, 'planned')
  assert.equal(stillConflict.plan.executable, false)

  const missingInput = migrationInput(source, {
    artifacts: source.desired.artifacts.map((artifact) => legacyArtifactFact(artifact, 'missing')),
    gitConfiguration: configuration({ commonInfoExclude: 'owned-legacy-lines' })
  })
  const missing = core.planLegacyMigration(missingInput)
  assert.equal(missing.ok, true, JSON.stringify(missing))
  assert.equal(missing.status, 'planned')
  assert.equal(missing.plan.summary.create, source.desired.artifacts.length)
  assert.equal(missing.plan.executable, true)
  const createdRecord = recordFromMigration(missing.plan)
  assert.deepEqual(createdRecord.artifacts, [])
  assert.equal(createdRecord.createdArtifacts.length, source.desired.artifacts.length)
  assert.equal(contracts.validateLegacyMigrationRecordV1(createdRecord).valid, true)

  const createdMarker = markerFromMigration(source, missing.plan)
  const createdCurrentGit = source.desired.artifacts.map((artifact, index) => visibilityFact(artifact, {
    trackedPaths: source.visibilityState.targets[index].trackedPaths.map((entry) => ({
      ...entry,
      skipWorktree: true
    })),
    ignored: true,
    ignoreOrigin: 'private',
    privateExcluded: true,
    ownership: 'managed',
    ownershipStateId: source.visibilityState.visibilityStateId,
    baselineDigest: core.visibilityOwnershipTargetBaselineDigest(source.visibilityState.targets[index]),
    restoreDigest: missingInput.gitFacts[index].factDigest
  }))
  const createdRollback = core.planLegacyRollback({
    ...missingInput,
    pin: pin(source.snapshot.snapshotId, source.snapshot.snapshotId),
    durableMarker: { schemaVersion: 1, pathKey: PATH_KEY, marker: createdMarker },
    observedMarker: createdMarker,
    currentVisibilityState: source.visibilityState,
    desiredVisibilityState: source.restoreVisibilityState,
    migrationRecord: createdRecord,
    restoreSources: [],
    artifacts: source.desired.artifacts.map((artifact) => legacyArtifactFact(artifact, 'plain')),
    gitFacts: createdCurrentGit,
    gitConfiguration: configuration(),
    restoreGitFacts: missingInput.gitFacts,
    restoreGitConfiguration: missingInput.gitConfiguration
  })
  assert.equal(createdRollback.ok, true, JSON.stringify(createdRollback))
  assert.equal(createdRollback.status, 'planned')
  assert.equal(createdRollback.plan.summary.deleteCreated, source.desired.artifacts.length)
  assert.equal(createdRollback.plan.executable, true)
})

test('rollback restores exact links, compound Git facts, and configuration and permits deterministic remigration', () => {
  const source = sources()
  const migrationInputValue = migrationInput(source)
  const migrated = core.planLegacyMigration(migrationInputValue)
  assert.equal(migrated.ok, true, JSON.stringify(migrated))
  assert.equal(migrated.status, 'planned')
  const record = recordFromMigration(migrated.plan)
  assert.equal(core.verifyLegacyMigrationRecordIdentity(record), true)
  const marker = markerFromMigration(source, migrated.plan)
  assert.equal(core.verifyMaterializationMarker(marker), true)

  const currentGitFacts = source.desired.artifacts.map((artifact, index) => visibilityFact(artifact, {
    trackedPaths: (artifact.kind === 'file'
      ? [{ path: artifact.targetRelativePath, skipWorktree: true }]
      : [
          { path: `${artifact.targetRelativePath}/tracked-a`, skipWorktree: true },
          { path: `${artifact.targetRelativePath}/tracked-b`, skipWorktree: true }
        ]),
    ignored: true,
    ignoreOrigin: 'private',
    privateExcluded: true,
    ownership: 'managed',
    ownershipStateId: source.visibilityState.visibilityStateId,
    baselineDigest: core.visibilityOwnershipTargetBaselineDigest(source.visibilityState.targets[index]),
    restoreDigest: migrationInputValue.gitFacts[index].factDigest
  }))
  assert.ok(currentGitFacts.every((fact, index) =>
    fact.factDigest === migrationInputValue.gitFacts[index].desiredDigest))
  const currentConfiguration = configuration({
    siblings: [{
      siblingPathKey: sha('new-safe-sibling'),
      visibilityDigest: sha('new-safe-visibility'),
      equivalentlyHidden: true
    }]
  })
  assert.equal(currentConfiguration.currentDigest, migrationInputValue.gitConfiguration.desiredDigest)
  assert.notEqual(currentConfiguration.siblingFactsDigest, migrationInputValue.gitConfiguration.siblingFactsDigest)
  const alreadyInput = {
    ...migrationInputValue,
    pin: pin(source.snapshot.snapshotId, source.snapshot.snapshotId),
    durableMarker: { schemaVersion: 1, pathKey: PATH_KEY, marker },
    observedMarker: marker,
    currentVisibilityState: source.visibilityState,
    desiredVisibilityState: source.visibilityState,
    migrationRecord: record,
    artifacts: source.desired.artifacts.map((artifact) => legacyArtifactFact(artifact, 'plain')),
    gitFacts: currentGitFacts,
    gitConfiguration: currentConfiguration
  }
  const alreadyMigrated = core.planLegacyMigration(alreadyInput)
  assert.equal(alreadyMigrated.ok, true, JSON.stringify(alreadyMigrated))
  assert.equal(alreadyMigrated.status, 'already-migrated')
  const substitutedPrivateBackup = core.planLegacyMigration({
    ...alreadyInput,
    backupPrivateStateId: sha('substituted-private-backup')
  })
  assert.equal(substitutedPrivateBackup.ok, false)
  assert.equal(substitutedPrivateBackup.errors[0].code, 'LEGACY_RECORD_INVALID')
  const rollbackInput = {
    ...migrationInputValue,
    pin: pin(source.snapshot.snapshotId, source.snapshot.snapshotId),
    durableMarker: { schemaVersion: 1, pathKey: PATH_KEY, marker },
    observedMarker: marker,
    currentVisibilityState: source.visibilityState,
    desiredVisibilityState: source.restoreVisibilityState,
    migrationRecord: record,
    restoreSources: restoreSources(record),
    artifacts: source.desired.artifacts.map((artifact) => legacyArtifactFact(artifact, 'plain')),
    gitFacts: currentGitFacts,
    gitConfiguration: currentConfiguration,
    restoreGitFacts: migrationInputValue.gitFacts,
    restoreGitConfiguration: migrationInputValue.gitConfiguration
  }
  const rollback = core.planLegacyRollback(rollbackInput)
  assert.equal(rollback.ok, true, JSON.stringify(rollback))
  assert.equal(rollback.status, 'planned')
  assert.equal(rollback.plan.summary.restoreLink, record.artifacts.length)
  assert.equal(rollback.plan.backupManifestId, record.backupManifestId)
  assert.equal(rollback.plan.backupPrivateStateId, record.backupPrivateStateId)
  assert.deepEqual(
    rollback.plan.operations
      .filter((operation) => operation.action === 'restoreLink')
      .map((operation) => operation.restore.sourceStateId),
    rollbackInput.restoreSources.map((fact) => fact.sourceStateId)
  )
  assert.ok(rollback.plan.git.operations.every((operation) => operation.action === 'restore'))
  assert.equal(rollback.plan.git.configuration.action, 'restore')
  assert.equal(rollback.plan.executable, true)
  assert.equal(contracts.validateLegacyRollbackPlanV1(rollback.plan).valid, true)
  assert.equal(core.verifyLegacyRollbackPlanHash(rollback.plan), true)
  assert.equal(core.verifyLegacyRollbackPlanHash({
    ...rollback.plan,
    operations: rollback.plan.operations.map((operation, index) => index === 0 && operation.restore
      ? { ...operation, restore: { ...operation.restore, sourceStateId: sha('tampered-source-state') } }
      : operation)
  }), false)

  for (const [status, expectedConflict] of [['missing', 'dirty'], ['changed', 'dirty'], ['unsafe', 'external-link']]) {
    const unavailable = core.planLegacyRollback({
      ...rollbackInput,
      restoreSources: restoreSources(record, status)
    })
    assert.equal(unavailable.ok, true, JSON.stringify(unavailable))
    assert.equal(unavailable.status, 'planned')
    assert.equal(unavailable.plan.executable, false)
    assert.ok(unavailable.plan.operations
      .filter((operation) => operation.restore !== null)
      .every((operation) => operation.action === 'conflict'
        && operation.conflict.kind === expectedConflict))
  }
  const wrongRestoreIdentity = restoreSources(record)
  wrongRestoreIdentity[0] = { ...wrongRestoreIdentity[0], sourceArtifactId: sha('wrong-restore-source') }
  const invalidRestoreIdentity = core.planLegacyRollback({
    ...rollbackInput,
    restoreSources: wrongRestoreIdentity
  })
  assert.equal(invalidRestoreIdentity.ok, false)
  assert.equal(invalidRestoreIdentity.errors[0].code, 'LEGACY_FACT_INVALID')

  const rolledBackRecord = {
    ...record,
    status: 'rolledBack',
    rollbackPlanHash: rollback.plan.planHash
  }
  assert.equal(core.verifyLegacyMigrationRecordIdentity(rolledBackRecord), true)
  const already = core.planLegacyRollback({
    ...migrationInputValue,
    pin: pin(source.snapshot.snapshotId),
    durableMarker: { schemaVersion: 1, pathKey: PATH_KEY, marker: null },
    observedMarker: null,
    currentVisibilityState: null,
    desiredVisibilityState: source.restoreVisibilityState,
    migrationRecord: rolledBackRecord,
    restoreSources: restoreSources(record),
    artifacts: migrationInputValue.artifacts,
    gitFacts: migrationInputValue.gitFacts,
    gitConfiguration: migrationInputValue.gitConfiguration,
    restoreGitFacts: migrationInputValue.gitFacts,
    restoreGitConfiguration: migrationInputValue.gitConfiguration
  })
  assert.equal(already.ok, true, JSON.stringify(already))
  assert.equal(already.status, 'already-rolled-back')

  const remigration = core.planLegacyMigration({
    ...migrationInputValue,
    migrationRecord: rolledBackRecord
  })
  assert.equal(remigration.ok, true, JSON.stringify(remigration))
  assert.equal(remigration.status, 'planned')
  assert.equal(remigration.plan.migrationId, migrated.plan.migrationId)

  const drifted = core.planLegacyRollback({
    ...rollbackInput,
    gitConfiguration: configuration({ hooksPath: 'externally-changed' })
  })
  assert.equal(drifted.ok, true, JSON.stringify(drifted))
  assert.equal(drifted.plan.git.configuration.action, 'conflict')
  assert.equal(drifted.plan.executable, false)

  const driftedGitFacts = currentGitFacts.map((fact, index) => index === 0
    ? visibilityFact(source.desired.artifacts[index], {
        trackedPaths: source.desired.artifacts[index].kind === 'file'
          ? [{ path: source.desired.artifacts[index].targetRelativePath, skipWorktree: true }]
          : [
              { path: `${source.desired.artifacts[index].targetRelativePath}/tracked-a`, skipWorktree: true },
              { path: `${source.desired.artifacts[index].targetRelativePath}/tracked-b`, skipWorktree: true }
            ],
        ignored: true,
        ignoreOrigin: 'external',
        ownership: 'managed',
        ownershipStateId: source.visibilityState.visibilityStateId,
        baselineDigest: core.visibilityOwnershipTargetBaselineDigest(source.visibilityState.targets[index]),
        restoreDigest: migrationInputValue.gitFacts[index].factDigest
      })
    : fact)
  const visibilityDrift = core.planLegacyRollback({ ...rollbackInput, gitFacts: driftedGitFacts })
  assert.equal(visibilityDrift.ok, true, JSON.stringify(visibilityDrift))
  assert.equal(visibilityDrift.plan.git.operations[0].action, 'conflict')
  assert.equal(visibilityDrift.plan.executable, false)

  const unsafeSiblingRollback = core.planLegacyRollback({
    ...rollbackInput,
    gitConfiguration: configuration({
      siblings: [{
        siblingPathKey: sha('unsafe-rollback-sibling'),
        visibilityDigest: sha('unsafe-rollback-visibility'),
        equivalentlyHidden: false
      }]
    })
  })
  assert.equal(unsafeSiblingRollback.ok, true, JSON.stringify(unsafeSiblingRollback))
  assert.equal(unsafeSiblingRollback.plan.git.configuration.action, 'conflict')
  assert.equal(unsafeSiblingRollback.plan.git.configuration.conflictKind, 'siblingVisibilityRisk')
  assert.equal(unsafeSiblingRollback.plan.executable, false)
})
