import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { openDshHost } from '../../../dist/dsh/create-dsh-host.js'

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
  return host.application.execute({
    kind,
    ...payload,
    meta: host.commandMeta('p6-real')
  })
}

test('P6 bundle is a self-contained DSH Host and Client package', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(stagedPackageRoot, 'package.json'), 'utf8'))
  assert.equal(packageJson.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(packageJson.dsh.client.platform, 'web')
  assert.equal(packageJson.dsh.client.inject.includes('@deepseek-ai/dsh-client-connection'), true)
  const patch = fs.readFileSync(path.join(stagedPackageRoot, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /name: '@ozdqp\/skill-graft-dsh'/)
  assert.match(patch, /inject: \[connection,/)
  const hostBundle = fs.readFileSync(path.join(stagedPackageRoot, 'lib', 'index.js'), 'utf8')
  const clientBundle = fs.readFileSync(path.join(stagedPackageRoot, 'lib', 'client.js'), 'utf8')
  assert.match(hostBundle, /application\.commandBus/)
  assert.match(hostBundle, /\/skill-graft/)
  assert.match(clientBundle, /window\.__ModuleLoader__\.load/)
  assert.match(clientBundle, /connection\.rpc\.call/)
  for (const forbidden of ['127.0.0.1:18765', 'codex-session-runner', 'start-codex', 'dispatch-hub-codex']) {
    assert.equal(hostBundle.includes(forbidden), false, `host bundle must not include ${forbidden}`)
    assert.equal(clientBundle.includes(forbidden), false, `client bundle must not include ${forbidden}`)
  }

  const packed = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: stagedPackageRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32'
  })
  assert.equal(packed.status, 0, packed.stderr || packed.stdout)
  const report = JSON.parse(packed.stdout)
  const names = report[0].files.map((entry) => entry.path).sort()
  for (const required of [
    'build-manifest.json',
    'cordis.patch.yml',
    'lib/client.js',
    'lib/index.js',
    'overlay/README.md',
    'overlay/hooks/.keep',
    'package.json'
  ]) assert.equal(names.includes(required), true, `packed DSH bundle must contain ${required}`)
  assert.equal(names.some((name) => name.startsWith('dist/local/')), false)
  assert.equal(names.some((name) => name.startsWith('dist/control/')), false)
  assert.equal(names.some((name) => name.startsWith('server/')), false)
})

test('P6 DSH composition executes real status, pin write, plan, and dispose lifecycle', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-dsh-p6-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dataRoot = path.join(root, 'dsh-home', 'skill-graft')
  const worktree = path.join(root, 'workspace')
  writeText(path.join(dataRoot, 'AGENTS.override.md'), '# DSH P6 fixture authority\n')
  writeText(path.join(dataRoot, 'skills', 'ozdqp-development', 'SKILL.md'), [
    '---',
    'name: ozdqp-development',
    'description: DSH P6 real fixture',
    '---',
    '# Fixture skill',
    ''
  ].join('\n'))
  fs.mkdirSync(worktree, { recursive: true })
  git(worktree, 'init')
  git(worktree, 'config', 'user.email', 'p6@example.invalid')
  git(worktree, 'config', 'user.name', 'P6 Gate')
  writeText(path.join(worktree, 'README.md'), '# P6 worktree\n')
  git(worktree, 'add', 'README.md')
  git(worktree, 'commit', '-m', 'fixture')
  writeText(path.join(dataRoot, 'overlay', 'attached-worktrees.txt'), `${worktree}\n`)

  const host = await openDshHost({
    packageRoot: sourcePackageRoot,
    dataRoot,
    hostId: 'dsh-p6-test',
    runtimeRevision: '0.1.0-p6'
  })
  t.after(() => host.dispose())

  const status = await command(host, 'status')
  assert.equal(status.ok, true)
  assert.equal(status.meta.handler, 'application.commandBus')
  const skills = await command(host, 'listSkills')
  assert.equal(skills.ok, true)
  assert.equal(skills.data.resident.some((item) => item.name === 'ozdqp-development'), true)
  const created = await command(host, 'createSnapshot')
  assert.equal(created.ok, true)
  const snapshotId = created.data.snapshot.snapshotId

  const migrationPlan = await command(host, 'migrateState', { mode: 'dryRun' })
  assert.equal(migrationPlan.ok, true)
  assert.equal(migrationPlan.data.status, 'planned')
  const migrated = await command(host, 'migrateState', {
    mode: 'commit',
    planHash: migrationPlan.data.plan.planHash
  })
  assert.equal(migrated.ok, true)
  assert.equal(migrated.data.status, 'committed')

  const pin = await command(host, 'getPin', { worktree })
  assert.equal(pin.ok, true)
  assert.equal(pin.data.pin.claimState, 'claimed')
  const setPin = await command(host, 'setPin', {
    worktree,
    snapshotId,
    selectedSkills: ['ozdqp-development']
  })
  assert.equal(setPin.ok, true)
  const planned = await command(host, 'planSync', { worktree })
  assert.equal(planned.ok, true, JSON.stringify(planned))
  assert.equal(planned.data.status, 'conflict')
  assert.equal(planned.data.plan.executable, false)
  assert.match(planned.data.plan.planHash, /^sha256:[a-f0-9]{64}$/)

  await host.dispose()
  await assert.rejects(host.ready(), /disposed/)
  const reopened = await openDshHost({
    packageRoot: sourcePackageRoot,
    dataRoot,
    hostId: 'dsh-p6-reopen',
    runtimeRevision: '0.1.0-p6'
  })
  const persisted = await command(reopened, 'getPin', { worktree })
  assert.equal(persisted.ok, true)
  assert.equal(persisted.data.pin.requestedSnapshot, snapshotId)
  await reopened.dispose()
})
