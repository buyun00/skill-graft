import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  assertRunLayoutOwned,
  validateRealE2eEnvironment
} from './real-e2e.mjs'

function required(name) {
  const value = String(process.env[name] || '').trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function absoluteDirectory(name) {
  const value = required(name)
  if (!path.isAbsolute(value)) throw new Error(`${name} must be absolute`)
  const resolved = path.resolve(value)
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`${name} is not a directory: ${resolved}`)
  }
  return resolved
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout.trim()
}

function assertEmptyDirectory(dir, label) {
  if (fs.readdirSync(dir).length > 0) throw new Error(`${label} must be empty before P0 fixture preparation: ${dir}`)
}

const sourceRoot = absoluteDirectory('SKILL_GRAFT_FIXTURE_SOURCE')
const libraryRoot = absoluteDirectory('SKILL_GRAFT_LIBRARY_SOURCE')
const probeSource = absoluteDirectory('SKILL_GRAFT_PROBE_SOURCE')
const probeCommit = required('SKILL_GRAFT_PROBE_COMMIT')
const protectedRoots = [sourceRoot, libraryRoot, probeSource]
const fixedProbe = 'E:\\ozdqp-cli-attach-probe'
if (fs.existsSync(fixedProbe)) protectedRoots.push(fixedProbe)
const context = validateRealE2eEnvironment(process.env, { workspaceRoot: sourceRoot, protectedRoots })
assertRunLayoutOwned(context)
assertEmptyDirectory(context.hubDataRoot, 'hub-data')
assertEmptyDirectory(context.probeRoot, 'probe')

fs.copyFileSync(path.join(sourceRoot, 'AGENTS.override.md'), path.join(context.hubDataRoot, 'AGENTS.override.md'))
fs.cpSync(path.join(sourceRoot, 'overlay'), path.join(context.hubDataRoot, 'overlay'), { recursive: true })
fs.mkdirSync(path.join(context.hubDataRoot, 'skills'), { recursive: true })
for (const name of ['ozdqp-development', 'ozdqp-ui-development', 'ozdqp-git-workflow']) {
  const source = path.join(libraryRoot, name)
  if (!fs.existsSync(path.join(source, 'SKILL.md'))) throw new Error(`missing authoritative ${name}/SKILL.md`)
  fs.cpSync(source, path.join(context.hubDataRoot, 'skills', name), { recursive: true })
}
fs.mkdirSync(path.join(context.hubDataRoot, 'skills', 'adopted'), { recursive: true })
fs.mkdirSync(path.join(context.hubDataRoot, 'skills', 'inbox'), { recursive: true })
fs.mkdirSync(path.join(context.hubDataRoot, 'skill-review', 'history'), { recursive: true })
fs.writeFileSync(path.join(context.hubDataRoot, 'overlay', 'attached-worktrees.txt'), '', 'utf8')
fs.writeFileSync(path.join(context.hubDataRoot, 'overlay', 'do-not-auto-attach.txt'), '', 'utf8')
fs.writeFileSync(path.join(context.hubDataRoot, 'overlay', 'scan-roots.txt'), `${path.dirname(context.probeRoot)}\n`, 'utf8')
fs.writeFileSync(path.join(context.hubDataRoot, 'skill-review', 'state.json'), '{\n  "version": 1,\n  "lastIngest": null,\n  "items": []\n}\n', 'utf8')
fs.writeFileSync(path.join(context.hubDataRoot, 'skill-review', 'sessions.json'), '{\n  "sessions": []\n}\n', 'utf8')
fs.writeFileSync(path.join(context.hubDataRoot, '.gitignore'), [
  'skill-review/state.json',
  'skill-review/sessions.json',
  'skill-review/history/',
  'skill-review/prompt-*.txt',
  'skill-review/resume-*.txt',
  'skill-review/run-codex-*',
  'skill-review/session-*',
  'skill-review/*.log',
  ''
].join('\n'), 'utf8')

run('git', ['init', '--initial-branch=main'], context.hubDataRoot)
run('git', ['config', 'user.name', 'Skill Graft P0 E2E'], context.hubDataRoot)
run('git', ['config', 'user.email', 'skill-graft-p0@invalid.local'], context.hubDataRoot)
run('git', ['add', '--', '.gitignore', 'AGENTS.override.md', 'overlay', 'skills'], context.hubDataRoot)
run('git', ['commit', '-m', 'P0 isolated hub fixture'], context.hubDataRoot)
const hubCommit = run('git', ['rev-parse', 'HEAD'], context.hubDataRoot)

run('git', ['cat-file', '-e', `${probeCommit}^{commit}`], probeSource)
run('git', ['clone', '--shared', '--no-checkout', probeSource, context.probeRoot], context.runRoot)
run('git', ['remote', 'remove', 'origin'], context.probeRoot)
run('git', ['checkout', '--detach', probeCommit], context.probeRoot)
run('git', ['config', 'user.name', 'Skill Graft P0 E2E'], context.probeRoot)
run('git', ['config', 'user.email', 'skill-graft-p0@invalid.local'], context.probeRoot)
const checkedOut = run('git', ['rev-parse', 'HEAD'], context.probeRoot)
const probeStatus = run('git', ['status', '--porcelain=v1', '--untracked-files=all'], context.probeRoot)
if (probeStatus) throw new Error(`isolated probe is not clean after checkout:\n${probeStatus}`)
if (!fs.existsSync(path.join(context.probeRoot, 'AGENTS.md')) || !fs.existsSync(path.join(context.probeRoot, 'baloot_client'))) {
  throw new Error('isolated probe does not satisfy the OZDQP checkout contract')
}

const manifest = {
  version: 1,
  runId: context.runId,
  preparedAt: new Date().toISOString(),
  hubCommit,
  probeCommit: checkedOut,
  probeCloneMode: 'shared-no-checkout',
  remoteRemoved: true,
  runtimeStateInitialized: true
}
fs.writeFileSync(path.join(context.runRoot, '.skill-graft-p0-fixture.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify({ ok: true, ...manifest }, null, 2)}\n`)
