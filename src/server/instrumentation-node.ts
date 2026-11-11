import { getBaseController, shutdownBaseController } from '@/src/hardware/base/instance'
import { startMechanicalContext, stopMechanicalContext } from '@/src/biometrics/mechanical/instance'
/**
 * Server startup and process lifecycle management.
 *
 * Handles:
 * - Job scheduler initialization with exponential-backoff retry
 * - DAC hardware monitor initialization (non-blocking)
 * - Hardware daemon pre-flight validation
 * - Centralized SIGTERM/SIGINT signal handling
 * - Global unhandled rejection/exception handlers
 * - Graceful shutdown sequencing with 10 s force-exit watchdog
 *
 * Entry points:
 * - `register()` — Next.js instrumentation hook, called automatically on server start.
 *    Runs only in the Node.js runtime; skipped on the Edge runtime.
 * - `initializeScheduler()` — idempotent, safe to call from app code as a fallback.
 */

import { getJobManager, shutdownJobManager } from '@/src/scheduler'
import { getAutomationEngine, shutdownAutomationEngine } from '@/src/automation'
import { startTemperatureController, stopTemperatureController } from '@/src/temperature/instance'
import { startComfortPreview, stopComfortPreview } from '@/src/comfort/instance'
import { closeDatabase, closeBiometricsDatabase } from '@/src/db'
import { startBiometricsRetention, stopBiometricsRetention } from '@/src/db/retention'
import { startAutomationRunsRetention, stopAutomationRunsRetention } from '@/src/db/automationRunsRetention'
import { startHealthSampler, stopHealthSampler } from '@/src/lib/healthSampler'
import { stopBacktestHost } from '@/src/biometrics/backtest/host'
import { stopBiometricCoordinator } from '@/src/biometrics/backtest/coordinator-service'
import { stopBiometricRuntime } from '@/src/biometrics/profiles/runtime-host'
import { getDacMonitor, shutdownDacMonitor } from '@/src/hardware/dacMonitor.instance'
import { startPiezoStreamServer, shutdownPiezoStreamServer } from '@/src/streaming/piezoStream'
import { startBonjourAnnouncement, stopBonjourAnnouncement } from '@/src/streaming/bonjourAnnounce'
import { startMqttBridge, shutdownMqttBridge } from '@/src/streaming/mqttBridge'
import { initializeKeepalives, shutdownKeepalives } from '@/src/services/temperatureKeepalive'
import { startAutoOffWatcher, stopAutoOffWatcher } from '@/src/services/autoOffWatcher'
import { startAutoOnWatcher, stopAutoOnWatcher } from '@/src/services/autoOnWatcher'
import { startDatabaseIntegrityChecks, stopDatabaseIntegrityChecks } from '@/src/db/integrity'
import { startPerformanceMonitoring, stopPerformanceMonitoring, recordStartupPhase } from '@/src/lib/serverPerformance'
import { shutdownHomeKit, startHomeKitIfEnabled } from '@/src/homekit'
import { stopPersonalHistoryIngestion } from '@/src/household/historyIngestionRuntime'
import { assertHardwareWriteCurrent, captureHardwareIntent, HardwareAdmissionError } from '@/src/hardware/admission'

interface NodeLifecycle {
  isInitialized: boolean
  isShuttingDown: boolean
  handlersRegistered: boolean
  initializationPromise: Promise<void> | null
  hardwareReady: boolean
  hardwarePromise: Promise<void> | null
  observabilityReady: boolean
  automaticSuspended: boolean
  suspension: Promise<void> | null
  automaticPromise: Promise<void> | null
  automaticStartupFailure: unknown | null
  automaticStopFailed: boolean
}
const shared = globalThis as typeof globalThis & { __sp_nodeLifecycle?: NodeLifecycle }
const lifecycle = shared.__sp_nodeLifecycle ??= {
  isInitialized: false, isShuttingDown: false, handlersRegistered: false,
  initializationPromise: null, hardwareReady: false, hardwarePromise: null,
  observabilityReady: false, automaticSuspended: false, suspension: null, automaticPromise: null,
  automaticStartupFailure: null, automaticStopFailed: false,
}

