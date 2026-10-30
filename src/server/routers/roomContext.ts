import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { publicProcedure, router } from '../trpc'
import { configVersionSchema, historyItemSchema, roomConfigSchema, roomStatusSchema } from '@/src/home-context/contract'
import { getRoomContext } from '@/src/home-context/instance'
import { RoomConfigConflict } from '@/src/home-context/store'
import { homeAssistantAutomations } from '@/src/home-context/homeAssistant'

export const roomContextRouter = router({
  status: publicProcedure.meta({ openapi: { method: 'GET', path: '/v1/home/context', tags: ['Home'] } })
    .input(z.object({}).strict()).output(roomStatusSchema).query(() => getRoomContext().status()),
  configure: publicProcedure.meta({ openapi: { method: 'PUT', path: '/v1/home/context/configuration', tags: ['Home'] } })
    .input(z.object({ expectedRevision: z.number().int().nonnegative(), config: roomConfigSchema }).strict()).output(configVersionSchema)
    .mutation(({ input }) => {
      try {
        return getRoomContext().configure(input.config, input.expectedRevision)
      }
      catch (error) {
        if (error instanceof RoomConfigConflict) throw new TRPCError({ code: 'CONFLICT', message: error.message })
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Room configuration could not be saved' })
      }
    }),
  history: publicProcedure.meta({ openapi: { method: 'GET', path: '/v1/home/context/history', tags: ['Home'] } })
    .input(z.object({ beforeId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional() }).strict())
    .output(z.object({ apiVersion: z.literal(1), generatedAt: z.number(), items: z.array(historyItemSchema), nextBeforeId: z.number().nullable() }))
    .query(({ input }) => getRoomContext().history(input.beforeId)),
  publisher: publicProcedure.meta({ openapi: { method: 'GET', path: '/v1/home/context/publisher', tags: ['Home'] } })
    .input(z.object({}).strict()).output(z.object({ revision: z.number(), automations: z.array(z.string()) }))
    .query(() => {
      const state = getRoomContext().status()
      if (!state.connected || !state.topic) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Connect the MQTT broker first' })
      return { revision: state.revision, automations: homeAssistantAutomations(state, state.topic).map(item => JSON.stringify(item, null, 2)) }
    }),
})
