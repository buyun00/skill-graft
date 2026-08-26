import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const PANEL_BUILD_INPUTS = [
  'lib',
  'src',
  'next.config.mjs',
  'package-lock.json',
  'package.json',
  'postcss.config.mjs',
  'tailwind.config.ts',
  'tsconfig.json'
]

function buildInputFiles(relative, files) {
  const absolute = path.join(__dirname, relative)
  const stat = fs.lstatSync(absolute)
  if (stat.isSymbolicLink()) throw new Error(`panel build input must not be a symbolic link: ${relative}`)
  if (stat.isFile()) {
    files.push(relative.replaceAll(path.sep, '/'))
    return
  }
  if (!stat.isDirectory()) throw new Error(`unsupported panel build input: ${relative}`)
  for (const name of fs.readdirSync(absolute).sort()) {
    buildInputFiles(path.join(relative, name), files)
  }
}

export function panelBuildId() {
  const files = []
  for (const input of PANEL_BUILD_INPUTS) buildInputFiles(input, files)
  files.sort()
  const digest = crypto.createHash('sha256')
  for (const relative of files) {
    digest.update(relative, 'utf8')
    digest.update('\0')
    digest.update(fs.readFileSync(path.join(__dirname, relative)))
    digest.update('\0')
  }
  return `p4-${digest.digest('hex').slice(0, 32)}`
}

const isDev = process.env.NODE_ENV !== 'production'

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(isDev ? {} : { output: 'export' }),
  trailingSlash: false,
  images: { unoptimized: true },
  generateBuildId: async () => panelBuildId(),
}

if (isDev) {
  nextConfig.rewrites = async () => [
    { source: '/api/:path*', destination: 'http://127.0.0.1:18765/api/:path*' }
  ]
}

export default nextConfig
