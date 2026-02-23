import { z } from 'zod'
import { publicProcedure, router } from '@/src/server/trpc'
import { db } from '@/src/db'
import {
  temperatureSchedules,
  powerSchedules,
  alarmSchedules,
} from '@/src/db/schema'
import { eq, and } from 'drizzle-orm'

const dayOfWeekEnum = z.enum([
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
])

/**
 * Schedules router - manages temperature, power, and alarm schedules
 */
export const schedulesRouter = router({
  /**
   * Get all schedules for a side
   */
  getAll: publicProcedure
    .input(
      z.object({
        side: z.enum(['left', 'right']),
      })
    )
    .query(async ({ input }) => {
      const [tempSchedules, powSchedules, almSchedules] = await Promise.all([
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
        temperature: tempSchedules,
        power: powSchedules,
        alarm: almSchedules,
      }
    }),

  /**
   * Create temperature schedule
   */
  createTemperatureSchedule: publicProcedure
    .input(
      z.object({
        side: z.enum(['left', 'right']),
        dayOfWeek: dayOfWeekEnum,
        time: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/),
        temperature: z.number().min(55).max(110),
        enabled: z.boolean().default(true),
      })
    )
    .mutation(async ({ input }) => {
      const [created] = await db
        .insert(temperatureSchedules)
        .values(input)
        .returning()

      return created
    }),

  /**
   * Update temperature schedule
   */
  updateTemperatureSchedule: publicProcedure
    .input(
      z.object({
        id: z.number(),
        time: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).optional(),
        temperature: z.number().min(55).max(110).optional(),
        enabled: z.boolean().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const { id, ...updates } = input

      const [updated] = await db
        .update(temperatureSchedules)
        .set({
          ...updates,
          updatedAt: new Date(),
        })
        .where(eq(temperatureSchedules.id, id))
        .returning()

      return updated
    }),

  /**
   * Delete temperature schedule
   */
  deleteTemperatureSchedule: publicProcedure
    .input(
      z.object({
        id: z.number(),
      })
    )
    .mutation(async ({ input }) => {
      await db
        .delete(temperatureSchedules)
        .where(eq(temperatureSchedules.id, input.id))

      return { success: true }
    }),

  /**
   * Create power schedule
   */
  createPowerSchedule: publicProcedure
    .input(
      z.object({
        side: z.enum(['left', 'right']),
        dayOfWeek: dayOfWeekEnum,
        onTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/),
        offTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/),
        onTemperature: z.number().min(55).max(110),
        enabled: z.boolean().default(true),
      })
    )
    .mutation(async ({ input }) => {
      const [created] = await db.insert(powerSchedules).values(input).returning()

      return created
    }),

  /**
   * Update power schedule
   */
  updatePowerSchedule: publicProcedure
    .input(
      z.object({
        id: z.number(),
        onTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).optional(),
        offTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).optional(),
        onTemperature: z.number().min(55).max(110).optional(),
        enabled: z.boolean().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const { id, ...updates } = input

      const [updated] = await db
        .update(powerSchedules)
        .set({
          ...updates,
          updatedAt: new Date(),
        })
        .where(eq(powerSchedules.id, id))
        .returning()

      return updated
    }),

  /**
   * Delete power schedule
   */
  deletePowerSchedule: publicProcedure
    .input(
      z.object({
        id: z.number(),
      })
    )
    .mutation(async ({ input }) => {
      await db.delete(powerSchedules).where(eq(powerSchedules.id, input.id))

      return { success: true }
    }),

  /**
   * Create alarm schedule
   */
  createAlarmSchedule: publicProcedure
    .input(
      z.object({
        side: z.enum(['left', 'right']),
        dayOfWeek: dayOfWeekEnum,
        time: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/),
        vibrationIntensity: z.number().min(1).max(100),
        vibrationPattern: z.enum(['double', 'rise']).default('rise'),
        duration: z.number().min(0).max(180),
        alarmTemperature: z.number().min(55).max(110),
        enabled: z.boolean().default(true),
      })
    )
    .mutation(async ({ input }) => {
      const [created] = await db.insert(alarmSchedules).values(input).returning()

      return created
    }),

  /**
   * Update alarm schedule
   */
  updateAlarmSchedule: publicProcedure
    .input(
      z.object({
        id: z.number(),
        time: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).optional(),
        vibrationIntensity: z.number().min(1).max(100).optional(),
        vibrationPattern: z.enum(['double', 'rise']).optional(),
        duration: z.number().min(0).max(180).optional(),
        alarmTemperature: z.number().min(55).max(110).optional(),
        enabled: z.boolean().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const { id, ...updates } = input

      const [updated] = await db
        .update(alarmSchedules)
        .set({
          ...updates,
          updatedAt: new Date(),
        })
        .where(eq(alarmSchedules.id, id))
        .returning()

      return updated
    }),

  /**
   * Delete alarm schedule
   */
  deleteAlarmSchedule: publicProcedure
    .input(
      z.object({
        id: z.number(),
      })
    )
    .mutation(async ({ input }) => {
      await db.delete(alarmSchedules).where(eq(alarmSchedules.id, input.id))

      return { success: true }
    }),

  /**
   * Get schedules for a specific day
   */
  getByDay: publicProcedure
    .input(
      z.object({
        side: z.enum(['left', 'right']),
        dayOfWeek: dayOfWeekEnum,
      })
    )
    .query(async ({ input }) => {
      const [tempSchedules, powSchedules, almSchedules] = await Promise.all([
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
        temperature: tempSchedules,
        power: powSchedules,
        alarm: almSchedules,
      }
    }),
})
