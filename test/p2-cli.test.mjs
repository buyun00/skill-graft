import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { spawnHub } from './helpers.mjs'

function parse(result, label) {
  assert.equal(result.status, 0, `${label}: ${result.stderr || result.stdout}`)
  return JSON.parse(result.stdout)
}

function typed(root, args, requestId) {
  return parse(spawnHub([
    ...args,
    '--contract-v1',
    '--request-id', requestId
  ], {
    env: { SKILL_GRAFT_HOME: root, HUB_ROOT: root, HUB_SPAWN_CODEX: '0' }
  }), args.join(' '))
}

function createP2CliRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-p2-cli-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'skills', 'ozdqp-development'), { recursive: true })
  fs.mkdirSync(path.join(root, 'overlay'), { recursive: true })
  fs.writeFileSync(path.join(root, 'skills', 'ozdqp-development', 'SKILL.md'), '# snapshot A\n', 'utf8')
  fs.writeFileSync(path.join(root, 'AGENTS.override.md'), '# fixture override\n', 'utf8')
  fs.writeFileSync(path.join(root, 'overlay', 'attached-worktrees.txt'), '', 'utf8')
  fs.writeFileSync(path.join(root, 'overlay', 'scan-roots.txt'), '', 'utf8')
  fs.writeFileSync(path.join(root, 'overlay', 'do-not-auto-attach.txt'), '', 'utf8')
  const probe = path.join(root, 'probe')
  fs.mkdirSync(path.join(probe, 'baloot_client'), { recursive: true })
  fs.writeFileSync(path.join(probe, 'AGENTS.md'), '# probe\n', 'utf8')
  fs.writeFileSync(path.join(root, 'overlay', 'attached-worktrees.txt'), `${probe}\n`, 'utf8')
  return { root, probe }
}

test('P2 CLI exposes schema, snapshot, migration, and pin commands over Application v1', {
  timeout: 30_000
}, (t) => {
  const { root, probe } = createP2CliRoot(t)

  const empty = typed(root, ['inspect-schema'], 'p2-cli-inspect-empty')
  assert.equal(empty.ok, true)
  assert.equal(empty.commandKind, 'inspectSchema')
  assert.equal(empty.data.status, 'empty')

  const createdA = typed(root, ['snapshot', 'create'], 'p2-cli-snapshot-a')
  assert.equal(createdA.ok, true)
  assert.equal(createdA.commandKind, 'createSnapshot')
  const snapshotA = createdA.data.snapshot.snapshotId
  assert.match(snapshotA, /^sha256:[a-f0-9]{64}$/)

  const listed = typed(root, ['snapshot', 'list'], 'p2-cli-snapshot-list')
  assert.deepEqual(listed.data.snapshots.map((manifest) => manifest.snapshotId), [snapshotA])
  const shown = typed(root, ['snapshot', 'show', '--id', snapshotA], 'p2-cli-snapshot-show')
  assert.equal(shown.data.snapshot.snapshotId, snapshotA)

  const dryRun = typed(root, ['migrate-state', '--dry-run'], 'p2-cli-migrate-dry-run')
  assert.equal(dryRun.ok, true)
  assert.equal(dryRun.data.status, 'planned')
  assert.equal(dryRun.data.plan.targetState.worktrees[Object.keys(dryRun.data.plan.targetState.worktrees)[0]].claimState, 'claimed')
  assert.equal(fs.existsSync(path.join(root, 'skill-review', 'state.json')), false)

  const committed = typed(root, [
    'migrate-state', '--commit', '--plan-hash', dryRun.data.plan.planHash
  ], 'p2-cli-migrate-commit')
  assert.equal(committed.ok, true)
  assert.equal(committed.data.status, 'committed')

  const initialPin = typed(root, ['pin', 'show', '--worktree', probe], 'p2-cli-pin-show')
  assert.equal(initialPin.ok, true)
  assert.equal(initialPin.data.pin.requestedSnapshot, snapshotA)
  assert.equal(initialPin.data.pin.materializedSnapshot, null)

  fs.writeFileSync(path.join(root, 'skills', 'ozdqp-development', 'SKILL.md'), '# snapshot B\n', 'utf8')
  const createdB = typed(root, ['snapshot', 'create'], 'p2-cli-snapshot-b')
  const snapshotB = createdB.data.snapshot.snapshotId
  assert.notEqual(snapshotB, snapshotA)

  const selected = typed(root, [
    'pin', 'set', '--worktree', probe, '--snapshot', snapshotB,
    '--skill', 'zeta', '--skill', 'alpha'
  ], 'p2-cli-pin-select')
  assert.equal(selected.ok, true)
  assert.equal(selected.data.pin.requestedSnapshot, snapshotB)
  assert.equal(selected.data.pin.materializedSnapshot, null)
  assert.deepEqual(selected.data.pin.selectedSkills, ['alpha', 'zeta'])

  const cleared = typed(root, [
    'pin', 'set', '--worktree', probe, '--snapshot', snapshotA, '--clear-skills'
  ], 'p2-cli-pin-clear')
  assert.equal(cleared.ok, true)
  assert.equal(cleared.data.pin.requestedSnapshot, snapshotA)
  assert.equal(cleared.data.pin.materializedSnapshot, null)
  assert.deepEqual(cleared.data.pin.selectedSkills, [])

  const restarted = typed(root, ['pin', 'show', '--worktree', probe], 'p2-cli-pin-restart')
  assert.equal(restarted.data.pin.requestedSnapshot, snapshotA)
  assert.deepEqual(restarted.data.pin.selectedSkills, [])
})

test('P2 CLI rejects ambiguous migration and selected-skill flags before dispatch', (t) => {
  const { root, probe } = createP2CliRoot(t)
  const env = { SKILL_GRAFT_HOME: root, HUB_ROOT: root, HUB_SPAWN_CODEX: '0' }
  const missingPlan = spawnHub(['migrate-state', '--commit'], { env })
  assert.notEqual(missingPlan.status, 0)
  assert.match(missingPlan.stderr, /requires --plan-hash/)

  const ambiguous = spawnHub([
    'pin', 'set', '--worktree', probe,
    '--snapshot', `sha256:${'a'.repeat(64)}`,
    '--skill', 'alpha', '--clear-skills'
  ], { env })
  assert.notEqual(ambiguous.status, 0)
  assert.match(ambiguous.stderr, /either --skill or --clear-skills/)

  for (const args of [
    ['inspect-schema', '--dry-run'],
    ['snapshot', 'list', '--id', `sha256:${'b'.repeat(64)}`],
    ['pin', 'show', '--worktree', probe, '--clear-skills'],
    ['migrate-state', '--dry-run', '--dry-run']
  ]) {
    const rejected = spawnHub(args, { env })
    assert.notEqual(rejected.status, 0, args.join(' '))
    assert.match(rejected.stderr, /unsupported or duplicate arguments/)
  }
  assert.equal(fs.existsSync(path.join(root, 'skill-review', 'application-ledger.json')), false)
})
