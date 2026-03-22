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
