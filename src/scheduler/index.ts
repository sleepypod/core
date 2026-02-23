/**
 * Job scheduler module for automated pod control.
 *
 * This module provides a robust scheduling system for:
 * - Temperature schedules (per side, per day)
 * - Power schedules (on/off times)
 * - Alarm schedules (vibration patterns)
 * - Daily priming
 * - Daily system reboots
 *
 * All schedules are timezone-aware and automatically reload when
 * database changes occur.
 *
 * @example
 * ```typescript
 * import { JobManager } from './scheduler'
 *
 * const manager = new JobManager('America/Los_Angeles')
 * await manager.loadSchedules()
 *
 * // Reload after schedule changes
 * await manager.reloadSchedules()
 *
 * // Update timezone
 * await manager.updateTimezone('America/New_York')
 *
 * // Graceful shutdown
 * await manager.shutdown()
 * ```
 */

export { Scheduler } from './scheduler'
export { JobManager } from './jobManager'
export { JobType, type ScheduledJob, type SchedulerConfig, type JobExecutionResult, type SchedulerEvents } from './types'
