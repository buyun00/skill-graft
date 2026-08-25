import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  acquireAbandonedDaemonStartCleanupAuthority,
  acquireCommittedDaemonStartCollapseAuthority,
  bootstrapDaemonStageNamespace,
  cleanupAbandonedDaemonStart,
  collapseCommittedDaemonStart,
  commitDaemonStartInstance,
  createDaemonStartStage,
  daemonReservationName,
  daemonProtocolPaths,
  inspectDaemonProtocol,
  inspectDaemonReceiptNamespace,
  publishDaemonStartProjection,
  removeDaemonDirectoryExactDurable,
  settleDaemonTerminalNamespaceDurability,
  unlinkDaemonFileExactDurable
} from '../dist/control/daemon-protocol.js'

const UUIDS = {
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

function captureFileEvidence(file) {
  return { bytes: fs.readFileSync(file), stat: fileState(file) }
}

function captureDaemonFileForProof(file) {
  const bytes = fs.readFileSync(file)
  return {
    file,
    bytes,
    sha256: `sha256:${sha256(bytes)}`,
    state: fileState(file)
  }
}

function assertFileEvidence(file, expected) {
  assert.deepEqual(captureFileEvidence(file), expected)
}

function captureTreeEvidence(root) {
  const result = []
  const visit = (entry, relative) => {
    const stat = fs.lstatSync(entry)
    result.push({
      relative,
      kind: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : 'other',
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      nlink: stat.nlink,
      bytes: stat.isFile() ? fs.readFileSync(entry).toString('hex') : null
    })
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(entry)
        .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))) {
        visit(path.join(entry, name), relative ? `${relative}/${name}` : name)
      }
    }
  }
  visit(root, '')
  return result
}

function createActiveReceiptFixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-protocol-d1a-'))
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
    installId: UUIDS.install,
    dataRootId: UUIDS.data,
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
  const businessFile = path.join(paths.reviewDirectory, 'unrelated-business.json')
  fs.writeFileSync(businessFile, '{"business":true}\n', { flag: 'wx' })
  return { home, dataRoot, packageRoot, installDir, receipt, paths, readReceiptAuthority, businessFile }
}

function daemonOptions(fixture) {
  return { home: fixture.home, dataRoot: fixture.dataRoot, readReceiptAuthority: fixture.readReceiptAuthority }
}

function bootstrapCurrent(fixture) {
  const options = daemonOptions(fixture)
  return bootstrapDaemonStageNamespace({
    ...options,
    expectedInspection: inspectDaemonProtocol(options),
    expectedReceiptAuthority: inspectDaemonReceiptNamespace(
      fixture.home,
      fixture.dataRoot,
      fixture.readReceiptAuthority
    ),
    namespaceId: UUIDS.namespace
  })
}

function createPreparedStartStage(t) {
  const fixture = createActiveReceiptFixture(t)
  const options = daemonOptions(fixture)
  const authority = bootstrapCurrent(fixture)
  const stage = createDaemonStartStage(authority, {
    epochId: UUIDS.epoch,
    pid: process.pid,
    apiPid: process.pid,
    processIdentity: `test-${process.pid}`,
    pgid: process.pid,
    port: 18765,
    createdAt: CREATED_AT
  })
  return { fixture, options, stage }
}

const START_WRITER_CUTS = [
  ['created', 'daemon-exclusive-created'],
  ['written', 'daemon-file-written'],
  ['file-fsynced', 'daemon-file-fsynced'],
  ['parent-fsynced', 'daemon-parent-fsynced']
]
const START_PAYLOADS = [
  ['daemon.pid', 'daemon staged PID projection'],
  ['api.pid', 'daemon staged API PID projection'],
  ['daemon-heartbeat.json', 'daemon staged heartbeat projection'],
  ['daemon-instance-v1.json', 'daemon staged instance'],
  ['stage-manifest-v1.json', 'daemon start stage manifest']
]

function createStartWriterCutFixture(t, payloadName, payloadLabel, checkpointName) {
  const fixture = createActiveReceiptFixture(t)
  const options = daemonOptions(fixture)
  const authority = bootstrapCurrent(fixture)
  let cut = false
  assert.throws(() => createDaemonStartStage(authority, {
    epochId: UUIDS.epoch,
    pid: process.pid,
    apiPid: process.pid,
    processIdentity: `test-${process.pid}`,
    pgid: process.pid,
    port: 18765,
    createdAt: CREATED_AT,
    checkpoint(name, facts) {
      if (!cut && name === checkpointName && facts.label === payloadLabel) {
        cut = true
        throw new Error(`D1-A writer cut ${payloadName}`)
      }
    }
  }), /D1-A writer cut/)
  assert.equal(cut, true)
  const inspection = inspectDaemonProtocol(options)
  assert.ok(inspection.kind === 'STARTING-PARTIAL' || inspection.kind === 'STARTING', inspection.reason || '')
  return { fixture, options, inspection }
}

function publishProjectionPrefix(stage, count) {
  for (const projection of ['pid', 'apiPid', 'heartbeat'].slice(0, count)) {
    publishDaemonStartProjection(stage, projection)
  }
}

function completeStart(stage) {
  publishProjectionPrefix(stage, 3)
  return commitDaemonStartInstance(stage)
}

function createStopPartialFixture(t) {
  const prepared = createPreparedStartStage(t)
  completeStart(prepared.stage)
  collapseCommittedDaemonStart(acquireCommittedDaemonStartCollapseAuthority(
    prepared.options,
    inspectDaemonProtocol(prepared.options)
  ))
  const instance = prepared.stage.instance
  const binding = {
    stageNamespaceId: instance.stageNamespaceId,
    receiptSha256: instance.receiptSha256,
    installId: instance.installId,
    dataRootId: instance.dataRootId,
    operationId: '55555555-5555-4555-8555-555555555555',
    actorPid: instance.pid,
    actorProcessIdentity: instance.processIdentity,
    actorPgid: instance.pgid,
    operation: 'stop',
    packageSha256: instance.packageSha256,
    createdAt: CREATED_AT
  }
  fs.mkdirSync(path.join(prepared.fixture.paths.stageDirectory, daemonReservationName(binding)))
  return prepared
}

