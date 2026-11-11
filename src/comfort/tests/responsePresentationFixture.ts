import { responseModelStatusSchema } from '../response-model-contract'

/** Artificial display states only. These values are not personal data or an artifact eligible for storage. */
export function responsePresentationFixture(now: number) {
  const dates = Array.from({ length: 20 }, (_, index) => `2026-10-${String(index + 1).padStart(2, '0')}`)
  return responseModelStatusSchema.parse({ apiVersion: 1, generatedAt: now, side: 'left', completeNights: 20, requiredNights: 20,
    datasetHash: 'a'.repeat(64), canTrain: true, activationAvailable: false,
    reason: 'Illustrative model evaluation; these are not personal measurements.',
    evidence: { apiVersion: 1, policy: 'acknowledged-small-step-v1', generatedAt: now, side: 'left', attribution: 'physical_zone_only',
      status: 'read', reviewedNights: 23, responseNights: 20, coolingWindows: 40, warmingWindows: 40, requiredNights: 20,
      datasetHash: 'a'.repeat(64), modelAvailable: false, activationAvailable: false, exclusions: [], exclusionsTruncated: false, reason: 'Display fixture' },
    model: { id: 'b'.repeat(64), current: true, version: 'target-response-ridge-v1', purpose: 'observed-water-response', mode: 'research_preview',
      attribution: 'physical_zone_only', side: 'left', createdAt: now - 60_000, sourceLastAt: now - 86_400_000, datasetHash: 'a'.repeat(64), configuration: 'c'.repeat(64),
      trainingDates: dates.slice(0, 10), calibrationDates: dates.slice(10, 15), validationDates: dates.slice(15),
      horizons: [15, 30].map(minutes => ({ minutes, errorBandF: 0.4, validation: { modelMaeF: 0.2, persistenceMaeF: 0.7,
        simpleMaeF: 0.6, trendMaeF: 0.8, intervalCoverage: 0.9, supportedFraction: 1, passes: true } })) } })
}
