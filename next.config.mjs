/** @type {import('next').NextConfig} */
const nextConfig = {
  // Source maps for debugging production crashes
  productionBrowserSourceMaps: true,
  // Keep native modules external — resolved from node_modules at runtime
  // so the correct platform binary (linux-arm64 on pod) is used
  serverExternalPackages: ['better-sqlite3'],
  turbopack: {
    // Lingui .po file loader
    rules: {
      '*.po': {
        loaders: ['@lingui/loader'],
        as: '*.js',
      },
    },
    // Force plain require() for native modules — prevents Turbopack from
    // mangling the module name with pnpm virtual store hashes
    resolveAlias: {
      'better-sqlite3': 'better-sqlite3',
    },
  },
  reactCompiler: false,
}

export default nextConfig
