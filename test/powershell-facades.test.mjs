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
    SG_FAKE_EXIT: '23',
    HUB_ROOT: guardedRoot
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

function gitAvailable() {
  return spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true }).status === 0
}

function runGit(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

function createRelocatedOverlaySandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-relocated-overlay-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const worktree = path.join(root, 'game worktree')
  const configuredPackage = path.join(root, 'configured package')
  const explicitPackage = path.join(root, 'explicit package')
  const copiedOverlay = path.join(worktree, '.codex', 'local-overlay')
  const bin = path.join(root, 'fake-bin')
  const log = path.join(root, 'node-call.json')
  for (const directory of [
    worktree,
    path.join(configuredPackage, 'overlay'),
    path.join(configuredPackage, 'dist', 'control'),
    path.join(explicitPackage, 'overlay'),
    path.join(explicitPackage, 'dist', 'control'),
    copiedOverlay,
    bin
  ]) fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(configuredPackage, 'dist', 'control', 'cli.js'), '// configured package CLI\n')
  fs.writeFileSync(path.join(explicitPackage, 'dist', 'control', 'cli.js'), '// explicit package CLI\n')
  runGit(worktree, ['init', '--quiet'])
  runGit(worktree, ['config', 'ozdqp.localOverlaySource', configuredPackage])
  for (const name of ['HubLib.ps1', 'attach-library.ps1', 'sync-codex-worktree-overlay.ps1']) {
    fs.copyFileSync(path.join(overlayRoot, name), path.join(copiedOverlay, name))
  }

  const fakeNode = path.join(root, 'fake-node.mjs')
  fs.writeFileSync(fakeNode, [
    "import fs from 'node:fs'",
    "fs.writeFileSync(process.env.NODE_FAKE_LOG, JSON.stringify({ args: process.argv.slice(2), dataRoot: process.env.HUB_ROOT, skillGraftHome: process.env.SKILL_GRAFT_HOME }))",
    ''
  ].join('\n'))
  fs.writeFileSync(path.join(bin, 'node.cmd'), [
    '@echo off',
    `"${process.execPath}" "${fakeNode}" %*`,
    'exit /b %ERRORLEVEL%',
    ''
  ].join('\r\n'))
  const dataRoot = path.join(root, 'independent data root')
  fs.mkdirSync(dataRoot)
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
    NODE_FAKE_LOG: log,
    HUB_ROOT: dataRoot,
    SKILL_GRAFT_HOME: dataRoot
  }
  return { root, worktree, configuredPackage, explicitPackage, copiedOverlay, dataRoot, log, env }
}

function invokeRelocatedOverlay(sandbox, name, args) {
  return spawnSync(powershellExe(), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', path.join(sandbox.copiedOverlay, name),
    ...args
  ], {
    cwd: sandbox.worktree,
    encoding: 'utf8',
    env: sandbox.env,
    windowsHide: true
  })
}

