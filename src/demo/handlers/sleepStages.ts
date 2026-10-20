import { demoStageSettings, demoStageView, writeDemoStageClassifier } from './biometricTuning'
import { TRPCError } from '@trpc/server'
import { changedSegments, classifyNights, mergeIntoBlocks, type NightInputs } from '@/src/lib/sleep-stages'
import {
  DEFAULT_STAGE_CLASSIFIER,
  STAGE_ENGINES,
  STAGE_RULESET_PRESETS,
  summarizeRulesetChange,
  type StageClassifier,
} from '@/src/lib/sleep-stage-rules'
import type { RouterOutputs } from '../types'
import { demoMovement, demoNights, demoStageEpochs, demoVitals, findDemoNight, type DemoNight, type Side } from '../history'
import type { DemoHandlers } from '../types'

type Change = RouterOutputs['sleepStages']['getClassifier']['changes'][number]

// Per-tab session state, like the other demo settings.
const changes: Record<Side, Change[]> = { left: [], right: [] }
let nextChangeId = 1

function previewNights(side: Side, sleepRecordId: number | undefined, nights: number): DemoNight[] {
  if (sleepRecordId === undefined) return demoNights(side).slice(0, nights)
  const n = findDemoNight(sleepRecordId)
  if (!n || n.side !== side) {
    throw new TRPCError({ code: 'NOT_FOUND', message: `Sleep record ${sleepRecordId} not found for side '${side}'` })
  }
  return [n]
}

// The demo's scripted hypnogram stands in for Apple Watch reference stages.
function nightInputs(side: Side, n: DemoNight): NightInputs {
  const start = n.enteredBedAt.getTime()
  const end = n.leftBedAt?.getTime() ?? Date.now()
  return {
    vitalsData: demoVitals(side, start, end).map(v => ({ timestamp: new Date(v.t), heartRate: v.heartRate, hrv: v.hrv, breathingRate: v.breathingRate })),
    movementData: demoMovement(side, start, end).map(m => ({ timestamp: new Date(m.t), totalMovement: m.score })),
    calibrationQuality: 1,
    reference: mergeIntoBlocks(demoStageEpochs(n, start, end)),
  }
}

function latestAgreement(side: Side, classifier: StageClassifier): number | null {
  const [n] = demoNights(side)
  if (!n) return null
  return classifyNights([nightInputs(side, n)], classifier.ruleset)?.summary.agreement?.accuracy ?? null
}

export const sleepStages: DemoHandlers<'sleepStages'> = {
  getClassifier: async input => ({
    ...await demoStageSettings(input.side),
    defaults: DEFAULT_STAGE_CLASSIFIER,
    engines: Object.entries(STAGE_ENGINES).map(([id, e]) => ({ id, ...e })),
    presets: Object.entries(STAGE_RULESET_PRESETS).map(([id, p]) => ({
      id,
      label: p.label,
      description: p.description,
      classifier: { engine: 'rules' as const, ruleset: p.ruleset },
    })),
    changes: changes[input.side].slice(0, 10),
  }),

  setClassifier: input => writeDemoStageClassifier(input.side, input.classifier, (storedBefore) => {
    const before = storedBefore ?? DEFAULT_STAGE_CLASSIFIER
    const after = input.classifier ?? DEFAULT_STAGE_CLASSIFIER
    const summary = input.classifier === null
      ? (storedBefore === null ? 'No change' : 'Reset to default')
      : summarizeRulesetChange(before.ruleset, after.ruleset)
    if (summary !== 'No change') {
      changes[input.side].unshift({
        id: nextChangeId++,
        changedAt: Date.now(),
        summary,
        before: storedBefore,
        agreementBefore: latestAgreement(input.side, before),
        agreementAfter: latestAgreement(input.side, after),
      })
    }
  }),

  // The demo has no Mac-trained model: the Settings card shows "none stored", and the switch cannot be turned on.
  getModel: async () => ({ model: null, uploadedAt: null, active: false }),
  setModelActive: async (input) => {
    if (input.active) throw new TRPCError({ code: 'NOT_FOUND', message: `No valid personal stage model stored for ${input.side}` })
    return { active: false, version: null }
  },

  previewClassifier: async (input) => {
    const nights = previewNights(input.side, input.sleepRecordId, input.nights ?? 1)
    const [latest] = nights
    if (!latest) {
      return { sleepRecordId: null, enteredBedAt: null, leftBedAt: null, nights: 0, hasReference: false, saved: null, candidate: null, changed: null }
    }
    const inputs = nights.map(n => nightInputs(input.side, n))
    const savedRun = classifyNights(inputs, (await demoStageView(input.side)).classifier.ruleset)
    const candidateRun = classifyNights(inputs, input.classifier.ruleset)

    return {
      sleepRecordId: latest.id,
      enteredBedAt: latest.enteredBedAt.getTime(),
      leftBedAt: latest.leftBedAt?.getTime() ?? null,
      nights: nights.length,
      hasReference: inputs.some(n => n.reference.length > 0),
      saved: savedRun?.summary ?? null,
      candidate: candidateRun?.summary ?? null,
      changed: savedRun && candidateRun ? changedSegments(savedRun.latestEpochs, candidateRun.latestEpochs) : null,
    }
  },
}
