import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  DAEMON_INSTANCE_MAX_BYTES,
  DAEMON_STAGE_MANIFEST_MAX_BYTES,
  DAEMON_START_STAGE_PAYLOADS,
  assertDaemonInspectionCurrent,
  assertDaemonStageNamespaceAuthority,
  bootstrapDaemonStageNamespace,
  captureDaemonProtocolFile,
  commitDaemonStartInstance,
  createDaemonStartStage,
  daemonFileIdentity,
  daemonInstanceRecordBytes,
  daemonProtocolPaths,
  daemonReservationName,
  daemonStageManifestBytes,
  inspectDaemonProtocol,
  inspectDaemonReceiptNamespace,
  inspectDaemonStageNamespaceAuthority,
  isDaemonActionableControlInspection,
  parseDaemonInstanceRecord,
  parseDaemonStageManifest,
  publishDaemonStartProjection,
  recoverDaemonStartStage,
  validateDaemonInstanceRecord,
  validateDaemonStageManifest
} from '../dist/control/daemon-protocol.js'

const UUIDS = {
  install: '11111111-1111-4111-8111-111111111111',
  data: '22222222-2222-4222-8222-222222222222',
  namespace: '33333333-3333-4333-8333-333333333333',
  epoch: '44444444-4444-4444-8444-444444444444',
  stop: '55555555-5555-4555-8555-555555555555',
  legacy: '66666666-6666-4666-8666-666666666666'
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

function assertFileEvidence(file, expected) {
  assert.deepEqual(captureFileEvidence(file), expected)
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function captureTreeEvidence(root) {
  const result = []
  const visit = (entry, relative) => {
    const stat = fs.lstatSync(entry)
    const kind = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : 'other'
    result.push({
      relative,
      kind,
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

function heartbeatProjectionBytes(fixture) {
  return Buffer.from(`${JSON.stringify({
    pid: process.pid,
    apiPid: process.pid,
    hubRoot: fixture.dataRoot,
    packageRoot: fixture.packageRoot,
    dataRoot: fixture.dataRoot,
    port: 18765,
    apiHealthy: true,
    lastBeat: CREATED_AT
  }, null, 2)}\n`, 'utf8')
}

function writeLegacyProjectionSubset(fixture, subset) {
  const files = {
    pid: fixture.paths.pidProjection,
    apiPid: fixture.paths.apiPidProjection,
    heartbeat: fixture.paths.heartbeatProjection
  }
  const bytes = {
    pid: Buffer.from(`${process.pid}\n`, 'utf8'),
    apiPid: Buffer.from(`${process.pid}\n`, 'utf8'),
    heartbeat: heartbeatProjectionBytes(fixture)
  }
  for (const key of subset) fs.writeFileSync(files[key], bytes[key], { flag: 'wx' })
  return Object.fromEntries(subset.map((key) => [key, captureFileEvidence(files[key])]))
}

function assertLegacyProjectionEvidence(fixture, expected) {
  const files = {
    pid: fixture.paths.pidProjection,
    apiPid: fixture.paths.apiPidProjection,
    heartbeat: fixture.paths.heartbeatProjection
  }
  for (const [key, evidence] of Object.entries(expected)) assertFileEvidence(files[key], evidence)
}

function createActiveReceiptFixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-protocol-d0-'))
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
  return { home, dataRoot, packageRoot, installDir, receipt, paths, readReceiptAuthority }
}

function daemonOptions(fixture) {
  return {
    home: fixture.home,
    dataRoot: fixture.dataRoot,
    readReceiptAuthority: fixture.readReceiptAuthority
  }
}

function bootstrapCurrent(fixture, namespaceId = UUIDS.namespace, checkpoint) {
  const options = daemonOptions(fixture)
  const expectedInspection = inspectDaemonProtocol(options)
  const expectedReceiptAuthority = inspectDaemonReceiptNamespace(
    fixture.home,
    fixture.dataRoot,
    fixture.readReceiptAuthority
  )
  return bootstrapDaemonStageNamespace({
    ...options,
    expectedInspection,
    expectedReceiptAuthority,
    namespaceId,
    checkpoint
  })
}

function createPreparedStartStage(t) {
  const fixture = createActiveReceiptFixture(t)
  const options = daemonOptions(fixture)
  const initial = inspectDaemonProtocol(options)
  assert.equal(initial.kind, 'ABSENT')
  const receipt = inspectDaemonReceiptNamespace(
    fixture.home,
    fixture.dataRoot,
    fixture.readReceiptAuthority
  )
  const authority = bootstrapDaemonStageNamespace({
    ...options,
    expectedInspection: initial,
    expectedReceiptAuthority: receipt,
    namespaceId: UUIDS.namespace
  })
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

function completeStart(stage) {
  publishDaemonStartProjection(stage, 'pid')
  publishDaemonStartProjection(stage, 'apiPid')
  publishDaemonStartProjection(stage, 'heartbeat')
  return commitDaemonStartInstance(stage)
}

function controlManifestFromStart(stage, operation) {
  const instance = stage.instance
  const operationId = operation === 'stop' ? UUIDS.stop : UUIDS.legacy
  const actor = {
    pid: instance.pid,
    processIdentity: instance.processIdentity,
    pgid: instance.pgid,
    createdAt: CREATED_AT
  }
  const binding = {
    stageNamespaceId: instance.stageNamespaceId,
    receiptSha256: instance.receiptSha256,
    installId: instance.installId,
    dataRootId: instance.dataRootId,
    operationId,
    actorPid: actor.pid,
    actorProcessIdentity: actor.processIdentity,
    actorPgid: actor.pgid,
    operation,
    packageSha256: instance.packageSha256,
    createdAt: actor.createdAt
  }
  const common = {
    schemaVersion: 1,
    product: 'skill-graft',
    operation,
    reservationName: daemonReservationName(binding),
    stageNamespaceId: binding.stageNamespaceId,
    receiptSha256: binding.receiptSha256,
    installId: binding.installId,
    dataRootId: binding.dataRootId,
    operationId,
    packageRoot: instance.packageRoot,
    packageVersion: instance.packageVersion,
    packageSha256: instance.packageSha256,
    dataRoot: instance.dataRoot,
    actor,
    roots: stage.manifest.roots,
    lifecycleOwnerBinding: null
  }
  if (operation === 'stop') {
    return {
      ...common,
      target: {
        instance: stage.manifest.instance,
        projections: stage.manifest.projections,
        epochId: instance.epochId,
        pid: instance.pid,
        apiPid: instance.apiPid,
        processIdentity: instance.processIdentity,
        pgid: instance.pgid,
        port: instance.port,
        processTree: [{ pid: instance.pid, processIdentity: instance.processIdentity }]
      }
    }
  }
  return {
    ...common,
    target: {
      projections: stage.manifest.projections,
      pid: instance.pid,
      apiPid: instance.apiPid,
      processIdentity: instance.processIdentity,
      pgid: instance.pgid,
      port: instance.port,
      processTree: [{ pid: instance.pid, processIdentity: instance.processIdentity }]
    }
  }
}

function directoryIdentity(directory) {
  const stat = fs.lstatSync(directory)
  return { dev: String(stat.dev), ino: String(stat.ino) }
}

function removePathIfPresent(file) {
  if (fs.existsSync(file)) fs.unlinkSync(file)
}

function collapseStartReservation(stage, keepInternal = []) {
  const keep = new Set(keepInternal)
  const entries = {
    pid: stage.files.pid.file,
    apiPid: stage.files.apiPid.file,
    heartbeat: stage.files.heartbeat.file,
    instance: stage.files.instance.file
  }
  for (const [key, file] of Object.entries(entries)) {
    if (!keep.has(key)) removePathIfPresent(file)
  }
  if (!keep.has('manifest')) removePathIfPresent(stage.files.manifest.file)
  if (fs.existsSync(stage.reservationDirectory)
    && fs.readdirSync(stage.reservationDirectory).length === 0) {
    fs.rmdirSync(stage.reservationDirectory)
  }
}

function createStopFixture(t, publicSubset, { complete = true, finalPresent = true } = {}) {
  const prepared = createPreparedStartStage(t)
  completeStart(prepared.stage)
  collapseStartReservation(prepared.stage)
  const manifest = controlManifestFromStart(prepared.stage, 'stop')
  const reservationDirectory = path.join(prepared.fixture.paths.stageDirectory, manifest.reservationName)
  fs.mkdirSync(reservationDirectory)
  manifest.roots = {
    ...manifest.roots,
    reservation: directoryIdentity(reservationDirectory)
  }
  const normalized = validateDaemonStageManifest(manifest)
  if (complete) {
    fs.writeFileSync(
      path.join(reservationDirectory, 'stage-manifest-v1.json'),
      daemonStageManifestBytes(normalized),
      { flag: 'wx' }
    )
  }
  const keep = new Set(publicSubset)
  if (!keep.has('pid')) removePathIfPresent(prepared.fixture.paths.pidProjection)
  if (!keep.has('apiPid')) removePathIfPresent(prepared.fixture.paths.apiPidProjection)
  if (!keep.has('heartbeat')) removePathIfPresent(prepared.fixture.paths.heartbeatProjection)
  if (!finalPresent) removePathIfPresent(prepared.fixture.paths.finalInstance)
  return { ...prepared, manifest: normalized, reservationDirectory }
}

function createLegacyFixture(t, subset, { complete = false } = {}) {
  const fixture = createActiveReceiptFixture(t)
  writeLegacyProjectionSubset(fixture, subset)
  const options = daemonOptions(fixture)
  const authority = bootstrapCurrent(fixture)
  const receipt = authority.receipt.receipt
  const actor = {
    pid: process.pid,
    processIdentity: `test-${process.pid}`,
    pgid: process.pid,
    createdAt: CREATED_AT
  }
  const binding = {
    stageNamespaceId: authority.namespaceId,
    receiptSha256: authority.receipt.receiptSha256,
    installId: receipt.installId,
    dataRootId: receipt.dataRootId,
    operationId: UUIDS.legacy,
    actorPid: actor.pid,
    actorProcessIdentity: actor.processIdentity,
    actorPgid: actor.pgid,
    operation: 'legacy-retire',
    packageSha256: receipt.packageSha256,
    createdAt: actor.createdAt
  }
  const reservationName = daemonReservationName(binding)
  const reservationDirectory = path.join(fixture.paths.stageDirectory, reservationName)
  fs.mkdirSync(reservationDirectory)
  const projectionFiles = {
    pid: subset.includes('pid')
      ? captureDaemonProtocolFile(fixture.paths.pidProjection, 128, 'legacy PID') : null,
    apiPid: subset.includes('apiPid')
      ? captureDaemonProtocolFile(fixture.paths.apiPidProjection, 128, 'legacy API PID') : null,
    heartbeat: subset.includes('heartbeat')
      ? captureDaemonProtocolFile(fixture.paths.heartbeatProjection, DAEMON_INSTANCE_MAX_BYTES, 'legacy heartbeat') : null
  }
  const manifest = validateDaemonStageManifest({
    schemaVersion: 1,
    product: 'skill-graft',
    operation: 'legacy-retire',
    reservationName,
    stageNamespaceId: authority.namespaceId,
    receiptSha256: authority.receipt.receiptSha256,
    installId: receipt.installId,
    dataRootId: receipt.dataRootId,
    operationId: UUIDS.legacy,
    packageRoot: receipt.packageRoot,
    packageVersion: receipt.packageVersion,
    packageSha256: receipt.packageSha256,
    dataRoot: receipt.dataRoot,
    actor,
    roots: {
      dataRoot: directoryIdentity(fixture.paths.dataRoot),
      review: directoryIdentity(fixture.paths.reviewDirectory),
      stage: directoryIdentity(fixture.paths.stageDirectory),
      reservation: directoryIdentity(reservationDirectory)
    },
    lifecycleOwnerBinding: null,
    target: {
      projections: {
        pid: projectionFiles.pid ? daemonFileIdentity(projectionFiles.pid) : null,
        apiPid: projectionFiles.apiPid ? daemonFileIdentity(projectionFiles.apiPid) : null,
        heartbeat: projectionFiles.heartbeat ? daemonFileIdentity(projectionFiles.heartbeat) : null
      },
      pid: process.pid,
      apiPid: process.pid,
      processIdentity: actor.processIdentity,
      pgid: actor.pgid,
      port: 18765,
      processTree: [{ pid: process.pid, processIdentity: actor.processIdentity }]
    }
  })
  if (complete) {
    fs.writeFileSync(
      path.join(reservationDirectory, 'stage-manifest-v1.json'),
      daemonStageManifestBytes(manifest),
      { flag: 'wx' }
    )
  }
  return { fixture, options, authority, manifest, reservationDirectory, projectionFiles }
}

function assertReadOnlyInspection(fixture, expected) {
  const before = captureTreeEvidence(fixture.home)
  const inspection = inspectDaemonProtocol(daemonOptions(fixture))
  assert.equal(inspection.kind, expected.kind, inspection.reason || '')
  if (expected.publicProjectionCount !== undefined) {
    assert.equal(inspection.publicProjectionCount, expected.publicProjectionCount)
  }
  if (expected.stagePayloadCount !== undefined) {
    assert.equal(inspection.stagePayloadCount, expected.stagePayloadCount)
  }
  if (expected.recoveryAuthority !== undefined) {
    assert.equal(inspection.recoveryAuthority, expected.recoveryAuthority)
  }
  if (inspection.kind === 'INVALID') assert.throws(() => assertDaemonInspectionCurrent(inspection))
  else assertDaemonInspectionCurrent(inspection)
  assert.deepEqual(captureTreeEvidence(fixture.home), before)
  return inspection
}

test('daemon D0 normal start publishes the exact projection prefix and final instance', (t) => {
  const { options, stage } = createPreparedStartStage(t)
  completeStart(stage)
  const running = inspectDaemonProtocol(options)
  assert.equal(running.kind, 'RUNNING-LINKED')
  assert.equal(running.publicProjectionCount, 3)
  assertDaemonInspectionCurrent(running)
})

for (const phase of ['daemon-hardlink-created', 'daemon-hardlink-parent-fsynced']) {
  test(`daemon D0 same-process retry seals a pending projection after ${phase}`, (t) => {
    const { options, stage } = createPreparedStartStage(t)
    let cut = false
    assert.throws(() => publishDaemonStartProjection(stage, 'pid', (name) => {
      if (!cut && name === phase) {
        cut = true
        throw new Error(`projection cut at ${phase}`)
      }
    }), /projection cut/)
    assert.equal(cut, true)
    publishDaemonStartProjection(stage, 'pid')
    publishDaemonStartProjection(stage, 'apiPid')
    publishDaemonStartProjection(stage, 'heartbeat')
    commitDaemonStartInstance(stage)
    assert.equal(inspectDaemonProtocol(options).kind, 'RUNNING-LINKED')
  })

  test(`daemon D0 same-process retry seals a pending final instance after ${phase}`, (t) => {
    const { options, stage } = createPreparedStartStage(t)
    publishDaemonStartProjection(stage, 'pid')
    publishDaemonStartProjection(stage, 'apiPid')
    publishDaemonStartProjection(stage, 'heartbeat')
    let cut = false
    assert.throws(() => commitDaemonStartInstance(stage, (name) => {
      if (!cut && name === phase) {
        cut = true
        throw new Error(`final cut at ${phase}`)
      }
    }), /final cut/)
    assert.equal(cut, true)
    commitDaemonStartInstance(stage)
    assert.equal(inspectDaemonProtocol(options).kind, 'RUNNING-LINKED')
  })
}

test('daemon D0 canonical schemas reject noncanonical instance, start, stop, and legacy records', (t) => {
  const { stage } = createPreparedStartStage(t)
  assert.deepEqual(validateDaemonInstanceRecord(clone(stage.instance)), stage.instance)
  assert.deepEqual(validateDaemonStageManifest(clone(stage.manifest)), stage.manifest)
  assert.equal(daemonInstanceRecordBytes(stage.instance).at(-1), 0x0a)
  assert.equal(daemonStageManifestBytes(stage.manifest).at(-1), 0x0a)

  assert.throws(() => validateDaemonInstanceRecord({ ...clone(stage.instance), extra: true }), /keys/)
  const badApiPid = clone(stage.instance)
  badApiPid.apiPid += 1
  assert.throws(() => validateDaemonInstanceRecord(badApiPid), /one process identity/)
  const leadingZeroFile = clone(stage.instance)
  leadingZeroFile.authority.receipt.dev = '00'
  assert.throws(() => validateDaemonInstanceRecord(leadingZeroFile), /file identity/)
  const leadingZeroRoot = clone(stage.instance)
  leadingZeroRoot.authority.dataRoot.ino = '01'
  assert.throws(() => validateDaemonInstanceRecord(leadingZeroRoot), /directory identity/)
  const arbitraryInventory = clone(stage.instance)
  arbitraryInventory.authority.receiptInventory = ['a', 'b', 'c']
  assert.throws(() => validateDaemonInstanceRecord(arbitraryInventory), /receipt inventory/)

  assert.throws(() => validateDaemonStageManifest({ ...clone(stage.manifest), extra: true }), /keys/)
  const wrongStartReservation = clone(stage.manifest)
  wrongStartReservation.operationId = UUIDS.stop
  assert.throws(() => validateDaemonStageManifest(wrongStartReservation), /reservation/)
  const invalidVersion = clone(stage.instance)
  invalidVersion.epochId = '44444444-4444-0444-8444-444444444444'
  assert.throws(() => validateDaemonInstanceRecord(invalidVersion), /canonical UUID/)
  const invalidVariant = clone(stage.manifest)
  invalidVariant.operationId = '44444444-4444-4444-7444-444444444444'
  assert.throws(() => validateDaemonStageManifest(invalidVariant), /canonical UUID/)
  const invalidHyphen = clone(stage.instance)
  invalidHyphen.stageNamespaceId = '3333333-33333-4333-8333-333333333333'
  assert.throws(() => validateDaemonInstanceRecord(invalidHyphen), /canonical UUID/)

  const stop = controlManifestFromStart(stage, 'stop')
  assert.deepEqual(validateDaemonStageManifest(clone(stop)), stop)
  assert.equal(daemonStageManifestBytes(stop).at(-1), 0x0a)
  const stopExtra = { ...clone(stop), unexpected: null }
  assert.throws(() => validateDaemonStageManifest(stopExtra), /keys/)
  const stopWrongApi = clone(stop)
  stopWrongApi.target.apiPid += 1
  assert.throws(() => validateDaemonStageManifest(stopWrongApi), /one v1 daemon\/API process/)
  const stopDuplicateTree = clone(stop)
  stopDuplicateTree.target.processTree.push(clone(stopDuplicateTree.target.processTree[0]))
  assert.throws(() => validateDaemonStageManifest(stopDuplicateTree), /uniquely PID-sorted/)

  const legacy = controlManifestFromStart(stage, 'legacy-retire')
  assert.deepEqual(validateDaemonStageManifest(clone(legacy)), legacy)
  assert.equal(daemonStageManifestBytes(legacy).at(-1), 0x0a)
  assert.throws(() => validateDaemonStageManifest({ ...clone(legacy), extra: true }), /keys/)
  const legacyEmpty = clone(legacy)
  legacyEmpty.target.projections = { pid: null, apiPid: null, heartbeat: null }
  assert.throws(() => validateDaemonStageManifest(legacyEmpty), /already-absent/)

  const oversized = path.join(stage.reservationDirectory, 'oversized.json')
  fs.writeFileSync(oversized, Buffer.alloc(DAEMON_INSTANCE_MAX_BYTES + 1, 0x61), { flag: 'wx' })
  assert.throws(
    () => captureDaemonProtocolFile(oversized, DAEMON_INSTANCE_MAX_BYTES, 'oversized daemon instance'),
    /bounded plain protocol file/
  )
  assert.ok(DAEMON_STAGE_MANIFEST_MAX_BYTES <= DAEMON_INSTANCE_MAX_BYTES)
})

const BOOTSTRAP_CUTS = [
  ['home-exclusive-created', 'daemon-exclusive-created', 'daemon HOME stage authority'],
  ['home-written', 'daemon-file-written', 'daemon HOME stage authority'],
  ['home-file-fsynced', 'daemon-file-fsynced', 'daemon HOME stage authority'],
  ['home-readback', 'daemon-file-readback', 'daemon HOME stage authority'],
  ['home-parent-fsynced', 'daemon-parent-fsynced', 'daemon HOME stage authority'],
  ['home-authority', 'daemon-bootstrap-home-authority', null],
  ['stage-directory-created', 'daemon-bootstrap-stage-directory-created', null],
  ['stage-directory-parent-fsynced', 'daemon-bootstrap-stage-directory-parent-fsynced', null],
  ['inner-exclusive-created', 'daemon-exclusive-created', 'daemon stage inner marker'],
  ['inner-written', 'daemon-file-written', 'daemon stage inner marker'],
  ['inner-file-fsynced', 'daemon-file-fsynced', 'daemon stage inner marker'],
  ['inner-readback', 'daemon-file-readback', 'daemon stage inner marker'],
  ['inner-parent-fsynced', 'daemon-parent-fsynced', 'daemon stage inner marker'],
  ['inner-marker', 'daemon-bootstrap-inner-marker', null]
]

for (const mode of ['ABSENT', 'LEGACY']) {
  for (const [cutName, checkpointName, expectedLabel] of BOOTSTRAP_CUTS) {
    test(`daemon D0 ${mode} bootstrap resumes the ${cutName} durability cut`, (t) => {
      const fixture = createActiveReceiptFixture(t)
      const legacyEvidence = mode === 'LEGACY'
        ? writeLegacyProjectionSubset(fixture, ['pid', 'apiPid', 'heartbeat'])
        : {}
      const options = daemonOptions(fixture)
      const initial = inspectDaemonProtocol(options)
      assert.equal(initial.kind, mode, initial.reason || '')
      const receipt = inspectDaemonReceiptNamespace(fixture.home, fixture.dataRoot, fixture.readReceiptAuthority)
      let cut = false
      assert.throws(() => bootstrapDaemonStageNamespace({
        ...options,
        expectedInspection: initial,
        expectedReceiptAuthority: receipt,
        namespaceId: UUIDS.namespace,
        checkpoint(name, facts) {
          if (!cut && name === checkpointName && (expectedLabel === null || facts.label === expectedLabel)) {
            cut = true
            throw new Error(`bootstrap cut ${cutName}`)
          }
        }
      }), /bootstrap cut/)
      assert.equal(cut, true)

      const cutInspection = inspectDaemonProtocol(options)
      assert.notEqual(cutInspection.kind, 'INVALID', cutInspection.reason || '')
      assertDaemonInspectionCurrent(cutInspection)
      const authority = bootstrapCurrent(fixture)
      assertDaemonStageNamespaceAuthority(authority)
      const recovered = inspectDaemonProtocol(options)
      assert.equal(recovered.kind, mode === 'LEGACY' ? 'LEGACY-NAMESPACE-RECOVERABLE' : 'ABSENT')
      assertDaemonInspectionCurrent(recovered)
      assertLegacyProjectionEvidence(fixture, legacyEvidence)
    })
  }
}

for (const mode of ['ABSENT', 'LEGACY']) {
  test(`daemon D0 ${mode} bootstrap resumes an existing-stage parent-fsync cut`, (t) => {
    const fixture = createActiveReceiptFixture(t)
    const legacyEvidence = mode === 'LEGACY'
      ? writeLegacyProjectionSubset(fixture, ['pid', 'apiPid', 'heartbeat'])
      : {}
    const options = daemonOptions(fixture)
    const initial = inspectDaemonProtocol(options)
    const receipt = inspectDaemonReceiptNamespace(fixture.home, fixture.dataRoot, fixture.readReceiptAuthority)
    assert.throws(() => bootstrapDaemonStageNamespace({
      ...options,
      expectedInspection: initial,
      expectedReceiptAuthority: receipt,
      namespaceId: UUIDS.namespace,
      checkpoint(name) {
        if (name === 'daemon-bootstrap-stage-directory-created') throw new Error('leave existing stage')
      }
    }), /leave existing stage/)
    const stagedCut = inspectDaemonProtocol(options)
    assert.notEqual(stagedCut.kind, 'INVALID', stagedCut.reason || '')
    const stagedReceipt = inspectDaemonReceiptNamespace(fixture.home, fixture.dataRoot, fixture.readReceiptAuthority)
    let cut = false
    assert.throws(() => bootstrapDaemonStageNamespace({
      ...options,
      expectedInspection: stagedCut,
      expectedReceiptAuthority: stagedReceipt,
      namespaceId: UUIDS.namespace,
      checkpoint(name) {
        if (!cut && name === 'daemon-bootstrap-existing-stage-parent-fsynced') {
          cut = true
          throw new Error('existing-stage parent-fsync cut')
        }
      }
    }), /existing-stage parent-fsync cut/)
    assert.equal(cut, true)
    const authority = bootstrapCurrent(fixture)
    assertDaemonStageNamespaceAuthority(authority)
    const recovered = inspectDaemonProtocol(options)
    assert.equal(recovered.kind, mode === 'LEGACY' ? 'LEGACY-NAMESPACE-RECOVERABLE' : 'ABSENT')
    assertLegacyProjectionEvidence(fixture, legacyEvidence)
  })
}

const LEGACY_SUBSETS = [
  ['pid'],
  ['apiPid'],
  ['heartbeat'],
  ['pid', 'apiPid'],
  ['pid', 'heartbeat'],
  ['apiPid', 'heartbeat'],
  ['pid', 'apiPid', 'heartbeat']
]

for (const subset of LEGACY_SUBSETS) {
  test(`daemon D0 bootstrap preserves the canonical legacy subset ${subset.join('+')}`, (t) => {
    const fixture = createActiveReceiptFixture(t)
    const expected = writeLegacyProjectionSubset(fixture, subset)
    const before = inspectDaemonProtocol(daemonOptions(fixture))
    assert.equal(before.kind, 'LEGACY', before.reason || '')
    assert.equal(before.publicProjectionCount, subset.length)
    assertDaemonInspectionCurrent(before)
    const authority = bootstrapCurrent(fixture)
    assertDaemonStageNamespaceAuthority(authority)
    const after = inspectDaemonProtocol(daemonOptions(fixture))
    assert.equal(after.kind, 'LEGACY-NAMESPACE-RECOVERABLE')
    assert.equal(after.publicProjectionCount, subset.length)
    assertDaemonInspectionCurrent(after)
    assertLegacyProjectionEvidence(fixture, expected)
  })
}

for (const checkpointName of [
  'daemon-start-reservation-directory-created',
  'daemon-start-reservation-parent-fsynced'
]) {
  test(`daemon D0 freezes an empty start reservation at ${checkpointName}`, (t) => {
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
      checkpoint(name) {
        if (!cut && name === checkpointName) {
          cut = true
          throw new Error(`reservation cut ${checkpointName}`)
        }
      }
    }), /reservation cut/)
    assert.equal(cut, true)
    const partial = inspectDaemonProtocol(options)
    assert.equal(partial.kind, 'STARTING-PARTIAL')
    assert.equal(partial.stagePayloadCount, 0)
    assert.equal(partial.publicProjectionCount, 0)
    assertDaemonInspectionCurrent(partial)
  })
}

test('daemon D0 validates all start options before creating its reservation', (t) => {
  const fixture = createActiveReceiptFixture(t)
  const authority = bootstrapCurrent(fixture)
  const before = captureTreeEvidence(fixture.home)
  assert.throws(() => createDaemonStartStage(authority, {
    epochId: UUIDS.epoch,
    pid: process.pid,
    apiPid: process.pid + 1,
    processIdentity: `test-${process.pid}`,
    pgid: process.pid,
    port: 18765,
    createdAt: CREATED_AT
  }), /API PID/)
  assert.deepEqual(captureTreeEvidence(fixture.home), before)
})

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

for (const [payloadName, payloadLabel] of START_PAYLOADS) {
  const payloadIndex = DAEMON_START_STAGE_PAYLOADS.indexOf(payloadName)
  for (const [cutName, checkpointName] of START_WRITER_CUTS) {
    test(`daemon D0 classifies ${payloadName} at its ${cutName} writer cut`, (t) => {
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
            throw new Error(`${payloadName} cut at ${cutName}`)
          }
        }
      }), new RegExp(`${payloadName.replaceAll('.', '\\.')} cut`))
      assert.equal(cut, true)
      const inspection = inspectDaemonProtocol(options)
      const manifestIsCanonical = payloadName === 'stage-manifest-v1.json' && cutName !== 'created'
      assert.equal(inspection.kind, manifestIsCanonical ? 'STARTING' : 'STARTING-PARTIAL', inspection.reason || '')
      assert.equal(inspection.stagePayloadCount, payloadIndex + 1)
      assert.equal(inspection.publicProjectionCount, 0)
      assertDaemonInspectionCurrent(inspection)
      assert.deepEqual(
        fs.readdirSync(path.join(fixture.paths.stageDirectory, inspection.reservation.name))
          .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))),
        DAEMON_START_STAGE_PAYLOADS.slice(0, payloadIndex + 1)
          .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
      )
    })
  }
}