test('every shipped PowerShell entry keeps review decisions behind typed sg commands', () => {
  const files = walkPowerShell(overlayRoot)
  const names = files.map((file) => path.relative(overlayRoot, file).replaceAll('\\', '/'))
  for (const name of facadeNames) assert.ok(names.includes(name), `${name} must remain a shipped compatibility asset`)

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

  const inferredParentRoot = /Join-Path\s+\$PSScriptRoot\s+['"]\.\.['"]/i
  for (const file of files) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), inferredParentRoot,
      `${path.basename(file)} must not infer the Hub from its copied overlay parent`)
  }
  const hubLibrary = fs.readFileSync(path.join(overlayRoot, 'HubLib.ps1'), 'utf8')
  assert.match(hubLibrary, /config --get ozdqp\.localOverlaySource/)
  assert.match(hubLibrary, /dist\\control\\cli\.js/)
  assert.match(hubLibrary, /IsPathRooted/)
  assert.match(hubLibrary, /must be outside the target worktree/)
  for (const name of ['attach-library.ps1', 'sync-codex-worktree-overlay.ps1']) {
    const source = fs.readFileSync(path.join(overlayRoot, name), 'utf8')
    assert.match(source, /Join-Path \$PSScriptRoot 'HubLib\.ps1'/)
    assert.match(source, /Get-SkillGraftPackageRoot -Worktree \$TargetWorktree -PackageRoot \$PackageRoot/)
    assert.match(source, /Join-Path \$packageRoot 'dist\\control\\cli\.js'/)
    assert.doesNotMatch(source, /\$env:(?:HUB_ROOT|SKILL_GRAFT_HOME)\s*=/)
  }
  for (const name of ['post-checkout', 'reference-transaction']) {
    const source = fs.readFileSync(path.join(overlayRoot, 'hooks', name), 'utf8')
    assert.match(source, /git -C "\$game" config --get ozdqp\.localOverlaySource/)
    assert.match(source, /git -C "\$game" config --get ozdqp\.skillWatchWorkspace/)
    assert.match(source, /case "\$hub" in[\s\S]*\[A-Za-z\]:\/\*/)
    assert.match(source, /SKILL_GRAFT_HOME="\$data_root" HUB_ROOT="\$data_root" node "\$cli"/)
    assert.doesNotMatch(source, /HUB_ROOT="\$hub"/)
  }
  const checkoutHook = fs.readFileSync(path.join(overlayRoot, 'hooks', 'post-checkout'), 'utf8')
  assert.match(checkoutHook, /data_root="\$\{primary_root:-\$legacy_root\}"/)
  assert.doesNotMatch(checkoutHook, /HUB_ROOT:-\$hub|data_root=.*\$hub/)
  assert.match(checkoutHook, /list="\$\{data_root%\/\}\/overlay\/do-not-auto-attach\.txt"/)
  assert.doesNotMatch(checkoutHook, /\$\{hub%\/\}\/overlay\/(?:do-not-auto-attach|attached-worktrees)\.txt/)

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
  assert.match(attachPrompt, /^sg snapshot create .*\{\{SESSION_ID\}\}.*--contract-v1$/m)
  assert.match(attachPrompt, /exit 0.*waiting/s)
  assert.match(attachPrompt, /claim.*plan-sync.*sync/s)
  assert.doesNotMatch(attachPrompt, /^sg (?:claim|plan-sync|sync|migrate-legacy|apply-legacy-attach)\b/m)
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

test('legacy ingest facade rejects a relative explicit host locator before invoking sg', {
  skip: !powershellExe()
}, (t) => {
  const sandbox = createFacadeSandbox(t)
  const gameRepo = path.join(sandbox.root, 'game')
  fs.mkdirSync(gameRepo)
  const before = snapshotTree(sandbox.guardedRoot)
  const result = invokeFacade(sandbox, 'analyze-remote-skill-update.ps1', [
    '-GameRepo', gameRepo,
    '-HubRoot', 'relative-host'
  ])

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /HubRoot must be an absolute path/)
  assert.equal(fs.existsSync(sandbox.log), false)
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
  assert.equal(call.hubRoot, path.resolve(sandbox.guardedRoot))
  assert.deepEqual(snapshotTree(sandbox.packageRoot), packageBefore)

  fs.rmSync(sandbox.log, { force: true })
  const dispatch = invokeFacade(sandbox, 'dispatch-hub-codex.ps1', [])
  assert.equal(dispatch.status, 23, dispatch.stderr)
  call = JSON.parse(fs.readFileSync(sandbox.log, 'utf8'))
  assert.deepEqual(call.args, ['analyze', '--contract-v1'])
  assert.equal(call.stdin, '')
  assert.equal(call.hubRoot, path.resolve(sandbox.guardedRoot))
  assert.deepEqual(snapshotTree(sandbox.packageRoot), packageBefore)
})

