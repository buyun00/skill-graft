import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { createHubApplication } from '../dist/application/index.js'
import { CONTRACT_VERSION } from '../dist/contracts/index.js'
import {
  buildDesiredMaterialization,
  createGitMaterializationConfigurationFact,
  createGitMaterializationSiblingProof,
  createGitVisibilityFact,
  createLibrarySnapshotManifest,
  createRuntimeAssetManifest,
  createVisibilityOwnershipState,
  gitMaterializationConfigurationValueId,
  materializationSourceArtifactId,
  visibilityOwnershipTargetBaselineDigest
} from '../dist/core/index.js'

const NOW = '2032-03-04T05:06:07.000Z'

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

function identifier(value) {
  return `sha256:${digest(value)}`
}

function clone(value) {
  return value == null ? value : structuredClone(value)
}

function identity(worktree) {
  const pathKey = identifier(`path:${String(worktree).toLowerCase()}`)
  return { pathKey, worktreeId: `worktree:${pathKey.slice(-24)}` }
}

function librarySnapshot() {
  const files = [
    ['AGENTS.override.md', 'override-v1'],
    ['skills/ozdqp-development/SKILL.md', 'skill-v1']
  ].map(([path, bytes]) => ({
    path,
    size: Buffer.byteLength(bytes),
    sha256: identifier(bytes),
    mode: '100644',
    isReparsePoint: false
  }))
  const created = createLibrarySnapshotManifest({
    source: { kind: 'library', id: 'fixture-library', revision: 'library-r1' },
    createdAt: NOW,
    files
  })
  assert.equal(created.ok, true)
  return created.manifest
}

function runtimeManifest() {
  const bytes = 'overlay-v1'
  const created = createRuntimeAssetManifest({
    runtimeRevision: 'runtime-r1',
    files: [{
      path: 'HubLib.ps1',
      size: Buffer.byteLength(bytes),
      sha256: identifier(bytes),
      mode: '100644',
      isReparsePoint: false
    }]
  })
  assert.equal(created.ok, true)
  return created.manifest
}

function pinFor(snapshot, worktree = '/probe') {
  const resolved = identity(worktree)
  return {
    schemaVersion: 1,
    pathKey: resolved.pathKey,
    worktreeId: resolved.worktreeId,
    requestedSnapshot: snapshot.snapshotId,
    materializedSnapshot: null,
    selectedSkills: ['ozdqp-development'],
    claimState: 'claimed'
  }
}

function currentState(snapshot, pin = pinFor(snapshot)) {
  return {
    schemaVersion: 2,
    stateRevision: 4,
    runtimeRevision: 'runtime-r1',
    librarySnapshots: [snapshot.snapshotId],
    worktrees: pin ? { [pin.pathKey]: pin } : {},
    items: [],
    lastIngest: null
  }
}

function restore(target, saved) {
  for (const key of Object.keys(target)) delete target[key]
  Object.assign(target, clone(saved))
}

function visibilityBaseline(artifact, phase) {
  return {
    artifactId: artifact.artifactId,
    owner: artifact.owner,
    targetRelativePath: artifact.targetRelativePath,
    baselineKind: 'missing',
    trackedPaths: [],
    ignoreOrigin: phase === 'legacy' ? 'legacyCommon' : 'none',
    privateExcluded: false
  }
}

function visibilityPrivateStateId(resolved, restore = false) {
  return identifier(`${restore ? 'restore-' : ''}visibility-private:${resolved.pathKey}`)
}

function legacyBackupPrivateStateId(resolved) {
  return identifier(`legacy-backup-private:${resolved.pathKey}`)
}

function legacyRestoreSources(record) {
  return record.artifacts.map((artifact) => ({
    artifactId: artifact.artifactId,
    targetRelativePath: artifact.targetRelativePath,
    legacyKind: artifact.legacyKind,
    sourceArtifactId: artifact.sourceArtifactId,
    sourceStateId: identifier(`legacy-restore-source:${record.backupPrivateStateId}:${artifact.targetRelativePath}`),
    status: 'valid'
  }))
}

function desiredBundleFor(model, resolved, options = {}) {
  const pin = model.state.worktrees[resolved.pathKey]
  assert.ok(pin)
  const provisional = buildDesiredMaterialization({
    snapshot: model.snapshot,
    selectedSkills: pin.selectedSkills,
    runtimeAsset: model.runtimeAsset,
    visibilityStateId: identifier('provisional-visibility-state')
  })
  assert.equal(provisional.ok, true)
  const currentTargets = new Map((model.currentVisibilityState?.targets ?? []).map((target) => [
    target.targetRelativePath,
    target
  ]))
  const phase = model.legacyMode && !model.gitManaged ? 'legacy' : 'fresh'
  const ownership = createVisibilityOwnershipState({
    privateStateId: options.restore
      ? visibilityPrivateStateId(resolved, true)
      : model.currentVisibilityState?.privateStateId ?? visibilityPrivateStateId(resolved),
    pathKey: resolved.pathKey,
    worktreeId: resolved.worktreeId,
    baseExclude: model.currentVisibilityState?.baseExclude ?? {
      scope: 'global',
      valueId: gitMaterializationConfigurationValueId('fixture-base-exclude'),
      contentDigest: identifier('fixture-base-exclude-content')
    },
    targets: options.restore
      ? []
      : provisional.desired.artifacts.map((artifact) => (
          currentTargets.get(artifact.targetRelativePath) ?? visibilityBaseline(artifact, phase)
        ))
  })
  assert.equal(ownership.ok, true, JSON.stringify(ownership))
  const built = buildDesiredMaterialization({
    snapshot: model.snapshot,
    selectedSkills: pin.selectedSkills,
    runtimeAsset: model.runtimeAsset,
    visibilityStateId: options.restore && model.currentVisibilityState
      ? model.currentVisibilityState.visibilityStateId
      : ownership.state.visibilityStateId
  })
  assert.equal(built.ok, true)
  return { desired: built.desired, desiredVisibilityState: ownership.state }
}

function desiredFor(model, resolved) {
  return desiredBundleFor(model, resolved).desired
}

