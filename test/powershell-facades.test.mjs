import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const overlayRoot = path.join(repoRoot, 'overlay')
const facadeNames = [
  'analyze-remote-skill-update.ps1',
  'dispatch-hub-codex.ps1',
  'promote-inbox.ps1'
]

function walkPowerShell(root) {
  const found = []
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(absolute)
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.ps1')) found.push(absolute)
    }
  }
  visit(root)
  return found.sort()
}

function powershellExe() {
  if (process.platform !== 'win32') return null
  const candidate = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return fs.existsSync(candidate) ? candidate : null
}

function snapshotTree(root) {
  if (!fs.existsSync(root)) return []
  const result = []
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name)
      const relative = path.relative(root, absolute).replaceAll('\\', '/')
      if (entry.isDirectory()) {
        result.push([relative, 'directory'])
        visit(absolute)
      } else {
        result.push([relative, 'file', fs.readFileSync(absolute).toString('base64')])
      }
    }
  }
  visit(root)
  return result
}

function createFacadeSandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-ps-facade-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const packageRoot = path.join(root, 'package with spaces')
  const overlay = path.join(packageRoot, 'overlay')
  const bin = path.join(root, 'fake-bin')
  const home = path.join(root, 'home')
  const log = path.join(root, 'sg-call.json')
  fs.mkdirSync(overlay, { recursive: true })
  fs.mkdirSync(bin, { recursive: true })
  fs.mkdirSync(home, { recursive: true })
  for (const name of facadeNames) {
    fs.copyFileSync(path.join(overlayRoot, name), path.join(overlay, name))
  }

  const fakeSg = path.join(root, 'fake-sg.mjs')
  fs.writeFileSync(fakeSg, [
    "import fs from 'node:fs'",
    "const stdin = fs.readFileSync(0, 'utf8')",
    "fs.writeFileSync(process.env.SG_FAKE_LOG, JSON.stringify({ args: process.argv.slice(2), stdin, hubRoot: process.env.HUB_ROOT }))",
    "process.stdout.write(process.env.SG_FAKE_STDOUT || '')",
    "process.stderr.write(process.env.SG_FAKE_STDERR || '')",
    "process.exit(Number(process.env.SG_FAKE_EXIT || 0))",
    ''
  ].join('\n'))
  fs.writeFileSync(path.join(bin, 'sg.cmd'), [
    '@echo off',
    `"${process.execPath}" "${fakeSg}" %*`,
    'exit /b %ERRORLEVEL%',
    ''
  ].join('\r\n'))

  const guardedRoot = path.join(root, 'guarded-data')
  fs.mkdirSync(path.join(guardedRoot, 'skill-review', 'history'), { recursive: true })
  fs.mkdirSync(path.join(guardedRoot, 'skills', 'inbox', 'sentinel'), { recursive: true })
  fs.writeFileSync(path.join(guardedRoot, 'skill-review', 'state.json'), '{"sentinel":true}\n')
  fs.writeFileSync(path.join(guardedRoot, 'skill-review', 'history', 'sentinel.json'), '{"sentinel":true}\n')
  fs.writeFileSync(path.join(guardedRoot, 'skills', 'inbox', 'sentinel', 'SKILL.md'), '# sentinel\n')

  const env = {
    ...process.env,
    PATH: bin,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'appdata'),
    LOCALAPPDATA: path.join(home, 'localappdata'),
    TEMP: path.join(home, 'temp'),
    TMP: path.join(home, 'temp'),
    SG_FAKE_LOG: log,
    SG_FAKE_STDOUT: 'fake-sg-stdout',
    SG_FAKE_STDERR: 'fake-sg-stderr',
    SG_FAKE_EXIT: '23'
  }
  for (const name of ['APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) fs.mkdirSync(env[name], { recursive: true })
  return { root, packageRoot, overlay, guardedRoot, log, env }
}

function invokeFacade(sandbox, name, args, input = '') {
  return spawnSync(powershellExe(), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', path.join(sandbox.overlay, name),
    ...args
  ], {
    cwd: sandbox.root,
    encoding: 'utf8',
    env: sandbox.env,
    input,
    windowsHide: true
  })
}

