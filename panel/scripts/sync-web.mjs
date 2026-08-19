import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const src = path.resolve(__dirname, '..', 'out')
const dest = path.resolve(__dirname, '..', '..', 'web')

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const name of fs.readdirSync(from)) {
    const a = path.join(from, name)
    const b = path.join(to, name)
    if (fs.statSync(a).isDirectory()) copyDir(a, b)
    else fs.copyFileSync(a, b)
  }
}

if (!fs.existsSync(src)) {
  console.error('missing panel/out — run next build first')
  process.exit(1)
}

fs.mkdirSync(dest, { recursive: true })
for (const name of fs.readdirSync(dest)) {
  fs.rmSync(path.join(dest, name), { recursive: true, force: true })
}
copyDir(src, dest)
console.log(`exported ${src} -> ${dest}`)
