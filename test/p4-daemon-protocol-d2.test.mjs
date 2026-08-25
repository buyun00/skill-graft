import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  acquireCommittedDaemonStartCollapseAuthority,
  acquireAbandonedDaemonControlStageCleanupAuthority,
  acquireDaemonControlRetirementAuthority,
  acquireDaemonControlSignalAuthority,
  bootstrapDaemonStageNamespace,
  cleanupAbandonedDaemonControlStage,
  collapseCommittedDaemonStart,
  commitDaemonStartInstance,
  createDaemonLegacyRetireStage,
  createDaemonStartStage,
  createDaemonStopStage,
  daemonProtocolPaths,
  inspectDaemonProtocol,
  inspectDaemonReceiptNamespace,
  publishDaemonStartProjection,
  readDaemonControlSignalTarget,
  recoverDaemonControlStage,
  retireDaemonControlStage,
  settleDaemonTerminalNamespaceDurability
} from '../dist/control/daemon-protocol.js'

const IDS = {
  install: '11111111-1111-4111-8111-111111111111',
  data: '22222222-2222-4222-8222-222222222222',
  namespace: '33333333-3333-4333-8333-333333333333',
  epoch: '44444444-4444-4444-8444-444444444444',
  control: '55555555-5555-4555-8555-555555555555'
}
const CREATED_AT = '2026-08-24T00:00:01.000Z'
const TARGET_IDENTITY = `d2-target-${process.pid}`
const CONTROLLER_IDENTITY = `d2-controller-${process.pid}`
const PORT = 18765

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function fileState(file) {
  const stat = fs.lstatSync(file)
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, nlink: stat.nlink }
}

function authorityFileState(file) {
  if (!file || !fs.existsSync(file)) return { bytes: null, stat: null }
  return { bytes: fs.readFileSync(file), stat: fileState(file) }
}

function capturedFile(file) {
  const bytes = fs.readFileSync(file)
  return { file, bytes, sha256: `sha256:${sha256(bytes)}`, state: fileState(file) }
}

function fileIdentity(file) {
  const captured = capturedFile(file)
  return {
    sha256: captured.sha256,
    dev: String(captured.state.dev),
    ino: String(captured.state.ino),
    size: captured.state.size
  }
}

function createActiveReceiptFixture(t, label = 'd2') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `daemon-protocol-${label}-`))
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
    const daemonName = names.find((name) => /^\.daemon-stage-namespace-v1\.[0-9a-f-]+\.marker$/.test(name)) || null
    const ownerName = names.find((name) => /^\.owner-stage-namespace-v1\.[0-9a-f-]+\.marker$/.test(name)) || null
    const daemonId = daemonName?.slice('.daemon-stage-namespace-v1.'.length, -'.marker'.length) || null
    const daemonFile = daemonName ? path.join(paths.receiptDirectory, daemonName) : null
    const ownerId = ownerName?.slice('.owner-stage-namespace-v1.'.length, -'.marker'.length) || null
    const ownerFile = ownerName ? path.join(paths.receiptDirectory, ownerName) : null
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
      ownerStageNamespaceId: ownerId,
      ownerStageAuthorityMarker: ownerFile,
      ownerStageAuthorityMarkerState: authorityFileState(ownerFile),
      daemonStageNamespaceId: daemonId,
      daemonStageAuthorityMarker: daemonFile,
      daemonStageAuthorityMarkerState: authorityFileState(daemonFile)
    }
  }
  return { home, dataRoot, packageRoot, paths, receipt, readReceiptAuthority }
}

function daemonOptions(fixture) {
  return { home: fixture.home, dataRoot: fixture.dataRoot, readReceiptAuthority: fixture.readReceiptAuthority }
}

