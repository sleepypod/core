import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({ revision: vi.fn(), monitor: vi.fn(), privacy: vi.fn() }))
vi.mock('@/src/server/controllerRevision', () => ({ readControllerRevision: runtime.revision }))
vi.mock('@/src/hardware/dacMonitor.instance', () => ({ getDacMonitorIfRunning: runtime.monitor }))
vi.mock('@/src/household/legacyPrivacy', () => ({ legacyPrivacyState: runtime.privacy }))
const { readMaintenanceStatus } = await import('../readStatus')

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers().setSystemTime('2026-10-29T20:00:00Z')
  runtime.revision.mockResolvedValue('abcdef123')
  runtime.monitor.mockReturnValue(null)
  runtime.privacy.mockReturnValue('personal_required')
})
afterEach(() => vi.useRealTimers())

it('can describe an unstarted controller without an initializer or hardware call', async () => {
  expect(await readMaintenanceStatus()).toMatchObject({ controller: { revision: 'abcdef123' }, device: { freshness: 'unavailable' }, thermalIdle: null })
  expect(runtime.monitor).toHaveBeenCalledOnce()
  expect(runtime.privacy).toHaveBeenCalledOnce()
})

it('uses the monitor invalidation check and does not publish cached targets', async () => {
  const { parseDeviceStatus } = await import('@/src/hardware/responseParser')
  const { DEVICE_STATUS_POD4 } = await import('@/src/hardware/tests/fixtures')
  const fresh = vi.fn().mockReturnValue(null)
  runtime.monitor.mockReturnValue({ getLastStatus: () => parseDeviceStatus(DEVICE_STATUS_POD4), getLastPollAt: () => Date.now() - 500, getFreshStatus: fresh })
  expect(await readMaintenanceStatus()).toMatchObject({ device: { freshness: 'stale' }, thermalIdle: null })
  expect(fresh).toHaveBeenCalledWith(15_000)
})
