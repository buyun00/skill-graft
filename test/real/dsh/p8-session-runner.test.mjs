import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { openDshHost } from '../../../dist/dsh/create-dsh-host.js'
import { createDshSessionRuntime } from '../../../dist/dsh/session-runtime.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const sourcePackageRoot = path.join(repoRoot, 'packages', 'host-dsh')
const stagedPackageRoot = path.join(repoRoot, '.artifacts-local', 'dsh-package')

function writeText(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, 'utf8')
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

async function command(host, kind, payload = {}) {
  return await host.application.execute({
    kind,
    ...payload,
    meta: host.commandMeta('p8-focused')
  })
}

function deferred() {
  let resolve
  const promise = new Promise((accept) => { resolve = accept })
  return { promise, resolve }
}

class FakeDshDriver {
  constructor(scripts = []) {
    this.scripts = [...scripts]
    this.calls = []
    this.runs = new Map()
    this.accepting = true
  }

  available() { return this.accepting }

  launch(kind, input) {
    this.calls.push({ kind, ...input })
    const script = this.scripts.shift() || { state: 'succeeded', exitCode: 0 }
    if (script === 'throw') throw new Error('scripted DSH launch failure')
    const gate = script === 'pending' ? deferred() : null
    const result = gate ? gate.promise : Promise.resolve({ ...script })
    const run = { state: 'running', result, gate, outcome: null }
    result.then((outcome) => { run.outcome = outcome; run.state = outcome.state })
    this.runs.set(input.runnerId, run)
    return {
      runnerId: input.runnerId,
      continuationToken: input.runnerId,
      startedAt: '2026-08-25T01:00:00.000Z',
      result
    }
  }

  async start(input) { return this.launch('start', input) }
  async resume(input) { return this.launch('resume', input) }

  async cancel(runnerId) {
    this.calls.push({ kind: 'cancel', runnerId })
    const run = this.runs.get(runnerId)
    if (!run) return { state: 'not-found' }
    if (run.outcome) return run.outcome
    run.state = 'cancelling'
    run.gate?.resolve({ state: 'cancelled', endedAt: '2026-08-25T01:00:01.000Z', exitCode: null })
    return { state: 'cancelling' }
  }

  async status(runnerId) {
    this.calls.push({ kind: 'status', runnerId })
    const run = this.runs.get(runnerId)
    if (!run) return { state: 'not-found' }
    return run.outcome || { state: run.state }
  }

  async dispose() {
    this.accepting = false
    for (const run of this.runs.values()) {
      if (!run.outcome) run.gate?.resolve({ state: 'cancelled', exitCode: null })
    }
    await Promise.allSettled([...this.runs.values()].map((run) => run.result))
  }
}

function runtimeFactory(driver) {
  return context => createDshSessionRuntime(context, driver)
}

function fixtureRoot(t, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `skill-graft-dsh-p8-${name}-`))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dataRoot = path.join(root, 'dsh-home', 'skill-graft')
  writeText(path.join(dataRoot, 'AGENTS.override.md'), '# DSH P8 fixture authority\n')
  writeText(path.join(dataRoot, 'skills', 'ozdqp-development', 'SKILL.md'), [
    '---',
    'name: ozdqp-development',
    'description: DSH P8 real fixture',
    '---',
    '# P8 Skill',
    '',
    'Materialized only through Application sync.',
    ''
  ].join('\n'))
  return { root, dataRoot }
}

test('P8 production bundle publishes only DSH-native session, tool, RPC, and UI dependencies', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(stagedPackageRoot, 'package.json'), 'utf8'))
  for (const dependency of [
    '@deepseek-ai/dsh-agent',
    '@deepseek-ai/dsh-agent-default-model',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-session',
    '@deepseek-ai/dsh-tools'
  ]) assert.equal(typeof packageJson.peerDependencies[dependency], 'string')
  assert.equal(packageJson.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'), true)
  const patch = fs.readFileSync(path.join(stagedPackageRoot, 'cordis.patch.yml'), 'utf8')
  for (const service of ['agentDefaultModel', 'agents', 'sessionPersistence', 'sessions', 'tools']) {
    assert.match(patch, new RegExp(`\\b${service}\\b`))
  }
  const host = fs.readFileSync(path.join(stagedPackageRoot, 'lib', 'index.js'), 'utf8')
  const client = fs.readFileSync(path.join(stagedPackageRoot, 'lib', 'client.js'), 'utf8')
  for (const marker of ['skill_graft_session', 'execute-from-session', 'RUNNER_RESUME_FAILED']) {
    assert.equal(host.includes(marker), true, `Host bundle must contain ${marker}`)
  }
  for (const marker of ['data-skill-graft-section', 'sessions', 'conversation.session.header.actions']) {
    assert.equal(client.includes(marker), true, `Client bundle must contain ${marker}`)
  }
  for (const forbidden of ['127.0.0.1:18765', 'codex-session-runner']) {
    assert.equal(host.toLowerCase().includes(forbidden.toLowerCase()), false)
    assert.equal(client.toLowerCase().includes(forbidden.toLowerCase()), false)
  }
})

