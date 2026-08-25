import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { openDshHost } from '../../../dist/dsh/create-dsh-host.js'
import { createDshWorkspaceLifecycle } from '../../../dist/dsh/workspace-lifecycle.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const sourcePackageRoot = path.join(repoRoot, 'packages', 'host-dsh')
const stagedPackageRoot = path.join(repoRoot, '.artifacts-local', 'dsh-package')
const SKILL = 'ozdqp-development'

function writeText(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, 'utf8')
}

async function execute(host, kind, payload = {}) {
  return await host.application.execute({
    kind,
    ...payload,
    meta: host.commandMeta('p7-focused')
  })
}

function success(kind, data) {
  return {
    contractVersion: '1.0.0',
    requestId: `p7-${kind}`,
    commandKind: kind,
    events: [],
    meta: { replayed: false, handler: 'application.commandBus' },
    ok: true,
    data
  }
}

function skillDocument(version) {
  return [
    '---',
    `name: ${SKILL}`,
    `description: DSH pinned Skill ${version}`,
    '---',
    `# Controlled ${version}`,
    '',
    `Only snapshot ${version} may register this text.`,
    ''
  ].join('\n')
}

test('P7 production bundle declares the DSH settings surface and lifecycle dependencies', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(stagedPackageRoot, 'package.json'), 'utf8'))
  assert.deepEqual(packageJson.dsh.client.inject, [
    '@deepseek-ai/dsh-client-connection',
    '@deepseek-ai/dsh-client-runtime',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-settings'
  ])
  const patch = fs.readFileSync(path.join(stagedPackageRoot, 'cordis.patch.yml'), 'utf8')
  for (const service of ['connection', 'settings', 'workspaceRegistry', 'skills', 'systemPrompt']) {
    assert.match(patch, new RegExp(`\\b${service}\\b`))
  }
  const host = fs.readFileSync(path.join(stagedPackageRoot, 'lib', 'index.js'), 'utf8')
  const client = fs.readFileSync(path.join(stagedPackageRoot, 'lib', 'client.js'), 'utf8')
  for (const endpoint of ['describe', 'update-settings', 'select-workspace', 'register-workspace', 'unregister-workspace']) {
    assert.equal(host.includes(endpoint), true, `Host bundle must contain ${endpoint}`)
    assert.equal(client.includes(endpoint), true, `Client bundle must contain ${endpoint}`)
  }
  for (const section of ['settings', 'workspace', 'pin-plan-sync', 'skills', 'inbox', 'history']) {
    assert.equal(client.includes(`data-skill-graft-section`), true)
    assert.equal(client.includes(section), true, `Client bundle must contain the ${section} surface`)
  }
  assert.match(client, /require\("react"\)/)
  assert.match(client, /settings\.section/)
  assert.match(host, /skill-graft:workspace-override/)
  assert.equal(host.includes('127.0.0.1:18765'), false)
})