test('copied live wrappers launch the configured package while preserving the independent data root', {
  skip: !powershellExe() || !gitAvailable()
}, (t) => {
  const sandbox = createRelocatedOverlaySandbox(t)
  const cases = [
    {
      name: 'sync-codex-worktree-overlay.ps1',
      args: ['-TargetWorktree', sandbox.worktree, '-RequestId', 'sync-123'],
      expected: ['repair-links', '--worktree', sandbox.worktree, '--request-id', 'sync-123']
    },
    {
      name: 'attach-library.ps1',
      args: ['-TargetWorktree', sandbox.worktree, '-SessionId', 'session-123'],
      expected: [
        'apply-legacy-attach', '--worktree', sandbox.worktree, '--source-policy', 'requireMatch',
        '--visibility', 'disable', '--session-id', 'session-123'
      ]
    }
  ]
  for (const entry of cases) {
    fs.rmSync(sandbox.log, { force: true })
    const result = invokeRelocatedOverlay(sandbox, entry.name, entry.args)
    assert.equal(result.status, 0, result.stderr)
    const call = JSON.parse(fs.readFileSync(sandbox.log, 'utf8'))
    assert.equal(call.args[0], path.join(sandbox.configuredPackage, 'dist', 'control', 'cli.js'))
    assert.deepEqual(call.args.slice(1), entry.expected)
    assert.equal(call.dataRoot, path.resolve(sandbox.dataRoot))
    assert.equal(call.skillGraftHome, path.resolve(sandbox.dataRoot))
    assert.notEqual(path.dirname(path.dirname(path.dirname(call.args[0]))), path.resolve(sandbox.worktree, '.codex'))
  }

  fs.rmSync(sandbox.log, { force: true })
  const explicit = invokeRelocatedOverlay(sandbox, 'sync-codex-worktree-overlay.ps1', [
    '-TargetWorktree', sandbox.worktree,
    '-PackageRoot', sandbox.explicitPackage
  ])
  assert.equal(explicit.status, 0, explicit.stderr)
  const explicitCall = JSON.parse(fs.readFileSync(sandbox.log, 'utf8'))
  assert.equal(explicitCall.args[0], path.join(sandbox.explicitPackage, 'dist', 'control', 'cli.js'))
  assert.equal(explicitCall.dataRoot, path.resolve(sandbox.dataRoot))

  const nestedHost = path.join(sandbox.worktree, 'nested package')
  fs.mkdirSync(path.join(nestedHost, 'overlay'), { recursive: true })
  fs.mkdirSync(path.join(nestedHost, 'dist', 'control'), { recursive: true })
  fs.writeFileSync(path.join(nestedHost, 'dist', 'control', 'cli.js'), '// unsafe nested CLI\n')
  fs.rmSync(sandbox.log, { force: true })
  const nested = invokeRelocatedOverlay(sandbox, 'sync-codex-worktree-overlay.ps1', [
    '-TargetWorktree', sandbox.worktree,
    '-PackageRoot', nestedHost
  ])
  assert.notEqual(nested.status, 0)
  assert.match(nested.stderr, /must be outside the target worktree/)
  assert.equal(fs.existsSync(sandbox.log), false)

  runGit(sandbox.worktree, ['config', 'ozdqp.localOverlaySource', 'relative-host'])
  fs.rmSync(sandbox.log, { force: true })
  const unsafe = invokeRelocatedOverlay(sandbox, 'sync-codex-worktree-overlay.ps1', [
    '-TargetWorktree', sandbox.worktree
  ])
  assert.notEqual(unsafe.status, 0)
  assert.match(unsafe.stderr, /must be an absolute path/)
  assert.equal(fs.existsSync(sandbox.log), false)
})

