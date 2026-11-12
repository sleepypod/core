import type { PredictiveRecording } from './predictive-recording-contract'
import { predictiveRecordingSchema } from './predictive-recording-contract'
import { previewReportId } from './report-evidence'
import { thermalContextSchema } from './thermal-learning'
import type { ThermalDatasetAudit, ThermalRecording } from './thermal-dataset'
import { temperatureApplicationSchema } from '@/src/temperature/applications'
import { responseSampleSchema, type ResponseApplication, type ResponseSample } from './response-window'
import type { PredictiveOutcomeReason } from './predictive-outcome-contract'

export interface PredictiveOutcomeReview {
  proof: ThermalDatasetAudit['proofs'][number]
  recording: ThermalRecording
}
export interface PredictiveOutcomeScore {
  date: string
  horizons: Array<{ minutes: 15 | 30, at: number, actualWaterF: number, errorF: number, persistenceErrorF: number, insideRange: boolean }>
}
type Outcome = { state: 'pending' } | { state: 'withheld', reason: PredictiveOutcomeReason } | { state: 'scored', score: PredictiveOutcomeScore }

/** Score only actual holding after a frozen forecast; never substitute a hypothetical target's outcome. */
export function assessPredictiveOutcome(record: PredictiveRecording, review: PredictiveOutcomeReview | null,
  samples: ResponseSample[], applications: ResponseApplication[], now: number): Outcome {
  predictiveRecordingSchema.parse(record)
  if (!Number.isSafeInteger(now) || now < record.recordedAt) throw new Error('Invalid evaluation clock.')
  const start = record.request.observedAt, end = start + 30 * 60_000, expected = record.request.input
  const reject = (reason: PredictiveOutcomeReason): Outcome => ({ state: 'withheld', reason })
  if (end >= now || record.source.end >= now) return { state: 'pending' }
  if (!record.forecasts.holdIdentity || record.forecasts.hold.predictions.length !== 2) return reject('no_forecast')
  if (!review || review.proof.reportId !== previewReportId(record.source)
    || review.proof.configuration !== record.request.configuration || review.proof.date !== review.recording.date) return reject('no_review')
  const allContexts = review.recording.samples
  if (allContexts.length < 72 || allContexts.length > 300 || allContexts.some((sample, index) => !Number.isSafeInteger(sample.at)
    || !thermalContextSchema.safeParse(sample.context).success || sample.at > now
    || (index > 0 && sample.at <= allContexts[index - 1].at))) return reject('context_changed')
  const contexts = allContexts.filter(sample => sample.at >= start - 330_000 && sample.at <= end + 330_000)
  const finalContext = contexts.at(-1)
  if (!finalContext || contexts[0].at > start || finalContext.at < end
    || contexts.some((sample, index) => sample.context.targetF !== expected.targetF
      || Math.abs(sample.context.roomF - expected.roomF) > 2 || Math.abs(sample.context.humidity - expected.humidity) > 10
      || (index > 0 && sample.at - contexts[index - 1].at > 330_000))) return reject('context_changed')
  if (samples.length < 2 || samples.length > 200 || samples.some((sample, index) => !responseSampleSchema.safeParse(sample).success
    || sample.at < start - 90_000 || sample.at > end + 90_000 || sample.at > now
    || (index > 0 && (sample.at <= samples[index - 1].at || sample.at - samples[index - 1].at > 90_000))
    || !sample.powered || sample.targetF !== expected.targetF || sample.waterF === null)) return reject('target_changed')
  const finalSample = samples.at(-1)
  if (!finalSample || samples[0].at > start || finalSample.at < end) return reject('outcome_missing')
  const origin = samples.reduce((nearest, sample) => Math.abs(sample.at - start) < Math.abs(nearest.at - start) ? sample : nearest)
  if (Math.abs(origin.at - start) > 15_000 || origin.waterF === null || Math.abs(origin.waterF - expected.waterF) > 0.5) return reject('outcome_missing')
  if (applications.length > 1000 || new Set(applications.map(item => item.attemptId)).size !== applications.length
    || applications.some(item => !temperatureApplicationSchema.safeParse(item).success || item.side !== record.request.side
      || item.attemptedAt < start - 90_000 || item.attemptedAt > end + 90_000 || item.attemptedAt > now
      || item.outcome !== 'acknowledged' || item.acknowledgment !== 'accepted_not_physically_verified'
      || item.reason !== 'keepalive' || item.targetF !== expected.targetF || item.finishedAt === null
      || item.finishedAt > now || item.finishedAt - item.attemptedAt > 30_000 || item.comfortLimit?.state === 'wake')) return reject('command_changed')
  const horizons: PredictiveOutcomeScore['horizons'] = []
  for (const prediction of record.forecasts.hold.predictions) {
    const intended = start + prediction.minutes * 60_000
    const actual = samples.reduce((nearest, sample) => Math.abs(sample.at - intended) < Math.abs(nearest.at - intended) ? sample : nearest)
    if (Math.abs(actual.at - intended) > 45_000 || actual.waterF === null) return reject('outcome_missing')
    horizons.push({ minutes: prediction.minutes, at: actual.at, actualWaterF: actual.waterF,
      errorF: Math.abs(prediction.waterF - actual.waterF), persistenceErrorF: Math.abs(expected.waterF - actual.waterF),
      insideRange: actual.waterF >= prediction.lowerF && actual.waterF <= prediction.upperF })
  }
  return { state: 'scored', score: { date: review.recording.date, horizons } }
}
