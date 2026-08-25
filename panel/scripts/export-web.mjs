import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const panelRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const nextBin = require.resolve('next/dist/bin/next')
const env = { ...process.env, NODE_ENV: 'production', HUB_PANEL_EXPORT: '1' }
const build = spawnSync(process.execPath, [nextBin, 'build'], {
  cwd: panelRoot,
  env,
  stdio: 'inherit'
})
if (build.status !== 0) process.exit(build.status || 1)

const verify = spawnSync(process.execPath, [path.join(panelRoot, 'scripts', 'verify-out.mjs')], {
  cwd: panelRoot,
  env,
  stdio: 'inherit'
})
if (verify.status !== 0) process.exit(verify.status || 1)

const sync = spawnSync(process.execPath, [path.join(panelRoot, 'scripts', 'sync-web.mjs')], {
  cwd: panelRoot,
  env,
  stdio: 'inherit'
})
process.exit(sync.status || 0)