function addLifecycleOwner(fixture) {
  const ownerNamespaceId = '66666666-6666-4666-8666-666666666666'
  const lockToken = '77777777-7777-4777-8777-777777777777'
  const ownerMarker = path.join(
    fixture.paths.receiptDirectory,
    `.owner-stage-namespace-v1.${ownerNamespaceId}.marker`
  )
  const ownerRecord = path.join(fixture.home, 'lifecycle-owner-record-v1.json')
  fs.writeFileSync(ownerMarker, '', { flag: 'wx' })
  fs.writeFileSync(ownerRecord, '{"owner":true}\n', { flag: 'wx' })
  const binding = {
    lockToken,
    operation: 'upgrade',
    ownerRecord: fileIdentity(ownerRecord),
    ownerStageNamespaceId: ownerNamespaceId,
    receiptSha256: `sha256:${sha256(fs.readFileSync(fixture.paths.receiptFile))}`,
    installId: fixture.receipt.installId,
    dataRootId: fixture.receipt.dataRootId
  }
  const readLifecycleOwnerAuthority = () => ({
    lockToken,
    operation: 'upgrade',
    ownerStageNamespaceId: ownerNamespaceId,
    receiptSha256: binding.receiptSha256,
    installId: fixture.receipt.installId,
    dataRootId: fixture.receipt.dataRootId,
    ownerRecord: capturedFile(ownerRecord),
    files: [capturedFile(ownerRecord)],
    directories: []
  })
  return { binding, ownerRecord, readLifecycleOwnerAuthority }
}

function bootstrap(fixture) {
  const options = daemonOptions(fixture)
  return bootstrapDaemonStageNamespace({
    ...options,
    expectedInspection: inspectDaemonProtocol(options),
    expectedReceiptAuthority: inspectDaemonReceiptNamespace(
      fixture.home,
      fixture.dataRoot,
      fixture.readReceiptAuthority
    ),
    namespaceId: IDS.namespace
  })
}

function actor() {
  return {
    pid: process.pid,
    processIdentity: CONTROLLER_IDENTITY,
    pgid: process.pid,
    createdAt: CREATED_AT
  }
}

function liveFacts(identity = TARGET_IDENTITY, pgid = process.pid, tree = null, listenerIdentity = identity) {
  return {
    process: {
      state: 'alive',
      pid: process.pid,
      processIdentity: identity,
      pgid,
      processTree: tree || [{ pid: process.pid, processIdentity: identity }]
    },
    listener: { state: 'owned', port: PORT, pid: process.pid, processIdentity: listenerIdentity }
  }
}

function deadFacts() {
  return {
    process: { state: 'dead', pid: process.pid },
    listener: { state: 'absent', port: PORT }
  }
}

function createRunningFixture(t, label = 'running') {
  const fixture = createActiveReceiptFixture(t, label)
  const options = daemonOptions(fixture)
  const authority = bootstrap(fixture)
  const start = createDaemonStartStage(authority, {
    epochId: IDS.epoch,
    pid: process.pid,
    apiPid: process.pid,
    processIdentity: TARGET_IDENTITY,
    pgid: process.pid,
    port: PORT,
    createdAt: CREATED_AT
  })
  for (const projection of ['pid', 'apiPid', 'heartbeat']) publishDaemonStartProjection(start, projection)
  commitDaemonStartInstance(start)
  collapseCommittedDaemonStart(acquireCommittedDaemonStartCollapseAuthority(options, inspectDaemonProtocol(options)))
  assert.equal(inspectDaemonProtocol(options).kind, 'RUNNING-CLEAN')
  return { fixture, options, start }
}

function legacyHeartbeat(fixture) {
  return Buffer.from(`${JSON.stringify({
    pid: process.pid,
    apiPid: process.pid,
    hubRoot: fixture.dataRoot,
    packageRoot: fixture.packageRoot,
    dataRoot: fixture.dataRoot,
    port: PORT,
    apiHealthy: true,
    lastBeat: CREATED_AT
  }, null, 2)}\n`)
}

function createLegacyFixture(t, label = 'legacy') {
  const fixture = createActiveReceiptFixture(t, label)
  fs.writeFileSync(fixture.paths.pidProjection, `${process.pid}\n`, { flag: 'wx' })
  fs.writeFileSync(fixture.paths.apiPidProjection, `${process.pid}\n`, { flag: 'wx' })
  fs.writeFileSync(fixture.paths.heartbeatProjection, legacyHeartbeat(fixture), { flag: 'wx' })
  const options = daemonOptions(fixture)
  const before = inspectDaemonProtocol(options)
  assert.equal(before.kind, 'LEGACY', before.reason || '')
  bootstrapDaemonStageNamespace({
    ...options,
    expectedInspection: before,
    expectedReceiptAuthority: inspectDaemonReceiptNamespace(
      fixture.home,
      fixture.dataRoot,
      fixture.readReceiptAuthority
    ),
    namespaceId: IDS.namespace
  })
  assert.equal(inspectDaemonProtocol(options).kind, 'LEGACY-NAMESPACE-RECOVERABLE')
  return { fixture, options }
}

