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

/**
 * Load timezone from database with fallback to safe default.
 */
async function loadTimezone(): Promise<string> {
  try {
    const [settings] = await db.select().from(deviceSettings).limit(1)
    return settings?.timezone || DEFAULT_TIMEZONE
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
 */
export async function getJobManager(): Promise<JobManager> {
  if (!jobManagerInstance) {
    const timezone = await loadTimezone()

    jobManagerInstance = new JobManager(timezone)
    await jobManagerInstance.loadSchedules()

    console.log('JobManager initialized with timezone:', timezone)
  }

  return jobManagerInstance
}

/**
 * Shutdown the global JobManager instance
 */
export async function shutdownJobManager(): Promise<void> {
  if (jobManagerInstance) {
    await jobManagerInstance.shutdown()
    jobManagerInstance = null
    console.log('JobManager shut down')
  }
}
