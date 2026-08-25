import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  assertDaemonStartStageCurrent,
  bootstrapDaemonStageNamespace,
  captureDaemonProtocolFile,
  commitDaemonStartInstance,
  createDaemonStartStage,
  daemonFileIdentity,
  daemonProtocolPaths,
  inspectDaemonProtocol,
  inspectDaemonReceiptNamespace,
  publishDaemonStartProjection,
  recoverDaemonStartStage
} from '../dist/control/daemon-protocol.js'

const IDS = {
  install: '11111111-1111-4111-8111-111111111111',
  data: '22222222-2222-4222-8222-222222222222',
  namespace: '33333333-3333-4333-8333-333333333333',
  epoch: '44444444-4444-4444-8444-444444444444'
}
const CREATED_AT = '2026-08-24T00:00:01.000Z'

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function fileState(file) {
  const stat = fs.lstatSync(file)
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, nlink: stat.nlink }
}

function authorityFileState(file) {
  if (!fs.existsSync(file)) return { bytes: null, stat: null }
  return { bytes: fs.readFileSync(file), stat: fileState(file) }
}

function captureTree(root) {
  const rows = []
  const visit = (file, relative) => {
    const stat = fs.lstatSync(file)
    rows.push({
      relative,
      kind: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : 'other',
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      nlink: stat.nlink,
      bytes: stat.isFile() ? fs.readFileSync(file).toString('hex') : null
    })
    if (!stat.isDirectory()) return
    for (const name of fs.readdirSync(file).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))) {
      visit(path.join(file, name), relative ? `${relative}/${name}` : name)
    }
  }
  visit(root, '')
  return rows
}

function createAuthorityFixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-stage-provenance-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const dataRoot = path.join(home, 'data')
  const packageRoot = path.join(home, 'package')
  const installDir = path.join(home, 'install')
  const paths = daemonProtocolPaths(home, dataRoot)
  fs.mkdirSync(paths.receiptDirectory, { recursive: true })
  fs.mkdirSync(paths.reviewDirectory, { recursive: true })
  fs.mkdirSync(packageRoot)
  fs.mkdirSync(installDir)
  fs.writeFileSync(paths.receiptNamespaceMarker, '', { flag: 'wx' })
  const receipt = {
    schemaVersion: 1,
    product: 'skill-graft',
    installId: IDS.install,
    dataRootId: IDS.data,
    dataRoot,
    installDir,
    packageRoot,
    packageVersion: '1.0.0',
    packageSha256: `sha256:${'a'.repeat(64)}`,
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
    state: 'active'
  }
  fs.writeFileSync(paths.receiptFile, `${JSON.stringify(receipt)}\n`, { flag: 'wx' })
  const homeStat = fs.lstatSync(home)
  const homeIdentity = sha256(`${fs.realpathSync.native(home)}\0${homeStat.dev}\0${homeStat.ino}`)
  const readReceiptAuthority = () => {
    const names = fs.readdirSync(paths.receiptDirectory)
      .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
    const daemonName = names.find((name) => /^\.daemon-stage-namespace-v1\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.marker$/.test(name)) || null
    const daemonId = daemonName?.slice('.daemon-stage-namespace-v1.'.length, -'.marker'.length) || null
    const daemonFile = daemonName ? path.join(paths.receiptDirectory, daemonName) : null
    return {
      home,
      directory: paths.receiptDirectory,
      directoryState: fileState(paths.receiptDirectory),
      entries: names,
      homeIdentity,
      namespaceMarker: paths.receiptNamespaceMarker,
      namespaceMarkerState: authorityFileState(paths.receiptNamespaceMarker),
      receiptFile: paths.receiptFile,
      receipt,
      receiptState: authorityFileState(paths.receiptFile),
      ownerStageNamespaceId: null,
      ownerStageAuthorityMarker: null,
      ownerStageAuthorityMarkerState: null,
      daemonStageNamespaceId: daemonId,
      daemonStageAuthorityMarker: daemonFile,
      daemonStageAuthorityMarkerState: daemonFile ? authorityFileState(daemonFile) : null
    }
  }
  const options = { home, dataRoot, readReceiptAuthority }
  const initial = inspectDaemonProtocol(options)
  const receiptAuthority = inspectDaemonReceiptNamespace(home, dataRoot, readReceiptAuthority)
  const authority = bootstrapDaemonStageNamespace({
    ...options,
    expectedInspection: initial,
    expectedReceiptAuthority: receiptAuthority,
    namespaceId: IDS.namespace
  })
  return { home, dataRoot, packageRoot, paths, options, authority }
}