test('live Git hooks launch package CLI without rebinding the independent data root', {
  skip: !gitAvailable()
}, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-relocated-hooks-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const worktree = path.join(root, 'game worktree')
  const packageRoot = path.join(root, 'runtime package')
  const dataRoot = path.join(root, 'independent data')
  const hookRoot = path.join(packageRoot, 'overlay', 'hooks')
  const cli = path.join(packageRoot, 'dist', 'control', 'cli.js')
  const log = path.join(root, 'hook-calls.jsonl')
  fs.mkdirSync(worktree, { recursive: true })
  fs.mkdirSync(hookRoot, { recursive: true })
  fs.mkdirSync(path.dirname(cli), { recursive: true })
  fs.mkdirSync(path.join(dataRoot, 'overlay'), { recursive: true })
  for (const name of ['post-checkout', 'reference-transaction']) {
    const target = path.join(hookRoot, name)
    fs.copyFileSync(path.join(overlayRoot, 'hooks', name), target)
    fs.chmodSync(target, 0o755)
  }
  fs.writeFileSync(cli, [
    "const fs = require('node:fs')",
    "const stdin = fs.readFileSync(0, 'utf8')",
    "fs.appendFileSync(process.env.HOOK_FAKE_LOG, JSON.stringify({ args: process.argv.slice(2), stdin, packageEntry: __filename, skillGraftHome: process.env.SKILL_GRAFT_HOME || null, hubRoot: process.env.HUB_ROOT || null }) + '\\n')",
    ''
  ].join('\n'))

  runGit(worktree, ['init', '--quiet'])
  runGit(worktree, ['config', 'user.email', 'hooks@example.invalid'])
  runGit(worktree, ['config', 'user.name', 'Hook Probe'])
  fs.writeFileSync(path.join(worktree, 'seed.txt'), 'seed\n')
  runGit(worktree, ['add', 'seed.txt'])
  runGit(worktree, ['commit', '--quiet', '-m', 'seed'])
  const canonicalWorktree = runGit(worktree, ['rev-parse', '--show-toplevel'])
  fs.writeFileSync(path.join(dataRoot, 'overlay', 'attached-worktrees.txt'), `${canonicalWorktree}\n`)
  fs.writeFileSync(path.join(dataRoot, 'overlay', 'do-not-auto-attach.txt'), '')
  runGit(worktree, ['config', 'ozdqp.localOverlaySource', packageRoot])
  runGit(worktree, ['config', 'ozdqp.skillWatchWorkspace', dataRoot])
  runGit(worktree, ['config', 'ozdqp.skillHubAutoAttach', 'false'])
  runGit(worktree, ['config', 'ozdqp.skillWatchEnabled', 'true'])
  runGit(worktree, ['config', 'core.hooksPath', hookRoot])

  const env = { ...process.env, SKILL_GRAFT_HOME: dataRoot, HOOK_FAKE_LOG: log }
  delete env.HUB_ROOT
  const checkout = spawnSync('git', ['-C', worktree, 'checkout', '--quiet', '-b', 'hook-probe'], {
    encoding: 'utf8', env, windowsHide: true
  })
  assert.equal(checkout.status, 0, checkout.stderr)
  const update = spawnSync('git', [
    '-C', worktree, 'update-ref', 'refs/heads/transaction-probe', 'HEAD'
  ], { encoding: 'utf8', env, windowsHide: true })
  assert.equal(update.status, 0, update.stderr)

  const calls = fs.readFileSync(log, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line))
  const repair = calls.find((call) => call.args[0] === 'repair-links')
  const ingest = calls.find((call) => call.args[0] === 'ingest'
    && call.stdin.includes('refs/heads/transaction-probe'))
  assert.deepEqual(repair.args, ['repair-links', '--worktree', canonicalWorktree])
  assert.deepEqual(ingest.args, ['ingest', '--game-repo', canonicalWorktree, '--dispatch'])
  assert.match(ingest.stdin, /refs\/heads\/transaction-probe/)
  for (const call of [repair, ingest]) {
    assert.equal(path.resolve(call.packageEntry), path.resolve(cli))
    assert.equal(path.resolve(call.skillGraftHome), path.resolve(dataRoot))
    assert.equal(path.resolve(call.hubRoot), path.resolve(dataRoot))
  }

  fs.rmSync(log, { force: true })
  const configuredEnv = { ...process.env, HOOK_FAKE_LOG: log }
  for (const key of Object.keys(configuredEnv)) {
    if (key.toUpperCase() === 'SKILL_GRAFT_HOME' || key.toUpperCase() === 'HUB_ROOT') delete configuredEnv[key]
  }
  const configuredCheckout = spawnSync('git', ['-C', worktree, 'checkout', '--quiet', '-b', 'configured-root-probe'], {
    encoding: 'utf8', env: configuredEnv, windowsHide: true
  })
  assert.equal(configuredCheckout.status, 0, configuredCheckout.stderr)
  const configuredUpdate = spawnSync('git', [
    '-C', worktree, 'update-ref', 'refs/heads/configured-root-transaction', 'HEAD'
  ], { encoding: 'utf8', env: configuredEnv, windowsHide: true })
  assert.equal(configuredUpdate.status, 0, configuredUpdate.stderr)
  const configuredCalls = fs.readFileSync(log, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line))
  assert.ok(configuredCalls.some((call) => call.args[0] === 'repair-links'))
  assert.ok(configuredCalls.some((call) => call.args[0] === 'ingest'))
  for (const call of configuredCalls) {
    assert.equal(path.resolve(call.skillGraftHome), path.resolve(dataRoot))
    assert.equal(path.resolve(call.hubRoot), path.resolve(dataRoot))
  }

  fs.rmSync(log, { force: true })
  const conflictEnv = {
    ...configuredEnv,
    SKILL_GRAFT_HOME: dataRoot,
    HUB_ROOT: path.join(root, 'conflicting data root')
  }
  const conflictCheckout = spawnSync('git', ['-C', worktree, 'checkout', '--quiet', '-b', 'conflicting-root-probe'], {
    encoding: 'utf8', env: conflictEnv, windowsHide: true
  })
  assert.equal(conflictCheckout.status, 0, conflictCheckout.stderr)
  assert.equal(fs.existsSync(log), false, 'conflicting data-root aliases must make hooks fail closed before CLI launch')
})
