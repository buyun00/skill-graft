import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  APPLICATION_LEASE_NAMESPACE_MARKER,
  applicationLeaseRoot,
  assertApplicationLeaseNamespaceSafe,
  createLeaseLockManager
} from '../dist/adapters/lease-lock.js'

function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-p4-gate-'))
  const dataRoot = path.join(parent, 'data')
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
  return { parent, dataRoot, leaseRoot: applicationLeaseRoot(dataRoot) }
}

function inspector(label, probe = 'dead') {
  return {
    async currentIdentity(pid) { return `test:${label}:${pid}` },
    async probe() { return probe }
  }
}

function identity(requestId) {
  return {
    scope: 'hub-global',
    key: 'hub-global',
    hostId: 'p4-gate-test',
    commandKind: 'migrateState',
    requestId
  }
}

function worktreeIdentity(requestId, digit = '1') {
  return {
    scope: 'worktree',
    key: `sha256:${digit.repeat(64)}`,
    hostId: 'p4-gate-worktree',
    commandKind: 'ingest',
    requestId
  }
}

test('external application namespace is locator-free, persistent, and outside dataRoot', async (t) => {
  const { parent, dataRoot, leaseRoot } = fixture(t)
  assert.equal(path.dirname(leaseRoot), parent)
  assert.notEqual(leaseRoot, dataRoot)
  assert.equal(fs.existsSync(dataRoot), false)
  assert.equal(fs.existsSync(leaseRoot), false)

  const manager = createLeaseLockManager({
    root: leaseRoot,
    leaseMs: 10_000,
    token: () => 'aaaaaaaaaaaaaaaa',
    processInspector: inspector('fresh')
  })
  const acquired = await manager.acquire(identity('fresh'))
  assert.equal(acquired.status, 'acquired')
  assert.equal(fs.existsSync(dataRoot), false)
  assert.deepEqual(fs.readdirSync(leaseRoot).sort(), [APPLICATION_LEASE_NAMESPACE_MARKER, 'leases'].sort())
  const markerText = fs.readFileSync(path.join(leaseRoot, APPLICATION_LEASE_NAMESPACE_MARKER), 'utf8')
  assert.doesNotMatch(markerText, /skill-graft-p4-gate|[A-Z]:\\/i)
  await acquired.lease.release()
  assert.deepEqual(fs.readdirSync(path.join(leaseRoot, 'leases')), [])
  assertApplicationLeaseNamespaceSafe(leaseRoot)
})

test('reserved empty namespace is adoptable while unmarked foreign bytes and wrong markers are zero-write refusals', async (t) => {
  await t.test('empty reservation', async (t) => {
    const { leaseRoot } = fixture(t)
    fs.mkdirSync(leaseRoot)
    const manager = createLeaseLockManager({
      root: leaseRoot,
      leaseMs: 10_000,
      token: () => 'bbbbbbbbbbbbbbbb',
      processInspector: inspector('empty')
    })
    const acquired = await manager.acquire(identity('empty'))
    assert.equal(acquired.status, 'acquired')
    await acquired.lease.release()
  })

  await t.test('foreign bytes', async (t) => {
    const { leaseRoot } = fixture(t)
    fs.mkdirSync(leaseRoot)
    const foreign = path.join(leaseRoot, 'foreign.bin')
    fs.writeFileSync(foreign, Buffer.from([1, 2, 3, 4]))
    const before = fs.readFileSync(foreign)
    assert.throws(() => createLeaseLockManager({
      root: leaseRoot,
      leaseMs: 10_000,
      processInspector: inspector('foreign')
    }), /foreign top-level artifact/)
    assert.deepEqual(fs.readFileSync(foreign), before)
    assert.deepEqual(fs.readdirSync(leaseRoot), ['foreign.bin'])
  })

  await t.test('wrong marker', async (t) => {
    const { leaseRoot } = fixture(t)
    fs.mkdirSync(leaseRoot)
    const marker = path.join(leaseRoot, APPLICATION_LEASE_NAMESPACE_MARKER)
    const bytes = Buffer.from('{"format":"foreign"}\n')
    fs.writeFileSync(marker, bytes)
    assert.throws(() => createLeaseLockManager({
      root: leaseRoot,
      leaseMs: 10_000,
      processInspector: inspector('wrong-marker')
    }), /invalid schema|inconsistent/)
    assert.deepEqual(fs.readFileSync(marker), bytes)
    assert.deepEqual(fs.readdirSync(leaseRoot), [APPLICATION_LEASE_NAMESPACE_MARKER])
  })
})

