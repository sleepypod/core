import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { controlReceiptSchema, controlRequestSchema } from '@/src/controls/contract'
import { getControlService } from '@/src/controls/instance'
import { ControlConflictError } from '@/src/controls/store'
import { publicProcedure, router } from '../trpc'

export const controlsRouter = router({
  submit: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/controls', tags: ['Device'] } })
    .input(controlRequestSchema).output(controlReceiptSchema)
    .mutation(async ({ input }) => {
      try {
        return await getControlService().submit(input)
      }
      catch (error) {
        if (error instanceof ControlConflictError) throw new TRPCError({ code: 'CONFLICT', message: error.message })
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Control receipt unavailable; query the existing request ID before any further action' })
      }
    }),
  get: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/v1/controls/{requestId}', tags: ['Device'] } })
    .input(z.object({ requestId: z.uuid() }).strict()).output(controlReceiptSchema)
    .query(({ input }) => {
      const receipt = getControlService().get(input.requestId)
      if (!receipt) throw new TRPCError({ code: 'NOT_FOUND', message: 'Control receipt not found' })
      return receipt
    }),
})
