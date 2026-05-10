import { fileURLToPath } from 'url'
import path from 'path'
import { codecovNextJSWebpackPlugin } from '@codecov/nextjs-webpack-plugin'

// Pin Turbopack workspace root so multi-lockfile detection (nested worktrees,
// monorepos) doesn't pick the wrong root and skip standalone output.
const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep production browser source maps off — serving .map files on LAN
  // exposes TypeScript source, API route internals, and file paths.
  // Use server-side-only source maps + a private error monitor for prod debugging.
  productionBrowserSourceMaps: false,
  // Standalone output for cross-machine deploys (build on macOS, run on pod).
  // Turbopack bakes RELATIVE_ROOT_PATH at build time — without standalone,
  // the .next bundle only works on the machine that built it.
  output: 'standalone',
  // Keep native modules external — resolved from node_modules at runtime
  // so the correct platform binary (linux-arm64 on pod) is used.
  // hap-nodejs is included because its module-evaluation side effects
  // (HAPStorage / mDNS init) crash Next.js's page-data worker with EBADF.
  serverExternalPackages: ['better-sqlite3', 'mqtt', 'hap-nodejs'],
  turbopack: {
    root: __dirname,
    // Lingui .po file loader (used in dev mode where Turbopack is active)
    rules: {
      '*.po': {
        loaders: ['@lingui/loader'],
        as: '*.js',
      },
    },
    resolveAlias: {
      'better-sqlite3': 'better-sqlite3',
    },
  },
  webpack: (config, options) => {
    // Lingui .po file loader for webpack builds
    config.module.rules.push({
      test: /\.po$/,
      use: ['@lingui/loader'],
    })
    config.plugins.push(
      codecovNextJSWebpackPlugin({
        enableBundleAnalysis: process.env.CODECOV_TOKEN !== undefined,
        bundleName: 'sleepypod-core',
        uploadToken: process.env.CODECOV_TOKEN,
        gitService: 'github',
        webpack: options.webpack,
      }),
    )
    return config
  },
  reactCompiler: false,
}

export default nextConfig
