import { defineConfig } from '@playwright/test'

if (!process.env.SLEEPYPOD_BROWSER_FIXTURE) throw new Error('Use node tests/browser/run.mjs to create isolated databases')

export default defineConfig({
  testDir: '.',
  testMatch: '*.e2e.ts',
  workers: 1,
  retries: 0,
  reporter: [['list'], ['junit', { outputFile: '../../test-results/browser/junit.xml' }]],
  timeout: 60_000,
  outputDir: '../../test-results/browser',
  use: {
    baseURL: 'http://127.0.0.1:3218',
    locale: 'en-US',
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
    actionTimeout: 15_000,
    viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node .next/standalone/server.js',
    env: { HOSTNAME: '127.0.0.1', PORT: '3218', CI: '1' },
    cwd: '../..',
    url: 'http://127.0.0.1:3218/en/settings',
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
