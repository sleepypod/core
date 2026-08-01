import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { publicProcedure, router } from '@/src/server/trpc'
import { biometricsDb } from '@/src/db'
import { bedTemp, pumpAlerts } from '@/src/db/biometrics-schema'
import {
  acknowledge as guardAcknowledge,
  completeResolution as guardCompleteResolution,
  confirmCutoff as guardConfirmCutoff,
  dismissIfActive,
  identifyResolution as guardIdentifyResolution,
  isCutoffPendingIncident,
  rearm as guardRearm,
  restoreAcknowledgedSession as guardRestoreSession,
  supersedeAlerts,
} from '@/src/hardware/pumpStallGuard'
import { clearPumpStallNotice, getPumpStallNotice } from '@/src/hardware/pumpStallNotification'
import { remainingPumpStallRestore } from '@/src/hardware/pumpStallRestore'
import type { PumpStallRestore } from '@/src/hardware/pumpStallRestore'
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
   * User-driven re-enable. Reserves the guarded incident and, if a pre-stall
   * snapshot exists, restores its remaining session through the guard-owned
   * hardware path before releasing the side.
   */
  acknowledgeAndRestore: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/pump-alerts/acknowledge', protect: false, tags: ['Pump Alerts'] } })
    .input(z.object({ side: sideSchema, alertId: idSchema.optional() }).strict())
    .output(z.object({
      success: z.boolean(),
      restoredTarget: z.number().nullable(),
      restoredDuration: z.number().nullable(),
      orphanRecovered: z.boolean(),
    }))
    .mutation(async ({ input }) => {
      // Snapshot the notice before the resolution completes — a failed
      // restore re-arms the guard with the original trip metadata.
      const priorNotice = getPumpStallNotice(input.side)
      const guardResult = input.alertId == null
        ? guardAcknowledge(input.side)
        : guardAcknowledge(input.side, input.alertId)
      if (guardResult.conflict != null) {
        const message = guardResult.conflict === 'hardware_pending'
          ? `Pump alert ${input.alertId ?? guardResult.alertId ?? 'incident'} is still being resolved — the side is not confirmed off`
          : `Pump alert ${input.alertId} is stale — the current incident is ${guardResult.alertId ?? 'unidentified'}`
        throw new TRPCError({ code: 'CONFLICT', message })
      }
      const { restore, alertId, trippedAt, rearmToken } = guardResult
      if (rearmToken == null) {
        // A successful guard acknowledgement always installs an opaque
        // resolution reservation. Refuse to continue without it: briefly
        // exposing an ordinary unblocked state here would let a duplicate
        // acknowledgement steal the restore or skip a compensating cutoff.
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Pump-stall resolution reservation was not established',
        })
      }

      // Identity correlation: a client that saw the banner passes the
      // notice's alertId, so a stale or replayed request stamps exactly
      // that incident's row (and never falls through to guessing).
      //
      // Without a client id, a restart wipes the guard's in-memory state,
      // so a trip from before the restart has no activeAlertId anymore and
      // its row would strand unacknowledged in the active list forever.
      // Fall back to the newest active power_off row for this side — but
      // only when the restore snapshot is gone too: a failed alert INSERT
      // at trip time also returns a null id while the snapshot survives,
      // and falling back there would stamp an older, unrelated row. The
      // row's persisted restore columns (ADR 0022) stand in for the lost
      // snapshot.
      let stampId = input.alertId ?? alertId
      let orphanRecovered = false
      let orphanRestore: PumpStallRestore | null = null
      let orphanTrippedAt: number | null = null
      if (stampId == null && restore == null && trippedAt == null) {
        let orphan
        try {
          // better-sqlite3 is synchronous. Resolve and attach the orphan id
          // without yielding, so a history-row dismissal cannot slip between
          // the lookup and the reservation gaining that incident identity.
          orphan = biometricsDb
            .select({
              id: pumpAlerts.id,
              timestamp: pumpAlerts.timestamp,
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
            // Newest by id — monotonic incident order even under the
            // pre-NTP boot clock skew that inverts timestamps, and the key
            // the supersede stamp bounds on.
            .orderBy(desc(pumpAlerts.id))
            .limit(1)
            .get()
        }
        catch (err) {
          // No hardware write has started. Restore a live pre-restart guard,
          // or discard the empty reservation so a transient DB failure can be
          // retried instead of stranding the side in resolutionPending.
          if (alertId != null || trippedAt != null || priorNotice != null) {
            guardRearm(input.side, {
              alertId,
              restore,
              trippedAt: trippedAt ?? undefined,
              rpm: priorNotice?.rpm,
            }, rearmToken)
          }
          else {
            guardCompleteResolution(input.side, rearmToken)
          }
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
          orphanTrippedAt = orphan.timestamp?.getTime() ?? null
          if (orphan.restoreTargetTemperature != null && orphan.restoreDurationSeconds != null) {
            orphanRestore = {
              targetTemperature: orphan.restoreTargetTemperature,
              durationSeconds: orphan.restoreDurationSeconds,
            }
          }
          guardIdentifyResolution(input.side, rearmToken, orphan.id)
        }
      }

      // Best-effort by design: a stamp failure only leaves the row in the
      // active list; the guard stays reserved until this attempt finishes.
      // The WHERE clause re-checks activity so a concurrently dismissed row
      // is not stamped twice (mirroring dismissAlert), and a client-provided
      // id must also prove it names this side's power_off incident.
      const stampAcknowledged = async (): Promise<void> => {
        if (stampId == null) return
        const conditions = [
          eq(pumpAlerts.id, stampId),
          isNull(pumpAlerts.acknowledgedAt),
          isNull(pumpAlerts.dismissedAt),
        ]
        if (input.alertId != null) {
          conditions.push(eq(pumpAlerts.side, input.side), eq(pumpAlerts.action, 'power_off'))
        }
        try {
          const stamped = await biometricsDb
            .update(pumpAlerts)
            .set({ acknowledgedAt: new Date() })
            .where(and(...conditions))
            .returning({ id: pumpAlerts.id })
          // Older active rows are duplicates of the incident just resolved —
          // stamp them too so the backlog cannot resurrect a block one boot
          // at a time. Only when the stamp proved out: a client id that
          // failed the side/action proof must not drive a bulk stamp.
          if (stamped.length > 0) supersedeAlerts(input.side, { beforeId: stampId })
        }
        catch (err) {
          console.warn('[pumpAlerts] failed to stamp acknowledgedAt:', err instanceof Error ? err.message : err)
        }
      }

      if (restore == null && orphanRestore == null) {
        await stampAcknowledged()
        guardCompleteResolution(input.side, rearmToken)
        return { success: true, restoredTarget: null, restoredDuration: null, orphanRecovered }
      }

      const sourceRestore = restore ?? orphanRestore
      const sourceTrippedAt = trippedAt
        ?? (priorNotice ? priorNotice.trippedAt * 1000 : null)
        ?? orphanTrippedAt
      let effectiveRestore = remainingPumpStallRestore(sourceRestore, sourceTrippedAt)
      if (effectiveRestore == null) {
        // The snapshot described the remainder at trip time. Once that
        // original window has elapsed, acknowledging must leave the side off
        // rather than creating another short session and another end-of-session
        // false trip.
        await stampAcknowledged()
        guardCompleteResolution(input.side, rearmToken)
        return { success: true, restoredTarget: null, restoredDuration: null, orphanRecovered }
      }

      // The caller remains useful for the conservative orphan status check
      // and for a compensating power-off. The restore itself goes through
      // the guard-owned path below because ordinary device writes correctly
      // remain blocked for the lifetime of this reservation.
      const { appRouter } = await import('./app')
      const caller = appRouter.createCaller({})

      if (restore == null && orphanRestore != null) {
        // Replay the persisted snapshot only when the side is still parked:
        // after an earlier silent stamp failure the side may already be
        // running a newer setpoint, and blind replay would clobber it. A
        // failed status read skips the replay — leaving the side off is
        // the conservative outcome.
        try {
          const status = await caller.device.getStatus({})
          const sideStatus = input.side === 'left' ? status.leftSide : status.rightSide
          if (sideStatus.targetLevel !== 0) effectiveRestore = null
        }
        catch (err) {
          console.warn('[pumpAlerts] status read before orphan replay failed — leaving the side off:', err instanceof Error ? err.message : err)
          effectiveRestore = null
        }
      }
      if (effectiveRestore == null) {
        await stampAcknowledged()
        guardCompleteResolution(input.side, rearmToken)
        return { success: true, restoredTarget: null, restoredDuration: null, orphanRecovered }
      }

      // Restore first, stamp after: if the hardware calls fail the row must
      // stay in the active list and the guard must re-arm, or the fault is
      // hidden while the side sits in an unknown power state.
      try {
        // setTemperature already energizes the side. Calling setPower(on)
        // first emitted a default 28,800-second duration immediately before
        // this real one, leaving logs and snapshots describing different
        // sessions.
        await guardRestoreSession(input.side, effectiveRestore, rearmToken)
      }
      catch (err) {
        // setTemperature writes level before duration, so any failure may be
        // partial. Re-arm synchronously before the compensating park so other
        // commands and dismissals stay gated. The acknowledgement token makes
        // this a no-op if a newer incident or user action already superseded
        // the restore; in that case its owner controls the hardware.
        const rearmParams = {
          alertId: stampId,
          restore: sourceRestore,
          trippedAt: sourceTrippedAt ?? undefined,
          rpm: priorNotice?.rpm,
          cutoffPending: true,
        }
        const rearmed = guardRearm(input.side, rearmParams, rearmToken)
        if (rearmed) {
          try {
            await caller.device.setPower({ side: input.side, powered: false })
            guardConfirmCutoff(input.side, rearmToken)
          }
          catch (offErr) {
            // cutoffPending stays asserted; the frame path will retry.
            console.warn('[pumpAlerts] failed to park side after partial restore:', offErr instanceof Error ? offErr.message : offErr)
          }
        }
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to restore side: ${err instanceof Error ? err.message : 'Unknown error'}`,
          cause: err,
        })
      }

      await stampAcknowledged()
      guardCompleteResolution(input.side, rearmToken)

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
    .input(z.object({ side: sideSchema, alertId: idSchema.optional() }).strict())
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ input }) => {
      const guardResult = input.alertId == null
        ? guardAcknowledge(input.side)
        : guardAcknowledge(input.side, input.alertId)
      if (guardResult.conflict != null) {
        const message = guardResult.conflict === 'hardware_pending'
          ? `Pump alert ${input.alertId ?? guardResult.alertId ?? 'incident'} is still being resolved — the side is not confirmed off`
          : `Pump alert ${input.alertId} is stale — the current incident is ${guardResult.alertId ?? 'unidentified'}`
        throw new TRPCError({ code: 'CONFLICT', message })
      }
      const { alertId, rearmToken } = guardResult
      if (rearmToken == null) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Pump-stall resolution reservation was not established',
        })
      }
      clearPumpStallNotice(input.side)
      // A client-provided id survives a restart (the guard's is wiped) and
      // pins the stamp to the incident the user actually dismissed; it must
      // prove it names this side's power_off incident. There is no
      // newest-row fallback here on purpose — without an id there is no way
      // to tell which incident a stale request meant.
      const stampId = input.alertId ?? alertId
      try {
        if (stampId != null) {
          const conditions = [eq(pumpAlerts.id, stampId), isNull(pumpAlerts.dismissedAt)]
          if (input.alertId != null) {
            conditions.push(
              eq(pumpAlerts.side, input.side),
              eq(pumpAlerts.action, 'power_off'),
              isNull(pumpAlerts.acknowledgedAt),
            )
          }
          try {
            const stamped = await biometricsDb
              .update(pumpAlerts)
              .set({ dismissedAt: new Date() })
              .where(and(...conditions))
              .returning({ id: pumpAlerts.id })
            // Same supersede rationale and same proof gate as the
            // acknowledgement stamp above.
            if (stamped.length > 0) supersedeAlerts(input.side, { beforeId: stampId })
          }
          catch (err) {
            console.warn('[pumpAlerts] failed to stamp dismissedAt:', err instanceof Error ? err.message : err)
          }
        }
      }
      finally {
        guardCompleteResolution(input.side, rearmToken)
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
    .mutation(({ input }) => {
      try {
        // better-sqlite3 is synchronous. Keep the safety check, row stamp,
        // and live-state release in one synchronous transaction with no
        // awaited Drizzle thenable between them. This prevents a frame from
        // arming a cutoff/probe after the precheck but before persistence is
        // changed. A process crash before commit rolls the stamp back, so the
        // row remains available for startup rehydration.
        biometricsDb.transaction((tx) => {
          const existing = tx
            .select({ id: pumpAlerts.id, side: pumpAlerts.side })
            .from(pumpAlerts)
            .where(and(eq(pumpAlerts.id, input.id), isNull(pumpAlerts.dismissedAt)))
            .limit(1)
            .get()
          if (!existing) {
            throw new TRPCError({ code: 'NOT_FOUND', message: `Pump alert ${input.id} not found or already dismissed` })
          }
          if (existing.side != null && isCutoffPendingIncident(existing.side, existing.id)) {
            throw new TRPCError({ code: 'CONFLICT', message: `Pump alert ${input.id} is still being resolved — the side has not confirmed its power-off yet` })
          }

          const updated = tx
            .update(pumpAlerts)
            .set({ dismissedAt: new Date() })
            .where(and(eq(pumpAlerts.id, input.id), isNull(pumpAlerts.dismissedAt)))
            .returning()
            .get()
          if (!updated) {
            throw new TRPCError({ code: 'NOT_FOUND', message: `Pump alert ${input.id} not found or already dismissed` })
          }
          // With no event-loop yield since the precheck, a matching live
          // incident cannot become hazardous before this synchronous release.
          if (updated.side != null) dismissIfActive(updated.side, updated.id)
        })
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