/**
 * Centralized graceful shutdown coordinator.
 * Sequences: wait for in-flight jobs → shutdown scheduler → close database → exit
 */
async function gracefulShutdown(signal: string): Promise<void> {
  if (lifecycle.isShuttingDown) return
  lifecycle.isShuttingDown = true

  console.log(`Received ${signal}, starting graceful shutdown...`)

  // Force exit after 10s if graceful shutdown hangs
  const forceExitTimer = setTimeout(() => {
    console.error('Graceful shutdown timed out after 10s, forcing exit')
    process.exit(1)
  }, 10_000)
  forceExitTimer.unref()

  stopPerformanceMonitoring()
  stopPersonalHistoryIngestion()
  await stopDatabaseIntegrityChecks()

  // Step 0: Stop keepalive timers
  try {
    await stopComfortPreview()
    await stopTemperatureController()
    shutdownBaseController()
    await shutdownKeepalives()
  }
  catch (error) {
    console.error('Error shutting down keepalives:', error)
  }

  // Step 1: Shutdown scheduler (waits for in-flight jobs internally)
  try {
    await shutdownJobManager()
  }
  catch (error) {
    console.error('Error shutting down scheduler:', error)
  }

  // Step 1a: Stop the Autopilot rules engine tick
  try {
    await shutdownAutomationEngine()
  }
  catch (error) {
    console.error('Error shutting down automation engine:', error)
  }

  // Step 2: Shutdown piezo stream server
  try {
    await shutdownPiezoStreamServer()
  }
  catch (error) {
    console.error('Error shutting down piezo stream server:', error)
  }

  // Step 2b: Shutdown MQTT bridge (publish offline + close client cleanly)
  try {
    await shutdownMqttBridge()
  }
  catch (error) {
    console.error('Error shutting down MQTT bridge:', error)
  }

  // Step 3: Stop Bonjour announcement
  try {
    stopBonjourAnnouncement()
  }
  catch (error) {
    console.error('Error stopping Bonjour:', error)
  }

  // Step 3a: Stop HomeKit bridge (unpublish HAP mDNS, close TCP listener)
  try {
    await shutdownHomeKit()
  }
  catch (error) {
    console.error('Error shutting down HomeKit:', error)
  }

  // Step 4: Stop auto-off / auto-on watchers (await in-flight power calls)
  try {
    await stopAutoOffWatcher()
  }
  catch (error) {
    console.error('Error stopping auto-off watcher:', error)
  }
  try {
    await stopAutoOnWatcher()
  }
  catch (error) {
    console.error('Error stopping auto-on watcher:', error)
  }

  // Step 5: Shutdown DAC monitor
  try {
    await shutdownDacMonitor()
  }
  catch (error) {
    console.error('Error shutting down DacMonitor:', error)
  }

  // Step 6: Stop biometrics retention and health sampling before closing DB
  try {
    stopBiometricsRetention()
    stopAutomationRunsRetention()
    stopHealthSampler()
    stopBiometricRuntime()
  }
  catch (error) {
    console.error('Error stopping biometrics retention:', error)
  }

  // Drain shadow workers before closing database connections.
  try {
    const { stopShadowService } = await import('@/src/biometrics/shadow/service-host')
    await stopShadowService()
  }
  catch (error) {
    console.error('Error stopping biometric shadow service:', error)
  }

  // Drain replay work before closing its database connections.
  try {
    await stopBacktestHost()
  }
  catch (error) {
    console.error('Error stopping biometric backtest host:', error)
  }
  try {
    await stopBiometricCoordinator()
  }
  catch (error) {
    console.error('Error stopping biometric coordinator:', error)
  }

  // Step 7: Close database connections
  try {
    stopMechanicalContext()
    closeDatabase()
    closeBiometricsDatabase()
  }
  catch (error) {
    console.error('Error closing database:', error)
  }

  process.exit(0)
}

