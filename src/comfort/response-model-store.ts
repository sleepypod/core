import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { z } from 'zod'
import { durableTransaction } from '@/src/db/durable'
import type { Side } from '@/src/hardware/types'
import { readResponseEvidence, responseEvidenceHash, type ResponseEvidence } from './response-audit'
import { responseAuditSchema } from './response-contract'
import { responseModelStatusSchema } from './response-model-contract'
import { predictResponseModel, responseModelSchema, responseModelShape, trainResponseModel, type ResponseInput, type ResponseModel } from './response-model'
import { responseWindowSchema } from './response-window'
import { PreviewReportError } from './report-summary'

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const referencesSchema = z.array(z.object({ window: responseWindowSchema, sourceHash: digest }).strict()).min(20).max(5760)
const artifactSchema = z.object({ model: responseModelSchema, references: referencesSchema }).strict()
const artifactHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
/** Explicit fitting stores an inert artifact. Reads never fit, collect new measurements or control the bed. */
export function createResponseModels(database: Database.Database, biometrics: Database.Database, clock: () => number = Date.now,
  read: typeof readResponseEvidence = readResponseEvidence) {
  function inspect(side: Side) {
    z.enum(['left', 'right']).parse(side)
    const now = clock(), evidence = read(database, biometrics, side, now)
    const audit = responseAuditSchema.parse(evidence.audit)
    if (audit.side !== side || audit.generatedAt !== now || (audit.status !== 'unavailable'
      && responseEvidenceHash(side, evidence.configuration, evidence.windows) !== audit.datasetHash)) {
      throw new PreviewReportError('Response evidence identity changed. Check the recordings again.', 'CONFLICT')
    }
    return { now, evidence }
  }
  function latest(side: Side) {
    const row = database.prepare(`SELECT id,created_at AS createdAt,length(CAST(record AS BLOB)) AS bytes FROM target_response_models
      WHERE side=? ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(side) as { id: string, createdAt: number, bytes: number } | undefined
    if (!row) return null
    if (row.bytes <= 0 || row.bytes > 8 * 1024 ** 2) throw new PreviewReportError('Saved response artifact exceeds its read limit.', 'PRECONDITION_FAILED')
    const payload = database.prepare('SELECT record FROM target_response_models WHERE id=? AND side=?').get(row.id, side) as { record: string }
    const artifact = artifactSchema.parse(JSON.parse(payload.record))
    if (artifactHash(artifact) !== row.id || artifact.model.side !== side || artifact.model.createdAt !== row.createdAt
      || artifact.model.datasetHash !== responseEvidenceHash(side, artifact.model.configuration, artifact.references)) {
      throw new PreviewReportError('Saved response artifact failed its integrity check.', 'PRECONDITION_FAILED')
    }
    return { id: row.id, artifact }
  }
  function current(model: ResponseModel, references: z.infer<typeof referencesSchema>, evidence: ResponseEvidence, now: number) {
    if (evidence.audit.status !== 'read' || model.createdAt > now || now - model.sourceLastAt > 30 * 86_400_000
      || model.configuration !== evidence.configuration) return false
    const identities = new Set(references.map(item => item.window.attemptId))
    const matching = evidence.windows.filter(item => identities.has(item.window.attemptId))
    return identities.size === references.length && matching.length === references.length
      && responseEvidenceHash(model.side, model.configuration, matching) === model.datasetHash
  }
  function eligible(evidence: ResponseEvidence, now: number) {
    const latestOutcome = Math.max(0, ...evidence.windows.map(item => item.window.outcomes[1].at))
    return evidence.audit.status === 'read' && evidence.configuration !== null && evidence.audit.responseNights >= 20
      && latestOutcome < now && now - latestOutcome <= 30 * 86_400_000
  }
  function status(side: Side) {
    return database.transaction(() => {
      const { now, evidence } = inspect(side), stored = latest(side), model = stored?.artifact.model
      const isCurrent = stored ? current(stored.artifact.model, stored.artifact.references, evidence, now) : false
      return responseModelStatusSchema.parse({ apiVersion: 1, side, generatedAt: now, completeNights: evidence.audit.responseNights,
        evidence: evidence.audit,
        requiredNights: 20, datasetHash: evidence.audit.datasetHash, canTrain: eligible(evidence, now), activationAvailable: false,
        model: model && stored
          ? { ...responseModelShape.omit({ support: true, horizons: true }).strip().parse(model), id: stored.id, current: isCurrent,
              horizons: model.horizons.map(horizon => responseModelShape.shape.horizons.element.omit({ coefficients: true, simpleCoefficient: true }).strip().parse(horizon)) }
          : null,
        reason: evidence.audit.status !== 'read'
          ? 'Some source evidence could not be inspected completely. Recheck the recordings before fitting or using a response model.'
          : !model
              ? eligible(evidence, now)
                ? 'Enough matched nights are available to evaluate a response model. A successful fit does not enable control.'
                : 'Twenty distinct reviewed nights with actual small target responses are required. Collection does not change your routine.'
              : !isCurrent
                  ? 'A source, configuration, clock or retention check failed. Response predictions are withheld.'
                  : model.horizons.every(horizon => horizon.validation.passes)
                    ? 'Both response horizons passed later-night comparisons. Conditional water predictions remain research only; no control is enabled.'
                    : 'The fitted response did not pass both later-night comparisons. Keep the routine.' })
    })()
  }
  function train(side: Side, expectedDatasetHash: string) {
    digest.parse(expectedDatasetHash)
    const { now, evidence } = inspect(side)
    if (evidence.audit.datasetHash !== expectedDatasetHash) throw new PreviewReportError('Response recordings changed. Check the evidence again.', 'CONFLICT')
    if (!eligible(evidence, now) || !evidence.configuration) throw new PreviewReportError('Twenty reviewed response nights with a recent, complete evidence read are required.', 'PRECONDITION_FAILED')
    const stored = latest(side)
    if (stored && stored.artifact.model.createdAt > now) throw new PreviewReportError('Controller clock precedes the saved response artifact.', 'PRECONDITION_FAILED')
    if (stored?.artifact.model.datasetHash === expectedDatasetHash) return status(side)
    const model = trainResponseModel(evidence.windows.map(item => item.window), { side, createdAt: now,
      datasetHash: expectedDatasetHash, configuration: evidence.configuration })
    const artifact = artifactSchema.parse({ model, references: evidence.windows })
    const serialized = JSON.stringify(artifact)
    if (Buffer.byteLength(serialized) > 8 * 1024 ** 2) throw new PreviewReportError('Response artifact exceeds its storage limit.', 'PRECONDITION_FAILED')
    durableTransaction(database, () => {
      const refreshed = inspect(side).evidence
      if (!eligible(refreshed, now) || refreshed.audit.datasetHash !== expectedDatasetHash) throw new PreviewReportError('Response evidence changed before saving.', 'CONFLICT')
      database.prepare('INSERT INTO target_response_models(id,side,created_at,record) VALUES (?,?,?,?)')
        .run(artifactHash(artifact), side, now, serialized)
      database.prepare(`DELETE FROM target_response_models WHERE side=? AND id NOT IN
        (SELECT id FROM target_response_models WHERE side=? ORDER BY created_at DESC,rowid DESC LIMIT 3)`).run(side, side)
    })
    return status(side)
  }
  function evidenceCompare(side: Side, inputs: Array<ResponseInput | null>, configuration: string | null) {
    if (inputs.length > 2) throw new PreviewReportError('At most two nearby target candidates can be compared.', 'PRECONDITION_FAILED')
    return database.transaction(() => {
      const { now, evidence } = inspect(side), stored = latest(side)
      if (!stored || stored.artifact.model.configuration !== configuration || !current(stored.artifact.model, stored.artifact.references, evidence, now)) {
        return { identity: null, results: inputs.map(() => ({ predictions: [], reason: 'Current reviewed response evidence, model and live configuration are required.' })) }
      }
      return { identity: { id: stored.id, datasetHash: stored.artifact.model.datasetHash }, results: inputs.map(input => predictResponseModel(stored.artifact.model, input, now)) }
    })()
  }
  function compare(side: Side, inputs: Array<ResponseInput | null>, configuration: string | null) {
    return evidenceCompare(side, inputs, configuration).results
  }
  function preview(side: Side, input: ResponseInput | null, configuration: string | null) {
    return compare(side, [input], configuration)[0]
  }
  return { status, train, preview, compare, evidenceCompare }
}
