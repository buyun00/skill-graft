import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import * as publicApi from '../dist/index.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = path.join(repoRoot, 'src')
const sharedLayers = ['contracts', 'core', 'application']
const allowedDependencies = {
  contracts: new Set(['contracts']),
  core: new Set(['contracts', 'core']),
  application: new Set(['contracts', 'core', 'application'])
}
const forbiddenModule = /(adapters?|local|control|server|panel|cordis|dsh|deepseek|codex|react|powershell|child[_-]?process)/i
const forbiddenIdentifiers = new Set(['process', 'Buffer', 'fetch'])

function sourceFiles(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(root, entry.name)
    return entry.isDirectory() ? sourceFiles(absolute) : entry.name.endsWith('.ts') ? [absolute] : []
  })
}

function relativeName(file) {
  return path.relative(repoRoot, file).replaceAll('\\', '/')
}

function sharedLayerOf(file) {
  const relative = path.relative(sourceRoot, file)
  return relative.split(path.sep)[0]
}

function resolveTypeScriptModule(importer, specifier) {
  const raw = path.resolve(path.dirname(importer), specifier)
  const candidates = [
    raw,
    raw.replace(/\.js$/i, '.ts'),
    `${raw}.ts`,
    path.join(raw, 'index.ts')
  ]
  return candidates.find((candidate) => existsSync(candidate)) || null
}

function moduleSpecifiers(sourceFile) {
  const values = []
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      values.push(node.moduleSpecifier.text)
    } else if (ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression
      && ts.isStringLiteralLike(node.moduleReference.expression)) {
      values.push(node.moduleReference.expression.text)
    } else if (ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || ts.isIdentifier(node.expression) && node.expression.text === 'require')
      && node.arguments[0]
      && ts.isStringLiteralLike(node.arguments[0])) {
      values.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return values
}

test('contracts/core/application import graph is host-neutral and follows layer direction', () => {
  const files = sharedLayers.flatMap((layer) => sourceFiles(path.join(sourceRoot, layer)))
  assert.ok(files.length >= 10, 'expected the shared source graph to be present')
  const violations = []
  let importCount = 0

  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const fromLayer = sharedLayerOf(file)
    for (const specifier of moduleSpecifiers(sourceFile)) {
      importCount += 1
      if (specifier.startsWith('node:')) {
        violations.push(`${relativeName(file)} imports Node builtin ${specifier}`)
        continue
      }
      if (forbiddenModule.test(specifier)) {
        violations.push(`${relativeName(file)} imports forbidden host module ${specifier}`)
      }
      if (!specifier.startsWith('.')) {
        violations.push(`${relativeName(file)} imports external module ${specifier}`)
        continue
      }
      const resolved = resolveTypeScriptModule(file, specifier)
      if (!resolved) {
        violations.push(`${relativeName(file)} has unresolved import ${specifier}`)
        continue
      }
      const targetLayer = sharedLayerOf(resolved)
      if (!sharedLayers.includes(targetLayer)) {
        violations.push(`${relativeName(file)} escapes shared source graph via ${specifier}`)
      } else if (!allowedDependencies[fromLayer].has(targetLayer)) {
        violations.push(`${relativeName(file)} violates ${fromLayer} dependency direction via ${specifier}`)
      }
    }
  }

  assert.ok(importCount > 0, 'expected imports in the shared source graph')
  assert.deepEqual(violations, [])
})

