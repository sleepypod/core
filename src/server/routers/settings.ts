import { z } from 'zod'
import { publicProcedure, router } from '@/src/server/trpc'
import { db } from '@/src/db'
import { deviceSettings, sideSettings, tapGestures } from '@/src/db/schema'
import { eq, and } from 'drizzle-orm'

/**
 * Settings router - manages device configuration
 */
export const settingsRouter = router({
  /**
   * Get all settings
   */
  getAll: publicProcedure.query(async () => {
    const [device] = await db.select().from(deviceSettings).limit(1)
    const sides = await db.select().from(sideSettings)
    const gestures = await db.select().from(tapGestures)

    return {
      device: device || null,
      sides: {
        left: sides.find((s) => s.side === 'left') || null,
        right: sides.find((s) => s.side === 'right') || null,
      },
      gestures: {
        left: gestures.filter((g) => g.side === 'left'),
        right: gestures.filter((g) => g.side === 'right'),
      },
    }
  }),

  /**
   * Update device settings
   */
  updateDevice: publicProcedure
    .input(
      z.object({
        timezone: z.string().optional(),
        temperatureUnit: z.enum(['F', 'C']).optional(),
        rebootDaily: z.boolean().optional(),
        rebootTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).optional(),
        primePodDaily: z.boolean().optional(),
        primePodTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).optional(),
      })
    )
    .mutation(async ({ input }) => {
      const [updated] = await db
        .update(deviceSettings)
        .set({
          ...input,
          updatedAt: new Date(),
        })
        .where(eq(deviceSettings.id, 1))
        .returning()

      return updated
    }),

  /**
   * Update side settings
   */
  updateSide: publicProcedure
    .input(
      z.object({
        side: z.enum(['left', 'right']),
        name: z.string().min(1).max(20).optional(),
        awayMode: z.boolean().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const { side, ...updates } = input

      const [updated] = await db
        .update(sideSettings)
        .set({
          ...updates,
          updatedAt: new Date(),
        })
        .where(eq(sideSettings.side, side))
        .returning()

      return updated
    }),

  /**
   * Create or update tap gesture
   */
  setGesture: publicProcedure
    .input(
      z.object({
        side: z.enum(['left', 'right']),
        tapType: z.enum(['doubleTap', 'tripleTap', 'quadTap']),
        actionType: z.enum(['temperature', 'alarm']),
        // Temperature action fields
        temperatureChange: z.enum(['increment', 'decrement']).optional(),
        temperatureAmount: z.number().min(0).max(10).optional(),
        // Alarm action fields
        alarmBehavior: z.enum(['snooze', 'dismiss']).optional(),
        alarmSnoozeDuration: z.number().min(60).max(600).optional(),
        alarmInactiveBehavior: z.enum(['power', 'none']).optional(),
      })
    )
    .mutation(async ({ input }) => {
      // Check if gesture already exists
      const existing = await db
        .select()
        .from(tapGestures)
        .where(
          and(
            eq(tapGestures.side, input.side),
            eq(tapGestures.tapType, input.tapType)
          )
        )
        .limit(1)

      if (existing.length > 0) {
        // Update existing
        const [updated] = await db
          .update(tapGestures)
          .set({
            ...input,
            updatedAt: new Date(),
          })
          .where(eq(tapGestures.id, existing[0].id))
          .returning()

        return updated
      } else {
        // Create new
        const [created] = await db
          .insert(tapGestures)
          .values({
            ...input,
          })
          .returning()

        return created
      }
    }),

  /**
   * Delete tap gesture
   */
  deleteGesture: publicProcedure
    .input(
      z.object({
        side: z.enum(['left', 'right']),
        tapType: z.enum(['doubleTap', 'tripleTap', 'quadTap']),
      })
    )
    .mutation(async ({ input }) => {
      await db
        .delete(tapGestures)
        .where(
          and(
            eq(tapGestures.side, input.side),
            eq(tapGestures.tapType, input.tapType)
          )
        )

      return { success: true }
    }),
})