test('D2 STOP stages, recovers, signals only the exact tree, and retires durably', (t) => {
  const prepared = createRunningFixture(t)
  const stage = createDaemonStopStage(prepared.options, inspectDaemonProtocol(prepared.options), {
    operationId: IDS.control,
    actor: actor(),
    targetFacts: liveFacts()
  })
  assert.equal(stage.kind, 'DAEMON-STOP-STAGE')
  assert.equal(stage.manifest.lifecycleOwnerBinding, null)
  assert.equal(inspectDaemonProtocol(prepared.options).kind, 'STOPPING')
  assert.equal(recoverDaemonControlStage(prepared.options, inspectDaemonProtocol(prepared.options)).kind,
    'DAEMON-STOP-STAGE')
  const signal = acquireDaemonControlSignalAuthority(
    prepared.options,
    inspectDaemonProtocol(prepared.options),
    liveFacts()
  )
  assert.deepEqual(readDaemonControlSignalTarget(signal), {
    operation: 'stop',
    pid: process.pid,
    processIdentity: TARGET_IDENTITY,
    pgid: process.pid,
    processTree: [{ pid: process.pid, processIdentity: TARGET_IDENTITY }]
  })
  const terminal = retireDaemonControlStage(acquireDaemonControlRetirementAuthority(
    prepared.options,
    inspectDaemonProtocol(prepared.options),
    deadFacts()
  ))
  assert.equal(terminal.kind, 'ABSENT')
  assert.equal(fs.existsSync(prepared.fixture.paths.finalInstance), false)
  assert.deepEqual(fs.readdirSync(prepared.fixture.paths.stageDirectory), [
    `.namespace-v1.${IDS.namespace}.skill-graft.marker`
  ])
})

test('D2 dead RUNNING-CLEAN recovery skips signal but retains exact retirement authority', (t) => {
  const prepared = createRunningFixture(t, 'dead-running')
  createDaemonStopStage(prepared.options, inspectDaemonProtocol(prepared.options), {
    operationId: IDS.control,
    actor: actor(),
    targetFacts: deadFacts()
  })
  assert.throws(() => acquireDaemonControlSignalAuthority(
    prepared.options,
    inspectDaemonProtocol(prepared.options),
    deadFacts()
  ), /not exactly alive/)
  assert.equal(retireDaemonControlStage(acquireDaemonControlRetirementAuthority(
    prepared.options,
    inspectDaemonProtocol(prepared.options),
    deadFacts()
  )).kind, 'ABSENT')
})

test('D2 LEGACY-RETIRE requires an exact live identity before staging and reaches ABSENT', (t) => {
  const prepared = createLegacyFixture(t)
  const stage = createDaemonLegacyRetireStage(prepared.options, inspectDaemonProtocol(prepared.options), {
    operationId: IDS.control,
    actor: actor(),
    targetFacts: liveFacts()
  })
  assert.equal(stage.kind, 'DAEMON-LEGACY-RETIRE-STAGE')
  assert.equal(inspectDaemonProtocol(prepared.options).kind, 'LEGACY-RETIRING')
  assert.equal(readDaemonControlSignalTarget(acquireDaemonControlSignalAuthority(
    prepared.options,
    inspectDaemonProtocol(prepared.options),
    liveFacts()
  )).operation, 'legacy-retire')
  assert.equal(retireDaemonControlStage(acquireDaemonControlRetirementAuthority(
    prepared.options,
    inspectDaemonProtocol(prepared.options),
    deadFacts()
  )).kind, 'ABSENT')
})

