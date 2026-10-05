import { TRPCError } from '@trpc/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/src/db'
import { baseSchedules } from '@/src/db/schema'
import { isBaseConfigured } from '@/src/hardware/base/configuration'
import { getBaseController } from '@/src/hardware/base/instance'
import { BASE_PRESETS, BaseError, basePositionSchema, baseMoveSchema, baseScopeSchema, baseDaysSchema, baseDayNumbers, basePresetSchema, baseStatusSchema } from '@/src/hardware/base/types'
import { getJobManager } from '@/src/scheduler'
import { publicProcedure, router } from '../trpc'
import { timeStringSchema, idSchema } from '../validation-schemas'

const success = z.object({ success: z.literal(true) })
const scheduleInput = basePositionSchema.extend({ dayOfWeek: baseDaysSchema, side: baseScopeSchema.default('both'), presetName: z.string().trim().min(1).max(40).default('Custom'), time: timeStringSchema, enabled: z.boolean() })
const scheduleOutput = scheduleInput.extend({ id: z.number() })
async function command(fn: () => Promise<void>) {
  try {
    await fn()
    return { success: true as const }
  }
  catch (error) {
    if (error instanceof BaseError) {
      throw new TRPCError({ code: error.code === 'busy' ? 'CONFLICT' : error.code === 'cancelled' ? 'CONFLICT' : 'PRECONDITION_FAILED', message: error.message })
    }
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Base command failed' })
  }
}

export const baseRouter = router({
  getAvailability: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/base/availability', tags: ['Base'] } })
    .input(z.object({})).output(z.object({ configured: z.boolean() }))
    .query(async () => ({ configured: await isBaseConfigured() })),
  getStatus: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/base/status', tags: ['Base'] } })
    .input(z.object({})).output(baseStatusSchema)
    .query(() => getBaseController().status()),
  reconnect: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/base/reconnect', tags: ['Base'] } })
    .input(z.object({})).output(baseStatusSchema)
    .mutation(async () => {
      await command(() => getBaseController().reconnect())
      return getBaseController().status()
    }),
  setPosition: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/base/position', tags: ['Base'] } })
    .input(baseMoveSchema).output(success)
    .mutation(({ input }) => command(() => getBaseController().setPosition(input))),
  setPreset: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/base/preset', tags: ['Base'] } })
    .input(z.object({ preset: basePresetSchema, sides: baseMoveSchema.shape.sides })).output(success)
    .mutation(({ input }) => command(() => getBaseController().setPosition({ ...BASE_PRESETS[input.preset], sides: input.sides }))),
  stop: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/base/stop', tags: ['Base'] } })
    .input(z.object({})).output(success)
    .mutation(() => command(() => getBaseController().stop())),
  getSchedules: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/base/schedules', tags: ['Base'] } })
    .input(z.object({})).output(z.array(scheduleOutput))
    .query(() => db.select().from(baseSchedules).all()),
  saveSchedule: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/base/schedules', tags: ['Base'] } })
    .input(scheduleInput.extend({ id: idSchema.optional() })).output(scheduleOutput)
    .mutation(async ({ input }) => {
      const { id, ...values } = input
      if (values.side !== 'both' && !getBaseController().status().independentControl) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'This base supports whole-bed movement only' })
      }
      // Resolve scheduler before persisting, so a startup failure cannot report
      // success for a schedule that will never be registered.
      const manager = await getJobManager()
      const overlaps = db.select().from(baseSchedules).all().some(row => row.id !== id && row.time === values.time
        && (row.side === 'both' || values.side === 'both' || row.side === values.side)
        && baseDayNumbers(row.dayOfWeek).some(day => baseDayNumbers(values.dayOfWeek).includes(day)))
      if (overlaps) throw new TRPCError({ code: 'CONFLICT', message: 'A base adjustment already exists for this side at this day and time' })
      let row: typeof baseSchedules.$inferSelect | undefined
      try {
        row = id === undefined
          ? db.insert(baseSchedules).values(values).returning().get()
          : db.update(baseSchedules).set(values).where(eq(baseSchedules.id, id)).returning().get()
      }
      catch (error) {
        if (error instanceof Error && error.message.includes('UNIQUE constraint')) {
          throw new TRPCError({ code: 'CONFLICT', message: 'A base adjustment already exists at this day and time' })
        }
        throw error
      }
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Base schedule not found' })
      manager.upsertBaseSchedule(row)
      return row
    }),
  deleteSchedule: publicProcedure
    .meta({ openapi: { method: 'DELETE', path: '/base/schedules/{id}', tags: ['Base'] } })
    .input(z.object({ id: idSchema })).output(success)
    .mutation(async ({ input }) => {
      const manager = await getJobManager()
      db.delete(baseSchedules).where(eq(baseSchedules.id, input.id)).run()
      manager.removeBaseSchedule(input.id)
      return { success: true as const }
    }),
})
