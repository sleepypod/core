import { TRPCError } from '@trpc/server'
import { publicProcedure, router } from '@/src/server/trpc'
import { getJobManager } from '@/src/scheduler'
import { JobType } from '@/src/scheduler/types'
import { db, sqlite } from '@/src/db'
import {
  temperatureSchedules,
  powerSchedules,
  alarmSchedules,
} from '@/src/db/schema'
import { eq } from 'drizzle-orm'
import { HardwareClient } from '@/src/hardware/client'

const DAC_SOCK_PATH = process.env.DAC_SOCK_PATH || '/run/dac.sock'

/**
 * Health router - monitors system health including scheduler
 */
export const healthRouter = router({
  /**
   * Get scheduler health status
   */
  scheduler: publicProcedure.query(async () => {
    try {
      const jobManager = await getJobManager()
      const scheduler = jobManager.getScheduler()
      const jobs = scheduler.getJobs()

      // Count jobs by type
      const jobCounts = {
        temperature: 0,
        powerOn: 0,
        powerOff: 0,
        alarm: 0,
        prime: 0,
        reboot: 0,
        total: jobs.length,
      }

      for (const job of jobs) {
        switch (job.type) {
          case JobType.TEMPERATURE:
            jobCounts.temperature++
            break
          case JobType.POWER_ON:
            jobCounts.powerOn++
            break
          case JobType.POWER_OFF:
            jobCounts.powerOff++
            break
          case JobType.ALARM:
            jobCounts.alarm++
            break
          case JobType.PRIME:
            jobCounts.prime++
            break
          case JobType.REBOOT:
            jobCounts.reboot++
            break
        }
      }

      // Get next scheduled execution times
      const upcomingJobs = jobs
        .map((job) => {
          const nextInvocation = scheduler.getNextInvocation(job.id)
          return {
            id: job.id,
            type: job.type,
            side: job.metadata?.side as string | undefined,
            nextRun: nextInvocation?.toISOString() || null,
          }
        })
        .filter((job) => job.nextRun !== null)
        .sort((a, b) => {
          if (!a.nextRun || !b.nextRun) return 0
          return new Date(a.nextRun).getTime() - new Date(b.nextRun).getTime()
        })
        .slice(0, 10) // Return next 10 upcoming jobs

      return {
        enabled: scheduler.isEnabled(),
        jobCounts,
        upcomingJobs,
        healthy: jobs.length > 0 || jobCounts.total === 0, // Healthy if has jobs or expected to have none
      }
    } catch (error) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: `Failed to get scheduler health: ${error instanceof Error ? error.message : 'Unknown error'}`,
        cause: error,
      })
    }
  }),

  /**
   * Overall system health check with database connectivity and scheduler drift detection
   */
  system: publicProcedure.query(async () => {
    let overallStatus: 'ok' | 'degraded' = 'ok'

    // Database connectivity check with latency measurement
    let dbStatus: 'ok' | 'degraded' = 'ok'
    let dbLatencyMs = 0
    let dbError: string | undefined
    try {
      const dbStart = performance.now()
      sqlite.pragma('quick_check(1)')
      dbLatencyMs = Math.round((performance.now() - dbStart) * 100) / 100
    } catch (error) {
      dbStatus = 'degraded'
      overallStatus = 'degraded'
      dbError = error instanceof Error ? error.message : 'Unknown error'
    }

    // Scheduler health
    let schedulerEnabled = false
    let schedulerJobCount = 0
    try {
      const jobManager = await getJobManager()
      const scheduler = jobManager.getScheduler()
      schedulerEnabled = scheduler.isEnabled()
      schedulerJobCount = scheduler.getJobs().length
    } catch {
      overallStatus = 'degraded'
    }

    // Scheduler drift detection: compare DB enabled schedule count vs scheduler job count
    let drift: { dbScheduleCount: number; schedulerJobCount: number; drifted: boolean } | undefined
    try {
      const [tempSchedules, powSchedules, almSchedules] = await Promise.all([
        db.select({ id: temperatureSchedules.id })
          .from(temperatureSchedules)
          .where(eq(temperatureSchedules.enabled, true)),
        db.select({ id: powerSchedules.id })
          .from(powerSchedules)
          .where(eq(powerSchedules.enabled, true)),
        db.select({ id: alarmSchedules.id })
          .from(alarmSchedules)
          .where(eq(alarmSchedules.enabled, true)),
      ])

      // Each power schedule creates 2 jobs (on + off), others create 1 each
      const expectedJobCount = tempSchedules.length + (powSchedules.length * 2) + almSchedules.length

      const systemJobTypes = [JobType.PRIME, JobType.REBOOT]
      let systemJobCount = 0
      try {
        const jobManager = await getJobManager()
        const scheduler = jobManager.getScheduler()
        for (const job of scheduler.getJobs()) {
          if (systemJobTypes.includes(job.type)) {
            systemJobCount++
          }
        }
      } catch {
        // Already handled above
      }

      const actualUserJobs = schedulerJobCount - systemJobCount
      const drifted = expectedJobCount !== actualUserJobs
      drift = {
        dbScheduleCount: expectedJobCount,
        schedulerJobCount: actualUserJobs,
        drifted,
      }
      if (drifted) {
        overallStatus = 'degraded'
      }
    } catch {
      // If drift detection fails, don't block the health check
    }

    return {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      database: {
        status: dbStatus,
        latencyMs: dbLatencyMs,
        ...(dbError && { error: dbError }),
      },
      scheduler: {
        enabled: schedulerEnabled,
        jobCount: schedulerJobCount,
        ...(drift && { drift }),
      },
    }
  }),

  /**
   * Hardware health check - pings dac.sock to verify hardware daemon connectivity
   */
  hardware: publicProcedure.query(async () => {
    let status: 'ok' | 'degraded' = 'ok'
    let latencyMs = 0
    let error: string | undefined

    const client = new HardwareClient({
      socketPath: DAC_SOCK_PATH,
      connectionTimeout: 5000,
      autoReconnect: false,
    })

    try {
      const start = performance.now()
      await client.connect()
      latencyMs = Math.round((performance.now() - start) * 100) / 100
    } catch (err) {
      status = 'degraded'
      error = err instanceof Error ? err.message : 'Unknown error'
    } finally {
      client.disconnect()
    }

    return {
      status,
      socketPath: DAC_SOCK_PATH,
      latencyMs,
      ...(error && { error }),
    }
  }),
})
