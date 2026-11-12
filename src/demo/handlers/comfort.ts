import { RESPONSE_POLICY } from '@/src/comfort/response-contract'
import type { DemoHandlers } from '../types'
import { COMFORT_ACTIVATION_REASON } from '@/src/comfort/contract'

const unavailable = 'Personal comfort requires a live, authenticated Pod. Demo data is not used for learning or Preview nights.'

/** A demo must not imply that feedback was saved or a real night was evaluated. */
function rejectDemoWrite(): never {
  throw new Error(unavailable)
}

export const comfort: DemoHandlers<'comfort'> = {
  predictiveOutcomes: ({ side }) => ({ apiVersion: 1, side, generatedAt: Date.now(), purpose: 'prospective_water_accuracy',
    activationAvailable: false, considered: 0, pending: 0, withheld: 0, scored: 0, models: [], exclusions: [],
    notice: 'Only the unchanged target is scored. Unapplied alternatives have no measured outcome, and water accuracy is not evidence of better sleep.' }),
  predictiveRecordings: ({ side }) => ({ apiVersion: 1, side, generatedAt: Date.now(), mode: 'research_preview', activationAvailable: false,
    records: 0, sessions: 0, candidates: 0, holds: 0, withheld: 0, latestAt: null, collector: { running: false, fault: null },
    outcomeNotice: 'Unapplied targets have no observed outcome. These records do not establish comfort benefit.',
    reason: 'Demonstration only. No production observations are recorded.' }),
  predictiveTargetPreview: ({ side }) => ({ apiVersion: 1, policy: 'bounded-water-tracking-v1', side, generatedAt: Date.now(),
    mode: 'research_preview', activationAvailable: false, objective: 'bounded-routine-water-target', disposition: 'withheld',
    currentTargetF: null, desiredWaterF: null, proposedTargetF: null, expiresAt: null, minimumF: null, maximumF: null,
    comparisons: [], reason: unavailable }),
  targetResponseModel: ({ side }) => {
    const generatedAt = Date.now()
    return { apiVersion: 1, generatedAt, side, requiredNights: 20, completeNights: 0, datasetHash: '0'.repeat(64),
      canTrain: false, activationAvailable: false, model: null, reason: unavailable,
      evidence: { apiVersion: 1, policy: RESPONSE_POLICY, generatedAt, side, attribution: 'physical_zone_only',
        status: 'unavailable', reviewedNights: 0, responseNights: 0, coolingWindows: 0, warmingWindows: 0, requiredNights: 20,
        datasetHash: '0'.repeat(64), modelAvailable: false, activationAvailable: false, exclusions: [], exclusionsTruncated: false, reason: unavailable } }
  },
  trainTargetResponseModel: rejectDemoWrite,
  targetResponsePreview: ({ side }) => ({ apiVersion: 1, generatedAt: Date.now(), side, activationAvailable: false, candidates: [], reason: unavailable }),
  targetResponse: ({ side }) => ({ apiVersion: 1, policy: RESPONSE_POLICY, generatedAt: Date.now(), side, attribution: 'physical_zone_only',
    status: 'unavailable', reviewedNights: 0, responseNights: 0, coolingWindows: 0, warmingWindows: 0, requiredNights: 20,
    datasetHash: '0'.repeat(64), modelAvailable: false, activationAvailable: false, exclusions: [], exclusionsTruncated: false, reason: unavailable }),
  waterForecast: ({ side }) => ({ apiVersion: 1, generatedAt: Date.now(), side, requiredNights: 20,
    completeNights: 0, datasetHash: '0'.repeat(64), canTrain: false, excluded: [], model: null, reason: unavailable }),
  waterForecastPreview: () => ({ predictions: [], reason: unavailable }),
  trainWaterForecast: rejectDemoWrite,
  thermalModel: ({ side }) => ({ apiVersion: 1, generatedAt: Date.now(), side, requiredNights: 20,
    completeNights: 0, feedbackNights: 0, datasetHash: '0'.repeat(64), canTrain: false,
    excluded: [], model: null, reason: unavailable }),
  thermalModelPreview: () => ({ offsetF: null, rawDirection: null, reason: unavailable }),
  trainThermalModel: rejectDemoWrite,
  owner: ({ side }) => ({ apiVersion: 1, generatedAt: Date.now(), side, identity: null, qualifications: [], nights: [],
    reasons: [unavailable], active: false, canActivate: false, application: null }),
  prepareOwnerReview: rejectDemoWrite,
  confirmOwnerReview: rejectDemoWrite,
  retestQualification: rejectDemoWrite,
  reports: ({ side }) => ({ apiVersion: 1, generatedAt: Date.now(), side, items: [], targetNights: 7, ownerConfirmedNights: 0, activationAvailable: false }),
  report: rejectDemoWrite,
  reviewReport: rejectDemoWrite,
  get: ({ side }) => ({
    apiVersion: 1,
    generatedAt: Date.now(),
    side,
    timezone: null,
    deviceDate: null,
    state: null,
    evaluatedAt: null,
    decision: null,
    fault: unavailable,
    history: [],
    runtime: 'stopped',
    activation: { available: false, reason: COMFORT_ACTIVATION_REASON },
    features: { sensorAware: false, followBedtime: false, nightReports: false, modeOnly: false, ownerActivation: false, modelTraining: true },
  }),
  configure: rejectDemoWrite,
  mode: rejectDemoWrite,
  feedback: rejectDemoWrite,
}