/**
 * Register global process handlers (signal handlers, error handlers).
 * Safe to call multiple times - only registers once.
 */
function registerGlobalHandlers(): void {
  if (lifecycle.handlersRegistered) return
  lifecycle.handlersRegistered = true

  // Centralized signal handlers
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
  process.on('SIGINT', () => gracefulShutdown('SIGINT'))

  // Global unhandled rejection handler - log but don't crash
  process.on('unhandledRejection', (reason: unknown) => {
    console.error('Unhandled promise rejection:', reason)
    // Don't exit - let the process continue serving other requests
  })

  // Global uncaught exception handler - log and attempt graceful shutdown
  process.on('uncaughtException', (error: Error & { code?: string, address?: string, port?: number }) => {
    // mDNS EPERM is non-fatal — iptables blocks multicast, just log and continue
    if (error.code === 'EPERM' && error.address === '224.0.0.251' && error.port === 5353) {
      console.warn('[bonjour] mDNS send blocked by iptables (non-fatal):', error.message)
      return
    }
    console.error('Uncaught exception:', error)
    // Process state may be corrupted, attempt graceful shutdown
    gracefulShutdown('uncaughtException')
  })
}

/**
 * Retry a function with exponential backoff.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxAttempts: number = 3,
  baseDelayMs: number = 500
): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (lifecycle.isShuttingDown) throw new Error('Startup cancelled during shutdown')
    try {
      return await fn()
    }
    catch (error) {
      if (error instanceof HardwareAdmissionError) throw error
      lastError = error
      if (attempt < maxAttempts) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1)
        console.warn(
          `${label} failed (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms:`,
          error instanceof Error ? error.message : error
        )
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
  }
  throw lastError
}

/**
 * Validate hardware daemon connectivity on startup.
 * Logs a warning if unavailable but does not crash.
 */
// Hardware validation removed — the DacMonitor handles connection lifecycle.
// The DAC socket server starts first, then the monitor waits for frankenfirmware.

/**
 * Initialize the DAC hardware monitor.
 * Non-blocking — logs a warning on failure but does not crash.
 */
const initializeDacMonitor = async (): Promise<void> => {
  try {
    await getDacMonitor()
    if (lifecycle.isShuttingDown) {
      await shutdownDacMonitor()
      return
    }
  }
  catch (error) {
    console.warn(
      'WARNING: DacMonitor failed to start:',
      error instanceof Error ? error.message : error
    )
  }
}

async function initializeHardware(): Promise<void> {
  if (lifecycle.hardwareReady || lifecycle.isShuttingDown) return
  if (lifecycle.hardwarePromise) return lifecycle.hardwarePromise
  lifecycle.hardwarePromise = prepareHardware().finally(() => {
    lifecycle.hardwarePromise = null
  })
  return lifecycle.hardwarePromise
}

async function prepareHardware(): Promise<void> {
  // Rehydrate the pump stall guard from persisted un-acknowledged alerts
  // before anything that consults shouldBlock (keepalives, scheduler jobs)
  // can re-energize a side whose fault predates this boot.
  try {
    const { rehydrate } = await import('@/src/hardware/pumpStallGuard')
    rehydrate()
  }
  catch (error) {
    console.warn(
      '[pumpStallGuard] rehydration failed:',
      error instanceof Error ? error.message : error
    )
  }

  if (lifecycle.isShuttingDown) return

  // Start DAC socket server FIRST — this is the single listener on dac.sock.
  // frankenfirmware will connect to it. Everything else (DacMonitor, device
  // router, health checks) uses this server's connection.
  try {
    const { startDacServer } = await import('@/src/hardware/dacMonitor.instance')
    await startDacServer()
  }
  catch (error) {
    console.warn('[DAC] Socket server failed to start:', error instanceof Error ? error.message : error)
  }

  if (lifecycle.isShuttingDown) return

  // Start DAC monitor (non-blocking — waits for frankenfirmware to connect)
  initializeDacMonitor()
  if (lifecycle.isShuttingDown) return
  // Subscribe to configured base telemetry for interference detection; no movement.
  getBaseController()

  if (lifecycle.isShuttingDown) return
  lifecycle.hardwareReady = true
  try {
    startPiezoStreamServer()
  }
  catch (error) {
    console.warn('WARNING: Piezo stream server failed to start:', error instanceof Error ? error.message : error)
  }
  recordStartupPhase('hardware-services-started')
}