function createFixture(t, checkpoint = undefined) {
  const fixture = createAuthorityFixture(t)
  const stage = createDaemonStartStage(fixture.authority, {
    epochId: IDS.epoch,
    pid: process.pid,
    apiPid: process.pid,
    processIdentity: `test-${process.pid}`,
    pgid: process.pid,
    port: 18765,
    createdAt: CREATED_AT,
    ...(checkpoint ? { checkpoint } : {})
  })
  return { ...fixture, stage }
}

function assertNoPublic(fixture) {
  for (const file of [
    fixture.paths.pidProjection,
    fixture.paths.apiPidProjection,
    fixture.paths.heartbeatProjection,
    fixture.paths.finalInstance
  ]) assert.equal(fs.existsSync(file), false, file)
}

function assertDifferentInode(left, right, label) {
  assert.notDeepEqual([left.dev, left.ino], [right.dev, right.ino], label)
}

function assertOnlyEmptyReservation(authority) {
  const stageNames = fs.readdirSync(authority.paths.stageDirectory)
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
  assert.equal(stageNames.length, 2)
  const reservationName = stageNames.find((name) => !name.startsWith('.namespace-v1.'))
  assert.ok(reservationName)
  assert.deepEqual(fs.readdirSync(path.join(authority.paths.stageDirectory, reservationName)), [])
}

test('D1-B provenance rejects caller-retargeted public projection before arbitrary link', (t) => {
  const fixture = createFixture(t)
  const arbitraryTarget = path.join(fixture.home, 'arbitrary-target')
  fixture.stage.authority.paths.pidProjection = arbitraryTarget
  const before = captureTree(fixture.home)

  assert.throws(
    () => publishDaemonStartProjection(fixture.stage, 'pid'),
    /caller-visible daemon start stage changed|not issued/
  )
  assert.equal(fs.existsSync(arbitraryTarget), false)
  assertNoPublic(fixture)
  assert.deepEqual(captureTree(fixture.home), before)
})

test('D1-B provenance rejects self-consistent caller source and record redirection', (t) => {
  const fixture = createFixture(t)
  const arbitrarySource = path.join(fixture.home, 'arbitrary-source')
  fs.writeFileSync(arbitrarySource, `${process.pid}\n`, { flag: 'wx' })
  const captured = captureDaemonProtocolFile(arbitrarySource, 128, 'arbitrary PID source')
  const identity = daemonFileIdentity(captured)
  fixture.stage.files.pid = captured
  fixture.stage.instance.projections.pid = identity
  fixture.stage.manifest.projections.pid = identity
  const before = captureTree(fixture.home)

  assert.throws(
    () => publishDaemonStartProjection(fixture.stage, 'pid'),
    /caller-visible daemon start stage changed|not issued/
  )
  assertNoPublic(fixture)
  assert.deepEqual(captureTree(fixture.home), before)
})

