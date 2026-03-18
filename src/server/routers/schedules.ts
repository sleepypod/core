import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { publicProcedure, router } from '@/src/server/trpc'
import { db } from '@/src/db'
import {
  temperatureSchedules,
  powerSchedules,
  alarmSchedules,
} from '@/src/db/schema'
import { eq, and } from 'drizzle-orm'
import {
  sideSchema,
  dayOfWeekSchema,
  timeStringSchema,
  temperatureSchema,
  idSchema,
  vibrationIntensitySchema,
  vibrationPatternSchema,
  alarmDurationSchema,
  validateTimeRange,
} from '@/src/server/validation-schemas'
import { getJobManager } from '@/src/scheduler'

/**
 * Reload schedules in the job manager after database changes
 */
async function reloadScheduler(): Promise<void> {
  const jobManager = await getJobManager()
  await jobManager.reloadSchedules()
}

/**
 * Schedules router - manages temperature, power, and alarm schedules
 */
export const schedulesRouter = router({
  /**
   * Get all schedules for a side
   */
  getAll: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/schedules', protect: false, tags: ['Schedules'] } })
    .input(
      z
        .object({
          side: sideSchema,
        })
        .strict()
    )
    .output(z.any())
    .query(async ({ input }) => {
      try {
        const [temperatureSchedulesList, powerSchedulesList, alarmSchedulesList]
          = await Promise.all([
            db
              .select()
              .from(temperatureSchedules)
              .where(eq(temperatureSchedules.side, input.side)),
            db
              .select()
              .from(powerSchedules)
              .where(eq(powerSchedules.side, input.side)),
            db
              .select()
              .from(alarmSchedules)
              .where(eq(alarmSchedules.side, input.side)),
          ])

        return {
          temperature: temperatureSchedulesList,
          power: powerSchedulesList,
          alarm: alarmSchedulesList,
        }
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to fetch schedules: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  /**
   * Create temperature schedule
   */
  createTemperatureSchedule: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/schedules/temperature', protect: false, tags: ['Schedules'] } })
    .input(
      z
        .object({
          side: sideSchema,
          dayOfWeek: dayOfWeekSchema,
          time: timeStringSchema,
          temperature: temperatureSchema,
          enabled: z.boolean().default(true),
        })
        .strict()
    )
    .output(z.any())
    .mutation(async ({ input }) => {
      try {
        const created = db.transaction((tx) => {
          const [result] = tx.insert(temperatureSchedules).values(input).returning().all()
          if (!result) {
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: 'Failed to create temperature schedule - no record returned',
            })
          }

          return result
        })

        try {
          await reloadScheduler()
        }
        catch (e) {
          console.error('Scheduler reload failed:', e)
        }

        return created
      }
      catch (error) {
        if (error instanceof TRPCError) throw error

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to create temperature schedule: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  /**
   * Update temperature schedule
   */
  updateTemperatureSchedule: publicProcedure
    .meta({ openapi: { method: 'PATCH', path: '/schedules/temperature', protect: false, tags: ['Schedules'] } })
    .input(
      z
        .object({
          id: idSchema,
          time: timeStringSchema.optional(),
          temperature: temperatureSchema.optional(),
          enabled: z.boolean().optional(),
        })
        .strict()
    )
    .output(z.any())
    .mutation(async ({ input }) => {
      try {
        const { id, ...updates } = input

        const updated = db.transaction((tx) => {
          const [result] = tx
            .update(temperatureSchedules)
            .set({ ...updates, updatedAt: new Date() })
            .where(eq(temperatureSchedules.id, id))
            .returning()
            .all()
          if (!result) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: `Temperature schedule with ID ${id} not found`,
            })
          }

          return result
        })

        try {
          await reloadScheduler()
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
          message: `Failed to update temperature schedule: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  /**
   * Delete temperature schedule
   */
  deleteTemperatureSchedule: publicProcedure
    .meta({ openapi: { method: 'DELETE', path: '/schedules/temperature', protect: false, tags: ['Schedules'] } })
    .input(
      z
        .object({
          id: idSchema,
        })
        .strict()
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ input }) => {
      try {
        void db.transaction((tx) => {
          const [deleted] = tx
            .delete(temperatureSchedules)
            .where(eq(temperatureSchedules.id, input.id))
            .returning()
            .all()
          if (!deleted) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: `Temperature schedule with ID ${input.id} not found`,
            })
          }
        })

        try {
          await reloadScheduler()
        }
        catch (e) {
          console.error('Scheduler reload failed:', e)
        }

        return { success: true }
      }
      catch (error) {
        if (error instanceof TRPCError) throw error

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to delete temperature schedule: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  /**
   * Create power schedule
   */
  createPowerSchedule: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/schedules/power', protect: false, tags: ['Schedules'] } })
    .input(
      z
        .object({
          side: sideSchema,
          dayOfWeek: dayOfWeekSchema,
          onTime: timeStringSchema,
          offTime: timeStringSchema,
          onTemperature: temperatureSchema,
          enabled: z.boolean().default(true),
        })
        .strict()
    )
    .output(z.any())
    .mutation(async ({ input }) => {
      try {
        if (!validateTimeRange(input.onTime, input.offTime)) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'onTime must be before offTime' })
        }

        const created = db.transaction((tx) => {
          const [result] = tx.insert(powerSchedules).values(input).returning().all()
          if (!result) {
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: 'Failed to create power schedule - no record returned',
            })
          }

          return result
        })

        try {
          await reloadScheduler()
        }
        catch (e) {
          console.error('Scheduler reload failed:', e)
        }

        return created
      }
      catch (error) {
        if (error instanceof TRPCError) throw error

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to create power schedule: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  /**
   * Update power schedule
   */
  updatePowerSchedule: publicProcedure
    .meta({ openapi: { method: 'PATCH', path: '/schedules/power', protect: false, tags: ['Schedules'] } })
    .input(
      z
        .object({
          id: idSchema,
          onTime: timeStringSchema.optional(),
          offTime: timeStringSchema.optional(),
          onTemperature: temperatureSchema.optional(),
          enabled: z.boolean().optional(),
        })
        .strict()
    )
    .output(z.any())
    .mutation(async ({ input }) => {
      try {
        if (input.onTime && input.offTime && !validateTimeRange(input.onTime, input.offTime)) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'onTime must be before offTime' })
        }

        const { id, ...updates } = input

        const updated = db.transaction((tx) => {
          // If partial time update, validate final computed state
          if ((input.onTime || input.offTime) && !(input.onTime && input.offTime)) {
            const [existing] = tx
              .select({ onTime: powerSchedules.onTime, offTime: powerSchedules.offTime })
              .from(powerSchedules)
              .where(eq(powerSchedules.id, id))
              .limit(1)
              .all()

            if (!existing) {
              throw new TRPCError({
                code: 'NOT_FOUND',
                message: `Power schedule with ID ${id} not found`,
              })
            }

            const finalOnTime = input.onTime ?? existing.onTime
            const finalOffTime = input.offTime ?? existing.offTime

            if (!validateTimeRange(finalOnTime, finalOffTime)) {
              throw new TRPCError({
                code: 'BAD_REQUEST',
                message: 'onTime must be before offTime',
              })
            }
          }

          const [result] = tx
            .update(powerSchedules)
            .set({ ...updates, updatedAt: new Date() })
            .where(eq(powerSchedules.id, id))
            .returning()
            .all()
          if (!result) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: `Power schedule with ID ${id} not found`,
            })
          }

          return result
        })

        try {
          await reloadScheduler()
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
          message: `Failed to update power schedule: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  /**
   * Delete power schedule
   */
  deletePowerSchedule: publicProcedure
    .meta({ openapi: { method: 'DELETE', path: '/schedules/power', protect: false, tags: ['Schedules'] } })
    .input(
      z
        .object({
          id: idSchema,
        })
        .strict()
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ input }) => {
      try {
        void db.transaction((tx) => {
          const [deleted] = tx
            .delete(powerSchedules)
            .where(eq(powerSchedules.id, input.id))
            .returning()
            .all()
          if (!deleted) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: `Power schedule with ID ${input.id} not found`,
            })
          }
        })

        try {
          await reloadScheduler()
        }
        catch (e) {
          console.error('Scheduler reload failed:', e)
        }

        return { success: true }
      }
      catch (error) {
        if (error instanceof TRPCError) throw error

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to delete power schedule: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  /**
   * Create alarm schedule
   */
  createAlarmSchedule: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/schedules/alarm', protect: false, tags: ['Schedules'] } })
    .input(
      z
        .object({
          side: sideSchema,
          dayOfWeek: dayOfWeekSchema,
          time: timeStringSchema,
          vibrationIntensity: vibrationIntensitySchema,
          vibrationPattern: vibrationPatternSchema.default('rise'),
          duration: alarmDurationSchema,
          alarmTemperature: temperatureSchema,
          enabled: z.boolean().default(true),
        })
        .strict()
    )
    .output(z.any())
    .mutation(async ({ input }) => {
      try {
        const created = db.transaction((tx) => {
          const [result] = tx.insert(alarmSchedules).values(input).returning().all()
          if (!result) {
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: 'Failed to create alarm schedule - no record returned',
            })
          }

          return result
        })

        try {
          await reloadScheduler()
        }
        catch (e) {
          console.error('Scheduler reload failed:', e)
        }

        return created
      }
      catch (error) {
        if (error instanceof TRPCError) throw error

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to create alarm schedule: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  /**
   * Update alarm schedule
   */
  updateAlarmSchedule: publicProcedure
    .meta({ openapi: { method: 'PATCH', path: '/schedules/alarm', protect: false, tags: ['Schedules'] } })
    .input(
      z
        .object({
          id: idSchema,
          time: timeStringSchema.optional(),
          vibrationIntensity: vibrationIntensitySchema.optional(),
          vibrationPattern: vibrationPatternSchema.optional(),
          duration: alarmDurationSchema.optional(),
          alarmTemperature: temperatureSchema.optional(),
          enabled: z.boolean().optional(),
        })
        .strict()
    )
    .output(z.any())
    .mutation(async ({ input }) => {
      try {
        const { id, ...updates } = input

        const updated = db.transaction((tx) => {
          const [result] = tx
            .update(alarmSchedules)
            .set({ ...updates, updatedAt: new Date() })
            .where(eq(alarmSchedules.id, id))
            .returning()
            .all()
          if (!result) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: `Alarm schedule with ID ${id} not found`,
            })
          }

          return result
        })

        try {
          await reloadScheduler()
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
          message: `Failed to update alarm schedule: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  /**
   * Delete alarm schedule
   */
  deleteAlarmSchedule: publicProcedure
    .meta({ openapi: { method: 'DELETE', path: '/schedules/alarm', protect: false, tags: ['Schedules'] } })
    .input(
      z
        .object({
          id: idSchema,
        })
        .strict()
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ input }) => {
      try {
        void db.transaction((tx) => {
          const [deleted] = tx
            .delete(alarmSchedules)
            .where(eq(alarmSchedules.id, input.id))
            .returning()
            .all()
          if (!deleted) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: `Alarm schedule with ID ${input.id} not found`,
            })
          }
        })

        try {
          await reloadScheduler()
        }
        catch (e) {
          console.error('Scheduler reload failed:', e)
        }

        return { success: true }
      }
      catch (error) {
        if (error instanceof TRPCError) throw error

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to delete alarm schedule: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  /**
   * Get schedules for a specific day
   */
  getByDay: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/schedules/by-day', protect: false, tags: ['Schedules'] } })
    .input(
      z
        .object({
          side: sideSchema,
          dayOfWeek: dayOfWeekSchema,
        })
        .strict()
    )
    .output(z.any())
    .query(async ({ input }) => {
      try {
        const [temperatureSchedulesList, powerSchedulesList, alarmSchedulesList]
          = await Promise.all([
            db
              .select()
              .from(temperatureSchedules)
              .where(
                and(
                  eq(temperatureSchedules.side, input.side),
                  eq(temperatureSchedules.dayOfWeek, input.dayOfWeek)
                )
              ),
            db
              .select()
              .from(powerSchedules)
              .where(
                and(
                  eq(powerSchedules.side, input.side),
                  eq(powerSchedules.dayOfWeek, input.dayOfWeek)
                )
              ),
            db
              .select()
              .from(alarmSchedules)
              .where(
                and(
                  eq(alarmSchedules.side, input.side),
                  eq(alarmSchedules.dayOfWeek, input.dayOfWeek)
                )
              ),
          ])

        return {
          temperature: temperatureSchedulesList,
          power: powerSchedulesList,
          alarm: alarmSchedulesList,
        }
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to fetch schedules by day: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),
})