test('every shipped PowerShell entry keeps review decisions behind typed sg commands', () => {
  const files = walkPowerShell(overlayRoot)
  const names = files.map((file) => path.relative(overlayRoot, file).replaceAll('\\', '/'))
  for (const name of facadeNames) assert.ok(names.includes(name), `${name} must remain a shipped compatibility asset`)
  const installSource = fs.readFileSync(path.join(repoRoot, 'src', 'control', 'install.ts'), 'utf8')
  assert.match(installSource, /join\(dataRoot, 'overlay', 'analyze-remote-skill-update\.ps1'\)/,
    'the installed data-root contract must retain its required ingest facade asset')

  const directReviewMutation = /(?:skill-review[\\/]state\.json|skills[\\/]inbox|\bWrite-JsonFile\b|\bNew-HistoryRecord\b)/i
  const directMutationFiles = files
    .filter((file) => directReviewMutation.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(overlayRoot, file).replaceAll('\\', '/'))
  assert.deepEqual(directMutationFiles, [
    'HubLib.ps1',
    'start-codex-session.ps1'
  ], 'only the non-entry helper library and the explicitly deferred P5 session launcher may retain legacy review writes')

  // These are the only remaining executable PowerShell mutation boundaries:
  // session persistence moves to SessionRunner in P5; visibility cleanup is a
  // P3 compatibility asset. Neither is reachable from current typed entries.
  const deferredLegacyEntrypoints = new Map([
    ['start-codex-session.ps1', /skill-review[\\/]sessions\.json/],
    ['manage-skill-visibility.ps1', /function Remove-LegacyWorkspaceContent/]
  ])
  for (const [name, legacyMarker] of deferredLegacyEntrypoints) {
    assert.match(fs.readFileSync(path.join(overlayRoot, name), 'utf8'), legacyMarker, `${name} planned-boundary marker`)
  }

  const expectedCommands = new Map([
    ['analyze-remote-skill-update.ps1', /@\('ingest', '--game-repo'/],
    ['dispatch-hub-codex.ps1', /& \$sg 'analyze' '--contract-v1'/],
    ['promote-inbox.ps1', /'decide',[\s\S]*'--id',[\s\S]*'--action'/]
  ])
  const forbiddenFacadeLogic = /(?:HubLib\.ps1|skill-review[\\/]|skills[\\/]inbox|\b(?:Read|Write)-JsonFile\b|\bNew-HistoryRecord\b|\bStart-Process\b|\bcodex\s+exec\b|\bgit\s+-C\b|\bMove-Item\b)/i
  for (const [name, commandPattern] of expectedCommands) {
    const source = fs.readFileSync(path.join(overlayRoot, name), 'utf8')
    assert.match(source, /Deprecated v0 compatibility facade/)
    assert.match(source, /Get-Command -Name 'sg'/)
    assert.match(source, commandPattern)
    assert.match(source, /--contract-v1/)
    assert.doesNotMatch(source, forbiddenFacadeLogic)
    const withoutEnvironmentRestore = source.replace(
      /Remove-Item -LiteralPath 'Env:HUB_ROOT' -ErrorAction SilentlyContinue/g,
      ''
    )
    assert.doesNotMatch(withoutEnvironmentRestore,
      /\b(?:Add-Content|Copy-Item|Move-Item|New-Item|Remove-Item|Set-Content|Start-Process)\b|\[System\.IO\.File\]/i,
      `${name} must not retain a direct file/process effect`)
  }

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8')
    assert.doesNotMatch(source, /(?:&|\.)[^\r\n]*(?:promote-inbox|manage-skill-visibility)\.ps1/i,
      `${path.basename(file)} must not invoke a direct promote/visibility mutation script`)
  }

  const liveEntrySources = [
    path.join(repoRoot, 'src', 'control', 'cli.ts'),
    path.join(repoRoot, 'server', 'index.mjs'),
    ...fs.readdirSync(path.join(overlayRoot, 'hooks')).map((name) => path.join(overlayRoot, 'hooks', name)),
    ...fs.readdirSync(path.join(overlayRoot, 'prompts')).map((name) => path.join(overlayRoot, 'prompts', name))
  ].map((file) => fs.readFileSync(file, 'utf8')).join('\n')
  assert.doesNotMatch(liveEntrySources, /(?:analyze-remote-skill-update|dispatch-hub-codex|promote-inbox|start-codex-session|manage-skill-visibility)\.ps1/i)
  assert.match(liveEntrySources, /application\.execute/)
  assert.match(liveEntrySources, /node "\$cli" ingest/)

  const attachPrompt = fs.readFileSync(path.join(overlayRoot, 'prompts', 'attach.txt'), 'utf8')
  const detachPrompt = fs.readFileSync(path.join(overlayRoot, 'prompts', 'detach.txt'), 'utf8')
  assert.match(attachPrompt, /^sg apply-legacy-attach .*\{\{SESSION_ID\}\}.*--contract-v1$/m)
  assert.match(detachPrompt, /^sg apply-legacy-detach .*\{\{SESSION_ID\}\}.*--contract-v1$/m)
  assert.equal((detachPrompt.match(/^sg\s+/gm) || []).length, 1)
  assert.doesNotMatch(detachPrompt, /attached-worktrees\.txt|skill-review[\\/]history|(?:Set|Add)-Content|Copy-Item|Move-Item|New-Item|Remove-Item|\bgit\s+-C\b/i)
})

