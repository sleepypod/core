import { TRPCError } from '@trpc/server'
import { JournalError, journalPageSchema, journalReadSchema, journalSelectionSchema, journalWriteSchema } from '@/src/journal/contract'
import { journalService } from '@/src/journal/instance'
import { publicProcedure, router } from '../trpc'

async function journalResult<Result>(work: () => Result | Promise<Result>): Promise<Result> {
  try {
    return await work()
  }
  catch (error) {
    if (error instanceof JournalError) throw new TRPCError({ code: error.code, message: error.message })
    // Database errors can contain serialized private notes. Never forward them to logs or clients.
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'The journal could not be read or saved. Your draft has not been discarded.' })
  }
}

export const journalRouter = router({
  get: publicProcedure.meta({ openapi: { method: 'GET', path: '/v1/journal', tags: ['Journal'] } })
    .input(journalReadSchema).output(journalPageSchema)
    .query(({ input }) => journalResult(() => journalService().read(input))),
  save: publicProcedure.meta({ openapi: { method: 'POST', path: '/v1/journal', tags: ['Journal'] } })
    .input(journalWriteSchema).output(journalSelectionSchema)
    .mutation(({ input }) => journalResult(() => journalService().write(input))),
})