for (const [cutName, checkpointName] of START_WRITER_CUTS.filter(([name]) => name !== 'created')) {
  test(`daemon D0 settles a structurally complete manifest ${cutName} cut before its first public link`, (t) => {
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
        if (!cut && name === checkpointName && facts.label === 'daemon start stage manifest') {
          cut = true
          throw new Error(`manifest durability source cut ${cutName}`)
        }
      }
    }), /manifest durability source cut/)
    const structural = inspectDaemonProtocol(options)
    assert.equal(structural.kind, 'STARTING')
    const events = []
    const recovered = recoverDaemonStartStage(options, structural, (name, facts) => {
      events.push(`${name}:${facts.payload || ''}`)
    })
    publishDaemonStartProjection(recovered, 'pid', (name) => events.push(name))
    const firstLink = events.indexOf('daemon-hardlink-created')
    const directoryBarrier = events.indexOf('daemon-stage-durability-reservation-fsynced:')
    assert.equal(events.filter((entry) => entry.startsWith('daemon-stage-durability-file-fsynced:')).length, 5)
    assert.ok(directoryBarrier >= 5, events.join('\n'))
    assert.ok(firstLink > directoryBarrier, events.join('\n'))
    publishDaemonStartProjection(recovered, 'apiPid')
    publishDaemonStartProjection(recovered, 'heartbeat')
    commitDaemonStartInstance(recovered)
    assert.equal(inspectDaemonProtocol(options).kind, 'RUNNING-LINKED')
  })
}

