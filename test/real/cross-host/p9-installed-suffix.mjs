import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

function argument(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function comparable(value) {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return Boolean(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
}

function treeManifest(root) {
  if (!fs.existsSync(root)) return []
  const rows = []
  const walk = (absolute, relative) => {
    const stat = fs.lstatSync(absolute)
    const portable = relative.split(path.sep).join('/')
    if (stat.isSymbolicLink()) {
      rows.push({ path: portable, kind: 'link', target: sha256(fs.readlinkSync(absolute)) })
      return
    }
    if (stat.isDirectory()) {
      if (portable) rows.push({ path: portable, kind: 'directory' })
      for (const name of fs.readdirSync(absolute).sort()) {
        walk(path.join(absolute, name), relative ? path.join(relative, name) : name)
      }
      return
    }
    assert.equal(stat.isFile(), true, `unexpected filesystem object under ${root}`)
    const bytes = fs.readFileSync(absolute)
    rows.push({ path: portable, kind: 'file', bytes: bytes.length, sha256: sha256(bytes) })
  }
  walk(root, '')
  return rows
}

function checked(result, label) {
  assert.equal(result.error, undefined, `${label} spawn failed: ${result.error?.message || ''}`)
  assert.equal(result.status, 0, `${label} failed: ${result.stderr || result.stdout}`)
  return result
}

function git(cwd, args, env, label) {
  return checked(spawnSync('git', [
    '--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', cwd, ...args
  ], {
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024
  }), label).stdout.trim()
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function safeEnvironment(base, runRoot) {
  const env = { ...base }
  for (const name of Object.keys(env)) {
    if (/^(?:SKILL_GRAFT|HUB_|DSH_)/i.test(name)
      || ['NODE_AUTH_TOKEN', 'NPM_TOKEN', 'GITHUB_TOKEN'].includes(name.toUpperCase())) delete env[name]
  }
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
    NO_COLOR: '1',
    npm_config_cache: path.join(runRoot, 'npm-cache'),
    NPM_CONFIG_CACHE: path.join(runRoot, 'npm-cache')
  })
  return env
}

function localEnvironment(base, layout) {
  return {
    ...base,
    HOME: layout.localHome,
    USERPROFILE: layout.localHome,
    APPDATA: path.join(layout.localHome, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(layout.localHome, 'AppData', 'Local'),
    TEMP: layout.temp,
    TMP: layout.temp,
    SKILL_GRAFT_HOME: layout.sharedHub,
    HUB_ROOT: layout.sharedHub,
    HUB_SPAWN_CODEX: '0',
    SG_SKIP_PATH: '1',
    SG_SKIP_TASK: '1'
  }
}

function installedLocal(cliScript, env, args, requestId, expectedOk = true) {
  const result = spawnSync(process.execPath, [
    cliScript, ...args, '--contract-v1', '--request-id', requestId
  ], {
    cwd: path.dirname(path.dirname(path.dirname(cliScript))),
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 64 * 1024 * 1024
  })
  assert.equal(result.error, undefined, `${requestId} CLI spawn failed`)
  assert.equal(expectedOk ? result.status === 0 : result.status !== 0, true,
    `${requestId}: ${result.stderr || result.stdout}`)
  const envelope = JSON.parse(String(result.stdout || ''))
  assert.equal(envelope.contractVersion, 1)
  assert.equal(envelope.requestId, requestId)
  assert.equal(envelope.ok, expectedOk, `${requestId}: ${JSON.stringify(envelope.error || {})}`)
  assert.equal(envelope.meta?.handler, 'application.commandBus')
  return envelope
}

async function hostCommand(host, kind, payload, requestId, expectedOk = true) {
  const envelope = await host.application.execute({
    kind,
    ...payload,
    meta: host.commandMeta('p9-installed-suffix', requestId)
  })
  assert.equal(envelope.contractVersion, 1)
  assert.equal(envelope.requestId, requestId)
  assert.equal(envelope.ok, expectedOk, `${requestId}: ${JSON.stringify(envelope.error || {})}`)
  assert.equal(envelope.meta?.handler, 'application.commandBus')
  return envelope
}

function listeners(port) {
  if (process.platform !== 'win32') return []
  const result = checked(spawnSync('netstat.exe', ['-ano', '-p', 'tcp'], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000
  }), 'netstat listeners')
  return String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter((line) => {
    const fields = line.split(/\s+/)
    return fields.length >= 5 && fields[1].endsWith(`:${port}`) && fields[3].toUpperCase() === 'LISTENING'
  }).map((line) => Number(line.split(/\s+/).at(-1))).filter(Number.isSafeInteger).sort((a, b) => a - b)
}

function runOwnedProcesses(runId) {
  if (process.platform !== 'win32') return []
  const escaped = runId.replaceAll("'", "''")
  const script = [
    "$rows = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -in @('node.exe','cmd.exe','dsh.exe','pnpm.exe') }",
    `$rows | Where-Object { $_.ProcessId -ne ${process.pid} -and [string]$_.CommandLine -like '*${escaped}*' } | Select-Object ProcessId,Name | ConvertTo-Json -Compress`
  ].join('; ')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000
  })
  assert.equal(result.status, 0, `enumerate run-owned processes: ${result.stderr || result.stdout}`)
  const output = String(result.stdout || '').trim()
  if (!output) return []
  const parsed = JSON.parse(output)
  return Array.isArray(parsed) ? parsed : [parsed]
}

