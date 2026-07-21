import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { publicProcedure, router } from '@/src/server/trpc'
import { biometricsDb } from '@/src/db'
import { bedTemp, pumpAlerts } from '@/src/db/biometrics-schema'
import { acknowledge as guardAcknowledge } from '@/src/hardware/pumpStallGuard'
import { clearPumpStallNotice } from '@/src/hardware/pumpStallNotification'
import { idSchema, sideSchema } from '@/src/server/validation-schemas'

const ALERT_TYPE = z.enum([
  'stall_left',
  'stall_right',
  'no_flow_left',
  'no_flow_right',
  'asymmetry',
  'clog_suspected',
  'hub_temp_disputed',
])

const ALERT_ACTION = z.enum(['power_off', 'auto_recovered', 'warned', 'none'])

const pumpAlertOut = z.object({
  id: z.number(),
  timestamp: z.date(),
  type: ALERT_TYPE,
  side: z.enum(['left', 'right']).nullable(),
  rpm: z.number().nullable(),
  flowrateCd: z.number().nullable(),
  durationSeconds: z.number().nullable(),
  action: ALERT_ACTION,
  restoreTargetTemperature: z.number().nullable(),
  restoreDurationSeconds: z.number().nullable(),
  acknowledgedAt: z.date().nullable(),
  dismissedAt: z.date().nullable(),
})

