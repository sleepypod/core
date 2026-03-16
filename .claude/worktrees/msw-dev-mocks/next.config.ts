import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  serverExternalPackages: ['node-schedule', 'better-sqlite3'],
  // Serve the MSW service worker script directly without the locale-prefix redirect
  // that [lang] dynamic routing applies to unrecognised path segments.
  async rewrites() {
    return [
      {
        source: '/mockServiceWorker.js',
        destination: '/mockServiceWorker.js',
        // basePath: false ensures this is matched before locale routing
      },
    ]
  },
  turbopack: {
    root: __dirname,
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
