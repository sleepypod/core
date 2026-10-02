import { describe, expect, it, vi } from 'vitest'

async function loadMovementBucketSizes() {
  // These constants are evaluated at module load. Reload the module while a
  // static Stryker mutant is active so arithmetic changes remain observable.
  vi.resetModules()
  const { MOVEMENT_BUCKET_DAY_SECONDS, MOVEMENT_BUCKET_WEEK_SECONDS } = await import('../movement')
  return { MOVEMENT_BUCKET_DAY_SECONDS, MOVEMENT_BUCKET_WEEK_SECONDS }
}

describe('movement bucket mutation contract', () => {
  it('pins both bucket sizes after a fresh module import', async () => {
    await expect(loadMovementBucketSizes()).resolves.toEqual({
      MOVEMENT_BUCKET_DAY_SECONDS: 300,
      MOVEMENT_BUCKET_WEEK_SECONDS: 1800,
    })
  })
})