function gitProofsFor(
  model,
  desired,
  desiredVisibilityState,
  phase = model.gitManaged ? 'managed' : 'fresh'
) {
  const legacy = phase === 'legacy'
  const managed = phase === 'managed'
  const currentTargets = new Map((model.currentVisibilityState?.targets ?? []).map((target) => [
    target.targetRelativePath,
    target
  ]))
  const desiredTargets = new Map(desiredVisibilityState.targets.map((target) => [
    target.targetRelativePath,
    target
  ]))
  const gitFacts = desired.artifacts.map((artifact) => {
    const baseline = currentTargets.get(artifact.targetRelativePath)
      ?? desiredTargets.get(artifact.targetRelativePath)
      ?? visibilityBaseline(artifact, legacy ? 'legacy' : 'fresh')
    const baselineDigest = visibilityOwnershipTargetBaselineDigest(baseline)
    const unmanaged = createGitVisibilityFact({
      targetRelativePath: artifact.targetRelativePath,
      trackedPaths: baseline.trackedPaths,
      ignored: baseline.ignoreOrigin !== 'none',
      ignoreOrigin: baseline.ignoreOrigin,
      privateExcluded: baseline.privateExcluded,
      ownership: 'unmanaged',
      ownershipStateId: null,
      baselineDigest,
      restoreDigest: null,
      restoreSafe: true
    })
    assert.equal(unmanaged.ok, true)
    const created = createGitVisibilityFact({
      targetRelativePath: artifact.targetRelativePath,
      trackedPaths: managed
        ? baseline.trackedPaths.map((entry) => ({ ...entry, skipWorktree: true }))
        : baseline.trackedPaths,
      ignored: managed || baseline.ignoreOrigin !== 'none',
      ignoreOrigin: managed ? 'private' : baseline.ignoreOrigin,
      privateExcluded: managed || baseline.privateExcluded,
      ownership: managed ? 'managed' : 'unmanaged',
      ownershipStateId: managed ? model.currentVisibilityState?.visibilityStateId ?? null : null,
      baselineDigest,
      restoreDigest: managed ? unmanaged.fact.factDigest : null,
      restoreSafe: true
    })
    assert.equal(created.ok, true)
    return created.fact
  })
  const cleanCommon = identifier('common-info-clean')
  const desiredHooks = gitMaterializationConfigurationValueId('desired-hooks')
  const desiredOverlay = gitMaterializationConfigurationValueId('desired-overlay')
  const desiredWatchWorkspace = gitMaterializationConfigurationValueId('desired-watch-workspace')
  const desiredExcludes = gitMaterializationConfigurationValueId('desired-excludes')
  const baseExcludeValueId = gitMaterializationConfigurationValueId('fixture-base-exclude')
  const baseExcludeContentDigest = identifier('fixture-base-exclude-content')
  const basePrivateExclude = identifier('fixture-private-exclude-base')
  const desiredPrivateExclude = identifier('fixture-private-exclude-projection')
  const siblingProof = createGitMaterializationSiblingProof(model.siblingUnsafe ? [{
    siblingPathKey: identifier('sibling-path'),
    visibilityDigest: identifier('sibling-visibility'),
    equivalentlyHidden: false
  }] : [])
  assert.equal(siblingProof.ok, true)
  const gitConfiguration = createGitMaterializationConfigurationFact({
    isLinkedWorktree: true,
    supportsWorktreeConfig: true,
    worktreeConfigEnabled: true,
    hooksPathValueId: managed ? desiredHooks : null,
    desiredHooksPathValueId: desiredHooks,
    overlaySourceValueId: managed ? desiredOverlay : null,
    desiredOverlaySourceValueId: desiredOverlay,
    watchWorkspaceValueId: managed ? desiredWatchWorkspace : null,
    desiredWatchWorkspaceValueId: desiredWatchWorkspace,
    excludesFileValueId: managed ? desiredExcludes : null,
    desiredExcludesFileValueId: desiredExcludes,
    baseExcludeSafe: true,
    baseExcludeValueId,
    baseExcludeContentDigest,
    privateExcludeContentDigest: managed ? desiredPrivateExclude : basePrivateExclude,
    desiredPrivateExcludeContentDigest: desiredPrivateExclude,
    commonInfoExcludeDigest: legacy ? identifier('common-info-legacy') : cleanCommon,
    cleanCommonInfoExcludeDigest: cleanCommon,
    legacyCommonSiblingSafety: siblingProof.proof.legacyCommonSiblingSafety,
    siblingFactsDigest: siblingProof.proof.siblingFactsDigest
  })
  return { gitFacts, gitConfiguration }
}

function legacyArtifactsFor(model, desired) {
  const linked = model.legacyMode && !model.gitManaged
  return desired.artifacts.map((artifact) => {
    const after = { digest: artifact.digest, source: artifact.source }
    return {
      artifactId: artifact.artifactId,
      owner: artifact.owner,
      targetRelativePath: artifact.targetRelativePath,
      kind: artifact.kind,
      observedKind: linked ? artifact.kind === 'file' ? 'hardlink' : 'junction' : artifact.kind,
      digest: artifact.digest,
      isReparsePoint: linked && artifact.kind === 'directory',
      legacyKind: linked ? artifact.kind === 'file' ? 'fileHardlink' : 'directoryLink' : null,
      sourceArtifactId: linked ? materializationSourceArtifactId(after) : null,
      pathEscaped: false,
      protected: false
    }
  })
}

