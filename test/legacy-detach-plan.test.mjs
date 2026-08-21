import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { planLegacyDetach } from '../dist/core/legacy-detach.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const residents = ['ozdqp-development', 'ozdqp-ui-development', 'ozdqp-git-workflow']

function observed(overrides = {}) {
  return {
    exists: true,
    actualKind: 'link',
    linkedToExpected: true,
    pointsElsewhere: false,
    contentMatches: true,
    ...overrides
  }
}

function artifact(id, kind, targetRelativePath, overrides = {}) {
  return {
    id,
    kind,
    label: id,
    targetRelativePath,
    hubRelativePath: kind === 'agentsOverride' ? 'AGENTS.override.md' : `skills/${id}`,
    expectedKind: kind === 'agentsOverride' ? 'file' : 'directory',
    libraryExists: true,
    observed: observed(),
    ...overrides
  }
}

function inspection(overrides = {}) {
  const artifacts = [
    artifact('agentsOverride', 'agentsOverride', 'AGENTS.override.md'),
    ...residents.map((name) => artifact(`resident:${name}`, 'residentSkill', `.agents/skills/${name}`, { name })),
    artifact('adopted:team-skill', 'adoptedSkill', '.agents/skills/team-skill', { name: 'team-skill' }),
    artifact('localOverlay', 'localOverlay', '.codex/local-overlay', {
      hubRelativePath: 'overlay',
      backupRelativePath: '.codex/local-overlay.pre-hub-fixture'
    })
  ]
  return {
    worktree: {
      targetId: 'opaque-target',
      resolvedPath: '/game-tree',
      recognition: {
        exists: true,
        isDirectory: true,
        sameAsHub: false,
        excluded: false,
        partialCheckout: false,
        explicitlyAllowed: false,
        ephemeral: false,
        requiredMarkers: [
          { name: 'AGENTS.md', present: true },
          { name: 'baloot_client', present: true }
        ]
      },
      blocked: false,
      claimed: true
    },
    gitWorktree: true,
    artifacts,
    trackedAssistantPaths: [
      'AGENTS.override.md',
      ...residents.map((name) => `.agents/skills/${name}/SKILL.md`),
      '.agents/skills/team-skill/SKILL.md',
      '.agents/skills/unity-skills/SKILL.md',
      '.claude/A',
      '.claude/a',
      '.codex/agents/legacy.txt',
      '.codex/local-overlay/legacy.txt'
    ],
    presentAssistantPaths: [
      ...residents.map((name) => `.agents/skills/${name}`),
      '.agents/skills/team-skill',
      '.agents/skills/unity-skills',
      '.codex/local-overlay'
    ],
    ...overrides
  }
}

test('detach Core restores legacy visibility plus tracked files hidden by every approved unlink', () => {
  const decision = planLegacyDetach({ inspection: inspection(), detachSessionAuthorized: true })
  assert.equal(decision.decision, 'apply', JSON.stringify(decision))
  assert.deepEqual(decision.plan.artifacts.map(({ id, action }) => ({ id, action })), [
    { id: 'agentsOverride', action: 'unlink' },
    ...residents.map((name) => ({ id: `resident:${name}`, action: 'unlink' })),
    { id: 'adopted:team-skill', action: 'unlink' },
    { id: 'localOverlay', action: 'unlink' }
  ])
  for (const name of residents) {
    assert.ok(decision.plan.restorePaths.includes(`.agents/skills/${name}/SKILL.md`), `${name} must be restored`)
  }
  assert.ok(decision.plan.restorePaths.includes('AGENTS.override.md'))
  assert.ok(decision.plan.restorePaths.includes('.agents/skills/team-skill/SKILL.md'))
  assert.ok(decision.plan.restorePaths.includes('.codex/local-overlay/legacy.txt'))
  assert.ok(decision.plan.restorePaths.includes('.claude/A'))
  assert.ok(decision.plan.restorePaths.includes('.claude/a'))
  assert.equal(decision.plan.restorePaths.filter((value) => value === '.claude/A').length, 1)
  assert.equal(decision.plan.restorePaths.filter((value) => value === '.claude/a').length, 1)
  assert.equal(decision.plan.restorePaths.includes('.agents/skills/unity-skills/SKILL.md'), false)
})

