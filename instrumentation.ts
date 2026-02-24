/**
 * Scheduler initialization and process lifecycle management
 *
 * Handles:
 * - Job scheduler initialization with retry logic
 * - Centralized signal handling (SIGTERM/SIGINT)
 * - Global unhandled rejection/exception handlers
 * - Hardware pre-flight validation
 * - Graceful shutdown sequencing
 *
 * USAGE:
 * - If your Next.js version supports instrumentation hooks, this will be called automatically
 * - Otherwise, call `initializeScheduler()` from your app startup (e.g., in a layout or API route)
 */

import { getJobManager, shutdownJobManager } from '@/src/scheduler'
import { closeDatabase } from '@/src/db'
import { createHardwareClient } from '@/src/hardware/client'

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

  // Step 2: Close database connection
  try {
    closeDatabase()
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
 * Initialize the job scheduler
 * Safe to call multiple times - will only initialize once
 */
export async function initializeScheduler(): Promise<void> {
  if (isInitialized) return

  try {
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
    await initializeScheduler()
  }
}