function sessionStatus(file) {
  const sessions = readJson(file).sessions
  return sessions.map((session) => ({ id: session.id, kind: session.kind, status: session.status }))
}

assert.equal(process.platform, 'win32', 'P9 installed suffix currently targets the native Windows gate')
const requestedRunRoot = argument('--run-root')
assert.ok(requestedRunRoot, 'usage: node p9-installed-suffix.mjs --run-root <absolute p9 run root>')
const runRoot = path.resolve(requestedRunRoot)
const markerFile = path.join(runRoot, '.skill-graft-p9-run.json')
assert.equal(fs.existsSync(markerFile), true, 'run root must carry the P9 ownership marker')
const marker = readJson(markerFile)
assert.equal(path.resolve(marker.runRoot), runRoot)
assert.equal(marker.runId, path.basename(runRoot))
assert.match(marker.runId, /^p9-[0-9a-f-]+$/)
assert.notEqual(comparable(runRoot), comparable(path.parse(runRoot).root))
assert.equal(fs.lstatSync(runRoot).isSymbolicLink(), false, 'run root must not be a link or junction')
const canonicalRunRoot = fs.realpathSync.native(runRoot)
assert.equal(comparable(canonicalRunRoot), comparable(runRoot), 'run root must be canonical')

const layout = {
  runId: marker.runId,
  runRoot,
  localApp: path.join(runRoot, 'local-app'),
  localHome: path.join(runRoot, 'local-home'),
  dshOsHome: path.join(runRoot, 'dsh-os-home'),
  dshHome: path.join(runRoot, 'dsh-home'),
  sharedHub: path.join(runRoot, 'dsh-home', 'skill-graft'),
  probes: path.join(runRoot, 'probes'),
  temp: path.join(runRoot, 'temp'),
  logs: path.join(runRoot, 'logs')
}
for (const value of Object.values(layout).filter((entry) => typeof entry === 'string' && entry !== marker.runId && entry !== runRoot)) {
  assert.equal(isInside(runRoot, value), true, `${value} must stay under the owned run root`)
  const stat = fs.lstatSync(value)
  assert.equal(stat.isDirectory(), true, `${value} must be an existing directory`)
  assert.equal(stat.isSymbolicLink(), false, `${value} must not be a link or junction`)
  assert.equal(isInside(canonicalRunRoot, fs.realpathSync.native(value)), true,
    `${value} must resolve under the canonical owned run root`)
}
assert.notEqual(comparable(layout.localHome), comparable(layout.dshHome))
assert.equal(isInside(layout.dshHome, layout.sharedHub), true)
assert.deepEqual(runOwnedProcesses(marker.runId), [], 'the preserved run has no live owned process before suffix')

