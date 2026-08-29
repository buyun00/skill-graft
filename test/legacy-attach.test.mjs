import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { createHub } from '../dist/adapters/create-hub.js'
import {
  createLocalLegacyAttachPort,
  createLocalLegacyDetachPort
} from '../dist/adapters/local-legacy-attach-port.js'
import { planLegacyAttach } from '../dist/core/legacy-attach.js'
import { planLegacyDetach } from '../dist/core/legacy-detach.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const residents = ['ozdqp-development', 'ozdqp-ui-development', 'ozdqp-git-workflow']

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, contents, 'utf8')
}

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true
  })
  assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join('\n'))
  return result.stdout || ''
}

function normalized(value) {
  const resolved = path.resolve(value).replaceAll('\\', '/').replace(/\/$/, '')
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function createFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-p1-legacy-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const hub = path.join(root, 'hub')
  const packageRoot = path.join(root, 'package')
  const worktree = path.join(root, 'game-tree')
  fs.mkdirSync(hub, { recursive: true })
  fs.mkdirSync(packageRoot, { recursive: true })
  fs.mkdirSync(worktree, { recursive: true })
  write(path.join(hub, 'AGENTS.override.md'), options.hubOverride || '# hub override\n')
  for (const name of options.residentNames ?? residents) {
    write(path.join(hub, 'skills', name, 'SKILL.md'), `# ${name}\n`)
  }
  fs.mkdirSync(path.join(hub, 'overlay'), { recursive: true })
  fs.mkdirSync(path.join(packageRoot, 'overlay', 'hooks'), { recursive: true })
  write(path.join(worktree, 'AGENTS.md'), '# isolated game tree\n')
  fs.mkdirSync(path.join(worktree, 'baloot_client'), { recursive: true })
  write(path.join(worktree, 'business.txt'), 'business data must survive\n')
  if (options.targetOverride !== undefined) {
    write(path.join(worktree, 'AGENTS.override.md'), options.targetOverride)
  }
  git(worktree, ['init', '-q'])

  let id = 0
  const commonOverrides = {
    clock: {
      nowIso: () => '2030-01-02T03:04:05.000Z',
      nowMs: () => Date.parse('2030-01-02T03:04:05.000Z')
    },
    ids: { next: (scope) => `${scope}-${++id}` }
  }
  const base = createHub(hub, commonOverrides)
  const link = options.wrapLink ? options.wrapLink(base.link, { hub, worktree }) : base.link
  const context = createHub(hub, { ...commonOverrides, link })
  const inspectWorktree = (candidate) => {
    const resolvedPath = path.resolve(candidate)
    const claimFile = path.join(hub, 'overlay', 'attached-worktrees.txt')
    const claimed = fs.existsSync(claimFile)
      && fs.readFileSync(claimFile, 'utf8').split(/\r?\n/).filter(Boolean).some((entry) => normalized(entry) === normalized(resolvedPath))
    return {
      resolvedPath,
      recognition: {
        exists: fs.existsSync(resolvedPath),
        isDirectory: fs.statSync(resolvedPath).isDirectory(),
        sameAsHub: normalized(resolvedPath) === normalized(hub),
        excluded: false,
        partialCheckout: false,
        explicitlyAllowed: false,
        ephemeral: false,
        requiredMarkers: [
          { name: 'AGENTS.md', present: fs.existsSync(path.join(resolvedPath, 'AGENTS.md')) },
          { name: 'baloot_client', present: fs.existsSync(path.join(resolvedPath, 'baloot_client')) }
        ]
      },
      blocked: false,
      claimed
    }
  }
  return {
    root,
    hub,
    packageRoot,
    worktree,
    context,
    inspectWorktree,
    port: createLocalLegacyAttachPort(context, inspectWorktree, {
      checkpoint: options.checkpoint,
      packageRoot
    })
  }
}

async function approvedPlan(port, worktree, options = {}) {
  const inspection = await port.inspect(worktree)
  const decision = planLegacyAttach({
    inspection,
    mode: 'firstAttach',
    attachSessionAuthorized: true,
    sourcePolicy: options.sourcePolicy || 'preferLibrary',
    visibility: options.visibility || 'preserve',
    configureGit: Boolean(options.configureGit)
  })
  assert.equal(decision.decision, 'apply', JSON.stringify(decision))
  return decision.plan
}