function createLegacyRetirePartialFixture(t) {
  const fixture = createActiveReceiptFixture(t)
  fs.writeFileSync(fixture.paths.pidProjection, `${process.pid}\n`, { flag: 'wx' })
  fs.writeFileSync(fixture.paths.apiPidProjection, `${process.pid}\n`, { flag: 'wx' })
  fs.writeFileSync(fixture.paths.heartbeatProjection, `${JSON.stringify({
    pid: process.pid,
    apiPid: process.pid,
    hubRoot: fixture.dataRoot,
    packageRoot: fixture.packageRoot,
    dataRoot: fixture.dataRoot,
    port: 18765,
    apiHealthy: true,
    lastBeat: CREATED_AT
  }, null, 2)}\n`, { flag: 'wx' })
  const options = daemonOptions(fixture)
  const authority = bootstrapCurrent(fixture)
  const binding = {
    stageNamespaceId: authority.namespaceId,
    receiptSha256: authority.receipt.receiptSha256,
    installId: fixture.receipt.installId,
    dataRootId: fixture.receipt.dataRootId,
    operationId: '66666666-6666-4666-8666-666666666666',
    actorPid: process.pid,
    actorProcessIdentity: `test-${process.pid}`,
    actorPgid: process.pid,
    operation: 'legacy-retire',
    packageSha256: fixture.receipt.packageSha256,
    createdAt: CREATED_AT
  }
  fs.mkdirSync(path.join(fixture.paths.stageDirectory, daemonReservationName(binding)))
  return { fixture, options }
}

function keepRunningInternalSubset(prepared, keep) {
  const present = new Set(keep)
  for (const [key, file] of Object.entries({
    pid: prepared.stage.files.pid.file,
    apiPid: prepared.stage.files.apiPid.file,
    heartbeat: prepared.stage.files.heartbeat.file,
    instance: prepared.stage.files.instance.file
  })) {
    if (!present.has(key)) fs.unlinkSync(file)
  }
}

function capturePreservedAuthority(prepared) {
  const { fixture, stage } = prepared
  return {
    receipt: captureFileEvidence(fixture.paths.receiptFile),
    homeMarker: captureFileEvidence(stage.authority.homeMarker.file),
    innerMarker: captureFileEvidence(stage.authority.innerMarker.file),
    business: captureFileEvidence(fixture.businessFile)
  }
}

function assertPreservedAuthority(prepared, expected) {
  const { fixture, stage } = prepared
  assertFileEvidence(fixture.paths.receiptFile, expected.receipt)
  assertFileEvidence(stage.authority.homeMarker.file, expected.homeMarker)
  assertFileEvidence(stage.authority.innerMarker.file, expected.innerMarker)
  assertFileEvidence(fixture.businessFile, expected.business)
}

function assertStartReservationAbsent(prepared) {
  const reservationDirectory = prepared.stage?.reservationDirectory
    || path.join(prepared.fixture.paths.stageDirectory, prepared.inspection.reservation.name)
  const innerMarker = prepared.stage?.authority.innerMarker.file
    || path.join(
      prepared.fixture.paths.stageDirectory,
      `.namespace-v1.${prepared.inspection.namespaceId}.skill-graft.marker`
    )
  assert.equal(fs.existsSync(reservationDirectory), false)
  assert.deepEqual(
    fs.readdirSync(prepared.fixture.paths.stageDirectory),
    [path.basename(innerMarker)]
  )
}

function acquireDeadStartCleanup(prepared) {
  return acquireAbandonedDaemonStartCleanupAuthority(
    prepared.options,
    inspectDaemonProtocol(prepared.options),
    () => ({ state: 'dead' })
  )
}

function assertStrictIntermediate(prepared) {
  const current = inspectDaemonProtocol(prepared.options)
  assert.notEqual(current.kind, 'INVALID', current.reason || '')
  return current
}

function runFileCutRetry(t, { mode, label, checkpointName, retry }) {
  const prepared = createPreparedStartStage(t)
  if (mode === 'collapse') completeStart(prepared.stage)
  else publishProjectionPrefix(prepared.stage, 3)
  const preserved = capturePreservedAuthority(prepared)
  let authority = mode === 'collapse'
    ? acquireCommittedDaemonStartCollapseAuthority(prepared.options, inspectDaemonProtocol(prepared.options))
    : acquireDeadStartCleanup(prepared)
  const mutate = mode === 'collapse' ? collapseCommittedDaemonStart : cleanupAbandonedDaemonStart
  let injected = false
  assert.throws(() => mutate(authority, (name, facts) => {
    if (!injected && name === checkpointName && facts.label === label) {
      injected = true
      assertStrictIntermediate(prepared)
      assert.equal(fs.existsSync(facts.file), false)
      const abandonedCounterparts = new Map([
        ['daemon abandoned heartbeat projection', prepared.stage.files.heartbeat.file],
        ['daemon abandoned API PID projection', prepared.stage.files.apiPid.file],
        ['daemon abandoned PID projection', prepared.stage.files.pid.file]
      ])
      const collapseCounterparts = new Map([
        ['daemon collapse staged PID', prepared.fixture.paths.pidProjection],
        ['daemon collapse staged API PID', prepared.fixture.paths.apiPidProjection],
        ['daemon collapse staged heartbeat', prepared.fixture.paths.heartbeatProjection],
        ['daemon collapse staged instance', prepared.fixture.paths.finalInstance]
      ])
      const counterpart = mode === 'collapse'
        ? collapseCounterparts.get(label)
        : abandonedCounterparts.get(label)
      if (counterpart) assert.equal(fileState(counterpart).nlink, 1)
      throw new Error(`D1-A ${mode} ${checkpointName} cut`)
    }
  }), /D1-A .* cut/)
  assert.equal(injected, true)
  if (retry === 'fresh') {
    const intermediate = assertStrictIntermediate(prepared)
    authority = mode === 'collapse'
      ? acquireCommittedDaemonStartCollapseAuthority(prepared.options, intermediate)
      : acquireAbandonedDaemonStartCleanupAuthority(
          prepared.options,
          intermediate,
          () => ({ state: 'dead' })
        )
  }
  const terminal = mutate(authority)
  assert.equal(terminal.kind, mode === 'collapse' ? 'RUNNING-CLEAN' : 'ABSENT')
  assertStartReservationAbsent(prepared)
  assertPreservedAuthority(prepared, preserved)
}