const localPackageRoot = path.join(layout.localApp, 'node_modules', 'ozdqp-skill-hub')
const localCliScript = path.join(localPackageRoot, 'dist', 'control', 'cli.js')
const dshPackageRoot = path.join(layout.dshHome, 'profiles', 'web', 'node_modules', '@ozdqp', 'skill-graft-dsh')
for (const required of [localCliScript, path.join(dshPackageRoot, 'lib', 'index.js')]) {
  assert.equal(fs.existsSync(required), true, `installed artifact is required: ${required}`)
}
assert.equal(fs.existsSync(path.join(localPackageRoot, 'src')), false)
assert.equal(fs.existsSync(path.join(dshPackageRoot, 'src')), false)

const baseEnv = safeEnvironment(process.env, runRoot)
const localEnv = localEnvironment(baseEnv, layout)
const sharedProbe = path.join(layout.probes, 'shared-state-only')
const localProbe = path.join(layout.probes, 'local-owned')
const dshProbe = path.join(layout.probes, 'dsh-owned')
const sharedManifestBeforeSuffix = treeManifest(sharedProbe)
assert.equal(git(sharedProbe, ['status', '--porcelain=v1', '--untracked-files=all'], localEnv, 'shared probe status'), '',
  'the rejected busy writer preserved the committed shared probe')

const reviewRoot = path.join(layout.sharedHub, 'skill-review')
const stateFile = path.join(reviewRoot, 'state.json')
const ledgerFile = path.join(reviewRoot, 'application-ledger.json')
const auditFile = path.join(reviewRoot, 'application-audit.json')
const sessionsFile = path.join(reviewRoot, 'sessions.json')
const dshSessionsFile = path.join(reviewRoot, 'dsh-sessions.json')
const profileCommand = fs.readFileSync(path.join(layout.logs, 'dsh-profile.stderr.log'), 'utf8')
const profilePortMatch = profileCommand.match(/"--port"\s+"([0-9]+)"/)
assert.ok(profilePortMatch, 'preserved run must record the selected DSH profile port')
const profilePort = Number(profilePortMatch[1])
assert.equal(Number.isInteger(profilePort) && profilePort > 0 && profilePort <= 65535, true)
const busyRequestId = `p9-dsh-shared-pin-busy-${marker.runId}`
const ledgerAfterBusy = fs.readFileSync(ledgerFile)
const auditAfterBusy = fs.readFileSync(auditFile)
assert.equal(ledgerAfterBusy.includes(Buffer.from(busyRequestId)), false,
  'LOCK_BUSY is rejected before request-ledger mutation')
assert.equal(auditAfterBusy.includes(Buffer.from(busyRequestId)), false,
  'LOCK_BUSY is rejected before audit mutation')

const ledger = JSON.parse(ledgerAfterBusy.toString('utf8'))
const snapshotBEntry = ledger.entries.find((entry) => entry.requestId === `p9-dsh-snapshot-b-${marker.runId}`)
assert.equal(snapshotBEntry?.status, 'completed')
const snapshotB = snapshotBEntry.result.data.snapshot.snapshotId
const hostModule = await import(pathToFileURL(path.join(localPackageRoot, 'dist', 'dsh', 'create-dsh-host.js')).href)
const leaseModule = await import(pathToFileURL(path.join(localPackageRoot, 'dist', 'adapters', 'lease-lock.js')).href)
const directDshHost = await hostModule.openDshHost({
  packageRoot: dshPackageRoot,
  dataRoot: layout.sharedHub,
  hostId: 'dsh-p9-installed-suffix',
  leaseMs: 30_000
})