function treeState(root) {
  const entries = []
  const visit = (directory, prefix = '') => {
    for (const name of fs.readdirSync(directory).sort((left, right) => left.localeCompare(right))) {
      if (!prefix && name === '.git') continue
      const absolute = path.join(directory, name)
      const relative = prefix ? `${prefix}/${name}` : name
      const stat = fs.lstatSync(absolute)
      if (stat.isSymbolicLink()) {
        entries.push(`link:${relative}:${fs.readlinkSync(absolute)}`)
      } else if (stat.isDirectory()) {
        entries.push(`dir:${relative}`)
        visit(absolute, relative)
      } else if (stat.isFile()) {
        entries.push(`file:${relative}:${fs.readFileSync(absolute).toString('base64')}`)
      }
    }
  }
  visit(root)
  return entries
}

function configValues(cwd, key) {
  const result = spawnSync('git', ['-C', cwd, 'config', '--local', '--null', '--get-all', key], {
    encoding: 'utf8',
    windowsHide: true
  })
  if (result.status === 1 || result.status === 128) return []
  assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join('\n'))
  return String(result.stdout || '').split('\0').filter(Boolean)
}

const transactionConfigKeys = [
  'core.hooksPath',
  'ozdqp.localOverlaySource',
  'ozdqp.skillWatchWorkspace',
  'ozdqp.skillWatchEnabled'
]

function transactionFingerprint(fixture) {
  return {
    worktree: treeState(fixture.worktree),
    hub: treeState(fixture.hub),
    status: git(fixture.worktree, ['status', '--porcelain=v1', '-z']),
    indexFlags: git(fixture.worktree, ['-c', 'core.quotepath=false', 'ls-files', '-v', '-z']),
    worktreeConfig: Object.fromEntries(transactionConfigKeys.map((key) => [key, configValues(fixture.worktree, key)])),
    hubGameRepo: configValues(fixture.hub, 'ozdqp.gameRepo')
  }
}

function createTransactionalFixture(t, checkpoint, options = {}) {
  const fixture = createFixture(t, {
    targetOverride: '# promoted worktree override\n',
    hubOverride: '# previous hub override\n',
    checkpoint
  })
  write(path.join(fixture.hub, 'skills', 'adopted', 'team-skill', 'SKILL.md'), '# adopted team skill\n')
  for (const name of residents) {
    write(path.join(fixture.worktree, '.agents', 'skills', name, 'SKILL.md'), `# ${name}\n`)
  }
  write(path.join(fixture.worktree, '.agents', 'skills', 'team-skill', 'SKILL.md'), '# adopted team skill\n')
  write(path.join(fixture.worktree, '.agents', 'skills', 'unity-skills', 'SKILL.md'), '# unity project adapter\n')
  write(path.join(fixture.worktree, '.agents', 'skills', 'custom-project', 'SKILL.md'), '# classification deferred to P3\n')
  write(path.join(fixture.worktree, '.claude', 'settings.json'), '{"fixture":true}\n')
  write(path.join(fixture.worktree, '.codex', 'agents', 'fixture.txt'), 'legacy agent\n')
  write(path.join(fixture.worktree, '.codex', 'local-overlay', 'legacy.txt'), 'legacy overlay\n')
  for (const entry of options.extraTrackedPaths || []) {
    write(path.join(fixture.worktree, ...entry.path.split('/')), entry.contents)
  }

  git(fixture.worktree, ['config', 'user.name', 'Skill Graft Test'])
  git(fixture.worktree, ['config', 'user.email', 'skill-graft@example.invalid'])
  git(fixture.worktree, ['config', 'core.autocrlf', 'false'])
  git(fixture.worktree, ['config', 'core.hooksPath', 'legacy-hooks'])
  git(fixture.worktree, ['config', 'ozdqp.localOverlaySource', 'legacy-source'])
  git(fixture.worktree, ['config', 'ozdqp.skillWatchWorkspace', 'legacy-workspace'])
  git(fixture.worktree, ['config', 'ozdqp.skillWatchEnabled', 'false'])
  git(fixture.worktree, ['add', '-A'])
  git(fixture.worktree, ['commit', '-qm', 'transaction fixture'])
  git(fixture.worktree, ['update-index', '--skip-worktree', '--', '.codex/agents/fixture.txt'])

  fs.rmSync(path.join(fixture.worktree, '.agents', 'skills', 'ozdqp-ui-development'), { recursive: true, force: true })
  const keptResident = path.join(fixture.worktree, '.agents', 'skills', 'ozdqp-git-workflow')
  fs.rmSync(keptResident, { recursive: true, force: true })
  fixture.context.link.linkDirectory(
    keptResident,
    path.join(fixture.hub, 'skills', 'ozdqp-git-workflow')
  )
  write(path.join(fixture.hub, 'overlay', 'attached-worktrees.txt'), '# pre-existing claim file\nC:\\other-tree\n')
  git(fixture.hub, ['init', '-q'])
  git(fixture.hub, ['config', 'ozdqp.gameRepo', 'C:\\legacy-game'])
  return fixture
}

