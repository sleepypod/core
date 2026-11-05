import { z } from 'zod'
import { sideSchema } from '@/src/server/validation-schemas'

export const REFERENCE_ADAPTER_VERSION = 'normalized-reference-v1'
export const REFERENCE_LIMITS = { bytes: 2 * 1024 * 1024, rows: 2000, depth: 12, nodes: 100000, rejectionExamples: 25 } as const
export const referenceMetricSchema = z.enum(['heart_rate', 'breathing_rate', 'window_ibi_variability_v1', 'hrv_rmssd', 'hrv_sdnn', 'hrv_unknown', 'sleep_stages',
  'blood_oxygen', 'resting_heart_rate', 'skin_temperature', 'breathing_disturbances'])
export type ReferenceMetric = z.infer<typeof referenceMetricSchema>

const MILLISECONDS = { ms: 1, s: 1000 }
const PER_MINUTE = { 'beats/min': 1, 'Hz': 60 }
/** Each numeric metric's stored unit, and what a submitted unit multiplies by to reach it. */
export const REFERENCE_UNITS = {
  heart_rate: { unit: 'bpm', accepted: { bpm: 1, ...PER_MINUTE } },
  resting_heart_rate: { unit: 'bpm', accepted: { bpm: 1, ...PER_MINUTE } },
  breathing_rate: { unit: 'breaths/min', accepted: { 'breaths/min': 1, 'br/min': 1, 'Hz': 60 } },
  window_ibi_variability_v1: { unit: 'ms', accepted: MILLISECONDS },
  hrv_rmssd: { unit: 'ms', accepted: MILLISECONDS },
  hrv_sdnn: { unit: 'ms', accepted: MILLISECONDS },
  hrv_unknown: { unit: 'ms', accepted: MILLISECONDS },
  blood_oxygen: { unit: '%', accepted: { '%': 1 } },
  skin_temperature: { unit: 'degC', accepted: { degC: 1 } },
  breathing_disturbances: { unit: 'events/h', accepted: { 'events/h': 1 } },
} as const satisfies Record<Exclude<ReferenceMetric, 'sleep_stages'>, { unit: string, accepted: Record<string, number> }>

/**
 * What a wearable may report through /biometrics/reference-samples, with the
 * bounds a whole batch is refused outside of. Devices differ in which of these
 * they have, so none is required. Clients read this list from
 * getReferenceCapabilities instead of assuming it: a pod on older software
 * rejects a metric or field it does not know.
 */
export const REFERENCE_SAMPLE_METRICS = {
  breathing_rate: { range: [4, 60] },
  hrv_sdnn: { range: [1, 500] },
  hrv_rmssd: { range: [1, 500] },
  blood_oxygen: { range: [50, 100] },
  resting_heart_rate: { range: [20, 250] },
  skin_temperature: { range: [20, 45] },
  breathing_disturbances: { range: [0, 200] },
} as const
export type ReferenceSampleMetric = keyof typeof REFERENCE_SAMPLE_METRICS
export const referenceSampleMetricSchema = z.enum(Object.keys(REFERENCE_SAMPLE_METRICS) as [ReferenceSampleMetric, ...ReferenceSampleMetric[]])
export function referenceCapabilities() {
  return {
    sampleFields: ['endTimestamp', 'device', 'algorithm'],
    metrics: referenceSampleMetricSchema.options.map(metric => ({ metric, unit: REFERENCE_UNITS[metric].unit, min: REFERENCE_SAMPLE_METRICS[metric].range[0], max: REFERENCE_SAMPLE_METRICS[metric].range[1] })),
  }
}
/** Identifies the hardware and the vendor's algorithm: Watch6,1 and Watch8,2 report the same metric differently. */
export const referenceDeviceSchema = z.string().min(1).max(64)
export const referenceAlgorithmSchema = z.string().min(1).max(32)
export const referenceStageSchema = z.enum(['wake', 'light', 'deep', 'rem', 'asleep', 'in_bed', 'unknown'])
export const timestampMsSchema = z.number().int().min(1_000_000_000_000).max(4_102_444_800_000)
export const timePolicySchema = z.object({
  timezone: z.string().min(1).max(100).optional(),
  utcOffsetMinutes: z.number().int().min(-840).max(840).optional(),
  disambiguation: z.enum(['reject', 'earlier', 'later']).default('reject'),
}).strict()

