import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const dshRoot = path.resolve(process.env.DSH_SOURCE_ROOT || 'E:\\deepseek-harness-master')
const packageJson = JSON.parse(fs.readFileSync(path.join(dshRoot, 'package.json'), 'utf8'))
if (packageJson.name !== '@deepseek-ai/dsh-root' || packageJson.version !== '0.1.0-rc.5') {
  throw new Error('P8 Agent smoke requires the reviewed DSH 0.1.0-rc.5 source tree')
}

const targetRoot = path.join(dshRoot, 'packages', 'core', 'agent-loop', 'tests')
const driverTarget = path.join(targetRoot, 'skill-graft-p8-agent-driver.temp.ts')
const specTarget = path.join(targetRoot, 'skill-graft-p8-agent-driver.temp.spec.ts')
for (const target of [driverTarget, specTarget]) {
  if (fs.existsSync(target)) throw new Error(`refusing to overwrite existing DSH test file: ${target}`)
}

try {
  fs.copyFileSync(path.join(repoRoot, 'packages', 'host-dsh', 'src', 'agent-driver.ts'), driverTarget)
  fs.copyFileSync(path.join(repoRoot, 'test', 'real', 'dsh', 'p8-agent-driver-smoke.spec.ts'), specTarget)
  execFileSync(process.execPath, [
    path.join(dshRoot, 'node_modules', 'vitest', 'vitest.mjs'),
    'run',
    'packages/core/agent-loop/tests/skill-graft-p8-agent-driver.temp.spec.ts'
  ], { cwd: dshRoot, stdio: 'inherit' })
} finally {
  for (const target of [specTarget, driverTarget]) fs.rmSync(target, { force: true })
}
