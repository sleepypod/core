import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { publicProcedure, router } from '@/src/server/trpc'
import { getJobManager } from '@/src/scheduler'
import { JobType } from '@/src/scheduler/types'
import { expandOccurrences } from '@/src/scheduler/occurrences'
import { db, biometricsDb, sqlite } from '@/src/db'
import {
  temperatureSchedules,
  powerSchedules,
  alarmSchedules,
  deviceState,
  deviceSettings,
} from '@/src/db/schema'
import { flowReadings, primeEvents } from '@/src/db/biometrics-schema'
import { desc, eq } from 'drizzle-orm'
import { getSharedHardwareClient } from '@/src/hardware/dacMonitor.instance'
import { getDacMonitorIfRunning } from '@/src/hardware/dacMonitor.instance'
import { getDatabaseIntegrity } from '@/src/db/integrity'
import { getServerPerformance } from '@/src/lib/serverPerformance'
import { getThermalHistory, THERMAL_RANGES, type ThermalRange } from '@/src/lib/thermalHistory'
import { readThermalTruth } from '@/src/lib/thermalTruth'
import { getDataPath } from '@/src/lib/dataPathCollect'
import { readHistory } from '@/src/lib/healthHistory'
import { NODES, RESTARTABLE_UNITS, STAGES } from '@/src/lib/dataPath'

const execFileAsync = promisify(execFile)

const DAC_SOCK_PATH = process.env.DAC_SOCK_PATH || '/persistent/deviceinfo/dac.sock'

