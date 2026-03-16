/**
 * Server startup and process lifecycle management (Node.js runtime only).
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
 * - `startNodeServer()` — called from `instrumentation.ts` register() hook.
 * - `initializeScheduler()` — idempotent, safe to call from app code as a fallback.
 */

import { getJobManager, shutdownJobManager } from '@/src/scheduler'
import { closeDatabase, closeBiometricsDatabase } from '@/src/db'
import { createHardwareClient } from '@/src/hardware/client'
import { getDacMonitor, shutdownDacMonitor } from '@/src/hardware/dacMonitor.instance'

const DAC_SOCK_PATH = process.env.DAC_SOCK_PATH || '/run/dac.sock'

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

  // Step 1: Shutdown scheduler (waits for in-flight jobs internally)
  try {
    await shutdownJobManager()
  }
  catch (error) {
    console.error('Error shutting down scheduler:', error)
  }

  // Step 2: Shutdown DAC monitor
  try {
    await shutdownDacMonitor()
  }
  catch (error) {
    console.error('Error shutting down DacMonitor:', error)
  }

  // Step 3: Close database connections
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
  process.on('uncaughtException', (error: Error) => {
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
async function validateHardware(): Promise<void> {
  try {
    const client = await withRetry(
      () => createHardwareClient({ socketPath: DAC_SOCK_PATH, connectionTimeout: 5000 }),
      'Hardware validation',
      3,
      1000
    )
    client.disconnect()
    console.log('Hardware daemon connectivity verified')
  }
  catch (error) {
    console.warn(
      'WARNING: Hardware daemon is not available at',
      DAC_SOCK_PATH,
      '-',
      error instanceof Error ? error.message : error
    )
    console.warn('Scheduled jobs that require hardware will fail until the daemon is running')
  }
}

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
 * Initialize the job scheduler.
 * Safe to call multiple times - will only initialize once.
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

    // Validate hardware connectivity (non-blocking, runs after scheduler is ready)
    validateHardware()

    // Start DAC monitor (non-blocking, logs warning on failure)
    initializeDacMonitor()
  }
  catch (error) {
    console.error('Failed to initialize job scheduler:', error)
    // Don't crash the app if scheduler fails to initialize
  }
}

/**
 * Main entry point called from instrumentation.ts register() hook.
 */
export async function startNodeServer(): Promise<void> {
  registerGlobalHandlers()
  await initializeScheduler()
}
