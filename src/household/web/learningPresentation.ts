import { z } from 'zod'
import { journalDateSchema, journalRecordSchema } from '@/src/journal/contract'
import type { LearningRecordDetail, LearningRecordPage } from '../learningApiContract'

export const learningLabels: Record<LearningRecordDetail['sourceTable'], string> = {
  comfort_states: 'Comfort settings', comfort_feedback: 'Comfort check-in', journal_entries: 'Journal entry',
  comfort_moments: 'Comfort moment', comfort_models: 'Temperature learning model', comfort_reviews: 'Learning review',
  comfort_events: 'Automatic adjustment history', thermal_forecasts: 'Water-temperature forecast',
  target_response_models: 'Bed response model', side_stage_models: 'Sleep-stage model', stage_model_library: 'Saved sleep-stage model',
  stage_classifier_changes: 'Sleep-stage settings change', biometric_profile_revisions: 'Sensor processing profile',
  biometric_profile_bindings: 'Sensor profile assignment',
}
export const learningDate = (value: string) => new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium', timeZone: 'UTC',
}).format(new Date(`${value}T12:00:00Z`))
export function learningRecordLabel(record: LearningRecordPage['records'][number]) {
  return `${learningLabels[record.sourceTable]} · ${record.recordedDate ? learningDate(record.recordedDate) : `record ${record.ordinal}`}`
}
const rowSchema = z.object({ side: z.enum(['left', 'right']), local_date: journalDateSchema })
export interface LearningReading { title: string, note: string | null, facts: { label: string, value: string }[] }

/** Render only known personal fields. Unknown model formats remain exact downloadable source files. */
export function learningReading(detail: LearningRecordDetail): LearningReading {
  const fallback = { title: learningLabels[detail.sourceTable], note: null, facts: [] }
  if (detail.payload === null) return fallback
  try {
    const raw: unknown = JSON.parse(detail.payload)
    if (detail.sourceTable === 'journal_entries') {
      const row = rowSchema.extend({ record: z.string().nullable() }).parse(raw)
      if (row.side !== detail.sourceSide || row.record === null) return fallback
      const journal = journalRecordSchema.parse(JSON.parse(row.record))
      if (journal.side !== row.side || journal.date !== row.local_date) return fallback
      return { title: `Journal · ${learningDate(journal.date)}`, note: journal.fields.notes || null, facts: [
        { label: 'Comfort', value: journal.fields.comfort === 'warm' ? 'Felt warm' : journal.fields.comfort === 'cold' ? 'Felt cold' : 'Comfortable' },
        { label: 'Restfulness', value: `${journal.fields.restfulness} of 5` },
      ] }
    }
    if (detail.sourceTable === 'comfort_feedback') {
      const row = rowSchema.extend({ comfort: z.enum(['warm', 'cold', 'comfortable']) }).parse(raw)
      if (row.side !== detail.sourceSide) return fallback
      return { title: `Comfort · ${learningDate(row.local_date)}`, note: null,
        facts: [{ label: 'Your check-in', value: row.comfort === 'warm' ? 'Felt warm' : row.comfort === 'cold' ? 'Felt cold' : 'Comfortable' }] }
    }
  }
  catch { /* An unrecognized legacy format is available unchanged, never interpreted speculatively. */ }
  return fallback
}