test('D2 signal and retirement facts fail closed on identity, PGID, tree, and listener drift', (t) => {
  const prepared = createRunningFixture(t, 'drift')
  createDaemonStopStage(prepared.options, inspectDaemonProtocol(prepared.options), {
    operationId: IDS.control,
    actor: actor(),
    targetFacts: liveFacts()
  })
  const inspection = inspectDaemonProtocol(prepared.options)
  assert.throws(() => acquireDaemonControlSignalAuthority(prepared.options, inspection,
    liveFacts('reused-identity')), /identity, group, or tree drifted/)
  assert.throws(() => acquireDaemonControlSignalAuthority(prepared.options, inspection,
    liveFacts(TARGET_IDENTITY, process.pid + 1)), /identity, group, or tree drifted/)
  assert.throws(() => acquireDaemonControlSignalAuthority(prepared.options, inspection,
    liveFacts(TARGET_IDENTITY, process.pid, [
      { pid: process.pid, processIdentity: TARGET_IDENTITY },
      { pid: process.pid + 1, processIdentity: 'unexpected-child' }
    ])), /identity, group, or tree drifted/)
  const listenerDrift = liveFacts()
  listenerDrift.listener = { ...listenerDrift.listener, processIdentity: 'foreign-listener' }
  assert.throws(() => acquireDaemonControlSignalAuthority(prepared.options, inspection, listenerDrift),
    /listener owner identity drifted/)
  assert.throws(() => acquireDaemonControlRetirementAuthority(prepared.options, inspection, {
    process: { state: 'alive', pid: process.pid, processIdentity: TARGET_IDENTITY,
      pgid: process.pid + 1, processTree: [{ pid: process.pid, processIdentity: TARGET_IDENTITY }] },
    listener: { state: 'absent', port: PORT }
  }), /process-group drift/)
  assert.throws(() => acquireDaemonControlRetirementAuthority(prepared.options, inspection, {
    process: { state: 'dead', pid: process.pid },
    listener: { state: 'unknown', port: PORT }
  }), /listener to be absent/)
})

test('D2 authorities are provenance-gated and forged authorities cannot signal or delete', (t) => {
  const prepared = createRunningFixture(t, 'forged')
  const stage = createDaemonStopStage(prepared.options, inspectDaemonProtocol(prepared.options), {
    operationId: IDS.control,
    actor: actor(),
    targetFacts: liveFacts()
  })
  assert.throws(() => readDaemonControlSignalTarget({ kind: 'DAEMON-CONTROL-SIGNAL', operation: 'stop' }),
    /not issued/)
  assert.throws(() => retireDaemonControlStage({
    kind: 'DAEMON-CONTROL-RETIREMENT', operation: 'stop', disposition: 'dead'
  }), /not issued/)
  assert.throws(() => recoverDaemonControlStage(prepared.options, {
    ...inspectDaemonProtocol(prepared.options),
    kind: 'LEGACY-RETIRING'
  }), /changed while private mutation authority was captured/)
  assert.equal(stage.kind, 'DAEMON-STOP-STAGE')
  assert.equal(fs.existsSync(prepared.fixture.paths.finalInstance), true)
})

test('D2 RUNNING-CLEAN can stage and retire after the recorded PID was explicitly reused', (t) => {
  const prepared = createRunningFixture(t, 'pid-reused')
  const reusedFacts = {
    process: {
      state: 'alive',
      pid: process.pid,
      processIdentity: 'different-process-generation',
      pgid: process.pid + 100,
      processTree: [{ pid: process.pid, processIdentity: 'different-process-generation' }]
    },
    listener: { state: 'absent', port: PORT }
  }
  createDaemonStopStage(prepared.options, inspectDaemonProtocol(prepared.options), {
    operationId: IDS.control,
    actor: actor(),
    targetFacts: reusedFacts
  })
  const retirement = acquireDaemonControlRetirementAuthority(
    prepared.options,
    inspectDaemonProtocol(prepared.options),
    reusedFacts
  )
  assert.equal(retirement.disposition, 'pid-reused')
  assert.equal(retireDaemonControlStage(retirement).kind, 'ABSENT')
})

const CONTROL_CREATE_CUTS = [
  ['reservation-created', (name) => name === 'daemon-control-reservation-directory-created', false],
  ['reservation-parent-fsynced', (name) => name === 'daemon-control-reservation-parent-fsynced', false],
  ['manifest-created', (name, facts) => name === 'daemon-exclusive-created'
    && facts.label?.includes('stage manifest'), false],
  ['manifest-written', (name, facts) => name === 'daemon-file-written'
    && facts.label?.includes('stage manifest'), true],
  ['manifest-file-fsynced', (name, facts) => name === 'daemon-file-fsynced'
    && facts.label?.includes('stage manifest'), true],
  ['manifest-parent-fsynced', (name, facts) => name === 'daemon-parent-fsynced'
    && facts.label?.includes('stage manifest'), true],
  ['manifest-complete', (name) => name === 'daemon-control-manifest-durable', true]
]

