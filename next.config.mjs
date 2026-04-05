/** @type {import('next').NextConfig} */
const nextConfig = {
  // Source maps for debugging production crashes
  productionBrowserSourceMaps: true,
  // Use webpack — Turbopack mangles native module requires with pnpm store
  // hashes that differ between CI (x86_64) and pod (arm64)
  bundler: 'webpack',
  // Keep native modules external — resolved from node_modules at runtime
  // so the correct platform binary (linux-arm64 on pod) is used
  serverExternalPackages: ['better-sqlite3'],
  reactCompiler: false,
}

export default nextConfig
