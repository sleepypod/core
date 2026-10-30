import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { publicProcedure, router } from '../trpc'
import { bedroomConfigSchema, bedroomReportSchema, bedroomSourceSchema, bedroomStatusSchema } from '@/src/bedroom/contract'
import { getBedroom } from '@/src/bedroom/instance'
import { BedroomConfigConflict } from '@/src/bedroom/store'

export const bedroomRouter = router({
  status: publicProcedure.meta({ openapi: { method: 'GET', path: '/v1/home/bedroom', tags: ['Home'] } })
    .input(z.object({}).strict()).output(bedroomStatusSchema).query(() => getBedroom().status()),
  configure: publicProcedure.meta({ openapi: { method: 'PUT', path: '/v1/home/bedroom/configuration', tags: ['Home'] } })
    .input(z.object({ expectedRevision: z.number().int().nonnegative(), config: bedroomConfigSchema }).strict())
    .output(z.object({ revision: z.number().int().positive(), config: bedroomConfigSchema }))
    .mutation(({ input }) => {
      try {
        return getBedroom().configure(input.config, input.expectedRevision)
      }
      catch (error) {
        if (error instanceof BedroomConfigConflict) throw new TRPCError({ code: 'CONFLICT', message: error.message })
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Bedroom configuration could not be saved.' })
      }
    }),
  report: publicProcedure.meta({ openapi: { method: 'POST', path: '/v1/home/bedroom/reports', tags: ['Home'] } })
    .input(z.object({ reports: z.array(bedroomReportSchema).min(1).max(40) }).strict())
    .output(z.object({ results: z.array(z.object({ sourceId: z.string(), accepted: z.boolean(), reason: z.string() })) }))
    .mutation(({ input }) => ({ results: input.reports.map(report => ({ sourceId: report.sourceId, ...getBedroom().receive(report) })) })),
  history: publicProcedure.meta({ openapi: { method: 'GET', path: '/v1/home/bedroom/history', tags: ['Home'] } })
    .input(z.object({ beforeId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional() }).strict())
    .output(z.object({ apiVersion: z.literal(1), generatedAt: z.number(), nextBeforeId: z.number().nullable(),
      items: z.array(z.object({ id: z.number(), revision: z.number(), receivedAt: z.number(), source: bedroomSourceSchema, report: bedroomReportSchema })) }))
    .query(({ input }) => getBedroom().history(input.beforeId)),
})
