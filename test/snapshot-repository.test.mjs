import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const outputRoot = path.resolve(process.env.SKILL_GRAFT_TEST_DIST || 'dist')
const durable = await import(pathToFileURL(path.join(outputRoot, 'adapters', 'durable-state.js')).href)
const snapshots = await import(pathToFileURL(path.join(outputRoot, 'adapters', 'snapshot-repository.js')).href)
const core = await import(pathToFileURL(path.join(outputRoot, 'core', 'index.js')).href)
const contracts = await import(pathToFileURL(path.join(outputRoot, 'contracts', 'index.js')).href)

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-snapshot-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function memoryLock() {
  let held = false
  return {
    async acquire() {
      if (held) return { status: 'busy', reason: 'held' }
      held = true
      return {
        status: 'acquired',
        lease: {
          ownerToken: 'snapshot-test-owner',
          renew() {
            if (!held) throw Object.assign(new Error('lost'), { code: 'LOCK_NOT_OWNED' })
          },
          release() { held = false }
        }
      }
    }
  }
}

function identity(requestId) {
  return {
    scope: 'hub-global',
    key: 'hub-global',
    hostId: 'snapshot-test-host',
    commandKind: 'createSnapshot',
    requestId
  }
}

function schemaFor(relativePath) {
  if (/^skill-review\/library\/snapshots\/[a-f0-9]{64}\.json$/.test(relativePath)) {
    return {
      name: 'LibrarySnapshotManifestV1',
      validate(value) {
        const result = contracts.validateLibrarySnapshotManifestV1(value)
        return result.valid && core.verifyLibrarySnapshotManifest(value)
          ? { valid: true }
          : { valid: false, message: 'invalid snapshot manifest' }
      }
    }
  }
  if (relativePath.endsWith('.json')) {
    return {
      name: `test-json:${relativePath}`,
      validate(value) {
        return value && typeof value === 'object' && !Array.isArray(value)
          ? { valid: true }
          : { valid: false, message: 'expected object' }
      }
    }
  }
  return undefined
}

