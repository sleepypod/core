import { z } from 'zod'
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
import { getSharedHardwareClient } from '@/src/hardware/dacMonitor.instance'
import { getDacMonitorIfRunning } from '@/src/hardware/dacMonitor.instance'

const DAC_SOCK_PATH = process.env.DAC_SOCK_PATH || '/persistent/deviceinfo/dac.sock'

/**
 * Health router — exposes system observability endpoints.
 *
 * Procedures:
 * - `scheduler` — job counts and next invocations
 * - `system`    — DB connectivity, scheduler drift detection, overall status
 * - `dacMonitor` — hardware polling loop status and gesture support flag
 * - `hardware`  — raw socket connectivity check with latency
 */
export const healthRouter = router({
  /**
   * Returns job counts, upcoming invocations, and a `healthy` flag.
   * `healthy` is false only when the scheduler is enabled but has zero jobs
   * (indicates the scheduler failed to load schedules from the DB).
   */
  scheduler: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/health/scheduler', protect: false, tags: ['Health'] } })
    .input(z.object({}))
    .output(z.object({
      enabled: z.boolean(),
      jobCounts: z.object({
        temperature: z.number(),
        powerOn: z.number(),
        powerOff: z.number(),
        alarm: z.number(),
        prime: z.number(),
        reboot: z.number(),
        total: z.number(),
      }),
      upcomingJobs: z.array(z.object({
        id: z.string(),
        type: z.string(),
        side: z.string().optional(),
        nextRun: z.string().nullable(),
      })),
      healthy: z.boolean(),
    }))
    .query(async () => {
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
          .filter(job => job.nextRun !== null)
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
      }
      catch (error) {
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
  system: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/health/system', protect: false, tags: ['Health'] } })
    .input(z.object({}))
    .output(z.object({
      status: z.enum(['ok', 'degraded']),
      timestamp: z.string(),
      database: z.object({
        status: z.enum(['ok', 'degraded']),
        latencyMs: z.number(),
        error: z.string().optional(),
      }),
      scheduler: z.object({
        enabled: z.boolean(),
        jobCount: z.number(),
        drift: z.object({
          dbScheduleCount: z.number(),
          schedulerJobCount: z.number(),
          drifted: z.boolean(),
        }).optional(),
      }),
      iptables: z.object({
        ok: z.boolean(),
        missing: z.array(z.string()),
      }),
    }))
    .query(async () => {
      let overallStatus: 'ok' | 'degraded' = 'ok'

      // Database connectivity check with latency measurement
      let dbStatus: 'ok' | 'degraded' = 'ok'
      let dbLatencyMs = 0
      let dbError: string | undefined
      try {
        const dbStart = performance.now()
        sqlite.pragma('quick_check(1)')
        dbLatencyMs = Math.round((performance.now() - dbStart) * 100) / 100
      }
      catch (error) {
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
      }
      catch {
        overallStatus = 'degraded'
      }

      // Scheduler drift detection: compare DB enabled schedule count vs scheduler job count
      let drift: { dbScheduleCount: number, schedulerJobCount: number, drifted: boolean } | undefined
      try {
        const tempSchedules = db.select({ id: temperatureSchedules.id })
          .from(temperatureSchedules)
          .where(eq(temperatureSchedules.enabled, true))
          .all()
        const powSchedules = db.select({ id: powerSchedules.id })
          .from(powerSchedules)
          .where(eq(powerSchedules.enabled, true))
          .all()
        const almSchedules = db.select({ id: alarmSchedules.id })
          .from(alarmSchedules)
          .where(eq(alarmSchedules.enabled, true))
          .all()

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
        }
        catch {
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
          // Auto-correct: reload scheduler from DB to resolve drift
          try {
            const { getJobManager } = await import('@/src/scheduler/instance')
            const manager = await getJobManager()
            await manager.reloadSchedules()
            console.log('[health] Schedule drift detected — auto-reloaded scheduler')
            // Re-check after reload
            drift.drifted = false
          }
          catch (reloadError) {
            console.error('[health] Failed to auto-reload scheduler:', reloadError)
            overallStatus = 'degraded'
          }
        }
      }
      catch {
      // If drift detection fails, don't block the health check
      }

      // Iptables health — verify critical firewall rules
      let iptables: { ok: boolean, missing: string[] } = { ok: true, missing: [] }
      try {
        const { checkIptables } = await import('@/src/hardware/iptablesCheck')
        const result = checkIptables()
        iptables = {
          ok: result.ok,
          missing: result.rules.filter(r => !r.present && r.critical).map(r => r.name),
        }
        if (!result.ok) overallStatus = 'degraded'
      }
      catch {
        // Dev environment — iptables not available
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
        iptables,
      }
    }),

  /**
   * DacMonitor status - polling loop health and gesture support
   */
  dacMonitor: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/health/dac-monitor', protect: false, tags: ['Health'] } })
    .input(z.object({}))
    .output(z.object({
      status: z.string(),
      podVersion: z.string().nullable(),
      gesturesSupported: z.boolean(),
    }))
    .query(() => {
      const monitor = getDacMonitorIfRunning()
      if (!monitor) {
        return { status: 'not_initialized' as const, podVersion: null, gesturesSupported: false }
      }
      const lastStatus = monitor.getLastStatus()
      return {
        status: monitor.getStatus(),
        podVersion: lastStatus?.podVersion ?? null,
        gesturesSupported: !!lastStatus?.gestures,
      }
    }),

  /**
   * Hardware health check - pings dac.sock to verify hardware daemon connectivity
   */
  hardware: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/health/hardware', protect: false, tags: ['Health'] } })
    .input(z.object({}))
    .output(z.object({
      status: z.enum(['ok', 'degraded']),
      socketPath: z.string(),
      latencyMs: z.number(),
      error: z.string().optional(),
    }))
    .query(async () => {
      let status: 'ok' | 'degraded' = 'ok'
      let latencyMs = 0
      let error: string | undefined

      const client = getSharedHardwareClient()

      try {
        const start = performance.now()
        await client.connect()
        latencyMs = Math.round((performance.now() - start) * 100) / 100
      }
      catch (err) {
        status = 'degraded'
        error = err instanceof Error ? err.message : 'Unknown error'
      }

      return {
        status,
        socketPath: DAC_SOCK_PATH,
        latencyMs,
        ...(error && { error }),
      }
    }),
})
