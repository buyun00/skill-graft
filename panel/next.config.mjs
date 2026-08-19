import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

function glassSrcDir() {
  try {
    return path.join(path.dirname(require.resolve('graft-glass-ui/package.json')), 'src')
  } catch {
    return path.resolve(__dirname, '../../graft-glass-ui/src')
  }
}

const isDev = process.env.NODE_ENV !== 'production'

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(isDev ? {} : { output: 'export' }),
  trailingSlash: false,
  images: { unoptimized: true },
  transpilePackages: ['graft-glass-ui'],
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      '@': glassSrcDir()
    }
    return config
  }
}

if (isDev) {
  nextConfig.rewrites = async () => [
    { source: '/api/:path*', destination: 'http://127.0.0.1:18765/api/:path*' }
  ]
}

export default nextConfig
