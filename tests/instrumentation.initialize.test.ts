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
  startConfiguredShadowService: vi.fn(),
  startBiometricRuntime: vi.fn(),
  stopBiometricRuntime: vi.fn(),
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
  restoreInternetAccess: vi.fn(async () => ({ action: 'kept', choice: 'allowed' })),
  rehydratePumpStallGuard: vi.fn(),
  startDatabaseIntegrityChecks: vi.fn(),
  stopDatabaseIntegrityChecks: vi.fn(async () => undefined),
  startPerformanceMonitoring: vi.fn(),
  stopPerformanceMonitoring: vi.fn(),
  recordStartupPhase: vi.fn(),
  startTemperatureController: vi.fn(async () => undefined),
  stopTemperatureController: vi.fn(),
  getAutomationEngine: vi.fn(async () => ({})),
  shutdownAutomationEngine: vi.fn(async () => undefined),
  stopShadowService: vi.fn(async () => undefined),
  stopBacktestHost: vi.fn(async () => undefined),
  stopBiometricCoordinator: vi.fn(async () => undefined),
  shutdownBaseController: vi.fn(),
  startAutomationRunsRetention: vi.fn(),
  stopAutomationRunsRetention: vi.fn(),
  startConfiguredBacktestHost: vi.fn(),
  startHealthSampler: vi.fn(),
  stopHealthSampler: vi.fn(),
}))
vi.mock('@/src/lib/healthSampler', () => ({ startHealthSampler: mocks.startHealthSampler, stopHealthSampler: mocks.stopHealthSampler }))
vi.mock('@/src/hardware/alarmState', () => ({ restoreActiveAlarms: vi.fn(async () => undefined) }))
vi.mock('@/src/hardware/snoozeManager', () => ({ restoreSnoozes: vi.fn() }))

vi.mock('@/src/biometrics/shadow/startup', () => ({
  startConfiguredShadowService: mocks.startConfiguredShadowService,
}))
vi.mock('@/src/biometrics/shadow/service-host', () => ({ stopShadowService: mocks.stopShadowService }))
vi.mock('@/src/biometrics/backtest/host', () => ({ stopBacktestHost: mocks.stopBacktestHost }))
vi.mock('@/src/biometrics/backtest/host-startup', () => ({ startConfiguredBacktestHost: mocks.startConfiguredBacktestHost }))
vi.mock('@/src/biometrics/backtest/coordinator-service', () => ({ stopBiometricCoordinator: mocks.stopBiometricCoordinator }))
vi.mock('@/src/hardware/base/instance', () => ({ shutdownBaseController: mocks.shutdownBaseController }))
vi.mock('@/src/db/automationRunsRetention', () => ({
  startAutomationRunsRetention: mocks.startAutomationRunsRetention,
  stopAutomationRunsRetention: mocks.stopAutomationRunsRetention,
}))

vi.mock('@/src/db/integrity', () => ({
  startDatabaseIntegrityChecks: mocks.startDatabaseIntegrityChecks,
  stopDatabaseIntegrityChecks: mocks.stopDatabaseIntegrityChecks,
}))
vi.mock('@/src/lib/serverPerformance', () => ({
  startPerformanceMonitoring: mocks.startPerformanceMonitoring,
  stopPerformanceMonitoring: mocks.stopPerformanceMonitoring,
  recordStartupPhase: mocks.recordStartupPhase,
}))
vi.mock('@/src/temperature/instance', () => ({
  startTemperatureController: mocks.startTemperatureController,
  stopTemperatureController: mocks.stopTemperatureController,
}))

vi.mock('@/src/automation', () => ({
  getAutomationEngine: mocks.getAutomationEngine,
  shutdownAutomationEngine: mocks.shutdownAutomationEngine,
}))

