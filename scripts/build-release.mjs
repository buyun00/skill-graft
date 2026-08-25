import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const npmExecPath = String(process.env.npm_execpath || (process.platform === 'win32'
  ? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  : ''))
const npmCommand = npmExecPath ? process.execPath : 'npm'
const npmPrefixArgs = npmExecPath ? [npmExecPath] : []

function run(args, cwd = packageRoot) {
  const result = spawnSync(npmCommand, [...npmPrefixArgs, ...args], {
    cwd,
    env: process.env,
    stdio: 'inherit',
    shell: false
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status || 1)
}

run(['run', 'build'])
run(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], path.join(packageRoot, 'panel'))
run(['run', 'export:web'], path.join(packageRoot, 'panel'))
run(['run', 'verify:release'])
