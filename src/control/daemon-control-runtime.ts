import { randomUUID } from 'node:crypto'

import type {
  DaemonExactProcessTree,
  DaemonProcessHost
} from '../adapters/daemon-process-host.js'
import {
  acquireAbandonedDaemonControlStageCleanupAuthority,
  acquireDaemonControlRetirementAuthority,
  acquireDaemonControlSignalAuthority,
  assertDaemonControlStageCurrent,
  bootstrapDaemonStageNamespace,
  cleanupAbandonedDaemonControlStage,
  createDaemonLegacyRetireStage,
  createDaemonStopStage,
  inspectDaemonProtocol,
  inspectDaemonReceiptNamespace,
  readDaemonControlSignalTarget,
  recoverDaemonControlStage,
  retireDaemonControlStage,
  type DaemonActorV1,
  type DaemonControlTargetFacts,
  type DaemonLifecycleOwnerBindingV1,
  type DaemonProtocolCheckpoint,
  type DaemonProtocolInspection,
  type InspectDaemonProtocolOptions
} from './daemon-protocol.js'
import {
  observeDaemonAuthority,
  type DaemonRuntimeHealthProbe,
  type DaemonRuntimeProtocolOptions
} from './daemon-runtime.js'

export type DaemonLegacyControlHint = Readonly<{
  pid: number
  apiPid: number
  port: number
}>

export type DaemonControlRuntimeOptions = Readonly<{
  protocol: DaemonRuntimeProtocolOptions
  processHost: DaemonProcessHost
  healthProbe: DaemonRuntimeHealthProbe
  lifecycleOwnerBinding?: DaemonLifecycleOwnerBindingV1 | null
  readLifecycleOwnerAuthority?: InspectDaemonProtocolOptions['readLifecycleOwnerAuthority']
  legacyHint?: DaemonLegacyControlHint | null
  checkpoint?: DaemonProtocolCheckpoint
  timeoutMs?: number
}>

export type DaemonControlRuntimeResult = Readonly<{
  stopped: boolean
  alreadyAbsent: boolean
  operation: 'none' | 'stop' | 'legacy-retire'
  terminal: DaemonProtocolInspection
}>

type CapturedControlFacts = Readonly<{
  facts: DaemonControlTargetFacts
  tree: DaemonExactProcessTree | null
}>

function inspectOptions(options: DaemonControlRuntimeOptions): InspectDaemonProtocolOptions {
  return Object.freeze({
    home: options.protocol.home,
    dataRoot: options.protocol.dataRoot,
    ...(options.protocol.platform ? { platform: options.protocol.platform } : {}),
    readReceiptAuthority: options.protocol.readReceiptAuthority,
    ...(options.readLifecycleOwnerAuthority
      ? { readLifecycleOwnerAuthority: options.readLifecycleOwnerAuthority }
      : {})
  })
}

function controlActor(processHost: DaemonProcessHost): DaemonActorV1 {
  const actor = processHost.processFacts(process.pid)
  if (actor.state !== 'alive') throw new Error(`daemon controller process facts are ${actor.state}`)
  return Object.freeze({
    pid: process.pid,
    processIdentity: actor.processIdentity,
    pgid: actor.pgid,
    createdAt: new Date().toISOString()
  })
}

function actorProbe(processHost: DaemonProcessHost, pid: number) {
  const facts = processHost.processFacts(pid)
  if (facts.state !== 'alive') return Object.freeze({ state: facts.state })
  return Object.freeze({
    state: 'alive' as const,
    processIdentity: facts.processIdentity,
    pgid: facts.pgid
  })
}

function terminalProcessFacts(pid: number, processHost: DaemonProcessHost): DaemonControlTargetFacts['process'] {
  const processFacts = processHost.processFacts(pid)
  if (processFacts.state === 'dead') return Object.freeze({ state: 'dead' as const, pid })
  if (processFacts.state === 'unknown') return Object.freeze({ state: 'unknown' as const, pid })
  return Object.freeze({
    state: 'alive' as const,
    pid,
    processIdentity: processFacts.processIdentity,
    pgid: processFacts.pgid,
    processTree: Object.freeze([{ pid, processIdentity: processFacts.processIdentity }])
  })
}