test('daemon D1-A abandons a complete START in canonical reverse order and preserves namespace authority', (t) => {
  const prepared = createPreparedStartStage(t)
  publishProjectionPrefix(prepared.stage, 3)
  const frozen = inspectDaemonProtocol(prepared.options)
  assert.equal(frozen.kind, 'STARTING')
  const preserved = capturePreservedAuthority(prepared)
  const kinds = []
  const authority = acquireAbandonedDaemonStartCleanupAuthority(
    prepared.options,
    frozen,
    () => ({ state: 'dead' })
  )
  const terminal = cleanupAbandonedDaemonStart(authority, (name) => {
    if (name === 'daemon-file-unlinked' || name === 'daemon-directory-removed') {
      const current = inspectDaemonProtocol(prepared.options)
      kinds.push(current.kind)
      assert.notEqual(current.kind, 'INVALID', current.reason || '')
    }
  })
  assert.equal(terminal.kind, 'ABSENT')
  assert.deepEqual(kinds, [
    'STARTING', 'STARTING', 'STARTING',
    'STARTING-PARTIAL', 'STARTING-PARTIAL', 'STARTING-PARTIAL',
    'STARTING-PARTIAL', 'STARTING-PARTIAL', 'ABSENT'
  ])
  for (const file of [
    prepared.fixture.paths.pidProjection,
    prepared.fixture.paths.apiPidProjection,
    prepared.fixture.paths.heartbeatProjection,
    prepared.fixture.paths.finalInstance
  ]) assert.equal(fs.existsSync(file), false)
  assertStartReservationAbsent(prepared)
  assertPreservedAuthority(prepared, preserved)
})

for (const facts of [
  { name: 'alive-owner', value: { state: 'alive', processIdentity: `test-${process.pid}`, pgid: process.pid } },
  { name: 'unknown', value: { state: 'unknown' } },
  { name: 'pgid-mismatch', value: { state: 'alive', processIdentity: `test-${process.pid}`, pgid: process.pid + 1 } }
]) {
  test(`daemon D1-A refuses abandoned START cleanup for ${facts.name} actor facts without mutation`, (t) => {
    const prepared = createPreparedStartStage(t)
    publishProjectionPrefix(prepared.stage, 2)
    const frozen = inspectDaemonProtocol(prepared.options)
    const before = capturePreservedAuthority(prepared)
    const reservationBefore = fs.readdirSync(prepared.stage.reservationDirectory)
    assert.throws(() => acquireAbandonedDaemonStartCleanupAuthority(
      prepared.options,
      frozen,
      () => facts.value
    ), /live owner|unknown|PGID/)
    assert.deepEqual(fs.readdirSync(prepared.stage.reservationDirectory), reservationBefore)
    assert.equal(fs.existsSync(prepared.fixture.paths.pidProjection), true)
    assert.equal(fs.existsSync(prepared.fixture.paths.apiPidProjection), true)
    assertPreservedAuthority(prepared, before)
  })
}

for (const [name, pgid] of [['same-PGID', process.pid], ['different-PGID', process.pid + 1]]) {
  test(`daemon D1-A treats ${name} process-identity mismatch as proven PID reuse`, (t) => {
    const prepared = createPreparedStartStage(t)
    const frozen = inspectDaemonProtocol(prepared.options)
    const authority = acquireAbandonedDaemonStartCleanupAuthority(
      prepared.options,
      frozen,
      () => ({ state: 'alive', processIdentity: `reused-${process.pid}`, pgid })
    )
    assert.equal(authority.disposition, 'pid-reused')
    assert.equal(cleanupAbandonedDaemonStart(authority).kind, 'ABSENT')
  })
}

test('daemon D1-A cleanup authority keeps a private inspection after caller proof and options mutation', (t) => {
  const prepared = createPreparedStartStage(t)
  publishProjectionPrefix(prepared.stage, 1)
  const frozen = inspectDaemonProtocol(prepared.options)
  const authority = acquireAbandonedDaemonStartCleanupAuthority(
    prepared.options,
    frozen,
    () => ({ state: 'dead' })
  )
  const victim = path.join(prepared.fixture.home, 'foreign-victim.txt')
  fs.writeFileSync(victim, 'foreign-victim\n', { flag: 'wx' })
  const victimBefore = captureFileEvidence(victim)
  const stagedPid = frozen.proof.files.find((entry) => entry.file === prepared.stage.files.pid.file)
  assert.ok(stagedPid)
  Object.assign(stagedPid, captureDaemonFileForProof(victim))
  stagedPid.bytes.fill(0x58)
  const receiptProof = frozen.proof.receipt.receiptFile
  receiptProof.bytes.fill(0x59)
  receiptProof.state.ino += 1000
  frozen.proof.directories[0].entries.splice(0)
  frozen.proof.directories[0].state.ino += 1000
  frozen.proof.directoryIdentities[0].state.ino += 1000
  frozen.proof.absent.splice(0, frozen.proof.absent.length, victim)
  frozen.reservation.name = '.d1.caller-mutated'
  prepared.options.home = path.join(prepared.fixture.home, 'caller-mutated-home')
  prepared.options.dataRoot = path.join(prepared.fixture.home, 'caller-mutated-root')
  prepared.options.readReceiptAuthority = () => {
    throw new Error('caller-mutated receipt reader must not be used')
  }
  assert.equal(cleanupAbandonedDaemonStart(authority).kind, 'ABSENT')
  assertFileEvidence(victim, victimBefore)
  assertStartReservationAbsent(prepared)
})

test('daemon D1-A normalizes actor probe getters into one private fact record', (t) => {
  const prepared = createPreparedStartStage(t)
  const frozen = inspectDaemonProtocol(prepared.options)
  let stateReads = 0
  let identityReads = 0
  let pgidReads = 0
  const facts = {}
  Object.defineProperties(facts, {
    state: {
      enumerable: true,
      get() {
        stateReads += 1
        return stateReads === 1 ? 'alive' : 'unknown'
      }
    },
    processIdentity: {
      enumerable: true,
      get() {
        identityReads += 1
        return identityReads === 1 ? `reused-${process.pid}` : `test-${process.pid}`
      }
    },
    pgid: {
      enumerable: true,
      get() {
        pgidReads += 1
        return process.pid
      }
    }
  })
  const authority = acquireAbandonedDaemonStartCleanupAuthority(
    prepared.options,
    frozen,
    () => facts
  )
  assert.equal(authority.disposition, 'pid-reused')
  assert.deepEqual({ stateReads, identityReads, pgidReads }, { stateReads: 1, identityReads: 1, pgidReads: 1 })
  assert.equal(cleanupAbandonedDaemonStart(authority).kind, 'ABSENT')
})

