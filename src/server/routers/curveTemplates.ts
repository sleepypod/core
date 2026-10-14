import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { desc, eq } from 'drizzle-orm'
import { publicProcedure, router } from '@/src/server/trpc'
import { db } from '@/src/db'
import { curveTemplates } from '@/src/db/schema'
import { dayOfWeekSchema, temperatureSchema, timeStringSchema } from '@/src/server/validation-schemas'
import { CURVE_NOTES_MAX } from '@/src/lib/sleepCurve/savePlan'
import { hasDays, movedDays, normalizeDays, planClaims } from '@/src/lib/scheduleLibrary'
import {
  applyClaimUpdates,
  applySchedulerOps,
  curveDays,
  emptySchedulerOps,
  syncCurveRows,
  toClaim,
} from '@/src/server/scheduleLibrary'

/**
 * The schedule library: named curves (set points in °F) that each run on
 * their own days per side while active. Active curves never share a side and
 * day; activating one moves shared days to it. The rows the scheduler reads
 * are written from here (src/server/scheduleLibrary.ts). The Schedule screen,
 * the AI curve wizard and the MCP server all save curves here.
 */

const nameSchema = z.string().trim().min(1).max(30)

const pointsSchema = z.record(timeStringSchema, temperatureSchema)
  .refine(points => Object.keys(points).length >= 2 && Object.keys(points).length <= 48, 'A saved curve needs 2-48 set points')

const endActionSchema = z.enum(['turn_off', 'maintain'])

const daysSchema = z.object({
  left: z.array(dayOfWeekSchema).max(7).default([]),
  right: z.array(dayOfWeekSchema).max(7).default([]),
}).strict()