function createFixture(options = {}) {
  const snapshot = librarySnapshot()
  const runtimeAsset = runtimeManifest()
  const resolved = identity('/probe')
  const initialPin = options.unclaimed ? null : pinFor(snapshot)
  const model = {
    snapshot,
    runtimeAsset,
    state: currentState(snapshot, initialPin),
    ledger: [],
    audit: [],
    currentRecord: null,
    currentVisibilityState: null,
    legacyRecords: {},
    externalMarker: null,
    gitManaged: false,
    legacyMode: Boolean(options.legacyMode),
    siblingUnsafe: Boolean(options.siblingUnsafe),
    legacyBackupGit: null,
    legacyBackupPrivateStateId: null,
    sessions: clone(options.sessions ?? [])
  }
  const calls = []
  let sequence = 0

  const transactions = {
    async withWriteTransaction(transactionIdentity, callback) {
      calls.push(['transaction', clone(transactionIdentity)])
      const before = clone(model)
      const participants = []
      const discarded = []
      const savepoints = new Map()
      const participantGuard = Object.freeze({
        revalidateLease() {
          calls.push(['participant-guard-revalidate'])
        }
      })
      let decided = false
      const transaction = {
        revalidateLease() {
          if (decided) throw new Error('transaction is closed')
          calls.push(['revalidate-lease'])
        },
        savepoint() {
          const token = {}
          savepoints.set(token, { model: clone(model), participants: participants.length })
          return token
        },
        rollbackTo(token) {
          const saved = savepoints.get(token)
          if (!saved) throw new Error('foreign savepoint')
          restore(model, saved.model)
          discarded.push(...participants.splice(saved.participants))
          savepoints.clear()
          calls.push(['rollback-to'])
        },
        enlist(participant) {
          participants.push(participant)
          calls.push(['enlist', participant.participantId])
        },
        commit(value) {
          if (decided) throw new Error('duplicate decision')
          decided = true
          return { kind: 'commit', value }
        },
        abort(error) {
          if (decided) throw new Error('duplicate decision')
          decided = true
          return { kind: 'abort', error }
        }
      }
      try {
        const decision = await callback(transaction)
        if (!decided || decision.kind === 'abort') throw decision.error
        for (const participant of [...discarded].reverse()) {
          calls.push(['participant-rollback', participant.participantId])
          await participant.rollback(participantGuard)
        }
        for (const participant of participants) {
          calls.push(['participant-publish', participant.participantId])
          await participant.publish(participantGuard)
        }
        for (const participant of [...participants].reverse()) {
          await participant.finalize(participantGuard)
        }
        return decision.value
      } catch (error) {
        restore(model, before)
        for (const participant of [...participants, ...discarded].reverse()) {
          try { await participant.rollback(participantGuard) } catch {}
        }
        throw error
      }
    }
  }

  const runtime = {
    nowIso: () => NOW,
    nextId: (scope) => `${scope}-${++sequence}`,
    sha256: digest
  }
  const queries = {
    readStatusFacts: () => ({ configuredGameRepo: null, inbox: [], attachedWorktrees: [] }),
    listSkillFacts: () => [],
    readWorktreeFacts: () => ({ candidates: [], attached: [] }),
    readSkill: () => ({ status: 'not-found', reason: 'missing' }),
    listHistory: () => []
  }
  const useCases = {
    state: {
      readState: () => ({ version: 1, items: [], lastIngest: null }),
      writeState() {},
      appendHistory() {},
      configuredGameRepo: () => null,
      listAttachedWorktrees: () => []
    },
    git: { revisionExists: () => false, changedPaths: () => [], readTree: () => [], readBlob: () => null },
    artifacts: { inspect: () => [], apply() {} }
  }
  const unavailable = () => { throw new Error('legacy adapter unavailable') }
  const legacyAttach = { inspect: unavailable, apply: unavailable }
  const legacyDetach = { inspect: unavailable, apply: unavailable }
  const sessions = {
    list: () => clone(model.sessions),
    get: (sessionId) => clone(model.sessions.find((session) => session.id === sessionId) ?? null),
    start: unavailable,
    resume: unavailable,
    reap: () => [],
    completeAttach(input) {
      calls.push(['session-complete', input.sessionId, clone(input.proof)])
      if (options.sessionCompletionFailure) throw new Error('session completion write failed')
      const session = model.sessions.find((candidate) => candidate.id === input.sessionId)
      if (!session) return { status: 'not-authorized', reason: 'not-found' }
      if (session.kind !== 'attach') return { status: 'not-authorized', reason: 'not-attach' }
      if (session.target?.kind !== 'worktree' || session.target.id !== input.proof.targetId) {
        return { status: 'not-authorized', reason: 'target-mismatch' }
      }
      if (session.status === 'completed') {
        const proof = session.attachCompletion
        if (!proof
          || proof.targetId !== input.proof.targetId
          || proof.pathKey !== input.proof.pathKey
          || proof.materializationId !== input.proof.materializationId) {
          return { status: 'proof-conflict' }
        }
        return { status: 'already-completed', session: clone(session) }
      }
      if (session.status !== 'waiting') return { status: 'not-authorized', reason: 'not-waiting' }
      if (session.exitCode !== 0) return { status: 'not-authorized', reason: 'exit-not-zero' }
      session.status = 'completed'
      session.canResume = false
      session.attachCompletion = clone(input.proof)
      return { status: 'completed', session: clone(session) }
    }
  }
  const ledger = {
    read(requestId) {
      calls.push(['ledger-read', requestId])
      return clone(model.ledger.find((entry) => entry.requestId === requestId) ?? null)
    },
    begin(entry) {
      calls.push(['ledger-begin', entry.commandKind])
      model.ledger.push(clone(entry))
    },
    complete(entry, events) {
      calls.push(['ledger-complete', entry.commandKind])
      const index = model.ledger.findIndex((candidate) => candidate.requestId === entry.requestId)
      model.ledger[index] = clone(entry)
      model.audit.push(...clone(Array.isArray(events) ? events : [events]))
    },
    listEvents: () => clone(model.audit)
  }
  const p2 = {
    identities: { resolve: (worktree) => identity(worktree) },
    snapshots: {
      observe: unavailable,
      store: unavailable,
      list: () => [clone(model.snapshot)],
      read: (snapshotId) => snapshotId === model.snapshot.snapshotId ? clone(model.snapshot) : null
    },
    state: {
      readDocument: () => clone(model.state),
      writeV2(state) {
        calls.push(['state-write', state.stateRevision])
        model.state = clone(state)
      },
      runtimeRevision: () => 'runtime-r1',
      observeV1Worktrees: () => []
    }
  }

  const p3 = {
    runtimeAssets: { observe: () => clone(model.runtimeAsset), readVerifiedFile: unavailable },
    records: {
      readCurrent(pathKey) {
        calls.push(['record-read', pathKey])
        return clone(model.currentRecord)
      },
      writeCurrent(record) {
        calls.push(['record-write', record.pathKey])
        model.currentRecord = clone(record)
      },
      readLegacyMigration(migrationId) {
        calls.push(['migration-read', migrationId])
        return clone(model.legacyRecords[migrationId] ?? null)
      },
      writeLegacyMigration(record) {
        calls.push(['migration-write', record.migrationId, record.status])
        model.legacyRecords[record.migrationId] = clone(record)
      }
    },
    materialize: {
      inspect({ identity: inspected }) {
        calls.push(['inspect', inspected.pathKey])
        const bundle = desiredBundleFor(model, inspected)
        const desired = bundle.desired
        const current = new Map((model.externalMarker?.artifacts ?? []).map((artifact) => [artifact.targetRelativePath, artifact]))
        const observations = desired.artifacts.map((artifact) => {
          const existing = current.get(artifact.targetRelativePath)
          if ((options.legacyConflict || model.legacyMode) && artifact.owner === 'localOverlay') {
            return {
              targetRelativePath: artifact.targetRelativePath,
              kind: 'junction',
              isReparsePoint: true,
              linkClassification: 'legacy'
            }
          }
          return existing
            ? {
                targetRelativePath: artifact.targetRelativePath,
                kind: artifact.kind,
                digest: existing.digest,
                isReparsePoint: false
              }
            : { targetRelativePath: artifact.targetRelativePath, kind: 'missing', isReparsePoint: false }
        })
        return {
          observedMarker: clone(model.externalMarker),
          currentVisibilityState: clone(model.currentVisibilityState),
          desiredVisibilityState: clone(bundle.desiredVisibilityState),
          observations,
          ...gitProofsFor(model, desired, bundle.desiredVisibilityState)
        }
      },
      inspectLegacy({ identity: inspected, migration }) {
        calls.push(['inspect-legacy', inspected.pathKey])
        if (migration !== null) assert.deepEqual(migration, model.legacyRecords[migration.migrationId])
        const bundle = desiredBundleFor(model, inspected)
        const desired = bundle.desired
        return {
          observedMarker: clone(model.externalMarker),
          currentVisibilityState: clone(model.currentVisibilityState),
          desiredVisibilityState: clone(bundle.desiredVisibilityState),
          backupPrivateStateId: migration?.backupPrivateStateId
            ?? model.legacyBackupPrivateStateId
            ?? legacyBackupPrivateStateId(inspected),
          artifacts: legacyArtifactsFor(model, desired),
          ...gitProofsFor(
            model,
            desired,
            bundle.desiredVisibilityState,
            model.gitManaged ? 'managed' : 'legacy'
          )
        }
      },
      inspectLegacyRollback({ identity: inspected, migration }) {
        calls.push(['inspect-legacy-rollback', inspected.pathKey])
        assert.deepEqual(migration, model.legacyRecords[migration.migrationId])
        const bundle = desiredBundleFor(model, inspected, { restore: true })
        const desired = bundle.desired
        const restored = clone(model.legacyBackupGit ?? gitProofsFor(
          model,
          desired,
          desiredBundleFor(model, inspected).desiredVisibilityState,
          'legacy'
        ))
        return {
          observedMarker: clone(model.externalMarker),
          currentVisibilityState: clone(model.currentVisibilityState),
          desiredVisibilityState: clone(bundle.desiredVisibilityState),
          backupPrivateStateId: migration.backupPrivateStateId,
          restoreSources: legacyRestoreSources(migration),
          artifacts: legacyArtifactsFor(model, desired),
          ...gitProofsFor(
            model,
            desired,
            model.currentVisibilityState ?? desiredBundleFor(model, inspected).desiredVisibilityState,
            model.gitManaged ? 'managed' : 'legacy'
          ),
          restoreGitFacts: restored.gitFacts,
          restoreGitConfiguration: restored.gitConfiguration
        }
      },
      async prepare({ identity: preparedIdentity, guard, plan }) {
        calls.push(['prepare', plan.planHash])
        assert.equal(typeof guard?.revalidateLease, 'function')
        await guard.revalidateLease()
        const bundle = desiredBundleFor(model, preparedIdentity)
        const desired = bundle.desired
        assert.equal(bundle.desiredVisibilityState.visibilityStateId, plan.requested.visibilityStateId)
        const marker = {
          schemaVersion: 1,
          materializationId: plan.requested.materializationId,
          planHash: options.invalidMarker ? identifier('wrong-plan') : plan.planHash,
          pathKey: preparedIdentity.pathKey,
          worktreeId: preparedIdentity.worktreeId,
          snapshotId: plan.requested.snapshotId,
          selectedSkills: [...plan.requested.selectedSkills],
          runtimeRevision: plan.requested.runtimeRevision,
          runtimeAssetId: plan.requested.runtimeAssetId,
          visibilityStateId: plan.requested.visibilityStateId,
          origin: { kind: 'sync' },
          artifacts: desired.artifacts.map(({ source: _source, files: _files, ...artifact }) => artifact)
        }
        return {
          marker,
          report: { preparedOperations: plan.operations.length, preparedBytes: 77 },
          participant: {
            participantId: 'materialization-participant-1',
            publish() {
              if (options.publishFailure) throw new Error('materialization publish failed')
              model.externalMarker = clone(marker)
              model.currentVisibilityState = clone(bundle.desiredVisibilityState)
              model.gitManaged = true
            },
            rollback() {
              calls.push(['adapter-rollback'])
            },
            finalize(context) {
              assert.equal(typeof context?.revalidateLease, 'function')
              calls.push(['adapter-finalize'])
              return context.revalidateLease()
            }
          }
        }
      },
      async recover({ identity: recovered, durable, guard, pin, stateRevision }) {
        calls.push(['recover', recovered.pathKey, durable?.marker?.materializationId ?? null])
        assert.equal(pin?.pathKey ?? null, model.state.worktrees[recovered.pathKey]?.pathKey ?? null)
        assert.equal(stateRevision, model.state.stateRevision)
        await guard.revalidateLease()
        await guard.revalidateLease()
        return { status: 'clean', recoveredTransactions: 0 }
      },
      async prepareLegacyMigration({ identity: preparedIdentity, guard, plan }) {
        calls.push(['prepare-legacy', plan.planHash])
        assert.equal(typeof guard?.revalidateLease, 'function')
        await guard.revalidateLease()
        const bundle = desiredBundleFor(model, preparedIdentity)
        const desired = bundle.desired
        assert.equal(bundle.desiredVisibilityState.visibilityStateId, plan.requested.visibilityStateId)
        const backupGit = gitProofsFor(model, desired, bundle.desiredVisibilityState, 'legacy')
        const marker = {
          schemaVersion: 1,
          materializationId: plan.requested.materializationId,
          planHash: plan.planHash,
          pathKey: preparedIdentity.pathKey,
          worktreeId: preparedIdentity.worktreeId,
          snapshotId: plan.requested.snapshotId,
          selectedSkills: [...plan.requested.selectedSkills],
          runtimeRevision: plan.requested.runtimeRevision,
          runtimeAssetId: plan.requested.runtimeAssetId,
          visibilityStateId: plan.requested.visibilityStateId,
          origin: { kind: 'legacyMigration', migrationId: plan.migrationId },
          artifacts: desired.artifacts.map(({ source: _source, files: _files, ...artifact }) => artifact)
        }
        const record = {
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
          artifacts: plan.operations.filter((operation) => operation.action === 'replaceWithCopy').map((operation) => ({
            artifactId: operation.artifactId,
            owner: operation.owner,
            targetRelativePath: operation.targetRelativePath,
            kind: operation.kind,
            legacyKind: operation.legacy.legacyKind,
            sourceArtifactId: operation.legacy.sourceArtifactId,
            beforeDigest: operation.before.digest,
              afterDigest: operation.after.digest
          })),
          createdArtifacts: plan.operations.filter((operation) => operation.action === 'create').map((operation) => ({
            artifactId: operation.artifactId,
            owner: operation.owner,
            targetRelativePath: operation.targetRelativePath,
            kind: operation.kind,
            digest: operation.after.digest
          })),
          gitVisibilityDigest: plan.gitBeforeDigest
        }
        return {
          marker,
          record,
          report: { preparedOperations: plan.operations.length, preparedBytes: 91 },
          participant: {
            participantId: `legacy-migrate-${plan.migrationId.slice(-16)}`,
            publish() {
              model.externalMarker = clone(marker)
              model.currentVisibilityState = clone(bundle.desiredVisibilityState)
              model.gitManaged = true
              model.legacyBackupGit = clone(backupGit)
              model.legacyBackupPrivateStateId = plan.backupPrivateStateId
            },
            rollback() { calls.push(['legacy-adapter-rollback']) },
            finalize(context) {
              assert.equal(typeof context?.revalidateLease, 'function')
              calls.push(['legacy-adapter-finalize'])
              return context.revalidateLease()
            }
          }
        }
      },
      async prepareLegacyRollback({ guard, plan, migration }) {
        calls.push(['prepare-legacy-rollback', plan.planHash])
        assert.equal(typeof guard?.revalidateLease, 'function')
        await guard.revalidateLease()
        const current = model.legacyRecords[plan.migrationId]
        assert.ok(current)
        assert.deepEqual(migration, current)
        assert.equal(migration.backupManifestId, plan.backupManifestId)
        assert.equal(migration.backupPrivateStateId, plan.backupPrivateStateId)
        const record = { ...clone(current), status: 'rolledBack', rollbackPlanHash: plan.planHash }
        return {
          record,
          report: { preparedOperations: plan.operations.length, preparedBytes: 53 },
          participant: {
            participantId: `legacy-rollback-${plan.migrationId.slice(-16)}`,
            publish() {
              model.externalMarker = null
              model.currentVisibilityState = null
              model.gitManaged = false
            },
            rollback() { calls.push(['legacy-rollback-adapter-rollback']) },
            finalize(context) {
              assert.equal(typeof context?.revalidateLease, 'function')
              calls.push(['legacy-rollback-adapter-finalize'])
              return context.revalidateLease()
            }
          }
        }
      }
    }
  }

  const app = createHubApplication({
    runtime,
    recovery: options.recovery,
    queries,
    useCases,
    legacyAttach,
    legacyDetach,
    sessions,
    ledger,
    p2,
    p3,
    transactions
  })
  const meta = (requestId) => ({
    contractVersion: CONTRACT_VERSION,
    requestId,
    hostId: 'local-test',
    transport: 'test'
  })
  return { app, calls, identity: resolved, meta, model }
}