for (const payload of [...DAEMON_START_STAGE_PAYLOADS, null]) {
  const checkpointName = payload
    ? 'daemon-stage-durability-file-fsynced'
    : 'daemon-stage-durability-reservation-fsynced'
  test(`daemon D0 recovery reenters after the ${payload || 'reservation directory'} durability barrier cut`, (t) => {
    const { options } = createPreparedStartStage(t)
    const frozen = inspectDaemonProtocol(options)
    assert.equal(frozen.kind, 'STARTING')
    let cut = false
    assert.throws(() => recoverDaemonStartStage(options, frozen, (name, facts) => {
      if (!cut && name === checkpointName && (payload === null || facts.payload === payload)) {
        cut = true
        throw new Error(`stage durability cut ${payload || 'directory'}`)
      }
    }), /stage durability cut/)
    assert.equal(cut, true)
    const afterCut = inspectDaemonProtocol(options)
    assert.equal(afterCut.kind, 'STARTING')
    assertDaemonInspectionCurrent(afterCut)
    const recovered = recoverDaemonStartStage(options, afterCut)
    completeStart(recovered)
    assert.equal(inspectDaemonProtocol(options).kind, 'RUNNING-LINKED')
  })
}

test('daemon D0 durability barrier rejects a same-byte staged-file replacement before publication', (t) => {
  const { options, stage } = createPreparedStartStage(t)
  const frozen = inspectDaemonProtocol(options)
  let replacement = null
  assert.throws(() => recoverDaemonStartStage(options, frozen, (name, facts) => {
    if (name !== 'daemon-stage-durability-file-fsynced' || facts.payload !== 'daemon.pid' || replacement) return
    const bytes = fs.readFileSync(stage.files.apiPid.file)
    fs.unlinkSync(stage.files.apiPid.file)
    fs.writeFileSync(stage.files.apiPid.file, bytes, { flag: 'wx' })
    replacement = captureFileEvidence(stage.files.apiPid.file)
  }), /changed|frozen|inode|reservation/)
  assert.ok(replacement)
  assertFileEvidence(stage.files.apiPid.file, replacement)
  assert.equal(fs.existsSync(stage.authority.paths.pidProjection), false)
  assert.equal(fs.existsSync(stage.authority.paths.apiPidProjection), false)
  assert.equal(fs.existsSync(stage.authority.paths.heartbeatProjection), false)
  assert.equal(fs.existsSync(stage.authority.paths.finalInstance), false)
})

