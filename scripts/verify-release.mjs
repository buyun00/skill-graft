import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const panelRoot = path.join(packageRoot, 'panel')
const outRoot = path.join(panelRoot, 'out')
const webRoot = path.join(packageRoot, 'web')

function runNode(script) {
  const result = spawnSync(process.execPath, [script], {
    cwd: packageRoot,
    env: process.env,
    stdio: 'inherit',
    shell: false
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status || 1)
}

function assertPlainDirectory(root, label) {
  if (!fs.existsSync(root)) throw new Error(`missing ${label}: ${root}`)
  const stat = fs.lstatSync(root)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a plain directory`)
}

function inventory(root, relative = '', result = new Map()) {
  for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
    const childRelative = relative ? path.join(relative, name) : name
    const absolute = path.join(root, childRelative)
    const stat = fs.lstatSync(absolute)
    if (stat.isSymbolicLink()) throw new Error(`release tree contains a symbolic link: ${childRelative}`)
    if (stat.isDirectory()) {
      inventory(root, childRelative, result)
      continue
    }
    if (!stat.isFile()) throw new Error(`release tree contains an unsupported entry: ${childRelative}`)
    const canonical = childRelative.replaceAll(path.sep, '/')
    result.set(canonical, {
      bytes: stat.size,
      digest: crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')
    })
  }
  return result
}

function assertSameTree(expectedRoot, actualRoot) {
  const expected = inventory(expectedRoot)
  const actual = inventory(actualRoot)
  const paths = [...new Set([...expected.keys(), ...actual.keys()])].sort()
  const mismatches = paths.filter((entry) => {
    const left = expected.get(entry)
    const right = actual.get(entry)
    return !left || !right || left.bytes !== right.bytes || left.digest !== right.digest
  })
  if (mismatches.length > 0) {
    throw new Error(`web release is stale or incomplete: ${mismatches.slice(0, 8).join(', ')}`)
  }
  return actual
}

assertPlainDirectory(outRoot, 'panel/out')
assertPlainDirectory(webRoot, 'web')
runNode(path.join(panelRoot, 'scripts', 'verify-out.mjs'))
const shipped = assertSameTree(outRoot, webRoot)

const cli = path.join(packageRoot, 'dist', 'control', 'cli.js')
if (!fs.existsSync(cli) || !fs.lstatSync(cli).isFile() || fs.lstatSync(cli).isSymbolicLink()) {
  throw new Error('release dist/control/cli.js is missing or unsafe')
}

console.log(`verified release dist and ${shipped.size} canonical web files`)
