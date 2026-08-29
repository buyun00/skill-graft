import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import path from 'node:path'
import test from 'node:test'

import {
  ApplicationTransactionErrorBase,
  createHubApplication,
  createMemoryApplicationTransactions,
  createMemoryRequestLedger,
  createMemorySessions,
  portFault
} from '../dist/application/index.js'
import { createLocalApplicationPorts } from '../dist/adapters/local-application-ports.js'
import { createLocalHost } from '../dist/local/create-local-host.js'
import {
  AUDIT_EVENT_TYPES,
  CONTRACT_VERSION,
  HUB_ERROR_CODES,
  QUERY_COMMAND_KINDS,
  UNKNOWN_COMMAND_KIND,
  WRITE_COMMAND_KINDS
} from '../dist/contracts/index.js'
import {
  PIN_SCHEMA_VERSION,
  classifyConflict,
  decideFirstAttach,
  evaluateClaim,
  recognizeWorktree,
  transitionInbox,
  validatePin
} from '../dist/core/policies.js'
import { planLegacyAttach } from '../dist/core/legacy-attach.js'
import { createLibrarySnapshotManifest } from '../dist/core/snapshot.js'
import {
  buildDesiredMaterialization,
  createGitMaterializationConfigurationFact,
  createGitMaterializationSiblingProof,
  createGitVisibilityFact,
  createRuntimeAssetManifest,
  createVisibilityOwnershipState,
  gitMaterializationConfigurationValueId,
  materializationSourceArtifactId,
  visibilityOwnershipTargetBaselineDigest
} from '../dist/core/index.js'

const posix = path.posix
const FIXED_NOW = '2030-01-02T03:04:05.000Z'

class TrustedSnapshotInvalidError extends ApplicationTransactionErrorBase {
  constructor() {
    super('invalid snapshot')
    this.code = 'SNAPSHOT_INVALID'
    this.retryable = false
  }
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function normalized(value) {
  return posix.resolve('/', String(value).replaceAll('\\', '/'))
}

function worktreeTargetId(value) {
  const canonical = normalized(value)
  return `worktree:${createHash('sha256').update(canonical).digest('hex').slice(0, 24)}`
}

function memorySnapshot(seed, createdAt = FIXED_NOW) {
  const planned = createLibrarySnapshotManifest({
    source: { kind: 'library', id: 'memory-library', revision: `revision-${seed}` },
    createdAt,
    files: [
      {
        path: 'AGENTS.override.md',
        size: Buffer.byteLength(`override-${seed}`),
        sha256: `sha256:${createHash('sha256').update(`override-${seed}`).digest('hex')}`,
        mode: '100644',
        isReparsePoint: false
      },
      {
        path: 'skills/ozdqp-development/SKILL.md',
        size: Buffer.byteLength(seed),
        sha256: `sha256:${createHash('sha256').update(seed).digest('hex')}`,
        mode: '100644',
        isReparsePoint: false
      }
    ]
  })
  assert.equal(planned.ok, true)
  return planned.manifest
}

const DEFAULT_MEMORY_SNAPSHOT = memorySnapshot('memory-default')
const SECOND_MEMORY_SNAPSHOT = memorySnapshot('memory-second')

function createMemoryP2Ports(context, options = {}) {
  const snapshots = (options.snapshots || [DEFAULT_MEMORY_SNAPSHOT, SECOND_MEMORY_SNAPSHOT]).map(clone)
  return {
    identities: {
      resolve(worktree) {
        const resolved = context.path.resolve(worktree)
        const canonical = context.fs.realpath(resolved) || resolved
        const comparisonKey = context.path.comparisonKey(canonical)
        return {
          pathKey: `sha256:${context.hash.sha256(comparisonKey)}`,
          worktreeId: worktreeTargetId(canonical)
        }
      }
    },
    snapshots: {
      observe() {
        return {
          captureId: 'memory-capture',
          source: DEFAULT_MEMORY_SNAPSHOT.source,
          files: DEFAULT_MEMORY_SNAPSHOT.files.map((file) => ({ ...file, isReparsePoint: false }))
        }
      },
      store(_captureId, approved) {
        const existing = snapshots.find((manifest) => manifest.snapshotId === approved.snapshotId)
        if (existing) return { manifest: clone(existing), deduplicated: true }
        snapshots.push(clone(approved))
        return { manifest: clone(approved), deduplicated: false }
      },
      list: () => snapshots.map(clone),
      read: (snapshotId) => clone(snapshots.find((manifest) => manifest.snapshotId === snapshotId) || null)
    },
    state: {
      readDocument: () => context.persist.readJson('/hub/skill-review/state.json', null),
      writeV2: (state) => context.persist.writeJson('/hub/skill-review/state.json', state),
      runtimeRevision: () => 'memory-runtime',
      observeV1Worktrees: () => []
    },
    memorySnapshots: snapshots
  }
}

function installCurrentMemoryState(context, p2, claimedWorktree) {
  const legacy = context.persist.readState('/hub/skill-review/state.json')
  const worktrees = {}
  if (claimedWorktree) {
    const identity = p2.identities.resolve(claimedWorktree)
    worktrees[identity.pathKey] = {
      schemaVersion: 1,
      pathKey: identity.pathKey,
      worktreeId: identity.worktreeId,
      requestedSnapshot: DEFAULT_MEMORY_SNAPSHOT.snapshotId,
      materializedSnapshot: DEFAULT_MEMORY_SNAPSHOT.snapshotId,
      selectedSkills: ['ozdqp-development'],
      claimState: 'claimed'
    }
  }
  context.persist.writeJson('/hub/skill-review/state.json', {
    schemaVersion: 2,
    stateRevision: 1,
    runtimeRevision: 'memory-runtime',
    librarySnapshots: p2.memorySnapshots.map((manifest) => manifest.snapshotId).sort(),
    worktrees,
    items: legacy.items || [],
    lastIngest: legacy.lastIngest || null
  })
}

function sha256Identifier(value) {
  return `sha256:${createHash('sha256').update(String(value)).digest('hex')}`
}

function createMemoryRuntimeAsset() {
  const bytes = 'memory-overlay-v1'
  const created = createRuntimeAssetManifest({
    runtimeRevision: 'memory-runtime',
    files: [{
      path: 'HubLib.ps1',
      size: Buffer.byteLength(bytes),
      sha256: sha256Identifier(bytes),
      mode: '100644',
      isReparsePoint: false
    }]
  })
  assert.equal(created.ok, true)
  return created.manifest
}

const DEFAULT_MEMORY_RUNTIME_ASSET = createMemoryRuntimeAsset()

function desiredMemoryMaterialization(snapshot, runtimeAsset, selectedSkills, visibilityStateId) {
  const built = buildDesiredMaterialization({ snapshot, runtimeAsset, selectedSkills, visibilityStateId })
  assert.equal(built.ok, true, JSON.stringify(built))
  return built.desired
}

function memoryVisibilityBaseline(artifact, phase) {
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

function memoryVisibilityPrivateStateId(identity, restore = false) {
  return sha256Identifier(`${restore ? 'restore-' : ''}memory-visibility-private:${identity.pathKey}`)
}

function memoryLegacyBackupPrivateStateId(identity) {
  return sha256Identifier(`memory-legacy-backup-private:${identity.pathKey}`)
}

function memoryLegacyRestoreSources(record) {
  return record.artifacts.map((artifact) => ({
    artifactId: artifact.artifactId,
    targetRelativePath: artifact.targetRelativePath,
    legacyKind: artifact.legacyKind,
    sourceArtifactId: artifact.sourceArtifactId,
    sourceStateId: sha256Identifier(
      `memory-legacy-restore-source:${record.backupPrivateStateId}:${artifact.targetRelativePath}`
    ),
    status: 'valid'
  }))
}

function memoryDesiredBundle(model, input, options = {}) {
  const provisional = desiredMemoryMaterialization(
    input.snapshot,
    input.runtimeAsset,
    input.selectedSkills,
    sha256Identifier('memory-provisional-visibility-state')
  )
  const currentTargets = new Map((model.currentVisibilityState?.targets ?? []).map((target) => [
    target.targetRelativePath,
    target
  ]))
  const ownership = createVisibilityOwnershipState({
    privateStateId: options.restore
      ? memoryVisibilityPrivateStateId(input.identity, true)
      : model.currentVisibilityState?.privateStateId
        ?? memoryVisibilityPrivateStateId(input.identity),
    pathKey: input.identity.pathKey,
    worktreeId: input.identity.worktreeId,
    baseExclude: model.currentVisibilityState?.baseExclude ?? {
      scope: 'global',
      valueId: gitMaterializationConfigurationValueId('memory-base-exclude'),
      contentDigest: sha256Identifier('memory-base-exclude-content')
    },
    targets: options.restore
      ? []
      : provisional.artifacts.map((artifact) => (
          currentTargets.get(artifact.targetRelativePath)
            ?? memoryVisibilityBaseline(artifact, model.phase === 'legacy' ? 'legacy' : 'fresh')
        ))
  })
  assert.equal(ownership.ok, true, JSON.stringify(ownership))
  const desired = desiredMemoryMaterialization(
    input.snapshot,
    input.runtimeAsset,
    input.selectedSkills,
    options.restore && model.currentVisibilityState
      ? model.currentVisibilityState.visibilityStateId
      : ownership.state.visibilityStateId
  )
  return { desired, desiredVisibilityState: ownership.state }
}

function memoryGitProofs(desired, desiredVisibilityState, phase, currentVisibilityState = null) {
  const managed = phase === 'managed'
  const legacy = phase === 'legacy'
  const currentTargets = new Map((currentVisibilityState?.targets ?? []).map((target) => [
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
      ?? memoryVisibilityBaseline(artifact, legacy ? 'legacy' : 'fresh')
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
      ownershipStateId: managed ? currentVisibilityState?.visibilityStateId ?? null : null,
      baselineDigest,
      restoreDigest: managed ? unmanaged.fact.factDigest : null,
      restoreSafe: true
    })
    assert.equal(created.ok, true)
    return created.fact
  })
  const siblingProof = createGitMaterializationSiblingProof([])
  assert.equal(siblingProof.ok, true)
  const desiredHooks = gitMaterializationConfigurationValueId('memory-desired-hooks')
  const desiredOverlay = gitMaterializationConfigurationValueId('memory-desired-overlay')
  const desiredWatchWorkspace = gitMaterializationConfigurationValueId('memory-desired-watch-workspace')
  const desiredExcludes = gitMaterializationConfigurationValueId('memory-desired-excludes')
  const baseExcludeValueId = gitMaterializationConfigurationValueId('memory-base-exclude')
  const baseExcludeContentDigest = sha256Identifier('memory-base-exclude-content')
  const basePrivateExclude = sha256Identifier('memory-private-exclude-base')
  const desiredPrivateExclude = sha256Identifier('memory-private-exclude-projection')
  const cleanCommon = sha256Identifier('memory-common-info-clean')
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
    commonInfoExcludeDigest: legacy ? sha256Identifier('memory-common-info-legacy') : cleanCommon,
    cleanCommonInfoExcludeDigest: cleanCommon,
    legacyCommonSiblingSafety: siblingProof.proof.legacyCommonSiblingSafety,
    siblingFactsDigest: siblingProof.proof.siblingFactsDigest
  })
  return { gitFacts, gitConfiguration }
}

function memoryLegacyArtifacts(desired, phase) {
  const linked = phase === 'legacy'
  return desired.artifacts.map((artifact) => {
    const sourceArtifactId = linked
      ? materializationSourceArtifactId({ digest: artifact.digest, source: artifact.source })
      : null
    return {
      artifactId: artifact.artifactId,
      owner: artifact.owner,
      targetRelativePath: artifact.targetRelativePath,
      kind: artifact.kind,
      observedKind: linked ? artifact.kind === 'file' ? 'hardlink' : 'junction' : artifact.kind,
      digest: artifact.digest,
      isReparsePoint: linked && artifact.kind === 'directory',
      legacyKind: linked ? artifact.kind === 'file' ? 'fileHardlink' : 'directoryLink' : null,
      sourceArtifactId,
      pathEscaped: false,
      protected: false
    }
  })
}