test('every namespace bootstrap cut converges on immediate retry without deleting foreign siblings', async (t) => {
  for (const [index, checkpoint] of [
    'lease-namespace-after-root-reservation',
    'lease-namespace-after-marker-write',
    'lease-namespace-after-marker-publication',
    'lease-namespace-after-container-create'
  ].entries()) {
    await t.test(checkpoint, async (t) => {
      const { parent, leaseRoot } = fixture(t)
      const sibling = path.join(parent, `foreign-${index}.bin`)
      fs.writeFileSync(sibling, `foreign-${index}\n`)
      let injected = false
      const crashing = createLeaseLockManager({
        root: leaseRoot,
        leaseMs: 10_000,
        token: () => `ccccccccccccccc${index}`,
        processInspector: inspector(`cut-${index}`),
        fault(name) {
          if (!injected && name === checkpoint) {
            injected = true
            throw new Error(`cut:${checkpoint}`)
          }
        }
      })
      await assert.rejects(crashing.acquire(identity(`cut-${index}`)), new RegExp(`cut:${checkpoint}`))
      assert.equal(injected, true)
      assert.equal(fs.readFileSync(sibling, 'utf8'), `foreign-${index}\n`)

      const retry = createLeaseLockManager({
        root: leaseRoot,
        leaseMs: 10_000,
        token: () => `ddddddddddddddd${index}`,
        processInspector: inspector(`retry-${index}`)
      })
      const acquired = await retry.acquire(identity(`retry-${index}`))
      assert.equal(acquired.status, 'acquired')
      await acquired.lease.release()
      assert.deepEqual(fs.readdirSync(path.join(leaseRoot, 'leases')), [])
      assert.deepEqual(
        fs.readdirSync(leaseRoot).sort(),
        [APPLICATION_LEASE_NAMESPACE_MARKER, 'leases'].sort()
      )
      assert.equal(fs.readFileSync(sibling, 'utf8'), `foreign-${index}\n`)
    })
  }
})

test('two first writers publish one namespace marker and one hub-global winner', async (t) => {
  const { leaseRoot } = fixture(t)
  const left = createLeaseLockManager({
    root: leaseRoot,
    leaseMs: 10_000,
    token: () => 'eeeeeeeeeeeeeeee',
    processInspector: inspector('left')
  })
  const right = createLeaseLockManager({
    root: leaseRoot,
    leaseMs: 10_000,
    token: () => 'ffffffffffffffff',
    processInspector: inspector('right')
  })
  const results = await Promise.all([left.acquire(identity('left')), right.acquire(identity('right'))])
  assert.equal(results.filter((result) => result.status === 'acquired').length, 1)
  assert.equal(results.filter((result) => result.status === 'busy').length, 1)
  const winner = results.find((result) => result.status === 'acquired')
  await winner.lease.release()
  assert.deepEqual(fs.readdirSync(path.join(leaseRoot, 'leases')), [])
  assert.deepEqual(fs.readdirSync(leaseRoot).sort(), [APPLICATION_LEASE_NAMESPACE_MARKER, 'leases'].sort())
})