test('P7 switches workspace and pin by unregistering then registering verified materialized snapshot content', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-dsh-p7-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dataRoot = path.join(root, 'dsh-home', 'skill-graft')
  const workspaceA = path.join(root, 'workspace-a')
  const workspaceB = path.join(root, 'workspace-b')
  fs.mkdirSync(workspaceA, { recursive: true })
  fs.mkdirSync(workspaceB, { recursive: true })
  writeText(path.join(dataRoot, 'AGENTS.override.md'), '# Override A\n')
  writeText(path.join(dataRoot, 'skills', SKILL, 'SKILL.md'), skillDocument('A'))

  const host = await openDshHost({
    packageRoot: sourcePackageRoot,
    dataRoot,
    hostId: 'dsh-p7-test',
    runtimeRevision: '0.1.0-p7'
  })
  t.after(() => host.dispose())
  const first = await execute(host, 'createSnapshot')
  assert.equal(first.ok, true)
  const snapshotA = first.data.snapshot.snapshotId

  writeText(path.join(dataRoot, 'AGENTS.override.md'), '# Override B\n')
  writeText(path.join(dataRoot, 'skills', SKILL, 'SKILL.md'), skillDocument('B'))
  const second = await execute(host, 'createSnapshot')
  assert.equal(second.ok, true)
  const snapshotB = second.data.snapshot.snapshotId
  assert.notEqual(snapshotA, snapshotB)

  const materialized = new Map([
    [workspaceA, snapshotA],
    [workspaceB, snapshotB]
  ])
  const originalExecute = host.application.execute.bind(host.application)
  let applicationCalls = 0
  const application = {
    async execute(command) {
      applicationCalls += 1
      const snapshotId = typeof command.worktree === 'string' ? materialized.get(command.worktree) : undefined
      if (command.kind === 'getPin' && snapshotId) {
        return success(command.kind, {
          worktree: command.worktree,
          pathKey: snapshotId,
          worktreeId: `workspace-${path.basename(command.worktree)}`,
          pin: {
            claimState: 'claimed',
            requestedSnapshot: snapshotId,
            materializedSnapshot: snapshotId,
            selectedSkills: [SKILL]
          }
        })
      }
      if (command.kind === 'planSync' && snapshotId) {
        return success(command.kind, {
          action: 'planSync',
          status: 'planned',
          plan: {
            planHash: snapshotId,
            markerStatus: 'valid',
            executable: false,
            current: { snapshotId, selectedSkills: [SKILL] },
            summary: { create: 0, update: 0, delete: 0, keep: 1, conflict: 0 },
            operations: [],
            git: {}
          }
        })
      }
      return await originalExecute(command)
    }
  }
  const lifecycleHost = { ...host, application }

  let settingsValue = { workspaceId: '', autoSync: 'off' }
  const watchers = new Set()
  const settings = {
    get: () => ({ ...settingsValue }),
    watch(callback) { watchers.add(callback); return () => watchers.delete(callback) },
    async update(patch) {
      const previous = settingsValue
      settingsValue = { ...settingsValue, ...patch }
      for (const watcher of [...watchers]) await watcher({ ...settingsValue }, { ...previous })
    }
  }
  const workspaces = [
    { id: 'workspace-a', path: workspaceA, title: 'Workspace A', createdAt: '', updatedAt: '', sessionIds: [], status: async () => 'ok' },
    { id: 'workspace-b', path: workspaceB, title: 'Workspace B', createdAt: '', updatedAt: '', sessionIds: [], status: async () => 'ok' }
  ]
  const workspaceRegistry = {
    list: () => [...workspaces],
    get: id => workspaces.find((workspace) => workspace.id === id),
    async create() { throw new Error('not used') },
    async delete() { return false }
  }
  const skillEvents = []
  const registered = new Map()
  const skills = {
    register(skill) {
      skillEvents.push(`register:${skill.name}:${skill.description}`)
      registered.set(skill.name, skill)
      return () => {
        skillEvents.push(`unregister:${skill.name}:${skill.description}`)
        if (registered.get(skill.name) === skill) registered.delete(skill.name)
      }
    }
  }
  const promptEvents = []
  let promptText = null
  const systemPrompt = {
    section(section) {
      promptEvents.push(`register:${section.text.trim()}`)
      promptText = section.text
      return () => {
        promptEvents.push(`unregister:${section.text.trim()}`)
        if (promptText === section.text) promptText = null
      }
    }
  }
  const lifecycle = createDshWorkspaceLifecycle({
    host: lifecycleHost,
    settings,
    workspaceRegistry,
    skills,
    systemPrompt,
    lockTimeoutMs: 30_000,
    logLevel: 'info'
  })

  const ambiguous = await lifecycle.refresh()
  assert.equal(ambiguous.requiresExplicitSelection, true)
  assert.equal(registered.size, 0)

  const cancelled = new AbortController()
  cancelled.abort()
  const callsBeforeCancel = applicationCalls
  await assert.rejects(lifecycle.refresh(cancelled.signal), /cancelled/)
  assert.equal(applicationCalls, callsBeforeCancel)
  await assert.rejects(lifecycle.updateSettings({ autoSync: 'plan' }, cancelled.signal), /cancelled/)
  assert.deepEqual(settingsValue, { workspaceId: '', autoSync: 'off' })

  const selectedA = await lifecycle.selectWorkspace('workspace-a')
  assert.equal(selectedA.selectedWorkspace.id, 'workspace-a')
  assert.match(registered.get(SKILL).content, /Controlled A/)
  assert.equal(promptText, '# Override A\n')

  const selectedB = await lifecycle.selectWorkspace('workspace-b')
  assert.equal(selectedB.selectedWorkspace.id, 'workspace-b')
  assert.match(registered.get(SKILL).content, /Controlled B/)
  assert.equal(promptText, '# Override B\n')
  const firstBRegistration = skillEvents.findIndex((entry) => entry.includes('register:ozdqp-development:DSH pinned Skill B'))
  const lastAUnregistration = skillEvents.findLastIndex((entry) => entry.includes('unregister:ozdqp-development:DSH pinned Skill A'))
  assert.equal(lastAUnregistration < firstBRegistration, true)

  materialized.set(workspaceB, snapshotA)
  const repinned = await lifecycle.refresh()
  assert.equal(repinned.registeredSkills[0].snapshotId, snapshotA)
  assert.match(registered.get(SKILL).content, /Controlled A/)
  assert.equal(promptText, '# Override A\n')

  await lifecycle.dispose()
  assert.equal(registered.size, 0)
  assert.equal(promptText, null)
  assert.equal(promptEvents.at(-1), 'unregister:# Override A')
})