function createMemoryP3Ports(p2, options = {}) {
  const runtimeAsset = clone(options.runtimeAsset || DEFAULT_MEMORY_RUNTIME_ASSET)
  const model = {
    phase: options.phase || 'fresh',
    externalMarker: null,
    currentRecord: null,
    currentVisibilityState: null,
    legacyBackupPrivateStateId: null,
    legacyRecords: {}
  }
  const calls = {
    stateWrite: 0,
    prepare: 0,
    prepareLegacyMigration: 0,
    prepareLegacyRollback: 0,
    publish: 0,
    recordWrite: 0,
    migrationWrite: 0
  }
  let participantSequence = 0

  if (options.resetMaterialized !== false) {
    const state = p2.state.readDocument()
    if (state?.schemaVersion === 2) {
      p2.state.writeV2({
        ...state,
        worktrees: Object.fromEntries(Object.entries(state.worktrees).map(([pathKey, pin]) => [
          pathKey,
          { ...pin, materializedSnapshot: null }
        ]))
      })
    }
  }
  const writeV2 = p2.state.writeV2.bind(p2.state)
  p2.state.writeV2 = (state) => {
    calls.stateWrite += 1
    return writeV2(state)
  }

  function desired(input) {
    return memoryDesiredBundle(model, input)
  }

  function markerFor(plan, origin) {
    const built = memoryDesiredBundle(model, {
      snapshot: p2.snapshots.read(plan.requested.snapshotId),
      runtimeAsset,
      selectedSkills: plan.requested.selectedSkills,
      identity: { pathKey: plan.pathKey, worktreeId: plan.worktreeId }
    })
    assert.equal(built.desiredVisibilityState.visibilityStateId, plan.requested.visibilityStateId)
    return {
      marker: {
        schemaVersion: 1,
        materializationId: plan.requested.materializationId,
        planHash: plan.planHash,
        pathKey: plan.pathKey,
        worktreeId: plan.worktreeId,
        snapshotId: plan.requested.snapshotId,
        selectedSkills: [...plan.requested.selectedSkills],
        runtimeRevision: plan.requested.runtimeRevision,
        runtimeAssetId: plan.requested.runtimeAssetId,
        visibilityStateId: plan.requested.visibilityStateId,
        origin,
        artifacts: built.desired.artifacts.map(({ source: _source, files: _files, ...artifact }) => artifact)
      },
      visibilityState: built.desiredVisibilityState
    }
  }

  function participant(phase, marker = null, visibilityState = null, backupPrivateStateId = null) {
    const participantId = `memory-p3-${phase}-${++participantSequence}`
    return {
      participantId,
      publish() {
        calls.publish += 1
        if (phase === 'rollback') {
          model.phase = 'legacy'
          model.externalMarker = null
          model.currentVisibilityState = null
        } else {
          model.phase = 'managed'
          model.externalMarker = clone(marker)
          model.currentVisibilityState = clone(visibilityState)
          if (backupPrivateStateId !== null) {
            model.legacyBackupPrivateStateId = backupPrivateStateId
          }
        }
      },
      rollback() {},
      finalize(context) {
        assert.equal(typeof context?.revalidateLease, 'function')
        return context.revalidateLease()
      }
    }
  }

  const ports = {
    runtimeAssets: {
      observe: () => clone(runtimeAsset),
      readVerifiedFile() {
        throw new Error('memory runtime bytes are not required by the materialization contract fixture')
      }
    },
    records: {
      readCurrent: () => clone(model.currentRecord),
      writeCurrent(record) {
        calls.recordWrite += 1
        model.currentRecord = clone(record)
      },
      readLegacyMigration(migrationId) {
        return clone(model.legacyRecords[migrationId] || null)
      },
      writeLegacyMigration(record) {
        calls.migrationWrite += 1
        model.legacyRecords[record.migrationId] = clone(record)
      }
    },
    materialize: {
      inspect(input) {
        const bundle = desired(input)
        const requested = bundle.desired
        const current = new Map((model.externalMarker?.artifacts || []).map((artifact) => [
          artifact.targetRelativePath,
          artifact
        ]))
        const observations = requested.artifacts.map((artifact) => {
          if (model.phase === 'legacy') {
            return {
              targetRelativePath: artifact.targetRelativePath,
              kind: artifact.kind === 'file' ? 'hardlink' : 'junction',
              digest: artifact.digest,
              isReparsePoint: artifact.kind === 'directory',
              linkClassification: 'legacy'
            }
          }
          const existing = current.get(artifact.targetRelativePath)
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
          ...memoryGitProofs(
            requested,
            bundle.desiredVisibilityState,
            model.phase,
            model.currentVisibilityState
          )
        }
      },
      inspectLegacy(input) {
        const bundle = desired(input)
        const requested = bundle.desired
        return {
          observedMarker: clone(model.externalMarker),
          currentVisibilityState: clone(model.currentVisibilityState),
          desiredVisibilityState: clone(bundle.desiredVisibilityState),
          backupPrivateStateId: model.legacyBackupPrivateStateId
            ?? memoryLegacyBackupPrivateStateId(input.identity),
          artifacts: memoryLegacyArtifacts(requested, model.phase),
          ...memoryGitProofs(
            requested,
            bundle.desiredVisibilityState,
            model.phase,
            model.currentVisibilityState
          )
        }
      },
      inspectLegacyRollback(input) {
        assert.deepEqual(input.migration, model.legacyRecords[input.migration.migrationId])
        const bundle = memoryDesiredBundle(model, input, { restore: true })
        const requested = bundle.desired
        const retained = model.currentVisibilityState ?? desired(input).desiredVisibilityState
        const restore = memoryGitProofs(requested, retained, 'legacy')
        return {
          observedMarker: clone(model.externalMarker),
          currentVisibilityState: clone(model.currentVisibilityState),
          desiredVisibilityState: clone(bundle.desiredVisibilityState),
          backupPrivateStateId: input.migration.backupPrivateStateId,
          restoreSources: memoryLegacyRestoreSources(input.migration),
          artifacts: memoryLegacyArtifacts(requested, model.phase),
          ...memoryGitProofs(requested, retained, model.phase, model.currentVisibilityState),
          restoreGitFacts: restore.gitFacts,
          restoreGitConfiguration: restore.gitConfiguration
        }
      },
      async prepare({ guard, plan }) {
        calls.prepare += 1
        assert.equal(typeof guard?.revalidateLease, 'function')
        await guard.revalidateLease()
        const prepared = markerFor(plan, { kind: 'sync' })
        return {
          marker: prepared.marker,
          report: { preparedOperations: plan.operations.length, preparedBytes: 64 },
          participant: participant('sync', prepared.marker, prepared.visibilityState)
        }
      },
      async recover({ guard }) {
        await guard.revalidateLease()
        return { status: 'clean', recoveredTransactions: 0 }
      },
      async prepareLegacyMigration({ guard, plan }) {
        calls.prepareLegacyMigration += 1
        assert.equal(typeof guard?.revalidateLease, 'function')
        await guard.revalidateLease()
        const prepared = markerFor(plan, { kind: 'legacyMigration', migrationId: plan.migrationId })
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
        return {
          marker: prepared.marker,
          record,
          report: { preparedOperations: plan.operations.length, preparedBytes: 96 },
          participant: participant(
            'migration',
            prepared.marker,
            prepared.visibilityState,
            plan.backupPrivateStateId
          )
        }
      },
      async prepareLegacyRollback({ guard, plan, migration }) {
        calls.prepareLegacyRollback += 1
        assert.equal(typeof guard?.revalidateLease, 'function')
        await guard.revalidateLease()
        const current = model.legacyRecords[plan.migrationId]
        assert.ok(current)
        assert.deepEqual(migration, current)
        assert.equal(migration.backupManifestId, plan.backupManifestId)
        assert.equal(migration.backupPrivateStateId, plan.backupPrivateStateId)
        return {
          record: { ...clone(current), status: 'rolledBack', rollbackPlanHash: plan.planHash },
          report: { preparedOperations: plan.operations.length, preparedBytes: 48 },
          participant: participant('rollback')
        }
      }
    }
  }
  return { ports, calls, model }
}

function memoryApplicationInfrastructure(context, options = {}) {
  const p2 = createMemoryP2Ports(context, options.p2)
  return {
    p2,
    p3: createMemoryP3Ports(p2, options.p3),
    transactions: createMemoryApplicationTransactions()
  }
}

function createMemoryFs() {
  const nodes = new Map([['/', { kind: 'dir', text: '', mtime: 1 }]])
  let tick = 10

  function mkdirp(target) {
    const absolute = normalized(target)
    const parts = absolute.split('/').filter(Boolean)
    let current = ''
    for (const part of parts) {
      current += `/${part}`
      if (!nodes.has(current)) nodes.set(current, { kind: 'dir', text: '', mtime: tick++ })
    }
  }

  function writeText(target, contents) {
    const absolute = normalized(target)
    mkdirp(posix.dirname(absolute))
    nodes.set(absolute, { kind: 'file', text: String(contents), mtime: tick++ })
  }

  function remove(target) {
    const absolute = normalized(target)
    for (const key of [...nodes.keys()]) {
      if (key === absolute || key.startsWith(`${absolute}/`)) nodes.delete(key)
    }
  }

  function rename(from, to) {
    const source = normalized(from)
    const destination = normalized(to)
    const moving = [...nodes.entries()].filter(([key]) => key === source || key.startsWith(`${source}/`))
    if (moving.length === 0) throw new Error(`missing ${source}`)
    remove(destination)
    mkdirp(posix.dirname(destination))
    for (const [key] of moving) nodes.delete(key)
    for (const [key, value] of moving) {
      nodes.set(`${destination}${key.slice(source.length)}`, { ...value, mtime: tick++ })
    }
  }

  return {
    nodes,
    exists(target) {
      return nodes.has(normalized(target))
    },
    isDirectory(target) {
      return nodes.get(normalized(target))?.kind === 'dir'
    },
    isFile(target) {
      return nodes.get(normalized(target))?.kind === 'file'
    },
    readDir(target) {
      const absolute = normalized(target)
      if (nodes.get(absolute)?.kind !== 'dir') throw new Error(`not a directory: ${absolute}`)
      const prefix = absolute === '/' ? '/' : `${absolute}/`
      const children = new Map()
      for (const [key, node] of nodes) {
        if (!key.startsWith(prefix) || key === absolute) continue
        const suffix = key.slice(prefix.length)
        const name = suffix.split('/')[0]
        if (!name) continue
        const direct = `${prefix}${name}`.replace('//', '/')
        const directNode = nodes.get(direct)
        children.set(name, {
          name,
          isDirectory: directNode?.kind === 'dir' || suffix.includes('/'),
          isSymbolicLink: false
        })
      }
      return [...children.values()].sort((left, right) => left.name.localeCompare(right.name))
    },
    readText(target) {
      const node = nodes.get(normalized(target))
      return node?.kind === 'file' ? node.text : null
    },
    writeText,
    mkdirp,
    remove,
    rename,
    statMtimeMs(target) {
      return nodes.get(normalized(target))?.mtime || 0
    },
    statId(target) {
      const absolute = normalized(target)
      if (!nodes.has(absolute)) return null
      let ino = 0
      for (const character of absolute) ino = (ino * 31 + character.charCodeAt(0)) >>> 0
      return { ino, dev: 1 }
    },
    realpath(target) {
      const absolute = normalized(target)
      return nodes.has(absolute) ? absolute : null
    }
  }
}

function seedVirtualHub(fs) {
  fs.mkdirp('/hub/skills/adopted/team-skill')
  fs.writeText('/hub/skills/adopted/team-skill/SKILL.md', '# Team skill\n')
  for (const name of ['ozdqp-development', 'ozdqp-ui-development', 'ozdqp-git-workflow']) {
    fs.mkdirp(`/hub/skills/${name}`)
    fs.writeText(`/hub/skills/${name}/SKILL.md`, `# ${name}\n`)
  }
  fs.mkdirp('/hub/skills/inbox/queued-skill')
  fs.writeText('/hub/skills/inbox/queued-skill/SKILL.md', '# Queued\n')
  fs.mkdirp('/hub/skills/inbox/reject-skill')
  fs.writeText('/hub/skills/inbox/reject-skill/SKILL.md', '# Reject\n')
  fs.writeText('/hub/skill-review/state.json', JSON.stringify({
    version: 1,
    lastIngest: null,
    items: [
      {
        id: 'queued-1',
        name: 'queued-skill',
        unit: '.agents/skills/queued-skill',
        status: 'queued',
        inboxPath: 'skills/inbox/queued-skill',
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW
      },
      {
        id: 'reject-1',
        name: 'reject-skill',
        unit: '.agents/skills/reject-skill',
        status: 'queued',
        inboxPath: 'skills/inbox/reject-skill',
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW
      }
    ]
  }))
  fs.writeText('/hub/skill-review/history/history-1.json', JSON.stringify({
    id: 'history-1',
    type: 'fixture.created',
    at: FIXED_NOW,
    summary: 'memory fixture'
  }))
  fs.mkdirp('/game-tree/baloot_client')
  fs.writeText('/game-tree/AGENTS.md', '# Test checkout\n')
  fs.mkdirp('/foreign-tree')
}

function createContext() {
  const fs = createMemoryFs()
  seedVirtualHub(fs)
  const links = new Map()
  let id = 0
  const context = {
    hubRoot: '/hub',
    path: {
      join: (...parts) => posix.join(...parts.map((part) => String(part).replaceAll('\\', '/'))),
      resolve: (...parts) => posix.resolve(...parts.map((part) => String(part).replaceAll('\\', '/'))),
      isAbsolute: (value) => posix.isAbsolute(String(value).replaceAll('\\', '/')),
      dirname: (value) => posix.dirname(String(value).replaceAll('\\', '/')),
      basename: (value) => posix.basename(String(value).replaceAll('\\', '/')),
      comparisonKey: (value) => normalized(value),
      isSameOrInside(root, target) {
        const relation = posix.relative(normalized(root), normalized(target))
        return relation === '' || (relation !== '..' && !relation.startsWith('../') && !posix.isAbsolute(relation))
      }
    },
    fs,
    link: {
      samePath: (left, right) => normalized(left).toLowerCase() === normalized(right).toLowerCase(),
      isLinked: (linkPath, expected) => links.get(normalized(linkPath)) === normalized(expected),
      linkDirectory(linkPath, target) {
        links.set(normalized(linkPath), normalized(target))
        fs.mkdirp(linkPath)
      },
      linkFile(linkPath, target) {
        links.set(normalized(linkPath), normalized(target))
        fs.writeText(linkPath, fs.readText(target) || '')
      },
      unlink(linkPath) {
        links.delete(normalized(linkPath))
        fs.remove(linkPath)
      }
    },
    git: {
      configGet: () => null,
      output: () => ''
    },
    persist: {
      readJson(file, fallback) {
        const text = fs.readText(file)
        return text == null ? clone(fallback) : JSON.parse(text)
      },
      writeJson(file, value) {
        fs.writeText(file, `${JSON.stringify(value, null, 2)}\n`)
      },
      readList(file) {
        return (fs.readText(file) || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      },
      readState(file) {
        const text = fs.readText(file)
        return text == null ? { version: 1, items: [], lastIngest: null } : JSON.parse(text)
      },
      writeState(file, state) {
        fs.writeText(file, `${JSON.stringify(state, null, 2)}\n`)
      }
    },
    clock: {
      nowIso: () => FIXED_NOW,
      nowMs: () => Date.parse(FIXED_NOW)
    },
    ids: {
      next: (scope) => `${scope}-${++id}`
    },
    hash: {
      sha256: (value) => createHash('sha256').update(value).digest('hex')
    }
  }
  return { context, fs, links }
}

function sessionSeed() {
  return [
    {
      id: 'waiting-1',
      kind: 'chat',
      status: 'waiting',
      target: { kind: 'hub', id: 'hub' },
      intent: 'waiting',
      startedAt: FIXED_NOW,
      canResume: true
    },
    {
      id: 'running-1',
      kind: 'attach',
      status: 'running',
      target: { kind: 'worktree', id: worktreeTargetId('/game-tree') },
      startedAt: FIXED_NOW,
      canResume: false
    }
  ]
}

function createMemoryLegacyAttachPort(fs, options = {}) {
  const calls = { inspect: 0, apply: 0 }
  const inspections = []
  const appliedPlans = []
  const port = {
    calls,
    inspections,
    appliedPlans,
    inspect(worktree) {
      calls.inspect += 1
      const resolvedPath = normalized(worktree)
      const custom = options.inspect?.(resolvedPath)
      const inspection = custom || {
        worktree: {
          targetId: worktreeTargetId(resolvedPath),
          resolvedPath,
          recognition: {
            exists: fs.exists(resolvedPath),
            isDirectory: fs.isDirectory(resolvedPath),
            sameAsHub: resolvedPath === '/hub',
            excluded: false,
            partialCheckout: false,
            explicitlyAllowed: false,
            ephemeral: false,
            requiredMarkers: [
              { name: 'AGENTS.md', present: fs.exists(`${resolvedPath}/AGENTS.md`) },
              { name: 'baloot_client', present: fs.exists(`${resolvedPath}/baloot_client`) }
            ]
          },
          blocked: false,
          claimed: false
        },
        gitWorktree: resolvedPath === '/game-tree',
        artifacts: [],
        trackedAssistantPaths: [],
        presentAssistantPaths: []
      }
      inspections.push(clone(inspection))
      return inspection
    },
    apply(plan) {
      calls.apply += 1
      appliedPlans.push(clone(plan))
      return options.apply?.(plan) || {
        changed: plan.claim === 'create',
        effects: plan.artifacts.map((artifact) => ({
          id: artifact.id,
          status: artifact.action === 'keep' ? 'unchanged' : 'applied'
        })),
        visibility: { trackedChanged: plan.visibility.trackedPaths.length, removed: plan.visibility.removePaths.length },
        gitConfigured: plan.configureGit,
        claim: plan.claim === 'create' ? 'created' : 'alreadyClaimed'
      }
    }
  }
  return port
}

function createMemoryLegacyDetachPort(fs, options = {}) {
  const calls = { inspect: 0, apply: 0 }
  const inspections = []
  const appliedPlans = []
  const port = {
    calls,
    inspections,
    appliedPlans,
    inspect(worktree) {
      calls.inspect += 1
      const resolvedPath = normalized(worktree)
      const custom = options.inspect?.(resolvedPath)
      const inspection = custom || recognizedLegacyInspection(resolvedPath, {
        worktree: { claimed: true }
      })
      inspections.push(clone(inspection))
      return inspection
    },
    apply(plan) {
      calls.apply += 1
      appliedPlans.push(clone(plan))
      return options.apply?.(plan) || {
        changed: true,
        effects: plan.artifacts.map((artifact) => ({
          id: artifact.id,
          status: artifact.action === 'unlink' ? 'unlinked' : 'missing'
        })),
        restoredTracked: plan.restorePaths.length,
        claim: 'removed'
      }
    }
  }
  return port
}

function createFixture(options = {}) {
  const { context, fs, links } = createContext()
  const sessions = createMemorySessions({ seed: options.sessions || sessionSeed(), now: () => FIXED_NOW })
  const ledger = createMemoryRequestLedger()
  const legacyAttach = createMemoryLegacyAttachPort(fs, options.legacyAttach)
  const legacyDetach = createMemoryLegacyDetachPort(fs, options.legacyDetach)
  const p2 = createMemoryP2Ports(context, options.p2)
  if (options.currentP2) installCurrentMemoryState(context, p2, options.claimedWorktree)
  const p3 = options.p3 ? createMemoryP3Ports(p2, options.p3) : undefined
  const transactions = createMemoryApplicationTransactions()
  const app = createHubApplication({
    ...createLocalApplicationPorts(context),
    legacyAttach,
    legacyDetach,
    sessions,
    ledger,
    p2,
    p3: p3?.ports,
    transactions,
    trace: options.trace
  })
  return { app, context, fs, ledger, legacyAttach, legacyDetach, links, p2, p3, sessions, transactions }
}

function createMemoryInvocationTrace(overrides = {}) {
  const events = []
  return {
    events,
    hashRequestId: overrides.hashRequestId || ((requestId) => `memory:${requestId}`),
    append: overrides.append || ((event) => events.push(clone(event)))
  }
}

function createObservedFixture(options = {}) {
  const { context, fs, links } = createContext()
  const sessions = createMemorySessions({ seed: options.sessions || sessionSeed(), now: () => FIXED_NOW })
  const ledger = createMemoryRequestLedger()
  const legacyAttach = createMemoryLegacyAttachPort(fs, options.legacyAttach)
  const legacyDetach = createMemoryLegacyDetachPort(fs, options.legacyDetach)
  const ports = createLocalApplicationPorts(context)
  const p2 = createMemoryP2Ports(context, options.p2)
  if (options.currentP2) installCurrentMemoryState(context, p2, options.claimedWorktree)
  const p3 = options.p3 ? createMemoryP3Ports(p2, options.p3) : undefined
  const transactions = createMemoryApplicationTransactions()
  const calls = { artifactApply: 0, stateWrite: 0, historyAppend: 0 }
  const queries = { ...ports.queries }
  const useCases = {
    ...ports.useCases,
    state: {
      ...ports.useCases.state,
      writeState(state) {
        calls.stateWrite += 1
        return ports.useCases.state.writeState(state)
      },
      appendHistory(write) {
        calls.historyAppend += 1
        return ports.useCases.state.appendHistory(write)
      }
    },
    artifacts: {
      ...ports.useCases.artifacts,
      apply(effects) {
        calls.artifactApply += 1
        return ports.useCases.artifacts.apply(effects)
      }
    }
  }
  options.configure?.({ calls, context, fs, ledger, legacyAttach, legacyDetach, p2, p3, queries, sessions, transactions, useCases })
  const app = createHubApplication({
    ...ports,
    queries,
    useCases,
    legacyAttach,
    legacyDetach,
    sessions,
    ledger,
    p2,
    p3: p3?.ports,
    transactions
  })
  return {
    app, calls, context, fs, ledger, legacyAttach, legacyDetach, links,
    p2, p3, queries, sessions, transactions, useCases
  }
}

function hostEffectSnapshot(fixture) {
  return {
    legacyApply: fixture.legacyAttach.calls.apply,
    legacyDetachApply: fixture.legacyDetach.calls.apply,
    artifactApply: fixture.calls.artifactApply,
    stateWrite: fixture.calls.stateWrite,
    historyAppend: fixture.calls.historyAppend,
    sessionStart: fixture.sessions.calls.start,
    sessionResume: fixture.sessions.calls.resume,
    sessionReap: fixture.sessions.calls.reap,
    sessionComplete: fixture.sessions.calls.completeAttach,
    p3StateWrite: fixture.p3?.calls.stateWrite || 0,
    p3Prepare: fixture.p3?.calls.prepare || 0,
    p3PrepareLegacyMigration: fixture.p3?.calls.prepareLegacyMigration || 0,
    p3PrepareLegacyRollback: fixture.p3?.calls.prepareLegacyRollback || 0,
    p3Publish: fixture.p3?.calls.publish || 0,
    p3RecordWrite: fixture.p3?.calls.recordWrite || 0,
    p3MigrationWrite: fixture.p3?.calls.migrationWrite || 0
  }
}

function expectedHostEffects(overrides) {
  return {
    legacyApply: 0,
    legacyDetachApply: 0,
    artifactApply: 0,
    stateWrite: 0,
    historyAppend: 0,
    sessionStart: 0,
    sessionResume: 0,
    sessionReap: 0,
    sessionComplete: 0,
    p3StateWrite: 0,
    p3Prepare: 0,
    p3PrepareLegacyMigration: 0,
    p3PrepareLegacyRollback: 0,
    p3Publish: 0,
    p3RecordWrite: 0,
    p3MigrationWrite: 0,
    ...overrides
  }
}

function resetObservedEffects(fixture) {
  fixture.ledger.entries.splice(0)
  fixture.ledger.events.splice(0)
  for (const key of Object.keys(fixture.ledger.calls)) fixture.ledger.calls[key] = 0
  for (const key of Object.keys(fixture.calls)) fixture.calls[key] = 0
  if (fixture.p3) {
    for (const key of Object.keys(fixture.p3.calls)) fixture.p3.calls[key] = 0
  }
}

function withoutReplayMarker(result) {
  return { ...clone(result), meta: { ...result.meta, replayed: false } }
}

function recognizedLegacyInspection(resolvedPath, overrides = {}) {
  const { worktree = {}, ...inspection } = overrides
  return {
    worktree: {
      targetId: worktreeTargetId(resolvedPath),
      resolvedPath,
      recognition: {
        exists: true,
        isDirectory: true,
        sameAsHub: false,
        excluded: false,
        partialCheckout: false,
        explicitlyAllowed: false,
        ephemeral: false,
        requiredMarkers: [
          { name: 'AGENTS.md', present: true },
          { name: 'baloot_client', present: true }
        ]
      },
      blocked: false,
      claimed: false,
      ...worktree
    },
    gitWorktree: true,
    artifacts: [],
    trackedAssistantPaths: [],
    presentAssistantPaths: [],
    ...inspection
  }
}

function command(kind, requestId, input = {}, meta = {}) {
  return {
    kind,
    meta: {
      contractVersion: CONTRACT_VERSION,
      requestId,
      hostId: 'memory-host',
      transport: 'memory',
      ...meta
    },
    ...input
  }
}

function assertSuccess(result, kind) {
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.contractVersion, CONTRACT_VERSION)
  assert.equal(result.commandKind, kind)
  assert.equal(result.meta.handler, 'application.commandBus')
  return result.data
}

function assertFailure(result, code, retryable = false) {
  assert.equal(result.ok, false, JSON.stringify(result))
  assert.equal(result.error.code, code)
  assert.equal(result.error.retryable, retryable)
  assert.equal(result.meta.handler, 'application.commandBus')
}

test('contracts publish one stable version, complete command corpora, audit types, and errors', () => {
  assert.equal(CONTRACT_VERSION, 1)
  assert.equal(UNKNOWN_COMMAND_KIND, 'unknown')
  assert.deepEqual(QUERY_COMMAND_KINDS, [
    'status',
    'listSkills',
    'listWorktrees',
    'readSkill',
    'listHistory',
    'listSessions',
    'getSession',
    'inspectSchema',
    'listSnapshots',
    'getSnapshot',
    'getPin',
    'planSync'
  ])
  assert.deepEqual(WRITE_COMMAND_KINDS, [
    'registerWorktree',
    'repairLegacy',
    'applyLegacyAttach',
    'applyLegacyDetach',
    'ingest',
    'decide',
    'attach',
    'detach',
    'edit',
    'chat',
    'analyze',
    'resumeSession',
    'cancelSession',
    'reapSessions',
    'createSnapshot',
    'setPin',
    'migrateState',
    'claimWorktree',
    'sync',
    'migrateLegacy',
    'rollbackLegacyMigration'
  ])
  assert.equal(new Set([...QUERY_COMMAND_KINDS, ...WRITE_COMMAND_KINDS]).size, 33)
  assert.deepEqual(HUB_ERROR_CODES, [
    'UNSUPPORTED_CONTRACT_VERSION',
    'INVALID_COMMAND_META',
    'INVALID_ARGUMENT',
    'REQUEST_ID_REQUIRED',
    'REQUEST_ID_CONFLICT',
    'REQUEST_IN_PROGRESS',
    'NOT_FOUND',
    'WORKTREE_NOT_RECOGNIZED',
    'WORKTREE_BLOCKED',
    'WORKTREE_ALREADY_CLAIMED',
    'FIRST_ATTACH_SESSION_REQUIRED',
    'DETACH_SESSION_REQUIRED',
    'INVALID_INBOX_TRANSITION',
    'INVALID_PIN',
    'CONFLICT_DIRTY',
    'CONFLICT_EXTERNAL_LINK',
    'CONFLICT_CONTENT',
    'STATE_VERSION_UNSUPPORTED',
    'STATE_CORRUPT',
    'MIGRATION_REQUIRED',
    'MIGRATION_PLAN_STALE',
    'LOCK_BUSY',
    'LOCK_NOT_OWNED',
    'SNAPSHOT_NOT_FOUND',
    'SNAPSHOT_INVALID',
    'RUNNER_UNAVAILABLE',
    'PORT_FAILURE',
    'UNSUPPORTED_COMMAND',
    'INTERNAL_ERROR',
    'WORKTREE_NOT_CLAIMED',
    'MATERIALIZE_PLAN_STALE',
    'MATERIALIZATION_MARKER_INVALID',
    'RUNTIME_ASSET_NOT_FOUND',
    'RUNTIME_ASSET_INVALID',
    'LEGACY_MIGRATION_REQUIRED',
    'LEGACY_PLAN_STALE',
    'LEGACY_MIGRATION_NOT_FOUND',
    'LEGACY_ROLLBACK_CONFLICT',
    'CONFLICT_PATH',
    'UNSUPPORTED_LAYOUT'
  ])
  assert.deepEqual(AUDIT_EVENT_TYPES, [
    'command.started',
    'command.succeeded',
    'command.failed',
    'worktree.claim-evaluated',
    'worktree.attach-requested',
    'inbox.ingested',
    'inbox.transitioned',
    'session.requested',
    'session.reaped',
    'state.changed',
    'worktree.claimed',
    'worktree.materialized',
    'worktree.legacy-migrated',
    'worktree.legacy-rolled-back'
  ])
})

test('pure policies accept and reject recognition, claims, first attach, inbox transitions, pins, and conflicts', async (t) => {
  const markerInput = {
    exists: true,
    isDirectory: true,
    sameAsHub: false,
    excluded: false,
    partialCheckout: false,
    explicitlyAllowed: false,
    ephemeral: false,
    requiredMarkers: [{ name: 'AGENTS.md', present: true }]
  }
  const recognized = recognizeWorktree(markerInput)
  assert.deepEqual(recognized, { recognized: true, via: 'markers', ephemeral: false })
  assert.deepEqual(recognizeWorktree({ ...markerInput, explicitlyAllowed: true, requiredMarkers: [] }), {
    recognized: true,
    via: 'explicit',
    ephemeral: false
  })
  assert.deepEqual(recognizeWorktree({ ...markerInput, requiredMarkers: [] }), {
    recognized: false,
    reason: 'not-explicitly-allowed',
    missingMarkers: []
  })
  assert.deepEqual(recognizeWorktree({ ...markerInput, exists: false }), {
    recognized: false,
    reason: 'missing',
    missingMarkers: []
  })
  assert.deepEqual(recognizeWorktree({ ...markerInput, sameAsHub: true }), {
    recognized: false,
    reason: 'hub-root',
    missingMarkers: []
  })
  assert.deepEqual(recognizeWorktree({
    ...markerInput,
    requiredMarkers: [{ name: 'AGENTS.md', present: true }, { name: 'baloot_client', present: false }]
  }), {
    recognized: false,
    reason: 'required-marker-missing',
    missingMarkers: ['baloot_client']
  })

  const noConflict = classifyConflict({ targetExists: false, expectedKind: 'directory' })
  const dirtyConflict = classifyConflict({
    targetExists: true,
    expectedKind: 'directory',
    actualKind: 'directory',
    dirty: true
  })
  assert.deepEqual(noConflict, { kind: 'none', blocking: false, mayWrite: true, recommendedAction: 'create' })
  assert.deepEqual(classifyConflict({
    targetExists: true,
    expectedKind: 'file',
    actualKind: 'file',
    contentMatches: true
  }), { kind: 'identical-content', blocking: false, mayWrite: true, recommendedAction: 'replace-identical' })
  assert.equal(classifyConflict({ targetExists: true, expectedKind: 'directory', protected: true }).kind, 'protected-target')
  assert.equal(classifyConflict({
    targetExists: true,
    expectedKind: 'directory',
    actualKind: 'link',
    pointsElsewhere: true
  }).kind, 'external-link')
  assert.equal(dirtyConflict.kind, 'dirty')
  assert.equal(classifyConflict({
    targetExists: true,
    expectedKind: 'file',
    actualKind: 'file',
    contentMatches: false
  }).kind, 'content-mismatch')

  const eligible = evaluateClaim({ recognition: recognized, blocked: false, claimed: false, conflict: noConflict })
  assert.deepEqual(eligible, { decision: 'eligible' })
  assert.deepEqual(evaluateClaim({ recognition: recognized, blocked: false, claimed: true }), { decision: 'already-claimed' })
  assert.deepEqual(evaluateClaim({ recognition: recognized, blocked: false, claimed: false, conflict: dirtyConflict }), {
    decision: 'requires-resolution',
    conflict: 'dirty'
  })
  assert.deepEqual(evaluateClaim({ recognition: recognized, blocked: true, claimed: false }), {
    decision: 'rejected',
    reason: 'blocked'
  })
  const unrecognized = recognizeWorktree({ ...markerInput, exists: false })
  assert.deepEqual(evaluateClaim({ recognition: unrecognized, blocked: false, claimed: false }), {
    decision: 'rejected',
    reason: 'unrecognized'
  })
  assert.deepEqual(decideFirstAttach(eligible), { decision: 'session-required', allowSilentWrite: false })
  assert.deepEqual(decideFirstAttach({ decision: 'requires-resolution', conflict: 'dirty' }), {
    decision: 'session-required',
    conflict: 'dirty',
    allowSilentWrite: false
  })
  assert.deepEqual(decideFirstAttach({ decision: 'already-claimed' }), {
    decision: 'not-required',
    reason: 'already-claimed',
    allowSilentWrite: false
  })
  assert.deepEqual(decideFirstAttach({ decision: 'rejected', reason: 'blocked' }), {
    decision: 'rejected',
    reason: 'blocked',
    allowSilentWrite: false
  })

  assert.deepEqual(transitionInbox('queued', 'propose'), {
    accepted: true,
    current: 'queued',
    next: 'proposed',
    idempotent: false,
    mergeTarget: undefined
  })
  assert.equal(transitionInbox('proposed', 'adopt').accepted, true)
  assert.deepEqual(transitionInbox('queued', 'merge'), {
    accepted: false,
    current: 'queued',
    action: 'merge',
    reason: 'merge-target-required'
  })
  assert.deepEqual(transitionInbox('queued', 'merge', { mergeTarget: ' skills/ozdqp-development ' }), {
    accepted: true,
    current: 'queued',
    next: 'merged-into-3skill',
    idempotent: false,
    mergeTarget: 'skills/ozdqp-development'
  })
  assert.equal(transitionInbox('queued', 'reject').accepted, true)
  assert.deepEqual(transitionInbox('rejected', 'reject'), {
    accepted: true,
    current: 'rejected',
    next: 'rejected',
    idempotent: true,
    mergeTarget: undefined
  })
  assert.deepEqual(transitionInbox('rejected', 'adopt'), {
    accepted: false,
    current: 'rejected',
    action: 'adopt',
    reason: 'terminal-state'
  })

  assert.equal(PIN_SCHEMA_VERSION, 1)
  assert.deepEqual(validatePin({
    schemaVersion: 1,
    worktreeId: ' tree-1 ',
    librarySnapshot: ' library-sha ',
    skills: [{ name: ' ozdqp-development ', snapshot: ' skill-sha ' }]
  }), {
    valid: true,
    pin: {
      schemaVersion: 1,
      worktreeId: 'tree-1',
      librarySnapshot: 'library-sha',
      skills: [{ name: 'ozdqp-development', snapshot: 'skill-sha' }]
    }
  })
  const invalidPin = validatePin({
    schemaVersion: 2,
    worktreeId: ' ',
    librarySnapshot: ' ',
    runtimeRevision: '\u0001',
    skills: [
      { name: 'Unity-Skills' },
      { name: 'unity-skills' },
      { name: 'bad/name', snapshot: '\u0001' }
    ]
  })
  assert.equal(invalidPin.valid, false)
  assert.deepEqual(new Set(invalidPin.errors.map((error) => error.code)), new Set([
    'unsupported-schema-version',
    'worktree-id-required',
    'library-snapshot-required',
    'runtime-revision-forbidden',
    'forbidden-skill',
    'duplicate-skill',
    'invalid-skill-name',
    'invalid-snapshot'
  ]))
  assert.deepEqual(validatePin({
    schemaVersion: 1,
    worktreeId: 'tree',
    librarySnapshot: 'sha',
    skills: []
  }), { valid: false, errors: [{ code: 'skills-required', field: 'skills' }] })
})

test('legacy attach planner is pure, fail-closed, and emits only approved host effects', () => {
  const markerFacts = {
    exists: true,
    isDirectory: true,
    sameAsHub: false,
    excluded: false,
    partialCheckout: false,
    explicitlyAllowed: false,
    ephemeral: false,
    requiredMarkers: [{ name: 'AGENTS.md', present: true }]
  }
  const baseArtifact = {
    id: 'agentsOverride',
    kind: 'agentsOverride',
    label: 'AGENTS.override.md',
    targetRelativePath: 'AGENTS.override.md',
    hubRelativePath: 'AGENTS.override.md',
    expectedKind: 'file',
    libraryExists: true,
    observed: {
      exists: true,
      actualKind: 'file',
      linkedToExpected: false,
      pointsElsewhere: false,
      contentMatches: false,
      observedDigest: 'worktree-digest',
      libraryDigest: 'library-digest'
    }
  }
  const inspection = {
    worktree: {
      targetId: worktreeTargetId('/game-tree'),
      resolvedPath: '/game-tree',
      recognition: markerFacts,
      blocked: false,
      claimed: false
    },
    gitWorktree: true,
    artifacts: [baseArtifact],
    trackedAssistantPaths: ['.claude/settings.json', '.agents/skills/unity-skills/SKILL.md'],
    presentAssistantPaths: ['.codex/agents', '.agents/skills/custom-skill']
  }

  assert.deepEqual(planLegacyAttach({ inspection, mode: 'firstAttach' }), {
    decision: 'session-required',
    worktree: '/game-tree'
  })
  const defaultConflict = planLegacyAttach({ inspection, mode: 'firstAttach', attachSessionAuthorized: true })
  assert.equal(defaultConflict.decision, 'rejected')
  assert.equal(defaultConflict.reason, 'conflict')
  assert.equal(defaultConflict.conflict, 'content-mismatch')

  const promoted = planLegacyAttach({
    inspection,
    mode: 'firstAttach',
    attachSessionAuthorized: true,
    sourcePolicy: 'promoteFromWorktree',
    configureGit: true
  })
  assert.equal(promoted.decision, 'apply')
  assert.equal(promoted.plan.artifacts[0].action, 'promoteToLibraryThenLink')
  assert.deepEqual(promoted.plan.visibility, {
    mode: 'disable',
    trackedPaths: ['.claude/settings.json'],
    removePaths: ['.codex/agents']
  })
  assert.equal(promoted.plan.claim, 'create')
  assert.equal(promoted.plan.configureGit, true)

  const external = clone(inspection)
  external.artifacts[0].observed.actualKind = 'link'
  external.artifacts[0].observed.pointsElsewhere = true
  const rejectedExternal = planLegacyAttach({
    inspection: external,
    mode: 'firstAttach',
    attachSessionAuthorized: true,
    sourcePolicy: 'preferLibrary'
  })
  assert.equal(rejectedExternal.decision, 'rejected')
  assert.equal(rejectedExternal.conflict, 'external-link')

  const repairUnclaimed = planLegacyAttach({ inspection, mode: 'repair' })
  assert.deepEqual(repairUnclaimed, { decision: 'noop', reason: 'not-attached', worktree: '/game-tree' })

  const nonGitRepair = clone(inspection)
  nonGitRepair.gitWorktree = false
  assert.deepEqual(planLegacyAttach({ inspection: nonGitRepair, mode: 'repair' }), {
    decision: 'rejected', reason: 'unrecognized', worktree: '/game-tree'
  })
  const emptyRulesRepair = clone(inspection)
  emptyRulesRepair.worktree.recognition.requiredMarkers = []
  assert.deepEqual(planLegacyAttach({ inspection: emptyRulesRepair, mode: 'repair' }), {
    decision: 'rejected', reason: 'unrecognized', worktree: '/game-tree'
  })
  const hubRepair = clone(inspection)
  hubRepair.worktree.recognition.sameAsHub = true
  assert.deepEqual(planLegacyAttach({ inspection: hubRepair, mode: 'repair' }), {
    decision: 'rejected', reason: 'unrecognized', worktree: '/game-tree'
  })
})

test('all query commands execute through the shared Application against pure memory ports', async () => {
  const { app, ledger, sessions } = createFixture({
    currentP2: true,
    claimedWorktree: '/p3-tree',
    p3: { phase: 'fresh' }
  })
  const corpus = [
    ['status', {}],
    ['listSkills', {}],
    ['listWorktrees', {}],
    ['readSkill', { path: 'skills/ozdqp-development' }],
    ['listHistory', { limit: 10, cursor: 'memory-cursor' }],
    ['listSessions', { statuses: ['waiting'] }],
    ['getSession', { sessionId: 'waiting-1' }],
    ['inspectSchema', {}],
    ['listSnapshots', {}],
    ['getSnapshot', { snapshotId: DEFAULT_MEMORY_SNAPSHOT.snapshotId }],
    ['getPin', { worktree: '/game-tree' }],
    ['planSync', { worktree: '/p3-tree' }]
  ]
  assert.deepEqual(corpus.map(([kind]) => kind), QUERY_COMMAND_KINDS)
  for (const [index, [kind, input]] of corpus.entries()) {
    const result = await app.execute(command(kind, `query-${index}`, input))
    assertSuccess(result, kind)
    assert.deepEqual(result.events, [])
    assert.equal(result.meta.replayed, false)
  }

  assert.equal((await app.execute(command('status', 'query-status'))).data.sessions.length, 1)
  assert.equal((await app.execute(command('listSkills', 'query-skills'))).data.resident.length, 3)
  assert.equal((await app.execute(command('listWorktrees', 'query-worktrees'))).data.worktrees.length, 0)
  assert.match((await app.execute(command('readSkill', 'query-read', { path: 'skills/ozdqp-development' }))).data.content, /ozdqp-development/)
  assert.equal((await app.execute(command('listHistory', 'query-history', { limit: 10 }))).data.records[0].id, 'history-1')
  assert.deepEqual((await app.execute(command('listSessions', 'query-sessions', { statuses: ['waiting'] }))).data.sessions.map((item) => item.id), ['waiting-1'])
  assert.equal((await app.execute(command('getSession', 'query-session', { sessionId: 'waiting-1' }))).data.session.id, 'waiting-1')
  assert.equal((await app.execute(command('inspectSchema', 'query-schema'))).data.status, 'current')
  assert.equal((await app.execute(command('listSnapshots', 'query-snapshots'))).data.snapshots.length, 2)
  assert.equal((await app.execute(command('getSnapshot', 'query-snapshot', {
    snapshotId: DEFAULT_MEMORY_SNAPSHOT.snapshotId
  }))).data.snapshot.snapshotId, DEFAULT_MEMORY_SNAPSHOT.snapshotId)
  assert.equal((await app.execute(command('getPin', 'query-pin', { worktree: '/game-tree' }))).data.pin, null)
  assert.equal((await app.execute(command('planSync', 'query-plan-sync', {
    worktree: '/p3-tree'
  }))).data.status, 'planned')
  assert.equal(ledger.entries.length, 0)
  assert.equal(ledger.events.length, 0)
  assert.ok(sessions.calls.list > 0)

  assertFailure(await app.execute(command('readSkill', 'query-escape', { path: '../escape' })), 'INVALID_ARGUMENT')
  assertFailure(await app.execute(command('getSession', 'query-missing', { sessionId: 'missing' })), 'NOT_FOUND')
})

test('Application projects flat host query facts without adapter-owned grouping, counts, or worktree policy', async () => {
  const fixture = createObservedFixture({
    configure({ queries }) {
      queries.readStatusFacts = () => ({
        hubRoot: '/raw-hub',
        gameRepo: '/raw-game',
        lastIngest: null,
        items: [
          { id: 'queued-raw', name: 'queued', unit: 'queued', status: 'queued' },
          { id: 'proposed-raw', name: 'proposed', unit: 'proposed', status: 'proposed' }
        ]
      })
      queries.listSkillFacts = () => [
        { source: 'inbox', name: 'candidate', path: 'skills/inbox/candidate', hasSkillMd: true, attached: false, ordinal: 3 },
        { source: 'resident', name: 'dev', path: 'skills/dev', hasSkillMd: true, attached: true, ordinal: 0 },
        { source: 'adopted', name: 'team', path: 'skills/adopted/team', hasSkillMd: true, attached: true, ordinal: 2 },
        { source: 'resident', name: 'git', path: 'skills/git', hasSkillMd: true, attached: false, ordinal: 1 }
      ]
      const tree = {
        identity: 'tree:raw',
        ordinal: 0,
        name: 'raw-tree',
        path: '/raw-tree',
        branch: 'main',
        head: 'abc',
        changedAtMs: 10,
        exists: true,
        sameAsHub: false,
        attached: false,
        doNotAuto: false,
        officialPresent: false,
        overrideLinked: false,
        locked: false,
        prunable: false
      }
      queries.readWorktreeFacts = () => ({
        scanRoots: ['/scan'],
        rules: { exclude: [], require: ['AGENTS.md'], paths: [] },
        observations: [{
          cloneIdentity: 'clone:raw',
          cloneRoot: '/raw-tree',
          seed: {
            ...tree,
            recognition: {
              name: 'raw-tree',
              exists: true,
              isDirectory: true,
              sameAsHub: false,
              explicitlyAllowed: false,
              requiredMarkers: [{ name: 'AGENTS.md', present: true }]
            }
          },
          listed: []
        }]
      })
    }
  })

  const status = assertSuccess(await fixture.app.execute(command('status', 'raw-query-status')), 'status')
  assert.deepEqual(status.resident.map((skill) => skill.name), ['dev', 'git'])
  assert.deepEqual(status.adopted.map((skill) => skill.name), ['team'])
  assert.deepEqual(status.inbox.map((skill) => skill.name), ['candidate'])
  assert.deepEqual(status.counts, { resident: 2, adopted: 1, queued: 1, proposed: 1 })
  const worktrees = assertSuccess(
    await fixture.app.execute(command('listWorktrees', 'raw-query-worktrees')),
    'listWorktrees'
  )
  assert.deepEqual(worktrees.worktrees.map((tree) => tree.path), ['/raw-tree'])
})

test('every query command has a deterministic pure-memory refusal or port error', async () => {
  const corpus = [
    {
      kind: 'status',
      input: {},
      code: 'PORT_FAILURE',
      retryable: true,
      configure({ queries }) {
        queries.readStatusFacts = () => { throw new Error('status query unavailable') }
      }
    },
    {
      kind: 'listSkills',
      input: {},
      code: 'PORT_FAILURE',
      retryable: true,
      configure({ queries }) {
        queries.listSkillFacts = () => { throw new Error('skill query unavailable') }
      }
    },
    {
      kind: 'listWorktrees',
      input: {},
      code: 'PORT_FAILURE',
      retryable: true,
      configure({ queries }) {
        queries.readWorktreeFacts = () => { throw new Error('worktree query unavailable') }
      }
    },
    { kind: 'readSkill', input: { path: '../escape' }, code: 'INVALID_ARGUMENT' },
    {
      kind: 'listHistory',
      input: { limit: 10 },
      code: 'PORT_FAILURE',
      retryable: true,
      configure({ queries }) {
        queries.listHistory = () => { throw new Error('history query unavailable') }
      }
    },
    {
      kind: 'listSessions',
      input: {},
      code: 'PORT_FAILURE',
      retryable: true,
      configure({ sessions }) {
        sessions.list = () => {
          sessions.calls.list += 1
          throw new Error('session query unavailable')
        }
      }
    },
    { kind: 'getSession', input: { sessionId: 'missing' }, code: 'NOT_FOUND' },
    {
      kind: 'inspectSchema',
      input: {},
      code: 'PORT_FAILURE',
      retryable: true,
      configure({ p2 }) {
        p2.state.runtimeRevision = () => { throw new Error('runtime revision unavailable') }
      }
    },
    {
      kind: 'listSnapshots',
      input: {},
      code: 'PORT_FAILURE',
      retryable: true,
      configure({ p2 }) {
        p2.snapshots.list = () => { throw new Error('snapshot inventory unavailable') }
      }
    },
    {
      kind: 'getSnapshot',
      input: { snapshotId: `sha256:${'f'.repeat(64)}` },
      code: 'SNAPSHOT_NOT_FOUND'
    },
    {
      kind: 'getPin',
      input: { worktree: '/game-tree' },
      code: 'MIGRATION_REQUIRED'
    },
    {
      kind: 'planSync',
      input: { worktree: '/game-tree' },
      code: 'WORKTREE_NOT_CLAIMED',
      fixture: { currentP2: true, p3: { phase: 'fresh' } }
    }
  ]
  assert.deepEqual(corpus.map(({ kind }) => kind), QUERY_COMMAND_KINDS)

  for (const [index, row] of corpus.entries()) {
    const fixture = createObservedFixture({ ...row.fixture, configure: row.configure })
    const result = await fixture.app.execute(command(row.kind, `query-refusal-${index}`, row.input))
    assertFailure(result, row.code, row.retryable || false)
    assert.deepEqual(result.events, [])
    assert.deepEqual(hostEffectSnapshot(fixture), expectedHostEffects())
    assert.equal(fixture.ledger.entries.length, 0)
    assert.equal(fixture.ledger.events.length, 0)
  }
})

test('every write command executes once, replays once, and rejects a semantic requestId conflict without extra effects or audit', async () => {
  const oldRevision = '1111111111111111111111111111111111111111'
  const nextRevision = '2222222222222222222222222222222222222222'
  const otherRevision = '3333333333333333333333333333333333333333'
  const corpus = [
    {
      kind: 'repairLegacy',
      input: { worktree: '/game-tree' },
      conflict: { worktree: '/other-tree' },
      effects: expectedHostEffects({ legacyApply: 1 }),
      fixture: {
        legacyAttach: {
          inspect: (resolvedPath) => recognizedLegacyInspection(resolvedPath, { worktree: { claimed: true } })
        }
      }
    },
    {
      kind: 'applyLegacyAttach',
      input: { worktree: '/game-tree', sessionId: 'legacy-ready', sourcePolicy: 'preferLibrary' },
      conflict: { worktree: '/game-tree', sessionId: 'legacy-ready', sourcePolicy: 'requireMatch' },
      effects: expectedHostEffects({ legacyApply: 1 }),
      fixture: {
        sessions: [
          ...sessionSeed(),
          {
            id: 'legacy-ready',
            kind: 'attach',
            status: 'waiting',
            target: { kind: 'worktree', id: worktreeTargetId('/game-tree') },
            startedAt: FIXED_NOW,
            exitCode: 0,
            canResume: true
          }
        ]
      }
    },
    {
      kind: 'applyLegacyDetach',
      input: { worktree: '/game-tree', sessionId: 'running-detach' },
      conflict: { worktree: '/other-tree', sessionId: 'running-detach' },
      effects: expectedHostEffects({ legacyDetachApply: 1 }),
      fixture: {
        sessions: [
          ...sessionSeed(),
          {
            id: 'running-detach',
            kind: 'detach',
            status: 'running',
            target: { kind: 'worktree', id: worktreeTargetId('/game-tree') },
            startedAt: FIXED_NOW,
            canResume: false
          }
        ]
      }
    },
    {
      kind: 'ingest',
      input: { gameRepo: '/game-repo', payload: `${oldRevision} ${nextRevision} refs/remotes/origin/main`, dispatch: false },
      conflict: { gameRepo: '/game-repo', payload: `${oldRevision} ${otherRevision} refs/remotes/origin/main`, dispatch: false },
      effects: expectedHostEffects({ artifactApply: 1, stateWrite: 1, historyAppend: 1 }),
      fixture: {
        configure({ useCases }) {
          useCases.git.revisionExists = () => true
          useCases.git.changedPaths = () => [{ status: 'M', path: '.agents/skills/gated-skill/SKILL.md' }]
          useCases.git.readTree = () => [{ path: 'SKILL.md', content: '# Gated skill\n' }]
        }
      }
    },
    {
      kind: 'decide',
      input: { id: 'reject-1', action: 'reject', note: 'memory decision' },
      conflict: { id: 'reject-1', action: 'reject', note: 'different decision' },
      effects: expectedHostEffects({ artifactApply: 1, stateWrite: 1, historyAppend: 1 })
    },
    {
      kind: 'attach',
      input: { worktree: '/game-tree', intent: 'attach from memory' },
      conflict: { worktree: '/game-tree', intent: 'different attach intent' },
      effects: expectedHostEffects({ sessionStart: 1 })
    },
    {
      kind: 'detach',
      input: { worktree: '/game-tree', intent: 'detach from memory' },
      conflict: { worktree: '/other-tree', intent: 'detach from memory' },
      effects: expectedHostEffects({ sessionStart: 1 })
    },
    {
      kind: 'edit',
      input: { path: 'skills/ozdqp-development', intent: 'edit from memory' },
      conflict: { path: 'skills/ozdqp-git-workflow', intent: 'edit from memory' },
      effects: expectedHostEffects({ sessionStart: 1 })
    },
    {
      kind: 'chat',
      input: { intent: 'chat from memory' },
      conflict: { intent: 'different chat intent' },
      effects: expectedHostEffects({ sessionStart: 1 })
    },
    {
      kind: 'analyze',
      input: { inboxId: 'queued-1', intent: 'analyze from memory' },
      conflict: { inboxId: 'reject-1', intent: 'analyze from memory' },
      effects: expectedHostEffects({ sessionStart: 1 })
    },
    {
      kind: 'resumeSession',
      input: { sessionId: 'waiting-1', message: 'continue from memory' },
      conflict: { sessionId: 'waiting-1', message: 'continue differently' },
      effects: expectedHostEffects({ sessionResume: 1 })
    },
    {
      kind: 'reapSessions',
      input: { sessionIds: ['running-1'] },
      conflict: { sessionIds: ['waiting-1'] },
      effects: expectedHostEffects({ sessionReap: 1 })
    },
    {
      kind: 'createSnapshot',
      input: {},
      conflictKind: 'migrateState',
      conflict: { mode: 'dryRun' },
      events: 2,
      effects: expectedHostEffects()
    },
    {
      kind: 'setPin',
      input: {
        worktree: '/game-tree',
        snapshotId: SECOND_MEMORY_SNAPSHOT.snapshotId
      },
      conflict: {
        worktree: '/game-tree',
        snapshotId: DEFAULT_MEMORY_SNAPSHOT.snapshotId
      },
      events: 2,
      effects: expectedHostEffects(),
      fixture: { currentP2: true, claimedWorktree: '/game-tree' }
    },
    {
      kind: 'migrateState',
      input: { mode: 'dryRun' },
      conflict: { mode: 'commit', planHash: DEFAULT_MEMORY_SNAPSHOT.snapshotId },
      effects: expectedHostEffects()
    },
    {
      kind: 'claimWorktree',
      input: {
        worktree: '/game-tree',
        snapshotId: DEFAULT_MEMORY_SNAPSHOT.snapshotId,
        selectedSkills: ['ozdqp-development'],
        sessionId: 'p3-attach-success'
      },
      conflict: {
        worktree: '/game-tree',
        snapshotId: DEFAULT_MEMORY_SNAPSHOT.snapshotId,
        selectedSkills: [],
        sessionId: 'p3-attach-success'
      },
      events: 2,
      effects: expectedHostEffects({ p3StateWrite: 1 }),
      fixture: {
        currentP2: true,
        p3: { phase: 'fresh' },
        sessions: [
          ...sessionSeed(),
          {
            id: 'p3-attach-success',
            kind: 'attach',
            status: 'waiting',
            target: { kind: 'worktree', id: worktreeTargetId('/game-tree') },
            startedAt: FIXED_NOW,
            endedAt: FIXED_NOW,
            exitCode: 0,
            canResume: true
          }
        ]
      }
    },
    {
      kind: 'sync',
      events: 2,
      effects: expectedHostEffects({
        p3StateWrite: 1,
        p3Prepare: 1,
        p3Publish: 1,
        p3RecordWrite: 1
      }),
      fixture: {
        currentP2: true,
        claimedWorktree: '/game-tree',
        p3: { phase: 'fresh' }
      },
      async prepare(fixture) {
        const planned = await fixture.app.execute(command('planSync', 'p3-sync-corpus-plan', {
          worktree: '/game-tree'
        }))
        const plan = assertSuccess(planned, 'planSync').plan
        return {
          input: { worktree: '/game-tree', planHash: plan.planHash },
          conflict: { worktree: '/game-tree', planHash: sha256Identifier('different-sync-plan') }
        }
      }
    },
    {
      kind: 'migrateLegacy',
      input: { worktree: '/game-tree', mode: 'dryRun' },
      conflict: { worktree: '/other-tree', mode: 'dryRun' },
      effects: expectedHostEffects(),
      fixture: {
        currentP2: true,
        claimedWorktree: '/game-tree',
        p3: { phase: 'legacy' }
      }
    },
    {
      kind: 'rollbackLegacyMigration',
      effects: expectedHostEffects(),
      fixture: {
        currentP2: true,
        claimedWorktree: '/game-tree',
        p3: { phase: 'legacy' }
      },
      async prepare(fixture) {
        const dryRun = await fixture.app.execute(command('migrateLegacy', 'p3-rollback-setup-plan', {
          worktree: '/game-tree',
          mode: 'dryRun'
        }))
        const plan = assertSuccess(dryRun, 'migrateLegacy').plan
        const committed = await fixture.app.execute(command('migrateLegacy', 'p3-rollback-setup-commit', {
          worktree: '/game-tree',
          mode: 'commit',
          planHash: plan.planHash
        }))
        const migration = assertSuccess(committed, 'migrateLegacy').migration
        resetObservedEffects(fixture)
        return {
          input: {
            worktree: '/game-tree',
            migrationId: migration.migrationId,
            mode: 'dryRun'
          },
          conflict: {
            worktree: '/game-tree',
            migrationId: sha256Identifier('different-legacy-migration'),
            mode: 'dryRun'
          }
        }
      }
    }
  ]
  assert.deepEqual(corpus.map(({ kind }) => kind), WRITE_COMMAND_KINDS)

  for (const [index, row] of corpus.entries()) {
    const fixture = createObservedFixture(row.fixture)
    const prepared = await row.prepare?.(fixture)
    const input = prepared?.input || row.input
    const semanticConflict = prepared?.conflict || row.conflict
    const requestId = `write-gate-${index}`
    const request = command(row.kind, requestId, input)
    const first = await fixture.app.execute(request)
    assertSuccess(first, row.kind)
    assert.equal(first.meta.replayed, false)
    const eventCount = row.events || 1
    assert.equal(first.events.length, eventCount)
    assert.equal(first.events.at(-1).type, 'command.succeeded')
    assert.equal(first.events.at(-1).requestId, requestId)
    assert.deepEqual(hostEffectSnapshot(fixture), row.effects)
    assert.equal(fixture.ledger.calls.begin, 1)
    assert.equal(fixture.ledger.calls.complete, 1)
    assert.equal(fixture.ledger.entries.length, 1)
    assert.equal(fixture.ledger.entries[0].status, 'completed')
    assert.equal(fixture.ledger.events.length, eventCount)

    const replay = await fixture.app.execute(clone(request))
    assertSuccess(replay, row.kind)
    assert.equal(replay.meta.replayed, true)
    assert.deepEqual(withoutReplayMarker(replay), withoutReplayMarker(first))
    assert.deepEqual(hostEffectSnapshot(fixture), row.effects)
    assert.equal(fixture.ledger.calls.begin, 1)
    assert.equal(fixture.ledger.calls.complete, 1)
    assert.equal(fixture.ledger.entries.length, 1)
    assert.equal(fixture.ledger.events.length, eventCount)

    const conflict = await fixture.app.execute(command(
      row.conflictKind || row.kind,
      requestId,
      semanticConflict
    ))
    assertFailure(conflict, 'REQUEST_ID_CONFLICT')
    assert.deepEqual(conflict.events, [])
    assert.deepEqual(hostEffectSnapshot(fixture), row.effects)
    assert.equal(fixture.ledger.calls.begin, 1)
    assert.equal(fixture.ledger.calls.complete, 1)
    assert.equal(fixture.ledger.entries.length, 1)
    assert.equal(fixture.ledger.events.length, eventCount)
  }
})

test('every write command caches one deterministic refusal without replaying host effects or audit', async () => {
  const ingestPayload = '1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 refs/remotes/origin/main'
  const runnerFailure = (method) => ({ sessions }) => {
    sessions[method] = () => {
      sessions.calls[method] += 1
      throw portFault('runner-unavailable')
    }
  }
  const missingLibraryArtifact = {
    id: 'agents-override',
    kind: 'agentsOverride',
    label: 'AGENTS.override.md',
    targetRelativePath: 'AGENTS.override.md',
    hubRelativePath: 'overlay/AGENTS.override.md',
    expectedKind: 'file',
    libraryExists: false,
    observed: {
      exists: false,
      linkedToExpected: false,
      pointsElsewhere: false,
      contentMatches: false
    }
  }
  const corpus = [
    {
      kind: 'repairLegacy',
      input: { worktree: '/game-tree' },
      code: 'NOT_FOUND',
      fixture: {
        legacyAttach: {
          inspect: (resolvedPath) => recognizedLegacyInspection(resolvedPath, {
            worktree: { claimed: true },
            artifacts: [missingLibraryArtifact]
          })
        }
      }
    },
    {
      kind: 'applyLegacyAttach',
      input: { worktree: '/game-tree', sourcePolicy: 'preferLibrary' },
      code: 'FIRST_ATTACH_SESSION_REQUIRED'
    },
    {
      kind: 'applyLegacyDetach',
      input: { worktree: '/game-tree' },
      code: 'DETACH_SESSION_REQUIRED'
    },
    {
      kind: 'ingest',
      input: { payload: ingestPayload, gameRepo: null, dispatch: false },
      code: 'INVALID_ARGUMENT'
    },
    { kind: 'decide', input: { id: 'missing-safe', action: 'reject' }, code: 'NOT_FOUND' },
    { kind: 'attach', input: { worktree: '/foreign-tree' }, code: 'WORKTREE_NOT_RECOGNIZED' },
    {
      kind: 'detach',
      input: { worktree: '/game-tree', intent: 'forced refusal' },
      code: 'RUNNER_UNAVAILABLE',
      retryable: true,
      fixture: { configure: runnerFailure('start') }
    },
    {
      kind: 'edit',
      input: { path: 'skills/ozdqp-development', intent: 'forced refusal' },
      code: 'RUNNER_UNAVAILABLE',
      retryable: true,
      fixture: { configure: runnerFailure('start') }
    },
    {
      kind: 'chat',
      input: { intent: 'forced refusal' },
      code: 'RUNNER_UNAVAILABLE',
      retryable: true,
      fixture: { configure: runnerFailure('start') }
    },
    { kind: 'analyze', input: { inboxId: 'missing-safe' }, code: 'NOT_FOUND' },
    { kind: 'resumeSession', input: { sessionId: 'missing-safe', message: 'continue' }, code: 'NOT_FOUND' },
    {
      kind: 'reapSessions',
      input: { sessionIds: ['running-1'] },
      code: 'RUNNER_UNAVAILABLE',
      retryable: true,
      fixture: { configure: runnerFailure('reap') }
    },
    {
      kind: 'createSnapshot',
      input: {},
      code: 'SNAPSHOT_INVALID',
      fixture: {
        configure({ p2 }) {
          p2.snapshots.observe = () => {
            throw new TrustedSnapshotInvalidError()
          }
        }
      }
    },
    {
      kind: 'setPin',
      input: { worktree: '/game-tree', snapshotId: DEFAULT_MEMORY_SNAPSHOT.snapshotId },
      code: 'MIGRATION_REQUIRED'
    },
    {
      kind: 'migrateState',
      input: { mode: 'dryRun' },
      code: 'SNAPSHOT_NOT_FOUND',
      fixture: { p2: { snapshots: [] } }
    },
    {
      kind: 'claimWorktree',
      input: {
        worktree: '/game-tree',
        snapshotId: DEFAULT_MEMORY_SNAPSHOT.snapshotId,
        selectedSkills: ['ozdqp-development'],
        sessionId: 'missing-attach-session'
      },
      code: 'FIRST_ATTACH_SESSION_REQUIRED',
      fixture: { currentP2: true, p3: { phase: 'fresh' } }
    },
    {
      kind: 'sync',
      input: { worktree: '/game-tree', planHash: sha256Identifier('stale-sync-plan') },
      code: 'MATERIALIZE_PLAN_STALE',
      fixture: {
        currentP2: true,
        claimedWorktree: '/game-tree',
        p3: { phase: 'fresh' }
      }
    },
    {
      kind: 'migrateLegacy',
      input: {
        worktree: '/game-tree',
        mode: 'commit',
        planHash: sha256Identifier('stale-legacy-plan')
      },
      code: 'LEGACY_PLAN_STALE',
      fixture: {
        currentP2: true,
        claimedWorktree: '/game-tree',
        p3: { phase: 'legacy' }
      }
    },
    {
      kind: 'rollbackLegacyMigration',
      input: {
        worktree: '/game-tree',
        migrationId: sha256Identifier('missing-legacy-migration'),
        mode: 'dryRun'
      },
      code: 'LEGACY_MIGRATION_NOT_FOUND',
      fixture: {
        currentP2: true,
        claimedWorktree: '/game-tree',
        p3: { phase: 'fresh' }
      }
    }
  ]
  assert.deepEqual(corpus.map(({ kind }) => kind), WRITE_COMMAND_KINDS)

  for (const [index, row] of corpus.entries()) {
    const fixture = createObservedFixture(row.fixture)
    const request = command(row.kind, `write-refusal-${index}`, row.input)
    const first = await fixture.app.execute(request)
    assertFailure(first, row.code, row.retryable || false)
    assert.equal(first.meta.replayed, false)
    assert.equal(first.events.length, 1)
    assert.equal(first.events[0].type, 'command.failed')
    assert.equal(first.events[0].details.errorCode, row.code)
    const effectsAfterFirst = hostEffectSnapshot(fixture)
    assert.equal(fixture.ledger.calls.begin, 1)
    assert.equal(fixture.ledger.calls.complete, 1)
    assert.equal(fixture.ledger.entries.length, 1)
    assert.equal(fixture.ledger.events.length, 1)

    const replay = await fixture.app.execute(clone(request))
    assertFailure(replay, row.code, row.retryable || false)
    assert.equal(replay.meta.replayed, true)
    assert.deepEqual(withoutReplayMarker(replay), withoutReplayMarker(first))
    assert.deepEqual(hostEffectSnapshot(fixture), effectsAfterFirst)
    assert.equal(fixture.ledger.calls.begin, 1)
    assert.equal(fixture.ledger.calls.complete, 1)
    assert.equal(fixture.ledger.entries.length, 1)
    assert.equal(fixture.ledger.events.length, 1)
  }
})

test('Application turns a decision into generic low-level facts/effects without passing the action to the adapter', async () => {
  const { context } = createContext()
  const ports = createLocalApplicationPorts(context)
  const sessions = createMemorySessions({ now: () => FIXED_NOW })
  const ledger = createMemoryRequestLedger()
  const inspected = []
  const applied = []
  const app = createHubApplication({
    ...ports,
    ...memoryApplicationInfrastructure(context),
    useCases: {
      ...ports.useCases,
      artifacts: {
        inspect(requests) {
          inspected.push(...clone(requests))
          return ports.useCases.artifacts.inspect(requests)
        },
        apply(effects) {
          applied.push(...clone(effects))
          return ports.useCases.artifacts.apply(effects)
        }
      }
    },
    sessions,
    ledger
  })
  assertSuccess(await app.execute(command('decide', 'minimal-decision-input', {
    id: 'reject-1',
    action: 'reject',
    note: 'typed input'
  })), 'decide')
  assert.deepEqual(inspected.map((request) => request.key), ['source'])
  assert.deepEqual(applied, [{
    kind: 'remove',
    target: { scope: 'hub', segments: ['skills', 'inbox', 'reject-skill'] }
  }])
  assert.equal(inspected.some((value) => Object.hasOwn(value, 'action')), false)
  assert.equal(applied.some((value) => Object.hasOwn(value, 'action')), false)
})

test('a terminal same-action decision with a new requestId is a no-op with no second host or state effect', async () => {
  const { context } = createContext()
  const ports = createLocalApplicationPorts(context)
  const calls = { inspect: 0, apply: 0, writeState: 0, appendHistory: 0 }
  const app = createHubApplication({
    ...ports,
    ...memoryApplicationInfrastructure(context),
    useCases: {
      ...ports.useCases,
      state: {
        ...ports.useCases.state,
        writeState(state) {
          calls.writeState += 1
          return ports.useCases.state.writeState(state)
        },
        appendHistory(write) {
          calls.appendHistory += 1
          return ports.useCases.state.appendHistory(write)
        }
      },
      artifacts: {
        inspect(requests) {
          calls.inspect += 1
          return ports.useCases.artifacts.inspect(requests)
        },
        apply(effects) {
          calls.apply += 1
          return ports.useCases.artifacts.apply(effects)
        }
      }
    },
    sessions: createMemorySessions({ now: () => FIXED_NOW }),
    ledger: createMemoryRequestLedger()
  })
  assertSuccess(await app.execute(command('decide', 'terminal-first', {
    id: 'reject-1', action: 'reject'
  })), 'decide')
  assertSuccess(await app.execute(command('decide', 'terminal-second', {
    id: 'reject-1', action: 'reject'
  })), 'decide')
  assert.deepEqual(calls, { inspect: 1, apply: 1, writeState: 1, appendHistory: 1 })
})

test('first legacy attach requires a matching successful waiting attach session and replays one approved effect', async () => {
  const { app, ledger, legacyAttach, sessions } = createFixture()
  sessions.sessions.push(
    {
      id: 'wrong-target',
      kind: 'attach',
      status: 'waiting',
      target: { kind: 'worktree', id: worktreeTargetId('/another-tree') },
      startedAt: FIXED_NOW,
      exitCode: 0,
      canResume: true
    },
    {
      id: 'terminal-attach',
      kind: 'attach',
      status: 'completed',
      target: { kind: 'worktree', id: worktreeTargetId('/game-tree') },
      startedAt: FIXED_NOW,
      endedAt: FIXED_NOW,
      canResume: false
    },
    {
      id: 'waiting-attach',
      kind: 'attach',
      status: 'waiting',
      target: { kind: 'worktree', id: worktreeTargetId('\\game-tree\\') },
      startedAt: FIXED_NOW,
      exitCode: 0,
      canResume: true
    },
    {
      id: 'running-attach',
      kind: 'attach',
      status: 'running',
      target: { kind: 'worktree', id: worktreeTargetId('/game-tree') },
      startedAt: FIXED_NOW,
      canResume: false
    },
    {
      id: 'waiting-nonzero',
      kind: 'attach',
      status: 'waiting',
      target: { kind: 'worktree', id: worktreeTargetId('/game-tree') },
      startedAt: FIXED_NOW,
      exitCode: 9,
      canResume: true
    }
  )

  for (const [index, sessionId] of [
    undefined,
    'waiting-1',
    'wrong-target',
    'terminal-attach',
    'running-attach',
    'waiting-nonzero'
  ].entries()) {
    const result = await app.execute(command('applyLegacyAttach', `attach-denied-${index}`, {
      worktree: '/game-tree',
      ...(sessionId ? { sessionId } : {}),
      sourcePolicy: 'preferLibrary'
    }))
    assertFailure(result, 'FIRST_ATTACH_SESSION_REQUIRED')
  }
  assert.equal(legacyAttach.calls.apply, 0)

  const request = command('applyLegacyAttach', 'attach-approved-once', {
    worktree: '/game-tree',
    sessionId: 'waiting-attach',
    sourcePolicy: 'preferLibrary',
    visibility: 'preserve'
  })
  const first = await app.execute(request)
  const replay = await app.execute(clone(request))
  assertSuccess(first, 'applyLegacyAttach')
  assertSuccess(replay, 'applyLegacyAttach')
  assert.equal(first.meta.replayed, false)
  assert.equal(replay.meta.replayed, true)
  assert.equal(first.data.claim, 'created')
  assert.equal(legacyAttach.calls.apply, 1)
  assert.equal(ledger.entries.length, 7)
  assert.equal(ledger.events.length, 7)
})

test('an existing claim never authorizes applyLegacyAttach promotion or host effects without a matching session', async () => {
  const { app, legacyAttach } = createFixture({
    legacyAttach: {
      inspect(resolvedPath) {
        return {
          worktree: {
            targetId: worktreeTargetId(resolvedPath),
            resolvedPath,
            recognition: {
              exists: true,
              isDirectory: true,
              sameAsHub: false,
              excluded: false,
              partialCheckout: false,
              explicitlyAllowed: false,
              ephemeral: false,
              requiredMarkers: [
                { name: 'AGENTS.md', present: true },
                { name: 'baloot_client', present: true }
              ]
            },
            blocked: false,
            claimed: true
          },
          gitWorktree: true,
          artifacts: [],
          trackedAssistantPaths: [],
          presentAssistantPaths: []
        }
      }
    }
  })
  for (const [index, sessionId] of [undefined, 'waiting-1'].entries()) {
    const result = await app.execute(command('applyLegacyAttach', `claimed-attach-denied-${index}`, {
      worktree: '/game-tree',
      ...(sessionId ? { sessionId } : {}),
      sourcePolicy: 'promoteFromWorktree',
      visibility: 'disable',
      configureGit: true
    }))
    assertFailure(result, 'FIRST_ATTACH_SESSION_REQUIRED')
  }
  assert.equal(legacyAttach.calls.apply, 0)
})

test('legacy detach apply requires one matching live detach session and replays one approved effect', async () => {
  const missingOverlay = {
    id: 'local-overlay',
    kind: 'localOverlay',
    label: '.codex/local-overlay',
    targetRelativePath: '.codex/local-overlay',
    hubRelativePath: 'overlay/local-overlay',
    expectedKind: 'directory',
    libraryExists: true,
    observed: {
      exists: false,
      linkedToExpected: false,
      pointsElsewhere: false,
      contentMatches: false
    }
  }
  const { app, ledger, legacyDetach, sessions } = createFixture({
    legacyDetach: {
      inspect: (resolvedPath) => recognizedLegacyInspection(resolvedPath, {
        worktree: { claimed: true },
        artifacts: [missingOverlay],
        trackedAssistantPaths: ['.claude/settings.json']
      })
    }
  })
  sessions.sessions.push(
    {
      id: 'wrong-detach-target',
      kind: 'detach',
      status: 'waiting',
      target: { kind: 'worktree', id: worktreeTargetId('/another-tree') },
      startedAt: FIXED_NOW,
      canResume: true
    },
    {
      id: 'wrong-detach-kind',
      kind: 'attach',
      status: 'waiting',
      target: { kind: 'worktree', id: worktreeTargetId('/game-tree') },
      startedAt: FIXED_NOW,
      canResume: true
    },
    {
      id: 'terminal-detach',
      kind: 'detach',
      status: 'completed',
      target: { kind: 'worktree', id: worktreeTargetId('/game-tree') },
      startedAt: FIXED_NOW,
      endedAt: FIXED_NOW,
      canResume: false
    },
    {
      id: 'waiting-detach',
      kind: 'detach',
      status: 'waiting',
      target: { kind: 'worktree', id: worktreeTargetId('\\game-tree\\') },
      startedAt: FIXED_NOW,
      canResume: true
    }
  )

  for (const [index, sessionId] of [
    undefined,
    'waiting-1',
    'running-1',
    'wrong-detach-target',
    'wrong-detach-kind',
    'terminal-detach'
  ].entries()) {
    const result = await app.execute(command('applyLegacyDetach', `detach-denied-${index}`, {
      worktree: '/game-tree',
      ...(sessionId ? { sessionId } : {})
    }))
    assertFailure(result, 'DETACH_SESSION_REQUIRED')
  }
  assert.equal(legacyDetach.calls.apply, 0)

  const request = command('applyLegacyDetach', 'detach-approved-once', {
    worktree: '/game-tree',
    sessionId: 'waiting-detach'
  })
  const first = await app.execute(request)
  const replay = await app.execute(clone(request))
  const conflict = await app.execute(command('applyLegacyDetach', 'detach-approved-once', {
    worktree: '/game-tree',
    sessionId: 'wrong-detach-target'
  }))
  const data = assertSuccess(first, 'applyLegacyDetach')
  assertSuccess(replay, 'applyLegacyDetach')
  assertFailure(conflict, 'REQUEST_ID_CONFLICT')
  assert.equal(first.meta.replayed, false)
  assert.equal(replay.meta.replayed, true)
  assert.deepEqual(data, {
    action: 'applyLegacyDetach',
    mode: 'legacyLinks',
    worktree: '/game-tree',
    changed: true,
    detached: true,
    plan: {
      artifacts: [{ id: 'local-overlay', label: '.codex/local-overlay', action: 'keepMissing' }],
      restorePaths: ['.claude/settings.json'],
      removeClaim: true
    },
    effects: [{ id: 'local-overlay', status: 'missing' }],
    restoredTracked: 1,
    claim: 'removed'
  })
  assert.deepEqual(replay.data, data)
  assert.equal(legacyDetach.calls.apply, 1)
  assert.equal(legacyDetach.appliedPlans.length, 1)
  assert.equal(ledger.entries.length, 7)
  assert.equal(ledger.events.length, 7)
})

test('failed decide and resume audit records hash subjects and never persist business identifiers', async () => {
  const { app, ledger } = createFixture()
  const decideSentinel = 'sentinel-decide-secret-7391'
  const sessionSentinel = 'sentinel-session-secret-2846'
  const decideResult = await app.execute(command('decide', 'failed-decide-redaction', {
    id: decideSentinel,
    action: 'reject'
  }))
  const resumeResult = await app.execute(command('resumeSession', 'failed-resume-redaction', {
    sessionId: sessionSentinel,
    message: 'do not persist this message'
  }))

  assertFailure(decideResult, 'NOT_FOUND')
  assertFailure(resumeResult, 'NOT_FOUND')
  assert.equal(decideResult.error.message, 'inbox item not found')
  assert.equal(resumeResult.error.message, 'session not found')
  assert.equal(ledger.events[0].subject, `inbox:${createHash('sha256').update(decideSentinel).digest('hex').slice(0, 16)}`)
  assert.equal(ledger.events[1].subject, `session:${createHash('sha256').update(sessionSentinel).digest('hex').slice(0, 16)}`)
  const persisted = JSON.stringify({ entries: ledger.entries, events: ledger.events })
  assert.equal(persisted.includes(decideSentinel), false)
  assert.equal(persisted.includes(sessionSentinel), false)
  assert.equal(persisted.includes('do not persist this message'), false)
})

test('same requestId and payload replays sequentially without another session, effect, or audit event', async () => {
  const { app, ledger, sessions } = createFixture()
  const request = command('chat', 'replay-sequential', { intent: 'one effect' })
  const first = await app.execute(request)
  const replay = await app.execute(clone(request))

  assertSuccess(first, 'chat')
  assertSuccess(replay, 'chat')
  assert.equal(first.meta.replayed, false)
  assert.equal(replay.meta.replayed, true)
  assert.deepEqual(replay.data, first.data)
  assert.equal('intent' in first.data.session, false)
  assert.equal(JSON.stringify(ledger.entries).includes('one effect'), false)
  assert.deepEqual(replay.events, first.events)
  assert.equal(sessions.calls.start, 1)
  assert.equal(ledger.calls.begin, 1)
  assert.equal(ledger.calls.complete, 1)
  assert.equal(ledger.entries.length, 1)
  assert.equal(ledger.events.length, 1)
})

test('reaped analyze completion flows through Core/Application state and redacted audit exactly once', async () => {
  const sensitiveOutput = '```json\n{"action":"reject","reason":"sensitive model rationale"}\n```'
  const fixture = createObservedFixture({
    configure({ sessions }) {
      sessions.reap = (sessionIds) => {
        sessions.calls.reap += 1
        assert.deepEqual(sessionIds, ['analyze-finished'])
        return [{
          id: 'analyze-finished',
          kind: 'analyze',
          status: 'waiting',
          target: { kind: 'inbox', id: 'queued-1' },
          startedAt: FIXED_NOW,
          endedAt: FIXED_NOW,
          exitCode: 0,
          canResume: true,
          inboxIds: ['queued-1'],
          lastMessage: sensitiveOutput,
          summary: 'must also stay out of the command result'
        }]
      }
    }
  })
  const request = command('reapSessions', 'analyze-completion-once', { sessionIds: ['analyze-finished'] })
  const first = await fixture.app.execute(request)
  assertSuccess(first, 'reapSessions')
  assert.deepEqual(first.events.map((event) => event.type), ['inbox.transitioned', 'command.succeeded'])
  assert.equal(first.events[0].subject.startsWith('inbox:'), true)
  assert.deepEqual(first.events[0].details, { nextStatus: 'proposed', source: 'analyze-completion' })
  assert.equal(JSON.stringify(first.events).includes('queued-1'), false)
  assert.equal(JSON.stringify(first.events).includes('sensitive model rationale'), false)
  assert.equal(JSON.stringify(first.data).includes('sensitive model rationale'), false)
  assert.equal(JSON.stringify(first.data).includes('must also stay out'), false)
  const state = fixture.useCases.state.readState()
  const item = state.items.find((candidate) => candidate.id === 'queued-1')
  assert.equal(item.status, 'proposed')
  assert.equal(item.suggestion.action, 'reject')
  assert.equal(fixture.calls.stateWrite, 1)
  assert.equal(fixture.ledger.events.length, 2)

  const replay = await fixture.app.execute(clone(request))
  assertSuccess(replay, 'reapSessions')
  assert.equal(replay.meta.replayed, true)
  assert.equal(fixture.sessions.calls.reap, 1)
  assert.equal(fixture.calls.stateWrite, 1)
  assert.equal(fixture.ledger.events.length, 2)
})

test('twenty concurrent identical requests create exactly one session/effect/audit result', async () => {
  const { app, ledger, sessions } = createFixture()
  const request = command('chat', 'replay-concurrent', { intent: 'one concurrent effect' })
  const results = await Promise.all(Array.from({ length: 20 }, () => app.execute(clone(request))))

  assert.ok(results.every((result) => result.ok))
  assert.equal(results.filter((result) => !result.meta.replayed).length, 1)
  assert.equal(results.filter((result) => result.meta.replayed).length, 19)
  assert.equal(new Set(results.map((result) => result.data.session.id)).size, 1)
  assert.equal(sessions.calls.start, 1)
  assert.equal(ledger.calls.begin, 1)
  assert.equal(ledger.calls.complete, 1)
  assert.equal(ledger.entries.length, 1)
  assert.equal(ledger.events.length, 1)
})

test('same requestId with a different payload fails with REQUEST_ID_CONFLICT and no second audit', async () => {
  const { app, ledger, sessions } = createFixture()
  assertSuccess(await app.execute(command('chat', 'request-conflict', { intent: 'first payload' })), 'chat')
  const conflict = await app.execute(command('chat', 'request-conflict', { intent: 'different payload' }))

  assertFailure(conflict, 'REQUEST_ID_CONFLICT')
  assert.equal(conflict.events.length, 0)
  assert.equal(sessions.calls.start, 1)
  assert.equal(ledger.entries.length, 1)
  assert.equal(ledger.events.length, 1)
})

test('deterministic rejection is cached and audited exactly once', async () => {
  const { app, ledger, sessions } = createFixture()
  const request = command('attach', 'rejected-replay', { worktree: '/foreign-tree' })
  const first = await app.execute(request)
  const replay = await app.execute(clone(request))

  assertFailure(first, 'WORKTREE_NOT_RECOGNIZED')
  assertFailure(replay, 'WORKTREE_NOT_RECOGNIZED')
  assert.equal(first.meta.replayed, false)
  assert.equal(replay.meta.replayed, true)
  assert.equal(first.events.length, 1)
  assert.equal(first.events[0].outcome, 'rejected')
  assert.deepEqual(replay.events, first.events)
  assert.equal(sessions.calls.start, 0)
  assert.equal(ledger.calls.begin, 1)
  assert.equal(ledger.calls.complete, 1)
  assert.equal(ledger.entries.length, 1)
  assert.equal(ledger.events.length, 1)
})

test('two Application instances sharing one ledger replay sequentially without a second host effect', async () => {
  const { context } = createContext()
  const ledger = createMemoryRequestLedger()
  const sessionsA = createMemorySessions({ now: () => FIXED_NOW })
  const sessionsB = createMemorySessions({ now: () => FIXED_NOW })
  const applicationPorts = createLocalApplicationPorts(context)
  const p2 = createMemoryP2Ports(context)
  const appA = createHubApplication({
    ...applicationPorts,
    sessions: sessionsA,
    ledger,
    p2,
    transactions: createMemoryApplicationTransactions()
  })
  const appB = createHubApplication({
    ...applicationPorts,
    sessions: sessionsB,
    ledger,
    p2,
    transactions: createMemoryApplicationTransactions()
  })
  const request = command('chat', 'cross-instance', { intent: 'shared ledger replay' })

  const first = await appA.execute(request)
  const replay = await appB.execute(clone(request))
  assertSuccess(first, 'chat')
  assertSuccess(replay, 'chat')
  assert.equal(first.meta.replayed, false)
  assert.equal(replay.meta.replayed, true)
  assert.deepEqual(replay.data, first.data)
  assert.equal(sessionsA.calls.start, 1)
  assert.equal(sessionsB.calls.start, 0)
  assert.equal(ledger.entries.length, 1)
  assert.equal(ledger.events.length, 1)
})

test('omitted HTTP runner defaults replay the explicit CLI defaults for one requestId', async () => {
  const { app, ledger, sessions } = createFixture()
  const requestId = 'cross-transport-runner-defaults'
  const cli = command('chat', requestId, {
    intent: 'same semantic command',
    runner: { start: true, wait: false }
  }, { hostId: 'local-cli', transport: 'cli' })
  const http = command('chat', requestId, {
    intent: 'same semantic command'
  }, { hostId: 'local-http', transport: 'http' })

  const first = await app.execute(cli)
  const replay = await app.execute(http)
  assertSuccess(first, 'chat')
  assertSuccess(replay, 'chat')
  assert.equal(first.meta.replayed, false)
  assert.equal(replay.meta.replayed, true)
  assert.equal(replay.data.session.id, first.data.session.id)
  assert.equal(sessions.calls.start, 1)
  assert.equal(ledger.calls.begin, 1)
  assert.equal(ledger.calls.complete, 1)
  assert.equal(ledger.entries.length, 1)
  assert.equal(ledger.events.length, 1)

  const conflict = await app.execute(command('chat', requestId, {
    intent: 'same semantic command',
    runner: { start: false, wait: false }
  }, { hostId: 'local-http', transport: 'http' }))
  assertFailure(conflict, 'REQUEST_ID_CONFLICT')
  assert.equal(sessions.calls.start, 1)
})

test('cross-transport write defaults replay for attach application and ingest instead of conflicting', async () => {
  {
    const { app, legacyAttach } = createFixture({
      sessions: [
        ...sessionSeed(),
        {
          id: 'legacy-ready',
          kind: 'attach',
          status: 'waiting',
          target: { kind: 'worktree', id: worktreeTargetId('/game-tree') },
          startedAt: FIXED_NOW,
          exitCode: 0,
          canResume: true
        }
      ]
    })
    const requestId = 'cross-transport-legacy-defaults'
    const explicit = command('applyLegacyAttach', requestId, {
      worktree: '/game-tree',
      sessionId: 'legacy-ready',
      sourcePolicy: 'requireMatch',
      visibility: 'disable',
      configureGit: false
    }, { hostId: 'local-cli', transport: 'cli' })
    const omitted = command('applyLegacyAttach', requestId, {
      worktree: '/game-tree',
      sessionId: 'legacy-ready'
    }, { hostId: 'local-http', transport: 'http' })
    const first = await app.execute(explicit)
    const replay = await app.execute(omitted)
    assertSuccess(first, 'applyLegacyAttach')
    assertSuccess(replay, 'applyLegacyAttach')
    assert.equal(replay.meta.replayed, true)
    assert.equal(legacyAttach.calls.apply, 1)
  }

  {
    const { app, ledger } = createFixture()
    const requestId = 'cross-transport-ingest-defaults'
    const explicit = command('ingest', requestId, {
      payload: '',
      gameRepo: null,
      dispatch: false,
      dryRun: false
    }, { hostId: 'local-cli', transport: 'cli' })
    const omitted = command('ingest', requestId, {
      payload: ''
    }, { hostId: 'local-http', transport: 'http' })
    const first = await app.execute(explicit)
    const replay = await app.execute(omitted)
    assertSuccess(first, 'ingest')
    assertSuccess(replay, 'ingest')
    assert.equal(replay.meta.replayed, true)
    assert.equal(ledger.calls.begin, 1)
    assert.equal(ledger.calls.complete, 1)
  }
})

test('a successful handler is not reclassified or rerun when its outcome cannot be persisted', async () => {
  const { context } = createContext()
  const sessions = createMemorySessions({ now: () => FIXED_NOW })
  const ledger = createMemoryRequestLedger()
  const completions = []
  ledger.complete = (entry, event) => {
    ledger.calls.complete += 1
    completions.push({ entry, event })
    throw new Error('ledger disk unavailable')
  }
  const app = createHubApplication({
    ...createLocalApplicationPorts(context),
    ...memoryApplicationInfrastructure(context),
    sessions,
    ledger
  })
  const request = command('chat', 'success-persist-failure', { intent: 'run once' })

  const result = await app.execute(request)
  assertFailure(result, 'PORT_FAILURE', true)
  assert.equal(result.error.message, 'host operation failed')
  assert.doesNotMatch(result.error.message, /ledger disk unavailable/)
  assert.deepEqual(result.events, [])
  assert.equal(sessions.calls.start, 1)
  assert.equal(ledger.calls.complete, 1)
  assert.equal(completions.length, 1)
  assert.equal(completions[0].entry.result.ok, true)
  assert.equal(completions[0].event.type, 'command.succeeded')
  assert.equal(ledger.events.length, 0)

  assertFailure(await app.execute(clone(request)), 'REQUEST_IN_PROGRESS', true)
  assert.equal(sessions.calls.start, 1)
  assert.equal(ledger.calls.complete, 1)
})

test('a failed handler keeps its original failure audit when that outcome cannot be persisted', async () => {
  const { context } = createContext()
  const sessions = createMemorySessions({ now: () => FIXED_NOW })
  sessions.start = () => {
    sessions.calls.start += 1
    throw portFault('runner-unavailable')
  }
  const ledger = createMemoryRequestLedger()
  const completions = []
  ledger.complete = (entry, event) => {
    ledger.calls.complete += 1
    completions.push({ entry, event })
    throw new Error('ledger disk unavailable')
  }
  const app = createHubApplication({
    ...createLocalApplicationPorts(context),
    ...memoryApplicationInfrastructure(context),
    sessions,
    ledger
  })
  const request = command('chat', 'failure-persist-failure', { intent: 'fail once' })

  const result = await app.execute(request)
  assertFailure(result, 'PORT_FAILURE', true)
  assert.equal(result.error.message, 'host operation failed')
  assert.doesNotMatch(result.error.message, /ledger disk unavailable/)
  assert.deepEqual(result.events, [])
  assert.equal(sessions.calls.start, 1)
  assert.equal(ledger.calls.complete, 1)
  assert.equal(completions.length, 1)
  assert.equal(completions[0].entry.result.ok, false)
  assert.equal(completions[0].entry.result.error.code, 'RUNNER_UNAVAILABLE')
  assert.equal(completions[0].event.type, 'command.failed')
  assert.deepEqual(completions[0].event.details, { errorCode: 'RUNNER_UNAVAILABLE' })
  assert.equal(ledger.events.length, 0)

  assertFailure(await app.execute(clone(request)), 'REQUEST_IN_PROGRESS', true)
  assert.equal(sessions.calls.start, 1)
  assert.equal(ledger.calls.complete, 1)
})

test('Application validation exposes stable error codes without touching the ledger', async () => {
  const { app, ledger } = createFixture()
  assertFailure(await app.execute(command('status', 'bad-version', {}, { contractVersion: 99 })), 'UNSUPPORTED_CONTRACT_VERSION')
  assertFailure(await app.execute(command('status', '   ')), 'REQUEST_ID_REQUIRED')
  assertFailure(await app.execute(command('status', 'bad-host', {}, { hostId: ' ' })), 'INVALID_COMMAND_META')
  const unsafeRequest = await app.execute(command('status', 'unsafe/request'))
  assertFailure(unsafeRequest, 'INVALID_COMMAND_META')
  assert.equal(unsafeRequest.requestId, '')
  assertFailure(await app.execute(command('status', 'long-host', {}, { hostId: 'h'.repeat(65) })), 'INVALID_COMMAND_META')
  assertFailure(await app.execute(command('status', 'bad-transport', {}, { transport: 'local transport' })), 'INVALID_COMMAND_META')
  assertFailure(await app.execute(command('decide', 'unsafe-inbox-id', { id: '../inbox', action: 'reject' })), 'INVALID_ARGUMENT')
  assertFailure(await app.execute(command('resumeSession', 'unsafe-session-id', { sessionId: 'session/id', message: 'continue' })), 'INVALID_ARGUMENT')
  assertFailure(await app.execute(command('reapSessions', 'unsafe-reap-id', { sessionIds: ['safe-id', 'bad id'] })), 'INVALID_ARGUMENT')
  const unknown = await app.execute({
    kind: 'not-a-command',
    meta: {
      contractVersion: CONTRACT_VERSION,
      requestId: 42,
      hostId: 'untrusted',
      transport: 'test'
    }
  })
  assertFailure(unknown, 'UNSUPPORTED_COMMAND')
  assert.equal(unknown.commandKind, 'unknown')
  assert.equal(unknown.requestId, '')
  assert.equal(typeof unknown.requestId, 'string')

  const numericKind = await app.execute({
    kind: 17,
    meta: {
      contractVersion: CONTRACT_VERSION,
      requestId: 'numeric-command-kind',
      hostId: 'untrusted',
      transport: 'test'
    }
  })
  assertFailure(numericKind, 'UNSUPPORTED_COMMAND')
  assert.equal(numericKind.commandKind, 'unknown')
  assert.equal(numericKind.requestId, 'numeric-command-kind')
  assert.equal(ledger.entries.length, 0)
  assert.equal(ledger.events.length, 0)
})

test('runtime and query port failures always resolve to PORT_FAILURE without rerunning handlers', async () => {
  {
    const { context } = createContext()
    const ports = createLocalApplicationPorts(context)
    const sessions = createMemorySessions({ now: () => FIXED_NOW })
    const ledger = createMemoryRequestLedger()
    const app = createHubApplication({
      ...ports,
      ...memoryApplicationInfrastructure(context),
      runtime: { ...ports.runtime, sha256: () => { throw new Error('hash port unavailable') } },
      sessions,
      ledger
    })
    const result = await app.execute(command('chat', 'hash-port-failure', { intent: 'must not start' }))
    assertFailure(result, 'PORT_FAILURE', true)
    assert.equal(result.error.message, 'host operation failed')
    assert.doesNotMatch(result.error.message, /hash port unavailable/)
    assert.equal(sessions.calls.start, 0)
    assert.equal(ledger.entries.length, 0)
  }

  {
    const { context } = createContext()
    const ports = createLocalApplicationPorts(context)
    const sessions = createMemorySessions({ now: () => FIXED_NOW })
    const ledger = createMemoryRequestLedger()
    let clockCalls = 0
    const app = createHubApplication({
      ...ports,
      ...memoryApplicationInfrastructure(context),
      runtime: {
        ...ports.runtime,
        nowIso() {
          clockCalls += 1
          if (clockCalls > 1) throw new Error('clock port unavailable during audit')
          return FIXED_NOW
        }
      },
      sessions,
      ledger
    })
    const request = command('chat', 'clock-port-failure', { intent: 'run once' })
    const result = await app.execute(request)
    assertFailure(result, 'PORT_FAILURE', true)
    assert.equal(result.error.message, 'host operation failed')
    assert.doesNotMatch(result.error.message, /clock port unavailable during audit/)
    assert.equal(sessions.calls.start, 1)
    assert.equal(ledger.entries.length, 1)
    assert.equal(ledger.entries[0].status, 'started')
    assertFailure(await app.execute(clone(request)), 'REQUEST_IN_PROGRESS', true)
    assert.equal(sessions.calls.start, 1)
  }

  {
    const { context } = createContext()
    const ports = createLocalApplicationPorts(context)
    const sessions = createMemorySessions({ now: () => FIXED_NOW })
    const ledger = createMemoryRequestLedger()
    const app = createHubApplication({
      ...ports,
      ...memoryApplicationInfrastructure(context),
      runtime: { ...ports.runtime, nextId: () => { throw new Error('id port unavailable') } },
      sessions,
      ledger
    })
    const result = await app.execute(command('chat', 'id-port-failure', { intent: 'run once' }))
    assertFailure(result, 'PORT_FAILURE', true)
    assert.equal(result.error.message, 'host operation failed')
    assert.doesNotMatch(result.error.message, /id port unavailable/)
    assert.equal(sessions.calls.start, 1)
    assert.equal(ledger.entries[0].status, 'started')
  }

  {
    const { context } = createContext()
    const ports = createLocalApplicationPorts(context)
    const sessions = createMemorySessions({ now: () => FIXED_NOW })
    const ledger = createMemoryRequestLedger()
    const app = createHubApplication({
      ...ports,
      ...memoryApplicationInfrastructure(context),
      queries: { ...ports.queries, readStatusFacts: () => { throw new Error('status port unavailable') } },
      sessions,
      ledger
    })
    const result = await app.execute(command('status', 'status-port-failure'))
    assertFailure(result, 'PORT_FAILURE', true)
    assert.equal(result.error.message, 'host operation failed')
    assert.doesNotMatch(result.error.message, /status port unavailable/)
    assert.equal(ledger.entries.length, 0)
  }
})

test('typed PortFault mapping is stable and unknown port errors never cross or enter the replay ledger', async () => {
  {
    const fixture = createObservedFixture({
      configure({ sessions }) {
        sessions.start = () => {
          sessions.calls.start += 1
          throw portFault('runner-unavailable')
        }
      }
    })
    const result = await fixture.app.execute(command('chat', 'typed-port-fault', { intent: 'run' }))
    assertFailure(result, 'RUNNER_UNAVAILABLE', true)
    assert.equal(result.error.message, 'session runner unavailable')
    assert.equal(JSON.stringify(fixture.ledger.entries).includes('runner-unavailable'), false)
  }

  for (const [name, thrown] of [
    ['unknown', new Error('SECRET database path and credentials')],
    ['spoof', {
      type: 'skill-graft.port-fault/v1',
      reason: 'runner-unavailable',
      message: 'SECRET forged safe message'
    }]
  ]) {
    const fixture = createObservedFixture({
      configure({ sessions }) {
        sessions.start = () => {
          sessions.calls.start += 1
          throw thrown
        }
      }
    })
    const result = await fixture.app.execute(command('chat', `${name}-port-fault`, { intent: 'run' }))
    assertFailure(result, 'PORT_FAILURE', true)
    assert.equal(result.error.message, 'host operation failed')
    const durable = JSON.stringify({ entries: fixture.ledger.entries, events: fixture.ledger.events })
    assert.doesNotMatch(durable, /SECRET|credentials|forged safe message/)
  }

  {
    const fixture = createObservedFixture({
      configure({ queries }) {
        queries.readStatusFacts = () => { throw new Error('SECRET query backend') }
      }
    })
    const result = await fixture.app.execute(command('status', 'unknown-query-port-fault'))
    assertFailure(result, 'PORT_FAILURE', true)
    assert.equal(result.error.message, 'host operation failed')
    assert.doesNotMatch(JSON.stringify(result), /SECRET query backend/)
    assert.equal(fixture.ledger.entries.length, 0)
  }
})

test('low-level state, Git, and artifact fact failures resolve to PORT_FAILURE before any approved effect', async () => {
  const cases = [
    {
      name: 'state',
      request: command('decide', 'low-port-state', { id: 'reject-1', action: 'reject' }),
      override(ports, calls) {
        return {
          ...ports.useCases,
          state: { ...ports.useCases.state, readState: () => { calls.state += 1; throw new Error('state read unavailable') } }
        }
      }
    },
    {
      name: 'git',
      request: command('ingest', 'low-port-git', {
        gameRepo: '/game-tree',
        payload: `${'1'.repeat(40)} ${'2'.repeat(40)} refs/remotes/origin/main\n`
      }),
      override(ports, calls) {
        return {
          ...ports.useCases,
          git: { ...ports.useCases.git, revisionExists: () => { calls.git += 1; throw new Error('git facts unavailable') } }
        }
      }
    },
    {
      name: 'artifact',
      request: command('decide', 'low-port-artifact', { id: 'queued-1', action: 'adopt' }),
      override(ports, calls) {
        return {
          ...ports.useCases,
          artifacts: {
            ...ports.useCases.artifacts,
            inspect: () => { calls.artifact += 1; throw new Error('artifact facts unavailable') }
          }
        }
      }
    }
  ]

  for (const scenario of cases) {
    const { context } = createContext()
    const ports = createLocalApplicationPorts(context)
    const calls = { state: 0, git: 0, artifact: 0, apply: 0 }
    const useCases = scenario.override(ports, calls)
    const originalApply = useCases.artifacts.apply
    useCases.artifacts = {
      ...useCases.artifacts,
      apply(effects) {
        calls.apply += 1
        return originalApply(effects)
      }
    }
    const app = createHubApplication({
      ...ports,
      ...memoryApplicationInfrastructure(context),
      useCases,
      sessions: createMemorySessions({ now: () => FIXED_NOW }),
      ledger: createMemoryRequestLedger()
    })
    const result = await app.execute(scenario.request)
    assertFailure(result, 'PORT_FAILURE', true)
    assert.equal(calls.apply, 0, `${scenario.name} failure must precede effects`)
  }
})

test('every command kind rejects malformed runtime payloads before ports, handlers, or ledger access', async () => {
  const malformed = [
    ['status', { unexpected: true }],
    ['listSkills', { unexpected: true }],
    ['listWorktrees', { unexpected: true }],
    ['readSkill', { path: 42 }],
    ['listHistory', { limit: '10' }],
    ['listSessions', { statuses: ['waiting', 'unknown'] }],
    ['getSession', { sessionId: '   ' }],
    ['inspectSchema', { unexpected: true }],
    ['listSnapshots', { unexpected: true }],
    ['getSnapshot', { snapshotId: 'not-a-snapshot' }],
    ['getPin', { worktree: '' }],
    ['planSync', { worktree: '' }],
    ['registerWorktree', { worktree: 42 }],
    ['repairLegacy', { worktree: null }],
    ['applyLegacyAttach', { worktree: '/game-tree', sourcePolicy: 'force' }],
    ['applyLegacyDetach', { worktree: '/game-tree', sessionId: [] }],
    ['ingest', { payload: 42 }],
    ['decide', { id: 'queued-1', action: 'archive' }],
    ['attach', {}],
    ['detach', { worktree: [] }],
    ['edit', { path: '' }],
    ['chat', { intent: 42 }],
    ['analyze', { runner: { start: 'yes' } }],
    ['resumeSession', { sessionId: 'waiting-1', message: '' }],
    ['cancelSession', { sessionId: [] }],
    ['reapSessions', { sessionIds: ['running-1', 42] }],
    ['createSnapshot', { unexpected: true }],
    ['setPin', { worktree: '/game-tree', snapshotId: 'invalid' }],
    ['migrateState', { mode: 'force' }],
    ['claimWorktree', { worktree: '/game-tree' }],
    ['sync', {
      worktree: '/game-tree',
      planHash: sha256Identifier('malformed-sync-session'),
      sessionId: []
    }],
    ['migrateLegacy', { worktree: '/game-tree', mode: 'force' }],
    ['rollbackLegacyMigration', {
      worktree: '/game-tree',
      migrationId: sha256Identifier('malformed-rollback'),
      mode: 'commit'
    }]
  ]
  assert.deepEqual(malformed.map(([kind]) => kind), [...QUERY_COMMAND_KINDS, ...WRITE_COMMAND_KINDS])

  const { app, ledger, sessions } = createFixture()
  for (const [index, [kind, input]] of malformed.entries()) {
    const result = await app.execute(command(kind, `malformed-${index}`, input))
    assertFailure(result, 'INVALID_ARGUMENT')
    assert.match(result.error.message, /must|unsupported/)
    assert.deepEqual(result.events, [])
  }

  assert.deepEqual(ledger.calls, { read: 0, begin: 0, complete: 0, listEvents: 0 })
  assert.equal(ledger.entries.length, 0)
  assert.equal(ledger.events.length, 0)
  assert.deepEqual(sessions.calls, {
    list: 0,
    get: 0,
    start: 0,
    resume: 0,
    cancel: 0,
    reap: 0,
    completeAttach: 0
  })
})

test('Application invocation trace emits exact entry/result pairs for success, replay, conflict, and failure', async () => {
  const trace = createMemoryInvocationTrace()
  const { app } = createFixture({ trace })
  const chat = command('chat', 'trace-chat', { intent: 'trace one effect' })

  const results = [
    await app.execute(command('status', 'trace-status')),
    await app.execute(chat),
    await app.execute(clone(chat)),
    await app.execute(command('chat', 'trace-chat', { intent: 'trace conflicting effect' })),
    await app.execute(command('getSession', 'trace-missing-session', { sessionId: 'missing' }))
  ]
  assert.deepEqual(results.map((result) => [result.ok, result.meta.replayed]), [
    [true, false],
    [true, false],
    [true, true],
    [false, false],
    [false, false]
  ])

  assert.equal(trace.events.length, results.length * 2)
  for (let index = 0; index < results.length; index += 1) {
    const sequence = index + 1
    const entry = trace.events[index * 2]
    const result = trace.events[index * 2 + 1]
    assert.deepEqual(Object.keys(entry).sort(), [
      'commandKind', 'handlerIdentity', 'phase', 'requestHash', 'sequence', 'transport'
    ].sort())
    assert.deepEqual(Object.keys(result).sort(), [
      'commandKind', 'handlerIdentity', 'ok', 'phase', 'replayed', 'requestHash', 'sequence', 'transport'
    ].sort())
    assert.equal(entry.phase, 'entry')
    assert.equal(result.phase, 'result')
    assert.equal(entry.sequence, sequence)
    assert.equal(result.sequence, sequence)
    assert.equal(entry.requestHash, result.requestHash)
    assert.equal(entry.commandKind, result.commandKind)
    assert.equal(entry.transport, 'memory')
    assert.equal(result.transport, 'memory')
    assert.equal(entry.handlerIdentity, 'application.commandBus')
    assert.equal(result.handlerIdentity, 'application.commandBus')
    assert.equal(result.ok, results[index].ok)
    assert.equal(result.replayed, results[index].meta.replayed)
  }
  assert.equal(trace.events[2].requestHash, trace.events[4].requestHash)
  assert.equal(trace.events[4].requestHash, trace.events[6].requestHash)

  const beforeInvalid = trace.events.length
  assertFailure(
    await app.execute(command('status', 'trace-invalid', {}, { contractVersion: 99 })),
    'UNSUPPORTED_CONTRACT_VERSION'
  )
  assert.equal(trace.events.length, beforeInvalid, 'unvalidated commands must not enter the trace port')
})

test('Application isolates invocation trace hash and append failures from business results', async () => {
  {
    const trace = createMemoryInvocationTrace({ hashRequestId: () => { throw new Error('trace hash unavailable') } })
    const { app } = createFixture({ trace })
    assertSuccess(await app.execute(command('status', 'trace-hash-failure')), 'status')
    assert.deepEqual(trace.events, [])
  }

  {
    const attempts = []
    const trace = createMemoryInvocationTrace({
      append(event) {
        attempts.push(clone(event))
        throw new Error('trace entry unavailable')
      }
    })
    const { app } = createFixture({ trace })
    assertSuccess(await app.execute(command('status', 'trace-entry-failure')), 'status')
    assert.equal(attempts.length, 1)
    assert.equal(attempts[0].phase, 'entry')
  }

  {
    const attempts = []
    const trace = createMemoryInvocationTrace({
      append(event) {
        attempts.push(clone(event))
        if (event.phase === 'result') throw new Error('trace result unavailable')
      }
    })
    const { app } = createFixture({ trace })
    assertSuccess(await app.execute(command('status', 'trace-result-failure')), 'status')
    assert.deepEqual(attempts.map((event) => event.phase), ['entry', 'result'])
  }
})

test('Local composition keeps tracing off by default and fails malformed explicit trace gates before host creation', async () => {
  const { context } = createContext()
  const sessions = createMemorySessions({ now: () => FIXED_NOW })
  const ledger = createMemoryRequestLedger()
  const local = createLocalHost({
    packageRoot: '/package-not-needed-with-trace-disabled',
    context,
    ...memoryApplicationInfrastructure(context),
    sessions,
    ledger,
    traceEnvironment: {}
  })
  assertSuccess(await local.application.execute(command('status', 'local-default-trace-off')), 'status')

  assert.throws(() => createLocalHost({
    packageRoot: '/package-not-read-before-gate-failure',
    context,
    ...memoryApplicationInfrastructure(context),
    sessions,
    ledger,
    traceEnvironment: {
      SKILL_GRAFT_INVOCATION_TRACE: '1',
      SKILL_GRAFT_REAL_E2E: '0'
    }
  }), /requires SKILL_GRAFT_REAL_E2E=1/)

  const infrastructure = memoryApplicationInfrastructure(context)
  for (const missing of ['p2', 'p3', 'transactions']) {
    const incomplete = { ...infrastructure }
    delete incomplete[missing]
    assert.throws(() => createLocalHost({
      packageRoot: '/package-not-needed-for-incomplete-infrastructure',
      context,
      ...incomplete,
      sessions,
      ledger,
      traceEnvironment: {}
    }), /p2, p3, and transactions must be supplied together/)
  }
})

test('ingest dry-run plans through Core, replays, conflicts, and records audit with zero business effects', async () => {
  const oldRevision = '7111111111111111111111111111111111111111'
  const nextRevision = '7222222222222222222222222222222222222222'
  const fixture = createObservedFixture({
    configure({ useCases }) {
      useCases.git.revisionExists = () => true
      useCases.git.changedPaths = () => [{ status: 'M', path: '.agents/skills/dry-run-skill/SKILL.md' }]
      useCases.git.readTree = () => [{ path: 'SKILL.md', content: '# Planned only\n' }]
    }
  })
  const request = command('ingest', 'ingest-dry-run-gate', {
    gameRepo: '/dry-run-game',
    payload: `${oldRevision} ${nextRevision} refs/remotes/origin/dry-run`,
    dispatch: true,
    dryRun: true
  })

  const first = await fixture.app.execute(request)
  assertSuccess(first, 'ingest')
  assert.equal(first.data.dryRun, true)
  assert.equal(first.data.created, 1)
  assert.equal(first.data.items[0].name, 'dry-run-skill')
  assert.equal(first.data.dispatched, false)
  assert.equal(first.data.session, undefined)
  assert.deepEqual(hostEffectSnapshot(fixture), expectedHostEffects())
  assert.equal(fixture.ledger.entries.length, 1)
  assert.equal(fixture.ledger.entries[0].status, 'completed')
  assert.equal(fixture.ledger.events.length, 1)
  assert.equal(fixture.ledger.events[0].type, 'command.succeeded')

  const replay = await fixture.app.execute(clone(request))
  assertSuccess(replay, 'ingest')
  assert.equal(replay.meta.replayed, true)
  assert.deepEqual(withoutReplayMarker(replay), withoutReplayMarker(first))
  assert.deepEqual(hostEffectSnapshot(fixture), expectedHostEffects())
  assert.equal(fixture.ledger.calls.begin, 1)
  assert.equal(fixture.ledger.calls.complete, 1)
  assert.equal(fixture.ledger.events.length, 1)

  const conflict = await fixture.app.execute(command('ingest', request.meta.requestId, {
    gameRepo: '/dry-run-game',
    payload: request.payload,
    dispatch: true,
    dryRun: false
  }))
  assertFailure(conflict, 'REQUEST_ID_CONFLICT')
  assert.deepEqual(hostEffectSnapshot(fixture), expectedHostEffects())
  assert.equal(fixture.ledger.entries.length, 1)
  assert.equal(fixture.ledger.events.length, 1)
})

test('ingest dryRun validates as an optional boolean before claiming a request', async () => {
  const { app, ledger } = createFixture()
  const result = await app.execute(command('ingest', 'invalid-ingest-dry-run', {
    payload: '',
    dryRun: 'yes'
  }))
  assertFailure(result, 'INVALID_ARGUMENT')
  assert.match(result.error.message, /dryRun must be a boolean/)
  assert.deepEqual(ledger.calls, { read: 0, begin: 0, complete: 0, listEvents: 0 })
  assert.equal(ledger.entries.length, 0)
  assert.equal(ledger.events.length, 0)
})
