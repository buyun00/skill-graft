import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const outputRoot = path.resolve(process.env.SKILL_GRAFT_TEST_DIST || 'dist')
const leaseModuleUrl = pathToFileURL(path.join(outputRoot, 'adapters', 'lease-lock.js')).href
const leases = await import(leaseModuleUrl)

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-lease-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function identity(requestId, hostId = 'lease-test-host') {
  return {
    scope: 'hub-global',
    key: 'hub-global',
    hostId,
    commandKind: 'ingest',
    requestId
  }
}

function fakeInspector(label, status = () => 'alive-owner') {
  return {
    async currentIdentity(pid) { return `test:${label}:${pid}` },
    async probe(pid, expected) { return status(pid, expected) }
  }
}

function lockEntries(root) {
  const directory = path.join(root, 'leases')
  return fs.existsSync(directory) ? fs.readdirSync(directory) : []
}

function acquisitionStaging(root, token) {
  return path.join(root, 'leases', `.acquire-hub-global.lock-${token}.tmp`)
}

function stagingOwner(token, overrides = {}) {
  const acquiredAt = new Date().toISOString()
  return {
    schemaVersion: 1,
    scope: 'hub-global',
    lockKey: 'hub-global',
    ownerToken: token,
    hostId: 'staging-test-host',
    pid: process.pid,
    processIdentity: `test:staging:${process.pid}`,
    command: 'ingest',
    requestId: 'staging-test',
    acquiredAt,
    heartbeatAt: acquiredAt,
    leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    ...overrides
  }
}

