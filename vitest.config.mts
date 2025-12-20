import { lingui } from '@lingui/vite-plugin'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

const sharedConfig = {
  globals: true,
  environment: 'jsdom',
  coverage: {
    provider: 'v8',
  },
}

export default defineConfig({
  plugins: [tsconfigPaths(), react({
    babel: {
      plugins: ['@lingui/babel-plugin-lingui-macro'],
    },
  }), lingui()],
  test: {
    reporters: ['junit', 'verbose'],
    outputFile: {
      junit: process.env.VITEST_JUNIT_OUTPUT || 'test-results/junit.xml',
    },
    projects: [
      // Unit tests
      {
        test: {
          ...sharedConfig,
          environment: 'jsdom',
          name: 'unit',
        },
      },
    ],
  },
})
