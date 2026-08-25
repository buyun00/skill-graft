import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = path.join(repoRoot, 'packages', 'host-dsh')
const stageRoot = path.join(repoRoot, '.artifacts-local', 'dsh-package')
const allowedStage = path.join(repoRoot, '.artifacts-local')
const relativeStage = path.relative(allowedStage, stageRoot)
if (!relativeStage || relativeStage.startsWith('..') || path.isAbsolute(relativeStage)) {
  throw new Error('refusing to replace an unbounded DSH staging directory')
}
fs.rmSync(stageRoot, { recursive: true, force: true })
fs.mkdirSync(path.join(stageRoot, 'lib'), { recursive: true })
for (const relative of ['package.json', 'cordis.patch.yml', 'overlay']) {
  fs.cpSync(path.join(sourceRoot, relative), path.join(stageRoot, relative), { recursive: true })
}

await build({
  entryPoints: [path.join(sourceRoot, 'src', 'index.ts')],
  outfile: path.join(stageRoot, 'lib', 'index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  external: ['@deepseek-ai/*'],
  legalComments: 'none'
})

await build({
  entryPoints: [path.join(sourceRoot, 'src', 'client.ts')],
  outfile: path.join(stageRoot, 'lib', 'client.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  external: ['react', 'react/*'],
  legalComments: 'none',
  banner: {
    js: 'window.__ModuleLoader__.load({\n  id: "@ozdqp/skill-graft-dsh",\n  factory: (require) => {\n    var module = { exports: {} };\n    var exports = module.exports;'
  },
  footer: {
    js: '    return module.exports;\n  }\n});'
  }
})

const sourcePackage = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8'))
fs.writeFileSync(path.join(stageRoot, 'build-manifest.json'), `${JSON.stringify({
  schemaVersion: 1,
  package: sourcePackage.name,
  version: sourcePackage.version,
  contractEntry: 'shared Application.commandBus',
  host: 'dsh',
  localDependencies: [],
  files: ['lib/index.js', 'lib/client.js', 'cordis.patch.yml', 'overlay/README.md', 'overlay/hooks/.keep']
}, null, 2)}\n`, 'utf8')

console.log(stageRoot)