test('a newly injected incomplete bootstrap blocks publication and is never deleted by the writer', async (t) => {
  const { leaseRoot } = fixture(t)
  const injectedName = '.namespace-bootstrap-injectedpending1.pending.json'
  const injectedBytes = Buffer.from('{"format":"foreign-prefix"')
  let injected = false
  const manager = createLeaseLockManager({
    root: leaseRoot,
    leaseMs: 10_000,
    token: () => 'abababababababab',
    processInspector: inspector('injected-pending'),
    fault(name) {
      if (!injected && name === 'lease-namespace-after-marker-write') {
        injected = true
        fs.writeFileSync(path.join(leaseRoot, injectedName), injectedBytes, { flag: 'wx' })
      }
    }
  })
  await assert.rejects(
    manager.acquire(identity('injected-pending')),
    /incomplete pending writer|bootstrap candidate/
  )
  assert.equal(injected, true)
  assert.equal(fs.existsSync(path.join(leaseRoot, APPLICATION_LEASE_NAMESPACE_MARKER)), false)
  assert.deepEqual(fs.readFileSync(path.join(leaseRoot, injectedName)), injectedBytes)
  assert.deepEqual(fs.readdirSync(leaseRoot), [injectedName])
})

test('a data-root reparse introduced during process inspection is rejected before namespace writes', async (t) => {
  const { parent, dataRoot, leaseRoot } = fixture(t)
  const target = path.join(parent, 'protected-target')
  fs.mkdirSync(target)
  fs.writeFileSync(path.join(target, 'sentinel.bin'), 'protected\n')
  let enterInspection
  const inspected = new Promise((resolve) => { enterInspection = resolve })
  let resumeInspection
  const resume = new Promise((resolve) => { resumeInspection = resolve })
  const manager = createLeaseLockManager({
    root: leaseRoot,
    leaseMs: 10_000,
    token: () => 'cdcdcdcdcdcdcdcd',
    preflightRoot() {
      const rebound = applicationLeaseRoot(dataRoot)
      if (rebound !== leaseRoot) throw new Error('data root lease binding changed')
    },
    processInspector: {
      async currentIdentity(pid) {
        enterInspection()
        await resume
        return `test:reparse:${pid}`
      },
      async probe() { return 'dead' }
    }
  })
  const acquiring = manager.acquire(identity('reparse-during-inspection'))
  await inspected
  try {
    fs.symlinkSync(target, dataRoot, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    resumeInspection()
    await acquiring.catch(() => {})
    t.skip(`reparse creation unavailable: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  resumeInspection()
  await assert.rejects(acquiring, /reparse|crosses|binding/)
  assert.equal(fs.existsSync(leaseRoot), false)
  assert.equal(fs.readFileSync(path.join(target, 'sentinel.bin'), 'utf8'), 'protected\n')
  assert.deepEqual(fs.readdirSync(target), ['sentinel.bin'])
})

test('an exact retirement-claim hard-link cut is collapsed before normal sweep readers', async (t) => {
  const { leaseRoot } = fixture(t)
  const seed = createLeaseLockManager({
    root: leaseRoot,
    leaseMs: 10_000,
    token: () => 'dededededededede',
    processInspector: inspector('claim-pair-seed')
  })
  const seeded = await seed.acquire(identity('claim-pair-seed'))
  assert.equal(seeded.status, 'acquired')
  await seeded.lease.release()

  const ownerHash = createHash('sha256').update('orphan-owner-token').digest('hex')
  const claim = {
    format: 'skill-graft.lease-retire-claim/v1',
    scope: 'hub-global',
    lockKey: 'hub-global',
    ownerHash: `sha256:${ownerHash}`,
    actorPid: 9911,
    actorProcessIdentity: 'test:dead-claim-publisher',
    createdAt: new Date(0).toISOString()
  }
  const leasesRoot = path.join(leaseRoot, 'leases')
  const temporary = path.join(leasesRoot, '.retire-claim-cutcutcutcutcut1.tmp')
  const published = path.join(leasesRoot, `.retire-hub-global.lock-${ownerHash}.claim.json`)
  fs.writeFileSync(temporary, `${JSON.stringify(claim, null, 2)}\n`, { flag: 'wx' })
  fs.linkSync(temporary, published)
  assert.equal(fs.statSync(temporary).nlink, 2)

  const recovering = createLeaseLockManager({
    root: leaseRoot,
    leaseMs: 10_000,
    token: () => 'efefefefefefefef',
    processInspector: inspector('claim-pair-recovery', 'dead')
  })
  const acquired = await recovering.acquire(identity('claim-pair-recovery'))
  assert.equal(acquired.status, 'acquired')
  assert.equal(fs.existsSync(temporary), false)
  assert.equal(fs.existsSync(published), false)
  await acquired.lease.release()
})

test('orphan reaping renews hub authority after slow identity and process probes or aborts before retirement', async (t) => {
  for (const slowBoundary of ['currentIdentity', 'probe']) {
    await t.test(slowBoundary, async (t) => {
      const { leaseRoot } = fixture(t)
      let clock = 0
      const stalePid = slowBoundary === 'currentIdentity' ? 9801 : 9802
      const hubPid = slowBoundary === 'currentIdentity' ? 9811 : 9812
      let entered
      const boundaryEntered = new Promise((resolve) => { entered = resolve })
      let resume
      const boundaryResume = new Promise((resolve) => { resume = resolve })
      let hubIdentityCalls = 0
      let probeBlocked = false

      const staleManager = createLeaseLockManager({
        root: leaseRoot,
        leaseMs: 100,
        now: () => clock,
        pid: stalePid,
        token: () => slowBoundary === 'currentIdentity' ? 'staleidentity001' : 'staleprobe000001',
        processInspector: inspector(`stale-${slowBoundary}`)
      })
      const stale = await staleManager.acquire(worktreeIdentity(`stale-${slowBoundary}`, slowBoundary === 'currentIdentity' ? '2' : '3'))
      assert.equal(stale.status, 'acquired')
      const staleOwnerFile = path.join(
        leaseRoot,
        'leases',
        `worktree-${(slowBoundary === 'currentIdentity' ? '2' : '3').repeat(64)}.lock`,
        'owner.json'
      )
      const staleOwnerBefore = fs.readFileSync(staleOwnerFile)

      clock = 101
      const hubManager = createLeaseLockManager({
        root: leaseRoot,
        leaseMs: 100,
        now: () => clock,
        pid: hubPid,
        token: () => slowBoundary === 'currentIdentity' ? 'hubidentity00001' : 'hubprobe00000001',
        processInspector: {
          async currentIdentity(pid) {
            hubIdentityCalls += 1
            if (slowBoundary === 'currentIdentity' && hubIdentityCalls === 2) {
              entered()
              await boundaryResume
            }
            return `test:hub-${slowBoundary}:${pid}`
          },
          async probe(pid) {
            if (slowBoundary === 'probe' && pid === stalePid && !probeBlocked) {
              probeBlocked = true
              entered()
              await boundaryResume
            }
            return pid === stalePid ? 'dead' : 'alive-owner'
          }
        }
      })
      const hub = await hubManager.acquire(identity(`hub-${slowBoundary}`))
      assert.equal(hub.status, 'acquired')
      clock = 150
      const reaping = hubManager.reapOrphanedWorktreeLeases(
        hub.lease.ownerToken,
        () => hub.lease.renew()
      )
      await boundaryEntered
      clock = 251

      const contender = createLeaseLockManager({
        root: leaseRoot,
        leaseMs: 100,
        now: () => clock,
        pid: hubPid + 100,
        token: () => slowBoundary === 'currentIdentity' ? 'contendidentity1' : 'contendprobe0001',
        processInspector: inspector(`contender-${slowBoundary}`, 'alive-owner')
      })
      const blocked = await contender.acquire(identity(`contender-${slowBoundary}`))
      assert.equal(blocked.status, 'busy')
      assert.equal(blocked.reason, 'owner-alive')
      resume()
      await assert.rejects(reaping, /expired|changed|live owned hub-global lease/)
      assert.deepEqual(fs.readFileSync(staleOwnerFile), staleOwnerBefore)

      await hub.lease.release()
      await stale.lease.release()
      assert.deepEqual(fs.readdirSync(path.join(leaseRoot, 'leases')), [])
    })
  }
})

test('leaf and parent reparses injected at renew and retire mutation cuts never reach the protected target', async (t) => {
  for (const swapKind of ['leaf', 'parent']) {
    for (const faultName of ['lease-after-renew-temporary', 'lease-after-retire-claim-link']) {
      await t.test(`${swapKind}:${faultName}`, async (t) => {
        const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-p4-reparse-cut-'))
        t.after(() => fs.rmSync(outer, { recursive: true, force: true }))
        const plainParent = path.join(outer, 'plain')
        const dataRoot = path.join(plainParent, 'data')
        const protectedTarget = path.join(outer, 'protected')
        const sentinel = path.join(protectedTarget, 'sentinel.bin')
        fs.mkdirSync(dataRoot, { recursive: true })
        fs.mkdirSync(protectedTarget)
        fs.writeFileSync(sentinel, 'protected\n')
        const leaseRoot = applicationLeaseRoot(dataRoot)
        const saved = path.join(outer, swapKind === 'leaf' ? 'saved-data' : 'saved-plain')
        const swapPath = swapKind === 'leaf' ? dataRoot : plainParent
        let swapped = false

        const manager = createLeaseLockManager({
          root: leaseRoot,
          leaseMs: 10_000,
          token: () => swapKind === 'leaf' ? 'reparseleaf00001' : 'reparseparent001',
          preflightRoot() {
            const rebound = applicationLeaseRoot(dataRoot)
            if (rebound !== leaseRoot) throw new Error('data root lease binding changed')
          },
          processInspector: inspector(`reparse-${swapKind}-${faultName}`),
          fault(name) {
            if (swapped || name !== faultName) return
            fs.renameSync(swapPath, saved)
            fs.symlinkSync(protectedTarget, swapPath, process.platform === 'win32' ? 'junction' : 'dir')
            swapped = true
          }
        })
        const acquired = await manager.acquire(identity(`reparse-${swapKind}-${faultName}`))
        assert.equal(acquired.status, 'acquired')

        const operation = faultName === 'lease-after-renew-temporary'
          ? acquired.lease.renew()
          : acquired.lease.release()
        try {
          await assert.rejects(operation, /reparse|crosses|binding/)
        } catch (error) {
          if (!swapped) {
            t.skip(`reparse creation unavailable: ${error instanceof Error ? error.message : String(error)}`)
            return
          }
          throw error
        }
        assert.equal(swapped, true)
        assert.equal(fs.readFileSync(sentinel, 'utf8'), 'protected\n')
        assert.deepEqual(fs.readdirSync(protectedTarget), ['sentinel.bin'])

        fs.unlinkSync(swapPath)
        fs.renameSync(saved, swapPath)
        if (faultName === 'lease-after-retire-claim-link') {
          const sweeper = createLeaseLockManager({
            root: leaseRoot,
            leaseMs: 10_000,
            token: () => swapKind === 'leaf' ? 'sweepleaf0000001' : 'sweepparent00001',
            preflightRoot() {
              const rebound = applicationLeaseRoot(dataRoot)
              if (rebound !== leaseRoot) throw new Error('data root lease binding changed')
            },
            processInspector: inspector(`reparse-sweep-${swapKind}`, 'alive-owner')
          })
          const blocked = await sweeper.acquire(identity(`reparse-sweep-${swapKind}`))
          assert.equal(blocked.status, 'busy')
        }
        await acquired.lease.release()
        assert.deepEqual(fs.readdirSync(path.join(leaseRoot, 'leases')), [])
      })
    }
  }
})

test('post-publication acquire and renew now-callback swaps reject and retain exact cleanup proof', async (t) => {
  for (const operationKind of ['acquire-return', 'renew-return']) {
    for (const swapKind of ['leaf', 'parent']) {
      await t.test(`${operationKind}:${swapKind}`, async (t) => {
        const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-p4-return-swap-'))
        t.after(() => fs.rmSync(outer, { recursive: true, force: true }))
        const plainParent = path.join(outer, 'plain')
        const dataRoot = path.join(plainParent, 'data')
        const protectedTarget = path.join(outer, 'protected')
        const sentinel = path.join(protectedTarget, 'sentinel.bin')
        fs.mkdirSync(dataRoot, { recursive: true })
        fs.mkdirSync(protectedTarget)
        fs.writeFileSync(sentinel, 'protected\n')
        const leaseRoot = applicationLeaseRoot(dataRoot)
        const saved = path.join(outer, swapKind === 'leaf' ? 'saved-data' : 'saved-plain')
        const swapPath = swapKind === 'leaf' ? dataRoot : plainParent
        let armed = false
        let swapped = false
        const swap = () => {
          fs.renameSync(swapPath, saved)
          fs.symlinkSync(protectedTarget, swapPath, process.platform === 'win32' ? 'junction' : 'dir')
          swapped = true
        }

        const manager = createLeaseLockManager({
          root: leaseRoot,
          leaseMs: 10_000,
          token: () => operationKind === 'acquire-return'
            ? swapKind === 'leaf' ? 'acqreturnleaf001' : 'acqreturnparent1'
            : swapKind === 'leaf' ? 'renewreturnleaf1' : 'renewreturnpar01',
          now() {
            if (armed && !swapped) swap()
            return Date.now()
          },
          checkpoint(name) {
            if (operationKind === 'acquire-return' && name === 'lease-acquired') armed = true
            if (operationKind === 'renew-return' && name === 'lease-renewed') armed = true
          },
          preflightRoot() {
            const rebound = applicationLeaseRoot(dataRoot)
            if (rebound !== leaseRoot) throw new Error('data root lease binding changed')
          },
          processInspector: inspector(`return-swap-${operationKind}-${swapKind}`)
        })

        let acquired
        if (operationKind === 'acquire-return') {
          await assert.rejects(manager.acquire(identity(`${operationKind}-${swapKind}`)), /reparse|crosses|binding/)
        } else {
          acquired = await manager.acquire(identity(`${operationKind}-${swapKind}`))
          assert.equal(acquired.status, 'acquired')
          await assert.rejects(acquired.lease.renew(), /reparse|crosses|binding/)
        }
        assert.equal(swapped, true)
        assert.equal(fs.readFileSync(sentinel, 'utf8'), 'protected\n')
        assert.deepEqual(fs.readdirSync(protectedTarget), ['sentinel.bin'])

        fs.unlinkSync(swapPath)
        fs.renameSync(saved, swapPath)
        if (operationKind === 'acquire-return') {
          const retry = await manager.acquire(identity(`${operationKind}-${swapKind}-retry`))
          assert.equal(retry.status, 'acquired')
          await retry.lease.release()
        } else {
          await acquired.lease.release()
        }
        assert.deepEqual(fs.readdirSync(path.join(leaseRoot, 'leases')), [])
      })
    }
  }
})

test('case-only aliases share the same Windows application namespace on a plain path', { skip: process.platform !== 'win32' }, (t) => {
  const { dataRoot } = fixture(t)
  fs.mkdirSync(dataRoot)
  assert.equal(
    applicationLeaseRoot(dataRoot, 'win32').toLowerCase(),
    applicationLeaseRoot(dataRoot.toUpperCase(), 'win32').toLowerCase()
  )
})