for (const [label, mutate] of [
  ['public path', (stage, fixture) => { stage.authority.paths.pidProjection = path.join(fixture.home, 'retargeted-pid') }],
  ['captured payload bytes', (stage) => { stage.files.pid.bytes[0] ^= 0x01 }],
  ['captured payload state', (stage) => { stage.files.pid.state.nlink += 1 }],
  ['instance semantics', (stage) => { stage.instance.port += 1 }],
  ['manifest semantics', (stage) => { stage.manifest.operationId = '55555555-5555-4555-8555-555555555555' }],
  ['reservation binding', (stage) => { stage.binding.actorProcessIdentity = 'retargeted-actor' }],
  ['receipt payload bytes', (stage) => { stage.authority.receipt.receiptFile.bytes[0] ^= 0x01 }],
  ['receipt payload state', (stage) => { stage.authority.receipt.receiptFile.state.nlink += 1 }],
  ['receipt reader', (stage) => { stage.authority.readReceiptAuthority = () => { throw new Error('caller reader must not run') } }],
  ['stage shell', (stage) => { stage.reservationDirectory = `${stage.reservationDirectory}.retargeted` }]
]) {
  test(`D1-B issued stage rejects caller mutation of ${label} before publication`, (t) => {
    const fixture = createFixture(t)
    mutate(fixture.stage, fixture)
    const before = captureTree(fixture.home)

    assert.throws(
      () => publishDaemonStartProjection(fixture.stage, 'pid'),
      /caller-visible daemon start stage changed after issuance/
    )
    assertNoPublic(fixture)
    assert.deepEqual(captureTree(fixture.home), before)
  })
}

test('D1-B issued stage rejects a forged caller shell before publication', (t) => {
  const fixture = createFixture(t)
  const forged = { ...fixture.stage }
  const before = captureTree(fixture.home)

  assert.throws(
    () => publishDaemonStartProjection(forged, 'pid'),
    /not issued by this protocol instance/
  )
  assertNoPublic(fixture)
  assert.deepEqual(captureTree(fixture.home), before)
})

for (const [label, mutate] of [
  ['public path', (authority, fixture) => { authority.paths.pidProjection = path.join(fixture.home, 'create-retargeted-pid') }],
  ['receipt bytes', (authority) => { authority.receipt.receiptFile.bytes[0] ^= 0x01 }],
  ['receipt state', (authority) => { authority.receipt.receiptFile.state.nlink += 1 }],
  ['receipt reader', (authority) => {
    const original = authority.readReceiptAuthority
    authority.readReceiptAuthority = () => original()
  }]
]) {
  test(`D1-B create rejects caller authority ${label} mutation at its first checkpoint`, (t) => {
    const fixture = createAuthorityFixture(t)
    let cut = null
    const options = {
      epochId: IDS.epoch,
      pid: process.pid,
      apiPid: process.pid,
      processIdentity: `test-${process.pid}`,
      pgid: process.pid,
      port: 18765,
      createdAt: CREATED_AT,
      checkpoint(name) {
        if (name !== 'daemon-start-reservation-directory-created' || cut) return
        mutate(fixture.authority, fixture)
        cut = captureTree(fixture.home)
      }
    }

    assert.throws(
      () => createDaemonStartStage(fixture.authority, options),
      /caller-visible daemon stage namespace authority changed after capture/
    )
    assert.ok(cut)
    assert.deepEqual(captureTree(fixture.home), cut)
    assertOnlyEmptyReservation(fixture.authority)
    assertNoPublic(fixture)
  })
}

test('D1-B create snapshots mutable options before the first mutation', (t) => {
  const fixture = createAuthorityFixture(t)
  const options = {
    epochId: IDS.epoch,
    pid: process.pid,
    apiPid: process.pid,
    processIdentity: `test-${process.pid}`,
    pgid: process.pid,
    port: 18765,
    createdAt: CREATED_AT,
    checkpoint(name) {
      if (name !== 'daemon-start-reservation-directory-created') return
      options.pid = process.pid + 1000
      options.apiPid = process.pid + 1000
      options.processIdentity = 'mutated-options'
      options.pgid = process.pid + 1000
      options.port = 18766
      options.createdAt = '2026-08-24T00:00:02.000Z'
    }
  }

  const stage = createDaemonStartStage(fixture.authority, options)
  assert.equal(stage.instance.pid, process.pid)
  assert.equal(stage.instance.apiPid, process.pid)
  assert.equal(stage.instance.processIdentity, `test-${process.pid}`)
  assert.equal(stage.instance.pgid, process.pid)
  assert.equal(stage.instance.port, 18765)
  assert.equal(stage.instance.createdAt, CREATED_AT)
  assertDaemonStartStageCurrent(stage, inspectDaemonProtocol(fixture.options))
})