test('planSync is zero-write and projects a locator-free Core plan', async () => {
  let recoveryCalls = 0
  const fixture = createFixture({ recovery: { recover() { recoveryCalls += 1 } } })
  const result = await fixture.app.execute({ kind: 'planSync', meta: fixture.meta('plan-1'), worktree: '/probe' })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.data.action, 'planSync')
  assert.equal(result.data.status, 'planned')
  assert.equal(result.data.plan.executable, true)
  assert.deepEqual(result.data.plan.operations.map((operation) => operation.owner), [
    'residentSkill',
    'localOverlay',
    'agentsOverride'
  ])
  assert.equal(fixture.calls.some(([kind]) => kind === 'transaction' || kind.startsWith('ledger-') || kind === 'recover'), false)
  assert.equal(recoveryCalls, 0)
  assert.equal(JSON.stringify(result).includes('/probe'), false)
  assert.equal(fixture.model.state.stateRevision, 4)
})

test('claimWorktree requires a successful waiting attach session and is replay-safe', async () => {
  const resolved = identity('/probe')
  const fixture = createFixture({
    unclaimed: true,
    sessions: [{
      id: 'attach-session-1',
      kind: 'attach',
      status: 'waiting',
      target: { kind: 'worktree', id: resolved.worktreeId },
      startedAt: NOW,
      endedAt: NOW,
      exitCode: 0,
      canResume: true
    }]
  })
  const command = {
    kind: 'claimWorktree',
    meta: fixture.meta('claim-1'),
    worktree: '/probe',
    snapshotId: fixture.model.snapshot.snapshotId,
    selectedSkills: ['ozdqp-development'],
    sessionId: 'attach-session-1'
  }
  const claimed = await fixture.app.execute(command)
  assert.equal(claimed.ok, true)
  assert.equal(claimed.data.changed, true)
  assert.equal(claimed.data.pin.claimState, 'claimed')
  assert.equal(claimed.data.pin.materializedSnapshot, null)
  assert.equal(fixture.model.state.stateRevision, 5)
  assert.equal(fixture.model.audit.some((event) => event.type === 'worktree.claimed'), true)
  assert.equal(JSON.stringify(fixture.model.ledger).includes('/probe'), false)

  const replay = await fixture.app.execute(command)
  assert.equal(replay.ok, true)
  assert.equal(replay.meta.replayed, true)
  assert.equal(fixture.model.state.stateRevision, 5)
  assert.equal(fixture.calls.filter(([kind]) => kind === 'recover').length, 2)
  assert.equal(fixture.calls.filter(([kind]) => kind === 'revalidate-lease').length, 4)
})