function captureControlFacts(
  processHost: DaemonProcessHost,
  target: Readonly<{
    pid: number
    apiPid: number
    processIdentity: string
    pgid: number
    port: number
  }>
): CapturedControlFacts {
  const root = processHost.processFacts(target.pid)
  const listener = processHost.listenerFacts(target.port)
  if (root.state !== 'alive') {
    const processFacts = root.state === 'dead'
      ? Object.freeze({ state: 'dead' as const, pid: target.pid })
      : Object.freeze({ state: 'unknown' as const, pid: target.pid })
    const listenerFacts = listener.state === 'absent'
      ? Object.freeze({ state: 'absent' as const, port: target.port })
      : Object.freeze({ state: 'unknown' as const, port: target.port })
    return Object.freeze({
      facts: Object.freeze({ process: processFacts, listener: listenerFacts }),
      tree: null
    })
  }
  if (root.processIdentity !== target.processIdentity || root.pgid !== target.pgid) {
    return Object.freeze({
      facts: Object.freeze({
        process: Object.freeze({
          state: 'alive' as const,
          pid: root.pid,
          processIdentity: root.processIdentity,
          pgid: root.pgid,
          processTree: Object.freeze([{ pid: root.pid, processIdentity: root.processIdentity }])
        }),
        listener: listener.state === 'absent'
          ? Object.freeze({ state: 'absent' as const, port: target.port })
          : Object.freeze({ state: 'unknown' as const, port: target.port })
      }),
      tree: null
    })
  }
  const tree = processHost.processTree(target.pid, target.processIdentity)
  if (tree.state !== 'exact') {
    return Object.freeze({
      facts: Object.freeze({
        process: Object.freeze({ state: 'unknown' as const, pid: target.pid }),
        listener: Object.freeze({ state: 'unknown' as const, port: target.port })
      }),
      tree: null
    })
  }
  const api = tree.entries.find((entry) => entry.pid === target.apiPid)
  const listenerOwned = listener.state === 'present' && listener.pids.length === 1
    && listener.pids[0] === target.apiPid
    && listener.bindings.length > 0
    && listener.bindings.every((binding) => binding.pid === target.apiPid && binding.port === target.port)
  const listenerFacts = listenerOwned && api
    ? Object.freeze({
        state: 'owned' as const,
        port: target.port,
        pid: target.apiPid,
        processIdentity: api.processIdentity
      })
    : listener.state === 'absent'
      ? Object.freeze({ state: 'absent' as const, port: target.port })
      : Object.freeze({ state: 'unknown' as const, port: target.port })
  return Object.freeze({
    facts: Object.freeze({
      process: Object.freeze({
        state: 'alive' as const,
        pid: target.pid,
        processIdentity: target.processIdentity,
        pgid: target.pgid,
        processTree: Object.freeze(tree.entries.map((entry) => Object.freeze({
          pid: entry.pid,
          processIdentity: entry.processIdentity
        })))
      }),
      listener: listenerFacts
    }),
    tree
  })
}

function targetFromInspection(
  inspection: DaemonProtocolInspection,
  legacyHint: DaemonLegacyControlHint | null | undefined
) {
  if (inspection.manifest && inspection.manifest.operation !== 'start') {
    return inspection.manifest.target
  }
  if (inspection.kind === 'RUNNING-CLEAN' && inspection.instance) return inspection.instance
  if ((inspection.kind === 'LEGACY' || inspection.kind === 'LEGACY-NAMESPACE-RECOVERABLE') && legacyHint) {
    const root = Number(legacyHint.pid)
    const apiPid = Number(legacyHint.apiPid)
    const port = Number(legacyHint.port)
    if (!Number.isSafeInteger(root) || root < 1 || apiPid !== root
      || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new Error('legacy daemon control hint is invalid')
    }
    return { pid: root, apiPid, port, processIdentity: '', pgid: 0 }
  }
  return null
}