test('detach Core restores tracked official content for an approved missing managed target', () => {
  const missingResident = `resident:${residents[0]}`
  const facts = inspection()
  facts.artifacts = facts.artifacts.map((entry) => entry.id === missingResident
    ? {
        ...entry,
        observed: observed({
          exists: false,
          actualKind: undefined,
          linkedToExpected: false,
          pointsElsewhere: false,
          contentMatches: false
        })
      }
    : entry)
  facts.presentAssistantPaths = facts.presentAssistantPaths.filter((relative) => relative !== `.agents/skills/${residents[0]}`)

  const decision = planLegacyDetach({ inspection: facts, detachSessionAuthorized: true })
  assert.equal(decision.decision, 'apply', JSON.stringify(decision))
  assert.equal(decision.plan.artifacts.find((entry) => entry.id === missingResident).action, 'keepMissing')
  assert.ok(decision.plan.restorePaths.includes(`.agents/skills/${residents[0]}/SKILL.md`))
})

test('detach Core requires authorization and a claimed recognized non-blocked target', () => {
  assert.equal(planLegacyDetach({ inspection: inspection() }).decision, 'session-required')
  assert.deepEqual(
    planLegacyDetach({ inspection: inspection({ worktree: { ...inspection().worktree, claimed: false } }), detachSessionAuthorized: true }),
    { decision: 'noop', reason: 'not-attached', worktree: '/game-tree' }
  )
  assert.equal(planLegacyDetach({
    inspection: inspection({ gitWorktree: false }),
    detachSessionAuthorized: true
  }).decision, 'rejected')
  assert.equal(planLegacyDetach({
    inspection: inspection({ worktree: { ...inspection().worktree, blocked: true } }),
    detachSessionAuthorized: true
  }).decision, 'rejected')
})

test('detach Core fails closed on ordinary, external-link, and restore-target conflicts', () => {
  const ordinary = inspection()
  ordinary.artifacts = ordinary.artifacts.map((entry, index) => index === 1
    ? { ...entry, observed: observed({ actualKind: 'directory', linkedToExpected: false, contentMatches: false }) }
    : entry)
  let decision = planLegacyDetach({ inspection: ordinary, detachSessionAuthorized: true })
  assert.equal(decision.decision, 'rejected')
  assert.equal(decision.conflict, 'dirty')

  const external = inspection()
  external.artifacts = external.artifacts.map((entry, index) => index === 1
    ? { ...entry, observed: observed({ linkedToExpected: false, pointsElsewhere: true, contentMatches: false }) }
    : entry)
  decision = planLegacyDetach({ inspection: external, detachSessionAuthorized: true })
  assert.equal(decision.decision, 'rejected')
  assert.equal(decision.conflict, 'external-link')

  decision = planLegacyDetach({
    inspection: inspection({ presentAssistantPaths: [...inspection().presentAssistantPaths, '.claude'] }),
    detachSessionAuthorized: true
  })
  assert.equal(decision.decision, 'rejected')
  assert.equal(decision.conflict, 'dirty')
  assert.equal(decision.path, '.claude')
})

test('shared detach planner is host-free and keeps case-sensitive path identity explicit', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'src', 'core', 'legacy-detach.ts'), 'utf8')
  assert.doesNotMatch(source, /node:|child_process|powershell|spawnSync|fs\.|git\s/i)
  assert.match(source, /normalizedRelativeIdentity/)
  assert.doesNotMatch(source, /function overlaps[\s\S]{0,220}toLowerCase/)
})