test('D1-B create reads every caller option exactly once before mutation', (t) => {
  const fixture = createAuthorityFixture(t)
  const values = {
    epochId: IDS.epoch,
    pid: process.pid,
    apiPid: process.pid,
    processIdentity: `test-${process.pid}`,
    pgid: process.pid,
    port: 18765,
    createdAt: CREATED_AT,
    checkpoint: () => {}
  }
  const reads = Object.fromEntries(Object.keys(values).map((key) => [key, 0]))
  const options = Object.create(null)
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(options, key, {
      enumerable: true,
      get() {
        reads[key] += 1
        return value
      }
    })
  }

  const stage = createDaemonStartStage(fixture.authority, options)
  assert.deepEqual(reads, Object.fromEntries(Object.keys(values).map((key) => [key, 1])))
  assert.equal(stage.instance.epochId, IDS.epoch)
  assertDaemonStartStageCurrent(stage, inspectDaemonProtocol(fixture.options))
})

test('D1-B assertion binds the issued stage to the exact frozen START inspection', (t) => {
  const fixture = createFixture(t)
  const expected = inspectDaemonProtocol(fixture.options)
  const before = captureTree(fixture.home)

  assert.equal(expected.kind, 'STARTING')
  assertDaemonStartStageCurrent(fixture.stage, expected)
  assert.deepEqual(captureTree(fixture.home), before)

  const forgedKind = { ...expected, kind: 'RUNNING-COLLAPSING' }
  assert.throws(
    () => assertDaemonStartStageCurrent(fixture.stage, forgedKind),
    /inspection.*changed|does not bind the issued stage epoch/
  )
  assert.deepEqual(captureTree(fixture.home), before)
})

test('D1-B recovered stage ignores later caller mutation of inspection options', (t) => {
  const fixture = createFixture(t)
  const frozen = inspectDaemonProtocol(fixture.options)
  const recoveryOptions = { ...fixture.options }
  const recovered = recoverDaemonStartStage(recoveryOptions, frozen)
  const arbitraryHome = path.join(fixture.home, 'arbitrary-home')
  recoveryOptions.home = arbitraryHome
  recoveryOptions.dataRoot = path.join(arbitraryHome, 'data')
  recoveryOptions.platform = process.platform === 'win32' ? 'linux' : 'win32'
  recoveryOptions.readReceiptAuthority = () => { throw new Error('mutated recovery reader must not run') }

  assertDaemonStartStageCurrent(recovered, frozen)
  const published = publishDaemonStartProjection(recovered, 'pid')
  assert.equal(published.state.dev, recovered.files.pid.state.dev)
  assert.equal(published.state.ino, recovered.files.pid.state.ino)
  assert.equal(fs.existsSync(fixture.paths.pidProjection), true)
  assert.equal(fs.existsSync(path.join(arbitraryHome, 'data', 'skill-review', 'daemon.pid')), false)
})

test('D1-B returned publication evidence cannot mutate the private publication epoch', (t) => {
  const fixture = createFixture(t)
  const pid = publishDaemonStartProjection(fixture.stage, 'pid')
  pid.file = path.join(fixture.home, 'retargeted-return')
  pid.bytes[0] ^= 0x01
  pid.state.ino += 1

  const apiPid = publishDaemonStartProjection(fixture.stage, 'apiPid')
  assert.equal(apiPid.state.dev, fixture.stage.files.apiPid.state.dev)
  assert.equal(apiPid.state.ino, fixture.stage.files.apiPid.state.ino)
  assert.equal(fs.existsSync(path.join(fixture.home, 'retargeted-return')), false)
})

