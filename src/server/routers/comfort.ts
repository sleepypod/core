import { previewReportDetailSchema, previewReportListSchema, previewReviewInputSchema, previewReviewSchema, reportIdSchema } from '@/src/comfort/report-contract'
import { PreviewReportError } from '@/src/comfort/report-summary'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { comfortConfigSchema, comfortFeedbackSchema, comfortStatusSchema } from '@/src/comfort/contract'
import { getComfortOwner, getComfortRuntime, getPreviewReports, getThermalModels, previewThermalModel, getThermalForecasts, previewWaterForecast } from '@/src/comfort/instance'
import { forecastStatusSchema } from '@/src/comfort/thermal-forecast-store'
import { thermalForecastPredictionSchema } from '@/src/comfort/thermal-forecast'
import { thermalModelStatusSchema } from '@/src/comfort/thermal-model-store'
import { thermalPredictionSchema } from '@/src/comfort/thermal-model'
import { ownerConfirmSchema, ownerPrepareSchema, ownerReviewSchema, ownerStatusSchema, qualificationKindSchema } from '@/src/comfort/owner-contract'
import { ComfortInputError } from '@/src/comfort/runtime'
import { publicProcedure, router } from '../trpc'

const sideSchema = z.enum(['left', 'right'])
async function reportResult<Result>(work: () => Promise<Result>): Promise<Result> {
  try {
    return await work()
  }
  catch (error) {
    if (error instanceof PreviewReportError) throw new TRPCError({ code: error.code, message: error.message })
    throw error
  }
}

export const comfortRouter = router({
  waterForecast: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/v1/comfort/forecast', tags: ['Autopilot'] } })
    .input(z.object({ side: sideSchema }).strict()).output(forecastStatusSchema)
    .query(({ input }) => getThermalForecasts().status(input.side)),
  waterForecastPreview: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/v1/comfort/forecast/preview', tags: ['Autopilot'] } })
    .input(z.object({ side: sideSchema }).strict()).output(thermalForecastPredictionSchema)
    .query(({ input }) => previewWaterForecast(input.side)),
  trainWaterForecast: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/comfort/forecast/train', tags: ['Autopilot'] } })
    .input(z.object({ side: sideSchema, expectedDatasetHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).output(forecastStatusSchema)
    .mutation(({ input }) => reportResult(async () => getThermalForecasts().train(input.side, input.expectedDatasetHash))),
  thermalModelPreview: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/v1/comfort/model/preview', tags: ['Autopilot'] } })
    .input(z.object({ side: sideSchema }).strict()).output(thermalPredictionSchema)
    .query(({ input }) => previewThermalModel(input.side)),
  thermalModel: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/v1/comfort/model', tags: ['Autopilot'] } })
    .input(z.object({ side: sideSchema }).strict()).output(thermalModelStatusSchema)
    .query(({ input }) => getThermalModels().status(input.side)),
  trainThermalModel: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/comfort/model/train', tags: ['Autopilot'] } })
    .input(z.object({ side: sideSchema, expectedDatasetHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict())
    .output(thermalModelStatusSchema)
    .mutation(({ input }) => reportResult(async () => getThermalModels().train(input.side, input.expectedDatasetHash))),
  owner: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/v1/comfort/owner', tags: ['Autopilot'] } })
    .input(z.object({ side: sideSchema }).strict()).output(ownerStatusSchema)
    .query(({ input }) => reportResult(() => getComfortOwner().status(input.side))),
  prepareOwnerReview: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/comfort/owner/prepare', tags: ['Autopilot'] } })
    .input(ownerPrepareSchema).output(ownerReviewSchema)
    .mutation(({ input }) => reportResult(() => getComfortOwner().prepare(input))),
  confirmOwnerReview: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/comfort/owner/confirm', tags: ['Autopilot'] } })
    .input(ownerConfirmSchema).output(z.object({ saved: z.literal(true) }))
    .mutation(({ input }) => reportResult(() => getComfortOwner().confirm(input))),
  retestQualification: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/comfort/owner/retest', tags: ['Autopilot'] } })
    .input(z.object({ side: sideSchema, kind: qualificationKindSchema, expectedId: z.string().uuid() }).strict())
    .output(z.object({ saved: z.literal(true) }))
    .mutation(({ input }) => reportResult(() => getComfortOwner().retest(input.side, input.kind, input.expectedId))),
  reports: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/v1/comfort/reports', tags: ['Autopilot'] } })
    .input(z.object({ side: sideSchema }).strict())
    .output(previewReportListSchema)
    .query(({ input }) => reportResult(() => getPreviewReports().list(input.side))),
  report: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/v1/comfort/report', tags: ['Autopilot'] } })
    .input(z.object({ side: sideSchema, id: reportIdSchema, afterId: z.number().int().positive().optional() }).strict())
    .output(previewReportDetailSchema)
    .query(({ input }) => reportResult(() => getPreviewReports().detail(input.side, input.id, input.afterId))),
  reviewReport: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/comfort/report/review', tags: ['Autopilot'] } })
    .input(previewReviewInputSchema)
    .output(previewReviewSchema)
    .mutation(({ input }) => reportResult(() => getPreviewReports().review(input))),
  get: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/v1/comfort', tags: ['Autopilot'] } })
    .input(z.object({ side: sideSchema }).strict())
    .output(comfortStatusSchema)
    .query(({ input }) => getComfortRuntime().status(input.side)),
  configure: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/comfort/configure', tags: ['Autopilot'] } })
    .input(z.object({ side: sideSchema, config: comfortConfigSchema }).strict())
    .output(comfortStatusSchema)
    .mutation(async ({ input }) => {
      if (input.config.mode === 'active') {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Active requires a separate owner activation review with current qualification and seven reviewed Preview nights.' })
      }
      if (input.config.followBedtime && !input.config.sensorAware) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Bed-entry timing requires the Pod sensor guard.' })
      }
      return getComfortRuntime().configure(input.side, input.config)
    }),
  mode: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/comfort/mode', tags: ['Autopilot'] } })
    .input(z.object({ side: sideSchema, mode: comfortConfigSchema.shape.mode }).strict())
    .output(comfortStatusSchema)
    .mutation(({ input }) => {
      if (input.mode === 'active') throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Active comfort still requires hardware qualification and reviewed Preview nights.' })
      return getComfortRuntime().setMode(input.side, input.mode)
    }),
  feedback: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/comfort/feedback', tags: ['Autopilot'] } })
    .input(z.object({ side: sideSchema, feedback: comfortFeedbackSchema }).strict())
    .output(comfortStatusSchema)
    .mutation(async ({ input }) => {
      try {
        return await getComfortRuntime().feedback(input.side, input.feedback)
      }
      catch (error) {
        if (error instanceof ComfortInputError) throw new TRPCError({ code: 'BAD_REQUEST', message: error.message })
        throw error
      }
    }),
})
