import fs from 'node:fs'
import path from 'node:path'
import { createRunLayout, validateRealE2eEnvironment } from './real-e2e.mjs'

const protectedRoots = String(process.env.SKILL_GRAFT_PROTECTED_ROOTS || '')
  .split(path.delimiter)
  .map((item) => item.trim())
  .filter(Boolean)
const fixedProbe = 'E:\\ozdqp-cli-attach-probe'
if (fs.existsSync(fixedProbe)) protectedRoots.push(fixedProbe)

const context = validateRealE2eEnvironment(process.env, {
  workspaceRoot: process.cwd(),
  protectedRoots
})
createRunLayout(context)
process.stdout.write(`${JSON.stringify({
  ok: true,
  runId: context.runId,
  runRoot: context.runRoot,
  appRoot: context.appRoot,
  homeRoot: context.homeRoot,
  hubDataRoot: context.hubDataRoot,
  probeRoot: context.probeRoot,
  logsRoot: context.logsRoot,
  markerFile: context.markerFile
}, null, 2)}\n`)