async function waitUntil(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

test('expired leases reclaim only a confirmed dead owner; alive, reused, and unknown fail closed', async (t) => {
  const root = fixture(t)
  let clock = 1_000
  const owner = leases.createLeaseLockManager({
    root,
    leaseMs: 100,
    now: () => clock,
    pid: 101,
    token: () => 'aaaaaaaaaaaaaaaa',
    processInspector: fakeInspector('owner')
  })
  const acquired = await owner.acquire(identity('owner', 'owner-host'))
  assert.equal(acquired.status, 'acquired')
  clock += 101

  let probeStatus = 'alive-owner'
  const contender = leases.createLeaseLockManager({
    root,
    leaseMs: 100,
    now: () => clock,
    pid: 202,
    token: () => 'bbbbbbbbbbbbbbbb',
    processInspector: fakeInspector('contender', () => probeStatus)
  })
  for (const expected of ['owner-alive', 'pid-reused-fail-closed', 'owner-unknown-fail-closed']) {
    probeStatus = expected === 'owner-alive'
      ? 'alive-owner'
      : expected === 'pid-reused-fail-closed' ? 'pid-reused' : 'unknown'
    const blocked = await contender.acquire(identity(`blocked-${probeStatus}`, 'contender-host'))
    assert.equal(blocked.status, 'busy')
    assert.equal(blocked.reason, expected)
  }

  probeStatus = 'dead'
  const reclaimed = await contender.acquire(identity('reclaimed', 'contender-host'))
  assert.equal(reclaimed.status, 'acquired')
  const ownerRecord = JSON.parse(fs.readFileSync(path.join(root, 'leases', 'hub-global.lock', 'owner.json'), 'utf8'))
  assert.equal(ownerRecord.lockKey, 'hub-global')
  assert.equal(Object.values(ownerRecord).some((value) => typeof value === 'string' && value.includes(root)), false)
  assert.ok(fs.statSync(path.join(root, 'leases', 'hub-global.lock', 'owner.json')).size < 64 * 1024)
  await reclaimed.lease.release()
  assert.deepEqual(lockEntries(root), [])
})

test('a post-rename acquisition fault returns the exact owned lease, not a false failure', async (t) => {
  const root = fixture(t)
  const observedFaults = []
  const manager = leases.createLeaseLockManager({
    root,
    leaseMs: 1_000,
    pid: 303,
    token: () => 'cccccccccccccccc',
    processInspector: fakeInspector('fsync'),
    fault(name) {
      if (name === 'lease-after-live-rename' || name === 'lease-after-live-directory-flush') {
        observedFaults.push(name)
        throw new Error(`simulated-post-rename-failure:${name}`)
      }
    },
    checkpoint(name) {
      if (name === 'lease-acquired') throw new Error('simulated-post-rename-readback-failure')
    }
  })
  const acquired = await manager.acquire(identity('fsync'))
  assert.equal(acquired.status, 'acquired')
  assert.deepEqual(observedFaults, ['lease-after-live-rename', 'lease-after-live-directory-flush'])
  await acquired.lease.release()
  assert.deepEqual(lockEntries(root), [])
})

test('acquisition retries instead of returning a lease that expires around publication', async (t) => {
  async function runScenario(label, expireBeforeRename) {
    const root = fixture(t)
    let clock = 0
    let nowCalls = 0
    let advancedAfterRename = false
    const manager = leases.createLeaseLockManager({
      root,
      leaseMs: 100,
      now() {
        nowCalls += 1
        if (expireBeforeRename && nowCalls === 2) clock = 101
        return clock
      },
      pid: expireBeforeRename ? 305 : 306,
      token: () => expireBeforeRename ? '5656565656565656' : '7878787878787878',
      processInspector: fakeInspector(`publish-expiry-${label}`),
      fault(name) {
        if (!expireBeforeRename && !advancedAfterRename && name === 'lease-after-live-rename') {
          advancedAfterRename = true
          clock = 101
        }
      }
    })
    const acquired = await manager.acquire(identity(`publish-expiry-${label}`))
    assert.equal(acquired.status, 'acquired')
    const record = JSON.parse(
      fs.readFileSync(path.join(root, 'leases', 'hub-global.lock', 'owner.json'), 'utf8')
    )
    assert.equal(Date.parse(record.acquiredAt), 101)
    assert.equal(Date.parse(record.leaseUntil), 201)
    await acquired.lease.release()
    assert.deepEqual(lockEntries(root), [])
  }

  await runScenario('before', true)
  await runScenario('after', false)
})

test('a post-link retirement-claim fault preserves and consumes the exact claim', async (t) => {
  const root = fixture(t)
  let injected = false
  const manager = leases.createLeaseLockManager({
    root,
    leaseMs: 1_000,
    pid: 304,
    token: () => '3434343434343434',
    processInspector: fakeInspector('claim-fsync'),
    fault(name) {
      if (!injected && name === 'lease-after-retire-claim-link') {
        injected = true
        throw new Error('simulated-claim-directory-fsync-failure')
      }
    }
  })
  const acquired = await manager.acquire(identity('claim-fsync'))
  assert.equal(acquired.status, 'acquired')
  await acquired.lease.release()
  assert.deepEqual(lockEntries(root), [])
})

test('claim readback and acquisition-staging cleanup failures retain exact background cleanup', async (t) => {
  const claimRoot = fixture(t)
  let afterLinkFaults = 0
  let readbackFaults = 0
  let pendingFaults = 0
  const claimManager = leases.createLeaseLockManager({
    root: claimRoot,
    leaseMs: 1_000,
    pid: 308,
    token: () => '8989898989898989',
    processInspector: fakeInspector('claim-readback'),
    fault(name) {
      if (name === 'lease-after-retire-claim-link' && afterLinkFaults++ === 0) {
        throw new Error('claim-linked-before-readback')
      }
      if (name === 'lease-before-retire-claim-readback' && readbackFaults++ === 0) {
        throw new Error('claim-readback-unavailable')
      }
      if (name === 'lease-before-pending-cleanup' && pendingFaults++ < 3) {
        throw new Error('claim-cleanup-temporarily-unavailable')
      }
    }
  })
  const claimed = await claimManager.acquire(identity('claim-readback'))
  assert.equal(claimed.status, 'acquired')
  await assert.rejects(claimed.lease.release(), /claim-|cleanup-/)
  await waitUntil(() => lockEntries(claimRoot).length === 0)
  assert.equal(afterLinkFaults >= 1, true)
  assert.equal(readbackFaults >= 1, true)

  const stagingRoot = fixture(t)
  let clock = 0
  let nowCalls = 0
  let stagingFault = true
  const stagingManager = leases.createLeaseLockManager({
    root: stagingRoot,
    leaseMs: 100,
    now() {
      nowCalls += 1
      if (nowCalls === 2) clock = 101
      return clock
    },
    pid: 309,
    token: () => '9090909090909090',
    processInspector: fakeInspector('staging-cleanup'),
    fault(name) {
      if (stagingFault && name === 'lease-before-acquire-staging-cleanup') {
        stagingFault = false
        throw new Error('staging-cleanup-unavailable')
      }
    }
  })
  await assert.rejects(
    stagingManager.acquire(identity('staging-cleanup-fault')),
    /staging-cleanup-unavailable/
  )
  await waitUntil(() => lockEntries(stagingRoot).length === 0)
  const retried = await stagingManager.acquire(identity('staging-cleanup-retry'))
  assert.equal(retried.status, 'acquired')
  await retried.lease.release()
  assert.deepEqual(lockEntries(stagingRoot), [])
})

test('renewal rechecks the old expiry around token, temporary write, and replacement', async (t) => {
  async function runScenario(label, advanceAt) {
    const root = fixture(t)
    let clock = 0
    let tokenCalls = 0
    const tokens = [
      `${label}a`.padEnd(16, 'a'),
      `${label}b`.padEnd(16, 'b'),
      `${label}c`.padEnd(16, 'c')
    ]
    const manager = leases.createLeaseLockManager({
      root,
      leaseMs: 100,
      now: () => clock,
      pid: 350 + tokenCalls,
      token() {
        tokenCalls += 1
        if (advanceAt === 'token' && tokenCalls === 2) clock = 101
        return tokens[Math.min(tokenCalls - 1, tokens.length - 1)]
      },
      processInspector: fakeInspector(`renew-${label}`),
      fault(name) {
        if (advanceAt === 'temporary' && name === 'lease-after-renew-temporary') clock = 101
        if (advanceAt === 'replace' && name === 'lease-after-renew-replace') clock = 101
      }
    })
    const acquired = await manager.acquire(identity(`renew-${label}`))
    assert.equal(acquired.status, 'acquired')
    const before = fs.readFileSync(path.join(root, 'leases', 'hub-global.lock', 'owner.json'), 'utf8')
    clock = 50
    await assert.rejects(
      acquired.lease.renew(),
      (error) => error?.code === 'LOCK_NOT_OWNED'
    )
    if (advanceAt === 'replace') {
      assert.deepEqual(lockEntries(root), [])
    } else {
      assert.equal(
        fs.readFileSync(path.join(root, 'leases', 'hub-global.lock', 'owner.json'), 'utf8'),
        before
      )
      assert.deepEqual(
        fs.readdirSync(path.join(root, 'leases', 'hub-global.lock')).sort(),
        ['owner.json']
      )
      await acquired.lease.release()
      assert.deepEqual(lockEntries(root), [])
    }
  }

  await runScenario('token', 'token')
  await runScenario('temporary', 'temporary')
  await runScenario('replace', 'replace')
})

test('failed post-commit release cleanup is retained and retried in the background', async (t) => {
  const root = fixture(t)
  let cleanupFaults = 0
  const manager = leases.createLeaseLockManager({
    root,
    leaseMs: 1_000,
    pid: 404,
    token: () => 'dddddddddddddddd',
    processInspector: fakeInspector('cleanup'),
    fault(name) {
      if ((name === 'lease-before-retired-cleanup' || name === 'lease-before-pending-cleanup')
        && cleanupFaults < 3) {
        cleanupFaults += 1
        throw new Error('transient-release-cleanup')
      }
    }
  })
  const first = await manager.acquire(identity('first'))
  assert.equal(first.status, 'acquired')
  await assert.rejects(first.lease.release(), /transient-release-cleanup/)
  assert.ok(lockEntries(root).some((entry) => entry.startsWith('.retire-') || entry.startsWith('.retired-')))

  await waitUntil(() => lockEntries(root).length === 0)

  const second = await manager.acquire(identity('second'))
  assert.equal(second.status, 'acquired')
  await second.lease.release()
  assert.deepEqual(lockEntries(root), [])
})

test('the next acquire drains a release left after bounded background retries', async (t) => {
  const root = fixture(t)
  let failCleanup = true
  const manager = leases.createLeaseLockManager({
    root,
    leaseMs: 1_000,
    pid: 405,
    token: () => 'abababababababab',
    processInspector: fakeInspector('bounded-cleanup'),
    fault(name) {
      if (failCleanup && (name === 'lease-before-retired-cleanup'
        || name === 'lease-before-pending-cleanup')) {
        throw new Error('persistent-release-cleanup')
      }
    }
  })
  const first = await manager.acquire(identity('bounded-first'))
  assert.equal(first.status, 'acquired')
  await assert.rejects(first.lease.release(), /persistent-release-cleanup/)

  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.ok(lockEntries(root).some((entry) => entry.startsWith('.retire-') || entry.startsWith('.retired-')))
  failCleanup = false

  const second = await manager.acquire(identity('bounded-second'))
  assert.equal(second.status, 'acquired')
  await second.lease.release()
  assert.deepEqual(lockEntries(root), [])
})

test('artifact sweep rejects an unfenced retired directory and removes pid-reused staging', async (t) => {
  const orphanRoot = fixture(t)
  const orphanLeases = path.join(orphanRoot, 'leases')
  fs.mkdirSync(path.join(orphanLeases, `.retired-hub-global.lock-${'a'.repeat(64)}.tmp`), {
    recursive: true
  })
  const orphanManager = leases.createLeaseLockManager({
    root: orphanRoot,
    leaseMs: 1_000,
    pid: 406,
    token: () => 'cdcdcdcdcdcdcdcd',
    processInspector: fakeInspector('orphan')
  })
  await assert.rejects(
    orphanManager.acquire(identity('unfenced-retired')),
    /missing its fencing claim/
  )

  const stagingRoot = fixture(t)
  const staging = path.join(stagingRoot, 'leases', '.acquire-hub-global.lock-efefefefefefefef.tmp')
  fs.mkdirSync(staging, { recursive: true })
  fs.writeFileSync(path.join(staging, 'owner.json'), `${JSON.stringify({
    schemaVersion: 1,
    scope: 'hub-global',
    lockKey: 'hub-global',
    ownerToken: 'efefefefefefefef',
    hostId: 'stale-staging-host',
    pid: 999,
    processIdentity: 'test:stale:999',
    command: 'ingest',
    requestId: 'stale-staging',
    acquiredAt: '2026-01-01T00:00:00.000Z',
    heartbeatAt: '2026-01-01T00:00:00.000Z',
    leaseUntil: '2026-01-01T00:00:01.000Z'
  }, null, 2)}\n`)
  const stagingManager = leases.createLeaseLockManager({
    root: stagingRoot,
    leaseMs: 1_000,
    pid: 407,
    token: () => '1212121212121212',
    processInspector: fakeInspector('staging', () => 'pid-reused')
  })
  const acquired = await stagingManager.acquire(identity('pid-reused-staging'))
  assert.equal(acquired.status, 'acquired')
  await acquired.lease.release()
  assert.deepEqual(lockEntries(stagingRoot), [])
})

test('fresh acquisition staging tolerates only empty and incomplete writer states; stale states are removed', async (t) => {
  const shapes = [
    { label: 'empty-directory', bytes: null },
    { label: 'empty-owner', bytes: Buffer.alloc(0) },
    { label: 'partial-owner', bytes: Buffer.from('{"schemaVersion": 1,\n', 'utf8') }
  ]

  for (const [index, shape] of shapes.entries()) {
    await t.test(`fresh ${shape.label}`, async (t) => {
      const root = fixture(t)
      const token = `${index + 1}`.repeat(16)
      const staging = acquisitionStaging(root, token)
      fs.mkdirSync(staging, { recursive: true })
      if (shape.bytes !== null) fs.writeFileSync(path.join(staging, 'owner.json'), shape.bytes)
      const manager = leases.createLeaseLockManager({
        root,
        leaseMs: 10_000,
        token: () => `${index + 4}`.repeat(16),
        processInspector: fakeInspector(`fresh-${shape.label}`)
      })
      const acquired = await manager.acquire(identity(`fresh-${shape.label}`))
      assert.equal(acquired.status, 'acquired')
      await acquired.lease.release()
      assert.equal(fs.existsSync(staging), true)
      fs.rmSync(staging, { recursive: true })
      assert.deepEqual(lockEntries(root), [])
    })

    await t.test(`stale ${shape.label}`, async (t) => {
      const root = fixture(t)
      const token = `${index + 1}`.repeat(16)
      const staging = acquisitionStaging(root, token)
      fs.mkdirSync(staging, { recursive: true })
      if (shape.bytes !== null) fs.writeFileSync(path.join(staging, 'owner.json'), shape.bytes)
      const stale = new Date(Date.now() - 10_000)
      fs.utimesSync(staging, stale, stale)
      const manager = leases.createLeaseLockManager({
        root,
        leaseMs: 100,
        token: () => `${index + 7}`.repeat(16),
        processInspector: fakeInspector(`stale-${shape.label}`)
      })
      const acquired = await manager.acquire(identity(`stale-${shape.label}`))
      assert.equal(acquired.status, 'acquired')
      await acquired.lease.release()
      assert.deepEqual(lockEntries(root), [])
    })
  }
})

test('owner growth during staging read is transient only with the exact fresh same-inode facts', async (t) => {
  await t.test('fresh same-inode growth is transient', async (t) => {
    const root = fixture(t)
    const token = '4545454545454545'
    const staging = acquisitionStaging(root, token)
    const owner = path.join(staging, 'owner.json')
    fs.mkdirSync(staging, { recursive: true })
    fs.writeFileSync(owner, '')
    let injected = false
    const manager = leases.createLeaseLockManager({
      root,
      leaseMs: 10_000,
      token: () => '6767676767676767',
      processInspector: fakeInspector('growing-owner'),
      fault(name) {
        if (!injected && name === 'lease-before-acquisition-owner-read') {
          fs.appendFileSync(owner, '{"schemaVersion": 1,\n')
          injected = true
          throw new Error('simulated-owner-growth-during-read')
        }
      }
    })
    const acquired = await manager.acquire(identity('growing-owner'))
    assert.equal(injected, true)
    assert.equal(acquired.status, 'acquired')
    await acquired.lease.release()
    assert.equal(fs.existsSync(staging), true)
    fs.rmSync(staging, { recursive: true })
    assert.deepEqual(lockEntries(root), [])
  })

  const rejectedGrowth = [
    {
      label: 'non-growing owner',
      mutate() {}
    },
    {
      label: 'replacement owner inode',
      mutate({ root, owner }) {
        fs.renameSync(owner, path.join(root, 'original-owner.json'))
        fs.writeFileSync(owner, '{"schemaVersion": 1,\n')
      }
    },
    {
      label: 'replacement staging directory',
      pattern: /staging directory identity changed/,
      mutate({ root, staging, owner }) {
        fs.renameSync(staging, path.join(root, 'original-staging'))
        fs.mkdirSync(staging)
        fs.writeFileSync(owner, '{"schemaVersion": 1,\n')
      }
    },
    {
      label: 'multiply-linked owner',
      mutate({ root, owner }) {
        fs.linkSync(owner, path.join(root, 'owner-hardlink.json'))
        fs.appendFileSync(owner, '{')
      }
    },
    {
      label: 'oversized growing owner',
      mutate({ owner }) {
        fs.appendFileSync(owner, Buffer.alloc(64 * 1024 + 1, 0x20))
      }
    },
    {
      label: 'stale growing owner',
      stale: true,
      mutate({ owner }) {
        fs.appendFileSync(owner, '{')
      }
    }
  ]

  for (const scenario of rejectedGrowth) {
    await t.test(scenario.label, async (t) => {
      const root = fixture(t)
      const staging = acquisitionStaging(root, '8989898989898989')
      const owner = path.join(staging, 'owner.json')
      fs.mkdirSync(staging, { recursive: true })
      fs.writeFileSync(owner, '')
      if (scenario.stale) {
        const stale = new Date(Date.now() - 10_000)
        fs.utimesSync(staging, stale, stale)
      }
      let injected = false
      const manager = leases.createLeaseLockManager({
        root,
        leaseMs: 100,
        token: () => '9090909090909090',
        processInspector: fakeInspector(`rejected-growth-${scenario.label.replaceAll(' ', '-')}`),
        fault(name) {
          if (!injected && name === 'lease-before-acquisition-owner-read') {
            scenario.mutate({ root, staging, owner })
            injected = true
            throw new Error(`simulated-rejected-growth-${scenario.label}`)
          }
        }
      })
      await assert.rejects(
        manager.acquire(identity(`rejected-growth-${scenario.label.replaceAll(' ', '-')}`)),
        scenario.pattern || /simulated-rejected-growth/
      )
      assert.equal(injected, true)
    })
  }
})

test('fresh acquisition staging fails closed for extra, linked, malformed, oversized, and mismatched owners', async (t) => {
  async function rejectsShape(label, arrange, pattern) {
    await t.test(label, async (t) => {
      const root = fixture(t)
      const token = 'abababababababab'
      const staging = acquisitionStaging(root, token)
      fs.mkdirSync(staging, { recursive: true })
      const arranged = arrange({ root, staging, token })
      if (arranged === 'skip') {
        t.skip('creating a file symlink is not permitted on this host')
        return
      }
      const safeLabel = label.replaceAll(/[^A-Za-z0-9._-]/g, '-')
      const manager = leases.createLeaseLockManager({
        root,
        leaseMs: 10_000,
        token: () => 'cdcdcdcdcdcdcdcd',
        processInspector: fakeInspector(`invalid-${safeLabel}`)
      })
      const requestId = `invalid-${safeLabel}`
      await assert.rejects(manager.acquire(identity(requestId)), pattern)
    })
  }

  await rejectsShape('extra entry', ({ staging }) => {
    fs.writeFileSync(path.join(staging, 'owner.json'), '')
    fs.writeFileSync(path.join(staging, 'extra'), '')
  }, /staging is incomplete/)
  await rejectsShape('linked owner', ({ root, staging }) => {
    const target = path.join(root, 'external-owner.json')
    fs.writeFileSync(target, '{}')
    try {
      fs.symlinkSync(target, path.join(staging, 'owner.json'), 'file')
    } catch (error) {
      if (error?.code === 'EPERM') return 'skip'
      throw error
    }
  }, /staging is incomplete|plain file|symlink|reparse/)
  await rejectsShape('malformed owner JSON', ({ staging }) => {
    fs.writeFileSync(path.join(staging, 'owner.json'), '{bad json}', 'utf8')
  }, /owner is invalid/)
  await rejectsShape('invalid UTF-8 owner', ({ staging }) => {
    fs.writeFileSync(path.join(staging, 'owner.json'), Buffer.from([0xc3, 0x28]))
  }, /not valid UTF-8/)
  await rejectsShape('oversized owner', ({ staging }) => {
    fs.writeFileSync(path.join(staging, 'owner.json'), Buffer.alloc(64 * 1024 + 1, 0x20))
  }, /exceeds the 65536 byte limit/)
  await rejectsShape('valid owner whose token mismatches its staging name', ({ staging }) => {
    fs.writeFileSync(
      path.join(staging, 'owner.json'),
      `${JSON.stringify(stagingOwner('efefefefefefefef'), null, 2)}\n`,
      'utf8'
    )
  }, /name does not match its owner/)
  await rejectsShape('valid owner whose lock identity mismatches its staging name', ({ staging, token }) => {
    fs.writeFileSync(
      path.join(staging, 'owner.json'),
      `${JSON.stringify(stagingOwner(token, {
        scope: 'worktree',
        lockKey: `sha256:${'1'.repeat(64)}`
      }), null, 2)}\n`,
      'utf8'
    )
  }, /name does not match its owner/)
})

test('an acquisition staging artifact disappearing after directory enumeration is benign', async (t) => {
  const root = fixture(t)
  const token = '3434343434343434'
  const staging = acquisitionStaging(root, token)
  fs.mkdirSync(staging, { recursive: true })
  let removed = false
  const manager = leases.createLeaseLockManager({
    root,
    leaseMs: 1_000,
    token: () => '5656565656565656',
    processInspector: fakeInspector('disappearing-staging'),
    checkpoint(name) {
      if (!removed && name === 'lease-acquisition-artifact-observed') {
        fs.rmdirSync(staging)
        removed = true
      }
    }
  })
  const acquired = await manager.acquire(identity('disappearing-staging'))
  assert.equal(removed, true)
  assert.equal(acquired.status, 'acquired')
  await acquired.lease.release()
  assert.deepEqual(lockEntries(root), [])
})

test('stale cleanup refuses a same-name staging directory replacement after observation', async (t) => {
  const root = fixture(t)
  const staging = acquisitionStaging(root, '7878787878787878')
  const original = path.join(root, 'original-observed-staging')
  const replacementOwner = path.join(staging, 'owner.json')
  fs.mkdirSync(staging, { recursive: true })
  fs.writeFileSync(replacementOwner, '{"schemaVersion": 1,\n')
  const stale = new Date(Date.now() - 10_000)
  fs.utimesSync(staging, stale, stale)
  let replaced = false
  const manager = leases.createLeaseLockManager({
    root,
    leaseMs: 100,
    token: () => '9696969696969696',
    processInspector: fakeInspector('stale-replacement'),
    fault(name) {
      if (!replaced && name === 'lease-before-stale-acquisition-cleanup') {
        fs.renameSync(staging, original)
        fs.mkdirSync(staging)
        fs.writeFileSync(replacementOwner, 'replacement-must-survive')
        replaced = true
      }
    }
  })
  await assert.rejects(
    manager.acquire(identity('stale-replacement')),
    /observed cleanup identity/
  )
  assert.equal(replaced, true)
  assert.equal(fs.readFileSync(replacementOwner, 'utf8'), 'replacement-must-survive')
})

test('live lock and owner paths reject a linked or reparse directory', async (t) => {
  const root = fixture(t)
  const external = fixture(t)
  fs.mkdirSync(path.join(root, 'leases'))
  try {
    fs.symlinkSync(external, path.join(root, 'leases', 'hub-global.lock'), process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (error?.code === 'EPERM') return
    throw error
  }
  const manager = leases.createLeaseLockManager({
    root,
    leaseMs: 1_000,
    pid: 505,
    token: () => 'eeeeeeeeeeeeeeee',
    processInspector: fakeInspector('linked')
  })
  await assert.rejects(manager.acquire(identity('linked')), /symlink|reparse|plain directory/)
})

function spawnContender(
  root,
  leaseMs,
  label,
  controlledRelease = false,
  staleBarrierDirectory = ''
) {
  const source = `
    import fs from 'node:fs'
    import path from 'node:path'
    const { createLeaseLockManager } = await import(process.env.LEASE_MODULE_URL)
    let crossedStaleBarrier = false
    const sleeper = new Int32Array(new SharedArrayBuffer(4))
    function fault(name) {
      if (crossedStaleBarrier || name !== 'lease-before-stale-acquisition-cleanup'
        || !process.env.LEASE_STALE_BARRIER_DIRECTORY) return
      crossedStaleBarrier = true
      const ready = path.join(
        process.env.LEASE_STALE_BARRIER_DIRECTORY,
        process.env.LEASE_LABEL + '.ready'
      )
      fs.writeFileSync(ready, '')
      const deadline = Date.now() + 30_000
      while (fs.readdirSync(process.env.LEASE_STALE_BARRIER_DIRECTORY)
        .filter((entry) => entry.endsWith('.ready')).length < 2) {
        if (Date.now() >= deadline) {
          console.error('stale cleanup barrier timed out')
          process.exit(3)
        }
        Atomics.wait(sleeper, 0, 0, 10)
      }
    }
    const manager = createLeaseLockManager({
      root: process.env.LEASE_ROOT,
      leaseMs: Number(process.env.LEASE_MS),
      fault
    })
    const result = await manager.acquire({
      scope: 'hub-global', key: 'hub-global', hostId: 'child-' + process.pid,
      commandKind: 'ingest', requestId: process.env.LEASE_LABEL
    })
    if (result.status === 'acquired' && process.env.LEASE_CONTROLLED_RELEASE === '1') {
      process.once('message', async (message) => {
        if (message?.command !== 'release') process.exit(2)
        try {
          await result.lease.release()
          process.exit(0)
        } catch (error) {
          console.error(error)
          process.exit(1)
        }
      })
    }
    if (process.send) process.send({ status: result.status, reason: result.reason || null })
    if (result.status === 'acquired' && process.env.LEASE_CONTROLLED_RELEASE !== '1') {
      setInterval(() => {}, 1000)
    } else if (result.status !== 'acquired') {
      setTimeout(() => process.exit(0), 25)
    }
  `
  return spawn(process.execPath, ['--input-type=module', '-e', source], {
    env: {
      ...process.env,
      LEASE_MODULE_URL: leaseModuleUrl,
      LEASE_ROOT: root,
      LEASE_MS: String(leaseMs),
      LEASE_LABEL: label,
      LEASE_CONTROLLED_RELEASE: controlledRelease ? '1' : '0',
      LEASE_STALE_BARRIER_DIRECTORY: staleBarrierDirectory
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true
  })
}

function waitForMessage(child, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    const timer = setTimeout(() => {
      reject(new Error(`child message timed out: ${stderr}`))
    }, timeoutMs)
    child.once('message', (message) => {
      clearTimeout(timer)
      resolve(message)
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      if (code && code !== 0) {
        clearTimeout(timer)
        reject(new Error(`child exited ${code}: ${stderr}`))
      }
    })
  })
}

function waitForExit(child) {
  if (child.exitCode !== null) return Promise.resolve()
  return new Promise((resolve) => child.once('exit', resolve))
}

function waitForCleanExit(child, timeoutMs = 30_000) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child exit timed out')), timeoutMs)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

test('real process contention has exactly one winner and one busy result across repeated clean rounds', { timeout: 300_000 }, async (t) => {
  const root = fixture(t)
  const children = []
  const rounds = Number(process.env.SKILL_GRAFT_LEASE_CONTENTION_ROUNDS || 8)
  assert.equal(Number.isSafeInteger(rounds) && rounds > 0 && rounds <= 500, true)
  t.after(() => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL')
  })

  for (let round = 0; round < rounds; round += 1) {
    const roundRoot = path.join(root, `round-${round}`)
    fs.mkdirSync(roundRoot)
    const pair = [
      spawnContender(roundRoot, 10_000, `round-${round}-a`, true),
      spawnContender(roundRoot, 10_000, `round-${round}-b`, true)
    ]
    children.push(...pair)
    const results = await Promise.all(pair.map((child) => waitForMessage(child)))
    assert.equal(results.filter((result) => result.status === 'acquired').length, 1, `round ${round}`)
    assert.equal(results.filter((result) => result.status === 'busy').length, 1, `round ${round}`)
    const winner = pair[results.findIndex((result) => result.status === 'acquired')]
    winner.send({ command: 'release' })
    const exitCodes = await Promise.all(pair.map((child) => waitForCleanExit(child)))
    assert.deepEqual(exitCodes, [0, 0], `round ${round}`)
    assert.deepEqual(lockEntries(roundRoot), [], `round ${round}`)
  }
})

