import { randomUUID } from 'node:crypto'
import { predictiveFixture } from './predictiveFixture'
import { previewPredictiveTarget } from '../predictive-policy'
import { predictiveContentHash } from '../predictive-recording-store'
import type { PredictiveObservation } from '../predictive-collector'
import { predictiveRecordingSchema, predictiveWorkerResultSchema } from '../predictive-recording-contract'
import { thermalConfiguration } from '../thermal-dataset'

/** Artificial source identities exercise production gates without using anyone's sleep data. */
export function predictiveRecordingFixture(now = 1_800_000_000_000) {
  const example = predictiveFixture(now)
  const observation: PredictiveObservation = {
    request: { version: 1, side: 'left', at: now, observedAt: now, configuration: 'c'.repeat(64),
      input: { targetF: 70, waterF: 73, roomF: 72, humidity: 50, change5mF: 0 } },
    evidence: { format: 1, runId: randomUUID(), environment: 'production', buildRevision: 'a'.repeat(40),
      hardwareIdentity: 'b'.repeat(64), session: 'fixture-night', start: now - 3_600_000, end: now + 8 * 3_600_000,
      timezone: 'America/Los_Angeles', scheduleRevision: 'd'.repeat(64), policy: { minimumF: 69, maximumF: 72, sensorAware: false, roomAware: true, followBedtime: false, offsetF: 0 },
      bedroom: { state: 'ready', offsetF: 0, reason: 'Artificial room fixture', sourceIds: ['temperature', 'humidity'],
        expiresAt: now + 60_000, configuration: 'c'.repeat(64) },
      scheduledBaselineF: 70, decisionBaselineF: 70, presence: 'occupied', presenceSourceKey: 'e'.repeat(64),
      mechanicallyQuiet: true, deviceFresh: true, sensorReady: true, manualPaused: false },
    state: example.state, context: example.context,
  }
  observation.request.configuration = thermalConfiguration(observation.evidence, 'c'.repeat(64))
  const forecasts = predictiveWorkerResultSchema.parse({ version: 1, requestHash: predictiveContentHash(observation.request),
    holdIdentity: { id: '1'.repeat(64), datasetHash: '2'.repeat(64) }, responseIdentity: { id: '3'.repeat(64), datasetHash: '4'.repeat(64) },
    hold: example.hold, steps: example.steps })
  const record = predictiveRecordingSchema.parse({ version: 1, id: randomUUID(), runId: observation.evidence.runId, recordedAt: now,
    source: observation.evidence, request: observation.request, forecasts,
    selection: previewPredictiveTarget(example), attribution: 'physical_zone_only', applied: false })
  return { observation, forecasts, record }
}