/**
 * Initialize the job scheduler
 * Safe to call multiple times - will only initialize once
 */
export async function initializeScheduler(): Promise<void> {
  if (lifecycle.isInitialized || lifecycle.isShuttingDown || lifecycle.automaticSuspended) return
  if (lifecycle.initializationPromise) return lifecycle.initializationPromise
  lifecycle.initializationPromise = initializeBackgroundServices().finally(() => {
    lifecycle.initializationPromise = null
  })
  return lifecycle.initializationPromise
}

async function initializeBackgroundServices(): Promise<void> {
  lifecycle.automaticStartupFailure = null
  try {
    await initializeHardware()
    if (lifecycle.isShuttingDown) return

    // Record System → Health's data-path history once a minute (non-blocking).
    // Started before the scheduler so a scheduler that fails to load still
    // leaves a history of the failure.
    startHealthSampler()

    // Read/Stop integrations remain available while a persisted arrangement hold
    // prevents restoring alarms or constructing any automatic command producer.
    startObservability()
    const admission = captureHardwareIntent()
    const assertStarting = () => {
      assertHardwareWriteCurrent(admission)
      if (lifecycle.isShuttingDown || lifecycle.automaticSuspended) throw new HardwareAdmissionError()
    }
    assertStarting()
    const { restoreActiveAlarms } = await import('@/src/hardware/alarmState')
    const { restoreSnoozes } = await import('@/src/hardware/snoozeManager')
    assertStarting()
    await restoreActiveAlarms()
    assertStarting()
    restoreSnoozes()

    const schedulerStartedAt = performance.now()
    console.log('Initializing job scheduler...')
    const jobManager = await withRetry(
      () => {
        assertStarting()
        return getJobManager()
      },
      'Job manager initialization'
    )
    assertStarting()
    recordStartupPhase('scheduler-ready', schedulerStartedAt)
    const scheduler = jobManager.getScheduler()
    const jobs = scheduler.getJobs()

    console.log(`Job scheduler initialized with ${jobs.length} scheduled jobs`)

    // Log next scheduled jobs for visibility
    const upcomingJobs = jobs
      .map((job) => {
        const nextRun = scheduler.getNextInvocation(job.id)
        return {
          id: job.id,
          type: job.type,
          nextRun: nextRun ? nextRun.toISOString() : 'N/A',
        }
      })
      .filter(job => job.nextRun !== 'N/A')
      .sort((a, b) => {
        if (a.nextRun === 'N/A' || b.nextRun === 'N/A') return 0
        return new Date(a.nextRun).getTime() - new Date(b.nextRun).getTime()
      })
      .slice(0, 5)

    if (upcomingJobs.length > 0) {
      console.log('Next scheduled jobs:')
      for (const job of upcomingJobs) {
        console.log(`  - ${job.id}: ${job.nextRun}`)
      }
    }

    lifecycle.isInitialized = true

    // Start auto-off watcher (polls biometrics DB for bed-exit events)
    startAutoOffWatcher()

    // Start auto-on watcher (experimental: powers a side on when a person settles in)
    startAutoOnWatcher()

    // Boot the Autopilot rules engine beside the scheduler (non-blocking).
    // Shares the same hardware path; no-op until automations are created.
    lifecycle.automaticPromise = getAutomationEngine().catch((error) => {
      if (error instanceof HardwareAdmissionError) throw error
      lifecycle.automaticStartupFailure = error
      console.warn('[automation] engine failed to start:', error instanceof Error ? error.message : error)
    }).then(async () => {
      if (lifecycle.isShuttingDown || lifecycle.automaticSuspended) return shutdownAutomationEngine()
      assertStarting()
      await startTemperatureController()
      if (lifecycle.isShuttingDown || lifecycle.automaticSuspended) return stopTemperatureController()
      assertStarting()
      initializeKeepalives()
      await startComfortPreview()
      if (lifecycle.isShuttingDown || lifecycle.automaticSuspended) return stopComfortPreview()
      assertStarting()
    }).catch(async (error) => {
      lifecycle.automaticStartupFailure = error
      if (error instanceof HardwareAdmissionError) {
        await Promise.allSettled([shutdownKeepalives(), shutdownAutomationEngine(), stopTemperatureController(), stopComfortPreview()])
        return
      }
      console.warn(
        '[temperature] controller failed to start:',
        error instanceof Error ? error.message : error,
      )
    }).finally(() => { lifecycle.automaticPromise = null })
  }
  catch (error) {
    lifecycle.isInitialized = false
    lifecycle.automaticStartupFailure = error
    if (error instanceof HardwareAdmissionError) return
    console.error('Failed to initialize job scheduler:', error)
    // Don't crash the app if scheduler fails to initialize
  }
}

