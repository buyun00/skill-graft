import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const panelRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const env = { ...process.env, NODE_ENV: 'production', HUB_PANEL_EXPORT: '1' }
const build = spawnSync('npx', ['next', 'build'], {
  cwd: panelRoot,
  env,
  stdio: 'inherit',
  shell: true
})
if (build.status !== 0) process.exit(build.status || 1)

const sync = spawnSync(process.execPath, [path.join(panelRoot, 'scripts', 'sync-web.mjs')], {
  cwd: panelRoot,
  env,
  stdio: 'inherit'
})
process.exit(sync.status || 0)
