import { afterEach, expect, it, vi } from 'vitest'
import { _resetPumpRunEvidence, confirmPumpRun, hasConfirmedPumpRun, _resetFirmwareSynced, _resetMutationStamps, getLastSideMutationAt, hasFirmwareSynced } from '../sideMutations'

afterEach(() => {
  _resetMutationStamps()
  _resetPumpRunEvidence()
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

it('shares startup evidence across modules without depending on wall time', async () => {
  _resetPumpRunEvidence()
  vi.useFakeTimers()
  vi.setSystemTime(100_000)
  expect(hasConfirmedPumpRun('left')).toBe(false)
  vi.resetModules()
  const writer = await import('../sideMutations')
  writer.confirmPumpRun('left')
  vi.setSystemTime(1_000)
  expect(hasConfirmedPumpRun('left')).toBe(true)
  expect(hasConfirmedPumpRun('right')).toBe(false)
  confirmPumpRun('right')
  expect(hasConfirmedPumpRun('right')).toBe(true)
})