async function createAttachedDetachFixture(t, options = {}) {
  const bulkPaths = options.bulk
      ? Array.from({ length: 620 }, (_, index) => ({
        path: `.claude/批量 恢复/编号 ${String(index).padStart(4, '0')} ü.txt`,
        contents: 'official bulk\n'
      }))
    : []
  const fixture = createTransactionalFixture(t, undefined, { extraTrackedPaths: bulkPaths })
  const attachPlan = await approvedPlan(fixture.port, fixture.worktree, {
    sourcePolicy: 'preferLibrary',
    visibility: 'disable',
    configureGit: false
  })
  await fixture.port.apply(attachPlan)
  if (options.removeManaged) {
    fs.rmSync(path.join(fixture.worktree, ...options.removeManaged.split('/')), { recursive: true, force: true })
  }
  const detachPort = createLocalLegacyDetachPort(fixture.context, fixture.inspectWorktree, {
    checkpoint: options.checkpoint
  })
  const inspection = await detachPort.inspect(fixture.worktree)
  const decision = planLegacyDetach({ inspection, detachSessionAuthorized: true })
  assert.equal(decision.decision, 'apply', JSON.stringify(decision))
  return { ...fixture, detachPort, detachPlan: decision.plan, bulkPaths }
}

test('isolated Local legacy adapter applies only a Core-approved plan and claims last', async (t) => {
  const fixture = createFixture(t)
  const plan = await approvedPlan(fixture.port, fixture.worktree)
  const report = await fixture.port.apply(plan)

  assert.equal(report.claim, 'created')
  assert.equal(report.effects.length, 5)
  assert.equal(fixture.context.link.isLinked(
    path.join(fixture.worktree, 'AGENTS.override.md'),
    path.join(fixture.hub, 'AGENTS.override.md')
  ), true)
  for (const name of residents) {
    assert.equal(fixture.context.link.isLinked(
      path.join(fixture.worktree, '.agents', 'skills', name),
      path.join(fixture.hub, 'skills', name)
    ), true)
  }
  assert.equal(fixture.context.link.isLinked(
    path.join(fixture.worktree, '.codex', 'local-overlay'),
    path.join(fixture.hub, 'overlay')
  ), true)
  assert.match(fs.readFileSync(path.join(fixture.hub, 'overlay', 'attached-worktrees.txt'), 'utf8'), /game-tree/)
  assert.equal(fs.readFileSync(path.join(fixture.worktree, 'business.txt'), 'utf8'), 'business data must survive\n')
})

