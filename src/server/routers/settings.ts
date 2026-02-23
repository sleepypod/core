import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { publicProcedure, router } from '@/src/server/trpc'
import { db } from '@/src/db'
import { deviceSettings, sideSettings, tapGestures } from '@/src/db/schema'
import { eq, and } from 'drizzle-orm'
import {
  sideSchema,
  tapTypeSchema,
  temperatureUnitSchema,
  timeStringSchema,
} from '@/src/server/validation-schemas'

/**
 * Settings router - manages device configuration
 */
export const settingsRouter = router({
  /**
   * Get all settings
   */
  getAll: publicProcedure.query(async () => {
    try {
      const [device] = await db.select().from(deviceSettings).limit(1)
      const sides = await db.select().from(sideSettings)
      const gestures = await db.select().from(tapGestures)

      return {
        device: device || null,
        sides: {
          left: sides.find(s => s.side === 'left') || null,
          right: sides.find(s => s.side === 'right') || null,
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
    .input(
      z
        .object({
          timezone: z.string().optional(),
          temperatureUnit: temperatureUnitSchema.optional(),
          rebootDaily: z.boolean().optional(),
          rebootTime: timeStringSchema.optional(),
          primePodDaily: z.boolean().optional(),
          primePodTime: timeStringSchema.optional(),
        })
        .strict()
        .refine(
          (data) => {
            // If rebootDaily is true, rebootTime should be provided
            if (data.rebootDaily === true && !data.rebootTime) {
              return false
            }
            return true
          },
          {
            message: 'rebootTime is required when rebootDaily is true',
            path: ['rebootTime'],
          }
        )
        .refine(
          (data) => {
            // If primePodDaily is true, primePodTime should be provided
            if (data.primePodDaily === true && !data.primePodTime) {
              return false
            }
            return true
          },
          {
            message: 'primePodTime is required when primePodDaily is true',
            path: ['primePodTime'],
          }
        )
    )
    .mutation(async ({ input }) => {
      try {
        const [updated] = await db
          .update(deviceSettings)
          .set({
            ...input,
            updatedAt: new Date(),
          })
          .where(eq(deviceSettings.id, 1))
          .returning()

        if (!updated) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Device settings not found',
          })
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
    .input(
      z
        .object({
          side: sideSchema,
          name: z.string().min(1).max(20).optional(),
          awayMode: z.boolean().optional(),
        })
        .strict()
    )
    .mutation(async ({ input }) => {
      try {
        const { side, ...updates } = input

        const [updated] = await db
          .update(sideSettings)
          .set({
            ...updates,
            updatedAt: new Date(),
          })
          .where(eq(sideSettings.side, side))
          .returning()

        if (!updated) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: `Side settings for ${side} not found`,
          })
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
          const [created] = await db
            .insert(tapGestures)
            .values({
              ...input,
            })
            .returning()

          if (!created) {
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: 'Failed to create gesture - no record returned',
            })
          }

          return created
        }
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
    .input(
      z
        .object({
          side: sideSchema,
          tapType: tapTypeSchema,
        })
        .strict()
    )
    .mutation(async ({ input }) => {
      try {
        await db
          .delete(tapGestures)
          .where(
            and(
              eq(tapGestures.side, input.side),
              eq(tapGestures.tapType, input.tapType)
            )
          )

        return { success: true }
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to delete gesture: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),
})
