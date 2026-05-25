import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { publicProcedure, router } from '@/src/server/trpc'
import { db } from '@/src/db'
import { deviceSettings, sideSettings, tapGestures } from '@/src/db/schema'
import { eq, and } from 'drizzle-orm'
import {
  isoDatetimeSchema,
  sideSchema,
  tapTypeSchema,
  temperatureUnitSchema,
  timeStringSchema,
} from '@/src/server/validation-schemas'

const timestampSchema = z.coerce.date()

const deviceSettingsSchema = z.object({
  id: z.number(),
  timezone: z.string(),
  temperatureUnit: temperatureUnitSchema,
  rebootDaily: z.boolean(),
  rebootTime: z.string().nullable(),
  primePodDaily: z.boolean(),
  primePodTime: z.string().nullable(),
  ledNightModeEnabled: z.boolean(),
  ledDayBrightness: z.number(),
  ledNightBrightness: z.number(),
  ledNightStartTime: z.string().nullable(),
  ledNightEndTime: z.string().nullable(),
  globalMaxOnHours: z.number().nullable(),
  homekitEnabled: z.boolean(),
  pumpStallProtectionEnabled: z.boolean(),
  pumpStallRpmThreshold: z.number(),
  pumpStallDwellSamples: z.number(),
  pumpStallAutoRecoveryEnabled: z.boolean(),
  pumpStallRecoveryRpm: z.number(),
  pumpStallRecoverySamples: z.number(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
})

const sideSettingsSchema = z.object({
  side: sideSchema,
  name: z.string(),
  awayMode: z.boolean(),
  alwaysOn: z.boolean(),
  autoOffEnabled: z.boolean(),
  autoOffMinutes: z.number(),
  awayStart: z.string().nullable().optional(),
  awayReturn: z.string().nullable().optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
})

const tapGestureSchema = z.object({
  id: z.number(),
  side: sideSchema,
  tapType: tapTypeSchema,
  actionType: z.enum(['temperature', 'alarm']),
  temperatureChange: z.enum(['increment', 'decrement']).nullable().optional(),
  temperatureAmount: z.number().nullable().optional(),
  alarmBehavior: z.enum(['snooze', 'dismiss']).nullable().optional(),
  alarmSnoozeDuration: z.number().nullable().optional(),
  alarmInactiveBehavior: z.enum(['power', 'none']).nullable().optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
})

const getAllSettingsResponse = z.object({
  device: deviceSettingsSchema,
  sides: z.object({
    left: sideSettingsSchema,
    right: sideSettingsSchema,
  }),
  gestures: z.object({
    left: z.array(tapGestureSchema),
    right: z.array(tapGestureSchema),
  }),
})
import { getJobManager } from '@/src/scheduler'
import { startKeepalive, stopKeepalive } from '@/src/services/temperatureKeepalive'
import { restartAutoOffTimers } from '@/src/services/autoOffWatcher'
import { invalidateGuardSettingsCache } from '@/src/hardware/pumpStallGuard'

const REBOOT_KEYS = ['rebootDaily', 'rebootTime'] as const
const PRIME_KEYS = ['primePodDaily', 'primePodTime'] as const
const LED_KEYS = [
  'ledNightModeEnabled', 'ledDayBrightness', 'ledNightBrightness',
  'ledNightStartTime', 'ledNightEndTime',
] as const

/**
 * Apply scheduler mutations triggered by a device-settings update. Re-reads
 * the persisted settings row so the helpers see the merged state instead of
 * just the incoming patch (`enabled=false` updates can omit the time fields,
 * and the upserts need both to decide schedule vs. cancel).
 *
 * Timezone changes still force a full reload — every cron job is bound to its
 * tz at creation time inside node-schedule and cannot be rebound in place.
 * Per-kind keys go through the incremental upserts so an unrelated alarm
 * fire-window isn't disturbed by a reboot-time toggle.
 */
async function applySettingsSchedulerChanges(input: Record<string, unknown>): Promise<void> {
  const tzChanged = 'timezone' in input && typeof input.timezone === 'string'
  const rebootChanged = REBOOT_KEYS.some(k => k in input)
  const primeChanged = PRIME_KEYS.some(k => k in input)
  const ledChanged = LED_KEYS.some(k => k in input)

  if (!tzChanged && !rebootChanged && !primeChanged && !ledChanged) return

  const jobManager = await getJobManager()

  if (tzChanged) {
    // Full reload — every cron job rebinds against the new tz.
    await jobManager.updateTimezone(input.timezone as string)
    return
  }

  // Re-read the row so the upserts see post-commit values, not the diff.
  const [settings] = await db.select().from(deviceSettings).limit(1)
  if (!settings) return

  if (rebootChanged) {
    jobManager.upsertRebootJob(settings.rebootDaily, settings.rebootTime)
  }
  if (primeChanged) {
    jobManager.upsertPrimeJob(settings.primePodDaily, settings.primePodTime)
  }
  if (ledChanged) {
    await jobManager.upsertLedNightMode(
      settings.ledNightModeEnabled,
      settings.ledNightStartTime,
      settings.ledNightEndTime,
      settings.ledDayBrightness,
      settings.ledNightBrightness,
    )
  }
}

/**
 * Settings router - manages device configuration
 */
export const settingsRouter = router({
  /**
   * Get all settings
   */
  getAll: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/settings', protect: false, tags: ['Settings'] } })
    .input(z.object({}))
    .output(getAllSettingsResponse)
    .query(async () => {
      try {
        const [device] = await db.select().from(deviceSettings).limit(1)
        const sides = await db.select().from(sideSettings)
        const gestures = await db.select().from(tapGestures)

        return {
          device: device ?? {
            id: 1,
            timezone: 'America/Los_Angeles',
            temperatureUnit: 'F',
            rebootDaily: false,
            rebootTime: '03:00',
            primePodDaily: false,
            primePodTime: '14:00',
            ledNightModeEnabled: false,
            ledDayBrightness: 100,
            ledNightBrightness: 0,
            ledNightStartTime: '22:00',
            ledNightEndTime: '07:00',
            globalMaxOnHours: null,
            homekitEnabled: false,
            pumpStallProtectionEnabled: true,
            pumpStallRpmThreshold: 500,
            pumpStallDwellSamples: 2,
            pumpStallAutoRecoveryEnabled: false,
            pumpStallRecoveryRpm: 1500,
            pumpStallRecoverySamples: 3,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          sides: {
            left: sides.find(s => s.side === 'left') ?? { side: 'left' as const, name: 'Left', alwaysOn: false, awayMode: false, autoOffEnabled: false, autoOffMinutes: 30, createdAt: new Date(), updatedAt: new Date() },
            right: sides.find(s => s.side === 'right') ?? { side: 'right' as const, name: 'Right', alwaysOn: false, awayMode: false, autoOffEnabled: false, autoOffMinutes: 30, createdAt: new Date(), updatedAt: new Date() },
          },
          gestures: {
            left: gestures.filter(g => g.side === 'left'),
            right: gestures.filter(g => g.side === 'right'),
          },
        }
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to fetch settings: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  /**
   * Update device settings
   */
  updateDevice: publicProcedure
    .meta({ openapi: { method: 'PATCH', path: '/settings/device', protect: false, tags: ['Settings'] } })
    .input(
      z
        .object({
          timezone: z.string().optional(),
          temperatureUnit: temperatureUnitSchema.optional(),
          rebootDaily: z.boolean().optional(),
          rebootTime: timeStringSchema.optional(),
          primePodDaily: z.boolean().optional(),
          primePodTime: timeStringSchema.optional(),
          ledNightModeEnabled: z.boolean().optional(),
          ledDayBrightness: z.number().int().min(0).max(100).optional(),
          ledNightBrightness: z.number().int().min(0).max(100).optional(),
          ledNightStartTime: timeStringSchema.optional(),
          ledNightEndTime: timeStringSchema.optional(),
          // Global wall-clock auto-off cap. `null` disables; 1–48 hours when set.
          globalMaxOnHours: z.number().int().min(1).max(48).nullable().optional(),
          homekitEnabled: z.boolean().optional(),
          pumpStallProtectionEnabled: z.boolean().optional(),
          pumpStallRpmThreshold: z.number().int().min(100).max(1500).optional(),
          pumpStallDwellSamples: z.number().int().min(1).max(10).optional(),
          pumpStallAutoRecoveryEnabled: z.boolean().optional(),
          pumpStallRecoveryRpm: z.number().int().min(500).max(3000).optional(),
          pumpStallRecoverySamples: z.number().int().min(1).max(10).optional(),
        })
        .strict()
    )
    .output(z.object({
      id: z.number(),
      timezone: z.string(),
      temperatureUnit: temperatureUnitSchema,
      rebootDaily: z.boolean(),
      rebootTime: z.string().nullable(),
      primePodDaily: z.boolean(),
      primePodTime: z.string().nullable(),
      ledNightModeEnabled: z.boolean(),
      ledDayBrightness: z.number(),
      ledNightBrightness: z.number(),
      ledNightStartTime: z.string().nullable(),
      ledNightEndTime: z.string().nullable(),
      homekitEnabled: z.boolean(),
      pumpStallProtectionEnabled: z.boolean(),
      pumpStallRpmThreshold: z.number(),
      pumpStallDwellSamples: z.number(),
      pumpStallAutoRecoveryEnabled: z.boolean(),
      pumpStallRecoveryRpm: z.number(),
      pumpStallRecoverySamples: z.number(),
      createdAt: z.date(),
      updatedAt: z.date(),
    }))
    .mutation(async ({ input }) => {
      try {
        // Capture homekitEnabled before the commit so we can revert the DB
        // if the lifecycle call after commit fails. The transaction is
        // synchronous (better-sqlite3) and homekit.enable/disable is async,
        // so we can't run the lifecycle inside the transaction; rolling back
        // the flag is the next-best option.
        let priorHomekitEnabled = false
        if ('homekitEnabled' in input) {
          const [prevRow] = await db
            .select({ homekitEnabled: deviceSettings.homekitEnabled })
            .from(deviceSettings)
            .where(eq(deviceSettings.id, 1))
            .limit(1)
          priorHomekitEnabled = Boolean(prevRow?.homekitEnabled)
        }

        const updated = db.transaction((tx) => {
          // Fetch current settings to validate final computed state
          const [current] = tx
            .select()
            .from(deviceSettings)
            .where(eq(deviceSettings.id, 1))
            .limit(1)
            .all()

          if (!current) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'Device settings not found',
            })
          }

          // Compute final state after update
          const finalRebootDaily = input.rebootDaily ?? current.rebootDaily
          const finalRebootTime = input.rebootTime ?? current.rebootTime
          const finalPrimeDaily = input.primePodDaily ?? current.primePodDaily
          const finalPrimeTime = input.primePodTime ?? current.primePodTime

          // Validate final state
          if (finalRebootDaily && !finalRebootTime) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'rebootTime is required when rebootDaily is enabled',
            })
          }

          if (finalPrimeDaily && !finalPrimeTime) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'primePodTime is required when primePodDaily is enabled',
            })
          }

          const [result] = tx
            .update(deviceSettings)
            .set({ ...input, updatedAt: new Date() })
            .where(eq(deviceSettings.id, 1))
            .returning()
            .all()

          if (!result) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'Device settings not found',
            })
          }

          return result
        })

        try {
          await applySettingsSchedulerChanges(input)
        }
        catch (e) {
          console.error('Scheduler reload failed:', e)
        }

        // Immediate LED apply when brightness fields or the night-mode toggle
        // change. Without this the pod LED only updates on the next cron
        // boundary, which makes the slider feel broken and — when night mode
        // is disabled while currently in the night window — leaves the LED
        // dim until the user manually nudges the day slider.
        //
        // Note: when night mode stays enabled and the user only drags the day
        // slider, applySettingsSchedulerChanges above also fires scheduleLedNightMode
        // which emits its own initial-apply send. The pod gets two consecutive
        // SET_SETTINGS frames with the same value — idempotent at firmware,
        // not worth gating around.
        if (
          'ledDayBrightness' in input
          || 'ledNightBrightness' in input
          || 'ledNightModeEnabled' in input
          || 'ledNightStartTime' in input
          || 'ledNightEndTime' in input
        ) {
          try {
            const jobManager = await getJobManager()
            await jobManager.applyCurrentLedBrightness()
          }
          catch (e) {
            console.error('LED brightness immediate apply failed:', e)
          }
        }

        if (
          'pumpStallProtectionEnabled' in input
          || 'pumpStallRpmThreshold' in input
          || 'pumpStallDwellSamples' in input
          || 'pumpStallAutoRecoveryEnabled' in input
          || 'pumpStallRecoveryRpm' in input
          || 'pumpStallRecoverySamples' in input
        ) {
          invalidateGuardSettingsCache()
        }

        // Re-evaluate autoOffWatcher immediately so a tightened cap fires
        // without waiting for the 30s poll. Idempotent; no-op if watcher isn't running.
        if ('globalMaxOnHours' in input) {
          try {
            restartAutoOffTimers()
          }
          catch (e) {
            console.error('autoOff restart failed:', e)
          }
        }

        // homekit.setEnabled is the canonical toggle, but updateDevice also
        // accepts homekitEnabled (REST/OpenAPI clients hit this route). Mirror
        // the lifecycle call. If it fails, revert the DB flag so source-of-
        // truth matches runtime; otherwise the next boot's
        // startHomeKitIfEnabled would diverge from the bridge.
        if ('homekitEnabled' in input) {
          const homekit = await import('@/src/homekit')
          try {
            if (input.homekitEnabled) await homekit.enable()
            else await homekit.disable()
          }
          catch (lifecycleError) {
            try {
              await db
                .update(deviceSettings)
                .set({ homekitEnabled: priorHomekitEnabled, updatedAt: new Date() })
                .where(eq(deviceSettings.id, 1))
            }
            catch { /* preserve original lifecycle error */ }
            throw lifecycleError
          }
        }

        return updated
      }
      catch (error) {
        if (error instanceof TRPCError) throw error

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to update device settings: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  /**
   * Update side settings
   */
  updateSide: publicProcedure
    .meta({ openapi: { method: 'PATCH', path: '/settings/side', protect: false, tags: ['Settings'] } })
    .input(
      z
        .object({
          side: sideSchema,
          name: z.string().min(1).max(20).optional(),
          alwaysOn: z.boolean().optional(),
          awayMode: z.boolean().optional(),
          autoOffEnabled: z.boolean().optional(),
          autoOffMinutes: z.number().int().min(5).max(120).optional(),
          awayStart: isoDatetimeSchema.nullable().optional(),
          awayReturn: isoDatetimeSchema.nullable().optional(),
        })
        .strict()
    )
    .output(z.object({
      side: sideSchema,
      name: z.string(),
      awayMode: z.boolean(),
      alwaysOn: z.boolean(),
      autoOffEnabled: z.boolean(),
      autoOffMinutes: z.number(),
      awayStart: z.string().nullable(),
      awayReturn: z.string().nullable(),
      createdAt: z.date(),
      updatedAt: z.date(),
    }))
    .mutation(async ({ input }) => {
      try {
        const { side, ...updates } = input

        const updated = db.transaction((tx) => {
          // Read current row to merge away window for validation
          const [current] = tx
            .select()
            .from(sideSettings)
            .where(eq(sideSettings.side, side))
            .limit(1)
            .all()

          if (!current) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: `Side settings for ${side} not found`,
            })
          }

          // alwaysOn and autoOffEnabled are mutually exclusive — the UI
          // already enforces this but a direct API call could land both as
          // true. Reject so the autoOffWatcher's "alwaysOn wins" tiebreak
          // never has to paper over an inconsistent persisted state.
          const finalAlwaysOn = updates.alwaysOn !== undefined ? updates.alwaysOn : current.alwaysOn
          const finalAutoOff = updates.autoOffEnabled !== undefined ? updates.autoOffEnabled : current.autoOffEnabled
          if (finalAlwaysOn && finalAutoOff) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'alwaysOn and autoOffEnabled are mutually exclusive — set the other to false in the same call',
            })
          }

          // Validate merged away window — reject reversed ranges
          if ('awayStart' in updates || 'awayReturn' in updates) {
            const finalStart = updates.awayStart !== undefined ? updates.awayStart : current.awayStart
            const finalReturn = updates.awayReturn !== undefined ? updates.awayReturn : current.awayReturn

            if (finalStart && finalReturn && new Date(finalReturn) < new Date(finalStart)) {
              throw new TRPCError({
                code: 'BAD_REQUEST',
                message: 'awayReturn must not be before awayStart',
              })
            }
          }

          const [result] = tx
            .update(sideSettings)
            .set({
              ...updates,
              updatedAt: new Date(),
            })
            .where(eq(sideSettings.side, side))
            .returning()
            .all()

          if (!result) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: `Side settings for ${side} not found`,
            })
          }

          return result
        })

        // Apply away-mode scheduling incrementally if it changed
        if ('awayStart' in input || 'awayReturn' in input) {
          try {
            const jobManager = await getJobManager()
            jobManager.upsertAwayMode(updated.side, updated.awayStart, updated.awayReturn)
          }
          catch (e) {
            console.error('Scheduler reload failed:', e)
          }
        }

        // Start/stop keepalive if alwaysOn changed
        if ('alwaysOn' in input) {
          if (input.alwaysOn) {
            startKeepalive(input.side)
          }
          else {
            stopKeepalive(input.side)
          }
        }

        // Restart auto-off timers if auto-off settings changed
        if ('autoOffEnabled' in input || 'autoOffMinutes' in input) {
          try {
            restartAutoOffTimers()
          }
          catch (e) {
            console.error('Auto-off timer restart failed:', e)
          }
        }

        return updated
      }
      catch (error) {
        if (error instanceof TRPCError) throw error

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to update side settings: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  /**
   * Set alwaysOn mode for a side.
   * When enabled, the keepalive service periodically re-sends the current
   * target temperature to prevent the firmware's 8-hour duration timeout.
   */
  setAlwaysOn: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/settings/always-on', protect: false, tags: ['Settings'] } })
    .input(
      z
        .object({
          side: sideSchema,
          alwaysOn: z.boolean(),
        })
        .strict()
    )
    .output(z.object({
      side: sideSchema,
      name: z.string(),
      awayMode: z.boolean(),
      alwaysOn: z.boolean(),
      autoOffEnabled: z.boolean(),
      autoOffMinutes: z.number(),
      awayStart: z.string().nullable(),
      awayReturn: z.string().nullable(),
      createdAt: z.date(),
      updatedAt: z.date(),
    }))
    .mutation(async ({ input }) => {
      try {
        const updated = db.transaction((tx) => {
          const [row] = tx
            .update(sideSettings)
            .set({ alwaysOn: input.alwaysOn, updatedAt: new Date() })
            .where(eq(sideSettings.side, input.side))
            .returning()
            .all()

          if (!row) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: `Side settings for ${input.side} not found`,
            })
          }

          return row
        })

        if (input.alwaysOn) {
          startKeepalive(input.side)
        }
        else {
          stopKeepalive(input.side)
        }

        return updated
      }
      catch (error) {
        if (error instanceof TRPCError) throw error

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to set alwaysOn: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  /**
   * Create or update tap gesture
   *
   * Uses discriminated union validation to ensure:
   * - actionType='temperature' requires temperatureChange + temperatureAmount
   * - actionType='alarm' requires alarmBehavior (+ optional snooze/inactive fields)
   */
  setGesture: publicProcedure
    .input(
      z.discriminatedUnion('actionType', [
        z
          .object({
            side: sideSchema,
            tapType: tapTypeSchema,
            actionType: z.literal('temperature'),
            temperatureChange: z.enum(['increment', 'decrement']),
            temperatureAmount: z.number().int().min(0).max(10),
          })
          .strict(),
        z
          .object({
            side: sideSchema,
            tapType: tapTypeSchema,
            actionType: z.literal('alarm'),
            alarmBehavior: z.enum(['snooze', 'dismiss']),
            alarmSnoozeDuration: z.number().int().min(60).max(600).optional(),
            alarmInactiveBehavior: z.enum(['power', 'none']).optional(),
          })
          .strict(),
      ])
    )
    .mutation(async ({ input }) => {
      try {
        const result = db.transaction((tx) => {
          // Check if gesture already exists
          const existing = tx
            .select()
            .from(tapGestures)
            .where(
              and(
                eq(tapGestures.side, input.side),
                eq(tapGestures.tapType, input.tapType)
              )
            )
            .limit(1)
            .all()

          if (existing.length > 0) {
            // Update existing
            const [updated] = tx
              .update(tapGestures)
              .set({
                ...input,
                updatedAt: new Date(),
              })
              .where(eq(tapGestures.id, existing[0].id))
              .returning()
              .all()

            if (!updated) {
              throw new TRPCError({
                code: 'INTERNAL_SERVER_ERROR',
                message: 'Failed to update gesture - no record returned',
              })
            }

            return updated
          }
          else {
            // Create new
            const [created] = tx
              .insert(tapGestures)
              .values({
                ...input,
              })
              .returning()
              .all()

            if (!created) {
              throw new TRPCError({
                code: 'INTERNAL_SERVER_ERROR',
                message: 'Failed to create gesture - no record returned',
              })
            }

            return created
          }
        })

        return result
      }
      catch (error) {
        if (error instanceof TRPCError) throw error

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to set gesture: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  /**
   * Delete tap gesture
   */
  deleteGesture: publicProcedure
    .meta({ openapi: { method: 'DELETE', path: '/settings/gesture', protect: false, tags: ['Settings'] } })
    .input(
      z
        .object({
          side: sideSchema,
          tapType: tapTypeSchema,
        })
        .strict()
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ input }) => {
      try {
        db.transaction((tx) => {
          const [deleted] = tx
            .delete(tapGestures)
            .where(
              and(
                eq(tapGestures.side, input.side),
                eq(tapGestures.tapType, input.tapType)
              )
            )
            .returning()
            .all()

          if (!deleted) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: `Gesture for ${input.side} ${input.tapType} not found`,
            })
          }
        })

        return { success: true }
      }
      catch (error) {
        if (error instanceof TRPCError) throw error

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to delete gesture: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),
})