async function waitForListenerAbsence(
  processHost: DaemonProcessHost,
  port: number,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const listener = processHost.listenerFacts(port)
    if (listener.state === 'absent') return
    if (listener.state === 'unknown') throw new Error('daemon listener terminal facts are unknown')
    if (Date.now() >= deadline) throw new Error('daemon listener did not become absent')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

export async function stopDaemonRuntime(
  options: DaemonControlRuntimeOptions
): Promise<DaemonControlRuntimeResult> {
  const protocolOptions = inspectOptions(options)
  const checkpoint = options.checkpoint || (() => {})
  const timeoutMs = options.timeoutMs ?? 10_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 120_000) {
    throw new TypeError('daemon control timeout is invalid')
  }
  if (Boolean(options.lifecycleOwnerBinding) !== Boolean(options.readLifecycleOwnerAuthority)) {
    throw new Error('daemon lifecycle control requires both the frozen binding and its authority reader')
  }
  let inspection = inspectDaemonProtocol(protocolOptions)
  for (let attempt = 0; attempt < 4
    && (inspection.kind === 'STOPPING-PARTIAL' || inspection.kind === 'LEGACY-RETIRING-PARTIAL');
    attempt += 1) {
    const authority = acquireAbandonedDaemonControlStageCleanupAuthority(
      protocolOptions,
      inspection,
      ({ pid }) => actorProbe(options.processHost, pid)
    )
    inspection = cleanupAbandonedDaemonControlStage(authority, checkpoint)
  }
  if (inspection.kind === 'STOPPING-PARTIAL' || inspection.kind === 'LEGACY-RETIRING-PARTIAL') {
    throw new Error(`daemon ${inspection.kind} cleanup did not converge`)
  }
  if (inspection.kind === 'ABSENT' || inspection.kind === 'NAMESPACE-RECOVERABLE') {
    return Object.freeze({ stopped: true, alreadyAbsent: true, operation: 'none', terminal: inspection })
  }

  if (inspection.kind === 'LEGACY') {
    const receipt = inspectDaemonReceiptNamespace(
      protocolOptions.home,
      protocolOptions.dataRoot,
      protocolOptions.readReceiptAuthority,
      protocolOptions.platform
    )
    bootstrapDaemonStageNamespace({
      ...protocolOptions,
      expectedInspection: inspection,
      expectedReceiptAuthority: receipt,
      checkpoint
    })
    inspection = inspectDaemonProtocol(protocolOptions)
  }

  let operation: 'stop' | 'legacy-retire'
  let captured: CapturedControlFacts
  if (inspection.kind === 'RUNNING-CLEAN' && inspection.instance) {
    const observed = await observeDaemonAuthority(options.protocol, options.processHost, options.healthProbe)
    if (observed.state === 'exact') {
      captured = Object.freeze({
        facts: Object.freeze({
          process: Object.freeze({
            state: 'alive' as const,
            pid: observed.instance.pid,
            processIdentity: observed.instance.processIdentity,
            pgid: observed.instance.pgid,
            processTree: Object.freeze(observed.processTree.entries.map((entry) => Object.freeze({
              pid: entry.pid,
              processIdentity: entry.processIdentity
            })))
          }),
          listener: Object.freeze({
            state: 'owned' as const,
            port: observed.instance.port,
            pid: observed.instance.apiPid,
            processIdentity: observed.apiProcess.processIdentity
          })
        }),
        tree: observed.processTree
      })
    } else {
      captured = captureControlFacts(options.processHost, inspection.instance)
    }
    createDaemonStopStage(protocolOptions, inspection, {
      operationId: randomUUID(),
      actor: controlActor(options.processHost),
      lifecycleOwnerBinding: options.lifecycleOwnerBinding || null,
      targetFacts: captured.facts,
      checkpoint
    })
    operation = 'stop'
    inspection = inspectDaemonProtocol(protocolOptions)
  } else if (inspection.kind === 'LEGACY-NAMESPACE-RECOVERABLE') {
    const hint = targetFromInspection(inspection, options.legacyHint)
    if (!hint) throw new Error('legacy daemon retirement requires exact legacy target facts')
    const root = options.processHost.processFacts(hint.pid)
    if (root.state !== 'alive') throw new Error('legacy daemon retirement cannot invent a dead process identity')
    captured = captureControlFacts(options.processHost, {
      ...hint,
      processIdentity: root.processIdentity,
      pgid: root.pgid
    })
    createDaemonLegacyRetireStage(protocolOptions, inspection, {
      operationId: randomUUID(),
      actor: controlActor(options.processHost),
      lifecycleOwnerBinding: options.lifecycleOwnerBinding || null,
      targetFacts: captured.facts,
      checkpoint
    })
    operation = 'legacy-retire'
    inspection = inspectDaemonProtocol(protocolOptions)
  } else if (inspection.kind === 'STOPPING' || inspection.kind === 'LEGACY-RETIRING') {
    recoverDaemonControlStage(protocolOptions, inspection, checkpoint)
    operation = inspection.kind === 'STOPPING' ? 'stop' : 'legacy-retire'
  } else {
    throw new Error(`daemon ${inspection.kind} is not an actionable control state`)
  }

  inspection = inspectDaemonProtocol(protocolOptions)
  const target = targetFromInspection(inspection, options.legacyHint)
  if (!target || !inspection.manifest || inspection.manifest.operation === 'start') {
    throw new Error('daemon control stage lost its frozen target')
  }
  captured = captureControlFacts(options.processHost, target)
  if (captured.facts.process.state === 'alive'
    && captured.facts.process.processIdentity === target.processIdentity) {
    if (!captured.tree) throw new Error('daemon signal has no exact host-issued process tree')
    const signal = acquireDaemonControlSignalAuthority(protocolOptions, inspection, captured.facts)
    const signalTarget = readDaemonControlSignalTarget(signal)
    if (signalTarget.pid !== captured.tree.rootPid
      || signalTarget.processIdentity !== captured.tree.rootProcessIdentity) {
      throw new Error('daemon signal authority differs from the host-issued tree')
    }
    assertDaemonControlStageCurrent(recoverDaemonControlStage(protocolOptions, inspection, checkpoint))
    const signaled = options.processHost.terminateExactTree(captured.tree)
    if (signaled.state === 'unknown') throw new Error('daemon exact tree signal was refused')
    const exited = options.processHost.waitForExit(captured.tree, timeoutMs)
    if (exited.state !== 'exited') throw new Error(`daemon exact tree exit is ${exited.state}`)
    await waitForListenerAbsence(options.processHost, target.port, timeoutMs)
    captured = Object.freeze({
      facts: Object.freeze({
        process: terminalProcessFacts(target.pid, options.processHost),
        listener: Object.freeze({ state: 'absent' as const, port: target.port })
      }),
      tree: null
    })
  }
  const retirement = acquireDaemonControlRetirementAuthority(
    protocolOptions,
    inspectDaemonProtocol(protocolOptions),
    captured.facts
  )
  const terminal = retireDaemonControlStage(retirement, checkpoint)
  return Object.freeze({ stopped: true, alreadyAbsent: false, operation, terminal })
}
