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
} from '@/src/server/validation-schemas'

const temperatureScheduleOutput = z.object({
  id: z.number(),
  side: sideSchema,
  dayOfWeek: dayOfWeekSchema,
  time: z.string(),
  temperature: z.number(),
  enabled: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

const powerScheduleOutput = z.object({
  id: z.number(),
  side: sideSchema,
  dayOfWeek: dayOfWeekSchema,
  onTime: z.string(),
  offTime: z.string(),
  onTemperature: z.number(),
  enabled: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

const alarmScheduleOutput = z.object({
  id: z.number(),
  side: sideSchema,
  dayOfWeek: dayOfWeekSchema,
  time: z.string(),
  vibrationIntensity: z.number(),
  vibrationPattern: vibrationPatternSchema,
  duration: z.number(),
  alarmTemperature: z.number(),
  enabled: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

const schedulesCollectionOutput = z.object({
  temperature: z.array(temperatureScheduleOutput),
  power: z.array(powerScheduleOutput),
  alarm: z.array(alarmScheduleOutput),
})
import { getJobManager } from '@/src/scheduler'
import { toC } from '@/src/lib/tempUtils'

type TemperatureRow = typeof temperatureSchedules.$inferSelect
type PowerRow = typeof powerSchedules.$inferSelect
type AlarmRow = typeof alarmSchedules.$inferSelect

/**
 * Apply an incremental scheduler mutation. The helper resolves the job
 * manager and invokes `fn`; failures are logged but never thrown out of the
 * route handler — schedule writes already committed, and the heartbeat
 * liveness loop will recover any drift.
 */
async function applyScheduler(fn: (jm: Awaited<ReturnType<typeof getJobManager>>) => void | Promise<void>): Promise<void> {
  try {
    const jobManager = await getJobManager()
    await fn(jobManager)
  }
  catch (e) {
    console.error('Scheduler update failed:', e)
  }
}

const unitSchema = z.enum(['F', 'C']).default('F')

function convertScheduleTemps(
  data: { temperature: (typeof temperatureSchedules.$inferSelect)[], power: (typeof powerSchedules.$inferSelect)[], alarm: (typeof alarmSchedules.$inferSelect)[] },
  unit: 'F' | 'C',
) {
  if (unit === 'F') return data
  const c = (f: number) => Math.round(toC(f) * 10) / 10
  return {
    temperature: data.temperature.map(s => ({ ...s, temperature: c(s.temperature) })),
    power: data.power.map(s => ({ ...s, onTemperature: c(s.onTemperature) })),
    alarm: data.alarm.map(s => ({ ...s, alarmTemperature: c(s.alarmTemperature) })),
  }
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
          unit: unitSchema,
        })
        .strict()
    )
    .output(schedulesCollectionOutput)
    .query(async ({ input }) => {
      try {
        const temperatureSchedulesList = db
          .select()
          .from(temperatureSchedules)
          .where(eq(temperatureSchedules.side, input.side))
          .all()
        const powerSchedulesList = db
          .select()
          .from(powerSchedules)
          .where(eq(powerSchedules.side, input.side))
          .all()
        const alarmSchedulesList = db
          .select()
          .from(alarmSchedules)
          .where(eq(alarmSchedules.side, input.side))
          .all()

        return convertScheduleTemps({
          temperature: temperatureSchedulesList,
          power: powerSchedulesList,
          alarm: alarmSchedulesList,
        }, input.unit)
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
    .output(temperatureScheduleOutput)
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

        await applyScheduler(jm => jm.upsertTemperatureJob(created))

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
    .output(temperatureScheduleOutput)
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

        await applyScheduler(jm => jm.upsertTemperatureJob(updated))

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

        await applyScheduler(jm => jm.cancelTemperatureJob(input.id))

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
    .output(powerScheduleOutput)
    .mutation(async ({ input }) => {
      try {
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

        await applyScheduler(jm => jm.upsertPowerJob(created))

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
    .output(powerScheduleOutput)
    .mutation(async ({ input }) => {
      try {
        const { id, ...updates } = input

        const updated = db.transaction((tx) => {
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

        await applyScheduler(jm => jm.upsertPowerJob(updated))

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

        await applyScheduler(jm => jm.cancelPowerJob(input.id))

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
    .output(alarmScheduleOutput)
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

        await applyScheduler(jm => jm.upsertAlarmJob(created))

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
    .output(alarmScheduleOutput)
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

        await applyScheduler(jm => jm.upsertAlarmJob(updated))

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

        await applyScheduler(jm => jm.cancelAlarmJob(input.id))

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
   * Batch update schedules — deletes, creates, and updates in one transaction with one scheduler reload.
   * Used by bulk operations (apply to other days, toggle all) to avoid N+1 API calls.
   */
  batchUpdate: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/schedules/batch', protect: false, tags: ['Schedules'] } })
    .input(
      z.object({
        deletes: z.object({
          temperature: z.array(idSchema).max(1000).default([]),
          power: z.array(idSchema).max(1000).default([]),
          alarm: z.array(idSchema).max(1000).default([]),
        }).default({ temperature: [], power: [], alarm: [] }),
        creates: z.object({
          temperature: z.array(z.object({
            side: sideSchema,
            dayOfWeek: dayOfWeekSchema,
            time: timeStringSchema,
            temperature: temperatureSchema,
            enabled: z.boolean().default(true),
          })).max(1000).default([]),
          power: z.array(z.object({
            side: sideSchema,
            dayOfWeek: dayOfWeekSchema,
            onTime: timeStringSchema,
            offTime: timeStringSchema,
            onTemperature: temperatureSchema,
            enabled: z.boolean().default(true),
          })).max(1000).default([]),
          alarm: z.array(z.object({
            side: sideSchema,
            dayOfWeek: dayOfWeekSchema,
            time: timeStringSchema,
            vibrationIntensity: vibrationIntensitySchema,
            vibrationPattern: vibrationPatternSchema.default('rise'),
            duration: alarmDurationSchema,
            alarmTemperature: temperatureSchema,
            enabled: z.boolean().default(true),
          })).max(1000).default([]),
        }).default({ temperature: [], power: [], alarm: [] }),
        updates: z.object({
          temperature: z.array(z.object({
            id: idSchema,
            time: timeStringSchema.optional(),
            temperature: temperatureSchema.optional(),
            enabled: z.boolean().optional(),
          })).max(1000).default([]),
          power: z.array(z.object({
            id: idSchema,
            onTime: timeStringSchema.optional(),
            offTime: timeStringSchema.optional(),
            onTemperature: temperatureSchema.optional(),
            enabled: z.boolean().optional(),
          })).max(1000).default([]),
          alarm: z.array(z.object({
            id: idSchema,
            time: timeStringSchema.optional(),
            vibrationIntensity: vibrationIntensitySchema.optional(),
            vibrationPattern: vibrationPatternSchema.optional(),
            duration: alarmDurationSchema.optional(),
            alarmTemperature: temperatureSchema.optional(),
            enabled: z.boolean().optional(),
          })).max(1000).default([]),
        }).default({ temperature: [], power: [], alarm: [] }),
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ input }) => {
      try {
        const upsertTemp: TemperatureRow[] = []
        const upsertPower: PowerRow[] = []
        const upsertAlarm: AlarmRow[] = []

        db.transaction((tx) => {
          // Deletes first
          for (const id of input.deletes.temperature) {
            const [deleted] = tx.delete(temperatureSchedules).where(eq(temperatureSchedules.id, id)).returning().all()
            if (!deleted) throw new TRPCError({ code: 'NOT_FOUND', message: `Temperature schedule with ID ${id} not found` })
          }
          for (const id of input.deletes.power) {
            const [deleted] = tx.delete(powerSchedules).where(eq(powerSchedules.id, id)).returning().all()
            if (!deleted) throw new TRPCError({ code: 'NOT_FOUND', message: `Power schedule with ID ${id} not found` })
          }
          for (const id of input.deletes.alarm) {
            const [deleted] = tx.delete(alarmSchedules).where(eq(alarmSchedules.id, id)).returning().all()
            if (!deleted) throw new TRPCError({ code: 'NOT_FOUND', message: `Alarm schedule with ID ${id} not found` })
          }

          // Creates — capture the returned rows so we can hand them to the scheduler
          // post-commit (upsert needs the autogenerated id).
          for (const entry of input.creates.temperature) {
            const [row] = tx.insert(temperatureSchedules).values(entry).returning().all()
            if (!row) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to create temperature schedule - no record returned' })
            upsertTemp.push(row)
          }
          for (const entry of input.creates.power) {
            const [row] = tx.insert(powerSchedules).values(entry).returning().all()
            if (!row) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to create power schedule - no record returned' })
            upsertPower.push(row)
          }
          for (const entry of input.creates.alarm) {
            const [row] = tx.insert(alarmSchedules).values(entry).returning().all()
            if (!row) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to create alarm schedule - no record returned' })
            upsertAlarm.push(row)
          }

          // Updates
          for (const { id, ...updates } of input.updates.temperature) {
            const [updated] = tx.update(temperatureSchedules).set({ ...updates, updatedAt: new Date() }).where(eq(temperatureSchedules.id, id)).returning().all()
            if (!updated) throw new TRPCError({ code: 'NOT_FOUND', message: `Temperature schedule with ID ${id} not found` })
            upsertTemp.push(updated)
          }
          for (const { id, ...updates } of input.updates.power) {
            const [updated] = tx.update(powerSchedules).set({ ...updates, updatedAt: new Date() }).where(eq(powerSchedules.id, id)).returning().all()
            if (!updated) throw new TRPCError({ code: 'NOT_FOUND', message: `Power schedule with ID ${id} not found` })
            upsertPower.push(updated)
          }
          for (const { id, ...updates } of input.updates.alarm) {
            const [updated] = tx.update(alarmSchedules).set({ ...updates, updatedAt: new Date() }).where(eq(alarmSchedules.id, id)).returning().all()
            if (!updated) throw new TRPCError({ code: 'NOT_FOUND', message: `Alarm schedule with ID ${id} not found` })
            upsertAlarm.push(updated)
          }
        })

        await applyScheduler((jm) => {
          for (const id of input.deletes.temperature) jm.cancelTemperatureJob(id)
          for (const id of input.deletes.power) jm.cancelPowerJob(id)
          for (const id of input.deletes.alarm) jm.cancelAlarmJob(id)
          for (const row of upsertTemp) jm.upsertTemperatureJob(row)
          for (const row of upsertPower) jm.upsertPowerJob(row)
          for (const row of upsertAlarm) jm.upsertAlarmJob(row)
        })

        return { success: true }
      }
      catch (error) {
        if (error instanceof TRPCError) throw error

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to batch update schedules: ${error instanceof Error ? error.message : 'Unknown error'}`,
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
          unit: unitSchema,
        })
        .strict()
    )
    .output(schedulesCollectionOutput)
    .query(async ({ input }) => {
      try {
        const temperatureSchedulesList = db
          .select()
          .from(temperatureSchedules)
          .where(
            and(
              eq(temperatureSchedules.side, input.side),
              eq(temperatureSchedules.dayOfWeek, input.dayOfWeek)
            )
          )
          .all()
        const powerSchedulesList = db
          .select()
          .from(powerSchedules)
          .where(
            and(
              eq(powerSchedules.side, input.side),
              eq(powerSchedules.dayOfWeek, input.dayOfWeek)
            )
          )
          .all()
        const alarmSchedulesList = db
          .select()
          .from(alarmSchedules)
          .where(
            and(
              eq(alarmSchedules.side, input.side),
              eq(alarmSchedules.dayOfWeek, input.dayOfWeek)
            )
          )
          .all()

        return convertScheduleTemps({
          temperature: temperatureSchedulesList,
          power: powerSchedulesList,
          alarm: alarmSchedulesList,
        }, input.unit)
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
