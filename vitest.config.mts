import { fileURLToPath } from 'node:url'
import { lingui } from '@lingui/vite-plugin'
import babel from '@rolldown/plugin-babel'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const serverOnlyTestStub = '\0server-only-test-stub'
const thermalForecastIntegration = 'src/comfort/tests/thermal-forecast-integration.test.ts'
const waveformPublicationIntegration = 'src/biometrics/backtest/tests/waveform-publication.integration.test.ts'
const shellIntegration = ['scripts/tests/diagnosticCli.test.ts', 'scripts/tests/biometricsArchiver.test.ts', 'tests/updateDeploy.test.ts', 'tests/fixtureCommand.test.ts']

export default defineConfig({
  plugins: [{
    name: 'server-only-test-stub',
    enforce: 'pre',
    resolveId(id) {
      if (id === 'server-only') return serverOnlyTestStub
    },
    load(id) {
      if (id === serverOnlyTestStub) return 'export {}'
    },
  }, tsconfigPaths(), react(), babel({
    plugins: ['@lingui/babel-plugin-lingui-macro'],
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
      reporter: ['text', 'lcov', 'json-summary'],
      // Count production files even when no test imports them. Otherwise new,
      // untested components disappear from the coverage denominator entirely.
      include: ['src/**/*.{ts,tsx}', 'app/**/*.{ts,tsx}', 'instrumentation.ts', 'proxy.ts'],
      exclude: ['**/tests/**', '**/*.test.{ts,tsx}', '**/*.d.ts'],
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          exclude: [thermalForecastIntegration, waveformPublicationIntegration, ...shellIntegration],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: 'waveform-publication-integration',
          include: [waveformPublicationIntegration],
          // Real scientific child processes and durable storage should not compete
          // with the coordinator fault-injection suite for the same local budget.
          sequence: { groupOrder: 1 },
          fileParallelism: false,
          maxWorkers: 1,
        },
      },
      {
        extends: true,
        test: {
          name: 'thermal-forecast-integration',
          include: [thermalForecastIntegration],
          // Full-night provenance audits need a worker without competing test files.
          // Keep the existing fixture, timeout and assertions, with shared coverage.
          sequence: { groupOrder: 2 },
          fileParallelism: false,
          maxWorkers: 1,
        },
      },
      {
        extends: true,
        test: {
          name: 'shell-integration',
          include: shellIntegration,
          // Real process bundles have a separate budget; fixtureCommand also kills
          // stalled children after 10s. Unit tests retain their normal 5s limit.
          sequence: { groupOrder: 3 },
          fileParallelism: false,
          maxWorkers: 1,
          environment: 'node',
          testTimeout: 20_000,
        },
      },
    ],
    // Alarm/snooze state is persisted next to the database; keep tests that
    // exercise it without mocking from writing into the repo.
    env: {
      ALARM_STATE_PATH: join(tmpdir(), 'sleepypod-vitest', 'alarm-state.json'),
    },
    // The bedroom publisher's .mjs suites use node:test and run separately.
    exclude: ['.claude/worktrees/**', '.codex/**', '.ygg/worktrees/**', 'node_modules/**', '.next/**', 'scripts/bedroom/*.test.mjs'],
  },
})