test('two real sweepers concurrently remove one stale acquisition staging directory', { timeout: 60_000 }, async (t) => {
  const root = fixture(t)
  const barrier = path.join(root, 'stale-sweeper-barrier')
  const staging = acquisitionStaging(root, '2323232323232323')
  fs.mkdirSync(barrier)
  fs.mkdirSync(staging, { recursive: true })
  fs.writeFileSync(path.join(staging, 'owner.json'), '{"schemaVersion": 1,\n')
  const stale = new Date(Date.now() - 10_000)
  fs.utimesSync(staging, stale, stale)

  const children = [
    spawnContender(root, 100, 'stale-sweeper-a', true, barrier),
    spawnContender(root, 100, 'stale-sweeper-b', true, barrier)
  ]
  t.after(() => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL')
  })
  const results = await Promise.all(children.map((child) => waitForMessage(child)))
  assert.equal(results.filter((result) => result.status === 'acquired').length, 1)
  assert.equal(results.filter((result) => result.status === 'busy').length, 1)
  const winner = children[results.findIndex((result) => result.status === 'acquired')]
  winner.send({ command: 'release' })
  assert.deepEqual(await Promise.all(children.map((child) => waitForCleanExit(child))), [0, 0])
  assert.deepEqual(lockEntries(root), [])
})

