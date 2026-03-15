/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep native modules external — resolved from node_modules at runtime
  // so the correct platform binary (linux-arm64 on pod) is used
  serverExternalPackages: ['better-sqlite3'],
  turbopack: {
    rules: {
      '*.po': {
        loaders: ['@lingui/loader'],
        as: '*.js',
      },
    },
  },
  reactCompiler: false,
}

export default nextConfig
