import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/src/db', () => {
  const query = {
    from: vi.fn(() => query),
    where: vi.fn(() => query),
    limit: vi.fn(() => query),
    all: vi.fn(() => []),
  }

  return { db: { select: vi.fn(() => query) } }
})

vi.mock('@/src/hardware/dacMonitor.instance', () => ({
  getSharedHardwareClient: vi.fn(),
}))

vi.mock('@/src/hardware/pumpStallGuard', () => ({
  shouldBlock: vi.fn(() => false),
}))

vi.mock('@/src/hardware/sideLock', () => ({
  withSideLock: (_side: unknown, work: () => unknown) => work(),
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('temperature keepalive mutation contract', () => {
  it('loads a fresh module and arms the firmware keepalive at exactly six hours', async () => {
    // KEEPALIVE_INTERVAL_MS is evaluated at module load. Reload the service
    // while each static Stryker mutant is active so arithmetic changes cannot
    // hide behind the module instance collected before mutation activation.
    vi.resetModules()
    const { startKeepalive, shutdownKeepalives } = await import('../temperatureKeepalive')

    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const interval = vi.spyOn(globalThis, 'setInterval')
    vi.spyOn(console, 'log').mockImplementation(() => {})

    startKeepalive('left')

    expect(interval).toHaveBeenCalledWith(expect.any(Function), 21_600_000)
    shutdownKeepalives()
  })
})
