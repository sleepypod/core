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
import { closeDatabase, closeBiometricsDatabase } from '@/src/db'
import { startBiometricsRetention, stopBiometricsRetention } from '@/src/db/retention'
import { getDacMonitor, shutdownDacMonitor } from '@/src/hardware/dacMonitor.instance'
import { startPiezoStreamServer, shutdownPiezoStreamServer } from '@/src/streaming/piezoStream'
import { startBonjourAnnouncement, stopBonjourAnnouncement } from '@/src/streaming/bonjourAnnounce'
import { initializeKeepalives, shutdownKeepalives } from '@/src/services/temperatureKeepalive'
import { startAutoOffWatcher, stopAutoOffWatcher } from '@/src/services/autoOffWatcher'

let isInitialized = false
let isShuttingDown = false
let handlersRegistered = false

/**
 * Centralized graceful shutdown coordinator.
 * Sequences: wait for in-flight jobs → shutdown scheduler → close database → exit
 */
async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) return
  isShuttingDown = true

  console.log(`Received ${signal}, starting graceful shutdown...`)

  // Force exit after 10s if graceful shutdown hangs
  const forceExitTimer = setTimeout(() => {
    console.error('Graceful shutdown timed out after 10s, forcing exit')
    process.exit(1)
  }, 10_000)
  forceExitTimer.unref()

  // Step 0: Stop keepalive timers
  try {
    shutdownKeepalives()
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

  // Step 2: Shutdown piezo stream server
  try {
    await shutdownPiezoStreamServer()
  }
  catch (error) {
    console.error('Error shutting down piezo stream server:', error)
  }

  // Step 3: Stop Bonjour announcement
  try {
    stopBonjourAnnouncement()
  }
  catch (error) {
    console.error('Error stopping Bonjour:', error)
  }

  // Step 4: Stop auto-off watcher (await in-flight power-off calls)
  try {
    await stopAutoOffWatcher()
  }
  catch (error) {
    console.error('Error stopping auto-off watcher:', error)
  }

  // Step 5: Shutdown DAC monitor
  try {
    await shutdownDacMonitor()
  }
  catch (error) {
    console.error('Error shutting down DacMonitor:', error)
  }

  // Step 6: Stop biometrics retention loop before closing DB
  try {
    stopBiometricsRetention()
  }
  catch (error) {
    console.error('Error stopping biometrics retention:', error)
  }

  // Step 7: Close database connections
  try {
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
  if (handlersRegistered) return
  handlersRegistered = true

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
    try {
      return await fn()
    }
    catch (error) {
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
  }
  catch (error) {
    console.warn(
      'WARNING: DacMonitor failed to start:',
      error instanceof Error ? error.message : error
    )
  }
}

/**
 * Wait until the system clock is plausible (year >= 2024).
 * The Pod can boot with its clock reset to ~2010 before NTP syncs.
 * Schedulers must not start until the date is valid or cron jobs fire at wrong times.
 */
async function waitForValidSystemDate(
  maxAttempts: number = 24,
  intervalMs: number = 5_000
): Promise<void> {
  const MIN_VALID_YEAR = 2024
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (new Date().getFullYear() >= MIN_VALID_YEAR) return
    console.warn(
      `System clock is invalid (${new Date().toISOString()}), waiting for NTP sync...`,
      `(${attempt + 1}/${maxAttempts})`
    )
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  console.error(
    'System clock never synced after waiting — proceeding anyway.',
    'Scheduled jobs may fire at incorrect times.'
  )
}

/**
 * Initialize the job scheduler
 * Safe to call multiple times - will only initialize once
 */
export async function initializeScheduler(): Promise<void> {
  if (isInitialized) return

  try {
    await waitForValidSystemDate()
    console.log('Initializing job scheduler...')
    const jobManager = await withRetry(
      () => getJobManager(),
      'Job manager initialization'
    )
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

    isInitialized = true

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

    // Start DAC monitor (non-blocking — waits for frankenfirmware to connect)
    initializeDacMonitor()

    // Initialize temperature keepalive timers for sides with alwaysOn enabled
    initializeKeepalives()

    // Start piezo WebSocket stream server (non-blocking)
    try {
      startPiezoStreamServer()
    }
    catch (error) {
      console.warn(
        'WARNING: Piezo stream server failed to start:',
        error instanceof Error ? error.message : error
      )
    }

    // Start auto-off watcher (polls biometrics DB for bed-exit events)
    startAutoOffWatcher()

    // Start Bonjour/mDNS announcement (non-blocking)
    startBonjourAnnouncement()

    // Start biometrics time-series retention loop (non-blocking)
    startBiometricsRetention()
  }
  catch (error) {
    console.error('Failed to initialize job scheduler:', error)
    // Don't crash the app if scheduler fails to initialize
  }
}

/**
 * Next.js instrumentation hook (if supported)
 * Automatically called by Next.js on server startup
 */
export async function register(): Promise<void> {
  // Only run on server
  if (process.env.NEXT_RUNTIME === 'nodejs' || typeof window === 'undefined') {
    // Register global handlers first (before any initialization that could fail)
    registerGlobalHandlers()

    // Run pending database migrations before starting the app
    const { runMigrations, seedDefaultData } = await import('@/src/db/migrate')
    await runMigrations()
    await seedDefaultData()

    // Skip hardware initialization in CI — no dac.sock, no sensors, no scheduler needed.
    // The server still starts and serves API routes (including /api/openapi.json).
    if (process.env.CI) {
      console.log('CI environment detected — skipping hardware initialization')
      return
    }

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

    await initializeScheduler()
  }
}
