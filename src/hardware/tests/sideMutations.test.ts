import { afterEach, expect, it, vi } from 'vitest'
import { _resetFirmwareSynced, _resetMutationStamps, getLastSideMutationAt, hasFirmwareSynced } from '../sideMutations'

afterEach(() => {
  _resetMutationStamps()
  _resetFirmwareSynced()
  vi.useRealTimers()
})

it('shares the first-sync flag with an independently loaded DAC-side module instance', async () => {
  _resetFirmwareSynced()
  expect(hasFirmwareSynced()).toBe(false)
  vi.resetModules()
  const dacModule = await import('../sideMutations')
  dacModule.markFirmwareSynced()

  expect(hasFirmwareSynced()).toBe(true)
})

it('shares route mutations with an independently loaded DAC-side module instance', async () => {
  _resetMutationStamps()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-05T02:39:00Z'))
  vi.resetModules()
  const routeModule = await import('../sideMutations')
  routeModule.markSideMutated('left')

  expect(getLastSideMutationAt('left')).toBe(Date.now())
  expect(getLastSideMutationAt('right')).toBe(0)
})