test('daemon D1-A rejects array-shaped actor probe facts without mutation', (t) => {
  const prepared = createPreparedStartStage(t)
  const frozen = inspectDaemonProtocol(prepared.options)
  const facts = []
  facts.state = 'dead'
  const before = captureTreeEvidence(prepared.fixture.home)
  assert.throws(() => acquireAbandonedDaemonStartCleanupAuthority(
    prepared.options,
    frozen,
    () => facts
  ), /probe returned unknown authority/)
  assert.deepEqual(captureTreeEvidence(prepared.fixture.home), before)
})

for (const cut of ['daemon-file-unlinked', 'daemon-unlink-parent-fsynced']) {
  test(`daemon D1-A exact file unlink pins caller expected across ${cut} retry`, (t) => {
    const fixture = createActiveReceiptFixture(t)
    const removable = path.join(fixture.home, `primitive-file-${cut}`)
    const victim = path.join(fixture.home, `primitive-victim-${cut}`)
    fs.writeFileSync(removable, 'owned-removal\n', { flag: 'wx' })
    fs.writeFileSync(victim, 'foreign-victim\n', { flag: 'wx' })
    const expected = captureDaemonFileForProof(removable)
    const victimBefore = captureFileEvidence(victim)
    let injected = false
    assert.throws(() => unlinkDaemonFileExactDurable(expected, 'D1-A primitive file', (name) => {
      if (!injected && name === cut) {
        injected = true
        Object.assign(expected, captureDaemonFileForProof(victim))
        throw new Error(`mutable expected file ${cut}`)
      }
    }), /mutable expected file/)
    assert.equal(injected, true)
    assert.equal(fs.existsSync(removable), false)
    unlinkDaemonFileExactDurable(expected, 'D1-A primitive file')
    assert.equal(fs.existsSync(removable), false)
    assertFileEvidence(victim, victimBefore)
  })
}

test('daemon D1-A exact file unlink never exposes its pinned expected object to seal callbacks', (t) => {
  const fixture = createActiveReceiptFixture(t)
  const removable = path.join(fixture.home, 'primitive-file-seal-owned')
  const victim = path.join(fixture.home, 'primitive-file-seal-victim')
  fs.writeFileSync(removable, 'owned-removal\n', { flag: 'wx' })
  fs.writeFileSync(victim, 'foreign-victim\n', { flag: 'wx' })
  const expected = captureDaemonFileForProof(removable)
  const victimBefore = captureFileEvidence(victim)
  let callbackMutations = 0
  unlinkDaemonFileExactDurable(
    expected,
    'D1-A primitive defensive seal',
    () => {},
    (inFlight) => {
      if (inFlight) {
        callbackMutations += 1
        Object.assign(inFlight, captureDaemonFileForProof(victim))
        inFlight.bytes.fill(0x5a)
        inFlight.state.ino += 1000
      }
    }
  )
  assert.equal(callbackMutations, 2)
  assert.equal(fs.existsSync(removable), false)
  assertFileEvidence(victim, victimBefore)
})

for (const cut of ['daemon-directory-removed', 'daemon-directory-parent-fsynced']) {
  test(`daemon D1-A exact directory removal pins caller expected across ${cut} retry`, (t) => {
    const fixture = createActiveReceiptFixture(t)
    const removable = path.join(fixture.home, `primitive-directory-${cut}`)
    const victim = path.join(fixture.home, `primitive-directory-victim-${cut}`)
    fs.mkdirSync(removable)
    fs.mkdirSync(victim)
    fs.writeFileSync(path.join(victim, 'foreign.txt'), 'foreign\n', { flag: 'wx' })
    const expected = { directory: removable, state: fileState(removable), entries: [] }
    const victimBefore = captureTreeEvidence(victim)
    let injected = false
    assert.throws(() => removeDaemonDirectoryExactDurable(expected, 'D1-A primitive directory', (name) => {
      if (!injected && name === cut) {
        injected = true
        Object.assign(expected, { directory: victim, state: fileState(victim), entries: [] })
        throw new Error(`mutable expected directory ${cut}`)
      }
    }), /mutable expected directory/)
    assert.equal(injected, true)
    assert.equal(fs.existsSync(removable), false)
    removeDaemonDirectoryExactDurable(expected, 'D1-A primitive directory')
    assert.equal(fs.existsSync(removable), false)
    assert.deepEqual(captureTreeEvidence(victim), victimBefore)
  })
}

test('daemon D1-A probe-side same-byte replacement is rejected before cleanup authority is issued', (t) => {
  const prepared = createPreparedStartStage(t)
  const frozen = inspectDaemonProtocol(prepared.options)
  const source = prepared.stage.files.pid.file
  const original = captureFileEvidence(source)
  const parked = path.join(prepared.fixture.home, 'parked-probe-source')
  assert.throws(() => acquireAbandonedDaemonStartCleanupAuthority(
    prepared.options,
    frozen,
    () => {
      fs.renameSync(source, parked)
      fs.writeFileSync(source, original.bytes, { flag: 'wx' })
      return { state: 'dead' }
    }
  ), /changed|identity/)
  assert.notEqual(fileState(source).ino, original.stat.ino)
  assertFileEvidence(parked, original)
  assert.equal(fs.existsSync(prepared.stage.files.apiPid.file), true)
  assert.equal(fs.existsSync(prepared.fixture.paths.pidProjection), false)
})

test('daemon D1-A private cleanup epoch rejects receipt reader record drift before mutation', (t) => {
  const prepared = createPreparedStartStage(t)
  publishProjectionPrefix(prepared.stage, 2)
  const authority = acquireDeadStartCleanup(prepared)
  prepared.fixture.receipt.updatedAt = '2026-08-24T00:00:02.000Z'
  const before = captureTreeEvidence(prepared.fixture.home)
  assert.throws(() => cleanupAbandonedDaemonStart(authority), /receipt namespace changed/)
  assert.deepEqual(captureTreeEvidence(prepared.fixture.home), before)
})

