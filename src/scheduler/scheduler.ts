import * as schedule from 'node-schedule'
import { EventEmitter } from 'events'
import { JobType } from './types'
import type {
  ScheduledJob,
  SchedulerConfig,
  JobExecutionResult,
  SchedulerEvents,
} from './types'

/**
 * Job types for which transient hardware failures should be retried.
 * A failed set-point otherwise silently loses the user's target until the
 * next scheduled point, potentially hours later.
 */
const HARDWARE_JOB_TYPES: ReadonlySet<JobType> = new Set([
  JobType.TEMPERATURE,
  JobType.POWER_ON,
  JobType.POWER_OFF,
  JobType.ALARM,
  JobType.LED_BRIGHTNESS,
  JobType.RUN_ONCE,
  JobType.AWAY_MODE,
])

const HARDWARE_RETRY_ATTEMPTS = 3
const HARDWARE_RETRY_BASE_DELAY_MS = 500

/**
 * Job scheduler service for automated pod control
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class Scheduler extends EventEmitter {
  private jobs: Map<string, ScheduledJob> = new Map()
  private config: SchedulerConfig
  private inFlightJobs: Set<string> = new Set()

  constructor(config: SchedulerConfig) {
    super()
    this.config = config
  }

  /**
   * Read the currently configured timezone. Exposed so callers (e.g. JobManager)
   * can convert wall-clock times to the user's zone without reaching into config.
   */
  getTimezone(): string {
    return this.config.timezone
  }

  /**
   * Schedule a job with cron expression
   */
  scheduleJob(
    id: string,
    type: JobType,
    cronExpression: string,
    handler: () => Promise<void>,
    metadata?: Record<string, unknown>
  ): ScheduledJob {
    // Cancel existing job with same ID
    this.cancelJob(id)

    // Create new job
    const job = schedule.scheduleJob(
      {
        tz: this.config.timezone,
        rule: cronExpression,
      },
      async () => {
        const result = await this.executeJob(id, type, handler)
        this.emit('jobExecuted', id, result)
      }
    )

    if (!job) {
      throw new Error(`Failed to schedule job: ${id}`)
    }

    const scheduledJob: ScheduledJob = {
      id,
      type,
      schedule: cronExpression,
      job,
      metadata,
    }

    this.jobs.set(id, scheduledJob)
    this.emit('jobScheduled', scheduledJob)

    return scheduledJob
  }

  /**
   * Schedule a one-time job that fires at an absolute Date.
   * Auto-removes from the jobs map after firing.
   */
  scheduleOneTimeJob(
    id: string,
    type: JobType,
    fireDate: Date,
    handler: () => Promise<void>,
    metadata?: Record<string, unknown>,
  ): ScheduledJob {
    this.cancelJob(id)

    const job = schedule.scheduleJob(fireDate, async () => {
      const result = await this.executeJob(id, type, handler)
      this.emit('jobExecuted', id, result)
      this.jobs.delete(id)
    })

    if (!job) {
      throw new Error(`Failed to schedule one-time job: ${id} at ${fireDate.toISOString()}`)
    }

    const scheduledJob: ScheduledJob = {
      id,
      type,
      schedule: fireDate.toISOString(),
      job,
      metadata,
      oneTime: true,
    }

    this.jobs.set(id, scheduledJob)
    this.emit('jobScheduled', scheduledJob)
    return scheduledJob
  }

  /**
   * Execute a job and handle errors. Hardware-category jobs get bounded retries
   * with exponential backoff so a single transient failure doesn't strand the
   * user's bed at the wrong temperature until the next scheduled point.
   */
  private async executeJob(
    id: string,
    type: JobType,
    handler: () => Promise<void>
  ): Promise<JobExecutionResult> {
    const timestamp = new Date()
    this.inFlightJobs.add(id)

    const maxAttempts = HARDWARE_JOB_TYPES.has(type) ? HARDWARE_RETRY_ATTEMPTS : 1
    let lastError: unknown

    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          await handler()
          return { success: true, timestamp }
        }
        catch (error) {
          lastError = error
          if (attempt < maxAttempts) {
            const delay = HARDWARE_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)
            console.warn(
              `Job ${id} attempt ${attempt}/${maxAttempts} failed, retrying in ${delay}ms:`,
              error instanceof Error ? error.message : String(error),
            )
            await new Promise(resolve => setTimeout(resolve, delay))
          }
        }
      }

      const errorMessage = lastError instanceof Error ? lastError.message : String(lastError)
      this.emit('jobError', id, lastError as Error)
      return { success: false, error: errorMessage, timestamp }
    }
    finally {
      this.inFlightJobs.delete(id)
    }
  }

  /**
   * Wait for in-flight jobs to complete with a timeout
   */
  async waitForInFlightJobs(timeoutMs: number = 5000): Promise<void> {
    if (this.inFlightJobs.size === 0) return

    console.log(`Waiting for ${this.inFlightJobs.size} in-flight job(s) to complete...`)

    const start = Date.now()
    while (this.inFlightJobs.size > 0 && Date.now() - start < timeoutMs) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    if (this.inFlightJobs.size > 0) {
      console.warn(
        `Force shutdown with ${this.inFlightJobs.size} in-flight job(s) still running: ${[...this.inFlightJobs].join(', ')}`
      )
    }
  }

  /**
   * Cancel a scheduled job
   */
  cancelJob(id: string): boolean {
    const scheduledJob = this.jobs.get(id)

    if (scheduledJob) {
      scheduledJob.job.cancel()
      this.jobs.delete(id)
      this.emit('jobCancelled', id)
      return true
    }

    return false
  }

  /**
   * Cancel all jobs
   */
  cancelAllJobs(): void {
    for (const [id, scheduledJob] of this.jobs.entries()) {
      scheduledJob.job.cancel()
      this.emit('jobCancelled', id)
    }

    this.jobs.clear()
  }

  /**
   * Cancel all recurring (cron) jobs, preserving one-time fire-date jobs.
   * Used by reloadSchedules to avoid dropping active one-shots (run-once
   * sessions, away-mode start/return transitions) whose Date has not yet passed.
   */
  cancelRecurringJobs(): void {
    for (const [id, scheduledJob] of this.jobs.entries()) {
      if (scheduledJob.oneTime) continue
      scheduledJob.job.cancel()
      this.emit('jobCancelled', id)
      this.jobs.delete(id)
    }
  }

  /**
   * Get all scheduled jobs
   */
  getJobs(): ScheduledJob[] {
    return Array.from(this.jobs.values())
  }

  /**
   * Get job by ID
   */
  getJob(id: string): ScheduledJob | undefined {
    return this.jobs.get(id)
  }

  /**
   * Get jobs by type
   */
  getJobsByType(type: JobType): ScheduledJob[] {
    return Array.from(this.jobs.values()).filter(job => job.type === type)
  }

  /**
   * Check if scheduler is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled
  }

  /**
   * Update scheduler configuration.
   *
   * NOTE: Timezone changes require the caller to invoke a full reload
   * (e.g. JobManager.reloadSchedules) because existing cron jobs are bound
   * to their original tz at creation time and cannot be rebound in place
   * without re-scheduling. Callers that change the timezone without
   * following up with a reload will see stale jobs firing on the old zone.
   * Use JobManager.updateTimezone for the safe path.
   */
  updateConfig(config: Partial<SchedulerConfig>): void {
    const oldTimezone = this.config.timezone
    this.config = { ...this.config, ...config }

    if (config.timezone != null && config.timezone !== oldTimezone) {
      // Existing cron jobs still carry the old tz — cancel them now so
      // they cannot fire on stale offsets before the caller reloads.
      // One-time jobs (scheduled at absolute Date) are fine as-is.
      this.cancelRecurringJobs()
    }
  }

  /**
   * Get next invocation time for a job
   */
  getNextInvocation(id: string): Date | null {
    const scheduledJob = this.jobs.get(id)
    return scheduledJob?.job.nextInvocation() || null
  }

  /**
   * Gracefully shutdown scheduler
   */
  async shutdown(): Promise<void> {
    console.log('Shutting down scheduler...')
    await this.waitForInFlightJobs(5000)
    this.cancelAllJobs()
    await schedule.gracefulShutdown()
    console.log('Scheduler shut down successfully')
  }
}

// Type-safe event emitter
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface Scheduler {
  on<K extends keyof SchedulerEvents>(
    event: K,
    listener: SchedulerEvents[K]
  ): this
  emit<K extends keyof SchedulerEvents>(
    event: K,
    ...args: Parameters<SchedulerEvents[K]>
  ): boolean
}
