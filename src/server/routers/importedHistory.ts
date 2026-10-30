import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { publicProcedure, router } from '../trpc'
import { historyDetailInputSchema, historyDetailSchema, historyPageInputSchema, historyPageSchema, historyStatusSchema } from '@/src/history/contract'
import { HistoryError, importedHistoryReader } from '@/src/history/read'

function historyResult<Result>(read: () => Result): Result {
  try {
    return read()
  }
  catch (error) {
    if (!(error instanceof HistoryError)) throw error
    const code = error.reason === 'changed'
      ? 'CONFLICT'
      : error.reason === 'invalid_cursor'
        ? 'BAD_REQUEST'
        : error.reason === 'not_found' ? 'NOT_FOUND' : 'PRECONDITION_FAILED'
    throw new TRPCError({ code, message: error.message })
  }
}

export const importedHistoryRouter = router({
  status: publicProcedure.meta({ openapi: { method: 'GET', path: '/v1/history', tags: ['History'] } })
    .input(z.object({}).strict()).output(historyStatusSchema).query(() => importedHistoryReader().status()),
  records: publicProcedure.meta({ openapi: { method: 'GET', path: '/v1/history/records', tags: ['History'] } })
    .input(historyPageInputSchema).output(historyPageSchema)
    .query(({ input }) => historyResult(() => importedHistoryReader().page(input))),
  presence: publicProcedure.meta({ openapi: { method: 'GET', path: '/v1/history/presence', tags: ['History'] } })
    .input(historyDetailInputSchema).output(historyDetailSchema)
    .query(({ input }) => historyResult(() => importedHistoryReader().detail(input))),
})