test('daemon D1-A private reinspection is sandwiched by the caller frozen proof', (t) => {
  const prepared = createPreparedStartStage(t)
  const frozen = inspectDaemonProtocol(prepared.options)
  const inner = prepared.stage.authority.innerMarker.file
  const original = captureFileEvidence(inner)
  const parked = path.join(prepared.fixture.home, 'parked-private-inspection-inner')
  let injected = false
  const attackOptions = {
    ...prepared.options,
    readReceiptAuthority() {
      if (!injected) {
        injected = true
        fs.renameSync(inner, parked)
        fs.writeFileSync(inner, original.bytes, { flag: 'wx' })
      }
      return prepared.fixture.readReceiptAuthority()
    }
  }
  assert.throws(() => acquireAbandonedDaemonStartCleanupAuthority(
    attackOptions,
    frozen,
    () => ({ state: 'dead' })
  ), /changed|identity/)
  assert.equal(injected, true)
  assert.notEqual(fileState(inner).ino, original.stat.ino)
  assertFileEvidence(parked, original)
  assert.equal(fs.existsSync(prepared.stage.files.pid.file), true)
  assert.equal(fs.existsSync(prepared.fixture.paths.pidProjection), false)
})

test('daemon D1-A immediate private clone rejects a stateful old-fresh-old receipt reader sequence', (t) => {
  const prepared = createPreparedStartStage(t)
  const oldUpdatedAt = prepared.fixture.receipt.updatedAt
  const freshUpdatedAt = '2026-08-24T00:00:02.000Z'
  const sharedAuthority = prepared.fixture.readReceiptAuthority()
  let acquireCalls = 0
  let acquiring = false
  const statefulReader = () => {
    if (acquiring) {
      acquireCalls += 1
      sharedAuthority.receipt.updatedAt = acquireCalls === 2 ? freshUpdatedAt : oldUpdatedAt
    } else {
      sharedAuthority.receipt.updatedAt = oldUpdatedAt
    }
    return sharedAuthority
  }
  const options = { ...prepared.options, readReceiptAuthority: statefulReader }
  const frozen = inspectDaemonProtocol(options)
  const before = captureTreeEvidence(prepared.fixture.home)
  acquiring = true
  assert.throws(() => acquireAbandonedDaemonStartCleanupAuthority(
    options,
    frozen,
    () => ({ state: 'dead' })
  ), /changed while private mutation authority was captured/)
  acquiring = false
  sharedAuthority.receipt.updatedAt = oldUpdatedAt
  assert.equal(acquireCalls, 3)
  assert.deepEqual(captureTreeEvidence(prepared.fixture.home), before)
})

test('daemon D1-A collapses committed START aliases with manifest last and preserves public authority', (t) => {
  const prepared = createPreparedStartStage(t)
  completeStart(prepared.stage)
  const frozen = inspectDaemonProtocol(prepared.options)
  assert.equal(frozen.kind, 'RUNNING-LINKED')
  const preserved = capturePreservedAuthority(prepared)
  const publicBefore = {
    pid: captureFileEvidence(prepared.fixture.paths.pidProjection),
    apiPid: captureFileEvidence(prepared.fixture.paths.apiPidProjection),
    heartbeat: captureFileEvidence(prepared.fixture.paths.heartbeatProjection),
    final: captureFileEvidence(prepared.fixture.paths.finalInstance)
  }
  const kinds = []
  const authority = acquireCommittedDaemonStartCollapseAuthority(prepared.options, frozen)
  const terminal = collapseCommittedDaemonStart(authority, (name) => {
    if (name === 'daemon-file-unlinked' || name === 'daemon-directory-removed') {
      const current = inspectDaemonProtocol(prepared.options)
      kinds.push(current.kind)
      assert.notEqual(current.kind, 'INVALID', current.reason || '')
    }
  })
  assert.equal(terminal.kind, 'RUNNING-CLEAN')
  assert.deepEqual(kinds, [
    'RUNNING-COLLAPSING', 'RUNNING-COLLAPSING', 'RUNNING-COLLAPSING',
    'RUNNING-COLLAPSING', 'RUNNING-COLLAPSING', 'RUNNING-CLEAN'
  ])
  for (const [key, file] of Object.entries({
    pid: prepared.fixture.paths.pidProjection,
    apiPid: prepared.fixture.paths.apiPidProjection,
    heartbeat: prepared.fixture.paths.heartbeatProjection,
    final: prepared.fixture.paths.finalInstance
  })) {
    assertFileEvidence(file, { ...publicBefore[key], stat: { ...publicBefore[key].stat, nlink: 1 } })
  }
  assertStartReservationAbsent(prepared)
  assertPreservedAuthority(prepared, preserved)
})

for (const mode of ['abandoned', 'collapse']) {
  for (const cut of ['daemon-directory-removed', 'daemon-directory-parent-fsynced']) {
    test(`daemon D1-A ${mode} retries the same authority after ${cut}`, (t) => {
      const prepared = createPreparedStartStage(t)
      const authority = mode === 'collapse'
        ? (() => {
            completeStart(prepared.stage)
            return acquireCommittedDaemonStartCollapseAuthority(
              prepared.options,
              inspectDaemonProtocol(prepared.options)
            )
          })()
        : acquireAbandonedDaemonStartCleanupAuthority(
            prepared.options,
            inspectDaemonProtocol(prepared.options),
            () => ({ state: 'dead' })
          )
      let injected = false
      const mutate = mode === 'collapse' ? collapseCommittedDaemonStart : cleanupAbandonedDaemonStart
      assert.throws(() => mutate(authority, (name) => {
        if (!injected && name === cut) {
          injected = true
          throw new Error(`rmdir retry cut ${cut}`)
        }
      }), /rmdir retry cut/)
      assert.equal(injected, true)
      assert.equal(fs.existsSync(prepared.stage.reservationDirectory), false)
      const terminal = mutate(authority)
      assert.equal(terminal.kind, mode === 'collapse' ? 'RUNNING-CLEAN' : 'ABSENT')
      assertStartReservationAbsent(prepared)
    })
  }
}