let sharedRead
let inspectedFuture
let rejectedFuture
let finalDshStatus
let finalLocalSchema
let stateAfterWinner
try {
  const localWinner = installedLocal(localCliScript, localEnv, [
    'pin', 'set', '--worktree', sharedProbe,
    '--snapshot', snapshotB,
    '--skill', 'ozdqp-development'
  ], `p9-local-shared-pin-winner-${marker.runId}`)
  assert.equal(localWinner.data.pin.requestedSnapshot, snapshotB)
  sharedRead = await hostCommand(directDshHost, 'getPin', {
    worktree: sharedProbe
  }, `p9-dsh-shared-pin-read-${marker.runId}`)
  assert.equal(sharedRead.data.pin.requestedSnapshot, snapshotB)
  assert.deepEqual(treeManifest(sharedProbe), sharedManifestBeforeSuffix,
    'shared-state pin success must not materialize the shared probe')

  stateAfterWinner = fs.readFileSync(stateFile)
  const ledgerBeforeSkew = fs.readFileSync(ledgerFile)
  const auditBeforeSkew = fs.readFileSync(auditFile)
  const libraryBeforeSkew = treeManifest(path.join(reviewRoot, 'library'))
  const probesBeforeSkew = {
    local: treeManifest(localProbe),
    dsh: treeManifest(dshProbe),
    shared: treeManifest(sharedProbe)
  }
  const futureState = Buffer.from('{"schemaVersion":3,"future":{"opaque":true}}\n', 'utf8')
  fs.writeFileSync(stateFile, futureState)
  try {
    inspectedFuture = await hostCommand(directDshHost, 'inspectSchema', {},
      `p9-dsh-future-schema-${marker.runId}`)
    assert.deepEqual({
      status: inspectedFuture.data.status,
      detected: inspectedFuture.data.detectedSchemaVersion,
      current: inspectedFuture.data.currentSchemaVersion,
      revision: inspectedFuture.data.stateRevision,
      writable: inspectedFuture.data.writable,
      migrationRequired: inspectedFuture.data.migrationRequired
    }, {
      status: 'unsupported',
      detected: 3,
      current: 2,
      revision: null,
      writable: false,
      migrationRequired: false
    })
    rejectedFuture = installedLocal(localCliScript, localEnv, ['snapshot', 'create'],
      `p9-local-future-write-${marker.runId}`, false)
    assert.equal(rejectedFuture.error.code, 'STATE_VERSION_UNSUPPORTED')
    assert.equal(rejectedFuture.error.retryable, false)
    assert.deepEqual(fs.readFileSync(stateFile), futureState, 'future schema bytes remain exact')
    assert.deepEqual(fs.readFileSync(ledgerFile), ledgerBeforeSkew)
    assert.deepEqual(fs.readFileSync(auditFile), auditBeforeSkew)
    assert.deepEqual(treeManifest(path.join(reviewRoot, 'library')), libraryBeforeSkew)
    assert.deepEqual({
      local: treeManifest(localProbe),
      dsh: treeManifest(dshProbe),
      shared: treeManifest(sharedProbe)
    }, probesBeforeSkew)
  } finally {
    fs.writeFileSync(stateFile, stateAfterWinner)
  }

  finalLocalSchema = installedLocal(localCliScript, localEnv, ['inspect-schema'],
    `p9-local-final-schema-${marker.runId}`)
  assert.equal(finalLocalSchema.data.status, 'current')
  finalDshStatus = await hostCommand(directDshHost, 'status', {},
    `p9-dsh-final-status-${marker.runId}`)
  assert.equal(finalDshStatus.ok, true)
} finally {
  await directDshHost.dispose()
}