test('daemon D0 durability barrier rejects a same-name reservation replacement before publication', (t) => {
  const { options, stage } = createPreparedStartStage(t)
  const frozen = inspectDaemonProtocol(options)
  const parked = `${stage.reservationDirectory}.parked`
  let replacement = null
  assert.throws(() => recoverDaemonStartStage(options, frozen, (name) => {
    if (name !== 'daemon-stage-durability-reservation-fsynced' || replacement) return
    fs.renameSync(stage.reservationDirectory, parked)
    fs.mkdirSync(stage.reservationDirectory)
    replacement = fileState(stage.reservationDirectory)
  }), /changed|frozen|identity|reservation/)
  assert.ok(replacement)
  assert.deepEqual(fileState(stage.reservationDirectory), replacement)
  assert.equal(fs.existsSync(parked), true)
  assert.equal(fs.existsSync(stage.authority.paths.pidProjection), false)
  assert.equal(fs.existsSync(stage.authority.paths.apiPidProjection), false)
  assert.equal(fs.existsSync(stage.authority.paths.heartbeatProjection), false)
  assert.equal(fs.existsSync(stage.authority.paths.finalInstance), false)
})

test('daemon D0 INVALID inspection is report-only and cannot become mutation authority', (t) => {
  const fixture = createActiveReceiptFixture(t)
  bootstrapCurrent(fixture)
  const foreign = path.join(fixture.paths.stageDirectory, 'foreign-child')
  fs.writeFileSync(foreign, 'foreign', { flag: 'wx' })
  const invalid = inspectDaemonProtocol(daemonOptions(fixture))
  assert.equal(invalid.kind, 'INVALID')
  assert.match(invalid.reason || '', /foreign|inner marker|reservation/)
  const receipt = inspectDaemonReceiptNamespace(fixture.home, fixture.dataRoot, fixture.readReceiptAuthority)
  const before = captureTreeEvidence(fixture.home)
  assert.throws(() => assertDaemonInspectionCurrent(invalid), /foreign|invalid|authority|reservation/)
  assert.throws(() => bootstrapDaemonStageNamespace({
    ...daemonOptions(fixture),
    expectedInspection: invalid,
    expectedReceiptAuthority: receipt,
    namespaceId: UUIDS.namespace
  }), /bootstrap requires|foreign|invalid/)
  assert.throws(
    () => inspectDaemonStageNamespaceAuthority(daemonOptions(fixture), invalid),
    /foreign|recoverable|invalid|multiple|non-directory/
  )
  assert.throws(() => recoverDaemonStartStage(daemonOptions(fixture), invalid), /frozen complete start-stage topology/)
  assert.equal(isDaemonActionableControlInspection(invalid), false)
  assert.deepEqual(captureTreeEvidence(fixture.home), before)
})

test('daemon D0 inspection ignores more than ten thousand unrelated review children', (t) => {
  const fixture = createActiveReceiptFixture(t)
  for (let index = 0; index < 10_001; index += 1) {
    fs.writeFileSync(path.join(fixture.paths.reviewDirectory, `unrelated-${String(index).padStart(5, '0')}`), '')
  }
  const inspection = inspectDaemonProtocol(daemonOptions(fixture))
  assert.equal(inspection.kind, 'ABSENT')
  assertDaemonInspectionCurrent(inspection)
})

test('daemon D0 bootstrap tolerates unrelated review mutation but preserves the child exactly', (t) => {
  const fixture = createActiveReceiptFixture(t)
  const options = daemonOptions(fixture)
  const initial = inspectDaemonProtocol(options)
  const receipt = inspectDaemonReceiptNamespace(fixture.home, fixture.dataRoot, fixture.readReceiptAuthority)
  const unrelated = path.join(fixture.paths.reviewDirectory, 'unrelated-session.json')
  let expected = null
  const authority = bootstrapDaemonStageNamespace({
    ...options,
    expectedInspection: initial,
    expectedReceiptAuthority: receipt,
    namespaceId: UUIDS.namespace,
    checkpoint(name) {
      if (name === 'daemon-bootstrap-stage-directory-created' && !expected) {
        fs.writeFileSync(unrelated, '{"foreign":true}\n', { flag: 'wx' })
        expected = captureFileEvidence(unrelated)
      }
    }
  })
  assert.ok(expected)
  assertDaemonStageNamespaceAuthority(authority)
  assertFileEvidence(unrelated, expected)
  assert.equal(inspectDaemonProtocol(options).kind, 'ABSENT')
})

function leaveHomeNamespaceRecoverable(t, legacy = false) {
  const fixture = createActiveReceiptFixture(t)
  if (legacy) writeLegacyProjectionSubset(fixture, ['pid'])
  const options = daemonOptions(fixture)
  const initial = inspectDaemonProtocol(options)
  const receipt = inspectDaemonReceiptNamespace(fixture.home, fixture.dataRoot, fixture.readReceiptAuthority)
  assert.throws(() => bootstrapDaemonStageNamespace({
    ...options,
    expectedInspection: initial,
    expectedReceiptAuthority: receipt,
    namespaceId: UUIDS.namespace,
    checkpoint(name) {
      if (name === 'daemon-bootstrap-home-authority') throw new Error('namespace cut')
    }
  }), /namespace cut/)
  return fixture
}

function createStartingPartialFixture(t) {
  const fixture = createActiveReceiptFixture(t)
  const authority = bootstrapCurrent(fixture)
  assert.throws(() => createDaemonStartStage(authority, {
    epochId: UUIDS.epoch,
    pid: process.pid,
    apiPid: process.pid,
    processIdentity: `test-${process.pid}`,
    pgid: process.pid,
    port: 18765,
    createdAt: CREATED_AT,
    checkpoint(name) {
      if (name === 'daemon-start-reservation-directory-created') throw new Error('partial cut')
    }
  }), /partial cut/)
  return fixture
}

