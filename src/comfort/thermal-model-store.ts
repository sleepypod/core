import type Database from 'better-sqlite3'
import { z } from 'zod'
import type { Side } from '@/src/hardware/types'
import { durableTransaction } from '@/src/db/durable'
import { thermalDatasetAudit, type ThermalDatasetAudit } from './thermal-dataset'
import { THERMAL_MODEL_MINIMUM_NIGHTS, predictThermalModel, thermalModelHash, thermalModelSchema, trainThermalModel } from './thermal-model'
import type { ThermalContext } from './thermal-learning'
import { PreviewReportError } from './report-summary'

export const thermalModelStatusSchema = z.object({
  apiVersion: z.literal(1), side: z.enum(['left', 'right']), generatedAt: z.number().int().positive(),
  requiredNights: z.literal(20), completeNights: z.number().int().nonnegative(), feedbackNights: z.number().int().nonnegative(),
  datasetHash: z.string().regex(/^[a-f0-9]{64}$/), canTrain: z.boolean(),
  excluded: z.array(z.object({ date: z.string(), reason: z.string() })),
  model: thermalModelSchema.omit({ coefficients: true, support: true }).extend({ id: z.string(), current: z.boolean() }).nullable(),
  reason: z.string(),
})

/** Keep one physical, schedule and calibration context per fit; household profiles use a separate boundary. */
function snapshot(audit: ThermalDatasetAudit) {
  const latest = [...audit.proofs].sort((first, second) => second.date.localeCompare(first.date))[0]
  const proofs = audit.proofs.filter(proof => proof.configuration === latest?.configuration).sort((first, second) => first.date.localeCompare(second.date))
  const included = new Set(proofs.map(proof => proof.date))
  const nights = audit.nights.filter(night => included.has(night.date)).sort((first, second) => first.date.localeCompare(second.date))
  const excluded = [...audit.collection.excluded, ...audit.proofs.filter(proof => !included.has(proof.date))
    .map(proof => ({ date: proof.date, reason: 'This night used a different calibration, routine or room configuration.' }))]
  return { proofs, nights, excluded, configuration: latest?.configuration ?? null,
    hash: thermalModelHash({ policy: audit.collection.policy, nights, proofs }) }
}

/** Training is explicitly requested, never triggered by viewing a status page, and never sends commands. */
export function createThermalModels(database: Database.Database, now: () => number = Date.now) {
  function inspect(side: Side) {
    const at = now()
    if (!Number.isSafeInteger(at) || at <= 0) throw new PreviewReportError('Controller clock is unavailable.', 'PRECONDITION_FAILED')
    const audit = thermalDatasetAudit(database, side, at)
    return { at, audit, data: snapshot(audit) }
  }
  function latest(side: Side) {
    const row = database.prepare('SELECT id, record FROM comfort_models WHERE side = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get(side) as { id: string, record: string } | undefined
    if (!row) return null
    const model = thermalModelSchema.parse(JSON.parse(row.record))
    if (model.side !== side || thermalModelHash(model) !== row.id) throw new Error('Stored thermal model failed its integrity check.')
    return { id: row.id, model }
  }
  function status(side: Side) {
    return database.transaction(() => {
      const { at, audit, data } = inspect(side)
      const stored = latest(side)
      const current = stored !== null && stored.model.createdAt <= at && stored.model.datasetHash === data.hash
      const model = stored ? { ...thermalModelSchema.omit({ coefficients: true, support: true }).strip().parse(stored.model), id: stored.id, current } : null
      return thermalModelStatusSchema.parse({ apiVersion: 1, side, generatedAt: at, requiredNights: THERMAL_MODEL_MINIMUM_NIGHTS,
        completeNights: data.nights.length, feedbackNights: audit.collection.feedbackNights, datasetHash: data.hash,
        canTrain: data.nights.length >= THERMAL_MODEL_MINIMUM_NIGHTS, excluded: data.excluded, model,
        reason: stored && !current
          ? 'The recording set or its reviews changed. Recheck and retrain before using this model.'
          : stored
            ? stored.model.validation.reason
            : `No fitted temperature model yet. ${data.nights.length} complete, reviewed nights match; ${THERMAL_MODEL_MINIMUM_NIGHTS} are required. Health history alone cannot supply missing bed temperatures or comfort labels.` })
    })()
  }
  function train(side: Side, expectedDatasetHash: string) {
    // The audit and fit are bound to one snapshot; a changed review or check-in refuses a stale Train action.
    const { at, data } = database.transaction(() => inspect(side))()
    if (data.hash !== expectedDatasetHash) throw new PreviewReportError('Training data changed. Check the nights again.', 'CONFLICT')
    if (!data.configuration || data.nights.length < THERMAL_MODEL_MINIMUM_NIGHTS) {
      throw new PreviewReportError('Twenty complete reviewed nights with matching thermal data and feedback are required.', 'PRECONDITION_FAILED')
    }
    const existing = latest(side)
    if (existing?.model.createdAt && existing.model.createdAt > at) throw new PreviewReportError('Controller clock precedes the saved model. Correct the clock before training.', 'PRECONDITION_FAILED')
    if (existing?.model.datasetHash === data.hash) return status(side)
    const model = trainThermalModel(data.nights, { side, createdAt: at, configuration: data.configuration, datasetHash: data.hash })
    durableTransaction(database, () => {
      if (inspect(side).data.hash !== data.hash) throw new PreviewReportError('Training data changed before saving.', 'CONFLICT')
      database.prepare('INSERT INTO comfort_models (id, side, created_at, dataset_hash, record) VALUES (?, ?, ?, ?, ?)')
        .run(thermalModelHash(model), side, at, data.hash, JSON.stringify(model))
    })
    return status(side)
  }
  function preview(side: Side, context: ThermalContext | null, configuration: string | null) {
    return database.transaction(() => {
      const { at, data } = inspect(side)
      const stored = latest(side)
      if (!stored || stored.model.createdAt > at || stored.model.datasetHash !== data.hash || configuration !== stored.model.configuration) {
        return { offsetF: null, rawDirection: null, reason: 'A current fitted model and matching sensor/routine configuration are required.' }
      }
      return predictThermalModel(stored.model, context)
    })()
  }
  return { status, train, preview }
}