test('claimWorktree rejects a non-terminal attach authorization without changing the pin', async () => {
  const resolved = identity('/probe')
  const fixture = createFixture({
    unclaimed: true,
    sessions: [{
      id: 'attach-session-2',
      kind: 'attach',
      status: 'running',
      target: { kind: 'worktree', id: resolved.worktreeId },
      startedAt: NOW,
      exitCode: null,
      canResume: false
    }]
  })
  const result = await fixture.app.execute({
    kind: 'claimWorktree',
    meta: fixture.meta('claim-rejected'),
    worktree: '/probe',
    snapshotId: fixture.model.snapshot.snapshotId,
    selectedSkills: ['ozdqp-development'],
    sessionId: 'attach-session-2'
  })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'FIRST_ATTACH_SESSION_REQUIRED')
  assert.equal(fixture.model.state.worktrees[resolved.pathKey], undefined)
  assert.equal(fixture.model.ledger[0].status, 'completed')
})

test('sync enlists external publication, atomically records the marker, and becomes a no-op', async () => {
  const fixture = createFixture()
  const planned = await fixture.app.execute({ kind: 'planSync', meta: fixture.meta('plan-sync-1'), worktree: '/probe' })
  assert.equal(planned.ok, true, JSON.stringify(planned))
  const synced = await fixture.app.execute({
    kind: 'sync',
    meta: fixture.meta('sync-1'),
    worktree: '/probe',
    planHash: planned.data.plan.planHash
  })
  assert.equal(synced.ok, true)
  assert.equal(synced.data.changed, true)
  assert.equal(synced.data.sessionCompleted, false)
  assert.equal(fixture.model.state.stateRevision, 5)
  assert.equal(fixture.model.state.worktrees[fixture.identity.pathKey].materializedSnapshot, fixture.model.snapshot.snapshotId)
  assert.deepEqual(fixture.model.currentRecord.marker, fixture.model.externalMarker)
  assert.equal(fixture.model.audit.some((event) => event.type === 'worktree.materialized'), true)
  assert.equal(JSON.stringify(fixture.model.ledger).includes('/probe'), false)
  const enlistIndex = fixture.calls.findIndex(([kind]) => kind === 'enlist')
  const recordIndex = fixture.calls.findIndex(([kind]) => kind === 'record-write')
  const publishIndex = fixture.calls.findIndex(([kind]) => kind === 'participant-publish')
  assert.ok(enlistIndex >= 0 && enlistIndex < recordIndex && recordIndex < publishIndex)

  const nextPlan = await fixture.app.execute({ kind: 'planSync', meta: fixture.meta('plan-sync-2'), worktree: '/probe' })
  assert.equal(nextPlan.ok, true)
  assert.equal(nextPlan.data.plan.operations.every((operation) => operation.action === 'keep'), true)
  const second = await fixture.app.execute({
    kind: 'sync',
    meta: fixture.meta('sync-2'),
    worktree: '/probe',
    planHash: nextPlan.data.plan.planHash
  })
  assert.equal(second.ok, true)
  assert.equal(second.data.changed, false)
  assert.equal(second.data.sessionCompleted, false)
  assert.equal(fixture.model.state.stateRevision, 5)
  assert.equal(fixture.calls.filter(([kind]) => kind === 'prepare').length, 1)
})