test('P8 attach reaches awaiting then Application claim and sync record materialization proof', async (t) => {
  const fixture = fixtureRoot(t, 'attach')
  const worktree = path.join(fixture.root, 'workspace')
  fs.mkdirSync(worktree, { recursive: true })
  git(worktree, 'init')
  git(worktree, 'config', 'user.email', 'p8@example.invalid')
  git(worktree, 'config', 'user.name', 'P8 Gate')
  git(worktree, 'config', 'extensions.worktreeConfig', 'true')
  writeText(path.join(worktree, 'README.md'), '# P8 worktree\n')
  writeText(path.join(worktree, 'AGENTS.md'), '# P8 recognition marker\n')
  fs.mkdirSync(path.join(worktree, 'baloot_client'))
  git(worktree, 'add', '.')
  git(worktree, 'commit', '-m', 'fixture')

  const driver = new FakeDshDriver([{ state: 'succeeded', exitCode: 0 }])
  const host = await openDshHost({
    packageRoot: sourcePackageRoot,
    dataRoot: fixture.dataRoot,
    hostId: 'dsh-p8-attach',
    runtimeRevision: '0.1.0-p8',
    createSessionRuntime: runtimeFactory(driver)
  })
  t.after(() => host.dispose())

  const created = await command(host, 'createSnapshot')
  assert.equal(created.ok, true, JSON.stringify(created))
  const snapshotId = created.data.snapshot.snapshotId
  const migrationPlan = await command(host, 'migrateState', { mode: 'dryRun' })
  assert.equal(migrationPlan.ok, true, JSON.stringify(migrationPlan))
  const migrated = await command(host, 'migrateState', {
    mode: 'commit',
    planHash: migrationPlan.data.plan.planHash
  })
  assert.equal(migrated.ok, true, JSON.stringify(migrated))
  const started = await command(host, 'attach', {
    worktree,
    intent: 'P8 true attach',
    runner: { wait: false, profile: 'mock', quality: 'mock' }
  })
  assert.equal(started.ok, true, JSON.stringify(started))
  assert.equal(started.data.session.status, 'running')
  const sessionId = started.data.session.id
  await new Promise((resolve) => setImmediate(resolve))
  const reaped = await command(host, 'reapSessions', { sessionIds: [sessionId] })
  assert.equal(reaped.ok, true, JSON.stringify(reaped))
  const ready = await command(host, 'getSession', { sessionId })
  assert.equal(ready.ok, true)
  assert.equal(ready.data.session.status, 'awaiting')
  assert.equal(ready.data.session.exitCode, 0)

  const claimed = await command(host, 'claimWorktree', {
    worktree,
    snapshotId,
    selectedSkills: ['ozdqp-development'],
    sessionId
  })
  assert.equal(claimed.ok, true, JSON.stringify(claimed))
  const planned = await command(host, 'planSync', { worktree })
  assert.equal(planned.ok, true, JSON.stringify(planned))
  assert.equal(planned.data.plan.executable, true, JSON.stringify(planned.data.plan))
  const synced = await command(host, 'sync', {
    worktree,
    planHash: planned.data.plan.planHash,
    sessionId
  })
  assert.equal(synced.ok, true, JSON.stringify(synced))

  const read = await command(host, 'getSession', { sessionId })
  assert.equal(read.ok, true)
  assert.equal(read.data.session.status, 'completed')
  assert.equal(read.data.session.attachCompletion.targetId, read.data.session.target.id)
  assert.equal(read.data.session.events.some((event) => event.type === 'session.completed'), true)
  assert.equal(fs.readFileSync(path.join(worktree, 'AGENTS.override.md'), 'utf8'), '# DSH P8 fixture authority\n')
  assert.match(fs.readFileSync(path.join(worktree, '.agents', 'skills', 'ozdqp-development', 'SKILL.md'), 'utf8'), /P8 Skill/)

  const publicJson = JSON.stringify(read.data.session).toLowerCase()
  for (const forbidden of [worktree.toLowerCase(), 'pid', 'argv', 'codex', 'powershell']) {
    assert.equal(publicJson.includes(forbidden), false, `SessionView leaked ${forbidden}`)
  }
  assert.equal(driver.calls[0].workingDirectory, worktree)
  assert.match(driver.calls[0].prompt, /Application-owned/)
})