/** Diagnostics, discovery and explicit Stop are still usable during attended recovery. */
function startObservability(): void {
  if (lifecycle.observabilityReady || lifecycle.isShuttingDown) return
  lifecycle.observabilityReady = true
  void startMqttBridge().then(() => {
    if (lifecycle.isShuttingDown) return shutdownMqttBridge()
    recordStartupPhase('mqtt-started')
  }).catch(error => console.warn('WARNING: MQTT bridge failed to start:', error instanceof Error ? error.message : error))
  startBonjourAnnouncement()
  void startHomeKitIfEnabled().then(() => {
    if (lifecycle.isShuttingDown) return shutdownHomeKit()
  }).catch(error => console.warn('[homekit] startup failed:', error instanceof Error ? error.message : error))
  startBiometricsRetention()
  startAutomationRunsRetention()
}

/** Call after persisting the hardware hold. Drain producers without closing diagnostic connections. */
export function suspendAutomaticServices(): Promise<void> {
  if (lifecycle.suspension) return lifecycle.suspension
  lifecycle.automaticSuspended = true
  lifecycle.isInitialized = false
  lifecycle.suspension = (async () => {
    // Cancel the scheduler's clock wait before waiting for initialization to settle.
    const results = await Promise.allSettled([shutdownJobManager, shutdownAutomationEngine].map(stop => Promise.resolve().then(stop)))
    await lifecycle.initializationPromise
    const stopped = await Promise.allSettled([
      shutdownKeepalives, stopComfortPreview, stopTemperatureController, stopAutoOnWatcher, stopAutoOffWatcher,
      async () => { (await import('@/src/hardware/snoozeManager')).suspendSnoozes() },
    ].map(stop => Promise.resolve().then(stop)))
    await lifecycle.automaticPromise
    // An alarm callback already inside a side lock can arm its timer after the
    // hardware reply. Drain that callback before clearing the last alarm timers.
    const drained = await Promise.allSettled([Promise.resolve().then(async () => {
      await (await import('@/src/hardware/sideLock')).waitForSideOperations()
      await (await import('@/src/hardware/alarmState')).suspendActiveAlarms()
    })])
    const failures = [...results, ...stopped, ...drained].filter(result => result.status === 'rejected')
    lifecycle.automaticStopFailed = failures.length > 0
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Automatic services did not finish stopping')
  })().finally(() => { lifecycle.suspension = null })
  return lifecycle.suspension
}

