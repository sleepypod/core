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
import { getJobManager } from '@/src/scheduler'
import { startKeepalive, stopKeepalive } from '@/src/services/temperatureKeepalive'
import { restartAutoOffTimers } from '@/src/services/autoOffWatcher'

/**
 * Reload schedules in the job manager after settings changes
 * that affect scheduling (timezone, priming, reboot)
 */
async function reloadSchedulerIfNeeded(input: Record<string, unknown>): Promise<void> {
  const schedulingKeys = [
    'timezone', 'rebootDaily', 'rebootTime', 'primePodDaily', 'primePodTime',
    'ledNightModeEnabled', 'ledDayBrightness', 'ledNightBrightness',
    'ledNightStartTime', 'ledNightEndTime',
  ]
  const hasSchedulingChanges = schedulingKeys.some(key => key in input)

  if (hasSchedulingChanges) {
    const jobManager = await getJobManager()

    // If timezone changed, use updateTimezone which reloads automatically
    if ('timezone' in input && typeof input.timezone === 'string') {
      await jobManager.updateTimezone(input.timezone)
    }
    else {
      await jobManager.reloadSchedules()
    }
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
    .output(z.any())
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
        })
        .strict()
    )
    .output(z.any())
    .mutation(async ({ input }) => {
      try {
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
          await reloadSchedulerIfNeeded(input)
        }
        catch (e) {
          console.error('Scheduler reload failed:', e)
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
    .output(z.any())
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

        // Reload scheduler if away mode scheduling changed
        if ('awayStart' in input || 'awayReturn' in input) {
          try {
            const jobManager = await getJobManager()
            await jobManager.reloadSchedules()
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
    .output(z.any())
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
