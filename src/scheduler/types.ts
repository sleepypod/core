import type { Job } from 'node-schedule'

/**
 * Job types supported by the scheduler
 */
export enum JobType {
  TEMPERATURE = 'temperature',
  POWER_ON = 'power_on',
  POWER_OFF = 'power_off',
  ALARM = 'alarm',
  PRIME = 'prime',
  CALIBRATION = 'calibration',
  REBOOT = 'reboot',
  RUN_ONCE = 'run_once',
}

/**
 * Scheduler configuration
 */
export interface SchedulerConfig {
  timezone: string
  enabled: boolean
}

/**
 * Scheduled job metadata
 */
export interface ScheduledJob {
  id: string
  type: JobType
  side?: 'left' | 'right'
  schedule: string // Cron expression
  job: Job
  metadata?: Record<string, unknown>
}

/**
 * Job execution result
 */
export interface JobExecutionResult {
  success: boolean
  error?: string
  timestamp: Date
}

/**
 * Scheduler events
 */
export interface SchedulerEvents {
  jobScheduled: (job: ScheduledJob) => void
  jobExecuted: (jobId: string, result: JobExecutionResult) => void
  jobCancelled: (jobId: string) => void
  jobError: (jobId: string, error: Error) => void
}