vi.mock('@/src/scheduler', () => ({
  getJobManager: mocks.getJobManager,
  shutdownJobManager: mocks.shutdownJobManager,
}))
vi.mock('@/src/biometrics/profiles/runtime-host', () => ({
  startBiometricRuntime: mocks.startBiometricRuntime, stopBiometricRuntime: mocks.stopBiometricRuntime,
}))
vi.mock('@/src/db', () => ({
  db: {}, biometricsDb: {},
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
vi.mock('@/src/hardware/internetAccess', () => ({
  restoreInternetAccess: mocks.restoreInternetAccess,
}))
vi.mock('@/src/hardware/pumpStallGuard', () => ({
  rehydrate: mocks.rehydratePumpStallGuard,
}))

const scheduler = {
  getJobs: vi.fn(() => [] as { id: string, type: string }[]),
  getNextInvocation: vi.fn<(id: string) => Date | null>(() => null),
}
const jobManager = { getScheduler: () => scheduler }
const signalHandlers = new Map<string, () => Promise<void>>()

beforeEach(() => {
  vi.resetModules()
  for (const key of Object.keys(mocks) as Array<keyof typeof mocks>) {
    const m = mocks[key] as ReturnType<typeof vi.fn>
    if (typeof m.mockReset === 'function') m.mockReset()
  }
  mocks.shutdownJobManager.mockResolvedValue(undefined)
  mocks.stopDatabaseIntegrityChecks.mockResolvedValue(undefined)
  mocks.getAutomationEngine.mockResolvedValue({})
  mocks.shutdownAutomationEngine.mockResolvedValue(undefined)
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
  mocks.restoreInternetAccess.mockResolvedValue({ action: 'kept', choice: 'allowed' })
  mocks.getJobManager.mockResolvedValue(jobManager)
  scheduler.getJobs.mockReturnValue([])
  scheduler.getNextInvocation.mockReturnValue(null)
  signalHandlers.clear()
  vi.spyOn(process, 'on').mockImplementation((event, listener) => {
    signalHandlers.set(String(event), listener as () => Promise<void>)
    return process
  })
})

afterEach(() => {
  delete process.env.CI
  delete process.env.NEXT_RUNTIME
  vi.useRealTimers()
  vi.restoreAllMocks()
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
    expect(mocks.rehydratePumpStallGuard).toHaveBeenCalled()
    expect(mocks.initializeKeepalives).toHaveBeenCalled()
    // The guard must be re-armed before keepalives can consult shouldBlock.
    expect(mocks.rehydratePumpStallGuard.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.initializeKeepalives.mock.invocationCallOrder[0] ?? 0)
    expect(mocks.rehydratePumpStallGuard.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.getJobManager.mock.invocationCallOrder[0] ?? 0)
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

  it('coalesces concurrent initialization while hardware startup is pending', async () => {
    let release!: () => void
    mocks.startDacServer.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve(undefined)
    }))
    const { initializeScheduler } = await fresh()
    const first = initializeScheduler()
    const second = initializeScheduler()
    await vi.waitFor(() => expect(mocks.startDacServer).toHaveBeenCalledOnce())
    release()
    await Promise.all([first, second])

    expect(mocks.getJobManager).toHaveBeenCalledOnce()
    expect(mocks.rehydratePumpStallGuard).toHaveBeenCalledOnce()
    expect(mocks.startPiezoStreamServer).toHaveBeenCalledOnce()
    expect(mocks.initializeKeepalives).toHaveBeenCalledOnce()
  })

  it('starts the remaining services without waiting for MQTT to connect', async () => {
    let release!: () => void
    mocks.startMqttBridge.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve(undefined)
    }))
    const { initializeScheduler } = await fresh()
    await initializeScheduler()

    expect(mocks.startAutoOffWatcher).toHaveBeenCalledOnce()
    expect(mocks.startBonjourAnnouncement).toHaveBeenCalledOnce()
    expect(mocks.startBiometricsRetention).toHaveBeenCalledOnce()
    release()
    await Promise.resolve()
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

  it('logs and swallows when pump stall guard rehydration throws', async () => {
    mocks.rehydratePumpStallGuard.mockImplementationOnce((): never => {
      throw new Error('bio db locked')
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { initializeScheduler } = await fresh()
    await initializeScheduler()
    expect(warnSpy).toHaveBeenCalledWith('[pumpStallGuard] rehydration failed:', 'bio db locked')
    expect(mocks.initializeKeepalives).toHaveBeenCalled()
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
  it('starts the shared controller and keepalives even when Autopilot fails', async () => {
    mocks.getAutomationEngine.mockRejectedValueOnce(new Error('automation table unavailable'))
    const { register } = await import('../instrumentation')
    await register()
    await vi.waitFor(() => {
      expect(mocks.startTemperatureController).toHaveBeenCalledTimes(1)
      expect(mocks.initializeKeepalives).toHaveBeenCalledTimes(1)
    })
  })

  it('waits for migrations before publishing hardware readiness', async () => {
    let release!: () => void
    mocks.runMigrations.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve(undefined)
    }))
    const { register, initializeScheduler } = await fresh()
    const pending = register()
    await vi.waitFor(() => expect(mocks.runMigrations).toHaveBeenCalledOnce())
    expect(mocks.startBiometricRuntime).not.toHaveBeenCalled()

    expect(mocks.seedDefaultData).not.toHaveBeenCalled()
    expect(mocks.startDacServer).not.toHaveBeenCalled()
    expect(mocks.startPiezoStreamServer).not.toHaveBeenCalled()
    release()
    await pending
    expect(mocks.startBiometricRuntime).toHaveBeenCalledOnce()
    await initializeScheduler()
    expect(mocks.startPiezoStreamServer).toHaveBeenCalledOnce()
  })

  it('allows HTTP and hardware readiness while the scheduler waits for the clock', async () => {
    let release!: (manager: typeof jobManager) => void
    mocks.getJobManager.mockImplementationOnce(() => new Promise((resolve) => {
      release = resolve
    }))
    const { register, initializeScheduler } = await fresh()
    await register()

    expect(mocks.startDacServer).toHaveBeenCalledOnce()
    expect(mocks.startPiezoStreamServer).toHaveBeenCalledOnce()
    expect(mocks.startDatabaseIntegrityChecks).toHaveBeenCalledOnce()
    expect(mocks.initializeKeepalives).not.toHaveBeenCalled()
    expect(mocks.recordStartupPhase).toHaveBeenCalledWith('http-initialization-ready')
    release(jobManager)
    await initializeScheduler()
    expect(mocks.initializeKeepalives).toHaveBeenCalledOnce()
  })

  it('does not start background writers when shutdown occurs during scheduler initialization', async () => {
    vi.useFakeTimers()
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    let release!: (manager: typeof jobManager) => void
    mocks.getJobManager.mockImplementationOnce(() => new Promise((resolve) => {
      release = resolve
    }))
    const { register, initializeScheduler } = await fresh()
    await register()
    const pending = initializeScheduler()
    await signalHandlers.get('SIGTERM')?.()
    release(jobManager)
    await pending

    expect(mocks.initializeKeepalives).not.toHaveBeenCalled()
    expect(mocks.startMqttBridge).not.toHaveBeenCalled()
    expect(mocks.startAutoOffWatcher).not.toHaveBeenCalled()
    expect(mocks.stopDatabaseIntegrityChecks).toHaveBeenCalledOnce()
    expect(mocks.shutdownJobManager).toHaveBeenCalledOnce()
  })

  it('closes a late MQTT connection after shutdown has already run', async () => {
    vi.useFakeTimers()
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    let release!: () => void
    mocks.startMqttBridge.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve(undefined)
    }))
    const { register, initializeScheduler } = await fresh()
    await register()
    await initializeScheduler()
    await signalHandlers.get('SIGTERM')?.()
    expect(mocks.shutdownMqttBridge).toHaveBeenCalledOnce()
    release()
    await Promise.resolve()
    expect(mocks.shutdownMqttBridge).toHaveBeenCalledTimes(2)
  })

  it('skips body entirely when NEXT_RUNTIME=edge', async () => {
    process.env.NEXT_RUNTIME = 'edge'
    const { register } = await fresh()
    await register()
    expect(mocks.runMigrations).not.toHaveBeenCalled()
    expect(mocks.startConfiguredShadowService).not.toHaveBeenCalled()
  })

  it('runs migrations + seed, then short-circuits before hardware on CI', async () => {
    process.env.CI = '1'
    const { register } = await fresh()
    await register()
    expect(mocks.runMigrations).toHaveBeenCalled()
    expect(mocks.seedDefaultData).toHaveBeenCalled()
    expect(mocks.checkAndRepairIptables).not.toHaveBeenCalled()
    expect(mocks.getJobManager).not.toHaveBeenCalled()
    expect(mocks.startConfiguredShadowService).not.toHaveBeenCalled()
  })

  it('runs migrations and full init when not in CI', async () => {
    const { register } = await fresh()
    await register()
    expect(mocks.runMigrations).toHaveBeenCalled()
    expect(mocks.checkAndRepairIptables).toHaveBeenCalled()
    expect(mocks.getJobManager).toHaveBeenCalled()
    const { db, biometricsDb } = await import('@/src/db')
    expect(mocks.startConfiguredShadowService).toHaveBeenCalledWith(db, biometricsDb)
    expect(mocks.startConfiguredShadowService.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.runMigrations.mock.invocationCallOrder[0])
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

  it('re-applies the saved internet access choice before repairing rules', async () => {
    mocks.restoreInternetAccess.mockResolvedValueOnce({ action: 'reapplied', choice: 'blocked' })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { register } = await fresh()
    await register()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/saved as blocked but the firewall was open; re-applied/))
    expect(mocks.restoreInternetAccess.mock.invocationCallOrder[0]).toBeLessThan(mocks.checkAndRepairIptables.mock.invocationCallOrder[0])
    warnSpy.mockRestore()
  })

  it('logs an inferred internet access choice', async () => {
    mocks.restoreInternetAccess.mockResolvedValueOnce({ action: 'inferred', choice: 'blocked' })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { register } = await fresh()
    await register()
    expect(logSpy).toHaveBeenCalledWith('[startup] Saved internet access as blocked (inferred from the current firewall)')
    logSpy.mockRestore()
  })

  it('still checks iptables when the internet access restore fails', async () => {
    mocks.restoreInternetAccess.mockRejectedValueOnce(new Error('EACCES'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { register } = await fresh()
    await register()
    expect(warnSpy).toHaveBeenCalledWith('[startup] internet access restore failed:', 'EACCES')
    expect(mocks.checkAndRepairIptables).toHaveBeenCalled()
    warnSpy.mockRestore()
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

describe('graceful shutdown and process handlers', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  const signal = (name: string) => {
    const handler = signalHandlers.get(name)
    if (!handler) throw new Error(`No ${name} handler`)
    return handler()
  }

  it('registers handlers once and shuts down once even when every step fails', async () => {
    const { register } = await fresh()
    await register()
    const registered = vi.mocked(process.on).mock.calls.length
    await register()
    expect(vi.mocked(process.on).mock.calls.length).toBe(registered)
    const failing = [
      mocks.stopTemperatureController, mocks.shutdownJobManager, mocks.shutdownAutomationEngine, mocks.shutdownPiezoStreamServer,
      mocks.shutdownMqttBridge, mocks.stopBonjourAnnouncement, mocks.shutdownHomeKit, mocks.stopAutoOffWatcher, mocks.shutdownDacMonitor,
      mocks.stopBiometricsRetention, mocks.stopShadowService, mocks.stopBacktestHost, mocks.stopBiometricCoordinator, mocks.closeDatabase,
    ] as ReturnType<typeof vi.fn>[]
    for (const step of failing) {
      step.mockImplementation(() => {
        throw new Error(`${step.getMockName()} failed`)
      })
    }
    await signal('SIGINT')
    expect(exitSpy).toHaveBeenCalledWith(0)
    expect(errorSpy.mock.calls.filter((call: unknown[]) => /^Error (shutting down|stopping|closing)/.test(String(call[0])))).toHaveLength(failing.length)
    expect(mocks.stopDatabaseIntegrityChecks).toHaveBeenCalledOnce()
    await signal('SIGTERM')
    expect(mocks.stopDatabaseIntegrityChecks).toHaveBeenCalledOnce()
    expect(exitSpy).toHaveBeenCalledTimes(1)
  })

  it('logs unhandled rejections and ignores the iptables mDNS EPERM without shutting down', async () => {
    const { register } = await fresh()
    await register()
    const rejection = signalHandlers.get('unhandledRejection') as unknown as (reason: unknown) => void
    rejection(new Error('late rejection'))
    expect(errorSpy).toHaveBeenCalledWith('Unhandled promise rejection:', expect.any(Error))
    const uncaught = signalHandlers.get('uncaughtException') as unknown as (error: Error & { code?: string, address?: string, port?: number }) => void
    uncaught(Object.assign(new Error('send EPERM'), { code: 'EPERM', address: '224.0.0.251', port: 5353 }))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/mDNS send blocked/), 'send EPERM')
    expect(mocks.shutdownJobManager).not.toHaveBeenCalled()
    uncaught(Object.assign(new Error('other EPERM'), { code: 'EPERM', address: '10.0.0.1', port: 5353 }))
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0))
    expect(errorSpy).toHaveBeenCalledWith('Uncaught exception:', expect.any(Error))
    expect(mocks.shutdownJobManager).toHaveBeenCalledOnce()
  })

  it('forces exit when graceful shutdown hangs', async () => {
    vi.useFakeTimers()
    mocks.shutdownJobManager.mockImplementation(() => new Promise(() => {}))
    const { register } = await fresh()
    await register()
    const pending = signal('SIGTERM')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errorSpy).toHaveBeenCalledWith('Graceful shutdown timed out after 10s, forcing exit')
    void pending
  })

  it('cancels scheduler retries once shutdown begins', async () => {
    vi.useFakeTimers()
    mocks.getJobManager.mockRejectedValueOnce(new Error('clock not ready'))
    const { register, initializeScheduler } = await fresh()
    await register()
    const pending = initializeScheduler()
    await vi.advanceTimersByTimeAsync(100)
    expect(mocks.getJobManager).toHaveBeenCalledOnce()
    await signal('SIGTERM')
    await vi.advanceTimersByTimeAsync(1000)
    await pending
    expect(mocks.getJobManager).toHaveBeenCalledOnce()
    expect(errorSpy).toHaveBeenCalledWith('Failed to initialize job scheduler:', expect.objectContaining({ message: 'Startup cancelled during shutdown' }))
    expect(mocks.startHealthSampler).toHaveBeenCalledOnce()
    expect(mocks.startAutoOffWatcher).not.toHaveBeenCalled()
  })

  it('closes late HomeKit, automation and temperature starts after shutdown has run', async () => {
    let releaseHomeKit!: () => void, releaseAutomation!: (engine: object) => void
    mocks.startHomeKitIfEnabled.mockImplementationOnce(() => new Promise((resolve) => {
      releaseHomeKit = () => resolve(undefined)
    }))
    mocks.getAutomationEngine.mockImplementationOnce(() => new Promise((resolve) => {
      releaseAutomation = resolve
    }))
    const { register, initializeScheduler } = await fresh()
    await register()
    await initializeScheduler()
    await signal('SIGTERM')
    expect(mocks.shutdownHomeKit).toHaveBeenCalledOnce()
    expect(mocks.shutdownAutomationEngine).toHaveBeenCalledOnce()
    releaseHomeKit()
    releaseAutomation({})
    await vi.waitFor(() => {
      expect(mocks.shutdownHomeKit).toHaveBeenCalledTimes(2)
      expect(mocks.shutdownAutomationEngine).toHaveBeenCalledTimes(2)
    })
    expect(mocks.startTemperatureController).not.toHaveBeenCalled()
  })

  it('stops a temperature controller that finished starting during shutdown and reports controller failures', async () => {
    let releaseController!: () => void
    mocks.startTemperatureController.mockImplementationOnce(() => new Promise((resolve) => {
      releaseController = () => resolve(undefined)
    }))
    const { register, initializeScheduler } = await fresh()
    await register()
    await initializeScheduler()
    await vi.waitFor(() => expect(mocks.startTemperatureController).toHaveBeenCalledOnce())
    await signal('SIGTERM')
    expect(mocks.stopTemperatureController).toHaveBeenCalledOnce()
    releaseController()
    await vi.waitFor(() => expect(mocks.stopTemperatureController).toHaveBeenCalledTimes(2))
    expect(mocks.initializeKeepalives).not.toHaveBeenCalled()

    vi.resetModules()
    mocks.startTemperatureController.mockRejectedValueOnce(new Error('controller offline'))
    const next = await fresh()
    await next.initializeScheduler()
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalledWith('[temperature] controller failed to start:', 'controller offline'))
  })

  it('abandons startup at each checkpoint once shutdown starts', async () => {
    let releaseDac!: () => void
    mocks.startDacServer.mockImplementationOnce(() => new Promise((resolve) => {
      releaseDac = () => resolve(undefined)
    }))
    let entry = await fresh()
    const node = await import('@/src/server/instrumentation-node')
    const registering = entry.register()
    await vi.waitFor(() => expect(mocks.startDacServer).toHaveBeenCalledOnce())
    const initializing = node.initializeScheduler()
    await signal('SIGTERM')
    releaseDac()
    await Promise.all([registering, initializing])
    expect(mocks.getDacMonitor).not.toHaveBeenCalled()
    expect(mocks.startHealthSampler).not.toHaveBeenCalled()
    expect(mocks.startDatabaseIntegrityChecks).not.toHaveBeenCalled()

    vi.resetModules()
    mocks.rehydratePumpStallGuard.mockImplementationOnce(() => void signal('SIGTERM'))
    entry = await fresh()
    await entry.register()
    expect(mocks.startDacServer).toHaveBeenCalledOnce()

    vi.resetModules()
    mocks.shutdownDacMonitor.mockClear()
    mocks.getDacMonitor.mockImplementationOnce(async () => {
      void signal('SIGTERM')
      return { getStatus: () => 'running' } as never
    })
    entry = await fresh()
    await entry.register()
    expect(mocks.startPiezoStreamServer).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(mocks.shutdownDacMonitor).toHaveBeenCalledTimes(2))

    vi.resetModules()
    mocks.getJobManager.mockImplementation(async () => {
      void signal('SIGTERM')
      return jobManager
    })
    entry = await fresh()
    await entry.register()
    await vi.waitFor(() => expect(mocks.getJobManager).toHaveBeenCalledOnce())
    await entry.initializeScheduler()
    expect(mocks.recordStartupPhase).not.toHaveBeenCalledWith('scheduler-ready', expect.anything())
    expect(mocks.startMqttBridge).not.toHaveBeenCalled()
    mocks.getJobManager.mockResolvedValue(jobManager)

    vi.resetModules()
    mocks.startConfiguredBacktestHost.mockClear()
    mocks.startConfiguredShadowService.mockClear()
    const shutdowns: Promise<void>[] = []
    mocks.startDatabaseIntegrityChecks.mockImplementationOnce(() => void shutdowns.push(signal('SIGTERM')))
    entry = await fresh()
    await entry.register()
    expect(mocks.startConfiguredBacktestHost).not.toHaveBeenCalled()

    vi.resetModules()
    mocks.startConfiguredBacktestHost.mockImplementationOnce(() => void shutdowns.push(signal('SIGTERM')))
    entry = await fresh()
    await entry.register()
    expect(mocks.startConfiguredShadowService).not.toHaveBeenCalled()
    await Promise.all(shutdowns)
  })

  it('reports non-Error startup failures and a silent iptables check verbatim', async () => {
    mocks.rehydratePumpStallGuard.mockImplementationOnce(() => {
      throw 'guard string'
    })
    mocks.startDacServer.mockRejectedValueOnce('dac string')
    mocks.getDacMonitor.mockRejectedValueOnce('monitor string')
    mocks.startPiezoStreamServer.mockImplementationOnce(() => {
      throw 'piezo string'
    })
    mocks.startMqttBridge.mockRejectedValueOnce('mqtt string')
    mocks.startHomeKitIfEnabled.mockRejectedValueOnce('homekit string')
    mocks.getAutomationEngine.mockRejectedValueOnce('automation string')
    mocks.startTemperatureController.mockRejectedValueOnce('temperature string')
    mocks.checkAndRepairIptables.mockImplementationOnce(() => {
      throw 'iptables string'
    })
    const { register, initializeScheduler } = await fresh()
    await register()
    await initializeScheduler()
    await vi.waitFor(() => {
      for (const text of ['guard string', 'dac string', 'monitor string', 'piezo string', 'mqtt string', 'homekit string', 'automation string', 'temperature string', 'iptables string']) {
        expect(warnSpy).toHaveBeenCalledWith(expect.any(String), text)
      }
    })
    vi.resetModules()
    const logSpy = vi.mocked(console.log)
    logSpy.mockClear()
    warnSpy.mockClear()
    mocks.checkAndRepairIptables.mockReturnValueOnce({ ok: false, repaired: [] } as never)
    const next = await fresh()
    await next.register()
    expect(logSpy).not.toHaveBeenCalledWith('[startup] iptables rules verified')
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringMatching(/Repaired/), expect.anything())
  })
})