test('sync completes the authorized attach for changed, replay, and external no-op paths with locator-free proof', async () => {
  const resolved = identity('/probe')
  const fixture = createFixture({
    sessions: [{
      id: 'attach-sync-1',
      kind: 'attach',
      status: 'waiting',
      target: { kind: 'worktree', id: resolved.worktreeId },
      startedAt: NOW,
      endedAt: NOW,
      exitCode: 0,
      canResume: true
    }]
  })
  const plan = await fixture.app.execute({
    kind: 'planSync',
    meta: fixture.meta('attach-sync-plan-1'),
    worktree: '/probe'
  })
  const command = {
    kind: 'sync',
    meta: fixture.meta('attach-sync-commit-1'),
    worktree: '/probe',
    planHash: plan.data.plan.planHash,
    sessionId: 'attach-sync-1'
  }
  const synced = await fixture.app.execute(command)
  assert.equal(synced.ok, true, JSON.stringify(synced))
  assert.equal(synced.data.changed, true)
  assert.equal(synced.data.sessionCompleted, true)
  const completed = fixture.model.sessions[0]
  assert.equal(completed.status, 'completed')
  assert.equal(completed.canResume, false)
  assert.deepEqual(completed.attachCompletion, {
    targetId: resolved.worktreeId,
    pathKey: resolved.pathKey,
    materializationId: synced.data.marker.materializationId,
    completedAt: NOW
  })

  const completionCalls = fixture.calls.filter(([kind]) => kind === 'session-complete').length
  const replay = await fixture.app.execute(command)
  assert.equal(replay.ok, true)
  assert.equal(replay.meta.replayed, true)
  assert.equal(fixture.calls.filter(([kind]) => kind === 'session-complete').length, completionCalls)

  const idempotentPlan = await fixture.app.execute({
    kind: 'planSync',
    meta: fixture.meta('attach-sync-plan-idempotent'),
    worktree: '/probe'
  })
  const idempotent = await fixture.app.execute({
    kind: 'sync',
    meta: fixture.meta('attach-sync-idempotent'),
    worktree: '/probe',
    planHash: idempotentPlan.data.plan.planHash,
    sessionId: completed.id
  })
  assert.equal(idempotent.ok, true, JSON.stringify(idempotent))
  assert.equal(idempotent.data.changed, false)
  assert.equal(idempotent.data.sessionCompleted, true)
  assert.equal(completed.attachCompletion.completedAt, NOW)

  fixture.model.sessions.push({
    id: 'attach-sync-2',
    kind: 'attach',
    status: 'waiting',
    target: { kind: 'worktree', id: resolved.worktreeId },
    startedAt: NOW,
    endedAt: NOW,
    exitCode: 0,
    canResume: true
  })
  const noOpPlan = await fixture.app.execute({
    kind: 'planSync',
    meta: fixture.meta('attach-sync-plan-2'),
    worktree: '/probe'
  })
  const noOp = await fixture.app.execute({
    kind: 'sync',
    meta: fixture.meta('attach-sync-commit-2'),
    worktree: '/probe',
    planHash: noOpPlan.data.plan.planHash,
    sessionId: 'attach-sync-2'
  })
  assert.equal(noOp.ok, true, JSON.stringify(noOp))
  assert.equal(noOp.data.changed, false)
  assert.equal(noOp.data.sessionCompleted, true)
  assert.equal(fixture.model.sessions[1].status, 'completed')
  assert.equal(fixture.calls.filter(([kind]) => kind === 'prepare').length, 1)
  assert.equal(JSON.stringify({ synced, noOp, ledger: fixture.model.ledger, sessions: fixture.model.sessions }).includes('/probe'), false)
})

test('sync refuses unauthorized and conflicting attach completion rows before materialization', async () => {
  const resolved = identity('/probe')
  const authorizationRows = [
    ['missing', [], 'missing-session'],
    ['running', [{
      id: 'running-session', kind: 'attach', status: 'running',
      target: { kind: 'worktree', id: resolved.worktreeId }, startedAt: NOW, exitCode: null, canResume: false
    }], 'running-session'],
    ['exit-nonzero', [{
      id: 'failed-waiting-session', kind: 'attach', status: 'waiting',
      target: { kind: 'worktree', id: resolved.worktreeId }, startedAt: NOW, exitCode: 7, canResume: true
    }], 'failed-waiting-session'],
    ['wrong-kind', [{
      id: 'chat-session', kind: 'chat', status: 'waiting',
      target: { kind: 'worktree', id: resolved.worktreeId }, startedAt: NOW, exitCode: 0, canResume: true
    }], 'chat-session'],
    ['wrong-target', [{
      id: 'other-worktree-session', kind: 'attach', status: 'waiting',
      target: { kind: 'worktree', id: identity('/other').worktreeId }, startedAt: NOW, exitCode: 0, canResume: true
    }], 'other-worktree-session']
  ]
  for (const [name, sessions, sessionId] of authorizationRows) {
    const fixture = createFixture({ sessions })
    const plan = await fixture.app.execute({ kind: 'planSync', meta: fixture.meta(`plan-${name}`), worktree: '/probe' })
    const result = await fixture.app.execute({
      kind: 'sync',
      meta: fixture.meta(`sync-${name}`),
      worktree: '/probe',
      planHash: plan.data.plan.planHash,
      sessionId
    })
    assert.equal(result.ok, false, `${name}: ${JSON.stringify(result)}`)
    assert.equal(result.error.code, 'FIRST_ATTACH_SESSION_REQUIRED', name)
    assert.equal(fixture.calls.some(([kind]) => kind === 'prepare'), false, name)
    assert.equal(fixture.model.currentRecord, null, name)
    assert.equal(fixture.model.state.stateRevision, 4, name)
  }

  const completedNonzero = createFixture({
    sessions: [{
      id: 'completed-nonzero-session',
      kind: 'attach',
      status: 'completed',
      target: { kind: 'worktree', id: resolved.worktreeId },
      startedAt: NOW,
      endedAt: NOW,
      exitCode: 9,
      canResume: false
    }]
  })
  const completedNonzeroPlan = await completedNonzero.app.execute({
    kind: 'planSync',
    meta: completedNonzero.meta('plan-completed-nonzero'),
    worktree: '/probe'
  })
  completedNonzero.model.sessions[0].attachCompletion = {
    targetId: resolved.worktreeId,
    pathKey: resolved.pathKey,
    materializationId: completedNonzeroPlan.data.plan.requested.materializationId,
    completedAt: NOW
  }
  const completedNonzeroResult = await completedNonzero.app.execute({
    kind: 'sync',
    meta: completedNonzero.meta('sync-completed-nonzero'),
    worktree: '/probe',
    planHash: completedNonzeroPlan.data.plan.planHash,
    sessionId: 'completed-nonzero-session'
  })
  assert.equal(completedNonzeroResult.ok, false, JSON.stringify(completedNonzeroResult))
  assert.equal(completedNonzeroResult.error.code, 'FIRST_ATTACH_SESSION_REQUIRED')
  assert.equal(completedNonzero.calls.some(([kind]) => kind === 'prepare'), false)

  const conflictRows = [
    ['legacy-completed-without-proof', undefined],
    ['different-materialization', {
      targetId: resolved.worktreeId,
      pathKey: resolved.pathKey,
      materializationId: identifier('other-materialization'),
      completedAt: NOW
    }],
    ['different-path-key', {
      targetId: resolved.worktreeId,
      pathKey: identity('/other').pathKey,
      materializationId: identifier('placeholder'),
      completedAt: NOW
    }]
  ]
  for (const [name, attachCompletion] of conflictRows) {
    const fixture = createFixture({
      sessions: [{
        id: `completed-${name}`,
        kind: 'attach',
        status: 'completed',
        target: { kind: 'worktree', id: resolved.worktreeId },
        startedAt: NOW,
        endedAt: NOW,
        exitCode: 0,
        canResume: false,
        ...(attachCompletion ? { attachCompletion } : {})
      }]
    })
    const plan = await fixture.app.execute({ kind: 'planSync', meta: fixture.meta(`conflict-plan-${name}`), worktree: '/probe' })
    const result = await fixture.app.execute({
      kind: 'sync',
      meta: fixture.meta(`conflict-sync-${name}`),
      worktree: '/probe',
      planHash: plan.data.plan.planHash,
      sessionId: `completed-${name}`
    })
    assert.equal(result.ok, false, `${name}: ${JSON.stringify(result)}`)
    assert.equal(result.error.code, 'CONFLICT_CONTENT', name)
    assert.equal(fixture.calls.some(([kind]) => kind === 'prepare'), false, name)
    assert.equal(fixture.model.currentRecord, null, name)
  }
})

