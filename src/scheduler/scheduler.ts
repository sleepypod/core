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
        const result = await this.executeJob(id, handler)
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
      const result = await this.executeJob(id, handler)
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
    }

    this.jobs.set(id, scheduledJob)
    this.emit('jobScheduled', scheduledJob)
    return scheduledJob
  }

  /**
   * Execute a job and handle errors
   */
  private async executeJob(
    id: string,
    handler: () => Promise<void>
  ): Promise<JobExecutionResult> {
    const timestamp = new Date()
    this.inFlightJobs.add(id)

    try {
      await handler()
      return { success: true, timestamp }
    }
    catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.emit('jobError', id, error as Error)
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
   * Cancel all recurring (cron) jobs, preserving one-time run-once jobs.
   * Used by reloadSchedules to avoid dropping active run-once sessions.
   */
  cancelRecurringJobs(): void {
    for (const [id, scheduledJob] of this.jobs.entries()) {
      if (scheduledJob.type === JobType.RUN_ONCE) continue
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
   * Update scheduler configuration
   */
  updateConfig(config: Partial<SchedulerConfig>): void {
    // Store old timezone before updating config
    const oldTimezone = this.config.timezone

    // Update config
    this.config = { ...this.config, ...config }

    // Reschedule all jobs with new config if timezone changed
    if (config.timezone != null && config.timezone !== oldTimezone) {
      this.rescheduleAllJobs()
    }
  }

  /**
   * Reschedule all jobs (useful after timezone change)
   */
  private rescheduleAllJobs(): void {
    const jobs = Array.from(this.jobs.values())

    for (const scheduledJob of jobs) {
      // This would require storing the original handler
      // For now, jobs need to be manually rescheduled
      console.warn(
        `Job ${scheduledJob.id} needs to be manually rescheduled after timezone change`
      )
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
