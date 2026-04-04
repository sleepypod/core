import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { publicProcedure, router } from '@/src/server/trpc'
import { db } from '@/src/db'
import {
  scheduleGroups,
  temperatureSchedules,
  powerSchedules,
  alarmSchedules,
} from '@/src/db/schema'
import { eq, and } from 'drizzle-orm'
import {
  sideSchema,
  dayOfWeekSchema,
  idSchema,
} from '@/src/server/validation-schemas'
import { getJobManager } from '@/src/scheduler'

async function reloadScheduler(): Promise<void> {
  const jobManager = await getJobManager()
  await jobManager.reloadSchedules()
}

function findConflictingGroup(
  side: 'left' | 'right',
  days: string[],
  excludeGroupId?: number,
): { groupName: string, conflictingDays: string[] } | null {
  const groups = db.select().from(scheduleGroups).where(eq(scheduleGroups.side, side)).all()
  for (const group of groups) {
    if (excludeGroupId && group.id === excludeGroupId) continue
    const groupDays: string[] = JSON.parse(group.days)
    const overlap = days.filter(d => groupDays.includes(d))
    if (overlap.length > 0) {
      return { groupName: group.name, conflictingDays: overlap }
    }
  }
  return null
}

export const scheduleGroupsRouter = router({
  getAll: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/schedule-groups', protect: false, tags: ['Schedule Groups'] } })
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
        const groups = db
          .select()
          .from(scheduleGroups)
          .where(eq(scheduleGroups.side, input.side))
          .all()

        return groups.map(g => ({
          ...g,
          days: JSON.parse(g.days) as string[],
        }))
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to fetch schedule groups: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  create: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/schedule-groups', protect: false, tags: ['Schedule Groups'] } })
    .input(
      z
        .object({
          side: sideSchema,
          name: z.string().min(1).max(50),
          days: z.array(dayOfWeekSchema).min(1).max(7),
        })
        .strict()
    )
    .output(z.any())
    .mutation(async ({ input }) => {
      try {
        const conflict = findConflictingGroup(input.side, input.days)
        if (conflict) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: `Day(s) ${conflict.conflictingDays.join(', ')} already belong to group '${conflict.groupName}'`,
          })
        }

        const created = db.transaction((tx) => {
          const [result] = tx
            .insert(scheduleGroups)
            .values({
              side: input.side,
              name: input.name,
              days: JSON.stringify(input.days),
            })
            .returning()
            .all()
          if (!result) {
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: 'Failed to create schedule group - no record returned',
            })
          }

          return result
        })

        return {
          ...created,
          days: JSON.parse(created.days) as string[],
        }
      }
      catch (error) {
        if (error instanceof TRPCError) throw error

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to create schedule group: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  update: publicProcedure
    .meta({ openapi: { method: 'PATCH', path: '/schedule-groups', protect: false, tags: ['Schedule Groups'] } })
    .input(
      z
        .object({
          id: idSchema,
          name: z.string().min(1).max(50).optional(),
          days: z.array(dayOfWeekSchema).min(1).max(7).optional(),
        })
        .strict()
    )
    .output(z.any())
    .mutation(async ({ input }) => {
      try {
        // Fetch existing group first
        const [existing] = db
          .select()
          .from(scheduleGroups)
          .where(eq(scheduleGroups.id, input.id))
          .all()
        if (!existing) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: `Schedule group with ID ${input.id} not found`,
          })
        }

        if (input.days) {
          const conflict = findConflictingGroup(existing.side, input.days, input.id)
          if (conflict) {
            throw new TRPCError({
              code: 'CONFLICT',
              message: `Day(s) ${conflict.conflictingDays.join(', ')} already belong to group '${conflict.groupName}'`,
            })
          }
        }

        const updated = db.transaction((tx) => {
          const updates: Record<string, unknown> = { updatedAt: new Date() }
          if (input.name !== undefined) updates.name = input.name
          if (input.days !== undefined) updates.days = JSON.stringify(input.days)

          const [result] = tx
            .update(scheduleGroups)
            .set(updates)
            .where(eq(scheduleGroups.id, input.id))
            .returning()
            .all()
          if (!result) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: `Schedule group with ID ${input.id} not found`,
            })
          }

          // Day sync: copy schedules from an existing day to newly added days
          if (input.days) {
            const oldDays: string[] = JSON.parse(existing.days)
            const newDays = input.days
            const addedDays = newDays.filter(d => !oldDays.includes(d))

            if (addedDays.length > 0) {
              // Pick a source day from the days that were already in the group
              const sourceDays = newDays.filter(d => oldDays.includes(d))
              if (sourceDays.length > 0) {
                const sourceDay = sourceDays[0]

                // Copy temperature schedules
                const sourceTemps = tx
                  .select()
                  .from(temperatureSchedules)
                  .where(
                    and(
                      eq(temperatureSchedules.side, existing.side),
                      eq(temperatureSchedules.dayOfWeek, sourceDay),
                    ),
                  )
                  .all()

                // Copy power schedules
                const sourcePower = tx
                  .select()
                  .from(powerSchedules)
                  .where(
                    and(
                      eq(powerSchedules.side, existing.side),
                      eq(powerSchedules.dayOfWeek, sourceDay),
                    ),
                  )
                  .all()

                // Copy alarm schedules
                const sourceAlarms = tx
                  .select()
                  .from(alarmSchedules)
                  .where(
                    and(
                      eq(alarmSchedules.side, existing.side),
                      eq(alarmSchedules.dayOfWeek, sourceDay),
                    ),
                  )
                  .all()

                for (const addedDay of addedDays) {
                  // Delete existing schedules for the target day first
                  tx.delete(temperatureSchedules)
                    .where(
                      and(
                        eq(temperatureSchedules.side, existing.side),
                        eq(temperatureSchedules.dayOfWeek, addedDay),
                      ),
                    )
                    .run()
                  tx.delete(powerSchedules)
                    .where(
                      and(
                        eq(powerSchedules.side, existing.side),
                        eq(powerSchedules.dayOfWeek, addedDay),
                      ),
                    )
                    .run()
                  tx.delete(alarmSchedules)
                    .where(
                      and(
                        eq(alarmSchedules.side, existing.side),
                        eq(alarmSchedules.dayOfWeek, addedDay),
                      ),
                    )
                    .run()

                  // Create copies
                  for (const t of sourceTemps) {
                    tx.insert(temperatureSchedules).values({
                      side: t.side,
                      dayOfWeek: addedDay,
                      time: t.time,
                      temperature: t.temperature,
                      enabled: t.enabled,
                    }).run()
                  }
                  for (const p of sourcePower) {
                    tx.insert(powerSchedules).values({
                      side: p.side,
                      dayOfWeek: addedDay,
                      onTime: p.onTime,
                      offTime: p.offTime,
                      onTemperature: p.onTemperature,
                      enabled: p.enabled,
                    }).run()
                  }
                  for (const a of sourceAlarms) {
                    tx.insert(alarmSchedules).values({
                      side: a.side,
                      dayOfWeek: addedDay,
                      time: a.time,
                      vibrationIntensity: a.vibrationIntensity,
                      vibrationPattern: a.vibrationPattern,
                      duration: a.duration,
                      alarmTemperature: a.alarmTemperature,
                      enabled: a.enabled,
                    }).run()
                  }
                }
              }
            }
          }

          return result
        })

        // Reload scheduler if days changed (schedules were synced)
        if (input.days) {
          try {
            await reloadScheduler()
          }
          catch (e) {
            console.error('Scheduler reload failed:', e)
          }
        }

        return {
          ...updated,
          days: JSON.parse(updated.days) as string[],
        }
      }
      catch (error) {
        if (error instanceof TRPCError) throw error

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to update schedule group: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  delete: publicProcedure
    .meta({ openapi: { method: 'DELETE', path: '/schedule-groups', protect: false, tags: ['Schedule Groups'] } })
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
            .delete(scheduleGroups)
            .where(eq(scheduleGroups.id, input.id))
            .returning()
            .all()
          if (!deleted) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: `Schedule group with ID ${input.id} not found`,
            })
          }
        })

        return { success: true }
      }
      catch (error) {
        if (error instanceof TRPCError) throw error

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to delete schedule group: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  getByDay: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/schedule-groups/by-day', protect: false, tags: ['Schedule Groups'] } })
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
        const groups = db
          .select()
          .from(scheduleGroups)
          .where(eq(scheduleGroups.side, input.side))
          .all()

        for (const group of groups) {
          const groupDays: string[] = JSON.parse(group.days)
          if (groupDays.includes(input.dayOfWeek)) {
            return {
              ...group,
              days: groupDays,
            }
          }
        }

        return null
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to fetch schedule group by day: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),
})
