import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const readOnlyGitEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0' }

function gitStatus() {
  const result = spawnSync('git', ['--no-optional-locks', 'status', '--short', '--untracked-files=all'], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
    env: readOnlyGitEnv
  })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'git status failed')
  return result.stdout.replaceAll('\r\n', '\n')
}

function runNode(args, env) {
  return spawnSync(process.execPath, args, {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    windowsHide: true
  })
}

function writeResult(result) {
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
}

async function startIsolatedApi() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-graft-default-api-'))
  const readyFile = path.join(root, 'port.txt')
  const code = [
    "const fs = require('node:fs')",
    "const http = require('node:http')",
    'const readyFile = process.argv[1]',
    "const server = http.createServer((_req, res) => { res.statusCode = 503; res.setHeader('content-type', 'application/json'); res.end('{\"ok\":false,\"isolated\":true}') })",
    "server.listen(0, '127.0.0.1', () => fs.writeFileSync(readyFile, String(server.address().port)))",
    'const stop = () => server.close(() => process.exit(0))',
    "process.on('SIGTERM', stop)",
    "process.on('SIGINT', stop)"
  ].join('; ')
  const child = spawn(process.execPath, ['-e', code, readyFile], {
    stdio: 'ignore',
    windowsHide: true
  })
  const deadline = Date.now() + 5000
  const waitArray = new Int32Array(new SharedArrayBuffer(4))
  while (!fs.existsSync(readyFile) && child.exitCode == null && Date.now() < deadline) {
    Atomics.wait(waitArray, 0, 0, 20)
  }
  if (!fs.existsSync(readyFile)) {
    try { child.kill('SIGKILL') } catch { /* best effort for this owned child */ }
    fs.rmSync(root, { recursive: true, force: true })
    throw new Error('could not start isolated default-suite API')
  }
  const port = Number(fs.readFileSync(readyFile, 'utf8'))
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    try { child.kill('SIGKILL') } catch { /* best effort for this owned child */ }
    fs.rmSync(root, { recursive: true, force: true })
    throw new Error('isolated default-suite API returned an invalid port')
  }
  const forceStop = () => {
    if (child.exitCode == null && child.signalCode == null) {
      try { child.kill('SIGKILL') } catch { /* best effort for this owned child */ }
    }
    fs.rmSync(root, { recursive: true, force: true })
  }
  return {
    port,
    forceStop,
    async stop() {
      if (child.exitCode == null && child.signalCode == null) {
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            try { child.kill('SIGKILL') } catch { /* best effort for this owned child */ }
          }, 1500)
          child.once('exit', () => {
            clearTimeout(timer)
            resolve()
          })
          try { child.kill('SIGTERM') } catch { resolve() }
        })
      }
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
}

function fileFingerprint(file) {
  if (!fs.existsSync(file)) return { exists: false }
  const stat = fs.statSync(file)
  if (!stat.isFile()) return { exists: true, type: 'non-file' }
  return {
    exists: true,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    sha256: fileSha256(file)
  }
}

function fileSha256(file) {
  const hash = crypto.createHash('sha256')
  const descriptor = fs.openSync(file, 'r')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  try {
    for (;;) {
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null)
      if (bytes === 0) break
      hash.update(buffer.subarray(0, bytes))
    }
  } finally {
    fs.closeSync(descriptor)
  }
  return hash.digest('hex')
}

function treeFingerprint(root) {
  if (!fs.existsSync(root)) return { exists: false, entries: [] }
  const entries = []
  const visit = (dir, relativeRoot = '') => {
    const children = fs.readdirSync(dir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const child of children) {
      const full = path.join(dir, child.name)
      const relative = path.join(relativeRoot, child.name).replaceAll('\\', '/')
      const stat = fs.lstatSync(full)
      if (stat.isSymbolicLink()) {
        entries.push({ path: relative, type: 'link', realpath: fs.realpathSync.native(full) })
      } else if (stat.isDirectory()) {
        entries.push({ path: relative, type: 'directory' })
        visit(full, relative)
      } else if (stat.isFile()) {
        entries.push({ path: relative, type: 'file', size: stat.size, mtimeMs: stat.mtimeMs, sha256: fileSha256(full) })
      } else {
        entries.push({ path: relative, type: 'other', size: stat.size, mtimeMs: stat.mtimeMs })
      }
    }
  }
  visit(root)
  return { exists: true, entries }
}

function linkFingerprint(target) {
  if (!fs.existsSync(target)) return { exists: false }
  const stat = fs.lstatSync(target)
  return {
    exists: true,
    reparse: stat.isSymbolicLink(),
    realpath: fs.realpathSync.native(target)
  }
}