const TOPOLOGY_CASES = [
  {
    kind: 'ABSENT', publicProjectionCount: 0, stagePayloadCount: 0, recoveryAuthority: 'NONE',
    setup: (t) => createActiveReceiptFixture(t)
  },
  {
    kind: 'NAMESPACE-RECOVERABLE', publicProjectionCount: 0, stagePayloadCount: 0, recoveryAuthority: 'NONE',
    setup: (t) => leaveHomeNamespaceRecoverable(t)
  },
  {
    kind: 'LEGACY-NAMESPACE-RECOVERABLE', publicProjectionCount: 1, stagePayloadCount: 0,
    recoveryAuthority: 'NONE', setup: (t) => leaveHomeNamespaceRecoverable(t, true)
  },
  {
    kind: 'STARTING-PARTIAL', publicProjectionCount: 0, stagePayloadCount: 0, recoveryAuthority: 'NONE',
    setup: (t) => createStartingPartialFixture(t)
  },
  {
    kind: 'STARTING', publicProjectionCount: 0, stagePayloadCount: 5, recoveryAuthority: 'START',
    setup: (t) => createPreparedStartStage(t).fixture
  },
  {
    kind: 'RUNNING-LINKED', publicProjectionCount: 3, stagePayloadCount: 5, recoveryAuthority: 'START',
    setup(t) {
      const prepared = createPreparedStartStage(t)
      completeStart(prepared.stage)
      return prepared.fixture
    }
  },
  {
    kind: 'RUNNING-COLLAPSING', publicProjectionCount: 3, stagePayloadCount: 4, recoveryAuthority: 'START',
    setup(t) {
      const prepared = createPreparedStartStage(t)
      completeStart(prepared.stage)
      collapseStartReservation(prepared.stage, ['apiPid', 'heartbeat', 'instance', 'manifest'])
      return prepared.fixture
    }
  },
  {
    kind: 'RUNNING-CLEAN', publicProjectionCount: 3, stagePayloadCount: 0, recoveryAuthority: 'NONE',
    setup(t) {
      const prepared = createPreparedStartStage(t)
      completeStart(prepared.stage)
      collapseStartReservation(prepared.stage)
      return prepared.fixture
    }
  },
  {
    kind: 'STOPPING-PARTIAL', publicProjectionCount: 3, stagePayloadCount: 0, recoveryAuthority: 'NONE',
    setup: (t) => createStopFixture(t, ['pid', 'apiPid', 'heartbeat'], { complete: false }).fixture
  },
  {
    kind: 'STOPPING', publicProjectionCount: 3, stagePayloadCount: 1, recoveryAuthority: 'STOP',
    setup: (t) => createStopFixture(t, ['pid', 'apiPid', 'heartbeat']).fixture
  },
  {
    kind: 'LEGACY-RETIRING-PARTIAL', publicProjectionCount: 3, stagePayloadCount: 0, recoveryAuthority: 'NONE',
    setup: (t) => createLegacyFixture(t, ['pid', 'apiPid', 'heartbeat']).fixture
  },
  {
    kind: 'LEGACY-RETIRING', publicProjectionCount: 3, stagePayloadCount: 1,
    recoveryAuthority: 'LEGACY-RETIRE',
    setup: (t) => createLegacyFixture(t, ['pid', 'apiPid', 'heartbeat'], { complete: true }).fixture
  },
  {
    kind: 'LEGACY', publicProjectionCount: 1, stagePayloadCount: 0, recoveryAuthority: 'NONE',
    setup(t) {
      const fixture = createActiveReceiptFixture(t)
      writeLegacyProjectionSubset(fixture, ['heartbeat'])
      return fixture
    }
  },
  {
    kind: 'INVALID', publicProjectionCount: 0, stagePayloadCount: 0, recoveryAuthority: 'NONE',
    setup(t) {
      const fixture = createActiveReceiptFixture(t)
      bootstrapCurrent(fixture)
      fs.writeFileSync(path.join(fixture.paths.stageDirectory, 'foreign'), 'foreign', { flag: 'wx' })
      return fixture
    }
  }
]

for (const topology of TOPOLOGY_CASES) {
  test(`daemon D0 topology table classifies ${topology.kind} read-only`, (t) => {
    const fixture = topology.setup(t)
    const inspection = assertReadOnlyInspection(fixture, topology)
    assert.equal(isDaemonActionableControlInspection(inspection),
      topology.kind === 'STOPPING' || topology.kind === 'LEGACY-RETIRING')
  })
}

const START_INTERNAL_ALIASES = ['pid', 'apiPid', 'heartbeat', 'instance']

for (let mask = 0; mask < 16; mask += 1) {
  const kept = START_INTERNAL_ALIASES.filter((_, index) => (mask & (1 << index)) !== 0)
  const expectedKind = kept.length === START_INTERNAL_ALIASES.length ? 'RUNNING-LINKED' : 'RUNNING-COLLAPSING'
  test(`daemon D0 ${expectedKind} accepts original-or-absent aliases ${kept.join('+') || 'none'}`, (t) => {
    const prepared = createPreparedStartStage(t)
    completeStart(prepared.stage)
    collapseStartReservation(prepared.stage, [...kept, 'manifest'])
    const inspection = assertReadOnlyInspection(prepared.fixture, {
      kind: expectedKind,
      publicProjectionCount: 3,
      stagePayloadCount: kept.length + 1,
      recoveryAuthority: 'START'
    })
    assert.equal(inspection.manifest?.operation, 'start')
  })
}

for (const alias of START_INTERNAL_ALIASES) {
  test(`daemon D0 rejects manifest-first collapse while the ${alias} alias remains`, (t) => {
    const prepared = createPreparedStartStage(t)
    completeStart(prepared.stage)
    collapseStartReservation(prepared.stage, [alias])
    const inspection = assertReadOnlyInspection(prepared.fixture, { kind: 'INVALID' })
    assert.match(inspection.reason || '', /manifest disappeared/)
  })

  test(`daemon D0 rejects a same-byte replacement of the internal ${alias} alias`, (t) => {
    const prepared = createPreparedStartStage(t)
    completeStart(prepared.stage)
    const file = prepared.stage.files[alias].file
    const bytes = fs.readFileSync(file)
    fs.unlinkSync(file)
    fs.writeFileSync(file, bytes, { flag: 'wx' })
    const replacement = captureFileEvidence(file)
    const inspection = assertReadOnlyInspection(prepared.fixture, { kind: 'INVALID' })
    assert.match(inspection.reason || '', /hardlink|identity|topology|projection|instance/)
    assertFileEvidence(file, replacement)
  })
}

test('daemon D0 RUNNING collapse keeps its manifest last through the empty-reservation cut', (t) => {
  const prepared = createPreparedStartStage(t)
  completeStart(prepared.stage)
  const aliases = [
    prepared.stage.files.pid.file,
    prepared.stage.files.apiPid.file,
    prepared.stage.files.heartbeat.file,
    prepared.stage.files.instance.file
  ]
  for (const [index, file] of aliases.entries()) {
    fs.unlinkSync(file)
    assertReadOnlyInspection(prepared.fixture, {
      kind: 'RUNNING-COLLAPSING',
      publicProjectionCount: 3,
      stagePayloadCount: 4 - index,
      recoveryAuthority: 'START'
    })
  }
  fs.unlinkSync(prepared.stage.files.manifest.file)
  assertReadOnlyInspection(prepared.fixture, {
    kind: 'RUNNING-COLLAPSING',
    publicProjectionCount: 3,
    stagePayloadCount: 0,
    recoveryAuthority: 'START'
  })
  fs.rmdirSync(prepared.stage.reservationDirectory)
  assertReadOnlyInspection(prepared.fixture, {
    kind: 'RUNNING-CLEAN',
    publicProjectionCount: 3,
    stagePayloadCount: 0,
    recoveryAuthority: 'NONE'
  })
})

const PUBLIC_SUBSETS = Array.from({ length: 8 }, (_, mask) =>
  ['pid', 'apiPid', 'heartbeat'].filter((_, index) => (mask & (1 << index)) !== 0))

for (const subset of PUBLIC_SUBSETS) {
  test(`daemon D0 complete STOP recognizes final plus ${subset.join('+') || 'no'} projection`, (t) => {
    const stopped = createStopFixture(t, subset)
    const inspection = assertReadOnlyInspection(stopped.fixture, {
      kind: 'STOPPING',
      publicProjectionCount: subset.length,
      stagePayloadCount: 1,
      recoveryAuthority: 'STOP'
    })
    assert.equal(isDaemonActionableControlInspection(inspection), true)
  })
}

test('daemon D0 partial STOP is non-actionable while its complete target remains intact', (t) => {
  const stopped = createStopFixture(t, ['pid', 'apiPid', 'heartbeat'], { complete: false })
  const inspection = assertReadOnlyInspection(stopped.fixture, {
    kind: 'STOPPING-PARTIAL',
    publicProjectionCount: 3,
    stagePayloadCount: 0,
    recoveryAuthority: 'NONE'
  })
  assert.equal(isDaemonActionableControlInspection(inspection), false)
})

test('daemon D0 rejects a partial STOP whose target changed before manifest durability', (t) => {
  const stopped = createStopFixture(t, ['pid', 'heartbeat'], { complete: false })
  const inspection = assertReadOnlyInspection(stopped.fixture, { kind: 'INVALID' })
  assert.match(inspection.reason || '', /incomplete running target/)
})

for (const subset of PUBLIC_SUBSETS.filter((value) => value.length > 0)) {
  test(`daemon D0 rejects final-absent STOP with residual ${subset.join('+')}`, (t) => {
    const stopped = createStopFixture(t, subset, { finalPresent: false })
    const inspection = assertReadOnlyInspection(stopped.fixture, { kind: 'INVALID' })
    assert.match(inspection.reason || '', /removed final before its projections/)
  })
}

