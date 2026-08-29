import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { panelBuildId } from '../next.config.mjs'

const panelRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outRoot = path.join(panelRoot, 'out')

if (!fs.existsSync(outRoot) || !fs.lstatSync(outRoot).isDirectory()) {
  throw new Error('missing panel/out; run the production Next build first')
}

const expectedBuildId = panelBuildId()
const staticRoot = path.join(outRoot, '_next', 'static')
const expectedBuildRoot = path.join(staticRoot, expectedBuildId)
if (!fs.existsSync(expectedBuildRoot) || !fs.lstatSync(expectedBuildRoot).isDirectory()) {
  throw new Error(`production export is not bound to the canonical panel build ID ${expectedBuildId}`)
}
const generatedBuildRoots = fs.readdirSync(staticRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !['chunks', 'css', 'media'].includes(entry.name))
  .map((entry) => entry.name)
  .sort()
if (generatedBuildRoots.length !== 1 || generatedBuildRoots[0] !== expectedBuildId) {
  throw new Error(`production export has unexpected build IDs: ${generatedBuildRoots.join(', ')}`)
}

function filesUnder(root, acc = []) {
  for (const name of fs.readdirSync(root)) {
    const absolute = path.join(root, name)
    const stat = fs.lstatSync(absolute)
    if (stat.isSymbolicLink()) throw new Error(`export contains a symbolic link: ${absolute}`)
    if (stat.isDirectory()) filesUnder(absolute, acc)
    else if (stat.isFile()) acc.push(absolute)
    else throw new Error(`export contains an unsupported entry: ${absolute}`)
  }
  return acc
}

function assertInside(file) {
  const relative = path.relative(outRoot, file)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`export reference escapes panel/out: ${file}`)
  }
}

function assertAsset(owner, reference, absolute) {
  assertInside(absolute)
  if (!fs.existsSync(absolute) || !fs.lstatSync(absolute).isFile()) {
    throw new Error(`${path.relative(outRoot, owner)} references missing asset ${reference}`)
  }
}

const files = filesUnder(outRoot)
const htmlFiles = files.filter((file) => file.endsWith('.html'))
const cssFiles = files.filter((file) => file.endsWith('.css'))
if (htmlFiles.length === 0) throw new Error('production export has no HTML')

for (const html of htmlFiles) {
  const source = fs.readFileSync(html, 'utf8')
  for (const match of source.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const reference = match[1].split(/[?#]/, 1)[0]
    if (!reference.startsWith('/_next/')) continue
    const decoded = decodeURIComponent(reference)
    assertAsset(html, reference, path.resolve(outRoot, decoded.replace(/^\/+/, '')))
  }
}

for (const css of cssFiles) {
  const source = fs.readFileSync(css, 'utf8')
  for (const match of source.matchAll(/url\(([^)]+)\)/g)) {
    const reference = match[1].trim().replace(/^['"]|['"]$/g, '').split(/[?#]/, 1)[0]
    if (!reference || /^(?:data:|https?:|#)/i.test(reference)) continue
    const absolute = reference.startsWith('/')
      ? path.resolve(outRoot, decodeURIComponent(reference).replace(/^\/+/, ''))
      : path.resolve(path.dirname(css), decodeURIComponent(reference))
    assertAsset(css, reference, absolute)
  }
}

const shippedText = files
  .filter((file) => /\.(?:html|js|css)$/.test(file))
  .map((file) => fs.readFileSync(file, 'utf8'))
  .join('\n')
if (!shippedText.includes('/api/product/overview')) throw new Error('production export is missing the product overview endpoint')
if (/graft-glass-ui/i.test(shippedText)) {
  throw new Error('production export contains graft-glass-ui')
}

console.log(`verified ${htmlFiles.length} HTML files and ${files.length} exported files for ${expectedBuildId}`)