const checkStatus = z.enum(['ok', 'idle', 'stale', 'down', 'unknown'])
const nodeId = z.enum(NODES.map(n => n.id) as [typeof NODES[number]['id'], ...Array<typeof NODES[number]['id']>])
const stage = z.enum(STAGES.map(s => s.id) as [typeof STAGES[number]['id'], ...Array<typeof STAGES[number]['id']>])
const unitEnum = z.enum(RESTARTABLE_UNITS)

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
  performance: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/health/performance', protect: false, tags: ['Health'] } })
    .input(z.object({}))
    .output(z.object({
      uptimeSeconds: z.number(),
      rssBytes: z.number(),
      startup: z.array(z.object({ name: z.string(), elapsedMs: z.number(), durationMs: z.number() })),
      sensorSource: z.enum(['pending', 'raw', 'nats']),
      firstFrameMs: z.number().nullable(),
      eventLoop: z.object({ meanMs: z.number(), p95Ms: z.number(), maxMs: z.number() }),
    }))
    .query(() => getServerPerformance()),

  /**
   * Returns job counts, upcoming invocations, and a `healthy` flag.
   * `healthy` is false only when the scheduler is enabled but has zero jobs
   * (indicates the scheduler failed to load schedules from the DB).
   */
  scheduler: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/health/scheduler', protect: false, tags: ['Health'] } })
    // withinHours: return every job due in that window (capped) instead of the next 10.
    .input(z.object({ withinHours: z.number().min(1).max(48).optional() }))
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
    .query(async ({ input }) => {
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
          .filter(job => input.withinHours == null || new Date(job.nextRun as string).getTime() <= Date.now() + input.withinHours * 3_600_000)
          .slice(0, input.withinHours == null ? 10 : 200) // next 10 by default

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
   * Every loaded job with its cron, plus each time the jobs fire from 24 h ago
   * to `days` ahead. Feeds the System → Scheduler nightly timeline, which needs
   * the whole week rather than the next 10 invocations `scheduler` returns.
   */
  schedulerTimeline: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/health/scheduler-timeline', protect: false, tags: ['Health'] } })
    .input(z.object({ days: z.number().int().min(1).max(8).default(8) }))
    .output(z.object({
      enabled: z.boolean(),
      timezone: z.string(),
      now: z.number(),
      jobs: z.array(z.object({
        id: z.string(),
        type: z.string(),
        side: z.enum(['left', 'right']).optional(),
        schedule: z.string(),
        oneTime: z.boolean(),
        nextRun: z.number().nullable(),
        targetTempF: z.number().nullable(),
        brightness: z.number().nullable(),
      })),
      occurrences: z.array(z.object({
        id: z.string(),
        type: z.string(),
        side: z.enum(['left', 'right']).optional(),
        at: z.number(),
        targetTempF: z.number().nullable(),
        brightness: z.number().nullable(),
      })),
    }))
    .query(async ({ input }) => {
      try {
        const scheduler = (await getJobManager()).getScheduler()
        const now = Date.now()
        const jobs = scheduler.getJobs()
        const occurrences = expandOccurrences(
          jobs,
          new Date(now - 24 * 3_600_000),
          new Date(now + input.days * 24 * 3_600_000),
          scheduler.getTimezone(),
        )
        return {
          enabled: scheduler.isEnabled(),
          timezone: scheduler.getTimezone(),
          now,
          jobs: jobs.map((job) => {
            const md = job.metadata ?? {}
            return {
              id: job.id,
              type: job.type,
              side: md.side === 'left' || md.side === 'right' ? md.side : undefined,
              schedule: job.schedule,
              oneTime: !!job.oneTime,
              nextRun: scheduler.getNextInvocation(job.id)?.getTime() ?? null,
              targetTempF: typeof md.targetTemperature === 'number' ? md.targetTemperature : null,
              brightness: typeof md.brightness === 'number' ? md.brightness : null,
            }
          }),
          occurrences,
        }
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to read scheduler timeline: ${error instanceof Error ? error.message : 'Unknown error'}`,
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
        integrity: z.object({
          status: z.enum(['pending', 'ok', 'degraded']),
          checkedAt: z.string().nullable(),
          latencyMs: z.number(),
          error: z.string().optional(),
        }),
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
        sqlite.prepare('SELECT 1').get()
        dbLatencyMs = Math.round((performance.now() - dbStart) * 100) / 100
      }
      catch (error) {
        dbStatus = 'degraded'
        overallStatus = 'degraded'
        dbError = error instanceof Error ? error.message : 'Unknown error'
      }

      const integrity = getDatabaseIntegrity()
      if (integrity.status === 'degraded') {
        dbStatus = 'degraded'
        overallStatus = 'degraded'
        dbError ??= integrity.error
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

        // Only count job types that originate from the schedule tables above.
        // Every other type (prime, reboot, LED brightness, away-mode,
        // run-once, calibration, future additions) has no DB schedule row, so
        // including it would flag phantom drift and trigger a full reload.
        const scheduleBackedJobTypes = [
          JobType.TEMPERATURE,
          JobType.POWER_ON,
          JobType.POWER_OFF,
          JobType.ALARM,
        ]
        let actualUserJobs = 0
        try {
          const jobManager = await getJobManager()
          const scheduler = jobManager.getScheduler()
          for (const job of scheduler.getJobs()) {
            if (scheduleBackedJobTypes.includes(job.type)) {
              actualUserJobs++
            }
          }
        }
        catch {
        // Already handled above
        }
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
        const { checkIptablesCached } = await import('@/src/hardware/iptablesCheck')
        const result = await checkIptablesCached()
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
          integrity,
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
      reportsPumpSpeed: z.boolean(),
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
        verdict: z.enum(['off', 'delivering', 'holding', 'stalled', 'unknown']),
        note: z.string().nullable(),
      })),
    }))
    .query(() => readThermalTruth()),

  /**
   * System → Health's data path: every stage from sensors to outputs judged
   * by whether its output is fresh, the links between them, and one verdict
   * naming where the chain breaks. See src/lib/dataPath.
   */
  dataPath: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/health/data-path', protect: false, tags: ['Health'] } })
    .input(z.object({}))
    .output(z.object({
      at: z.number(),
      occupancy: z.object({ left: z.enum(['empty', 'occupied', 'suspect']), right: z.enum(['empty', 'occupied', 'suspect']) }),
      nodes: z.array(z.object({
        id: nodeId,
        stage,
        label: z.string(),
        status: checkStatus,
        metric: z.string(),
        detail: z.string(),
        lastOutputAt: z.number().nullable(),
        unit: unitEnum.optional(),
        path: z.string().optional(),
      })),
      edges: z.array(z.object({ from: nodeId, to: nodeId, state: z.enum(['flowing', 'idle', 'stalled']) })),
      verdict: z.object({
        tone: z.enum(['ok', 'warn', 'danger']),
        headline: z.string(),
        nodeId: nodeId.nullable(),
        lastGoodId: nodeId.nullable(),
        fix: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('restart'), unit: unitEnum, label: z.string() }),
          z.object({ kind: z.literal('occupancy'), sides: z.array(z.enum(['left', 'right'])), unit: unitEnum, label: z.string() }),
          z.object({ kind: z.literal('logs'), unit: z.string(), label: z.string(), hint: z.string().optional() }),
          z.object({ kind: z.literal('link'), tab: z.enum(['scheduler', 'thermal']), label: z.string() }),
        ]).nullable(),
        also: z.array(z.string()),
      }),
    }))
    .query(async () => {
      try {
        return await getDataPath()
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to evaluate the data path: ${error instanceof Error ? error.message : String(error)}`,
          cause: error,
        })
      }
    }),

  /** The last 24 hours of data-path checks, recorded once a minute. */
  history: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/health/history', protect: false, tags: ['Health'] } })
    .input(z.object({}))
    .output(z.object({
      from: z.number(),
      to: z.number(),
      recordedSince: z.number().nullable(),
      checks: z.array(z.object({
        id: nodeId,
        label: z.string(),
        runs: z.array(z.object({ status: checkStatus, start: z.number(), end: z.number() })),
        healthyShare: z.number().nullable(),
        incidents: z.number(),
      })),
      incidents: z.array(z.object({
        checkId: nodeId,
        label: z.string(),
        status: z.enum(['stale', 'down']),
        start: z.number(),
        end: z.number().nullable(),
        detail: z.string().nullable(),
      })),
      gaps: z.array(z.object({ start: z.number(), end: z.number() })),
    }))
    .query(() => readHistory(biometricsDb as never, Date.now())),

  /**
   * Restart one biometrics module. next-server runs as User=sleepypod, so
   * this goes through the NOPASSWD rule scripts/install writes for exactly
   * these units; pods installed before that rule get the manual command back.
   */
  restartService: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/health/restart-service', protect: false, tags: ['Health'] } })
    .input(z.object({ unit: unitEnum }))
    .output(z.object({ ok: z.boolean(), message: z.string() }))
    .mutation(async ({ input }) => {
      try {
        await execFileAsync('sudo', ['-n', 'systemctl', 'restart', input.unit], { timeout: 20_000 })
        return { ok: true, message: `Restarted ${input.unit}` }
      }
      catch (error) {
        const reason = error instanceof Error ? error.message.split('\n')[0] : String(error)
        return { ok: false, message: `Couldn’t restart it from here (${reason}). Run on the pod: sudo systemctl restart ${input.unit}` }
      }
    }),

  /**
   * Maintenance facts for the Dashboard's attention list: whether the
   * pump-stall guard is armed and when the pod last finished a prime.
   */
  maintenance: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/health/maintenance', protect: false, tags: ['Health'] } })
    .input(z.object({}))
    .output(z.object({
      pumpStallProtectionEnabled: z.boolean(),
      reportsPumpSpeed: z.boolean(),
      primePodDaily: z.boolean(),
      primePodTime: z.string().nullable(),
      lastPrimeAt: z.number().nullable(),
      firstPrimeRecordedAt: z.number().nullable(),
    }))
    .query(() => {
      const [settings] = db
        .select({
          pumpStall: deviceSettings.pumpStallProtectionEnabled,
          primePodDaily: deviceSettings.primePodDaily,
          primePodTime: deviceSettings.primePodTime,
        })
        .from(deviceSettings)
        .limit(1)
        .all()
      const [last] = biometricsDb.select({ ts: primeEvents.timestamp }).from(primeEvents).orderBy(desc(primeEvents.timestamp)).limit(1).all()
      const [first] = biometricsDb.select({ ts: primeEvents.timestamp }).from(primeEvents).orderBy(primeEvents.timestamp).limit(1).all()
      const [flow] = biometricsDb.select({ ts: flowReadings.timestamp }).from(flowReadings).limit(1).all()
      return {
        pumpStallProtectionEnabled: settings?.pumpStall ?? false,
        reportsPumpSpeed: flow != null,
        primePodDaily: settings?.primePodDaily ?? false,
        primePodTime: settings?.primePodTime ?? null,
        lastPrimeAt: last?.ts ? last.ts.getTime() : null,
        firstPrimeRecordedAt: first?.ts ? first.ts.getTime() : null,
      }
    }),

  /**
   * Downsampled thermal history (bed/target, water, surface, pump rpm, hub)
   * for System → Thermal, with power-on markers. See src/lib/thermalHistory.
   */
  thermalHistory: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/health/thermal-history', protect: false, tags: ['Health'] } })
    .input(z.object({ range: z.enum(Object.keys(THERMAL_RANGES) as [ThermalRange, ...ThermalRange[]]).default('12h') }))
    .output(z.object({
      range: z.enum(Object.keys(THERMAL_RANGES) as [ThermalRange, ...ThermalRange[]]),
      from: z.number(),
      to: z.number(),
      bucketSec: z.number(),
      points: z.array(z.object({
        t: z.number(),
        leftBed: z.number().nullable(),
        rightBed: z.number().nullable(),
        leftTarget: z.number().nullable(),
        rightTarget: z.number().nullable(),
        leftWater: z.number().nullable(),
        rightWater: z.number().nullable(),
        leftSurface: z.number().nullable(),
        rightSurface: z.number().nullable(),
        leftRpm: z.number().nullable(),
        rightRpm: z.number().nullable(),
        heatsink: z.number().nullable(),
        ambient: z.number().nullable(),
      })),
      powerOn: z.array(z.object({ side: z.enum(['left', 'right']), at: z.number() })),
      available: z.object({
        bedTarget: z.boolean(),
        water: z.boolean(),
        surface: z.boolean(),
        pump: z.boolean(),
        hub: z.boolean(),
      }),
      bedTargetSince: z.number().nullable(),
    }))
    .query(({ input }) => {
      const states = db.select({ side: deviceState.side, poweredOnAt: deviceState.poweredOnAt, isPowered: deviceState.isPowered }).from(deviceState).all()
      const poweredOnAt = Object.fromEntries(states.map(r => [r.side, r.isPowered && r.poweredOnAt ? r.poweredOnAt.getTime() : null]))
      try {
        return getThermalHistory(biometricsDb as never, input.range, Date.now(), poweredOnAt)
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to read thermal history: ${error instanceof Error ? error.message : String(error)}`,
          cause: error,
        })
      }
    }),
})
