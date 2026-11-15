import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { biometricProcessingRuns as runs, vitals } from '@/src/db/biometrics-schema'

// The same-side join is required by callers. A saved config hash alone does not
// identify an engine version, so configuration identity also includes its manifest.
const live = sql`(${runs.kind} = 'live' AND length(${runs.configHash}) = 64 AND ${runs.configHash} NOT GLOB '*[^a-f0-9]*')`
const manifest = sql`CASE WHEN json_valid(${runs.bundle}) THEN json_extract(${runs.bundle}, '$.manifestHash') END`
const rawMetric = sql`CASE WHEN json_valid(${runs.bundle}) THEN json_extract(${runs.bundle}, '$.components.hrv_index.metricId') END`
const metric = sql`CASE WHEN ${live} AND typeof(${rawMetric}) = 'text' AND length(${rawMetric}) BETWEEN 1 AND 80 AND ${rawMetric} NOT GLOB '*[^a-z0-9_]*' THEN ${rawMetric} END`
const configuration = sql`CASE WHEN ${live} AND typeof(${manifest}) = 'text' AND length(${manifest}) = 64 AND ${manifest} NOT GLOB '*[^a-f0-9]*' THEN ${manifest} || ':' || ${runs.configHash} END`
export const summaryProvenanceFields = {
  configurationCount: sql<number>`COUNT(DISTINCT ${configuration})`,
  unknownConfigurationRows: sql<number>`COUNT(CASE WHEN ${configuration} IS NULL THEN 1 END)`,
  hrvRows: sql<number>`COUNT(${vitals.hrv})`,
  hrvDefinitionCount: sql<number>`COUNT(DISTINCT CASE WHEN ${vitals.hrv} IS NOT NULL THEN ${metric} END)`,
  unknownHrvRows: sql<number>`COUNT(CASE WHEN ${vitals.hrv} IS NOT NULL AND ${metric} IS NULL THEN 1 END)`,
  singleHrvMetricId: sql<string | null>`MIN(CASE WHEN ${vitals.hrv} IS NOT NULL THEN ${metric} END)`,
}
export const summaryProvenanceSchema = z.object({
  interpretation: z.literal('original_observations'),
  configurationCount: z.number().int().nonnegative(),
  unknownConfigurationRows: z.number().int().nonnegative(),
  hrvRows: z.number().int().nonnegative(),
  hrvDefinitionCount: z.number().int().nonnegative(),
  unknownHrvRows: z.number().int().nonnegative(),
  hrvMetricId: z.string().nullable(),
  hrvAggregation: z.enum(['single_definition', 'legacy_unverified', 'incompatible_definitions', 'no_readings']),
})
export function summarizeVitalProvenance(row: {
  configurationCount?: number
  unknownConfigurationRows?: number
  hrvRows?: number
  hrvDefinitionCount?: number
  unknownHrvRows?: number
  singleHrvMetricId?: string | null
}) {
  // Compatibility with adapters that have not supplied these new aggregate fields.
  if ([row.configurationCount, row.unknownConfigurationRows, row.hrvRows, row.hrvDefinitionCount, row.unknownHrvRows].some(value => value === undefined)) return undefined
  const incompatible = (row.hrvDefinitionCount ?? 0) > 1 || ((row.hrvDefinitionCount ?? 0) > 0 && (row.unknownHrvRows ?? 0) > 0)
  return summaryProvenanceSchema.parse({
    interpretation: 'original_observations', configurationCount: row.configurationCount,
    unknownConfigurationRows: row.unknownConfigurationRows, hrvRows: row.hrvRows,
    hrvDefinitionCount: row.hrvDefinitionCount, unknownHrvRows: row.unknownHrvRows,
    hrvMetricId: row.hrvDefinitionCount === 1 && row.unknownHrvRows === 0 ? row.singleHrvMetricId : null,
    hrvAggregation: row.hrvRows === 0 ? 'no_readings' : incompatible ? 'incompatible_definitions' : row.hrvDefinitionCount === 0 ? 'legacy_unverified' : 'single_definition',
  })
}
/** `<manifestHash>:<configHash>` of the live same-side run that produced a vitals row, or NULL when unrecorded. */
export const vitalsConfiguration = configuration