function protectedFingerprint() {
  const probe = 'E:\\ozdqp-cli-attach-probe'
  const result = {
    liveReview: treeFingerprint(path.join(repoRoot, 'skill-review')),
    liveOverlay: treeFingerprint(path.join(repoRoot, 'overlay')),
    probe: { exists: fs.existsSync(probe) }
  }
  if (!result.probe.exists) return result
  const git = spawnSync('git', ['--no-optional-locks', '-C', probe, 'status', '--porcelain=v1', '--untracked-files=all'], {
    encoding: 'utf8',
    windowsHide: true,
    env: readOnlyGitEnv
  })
  const head = spawnSync('git', ['--no-optional-locks', '-C', probe, 'rev-parse', 'HEAD'], {
    encoding: 'utf8', windowsHide: true, env: readOnlyGitEnv
  })
  const index = spawnSync('git', ['--no-optional-locks', '-C', probe, 'rev-parse', '--git-path', 'index'], {
    encoding: 'utf8', windowsHide: true, env: readOnlyGitEnv
  })
  const stage = spawnSync('git', ['--no-optional-locks', '-C', probe, 'ls-files', '--stage', '-z'], {
    encoding: 'utf8',
    windowsHide: true,
    env: readOnlyGitEnv,
    maxBuffer: 64 * 1024 * 1024
  })
  const visibility = spawnSync('git', ['--no-optional-locks', '-C', probe, 'ls-files', '-v', '-z'], {
    encoding: 'utf8',
    windowsHide: true,
    env: readOnlyGitEnv,
    maxBuffer: 64 * 1024 * 1024
  })
  const indexPath = index.status === 0
    ? (path.isAbsolute(index.stdout.trim()) ? index.stdout.trim() : path.resolve(probe, index.stdout.trim()))
    : ''
  result.probe = {
    exists: true,
    gitStatus: git.status === 0 ? git.stdout.replaceAll('\r\n', '\n') : `git-error:${git.status}`,
    head: head.status === 0 ? head.stdout.trim() : `git-error:${head.status}`,
    index: indexPath ? fileFingerprint(indexPath) : { exists: false, error: `git-error:${index.status}` },
    stageSha256: stage.status === 0 ? crypto.createHash('sha256').update(stage.stdout).digest('hex') : `git-error:${stage.status}`,
    visibilitySha256: visibility.status === 0 ? crypto.createHash('sha256').update(visibility.stdout).digest('hex') : `git-error:${visibility.status}`,
    override: fileFingerprint(path.join(probe, 'AGENTS.override.md')),
    resident: ['ozdqp-development', 'ozdqp-ui-development', 'ozdqp-git-workflow']
      .map((name) => [name, linkFingerprint(path.join(probe, '.agents', 'skills', name))])
  }
  return result
}

const before = gitStatus()
const protectedBefore = protectedFingerprint()
const isolatedApi = await startIsolatedApi()
process.once('exit', isolatedApi.forceStop)
const env = { ...process.env }
for (const name of [
  'HUB_ROOT',
  'SKILL_GRAFT_HOME',
  'SKILL_GRAFT_RUN_ID',
  'SKILL_GRAFT_E2E_ROOT',
  'SKILL_GRAFT_REAL_PROBE',
  'SKILL_GRAFT_CLI',
  'DSH_HOME'
]) {
  delete env[name]
}
for (const name of Object.keys(env)) {
  if (/(api.?key|token|secret|credential|password)/i.test(name)) delete env[name]
}
env.SKILL_GRAFT_REAL_E2E = '0'
env.HUB_SPAWN_CODEX = '0'
env.HUB_API_PORT = String(isolatedApi.port)

const tsc = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc')
if (!fs.existsSync(tsc)) {
  process.stderr.write('missing node_modules/typescript; run npm ci before the default suite\n')
  process.exit(1)
}

const build = runNode([tsc, '-p', 'tsconfig.json'], env)
writeResult(build)

const requested = process.argv.slice(2)
const files = requested.length > 0
  ? requested
  : fs.readdirSync(path.join(repoRoot, 'test'))
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
    .map((name) => path.join('test', name))
let tests = { status: 1, stdout: '', stderr: '' }
if (build.status === 0) {
  tests = runNode(['--test', ...files], env)
  writeResult(tests)
}

const after = gitStatus()
const protectedAfter = protectedFingerprint()
if (after !== before) {
  process.stderr.write('default suite changed the repository worktree\n')
  process.stderr.write('--- before\n')
  process.stderr.write(before || '(clean)\n')
  process.stderr.write('--- after\n')
  process.stderr.write(after || '(clean)\n')
}
if (JSON.stringify(protectedAfter) !== JSON.stringify(protectedBefore)) {
  process.stderr.write('default suite changed protected runtime state or the fixed probe\n')
}

const succeeded = (
  build.status === 0
  && tests.status === 0
  && after === before
  && JSON.stringify(protectedAfter) === JSON.stringify(protectedBefore)
)
await isolatedApi.stop()
process.exit(succeeded ? 0 : 1)