/** A verified recovery/cancellation releases durable admission before requesting a fresh start. */
export async function resumeAutomaticServices(): Promise<void> {
  await lifecycle.suspension
  assertHardwareWriteCurrent(captureHardwareIntent())
  if (lifecycle.isShuttingDown) throw new Error('Controller is shutting down')
  if (lifecycle.automaticStopFailed) throw new Error('Automatic services must finish stopping before resuming')
  lifecycle.automaticSuspended = false
  try {
    await initializeScheduler()
    await lifecycle.automaticPromise
    assertHardwareWriteCurrent(captureHardwareIntent())
    if (!lifecycle.isInitialized || lifecycle.automaticSuspended || lifecycle.isShuttingDown || lifecycle.automaticStartupFailure) {
      throw new Error('Automatic services could not resume', { cause: lifecycle.automaticStartupFailure })
    }
  }
  catch (error) {
    // A partial resume must not leave unattended producers running behind a failed result.
    await suspendAutomaticServices()
    throw error
  }
}

export async function registerNodeInstrumentation(): Promise<void> {
  // Register global handlers first (before any initialization that could fail)
  registerGlobalHandlers()
  startPerformanceMonitoring()
  const migrationsStartedAt = performance.now()

  // Run pending database migrations before starting the app
  const { runMigrations, seedDefaultData } = await import('@/src/db/migrate')
  await runMigrations()
  await seedDefaultData()
  recordStartupPhase('migrations-ready', migrationsStartedAt)
  const [{ db, sqlite, biometricsDb }, { startBiometricRuntime }] = await Promise.all([
    import('@/src/db'), import('@/src/biometrics/profiles/runtime-host'),
  ])
  const { startHardwareAdmission } = await import('@/src/hardware/admissionRuntime')
  // Install before alarm restoration, schedulers or keepalives. A persisted hold
  // stays closed across restart; unreadable storage still permits explicit Stop.
  startHardwareAdmission(sqlite)
  startBiometricRuntime(db, biometricsDb)

  // Skip hardware initialization in CI — no dac.sock, no sensors, no scheduler needed.
  // The server still starts and serves API routes (including /api/openapi.json).
  if (process.env.CI) {
    console.log('CI environment detected — skipping hardware initialization')
    return
  }

  const { startPersonalHistoryIngestion } = await import('@/src/household/historyIngestionRuntime')
  if (lifecycle.isShuttingDown) return
  startPersonalHistoryIngestion(sqlite, biometricsDb.$client)

  startMechanicalContext()

  // Validate and auto-repair iptables rules (mDNS, LAN access, NTP)
  try {
    const { checkAndRepairIptables } = await import('@/src/hardware/iptablesCheck')
    const result = checkAndRepairIptables()
    if (result.repaired.length > 0) {
      console.warn(`[startup] Repaired ${result.repaired.length} missing iptables rules:`, result.repaired.join(', '))
    }
    else if (result.ok) {
      console.log('[startup] iptables rules verified')
    }
  }
  catch (e) {
    console.warn('[startup] iptables check skipped:', e instanceof Error ? e.message : e)
  }

  await initializeHardware()
  if (lifecycle.isShuttingDown) return
  startDatabaseIntegrityChecks()
  const { startConfiguredBacktestHost } = await import('@/src/biometrics/backtest/host-startup')
  if (lifecycle.isShuttingDown) return
  startConfiguredBacktestHost(biometricsDb)
  const { startConfiguredShadowService } = await import('@/src/biometrics/shadow/startup')
  if (lifecycle.isShuttingDown) return
  startConfiguredShadowService(db, biometricsDb)
  // The clock gate and scheduler loading still finish before scheduled writers
  // start, but no longer prevent clients from loading settings or diagnostics.
  void initializeScheduler()
  recordStartupPhase('http-initialization-ready')
}