test('daemon D0 complete STOP recognizes the final-and-projections-absent terminal cut', (t) => {
  const stopped = createStopFixture(t, [], { finalPresent: false })
  const inspection = assertReadOnlyInspection(stopped.fixture, {
    kind: 'STOPPING',
    publicProjectionCount: 0,
    stagePayloadCount: 1,
    recoveryAuthority: 'STOP'
  })
  assert.equal(isDaemonActionableControlInspection(inspection), true)
})

test('daemon D0 STOP proof rejects a missing projection that reappears after inspection', (t) => {
  const stopped = createStopFixture(t, ['pid'])
  const inspection = inspectDaemonProtocol(stopped.options)
  assert.equal(inspection.kind, 'STOPPING')
  const replacementBytes = stopped.stage.files.apiPid.bytes
  fs.writeFileSync(stopped.fixture.paths.apiPidProjection, replacementBytes, { flag: 'wx' })
  const replacement = captureFileEvidence(stopped.fixture.paths.apiPidProjection)
  assert.throws(() => assertDaemonInspectionCurrent(inspection), /reappeared/)
  assertFileEvidence(stopped.fixture.paths.apiPidProjection, replacement)
})

function rewriteLegacyManifest(legacy, value) {
  const file = path.join(legacy.reservationDirectory, 'stage-manifest-v1.json')
  fs.unlinkSync(file)
  const normalized = validateDaemonStageManifest(value)
  fs.writeFileSync(file, daemonStageManifestBytes(normalized), { flag: 'wx' })
  legacy.manifest = normalized
}

for (const subset of LEGACY_SUBSETS) {
  test(`daemon D0 complete LEGACY-RETIRING binds the canonical target subset ${subset.join('+')}`, (t) => {
    const legacy = createLegacyFixture(t, subset, { complete: true })
    const inspection = assertReadOnlyInspection(legacy.fixture, {
      kind: 'LEGACY-RETIRING',
      publicProjectionCount: subset.length,
      stagePayloadCount: 1,
      recoveryAuthority: 'LEGACY-RETIRE'
    })
    assert.equal(isDaemonActionableControlInspection(inspection), true)
  })
}

test('daemon D0 partial LEGACY-RETIRING is non-actionable before manifest durability', (t) => {
  const legacy = createLegacyFixture(t, ['pid', 'apiPid', 'heartbeat'])
  const inspection = assertReadOnlyInspection(legacy.fixture, {
    kind: 'LEGACY-RETIRING-PARTIAL',
    publicProjectionCount: 3,
    stagePayloadCount: 0,
    recoveryAuthority: 'NONE'
  })
  assert.equal(isDaemonActionableControlInspection(inspection), false)
})

for (const present of PUBLIC_SUBSETS) {
  test(`daemon D0 LEGACY-RETIRING accepts original-or-absent target ${present.join('+') || 'none'}`, (t) => {
    const legacy = createLegacyFixture(t, ['pid', 'apiPid', 'heartbeat'], { complete: true })
    const keep = new Set(present)
    if (!keep.has('pid')) fs.unlinkSync(legacy.fixture.paths.pidProjection)
    if (!keep.has('apiPid')) fs.unlinkSync(legacy.fixture.paths.apiPidProjection)
    if (!keep.has('heartbeat')) fs.unlinkSync(legacy.fixture.paths.heartbeatProjection)
    const inspection = assertReadOnlyInspection(legacy.fixture, {
      kind: 'LEGACY-RETIRING',
      publicProjectionCount: present.length,
      stagePayloadCount: 1,
      recoveryAuthority: 'LEGACY-RETIRE'
    })
    assert.equal(isDaemonActionableControlInspection(inspection), true)
  })
}

test('daemon D0 rejects LEGACY-RETIRING whose target PID names another process', (t) => {
  const legacy = createLegacyFixture(t, ['pid', 'apiPid', 'heartbeat'], { complete: true })
  const manifest = clone(legacy.manifest)
  manifest.target.pid = process.pid + 10_000
  manifest.target.processIdentity = `other-${process.pid}`
  manifest.target.processTree = [
    { pid: process.pid, processIdentity: `test-${process.pid}` },
    { pid: process.pid + 10_000, processIdentity: `other-${process.pid}` }
  ]
  rewriteLegacyManifest(legacy, manifest)
  const inspection = assertReadOnlyInspection(legacy.fixture, { kind: 'INVALID' })
  assert.match(inspection.reason || '', /PID projection does not bind its target/)
})

test('daemon D0 rejects LEGACY-RETIRING whose target port mismatches heartbeat', (t) => {
  const legacy = createLegacyFixture(t, ['heartbeat'], { complete: true })
  const manifest = clone(legacy.manifest)
  manifest.target.port += 1
  rewriteLegacyManifest(legacy, manifest)
  const inspection = assertReadOnlyInspection(legacy.fixture, { kind: 'INVALID' })
  assert.match(inspection.reason || '', /heartbeat projection does not bind its target/)
})

test('daemon D0 rejects LEGACY-RETIRING whose canonical heartbeat names another root', (t) => {
  const legacy = createLegacyFixture(t, ['heartbeat'], { complete: true })
  const wrongRoot = path.join(legacy.fixture.home, 'other-data')
  fs.mkdirSync(wrongRoot)
  fs.unlinkSync(legacy.fixture.paths.heartbeatProjection)
  fs.writeFileSync(legacy.fixture.paths.heartbeatProjection, Buffer.from(`${JSON.stringify({
    pid: process.pid,
    apiPid: process.pid,
    hubRoot: wrongRoot,
    packageRoot: legacy.fixture.packageRoot,
    dataRoot: wrongRoot,
    port: 18765,
    apiHealthy: true,
    lastBeat: CREATED_AT
  }, null, 2)}\n`), { flag: 'wx' })
  const replacement = captureDaemonProtocolFile(
    legacy.fixture.paths.heartbeatProjection,
    DAEMON_INSTANCE_MAX_BYTES,
    'wrong-root legacy heartbeat'
  )
  const manifest = clone(legacy.manifest)
  manifest.target.projections.heartbeat = daemonFileIdentity(replacement)
  rewriteLegacyManifest(legacy, manifest)
  const inspection = assertReadOnlyInspection(legacy.fixture, { kind: 'INVALID' })
  assert.match(inspection.reason || '', /heartbeat projection does not bind its target/)
})

test('daemon D0 rejects LEGACY-RETIRING whose target projection digest is wrong', (t) => {
  const legacy = createLegacyFixture(t, ['pid'], { complete: true })
  const manifest = clone(legacy.manifest)
  manifest.target.projections.pid.sha256 = `sha256:${'b'.repeat(64)}`
  rewriteLegacyManifest(legacy, manifest)
  const inspection = assertReadOnlyInspection(legacy.fixture, { kind: 'INVALID' })
  assert.match(inspection.reason || '', /does not match.*identity|identity does not match/)
})

test('daemon D0 rejects malformed LEGACY projection bytes without mutation', (t) => {
  const legacy = createLegacyFixture(t, ['pid'], { complete: true })
  fs.unlinkSync(legacy.fixture.paths.pidProjection)
  fs.writeFileSync(legacy.fixture.paths.pidProjection, 'not-a-pid\n', { flag: 'wx' })
  const malformed = captureDaemonProtocolFile(
    legacy.fixture.paths.pidProjection,
    128,
    'malformed legacy PID'
  )
  const manifest = clone(legacy.manifest)
  manifest.target.projections.pid = daemonFileIdentity(malformed)
  rewriteLegacyManifest(legacy, manifest)
  const replacement = captureFileEvidence(legacy.fixture.paths.pidProjection)
  const inspection = assertReadOnlyInspection(legacy.fixture, { kind: 'INVALID' })
  assert.match(inspection.reason || '', /PID projection.*not canonical|not canonical/)
  assertFileEvidence(legacy.fixture.paths.pidProjection, replacement)
})

test('daemon D0 rejects a same-byte LEGACY projection replacement against its manifest identity', (t) => {
  const legacy = createLegacyFixture(t, ['pid'], { complete: true })
  const bytes = fs.readFileSync(legacy.fixture.paths.pidProjection)
  fs.unlinkSync(legacy.fixture.paths.pidProjection)
  fs.writeFileSync(legacy.fixture.paths.pidProjection, bytes, { flag: 'wx' })
  const replacement = captureFileEvidence(legacy.fixture.paths.pidProjection)
  const inspection = assertReadOnlyInspection(legacy.fixture, { kind: 'INVALID' })
  assert.match(inspection.reason || '', /does not match.*identity|identity does not match/)
  assertFileEvidence(legacy.fixture.paths.pidProjection, replacement)
})

test('daemon D0 LEGACY-RETIRING proof rejects a recorded absent projection reappearance', (t) => {
  const legacy = createLegacyFixture(t, ['pid', 'apiPid', 'heartbeat'], { complete: true })
  const bytes = fs.readFileSync(legacy.fixture.paths.apiPidProjection)
  fs.unlinkSync(legacy.fixture.paths.apiPidProjection)
  const inspection = inspectDaemonProtocol(legacy.options)
  assert.equal(inspection.kind, 'LEGACY-RETIRING')
  fs.writeFileSync(legacy.fixture.paths.apiPidProjection, bytes, { flag: 'wx' })
  const replacement = captureFileEvidence(legacy.fixture.paths.apiPidProjection)
  assert.throws(() => assertDaemonInspectionCurrent(inspection), /reappeared/)
  assertFileEvidence(legacy.fixture.paths.apiPidProjection, replacement)
})

