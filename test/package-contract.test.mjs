import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { hubRoot } from './helpers.mjs'

function npmPackDryRun() {
  const npmExecPath = String(process.env.npm_execpath || path.join(
    path.dirname(process.execPath),
    'node_modules',
    'npm',
    'bin',
    'npm-cli.js'
  ))
  assert.equal(fs.existsSync(npmExecPath), true, `npm CLI is unavailable: ${npmExecPath}`)
  return spawnSync(process.execPath, [npmExecPath, 'pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: hubRoot,
    env: { ...process.env },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60000,
    maxBuffer: 32 * 1024 * 1024
  })
}

function importPackage(specifier) {
  return spawnSync(process.execPath, [
    '--input-type=module',
    '--eval',
    `await import(${JSON.stringify(specifier)})`
  ], {
    cwd: hubRoot,
    env: { ...process.env },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000
  })
}

test('Local release tarball is a clean built distribution without source or machine-owned configuration', () => {
  const result = npmPackDryRun()
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const rows = JSON.parse(result.stdout)
  assert.equal(rows.length, 1)
  const files = rows[0].files.map((entry) => entry.path.replaceAll('\\', '/')).sort()
  for (const required of [
    'dist/control/cli.js',
    'server/index.mjs',
    'web/index.html',
    'overlay/analyze-remote-skill-update.ps1',
    'overlay/dispatch-hub-codex.ps1',
    'overlay/promote-inbox.ps1'
  ]) {
    assert.equal(files.includes(required), true, `${required} must ship`)
  }
  const sourcePowerShell = fs.readdirSync(path.join(hubRoot, 'overlay'))
    .filter((name) => name.toLowerCase().endsWith('.ps1'))
    .map((name) => `overlay/${name}`)
    .sort()
  assert.deepEqual(files.filter((file) => file.startsWith('overlay/') && file.endsWith('.ps1')), sourcePowerShell,
    'the static facade audit must cover every PowerShell file in the release tarball')
  for (const forbidden of [
    'overlay/attached-worktrees.txt',
    'overlay/do-not-auto-attach.txt',
    'overlay/scan-roots.txt',
    'setup.cmd'
  ]) {
    assert.equal(files.includes(forbidden), false, `${forbidden} must not ship`)
  }
  const packedPackage = JSON.parse(fs.readFileSync(path.join(hubRoot, 'package.json'), 'utf8'))
  assert.equal(packedPackage.scripts.setup, 'node dist/control/cli.js setup')
  assert.deepEqual(Object.keys(packedPackage.exports).sort(), [
    '.',
    './application',
    './contracts',
    './local',
    './package.json'
  ])
  for (const prefix of ['src/', 'test/', 'docs/', 'artifacts/', 'scripts/']) {
    assert.deepEqual(files.filter((file) => file.startsWith(prefix)), [], `${prefix} must not ship`)
  }
  for (const runtimePrefix of [
    '.skill-graft-transactions/',
    'skill-review/library/',
    'skill-review/locks/',
    'skill-review/materializations/'
  ]) {
    assert.deepEqual(files.filter((file) => file.startsWith(runtimePrefix)), [], `${runtimePrefix} runtime data must not ship`)
  }
  const npmignore = fs.readFileSync(path.join(hubRoot, '.npmignore'), 'utf8')
  assert.match(npmignore, /^\/\.skill-graft-transactions\/$/m)
  assert.deepEqual(
    files.filter((file) => /^dist\/core\/(?:install|sessions)(?:\.|\/)/.test(file)),
    [],
    'clean build must not retain migrated core artifacts'
  )
  assert.deepEqual(
    files.filter((file) => file.startsWith('skills/') && file !== 'skills/README.md'),
    [],
    'project skill corpus must not ship'
  )

  const privateMarkers = [
    'E:\\ozdqp-skill-hub',
    'E:/ozdqp-skill-hub',
    'E:\\ozdqp-cli-attach-probe',
    'C:\\Users\\win11',
    'C:/Users/win11'
  ]
  const privateSkillMarkers = [
    'ozdqp-development',
    'ozdqp-ui-development',
    'ozdqp-git-workflow'
  ]
  for (const relative of files) {
    const file = path.join(hubRoot, ...relative.split('/'))
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue
    const bytes = fs.readFileSync(file)
    if (bytes.includes(0)) continue
    const text = bytes.toString('utf8')
    for (const marker of [...privateMarkers, ...privateSkillMarkers]) {
      assert.equal(text.includes(marker), false, `${relative} contains private release marker ${marker}`)
    }
  }
})

test('package exports expose only contracts, Application, and Local composition', () => {
  for (const allowed of [
    'ozdqp-skill-hub',
    'ozdqp-skill-hub/contracts',
    'ozdqp-skill-hub/application',
    'ozdqp-skill-hub/local'
  ]) {
    const result = importPackage(allowed)
    assert.equal(result.status, 0, result.stderr || result.stdout)
  }

  for (const forbidden of [
    'ozdqp-skill-hub/dist/core/decide.js',
    'ozdqp-skill-hub/dist/core/ingest.js',
    'ozdqp-skill-hub/dist/local/session/legacy-sessions.js'
  ]) {
    const result = importPackage(forbidden)
    assert.notEqual(result.status, 0, `${forbidden} unexpectedly resolved`)
    assert.match(result.stderr, /ERR_PACKAGE_PATH_NOT_EXPORTED/)
  }
})