assert.deepEqual(fs.readFileSync(stateFile), stateAfterWinner, 'future-schema fixture restores the exact current state')
assert.deepEqual(treeManifest(sharedProbe), sharedManifestBeforeSuffix,
  'all suffix operations preserve the shared-probe bytes')
const leaseRoot = leaseModule.applicationLeaseRoot(layout.sharedHub)
assert.deepEqual(treeManifest(path.join(layout.sharedHub, '.skill-graft-transactions')), [],
  'shared durable transaction residue is zero')
assert.deepEqual(treeManifest(path.join(leaseRoot, 'leases')), [], 'lease residue is zero')
for (const [name, worktree] of Object.entries({ localProbe, dshProbe, sharedProbe })) {
  const relative = git(worktree, ['rev-parse', '--git-path', 'skill-graft/transactions'], localEnv,
    `${name} transaction path`)
  const transactionRoot = path.resolve(worktree, relative)
  assert.deepEqual(treeManifest(transactionRoot), [], `${name} materialization transaction residue is zero`)
}
assert.deepEqual(listeners(profilePort), [], 'the preserved run profile listener is released')
assert.deepEqual(runOwnedProcesses(marker.runId), [], 'the preserved run has no live owned process after suffix')

const localMaterialization = readJson(path.join(localProbe, '.git', 'skill-graft', 'materialized-v1.json'))
const dshMaterialization = readJson(path.join(dshProbe, '.git', 'skill-graft', 'materialized-v1.json'))
const summary = {
  schemaVersion: 1,
  runId: marker.runId,
  installedArtifacts: {
    localPackageRoot,
    dshPackageRoot,
    sourceTreeCliUsed: false,
    localPackageContainsSource: false,
    dshPackageContainsSource: false
  },
  shared: {
    busyEvidence: {
      priorRunnerObservation: {
        requestId: busyRequestId,
        code: 'LOCK_BUSY',
        retryable: true,
        source: 'operator-captured node:test failure output',
        assertedBySuffix: false
      },
      suffixAssertions: {
        requestAbsentFromLedger: true,
        requestAbsentFromAudit: true,
        probeBytesPreserved: true
      }
    },
    winnerSnapshot: snapshotB,
    dshReadWinner: sharedRead.data.pin.requestedSnapshot,
    futureSchema: {
      inspectStatus: inspectedFuture.data.status,
      detected: inspectedFuture.data.detectedSchemaVersion,
      writable: inspectedFuture.data.writable,
      rejectionCode: rejectedFuture.error.code,
      retryable: rejectedFuture.error.retryable,
      bytesPreserved: true
    },
    finalStateSha256: sha256(fs.readFileSync(stateFile)),
    finalLedgerSha256: sha256(fs.readFileSync(ledgerFile)),
    finalAuditSha256: sha256(fs.readFileSync(auditFile))
  },
  materialization: {
    local: {
      snapshotId: localMaterialization.snapshotId,
      materializationId: localMaterialization.materializationId
    },
    dshComposition: {
      snapshotId: dshMaterialization.snapshotId,
      materializationId: dshMaterialization.materializationId
    },
    sameProbeCrossHostSync: false
  },
  sessions: {
    local: sessionStatus(sessionsFile),
    dshComposition: sessionStatus(dshSessionsFile)
  },
  status: {
    localSchema: finalLocalSchema.data.status,
    dshCompositionOk: finalDshStatus.ok
  },
  isolation: {
    localHome: layout.localHome,
    dshHome: layout.dshHome,
    distinctHomes: comparable(layout.localHome) !== comparable(layout.dshHome),
    listenerPort: profilePort,
    listenerReleased: true,
    ownedProcesses: 0,
    leaseResidue: 0,
    transactionResidue: 0
  }
}
const summaryFile = path.join(layout.logs, 'p9-suffix-summary.json')
fs.writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
process.stdout.write(`P9_SUFFIX_SUMMARY ${JSON.stringify(summary)}\n`)
