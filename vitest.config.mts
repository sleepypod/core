import { fileURLToPath } from 'node:url'
import { lingui } from '@lingui/vite-plugin'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [tsconfigPaths(), react({
    babel: {
      plugins: ['@lingui/babel-plugin-lingui-macro'],
    },
  }), lingui()],
  resolve: {
    alias: {
      // The `mqtt` npm package is added by sleepypod-core-28 (frontend PR).
      // Until that lands, alias it to a local test stub so the bridge module
      // is resolvable under vitest. Tests then layer vi.mock('mqtt') on top
      // to control behaviour.
      mqtt: fileURLToPath(new URL('./src/streaming/tests/__stubs__/mqtt.ts', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    reporters: ['junit', 'verbose'],
    outputFile: {
      junit: process.env.VITEST_JUNIT_OUTPUT || 'test-results/junit.xml',
    },
    coverage: {
      provider: 'v8',
    },
    name: 'unit',
    exclude: ['.claude/worktrees/**', 'node_modules/**'],
  },
})
