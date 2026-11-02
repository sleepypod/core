import type Database from 'better-sqlite3'
import { z } from 'zod'
import { durableTransaction } from '@/src/db/durable'
import type { Side } from '@/src/hardware/types'
import { thermalDatasetAudit, type ThermalDatasetAudit } from './thermal-dataset'
import { thermalModelHash } from './thermal-model'
import { FORECAST_MINIMUM_NIGHTS, forecastExamples, predictThermalForecast, thermalForecastSchema, thermalForecastShape, trainThermalForecast, type ForecastInput, type ThermalForecast } from './thermal-forecast'
import { PreviewReportError } from './report-summary'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const proofSchema = z.object({ date: z.string(), reportId: hash, digest: hash, reviewId: z.number().int().positive(), configuration: hash }).strict()
const artifactSchema = z.object({ model: thermalForecastSchema, proofs: z.array(proofSchema).min(20).max(90) }).strict()
export const forecastStatusSchema = z.object({
  apiVersion: z.literal(1), side: z.enum(['left', 'right']), generatedAt: z.number().int().positive(),
  requiredNights: z.literal(20), completeNights: z.number().int().nonnegative(), datasetHash: hash,
  canTrain: z.boolean(), excluded: z.array(z.object({ date: z.string(), reason: z.string() })), reason: z.string(),
  model: thermalForecastShape.omit({ support: true, horizons: true }).extend({
    id: hash, current: z.boolean(), horizons: z.array(thermalForecastSchema.shape.horizons.element.omit({ coefficients: true, simpleCoefficient: true })),
  }).nullable(),
}).strict()

/** Reuse the reviewed full-night gate; retain whole-series provenance instead of aggregate labels. */
function dataset(audit: ThermalDatasetAudit) {
  const latest = [...audit.proofs].sort((first, second) => second.date.localeCompare(first.date))[0]
  const excluded = [...audit.collection.excluded]
  const recordings = audit.recordings.filter((recording) => {
    const proof = audit.proofs.find(item => item.date === recording.date)
    if (proof?.configuration !== latest?.configuration) {
      excluded.push({ date: recording.date, reason: 'This night used a different sensor, routine or room configuration.' })
      return false
    }
    try {
      if ([15, 30].every(minutes => forecastExamples(recording, minutes as 15 | 30).examples.length >= 12)) return true
    }
    catch { /* Invalid recordings remain visible as excluded, never imputed. */ }
    excluded.push({ date: recording.date, reason: 'Not enough stable 15- and 30-minute forecast examples in this complete night.' })
    return false
  }).sort((first, second) => first.date.localeCompare(second.date))
  const included = new Set(recordings.map(recording => recording.date))
  const proofs = audit.proofs.filter(proof => included.has(proof.date)).sort((first, second) => first.date.localeCompare(second.date))
  return { recordings, proofs, excluded, configuration: latest?.configuration ?? null,
    latestAt: recordings.at(-1)?.samples.at(-1)?.at ?? 0,
    hash: thermalModelHash({ version: 'water-response-ridge-v1', recordings, proofs }) }
}

