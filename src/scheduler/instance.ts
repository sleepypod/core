/**
 * Global JobManager singleton instance
 *
 * This ensures only one scheduler runs across the application.
 * The instance is initialized on first import with the system timezone.
 */

import { waitForValidSystemDate } from './startupClock'
import { JobManager } from './jobManager'
import { db } from '@/src/db'
import { deviceSettings } from '@/src/db/schema'

const DEFAULT_TIMEZONE = 'America/Los_Angeles'

const globalState = globalThis as typeof globalThis & {
  __sp_job_manager__?: {
    instance: JobManager | null
    pending: Promise<JobManager> | null
    timezone: string | null
    abort: AbortController | null
    shutdown: Promise<void> | null
  }
}
function state() {
  return globalState.__sp_job_manager__ ??= { instance: null, pending: null, timezone: null, abort: null, shutdown: null }
}

/**
 * Load timezone from database with fallback to safe default.
 * Caches the result on first successful read to ensure consistent
 * timezone across retries if loadSchedules() fails.
 */
async function loadTimezone(): Promise<string> {
  const cachedTimezone = state().timezone
  if (cachedTimezone) {
    return cachedTimezone
  }

  try {
    const [settings] = await db.select().from(deviceSettings).limit(1)
    const tz = settings?.timezone || DEFAULT_TIMEZONE
    state().timezone = tz
    return tz
  }
  catch (error) {
    console.warn(
      'Failed to load timezone from database, using default:',
      error instanceof Error ? error.message : error
    )
    return DEFAULT_TIMEZONE
  }
}

/**
 * Get or create the global JobManager instance
 * Uses single-flight pattern to prevent race conditions
 */
export async function getJobManager(): Promise<JobManager> {
  const s = state()
  if (s.shutdown) throw new Error('JobManager is shutting down')
  // If already initialized, return immediately
  if (s.instance) {
    return s.instance
  }

  // If initialization is in progress, await it
  if (s.pending) {
    return s.pending
  }

  // Start initialization
  const controller = new AbortController()
  state().abort = controller
  const pending = (async () => {
    try {
      await waitForValidSystemDate(24, 5_000, controller.signal)
      const timezone = await loadTimezone()

      controller.signal.throwIfAborted()
      const manager = new JobManager(timezone)
      try {
        await manager.loadSchedules()
        controller.signal.throwIfAborted()
      }
      catch (error) {
        // loadSchedules can throw after registering some jobs; the discarded
        // manager's node-schedule timers would keep firing, and a successful
        // retry would register duplicates → double hardware commands.
        try {
          await manager.shutdown()
        }
        catch (shutdownError) {
          console.warn(
            'Failed to clean up partially-initialized JobManager:',
            shutdownError instanceof Error ? shutdownError.message : shutdownError,
          )
        }
        throw error
      }

      state().instance = manager
      console.log('JobManager initialized with timezone:', timezone)

      return manager
    }
    finally {
      // Clear the promise to allow subsequent calls to check state().instance or retry on failure
      if (state().abort === controller) {
        state().pending = null
        state().abort = null
      }
    }
  })()

  s.pending = pending
  return pending
}

/**
 * Shutdown the global JobManager instance
 */
export function shutdownJobManager(): Promise<void> {
  const s = state()
  if (s.shutdown) return s.shutdown
  const pending = s.pending
  const manager = s.instance
  s.abort?.abort()
  // Keep the published initialization until its cancellation cleanup finishes;
  // otherwise a new caller can construct a second manager while the old one is
  // still registering jobs. Shutdown also precedes closing its database.
  s.shutdown = (async () => {
    await pending?.catch(() => {})
    if (manager) {
      await manager.shutdown()
      console.log('JobManager shut down')
    }
  })().finally(() => {
    s.abort = null
    s.pending = null
    s.instance = null
    s.timezone = null
    s.shutdown = null
  })
  return s.shutdown
}