for (const operation of ['stop', 'legacy-retire']) {
  for (const [cut, matches, mayBeComplete] of CONTROL_CREATE_CUTS) {
    test(`D2 ${operation} creation kill-cut ${cut} is exactly recoverable`, (t) => {
      const prepared = operation === 'stop'
        ? createRunningFixture(t, `create-${operation}-${cut}`)
        : createLegacyFixture(t, `create-${operation}-${cut}`)
      let injected = false
      const create = operation === 'stop' ? createDaemonStopStage : createDaemonLegacyRetireStage
      assert.throws(() => create(prepared.options, inspectDaemonProtocol(prepared.options), {
        operationId: IDS.control,
        actor: actor(),
        targetFacts: liveFacts(),
        checkpoint(name, facts) {
          if (!injected && matches(name, facts)) {
            injected = true
            throw new Error(`D2 create cut ${cut}`)
          }
        }
      }), /D2 create cut/)
      assert.equal(injected, true)
      const inspection = inspectDaemonProtocol(prepared.options)
      if (inspection.kind === 'STOPPING' || inspection.kind === 'LEGACY-RETIRING') {
        assert.equal(mayBeComplete, true)
        assert.equal(recoverDaemonControlStage(prepared.options, inspection).manifest.operation, operation)
      } else {
        assert.equal(inspection.kind,
          operation === 'stop' ? 'STOPPING-PARTIAL' : 'LEGACY-RETIRING-PARTIAL', inspection.reason || '')
        const restored = cleanupAbandonedDaemonControlStage(
          acquireAbandonedDaemonControlStageCleanupAuthority(
            prepared.options,
            inspection,
            () => ({ state: 'dead' })
          )
        )
        assert.equal(restored.kind,
          operation === 'stop' ? 'RUNNING-CLEAN' : 'LEGACY-NAMESPACE-RECOVERABLE')
      }
    })
  }
}

const CONTROL_RETIREMENT_CUTS = [
  ['review-barrier', (name) => name === 'daemon-control-review-recovery-fsynced'],
  ['reservation-barrier', (name) => name === 'daemon-control-reservation-recovery-fsynced'],
  ...[
    'daemon retirement heartbeat',
    'daemon retirement API PID',
    'daemon retirement PID',
    'daemon retirement final instance',
    'daemon retirement stage manifest'
  ].flatMap((label) => [
    [`${label}-unlinked`, (name, facts) => name === 'daemon-file-unlinked' && facts.label === label],
    [`${label}-parent-fsynced`, (name, facts) => name === 'daemon-unlink-parent-fsynced' && facts.label === label]
  ]),
  ['reservation-removed', (name, facts) => name === 'daemon-directory-removed'
    && facts.label === 'empty daemon control reservation'],
  ['reservation-remove-parent-fsynced', (name, facts) => name === 'daemon-directory-parent-fsynced'
    && facts.label === 'empty daemon control reservation']
]

for (const [cut, matches] of CONTROL_RETIREMENT_CUTS) {
  test(`D2 STOP retirement kill-cut ${cut} is fresh-inspection idempotent`, (t) => {
    const prepared = createRunningFixture(t, `retire-stop-${cut}`)
    createDaemonStopStage(prepared.options, inspectDaemonProtocol(prepared.options), {
      operationId: IDS.control,
      actor: actor(),
      targetFacts: liveFacts()
    })
    const retirement = acquireDaemonControlRetirementAuthority(
      prepared.options,
      inspectDaemonProtocol(prepared.options),
      deadFacts()
    )
    let injected = false
    assert.throws(() => retireDaemonControlStage(retirement, (name, facts) => {
      if (!injected && matches(name, facts)) {
        injected = true
        throw new Error(`D2 retirement cut ${cut}`)
      }
    }), /D2 retirement cut/)
    assert.equal(injected, true)
    const current = inspectDaemonProtocol(prepared.options)
    let terminal
    if (current.kind === 'STOPPING') {
      terminal = retireDaemonControlStage(acquireDaemonControlRetirementAuthority(
        prepared.options,
        current,
        deadFacts()
      ))
    } else if (current.kind === 'STOPPING-PARTIAL') {
      terminal = cleanupAbandonedDaemonControlStage(
        acquireAbandonedDaemonControlStageCleanupAuthority(
          prepared.options,
          current,
          () => ({ state: 'dead' })
        )
      )
    } else {
      assert.equal(current.kind, 'ABSENT', current.reason || '')
      terminal = settleDaemonTerminalNamespaceDurability(prepared.options, current)
    }
    assert.equal(terminal.kind, 'ABSENT')
    assert.equal(settleDaemonTerminalNamespaceDurability(
      prepared.options,
      inspectDaemonProtocol(prepared.options)
    ).kind, 'ABSENT')
  })
}

