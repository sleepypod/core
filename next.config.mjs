import { existsSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { PHASE_PRODUCTION_BUILD } from 'next/constants.js'
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
  // Always inline the demo flag (even when unset) so pod builds can drop
  // src/demo/ as dead code instead of leaving a runtime env lookup.
  env: { NEXT_PUBLIC_DEMO: process.env.NEXT_PUBLIC_DEMO ?? '' },
  // Standalone output for cross-machine deploys (build on macOS, run on pod).
  // Turbopack bakes RELATIVE_ROOT_PATH at build time — without standalone,
  // the .next bundle only works on the machine that built it.
  output: 'standalone',
  outputFileTracingIncludes: {
    '/api/biometrics/watch-upload': ['./scripts/import-watch-health.py', './scripts/sleep-stage-dataset.py'],
  },
  // Keep native modules external — resolved from node_modules at runtime
  // so the correct platform binary (linux-arm64 on pod) is used.
  // hap-nodejs is included because its module-evaluation side effects
  // (HAPStorage / mDNS init) crash Next.js's page-data worker with EBADF.
  serverExternalPackages: ['better-sqlite3', 'mqtt', 'hap-nodejs', 'dbus-next'],
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
        enableBundleAnalysis: process.env.GITHUB_ACTIONS === 'true',
        bundleName: 'sleepypod-core',
        oidc: { useGitHubOIDC: true },
        gitService: 'github',
        webpack: options.webpack,
      }),
    )
    return config
  },
  reactCompiler: false,
}

// next build empties .next before compiling, and the Pod's 2GB of RAM can't
// finish the build — an on-Pod build deletes .next/standalone/server.js and
// leaves the service with nothing to start. /etc/sleepypod/data-dir is
// written by scripts/install, so it only exists on an installed Pod.
const onPod = existsSync('/etc/sleepypod/data-dir')

export default function config(phase) {
  if (phase === PHASE_PRODUCTION_BUILD && onPod && process.env.SP_ALLOW_POD_BUILD !== '1') {
    throw new Error(
      'Refusing to run next build on the Pod: it would delete the installed build and cannot finish in 2GB of RAM. '
      + 'Build on a computer with ./scripts/deploy POD_IP, or install a release with sp-update. '
      + 'Set SP_ALLOW_POD_BUILD=1 to override.',
    )
  }
  return nextConfig
}
