/** @type {import('next').NextConfig} */
const nextConfig = {
  // Source maps for debugging production crashes
  productionBrowserSourceMaps: true,
  // Keep native modules external — resolved from node_modules at runtime
  // so the correct platform binary (linux-arm64 on pod) is used
  serverExternalPackages: ['better-sqlite3'],
  reactCompiler: false,
}

export default nextConfig
