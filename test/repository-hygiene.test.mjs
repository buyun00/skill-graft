import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { hubRoot } from './helpers.mjs'

function git(args) {
  return spawnSync('git', args, { cwd: hubRoot, encoding: 'utf8', windowsHide: true })
}

test('runtime state, session text, history, and raw verification artifacts are ignored and untracked', () => {
  for (const rel of [
    'skill-review/state.json',
    'skill-review/sessions.json',
    'skill-review/history/example.json',
    'skill-review/resume-example.txt',
    '.artifacts-local/verification/P0/raw.log'
  ]) {
    const ignored = git(['check-ignore', '-q', '--', rel])
    assert.equal(ignored.status, 0, `${rel} must be ignored`)
  }
  const tracked = git(['ls-files', '--', 'skill-review/state.json', 'skill-review/sessions.json', 'skill-review/history'])
  assert.equal(tracked.status, 0, tracked.stderr)
  assert.equal(tracked.stdout.trim(), '', `runtime files remain tracked:\n${tracked.stdout}`)
})

test('default npm test cannot discover the explicitly gated real attach file', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(hubRoot, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts.test, 'node test/support/run-default-suite.mjs')
  assert.match(pkg.scripts['test:real:local:attach'], /test\/real\/local\/attach\.test\.mjs/)
  const topLevelTests = fs.readdirSync(path.join(hubRoot, 'test')).filter((name) => name.endsWith('.test.mjs'))
  assert.equal(topLevelTests.some((name) => /real.*attach/i.test(name)), false)
})

test('default suite inspects the fixed probe without optional Git index refreshes', () => {
  const wrapper = fs.readFileSync(path.join(hubRoot, 'test', 'support', 'run-default-suite.mjs'), 'utf8')
  assert.match(wrapper, /GIT_OPTIONAL_LOCKS:\s*'0'/)
  assert.match(wrapper, /--no-optional-locks/)
  assert.match(wrapper, /--git-path', 'index/)
  assert.match(wrapper, /startIsolatedApi/)
  assert.match(wrapper, /HUB_API_PORT = String\(isolatedApi\.port\)/)
})
