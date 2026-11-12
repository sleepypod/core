import { predictiveRecordingFixture } from './predictiveRecordingFixture'
import { previewReportId } from '../report-evidence'
import type { PredictiveOutcomeReview } from '../predictive-outcome-window'
import type { ResponseApplication, ResponseSample } from '../response-window'
import type { ThermalDatasetAudit } from '../thermal-dataset'

/** Synthetic complete night; no personal observations or real review confirmations. */
export function predictiveOutcomeFixture(at = 1_800_000_000_000) {
  const { record } = predictiveRecordingFixture(at), start = record.source.start
  const date = new Date(record.source.end).toISOString().slice(0, 10)
  const water = (observed: number) => 73 + Math.max(0, Math.min(1, (observed - at) / 1_800_000))
  const review: PredictiveOutcomeReview = {
    proof: { date, reportId: previewReportId(record.source), digest: 'd'.repeat(64), reviewId: 1, configuration: record.request.configuration },
    recording: { date, samples: Array.from({ length: 109 }, (_, index) => ({ at: start + index * 300_000,
      context: { targetF: 70, waterF: water(start + index * 300_000), roomF: 72, humidity: 50 } })) },
  }
  const samples: ResponseSample[] = Array.from({ length: 67 }, (_, index) => ({ at: at - 90_000 + index * 30_000,
    powered: true, targetF: 70, waterF: water(at - 90_000 + index * 30_000) }))
  const applications: ResponseApplication[] = []
  const audit: ThermalDatasetAudit = { nights: [], recordings: [review.recording], proofs: [review.proof],
    collection: { feedbackNights: 1, excluded: [], policy: 'complete-reviewed-nights-v1' } }
  return { record, review, samples, applications, audit, now: record.source.end + 3_600_000 }
}