for (const kind of ['ABSENT', 'RUNNING-CLEAN']) {
  test(`daemon D1-A terminal namespace durability settle is deletion-free for ${kind}`, (t) => {
    const prepared = createPreparedStartStage(t)
    if (kind === 'RUNNING-CLEAN') {
      completeStart(prepared.stage)
      const authority = acquireCommittedDaemonStartCollapseAuthority(
        prepared.options,
        inspectDaemonProtocol(prepared.options)
      )
      collapseCommittedDaemonStart(authority)
    } else {
      const authority = acquireAbandonedDaemonStartCleanupAuthority(
        prepared.options,
        inspectDaemonProtocol(prepared.options),
        () => ({ state: 'dead' })
      )
      cleanupAbandonedDaemonStart(authority)
    }
    const frozen = inspectDaemonProtocol(prepared.options)
    assert.equal(frozen.kind, kind)
    const before = capturePreservedAuthority(prepared)
    const runningPublicBefore = kind === 'RUNNING-CLEAN'
      ? [
          prepared.fixture.paths.pidProjection,
          prepared.fixture.paths.apiPidProjection,
          prepared.fixture.paths.heartbeatProjection,
          prepared.fixture.paths.finalInstance
        ].map((file) => ({ file, evidence: captureFileEvidence(file) }))
      : []
    let checkpointSeen = false
    const settled = settleDaemonTerminalNamespaceDurability(prepared.options, frozen, (name) => {
      if (name === 'daemon-terminal-stage-parent-fsynced') checkpointSeen = true
    })
    assert.equal(checkpointSeen, true)
    assert.equal(settled.kind, kind)
    assertPreservedAuthority(prepared, before)
    for (const entry of runningPublicBefore) assertFileEvidence(entry.file, entry.evidence)
  })
}

test('daemon D1-A same authority rejects staged-instance replacement after manifest unlink cut', (t) => {
  const prepared = createPreparedStartStage(t)
  publishProjectionPrefix(prepared.stage, 3)
  const authority = acquireDeadStartCleanup(prepared)
  let cut = false
  assert.throws(() => cleanupAbandonedDaemonStart(authority, (name, facts) => {
    if (!cut && name === 'daemon-file-unlinked' && facts.label === 'daemon abandoned start manifest') {
      cut = true
      throw new Error('D1-A manifest unlink replacement cut')
    }
  }), /manifest unlink replacement cut/)
  assert.equal(cut, true)
  assert.equal(fs.existsSync(prepared.stage.files.manifest.file), false)
  const instance = prepared.stage.files.instance.file
  const instanceBefore = captureFileEvidence(instance)
  const parked = path.join(prepared.fixture.home, 'parked-manifest-cut-instance')
  fs.renameSync(instance, parked)
  fs.writeFileSync(instance, instanceBefore.bytes, { flag: 'wx' })
  assert.notEqual(fileState(instance).ino, instanceBefore.stat.ino)
  const afterAttack = captureTreeEvidence(prepared.fixture.home)
  assert.throws(() => cleanupAbandonedDaemonStart(authority), /changed|bounded plain|frozen|identity/)
  assert.deepEqual(captureTreeEvidence(prepared.fixture.home), afterAttack)
  assertFileEvidence(parked, instanceBefore)
})

test('daemon D1-A collapse factory rejects a caller-forged RUNNING kind on STARTING proof', (t) => {
  const prepared = createPreparedStartStage(t)
  publishProjectionPrefix(prepared.stage, 2)
  const frozen = inspectDaemonProtocol(prepared.options)
  assert.equal(frozen.kind, 'STARTING')
  frozen.kind = 'RUNNING-COLLAPSING'
  const before = captureTreeEvidence(prepared.fixture.home)
  assert.throws(() => acquireCommittedDaemonStartCollapseAuthority(
    prepared.options,
    frozen
  ), /changed while private mutation authority was captured/)
  assert.deepEqual(captureTreeEvidence(prepared.fixture.home), before)
})

for (const [payloadName, payloadLabel] of START_PAYLOADS) {
  for (const [cutName, checkpointName] of START_WRITER_CUTS) {
    for (const disposition of ['dead', 'pid-reused']) {
      test(`daemon D1-A cleans ${payloadName} ${cutName} writer cut for ${disposition}`, (t) => {
        const prepared = createStartWriterCutFixture(t, payloadName, payloadLabel, checkpointName)
        const preserved = {
          receipt: captureFileEvidence(prepared.fixture.paths.receiptFile),
          business: captureFileEvidence(prepared.fixture.businessFile)
        }
        const authority = acquireAbandonedDaemonStartCleanupAuthority(
          prepared.options,
          prepared.inspection,
          () => disposition === 'dead'
            ? { state: 'dead' }
            : { state: 'alive', processIdentity: `reused-${process.pid}`, pgid: process.pid }
        )
        assert.equal(authority.disposition, disposition)
        assert.equal(cleanupAbandonedDaemonStart(authority).kind, 'ABSENT')
        assertStartReservationAbsent(prepared)
        assertFileEvidence(prepared.fixture.paths.receiptFile, preserved.receipt)
        assertFileEvidence(prepared.fixture.businessFile, preserved.business)
      })
    }
  }
}

for (const [payloadName, payloadLabel] of START_PAYLOADS) {
  for (const facts of [
    { name: 'alive-owner', value: { state: 'alive', processIdentity: `test-${process.pid}`, pgid: process.pid } },
    { name: 'unknown', value: { state: 'unknown' } }
  ]) {
    test(`daemon D1-A preserves ${payloadName} logical prefix for ${facts.name}`, (t) => {
      const prepared = createStartWriterCutFixture(
        t,
        payloadName,
        payloadLabel,
        'daemon-parent-fsynced'
      )
      const before = captureTreeEvidence(prepared.fixture.home)
      assert.throws(() => acquireAbandonedDaemonStartCleanupAuthority(
        prepared.options,
        prepared.inspection,
        () => facts.value
      ), /live owner|unknown/)
      assert.deepEqual(captureTreeEvidence(prepared.fixture.home), before)
    })
  }
}

for (let publicPrefix = 0; publicPrefix <= 3; publicPrefix += 1) {
  test(`daemon D1-A cleans complete START with public projection prefix ${publicPrefix}`, (t) => {
    const prepared = createPreparedStartStage(t)
    publishProjectionPrefix(prepared.stage, publicPrefix)
    const before = capturePreservedAuthority(prepared)
    assert.equal(cleanupAbandonedDaemonStart(acquireDeadStartCleanup(prepared)).kind, 'ABSENT')
    assertStartReservationAbsent(prepared)
    assertPreservedAuthority(prepared, before)
  })
}