test('real child processes have one winner; a live expired owner blocks and kill enables recovery', { timeout: 60_000 }, async (t) => {
  const root = fixture(t)
  const leaseMs = 1_200
  const children = [spawnContender(root, leaseMs, 'child-a'), spawnContender(root, leaseMs, 'child-b')]
  t.after(() => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL')
  })
  const results = await Promise.all(children.map((child) => waitForMessage(child)))
  assert.equal(results.filter((result) => result.status === 'acquired').length, 1)
  assert.equal(results.filter((result) => result.status === 'busy').length, 1)
  const winnerIndex = results.findIndex((result) => result.status === 'acquired')
  const winner = children[winnerIndex]
  const loser = children[1 - winnerIndex]
  await waitForExit(loser)

  await new Promise((resolve) => setTimeout(resolve, leaseMs + 250))
  const parent = leases.createLeaseLockManager({ root, leaseMs })
  const aliveBlocked = await parent.acquire(identity('parent-alive', 'parent-host'))
  assert.equal(aliveBlocked.status, 'busy')
  assert.equal(aliveBlocked.reason, 'owner-alive')

  winner.kill('SIGKILL')
  await waitForExit(winner)
  const recovered = await parent.acquire(identity('parent-recovered', 'parent-host'))
  assert.equal(recovered.status, 'acquired')
  await recovered.lease.release()
  assert.deepEqual(lockEntries(root), [])
})