test('legacy attach uses the actual resident corpus and accepts an empty corpus', async (t) => {
  const empty = createFixture(t, { residentNames: [] })
  const emptyPlan = await approvedPlan(empty.port, empty.worktree)
  assert.deepEqual(emptyPlan.artifacts.map((artifact) => artifact.id), ['agentsOverride', 'localOverlay'])
  const emptyReport = await empty.port.apply(emptyPlan)
  assert.equal(emptyReport.claim, 'created')
  assert.equal(fs.existsSync(path.join(empty.worktree, '.agents', 'skills')), false)

  const preserved = createFixture(t, { residentNames: [] })
  const projectPrivate = path.join(preserved.worktree, '.agents', 'skills', 'project-private', 'SKILL.md')
  write(projectPrivate, '# worktree-owned private Skill\n')
  const preservedPlan = await approvedPlan(preserved.port, preserved.worktree, { visibility: 'disable' })
  assert.equal(preservedPlan.visibility.removePaths.some((relative) => /project-private/i.test(relative)), false)
  await preserved.port.apply(preservedPlan)
  assert.equal(fs.readFileSync(projectPrivate, 'utf8'), '# worktree-owned private Skill\n')

  const privateName = 'project-private'
  const dynamic = createFixture(t, { residentNames: [privateName] })
  write(path.join(dynamic.worktree, '.agents', 'skills', privateName, 'SKILL.md'), `# ${privateName}\n`)
  const dynamicPlan = await approvedPlan(dynamic.port, dynamic.worktree, { visibility: 'disable' })
  assert.ok(dynamicPlan.artifacts.some((artifact) => artifact.id === `resident:${privateName}`))
  assert.equal(dynamicPlan.visibility.removePaths.some((relative) => relative.includes(privateName)), false)
  await dynamic.port.apply(dynamicPlan)
  assert.equal(dynamic.context.link.isLinked(
    path.join(dynamic.worktree, '.agents', 'skills', privateName),
    path.join(dynamic.hub, 'skills', privateName)
  ), true)

  const protectedUnity = createFixture(t, { residentNames: ['unity-skills'] })
  const unityFile = path.join(protectedUnity.worktree, '.agents', 'skills', 'unity-skills', 'SKILL.md')
  write(unityFile, '# worktree-owned Unity Skill\n')
  const unityPlan = await approvedPlan(protectedUnity.port, protectedUnity.worktree, { visibility: 'disable' })
  assert.equal(unityPlan.artifacts.some((artifact) => artifact.id === 'resident:unity-skills'), false)
  await protectedUnity.port.apply(unityPlan)
  assert.equal(fs.readFileSync(unityFile, 'utf8'), '# worktree-owned Unity Skill\n')

  const linkedTree = createFixture(t, { residentNames: ['linked-private'] })
  const external = path.join(linkedTree.root, 'external-skill-content')
  fs.mkdirSync(external, { recursive: true })
  fs.symlinkSync(
    external,
    path.join(linkedTree.hub, 'skills', 'linked-private', 'nested-link'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  const linkedPlan = await approvedPlan(linkedTree.port, linkedTree.worktree)
  assert.equal(linkedPlan.artifacts.some((artifact) => artifact.id === 'resident:linked-private'), false)
})

test('full legacy transaction commits every artifact action while preserving unity and adopted Skills', async (t) => {
  const fixture = createTransactionalFixture(t)
  const plan = await approvedPlan(fixture.port, fixture.worktree, {
    sourcePolicy: 'promoteFromWorktree',
    visibility: 'disable',
    configureGit: true
  })
  assert.deepEqual(new Set(plan.artifacts.map((artifact) => artifact.action)), new Set([
    'keep',
    'link',
    'replaceWithLibrary',
    'promoteToLibraryThenLink',
    'backupThenLink'
  ]))
  assert.equal(plan.visibility.removePaths.some((relative) => /unity-skills/i.test(relative)), false)
  assert.equal(plan.visibility.removePaths.some((relative) => /team-skill/i.test(relative)), false)

  const report = await fixture.port.apply(plan)
  assert.equal(report.claim, 'created')
  assert.equal(fs.readFileSync(path.join(fixture.worktree, '.agents', 'skills', 'unity-skills', 'SKILL.md'), 'utf8'), '# unity project adapter\n')
  assert.equal(fixture.context.link.isLinked(
    path.join(fixture.worktree, '.agents', 'skills', 'team-skill'),
    path.join(fixture.hub, 'skills', 'adopted', 'team-skill')
  ), true)
  assert.equal(fs.existsSync(path.join(fixture.worktree, '.claude')), false)
  assert.equal(fs.existsSync(path.join(fixture.worktree, '.codex', 'agents')), false)
  assert.equal(fs.existsSync(path.join(fixture.worktree, '.skill-graft-transactions')), false)
  assert.equal(fs.existsSync(path.join(fixture.hub, '.skill-graft-transactions')), false)
  assert.deepEqual(configValues(fixture.worktree, 'ozdqp.localOverlaySource'), [fixture.packageRoot])
  assert.deepEqual(configValues(fixture.worktree, 'core.hooksPath'), [path.join(fixture.packageRoot, 'overlay', 'hooks')])
  assert.deepEqual(configValues(fixture.worktree, 'ozdqp.skillWatchWorkspace'), [fixture.hub])
})

for (const failure of [
  { name: 'late artifact', step: 'artifact:localOverlay:applied' },
  { name: 'visibility removal', step: 'visibility:remove:.claude' },
  { name: 'Git configuration', step: 'config:ozdqp.skillWatchEnabled' },
  { name: 'claim write', step: 'claim:written' }
]) {
  test(`full transaction rolls back ${failure.name} failure without half-state`, async (t) => {
    const fixture = createTransactionalFixture(t, (step) => {
      if (step === failure.step) throw new Error(`injected transaction failure: ${step}`)
    })
    const plan = await approvedPlan(fixture.port, fixture.worktree, {
      sourcePolicy: 'promoteFromWorktree',
      visibility: 'disable',
      configureGit: true
    })
    const before = transactionFingerprint(fixture)

    await assert.rejects(fixture.port.apply(plan), /injected transaction failure/)
    assert.deepEqual(transactionFingerprint(fixture), before)
    assert.equal(fs.existsSync(path.join(fixture.worktree, '.skill-graft-transactions')), false)
    assert.equal(fs.existsSync(path.join(fixture.hub, '.skill-graft-transactions')), false)
  })
}

test('adapter rechecks every approved fact before the first write', async (t) => {
  const fixture = createFixture(t)
  const plan = await approvedPlan(fixture.port, fixture.worktree)
  write(path.join(fixture.worktree, 'AGENTS.override.md'), 'late conflicting change\n')

  await assert.rejects(fixture.port.apply(plan), /artifact changed before apply/)
  assert.equal(fs.readFileSync(path.join(fixture.worktree, 'AGENTS.override.md'), 'utf8'), 'late conflicting change\n')
  assert.equal(fs.existsSync(path.join(fixture.worktree, '.agents', 'skills', residents[0])), false)
  assert.equal(fs.existsSync(path.join(fixture.hub, 'overlay', 'attached-worktrees.txt')), false)
})

test('adapter rejects linked ancestors on both worktree and hub sides', async (t) => {
  await t.test('worktree ancestor junction cannot escape the approved tree', async (t) => {
    const fixture = createFixture(t)
    const outside = path.join(fixture.root, 'outside-worktree')
    fs.mkdirSync(path.join(outside, 'skills'), { recursive: true })
    fs.symlinkSync(outside, path.join(fixture.worktree, '.agents'), process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(fixture.port.inspect(fixture.worktree), /linked ancestor|existing ancestor/)
    assert.deepEqual(fs.readdirSync(outside), ['skills'])
    assert.equal(fs.existsSync(path.join(fixture.hub, 'overlay', 'attached-worktrees.txt')), false)
  })

  await t.test('hub source junction cannot escape the library root', async (t) => {
    const fixture = createFixture(t)
    const outside = path.join(fixture.root, 'outside-hub')
    fs.mkdirSync(path.join(outside, 'adopted'), { recursive: true })
    fs.rmSync(path.join(fixture.hub, 'skills'), { recursive: true, force: true })
    fs.symlinkSync(outside, path.join(fixture.hub, 'skills'), process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(fixture.port.inspect(fixture.worktree), /linked ancestor|existing ancestor/)
    assert.deepEqual(fs.readdirSync(outside), ['adopted'])
    assert.equal(fs.existsSync(path.join(fixture.hub, 'overlay', 'attached-worktrees.txt')), false)
  })
})

test('promotion link failure restores the old library and original worktree content', async (t) => {
  const targetContents = '# original worktree override\n'
  const libraryContents = '# previous library override\n'
  const fixture = createFixture(t, {
    targetOverride: targetContents,
    hubOverride: libraryContents,
    wrapLink(base, paths) {
      return {
        ...base,
        linkFile(linkPath, target) {
          if (normalized(linkPath) === normalized(path.join(paths.worktree, 'AGENTS.override.md'))) {
            throw new Error('injected promotion link failure')
          }
          return base.linkFile(linkPath, target)
        }
      }
    }
  })
  const plan = await approvedPlan(fixture.port, fixture.worktree, { sourcePolicy: 'promoteFromWorktree' })
  assert.equal(plan.artifacts[0].action, 'promoteToLibraryThenLink')

  await assert.rejects(fixture.port.apply(plan), /injected promotion link failure/)
  assert.equal(fs.readFileSync(path.join(fixture.hub, 'AGENTS.override.md'), 'utf8'), libraryContents)
  assert.equal(fs.readFileSync(path.join(fixture.worktree, 'AGENTS.override.md'), 'utf8'), targetContents)
  assert.equal(fs.lstatSync(path.join(fixture.worktree, 'AGENTS.override.md')).isSymbolicLink(), false)
  assert.equal(fs.existsSync(path.join(fixture.hub, 'overlay', 'attached-worktrees.txt')), false)
  assert.deepEqual(
    fs.readdirSync(fixture.hub).filter((name) => name.includes('.skill-graft-')),
    []
  )
  assert.deepEqual(
    fs.readdirSync(fixture.worktree).filter((name) => name.includes('.skill-graft-')),
    []
  )
})

test('promotion rejects a nested symlink or reparse point before staging any write', async (t) => {
  const fixture = createFixture(t)
  const source = path.join(fixture.worktree, '.agents', 'skills', 'ozdqp-development')
  const outside = path.join(fixture.root, 'promotion-outside')
  write(path.join(source, 'SKILL.md'), '# worktree promotion source\n')
  write(path.join(outside, 'secret.txt'), 'must never be copied\n')
  fs.symlinkSync(outside, path.join(source, 'nested-external'), process.platform === 'win32' ? 'junction' : 'dir')
  const plan = await approvedPlan(fixture.port, fixture.worktree, { sourcePolicy: 'promoteFromWorktree' })
  assert.equal(plan.artifacts.find((artifact) => artifact.id === 'resident:ozdqp-development').action, 'promoteToLibraryThenLink')
  const before = transactionFingerprint(fixture)

  await assert.rejects(fixture.port.apply(plan), /promotion source contains a linked path|reparse point/)
  assert.deepEqual(transactionFingerprint(fixture), before)
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'must never be copied\n')
  assert.equal(fs.existsSync(path.join(fixture.hub, 'overlay', 'attached-worktrees.txt')), false)
})

test('transactional detach restores tracked official trees through NUL-delimited Git input and removes claim last', async (t) => {
  const fixture = await createAttachedDetachFixture(t, { bulk: true })
  const configBefore = {
    worktree: Object.fromEntries(transactionConfigKeys.map((key) => [key, configValues(fixture.worktree, key)])),
    hub: configValues(fixture.hub, 'ozdqp.gameRepo')
  }
  assert.ok(fixture.detachPlan.restorePaths.length > 620)
  assert.ok(fixture.detachPlan.restorePaths.includes('AGENTS.override.md'))
  for (const name of residents) {
    assert.ok(fixture.detachPlan.restorePaths.includes(`.agents/skills/${name}/SKILL.md`), `${name} tracked source must be planned`)
  }

  const report = await fixture.detachPort.apply(fixture.detachPlan)
  assert.equal(report.changed, true)
  assert.equal(report.claim, 'removed')
  assert.equal(report.restoredTracked, fixture.detachPlan.restorePaths.length)
  assert.equal(report.effects.every((effect) => effect.status === 'unlinked'), true)

  assert.equal(fs.readFileSync(path.join(fixture.worktree, 'AGENTS.override.md'), 'utf8').replaceAll('\r\n', '\n'), '# promoted worktree override\n')
  for (const name of residents) {
    const skill = path.join(fixture.worktree, '.agents', 'skills', name)
    assert.equal(fs.lstatSync(skill).isSymbolicLink(), false)
    assert.equal(fs.readFileSync(path.join(skill, 'SKILL.md'), 'utf8').replaceAll('\r\n', '\n'), `# ${name}\n`)
    assert.equal(fixture.context.link.isLinked(skill, path.join(fixture.hub, 'skills', name)), false)
  }
  assert.equal(fs.readFileSync(path.join(fixture.worktree, '.agents', 'skills', 'team-skill', 'SKILL.md'), 'utf8'), '# adopted team skill\n')
  assert.equal(fs.readFileSync(path.join(fixture.worktree, '.agents', 'skills', 'unity-skills', 'SKILL.md'), 'utf8'), '# unity project adapter\n')
  assert.equal(fs.readFileSync(path.join(fixture.worktree, '.codex', 'local-overlay', 'legacy.txt'), 'utf8'), 'legacy overlay\n')
  assert.equal(fs.readFileSync(path.join(fixture.worktree, ...fixture.bulkPaths[0].path.split('/')), 'utf8'), 'official bulk\n')
  assert.equal(
    fs.readFileSync(path.join(fixture.worktree, ...fixture.bulkPaths.at(-1).path.split('/')), 'utf8'),
    'official bulk\n'
  )

  const flags = git(fixture.worktree, ['-c', 'core.quotepath=false', 'ls-files', '-v', '-z'])
  const restoredFlags = new Map(flags.split('\0').filter(Boolean).map((record) => [record.slice(2), record[0]]))
  for (const relative of fixture.detachPlan.restorePaths) {
    assert.notEqual(restoredFlags.get(relative)?.toUpperCase(), 'S', `${relative} must not remain skip-worktree`)
  }
  assert.equal(git(fixture.worktree, ['status', '--porcelain=v1', '--untracked-files=no']), '')
  assert.deepEqual({
    worktree: Object.fromEntries(transactionConfigKeys.map((key) => [key, configValues(fixture.worktree, key)])),
    hub: configValues(fixture.hub, 'ozdqp.gameRepo')
  }, configBefore, 'P1 detach must not guess or rewrite attach-time Git config')

  const claims = fs.readFileSync(path.join(fixture.hub, 'overlay', 'attached-worktrees.txt'), 'utf8')
  assert.equal(claims, '# pre-existing claim file\nC:\\other-tree\n')
  assert.equal(fs.existsSync(path.join(fixture.worktree, '.skill-graft-transactions')), false)
  assert.equal(fs.existsSync(path.join(fixture.hub, '.skill-graft-transactions')), false)
})

test('detach restores the tracked official tree when a claimed managed link is already missing', async (t) => {
  const steps = []
  const missingTarget = `.agents/skills/${residents[1]}`
  const fixture = await createAttachedDetachFixture(t, {
    removeManaged: missingTarget,
    checkpoint: (step) => steps.push(step)
  })
  const artifact = fixture.detachPlan.artifacts.find((entry) => entry.id === `resident:${residents[1]}`)
  assert.equal(artifact.action, 'keepMissing')
  assert.ok(fixture.detachPlan.restorePaths.includes(`${missingTarget}/SKILL.md`))

  const report = await fixture.detachPort.apply(fixture.detachPlan)
  assert.equal(report.claim, 'removed')
  assert.equal(report.effects.find((entry) => entry.id === artifact.id).status, 'missing')
  const restored = path.join(fixture.worktree, ...missingTarget.split('/'))
  assert.equal(fs.lstatSync(restored).isSymbolicLink(), false)
  assert.equal(fs.readFileSync(path.join(restored, 'SKILL.md'), 'utf8'), `# ${residents[1]}\n`)
  assert.equal(git(fixture.worktree, ['status', '--porcelain=v1', '--untracked-files=no']), '')
  assert.equal(steps.at(-1), 'detach:claim:removed', 'claim removal must remain the final transactional effect')
  assert.equal(fs.readFileSync(path.join(fixture.hub, 'overlay', 'attached-worktrees.txt'), 'utf8'), '# pre-existing claim file\nC:\\other-tree\n')
})

for (const failure of [
  { name: 'late checkout staging', step: 'detach:restore-index:staged', bulk: true },
  { name: 'late claim replacement', step: 'detach:claim:removed', bulk: true },
  { name: 'late managed unlink', step: 'detach:artifact:localOverlay:staged', bulk: false },
  { name: 'index visibility restore', step: 'detach:index:restored', bulk: false }
]) {
  test(`detach rollback restores the full worktree, claim, and index after ${failure.name} failure`, async (t) => {
    const fixture = await createAttachedDetachFixture(t, {
      bulk: failure.bulk,
      checkpoint(step) {
        if (step === failure.step) throw new Error(`injected detach failure: ${step}`)
      }
    })
    const before = transactionFingerprint(fixture)

    await assert.rejects(fixture.detachPort.apply(fixture.detachPlan), /injected detach failure/)
    assert.deepEqual(transactionFingerprint(fixture), before)
    assert.equal(fs.existsSync(path.join(fixture.worktree, '.skill-graft-transactions')), false)
    assert.equal(fs.existsSync(path.join(fixture.hub, '.skill-graft-transactions')), false)
  })
}

test('detach adapter rechecks managed links and empty restore targets before its first write', async (t) => {
  await t.test('ordinary managed target is rejected without touching other links or claim', async (t) => {
    const fixture = await createAttachedDetachFixture(t)
    const target = path.join(fixture.worktree, '.agents', 'skills', residents[0])
    fs.rmSync(target, { recursive: true, force: true })
    write(path.join(target, 'user.txt'), 'late ordinary content\n')
    const before = transactionFingerprint(fixture)

    await assert.rejects(fixture.detachPort.apply(fixture.detachPlan), /artifact changed before apply/)
    assert.deepEqual(transactionFingerprint(fixture), before)
  })

  await t.test('late restore target is rejected rather than overwritten', async (t) => {
    const fixture = await createAttachedDetachFixture(t)
    const target = path.join(fixture.worktree, '.claude', 'settings.json')
    write(target, 'late user content\n')
    const before = transactionFingerprint(fixture)

    await assert.rejects(fixture.detachPort.apply(fixture.detachPlan), /restore target is not empty/)
    assert.deepEqual(transactionFingerprint(fixture), before)
  })

  await t.test('late ordinary content at a planned keepMissing target is rejected without removing claim', async (t) => {
    const missingTarget = `.agents/skills/${residents[1]}`
    const fixture = await createAttachedDetachFixture(t, { removeManaged: missingTarget })
    const artifact = fixture.detachPlan.artifacts.find((entry) => entry.id === `resident:${residents[1]}`)
    assert.equal(artifact.action, 'keepMissing')
    write(path.join(fixture.worktree, ...missingTarget.split('/'), 'user.txt'), 'late ordinary content\n')
    const before = transactionFingerprint(fixture)

    await assert.rejects(fixture.detachPort.apply(fixture.detachPlan), /artifact changed before apply/)
    assert.deepEqual(transactionFingerprint(fixture), before)
    assert.match(fs.readFileSync(path.join(fixture.hub, 'overlay', 'attached-worktrees.txt'), 'utf8'), /game-tree/)
  })
})

test('attach prompt defers claim/materialization until exit-zero waiting while legacy shims stay typed', () => {
  const promptRoot = path.join(repoRoot, 'overlay', 'prompts')
  const prompt = fs.readFileSync(path.join(promptRoot, 'attach.txt'), 'utf8')
  const detachPrompt = fs.readFileSync(path.join(promptRoot, 'detach.txt'), 'utf8')
  const attachShim = fs.readFileSync(path.join(repoRoot, 'overlay', 'attach-library.ps1'), 'utf8')
  const syncShim = fs.readFileSync(path.join(repoRoot, 'overlay', 'sync-codex-worktree-overlay.ps1'), 'utf8')

  assert.match(prompt, /\{\{SESSION_ID\}\}/)
  assert.equal((prompt.match(/^sg\s+/gm) || []).length, 1)
  assert.match(prompt, /sg snapshot create .*attach-snapshot-\{\{SESSION_ID\}\}.*--contract-v1/)
  assert.match(prompt, /exit 0.*waiting/s)
  assert.match(prompt, /claim.*plan-sync.*sync/s)
  assert.match(prompt, /--session-id "\{\{SESSION_ID\}\}"/)
  assert.match(prompt, /materializedSnapshot.*marker/s)
  assert.match(prompt, /selectedSkills=\[\.\.\.\].*snapshot\.files/s)
  assert.match(prompt, /没有任何 Skill.*\[\]/)
  assert.doesNotMatch(prompt, /selectedSkills=\[ozdqp-/)
  assert.doesNotMatch(prompt, /sg apply-legacy-attach|attach-library\.ps1|manage-skill-visibility\.ps1|Set-Content|Copy-Item|Remove-Item/)

  assert.match(detachPrompt, /\{\{SESSION_ID\}\}/)
  assert.equal((detachPrompt.match(/^sg\s+/gm) || []).length, 1)
  assert.match(detachPrompt, /sg apply-legacy-detach .*--session-id "\{\{SESSION_ID\}\}".*--contract-v1/)
  assert.doesNotMatch(detachPrompt, /manage-skill-visibility\.ps1|attached-worktrees\.txt|skill-review[\\/]history|Set-Content|Copy-Item|Remove-Item|Move-Item|New-Item/)

  const allPrompts = fs.readdirSync(promptRoot)
    .filter((name) => name.endsWith('.txt'))
    .map((name) => fs.readFileSync(path.join(promptRoot, name), 'utf8'))
    .join('\n')
  assert.doesNotMatch(allPrompts, /(?:attach-library|manage-skill-visibility|promote-inbox|analyze-remote-skill-update|dispatch-hub-codex|start-codex-session)\.ps1/i)

  assert.match(attachShim, /'apply-legacy-attach'/)
  assert.match(attachShim, /'requireMatch'/)
  assert.match(attachShim, /\$SessionId/)
  assert.doesNotMatch(attachShim, /Get-FileHash|Copy-Item|Remove-Item|New-Item|Set-Content|Add-Content|Start-Process/)
  assert.doesNotMatch(attachShim, /(?:^|[;&|])\s*git(?:\.exe)?\b/im)

  assert.match(syncShim, /'repair-links'/)
  assert.doesNotMatch(syncShim, /attach-library\.ps1|apply-legacy-attach|Copy-Item|Remove-Item/)
})