const ABANDONED_REMOVAL_LABELS = [
  'daemon abandoned heartbeat projection',
  'daemon abandoned API PID projection',
  'daemon abandoned PID projection',
  'daemon abandoned start manifest',
  'daemon abandoned staged instance',
  'daemon abandoned staged heartbeat',
  'daemon abandoned staged API PID',
  'daemon abandoned staged PID'
]
const COLLAPSE_REMOVAL_LABELS = [
  'daemon collapse staged PID',
  'daemon collapse staged API PID',
  'daemon collapse staged heartbeat',
  'daemon collapse staged instance',
  'daemon collapse start manifest'
]

for (const [mode, labels] of [['abandoned', ABANDONED_REMOVAL_LABELS], ['collapse', COLLAPSE_REMOVAL_LABELS]]) {
  for (const label of labels) {
    for (const checkpointName of ['daemon-file-unlinked', 'daemon-unlink-parent-fsynced']) {
      for (const retry of ['same', 'fresh']) {
        test(`daemon D1-A ${mode} ${retry} retry after ${label} ${checkpointName}`, (t) => {
          runFileCutRetry(t, { mode, label, checkpointName, retry })
        })
      }
    }
  }
}

for (let mask = 0; mask < 16; mask += 1) {
  test(`daemon D1-A collapses RUNNING internal alias subset ${mask.toString(2).padStart(4, '0')}`, (t) => {
    const prepared = createPreparedStartStage(t)
    completeStart(prepared.stage)
    const keys = ['pid', 'apiPid', 'heartbeat', 'instance']
    keepRunningInternalSubset(prepared, keys.filter((_, index) => Boolean(mask & (1 << index))))
    const frozen = inspectDaemonProtocol(prepared.options)
    assert.ok(frozen.kind === 'RUNNING-LINKED' || frozen.kind === 'RUNNING-COLLAPSING', frozen.reason || '')
    const internalFiles = [
      prepared.stage.files.pid.file,
      prepared.stage.files.apiPid.file,
      prepared.stage.files.heartbeat.file,
      prepared.stage.files.instance.file
    ]
    const publicFiles = [
      prepared.fixture.paths.pidProjection,
      prepared.fixture.paths.apiPidProjection,
      prepared.fixture.paths.heartbeatProjection,
      prepared.fixture.paths.finalInstance
    ]
    for (let index = 0; index < internalFiles.length; index += 1) {
      const kept = Boolean(mask & (1 << index))
      assert.equal(fs.existsSync(internalFiles[index]), kept)
      assert.equal(fileState(publicFiles[index]).nlink, kept ? 2 : 1)
      if (kept) assert.equal(fileState(internalFiles[index]).ino, fileState(publicFiles[index]).ino)
    }
    const publicBefore = [
      prepared.fixture.paths.pidProjection,
      prepared.fixture.paths.apiPidProjection,
      prepared.fixture.paths.heartbeatProjection,
      prepared.fixture.paths.finalInstance
    ].map(captureFileEvidence)
    const terminal = collapseCommittedDaemonStart(
      acquireCommittedDaemonStartCollapseAuthority(prepared.options, frozen)
    )
    assert.equal(terminal.kind, 'RUNNING-CLEAN')
    for (const [index, file] of [
      prepared.fixture.paths.pidProjection,
      prepared.fixture.paths.apiPidProjection,
      prepared.fixture.paths.heartbeatProjection,
      prepared.fixture.paths.finalInstance
    ].entries()) {
      assertFileEvidence(file, { ...publicBefore[index], stat: { ...publicBefore[index].stat, nlink: 1 } })
    }
    assertStartReservationAbsent(prepared)
  })
}

for (const mode of ['abandoned', 'collapse']) {
  for (const cut of ['daemon-directory-removed', 'daemon-directory-parent-fsynced']) {
    test(`daemon D1-A ${mode} fresh terminal settle after ${cut}`, (t) => {
      const prepared = createPreparedStartStage(t)
      if (mode === 'collapse') completeStart(prepared.stage)
      const authority = mode === 'collapse'
        ? acquireCommittedDaemonStartCollapseAuthority(prepared.options, inspectDaemonProtocol(prepared.options))
        : acquireDeadStartCleanup(prepared)
      const mutate = mode === 'collapse' ? collapseCommittedDaemonStart : cleanupAbandonedDaemonStart
      let injected = false
      assert.throws(() => mutate(authority, (name) => {
        if (!injected && name === cut) {
          injected = true
          throw new Error(`fresh terminal cut ${cut}`)
        }
      }), /fresh terminal cut/)
      const terminalFrozen = inspectDaemonProtocol(prepared.options)
      assert.equal(terminalFrozen.kind, mode === 'collapse' ? 'RUNNING-CLEAN' : 'ABSENT')
      let settled = false
      const terminal = settleDaemonTerminalNamespaceDurability(prepared.options, terminalFrozen, (name) => {
        if (name === 'daemon-terminal-stage-parent-fsynced') settled = true
      })
      assert.equal(settled, true)
      assert.equal(terminal.kind, terminalFrozen.kind)
      assertStartReservationAbsent(prepared)
    })
  }
}

for (const attack of ['source', 'target', 'manifest', 'reservation']) {
  test(`daemon D1-A collapse rejects same-byte new-inode ${attack} replacement before mutation`, (t) => {
    const prepared = createPreparedStartStage(t)
    completeStart(prepared.stage)
    const authority = acquireCommittedDaemonStartCollapseAuthority(
      prepared.options,
      inspectDaemonProtocol(prepared.options)
    )
    let originalPath
    let parked
    if (attack === 'source') {
      originalPath = prepared.stage.files.pid.file
      parked = path.join(prepared.fixture.home, 'parked-collapse-source')
    } else if (attack === 'target') {
      originalPath = prepared.fixture.paths.pidProjection
      parked = path.join(prepared.fixture.home, 'parked-collapse-target')
    } else if (attack === 'manifest') {
      originalPath = prepared.stage.files.manifest.file
      parked = path.join(prepared.fixture.home, 'parked-collapse-manifest')
    } else {
      originalPath = prepared.stage.reservationDirectory
      parked = path.join(prepared.fixture.home, 'parked-collapse-reservation')
    }
    if (attack === 'reservation') {
      fs.renameSync(originalPath, parked)
      fs.mkdirSync(originalPath)
    } else {
      const bytes = fs.readFileSync(originalPath)
      fs.renameSync(originalPath, parked)
      fs.writeFileSync(originalPath, bytes, { flag: 'wx' })
    }
    assert.notEqual(fileState(originalPath).ino, fileState(parked).ino)
    const afterAttack = captureTreeEvidence(prepared.fixture.home)
    assert.throws(() => collapseCommittedDaemonStart(authority), /changed|identity|frozen|hardlink|inventory|bounded plain/)
    assert.deepEqual(captureTreeEvidence(prepared.fixture.home), afterAttack)
  })
}

