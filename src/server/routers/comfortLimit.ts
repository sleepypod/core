import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { publicProcedure, router } from '../trpc'
import { comfortLimitPageSchema, comfortLimitWriteSchema } from '@/src/temperature/limits'
import { readComfortLimit, saveComfortLimit } from '@/src/temperature/limitInstance'
import { ComfortLimitConflict } from '@/src/temperature/limitStore'
import { withSideLock } from '@/src/hardware/sideLock'

export const comfortLimitRouter = router({
  get: publicProcedure.meta({ openapi: { method: 'GET', path: '/v1/temperature/comfort-limit', tags: ['Temperature'] } })
    .input(z.object({ side: z.enum(['left', 'right']) }).strict()).output(comfortLimitPageSchema)
    .query(({ input }) => readComfortLimit(input.side)),
  configure: publicProcedure.meta({ openapi: { method: 'PUT', path: '/v1/temperature/comfort-limit', tags: ['Temperature'] } })
    .input(comfortLimitWriteSchema).output(comfortLimitPageSchema)
    .mutation(({ input }) => withSideLock(input.side, async () => {
      try {
        return saveComfortLimit(input.side, input.expectedSourceSide, input.expectedRevision, input.config)
      }
      catch (error) {
        if (error instanceof ComfortLimitConflict) throw new TRPCError({ code: 'CONFLICT', message: error.message })
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'The comfort limit could not be confirmed. Refresh before trying again.' })
      }
    })),
})