const curveTemplateOutput = z.object({
  id: z.number(),
  name: z.string(),
  bedtime: z.string(),
  wake: z.string(),
  points: z.record(z.string(), z.number()),
  notes: z.string(),
  endAction: endActionSchema,
  days: z.object({ left: z.array(dayOfWeekSchema), right: z.array(dayOfWeekSchema) }),
  active: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

const changeOutput = z.object({
  curve: curveTemplateOutput,
  // Days other active curves gave up to this one.
  moved: z.array(z.object({
    name: z.string(),
    side: z.enum(['left', 'right']),
    days: z.array(dayOfWeekSchema),
    deactivated: z.boolean(),
  })),
})

type CurveRow = typeof curveTemplates.$inferSelect

function toOutput(row: CurveRow) {
  const { leftDays, rightDays, ...rest } = row
  return { ...rest, days: curveDays({ leftDays, rightDays }) }
}

function failed(action: string, error: unknown): never {
  if (error instanceof TRPCError) throw error
  if (error instanceof Error && /UNIQUE constraint failed: curve_templates\.name/.test(error.message)) {
    throw new TRPCError({ code: 'CONFLICT', message: 'Another curve already has that name', cause: error })
  }
  throw new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: `Failed to ${action}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    cause: error,
  })
}

export const curveTemplatesRouter = router({
  /** Every curve in the library, most recently saved first. */
  list: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/curve-templates', protect: false, tags: ['Schedules'] } })
    .input(z.object({}).strict())
    .output(z.array(curveTemplateOutput))
    .query(() => {
      try {
        return db.select().from(curveTemplates).orderBy(desc(curveTemplates.updatedAt), desc(curveTemplates.id)).all().map(toOutput)
      }
      catch (error) {
        failed('list saved curves', error)
      }
    }),

  /**
   * Save a curve by name; saving an existing name replaces its set points and
   * keeps its days. An active curve's schedule is rewritten straight away.
   */
  save: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/curve-templates', protect: false, tags: ['Schedules'] } })
    .input(z.object({
      name: nameSchema,
      bedtime: timeStringSchema,
      wake: timeStringSchema,
      points: pointsSchema,
      notes: z.string().max(CURVE_NOTES_MAX).default(''),
      endAction: endActionSchema.optional(),
    }).strict())
    .output(curveTemplateOutput)
    .mutation(async ({ input }) => {
      try {
        const ops = emptySchedulerOps()
        const saved = db.transaction((tx) => {
          const now = new Date()
          const before = tx.select().from(curveTemplates).where(eq(curveTemplates.name, input.name)).get()
          const row = tx.insert(curveTemplates)
            .values({ ...input, createdAt: now, updatedAt: now })
            .onConflictDoUpdate({
              target: curveTemplates.name,
              set: {
                bedtime: input.bedtime,
                wake: input.wake,
                points: input.points,
                notes: input.notes,
                ...(input.endAction ? { endAction: input.endAction } : {}),
                updatedAt: now,
              },
            })
            .returning()
            .get()
          if (before?.active) syncCurveRows(tx, row, { days: curveDays(before), active: true }, ops)
          return row
        })
        await applySchedulerOps(ops)
        return toOutput(saved)
      }
      catch (error) {
        failed('save curve', error)
      }
    }),

  /**
   * Create (no id) or update a curve with its days and active flag in one
   * step. When active, the days it shares with other active curves move to
   * it, and a curve left with no days stops being active. Active needs at
   * least one day; a curve without days is saved inactive.
   */
  put: publicProcedure
    .meta({ openapi: { method: 'PUT', path: '/curve-templates', protect: false, tags: ['Schedules'] } })
    .input(z.object({
      id: z.number().int().positive().optional(),
      name: nameSchema,
      bedtime: timeStringSchema,
      wake: timeStringSchema,
      points: pointsSchema,
      notes: z.string().max(CURVE_NOTES_MAX).default(''),
      endAction: endActionSchema.default('turn_off'),
      days: daysSchema,
      active: z.boolean(),
    }).strict())
    .output(changeOutput)
    .mutation(async ({ input }) => {
      try {
        const ops = emptySchedulerOps()
        const result = db.transaction((tx) => {
          const all = tx.select().from(curveTemplates).all()
          const before = input.id === undefined ? undefined : all.find(c => c.id === input.id)
          if (input.id !== undefined && !before) throw new TRPCError({ code: 'NOT_FOUND', message: `No curve with id ${input.id}` })
          const days = normalizeDays(input.days)
          const active = input.active && hasDays(days)
          const plan = planClaims(all.map(toClaim), before?.id ?? null, days, active)
          const now = new Date()
          const fields = {
            name: input.name,
            bedtime: input.bedtime,
            wake: input.wake,
            points: input.points,
            notes: input.notes,
            endAction: input.endAction,
            leftDays: days.left,
            rightDays: days.right,
            active,
            updatedAt: now,
          }
          const row = before
            ? tx.update(curveTemplates).set(fields).where(eq(curveTemplates.id, before.id)).returning().get()
            : tx.insert(curveTemplates).values({ ...fields, createdAt: now }).returning().get()
          applyClaimUpdates(tx, plan.updates)
          syncCurveRows(tx, row, before ? { days: curveDays(before), active: before.active } : null, ops)
          return { curve: toOutput(row), moved: movedDays(plan.moves) }
        })
        await applySchedulerOps(ops)
        return result
      }
      catch (error) {
        failed('save curve', error)
      }
    }),

  /** Turn a curve on (on its saved days, moving shared days to it) or off (its days stop running). */
  setActive: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/curve-templates/active', protect: false, tags: ['Schedules'] } })
    .input(z.object({ id: z.number().int().positive(), active: z.boolean() }).strict())
    .output(changeOutput)
    .mutation(async ({ input }) => {
      try {
        const ops = emptySchedulerOps()
        const result = db.transaction((tx) => {
          const all = tx.select().from(curveTemplates).all()
          const before = all.find(c => c.id === input.id)
          if (!before) throw new TRPCError({ code: 'NOT_FOUND', message: `No curve with id ${input.id}` })
          const days = curveDays(before)
          if (input.active && !hasDays(days)) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: `Pick days for ${before.name} before turning it on` })
          }
          if (before.active === input.active) return { curve: toOutput(before), moved: [] }
          const plan = planClaims(all.map(toClaim), before.id, days, input.active)
          const row = tx.update(curveTemplates).set({ active: input.active }).where(eq(curveTemplates.id, before.id)).returning().get()
          applyClaimUpdates(tx, plan.updates)
          syncCurveRows(tx, row, { days, active: before.active }, ops)
          return { curve: toOutput(row), moved: movedDays(plan.moves) }
        })
        await applySchedulerOps(ops)
        return result
      }
      catch (error) {
        failed('change curve', error)
      }
    }),

  /** Delete a curve by name. An active curve's days stop running. */
  delete: publicProcedure
    .meta({ openapi: { method: 'DELETE', path: '/curve-templates', protect: false, tags: ['Schedules'] } })
    .input(z.object({ name: nameSchema }).strict())
    .output(z.object({ deleted: z.boolean() }))
    .mutation(async ({ input }) => {
      try {
        const ops = emptySchedulerOps()
        const deleted = db.transaction((tx) => {
          const [row] = tx.delete(curveTemplates).where(eq(curveTemplates.name, input.name)).returning().all()
          if (row?.active) syncCurveRows(tx, { ...row, active: false }, { days: curveDays(row), active: true }, ops)
          return row !== undefined
        })
        await applySchedulerOps(ops)
        return { deleted }
      }
      catch (error) {
        failed('delete curve', error)
      }
    }),
})