test('daemon D1-A terminal fresh inspection rejects an inner-marker replacement from its receipt reader', (t) => {
  const prepared = createPreparedStartStage(t)
  const inner = prepared.stage.authority.innerMarker.file
  const original = captureFileEvidence(inner)
  const parked = path.join(prepared.fixture.home, 'parked-terminal-inner')
  let injected = false
  const baseReader = prepared.fixture.readReceiptAuthority
  prepared.options.readReceiptAuthority = () => {
    if (!injected && !fs.existsSync(prepared.stage.reservationDirectory)
      && /inspectDaemonProtocol/.test(new Error().stack || '')) {
      injected = true
      fs.renameSync(inner, parked)
      fs.writeFileSync(inner, original.bytes, { flag: 'wx' })
    }
    return baseReader()
  }
  const authority = acquireAbandonedDaemonStartCleanupAuthority(
    prepared.options,
    inspectDaemonProtocol(prepared.options),
    () => ({ state: 'dead' })
  )
  assert.throws(() => cleanupAbandonedDaemonStart(authority), /changed|identity/)
  assert.equal(injected, true)
  assert.notEqual(fileState(inner).ino, original.stat.ino)
  assertFileEvidence(parked, original)
  assert.equal(fs.existsSync(prepared.stage.reservationDirectory), false)
})

test('daemon D1-A terminal settle private reinspection rejects same-byte inner-marker replacement', (t) => {
  const prepared = createPreparedStartStage(t)
  cleanupAbandonedDaemonStart(acquireDeadStartCleanup(prepared))
  const frozen = inspectDaemonProtocol(prepared.options)
  const inner = prepared.stage.authority.innerMarker.file
  const original = captureFileEvidence(inner)
  const parked = path.join(prepared.fixture.home, 'parked-terminal-settle-inner')
  let injected = false
  const attackOptions = {
    ...prepared.options,
    readReceiptAuthority() {
      if (!injected) {
        injected = true
        fs.renameSync(inner, parked)
        fs.writeFileSync(inner, original.bytes, { flag: 'wx' })
      }
      return prepared.fixture.readReceiptAuthority()
    }
  }
  assert.throws(() => settleDaemonTerminalNamespaceDurability(attackOptions, frozen), /changed|identity/)
  assert.equal(injected, true)
  assert.notEqual(fileState(inner).ino, original.stat.ino)
  assertFileEvidence(parked, original)
})

test('daemon D1-A terminal settle rejects receipt reader record drift after its checkpoint', (t) => {
  const prepared = createPreparedStartStage(t)
  cleanupAbandonedDaemonStart(acquireDeadStartCleanup(prepared))
  const frozen = inspectDaemonProtocol(prepared.options)
  const before = captureTreeEvidence(prepared.fixture.home)
  assert.throws(() => settleDaemonTerminalNamespaceDurability(prepared.options, frozen, (name) => {
    if (name === 'daemon-terminal-stage-parent-fsynced') {
      prepared.fixture.receipt.updatedAt = '2026-08-24T00:00:02.000Z'
    }
  }), /receipt namespace changed|changed during durability settle/)
  assert.deepEqual(captureTreeEvidence(prepared.fixture.home), before)
})

test('daemon D1-A rejects wrong and non-actionable kinds without mutation or actor probing', (t) => {
  const cases = [
    {
      name: 'ABSENT',
      setup: () => {
        const fixture = createActiveReceiptFixture(t)
        bootstrapCurrent(fixture)
        return { fixture, options: daemonOptions(fixture) }
      }
    },
    {
      name: 'RUNNING-CLEAN',
      setup: () => {
        const prepared = createPreparedStartStage(t)
        completeStart(prepared.stage)
        collapseCommittedDaemonStart(acquireCommittedDaemonStartCollapseAuthority(
          prepared.options,
          inspectDaemonProtocol(prepared.options)
        ))
        return prepared
      }
    },
    { name: 'STOPPING-PARTIAL', setup: () => createStopPartialFixture(t) },
    { name: 'LEGACY-RETIRING-PARTIAL', setup: () => createLegacyRetirePartialFixture(t) },
    {
      name: 'INVALID',
      setup: () => {
        const prepared = createPreparedStartStage(t)
        fs.writeFileSync(path.join(prepared.fixture.paths.stageDirectory, 'foreign-entry'), 'foreign')
        return prepared
      }
    }
  ]
  for (const row of cases) {
    const prepared = row.setup()
    const frozen = inspectDaemonProtocol(prepared.options)
    assert.equal(frozen.kind, row.name, frozen.reason || '')
    const before = captureTreeEvidence(prepared.fixture.home)
    let probes = 0
    assert.throws(() => acquireAbandonedDaemonStartCleanupAuthority(
      prepared.options,
      frozen,
      () => {
        probes += 1
        return { state: 'dead' }
      }
    ), /requires STARTING|invalid daemon protocol state|stage namespace/)
    assert.equal(probes, 0)
    assert.throws(() => acquireCommittedDaemonStartCollapseAuthority(
      prepared.options,
      frozen
    ), /requires RUNNING|invalid daemon protocol state|stage namespace/)
    assert.deepEqual(captureTreeEvidence(prepared.fixture.home), before)
  }
})

test('daemon D1-A mutation APIs reject caller-constructed structural authorities', (t) => {
  const prepared = createPreparedStartStage(t)
  const before = captureTreeEvidence(prepared.fixture.home)
  assert.throws(() => cleanupAbandonedDaemonStart({
    kind: 'ABANDONED-START-CLEANUP',
    disposition: 'dead'
  }), /was not issued/)
  assert.throws(() => collapseCommittedDaemonStart({ kind: 'COMMITTED-START-COLLAPSE' }), /was not issued/)
  assert.deepEqual(captureTreeEvidence(prepared.fixture.home), before)
})