for (const [name, options] of [
  ['session write', { sessionCompletionFailure: true }],
  ['participant publish', { publishFailure: true }]
]) {
  test(`sync rolls back state, marker record, attach completion, and participant after ${name} failure`, async () => {
    const slug = name.replaceAll(' ', '-')
    const resolved = identity('/probe')
    const fixture = createFixture({
      ...options,
      sessions: [{
        id: `rollback-${slug}`,
        kind: 'attach',
        status: 'waiting',
        target: { kind: 'worktree', id: resolved.worktreeId },
        startedAt: NOW,
        endedAt: NOW,
        exitCode: 0,
        canResume: true
      }]
    })
    const plan = await fixture.app.execute({
      kind: 'planSync',
      meta: fixture.meta(`rollback-plan-${slug}`),
      worktree: '/probe'
    })
    const result = await fixture.app.execute({
      kind: 'sync',
      meta: fixture.meta(`rollback-sync-${slug}`),
      worktree: '/probe',
      planHash: plan.data.plan.planHash,
      sessionId: fixture.model.sessions[0].id
    })
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(result.error.code, 'PORT_FAILURE')
    assert.equal(fixture.model.state.stateRevision, 4)
    assert.equal(fixture.model.state.worktrees[resolved.pathKey].materializedSnapshot, null)
    assert.equal(fixture.model.currentRecord, null)
    assert.equal(fixture.model.externalMarker, null)
    assert.equal(fixture.model.sessions[0].status, 'waiting')
    assert.equal(fixture.model.sessions[0].attachCompletion, undefined)
    assert.equal(fixture.calls.some(([kind]) => kind === 'adapter-rollback'), true)
  })
}

test('sync rejects stale, legacy-link, and invalid prepared-marker paths without publishing', async () => {
  const stale = createFixture()
  const staleResult = await stale.app.execute({
    kind: 'sync',
    meta: stale.meta('sync-stale'),
    worktree: '/probe',
    planHash: identifier('stale')
  })
  assert.equal(staleResult.ok, false, JSON.stringify(staleResult))
  assert.equal(staleResult.error.code, 'MATERIALIZE_PLAN_STALE')
  assert.equal(stale.model.externalMarker, null)

  const legacy = createFixture({ legacyConflict: true })
  const legacyPlan = await legacy.app.execute({ kind: 'planSync', meta: legacy.meta('legacy-plan'), worktree: '/probe' })
  assert.equal(legacyPlan.ok, true)
  assert.equal(legacyPlan.data.status, 'conflict')
  const legacySync = await legacy.app.execute({
    kind: 'sync',
    meta: legacy.meta('legacy-sync'),
    worktree: '/probe',
    planHash: legacyPlan.data.plan.planHash
  })
  assert.equal(legacySync.ok, false)
  assert.equal(legacySync.error.code, 'LEGACY_MIGRATION_REQUIRED')
  assert.equal(legacy.calls.some(([kind]) => kind === 'prepare'), false)

  const invalid = createFixture({ invalidMarker: true })
  const invalidPlan = await invalid.app.execute({ kind: 'planSync', meta: invalid.meta('invalid-plan'), worktree: '/probe' })
  const invalidSync = await invalid.app.execute({
    kind: 'sync',
    meta: invalid.meta('invalid-sync'),
    worktree: '/probe',
    planHash: invalidPlan.data.plan.planHash
  })
  assert.equal(invalidSync.ok, false)
  assert.equal(invalidSync.error.code, 'MATERIALIZATION_MARKER_INVALID')
  assert.equal(invalid.model.externalMarker, null)
  assert.equal(invalid.model.currentRecord, null)
  assert.equal(invalid.model.state.stateRevision, 4)
  assert.equal(invalid.calls.some(([kind]) => kind === 'participant-rollback'), true)
})

