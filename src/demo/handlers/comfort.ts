import type { DemoHandlers } from '../types'
import { COMFORT_ACTIVATION_REASON } from '@/src/comfort/contract'

const unavailable = 'Personal comfort requires a live, authenticated Pod. Demo data is not used for learning or Preview nights.'

/** A demo must not imply that feedback was saved or a real night was evaluated. */
function rejectDemoWrite(): never {
  throw new Error(unavailable)
}

export const comfort: DemoHandlers<'comfort'> = {
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
