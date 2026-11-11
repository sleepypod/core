import { z } from 'zod'

const finite = z.number().finite()
export const responseInstantSchema = z.number().int().positive().max(8_640_000_000_000_000)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => Number.isFinite(Date.parse(value))
  && new Date(value).toISOString().slice(0, 10) === value, 'Invalid calendar date')
export const FEATURE_COUNT = 6
export const RESPONSE_MODEL_MINIMUM_NIGHTS = 20
const vector = z.array(finite).length(FEATURE_COUNT)

export const responseInputSchema = z.object({
  observedAt: responseInstantSchema, previousTargetF: finite.min(55).max(110), requestedTargetF: finite.min(55).max(110),
  waterBeforeF: finite.min(40).max(120), waterChange5mF: finite.min(-10).max(10),
  roomF: finite.min(40).max(100), humidity: finite.min(0).max(100),
}).strict().refine(input => Math.abs(input.requestedTargetF - input.previousTargetF) === 1,
  'Only a one-degree target step is supported.')
export type ResponseInput = z.infer<typeof responseInputSchema>

const horizonSchema = z.object({
  minutes: z.union([z.literal(15), z.literal(30)]), coefficients: vector,
  simpleCoefficient: finite.min(0).max(1), errorBandF: finite.min(0.25),
  validation: z.object({
    modelMaeF: finite.nonnegative(), persistenceMaeF: finite.nonnegative(), simpleMaeF: finite.nonnegative(),
    trendMaeF: finite.nonnegative(), intervalCoverage: finite.min(0).max(1), supportedFraction: finite.min(0).max(1),
    passes: z.boolean(),
  }).strict(),
}).strict()
export const responseModelShape = z.object({
  version: z.literal('target-response-ridge-v1'), purpose: z.literal('observed-water-response'),
  mode: z.literal('research_preview'), attribution: z.literal('physical_zone_only'),
  side: z.enum(['left', 'right']), createdAt: responseInstantSchema, sourceLastAt: responseInstantSchema,
  datasetHash: digest, configuration: digest,
  trainingDates: z.array(date).min(10).max(46), calibrationDates: z.array(date).min(5).max(23),
  validationDates: z.array(date).min(5).max(23),
  support: z.array(z.object({ date, previousTargetF: finite.min(55).max(110), step: z.union([z.literal(-1), z.literal(1)]), values: vector }).strict()).min(10).max(2944),
  horizons: z.array(horizonSchema).length(2),
}).strict()
export const responseModelSchema = responseModelShape
  .refine(model => model.horizons[0].minutes === 15 && model.horizons[1].minutes === 30, 'Both horizons are required in order.')
  .refine(model => model.sourceLastAt < model.createdAt, 'All outcomes must precede fitting.')
  .refine((model) => {
    const dates = [...model.trainingDates, ...model.calibrationDates, ...model.validationDates]
    return dates.every((value, index) => index === 0 || value > dates[index - 1])
      && model.support.every(sample => model.trainingDates.includes(sample.date))
      && new Set(model.support.map(sample => sample.date)).size === model.trainingDates.length
  }, 'Disjoint chronological night splits and training-only support are required.')
export type ResponseModel = z.infer<typeof responseModelSchema>