const SCHEMA_MUTATIONS = [
  ['missing instance key', 'instance', (value) => { delete value.product }],
  ['extra instance key', 'instance', (value) => { value.extra = true }],
  ['instance schema version', 'instance', (value) => { value.schemaVersion = 2 }],
  ['instance product', 'instance', (value) => { value.product = 'foreign' }],
  ['instance digest', 'instance', (value) => { value.packageSha256 = `sha256:${'A'.repeat(64)}` }],
  ['instance UUID', 'instance', (value) => { value.epochId = '44444444-4444-0444-8444-444444444444' }],
  ['instance package path', 'instance', (value) => { value.packageRoot = 'relative/package' }],
  ['instance timestamp', 'instance', (value) => { value.createdAt = '2026-08-24T00:00:01Z' }],
  ['instance PID', 'instance', (value) => { value.pid = 0 }],
  ['instance port', 'instance', (value) => { value.port = 65_536 }],
  ['instance file identity', 'instance', (value) => { value.projections.pid.dev = '00' }],
  ['instance root identity', 'instance', (value) => { value.authority.review.ino = '01' }],
  ['instance receipt inventory', 'instance', (value) => { value.authority.receiptInventory = ['a', 'b', 'c'] }],
  ['missing start key', 'start', (value) => { delete value.roots }],
  ['extra start key', 'start', (value) => { value.extra = null }],
  ['start reservation UUID', 'start', (value) => { value.operationId = UUIDS.stop }],
  ['start actor time', 'start', (value) => { value.actor.createdAt = '2026-08-24' }],
  ['stop lifecycle owner binding', 'stop-owner', (value) => {
    value.lifecycleOwnerBinding = {
      lockToken: UUIDS.stop,
      operation: 'uninstall',
      ownerRecord: value.target.instance,
      ownerStageNamespaceId: UUIDS.namespace,
      receiptSha256: `sha256:${'b'.repeat(64)}`,
      installId: value.installId,
      dataRootId: value.dataRootId
    }
  }],
  ['legacy empty target', 'legacy', (value) => {
    value.target.projections = { pid: null, apiPid: null, heartbeat: null }
  }]
]

for (const [name, schema, mutate] of SCHEMA_MUTATIONS) {
  test(`daemon D0 schema mutation table rejects ${name}`, (t) => {
    const { stage } = createPreparedStartStage(t)
    const source = schema === 'instance'
      ? clone(stage.instance)
      : schema === 'start'
        ? clone(stage.manifest)
        : schema === 'stop-owner'
          ? clone(controlManifestFromStart(stage, 'stop'))
          : clone(controlManifestFromStart(stage, 'legacy-retire'))
    mutate(source)
    assert.throws(() => schema === 'instance'
      ? validateDaemonInstanceRecord(source)
      : validateDaemonStageManifest(source))
  })
}

test('daemon D0 strict parsers reject malformed, noncanonical, and oversized records read-only', (t) => {
  const { fixture, stage } = createPreparedStartStage(t)
  const cases = [
    {
      name: 'instance-malformed',
      bytes: Buffer.from('{'),
      maximum: DAEMON_INSTANCE_MAX_BYTES,
      parse: parseDaemonInstanceRecord,
      error: /not valid bounded JSON/
    },
    {
      name: 'instance-noncanonical',
      bytes: Buffer.from(JSON.stringify(stage.instance)),
      maximum: DAEMON_INSTANCE_MAX_BYTES,
      parse: parseDaemonInstanceRecord,
      error: /not canonical JSON/
    },
    {
      name: 'instance-oversized',
      bytes: Buffer.alloc(DAEMON_INSTANCE_MAX_BYTES + 1, 0x20),
      maximum: DAEMON_INSTANCE_MAX_BYTES + 1,
      parse: parseDaemonInstanceRecord,
      error: /exceeds 64 KiB/
    },
    {
      name: 'manifest-malformed',
      bytes: Buffer.from('{'),
      maximum: DAEMON_STAGE_MANIFEST_MAX_BYTES,
      parse: parseDaemonStageManifest,
      error: /not valid bounded JSON/
    },
    {
      name: 'manifest-noncanonical',
      bytes: Buffer.from(JSON.stringify(stage.manifest)),
      maximum: DAEMON_STAGE_MANIFEST_MAX_BYTES,
      parse: parseDaemonStageManifest,
      error: /not canonical JSON/
    },
    {
      name: 'manifest-oversized',
      bytes: Buffer.alloc(DAEMON_STAGE_MANIFEST_MAX_BYTES + 1, 0x20),
      maximum: DAEMON_STAGE_MANIFEST_MAX_BYTES + 1,
      parse: parseDaemonStageManifest,
      error: /exceeds 64 KiB/
    }
  ]
  for (const entry of cases) {
    const file = path.join(fixture.home, `${entry.name}.json`)
    fs.writeFileSync(file, entry.bytes, { flag: 'wx' })
    const captured = captureDaemonProtocolFile(file, entry.maximum, entry.name)
    const evidence = captureFileEvidence(file)
    assert.throws(() => entry.parse(captured), entry.error)
    assertFileEvidence(file, evidence)
  }
})

function replaceSameBytes(file) {
  const bytes = fs.readFileSync(file)
  fs.unlinkSync(file)
  fs.writeFileSync(file, bytes, { flag: 'wx' })
  return captureFileEvidence(file)
}

const BOOTSTRAP_FILE_REPLACEMENTS = [
  ['lifecycle receipt', (fixture) => fixture.paths.receiptFile, false],
  ['HOME namespace marker', (fixture) => fixture.paths.receiptNamespaceMarker, false],
  ['daemon HOME marker', (fixture) => path.join(
    fixture.paths.receiptDirectory,
    `.daemon-stage-namespace-v1.${UUIDS.namespace}.marker`
  ), false],
  ['fixed legacy projection', (fixture) => fixture.paths.pidProjection, true]
]

for (const [label, selectFile, legacy] of BOOTSTRAP_FILE_REPLACEMENTS) {
  test(`daemon D0 bootstrap rejects a same-byte ${label} replacement before its next mutation`, (t) => {
    const fixture = createActiveReceiptFixture(t)
    if (legacy) writeLegacyProjectionSubset(fixture, ['pid'])
    const options = daemonOptions(fixture)
    const initial = inspectDaemonProtocol(options)
    const receipt = inspectDaemonReceiptNamespace(fixture.home, fixture.dataRoot, fixture.readReceiptAuthority)
    let replacement = null
    let postAttackCheckpoint = 0
    assert.throws(() => bootstrapDaemonStageNamespace({
      ...options,
      expectedInspection: initial,
      expectedReceiptAuthority: receipt,
      namespaceId: UUIDS.namespace,
      checkpoint(name) {
        if (replacement) {
          postAttackCheckpoint += 1
          return
        }
        if (name === 'daemon-bootstrap-home-authority') replacement = replaceSameBytes(selectFile(fixture))
      }
    }), /changed|frozen|authority|marker|fixed|receipt|inventory/)
    assert.ok(replacement)
    assert.equal(postAttackCheckpoint, 0)
    assertFileEvidence(selectFile(fixture), replacement)
    assert.equal(fs.existsSync(fixture.paths.stageDirectory), false)
  })
}

test('daemon D0 bootstrap rejects a data-root directory replacement before stage creation', (t) => {
  const fixture = createActiveReceiptFixture(t)
  const options = daemonOptions(fixture)
  const initial = inspectDaemonProtocol(options)
  const receipt = inspectDaemonReceiptNamespace(fixture.home, fixture.dataRoot, fixture.readReceiptAuthority)
  const parked = `${fixture.dataRoot}.parked`
  let replacement = null
  assert.throws(() => bootstrapDaemonStageNamespace({
    ...options,
    expectedInspection: initial,
    expectedReceiptAuthority: receipt,
    namespaceId: UUIDS.namespace,
    checkpoint(name) {
      if (name !== 'daemon-bootstrap-home-authority' || replacement) return
      fs.renameSync(fixture.dataRoot, parked)
      fs.mkdirSync(fixture.dataRoot)
      replacement = fileState(fixture.dataRoot)
    }
  }), /root|ancestor|changed/)
  assert.ok(replacement)
  assert.deepEqual(fileState(fixture.dataRoot), replacement)
  assert.equal(fs.existsSync(parked), true)
  assert.equal(fs.existsSync(fixture.paths.stageDirectory), false)
})

test('daemon D0 bootstrap rejects a review-directory replacement but not ordinary review children', (t) => {
  const fixture = createActiveReceiptFixture(t)
  const options = daemonOptions(fixture)
  const initial = inspectDaemonProtocol(options)
  const receipt = inspectDaemonReceiptNamespace(fixture.home, fixture.dataRoot, fixture.readReceiptAuthority)
  const parked = `${fixture.paths.reviewDirectory}.parked`
  let replacement = null
  assert.throws(() => bootstrapDaemonStageNamespace({
    ...options,
    expectedInspection: initial,
    expectedReceiptAuthority: receipt,
    namespaceId: UUIDS.namespace,
    checkpoint(name) {
      if (name !== 'daemon-bootstrap-home-authority' || replacement) return
      fs.renameSync(fixture.paths.reviewDirectory, parked)
      fs.mkdirSync(fixture.paths.reviewDirectory)
      replacement = fileState(fixture.paths.reviewDirectory)
    }
  }), /review|identity|changed/)
  assert.ok(replacement)
  assert.deepEqual(fileState(fixture.paths.reviewDirectory), replacement)
  assert.equal(fs.existsSync(parked), true)
  assert.equal(fs.existsSync(fixture.paths.stageDirectory), false)
})

