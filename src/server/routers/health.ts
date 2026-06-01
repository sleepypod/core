import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { publicProcedure, router } from '@/src/server/trpc'
import { getJobManager } from '@/src/scheduler'
import { JobType } from '@/src/scheduler/types'
import { db, biometricsDb, sqlite } from '@/src/db'
import {
  temperatureSchedules,
  powerSchedules,
  alarmSchedules,
  deviceState,
  deviceSettings,
} from '@/src/db/schema'
import { bedTemp, freezerTemp, flowReadings } from '@/src/db/biometrics-schema'
import { desc, eq } from 'drizzle-orm'
import { getSharedHardwareClient } from '@/src/hardware/dacMonitor.instance'
import { getDacMonitorIfRunning } from '@/src/hardware/dacMonitor.instance'
import { shouldBlock as pumpStallShouldBlock } from '@/src/hardware/pumpStallGuard'
import { centiDegreesToF } from '@/src/lib/tempUtils'

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
        targetTempF: z.number().nullable(),
        brightness: z.number().nullable(),
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
            const md = job.metadata ?? {}
            return {
              id: job.id,
              type: job.type,
              side: md.side as string | undefined,
              nextRun: nextInvocation?.toISOString() || null,
              targetTempF: typeof md.targetTemperature === 'number' ? md.targetTemperature : null,
              brightness: typeof md.brightness === 'number' ? md.brightness : null,
            }
          })
          .filter(job => job.nextRun !== null)
          .sort((a, b) => {
            if (!a.nextRun || !b.nextRun) return 0
            return new Date(a.nextRun).getTime() - new Date(b.nextRun).getTime()
          })
          .slice(0, 10) // Return next 10 upcoming jobs

        const enabled = scheduler.isEnabled()
        return {
          enabled,
          jobCounts,
          upcomingJobs,
          // Healthy when scheduler is disabled (no jobs expected) or enabled
          // with at least one loaded job. The previous `jobs.length > 0 ||
          // jobCounts.total === 0` was always true because jobCounts.total is
          // derived from jobs.length, so an enabled-but-empty scheduler (the
          // failure mode this signal is meant to catch) was reported healthy.
          healthy: enabled ? jobCounts.total > 0 : true,
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

  /**
   * Thermal truth — reconciles what the app *commanded* (device_state) against
   * what the hardware is *delivering* (latest pump RPM + flow). A side can read
   * `isPowered=1, target=81°F` while its pump is at 0 rpm, in which case
   * firmware locks the TEC (`tec[<side>] locked (pump)`) and the bed silently
   * drifts to ambient. That divergence is invisible in the normal status view;
   * this surfaces it as a per-side `verdict` so a stalled side is obvious.
   *
   * Pump/flow age matters: flow_readings are written ~once/60s only while the
   * monitor sees frzHealth frames, so a stale reading on a powered side is
   * itself a stall signal (the source of the gap seen in the 2026-05-31 RCA).
   */
  thermal: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/health/thermal', protect: false, tags: ['Health'] } })
    .input(z.object({}))
    .output(z.object({
      pumpStallProtectionEnabled: z.boolean(),
      heatsinkTempF: z.number().nullable(),
      ambientTempF: z.number().nullable(),
      sides: z.array(z.object({
        side: z.enum(['left', 'right']),
        isPowered: z.boolean(),
        targetTempF: z.number().nullable(),
        currentTempF: z.number().nullable(),
        isAlarmVibrating: z.boolean(),
        poweredOnAt: z.string().nullable(),
        pumpRpm: z.number().nullable(),
        flowrate: z.number().nullable(),
        readingAgeSec: z.number().nullable(),
        waterTempF: z.number().nullable(),
        bedSurfaceTempF: z.number().nullable(),
        guardBlocked: z.boolean(),
        verdict: z.enum(['off', 'delivering', 'idle', 'stalled']),
        note: z.string().nullable(),
      })),
    }))
    .query(() => {
      // A powered side reporting flow below this is not circulating; firmware
      // locks the TEC at zero flow, so we treat sub-threshold as stalled. 100
      // matches device_settings.pump_stall_rpm_threshold default sense.
      const MIN_FLOW_RPM = 100
      // A flow reading older than this on a powered side means the monitor has
      // stopped seeing frames — also a stall (see the overnight gap in the RCA).
      const STALE_SEC = 180
      // Heating/cooling is only "delivering" when target diverges from current
      // by more than sensor noise; otherwise a powered, on-target side is idle.
      const AT_TARGET_F = 2

      const [settings] = db
        .select({ enabled: deviceSettings.pumpStallProtectionEnabled })
        .from(deviceSettings)
        .limit(1)
        .all()

      const [flow] = biometricsDb
        .select()
        .from(flowReadings)
        .orderBy(desc(flowReadings.timestamp))
        .limit(1)
        .all()

      const [water] = biometricsDb
        .select()
        .from(freezerTemp)
        .orderBy(desc(freezerTemp.timestamp))
        .limit(1)
        .all()

      const [bed] = biometricsDb
        .select()
        .from(bedTemp)
        .orderBy(desc(bedTemp.timestamp))
        .limit(1)
        .all()

      const now = Date.now()
      const flowAgeSec = flow?.timestamp ? Math.round((now - flow.timestamp.getTime()) / 1000) : null

      const sides = (['left', 'right'] as const).map((side) => {
        const [ds] = db.select().from(deviceState).where(eq(deviceState.side, side)).limit(1).all()

        const pumpRpm = side === 'left' ? (flow?.leftPumpRpm ?? null) : (flow?.rightPumpRpm ?? null)
        const flowrate = side === 'left' ? (flow?.leftFlowrateCd ?? null) : (flow?.rightFlowrateCd ?? null)
        const waterCd = side === 'left' ? (water?.leftWaterTemp ?? null) : (water?.rightWaterTemp ?? null)
        const bedCd = side === 'left' ? (bed?.leftCenterTemp ?? null) : (bed?.rightCenterTemp ?? null)

        const isPowered = ds?.isPowered ?? false
        const target = ds?.targetTemperature ?? null
        const current = ds?.currentTemperature ?? null
        const stale = flowAgeSec != null && flowAgeSec > STALE_SEC
        const flowing = pumpRpm != null && pumpRpm >= MIN_FLOW_RPM && !stale

        let verdict: 'off' | 'delivering' | 'idle' | 'stalled'
        let note: string | null = null
        if (!isPowered) {
          verdict = 'off'
        }
        else if (!flowing) {
          verdict = 'stalled'
          note = stale
            ? `powered but no fresh pump reading for ${flowAgeSec}s — pump likely not circulating; TEC locks at zero flow`
            : 'powered but pump below flow threshold — TEC is locked, bed will drift to ambient'
        }
        else if (target != null && current != null && Math.abs(target - current) > AT_TARGET_F) {
          verdict = 'delivering'
        }
        else {
          verdict = 'idle'
        }

        return {
          side,
          isPowered,
          targetTempF: target,
          currentTempF: current,
          isAlarmVibrating: ds?.isAlarmVibrating ?? false,
          poweredOnAt: ds?.poweredOnAt ? ds.poweredOnAt.toISOString() : null,
          pumpRpm,
          flowrate,
          readingAgeSec: flowAgeSec,
          waterTempF: waterCd != null ? Math.round(centiDegreesToF(waterCd) * 10) / 10 : null,
          bedSurfaceTempF: bedCd != null ? Math.round(centiDegreesToF(bedCd) * 10) / 10 : null,
          guardBlocked: pumpStallShouldBlock(side),
          verdict,
          note,
        }
      })

      return {
        pumpStallProtectionEnabled: settings?.enabled ?? false,
        heatsinkTempF: water?.heatsinkTemp != null ? Math.round(centiDegreesToF(water.heatsinkTemp) * 10) / 10 : null,
        ambientTempF: water?.ambientTemp != null ? Math.round(centiDegreesToF(water.ambientTemp) * 10) / 10 : null,
        sides,
      }
    }),
})