for (const [cut, matches] of CONTROL_RETIREMENT_CUTS
  .filter(([name]) => !name.includes('final instance'))) {
  test(`D2 LEGACY retirement kill-cut ${cut} is fresh-inspection idempotent`, (t) => {
    const prepared = createLegacyFixture(t, `retire-legacy-${cut}`)
    createDaemonLegacyRetireStage(prepared.options, inspectDaemonProtocol(prepared.options), {
      operationId: IDS.control,
      actor: actor(),
      targetFacts: liveFacts()
    })
    const retirement = acquireDaemonControlRetirementAuthority(
      prepared.options,
      inspectDaemonProtocol(prepared.options),
      deadFacts()
    )
    let injected = false
    assert.throws(() => retireDaemonControlStage(retirement, (name, facts) => {
      if (!injected && matches(name, facts)) {
        injected = true
        throw new Error(`D2 legacy retirement cut ${cut}`)
      }
    }), /D2 legacy retirement cut/)
    assert.equal(injected, true)
    const current = inspectDaemonProtocol(prepared.options)
    let terminal
    if (current.kind === 'LEGACY-RETIRING') {
      terminal = retireDaemonControlStage(acquireDaemonControlRetirementAuthority(
        prepared.options,
        current,
        deadFacts()
      ))
    } else if (current.kind === 'LEGACY-RETIRING-PARTIAL') {
      terminal = cleanupAbandonedDaemonControlStage(
        acquireAbandonedDaemonControlStageCleanupAuthority(
          prepared.options,
          current,
          () => ({ state: 'dead' })
        )
      )
    } else {
      assert.equal(current.kind, 'ABSENT', current.reason || '')
      terminal = settleDaemonTerminalNamespaceDurability(prepared.options, current)
    }
    assert.equal(terminal.kind, 'ABSENT')
  })
}

test('D2 lifecycle-driven STOP carries and freezes its owner binding; ordinary stop remains null', (t) => {
  const fixture = createActiveReceiptFixture(t, 'lifecycle-owner')
  const owner = addLifecycleOwner(fixture)
  const options = {
    ...daemonOptions(fixture),
    readLifecycleOwnerAuthority: owner.readLifecycleOwnerAuthority
  }
  const authority = bootstrapDaemonStageNamespace({
    ...options,
    expectedInspection: inspectDaemonProtocol(options),
    expectedReceiptAuthority: inspectDaemonReceiptNamespace(
      fixture.home,
      fixture.dataRoot,
      fixture.readReceiptAuthority
    ),
    namespaceId: IDS.namespace
  })
  const start = createDaemonStartStage(authority, {
    epochId: IDS.epoch,
    pid: process.pid,
    apiPid: process.pid,
    processIdentity: TARGET_IDENTITY,
    pgid: process.pid,
    port: PORT,
    createdAt: CREATED_AT
  })
  for (const projection of ['pid', 'apiPid', 'heartbeat']) publishDaemonStartProjection(start, projection)
  commitDaemonStartInstance(start)
  collapseCommittedDaemonStart(acquireCommittedDaemonStartCollapseAuthority(options, inspectDaemonProtocol(options)))
  const stage = createDaemonStopStage(options, inspectDaemonProtocol(options), {
    operationId: IDS.control,
    actor: actor(),
    lifecycleOwnerBinding: owner.binding,
    targetFacts: liveFacts()
  })
  assert.deepEqual(stage.manifest.lifecycleOwnerBinding, owner.binding)
  fs.appendFileSync(owner.ownerRecord, 'tamper')
  assert.equal(inspectDaemonProtocol(options).kind, 'INVALID')
})

