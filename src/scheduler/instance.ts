/**
 * Global JobManager singleton instance
 *
 * This ensures only one scheduler runs across the application.
 * The instance is initialized on first import with the system timezone.
 */

import { JobManager } from './jobManager'
import { db } from '@/src/db'
import { deviceSettings } from '@/src/db/schema'

const DEFAULT_TIMEZONE = 'America/Los_Angeles'

let jobManagerInstance: JobManager | null = null
let jobManagerInitPromise: Promise<JobManager> | null = null
let cachedTimezone: string | null = null

/**
 * Load timezone from database with fallback to safe default.
 * Caches the result on first successful read to ensure consistent
 * timezone across retries if loadSchedules() fails.
 */
async function loadTimezone(): Promise<string> {
  if (cachedTimezone) {
    return cachedTimezone
  }

  try {
    const [settings] = await db.select().from(deviceSettings).limit(1)
    const tz = settings?.timezone || DEFAULT_TIMEZONE
    cachedTimezone = tz
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
  // If already initialized, return immediately
  if (jobManagerInstance) {
    return jobManagerInstance
  }

  // If initialization is in progress, await it
  if (jobManagerInitPromise) {
    return jobManagerInitPromise
  }

  // Start initialization
  jobManagerInitPromise = (async () => {
    try {
      const timezone = await loadTimezone()

      const manager = new JobManager(timezone)
      await manager.loadSchedules()

      jobManagerInstance = manager
      console.log('JobManager initialized with timezone:', timezone)

      return manager
    }
    finally {
      // Clear the promise to allow subsequent calls to check jobManagerInstance or retry on failure
      jobManagerInitPromise = null
    }
  })()

  return jobManagerInitPromise
}

/**
 * Shutdown the global JobManager instance
 */
export async function shutdownJobManager(): Promise<void> {
  if (jobManagerInstance) {
    await jobManagerInstance.shutdown()
    jobManagerInstance = null
    jobManagerInitPromise = null
    cachedTimezone = null
    console.log('JobManager shut down')
  }
}