test('legacy ingest facade maps explicit argv, dry-run, stdin transaction, output, and exit to fake sg', {
  skip: !powershellExe()
}, (t) => {
  const sandbox = createFacadeSandbox(t)
  const gameRepo = path.join(sandbox.root, 'game repo')
  fs.mkdirSync(gameRepo)
  const before = snapshotTree(sandbox.guardedRoot)
  const oldCommit = '1'.repeat(40)
  const newCommit = '2'.repeat(40)
  const result = invokeFacade(sandbox, 'analyze-remote-skill-update.ps1', [
    '-GameRepo', gameRepo,
    '-HubRoot', sandbox.guardedRoot,
    '-OldCommit', oldCommit,
    '-NewCommit', newCommit,
    '-RefName', 'refs/remotes/origin/main',
    '-DispatchCodex',
    '-DryRun'
  ], 'ignored redirected payload\n')

  assert.equal(result.status, 23, result.stderr)
  assert.equal(result.stdout, 'fake-sg-stdout')
  assert.equal(result.stderr, 'fake-sg-stderr')
  const call = JSON.parse(fs.readFileSync(sandbox.log, 'utf8'))
  assert.deepEqual(call.args, [
    'ingest', '--game-repo', path.resolve(gameRepo), '--dispatch', '--dry-run', '--contract-v1'
  ])
  assert.equal(call.stdin.replaceAll('\r\n', '\n'), `${oldCommit} ${newCommit} refs/remotes/origin/main\n`)
  assert.equal(call.hubRoot, path.resolve(sandbox.guardedRoot))
  assert.deepEqual(snapshotTree(sandbox.guardedRoot), before)
})

test('legacy ingest facade forwards redirected hook payload without interpreting it', {
  skip: !powershellExe()
}, (t) => {
  const sandbox = createFacadeSandbox(t)
  sandbox.env.SG_FAKE_EXIT = '0'
  sandbox.env.SG_FAKE_STDERR = ''
  const gameRepo = path.join(sandbox.root, 'game')
  fs.mkdirSync(gameRepo)
  const payload = `${'3'.repeat(40)} ${'4'.repeat(40)} refs/remotes/origin/one\n${'5'.repeat(40)} ${'6'.repeat(40)} refs/remotes/origin/two\n`
  const before = snapshotTree(sandbox.guardedRoot)
  const result = invokeFacade(sandbox, 'analyze-remote-skill-update.ps1', [
    '-GameRepo', gameRepo,
    '-HubRoot', sandbox.guardedRoot
  ], payload)

  assert.equal(result.status, 0, result.stderr)
  const call = JSON.parse(fs.readFileSync(sandbox.log, 'utf8'))
  assert.deepEqual(call.args, ['ingest', '--game-repo', path.resolve(gameRepo), '--contract-v1'])
  assert.equal(call.stdin.replaceAll('\r\n', '\n'), payload)
  assert.deepEqual(snapshotTree(sandbox.guardedRoot), before)
})

test('legacy decide and dispatch facades only map argv to fake typed sg and project process results', {
  skip: !powershellExe()
}, (t) => {
  const sandbox = createFacadeSandbox(t)
  const packageBefore = snapshotTree(sandbox.packageRoot)
  const decide = invokeFacade(sandbox, 'promote-inbox.ps1', [
    '-Id', 'inbox-123',
    '-Action', 'merge',
    '-Note', 'reviewed note',
    '-MergeTarget', 'skills/ozdqp-development'
  ])
  assert.equal(decide.status, 23, decide.stderr)
  assert.equal(decide.stdout, 'fake-sg-stdout')
  assert.equal(decide.stderr, 'fake-sg-stderr')
  let call = JSON.parse(fs.readFileSync(sandbox.log, 'utf8'))
  assert.deepEqual(call.args, [
    'decide', '--id', 'inbox-123', '--action', 'merge', '--note', 'reviewed note',
    '--merge-target', 'skills/ozdqp-development', '--contract-v1'
  ])
  assert.equal(call.stdin, '')
  assert.equal(call.hubRoot, path.resolve(sandbox.packageRoot))
  assert.deepEqual(snapshotTree(sandbox.packageRoot), packageBefore)

  fs.rmSync(sandbox.log, { force: true })
  const dispatch = invokeFacade(sandbox, 'dispatch-hub-codex.ps1', [])
  assert.equal(dispatch.status, 23, dispatch.stderr)
  call = JSON.parse(fs.readFileSync(sandbox.log, 'utf8'))
  assert.deepEqual(call.args, ['analyze', '--contract-v1'])
  assert.equal(call.stdin, '')
  assert.equal(call.hubRoot, path.resolve(sandbox.packageRoot))
  assert.deepEqual(snapshotTree(sandbox.packageRoot), packageBefore)
})