function createApproved(observation, createdAt) {
  const result = core.createLibrarySnapshotManifest({
    source: observation.source,
    createdAt,
    files: observation.files
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  return result.manifest
}

test('query-only snapshot repository construction and list do not create an absent source or repository', (t) => {
  const base = fixture(t)
  const sourceRoot = path.join(base, 'missing-source')
  const repositoryRoot = path.join(sourceRoot, 'skill-review', 'library')
  const repository = snapshots.createSnapshotRepository({
    root: repositoryRoot,
    sourceRoot,
    source: { kind: 'library', id: 'missing' },
    captureRoots: ['AGENTS.override.md'],
    persist: {
      readOptionalJson() { return null },
      readJson(_file, fallback) { return structuredClone(fallback) },
      writeJson() { throw new Error('query attempted a write') },
      readList() { return [] },
      readState() { return { version: 1, items: [], lastIngest: null } },
      writeState() { throw new Error('query attempted a write') }
    }
  })
  assert.deepEqual(repository.list(), [])
  assert.equal(fs.existsSync(sourceRoot), false)
})

test('snapshot store rejects outside a write transaction before publishing CAS blobs', (t) => {
  const dataRoot = fixture(t)
  fs.writeFileSync(path.join(dataRoot, 'AGENTS.override.md'), 'agent rules\n', 'utf8')
  const host = durable.createDurableTransactionHost({
    root: dataRoot,
    schemaFor,
    lock: memoryLock()
  })
  const repositoryRoot = path.join(dataRoot, 'skill-review', 'library')
  const repository = snapshots.createSnapshotRepository({
    root: repositoryRoot,
    sourceRoot: dataRoot,
    source: { kind: 'library', id: 'source' },
    captureRoots: ['AGENTS.override.md'],
    persist: host.persist
  })
  const observation = repository.observe()
  const approved = createApproved(observation, '2026-08-22T00:00:00.000Z')
  assert.throws(
    () => repository.store(observation.captureId, approved),
    (error) => error?.code === 'PORT_FAILURE' && error.retryable === true
  )
  assert.equal(fs.existsSync(repositoryRoot), false)
})

test('two-phase capture stages only the manifest in the shared WAL and deduplicates provenance', async (t) => {
  const dataRoot = fixture(t)
  fs.mkdirSync(path.join(dataRoot, 'skills', 'ozdqp-development'), { recursive: true })
  fs.writeFileSync(path.join(dataRoot, 'AGENTS.override.md'), 'agent rules\n', 'utf8')
  fs.writeFileSync(path.join(dataRoot, 'skills', 'ozdqp-development', 'SKILL.md'), 'skill body\n', 'utf8')

  const host = durable.createDurableTransactionHost({
    root: dataRoot,
    schemaFor,
    lock: memoryLock()
  })
  let source = { kind: 'library', id: 'source-a', revision: 'one' }
  let captureRoots = ['skills/ozdqp-development', 'AGENTS.override.md']
  const repositoryRoot = path.join(dataRoot, 'skill-review', 'library')
  const repository = snapshots.createSnapshotRepository({
    root: repositoryRoot,
    sourceRoot: dataRoot,
    source: () => source,
    captureRoots: () => captureRoots,
    persist: host.persist,
    token: () => 'z'.repeat(64)
  })

  let first
  await host.transactions.withWriteTransaction(identity('snapshot-one'), async (transaction) => {
    const observation = repository.observe()
    const approved = createApproved(observation, '2026-08-22T00:00:00.000Z')
    first = repository.store(observation.captureId, approved)
    assert.deepEqual(repository.list(), [])
    assert.equal(repository.read(approved.snapshotId).snapshotId, approved.snapshotId)
    host.persist.writeJson(path.join(dataRoot, 'state.json'), {
      version: 1,
      snapshotId: approved.snapshotId
    })
    return transaction.commit(null)
  })
  assert.equal(first.deduplicated, false)
  assert.equal(repository.list().length, 1)
  assert.equal(repository.list()[0].source.id, 'source-a')
  const overrideFile = first.manifest.files.find((file) => file.path === 'AGENTS.override.md')
  assert.ok(overrideFile)
  assert.equal(
    Buffer.from(repository.readVerifiedFile({
      snapshotId: first.manifest.snapshotId,
      path: overrideFile.path,
      expectedSize: overrideFile.size,
      expectedSha256: overrideFile.sha256
    })).toString('utf8'),
    'agent rules\n'
  )
  assert.equal(repository.readVerifiedFile({
    snapshotId: first.manifest.snapshotId,
    path: 'skills/not-in-the-manifest/SKILL.md',
    expectedSize: 0,
    expectedSha256: overrideFile.sha256
  }), null)
  assert.throws(() => repository.readVerifiedFile({
    snapshotId: first.manifest.snapshotId,
    path: overrideFile.path,
    expectedSize: overrideFile.size + 1,
    expectedSha256: overrideFile.sha256
  }), /does not match its manifest/)

  const primaryManifest = path.join(
    repositoryRoot,
    'snapshots',
    `${first.manifest.snapshotId.slice('sha256:'.length)}.json`
  )
  const backupManifest = path.join(
    repositoryRoot,
    'snapshots',
    `.${first.manifest.snapshotId.slice('sha256:'.length)}.json.skill-graft.bak`
  )
  assert.equal(fs.existsSync(primaryManifest), true)
  assert.equal(fs.existsSync(backupManifest), true)

  source = { kind: 'library', id: 'source-b', revision: 'two' }
  fs.utimesSync(
    path.join(dataRoot, 'AGENTS.override.md'),
    new Date('2026-08-22T01:00:00.000Z'),
    new Date('2026-08-22T01:00:00.000Z')
  )
  let duplicate
  await host.transactions.withWriteTransaction(identity('snapshot-two'), async (transaction) => {
    const observation = repository.observe()
    const approved = createApproved(observation, '2026-08-22T02:00:00.000Z')
    assert.equal(approved.snapshotId, first.manifest.snapshotId)
    duplicate = repository.store(observation.captureId, approved)
    return transaction.commit(null)
  })
  assert.equal(duplicate.deduplicated, true)
  assert.equal(duplicate.manifest.source.id, 'source-a')
  assert.equal(repository.list().length, 1)

  fs.writeFileSync(path.join(dataRoot, 'AGENTS.override.md'), 'changed rules\n', 'utf8')
  let abortedId
  await assert.rejects(host.transactions.withWriteTransaction(identity('snapshot-abort'), async (transaction) => {
    const observation = repository.observe()
    const approved = createApproved(observation, '2026-08-22T03:00:00.000Z')
    abortedId = approved.snapshotId
    repository.store(observation.captureId, approved)
    assert.equal(repository.read(abortedId).snapshotId, abortedId)
    return transaction.abort(new Error('terminal-ledger-failure'))
  }), /terminal-ledger-failure/)
  assert.equal(repository.read(abortedId), null)
  assert.equal(repository.list().length, 1)
  assert.equal(fs.existsSync(path.join(repositoryRoot, '.captures')), false)

  captureRoots = ['AGENTS.override.md', 'agents.override.md']
  assert.throws(() => repository.observe(), /approved roots collide/)
})

test('manifest backup and blob closure are both required for reads', async (t) => {
  const dataRoot = fixture(t)
  fs.writeFileSync(path.join(dataRoot, 'AGENTS.override.md'), 'one file\n', 'utf8')
  const host = durable.createDurableTransactionHost({ root: dataRoot, schemaFor, lock: memoryLock() })
  const repositoryRoot = path.join(dataRoot, 'skill-review', 'library')
  const repository = snapshots.createSnapshotRepository({
    root: repositoryRoot,
    sourceRoot: dataRoot,
    source: { kind: 'library', id: 'source' },
    captureRoots: ['AGENTS.override.md'],
    persist: host.persist
  })
  let stored
  await host.transactions.withWriteTransaction(identity('snapshot'), async (transaction) => {
    const observation = repository.observe()
    stored = repository.store(
      observation.captureId,
      createApproved(observation, '2026-08-22T00:00:00.000Z')
    )
    return transaction.commit(null)
  })
  const digest = stored.manifest.snapshotId.slice('sha256:'.length)
  const primary = path.join(repositoryRoot, 'snapshots', `${digest}.json`)
  const backup = path.join(repositoryRoot, 'snapshots', `.${digest}.json.skill-graft.bak`)
  fs.writeFileSync(primary, '{broken', 'utf8')
  assert.equal(repository.read(stored.manifest.snapshotId).snapshotId, stored.manifest.snapshotId)
  fs.unlinkSync(primary)
  assert.equal(repository.list()[0].snapshotId, stored.manifest.snapshotId)

  const blob = path.join(
    repositoryRoot,
    'blobs',
    'sha256',
    stored.manifest.files[0].sha256.slice('sha256:'.length)
  )
  const originalBlob = fs.readFileSync(blob)
  fs.writeFileSync(blob, 'corrupt', 'utf8')
  assert.throws(() => repository.read(stored.manifest.snapshotId), /blob closure is invalid/)
  assert.throws(() => repository.readVerifiedFile({
    snapshotId: stored.manifest.snapshotId,
    path: stored.manifest.files[0].path,
    expectedSize: stored.manifest.files[0].size,
    expectedSha256: stored.manifest.files[0].sha256
  }), /blob closure is invalid/)
  fs.writeFileSync(blob, originalBlob)

  const linkedBlob = path.join(dataRoot, 'blob-hardlink-probe')
  try {
    fs.linkSync(blob, linkedBlob)
    assert.throws(
      () => repository.read(stored.manifest.snapshotId),
      (error) => error?.retryable === false && error?.code === 'PORT_FAILURE'
    )
    fs.unlinkSync(linkedBlob)
  } catch (error) {
    if (error?.code !== 'EPERM' && error?.code !== 'ENOTSUP') throw error
  }

  fs.writeFileSync(backup, '{also-broken', 'utf8')
  assert.throws(
    () => repository.read(stored.manifest.snapshotId),
    (error) => error?.code === 'STATE_CORRUPT' && error.retryable === false
  )
})

test('approved snapshot subtrees reject links and max+1 file traversal', (t) => {
  const dataRoot = fixture(t)
  fs.mkdirSync(path.join(dataRoot, 'skills'), { recursive: true })
  fs.writeFileSync(path.join(dataRoot, 'skills', 'one.md'), 'one', 'utf8')
  fs.writeFileSync(path.join(dataRoot, 'skills', 'two.md'), 'two', 'utf8')
  const persist = {
    readOptionalJson() { return null },
    readJson(_file, fallback) { return structuredClone(fallback) },
    writeJson() { throw new Error('not in transaction') },
    readList() { return [] },
    readState() { return { version: 1, items: [], lastIngest: null } },
    writeState() { throw new Error('not in transaction') }
  }
  const limited = snapshots.createSnapshotRepository({
    root: path.join(dataRoot, 'skill-review', 'library'),
    sourceRoot: dataRoot,
    source: { kind: 'library', id: 'source' },
    captureRoots: ['skills'],
    persist,
    limits: { maxFiles: 1 }
  })
  assert.throws(() => limited.observe(), /file limit/)

  const external = path.join(fixture(t), 'external')
  fs.mkdirSync(external)
  fs.writeFileSync(path.join(external, 'outside.md'), 'outside', 'utf8')
  const link = path.join(dataRoot, 'skills', 'linked')
  try {
    fs.symlinkSync(external, link, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (error?.code === 'EPERM') return
    throw error
  }
  const linked = snapshots.createSnapshotRepository({
    root: path.join(dataRoot, 'skill-review', 'other-library'),
    sourceRoot: dataRoot,
    source: { kind: 'library', id: 'source' },
    captureRoots: ['skills'],
    persist
  })
  assert.throws(() => linked.observe(), /symlink|reparse point/)
})