test('legacy migration and rollback use frozen plans, durable proofs, and replay-safe participants', async () => {
  const fixture = createFixture({ legacyMode: true })
  const ordinary = await fixture.app.execute({
    kind: 'planSync',
    meta: fixture.meta('legacy-ordinary-plan'),
    worktree: '/probe'
  })
  assert.equal(ordinary.ok, true, JSON.stringify(ordinary))
  assert.equal(ordinary.data.status, 'conflict')

  const dryRun = await fixture.app.execute({
    kind: 'migrateLegacy',
    meta: fixture.meta('legacy-dry-run'),
    worktree: '/probe',
    mode: 'dryRun'
  })
  assert.equal(dryRun.ok, true, JSON.stringify(dryRun))
  assert.equal(dryRun.data.status, 'planned')
  assert.equal(dryRun.data.plan.executable, true)
  assert.ok(dryRun.data.plan.summary.replaceWithCopy > 0)
  assert.equal(
    dryRun.data.plan.backupPrivateStateId,
    legacyBackupPrivateStateId(fixture.identity)
  )
  assert.match(dryRun.data.plan.backupManifestId, /^sha256:[a-f0-9]{64}$/u)
  assert.notEqual(dryRun.data.plan.backupManifestId, dryRun.data.plan.backupPrivateStateId)
  assert.equal(fixture.model.externalMarker, null)
  assert.equal(fixture.model.state.stateRevision, 4)

  const committed = await fixture.app.execute({
    kind: 'migrateLegacy',
    meta: fixture.meta('legacy-commit'),
    worktree: '/probe',
    mode: 'commit',
    planHash: dryRun.data.plan.planHash
  })
  assert.equal(committed.ok, true, JSON.stringify(committed))
  assert.equal(committed.data.status, 'committed')
  assert.equal(committed.data.migration.status, 'committed')
  assert.equal(committed.data.migration.backupManifestId, dryRun.data.plan.backupManifestId)
  assert.equal(committed.data.migration.backupPrivateStateId, dryRun.data.plan.backupPrivateStateId)
  assert.equal(committed.data.migration.visibilityStateId, dryRun.data.plan.requested.visibilityStateId)
  assert.deepEqual(fixture.model.legacyRecords[committed.data.migration.migrationId], committed.data.migration)
  assert.equal(committed.data.marker, undefined)
  assert.equal(fixture.model.externalMarker.origin.kind, 'legacyMigration')
  assert.equal(fixture.model.currentRecord.marker.origin.migrationId, committed.data.migration.migrationId)
  assert.equal(fixture.model.state.worktrees[fixture.identity.pathKey].materializedSnapshot, fixture.model.snapshot.snapshotId)
  assert.equal(fixture.model.state.stateRevision, 5)
  assert.equal(JSON.stringify(fixture.model.ledger).includes('/probe'), false)

  const repeated = await fixture.app.execute({
    kind: 'migrateLegacy',
    meta: fixture.meta('legacy-repeat'),
    worktree: '/probe',
    mode: 'commit',
    planHash: dryRun.data.plan.planHash
  })
  assert.equal(repeated.ok, true)
  assert.equal(repeated.data.status, 'already-migrated')
  assert.equal(fixture.model.state.stateRevision, 5)

  const rollbackDryRun = await fixture.app.execute({
    kind: 'rollbackLegacyMigration',
    meta: fixture.meta('legacy-rollback-dry-run'),
    worktree: '/probe',
    migrationId: committed.data.migration.migrationId,
    mode: 'dryRun'
  })
  assert.equal(rollbackDryRun.ok, true, JSON.stringify(rollbackDryRun))
  assert.equal(rollbackDryRun.data.status, 'planned')
  assert.equal(rollbackDryRun.data.plan.executable, true)
  assert.equal(rollbackDryRun.data.plan.backupManifestId, committed.data.migration.backupManifestId)
  assert.equal(rollbackDryRun.data.plan.backupPrivateStateId, committed.data.migration.backupPrivateStateId)
  assert.deepEqual(
    rollbackDryRun.data.plan.operations
      .filter((operation) => operation.action === 'restoreLink')
      .map((operation) => operation.restore.sourceStateId),
    legacyRestoreSources(committed.data.migration).map((source) => source.sourceStateId)
  )

  const rolledBack = await fixture.app.execute({
    kind: 'rollbackLegacyMigration',
    meta: fixture.meta('legacy-rollback-commit'),
    worktree: '/probe',
    migrationId: committed.data.migration.migrationId,
    mode: 'commit',
    planHash: rollbackDryRun.data.plan.planHash
  })
  assert.equal(rolledBack.ok, true, JSON.stringify(rolledBack))
  assert.equal(rolledBack.data.status, 'rolled-back')
  assert.equal(rolledBack.data.migration.status, 'rolledBack')
  assert.equal(rolledBack.data.migration.rollbackPlanHash, rollbackDryRun.data.plan.planHash)
  assert.equal(rolledBack.data.migration.backupManifestId, committed.data.migration.backupManifestId)
  assert.equal(rolledBack.data.migration.backupPrivateStateId, committed.data.migration.backupPrivateStateId)
  assert.deepEqual(rolledBack.data.migration.artifacts, committed.data.migration.artifacts)
  assert.deepEqual(rolledBack.data.migration.createdArtifacts, committed.data.migration.createdArtifacts)
  assert.equal(fixture.model.currentRecord.marker, null)
  assert.equal(fixture.model.externalMarker, null)
  assert.equal(fixture.model.state.worktrees[fixture.identity.pathKey].materializedSnapshot, null)
  assert.equal(fixture.model.state.stateRevision, 6)

  const repeatedRollback = await fixture.app.execute({
    kind: 'rollbackLegacyMigration',
    meta: fixture.meta('legacy-rollback-repeat'),
    worktree: '/probe',
    migrationId: committed.data.migration.migrationId,
    mode: 'commit',
    planHash: rollbackDryRun.data.plan.planHash
  })
  assert.equal(repeatedRollback.ok, true)
  assert.equal(repeatedRollback.data.status, 'already-rolled-back')
  assert.equal(fixture.model.state.stateRevision, 6)

  const remigration = await fixture.app.execute({
    kind: 'migrateLegacy',
    meta: fixture.meta('legacy-remigrate'),
    worktree: '/probe',
    mode: 'dryRun'
  })
  assert.equal(remigration.ok, true, JSON.stringify(remigration))
  assert.equal(remigration.data.status, 'planned')
  assert.equal(remigration.data.plan.executable, true)
  assert.equal(remigration.data.plan.backupManifestId, committed.data.migration.backupManifestId)
  assert.equal(remigration.data.plan.backupPrivateStateId, committed.data.migration.backupPrivateStateId)
})

test('legacy common exclusion changes refuse unsafe sibling visibility for migration and rollback', async () => {
  const unsafeMigration = createFixture({ legacyMode: true, siblingUnsafe: true })
  const migrationPlan = await unsafeMigration.app.execute({
    kind: 'migrateLegacy',
    meta: unsafeMigration.meta('unsafe-sibling-migration-plan'),
    worktree: '/probe',
    mode: 'dryRun'
  })
  assert.equal(migrationPlan.ok, true, JSON.stringify(migrationPlan))
  assert.equal(migrationPlan.data.status, 'conflict')
  assert.equal(migrationPlan.data.plan.git.configuration.conflictKind, 'siblingVisibilityRisk')
  const migrationCommit = await unsafeMigration.app.execute({
    kind: 'migrateLegacy',
    meta: unsafeMigration.meta('unsafe-sibling-migration-commit'),
    worktree: '/probe',
    mode: 'commit',
    planHash: migrationPlan.data.plan.planHash
  })
  assert.equal(migrationCommit.ok, false)
  assert.equal(migrationCommit.error.code, 'CONFLICT_PATH')
  assert.equal(unsafeMigration.calls.some(([kind]) => kind === 'prepare-legacy'), false)

  const unsafeRollback = createFixture({ legacyMode: true })
  const safePlan = await unsafeRollback.app.execute({
    kind: 'migrateLegacy',
    meta: unsafeRollback.meta('safe-before-unsafe-plan'),
    worktree: '/probe',
    mode: 'dryRun'
  })
  const committed = await unsafeRollback.app.execute({
    kind: 'migrateLegacy',
    meta: unsafeRollback.meta('safe-before-unsafe-commit'),
    worktree: '/probe',
    mode: 'commit',
    planHash: safePlan.data.plan.planHash
  })
  assert.equal(committed.ok, true, JSON.stringify(committed))
  unsafeRollback.model.siblingUnsafe = true
  const rollbackPlan = await unsafeRollback.app.execute({
    kind: 'rollbackLegacyMigration',
    meta: unsafeRollback.meta('unsafe-sibling-rollback-plan'),
    worktree: '/probe',
    migrationId: committed.data.migration.migrationId,
    mode: 'dryRun'
  })
  assert.equal(rollbackPlan.ok, true, JSON.stringify(rollbackPlan))
  assert.equal(rollbackPlan.data.status, 'conflict')
  assert.equal(rollbackPlan.data.plan.git.configuration.conflictKind, 'siblingVisibilityRisk')
  const rollbackCommit = await unsafeRollback.app.execute({
    kind: 'rollbackLegacyMigration',
    meta: unsafeRollback.meta('unsafe-sibling-rollback-commit'),
    worktree: '/probe',
    migrationId: committed.data.migration.migrationId,
    mode: 'commit',
    planHash: rollbackPlan.data.plan.planHash
  })
  assert.equal(rollbackCommit.ok, false)
  assert.equal(rollbackCommit.error.code, 'LEGACY_ROLLBACK_CONFLICT')
  assert.equal(unsafeRollback.model.externalMarker.origin.kind, 'legacyMigration')
})
