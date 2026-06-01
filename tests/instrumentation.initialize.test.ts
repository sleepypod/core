/**
 * Behavioural tests for the Next.js instrumentation hook body —
 * `initializeScheduler()` orchestrates a long chain of (non-)blocking
 * startup steps and must swallow per-step failures without crashing.
 * `register()` is the entry; the gate is covered in instrumentation.test.ts.
 *
 * Every external module is mocked. Each test resets module state so the
 * `isInitialized` flag doesn't leak between cases.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getJobManager: vi.fn(),
  shutdownJobManager: vi.fn(async () => undefined),
  closeDatabase: vi.fn(),
  closeBiometricsDatabase: vi.fn(),
  startBiometricsRetention: vi.fn(),
  stopBiometricsRetention: vi.fn(),
  getDacMonitor: vi.fn(async () => ({ getStatus: () => 'running' })),
  shutdownDacMonitor: vi.fn(async () => undefined),
  startDacServer: vi.fn(async () => undefined),
  startPiezoStreamServer: vi.fn(),
  shutdownPiezoStreamServer: vi.fn(async () => undefined),
  startBonjourAnnouncement: vi.fn(),
  stopBonjourAnnouncement: vi.fn(),
  startMqttBridge: vi.fn(async () => undefined),
  shutdownMqttBridge: vi.fn(async () => undefined),
  initializeKeepalives: vi.fn(),
  shutdownKeepalives: vi.fn(),
  startAutoOffWatcher: vi.fn(),
  stopAutoOffWatcher: vi.fn(async () => undefined),
  shutdownHomeKit: vi.fn(async () => undefined),
  startHomeKitIfEnabled: vi.fn(async () => undefined),
  runMigrations: vi.fn(async () => undefined),
  seedDefaultData: vi.fn(async () => undefined),
  checkAndRepairIptables: vi.fn(() => ({ ok: true, repaired: [] })),
}))

vi.mock('@/src/scheduler', () => ({
  getJobManager: mocks.getJobManager,
  shutdownJobManager: mocks.shutdownJobManager,
}))
vi.mock('@/src/db', () => ({
  closeDatabase: mocks.closeDatabase,
  closeBiometricsDatabase: mocks.closeBiometricsDatabase,
}))
vi.mock('@/src/db/retention', () => ({
  startBiometricsRetention: mocks.startBiometricsRetention,
  stopBiometricsRetention: mocks.stopBiometricsRetention,
}))
vi.mock('@/src/hardware/dacMonitor.instance', () => ({
  getDacMonitor: mocks.getDacMonitor,
  shutdownDacMonitor: mocks.shutdownDacMonitor,
  startDacServer: mocks.startDacServer,
}))
vi.mock('@/src/streaming/piezoStream', () => ({
  startPiezoStreamServer: mocks.startPiezoStreamServer,
  shutdownPiezoStreamServer: mocks.shutdownPiezoStreamServer,
}))
vi.mock('@/src/streaming/bonjourAnnounce', () => ({
  startBonjourAnnouncement: mocks.startBonjourAnnouncement,
  stopBonjourAnnouncement: mocks.stopBonjourAnnouncement,
}))
vi.mock('@/src/streaming/mqttBridge', () => ({
  startMqttBridge: mocks.startMqttBridge,
  shutdownMqttBridge: mocks.shutdownMqttBridge,
}))
vi.mock('@/src/services/temperatureKeepalive', () => ({
  initializeKeepalives: mocks.initializeKeepalives,
  shutdownKeepalives: mocks.shutdownKeepalives,
}))
vi.mock('@/src/services/autoOffWatcher', () => ({
  startAutoOffWatcher: mocks.startAutoOffWatcher,
  stopAutoOffWatcher: mocks.stopAutoOffWatcher,
}))
vi.mock('@/src/homekit', () => ({
  shutdownHomeKit: mocks.shutdownHomeKit,
  startHomeKitIfEnabled: mocks.startHomeKitIfEnabled,
}))
vi.mock('@/src/db/migrate', () => ({
  runMigrations: mocks.runMigrations,
  seedDefaultData: mocks.seedDefaultData,
}))
vi.mock('@/src/hardware/iptablesCheck', () => ({
  checkAndRepairIptables: mocks.checkAndRepairIptables,
}))

const scheduler = {
  getJobs: vi.fn(() => [] as { id: string, type: string }[]),
  getNextInvocation: vi.fn<(id: string) => Date | null>(() => null),
}
const jobManager = { getScheduler: () => scheduler }

beforeEach(() => {
  vi.resetModules()
  for (const key of Object.keys(mocks) as Array<keyof typeof mocks>) {
    const m = mocks[key] as ReturnType<typeof vi.fn>
    if (typeof m.mockReset === 'function') m.mockReset()
  }
  mocks.shutdownJobManager.mockResolvedValue(undefined)
  mocks.shutdownPiezoStreamServer.mockResolvedValue(undefined)
  mocks.shutdownMqttBridge.mockResolvedValue(undefined)
  mocks.shutdownHomeKit.mockResolvedValue(undefined)
  mocks.stopAutoOffWatcher.mockResolvedValue(undefined)
  mocks.shutdownDacMonitor.mockResolvedValue(undefined)
  mocks.getDacMonitor.mockResolvedValue({ getStatus: () => 'running' } as never)
  mocks.startDacServer.mockResolvedValue(undefined)
  mocks.startMqttBridge.mockResolvedValue(undefined)
  mocks.startHomeKitIfEnabled.mockResolvedValue(undefined)
  mocks.runMigrations.mockResolvedValue(undefined)
  mocks.seedDefaultData.mockResolvedValue(undefined)
  mocks.checkAndRepairIptables.mockReturnValue({ ok: true, repaired: [] })
  mocks.getJobManager.mockResolvedValue(jobManager)
  scheduler.getJobs.mockReturnValue([])
  scheduler.getNextInvocation.mockReturnValue(null)
})

afterEach(() => {
  delete process.env.CI
  delete process.env.NEXT_RUNTIME
})

async function fresh() {
  return await import('../instrumentation')
}

describe('initializeScheduler — happy path', () => {
  it('boots every startup service in order', async () => {
    scheduler.getJobs.mockReturnValue([
      { id: 'j1', type: 'temperature' },
      { id: 'j2', type: 'power_on' },
    ])
    scheduler.getNextInvocation.mockImplementation((id: string) =>
      id === 'j1' ? new Date(Date.now() + 1000) : new Date(Date.now() + 500),
    )

    const { initializeScheduler } = await fresh()
    await initializeScheduler()

    expect(mocks.getJobManager).toHaveBeenCalled()
    expect(mocks.startDacServer).toHaveBeenCalled()
    expect(mocks.getDacMonitor).toHaveBeenCalled()
    expect(mocks.initializeKeepalives).toHaveBeenCalled()
    expect(mocks.startPiezoStreamServer).toHaveBeenCalled()
    expect(mocks.startMqttBridge).toHaveBeenCalled()
    expect(mocks.startAutoOffWatcher).toHaveBeenCalled()
    expect(mocks.startBonjourAnnouncement).toHaveBeenCalled()
    expect(mocks.startHomeKitIfEnabled).toHaveBeenCalled()
    expect(mocks.startBiometricsRetention).toHaveBeenCalled()
  })

  it('is idempotent — second call is a no-op', async () => {
    const { initializeScheduler } = await fresh()
    await initializeScheduler()
    mocks.getJobManager.mockClear()
    await initializeScheduler()
    expect(mocks.getJobManager).not.toHaveBeenCalled()
  })

  it('skips upcoming-jobs log block when no jobs have a nextRun', async () => {
    scheduler.getJobs.mockReturnValue([{ id: 'never', type: 'temperature' }])
    scheduler.getNextInvocation.mockReturnValue(null)

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { initializeScheduler } = await fresh()
    await initializeScheduler()
    expect(logSpy).not.toHaveBeenCalledWith('Next scheduled jobs:')
    logSpy.mockRestore()
  })
})

describe('initializeScheduler — error swallowing', () => {
  it('logs and swallows when DAC socket server fails to start', async () => {
    mocks.startDacServer.mockRejectedValueOnce(new Error('dac sock busy'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { initializeScheduler } = await fresh()
    await initializeScheduler()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/DAC.*Socket server failed/), expect.anything())
    warnSpy.mockRestore()
  })

  it('logs and swallows when DacMonitor throws', async () => {
    mocks.getDacMonitor.mockRejectedValueOnce(new Error('no socket'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { initializeScheduler } = await fresh()
    await initializeScheduler()
    // Wait a microtask — initializeDacMonitor() is fire-and-forget
    await new Promise(resolve => setImmediate(resolve))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/DacMonitor failed/), expect.anything())
    warnSpy.mockRestore()
  })

  it('logs and swallows when piezo stream server throws', async () => {
    mocks.startPiezoStreamServer.mockImplementationOnce((): never => {
      throw new Error('addr in use')
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { initializeScheduler } = await fresh()
    await initializeScheduler()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/Piezo stream server failed/), expect.anything())
    warnSpy.mockRestore()
  })

  it('logs and swallows when MQTT bridge rejects', async () => {
    mocks.startMqttBridge.mockRejectedValueOnce(new Error('mqtt down'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { initializeScheduler } = await fresh()
    await initializeScheduler()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/MQTT bridge failed/), expect.anything())
    warnSpy.mockRestore()
  })

  it('logs HomeKit startup failures via the .catch chain', async () => {
    mocks.startHomeKitIfEnabled.mockRejectedValueOnce(new Error('home boom'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { initializeScheduler } = await fresh()
    await initializeScheduler()
    await new Promise(resolve => setImmediate(resolve))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/\[homekit] startup failed/), expect.anything())
    warnSpy.mockRestore()
  })

  it('logs and swallows when getJobManager rejects all retries', async () => {
    mocks.getJobManager.mockRejectedValue(new Error('manager down'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // Speed up exponential backoff in withRetry
    const origSetTimeout = global.setTimeout
    const fakeTimeout = ((cb: () => void) => origSetTimeout(cb, 0)) as unknown as typeof global.setTimeout
    Object.assign(fakeTimeout, origSetTimeout)
    vi.stubGlobal('setTimeout', fakeTimeout)

    const { initializeScheduler } = await fresh()
    await initializeScheduler()
    expect(errSpy).toHaveBeenCalledWith('Failed to initialize job scheduler:', expect.any(Error))
    errSpy.mockRestore()
    warnSpy.mockRestore()
    vi.unstubAllGlobals()
  }, 15000)
})

describe('register()', () => {
  it('skips body entirely when NEXT_RUNTIME=edge', async () => {
    process.env.NEXT_RUNTIME = 'edge'
    const { register } = await fresh()
    await register()
    expect(mocks.runMigrations).not.toHaveBeenCalled()
  })

  it('runs migrations + seed, then short-circuits before hardware on CI', async () => {
    process.env.CI = '1'
    const { register } = await fresh()
    await register()
    expect(mocks.runMigrations).toHaveBeenCalled()
    expect(mocks.seedDefaultData).toHaveBeenCalled()
    expect(mocks.checkAndRepairIptables).not.toHaveBeenCalled()
    expect(mocks.getJobManager).not.toHaveBeenCalled()
  })

  it('runs migrations and full init when not in CI', async () => {
    const { register } = await fresh()
    await register()
    expect(mocks.runMigrations).toHaveBeenCalled()
    expect(mocks.checkAndRepairIptables).toHaveBeenCalled()
    expect(mocks.getJobManager).toHaveBeenCalled()
  })

  it('warns when iptables auto-repaired rules', async () => {
    mocks.checkAndRepairIptables.mockReturnValueOnce({ ok: false, repaired: ['mdns', 'ntp'] } as any)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { register } = await fresh()
    await register()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Repaired 2 missing iptables rules/),
      'mdns, ntp',
    )
    warnSpy.mockRestore()
  })

  it('logs ok when iptables already verified', async () => {
    mocks.checkAndRepairIptables.mockReturnValueOnce({ ok: true, repaired: [] } as any)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { register } = await fresh()
    await register()
    expect(logSpy).toHaveBeenCalledWith('[startup] iptables rules verified')
    logSpy.mockRestore()
  })

  it('swallows iptables check failures with a warning', async () => {
    mocks.checkAndRepairIptables.mockImplementationOnce((): never => {
      throw new Error('no perms')
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { register } = await fresh()
    await register()
    expect(warnSpy).toHaveBeenCalledWith(
      '[startup] iptables check skipped:',
      expect.stringMatching(/no perms/),
    )
    warnSpy.mockRestore()
  })
})