export const referenceRowSchema = z.object({
  recordKey: z.string().min(1).max(200),
  subjectId: z.string().min(1).max(200).optional(),
  metric: referenceMetricSchema,
  value: z.union([z.number().finite(), referenceStageSchema]),
  unit: z.string().min(1).max(40),
  timestampMs: timestampMsSchema.optional(),
  startMs: timestampMsSchema.optional(),
  endMs: timestampMsSchema.optional(),
  // Offset-bearing ISO, or an explicitly resolved local time under timePolicy.
  timestamp: z.string().max(80).optional(),
  start: z.string().max(80).optional(),
  end: z.string().max(80).optional(),
  aggregation: z.enum(['instant', 'mean', 'median', 'window_index', 'stage']).optional(),
  windowMs: z.number().int().min(1).max(24 * 60 * 60 * 1000).optional(),
  quality: z.number().finite().min(0).max(1).optional(),
  annotation: z.string().max(1000).optional(),
  device: referenceDeviceSchema.optional(),
  algorithm: referenceAlgorithmSchema.optional(),
}).strict()
export type ReferenceRow = z.infer<typeof referenceRowSchema>

export const referenceImportSchema = z.object({
  side: sideSchema,
  subjectId: z.string().min(1).max(200),
  source: z.string().min(1).max(120),
  timePolicy: timePolicySchema.default({ disambiguation: 'reject' }),
  rows: z.array(z.unknown()).min(1).max(REFERENCE_LIMITS.rows),
}).strict()
export type ReferenceImportInput = z.input<typeof referenceImportSchema>

export const normalizedMeasurementSchema = z.object({
  recordKey: z.string(),
  metric: referenceMetricSchema,
  value: z.number().nullable(),
  stage: referenceStageSchema.nullable(),
  unit: z.string(),
  startMs: timestampMsSchema,
  endMs: timestampMsSchema,
  temporalKind: z.enum(['point', 'interval']),
  aggregation: z.enum(['instant', 'mean', 'median', 'window_index', 'stage']),
  windowMs: z.number().nullable(),
  quality: z.number().nullable(),
  scorable: z.boolean(),
  exclusions: z.array(z.string()),
  // Retain the submitted units, values, source times and annotations as data.
  original: referenceRowSchema,
}).strict()
export type NormalizedMeasurement = z.infer<typeof normalizedMeasurementSchema>

export const previewSummarySchema = z.object({
  contentHash: z.string(),
  adapterVersion: z.string(),
  side: sideSchema,
  subjectId: z.string(),
  source: z.string(),
  timePolicy: timePolicySchema,
  received: z.number(),
  accepted: z.number(),
  rejected: z.number(),
  duplicates: z.number(),
  unscorable: z.number(),
  conflicts: z.number(),
  startMs: z.number().nullable(),
  endMs: z.number().nullable(),
  metrics: z.array(referenceMetricSchema),
  rejectionCounts: z.record(z.string(), z.number()),
  rejectionExamples: z.array(z.object({ row: z.number(), code: z.string(), message: z.string() })),
  warnings: z.array(z.string()),
})
export type PreviewSummary = z.infer<typeof previewSummarySchema>

export const referenceImportDescriptorSchema = z.object({
  id: z.string().uuid(),
  familyId: z.string().uuid(),
  revision: z.number().int(),
  supersedesImportId: z.string().uuid().nullable(),
  summary: previewSummarySchema,
  createdAtMs: z.number(),
  deletedAtMs: z.number().nullable(),
  available: z.boolean(),
})
