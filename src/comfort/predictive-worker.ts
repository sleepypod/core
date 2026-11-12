import type Database from 'better-sqlite3'
import { createThermalForecasts } from './thermal-forecast-store'
import { createResponseModels } from './response-model-store'
import { predictiveContentHash } from './predictive-recording-store'
import { predictiveWorkerRequestSchema, predictiveWorkerResultSchema } from './predictive-recording-contract'

/** Read existing reviewed artifacts only; both SQLite handles must be read-only. */
export function evaluatePredictiveRecording(database: Database.Database, biometrics: Database.Database, input: unknown) {
  if (!database.readonly || !biometrics.readonly) throw new Error('Predictive worker requires read-only databases.')
  const request = predictiveWorkerRequestSchema.parse(input)
  return database.transaction(() => biometrics.transaction(() => {
    const hold = createThermalForecasts(database, () => request.at).evidencePreview(request.side, request.input, request.configuration)
    const candidates = [request.input.targetF - 1, request.input.targetF + 1].filter(target => target >= 55 && target <= 110)
    const responses = createResponseModels(database, biometrics, () => request.at).evidenceCompare(request.side,
      candidates.map(requestedTargetF => ({ observedAt: request.observedAt, previousTargetF: request.input.targetF,
        requestedTargetF, waterBeforeF: request.input.waterF, waterChange5mF: request.input.change5mF,
        roomF: request.input.roomF, humidity: request.input.humidity })), request.configuration)
    return predictiveWorkerResultSchema.parse({ version: 1, requestHash: predictiveContentHash(request),
      holdIdentity: hold.identity, responseIdentity: responses.identity,
      hold: { predictions: hold.predictions, reason: hold.reason },
      steps: candidates.map((targetF, index) => ({ targetF, ...responses.results[index] })) })
  })())()
}