test('D1-B publication rejects same-byte replacement of its frozen staged source', (t) => {
  const fixture = createFixture(t)
  const source = fixture.stage.files.pid.file
  const bytes = fs.readFileSync(source)
  const original = fileState(source)
  const parked = path.join(fixture.home, 'parked-staged-pid')
  fs.renameSync(source, parked)
  fs.writeFileSync(source, bytes, { flag: 'wx' })
  const replacement = fileState(source)
  assertDifferentInode(original, replacement, 'staged source replacement must use a different inode')
  const before = captureTree(fixture.home)

  assert.throws(
    () => publishDaemonStartProjection(fixture.stage, 'pid'),
    /frozen inode|changed/
  )
  assert.deepEqual(captureTree(fixture.home), before)
  assert.equal(fs.readFileSync(source).equals(bytes), true)
  assert.equal(fs.readFileSync(parked).equals(bytes), true)
  assertNoPublic(fixture)
})

test('D1-B publication checkpoint rejects same-byte replacement of the just-linked target', (t) => {
  const fixture = createFixture(t)
  const target = fixture.paths.pidProjection
  const parked = path.join(fixture.home, 'parked-public-pid')
  let cut = null

  assert.throws(() => publishDaemonStartProjection(fixture.stage, 'pid', (name) => {
    if (name !== 'daemon-hardlink-created' || cut) return
    const bytes = fs.readFileSync(target)
    const original = fileState(target)
    fs.renameSync(target, parked)
    fs.writeFileSync(target, bytes, { flag: 'wx' })
    const replacement = fileState(target)
    assertDifferentInode(original, replacement, 'published target replacement must use a different inode')
    cut = captureTree(fixture.home)
  }), /hardlink|frozen inode|changed/)

  assert.ok(cut)
  assert.deepEqual(captureTree(fixture.home), cut)
  assert.equal(fs.existsSync(fixture.paths.apiPidProjection), false)
  assert.equal(fs.existsSync(fixture.paths.heartbeatProjection), false)
  assert.equal(fs.existsSync(fixture.paths.finalInstance), false)
})

test('D1-B publication checkpoint seals the caller-visible stage before its next fsync', (t) => {
  const fixture = createFixture(t)
  let cut = null

  assert.throws(() => publishDaemonStartProjection(fixture.stage, 'pid', (name) => {
    if (name !== 'daemon-hardlink-created' || cut) return
    fixture.stage.manifest.operationId = '55555555-5555-4555-8555-555555555555'
    cut = captureTree(fixture.home)
  }), /caller-visible daemon start stage changed after issuance/)

  assert.ok(cut)
  assert.deepEqual(captureTree(fixture.home), cut)
  const source = fileState(fixture.stage.files.pid.file)
  const target = fileState(fixture.paths.pidProjection)
  assert.deepEqual([target.dev, target.ino, target.nlink], [source.dev, source.ino, 2])
  assert.equal(fs.existsSync(fixture.paths.apiPidProjection), false)
  assert.equal(fs.existsSync(fixture.paths.heartbeatProjection), false)
  assert.equal(fs.existsSync(fixture.paths.finalInstance), false)
})

test('D1-B exact assertion follows every legal start publication phase', (t) => {
  const fixture = createFixture(t)
  assertDaemonStartStageCurrent(fixture.stage, inspectDaemonProtocol(fixture.options))
  for (const projection of ['pid', 'apiPid', 'heartbeat']) {
    publishDaemonStartProjection(fixture.stage, projection)
    assertDaemonStartStageCurrent(fixture.stage, inspectDaemonProtocol(fixture.options))
  }
  commitDaemonStartInstance(fixture.stage)
  const linked = inspectDaemonProtocol(fixture.options)
  assert.equal(linked.kind, 'RUNNING-LINKED')
  assertDaemonStartStageCurrent(fixture.stage, linked)
})
