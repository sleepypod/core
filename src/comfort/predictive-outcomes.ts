import type Database from 'better-sqlite3'
import type { Side } from '@/src/hardware/types'
import { temperatureApplicationSchema } from '@/src/temperature/applications'
import { previewReportId } from './report-evidence'
import { thermalDatasetAudit, type ThermalDatasetAudit } from './thermal-dataset'
import { verifiedPredictiveRecordings } from './predictive-recording-store'
import { assessPredictiveOutcome, type PredictiveOutcomeReview, type PredictiveOutcomeScore } from './predictive-outcome-window'
import { predictiveOutcomeSchema, type PredictiveOutcomeReason, type PredictiveOutcomeSummary } from './predictive-outcome-contract'
import { responseSampleSchema, type ResponseApplication, type ResponseSample } from './response-window'

interface NightSource { samples: ResponseSample[], applications: ResponseApplication[] }
interface Group { identity: { id: string, datasetHash: string }, configuration: string, latestAt: number, nights: Map<string, PredictiveOutcomeScore[]> }
interface ApplicationRow { id: number, attemptId: string, attemptedAt: number, finishedAt: number | null, outcome: string, bytes: number }
const mean = (values: number[]) => values.reduce((total, value) => total + value, 0) / values.length

/** Re-evaluate retained predictions against current reviewed sources, never fit or activate a model. */
export function evaluatePredictiveOutcomes(database: Database.Database, biometrics: Database.Database, side: Side, now: number,
  audit: typeof thermalDatasetAudit = thermalDatasetAudit): PredictiveOutcomeSummary {
  const initial = predictiveOutcomeSchema.parse({ apiVersion: 1, side, generatedAt: now, purpose: 'prospective_water_accuracy',
    activationAvailable: false, considered: 0, pending: 0, withheld: 0, scored: 0, models: [], exclusions: [],
    notice: 'Only the unchanged target is scored. Unapplied alternatives have no measured outcome, and water accuracy is not evidence of better sleep.' })
  return database.transaction(() => biometrics.transaction(() => {
    const result = { ...initial }, groups = new Map<string, Group>(), excluded = new Map<PredictiveOutcomeReason, number>()
    const cached = new Map<string, NightSource>()
    let source: ThermalDatasetAudit | undefined, waterRows = 0, commandBytes = 0
    function nightSource(review: PredictiveOutcomeReview): NightSource {
      const cachedNight = cached.get(review.proof.reportId)
      if (cachedNight) return cachedNight
      const first = review.recording.samples[0]?.at, last = review.recording.samples.at(-1)?.at
      if (!first || !last || last <= first || last > now) throw new Error('Reviewed source clocks are invalid.')
      const rows = biometrics.prepare(`SELECT timestamp*1000 AS at,is_powered AS powered,target_temp_f AS targetF,current_temp_f AS waterF
        FROM thermal_state WHERE side=? AND timestamp>=? AND timestamp<=? ORDER BY timestamp,id LIMIT 2201`)
        .all(side, (first - 90_000) / 1000, (last + 90_000) / 1000) as Array<{ at: number, powered: unknown, targetF: unknown, waterF: unknown }>
      waterRows += rows.length
      if (rows.length > 2200 || waterRows > 50_000) throw new Error('Water evidence exceeds the inspection budget.')
      const samples = rows.map(row => responseSampleSchema.parse({ ...row, powered: row.powered === 1 ? true : row.powered === 0 ? false : row.powered }))
      const commands = database.prepare(`SELECT id,attempt_id AS attemptId,attempted_at AS attemptedAt,finished_at AS finishedAt,outcome,
        length(CAST(request AS BLOB)) AS bytes FROM temperature_applications
        WHERE side=? AND attempted_at>=? AND attempted_at<=? ORDER BY attempted_at,id LIMIT 1001`)
        .all(side, first - 90_000, last + 90_000) as ApplicationRow[]
      if (commands.length > 1000) throw new Error('Command evidence exceeds the inspection budget.')
      const applications = commands.map((row) => {
        commandBytes += row.bytes
        if (row.bytes <= 0 || row.bytes > 65_536 || commandBytes > 4 * 1024 ** 2) throw new Error('Command evidence exceeds the byte budget.')
        const payload = database.prepare('SELECT request FROM temperature_applications WHERE id=? AND side=?').get(row.id, side) as { request: string }
        const command = temperatureApplicationSchema.parse({ ...JSON.parse(payload.request), id: row.id, attemptId: row.attemptId,
          attemptedAt: row.attemptedAt, finishedAt: row.finishedAt, outcome: row.outcome,
          acknowledgment: row.outcome === 'acknowledged' ? 'accepted_not_physically_verified' : 'unconfirmed' })
        if (command.side !== side || command.attemptedAt > now || (command.finishedAt !== null && command.finishedAt > now)) throw new Error('Command identity or clock changed.')
        return command
      })
      const value = { samples, applications }
      cached.set(review.proof.reportId, value)
      return value
    }
    for (const record of verifiedPredictiveRecordings(database, side, now)) {
      result.considered++
      let review: PredictiveOutcomeReview | null = null, measurements: NightSource = { samples: [], applications: [] }
      if (record.source.end < now && record.request.observedAt + 30 * 60_000 < now && record.forecasts.holdIdentity) {
        source ??= audit(database, side, now)
        if (source.recordings.length > 90 || source.proofs.length > 90) throw new Error('Review inspection exceeds its limit.')
        const proof = source.proofs.find(item => item.reportId === previewReportId(record.source) && item.configuration === record.request.configuration)
        const recording = proof && source.recordings.find(item => item.date === proof.date)
        if (proof && recording) {
          review = { proof, recording }
          const night = nightSource(review), start = record.request.observedAt - 90_000, end = record.request.observedAt + 30 * 60_000 + 90_000
          measurements = { samples: night.samples.filter(item => item.at >= start && item.at <= end),
            applications: night.applications.filter(item => item.attemptedAt >= start && item.attemptedAt <= end) }
        }
      }
      const checked = assessPredictiveOutcome(record, review, measurements.samples, measurements.applications, now)
      if (checked.state === 'pending') result.pending++
      else if (checked.state === 'withheld') {
        result.withheld++
        excluded.set(checked.reason, (excluded.get(checked.reason) ?? 0) + 1)
      }
      else {
        const identity = record.forecasts.holdIdentity
        if (!identity) throw new Error('Scored forecast has no model identity.')
        const key = JSON.stringify([identity, record.request.configuration])
        const group = groups.get(key) ?? { identity, configuration: record.request.configuration, latestAt: record.recordedAt, nights: new Map<string, PredictiveOutcomeScore[]>() }
        const night = group.nights.get(checked.score.date) ?? []
        night.push(checked.score)
        group.nights.set(checked.score.date, night)
        groups.set(key, group)
        if (groups.size > 32) throw new Error('Too many model configurations to summarize safely.')
        result.scored++
      }
    }
    result.models = [...groups.values()].map(group => ({ artifactId: group.identity.id, datasetHash: group.identity.datasetHash,
      configuration: group.configuration, latestAt: group.latestAt, reviewedNights: group.nights.size,
      comparisons: [...group.nights.values()].reduce((total, night) => total + night.length, 0),
      horizons: ([15, 30] as const).map((minutes, index) => {
        // Overlapping comparisons are not independent nights. Give each reviewed night equal weight.
        const nights = [...group.nights.values()].map(night => night.map(score => score.horizons[index]))
        return { minutes, meanNightErrorF: mean(nights.map(night => mean(night.map(value => value.errorF)))),
          meanNightPersistenceErrorF: mean(nights.map(night => mean(night.map(value => value.persistenceErrorF)))),
          meanNightRangeCoverage: mean(nights.map(night => mean(night.map(value => value.insideRange ? 1 : 0)))) }
      }) }))
    result.exclusions = [...excluded].map(([code, count]) => ({ code, count }))
    return predictiveOutcomeSchema.parse(result)
  })())()
}