test('P8 persists a failed continuation across host restart, resumes it, and confirms cancellation', async (t) => {
  const fixture = fixtureRoot(t, 'resume')
  const firstDriver = new FakeDshDriver([{
    state: 'failed', exitCode: 1, errorCode: 'RUNNER_PROTOCOL_ERROR'
  }])
  const first = await openDshHost({
    packageRoot: sourcePackageRoot,
    dataRoot: fixture.dataRoot,
    hostId: 'dsh-p8-first',
    runtimeRevision: '0.1.0-p8',
    createSessionRuntime: runtimeFactory(firstDriver)
  })
  const relativeWorktree = await command(first, 'chat', {
    worktree: 'relative-worktree',
    intent: 'must fail closed before DSH launch',
    runner: { wait: false, profile: 'mock', quality: 'mock' }
  })
  assert.equal(relativeWorktree.ok, false)
  assert.equal(firstDriver.calls.length, 0)
  const failed = await command(first, 'chat', {
    worktree: fixture.root,
    intent: 'fail once',
    runner: { wait: false, profile: 'mock', quality: 'mock' }
  })
  assert.equal(failed.ok, true)
  const sessionId = failed.data.session.id
  await new Promise((resolve) => setImmediate(resolve))
  await command(first, 'reapSessions', { sessionIds: [sessionId] })
  const failedRead = await command(first, 'getSession', { sessionId })
  assert.equal(failedRead.data.session.status, 'failed')
  assert.equal(failedRead.data.session.capabilities.canResume, true)
  assert.equal(firstDriver.calls[0].workingDirectory, fs.realpathSync(fixture.root))
  const runnerId = failedRead.data.session.runnerId
  await first.dispose()

  const secondDriver = new FakeDshDriver([
    'throw',
    { state: 'succeeded', exitCode: 0 },
    { state: 'succeeded', exitCode: 7 },
    'pending'
  ])
  const second = await openDshHost({
    packageRoot: sourcePackageRoot,
    dataRoot: fixture.dataRoot,
    hostId: 'dsh-p8-second',
    runtimeRevision: '0.1.0-p8',
    createSessionRuntime: runtimeFactory(secondDriver)
  })
  t.after(() => second.dispose())
  const rejectedResume = await command(second, 'resumeSession', {
    sessionId,
    message: 'scripted resume failure',
    runner: { wait: false, profile: 'mock', quality: 'mock' }
  })
  assert.equal(rejectedResume.ok, true, JSON.stringify(rejectedResume))
  assert.equal(rejectedResume.data.session.status, 'failed')
  assert.equal(rejectedResume.data.session.runnerId, runnerId)
  assert.equal(rejectedResume.data.session.capabilities.canResume, true)

  const resumed = await command(second, 'resumeSession', {
    sessionId,
    message: 'resume after restart',
    runner: { wait: false, profile: 'mock', quality: 'mock' }
  })
  assert.equal(resumed.ok, true, JSON.stringify(resumed))
  assert.equal(resumed.data.session.runnerId, runnerId)
  assert.equal(secondDriver.calls.some((call) => call.kind === 'resume'), true)
  await new Promise((resolve) => setImmediate(resolve))
  await command(second, 'reapSessions', { sessionIds: [sessionId] })
  const resumedRead = await command(second, 'getSession', { sessionId })
  assert.equal(resumedRead.data.session.status, 'completed')

  const nonZero = await command(second, 'chat', {
    intent: 'non-zero success must fail closed',
    runner: { wait: false, profile: 'mock', quality: 'mock' }
  })
  assert.equal(nonZero.ok, true)
  await new Promise((resolve) => setImmediate(resolve))
  await command(second, 'reapSessions', { sessionIds: [nonZero.data.session.id] })
  const nonZeroRead = await command(second, 'getSession', { sessionId: nonZero.data.session.id })
  assert.equal(nonZeroRead.data.session.status, 'failed')
  assert.equal(nonZeroRead.data.session.exitCode, 7)
  assert.equal(nonZeroRead.data.session.error, 'RUNNER_PROTOCOL_ERROR')

  const pending = await command(second, 'chat', {
    intent: 'cancel me',
    runner: { wait: false, profile: 'mock', quality: 'mock' }
  })
  assert.equal(pending.ok, true)
  assert.equal(pending.data.session.status, 'running')
  const statusCallsBeforeRead = secondDriver.calls.filter((call) => call.kind === 'status').length
  const observed = await command(second, 'getSession', { sessionId: pending.data.session.id })
  assert.equal(observed.ok, true)
  assert.equal(observed.data.session.status, 'running')
  assert.equal(
    secondDriver.calls.filter((call) => call.kind === 'status').length,
    statusCallsBeforeRead,
    'query-only getSession must not fold runner state outside a write transaction'
  )
  const cancelled = await command(second, 'cancelSession', {
    sessionId: pending.data.session.id,
    reason: 'P8 cancellation proof'
  })
  assert.equal(cancelled.ok, true)
  assert.equal(cancelled.data.session.cancelRequested, true)
  await new Promise((resolve) => setImmediate(resolve))
  const reaped = await command(second, 'reapSessions', { sessionIds: [pending.data.session.id] })
  assert.equal(reaped.ok, true)
  const after = await command(second, 'getSession', { sessionId: pending.data.session.id })
  assert.equal(after.data.session.status, 'cancelled')
  assert.equal(after.data.session.capabilities.canCancel, false)
  assert.equal(after.data.session.events.some((event) => event.type === 'session.cancel-requested'), true)
  assert.equal(after.data.session.events.some((event) => event.code === 'RUNNER_CANCELLED'), true)
  for (const method of ['start', 'resume', 'cancel', 'status']) {
    assert.equal([...firstDriver.calls, ...secondDriver.calls].some((call) => call.kind === method), true, method)
  }
})
