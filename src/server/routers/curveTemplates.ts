import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { desc, eq } from 'drizzle-orm'
import { publicProcedure, router } from '@/src/server/trpc'
import { db } from '@/src/db'
import { curveTemplates } from '@/src/db/schema'
import { temperatureSchema, timeStringSchema } from '@/src/server/validation-schemas'

/**
 * Saved curves: named set point lists (°F) that are not tied to a side or a
 * day. The AI curve wizard and the MCP server save them here; applying one
 * goes through the schedule editor or apply_sleep_curve like any other curve.
 */

const nameSchema = z.string().trim().min(1).max(30)

const pointsSchema = z.record(timeStringSchema, temperatureSchema)
  .refine(points => Object.keys(points).length >= 2 && Object.keys(points).length <= 48, 'A saved curve needs 2-48 set points')

const curveTemplateOutput = z.object({
  id: z.number(),
  name: z.string(),
  bedtime: z.string(),
  wake: z.string(),
  points: z.record(z.string(), z.number()),
  reasoning: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

function failed(action: string, error: unknown): never {
  if (error instanceof TRPCError) throw error
  throw new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: `Failed to ${action}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    cause: error,
  })
}

export const curveTemplatesRouter = router({
  /** Every saved curve, most recently saved first. */
  list: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/curve-templates', protect: false, tags: ['Schedules'] } })
    .input(z.object({}).strict())
    .output(z.array(curveTemplateOutput))
    .query(() => {
      try {
        return db.select().from(curveTemplates).orderBy(desc(curveTemplates.updatedAt), desc(curveTemplates.id)).all()
      }
      catch (error) {
        failed('list saved curves', error)
      }
    }),

  /** Save a curve by name; saving an existing name replaces it. */
  save: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/curve-templates', protect: false, tags: ['Schedules'] } })
    .input(z.object({
      name: nameSchema,
      bedtime: timeStringSchema,
      wake: timeStringSchema,
      points: pointsSchema,
      reasoning: z.string().max(2000).default(''),
    }).strict())
    .output(curveTemplateOutput)
    .mutation(({ input }) => {
      try {
        const now = new Date()
        return db.insert(curveTemplates)
          .values({ ...input, createdAt: now, updatedAt: now })
          .onConflictDoUpdate({
            target: curveTemplates.name,
            set: { bedtime: input.bedtime, wake: input.wake, points: input.points, reasoning: input.reasoning, updatedAt: now },
          })
          .returning()
          .get()
      }
      catch (error) {
        failed('save curve', error)
      }
    }),

  /** Delete a saved curve by name. Schedules already written from it are untouched. */
  delete: publicProcedure
    .meta({ openapi: { method: 'DELETE', path: '/curve-templates', protect: false, tags: ['Schedules'] } })
    .input(z.object({ name: nameSchema }).strict())
    .output(z.object({ deleted: z.boolean() }))
    .mutation(({ input }) => {
      try {
        const rows = db.delete(curveTemplates).where(eq(curveTemplates.name, input.name)).returning().all()
        return { deleted: rows.length > 0 }
      }
      catch (error) {
        failed('delete curve', error)
      }
    }),
})
