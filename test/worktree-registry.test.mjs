import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  createHubApplication,
  createMemoryApplicationTransactions,
  createMemoryRequestLedger,
  createMemorySessions
} from '../dist/application/index.js'
import { createHub } from '../dist/adapters/create-hub.js'
import { createLocalApplicationPorts } from '../dist/adapters/local-application-ports.js'
import { CONTRACT_VERSION } from '../dist/contracts/index.js'
import { hubRoot as packageRoot } from './helpers.mjs'

const git = (cwd, args) => execFileSync('git', args, {
  cwd,
  encoding: 'utf8',
  env: {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1'
  },
  stdio: ['ignore', 'pipe', 'pipe']
}).trim()

function initializeRepository(directory) {
  fs.mkdirSync(directory, { recursive: true })
  git(directory, ['init'])
  git(directory, ['config', 'user.name', 'Skill Graft Test'])
  git(directory, ['config', 'user.email', 'skill-graft-test@example.invalid'])
  fs.writeFileSync(path.join(directory, 'README.md'), '# probe\n', 'utf8')
  git(directory, ['add', 'README.md'])
  git(directory, ['commit', '-m', 'probe'])
}

function command(application, kind, requestId, input = {}) {
  return application.execute({
    kind,
    meta: {
      contractVersion: CONTRACT_VERSION,
      requestId,
      hostId: 'local-focused-test',
      transport: 'focused-test'
    },
    ...input
  })
}

function assertInvalid(result, pattern) {
  assert.equal(result.ok, false, JSON.stringify(result))
  assert.equal(result.error.code, 'INVALID_ARGUMENT')
  assert.match(result.error.message, pattern)
}

test('registerWorktree persists only one exact Git root, replays safely, and powers list plus attach', async (t) => {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-worktree-registry-'))
  t.after(() => fs.rmSync(runRoot, { recursive: true, force: true }))

  const dataRoot = path.join(runRoot, 'data')
  const scanRoot = path.join(runRoot, 'scan')
  const selected = path.join(scanRoot, 'selected')
  const sibling = path.join(runRoot, 'sibling')
  const nonGit = path.join(runRoot, 'not-a-repository')
  const ordinaryFile = path.join(runRoot, 'ordinary-file.txt')
  const selectedSubdirectory = path.join(selected, 'nested')

  initializeRepository(dataRoot)
  initializeRepository(selected)
  git(selected, ['worktree', 'add', '-b', 'sibling-probe', sibling])
  fs.mkdirSync(nonGit, { recursive: true })
  fs.mkdirSync(selectedSubdirectory, { recursive: true })
  fs.writeFileSync(ordinaryFile, 'not a directory\n', 'utf8')

  const overlayRoot = path.join(dataRoot, 'overlay')
  fs.mkdirSync(overlayRoot, { recursive: true })
  const scanRootsFile = path.join(overlayRoot, 'scan-roots.txt')
  const initialScanRoots = '# intentionally empty\n'
  fs.writeFileSync(scanRootsFile, initialScanRoots, 'utf8')
  fs.writeFileSync(path.join(overlayRoot, 'checkout-rules.txt'), '', 'utf8')

  const sessions = createMemorySessions()
  const context = createHub(dataRoot)
  const application = createHubApplication({
    ...createLocalApplicationPorts(context, { packageRoot }),
    sessions,
    ledger: createMemoryRequestLedger(),
    p2: {
      identities: {
        resolve(worktree) {
          const canonical = context.fs.realpath(context.path.resolve(worktree)) || context.path.resolve(worktree)
          const digest = context.hash.sha256(context.path.comparisonKey(canonical))
          return { pathKey: `sha256:${digest}`, worktreeId: `worktree:${digest.slice(0, 24)}` }
        }
      },
      snapshots: {
        observe: () => ({ captureId: 'unused', source: { kind: 'library', id: 'unused', revision: 'unused' }, files: [] }),
        store: () => { throw new Error('snapshot store is unused') },
        list: () => [],
        read: () => null
      },
      state: {
        readDocument: () => null,
        writeV2: () => { throw new Error('state write is unused') },
        runtimeRevision: () => 'focused-registry-test',
        observeV1Worktrees: () => []
      }
    },
    transactions: createMemoryApplicationTransactions()
  })
  const canonicalSelected = fs.realpathSync(selected)
  const canonicalSibling = fs.realpathSync(sibling)

  const registered = await command(application, 'registerWorktree', 'register-selected', {
    worktree: selected
  })
  assert.equal(registered.ok, true, JSON.stringify(registered))
  assert.equal(registered.data.action, 'registerWorktree')
  assert.equal(registered.data.worktree, canonicalSelected)
  assert.equal(registered.data.changed, true)
  assert.deepEqual(registered.data.scanRoots, [])
  assert.deepEqual(registered.data.worktrees.map((entry) => entry.path), [canonicalSelected])
  assert.ok(!registered.data.worktrees.some((entry) => entry.path === canonicalSibling))
  assert.equal(fs.readFileSync(scanRootsFile, 'utf8'), initialScanRoots)
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(dataRoot, 'skill-review', 'worktree-registry.json'), 'utf8')),
    { schemaVersion: 1, worktrees: [canonicalSelected] }
  )

  const replay = await command(application, 'registerWorktree', 'register-selected', {
    worktree: selected
  })
  assert.equal(replay.ok, true)
  assert.equal(replay.meta.replayed, true)
  assert.equal(replay.data.changed, true)

  const duplicate = await command(application, 'registerWorktree', 'register-selected-again', {
    worktree: selected
  })
  assert.equal(duplicate.ok, true)
  assert.equal(duplicate.meta.replayed, false)
  assert.equal(duplicate.data.changed, false)
  assert.deepEqual(duplicate.data.worktrees.map((entry) => entry.path), [canonicalSelected])

  const listed = await command(application, 'listWorktrees', 'list-registered')
  assert.equal(listed.ok, true)
  assert.deepEqual(listed.data.scanRoots, [])
  assert.deepEqual(listed.data.worktrees.map((entry) => entry.path), [canonicalSelected])

  const attached = await command(application, 'attach', 'attach-registered', {
    worktree: selected,
    runner: { start: false }
  })
  assert.equal(attached.ok, true, JSON.stringify(attached))
  assert.equal(attached.data.session.status, 'queued')
  assert.equal(sessions.calls.start, 1)

  for (const [requestId, worktree, message] of [
    ['reject-relative', 'relative-worktree', /absolute/],
    ['reject-file', ordinaryFile, /directory/],
    ['reject-subdirectory', selectedSubdirectory, /exact Git worktree root/],
    ['reject-non-git', nonGit, /not a Git worktree/],
    ['reject-hub-root', dataRoot, /Hub data root/]
  ]) {
    assertInvalid(await command(application, 'registerWorktree', requestId, { worktree }), message)
  }
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(dataRoot, 'skill-review', 'worktree-registry.json'), 'utf8')).worktrees,
    [canonicalSelected]
  )

  // A pre-existing scan-root remains authoritative when it overlaps an exact
  // registration; the exact registry must not disable legacy clone expansion.
  fs.writeFileSync(scanRootsFile, `${scanRoot}\n`, 'utf8')
  const overlapped = await command(application, 'listWorktrees', 'list-overlapped-scan-root')
  assert.equal(overlapped.ok, true)
  assert.deepEqual(overlapped.data.scanRoots, [scanRoot])
  assert.ok(overlapped.data.worktrees.some((entry) => entry.path === canonicalSelected))
  assert.ok(overlapped.data.worktrees.some((entry) => entry.path === canonicalSibling))
})
