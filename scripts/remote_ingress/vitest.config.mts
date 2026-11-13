import base from '../../vitest.config.mts'

// The real Nginx dependency belongs to this explicit integration gate, never a
// skipped branch in the ordinary unit suite. Missing Nginx is a test failure.
const configuration = {
  ...base,
  test: {
    ...base.test,
    projects: undefined,
    environment: 'node',
    include: ['scripts/remote_ingress/authentication.integration.ts'],
    reporters: ['default'],
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
}

export default configuration