test('D2 exact replacement after retirement issuance is rejected before the next wrong deletion', (t) => {
  const prepared = createRunningFixture(t, 'replacement')
  createDaemonStopStage(prepared.options, inspectDaemonProtocol(prepared.options), {
    operationId: IDS.control,
    actor: actor(),
    targetFacts: liveFacts()
  })
  const authority = acquireDaemonControlRetirementAuthority(
    prepared.options,
    inspectDaemonProtocol(prepared.options),
    deadFacts()
  )
  const original = fs.readFileSync(prepared.fixture.paths.heartbeatProjection)
  fs.renameSync(prepared.fixture.paths.heartbeatProjection,
    path.join(prepared.fixture.home, 'parked-original-heartbeat'))
  fs.writeFileSync(prepared.fixture.paths.heartbeatProjection, original, { flag: 'wx' })
  assert.throws(() => retireDaemonControlStage(authority), /frozen inode|changed|authority/)
  assert.equal(fs.existsSync(prepared.fixture.paths.apiPidProjection), true)
  assert.equal(fs.existsSync(prepared.fixture.paths.pidProjection), true)
  assert.equal(fs.existsSync(prepared.fixture.paths.finalInstance), true)
})

test('D2 abandoned control creation cleanup is actor-gated and its authority cannot be forged', (t) => {
  const prepared = createRunningFixture(t, 'abandoned-actor-gate')
  assert.throws(() => createDaemonStopStage(
    prepared.options,
    inspectDaemonProtocol(prepared.options),
    {
      operationId: IDS.control,
      actor: actor(),
      targetFacts: liveFacts(),
      checkpoint(name) {
        if (name === 'daemon-control-reservation-directory-created') throw new Error('actor gate cut')
      }
    }
  ), /actor gate cut/)
  const partial = inspectDaemonProtocol(prepared.options)
  assert.equal(partial.kind, 'STOPPING-PARTIAL')
  assert.throws(() => acquireAbandonedDaemonControlStageCleanupAuthority(
    prepared.options,
    partial,
    () => ({ state: 'alive', processIdentity: CONTROLLER_IDENTITY, pgid: process.pid })
  ), /still alive/)
  assert.throws(() => acquireAbandonedDaemonControlStageCleanupAuthority(
    prepared.options,
    partial,
    () => ({ state: 'alive', processIdentity: CONTROLLER_IDENTITY, pgid: process.pid + 1 })
  ), /process group drifted/)
  assert.throws(() => acquireAbandonedDaemonControlStageCleanupAuthority(
    prepared.options,
    partial,
    () => ({ state: 'unknown' })
  ), /state is unknown/)
  assert.throws(() => cleanupAbandonedDaemonControlStage({
    kind: 'ABANDONED-DAEMON-CONTROL-STAGE-CLEANUP',
    operation: 'stop',
    disposition: 'dead'
  }), /not issued/)
  const reused = acquireAbandonedDaemonControlStageCleanupAuthority(
    prepared.options,
    partial,
    () => ({ state: 'alive', processIdentity: 'reused-controller-pid', pgid: process.pid + 2 })
  )
  assert.equal(reused.disposition, 'pid-reused')
  assert.equal(cleanupAbandonedDaemonControlStage(reused).kind, 'RUNNING-CLEAN')
})

test('D2 legacy state without a currently exact process identity fails closed before staging', (t) => {
  const prepared = createLegacyFixture(t, 'legacy-no-identity')
  const before = fs.readdirSync(prepared.fixture.paths.reviewDirectory)
  assert.throws(() => createDaemonLegacyRetireStage(
    prepared.options,
    inspectDaemonProtocol(prepared.options),
    {
      operationId: IDS.control,
      actor: actor(),
      targetFacts: deadFacts()
    }
  ), /requires an exactly live identity/)
  assert.deepEqual(fs.readdirSync(prepared.fixture.paths.reviewDirectory), before)
  assert.equal(inspectDaemonProtocol(prepared.options).kind, 'LEGACY-NAMESPACE-RECOVERABLE')
})
