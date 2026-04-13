/** @type {import('next').NextConfig} */
const nextConfig = {
  // Source maps for debugging production crashes
  productionBrowserSourceMaps: true,
  // Standalone output for cross-machine deploys (build on macOS, run on pod).
  // Turbopack bakes RELATIVE_ROOT_PATH at build time — without standalone,
  // the .next bundle only works on the machine that built it.
  output: 'standalone',
  // Keep native modules external — resolved from node_modules at runtime
  // so the correct platform binary (linux-arm64 on pod) is used
  serverExternalPackages: ['better-sqlite3'],
  turbopack: {
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
  webpack: (config) => {
    // Lingui .po file loader for webpack builds
    config.module.rules.push({
      test: /\.po$/,
      use: ['@lingui/loader'],
    })
    return config
  },
  reactCompiler: false,
}

export default nextConfig