/** Explicit fitting persists an inert artifact; status and forecasting never write controls. */
export function createThermalForecasts(database: Database.Database, clock: () => number = Date.now) {
  function inspect(side: Side) {
    const now = clock()
    if (!Number.isSafeInteger(now) || now <= 0) throw new PreviewReportError('Controller clock is unavailable.', 'PRECONDITION_FAILED')
    const audit = thermalDatasetAudit(database, side, now)
    return { now, audit, data: dataset(audit) }
  }
  function latest(side: Side) {
    const row = database.prepare('SELECT id, record FROM thermal_forecasts WHERE side = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get(side) as { id: string, record: string } | undefined
    if (!row) return null
    const artifact = artifactSchema.parse(JSON.parse(row.record))
    if (artifact.model.side !== side || thermalModelHash(artifact) !== row.id) throw new Error('Forecast artifact failed its integrity check.')
    return { id: row.id, artifact }
  }
  function evidenceCurrent(model: ThermalForecast, data: ReturnType<typeof dataset>, now: number) {
    const dates = new Set([...model.trainingDates, ...model.calibrationDates, ...model.validationDates])
    const recordings = data.recordings.filter(recording => dates.has(recording.date))
    const proofs = data.proofs.filter(proof => dates.has(proof.date))
    return model.createdAt <= now && model.sourceLastAt <= model.createdAt && now - model.sourceLastAt <= 45 * 86_400_000 && model.configuration === data.configuration
      && model.datasetHash === thermalModelHash({ version: 'water-response-ridge-v1', recordings, proofs })
  }
  function status(side: Side) {
    return database.transaction(() => {
      const { now, data } = inspect(side), stored = latest(side)
      const model = stored?.artifact.model
      const current = model ? evidenceCurrent(model, data, now) : false
      return forecastStatusSchema.parse({ apiVersion: 1, side, generatedAt: now, requiredNights: FORECAST_MINIMUM_NIGHTS,
        completeNights: data.recordings.length, datasetHash: data.hash, canTrain: data.recordings.length >= FORECAST_MINIMUM_NIGHTS && now - data.latestAt <= 45 * 86_400_000,
        excluded: data.excluded, model: model
          ? { ...thermalForecastShape.omit({ support: true, horizons: true }).strip().parse(model),
              id: stored?.id, current, horizons: model.horizons.map(horizon => thermalForecastSchema.shape.horizons.element.omit({ coefficients: true, simpleCoefficient: true }).strip().parse(horizon)) }
          : null,
        reason: !model
          ? `${data.recordings.length} complete reviewed nights have stable forecast windows; ${FORECAST_MINIMUM_NIGHTS} are required.`
          : !current
              ? 'Reference recordings changed, the configuration changed, or the latest reference is over 45 days old. Recheck before use.'
              : model.horizons.every(horizon => horizon.validation.passes)
                ? 'Both horizons passed later-night water forecasting comparisons. Preview only.'
                : 'The fitted forecast did not pass both later-night comparisons. Keep the routine.' })
    })()
  }
  function train(side: Side, expectedDatasetHash: string) {
    const { now, data } = database.transaction(() => inspect(side))()
    if (data.hash !== expectedDatasetHash) throw new PreviewReportError('Forecast recordings changed. Check the nights again.', 'CONFLICT')
    if (!data.configuration || data.recordings.length < FORECAST_MINIMUM_NIGHTS) throw new PreviewReportError('Twenty complete reviewed nights with stable forecast windows are required.', 'PRECONDITION_FAILED')
    if (now - data.latestAt > 45 * 86_400_000) throw new PreviewReportError('New complete recordings are required; the most recent reference is over 45 days old.', 'PRECONDITION_FAILED')
    const existing = latest(side)
    if (existing && existing.artifact.model.createdAt > now) throw new PreviewReportError('Controller clock precedes the saved forecast.', 'PRECONDITION_FAILED')
    if (existing?.artifact.model.datasetHash === data.hash) return status(side)
    const model = trainThermalForecast(data.recordings, { side, createdAt: now, datasetHash: data.hash, configuration: data.configuration })
    const artifact = artifactSchema.parse({ model, proofs: data.proofs })
    durableTransaction(database, () => {
      if (inspect(side).data.hash !== data.hash) throw new PreviewReportError('Forecast recordings changed before saving.', 'CONFLICT')
      database.prepare('INSERT INTO thermal_forecasts (id, side, created_at, record) VALUES (?, ?, ?, ?)')
        .run(thermalModelHash(artifact), side, now, JSON.stringify(artifact))
    })
    return status(side)
  }
  function preview(side: Side, input: ForecastInput | null, configuration: string | null) {
    return database.transaction(() => {
      const { now, data } = inspect(side), stored = latest(side)
      if (!stored || !evidenceCurrent(stored.artifact.model, data, now) || stored.artifact.model.configuration !== configuration) {
        return { predictions: [], reason: 'A current fitted water forecast and matching live configuration are required.' }
      }
      return predictThermalForecast(stored.artifact.model, input)
    })()
  }
  return { status, train, preview }
}
