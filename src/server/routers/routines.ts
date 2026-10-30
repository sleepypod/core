import { z } from 'zod'
import { publicProcedure, router } from '@/src/server/trpc'
import { routineChangesSchema, routineSideSchema, routineSnapshotSchema } from '@/src/lib/bedtimeRoutines'
import { getBedtimeRoutines, replaceBedtimeRoutines } from '@/src/server/bedtimeRoutineStore'

const output = z.object({ version: z.literal(1), side: routineSideSchema, canCreate: z.boolean(), routines: z.array(routineSnapshotSchema) })

export const routinesRouter = router({
  get: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/v1/routines', protect: false, tags: ['Schedules'] } })
    .input(z.object({ side: routineSideSchema }).strict())
    .output(output)
    .query(({ input }) => getBedtimeRoutines(input.side)),
  replace: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/routines', protect: false, tags: ['Schedules'] } })
    .input(routineChangesSchema)
    .output(output.extend({ schedulerApplied: z.boolean() }))
    .mutation(({ input }) => replaceBedtimeRoutines(input)),
})