test('daemon D0 bootstrap rejects a stage-directory replacement before inner publication', (t) => {
  const fixture = createActiveReceiptFixture(t)
  const options = daemonOptions(fixture)
  const initial = inspectDaemonProtocol(options)
  const receipt = inspectDaemonReceiptNamespace(fixture.home, fixture.dataRoot, fixture.readReceiptAuthority)
  const parked = `${fixture.paths.stageDirectory}.parked`
  let replacement = null
  assert.throws(() => bootstrapDaemonStageNamespace({
    ...options,
    expectedInspection: initial,
    expectedReceiptAuthority: receipt,
    namespaceId: UUIDS.namespace,
    checkpoint(name) {
      if (name !== 'daemon-bootstrap-stage-directory-created' || replacement) return
      fs.renameSync(fixture.paths.stageDirectory, parked)
      fs.mkdirSync(fixture.paths.stageDirectory)
      replacement = fileState(fixture.paths.stageDirectory)
    }
  }), /stage namespace changed|identity/)
  assert.ok(replacement)
  assert.deepEqual(fileState(fixture.paths.stageDirectory), replacement)
  assert.equal(fs.readdirSync(fixture.paths.stageDirectory).length, 0)
  assert.equal(fs.existsSync(parked), true)
})

test('daemon D0 bootstrap rejects an inner-marker replacement during existing-stage recovery', (t) => {
  const fixture = createActiveReceiptFixture(t)
  bootstrapCurrent(fixture)
  const options = daemonOptions(fixture)
  const initial = inspectDaemonProtocol(options)
  const receipt = inspectDaemonReceiptNamespace(fixture.home, fixture.dataRoot, fixture.readReceiptAuthority)
  const inner = path.join(
    fixture.paths.stageDirectory,
    `.namespace-v1.${UUIDS.namespace}.skill-graft.marker`
  )
  let replacement = null
  assert.throws(() => bootstrapDaemonStageNamespace({
    ...options,
    expectedInspection: initial,
    expectedReceiptAuthority: receipt,
    namespaceId: UUIDS.namespace,
    checkpoint(name) {
      if (name === 'daemon-bootstrap-existing-stage-parent-fsynced' && !replacement) {
        replacement = replaceSameBytes(inner)
      }
    }
  }), /inner marker|changed|frozen/)
  assert.ok(replacement)
  assertFileEvidence(inner, replacement)
  assert.equal(fs.readdirSync(fixture.paths.stageDirectory).length, 1)
})

test('daemon D0 start creation rejects a reservation-directory replacement before its first payload', (t) => {
  const fixture = createActiveReceiptFixture(t)
  const authority = bootstrapCurrent(fixture)
  let replacement = null
  let parked = null
  let originalState = null
  assert.throws(() => createDaemonStartStage(authority, {
    epochId: UUIDS.epoch,
    pid: process.pid,
    apiPid: process.pid,
    processIdentity: `test-${process.pid}`,
    pgid: process.pid,
    port: 18765,
    createdAt: CREATED_AT,
    checkpoint(name, facts) {
      if (name !== 'daemon-start-reservation-directory-created' || replacement) return
      const reservation = path.join(fixture.paths.stageDirectory, facts.reservationName)
      originalState = fileState(reservation)
      parked = `${fixture.home}-parked-original-reservation`
      t.after(() => fs.rmSync(parked, { recursive: true, force: true }))
      fs.renameSync(reservation, parked)
      fs.mkdirSync(reservation)
      replacement = { directory: reservation, state: fileState(reservation) }
    }
  }), /daemon start reservation identity changed/)
  assert.ok(replacement)
  assert.ok(originalState)
  assert.notDeepEqual(
    { dev: replacement.state.dev, ino: replacement.state.ino },
    { dev: originalState.dev, ino: originalState.ino }
  )
  assert.deepEqual(fileState(replacement.directory), replacement.state)
  assert.equal(fs.readdirSync(replacement.directory).length, 0)
  assert.equal(fs.existsSync(parked), true)
  assert.deepEqual(
    fs.readdirSync(fixture.paths.stageDirectory)
      .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))),
    [
      `.namespace-v1.${UUIDS.namespace}.skill-graft.marker`,
      path.basename(replacement.directory)
    ].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
  )
  for (const payload of DAEMON_START_STAGE_PAYLOADS) {
    assert.equal(fs.existsSync(path.join(replacement.directory, payload)), false)
  }
  assert.equal(fs.existsSync(fixture.paths.pidProjection), false)
  assert.equal(fs.existsSync(fixture.paths.apiPidProjection), false)
  assert.equal(fs.existsSync(fixture.paths.heartbeatProjection), false)
  assert.equal(fs.existsSync(fixture.paths.finalInstance), false)
})

test('daemon D0 never adopts a same-byte replacement of its linked public target', (t) => {
  const { stage } = createPreparedStartStage(t)
  let replacement = null
  assert.throws(() => publishDaemonStartProjection(stage, 'pid', (name, facts) => {
    if (name !== 'daemon-hardlink-created' || replacement) return
    const bytes = fs.readFileSync(facts.source)
    fs.unlinkSync(facts.target)
    fs.writeFileSync(facts.target, bytes, { flag: 'wx' })
    replacement = captureFileEvidence(facts.target)
  }), /hardlink pair|changed/)
  assert.ok(replacement)
  assertFileEvidence(stage.authority.paths.pidProjection, replacement)
  assert.equal(fs.existsSync(stage.authority.paths.apiPidProjection), false)
  assert.throws(() => publishDaemonStartProjection(stage, 'pid'), /changed|hardlink|frozen|linked|bounded plain/)
  assertFileEvidence(stage.authority.paths.pidProjection, replacement)
})

test('daemon D0 never adopts a same-byte replacement of its staged source after linking', (t) => {
  const { stage } = createPreparedStartStage(t)
  let replacement = null
  assert.throws(() => publishDaemonStartProjection(stage, 'pid', (name, facts) => {
    if (name !== 'daemon-hardlink-created' || replacement) return
    const bytes = fs.readFileSync(facts.source)
    fs.unlinkSync(facts.source)
    fs.writeFileSync(facts.source, bytes, { flag: 'wx' })
    replacement = captureFileEvidence(facts.source)
  }), /hardlink pair|changed/)
  assert.ok(replacement)
  assertFileEvidence(stage.files.pid.file, replacement)
  assert.equal(fs.existsSync(stage.authority.paths.apiPidProjection), false)
  assert.throws(() => publishDaemonStartProjection(stage, 'pid'), /changed|hardlink|frozen|linked|bounded plain/)
  assertFileEvidence(stage.files.pid.file, replacement)
})

test('daemon D0 rehydrates a frozen STARTING prefix without rebasing its pending hardlink', (t) => {
  const { options, stage } = createPreparedStartStage(t)
  let cut = false
  assert.throws(() => publishDaemonStartProjection(stage, 'pid', (name) => {
    if (!cut && name === 'daemon-hardlink-created') {
      cut = true
      throw new Error('fresh recovery cut')
    }
  }), /fresh recovery cut/)
  const starting = inspectDaemonProtocol(options)
  assert.equal(starting.kind, 'STARTING')
  const recovered = recoverDaemonStartStage(options, starting)
  publishDaemonStartProjection(recovered, 'apiPid')
  publishDaemonStartProjection(recovered, 'heartbeat')
  commitDaemonStartInstance(recovered)
  assert.equal(inspectDaemonProtocol(options).kind, 'RUNNING-LINKED')
})

test('daemon D0 settles a rehydrated linked heartbeat before a direct final publication', (t) => {
  const { options, stage } = createPreparedStartStage(t)
  publishDaemonStartProjection(stage, 'pid')
  publishDaemonStartProjection(stage, 'apiPid')
  let cut = false
  assert.throws(() => publishDaemonStartProjection(stage, 'heartbeat', (name) => {
    if (!cut && name === 'daemon-hardlink-created') {
      cut = true
      throw new Error('heartbeat recovery cut')
    }
  }), /heartbeat recovery cut/)
  const starting = inspectDaemonProtocol(options)
  assert.equal(starting.kind, 'STARTING')
  const recovered = recoverDaemonStartStage(options, starting)
  commitDaemonStartInstance(recovered)
  assert.equal(inspectDaemonProtocol(options).kind, 'RUNNING-LINKED')
})

for (const phase of ['daemon-hardlink-created', 'daemon-hardlink-parent-fsynced']) {
  test(`daemon D0 frozen inspection rehydrates a pending projection after ${phase}`, (t) => {
    const { options, stage } = createPreparedStartStage(t)
    let cut = false
    assert.throws(() => publishDaemonStartProjection(stage, 'pid', (name) => {
      if (!cut && name === phase) {
        cut = true
        throw new Error(`fresh projection cut at ${phase}`)
      }
    }), /fresh projection cut/)
    const recovered = recoverDaemonStartStage(options, inspectDaemonProtocol(options))
    publishDaemonStartProjection(recovered, 'pid')
    publishDaemonStartProjection(recovered, 'apiPid')
    publishDaemonStartProjection(recovered, 'heartbeat')
    commitDaemonStartInstance(recovered)
    assert.equal(inspectDaemonProtocol(options).kind, 'RUNNING-LINKED')
  })

  test(`daemon D0 frozen inspection rehydrates a pending final instance after ${phase}`, (t) => {
    const { options, stage } = createPreparedStartStage(t)
    publishDaemonStartProjection(stage, 'pid')
    publishDaemonStartProjection(stage, 'apiPid')
    publishDaemonStartProjection(stage, 'heartbeat')
    let cut = false
    assert.throws(() => commitDaemonStartInstance(stage, (name) => {
      if (!cut && name === phase) {
        cut = true
        throw new Error(`fresh final cut at ${phase}`)
      }
    }), /fresh final cut/)
    const linked = inspectDaemonProtocol(options)
    assert.equal(linked.kind, 'RUNNING-LINKED')
    const recovered = recoverDaemonStartStage(options, linked)
    commitDaemonStartInstance(recovered)
    assert.equal(inspectDaemonProtocol(options).kind, 'RUNNING-LINKED')
  })
}