export const pumpAlertsRouter = router({
  /**
   * Recent pump alerts, newest first. Filters out dismissed rows by default
   * and acknowledged rows unless `includeAcknowledged` is true.
   */
  list: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/pump-alerts', protect: false, tags: ['Pump Alerts'] } })
    .input(z.object({
      limit: z.number().int().min(1).max(500).default(50),
      includeAcknowledged: z.boolean().default(false),
    }).strict())
    .output(z.array(pumpAlertOut))
    .query(async ({ input }) => {
      try {
        const conditions = [isNull(pumpAlerts.dismissedAt)]
        if (!input.includeAcknowledged) conditions.push(isNull(pumpAlerts.acknowledgedAt))
        return await biometricsDb
          .select()
          .from(pumpAlerts)
          .where(and(...conditions))
          .orderBy(desc(pumpAlerts.timestamp))
          .limit(input.limit)
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to fetch pump alerts: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  /**
   * Probe-first capability check for the bed-temp cross-check feature. The
   * settings UI uses this to decide whether to render the cross-check
   * section — pods without center thermistors won't expose those controls.
   */
  getCapabilities: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/pump-alerts/capabilities', protect: false, tags: ['Pump Alerts'] } })
    .input(z.object({}))
    .output(z.object({ hasBedCenterSensors: z.boolean() }))
    .query(async () => {
      try {
        const tenMinutesAgo = new Date(Date.now() - 10 * 60_000)
        const [row] = await biometricsDb
          .select({
            timestamp: bedTemp.timestamp,
            leftCenterTemp: bedTemp.leftCenterTemp,
            rightCenterTemp: bedTemp.rightCenterTemp,
          })
          .from(bedTemp)
          .orderBy(desc(bedTemp.timestamp))
          .limit(1)
        const hasBedCenterSensors = row != null
          && row.leftCenterTemp != null
          && row.rightCenterTemp != null
          && row.timestamp >= tenMinutesAgo
        return { hasBedCenterSensors }
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to probe pump-alert capabilities: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  /**
   * User-driven re-enable. Clears the guard for the side and, if a
   * pre-stall snapshot exists, restores the saved target temperature via
   * the normal command path so all the regular safety/debounce paths apply.
   */
  acknowledgeAndRestore: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/pump-alerts/acknowledge', protect: false, tags: ['Pump Alerts'] } })
    .input(z.object({ side: sideSchema }).strict())
    .output(z.object({
      success: z.boolean(),
      restoredTarget: z.number().nullable(),
      restoredDuration: z.number().nullable(),
      orphanRecovered: z.boolean(),
    }))
    .mutation(async ({ input }) => {
      const { restore, alertId } = guardAcknowledge(input.side)

      // A restart wipes the guard's in-memory state, so a trip from before
      // the restart has no activeAlertId anymore and its row would strand
      // unacknowledged in the active list forever. Fall back to the newest
      // active power_off row for this side — but only when the restore
      // snapshot is gone too: a failed alert INSERT at trip time also
      // returns a null id while the snapshot survives, and falling back
      // there would stamp an older, unrelated row. The row's persisted
      // restore columns (ADR 0022) stand in for the lost snapshot.
      let stampId = alertId
      let orphanRecovered = false
      let orphanRestore: { targetTemperature: number, durationSeconds: number } | null = null
      if (stampId == null && restore == null) {
        let orphan
        try {
          [orphan] = await biometricsDb
            .select({
              id: pumpAlerts.id,
              restoreTargetTemperature: pumpAlerts.restoreTargetTemperature,
              restoreDurationSeconds: pumpAlerts.restoreDurationSeconds,
            })
            .from(pumpAlerts)
            .where(and(
              eq(pumpAlerts.side, input.side),
              eq(pumpAlerts.action, 'power_off'),
              isNull(pumpAlerts.acknowledgedAt),
              isNull(pumpAlerts.dismissedAt),
            ))
            .orderBy(desc(pumpAlerts.timestamp), desc(pumpAlerts.id))
            .limit(1)
        }
        catch (err) {
          // This lookup is the mutation's only route to the stranded row —
          // when it fails the whole restart-recovery action failed.
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: `Failed to look up orphaned pump alert: ${err instanceof Error ? err.message : 'Unknown error'}`,
            cause: err,
          })
        }
        if (orphan) {
          stampId = orphan.id
          orphanRecovered = true
          if (orphan.restoreTargetTemperature != null && orphan.restoreDurationSeconds != null) {
            orphanRestore = {
              targetTemperature: orphan.restoreTargetTemperature,
              durationSeconds: orphan.restoreDurationSeconds,
            }
          }
        }
      }

      if (stampId != null) {
        try {
          await biometricsDb
            .update(pumpAlerts)
            .set({ acknowledgedAt: new Date() })
            .where(eq(pumpAlerts.id, stampId))
        }
        catch (err) {
          console.warn('[pumpAlerts] failed to stamp acknowledgedAt:', err instanceof Error ? err.message : err)
        }
      }

      if (restore == null && orphanRestore == null) {
        return { success: true, restoredTarget: null, restoredDuration: null, orphanRecovered }
      }

      // Route through the device router so debounce, freshness stamping,
      // and the rest of the normal flow apply identically to a manual
      // user mutation.
      const { appRouter } = await import('./app')
      const caller = appRouter.createCaller({})

      let effectiveRestore = restore
      if (effectiveRestore == null && orphanRestore != null) {
        // Replay the persisted snapshot only when the side is still parked:
        // after an earlier silent stamp failure the side may already be
        // running a newer setpoint, and blind replay would clobber it. A
        // failed status read skips the replay — leaving the side off is
        // the conservative outcome.
        try {
          const status = await caller.device.getStatus({})
          const sideStatus = input.side === 'left' ? status.leftSide : status.rightSide
          if (sideStatus.targetLevel === 0) {
            effectiveRestore = orphanRestore
          }
        }
        catch (err) {
          console.warn('[pumpAlerts] status read before orphan replay failed — leaving the side off:', err instanceof Error ? err.message : err)
        }
      }
      if (effectiveRestore == null) {
        return { success: true, restoredTarget: null, restoredDuration: null, orphanRecovered }
      }

      try {
        await caller.device.setPower({ side: input.side, powered: true, temperature: effectiveRestore.targetTemperature })
        await caller.device.setTemperature({
          side: input.side,
          temperature: effectiveRestore.targetTemperature,
          duration: effectiveRestore.durationSeconds,
        })
      }
      catch (err) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to restore side: ${err instanceof Error ? err.message : 'Unknown error'}`,
          cause: err,
        })
      }

      return {
        success: true,
        restoredTarget: effectiveRestore.targetTemperature,
        restoredDuration: effectiveRestore.durationSeconds,
        orphanRecovered,
      }
    }),

  /**
   * Dismiss the notification banner only. The side stays off; the alert
   * row is stamped `dismissedAt` so history filters can hide it.
   */
  dismissNotification: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/pump-alerts/dismiss-notification', protect: false, tags: ['Pump Alerts'] } })
    .input(z.object({ side: sideSchema }).strict())
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ input }) => {
      const { alertId } = guardAcknowledge(input.side)
      clearPumpStallNotice(input.side)
      if (alertId != null) {
        try {
          await biometricsDb
            .update(pumpAlerts)
            .set({ dismissedAt: new Date() })
            .where(eq(pumpAlerts.id, alertId))
        }
        catch (err) {
          console.warn('[pumpAlerts] failed to stamp dismissedAt:', err instanceof Error ? err.message : err)
        }
      }
      return { success: true }
    }),

  /**
   * History-row dismiss. Hides a specific alert from the active list.
   */
  dismissAlert: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/pump-alerts/dismiss', protect: false, tags: ['Pump Alerts'] } })
    .input(z.object({ id: idSchema }).strict())
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ input }) => {
      try {
        const [updated] = await biometricsDb
          .update(pumpAlerts)
          .set({ dismissedAt: new Date() })
          .where(and(eq(pumpAlerts.id, input.id), isNull(pumpAlerts.dismissedAt)))
          .returning()
        if (!updated) {
          throw new TRPCError({ code: 'NOT_FOUND', message: `Pump alert ${input.id} not found or already dismissed` })
        }
        return { success: true }
      }
      catch (error) {
        if (error instanceof TRPCError) throw error
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to dismiss pump alert: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),
})
