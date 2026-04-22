// @ts-check
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  $schema: './node_modules/@stryker-mutator/core/schema/stryker-schema.json',
  packageManager: 'pnpm',
  // Explicit plugin registration. pnpm's isolated node_modules layout
  // sometimes breaks Stryker's auto-discovery of runner + checker
  // packages — listing them here is deterministic.
  plugins: [
    '@stryker-mutator/vitest-runner',
    '@stryker-mutator/typescript-checker',
  ],
  testRunner: 'vitest',
  testRunner_comment: 'vitest config at vitest.config.mts is picked up automatically',
  vitest: {
    configFile: 'vitest.config.mts',
  },

  // Start narrow: mutate only the modules that have real unit test coverage.
  // Next.js app code (app/, components/, hooks/, utils/) is under-tested
  // and would add hours of wall-clock time to each mutation run without
  // telling us anything useful. Expand once we're confident the report is
  // actionable.
  mutate: [
    'src/services/**/*.ts',
    'src/scheduler/**/*.ts',
    'src/hardware/**/*.ts',
    'src/lib/**/*.ts',
    '!src/**/tests/**',
    '!src/**/*.test.ts',
    '!src/**/*.d.ts',
  ],

  // Skip files that have no test coverage at all — Stryker will flag every
  // mutation as "No coverage", which is noise rather than signal.
  ignoreStatic: true,

  // Type-check each mutant so we don't waste runner cycles on mutants that
  // can't even compile. Matches the project's tsc --noEmit CI step.
  checkers: ['typescript'],
  tsconfigFile: 'tsconfig.json',

  // Concurrency: matches typical GH Actions runner CPU count.
  concurrency: 4,

  // Per-mutant timeout. Default 5s is too tight for services that poll DBs
  // / await setTimeout. Scheduler + autoOffWatcher tests include real
  // timers. 15s is still short relative to test-suite runtime.
  timeoutMS: 15000,
  timeoutFactor: 2,

  // Cache passed mutants across runs so reruns are fast. Stored under
  // reports/mutation/ so local .gitignore already covers it.
  incremental: true,
  incrementalFile: 'reports/mutation/incremental.json',

  reporters: ['html', 'clear-text', 'progress', 'json'],
  htmlReporter: {
    fileName: 'reports/mutation/index.html',
  },
  jsonReporter: {
    fileName: 'reports/mutation/mutation.json',
  },

  // Thresholds are advisory for now; break=null means we never fail CI on
  // low score. Tighten over time as real coverage gaps get closed.
  thresholds: {
    high: 80,
    low: 60,
    break: null,
  },

  tempDirName: '.stryker-tmp',
  cleanTempDir: true,
  disableTypeChecks: '{src,test}/**/*.{js,ts,tsx,jsx}',
}