test('shared runtime AST has no process, Buffer, or fetch dependency', () => {
  const files = sharedLayers.flatMap((layer) => sourceFiles(path.join(sourceRoot, layer)))
  const violations = []

  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    function visit(node) {
      if (ts.isIdentifier(node) && forbiddenIdentifiers.has(node.text)) {
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
        violations.push(`${relativeName(file)}:${position.line + 1} uses ${node.text}`)
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }

  assert.deepEqual(violations, [])
})

test('Application uses declared ports without HubContext, ctx access, or host I/O modules', () => {
  const files = sourceFiles(path.join(sourceRoot, 'application'))
  const violations = []

  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    for (const specifier of moduleSpecifiers(sourceFile)) {
      if (/^\.\.\/core\/(?:decide|ingest|inventory|repair|status|worktrees|shared-hub-operations|ports)\.js$/.test(specifier)) {
        violations.push(`${relativeName(file)} imports effectful Core module ${specifier}`)
      }
    }
    function visit(node) {
      if (ts.isIdentifier(node) && node.text === 'HubContext') {
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
        violations.push(`${relativeName(file)}:${position.line + 1} refers to HubContext`)
      }
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'ctx') {
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
        violations.push(`${relativeName(file)}:${position.line + 1} accesses ctx.${node.name.text}`)
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }

  assert.deepEqual(violations, [])

  const application = readFileSync(path.join(sourceRoot, 'application', 'hub-application.ts'), 'utf8')
  assert.doesNotMatch(application, /instanceof Error|String\(error\)|\.test\(message\)/)
  assert.match(application, /portFaultError\(error\)/)
})

test('public root exposes contracts/composition but no legacy Core business or session internals', () => {
  const sourcePath = path.join(sourceRoot, 'index.ts')
  const sourceText = readFileSync(sourcePath, 'utf8')
  const sourceFile = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const forbiddenModules = new Set([
    './core/index.js',
    './core/decide.js',
    './core/ingest.js',
    './core/inventory.js',
    './core/repair.js',
    './core/status.js',
    './core/worktrees.js',
    './local/session/legacy-sessions.js',
    './local/session/types.js'
  ])
  assert.deepEqual(moduleSpecifiers(sourceFile).filter((specifier) => forbiddenModules.has(specifier)), [])

  const forbiddenExports = [
    'cloneRootFromCommonDir',
    'decide',
    'enqueueSession',
    'extractCodexSessionId',
    'extractSuggestion',
    'finalizeSession',
    'findSession',
    'gameRepoOf',
    'getStatus',
    'ingest',
    'isClientCheckout',
    'isEphemeralPath',
    'listSessions',
    'listSkills',
    'listWorktrees',
    'markSessionSpawned',
    'parseWorktreePorcelain',
    'presentSession',
    'reapSessions',
    'repairLinks',
    'repairPlan',
    'sessionExitFile'
  ]
  assert.deepEqual(forbiddenExports.filter((name) => Object.hasOwn(publicApi, name)), [])
  assert.equal(typeof publicApi.createHubApplication, 'function')
  assert.equal(typeof publicApi.createLocalHost, 'function')
  assert.equal(publicApi.CONTRACT_VERSION, 1)

  const declaration = readFileSync(path.join(repoRoot, 'dist', 'index.d.ts'), 'utf8')
  assert.doesNotMatch(declaration, /\bHubSession\b|from ['"]\.\/core\/index\.js['"]|local\/session\/legacy-sessions/)
  assert.doesNotMatch(declaration, /HubOperationsPort|createSharedHubOperations|shared-hub-operations/)
  assert.equal(existsSync(path.join(sourceRoot, 'core', 'shared-hub-operations.ts')), false)
})

test('Local composition supplies query and low-level ports without a host use-case factory', () => {
  const adapterPath = path.join(sourceRoot, 'adapters', 'local-application-ports.ts')
  const text = readFileSync(adapterPath, 'utf8')
  const sourceFile = ts.createSourceFile(adapterPath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  assert.ok(moduleSpecifiers(sourceFile).includes('./local-query-port.js'))
  assert.ok(moduleSpecifiers(sourceFile).includes('./local-use-case-ports.js'))
  assert.doesNotMatch(text, /shared-hub-operations|createSharedHubOperations|HubOperationsPort/)
  assert.match(text, /const queries\s*=\s*createLocalQueryPort\(context\)/)
  assert.match(text, /useCases:\s*createLocalUseCasePorts\(context\)/)
  assert.match(text, /legacyAttach:\s*createLocalLegacyAttachPort\(context, queries\.inspectWorktree,\s*\{/)
  assert.doesNotMatch(text, /from ['"]\.\.\/core\/(?:decide|ingest|inventory|repair|status|worktrees)\.js['"]/)
  assert.doesNotMatch(text, /\b(?:decide|ingest|repairLegacy)\s*\(/)

  const genericAdapter = readFileSync(path.join(sourceRoot, 'adapters', 'local-use-case-ports.ts'), 'utf8')
  assert.doesNotMatch(genericAdapter, /\b(?:adopt|merge|reject)\b/i)
  assert.doesNotMatch(genericAdapter, /(?:decision-plan|ingest-plan|policies)\.js/)

  const queryAdapter = readFileSync(path.join(sourceRoot, 'adapters', 'local-query-port.ts'), 'utf8')
  assert.match(queryAdapter, /readStatusFacts/)
  assert.match(queryAdapter, /listSkillFacts/)
  assert.match(queryAdapter, /readWorktreeFacts/)
  assert.doesNotMatch(queryAdapter, /recognizeWorktree|project(?:HubStatus|SkillInventory|WorktreeList)/)

  const queryCore = readFileSync(path.join(sourceRoot, 'core', 'query-projections.ts'), 'utf8')
  assert.match(queryCore, /recognizeWorktree/)
  assert.match(queryCore, /projectHubStatus/)
  assert.match(queryCore, /projectSkillInventory/)
  assert.match(queryCore, /projectWorktreeList/)
})

test('Core runtime is pure and contains no broad host context or direct I/O capability access', () => {
  const violations = []
  for (const file of sourceFiles(path.join(sourceRoot, 'core'))) {
    const text = readFileSync(file, 'utf8')
    if (/HubContext|LocalHostContext|\bctx\b|\.(?:fs|persist|link)\b/.test(text)) {
      violations.push(relativeName(file))
    }
  }
  assert.deepEqual(violations, [])
})

test('tsconfig.shared includes only shared layers and compiles without ambient Node types', () => {
  const configPath = path.join(repoRoot, 'tsconfig.shared.json')
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  assert.deepEqual(config.compilerOptions.types, [])
  assert.deepEqual([...config.include].sort(), [
    'src/application/**/*.ts',
    'src/contracts/**/*.ts',
    'src/core/**/*.ts'
  ])

  const tscPath = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc')
  const result = spawnSync(process.execPath, [tscPath, '-p', configPath], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true
  })
  assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join('\n'))
})
